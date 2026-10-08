import { updateFighterVfx, resetFighterVfx } from './fx.js';


// ── merged from anim/core.js ──
// core.js — keyframe animation data model + sampling for the Hand/Weapon
// Animator. Pure data + math, no DOM/canvas/game dependencies.
//
// An Animation is a flat object:
//   {
//     id, name, fps, loop, mirror, blendIn,
//     weapons: { left: cfg|null, right: cfg|null },      // weapon assignments
//     tracks:  { 'hands.right.x': Track, 'hands.left.rot': Track, ... }
//   }
// A Track is { prop: 'x', keyframes: [{ f, v, e }] } — sorted by frame.
// Property paths:  hands.<left|right>.<prop>  ·  weapons.<left|right>.<prop>
// Every transform parameter keyframes identically for hands and weapons
// (x, y, rot, scaleX, scaleY, width, height, opacity, visible, flipX, flipY, z).

export const EASING = {
  linear:   t => t,
  easeIn:   t => t * t * t,
  easeOut:  t => 1 - Math.pow(1 - t, 3),
  easeInOut: t => t * t * (3 - 2 * t),
  step:     () => 0, // hold previous value until the next keyframe
};

export function interpValue(prev, next, t, easeName) {
  const fn = EASING[easeName] || EASING.linear;
  const e = fn(Math.min(1, Math.max(0, t)));
  return prev + (next - prev) * e;
}

export function createTrack(prop) {
  return { prop, keyframes: [] }; // { f, v, e }
}

export function addKeyframe(track, frame, value, easeName) {
  const f = Math.max(0, Math.round(frame));
  const kf = { f, v: value, e: easeName || 'linear' };
  const i = track.keyframes.findIndex(k => k.f === f);
  if (i >= 0) track.keyframes[i] = kf;
  else track.keyframes.push(kf);
  track.keyframes.sort((a, b) => a.f - b.f);
  return kf;
}

export function removeKeyframeAt(track, frame) {
  const f = Math.round(frame);
  const i = track.keyframes.findIndex(k => k.f === f);
  if (i >= 0) track.keyframes.splice(i, 1);
}

export function exactKey(track, frame) {
  const f = Math.round(frame);
  return track.keyframes.find(k => k.f === f) || null;
}

export function keyAtOrBefore(track, frame) {
  let prev = null;
  for (const k of track.keyframes) {
    if (k.f <= frame) prev = k;
    else break;
  }
  return prev;
}

export function keyAtOrAfter(track, frame) {
  for (const k of track.keyframes) if (k.f >= frame) return k;
  return null;
}

// Sample a track at `frame`. Segments interpolate with the PREVIOUS key's ease
// mode; a track with one keyframe holds; an empty track returns `def`.
export function sampleTrack(track, frame, def) {
  if (!track || !track.keyframes.length) return def;
  const prev = keyAtOrBefore(track, frame);
  if (!prev) { // before the first keyframe: hold first keyframe value
    return track.keyframes[0].v;
  }
  const next = keyAtOrAfter(track, frame);
  if (!next || next === prev) return prev.v;
  const span = next.f - prev.f;
  if (span <= 0) return next.v;
  return interpValue(prev.v, next.v, (frame - prev.f) / span, prev.e);
}

// ── track helpers ────────────────────────────────────────────────────────

export function nearestKey(track, frame) {
  if (!track || !track.keyframes.length) return null;
  let best = null;
  let bestD = Infinity;
  for (const k of track.keyframes) {
    const d = Math.abs(k.f - frame);
    if (d < bestD) { bestD = d; best = k; }
  }
  return best;
}

// Move (or insert-then-move) a keyframe. Returns the moved keyframe.
export function moveKeyframe(track, fromFrame, toFrame) {
  const k = exactKey(track, fromFrame);
  if (!k) return null;
  removeKeyframeAt(track, fromFrame);
  return addKeyframe(track, toFrame, k.v, k.e);
}

export function shiftTrack(track, delta) {
  for (const k of track.keyframes) k.f = Math.max(0, k.f + delta);
  track.keyframes.sort((a, b) => a.f - b.f);
}

export function reverseTrack(track, frameCount) {
  for (const k of track.keyframes) k.f = Math.max(0, frameCount - k.f);
  track.keyframes.sort((a, b) => a.f - b.f);
}

export function flipTrackH(track, mirrorValue) {
  for (const k of track.keyframes) k.v = mirrorValue(k.v);
}

export function scaleTrackTiming(track, factor) {
  for (const k of track.keyframes) k.f = Math.max(0, Math.round(k.f * factor));
  track.keyframes.sort((a, b) => a.f - b.f);
}

// ── animation structure helpers ──────────────────────────────────────────

const SIDES = ['left', 'right'];
const TRACK_GROUPS = ['hands', 'weapons'];

export function ensureTrack(anim, path) {
  if (!anim.tracks) anim.tracks = {};
  if (!anim.tracks[path]) anim.tracks[path] = createTrack(path);
  return anim.tracks[path];
}

export function getTrack(anim, path) {
  return (anim.tracks && anim.tracks[path]) || null;
}

export function allTrackPaths(anim) {
  const mine = anim.tracks ? Object.keys(anim.tracks) : [];
  const set = new Set(mine);
  for (const g of TRACK_GROUPS) for (const s of SIDES) {
    for (const p of TRANSFORM_PROPS) set.add(`${g}.${s}.${p}`);
  }
  return Array.from(set).sort();
}

// The transform parameters — identical schema for hands and weapons.
export const TRANSFORM_PROPS = [
  'x', 'y', 'rot', 'scaleX', 'scaleY',
  'width', 'height', 'opacity', 'visible', 'flipX', 'flipY', 'z',
];

export const PROP_LABEL = {
  x: 'X', y: 'Y', rot: 'Rotation', scaleX: 'Scale X', scaleY: 'Scale Y',
  width: 'Width', height: 'Height', opacity: 'Opacity', visible: 'Visible',
  flipX: 'Flip X', flipY: 'Flip Y', z: 'Depth',
};

// Sensible per-property drag sensitivity for the editor value readouts.
export const PROP_STEP = {
  x: 2, y: 2, rot: 1, scaleX: 0.01, scaleY: 0.01,
  width: 1, height: 1, opacity: 0.02, visible: 1, flipX: 1, flipY: 1, z: 0.5,
};

const _pathCache = Object.create(null);
export function propPath(group, side, prop) {
  const key = group + '.' + side + '.' + prop;
  return _pathCache[key] || (_pathCache[key] = key);
}

export function sampleAnimation(anim, frame) {
  // Returns flat { path: value } for every keyframeable property, filling
  // defaults for tracks that have no keyframes.
  const out = {};
  for (const g of TRACK_GROUPS) {
    for (const s of SIDES) {
      for (const p of TRANSFORM_PROPS) {
        const def = DEFAULT_VALUES[p];
        const tr = getTrack(anim, propPath(g, s, p));
        out[propPath(g, s, p)] = sampleTrack(tr, frame, def);
      }
    }
  }
  return out;
}

// Property defaults — hands + weapons share the same template. `width`/`height`
// of 0 mean "auto" at render time (use base hand/weapon size).
export const DEFAULT_VALUES = {
  x: 0, y: 0, rot: 0, scaleX: 1, scaleY: 1,
  width: 0, height: 0, opacity: 1, visible: 1, flipX: 0, flipY: 0, z: 0,
};

export function objectDefaults() {
  return { ...DEFAULT_VALUES };
}

// One canonical default REST pose for both hands (per §19). Values are world
// pixels relative to the fighter center, tuned for a ~30px radius ball.
export const DEFAULT_POSE = {
  hands: {
    left:  { ...objectDefaults(), x: -26, y: 6 },
    right: { ...objectDefaults(), x: 28, y: -8 },
  },
  weapons: {
    left:  { ...objectDefaults(), z: -1 },
    right: { ...objectDefaults(), z: 2 },
  },
};

// ── animation tools (§18) ────────────────────────────────────────────────

export function cloneAnimation(anim) {
  return JSON.parse(JSON.stringify(anim));
}

export function duplicateAnimation(anim, newId) {
  const copy = cloneAnimation(anim);
  copy.id = newId;
  copy.name = anim.name ? `${anim.name} Copy` : newId;
  return copy;
}

// Whole-animation keyframe copy/paste (Hand Animator COPY ALL / PASTE ALL).
// Clones ONLY the pose tracks (every keyframe on every track) — id, name,
// weapons, combat, vfx, fps and loop stay with the paste target.
export function cloneAnimTracks(tracks) {
  return JSON.parse(JSON.stringify(tracks || {}));
}

export function reverseAnimation(anim, frameCount) {
  const copy = cloneAnimation(anim);
  for (const path of Object.keys(copy.tracks || {})) reverseTrack(copy.tracks[path], frameCount);
  return copy;
}

// Flip horizontally: mirror x sign per keyframe, negate rotations. Per-keyframe
// transforms, so keyframes map independently of track semantics. Weapon `x` is
// pivot-relative and the pivot is a fixed sprite-space point that does not
// mirror with the art, so the caller supplies the per-side pivot x (defaults to
// no pivot, i.e. a plain negation).
export function flipAnimationH(anim, weaponPivotX) {
  const copy = cloneAnimation(anim);
  const pivotX = typeof weaponPivotX === 'function' ? weaponPivotX : () => 0;
  const flipProp = (path, prop, v) => {
    if (prop === 'x') {
      if (path.startsWith('weapons.')) return -v + 2 * pivotX(path.split('.')[1]);
      return -v;
    }
    if (prop === 'rot') return -v;
    if (prop === 'flipX') return v ? 0 : 1;
    return v;
  };
  for (const path of Object.keys(copy.tracks || {})) {
    const prop = path.split('.').pop();
    for (const k of copy.tracks[path].keyframes) k.v = flipProp(path, prop, k.v);
  }
  // Weapon assignments mirror grip/mount offsets.
  if (copy.weapons) {
    for (const side of SIDES) {
      const w = copy.weapons[side];
      if (!w) continue;
      if (typeof w.gripOffsetX === 'number') w.gripOffsetX = -w.gripOffsetX;
      if (typeof w.mountX === 'number') w.mountX = -w.mountX;
      if (typeof w.gripRot === 'number') w.gripRot = -w.gripRot;
    }
  }
  // The flip has to carry the sprite art as well. flipX defaults to 0 and a
  // side may have no flipX track at all, in which case the sprite would keep
  // its unflipped orientation while the pose mirrors around it — seed the
  // toggled key for every side/group that carries authored pose data.
  for (const path of Object.keys(copy.tracks)) {
    const parts = path.split('.');
    const fx = propPath(parts[0], parts[1], 'flipX');
    if (copy.tracks[fx]) continue;
    addKeyframe(ensureTrack(copy, fx), 0, 1, 'linear');
  }
  return copy;
}

export function shiftAnimationTiming(anim, delta) {
  const copy = cloneAnimation(anim);
  for (const path of Object.keys(copy.tracks || {})) shiftTrack(copy.tracks[path], delta);
  return copy;
}

export function scaleAnimationTiming(anim, factor) {
  const copy = cloneAnimation(anim);
  copy.fps = Math.max(1, Math.round((copy.fps || 60) / factor));
  for (const path of Object.keys(copy.tracks || {})) scaleTrackTiming(copy.tracks[path], factor);
  return copy;
}

export function animationFrameCount(anim) {
  let max = 0;
  for (const path of Object.keys((anim && anim.tracks) || {})) {
    const kf = anim.tracks[path].keyframes;
    if (kf.length) max = Math.max(max, kf[kf.length - 1].f);
  }
  return max;
}


// ── merged from anim/weapons.js ──
// weapons.js — reusable weapon library (§12). Weapons live SEPARATELY from
// animations. Each weapon is a data object:
//   {
//     id, name, type,              // art flavour
//     w, h,                        // sprite base size (px)
//     color, accent,               // art colours
//     mirror,                      // participates in left/right mirroring
//     pivot:   { x, y },           // rotation pivot (= grip by default)
//     anchors: { grip: {x,y}, tip: {x,y}, center: {x,y}, custom: [{id,x,y}] }
//   }
// Anchor coordinates are in WEAPON-SPRITE space: origin = sprite center,
// +x = right, +y = down. They are never mirrored — the art flips instead, so
// the grip/tip stay glued to the correct spots of the weapon.
//
// Baseline library ships in repo (human-readable); user-created weapons are
// layered on top from localStorage. Export produces the same JSON you can drop
// back into the weapons folder.

// v2 — the v1 store carried locally-created weapons from the old editor that
// duplicated the GA folder assets. Shipping the GA sprite weapons clean means
// starting fresh instead of merging stale editor weapons on top of defaults.
export const WEAPON_STORE_KEY = 'smashfighters.weapons.v2';

const ANCHOR = (x, y) => ({ x, y });

const DEFAULT_WEAPONS = [
  // Sprite-only catalogue: every entry draws a GA PNG (procedural type art
  // in drawWeapon is purely the while-loading/error fallback).
  {
    id: 'revolver', name: 'Revolver', type: 'gun', w: 64, h: 20,
    color: '#2b2b2b', accent: '#44aaff', mirror: true,
    sprite: '/GA/weapons/revolver.png',
    pivot: { x: -10, y: 4 },
    anchors: {
      grip: ANCHOR(-10, 4), tip: ANCHOR(11, -5),
      center: ANCHOR(0, 0), custom: [],
    },
  },
  {
    id: 'rifle', name: 'Rifle', type: 'gun', w: 80, h: 24,
    color: '#2b2b2b', accent: '#44aaff', mirror: true,
    sprite: '/GA/weapons/rifle.png',
    pivot: { x: -29, y: 3 },
    anchors: {
      grip: ANCHOR(-29, 3), tip: ANCHOR(30, -4),
      center: ANCHOR(0, 0), custom: [],
    },
  },
  // Ninja sword (GA sprite): the blade is authored diagonally (guard near
  // bottom-left, tip top-right), so grip/tip anchors sit at the handle middle
  // and the tip in sprite space. The hand-attachment math is identical to
  // every other weapon (grip glued to the hand) — only the art + anchors are
  // new, no second weapon system.
  {
    id: 'ninjaSword', name: 'Ninja Sword', type: 'sword', w: 132, h: 88,
    color: '#d8d8d8', accent: '#e8b53a', mirror: true,
    sprite: '/GA/weapons/sword.png',
    pivot: { x: -43, y: 24 },
    anchors: {
      grip: ANCHOR(-43, 24), tip: ANCHOR(62, -42),
      center: ANCHOR(10, -9), custom: [],
    },
  },
  {
    id: 'shuriken', name: 'Shuriken', type: 'throwing', w: 32, h: 32,
    color: '#2c3e50', accent: '#3498db', mirror: true,
    sprite: '/GA/weapons/shuriken.png',
    pivot: { x: 0, y: 0 },
    anchors: {
      grip: ANCHOR(0, 0), tip: ANCHOR(0, -12),
      center: ANCHOR(0, 0), custom: [],
    },
  },
  // GA sprite arms (sword.png landscape 3:2, shield.png square): the PNG draws
  // when loaded, with drawWeapon's procedural type art as the automatic
  // fallback — the same pattern every other sprite weapon uses. Anchors are
  // the neutral center-grip defaults; fine-tune per weapon in the editor.
  {
    id: 'sword', name: 'Sword', type: 'sword', w: 96, h: 64,
    color: '#cfd8e3', accent: '#d9a92e', mirror: true,
    sprite: '/GA/weapons/sword.png',
    pivot: { x: 0, y: 0 },
    anchors: {
      grip: ANCHOR(0, 0), tip: ANCHOR(44, 0),
      center: ANCHOR(0, 0), custom: [],
    },
  },
  {
    id: 'shield', name: 'Shield', type: 'shield', w: 66, h: 66,
    color: '#2e4a8a', accent: '#d9a92e', mirror: true,
    sprite: '/GA/weapons/shield.png',
    pivot: { x: 0, y: 0 },
    anchors: {
      grip: ANCHOR(0, 0), tip: ANCHOR(0, -30),
      center: ANCHOR(0, 0), custom: [],
    },
  },
  {
    id: 'knightsword', name: 'Knight Sword', type: 'sword', w: 96, h: 64,
    color: '#cfd8e3', accent: '#d9a92e', mirror: true,
    sprite: '/GA/weapons/knightsword.png',
    pivot: { x: 0, y: 0 },
    anchors: {
      grip: ANCHOR(0, 0), tip: ANCHOR(44, 0),
      center: ANCHOR(0, 0), custom: [],
    },
  },
  // Pirate saber (GA sprite): portrait 551x682 authored DIAGONALLY, exactly
  // like the ninja blade — grip/handle at the lower-left, curved tip at the
  // upper-right. Anchor values are in the SCALED draw space (the fitted w/h
  // box), so they are derived from the sprite's authored offsets: the raw
  // pixel offsets from image centre are (-150, +270) at the grip and
  // (+220, -329) at the tip, and the fitted scale is min(58/551, 72/682) =
  // 0.1053. The hand-attachment math is identical to every other weapon (grip
  // glued to the hand) — only the art + anchors are new, no second weapon
  // system.
  {
    id: 'saber', name: 'Pirate Saber', type: 'sword', w: 58, h: 72,
    color: '#d9e2ea', accent: '#c8a24a', mirror: true,
    sprite: '/GA/weapons/saber.png',
    pivot: { x: -13, y: 28 },
    anchors: {
      grip: ANCHOR(-13, 28), tip: ANCHOR(23, -35),
      center: ANCHOR(5, -3), custom: [],
    },
  },
  // Pirate hand cannon (GA sprite): landscape 1536x1024, authored as a
  // side-view barrel pointing right, like the rifle family.
  // Fitted into an 84x56 box (scale min(84/1536, 56/1024) = 0.0547): the
  // grip sits back-left of centre where the hand holds the breech and the
  // tip at the muzzle lip, so the cannonball (projectileSpawn reads the
  // weapon's tip anchor) leaves the barrel mouth. Anchors are starter
  // values in the fitted draw space — fine-tune per weapon in the editor
  // (weapon guides overlay) like every other sprite weapon.
  {
    id: 'pirateCannon', name: 'Pirate Cannon', type: 'gun', w: 84, h: 56,
    color: '#3a2f28', accent: '#c8a24a', mirror: true,
    sprite: '/GA/weapons/piratecannon.png',
    pivot: { x: -16, y: 8 },
    anchors: {
      grip: ANCHOR(-16, 8), tip: ANCHOR(38, -2),
      center: ANCHOR(8, 2), custom: [],
    },
  },
  // Pirate flintlock (GA sprite): landscape 1536x1024 side-view pistol
  // pointing right. Fitted into a 64x36 box; grip at the handle, tip at the
  // muzzle. Same starter-anchor caveat as the cannon above.
  {
    id: 'pirateFlintlock', name: 'Pirate Flintlock', type: 'gun', w: 64, h: 36,
    color: '#3a2f28', accent: '#c8a24a', mirror: true,
    sprite: '/GA/weapons/pirateflintknock.png',
    pivot: { x: -12, y: 6 },
    anchors: {
      grip: ANCHOR(-12, 6), tip: ANCHOR(26, -3),
      center: ANCHOR(6, 1), custom: [],
    },
  },
];

let weaponLib = new Map();
for (const w of DEFAULT_WEAPONS) weaponLib.set(w.id, w);

// Merge localStorage weapons over the baseline.
try {
  if (typeof localStorage !== 'undefined') {
    const raw = localStorage.getItem(WEAPON_STORE_KEY);
    if (raw) {
      for (const w of JSON.parse(raw)) weaponLib.set(w.id, normalizeWeapon(w));
    }
  }
} catch (err) { /* corrupt store — ignore */ }

function normalizeWeapon(w) {
  return {
    mirror: true,
    ...w,
    anchors: {
      grip: w.anchors?.grip || ANCHOR(0, 0),
      tip: w.anchors?.tip || ANCHOR(0, -10),
      center: w.anchors?.center || ANCHOR(0, 0),
      custom: Array.isArray(w.anchors?.custom) ? w.anchors.custom : [],
    },
    pivot: w.pivot || w.anchors?.grip || ANCHOR(0, 0),
    scale: w.scale == null ? 1 : w.scale,
    rotation: w.rotation || 0,
    offsetX: w.offsetX || 0,
    offsetY: w.offsetY || 0,
    handAnchor: w.handAnchor || 'right',
    vfxAnchor: w.vfxAnchor || w.anchors?.tip || ANCHOR(0, -10),
    sprite: w.sprite || null,
  };
}

// getWeapon is called every animated frame (per side, per fighter) — resolving
// the same def each time. normalizeWeapon spreads + allocates a new object, so
// cache the normalized result per id. Runtime only READS weapon defs in
// resolveWeapon (pivot/anchors/size), never mutates them, so sharing one
// object is safe. Every mutation path below invalidates the cache.
const _weaponDefCache = new Map();

// Sprite image cache — one Image per weapon sprite path, loaded lazily.
// status: 'loading' | 'loaded' | 'error'
const _spriteCache = new Map();

export function getWeaponSprite(spritePath) {
  if (!spritePath) return null;
  let entry = _spriteCache.get(spritePath);
  if (entry) {
    if (entry.status === 'error' && performance.now() - entry.lastAttempt > 5000) {
      entry.status = 'loading';
      entry.lastAttempt = performance.now();
      const img = new Image();
      entry.img = img;
      img.onload = () => { entry.status = 'loaded'; };
      img.onerror = () => { entry.status = 'error'; };
      img.src = spritePath;
    }
    return entry;
  }
  entry = { status: 'loading', lastAttempt: performance.now() };
  _spriteCache.set(spritePath, entry);
  const img = new Image();
  entry.img = img;
  img.onload = () => { entry.status = 'loaded'; };
  img.onerror = () => { entry.status = 'error'; };
  img.src = spritePath;
  return entry;
}

// Baked weapon sprites — the FPS fix for weapon rendering. A GA weapon PNG
// decodes to a multi-megapixel bitmap, and drawWeapon used to resample the
// whole thing down into a ~100px hand every frame, with high-quality
// smoothing on top. Instead each weapon is downscaled ONCE (same high-quality
// resample) into a small offscreen canvas at 2x its fitted draw size, and
// every frame blits that: identical pixels, a fraction of the fill rate, and
// crisp under camera zoom up to 2x. Same pattern as the baked body sprites
// in render/Effects.js.
const WEAPON_BAKE_SS = 2;
const _weaponBakeCache = new Map(); // key: sprite path + fitted size -> { img, canvas }

function bakedWeaponSprite(spritePath, img, dw, dh) {
  const key = spritePath + '|' + Math.max(1, Math.round(dw)) + 'x' + Math.max(1, Math.round(dh));
  const hit = _weaponBakeCache.get(key);
  if (hit && hit.img === img) return hit.canvas;
  const bw = Math.max(2, Math.ceil(dw * WEAPON_BAKE_SS));
  const bh = Math.max(2, Math.ceil(dh * WEAPON_BAKE_SS));
  let canvas = null;
  try {
    canvas = document.createElement('canvas');
    canvas.width = bw;
    canvas.height = bh;
    const m = canvas.getContext('2d');
    m.imageSmoothingEnabled = true;
    m.imageSmoothingQuality = 'high';
    m.clearRect(0, 0, bw, bh);
    m.drawImage(img, 0, 0, bw, bh);
  } catch (_) {
    return null;
  }
  if (_weaponBakeCache.size >= 32) _weaponBakeCache.delete(_weaponBakeCache.keys().next().value);
  _weaponBakeCache.set(key, { img, canvas });
  return canvas;
}

// Diagnostic: number of baked weapon sprites (used by the node harness).
export function weaponBakeCount() { return _weaponBakeCache.size; }

function persistWeaponLib() {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(WEAPON_STORE_KEY, JSON.stringify([...weaponLib.values()]));
  } catch (err) { /* ignore */ }
}

function invalidateWeaponCache() {
  _weaponDefCache.clear();
}

export function getWeapon(id) {
  if (!id) return null;
  const raw = weaponLib.get(id);
  if (!raw) return null;
  let w = _weaponDefCache.get(id);
  if (!w) {
    w = normalizeWeapon(raw);
    _weaponDefCache.set(id, w);
  }
  return w;
}

export function getWeaponRaw(id) {
  return weaponLib.get(id) || null;
}

export function allWeapons() {
  return [...weaponLib.values()].map(normalizeWeapon);
}

export function addWeapon(def) {
  const w = normalizeWeapon(def);
  if (!w.id) return null;
  weaponLib.set(w.id, w);
  persistWeaponLib();
  invalidateWeaponCache();
  return w;
}

export function updateWeapon(id, patch) {
  const cur = weaponLib.get(id);
  if (!cur) return null;
  const w = normalizeWeapon({ ...cur, ...patch });
  weaponLib.set(id, w);
  persistWeaponLib();
  invalidateWeaponCache();
  return w;
}

export function deleteWeapon(id) {
  weaponLib.delete(id);
  persistWeaponLib();
  invalidateWeaponCache();
}

export function resetWeaponLibrary() {
  weaponLib = new Map();
  for (const w of DEFAULT_WEAPONS) weaponLib.set(w.id, w);
  persistWeaponLib();
  invalidateWeaponCache();
}

export function weaponsToJSON() {
  return JSON.stringify([...weaponLib.values()], null, 2);
}

export function importWeaponsJSON(text) {
  const list = JSON.parse(text);
  if (!Array.isArray(list)) throw new Error('Weapon list must be an array.');
  for (const w of list) {
    if (w && w.id) addWeapon(w); // addWeapon invalidates the def cache
  }
}

// A fresh weapon assignment config for an animation (§5: hand anchors +
// grip offsets + mirroring live here, per side).
export function emptyWeaponCfg(id = null) {
  return { id, mountX: 0, mountY: 0, gripOffsetX: 0, gripOffsetY: 0, gripRot: 0, mirror: true };
}

// ── procedural weapon art ────────────────────────────────────────────────
// Draws the weapon in SPRITE space: (0,0) is the sprite center, +x right, +y
// down. size is w×h as given in the def. Anchors/pivot can be overlaid for
// editor editing.
export function drawWeapon(ctx, def, overrides = {}) {
  const w = def.w || 40;
  const h = def.h || 40;
  const c = overrides.color || def.color || '#cccccc';
  const a = overrides.accent || def.accent || '#888888';
  const type = def.type || 'sword';

  // Sprite-based weapon: draw the image centered at (0,0) in sprite space.
  // The blit goes through the baked cache above, never the raw bitmap.
  if (def.sprite) {
    const entry = getWeaponSprite(def.sprite);
    const img = entry && entry.status === 'loaded' ? entry.img : null;
    if (img && img.width > 0 && img.height > 0) {
      const scale = Math.min(w / img.width, h / img.height);
      const dw = img.width * scale;
      const dh = img.height * scale;
      ctx.drawImage(bakedWeaponSprite(def.sprite, img, dw, dh) || img, -dw / 2, -dh / 2, dw, dh);
      return;
    }
    // Sprite still loading or errored — fall through to procedural draw
  }

  ctx.save();
  ctx.lineWidth = 2;
  ctx.strokeStyle = '#111111';

  switch (type) {
    case 'sword': {
      // blade up, crossguard at grip (y=+34 area)
      ctx.fillStyle = c;
      ctx.fillRect(-3.5, -h / 2 + 8, 7, h * 0.58);                 // blade
      ctx.fillStyle = a;
      ctx.fillRect(-13, h * 0.20, 26, 4);                          // guard
      ctx.fillRect(-3.5, h * 0.20, 7, h * 0.30);                   // handle
      ctx.strokeRect(-3.5, -h / 2 + 8, 7, h * 0.58);
      ctx.strokeRect(-13, h * 0.20, 26, 4);
      ctx.strokeRect(-3.5, h * 0.20, 7, h * 0.30);
      break;
    }
    case 'gun': {
      ctx.fillStyle = c;
      ctx.fillRect(-w / 2, -h / 2, w, h);                          // body
      ctx.fillRect(w / 2 - 10, -h / 2 - 6, 6, 12);                // muzzle lip
      ctx.fillStyle = a;
      ctx.fillRect(-w / 2 + 4, -h / 2 + 4, w * 0.4, h * 0.4);     // grip block
      ctx.fillRect(-20, h / 2, 14, 12);                            // pistol grip
      ctx.strokeRect(-w / 2, -h / 2, w, h);
      break;
    }
    case 'hammer': {
      // handle + heavy head
      ctx.fillStyle = a;
      ctx.fillRect(-4, -h / 2 + 6, 8, h * 0.6);                    // handle
      ctx.fillStyle = c;
      ctx.fillRect(-h * 0.30, -h / 2 + 2, h * 0.60, 20);           // head
      ctx.strokeRect(-h * 0.30, -h / 2 + 2, h * 0.60, 20);
      ctx.strokeRect(-4, -h / 2 + 6, 8, h * 0.6);
      break;
    }
    case 'shield': {
      ctx.beginPath();
      ctx.ellipse(0, 2, w / 2, h / 2, 0, 0, Math.PI * 2);
      ctx.fillStyle = c;
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = a;
      ctx.beginPath();
      ctx.arc(0, 2, w * 0.22, 0, Math.PI * 2);
      ctx.fill();
      break;
    }
    case 'staff': {
      ctx.fillStyle = c;
      ctx.fillRect(-4, -h / 2, 8, h);                              // shaft
      ctx.fillStyle = a;
      ctx.beginPath();
      ctx.arc(0, -h / 2 + 6, 9, 0, Math.PI * 2);                  // orb
      ctx.fill();
      ctx.strokeRect(-4, -h / 2, 8, h);
      break;
    }
    case 'throwing': {
      // Shuriken fallback (used only while the GA sprite is loading or on
      // error — the registered sprite above is the real art): a 4-point star
      // so the hand never holds an empty/generic box.
      ctx.fillStyle = c;
      ctx.beginPath();
      for (let i = 0; i < 8; i++) {
        const ang = (i * Math.PI) / 4 - Math.PI / 2;
        const r = i % 2 === 0 ? Math.min(w, h) / 2 : Math.min(w, h) / 5;
        const x = Math.cos(ang) * r, y = Math.sin(ang) * r;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = a;
      ctx.beginPath();
      ctx.arc(0, 0, Math.min(w, h) / 8, 0, Math.PI * 2);
      ctx.fill();
      break;
    }
    default: { // generic box
      ctx.fillStyle = c;
      ctx.fillRect(-w / 2, -h / 2, w, h);
      ctx.strokeRect(-w / 2, -h / 2, w, h);
    }
  }
  ctx.restore();
}

// Draw the anchor/pivot markers of a weapon (editor overlay, sprite space).
export function drawWeaponGuides(ctx, def) {
  if (!def) return;
  ctx.save();
  ctx.lineWidth = 1.5;
  const drawAnchor = (p, color, label) => {
    if (!p) return;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.strokeStyle = '#000';
    ctx.stroke();
    if (label) {
      ctx.font = '9px Consolas, monospace';
      ctx.fillStyle = '#fff';
      ctx.strokeText(label, p.x + 6, p.y - 5);
      ctx.fillStyle = '#000';
      ctx.fillText(label, p.x + 6, p.y - 5);
    }
  };
  if (def.pivot) drawAnchor(def.pivot, '#ffd24a', 'P');
  if (def.anchors.grip) drawAnchor(def.anchors.grip, '#4ade80', 'G');
  if (def.anchors.tip) drawAnchor(def.anchors.tip, '#ff5555', 'T');
  if (def.anchors.center) drawAnchor(def.anchors.center, '#9be8ff', 'C');
  for (const c of def.anchors.custom || []) drawAnchor(c, '#c792ea', 'X');
  ctx.restore();
}


// ── merged from anim/library.js ──
// library.js — animation library (§13). Animations are self-contained keyframe
// data (core.js model) + weapon assignments. Defaults ship in-repo here (the
// code-side mirror of `animations/character/`); user saves persist to
// localStorage. Export/import round-trips the same JSON so files can be saved
// into `animations/` and loaded later.


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
// movement pose system (in Effects.js) and are intentionally NOT
// animator-controlled, so no movement animations live in the library.
//
// VFX RULE: an animation carries VFX only when it is BOUND TO AN ABILITY
// (combat.type 'nonHitbox' + combat.abilityId). Every plain melee attack below
// — the cowboy's jab/heavies/aerials, the ninja's slashes, the shadow push, the
// dash attack — ships with an empty vfx list, so a normal swing paints nothing.
// The ability moves that keep art are cowboy fsmash (cowboyFwdHeavy), the ninja's
// fsmash (ninjaFsmash) and the ninja's dtilt (ninjaDtilt, the Teleport Strike);
// ninjaDsmash's Shadow Strike is fired by the ability itself (abilities.js).
// The boxed list above is the BASE set (cowboy + ninja). The exported
// DEFAULT_ANIMATIONS below appends the boxer's derived animations on top, so
// the base const never has to be re-declared when a character is added.
const BASE_ANIMATIONS = [
  // The animator ships exactly one base animation per combat slot (the seven
  // standard attacks, the dash attack, shield/block). Walk/run/jump are
  // rendered by the original movement pose system (in Effects.js) and are
  // intentionally NOT animator-controlled.
  build('jab', 'Neutral Light', { fps: 60, loop: false, blendIn: 1,
    weapons: { right: { id: 'revolver', mountX: 0, mountY: -2, gripOffsetX: -10, gripOffsetY: 0, gripRot: 0 } },
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
  build('fsmash', 'Side Smash', { fps: 60, loop: false, blendIn: 2,
    combat: { type: 'nonHitbox', abilityId: 'cowboyFwdHeavy' },
    weapons: { right: { id: 'rifle', mountX: 0, mountY: -2, gripOffsetX: -18, gripOffsetY: 0, gripRot: 0 } },
    // ABILITY VFX (cowboyFwdHeavy): the rifle report — muzzle flash, blast and
    // the barrel spray. This is the one cowboy swing that paints.
    vfx: [
      { effect: 'cowboyMuzzle', anchor: 'weapon', startFrame: 6, duration: 5, scale: 1.1, rotation: 0, offsetX: 12, offsetY: 0, loop: false },
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
  build('fair', 'Aerial Heavy', { fps: 60, loop: false, blendIn: 2,
    weapons: { right: { id: 'rifle', mountX: 0, mountY: -2, gripOffsetX: -18, gripOffsetY: 0, gripRot: 0 } },
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
  build('ninjaNair', 'Aerial Slash', { fps: 60, loop: false, blendIn: 2,
    weapons: { right: { id: 'ninjaSword', mountX: 0, mountY: -2, gripOffsetX: -8, gripOffsetY: 0, gripRot: 0 } },
  }, [
    [r('x'), 0, 20], [r('y'), 0, -8], [r('rot'), 0, 20],
    [l('x'), 0, -22], [l('y'), 0, 4], [l('rot'), 0, -15],
    [r('x'), 3, 45], [r('y'), 3, -4], [r('rot'), 3, -10],
    [l('x'), 3, -20], [l('rot'), 3, 10],
    [r('x'), 7, 35], [r('y'), 7, -6], [r('rot'), 7, 15],
    [rw('rot'), 5, -25],
    [r('x'), 12, 20], [r('y'), 12, -8], [r('rot'), 12, 20],
    [l('x'), 12, -22], [l('rot'), 12, -15],
  ]),
  build('ninjaFair', 'Aerial Kick', { fps: 60, loop: false, blendIn: 2,
    weapons: { right: { id: 'ninjaSword', mountX: 0, mountY: -2, gripOffsetX: -8, gripOffsetY: 0, gripRot: 0 } },
  }, [
    [r('x'), 0, 15], [r('y'), 0, -4], [r('rot'), 0, 15],
    [l('x'), 0, -20], [l('y'), 0, 6], [l('rot'), 0, -12],
    [r('x'), 4, 55], [r('y'), 4, 4], [r('rot'), 4, -20],
    [l('x'), 4, -25], [l('y'), 4, 10], [l('rot'), 4, 20],
    [r('x'), 8, 40], [r('y'), 8, 2], [r('rot'), 8, -5],
    [rw('rot'), 6, 15],
    [r('x'), 14, 20], [r('y'), 14, -2], [r('rot'), 14, 10],
    [l('x'), 14, -18], [l('rot'), 14, 0],
  ]),
  build('cowboyDownHeavy', 'Down Heavy', { fps: 60, loop: false, blendIn: 2,
    combat: { type: 'nonHitbox', abilityId: 'cowboyDownHeavy' },
    weapons: { right: { id: 'rifle', mountX: 0, mountY: -2, gripOffsetX: -18, gripOffsetY: 0, gripRot: -8 } },
  }, [
    [r('x'), 0, 24], [r('y'), 0, 10], [r('rot'), 0, -10],
    [l('x'), 0, -20], [l('y'), 0, 10], [l('rot'), 0, 4],
    [r('x'), 3, 18], [r('y'), 3, 16], [r('rot'), 3, -22],
    [l('x'), 3, -14], [l('y'), 3, 16], [l('rot'), 3, 12],
    [r('x'), 6, 54], [r('y'), 6, 10], [r('rot'), 6, 28],
    [l('x'), 6, -4], [l('y'), 6, 20], [l('rot'), 6, -10],
    [rw('rot'), 4, 6], [rw('rot'), 7, 30],
    [r('x'), 14, 44], [r('y'), 14, 12], [r('rot'), 14, 14],
    [l('x'), 14, -14], [l('y'), 14, 14],
    [r('x'), 22, 34], [r('y'), 22, 8], [r('rot'), 22, 0],
    [l('x'), 22, -18], [l('y'), 22, 10],
    [r('x'), 32, 26], [r('y'), 32, 4], [r('rot'), 32, -12],
    [l('x'), 32, -20], [l('rot'), 32, 0],
  ]),
  build('cowboyDownLight', 'Down Light', { fps: 60, loop: false, blendIn: 2,
    combat: { type: 'nonHitbox', abilityId: 'cowboyDownLight' },
    weapons: { right: { id: 'revolver', mountX: 0, mountY: -2, gripOffsetX: -10, gripOffsetY: 0, gripRot: 0 } },
  }, [
    // Wind-up: rise up, revolver cocked overhead as the slow-mo bites.
    [r('x'), 0, 22], [r('y'), 0, -12], [r('rot'), 0, 24],
    [l('x'), 0, -8], [l('y'), 0, -6], [l('rot'), 0, 10],
    [r('x'), 3, 16], [r('y'), 3, -16], [r('rot'), 3, 40],
    [l('x'), 3, -16], [l('y'), 3, -8], [l('rot'), 3, -14],
    [rw('rot'), 4, 8],
    // Hold: the "freeze" — arms spread, low stance while the arena burns orange.
    [r('x'), 8, 40], [r('y'), 8, -4], [r('rot'), 8, -6],
    [l('x'), 8, -30], [l('y'), 8, 14], [l('rot'), 8, 20],
    [rw('rot'), 8, -20],
    [r('x'), 16, 34], [r('y'), 16, -6], [r('rot'), 16, 0],
    [l('x'), 16, -28], [l('y'), 16, 12],
    // Recovery: settle back as time returns.
    [r('x'), 24, 24], [r('y'), 24, -10], [r('rot'), 24, 14],
    [l('x'), 24, -16], [l('y'), 24, 2], [l('rot'), 24, -8],
    [rw('rot'), 20, -6],
  ]),
  build('ninjaJab', 'Quick Slash', { fps: 60, loop: false, blendIn: 1,
    weapons: { right: { id: 'ninjaSword', mountX: 0, mountY: -2, gripOffsetX: -8, gripOffsetY: 0, gripRot: 0 } },
  }, [
    [r('x'), 0, 30], [r('y'), 0, -6], [r('rot'), 0, 15],
    [l('x'), 0, -20], [l('y'), 0, 6],
    [r('x'), 2, 50], [r('y'), 2, -2], [r('rot'), 2, -5],
    [l('x'), 2, -16], [l('rot'), 2, -10],
    [r('x'), 5, 40], [r('y'), 5, -4], [r('rot'), 5, 10],
    [rw('rot'), 3, -15],
    [r('x'), 8, 30], [r('y'), 8, -6], [r('rot'), 8, 15],
    [l('x'), 8, -20], [l('rot'), 8, 0],
  ]),
  build('ninjaFtilt', 'Forward Slash', { fps: 60, loop: false, blendIn: 2,
    weapons: { right: { id: 'ninjaSword', mountX: 0, mountY: -2, gripOffsetX: -8, gripOffsetY: 0, gripRot: 0 } },
  }, [
    [r('x'), 0, 28], [r('y'), 0, -4], [r('rot'), 0, 10],
    [l('x'), 0, -22], [l('y'), 0, 8],
    [r('x'), 3, 55], [r('y'), 3, -6], [r('rot'), 3, -8],
    [l('x'), 3, -18], [l('rot'), 3, -12],
    [r('x'), 6, 45], [r('y'), 6, -2], [r('rot'), 6, 12],
    [rw('rot'), 4, -20],
    [r('x'), 12, 28], [r('y'), 12, -4], [r('rot'), 12, 10],
    [l('x'), 12, -22], [l('rot'), 12, 0],
  ]),
  build('ninjaFsmash', 'Shuriken Throw', { fps: 60, loop: false, blendIn: 2,
    combat: { type: 'nonHitbox', abilityId: 'ninjaFsmash' },
    weapons: { right: { id: 'shuriken', mountX: 0, mountY: -2, gripOffsetX: -6, gripOffsetY: 0, gripRot: 0 } },
    // ABILITY VFX (ninjaFsmash): the release pop on the thrown shuriken.
    vfx: [{ effect: 'ninjaMuzzle', anchor: 'weapon', startFrame: 8, duration: 4, scale: 1.0, rotation: 0, offsetX: 10, offsetY: 0, loop: false }],
  }, [
    [r('x'), 0, 20], [r('y'), 0, -8], [r('rot'), 0, 20],
    [l('x'), 0, -18], [l('y'), 0, 10], [l('rot'), 0, -10],
    [r('x'), 4, 35], [r('y'), 4, -12], [r('rot'), 4, 45],
    [l('x'), 4, -25], [l('y'), 4, 14], [l('rot'), 4, -20],
    [rw('rot'), 6, 30],
    [r('x'), 8, 60], [r('y'), 8, -6], [r('rot'), 8, -10],
    [l('x'), 8, -30], [l('y'), 8, 8], [l('rot'), 8, 10],
    [rw('rot'), 8, 0],
    [r('x'), 14, 30], [r('y'), 14, -2], [r('rot'), 14, 10],
    [l('x'), 14, -22], [l('rot'), 14, 0],
  ]),
  build('ninjaUtilt', 'Upward Slash', { fps: 60, loop: false, blendIn: 2,
    weapons: { right: { id: 'ninjaSword', mountX: 0, mountY: -2, gripOffsetX: -8, gripOffsetY: 0, gripRot: 0 } },
  }, [
    [r('x'), 0, 10], [r('y'), 0, -12], [r('rot'), 0, 80],
    [l('x'), 0, -10], [l('y'), 0, -4], [l('rot'), 0, 70],
    [r('x'), 3, 20], [r('y'), 3, -20], [r('rot'), 3, 100],
    [l('x'), 3, -15], [l('y'), 3, -2], [l('rot'), 3, -20],
    [r('x'), 6, 12], [r('y'), 6, -14], [r('rot'), 6, 85],
    [rw('rot'), 4, -30],
    [r('x'), 10, 10], [r('y'), 10, -12], [r('rot'), 10, 80],
    [l('x'), 10, -10], [l('rot'), 10, 70],
  ]),
  build('ninjaUsmash', 'Rising Slash', { fps: 60, loop: false, blendIn: 2,
    weapons: { right: { id: 'ninjaSword', mountX: 0, mountY: -2, gripOffsetX: -8, gripOffsetY: 0, gripRot: 0 } },
  }, [
    [r('x'), 0, 15], [r('y'), 0, -4], [r('rot'), 0, 60],
    [l('x'), 0, -12], [l('y'), 0, 4], [l('rot'), 0, 50],
    [r('x'), 3, 25], [r('y'), 3, -18], [r('rot'), 3, 90],
    [l('x'), 3, -18], [l('y'), 3, 2], [l('rot'), 3, -30],
    [r('x'), 6, 30], [r('y'), 6, -30], [r('rot'), 6, 110],
    [rw('rot'), 4, -40],
    [r('x'), 12, 20], [r('y'), 12, -10], [r('rot'), 12, 70],
    [l('x'), 12, -16], [l('rot'), 12, 40],
  ]),
  build('ninjaDtilt', 'Low Sweep', { fps: 60, loop: false, blendIn: 1,
    // Down Light is the Teleport Strike: the animation owns the ability binding
    // (same as ninjaFsmash / ninjaDsmash), so the move is routed to
    // ABILITIES.ninjaDtilt instead of a plain melee box. combat.js
    // (mergeAbilityDef) still merges NINJA_ATTACKS.dtilt underneath, so the
    // strike's damage/knockback/geometry are the attack table's own numbers.
    combat: { type: 'nonHitbox', abilityId: 'ninjaDtilt' },
    weapons: { right: { id: 'ninjaSword', mountX: 0, mountY: -2, gripOffsetX: -8, gripOffsetY: 0, gripRot: 0 } },
    // ABILITY VFX (ninjaDtilt, the Teleport Strike): the blade arc on the strike
    // the warp delivers.
    vfx: [{ effect: 'slash', anchor: 'weapon', startFrame: 2, duration: 5, scale: 0.7, rotation: 0, offsetX: 8, offsetY: 2, loop: false }],
  }, [
    [r('x'), 0, 25], [r('y'), 0, 8], [r('rot'), 0, -10],
    [l('x'), 0, -18], [l('y'), 0, 12], [l('rot'), 0, 10],
    [r('x'), 2, 45], [r('y'), 2, 12], [r('rot'), 2, -30],
    [l('x'), 2, -12], [l('y'), 2, 10], [l('rot'), 2, 15],
    [r('x'), 5, 30], [r('y'), 5, 6], [r('rot'), 5, -15],
    [rw('rot'), 3, 20],
    [r('x'), 8, 25], [r('y'), 8, 8], [r('rot'), 8, -10],
    [l('x'), 8, -18], [l('rot'), 8, 10],
  ]),
  build('ninjaDsmash', 'Shadow Strike', { fps: 60, loop: false, blendIn: 2,
    combat: { type: 'nonHitbox', abilityId: 'ninjaDsmash' },
    weapons: { right: { id: 'ninjaSword', mountX: 0, mountY: -2, gripOffsetX: -8, gripOffsetY: 0, gripRot: 0 } },
    // Shadow Strike's visual is NOT authored here: the ability owns it. The
    // instant dash (its distance, and how much of it the arena edge clipped) and
    // the trail that has to cover it are known only to abilities.js, which fires
    // the shadowDash effect at the cast (playShadowStrikeVFX) — see
    // fx.js. The retired shadowPoof + slash pair used to sit here.
    vfx: [],
  }, [
    [r('x'), 0, 20], [r('y'), 0, -2], [r('rot'), 0, 10],
    [l('x'), 0, -20], [l('y'), 0, 8], [l('rot'), 0, -10],
    [r('x'), 4, 10], [r('y'), 4, 2], [r('rot'), 4, 5],
    [l('x'), 4, -10], [l('y'), 4, 10], [l('rot'), 4, -5],
    [r('x'), 8, 0], [r('y'), 8, 0], [r('rot'), 8, 0],
    [l('x'), 8, 0], [l('y'), 8, 0], [l('rot'), 8, 0],
    [r('x'), 10, 80], [r('y'), 10, -4], [r('rot'), 10, -30],
    [l('x'), 10, -30], [l('y'), 10, 6], [l('rot'), 10, 15],
    [rw('rot'), 10, 40],
    [r('x'), 16, 50], [r('y'), 16, 2], [r('rot'), 16, -10],
    [l('x'), 16, -25], [l('y'), 16, 10],
    [r('x'), 24, 25], [r('y'), 24, 0], [r('rot'), 24, 5],
    [l('x'), 24, -18], [l('rot'), 24, -5],
  ]),
  build('shield', 'Shield / Block', { fps: 60, loop: true, blendIn: 3 }, [
    [r('x'), 0, 6], [r('y'), 0, -8], [r('rot'), 0, 20],
    [l('x'), 0, -6], [l('y'), 0, -6], [l('rot'), 0, -18],
  ]),
  // Hand idle poses: neutral rest positions held as editable single-frame
  // loops, one per leading hand. Weaponless by default so hand gear shows;
  // attach weapons in the animator like any other animation. The runtime
  // mirror still applies, so these read correctly in both facings.
  build('rfidle', 'Right Idle', { fps: 60, loop: true, blendIn: 3 }, [
    [r('x'), 0, 28], [r('y'), 0, -8], [r('rot'), 0, 0],
    [l('x'), 0, -26], [l('y'), 0, 6], [l('rot'), 0, 0],
  ]),
  build('lfidle', 'Left Idle', { fps: 60, loop: true, blendIn: 3 }, [
    [l('x'), 0, 28], [l('y'), 0, -8], [l('rot'), 0, 0],
    [r('x'), 0, -26], [r('y'), 0, 6], [r('rot'), 0, 0],
  ]),
  build('ninjaNsmash', 'Shadow Push', { fps: 60, loop: false, blendIn: 2,
    // The ninja's Neutral Heavy is the one move he does NOT draw his sword for:
    // both hands drive out to opposite sides and shove a wave of shadow energy
    // off each palm. NINJA_ATTACKS.nsmash is `bothSides`, so the box mirrors to
    // the far side too and the symmetric pose is what the player actually sees
    // connect on both edges.
    weapons: { right: null, left: null },
    // No VFX: the Shadow Push is a plain melee Neutral Heavy, not an ability, so
    // it paints nothing. The pose below is the whole read — hands up, coil, snap.
  }, [
    // Guard: hands up and close, palms already turned out.
    [r('x'), 0, 26], [r('y'), 0, -10], [r('rot'), 0, -14],
    [l('x'), 0, -24], [l('y'), 0, 8], [l('rot'), 0, 12],
    // Coil: BOTH hands snap in toward the chest and cross the centerline a
    // little, loading the push. Mirrored values, so the pose stays symmetric.
    [r('x'), 3, 8], [r('y'), 3, -4], [r('rot'), 3, -30], [r('scaleX'), 3, 1.06], [r('scaleY'), 3, 0.94],
    [l('x'), 3, -6], [l('y'), 3, 2], [l('rot'), 3, 28], [l('scaleX'), 3, 1.06], [l('scaleY'), 3, 0.94],
    // SNAP: arms punch out to both sides — a short, sharp reach, not a full
    // stretch. Peak lands on frame 8, the first active frame, and holds there
    // until the window closes while the energy spends itself.
    [r('x'), 7, 48], [r('y'), 7, -10], [r('rot'), 7, 10], [r('scaleX'), 7, 1.12], [r('scaleY'), 7, 0.9],
    [l('x'), 7, -46], [l('y'), 7, 2], [l('rot'), 7, -9], [l('scaleX'), 7, 1.12], [l('scaleY'), 7, 0.9],
    // Hold through the rest of the active window, easing in slightly.
    [r('x'), 12, 44], [r('y'), 12, -9], [r('rot'), 12, 8], [r('scaleX'), 12, 1.06], [r('scaleY'), 12, 0.96],
    [l('x'), 12, -42], [l('y'), 12, 3], [l('rot'), 12, -7], [l('scaleX'), 12, 1.06], [l('scaleY'), 12, 0.96],
    // Follow-through: the arms drift back in but stay wide, overshooting the
    // rest pose before settling.
    [r('x'), 18, 36], [r('y'), 18, -6], [r('rot'), 18, 3], [r('scaleX'), 18, 1],
    [l('x'), 18, -34], [l('y'), 18, 5], [l('rot'), 18, -3], [l('scaleX'), 18, 1],
    [r('x'), 25, 31], [r('y'), 25, -8], [r('rot'), 25, -5],
    [l('x'), 25, -28], [l('y'), 25, 7], [l('rot'), 25, 5],
    // Recovery: back to the shared rest pose (the move is 38 frames long, so the
    // last few frames hold this).
    [r('x'), 32, 28], [r('y'), 32, -8], [r('rot'), 32, 0],
    [l('x'), 32, -26], [l('y'), 32, 6], [l('rot'), 32, 0],
  ]),
  build('ninjaDash', 'Dash Attack', { fps: 60, loop: false, blendIn: 2,
    weapons: { right: { id: 'ninjaSword', mountX: 0, mountY: -2, gripOffsetX: -8, gripOffsetY: 0, gripRot: 0 } },
  }, [
    [r('x'), 0, 10], [r('y'), 0, 12], [r('rot'), 0, 25],
    [l('x'), 0, -26], [l('y'), 0, 6],
    [r('x'), 3, 70], [r('y'), 3, 0], [r('rot'), 3, -10],
    [l('x'), 3, -32], [l('y'), 3, 12],
    [r('x'), 6, 80], [r('y'), 6, -2], [r('rot'), 6, -20],
    [l('x'), 6, -36], [l('y'), 6, 14],
    [r('x'), 10, 40], [r('y'), 10, 6], [r('rot'), 10, 5],
    [l('x'), 10, -28], [l('y'), 10, 8],
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
  // ── Victory dance ───────────────────────────────────────────────────────
  // Played by the WINNER once the match ends (the simulation keeps running, so
  // the arena is live while the camera settles on them). Loops forever.
  //
  // One per character, because the animator draws the weapon declared on the
  // animation and HIDES it when that entry is null (animator.js sampleInto) —
  // so a single shared victory anim would make the winner's gun/sword vanish.
  // Same convention the attack anims already use: cowboy carries the revolver,
  // ninja the sword.
  //
  // 40 frames @ 60fps, with frame 40 equal to frame 0 so the loop is seamless:
  // both arms punch up, sway out and back with a little pumping. The DSL only
  // drives hands/weapons (no root motion), so the "dance" is an upper-body one.
  build('cowboyVictory', 'Victory Dance', { fps: 60, loop: true, blendIn: 4,
    weapons: { right: { id: 'revolver', mountX: 0, mountY: -2, gripOffsetX: -10, gripOffsetY: 0, gripRot: 0 } },
  }, [
    // Arms thrown straight up.
    [r('x'), 0, 28], [r('y'), 0, -30], [r('rot'), 0, -18],
    [l('x'), 0, -26], [l('y'), 0, -22], [l('rot'), 0, 18],
    // Sway out to the right, arms punched wide.
    [r('x'), 10, 40], [r('y'), 10, -24], [r('rot'), 10, -32],
    [l('x'), 10, -34], [l('y'), 10, -16], [l('rot'), 10, 32],
    // Back through centre, reaching higher.
    [r('x'), 20, 26], [r('y'), 20, -34], [r('rot'), 20, -6],
    [l('x'), 20, -24], [l('y'), 20, -26], [l('rot'), 20, 6],
    // Sway out to the left.
    [r('x'), 30, 18], [r('y'), 30, -26], [r('rot'), 30, 16],
    [l('x'), 30, -16], [l('y'), 30, -18], [l('rot'), 30, -16],
    // Loop point - identical to frame 0.
    [r('x'), 40, 28], [r('y'), 40, -30], [r('rot'), 40, -18],
    [l('x'), 40, -26], [l('y'), 40, -22], [l('rot'), 40, 18],
  ]),
  build('ninjaVictory', 'Victory Dance', { fps: 60, loop: true, blendIn: 4,
    weapons: { right: { id: 'ninjaSword', mountX: 0, mountY: -2, gripOffsetX: -8, gripOffsetY: 0, gripRot: 0 } },
  }, [
    [r('x'), 0, 28], [r('y'), 0, -30], [r('rot'), 0, -18],
    [l('x'), 0, -26], [l('y'), 0, -22], [l('rot'), 0, 18],
    [r('x'), 10, 40], [r('y'), 10, -24], [r('rot'), 10, -32],
    [l('x'), 10, -34], [l('y'), 10, -16], [l('rot'), 10, 32],
    [r('x'), 20, 26], [r('y'), 20, -34], [r('rot'), 20, -6],
    [l('x'), 20, -24], [l('y'), 20, -26], [l('rot'), 20, 6],
    [r('x'), 30, 18], [r('y'), 30, -26], [r('rot'), 30, 16],
    [l('x'), 30, -16], [l('y'), 30, -18], [l('rot'), 30, -16],
    [r('x'), 40, 28], [r('y'), 40, -30], [r('rot'), 40, -18],
    [l('x'), 40, -26], [l('y'), 40, -22], [l('rot'), 40, 18],
  ]),
];

// ── Boxer animations ────────────────────────────────────────────────────
// The boxer owns no weapon, so rather than hand-authoring a third full set of
// punch keyframes, each move is DERIVED from the existing pose that already
// reads as that kind of swing — the ninja's upward slashes for the boxer's
// uppercuts, the cowboy's swings for its straights. The poses are real authored
// arcs, not placeholders; only the weapon and VFX are stripped.
//
// Deriving rather than duplicating also means the boxer is automatically bound
// to the VFX RULE at the top of this file: a clone has its `vfx` list emptied, so
// no derived move can inherit an ability's art — and every boxer row in
// BOXER_ATTACKS (combat.js) is a plain melee box with no abilityType anyway.
//
// The source is always the SHIPPED pose (BASE_ANIMATIONS), never the player's
// stored copy of that source — so a profile that re-authored `ninjaUtilt` does
// not silently rewrite the boxer's uppercut. The boxer move is its own
// independent animation from the moment it is created, and is edited as one.
//
// The ids here are exactly the `anim` fields in BOXER_ATTACKS, plus
// 'boxerVictory' (Game.js victoryAnimFor). 'shield' is deliberately NOT cloned:
// it is already weaponless and shared by every character.
const BOXER_ANIM_SOURCES = [
  // id,                   source,        display name
  ['boxerJab',             'jab',          'Jab'],
  ['boxerFtilt',           'ftilt',        'Lead Hook'],
  ['boxerNsmash',          'nsmash',       'Cross'],
  ['boxerFsmash',          'fsmash',       'Straight Right'],
  ['boxerUtilt',           'ninjaUtilt',   'Uppercut'],
  ['boxerUsmash',          'ninjaUsmash',  'Rising Upper'],
  ['boxerDtilt',           'ninjaDtilt',   'Low Hook'],
  ['boxerDsmash',          'ninjaDsmash',  'Overhand Chop'],
  ['boxerAerialLight',     'nair',         'Air Jab'],
  ['boxerAerialHeavy',     'fair',         'Air Uppercut'],
  ['boxerDash',            'dash',         'Shoulder Charge'],
  ['boxerVictory',         'cowboyVictory', 'Victory Dance'],
];

function deriveUnarmed(source, id, name) {
  if (!source) return null;
  const tracks = {};
  // Keyframes are copied too, not shared: the editor mutates a loaded
  // animation's tracks in place, so two entries sharing one keyframe array would
  // make editing the cowboy's jab silently rewrite the boxer's.
  for (const path of Object.keys(source.tracks)) {
    const t = source.tracks[path];
    tracks[path] = { ...t, keyframes: t.keyframes.map((k) => ({ ...k })) };
  }
  return {
    id,
    name,
    fps: source.fps,
    loop: source.loop,
    mirror: source.mirror,
    blendIn: source.blendIn,
    // No weapon on either hand — the animator hides a null weapon, which is
    // exactly what a bare-handed fighter needs.
    weapons: { right: null, left: null },
    combat: null,
    vfx: [],
    tracks,
  };
}

const _baseAnimById = new Map();
for (const a of BASE_ANIMATIONS) _baseAnimById.set(a.id, a);

const _boxerAnims = [];
for (const [id, srcId, name] of BOXER_ANIM_SOURCES) {
  const derived = deriveUnarmed(_baseAnimById.get(srcId), id, name);
  // A missing source means a typo in the table above. Warn rather than throw:
  // the game must still boot on a broken library, just with that one move
  // missing its animation.
  if (!derived) console.warn(`[animlib] boxer move "${id}" has no source animation "${srcId}"`);
  else _boxerAnims.push(derived);
}

// Default timeline VFX for the boxer's cast-timed art (same rule as the
// knight's: combat.js defers to these, the timeline always wins). Straight
// Right reach: cast frame 1, 0.16s life, forward offset + unit — the same
// values the code spawn uses. `ability: true` makes the ability's spawn ADOPT
// the row (combat.js spawnAbilityVfx) instead of shadowing it, so the Hand
// Animator's scale/X/Y are the ones gameplay uses.
for (const a of _boxerAnims) {
  if (a.id === 'boxerFsmash') {
    a.vfx = [{
      effect: 'boxerStraightPunch', anchor: 'character', startFrame: 1, duration: 10,
      scale: 1, rotation: 0, offsetX: 15.6, offsetY: -4, loop: false, ability: true,
      params: { unit: 1.42 },
    }];
  }
}

// ── Knight animations ───────────────────────────────────────────────────
// Bare-handed like the boxer: the exact same deriveUnarmed convention — each
// move clones the shipped base pose that already reads as that kind of swing,
// with no weapon on either hand, so the knight's hands run the identical
// pipeline as every other character. Attack numbers/names live in
// KNIGHT_ATTACKS (unchanged); vfx/combat are stripped like the boxer's (the
// Shield Bash ability binds on the attack TABLE row, which is authoritative).
//
// The ids here are exactly the `anim` fields in KNIGHT_ATTACKS, plus
// 'knightVictory' (Game.js victoryAnimFor needs a weaponless victory anim —
// the shared cowboyVictory carries a gun). Shielding uses the shared
// weaponless 'shield' like everyone else.
const KNIGHT_ANIM_SOURCES = [
  // id,                   source,        display name
  ['knightJab',            'jab',          'Sword Slash'],
  ['knightFtilt',          'ftilt',         'Side Slash'],
  ['knightFsmash',         'fsmash',        'Charged Sword Strike'],
  ['knightUtilt',          'ninjaUtilt',    'Rising Guard'],
  ['knightUsmash',         'ninjaUsmash',   'Skyward Oath'],
  ['knightDtilt',          'jab',           'Shield Bash'],
  ['knightDsmash',         'ninjaNsmash',   'Spinning Sweep'],
  ['knightAerialLight',    'nair',          'Rising Sword Slash'],
  ['knightAerialHeavy',    'fair',          'Falling Sword Strike'],
  ['knightDash',           'dash',          'Oath Lunge'],
  ['knightShield',         'shield',        'Shield Counter'],
  ['knightVictory',        'cowboyVictory', 'Victory Dance'],
];

const _knightAnims = [];
for (const [id, srcId, name] of KNIGHT_ANIM_SOURCES) {
  const derived = deriveUnarmed(_baseAnimById.get(srcId), id, name);
  if (!derived) console.warn(`[animlib] knight move "${id}" has no source animation "${srcId}"`);
  else _knightAnims.push(derived);
}

// ── Pirate animations ──────────────────────────────────────────────────
// Armed, so this is the same DERIVE convention as the boxer/knight above but
// with the saber on the leading hand instead of a bare fist: each move clones
// the shipped base pose that already reads as that kind of swing, then the
// right slot is re-armed with the registered `saber` weapon def (so grip,
// rotation, facing mirroring and rendering all run through the shared weapon
// attachment path — no Pirate-specific weapon drawing).
//
// `vfx`/`combat` are stripped like the other derived sets: every pirate move's
// art belongs to its ability, which binds on the ATTACK TABLE row (the
// authoritative designation — see resolveAnimDef), so a stored animation can
// never strip a signature move back to a plain swing.
//
// The ids here are exactly the `anim` fields in PIRATE_ATTACKS, plus
// 'pirateVictory' (Game.js victoryAnimFor — the shared cowboyVictory carries a
// revolver, which would make the winner's saber vanish).
const PIRATE_ANIM_SOURCES = [
  // id,                 source,          display name
  ['pirateJab',         'jab',            'Cutlass Jab'],
  ['pirateFtilt',       'ftilt',          'Cutlass Lunge'],
  ['pirateFsmash',      'fsmash',         'Cannon Blast'],
  ['pirateNsmash',      'nsmash',         'Broadside Burst'],
  ['pirateUtilt',       'ninjaUtilt',     'Saber Rise'],
  ['pirateUsmash',      'ninjaUsmash',    'Oath Cleave'],
  ['pirateDtilt',       'ninjaDtilt',     'Rope Swing'],
  ['pirateDsmash',      'ninjaDsmash',    'Anchor Drop'],
  ['pirateAerialLight', 'nair',           'Air Slash'],
  ['pirateAerialHeavy', 'fair',           'Down Blast'],
  ['pirateDash',        'dash',           'Saber Dash'],
  ['pirateVictory',     'cowboyVictory',  'Victory Dance'],
];

// Same clone shape as deriveUnarmed, then the saber goes on the leading hand.
// `gripOffsetX` is the saber's small hand-space nudge (the sword family uses
// the same convention); everything else — pivot, anchors, mirroring — comes
// from the registered weapon def.
function deriveArmed(source, id, name, weaponId) {
  const base = deriveUnarmed(source, id, name);
  if (!base) return null;
  base.weapons.right = { ...emptyWeaponCfg(), id: weaponId, mountX: 0, mountY: -2, gripOffsetX: -6, gripOffsetY: 0, gripRot: 0 };
  return base;
}

const _pirateAnims = [];
for (const [id, srcId, name] of PIRATE_ANIM_SOURCES) {
  const derived = deriveArmed(_baseAnimById.get(srcId), id, name, 'saber');
  if (!derived) console.warn(`[animlib] pirate move "${id}" has no source animation "${srcId}"`);
  else _pirateAnims.push(derived);
}
// Cannon Blast shoulders the hand cannon instead of the saber: the pirate
// aims the piece during the windup and the ball leaves its muzzle (the
// projectile spawn reads the weapon's tip anchor, so the round, the muzzle
// star and the trail all originate at the barrel mouth with no extra math).
for (const a of _pirateAnims) {
  if (a.id === 'pirateFsmash') {
    a.weapons.right = { ...emptyWeaponCfg(), id: 'pirateCannon', mountX: 0, mountY: -2, gripOffsetX: -14, gripOffsetY: 0, gripRot: 0 };
  }
  // Down Blast (aerial heavy) shoulders the same hand cannon, rotated to aim
  // down (+90 canvas degrees; the animator mirrors it per facing, and it is
  // tunable per move in the Hand Animator's GRIPROT row).
  if (a.id === 'pirateAerialHeavy') {
    a.weapons.right = { ...emptyWeaponCfg(), id: 'pirateCannon', mountX: 0, mountY: -2, gripOffsetX: -14, gripOffsetY: 0, gripRot: 90 };
  }
}

// Default timeline VFX for the pirate's ability art (same rule as the
// knight's and the boxer's: the rows below are what the Hand Animator shows
// out of the box, and combat.js adopts them — the timeline always wins).
// Each row mirrors the code spawn's values (effect, anchor, cast-frame
// timing, lifetime, scale, rotation, canonical offsets), so an unedited row
// plays exactly the built-in art, and the rows paint in the animator preview
// like any other timeline effect.
//
// `ability: true` marks rows the ability itself drives: at the cast the
// ability's code spawn reads the row and adopts its editable presentation —
// anchor, scale, rotation, canonical offsets, duration-as-lifetime and any
// extra params — over the runtime truth the ability still owns (pinned world
// positions, radius-derived unit, hitbox-derived reach, rope-pivot tracking).
// In-game the live adopted instance shadows the row (fx.js drawFighterVfx
// yields same-effect timeline rows to a live temp instance), so the art can
// never double-draw. Deleting a row is safe: the spawn falls back to these
// same built-ins. Retargeting a row's EFFECT swaps the art in BOTH paths
// (the spawn adopts the row's pick); only ability-specific runtime extras
// stay art-bound — rope-pivot tracking follows pirateRope, so other art on
// the rope row simply ignores the pivot. The exact field-by-field
// preview↔game contract lives on spawnAbilityVfx (combat.js).
const _PIRATE_ABILITY_VFX = {
  // Rope Swing: grapple tether + swing wake, thrown at the cast (frame 8),
  // living the whole ~0.6s swing plus its release tail (40 frames), riding
  // the front hand ahead of the body.
  pirateDtilt: [
    { effect: 'pirateRope', anchor: 'frontHand', startFrame: 8, duration: 40, scale: 1, rotation: 0, offsetX: 14, offsetY: 0, loop: false, ability: true, params: { length: 82 } },
  ],
  // Cutlass Lunge: world-pinned crescent at the lunge start (frame 6),
  // ~0.34s of life (20 frames).
  pirateFtilt: [
    { effect: 'pirateCutlassSlash', anchor: 'character', startFrame: 6, duration: 20, scale: 1, rotation: 0, offsetX: 0, offsetY: 0, loop: false, ability: true },
  ],
  // Anchor Drop: ground eruption at the landing spot (frame 15), 0.5s of life.
  pirateDsmash: [
    { effect: 'pirateAnchorSlam', anchor: 'character', startFrame: 15, duration: 30, scale: 1, rotation: 0, offsetX: 0, offsetY: 0, loop: false, ability: true },
  ],
  // Cannon Blast: muzzle starburst on the cannon (frame 19), 0.2s of life.
  pirateFsmash: [
    { effect: 'pirateCannonMuzzle', anchor: 'character', startFrame: 19, duration: 12, scale: 1, rotation: 0, offsetX: 0, offsetY: 0, loop: false, ability: true },
  ],
  // Down Blast: muzzle starburst below the pirate at the shot (frame 10),
  // 0.2s of life (the code spawn pins it under the body).
  pirateAerialHeavy: [
    { effect: 'pirateCannonMuzzle', anchor: 'character', startFrame: 10, duration: 12, scale: 1, rotation: 0, offsetX: 0, offsetY: 0, loop: false, ability: true },
  ],
};
for (const a of _pirateAnims) {
  const list = _PIRATE_ABILITY_VFX[a.id];
  if (list) a.vfx = list.map((e) => ({ ...(e || {}), params: { ...((e || {}).params || {}) } }));
}

// Default timeline VFX for the knight's attack-start trails (durations in
// frames mirror the code-spawn life: startup + active frames at 60fps). These
// are the SAME instances combat.js would spawn (knightSwingTrail defers to
// them — the timeline always wins), so every trail is visible and tunable in
// the Hand Animator out of the box: effect, anchor, timing, scale, rotation
// and X/Y offsets. The Counter answer's art is target-anchored and stays
// code-driven — it cannot be expressed as an attack-start timeline entry.
const _KNIGHT_TRAIL_VFX = {
  knightJab:         [{ effect: 'knightSlash', anchor: 'weapon', startFrame: 0, duration: 7, scale: 1 }],
  knightFtilt:       [{ effect: 'knightSlash', anchor: 'weapon', startFrame: 0, duration: 10, scale: 1 }],
  knightAerialLight: [{ effect: 'knightSlash', anchor: 'weapon', startFrame: 0, duration: 10, scale: 1 }],
  knightAerialHeavy: [{ effect: 'knightSlash', anchor: 'weapon', startFrame: 0, duration: 18, scale: 1 }],
  knightDsmash:      [{ effect: 'knightSweep', anchor: 'weapon', startFrame: 0, duration: 18, scale: 0.5 }],
  knightFsmash:      [{ effect: 'knightBlueSlash', anchor: 'weapon', startFrame: 0, duration: 19, scale: 1.15 }],
  knightDash: [
    { effect: 'knightCircleBurst', anchor: 'character', startFrame: 0, duration: 19, scale: 1 },
  ],
}; // Durations fit inside each source animation's frame count so every seeded
// entry completes before the pose freezes (jab 9, ftilt 14, nair 10, fair 28,
// ninjaNsmash 32, fsmash 32, dash 19).
for (const a of _knightAnims) {
  const list = _KNIGHT_TRAIL_VFX[a.id];
  if (list) a.vfx = list.map((e) => ({ rotation: 0, offsetX: 0, offsetY: 0, loop: false, ...e }));
}

// Default timeline VFX for the knight's Shield Bash (Down Light) — cast-timed
// impact art anchored to the knight, so it IS expressible as an ability row.
// Same `ability: true` contract as the pirate rows: the ability's code spawn
// adopts these field by field (combat.js spawnAbilityVfx), so the Hand Animator
// lane owns the art's effect, anchor, timing, scale, rotation and X/Y in
// gameplay. `knightBash` is the shield burst; `knightSpeedLines` is the push's
// trail. startFrame 2 is the ability's castFrame; offsetX 34.1 is the code
// spawn's radius-derived dir * r * 1.1 (r 31) authored canonically.
const _KNIGHT_ABILITY_VFX = {
  knightDtilt: [
    { effect: 'knightBash', anchor: 'character', startFrame: 2, duration: 27, scale: 1, rotation: 0, offsetX: 34.1, offsetY: -4, loop: false, ability: true },
    { effect: 'knightSpeedLines', anchor: 'character', startFrame: 2, duration: 9, scale: 1, rotation: 0, offsetX: 0, offsetY: 0, loop: false, ability: true },
  ],
};
for (const a of _knightAnims) {
  const list = _KNIGHT_ABILITY_VFX[a.id];
  if (list) a.vfx = list.map((e) => ({ ...(e || {}) }));
}

export const DEFAULT_ANIMATIONS = [...BASE_ANIMATIONS, ..._boxerAnims, ..._knightAnims, ..._pirateAnims];

let animLib = new Map();

// Playback-side cache invalidation. Gameplay animation playback keeps a
// read-only clone per id so attacks don't deep-clone a whole animation on
// every start; the library can only change while the editor is open, so we
// notify a listener whenever any mutation happens and the caller clears it.
let _libChange = null;
export function setAnimLibChangeListener(fn) { _libChange = fn; }
// Monotonic library revision: renderers that cache library-derived data (the
// idle-pose defaults in Effects.js) poll this per frame — one integer compare
// — instead of competing for the single change-listener slot above.
let _libRev = 0;
export function animLibRev() { return _libRev; }
function notifyLibChanged() {
  _libRev++;
  if (_libChange) _libChange();
}

export function loadDefaultLibrary() {
  animLib = new Map();
  for (const a of DEFAULT_ANIMATIONS) animLib.set(a.id, cloneAnimation(a));
  notifyLibChanged();
};

// ── Shadow Strike VFX migration ────────────────────────────────────────────
// Shadow Strike's visual moved OFF the animation (the curated shadowPoof+slash
// pair that used to sit in ninjaDsmash.vfx) and ONTO the ability, which fires the
// shadowDash effect from abilities.js (playShadowStrikeVFX) so the trail always
// covers the dash the ability actually performs. A store written before that
// change would keep painting the retired pair on top of the new dash, so drop
// those two entries once. The marker is deliberate: a LATER animator edit to
// ninjaDsmash.vfx is left alone, only the pre-migration pair is retired.
const SHADOW_STRIKE_VFX_MIGRATION_KEY = 'smashfighters.animlib.shadowStrikeVfx';
const RETIRED_SHADOW_STRIKE_VFX = new Set(['shadowPoof', 'slash']);

function migrateShadowStrikeVfx() {
  if (typeof localStorage === 'undefined') return;
  try {
    if (localStorage.getItem(SHADOW_STRIKE_VFX_MIGRATION_KEY)) return;
  } catch (_) { return; }
  const stored = animLib.get('ninjaDsmash');
  if (stored && Array.isArray(stored.vfx)) {
    const kept = stored.vfx.filter(v => !(v && RETIRED_SHADOW_STRIKE_VFX.has(v.effect)));
    if (kept.length !== stored.vfx.length) {
      stored.vfx = kept;
      persistAnimLib();
    }
  }
  try { localStorage.setItem(SHADOW_STRIKE_VFX_MIGRATION_KEY, '1'); } catch (_) {}
}

// ── Teleport Strike ability-binding migration ─────────────────────────────
// ninjaDtilt BECAME the Teleport Strike: the move only warps because the
// animation routes to ABILITIES.ninjaDtilt (combat.type nonHitbox +
// abilityId). That binding lives on the animation, and a saved store REPLACES a
// built-in animation wholesale (see the load loop below) — so any browser where
// the animator ever saved anything is running a stored ninjaDtilt captured
// BEFORE the binding existed. It loads fine, animates fine, and Down Light is
// just a plain sweep: the ability never runs and the move silently "does not
// activate". Re-attach the binding in place, once, keeping every animator edit
// in that stored copy (keyframes, weapons, vfx) exactly as the user left it —
// only the gameplay routing is repaired.
const TELEPORT_STRIKE_MIGRATION_KEY = 'smashfighters.animlib.teleportStrike';
const NINJA_DTILT_COMBAT = { type: 'nonHitbox', abilityId: 'ninjaDtilt' };

function migrateTeleportStrike() {
  if (typeof localStorage === 'undefined') return;
  try {
    if (localStorage.getItem(TELEPORT_STRIKE_MIGRATION_KEY)) return;
  } catch (_) { return; }
  const stored = animLib.get('ninjaDtilt');
  if (stored) {
    const c = stored.combat;
    const bound = c && c.type === 'nonHitbox' && c.abilityId === 'ninjaDtilt';
    if (!bound) {
      // Preserve any other combat fields the user (or a future change) set, and
      // only overwrite the routing.
      stored.combat = { ...(c || {}), ...NINJA_DTILT_COMBAT };
      persistAnimLib();
    }
  }
  try { localStorage.setItem(TELEPORT_STRIKE_MIGRATION_KEY, '1'); } catch (_) {}
}

// ── Ability-only VFX migration ────────────────────────────────────────────
// VFX belongs to abilities alone: an animation paints only when it is bound
// to an ability (combat.type 'nonHitbox' + combat.abilityId), which is the same
// test DEFAULT_ANIMATIONS above is written to. A browser whose animator had
// already saved would otherwise keep replaying the RETIRED general melee art
// (bullet, spray, blast, slash, shadowPoof/shadowBlast and the retired
// movement/recovery dust) on top of the new rule forever, so drop exactly
// those entries from every non-ability animation, once.
//
// Deliberately a denylist, not a wipe: animator-authored entries (knight
// trails included) must survive the load, or timeline VFX editing could never
// stick on plain attacks.
//
// Runs AFTER migrateTeleportStrike() on purpose: a stored ninjaDtilt that still
// needed its ability binding re-attached would otherwise be treated as unbound
// and have its (legitimate) Teleport Strike slash wiped instead of repaired.
const ABILITY_ONLY_VFX_MIGRATION_KEY = 'smashfighters.animlib.abilityOnlyVfx';
const RETIRED_GENERAL_VFX = new Set([
  'bullet', 'spray', 'blast', 'slash', 'shadowPoof', 'shadowBlast',
  'jumpVfx', 'landingVfx', 'hardLandingVfx', 'fastFallVfx', 'directionChangeVfx',
  'recoveryVfx', 'recoveryTrailVfx', 'aerialLightRecoveryVfx',
]);

function migrateAbilityOnlyVfx() {
  if (typeof localStorage === 'undefined') return;
  try {
    if (localStorage.getItem(ABILITY_ONLY_VFX_MIGRATION_KEY)) return;
  } catch (_) { return; }
  let changed = false;
  for (const a of animLib.values()) {
    if (!a || !Array.isArray(a.vfx) || a.vfx.length === 0) continue;
    const c = a.combat;
    if (c && c.type === 'nonHitbox' && c.abilityId) continue;   // ability: keep
    const kept = a.vfx.filter((v) => !(v && RETIRED_GENERAL_VFX.has(v.effect)));
    if (kept.length !== a.vfx.length) { a.vfx = kept; changed = true; }
  }
  if (changed) persistAnimLib();
  try { localStorage.setItem(ABILITY_ONLY_VFX_MIGRATION_KEY, '1'); } catch (_) {}
}

// ── Retired dash-trail cleanup ────────────────────────────────────────────
// The Oath Lunge trail effect was removed (replaced by Shield Bash speed
// lines): drop its entries from every stored animation so a deleted effect id
// can never resolve to the fallback orb. Runs once, BEFORE the top-up below
// (a stripped-then-emptied knight entry is refilled with current defaults).
const RETIRE_DASH_TRAIL_KEY = 'smashfighters.animlib.retireDashTrail.v1';

function migrateRetireDashTrail() {
  if (typeof localStorage === 'undefined') return;
  try {
    if (localStorage.getItem(RETIRE_DASH_TRAIL_KEY)) return;
  } catch (_) { return; }
  let changed = false;
  for (const a of animLib.values()) {
    if (!a || !Array.isArray(a.vfx) || !a.vfx.length) continue;
    const kept = a.vfx.filter((v) => !(v && v.effect === 'knightDashTrail'));
    if (kept.length !== a.vfx.length) { a.vfx = kept; changed = true; }
  }
  if (changed) persistAnimLib();
  try { localStorage.setItem(RETIRE_DASH_TRAIL_KEY, '1'); } catch (_) {}
}

// ── Knight/boxer timeline top-up ──────────────────────────────────────────
// Stored animations replace built-ins wholesale, so a knightDsmash (or
// boxerFsmash) saved before its trail entries were seeded keeps shadowing the
// default with an empty vfx list — the timeline shows nothing while the code
// fallback still paints. Top up stored entries that carry NO vfx at all with
// the current defaults (tracks and everything else untouched). Entries the
// user customized are left alone; and resurrecting a deleted trail entry is
// harmless, because with no entry the code fallback paints the same art
// anyway. Scoped to the deferral-paired moves only — elsewhere an emptied
// list is meaningful (no fallback exists to cover it).
const KNIGHT_VFX_TOPUP_KEY = 'smashfighters.animlib.knightVfxTopUp.v1';

function migrateKnightVfxTopUp() {
  if (typeof localStorage === 'undefined') return;
  try {
    if (localStorage.getItem(KNIGHT_VFX_TOPUP_KEY)) return;
  } catch (_) { return; }
  let changed = false;
  for (const a of animLib.values()) {
    if (!a || typeof a.id !== 'string') continue;
    const paired = a.id.startsWith('knight') || a.id === 'boxerFsmash';
    if (!paired) continue;
    if (Array.isArray(a.vfx) && a.vfx.length) continue;
    let def = null;
    for (const d of DEFAULT_ANIMATIONS) {
      if (d && d.id === a.id) { def = d; break; }
    }
    if (def && Array.isArray(def.vfx) && def.vfx.length) {
      a.vfx = def.vfx.map((e) => ({ ...(e || {}) }));
      changed = true;
    }
  }
  if (changed) persistAnimLib();
  try { localStorage.setItem(KNIGHT_VFX_TOPUP_KEY, '1'); } catch (_) {}
}

// ── Pirate ability-VFX top-up ───────────────────────────────────────────
// Same rule as the knight/boxer top-up above, for the pirate's ability rows
// (_PIRATE_ABILITY_VFX): stored animations replace built-ins wholesale, so a
// pirateDtilt / pirateFtilt / pirateDsmash / pirateFsmash / pirateAerialHeavy
// saved before those rows were seeded keeps shadowing the default with an
// empty vfx list — the animator shows nothing editable. Top up stored entries that carry NO vfx
// at all with the current defaults (tracks and everything else untouched).
// Entries the user customized are left alone; and resurrecting a deleted row
// is harmless, because with no row the ability spawn falls back to the same
// built-in values anyway.
//
// v2: the Rope Swing got 2.5x slower, so its row's duration went 18 → 40. A
// stored rope row matching the v1 seed EXACTLY was never touched by the user
// (any edit breaks the match), so refresh just that fingerprint to the new
// timing; anything customized keeps the user's numbers.
// v3: the aerial heavy became the Down Blast, so its row is seeded too. The
// re-run is safe (same rules: only empty vfx lists are topped up).
const PIRATE_VFX_TOPUP_KEY = 'smashfighters.animlib.pirateVfxTopUp.v3';
const _PIRATE_TOPUP_IDS = new Set(['pirateDtilt', 'pirateFtilt', 'pirateDsmash', 'pirateFsmash', 'pirateAerialHeavy']);
// The v1 rope seed, field for field. Only an exact match refreshes — a row
// the user edited anywhere (timing, scale, offsets, anchor, effect) stays.
const _PIRATE_ROPE_SEED_V1 = {
  effect: 'pirateRope', anchor: 'frontHand', startFrame: 8, duration: 18,
  scale: 1, rotation: 0, offsetX: 14, offsetY: 0, loop: false, ability: true,
};
function pirateRowMatches(r, s) {
  if (!r || !s) return false;
  for (const k of ['effect', 'anchor', 'startFrame', 'duration', 'scale', 'rotation', 'offsetX', 'offsetY', 'loop', 'ability']) {
    if ((r[k] ?? null) !== (s[k] ?? null)) return false;
  }
  const rp = r.params || {}, sp = s.params || {};
  const keys = new Set([...Object.keys(rp), ...Object.keys(sp)]);
  for (const k of keys) if (rp[k] !== sp[k]) return false;
  return true;
}

function migratePirateVfxTopUp() {
  if (typeof localStorage === 'undefined') return;
  try {
    if (localStorage.getItem(PIRATE_VFX_TOPUP_KEY)) return;
  } catch (_) { return; }
  let changed = false;
  const seedOf = (id) => {
    for (const d of DEFAULT_ANIMATIONS) {
      if (d && d.id === id) return d;
    }
    return null;
  };
  for (const a of animLib.values()) {
    if (!a || typeof a.id !== 'string') continue;
    if (!_PIRATE_TOPUP_IDS.has(a.id)) continue;
    const def = seedOf(a.id);
    if (!def || !Array.isArray(def.vfx) || !def.vfx.length) continue;
    if (!Array.isArray(a.vfx) || !a.vfx.length) {
      a.vfx = def.vfx.map((e) => ({ ...(e || {}), params: { ...((e || {}).params || {}) } }));
      changed = true;
    } else if (a.id === 'pirateDtilt' && a.vfx.length === 1 &&
        pirateRowMatches(a.vfx[0], { ..._PIRATE_ROPE_SEED_V1, params: { length: 82 } })) {
      // Untouched v1 rope row: refresh to the current (slower-swing) timing.
      a.vfx = def.vfx.map((e) => ({ ...(e || {}), params: { ...((e || {}).params || {}) } }));
      changed = true;
    }
  }
  if (changed) persistAnimLib();
  try { localStorage.setItem(PIRATE_VFX_TOPUP_KEY, '1'); } catch (_) {}
}

// ── Ability-VFX adoption migration ────────────────────────────────────────
// Rows gameplay now ADOPTS (the boxer's Straight Right reach and the knight's
// Shield Bash bash + speed lines) were seeded as plain timeline rows, or not
// seeded at all. A stored animation still carrying the old shape would keep a
// row the code spawn shadows (Straight Right) or show no row for the bash at
// all, so the Hand Animator's numbers would not match gameplay. Add the
// `ability` flag and the missing rows on stored entries, once. Custom values
// are preserved — only the flag and the two bash rows are touched.
const ABILITY_VFX_ADOPTION_KEY = 'smashfighters.animlib.abilityVfxAdoption.v1';

// The pre-adoption Shield Bash speed-lines seed: startFrame 0, no flag. Only a
// row still exactly matching it is moved to the real cast frame (2); a value
// the user changed is left where they put it.
function _isLegacyKnightSpeedLines(v) {
  return !!v && v.effect === 'knightSpeedLines' && v.anchor === 'character'
    && (v.startFrame == null || v.startFrame === 0) && v.ability !== true;
}

function migrateAbilityVfxAdoption() {
  if (typeof localStorage === 'undefined') return;
  try {
    if (localStorage.getItem(ABILITY_VFX_ADOPTION_KEY)) return;
  } catch (_) { return; }
  let changed = false;

  const boxer = animLib.get('boxerFsmash');
  if (boxer && Array.isArray(boxer.vfx)) {
    for (const v of boxer.vfx) {
      if (v && v.effect === 'boxerStraightPunch' && v.ability !== true) {
        v.ability = true;
        changed = true;
      }
    }
  }

  const kd = animLib.get('knightDtilt');
  if (kd) {
    if (!Array.isArray(kd.vfx)) kd.vfx = [];
    for (const v of kd.vfx) {
      if (_isLegacyKnightSpeedLines(v)) {
        v.startFrame = 2;
        if (v.offsetX == null) v.offsetX = 0;
        if (v.offsetY == null) v.offsetY = 0;
        v.ability = true;
        changed = true;
      } else if (v && v.effect === 'knightSpeedLines' && v.ability !== true) {
        v.ability = true;
        changed = true;
      }
    }
    for (const d of _KNIGHT_ABILITY_VFX.knightDtilt) {
      if (!kd.vfx.some((v) => v && v.effect === d.effect)) {
        kd.vfx.push({ ...d });
        changed = true;
      }
    }
  }

  if (changed) persistAnimLib();
  try { localStorage.setItem(ABILITY_VFX_ADOPTION_KEY, '1'); } catch (_) {}
}

// ── Sprite-only catalogue migration ───────────────────────────────────────
// The catalogue is PNG-only now: drop every stored custom weapon without a
// PNG sprite (they would otherwise keep resolving through the store merge),
// and restore any missing built-in. Runs once.
const SPRITE_ONLY_MIGRATION_KEY = 'smashfighters.weapons.spriteOnly.v1';
const _isPngSprite = (w) => !!w && typeof w.sprite === 'string' && w.sprite.toLowerCase().endsWith('.png');

function migrateSpriteOnlyWeapons() {
  if (typeof localStorage === 'undefined') return;
  try {
    if (localStorage.getItem(SPRITE_ONLY_MIGRATION_KEY)) return;
  } catch (_) { return; }
  try {
    const raw = localStorage.getItem(WEAPON_STORE_KEY);
    if (raw) {
      const list = JSON.parse(raw);
      if (Array.isArray(list)) {
        const kept = list.filter((w) => w && _isPngSprite(w));
        if (kept.length !== list.length) {
          localStorage.setItem(WEAPON_STORE_KEY, JSON.stringify(kept));
        }
      }
    }
  } catch (_) {}
  let purged = false;
  for (const [id, w] of [...weaponLib]) {
    if (!_isPngSprite(w)) { weaponLib.delete(id); purged = true; }
  }
  for (const d of DEFAULT_WEAPONS) {
    if (!weaponLib.has(d.id)) { weaponLib.set(d.id, d); purged = true; }
  }
  if (purged) invalidateWeaponCache();
  try { localStorage.setItem(SPRITE_ONLY_MIGRATION_KEY, '1'); } catch (_) {}
}

// ── Bare-knight rebuild migration ─────────────────────────────────────────
// The knight was rebuilt bare-handed (boxer-style): the knightshield weapon
// def is deleted and every knight animation derives unarmed. But a saved
// store REPLACES a built-in animation wholesale (see the load loop below), so
// any browser where the animator ever saved may still run stored knight
// copies carrying the old arms. Strip weapons off every stored knight*
// animation in place (tracks/vfx/combat untouched) and drop the retired
// shield def, once. (The knight sword is a normal catalogue entry and is
// left alone.)
const BARE_KNIGHT_MIGRATION_KEY = 'smashfighters.animlib.bareKnight.v1';

function migrateBareKnight() {
  if (typeof localStorage === 'undefined') return;
  try {
    if (localStorage.getItem(BARE_KNIGHT_MIGRATION_KEY)) return;
  } catch (_) { return; }
  let changed = false;
  for (const a of animLib.values()) {
    if (!a || typeof a.id !== 'string' || !a.id.startsWith('knight')) continue;
    const w = a.weapons;
    if (w && (w.right || w.left)) {
      a.weapons = { right: null, left: null };
      changed = true;
    }
  }
  if (changed) persistAnimLib();
  try {
    const raw = localStorage.getItem(WEAPON_STORE_KEY);
    if (raw) {
      const list = JSON.parse(raw);
      if (Array.isArray(list)) {
        const kept = list.filter((w) => w && w.id !== 'knightshield');
        if (kept.length !== list.length) {
          localStorage.setItem(WEAPON_STORE_KEY, JSON.stringify(kept));
          weaponLib.delete('knightshield');
          invalidateWeaponCache();
        }
      }
    }
  } catch (_) {}
  try { localStorage.setItem(BARE_KNIGHT_MIGRATION_KEY, '1'); } catch (_) {}
}

// Load user-saved library over the defaults.
try {
  if (typeof localStorage !== 'undefined') {
    const raw = localStorage.getItem(ANIM_STORE_KEY);
    if (raw) {
      const saved = JSON.parse(raw);
      loadDefaultLibrary();
      for (const a of saved) if (a && a.id) animLib.set(a.id, a);
      migrateShadowStrikeVfx();
      migrateTeleportStrike();
      migrateAbilityOnlyVfx();
      migrateBareKnight();
      migrateRetireDashTrail();
      migrateKnightVfxTopUp();
      migratePirateVfxTopUp();
      migrateAbilityVfxAdoption();
      migrateSpriteOnlyWeapons();
    }
  }
} catch (err) { /* corrupt store — fall back to defaults */ }

if (animLib.size === 0) loadDefaultLibrary();
// Runs unconditionally (not just with a stored library): the retired weapon
// defs must be purged from the stored weapon library even on browsers that
// never saved an animation — a stored rig override could still reference them.
migrateBareKnight();
migrateRetireDashTrail();
migrateKnightVfxTopUp();
migrateSpriteOnlyWeapons();

function persistAnimLib() {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(ANIM_STORE_KEY, JSON.stringify([...animLib.values()]));
  } catch (err) { /* ignore */ }
}

export function listAnimations() {
  return [...animLib.values()].map(a => ({ id: a.id, name: a.name, loop: !!a.loop }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// Get animation IDs that are used by a specific character's attack table
export function getAnimationsForCharacter(characterId) {
  // This function needs to be called from combat.js or the editor
  // The mapping is maintained in combat.js via attacksFor()
  // We'll use a simple heuristic: Cowboy uses revolver/rifle, Ninja uses ninjaSword/shuriken
  // But the proper way is to look at what animations the character's attacks reference
  
  // For now, return all - the editor will do the filtering using the character's attack table
  return [...animLib.values()].map(a => a.id);
}

// Proper function to get character-specific animations by checking which
// animations are referenced by the character's attack table
export function getCharacterAnimationIds(characterId, attacksForFn) {
  if (!attacksForFn) return [...animLib.values()].map(a => a.id);
  const attacks = attacksForFn({ _fighterDef: { id: characterId } });
  if (!attacks) return [...animLib.values()].map(a => a.id);

  const animIds = new Set();
  for (const attack of Object.values(attacks)) {
    if (attack && attack.anim) {
      animIds.add(attack.anim);
    }
  }
  // Plus the character's own named animations the tables never reference:
  // guard/shield and victory poses (knightShield, knightVictory, and the
  // cowboy/ninja/boxer equivalents) — matched by id prefix so future
  // characters are covered without another per-character list. Shared
  // non-combat poses (guard, dash, hand idles) are listed for everyone.
  if (characterId) {
    for (const a of animLib.values()) {
      if (a && typeof a.id === 'string' && a.id.startsWith(characterId)) animIds.add(a.id);
    }
  }
  for (const sharedId of ['shield', 'dash', 'lfidle', 'rfidle']) {
    if (animLib.has(sharedId)) animIds.add(sharedId);
  }
  return [...animIds];
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
  persistAnimLib();
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
  persistAnimLib();
  notifyLibChanged();
}

export function renameAnimation(id, name) {
  const a = animLib.get(id);
  if (!a) return;
  a.name = name;
  persistAnimLib();
  notifyLibChanged();
}

export function duplicateAnimationInLibrary(id, newId) {
  const src = animLib.get(id);
  if (!src) return null;
  const copy = cloneAnimation(src);
  copy.id = newId || `${id}-copy-${Date.now()}`;
  copy.name = `${src.name} Copy`;
  animLib.set(copy.id, copy);
  persistAnimLib();
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
  persistAnimLib();
  notifyLibChanged();
  return added;
}

export function resetLibraryToDefaults() {
  loadDefaultLibrary();
  persistAnimLib();
}


// ── merged from anim/animator.js ──
// animator.js — runtime layer. Gameplay only calls playAnimation(name) /
// requestAnimation(); the animator owns numbering frames, blending, facing
// mirroring and the hand→grip→weapon transform chain. Output is written to
// fighter.anim.out as fully-resolved world-space drawables — the renderer just
// draws them, so nothing in Effects knows about tracks or mirroring.
//
// OUT STRUCTURE (world space, per object):
//   { side, px, py, rot, scaleX, scaleY, width, height, opacity, visible,
//     flipX, flipY, z, type: 'hand'|'weapon', def?: weaponDef }


const DEG_TO_RAD = Math.PI / 180;

// Reusable scratch vectors — resolveWeapon rotates several offsets every
// animated frame; writing into these avoids per-weapon-per-frame garbage.
const _v1 = { x: 0, y: 0 };
const _v2 = { x: 0, y: 0 };

function rot(vx, vy, a, out) {
  const c = Math.cos(a), s = Math.sin(a);
  out.x = vx * c - vy * s;
  out.y = vx * s + vy * c;
  return out;
}

export function createAnimator(fighter) {
  return {
    frame: 0,          // current float frame
    maxFrame: 0,
    playing: false,
    paused: false,
    speed: 1,
    loop: true,
    fps: 60,
    animId: null,      // current animation id
    anim: null,        // working copy of the animation
    blendFrom: null,   // per-object flat snapshot for crossfades
    blendProgress: 1,  // 0..1
    blendIn: 0,        // frames the current/next blend spans (set on entry)
    _flat: buildDefaultFlat(), // last sampled flat pose (crossfade source)
    scrubbing: false,  // editor scrub → no blending
    out: buildDefaultOut(fighter),
  };
}

// Total default-pose output when there is no animation.
function buildDefaultOut(fighter) {
  const cx = fighter.x, cy = fighter.y;
  const m = fighter.facingRight ? 1 : -1;
  const flat = buildDefaultFlat();
  return {
    hands: {
      left: resolveHand(cx, cy, flat.hands.left, m),
      right: resolveHand(cx, cy, flat.hands.right, m),
    },
    weapons: { left: null, right: null },
  };
}

// Default FLAT per-prop pose (editor-space values, same shape sampleInto
// blends). This is the snapshot space for crossfades: the world-space `out`
// objects carry resolved px/py, but sampleInto interpolates the local x/y/rot
// properties, so the blend source must live in that same flat space.
function buildDefaultFlat() {
  return {
    hands: {
      left:  { ...DEFAULT_VALUES, ...DEFAULT_POSE.hands.left },
      right: { ...DEFAULT_VALUES, ...DEFAULT_POSE.hands.right },
    },
    weapons: { left: null, right: null },
  };
}

function resolveHand(cx, cy, f, m, hand) {
  if (!hand) hand = {};
  hand.type = 'hand';
  hand.side = 'hand';
  hand.px = cx + f.x * m;
  hand.py = cy + f.y;
  hand.rot = m < 0 ? -f.rot : f.rot;
  hand.scaleX = f.scaleX * (f.flipX ? -1 : 1) * m;
  hand.scaleY = f.scaleY * (f.flipY ? -1 : 1);
  hand.width = f.width; hand.height = f.height;
  hand.opacity = f.opacity; hand.visible = f.visible;
  hand.flipX = f.flipX; hand.flipY = f.flipY; hand.z = f.z;
  return hand;
}

function anchorWorldFor(weapon) {
  if (!weapon.anchorWorld) weapon.anchorWorld = { grip: {}, mount: {} };
  return weapon.anchorWorld;
}

// Hand mount → kitchen pivot → sprite-center chain. cfg is the weapon
// assignment, def the library weapon. `wm` already decides whether this weapon
// mirrors with the fighter. `weapon` is the pooled out object, mutated in place.
function resolveWeapon(fighter, side, handOut, flat, cfg, def, mEff, weapon) {
  if (!cfg || !def) return null;
  const cx = fighter.x, cy = fighter.y;

  // 1. Hand mount point (attachment anchor on the hand). The mount offset is
  //    authored in the hand's own frame, which mirrors with the fighter, so its
  //    x takes the mirror sign before being rotated by the mirrored hand angle.
  const hA = handOut.rot * DEG_TO_RAD;
  const mv = rot(mEff * cfg.mountX, cfg.mountY, hA, _v1);
  const aw = anchorWorldFor(weapon);
  const mount = aw.mount;
  mount.x = handOut.px + mv.x;
  mount.y = handOut.py + mv.y;

  // 2. Grip offset (hand-relative), still in hand frame — mirrors like mount.
  const gv = rot(mEff * cfg.gripOffsetX, cfg.gripOffsetY, hA, _v2);
  const grip = aw.grip;
  grip.x = mount.x + gv.x;
  grip.y = mount.y + gv.y;

  // 3. Total rotation. handOut.rot is already mirrored by resolveHand, so only
  //    the unmirrored contributions (the weapon's own local rot + grip rot)
  //    take the mirror sign — negating the whole sum would double-negate the
  //    hand and spin the weapon the wrong way.
  const theta = handOut.rot + mEff * (flat.rot + cfg.gripRot);

  // 4. Sprite center sits at (localOffset - pivot) from the rotation pivot,
  //    which we pin to the grip. The authoring frame mirrors with the fighter:
  //    x flips, the rotation axis flips → rotate by the (already mirrored) θ.
  const pivot = def.pivot || def.anchors.grip || { x: 0, y: 0 };
  const off = rot(mEff * (flat.x - pivot.x), flat.y - pivot.y, theta * DEG_TO_RAD, _v1);
  const px = grip.x + off.x;
  const py = grip.y + off.y;

  weapon.type = 'weapon';
  weapon.side = side;
  weapon.def = def;
  weapon.cfg = cfg;
  weapon.px = px;
  weapon.py = py;
  weapon.rot = theta;
  weapon.scaleX = flat.scaleX * (flat.flipX ? -1 : 1) * mEff;
  weapon.scaleY = flat.scaleY * (flat.flipY ? -1 : 1);
  weapon.width = flat.width || def.w;
  weapon.height = flat.height || def.h;
  weapon.opacity = flat.opacity;
  weapon.visible = flat.visible;
  weapon.flipX = flat.flipX;
  weapon.flipY = flat.flipY;
  weapon.z = flat.z;

  // ─ Per-definition visual tweaks (weapons.js) ─
  // Applied AFTER the hand chain so they behave like a sprite re-scale / extra
  // spin / nudge on top of whatever the animator sampled. They belong to the
  // weapon sprite, so the mirrorable ones take the mirror sign too.
  if (def.rotation) weapon.rot = theta + mEff * def.rotation;
  if (def.scale !== 1) {
    weapon.scaleX *= def.scale;
    weapon.scaleY *= def.scale;
  }
  if (def.offsetX || def.offsetY) {
    const ov = rot(mEff * def.offsetX, def.offsetY, weapon.rot * DEG_TO_RAD, _v2);
    weapon.px += ov.x;
    weapon.py += ov.y;
  }
  return weapon;
}

// Shared scratch buffers for flattenObject — sampleInto rebuilds them up to
// four times per frame per fighter; reusing them avoids per-frame garbage.
const _flatHand = {};
const _flatWeapon = {};

// Copy a sampled flat pose into a pooled target (same TRANSFORM_PROPS keys
// flattenObject writes). Replaces the per-side-per-frame `{ ...fh }` spreads.
function copyFlat(dst, src) {
  dst.x = src.x; dst.y = src.y; dst.rot = src.rot;
  dst.scaleX = src.scaleX; dst.scaleY = src.scaleY;
  dst.width = src.width; dst.height = src.height;
  dst.opacity = src.opacity; dst.visible = src.visible;
  dst.flipX = src.flipX; dst.flipY = src.flipY; dst.z = src.z;
  return dst;
}

function flattenObject(anim, side, group, frame, out) {
  for (const p of TRANSFORM_PROPS) {
    const tr = anim ? anim.tracks[propPath(group, side, p)] : null;
    out[p] = sampleTrack(tr, frame, DEFAULT_VALUES[p]);
  }
  return out;
}

// Sample + mirror + resolve to world-space out. Uses blendFrom for crossfade.
function sampleInto(fighter, out) {
  const A = fighter.anim;
  const anim = A.anim;
  const frame = A.scrubbing ? Math.floor(A.frame) : A.frame;
  const mGlobal = (anim && anim.mirror === false) ? 1 : (fighter.facingRight ? 1 : -1);

  const cfg = (anim && anim.weapons) || {};
  for (const side of SIDES) {
    const fh = flattenObject(anim, side, 'hands', frame, _flatHand);
    if (A.blendFrom && A.blendProgress < 1) {
      const b = A.blendFrom.hands ? A.blendFrom.hands[side] : null;
      if (b) for (const p of TRANSFORM_PROPS) fh[p] = b[p] + (fh[p] - b[p]) * easeOutC(A.blendProgress);
    }
    // Reuse the pooled out object (no per-frame hand allocation).
    const hand = out.hands[side] || (out.hands[side] = {});
    resolveHand(fighter.x, fighter.y, fh, mGlobal, hand);
    // Remember this frame's effective flat pose — the next playAnimation/stop
    // crossfade blends FROM here (world-space out has px/py, not x/y).
    // Field copy into the pooled flat object instead of a spread alloc.
    copyFlat(A._flat.hands[side] || (A._flat.hands[side] = {}), fh);

    const wcfg = (cfg[side] || null);
    const def = wcfg ? getWeapon(wcfg.id) : null;
    if (!def) { out.weapons[side] = null; A._flat.weapons[side] = null; continue; }
    const fw = flattenObject(anim, side, 'weapons', frame, _flatWeapon);
    if (A.blendFrom && A.blendProgress < 1) {
      const b = A.blendFrom.weapons ? A.blendFrom.weapons[side] : null;
      if (b) for (const p of TRANSFORM_PROPS) fw[p] = b[p] + (fw[p] - b[p]) * easeOutC(A.blendProgress);
    }
    copyFlat(A._flat.weapons[side] || (A._flat.weapons[side] = {}), fw);
    // Reuse the pooled weapon object (no per-frame weapon allocation).
    const wm = wcfg.mirror === false ? 1 : mGlobal;
    if (!out.weapons[side] || out.weapons[side].type !== 'weapon') out.weapons[side] = {};
    resolveWeapon(fighter, side, hand, fw, wcfg, def, wm, out.weapons[side]);
  }
}

// 1-(1-t)^3 expanded: identical curve, three multiplies instead of a pow call
// on every blended component every animated frame.
function easeOutC(t) {
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const u = 1 - t;
  return 1 - u * u * u;
}

function updateBlend(A, dt) {
  if (A.blendFrom && A.blendProgress < 1) {
    const ticks = dt <= 0 ? 1 : (A.anim ? A.anim.fps : 60) * dt;
    A.blendProgress = Math.min(1, A.blendProgress + ticks / Math.max(1, A.blendIn));
    if (A.blendProgress >= 1) A.blendFrom = null;
  }
}

function beginBlend(A, fromOut) {
  const blendIn = (A.anim && A.anim.blendIn) || 0;
  A.blendIn = blendIn;
  if (!blendIn || A.scrubbing) { A.blendFrom = null; A.blendProgress = 1; return; }
  // Crossfade source is the previous frame's FLAT pose (x/y/rot/…), the same
  // property space sectionInto interpolates — snapshots of the world-space out
  // (px/py) would NaN every blended frame.
  A.blendFrom = {
    hands: {
      left:  { ...A._flat.hands.left },
      right: { ...A._flat.hands.right },
    },
    weapons: {
      left:  A._flat.weapons.left  ? { ...A._flat.weapons.left }  : null,
      right: A._flat.weapons.right ? { ...A._flat.weapons.right } : null,
    },
  };
  A.blendProgress = 0;
}

// ── public API ───────────────────────────────────────────────────────────

export function attachAnimator(fighter) {
  fighter.anim = createAnimator(fighter);
}

// The one gameplay-facing call: request a named animation. Returns the id that
// ended up playing (or null when no animation matched → default pose).
export function playAnimation(fighter, name, { force = false } = {}) {
  const A = fighter.anim || (attachAnimator(fighter), fighter.anim);
  if (A.scrubbing) { A.scrubbing = false; A.blendFrom = null; }
  if (!force && A.animId === name) return A.animId;

  let anim = null, id = null;
  if (name) { anim = getAnimationClone(name); id = name; }
  A.anim = anim;
  A.animId = id;
  A.frame = 0;
  A.playing = true;
  A.paused = false;
  A.loop = !!(anim && anim.loop);
  A.fps = (anim && anim.fps) || 60;
  A.maxFrame = anim ? animationFrameCount(anim) : 0;
  beginBlend(A, A.out);
  return id;
}

let _loader = (name) => null;
export function setAnimationLoader(fn) { _loader = fn; }
export function getAnimationClone(name) { return _loader(name); }

export { playAnimation as requestAnimation };

export function stopAnimation(fighter) {
  const A = fighter.anim;
  if (!A) return;
  A.playing = false;
  A.paused = false;
  A.anim = null;
  A.animId = null;
  A.maxFrame = 0;
  // Blend back to the default pose from THIS frame's flat pose (same x/y/rot
  // property space sampleInto interpolates; the world-space out would NaN).
  A.blendFrom = {
    hands: {
      left:  A._flat.hands.left  ? { ...A._flat.hands.left }  : null,
      right: A._flat.hands.right ? { ...A._flat.hands.right } : null,
    },
    weapons: {
      left:  A._flat.weapons.left  ? { ...A._flat.weapons.left }  : null,
      right: A._flat.weapons.right ? { ...A._flat.weapons.right } : null,
    },
  };
  // Blend back to the default pose over a few frames. Reuse the last
  // animation's blendIn when we have one, otherwise fall back to ~3 frames.
  if (A.blendIn <= 0) A.blendIn = 3;
  A.blendProgress = 0;
  A.out = buildDefaultOut(fighter);
  resetFighterVfx(fighter);
}

// Advance + sample. `dt` in seconds. Pass 0/negative to only re-sample (editor
// scrubbing / paused).
export function updateAnimator(fighter, dt) {
  const A = fighter.anim;
  if (!A) return;
  if (dt > 0) {
    if (A.playing && !A.paused) {
      A.frame += A.fps * A.speed * dt;
      if (A.maxFrame > 0) {
        if (A.loop) {
          A.frame = A.frame % (A.maxFrame + 1);
        } else if (A.frame >= A.maxFrame) {
          A.frame = A.maxFrame;
          // Freeze at the last frame — the hands hold their final keyframed
          // pose until the attack ends, when syncFighterAnim calls
          // stopAnimation to blend back to the legacy movement pose system.
          A.playing = false;
          A.paused = false;
        }
      }
    }
    updateBlend(A, dt);
  } else {
    A.scrubbing = true;
  }
  sampleInto(fighter, A.out);
  updateFighterVfx(fighter, A.frame);
}

// Pure sample at the current frame (editor). Call after changing A.frame.
export function sampleAnimator(fighter) {
  const A = fighter.anim;
  if (!A) return false;
  A.scrubbing = true;
  sampleInto(fighter, A.out);
  updateFighterVfx(fighter, A.frame);
  return true;
}

export function resetAnimator(fighter) {
  const A = fighter.anim || (attachAnimator(fighter), fighter.anim);
  A.playing = false; A.paused = false; A.anim = null; A.animId = null;
  A.blendFrom = null; A.blendProgress = 1; A.frame = 0; A.scrubbing = false;
  A._flat = buildDefaultFlat();
  A.out = buildDefaultOut(fighter);
  resetFighterVfx(fighter);
  return A;
}

export function animatorFrameCount(A) { return A.maxFrame; }
