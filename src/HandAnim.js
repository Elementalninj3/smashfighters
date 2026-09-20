// HandAnim.js — hand pose configuration for the movement sandbox.
// The keyframe animation engine, weapon hand slots, and ability metadata are
// gone. This module keeps only the neutral resting pose that the fighter
// renderer samples for idle hands, plus the hand-color resolution stack.
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
let charHandColors = {};
if (typeof localStorage !== 'undefined') {
  try {
    const raw = localStorage.getItem(CHAR_COLOR_KEY);
    if (raw) charHandColors = JSON.parse(raw) || {};
  } catch (err) {
    charHandColors = {};
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
// then the global HAND COLOR, then the body color.
export function resolveHandColor(fighterId, bodyColor) {
  const perChar = charHandColorFor(fighterId);
  if (perChar) return perChar;
  const c = handConfig && handConfig.handColor;
  if (typeof c === 'string' && c !== 'auto' && isValidColor(c)) return c;
  return bodyColor;
}