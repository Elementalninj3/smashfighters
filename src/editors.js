import { TRANSFORM_PROPS, PROP_LABEL, PROP_STEP, DEFAULT_VALUES, ensureTrack, getTrack, propPath, sampleTrack, addKeyframe, exactKey, removeKeyframeAt, moveKeyframe, nearestKey, cloneAnimation, animationFrameCount, reverseAnimation, flipAnimationH, shiftAnimationTiming, allTrackPaths, getAnimation, saveAnimation, createAnimation, deleteAnimation, duplicateAnimationInLibrary, renameAnimation, listAnimations, getCharacterAnimationIds, exportAnimation, importAnimationsJSON, allWeapons, getWeapon, getWeaponRaw, addWeapon, emptyWeaponCfg, drawWeaponGuides, weaponsToJSON, importWeaponsJSON, attachAnimator, resetAnimator, sampleAnimator, updateAnimator, getAnimationRaw } from './anim.js';
import { attacksFor, listAbilities, ALL_FIGHTERS, resolveAnimDef, resolveAttackDef, getAttackDefForAnimId, hitboxRectFor, hitboxList, setCustomHitboxes, clearCustomHitboxes, getCustomHitboxes } from './combat.js';
import { drawFighterVfx, listVfxEffects, listVfxAnchors } from './fx.js';
import { drawFighter } from './render.js';


// ── merged from anim/modal.js ──
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


// ── merged from anim/editor.js ──
// editor.js — visual Hand/Weapon Animator. Runs as its own game state on the
// game canvas (Game.js switches to it from the terminal menu). Everything
// renders through the same drawFighter used in the arena, so what you see here
// is exactly what gameplay will show.
//
// The editor is an almost-fullscreen 2D animation workstation:
//   top bar      — title, character, animation, save/undo/redo, transport
//   viewport     — the fighter + hands + weapons, camera pan/zoom, gizmos,
//                  world-space direct manipulation (drag hand / rotate / scale /
//                  drag weapon / drag anchors & pivot)
//   right panel  — grouped properties, precise numeric editing (click any
//                  value to type it in), weapon mount/grip config, anchors
//   timeline     — collapsible tracks, keyframe drag / delete / copy / paste,
//                  double-click to pose, scrub, playback, plus a VFX lane
//                  where each effect is a draggable/resizable bar that sets
//                  exactly when it plays
//
// Authoring happens in CANONICAL space (fighter faces right) — the animator
// mirrors automatically during gameplay. Undo/redo is snapshot-based and
// covers every editing operation.


// ── black + cream theme ─────────────────────────────────────────────────
const CREAM      = '#f3ead1';   // primary text / selection
const CREAM_MUT  = '#cbbf9f';   // secondary text
const CREAM_DIM  = '#7d745c';   // tertiary text / hints
const CREAM_FAINT= 'rgba(243,234,209,0.07)';
const CREAM_GLO  = 'rgba(243,234,209,0.2)';
const BG         = '#101010';   // window background
const BG_SOFT    = '#151515';   // panels
const BG_DEEP    = '#0c0c0c';   // viewport / timeline wells
const BG_RAISE   = '#1d1d1d';   // buttons / wells
const BG_HOT     = '#2c2c2c';   // hover / active
const LINE       = '#2c2c2c';   // borders
const MONO = 'Consolas, "Courier New", monospace';

// ── VFX lane coloring (one tint per effect id) ─────────────────────────────
const VFX_TINT = { bullet: '#ffd34d', spray: '#ff9d5c', blast: '#ff5d8f' };

// ── timeline track groups ───────────────────────────────────────────────────
// The base prop tracks still own the real keyframes (that's the animator's
// source of truth); the timeline just presents them grouped into a few clean
// rows so it reads like a normal 2D animator instead of a dump of every
// internal transform property.
const TRACK_GROUPS = [
  { id: 'POS',   props: ['x', 'y'],                                label: 'position' },
  { id: 'SCALE', props: ['scaleX', 'scaleY', 'width', 'height'],   label: 'scale · size' },
  { id: 'ROT',   props: ['rot'],                                   label: 'rotation' },
  { id: 'VIS',   props: ['opacity', 'visible', 'flipX', 'flipY', 'z'], label: 'opacity · flip · z' },
];
const TRACK_TINT = { POS: '#f3ead1', SCALE: '#7fd8c2', ROT: '#ffb26b', VIS: '#b9a6ff' };

// ── layout (logical CSS px; canvas is DPR-scaled internally) ──────────────
let VPW = 1200, VPH = 820;      // logical canvas size (recomputed each frame)
let dpr = 1;
const TOPBAR_H = 52;
let PANEL_W   = 340;            // resizable
let TIMELINE_H = 480;           // resizable (tall enough for the VFX lane)
const TIMELINE_MIN = 240, TIMELINE_MAX = 680;
const PANEL_MIN = 280, PANEL_MAX = 520;
const LABEL_W = 148;            // timeline track label column
const SNAP_GRID = 8;            // world units for grid + snap
const TOPROW_H = 28, FULLROW_H = 20;

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
function fmt(v) {
  const n = Number(v);
  if (!isFinite(n)) return '0';
  if (Math.abs(n) >= 100) return n.toFixed(0);
  if (Math.abs(n) >= 10) return n.toFixed(1);
  return n.toFixed(2);
}
function round3(v) { return Math.round(v * 1000) / 1000; }
function snapVal(v) { return Math.round(v / SNAP_GRID) * SNAP_GRID; }

// ── editor state ──────────────────────────────────────────────────────────
const S = {
  open: false,
  canvas: null,
  ctx: null,
  subject: null,
  subjectDef: null,

  frame: 0,
  playing: false,
  speed: 1,
  loop: true,
  fps: 60,
  displayMax: 60,        // timeline duration (frames)

  animId: 'idle',
  anim: null,            // working copy being edited

  side: 'right',         // 'left' | 'right'
  objType: 'hand',       // 'hand' | 'weapon'

  trackSelect: null,     // full path of selected track
  keySelect: null,       // { track, frame } — primary selected keyframe
  selKeys: null,         // Set of "track|frame" — multi-selection
  clip: null,            // copied keyframe { v, e }

  // view
  showGrid: true,
  snap: true,
  showAnchors: true,
  showPivot: true,
  showBody: false,       // keep subtle: body is drawn faintly by default
  advanced: false,       // reveal advanced timeline tools
  debug: false,

  panelScroll: 0,
  history: null,         // snapshot stack, see undo section

  drag: null,
  hits: [],
  hover: null,           // hovered hit id (for tooltips)
  lastPointer: { x: 0, y: 0 },
  clickAt: null,         // {x,y,t} for double-click detection
  // Per-character animation memory: when the user cycles characters, each
  // character remembers which animation was open so the animator doesn't
  // jump back to the first library entry every time.
  perCharAnim: {},
  // Pop-up dropdown state (see drawMenu/openMenu). null = closed.
  popup: null,
  menuRects: {},         // cached opener rects for each menu tag
  vfxIdx: 0,             // selected VFX row index
  clipPanel: null,       // set to panel rect during drawPanel for hit guard
  _panelContentH: 0,     // measured total content height for panel wheel clamp
  tlCollapsed: false,    // timeline hidden (frees the viewport/panel)
  mirror: true,          // live-mirror edits to the opposite side (automatic)
  objOpen: { rh: true, rw: true, lh: false, lw: false }, // per-object track expand
};

// Expose the mirror + weapon-config data plumbing for the headless test
// harness — these stay internal to the editor UI but are verified as pure
// data ops. Hitbox editing is intentionally absent: it moved out of the
// animator into the dedicated Hitbox Customizer (hitboxCustomizer.js).
export {
  writeKey, mirrorPath, mirrorValue, weaponPivotX,
  setRowValue, ensureWeaponCfg,
};

const cam = { x: 0, y: 0, zoom: 2.2 };

// ── undo / redo (snapshot based) ───────────────────────────────────────────
// One undo per gesture/op: call pushUndo() right before a mutation begins.
const UNDO_MAX = 120;

function animSnapshot() {
  return {
    anim: cloneAnimation(S.anim),
    weapons: weaponsToJSON(),
  };
}

function pushUndo() {
  if (!S.history) return;
  S.history.undo.push(animSnapshot());
  if (S.history.undo.length > UNDO_MAX) S.history.undo.shift();
  S.history.redo.length = 0;
}

function applySnapshot(snap) {
  S.anim = snap.anim;
  try { importWeaponsJSON(snap.weapons); } catch (_) {}
  S.frame = clamp(S.frame, 0, S.displayMax);
  S.trackSelect = null;
  S.keySelect = null;
  if (S.selKeys) S.selKeys.clear();
  refreshMax();
  resetSubjectAnim();
}

function undo() {
  if (!S.history || !S.history.undo.length) return;
  S.history.redo.push(animSnapshot());
  applySnapshot(S.history.undo.pop());
}

function redo() {
  if (!S.history || !S.history.redo.length) return;
  S.history.undo.push(animSnapshot());
  applySnapshot(S.history.redo.pop());
}

function canUndo() { return !!(S.history && S.history.undo.length); }
function canRedo() { return !!(S.history && S.history.redo.length); }

// ── helpers ────────────────────────────────────────────────────────────────

function currentGroup() { return S.objType === 'hand' ? 'hands' : 'weapons'; }
function pathFor(prop) { return propPath(currentGroup(), S.side, prop); }
function trackFor(prop) { return getTrack(S.anim, pathFor(prop)); }

function sampledValue(prop) {
  const tr = trackFor(prop);
  return sampleTrack(tr, Math.floor(S.frame), DEFAULT_VALUES[prop]);
}

function refreshMax() {
  S.displayMax = Math.max(30, animationFrameCount(S.anim) + 10);
  if (S.subject && S.subject.anim) S.subject.anim.maxFrame = S.displayMax - 10;
}

function resetSubjectAnim() {
  if (!S.subject || !S.anim) return;
  const A = S.subject.anim;
  A.anim = S.anim;
  A.animId = S.animId;
  A.frame = 0;
  A.playing = false;
  A.paused = false;
  A.scrubbing = true;
  S.subject.facingRight = true;
  sampleAnimator(S.subject);
}

function loadAnimById(id) {
  const anim = getAnimation(id);
  if (!anim) return;
  // Remember which animation this character was last editing.
  const cid = (S.subjectDef && S.subjectDef()) || null;
  if (cid && cid.id) S.perCharAnim[cid.id] = id;
  S.anim = anim;
  S.animId = id;
  S.frame = 0;
  S.trackSelect = null;
  S.keySelect = null;
  refreshMax();
  resetSubjectAnim();
}

function setAnim(anim, idv) {
  S.anim = anim; S.animId = idv; S.frame = 0;
  S.trackSelect = null; S.keySelect = null;
  refreshMax(); resetSubjectAnim();
}

// Concurrent with importWeaponsJSON the weapon library is global (shared across
// animations). We snapshot it too so anchor edits undo cleanly.

function ensureWeaponCfg(side) {
  const wc = (S.anim.weapons || (S.anim.weapons = { right: null, left: null }));
  const s = side || S.side;
  if (!wc[s]) wc[s] = emptyWeaponCfg();
  return wc[s];
}

function ensureWeaponCfgSide(side) { return ensureWeaponCfg(side); }

function weaponDefForSide() {
  const wc = (S.anim.weapons || {})[S.side];
  return wc && wc.id ? getWeapon(wc.id) : null;
}

// ── combat (ability) / VFX helpers ─────────────────────────────────────────
function ensureAnimCombat() {
  if (!S.anim) S.anim = {};
  if (!S.anim.combat) S.anim.combat = {};
  return S.anim.combat;
}

function ensureAnimVfx() {
  if (!S.anim) S.anim = {};
  if (!S.anim.vfx) S.anim.vfx = [];
  return S.anim.vfx;
}

// ── popup dropdown ──────────────────────────────────────────────────────
// Opens (or closes) a contextual menu from a registered opener hit. Items are
// an array of { label, value, tip }. When a row is selected, onOk(value) is
// called and the menu closes.
function openMenu(tag, items, openerRect, onOk) {
  if (S.popup && S.popup.tag === tag) { S.popup = null; return; }
  const r = lr();
  const maxH = r.panel.y + r.panel.h - (openerRect.y + openerRect.h) - 8;
  S.popup = {
    tag, items, opener: openerRect, onOk,
    scroll: 0, maxH: Math.min(maxH, items.length * 22 + 4),
    itemH: 22, totalH: items.length * 22,
  };
}

function insidePopup(x, y) {
  if (!S.popup) return false;
  const p = popupRect();
  return x >= p.x && x <= p.x + p.w && y >= p.y && y <= p.y + p.h;
}

function popupRect() {
  const p = S.popup;
  const pr = lr().panel;
  const x = Math.min(pr.x + pr.w - 170, p.opener.x);
  const y = Math.min(pr.y + pr.h - p.maxH - 4, p.opener.y + p.opener.h + 2);
  return { x, y, w: 170, h: p.maxH };
}

function closePopup() { S.popup = null; }

function drawMenu(ctx) {
  const p = S.popup;
  if (!p) return;
  const { x: px, y: py, w: pw, h: ph } = popupRect();
  ctx.save();
  ctx.beginPath();
  ctx.rect(px, py, pw, ph);
  ctx.clip();
  ctx.fillStyle = BG_RAISE;
  ctx.strokeStyle = LINE;
  ctx.fillRect(px, py, pw, ph);
  ctx.strokeRect(px + 0.5, py + 0.5, pw - 1, ph - 1);
  ctx.font = `11px ${MONO}`;
  ctx.textBaseline = 'middle';
  const rowW = pw - 4, rowX = px + 2;
  let ry = py + 2 - p.scroll;
  for (let i = 0; i < p.items.length; i++) {
    const item = p.items[i];
    if (ry + p.itemH > py && ry < py + ph) {
      ctx.fillStyle = CREAM_MUT;
      ctx.fillText(item.label, rowX + 6, ry + p.itemH / 2);
      registerHit('menu-pop:' + i, rowX, ry, rowW, p.itemH);
      if (item.tip) TIPS['menu-pop:' + i] = item.tip;
    }
    ry += p.itemH;
  }
  ctx.restore();
}

function menuHit(tag, x, y, w, h, opts) {
  registerHit('menu:' + tag, x, y, w, h);
  S.menuRects[tag] = { x, y, w, h };
}

function handlePopupSelect(idx) {
  const p = S.popup;
  if (!p || !p.items[idx]) return;
  p.onOk(p.items[idx].value);
  S.popup = null;
}

// ── numeric row helpers ─────────────────────────────────────────────────
// Reusable for the VFX and weapon-config panel rows so the per-field draw /
// step logic is written exactly once.
const VFX_FIELDS = [
  ['startFrame', 1], ['duration', 1], ['scale', 0.05], ['rotation', 5],
  ['offsetX', 2], ['offsetY', 2],
];
const WEAP_FIELDS = [
  ['mountX', 2], ['mountY', 2], ['gripOffsetX', 2], ['gripOffsetY', 2], ['gripRot', 5],
];
// Hitbox editing lives in the dedicated Hitbox Customizer (hitboxCustomizer.js),
// never here — FIELD_LABEL only covers weapon mount/grip + VFX row properties.
const FIELD_LABEL = {
  scale:'SCALE', rotation:'ROT',
  offsetX:'PX', offsetY:'PY', loop:'LOOP', color:'COLOR',
  mountX:'MOUNTX', mountY:'MOUNTY', gripOffsetX:'GRIPX', gripOffsetY:'GRIPY',
  gripRot:'GRIPROT',
};
function rowStep(key) {
  for (const [k, s] of VFX_FIELDS) if (k === key) return s;
  for (const [k, s] of WEAP_FIELDS) if (k === key) return s;
  return 1;
}

// Integer fields snap to whole frames/units in dragged values.
const INT_ROWS = ['startFrame', 'duration'];

function setRowValue(prefix, key, v) {
  const nv = INT_ROWS.includes(key) ? Math.round(v) : round3(v);
  if (prefix === 'weap') {
    const wc = ensureWeaponCfg();
    wc[key] = nv;
    // Mirror the weapon's attachment/pivot config to the opposite side so a
    // mirrored grip still lines the weapon up on the mirrored hand.
    if (S.mirror) mirrorWeaponCfgEdit(S.side, key, nv);
    S.dirty = true;
  } else {
    const arr = ensureAnimVfx();
    const item = arr[S.vfxIdx];
    if (!item) return;
    item[key] = nv;
    if (key === 'duration') item[key] = Math.max(1, item[key]);
    S.dirty = true;
  }
}

function rowCurrent(prefix, key) {
  if (prefix === 'weap') {
    const wc = (S.anim.weapons || {})[S.side];
    return (wc && wc[key] != null) ? wc[key] : 0;
  }
  const arr = ensureAnimVfx();
  const item = arr[S.vfxIdx];
  return item && item[key] != null ? item[key] : 0;
}

function drawNumRow(ctx, r, y, key, value, prefix, def) {
  const lx = r.x + 16, cx = r.x + r.w - 16, h = 24;
  ctx.fillStyle = CREAM_MUT;
  ctx.font = `12px ${MONO}`;
  ctx.fillText(FIELD_LABEL[key] || key.toUpperCase(), lx, y + 14);
  ctx.fillStyle = CREAM;
  ctx.font = `13px ${MONO}`;
  const txt = fmt(value);
  const vw = ctx.measureText(txt).width;
  ctx.fillText(txt, cx - 104 - vw, y + 14);
  registerHit(`${prefix}-${key}-drag`, cx - 106 - vw, y, vw + 12, h);
  TIPS[`${prefix}-${key}-drag`] = `${key} — drag to change · click to type`;
  btn('−', cx - 98, y + 2, 22, 20, `${prefix}-${key}-m`);
  btn('+', cx - 74, y + 2, 22, 20, `${prefix}-${key}-p`);
  return y + h;
}

function drawMenuBtnRow(ctx, r, y, label, value, menuTag, tip) {
  const lx = r.x + 16, cx = r.x + r.w - 16;
  ctx.fillStyle = CREAM_MUT;
  ctx.font = `12px ${MONO}`;
  ctx.fillText(label, lx, y + 14);
  ctx.fillStyle = CREAM;
  ctx.font = `13px ${MONO}`;
  ctx.fillText(value, lx + 60, y + 14);
  menuHit(menuTag, lx + 56, y, cx - lx - 64, 20);
  TIPS['menu:' + menuTag] = tip || label;
  return y + 24;
}

// Weapon chain world position for a local sprite-space point, matching
// Effects.drawAnimatedWeapon's translate→rotate→scale order.
function localToWorld(px, py, rot, sx, sy, lx, ly) {
  const r = rot * Math.PI / 180;
  const c = Math.cos(r), s = Math.sin(r);
  return {
    x: px + c * lx * sx - s * ly * sy,
    y: py + s * lx * sx + c * ly * sy,
  };
}

function worldToLocal(px, py, rot, sx, sy, wx, wy) {
  const r = rot * Math.PI / 180;
  const c = Math.cos(r), s = Math.sin(r);
  const dx = wx - px, dy = wy - py;
  const vx = c * dx + s * dy;
  const vy = -s * dx + c * dy;
  return {
    x: Math.abs(sx) < 0.0001 ? 0 : vx / sx,
    y: Math.abs(sy) < 0.0001 ? 0 : vy / sy,
  };
}

// ── create subject / open / close ─────────────────────────────────────────
export function createEditorSubject(def) {
  const f = { ...def };
  f.x = 0; f.y = 0;
  f.color = def.color || '#4a9eff';
  f._fighterDef = { ...def };
  f.radius = def.radius || 30;
  f.flipX = false;
  f.playerNum = 1;
  f.facingRight = true;
  f.state = 'neutral';
  f.running = false;
  f.grounded = true;
  f._bonkTimer = 0;
  f.frozen = false;
  f.photo = null;
  f.dead = false;
  f.bodySquishT = 0;
  f.bodySquishAmount = 0;
  f.breath = 0;
  f.handConfig = { configSaved: false, right: { x: 0, y: 0 }, left: { x: 0, y: 0 } };
  f.stocks = 3;
  f.percent = 0;
  f.attack = null;
  f.hitstun = 0;
  f.shielding = false;
  f.hitFlash = 0;
  f.accessory = null;
  f.anim = null;
  attachAnimator(f);
  return f;
}

let onKey, onDown, onMove, onUp, onWheel, onResize, savedCanvas = null;

function captureCanvasStyle() {
  savedCanvas = {
    w: S.canvas.width, h: S.canvas.height,
    sw: S.canvas.style.width, sh: S.canvas.style.height,
    pos: S.canvas.style.position, top: S.canvas.style.top, left: S.canvas.style.left,
    tf: S.canvas.style.transform, border: S.canvas.style.border,
  };
}

function restoreCanvasStyle() {
  if (!S.canvas || !savedCanvas) return;
  const c = S.canvas, s = savedCanvas;
  c.width = s.w; c.height = s.h;
  c.style.width = s.sw; c.style.height = s.sh;
  c.style.position = s.pos; c.style.top = s.top; c.style.left = s.left;
  c.style.transform = s.tf; c.style.border = s.border;
  try { delete c.dataset.editorTakeover; } catch (_) {}
}

function fitCanvasToWindow() {
  if (!S.canvas) return;
  // Capped like the game's own backing store: past 2x the pixels cost more
  // than the eye resolves on a canvas UI.
  dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
  const w = window.innerWidth, h = window.innerHeight;
  VPW = w; VPH = h;
  S.canvas.width = Math.round(w * dpr);
  S.canvas.height = Math.round(h * dpr);
  S.canvas.style.width = w + 'px';
  S.canvas.style.height = h + 'px';
  S.canvas.style.position = 'fixed';
  S.canvas.style.top = '0'; S.canvas.style.left = '0';
  S.canvas.style.transform = 'none';
  S.canvas.style.border = 'none';
  // Takeover flag: main.js must not re-fit the game canvas while the editor
  // owns it (its resize/fullscreen/DPR listeners would otherwise squash this
  // fullscreen layout back into the game's square viewport).
  try { S.canvas.dataset.editorTakeover = '1'; } catch (_) {}
}

export function openEditor(canvas, getFighterDef) {
  S.canvas = canvas;
  S.ctx = canvas.getContext('2d');
  captureCanvasStyle();
  fitCanvasToWindow();

  S.subjectDef = getFighterDef;
  S.subject = createEditorSubject(getFighterDef());
  // Open on the first library animation for THIS character (combat/hand/weapon actions)
  const def = getFighterDef();
  const charId = def && def.id ? def.id : 'cowboy';
  const allowedIds = getCharacterAnimationIds(charId, attacksFor);
  const lib = listAnimations().filter(a => allowedIds.includes(a.id));
  const firstEntry = lib[0];
  const firstAnim = firstEntry ? getAnimation(firstEntry.id) : null;
  S.anim = firstAnim || createAnimation('new-anim', 'New Animation');
  S.animId = S.anim.id;
  S.frame = 0;
  S.playing = false;
  S.side = 'right';
  S.objType = 'hand';
  S.trackSelect = null;
  S.keySelect = null;
  S.selKeys = new Set();
  S.clip = null;
  S.advanced = false;
  S.panelScroll = 0;
  S.mirror = true;
  S.perCharAnim = {};
  S.popup = null;
  S.vfxIdx = 0;
  S._panelContentH = 0;
  S.history = { undo: [], redo: [] };
  // restore persisted timeline UI state (collapse + per-object expansion)
  try {
    if (localStorage.getItem(UI_KEY_TL) === '1') S.tlCollapsed = true;
    const oo = JSON.parse(localStorage.getItem(UI_KEY_OBJ) || 'null');
    if (oo) S.objOpen = { ...S.objOpen, ...oo };
  } catch (_) {}
  cam.x = 0; cam.y = 0; cam.zoom = 2.2;
  S.open = true;
  refreshMax();
  resetSubjectAnim();

  onKey = e => onEditorKey(e);
  onDown = e => onPointerDown(e);
  onMove = e => onPointerMove(e);
  onUp = e => onPointerUp(e);
  onWheel = e => onEditorWheel(e);
  onResize = () => fitCanvasToWindow();

  window.addEventListener('keydown', onKey, true);
  canvas.addEventListener('pointerdown', onDown);
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  window.addEventListener('resize', onResize);
}

export function closeEditor() {
  if (!S.open) return;
  if (S.canvas) {
    S.canvas.removeEventListener('pointerdown', onDown);
    S.canvas.removeEventListener('wheel', onWheel);
  }
  window.removeEventListener('keydown', onKey, true);
  window.removeEventListener('pointermove', onMove);
  window.removeEventListener('pointerup', onUp);
  window.removeEventListener('resize', onResize);
  restoreCanvasStyle();
  // The window may have resized while the editor owned the canvas, leaving
  // the restored game CSS stale — poke the game's own refit (its takeover
  // flag is already cleared, and this listener is already removed).
  try { window.dispatchEvent(new Event('resize')); } catch (_) {}
  S.open = false;
  S.drag = null;
  S.popup = null;
  S.subject = null;
  S.history = null;
}

export function isEditorOpen() { return S.open; }

// ── layout rects (recomputed every frame) ─────────────────────────────────
function lr() {
  const tlH = S.tlCollapsed ? 22 : TIMELINE_H;
  return {
    top: { x: 0, y: 0, w: VPW, h: TOPBAR_H },
    vp:  { x: 0, y: TOPBAR_H, w: Math.max(200, VPW - PANEL_W - 1), h: VPH - TOPBAR_H - tlH - 1 },
    panel: { x: Math.max(200, VPW - PANEL_W), y: TOPBAR_H, w: PANEL_W, h: VPH - TOPBAR_H - tlH - 1 },
    tl:  { x: 0, y: VPH - tlH, w: VPW, h: tlH },
  };
}

// ── per-frame update ──────────────────────────────────────────────────────
let timeNow = 0;

export function updateEditor(dt) {
  if (!S.open || !S.subject) return;
  timeNow += dt;
  if (S.playing) {
    updateAnimator(S.subject, dt);
    S.frame = S.subject.anim.frame;
    if (!S.subject.anim.playing) S.playing = false;
  } else {
    S.subject.anim.scrubbing = true;
    S.subject.anim.frame = clamp(S.frame, 0, S.displayMax);
    sampleAnimator(S.subject);
  }
}

function previewTime() { return timeNow % 1000; }

// ── render ────────────────────────────────────────────────────────────────
export function renderEditor() {
  if (!S.open || !S.ctx) return;
  // Self-heal: if anything outside the editor resized the canvas (a missed
  // window event, a DPR change), the layout below would stretch — re-fit
  // instead of drawing a frame with mismatched CSS/backing/layout numbers.
  // Idempotent when nothing changed (two integer comparisons).
  if (S.canvas.width !== Math.round(VPW * dpr) || S.canvas.height !== Math.round(VPH * dpr)) {
    fitCanvasToWindow();
  }
  const ctx = S.ctx;
  S.hits = [];
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, VPW, VPH);

  S.clipPanel = null;

  const l = lr();
  drawTopBar(ctx, l.top);
  drawViewport(ctx, l.vp);
  drawPanel(ctx, l.panel);
  drawTimeline(ctx, l.tl);
  drawMenu(ctx);           // popup drawn last → its hits resolve first
  drawTooltip(ctx);
}

// ── top bar ───────────────────────────────────────────────────────────────
const TIPS = {};

function drawTopBar(ctx, r) {
  ctx.fillStyle = BG_SOFT;
  ctx.fillRect(r.x, r.y, r.w, r.h);
  ctx.fillStyle = LINE;
  ctx.fillRect(r.x, r.y + r.h - 1, r.w, 1);

  let x = 14;
  const by = r.y + (r.h - 28) / 2;  // vertically center 28px-tall buttons
  const lblY = r.y + 16;             // small label baseline
  const divPad = 10;                  // divider inset from top/bottom
  ctx.font = `bold 16px ${MONO}`;
  ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  ctx.fillStyle = CREAM;
  ctx.fillText('ANIMATOR', x, r.y + r.h / 2 + 1);
  x += 106;

  // character selector
  const fi = ALL_FIGHTERS.findIndex(f => (S.subjectDef && f.id === (S.subjectDef().id)));
  const curIdx = fi >= 0 ? fi : 0;
  const cname = (ALL_FIGHTERS[curIdx] || {}).name || '—';
  ctx.fillStyle = CREAM_DIM;
  ctx.font = `11px ${MONO}`;
  ctx.fillText('CHAR', x, lblY);
  x += 38;
  btn('◀', x, by, 28, 28, 'char-prev'); x += 28;
  ctx.fillStyle = CREAM;
  ctx.font = `13px ${MONO}`;
  const cwd = ctx.measureText(cname).width;
  ctx.fillText(cname, x + 5, r.y + r.h / 2 + 1);
  registerHit('char-open', x, by, cwd + 10, 28);
  TIPS['char-open'] = 'Edit hands with this character';
  x += cwd + 20;
  btn('▶', x, by, 28, 28, 'char-next'); x += 36;
  ctx.fillStyle = LINE;
  ctx.fillRect(x, r.y + divPad, 1, r.h - divPad * 2); x += 14;

  // animation selector
  ctx.fillStyle = CREAM_DIM;
  ctx.font = `11px ${MONO}`;
  ctx.fillText('ANIM', x, lblY);
  x += 38;
  btn('◀', x, by, 26, 28, 'anim-prev'); x += 26;
  const aname = (S.anim && S.anim.name) || '—';
  ctx.fillStyle = CREAM;
  ctx.font = `13px ${MONO}`;
  const awd = ctx.measureText(aname).width;
  ctx.fillText(aname, x + 5, r.y + r.h / 2 + 1);
  menuHit('anim', x, by, awd + 10, 28);
  TIPS['menu:anim'] = 'Animation library (click to open)';
  x += awd + 20;
  btn('▶', x, by, 26, 28, 'anim-next'); x += 34;

  ctx.fillStyle = LINE;
  ctx.fillRect(x, r.y + divPad, 1, r.h - divPad * 2); x += 14;

  // animation file ops
  btn('NEW', x, by, 48, 28, 'anim-new', { hot: false }); TIPS['anim-new'] = 'Create a new animation (Ctrl+N)';
  x += 54;
  btn(S.dirty ? 'SAVE*' : 'SAVE', x, by, 58, 28, 'anim-save', { hot: S.dirty }); TIPS['anim-save'] = 'Save to library (Ctrl+S)';
  x += 64;
  btn('UNDO', x, by, 58, 28, 'undo', { disabled: !canUndo() }); TIPS['undo'] = 'Undo (Ctrl+Z)';
  x += 64;
  btn('REDO', x, by, 58, 28, 'redo', { disabled: !canRedo() }); TIPS['redo'] = 'Redo (Ctrl+Y)';
  x += 64;

  // mirror toggle
  btn('MIRROR', x, by, 70, 28, 'mirror-toggle', { hot: S.mirror }); TIPS['mirror-toggle'] = 'Mirror edits to the opposite side';
  x += 76;

  ctx.fillStyle = LINE;
  ctx.fillRect(x, r.y + divPad, 1, r.h - divPad * 2); x += 14;

  // transport readout: frame + duration
  ctx.fillStyle = CREAM_DIM;
  ctx.font = `12px ${MONO}`;
  ctx.fillText('FRAME', x, lblY); x += 48;
  ctx.fillStyle = CREAM;
  ctx.font = `16px ${MONO}`;
  const fr = `${Math.floor(S.frame)} / ${S.displayMax}`;
  ctx.fillText(fr, x, r.y + r.h / 2 + 1);
  const fw = ctx.measureText(fr).width;
  registerHit('frame-drag', x - 2, by, fw + 8, 28);
  TIPS['frame-drag'] = 'Current frame — drag to scrub';
  x += fw + 20;

  // play / pause
  btn(S.playing ? '❚❚' : '▶', x, by, 44, 28, 'tl-play', { hot: S.playing }); TIPS['tl-play'] = 'Play / pause (Space)';
  x += 50;
  btn('■', x, by, 34, 28, 'tl-stop'); TIPS['tl-stop'] = 'Stop';
  x += 40;
  btn('⏮', x, by, 34, 28, 'tl-rewind'); TIPS['tl-rewind'] = 'First frame (Home)';
  x += 40;
  btn('⏭', x, by, 34, 28, 'tl-end'); TIPS['tl-end'] = 'Last frame (End)';
  x += 40;

  ctx.fillStyle = LINE;
  ctx.fillRect(x, r.y + divPad, 1, r.h - divPad * 2); x += 14;

  // fps + speed
  ctx.fillStyle = CREAM_DIM;
  ctx.font = `11px ${MONO}`;
  ctx.fillText('FPS', x, lblY); x += 30;
  btn('−', x, by, 24, 28, 'fps-m'); TIPS['fps-m'] = 'Lower frames/sec'; x += 25;
  ctx.fillStyle = CREAM;
  ctx.font = `14px ${MONO}`;
  const fpsT = `${S.fps}`;
  ctx.fillText(fpsT, x, r.y + r.h / 2 + 1); x += ctx.measureText(fpsT).width + 8;
  btn('+', x, by, 24, 28, 'fps-p'); TIPS['fps-p'] = 'Raise frames/sec'; x += 30;

  ctx.fillStyle = CREAM_DIM;
  ctx.font = `11px ${MONO}`;
  ctx.fillText('SPD', x, lblY); x += 32;
  btn('−', x, by, 24, 28, 'speed-m'); TIPS['speed-m'] = 'Slower playback'; x += 25;
  ctx.fillStyle = CREAM;
  ctx.font = `14px ${MONO}`;
  const spT = `×${S.speed}`;
  ctx.fillText(spT, x, r.y + r.h / 2 + 1); x += ctx.measureText(spT).width + 8;
  btn('+', x, by, 24, 28, 'speed-p'); TIPS['speed-p'] = 'Faster playback'; x += 30;

  btn(S.loop ? 'LOOP ON' : 'LOOP OFF', x, by, 72, 28, 'loop-toggle', { hot: S.loop }); TIPS['loop-toggle'] = 'Word-wrap playing to the start';
  x += 78;

  // advanced flag goes to the right end with close
  ctx.fillStyle = LINE; ctx.fillRect(x, r.y + divPad, 1, r.h - divPad * 2); x += 14;

  // remaining space drives the right-aligned cluster
  const rightBtns = [
    ['ADV', 'advanced'],
    ['ESC', 'tl-close'],
  ];
  let rx = r.x + r.w - 14;
  for (let i = rightBtns.length - 1; i >= 0; i--) {
    const [lab, id2] = rightBtns[i];
    const wd = 40 + lab.length * 9;
    rx -= wd + 8;
    btn(lab, rx, by, wd, 28, id2, { hot: id2 === 'advanced' ? S.advanced : false });
    TIPS[id2] = id2 === 'advanced' ? 'Show advanced timeline tools' : 'Close editor (Esc)';
  }
  if (x + 24 < rx - 160) {
    ctx.fillStyle = CREAM_DIM;
    ctx.font = `10px ${MONO}`;
    ctx.textBaseline = 'middle';
    ctx.fillText('drag hand to move · alt/right drag pans · wheel zooms · F-help', x + 2, r.y + r.h / 2 + 2);
  }
}

// ── viewport ───────────────────────────────────────────────────────────────
function worldToScreen(wx, wy, r) {
  return {
    x: r.x + r.w / 2 + (wx - cam.x) * cam.zoom,
    y: r.y + r.h / 2 + (wy - cam.y) * cam.zoom,
  };
}
function screenToWorld(sx, sy, r) {
  return {
    x: (sx - r.x - r.w / 2) / cam.zoom + cam.x,
    y: (sy - r.y - r.h / 2) / cam.zoom + cam.y,
  };
}

function drawCross(ctx, x, y, r2, color) {
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x - r2, y); ctx.lineTo(x + r2, y);
  ctx.moveTo(x, y - r2); ctx.lineTo(x, y + r2);
  ctx.stroke();
}

function drawViewport(ctx, r) {
  S.lastViewportRect = r;
  ctx.save();
  ctx.beginPath();
  ctx.rect(r.x, r.y, r.w, r.h);
  ctx.clip();
  ctx.fillStyle = BG_DEEP;
  ctx.fillRect(r.x, r.y, r.w, r.h);

  const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.scale(cam.zoom, cam.zoom);
  ctx.translate(-cam.x, -cam.y);

  // grid
  const visL = cam.x - r.w / (2 * cam.zoom), visR = cam.x + r.w / (2 * cam.zoom);
  const visT = cam.y - r.h / (2 * cam.zoom), visB = cam.y + r.h / (2 * cam.zoom);
  if (S.showGrid) {
    ctx.strokeStyle = CREAM_FAINT;
    ctx.lineWidth = 1 / cam.zoom;
    ctx.beginPath();
    const g0 = Math.floor(visL / SNAP_GRID) * SNAP_GRID;
    const g1 = Math.floor(visT / SNAP_GRID) * SNAP_GRID;
    for (let gx = g0; gx <= visR; gx += SNAP_GRID) { ctx.moveTo(gx, visT); ctx.lineTo(gx, visB); }
    for (let gy = g1; gy <= visB; gy += SNAP_GRID) { ctx.moveTo(visL, gy); ctx.lineTo(visR, gy); }
    ctx.stroke();
  }

  // floor line at the fighting surface
  ctx.strokeStyle = CREAM_GLO;
  ctx.lineWidth = 1 / cam.zoom;
  ctx.beginPath();
  ctx.moveTo(visL, 52); ctx.lineTo(visR, 52);
  ctx.stroke();

  // the subject
  ctx.save();
  ctx.translate(0, 0);
  drawFighter(ctx, S.subject, previewTime());
  drawFighterVfx(ctx, S.subject);
  ctx.restore();
  ctx.restore();

  drawViewportGizmos(ctx, r);
  drawViewportToolbar(ctx, r);
  ctx.restore();
}

function drawViewportGizmos(ctx, r) {
  if (!S.subject.anim || !S.subject.anim.out) return;
  const out = S.subject.anim.out;
  const side = S.side;

  // hand centers — selected is prominent, the other faint
  for (const s of ['left', 'right']) {
    const h = out.hands[s];
    if (!h) continue;
    const p = worldToScreen(h.px, h.py, r);
    if (s === side && S.objType === 'hand') {
      drawCross(ctx, p.x, p.y, 7 * clamp(cam.zoom, 0.7, 3) / 2.2, CREAM);
      ctx.strokeStyle = CREAM_GLO;
      ctx.lineWidth = 1;
      const ang = h.rot * Math.PI / 180;
      const L = 24 * clamp(cam.zoom, 0.7, 3) / 2.2;
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(p.x + L * Math.cos(ang), p.y + L * Math.sin(ang));
      ctx.stroke();
    } else {
      drawCross(ctx, p.x, p.y, 4 * clamp(cam.zoom, 0.7, 3) / 2.2, CREAM_GLO);
    }
  }

  // weapon chain
  if (S.objType === 'weapon') {
    const w = out.weapons[side];
    const h = out.hands[side];
    if (w && h) {
      const hp = worldToScreen(h.px, h.py, r);
      const gripW = worldToScreen(w.anchorWorld.grip.x, w.anchorWorld.grip.y, r);
      const mountW = worldToScreen(w.anchorWorld.mount.x, w.anchorWorld.mount.y, r);
      const wp = worldToScreen(w.px, w.py, r);
      ctx.strokeStyle = CREAM_FAINT;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(hp.x, hp.y); ctx.lineTo(mountW.x, mountW.y); ctx.lineTo(gripW.x, gripW.y);
      ctx.stroke();
      drawCross(ctx, mountW.x, mountW.y, 4 * clamp(cam.zoom, 0.7, 3) / 2.2, CREAM_MUT);
      drawCross(ctx, gripW.x, gripW.y, 4 * clamp(cam.zoom, 0.7, 3) / 2.2, CREAM_MUT);
      drawCross(ctx, wp.x, wp.y, 5 * clamp(cam.zoom, 0.7, 3) / 2.2, CREAM);
      ctx.strokeStyle = CREAM_GLO;
      ctx.beginPath();
      ctx.moveTo(wp.x, wp.y);
      ctx.lineTo(wp.x + 20 * clamp(cam.zoom, 0.7, 3) / 2.2 * Math.cos(w.rot * Math.PI / 180), wp.y + 20 * clamp(cam.zoom, 0.7, 3) / 2.2 * Math.sin(w.rot * Math.PI / 180));
      ctx.stroke();
    }
  }

  // world-space anchors + pivot for a selected weapon
  if (S.objType === 'weapon') {
    const w = out.weapons[side];
    if (w && w.def && (S.showAnchors || S.showPivot)) {
      const sc = S.showAnchors;
      const pc = S.showPivot;
      const drawAnchor = (local, idm, color, label, show) => {
        if (!show || !local) return;
        const pw = localToWorld(w.px, w.py, w.rot, w.scaleX || 1, w.scaleY || 1, local.x, local.y);
        const p = worldToScreen(pw.x, pw.y, r);
        ctx.beginPath();
        ctx.arc(p.x, p.y, 6 * clamp(cam.zoom, 0.6, 3.5) / 2.2, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();
        ctx.strokeStyle = '#000';
        ctx.lineWidth = 1;
        ctx.stroke();
        registerHit('wanchor:' + idm, p.x - 6, p.y - 6, 12, 12);
        TIPS['wanchor:' + idm] = label + ' anchor — drag to move';
        ctx.fillStyle = color;
        ctx.font = `9px ${MONO}`;
        ctx.fillText(shortLabel(idm), p.x + 7, p.y - 6);
      };
      const d = w.def;
      if (sc) {
        drawAnchor(d.anchors.grip, 'grip', CREAM_MUT, 'Grip', true);
        drawAnchor(d.anchors.tip, 'tip', CREAM_DIM, 'Tip', true);
        drawAnchor(d.anchors.center, 'center', CREAM_MUT, 'Center', true);
        (d.anchors.custom || []).forEach((c, i) => drawAnchor(c, 'custom:' + i, CREAM_MUT, 'Custom', true));
      }
      if (pc) drawAnchor(d.pivot, 'pivot', CREAM_GLO, 'Pivot', true);
    }
  }

  // selected object handles (position / rotation / scale)
  const sel = S.objType === 'hand' ? out.hands[side] : (out.weapons[side] || out.hands[side]);
  if (sel) {
    const p = worldToScreen(sel.px, sel.py, r);
    const ang = sel.rot * Math.PI / 180;
    // rotation handle
    const rr = 30 * clamp(cam.zoom, 0.6, 3.5) / 2.2;
    const rx2 = p.x + rr * Math.cos(ang), ry2 = p.y + rr * Math.sin(ang);
    ctx.strokeStyle = CREAM_MUT;
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(rx2, ry2); ctx.stroke();
    ctx.beginPath(); ctx.arc(rx2, ry2, 4.5, 0, Math.PI * 2);
    ctx.fillStyle = CREAM;
    ctx.fill();
    ctx.strokeStyle = '#000';
    ctx.stroke();
    registerHit('rot-handle', rx2 - 6, ry2 - 6, 12, 12);
    TIPS['rot-handle'] = 'Rotate';

    // scale handle
    const sOff = 22 * clamp(cam.zoom, 0.6, 3.5) / 2.2;
    const sxd = p.x + sOff, syd = p.y - sOff;
    ctx.strokeStyle = CREAM_FAINT;
    ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(sxd, syd); ctx.stroke();
    ctx.fillStyle = CREAM_GLO;
    ctx.strokeStyle = '#000';
    ctx.beginPath(); ctx.arc(sxd, syd, 4, 0, Math.PI * 2);
    ctx.fill(); ctx.stroke();
    registerHit('scale-handle', sxd - 6, syd - 6, 12, 12);
    TIPS['scale-handle'] = 'Scale';

    // position handle
    ctx.beginPath(); ctx.arc(p.x, p.y, 4 * clamp(cam.zoom, 0.6, 3.5) / 2.2, 0, Math.PI * 2);
    ctx.fillStyle = CREAM;
    ctx.fill();
    ctx.strokeStyle = '#000';
    ctx.stroke();
    registerHit('move-handle', p.x - 8, p.y - 8, 16, 16);
    TIPS['move-handle'] = 'Move';

    // selection label
    const label = `${S.objType === 'hand' ? 'HAND' : 'WEAPON'} · ${S.side.toUpperCase()}`;
    ctx.font = `bold 10px ${MONO}`;
    const lw = ctx.measureText(label).width;
    ctx.fillStyle = CREAM_DIM;
    ctx.textBaseline = 'middle';
    ctx.fillText(label, p.x + 12, p.y + 12);
    ctx.textBaseline = 'alphabetic';
  }
}

function shortLabel(idm) {
  if (idm === 'grip') return 'G';
  if (idm === 'tip') return 'T';
  if (idm === 'center') return 'C';
  if (idm === 'pivot') return 'P';
  return 'X';
}

// floating viewport toolbar (grid/snap/anchors/pivot/reset)
function drawViewportToolbar(ctx, r) {
  const y = r.y + 10;
  let x = r.x + 10;
  const toggles = [
    ['G', 'grid', 'Grid', S.showGrid],
    ['S', 'snap', 'Snap to grid', S.snap],
    ['A', 'anchors', 'Weapon anchors', S.showAnchors],
    ['P', 'pivot', 'Weapon pivot', S.showPivot],
    ['R', 'reset', 'Reset view', false],
    ['+', 'zoom-in', 'Zoom in', false],
    ['−', 'zoom-out', 'Zoom out', false],
  ];
  for (const [lab, idv, tip, on] of toggles) {
    tile(lab, x, y, 30, 30, idv, on ? CREAM : BG_RAISE, on ? BG : CREAM_MUT);
    TIPS[idv] = tip + (on ? ' (on)' : ' (off)');
    x += 34;
  }
}

function registerHit(id, x, y, w, h) {
  // While a panel is scrolled + clipped, skip hits that are fully outside the
  // visible pane so invisible items can't capture clicks.
  const c = S.clipPanel;
  if (c && (y + h < c.y || y > c.y + c.h || x + w < c.x || x > c.x + c.w)) return;
  S.hits.push({ id, x, y, w, h });
}

function tile(lab, x, y, w, h, id, bg, fg) {
  const ctx = S.ctx;
  ctx.fillStyle = bg;
  ctx.strokeStyle = LINE;
  ctx.fillRect(x, y, w, h);
  ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
  ctx.fillStyle = fg;
  ctx.font = `bold 12px ${MONO}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(lab, x + w / 2, y + h / 2 + 1);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  registerHit(id, x, y, w, h);
}

// ── right properties panel ─────────────────────────────────────────────────
function btn(label, x, y, w, h, id, opts = {}) {
  const ctx = S.ctx;
  const disabled = opts.disabled;
  const hot = opts.hot || false;
  ctx.fillStyle = hot ? CREAM : (disabled ? '#181818' : BG_RAISE);
  ctx.strokeStyle = hot ? CREAM : LINE;
  ctx.fillRect(x, y, w, h);
  ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
  ctx.fillStyle = hot ? BG : (disabled ? '#4a4436' : CREAM_MUT);
  ctx.font = `11px ${MONO}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, x + w / 2, y + h / 2 + 1);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  if (!disabled) registerHit(id, x, y, w, h);
}

function groupLabel(ctx, x, y, text) {
  ctx.fillStyle = CREAM_DIM;
  ctx.font = `11px ${MONO}`;
  ctx.fillText(text.toUpperCase(), x, y);
}

function drawPanel(ctx, r) {
  ctx.fillStyle = BG_SOFT;
  ctx.fillRect(r.x, r.y, r.w, r.h);
  ctx.fillStyle = LINE;
  ctx.fillRect(r.x, r.y, 1, r.h);

  const yStart = r.y + 14;
  let y = yStart - S.panelScroll;
  const lx = r.x + 16;
  const cx = r.x + r.w - 16;

  // Clip all panel content to the visible pane (panelScroll pushes rows out of
  // the visible top; registerHit uses S.clipPanel to skip off-screen rows).
  ctx.save();
  ctx.beginPath();
  ctx.rect(r.x, yStart, r.w, r.h - 14);
  ctx.clip();
  S.clipPanel = { x: r.x, y: yStart, w: r.w, h: r.h - 14 };

  // ── object header + side switch ──
  const isWeapon = S.objType === 'weapon';
  ctx.fillStyle = CREAM;
  ctx.font = `bold 14px ${MONO}`;
  const head = `${isWeapon ? 'WEAPON' : 'HAND'} — ${S.side.toUpperCase()}`;
  ctx.fillText(head, lx, y);
  const hw = ctx.measureText(head).width;
  btn('H', cx - 108, y - 10, 30, 24, 'obj-hand', { hot: !isWeapon }); TIPS['obj-hand'] = 'Edit hand (E)';
  btn('W', cx - 74, y - 10, 30, 24, 'obj-weapon', { hot: isWeapon }); TIPS['obj-weapon'] = 'Edit weapon (E)';
  btn('◀', cx - 42, y - 10, 26, 24, 'obj-side-l'); TIPS['obj-side-l'] = 'Left / right';
  btn('▶', cx - 14, y - 10, 26, 24, 'obj-side-r'); TIPS['obj-side-r'] = 'Left / right';
  y += 32;

  // ── weapons (per-animation, both sides) ─────────────────────────────────
  groupLabel(ctx, lx, y, 'Weapons'); y += 8;
  for (const wside of ['left', 'right']) {
    const wc = S.anim.weapons ? S.anim.weapons[wside] : null;
    const wd = wc && wc.id ? getWeaponRaw(wc.id) : null;
    ctx.fillStyle = CREAM_DIM;
    ctx.font = `11px ${MONO}`;
    ctx.fillText(wside.toUpperCase(), lx, y + 12);
    const wname = wd ? wd.name : '— none —';
    ctx.fillStyle = CREAM;
    ctx.font = `13px ${MONO}`;
    ctx.fillText(wname, lx + 40, y + 12);
    menuHit('wpn-' + wside, lx + 36, y, Math.max(60, ctx.measureText(wname).width + 14), 20);
    TIPS['menu:wpn-' + wside] = 'Choose ' + wside + ' weapon';
    const mirr = wc && wc.mirror !== false;
    btn(mirr ? 'MIRROR' : 'NO MIRROR', cx - 82, y, 82, 20, 'weap-mirror-' + wside, { hot: mirr });
    TIPS['weap-mirror-' + wside] = 'Mirror with the character';
    y += 26;
  }
  y += 6;

  // ── per-object weapon assignment (only when editing a weapon) ──
  if (isWeapon) {
    const wc = S.anim.weapons ? S.anim.weapons[S.side] : null;
    groupLabel(ctx, lx, y, 'Weapon Detail');
    y += 8;
    const wname = wc && wc.id ? (getWeaponRaw(wc.id) || getWeapon(wc.id) || {}).name : '— none —';
    ctx.fillStyle = CREAM;
    ctx.font = `14px ${MONO}`;
    ctx.fillText(wname, lx, y + 14);
    registerHit('weap-name-drag', lx - 2, y, r.w - 14, 22);
    TIPS['weap-name-drag'] = 'Cycle weapon (drag)';
    btn('◀', cx - 66, y + 2, 28, 20, 'weap-prev'); TIPS['weap-prev'] = 'Previous weapon';
    btn('▶', cx - 36, y + 2, 28, 20, 'weap-next'); TIPS['weap-next'] = 'Next weapon';
    y += 32;

    // per-animation weapon attachment config — typed/dragged like the rest
    const wcCfg = (S.anim.weapons || {})[S.side] || null;
    if (wcCfg && wcCfg.id) {
      groupLabel(ctx, lx, y, 'Weapon Config'); y += 8;
      for (const [key, step] of WEAP_FIELDS) {
        y = drawNumRow(ctx, r, y, key, rowCurrent('weap', key), 'weap', step);
      }
      y += 6;
    }
  }

  // ── combat ability (hitboxes moved to the Hitbox Customizer) ─────────────
  groupLabel(ctx, lx, y, 'Combat'); y += 8;
  {
    const combat = S.anim && S.anim.combat;
    const isAb = combat && combat.type === 'nonHitbox';
    const typeLabel = isAb ? 'Ability' : 'None';
    y = drawMenuBtnRow(ctx, r, y, 'TYPE', typeLabel, 'combat-type', 'Set this animation\'s gameplay role');

    if (isAb) {
      const cid = combat.abilityId || '—';
      const abl = listAbilities().find(a => a.id === cid);
      y = drawMenuBtnRow(ctx, r, y, 'ABILITY', abl ? abl.name : cid, 'combat-ability', 'Choose ability');
    }
    y += 6;
  }

  // ── VFX ─────────────────────────────────────────────────────────────────
  groupLabel(ctx, lx, y, 'VFX'); y += 8;
  {
    const vfx = ensureAnimVfx();
    if (vfx.length) {
      let bx = lx;
      btn('−', bx, y, 24, 20, 'vfx-del'); TIPS['vfx-del'] = 'Delete selected VFX';
      bx += 28;
      if (vfx.length > 1) {
        btn('◀', bx, y, 24, 20, 'vfx-prev'); TIPS['vfx-prev'] = 'Previous';
        btn('▶', bx + 28, y, 24, 20, 'vfx-next'); TIPS['vfx-next'] = 'Next';
        bx += 56;
      }
      btn(vfx[S.vfxIdx] && vfx[S.vfxIdx].loop ? 'LOOP' : 'LOOP OFF', bx, y, 70, 20, 'vfx-loop', { hot: vfx[S.vfxIdx] && vfx[S.vfxIdx].loop });
      TIPS['vfx-loop'] = 'Loop / once';
    }
    btn('+', cx - 24, y, 24, 20, 'vfx-add'); TIPS['vfx-add'] = 'Add VFX';
    y += 24;
    S.vfxIdx = clamp(S.vfxIdx, 0, Math.max(0, vfx.length - 1));
    if (vfx.length) {
      const v = vfx[S.vfxIdx] || vfx[0];
      const eff = listVfxEffects().find(e => e.id === v.effect);
      const anc = listVfxAnchors().find(a => a.id === v.anchor);
      y = drawMenuBtnRow(ctx, r, y, 'EFFECT', eff ? eff.name : v.effect || '—', 'vfx-effect', 'Choose effect');
      y = drawMenuBtnRow(ctx, r, y, 'ANCHOR', anc ? anc.name : v.anchor || '—', 'vfx-anchor', 'Choose anchor');
      for (const [key] of VFX_FIELDS) y = drawNumRow(ctx, r, y, key, v[key] != null ? v[key] : 0, 'vfx', key);
    } else {
      ctx.fillStyle = CREAM_DIM;
      ctx.font = `11px ${MONO}`;
      ctx.fillText('no effects', lx, y + 10);
      y += 18;
    }
    y += 6;
  }

  // ── per-property rows grouped ──
  const props = S._propList ? S._propList : TRANSFORM_PROPS;
  y += 4;

  // —— transform group ——
  groupLabel(ctx, lx, y, 'Transform'); y += 18;
  const transformProps = ['x', 'y', 'rot', 'scaleX', 'scaleY'];
  y = drawPropRows(ctx, r, y, transformProps);

  // —— size/visibility for hands ——
  if (!isWeapon) {
    groupLabel(ctx, lx, y, 'Size'); y += 18;
    y = drawPropRows(ctx, r, y, ['width', 'height']);
    groupLabel(ctx, lx, y, 'Visibility'); y += 18;
    y = drawPropRows(ctx, r, y, ['opacity', 'visible', 'z']);
  }

  // —— anchors for weapons ——
  if (isWeapon) {
    const wd = weaponDefForSide();
    if (wd) {
      groupLabel(ctx, lx, y, 'Anchors  (drag in viewport)'); y += 18;
      y = drawAnchorRows(ctx, r, y, wd);
    }
    groupLabel(ctx, lx, y, 'Attachment'); y += 18;
    ctx.fillStyle = CREAM_MUT;
    ctx.font = `12px ${MONO}`;
    ctx.fillText(`${S.side.toUpperCase()} HAND`, lx, y + 12);
    y += 24;
    groupLabel(ctx, lx, y, 'Duration'); y += 24;
  }

  // —— animation props ——
  groupLabel(ctx, lx, y, 'Animation'); y += 18;
  y = drawAnimPropRows(ctx, r, y);

  // keyframe tangent (when a key is selected)
  if (S.keySelect) {
    y += 12;
    groupLabel(ctx, lx, y, 'Key easing'); y += 18;
    const easeNames = ['linear', 'easeIn', 'easeOut', 'easeInOut', 'step'];
    let ex = lx;
    for (const e of easeNames) {
      const hot = currentKeyEase(e);
      btn(e.toUpperCase(), ex, y, 56, 20, `ease-${e}`, { hot });
      ex += 59;
    }
    TIPS['ease-linear'] = 'Constant speed';
    TIPS['ease-easeIn'] = 'Ease into key';
    TIPS['ease-easeOut'] = 'Ease out of key';
    TIPS['ease-easeInOut'] = 'Ease both ways';
    TIPS['ease-step'] = 'Step (hold value)';
    y += 26;
  }

  // Footer hint (stays pinned inside the visible pane).
  ctx.fillStyle = CREAM_DIM;
  ctx.font = `10px ${MONO}`;
  ctx.fillText('drag a value to scrub · − / + fine · click ✦ to key', lx, r.y + r.h - 8);

  S._panelContentH = y - yStart;
  S.panelScroll = clamp(S.panelScroll, 0, Math.max(0, S._panelContentH - (r.h - 14)));
  ctx.restore();
  S.clipPanel = null;
}

function currentKeyEase(e) {
  if (!S.trackSelect || !S.keySelect) return false;
  const tr = getTrack(S.anim, S.trackSelect);
  const k = tr && exactKey(tr, S.keySelect.frame);
  return !!(k && k.e === e);
}

// one numeric editor row for a transform prop
function drawPropRow(ctx, r, y, prop) {
  const lx = r.x + 16;
  const cx = r.x + r.w - 16;
  const val = sampledValue(prop);
  const path = pathFor(prop);
  const tracked = S.trackSelect === path;
  const label = PROP_LABEL[prop] || prop;
  const h = 24;

  ctx.fillStyle = tracked ? CREAM : CREAM_MUT;
  ctx.font = `12px ${MONO}`;
  ctx.fillText(label, lx, y + 14);

  ctx.fillStyle = tracked ? CREAM : CREAM;
  ctx.font = `13px ${MONO}`;
  const valTxt = fmt(val);
  const vw = ctx.measureText(valTxt).width;
  ctx.fillText(valTxt, cx - 104 - vw, y + 14);
  registerHit(`prop-${prop}-drag`, cx - 106 - vw, y, vw + 12, h);
  TIPS[`prop-${prop}-drag`] = `${label} — drag to change · click to type`;

  btn('−', cx - 98, y + 2, 22, 20, `prop-${prop}-m`); TIPS[`prop-${prop}-m`] = label + ' −';
  btn('+', cx - 74, y + 2, 22, 20, `prop-${prop}-p`); TIPS[`prop-${prop}-p`] = label + ' +';
  tile('✦', cx - 46, y + 2, 22, 20, `prop-${prop}-key`, tracked ? CREAM : BG_RAISE, tracked ? BG : CREAM_MUT);
  TIPS[`prop-${prop}-key`] = 'Add / update keyframe here';

  return y + h;
}

function drawPropRows(ctx, r, y, props) {
  for (const p of props) y = drawPropRow(ctx, r, y, p);
  return y + 10;
}

function drawAnchorRows(ctx, r, y, wd) {
  const lx = r.x + 16;
  const cx = r.x + r.w - 16;
  const each = (label, p, idm) => {
    const txt = `${fmt(p.x)} , ${fmt(p.y)}`;
    ctx.fillStyle = CREAM_MUT;
    ctx.font = `12px ${MONO}`;
    ctx.fillText(label, lx, y + 14);
    ctx.fillStyle = CREAM;
    ctx.font = `12px ${MONO}`;
    const tw = ctx.measureText(txt).width;
    ctx.textAlign = 'right';
    ctx.fillText(txt, cx - 8, y + 14);
    ctx.textAlign = 'left';
    // register the value hit BEFORE the −/+ buttons: the text region overlaps
    // them (a "x , y" pair is wide), and the later-registered hit would
    // otherwise swallow the button clicks (hitAt prefers the last hit).
    registerHit(`edit-anch-${idm}`, cx - 8 - tw, y, tw, 24);
    TIPS[`edit-anch-${idm}`] = `${label} — click to type (x, y)`;
    btn('−', cx - 98, y + 2, 22, 20, `anc-${idm}-m`); TIPS[`anc-${idm}-m`] = label + ' −';
    btn('+', cx - 74, y + 2, 22, 20, `anc-${idm}-p`); TIPS[`anc-${idm}-p`] = label + ' +';
    y += 24;
  };
  each('Grip', wd.anchors.grip, 'grip');
  each('Tip', wd.anchors.tip, 'tip');
  each('Center', wd.anchors.center, 'center');
  each('Pivot', wd.pivot, 'pivot');
  return y + 10;
}

function drawAnimPropRows(ctx, r, y) {
  const lx = r.x + 16;
  const cx = r.x + r.w - 16;
  const each = (label, valTxt, idm) => {
    ctx.fillStyle = CREAM_MUT;
    ctx.font = `12px ${MONO}`;
    ctx.fillText(label, lx, y + 14);
    ctx.fillStyle = CREAM;
    ctx.font = `12px ${MONO}`;
    ctx.fillText(valTxt, cx - 98, y + 14);
    y += 24;
  };
  const eachEdit = (label, valTxt, editId, lastX = cx - 98) => {
    ctx.fillStyle = CREAM_MUT;
    ctx.font = `12px ${MONO}`;
    ctx.fillText(label, lx, y + 14);
    ctx.fillStyle = CREAM;
    ctx.font = `12px ${MONO}`;
    const vw = ctx.measureText(valTxt).width;
    ctx.fillText(valTxt, lastX, y + 14);
    registerHit(editId, lastX - vw, y, vw + 8, 24);
    return y + 24;
  };
  y = eachEdit('FPS', `${S.fps}`, 'edit-fps'); TIPS['edit-fps'] = 'FPS — click to type';
  each('Loop', S.anim.loop ? 'yes' : 'no', 'anim-loop');
  y = eachEdit('Blend In', `${S.anim.blendIn ?? 0} f`, 'edit-blend'); TIPS['edit-blend'] = 'Blend in frames — click to type';
  y += 24;
  btn('REVERSE', lx, y, 72, 20, 'tl-rev'); TIPS['tl-rev'] = 'Reverse keyframe order';
  btn('FLIP', lx + 76, y, 48, 20, 'tl-flip'); TIPS['tl-flip'] = 'Flip horizontally (authoring space)';
  y += 24;
  btn('SHIFT −10', lx, y, 72, 20, 'tl-shift-l'); TIPS['tl-shift-l'] = 'Shift all keys 10 frames earlier';
  btn('SHIFT +10', lx + 76, y, 78, 20, 'tl-shift-r'); TIPS['tl-shift-r'] = 'Shift all keys 10 frames later';
  y += 28;
  btn('EXPORT ANIM', lx, y, 94, 20, 'anim-export'); TIPS['anim-export'] = 'Copy animation JSON';
  btn('IMPORT ANIM', lx + 98, y, 94, 20, 'anim-import'); TIPS['anim-import'] = 'Paste animation JSON';
  y += 24;
  btn('EXPORT WEAPONS', lx, y, 108, 20, 'wpn-export'); TIPS['wpn-export'] = 'Copy weapon library JSON';
  btn('IMPORT WEAPONS', lx + 112, y, 110, 20, 'wpn-import'); TIPS['wpn-import'] = 'Paste weapon library JSON';
  return y;
}

// ── timeline ───────────────────────────────────────────────────────────────
const OBJECTS = [
  { id: 'rh', label: 'RIGHT HAND',   group: 'hands',   side: 'right' },
  { id: 'rw', label: 'RIGHT WEAPON', group: 'weapons', side: 'right' },
  { id: 'lh', label: 'LEFT HAND',    group: 'hands',   side: 'left' },
  { id: 'lw', label: 'LEFT WEAPON',  group: 'weapons', side: 'left' },
];

function timX(f, r) {
  const tw = r.w - LABEL_W - 8;
  return r.x + LABEL_W + (f / S.displayMax) * tw;
}
function frameFromX(x, r) {
  const tw = r.w - LABEL_W - 8;
  return clamp((x - r.x - LABEL_W) / tw, 0, 1) * S.displayMax;
}

function drawTimeline(ctx, r) {
  // collapsed — slim strip with an expand handle so the viewport gets the room
  if (S.tlCollapsed) {
    ctx.fillStyle = BG_SOFT;
    ctx.fillRect(r.x, r.y, r.w, r.h);
    ctx.fillStyle = LINE;
    ctx.fillRect(r.x, r.y, r.w, 1);
    ctx.fillStyle = CREAM_DIM;
    ctx.font = `10px ${MONO}`;
    ctx.fillText('TIMELINE HIDDEN — click ▴ to expand', r.x + 10, r.y + 13);
    btn('▴', r.x + 224, r.y + 4, 26, 14, 'tl-expand');
    TIPS['tl-expand'] = 'Expand timeline';
    return;
  }

  ctx.fillStyle = BG_DEEP;
  ctx.fillRect(r.x, r.y, r.w, r.h);
  ctx.fillStyle = LINE;
  ctx.fillRect(r.x, r.y, r.w, 1);

  // divider: grab the top edge of the timeline to resize
  ctx.fillStyle = CREAM_DIM;
  ctx.fillRect(r.x, r.y, r.w, 3);
  TIPS['tl-resize'] = 'Resize timeline';

  let y = r.y + 6;

  // transport + tools (plus the collapse toggle)
  const ty = y;
  btn('▼', r.x + 6, ty, 24, 26, 'tl-collapse'); TIPS['tl-collapse'] = 'Hide timeline';
  btn('▶/❚❚', r.x + 34, ty, 40, 26, 'tl-play', { hot: S.playing });
  TIPS['tl-play'] = 'Play / pause (Space)';
  btn('■', r.x + 76, ty, 28, 26, 'tl-stop'); TIPS['tl-stop'] = 'Stop';
  btn('⏮', r.x + 106, ty, 28, 26, 'tl-rewind'); TIPS['tl-rewind'] = 'First frame';
  btn('◀K', r.x + 136, ty, 32, 26, 'tl-prevkey'); TIPS['tl-prevkey'] = 'Previous keyframe';
  btn('K▶', r.x + 170, ty, 32, 26, 'tl-nextkey'); TIPS['tl-nextkey'] = 'Next keyframe';
  btn('⏭', r.x + 204, ty, 28, 26, 'tl-end'); TIPS['tl-end'] = 'Last frame';

  // frame readout (draggable scrub)
  ctx.fillStyle = CREAM_DIM;
  ctx.font = `10px ${MONO}`;
  ctx.fillText('FRAME', r.x + 240, ty + 13);
  ctx.fillStyle = CREAM;
  ctx.font = `13px ${MONO}`;
  ctx.fillText(`${Math.floor(S.frame)} / ${S.displayMax}`, r.x + 288, ty + 17);
  registerHit('frame-drag-tl', r.x + 236, ty, 92, 26);
  TIPS['frame-drag-tl'] = 'Frame — drag to scrub';

  // add / del / copy / paste keys
  btn('KEY', r.x + 338, ty, 40, 26, 'tl-key'); TIPS['tl-key'] = 'Add keyframe for selected track (K)';
  btn('DEL', r.x + 380, ty, 40, 26, 'tl-deldim'); TIPS['tl-deldim'] = 'Delete selected keyframe (Del)';
  btn('COPY', r.x + 422, ty, 46, 26, 'tl-copy'); TIPS['tl-copy'] = 'Copy key (Ctrl+C)';
  btn('PASTE', r.x + 470, ty, 50, 26, 'tl-paste'); TIPS['tl-paste'] = 'Paste key at frame (Ctrl+V)';

  // loop toggle
  btn(S.loop ? 'LOOP ON' : 'LOOP OFF', r.x + 526, ty, 64, 26, 'loop-toggle', { hot: S.loop });
  TIPS['loop-toggle'] = 'Loop playback';

  // advanced tools row
  if (S.advanced) {
    const ay = ty + 28;
    btn('MIRROR', r.x + 10, ay, 50, 20, 'tl-mirror'); TIPS['tl-mirror'] = 'Toggle weapon mirror (M)';
    btn('GUIDE', r.x + 62, ay, 48, 20, 'tl-guides'); TIPS['tl-guides'] = 'Toggle grid (G)';
    btn('SNAP', r.x + 112, ay, 46, 20, 'snap'); TIPS['snap'] = 'Toggle snap (shift)';
    btn('DBG', r.x + 160, ay, 42, 20, 'tl-debug'); TIPS['tl-debug'] = 'Debug readout';
    return; // advanced takes the room — timeline area below is the same
  }

  // ruler + track area below
  y += 32;
  const rulerY = y;
  // keep track lanes + VFX lane inside the timeline rect when content overflows
  ctx.save();
  ctx.beginPath();
  ctx.rect(r.x, rulerY, r.w, (r.y + r.h) - rulerY);
  ctx.clip();

  // whole-area scrub registers FIRST so the more specific row / keyframe / VFX
  // hits below it win when they overlap (last-registered hit wins).
  registerHit('tl-scrub', r.x + LABEL_W, rulerY + 4, r.w - LABEL_W, (r.y + r.h) - rulerY - 4);
  TIPS['tl-scrub'] = 'Click to scrub · double-click empty track to pose';

  // ruler
  ctx.fillStyle = BG_RAISE;
  ctx.fillRect(r.x + LABEL_W, rulerY, r.w - LABEL_W, 18);
  ctx.fillStyle = CREAM_DIM;
  ctx.font = `10px ${MONO}`;
  let step = 5;
  while ((r.w - LABEL_W - 8) / (S.displayMax / step) < 26) step *= 2;
  for (let f = 0; f <= S.displayMax; f += step) {
    const px = Math.round(timX(f, r));
    ctx.fillText(`${f}`, px + 2, rulerY + 13);
  }

  // playhead handle (draggable, wins over the ruler scrub in its rect)
  const phx = Math.round(timX(clamp(S.frame, 0, S.displayMax), r));
  ctx.fillStyle = BG;
  ctx.fillRect(phx - 16, rulerY, 32, 18);
  ctx.fillStyle = CREAM;
  ctx.font = `9px ${MONO}`;
  ctx.fillText(`${Math.floor(S.frame)}`, phx - 14, rulerY + 12);
  ctx.beginPath();
  ctx.moveTo(phx - 6, rulerY + 18);
  ctx.lineTo(phx + 6, rulerY + 18);
  ctx.lineTo(phx, rulerY + 25);
  ctx.closePath();
  ctx.fillStyle = CREAM;
  ctx.fill();
  registerHit('tl-playhead', phx - 8, rulerY + 8, 16, 18);
  TIPS['tl-playhead'] = 'Playhead — drag to scrub';

  y += 20;

  // per-object track headers, each expanding to the grouped transform tracks
  for (const o of OBJECTS) {
    const isSel = o.group === currentGroup() && o.side === S.side;
    const open = !!S.objOpen[o.id];
    ctx.fillStyle = isSel ? BG_RAISE : BG;
    ctx.fillRect(r.x, y, r.w, TOPROW_H);
    ctx.fillStyle = LINE;
    ctx.fillRect(r.x, y, r.w, 1);
    ctx.fillStyle = isSel ? CREAM : CREAM_MUT;
    ctx.font = `bold 12px ${MONO}`;
    ctx.fillText(open ? '▼' : '▶', r.x + 10, y + 18);
    registerHit(`obj-toggle-${o.id}`, r.x, y, 26, TOPROW_H);
    TIPS[`obj-toggle-${o.id}`] = open ? 'Collapse track group' : 'Expand track group';
    ctx.fillStyle = isSel ? CREAM : CREAM_MUT;
    ctx.fillText(o.label, r.x + 30, y + 18);
    registerHit(`obj-${o.group}-${o.side}`, r.x + 26, y, LABEL_W - 26, TOPROW_H);
    TIPS[`obj-${o.group}-${o.side}`] = o.label + ' (E to switch hand/weapon)';
    ctx.fillStyle = CREAM_DIM;
    ctx.font = `10px ${MONO}`;
    const kcount = countKeys(o);
    ctx.fillText(kcount ? `${kcount} keys` : '', r.x + LABEL_W - 64, y + 18);
    y += TOPROW_H;
    if (!open) continue;
    for (const G of TRACK_GROUPS) y = drawGroupRow(ctx, r, y, o, G);
  }

  // VFX event lane (its hits register after tl-scrub → they take precedence)
  y = drawVfxLane(ctx, r, y);

  // playhead line over every track + the VFX lane
  const px = Math.round(timX(clamp(S.frame, 0, S.displayMax), r));
  ctx.strokeStyle = CREAM;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(px, rulerY + 8);
  ctx.lineTo(px, y);
  ctx.stroke();
  ctx.fillStyle = CREAM;
  ctx.fillRect(px - 3, rulerY + 8, 6, 8);
  ctx.restore();
}

// One grouped timeline row (e.g. POS = x/y across the selected object's props).
// The row shows the group's live sampled value + one diamond per frame where any
// of its base props has a keyframe. All interactions operate on the real prop
// tracks so nothing is duplicated.
function drawGroupRow(ctx, r, y, o, G) {
  const primary = propPath(o.group, o.side, G.props[0]);
  const isSel = o.group === currentGroup() && o.side === S.side;
  const tracked = S.trackSelect === primary;
  ctx.fillStyle = tracked ? '#1c1c1c' : BG;
  ctx.fillRect(r.x, y, r.w, FULLROW_H);
  if (tracked) { ctx.fillStyle = LINE; ctx.fillRect(r.x, y, r.w, 1); }

  ctx.fillStyle = TRACK_TINT[G.id];
  ctx.font = `bold 10px ${MONO}`;
  ctx.fillText(G.id, r.x + 10, y + 13);
  ctx.fillStyle = isSel ? CREAM_MUT : CREAM_DIM;
  ctx.font = `10px ${MONO}`;
  ctx.fillText(G.label, r.x + 42, y + 13);

  const vtxt = groupValueText(o, G);
  ctx.fillStyle = isSel ? CREAM : CREAM_DIM;
  ctx.font = `10px ${MONO}`;
  ctx.fillText(vtxt, r.x + LABEL_W - 6 - ctx.measureText(vtxt).width, y + 13);
  registerHit(`trv-${primary}`, r.x + 34, y, LABEL_W - 44, FULLROW_H);
  TIPS[`trv-${primary}`] = `${G.label} — drag value to scrub`;

  // empty row lane (select row; double-click = add a key for this group)
  registerHit(`tr-${primary}`, r.x + LABEL_W, y, r.w - LABEL_W, FULLROW_H);
  TIPS[`tr-${primary}`] = `${G.label} — double-click empty to add a key`;

  // merged keyframe diamonds for every frame the group actually keys
  for (const f of groupKeyFrames(o.group, o.side, G.id)) {
    const kx = Math.round(timX(f, r));
    const sel = isGroupKeySelected(o.group, o.side, G.id, f);
    const prim = !!(S.keySelect && S.keySelect.track === primary && S.keySelect.frame === f);
    ctx.beginPath();
    ctx.moveTo(kx, y + 4);
    ctx.lineTo(kx + 5, y + FULLROW_H / 2 + 1);
    ctx.lineTo(kx, y + FULLROW_H - 3);
    ctx.lineTo(kx - 5, y + FULLROW_H / 2 + 1);
    ctx.closePath();
    ctx.fillStyle = sel ? TRACK_TINT[G.id] : 'rgba(243,234,209,0.10)';
    ctx.fill();
    ctx.strokeStyle = prim ? CREAM : (sel ? 'rgba(0,0,0,0.75)' : TRACK_TINT[G.id]);
    ctx.lineWidth = 1;
    ctx.stroke();
    // registered last → markers win over the row + scrub hits
    registerHit(`gk-${o.group}:${o.side}:${G.id}@${f}`, kx - 7, y, 14, FULLROW_H);
    TIPS[`gk-${o.group}:${o.side}:${G.id}@${f}`] = `${G.label} key · frame ${f} — drag to move · shift+click multi · Del to delete`;
  }
  return y + FULLROW_H;
}

// The concrete prop paths behind one grouped row.
function groupPaths(obj, side, gid) {
  const G = TRACK_GROUPS.find(g => g.id === gid);
  return G ? G.props.map(p => propPath(obj, side, p)) : [];
}

// Sorted frame list where any prop in the group has a keyframe.
function groupKeyFrames(obj, side, gid) {
  const frames = new Set();
  for (const full of groupPaths(obj, side, gid)) {
    const tr = getTrack(S.anim, full);
    if (tr) for (const k of tr.keyframes) frames.add(Math.round(k.f));
  }
  return [...frames].sort((a, b) => a - b);
}

function isGroupKeySelected(obj, side, gid, f) {
  if (!S.selKeys) return false;
  for (const p of groupPaths(obj, side, gid)) {
    if (S.selKeys.has(`${p}|${f}`)) return true;
  }
  return false;
}

// Which group owns a concrete prop path.
function groupForPath(full) {
  const prop = full.slice(full.lastIndexOf('.') + 1);
  const G = TRACK_GROUPS.find(g => g.props.includes(prop));
  return G ? G.id : null;
}

// Live sampled value summary for a grouped row.
function groupValueText(o, G) {
  const parts = [];
  for (const p of G.props.slice(0, 2)) {
    const tr = getTrack(S.anim, propPath(o.group, o.side, p));
    const v = sampleTrack(tr, Math.floor(S.frame), DEFAULT_VALUES[p]);
    const lbl = { x: 'x', y: 'y', rot: 'rot', scaleX: 'sx', scaleY: 'sy', opacity: 'op', visible: 'vis', z: 'z' }[p] || p;
    parts.push(`${lbl} ${fmt(v)}${p === 'rot' ? '°' : ''}`);
  }
  return parts.join('  ');
}

// Select every base-prop key at `f` for a grouped marker (they all live on the
// one real row, so selecting the row selects them all).
function pressGroupKey(obj, side, gid, f, multi) {
  const present = groupPaths(obj, side, gid).filter(p => {
    const tr = getTrack(S.anim, p);
    return tr && exactKey(tr, f);
  });
  if (!present.length) return;
  S.trackSelect = present[0];
  const keyStrs = present.map(p => `${p}|${f}`);
  if (multi) {
    if (!S.selKeys) S.selKeys = new Set();
    const allSel = keyStrs.every(k => S.selKeys.has(k));
    if (allSel) {
      for (const k of keyStrs) S.selKeys.delete(k);
      S.keySelect = null;
    } else {
      for (const k of keyStrs) S.selKeys.add(k);
      S.keySelect = { track: present[0], frame: f };
    }
  } else {
    S.selKeys = new Set(keyStrs);
    S.keySelect = { track: present[0], frame: f };
  }
}

// Double-click on an empty grouped row drops keys for its props at that frame.
function keyGroupAt(gid, primary, frame) {
  const f = Math.floor(frame);
  const obj = primary.split('.')[0];
  const side = primary.split('.')[1];
  const G = TRACK_GROUPS.find(g => g.id === gid);
  if (!G) return;
  for (const p of G.props) {
    const full = propPath(obj, side, p);
    const tr = ensureTrack(S.anim, full);
    if (!exactKey(tr, f)) {
      addKeyframe(tr, f, sampleTrack(tr, f, DEFAULT_VALUES[p]), tr.keyframes.length ? tr.keyframes[tr.keyframes.length - 1].e : 'linear');
    }
  }
  refreshMax();
  S.dirty = true;
}

const UI_KEY_TL = 'smashfighters.animui.tlCollapsed';
const UI_KEY_OBJ = 'smashfighters.animui.objOpen';
function persistTlUi() {
  try {
    localStorage.setItem(UI_KEY_TL, S.tlCollapsed ? '1' : '0');
    localStorage.setItem(UI_KEY_OBJ, JSON.stringify(S.objOpen));
  } catch (_) {}
}

// Screen-space bar rect for one VFX entry on the timeline lane.
function vfxBarRect(i, r) {
  const list = ensureAnimVfx();
  const v = list[i];
  if (!v) return { x0: 0, x1: 0 };
  const x0 = Math.round(timX(clamp(v.startFrame || 0, 0, S.displayMax), r));
  const end = (v.startFrame || 0) + Math.max(1, v.duration || 10);
  const x1 = Math.round(timX(clamp(end, 0, S.displayMax), r));
  return { x0, x1 };
}

// The VFX lane: one bar per effect spanning startFrame → startFrame+duration,
// laid out under the object tracks. Click selects, drag moves/resizes the bar
// (so you can say exactly when each effect plays), double-click jumps there.
function drawVfxLane(ctx, r, y) {
  const vfx = ensureAnimVfx();
  const lx = r.x + 16;

  // lane header
  ctx.fillStyle = S.vfxIdx >= 0 ? BG_RAISE : BG;
  ctx.fillRect(r.x, y, r.w, TOPROW_H);
  ctx.fillStyle = LINE;
  ctx.fillRect(r.x, y, r.w, 1);
  ctx.fillStyle = CREAM;
  ctx.font = `bold 12px ${MONO}`;
  ctx.fillText('VFX EVENTS', lx, y + 18);
  ctx.fillStyle = CREAM_DIM;
  ctx.font = `10px ${MONO}`;
  ctx.fillText(`${vfx.length} ${vfx.length === 1 ? 'effect' : 'effects'} · click selects instance · drag moves · edges resize`, r.x + 96, y + 18);
  btn('+', r.x + r.w - 28, y + 4, 24, 20, 'vfx-add'); TIPS['vfx-add'] = 'Add VFX';
  btn('✕', r.x + r.w - 74, y + 4, 42, 20, 'vfx-del'); TIPS['vfx-del'] = 'Delete selected VFX';
  y += TOPROW_H;

  if (!vfx.length) {
    ctx.fillStyle = CREAM_DIM;
    ctx.font = `10px ${MONO}`;
    ctx.fillText('no effects — press + to add', lx, y + 13);
    return y + FULLROW_H;
  }

  for (let i = 0; i < vfx.length; i++) {
    const v = vfx[i];
    if (!v) continue;
    const isSel = i === S.vfxIdx;
    const { x0, x1 } = vfxBarRect(i, r);
    const eff = listVfxEffects().find(e => e.id === v.effect);
    const effName = ((eff ? eff.name : (v.effect || '?')) || '?').toUpperCase().slice(0, 8);
    const tint = VFX_TINT[v.effect] || VFX_TINT.bullet;

    ctx.fillStyle = isSel ? '#1c1c1c' : BG;
    ctx.fillRect(r.x, y, r.w, FULLROW_H);
    if (isSel) { ctx.fillStyle = LINE; ctx.fillRect(r.x, y, r.w, 1); }
    // type name is drawn in its own lane color so effects read at a glance
    ctx.fillStyle = tint;
    ctx.font = `bold 11px ${MONO}`;
    ctx.fillText(`${i + 1}`, lx, y + 13);
    ctx.fillText(effName, lx + 20, y + 13);
    ctx.fillStyle = isSel ? CREAM : CREAM_DIM;
    ctx.font = `10px ${MONO}`;
    const span = `${Math.round(v.startFrame || 0)}→${Math.round((v.startFrame || 0) + Math.max(1, v.duration || 10))}${v.loop ? ' ∞' : ''}`;
    ctx.fillText(span, r.x + LABEL_W - 58, y + 13);
    // row hit first, then the del button registers later so IT wins its rect
    registerHit(`vfx-tl-${i}`, r.x, y, r.w, FULLROW_H);
    TIPS[`vfx-tl-${i}`] = `VFX ${i + 1} · ${effName} — drag to move · edges resize · dbl-click go`;
    btn('✕', r.x + LABEL_W - 22, y + 3, 18, 14, `vfx-tl-del-${i}`);

    // the VFX bar: tinted block from trigger frame to end frame, with a cream
    // trigger tick at the left edge so it reads as "starts here"
    const bw = Math.max(2, x1 - x0);
    ctx.fillStyle = tint;
    ctx.globalAlpha = isSel ? 1 : 0.72;
    ctx.fillRect(x0, y + 5, bw, FULLROW_H - 10);
    ctx.globalAlpha = 1;
    ctx.fillStyle = CREAM;
    ctx.fillRect(x0, y + 5, Math.min(3, bw), FULLROW_H - 10);
    ctx.strokeStyle = isSel ? CREAM : 'rgba(0,0,0,0.8)';
    ctx.strokeRect(x0 + 0.5, y + 5.5, bw - 1, FULLROW_H - 11);
    if (bw > 36) {
      ctx.fillStyle = 'rgba(0,0,0,0.78)';
      ctx.font = `9px ${MONO}`;
      ctx.fillText(effName, x0 + 6, y + 15);
    }
    if (v.loop && bw > 12) {
      ctx.fillStyle = 'rgba(0,0,0,0.8)';
      ctx.fillRect(x1 - 3, y + 8, 2, FULLROW_H - 16);
      ctx.fillRect(x1 - 9, y + 8, 2, FULLROW_H - 16);
    }

    y += FULLROW_H;
  }
  return y;
}

function countKeys(o) {
  let n = 0;
  for (const p of TRANSFORM_PROPS) {
    const tr = getTrack(S.anim, propPath(o.group, o.side, p));
    if (tr) n += tr.keyframes.length;
  }
  return n;
}

function isKeySelected(track, frame) {
  return S.selKeys ? S.selKeys.has(`${track}|${frame}`) : false;
}

// ── tooltip ────────────────────────────────────────────────────────────────
function drawTooltip(ctx) {
  if (!S.hover || !TIPS[S.hover]) return;
  const tip = TIPS[S.hover];
  const { x, y } = S.lastPointer;
  ctx.font = `11px ${MONO}`;
  const tw = ctx.measureText(tip).width + 18;
  const bx = clamp(x + 16, 0, VPW - tw - 4);
  const by = clamp(y + 20, 0, VPH - 28);
  ctx.fillStyle = 'rgba(28,28,28,0.96)';
  ctx.strokeStyle = LINE;
  ctx.strokeRect(bx, by, tw, 24);
  ctx.fillRect(bx, by, tw, 24);
  ctx.fillStyle = CREAM_MUT;
  ctx.textBaseline = 'middle';
  ctx.fillText(tip, bx + 9, by + 13);
  ctx.textBaseline = 'alphabetic';
}

// ── hit testing / pointer ─────────────────────────────────────────────────
function hitAt(x, y) {
  for (let i = S.hits.length - 1; i >= 0; i--) {
    const h = S.hits[i];
    if (x >= h.x && x <= h.x + h.w && y >= h.y && y <= h.y + h.h) return h.id;
  }
  return null;
}

function loc(e) {
  const rect = S.canvas.getBoundingClientRect();
  return { x: e.clientX - rect.left, y: e.clientY - rect.top };
}

function setFrame(f) {
  S.frame = clamp(Math.round(f), 0, S.displayMax);
  if (S.subject) {
    S.subject.anim.scrubbing = true;
    S.subject.anim.frame = S.frame;
    sampleAnimator(S.subject);
  }
}

function selectKey(track, frame, additive) {
  S.trackSelect = track;
  if (additive) {
    if (!S.selKeys) S.selKeys = new Set();
    S.selKeys.add(`${track}|${frame}`);
    S.keySelect = { track, frame };
  } else {
    S.selKeys = new Set();
    S.selKeys.add(`${track}|${frame}`);
    S.keySelect = { track, frame };
  }
}

let lastDownT = 0, lastDownX = 0, lastDownY = 0;

function onPointerDown(e) {
  if (!S.open) return;
  const { x, y } = loc(e);
  S.lastPointer = { x, y };
  const l = lr();

  // Popup takes precedence: if it's open and the click lands anywhere outside
  // it (and not on an opener), close the menu and treat this as a normal click.
  if (S.popup && !insidePopup(x, y)) {
    const hit = hitAt(x, y);
    if (!(hit && hit.startsWith('menu:'))) S.popup = null;
  }

  const hit = hitAt(x, y);

  // right / middle drag anywhere in the viewport pans the camera
  if (y > l.top.y + l.top.h - 1 && hit == null && (e.button === 1 || e.button === 2 || e.altKey)) {
    S.drag = { type: 'pan', lastX: x, lastY: y };
    e.preventDefault();
    return;
  }
  // timeline resize divider
  if (!S.tlCollapsed && y >= VPH - TIMELINE_H && y <= VPH - TIMELINE_H + 3 && x < VPW - PANEL_W) {
    S.drag = { type: 'tlResize', lastY: y };
    if (e.button === 0) { e.preventDefault(); }
    return;
  }
  // panel resize divider
  if (x >= VPW - PANEL_W - 4 && x <= VPW - PANEL_W && y > l.top.y && y < l.tl.y) {
    S.drag = { type: 'panelResize', lastX: x };
    e.preventDefault();
    return;
  }

  if (hit) {
    // gizmo / anchor drags — undo captured at gesture start
    if (hit === 'move-handle') {
      pushUndo();
      S.drag = { type: 'move', lastWorld: screenToWorld(x, y, l.vp) };
      e.preventDefault(); return;
    }
    if (hit === 'rot-handle') {
      const selH = selectedOut();
      if (selH) {
        pushUndo();
        const pivot = gripCenterWorld();
        const p = worldToScreen(pivot.x, pivot.y, l.vp);
        S.drag = { type: 'rot', lastAng: Math.atan2(y - p.y, x - p.x), pivot: p };
        e.preventDefault(); return;
      }
    }
    if (hit === 'scale-handle') {
      const selH = selectedOut();
      if (selH) {
        pushUndo();
        const pivot = gripCenterWorld();
        const ps = worldToScreen(pivot.x, pivot.y, l.vp);
        const grabDist = Math.max(6, Math.hypot(x - ps.x, y - ps.y) / cam.zoom);
        S.drag = {
          type: 'scale',
          pivot: { x: ps.x, y: ps.y },
          startDist: grabDist,
          startV: [sampledValue('scaleX'), sampledValue('scaleY')],
        };
        e.preventDefault(); return;
      }
    }
    if (hit.startsWith('wanchor:')) {
      const wd = weaponDefForSide();
      const out = S.subject && S.subject.anim && S.subject.anim.out;
      const w = out && out.weapons[S.side];
      if (wd && w) {
        pushUndo();
        const anchorId = hit.slice(8);
        const world = screenToWorld(x, y, l.vp);
        const startLocal = worldToLocal(w.px, w.py, w.rot, w.scaleX || 1, w.scaleY || 1, world.x, world.y);
        S.drag = { type: 'worldAnchor', anchorId, startAnchor: anchorLocalValue(anchorId, wd), startLocal };
        e.preventDefault(); return;
      }
    }
    // scrub-readouts
    if (hit === 'frame-drag' || hit === 'frame-drag-tl') {
      S.drag = { type: 'scrub', lastX: x, inTimeline: hit === 'frame-drag-tl' };
      e.preventDefault(); return;
    }
    if (hit === 'tl-playhead') {
      const f = frameFromX(x, l.tl);
      S.drag = { type: 'scrub', lastX: x, inTimeline: true };
      setFrame(f);
      e.preventDefault(); return;
    }
    if (hit === 'tl-scrub') {
      // empty-track double-click drops a full-pose key at that frame
      const nowT = performance.now();
      const isDbl = (nowT - lastDownT < 400) && Math.hypot(x - lastDownX, y - lastDownY) < 6;
      lastDownT = nowT; lastDownX = x; lastDownY = y;
      if (isDbl) { pushUndo(); addPoseKey(); e.preventDefault(); return; }
      const f = frameFromX(x, l.tl);
      S.drag = { type: 'scrub', lastX: x, inTimeline: true };
      setFrame(f);
      e.preventDefault(); return;
    }
    if (hit.startsWith('trv-')) {
      const full = hit.slice(4);
      S.trackSelect = full;
      pushUndo();
      S.drag = { type: 'prop', prop: full.split('.').pop(), lastX: x };
      e.preventDefault(); return;
    }
    if (hit.startsWith('prop-') && hit.endsWith('-drag')) {
      const prop = hit.slice(5, -5);
      pushUndo();
      // clickId turns a click-without-drag into the "type a number" editor
      S.drag = { type: 'prop', prop, lastX: x, clickId: 'edit-prop-' + prop, downX: x, downY: y };
      e.preventDefault(); return;
    }
    // vfx/weapon numeric row drags (shared numRow handler)
    const nrMatch = hit.match(/^(vfx|weap)-([A-Za-z]+)-drag$/);
    if (nrMatch) {
      const prefix = nrMatch[1];
      const key = nrMatch[2];
      const src = prefix === 'weap'
        ? (S.anim.weapons || {})[S.side] || {}
        : ensureAnimVfx()[S.vfxIdx] || {};
      pushUndo();
      S.drag = {
        type: 'numRow', prefix, key,
        start: src[key] != null ? src[key] : 0,
        lastX: x,
        clickId: `edit-${prefix}-${key}`, downX: x, downY: y,
      };
      e.preventDefault(); return;
    }
    if (hit.startsWith('vfx-tl-')) {
      e.preventDefault();
      pressVfxLane(hit, x, y, l);
      return;
    }
    if (hit.startsWith('kf-')) {
      const rest = hit.slice(3);
      const at = rest.lastIndexOf('@');
      const full = rest.slice(0, at);
      const f = parseInt(rest.slice(at + 1), 10);
      // double-click handled on up; initiating a keyframe drag
      const multi = e.shiftKey || e.ctrlKey;
      if (!multi && !isKeySelected(full, f)) {
        S.selKeys = new Set();
        S.trackSelect = full;
        S.keySelect = { track: full, frame: f };
        S.selKeys.add(`${full}|${f}`);
      } else {
        S.trackSelect = full;
        if (multi) {
          S.selKeys = S.selKeys || new Set();
          if (S.selKeys.has(`${full}|${f}`)) S.selKeys.delete(`${full}|${f}`);
          else S.selKeys.add(`${full}|${f}`);
        } else if (!S.selKeys.has(`${full}|${f}`)) {
          S.selKeys = new Set();
          S.selKeys.add(`${full}|${f}`);
        }
      }
      // capture original frames for the drag
      pushUndo();
      S.drag = { type: 'kfDrag', startFrame: f, moved: false, origin: colOriginFrames() };
      e.preventDefault(); return;
    }
    // grouped-track markers: select + drag-move every real key in this group
    if (hit.startsWith('gk-')) {
      const rest = hit.slice(3);
      const atF = rest.lastIndexOf('@');
      const f = parseInt(rest.slice(atF + 1), 10);
      const [obj, side, gid] = rest.slice(0, atF).split(':');
      const multi = e.shiftKey || e.ctrlKey;
      pressGroupKey(obj, side, gid, f, multi);
      pushUndo();
      S.drag = { type: 'kfDrag', startFrame: f, moved: false, origin: colOriginFrames() };
      e.preventDefault(); return;
    }
    // grouped-track rows: click selects the row, double-click drops a group key
    if (hit.startsWith('tr-')) {
      const full = hit.slice(3);
      const nowT = performance.now();
      const isDbl = (nowT - lastDownT < 400) && Math.hypot(x - lastDownX, y - lastDownY) < 6;
      lastDownT = nowT; lastDownX = x; lastDownY = y;
      S.trackSelect = full;
      S.keySelect = null;
      if (isDbl) {
        const gid = groupForPath(full);
        pushUndo();
        keyGroupAt(gid, full, frameFromX(x, l.tl));
        e.preventDefault(); return;
      }
      e.preventDefault(); return;
    }
    // handled by the action table (buttons etc.)
    if (isStepButton(hit)) {
      pushUndo();
      executeStep(hit);
      S.drag = { type: 'btnHold', id: hit };
      startStepHold(hit);
    } else {
      handleEditAction(hit);
    }
    e.preventDefault();
    return;
  }

  // click empty viewport — select nearest object / start a move?
  if (y > l.top.y + l.top.h - 1 && y < l.tl.y && x < l.vp.x + l.vp.w) {
    // clicked an empty spot: bring the nearest hand/weapon under the cursor
    const near = pickObjectNearScreen(x, y, l);
    if (near) {
      S.objType = near.g === 'hands' ? 'hand' : 'weapon';
      S.side = near.s;
      S.trackSelect = null; S.keySelect = null;
    }
  }

  // double-click empty timeline → pose key for the selected object
  if (y >= l.tl.y) {
    const nowT = performance.now();
    const isDbl = (nowT - lastDownT < 400) && Math.hypot(x - lastDownX, y - lastDownY) < 6;
    lastDownT = nowT; lastDownX = x; lastDownY = y;
    if (isDbl) {
      pushUndo();
      addPoseKey();
      e.preventDefault(); return;
    }
    const f = frameFromX(x, l.tl);
    S.drag = { type: 'scrub', lastX: x, inTimeline: true };
    setFrame(f);
    e.preventDefault();
    return;
  }

  // click empty viewport pans? no — drag hand only via handle. allow drag to
  // pan with alt/right (handled above). otherwise nothing.
  S.drag = null;
}

function pickObjectNearScreen(x, y, l) {
  if (!S.subject.anim || !S.subject.anim.out) return null;
  const out = S.subject.anim.out;
  let best = null, bd = 40;
  for (const s of ['right', 'left']) {
    for (const g of ['hands', 'weapons']) {
      const o = g === 'hands' ? null : out.weapons[s];
      const pos = g === 'hands' ? out.hands[s] : (o || out.hands[s]);
      if (!pos) continue;
      const p = worldToScreen(pos.px, pos.py, l.vp);
      const dist = Math.hypot(x - p.x, y - p.y);
      if (dist < bd) { bd = dist; best = { g, s }; }
    }
  }
  return best;
}

function selectedOut() {
  const out = S.subject.anim && S.subject.anim.out;
  if (!out) return null;
  return S.objType === 'hand' ? out.hands[S.side] : (out.weapons[S.side] || out.hands[S.side]);
}

// The world-space point an object visibly rotates/scales around. Hands pivot
// on their own position; weapons on their sprite pivot (grip by default).
function gripCenterWorld() {
  const out = S.subject && S.subject.anim && S.subject.anim.out;
  if (!out) return { x: 0, y: 0 };
  if (S.objType === 'weapon') {
    const w = out.weapons[S.side];
    if (w && w.def) {
      const pv = w.def.pivot || w.def.anchors.grip || { x: 0, y: 0 };
      return localToWorld(w.px, w.py, w.rot, w.scaleX || 1, w.scaleY || 1, pv.x, pv.y);
    }
  }
  const h = out.hands[S.side];
  return h ? { x: h.px, y: h.py } : { x: 0, y: 0 };
}

// Current local-sprite-space value of a weapon anchor id — the anchor drag
// starts from here so it follows the cursor with zero initial jump.
function anchorLocalValue(anchorId, wd) {
  if (!wd) return { x: 0, y: 0 };
  const a = wd.anchors || {};
  if (anchorId === 'grip') return a.grip || { x: 0, y: 0 };
  if (anchorId === 'tip') return a.tip || { x: 0, y: 0 };
  if (anchorId === 'center') return a.center || { x: 0, y: 0 };
  if (anchorId === 'pivot') return wd.pivot || { x: 0, y: 0 };
  const i = parseInt(anchorId.split(':')[1], 10);
  return (a.custom && a.custom[i]) || { x: 0, y: 0 };
}

function colOriginFrames() {
  const m = new Map();
  for (const key of (S.selKeys || [])) {
    const [track, fstr] = key.split('|');
    m.set(key, parseInt(fstr, 10));
  }
  return m;
}

function onPointerMove(e) {
  if (!S.open) return;
  const { x, y } = loc(e);
  S.lastPointer = { x, y };
  S.hover = hitAt(x, y);
  const d = S.drag;
  if (!d) return;
  const l = lr();

  // a real drag (not a click) — don't open the type-in editor on release
  if (d.downX != null && (Math.abs(x - d.downX) > 3 || Math.abs(y - d.downY) > 3)) d.clickId = null;

  if (d.type === 'pan') {
    const dx = x - d.lastX, dy = y - d.lastY;
    d.lastX = x; d.lastY = y;
    cam.x -= dx / cam.zoom;
    cam.y -= dy / cam.zoom;
  } else if (d.type === 'tlResize') {
    const dy = y - d.lastY;
    d.lastY = y;
    TIMELINE_H = clamp(TIMELINE_H - dy, TIMELINE_MIN, TIMELINE_MAX);
  } else if (d.type === 'panelResize') {
    const dx = x - d.lastX;
    d.lastX = x;
    PANEL_W = clamp(PANEL_W - dx, PANEL_MIN, PANEL_MAX);
  } else if (d.type === 'move') {
    const w = screenToWorld(x, y, l.vp);
    const dx = w.x - d.lastWorld.x, dy = w.y - d.lastWorld.y;
    d.lastWorld = w;
    nudgeProp('x', dx / (PROP_STEP.x || 1));
    nudgeProp('y', dy / (PROP_STEP.y || 1));
  } else if (d.type === 'rot') {
    const selH = selectedOut();
    if (!selH) { S.drag = null; return; }
    const p = d.pivot || worldToScreen(selH.px, selH.py, l.vp);
    const na = Math.atan2(y - p.y, x - p.x);
    // Delta-based: rotation follows the cursor's angular drag from the grab
    // point (no initial jump), pivoting around the handle pivot.
    let deg = round3((na - d.lastAng) * 180 / Math.PI);
    if (deg > 180) deg -= 360;
    else if (deg < -180) deg += 360;
    d.lastAng = na;
    nudgeProp('rot', deg);
  } else if (d.type === 'scale') {
    const selH = selectedOut();
    if (!selH) { S.drag = null; return; }
    // Pivot-anchored ratio: the object scales as the cursor moves toward/away
    // from the pivot. Distances are in world units so feel is zoom-independent.
    const cur = Math.max(2, Math.hypot(x - d.pivot.x, y - d.pivot.y) / cam.zoom);
    const ratio = d.startDist > 0 ? cur / d.startDist : 1;
    const sStep = PROP_STEP.scaleX || 0.01;
    nudgeProp('scaleX', (d.startV[0] * ratio - sampledValue('scaleX')) / sStep);
    nudgeProp('scaleY', (d.startV[1] * ratio - sampledValue('scaleY')) / sStep);
  } else if (d.type === 'scrub') {
    if (d.inTimeline) setFrame(frameFromX(x, l.tl));
    else setFrame(screenToTimelineFrac(x, l));
  } else if (d.type === 'prop') {
    const dxp = (x - d.lastX);
    d.lastX = x;
    nudgeProp(d.prop, dxp);
  } else if (d.type === 'numRow') {
    const dxp = x - d.lastX;
    d.lastX = x;
    setRowValue(d.prefix, d.key, d.start + dxp * rowStep(d.key));
  } else if (d.type === 'vfxTl') {
    const arr = ensureAnimVfx();
    const v = arr[d.idx];
    if (!v) { S.drag = null; return; }
    const curF = frameFromX(x, l.tl);
    let ns = d.start, nd = d.dur;
    if (d.mode === 'move') {
      ns = clamp(Math.round(curF - d.grabOffsetF), 0, S.displayMax);
    } else if (d.mode === 'resizeL') {
      ns = clamp(Math.round(curF), 0, S.displayMax);
      nd = d.start + d.dur - ns;
      if (nd < 1) { nd = 1; ns = d.start + d.dur - 1; }
    } else { // resizeR
      nd = clamp(Math.round(curF) - d.start, 1, S.displayMax);
    }
    v.startFrame = ns;
    v.duration = nd;
    S.dirty = true;
  } else if (d.type === 'kfDrag') {
    const newF = clamp(Math.round(frameFromX(x, l.tl)), 0, S.displayMax);
    const delta = newF - d.startFrame;
    if (delta !== 0) d.moved = true;
    for (const [key, orig] of d.origin.entries()) {
      const [track] = key.split('|');
      const tr = getTrack(S.anim, track);
      if (!tr) continue;
      const nf = clamp(orig + delta, 0, S.displayMax);
      moveKeyframe(tr, orig, nf);
      if (S.keySelect && S.keySelect.track === track && S.keySelect.frame === orig) {
        S.keySelect.frame = nf;
      }
      // rebuild selection keys
      const newKey = `${track}|${nf}`;
      if (isKeySelected(track, orig)) {
        S.selKeys.delete(key);
        S.selKeys.add(newKey);
      }
    }
    refreshMax();
  } else if (d.type === 'worldAnchor') {
    const out = S.subject.anim.out;
    const w = out.weapons[S.side];
    if (!w) { S.drag = null; return; }
    // Track the cursor 1:1 from the grab point: (currentLocal - grabLocal)
    // is the exact cursor motion in sprite space, added to the anchor's
    // original position — no jump, works at any zoom/rotation/scale.
    const world = screenToWorld(x, y, l.vp);
    const cur = worldToLocal(w.px, w.py, w.rot, w.scaleX || 1, w.scaleY || 1, world.x, world.y);
    let lx = round3(d.startAnchor.x + (cur.x - d.startLocal.x));
    let ly = round3(d.startAnchor.y + (cur.y - d.startLocal.y));
    if (S.snap) { lx = snapVal(lx); ly = snapVal(ly); }
    updateAnchor(d.anchorId, lx, ly);
  }
  e.preventDefault();
}

function screenToTimelineFrac(x, l) {
  // reuse frame mapping from the timeline region (top-bar frame readout)
  return S.displayMax * clamp((x - l.tl.x - LABEL_W) / (l.tl.w - LABEL_W - 8), 0, 1);
}

// Click / drag start on a timeline VFX bar. Selects the row; double-click
// jumps the playhead to the effect's start; single press begins a move or an
// edge-resize drag (left edge = start frame, right edge = duration).
function pressVfxLane(hit, x, y, l) {
  const arr = ensureAnimVfx();
  if (!arr.length) return;
  if (hit.startsWith('vfx-tl-del-')) {
    const i = parseInt(hit.slice('vfx-tl-del-'.length), 10);
    if (arr[i] == null) return;
    pushUndo();
    arr.splice(i, 1);
    S.vfxIdx = clamp(S.vfxIdx, 0, Math.max(0, arr.length - 1));
    S.dirty = true;
    return;
  }
  const i = parseInt(hit.slice('vfx-tl-'.length), 10);
  if (arr[i] == null) return;
  S.vfxIdx = i;

  const nowT = performance.now();
  const isDbl = (nowT - lastDownT < 400) && Math.hypot(x - lastDownX, y - lastDownY) < 6;
  lastDownT = nowT; lastDownX = x; lastDownY = y;
  if (isDbl) { setFrame(arr[i].startFrame || 0); return; }

  const { x0, x1 } = vfxBarRect(i, l.tl);
  const start = Math.round(arr[i].startFrame || 0);
  const dur = Math.max(1, Math.round(arr[i].duration || 10));
  let mode = 'move';
  if (x1 - x0 >= 10) {
    if (x - x0 <= 4) mode = 'resizeL';
    else if (x1 - x <= 4) mode = 'resizeR';
  }
  pushUndo();
  S.drag = {
    type: 'vfxTl', idx: i, mode, start, dur,
    grabOffsetF: Math.max(0, frameFromX(x, l.tl) - start),
    lastX: x,
  };
}

function onPointerUp(e) {
  const d = S.drag;
  if (d && d.type === 'btnHold') {
    clearStepHold();
    S.drag = null;
    return;
  }
  if (d && d.clickId) {
    const cur = editValueCurrent(d.clickId);
    if (cur !== undefined) {
      showModal(editValueTitle(d.clickId), String(cur), v => {
        pushUndo();
        applyEditValue(d.clickId, v);
      }, 'SET', 'CANCEL', true);
    }
    S.drag = null;
    return;
  }
  if (S.drag && (S.drag.type === 'kfDrag' || S.drag.type === 'pan')) {
    // nothing to commit beyond the pushed undo snapshot
  }
  S.drag = null;
}

// ── click-to-type value editing ────────────────────────────────────────
function editValueCurrent(id) {
  if (id.startsWith('edit-prop-')) return sampledValue(id.slice('edit-prop-'.length));
  if (id.startsWith('edit-weap-')) return rowCurrent('weap', id.slice('edit-weap-'.length));
  if (id.startsWith('edit-vfx-')) return rowCurrent('vfx', id.slice('edit-vfx-'.length));
  return undefined;
}

function editValueTitle(id) {
  if (id.startsWith('edit-prop-')) {
    const p = id.slice('edit-prop-'.length);
    return `${(PROP_LABEL[p] || p).toUpperCase()} (frame ${Math.floor(S.frame)})`;
  }
  if (id.startsWith('edit-weap-')) return (FIELD_LABEL[id.slice('edit-weap-'.length)] || 'VALUE').toUpperCase();
  if (id.startsWith('edit-vfx-')) return (FIELD_LABEL[id.slice('edit-vfx-'.length)] || 'VALUE').toUpperCase();
  return 'VALUE';
}

function applyEditValue(id, v) {
  const n = Number(v);
  if (!isFinite(n)) return;
  if (id.startsWith('edit-prop-')) setPropAbs(id.slice('edit-prop-'.length), n);
  else if (id.startsWith('edit-weap-')) setRowValue('weap', id.slice('edit-weap-'.length), n);
  else if (id.startsWith('edit-vfx-')) setRowValue('vfx', id.slice('edit-vfx-'.length), n);
}

// Set an animation prop to an exact value at the current frame (no snapping —
// typed numbers are honored literally).
function setPropAbs(prop, v) {
  const nv = round3(Number(v));
  if (!isFinite(nv)) return;
  const tr = ensureTrack(S.anim, pathFor(prop));
  const k = writeKey(pathFor(prop), Math.floor(S.frame), nv, tr.keyframes.length ? tr.keyframes[tr.keyframes.length - 1].e : 'linear');
  S.keySelect = { track: pathFor(prop), frame: k.f };
  refreshMax();
  S.dirty = true;
}

function onEditorWheel(e) {
  if (!S.open) return;
  const { x, y } = loc(e);
  const l = lr();

  // viewport: camera zoom centered at cursor
  if (y < l.tl.y && y >= l.top.y + l.top.h - 1 && x < l.vp.x + l.vp.w) {
    const factor = e.deltaY > 0 ? 0.9 : 1.1;
    const before = screenToWorld(x, y, l.vp);
    cam.zoom = clamp(cam.zoom * factor, 0.3, 8);
    const after = screenToWorld(x, y, l.vp);
    cam.x += before.x - after.x;
    cam.y += before.y - after.y;
    e.preventDefault();
    return;
  }

  // popup: scroll the menu rows
  if (S.popup && insidePopup(x, y)) {
    S.popup.scroll = clamp(S.popup.scroll + (e.deltaY > 0 ? 18 : -18), 0, Math.max(0, S.popup.totalH - S.popup.maxH));
    e.preventDefault();
    return;
  }

  // panel: scroll properties
  if (x >= l.panel.x && y > l.top.y && y < l.tl.y) {
    const maxScroll = Math.max(0, S._panelContentH - (l.panel.h - 14));
    S.panelScroll = clamp(S.panelScroll + (e.deltaY > 0 ? 18 : -18), 0, maxScroll);
    e.preventDefault();
    return;
  }

  // timeline: adjust display (zoom in/out frame window)
  if (!S.tlCollapsed && y >= l.tl.y) {
    S.displayMax = clamp(S.displayMax + (e.deltaY > 0 ? 10 : -10), 20, 2000);
    refreshMax();
    S.frame = Math.min(S.frame, S.displayMax);
    e.preventDefault();
  }
}

// ── value nudging + keyframe ops ───────────────────────────────────────────
function nudgeProp(prop, worldDelta) {
  const tr = ensureTrack(S.anim, pathFor(prop));
  const cur = sampledValue(prop);
  const step = PROP_STEP[prop] || 1;
  if (globalThis.__DBG) console.error(`nudgeProp prop=${prop} delta=${worldDelta} cur=${cur} step=${step} frame=${S.frame}`);
  let nv = round3(cur + worldDelta * step);
  if (S.snap) {
    if (prop === 'x' || prop === 'y') nv = snapVal(nv);
    else if (prop === 'rot') nv = Math.round(nv / 15) * 15;
    else if (prop === 'scaleX' || prop === 'scaleY') nv = Math.round(nv * 20) / 20;
  }
  const ease = tr.keyframes.length ? tr.keyframes[tr.keyframes.length - 1].e : 'linear';
  const k = writeKey(pathFor(prop), Math.floor(S.frame), nv, ease);
  S.keySelect = { track: pathFor(prop), frame: k.f };
  refreshMax();
  S.dirty = true;
}

// Step a transform prop by its PROP_STEP without snapping. Used by the +/−
// buttons so a single click always produces a visible change and repeated
// clicks keep accumulating.
function stepProp(prop, dir) {
  const tr = ensureTrack(S.anim, pathFor(prop));
  const cur = sampledValue(prop);
  const step = PROP_STEP[prop] || 1;
  const nv = round3(cur + dir * step);
  const ease = tr.keyframes.length ? tr.keyframes[tr.keyframes.length - 1].e : 'linear';
  const k = writeKey(pathFor(prop), Math.floor(S.frame), nv, ease);
  S.keySelect = { track: pathFor(prop), frame: k.f };
  refreshMax();
  S.dirty = true;
}

// ── live side-mirroring ───────────────────────────────────────────────────
// When S.mirror is on, writing a keyframe for one side also writes the
// mirrored keyframe to the opposite side (right ↔ left). Only applies to
// hands and weapons tracks; other tracks are left alone.
function mirrorPath(path) {
  const parts = path.split('.');
  if (parts.length !== 3) return null;
  const [group, side, prop] = parts;
  if (side !== 'right' && side !== 'left') return null;
  return `${group}.${side === 'right' ? 'left' : 'right'}.${prop}`;
}
function mirrorValue(prop, v) {
  if (prop === 'x' || prop === 'rot') return round3(-v);
  if (prop === 'flipX') return v ? 0 : 1;
  return v;
}

// A weapon `x` track is not a plain position: the animator rotates
// `x - pivot.x` about the grip, and the pivot is a fixed point in the sprite's
// own space that never mirrors with the art. So a bare negation would drop both
// sides' pivot and the mirrored weapon would land 2*pivot.x off the mirror
// (20px for a revolver, 58px for a rifle). Carrying the source and destination
// pivots makes the mirrored resolve an exact mirror of the authored pose.
function weaponPivotX(side) {
  const cfg = S.anim.weapons && S.anim.weapons[side];
  const def = cfg && cfg.id ? getWeapon(cfg.id) : null;
  return (def && def.pivot && def.pivot.x) || 0;
}
function mirroredWeaponX(path, mpath, v) {
  const src = path.split('.')[1];
  const dst = mpath.split('.')[1];
  return round3(-v + weaponPivotX(src) + weaponPivotX(dst));
}

// Weapon attachment config mirrors across the Y axis the same way x does:
// horizontal grip/mount offsets and the grip rotation flip sign, vertical
// offsets pass through untouched. Only applied when the opposite side already
// has a weapon assigned, so arming one side never silently arms the other.
function mirrorWeaponCfgEdit(side, key, value) {
  const opp = side === 'right' ? 'left' : 'right';
  const oppCfg = S.anim.weapons && S.anim.weapons[opp];
  if (!oppCfg) return;
  let mv = value;
  if (key === 'mountX' || key === 'gripOffsetX' || key === 'gripRot') mv = -value;
  oppCfg[key] = round3(mv);
}
function writeKey(path, frame, value, ease) {
  const tr = ensureTrack(S.anim, path);
  const k = addKeyframe(tr, Math.round(frame), round3(value), ease);
  if (S.mirror) {
    const mp = mirrorPath(path);
    if (mp) {
      const mProp = mp.split('.')[2];
      const mv = mProp === 'x' && path.startsWith('weapons.')
        ? mirroredWeaponX(path, mp, round3(value))
        : mirrorValue(mProp, round3(value));
      const mTr = ensureTrack(S.anim, mp);
      addKeyframe(mTr, Math.round(frame), mv, ease);
    }
  }
  return k;
}

function addPoseKey() {
  // place a full-pose keyframe for the selected object at the current frame
  const props = TRANSFORM_PROPS;
  for (const p of props) {
    const tr = ensureTrack(S.anim, pathFor(p));
    writeKey(pathFor(p), Math.floor(S.frame), sampledValue(p), tr.keyframes.length ? tr.keyframes[tr.keyframes.length - 1].e : 'linear');
  }
  refreshMax();
}

function pushKey(prop) {
  const tr = ensureTrack(S.anim, pathFor(prop));
  return writeKey(pathFor(prop), Math.floor(S.frame), round3(sampledValue(prop)), tr.keyframes.length ? tr.keyframes[tr.keyframes.length - 1].e : 'linear');
}

function keyTrack() {
  if (!S.trackSelect) return;
  const tr = ensureTrack(S.anim, S.trackSelect);
  const k = addKeyframe(tr, Math.floor(S.frame), sampleTrack(tr, Math.floor(S.frame), DEFAULT_VALUES[S.trackSelect.split('.').pop()]), 'linear');
  selectKey(S.trackSelect, k.f, false);
  refreshMax();
}

function delSelectedKey() {
  if (!S.keySelect && (!S.selKeys || !S.selKeys.size)) return;
  const targets = [];
  if (S.selKeys && S.selKeys.size) {
    for (const key of S.selKeys) {
      const [track, fstr] = key.split('|');
      targets.push({ track, frame: parseInt(fstr, 10) });
    }
  } else if (S.keySelect) {
    targets.push({ track: S.keySelect.track, frame: S.keySelect.frame });
  }
  for (const t of targets) {
    const tr = getTrack(S.anim, t.track);
    if (tr) removeKeyframeAt(tr, t.frame);
  }
  S.keySelect = null;
  if (S.selKeys) S.selKeys.clear();
  refreshMax();
}

// Removes the selected VFX instance outright (array element, so the animation
// data and timeline entry disappear — not just hidden). No-op when a keyframe
// selection is active so Delete keeps deleting keyframes.
function delSelectedVfx() {
  const arr = ensureAnimVfx();
  if (!arr.length || arr[S.vfxIdx] == null) return;
  arr.splice(S.vfxIdx, 1);
  S.vfxIdx = clamp(S.vfxIdx, 0, Math.max(0, arr.length - 1));
  S.dirty = true;
}

function copyKey() {
  if (!S.keySelect) return;
  const tr = getTrack(S.anim, S.keySelect.track);
  const k = tr && exactKey(tr, S.keySelect.frame);
  if (k) S.clip = { v: k.v, e: k.e };
}

function pasteKey() {
  if (!S.clip || !S.trackSelect) return;
  const tr = ensureTrack(S.anim, S.trackSelect);
  const k = addKeyframe(tr, Math.floor(S.frame), round3(S.clip.v), S.clip.e);
  selectKey(S.trackSelect, k.f, false);
  refreshMax();
}

function prevKeyFrame() {
  let best = null;
  for (const path of allTrackPaths(S.anim)) {
    const tr = getTrack(S.anim, path);
    if (!tr) continue;
    for (const k of tr.keyframes) if (k.f < S.frame - 0.01) best = best == null ? k.f : Math.max(best, k.f);
  }
  return best;
}
function nextKeyFrame() {
  let best = null;
  for (const path of allTrackPaths(S.anim)) {
    const tr = getTrack(S.anim, path);
    if (!tr) continue;
    for (const k of tr.keyframes) if (k.f > S.frame + 0.01) best = best == null ? k.f : Math.min(best, k.f);
  }
  return best;
}

function cycleWeapon(dir) {
  const wc = ensureWeaponCfg();
  const list = allWeapons();
  if (wc.id == null) {
    wc.id = (list.length && (dir > 0 ? list[0].id : list[list.length - 1].id)) || null;
  } else {
    const idx = list.findIndex(w => w.id === wc.id);
    if (idx < 0) wc.id = list[0].id;
    else {
      const ni = idx + dir;
      wc.id = (ni < 0 || ni >= list.length) ? null : list[ni].id;
    }
  }
  refreshMax();
}

function updateAnchor(anchorId, sx, sy) {
  const wd = weaponDefForSide();
  if (!wd) return;
  const sp = { x: round3(sx), y: round3(sy) };
  const patch = { anchors: { ...wd.anchors } };
  if (anchorId === 'grip') patch.anchors.grip = sp;
  else if (anchorId === 'tip') patch.anchors.tip = sp;
  else if (anchorId === 'center') patch.anchors.center = sp;
  else if (anchorId === 'pivot') { patch.pivot = sp; addWeapon({ ...wd, ...patch }); return; }
  else {
    const i = parseInt(anchorId.split(':')[1], 10);
    patch.anchors.custom = (wd.anchors.custom || []).map((c, j) => j === i ? sp : c);
    if (!patch.anchors.custom[i]) patch.anchors.custom.push(sp);
  }
  addWeapon({ ...wd, ...patch });
}

function setTrackEase(ease) {
  const tr = getTrack(S.anim, S.trackSelect);
  if (tr && S.keySelect) {
    const k = exactKey(tr, S.keySelect.frame);
    if (k) k.e = ease;
  }
}

// ── keyboard ───────────────────────────────────────────────────────────────
function onEditorKey(e) {
  if (!S.open) return;
  const k = e.code;
  const ctrl = e.ctrlKey || e.metaKey;

  if ((ctrl) && k === 'KeyZ') {
    e.preventDefault();
    if (e.shiftKey) redo(); else undo();
    return;
  }
  if (ctrl && k === 'KeyY') { e.preventDefault(); redo(); return; }
  if (ctrl && k === 'KeyS') { e.preventDefault(); handleEditAction('anim-save'); return; }
  if (ctrl && k === 'KeyC') { e.preventDefault(); copyKey(); return; }
  if (ctrl && k === 'KeyV') { e.preventDefault(); pushUndo(); pasteKey(); return; }
  if (ctrl && k === 'KeyN') { e.preventDefault(); handleEditAction('anim-new'); return; }

  if (modalActive()) return; // let the modal input take over (its own handler)

  if (k === 'Space') {
    e.preventDefault();
    handleEditAction('tl-play');
    return;
  }
  if (k === 'ArrowLeft' || k === 'ArrowRight') {
    e.preventDefault();
    const step = e.shiftKey ? 10 : 1;
    setFrame(S.frame + (k === 'ArrowLeft' ? -step : step));
    return;
  }
  if (k === 'Home') { setFrame(0); return; }
  if (k === 'End') { setFrame(S.displayMax); return; }
  if (k === 'KeyK') { pushUndo(); keyTrack(); return; }
  if (k === 'Delete' || k === 'Backspace') {
    e.preventDefault();
    const hadKey = !!(S.keySelect || (S.selKeys && S.selKeys.size));
    const vfx = ensureAnimVfx();
    const hadVfx = !!vfx.length && vfx[S.vfxIdx] != null;
    if (!hadKey && !hadVfx) return;
    pushUndo();
    if (hadKey) delSelectedKey();
    else delSelectedVfx();
    return;
  }
  if (k === 'KeyG') { S.showGrid = !S.showGrid; return; }
  if (k === 'KeyS') { S.snap = !S.snap; return; }
  if (k === 'KeyA') { S.showAnchors = !S.showAnchors; return; }
  if (k === 'KeyP') { S.showPivot = !S.showPivot; return; }
  if (k === 'KeyD') { S.debug = !S.debug; return; }
  if (k === 'KeyM') {
    if (S.objType === 'weapon' && S.anim.weapons && S.anim.weapons[S.side]) {
      pushUndo();
      S.anim.weapons[S.side].mirror = !S.anim.weapons[S.side].mirror;
    }
    return;
  }
  if (k === 'KeyE') { S.objType = S.objType === 'hand' ? 'weapon' : 'hand'; return; }
  if (k === 'Digit1') { S.objType = 'hand'; S.side = 'right'; return; }
  if (k === 'Digit2') { S.objType = 'weapon'; S.side = 'right'; return; }
  if (k === 'Digit3') { S.objType = 'hand'; S.side = 'left'; return; }
  if (k === 'Digit4') { S.objType = 'weapon'; S.side = 'left'; return; }
  if (k === 'BracketLeft') { cycleAnimSelect(-1); return; }
  if (k === 'BracketRight') { cycleAnimSelect(1); return; }
  if (k === 'Escape') {
    if (modalActive()) { cancelModal(); return; }
    if (onCloseEditor) onCloseEditor();
    return;
  }
}

function cycleAnimSelect(dir) {
  // Filter animations by the currently selected character
  const def = S.subjectDef ? S.subjectDef() : null;
  const charId = def && def.id ? def.id : 'cowboy';
  const allowedIds = getCharacterAnimationIds(charId, attacksFor);
  const lib = listAnimations().filter(a => allowedIds.includes(a.id));
  if (!lib.length) return;
  let idx = lib.findIndex(a => a.id === S.animId);
  idx = (idx + dir + lib.length) % lib.length;
  pushUndo();
  loadAnimById(lib[idx].id);
}

// ── action dispatch ────────────────────────────────────────────────────────
// Shared step logic for all +/- buttons, used both by single clicks and by
// the hold-to-increment timer. Does NOT push an undo snapshot — callers must
// do that once per gesture.
function executeStep(id) {
  if (id.startsWith('weap-') && (id.endsWith('-m') || id.endsWith('-p'))) {
    const tail = id.slice(5);
    const key = tail.replace(/-(m|p)$/, '');
    const op = tail.endsWith('-m') ? -1 : 1;
    setRowValue('weap', key, rowCurrent('weap', key) + op * rowStep(key));
    return;
  }
  if (id.startsWith('vfx-')) {
    const tail = id.slice(4);
    const key = tail.replace(/-(m|p)$/, '');
    const op = tail.endsWith('-m') ? -1 : tail.endsWith('-p') ? 1 : 0;
    if (!op) return;
    setRowValue('vfx', key, rowCurrent('vfx', key) + op * rowStep(key));
    return;
  }
  if (id.startsWith('anc-')) {
    const rest = id.slice(4);
    const anchorId = rest.slice(0, -2);
    const op = rest.endsWith('-p') ? 1 : -1;
    const wd = weaponDefForSide();
    if (!wd) return;
    let p;
    if (anchorId === 'pivot') p = wd.pivot;
    else p = wd.anchors[anchorId];
    if (!p) return;
    updateAnchor(anchorId, p.x + op, p.y);
    return;
  }
  if (id.startsWith('prop-')) {
    const tail = id.slice(5);
    if (tail.endsWith('-m')) { stepProp(tail.slice(0, -2), -1); return; }
    if (tail.endsWith('-p')) { stepProp(tail.slice(0, -2), 1); return; }
  }
}

// True for any numeric +/- button id that should support hold-to-increment.
function isStepButton(id) {
  if (!id) return false;
  if (id.startsWith('prop-') && (id.endsWith('-m') || id.endsWith('-p'))) return true;
  if (id.startsWith('weap-') && (id.endsWith('-m') || id.endsWith('-p'))) return true;
  if (id.startsWith('vfx-') && (id.endsWith('-m') || id.endsWith('-p'))) return true;
  if (id.startsWith('anc-') && (id.endsWith('-m') || id.endsWith('-p'))) return true;
  return false;
}

// Hold-to-increment state. One step fires immediately on press, then after an
// initial delay, repeating faster until release.
let _stepTimer = null;
let _stepDelay = 0;
function startStepHold(id) {
  clearStepHold();
  _stepDelay = 400;
  _stepTimer = setTimeout(() => _tickStepHold(id), _stepDelay);
}
function _tickStepHold(id) {
  executeStep(id);
  _stepDelay = Math.max(40, _stepDelay * 0.75);
  _stepTimer = setTimeout(() => _tickStepHold(id), _stepDelay);
}
function clearStepHold() {
  if (_stepTimer) { clearTimeout(_stepTimer); _stepTimer = null; }
}

function handleEditAction(id) {
  if (!id) return;

  if (id === 'undo') { undo(); return; }
  if (id === 'redo') { redo(); return; }
  if (id === 'advanced') { S.advanced = !S.advanced; return; }
  if (id === 'grid') { S.showGrid = !S.showGrid; return; }
  if (id === 'snap') { S.snap = !S.snap; return; }
  if (id === 'anchors') { S.showAnchors = !S.showAnchors; return; }
  if (id === 'pivot') { S.showPivot = !S.showPivot; return; }
  if (id === 'reset') { cam.x = 0; cam.y = 0; cam.zoom = 2.2; return; }
  if (id === 'zoom-in') { cam.zoom = clamp(cam.zoom * 1.2, 0.3, 8); return; }
  if (id === 'zoom-out') { cam.zoom = clamp(cam.zoom / 1.2, 0.3, 8); return; }
  if (id === 'fps-m') { S.fps = clamp(S.fps - 5, 1, 120); S.anim.fps = S.fps; return; }
  if (id === 'fps-p') { S.fps = clamp(S.fps + 5, 1, 120); S.anim.fps = S.fps; return; }
  if (id === 'speed-m') { S.speed = round3(clamp(S.speed - 0.5, 0.2, 4)); return; }
  if (id === 'speed-p') { S.speed = round3(clamp(S.speed + 0.5, 0.2, 4)); return; }
  if (id === 'loop-toggle') { S.loop = !S.loop; S.anim.loop = S.loop; return; }

  if (id === 'char-prev') { charCycle(-1); return; }
  if (id === 'char-next') { charCycle(1); return; }
  if (id === 'char-open') { charCycle(1); return; }

  if (id === 'mirror-toggle') { S.mirror = !S.mirror; return; }
  if (id === 'anim-prev') { animNav(-1); return; }
  if (id === 'anim-next') { animNav(1); return; }
  if (id === 'menu:anim') {
    // Filter animations by the currently selected character
    const def = S.subjectDef ? S.subjectDef() : null;
    const charId = def && def.id ? def.id : 'cowboy';
    const allowedIds = getCharacterAnimationIds(charId, attacksFor);
    const lib = listAnimations().filter(a => allowedIds.includes(a.id));
    const op = S.menuRects['anim'];
    openMenu('anim', lib.map(a => ({ label: a.name, value: a.id })), op, v => {
      pushUndo();
      loadAnimById(v);
    });
    return;
  }
  if (id.startsWith('menu:wpn-')) {
    const side = id.slice('menu:wpn-'.length);
    const op = S.menuRects['wpn-' + side];
    openMenu('wpn-' + side,
      [{ label: '— none —', value: null }, ...allWeapons().map(w => ({ label: w.name, value: w.id }))],
      op, v => {
        pushUndo();
        const wc = ensureWeaponCfgSide(side);
        wc.id = v;
        if (S.side !== side) { /* keep selected side untouched */ }
        refreshMax();
      });
    return;
  }
  if (id === 'menu:combat-type') {
    const op = S.menuRects['combat-type'];
    openMenu('combat-type', [
      { label: 'None', value: 'none' },
      { label: 'Ability', value: 'nonHitbox' },
    ], op, v => {
      pushUndo();
      const c = ensureAnimCombat();
      if (v === 'none') S.anim.combat = null;
      else {
        c.type = v;
        if (v === 'nonHitbox' && !c.abilityId) {
          const first = listAbilities()[0];
          if (first) c.abilityId = first.id;
        }
        if (v === 'nonHitbox' && !c.cfg) c.cfg = {};
      }
      S.dirty = true;
    });
    return;
  }
  if (id === 'menu:combat-ability') {
    const op = S.menuRects['combat-ability'];
    const items = listAbilities().map(a => ({ label: a.name, value: a.id }));
    openMenu('combat-ability', items, op, v => {
      pushUndo();
      const c = ensureAnimCombat();
      c.type = 'nonHitbox';
      c.abilityId = v;
      if (!c.cfg) c.cfg = {};
      S.dirty = true;
    });
    return;
  }
  if (id === 'menu:vfx-effect') {
    const op = S.menuRects['vfx-effect'];
    openMenu('vfx-effect', listVfxEffects().map(e => ({ label: e.name, value: e.id })), op, v => {
      pushUndo();
      const arr = ensureAnimVfx();
      const item = arr[S.vfxIdx];
      if (item) { item.effect = v; S.dirty = true; }
    });
    return;
  }
  if (id === 'menu:vfx-anchor') {
    const op = S.menuRects['vfx-anchor'];
    openMenu('vfx-anchor', listVfxAnchors().map(a => ({ label: a.name, value: a.id })), op, v => {
      pushUndo();
      const arr = ensureAnimVfx();
      const item = arr[S.vfxIdx];
      if (item) { item.anchor = v; S.dirty = true; }
    });
    return;
  }
  if (id.startsWith('menu-pop:')) { handlePopupSelect(parseInt(id.slice(9), 10)); return; }

  if (id === 'tl-rewind') { setFrame(0); return; }
  if (id === 'tl-end') { setFrame(S.displayMax); return; }
  if (id === 'tl-prevkey') { const f = prevKeyFrame(); if (f != null) setFrame(f); return; }
  if (id === 'tl-nextkey') { const f = nextKeyFrame(); if (f != null) setFrame(f); return; }
  if (id === 'tl-play') {
    S.playing = !S.playing;
    if (S.playing) {
      const A = S.subject.anim;
      A.anim = S.anim;
      A.animId = S.animId;
      A.loop = S.loop;
      A.fps = S.fps;
      A.speed = S.speed;
      A.playing = true;
      A.paused = false;
      A.scrubbing = false;
      A.maxFrame = S.displayMax - 10;
    } else if (S.subject.anim) {
      S.subject.anim.playing = false;
      S.subject.anim.scrubbing = true;
      sampleAnimator(S.subject);
    }
    return;
  }
  if (id === 'tl-stop') { S.playing = false; if (S.subject.anim) { S.subject.anim.playing = false; S.subject.anim.scrubbing = true; } setFrame(0); return; }
  if (id === 'tl-key') { pushUndo(); keyTrack(); return; }
  if (id === 'tl-deldim') { pushUndo(); delSelectedKey(); return; }
  if (id === 'tl-copy') { copyKey(); return; }
  if (id === 'tl-paste') { pushUndo(); pasteKey(); return; }
  if (id === 'tl-shift-l') { pushUndo(); S.anim = shiftAnimationTiming(S.anim, -10); refreshMax(); resetSubjectAnim(); return; }
  if (id === 'tl-shift-r') { pushUndo(); S.anim = shiftAnimationTiming(S.anim, 10); refreshMax(); resetSubjectAnim(); return; }
  if (id === 'tl-rev') { pushUndo(); S.anim = reverseAnimation(S.anim, animationFrameCount(S.anim)); refreshMax(); resetSubjectAnim(); return; }
  if (id === 'tl-flip') { pushUndo(); S.anim = flipAnimationH(S.anim, weaponPivotX); refreshMax(); resetSubjectAnim(); return; }
  if (id === 'tl-mirror') {
    if (S.anim.weapons && S.anim.weapons[S.side]) {
      pushUndo();
      S.anim.weapons[S.side].mirror = !S.anim.weapons[S.side].mirror;
    }
    return;
  }
  if (id === 'tl-guides') { S.showGrid = !S.showGrid; return; }
  if (id === 'tl-debug') { S.debug = !S.debug; return; }
  if (id === 'tl-close') { if (onCloseEditor) onCloseEditor(); return; }

  if (id === 'anim-new') {
    askText('New animation id', 'new-anim', idv => {
      if (!idv) return;
      pushUndo();
      setAnim(createAnimation(idv, idv), idv);
    });
    return;
  }
  if (id === 'anim-save') {
    S.anim.fps = S.fps;
    S.anim.loop = S.loop;
    saveAnimation(S.anim);
    S.dirty = false;
    return;
  }
  if (id === 'anim-dup') {
    pushUndo();
    const cp = duplicateAnimationInLibrary(S.animId, S.animId + '-copy');
    if (cp) setAnim(cp, cp.id);
    return;
  }
  if (id === 'anim-del') {
    pushUndo();
    deleteAnimation(S.animId);
    // Filter remaining animations by current character
    const def = S.subjectDef ? S.subjectDef() : null;
    const charId = def && def.id ? def.id : 'cowboy';
    const allowedIds = getCharacterAnimationIds(charId, attacksFor);
    const rest = listAnimations().filter(a => allowedIds.includes(a.id));
    const next = rest[0] ? rest[0].id : null;
    if (next) loadAnimById(next); else setAnim(createAnimation('base', 'Base'), 'base');
    return;
  }
  if (id === 'anim-ren') {
    askText('Rename animation', (S.anim && S.anim.name) || S.animId, nm => {
      if (!nm) return;
      pushUndo();
      renameAnimation(S.animId, nm);
      S.anim.name = nm;
    });
    return;
  }
  if (id === 'anim-export') {
    showModal('Exported animation JSON (copy to save as file)',
      S.animId ? exportAnimation(S.animId) || '' : '',
      () => {}, 'CLOSE', 'CANCEL', false);
    return;
  }
  if (id === 'anim-import') {
    showModal('Import animation JSON', '', (txt) => {
      const ids = importAnimationsJSON(txt);
      refreshMax();
      if (ids.length && ids[0]) { pushUndo(); loadAnimById(ids[0]); }
    }, 'IMPORT', 'CANCEL', false);
    return;
  }
  if (id === 'wpn-new') {
    const cur = weaponDefForSide();
    const base = cur || allWeapons()[0];
    if (base) {
      const copy = JSON.parse(JSON.stringify(base));
      copy.id = `wpn-${Date.now()}`;
      copy.name = base.name + ' Copy';
      addWeapon(copy);
      ensureWeaponCfg().id = copy.id;
      refreshMax();
    }
    return;
  }
  if (id === 'wpn-export') {
    showModal('Exported weapons JSON (copy to save as file)',
      weaponsToJSON(), () => {}, 'CLOSE', 'CANCEL', false);
    return;
  }
  if (id === 'wpn-import') {
    showModal('Import weapons JSON', '', (txt) => {
      try { importWeaponsJSON(txt); refreshMax(); } catch (err) { /* ignore */ }
    }, 'IMPORT', 'CANCEL', false);
    return;
  }
  if (id === 'obj-hand') { S.objType = 'hand'; return; }
  if (id === 'obj-weapon') { S.objType = 'weapon'; return; }
  if (id === 'obj-side-l') { S.side = S.side === 'left' ? 'right' : 'left'; return; }
  if (id === 'obj-side-r') { S.side = S.side === 'left' ? 'right' : 'left'; return; }
  if (id.startsWith('edit-anch-')) {
    const anchorId = id.slice('edit-anch-'.length);
    const wd = weaponDefForSide();
    if (!wd) return;
    const p = anchorId === 'pivot' ? wd.pivot : (wd.anchors[anchorId] || { x: 0, y: 0 });
    pushUndo();
    showModal('Set anchor (x , y)', `${p.x}, ${p.y}`, v => {
      const parts = String(v).split(/[,\s]+/).map(Number);
      if (parts.length >= 2 && isFinite(parts[0]) && isFinite(parts[1])) {
        updateAnchor(anchorId, parts[0], parts[1]);
      }
    }, 'SET', 'CANCEL', false);
    return;
  }
  if (id === 'edit-fps') {
    showModal('FPS', String(S.fps), v => {
      const n = Number(v);
      if (!isFinite(n)) return;
      S.fps = clamp(Math.round(n), 1, 120);
      S.anim.fps = S.fps;
    }, 'SET', 'CANCEL', true);
    return;
  }
  if (id === 'edit-blend') {
    showModal('Blend in (frames)', String(S.anim.blendIn ?? 0), v => {
      const n = Number(v);
      if (!isFinite(n)) return;
      S.anim.blendIn = n;
    }, 'SET', 'CANCEL', true);
    return;
  }
  if (id === 'weap-prev') { pushUndo(); cycleWeapon(-1); return; }
  if (id === 'weap-next') { pushUndo(); cycleWeapon(1); return; }
  if (id === 'weap-name-drag') { S.drag = { type: 'cycle-weapon', dir: 1 }; return; }
  if (id.startsWith('weap-mirror-')) {
    const side = id.slice('weap-mirror-'.length);
    pushUndo();
    const wc = ensureWeaponCfg(side);
    wc.mirror = !wc.mirror;
    refreshMax();
    return;
  }

  if (id === 'vfx-add') {
    pushUndo();
    const arr = ensureAnimVfx();
    arr.push({
      effect: 'bullet', anchor: 'weapon',
      startFrame: clamp(Math.floor(S.frame), 0, Math.max(0, S.displayMax)),
      duration: 8, scale: 1, rotation: 0, offsetX: 0, offsetY: 0, loop: false,
    });
    S.vfxIdx = arr.length - 1;
    S.dirty = true;
    return;
  }
  if (id === 'vfx-del') {
    const arr = ensureAnimVfx();
    if (!arr.length) return;
    pushUndo();
    arr.splice(S.vfxIdx, 1);
    S.vfxIdx = clamp(S.vfxIdx, 0, Math.max(0, arr.length - 1));
    if (S.vfxIdx > 0 && !arr.length) S.vfxIdx = 0;
    S.dirty = true;
    return;
  }
  if (id === 'vfx-prev') {
    const arr = ensureAnimVfx();
    if (arr.length > 1) S.vfxIdx = (S.vfxIdx - 1 + arr.length) % arr.length;
    return;
  }
  if (id === 'vfx-next') {
    const arr = ensureAnimVfx();
    if (arr.length > 1) S.vfxIdx = (S.vfxIdx + 1) % arr.length;
    return;
  }
  if (id === 'vfx-loop') {
    const arr = ensureAnimVfx();
    const item = arr[S.vfxIdx];
    if (!item) return;
    pushUndo();
    item.loop = !item.loop;
    S.dirty = true;
    return;
  }
  if (id.startsWith('weap-') && (id.endsWith('-m') || id.endsWith('-p'))) {
    pushUndo();
    executeStep(id);
    return;
  }
  if (id.startsWith('vfx-')) {
    const op = id.endsWith('-m') ? -1 : id.endsWith('-p') ? 1 : 0;
    if (!op) return;
    pushUndo();
    executeStep(id);
    return;
  }

  if (id.startsWith('anc-')) {
    pushUndo();
    executeStep(id);
    return;
  }

  if (id.endsWith('-key') && id.startsWith('prop-')) {
    pushUndo();
    nudgeTrackCreate(id.slice(5, -4));
    return;
  }
  if (id.startsWith('prop-')) {
    const tail = id.slice(5);
    if (tail.endsWith('-m')) { pushUndo(); stepProp(tail.slice(0, -2), -1); }
    else if (tail.endsWith('-p')) { pushUndo(); stepProp(tail.slice(0, -2), 1); }
    else if (tail.endsWith('-key')) { pushUndo(); nudgeTrackCreate(tail.slice(0, -4)); }
    else if (tail.endsWith('-drag')) { /* handled at down */ }
    return;
  }
  if (id.startsWith('ease-')) { pushUndo(); setTrackEase(id.slice(5)); return; }
  if (id === 'tl-collapse') { S.tlCollapsed = true; persistTlUi(); return; }
  if (id === 'tl-expand')  { S.tlCollapsed = false; persistTlUi(); return; }
  if (id.startsWith('obj-toggle-')) {
    const oid = id.slice('obj-toggle-'.length);
    S.objOpen[oid] = !S.objOpen[oid];
    persistTlUi();
    return;
  }
  if (id.startsWith('obj-')) {
    const parts = id.split('-');
    if (parts.length === 3 && (parts[1] === 'hands' || parts[1] === 'weapons')) {
      S.objType = parts[1] === 'hands' ? 'hand' : 'weapon';
      S.side = parts[2];
      // expand the matched track group so the user sees the keys they just jumped to
      const oid = { 'hands.right':'rh', 'hands.left':'lh', 'weapons.right':'rw', 'weapons.left':'lw' }[`${parts[1]}.${parts[2]}`];
      if (oid) { S.objOpen[oid] = true; persistTlUi(); }
    }
    return;
  }
  if (id.startsWith('tr-') && !id.startsWith('trv-')) {
    S.trackSelect = id.slice(3);
    S.keySelect = null;
    return;
  }
  if (id.startsWith('kf-')) {
    // selection already handled on pointer-down; nothing else needed
    return;
  }
}

function charCycle(dir) {
  const n = ALL_FIGHTERS.length;
  const cur = (S.subjectDef && S.subjectDef()) || null;
  const idx = cur ? ALL_FIGHTERS.findIndex(f => f.id === cur.id) : 0;
  const next = (idx + dir + n) % n;
  const def = ALL_FIGHTERS[next];
  // remember which animation we were on, then swap characters
  if (cur) S.perCharAnim[cur.id] = S.animId;
  S.subject = createEditorSubject({ ...def });
  S.subjectDef = () => ({ ...def });
  // restore this character's remembered animation (fall back to the current one)
  // but only if the remembered animation is valid for this character
  const charId = def.id;
  const allowedIds = getCharacterAnimationIds(charId, attacksFor);
  const remembered = S.perCharAnim[charId];
  if (remembered && getAnimation(remembered) && allowedIds.includes(remembered)) {
    S.anim = getAnimation(remembered);
    S.animId = remembered;
    refreshMax();
  } else if (remembered && getAnimation(remembered) && !allowedIds.includes(remembered)) {
    // remembered animation is not valid for this character, use first allowed
    const lib = listAnimations().filter(a => allowedIds.includes(a.id));
    const firstEntry = lib[0];
    const firstAnim = firstEntry ? getAnimation(firstEntry.id) : null;
    S.anim = firstAnim || createAnimation('new-anim', 'New Animation');
    S.animId = S.anim.id;
    refreshMax();
  }
  resetSubjectAnim();
}

function animNav(dir) {
  // Filter animations by the currently selected character
  const def = S.subjectDef ? S.subjectDef() : null;
  const charId = def && def.id ? def.id : 'cowboy';
  const allowedIds = getCharacterAnimationIds(charId, attacksFor);
  const lib = listAnimations().filter(a => allowedIds.includes(a.id));
  if (!lib.length) return;
  let idx = lib.findIndex(a => a.id === S.animId);
  if (lib[idx]) {
    const idv = lib[(idx + dir + lib.length) % lib.length].id;
    pushUndo();
    loadAnimById(idv);
  }
}

function nudgeTrackCreate(prop) {
  const tr = ensureTrack(S.anim, pathFor(prop));
  const k = pushKey(prop);
  selectKey(pathFor(prop), k.f, false);
  refreshMax();
}

// ── text/number modal ────────────────────────────────────────────────────
// Shared with the Hitbox Customizer (modal.js): one handler pair on the shared
// #anim-modal DOM, detached every open, so the two editors can never collide.
function askText(title, initial, onOk) { showModal(title, initial, onOk); }

let onCloseEditor = null;
export function setEditorCloseHandler(fn) { onCloseEditor = fn; }

// keep lint/runtime from GC-ing rarely referenced helpers


// ── merged from anim/hitboxCustomizer.js ──
// hitboxCustomizer.js — the Hitbox Customizer, a standalone canvas section
// that edits the REAL runtime hitbox data for a character + move. Everything
// it writes goes through hitboxData.js into the per-character/per-move store,
// which combat.resolveAnimDef reads at every attack start — so a saved box
// overrides the DEFAULT_ATTACKS fallback in the actual game. There is no
// separate preview-only database.


const HITBOX_FILL = '#ff3c3c';
const HITBOX_SEL  = 'rgba(255,100,100,0.9)';

let HC_VPW = 1200, HC_VPH = 820;
let hcDpr = 1;
const HC_PANEL_W = 300;

const hcCam = { x: 0, y: 0, zoom: 2.2 };


const MOVES = [
  { id: 'jab',        label: 'NEUTRAL LIGHT · JAB' },
  { id: 'ftilt',      label: 'FORWARD LIGHT · FTILT' },
  { id: 'utilt',      label: 'UP LIGHT · UTILT' },
  { id: 'dtilt',      label: 'DOWN LIGHT · DTILT' },
  { id: 'nsmash',     label: 'NEUTRAL HEAVY · NSMASH' },
  { id: 'fsmash',     label: 'SIDE SMASH · FSMASH' },
  { id: 'usmash',     label: 'UP HEAVY · USMASH' },
  { id: 'dsmash',     label: 'DOWN HEAVY · DSMASH' },
  { id: 'aerialLight', label: 'AERIAL LIGHT' },
  { id: 'aerialHeavy', label: 'AERIAL HEAVY' },
  { id: 'dash',       label: 'DASH' },
];

const HC_FIELD_LABEL = {
  frame: 'FRAME',
  w: 'W', h: 'H', ox: 'OX', oy: 'OY',
  startFrame: 'START', duration: 'DUR', range: 'RANGE', end: 'END',
  dmg: 'DMG', kbBase: 'KB', kbGrowth: 'GROW', angle: 'ANGLE',
  recoveryX: 'REC.X', recoveryY: 'REC.Y', recoveryDuration: 'REC.DUR',
};

const ROW_STEP = {
  frame: 1,
  w: 2, h: 2, ox: 2, oy: 2, range: 2,
  startFrame: 1, duration: 1, end: 1,
  dmg: 0.5, kbBase: 5, kbGrowth: 0.05, angle: 5,
  recoveryX: 1, recoveryY: 1, recoveryDuration: 1,
};

const INT_KEYS = ['startFrame', 'duration', 'end', 'recoveryDuration'];

// Attacker recovery is attack-level, not per-hitbox: these keys always read and
// write box 0 (mergeHitboxDef takes recovery from the first stored box), no
// matter which hitbox is currently selected.
const RECOVERY_KEYS = ['recoveryX', 'recoveryY', 'recoveryDuration'];

const HC = {
  open: false,
  canvas: null,
  ctx: null,
  subject: null,
  fighterIdx: 0,
  animId: null,
  def: null,
  boxes: [],
  sel: -1,
  timeNow: 0,
  hits: [],
  hover: null,
  lastPointer: { x: 0, y: 0 },
  drag: null,
  snap: true,
  showGrid: true,
  savedAt: 0,
  vp: { x: 0, y: 0, w: 0, h: 0 },
  previewFrame: 0,     // preview pose + hitbox-active state
  previewMax: 24,      // loop window end (recomputed per move)
  autoScrub: true,     // auto-advance the preview frame
  scrubDrag: null,     // dragging the timeline ruler
};

export function boxesFromDef(def) {
  const list = hitboxList(def);
  if (!list.length) return [];
  return list.filter(Boolean).map(hb => ({
    w: hb.w || 0,
    h: hb.h || 0,
    ox: hb.ox != null ? hb.ox : 0,
    oy: hb.oy != null ? hb.oy : 0,
    startFrame: hb.startFrame != null ? hb.startFrame : ((def && def.startup != null) ? def.startup : 0),
    duration: Math.max(1, hb.duration != null ? hb.duration : ((def && def.active != null) ? def.active : 4)),
    dmg: hb.dmg != null ? hb.dmg : ((def && def.dmg != null) ? def.dmg : 0),
    kbBase: hb.kbBase != null ? hb.kbBase : ((def && def.kbBase != null) ? def.kbBase : 0),
    kbGrowth: hb.kbGrowth != null ? hb.kbGrowth : ((def && def.kbGrowth != null) ? def.kbGrowth : 0),
    angle: hb.angle != null ? hb.angle : ((def && def.angle != null) ? def.angle : 0),
    // Attack recovery (attack-level) surfaces from the base def so the panel
    // shows the real in-game values even before anything is customized.
    recoveryX: hb.recoveryX != null ? hb.recoveryX : ((def && def.recoveryX != null) ? def.recoveryX : 0),
    recoveryY: hb.recoveryY != null ? hb.recoveryY : ((def && def.recoveryY != null) ? def.recoveryY : 0),
    recoveryDuration: hb.recoveryDuration != null ? hb.recoveryDuration : ((def && def.recoveryDuration != null) ? def.recoveryDuration : 0),
  }));
}

function effectiveDef(fighter, animId) {
  if (!animId || !fighter) return null;
  // Prefer the per-ATTACK definition (up/back/down variants each own their own
  // box + store key); fall back to pure animation lookups for edge cases.
  const byAttack = resolveAttackDef(animId, fighter);
  if (byAttack) return byAttack;
  const anim = getAnimationRaw(animId);
  const d = anim ? resolveAnimDef(anim, fighter) : null;
  if (d) return d;
  return getAttackDefForAnimId(animId, fighter) || null;
}

export function setCustomizerFighter(idx) {
  HC.fighterIdx = (idx + ALL_FIGHTERS.length) % ALL_FIGHTERS.length;
  HC.subject = createEditorSubject({ ...ALL_FIGHTERS[HC.fighterIdx] });
  if (HC.animId) loadMove(HC.animId);
}

export function setCustomizerMove(animId) {
  HC.animId = animId;
  loadMove(animId);
}

function loadMove(animId) {
  HC.animId = animId;
  HC.def = effectiveDef(HC.subject, animId);
  HC.boxes = boxesFromDef(HC.def);
  HC.sel = HC.boxes.length ? 0 : -1;
  HC.drag = null;
  HC.scrubDrag = null;
  HC.hits = [];
  refreshPreviewWindow();
  if (HC.sel >= 0) snapPreviewToBox(HC.sel);
  else HC.previewFrame = 0;
}

function boxEndFrame(b) {
  return Math.ceil((b.startFrame || 0) + Math.max(1, b.duration || 4));
}

function refreshPreviewWindow() {
  let max = 24;
  for (const b of HC.boxes) max = Math.max(max, boxEndFrame(b));
  HC.previewMax = max;
}

function snapPreviewToBox(i) {
  const b = HC.boxes[i];
  if (!b || HC.scrubDrag) return;
  const s = b.startFrame || 0;
  const e = boxEndFrame(b);
  if (HC.previewFrame < s) HC.previewFrame = s;
  else if (HC.previewFrame >= e) HC.previewFrame = s + Math.max(0, (e - s - 1) * 0.25);
}

function selectBox(i) {
  HC.sel = clamp(i, 0, Math.max(0, HC.boxes.length - 1));
  if (HC.sel >= 0) snapPreviewToBox(HC.sel);
}

function setPreviewFrame(v) {
  const n = Number(v);
  if (!isFinite(n)) return;
  HC.previewFrame = clamp(Math.round(n * 10) / 10, 0, Math.max(24, HC.previewMax));
  HC.autoScrub = false;
}

function scrubPos() {
  const r = HC.vp;
  return { x: r.x + 16, w: r.w - 32, max: Math.max(24, HC.previewMax) };
}

function setPreviewFrameFromX(x) {
  const s = scrubPos();
  setPreviewFrame(s.w > 0 ? ((x - s.x) / s.w) * s.max : 0);
}

export function getWorkingBoxes() {
  return HC.boxes.map(b => ({ ...b }));
}

export function workingBoxValue(i, key) {
  if (key === 'frame') return round3(HC.previewFrame);
  const b = HC.boxes[RECOVERY_KEYS.includes(key) ? 0 : i];
  if (!b) return 0;
  if (key === 'range') return round3((b.ox || 0) + (b.w || 0) / 2);
  if (key === 'end') return Math.round((b.startFrame || 0) + Math.max(1, b.duration || 4));
  return b[key] != null ? b[key] : 0;
}

export function setWorkingBoxValue(i, key, v) {
  if (key === 'frame') { setPreviewFrame(v); return; }
  const b = HC.boxes[RECOVERY_KEYS.includes(key) ? 0 : i];
  if (!b) return;
  const nv = INT_KEYS.includes(key) ? Math.round(v) : round3(v);
  if (key === 'range') b.ox = round3(nv - (b.w || 0) / 2);
  else if (key === 'end') b.duration = Math.max(1, Math.round(nv - (b.startFrame || 0)));
  else {
    b[key] = nv;
    if (key === 'duration') b[key] = Math.max(1, b[key]);
  }
  if (key === 'startFrame' || key === 'duration' || key === 'end') {
    refreshPreviewWindow();
    snapPreviewToBox(i);
  }
}

export function customizerResizeRect(i, wx, wy, handle) {
  const hb = HC.boxes[i];
  if (!hb) return null;
  const base = { x: HC.subject.x, y: HC.subject.y };
  const cx = base.x + (hb.ox || 0);
  const cy = base.y + (hb.oy || 0);
  let left = cx - (hb.w || 0) / 2, right = cx + (hb.w || 0) / 2;
  let top = cy - (hb.h || 0) / 2, bottom = cy + (hb.h || 0) / 2;
  if (handle.includes('w')) left = wx;
  if (handle.includes('e')) right = wx;
  if (handle.includes('n')) top = wy;
  if (handle.includes('s')) bottom = wy;
  if (right - left < 2) right = left + 2;
  if (bottom - top < 2) bottom = top + 2;
  const w = Math.max(2, right - left);
  const h = Math.max(2, bottom - top);
  let ox = left + w / 2 - base.x;
  let oy = top + h / 2 - base.y;
  if (HC.snap) { ox = snapVal(ox); oy = snapVal(oy); }
  return { w: Math.round(w), h: Math.round(h), ox: round3(ox), oy: round3(oy) };
}

export function saveCustomizer() {
  if (!HC.subject || !HC.animId) return false;
  const charId = HC.subject._fighterDef.id;
  setCustomHitboxes(charId, HC.animId, HC.boxes.map(b => ({ ...b })));
  HC.def = effectiveDef(HC.subject, HC.animId);
  HC.savedAt = performance.now();
  return true;
}

export function resetCustomizerMove() {
  if (!HC.subject || !HC.animId) return;
  clearCustomHitboxes(HC.subject._fighterDef.id, HC.animId);
  loadMove(HC.animId);
}

export function addCustomizerBox() {
  const seed = boxesFromDef(HC.def);
  const proto = seed[0] || { w: 40, h: 30, ox: 40, oy: 0, startFrame: 0, duration: 4, dmg: 5, kbBase: 130, kbGrowth: 1, angle: 30 };
  HC.boxes.push({ ...proto });
  HC.sel = HC.boxes.length - 1;
  refreshPreviewWindow();
  snapPreviewToBox(HC.sel);
}

let onClose = null;
export function setHitboxCustomizerCloseHandler(fn) { onClose = fn; }

function hcCaptureCanvasStyle() {
  HC._savedStyle = {
    w: HC.canvas.width, h: HC.canvas.height,
    sw: HC.canvas.style.width, sh: HC.canvas.style.height,
    pos: HC.canvas.style.position, top: HC.canvas.style.top, left: HC.canvas.style.left,
    tf: HC.canvas.style.transform, border: HC.canvas.style.border,
  };
}

function hcRestoreCanvasStyle() {
  if (!HC.canvas || !HC._savedStyle) return;
  const c = HC.canvas, s = HC._savedStyle;
  c.width = s.w; c.height = s.h;
  c.style.width = s.sw; c.style.height = s.sh;
  c.style.position = s.pos; c.style.top = s.top; c.style.left = s.left;
  c.style.transform = s.tf; c.style.border = s.border;
  try { delete c.dataset.editorTakeover; } catch (_) {}
}

function fitToWindow() {
  if (!HC.canvas) return;
  // Capped like the game's own backing store (see editor.js).
  hcDpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
  const w = window.innerWidth, h = window.innerHeight;
  HC_VPW = w; HC_VPH = h;
  HC.canvas.width = Math.round(w * hcDpr);
  HC.canvas.height = Math.round(h * hcDpr);
  HC.canvas.style.width = w + 'px';
  HC.canvas.style.height = h + 'px';
  HC.canvas.style.position = 'fixed';
  HC.canvas.style.top = '0'; HC.canvas.style.left = '0';
  HC.canvas.style.transform = 'none';
  HC.canvas.style.border = 'none';
  // Takeover flag: main.js must not re-fit the game canvas while the
  // customizer owns it (see editor.js).
  try { HC.canvas.dataset.editorTakeover = '1'; } catch (_) {}
}

let hcOnKey, hcOnDown, hcOnMove, hcOnUp;

export function openHitboxCustomizer(canvas, getFighterDef) {
  HC.canvas = canvas;
  HC.ctx = canvas.getContext('2d');
  hcCaptureCanvasStyle();
  fitToWindow();
  const def = getFighterDef();
  HC.fighterIdx = Math.max(0, ALL_FIGHTERS.findIndex(f => f.id === (def && def.id)));
  HC.subject = createEditorSubject({ ...ALL_FIGHTERS[HC.fighterIdx] });
  hcCam.x = 0; hcCam.y = 0; hcCam.zoom = 2.2;
  HC.sel = -1;
  HC.boxes = [];
  HC.def = null;
  HC.animId = MOVES[0].id;
  loadMove(HC.animId);
  HC.open = true;

  hcOnKey = e => onCustomizerKey(e);
  hcOnDown = e => hcOnPointerDown(e);
  hcOnMove = e => hcOnPointerMove(e);
  hcOnUp = e => hcOnPointerUp(e);

  window.addEventListener('keydown', hcOnKey, true);
  canvas.addEventListener('pointerdown', hcOnDown);
  window.addEventListener('pointermove', hcOnMove);
  window.addEventListener('pointerup', hcOnUp);
  window.addEventListener('resize', fitToWindow);
}

export function closeHitboxCustomizer() {
  if (!HC.open) return;
  if (HC.canvas) HC.canvas.removeEventListener('pointerdown', hcOnDown);
  window.removeEventListener('keydown', hcOnKey, true);
  window.removeEventListener('pointermove', hcOnMove);
  window.removeEventListener('pointerup', hcOnUp);
  window.removeEventListener('resize', fitToWindow);
  hcRestoreCanvasStyle();
  // Re-sync the game canvas size (see closeEditor in editor.js).
  try { window.dispatchEvent(new Event('resize')); } catch (_) {}
  HC.open = false;
  HC.drag = null;
  HC.scrubDrag = null;
  HC.subject = null;
}

export function isHitboxCustomizerOpen() { return HC.open; }

export function updateHitboxCustomizer(dt) {
  if (!HC.open || !HC.subject || !HC.subject.anim) return;
  HC.timeNow += dt;
  if (HC.autoScrub && !HC.scrubDrag && HC.boxes.length) {
    HC.previewFrame = (HC.previewFrame + 4 * dt) % (Math.max(24, HC.previewMax) + 1);
  }
  HC.subject.anim.scrubbing = true;
  HC.subject.anim.frame = HC.previewFrame;
  sampleAnimator(HC.subject);
}

function hcPreviewTime() { return HC.timeNow % 1000; }

function hcWorldToScreen(wx, wy, r) {
  return {
    x: r.x + r.w / 2 + (wx - hcCam.x) * hcCam.zoom,
    y: r.y + r.h / 2 + (wy - hcCam.y) * hcCam.zoom,
  };
}

function hcScreenToWorld(sx, sy, r) {
  return {
    x: (sx - r.x - r.w / 2) / hcCam.zoom + hcCam.x,
    y: (sy - r.y - r.h / 2) / hcCam.zoom + hcCam.y,
  };
}

const HC_TIPS = {};

function hcRegisterHit(id, x, y, w, h) {
  HC.hits.push({ id, x, y, w, h });
}

function hcBtn(label, x, y, w, h, id, opts = {}) {
  const ctx = HC.ctx;
  const hot = opts.hot;
  ctx.fillStyle = hot ? CREAM : BG_RAISE;
  ctx.strokeStyle = hot ? CREAM : LINE;
  ctx.fillRect(x, y, w, h);
  ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
  ctx.fillStyle = hot ? BG : CREAM_MUT;
  ctx.font = `11px ${MONO}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, x + w / 2, y + h / 2 + 1);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  hcRegisterHit(id, x, y, w, h);
}

function chip(ctx, x, y, prevId, label, nextId, tip) {
  hcBtn('◀', x, y, 22, 24, prevId);
  ctx.fillStyle = CREAM;
  ctx.font = `12px ${MONO}`;
  ctx.fillText(label, x + 28, y + 16);
  hcRegisterHit(nextId, x + 28, y, ctx.measureText(label).width + 6, 24);
  HC_TIPS[prevId] = tip; HC_TIPS[nextId] = tip;
  ctx.strokeStyle = LINE;
  ctx.strokeRect(x + 26, y + 3, ctx.measureText(label).width + 10, 18);
  return x + 40 + ctx.measureText(label).width;
}

export function renderHitboxCustomizer() {
  if (!HC.open || !HC.ctx) return;
  // Self-heal against external resizes (see renderEditor in editor.js).
  if (HC.canvas.width !== Math.round(HC_VPW * hcDpr) || HC.canvas.height !== Math.round(HC_VPH * hcDpr)) {
    fitToWindow();
  }
  const ctx = HC.ctx;
  HC.hits = [];
  ctx.setTransform(hcDpr, 0, 0, hcDpr, 0, 0);
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, HC_VPW, HC_VPH);

  hcDrawTopBar(ctx);
  hcDrawViewport(ctx);
  hcDrawPanel(ctx);
  hcDrawTooltip(ctx);
}

function hcDrawTopBar(ctx) {
  const r = { x: 0, y: 0, w: HC_VPW, h: TOPBAR_H };
  ctx.fillStyle = BG_SOFT;
  ctx.fillRect(r.x, r.y, r.w, r.h);
  ctx.strokeStyle = LINE;
  ctx.beginPath(); ctx.moveTo(0, TOPBAR_H - 0.5); ctx.lineTo(HC_VPW, TOPBAR_H - 0.5); ctx.stroke();

  ctx.fillStyle = CREAM;
  ctx.font = `bold 15px ${MONO}`;
  ctx.fillText('HITBOX CUSTOMIZER', 14, 31);
  ctx.fillStyle = CREAM_DIM;
  ctx.font = `10px ${MONO}`;
  ctx.fillText('character + move hitboxes → real runtime data', 14, 46);

  let x = 250;
  const f = ALL_FIGHTERS[HC.fighterIdx];
  x = chip(ctx, x, 14, 'char-prev', f ? f.name.toUpperCase() : '—', 'char-next', 'Character');
  x += 24;
  const move = MOVES.find(m => m.id === HC.animId) || { label: '—' };
  x = chip(ctx, x, 14, 'move-prev', move.label, 'move-next', 'Move');

  const customOn = HC.subject && HC.subject._fighterDef && getCustomHitboxes(HC.subject._fighterDef.id, HC.animId) !== null;
  ctx.fillStyle = CREAM_DIM;
  ctx.font = `10px ${MONO}`;
  ctx.fillText(customOn ? 'custom ·> active' : 'default', x + 20, 30);

  const bx = HC_VPW - 14;
  hcBtn('CLOSE', bx - 210, 14, 64, 24, 'close');
  hcBtn('RESET', bx - 140, 14, 62, 24, 'reset');
  const savedFlash = (performance.now() - HC.savedAt) < 1400;
  hcBtn('SAVE', bx - 70, 14, 56, 24, 'save', { hot: true });
  if (savedFlash) {
    ctx.fillStyle = CREAM;
    ctx.font = `11px ${MONO}`;
    ctx.fillText('SAVED', bx - 70 - ctx.measureText('SAVED').width - 14, 31);
  }
}

const RULER_H = 30;

function drawFrameRuler(ctx, r) {
  const px0 = r.x + 16, pw = r.w - 32;
  ctx.fillStyle = BG_RAISE;
  ctx.fillRect(r.x, r.y, r.w, RULER_H);
  ctx.strokeStyle = LINE;
  ctx.beginPath(); ctx.moveTo(r.x, r.y + RULER_H - 0.5); ctx.lineTo(r.x + r.w, r.y + RULER_H - 0.5); ctx.stroke();
  const max = Math.max(24, HC.previewMax);
  ctx.font = `9px ${MONO}`;
  for (let f = 0; f <= max; f += 5) {
    const x = px0 + (f / max) * pw;
    ctx.strokeStyle = f % 10 === 0 ? CREAM_DIM : CREAM_FAINT;
    ctx.beginPath();
    ctx.moveTo(x, f % 10 === 0 ? r.y + 3 : r.y + 9);
    ctx.lineTo(x, r.y + 13);
    ctx.stroke();
    if (f % 10 === 0) {
      ctx.fillStyle = CREAM_DIM;
      ctx.fillText(String(f), x + 3, r.y + 10);
    }
  }
  for (let i = 0; i < HC.boxes.length; i++) {
    const b = HC.boxes[i];
    const s = clamp(b.startFrame || 0, 0, max);
    const e = clamp(s + Math.max(1, b.duration || 4), 0, max);
    const x0 = px0 + (s / max) * pw, x1 = px0 + (e / max) * pw;
    ctx.fillStyle = i === HC.sel ? 'rgba(255,120,120,0.95)' : 'rgba(255,60,60,0.45)';
    ctx.fillRect(x0 + 0.5, r.y + 19, Math.max(2, x1 - x0 - 1), 5);
  }
  const phx = px0 + (clamp(HC.previewFrame, 0, max) / max) * pw;
  ctx.fillStyle = CREAM;
  ctx.fillRect(phx - 1, r.y + 2, 2, RULER_H - 5);
  ctx.fillStyle = CREAM;
  ctx.font = `bold 12px ${MONO}`;
  ctx.textAlign = 'right';
  ctx.fillText(`f ${Math.floor(HC.previewFrame)}${HC.autoScrub ? '  ▶' : '  ❚❚'}`, r.x + r.w - 12, r.y + 19);
  ctx.textAlign = 'left';
}

function hcDrawViewport(ctx) {
  const r = { x: 0, y: TOPBAR_H, w: Math.max(200, HC_VPW - HC_PANEL_W), h: HC_VPH - TOPBAR_H };
  const vp = { x: r.x, y: r.y + RULER_H, w: r.w, h: r.h - RULER_H };
  HC.vp = vp;
  ctx.save();
  ctx.beginPath();
  ctx.rect(r.x, r.y, r.w, r.h);
  ctx.clip();
  ctx.fillStyle = BG_DEEP;
  ctx.fillRect(r.x, r.y, r.w, r.h);
  drawFrameRuler(ctx, r);

  const cx = vp.x + vp.w / 2, cy = vp.y + vp.h / 2;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.scale(hcCam.zoom, hcCam.zoom);
  ctx.translate(-hcCam.x, -hcCam.y);

  const visL = hcCam.x - vp.w / (2 * hcCam.zoom), visR = hcCam.x + vp.w / (2 * hcCam.zoom);
  const visT = hcCam.y - vp.h / (2 * hcCam.zoom), visB = hcCam.y + vp.h / (2 * hcCam.zoom);
  if (HC.showGrid) {
    ctx.strokeStyle = CREAM_FAINT;
    ctx.lineWidth = 1 / hcCam.zoom;
    ctx.beginPath();
    for (let gx = Math.floor(visL / SNAP_GRID) * SNAP_GRID; gx <= visR; gx += SNAP_GRID) { ctx.moveTo(gx, visT); ctx.lineTo(gx, visB); }
    for (let gy = Math.floor(visT / SNAP_GRID) * SNAP_GRID; gy <= visB; gy += SNAP_GRID) { ctx.moveTo(visL, gy); ctx.lineTo(visR, gy); }
    ctx.stroke();
  }
  ctx.strokeStyle = CREAM_GLO;
  ctx.lineWidth = 1 / hcCam.zoom;
  ctx.beginPath(); ctx.moveTo(visL, 52); ctx.lineTo(visR, 52); ctx.stroke();

  if (!HC.subject.anim || !HC.subject.anim.out) sampleAnimator(HC.subject);
  drawFighter(ctx, HC.subject, previewTime());

  const rectScratch = { x: 0, y: 0, w: 0, h: 0 };
  const f = HC.previewFrame;
  for (let i = 0; i < HC.boxes.length; i++) {
    const hb = HC.boxes[i];
    hitboxRectFor(hb, 1, HC.subject.x, HC.subject.y, rectScratch);
    const isSel = i === HC.sel;
    const active = f >= (hb.startFrame || 0) && f < (hb.startFrame || 0) + Math.max(1, hb.duration || 4);
    if (active) {
      ctx.fillStyle = isSel ? 'rgba(255,90,90,0.35)' : 'rgba(255,60,60,0.22)';
      ctx.fillRect(rectScratch.x, rectScratch.y, rectScratch.w, rectScratch.h);
      ctx.strokeStyle = isSel ? HITBOX_SEL : '#00e5ff';
      ctx.lineWidth = isSel ? 3 : 2;
      ctx.strokeRect(rectScratch.x, rectScratch.y, rectScratch.w, rectScratch.h);
    } else {
      ctx.fillStyle = 'rgba(255,60,60,0.07)';
      ctx.fillRect(rectScratch.x, rectScratch.y, rectScratch.w, rectScratch.h);
      ctx.strokeStyle = isSel ? CREAM_DIM : 'rgba(0,0,0,0.6)';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4 / hcCam.zoom, 4 / hcCam.zoom]);
      ctx.strokeRect(rectScratch.x, rectScratch.y, rectScratch.w, rectScratch.h);
      ctx.setLineDash([]);
    }
    ctx.fillStyle = active ? 'rgba(255,255,255,0.65)' : 'rgba(255,255,255,0.22)';
    ctx.font = `10px ${MONO}`;
    const s = Math.round(hb.startFrame || 0);
    const e = Math.round(s + Math.max(1, hb.duration || 4));
    ctx.fillText(`${s}→${e}${active ? '' : ' · off'}`, rectScratch.x + 4, rectScratch.y - 4);

    const tl = hcWorldToScreen(rectScratch.x, rectScratch.y, vp);
    const br = hcWorldToScreen(rectScratch.x + rectScratch.w, rectScratch.y + rectScratch.h, vp);
    const rectS = {
      x: Math.min(tl.x, br.x), y: Math.min(tl.y, br.y),
      w: Math.abs(br.x - tl.x), h: Math.abs(br.y - tl.y),
    };
    if (isSel) {
      hcRegisterHit(`hb-body-${i}`, rectS.x, rectS.y, rectS.w, rectS.h);
      HC_TIPS[`hb-body-${i}`] = `Hitbox ${i + 1} — drag to move ox/oy`;
      drawHandles(ctx, i, vp, rectScratch);
    } else {
      hcRegisterHit(`hb-pick-${i}`, rectS.x, rectS.y, rectS.w, rectS.h);
      HC_TIPS[`hb-pick-${i}`] = `Hitbox ${i + 1} — click to select`;
    }
  }
  if (HC.def && (HC.def.startup != null || HC.def.active != null || HC.def.recovery != null)) {
    ctx.fillStyle = 'rgba(255,255,255,0.45)';
    ctx.font = `10px ${MONO}`;
    ctx.fillText(`${HC.def.startup || 0}·${HC.def.active || 0}·${HC.def.recovery || 0}`, HC.subject.x - 20, HC.subject.y - HC.subject.radius - 40);
  }
  ctx.restore();
  ctx.restore();

  const s = scrubPos();
  hcRegisterHit('frame-scrub', s.x, TOPBAR_H, s.w, RULER_H);
  HC_TIPS['frame-scrub'] = 'Timeline — drag to scrub pose · box turns dim while off · Space toggles auto-preview';
}

function drawHandles(ctx, i, r, rect) {
  const hs = clamp(8 * hcCam.zoom / 2.2, 6, 13);
  const HANDLES = [
    ['nw', 0, 0], ['n', 0.5, 0], ['ne', 1, 0],
    ['w', 0, 0.5],               ['e', 1, 0.5],
    ['sw', 0, 1], ['s', 0.5, 1], ['se', 1, 1],
  ];
  for (const [id, fx, fy] of HANDLES) {
    const p = hcWorldToScreen(rect.x + fx * rect.w, rect.y + fy * rect.h, r);
    ctx.fillStyle = CREAM;
    ctx.strokeStyle = '#000';
    ctx.fillRect(p.x - hs / 2, p.y - hs / 2, hs, hs);
    ctx.strokeRect(p.x - hs / 2 + 0.5, p.y - hs / 2 + 0.5, hs - 1, hs - 1);
    hcRegisterHit(`hb-resize-${id}-${i}`, p.x - hs / 2, p.y - hs / 2, hs, hs);
    HC_TIPS[`hb-resize-${id}-${i}`] = `Hitbox ${i + 1} ${id} — drag to resize`;
  }
}

function hcDrawNumRow(ctx, r, y, key, value) {
  const lx = r.x + 16, cx = r.x + r.w - 16, h = 24;
  ctx.fillStyle = CREAM_MUT;
  ctx.font = `12px ${MONO}`;
  ctx.fillText(HC_FIELD_LABEL[key] || key.toUpperCase(), lx, y + 14);
  ctx.fillStyle = CREAM;
  ctx.font = `13px ${MONO}`;
  const txt = fmt(value);
  const vw = ctx.measureText(txt).width;
  ctx.fillText(txt, cx - 104 - vw, y + 14);
  hcRegisterHit(`nr-${key}-drag`, cx - 106 - vw, y, vw + 12, h);
  HC_TIPS[`nr-${key}-drag`] = `${key} — drag to change · click to type`;
  hcBtn('−', cx - 98, y + 2, 22, 20, `nr-${key}-m`);
  hcBtn('+', cx - 74, y + 2, 22, 20, `nr-${key}-p`);
  return y + h;
}

function hcDrawPanel(ctx) {
  const r = { x: HC_VPW - HC_PANEL_W, y: TOPBAR_H, w: HC_PANEL_W, h: HC_VPH - TOPBAR_H };
  ctx.fillStyle = BG_SOFT;
  ctx.fillRect(r.x, r.y, r.w, r.h);
  ctx.strokeStyle = LINE;
  ctx.beginPath(); ctx.moveTo(r.x + 0.5, r.y); ctx.lineTo(r.x + 0.5, r.y + r.h); ctx.stroke();

  const lx = r.x + 16, cx = r.x + r.w - 16;
  let y = r.y + 12;
  ctx.fillStyle = CREAM;
  ctx.font = `bold 12px ${MONO}`;
  ctx.fillText('HITBOXES', lx, y + 12);
  ctx.fillStyle = CREAM_DIM;
  ctx.font = `10px ${MONO}`;
  ctx.fillText(HC.boxes.length ? `${HC.boxes.length} box${HC.boxes.length === 1 ? '' : 'es'}` : 'none', lx + 96, y + 12);

  let bx = cx - 24;
  hcBtn('+', bx, y, 24, 20, 'add');
  bx -= 96;
  hcBtn('▶', bx + 28, y, 24, 20, 'next');
  hcBtn('◀', bx, y, 24, 20, 'prev');
  hcBtn('−', bx - 28, y, 24, 20, 'del');
  y += 30;

  ctx.fillStyle = CREAM;
  ctx.font = `bold 12px ${MONO}`;
  ctx.fillText('PREVIEW', lx, y + 12);
  hcBtn(HC.autoScrub ? 'AUTO ▶' : 'AUTO ❚❚', cx - 62, y, 68, 20, 'auto-scrub', { hot: HC.autoScrub });
  HC_TIPS['auto-scrub'] = 'Auto-advance the preview pose through the active frames';
  y += 26;
  y = hcDrawNumRow(ctx, r, y, 'frame', Math.round(HC.previewFrame));
  ctx.strokeStyle = LINE;
  ctx.beginPath(); ctx.moveTo(lx, y + 4); ctx.lineTo(cx, y + 4); ctx.stroke();
  y += 16;

  if (!HC.boxes.length) {
    ctx.fillStyle = CREAM_DIM;
    ctx.font = `11px ${MONO}`;
    ctx.fillText('no hitboxes — press + to add', lx, y + 12);
    y += 26;
  } else {
    const i = clamp(HC.sel, 0, HC.boxes.length - 1);
    HC.sel = i;
    ctx.fillStyle = CREAM;
    ctx.font = `13px ${MONO}`;
    ctx.fillText(`HITBOX ${i + 1} / ${HC.boxes.length}`, lx, y + 13);
    y += 22;
    for (const key of ['w', 'h', 'ox', 'oy', 'startFrame', 'duration', 'range', 'end']) {
      y = hcDrawNumRow(ctx, r, y, key, workingBoxValue(i, key));
    }
    ctx.strokeStyle = LINE;
    ctx.beginPath(); ctx.moveTo(lx, y + 4); ctx.lineTo(cx, y + 4); ctx.stroke();
    y += 16;
    for (const key of ['dmg', 'kbBase', 'kbGrowth', 'angle']) {
      y = hcDrawNumRow(ctx, r, y, key, workingBoxValue(i, key));
    }
    // Attack-level recovery settings — ALWAYS shown, read/write box 0 (they
    // are attack-wide, not per-hitbox), so the attacker's recoil is tunable
    // independently of any single hitbox.
    ctx.strokeStyle = LINE;
    ctx.beginPath(); ctx.moveTo(lx, y + 4); ctx.lineTo(cx, y + 4); ctx.stroke();
    y += 16;
    ctx.fillStyle = CREAM_MUT;
    ctx.font = `11px ${MONO}`;
    ctx.fillText('ATTACK RECOVERY', lx, y + 13);
    y += 18;
    for (const key of RECOVERY_KEYS) {
      y = hcDrawNumRow(ctx, r, y, key, workingBoxValue(0, key));
    }
  }

  y += 14;
  ctx.strokeStyle = LINE;
  ctx.beginPath(); ctx.moveTo(lx, y); ctx.lineTo(cx, y); ctx.stroke();
  y += 12;
  ctx.fillStyle = CREAM_DIM;
  ctx.font = `10px ${MONO}`;
  ctx.fillText('SAVE writes straight into combat resolution', lx, y + 12);
  ctx.fillText('default boxes restore from the base moveset', lx, y + 26);
  ctx.fillText('RANGE = forward reach · END = last active frame', lx, y + 40);
  y += 44;

  ctx.fillStyle = CREAM_DIM;
  ctx.font = `10px ${MONO}`;
  const hasCustom = HC.subject && HC.subject._fighterDef && getCustomHitboxes(HC.subject._fighterDef.id, HC.animId) !== null;
  ctx.fillText(hasCustom ? 'state: custom override (runtime active)' : 'state: default fallback (no override)', lx, y + 12);
}

function hcDrawTooltip(ctx) {
  if (!HC.hover || !HC_TIPS[HC.hover]) return;
  const tip = HC_TIPS[HC.hover];
  const { x, y } = HC.lastPointer;
  ctx.font = `11px ${MONO}`;
  const tw = ctx.measureText(tip).width + 18;
  const bx = clamp(x + 16, 0, HC_VPW - tw - 4);
  const by = clamp(y + 20, 0, HC_VPH - 28);
  ctx.fillStyle = 'rgba(28,28,28,0.96)';
  ctx.strokeStyle = LINE;
  ctx.strokeRect(bx, by, tw, 24);
  ctx.fillRect(bx, by, tw, 24);
  ctx.fillStyle = CREAM_MUT;
  ctx.textBaseline = 'middle';
  ctx.fillText(tip, bx + 9, by + 13);
  ctx.textBaseline = 'alphabetic';
}

function hcHitAt(x, y) {
  for (let i = HC.hits.length - 1; i >= 0; i--) {
    const h = HC.hits[i];
    if (x >= h.x && x <= h.x + h.w && y >= h.y && y <= h.y + h.h) return h.id;
  }
  return null;
}

function hcLoc(e) {
  const rect = HC.canvas.getBoundingClientRect();
  return { x: e.clientX - rect.left, y: e.clientY - rect.top };
}

function stepValue(key, op) {
  const i = HC.sel;
  setWorkingBoxValue(i, key, workingBoxValue(i, key) + op * (ROW_STEP[key] || 1));
}

let stepTimer = null, stepPending = null;

function kickStep(id) {
  hcExecuteStep(id);
  stepTimer = setTimeout(() => {
    stepTimer = setTimeout(tickFast, 90);
    stepPending = id;
  }, 380);
}

function tickFast() {
  if (!stepPending) return;
  hcExecuteStep(stepPending);
  stepTimer = setTimeout(tickFast, 72);
}

function hcClearStepHold() {
  if (stepTimer) { clearTimeout(stepTimer); stepTimer = null; }
  stepPending = null;
}

function hcExecuteStep(id) {
  if (!id.startsWith('nr-')) return;
  const rest = id.slice(3);
  const key = rest.replace(/-(m|p)$/, '');
  const op = rest.endsWith('-m') ? -1 : rest.endsWith('-p') ? 1 : 0;
  if (!op) return;
  if (key === 'frame') { setPreviewFrame(HC.previewFrame + op); return; }
  if (HC.sel < 0) return;
  stepValue(key, op);
}

function hcOnPointerDown(e) {
  if (!HC.open || HC.drag) return;
  const { x, y } = hcLoc(e);
  HC.lastPointer = { x, y };
  const hit = hcHitAt(x, y);
  if (!hit) return;

  if (hit === 'close') { if (onClose) onClose(); return; }
  if (hit === 'save') { saveCustomizer(); return; }
  if (hit === 'reset') { resetCustomizerMove(); return; }
  if (hit === 'auto-scrub') { HC.autoScrub = !HC.autoScrub; return; }
  if (hit === 'frame-scrub') {
    HC.autoScrub = false;
    HC.scrubDrag = { startFrame: HC.previewFrame, startX: x };
    HC.drag = { type: 'scrubFrame', startX: x };
    setPreviewFrameFromX(x);
    e.preventDefault();
    return;
  }

  if (hit === 'char-prev') { setCustomizerFighter(HC.fighterIdx - 1); return; }
  if (hit === 'char-next') { setCustomizerFighter(HC.fighterIdx + 1); return; }
  if (hit === 'move-prev') {
    const idx = MOVES.findIndex(m => m.id === HC.animId);
    setCustomizerMove(MOVES[(idx - 1 + MOVES.length) % MOVES.length].id);
    return;
  }
  if (hit === 'move-next') {
    const idx = MOVES.findIndex(m => m.id === HC.animId);
    setCustomizerMove(MOVES[(idx + 1) % MOVES.length].id);
    return;
  }
  if (hit === 'add') {
    addCustomizerBox();
    return;
  }
  if (hit === 'del') {
    if (!HC.boxes.length) return;
    HC.boxes.splice(HC.sel, 1);
    selectBox(HC.sel);
    return;
  }
  if (hit === 'prev') {
    if (HC.boxes.length > 1) selectBox((HC.sel - 1 + HC.boxes.length) % HC.boxes.length);
    return;
  }
  if (hit === 'next') {
    if (HC.boxes.length > 1) selectBox((HC.sel + 1) % HC.boxes.length);
    return;
  }

  const pick = hit.match(/^hb-pick-(\d+)$/);
  if (pick) { selectBox(parseInt(pick[1], 10)); HC.drag = null; e.preventDefault(); return; }

  const body = hit.match(/^hb-body-(\d+)$/);
  if (body) {
    const i = parseInt(body[1], 10);
    HC.sel = i;
    snapPreviewToBox(i);
    const world = hcScreenToWorld(x, y, HC.vp);
    HC.drag = { type: 'hbBody', i, startOx: HC.boxes[i].ox || 0, startOy: HC.boxes[i].oy || 0, startWorld: world, lastWorld: world };
    e.preventDefault();
    return;
  }

  const resize = hit.match(/^hb-resize-(nw|n|ne|w|e|sw|s|se)-(\d+)$/);
  if (resize) {
    const i = parseInt(resize[2], 10);
    HC.sel = i;
    snapPreviewToBox(i);
    HC.drag = { type: 'hbResize', i, handle: resize[1] };
    e.preventDefault();
    return;
  }

  const nrMatch = hit.match(/^nr-([a-zA-Z]+)-drag$/);
  if (nrMatch) {
    const key = nrMatch[1];
    const startVal = key === 'frame' ? HC.previewFrame : (HC.sel >= 0 ? workingBoxValue(HC.sel, key) : NaN);
    if (isFinite(startVal)) {
      HC.drag = { type: 'numRow', key, start: startVal, lastX: x, clickId: `edit-${key}`, downX: x, downY: y };
      e.preventDefault();
    }
    return;
  }

  if (hit.match(/^nr-[a-zA-Z]+-[mp]$/)) {
    e.preventDefault();
    kickStep(hit);
    HC.drag = { type: 'btnHold' };
    return;
  }
}

function hcOnPointerMove(e) {
  if (!HC.open) return;
  const { x, y } = hcLoc(e);
  HC.lastPointer = { x, y };
  HC.hover = hcHitAt(x, y);
  const d = HC.drag;
  if (!d) return;
  if (d.type === 'btnHold') return;

  if (d.downX != null && (Math.abs(x - d.downX) > 3 || Math.abs(y - d.downY) > 3)) d.clickId = null;

  if (d.type === 'scrubFrame') {
    setPreviewFrameFromX(x);
    return;
  }

  if (d.type === 'hbBody') {
    const world = hcScreenToWorld(x, y, HC.vp);
    const dx = world.x - d.lastWorld.x, dy = world.y - d.lastWorld.y;
    d.lastWorld = world;
    let nx = HC.boxes[d.i].ox + dx;
    let ny = HC.boxes[d.i].oy + dy;
    if (HC.snap) { nx = snapVal(nx); ny = snapVal(ny); }
    HC.boxes[d.i].ox = round3(nx);
    HC.boxes[d.i].oy = round3(ny);
  } else if (d.type === 'hbResize') {
    const world = hcScreenToWorld(x, y, HC.vp);
    const r = customizerResizeRect(d.i, world.x, world.y, d.handle);
    if (r) { HC.boxes[d.i].w = r.w; HC.boxes[d.i].h = r.h; HC.boxes[d.i].ox = r.ox; HC.boxes[d.i].oy = r.oy; }
  } else if (d.type === 'numRow') {
    const dxp = x - d.lastX;
    d.lastX = x;
    if (d.key === 'frame') setPreviewFrame(d.start + dxp);
    else if (HC.sel >= 0) setWorkingBoxValue(HC.sel, d.key, d.start + dxp * (ROW_STEP[d.key] || 1));
  }
}

function hcOnPointerUp(e) {
  const d = HC.drag;
  if (d && d.type === 'btnHold') { clearStepHold(); HC.drag = null; return; }
  if (d && d.type === 'scrubFrame') { HC.scrubDrag = null; HC.drag = null; return; }
  if (d && d.clickId) {
    const key2 = d.clickId.slice('edit-'.length);
    const cur = key2 === 'frame' ? HC.previewFrame : (HC.sel >= 0 ? workingBoxValue(HC.sel, key2) : undefined);
    if (cur !== undefined) {
      showModal(
        (HC_FIELD_LABEL[key2] || 'VALUE').toUpperCase(),
        String(cur),
        v => {
          const n = Number(v);
          if (!isFinite(n)) return;
          if (key2 === 'frame') setPreviewFrame(n);
          else if (HC.sel >= 0) setWorkingBoxValue(HC.sel, key2, n);
        },
        'SET', 'CANCEL', true,
      );
    }
  }
  HC.drag = null;
  HC.scrubDrag = null;
}

function onCustomizerKey(e) {
  if (modalActive()) {
    if (e.key === 'Escape') { cancelModal(); e.preventDefault(); }
    return;
  }
  if (e.key === 'Escape') {
    if (onClose) onClose();
    e.preventDefault();
    return;
  }
  if (e.code === 'Space') { HC.autoScrub = !HC.autoScrub; e.preventDefault(); return; }
  if (e.code === 'ArrowRight') { setPreviewFrame(HC.previewFrame + 1); e.preventDefault(); return; }
  if (e.code === 'ArrowLeft') { setPreviewFrame(HC.previewFrame - 1); e.preventDefault(); return; }
}
