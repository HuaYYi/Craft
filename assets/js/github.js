// GitHub Git Data API 封装
// 为什么用 Git Data API 而不是 Contents API？
// Contents API 的 create/update 只针对单个文件，N 个文件会产生 N 次 commit。
// Git Data API 可以一次性把所有 blob 打包进一个 tree → 一个 commit，真正做到「统一提交」。

import { CONFIG, LS_KEYS } from './config.js';

// ---------- 工具 ----------

// PAT 只在内存中，刷新页面即失效（不落 localStorage，避免泄露）
let _token = '';
export function setToken(t) { _token = t || ''; }
export function getToken() { return _token; }

// 从 localStorage 读用户覆盖的仓库信息，没有就用默认值
export function getGithubSettings() {
  return {
    owner:  localStorage.getItem(LS_KEYS.owner)  || CONFIG.defaultOwner,
    repo:   localStorage.getItem(LS_KEYS.repo)   || CONFIG.defaultRepo,
    branch: localStorage.getItem(LS_KEYS.branch) || CONFIG.defaultBranch,
    token:  _token,
  };
}

export function saveGithubSettings({ owner, repo, branch }) {
  if (owner  != null) localStorage.setItem(LS_KEYS.owner,  owner);
  if (repo   != null) localStorage.setItem(LS_KEYS.repo,   repo);
  if (branch != null) localStorage.setItem(LS_KEYS.branch, branch);
}

function apiUrl(path) {
  const { owner, repo } = getGithubSettings();
  return `${CONFIG.apiBase}/repos/${owner}/${repo}${path}`;
}

async function ghFetch(url, options = {}) {
  const { token } = getGithubSettings();
  const headers = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    ...(options.headers || {}),
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(url, { ...options, headers });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const err = new Error(`GitHub API ${res.status} ${res.statusText}: ${body.slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
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

// ---------- 读取 ----------

// 取分支 HEAD commit
export async function getBranchHead(branch) {
  const { owner, repo } = getGithubSettings();
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
  const { owner, repo, branch } = getGithubSettings();
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
    // Contents API 有 1MB 响应上限，超限会 403；用 raw 兜底读取
    const res = await fetch(`${CONFIG.rawBase}/${owner}/${repo}/${branch}/${path}`);
    if (!res.ok) return null;
    return { content: await res.text(), sha: null, encoding: 'utf8' };
  }
}

// 取附件二进制（用 raw.githubusercontent.com，更快）
export async function getRawBinary(path) {
  const { owner, repo, branch } = getGithubSettings();
  const res = await fetch(`${CONFIG.rawBase}/${owner}/${repo}/${branch}/${path}`);
  if (!res.ok) return null;
  return res.blob();
}

// ---------- 单次提交：blobs → tree → commit → update ref ----------

/**
 * @param {Object} opts
 * @param {string} opts.message          commit message
 * @param {string} [opts.baseCommit]     基准 commit sha（不传则自动取分支 HEAD）
 * @param {Array}  opts.treeChanges     [{ path, content: string, blobId?: string }, ...]
 *                                      content 是 UTF-8 文本；二进制附件先 blob 再传 sha
 * @param {Array}  [opts.treeDeletes]    [{ path }, ...] — 要从 tree 里移除的路径
 * @returns {Promise<{commitSha:string, treeSha:string}>}
 *
 * 冲突检测：
 *   如果 baseCommit 与自动取到的 HEAD 不一致，说明远端别人提交过，直接 reject。
 *   调用方据此提示用户「请刷新后重试」。
 */
export async function singleCommit({ message, baseCommit, treeChanges, treeDeletes = [] }) {
  const { owner, repo, branch, token } = getGithubSettings();
  if (!token) throw new Error('未配置 GitHub Personal Access Token');

  // 1. 拿到当前 HEAD，做冲突比对
  const currentHead = await getBranchHead(branch);
  if (baseCommit && baseCommit !== currentHead) {
    const err = new Error('远端已更新，请刷新后重试');
    err.code = 'CONFLICT';
    err.remoteHead = currentHead;
    throw err;
  }
  const base = await getCommit(currentHead);

  // 2. 先创建所有 blob（文本内容直接提交）
  const createdBlobs = [];
  for (const change of treeChanges) {
    // 如果 change 已经带 sha（二进制附件），直接用；否则把文本转 base64 再建 blob
    let sha = change.sha;
    if (!sha) {
      const body = { content: toBase64(change.content), encoding: 'base64' };
      const blob = await ghFetch(
        `${CONFIG.apiBase}/repos/${owner}/${repo}/git/blobs`,
        { method: 'POST', body: JSON.stringify(body) }
      );
      sha = blob.sha;
    }
    createdBlobs.push({ path: change.path, sha, mode: change.mode || '100644', type: 'blob' });
  }

  // 3. 构建新 tree —— 基于 base.tree.sha，用 tree API 的 base_tree 参数让它做增量
  // 对删除的路径：先拿完整 tree，过滤掉要删的 path，再把新增/修改条目覆盖进去
  const fullTree = await getTree(base.tree.sha, true);
  const deleteSet = new Set(treeDeletes.map(d => d.path));

  const filtered = fullTree.tree.filter(item => {
    // 只保留 blob，跳过 submodule/commit；删除集合命中的去掉
    if (item.type !== 'blob') return false;
    if (deleteSet.has(item.path)) return false;
    // 如果这个路径在 treeChanges 里，会被新条目覆盖，这里先删掉旧的
    if (treeChanges.some(c => c.path === item.path)) return false;
    return true;
  });

  const newTreeEntries = [...filtered, ...createdBlobs];

  const newTree = await ghFetch(
    `${CONFIG.apiBase}/repos/${owner}/${repo}/git/trees`,
    { method: 'POST', body: JSON.stringify({ base_tree: base.tree.sha, tree: newTreeEntries }) }
  );

  // 4. 创建 commit
  const newCommit = await ghFetch(
    `${CONFIG.apiBase}/repos/${owner}/${repo}/git/commits`,
    { method: 'POST', body: JSON.stringify({
        message,
        tree: newTree.sha,
        parents: [currentHead],
      }) }
  );

  // 5. 更新 ref
  await ghFetch(
    `${CONFIG.apiBase}/repos/${owner}/${repo}/git/refs/heads/${branch}`,
    { method: 'PATCH', body: JSON.stringify({ sha: newCommit.sha, force: false }) }
  );

  return { commitSha: newCommit.sha, treeSha: newTree.sha };
}

// 用 PAT 试一下是否有效（读一下 `/user`，200 即通过）
export async function validateToken(token) {
  const res = await fetch(`${CONFIG.apiBase}/user`, {
    headers: {
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      Accept: 'application/vnd.github+json',
    },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.message || `Token 无效 (${res.status})`);
  }
  return res.json();
}
