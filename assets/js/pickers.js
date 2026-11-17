// pickers.js —— 统一的浮层选择器（下拉单选 / 下拉多选 / 日期）
// 表单和表格单元格共用同一套浮层外观与交互；浮层挂在 body 上，fixed 定位，
// 不会被弹窗裁剪，也不参与页面布局。

const WEEK = ['一', '二', '三', '四', '五', '六', '日'];
const pad = n => String(n).padStart(2, '0');
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

let active = null;

function position(panel, anchor, minWidth) {
  const r = anchor.getBoundingClientRect();
  const width = Math.max(minWidth, Math.min(Math.max(r.width, minWidth), window.innerWidth - 16));
  panel.style.width = `${width}px`;
  panel.style.minWidth = '0';
  const h = panel.offsetHeight;
  const below = window.innerHeight - r.bottom - 12;
  const above = r.top - 12;
  const up = below < h && above > below;
  panel.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - width - 8))}px`;
  panel.style.top = up ? '' : `${r.bottom + 4}px`;
  panel.style.bottom = up ? `${window.innerHeight - r.top + 4}px` : '';
}

function open(panel, anchor, { minWidth = 200, onClose } = {}) {
  if (active) active.close();
  document.body.appendChild(panel);
  panel.style.position = 'fixed';
  panel.style.zIndex = '130';
  panel.classList.add('open');
  panel.style.visibility = 'hidden';
  position(panel, anchor, minWidth);
  panel.style.visibility = '';
  requestAnimationFrame(() => { if (active && active.panel === panel) position(panel, anchor, minWidth); });

  const onDown = (e) => {
    if (!panel.contains(e.target) && !anchor.contains(e.target)) ctrl.close();
  };
  const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); ctrl.close(); } };
  const onScroll = (e) => { if (!panel.contains(e.target)) ctrl.close(); };
  const onResize = () => ctrl.close();

  const ctrl = {
    panel,
    close() {
      if (!active || active.panel !== panel) return;
      active = null;
      panel.remove();
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
      onClose?.();
    },
  };
  document.addEventListener('mousedown', onDown, true);
  document.addEventListener('keydown', onKey, true);
  window.addEventListener('scroll', onScroll, true);
  window.addEventListener('resize', onResize);
  active = ctrl;
  return ctrl;
}

/**
 * 下拉选择
 * options: [{ value, label }]
 * multiple: 多选时 default 值为数组，勾选即回调
 */
export function openPicker({ anchor, options = [], value, multiple = false, onChange }) {
  const panel = el('div', 'ui-pop ui-pop-menu');
  const list = el('div', 'ui-pop-list');
  let draft = multiple ? (Array.isArray(value) ? value.slice() : []) : value;
  let ctrl;

  for (const opt of options) {
    if (multiple) {
      const row = el('label', 'ui-pop-item');
      const cb = el('input');
      cb.type = 'checkbox';
      cb.checked = draft.some(v => String(v) === String(opt.value));
      cb.addEventListener('change', () => {
        if (cb.checked) draft.push(opt.value);
        else draft = draft.filter(v => String(v) !== String(opt.value));
        onChange?.(draft.slice());
      });
      row.append(cb, document.createTextNode(' ' + opt.label));
      list.appendChild(row);
    } else {
      const row = el('button', 'ui-pop-item');
      row.type = 'button';
      row.textContent = opt.label;
      if (String(value ?? '') === String(opt.value)) row.classList.add('active');
      row.addEventListener('click', () => {
        onChange?.(opt.value);
        ctrl.close();
      });
      list.appendChild(row);
    }
  }
  if (!options.length) list.appendChild(el('div', 'ui-pop-empty', '暂无可选项'));

  panel.appendChild(list);
  ctrl = open(panel, anchor, { minWidth: 180 });
  return ctrl;
}

/** 日期选择：值为 YYYY-MM-DD，空值回调 '' */
export function openDatePicker({ anchor, value = '', onChange }) {
  const panel = el('div', 'ui-pop ui-pop-cal');
  const raw = String(value || '').slice(0, 10);
  let view = /^\d{4}-\d{2}/.test(raw) ? new Date(`${raw.slice(0, 7)}-01T00:00:00`) : new Date();
  view.setDate(1);
  let ctrl;

  const render = () => {
    panel.innerHTML = '';
    const head = el('div', 'ui-cal-head');
    const prev = el('button', 'ui-cal-nav', '‹');
    const next = el('button', 'ui-cal-nav', '›');
    prev.type = 'button';
    next.type = 'button';
    prev.addEventListener('click', () => { view.setMonth(view.getMonth() - 1); render(); });
    next.addEventListener('click', () => { view.setMonth(view.getMonth() + 1); render(); });
    head.append(prev, el('span', 'ui-cal-title', `${view.getFullYear()}年${view.getMonth() + 1}月`), next);

    const week = el('div', 'ui-cal-week');
    for (const w of WEEK) week.appendChild(el('span', 'ui-cal-wd', w));

    const grid = el('div', 'ui-cal-grid');
    const start = (new Date(view.getFullYear(), view.getMonth(), 1).getDay() + 6) % 7;
    const days = new Date(view.getFullYear(), view.getMonth() + 1, 0).getDate();
    for (let i = 0; i < start; i++) grid.appendChild(el('span', 'ui-cal-day empty'));
    for (let d = 1; d <= days; d++) {
      const iso = `${view.getFullYear()}-${pad(view.getMonth() + 1)}-${pad(d)}`;
      const day = el('button', 'ui-cal-day', String(d));
      day.type = 'button';
      if (iso === raw) day.classList.add('active');
      day.addEventListener('click', () => { onChange?.(iso); ctrl.close(); });
      grid.appendChild(day);
    }

    const foot = el('div', 'ui-cal-foot');
    if (raw) {
      const clear = el('button', 'ui-cal-clear', '清空');
      clear.type = 'button';
      clear.addEventListener('click', () => { onChange?.(''); ctrl.close(); });
      foot.appendChild(clear);
    }

    panel.append(head, week, grid, foot);
  };

  render();
  ctrl = open(panel, anchor, { minWidth: 264 });
  return ctrl;
}
