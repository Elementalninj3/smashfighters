// Effects.js — fighter rendering, plus the hand pose/colour configuration the
// renderer samples. The body is always drawn the same way; hands and weapons
// come from ONE of two sources:
//   • animator output (fighter.anim.out) — keyframeable hands + weapons
//   • the legacy neutral pose system below — fallback
//
// Layering: drawables with z < 0 sit behind the body, everything else (z ≥ 0)
// draws on top. When no animator is attached nothing changes and the actor
// looks exactly as before.
//
// The hand configuration lives here rather than in its own module because the
// renderer is its only consumer of the pose data: it samples `handConfig` and
// `resolveHandColor` while drawing. The menu and the character-select screen
// reach them by importing them from this module.

import { drawAccessory, getSkinImage } from './Accessories.js';
import { drawHandGear } from './HandGear.js';
import { drawWeapon, getWeapon } from '../anim/weapons.js';
import { getVfxEffect } from '../effects/vfx.js';

// ═══════════════════════════════════════════════════════════════════════
// HAND POSE + COLOUR CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════
// Hand pose configuration for the movement sandbox. The keyframe animation
// engine, weapon hand slots, and ability metadata are gone. This section keeps
// only the neutral resting pose that the fighter renderer samples for idle
// hands, plus the hand-color resolution stack.
//
// Values are SIGNED factors of the fighter's body radius (1.0 = one radius).
// Positive X = toward the facing direction; +Y = down (screen axes).

// Applied at boot beneath any live localStorage edits (was the AERIAL HVY preset
// shipped with the first boot when no saved config existed yet).
export const SAVED_HAND_CONFIG = null;

export const HAND_COLOR_OPTIONS = [
  { value: 'auto',   label: 'BODY' },
  { value: '#ffd9a8', label: 'SKIN' },
  { value: '#ffffff', label: 'WHITE' },
  { value: '#ffd84d', label: 'YELLOW' },
  { value: '#ff5555', label: 'RED' },
  { value: '#222222', label: 'BLACK' },
  { value: '#aaff66', label: 'GREEN' },
];

const REST_POSE = { back: { x: 0.82, y: 0.25 }, front: { x: 0.96, y: -0.10 } };
const LUNGE_POSE = { back: { x: 0.95, y: 0.55 }, front: { x: 1.45, y: 0.10 } };

export const DEFAULT_HAND_CONFIG = {
  handColor: 'auto',
  actions: {
    neutral: {
      start: REST_POSE,
      stop: clonePose(REST_POSE),
      airLiftY: 0.22,    // how high the hands float when airborne
      airSpreadX: 0.08,  // how far out to the sides when airborne
    },
    gndLight: { start: clonePose(REST_POSE), stop: clonePose(LUNGE_POSE) },
    gndHeavy: { start: clonePose(REST_POSE), stop: clonePose(LUNGE_POSE) },
    airLight: { start: clonePose(REST_POSE), stop: clonePose(LUNGE_POSE) },
    airHeavy: { start: clonePose(REST_POSE), stop: clonePose(LUNGE_POSE) },
  },
};

function clonePose(p) {
  return { back: { x: p.back.x, y: p.back.y }, front: { x: p.front.x, y: p.front.y } };
}

export function cloneDefaults() {
  return JSON.parse(JSON.stringify(DEFAULT_HAND_CONFIG));
}

export const handConfig = cloneDefaults();

// Deep-merge a saved config (from localStorage) over the live config so any
// user-tuned poses survive reloads. Non-combat action ids are ignored when the
// stored config is newer than this module (its actions map still wins).
function isFiniteNum(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

function applyPoseTo(target, saved) {
  if (!saved || typeof saved !== 'object') return;
  for (const hand of ['back', 'front']) {
    const sh = saved[hand];
    if (!sh || typeof sh !== 'object') continue;
    if (isFiniteNum(sh.x)) target[hand].x = clampHandValue(sh.x);
    if (isFiniteNum(sh.y)) target[hand].y = clampHandValue(sh.y);
  }
}

export function applySavedConfig(saved) {
  if (!saved || typeof saved !== 'object') return;
  if (typeof saved.handColor === 'string') handConfig.handColor = saved.handColor;
  if (saved.actions && typeof saved.actions === 'object') {
    for (const id of Object.keys(handConfig.actions)) {
      const act = saved.actions[id];
      if (!act || typeof act !== 'object') continue;
      const target = handConfig.actions[id];
      if (act.start) applyPoseTo(target.start, act.start);
      if (act.stop) applyPoseTo(target.stop, act.stop);
      if (id === 'neutral') {
        if (isFiniteNum(act.airLiftY)) target.airLiftY = act.airLiftY;
        if (isFiniteNum(act.airSpreadX)) target.airSpreadX = act.airSpreadX;
      }
    }
  }
}

// Boot merge: stored file baseline, then any auto-saved localStorage edits.
const HAND_CONFIG_STORAGE_KEY = 'smashfighters.hands';
applySavedConfig(SAVED_HAND_CONFIG);
if (typeof localStorage !== 'undefined') {
  try {
    const raw = localStorage.getItem(HAND_CONFIG_STORAGE_KEY);
    if (raw) applySavedConfig(JSON.parse(raw));
  } catch (err) {
    // ignore corrupt storage
  }
}

// Persist the current live config so tunes survive a full page reload.
export function persistHandConfigToStorage() {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(HAND_CONFIG_STORAGE_KEY, JSON.stringify(handConfig));
  } catch (err) {
    // storage unavailable — fine
  }
}

export function clearHandConfigStorage() {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.removeItem(HAND_CONFIG_STORAGE_KEY);
  } catch (err) {
    // ignore
  }
}

export function resetHandConfig() {
  Object.assign(handConfig, cloneDefaults());
}

export function clampHandValue(value) {
  const clamped = Math.min(2, Math.max(-2, value));
  return Math.round(clamped * 100) / 100;
}

// ── Per-character hand colors ────────────────────────────────────────────
// A hand color can be pinned per fighter id (hexcode or any CSS color name).
// Resolution order: character override → global HAND COLOR setting → body color.
const CHAR_COLOR_KEY = 'smashfighters.charHandColors';
// Built-in defaults: ninja wears near-black gloves.
const DEFAULT_CHAR_HAND_COLORS = { ninja: '#0B0A0B' };
let charHandColors = { ...DEFAULT_CHAR_HAND_COLORS };
if (typeof localStorage !== 'undefined') {
  try {
    const raw = localStorage.getItem(CHAR_COLOR_KEY);
    if (raw) charHandColors = { ...DEFAULT_CHAR_HAND_COLORS, ...(JSON.parse(raw) || {}) };
  } catch (err) {
    charHandColors = { ...DEFAULT_CHAR_HAND_COLORS };
  }
}

// Canvas probe result cache — validating the same color string repeatedly
// (every render frame) shouldn't allocate a new probe context each time.
const validColorCache = new Map();

export function isValidColor(value) {
  if (typeof value !== 'string') return false;
  const s = value.trim();
  if (validColorCache.has(s)) return validColorCache.get(s);
  let valid;
  if (/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(s)) valid = true;
  else {
    try {
      const probe = document.createElement('canvas').getContext('2d');
      probe.fillStyle = s;
      valid = probe.fillStyle !== '' && probe.fillStyle !== 'rgba(0, 0, 0, 0)';
    } catch (err) {
      valid = false;
    }
  }
  validColorCache.set(s, valid);
  return valid;
}

export function charHandColorFor(id) {
  if (!id) return null;
  const c = charHandColors[id];
  return c && isValidColor(c) ? c.trim() : null;
}

export function setCharHandColor(id, color) {
  if (!id) return;
  const clean = typeof color === 'string' ? color.trim() : '';
  if (!clean) delete charHandColors[id];
  else if (isValidColor(clean)) charHandColors[id] = clean;
  else return;
  persistCharHandColors();
}

export function clearCharHandColor(id) {
  if (!id) return;
  delete charHandColors[id];
  persistCharHandColors();
}

export function persistCharHandColors() {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(CHAR_COLOR_KEY, JSON.stringify(charHandColors));
  } catch (err) {
    // ignore
  }
}

// Resolve the fill color for a fighter's hands: per-character override wins,
// then the built-in per-character default (ninja = near-black gloves),
// then the global HAND COLOR, then the body color.
export function resolveHandColor(fighterId, bodyColor) {
  const perChar = charHandColorFor(fighterId);
  if (perChar) return perChar;
  if (fighterId === 'ninja' && DEFAULT_CHAR_HAND_COLORS.ninja) return DEFAULT_CHAR_HAND_COLORS.ninja;
  const c = handConfig && handConfig.handColor;
  if (typeof c === 'string' && c !== 'auto' && isValidColor(c)) return c;
  return bodyColor;
}

// ═══════════════════════════════════════════════════════════════════════
// RENDERER
// ═══════════════════════════════════════════════════════════════════════

// Reused drawable buffer — collectAnimatedItems is called every animated frame
// and would otherwise allocate a fresh array + copies each time. The resolved
// out objects already carry `type` ('hand'|'weapon') and are rebuilt in place
// by the animator, so we push them straight into a reusable sorted list.
const _animatedItems = [];
const _SIDES = ['left', 'right'];
const _DEG_TO_RAD = Math.PI / 180;
function _byZ(a, b) { return (a.z || 0) - (b.z || 0); }

// The default projectile orb's body gradient, built once at UNIT radius and
// reused at any size through a scale() transform. Built per canvas context, so a
// context swap (new canvas / re-created 2D handle) transparently gets its own.
let _orbGradCtx = null;
let _orbGrad = null;
function orbGradient(ctx) {
  if (_orbGrad && _orbGradCtx === ctx) return _orbGrad;
  _orbGradCtx = ctx;
  _orbGrad = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
  _orbGrad.addColorStop(0, 'rgba(255,255,255,0.95)');
  _orbGrad.addColorStop(0.4, 'rgba(120,220,255,0.9)');
  _orbGrad.addColorStop(1, 'rgba(80,140,255,0)');
  return _orbGrad;
}

// ── View culling ─────────────────────────────────────────────────────────
// World-space visible rect, set once per frame by Game.js render() via
// setViewBounds(). Worlds outside it (with margin) skip all drawing — body,
// hands, gear, accessories, horses, projectiles. Margin covers hand/weapon
// reach, shadows and arrows so nothing pops at the edge.
let _vx0 = -1e9, _vy0 = -1e9, _vx1 = 1e9, _vy1 = 1e9;
export function setViewBounds(x0, y0, x1, y1) {
  _vx0 = x0; _vy0 = y0; _vx1 = x1; _vy1 = y1;
}
function _inView(x, y, m) {
  return x > _vx0 - m && x < _vx1 + m && y > _vy0 - m && y < _vy1 + m;
}

function collectAnimatedItems(fighter) {
  const out = fighter.anim.out;
  const items = _animatedItems;
  items.length = 0;
  for (const side of _SIDES) {
    const h = out.hands[side];
    if (h && h.visible !== false && h.opacity > 0) {
      // Tag which arm this is. The animator's own `side` field is the shared
      // 'hand'/'weapon' type tag that resolveHand rewrites every sample, so the
      // left/right identity has to ride on a separate field. Set here, right
      // before the draw pass reads it in the same frame, and never relied on
      // outside drawAnimatedLayer — it exists to pick the matching hand gear.
      h._gearSide = side;
      items.push(h);
    }
    const w = out.weapons[side];
    if (w && w.visible !== false && w.opacity > 0) items.push(w);
  }
  items.sort(_byZ);
  return items;
}

// Per-fighter cached hand-base position { x, y } — updated in place so the
// legacy render path never allocates a new object each frame.
function _hb(fighter, key, x, y) {
  const cache = fighter._handCache || (fighter._handCache = {});
  let obj = cache[key];
  if (!obj) obj = cache[key] = { x, y };
  else { obj.x = x; obj.y = y; }
  return obj;
}

// Per-fighter cached hand draw-state (layer, px, py, scale, rotation,
// opacity, visibility). Updated in place each frame.
function _hst(fighter, key, px, py, layer) {
  const cache = fighter._handStateCache || (fighter._handStateCache = {});
  let st = cache[key];
  if (!st) {
    st = cache[key] = {
      layer, px, py,
      sx: 1, sy: 1,
      rot: 0,
      opacity: 1,
      visible: true,
    };
  } else {
    st.layer = layer;
    st.px = px;
    st.py = py;
  }
  return st;
}

function directionalShadow(ctx, x, y, radius) {
  ctx.fillStyle = 'rgba(0,0,0,0.2)';
  ctx.beginPath();
  ctx.ellipse(x, y + radius + 2, radius * 0.8, radius * 0.3, 0, 0, Math.PI * 2);
  ctx.fill();
}

function lookUpSkin(skin) {
  if (!skin) return { loaded: false, img: null };
  if (skin.loaded) return skin;
  if (skin.path) {
    const entry = getSkinImage(skin.path);
    if (entry && entry.status === 'loaded' && entry.img) {
      skin.loaded = true;
      skin.img = entry.img;
    }
  }
  return skin;
}

function drawBody(ctx, fighter, skin) {
  const { x, y, radius, color, skinScale, skinCenter } = fighter;
  if (skin && skin.img) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.clip();

    const img = skin.img;
    const ss = skinScale || 1;
    const size = radius * 2 * ss;
    const scale = size / Math.min(img.width, img.height);
    const drawW = img.width * scale;
    const drawH = img.height * scale;
    const cx = skinCenter ? skinCenter.x * scale : 0;
    const cy = skinCenter ? skinCenter.y * scale : 0;

    ctx.drawImage(img, x - drawW / 2 + cx, y - drawH / 2 + cy, drawW, drawH);
    ctx.restore();
  } else {
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
  }

  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.strokeStyle = '#222222';
  ctx.lineWidth = 3;
  ctx.stroke();
}

// One animated hand: the hand circle, then whatever gear is worn on THAT arm.
// The gear is drawn inside this same save/restore so it inherits the hand's
// opacity, and it is rotated with the hand so a glove stays aligned to the fist
// through a punch. It is sized off the hand's own drawn radius (not the base
// handR) so a resized hand scales its glove with it.
function drawAnimatedHand(ctx, st, handR, handFill, gear) {
  const rx = (st.width > 0 ? st.width / 2 : handR) * Math.abs(st.scaleX || 1);
  const ry = (st.height > 0 ? st.height / 2 : handR) * Math.abs(st.scaleY || 1);
  ctx.save();
  ctx.globalAlpha = st.opacity ?? 1;
  ctx.beginPath();
  ctx.ellipse(st.px, st.py, rx, ry, ((st.rot ?? 0) * _DEG_TO_RAD), 0, Math.PI * 2);
  ctx.fillStyle = handFill;
  ctx.fill();
  ctx.strokeStyle = '#222222';
  ctx.lineWidth = 2.5;
  ctx.stroke();
  if (gear) {
    ctx.translate(st.px, st.py);
    ctx.rotate((st.rot ?? 0) * _DEG_TO_RAD);
    // scaleX carries the fighter's facing mirror (animator.js resolveHand).
    drawHandGear(ctx, 0, 0, (rx + ry) * 0.5, gear, (st.scaleX || 1) < 0);
  }
  ctx.restore();
}

function drawAnimatedWeapon(ctx, st) {
  ctx.save();
  ctx.globalAlpha = st.opacity ?? 1;
  ctx.translate(st.px, st.py);
  ctx.rotate(((st.rot || 0) * _DEG_TO_RAD));
  ctx.scale(st.scaleX || 1, st.scaleY || 1);
  drawWeapon(ctx, st.def, { color: st.def.color, accent: st.def.accent });
  ctx.restore();
}

// Reused draw-def for sprite projectiles. drawWeapon reads w/h off the def
// object itself, so a scratch object lets a projectile pick its on-screen size
// without allocating a new def every frame (the projectile list is walked each
// frame and must not produce garbage).
const _projWeaponDef = { w: 22, h: 22, color: null, accent: null, type: 'throwing', sprite: null };

// Reused VFX params for the projectile-trail dispatch above. The art reads
// progress/scale/color/mirrorX/rotation only, and draw() is synchronous, so
// one shared record is safe.
const _trailParams = { progress: 0, scale: 1, color: null, mirrorX: 1, rotation: 0 };

// Cached muzzle-flash fill strings: alpha is quantized to 16 steps per kind,
// so a flash reuses one of 32 strings instead of building + re-parsing an
// rgba() template every frame of its life.
const _flashStyles = [new Array(16), new Array(16)];
function _flashStyle(a, kind) {
  const q = Math.max(0, Math.min(15, (a * 16) | 0));
  const arr = _flashStyles[kind];
  let s = arr[q];
  if (!s) {
    const alpha = (q / 16).toFixed(3);
    s = kind === 0 ? `rgba(255, 213, 79, ${alpha})` : `rgba(255, 255, 200, ${alpha})`;
    arr[q] = s;
  }
  return s;
}

// Draw a projectile that IS a registered weapon (p.weaponId) through the same
// weapon renderer the fighter's hand uses, so the thrown art is the real
// weapon sprite rather than a shape re-drawn just for the projectile. Spins on
// the projectile's own spin clock, and mirrors when travelling left so the spin
// reads in the direction of travel. Returns false if the id isn't registered,
// letting the caller fall back to its generic projectile drawing.
function drawProjectileWeapon(ctx, p) {
  const wdef = getWeapon(p.weaponId);
  if (!wdef) return false;
  const size = p.drawSize || wdef.w || 32;
  _projWeaponDef.w = size;
  _projWeaponDef.h = size;
  _projWeaponDef.color = wdef.color;
  _projWeaponDef.accent = wdef.accent;
  _projWeaponDef.type = wdef.type;
  _projWeaponDef.sprite = wdef.sprite;
  ctx.save();
  ctx.translate(p.x, p.y);
  ctx.rotate(p.spin || 0);
  if ((p.vx || p.facing || 1) < 0) ctx.scale(-1, 1);
  drawWeapon(ctx, _projWeaponDef);
  ctx.restore();
  return true;
}

// Draw the animated hands + weapons for one layer ("behind" = z < 0,
// anything else = front). `type` is 'hand' or 'weapon' (set by the animator).
// `handGear` is the fighter's { left, right } gear pair; each hand looks up its
// own side via the tag collectAnimatedItems attached, so the two arms can wear
// different things.
function drawAnimatedLayer(ctx, items, behind, handR, handFill, handGear) {
  for (const it of items) {
    const isBehind = (it.z || 0) < 0;
    if (isBehind !== behind) continue;
    if (it.type === 'hand') drawAnimatedHand(ctx, it, handR, handFill, handGear && handGear[it._gearSide]);
    else drawAnimatedWeapon(ctx, it);
  }
}

function _drawHandState(ctx, st, handR, handFill, gear) {
  if (!st || st.visible === false || st.opacity <= 0) return;
  ctx.save();
  ctx.globalAlpha = st.opacity ?? 1;
  ctx.beginPath();
  ctx.ellipse(
    st.px, st.py,
    handR * (st.sx ?? 1),
    handR * (st.sy ?? 1),
    ((st.rot ?? 0) * _DEG_TO_RAD),
    0,
    Math.PI * 2
  );
  ctx.fillStyle = handFill;
  ctx.fill();
  ctx.strokeStyle = '#222222';
  ctx.lineWidth = 2.5;
  ctx.stroke();
  // Gear rides with the legacy hand: same pass, same rotation, same opacity, so
  // it can never end up behind the body or on the wrong side of it.
  if (gear) {
    const sx = st.sx ?? 1, sy = st.sy ?? 1;
    ctx.translate(st.px, st.py);
    ctx.rotate((st.rot ?? 0) * _DEG_TO_RAD);
    drawHandGear(ctx, 0, 0, handR * ((Math.abs(sx) + Math.abs(sy)) * 0.5), gear, sx < 0);
  }
  ctx.restore();
}

// Draw a fighter: body circle (skin image or flat color), resting hands tuned
// by the neutral hand pose, cosmetic accessories, and movement-state markers.
export function drawFighter(ctx, fighter, time) {
  if (fighter.state === 'dead') return;
  // Whole-fighter cull (margin: hands/weapons/shadow/arrow reach).
  if (!_inView(fighter.x, fighter.y, 160)) return;

  const { x, y, radius, color, skin } = fighter;

  // Invulnerability blink (used by the soft blast-zone respawn)
  if (fighter.invulnTimer > 0) {
    if (Math.floor(time / 80) % 2 === 0) return;
  }

  ctx.save();

  // Squish effect (jump/landing stretch)
  const sx = fighter.squishX || 1;
  const sy = fighter.squishY || 1;
  if (sx !== 1 || sy !== 1) {
    ctx.translate(x, y);
    ctx.scale(sx, sy);
    ctx.translate(-x, -y);
  }

  // Draw shadow on ground
  if (fighter.grounded) directionalShadow(ctx, x, y, radius);

  // Behind-the-player accessories (hides behind the body).
  if (fighter.accessory && fighter.accessory.type && fighter.accessory.layer === 'behind') {
    drawAccessory(ctx, x, y, radius, fighter.accessory);
  }

  // Look up live skin status from the cache (skin.path is set by resolveSkin)
  const skinLive = lookUpSkin(skin);

  // ── Body + hands/layers ────────────────────────────────────────────────
  const handR = radius * 0.35;
  const handFill = resolveHandColor(fighter._fighterDef ? fighter._fighterDef.id : fighter.id, color);
  // Cosmetic gear worn on the hands — drawn by the hand passes below, in the
  // hand's own transform, so it inherits the pose and z-order for free.
  const handGear = fighter.handGear || null;
  // Which ARM is which. The legacy pose system below only distinguishes a
  // trailing ('back') and a leading ('front') hand, with no left/right of its
  // own; facing tells us which one is the fighter's leading arm. The animator
  // path doesn't need this — it has real `hands.left` / `hands.right` slots.
  const frontSide = fighter.facingRight ? 'right' : 'left';
  const backSide = fighter.facingRight ? 'left' : 'right';
  const frontGear = handGear && handGear[frontSide];
  const backGear = handGear && handGear[backSide];
  // Animator output is used ONLY while a combat action (attack / shield — the
  // library's base animations) is active. Normal movement — idle, walking
  // left/right, running, jumping — always renders through the original legacy
  // pose system below, never through animator playback.
  const animated = !!(
    fighter.anim &&
    fighter.anim.out &&
    (fighter.anim.animId || fighter.anim.playing || fighter.anim.blendFrom)
  );

  if (animated) {
    const items = collectAnimatedItems(fighter);
    drawAnimatedLayer(ctx, items, true, handR, handFill, handGear);
    drawBody(ctx, fighter, skinLive);
    drawAnimatedLayer(ctx, items, false, handR, handFill, handGear);
  } else {
    const dirHand = fighter.facingRight ? 1 : -1;

    // Neutral hand offsets — the resting pose (live-editable via the terminal
    // menu's SKIN SIZE / accessories editors; hand poses come from handConfig).
    const neutralPose = handConfig.actions.neutral;
    const backBase = _hb(fighter, 'backBase', -dirHand * radius * neutralPose.start.back.x, radius * neutralPose.start.back.y);
    const frontBase = _hb(fighter, 'frontBase', dirHand * radius * neutralPose.start.front.x, radius * neutralPose.start.front.y);

    const neutralBack = _hb(fighter, 'neutralBack', backBase.x, backBase.y);
    const neutralFront = _hb(fighter, 'neutralFront', frontBase.x, frontBase.y);
    const bob = Math.sin(time * 0.005) * 2; // subtle breathing
    neutralFront.y = frontBase.y + bob;
    neutralBack.y = backBase.y - bob * 0.6;

    if (fighter.grounded && !fighter.dodging && Math.abs(fighter.vx) > 120) {
      const pump = Math.abs(Math.sin(time * 0.016)) * radius * 0.28;
      neutralFront.x = frontBase.x + dirHand * pump;
      neutralFront.y = frontBase.y - pump * 0.5;
      neutralBack.x = backBase.x - dirHand * pump * 0.6;
      neutralBack.y = backBase.y + pump * 0.4;
    }

    if (!fighter.grounded && !fighter.dodging) {
      neutralFront.y -= radius * neutralPose.airLiftY;
      neutralBack.y -= radius * neutralPose.airLiftY;
      neutralFront.x += dirHand * radius * neutralPose.airSpreadX;
      neutralBack.x -= dirHand * radius * neutralPose.airSpreadX;
    }

    if (fighter.dodging) {
      neutralFront.x = frontBase.x * 0.35;
      neutralBack.x = backBase.x * 0.35;
      neutralFront.y = frontBase.y + radius * 0.15;
      neutralBack.y = backBase.y + radius * 0.1;
    }

    // Ease the displayed hands toward the neutral targets so every pose settles
    // back onto the same resting offsets.
    const smooth = Math.min(1, 0.42);
    if (!fighter._handBack) fighter._handBack = { x: backBase.x, y: backBase.y };
    if (!fighter._handFront) fighter._handFront = { x: frontBase.x, y: frontBase.y };
    fighter._handBack.x += (neutralBack.x - fighter._handBack.x) * smooth;
    fighter._handBack.y += (neutralBack.y - fighter._handBack.y) * smooth;
    fighter._handFront.x += (neutralFront.x - fighter._handFront.x) * smooth;
    fighter._handFront.y += (neutralFront.y - fighter._handFront.y) * smooth;

    // Reuse pre-allocated state objects for rendering.
    const backSt = _hst(fighter, 'back', x + fighter._handBack.x, y + fighter._handBack.y, 'back');
    const frontSt = _hst(fighter, 'front', x + fighter._handFront.x, y + fighter._handFront.y, 'front');

    if (backSt.layer === 'front') {
      _drawHandState(ctx, frontSt, handR, handFill, frontGear);
      drawBody(ctx, fighter, skinLive);
      _drawHandState(ctx, backSt, handR, handFill, backGear);
    } else {
      _drawHandState(ctx, backSt, handR, handFill, backGear);
      drawBody(ctx, fighter, skinLive);
      _drawHandState(ctx, frontSt, handR, handFill, frontGear);
    }
  }

  // Cosmetic accessory (hats & co.) — on top, unless set to draw behind.
  if (fighter.accessory && fighter.accessory.type && fighter.accessory.layer !== 'behind') {
    drawAccessory(ctx, x, y, radius, fighter.accessory);
  }

  // Deadeye hit flash: brief red overlay when one of the cowboy's Deadeye
  // bullets connects (set by combat.js' applyDeadeyeHit, decayed in Fighter.js
  // physics). This is the ONLY fighter-local flash left — a plain melee or
  // ability hit paints nothing.
  if (fighter._hitFlash > 0) {
    const a = Math.min(0.45, fighter._hitFlash * 3);
    ctx.globalAlpha = a;
    ctx.beginPath();
    ctx.arc(x, y, radius + 2, 0, Math.PI * 2);
    ctx.fillStyle = '#ff2222';
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  // Direction indicator (small arrow on top)
  const arrowY = y - radius - 10;
  const arrowX = x;
  ctx.fillStyle = '#111111';
  ctx.beginPath();
  ctx.moveTo(arrowX, arrowY);
  ctx.lineTo(arrowX - 4, arrowY - 6);
  ctx.lineTo(arrowX + 4, arrowY - 6);
  ctx.closePath();
  ctx.fill();

  ctx.restore();
}

function darkenColor(hex, amount) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgb(${Math.floor(r * (1 - amount))},${Math.floor(g * (1 - amount))},${Math.floor(b * (1 - amount))})`;
}

// Ability-world effects: projectile orbs (with the projectile's cowboyTrail /
// ninjaTrail VFX riding the bullet when it is marked) and the cowboy Down Light
// Deadeye volley (homing slugs + their muzzle starbursts). World-space — call
// inside the camera transform, after the fighters.
export function drawAbilityFx(ctx, fighter, time) {
  const proj = fighter._projectiles;

  if (proj && proj.length) {
    for (const p of proj) {
      if (!_inView(p.x, p.y, 120)) continue;
      // Projectile trail — the cowboyTrail VFX system effect follows the
      // bullet's position and travel orientation. It is draw-only: the trail is
      // never a hitbox (projectiles own only their r-sized orb hurtbox).
      // The param record is reused (draw is synchronous), so no object is
      // allocated per projectile per frame.
      if (p.trail === 'cowboyTrail') {
        const eff = getVfxEffect('cowboyTrail');
        if (eff) {
          _trailParams.progress = 0;
          _trailParams.scale = 1;
          _trailParams.color = null;
          _trailParams.mirrorX = 1;
          _trailParams.rotation = (Math.atan2(p.vy, p.vx) * 180) / Math.PI;
          eff.draw(ctx, _trailParams, p);
        }
      }
      // Ninja shuriken: the ninjaTrail VFX system effect rides the projectile
      // (oriented along its facing — flight is always horizontal), and the
      // shuriken itself is drawn as the REAL registered weapon sprite on top,
      // spinning on the projectile's own spin clock (advanced in
      // combat.updateProjectiles). Draw-only: neither the trail nor the sprite
      // owns a hitbox (the projectile's r-sized hurtbox does).
      if (p.trail === 'ninjaTrail') {
        const eff = getVfxEffect('ninjaTrail');
        if (eff) {
          _trailParams.progress = 0;
          _trailParams.scale = 1;
          _trailParams.color = null;
          _trailParams.mirrorX = (p.vx || p.facing || 1) >= 0 ? 1 : -1;
          _trailParams.rotation = 0;
          eff.draw(ctx, _trailParams, p);
        }
        // The shuriken sprite. Drawn through the shared weapon renderer from the
        // shared weapon registry, so a projectile is never a hand-rolled shape
        // that can drift from the weapon the ninja is actually holding.
        if (p.weaponId && drawProjectileWeapon(ctx, p)) continue;
        // Spinning star core (fallback for a projectile with no weapon sprite).
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.spin || 0);
        const oR = 8, iR = 3.2;
        ctx.beginPath();
        for (let i = 0; i < 8; i++) {
          const ang = (i * Math.PI) / 4 - Math.PI / 2;
          const r = i % 2 === 0 ? oR : iR;
          const x = Math.cos(ang) * r, y = Math.sin(ang) * r;
          if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.closePath();
        ctx.fillStyle = '#2c3e50';
        ctx.fill();
        ctx.strokeStyle = '#0a0f14';
        ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.fillStyle = 'rgba(52,152,219,0.85)';
        ctx.beginPath();
        ctx.arc(0, 0, 2.4, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
        continue;
      }
      // Default projectile orb.
      const pulse = 1 + 0.15 * Math.sin(time * 0.02);
      const R = p.r * pulse + 4;
      // One cached unit-radius gradient, drawn through a scale(R, R) transform.
      // A concentric radial gradient's colour is a function of RELATIVE distance,
      // so the r=1 gradient scaled to R is pixel-identical to a fresh gradient
      // built at radius R — the pulse makes R change every frame, which is
      // exactly why a per-frame createRadialGradient (plus 3 addColorStop parses)
      // could never be cached by key.
      const g = orbGradient(ctx);
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.scale(R, R);
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(0, 0, 1, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      ctx.strokeStyle = 'rgba(180,230,255,0.8)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r * pulse, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  // === DEADEYE: Homing bullets with metallic slug + yellow trail ===
  // Rendered in world-space inside camera transform
  if (fighter._deadeyeBullets && fighter._deadeyeBullets.length) {
    for (const b of fighter._deadeyeBullets) {
      if (b.dead) continue;
      if (!_inView(b.x, b.y, 120)) continue;
      
      // 1. Trail (yellow/gold, tapered)
      if (b.trail && b.trail.length > 1) {
        ctx.globalCompositeOperation = 'lighter';
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        
        for (let i = 0; i < b.trail.length - 1; i++) {
          const t = i / (b.trail.length - 1);
          const p1 = b.trail[i];
          const p2 = b.trail[i + 1];
          const alpha = t * 0.6; // Fade toward tail
          const width = (1 - t) * b.bulletSize * 0.4;
          
          ctx.globalAlpha = alpha;
          ctx.strokeStyle = b.trailColor || '#ffd54f';
          ctx.lineWidth = width;
          ctx.beginPath();
          ctx.moveTo(p1.x, p1.y);
          ctx.lineTo(p2.x, p2.y);
          ctx.stroke();
        }
        ctx.globalCompositeOperation = 'source-over';
      }
      
      // 2. Bullet slug (metallic gray with rounded tip, specular highlight)
      ctx.save();
      ctx.translate(b.x, b.y);
      ctx.rotate(b.angle);
      
      const len = b.bulletSize * 3.2;
      const r = b.bulletSize * 0.65;
      
      // Metallic projectile body with rounded front tip
      ctx.fillStyle = b.bodyColor || '#78828c';
      ctx.beginPath();
      ctx.moveTo(-len * 0.5, -r);
      ctx.lineTo(len * 0.3, -r);
      // Rounded bullet nose arc
      ctx.arc(len * 0.3, 0, r, -Math.PI / 2, Math.PI / 2, false);
      ctx.lineTo(-len * 0.5, r);
      ctx.closePath();
      ctx.fill();
      
      // Highlight strip on top for anime sheen
      ctx.fillStyle = b.highlightColor || '#b0bec5';
      ctx.beginPath();
      ctx.moveTo(-len * 0.4, -r * 0.4);
      ctx.lineTo(len * 0.2, -r * 0.4);
      ctx.arc(len * 0.2, 0, r * 0.4, -Math.PI / 2, Math.PI / 2, false);
      ctx.lineTo(-len * 0.4, r * 0.4);
      ctx.closePath();
      ctx.fill();
      
      ctx.restore();
    }
  }
  
  // Muzzle flashes (brief starburst at weapon tip)
  if (fighter._deadeyeMuzzleFlashes && fighter._deadeyeMuzzleFlashes.length) {
    ctx.globalCompositeOperation = 'lighter';
    for (const f of fighter._deadeyeMuzzleFlashes) {
      if (f.life <= 0) continue;
      if (!_inView(f.x, f.y, 80)) continue;
      const prog = 1 - f.life / f.maxLife;
      const alpha = 1 - prog;
      const size = f.size * (1 + prog * 0.5);

      ctx.save();
      ctx.translate(f.x, f.y);
      ctx.rotate(f.angle);
      
      // Starburst muzzle flash (fill strings cached by quantized alpha).
      ctx.fillStyle = _flashStyle(alpha * 0.9, 0);
      ctx.beginPath();
      for (let i = 0; i < 8; i++) {
        const a = i * Math.PI / 4;
        const r1 = size * 0.3;
        const r2 = size;
        ctx.moveTo(Math.cos(a) * r1, Math.sin(a) * r1);
        ctx.lineTo(Math.cos(a) * r2, Math.sin(a) * r2);
        ctx.lineTo(Math.cos(a + Math.PI / 8) * r1, Math.sin(a + Math.PI / 8) * r1);
      }
      ctx.closePath();
      ctx.fill();
      
      // Core
      ctx.fillStyle = _flashStyle(alpha, 1);
      ctx.beginPath();
      ctx.arc(0, 0, size * 0.4, 0, Math.PI * 2);
      ctx.fill();
      
      ctx.restore();
    }
    ctx.globalCompositeOperation = 'source-over';
  }
}

// ---------------------------------------------------------------------------
// Draw a fighter's mount (the cowboy's horse ride) UNDERNEATH the rider.
// World-space — call right BEFORE drawFighter so the horse always sits behind
// the cowboy. Mirrors with the horse's facing direction; falls back to a flat
// silhouette while the sprite loads (or if it fails) so the trample reads even
// without the asset. The horse's back sits at the lifted rider's feet (the
// geometry in abilities.js guarantees the hooves rest on the standing floor).
// The sprite's authored default faces LEFT, so a rightward horse is drawn with
// a NEGATED x-scale to face the direction of travel.
export function drawHorse(ctx, fighter, time) {
  const horse = fighter._horse;
  if (!horse) return;
  if (!_inView(horse.x, horse.y, 160)) return;
  const hw = horse.drawW / 2;
  const hh = horse.drawH / 2;
  const entry = getSkinImage(horse.sprite);
  const img = entry && entry.status === 'loaded' ? entry.img : null;

  ctx.save();
  ctx.translate(horse.x, horse.y);
  ctx.scale(-horse.dir, 1);

  // Dirt kick-up as the ride moves.
  const dust = (time * 0.003) % 1;
  ctx.fillStyle = 'rgba(120, 95, 60, 0.35)';
  ctx.beginPath();
  ctx.ellipse(-hw * 0.7 + dust * 6, hh * 0.9, 7 + dust * 10, 3 + dust * 4, 0, 0, Math.PI * 2);
  ctx.fill();

  if (img) {
    ctx.drawImage(img, -hw, -hh, horse.drawW, horse.drawH);
  } else {
    ctx.fillStyle = 'rgba(70, 40, 20, 0.85)';
    ctx.strokeStyle = '#222222';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.ellipse(0, 0, hw * 0.95, hh, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }
  ctx.restore();
}
