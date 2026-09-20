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