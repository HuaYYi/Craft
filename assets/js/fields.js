// schema → 动态表单渲染 + 校验
// 字段类型：text / textarea / number / select / radio / multiselect / range(min-max) / date / checkbox
// 附件是表级区域（见 renderAttachmentZone），不是单字段类型

import { FIELD_TYPES } from './config.js';

// ---------- 渲染 ----------

// 把一张表的 fields 渲染成 <fieldset>，返回 { root: HTMLElement, read(): object, errors(): string[] }
export function renderForm(table, record) {
  const root = document.createElement('fieldset');
  root.className = 'form-grid';

  for (const field of table.fields) {
    root.appendChild(renderField(field, record));
  }

  return {
    root,
    read() {
      const data = {};
      for (const field of table.fields) {
        data[field.key] = readField(root, field);
      }
      return data;
    },
    errors() {
      const errs = [];
      for (const field of table.fields) {
        const val = readField(root, field);
        const e = validateField(field, val);
        if (e) errs.push(`${field.label}：${e}`);
      }
      return errs;
    },
  };
}

function renderField(field, record) {
  const wrap = document.createElement('div');
  wrap.className = 'field';
  const label = document.createElement('label');
  label.textContent = field.label + (field.required ? ' *' : '');
  label.htmlFor = `f-${field.key}`;
  wrap.appendChild(label);

  const val = record?.fields?.[field.key] ?? field.default ?? '';

  let control;
  switch (field.type) {
    case 'text':
      control = mk('input', { type: 'text', id: `f-${field.key}`, value: val, placeholder: field.placeholder || '' });
      break;
    case 'textarea':
      control = mk('textarea', { id: `f-${field.key}`, rows: 3, placeholder: field.placeholder || '' }, String(val));
      break;
    case 'number':
      control = mk('input', {
        type: 'number', id: `f-${field.key}`,
        value: val === '' || val == null ? '' : val,
        min: field.min, max: field.max, step: field.step ?? 1,
      });
      break;
    case 'date':
      control = mk('input', { type: 'date', id: `f-${field.key}`, value: val });
      break;
    case 'checkbox': {
      control = mk('label', { class: 'checkbox-label' });
      const cb = mk('input', { type: 'checkbox', id: `f-${field.key}`, checked: !!val });
      control.appendChild(cb);
      control.appendChild(document.createTextNode(' ' + (field.caption || '启用')));
      break;
    }
    case 'select': {
      control = mk('select', { id: `f-${field.key}` });
      // 选项里已含空值项（如「未分组」）时不再加占位符
      if (!field.required && !(field.options || []).includes('')) control.appendChild(mk('option', { value: '' }, '—'));
      for (const opt of (field.options || [])) {
        // optionsLabels 用于 value 和显示文案不一致的场景（如分组 id → 分组路径）
        const o = mk('option', { value: opt }, field.optionsLabels?.[opt] || opt);
        if (val === opt) o.selected = true;
        control.appendChild(o);
      }
      break;
    }
    case 'radio': {
      control = mk('div', { class: 'radio-group' });
      for (const opt of (field.options || [])) {
        const id = `f-${field.key}-${opt}`;
        const lbl = mk('label');
        lbl.appendChild(mk('input', { type: 'radio', name: `f-${field.key}`, value: opt, checked: val === opt }));
        lbl.appendChild(document.createTextNode(' ' + opt));
        control.appendChild(lbl);
      }
      break;
    }
    case 'multiselect': {
      control = mk('div', { class: 'checkbox-group', 'data-field': field.key });
      const cur = Array.isArray(val) ? val : [];
      for (const opt of (field.options || [])) {
        const lbl = mk('label');
        const cb = mk('input', { type: 'checkbox', value: opt });
        if (cur.includes(opt)) cb.checked = true;
        lbl.appendChild(cb);
        lbl.appendChild(document.createTextNode(' ' + (field.optionsLabels?.[opt] || opt)));
        control.appendChild(lbl);
      }
      break;
    }
    case 'range': {
      // min-max 对
      const box = mk('div', { class: 'range-box', 'data-field': field.key });
      const min = mk('input', { type: 'number', placeholder: '最小', value: val?.min ?? '', min: field.min, max: field.max, step: field.step ?? 1 });
      const max = mk('input', { type: 'number', placeholder: '最大', value: val?.max ?? '', min: field.min, max: field.max, step: field.step ?? 1 });
      box.appendChild(min);
      box.appendChild(document.createTextNode(' ~ '));
      box.appendChild(max);
      control = box;
      break;
    }
    default:
      control = mk('input', { type: 'text', id: `f-${field.key}`, value: String(val) });
  }

  if (field.type !== 'radio' && field.type !== 'multiselect' && field.type !== 'checkbox') {
    control.id = `f-${field.key}`;
  }
  wrap.appendChild(control);
  return wrap;
}

function readField(root, field) {
  switch (field.type) {
    case 'text':
    case 'textarea':
    case 'number':
    case 'date': {
      const el = root.querySelector(`#f-${field.key}`);
      return field.type === 'number' && el.value !== '' ? Number(el.value) : el.value;
    }
    case 'checkbox': {
      const el = root.querySelector(`#f-${field.key}`);
      return el.checked;
    }
    case 'select': {
      const el = root.querySelector(`#f-${field.key}`);
      return el.value;
    }
    case 'radio': {
      const el = root.querySelector(`input[name="f-${field.key}"]:checked`);
      return el?.value ?? '';
    }
    case 'multiselect': {
      const group = root.querySelector(`.checkbox-group[data-field="${field.key}"]`);
      if (!group) return [];
      return Array.from(group.querySelectorAll('input[type="checkbox"]'))
        .filter(c => c.checked)
        .map(c => c.value);
    }
    case 'range': {
      const box = root.querySelector(`.range-box[data-field="${field.key}"]`);
      if (!box) return { min: '', max: '' };
      const inputs = box.querySelectorAll('input');
      return { min: inputs[0].value !== '' ? Number(inputs[0].value) : '',
               max: inputs[1].value !== '' ? Number(inputs[1].value) : '' };
    }
    default:
      return '';
  }
}

// ---------- 校验 ----------
export function validateField(field, val) {
  if (field.required) {
    if (val === '' || val == null) return '必填';
    if (Array.isArray(val) && val.length === 0) return '必填';
    if (field.type === 'range' && (!val.min && !val.max)) return '必填';
  }
  if (field.type === 'number') {
    if (val !== '' && val != null) {
      if (Number.isNaN(val)) return '必须是数字';
      if (field.min != null && val < field.min) return `不能小于 ${field.min}`;
      if (field.max != null && val > field.max) return `不能大于 ${field.max}`;
    }
  }
  if (field.type === 'range' && val?.min !== '' && val?.max !== '' && Number(val.min) > Number(val.max)) {
    return '最小不能大于最大';
  }
  return null;
}

// ---------- 字段定义编辑器（表与字段管理页用） ----------

// 渲染一行字段定义（可编辑）
export function renderFieldEditor(field, index, dictionaries = [], readonly = false) {
  const tr = document.createElement('tr');
  tr.dataset.index = index;

  const keyInput = mk('input', { type: 'text', value: field.key || '' });
  const labelInput = mk('input', { type: 'text', value: field.label || '' });
  const typeSelect = mk('select');
  for (const [k, v] of Object.entries(FIELD_TYPES)) {
    const o = mk('option', { value: k }, v.label);
    if (field.type === k) o.selected = true;
    typeSelect.appendChild(o);
  }

  // 选项来源：字典（单选/多选/下拉单选从字典取选项，可复用）
  const dictSelect = mk('select');
  dictSelect.appendChild(mk('option', { value: '' }, '（请选择字典）'));
  for (const d of dictionaries) {
    const o = mk('option', { value: d.id }, `${d.name}（${d.items?.length || 0} 项）`);
    if (field.dictId === d.id) o.selected = true;
    dictSelect.appendChild(o);
  }
  if (field.dictId && !dictionaries.some(d => d.id === field.dictId)) {
    const o = mk('option', { value: field.dictId }, '（字典已删除）');
    o.selected = true;
    dictSelect.appendChild(o);
  }

  const delBtn = readonly
    ? mk('span', { class: 'from-tag' }, '来自集合')
    : mk('button', { class: 'btn danger small', type: 'button' }, '删');

  // 拖动手柄：只有本组自有字段能拖动排序（来自集合的行顺序由集合决定）
  const dragTd = document.createElement('td');
  dragTd.className = 'col-drag';
  if (!readonly) {
    dragTd.appendChild(mk('span', { class: 'drag-handle', title: '按住拖动调整顺序', draggable: 'true' }, '⠿'));
  }
  tr.appendChild(dragTd);
  tr.appendChild(td(keyInput));
  tr.appendChild(td(labelInput));
  tr.appendChild(td(typeSelect));
  tr.appendChild(td(dictSelect));
  tr.appendChild(td(mkRoleCheckbox('required', !!field.required)));
  tr.appendChild(td(mkRoleCheckbox('unique', !!field.unique)));
  tr.appendChild(td(delBtn));

  // 只有需要选项的类型才启用字典选择
  const refresh = () => {
    const need = FIELD_TYPES[typeSelect.value].needsOptions;
    dictSelect.disabled = readonly || !need;
    dictSelect.title = readonly
      ? '来自属性集合，只读；要改请到「系统设置 → 属性集合」'
      : (need ? '选项来自字典，可在「系统设置 → 字典设置」里维护' : '该类型不需要选项');
  };
  typeSelect.addEventListener('change', refresh);
  refresh();

  if (readonly) {
    for (const el of tr.querySelectorAll('input, select')) el.disabled = true;
    tr.classList.add('row-readonly');
  }

  tr._read = () => {
    if (readonly) return null;
    const type = typeSelect.value;
    const next = {
      key: keyInput.value.trim(),
      label: labelInput.value.trim() || keyInput.value.trim() || '字段',
      type,
      required: tr.querySelector('input[data-role="required"]').checked,
      unique: tr.querySelector('input[data-role="unique"]').checked,
      default: field.default,
      dictId: dictSelect.value || undefined,
    };
    // 历史字段若还带着逗号选项、又没有字典，保留原选项避免丢数据
    if (!next.dictId && Array.isArray(field.options)?.length) next.options = field.options;
    return next;
  };

  return tr;
}

function td(child) { const e = document.createElement('td'); e.appendChild(child); return e; }
// 表头已写明「必填 / 唯一」，单元格里只放勾选框，不再重复文字
function mkRoleCheckbox(role, checked) {
  const cb = mk('input', { type: 'checkbox' });
  if (checked) cb.checked = true;
  cb.dataset.role = role;
  return cb;
}

// 表格行拖动排序：只能拖本组自有字段（来自集合的只读行固定在顶部，拖到只读区就排到第一个可编辑行前）
// 顺序即 DOM 顺序，read() 按 DOM 顺序返回，保存后顺序持久化
export function enableRowDrag(tbody) {
  let dragging = null;

  const clearMarks = () => {
    for (const tr of Array.from(tbody.children)) tr.classList.remove('drop-above', 'drop-below');
  };
  const endDrag = () => {
    if (dragging) dragging.classList.remove('row-dragging');
    dragging = null;
    clearMarks();
  };

  tbody.addEventListener('dragstart', (e) => {
    if (!e.target.closest || !e.target.closest('.drag-handle')) return;
    const tr = e.target.closest('tr');
    if (!tr || tr.classList.contains('row-readonly')) return;
    dragging = tr;
    tr.classList.add('row-dragging');
    e.dataTransfer.effectAllowed = 'move';
    try {
      e.dataTransfer.setData('text/plain', '');
      e.dataTransfer.setDragImage(tr, 12, 12);
    } catch (_) { /* 部分浏览器不支持自定义拖影 */ }
  });

  tbody.addEventListener('dragover', (e) => {
    if (!dragging) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    clearMarks();
    const tr = e.target.closest && e.target.closest('tr');
    if (!tr || tr === dragging) return;
    const rect = tr.getBoundingClientRect();
    tr.classList.add(e.clientY > rect.top + rect.height / 2 ? 'drop-below' : 'drop-above');
  });

  tbody.addEventListener('drop', (e) => {
    if (!dragging) return;
    e.preventDefault();
    const tr = e.target.closest && e.target.closest('tr');
    clearMarks();
    if (!tr || tr === dragging) { endDrag(); return; }

    if (tr.classList.contains('row-readonly')) {
      // 只读行永远在上方，落到只读区就排到第一个可编辑行之前
      const first = tbody.querySelector('tr:not(.row-readonly)');
      if (first && first !== dragging) tbody.insertBefore(dragging, first);
    } else {
      const rect = tr.getBoundingClientRect();
      const after = e.clientY > rect.top + rect.height / 2;
      const ref = after ? tr.nextElementSibling : tr;
      if (ref !== dragging) tbody.insertBefore(dragging, ref);
    }
    endDrag();
  });

  tbody.addEventListener('dragend', endDrag);
}


/**
 * @param {Array} attrs  本组自有属性定义 [{key,label,type,dictId,required,unique}]
 * @param {Array} dictionaries 字典数组 [{id,name,items:[{value,label}]}]
 * @param {Array} linkedAttrs  关联属性集合的字段，只读展示在本组字段上方
 * @returns {{ root: HTMLElement, read: () => Array }}
 */
export function renderAttrDefTable(attrs = [], dictionaries = [], linkedAttrs = []) {
  const wrap = mk('div');
  const table = mk('table', { class: 'field-editor-table' });
  const head = mk('tr');
  ['', '属性key', '显示名', '类型', '字典', '必填', '唯一', ''].forEach((t, i) => {
    const th = mk('th', {}, t);
    if (i === 0) th.className = 'col-drag';
    head.appendChild(th);
  });
  table.appendChild(head);

  const tbody = mk('tbody');
  enableRowDrag(tbody);
  const addRow = (attr, readonly = false) => {
    const tr = renderFieldEditor(attr || { type: 'text' }, tbody.children.length, dictionaries, readonly);
    if (!readonly) {
      tr.querySelector('button.danger.small').addEventListener('click', () => tr.remove());
    }
    tbody.appendChild(tr);
  };
  for (const a of linkedAttrs) addRow(a, true);
  for (const a of attrs) addRow(a);
  table.appendChild(tbody);
  wrap.appendChild(table);

  const addBtn = mk('button', { class: 'btn', style: 'margin-top:8px;' }, '＋ 添加属性');
  addBtn.addEventListener('click', () => addRow({ type: 'text' }));
  wrap.appendChild(addBtn);

  return {
    root: wrap,
    read() {
      const out = [];
      for (const tr of Array.from(tbody.children)) {
        const r = tr._read?.();
        if (!r) continue;               // 只读行（来自属性集合）不写入本组字段
        if (!r.key && !r.label) continue;
        if (!r.key) throw new Error('属性 key 不能为空');
        if (FIELD_TYPES[r.type].needsOptions && !r.dictId) {
          throw new Error(`属性「${r.label}」是${FIELD_TYPES[r.type].label}，需要先选一个字典`);
        }
        out.push(r);
      }
      return out;
    },
  };
}

// ---------- 附件上传区（表级） ----------

/**
 * @param {Object}   opts
 * @param {Array}    opts.attachments  当前附件列表 [{ id, name, size, local? }]
 * @param {Function} opts.onAttach     (File[]) => void
 * @param {Function} opts.onRemove     (id) => void
 * @param {boolean}  opts.readonly     是否禁止修改
 */
export function renderAttachmentZone({ attachments = [], onAttach, onRemove, readonly = false }) {
  const wrap = mk('div', { class: 'attachments' });

  const title = mk('div', { class: 'section-title' }, '附件');
  wrap.appendChild(title);

  if (!readonly) {
    const input = mk('input', { type: 'file', multiple: true });
    input.addEventListener('change', e => {
      if (e.target.files.length) onAttach(Array.from(e.target.files));
      e.target.value = '';
    });
    const drop = mk('div', { class: 'drop-zone' }, '点击或拖拽文件到这里上传');
    drop.addEventListener('click', () => input.click());
    drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('active'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('active'));
    drop.addEventListener('drop', e => {
      e.preventDefault(); drop.classList.remove('active');
      if (e.dataTransfer.files.length) onAttach(Array.from(e.dataTransfer.files));
    });
    wrap.appendChild(drop);
  }

  const list = mk('ul', { class: 'attach-list' });
  for (const att of attachments) {
    const li = mk('li');
    li.appendChild(mk('span', { class: 'att-name' }, att.name));
    li.appendChild(mk('span', { class: 'att-size' }, formatSize(att.size || 0)));
    if (!readonly) {
      const rm = mk('button', { class: 'btn small danger', type: 'button' }, '移除');
      rm.addEventListener('click', () => onRemove(att.id));
      li.appendChild(rm);
    }
    list.appendChild(li);
  }
  wrap.appendChild(list);
  return wrap;
}

export function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1024 / 1024).toFixed(1) + ' MB';
}

// ---------- DOM 工具 ----------
export function mk(tag, attrs = {}, text) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'for') el.htmlFor = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  if (text != null) el.textContent = text;
  return el;
}
