// IndexedDB 封装：草稿缓存 + 附件 Blob
// 草稿 = 对某条记录的未提交改动（新增/修改/删除）
// Blob 单独存表，避免跟草稿元数据绑死

import { CONFIG } from './config.js';

const { dbName, dbVersion } = CONFIG;
let _db = null;

function openDB() {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(dbName, dbVersion);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('meta'))      db.createObjectStore('meta');
      if (!db.objectStoreNames.contains('drafts'))    db.createObjectStore('drafts', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('blobs'))     db.createObjectStore('blobs', { keyPath: 'id' });
    };
    req.onsuccess = () => { _db = req.result; resolve(_db); };
    req.onerror = () => reject(req.error);
  });
}

function tx(storeName, mode = 'readonly') {
  return openDB().then(db => db.transaction(storeName, mode).objectStore(storeName));
}

function reqToPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// ---------- meta（配置类小数据，也可以用 localStorage，这里统一放 IDB 方便清理）----------
export async function getMeta(key) {
  const s = await tx('meta', 'readonly');
  return reqToPromise(s.get(key));
}
export async function setMeta(key, value) {
  const s = await tx('meta', 'readwrite');
  return reqToPromise(s.put(value, key));
}
export async function removeMeta(key) {
  const s = await tx('meta', 'readwrite');
  return reqToPromise(s.delete(key));
}

// ---------- drafts ----------
// 草稿对象结构：
// {
//   id: `${tableId}:${recordId}`,
//   tableId, recordId,
//   op: 'add' | 'update' | 'delete',
//   data: { id, createdAt, updatedAt, fields:{...}, attachments:[...] }  // 当前草稿值
//   base: null | {...}   // 提交前远端快照，用于比对/还原
// }
export async function listDrafts() {
  const s = await tx('drafts', 'readonly');
  return reqToPromise(s.getAll());
}
export async function getDraft(tableId, recordId) {
  const s = await tx('drafts', 'readonly');
  return reqToPromise(s.get(`${tableId}:${recordId}`));
}
export async function putDraft(draft) {
  const s = await tx('drafts', 'readwrite');
  return reqToPromise(s.put(draft));
}
export async function removeDraft(tableId, recordId) {
  const s = await tx('drafts', 'readwrite');
  return reqToPromise(s.delete(`${tableId}:${recordId}`));
}
export async function clearDrafts() {
  const s = await tx('drafts', 'readwrite');
  return reqToPromise(s.clear());
}

// ---------- blobs（附件） ----------
// { id, name, type, size, blob }
export async function putBlob(id, { name, type, size, blob }) {
  const s = await tx('blobs', 'readwrite');
  return reqToPromise(s.put({ id, name, type, size, blob }));
}
export async function getBlob(id) {
  const s = await tx('blobs', 'readonly');
  return reqToPromise(s.get(id));
}
export async function removeBlob(id) {
  const s = await tx('blobs', 'readwrite');
  return reqToPromise(s.delete(id));
}
export async function clearBlobs() {
  const s = await tx('blobs', 'readwrite');
  return reqToPromise(s.clear());
}

// 清空全部草稿缓存（提交成功后调用）
export async function clearAllCache() {
  await clearDrafts();
  await clearBlobs();
}

// 申请持久化存储，避免浏览器回收大附件缓存
export async function requestPersistent() {
  try {
    if (navigator.storage && navigator.storage.persist) {
      await navigator.storage.persist();
    }
  } catch (_) { /* 忽略 */ }
}
