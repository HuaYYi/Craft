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

import { CONFIG, LOCATION, FIELD_TYPES } from './config.js';
import * as Store from './store.js';
import * as GH from './github.js';
import * as Cat from './categories.js';
import * as Excel from './excel.js';
import { renderForm, renderAttrDefTable, mk } from './fields.js';
import { openModal, closeModal, toastOk, toastErr, confirm, toast } from './ui.js';

// ---------- 全局状态 ----------
const state = {
  view: 'materials',
  // 远端基准（未应用草稿）
  baseCategories: [],
  baseMaterials: [],
  baseDictionaries: [],
  baseAttrSets: [],
  rawCategoriesText: '',
  rawMaterialsText: '',
  rawDictionariesText: '',
  rawAttrSetsText: '',
  // 应用草稿后的展示数据
  categories: [],
  materials: [],
  dictionaries: [],
  attrSets: [],
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

// 物料编码自动生成：年月日 + 四位流水号（如 202610270001）
// 当天已用过的序号往后顺延；草稿里的新物料也算在内，避免重复
function nextMaterialCode() {
  const d = new Date();
  const prefix = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  const used = new Set();
  for (const m of state.materials) {
    const code = String(m.code || '');
    if (!code.startsWith(prefix)) continue;
    const seq = Number(code.slice(prefix.length));
    if (Number.isInteger(seq) && seq > 0) used.add(seq);
  }
  let seq = 1;
  while (used.has(seq)) seq++;
  return prefix + String(seq).padStart(4, '0');
}
const clone = (v) => JSON.parse(JSON.stringify(v));
const UNGROUPED = '';          // 未分组的 categoryId

// 四份数据文件，统一按「草稿 → 提交」处理
const DATA_SETS = [
  { kind: 'category',   path: CONFIG.categoriesPath,   base: 'baseCategories',   live: 'categories',   raw: 'rawCategoriesText' },
  { kind: 'material',   path: CONFIG.materialsPath,    base: 'baseMaterials',    live: 'materials',    raw: 'rawMaterialsText' },
  { kind: 'dictionary', path: CONFIG.dictionariesPath, base: 'baseDictionaries', live: 'dictionaries', raw: 'rawDictionariesText' },
  { kind: 'attrSet',    path: CONFIG.attrSetsPath,     base: 'baseAttrSets',     live: 'attrSets',     raw: 'rawAttrSetsText' },
];

// 分组的生效属性定义（集合字段 + 自有字段）
const attrsOf = (cat) => Cat.withAttrSet(cat, state.attrSets);
// 字段定义补上字典选项，交给表单渲染
const fieldsOf = (defs) => Cat.applyDictionaries(defs, state.dictionaries);

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
  bindInfoTips();
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
  const titles = { materials: '物料及分组', settings: '系统设置', commit: '提交管理' };
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
    const texts = {};

    if (state.pat) {
      try {
        state.remoteHead = await GH.getBranchHead(state.settings.branch);
      } catch (_) { state.remoteHead = null; }
      for (const s of DATA_SETS) {
        const f = await GH.getFile(s.path);
        texts[s.kind] = f ? f.content : null;
      }
    } else {
      state.remoteHead = null;
      for (const s of DATA_SETS) {
        try {
          const r = await fetch(s.path);
          texts[s.kind] = r.ok ? await r.text() : null;
        } catch (_) {
          texts[s.kind] = null;
        }
      }
    }

    for (const s of DATA_SETS) {
      state[s.base] = texts[s.kind] ? safeParse(texts[s.kind], []) : [];
      state[s.raw] = texts[s.kind] || '[]';
    }
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
  const sets = {};
  for (const s of DATA_SETS) sets[s.kind] = clone(state[s.base]);

  for (const d of state.drafts) {
    const target = sets[d.kind];
    if (!target) continue;
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

  for (const s of DATA_SETS) state[s.live] = sets[s.kind];

  // 选中分组若被删掉则回退到未分组
  if (state.selectedCategoryId !== UNGROUPED && !state.categories.some(c => c.id === state.selectedCategoryId)) {
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

async function saveDictionaryDraft(dict, op) {
  await Store.putDraft({
    id: `dictionary:${dict.id}`,
    kind: 'dictionary',
    recordId: dict.id,
    op,
    data: clone(dict),
  });
  await loadDrafts();
}

async function saveAttrSetDraft(set, op) {
  await Store.putDraft({
    id: `attrSet:${set.id}`,
    kind: 'attrSet',
    recordId: set.id,
    op,
    data: clone(set),
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
  // 按物料编码自然排序：草稿是按键名（内部 ID）取回的，顺序本身是随机的，
  // 不显式排序会导致列表/导出顺序错乱
  list = [...list].sort((a, b) =>
    String(a.code || '').localeCompare(String(b.code || ''), 'zh', { numeric: true }));
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

  // 物料属性列：当前可见物料所属末级分组生效字段的并集，每个属性单独一列
  const attrDefs = [];
  const seenKeys = new Set();
  for (const m of list) {
    if (!m.categoryId) continue;
    const cat = Cat.findCategory(state.categories, m.categoryId);
    for (const def of fieldsOf(attrsOf(cat))) {
      if (!seenKeys.has(def.key)) { seenKeys.add(def.key); attrDefs.push(def); }
    }
  }

  const thChk = mk('th', { class: 'col-chk' });
  thChk.appendChild(chkAll);
  head.appendChild(thChk);
  const headLabels = ['物料编码', '物料名称', ...attrDefs.map(d => d.label), '位置', '最近编辑'];
  const headClasses = ['col-code', 'col-name', ...attrDefs.map(() => 'col-attr'), 'col-attr', 'col-attr'];
  headLabels.forEach((t, i) => head.appendChild(mk('th', { class: headClasses[i] }, t)));
  head.appendChild(mk('th', { class: 'col-ops' }, '操作'));
  table.appendChild(head);

  if (!list.length) {
    const tr = mk('tr');
    tr.appendChild(mk('td', { colspan: attrDefs.length + 6, class: 'empty' }, '暂无物料'));
    table.appendChild(tr);
  }

  for (const m of list) {
    const d = draftOf('material', m.id);
    const tr = mk('tr', { class: d ? 'dirty' : '' });

    const tdChk = mk('td', { class: 'col-chk' });
    const chk = mk('input', { type: 'checkbox' });
    chk.checked = state.checked.has(m.id);
    chk.addEventListener('change', () => {
      if (chk.checked) state.checked.add(m.id); else state.checked.delete(m.id);
      render();
    });
    tdChk.appendChild(chk);
    tr.appendChild(tdChk);

    tr.appendChild(mk('td', { class: 'col-code' }, m.code || ''));
    tr.appendChild(mk('td', { class: 'col-name' }, m.name || ''));
    for (const def of attrDefs) {
      tr.appendChild(mk('td', { class: 'wrap col-attr' }, Cat.fmtAttrValue(def, m.attrs?.[def.key])));
    }
    const locTd = mk('td', { class: 'col-attr' });
    locTd.appendChild(buildLocationCell(m));
    tr.appendChild(locTd);

    const editTd = mk('td', { class: 'muted col-attr', style: 'font-size:12px;' },
      fmtTime(m.updatedAt || m.createdAt));
    tr.appendChild(editTd);

    const opsTd = mk('td', { class: 'col-ops' });
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

  // 固定列偏移：勾选框列宽 + 编码列宽 → 「物料名称」的 left
  const pinColumns = () => {
    const chk = table.querySelector('th.col-chk');
    const code = table.querySelector('th.col-code');
    if (!chk || !code) return;
    const left1 = chk.offsetWidth;
    const left2 = left1 + code.offsetWidth;
    table.querySelectorAll('.col-code').forEach(el => { el.style.left = `${left1}px`; });
    table.querySelectorAll('.col-name').forEach(el => { el.style.left = `${left2}px`; });
  };
  pinColumns();
  requestAnimationFrame(pinColumns);
  if (wrap._pinObserver) wrap._pinObserver.disconnect();
  if (window.ResizeObserver) {
    wrap._pinObserver = new ResizeObserver(() => pinColumns());
    wrap._pinObserver.observe(wrap);
  }
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
  // 末级分组的生效字段（属性集合 + 自有字段），选项来自字典
  const defs = fieldsOf(attrsOf(cat));

  let current = mat
    ? clone(mat)
    : {
        id: mint('m'), categoryId: catId || UNGROUPED, code: nextMaterialCode(), name: '',
        attrs: {}, location: 'local', syncedAt: '',
        createdAt: nowISO(), updatedAt: nowISO(), createdBy: '', updatedBy: '',
      };

  const body = mk('div');

  const fields = [
    { key: 'code', label: '物料编码', type: 'text', required: true },
    { key: 'name', label: '物料名称', type: 'text', required: true },
    ...defs,
  ];
  const flat = { code: current.code, name: current.name, ...(current.attrs || {}) };
  const form = renderForm({ fields }, { fields: flat });
  body.appendChild(form.root);

  // 物料编码由系统生成，不允许手改
  const codeInput = form.root.querySelector('#f-code');
  if (codeInput) {
    codeInput.readOnly = true;
    codeInput.title = '按「年月日 + 四位流水号」自动生成';
  }
  body.appendChild(mk('div', { class: 'muted', style: 'margin-top:6px;font-size:12px;' },
    '物料编码按「年月日 + 四位流水号」自动生成'));

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
    const n = Excel.exportMaterials(rows, state.categories, state.attrSets, state.dictionaries);
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

    // 属性列按「显示名 = 字段定义 label」匹配；分组级属性在分组上维护，不在这里读
    const importCat = Cat.findCategory(cats, targetCatId);
    const importedAttrs = {};
    for (const def of fieldsOf(attrsOf(importCat))) {
      const raw = row.raw?.[def.label];
      const parsed = Cat.parseAttrValue(def, Cat.attrValueFromDisplay(def, raw));
      if (parsed !== undefined) importedAttrs[def.key] = parsed;
    }

    const data = {
      ...(existing || {
        id: row.id || mint('m'),
        createdAt: nowISO(), createdBy: '', updatedBy: '',
        location: 'local', syncedAt: '', attrs: {},
      }),
      categoryId: targetCatId,
      code: row.code || existing?.code || '',
      name: row.name || existing?.name || '',
      // Excel 里有值的属性覆盖，Excel 为空的保留原值（避免把已有数据清空）
      attrs: { ...(existing?.attrs || {}), ...importedAttrs },
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
// 板块4 物料属性（字段定义）：非末级=下级自动继承（下级在「本级属性值」填值）；末级=进物料档案
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
  leafWrap.appendChild(document.createTextNode('末级分组'));
  leafWrap.appendChild(infoTip(
    kids.length ? '已有下一级分组，不可设为末级' : '勾选后可挂物料档案'));

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
  const parentDefs = fieldsOf(attrsOf(directParent)).map(a => ({ ...a, fromCategory: directParent.name }));
  const parentKeys = new Set(parentDefs.map(a => a.key));
  // 更高层祖先的字段：同 key 就近覆盖；直接父级已定义的（归本级属性值）不重复显示
  const ancestorDefMap = new Map();
  for (const anc of chain.slice(0, -1)) {
    for (const a of fieldsOf(attrsOf(anc))) {
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

  // 字段定义（非末级 → 下级自动继承；末级 → 进物料档案）
  const s3 = mk('div', { class: 'section' });
  s3.appendChild(sectionTitle(++secIdx, '物料属性',
    cat.isLeaf
      ? '末级分组的字段：进入物料档案的列和新增/编辑表单，每个物料各自填值'
      : '定义一次，所有下级分组自动拥有，在各下级的分组管理里填值；不进物料档案'));

  // 属性集合：一套属性模板，套用后本组字段由集合实时提供
  let pendingDetach = false;
  const linkedSet = state.attrSets.find(s => s.id === cat.attrSetId) || null;
  const setRow = mk('div', { class: 'assign-row' });
  setRow.appendChild(mk('label', {}, '属性集合'));
  setRow.appendChild(infoTip(linkedSet
    ? `下表灰色行来自「${linkedSet.name}」，只读；要改请到「系统设置 → 属性集合」。白色行是本组额外字段。关联新集合会替换本组字段并清理已填的值（保存时会弹窗确认）。`
    : '关联集合会用集合字段替换本组现有字段，并清理这些字段已填的值（保存时会弹窗确认）。'));
  const setSelect = mk('select');
  setSelect.appendChild(mk('option', { value: '' }, '（不关联）'));
  for (const s of state.attrSets) {
    const o = mk('option', { value: s.id }, `${s.name}（${s.attrs.length} 个属性）`);
    if (cat.attrSetId === s.id) o.selected = true;
    setSelect.appendChild(o);
  }
  if (cat.attrSetId && !state.attrSets.some(s => s.id === cat.attrSetId)) {
    const o = mk('option', { value: cat.attrSetId }, '（集合已删除）');
    o.selected = true;
    setSelect.appendChild(o);
  }
  setRow.appendChild(setSelect);

  if (linkedSet) {
    setRow.appendChild(mk('span', { class: 'from-tag' }, '实时关联：改集合会影响所有关联分组'));
    const detachBtn = mk('button', { class: 'btn small', type: 'button' }, '脱离关联（复制一份）');
    detachBtn.addEventListener('click', () => {
      pendingDetach = true;
      setSelect.value = '';
      toast('已改为脱离：集合字段会复制为本组自有字段，点右侧 ✓ 保存后生效');
    });
    setRow.appendChild(detachBtn);
  }
  s3.appendChild(setRow);

  // 集合字段与本组自有字段放在同一张表里，集合行只读
  const attrTable = renderAttrDefTable(cat.attrs || [], state.dictionaries, linkedSet?.attrs || []);
  s3.appendChild(attrTable.root);
  formCol.appendChild(s3);

  // 统一保存：板块1 + 本级属性值 + 字段定义 一次存草稿
  const doSaveAll = async () => {
    const name = nameInput.value.trim();
    if (!name) { toastErr('名称必填'); return; }

    const setId = pendingDetach ? '' : (setSelect.value || '');
    const linking = !!setId && setId !== (cat.attrSetId || '');
    const linkedOf = linking ? state.attrSets.find(s => s.id === setId) : null;
    if (linking && !linkedOf) { toastErr('所选属性集合不存在'); return; }

    // 关联集合 = 用集合字段替换本组原有字段，并清理原有字段已填的值
    let removedKeys = [];
    let valuesInCats = 0;
    let matsAffected = 0;
    if (linking) {
      const setKeys = new Set((linkedOf.attrs || []).map(a => a.key));
      removedKeys = (cat.attrs || []).map(a => a.key).filter(k => !setKeys.has(k));
      const ids = Cat.selfAndDescendantIds(state.categories, cat.id);
      for (const c of state.categories) {
        if (!ids.has(c.id)) continue;
        for (const k of removedKeys) if (k in (c.attrValues || {})) valuesInCats++;
      }
      if (cat.isLeaf) {
        for (const m of state.materials) {
          if (m.categoryId !== cat.id) continue;
          if (removedKeys.some(k => k in (m.attrs || {}))) matsAffected++;
        }
      }

      const ownCount = (cat.attrs || []).length;
      const lines = [
        `关联属性集合「${linkedOf.name}」会用集合字段替换本组现有字段。`,
        removedKeys.length
          ? `· 移除本组现有字段：${removedKeys.join('、')}`
          : (ownCount ? '· 本组自有字段与集合字段 key 相同，改由集合字段接管' : '· 本组当前没有自有字段'),
        valuesInCats ? `· 清理 ${valuesInCats} 处分组属性值（含下级分组）` : '',
        matsAffected ? `· 清理 ${matsAffected} 条物料的属性值` : '',
        removedKeys.length || valuesInCats || matsAffected ? '' : '· 没有已填的数据需要清理',
        '清理只在浏览器草稿里完成，提交前仍可在「提交管理」丢弃；提交后不可恢复。确定继续？',
      ].filter(Boolean);
      const ok = await confirm(lines.join('\n'), '⚠ 会替换字段并清理现有数据');
      if (!ok) { setSelect.value = cat.attrSetId || ''; return; }
    }

    let attrs;
    try { attrs = attrTable.read(); } catch (e) { toastErr(e.message); return; }

    // 脱离关联：把集合字段复制成本组自有字段（同名 key 本组覆盖）
    if (pendingDetach) {
      const merged = new Map();
      for (const a of attrsOf(cat)) merged.set(a.key, a);
      for (const a of attrs) merged.set(a.key, a);
      attrs = Array.from(merged.values());
    }
    // 关联集合：原有自有字段被集合字段替换
    if (linking) attrs = [];

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
    // 关联的属性集合（实时关联）；空值不写字段
    if (setId) next.attrSetId = setId;
    else delete next.attrSetId;
    delete next.code;
    const d = draftOf('category', cat.id);
    await saveCategoryDraft(next, d?.op === 'add' ? 'add' : 'update');

    // 关联后清理被移除字段在下级分组 / 物料上的残留值
    if (linking && removedKeys.length) await cleanFieldValues(cat, removedKeys);

    render();
    toastOk(linking ? '已关联集合并清理旧字段数据（草稿）' : '已保存为草稿');
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
  const copyBtn = mk('button', { class: 'rail-btn', title: '复制分组' }, '⧉');
  copyBtn.addEventListener('click', () => doCopyCategory(cat));
  rail.appendChild(copyBtn);

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

// 复制分组：可连同子分组一起复制，可选是否带上物料（全部走草稿）
async function doCopyCategory(cat) {
  const ids = Cat.selfAndDescendantIds(state.categories, cat.id);
  const subCount = ids.size - 1;
  const matsInTree = state.materials.filter(m => m.categoryId && ids.has(m.categoryId));

  // 目标父级：根级 + 所有非末级分组（排除自身及后代，避免把树拷进自己里面）
  const parentOptions = [{ id: null, label: '（根级）' }];
  for (const c of state.categories) {
    if (ids.has(c.id) || c.isLeaf) continue;
    parentOptions.push({ id: c.id, label: Cat.categoryPathString(state.categories, c.id) });
  }

  const body = mk('div', { class: 'copy-form' });

  body.appendChild(mk('label', {}, '新分组名称'));
  const nameInput = mk('input', { type: 'text', value: `${cat.name} 副本` });
  body.appendChild(nameInput);

  body.appendChild(mk('label', {}, '复制到'));
  const parentSel = mk('select');
  for (const p of parentOptions) {
    const o = mk('option', { value: p.id || '' }, p.label);
    if ((cat.parentId || '') === (p.id || '')) o.selected = true;
    parentSel.appendChild(o);
  }
  body.appendChild(parentSel);

  body.appendChild(mk('label', {}, '复制内容'));
  const onlyChk = mk('input', { type: 'radio', name: 'copyMode', value: 'group', checked: true });
  const allChk = mk('input', { type: 'radio', name: 'copyMode', value: 'all' });
  const modeBox = mk('div', { class: 'copy-modes' });
  const mkMode = (input, text) => {
    const lbl = mk('label', { class: 'copy-mode' });
    lbl.appendChild(input);
    lbl.appendChild(mk('span', {}, text));
    return lbl;
  };
  modeBox.appendChild(mkMode(onlyChk, `仅分组数据（${subCount} 个子分组，不含物料）`));
  modeBox.appendChild(mkMode(allChk, `分组数据 + 物料档案（${subCount} 个子分组，${matsInTree.length} 条物料）`));
  if (!matsInTree.length) allChk.disabled = true;
  body.appendChild(modeBox);
  body.appendChild(mk('div', { class: 'hint' },
    '分组数据包含：名称、描述、排序、末级标记、属性字段与已填的整组属性值；物料会生成新的物料编码。'));

  openModal({
    title: `复制分组「${cat.name}」`,
    body,
    actions: [
      { label: '取消', onClick: closeModal },
      {
        label: '复制', className: 'primary',
        onClick: async () => {
          const name = nameInput.value.trim();
          if (!name) { toastErr('新分组名称必填'); return; }
          const targetParent = parentSel.value || null;
          if (state.categories.some(c => (c.parentId || null) === targetParent && c.name === name)) {
            toastErr('该层级下已有同名分组'); return;
          }

          // 1) 分组：先建新旧 id 映射，再按映射重建父子关系
          const idMap = new Map();
          for (const c of state.categories) if (ids.has(c.id)) idMap.set(c.id, mint('category'));
          const siblingCount = state.categories.filter(c => (c.parentId || null) === targetParent).length;

          const newCats = state.categories
            .filter(c => ids.has(c.id))
            .map(c => {
              const isRoot = c.id === cat.id;
              return {
                ...clone(c),
                id: idMap.get(c.id),
                name: isRoot ? name : c.name,
                parentId: isRoot ? targetParent : idMap.get(c.parentId || null),
                sort: isRoot ? siblingCount : c.sort,
                attrs: clone(c.attrs || []),
                attrValues: clone(c.attrValues || {}),
              };
            });
          for (const nc of newCats) await saveCategoryDraft(nc, 'add');

          // 2) 物料：新编码（当天流水号顺延），挂到复制出来的分组上
          let newMatCount = 0;
          if (allChk.checked && matsInTree.length) {
            const d = new Date();
            const prefix = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
            const used = new Set();
            for (const m of state.materials) {
              const code = String(m.code || '');
              if (!code.startsWith(prefix)) continue;
              const seq = Number(code.slice(prefix.length));
              if (Number.isInteger(seq) && seq > 0) used.add(seq);
            }
            let seq = 1;
            for (const m of matsInTree) {
              while (used.has(seq)) seq++;
              const code = prefix + String(seq).padStart(4, '0');
              used.add(seq);
              await saveMaterialDraft({
                ...clone(m),
                id: mint('m'),
                categoryId: idMap.get(m.categoryId),
                code,
                attrs: clone(m.attrs || {}),
                location: 'local',
                syncedAt: '',
                createdAt: nowISO(),
                updatedAt: nowISO(),
                createdBy: '',
                updatedBy: '',
              }, 'add');
              newMatCount++;
            }
          }

          await loadDrafts();
          closeModal();
          state.selectedCategoryId = idMap.get(cat.id);
          render();
          toastOk(`已复制为「${name}」（${newCats.length} 个分组${newMatCount ? `、${newMatCount} 条物料` : ''}，草稿）`);
        },
      },
    ],
  });
}


// 关联属性集合后，清理被移除字段在下级分组 / 本组物料上的残留值（全部走草稿）
async function cleanFieldValues(cat, removedKeys) {
  if (!removedKeys.length) return;
  const ids = Cat.selfAndDescendantIds(state.categories, cat.id);
  for (const c of state.categories) {
    if (!ids.has(c.id)) continue;
    const hit = removedKeys.filter(k => k in (c.attrValues || {}));
    if (!hit.length) continue;
    const next = { ...c, attrValues: { ...c.attrValues } };
    for (const k of hit) delete next.attrValues[k];
    const d = draftOf('category', c.id);
    await saveCategoryDraft(next, d?.op === 'add' ? 'add' : 'update');
  }
  // 只有末级分组的字段值存在物料上
  if (!cat.isLeaf) return;
  for (const m of state.materials) {
    if (m.categoryId !== cat.id) continue;
    const hit = removedKeys.filter(k => k in (m.attrs || {}));
    if (!hit.length) continue;
    const next = { ...m, attrs: { ...m.attrs }, updatedAt: nowISO() };
    for (const k of hit) delete next.attrs[k];
    const d = draftOf('material', m.id);
    await saveMaterialDraft(next, d?.op === 'add' ? 'add' : 'update');
  }
}

function sectionTitle(idx, text, sub) {
  const h = mk('div', { class: 'section-title' });
  h.appendChild(mk('span', { class: 'idx' }, String(idx)));
  h.appendChild(document.createTextNode(text));
  if (sub) h.appendChild(infoTip(sub));
  return h;
}

// 说明文字统一收进「!」图标，悬浮才显示，避免版面被小字提示占满
function infoTip(text) {
  return mk('span', { class: 'info-tip', 'data-tip': text, 'aria-label': text }, '!');
}

// 提示浮层挂在 body 上用 fixed 定位：面板是可滚动容器，放在里面会被裁剪
let _tipEl = null;

function bindInfoTips() {
  document.addEventListener('mouseover', (e) => {
    const icon = e.target.closest && e.target.closest('.info-tip');
    if (icon) showInfoTip(icon);
  });
  document.addEventListener('mouseout', (e) => {
    if (e.target.closest && e.target.closest('.info-tip')) hideInfoTip();
  });
  window.addEventListener('scroll', hideInfoTip, true);
  window.addEventListener('resize', hideInfoTip);
}

function showInfoTip(icon) {
  hideInfoTip();
  const text = icon.getAttribute('data-tip');
  if (!text) return;
  const el = mk('div', { class: 'info-tip-pop' }, text);
  document.body.appendChild(el);

  const pad = 8;
  const r = icon.getBoundingClientRect();
  const w = el.offsetWidth;
  const h = el.offsetHeight;
  // 水平居中在图标下方，超出视口就夹紧
  let left = r.left + r.width / 2 - w / 2;
  left = Math.max(pad, Math.min(left, window.innerWidth - w - pad));
  // 下方放不下就翻到上方
  let top = r.bottom + 6;
  if (top + h > window.innerHeight - pad) top = Math.max(pad, r.top - h - 6);

  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
  _tipEl = el;
}

function hideInfoTip() {
  if (_tipEl) { _tipEl.remove(); _tipEl = null; }
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

// ---------- 系统设置：字典设置 + 属性集合 ----------
function renderSettings() {
  const content = document.getElementById('content');
  content.className = 'content scroll';
  content.innerHTML = '';

  const tabs = mk('div', { class: 'subtabs' });
  const tabDefs = [
    { key: 'dict', label: `字典设置（${state.dictionaries.length}）` },
    { key: 'set', label: `属性集合（${state.attrSets.length}）` },
  ];
  if (!state.settingTab) state.settingTab = 'dict';
  for (const t of tabDefs) {
    const b = mk('button', { class: `subtab ${state.settingTab === t.key ? 'active' : ''}` }, t.label);
    b.addEventListener('click', () => { state.settingTab = t.key; render(); });
    tabs.appendChild(b);
  }
  content.appendChild(tabs);

  if (state.settingTab === 'dict') content.appendChild(buildDictionarySection());
  else content.appendChild(buildAttrSetSection());
}

// ----- 字典设置 -----
function buildDictionarySection() {
  const wrap = mk('div', { class: 'setting-block' });
  wrap.appendChild(mk('div', { class: 'hint' },
    '字典是给「下拉单选 / 单选 / 多选」类型属性提供选项的选项库，改一次所有引用它的字段一起生效。'));

  if (!state.dictionaries.length) {
    wrap.appendChild(mk('div', { class: 'empty', style: 'padding:20px;' }, '还没有字典'));
  }

  for (const dict of state.dictionaries) {
    const card = mk('div', { class: 'dict-card' });
    const head = mk('div', { class: 'dict-head' });
    const nameInput = mk('input', { type: 'text', value: dict.name, class: 'dict-name' });
    head.appendChild(nameInput);
    head.appendChild(mk('span', { class: 'muted' }, `${dict.items.length} 项`));

    const usedBy = [
      ...state.categories.flatMap(c => (c.attrs || []).map(a => ({ a, c }))),
      ...state.attrSets.flatMap(s => (s.attrs || []).map(a => ({ a, c: { name: '集合：' + s.name } }))),
    ].filter(x => x.a.dictId === dict.id);
    if (usedBy.length) {
      head.appendChild(mk('span', { class: 'from-tag' }, `被 ${usedBy.length} 个字段引用`));
    }

    const delBtn = mk('button', { class: 'btn danger small' }, '删除字典');
    delBtn.addEventListener('click', () => doDeleteDictionary(dict, usedBy));
    head.appendChild(delBtn);
    card.appendChild(head);

    // 字典项
    const itemWrap = mk('div', { class: 'dict-items' });
    const rows = [];
    const addItemRow = (item) => {
      const row = mk('div', { class: 'dict-item-row' });
      const labelInput = mk('input', { type: 'text', value: item?.label || '', placeholder: '显示名，如 35平方' });
      const valueInput = mk('input', { type: 'text', value: item?.value || '', placeholder: '存储值，如 35' });
      const rm = mk('button', { class: 'btn danger small', type: 'button' }, '删');
      row.appendChild(labelInput);
      row.appendChild(valueInput);
      rm.addEventListener('click', () => { row.remove(); });
      row.appendChild(rm);
      itemWrap.appendChild(row);
      rows.push({ row, labelInput, valueInput });
    };
    for (const it of dict.items) addItemRow(it);
    const head2 = mk('div', { class: 'dict-item-row dict-item-head' });
    head2.appendChild(mk('span', { class: 'muted' }, '显示名'));
    head2.appendChild(mk('span', { class: 'muted' }, '存储值'));
    head2.appendChild(mk('span', {}));
    itemWrap.insertBefore(head2, itemWrap.firstChild);
    card.appendChild(itemWrap);

    const actions = mk('div', { class: 'dict-actions' });
    const addBtn = mk('button', { class: 'btn small', type: 'button' }, '＋ 添加选项');
    addBtn.addEventListener('click', () => addItemRow({ label: '', value: '' }));
    actions.appendChild(addBtn);

    const saveBtn = mk('button', { class: 'btn primary small' }, '保存字典');
    saveBtn.addEventListener('click', async () => {
      const name = nameInput.value.trim();
      if (!name) { toastErr('字典名称必填'); return; }
      if (state.dictionaries.some(d => d.id !== dict.id && d.name === name)) {
        toastErr('字典名称已存在'); return;
      }
      const items = [];
      for (const r of rows) {
        if (!r.row.isConnected) continue;
        const label = r.labelInput.value.trim();
        const value = r.valueInput.value.trim();
        if (!label && !value) continue;
        if (!value) { toastErr('存储值不能为空'); return; }
        if (items.some(i => i.value === value)) { toastErr(`存储值「${value}」重复`); return; }
        items.push({ value, label: label || value });
      }
      const d = draftOf('dictionary', dict.id);
      await saveDictionaryDraft({ ...dict, name, items }, d?.op === 'add' ? 'add' : 'update');
      render();
      toastOk('字典已保存为草稿');
    });
    actions.appendChild(saveBtn);
    card.appendChild(actions);

    wrap.appendChild(card);
  }

  const newBtn = mk('button', { class: 'btn' }, '＋ 新建字典');
  newBtn.addEventListener('click', async () => {
    let i = state.dictionaries.length + 1;
    while (state.dictionaries.some(d => d.name === `新字典${i}`)) i++;
    await saveDictionaryDraft({ id: mint('dict'), name: `新字典${i}`, items: [] }, 'add');
    render();
    toast('已创建，改好名称和选项后点「保存字典」');
  });
  wrap.appendChild(newBtn);
  return wrap;
}

async function doDeleteDictionary(dict, usedBy) {
  if (usedBy.length) {
    const where = usedBy.slice(0, 5).map(x => `「${x.c.name}」的「${x.a.label}」`).join('、');
    toastErr(`该字典正被 ${usedBy.length} 个字段引用（${where}${usedBy.length > 5 ? ' 等' : ''}），请先改成其它字典`);
    return;
  }
  if (!(await confirm(`确定删除字典「${dict.name}」？`))) return;
  const d = draftOf('dictionary', dict.id);
  if (d?.op === 'add') {
    await Store.removeDraft('dictionary', dict.id);
    await loadDrafts();
  } else {
    await saveDictionaryDraft({ ...dict }, 'delete');
  }
  render();
  toastOk('已标记为删除');
}

// ----- 属性集合 -----
function buildAttrSetSection() {
  const wrap = mk('div', { class: 'setting-block' });
  wrap.appendChild(mk('div', { class: 'hint' },
    '属性集合是一整套属性模板：在分组管理里「关联」后，该分组的物料属性 / 给下级分组的属性由集合实时提供，改集合一次全部生效。'));

  if (!state.attrSets.length) {
    wrap.appendChild(mk('div', { class: 'empty', style: 'padding:20px;' }, '还没有属性集合'));
  }

  for (const set of state.attrSets) {
    const card = mk('div', { class: 'dict-card' });
    const head = mk('div', { class: 'dict-head' });
    const nameInput = mk('input', { type: 'text', value: set.name, class: 'dict-name' });
    head.appendChild(nameInput);
    const usedBy = state.categories.filter(c => c.attrSetId === set.id);
    head.appendChild(mk('span', { class: 'muted' },
      `${set.attrs.length} 个属性 · ${usedBy.length} 个分组在用`));
    const delBtn = mk('button', { class: 'btn danger small' }, '删除集合');
    delBtn.addEventListener('click', () => doDeleteAttrSet(set, usedBy));
    head.appendChild(delBtn);
    card.appendChild(head);

    const editor = renderAttrDefTable(set.attrs || [], state.dictionaries);
    card.appendChild(editor.root);

    const actions = mk('div', { class: 'dict-actions' });
    const saveBtn = mk('button', { class: 'btn primary small' }, '保存集合');
    saveBtn.addEventListener('click', async () => {
      const name = nameInput.value.trim();
      if (!name) { toastErr('集合名称必填'); return; }
      if (state.attrSets.some(s => s.id !== set.id && s.name === name)) { toastErr('集合名称已存在'); return; }
      let attrs;
      try { attrs = editor.read(); } catch (e) { toastErr(e.message); return; }
      const keys = attrs.map(a => a.key);
      if (new Set(keys).size !== keys.length) { toastErr('属性 key 不能重复'); return; }
      const d = draftOf('attrSet', set.id);
      await saveAttrSetDraft({ ...set, name, attrs }, d?.op === 'add' ? 'add' : 'update');
      render();
      toastOk('属性集合已保存为草稿');
    });
    actions.appendChild(saveBtn);
    card.appendChild(actions);

    wrap.appendChild(card);
  }

  const newBtn = mk('button', { class: 'btn' }, '＋ 新建属性集合');
  newBtn.addEventListener('click', async () => {
    let i = state.attrSets.length + 1;
    while (state.attrSets.some(s => s.name === `新集合${i}`)) i++;
    await saveAttrSetDraft({ id: mint('set'), name: `新集合${i}`, attrs: [] }, 'add');
    render();
    toast('已创建，改好名称和属性后点「保存集合」');
  });
  wrap.appendChild(newBtn);
  return wrap;
}

async function doDeleteAttrSet(set, usedBy) {
  if (usedBy.length) {
    toastErr(`该集合正被 ${usedBy.length} 个分组关联（${usedBy.slice(0, 3).map(c => '「' + c.name + '」').join('、')}${usedBy.length > 3 ? ' 等' : ''}），请先在这些分组里取消关联或脱离关联`);
    return;
  }
  if (!(await confirm(`确定删除属性集合「${set.name}」？`))) return;
  const d = draftOf('attrSet', set.id);
  if (d?.op === 'add') {
    await Store.removeDraft('attrSet', set.id);
    await loadDrafts();
  } else {
    await saveAttrSetDraft({ ...set }, 'delete');
  }
  render();
  toastOk('已标记为删除');
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

  // 仓库设置（原「设置」页并入这里：提交目标仓库）
  const repoSection = mk('div', { class: 'section' });
  repoSection.appendChild(mk('div', { class: 'section-title' }, '仓库设置'));
  const ownerInput = mk('input', { type: 'text', value: state.settings.owner });
  const repoInput = mk('input', { type: 'text', value: state.settings.repo });
  const branchInput = mk('input', { type: 'text', value: state.settings.branch });
  repoSection.appendChild(settingRow('Owner', ownerInput));
  repoSection.appendChild(settingRow('Repo', repoInput));
  repoSection.appendChild(settingRow('Branch', branchInput));
  const repoSave = mk('button', { class: 'btn' }, '保存仓库设置');
  repoSave.addEventListener('click', async () => {
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
  repoSection.appendChild(repoSave);
  content.appendChild(repoSection);

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
  const opText = { add: '新增', update: '修改', delete: '删除' }[d.op] || d.op;
  if (d.kind === 'category') {
    return `【分组】${opText} ${d.data?.name || d.recordId}`;
  }
  if (d.kind === 'dictionary') {
    return `【字典】${opText} ${d.data?.name || d.recordId}（${d.data?.items?.length || 0} 项）`;
  }
  if (d.kind === 'attrSet') {
    return `【属性集合】${opText} ${d.data?.name || d.recordId}（${d.data?.attrs?.length || 0} 个属性）`;
  }
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
  const sets = {};
  for (const s of DATA_SETS) sets[s.kind] = clone(state[s.base]);

  for (const d of selectedDrafts) {
    const target = sets[d.kind];
    if (!target) continue;
    const idx = target.findIndex(x => x.id === d.recordId);
    if (d.op === 'delete') {
      if (idx >= 0) target.splice(idx, 1);
      continue;
    }
    const next = clone(d.data);
    if (d.kind === 'material') {
      next.location = 'cloud';
      next.syncedAt = now;
    }
    if (idx >= 0) target[idx] = next; else target.push(next);
  }

  const textChanges = [];
  for (const s of DATA_SETS) {
    const text = JSON.stringify(sets[s.kind], null, 2) + '\n';
    if (text !== state[s.raw]) textChanges.push({ path: s.path, content: text });
  }

  return { textChanges };
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
