import { drawWeapon, getWeapon } from './anim.js';
import { SFX } from './assets.js';
import { getVfxEffect } from './fx.js';
import { GRAVITY, MAX_FALL_SPEED, LAUNCH_GRAVITY_MUL } from './physics.js';


// ── merged from render/handRig.js ──
// handRig.js — the canonical hand rig: one source of truth for hand sides,
// facing transforms, per-fighter rig configuration, and weapon-rotation
// easing. Rendering stays in Effects.js; this module owns data + transforms
// and imports nothing, so nothing can cycle through it.
//
// PIPELINE (stages in order, each with one job):
//   rig config (per-fighter store over def heldWeapons)
//     → idle hand positions (Effects.js idle cache, animation library)
//     → movement offsets (bob/pump/air/dodge, in the renderer)
//     → facing transform (mirror below — the ONLY place facing applies)
//     → equipment attach (grip/socket math in the renderer)
//     → layer resolve (front/back draw order in the renderer)
//
// COORDINATES: the rig is anatomical. Slots are body sides ('left'/'right'),
// authored facing-right. 'lead' resolves to the primary slot (default right)
// because the facing mirror carries body-right onto the facing side in BOTH
// facings; 'trail' is the other slot. Fixed 'left'/'right' assignments never
// move between slots — only their rendered mirror changes. Screen-side
// aliases ('front'/'back') exist for legacy callers and resolve per facing.
//
// Facing changes never rewrite attachments: the same slots, the same config,
// mirrored rendering. Rapid re-turns just retarget the (already eased)
// transforms, so nothing can strand.

// ── Per-fighter rig store ─────────────────────────────────────────────
// Extends (never replaces) the fighter def: primary hand, facing-transition
// blend rate, and an optional full held-weapons override edited in the Hand
// Gear editor. Separate key from the hand-gear store so existing loadouts,
// saves and reset flows are untouched. In-memory mirror = no localStorage
// reads in the frame loop; the editor writes through saveRig().
const RIG_STORE_KEY = 'smashfighters.handRig.v1';
export const RIG_DEFAULT_BLEND = 0.42; // matches the long-standing hand ease
function loadRigStore() {
  try {
    const raw = localStorage.getItem(RIG_STORE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (_) {
    return {};
  }
}
const _rigStore = loadRigStore();
function persistRigStore() {
  try { localStorage.setItem(RIG_STORE_KEY, JSON.stringify(_rigStore)); } catch (_) {}
}

// One-time cleanup: the knight was rebuilt bare-handed (boxer-style), so drop
// any stored rig override that would otherwise re-add held weapons onto him.
// Runs once per browser (separate flag key).
const KNIGHT_BARE_HELD_MIG_KEY = 'smashfighters.handRig.mig.knightBare.v2';
try {
  if (typeof localStorage !== 'undefined' && !localStorage.getItem(KNIGHT_BARE_HELD_MIG_KEY)) {
    const k = _rigStore.knight;
    if (k && k.held) {
      delete k.held;
      if (!Object.keys(k).length) delete _rigStore.knight;
      persistRigStore();
    }
    localStorage.setItem(KNIGHT_BARE_HELD_MIG_KEY, '1');
  }
} catch (_) {}

// Merged live config for a fighter id. Returned record is the stored one (or
// a shared default) — readers must not mutate it; writers go through saveRig.
const _DEFAULT_RIG = { primary: 'right', blend: RIG_DEFAULT_BLEND, held: null };

// Revision counter for the rig store. The derived orbit-geometry and skin-meta
// records are cached per (fighter id, revision); every write through saveRig /
// clearRig bumps this so a customiser edit is picked up on the next frame with
// no per-frame recompute and no leaked stale records.
let _rigRev = 0;
function _bumpRigRev() { _rigRev++; _orbitRigCache.clear(); _skinMetaCache.clear(); }

export function getRig(fighterId) {
  if (!fighterId) return _DEFAULT_RIG;
  const r = _rigStore[fighterId];
  return r && typeof r === 'object' ? r : _DEFAULT_RIG;
}
export function saveRig(fighterId, patch) {
  if (!fighterId) return false;
  try {
    const cur = _rigStore[fighterId] && typeof _rigStore[fighterId] === 'object'
      ? { ..._rigStore[fighterId] } : {};
    if (!patch || typeof patch !== 'object') return false;
    for (const k of Object.keys(patch)) {
      if (patch[k] === undefined) delete cur[k];
      else cur[k] = patch[k];
    }
    if (!Object.keys(cur).length) delete _rigStore[fighterId];
    else _rigStore[fighterId] = cur;
    persistRigStore();
    _bumpRigRev();
    return true;
  } catch (_) {
    return false;
  }
}
export function clearRig(fighterId) {
  if (!fighterId) return false;
  try {
    if (_rigStore[fighterId]) { delete _rigStore[fighterId]; persistRigStore(); _bumpRigRev(); }
    return true;
  } catch (_) {
    return false;
  }
}

// Primary (leading) anatomical slot for a fighter def: user rig choice wins,
// otherwise body-right — the slot the facing mirror puts on the facing side.
export function rigPrimary(fighterDef) {
  try {
    const id = fighterDef && fighterDef.id;
    const p = id && _rigStore[id] && _rigStore[id].primary;
    if (p === 'left' || p === 'right') return p;
  } catch (_) {}
  return 'right';
}
// Facing-transition blend rate (fraction of remaining distance per frame, same
// units as the historical hand ease): user rig choice wins, else the default.
export function rigBlend(fighterDef) {
  try {
    const id = fighterDef && fighterDef.id;
    const b = id && _rigStore[id] && _rigStore[id].blend;
    if (typeof b === 'number' && Number.isFinite(b)) {
      return Math.max(0.05, Math.min(1, b));
    }
  } catch (_) {}
  return RIG_DEFAULT_BLEND;
}
// Effective held-weapons array for a fighter def: the editor's override when
// present, else the def's own config. Returned by reference, never mutated by
// readers — zero per-frame allocation by construction.
export function resolveHeld(fighterDef) {
  try {
    const id = fighterDef && fighterDef.id;
    const o = id && _rigStore[id] && _rigStore[id].held;
    if (Array.isArray(o)) return o;
  } catch (_) {}
  const d = fighterDef && fighterDef.heldWeapons;
  return Array.isArray(d) ? d : null;
}

// ── Side resolution ──────────────────────────────────────────────────
// Body slot for a configured hand. Lead/trail resolve through the primary so
// a primary-left fighter leads left everywhere with no other changes;
// 'front'/'back' are legacy screen aliases resolved per facing.
export function resolveHoldSlot(hand, fighter) {
  const def = fighter && fighter._fighterDef;
  if (hand === 'lead') return rigPrimary(def);
  if (hand === 'trail') return rigPrimary(def) === 'right' ? 'left' : 'right';
  if (hand === 'front') return (fighter && fighter.facingRight) ? 'right' : 'left';
  if (hand === 'back') return (fighter && fighter.facingRight) ? 'left' : 'right';
  return (hand === 'left' || hand === 'right') ? hand : 'right';
}
export function otherBodySide(slot) {
  return slot === 'right' ? 'left' : 'right';
}
// Facing mirror multiplier for canonical-space values (+x = facing dir).
export function facingDir(fighter) {
  return fighter && fighter.facingRight ? 1 : -1;
}

// ── Weapon-rotation mirroring (prototype 1:1) ────────────────────────
// One-handed weapon orientation target (degrees): the entry's canonical
// angle multiplied by the facing sign when the entry mirrors. This is the
// prototype's exact rule (`rot = g.rot * d`, `flip = d`) and the
// mathematically correct mirror of the right-facing pose:
//     S(-1,1)·R(a)  ==  R(-a)·S(-1,1)
// i.e. mirror the sprite in x AND negate the angle. It is deliberately NOT
// `180 - a` (a true mirror rotated an extra 180), which draws mirrored
// weapons — a sword blade, a shield boss — upside down. Shared by the easer
// and the drawer so both always agree.
export function heldTargetRot(entry, dir) {
  const a = (entry && entry.angle) || 0;
  if (entry && entry.mirror === false) return a;
  return dir > 0 ? a : -a;
}
// Ease each one-handed weapon's rotation toward its live target along the
// shortest arc. Call ONCE per frame per fighter (the legacy draw path does);
// targets derive from live facing, so a mid-transition re-turn just retargets
// instead of snapping. State is one small object per fighter, keyed by weapon
// index — bounded, never reallocated, self-healing if the config changes.
export function easeHeldRots(fighter) {
  if (!fighter) return;
  const def = fighter._fighterDef;
  const cfg = resolveHeld(def);
  if (!cfg || !cfg.length) return;
  const blend = rigBlend(def);
  const dir = facingDir(fighter);
  let hr = fighter._heldRot;
  if (!hr) hr = fighter._heldRot = {};
  for (let i = 0; i < cfg.length; i++) {
    const e = cfg[i];
    if (!e || e.hands === 'both') continue;
    const target = heldTargetRot(e, dir);
    const cur = hr[i];
    if (typeof cur !== 'number' || !Number.isFinite(cur)) { hr[i] = target; continue; }
    let d = ((target - cur + 540) % 360) - 180;
    hr[i] = cur + d * blend;
  }
}
// Current (possibly mid-transition) rotation for weapon index i.
export function heldRot(fighter, i, target) {
  const hr = fighter && fighter._heldRot;
  const cur = hr ? hr[i] : undefined;
  return (typeof cur === 'number' && Number.isFinite(cur)) ? cur : target;
}
// Keep one-handed held-weapon rotation state synced while the held layer is
// hidden (attack/shield/victory animations own the hands, so neither the
// orbit snap nor easeHeldRots runs for them). A facing change mid-animation
// otherwise leaves _heldRot behind: at rest the sprite flip is instant
// (scaleX) but the angle eases over frames, so the weapon visibly sweeps
// under a flipped sprite — on the angled hand only, which reads as a
// one-sided turn bug. Stamping (the orbit snap's rule) keeps flip and angle
// atomic; the rest-path easing is untouched, so editor live-tweaks still
// ease smoothly.
export function syncHeldRotSnap(fighter) {
  if (!fighter) return;
  const cfg = resolveHeld(fighter._fighterDef);
  if (!cfg || !cfg.length) return;
  const dir = facingDir(fighter);
  let hr = fighter._heldRot;
  if (!hr) hr = fighter._heldRot = {};
  for (let i = 0; i < cfg.length; i++) {
    const e = cfg[i];
    if (!e || e.hands === 'both') continue;
    hr[i] = heldTargetRot(e, dir);
  }
}

// ── Shared hand orbit (facing-turn travel) ─────────────────────────────
// One orbit angle `phi` drives BOTH anatomical hands around the body, so a
// facing change reads as circular travel instead of a straight slide.
// Facing right rests at phi = 0, facing left at phi = -PI; the hands sit PI
// apart, so they stay opposite each other the whole way. Horizontal position
// follows cos (screen side), depth follows sin (>0 front, <0 behind).
// Attachments never move between hands: the visible front/rear swap is
// produced by the orbit, never by reassigning weapons or redrawing gear on
// the other fist.
export const HAND_OFF = { right: 0, left: Math.PI };
// Centralized switching parameters, in body radii. handDist pulled in to 1.0
// (hand centres on the body edge) per request; because the fists draw OVER the
// body (see drawFighter) a hand never ducks behind it, so pulling them in does
// not introduce a layer pop — the depth→size swell is what still reads as depth.
//   baseDur    0.5s rotation duration for a full half orbit (prototype `dur`)
//   snap       weapon grip-orientation snap point, 0..1 of the turn
//   handDist   hand ring radius, body radii (1.0 = hand centre on the body edge)
//   handY      hand ring height on the body centre line (+y is down)
//   depthScale orbit depth intensity (prototype z = sin(a), unit)
//   depthSize  depth→hand-size factor: r = h*(1 + depthSize*z) (prototype `arc`)
//   handRadius hand circle radius, body radii (prototype 6/18 ≈ 0.33; 0.35 here)
export const ORBIT = {
  baseDur: 0.5,
  snap: 0.5,
  handDist: 1.0,
  handY: 0,
  depthScale: 1,
  depthSize: 0.3,
  handRadius: 0.35,
};

// Overridable orbit GEOMETRY (handDist/handY/depthScale/depthSize/handRadius).
// A fighter def may carry an `orbit` record, and the Hand Gear customiser can
// store one under the rig store; the merged record is cached per (id, rev) and
// read allocation-free every frame. No override → the shared ORBIT record
// itself, so untouched fighters stay on the exact prototype defaults and the
// per-frame path never copies an object.
const _ORBIT_GEOM_KEYS = ['handDist', 'handY', 'depthScale', 'depthSize', 'handRadius'];
const _orbitRigCache = new Map();
export function resolveOrbitRig(fighterDef) {
  const id = fighterDef && fighterDef.id;
  if (!id) return ORBIT;
  const o = fighterDef.orbit;
  const st = _rigStore[id] && _rigStore[id].orbit;
  if (!o && !st) return ORBIT;
  const ck = id + '\u0000' + _rigRev;
  const hit = _orbitRigCache.get(ck);
  if (hit) return hit;
  const merged = { ...ORBIT };
  for (const src of [o, st]) {
    if (!src) continue;
    for (let k = 0; k < _ORBIT_GEOM_KEYS.length; k++) {
      const key = _ORBIT_GEOM_KEYS[k];
      const v = src[key];
      if (typeof v === 'number' && Number.isFinite(v)) merged[key] = v;
    }
  }
  if (_orbitRigCache.size > 64) _orbitRigCache.clear();
  _orbitRigCache.set(ck, merged);
  return merged;
}
function orbitEase(t) {
  // Smooth ease-in-out cubic: still at both ends, fastest mid-transition.
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}
// Per-fighter orbit overrides from the rig store ({ orbit: { dur, snap } }),
// edited in the Hand Gear editor. Neutral fallbacks keep untouched fighters
// exactly on the shared defaults.
export function orbitDur(fighterDef) {
  try {
    const id = fighterDef && fighterDef.id;
    const d = id && _rigStore[id] && _rigStore[id].orbit && _rigStore[id].orbit.dur;
    if (typeof d === 'number' && Number.isFinite(d)) return Math.max(0.05, Math.min(1, d));
  } catch (_) {}
  return ORBIT.baseDur;
}
export function orbitSnap(fighterDef) {
  try {
    const id = fighterDef && fighterDef.id;
    const s = id && _rigStore[id] && _rigStore[id].orbit && _rigStore[id].orbit.snap;
    if (typeof s === 'number' && Number.isFinite(s)) return Math.max(0, Math.min(1, s));
  } catch (_) {}
  return ORBIT.snap;
}
export function orbitTarget(facingRight) {
  return facingRight ? 0 : -Math.PI;
}
// Normalized turn progress from phi, 0 (facing right) to 1 (facing left).
// Position-based, so it stays correct in both directions and across
// interrupted turns — never derived from the turn's start direction.
export function orbitProgress(phi) {
  return Math.max(0, Math.min(1, -phi / Math.PI));
}
// Weapon grip orientation for an orbit angle: +1 right-facing, -1
// left-facing, flipping once at the configured snap point. At rest this
// agrees with facingDir exactly; mid-transition it holds the old orientation
// until the snap, then flips deliberately (no continuous weapon spin).
export function orbitGripDir(phi, fighterDef) {
  return orbitProgress(phi) < orbitSnap(fighterDef) ? 1 : -1;
}
// Current orbit angle of a fighter (settled facing target when no orbit
// state exists yet, e.g. editor previews that never simulate).
export function orbitPhi(fighter) {
  const o = fighter && fighter._orbit;
  if (o && typeof o.phi === 'number' && Number.isFinite(o.phi)) return o.phi;
  return orbitTarget(!!(fighter && fighter.facingRight));
}
// True while a facing transition is still travelling.
export function orbitActive(fighter) {
  const o = fighter && fighter._orbit;
  return !!o && o.t < 1;
}
// Advance the shared orbit one step. Retargets from the CURRENT angle
// whenever facing disagrees with the live target, so rapid re-turns bend
// the same circular motion instead of queuing or snapping. Duration scales
// with the remaining angular distance; zero-distance turns can't divide.
export function updateHandOrbit(fighter, dt) {
  if (!fighter || fighter.state === 'dead') return orbitPhi(fighter);
  const want = orbitTarget(!!fighter.facingRight);
  let o = fighter._orbit;
  if (!o || typeof o.phi !== 'number' || !Number.isFinite(o.phi)) {
    o = fighter._orbit = { phi: want, from: want, to: want, t: 1, dur: 0.001 };
    return o.phi;
  }
  if (o.to !== want) {
    o.from = o.phi;
    o.to = want;
    o.t = 0;
    const dist = Math.abs(o.to - o.from);
    // Prototype 1:1: duration scales with the remaining arc and is floored at
    // 0.05s, so even a nearly-complete re-turn still eases the last sliver
    // instead of snapping the final frame.
    o.dur = Math.max(0.05, orbitDur(fighter._fighterDef) * dist / Math.PI);
  }
  if (o.t < 1 && dt > 0) {
    o.t = Math.min(1, o.t + dt / o.dur);
    o.phi = o.from + (o.to - o.from) * orbitEase(o.t);
    if (o.t >= 1) o.phi = o.to;
  }
  return o.phi;
}
// Base pose of one anatomical hand ('left' | 'right'): fighter-relative
// offsets in body radii plus depth. `rig` is a resolveOrbitRig record (shared
// ORBIT when omitted). Written into `out` ({x, y, z}) so the per-frame path
// allocates nothing.
export function orbitHandPose(phi, side, out, rig) {
  const r = rig || ORBIT;
  const a = phi + (HAND_OFF[side] || 0);
  out = out || {};
  out.x = Math.cos(a) * r.handDist;
  out.y = r.handY;
  out.z = Math.sin(a) * r.depthScale;
  return out;
}
// Depth → hand size, straight from the prototype: r = h*(1 + depthSize*z).
// z ∈ [-1, 1], so a hand is depthSize larger in front and smaller behind
// (0.3 default → ±30%), which is what sells the hands travelling around a
// body with 3D-like depth. Gear rides the hand and scales with it for free.
export function orbitHandScale(z, rig) {
  const r = rig || ORBIT;
  // Clamped positive: a data-driven depthSize must never yield a non-positive
  // ellipse radius (canvas throws on those) or an inverted hand.
  return Math.max(0.1, 1 + r.depthSize * z);
}
// Which anatomical hand draws in front. Mid-orbit the depth decides (under
// the -PI convention the left hand always rides the frontal arc, the right
// hand the rear arc); exact ties happen only at rest, where facing decides —
// so rest layering matches the facing-side default exactly.
export function orbitFrontSide(phi, facingRight, transitioning) {
  // dz = zR - zL: positive means the right hand rides more frontal.
  const dz = Math.sin(phi) - Math.sin(phi + Math.PI);
  if (dz > 1e-3) return 'right';
  if (dz < -1e-3) return 'left';
  if (transitioning) return 'left';
  return facingRight ? 'right' : 'left';
}

// ── Shared skin / body metadata ────────────────────────────────────────
// ONE coordinate system for the body, hands and equipment. Every visual size
// the fighter renderer uses is read from here: the rendered body circle, the
// hand ring/radius the orbit places hands on, the depth intensity, and the
// grip scale for held weapons. That is what keeps a skin aligned with the
// hands and weapons as they orbit and switch — the skin cannot drift out of
// the hand system because both derive from the same record.
//
//   bodyRadiusMul  rendered body circle vs the PHYSICS radius. Combat,
//                  hitboxes and hurtboxes keep reading fighter.radius, so a
//                  skin can be drawn larger/smaller without touching balance.
//   handRadius     hand circle radius, body radii
//   handDist       hand ring radius, body radii (orbit geometry)
//   handY          hand ring height, body radii
//   depthScale     orbit depth intensity
//   depthSize      depth→hand-size factor (prototype `arc`)
//   gripScale      multiplies held-weapon grip offsets for this skin
//   skinScale      overrides the skin customiser's scale when set
//   skinCenterX/Y  skin image centre offset, source-image pixels (matches the
//                  pre-existing fighter.skinCenter field)
//
// Resolution order: shared defaults → SKIN_META[id] → fighterDef.skinMeta →
// the rig store's `visual` record. Every entry currently inherits the shared
// defaults, so existing skins keep their exact proportions and identity; the
// table is the per-skin extension point, not a forced re-proportioning.
export const SKIN_META_DEFAULTS = {
  bodyRadiusMul: 1,
  handRadius: ORBIT.handRadius,
  handDist: ORBIT.handDist,
  handY: ORBIT.handY,
  depthScale: ORBIT.depthScale,
  depthSize: ORBIT.depthSize,
  gripScale: 1,
  skinScale: null,
  skinCenterX: null,
  skinCenterY: null,
};
// Per-character overrides. Empty = inherit every shared default (the current
// roster, whose art was authored on the shared proportions). Add keys here to
// give one skin its own body size, hand attachment or grip without touching
// the shared hand system.
export const SKIN_META = {
  cowboy: {},
  ninja: {},
  boxer: {},
  knight: {},
};
const _SKIN_META_KEYS = [
  'bodyRadiusMul', 'handRadius', 'handDist', 'handY', 'depthScale',
  'depthSize', 'gripScale', 'skinScale', 'skinCenterX', 'skinCenterY',
];
// Ids whose table entry actually overrides something — lets the hot path skip
// the merge entirely for every fighter that uses the shared defaults.
const _skinMetaOverrideIds = new Set();
for (const k of Object.keys(SKIN_META)) {
  const e = SKIN_META[k];
  if (e && Object.keys(e).length) _skinMetaOverrideIds.add(k);
}
const _skinMetaCache = new Map();
export function resolveSkinMeta(fighterDef) {
  const id = fighterDef && fighterDef.id;
  const table = id && _skinMetaOverrideIds.has(id) ? SKIN_META[id] : null;
  const defMeta = fighterDef && fighterDef.skinMeta;
  const stMeta = id ? (_rigStore[id] && _rigStore[id].visual) : null;
  if (!table && !defMeta && !stMeta) return SKIN_META_DEFAULTS;
  const ck = (id || '') + '\u0000' + _rigRev;
  const hit = _skinMetaCache.get(ck);
  if (hit) return hit;
  const merged = { ...SKIN_META_DEFAULTS };
  for (const src of [table, defMeta, stMeta]) {
    if (!src) continue;
    for (let k = 0; k < _SKIN_META_KEYS.length; k++) {
      const key = _SKIN_META_KEYS[k];
      const v = src[key];
      if (v === null || v === undefined) continue;
      if (typeof v === 'number' && !Number.isFinite(v)) continue;
      merged[key] = v;
    }
  }
  if (_skinMetaCache.size > 64) _skinMetaCache.clear();
  _skinMetaCache.set(ck, merged);
  return merged;
}
// Rendered body radius for a fighter: physics radius × the skin's body-size
// multiplier. Combat geometry is untouched (it reads fighter.radius).
export function visualRadius(fighter, meta) {
  const r = (fighter && fighter.radius) || 31;
  const m = meta || resolveSkinMeta(fighter && fighter._fighterDef);
  const mul = m.bodyRadiusMul;
  return (typeof mul === 'number' && mul > 0) ? r * mul : r;
}


// ── merged from render/Accessories.js ──
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
//
// It also owns getSkinImage, the shared on-demand image cache this module's own
// accessories use and the character skins / mount sprite are drawn through. One
// Image object per path, kept for the lifetime of the page — nothing here is
// per-frame work.

const STORAGE_KEY = 'smashfighters.accessories';

// ── Image cache ─────────────────────────────────────────────────────────
// One entry per path, created on first request. status:
//   'loading' | 'loaded' | 'error'
const skinImageCache = new Map();

// ── Procedural-art sprite baking ────────────────────────────────────────
//
// Every procedural accessory and hand-gear shape is a STATIC piece of vector
// artwork drawn in a normalized unit space (1.0 = one fighter/hand radius) and
// then placed with a translate/rotate/scale. The old path re-issued the whole
// path — every moveTo/lineTo/quadraticCurveTo, every fill, and every stroke
// (stroke tessellation alone is roughly 2-4x the cost of a fill) — on every
// frame, for every wearer, just to produce identical pixels.
//
// Each shape is therefore rasterized ONCE into a small offscreen canvas and
// blitted thereafter. Because the shape is drawn under a scale of RES in the
// bake and the blit applies the same uniform scale the stroke would have had,
// the baked outline lands at exactly the same on-screen thickness.
//
// HALF bounds the unit-space box the artwork is assumed to occupy. Anything
// drawn outside it is simply cropped, so it must cover the widest shape.
//
// BAKE_RES is art-px-per-sprite-px. It is deliberately close to the size the
// art is actually displayed at (a hand gear covers roughly 2.9 hand radii, and
// a hand radius is ~28-31px, so ~85px on screen). Baking much larger than that
// is not free: a downscaling blit still has to SAMPLE the whole source, so a
// 4x oversized sprite costs ~16x the pixel samples for no visible benefit.
// ~2x headroom is enough to stay crisp when the camera zooms in.
const BAKE_HALF = 1.45;
const BAKE_RES = 56;
const _bakeCache = new Map();

export function bakedUnitSprite(drawFn) {
  if (typeof drawFn !== 'function') return null;
  let spr = _bakeCache.get(drawFn);
  if (spr !== undefined) return spr;
  try {
    const size = Math.ceil(BAKE_HALF * 2 * BAKE_RES);
    const c = document.createElement('canvas');
    c.width = size;
    c.height = size;
    const b = c.getContext('2d');
    // Map unit space [-BAKE_HALF, BAKE_HALF] onto the canvas.
    b.translate(BAKE_HALF * BAKE_RES, BAKE_HALF * BAKE_RES);
    b.scale(BAKE_RES, BAKE_RES);
    drawFn(b);
    spr = c;
  } catch (_) {
    spr = null;
  }
  _bakeCache.set(drawFn, spr);
  return spr;
}

// Blit a baked unit-space sprite under the caller's already-applied transform.
// Mirrors the old `ctx.scale(±s, s); entry.draw(ctx)` exactly.
function drawBakedUnit(ctx, spr) {
  ctx.drawImage(spr, -BAKE_HALF, -BAKE_HALF, BAKE_HALF * 2, BAKE_HALF * 2);
}
export const UNIT_HALF = BAKE_HALF;

// Retry clock for failed images. The retry throttle used to call
// `performance.now()` inside getSkinImage — a DOM high-resolution timer read
// executed per fighter per frame, from the DRAW path, every time a skin failed
// to load. A failure is rare and sticky, so a single per-tick timestamp
// (updated by tickSkinImageRetries, called from the game update) is enough to
// drive the same 3s throttle with zero per-frame cost.
let _retryNow = 0;
export function tickSkinImageRetries() { _retryNow = performance.now(); }

export function getSkinImage(path) {
  if (!path) return null;
  let entry = skinImageCache.get(path);
  if (entry) {
    // A previously-failed image is retried (throttled) so it recovers without
    // a page refresh once the asset is actually served.
    if (entry.status === 'error' && _retryNow - entry.lastAttempt > 3000) {
      retrySkinImage(entry, path);
    }
    return entry;
  }
  entry = { status: 'loading' };
  skinImageCache.set(path, entry);
  retrySkinImage(entry, path);
  return entry;
}

function retrySkinImage(entry, path) {
  entry.status = 'loading';
  entry.lastAttempt = performance.now();
  const img = new Image();
  entry.img = img;
  img.onload  = () => { entry.status = 'loaded'; };
  img.onerror = () => {
    entry.status = 'error';
    console.warn(`[skin] failed to load image at "${path}" — falling back to a flat/procedural draw.`);
  };
  img.src = path;
}

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

// A ninja headband: a cloth band tied around the brow with two tails whipping out
// behind. Drawn in the same unit space as the hats (1.0 = one fighter radius) and
// used as the on-screen fallback while ninjaheadband.png loads or if it fails.
function drawNinjaHeadband(ctx) {
  const RED = '#c62828';
  const RED_D = '#8e1c1c';
  // Band across the brow
  ctx.beginPath();
  ctx.moveTo(-0.58, -0.58);
  ctx.quadraticCurveTo(0, -0.44, 0.58, -0.58);
  ctx.lineTo(0.58, -0.78);
  ctx.quadraticCurveTo(0, -0.64, -0.58, -0.78);
  ctx.closePath();
  ctx.fillStyle = RED;
  ctx.fill();
  strokePath(ctx);
  // Knot + trailing tails (behind the head, so they read as cloth)
  ctx.beginPath();
  ctx.moveTo(-0.3, -0.6);
  ctx.quadraticCurveTo(-0.62, -0.62, -0.92, -0.44);
  ctx.quadraticCurveTo(-0.66, -0.56, -0.34, -0.46);
  ctx.closePath();
  ctx.fillStyle = RED;
  ctx.fill();
  strokePath(ctx);
  ctx.beginPath();
  ctx.moveTo(-0.34, -0.68);
  ctx.quadraticCurveTo(-0.68, -0.82, -1.0, -0.76);
  ctx.quadraticCurveTo(-0.7, -0.72, -0.3, -0.58);
  ctx.closePath();
  ctx.fillStyle = RED_D;
  ctx.fill();
  strokePath(ctx);
}

// ── Accessory catalogue ────────────────────────────────────────────────
// id -> { name, img? (image art), draw? (procedural fallback) }. Entries with
// an image draw it seated on the head; `draw` is used as a fallback while the
// image loads or if it fails.
export const ACCESSORIES = [
  { id: 'none', name: 'NONE' },
  { id: 'cowboyhat', name: 'COWBOY HAT', img: '/GA/accesories/cowboyhat.png', draw: drawCowboyHat },
  { id: 'ninjaheadband', name: 'NINJA HEADBAND', img: '/GA/accesories/ninjaheadband.png', draw: drawNinjaHeadband },
  { id: 'knighthelmet', name: 'KNIGHT HELMET', img: '/GA/accesories/knighthelmet.png' },
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
  const prevQuality = ctx.imageSmoothingQuality;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, -w / 2, IMAGE_SEAT_Y - h, w, h);
  if (prevQuality) ctx.imageSmoothingQuality = prevQuality;
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
  if (!drew && entry.draw) {
    // Blit the baked sprite when we have one; fall back to the live vector pass
    // if baking failed (e.g. a canvas-less environment) so the art still shows.
    const spr = bakedUnitSprite(entry.draw);
    if (spr) drawBakedUnit(ctx, spr);
    else entry.draw(ctx);
  }
  ctx.restore();
}


// ── merged from render/HandGear.js ──
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


const GEAR_STORAGE_KEY = 'smashfighters.handGear';

export const HAND_SIDES = ['left', 'right'];

// ── Procedural vector hand gear ─────────────────────────────────────────
// Drawn in HAND space: 1.0 = one hand radius, origin = the hand's centre.
// Used as a fallback while the image loads and if the image fails, so a fighter
// never renders a bare hand just because an asset is slow.

const HAND_OUTLINE = '#222222';

function strokeHandGearPath(ctx) {
  ctx.strokeStyle = HAND_OUTLINE;
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
  strokeHandGearPath(ctx);

  // Thumb, tucked across the lower-left of the mitt.
  ctx.beginPath();
  ctx.moveTo(-0.62, 0.2);
  ctx.quadraticCurveTo(-1.04, 0.06, -0.86, -0.36);
  ctx.quadraticCurveTo(-0.6, -0.2, -0.46, 0.04);
  ctx.closePath();
  ctx.fillStyle = RED_D;
  ctx.fill();
  strokeHandGearPath(ctx);

  // Main mitt.
  ctx.beginPath();
  ctx.ellipse(0, -0.24, 0.94, 0.82, 0, 0, Math.PI * 2);
  ctx.fillStyle = RED;
  ctx.fill();
  strokeHandGearPath(ctx);

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
// id -> { name, img? (image art), draw? (procedural fallback) }. The sword
// and shield are image-only: the exact GA PNGs, no procedural placeholder.
export const HAND_GEAR = [
  { id: 'none', name: 'NONE' },
  { id: 'boxinggloves', name: 'BOXING GLOVES', img: '/GA/accesories/boxinggloves.png', draw: drawBoxingGlove },
  { id: 'sword', name: 'SWORD', img: '/GA/accesories/sword.png' },
  { id: 'shield', name: 'SHIELD', img: '/GA/accesories/shield.png' },
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
    return JSON.parse(localStorage.getItem(GEAR_STORAGE_KEY)) || {};
  } catch (_) {
    return {};
  }
}

// A character's built-in gear (default loadout): either one id for both
// hands (the boxer's gloves) or a per-side { left, right } pair (the
// knight's shield + sword). Unknown ids fall back to 'none' so a typo can
// never wedge a hand into a missing entry.
export function defaultGearIdFor(defaultType, side) {
  const id = (defaultType && typeof defaultType === 'object') ? defaultType[side] : defaultType;
  return _handGearMap.has(id) ? id : 'none';
}

// `defaultType` is the character's built-in gear: a single id, a per-side
// pair, or undefined/'none'. A fighter with no stored record gets that
// default; anything stored still wins per side.
export function loadHandGearFor(fighterId, defaultType) {
  const base = {
    left: defaultHandGear(defaultGearIdFor(defaultType, 'left')),
    right: defaultHandGear(defaultGearIdFor(defaultType, 'right')),
  };
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
    localStorage.setItem(GEAR_STORAGE_KEY, JSON.stringify(all));
  } catch (_) {}
}

// Used by the customiser's MATCH BOTH HANDS and RESET rows, which act on the
// whole pair at once instead of the single hand being edited.
export function saveHandGearSetFor(fighterId, gear) {
  if (!fighterId) return;
  try {
    const all = readStore();
    all[fighterId] = cloneHandGearSet(gear);
    localStorage.setItem(GEAR_STORAGE_KEY, JSON.stringify(all));
  } catch (_) {}
}

// One-time cleanup: the knight was rebuilt bare-handed (boxer-style), so drop
// his stored fist gear — otherwise a saved sword/shield loadout would keep
// painting weapons onto his fists. Runs once per browser (separate flag key).
const KNIGHT_BARE_GEAR_MIG_KEY = 'smashfighters.handGear.mig.knightBare.v1';
try {
  if (typeof localStorage !== 'undefined' && !localStorage.getItem(KNIGHT_BARE_GEAR_MIG_KEY)) {
    const raw = localStorage.getItem(GEAR_STORAGE_KEY);
    if (raw) {
      const all = JSON.parse(raw);
      if (all && all.knight) {
        delete all.knight;
        localStorage.setItem(GEAR_STORAGE_KEY, JSON.stringify(all));
      }
    }
    localStorage.setItem(KNIGHT_BARE_GEAR_MIG_KEY, '1');
  }
} catch (_) {}

// Clean-slate refresh: NOBODY starts with hand gear. Drop every stored fist
// loadout and every stored held-weapon/rig override, so all fighters come out
// bare-fisted and the trimmed Hand Weapons editor is the only way anything
// gets equipped from here on. Runs once per browser (separate flag keys).
const CLEAN_SLATE_GEAR_MIG_KEY = 'smashfighters.handGear.mig.cleanSlate.v1';
try {
  if (typeof localStorage !== 'undefined' && !localStorage.getItem(CLEAN_SLATE_GEAR_MIG_KEY)) {
    localStorage.removeItem(GEAR_STORAGE_KEY);
    localStorage.setItem(CLEAN_SLATE_GEAR_MIG_KEY, '1');
  }
} catch (_) {}
const CLEAN_SLATE_RIG_MIG_KEY = 'smashfighters.handRig.mig.cleanSlate.v1';
try {
  if (typeof localStorage !== 'undefined' && !localStorage.getItem(CLEAN_SLATE_RIG_MIG_KEY)) {
    for (const k of Object.keys(_rigStore)) delete _rigStore[k];
    persistRigStore();
    localStorage.setItem(CLEAN_SLATE_RIG_MIG_KEY, '1');
  }
} catch (_) {}

export function handGearName(id) {
  const g = _handGearMap.get(id);
  return g ? g.name : 'NONE';
}

// ── Drawing ────────────────────────────────────────────────────────────
// Image art is centred on the hand and sized in hand-radius units, so a glove
// reads as a glove covering the fist rather than as a hat perched on it.
const HAND_IMAGE_WIDTH = 2.3;

function drawImageHandGear(ctx, entry) {
  const e = getSkinImage(entry.img);
  if (!e || e.status !== 'loaded' || !e.img) return false;
  const img = e.img;
  const w = HAND_IMAGE_WIDTH;
  const h = w * (img.height / img.width);
  const prevQuality = ctx.imageSmoothingQuality;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, -w / 2, -h / 2, w, h);
  if (prevQuality) ctx.imageSmoothingQuality = prevQuality;
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
  if (!drew && entry.draw) {
    // Baked sprite instead of re-tessellating the vector art every frame. A
    // boxing glove is ~12 path ops including 5 stroke tessellations, and it is
    // drawn for BOTH hands of every fighter on every frame. Falls back to the
    // live vector pass if baking is unavailable.
    const spr = bakedUnitSprite(entry.draw);
    if (spr) ctx.drawImage(spr, -UNIT_HALF, -UNIT_HALF, UNIT_HALF * 2, UNIT_HALF * 2);
    else entry.draw(ctx);
  }
  ctx.restore();
}


// ── merged from core/camera.js ──
// render.js — the single dynamic camera, plus the shake offset it draws
// with. Every world->screen transform in the game goes through
// applyCameraTransform(), so this file owns all camera state.
//
// Smash-style dynamic camera
// --------------------------
// One camera, two framing regimes, chosen per frame inside computeFraming().
// Tracks BOTH players: midpoint follow + dynamic zoom, vertical-aware,
// off-stage-aware. Smooth interpolation, no snapping, stage-bound clamping,
// deadzone against jitter, slow zoom rate so it never pumps. Shake is
// tiny/controlled (see shakeCamera) and decays fast.
//
// Two regimes:
//   - BOTH players in play: the framing zoom is pure geometry from their actual
//     separation on BOTH axes, clamped to [TWO_PLAYER_MIN_ZOOM,
//     TWO_PLAYER_MAX_ZOOM] - wider as they part, tighter as they close. The
//     clamp is what keeps the view from collapsing onto them mid-match.
//   - ONE player in play (the other eliminated/respawning): stop trying to fit
//     two and settle onto the survivor at SOLE_SURVIVOR_ZOOM. A fighter who is
//     merely past the off-stage cut but still alive keeps the two-player zoom
//     regime — the winner push-in waits until the loser actually dies and
//     disappears, never firing mid-launch while they can still recover.
//
// The off-stage cut is VERTICAL ONLY, so two players merely drifting apart
// horizontally never flips the camera into winner focus; and it is a threshold,
// not a latch - a player who climbs back above it restores two-player framing.

// ── Camera configuration ─────────────────────────────────────────────────
const CAMERA_SMOOTHING = 0.12;   // pan easing (higher = snappier, no popping)
// Zoom easing is ASYMMETRIC on purpose. Widening is urgent - a fighter who is
// about to leave the frame has to be kept in it - so it runs on a fast ramp.
// Tightening is lazy, because chasing a shrink is what makes a camera pump.
const ZOOM_SMOOTHING = 0.05;         // slow: zooming IN
const ZOOM_OUT_SMOOTHING = 0.35;     // fast: zooming OUT to re-accommodate
const ZOOM_IN_RATE = 0.35;           // max zoom-in units per second
const ZOOM_OUT_RATE = 6.0;           // max zoom-out units per second
// Two players in play.
//
// TWO_PLAYER_MAX_ZOOM is a hard ceiling on the zoom-IN: the view never gets
// tighter than this, however close the two fighters are. Everything wider is
// the camera accommodating them - see the fit below, which widens by exactly as
// much as the current positions require and no more.
//
// The visible world width is arenaWidth / zoom, so the ceiling is really "how
// much stage do we show". The stage is 1080 wide with a ~702-wide main ground:
//   2.00      -> ~540px visible. Two fighters plus a real margin, filling the
//                 frame, and the resting view for ordinary spacing.
//   min 0.85 -> widest the view may go; keeps fighters readable, never tiny.
//                 (The square viewport shows less horizontal room than the old
//                 widescreen one, so the floor sits slightly tighter than the
//                 old 0.78 — extreme separations still fit, verified by the
//                 fit math: opposite blast edges need ~0.93.)
// Players at opposite edges of the main ground (~702px apart) fit at ~1.4, so
// the full tight-to-wide range stays available and always fits both.
const TWO_PLAYER_MIN_ZOOM = 0.85;
const TWO_PLAYER_MAX_ZOOM = 2.0;
// Margin kept between the players' bounding box and the edge of the frame.
// Two-player framing only - the winner/single-player branch reads
// SOLE_SURVIVOR_ZOOM and ignores this, so padding changes cannot alter winner or
// off-stage behaviour.
const ZOOM_PADDING = 40;
// How far BELOW the main platform a fighter must fall before the camera stops
// framing them. Matches the vertical follow tolerance the clamps already use
// (g.y + 260), so the cut and the pan limits agree.
const OFFSTAGE_CAMERA_THRESHOLD = 260;
// A single fighter is the only thing left in frame: a clear push-in so they are
// unambiguously the subject. This is the live-match value (a fighter past the
// off-stage cut also leaves one subject) and is deliberately modest.
const SOLE_SURVIVOR_ZOOM = 1.3;
// Winner announced: a HARD close-up so the winner fills the frame. This is the
// framing target, and it compounds with WINNER_MATCH_ZOOM below — at match end
// both are live at once, so the total push-in is the product.
const WINNER_CAMERA_ZOOM = 2.2;

// The second, softer layer: eases in over about a second once the match is over.
// Kept as its own constant (rather than folded into WINNER_CAMERA_ZOOM) so the
// two effects stay independently tunable, and because updateMatchZoom is what
// animates the arrival — the framing number above is reached via the camera's
// own asymmetric zoom easing.
const WINNER_MATCH_ZOOM = 1.6;
const FOLLOW_ZOOM = 1.15;  // closer default view; zoom math still fits both
const CAM_DEADZONE = 5; // px — ignore smaller target moves (no jitter)
const MAX_PAN_PER_FRAME = 14; // px at 60fps — avoids snapping on launches
// Smash-style group-framing extras (single controller, no second system):
// restrained velocity look-ahead + zoom hysteresis deadband so the view never
// pumps around a threshold. Look-ahead dies in close combat, cinematics and
// match-end; the deadband only holds the target, never the easing itself.
const LOOKAHEAD_TIME = 0.18;   // seconds of velocity to peek ahead
const LOOKAHEAD_MAX = 60;      // px clamp per axis — never yanks off the group
const LOOKAHEAD_CLOSE_SPREAD = 220; // below this spread, no look-ahead (infight)
const ZOOM_DEADBAND = 0.03;    // hold target inside this band (no oscillation)

let cameraX = 0;
let cameraY = 0;
let targetX = 0;
let targetY = 0;
let baseZoom = 1;         // User-facing zoom setting
let matchZoom = 1;        // Winner KO zoom-in (eases toward WINNER_MATCH_ZOOM)
let trackZoom = 1;        // Wide/tight dynamic framing zoom
let targetTrackZoom = 1;
let followActive = true;  // Is tracking live fighters
let shakeOffsetX = 0;
let shakeOffsetY = 0;

let cutsceneTarget = null;

// ── Camera shake ─────────────────────────────────────────────────────────
// Screen shake. Deliberately tiny and always self-decaying: strong hits, hard
// landings and knockouts only, never constant. `decay` lets a knockout hold its
// (still small) shake a fraction longer than a hit; the magnitude is clamped
// hard so the fighters can never become hard to track.
const SHAKE_DECAY = 0.18;
const SHAKE_MAX = 6;
let _shakeMag = 0;
let _shakeTime = 0;
let _shakeDecay = SHAKE_DECAY;

export function shakeCamera(mag = 2, decay = SHAKE_DECAY) {
  const m = Math.max(0, Math.min(SHAKE_MAX, Number(mag) || 0));
  if (m <= 0) return;
  _shakeMag = Math.max(_shakeMag, m);
  _shakeDecay = Math.max(0.08, Math.min(0.4, Number(decay) || SHAKE_DECAY));
  _shakeTime = _shakeDecay;
}

// ── Camera zoom ramp ─────────────────────────────────────────────────────
// A one-shot scripted zoom (zoomCamera) layered under the dynamic framing
// zoom. It is a separate layer because it answers a different question: not
// "where are the fighters" but "the match just started / ended, push in".
let zoomCurrent = 1;
let zoomTarget = 1;
let zoomElapsed = 0;
let zoomDuration = 0;

export function zoomCamera(targetScale = 1.5, duration = 0.3, fromCurrent = false) {
  if (!fromCurrent) zoomCurrent = 1;
  zoomTarget = targetScale;
  zoomElapsed = 0;
  zoomDuration = duration;
}

export function resetCameraZoom() {
  zoomTarget = 1;
  zoomDuration = 0;
}

export function updateCameraZoom(dt) {
  if (zoomDuration > 0) {
    zoomElapsed += dt;
    const t = Math.min(zoomElapsed / zoomDuration, 1);
    zoomCurrent = 1 + (zoomTarget - 1) * t;
    if (t >= 1) zoomDuration = 0;
  } else {
    zoomCurrent += (1 - zoomCurrent) * 0.08;
  }
}

export function getCameraZoom() {
  return zoomCurrent;
}

export function setCutsceneCamera(target) {
  cutsceneTarget = target; // { x, y, zoom } or null
}

export function resetCamera() {
  cameraX = 0;
  cameraY = 0;
  targetX = 0;
  targetY = 0;
  baseZoom = 1;
  matchZoom = 1;
  trackZoom = 1;
  targetTrackZoom = 1;
  followActive = true;
  shakeOffsetX = 0;
  shakeOffsetY = 0;
  _shakeMag = 0;
  _shakeTime = 0;
  _shakeDecay = SHAKE_DECAY;
  cutsceneTarget = null;
}

export function setBaseZoom(val) {
  baseZoom = typeof val === 'number' && val > 0 ? val : 1;
}

export function setMatchZoom(val) {
  matchZoom = val;
}

export function setFollowActive(active) {
  followActive = !!active;
}

// The match-end push-in layer. Eases toward WINNER_MATCH_ZOOM while the match
// is over and back to 1 once it is not (a rematch / a return to the menu), so
// the close-up arrives on its own instead of snapping. It multiplies the
// framing zoom, which computeFraming has already aimed at the lone survivor.
export function updateMatchZoom(dt, isMatchOver) {
  if (isMatchOver) {
    matchZoom += (WINNER_MATCH_ZOOM - matchZoom) * 0.04 * (dt * 60);
  } else {
    matchZoom += (1.0 - matchZoom) * 0.08 * (dt * 60);
  }
}

// ── Shared framing computation (single source of truth) ────────────────
// Pure geometry: midpoint + stage-clamped pan target + dynamic zoom want for
// the CURRENT fighter positions. updateCamera eases toward it every frame;
// snapCameraToFit assigns it directly (match start — no animation).
//
// The result is a single reused record, not a fresh object per frame. Both
// callers (snapCameraToFit, updateCamera) read every field out of it before
// returning, and neither holds onto it past that, so sharing one record is
// equivalent to allocating a new one and costs no garbage on the camera path.
const _framing = { x: 0, y: 0, zoom: 1, alive: 0 };

function computeFraming(fighters, canvasWidth, canvasHeight, stage, isMatchOver) {
  // Logical viewport is 1080 × 1080 (square). Callers pass the arena size;
  // the fallback matches it so a missing size still frames the square view.
  const W = canvasWidth || 1080, H = canvasHeight || 1080;

  // Main platform first: the off-stage cut below is measured from it, and the
  // pan clamps reuse the same lookup. Index loop instead of
  // platforms.find(p => p.isGround): a 2-element stage doesn't need a predicate
  // closure allocated and called on every frame.
  let g = null;
  try {
    const plats = stage && stage.platforms;
    if (plats) {
      for (let i = 0; i < plats.length; i++) {
        if (plats[i].isGround) { g = plats[i]; break; }
      }
      if (!g) g = plats[0];
    }
  } catch (_) {}

  // A fighter is treated as off-stage (out of the framing) once they are this
  // far BELOW the main platform. Vertical only - horizontal distance never
  // triggers it. Null when the stage exposes no platform, in which case only
  // the dead/respawn state test below applies.
  const offstageCut = g ? g.y + OFFSTAGE_CAMERA_THRESHOLD : null;

  let alive = 0;
  let liveExcluded = 0; // alive but past the off-stage cut (still recoverable)
  let minX = Infinity, maxX = -Infinity;
  let minY = Infinity, maxY = -Infinity;
  // Highest off-stage fighter, kept as a last-resort subject (see below).
  let hiY = Infinity, hiF = null;

  for (let i = 0; i < fighters.length; i++) {
    const f = fighters[i];
    if (!f || f.state === 'dead' || f.state === 'respawn') continue;
    if (offstageCut !== null && f.y > offstageCut) {
      if (f.y < hiY) { hiY = f.y; hiF = f; }
      liveExcluded++;
      continue;
    }
    alive++;
    if (f.x < minX) minX = f.x;
    if (f.x > maxX) maxX = f.x;
    if (f.y < minY) minY = f.y;
    if (f.y > maxY) maxY = f.y;
  }

  // Everyone fell past the cut (e.g. a simultaneous double KO). Returning null
  // would hand updateCamera an early return and freeze the view mid-air, so
  // frame the highest one instead - the camera always keeps a subject.
  if (alive === 0) {
    if (!hiF) return null;
    alive = 1;
    minX = maxX = hiF.x; minY = maxY = hiF.y;
  }

  let wantX = (minX + maxX) / 2;
  let wantY = (minY + maxY) / 2;
  // Vertical spread biases the view upward to give the action headroom. Safe at
  // any magnitude now: the fit below is derived from the final pan position, so
  // a bias that would push the lower player toward the edge widens the view by
  // itself instead of clipping.
  const vSpread = maxY - minY;
  if (vSpread > 260) wantY -= Math.min(60, (vSpread - 260) * 0.12);
  // Restrained velocity look-ahead: peek a fraction of a second along the
  // group's mean velocity so fast launches/dashes don't feel cramped. Killed
  // in close combat (would fight infight framing), cinematics and match-end,
  // and hard-clamped so it can never pull off the group or jitter on DI flips.
  try {
    if (!isMatchOver && !cutsceneTarget && (alive + liveExcluded) >= 2) {
      const spreadX = maxX - minX, spreadY = maxY - minY;
      const spread = spreadX > spreadY ? spreadX : spreadY;
      if (spread >= LOOKAHEAD_CLOSE_SPREAD) {
        let svx = 0, svy = 0, n = 0;
        for (let i = 0; i < fighters.length; i++) {
          const f = fighters[i];
          if (!f || f.state === 'dead' || f.state === 'respawn') continue;
          if (offstageCut !== null && f.y > offstageCut) continue;
          if (Number.isFinite(f.vx)) svx += f.vx;
          if (Number.isFinite(f.vy)) svy += f.vy;
          n++;
        }
        if (n > 0) {
          let lx = (svx / n) * LOOKAHEAD_TIME;
          let ly = (svy / n) * LOOKAHEAD_TIME;
          if (lx > LOOKAHEAD_MAX) lx = LOOKAHEAD_MAX;
          else if (lx < -LOOKAHEAD_MAX) lx = -LOOKAHEAD_MAX;
          if (ly > LOOKAHEAD_MAX) ly = LOOKAHEAD_MAX;
          else if (ly < -LOOKAHEAD_MAX) ly = -LOOKAHEAD_MAX;
          // Vertical look-ahead is halved: full vertical chase pumps on jumps.
          wantX += lx;
          wantY += ly * 0.5;
        }
      }
    }
  } catch (_) {}

  let clampL = W * 0.15, clampR = W * 0.85, clampT = H * 0.1, clampB = H * 0.95;
  // Sandbox-only override (stage.cameraFraming). The main map never sets it,
  // so the two-fighter framing below is byte-for-byte what it always was. When a
  // stage DOES set it, the arena's own pan box replaces the ground-platform
  // guess — a sandbox arena has an authored shape that does not have to match
  // its widest block — and the fit uses the real roster count instead of
  // "exactly two or treat it as a winner shot".
  // NOTE: camera bounds are deliberately NOT the death-zone bounds. The pan
  // box follows the playable arena (ground platform); death-zone margins only
  // drive KO detection in physics.js and never move the camera by themselves.
  const cf = (stage && stage.cameraFraming) || null;
  if (cf && cf.pan) {
    clampL = cf.pan.left; clampR = cf.pan.right; clampT = cf.pan.top; clampB = cf.pan.bottom;
  } else if (g) {
    clampL = g.x - 120; clampR = g.x + g.width + 120;
    clampT = g.y - 520; clampB = g.y + 260;
  }
  wantX = Math.max(clampL, Math.min(clampR, wantX));
  wantY = Math.max(clampT, Math.min(clampB, wantY));

  // Fit the pair into the window that is actually going to be rendered, which
  // is not always the box centred on their midpoint: the pan gets clamped to
  // the stage bounds and biased upward for tall spreads. Deriving the zoom from
  // the FINAL pan position, instead of from the raw separation alone, is what makes
  // the fit a guarantee - whenever clamping or biasing would push one of them
  // toward an edge, this widens by exactly as much as that requires and no more.
  // With an unclamped, unbiased pan it reduces to the familiar
  // min(W / (spreadX + 2 * padding), H / (spreadY + 2 * padding)).
  const halfX = Math.max(Math.abs(minX - wantX), Math.abs(maxX - wantX)) + ZOOM_PADDING;
  const halfY = Math.max(Math.abs(minY - wantY), Math.abs(maxY - wantY)) + ZOOM_PADDING;
  const fitZoom = Math.min(W / (2 * halfX), H / (2 * halfY));
  // Two players in play: bounded at both ends. TWO_PLAYER_MAX_ZOOM is the hard
  // limit on zooming in; anything the fit needs beyond the ceiling is clamped
  // away, and anything wider than the fit is allowed through so both always
  // fit. A stage that opted into cameraFraming (the sandbox) frames whatever
  // roster it was given with the same fit, bounded by that stage's own zoom
  // limits.
  //
  // The push-in fires ONLY on true elimination: as long as two fighters are
  // alive — even with one past the off-stage cut and still recoverable — the
  // two-player regime holds and the camera never zooms onto the survivor
  // mid-launch. "One player left" therefore always means the loser has died
  // and disappeared: a modest SOLE_SURVIVOR_ZOOM live, the full
  // WINNER_CAMERA_ZOOM close-up once the match is decided.
  const contested = (alive + liveExcluded) >= 2;
  const wantZoom = cf && cf.fitAnyRoster
    ? Math.max(cf.minZoom || 0.4, Math.min(cf.maxZoom || 1.4, fitZoom))
    : (contested
      ? Math.max(TWO_PLAYER_MIN_ZOOM, Math.min(TWO_PLAYER_MAX_ZOOM, fitZoom))
      : (isMatchOver ? WINNER_CAMERA_ZOOM : SOLE_SURVIVOR_ZOOM));
  _framing.x = wantX; _framing.y = wantY; _framing.zoom = wantZoom; _framing.alive = alive;
  return _framing;
}

// Match-start snap: establish the FINAL gameplay framing synchronously — no
// timers, no lerp, no intro animation. Dynamic tracking continues normally
// afterwards (updateCamera eases from these correct values).
export function snapCameraToFit(fighters, canvasWidth, canvasHeight, stage) {
  let fr = null;
  try {
    fr = computeFraming(fighters, canvasWidth, canvasHeight, stage);
  } catch (_) { fr = null; }
  if (!fr) return false;
  cameraX = fr.x; cameraY = fr.y;
  targetX = fr.x; targetY = fr.y;
  trackZoom = fr.zoom; targetTrackZoom = fr.zoom;
  return true;
}

export function updateCamera(fighters, canvasWidth, canvasHeight, dt, stage, isMatchOver) {
  // Shake decay runs even for cutscenes (tiny, never constant).
  if (_shakeTime > 0) {
    _shakeTime -= dt;
    if (_shakeTime <= 0) { _shakeMag = 0; shakeOffsetX = 0; shakeOffsetY = 0; }
    else {
      const k = _shakeMag * (_shakeTime / _shakeDecay);
      shakeOffsetX = (Math.random() * 2 - 1) * k;
      shakeOffsetY = (Math.random() * 2 - 1) * k;
    }
  } else if (shakeOffsetX !== 0 || shakeOffsetY !== 0) {
    shakeOffsetX = 0; shakeOffsetY = 0;
  }

  if (cutsceneTarget) {
    targetX = cutsceneTarget.x;
    targetY = cutsceneTarget.y;
    targetTrackZoom = cutsceneTarget.zoom || 1;
    const followFactor = 0.5;
    cameraX += (targetX - cameraX) * followFactor * dt * 60;
    cameraY += (targetY - cameraY) * followFactor * dt * 60;
    trackZoom += (targetTrackZoom - trackZoom) * 0.06 * dt * 60;
    return;
  }

  // Framing geometry from the single shared helper (identical numbers the
  // snap uses at match start); only the EASING below is per-frame dynamic.
  let fr = null;
  try {
    fr = computeFraming(fighters, canvasWidth, canvasHeight, stage, isMatchOver);
  } catch (_) { fr = null; }
  if (!fr) return;

  // Deadzone: ignore tiny moves (avoids constant micro-jitter).
  let wantX = fr.x, wantY = fr.y;
  if (Math.abs(wantX - targetX) < CAM_DEADZONE) wantX = targetX;
  if (Math.abs(wantY - targetY) < CAM_DEADZONE) wantY = targetY;
  targetX = wantX; targetY = wantY;

  // Zoom eases toward the framing want in BOTH regimes: widening to
  // re-accommodate the pair, and onto WINNER_CAMERA_ZOOM once only the survivor
  // is left. The survivor case used to snap straight to 1, which both threw
  // away the framing want and read as a hard jump the instant the loser was
  // eliminated.
  //
  // The two directions get different rates. Widening is on a fast ramp because
  // it is what keeps a fighter who is being launched across the stage inside
  // the frame - at the old shared 0.35/sec the camera needed well over a second
  // to open up, so a hard side-special carried the player clean off screen
  // before the view had moved. Tightening keeps the old lazy rate, since
  // eagerly chasing a shrink is what makes a camera pump.
  // Hysteresis deadband: ignore framing wants inside ZOOM_DEADBAND so the
  // target never oscillates around a threshold (no zoom pumping).
  const _dz = fr.zoom - targetTrackZoom;
  const widening = _dz < -ZOOM_DEADBAND;
  if (_dz > -ZOOM_DEADBAND && _dz < ZOOM_DEADBAND) {
    // hold: inside the band the current target already frames the group.
  } else {
    const maxStep = (widening ? ZOOM_OUT_RATE : ZOOM_IN_RATE) * dt + 0.002;
    targetTrackZoom += Math.max(-maxStep, Math.min(maxStep, _dz));
  }

  // Smooth follow pan, capped per-frame (no snapping on launches) and eased at
  // CAMERA_SMOOTHING, so the handover from two-player to winner framing glides
  // onto the survivor instead of cutting.
  const f = Math.min(1, CAMERA_SMOOTHING * dt * 60);
  let nx = cameraX + (targetX - cameraX) * f;
  let ny = cameraY + (targetY - cameraY) * f;
  // sqrt, not Math.hypot: hypot's overflow-safe path costs several extra
  // comparisons per call, and this magnitude is only ever used as a ratio
  // against `cap`, so the cheap form is numerically identical here.
  const ddx = nx - cameraX, ddy = ny - cameraY;
  const step = Math.sqrt(ddx * ddx + ddy * ddy);
  const cap = MAX_PAN_PER_FRAME * dt * 60;
  if (step > cap && step > 0) {
    const k = cap / step;
    nx = cameraX + (nx - cameraX) * k;
    ny = cameraY + (ny - cameraY) * k;
  }
  // First frames: snap only when camera is uninitialized at origin.
  if (cameraX === 0 && cameraY === 0 && targetX !== 0) { cameraX = targetX; cameraY = targetY; }
  else { cameraX = nx; cameraY = ny; }

  // Zoom interpolation, still a ramp rather than a cut (no snapping) but fast
  // on the way out so the widened view actually lands while it is needed.
  const zSmooth = (targetTrackZoom < trackZoom) ? ZOOM_OUT_SMOOTHING : ZOOM_SMOOTHING;
  trackZoom += (targetTrackZoom - trackZoom) * Math.min(1, zSmooth * dt * 60);
}

export function getComposedZoom() {
  const engineZoom = getCameraZoom();
  const followMultiplier = followActive ? FOLLOW_ZOOM : 1;
  return engineZoom * baseZoom * matchZoom * trackZoom * followMultiplier;
}

export function applyCameraTransform(ctx, canvasWidth, canvasHeight, snapScale) {
  const camZoom = getComposedZoom();

  // Center on screen with camera pan and shake offset.
  //
  // snapScale (optional): quantize the pan offset to whole device pixels
  // (pass the backing-store scale). A fractional pan resamples the entire
  // world every frame, which reads as shimmer on sharp platform edges and
  // outlines during slow pans; snapping keeps static art rock-steady while
  // moving fighters still move smoothly underneath. Camera STATE
  // (cameraX/Y, probe output) is untouched — this is render-only.
  let offsetX = canvasWidth / 2 - cameraX * camZoom + shakeOffsetX;
  let offsetY = canvasHeight / 2 - cameraY * camZoom + shakeOffsetY;
  if (Number.isFinite(snapScale) && snapScale > 0) {
    const q = 1 / snapScale;
    offsetX = Math.round(offsetX / q) * q;
    offsetY = Math.round(offsetY / q) * q;
  }

  ctx.translate(offsetX, offsetY);
  ctx.scale(camZoom, camZoom);
}

export function setShakeOffset(x, y) {
  shakeOffsetX = x;
  shakeOffsetY = y;
}

export function getCameraState() {
  return {
    x: cameraX,
    y: cameraY,
    zoom: getComposedZoom(),
    targetX,
    targetY,
    targetZoom: targetTrackZoom,
    baseZoom,
    matchZoom,
    trackZoom,
  };
}

// Allocation-free read for the per-frame render path (Game.js
// updateViewBounds). Reuses one record; callers must read x/y/zoom
// synchronously and never retain the reference.
const _camState = { x: 0, y: 0, zoom: 1, targetX: 0, targetY: 0, targetZoom: 1, baseZoom: 1, matchZoom: 1, trackZoom: 1 };
export function getCameraStateInto(out) {
  const o = out || _camState;
  o.x = cameraX; o.y = cameraY; o.zoom = getComposedZoom();
  o.targetX = targetX; o.targetY = targetY; o.targetZoom = targetTrackZoom;
  o.baseZoom = baseZoom; o.matchZoom = matchZoom; o.trackZoom = trackZoom;
  return o;
}

// World → logical-screen conversion using the live camera (single source of
// truth with applyCameraTransform). Screen-space off-screen indicators reuse
// this so Canvas markers and world rendering can never disagree.
const _w2s = { x: 0, y: 0 };
export function worldToScreen(x, y, out, canvasWidth, canvasHeight) {
  const o = out || _w2s;
  try {
    const W = canvasWidth || VIEW_W, H = canvasHeight || VIEW_H;
    const z = getComposedZoom();
    o.x = W / 2 + (x - cameraX) * z + shakeOffsetX;
    o.y = H / 2 + (y - cameraY) * z + shakeOffsetY;
  } catch (_) {
    o.x = x; o.y = y;
  }
  return o;
}


// ── merged from core/viewport.js ──
// render.js — the single source of truth for the game's viewport.
//
// The game renders a fixed logical viewport of 1080 × 1080 (square, 1:1).
// Every world-space system (stage layout, camera framing, physics, HUD
// layout) works in these logical pixels, which never change. Sharpness on
// high-density displays comes from the BACKING store: the canvas holds
// VIEW_W × effective-DPR device pixels, and every render path draws
// through a DPR-scaled transform so one logical pixel lands on exact device
// pixels — no fractional resampling, no upscale blur. The effective DPR is
// display density times the adaptive render scale (full density by default,
// reduced only under sustained load).
//
// The displayed (CSS) size is a uniform square fit into the browser window,
// centred with letterboxing — the aspect ratio is never stretched. Input
// mapping uses the same logical size, so pointer coordinates stay accurate
// at any window size or zoom level.
//
// This module imports nothing, so Game.js, main.js and the sandbox modules
// can all share it without creating import cycles.

// ── Logical viewport (never changes at runtime) ──────────────────────────
export const VIEW_W = 1080;
export const VIEW_H = 1080;

// Cap on the backing-store multiplier. Real displays top out at 3x, but past
// 2x the extra pixels cost more raster time than the eye can resolve on a
// canvas game, so the backing is clamped — still tack-sharp, never wasteful.
export const MAX_DPR = 2;

// Adaptive render scale: a lightweight multiplier (default 1) on the DPR
// above, driven by the adaptive quality tier (see Game.js). On sustained
// poor frame times the tier steps down and the backing store shrinks with it
// — the single biggest raster cost is the fullscreen backdrop fill, which
// scales directly with backing pixels — then steps back up when headroom
// returns. Tier changes are already hysteresis/cooldown-gated in physics.js
// (wide thresholds, minimum samples, 2.5s cooldown), so reallocations are
// rare by construction. Logical viewport and gameplay coordinates never see
// this: renderers derive their transform from the store itself.
let _renderScale = 1;
export const RENDER_SCALE_MIN = 0.5;
// 1.5 covers the 1440p pin (1440/1080) with headroom; the backing clamp below
// keeps pathological DPR × scale products inside a sane memory budget.
export const RENDER_SCALE_MAX = 1.5;
// Hard ceiling on either backing dimension (px). Bounds canvas memory (~26MB
// worst case) on exotic display/scale combinations; ordinary settings never
// come near it.
export const BACKING_MAX = 2560;
export function setRenderScale(s) {
  const v = Number.isFinite(s) ? Math.max(RENDER_SCALE_MIN, Math.min(RENDER_SCALE_MAX, s)) : 1;
  if (v === _renderScale) return false;
  _renderScale = v;
  return true;
}
export function getRenderScale() { return _renderScale; }

// The DPR the backing store should use right now: display density times the
// adaptive render scale. Floored so even the weakest tier keeps a usable
// image (540px across at the minimum — chunky but playable, never broken).
export function effectiveDpr() {
  return Math.max(0.5, deviceDpr() * _renderScale);
}

// The devicePixelRatio the backing store should use right now. Read live
// (not cached) so moving the window across monitors or changing browser zoom
// picks up the new density on the next frame.
export function deviceDpr() {
  try {
    const d = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
    if (!Number.isFinite(d) || d <= 0) return 1;
    return Math.max(1, Math.min(MAX_DPR, d));
  } catch (_) {
    return 1;
  }
}

// The scale currently baked into a canvas backing store, derived from the
// store itself rather than window.devicePixelRatio so renderers that only
// hold a ctx (sandbox session/editor) agree with whoever sized the canvas.
export function backingScaleFor(canvas, logicalW = VIEW_W) {
  try {
    if (!canvas || !logicalW) return 1;
    const s = canvas.width / logicalW;
    return Number.isFinite(s) && s > 0 ? s : 1;
  } catch (_) {
    return 1;
  }
}

// Ensure the canvas backing store matches VIEW × effective DPR. Resizing a
// canvas resets its 2D context state, so smoothing is (re-)applied here —
// callers can rely on high-quality smoothing without setting it per draw.
export function syncCanvasBacking(canvas) {
  const dpr = effectiveDpr();
  try {
    // One computation, one clamp — the resolution can never be multiplied
    // twice, and exotic products stop at BACKING_MAX instead of ballooning.
    const bw = Math.max(1, Math.min(BACKING_MAX, Math.round(VIEW_W * dpr)));
    const bh = Math.max(1, Math.min(BACKING_MAX, Math.round(VIEW_H * dpr)));
    if (canvas.width !== bw || canvas.height !== bh) {
      canvas.width = bw;
      canvas.height = bh;
    }
    const ctx = canvas.getContext('2d');
    if (ctx) {
      if (ctx.imageSmoothingEnabled !== true) ctx.imageSmoothingEnabled = true;
      if ('imageSmoothingQuality' in ctx && ctx.imageSmoothingQuality !== 'high') {
        ctx.imageSmoothingQuality = 'high';
      }
    }
  } catch (_) {}
  return dpr;
}

// Install the screen-space transform: logical 1080 coordinates map onto the
// full backing store. Call once at the top of a render pass (and after any
// raw setTransform(1,...) & restore imbalance); world code then draws in
// logical pixels and lands on exact device pixels.
export function applyScreenTransform(ctx, canvas) {
  const s = backingScaleFor(canvas);
  try {
    ctx.setTransform(s, 0, 0, s, 0, 0);
  } catch (_) {}
  return s;
}

// Fit the canvas element as a centred square in the browser window.
// Backing store follows DPR; CSS size follows the smaller window dimension —
// uniform scale, 1:1 preserved, letterbox handled by the page background.
export function fitCanvasElement(canvas) {
  try {
    const ww = (typeof window !== 'undefined' && window.innerWidth) || VIEW_W;
    const wh = (typeof window !== 'undefined' && window.innerHeight) || VIEW_H;
    const side = Math.max(1, Math.floor(Math.min(ww, wh)));
    canvas.style.width = side + 'px';
    canvas.style.height = side + 'px';
  } catch (_) {}
  return syncCanvasBacking(canvas);
}

// Client (pointer-event) position → logical viewport coordinates. Uses the
// element's on-screen rect, so CSS scaling, letterboxing and DPR all cancel
// out and the result is exact at any window size.
export function clientToLogical(canvas, clientX, clientY, logicalW = VIEW_W, logicalH = VIEW_H) {
  try {
    const r = canvas.getBoundingClientRect();
    const rw = r.width || 1;
    const rh = r.height || 1;
    return {
      x: (clientX - r.left) * (logicalW / rw),
      y: (clientY - r.top) * (logicalH / rh),
    };
  } catch (_) {
    return { x: 0, y: 0 };
  }
}


// ── merged from render/cinematic.js ──
// cinematic.js — Smash-style Special Zoom / Finish Zoom presentation layer.
//
// SCOPE: PRESENTATION ONLY. Nothing here changes damage, knockback, weight,
// angles, DI, gravity, hitstun, stocks or KO detection. It reads the live hit
// event (already resolved by combat.js), optionally moves the camera through
// the EXISTING cutscene hook (camera.js setCutsceneCamera), optionally slows
// the world through the EXISTING dilation envelope (worldFx triggerTimeDilation
// — only when no dilation is already running, so Deadeye is never clobbered),
// and paints world-space particles adapted from the GA/vfx reference files.
//
// Why a separate module instead of extending worldFx.js: worldFx is documented
// as the ABILITY layer and its general gameplay-event emitters were deliberately
// removed. This module owns the cinematic camera state, the final-hit
// prediction, and the four event VFX below — nothing else writes them.
//
// VFX sources (GA/vfx/*.html, kept as references, never loaded):
//   KOpillar.html      -> KO pillar (vertical beam + core + embers + ring)
//   runningvfx.html    -> covered by the existing footstep dust in Fighter.js
//                        (grounded + speed-gated + throttled trailing-foot
//                        puffs); no duplicate system is created here.
//   launchtrail.html   -> toony grey puffs shed behind a strongly launched fighter
//   Finalhitimpact.html-> shockwave ring + white star burst + debris particles
//
// TIMING: the cinematic's own age runs on REAL dt handed in by Game.update, so
// zoom/tint/particles progress even while the world is dilated.


// ── Tunables (single place; presentation only) ──────────────────────────
export const CINEMATIC_CONFIG = {
  specialZoom: 1.6,    // cutscene track-zoom for Special Zoom (cyan)
  specialDuration: 0.7,
  specialSlowmo: 0.45, // dilation factor while active (skipped if busy)
  finishZoom: 1.9,     // cutscene track-zoom for Finish Zoom (red)
  finishDuration: 1.1,
  finishSlowmo: 0.3,
  // Final-hit prediction: simulate the post-hit velocity this long, in 1/60
  // steps, and trigger only if the blast boundary is crossed. kb floor + last
  // stock + margin keep weak/ambiguous hits out.
  predictDuration: 1.2,
  predictStep: 1 / 60,
  predictMargin: 100,  // certain-KO only: must carry this far PAST the blast
  predictMinKb: 350,
  finishMinPercent: 100, // slow-mo finish needs the victim at 100%+ damage
  // Launch trail: only while tumbling this fast; one puff per spacing px.
  trailMinSpeed: 450,
  trailSpacing: 25,
  trailMax: 60,
  burstMax: 48,
};

const TAU = Math.PI * 2;

// ── Cinematic state (one coordinated controller; finish wins ties) ──────
let _active = null;   // { type:'special'|'finish', age, duration, x, y, zoom }
let _tintColor = null;
let _tintAlpha = 0;
// Pending hit recorded by combat.js; processed on the next updateCinematic so
// side effects (camera/dilation) only ever run in the main-match loop — the
// sandbox/training paths share launchFromHit but never call updateCinematic.
let _pending = null;

function _startCinematic(type, x, y, zoom, duration, slowmo, tint) {
  if (_active && _active.type === 'finish') return; // finish has priority
  _active = { type, age: 0, duration, x, y, zoom };
  _tintColor = tint;
  _tintAlpha = 0;
  try { setCutsceneCamera({ x, y, zoom }); } catch (_) {}
  // No slow-mo: cinematics are zoom + tint + VFX only. The shared dilation
  // envelope is left entirely to gameplay systems (Deadeye).
  void slowmo;
}

export function endCinematicCamera() {
  try { setCutsceneCamera(null); } catch (_) {}
  _active = null;
  _tintAlpha = 0;
}

// ── Event entry points (called from combat/Game, never allocate) ────────

// combat.js launchFromHit calls this AFTER velocities + hitstun are stamped.
// Everything needed for both decisions travels in the record; prediction runs
// later in updateCinematic where stage + match state are available.
export function notifyCinematicHit(record) {
  _pending = record;
}

// Game.js onBlastKO calls this with the victim's position BEFORE the reset.
// Ends any cinematic camera (winner framing takes over) and fires the pillar.
export function notifyCinematicKO(x, y) {
  endCinematicCamera();
  spawnKoPillar(x, y);
}

export function resetCinematic() {
  _pending = null;
  endCinematicCamera();
  _pillars.length = 0;
  _puffs.length = 0;
  _bursts.length = 0;
  for (const k in _trailLast) delete _trailLast[k];
  for (const k in _runAcc) delete _runAcc[k];
  for (const k in _stepAcc) delete _stepAcc[k];
}

// ── Final-hit prediction (pure-ish, touches nothing live) ───────────────
// Simulates the victim's post-hit motion with the game's own constants:
// launch-relief gravity while hitstun lasts, full gravity after, no air drag
// while tumbling (matches stepFighterPhysics), fall-speed cap. Answers only
// "would this cross a blast line within the window".
export function predictBlastCross(victim, stage, kb) {
  try {
    const cfg = CINEMATIC_CONFIG;
    if (!victim || !stage || !stage.blastZones) return false;
    if (!(kb >= cfg.predictMinKb)) return false;
    let px = victim.x, py = victim.y;
    let vx = victim.vx, vy = victim.vy;
    const gravMul = victim.gravityMul || 1;
    const fallCap = MAX_FALL_SPEED * (victim.fallMaxMul || 1);
    let stun = Math.max(0, victim.hitstun || 0);
    let tumble = Math.max(0, victim.launchTimer || 0);
    const bz = stage.blastZones;
    const m = cfg.predictMargin;
    const dt = cfg.predictStep;
    let t = 0;
    while (t < cfg.predictDuration) {
      const g = GRAVITY * gravMul * (stun > 0 ? LAUNCH_GRAVITY_MUL : 1);
      vy += g * dt;
      if (vy > fallCap) vy = fallCap;
      if (!(stun > 0 || tumble > 0)) vx *= Math.pow(0.94, dt * 60);
      px += vx * dt;
      py += vy * dt;
      stun -= dt;
      tumble -= dt;
      if (px < bz.left - m || px > bz.right + m ||
          py < bz.top - m || py > bz.bottom + m) return true;
      t += dt;
    }
    return false;
  } catch (_) {
    return false;
  }
}

// ── Per-frame update (Game.update playing path, REAL dt) ────────────────
const _trailLast = {}; // fighterId -> {x, y}

export function updateCinematic(dt, fighters, stage, matchCtx) {
  if (dt <= 0) return;
  // 1. Resolve the pending hit, if any.
  const hit = _pending;
  _pending = null;
  if (hit && fighters && !matchCtx?.matchOver) {
    try {
      const def = hit.def || {};
      // Finish Zoom: last stock + victim at 100%+ + strong launch + predicted
      // blast cross. Uses the combat system's own kb/velocity — never
      // recomputed here.
      const lastStock = (hit.targetStocks ?? 1) <= 1;
      const highPercent = (hit.target ? hit.target.percent || 0 : 0) >=
        CINEMATIC_CONFIG.finishMinPercent;
      if (lastStock && highPercent && predictBlastCross(hit.target, stage, hit.kb)) {
        const fx = (hit.x + hit.attacker.x + hit.target.x) / 3;
        const fy = (hit.y + hit.attacker.y + hit.target.y) / 3;
        _startCinematic('finish', fx, fy,
          CINEMATIC_CONFIG.finishZoom, CINEMATIC_CONFIG.finishDuration,
          CINEMATIC_CONFIG.finishSlowmo, '255,60,60');
        spawnFinalBurst(hit.x, hit.y, hit.kb);
      } else {
        // Special Zoom: move-opt-in only (def.specialZoom), clean hit, charge gate.
        const sz = def.specialZoom;
        if (sz && !hit.shielded && (hit.kb || 0) > 0 && (hit.targetHitstun || 0) > 0) {
          const o = sz === true ? {} : sz;
          const minCharge = o.minCharge == null ? 1.0 : o.minCharge;
          if ((hit.chargeMult || 1) >= minCharge) {
            const fx = (hit.x + hit.attacker.x + hit.target.x) / 3;
            const fy = (hit.y + hit.attacker.y + hit.target.y) / 3;
            // Zoom + tint only — slow-mo is reserved for certain-KO finishes.
            _startCinematic('special', fx, fy,
              o.zoomStrength || CINEMATIC_CONFIG.specialZoom,
              o.zoomDuration || CINEMATIC_CONFIG.specialDuration,
              1,
              '80,200,255');
          }
        }
      }
    } catch (_) {}
  }
  // 2. Advance the active cinematic (real time — progresses under slow-mo).
  if (_active) {
    _active.age += dt;
    const p = _active.age / _active.duration;
    _tintAlpha = p < 0.15 ? p / 0.15 : Math.max(0, 1 - (p - 0.15) / 0.85);
    if (p >= 1) endCinematicCamera();
  } else if (_tintAlpha !== 0) {
    _tintAlpha = 0;
  }
  // 3. Launch trails (launchtrail.html) + run dust (runningvfx.html).
  if (fighters) {
    const cfg = CINEMATIC_CONFIG;
    for (let i = 0; i < fighters.length; i++) {
      const f = fighters[i];
      if (!f || f.state === 'dead') continue;
      _updateRunDust(f, dt);
      if ((f.launchTimer || 0) <= 0) continue;
      const sp = Math.sqrt(f.vx * f.vx + f.vy * f.vy);
      const id = f.id || ('p' + f.playerNum);
      if (sp < cfg.trailMinSpeed) { delete _trailLast[id]; continue; }
      const last = _trailLast[id];
      if (!last) {
        _trailLast[id] = { x: f.x, y: f.y };
        spawnTrailPuff(f);
        continue;
      }
      const dx = f.x - last.x, dy = f.y - last.y;
      if (dx * dx + dy * dy >= cfg.trailSpacing * cfg.trailSpacing) {
        last.x = f.x;
        last.y = f.y;
        spawnTrailPuff(f);
      }
    }
  }
  // 4. Age particles.
  _agePillars(dt);
  _agePuffs(dt);
  _ageBursts(dt);
}

// ── KO pillar (KOpillar.html: beam + white core + embers + ring) ─────────
const _pillars = []; // {x, y, age, life}
const PILLAR_LIFE = 0.9;

export function spawnKoPillar(x, y) {
  if (_pillars.length >= 2) _pillars.shift();
  _pillars.push({ x, y, age: 0, life: PILLAR_LIFE, seed: Math.random() * 10 });
  // Ground ring at the KO point (Finalhit-style shockwave, warm red).
  _spawnRing(x, y, 36, 330, 0.5, '255,120,70');
  // Ember burst (pillar ignition).
  for (let i = 0; i < 20; i++) _spawnPuff(
    x + (Math.random() - 0.5) * 180, y + Math.random() * 60,
    (Math.random() - 0.5) * 160, -200 - Math.random() * 320,
    4 + Math.random() * 5, 0.6 + Math.random() * 0.35,
    Math.random() < 0.5 ? '255,200,120' : '255,120,70', false, 1);
}

function _agePillars(dt) {
  for (let i = _pillars.length - 1; i >= 0; i--) {
    _pillars[i].age += dt;
    if (_pillars[i].age >= _pillars[i].life) {
      _pillars.splice(i, 1);
    }
  }
}

// ── Launch-trail + ember puffs (launchtrail.html: grey, dark outline) ────
const _puffs = []; // {x,y,vx,vy,r,life,maxLife,color,outline}

function _spawnPuff(x, y, vx, vy, r, life, color, outline, alpha) {
  if (_puffs.length >= CINEMATIC_CONFIG.trailMax + 40) _puffs.shift();
  _puffs.push({ x, y, vx, vy, r, life, maxLife: life, color,
    outline: outline !== false, a: alpha == null ? 1 : alpha });
}

function spawnTrailPuff(f) {
  const sp = Math.sqrt(f.vx * f.vx + f.vy * f.vy) || 1;
  const bx = f.x - (f.vx / sp) * (f.radius || 22);
  const by = f.y - (f.vy / sp) * (f.radius || 22);
  // Small and faint: launch trail reads as motion, never a smokescreen.
  _spawnPuff(bx + (Math.random() - 0.5) * 8, by + (Math.random() - 0.5) * 8,
    -f.vx * 0.06, -f.vy * 0.06,
    7 + Math.random() * 5, 0.35 + Math.random() * 0.15, '176,176,176', true, 0.5);
}

// Run dust (runningvfx.html): follows a grounded, moving fighter at ANY pace
// — walking included. One small soft puff at the trailing foot ~11x/second.
const _runAcc = {}; // fighterId -> accumulator
const _stepAcc = {}; // fighterId -> stride counter for footstep audio
function _updateRunDust(f, dt) {
  const id = f.id || ('p' + f.playerNum);
  const moving = f.grounded && !f.attack && (f.hitstun || 0) <= 0 &&
    f.state !== 'dead' && Math.abs(f.vx) > 12;
  if (!moving) { delete _runAcc[id]; return; }
  const acc = (_runAcc[id] || 0) + dt;
  if (acc < 0.14) { _runAcc[id] = acc; return; }
  _runAcc[id] = 0;
  // Footsteps: one walking.mp3 stride roughly every other puff.
  const step = (_stepAcc[id] || 0) + 1;
  if (step >= 2) {
    _stepAcc[id] = 0;
    try { SFX.walking(); } catch (_) {}
  } else {
    _stepAcc[id] = step;
  }
  const back = (f.vx > 0 ? -1 : 1) * (f.radius || 22) * 0.5;
  _spawnPuff(f.x + back + (Math.random() - 0.5) * 8, f.y + (f.radius || 22) * 0.7,
    -f.vx * 0.15 + (Math.random() - 0.5) * 20, -25 - Math.random() * 30,
    5 + Math.random() * 3, 0.32, '200,200,200', false, 0.24);
}

function _agePuffs(dt) {
  for (let i = _puffs.length - 1; i >= 0; i--) {
    const p = _puffs[i];
    p.life -= dt;
    if (p.life <= 0) { _puffs.splice(i, 1); continue; }
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.r = Math.max(0.1, p.r - dt * 22);
  }
}

// ── Final-impact bursts (Finalhitimpact.html: ring + star + debris) ──────
const _bursts = []; // {kind:'ring'|'star'|'bit', ...}

function _spawnRing(x, y, r0, growth, life, color) {
  if (_bursts.length >= CINEMATIC_CONFIG.burstMax) _bursts.shift();
  _bursts.push({ kind: 'ring', x, y, r: r0, growth, life, maxLife: life, color });
}

export function spawnFinalBurst(x, y, kb) {
  const scale = Math.max(0.8, Math.min(1.4, (kb || 500) / 600));
  _spawnRing(x, y, 10 * scale, 95 * scale, 0.35, '255,70,60');
  _spawnRing(x, y, 6 * scale, 60 * scale, 0.28, '17,17,17');
  if (_bursts.length < CINEMATIC_CONFIG.burstMax) {
    _bursts.push({ kind: 'star', x, y, life: 0.25, maxLife: 0.25, size: 30 * scale });
  }
  const n = 20;
  for (let i = 0; i < n; i++) {
    if (_bursts.length >= CINEMATIC_CONFIG.burstMax) break;
    const a = Math.random() * TAU;
    const sp = (180 + Math.random() * 420) * scale;
    _bursts.push({
      kind: 'bit', x, y,
      vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
      r: 9 + Math.random() * 9, life: 0.4 + Math.random() * 0.25,
      maxLife: 0.6,
      color: Math.random() < 0.55 ? '176,176,176'
        : (Math.random() < 0.5 ? '255,90,70' : '255,220,150'),
    });
  }
}

function _ageBursts(dt) {
  for (let i = _bursts.length - 1; i >= 0; i--) {
    const b = _bursts[i];
    b.life -= dt;
    if (b.life <= 0) { _bursts.splice(i, 1); continue; }
    if (b.kind === 'ring') {
      b.r += b.growth * dt * 2.2;
    } else if (b.kind === 'bit') {
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      b.vx *= 0.92;
      b.vy *= 0.92;
      b.r = Math.max(0.1, b.r - dt * 26);
    }
  }
}

// ── World-space draw (inside the camera transform, after worldFx) ────────
export function drawCinematicWorld(ctx) {
  // KO pillars: additive beam streaks + white core over a fixed height.
  for (let i = 0; i < _pillars.length; i++) {
    const pl = _pillars[i];
    const p = pl.age / pl.life;
    if (p < 0 || p >= 1) continue;
    const alpha = p < 0.12 ? p / 0.12 : Math.pow(1 - (p - 0.12) / 0.88, 1.3);
    const top = pl.y - 850, base = pl.y + 40;
    const w = 192;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    // Haze + colored streaks (warm KO theme).
    for (let s = 0; s < 6; s++) {
      const off = Math.sin(pl.seed + s * 2.4) * w * 0.45;
      const flick = 0.6 + 0.4 * Math.sin(pl.seed * 3 + s + pl.age * 9);
      ctx.fillStyle = `rgba(255,${s % 2 ? 120 : 170},70,${(0.28 * flick * alpha).toFixed(3)})`;
      const bw = w * (0.1 + 0.06 * ((s * 7) % 3));
      ctx.fillRect(pl.x + off - bw / 2, top, bw, base - top);
    }
    // White core.
    ctx.fillStyle = `rgba(255,255,255,${(0.8 * alpha).toFixed(3)})`;
    ctx.fillRect(pl.x - w * 0.12, top, w * 0.24, base - top);
    ctx.restore();
  }
  // Toony trail puffs: grey fill + crisp dark outline (no additive).
  for (let i = 0; i < _puffs.length; i++) {
    const p = _puffs[i];
    const t = p.life / p.maxLife;
    ctx.save();
    ctx.globalAlpha = Math.min(p.a == null ? 1 : p.a, t * 1.6);
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.r, 0, TAU);
    ctx.fillStyle = `rgb(${p.color})`;
    ctx.fill();
    if (p.outline) {
      ctx.lineWidth = 3;
      ctx.strokeStyle = '#111111';
      ctx.stroke();
    }
    ctx.restore();
  }
  // Final bursts: rings, white star, debris bits.
  for (let i = 0; i < _bursts.length; i++) {
    const b = _bursts[i];
    const t = b.life / b.maxLife;
    if (b.kind === 'ring') {
      ctx.save();
      ctx.globalAlpha = Math.max(0, t);
      ctx.beginPath();
      ctx.arc(b.x, b.y, b.r, 0, TAU);
      ctx.lineWidth = 6;
      ctx.strokeStyle = `rgb(${b.color})`;
      ctx.stroke();
      ctx.restore();
    } else if (b.kind === 'star') {
      ctx.save();
      ctx.translate(b.x, b.y);
      ctx.globalAlpha = Math.max(0, t);
      ctx.beginPath();
      for (let s = 0; s < 16; s++) {
        const r = (s % 2 === 0 ? b.size : b.size * 0.42) * t;
        const a = (s * Math.PI) / 8;
        const px = Math.cos(a) * r, py = Math.sin(a) * r;
        if (s === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.closePath();
      ctx.fillStyle = '#ffffff';
      ctx.fill();
      ctx.lineWidth = 4;
      ctx.strokeStyle = '#111111';
      ctx.stroke();
      ctx.restore();
    } else {
      ctx.save();
      ctx.globalAlpha = Math.min(1, t * 1.8);
      ctx.beginPath();
      ctx.arc(b.x, b.y, b.r, 0, TAU);
      ctx.fillStyle = `rgb(${b.color})`;
      ctx.fill();
      ctx.lineWidth = 3;
      ctx.strokeStyle = '#111111';
      ctx.stroke();
      ctx.restore();
    }
  }
  ctx.globalAlpha = 1;
}

// ── Screen-space tint (after camera restore, beside the orange overlay) ──
export function cinematicTint() {
  if (!_tintColor || _tintAlpha <= 0.004) return null;
  return { color: _tintColor, alpha: Math.min(0.22, _tintAlpha * 0.22) };
}


// ── merged from render/Effects.js ──
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


// Idle-stance defaults are read from the rfidle/lfidle library animations
// (the animation library lives in anim.js — no cycle back here).


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
  if (typeof saved.handColor === 'string') { handConfig.handColor = saved.handColor; _invalidateHandColors(); }
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
  _invalidateHandColors();
}

export function clampHandValue(value) {
  const clamped = Math.min(2, Math.max(-2, value));
  return Math.round(clamped * 100) / 100;
}

// ── Per-character hand colors ────────────────────────────────────────────
// A hand color can be pinned per fighter id (hexcode or any CSS color name).
// Resolution order: character override → global HAND COLOR setting → body color.
const CHAR_COLOR_KEY = 'smashfighters.charHandColors';
// Built-in defaults: ninja wears near-black gloves, boxer wears red gloves,
// knight wears steel gauntlets.
const DEFAULT_CHAR_HAND_COLORS = { ninja: '#0B0A0B', boxer: '#e53935', knight: '#9aa6b0' };
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
  _invalidateHandColors();
  persistCharHandColors();
}

export function clearCharHandColor(id) {
  if (!id) return;
  delete charHandColors[id];
  _invalidateHandColors();
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
//
// Cached by (fighterId, bodyColor) behind a version counter. The inputs only
// change when a player edits a colour in the menus, but the old code ran the
// whole resolution — two string allocations from .trim(), a regex test and two
// Map lookups — for every fighter on every single frame, then threw the result
// away. Any mutation of the underlying sources bumps the version, which
// invalidates the whole cache.
let _handColorVersion = 0;
const _handColorCache = new Map();
function _invalidateHandColors() { _handColorVersion++; }
export function resolveHandColor(fighterId, bodyColor) {
  const ck = (fighterId || '') + '\u0000' + (bodyColor || '');
  const c = _handColorCache.get(ck);
  if (c !== undefined && c.v === _handColorVersion) return c.color;
  const perChar = charHandColorFor(fighterId);
  let color;
  if (perChar) color = perChar;
  else if (fighterId === 'ninja' && DEFAULT_CHAR_HAND_COLORS.ninja) color = DEFAULT_CHAR_HAND_COLORS.ninja;
  else {
    const g = handConfig && handConfig.handColor;
    color = (typeof g === 'string' && g !== 'auto' && isValidColor(g)) ? g : bodyColor;
  }
  if (_handColorCache.size > 64) _handColorCache.clear();
  _handColorCache.set(ck, { v: _handColorVersion, color });
  return color;
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

// Per-fighter ANATOMICAL hand world positions (left/right — the hands
// themselves, never the screen roles). Written every draw by both the legacy
// and animator paths; read by the ` hitbox-debug hand labels and the ?probe
// hands() snapshot. One reusable record, never reallocated.
function _handWorldOf(fighter) {
  let hw = fighter._handWorld;
  if (!hw) hw = fighter._handWorld = { left: { x: 0, y: 0 }, right: { x: 0, y: 0 } };
  return hw;
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

// Cached ground-shadow ellipse. Identical for every fighter of a given radius,
// yet it was an ellipse path + fill per fighter per frame. Baking it turns
// three ops into one drawImage.
let _shadowSpr = null;
let _shadowSprR = -1;
function _shadowSprite(radius) {
  if (_shadowSpr && _shadowSprR === radius) return _shadowSpr;
  const rw = Math.max(1, Math.ceil(radius * 0.8));
  const rh = Math.max(1, Math.ceil(radius * 0.3));
  const pad = 2;
  const c = document.createElement('canvas');
  c.width = rw * 2 + pad * 2;
  c.height = rh * 2 + pad * 2;
  const m = c.getContext('2d');
  m.fillStyle = 'rgba(0,0,0,0.2)';
  m.beginPath();
  m.ellipse(c.width / 2, c.height / 2, rw, rh, 0, 0, Math.PI * 2);
  m.fill();
  _shadowSpr = c;
  _shadowSprR = radius;
  return c;
}

function directionalShadow(ctx, x, y, radius) {
  const spr = _shadowSprite(radius);
  if (spr) {
    ctx.drawImage(spr, Math.round(x - spr.width / 2), Math.round(y + radius + 2 - spr.height / 2));
    return;
  }
  ctx.fillStyle = 'rgba(0,0,0,0.2)';
  ctx.beginPath();
  ctx.ellipse(x, y + radius + 2, radius * 0.8, radius * 0.3, 0, 0, Math.PI * 2);
  ctx.fill();
}

// Shared "no skin" record. lookUpSkin runs for every fighter every frame, and
// a fighter with no skin configured used to allocate a fresh
// `{ loaded: false, img: null }` on each of those calls. It is read-only.
const NO_SKIN = { loaded: false, img: null };

function lookUpSkin(skin) {
  if (!skin) return NO_SKIN;
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

// Pre-rasterize the per-fighter sprites (clipped body, gear, accessories) so
// their first appearance in a match is already a plain blit. Called at the
// ready -> playing transition; see Game.js `_warmRenderCaches`.
export function warmFighterSprites() {
  try {
    for (const g of HAND_GEAR) if (g && g.draw) warmOne(g.draw);
    for (const a of ACCESSORIES) if (a && a.draw) warmOne(a.draw);
  } catch (_) {}
  try {
    // Body sprites are keyed on the skin image, so they can only be baked once
    // the image itself has decoded. This covers the common (skinless) case,
    // where drawBody takes the cheap flat-fill path and needs no sprite.
    _shadowSprite(30);
  } catch (_) {}
}
function warmOne(drawFn) {
  try {
    const c = document.createElement('canvas');
    c.width = c.height = 8;
    c.getContext('2d');
    bakedUnitSprite(drawFn);
  } catch (_) {}
}

// Cached clipped-skin body sprite.
//
// The original path built a circular clip and drew the skin image through it,
// for every fighter, every frame. `clip()` is one of the most expensive
// operations in Canvas2D: it pushes the renderer onto a masked raster path (and
// on many backends a separate compositing layer) for everything drawn until the
// matching restore. The skin image, the fighter's radius, the scale and the
// centre offset are all static for a given fighter, so the clipped result is
// baked once and blitted thereafter — one drawImage, no clip, no mask.
//
// GEOMETRY (the subtle part). The visible result is a circle of diameter
// 2*radius, with the skin drawn INSIDE it scaled to fit `size = 2*radius*ss`.
// Those two are NOT the same number: with the default skinScale of 0.85 the
// image is smaller than the circle, so the circle's own edge is what shows
// around the art. The sprite therefore has to be sized and blitted to the
// CIRCLE's bounding box (2*radius), not to the image size. Blitting to the
// image size instead crops the sprite to 85% of the fighter and drops ~70% of
// the skin's visible pixels.
//
// BODY_SS supersamples the bake so the downscaled blit stays sharp when the
// camera zooms in. 1.4x is deliberate: a downscaling blit samples the whole
// source, so a much larger sprite costs real fill rate for no visible gain.
const BODY_SS = 4.0;
const _bodySprites = new Map();
function _bodySprite(img, radius, ss, ccx, ccy) {
  const imgSrc = (img && img.src) || img;
  const key = imgSrc + '|' + radius + '|' + ss + '|' + ccx + '|' + ccy;
  let e = _bodySprites.get(key);
  if (e && e.img === img) return e.canvas;
  // Sprite covers the clip circle's bounding box, not the image's.
  const px = Math.max(2, Math.ceil(radius * 2 * BODY_SS));
  const c = document.createElement('canvas');
  c.width = px;
  c.height = px;
  const m = c.getContext('2d');
  m.imageSmoothingEnabled = true;
  m.imageSmoothingQuality = 'high';
  m.beginPath();
  m.arc(px / 2, px / 2, radius * BODY_SS, 0, Math.PI * 2);
  m.clip();
  // The image, positioned exactly as the live path did: centred on the circle,
  // offset by the skin centre, scaled so its SHORTER side is `size` long.
  const size = radius * 2 * ss;
  const scale = size / Math.min(img.width, img.height);
  const drawW = img.width * scale;
  const drawH = img.height * scale;
  m.drawImage(
    img,
    px / 2 + (ccx * scale - drawW / 2) * BODY_SS,
    px / 2 + (ccy * scale - drawH / 2) * BODY_SS,
    drawW * BODY_SS,
    drawH * BODY_SS,
  );
  if (_bodySprites.size >= 32) _bodySprites.delete(_bodySprites.keys().next().value);
  _bodySprites.set(key, { img, canvas: c });
  return c;
}

function drawBody(ctx, fighter, skin, vr) {
  // Rendered body radius: the skin metadata's size multiplier applied to the
  // physics radius (see SKIN_META). Combat never sees this value.
  const radius = (typeof vr === 'number' && vr > 0) ? vr : ((fighter.radius) || 31);
  const { x, y, color } = fighter;
  const meta = resolveSkinMeta(fighter._fighterDef);
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
  if (skin && skin.img) {
    const ss = (meta.skinScale != null ? meta.skinScale : (fighter.skinScale || 1));
    const ccx = (meta.skinCenterX != null ? meta.skinCenterX : (fighter.skinCenter ? fighter.skinCenter.x : 0));
    const ccy = (meta.skinCenterY != null ? meta.skinCenterY : (fighter.skinCenter ? fighter.skinCenter.y : 0));
    const spr = _bodySprite(skin.img, radius, ss, ccx, ccy);
    // Blit to the clip CIRCLE's bounding box, not the image size — the circle
    // is what the outline below strokes, so the two must match exactly.
    const d = radius * 2;
    const prevQuality = ctx.imageSmoothingQuality;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(spr, x - radius, y - radius, d, d);
    if (prevQuality) ctx.imageSmoothingQuality = prevQuality;
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

// Reused draw-def for animated hand weapons. drawWeapon reads color/accent off
// the def, so the old inline `{ color: st.def.color, accent: st.def.accent }`
// allocated a fresh object for every animated weapon on every frame (up to 8
// per frame across four fighters). One shared record, written then drawn
// synchronously.
const _animWeaponDef = { color: null, accent: null };

function drawAnimatedWeapon(ctx, st) {
  ctx.save();
  ctx.globalAlpha = st.opacity ?? 1;
  ctx.translate(st.px, st.py);
  ctx.rotate(((st.rot || 0) * _DEG_TO_RAD));
  ctx.scale(st.scaleX || 1, st.scaleY || 1);
  _animWeaponDef.color = st.def.color;
  _animWeaponDef.accent = st.def.accent;
  // Sprite weapons blit pre-smoothed baked bitmaps; only touch the quality
  // flag when it isn't already high — each set can flush the canvas pipeline.
  // (Procedural art is vector and unaffected.)
  const prevQ = ctx.imageSmoothingQuality;
  if (prevQ !== 'high') ctx.imageSmoothingQuality = 'high';
  drawWeapon(ctx, st.def, _animWeaponDef);
  if (prevQ && prevQ !== 'high') ctx.imageSmoothingQuality = prevQ;
  ctx.restore();
}

// ═══════════════════════════════════════════════════════════════════════
// UNIVERSAL PERSISTENT HELD WEAPONS
// ═══════════════════════════════════════════════════════════════════════
// Data-driven permanently-equipped handheld gear for ANY character — swords,
// shields, dual weapons, staves — drawn from the fighter definition, with no
// per-character attachment code. Character config (fighter def `heldWeapons`,
// an array; absent/empty = today's behavior exactly):
//
//   { weapon: 'sword',            // weapon registry id (weapons.js)
//     hand: 'lead',               // 'lead' | 'trail' | 'left' | 'right'
//     hands: undefined,           // or 'both' for two-handed (see below)
//     scale: 1,                   // weapon scale (fighter proportions untouched)
//     angle: -25,                 // rotation offset, degrees, canonical space
//     dx: 0.15, dy: -0.1,         // grip offset in radius units (dx mirrors)
//     mirror: true,               // mirror art + orientation with facing
//     layer: 'front' },           // 'front' (over body) | 'back' (behind body)
//
// Two-handed (staff/spear): { weapon: 'staff', hands: 'both', primary: 'lead',
// angle: 0, scale: 1, ... }. Position comes from the PRIMARY grip, orientation
// from the primary→secondary hand axis plus `angle`.
//
// Hand assignment: slots are BODY sides, shared with the animator (which
// mirrors them at runtime). 'lead' resolves to the rig's primary slot
// (default body-right) because the facing mirror carries it onto the facing
// side in BOTH facings — so a lead sword points at the opponent left and
// right with no per-facing config, and rapid turns can never strand a weapon
// on the wrong hand. 'trail' is the other slot; 'left'/'right' pin an
// anatomical hand (still mirrored visually). Rendering mirrors through the
// same facing convention as every other weapon; only the draw side flips,
// never the attachment.
//
// Where it draws: the legacy (non-animator) movement path only — idle, run,
// jump, fall, dodge, turn — at the SAME eased hand positions the hands use
// (bob, run-pump, air spread, dodge tuck included), so weapons track the
// hands with no frame-by-frame weapon animation. While a combat/shield/
// victory animation owns the hands, that animation's own weapon slots draw
// instead (same arms for the knight), so nothing ever double-draws and no
// combat timing, hitbox or parry behavior changes — this layer is visuals only
// and never creates hitboxes.
//
// Cost: one registry Map.get + a few multiplies per weapon per frame. No
// animation-library reads (a Map compare-free path), no listeners, no
// allocations (one shared draw state, two shared position scratch records).
// (Weapon defs resolve through the getWeapon import above.)

// One shared draw state (draw is synchronous) + two position scratch records
// (two-handed placement needs both grips alive at once).
const _heldSt = { def: null, px: 0, py: 0, rot: 0, scaleX: 1, scaleY: 1, opacity: 1 };
const _holdA = { x: 0, y: 0 };
const _holdB = { x: 0, y: 0 };
// Orbit scratch: per-anatomical-hand base pose plus fighter-relative
// equipment positions. Written every legacy frame and read synchronously
// inside the same draw pass — never retained, never allocated per frame.
const _orbR = { x: 0, y: 0, z: 0 };
const _orbL = { x: 0, y: 0, z: 0 };
const _orbHands = { left: { x: 0, y: 0 }, right: { x: 0, y: 0 } };

// (Side resolution lives in handRig.js resolveHoldSlot — single source.)

// Eased world position of an ANATOMICAL hand slot ('left' | 'right'). Reads the
// per-hand displayed offsets directly — never a screen-role record — so a facing
// turn can never map a weapon onto the wrong side.
function holdSlotPos(fighter, x, y, slot, out) {
  const h = (slot === 'right') ? fighter._handR : fighter._handL;
  if (!h) return null;
  out.x = x + h.x;
  out.y = y + h.y;
  return out;
}

const _DEG = Math.PI / 180;

// A hand gripping a configured held weapon shows the weapon, not fist gear:
// without this, a stored custom (sword on the fist) stacks with the gripped
// blade and both draw on the same hand. Resolution is shared with the held
// layer (lead/trail/body), so gear hides exactly where a weapon grips.
export function holdCoversSide(fighter, bodySide) {
  const cfg = resolveHeld(fighter && fighter._fighterDef);
  if (!cfg) return false;
  for (let i = 0; i < cfg.length; i++) {
    const e = cfg[i];
    if (!e) continue;
    if (e.hands === 'both') return true;
    if (resolveHoldSlot(e.hand, fighter) === bodySide) return true;
  }
  return false;
}

// Draw one layer ('front' or 'back') of a fighter's configured held weapons.
// `over` selects the fist relationship: false draws under the fist (grip
// hidden in the hand — the default), true draws over it (shield covering the
// gripping hand). Safe to call with any fighter: missing config, missing
// eased hands, or an unknown weapon id all skip silently with no state
// touched.
export function drawHeldLayer(ctx, fighter, x, y, layer, over = false, vr) {
  const def = fighter && fighter._fighterDef;
  const cfg = resolveHeld(def);
  if (!cfg || !cfg.length) return;
  const facingRight = !!fighter.facingRight;
  const dir = facingRight ? 1 : -1;
  // Rendered body radius (skin body-size multiplier included) — offsets and
  // weapon scale ride it so equipment stays glued to the visual body.
  const radius = (typeof vr === 'number' && vr > 0) ? vr : (fighter.radius || 31);
  const baseScale = radius / 31;
  const gs = resolveSkinMeta(def).gripScale || 1;
  for (let i = 0; i < cfg.length; i++) {
    const e = cfg[i];
    if (!e || (e.layer || 'front') !== layer) continue;
    // overHand defaults to TRUE: a weapon normally renders in front of the
    // fist. Set overHand:false to tuck one behind the fist instead.
    if ((e.overHand !== false) !== over) continue;
    let wdef = null;
    try { wdef = getWeapon(e.weapon); } catch (_) { wdef = null; }
    if (!wdef) continue;
    const S = baseScale * (typeof e.scale === 'number' ? e.scale : 1);
    if (!(S > 0)) continue;
    if (e.hands === 'both') {
      // Two-handed: primary grip positions, secondary aims.
      const ps = resolveHoldSlot(e.primary || 'lead', fighter);
      const ss = otherBodySide(ps);
      if (!holdSlotPos(fighter, x, y, ps, _holdA)) continue;
      if (!holdSlotPos(fighter, x, y, ss, _holdB)) continue;
      const ox = (e.dx || 0) * radius * gs, oy = (e.dy || 0) * radius * gs;
      _heldSt.def = wdef;
      _heldSt.px = _holdA.x + dir * ox;
      _heldSt.py = _holdA.y + oy;
      _heldSt.rot = Math.atan2(_holdB.y - _holdA.y, _holdB.x - _holdA.x) / _DEG + (e.angle || 0);
      _heldSt.scaleX = S;
      _heldSt.scaleY = S;
      _heldSt.opacity = 1;
      drawAnimatedWeapon(ctx, _heldSt);
      continue;
    }
    const slot = resolveHoldSlot(e.hand || 'right', fighter);
    if (!holdSlotPos(fighter, x, y, slot, _holdA)) continue;
    drawHeldOneHanded(ctx, fighter, e, i, wdef, _holdA.x, _holdA.y, dir, S, false, radius, gs);
  }
  _heldSt.def = null;
}

// Shared one-handed weapon draw core — the prototype's gripPose/drawW pair,
// 1:1. Seat a held entry at a resolved hand point (hx, hy, world space) with
// facing sign `dir`:
//     px = hx + dir*ox      (grip offset mirrored in x)
//     py = hy + oy          (y never mirrored)
//     rot = angle * dir     (angle negated on the mirrored side)
//     scaleX = dir * S      (sprite flipped in x)
// exactly the prototype's `x = h.x + ox*d, y = h.y + oy, rot = g.rot*d,
// flip = d`. `snap` selects the orbit-transition behavior — the snapped grip
// orientation stamped for a seamless rest handoff — instead of the continuous
// rest easing. Both paths draw identically at rest.
function drawHeldOneHanded(ctx, fighter, e, i, wdef, hx, hy, dir, S, snap, radiusIn, gsIn) {
  const mir = e.mirror !== false;
  const radius = (typeof radiusIn === 'number' && radiusIn > 0) ? radiusIn : (fighter.radius || 31);
  const gs = (typeof gsIn === 'number' && gsIn > 0) ? gsIn : 1;
  const ox = (e.dx || 0) * radius * gs, oy = (e.dy || 0) * radius * gs;
  const mdir = mir ? dir : 1;
  const target = heldTargetRot(e, dir);
  let rot;
  if (snap) {
    let hr = fighter._heldRot;
    if (!hr) hr = fighter._heldRot = {};
    hr[i] = target;
    rot = target;
  } else {
    rot = heldRot(fighter, i, target);
  }
  _heldSt.def = wdef;
  _heldSt.px = hx + mdir * ox;
  _heldSt.py = hy + oy;
  _heldSt.rot = rot;
  _heldSt.scaleX = mdir * S;
  _heldSt.scaleY = S;
  _heldSt.opacity = 1;
  drawAnimatedWeapon(ctx, _heldSt);
}

// Orbit-transition weapon pass: each entry rides its anatomical hand's orbit
// position with snap-based grip orientation, preserving the under/over fist
// relationship inside its depth group. Runs only while the orbit travels;
// at rest the configured drawHeldLayer sequence above runs unchanged.
function drawOrbitEntries(ctx, fighter, x, y, side, hands, gripDir, over, vr) {
  const def = fighter && fighter._fighterDef;
  const cfg = resolveHeld(def);
  if (!cfg || !cfg.length) return;
  const radius = (typeof vr === 'number' && vr > 0) ? vr : (fighter.radius || 31);
  const baseScale = radius / 31;
  const gs = resolveSkinMeta(def).gripScale || 1;
  for (let i = 0; i < cfg.length; i++) {
    const e = cfg[i];
    // overHand defaults to TRUE (weapon draws in front of the fist).
    if (!e || (e.overHand !== false) !== over) continue;
    let wdef = null;
    try { wdef = getWeapon(e.weapon); } catch (_) { wdef = null; }
    if (!wdef) continue;
    const S = baseScale * (typeof e.scale === 'number' ? e.scale : 1);
    if (!(S > 0)) continue;
    if (e.hands === 'both') {
      // Drawn once, with the primary hand's depth group; aims along the
      // primary→support hand axis so both grips stay glued to one weapon.
      const ps = resolveHoldSlot(e.primary || 'lead', fighter);
      if (ps !== side) continue;
      const ss = otherBodySide(ps);
      const pa = hands[ps], sa = hands[ss];
      if (!pa || !sa) continue;
      const ox = (e.dx || 0) * radius * gs, oy = (e.dy || 0) * radius * gs;
      _heldSt.def = wdef;
      _heldSt.px = x + pa.x + gripDir * ox;
      _heldSt.py = y + pa.y + oy;
      _heldSt.rot = Math.atan2(sa.y - pa.y, sa.x - pa.x) / _DEG + (e.angle || 0);
      _heldSt.scaleX = S;
      _heldSt.scaleY = S;
      _heldSt.opacity = 1;
      drawAnimatedWeapon(ctx, _heldSt);
      continue;
    }
    if (resolveHoldSlot(e.hand || 'right', fighter) !== side) continue;
    const hp = hands[side];
    if (!hp) continue;
    drawHeldOneHanded(ctx, fighter, e, i, wdef, x + hp.x, y + hp.y, gripDir, S, true, radius, gs);
  }
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

// Batched Deadeye trail renderer. Segments quantized into 4 alpha/width bands;
// one stroked multi-subpath per band. moveTo per segment keeps bullets and
// segments disconnected (no bridging lines). Width tapers with the band mean,
// alpha steps (0.075/0.225/0.375/0.525) approximate the linear fade — visually
// identical at trail lengths, 4 strokes max instead of N.
let _batchTrails = true;
export function setEffectBatch(on) { _batchTrails = on !== false; }
function _drawDeadeyeTrailBatched(ctx, b) {
  const trail = b.trail;
  const segs = trail.length - 1;
  const color = b.trailColor || '#ffd54f';
  const bs = b.bulletSize * 0.4;
  ctx.globalCompositeOperation = 'lighter';
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = color;
  if (segs <= 0) { ctx.globalCompositeOperation = 'source-over'; return; }
  // 4 bands over t in [0,1): band k holds the segment indices in
  // [k*segs/4, (k+1)*segs/4). The old form walked the WHOLE trail once per
  // band and discarded 3 of every 4 segments, so N segments cost 4N iterations
  // (plus a divide and a compare each). Each band is a contiguous index range,
  // so iterating just that range visits every segment exactly once overall,
  // landing each in precisely the band it had before.
  for (let band = 0; band < 4; band++) {
    const tMid = (band + 0.5) / 4;
    ctx.globalAlpha = tMid * 0.6;
    ctx.lineWidth = Math.max(0.5, (1 - tMid) * bs);
    // ceil (not floor) on the low edge: segment i belongs to band b exactly
    // when b*segs/4 <= i < (b+1)*segs/4, and a floor would duplicate the
    // boundary segment into two bands.
    const lo = Math.ceil(band * segs / 4);
    const hi = Math.min(segs, Math.ceil((band + 1) * segs / 4));
    if (hi <= lo) continue;
    ctx.beginPath();
    for (let i = lo; i < hi; i++) {
      const p1 = trail[i];
      const p2 = trail[i + 1];
      ctx.moveTo(p1.x, p1.y);
      ctx.lineTo(p2.x, p2.y);
    }
    ctx.stroke();
  }
  ctx.globalCompositeOperation = 'source-over';
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
function drawAnimatedLayer(ctx, items, behind, handR, handFill, handGear, fighter) {
  for (const it of items) {
    const isBehind = (it.z || 0) < 0;
    if (isBehind !== behind) continue;
    // Fist gear hides where a held weapon grips (same rule as the legacy
    // path) — the animation's own weapon slots are unaffected.
    if (it.type === 'hand') {
      const g = handGear && handGear[it._gearSide];
      drawAnimatedHand(ctx, it, handR, handFill,
        (g && fighter && !holdCoversSide(fighter, it._gearSide)) ? g : null);
    }
    else drawAnimatedWeapon(ctx, it);
  }
}

function _drawHandState(ctx, st, handR, handFill, gear, mirrorFacing) {
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
  // mirrorFacing flips the art when the fighter faces left — gear authored
  // facing-right (like every weapon) mirrors with the body, XOR'd with the
  // gear's own FLIP setting inside drawHandGear.
  if (gear) {
    const sx = st.sx ?? 1, sy = st.sy ?? 1;
    ctx.translate(st.px, st.py);
    ctx.rotate((st.rot ?? 0) * _DEG_TO_RAD);
    drawHandGear(ctx, 0, 0, handR * ((Math.abs(sx) + Math.abs(sy)) * 0.5), gear, (sx < 0) !== !!mirrorFacing);
  }
  ctx.restore();
}

// Front-layer accessory (hats & co.): above the body, below the hands, so
// fists and hand gear always read in front of it. 'behind'-layer accessories
// draw earlier, underneath the body.
function drawFrontAccessory(ctx, fighter, x, y, radius) {
  if (fighter.accessory && fighter.accessory.type && fighter.accessory.layer !== 'behind') {
    drawAccessory(ctx, x, y, radius, fighter.accessory);
  }
}

// Draw a fighter: body circle (skin image or flat color), resting hands tuned
// by the neutral hand pose, cosmetic accessories, and movement-state markers.
export function drawFighter(ctx, fighter, time) {
  if (fighter.state === 'dead') return;
  // Whole-fighter cull (margin: hands/weapons/shadow/arrow reach).
  if (!_inView(fighter.x, fighter.y, 160)) return;

  const { x, y, color, skin } = fighter;
  // Skin/body metadata: the one record the body, hands and equipment all size
  // from. `vradius` is the RENDERED body radius (physics radius × the skin's
  // body-size multiplier); combat still reads fighter.radius untouched.
  const meta = resolveSkinMeta(fighter._fighterDef);
  const orbitRig = resolveOrbitRig(fighter._fighterDef);
  const vradius = visualRadius(fighter, meta);

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
  if (fighter.grounded) directionalShadow(ctx, x, y, vradius);

  // Behind-the-player accessories (hides behind the body).
  if (fighter.accessory && fighter.accessory.type && fighter.accessory.layer === 'behind') {
    drawAccessory(ctx, x, y, vradius, fighter.accessory);
  }

  // Look up live skin status from the cache (skin.path is set by resolveSkin)
  const skinLive = lookUpSkin(skin);

  // ── Body + hands/layers ────────────────────────────────────────────────
  const handR = vradius * (typeof meta.handRadius === 'number' ? meta.handRadius : ORBIT.handRadius);
  const handFill = resolveHandColor(fighter._fighterDef ? fighter._fighterDef.id : fighter.id, color);
  // Cosmetic gear worn on the hands — drawn by the hand passes below, in the
  // hand's own transform, so it inherits the pose and z-order for free.
  const handGear = fighter.handGear || null;
  // Which ARM is which is resolved per path below from anatomical sides: the
  // legacy orbit assigns screen roles ('front' / 'back') by depth each frame,
  // while the animator path carries real `hands.left` / `hands.right` slots.
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
    // Animation is authoritative: hands, weapons and their depth come straight
    // from the animator, exactly as before. The procedural orbit is not applied.
    const items = collectAnimatedItems(fighter);
    // Publish anatomical hand positions for the debug overlay / probe.
    const oh = fighter.anim.out.hands;
    const hwA = _handWorldOf(fighter);
    if (oh.left) { hwA.left.x = oh.left.px; hwA.left.y = oh.left.py; }
    if (oh.right) { hwA.right.x = oh.right.px; hwA.right.y = oh.right.py; }
    drawAnimatedLayer(ctx, items, true, handR, handFill, handGear, fighter);
    drawBody(ctx, fighter, skinLive, vradius);
    // Front-layer accessories sit above the body but below the hands: hats
    // stay on the head while fists, gloves, swords and shields (drawn with
    // their hand) always read in front of them.
    drawFrontAccessory(ctx, fighter, x, y, vradius);
    drawAnimatedLayer(ctx, items, false, handR, handFill, handGear, fighter);
  } else {
    // Orbit base per anatomical hand (fighter-relative, radius units). The
    // shared orbit angle already encodes facing — +x is screen-right in both
    // facings — so no mirror sign is applied here, exactly like the
    // prototype's handAt(). The two hands sit PI apart and stay opposite.
    const phi = orbitPhi(fighter);
    const orbiting = orbitActive(fighter);
    const gripDir = orbitGripDir(phi, fighter._fighterDef);
    const oR = orbitHandPose(phi, 'right', _orbR, orbitRig);
    const oL = orbitHandPose(phi, 'left', _orbL, orbitRig);

    // Screen roles from depth — LAYERING ONLY (the front-arc hand draws over
    // the body, the rear-arc hand behind it; at rest the facing side leads).
    // These roles are never used to place hands, so the moment a turn swaps
    // them the hands do not move.
    const frontAnat = orbitFrontSide(phi, fighter.facingRight, orbiting);
    const backAnat = frontAnat === 'right' ? 'left' : 'right';
    const frontZ = (frontAnat === 'right' ? oR : oL).z;
    const backZ = (backAnat === 'right' ? oR : oL).z;

    // Movement offsets are computed PER ANATOMICAL HAND, never per screen role.
    // If the bob/pump/air offsets followed the front/rear roles, they would
    // jump the instant a turn swapped the roles — the left↔right flicker.
    // `faceB` is the continuous facing (+1 right, −1 left, 0 mid-turn); the
    // offsets interpolate on it, so a turn reverses them smoothly instead of
    // stepping a sign in a single frame.
    const faceB = Math.cos(phi);
    const neutralAir = (handConfig.actions && handConfig.actions.neutral) || { airLiftY: 0.22, airSpreadX: 0.08 };
    // Facing-side ("lead") weights: the lead hand carries +1, the trail hand
    // −0.6, and they cross-fade through 0 at the mid-turn.
    const leadR = 0.2 + 0.8 * faceB;
    const leadL = 0.2 - 0.8 * faceB;

    const baseR = _hb(fighter, 'baseR', oR.x * vradius, oR.y * vradius);
    const baseL = _hb(fighter, 'baseL', oL.x * vradius, oL.y * vradius);
    const neutralR = _hb(fighter, 'neutralR', baseR.x, baseR.y);
    const neutralL = _hb(fighter, 'neutralL', baseL.x, baseL.y);
    neutralR.x = baseR.x; neutralR.y = baseR.y;
    neutralL.x = baseL.x; neutralL.y = baseL.y;

    const bob = Math.sin(time * 0.005) * 2; // subtle breathing
    neutralR.y += bob * leadR;
    neutralL.y += bob * leadL;

    if (fighter.grounded && !fighter.dodging && Math.abs(fighter.vx) > 120) {
      const pump = Math.abs(Math.sin(time * 0.016)) * vradius * 0.28;
      neutralR.x += pump * leadR;
      neutralL.x += pump * leadL;
      neutralR.y += pump * (-0.05 - 0.45 * faceB);
      neutralL.y += pump * (-0.05 + 0.45 * faceB);
    }

    if (!fighter.grounded && !fighter.dodging) {
      neutralR.y -= vradius * neutralAir.airLiftY;
      neutralL.y -= vradius * neutralAir.airLiftY;
      const spread = vradius * neutralAir.airSpreadX;
      neutralR.x += spread * faceB;
      neutralL.x -= spread * faceB;
    }

    if (fighter.dodging) {
      neutralR.x = baseR.x * 0.35;
      neutralL.x = baseL.x * 0.35;
      neutralR.y += vradius * 0.12;
      neutralL.y += vradius * 0.12;
    }

    // Ease the DISPLAYED hands PER ANATOMICAL SIDE (never per screen role). The
    // front/back roles only decide draw ORDER below — they must never store the
    // hand positions, because `frontAnat` flips when the orbit ends and storing
    // role-based positions made the anatomical hands jump ~half a body width in
    // one frame (the "hands switch" glitch). While the orbit travels the angle
    // is already eased, so the arc is stamped; otherwise the pose settles.
    const smooth = Math.min(1, rigBlend(fighter._fighterDef));
    if (!orbiting) {
      // Weapon-rotation easing, once per frame (see handRig.js easeHeldRots).
      // Skipped mid-orbit: the orbit pass stamps snapped orientations instead.
      easeHeldRots(fighter);
    }
    if (!fighter._handL) fighter._handL = { x: neutralL.x, y: neutralL.y };
    if (!fighter._handR) fighter._handR = { x: neutralR.x, y: neutralR.y };
    if (orbiting) {
      fighter._handL.x = neutralL.x; fighter._handL.y = neutralL.y;
      fighter._handR.x = neutralR.x; fighter._handR.y = neutralR.y;
    } else {
      fighter._handL.x += (neutralL.x - fighter._handL.x) * smooth;
      fighter._handL.y += (neutralL.y - fighter._handL.y) * smooth;
      fighter._handR.x += (neutralR.x - fighter._handR.x) * smooth;
      fighter._handR.y += (neutralR.y - fighter._handR.y) * smooth;
    }
    const rl = fighter._handL, rr = fighter._handR;
    // Anatomical offsets for equipment — read straight from the per-hand
    // records, so each weapon stays glued to the hand that holds it.
    _orbHands.left.x = rl.x; _orbHands.left.y = rl.y;
    _orbHands.right.x = rr.x; _orbHands.right.y = rr.y;
    // Publish anatomical hand world positions for the debug overlay / probe.
    {
      const hw = _handWorldOf(fighter);
      hw.left.x = x + rl.x; hw.left.y = y + rl.y;
      hw.right.x = x + rr.x; hw.right.y = y + rr.y;
    }

    // Reuse pre-allocated state objects for rendering. Depth → size rides on
    // the cached draw state: a hand swells as it swings in front of the body
    // and shrinks behind it, exactly like the prototype (radius = h*(1+arc*z)).
    const frontHand = frontAnat === 'right' ? rr : rl;
    const backHand = backAnat === 'right' ? rr : rl;
    const backSt = _hst(fighter, 'back', x + backHand.x, y + backHand.y, 'back');
    const frontSt = _hst(fighter, 'front', x + frontHand.x, y + frontHand.y, 'front');
    const backScale = orbitHandScale(backZ, orbitRig);
    const frontScale = orbitHandScale(frontZ, orbitRig);
    backSt.sx = backScale; backSt.sy = backScale;
    frontSt.sx = frontScale; frontSt.sy = frontScale;
    // Gear rides anatomical hands (never swaps fists) and mirrors with the
    // snap-based grip orientation — at rest this agrees with facing exactly.
    const mirrorGear = gripDir < 0;
    // Gripped hands show the weapon instead of fist gear (see holdCoversSide).
    const frontGearShown = (handGear && handGear[frontAnat] && !holdCoversSide(fighter, frontAnat)) ? handGear[frontAnat] : null;
    const backGearShown = (handGear && handGear[backAnat] && !holdCoversSide(fighter, backAnat)) ? handGear[backAnat] : null;

    if (orbiting) {
      // Body first, then BOTH fists over it (rear group then front group),
      // weapons over their fist. The hands sit on the body edge, so nothing may
      // duck behind the body — that swap popped a hand at each turn.
      drawBody(ctx, fighter, skinLive, vradius);
      drawFrontAccessory(ctx, fighter, x, y, vradius);
      drawOrbitEntries(ctx, fighter, x, y, backAnat, _orbHands, gripDir, false, vradius);
      _drawHandState(ctx, backSt, handR, handFill, backGearShown, mirrorGear);
      drawOrbitEntries(ctx, fighter, x, y, backAnat, _orbHands, gripDir, true, vradius);
      drawOrbitEntries(ctx, fighter, x, y, frontAnat, _orbHands, gripDir, false, vradius);
      _drawHandState(ctx, frontSt, handR, handFill, frontGearShown, mirrorGear);
      drawOrbitEntries(ctx, fighter, x, y, frontAnat, _orbHands, gripDir, true, vradius);
    } else if (backSt.layer === 'front') {
      drawHeldLayer(ctx, fighter, x, y, 'back', false, vradius);
      drawHeldLayer(ctx, fighter, x, y, 'back', true, vradius);
      drawBody(ctx, fighter, skinLive, vradius);
      drawFrontAccessory(ctx, fighter, x, y, vradius);
      _drawHandState(ctx, backSt, handR, handFill, backGearShown, mirrorGear);
      drawHeldLayer(ctx, fighter, x, y, 'front', false, vradius);
      _drawHandState(ctx, frontSt, handR, handFill, frontGearShown, mirrorGear);
      drawHeldLayer(ctx, fighter, x, y, 'front', true, vradius);
    } else {
      // Explicit layer:'back' weapons stay behind the body (the WPN LAYER row).
      drawHeldLayer(ctx, fighter, x, y, 'back', false, vradius);
      drawHeldLayer(ctx, fighter, x, y, 'back', true, vradius);
      drawBody(ctx, fighter, skinLive, vradius);
      drawFrontAccessory(ctx, fighter, x, y, vradius);
      // Both fists draw over the body (rear group then front group), weapons
      // over their fist by default. No hand is occluded by the body, so close
      // hands and the facing turn can never pop one.
      _drawHandState(ctx, backSt, handR, handFill, backGearShown, mirrorGear);
      drawHeldLayer(ctx, fighter, x, y, 'front', false, vradius);
      _drawHandState(ctx, frontSt, handR, handFill, frontGearShown, mirrorGear);
      drawHeldLayer(ctx, fighter, x, y, 'front', true, vradius);
    }
  }

  // Deadeye hit flash: brief red overlay when one of the cowboy's Deadeye
  // bullets connects (set by combat.js' applyDeadeyeHit, decayed in Fighter.js
  // physics). This is the ONLY fighter-local flash left — a plain melee or
  // ability hit paints nothing.
  if (fighter._hitFlash > 0) {
    const a = Math.min(0.45, fighter._hitFlash * 3);
    ctx.globalAlpha = a;
    ctx.beginPath();
    ctx.arc(x, y, vradius + 2, 0, Math.PI * 2);
    ctx.fillStyle = '#ff2222';
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  // Direction indicator (small arrow on top)
  const arrowY = y - vradius - 10;
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
      
      // 1. Trail (yellow/gold, tapered). Batched by alpha band: segments are
      // quantized into 4 bands sharing one beginPath/stroke each (subpaths stay
      // disconnected via moveTo, so bullets never connect). ~4 strokes + ~12
      // state sets per bullet instead of N strokes + 3N sets. Legacy path via
      // setEffectBatch(false).
      if (b.trail && b.trail.length > 1) {
        if (_batchTrails) _drawDeadeyeTrailBatched(ctx, b);
        else {
          ctx.globalCompositeOperation = 'lighter';
          ctx.lineCap = 'round';
          ctx.lineJoin = 'round';
          for (let i = 0; i < b.trail.length - 1; i++) {
            const t = i / (b.trail.length - 1);
            const p1 = b.trail[i];
            const p2 = b.trail[i + 1];
            ctx.globalAlpha = t * 0.6;
            ctx.strokeStyle = b.trailColor || '#ffd54f';
            ctx.lineWidth = (1 - t) * b.bulletSize * 0.4;
            ctx.beginPath();
            ctx.moveTo(p1.x, p1.y);
            ctx.lineTo(p2.x, p2.y);
            ctx.stroke();
          }
          ctx.globalCompositeOperation = 'source-over';
        }
        ctx.globalAlpha = 1;
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
// Depsey Roll aura (GA/vfx/depseyaura.html), drawn UNDER the buffed fighter.
// World-space — call BEFORE drawFighter so the blob sits behind the body.
// Centered on the fighter's center (not the feet) with a faint outer glow and
// a bright core spot; rides the fighter exactly and flickers out over the
// buff's last second.
export function drawBoxerRollUnder(ctx, fighter, time) {
  if (!fighter || !fighter._boxerRoll || fighter._boxerRoll.timeLeft <= 0) return;
  if (!_inView(fighter.x, fighter.y, 110)) return;
  const r = fighter.radius || 22;
  const t = time * 0.003;
  const cx = fighter.x, cy = fighter.y;
  const base = r * 1.6;
  const aMul = fighter._boxerRoll.timeLeft < 1
    ? 0.45 + 0.55 * Math.abs(Math.sin(t * 4)) : 1;
  ctx.save();
  ctx.globalAlpha = 0.10 * aMul;
  ctx.fillStyle = '#00ff64';
  ctx.beginPath();
  ctx.arc(cx, cy, base * 1.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  for (let i = 0; i <= 24; i++) {
    const th = (i / 24) * Math.PI * 2;
    const wv = Math.sin(th * 5 + t * 3) * base * 0.09
      + Math.cos(th * 3 - t * 2) * base * 0.08;
    const rr = base + wv;
    const px = cx + Math.cos(th) * rr, py = cy + Math.sin(th) * rr;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
  ctx.globalAlpha = 0.85 * aMul;
  ctx.fillStyle = '#00cc55';
  ctx.fill();
  ctx.globalAlpha = 1 * aMul;
  ctx.lineWidth = 3;
  ctx.strokeStyle = '#00ff73';
  ctx.stroke();
  ctx.globalAlpha = 0.9 * aMul;
  ctx.fillStyle = '#66ff99';
  ctx.beginPath();
  ctx.arc(cx, cy, base * 0.2, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
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
