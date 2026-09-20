// modal.js — the single shared text/number modal for the Hand/Weapon Animator
// and the Hitbox Customizer. Both used to attach their own listeners to the
// same #anim-modal DOM on every open: handlers survived the close and the two
// editors' handler stacks could collide, so a stale editor closure could fire
// inside a customizer modal (double-apply / wrong-target edits). One module,
// one handler pair, detached on every open.

let modalBtnHandler = null;
let modalKeyHandler = null;

export function modalActive() {
  const el = document.getElementById('anim-modal');
  return !!(el && el.style.display === 'flex');
}

export function showModal(title, initial, onOk, okLabel, cancelLabel, isNumber) {
  const box = document.getElementById('anim-modal');
  const titleEl = document.getElementById('anim-modal-title');
  const input = document.getElementById('anim-modal-input');
  const btns = document.getElementById('anim-modal-btns');
  if (!box || !input || !btns) return;

  // Detach handlers surviving a previous modal before re-registering so a
  // commit done by clicking (not Enter) never leaks a live listener into the
  // next modal — and never collides with the other editor's handler pair.
  if (modalKeyHandler && input.removeEventListener) input.removeEventListener('keydown', modalKeyHandler);
  if (modalBtnHandler && btns.removeEventListener) btns.removeEventListener('click', modalBtnHandler);

  titleEl.textContent = title;
  input.type = isNumber ? 'number' : 'text';
  input.step = isNumber ? 'any' : undefined;
  input.value = initial || '';
  btns.innerHTML = '';
  const make = (label, act) => {
    const b = document.createElement('button');
    b.textContent = label;
    b.dataset.act = act;
    btns.appendChild(b);
  };
  make(okLabel || 'OK', 'ok');
  make(cancelLabel || 'CANCEL', 'cancel');
  box.style.display = 'flex';
  input.focus();
  input.select();

  const close = (val) => {
    box.style.display = 'none';
    btns.innerHTML = '';
    if (val !== undefined && onOk) {
      if (isNumber) { const n = parseFloat(val); if (isFinite(n)) onOk(n); }
      else onOk(val);
    }
  };
  const onBtn = (e) => {
    const act = e.target.dataset && e.target.dataset.act;
    if (act === 'ok') { const v = input.value; close(v); }
    else if (act === 'cancel') close(undefined);
  };
  const onEnter = (e) => {
    if (e.key === 'Enter') { const v = input.value; close(v); }
    else if (e.key === 'Escape') close(undefined);
  };
  modalBtnHandler = onBtn;
  modalKeyHandler = onEnter;
  btns.addEventListener('click', onBtn);
  input.addEventListener('keydown', onEnter);
}

export function cancelModal() {
  const box = document.getElementById('anim-modal');
  if (box) box.style.display = 'none';
}