// GitHub Git Data API 封装
// 为什么用 Git Data API 而不是 Contents API？
// Contents API 的 create/update 只针对单个文件，N 个文件会产生 N 次 commit。
// Git Data API 可以一次性把所有 blob 打包进一个 tree → 一个 commit，真正做到「统一提交」。

import { CONFIG, LS_KEYS } from './config.js';
import { getToken } from './auth.js';

// ---------- 工具 ----------

// 当前数据仓库（代码仓库只托管页面，不参与读写）
export function getRepoSettings() {
  return {
    owner:  localStorage.getItem(LS_KEYS.dataOwner)  || CONFIG.defaultDataOwner,
    repo:   localStorage.getItem(LS_KEYS.dataRepo)   || CONFIG.defaultDataRepo,
    branch: localStorage.getItem(LS_KEYS.dataBranch) || CONFIG.defaultDataBranch,
    token:  getToken(),
  };
}

export function saveRepoSettings({ owner, repo, branch }) {
  if (owner  != null) localStorage.setItem(LS_KEYS.dataOwner,  owner);
  if (repo   != null) localStorage.setItem(LS_KEYS.dataRepo,   repo);
  if (branch != null) localStorage.setItem(LS_KEYS.dataBranch, branch);
}

export function clearRepoSettings() {
  localStorage.removeItem(LS_KEYS.dataOwner);
  localStorage.removeItem(LS_KEYS.dataRepo);
  localStorage.removeItem(LS_KEYS.dataBranch);
}

function apiUrl(path) {
  const { owner, repo } = getRepoSettings();
  return `${CONFIG.apiBase}/repos/${owner}/${repo}${path}`;
}

function authHeaders(token) {
  return {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

// ---------- API 额度监控（GitHub 响应携带 x-ratelimit-* 头） ----------
// remaining: 本小时剩余请求数；reset: 重置时间（epoch 秒）；localUsed: 本页面会话发出的请求数
const quota = { limit: 5000, remaining: null, reset: null, localUsed: 0 };
const quotaListeners = new Set();

function trackQuota(res) {
  const lim = res.headers.get('x-ratelimit-limit');
  const rem = res.headers.get('x-ratelimit-remaining');
  const rst = res.headers.get('x-ratelimit-reset');
  if (lim !== null && Number(lim)) quota.limit = Number(lim);
  if (rem !== null) quota.remaining = Number(rem);
  if (rst !== null) quota.reset = Number(rst);
  quota.localUsed += 1;
  quotaListeners.forEach(fn => fn({ ...quota }));
}

export function getQuota() { return { ...quota }; }
export function onQuota(fn) { quotaListeners.add(fn); return () => quotaListeners.delete(fn); }

async function ghFetch(url, options = {}, token = getToken()) {
  const headers = {
    ...authHeaders(token),
    ...(options.headers || {}),
  };

  const res = await fetch(url, { ...options, headers });
  trackQuota(res);
  if (res.status === 429) {
    const err = new Error(`API 额度本小时已用完${quota.reset ? `，${formatReset(quota.reset)} 重置` : '，请稍后再试'}`);
    err.status = 429;
    err.reset = quota.reset;
    throw err;
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const err = new Error(`GitHub API ${res.status} ${res.statusText}: ${body.slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

function formatReset(epochSec) {
  const d = new Date(epochSec * 1000);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// ---------- base64 编解码（浏览器原生 btoa/atob 只支持 Latin1，用 UTF-8 版本） ----------
export function toBase64(str) {
  // 文本内容：UTF-8 → base64
  return btoa(unescape(encodeURIComponent(str)));
}
export function textFromBase64(b64) {
  return decodeURIComponent(escape(atob(b64)));
}
export function blobToBase64(blob) {
  // 二进制附件：FileReader 读成 data URL 再剥掉前缀
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result.split(',')[1] || '');
    fr.onerror = reject;
    fr.readAsDataURL(blob);
  });
}
export function bytesToBase64(bytes) {
  // 分块转码，避免大文件一次性展开成参数字符串导致栈溢出
  let binary = '';
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + step));
  }
  return btoa(binary);
}

// ---------- 读取 ----------

// 取分支 HEAD commit
export async function getBranchHead(branch) {
  const { owner, repo } = getRepoSettings();
  const ref = await ghFetch(`${CONFIG.apiBase}/repos/${owner}/${repo}/git/refs/heads/${branch}`);
  return ref.object.sha;
}

// 取 commit
export async function getCommit(sha) {
  return ghFetch(apiUrl(`/git/commits/${sha}`));
}

// 取 tree（recursive 拿完整文件列表）
export async function getTree(sha, recursive = true) {
  return ghFetch(apiUrl(`/git/trees/${sha}${recursive ? '?recursive=1' : ''}`));
}

// 通过 contents API 取文件；文件过大（>1MB 会返回 403）或接口异常时降级用 raw
// 返回 { content: 解码后的文本, sha: 文件 blob sha（raw 降级时为 null）, encoding }
export async function getFile(path) {
  const { owner, repo, branch } = getRepoSettings();
  try {
    const data = await ghFetch(
      `${CONFIG.apiBase}/repos/${owner}/${repo}/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${branch}`
    );
    if (data.encoding === 'base64') {
      return { content: textFromBase64(data.content.replace(/\n/g, '')), sha: data.sha, encoding: data.encoding };
    }
    return { content: data.content, sha: data.sha, encoding: data.encoding };
  } catch (e) {
    if (e.status === 404) return null; // 文件不存在
    // Contents API 有 1MB 响应上限，超限会 403；改用 raw 媒体类型再读一次（私有仓库同样适用）
    const res = await fetch(
      `${CONFIG.apiBase}/repos/${owner}/${repo}/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${branch}`,
      { headers: { ...authHeaders(getToken()), Accept: 'application/vnd.github.raw' } }
    );
    if (!res.ok) return null;
    return { content: await res.text(), sha: null, encoding: 'utf8' };
  }
}

// 取二进制文件（如 gzip 搜索索引）：按 raw 字节读取，避免 base64 文本解码破坏内容
// 返回 { bytes: Uint8Array }；文件不存在返回 null
export async function getFileBinary(path) {
  const { owner, repo, branch } = getRepoSettings();
  const res = await fetch(
    `${CONFIG.apiBase}/repos/${owner}/${repo}/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${branch}`,
    { headers: { ...authHeaders(getToken()), Accept: 'application/vnd.github.raw' } }
  );
  if (res.status === 404) return null;
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const err = new Error(`GitHub API ${res.status} ${res.statusText}: ${body.slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }
  return { bytes: new Uint8Array(await res.arrayBuffer()) };
}

// 取附件二进制（用 raw.githubusercontent.com，更快）
export async function getRawBinary(path) {
  const { owner, repo, branch } = getRepoSettings();
  const res = await fetch(`${CONFIG.rawBase}/${owner}/${repo}/${branch}/${path}`);
  if (!res.ok) return null;
  return res.blob();
}

// ---------- 单次提交：blobs → tree → commit → update ref ----------

/**
 * @param {Object} opts
 * @param {string} opts.message          commit message
 * @param {string} [opts.baseCommit]     基准 commit sha（不传则自动取分支 HEAD）
 * @param {Array}  opts.treeChanges     [{ path, content?: string, base64?: string, sha?: string }, ...]
 *                                      content 是 UTF-8 文本；二进制内容传 base64；
 *                                      已在别处建好 blob 时可只传 sha（二进制附件）
 * @param {Array}  [opts.treeDeletes]    [{ path }, ...] — 要从 tree 里移除的路径
 * @returns {Promise<{commitSha:string, treeSha:string}>}
 *
 * 冲突检测：
 *   如果 baseCommit 与自动取到的 HEAD 不一致，说明远端别人提交过，直接 reject。
 *   调用方据此提示用户「请刷新后重试」。
 */
export async function singleCommit({ message, baseCommit, treeChanges, treeDeletes = [], onProgress }) {
  const { owner, repo, branch, token } = getRepoSettings();
  if (!token) throw new Error('登录已失效，请重新登录');

  // 进度：N 个文件 + 建目录 + 建提交 + 更新分支
  const totalSteps = treeChanges.length + 3;
  let doneSteps = 0;
  const report = (label) => {
    doneSteps += 1;
    onProgress?.(doneSteps, totalSteps, label);
  };

  // 1. 拿到当前 HEAD，做冲突比对
  //    空仓库还没有任何 ref，GitHub 对 refs / blobs 都返回 409；
  //    空仓库不能直接建 blob，必须先用 Contents API 写入第一个文件，产生首个提交。
  let currentHead = null;
  try {
    currentHead = await getBranchHead(branch);
  } catch (e) {
    if (e.status !== 409) throw e;
  }
  if (currentHead && baseCommit && baseCommit !== currentHead) {
    const err = new Error('远端已更新，请刷新后重试');
    err.code = 'CONFLICT';
    err.remoteHead = currentHead;
    throw err;
  }

  let changes = treeChanges;

  if (!currentHead) {
    const idx = changes.findIndex(c => !c.sha && (typeof c.content === 'string' || c.base64));
    if (idx === -1) throw new Error('空仓库首次提交需要至少一个文件内容');
    const first = changes[idx];

    const put = await ghFetch(
      `${CONFIG.apiBase}/repos/${owner}/${repo}/contents/${first.path.split('/').map(encodeURIComponent).join('/')}`,
      { method: 'PUT', body: JSON.stringify({ message, content: first.base64 || toBase64(first.content) }) }
    );
    currentHead = put.commit.sha;

    // 首个提交落在默认分支；如果用户选的是其他分支，把该分支指到同一个提交
    const info = await getRepo(owner, repo);
    if (branch !== (info.default_branch || branch)) {
      await ghFetch(
        `${CONFIG.apiBase}/repos/${owner}/${repo}/git/refs`,
        { method: 'POST', body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: currentHead }) }
      );
    }

    changes = changes.filter((_, i) => i !== idx);
    if (!changes.length) {
      onProgress?.(1, 1, '创建首个文件');
      return { commitSha: currentHead, treeSha: put.commit.tree?.sha || null };
    }
    report('创建首个文件');
  }

  const base = await getCommit(currentHead);

  // 2. 并行创建所有 blob（文本转 base64，二进制内容直接使用 base64）
  const createdBlobs = await Promise.all(changes.map(async (change) => {
    // 如果 change 已经带 sha（二进制附件），直接用
    let sha = change.sha;
    if (!sha) {
      const content = change.base64 || toBase64(change.content);
      const body = { content, encoding: 'base64' };
      const blob = await ghFetch(
        `${CONFIG.apiBase}/repos/${owner}/${repo}/git/blobs`,
        { method: 'POST', body: JSON.stringify(body) }
      );
      sha = blob.sha;
    }
    report(`写入 ${change.path.split('/').pop()}`);
    return { path: change.path, sha, mode: change.mode || '100644', type: 'blob' };
  }));

  // 3. 构建新 tree —— 基于 base.tree.sha，用 tree API 的 base_tree 参数让它做增量
  // 对删除的路径：先拿完整 tree，过滤掉要删的 path，再把新增/修改条目覆盖进去
  const fullTree = await getTree(base.tree.sha, true);
  const deleteSet = new Set(treeDeletes.map(d => d.path));

  const filtered = fullTree.tree.filter(item => {
    // 只保留 blob，跳过 submodule/commit；删除集合命中的去掉
    if (item.type !== 'blob') return false;
    if (deleteSet.has(item.path)) return false;
    // 如果这个路径在本次改动里，会被新条目覆盖，这里先删掉旧的
    if (changes.some(c => c.path === item.path)) return false;
    return true;
  });

  const newTreeEntries = [...filtered, ...createdBlobs];

  const newTree = await ghFetch(
    `${CONFIG.apiBase}/repos/${owner}/${repo}/git/trees`,
    { method: 'POST', body: JSON.stringify({ base_tree: base.tree.sha, tree: newTreeEntries }) }
  );
  report('生成目录');

  // 4. 创建 commit
  const newCommit = await ghFetch(
    `${CONFIG.apiBase}/repos/${owner}/${repo}/git/commits`,
    { method: 'POST', body: JSON.stringify({
        message,
        tree: newTree.sha,
        parents: [currentHead],
      }) }
  );
  report('创建提交');

  // 5. 更新 ref（空仓库的首个提交已让分支存在）
  await ghFetch(
    `${CONFIG.apiBase}/repos/${owner}/${repo}/git/refs/heads/${branch}`,
    { method: 'PATCH', body: JSON.stringify({ sha: newCommit.sha, force: false }) }
  );
  report('更新分支');

  return { commitSha: newCommit.sha, treeSha: newTree.sha };
}

// 用 PAT 试一下是否有效（读一下 `/user`，200 即通过）
export async function validateToken(token) {
  const res = await fetch(`${CONFIG.apiBase}/user`, { headers: authHeaders(token) });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const err = new Error(body.message || `Token 无效 (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

// 登录页：列出该 PAT 可写的仓库（最多 500 个，按最近更新排序）
export async function listWritableRepos(token) {
  const repos = [];
  for (let page = 1; page <= 5; page++) {
    const url = `${CONFIG.apiBase}/user/repos?per_page=100&sort=updated`
      + `&affiliation=owner,collaborator,organization_member&page=${page}`;
    const res = await fetch(url, { headers: authHeaders(token) });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      const err = new Error(body.message || `读取仓库列表失败 (${res.status})`);
      err.status = res.status;
      throw err;
    }
    const list = await res.json();
    repos.push(...list);
    if (list.length < 100) break;
  }
  return repos
    .filter(item => item.permissions?.push)
    .map(item => ({
      owner: item.owner?.login || '',
      repo: item.name,
      branch: item.default_branch || 'main',
      private: !!item.private,
      description: item.description || '',
      updatedAt: item.updated_at || '',
    }));
}

// 登录页：确认仓库可访问，并返回默认分支
export async function getRepo(owner, repo, token = getToken()) {
  return ghFetch(`${CONFIG.apiBase}/repos/${owner}/${repo}`, {}, token);
}

