/* ============================================================
   sheet-core.js — 可复用表格内核（原生 JS，无依赖）
   只管单元格：渲染、选区、直改、拖拽填充、复制粘贴、撤销、冻结、
   列宽、排序、搜索、导出。不认识任何业务概念。
   业务通过 onChange(patches) 落库，落库方式由宿主决定。
   ============================================================ */

const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const numOrRaw = x => { const n = Number(x); return x !== '' && !Number.isNaN(n) ? n : x; };

import { openPicker, openDatePicker } from './pickers.js';

// ---------- 悬浮详情（内容被截断时，悬停一会儿显示全文） ----------
let tipEl = null;
let tipTimer = 0;

export function hideHoverTip() {
  clearTimeout(tipTimer);
  if (tipEl) { tipEl.remove(); tipEl = null; }
}

export function showHoverTip(target, text, delay = 900) {
  clearTimeout(tipTimer);
  if (!target?.isConnected || !text) { hideHoverTip(); return; }
  tipTimer = setTimeout(() => {
    if (!target.isConnected) return;
    if (!tipEl) {
      tipEl = document.createElement('div');
      tipEl.className = 'sc-tip';
      document.body.appendChild(tipEl);
    }
    tipEl.textContent = text;
    tipEl.style.visibility = 'hidden';
    tipEl.style.left = '-9999px';
    tipEl.style.top = '0px';
    const r = target.getBoundingClientRect();
    const tw = tipEl.offsetWidth;
    const th = tipEl.offsetHeight;
    let left = Math.min(r.left, window.innerWidth - tw - 8);
    let top = r.bottom + 6;
    if (top + th > window.innerHeight - 8) top = r.top - th - 6;
    tipEl.style.left = `${Math.max(8, left)}px`;
    tipEl.style.top = `${Math.max(8, top)}px`;
    tipEl.style.visibility = 'visible';
  }, delay);
}

// 文本是否真的被省略号截断：按文本实际宽度判断，
// 不能用 scrollWidth（冻结列阴影、填充柄等伪元素/悬浮元素会把 scrollWidth 撑大）
export function isTextTruncated(el) {
  if (!el || !el.isConnected) return false;
  const style = getComputedStyle(el);
  if (style.textOverflow !== 'ellipsis') return false;
  if (!String(el.textContent || '').trim()) return false;
  const range = document.createRange();
  range.selectNodeContents(el);
  const width = range.getBoundingClientRect().width;
  const inner = el.clientWidth - (parseFloat(style.paddingLeft) || 0) - (parseFloat(style.paddingRight) || 0);
  return width > inner + 1;
}

// 滚动、改窗口、按下鼠标都立即关掉，避免浮窗挡住操作
if (typeof window !== 'undefined') {
  window.addEventListener('scroll', hideHoverTip, true);
  window.addEventListener('resize', hideHoverTip);
  window.addEventListener('mousedown', hideHoverTip, true);
}


function labelOf(col, v) {
  const hit = (col.options || []).find(o => String(o.value) === String(v));
  return hit ? hit.label : String(v);
}

/** 原始值 → 显示文本 */
export function fmtCell(col, raw) {
  if (raw == null || raw === '') return '';
  switch (col.type) {
    case 'bool': return raw === true || raw === 'true' || raw === 1 || raw === '1' ? '是' : '否';
    case 'multiselect': return Array.isArray(raw) ? raw.map(v => labelOf(col, v)).join('、') : String(raw);
    case 'multiselectDropdown': return Array.isArray(raw) ? raw.map(v => labelOf(col, v)).join('、') : String(raw);
    case 'range': return (raw && typeof raw === 'object') ? `${raw.min ?? ''} ~ ${raw.max ?? ''}` : String(raw);
    case 'select': return labelOf(col, raw);
    case 'radio': return labelOf(col, raw);
    default: return String(raw);
  }
}

/** 显示文本 → 原始值，带校验 */
export function parseCell(col, text) {
  const s = String(text ?? '').trim();
  if (s === '') return { ok: true, value: '' };
  switch (col.type) {
    case 'number': {
      const n = Number(s);
      if (Number.isNaN(n)) return { ok: false, reason: '需要填数字' };
      return { ok: true, value: n };
    }
    case 'bool': {
      const t = s.toLowerCase();
      if (['是', 'true', '1', 'yes', 'y'].includes(t)) return { ok: true, value: true };
      if (['否', 'false', '0', 'no', 'n'].includes(t)) return { ok: true, value: false };
      return { ok: false, reason: '请填「是」或「否」' };
    }
    case 'multiselect':
    case 'multiselectDropdown':
      return { ok: true, value: s.split(/[/、,，]/).map(x => x.trim()).filter(Boolean) };
    case 'range': {
      const p = s.split(/[~～]/).map(x => x.trim());
      if (p.length !== 2 || p.some(x => x === '')) return { ok: false, reason: '请填「最小值 ~ 最大值」' };
      return { ok: true, value: { min: numOrRaw(p[0]), max: numOrRaw(p[1]) } };
    }
    case 'select': {
      const hit = (col.options || []).find(o => String(o.label) === s || String(o.value) === s);
      if (!hit) return { ok: false, reason: '不在可选范围内' };
      return { ok: true, value: hit.value };
    }
    case 'radio': {
      const hit = (col.options || []).find(o => String(o.label) === s || String(o.value) === s);
      if (!hit) return { ok: false, reason: '不在可选范围内' };
      return { ok: true, value: hit.value };
    }
    case 'date': {
      if (!/^\d{4}-\d{2}(-\d{2})?/.test(s)) return { ok: false, reason: '日期格式 YYYY-MM-DD' };
      return { ok: true, value: s };
    }
    default:
      return { ok: true, value: s };
  }
}

export function createSheet(host, options = {}) {
  const feat = Object.assign({
    search: true, fill: true, paste: true, undo: true, resize: true,
    sort: true, export: true, log: true, freeze: true, toolbar: true,
    virtual: true,          // 行虚拟化：只渲染当前窗口
  }, options.features || {});

  const cfg = {
    columns: options.columns || [],
    rows: options.rows || [],
    onChange: options.onChange || null,          // (patches) => void
    searchFields: options.searchFields || null,  // 默认全列
    placeholder: options.placeholder || '暂无数据',
    searchPlaceholder: options.searchPlaceholder || '搜索…',
    onLog: options.onLog || null,
    onSelectionChange: options.onSelectionChange || null,
    onError: options.onError || null,            // (message) => void 校验提示
    batchHandler: options.batchHandler || null,  // 外部挂的「批量修改」处理器
    formatter: options.formatter || null,        // (row, col) => text 覆盖默认
  };

  const st = {
    cols: [],
    rows: [],
    sel: null,            // {r, c}  r 是视图行下标
    rangeEnd: null,
    undoStack: [], redoStack: [],
    search: '', sort: null,   // {ci, dir:1|-1}
    editing: null, fill: null,
    filterFn: null,
  };

  // ---------- DOM ----------
  host.innerHTML = `
    <div class="sc-root">
      ${feat.toolbar ? `<div class="sc-toolbar">
        ${feat.search ? `<input class="sc-search" type="text" placeholder="${esc(cfg.searchPlaceholder)}" />` : ''}
        <span class="sc-count"></span>
        <span class="sc-extra"></span>
      </div>` : ''}
      <div class="sc-scroll"><div class="sc-empty">${esc(cfg.placeholder)}</div></div>
      ${feat.log ? '<div class="sc-log"></div>' : ''}
    </div>`;

  const rootEl = host.querySelector('.sc-root');
  const scrollEl = host.querySelector('.sc-scroll');
  const countEl = host.querySelector('.sc-count');
  const logEl = host.querySelector('.sc-log');
  const searchEl = host.querySelector('.sc-search');

  // 单元格内容被省略号截断时，悬停约 1 秒浮出全文
  scrollEl.addEventListener('mouseover', (e) => {
    const td = e.target instanceof Element ? e.target.closest('td') : null;
    if (!td || !table || !table.contains(td) || st.editing) return;
    if (e.relatedTarget instanceof Element && td.contains(e.relatedTarget)) return;
    const text = (td.textContent || '').trim();
    if (!text || !isTextTruncated(td)) { hideHoverTip(); return; }
    showHoverTip(td, text);
  });
  scrollEl.addEventListener('mouseout', (e) => {
    const td = e.target instanceof Element ? e.target.closest('td') : null;
    if (!td) return;
    if (e.relatedTarget instanceof Element && td.contains(e.relatedTarget)) return;
    hideHoverTip();
  });

  let table = null;
  let ghost = null;
  let ghostTimer = null;

  // 行虚拟化：固定行高，窗口上下各留 PAD 行缓冲
  const ROW_H = 30;
  const V_PAD = 8;
  let viewCache = null;
  let scrollRaf = 0;

  function invalidateView() { viewCache = null; }
  function getView() { if (!viewCache) viewCache = viewRows(); return viewCache; }

  // ---------- 数据 ----------
  function normalize(rows) {
    return (rows || []).map((r, i) => {
      if (r && Object.prototype.hasOwnProperty.call(r, '_id') && 'values' in r) return r;
      return { _id: r && r._id != null ? r._id : `__r${i}`, values: (r && r.values) || r || {}, dirty: !!(r && r.dirty) };
    });
  }
  st.rows = normalize(cfg.rows);
  setColumns(cfg.columns, { keepRows: true });

  function setColumns(cols, { keepRows = false, repaint = true } = {}) {
    st.cols = (cols || []).map((c, i) => Object.assign({
      key: c.key, label: c.label || c.key, width: c.width || 130,
      type: c.type || 'text', readonly: !!c.readonly,
      freeze: !!c.freeze, align: c.align || '',
      options: c.options || null, required: !!c.required,
    }, c));
    st.cols.forEach((c, i) => { c._i = i; });
    if (repaint) paint();
  }

  function setRows(rows) {
    st.rows = normalize(rows);
    st.sel = null; st.rangeEnd = null;
    st.undoStack = []; st.redoStack = [];
    invalidateView();
    paint();
  }

  /** 追加若干行（无限滚动/分批加载用），不重置选区与撤销栈 */
  function appendRows(rows) {
    const list = normalize(rows);
    if (!list.length) return 0;
    st.rows.push(...list);
    invalidateView();
    if (!st.editing) paint();
    return list.length;
  }

  function getRows() { return st.rows; }
  function rowById(id) { return st.rows.find(r => String(r._id) === String(id)) || null; }

  /** 追加一行（独立应用 / 弹窗新增用） */
  function addRow(values = {}, opts = {}) {
    const id = opts.id != null ? opts.id : 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
    const row = { _id: id, values: Object.assign({}, values), dirty: opts.dirty !== false };
    if (opts.at != null && opts.at >= 0 && opts.at <= st.rows.length) st.rows.splice(opts.at, 0, row);
    else st.rows.push(row);
    paint();
    return row;
  }

  /** 删除若干行（按 _id） */
  function removeRows(ids) {
    const set = new Set((ids || []).map(String));
    if (!set.size) return 0;
    const before = st.rows.length;
    st.rows = st.rows.filter(r => !set.has(String(r._id)));
    st.sel = null; st.rangeEnd = null;
    st.undoStack = []; st.redoStack = [];
    invalidateView();
    paint();
    const n = before - st.rows.length;
    if (n) log(`删除 ${n} 行`);
    return n;
  }

  /** 当前选区覆盖的行的 _id */
  function selectedRowIds() {
    const info = getSelectionInfo();
    return info ? info.rows.map(r => r._id) : [];
  }

  /** 当前可见行（过滤 + 排序后的行对象） */
  function viewRows() {
    let list = st.rows.slice();
    if (st.filterFn) list = list.filter(st.filterFn);
    if (st.search) {
      const kw = st.search.toLowerCase();
      const keys = cfg.searchFields || st.cols.map(c => c.key);
      list = list.filter(r => keys.some(k => fmtCell(colByKey(k) || { key: k }, r.values[k]).toLowerCase().includes(kw)));
    }
    if (st.sort) {
      const col = st.cols[st.sort.ci];
      const dir = st.sort.dir;
      if (col) {
        list.sort((a, b) => {
          const av = a.values[col.key], bv = b.values[col.key];
          if (av == null || av === '') return 1;
          if (bv == null || bv === '') return -1;
          const an = typeof av === 'number', bn = typeof bv === 'number';
          if (an && bn) return (av - bv) * dir;
          return String(fmtCell(col, av)).localeCompare(String(fmtCell(col, bv)), 'zh', { numeric: true }) * dir;
        });
      }
    }
    return list;
  }
  const colByKey = k => st.cols.find(c => c.key === k) || null;

  /** 前缀冻结列的 left 偏移 */
  function frozenInfo() {
    const idx = [];
    if (feat.freeze) {
      for (let i = 0; i < st.cols.length; i++) { if (st.cols[i].freeze) idx.push(i); else break; }
    }
    let acc = 0;
    const lefts = {};
    idx.forEach(i => { lefts[i] = acc; acc += st.cols[i].width; });
    const last = idx.length ? idx[idx.length - 1] : -1;
    return { idx, lefts, last };
  }

  function cellText(row, col) {
    if (cfg.formatter) {
      const t = cfg.formatter(row, col);
      if (t !== undefined) return t;
    }
    return fmtCell(col, row.values[col.key]);
  }

  // ---------- 渲染 ----------
  function renderHead(fi, lefts, last) {
    return st.cols.map((c, i) => {
      const frozen = fi.includes(i);
      const cls = [frozen ? 'sc-frozen' : '', frozen && i === last ? 'sc-frozen-last' : ''].filter(Boolean).join(' ');
      const sortMark = st.sort && st.sort.ci === i ? `<span class="sc-sort-ind">${st.sort.dir > 0 ? '▲' : '▼'}</span>` : '';
      const headInner = c.headRender
        ? c.headRender()
        : `<span class="sc-th-label">${esc(c.label)}</span>${sortMark}`;
      return `<th data-ci="${i}" class="${cls}" style="width:${c.width}px${frozen ? ';left:' + lefts[i] + 'px' : ''}">
        ${headInner}
        ${feat.resize ? '<span class="sc-resizer" data-ci="' + i + '"></span>' : ''}
      </th>`;
    }).join('');
  }

  function renderRow(row, ri, fi, lefts, last) {
    const cells = st.cols.map((c, i) => {
      const frozen = fi.includes(i);
      const cls = [
        frozen ? 'sc-frozen' : '',
        frozen && i === last ? 'sc-frozen-last' : '',
        c.readonly ? 'sc-readonly' : '',
        c.align === 'right' ? 'sc-align-right' : c.align === 'center' ? 'sc-align-center' : '',
        c.cellClass ? c.cellClass(row) : '',
      ].filter(Boolean).join(' ');
      const txt = c.render ? c.render(row) : esc(cellText(row, c));
      return `<td data-ci="${i}" data-ri="${ri}" data-rid="${esc(row._id)}" class="${cls}"
        style="width:${c.width}px${frozen ? ';left:' + lefts[i] + 'px' : ''}">${txt}<div class="sc-fill-handle"></div></td>`;
    }).join('');
    const trCls = [row.dirty ? 'sc-dirty' : '', row.error ? 'sc-error' : ''].filter(Boolean).join(' ');
    return `<tr data-rid="${esc(row._id)}" class="${trCls}">${cells}</tr>`;
  }

  function spacerRow(h, colCount) {
    return h > 0
      ? `<tr class="sc-spacer"><td colspan="${colCount}" style="height:${h}px"></td></tr>`
      : '';
  }

  // 按滚动位置渲染窗口内的行：上下用占位行撑出真实滚动高度
  function paintBody(view, topOverride) {
    if (!table) return;
    const rows = view || getView();
    const tbody = table.tBodies[0];
    if (!rows.length) { tbody.innerHTML = ''; st.win = null; return; }
    const total = rows.length;
    const scrollTop = topOverride == null ? scrollEl.scrollTop : topOverride;
    let start = 0;
    let end = total;
    if (feat.virtual && total > 60) {
      const headH = table.tHead ? table.tHead.offsetHeight : 32;
      const top = Math.max(0, scrollTop - headH);
      const visible = Math.ceil((scrollEl.clientHeight || 400) / ROW_H) + 1;
      start = Math.max(0, Math.floor(top / ROW_H) - V_PAD);
      end = Math.min(total, start + visible + V_PAD * 2);
      if (end - start < visible + V_PAD * 2) start = Math.max(0, end - (visible + V_PAD * 2));
    }
    if (st.win && st.win.start === start && st.win.end === end) return;
    st.win = { start, end };

    const { idx: fi, lefts, last } = frozenInfo();
    const html = [];
    html.push(spacerRow(start * ROW_H, st.cols.length));
    for (let ri = start; ri < end; ri++) html.push(renderRow(rows[ri], ri, fi, lefts, last));
    html.push(spacerRow((total - end) * ROW_H, st.cols.length));
    tbody.innerHTML = html.join('');
    ensureGhost();
    markSel();
  }

  function paint() {
    if (st.editing) st.editing = null;
    invalidateView();
    st.win = null;
    const view = getView();
    if (countEl) countEl.textContent = `${view.length} 条`;

    if (!view.length) {
      scrollEl.innerHTML = `<div class="sc-empty">${esc(cfg.placeholder)}</div>`;
      table = null;
      return;
    }
    const { idx: fi, lefts, last } = frozenInfo();
    const totalW = st.cols.reduce((a, c) => a + c.width, 0);
    const scTop = scrollEl.scrollTop;
    scrollEl.innerHTML = `<table class="sc-table" style="width:${totalW}px;min-width:100%">
      <thead><tr>${renderHead(fi, lefts, last)}</tr></thead><tbody></tbody></table>`;
    table = scrollEl.querySelector('.sc-table');
    paintBody(view, scTop);
    scrollEl.scrollTop = scTop;
  }

  // 滚动时只重绘窗口内的行；编辑中先不重绘，提交后再刷新
  scrollEl.addEventListener('scroll', () => {
    if (!feat.virtual || !table || st.editing || scrollRaf) return;
    scrollRaf = requestAnimationFrame(() => {
      scrollRaf = 0;
      if (table && !st.editing) paintBody();
    });
  });

  function ensureGhost() {
    if (!feat.fill) return;
    if (!ghost || !ghost.isConnected) {
      ghost = document.createElement('div');
      ghost.className = 'sc-fill-ghost';
      scrollEl.appendChild(ghost);
    }
  }

  // ---------- 选区 ----------
  function markSel() {
    if (!table) return;
    table.querySelectorAll('td').forEach(td => td.classList.remove('sc-sel', 'sc-range'));
    if (!st.sel) return;
    const a = st.sel, b = st.rangeEnd || st.sel;
    const r1 = Math.min(a.r, b.r), r2 = Math.max(a.r, b.r), c1 = Math.min(a.c, b.c), c2 = Math.max(a.c, b.c);
    table.querySelectorAll('td').forEach(td => {
      const r = +td.dataset.ri, c = +td.dataset.ci;
      if (r >= r1 && r <= r2 && c >= c1 && c <= c2) td.classList.add(r === a.r && c === a.c ? 'sc-sel' : 'sc-range');
    });
    if (cfg.onSelectionChange) cfg.onSelectionChange(getSelectionInfo());
  }

  function normalizeSel(r, c) {
    const view = getView();
    r = Math.max(0, Math.min(view.length - 1, r));
    c = Math.max(0, Math.min(st.cols.length - 1, c));
    return { r, c };
  }

  function setSel(r, c, extend = false) {
    const n = normalizeSel(r, c);
    if (extend && st.sel) {
      // Shift 扩选：锚点保持不动，只移动另一端
      st.rangeEnd = { r: n.r, c: n.c };
    } else {
      st.sel = { r: n.r, c: n.c };
      st.rangeEnd = null;
    }
    markSel();
    ensureVisible((st.rangeEnd || st.sel).r);
  }

  // 滚动到目标行（虚拟化下目标行可能不在窗口内）
  function ensureVisible(r) {
    if (!table) return;
    const headH = table.tHead ? table.tHead.offsetHeight : 32;
    const y = r * ROW_H;
    const top = scrollEl.scrollTop - headH;
    const viewH = scrollEl.clientHeight || 400;
    if (y < top || y + ROW_H > top + viewH - ROW_H) {
      scrollEl.scrollTop = Math.max(0, headH + y - viewH / 2);
    }
    paintBody();
    markSel();
  }

  const tdAt = (r, c) => table ? table.querySelector(`td[data-ri="${r}"][data-ci="${c}"]`) : null;
  function rowAt(r) { return getView()[r] || null; }
  function colAt(c) { return st.cols[c] || null; }

  function getSelectionInfo() {
    if (!st.sel) return null;
    const view = getView();
    const a = st.sel, b = st.rangeEnd || st.sel;
    const rows = [];
    for (let r = Math.min(a.r, b.r); r <= Math.max(a.r, b.r); r++) if (view[r]) rows.push(view[r]);
    return {
      rows,
      columns: st.cols.slice(Math.min(a.c, b.c), Math.max(a.c, b.c) + 1),
      range: { r1: Math.min(a.r, b.r), r2: Math.max(a.r, b.r), c1: Math.min(a.c, b.c), c2: Math.max(a.c, b.c) },
    };
  }

  // ---------- 编辑 ----------
  function beginEdit(r, c, initial = null) {
    const col = colAt(c); const row = rowAt(r);
    if (!col || !row || col.readonly) return false;
    const td = tdAt(r, c); if (!td) return false;
    cancelEdit({ silent: true });
    st.editing = { r, c, col, row };
    if (['select', 'bool', 'radio', 'multiselect', 'multiselectDropdown'].includes(col.type)) {
      return beginChoiceEdit(col, row, td);
    }
    if (col.type === 'date') return beginDatePickEdit(col, row, td);
    if (col.type === 'range') return beginRangeEdit(col, row, td);

    const input = document.createElement('input');
    input.className = 'sc-input';
    input.value = initial != null ? initial : cellText(row, col);
    td.textContent = '';
    td.appendChild(input);
    input.focus();
    if (initial == null) input.select();
    input.addEventListener('keydown', ev => {
      ev.stopPropagation();
      if (ev.key === 'Enter') { ev.preventDefault(); commitEdit(); setSel(r + 1, c); }
      else if (ev.key === 'Tab') { ev.preventDefault(); commitEdit(); setSel(r, ev.shiftKey ? c - 1 : c + 1); }
      else if (ev.key === 'Escape') { ev.preventDefault(); cancelEdit(); }
      else if (['ArrowUp', 'ArrowDown'].includes(ev.key) && !ev.shiftKey && input.value === '') { ev.preventDefault(); setSel(r + (ev.key === 'ArrowUp' ? -1 : 1), c); }
    });
    input.addEventListener('blur', () => { if (st.editing) commitEdit(); });
    return true;
  }

  // 下拉单选 / 开关 / 单选 / 多选：统一使用浮层选择器
  function beginChoiceEdit(col, row, td) {
    const multiple = col.type === 'multiselect' || col.type === 'multiselectDropdown';
    const options = col.type === 'bool'
      ? [{ value: true, label: '是' }, { value: false, label: '否' }]
      : (col.options || []).map(o => ({ value: o.value, label: o.label }));
    const picker = openPicker({
      anchor: td,
      options,
      value: row.values[col.key] ?? (multiple ? [] : ''),
      multiple,
      onChange: (v) => {
        const prev = row.values[col.key];
        const next = multiple ? (Array.isArray(v) ? v.slice() : []) : v;
        if (JSON.stringify(next) === JSON.stringify(prev ?? (multiple ? [] : ''))) return;
        applyPatches([{ rowId: row._id, key: col.key, prev, next, row }], 'edit');
      },
    });
    st.editing = { ...st.editing, picker };
    return true;
  }

  // 日期：统一日历浮层
  function beginDatePickEdit(col, row, td) {
    const prev = row.values[col.key];
    const picker = openDatePicker({
      anchor: td,
      value: String(prev ?? '').slice(0, 10),
      onChange: (v) => {
        if (String(v) === String(prev ?? '')) return;
        applyPatches([{ rowId: row._id, key: col.key, prev, next: v, row }], 'edit');
      },
    });
    st.editing = { ...st.editing, picker };
    return true;
  }

  // 区间：左右两个输入框，中间固定波浪号；两边都空即空值
  function beginRangeEdit(col, row, td) {
    const cur = row.values[col.key];
    const has = cur && typeof cur === 'object';
    const wrap = document.createElement('div');
    wrap.className = 'sc-range-edit';
    const mkIn = (v) => {
      const i = document.createElement('input');
      i.className = 'sc-range-input';
      i.value = v == null ? '' : String(v);
      return i;
    };
    const a = mkIn(has ? cur.min : '');
    const b = mkIn(has ? cur.max : '');
    const sep = document.createElement('span');
    sep.className = 'sc-range-sep';
    sep.textContent = '~';
    wrap.append(a, sep, b);
    td.textContent = '';
    td.appendChild(wrap);
    st.editing = { ...st.editing, range: wrap };
    a.focus();
    a.select();

    const side = (s) => {
      const t = String(s ?? '').trim();
      if (!t) return '';
      const n = Number(t);
      return Number.isNaN(n) ? null : n;
    };
    const close = (commit) => {
      if (!st.editing || st.editing.range !== wrap) return;
      st.editing = null;
      window.removeEventListener('scroll', onScroll, true);
      if (commit) {
        const p1 = side(a.value);
        const p2 = side(b.value);
        if (p1 === null || p2 === null) {
          paint();
          if (typeof cfg.onError === 'function') cfg.onError(`${col.label}：请填数字`);
          return;
        }
        const next = (p1 === '' && p2 === '') ? '' : { min: p1, max: p2 };
        const prev = row.values[col.key];
        if (JSON.stringify(next) !== JSON.stringify(prev ?? '')) {
          applyPatches([{ rowId: row._id, key: col.key, prev, next, row }], 'edit');
        }
      }
      paint();
    };
    const onScroll = () => close(false);
    wrap.addEventListener('keydown', ev => {
      ev.stopPropagation();
      if (ev.key === 'Enter') { ev.preventDefault(); close(true); }
      else if (ev.key === 'Escape') { ev.preventDefault(); close(false); }
    });
    wrap.addEventListener('focusout', ev => { if (!wrap.contains(ev.relatedTarget)) close(true); });
    window.addEventListener('scroll', onScroll, true);
    return true;
  }

  function cancelEdit({ silent = false } = {}) {
    const ed = st.editing; if (!ed) return;
    st.editing = null;
    if (ed.picker) ed.picker.close();
    if (!silent) paint();
  }

  function commitEdit() {
    const ed = st.editing; if (!ed) return;
    if (ed.picker) return;                  // 浮层选择器自己提交
    st.editing = null;
    const editor = ed.r != null && tdAt(ed.r, ed.c) ? tdAt(ed.r, ed.c).querySelector('.sc-input') : null;
    const raw = editor ? editor.value : '';
    const col = ed.col; const row = ed.row;

    const res = parseCell(col, raw);
    if (!res.ok) { toastLocal(`${col.label}：${res.reason}`, 'err'); paint(); return; }
    if (col.required && String(raw).trim() === '') { toastLocal(`${col.label} 不能为空`, 'err'); paint(); return; }

    const prev = row.values[col.key];
    if (String(res.value ?? '') === String(prev ?? '')) { paint(); return; }
    applyPatches([{ rowId: row._id, key: col.key, prev, next: res.value, row }], 'edit');
    paint();
  }

  /** 统一的写入通道：更新内存 + 通知宿主 + 入撤销栈 */
  function applyPatches(patches, kind = 'edit') {
    if (!patches.length) return;
    invalidateView();
    const touched = new Set();
    patches.forEach(p => {
      const row = p.row || rowById(p.rowId);
      if (!row) return;
      row.values[p.key] = p.next;
      if ('dirty' in row) row.dirty = true;
      touched.add(row);
    });
    if (feat.undo) {
      st.undoStack.push(patches.map(p => ({ ...p, row: undefined })));
      if (st.undoStack.length > 60) st.undoStack.shift();
      st.redoStack = [];
    }
    if (cfg.onChange) cfg.onChange(patches, kind);
    if (logEl) {
      const first = patches[0];
      const col = colByKey(first.key);
      log(`${patches.length > 1 ? patches.length + ' 处' : ''}${col ? esc(col.label) : ''} 改为「${esc(fmtCell(col || { key: first.key }, first.next))}」`, 'ok');
    }
  }

  function undo() {
    if (!feat.undo || !st.undoStack.length) return false;
    const patches = st.undoStack.pop();
    patches.forEach(p => { const row = rowById(p.rowId); if (row) row.values[p.key] = p.prev; });
    st.redoStack.push(patches);
    if (cfg.onChange) cfg.onChange(patches.map(p => ({ ...p, next: p.prev, prev: p.next, row: undefined })), 'undo');
    paint();
    log('撤销一步');
    return true;
  }
  function redo() {
    if (!feat.undo || !st.redoStack.length) return false;
    const patches = st.redoStack.pop();
    patches.forEach(p => { const row = rowById(p.rowId); if (row) row.values[p.key] = p.next; });
    st.undoStack.push(patches);
    if (cfg.onChange) cfg.onChange(patches, 'redo');
    paint();
    log('重做一步');
    return true;
  }
  const canUndo = () => st.undoStack.length > 0;
  const canRedo = () => st.redoStack.length > 0;

  // ---------- 清空 ----------
  function clearSelection() {
    const info = getSelectionInfo(); if (!info) return;
    const patches = [];
    info.rows.forEach(row => info.columns.forEach(col => {
      if (col.readonly) return;
      const prev = row.values[col.key];
      if (prev === '' || prev == null) return;
      patches.push({ rowId: row._id, key: col.key, prev, next: '', row });
    }));
    if (!patches.length) return;
    applyPatches(patches, 'clear');
    paint();
    log(`清空 ${patches.length} 个单元格`);
  }

  // ---------- 拖拽填充 ----------
  function startFill(e, r, c) {
    e.preventDefault(); e.stopPropagation();
    const col = colAt(c); if (!col || col.readonly || !feat.fill) return;
    const info = getSelectionInfo();
    const r1 = info ? info.range.r1 : r, r2 = info ? info.range.r2 : r;
    const c1 = info ? info.range.c1 : c, c2 = info ? info.range.c2 : c;
    st.fill = { r1, r2, c1, c2, target: null };
    showGhost(r1, r2, c1, c2);

    const move = ev => {
      const td = pointToCell(ev.clientX, ev.clientY);
      if (!td) return;
      st.fill.target = { r: +td.dataset.ri, c: +td.dataset.ci };
      const t = st.fill.target;
      showGhost(r1, Math.max(r2, t.r), c1, Math.max(c2, t.c));
    };
    const up = () => {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      hideGhost();
      const f = st.fill; st.fill = null;
      if (f && f.target && (f.target.r > r2 || f.target.c > c2)) doFill(f);
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  }

  function pointToCell(x, y) {
    const el = document.elementFromPoint(x, y);
    const td = el && el.closest ? el.closest('td') : null;
    return td && table && table.contains(td) ? td : null;
  }

  function showGhost(r1, r2, c1, c2) {
    ensureGhost();
    if (!ghost || !table) return;
    const tl = tdAt(r1, c1), br = tdAt(r2, c2);
    if (!tl || !br) return;
    ghost.style.display = 'block';
    ghost.style.left = tl.offsetLeft + 'px';
    ghost.style.top = tl.offsetTop + 'px';
    ghost.style.width = (br.offsetLeft + br.offsetWidth - tl.offsetLeft) + 'px';
    ghost.style.height = (br.offsetTop + br.offsetHeight - tl.offsetTop) + 'px';
  }
  function hideGhost() { if (ghost) ghost.style.display = 'none'; }

  function doFill(f) {
    const view = getView();
    const srcRows = [];
    for (let r = f.r1; r <= f.r2; r++) if (view[r]) srcRows.push(view[r]);
    if (!srcRows.length) return;

    const patches = [];
    for (let c = f.c1; c <= f.c2; c++) {
      const col = colAt(c); if (!col || col.readonly) continue;
      const srcVals = srcRows.map(row => row.values[col.key]);

      for (let r = f.r2 + 1; r <= f.target.r; r++) {
        const row = view[r]; if (!row) continue;
        const prev = row.values[col.key];
        const v = nextFillValue(col, srcVals, r - f.r1);
        if (String(v ?? '') === String(prev ?? '')) continue;
        patches.push({ rowId: row._id, key: col.key, prev, next: v, row });
      }
    }
    if (!patches.length) return;
    applyPatches(patches, 'fill');
    paint();
    log(`向下填充 ${patches.length} 个单元格`, 'ok');
  }

  /** 填充值：纯数字按步长递增，其余循环/复制 */
  function nextFillValue(col, srcVals, offset) {
    if (!srcVals.length) return '';
    if (col.type === 'number' || srcVals.every(v => typeof v === 'number' || /^-?\d+(\.\d+)?$/.test(String(v)))) {
      const nums = srcVals.map(v => Number(v)).filter(n => !Number.isNaN(n));
      if (nums.length === srcVals.length) {
        if (nums.length === 1) return nums[0] + offset * (nums[0] === 0 ? 1 : 1);
        const step = nums[1] - nums[0];
        return nums[nums.length - 1] + step * (offset - nums.length + 1);
      }
    }
    const i = offset % srcVals.length;
    return srcVals[i];
  }

  // ---------- 复制 / 粘贴 ----------
  function copySelection() {
    const info = getSelectionInfo(); if (!info) return '';
    const lines = [];
    info.rows.forEach(row => lines.push(info.columns.map(col => cellText(row, col)).join('\t')));
    const text = lines.join('\n');
    writeClipboard(text);
    log(`已复制 ${info.rows.length}×${info.columns.length}`);
    return text;
  }

  function writeClipboard(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).catch(() => {});
    else {
      const ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove();
    }
  }

  async function pasteFromClipboard() {
    let text = '';
    try {
      if (navigator.clipboard && navigator.clipboard.readText) text = await navigator.clipboard.readText();
    } catch (_) { text = ''; }
    if (!text) { toastLocal('浏览器未授予剪贴板读取权限，可用 Ctrl+V 直接粘贴', 'warn'); return; }
    pasteText(text);
  }

  function pasteText(text) {
    if (!st.sel || !text) return;
    const lines = text.replace(/\r\n?/g, '\n').replace(/\n$/, '').split('\n');
    const view = getView();
    const patches = [];
    const rejected = [];
    lines.forEach((line, dr) => {
      const cells = line.split('\t');
      cells.forEach((v, dc) => {
        const row = view[st.sel.r + dr];
        const col = colAt(st.sel.c + dc);
        if (!row || !col || col.readonly) return;
        const prev = row.values[col.key];
        const res = parseCell(col, v);
        if (!res.ok) { rejected.push(col.label); return; }
        if (String(res.value ?? '') === String(prev ?? '')) return;
        patches.push({ rowId: row._id, key: col.key, prev, next: res.value, row });
      });
    });
    if (rejected.length) toastLocal(`部分单元格格式不符，已跳过：${rejected.slice(0, 3).join('、')}`, 'warn');
    if (!patches.length) return;
    applyPatches(patches, 'paste');
    paint();
    log(`已粘贴 ${patches.length} 个单元格`, 'ok');
  }

  // ---------- 列宽 ----------
  function startResize(e, ci) {
    e.preventDefault(); e.stopPropagation();
    const col = colAt(ci); if (!col) return;
    const startX = e.clientX, startW = col.width;
    const move = ev => {
      col.width = Math.max(56, startW + (ev.clientX - startX));
      if (table) {
        const totalW = st.cols.reduce((a, c) => a + c.width, 0);
        table.style.width = totalW + 'px';
        table.querySelectorAll(`th[data-ci="${ci}"], td[data-ci="${ci}"]`).forEach(el => el.style.width = col.width + 'px');
        const { lefts } = frozenInfo();
        table.querySelectorAll('td.sc-frozen, th.sc-frozen').forEach(el => {
          const i = +el.dataset.ci; if (lefts[i] != null) el.style.left = lefts[i] + 'px';
        });
      }
    };
    const up = () => { document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  }

  function autoFit(ci) {
    const col = colAt(ci); if (!col || !table) return;
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    const cs = getComputedStyle(table.querySelector('th'));
    ctx.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    let maxW = ctx.measureText(String(col.label || col.key)).width + 30; // 表头 + 排序箭头
    st.rows.forEach(row => {
      const w = ctx.measureText(String(cellText(row, col))).width + 24;
      if (w > maxW) maxW = w;
    });
    col.width = Math.max(64, Math.min(420, Math.ceil(maxW)));
    paint();
  }

  // ---------- 事件 ----------
  scrollEl.addEventListener('mousedown', e => {
    if (e.target.classList && e.target.classList.contains('sc-input')) return;
    const resizer = e.target.closest('.sc-resizer');
    if (resizer) { startResize(e, +resizer.dataset.ci); return; }
    const handle = e.target.closest('.sc-fill-handle');
    if (handle) {
      const td = handle.closest('td');
      startFill(e, +td.dataset.ri, +td.dataset.ci);
      return;
    }
    const td = e.target.closest('td');
    if (!td) return;
    e.preventDefault();
    if (st.editing) commitEdit();
    setSel(+td.dataset.ri, +td.dataset.ci, e.shiftKey);
  });

  scrollEl.addEventListener('dblclick', e => {
    const resizer = e.target.closest('.sc-resizer');
    if (resizer) { autoFit(+resizer.dataset.ci); return; }
    const td = e.target.closest('td');
    if (!td) return;
    beginEdit(+td.dataset.ri, +td.dataset.ci);
  });

  scrollEl.addEventListener('click', e => {
    const th = e.target.closest('th');
    if (!th || e.target.closest('.sc-resizer') || e.target.closest('input') || !feat.sort) return;
    const ci = +th.dataset.ci;
    if (!st.sort || st.sort.ci !== ci) st.sort = { ci, dir: 1 };
    else if (st.sort.dir === 1) st.sort = { ci, dir: -1 };
    else st.sort = null;
    invalidateView();
    st.sel = null; st.rangeEnd = null;
    paint();
  });

  function onKeyDown(e) {
    if (st.editing) return;
    const tgt = e.target;
    // 焦点在任何输入元素上（含别的页面/弹窗里的输入框）都不抢键盘
    if (tgt && (tgt.tagName === 'INPUT' || tgt.tagName === 'TEXTAREA' || tgt.isContentEditable)) return;

    if (e.ctrlKey || e.metaKey) {
      const k = e.key.toLowerCase();
      if (k === 'z' && !e.shiftKey) { e.preventDefault(); undo(); return; }
      if (k === 'y' || (k === 'z' && e.shiftKey)) { e.preventDefault(); redo(); return; }
      if (st.sel && k === 'c') { copySelection(); return; }
      return;
    }
    if (!st.sel) return;

    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
      e.preventDefault();
      // 扩选时要从活动端（rangeEnd）继续移动，锚点（sel）保持不动
      const base = st.rangeEnd || st.sel;
      const d = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] }[e.key];
      setSel(base.r + d[0], base.c + d[1], e.shiftKey);
      return;
    }
    if (e.key === 'Enter' || e.key === 'F2') { e.preventDefault(); beginEdit(st.sel.r, st.sel.c); return; }
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); clearSelection(); return; }
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      beginEdit(st.sel.r, st.sel.c, e.key);
    }
  }

  function onPaste(e) {
    if (st.editing || !st.sel) return;
    const tgt = e.target;
    if (tgt && (tgt.tagName === 'INPUT' || tgt.tagName === 'TEXTAREA' || tgt.isContentEditable)) return;
    const dt = e.clipboardData || window.clipboardData;
    const text = dt && dt.getData('text');
    if (!text) return;
    e.preventDefault();
    pasteText(text);
  }

  const onSelection = () => { /* 焦点守卫：容器失去焦点时不抢键盘 */ };

  document.addEventListener('keydown', onKeyDown);
  document.addEventListener('paste', onPaste);

  // 搜索
  if (searchEl) {
    searchEl.addEventListener('input', () => {
      st.search = searchEl.value.trim();
      st.sel = null;
      paint();
    });
  }

  function setSearch(kw) { st.search = String(kw || '').trim(); if (searchEl) searchEl.value = st.search; st.sel = null; invalidateView(); paint(); }
  function setFilter(fn) { st.filterFn = fn || null; st.sel = null; invalidateView(); paint(); }

  // ---------- 导出 ----------
  function exportRows() {
    const view = getView();
    const head = st.cols.map(c => c.label);
    const body = view.map(row => st.cols.map(c => cellText(row, c)));
    return { head, body };
  }

  function exportCsv(filename = 'sheet.csv') {
    const { head, body } = exportRows();
    const cell = v => /[",\n]/.test(v) ? `"${String(v).replace(/"/g, '""')}"` : String(v);
    const lines = [head.map(cell).join(',')].concat(body.map(r => r.map(cell).join(',')));
    const blob = new Blob(['\uFEFF' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = filename; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    log(`已导出 CSV：${body.length} 行`, 'ok');
  }

  function log(html, cls = '') {
    if (logEl) {
      const div = document.createElement('div');
      if (cls) div.className = cls;
      div.innerHTML = html;
      logEl.appendChild(div);
      logEl.scrollTop = logEl.scrollHeight;
    }
    if (cfg.onLog) cfg.onLog(html, cls);
  }

  function toastLocal(msg, cls = 'ok') {
    log(esc(msg), cls);
  }

  function destroy() {
    document.removeEventListener('keydown', onKeyDown);
    document.removeEventListener('paste', onPaste);
  }

  // 首次渲染
  paint();

  return {
    paint, setRows, appendRows, getRows, setColumns, rowById,
    addRow, removeRows, selectedRowIds,
    setSearch, setFilter, selectFirst: () => setSel(0, 0),
    focusCell: (r, c) => setSel(r, c),
    beginEdit, undo, redo, canUndo, canRedo,
    exportCsv, exportRows, log, destroy,
    getSelection: getSelectionInfo,
    get state() { return st; },
    cols: () => st.cols,
    rowsView: getView,
  };
}

export default { createSheet };
