// 物料分片存储：轻量索引用于计数和搜索，完整物料按分类分片按需读取。
import { CONFIG } from './config.js';
import * as GH from './github.js';

const clone = (v) => JSON.parse(JSON.stringify(v));
const defaultManifest = () => ({
  version: 1,
  chunkBytes: CONFIG.materialChunkBytes,
  chunkMaxBytes: CONFIG.materialChunkMaxBytes,
  total: 0,
});
const defaultCategory = (categoryId) => ({ categoryId: categoryId || '', seq: 0, chunks: [], records: [] });

let manifest = defaultManifest();
let baseIndex = [];
let remoteCategoryIds = new Set();
let indexExisted = false;
let indexGzExisted = false;
let manifestExisted = false;
const shardCache = new Map();
const categoryCache = new Map();

const encoder = new TextEncoder();
const jsonBytes = (value) => encoder.encode(JSON.stringify(value)).length;

function shardPathOf(categoryId, shardId) {
  return `${CONFIG.materialsRoot}/categories/${categoryKey(categoryId)}/page-${shardId}.json`;
}

function shardIdOf(path) {
  const match = /\/page-([^/]+)\.json$/.exec(path || '');
  return match ? match[1] : '';
}

// 分类索引的 chunks 统一成 { path, bytes }；旧格式是字符串路径，bytes 未知（null）
function normalizeChunks(chunks) {
  return (Array.isArray(chunks) ? chunks : []).map(chunk => {
    if (typeof chunk === 'string') return { path: chunk, bytes: null };
    if (!chunk || typeof chunk !== 'object' || !chunk.path) return null;
    const bytes = Number(chunk.bytes);
    return { path: chunk.path, bytes: Number.isFinite(bytes) ? bytes : null };
  }).filter(Boolean);
}

const chunkPathOf = (chunk) => (typeof chunk === 'string' ? chunk : (chunk?.path || ''));


function compareCode(a, b) {
  return String(a.code || '').localeCompare(String(b.code || ''), 'zh', { numeric: true });
}

function summaryOf(data, path) {
  return {
    id: data.id,
    categoryId: data.categoryId || '',
    code: data.code || '',
    name: data.name || '',
    updatedAt: data.updatedAt || data.createdAt || '',
    updatedBy: data.updatedBy || '',
    path: path || data.path || '',
  };
}

// ---------- 搜索索引：紧凑结构 + gzip ----------
// 磁盘格式：{"v":3,"cats":["c_a",...],"items":[[catIdx,page,id,code,name,updatedAt,updatedBy],...]}
// 读取时展开成 { id, categoryId, code, name, updatedAt, updatedBy, path }，
// 列表页直接用摘要渲染，不再为每页下载完整分片。
const INDEX_VERSION = 3;

function compactIndex(items) {
  const cats = [];
  const catIdx = new Map();
  const rows = [];
  for (const item of items) {
    const categoryId = item.categoryId || '';
    if (!catIdx.has(categoryId)) {
      catIdx.set(categoryId, cats.length);
      cats.push(categoryId);
    }
    const shardId = shardIdOf(item.path);
    rows.push([
      catIdx.get(categoryId), shardId, item.id || '', item.code || '', item.name || '',
      item.updatedAt || '', item.updatedBy || '',
    ]);
  }
  return { v: INDEX_VERSION, cats, items: rows };
}

function expandIndex(data) {
  if (Array.isArray(data)) return data; // 兼容旧版完整数组
  const cats = Array.isArray(data?.cats) ? data.cats : [];
  return (Array.isArray(data?.items) ? data.items : []).map(row => {
    // v2 行只有 5 列，updatedAt/updatedBy 解出来是 undefined，按空串处理
    const [catIdx, page, id, code, name, updatedAt, updatedBy] = row;
    const categoryId = cats[catIdx] || '';
    // 兼容旧索引里的数字页码和新索引里的无序分片 ID
    const shardId = typeof page === 'number' ? String(page).padStart(6, '0') : String(page || '');
    return {
      id,
      categoryId,
      code: code || '',
      name: name || '',
      updatedAt: updatedAt || '',
      updatedBy: updatedBy || '',
      path: shardId ? shardPathOf(categoryId, shardId) : '',
    };
  });
}

async function gzipToBase64(text) {
  if (typeof CompressionStream === 'undefined') {
    throw new Error('当前浏览器不支持 gzip 压缩，请升级到最新版 Chrome / Edge');
  }
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
  const buffer = await new Response(stream).arrayBuffer();
  return GH.bytesToBase64(new Uint8Array(buffer));
}

async function gunzipToText(bytes) {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('当前浏览器不支持 gzip 解压，请升级到最新版 Chrome / Edge');
  }
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).text();
}

// 读全局搜索索引：优先 gz，缺失时兼容旧的 search-index.json
export async function readSearchIndex() {
  const file = await GH.getFileBinary(CONFIG.materialsSearchIndexPath);
  if (file) {
    const data = JSON.parse(await gunzipToText(file.bytes));
    return { items: expandIndex(data), existed: true, gz: true };
  }
  const legacy = await GH.getFile(CONFIG.legacySearchIndexPath);
  if (legacy) {
    return { items: expandIndex(JSON.parse(legacy.content) || []), existed: true, gz: false };
  }
  return { items: [], existed: false, gz: false };
}

function categoryKey(categoryId) {
  if (!categoryId) return '_ungrouped';
  return Array.from(String(categoryId)).map(ch =>
    /^[A-Za-z0-9-]$/.test(ch) ? ch : `_${ch.codePointAt(0).toString(16)}_`).join('');
}

function categoryIndexPath(categoryId) {
  return `${CONFIG.materialsRoot}/categories/${categoryKey(categoryId)}/index.json`;
}

async function readJson(path) {
  const file = await GH.getFile(path);
  return file ? JSON.parse(file.content) : null;
}

async function getShard(path) {
  if (!path) throw new Error('物料索引缺少分片路径');
  if (!shardCache.has(path)) {
    const promise = readJson(path).then(data => {
      if (!Array.isArray(data)) throw new Error(`物料分片格式错误：${path}`);
      return data;
    }).catch(err => {
      shardCache.delete(path);
      throw err;
    });
    shardCache.set(path, promise);
  }
  return shardCache.get(path);
}

async function getCategory(categoryId, force = false) {
  const key = categoryId || '';
  // 全局索引中没有该分类，说明远端还没有分类索引；本地新分类无需再请求一次 404。
  // force=true 时仍去仓库读一次，用于修复索引丢失后残留的分片。
  if (!force && !remoteCategoryIds.has(key)) return defaultCategory(key);
  if (!categoryCache.has(key)) {
    const path = categoryIndexPath(key);
    const promise = readJson(path).then(data => ({
      ...defaultCategory(key),
      ...(data || {}),
      categoryId: key,
      chunks: normalizeChunks(data?.chunks),
      records: Array.isArray(data?.records) ? data.records : [],
    })).catch(err => {
      categoryCache.delete(key);
      throw err;
    });
    categoryCache.set(key, promise);
  }
  return categoryCache.get(key);
}

// 清单很小，首屏必需；先把分片缓存清空，保证之后按需读取的是最新文件
export async function loadManifest() {
  shardCache.clear();
  categoryCache.clear();
  const manifestFile = await GH.getFile(CONFIG.materialsManifestPath);
  manifestExisted = !!manifestFile;
  manifest = { ...defaultManifest(), ...(manifestFile ? JSON.parse(manifestFile.content) : {}) };
  manifest.chunkBytes = Number(manifest.chunkBytes) || CONFIG.materialChunkBytes;
  manifest.chunkMaxBytes = Number(manifest.chunkMaxBytes) || CONFIG.materialChunkMaxBytes;
  delete manifest.chunkSize;
  return {
    manifest: clone(manifest),
    missingPaths: manifestFile ? [] : [CONFIG.materialsManifestPath],
  };
}

// 全局索引需要下载并解压，可能较慢；单独加载，供首屏渲染后再补上
export async function loadIndex() {
  const search = await readSearchIndex();
  indexExisted = search.existed;
  indexGzExisted = search.gz;
  baseIndex = search.items;
  remoteCategoryIds = new Set(baseIndex.map(item => item.categoryId || ''));
  return {
    materials: clone(baseIndex),
    missingPaths: search.existed ? [] : [CONFIG.materialsSearchIndexPath],
  };
}

export async function listCategory(categoryId) {
  const category = await getCategory(categoryId);
  return clone(category.records);
}

// 只下载摘要所涉及的分片，逐片加载避免大批量操作时同时发起过多请求；调用方负责叠加本地草稿。
export async function hydrate(entries, onProgress) {
  const paths = [...new Set(entries.map(item => item.path).filter(Boolean))];
  const byId = new Map();
  for (let i = 0; i < paths.length; i++) {
    const records = await getShard(paths[i]);
    for (const record of records) byId.set(record.id, record);
    onProgress?.(i + 1, paths.length);
  }
  return entries.map(entry => {
    const record = byId.get(entry.id);
    if (!record) throw new Error(`物料 ${entry.code || entry.id} 不在索引指定的分片中`);
    return clone(record);
  });
}

// 仅重建本次草稿影响的分类索引和分片；init=true 时额外写入首次需要的空索引。
export async function buildCommitPayload(selectedDrafts, syncedAt, init = false) {
  const drafts = selectedDrafts.filter(d => d.kind === 'material');
  if (!drafts.length && !init) return { fileChanges: [], treeDeletes: [] };

  const work = clone(baseIndex);
  const byId = new Map(work.map(item => [item.id, item]));
  const affectedCategories = new Set();
  const categoryWork = new Map();
  const shardWork = new Map();
  const deletedShards = new Set();

  async function categoryFor(id) {
    const key = id || '';
    if (!categoryWork.has(key)) categoryWork.set(key, clone(await getCategory(key)));
    return categoryWork.get(key);
  }

  async function shardFor(path) {
    if (!shardWork.has(path)) shardWork.set(path, clone(await getShard(path)));
    return shardWork.get(path);
  }

  const shardBytes = new Map();

  // 写入分片内容并同步字节数，供后续查找可复用空间
  function setShardRecords(category, path, records) {
    const bytes = jsonBytes(JSON.stringify(records, null, 2));
    shardWork.set(path, records);
    shardBytes.set(path, bytes);
    const chunk = category.chunks.find(item => item.path === path);
    if (chunk) chunk.bytes = bytes;
    else category.chunks.push({ path, bytes });
    return bytes;
  }

  // 分片 ID 无序、只增不复用：拆分/新建都取新 ID，永不重排已有文件
  function mintShardPath(category, used = new Set(category.chunks.map(chunk => shardIdOf(chunk.path)))) {
    let id;
    do { id = crypto.randomUUID().replace(/-/g, '').slice(0, 8); } while (used.has(id));
    used.add(id);
    return shardPathOf(category.categoryId, id);
  }

  async function removeExisting(existing, category) {
    const records = await shardFor(existing.path);
    const next = records.filter(item => item.id !== existing.id);
    if (next.length === records.length) throw new Error(`物料 ${existing.code || existing.id} 不在原分片中`);
    if (!next.length) {
      shardWork.set(existing.path, next);
      shardBytes.delete(existing.path);
      deletedShards.add(existing.path);
      category.chunks = category.chunks.filter(chunk => chunk.path !== existing.path);
      return;
    }
    // 删除后分片可能空出空间，更新字节数让它重新进入可复用范围
    setShardRecords(category, existing.path, next);
    deletedShards.delete(existing.path);
  }

  // 整片超过 800KB 时按记录顺序拆成多片；新片领新 ID，旧片整体删除
  function splitShard(path, records, category) {
    const groups = [];
    let group = [];
    let groupBytes = 0;
    for (const record of records) {
      const size = jsonBytes(JSON.stringify([record], null, 2)) + 4;
      if (group.length && groupBytes + size > manifest.chunkBytes) {
        groups.push(group);
        group = [];
        groupBytes = 0;
      }
      group.push(record);
      groupBytes += size;
    }
    if (group.length) groups.push(group);
    if (groups.length < 2) return false;

    const used = new Set(category.chunks.map(chunk => shardIdOf(chunk.path)));
    const placed = groups.map(list => {
      const nextPath = mintShardPath(category, used);
      const bytes = jsonBytes(JSON.stringify(list, null, 2));
      shardWork.set(nextPath, list);
      shardBytes.set(nextPath, bytes);
      return { path: nextPath, bytes };
    });
    const at = category.chunks.findIndex(chunk => chunk.path === path);
    if (at >= 0) category.chunks.splice(at, 1, ...placed);
    else category.chunks.push(...placed);
    groups.forEach((list, i) => {
      for (const record of list) {
        const summary = byId.get(record.id);
        if (summary) summary.path = placed[i].path;
      }
    });

    shardWork.delete(path);
    shardBytes.delete(path);
    deletedShards.add(path);
    return true;
  }

  async function addRecord(data, category) {
    const incoming = jsonBytes(JSON.stringify([data], null, 2)) + 4;

    // 优先复用空闲空间：在已知字节且装得下的分片里选最满的一片（best fit），减少碎片
    let target = null;
    for (const chunk of category.chunks) {
      if (!Number.isFinite(chunk.bytes)) continue;
      if (chunk.bytes + incoming > manifest.chunkBytes) continue;
      if (!target || chunk.bytes > target.bytes) target = chunk;
    }

    // 旧分类索引没有字节数：先补算最后一片，装得下就继续用它
    if (!target) {
      const last = category.chunks[category.chunks.length - 1];
      if (last && !Number.isFinite(last.bytes)) {
        const records = await shardFor(last.path);
        const bytes = jsonBytes(JSON.stringify(records, null, 2));
        last.bytes = bytes;
        if (bytes + incoming <= manifest.chunkBytes) target = last;
      }
    }

    if (target) {
      const records = await shardFor(target.path);
      setShardRecords(category, target.path, records.concat(data).sort(compareCode));
      deletedShards.delete(target.path);
      return target.path;
    }

    const path = mintShardPath(category);
    setShardRecords(category, path, [data]);
    deletedShards.delete(path);
    return path;
  }

  for (const draft of drafts) {
    const existing = byId.get(draft.recordId) || null;
    const oldCategoryId = existing?.categoryId || '';
    const newCategoryId = draft.data?.categoryId || '';
    if (existing) affectedCategories.add(oldCategoryId);

    if (draft.op === 'delete') {
      if (existing) {
        const oldCategory = await categoryFor(oldCategoryId);
        await removeExisting(existing, oldCategory);
        work.splice(work.findIndex(item => item.id === existing.id), 1);
        byId.delete(existing.id);
      }
      continue;
    }

    const next = clone(draft.data);
    next.categoryId = newCategoryId;
    next.location = 'cloud';
    next.syncedAt = syncedAt;
    affectedCategories.add(newCategoryId);

    if (existing && oldCategoryId === newCategoryId) {
      const category = await categoryFor(newCategoryId);
      const records = await shardFor(existing.path);
      const index = records.findIndex(item => item.id === existing.id);
      if (index < 0) throw new Error(`物料 ${existing.code || existing.id} 不在原分片中`);
      records[index] = next;
      records.sort(compareCode);
      const bytes = setShardRecords(category, existing.path, records);
      Object.assign(existing, summaryOf(next, existing.path));
      // splitShard 会把摘要里的分片路径改到新片，所以先写摘要再拆
      if (bytes > manifest.chunkMaxBytes) splitShard(existing.path, records, category);
    } else {
      if (existing) {
        const oldCategory = await categoryFor(oldCategoryId);
        await removeExisting(existing, oldCategory);
      }
      const newCategory = await categoryFor(newCategoryId);
      const path = await addRecord(next, newCategory);
      const summary = summaryOf(next, path);
      if (existing) Object.assign(existing, summary);
      else {
        work.push(summary);
        byId.set(summary.id, summary);
      }
    }
  }

  const changes = new Map();
  const deletes = new Set(deletedShards);
  for (const [path, records] of shardWork) {
    if (records.length && !deletedShards.has(path)) {
      changes.set(path, { content: JSON.stringify(records, null, 2) + '\n' });
    }
  }

  for (const categoryId of affectedCategories) {
    const category = await categoryFor(categoryId);
    category.records = work.filter(item => (item.categoryId || '') === categoryId).sort(compareCode);
    const indexPath = categoryIndexPath(categoryId);
    if (!category.records.length && !category.chunks.length) deletes.add(indexPath);
    else changes.set(indexPath, { content: JSON.stringify(category, null, 2) + '\n' });
  }

  manifest.total = work.length;
  // 初始化提交只补缺失文件，绝不能用空数组覆盖已有的索引/清单
  if (!(init && manifestExisted)) {
    changes.set(CONFIG.materialsManifestPath, { content: JSON.stringify(manifest, null, 2) + '\n' });
  }
  const writeIndex = !(init && indexExisted);
  if (writeIndex) {
    const compact = JSON.stringify(compactIndex(work));
    changes.set(CONFIG.materialsSearchIndexPath, { base64: await gzipToBase64(compact) });
  }
  if (writeIndex || indexGzExisted) deletes.add(CONFIG.legacySearchIndexPath);
  deletes.add(CONFIG.legacyMaterialsPath);

  for (const path of deletes) changes.delete(path);
  return {
    fileChanges: Array.from(changes, ([path, change]) => ({ path, ...change })),
    // 旧格式文件可能早就被删过，只删远端确实存在的路径
    treeDeletes: (await GH.filterExistingPaths([...deletes])).map(path => ({ path })),
  };
}

// 提交成功后直接用本次 payload 更新内存，不再重新下载整批文件。
export async function applyCommitPayload({ fileChanges = [], treeDeletes = [] }) {
  const categoryRoot = `${CONFIG.materialsRoot}/categories/`;
  for (const change of fileChanges) {
    if (change.path === CONFIG.materialsSearchIndexPath && typeof change.base64 === 'string') {
      const bytes = GH.bytesFromBase64(change.base64);
      baseIndex = expandIndex(JSON.parse(await gunzipToText(bytes)));
      remoteCategoryIds = new Set(baseIndex.map(item => item.categoryId || ''));
      indexExisted = true;
      indexGzExisted = true;
    } else if (change.path === CONFIG.materialsManifestPath) {
      manifest = { ...defaultManifest(), ...JSON.parse(change.content) };
      manifest.chunkBytes = Number(manifest.chunkBytes) || CONFIG.materialChunkBytes;
      manifest.chunkMaxBytes = Number(manifest.chunkMaxBytes) || CONFIG.materialChunkMaxBytes;
      delete manifest.chunkSize;
      manifestExisted = true;
    } else if (change.path.startsWith(categoryRoot) && change.path.endsWith('/index.json')) {
      const data = JSON.parse(change.content);
      const categoryId = data.categoryId || '';
      categoryCache.set(categoryId, Promise.resolve({
        ...defaultCategory(categoryId),
        ...data,
        categoryId,
        chunks: normalizeChunks(data.chunks),
        records: Array.isArray(data.records) ? data.records : [],
      }));
    } else if (change.path.startsWith(categoryRoot) && shardIdOf(change.path)) {
      const records = JSON.parse(change.content);
      if (!Array.isArray(records)) throw new Error(`物料分片格式错误：${change.path}`);
      shardCache.set(change.path, Promise.resolve(records));
    }
  }

  for (const { path } of treeDeletes) {
    if (path.startsWith(categoryRoot) && shardIdOf(path)) {
      shardCache.delete(path);
    } else if (path.startsWith(categoryRoot) && path.endsWith('/index.json')) {
      for (const key of categoryCache.keys()) {
        if (categoryIndexPath(key) === path) categoryCache.delete(key);
      }
    }
  }
  return clone(baseIndex);
}

/**
 * 重建全局搜索索引与清单：逐个分组读取分类索引（缺失时读分片），
 * 用于修复「分片里有物料但搜索索引为空」这类不一致。
 */
export async function rebuildSearchIndex(categoryIds, onProgress) {
  const byId = new Map();
  let done = 0;
  for (const categoryId of categoryIds) {
    const category = await getCategory(categoryId, true);
    let records;
    if ((category.records || []).length) {
      records = category.records;
    } else {
      // 分类索引丢了时从分片恢复，需要把分片路径补回摘要
      const shards = await Promise.all((category.chunks || []).map(async chunk => {
        const path = chunkPathOf(chunk);
        return { path, list: await getShard(path) };
      }));
      records = shards.flatMap(({ path, list }) => list.map(record => ({ ...record, path })));
    }
    for (const record of records) {
      if (!record || !record.id) continue;
      byId.set(record.id, summaryOf(record, record.path || ''));
    }
    done += 1;
    if (onProgress) onProgress(done, categoryIds.length);
  }
  baseIndex = Array.from(byId.values()).sort(compareCode);
  manifest = { ...manifest, total: baseIndex.length };
  indexExisted = true;
  indexGzExisted = true;
  return {
    fileChanges: [
      { path: CONFIG.materialsSearchIndexPath, base64: await gzipToBase64(JSON.stringify(compactIndex(baseIndex))) },
      { path: CONFIG.materialsManifestPath, content: JSON.stringify(manifest, null, 2) + '\n' },
    ],
    treeDeletes: (await GH.filterExistingPaths([CONFIG.legacySearchIndexPath])).map(path => ({ path })),
    total: baseIndex.length,
  };
}
