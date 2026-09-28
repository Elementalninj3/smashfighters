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
    // src/effects/art.js. The retired shadowPoof + slash pair used to sit here.
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

export const DEFAULT_ANIMATIONS = [...BASE_ANIMATIONS, ..._boxerAnims];

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
      persist();
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
      persist();
    }
  }
  try { localStorage.setItem(TELEPORT_STRIKE_MIGRATION_KEY, '1'); } catch (_) {}
}

// ── Ability-only VFX migration ────────────────────────────────────────────
// VFX now belongs to abilities alone: an animation paints only when it is bound
// to an ability (combat.type 'nonHitbox' + combat.abilityId), which is the same
// test DEFAULT_ANIMATIONS above is written to. A browser whose animator had
// already saved would otherwise keep replaying the general melee art (bullet,
// spray, blast, slash, shadowPoof/shadowBlast) on top of the new rule forever,
// so drop it from every non-ability animation, once.
//
// Runs AFTER migrateTeleportStrike() on purpose: a stored ninjaDtilt that still
// needed its ability binding re-attached would otherwise be treated as unbound
// and have its (legitimate) Teleport Strike slash wiped instead of repaired.
const ABILITY_ONLY_VFX_MIGRATION_KEY = 'smashfighters.animlib.abilityOnlyVfx';

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
    a.vfx = [];
    changed = true;
  }
  if (changed) persist();
  try { localStorage.setItem(ABILITY_ONLY_VFX_MIGRATION_KEY, '1'); } catch (_) {}
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