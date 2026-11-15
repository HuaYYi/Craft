// 登录页：账号验证 → 选择数据位置 → 进入管理端
import * as GH from './github.js';
import * as Auth from './auth.js';

const $ = (id) => document.getElementById(id);

let repos = [];
let selected = null;
let manualMode = false;
let listOpen = false;

const isSelected = (repo) => !!selected && selected.owner === repo.owner && selected.repo === repo.repo;
const labelOf = (repo) => `${repo.owner}/${repo.repo}`;

function openList() {
  listOpen = true;
  $('repoList').hidden = false;
}

function closeList() {
  listOpen = false;
  $('repoList').hidden = true;
}

function setStep(n) {
  $('stepToken').hidden = n !== 1;
  $('stepRepo').hidden = n !== 2;
}

function setError(el, message) {
  el.textContent = message || '';
}

function busy(btn, on, text) {
  if (on) {
    btn.dataset.label = btn.textContent;
    btn.textContent = text;
    btn.disabled = true;
  } else {
    btn.textContent = btn.dataset.label || btn.textContent;
    btn.disabled = false;
  }
}

function note(message) {
  const div = document.createElement('div');
  div.className = 'repo-empty';
  div.textContent = message;
  return div;
}

function renderRepoList({ all = false } = {}) {
  if (!listOpen) return;
  const keyword = all ? '' : $('repoSearch').value.trim().toLowerCase();
  const list = repos.filter(item => {
    if (!keyword) return true;
    const text = `${item.owner}/${item.repo} ${item.description}`.toLowerCase();
    return text.includes(keyword);
  });

  const box = $('repoList');
  box.innerHTML = '';
  if (!repos.length) {
    box.appendChild(note('没有可选的数据。'));
    return;
  }
  if (!list.length) {
    box.appendChild(note('没有匹配的结果'));
    return;
  }

  for (const repo of list) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'repo-item' + (isSelected(repo) ? ' selected' : '');

    const name = document.createElement('div');
    name.className = 'repo-name';
    name.appendChild(document.createTextNode(repo.repo));
    if (repo.private) {
      const badge = document.createElement('span');
      badge.className = 'badge private';
      badge.textContent = '私有';
      name.appendChild(badge);
    }
    const owner = document.createElement('span');
    owner.className = 'repo-owner';
    owner.textContent = repo.owner;
    name.appendChild(owner);
    item.appendChild(name);

    if (repo.description) {
      const desc = document.createElement('div');
      desc.className = 'repo-desc';
      desc.textContent = repo.description;
      item.appendChild(desc);
    }

    item.addEventListener('click', () => {
      selected = repo;
      manualMode = false;
      $('manualBox').hidden = true;
      $('manualToggle').textContent = '手动填写';
      $('branchInput').value = repo.branch || 'main';
      setError($('repoError'), '');
      $('repoSearch').value = labelOf(repo);
      closeList();
    });
    box.appendChild(item);
  }
}

async function loadRepos() {
  const box = $('repoList');
  box.innerHTML = '';
  openList();
  box.appendChild(note('正在读取…'));
  try {
    repos = await GH.listWritableRepos(Auth.getToken());
    const saved = GH.getRepoSettings();
    if (!selected && saved.owner && saved.repo) {
      selected = repos.find(item => item.owner === saved.owner && item.repo === saved.repo) || null;
    }
    if (!selected && repos.length) selected = repos[0];
    if (selected && !$('branchInput').value.trim()) {
      $('branchInput').value = selected.branch || 'main';
    }
    if (selected) {
      $('repoSearch').value = labelOf(selected);
      closeList();
    } else {
      renderRepoList({ all: true });
    }
  } catch (e) {
    box.innerHTML = '';
    if (e.status === 401) {
      Auth.clearToken();
      Auth.clearUser();
      setStep(1);
      setError($('tokenError'), '登录已失效，请重新输入账号');
      $('tokenInput').focus();
      return;
    }
    box.appendChild(note(e.message || '读取失败'));
  }
}

async function connect() {
  const token = $('tokenInput').value.trim();
  setError($('tokenError'), '');
  if (!token) {
    setError($('tokenError'), '请输入账号');
    return;
  }

  const btn = $('connectBtn');
  busy(btn, true, '验证中…');
  try {
    const user = await GH.validateToken(token);
    Auth.saveToken(token, $('rememberChk').checked);
    Auth.saveUser(user);
    $('accountName').textContent = user.login;
    setStep(2);
    await loadRepos();
  } catch (e) {
    Auth.clearToken();
    setError($('tokenError'), e.status === 401 ? '账号无效或已过期' : (e.message || '验证失败'));
  } finally {
    busy(btn, false);
  }
}

async function enterSystem() {
  let owner = '';
  let repo = '';
  if (manualMode) {
    owner = $('ownerInput').value.trim();
    repo = $('repoInput').value.trim();
    if (!owner || !repo) {
      setError($('repoError'), '请填写账户和名称');
      return;
    }
  } else {
    if (!selected) {
      setError($('repoError'), '请先选择一个数据位置');
      return;
    }
    owner = selected.owner;
    repo = selected.repo;
  }

  const branch = $('branchInput').value.trim();
  const btn = $('enterBtn');
  setError($('repoError'), '');
  busy(btn, true, '进入中…');

  try {
    const info = await GH.getRepo(owner, repo);
    if (!info.permissions?.push) throw new Error('没有写入权限');
    GH.saveRepoSettings({
      owner: info.owner.login,
      repo: info.name,
      branch: branch || info.default_branch || 'main',
    });
    location.replace('admin.html');
  } catch (e) {
    if (e.status === 401) {
      Auth.clearToken();
      Auth.clearUser();
      setStep(1);
      setError($('tokenError'), '登录已失效，请重新输入账号');
    } else if (e.status === 404) {
      setError($('repoError'), '找不到该数据位置，或当前账号没有访问权限');
    } else {
      setError($('repoError'), e.message || '进入失败');
    }
    busy(btn, false);
  }
}

function init() {
  $('connectBtn').addEventListener('click', connect);
  $('enterBtn').addEventListener('click', enterSystem);

  $('tokenInput').addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); connect(); }
  });
  $('repoSearch').addEventListener('focus', () => {
    openList();
    renderRepoList({ all: true });
    $('repoSearch').select();
  });
  $('repoSearch').addEventListener('input', () => {
    openList();
    renderRepoList();
  });
  $('repoSearch').addEventListener('keydown', e => {
    if (e.key === 'Escape') closeList();
  });
  document.addEventListener('mousedown', e => {
    if (e.target.closest('.repo-picker')) return;
    if (e.target.closest('#manualToggle')) return;
    closeList();
  });

  $('backBtn').addEventListener('click', () => {
    Auth.clearToken();
    Auth.clearUser();
    repos = [];
    selected = null;
    $('tokenInput').value = '';
    $('repoSearch').value = '';
    $('rememberChk').checked = Auth.isRemembered();
    setStep(1);
    $('tokenInput').focus();
  });

  $('manualToggle').addEventListener('click', () => {
    manualMode = !manualMode;
    $('manualBox').hidden = !manualMode;
    $('manualToggle').textContent = manualMode ? '从列表选择' : '手动填写';
    if (manualMode) {
      closeList();
    } else {
      openList();
      renderRepoList({ all: true });
    }
  });

  const saved = GH.getRepoSettings();
  $('rememberChk').checked = Auth.isRemembered() || !Auth.getToken();
  $('branchInput').value = saved.branch || '';
  $('ownerInput').value = saved.owner || '';
  $('repoInput').value = saved.repo || '';

  if (!Auth.getToken()) {
    setStep(1);
    $('tokenInput').focus();
    return;
  }

  const user = Auth.getUser();
  $('accountName').textContent = user?.login || '';
  setStep(2);
  loadRepos();
}

init();
