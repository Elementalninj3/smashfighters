// library.js — animation library (§13). Animations are self-contained keyframe
// data (core.js model) + weapon assignments. Defaults ship in-repo here (the
// code-side mirror of `animations/character/`); user saves persist to
// localStorage. Export/import round-trips the same JSON so files can be saved
// into `animations/` and loaded later.

import {
  ensureTrack, propPath, cloneAnimation, DEFAULT_POSE,
} from './core.js';
import { emptyWeaponCfg } from './weapons.js';

// v3 — the v2 store predates the "base animations" cleanup and can hold
// removed animation slots (dodge/hitstun/showcases) plus effect ids that no
// longer exist. Bumping the key starts fresh so only the base slots ship.
export const ANIM_STORE_KEY = 'smashfighters.animlib.v3';

// ── compact builder ──────────────────────────────────────────────────────
// kfs = [ [pathOrGroup, frame, value, ease?], ... ]
// pathOrGroup may be "hands.right.x" or a short form "R.x" / "L.y" / "RW.pos".
function r(path) { return `hands.right.${path}`; }
function l(path) { return `hands.left.${path}`; }
function rw(path) { return `weapons.right.${path}`; }
function lw(path) { return `weapons.left.${path}`; }

function build(id, name, opts, kfs) {
  const anim = {
    id, name,
    fps: opts.fps || 60,
    loop: !!opts.loop,
    mirror: opts.mirror !== false,
    blendIn: opts.blendIn == null ? 3 : opts.blendIn,
    weapons: {
      right: opts.weapons?.right ? { ...emptyWeaponCfg(), ...opts.weapons.right } : null,
      left: opts.weapons?.left ? { ...emptyWeaponCfg(), ...opts.weapons.left } : null,
    },
    combat: opts.combat || null,
    vfx: opts.vfx ? opts.vfx.map(v => ({ ...v })) : [],
    tracks: {},
  };
  for (const [path, frame, value, ease] of kfs) {
    ensureTrack(anim, path).keyframes.push({ f: Math.max(0, Math.round(frame)), v: value, e: ease || 'linear' });
  }
  for (const path of Object.keys(anim.tracks)) {
    anim.tracks[path].keyframes.sort((a, b) => a.f - b.f);
  }
  return anim;
}

const REST = { ...DEFAULT_POSE.hands };
const REST_L = { ...REST.left };
const REST_R = { ...REST.right };

// ── default animations ───────────────────────────────────────────────────

// NOTE: the animator drives combat actions only (the base animations below).
// Walking/running/jumping/falling are rendered by the original
// movement pose system (Effects/HandAnim) and are intentionally NOT
// animator-controlled, so no movement animations live in the library.
export const DEFAULT_ANIMATIONS = [
  // The animator ships exactly one base animation per combat slot (the six
  // standard attacks, the dash attack, shield/block). Walk/run/jump are
  // rendered by the original movement pose system (Effects/HandAnim) and are
  // intentionally NOT animator-controlled.
  build('jab', 'Neutral Light', { fps: 60, loop: false, blendIn: 1,
    weapons: { right: { id: 'revolver', mountX: 0, mountY: -2, gripOffsetX: -10, gripOffsetY: 0, gripRot: 0 } },
    vfx: [{ effect: 'bullet', anchor: 'weapon', startFrame: 2, duration: 6, scale: 0.8, rotation: 0, offsetX: 8, offsetY: 0, loop: false }],
  }, [
    [r('x'), 0, 28], [r('y'), 0, -6], [r('rot'), 0, 12],
    [l('x'), 0, -22], [l('y'), 0, 8],
    [r('x'), 2, 44], [r('y'), 2, -2], [r('rot'), 2, 8],
    [l('x'), 2, -18], [l('rot'), 2, -12],
    [r('x'), 5, 36], [r('y'), 5, -4], [r('rot'), 5, 16],
    [rw('rot'), 3, -8], [rw('rot'), 5, -3],
    [r('x'), 9, 28], [r('y'), 9, -6], [r('rot'), 9, 12],
    [l('x'), 9, -22], [l('rot'), 9, 0],
  ]),
  build('nsmash', 'Neutral Heavy', { fps: 60, loop: false, blendIn: 2,
    weapons: { right: { id: 'revolver', mountX: 0, mountY: -2, gripOffsetX: -10, gripOffsetY: 0, gripRot: 0 } },
    vfx: [
      { effect: 'blast', anchor: 'weapon', startFrame: 8, duration: 13, scale: 1.1, rotation: 0, offsetX: 10, offsetY: 0, loop: false },
      { effect: 'spray', anchor: 'weapon', startFrame: 6, duration: 10, scale: 0.9, rotation: 8, offsetX: 8, offsetY: 0, loop: false },
    ],
  }, [
    [r('x'), 0, 24], [r('y'), 0, -10], [r('rot'), 0, -14],
    [l('x'), 0, -20], [l('y'), 0, 10], [l('rot'), 0, 8],
    [r('x'), 4, 18], [r('y'), 4, -14], [r('rot'), 4, -24],
    [l('x'), 4, -14], [l('y'), 4, 14], [l('rot'), 4, 16],
    [r('x'), 10, 52], [r('y'), 10, -4], [r('rot'), 10, 22],
    [l('x'), 10, -8], [l('y'), 10, 6], [l('rot'), 10, -8],
    [rw('rot'), 9, -18], [rw('rot'), 13, -8],
    [r('x'), 20, 36], [r('y'), 20, -8], [r('rot'), 20, 10],
    [l('x'), 20, -18], [l('y'), 20, 10],
    [r('x'), 28, 28], [r('y'), 28, -6], [r('rot'), 28, -8],
    [l('x'), 28, -22], [l('rot'), 28, 0],
  ]),
  build('ftilt', 'Forward Light', { fps: 60, loop: false, blendIn: 1,
    weapons: { right: { id: 'revolver', mountX: 0, mountY: -2, gripOffsetX: -10, gripOffsetY: 0, gripRot: 0 } },
    vfx: [{ effect: 'spray', anchor: 'weapon', startFrame: 3, duration: 7, scale: 0.9, rotation: 4, offsetX: 9, offsetY: 0, loop: false }],
  }, [
    [r('x'), 0, 30], [r('y'), 0, -4], [r('rot'), 0, 20],
    [l('x'), 0, -24], [l('y'), 0, 8],
    [r('x'), 3, 52], [r('y'), 3, -2], [r('rot'), 3, 10],
    [l('x'), 3, -16], [l('y'), 3, 10], [l('rot'), 3, -14],
    [rw('rot'), 4, -9], [rw('rot'), 7, -4],
    [r('x'), 7, 38], [r('y'), 7, -4], [r('rot'), 7, 24],
    [r('x'), 14, 30], [r('y'), 14, -4], [r('rot'), 14, 20],
    [l('x'), 14, -24], [l('rot'), 14, 0],
  ]),
  build('fsmash', 'Forward Heavy', { fps: 60, loop: false, blendIn: 2,
    weapons: { right: { id: 'rifle', mountX: 0, mountY: -2, gripOffsetX: -18, gripOffsetY: 0, gripRot: 0 } },
    vfx: [
      { effect: 'blast', anchor: 'weapon', startFrame: 10, duration: 15, scale: 1.2, rotation: 0, offsetX: 12, offsetY: 0, loop: false },
      { effect: 'spray', anchor: 'weapon', startFrame: 8, duration: 10, scale: 0.9, rotation: 10, offsetX: 10, offsetY: 0, loop: false },
    ],
  }, [
    [r('x'), 0, 26], [r('y'), 0, 2], [r('rot'), 0, -16],
    [l('x'), 0, -20], [l('y'), 0, 12],
    [r('x'), 5, 20], [r('y'), 5, 6], [r('rot'), 5, -32],
    [l('x'), 5, -16], [l('y'), 5, 16], [l('rot'), 5, 14],
    [r('x'), 12, 58], [r('y'), 12, -2], [r('rot'), 12, 18],
    [l('x'), 12, -6], [l('y'), 12, 8], [l('rot'), 12, -10],
    [rw('rot'), 11, -22], [rw('rot'), 15, -10],
    [r('x'), 24, 38], [r('y'), 24, -4], [r('rot'), 24, 8],
    [l('x'), 24, -18], [l('y'), 24, 10],
    [r('x'), 32, 28], [r('y'), 32, -2], [r('rot'), 32, -10],
    [l('x'), 32, -22], [l('rot'), 32, 0],
  ]),
  build('nair', 'Aerial Light', { fps: 60, loop: false, blendIn: 1,
    weapons: { right: { id: 'revolver', mountX: 0, mountY: -2, gripOffsetX: -10, gripOffsetY: 0, gripRot: 0 } },
    vfx: [{ effect: 'bullet', anchor: 'weapon', startFrame: 2, duration: 6, scale: 0.8, rotation: 0, offsetX: 8, offsetY: 0, loop: false }],
  }, [
    [r('x'), 0, 26], [r('y'), 0, -4], [r('rot'), 0, 14],
    [l('x'), 0, -20], [l('y'), 0, 6],
    [r('x'), 2, 38], [r('y'), 2, -8], [r('rot'), 2, 6],
    [l('x'), 2, -14], [l('y'), 2, 10], [l('rot'), 2, -18],
    [rw('rot'), 3, -7], [rw('rot'), 6, -3],
    [r('x'), 6, 32], [r('y'), 6, -6], [r('rot'), 6, 18],
    [r('x'), 10, 26], [r('y'), 10, -4], [r('rot'), 10, 14],
    [l('x'), 10, -20], [l('rot'), 10, 0],
  ]),
  build('fair', 'Aerial Heavy', { fps: 60, loop: false, blendIn: 1,
    weapons: { right: { id: 'revolver', mountX: 0, mountY: -2, gripOffsetX: -10, gripOffsetY: 0, gripRot: 0 } },
    vfx: [{ effect: 'spray', anchor: 'weapon', startFrame: 3, duration: 9, scale: 1, rotation: 6, offsetX: 10, offsetY: 0, loop: false }],
  }, [
    [r('x'), 0, 30], [r('y'), 0, 8], [r('rot'), 0, 30],
    [l('x'), 0, -18], [l('y'), 0, 10],
    [r('x'), 3, 24], [r('y'), 3, 12], [r('rot'), 3, 48],
    [l('x'), 3, -14], [l('y'), 3, 14], [l('rot'), 3, -24],
    [r('x'), 7, 46], [r('y'), 7, 2], [r('rot'), 7, 12],
    [l('x'), 7, -10], [l('y'), 7, 8], [l('rot'), 7, -12],
    [rw('rot'), 5, -12], [rw('rot'), 8, -5],
    [r('x'), 14, 34], [r('y'), 14, -2], [r('rot'), 14, 6],
    [l('x'), 14, -20], [l('rot'), 14, 0],
  ]),
  build('shield', 'Shield / Block', { fps: 60, loop: true, blendIn: 3 }, [
    [r('x'), 0, 6], [r('y'), 0, -8], [r('rot'), 0, 20],
    [l('x'), 0, -6], [l('y'), 0, -6], [l('rot'), 0, -18],
  ]),
  // Dash: a grounded forward lunge. The runtime fallback is DEFAULT_ATTACKS
  // 'dash' (startup 0, active 8, recovery 10, w100 h50 ox50); customize its
  // hitbox here and the saved animation overrides that fallback in-game.
  build('dash', 'Dash', { fps: 60, loop: false, blendIn: 2 }, [
    [r('x'), 0, 8], [r('y'), 0, 14], [r('rot'), 0, 30],
    [l('x'), 0, -24], [l('y'), 0, 6],
    [r('x'), 4, 58], [r('y'), 4, -2], [r('rot'), 4, -6],
    [l('x'), 4, -30], [l('y'), 4, 10], [l('rot'), 4, -18],
    [r('x'), 10, 66], [r('y'), 10, 4], [r('rot'), 10, -14],
    [l('x'), 10, -34], [l('y'), 10, 14],
    [r('x'), 16, 30], [r('y'), 16, 0], [r('rot'), 16, 6],
    [l('x'), 16, -22], [l('y'), 16, 8], [l('rot'), 16, 0],
    [r('x'), 19, 16], [r('y'), 19, 4], [r('rot'), 19, 2],
    [l('x'), 19, -22], [l('y'), 19, 6],
  ]),
];

let animLib = new Map();

// Playback-side cache invalidation. Gameplay animation playback keeps a
// read-only clone per id so attacks don't deep-clone a whole animation on
// every start; the library can only change while the editor is open, so we
// notify a listener whenever any mutation happens and the caller clears it.
let _libChange = null;
export function setAnimLibChangeListener(fn) { _libChange = fn; }
function notifyLibChanged() {
  if (_libChange) _libChange();
}

export function loadDefaultLibrary() {
  animLib = new Map();
  for (const a of DEFAULT_ANIMATIONS) animLib.set(a.id, cloneAnimation(a));
  notifyLibChanged();
};

// Load user-saved library over the defaults.
try {
  if (typeof localStorage !== 'undefined') {
    const raw = localStorage.getItem(ANIM_STORE_KEY);
    if (raw) {
      const saved = JSON.parse(raw);
      loadDefaultLibrary();
      for (const a of saved) if (a && a.id) animLib.set(a.id, a);
    }
  }
} catch (err) { /* corrupt store — fall back to defaults */ }

if (animLib.size === 0) loadDefaultLibrary();

function persist() {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(ANIM_STORE_KEY, JSON.stringify([...animLib.values()]));
  } catch (err) { /* ignore */ }
}

export function listAnimations() {
  return [...animLib.values()].map(a => ({ id: a.id, name: a.name, loop: !!a.loop }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function getAnimation(id) {
  const a = animLib.get(id);
  return a ? cloneAnimation(a) : null;
}

export function getAnimationRaw(id) {
  return animLib.get(id) || null;
}

export function saveAnimation(anim) {
  if (!anim || !anim.id) return false;
  animLib.set(anim.id, cloneAnimation(anim));
  persist();
  notifyLibChanged();
  return true;
}

export function createAnimation(id, name) {
  const anim = {
    id: id || `anim-${Date.now()}`,
    name: name || (id || 'New Animation'),
    fps: 60, loop: false, mirror: true, blendIn: 3,
    weapons: { right: null, left: null },
    combat: null,
    vfx: [],
    tracks: {},
  };
  // Seed with a neutral REST pose so the first frame is never blank.
  ensureTrack(anim, propPath('hands', 'right', 'x')).keyframes.push({ f: 0, v: REST_R.x, e: 'linear' });
  ensureTrack(anim, propPath('hands', 'right', 'y')).keyframes.push({ f: 0, v: REST_R.y, e: 'linear' });
  ensureTrack(anim, propPath('hands', 'left', 'x')).keyframes.push({ f: 0, v: REST_L.x, e: 'linear' });
  ensureTrack(anim, propPath('hands', 'left', 'y')).keyframes.push({ f: 0, v: REST_L.y, e: 'linear' });
  return anim;
}

export function deleteAnimation(id) {
  animLib.delete(id);
  persist();
  notifyLibChanged();
}

export function renameAnimation(id, name) {
  const a = animLib.get(id);
  if (!a) return;
  a.name = name;
  persist();
  notifyLibChanged();
}

export function duplicateAnimationInLibrary(id, newId) {
  const src = animLib.get(id);
  if (!src) return null;
  const copy = cloneAnimation(src);
  copy.id = newId || `${id}-copy-${Date.now()}`;
  copy.name = `${src.name} Copy`;
  animLib.set(copy.id, copy);
  persist();
  notifyLibChanged();
  return copy;
}

export function exportAnimation(id) {
  const a = animLib.get(id);
  return a ? JSON.stringify(a, null, 2) : null;
}

export function exportAllAnimations() {
  return JSON.stringify([...animLib.values()], null, 2);
}

// Import a single animation JSON (or an array of them). Returns the ids added.
export function importAnimationsJSON(text) {
  const data = JSON.parse(text);
  const list = Array.isArray(data) ? data : [data];
  const added = [];
  for (const a of list) {
    if (!a || !a.id) continue;
    animLib.set(a.id, a);
    added.push(a.id);
  }
  persist();
  notifyLibChanged();
  return added;
}

export function resetLibraryToDefaults() {
  loadDefaultLibrary();
  persist();
}