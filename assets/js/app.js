// app.js —— 状态编排
//
// 数据模型
//   categories.json : [{ id, name, parentId, isLeaf, sort, desc,
//                        attrs:[{key,label,type,options,required}],   // 字段定义：非末级=给下级继承；末级=物料属性
//                        attrValues:{ key: 值 } }]                    // 继承字段在本组的值（整组一份，不进物料档案）
//   materials.json  : [{ id, categoryId, code, name,
//                        attrs:{ key: 值 },                          // 末级分组定义的字段值，每个物料各自一份
//                        location, syncedAt, createdAt, updatedAt, createdBy, updatedBy }]
//
// 改动统一先进 IndexedDB 草稿（drafts），点右上角「提交管理」勾选后一次 commit 推送。
//
// 视图：materials（物料及分组） / settings（设置） / commit（提交管理）

import { CONFIG, LOCATION } from './config.js';
import * as Store from './store.js';
import * as GH from './github.js';
import * as Cat from './categories.js';
import * as Excel from './excel.js';
import { renderForm, renderAttrDefTable, mk } from './fields.js';
import { openModal, closeModal, toastOk, toastErr, confirm } from './ui.js';

// ---------- 全局状态 ----------
const state = {
  view: 'materials',
  // 远端基准（未应用草稿）
  baseCategories: [],
  baseMaterials: [],
  rawCategoriesText: '',
  rawMaterialsText: '',
  // 应用草稿后的展示数据
  categories: [],
  materials: [],
  drafts: [],
  settings: null,
  pat: '',
  remoteHead: null,
  // UI 状态
  selectedCategoryId: '',     // '' = 未分组（虚拟节点）；否则为分组 id
  activeTab: 'materials',
  expanded: new Set(),
  checked: new Set(),
  search: '',
  draggingCatId: null,        // 正在拖拽的分组 id
};

const mint = (prefix) => `${prefix}_${crypto.randomUUID().slice(0, 8)}`;
const nowISO = () => new Date().toISOString();
const clone = (v) => JSON.parse(JSON.stringify(v));
const UNGROUPED = '';          // 未分组的 categoryId

// ---------- 启动 ----------
init().catch(e => {
  console.error(e);
  toastErr('初始化失败：' + (e.message || e));
});

async function init() {
  await Store.requestPersistent();

  // 数据模型版本标记：仅记录，升级时默认保留全部本地数据，不做任何清理
  const MODEL_KEY = 'craft.modelVersion';
  const MODEL_VERSION = '5';

  state.settings = GH.getGithubSettings();
  bindNav();
  await refreshRemote();

  if (localStorage.getItem(MODEL_KEY) !== MODEL_VERSION) {
    localStorage.setItem(MODEL_KEY, MODEL_VERSION);
  }

  await loadDrafts();
  render();
}

function bindNav() {
  document.querySelectorAll('.nav-item').forEach(item => {
    item.addEventListener('click', () => switchView(item.dataset.view));
  });
  document.getElementById('commitLink').addEventListener('click', () => switchView('commit'));
}

function switchView(view) {
  state.view = view;
  document.querySelectorAll('.nav-item').forEach(i => i.classList.toggle('active', i.dataset.view === view));
  document.getElementById('commitLink').classList.toggle('active', view === 'commit');
  const titles = { materials: '物料及分组', settings: '设置', commit: '提交管理' };
  document.getElementById('topbarTitle').textContent = titles[view] || '';
  render();
}

function render() {
  const content = document.getElementById('content');
  content.className = 'content';
  content.innerHTML = '';
  if (state.view === 'materials') renderMaterialsPage();
  else if (state.view === 'settings') renderSettings();
  else if (state.view === 'commit') renderCommit();
}

// ---------- 远端读取 ----------
async function refreshRemote() {
  GH.setToken(state.pat);
  setLoading();
  try {
    let catsText = null;
    let matsText = null;

    if (state.pat) {
      try {
        state.remoteHead = await GH.getBranchHead(state.settings.branch);
      } catch (_) { state.remoteHead = null; }
      const cf = await GH.getFile(CONFIG.categoriesPath);
      const mf = await GH.getFile(CONFIG.materialsPath);
      if (cf) catsText = cf.content;
      if (mf) matsText = mf.content;
    } else {
      state.remoteHead = null;
      const rc = await fetch(CONFIG.categoriesPath);
      if (rc.ok) catsText = await rc.text();
      const rm = await fetch(CONFIG.materialsPath);
      if (rm.ok) matsText = await rm.text();
    }

    state.baseCategories = catsText ? safeParse(catsText, []) : [];
    state.baseMaterials = matsText ? safeParse(matsText, []) : [];
    state.rawCategoriesText = catsText || '[]';
    state.rawMaterialsText = matsText || '[]';
  } catch (e) {
    console.warn('远端读取失败', e);
    toastErr('远端同步失败：' + (e.message || e));
  }
}

function safeParse(text, fallback) {
  try { return JSON.parse(text) || fallback; } catch (_) { return fallback; }
}

// ---------- 草稿 ----------
async function loadDrafts() {
  state.drafts = await Store.listDrafts();
  applyDrafts();
  updateCommitBadge();
}

function applyDrafts() {
  const cats = clone(state.baseCategories);
  const mats = clone(state.baseMaterials);

  for (const d of state.drafts) {
    const target = d.kind === 'category' ? cats : mats;
    const idx = target.findIndex(x => x.id === d.recordId);
    if (d.op === 'delete') {
      if (idx >= 0) target.splice(idx, 1);
    } else if (d.op === 'add') {
      if (idx < 0) target.push(clone(d.data));
    } else {
      if (idx >= 0) target[idx] = clone(d.data);
      else target.push(clone(d.data));
    }
  }

  state.categories = cats;
  state.materials = mats;

  // 选中分组若被删掉则回退到未分组
  if (state.selectedCategoryId !== UNGROUPED && !cats.some(c => c.id === state.selectedCategoryId)) {
    state.selectedCategoryId = UNGROUPED;
  }
}

function updateCommitBadge() {
  document.getElementById('commitLink').textContent = `提交管理(${state.drafts.length})`;
}

async function saveCategoryDraft(cat, op) {
  await Store.putDraft({
    id: `category:${cat.id}`,
    kind: 'category',
    recordId: cat.id,
    op,
    data: clone(cat),
  });
  await loadDrafts();
}

async function saveMaterialDraft(mat, op) {
  await Store.putDraft({
    id: `material:${mat.id}`,
    kind: 'material',
    recordId: mat.id,
    op,
    data: clone(mat),
  });
  await loadDrafts();
}

// 判断某条记录当前是否有未提交改动
function draftOf(kind, id) {
  return state.drafts.find(d => d.kind === kind && d.recordId === id) || null;
}

// ---------- 物料及分组页 ----------
function renderMaterialsPage() {
  const content = document.getElementById('content');
  content.className = 'content';
  content.innerHTML = '';

  const page = mk('div', { class: 'cat-page' });
  page.appendChild(buildTreePanel());
  page.appendChild(buildCatMain());
  content.appendChild(page);
}

function buildTreePanel() {
  const panel = mk('div', { class: 'cat-panel' });
  const head = mk('div', { class: 'cat-panel-head' });
  head.appendChild(mk('span', { class: 'ttl' }, '分组'));
  const addBtn = mk('button', { class: 'btn small' }, '＋ 新建');
  addBtn.addEventListener('click', () => openCategoryDialog(null));
  head.appendChild(addBtn);
  panel.appendChild(head);

  const tree = mk('div', { class: 'tree' });

  // 固定的「未分组」（虚拟节点，categoryId 为空字符串）
  const ungroupedCount = state.materials.filter(m =>
    !m.categoryId || !state.categories.some(c => c.id === m.categoryId)).length;
  tree.appendChild(buildTreeNode({
    depth: 0,
    label: '未分组',
    count: ungroupedCount,
    active: state.selectedCategoryId === UNGROUPED,
    isRoot: true,
    onClick: () => { state.selectedCategoryId = UNGROUPED; state.activeTab = 'materials'; state.checked.clear(); render(); },
  }));

  const roots = Cat.buildTree(state.categories);
  const renderNodes = (nodes, depth) => {
    for (const node of nodes) {
      const hasKids = (node.children || []).length > 0;
      const isOpen = state.expanded.has(node.id);
      const count = state.materials.filter(m => m.categoryId === node.id).length;

      tree.appendChild(buildTreeNode({
        id: node.id,
        parentId: node.parentId ?? null,
        depth,
        label: node.name,
        count,
        active: state.selectedCategoryId === node.id,
        hasKids,
        isOpen,
        isLeaf: node.isLeaf,
        onCaret: (e) => {
          e.stopPropagation();
          if (isOpen) state.expanded.delete(node.id);
          else state.expanded.add(node.id);
          render();
        },
        onClick: () => {
          state.selectedCategoryId = node.id;
          state.activeTab = node.isLeaf ? 'materials' : 'manage';
          state.checked.clear();
          if (hasKids) state.expanded.add(node.id);
          render();
        },
        onAdd: (e) => { e.stopPropagation(); openCategoryDialog(node.id); },
      }));

      if (hasKids && isOpen) renderNodes(node.children, depth + 1);
    }
  };
  renderNodes(roots, 0);

  // 拖到树空白处 → 移到根级
  tree.addEventListener('dragover', (e) => {
    if (!state.draggingCatId) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    tree.classList.add('drop-root');
  });
  tree.addEventListener('dragleave', (e) => {
    if (e.target === tree) tree.classList.remove('drop-root');
  });
  tree.addEventListener('drop', (e) => {
    if (!state.draggingCatId) return;
    e.preventDefault();
    tree.classList.remove('drop-root');
    doMoveCategory(state.draggingCatId, null, null);
  });

  if (!roots.length) {
    tree.appendChild(mk('div', { class: 'empty', style: 'padding:24px 10px;' }, '还没有分组'));
  }

  panel.appendChild(tree);
  return panel;
}

function buildTreeNode(opts) {
  const node = mk('div', {
    class: 'tree-node' + (opts.active ? ' active' : '') + (opts.isRoot ? ' is-root' : ''),
    style: `--depth:${opts.depth}`,
    title: opts.label,
  });

  const caret = mk('span', { class: 'caret' + (opts.hasKids ? '' : ' hidden-caret') },
    opts.hasKids ? (opts.isOpen ? '▾' : '▸') : '·');
  if (opts.hasKids) caret.addEventListener('click', opts.onCaret);
  node.appendChild(caret);

  node.appendChild(mk('span', { class: 'tree-label' }, opts.label));
  if (opts.count) node.appendChild(mk('span', { class: 'tree-count' }, String(opts.count)));

  // 末级分组不能再挂子分组，不显示 ＋
  if (!opts.isRoot && !opts.isLeaf) {
    const add = mk('button', { class: 'node-add', title: '新建子分组' }, '＋');
    add.addEventListener('click', opts.onAdd);
    node.appendChild(add);
  }

  node.addEventListener('click', opts.onClick);

  // 拖拽调整层级/顺序（「未分组」虚拟节点不参与）
  if (opts.id) wireTreeNodeDrag(node, opts);
  return node;
}

// 节点三分区：上 1/4 插到前面（同级）、下 1/4 插到后面（同级）、中间作为子级
function dropZoneOf(e, el) {
  const r = el.getBoundingClientRect();
  const y = e.clientY - r.top;
  if (y < r.height * 0.25) return 'before';
  if (y > r.height * 0.75) return 'after';
  return 'into';
}

function clearDropMarks(el) {
  el.classList.remove('drop-before', 'drop-into', 'drop-after');
}

function wireTreeNodeDrag(node, opts) {
  node.draggable = true;

  node.addEventListener('dragstart', (e) => {
    state.draggingCatId = opts.id;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', opts.id);
    node.classList.add('dragging');
  });
  node.addEventListener('dragend', () => {
    state.draggingCatId = null;
    node.classList.remove('dragging');
    document.querySelectorAll('.tree-node.drop-before,.tree-node.drop-into,.tree-node.drop-after')
      .forEach(clearDropMarks);
    document.querySelector('.tree')?.classList.remove('drop-root');
  });

  node.addEventListener('dragover', (e) => {
    if (!state.draggingCatId || state.draggingCatId === opts.id) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';
    clearDropMarks(node);
    node.classList.add('drop-' + dropZoneOf(e, node));
  });
  node.addEventListener('dragleave', () => clearDropMarks(node));
  node.addEventListener('drop', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const zone = dropZoneOf(e, node);
    clearDropMarks(node);
    const dragId = state.draggingCatId;
    if (!dragId || dragId === opts.id) return;
    if (zone === 'into') doMoveCategory(dragId, opts.id, null);
    else doMoveCategory(dragId, opts.parentId, zone === 'before' ? opts.id : nextSiblingIdOf(opts));
  });
}

// 「插到某节点之后」= 插到它下一个同级之前；没有下一个就是末尾（null）
function nextSiblingIdOf(opts) {
  const siblings = state.categories
    .filter(c => (c.parentId ?? null) === (opts.parentId ?? null) && c.id !== state.draggingCatId)
    .sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0) || a.name.localeCompare(b.name, 'zh'));
  const idx = siblings.findIndex(c => c.id === opts.id);
  return idx >= 0 && idx + 1 < siblings.length ? siblings[idx + 1].id : null;
}

// 执行移动：校验 → 存草稿 → 刷新
async function doMoveCategory(id, newParentId, beforeId) {
  const np = newParentId ?? null;
  const node = Cat.findCategory(state.categories, id);
  if (!node) return;
  // 末级分组不能再挂子分组（先在「分组管理」里取消末级）
  const target = np ? Cat.findCategory(state.categories, np) : null;
  if (target && target.isLeaf && np !== (node.parentId ?? null)) {
    toastErr('末级分组不能挂子分组，请先在「分组管理」里取消末级');
    return;
  }
  // 目标父级已挂物料时不能再挂子分组，否则那些物料会失去入口
  if (np && np !== (node.parentId ?? null) && state.materials.some(m => m.categoryId === np)) {
    toastErr('目标分组下已有物料，不能再挂子分组');
    return;
  }
  // 位置没变就不动
  if ((node.parentId ?? null) === np && !beforeId) return;

  const cats = clone(state.categories);
  const changed = Cat.moveCategory(cats, id, np, beforeId);
  if (!changed.length) { toastErr('不能移动到该位置'); return; }
  for (const c of changed) {
    const d = draftOf('category', c.id);
    await saveCategoryDraft(c, d?.op === 'add' ? 'add' : 'update');
  }
  if (np) state.expanded.add(np);
  state.checked.clear();
  render();
  toastOk('分组已移动（草稿）');
}

function buildCatMain() {
  const main = mk('div', { class: 'cat-main' });
  const cat = state.selectedCategoryId ? Cat.findCategory(state.categories, state.selectedCategoryId) : null;

  // 选项卡：末级分组或未分组才有「物料档案」；分组有「分组管理」
  const tabs = [];
  if (!cat || cat.isLeaf) tabs.push({ id: 'materials', label: '物料档案' });
  if (cat) tabs.push({ id: 'manage', label: '分组管理' });

  if (!tabs.some(t => t.id === state.activeTab)) {
    state.activeTab = tabs[0]?.id || 'materials';
  }

  const tabBar = mk('div', { class: 'tabs' });
  for (const t of tabs) {
    const btn = mk('button', { class: 'tab' + (state.activeTab === t.id ? ' active' : '') }, t.label);
    btn.addEventListener('click', () => { state.activeTab = t.id; render(); });
    tabBar.appendChild(btn);
  }
  main.appendChild(tabBar);

  if (state.activeTab === 'materials') main.appendChild(buildMaterialsPanel(cat));
  else if (cat) main.appendChild(buildManagePanel(cat));

  return main;
}

// ---------- 物料档案 ----------
function currentMaterials() {
  let list = state.materials;
  if (state.selectedCategoryId === UNGROUPED) {
    // 未分组：没有 categoryId，或指向的分组已不存在
    list = list.filter(m => !m.categoryId || !state.categories.some(c => c.id === m.categoryId));
  } else {
    const ids = Cat.selfAndDescendantIds(state.categories, state.selectedCategoryId);
    list = list.filter(m => ids.has(m.categoryId));
  }
  const kw = state.search.trim().toLowerCase();
  if (kw) {
    list = list.filter(m =>
      (m.code || '').toLowerCase().includes(kw) ||
      (m.name || '').toLowerCase().includes(kw));
  }
  return list;
}

function buildMaterialsPanel(cat) {
  const panel = mk('div', { class: 'tab-panel' });

  // 工具栏：只留搜索和计数，操作都移到右侧图标栏
  const bar = mk('div', { class: 'toolbar' });
  const search = mk('input', { type: 'search', placeholder: '搜索物料编码 / 名称' });
  search.value = state.search;
  search.addEventListener('input', e => {
    state.search = e.target.value;
    refreshMaterialsTable(panel, cat);
  });
  bar.appendChild(search);

  const info = mk('span', { class: 'hint' });
  bar.appendChild(info);
  bar.appendChild(mk('span', { class: 'spacer' }));
  if (state.checked.size) {
    bar.appendChild(mk('span', { class: 'hint' }, `已选 ${state.checked.size} 项`));
  }

  panel.appendChild(bar);

  // 表格 + 右侧批量操作栏
  const body = mk('div', { class: 'materials-body' });
  const tableWrap = mk('div', { class: 'table-wrap', id: 'materialsTableWrap' });
  body.appendChild(tableWrap);
  body.appendChild(buildSideRail());
  panel.appendChild(body);

  renderMaterialsTable(tableWrap, cat, info);
  return panel;
}

// 页面右侧竖排批量操作栏（参考图二最右红框）
function buildSideRail() {
  const rail = mk('div', { class: 'side-rail' });
  const sep = () => mk('div', { class: 'rail-sep' });

  const add = mk('button', { class: 'rail-btn', title: '新增物料' }, '＋');
  add.addEventListener('click', () => openMaterialDialog(null));

  const imp = mk('button', { class: 'rail-btn', title: '导入 Excel' }, '⤓');
  imp.addEventListener('click', () => triggerImport());

  const exp = mk('button', { class: 'rail-btn', title: '导出当前筛选为 Excel' }, '⤒');
  exp.addEventListener('click', () => doExport());

  const move = mk('button', { class: 'rail-btn', title: '批量转移分组（先勾选）' }, '⇄');
  move.disabled = !state.checked.size;
  move.addEventListener('click', () => openBatchMoveDialog());

  const del = mk('button', { class: 'rail-btn danger-hover', title: '批量删除（先勾选）' }, '✕');
  del.disabled = !state.checked.size;
  del.addEventListener('click', () => doBatchDelete());

  rail.appendChild(add);
  rail.appendChild(sep());
  rail.appendChild(imp);
  rail.appendChild(exp);
  rail.appendChild(sep());
  rail.appendChild(move);
  rail.appendChild(del);
  return rail;
}

function refreshMaterialsTable(panel, cat) {
  const wrap = panel.querySelector('#materialsTableWrap');
  const info = panel.querySelector('.hint');
  if (!wrap) return;
  renderMaterialsTable(wrap, cat, info);
}

function renderMaterialsTable(wrap, cat, info) {
  wrap.innerHTML = '';
  const list = currentMaterials();
  if (info) info.textContent = `共 ${list.length} 条`;

  const table = mk('table', { class: 'grid' });
  const head = mk('tr');
  const chkAll = mk('input', { type: 'checkbox' });
  const allVisibleChecked = list.length > 0 && list.every(m => state.checked.has(m.id));
  chkAll.checked = allVisibleChecked;
  chkAll.addEventListener('change', () => {
    if (chkAll.checked) list.forEach(m => state.checked.add(m.id));
    else list.forEach(m => state.checked.delete(m.id));
    render();
  });

  // 物料属性列：当前可见物料所属末级分组定义的字段并集，每个属性单独一列
  const attrDefs = [];
  const seenKeys = new Set();
  for (const m of list) {
    if (!m.categoryId) continue;
    const cat = Cat.findCategory(state.categories, m.categoryId);
    for (const def of cat?.attrs || []) {
      if (!seenKeys.has(def.key)) { seenKeys.add(def.key); attrDefs.push(def); }
    }
  }

  const thChk = mk('th', { style: 'width:32px;' });
  thChk.appendChild(chkAll);
  head.appendChild(thChk);
  ['ID', '物料编码', '物料名称', ...attrDefs.map(d => d.label), '位置', '最近编辑'].forEach(t => head.appendChild(mk('th', {}, t)));
  head.appendChild(mk('th', {}, '操作'));
  table.appendChild(head);

  if (!list.length) {
    const tr = mk('tr');
    tr.appendChild(mk('td', { colspan: attrDefs.length + 7, class: 'empty' }, '暂无物料'));
    table.appendChild(tr);
  }

  for (const m of list) {
    const d = draftOf('material', m.id);
    const tr = mk('tr', { class: d ? 'dirty' : '' });

    const tdChk = mk('td');
    const chk = mk('input', { type: 'checkbox' });
    chk.checked = state.checked.has(m.id);
    chk.addEventListener('change', () => {
      if (chk.checked) state.checked.add(m.id); else state.checked.delete(m.id);
      render();
    });
    tdChk.appendChild(chk);
    tr.appendChild(tdChk);

    tr.appendChild(mk('td', { class: 'mono' }, m.id.slice(-8)));
    tr.appendChild(mk('td', { class: 'mono' }, m.code || ''));
    tr.appendChild(mk('td', {}, m.name || ''));
    for (const def of attrDefs) {
      tr.appendChild(mk('td', { class: 'wrap' }, Cat.fmtAttrValue(def, m.attrs?.[def.key])));
    }
    const locTd = mk('td');
    locTd.appendChild(buildLocationCell(m));
    tr.appendChild(locTd);

    const editTd = mk('td', { class: 'muted', style: 'font-size:12px;' },
      fmtTime(m.updatedAt || m.createdAt));
    tr.appendChild(editTd);

    const opsTd = mk('td', { style: 'white-space:nowrap;' });
    const editBtn = mk('button', { class: 'link-btn' }, '编辑');
    editBtn.addEventListener('click', () => openMaterialDialog(m));
    const delBtn = mk('button', { class: 'link-btn danger' }, '删除');
    delBtn.addEventListener('click', () => doDeleteMaterial(m));
    opsTd.appendChild(editBtn);
    opsTd.appendChild(delBtn);
    tr.appendChild(opsTd);

    table.appendChild(tr);
  }

  wrap.appendChild(table);
}

// 位置：云端=淡绿圆点（与云端一致），本地=灰圆点（有未提交的本地改动）
function buildLocationCell(m) {
  const isCloud = !draftOf('material', m.id);
  const span = mk('span', { class: 'loc', title: isCloud ? '与云端一致' : '有未提交的本地改动' });
  span.appendChild(mk('i', { class: `dot ${isCloud ? 'cloud' : 'local'}` }));
  span.appendChild(document.createTextNode(LOCATION[isCloud ? 'cloud' : 'local']));
  return span;
}

function fmtTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function leafCategories() {
  return state.categories.filter(c => c.isLeaf && !state.categories.some(x => x.parentId === c.id));
}

// ---------- 物料编辑弹窗 ----------
function openMaterialDialog(mat) {
  const isNew = !mat;

  // 在哪个分组下点的新增，物料就进哪个分组；弹窗里不再重复选择
  const catId = mat ? (mat.categoryId || UNGROUPED) : (state.selectedCategoryId || UNGROUPED);
  const cat = catId ? Cat.findCategory(state.categories, catId) : null;
  // 只有末级分组自己定义的字段才进物料表单（上级定义的字段在分组上统一填，不进物料档案）
  const defs = cat?.attrs || [];

  let current = mat
    ? clone(mat)
    : {
        id: mint('m'), categoryId: catId || UNGROUPED, code: '', name: '',
        attrs: {}, location: 'local', syncedAt: '',
        createdAt: nowISO(), updatedAt: nowISO(), createdBy: '', updatedBy: '',
      };

  const body = mk('div');

  const fields = [
    { key: 'code', label: '物料编码', type: 'text', required: true, placeholder: '如 120201501' },
    { key: 'name', label: '物料名称', type: 'text', required: true },
    ...defs,
  ];
  const flat = { code: current.code, name: current.name, ...(current.attrs || {}) };
  const form = renderForm({ fields }, { fields: flat });
  body.appendChild(form.root);

  // 位置信息（只读）：有未提交草稿=本地，与云端一致=云端
  const locLine = mk('div', { class: 'muted', style: 'margin-top:12px;font-size:12px;' });
  const locKey = (isNew || draftOf('material', current.id)) ? 'local' : 'cloud';
  locLine.textContent = `物料位置：${LOCATION[locKey]}` +
    (locKey === 'cloud' && current.syncedAt ? `　最近同步：${fmtTime(current.syncedAt)}` : '　（提交后自动标记为云端）');
  body.appendChild(locLine);

  openModal({
    title: isNew ? '新增物料' : '编辑物料',
    body,
    actions: [
      { label: '取消', onClick: closeModal },
      {
        label: '保存草稿', className: 'primary',
        onClick: async () => {
          const errs = form.errors();
          if (errs.length) { toastErr('校验未通过：' + errs.join('；')); return; }
          const v = form.read();
          // 物料编码全局唯一（导入也按编码匹配）
          const code = String(v.code || '').trim();
          if (state.materials.some(m => m.id !== current.id && (m.code || '') === code)) {
            toastErr(`物料编码「${code}」已存在`);
            return;
          }
          // 末级分组的字段值，每个物料各自存一份
          const attrs = {};
          for (const def of defs) {
            const val = v[def.key];
            if (val === '' || val == null) continue;
            if (Array.isArray(val) && !val.length) continue;
            if (def.type === 'range' && val.min === '' && val.max === '') continue;
            attrs[def.key] = val;
          }
          const data = {
            ...current,
            code,
            name: String(v.name || '').trim(),
            attrs,
            updatedAt: nowISO(),
            location: current.location === 'cloud' ? 'cloud' : 'local',
          };
          await saveMaterialDraft(data, isNew ? 'add' : 'update');
          closeModal();
          render();
          toastOk('已存为草稿');
        },
      },
    ],
  });
}

async function doDeleteMaterial(m) {
  const d = draftOf('material', m.id);
  if (!(await confirm(`确定删除物料「${m.name || m.code || m.id}」？`))) return;
  if (d?.op === 'add') {
    await Store.removeDraft('material', m.id);
    await loadDrafts();
  } else {
    await saveMaterialDraft({ ...m }, 'delete');
  }
  state.checked.delete(m.id);
  render();
  toastOk('已标记为删除');
}

// ---------- 批量操作 ----------
function openBatchMoveDialog() {
  const ids = Array.from(state.checked);
  if (!ids.length) { toastErr('请先勾选物料'); return; }
  const leaves = leafCategories();

  const body = mk('div');
  body.appendChild(mk('p', { class: 'muted' }, `已选 ${ids.length} 条物料，转移到：`));

  const sel = mk('select', { style: 'width:100%;padding:6px 10px;border:1px solid var(--border-strong);border-radius:6px;' });
  sel.appendChild(mk('option', { value: UNGROUPED }, '未分组'));
  const grouped = leaves.map(c => ({ id: c.id, label: Cat.categoryPathString(state.categories, c.id) }))
    .sort((a, b) => a.label.localeCompare(b.label, 'zh'));
  for (const c of grouped) sel.appendChild(mk('option', { value: c.id }, c.label));
  body.appendChild(sel);

  openModal({
    title: '批量转移分组',
    body,
    actions: [
      { label: '取消', onClick: closeModal },
      {
        label: '确认转移', className: 'primary',
        onClick: async () => {
          const target = sel.value;
          for (const id of ids) {
            const m = state.materials.find(x => x.id === id);
            if (!m) continue;
            const d = draftOf('material', id);
            const op = d?.op === 'add' ? 'add' : 'update';
            await saveMaterialDraft({ ...m, categoryId: target, updatedAt: nowISO() }, op);
          }
          closeModal();
          render();
          toastOk(`已转移 ${ids.length} 条物料`);
        },
      },
    ],
  });
}

async function doBatchDelete() {
  const ids = Array.from(state.checked);
  if (!ids.length) { toastErr('请先勾选物料'); return; }
  if (!(await confirm(`确定删除选中的 ${ids.length} 条物料？`))) return;
  for (const id of ids) {
    const m = state.materials.find(x => x.id === id);
    if (!m) continue;
    const d = draftOf('material', id);
    if (d?.op === 'add') await Store.removeDraft('material', id);
    else await saveMaterialDraft({ ...m }, 'delete');
  }
  state.checked.clear();
  await loadDrafts();
  render();
  toastOk(`已删除 ${ids.length} 条（草稿）`);
}

// ---------- Excel 导入导出 ----------
function doExport() {
  const list = currentMaterials();
  if (!list.length) { toastErr('当前没有可导出的物料'); return; }
  try {
    // 物料位置按同步状态推导：有未提交草稿=本地
    const rows = list.map(m => ({ ...m, location: draftOf('material', m.id) ? 'local' : 'cloud' }));
    const n = Excel.exportMaterials(rows, state.categories);
    toastOk(`已导出 ${n} 条物料`);
  } catch (e) {
    toastErr('导出失败：' + (e.message || e));
  }
}

function triggerImport() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.xlsx,.xls';
  input.addEventListener('change', async () => {
    if (!input.files?.length) return;
    const file = input.files[0];
    try {
      const rows = await Excel.parseMaterialsFile(file);
      openImportPreview(rows, file.name);
    } catch (e) {
      toastErr('读取失败：' + (e.message || e));
    }
  });
  input.click();
}

function openImportPreview(rows, fileName) {
  if (!rows.length) { toastErr('文件里没有数据行'); return; }

  // 在副本上预演，避免改动真实数据
  const cats = clone(state.categories);
  const plan = { updates: [], inserts: [], createdCats: [] };

  for (const row of rows) {
    const segs = row.groupNames || [];
    // 分组列为空 → 未分组（虚拟节点，categoryId 为空字符串）
    let categoryId = UNGROUPED;
    if (segs.length) {
      const r = Cat.resolveOrCreatePath(cats, segs, () => mint('c'));
      categoryId = r.categoryId;
      for (const c of r.created) plan.createdCats.push(c);
    }

    const existing = (row.id && state.materials.find(m => m.id === row.id))
      || (row.code && state.materials.find(m => m.code === row.code))
      || null;

    const targetCatId = categoryId;

    // 导入只锁定分组路径；属性（分组级/物料级）都在页面里维护
    const data = {
      ...(existing || {
        id: row.id || mint('m'),
        createdAt: nowISO(), createdBy: '', updatedBy: '',
        location: 'local', syncedAt: '', attrs: {},
      }),
      categoryId: targetCatId,
      code: row.code || existing?.code || '',
      name: row.name || existing?.name || '',
      updatedAt: nowISO(),
    };
    if (existing) plan.updates.push({ existing, data });
    else plan.inserts.push({ data });
  }

  const body = mk('div');
  body.appendChild(mk('p', {}, `文件：${fileName}`));
  const ul = mk('ul', { style: 'margin:8px 0 0;padding-left:18px;' });
  ul.appendChild(mk('li', {}, `更新已有物料：${plan.updates.length} 条`));
  ul.appendChild(mk('li', {}, `新增物料：${plan.inserts.length} 条`));
  ul.appendChild(mk('li', {}, `需新建分组：${plan.createdCats.length} 个`));
  body.appendChild(ul);
  body.appendChild(mk('p', { class: 'muted', style: 'margin-top:10px;font-size:12px;' },
    '导入只会写入本地草稿，仍需到「提交管理」统一提交才会生效。'));

  openModal({
    title: '导入预览',
    body,
    actions: [
      { label: '取消', onClick: closeModal },
      {
        label: '写入草稿', className: 'primary',
        onClick: async () => {
          // 新建的分组
          for (const c of plan.createdCats) {
            const existingDraft = draftOf('category', c.id);
            await saveCategoryDraft(c, existingDraft?.op === 'update' ? 'update' : 'add');
          }
          for (const u of plan.updates) {
            const d = draftOf('material', u.existing.id);
            await saveMaterialDraft(u.data, d?.op === 'add' ? 'add' : 'update');
          }
          for (const i of plan.inserts) await saveMaterialDraft(i.data, 'add');

          closeModal();
          render();
          toastOk(`已写入草稿：更新 ${plan.updates.length} / 新增 ${plan.inserts.length}`);
        },
      },
    ],
  });
}

// ---------- 分组管理（统一保存） ----------
// 板块1 分组属性：名称/排序/末级/描述
// 板块2 本级属性值：直接父级定义的字段，本组填值（整组一份，不进物料档案）；父级没定义则不显示
// 板块3 继承的属性：更高层祖先定义的字段，只读显示上级已填的值；没有则不显示
// 板块4 字段定义：非末级=给下级分组添加属性（下级在「本级属性值」填值）；末级=物料属性（进物料档案）
function buildManagePanel(cat) {
  const panel = mk('div', { class: 'tab-panel' });
  const body = mk('div', { class: 'materials-body' });
  // 左侧表单内容列（可滚动），右侧图标工具栏（保存 / 删除）
  const formCol = mk('div', { class: 'manage-flat', style: 'flex:1; min-width:0; overflow-y:auto; padding:2px 4px 2px 2px;' });

  // 板块 1：分组属性
  const s1 = mk('div', { class: 'section' });
  s1.appendChild(sectionTitle(1, '分组属性'));
  const formGrid = mk('div', { class: 'form-grid' });

  const nameInput = mk('input', { type: 'text', value: cat.name || '' });
  const sortInput = mk('input', { type: 'number', value: cat.sort ?? 0 });
  const descInput = mk('textarea', { rows: 2 });
  descInput.value = cat.desc || '';

  const kids = Cat.childIds(state.categories, cat.id);
  const leafChk = mk('input', { type: 'checkbox' });
  leafChk.checked = !!cat.isLeaf;
  leafChk.disabled = kids.length > 0;
  const leafWrap = mk('label', { class: 'checkbox-label' });
  leafWrap.appendChild(leafChk);
  leafWrap.appendChild(document.createTextNode(
    kids.length ? '末级分组（已有下一级分组，不可设为末级）' : '末级分组（勾选后可挂物料档案）'));

  formGrid.appendChild(fieldBox('名称', nameInput));
  formGrid.appendChild(fieldBox('排序', sortInput));
  formGrid.appendChild(fieldBox('是否末级', leafWrap));
  const descBox = fieldBox('描述', descInput);
  descBox.classList.add('full');
  formGrid.appendChild(descBox);
  s1.appendChild(formGrid);
  formCol.appendChild(s1);

  // 本级属性值：直接父级定义的字段，本组在这里填值（整组一份，不进物料档案，可编辑）
  // 继承的属性：更高层祖先定义的字段，显示上级已填好的值（只读，要改请到对应分组）
  let secIdx = 1;
  const chain = Cat.categoryPath(state.categories, cat.id).slice(0, -1); // 祖先链，根在前
  const directParent = chain[chain.length - 1] || null;
  const parentDefs = (directParent?.attrs || []).map(a => ({ ...a, fromCategory: directParent.name }));
  const parentKeys = new Set(parentDefs.map(a => a.key));
  // 更高层祖先的字段：同 key 就近覆盖；直接父级已定义的（归本级属性值）不重复显示
  const ancestorDefMap = new Map();
  for (const anc of chain.slice(0, -1)) {
    for (const a of anc.attrs || []) {
      if (!parentKeys.has(a.key)) ancestorDefMap.set(a.key, { ...a, fromCategory: anc.name });
    }
  }
  const ancestorDefs = Array.from(ancestorDefMap.values());
  // 继承值 = 父级整条链的生效值（就近覆盖）
  const inheritedVals = directParent ? Cat.effectiveValues(state.categories, directParent.id) : {};

  let ownForm = null;
  if (parentDefs.length) {
    const s = mk('div', { class: 'section' });
    s.appendChild(sectionTitle(++secIdx, '本级属性值',
      `由上级分组「${directParent.name}」定义的字段，这里填本组的值；整个分组一份，不进物料档案`));
    ownForm = renderForm({ fields: parentDefs }, { fields: cat.attrValues || {} });
    s.appendChild(ownForm.root);
    formCol.appendChild(s);
  }
  if (ancestorDefs.length) {
    const s = mk('div', { class: 'section' });
    s.appendChild(sectionTitle(++secIdx, '继承的属性', '更高层分组定义、上级已填好的值，只读；要改请到对应分组修改'));
    const grid = mk('div', { class: 'form-grid' });
    for (const def of ancestorDefs) {
      const inp = mk('input', {
        type: 'text',
        value: Cat.fmtAttrValue(def, inheritedVals[def.key]),
        disabled: true,
        placeholder: '（上级未填）',
      });
      const box = fieldBox(def.label, inp);
      box.querySelector('label').appendChild(mk('span', { class: 'from-tag' }, ` 来自 ${def.fromCategory}`));
      grid.appendChild(box);
    }
    s.appendChild(grid);
    formCol.appendChild(s);
  }

  // 字段定义（非末级 → 下级分组自动继承；末级 → 物料属性，进物料档案）
  const s3 = mk('div', { class: 'section' });
  if (cat.isLeaf) {
    s3.appendChild(sectionTitle(++secIdx, '物料属性', '末级分组才有的字段：进入物料档案的列和新增/编辑表单，每个物料各自填值'));
  } else {
    s3.appendChild(sectionTitle(++secIdx, '给下级分组添加属性', '定义一次，所有下级分组自动拥有，在各自的分组管理里填值；不进物料档案'));
  }
  const attrTable = renderAttrDefTable(cat.attrs || []);
  s3.appendChild(attrTable.root);
  formCol.appendChild(s3);

  // 统一保存：板块1 + 本级属性值 + 字段定义 一次存草稿
  const doSaveAll = async () => {
    const name = nameInput.value.trim();
    if (!name) { toastErr('名称必填'); return; }

    let attrs;
    try { attrs = attrTable.read(); } catch (e) { toastErr(e.message); return; }
    const keys = attrs.map(a => a.key);
    if (new Set(keys).size !== keys.length) { toastErr('属性 key 不能重复'); return; }

    // 本级属性值（直接父级定义的字段；整组一份，存本组 attrValues）
    const attrValues = { ...(cat.attrValues || {}) };
    if (ownForm) {
      const errs = ownForm.errors();
      if (errs.length) { toastErr('校验未通过：' + errs.join('；')); return; }
      const raw = ownForm.read();
      for (const def of parentDefs) {
        const v = raw[def.key];
        if (v === '' || v == null || (Array.isArray(v) && !v.length)
          || (def.type === 'range' && v.min === '' && v.max === '')) {
          delete attrValues[def.key];
        } else {
          attrValues[def.key] = v;
        }
      }
    }
    // 清掉已不属于任何生效字段的残留值
    const validKeys = new Set([...parentKeys, ...ancestorDefs.map(a => a.key), ...keys]);
    for (const k of Object.keys(attrValues)) if (!validKeys.has(k)) delete attrValues[k];

    const next = {
      ...cat,
      name,
      sort: Number(sortInput.value) || 0,
      desc: descInput.value.trim(),
      isLeaf: kids.length ? false : leafChk.checked,
      attrs,
      attrValues,
    };
    delete next.code;
    const d = draftOf('category', cat.id);
    await saveCategoryDraft(next, d?.op === 'add' ? 'add' : 'update');
    render();
    toastOk('已保存为草稿');
  };

  // 右侧图标工具栏：保存 / 删除（样式同物料档案侧栏）
  const rail = mk('div', { class: 'side-rail' });
  const saveBtn = mk('button', { class: 'rail-btn', title: '保存' }, '✓');
  saveBtn.addEventListener('click', doSaveAll);
  rail.appendChild(saveBtn);
  rail.appendChild(mk('div', { class: 'rail-sep' }));
  const delBtn = mk('button', { class: 'rail-btn danger-hover', title: '删除分组' }, '✕');
  delBtn.addEventListener('click', () => doDeleteCategory(cat));
  rail.appendChild(delBtn);

  body.appendChild(formCol);
  body.appendChild(rail);
  panel.appendChild(body);
  return panel;
}

// 删除分组：有子分组或物料时不允许删；删除走草稿（提交管理可撤销）
async function doDeleteCategory(cat) {
  const kids = Cat.childIds(state.categories, cat.id);
  if (kids.length) { toastErr('该分组下还有子分组，请先删除或移走子分组'); return; }
  const matCount = state.materials.filter(m => m.categoryId === cat.id).length;
  if (matCount) { toastErr(`该分组下还有 ${matCount} 条物料，请先转移或删除这些物料`); return; }
  if (!(await confirm(`确定删除分组「${cat.name}」？`))) return;
  const d = draftOf('category', cat.id);
  if (d?.op === 'add') {
    await Store.removeDraft('category', cat.id);
    await loadDrafts();
  } else {
    await saveCategoryDraft({ ...cat }, 'delete');
  }
  render();
  toastOk('已标记为删除');
}

function sectionTitle(idx, text, sub) {
  const h = mk('div', { class: 'section-title' });
  h.appendChild(mk('span', { class: 'idx' }, String(idx)));
  h.appendChild(document.createTextNode(text));
  if (sub) h.appendChild(mk('span', { class: 'sub' }, sub));
  return h;
}

function fieldBox(label, input) {
  const wrap = mk('div', { class: 'field' });
  wrap.appendChild(mk('label', {}, label));
  wrap.appendChild(input);
  return wrap;
}

// ---------- 分组新建 ----------
function openCategoryDialog(parentId) {
  const body = mk('div');
  const nameInput = mk('input', { type: 'text', placeholder: '分组名称，如 成品' });

  const grid = mk('div', { class: 'form-grid' });
  const nameBox = fieldBox('名称', nameInput);
  nameBox.classList.add('full');
  grid.appendChild(nameBox);
  body.appendChild(grid);

  if (parentId) {
    body.appendChild(mk('div', { class: 'muted', style: 'margin-top:10px;font-size:12px;' },
      '父级：' + Cat.categoryPathString(state.categories, parentId)));
  }

  openModal({
    title: parentId ? '新建子分组' : '新建分组',
    body,
    actions: [
      { label: '取消', onClick: closeModal },
      {
        label: '创建', className: 'primary',
        onClick: async () => {
          const name = nameInput.value.trim();
          if (!name) { toastErr('名称必填'); return; }
          // 同级不允许重名，避免误建出多个同名分组
          if (state.categories.some(c => (c.parentId || null) === (parentId || null) && c.name === name)) {
            toastErr(`同级下已存在「${name}」`);
            return;
          }
          // 新分组排在同级最下面，默认非末级（末级在「分组管理」里勾选）
          const siblingCount = state.categories.filter(c => (c.parentId ?? null) === (parentId ?? null)).length;
          const cat = Cat.makeCategory(() => mint('c'), {
            name, parentId: parentId || null, sort: siblingCount,
          });
          await saveCategoryDraft(cat, 'add');
          // 父级不再是末级
          if (parentId) {
            const parent = Cat.findCategory(state.categories, parentId);
            if (parent) {
              await saveCategoryDraft({ ...parent, isLeaf: false }, draftOf('category', parentId)?.op === 'add' ? 'add' : 'update');
            }
            state.expanded.add(parentId);
          }
          state.selectedCategoryId = cat.id;
          state.activeTab = 'manage';
          closeModal();
          render();
          toastOk('分组已创建（草稿）');
        },
      },
    ],
  });
}

// ---------- 设置 ----------
function renderSettings() {
  const content = document.getElementById('content');
  content.className = 'content scroll';
  content.innerHTML = '';

  const form = mk('div', { class: 'settings-form' });
  form.appendChild(mk('h2', { style: 'margin:0 0 4px;font-size:15px;' }, '仓库设置'));
  form.appendChild(mk('div', { class: 'hint' }, '修好后点保存，然后去「提交管理」填 PAT 提交。'));

  const ownerInput = mk('input', { type: 'text', value: state.settings.owner });
  const repoInput = mk('input', { type: 'text', value: state.settings.repo });
  const branchInput = mk('input', { type: 'text', value: state.settings.branch });

  form.appendChild(settingRow('Owner', ownerInput));
  form.appendChild(settingRow('Repo', repoInput));
  form.appendChild(settingRow('Branch', branchInput));

  const saveBtn = mk('button', { class: 'btn primary' }, '保存');
  saveBtn.addEventListener('click', async () => {
    const owner = ownerInput.value.trim();
    const repo = repoInput.value.trim();
    const branch = branchInput.value.trim();
    if (!owner || !repo || !branch) { toastErr('请填写完整'); return; }
    GH.saveGithubSettings({ owner, repo, branch });
    state.settings = GH.getGithubSettings();
    toastOk('已保存，正在重新同步…');
    await refreshRemote();
    await loadDrafts();
    render();
  });
  form.appendChild(saveBtn);

  content.appendChild(form);
}

function settingRow(label, input, hint) {
  const row = mk('div', { class: 'row' });
  row.appendChild(mk('label', {}, label));
  row.appendChild(input);
  if (hint) row.appendChild(mk('div', { class: 'hint' }, hint));
  return row;
}

// ---------- 提交管理 ----------
function renderCommit() {
  const content = document.getElementById('content');
  content.className = 'content scroll';
  content.innerHTML = '';

  content.appendChild(mk('h2', { style: 'margin:0 0 4px;font-size:15px;' }, '提交管理'));
  content.appendChild(mk('p', { class: 'muted', style: 'margin:0 0 16px;font-size:12px;' },
    '所有改动先暂存在浏览器（IndexedDB），勾选后一次性提交到 GitHub；提交成功后自动清空已提交的草稿。'));

  // PAT
  const patSection = mk('div', { class: 'section' });
  patSection.appendChild(mk('div', { class: 'section-title' }, 'GitHub Token'));
  const patInput = mk('input', {
    type: 'password',
    value: state.pat,
    placeholder: 'github_pat_xxxxxxxx',
    autocomplete: 'off',
    style: 'width:100%;padding:6px 10px;border:1px solid var(--border-strong);border-radius:6px;',
  });
  patInput.addEventListener('input', () => {
    state.pat = patInput.value.trim();
    GH.setToken(state.pat);
  });
  patSection.appendChild(patInput);
  patSection.appendChild(mk('div', { class: 'hint', style: 'margin-top:6px;font-size:12px;color:var(--text-muted);' },
    'Fine-grained PAT，仅授予本仓库 Contents: Read and write。Token 只存在内存，刷新即清除。'));
  content.appendChild(patSection);

  // 改动列表
  const listSection = mk('div', { class: 'section' });
  listSection.appendChild(mk('div', { class: 'section-title' }, `待提交改动（${state.drafts.length}）`));

  if (!state.drafts.length) {
    listSection.appendChild(mk('div', { class: 'empty', style: 'padding:24px;' }, '暂无待提交改动'));
  } else {
    const checkboxes = [];
    const selAllRow = mk('label', { class: 'checkbox-label', style: 'margin-bottom:6px;' });
    const selAll = mk('input', { type: 'checkbox' });
    selAll.checked = true;
    selAllRow.appendChild(selAll);
    selAllRow.appendChild(document.createTextNode(' 全选'));
    listSection.appendChild(selAllRow);

    const ul = mk('ul', { class: 'commit-list' });
    for (const d of state.drafts) {
      const li = mk('li');
      const chk = mk('input', { type: 'checkbox' });
      chk.checked = true;
      chk.dataset.id = d.id;
      checkboxes.push(chk);
      li.appendChild(chk);
      li.appendChild(mk('span', {}, draftLabel(d)));
      ul.appendChild(li);
    }
    listSection.appendChild(ul);

    selAll.addEventListener('change', () => checkboxes.forEach(c => { c.checked = selAll.checked; }));

    const msgInput = mk('input', {
      type: 'text',
      placeholder: '提交说明（留空自动生成）',
      style: 'width:100%;padding:6px 10px;border:1px solid var(--border-strong);border-radius:6px;margin-top:12px;',
    });
    listSection.appendChild(msgInput);

    const btn = mk('button', { class: 'btn primary', style: 'margin-top:12px;' }, '提交选中项到 GitHub');
    btn.addEventListener('click', () => {
      const ids = checkboxes.filter(c => c.checked).map(c => c.dataset.id);
      if (!ids.length) { toastErr('请勾选至少一项'); return; }
      if (!state.pat) { toastErr('请先填写 GitHub Token'); return; }
      doCommit(ids, msgInput.value.trim(), btn);
    });
    listSection.appendChild(btn);
  }
  content.appendChild(listSection);

  // 清空草稿
  const dangerSection = mk('div', { class: 'section' });
  const discard = mk('button', { class: 'btn danger' }, '丢弃全部草稿');
  discard.disabled = !state.drafts.length;
  discard.addEventListener('click', discardAllDrafts);
  dangerSection.appendChild(discard);
  content.appendChild(dangerSection);
}

function draftLabel(d) {
  if (d.kind === 'category') {
    const opText = { add: '新增', update: '修改', delete: '删除' }[d.op] || d.op;
    return `【分组】${opText} ${d.data?.name || d.recordId}`;
  }
  const opText = { add: '新增', update: '修改', delete: '删除' }[d.op] || d.op;
  const catName = d.data?.categoryId ? Cat.categoryPathString(state.categories, d.data.categoryId) : '';
  return `【物料】${opText} ${d.data?.code || d.recordId}${d.data?.name ? ' ' + d.data.name : ''}${catName ? '（' + catName + '）' : ''}`;
}

async function discardAllDrafts() {
  if (!state.drafts.length) return;
  if (!(await confirm('丢弃全部未提交改动？此操作不可恢复。'))) return;
  await Store.clearAllCache();
  await loadDrafts();
  render();
  toastOk('已清空全部草稿');
}

// ---------- 提交 ----------
function buildCommitPayload(selectedDrafts) {
  const now = nowISO();
  let cats = clone(state.baseCategories);
  let mats = clone(state.baseMaterials);

  for (const d of selectedDrafts) {
    if (d.kind === 'category') {
      const idx = cats.findIndex(c => c.id === d.recordId);
      if (d.op === 'delete') { if (idx >= 0) cats.splice(idx, 1); }
      else if (idx >= 0) cats[idx] = clone(d.data);
      else cats.push(clone(d.data));
    } else {
      const idx = mats.findIndex(m => m.id === d.recordId);
      if (d.op === 'delete') { if (idx >= 0) mats.splice(idx, 1); }
      else {
        const next = clone(d.data);
        next.location = 'cloud';
        next.syncedAt = now;
        if (idx >= 0) mats[idx] = next; else mats.push(next);
      }
    }
  }

  const catsText = JSON.stringify(cats, null, 2) + '\n';
  const matsText = JSON.stringify(mats, null, 2) + '\n';

  const textChanges = [];
  if (catsText !== state.rawCategoriesText) textChanges.push({ path: CONFIG.categoriesPath, content: catsText });
  if (matsText !== state.rawMaterialsText) textChanges.push({ path: CONFIG.materialsPath, content: matsText });

  return { textChanges, cats, mats };
}

async function doCommit(selectedIds, message, btn) {
  const draftsToSubmit = state.drafts.filter(d => selectedIds.includes(d.id));
  btn.disabled = true;
  const oldText = btn.textContent;
  btn.textContent = '提交中…';

  try {
    GH.setToken(state.pat);
    const { textChanges } = buildCommitPayload(draftsToSubmit);
    if (!textChanges.length) { toastErr('内容与远端一致，无需提交'); btn.disabled = false; btn.textContent = oldText; return; }

    const result = await GH.singleCommit({
      message: message || `chore: Craft 后台提交（${draftsToSubmit.length} 项）`,
      baseCommit: state.remoteHead,
      treeChanges: textChanges,
      treeDeletes: [],
    });

    // 清掉已提交的草稿
    for (const d of draftsToSubmit) {
      const [kind, id] = d.id.split(/:(.+)/);
      await Store.removeDraft(kind, id);
    }
    toastOk(`已提交，commit ${result.commitSha.slice(0, 7)}`);
    await refreshRemote();
    await loadDrafts();
    render();
  } catch (e) {
    btn.disabled = false;
    btn.textContent = oldText;
    if (e.code === 'CONFLICT') {
      toastErr('远端已更新，已重新同步，请重新勾选提交');
      await refreshRemote();
      await loadDrafts();
      render();
    } else {
      toastErr('提交失败：' + (e.message || e));
      console.error(e);
    }
  }
}

// ---------- loading ----------
function setLoading() {
  const content = document.getElementById('content');
  content.className = 'content';
  content.innerHTML = '';
  content.appendChild(mk('div', { class: 'loading' }, '加载中…'));
}
