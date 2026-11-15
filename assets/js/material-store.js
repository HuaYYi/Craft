// 物料分片存储：轻量索引用于计数和搜索，完整物料按分类分片按需读取。
import { CONFIG } from './config.js';
import * as GH from './github.js';

const clone = (v) => JSON.parse(JSON.stringify(v));
const defaultManifest = () => ({ version: 1, chunkSize: CONFIG.materialChunkSize, total: 0 });
const defaultCategory = (categoryId) => ({ categoryId: categoryId || '', seq: 0, chunks: [], records: [] });

let remoteMode = false;
let manifest = defaultManifest();
let baseIndex = [];
let remoteCategoryIds = new Set();
const shardCache = new Map();
const categoryCache = new Map();

function compareCode(a, b) {
  return String(a.code || '').localeCompare(String(b.code || ''), 'zh', { numeric: true });
}

function summaryOf(data, path) {
  return {
    id: data.id,
    categoryId: data.categoryId || '',
    code: data.code || '',
    name: data.name || '',
    path: path || data.path || '',
  };
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
  let text = null;
  if (remoteMode) {
    const file = await GH.getFile(path);
    text = file?.content ?? null;
  } else {
    const res = await fetch(path);
    if (res.ok) text = await res.text();
    else if (res.status !== 404) throw new Error(`读取 ${path} 失败（${res.status}）`);
  }
  return text == null ? null : JSON.parse(text);
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

async function getCategory(categoryId) {
  const key = categoryId || '';
  // 全局索引中没有该分类，说明远端还没有分类索引；本地新分类无需再请求一次 404。
  if (!remoteCategoryIds.has(key)) return defaultCategory(key);
  if (!categoryCache.has(key)) {
    const path = categoryIndexPath(key);
    const promise = readJson(path).then(data => ({
      ...defaultCategory(key),
      ...(data || {}),
      categoryId: key,
      chunks: Array.isArray(data?.chunks) ? data.chunks : [],
      records: Array.isArray(data?.records) ? data.records : [],
    })).catch(err => {
      categoryCache.delete(key);
      throw err;
    });
    categoryCache.set(key, promise);
  }
  return categoryCache.get(key);
}

export async function loadRemote(useRemote) {
  remoteMode = useRemote;
  shardCache.clear();
  categoryCache.clear();
  const [manifestData, searchData] = await Promise.all([
    readJson(CONFIG.materialsManifestPath),
    readJson(CONFIG.materialsSearchIndexPath),
  ]);
  manifest = { ...defaultManifest(), ...(manifestData || {}) };
  baseIndex = Array.isArray(searchData) ? searchData : [];
  remoteCategoryIds = new Set(baseIndex.map(item => item.categoryId || ''));
  return { manifest: clone(manifest), materials: clone(baseIndex) };
}

export async function listCategory(categoryId) {
  const category = await getCategory(categoryId);
  return clone(category.records);
}

// 只下载当前页摘要所涉及的分片；调用方负责叠加本地草稿。
export async function hydrate(entries) {
  const paths = [...new Set(entries.map(item => item.path).filter(Boolean))];
  const shards = await Promise.all(paths.map(path => getShard(path)));
  const byId = new Map();
  shards.forEach(records => {
    for (const record of records) byId.set(record.id, record);
  });
  return entries.map(entry => {
    const record = byId.get(entry.id);
    if (!record) throw new Error(`物料 ${entry.code || entry.id} 不在索引指定的分片中`);
    return clone(record);
  });
}

// 仅重建本次草稿影响的分类索引和分片，不读取或上传完整物料库。
export async function buildCommitPayload(selectedDrafts, syncedAt) {
  const drafts = selectedDrafts.filter(d => d.kind === 'material');
  if (!drafts.length) return { textChanges: [], treeDeletes: [] };

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

  async function removeExisting(existing, category) {
    const records = await shardFor(existing.path);
    const next = records.filter(item => item.id !== existing.id);
    if (next.length === records.length) throw new Error(`物料 ${existing.code || existing.id} 不在原分片中`);
    shardWork.set(existing.path, next);
    if (next.length) deletedShards.delete(existing.path);
    else {
      deletedShards.add(existing.path);
      category.chunks = category.chunks.filter(path => path !== existing.path);
    }
  }

  async function addRecord(data, category) {
    let path = category.chunks[category.chunks.length - 1] || '';
    let records = path ? await shardFor(path) : [];
    if (!path || records.length >= manifest.chunkSize) {
      category.seq = Math.max(category.seq || 0, category.chunks.length) + 1;
      path = `${CONFIG.materialsRoot}/categories/${categoryKey(category.categoryId)}/page-${String(category.seq).padStart(6, '0')}.json`;
      category.chunks.push(path);
      records = [];
    }
    records.push(data);
    records.sort(compareCode);
    shardWork.set(path, records);
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
      const records = await shardFor(existing.path);
      const index = records.findIndex(item => item.id === existing.id);
      if (index < 0) throw new Error(`物料 ${existing.code || existing.id} 不在原分片中`);
      records[index] = next;
      records.sort(compareCode);
      shardWork.set(existing.path, records);
      Object.assign(existing, summaryOf(next, existing.path));
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
      changes.set(path, JSON.stringify(records, null, 2) + '\n');
    }
  }

  for (const categoryId of affectedCategories) {
    const category = await categoryFor(categoryId);
    category.records = work.filter(item => (item.categoryId || '') === categoryId).sort(compareCode);
    const indexPath = categoryIndexPath(categoryId);
    if (!category.records.length && !category.chunks.length) deletes.add(indexPath);
    else changes.set(indexPath, JSON.stringify(category, null, 2) + '\n');
  }

  manifest.total = work.length;
  changes.set(CONFIG.materialsManifestPath, JSON.stringify(manifest, null, 2) + '\n');
  changes.set(CONFIG.materialsSearchIndexPath, JSON.stringify(work, null, 2) + '\n');
  deletes.add(CONFIG.legacyMaterialsPath);

  for (const path of deletes) changes.delete(path);
  return {
    textChanges: Array.from(changes, ([path, content]) => ({ path, content })),
    treeDeletes: Array.from(deletes, path => ({ path })),
  };
}
