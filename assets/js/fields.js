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
export function renderFieldEditor(field, index) {
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

  const optionsInput = mk('input', {
    type: 'text',
    placeholder: '选项用英文逗号分隔',
    value: Array.isArray(field.options) ? field.options.join(',') : '',
  });

  const delBtn = mk('button', { class: 'btn danger small', type: 'button' }, '删');

  tr.appendChild(td(keyInput));
  tr.appendChild(td(labelInput));
  tr.appendChild(td(typeSelect));
  tr.appendChild(td(optionsInput));
  tr.appendChild(td(mkLabeledCheckbox('必填', !!field.required)));
  tr.appendChild(td(mkLabeledCheckbox('唯一', !!field.unique)));
  tr.appendChild(td(delBtn));

  // 显隐 options 输入框
  const refresh = () => {
    const t = typeSelect.value;
    optionsInput.disabled = !FIELD_TYPES[t].needsOptions;
    optionsInput.placeholder = FIELD_TYPES[t].needsOptions ? '选项用英文逗号分隔' : '(无需选项)';
  };
  typeSelect.addEventListener('change', refresh);
  refresh();

  tr._read = () => ({
    key: keyInput.value.trim(),
    label: labelInput.value.trim() || keyInput.value.trim() || '字段',
    type: typeSelect.value,
    required: tr.querySelector('input[data-role="required"]').checked,
    unique: tr.querySelector('input[data-role="unique"]').checked,
    default: field.default,
    options: optionsInput.disabled ? undefined :
             optionsInput.value.split(',').map(s => s.trim()).filter(Boolean),
  });

  return tr;
}

function td(child) { const e = document.createElement('td'); e.appendChild(child); return e; }
function mkLabeledCheckbox(label, checked) {
  const wrap = mk('label', { class: 'chk-inline' });
  const cb = mk('input', { type: 'checkbox' });
  if (checked) cb.checked = true;
  cb.dataset.role = label === '必填' ? 'required' : 'unique';
  wrap.appendChild(cb);
  wrap.appendChild(document.createTextNode(' ' + label));
  return wrap;
}

// ---------- 属性定义表（分组物料属性 / 给子分组加字段）----------
/**
 * @param {Array} attrs  属性定义数组 [{key,label,type,options,required}]
 * @returns {{ root: HTMLElement, read: () => Array }}
 */
export function renderAttrDefTable(attrs = []) {
  const wrap = mk('div');
  const table = mk('table', { class: 'field-editor-table' });
  const head = mk('tr');
  ['属性key', '显示名', '类型', '选项(逗号)', '必填', '唯一', ''].forEach(t => head.appendChild(mk('th', {}, t)));
  table.appendChild(head);

  const tbody = mk('tbody');
  const addRow = (attr) => {
    const tr = renderFieldEditor(attr || { type: 'text' }, tbody.children.length);
    tr.querySelector('button.danger.small').addEventListener('click', () => tr.remove());
    tbody.appendChild(tr);
  };
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
        const r = tr._read();
        if (!r.key && !r.label) continue;
        if (!r.key) throw new Error('属性 key 不能为空');
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
