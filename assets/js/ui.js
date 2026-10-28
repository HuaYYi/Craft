// Toast / Modal / DOM 辅助

import { mk } from './fields.js';

// ---------- Toast ----------
const toastWrap = () => document.getElementById('toastWrap');
let _toastSeq = 0;

export function toast(msg, type = 'info', duration = 2500) {
  const wrap = toastWrap();
  const el = mk('div', { class: `toast ${type}` });
  el.textContent = msg;
  const seq = ++_toastSeq;
  el.dataset.seq = seq;
  wrap.appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transform = 'translateX(20px)';
    setTimeout(() => el.remove(), 300);
  }, duration);
}
export const toastOk = (m) => toast(m, 'ok', 2000);
export const toastErr = (m) => toast(m, 'err', 3500);

// ---------- Modal ----------
let _modalRef = null;

/**
 * @param {Object} opts
 * @param {string} opts.title
 * @param {HTMLElement|string} opts.body
 * @param {Array}  [opts.actions]  [{ label, className, onClick }] — 点完关闭请手动调 closeModal()
 * @returns {HTMLElement} modal 根节点
 */
export function openModal({ title, body, actions }) {
  const mask = document.getElementById('modalMask');
  const modal = document.getElementById('modal');
  modal.innerHTML = '';

  const head = mk('div', { class: 'modal-head' });
  head.appendChild(mk('h3', {}, title));
  const closeBtn = mk('button', { class: 'icon-btn', title: '关闭' }, '✕');
  closeBtn.addEventListener('click', closeModal);
  head.appendChild(closeBtn);
  modal.appendChild(head);

  const bodyEl = typeof body === 'string'
    ? mk('div', { class: 'modal-body' }, body)
    : body;
  if (bodyEl.classList) bodyEl.classList.add('modal-body');
  modal.appendChild(bodyEl);

  if (actions?.length) {
    const foot = mk('div', { class: 'modal-foot' });
    for (const a of actions) {
      const btn = mk('button', { class: `btn ${a.className || ''}` }, a.label);
      // 异步 action 在 await 期间禁用按钮，避免连点产生重复数据
      btn.addEventListener('click', async () => {
        if (btn.dataset.busy) return;
        const ret = a.onClick?.();
        if (ret && typeof ret.then === 'function') {
          btn.dataset.busy = '1';
          btn.disabled = true;
          try { await ret; } finally {
            btn.dataset.busy = '';
            btn.disabled = false;
          }
        }
      });
      foot.appendChild(btn);
    }
    modal.appendChild(foot);
  }

  mask.classList.remove('hidden');
  // 点击遮罩关闭（除非有 action 以外需要强制确认）
  mask.onclick = (e) => { if (e.target === mask) closeModal(); };

  _modalRef = modal;
  return modal;
}

export function closeModal() {
  document.getElementById('modalMask').classList.add('hidden');
  document.getElementById('modal').innerHTML = '';
  // 弹窗内的可搜索下拉列表挂在 body 上，关弹窗时一并清掉
  document.querySelectorAll('.picker-list.open').forEach(el => el.remove());
  _modalRef = null;
}

// 简单确认框
export async function confirm(message, title = '确认') {
  return new Promise((resolve) => {
    openModal({
      title,
      body: mk('p', { style: 'white-space: pre-line;' }, message),
      actions: [
        { label: '取消', onClick: () => { closeModal(); resolve(false); } },
        { label: '确定', className: 'primary', onClick: () => { closeModal(); resolve(true); } },
      ],
    });
  });
}
