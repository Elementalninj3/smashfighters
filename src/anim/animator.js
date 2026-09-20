// animator.js — runtime layer. Gameplay only calls playAnimation(name) /
// requestAnimation(); the animator owns numbering frames, blending, facing
// mirroring and the hand→grip→weapon transform chain. Output is written to
// fighter.anim.out as fully-resolved world-space drawables — the renderer just
// draws them, so nothing in Effects knows about tracks or mirroring.
//
// OUT STRUCTURE (world space, per object):
//   { side, px, py, rot, scaleX, scaleY, width, height, opacity, visible,
//     flipX, flipY, z, type: 'hand'|'weapon', def?: weaponDef }

import {
  sampleTrack, TRANSFORM_PROPS, DEFAULT_VALUES, DEFAULT_POSE,
  propPath, animationFrameCount,
} from './core.js';
import { getWeapon } from './weapons.js';
import { updateFighterVfx, resetFighterVfx } from '../vfx.js';

const SIDES = ['left', 'right'];

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
    A._flat.hands[side] = { ...fh };

    const wcfg = (cfg[side] || null);
    const def = wcfg ? getWeapon(wcfg.id) : null;
    if (!def) { out.weapons[side] = null; A._flat.weapons[side] = null; continue; }
    const fw = flattenObject(anim, side, 'weapons', frame, _flatWeapon);
    if (A.blendFrom && A.blendProgress < 1) {
      const b = A.blendFrom.weapons ? A.blendFrom.weapons[side] : null;
      if (b) for (const p of TRANSFORM_PROPS) fw[p] = b[p] + (fw[p] - b[p]) * easeOutC(A.blendProgress);
    }
    A._flat.weapons[side] = { ...fw };
    // Reuse the pooled weapon object (no per-frame weapon allocation).
    const wm = wcfg.mirror === false ? 1 : mGlobal;
    if (!out.weapons[side] || out.weapons[side].type !== 'weapon') out.weapons[side] = {};
    resolveWeapon(fighter, side, hand, fw, wcfg, def, wm, out.weapons[side]);
  }
}

function easeOutC(t) { return 1 - Math.pow(1 - Math.min(1, Math.max(0, t)), 3); }

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
          // Freeze at the last frame — the attack is still in recovery and the
          // hands should hold their final keyframed pose. When the attack
          // enters recovery / ends, syncFighterAnim calls stopAnimation to
          // blend back to the legacy movement pose system.
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