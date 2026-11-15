// 官网：未登录显示「登录」，已登录显示「进入系统」
import { enterUrl, getToken } from './auth.js';

const el = document.getElementById('enterBtn');
if (el) {
  el.setAttribute('href', enterUrl());
  if (getToken()) el.textContent = '进入系统';
}
