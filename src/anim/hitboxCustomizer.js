// hitboxCustomizer.js — the Hitbox Customizer, a standalone canvas section
// that edits the REAL runtime hitbox data for a character + move. Everything
// it writes goes through hitboxData.js into the per-character/per-move store,
// which combat.resolveAnimDef reads at every attack start — so a saved box
// overrides the DEFAULT_ATTACKS fallback in the actual game. There is no
// separate preview-only database.

import { createEditorSubject } from './editor.js';
import { getAnimationRaw } from './library.js';
import { sampleAnimator } from './animator.js';
import { drawFighter } from '../render/Effects.js';
import { ALL_FIGHTERS } from '../content/Menu.js';
import {
  resolveAnimDef, resolveAttackDef, getAttackDefForAnimId, hitboxRectFor, hitboxList,
} from '../fighter/combat.js';
import {
  setCustomHitboxes, clearCustomHitboxes, getCustomHitboxes,
} from '../fighter/hitboxData.js';
import { showModal, cancelModal, modalActive } from './modal.js';

const CREAM      = '#f3ead1';
const CREAM_MUT  = '#cbbf9f';
const CREAM_DIM  = '#7d745c';
const CREAM_FAINT= 'rgba(243,234,209,0.07)';
const CREAM_GLO  = 'rgba(243,234,209,0.2)';
const BG         = '#101010';
const BG_SOFT    = '#151515';
const BG_DEEP    = '#0c0c0c';
const BG_RAISE   = '#1d1d1d';
const BG_HOT     = '#2c2c2c';
const LINE       = '#2c2c2c';
const MONO = 'Consolas, "Courier New", monospace';
const HITBOX_FILL = '#ff3c3c';
const HITBOX_SEL  = 'rgba(255,100,100,0.9)';

let VPW = 1200, VPH = 820;
let dpr = 1;
const TOPBAR_H = 52;
const PANEL_W = 300;

const cam = { x: 0, y: 0, zoom: 2.2 };
const SNAP_GRID = 8;

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
function round3(v) { return Math.round(v * 1000) / 1000; }
function snapVal(v) { return Math.round(v / SNAP_GRID) * SNAP_GRID; }
function fmt(v) {
  const n = Number(v);
  if (!isFinite(n)) return '0';
  if (Math.abs(n) >= 100) return n.toFixed(0);
  if (Math.abs(n) >= 10) return n.toFixed(1);
  return n.toFixed(2);
}

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

const FIELD_LABEL = {
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

export const __HC = HC;

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

function captureCanvasStyle() {
  HC._savedStyle = {
    w: HC.canvas.width, h: HC.canvas.height,
    sw: HC.canvas.style.width, sh: HC.canvas.style.height,
    pos: HC.canvas.style.position, top: HC.canvas.style.top, left: HC.canvas.style.left,
    tf: HC.canvas.style.transform, border: HC.canvas.style.border,
  };
}

function restoreCanvasStyle() {
  if (!HC.canvas || !HC._savedStyle) return;
  const c = HC.canvas, s = HC._savedStyle;
  c.width = s.w; c.height = s.h;
  c.style.width = s.sw; c.style.height = s.sh;
  c.style.position = s.pos; c.style.top = s.top; c.style.left = s.left;
  c.style.transform = s.tf; c.style.border = s.border;
}

function fitToWindow() {
  if (!HC.canvas) return;
  dpr = window.devicePixelRatio || 1;
  const w = window.innerWidth, h = window.innerHeight;
  VPW = w; VPH = h;
  HC.canvas.width = Math.round(w * dpr);
  HC.canvas.height = Math.round(h * dpr);
  HC.canvas.style.width = w + 'px';
  HC.canvas.style.height = h + 'px';
  HC.canvas.style.position = 'fixed';
  HC.canvas.style.top = '0'; HC.canvas.style.left = '0';
  HC.canvas.style.transform = 'none';
  HC.canvas.style.border = 'none';
}

let onKey, onDown, onMove, onUp;

export function openHitboxCustomizer(canvas, getFighterDef) {
  HC.canvas = canvas;
  HC.ctx = canvas.getContext('2d');
  captureCanvasStyle();
  fitToWindow();
  const def = getFighterDef();
  HC.fighterIdx = Math.max(0, ALL_FIGHTERS.findIndex(f => f.id === (def && def.id)));
  HC.subject = createEditorSubject({ ...ALL_FIGHTERS[HC.fighterIdx] });
  cam.x = 0; cam.y = 0; cam.zoom = 2.2;
  HC.sel = -1;
  HC.boxes = [];
  HC.def = null;
  HC.animId = MOVES[0].id;
  loadMove(HC.animId);
  HC.open = true;

  onKey = e => onCustomizerKey(e);
  onDown = e => onPointerDown(e);
  onMove = e => onPointerMove(e);
  onUp = e => onPointerUp(e);

  window.addEventListener('keydown', onKey, true);
  canvas.addEventListener('pointerdown', onDown);
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('resize', fitToWindow);
}

export function closeHitboxCustomizer() {
  if (!HC.open) return;
  if (HC.canvas) HC.canvas.removeEventListener('pointerdown', onDown);
  window.removeEventListener('keydown', onKey, true);
  window.removeEventListener('pointermove', onMove);
  window.removeEventListener('pointerup', onUp);
  window.removeEventListener('resize', fitToWindow);
  restoreCanvasStyle();
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

function previewTime() { return HC.timeNow % 1000; }

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

const TIPS = {};

function registerHit(id, x, y, w, h) {
  HC.hits.push({ id, x, y, w, h });
}

function btn(label, x, y, w, h, id, opts = {}) {
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
  registerHit(id, x, y, w, h);
}

function chip(ctx, x, y, prevId, label, nextId, tip) {
  btn('◀', x, y, 22, 24, prevId);
  ctx.fillStyle = CREAM;
  ctx.font = `12px ${MONO}`;
  ctx.fillText(label, x + 28, y + 16);
  registerHit(nextId, x + 28, y, ctx.measureText(label).width + 6, 24);
  TIPS[prevId] = tip; TIPS[nextId] = tip;
  ctx.strokeStyle = LINE;
  ctx.strokeRect(x + 26, y + 3, ctx.measureText(label).width + 10, 18);
  return x + 40 + ctx.measureText(label).width;
}

export function renderHitboxCustomizer() {
  if (!HC.open || !HC.ctx) return;
  const ctx = HC.ctx;
  HC.hits = [];
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, VPW, VPH);

  drawTopBar(ctx);
  drawViewport(ctx);
  drawPanel(ctx);
  drawTooltip(ctx);
}

function drawTopBar(ctx) {
  const r = { x: 0, y: 0, w: VPW, h: TOPBAR_H };
  ctx.fillStyle = BG_SOFT;
  ctx.fillRect(r.x, r.y, r.w, r.h);
  ctx.strokeStyle = LINE;
  ctx.beginPath(); ctx.moveTo(0, TOPBAR_H - 0.5); ctx.lineTo(VPW, TOPBAR_H - 0.5); ctx.stroke();

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

  const bx = VPW - 14;
  btn('CLOSE', bx - 210, 14, 64, 24, 'close');
  btn('RESET', bx - 140, 14, 62, 24, 'reset');
  const savedFlash = (performance.now() - HC.savedAt) < 1400;
  btn('SAVE', bx - 70, 14, 56, 24, 'save', { hot: true });
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

function drawViewport(ctx) {
  const r = { x: 0, y: TOPBAR_H, w: Math.max(200, VPW - PANEL_W), h: VPH - TOPBAR_H };
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
  ctx.scale(cam.zoom, cam.zoom);
  ctx.translate(-cam.x, -cam.y);

  const visL = cam.x - vp.w / (2 * cam.zoom), visR = cam.x + vp.w / (2 * cam.zoom);
  const visT = cam.y - vp.h / (2 * cam.zoom), visB = cam.y + vp.h / (2 * cam.zoom);
  if (HC.showGrid) {
    ctx.strokeStyle = CREAM_FAINT;
    ctx.lineWidth = 1 / cam.zoom;
    ctx.beginPath();
    for (let gx = Math.floor(visL / SNAP_GRID) * SNAP_GRID; gx <= visR; gx += SNAP_GRID) { ctx.moveTo(gx, visT); ctx.lineTo(gx, visB); }
    for (let gy = Math.floor(visT / SNAP_GRID) * SNAP_GRID; gy <= visB; gy += SNAP_GRID) { ctx.moveTo(visL, gy); ctx.lineTo(visR, gy); }
    ctx.stroke();
  }
  ctx.strokeStyle = CREAM_GLO;
  ctx.lineWidth = 1 / cam.zoom;
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
      ctx.setLineDash([4 / cam.zoom, 4 / cam.zoom]);
      ctx.strokeRect(rectScratch.x, rectScratch.y, rectScratch.w, rectScratch.h);
      ctx.setLineDash([]);
    }
    ctx.fillStyle = active ? 'rgba(255,255,255,0.65)' : 'rgba(255,255,255,0.22)';
    ctx.font = `10px ${MONO}`;
    const s = Math.round(hb.startFrame || 0);
    const e = Math.round(s + Math.max(1, hb.duration || 4));
    ctx.fillText(`${s}→${e}${active ? '' : ' · off'}`, rectScratch.x + 4, rectScratch.y - 4);

    const tl = worldToScreen(rectScratch.x, rectScratch.y, vp);
    const br = worldToScreen(rectScratch.x + rectScratch.w, rectScratch.y + rectScratch.h, vp);
    const rectS = {
      x: Math.min(tl.x, br.x), y: Math.min(tl.y, br.y),
      w: Math.abs(br.x - tl.x), h: Math.abs(br.y - tl.y),
    };
    if (isSel) {
      registerHit(`hb-body-${i}`, rectS.x, rectS.y, rectS.w, rectS.h);
      TIPS[`hb-body-${i}`] = `Hitbox ${i + 1} — drag to move ox/oy`;
      drawHandles(ctx, i, vp, rectScratch);
    } else {
      registerHit(`hb-pick-${i}`, rectS.x, rectS.y, rectS.w, rectS.h);
      TIPS[`hb-pick-${i}`] = `Hitbox ${i + 1} — click to select`;
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
  registerHit('frame-scrub', s.x, TOPBAR_H, s.w, RULER_H);
  TIPS['frame-scrub'] = 'Timeline — drag to scrub pose · box turns dim while off · Space toggles auto-preview';
}

function drawHandles(ctx, i, r, rect) {
  const hs = clamp(8 * cam.zoom / 2.2, 6, 13);
  const HANDLES = [
    ['nw', 0, 0], ['n', 0.5, 0], ['ne', 1, 0],
    ['w', 0, 0.5],               ['e', 1, 0.5],
    ['sw', 0, 1], ['s', 0.5, 1], ['se', 1, 1],
  ];
  for (const [id, fx, fy] of HANDLES) {
    const p = worldToScreen(rect.x + fx * rect.w, rect.y + fy * rect.h, r);
    ctx.fillStyle = CREAM;
    ctx.strokeStyle = '#000';
    ctx.fillRect(p.x - hs / 2, p.y - hs / 2, hs, hs);
    ctx.strokeRect(p.x - hs / 2 + 0.5, p.y - hs / 2 + 0.5, hs - 1, hs - 1);
    registerHit(`hb-resize-${id}-${i}`, p.x - hs / 2, p.y - hs / 2, hs, hs);
    TIPS[`hb-resize-${id}-${i}`] = `Hitbox ${i + 1} ${id} — drag to resize`;
  }
}

function drawNumRow(ctx, r, y, key, value) {
  const lx = r.x + 16, cx = r.x + r.w - 16, h = 24;
  ctx.fillStyle = CREAM_MUT;
  ctx.font = `12px ${MONO}`;
  ctx.fillText(FIELD_LABEL[key] || key.toUpperCase(), lx, y + 14);
  ctx.fillStyle = CREAM;
  ctx.font = `13px ${MONO}`;
  const txt = fmt(value);
  const vw = ctx.measureText(txt).width;
  ctx.fillText(txt, cx - 104 - vw, y + 14);
  registerHit(`nr-${key}-drag`, cx - 106 - vw, y, vw + 12, h);
  TIPS[`nr-${key}-drag`] = `${key} — drag to change · click to type`;
  btn('−', cx - 98, y + 2, 22, 20, `nr-${key}-m`);
  btn('+', cx - 74, y + 2, 22, 20, `nr-${key}-p`);
  return y + h;
}

function drawPanel(ctx) {
  const r = { x: VPW - PANEL_W, y: TOPBAR_H, w: PANEL_W, h: VPH - TOPBAR_H };
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
  btn('+', bx, y, 24, 20, 'add');
  bx -= 96;
  btn('▶', bx + 28, y, 24, 20, 'next');
  btn('◀', bx, y, 24, 20, 'prev');
  btn('−', bx - 28, y, 24, 20, 'del');
  y += 30;

  ctx.fillStyle = CREAM;
  ctx.font = `bold 12px ${MONO}`;
  ctx.fillText('PREVIEW', lx, y + 12);
  btn(HC.autoScrub ? 'AUTO ▶' : 'AUTO ❚❚', cx - 62, y, 68, 20, 'auto-scrub', { hot: HC.autoScrub });
  TIPS['auto-scrub'] = 'Auto-advance the preview pose through the active frames';
  y += 26;
  y = drawNumRow(ctx, r, y, 'frame', Math.round(HC.previewFrame));
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
      y = drawNumRow(ctx, r, y, key, workingBoxValue(i, key));
    }
    ctx.strokeStyle = LINE;
    ctx.beginPath(); ctx.moveTo(lx, y + 4); ctx.lineTo(cx, y + 4); ctx.stroke();
    y += 16;
    for (const key of ['dmg', 'kbBase', 'kbGrowth', 'angle']) {
      y = drawNumRow(ctx, r, y, key, workingBoxValue(i, key));
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
      y = drawNumRow(ctx, r, y, key, workingBoxValue(0, key));
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

function drawTooltip(ctx) {
  if (!HC.hover || !TIPS[HC.hover]) return;
  const tip = TIPS[HC.hover];
  const { x, y } = HC.lastPointer;
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

function hitAt(x, y) {
  for (let i = HC.hits.length - 1; i >= 0; i--) {
    const h = HC.hits[i];
    if (x >= h.x && x <= h.x + h.w && y >= h.y && y <= h.y + h.h) return h.id;
  }
  return null;
}

function loc(e) {
  const rect = HC.canvas.getBoundingClientRect();
  return { x: e.clientX - rect.left, y: e.clientY - rect.top };
}

function stepValue(key, op) {
  const i = HC.sel;
  setWorkingBoxValue(i, key, workingBoxValue(i, key) + op * (ROW_STEP[key] || 1));
}

let stepTimer = null, stepPending = null;

function kickStep(id) {
  executeStep(id);
  stepTimer = setTimeout(() => {
    stepTimer = setTimeout(tickFast, 90);
    stepPending = id;
  }, 380);
}

function tickFast() {
  if (!stepPending) return;
  executeStep(stepPending);
  stepTimer = setTimeout(tickFast, 72);
}

function clearStepHold() {
  if (stepTimer) { clearTimeout(stepTimer); stepTimer = null; }
  stepPending = null;
}

function executeStep(id) {
  if (!id.startsWith('nr-')) return;
  const rest = id.slice(3);
  const key = rest.replace(/-(m|p)$/, '');
  const op = rest.endsWith('-m') ? -1 : rest.endsWith('-p') ? 1 : 0;
  if (!op) return;
  if (key === 'frame') { setPreviewFrame(HC.previewFrame + op); return; }
  if (HC.sel < 0) return;
  stepValue(key, op);
}

function onPointerDown(e) {
  if (!HC.open || HC.drag) return;
  const { x, y } = loc(e);
  HC.lastPointer = { x, y };
  const hit = hitAt(x, y);
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
    const world = screenToWorld(x, y, HC.vp);
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

function onPointerMove(e) {
  if (!HC.open) return;
  const { x, y } = loc(e);
  HC.lastPointer = { x, y };
  HC.hover = hitAt(x, y);
  const d = HC.drag;
  if (!d) return;
  if (d.type === 'btnHold') return;

  if (d.downX != null && (Math.abs(x - d.downX) > 3 || Math.abs(y - d.downY) > 3)) d.clickId = null;

  if (d.type === 'scrubFrame') {
    setPreviewFrameFromX(x);
    return;
  }

  if (d.type === 'hbBody') {
    const world = screenToWorld(x, y, HC.vp);
    const dx = world.x - d.lastWorld.x, dy = world.y - d.lastWorld.y;
    d.lastWorld = world;
    let nx = HC.boxes[d.i].ox + dx;
    let ny = HC.boxes[d.i].oy + dy;
    if (HC.snap) { nx = snapVal(nx); ny = snapVal(ny); }
    HC.boxes[d.i].ox = round3(nx);
    HC.boxes[d.i].oy = round3(ny);
  } else if (d.type === 'hbResize') {
    const world = screenToWorld(x, y, HC.vp);
    const r = customizerResizeRect(d.i, world.x, world.y, d.handle);
    if (r) { HC.boxes[d.i].w = r.w; HC.boxes[d.i].h = r.h; HC.boxes[d.i].ox = r.ox; HC.boxes[d.i].oy = r.oy; }
  } else if (d.type === 'numRow') {
    const dxp = x - d.lastX;
    d.lastX = x;
    if (d.key === 'frame') setPreviewFrame(d.start + dxp);
    else if (HC.sel >= 0) setWorkingBoxValue(HC.sel, d.key, d.start + dxp * (ROW_STEP[d.key] || 1));
  }
}

function onPointerUp(e) {
  const d = HC.drag;
  if (d && d.type === 'btnHold') { clearStepHold(); HC.drag = null; return; }
  if (d && d.type === 'scrubFrame') { HC.scrubDrag = null; HC.drag = null; return; }
  if (d && d.clickId) {
    const key2 = d.clickId.slice('edit-'.length);
    const cur = key2 === 'frame' ? HC.previewFrame : (HC.sel >= 0 ? workingBoxValue(HC.sel, key2) : undefined);
    if (cur !== undefined) {
      showModal(
        (FIELD_LABEL[key2] || 'VALUE').toUpperCase(),
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