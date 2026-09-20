// Accessories.js — cosmetic gear (hats & co.) worn by fighters.
// Accessories are either image files (loaded via getSkinImage) or
// procedurally drawn vector versions, seated on top of the fighter ball and
// drawn in "unit space" where 1.0 = one fighter radius. Selection is
// persisted per fighter in localStorage.
//
//   conf = { type, scale, angle, shiftX, shiftY, flip, layer }
//     type    accessory id (see ACCESSORIES) or 'none'
//     scale   overall size multiplier
//     angle   rotation in degrees
//     shiftX / shiftY   nudge in radius units
//     flip    mirror horizontally
//     layer   'behind' hides behind the body · 'front' sits on top

import { getSkinImage } from './vfxCore.js';

const STORAGE_KEY = 'smashfighters.accessories';

// ── Procedural vector accessories ──────────────────────────────────────

const OUTLINE = '#222222';

function strokePath(ctx) {
  ctx.strokeStyle = OUTLINE;
  ctx.lineWidth = 0.09;
  ctx.lineJoin = 'round';
  ctx.stroke();
}

function drawCowboyHat(ctx) {
  const TAN = '#c19a5b';
  const BAND = '#5a3114';
  // Brim
  ctx.beginPath();
  ctx.ellipse(0, -0.62, 1.02, 0.2, 0, 0, Math.PI * 2);
  ctx.fillStyle = TAN;
  ctx.fill();
  strokePath(ctx);
  // Crown
  ctx.beginPath();
  ctx.moveTo(-0.44, -0.6);
  ctx.lineTo(-0.33, -1.18);
  ctx.quadraticCurveTo(0, -1.26, 0.33, -1.18);
  ctx.lineTo(0.44, -0.6);
  ctx.closePath();
  ctx.fillStyle = TAN;
  ctx.fill();
  strokePath(ctx);
  // Band
  ctx.beginPath();
  ctx.moveTo(-0.38, -0.88);
  ctx.lineTo(-0.4, -0.7);
  ctx.lineTo(0.4, -0.7);
  ctx.lineTo(0.38, -0.88);
  ctx.closePath();
  ctx.fillStyle = BAND;
  ctx.fill();
  // Crease
  ctx.beginPath();
  ctx.moveTo(0, -1.22);
  ctx.lineTo(0, -1.04);
  ctx.lineWidth = 0.06;
  ctx.strokeStyle = BAND;
  ctx.stroke();
}

function drawTopHat(ctx) {
  const DARK = '#26262c';
  const BAND = '#b03030';
  // Brim
  ctx.beginPath();
  ctx.ellipse(0, -0.52, 0.92, 0.17, 0, 0, Math.PI * 2);
  ctx.fillStyle = DARK;
  ctx.fill();
  strokePath(ctx);
  // Crown
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(-0.38, -1.28, 0.76, 0.76, 0.08);
  else ctx.rect(-0.38, -1.28, 0.76, 0.76);
  ctx.fillStyle = DARK;
  ctx.fill();
  strokePath(ctx);
  // Band
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(-0.38, -0.92, 0.76, 0.12, 0.02);
  else ctx.rect(-0.38, -0.92, 0.76, 0.12);
  ctx.fillStyle = BAND;
  ctx.fill();
  // Edge highlight
  ctx.beginPath();
  ctx.moveTo(-0.3, -1.24);
  ctx.lineTo(-0.3, -0.98);
  ctx.lineWidth = 0.05;
  ctx.strokeStyle = 'rgba(255,255,255,0.25)';
  ctx.stroke();
}

function drawBaseballCap(ctx) {
  const CAP = '#3a6ea5';
  const SEAM = '#2c5180';
  const BRIM = '#d8d8d8';
  // Dome
  ctx.beginPath();
  ctx.moveTo(-0.6, -0.52);
  ctx.quadraticCurveTo(-0.6, -1.1, 0, -1.1);
  ctx.quadraticCurveTo(0.6, -1.1, 0.6, -0.52);
  ctx.closePath();
  ctx.fillStyle = CAP;
  ctx.fill();
  strokePath(ctx);
  // Seams
  ctx.beginPath();
  ctx.moveTo(0, -1.06);
  ctx.lineTo(0, -0.62);
  ctx.moveTo(-0.28, -1.06);
  ctx.lineTo(-0.2, -0.62);
  ctx.moveTo(0.28, -1.06);
  ctx.lineTo(0.2, -0.62);
  ctx.lineWidth = 0.05;
  ctx.strokeStyle = SEAM;
  ctx.stroke();
  // Brim (sits on the front / +x side by default; flip mirrors it)
  ctx.beginPath();
  ctx.ellipse(0.44, -0.5, 0.42, 0.13, 0.06, 0, Math.PI * 2);
  ctx.fillStyle = BRIM;
  ctx.fill();
  strokePath(ctx);
}

function drawCrown(ctx) {
  const GOLD = '#f2c532';
  const GOLD_D = '#c9961a';
  // Band
  ctx.beginPath();
  ctx.ellipse(0, -0.78, 0.56, 0.17, 0, 0, Math.PI * 2);
  ctx.fillStyle = GOLD_D;
  ctx.fill();
  strokePath(ctx);
  // Spikes
  ctx.beginPath();
  ctx.moveTo(-0.52, -0.88);
  ctx.lineTo(-0.5, -1.2);
  ctx.lineTo(-0.34, -0.86);
  ctx.lineTo(-0.17, -1.28);
  ctx.lineTo(-0.02, -0.86);
  ctx.lineTo(0.15, -1.26);
  ctx.lineTo(0.32, -0.86);
  ctx.lineTo(0.5, -1.16);
  ctx.lineTo(0.52, -0.9);
  ctx.closePath();
  ctx.fillStyle = GOLD;
  ctx.fill();
  strokePath(ctx);
  // Gems
  ctx.beginPath();
  ctx.arc(0, -0.78, 0.09, 0, Math.PI * 2);
  ctx.fillStyle = '#e02040';
  ctx.fill();
  ctx.beginPath();
  ctx.arc(-0.3, -0.96, 0.06, 0, Math.PI * 2);
  ctx.arc(0.3, -0.92, 0.06, 0, Math.PI * 2);
  ctx.fillStyle = '#40b0e0';
  ctx.fill();
}

function drawWizardHat(ctx) {
  const PURPLE = '#5a2d82';
  const GOLD = '#d9b310';
  // Brim
  ctx.beginPath();
  ctx.ellipse(0, -0.6, 0.98, 0.21, 0, 0, Math.PI * 2);
  ctx.fillStyle = PURPLE;
  ctx.fill();
  strokePath(ctx);
  // Tall bent cone
  ctx.beginPath();
  ctx.moveTo(-0.32, -0.58);
  ctx.quadraticCurveTo(0.02, -1.65, 0.55, -1.6);
  ctx.quadraticCurveTo(0.5, -1.15, 0.44, -0.6);
  ctx.closePath();
  ctx.fillStyle = PURPLE;
  ctx.fill();
  strokePath(ctx);
  // Band
  ctx.beginPath();
  ctx.moveTo(-0.26, -0.94);
  ctx.lineTo(0.42, -0.92);
  ctx.lineTo(0.44, -0.8);
  ctx.lineTo(-0.28, -0.82);
  ctx.closePath();
  ctx.fillStyle = GOLD;
  ctx.fill();
  strokePath(ctx);
  // Star
  ctx.save();
  ctx.translate(0.2, -1.28);
  ctx.rotate(0.35);
  ctx.beginPath();
  for (let i = 0; i < 5; i++) {
    const a = (i * 2 * Math.PI) / 5 - Math.PI / 2;
    const a2 = a + Math.PI / 5;
    const rOut = 0.16;
    const rIn = 0.07;
    ctx.lineTo(Math.cos(a) * rOut, Math.sin(a) * rOut);
    ctx.lineTo(Math.cos(a2) * rIn, Math.sin(a2) * rIn);
  }
  ctx.closePath();
  ctx.fillStyle = GOLD;
  ctx.fill();
  strokePath(ctx);
  ctx.restore();
}

// ── Accessory catalogue ────────────────────────────────────────────────
// id -> { name, img? (image art), draw? (procedural fallback) }. Entries with
// an image draw it seated on the head; `draw` is used as a fallback while the
// image loads or if it fails.
export const ACCESSORIES = [
  { id: 'none', name: 'NONE' },
  { id: 'cowboyhat', name: 'COWBOY HAT', img: '/GA/accesories/cowboyhat.png', draw: drawCowboyHat },
  { id: 'tophat', name: 'TOP HAT', draw: drawTopHat },
  { id: 'baseballcap', name: 'BASEBALL CAP', draw: drawBaseballCap },
  { id: 'crown', name: 'CROWN', draw: drawCrown },
  { id: 'wizardhat', name: 'WIZARD HAT', draw: drawWizardHat },
];

// O(1) lookup by id — avoids Array.find() per fighter per frame.
const _accessoryMap = new Map();
for (const a of ACCESSORIES) _accessoryMap.set(a.id, a);

export function defaultAccessory() {
  return { type: 'none', scale: 1, angle: 0, shiftX: 0, shiftY: 0, flip: false, layer: 'front' };
}

export function cloneAccessory(conf) {
  return { ...defaultAccessory(), ...(conf || {}) };
}

export function loadAccessoryFor(fighterId) {
  if (!fighterId) return cloneAccessory(null);
  try {
    const all = JSON.parse(localStorage.getItem(STORAGE_KEY)) || {};
    const raw = all[fighterId];
    if (!raw) return cloneAccessory(null);
    const c = cloneAccessory(raw);
    if (!_accessoryMap.has(c.type)) return cloneAccessory(null);
    return c;
  } catch (_) {
    return cloneAccessory(null);
  }
}

export function saveAccessoryFor(fighterId, conf) {
  if (!fighterId) return;
  try {
    const all = JSON.parse(localStorage.getItem(STORAGE_KEY)) || {};
    all[fighterId] = cloneAccessory(conf);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
  } catch (_) {}
}

export function accessoryName(id) {
  const a = _accessoryMap.get(id);
  return a ? a.name : 'NONE';
}

// Image accessory: draw the art seated on the head. Width in radius units;
// height follows the image's aspect ratio. Bottom of the image rests just on
// the top of the ball (tweak with SIZE / UP-DOWN / FLIP in the editor).
const IMAGE_WIDTH = 1.9;
const IMAGE_SEAT_Y = -0.92;

function drawImageAccessory(ctx, entry) {
  const e = getSkinImage(entry.img);
  if (!e || e.status !== 'loaded' || !e.img) return false;
  const img = e.img;
  const w = IMAGE_WIDTH;
  const h = w * (img.height / img.width);
  ctx.drawImage(img, -w / 2, IMAGE_SEAT_Y - h, w, h);
  return true;
}

// Draw an accessory seated on a fighter ball. R = ball radius, conf as above.
export function drawAccessory(ctx, cx, cy, R, conf) {
  if (!conf || !conf.type || conf.type === 'none') return;
  const entry = _accessoryMap.get(conf.type);
  if (!entry) return;
  const s = R * (typeof conf.scale === 'number' ? conf.scale : 1);
  ctx.save();
  ctx.translate(
    cx + (conf.shiftX || 0) * R,
    cy + (conf.shiftY || 0) * R
  );
  ctx.rotate(-((conf.angle || 0) * Math.PI) / 180);
  ctx.scale(conf.flip ? -s : s, s);
  let drew = false;
  if (entry.img) drew = drawImageAccessory(ctx, entry);
  if (!drew && entry.draw) entry.draw(ctx);
  ctx.restore();
}