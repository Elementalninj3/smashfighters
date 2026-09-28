// SandboxEditor.js — the Interactive Sandbox / map editor.
//
// Same architecture as anim/editor.js: module state, pointer handlers on the
// canvas, a hit registry rebuilt for the frame, panels drawn in the game's
// terminal palette, and explicit open/close/update/render functions the game
// loop calls. The editor is a MODE, not a copy of the game — while it is open
// nothing simulates, and the arena underneath it is drawn with the real
// Stage.js / Effects.js renderers, so what you build is what you play.
//
// It edits a plain data document (a list of platform / breakable / spawn
// objects). The play session builds a fresh stage from that document every time
// it starts (see SandboxSession.js), which is why editing here can never leave
// debris in a running match and why a broken board always comes back at full
// durability when you press PLAY.

import { showModal } from '../../anim/modal.js';
import { ALL_FIGHTERS } from '../../content/Menu.js';
import { drawFighter } from '../../render/Effects.js';
import { createFighter } from '../../fighter/Fighter.js';
import { loadHandGearFor } from '../../render/HandGear.js';
import { resolveFighterSkin } from '../../fighter/session.js';
import { DESTRUCTIBLE_KINDS, destructibleKind, drawDestructibleHp } from './destructible.js';
import {
  drawStage,
  PLATFORM_TYPES,
  platformType,
  BACKGROUND_PRESETS,
  backgroundPreset,
  defaultSandboxEnv,
  defaultSandboxObjects,
  loadSandboxEnv,
  saveSandboxEnv,
  loadSandboxDoc,
  saveSandboxDoc,
  invalidateSandboxBackground,
  countDestructibles,
  countEntities,
  MAX_SANDBOX_FIGHTERS,
} from '../Stage.js';

// ── Palette ──────────────────────────────────────────────────────────────
const CREAM = '#f3ead1';
const CREAM_MUT = '#cbbf9f';
const CREAM_DIM = '#7d745c';
const LINE = '#2c2c2c';
const BG = '#101010';
const BG_SOFT = '#151515';
const BG_RAISE = '#1d1d1d';
const ACCENT = '#e8c25a';
const MONO = 'Consolas, "Courier New", monospace';
const F_SMALL = `10px ${MONO}`;
const F_BODY = `12px ${MONO}`;
const F_HEAD = `bold 12px ${MONO}`;
const F_TITLE = `bold 15px ${MONO}`;

// ── Tools ────────────────────────────────────────────────────────────────
export const TOOL_SELECT = 0;
export const TOOL_MOVE = 1;
export const TOOL_RESIZE = 2;
export const TOOL_PLATFORM = 3;
export const TOOL_DESTRUCTIBLE = 4;
export const TOOL_ENTITY = 5;
export const TOOL_DELETE = 6;

const TOOL_DEFS = [
  { id: TOOL_SELECT, name: 'SELECT', key: '1' },
  { id: TOOL_MOVE, name: 'MOVE', key: '2' },
  { id: TOOL_RESIZE, name: 'RESIZE', key: '3' },
  { id: TOOL_PLATFORM, name: '+PLATFORM', key: '4' },
  { id: TOOL_DESTRUCTIBLE, name: '+BREAKABLE', key: '5' },
  { id: TOOL_ENTITY, name: '+SPAWN', key: '6' },
  { id: TOOL_DELETE, name: 'DELETE', key: '7' },
];

// ── Layout ───────────────────────────────────────────────────────────────
const PANEL_W = 246;
const TOPBAR_H = 46;
const STATUS_H = 24;
const MIN_SIZE = 12;
const PAD = 16;

// ── State ────────────────────────────────────────────────────────────────
let open = false;
let canvas = null;
let ctx = null;
let closeHandler = null;
let playHandler = null;

let env = defaultSandboxEnv(1200, 1100);
let objects = [];
let selectedId = null;
let tool = TOOL_SELECT;

let platformTypeId = PLATFORM_TYPES[0].id;
let destructibleKindId = DESTRUCTIBLE_KINDS[0].id;
let entityCharId = 'cowboy';
let entityControl = 'human';

let arenaW = 1200;
let arenaH = 1100;

// Viewport (pan/zoom over the arena — the editor does not use the match camera,
// so the whole arena stays reachable even before anything is placed).
let viewX = 0;
let viewY = 0;
let viewZoom = 1;

let drag = null;
const pointer = { x: 0, y: 0, worldX: 0, worldY: 0, inside: false };
let snap = true;
let time = 0;
let nextId = 1;

const hits = [];

function findObject(id) {
  for (let i = 0; i < objects.length; i++) if (objects[i] && objects[i].id === id) return objects[i];
  return null;
}

function removeObject(id) {
  const i = objects.findIndex((o) => o.id === id);
  if (i !== -1) objects.splice(i, 1);
  if (selectedId === id) selectedId = null;
}

// ── Open / close ─────────────────────────────────────────────────────────
export function openSandboxEditor(gameCanvas, handlers = {}) {
  if (open) closeSandboxEditor();
  canvas = gameCanvas;
  ctx = canvas ? canvas.getContext('2d') : null;
  closeHandler = handlers.onClose || null;
  playHandler = handlers.onPlay || null;

  const savedEnv = loadSandboxEnv();
  env = savedEnv || defaultSandboxEnv(arenaW, arenaH);
  const savedDoc = loadSandboxDoc();
  objects = savedDoc ? savedDoc.objects.slice() : defaultSandboxObjects(arenaW, arenaH);
  normalizeDocument();

  selectedId = null;
  tool = TOOL_SELECT;
  drag = null;
  fitView();
  open = true;

  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerUp);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  canvas.addEventListener('contextmenu', onContextMenu);
  window.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('keyup', onKeyUp, true);
  window.addEventListener('blur', onBlur);
  return true;
}

// Detaches every listener and marks the editor closed. `silent` is for the
// PLAY transition: the editor is stepping aside for a session, not being
// dismissed, so the close handler (which returns to the main menu) must not
// fire. The document itself survives — ESC from a session reopens this exact
// state, and the module keeps `env`/`objects` either way.
export function closeSandboxEditor(silent = false) {
  if (!open) return;
  open = false;
  if (canvas) {
    canvas.removeEventListener('pointerdown', onPointerDown);
    canvas.removeEventListener('pointermove', onPointerMove);
    canvas.removeEventListener('pointerup', onPointerUp);
    canvas.removeEventListener('pointercancel', onPointerUp);
    canvas.removeEventListener('wheel', onWheel);
    canvas.removeEventListener('contextmenu', onContextMenu);
  }
  window.removeEventListener('keydown', onKeyDown, true);
  window.removeEventListener('keyup', onKeyUp, true);
  window.removeEventListener('blur', onBlur);
  drag = null;
  if (!silent && closeHandler) closeHandler();
}

export function isSandboxEditorOpen() {
  return open;
}

// The game loop tells the editor the real canvas size, so its defaults and its
// "fit" match the live arena instead of a hardcoded 1200×1100.
export function setSandboxArenaSize(width, height) {
  if (width === arenaW && height === arenaH) return;
  arenaW = width;
  arenaH = height;
}

export function getSandboxDocument() {
  return { env, objects };
}

export function setSandboxDocument(doc) {
  if (!doc) return;
  if (doc.env) env = { ...defaultSandboxEnv(arenaW, arenaH), ...doc.env };
  if (Array.isArray(doc.objects)) objects = doc.objects.slice();
  normalizeDocument();
  invalidateSandboxBackground();
}

function normalizeDocument() {
  nextId = 1;
  for (let i = 0; i < objects.length; i++) {
    const o = objects[i];
    if (!o) continue;
    if (!o.id) o.id = newId(o.type === 'entity' ? 'e' : o.type === 'destructible' ? 'd' : 'p');
    const m = /(\d+)$/.exec(o.id);
    if (m) nextId = Math.max(nextId, parseInt(m[1], 10) + 1);
    if (o.type === 'destructible') {
      const kind = destructibleKind(o.kindId);
      if (o.maxHp == null) o.maxHp = kind.hp;
      if (o.hp == null) o.hp = o.maxHp;
      o.hp = Math.max(1, Math.min(o.maxHp, o.hp));
    }
  }
}

function newId(prefix) {
  return `${prefix}${nextId++}`;
}

function persist() {
  saveSandboxEnv(env);
  saveSandboxDoc({ objects });
}

// ── Update ───────────────────────────────────────────────────────────────
// Deliberately almost nothing: the editor is event-driven. A drag applies its
// world delta in the pointer handler, so an idle editor costs a clock read and
// no simulation at all.
export function updateSandboxEditor(dt) {
  time += dt * 1000;
}

// ── Viewport maths ───────────────────────────────────────────────────────
function viewport() {
  return { x: PANEL_W, y: TOPBAR_H, w: arenaW - PANEL_W, h: arenaH - TOPBAR_H - STATUS_H };
}

function eventPos(e) {
  const r = canvas.getBoundingClientRect();
  return {
    x: (e.clientX - r.left) * (canvas.width / r.width),
    y: (e.clientY - r.top) * (canvas.height / r.height),
  };
}

function screenToWorld(sx, sy) {
  return { x: (sx - viewX) / viewZoom, y: (sy - viewY) / viewZoom };
}

function inViewport(sx, sy) {
  const vp = viewport();
  return sx >= vp.x && sx < vp.x + vp.w && sy >= vp.y && sy < vp.y + vp.h;
}

function fitView() {
  const vp = viewport();
  viewZoom = Math.max(0.2, Math.min(1.4, Math.min(vp.w / arenaW, vp.h / arenaH)));
  viewX = vp.x + (vp.w - arenaW * viewZoom) / 2;
  viewY = vp.y + (vp.h - arenaH * viewZoom) / 2;
}

function snapStep() {
  return Math.max(5, (env.gridSize || 40) / 2);
}

function snapValue(v) {
  if (!snap) return Math.round(v);
  const step = snapStep();
  return Math.round(v / step) * step;
}

// ── Pointer ──────────────────────────────────────────────────────────────
function onContextMenu(e) {
  if (open) e.preventDefault();
}

function onPointerDown(e) {
  if (!open || !canvas) return;
  const p = eventPos(e);

  // Panels and the top bar own the screen space left of / above the arena.
  if (!inViewport(p.x, p.y)) {
    if (e.button === 0) {
      const h = hitTest(p.x, p.y);
      if (h && h.onClick) { h.onClick(); return; }
    }
    return;
  }

  if (e.button === 2 || e.button === 1) {
    drag = { kind: 'pan', sx: p.x, sy: p.y, vx: viewX, vy: viewY };
    try { canvas.setPointerCapture(e.pointerId); } catch (_) {}
    return;
  }
  if (e.button !== 0) return;

  const w = screenToWorld(p.x, p.y);
  const target = pickAt(w.x, w.y);

  if (tool === TOOL_DELETE) {
    if (target) { removeObject(target.id); persist(); }
    return;
  }
  if (tool === TOOL_PLATFORM) { addPlatform(w.x, w.y); return; }
  if (tool === TOOL_DESTRUCTIBLE) { addDestructible(w.x, w.y); return; }
  if (tool === TOOL_ENTITY) { addEntity(w.x, w.y); return; }

  if (!target) {
    if (tool === TOOL_SELECT) selectedId = null;
    return;
  }
  selectedId = target.id;

  if (tool === TOOL_RESIZE) {
    const handle = pickHandle(target, w.x, w.y);
    if (handle) {
      drag = { kind: 'resize', id: target.id, handle, ox: w.x, oy: w.y, start: snapshotRect(target) };
      try { canvas.setPointerCapture(e.pointerId); } catch (_) {}
    }
    return;
  }
  if (tool === TOOL_MOVE) {
    drag = { kind: 'move', id: target.id, ox: w.x, oy: w.y, startX: target.x, startY: target.y };
    try { canvas.setPointerCapture(e.pointerId); } catch (_) {}
  }
}

function onPointerMove(e) {
  if (!open || !canvas) return;
  const p = eventPos(e);
  const w = screenToWorld(p.x, p.y);
  pointer.x = p.x; pointer.y = p.y;
  pointer.worldX = w.x; pointer.worldY = w.y;
  pointer.inside = inViewport(p.x, p.y);
  if (!drag) return;

  if (drag.kind === 'pan') {
    viewX = drag.vx + (p.x - drag.sx);
    viewY = drag.vy + (p.y - drag.sy);
    return;
  }
  const o = findObject(drag.id);
  if (!o) { drag = null; return; }

  if (drag.kind === 'move') {
    o.x = snapValue(drag.startX + (w.x - drag.ox));
    o.y = snapValue(drag.startY + (w.y - drag.oy));
    if (o.width) clampInsideArena(o);
    return;
  }
  if (drag.kind === 'resize') applyResize(o, drag, w.x, w.y);
}

function onPointerUp(e) {
  if (!open) return;
  if (drag && drag.kind !== 'pan') persist();
  drag = null;
  if (canvas && e && e.pointerId !== undefined) {
    try { canvas.releasePointerCapture(e.pointerId); } catch (_) {}
  }
}

function onWheel(e) {
  if (!open || !canvas) return;
  const p = eventPos(e);
  if (!inViewport(p.x, p.y)) return;
  e.preventDefault();
  const before = screenToWorld(p.x, p.y);
  viewZoom = Math.max(0.25, Math.min(3, viewZoom * (e.deltaY < 0 ? 1.12 : 1 / 1.12)));
  const after = screenToWorld(p.x, p.y);
  viewX += (after.x - before.x) * viewZoom;
  viewY += (after.y - before.y) * viewZoom;
}

function onBlur() {
  drag = null;
}

function hitTest(sx, sy) {
  for (let i = hits.length - 1; i >= 0; i--) {
    const h = hits[i];
    if (sx >= h.x && sx <= h.x + h.w && sy >= h.y && sy <= h.y + h.h) return h;
  }
  return null;
}

// ── Keyboard ─────────────────────────────────────────────────────────────
// Capture phase + stopPropagation: the editor owns the keyboard while it is
// open, so none of these reach the match's own bindings.

// One place that changes the active tool, shared by the digit shortcuts and the
// top-bar buttons. Dropping the selection keeps an armed add/resize tool from
// acting on the object that was selected by the previous tool.
function setTool(id) {
  if (tool === id) return;
  tool = id;
  if (id !== TOOL_SELECT) selectedId = null;
}

function onKeyDown(e) {
  if (!open) return;
  let handled = true;
  switch (e.code) {
    case 'Digit1': case 'Digit2': case 'Digit3': case 'Digit4':
    case 'Digit5': case 'Digit6': case 'Digit7': {
      const def = TOOL_DEFS[parseInt(e.code.slice(5), 10) - 1];
      if (def) setTool(def.id);
      break;
    }
    case 'KeyF': persist(); if (playHandler) playHandler(); break;
    case 'KeyR': resetSandbox(); break;
    case 'KeyC': clearSandbox(); break;
    case 'KeyG': env.showGrid = !env.showGrid; invalidateSandboxBackground(); persist(); break;
    case 'KeyS': snap = !snap; break;
    case 'KeyH': fitView(); break;
    case 'Delete': case 'Backspace':
      if (selectedId) { removeObject(selectedId); persist(); }
      break;
    case 'Escape':
      if (selectedId && !e.shiftKey) selectedId = null;
      else closeSandboxEditor();
      break;
    case 'ArrowLeft': cycleKind(-1); break;
    case 'ArrowRight': cycleKind(1); break;
    default: handled = false;
  }
  if (handled) { e.preventDefault(); e.stopPropagation(); }
}

function onKeyUp(e) {
  if (open) e.stopPropagation();
}

// The kind pickers only mean something while an add tool is armed.
function cycleKind(dir) {
  if (tool === TOOL_PLATFORM) {
    const i = PLATFORM_TYPES.findIndex((t) => t.id === platformTypeId);
    platformTypeId = PLATFORM_TYPES[(i + dir + PLATFORM_TYPES.length) % PLATFORM_TYPES.length].id;
  } else if (tool === TOOL_DESTRUCTIBLE) {
    const i = DESTRUCTIBLE_KINDS.findIndex((k) => k.id === destructibleKindId);
    destructibleKindId = DESTRUCTIBLE_KINDS[(i + dir + DESTRUCTIBLE_KINDS.length) % DESTRUCTIBLE_KINDS.length].id;
  } else if (tool === TOOL_ENTITY) {
    const i = ALL_FIGHTERS.findIndex((f) => f.id === entityCharId);
    entityCharId = ALL_FIGHTERS[(i + dir + ALL_FIGHTERS.length) % ALL_FIGHTERS.length].id;
  }
}

// ── Document edits ───────────────────────────────────────────────────────
function addPlatform(wx, wy) {
  const t = platformType(platformTypeId);
  const o = {
    id: newId('p'),
    type: 'platform',
    typeId: t.id,
    x: snapValue(wx - t.w / 2),
    y: snapValue(wy - t.h / 2),
    width: t.w,
    height: t.h,
    isGround: false,
  };
  clampInsideArena(o);
  objects.push(o);
  selectedId = o.id;
  persist();
}

function addDestructible(wx, wy) {
  const kind = destructibleKind(destructibleKindId);
  const o = {
    id: newId('d'),
    type: 'destructible',
    kindId: kind.id,
    x: snapValue(wx - kind.w / 2),
    y: snapValue(wy - kind.h / 2),
    width: kind.w,
    height: kind.h,
    hp: kind.hp,
    maxHp: kind.hp,
  };
  clampInsideArena(o);
  objects.push(o);
  selectedId = o.id;
  persist();
}

function addEntity(wx, wy) {
  if (countEntities(objects) >= MAX_SANDBOX_FIGHTERS) return;
  const o = {
    id: newId('e'),
    type: 'entity',
    charId: entityCharId,
    control: entityControl,
    x: snapValue(wx),
    y: snapValue(wy),
  };
  objects.push(o);
  selectedId = o.id;
  persist();
}

export function clearSandbox() {
  objects = [];
  selectedId = null;
  persist();
}

export function resetSandbox() {
  env = defaultSandboxEnv(arenaW, arenaH);
  objects = defaultSandboxObjects(arenaW, arenaH);
  normalizeDocument();
  selectedId = null;
  invalidateSandboxBackground();
  fitView();
  persist();
}

function clampInsideArena(o) {
  o.x = Math.max(0, Math.min(arenaW - (o.width || 0), o.x));
  o.y = Math.max(0, Math.min(arenaH - (o.height || 0), o.y));
}

function snapshotRect(o) {
  return { x: o.x, y: o.y, width: o.width, height: o.height };
}

// ── Geometry ─────────────────────────────────────────────────────────────
function rectOf(o) {
  if (!o) return null;
  // A spawn is a point in the world; it gets a body-sized box so it is
  // comfortable to click.
  if (o.type === 'entity') return { x: o.x - 26, y: o.y - 78, width: 52, height: 84 };
  return { x: o.x, y: o.y, width: o.width, height: o.height };
}

function pickAt(wx, wy) {
  // Topmost first: later objects draw on top, so they pick first.
  for (let i = objects.length - 1; i >= 0; i--) {
    const r = rectOf(objects[i]);
    if (!r) continue;
    if (wx >= r.x && wx <= r.x + r.width && wy >= r.y && wy <= r.y + r.height) return objects[i];
  }
  return null;
}

// RESIZE handles: three corners plus the right edge, because width is the
// number people actually want to change on a platform.
const RESIZE_HANDLES = [
  { id: 'nw', dx: 0, dy: 0 },
  { id: 'ne', dx: 1, dy: 0 },
  { id: 'se', dx: 1, dy: 1 },
  { id: 'sw', dx: 0, dy: 1 },
  { id: 'e', dx: 1, dy: 0.5 },
];

function pickHandle(o, wx, wy) {
  const r = rectOf(o);
  if (!r) return null;
  const pad = 6 / viewZoom;
  for (let i = 0; i < RESIZE_HANDLES.length; i++) {
    const h = RESIZE_HANDLES[i];
    if (Math.abs(wx - (r.x + r.width * h.dx)) <= pad && Math.abs(wy - (r.y + r.height * h.dy)) <= pad) return h;
  }
  return null;
}

function applyResize(o, d, wx, wy) {
  const s = d.start;
  const dx = wx - d.ox;
  const dy = wy - d.oy;

  if (o.type === 'entity') {
    o.x = snapValue(s.x + dx);
    o.y = snapValue(s.y + dy);
    return;
  }
  // Standard box resize, with the opposite edge pinned: a left-edge handle
  // moves the left edge (right stays put), a right-edge handle moves the right
  // edge, a top-edge handle moves the top edge (bottom stays put) and a
  // bottom-edge handle moves the bottom edge. A side handle has no vertical
  // meaning, so it scales height from the pinned top.
  if (d.handle.dx === 0) {
    const nx = snapValue(s.x + dx);
    o.x = nx;
    o.width = Math.max(MIN_SIZE, s.x + s.width - nx);
  } else {
    o.width = Math.max(MIN_SIZE, snapValue(s.width + dx) - s.x);
  }
  if (d.handle.dy === 0) {
    const ny = snapValue(s.y + dy);
    o.y = ny;
    o.height = Math.max(MIN_SIZE, s.y + s.height - ny);
  } else {
    o.height = Math.max(MIN_SIZE, s.height + dy);
  }
  clampInsideArena(o);
}

// ── Render ───────────────────────────────────────────────────────────────
export function renderSandboxEditor() {
  if (!open || !ctx) return;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, arenaW, arenaH);

  hits.length = 0;
  drawViewport();
  drawPanel();
  drawTopbar();
  drawStatus();
}

// The live arena: background, then the REAL stage renderer over the real
// document, then the breakables, then the spawn previews. Nothing here is a
// mock-up of the play view — it is the same draw calls.
function drawViewport() {
  const vp = viewport();
  ctx.save();
  ctx.beginPath();
  ctx.rect(vp.x, vp.y, vp.w, vp.h);
  ctx.clip();
  ctx.fillStyle = BG_SOFT;
  ctx.fillRect(vp.x, vp.y, vp.w, vp.h);

  ctx.save();
  ctx.translate(viewX, viewY);
  ctx.scale(viewZoom, viewZoom);

  ctx.fillStyle = env.backgroundColor || backgroundPreset(env.background).color;
  ctx.fillRect(0, 0, arenaW, arenaH);
  drawGrid();
  ctx.strokeStyle = LINE;
  ctx.lineWidth = 2;
  ctx.strokeRect(0, 0, arenaW, arenaH);

  drawStage(ctx, { platforms: platformRecords() }, time, env.platformColor);
  drawDestructibleObjects();
  drawEntityPreviews();
  drawSelection();
  drawHoverOutline();

  ctx.restore();
  ctx.restore();
}

function drawGrid() {
  if (!env.showGrid) return;
  const step = Math.max(10, env.gridSize || 40);
  ctx.strokeStyle = env.gridColor || backgroundPreset(env.background).grid;
  ctx.lineWidth = 1 / viewZoom;
  ctx.beginPath();
  for (let x = step; x < arenaW; x += step) { ctx.moveTo(x, 0); ctx.lineTo(x, arenaH); }
  for (let y = step; y < arenaH; y += step) { ctx.moveTo(0, y); ctx.lineTo(arenaW, y); }
  ctx.stroke();
}

function platformRecords() {
  const out = [];
  for (let i = 0; i < objects.length; i++) {
    const o = objects[i];
    if (o.type !== 'platform') continue;
    const t = platformType(o.typeId);
    const p = {
      x: o.x, y: o.y, baseY: o.y,
      width: o.width, height: o.height,
      isGround: !!o.isGround,
      canDropThrough: o.isGround ? false : t.canDropThrough,
      color: o.color || t.color,
    };
    if (t.bob) { p.bobSpeed = 1.0; p.bobAmp = 3; p.bobPhase = 0; }
    out.push(p);
  }
  return out;
}

function drawDestructibleObjects() {
  for (let i = 0; i < objects.length; i++) {
    const o = objects[i];
    if (o.type !== 'destructible') continue;
    const kind = destructibleKind(o.kindId);
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.fillRect(o.x + 4, o.y + 4, o.width, o.height);
    ctx.fillStyle = kind.color;
    ctx.fillRect(o.x, o.y, o.width, o.height);
    ctx.fillStyle = kind.plank;
    ctx.fillRect(o.x, o.y, o.width, Math.max(2, o.height * 0.28));
    ctx.strokeStyle = kind.edge;
    ctx.lineWidth = 2;
    ctx.strokeRect(o.x + 1, o.y + 1, o.width - 2, o.height - 2);
    if (viewZoom >= 0.55) {
      ctx.font = F_SMALL;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillStyle = CREAM_DIM;
      ctx.fillText(kind.name, o.x + o.width / 2, o.y + o.height + 5);
    }
  }
}

// A live preview built from the REAL fighter factory and the REAL fighter
// renderer, so what you place is exactly what spawns. Cached per character and
// never stepped — it is a still pose, not a simulation.
const _previews = new Map();
function previewFighterFor(def) {
  const key = def ? def.id : 'none';
  let f = _previews.get(key);
  if (!f) {
    f = createFighter(1, 0, 0, resolveFighterSkin(def), { id: `preview-${key}` });
    f.state = 'idle';
    // Same gear the real spawn hands this character, so the marker you are
    // placing looks like the fighter that will appear there — a boxer placed on
    // a platform previews with its gloves on.
    f.handGear = loadHandGearFor(def.id, def.handGear);
    _previews.set(key, f);
  }
  return f;
}

function drawEntityPreviews() {
  for (let i = 0; i < objects.length; i++) {
    const o = objects[i];
    if (o.type !== 'entity') continue;
    const def = ALL_FIGHTERS.find((f) => f.id === o.charId) || ALL_FIGHTERS[0];
    const f = previewFighterFor(def);
    f.x = o.x;
    f.y = o.y;
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.beginPath();
    ctx.ellipse(o.x, o.y + 24, 22, 7, 0, 0, Math.PI * 2);
    ctx.fill();
    try { drawFighter(ctx, f, time); } catch (_) {}
    ctx.font = F_SMALL;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillStyle = o.control === 'human' ? '#7fd4ff' : o.control === 'dummy' ? CREAM_DIM : ACCENT;
    ctx.fillText(`${controlLabel(o.control)} · ${def ? def.name : o.charId}`, o.x, o.y - 76);
  }
}

function controlLabel(control) {
  return control === 'human' ? 'P1/P2' : control === 'dummy' ? 'IDLE' : 'AI';
}

function drawSelection() {
  const o = selectedId ? findObject(selectedId) : null;
  if (!o) return;
  const r = rectOf(o);
  ctx.strokeStyle = ACCENT;
  ctx.lineWidth = 2 / viewZoom;
  ctx.setLineDash([6, 4]);
  ctx.strokeRect(r.x, r.y, r.width, r.height);
  ctx.setLineDash([]);
  if (o.type !== 'entity') drawHandles(r);
  if (o.type === 'destructible') drawDestructibleHp(ctx, o);
  drawInspectorLabel(o, r);
}

function drawHandles(r) {
  const s = 4 / viewZoom;
  ctx.fillStyle = BG;
  ctx.strokeStyle = ACCENT;
  ctx.lineWidth = 1.5 / viewZoom;
  for (let i = 0; i < RESIZE_HANDLES.length; i++) {
    const h = RESIZE_HANDLES[i];
    const hx = r.x + r.width * h.dx;
    const hy = r.y + r.height * h.dy;
    ctx.beginPath();
    ctx.rect(hx - s, hy - s, s * 2, s * 2);
    ctx.fill();
    ctx.stroke();
  }
}

function drawHoverOutline() {
  if (!pointer.inside || drag) return;
  if (tool !== TOOL_MOVE && tool !== TOOL_RESIZE) return;
  const o = pickAt(pointer.worldX, pointer.worldY);
  if (!o || o.id === selectedId) return;
  const r = rectOf(o);
  ctx.strokeStyle = 'rgba(232,194,90,0.4)';
  ctx.lineWidth = 1 / viewZoom;
  ctx.strokeRect(r.x, r.y, r.width, r.height);
}

function drawInspectorLabel(o, r) {
  const lines = inspectorLines(o);
  ctx.font = F_BODY;
  let w = 0;
  for (let i = 0; i < lines.length; i++) w = Math.max(w, ctx.measureText(lines[i]).width);
  w += 12;
  const ly = r.y - 10 - lines.length * 13;
  ctx.fillStyle = 'rgba(0,0,0,0.75)';
  ctx.fillRect(r.x, ly, w, lines.length * 13 + 6);
  ctx.textAlign = 'left';
  for (let i = 0; i < lines.length; i++) {
    ctx.fillStyle = i === 0 ? ACCENT : CREAM_MUT;
    ctx.textBaseline = 'bottom';
    ctx.fillText(lines[i], r.x + 6, ly + 13 * (i + 1));
  }
}

function inspectorLines(o) {
  if (o.type === 'platform') {
    const t = platformType(o.typeId);
    return [`${t.name}${o.isGround ? ' · GROUND' : ''}`, `${o.x}, ${o.y}  ${o.width}×${o.height}`];
  }
  if (o.type === 'destructible') {
    const kind = destructibleKind(o.kindId);
    return [`${kind.name}  ${Math.round(o.hp)}/${o.maxHp} HP`, 'durability is per-PLAY run'];
  }
  const def = ALL_FIGHTERS.find((f) => f.id === o.charId);
  return [`${def ? def.name : o.charId} · ${o.control.toUpperCase()}`, 'edit control in the panel'];
}

// ── Chrome ───────────────────────────────────────────────────────────────
function drawTopbar() {
  ctx.fillStyle = BG_SOFT;
  ctx.fillRect(0, 0, arenaW, TOPBAR_H);
  ctx.strokeStyle = LINE;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(0, TOPBAR_H - 1);
  ctx.lineTo(arenaW, TOPBAR_H - 1);
  ctx.stroke();

  ctx.font = F_TITLE;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = ACCENT;
  ctx.fillText('SANDBOX EDITOR', PAD, TOPBAR_H / 2);

  let x = 210;
  for (let i = 0; i < TOOL_DEFS.length; i++) {
    const t = TOOL_DEFS[i];
    const active = tool === t.id;
    const label = `${t.key} ${t.name}`;
    ctx.font = active ? F_HEAD : F_BODY;
    const w = ctx.measureText(label).width + 16;
    // Registered as a hit so the toolbar is clickable, not keyboard-only: the
    // digit shortcut and the mouse pick the same setTool() path.
    hits.push({ id: `tool:${t.id}`, x: x - 6, y: TOPBAR_H / 2 - 12, w, h: 24, onClick: () => setTool(t.id), kind: 'button' });
    if (active) {
      ctx.fillStyle = BG_RAISE;
      ctx.fillRect(x - 6, TOPBAR_H / 2 - 12, w, 24);
    }
    ctx.strokeStyle = active ? ACCENT : LINE;
    ctx.lineWidth = 1;
    ctx.strokeRect(x - 6, TOPBAR_H / 2 - 12, w, 24);
    ctx.fillStyle = active ? ACCENT : CREAM_DIM;
    ctx.fillText(label, x + 2, TOPBAR_H / 2);
    x += w + 8;
  }

  drawButton('PLAY  [F]', arenaW - PAD, TOPBAR_H / 2, () => { persist(); if (playHandler) playHandler(); });
}

function drawButton(label, right, cy, onClick, accent) {
  ctx.font = F_BODY;
  const w = ctx.measureText(label).width + 20;
  const x = right - w;
  const y = cy - 12;
  hits.push({ id: `btn:${label}`, x, y, w, h: 24, onClick, kind: 'button' });
  ctx.fillStyle = accent ? ACCENT : BG_RAISE;
  ctx.fillRect(x, y, w, 24);
  ctx.strokeStyle = accent ? ACCENT : LINE;
  ctx.lineWidth = 1;
  ctx.strokeRect(x + 0.5, y + 0.5, w - 1, 23);
  ctx.fillStyle = accent ? BG : CREAM;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, x + w / 2, cy + 1);
}

function drawPanel() {
  const y0 = TOPBAR_H;
  const h = arenaH - TOPBAR_H - STATUS_H;
  ctx.fillStyle = BG_SOFT;
  ctx.fillRect(0, y0, PANEL_W, h);
  ctx.strokeStyle = LINE;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(PANEL_W - 1, y0);
  ctx.lineTo(PANEL_W - 1, y0 + h);
  ctx.stroke();

  const x = PAD;
  const w = PANEL_W - PAD * 2;
  let y = y0 + 20;

  y = section('ENVIRONMENT', y, x, w);
  y = row('BACKGROUND', backgroundPreset(env.background).name, x, y, w, () => {
    const i = BACKGROUND_PRESETS.findIndex((p) => p.id === env.background);
    const n = BACKGROUND_PRESETS[(i + 1) % BACKGROUND_PRESETS.length];
    env.background = n.id;
    env.backgroundColor = n.color;
    env.gridColor = n.grid;
    invalidateSandboxBackground();
    persist();
  });
  y = row('PLATFORM COLOR', env.platformColor.toUpperCase(), x, y, w, () => {
    const i = PLATFORM_COLOR_CYCLE.indexOf(env.platformColor);
    env.platformColor = PLATFORM_COLOR_CYCLE[(i + 1) % PLATFORM_COLOR_CYCLE.length];
    persist();
  });
  y = row('GRID', env.showGrid ? 'ON' : 'OFF', x, y, w, () => {
    env.showGrid = !env.showGrid;
    invalidateSandboxBackground();
    persist();
  });
  y = row('SNAP', snap ? 'ON' : 'OFF', x, y, w, () => { snap = !snap; });
  y = row('CAMERA', env.cameraBounds === false ? 'FREE' : 'ARENA', x, y, w, () => {
    env.cameraBounds = env.cameraBounds === false;
    persist();
  });
  y += 10;

  y = section('ADD', y, x, w);
  y = row('PLATFORM', platformType(platformTypeId).name, x, y, w, () => cycleKind(1), tool === TOOL_PLATFORM);
  y = row('BREAKABLE', destructibleKind(destructibleKindId).name, x, y, w, () => cycleKind(1), tool === TOOL_DESTRUCTIBLE);
  y = row('SPAWN CHAR', charName(entityCharId), x, y, w, () => cycleKind(1), tool === TOOL_ENTITY);
  y = row('SPAWN CTRL', entityControl.toUpperCase(), x, y, w, () => {
    entityControl = nextControl(entityControl);
    applyControlToSelection();
  }, tool === TOOL_ENTITY);
  y = hint(`click the arena to place · ${countEntities(objects)}/${MAX_SANDBOX_FIGHTERS} placed`, x, y, w);
  y += 10;

  y = section('SELECTED', y, x, w);
  const sel = selectedId ? findObject(selectedId) : null;
  if (!sel) {
    y = hint('nothing selected', x, y, w);
    y = hint('pick a tool (1-7), then click the arena', x, y, w);
  } else {
    y = numRow('X', sel.x, x, y, w, (v) => { sel.x = v; if (sel.width) clampInsideArena(sel); });
    y = numRow('Y', sel.y, x, y, w, (v) => { sel.y = v; if (sel.height) clampInsideArena(sel); });
    if (sel.type !== 'entity') {
      y = numRow('W', sel.width, x, y, w, (v) => { sel.width = Math.max(MIN_SIZE, v); clampInsideArena(sel); });
      y = numRow('H', sel.height, x, y, w, (v) => { sel.height = Math.max(MIN_SIZE, v); clampInsideArena(sel); });
    }
    if (sel.type === 'destructible') {
      y = numRow('HP', sel.hp, x, y, w, (v) => {
        sel.hp = Math.max(1, Math.min(sel.maxHp, v));
        // The documented cap is one kind-HP of headroom; anything past that is
        // allowed too, it just makes an unreasonably tough board.
        sel.maxHp = Math.max(sel.maxHp, sel.hp);
      });
    }
    if (sel.type === 'platform') {
      y = row('TYPE', platformType(sel.typeId).name, x, y, w, () => {
        const i = PLATFORM_TYPES.findIndex((t) => t.id === sel.typeId);
        const t = PLATFORM_TYPES[(i + 1) % PLATFORM_TYPES.length];
        sel.typeId = t.id;
        sel.width = t.w;
        sel.height = t.h;
        clampInsideArena(sel);
        persist();
      });
      y = row('GROUND', sel.isGround ? 'YES' : 'NO', x, y, w, () => {
        if (sel.isGround) { sel.isGround = false; persist(); return; }
        for (const o of objects) if (o.type === 'platform') o.isGround = false;
        sel.isGround = true;
        persist();
      });
    }
    if (sel.type === 'entity') {
      y = row('CHAR', charName(sel.charId), x, y, w, () => {
        const i = ALL_FIGHTERS.findIndex((f) => f.id === sel.charId);
        sel.charId = ALL_FIGHTERS[(i + 1) % ALL_FIGHTERS.length].id;
        persist();
      });
      y = row('CONTROL', sel.control.toUpperCase(), x, y, w, () => {
        sel.control = nextControl(sel.control);
        entityControl = sel.control;
        persist();
      });
    }
    y = button('DELETE OBJECT', x, y, w, () => { removeObject(sel.id); persist(); });
  }
  y += 10;

  y = section('DOCUMENT', y, x, w);
  y = hint(`platforms   ${objects.filter((o) => o.type === 'platform').length}`, x, y, w);
  y = hint(`breakables  ${countDestructibles(objects)}`, x, y, w);
  y = hint(`spawns      ${countEntities(objects)}/${MAX_SANDBOX_FIGHTERS}`, x, y, w);
  y += 6;
  y = button('CLEAR ALL  [C]', x, y, w, clearSandbox);
  y = button('RESET ARENA  [R]', x, y, w, resetSandbox);
  y = button('FIT VIEW  [H]', x, y, w, fitView);
  y = button('PLAY / TEST  [F]', x, y, w, () => { persist(); if (playHandler) playHandler(); }, true);
  y = button('BACK TO MENU  [ESC]', x, y, w, closeSandboxEditor);
  y += 10;

  section('CONTROLS', y, x, w);
  y = hint('1-7  select a tool      [ ]  change the kind', x, y, w);
  y = hint('right-drag or middle-drag  pan the view', x, y, w);
  y = hint('wheel  zoom        Del  delete selection', x, y, w);
  y = hint('G grid   S snap   H fit   F play', x, y, w);
  y = hint('Esc  deselect, then back to the menu', x, y, w);
}

const PLATFORM_COLOR_CYCLE = ['#4a7a4a', '#3a5a3a', '#54684f', '#5a4a7a', '#7a5a3a', '#3d4f5a', '#7a3a3a'];

function nextControl(control) {
  return control === 'human' ? 'bot' : control === 'bot' ? 'dummy' : 'human';
}

function applyControlToSelection() {
  const sel = selectedId ? findObject(selectedId) : null;
  if (sel && sel.type === 'entity') { sel.control = entityControl; persist(); }
}

function charName(charId) {
  const def = ALL_FIGHTERS.find((f) => f.id === charId);
  return def ? def.name : '?';
}

function section(label, y, x, w) {
  ctx.font = F_HEAD;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = ACCENT;
  ctx.fillText(label, x, y);
  ctx.strokeStyle = LINE;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x, y + 5);
  ctx.lineTo(x + w, y + 5);
  ctx.stroke();
  return y + 20;
}

function row(label, value, x, y, w, onClick, active) {
  const h = 20;
  hits.push({ id: `row:${label}`, x, y, w, h, onClick, kind: 'button' });
  if (active) {
    ctx.fillStyle = BG_RAISE;
    ctx.fillRect(x, y, w, h);
  }
  ctx.font = F_BODY;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = CREAM_MUT;
  ctx.fillText(label, x + 6, y + h / 2);
  ctx.fillStyle = CREAM;
  ctx.textAlign = 'right';
  ctx.fillText(String(value), x + w - 6, y + h / 2);
  ctx.textAlign = 'left';
  return y + h + 3;
}

// A numeric inspector row: [−] value [+] with a click on the value opening the
// shared typed-entry modal, so an exact coordinate is one click away instead of
// a fiddly drag.
function numRow(label, value, x, y, w, onSet) {
  const h = 20;
  const stepW = 18;
  const minusX = x + w - 96;
  const plusX = x + w - stepW;
  hits.push({ id: `num:${label}:-`, x: minusX, y, w: stepW, h, onClick: () => onSet(Math.round(value) - 10), kind: 'button' });
  hits.push({ id: `num:${label}:+`, x: plusX, y, w: stepW, h, onClick: () => onSet(Math.round(value) + 10), kind: 'button' });
  stepper(minusX, y, stepW, h, '−');
  stepper(plusX, y, stepW, h, '+');

  const valX = minusX + stepW + 4;
  const valW = plusX - (minusX + stepW) - 8;
  hits.push({ id: `num:${label}`, x: valX, y, w: valW, h, onClick: () => promptNumber(label, value, onSet), kind: 'button' });
  ctx.fillStyle = BG_RAISE;
  ctx.fillRect(valX, y, valW, h);
  ctx.font = F_BODY;
  ctx.fillStyle = CREAM;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(String(Math.round(value)), valX + valW / 2, y + h / 2);
  ctx.textAlign = 'left';
  return y + h + 3;
}

function stepper(x, y, w, h, glyph) {
  ctx.fillStyle = BG_RAISE;
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = LINE;
  ctx.lineWidth = 1;
  ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
  ctx.font = F_BODY;
  ctx.fillStyle = CREAM_MUT;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(glyph, x + w / 2, y + h / 2 + 1);
  ctx.textAlign = 'left';
}

function promptNumber(label, value, onSet) {
  if (typeof showModal !== 'function') return;
  showModal(label, String(Math.round(value)), (text) => {
    const v = parseInt(text, 10);
    if (!isNaN(v)) onSet(v);
  }, 'SET', 'CANCEL', true);
}

function button(label, x, y, w, onClick, accent) {
  const h = 22;
  hits.push({ id: `btn:${label}`, x, y, w, h, onClick, kind: 'button' });
  ctx.fillStyle = accent ? ACCENT : BG_RAISE;
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = accent ? ACCENT : LINE;
  ctx.lineWidth = 1;
  ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
  ctx.font = F_BODY;
  ctx.fillStyle = accent ? BG : CREAM;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, x + 8, y + h / 2 + 1);
  return y + h + 4;
}

function hint(text, x, y, w) {
  ctx.font = F_SMALL;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = CREAM_DIM;
  ctx.fillText(text, x + 6, y + 9);
  return y + 14;
}

function drawStatus() {
  const y = arenaH - STATUS_H;
  ctx.fillStyle = BG_SOFT;
  ctx.fillRect(0, y, arenaW, STATUS_H);
  ctx.strokeStyle = LINE;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(0, y + 1);
  ctx.lineTo(arenaW, y + 1);
  ctx.stroke();
  ctx.font = F_SMALL;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = CREAM_DIM;
  const w = pointer.inside ? `${Math.round(pointer.worldX)} , ${Math.round(pointer.worldY)}` : '—, —';
  ctx.fillText(`WORLD ${w}    ZOOM ${(viewZoom * 100).toFixed(0)}%    ${toolName(tool)}    SNAP ${snap ? 'ON' : 'OFF'}`, PAD, y + STATUS_H / 2);
  ctx.textAlign = 'right';
  ctx.fillText('the sandbox arena is separate — the main map is never touched', arenaW - PAD, y + STATUS_H / 2);
}

function toolName(id) {
  const t = TOOL_DEFS.find((d) => d.id === id);
  return t ? t.name : '?';
}
