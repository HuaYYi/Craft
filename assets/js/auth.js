// 登录态：PAT、当前账号与数据仓库
//
// PAT 默认长期保存在 localStorage（登录页可取消勾选，改为仅当前标签页有效）。
// 手动退出会同时清除 PAT、账号和数据仓库选择。

import { LS_KEYS } from './config.js';

const PAT_KEY = 'craft.pat';
const USER_KEY = 'craft.user';

export function getToken() {
  return sessionStorage.getItem(PAT_KEY) || localStorage.getItem(PAT_KEY) || '';
}

export function isRemembered() {
  return !!localStorage.getItem(PAT_KEY);
}

// remember=true 长期保存；false 只存 sessionStorage，关闭标签页即失效
export function saveToken(token, remember) {
  clearToken();
  sessionStorage.setItem(PAT_KEY, token);
  if (remember) localStorage.setItem(PAT_KEY, token);
}

export function clearToken() {
  sessionStorage.removeItem(PAT_KEY);
  localStorage.removeItem(PAT_KEY);
}

export function getUser() {
  try {
    return JSON.parse(localStorage.getItem(USER_KEY) || 'null');
  } catch (_) {
    return null;
  }
}

export function saveUser(user) {
  localStorage.setItem(USER_KEY, JSON.stringify({
    login: user?.login || '',
    name: user?.name || '',
    avatarUrl: user?.avatar_url || '',
  }));
}

export function clearUser() {
  localStorage.removeItem(USER_KEY);
}

export function hasRepo() {
  return !!(localStorage.getItem(LS_KEYS.dataOwner) && localStorage.getItem(LS_KEYS.dataRepo));
}

// 进入系统：有账号进管理端，缺仓库回登录页第二步
export function enterUrl() {
  if (!getToken()) return 'login.html';
  if (!hasRepo()) return 'login.html?step=repos';
  return 'admin.html';
}

// 管理端入口守卫
export function requireLogin() {
  if (getToken() && hasRepo()) return true;
  location.replace('login.html');
  return false;
}

export function logout() {
  clearToken();
  clearUser();
  location.replace('login.html');
}
