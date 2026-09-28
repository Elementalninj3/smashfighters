// HandGear.js — cosmetic gear worn ON THE HANDS (gloves & co.).
// Accessories.js owns the same idea for the head; this is its per-hand
// counterpart. Everything here is purely visual: gear never touches hitboxes,
// damage, or the simulation — it is drawn on top of a hand circle inside that
// hand's own draw pass, so it inherits the hand's pose, z-order and layer
// (behind-body / front) for free and can never be sorted wrong.
//
//   conf = { type, scale, angle, shiftX, shiftY, flip }
//     type        hand-gear id (see HAND_GEAR) or 'none'
//     scale       overall size multiplier
//     angle       rotation in degrees
//     shiftX/Y    nudge in HAND-radius units
//     flip        mirror horizontally
//
// There is deliberately no `layer` field (Accessories.js has one): a hat chooses
// whether it sits in front of or behind the fighter, but a glove IS part of the
// hand, so it is always drawn with the hand and follows the body around.
//
// Selection is persisted per fighter PER HAND in localStorage, so the two hands
// are independent:
//
//   { cowboy: { left: {…}, right: {…} }, ninja: { left: {…}, right: {…} } }
//
// Images are loaded through the shared getSkinImage cache owned by
// Accessories.js — one Image per path for the page's lifetime, never per frame.

import { getSkinImage } from './Accessories.js';

const STORAGE_KEY = 'smashfighters.handGear';

export const HAND_SIDES = ['left', 'right'];

// ── Procedural vector hand gear ─────────────────────────────────────────
// Drawn in HAND space: 1.0 = one hand radius, origin = the hand's centre.
// Used as a fallback while the image loads and if the image fails, so a fighter
// never renders a bare hand just because an asset is slow.

const OUTLINE = '#222222';

function strokePath(ctx) {
  ctx.strokeStyle = OUTLINE;
  ctx.lineWidth = 0.12;
  ctx.lineJoin = 'round';
  ctx.stroke();
}

// Rounded path helper — ctx.roundRect with a plain-rect fallback, matching how
// Accessories.js degrades for older canvas implementations.
function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(x, y, w, h, r);
  else ctx.rect(x, y, w, h);
}

// A laced boxing glove: big padded mitt, thumb across the front, cuff at the
// wrist. Sized so the mitt reads clearly larger than the hand circle under it.
function drawBoxingGlove(ctx) {
  const RED = '#c62828';
  const RED_D = '#8e1c1c';
  const LACE = '#f2f2f2';

  // Cuff / wrist wrap, drawn first so the mitt overlaps it.
  roundRect(ctx, -0.78, 0.34, 1.56, 0.66, 0.18);
  ctx.fillStyle = RED_D;
  ctx.fill();
  strokePath(ctx);

  // Thumb, tucked across the lower-left of the mitt.
  ctx.beginPath();
  ctx.moveTo(-0.62, 0.2);
  ctx.quadraticCurveTo(-1.04, 0.06, -0.86, -0.36);
  ctx.quadraticCurveTo(-0.6, -0.2, -0.46, 0.04);
  ctx.closePath();
  ctx.fillStyle = RED_D;
  ctx.fill();
  strokePath(ctx);

  // Main mitt.
  ctx.beginPath();
  ctx.ellipse(0, -0.24, 0.94, 0.82, 0, 0, Math.PI * 2);
  ctx.fillStyle = RED;
  ctx.fill();
  strokePath(ctx);

  // Highlight seam across the top of the padding.
  ctx.beginPath();
  ctx.moveTo(-0.5, -0.66);
  ctx.quadraticCurveTo(0, -0.96, 0.5, -0.66);
  ctx.lineWidth = 0.1;
  ctx.strokeStyle = '#e05a5a';
  ctx.stroke();

  // Laces down the middle of the mitt.
  ctx.lineWidth = 0.07;
  ctx.strokeStyle = LACE;
  ctx.beginPath();
  for (let i = 0; i < 3; i++) {
    const y = -0.3 + i * 0.24;
    ctx.moveTo(-0.16, y);
    ctx.lineTo(0.16, y);
  }
  ctx.stroke();
}

// ── Hand-gear catalogue ────────────────────────────────────────────────
// id -> { name, img? (image art), draw? (procedural fallback) }. Entries with
// an image draw it centred on the hand; `draw` covers the loading window and a
// failed load, exactly as Accessories.js does for hats.
export const HAND_GEAR = [
  { id: 'none', name: 'NONE' },
  { id: 'boxinggloves', name: 'BOXING GLOVES', img: '/GA/accesories/boxinggloves.png', draw: drawBoxingGlove },
];

// O(1) lookup by id — avoids Array.find() per hand per frame.
const _handGearMap = new Map();
for (const g of HAND_GEAR) _handGearMap.set(g.id, g);

export function handGearById(id) {
  return _handGearMap.get(id) || null;
}

export function defaultHandGear(type) {
  return { type: type || 'none', scale: 1, angle: 0, shiftX: 0, shiftY: 0, flip: false };
}

export function cloneHandGear(conf) {
  return { ...defaultHandGear(null), ...(conf || {}) };
}

// The "no gear" record for a whole fighter: both hands bare. A character that
// ships with gear (the boxer) passes its default type in instead — see
// loadHandGearFor, which only uses the default when nothing is stored yet, so
// the customiser can always override a character's built-in look.
export function defaultHandGearSet(type) {
  return { left: defaultHandGear(type), right: defaultHandGear(type) };
}

export function cloneHandGearSet(gear) {
  return {
    left: cloneHandGear(gear && gear.left),
    right: cloneHandGear(gear && gear.right),
  };
}

function readStore() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {};
  } catch (_) {
    return {};
  }
}

// `defaultType` is the character's built-in gear id, or undefined/'none'. A
// fighter with no stored record gets that default on BOTH hands.
export function loadHandGearFor(fighterId, defaultType) {
  const base = defaultHandGearSet(defaultType);
  if (!fighterId) return base;
  const all = readStore();
  const raw = all[fighterId];
  if (!raw) return base;
  for (const side of HAND_SIDES) {
    const c = cloneHandGear(raw[side]);
    if (_handGearMap.has(c.type)) base[side] = c;
  }
  return base;
}

export function saveHandGearFor(fighterId, side, conf) {
  if (!fighterId) return;
  try {
    const all = readStore();
    if (!all[fighterId]) all[fighterId] = { left: defaultHandGear(null), right: defaultHandGear(null) };
    all[fighterId][side] = cloneHandGear(conf);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
  } catch (_) {}
}

// Used by the customiser's MATCH BOTH HANDS and RESET rows, which act on the
// whole pair at once instead of the single hand being edited.
export function saveHandGearSetFor(fighterId, gear) {
  if (!fighterId) return;
  try {
    const all = readStore();
    all[fighterId] = cloneHandGearSet(gear);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
  } catch (_) {}
}

export function handGearName(id) {
  const g = _handGearMap.get(id);
  return g ? g.name : 'NONE';
}

// ── Drawing ────────────────────────────────────────────────────────────
// Image art is centred on the hand and sized in hand-radius units, so a glove
// reads as a glove covering the fist rather than as a hat perched on it.
const IMAGE_WIDTH = 2.3;

function drawImageHandGear(ctx, entry) {
  const e = getSkinImage(entry.img);
  if (!e || e.status !== 'loaded' || !e.img) return false;
  const img = e.img;
  const w = IMAGE_WIDTH;
  const h = w * (img.height / img.width);
  ctx.drawImage(img, -w / 2, -h / 2, w, h);
  return true;
}

// Draw one hand's gear. R = that hand's radius, conf as documented at the top.
// `extraFlip` is XOR'd on top of the user's FLIP setting and exists so a
// MIRRORED fighter (facing left) also mirrors the art — the glove's thumb has to
// swap sides with the body. It is passed as a flag rather than baked into a
// modified conf so the mirrored case allocates nothing per frame.
export function drawHandGear(ctx, cx, cy, R, conf, extraFlip) {
  if (!conf || !conf.type || conf.type === 'none') return;
  const entry = _handGearMap.get(conf.type);
  if (!entry) return;
  const s = R * (typeof conf.scale === 'number' ? conf.scale : 1);
  if (s <= 0) return;
  const mirrored = !!conf.flip !== !!extraFlip;
  ctx.save();
  ctx.translate(
    cx + (conf.shiftX || 0) * R,
    cy + (conf.shiftY || 0) * R
  );
  ctx.rotate(-((conf.angle || 0) * Math.PI) / 180);
  ctx.scale(mirrored ? -s : s, s);
  let drew = false;
  if (entry.img) drew = drawImageHandGear(ctx, entry);
  if (!drew && entry.draw) entry.draw(ctx);
  ctx.restore();
}
