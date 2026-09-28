// combat.js â€” data-driven melee foundation for the movement arena.
//
// Flow per frame:    Movement / physics â†’ grounded resolve
//                    â†’ combatInput (a fresh press â€” or a buffered press â€” starts
//                      a new attack instance, capturing type/direction/facing)
//                    â†’ Attack frame machine (startup â†’ active â†’ recovery)
//                    â†’ Hitbox spawn / position / collision
//                    â†’ Hit resolution (percent / knockback / hitstun)
//                    â†’ Cleanup (no lingering hitboxes)
//
// The model is deliberately simple:
//   - One hurtbox per fighter (a square from their ball radius).
//   - Hitbox = a rect defined by attack data, mirrored by facing.
//   - One shared hitbox registry, cleaned up every frame.
//
// Future characters only need to define `character.attacks` â€” the same engine
// executes them. No character-specific collision code anywhere.

import { isHeld, isJustPressed } from '../input/Input.js';
import { freezeGame } from '../core/loop.js';
import { SFX } from '../core/sfx.js';
import { getAnimationRaw } from '../anim/library.js';
import { getAbility, abilityCooldownFor } from './abilities.js';
import { getCustomHitboxes } from './hitboxData.js';
import { releaseTimeDilation, spawnDamageNumber, spawnFloatingText, emitFlash, emitImpactRing, emitSparks, fxStyleFor } from '../render/worldFx.js';
import { destructibleList, damageDestructible } from '../stage/sandbox/destructible.js';
import {
  AERIAL_LIGHT_RECOVERY_FORCE,
  AERIAL_LIGHT_RECOVERY_DURATION,
  BLOCK_COOLDOWN,
  stampAbilityCooldown,
  spawnTempVfx,
} from './Fighter.js';


// â”€â”€ Global attack pacing (Â§45 â€” ONE centralized lock, every attack type) â”€â”€
// Minimum time between attack STARTS, measured from the previous attack's
// start via fighter.attackCooldown (stamped in startAttack, decayed in
// stepFighterPhysics, gated in combatInput below). Covers Light/Heavy/
// Down/Smash/Aerial/special/projectile/character moves alike â€” switching
// buttons cannot bypass it, because the gate sits on the single entry path.
// Multi-hit internals of ONE attack are untouched (hitbox frames â‰  starts),
// and the 5-frame input buffer still fires the instant the lock clears, so
// combos keep their rhythm at â‰¥0.83s spacing.
// Balance (Â§46): 0.5 â†’ 0.83, i.e. attack STARTS per second drop 40% (2.0/s â†’
// 1.2/s). Single knob â€” every attack type slows together, and HITSTUN_CAP below
// is raised to match so follow-ups still connect.
export const ATTACK_DELAY = 0.83;

// One frame of committed action. The attack still plays out startup â†’ active â†’
// recovery even if it whiffs â€” a missed heavy attack is punishable.
// Balance (2026-09): hitstun kept combo-capable after the damage/kb cuts so
// matches stay action-heavy and close in 20â€“50s (combos â†’ percent â†’ KOs).
const HITSTUN_CAP = 1.05;   // Â§45 combo-compat: must exceed ATTACK_DELAY (0.83)
  // so a heavy/high-percent hit keeps the victim stunned across the attacker's
  // own start-lock, letting a real follow-up connect instead of mashing.
// Tiny post-hit grace (~2 frames). Re-hits are already prevented per-attack by
// the shared `hitIds` set â€” this only stops two hitboxes from resolving onto
// the same target in the same moment, without gating combo pressure.
const HIT_FEEDBACK_INVULN = 0.03;

// After a successful hit the attacker renders ON TOP of the knocked-away
// target for this window (see Game.js render). Simple, facing-agnostic rule:
// whoever most recently landed a hit draws last while their timer is alive.
const HIT_RENDER_LINGER = 0.28;

// Input buffering: a light/heavy press made just before the current attack or
// dodge ends is remembered and executed on the first free frame (~5 frames â‰ˆ
// 83ms). Buffering only covers "I want to act very soon" â€” it is never set or
// honored while in hitstun, and it never queues an input indefinitely.
const BUFFER_FRAMES = 5;

// Snapshot the currently held directions so the attack side is fixed at the
// exact moment the attack button is pressed â€” never resolved later from a
// direction that may have changed. Accepts optional input-function overrides
// (AI controllers) so synthetic AI holds resolve through the same path as
// human keys: readDir(p, { isHeld }) â€” defaults to the real Input.js queries.
function readDir(p, inputFns) {
  const ih = (inputFns && inputFns.isHeld) || isHeld;
  return {
    up: ih(p, 'up'),
    down: ih(p, 'down'),
    left: ih(p, 'left'),
    right: ih(p, 'right'),
  };
}

// â”€â”€ Attack definitions â€” the whole moveset is data, not code â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Frames are 1-indexed at 60fps. Positions are relative to the attacker's
// center: `ox` mirrors with facing, `oy` is vertical offset (+ = below).
// Angle in degrees: 0 = straight forward, positive tilts up, negative tilts
// down (Canvas Y increases downward).
//
// Hitboxes are intentionally GENEROUS â€” this is a fun platform-fighter, not a
// pixel-precise 2D fighter. Each hitbox is tuned so it visually anchors to the
// player's body and reaches clearly toward the attack direction, so a melee
// attack connects without pixel-perfect spacing. The reach is the playerâ†’hitbox
// relationship: the farther the intended range, the farther `ox`/`oy` push it.
// The `anim` id connects each attack to the Hand/Weapon Animator animation that
// drives the character's hands while this attack plays (library.js). It is pure
// metadata â€” no combat behaviour depends on it.
//
// The HEAVY attacks (neutral/side/up/down smash â€” the `special` type) have
// startup: 0 on purpose: their damaging hitbox must be live on the very same
// game update as the input press. The active window then runs its normal frame
// count and hot-swaps to recovery (hitbox deactivated) the instant it ends.
//
// `anim` is pure visual metadata: which library animation drives the hands
// while the attack plays. Neutral/Forward Aerial light+heavy each own one;
// up/down/back variants reuse the closest of the base poses. Down Heavy owns
// its own (cowboyDownHeavy) whose combat entry turns it into a non-hitbox
// projectile.
// â”€â”€ Balance (2026-09): combat is fast + controlled â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Damage = original Ã— 0.40, knockback (kbBase/kbGrowth) = original Ã— 0.50,
// applied PER-ATTACK in the tables below (never a single global damage knob).
// Launch direction is per-attack: `launchAngle` is authoritative (deg: 0 =
// forward, +up, -down, canvas Y down), `angle` kept as alias for legacy/custom
// boxes. Side moves launch mostly horizontal, up moves launch up, down moves
// spike/angle down, aerials carry their own direction. Generic geometry never
// decides the launch â€” resolveHitDir only mirrors (away-from-attacker).
const DEFAULT_ATTACKS = {
  jab:    { name: 'Jab',          anim: 'jab',    startup: 3,  active: 5,  recovery: 8,  dmg: 1.2, kbBase: 45,  kbGrowth: 0.4,  angle: 15,  launchAngle: 15,  horizontalKnockback: 1.0, verticalKnockback: 0.27, w: 60, h: 32, ox: 42,  oy: -4 },
  nsmash: { name: 'Neutral Smash',anim: 'nsmash', startup: 0,  active: 6,  recovery: 24, dmg: 5.6, kbBase: 140, kbGrowth: 0.8,  angle: 30,  launchAngle: 30,  horizontalKnockback: 0.87, verticalKnockback: 0.5,  w: 82, h: 40, ox: 46,  oy: -4 },
  ftilt:  { name: 'Side Tilt',    anim: 'ftilt',  startup: 5,  active: 5,  recovery: 12, dmg: 2.8, kbBase: 85,  kbGrowth: 0.55, angle: 35,  launchAngle: 35,  horizontalKnockback: 0.82, verticalKnockback: 0.57, w: 76, h: 36, ox: 54,  oy: -4 },
  fsmash: { name: 'Side Smash',   anim: 'fsmash', startup: 0,  active: 6,  recovery: 28, dmg: 6.4, kbBase: 165, kbGrowth: 0.95, angle: 38,  launchAngle: 38,  horizontalKnockback: 0.79, verticalKnockback: 0.62, w: 92, h: 44, ox: 66,  oy: -4, abilityType: 'nonHitbox', abilityId: 'cowboyFwdHeavy', abilityCfg: {} },
  utilt:  { name: 'Up Tilt',      anim: 'nair',   startup: 5,  active: 5,  recovery: 12, dmg: 2.4, kbBase: 75,  kbGrowth: 0.5,  angle: 75,  launchAngle: 75,  horizontalKnockback: 0.26, verticalKnockback: 0.97, w: 50, h: 60, ox: 8,   oy: -46 },
  usmash: { name: 'Up Smash',     anim: 'nsmash', startup: 0,  active: 7,  recovery: 26, dmg: 6.0, kbBase: 150, kbGrowth: 0.9,  angle: 88,  launchAngle: 88,  horizontalKnockback: 0.03, verticalKnockback: 1.0,  w: 70, h: 80, ox: 4,   oy: -68 },
  dtilt:  { name: 'Down Light',    anim: 'cowboyDownLight', startup: 0, active: 0, recovery: 0, dmg: 0, kbBase: 0, kbGrowth: 0, angle: 0, launchAngle: 0, horizontalKnockback: 1.0, verticalKnockback: 0, w: 40, h: 40, ox: 0, oy: 0 },
  dsmash: { name: 'Down Smash',   anim: 'cowboyDownHeavy', startup: 0,  active: 6,  recovery: 26, dmg: 5.6, kbBase: 155, kbGrowth: 0.9,  angle: -45, launchAngle: -45, horizontalKnockback: 0.71, verticalKnockback: -0.71, w: 74, h: 36, ox: 50,  oy: 16, bothSides: true },
  aerialLight: { name: 'Aerial Light', anim: 'nair', startup: 5,  active: 8,  recovery: 13, dmg: 2.8, kbBase: 80,  kbGrowth: 0.6,  angle: 0,   launchAngle: 0,   horizontalKnockback: 1.0, verticalKnockback: 0,   w: 66, h: 64, ox: 0,   oy: 0, air: true, recoveryX: 0, recoveryY: 0, recoveryDuration: 0 },
  aerialHeavy: { name: 'Aerial Heavy', anim: 'fair', startup: 8,  active: 10, recovery: 20, dmg: 4.8, kbBase: 120, kbGrowth: 0.8,  angle: 80, launchAngle: 80, horizontalKnockback: 0.17, verticalKnockback: 0.98, vyScale: 0.25, w: 70, h: 48, ox: 52,  oy: -4, air: true, recoveryX: -8, recoveryY: -12, recoveryDuration: 8 },
  dash:   { name: 'Dash',         anim: 'dash',   startup: 0,  active: 8,  recovery: 10, dmg: 2.0, kbBase: 65,  kbGrowth: 0.45, angle: 20,  launchAngle: 20,  horizontalKnockback: 0.94, verticalKnockback: 0.34, w: 100, h: 50, ox: 50,  oy: 0 },
};

// Ninja-specific attacks â€” the same balance rule as every other table (dmg Ã—0.40,
// kb Ã—0.50, per-attack launchAngle authoritative â€” see DEFAULT_ATTACKS header),
// then a NINJA-ONLY damage buff on top, applied TWICE: every row below is Ã—1.4
// twice over, so the ninja's effective damage is now original Ã— 0.784
// (0.40 shared rule Ã— 1.4 Ã— 1.4). Knockback is deliberately NOT buffed â€” the ninja
// trades reach for power, not for launch distance, so its knockback numbers are
// still the shared Ã—0.50 rule. Buffed per-attack (never through a single global
// multiplier) so a single move can still be retuned on its own. The shuriken's
// real damage in abilities.js (ninjaFsmash) is kept in lockstep with this table.
const NINJA_ATTACKS = {
  jab:    { name: 'Quick Slash',    anim: 'ninjaJab',    startup: 2,  active: 4,  recovery: 6,  dmg: 3.136, kbBase: 30, kbGrowth: 0.3, angle: 20, launchAngle: 20, horizontalKnockback: 0.94, verticalKnockback: 0.34, w: 50, h: 28, ox: 38,  oy: -2 },
  ftilt:  { name: 'Forward Slash',  anim: 'ninjaFtilt',  startup: 4,  active: 5,  recovery: 10, dmg: 6.272, kbBase: 70, kbGrowth: 0.5, angle: 30, launchAngle: 30, horizontalKnockback: 0.87, verticalKnockback: 0.5, w: 65, h: 32, ox: 48,  oy: -2 },
fsmash: { name: 'Shuriken Throw', anim: 'ninjaFsmash', startup: 8, active: 2, recovery: 20, dmg: 9.408, kbBase: 90, kbGrowth: 0.6, angle: 15, launchAngle: 15, horizontalKnockback: 0.97, verticalKnockback: 0.26, w: 30, h: 30, ox: 60,  oy: 0, isProjectile: true, hitLockDuration: 0.5 },
  utilt:  { name: 'Upward Slash',   anim: 'ninjaUtilt',  startup: 4,  active: 5,  recovery: 10, dmg: 5.488, kbBase: 65, kbGrowth: 0.5, angle: 80, launchAngle: 80, horizontalKnockback: 0.17, verticalKnockback: 0.98, w: 45, h: 55, ox: 6,   oy: -40 },
  usmash: { name: 'Rising Slash',   anim: 'ninjaUsmash', startup: 6,  active: 7,  recovery: 18, dmg: 10.976, kbBase: 130, kbGrowth: 0.8, angle: 85, launchAngle: 85, horizontalKnockback: 0.09, verticalKnockback: 1.0, w: 55, h: 70, ox: 4,   oy: -60 },
  // Down Light is the Teleport Strike: the ability (ABILITIES.ninjaDtilt) warps
  // the ninja in BEHIND the opponent on its cast frame and then this same row's
  // melee box runs from there through the shared hitbox registry. Numbers below
  // are the strike's damage and knockback â€” nothing about the hit is
  // special-cased in the ability.
  // angle 0 (was -10) = pure HORIZONTAL knockback; the hit direction is resolved
  // from the attacker/target positions (resolveHitDir), so because the ninja
  // always ends up behind the opponent the launch is always AWAY from the ninja.
  // kbBase/kbGrowth are raised from the sweep's 50/0.4 so the launch is a clear,
  // visible punish rather than a nudge (see the ninja balance rule above).
  //
  // The abilityType/abilityId designation is repeated HERE, on the attack table,
  // and not only on the ninjaDtilt animation, for the same reason the cowboy's
  // Side Smash repeats it (see resolveAnimDef): a saved animation store
  // REPLACES a built-in animation wholesale, so a profile that stored
  // ninjaDtilt before this move existed loads an animation with no combat
  // payload. The table designation is authoritative and wins in that case, so
  // Down Light keeps teleporting instead of silently reverting to a plain sweep.
  dtilt:  { name: 'Teleport Strike', anim: 'ninjaDtilt',  startup: 3,  active: 5,  recovery: 8,  dmg: 4.704, kbBase: 220, kbGrowth: 1.0, angle: 0, launchAngle: 0, horizontalKnockback: 1.0, verticalKnockback: 0,    w: 55,  h: 20,  ox: 42,  oy: 10, abilityType: 'nonHitbox', abilityId: 'ninjaDtilt', abilityCfg: {} },
  // dashDistance is the Shadow Dash's fixed forward travel budget. The ability
  // derives the burst LENGTH from it while holding the dash speed constant, so
  // raising this number lengthens the burst instead of speeding it up.
  //
  // `active` is how long the dash-strike's hitbox stays live after the cast
  // frame. It is set to cover the WHOLE burst: the dash is dashDistance /
  // dashSpeed = 192 / 800 = 0.24s = ~14 frames at 60fps, so anything the ninja
  // passes through during the burst is now a real hit instead of only the first
  // 3 frames. Because this move is a nonHitbox ability its length comes from the
  // ability's own `frames` (32), NOT from startup+active+recovery â€” so widening
  // the strike window does not make the move itself longer or slower to recover.
  dsmash: { name: 'Shadow Strike',  anim: 'ninjaDsmash', startup: 10, active: 14, recovery: 22, dmg: 12.544, kbBase: 140, kbGrowth: 0.9,  angle: 40, launchAngle: 40, horizontalKnockback: 0.77, verticalKnockback: 0.64, w: 96, h: 88, ox: 0,   oy: 0,   dashDistance: 192 },
  aerialLight: { name: 'Aerial Slash',  anim: 'ninjaNair', startup: 4,  active: 7,  recovery: 12, dmg: 4.704, kbBase: 60, kbGrowth: 0.5, angle: 0,   launchAngle: 0,   horizontalKnockback: 1.0, verticalKnockback: 0,   w: 60, h: 55, ox: 0,   oy: 0, air: true, recoveryX: 0, recoveryY: 0, recoveryDuration: 0 },
  aerialHeavy: { name: 'Aerial Kick',   anim: 'ninjaFair', startup: 7,  active: 8,  recovery: 18, dmg: 8.624, kbBase: 100, kbGrowth: 0.7, angle: 70, launchAngle: 70, horizontalKnockback: 0.34, verticalKnockback: 0.94, vyScale: 0.25, w: 65, h: 45, ox: 48,  oy: -2, air: true, recoveryX: -6, recoveryY: -8, recoveryDuration: 6 },
  dash:   { name: 'Dash Attack',    anim: 'ninjaDash',   startup: 3,  active: 6,  recovery: 12, dmg: 5.488, kbBase: 60, kbGrowth: 0.4, angle: 25, launchAngle: 25, horizontalKnockback: 0.91, verticalKnockback: 0.42, w: 80, h: 40, ox: 45,  oy: 0 },
  nsmash: { name: 'Shadow Push',     anim: 'ninjaNsmash', startup: 8,  active: 6,  recovery: 24, dmg: 10.192, kbBase: 120, kbGrowth: 0.75, angle: 35, launchAngle: 35, horizontalKnockback: 0.82, verticalKnockback: 0.57, w: 80, h: 50, ox: 40,  oy: -4, bothSides: true },
};

// Boxer attacks â€” fists only, and three of them are ABILITIES rather than boxes.
// The light and tilt rows are the fastest-starting in the game (startup 2â€“4) so
// the character can actually get in, but every heavy trades reach for a big
// launch and a punishing recovery.
//
// Three rows are nonHitbox abilities (abilityType/abilityId below, the same
// designation the cowboy and ninja tables use, repeated HERE rather than only on
// the animation so a saved animation store can never strip a signature move
// back to a plain swing â€” see resolveAnimDef):
//   dtilt  = the Grab       (reach, hold, then punch the target away)
//   dsmash = the Deadeye Roll (blink behind the target, fist barrage, finale
//            launcher, 3.5s cooldown)
//   fsmash = the Straight Right (the heaviest single hit in the game)
//
// The ability owns the move's behaviour and its tuning constants live with it in
// abilities.js; the numbers below are what the shared hit path reads, so the
// punch, the straight and every other hit in the game resolve through the same
// deliverHit with the same knockback and hitstun rules.
const BOXER_ATTACKS = {
  jab:    { name: 'Jab',            anim: 'boxerJab',    startup: 2, active: 4, recovery: 7,  dmg: 1.6, kbBase: 40,  kbGrowth: 0.35, angle: 12, launchAngle: 12, horizontalKnockback: 1.0,  verticalKnockback: 0.22, w: 56, h: 30, ox: 40, oy: -4 },
  ftilt:  { name: 'Lead Hook',      anim: 'boxerFtilt',  startup: 4, active: 5, recovery: 12, dmg: 3.0, kbBase: 80,  kbGrowth: 0.5,  angle: 32, launchAngle: 32, horizontalKnockback: 0.84, verticalKnockback: 0.54, w: 70, h: 34, ox: 50, oy: -4 },
  nsmash: { name: 'Cross',          anim: 'boxerNsmash', startup: 0, active: 6, recovery: 30, dmg: 7.0, kbBase: 150, kbGrowth: 0.85, angle: 28, launchAngle: 28, horizontalKnockback: 0.88, verticalKnockback: 0.47, w: 86, h: 44, ox: 48, oy: -4 },
  // The Straight Right: the single hardest-hitting move in the game (9.6, above
  // the Grab's punch) with a launch long enough to send a stock back toward the
  // ledge, and the longest recovery â€” a whiff is a free punish. It is still a
  // real melee box: the ability adds a reach streak and a punch sound, and hands
  // THIS row to the shared hitbox registry on the cast frame.
  fsmash: { name: 'Straight Right', anim: 'boxerFsmash', startup: 0, active: 6, recovery: 34, dmg: 9.6, kbBase: 205, kbGrowth: 1.2,  angle: 36, launchAngle: 36, horizontalKnockback: 0.84, verticalKnockback: 0.54, w: 104, h: 46, ox: 74, oy: -4, abilityType: 'nonHitbox', abilityId: 'boxerFsmash', abilityCfg: {} },
  // Uppercut: the character's signature. Low horizontal push, almost all vertical,
  // so it spikes nothing â€” it lifts.
  utilt:  { name: 'Uppercut',       anim: 'boxerUtilt',  startup: 3, active: 5, recovery: 12, dmg: 3.2, kbBase: 70,  kbGrowth: 0.45, angle: 82, launchAngle: 82, horizontalKnockback: 0.14, verticalKnockback: 0.99, w: 52, h: 58, ox: 10, oy: -44 },
  usmash: { name: 'Rising Upper',   anim: 'boxerUsmash', startup: 0, active: 7, recovery: 28, dmg: 8.5, kbBase: 155, kbGrowth: 0.9,  angle: 88, launchAngle: 88, horizontalKnockback: 0.03, verticalKnockback: 1.0,  w: 72, h: 78, ox: 6,  oy: -66 },
  // Down Light is the Grab. The row carries no melee box at all: the ability
  // finds the target, combat holds it, and the punch that ends the move is
  // resolved through the shared hit path (see BOXER_GRAB.punch). The punch
  // numbers live with the ability; `active` is only kept non-zero so the move's
  // length and the animator's phases read sensibly.
  dtilt:  { name: 'Grab',           anim: 'boxerDtilt',  startup: 0, active: 5, recovery: 10, dmg: 0, kbBase: 0, kbGrowth: 0, angle: 0, launchAngle: 0, horizontalKnockback: 1.0, verticalKnockback: 0, w: 66, h: 26, ox: 46, oy: 12, abilityType: 'nonHitbox', abilityId: 'boxerDtilt', abilityCfg: {} },
  // Down Heavy is the Deadeye Roll - a blink-and-pummel, not a swing, so it
  // registers no box: the ability teleports behind the target and the combat
  // stepper lands the barrage + finale through the shared hit path instead.
  dsmash: { name: 'Deadeye Roll',   anim: 'boxerDsmash', startup: 0, active: 0, recovery: 18, dmg: 0, kbBase: 0, kbGrowth: 0, angle: 0, launchAngle: 0, horizontalKnockback: 1.0, verticalKnockback: 0, w: 78, h: 40, ox: 44, oy: 20, abilityType: 'nonHitbox', abilityId: 'boxerDsmash', abilityCfg: {} },
  aerialLight:  { name: 'Air Jab',      anim: 'boxerAerialLight',  startup: 4, active: 7, recovery: 12,  dmg: 3.0, kbBase: 85,  kbGrowth: 0.6,  angle: 0,  launchAngle: 0,  horizontalKnockback: 1.0, verticalKnockback: 0,    w: 62, h: 60, ox: 0,  oy: 0, air: true, recoveryX: 0,  recoveryY: 0,  recoveryDuration: 0 },
  aerialHeavy:  { name: 'Air Uppercut', anim: 'boxerAerialHeavy',  startup: 7, active: 9, recovery: 20,  dmg: 6.0, kbBase: 130, kbGrowth: 0.85, angle: 78, launchAngle: 78, horizontalKnockback: 0.12, verticalKnockback: 0.99, vyScale: 0.25, w: 74, h: 50, ox: 48, oy: -6, air: true, recoveryX: -6, recoveryY: -10, recoveryDuration: 6 },
  dash:   { name: 'Shoulder Charge', anim: 'boxerDash',  startup: 2, active: 7, recovery: 14,  dmg: 2.6, kbBase: 70,  kbGrowth: 0.45, angle: 22, launchAngle: 22, horizontalKnockback: 0.95, verticalKnockback: 0.31, w: 92, h: 46, ox: 46, oy: 0 },
};

export function attacksFor(fighter) {
  const def = fighter._fighterDef;
  if (def && def.id === 'ninja') return NINJA_ATTACKS;
  if (def && def.id === 'boxer') return BOXER_ATTACKS;
  return (def && def.attacks) || DEFAULT_ATTACKS;
}

// â”€â”€ Per-animation combat data â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// The editor stores combat data on animations (anim.combat), so an animation
// fully owns how it behaves: a hitbox rect + damage/knockback tuning, or a
// non-hitbox ability. resolveAnimDef merges that onto the base attack def,
// which keeps the attack machine (startup/active/recovery, name, bothSides,
// air, spike) working unchanged.

// Find the attack definition whose `anim` links to this animation id.
export function getAttackDefForAnimId(animId, fighter) {
  if (!animId) return null;
  const attacks = attacksFor(fighter);
  for (const key of Object.keys(attacks)) {
    const def = attacks[key];
    if (def && def.anim === animId) return def;
  }
  return null;
}

// Effective attack definition for an animation: base def (or a synthesized
// one for animator-only animations) overlaid with combat data. Not cached â€”
// it runs only at attack start, and caching risks stale data after a save.
//
// `attackKey` is the input-selected attack id (e.g. 'aerialHeavy'). Several attacks
// share one library animation (`anim`), but the Hitbox Customizer store is
// keyed by the ATTACK id so each attack owns its hitbox data. When no
// attackKey is given (animator previews) it falls back to the animation id.
//
// Priority for the damaging hitbox (highest wins):
//   1. the Hitbox Customizer's per-character, per-attack store (hitboxData.js)
//   2. legacy anim.combat hitbox data written by the old animator hitbox editor
//   3. the DEFAULT_ATTACKS / character attack-table fallback
// The store is consulted for ANY animation id, even one with no combat data,
// so customizing a move's hitbox works without the animation carrying a
// hitbox payload.
export function resolveAnimDef(anim, fighter, attackKey) {
  if (!anim) return null;
  const charId = fighter && fighter._fighterDef && fighter._fighterDef.id;

  // Non-hitbox ability moves (fsmash rifle bullet, dsmash horse ride, dtilt
  // Deadeye) are ALWAYS governed by the animation's combat entry â€” they are
  // IMMUNE to the hitbox store. Their damage and behavior come from the ability
  // itself, so a stored melee box must never silently strip the ability off the
  // move (which would make e.g. Side Smash fire no bullet at all).
  if (anim.combat && anim.combat.type === 'nonHitbox') return mergeAbilityDef(anim, fighter, attackKey);

  // Prefer the attack-keyed table entry (up/back/down attacks share one anim,
  // so the shared-anim lookup would pick the wrong variant's phases/recovery).
  const base = (attackKey && (attacksFor(fighter) || {})[attackKey]) || getAttackDefForAnimId(anim.id, fighter);

  // A saved animation must never silently strip a move's ability: when the
  // animation carries NO combat payload at all, the attack table's own ability
  // designation is authoritative (cowboy Side Smash keeps its rifle bullet no
  // matter what a dirty localStorage profile left behind) â€” and, like the
  // nonHitbox branch above, it wins over any stored melee box.
  if (!anim.combat || !anim.combat.type) {
    if (base && base.abilityType === 'nonHitbox' && base.abilityId) {
      return buildAbilityDef(base, base.abilityId, base.abilityCfg || {});
    }
  }

  const custom = charId ? getCustomHitboxes(charId, attackKey || anim.id) : null;
  if (custom !== null) {
    // A stored entry is authoritative â€” including an explicit empty list,
    // which means "this move deliberately has no hitbox".
    return mergeHitboxDef(fighter, anim, custom, null, attackKey);
  }
  if (!anim.combat || !anim.combat.type) return null;
  const combat = anim.combat;

  if (combat.type === 'hitbox') {
    const hbs = Array.isArray(combat.hitboxes) ? combat.hitboxes : (combat.hitbox ? [combat.hitbox] : []);
    return mergeHitboxDef(fighter, anim, hbs, combat, attackKey);
  }

  if (combat.type === 'nonHitbox') return mergeAbilityDef(anim, fighter, attackKey);

  return base;
}

// Build the def for a non-hitbox ability move. Shared by the resolve above, so
// the hitbox store can never turn an ability move into a melee one.
function mergeAbilityDef(anim, fighter, attackKey) {
  const base = (attackKey && (attacksFor(fighter) || {})[attackKey]) || getAttackDefForAnimId(anim.id, fighter);
  return buildAbilityDef(base, anim.combat.abilityId || null, anim.combat.cfg || {});
}

// Shape a def as a non-hitbox ability: carries the ability id + cfg plus the
// ability's frame budget (cast frame / total frames) so the attack machine can
// route it to advanceNonHitbox without a hitbox registry. The base attack def
// (which keeps `anim`, stats, name) is preserved so the animator and HUD still
// recognise the move. Works from either an animation's combat entry or an
// attack-table designation â€” the two sources a fighter's move can declare an
// ability.
function buildAbilityDef(base, abilityId, abilityCfg) {
  const out = base ? { ...base } : {
    name: 'Ability',
    anim: null,
    startup: 0, active: 0, recovery: 0,
    dmg: 0, kbBase: 0, kbGrowth: 0, angle: 0,
    w: 40, h: 40, ox: 0, oy: 0,
  };
  out.abilityType = 'nonHitbox';
  out.abilityId = abilityId || null;
  out.abilityCfg = abilityCfg || {};
  const ab = getAbility(out.abilityId);
  if (ab) {
    out.abilityFrames = ab.frames;
    out.abilityCastFrame = ab.castFrame || 1;
    // A DELAYED ability (the Teleport Strike charges before it warps) also
    // publishes how long that charge is, so the timing an ability asks for is
    // readable from the def the same way its total length already is.
    out.abilityDelayFrames = ab.delayFrames || 0;
  } else {
    out.abilityFrames = Math.max(6, base ? base.startup + base.active + base.recovery : 18);
    out.abilityCastFrame = 1;
  }
  return out;
}

// Effective attack definition for a specific attack id (e.g. 'aerialHeavy') â€” the
// per-attack version of resolveAnimDef. Backs the Hitbox Customizer preview:
// it consults the custom store through the attack key (never the shared anim
// id) and falls back to the attack's own table entry.
export function resolveAttackDef(attackKey, fighter) {
  if (!attackKey) return null;
  const def = (attacksFor(fighter) || {})[attackKey];
  if (!def) return null;
  if (def.anim) {
    const anim = getAnimationRaw(def.anim);
    if (anim) {
      const r = resolveAnimDef(anim, fighter, attackKey);
      if (r) return r;
    }
  }
  return def;
}

// Build a hitbox-type def from a hitbox list (either the custom store's or an
// animation's legacy combat data). Always a fresh object â€” the hitbox/ability
// machine mutates the returned def (abilityType etc.) and we must never write
// into a library def or the persisted store.
function mergeHitboxDef(fighter, anim, hbsSrc, combat, attackKey) {
  // Prefer the attack-keyed entry: up/back/down attacks that share an anim
  // then keep their OWN phases/recovery/damage defaults when the box doesn't
  // supply them.
  const base = (attackKey && (attacksFor(fighter) || {})[attackKey])
    || getAttackDefForAnimId(anim.id, fighter);
  const out = base ? { ...base } : {
    name: anim.name || anim.id,
    anim: anim.id,
    startup: 0, active: 0, recovery: 0,
    dmg: 0, kbBase: 0, kbGrowth: 0, angle: 0,
    w: 40, h: 40, ox: 0, oy: 0,
  };
  // normalize legacy single hitbox and ensure per-hitbox timing fields
  const hbs = (hbsSrc || []).map(hb => {
    if (!hb) return null;
    const n = { ...hb };
    if (n.startFrame == null) n.startFrame = n.startup != null ? n.startup : 0;
    if (n.duration == null) n.duration = n.active != null ? n.active : 4;
    return n;
  }).filter(Boolean);
  // Keep the explicit list â€” an EMPTY list means "this attack has no hitbox"
  // (a deliberately de-hitspaced swing), never a silent fallback to stray values.
  out.hitboxes = hbs;
  if (hbs.length) {
    const first = hbs[0];
    // keep top-level hitbox fields for code that expects a single hitbox
    for (const k of ['w','h','ox','oy','dmg','kbBase','kbGrowth','angle','launchAngle','horizontalKnockback','verticalKnockback','vyScale','recoveryX','recoveryY','recoveryDuration']) {
      if (first[k] != null) out[k] = first[k];
    }
    // launchAngle mirrors angle when only one is customized.
    if (first.angle != null && first.launchAngle == null) out.launchAngle = first.angle;
    if (first.launchAngle != null && first.angle == null) out.angle = first.launchAngle;
  }
  // Attack phase timing is derived from the union of the hitbox windows so
  // the active phase always covers exactly the damaging frames; explicit
  // combat.startup/active override it. Recovery is the one phase that is not
  // represented by a window â€” it is preserved from the base attack so a
  // customized hitbox never swallows the punish window.
  const start = hbs.length ? Math.min(...hbs.map(h => h.startFrame || 0)) : 0;
  const end = hbs.length ? Math.max(...hbs.map(h => (h.startFrame || 0) + Math.max(1, h.duration || 1))) : 1;
  out.startup = combat && combat.startup != null ? combat.startup : start;
  out.active = combat && combat.active != null ? combat.active : Math.max(1, end - start);
  out.recovery = (combat && combat.recovery != null) ? combat.recovery
    : ((base && base.recovery != null) ? base.recovery : 0);
  out.abilityType = 'hitbox';
  return out;
}

const _rectScratch = { x: 0, y: 0, w: 0, h: 0 };

// Shared scratch for the 1-or-2 facing values an attack's hitbox is spawned for
// (one facing, or mirrored for a bothSides move). Consumed synchronously.
const _facingScratch = [0, 0];

// Single-slot scratch for the "a plain def is its own one hitbox" case. Every
// caller consumes the returned list within the same synchronous block (the
// per-active-frame spawn loop below, and the editor's boxesFromDef), so one
// shared array is safe and saves a fresh `[def]` on every active frame of every
// attack. Only reached when no def has an explicit `hitboxes` array.
const _hitboxListScratch = [null];
const _hitboxListEmpty = [];

// The hitboxes a def actually spawns: an explicit array is authoritative (even
// an empty one â€” "deliberately no hitbox"); a plain attack def with no
// `hitboxes` member is its own single box (the pre-animator default case).
export function hitboxList(def) {
  if (def && Array.isArray(def.hitboxes)) return def.hitboxes;
  if (!def) return _hitboxListEmpty;
  _hitboxListScratch[0] = def;
  return _hitboxListScratch;
}

// Shared hitbox-rect math (mirroring applied). Used by combat positioning,
// the debug renderer and the editor's live hitbox preview so they can never
// drift apart.
export function hitboxRectFor(def, facing, cx, cy, out) {
  const r = out || _rectScratch;
  r.w = def.w || 0;
  r.h = def.h || 0;
  r.x = cx + (def.ox || 0) * facing - r.w / 2;
  r.y = cy + (def.oy || 0) - r.h / 2;
  return r;
}

// â”€â”€ Hitbox registry (shared, cleaned up every frame) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const hitboxes = new Map(); // id â†’ { id, owner, def, facing, active, x, y, w, h, hitIds }
let nextHitboxId = 1;

// Freelists â€” light attacks can chain dozens of hitboxes + per-attack hit Sets
// + attack objects per minute. Reusing instead of reallocating keeps repeated
// attacks allocation-free. Objects on a freelist hold no live references (their
// def/hitIds are nulled on release and rewritten on the next take).
const _hitboxPool = [];
const _hitIdPool = [];
const _attackPool = [];
// Spawned-index sets ("which hitbox indices already spawned" per attack) and
// recovery-force records are pooled too: advanceAttack used to allocate a
// `new Set()` + a `{x,y,framesLeft}` literal on every swing.
const _spawnedPool = [];
const _recForcePool = [];

function registerHitbox(owner, def, facing, attackHitIds) {
  const hb = _hitboxPool.pop() || {};
  hb.id = nextHitboxId++;
  hb.owner = owner;
  hb.def = def;
  hb.facing = facing;
  hb.active = true;
  hb.x = 0; hb.y = 0; hb.w = def.w; hb.h = def.h;
  // Shared per-attack-instance set: a target can only be hit once per attack,
  // even if the attack spawns multiple hitboxes (e.g. bothSides dsmash).
  hb.hitIds = attackHitIds;
  positionHitbox(hb, owner, facing, def);
  hitboxes.set(hb.id, hb);
  return hb;
}

function positionHitbox(hb, fighter, facing, def) {
  hb.x = fighter.x + def.ox * facing - def.w / 2;
  hb.y = fighter.y + def.oy - def.h / 2;
}

// Release an attack completely: remove + recycle its hitboxes, recycle the
// per-attack hit Set, and free the attack object itself. After a finished /
// cancelled attack NO combat state of that attack remains anywhere.
function destroyAttackHitboxes(fighter) {
  const a = fighter.attack;
  if (!a) return;
  for (const id of a.hitboxIds) {
    const hb = hitboxes.get(id);
    if (hb) {
      hitboxes.delete(id);
      hb.def = null;
      hb.hitIds = null;
      _hitboxPool.push(hb);
    }
  }
  a.hitboxIds.length = 0;
  if (a.hitIds) { a.hitIds.clear(); _hitIdPool.push(a.hitIds); }
  if (a.spawnedHitboxes) { a.spawnedHitboxes.clear(); _spawnedPool.push(a.spawnedHitboxes); a.spawnedHitboxes = null; }
  if (a.recoveryForce) { _recForcePool.push(a.recoveryForce); a.recoveryForce = null; }

  // A charge that was still counting down dies with the move: the teleport it
  // was building towards never happens and the strike it owed never lands.
  // (Hit-interrupt, a soft reset, or simply the move ending on its own.)
  fighter._teleportPending = null;
  
  // Deadeye bullets are fighter-owned, NOT attack-owned: they deliberately
  // survive this attack's teardown and keep flying until every bullet has
  // resolved (see updateDeadeyeCombat / clearDeadeye).
  
  fighter.attack = null;
  a.def = null;
  a.hitIds = null;
  a.hitboxIds = null;
  _attackPool.push(a);
  // A mount's hitbox rides the attack object's hitboxIds â€” releasing the
  // attack releases the ride too (ability end, hit-interrupt, soft reset).
  removeHorse(fighter);
}

export function removeAttackerHitboxes(fighter) {
  destroyAttackHitboxes(fighter);
}

export function resetCombat() {
  hitboxes.clear();
  nextHitboxId = 1;
  // Reset at match start: drop pooled combat objects so no references to this
  // match's fighters/animations linger into the next one.
  _hitboxPool.length = 0;
  _hitIdPool.length = 0;
  _attackPool.length = 0;
  _spawnedPool.length = 0;
  _recForcePool.length = 0;
}

// Temporary diagnostic: live hitbox registry snapshot ({probe} tests).
export function __debugHitboxes() {
  return [...hitboxes.values()].map(h => ({
    x: +h.x.toFixed(1), y: +h.y.toFixed(1), w: h.w, h: h.h,
    active: h.active, owner: h.owner.playerNum,
  }));
}

// â”€â”€ Hurtbox: one AABB per fighter, from their ball radius â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Returns the fighter's SHARED, mutable hurtbox buffer, refreshed to the
// fighter's current position. Every caller reads it immediately (aabb test, or
// a debug strokeRect), so one buffer per fighter is enough â€” no per-call object.
// w/h are derived from a radius that never changes mid-match, so they are
// written once at creation instead of on every call in the collision loop.
export function getHurtbox(fighter) {
  let h = fighter._hurtbox;
  if (!h) {
    const r = fighter.radius;
    h = fighter._hurtbox = { x: 0, y: 0, w: r * 2, h: r * 2 };
  }
  const r = fighter.radius;
  h.x = fighter.x - r;
  h.y = fighter.y - r;
  h.w = r * 2;
  h.h = r * 2;
  return h;
}

function aabb(a, b) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

// Scratch hurtbox cache for the broadphase above (sized on demand, no alloc
// in the steady state).
const _hbCache = [];

// â”€â”€ Input â†’ Attack selection â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Grounded:  (no dir / side / up / down) Ã— (light / heavy)
// Airborne:  light â†’ aerialLight Â· heavy â†’ aerialHeavy (direction-independent)
// `type` is 'attack' (light) or 'special' (heavy). When given, the press is
// already known (e.g. from the input buffer); otherwise it reads fresh presses.
// `dir` is an optional direction snapshot captured at press time â€” when present
// it fully determines the attack side, so a direction changed after the press
// (or a direction resolved several frames later) never affects the attack.
function selectAttack(fighter, type, dir, inputFns) {
  const p = fighter.playerNum;
  const ijp = (inputFns && inputFns.isJustPressed) || isJustPressed;
  const light = type ? type === 'attack' : ijp(p, 'attack');
  const heavy = type ? type === 'special' : ijp(p, 'special');
  if (!light && !heavy) return null;

  const dirs = dir || readDir(p, inputFns);
  const up = dirs.up;
  const down = dirs.down;
  const left = dirs.left;
  const right = dirs.right;
  const attacks = attacksFor(fighter);

  // Determine forward/back based on facing direction
  const facingRight = fighter.facingRight;
  const forwardHeld = facingRight ? right : left;
  const backHeld = facingRight ? left : right;

  if (!fighter.grounded) {
    // Aerial attacks: exactly two â€” Light and Heavy.
    // Selection does NOT depend on horizontal input, facing direction, or vertical input.
    // Light button â†’ Aerial Light; Heavy button â†’ Aerial Heavy. Always.
    return light
      ? { key: 'aerialLight', def: attacks.aerialLight, variant: 'air', dir: dirs }
      : { key: 'aerialHeavy', def: attacks.aerialHeavy, variant: 'air', dir: dirs };
  }

  // Dash attack: attacking during a dash burst lunges forward with the dash
  // attack's hitbox â€” the same animator-customizable source as every other
  // attack. Custom fighter attack tables can override it; the built-in
  // fallback always exists.
  if (fighter.dashing) return { key: 'dash', def: attacks.dash || DEFAULT_ATTACKS.dash, variant: 'side', dir: dirs };

  if (up) return { key: light ? 'utilt' : 'usmash', def: light ? attacks.utilt : attacks.usmash, variant: 'up', dir: dirs };
  if (down) return { key: light ? 'dtilt' : 'dsmash', def: light ? attacks.dtilt : attacks.dsmash, variant: 'down', dir: dirs };
  // Forward/Back attacks are relative to facing direction
  if (forwardHeld) return { key: light ? 'ftilt' : 'fsmash', def: light ? attacks.ftilt : attacks.fsmash, variant: 'side', dir: dirs };
  if (backHeld) return { key: light ? 'btilt' : 'bsmash', def: light ? (attacks.btilt || attacks.ftilt) : (attacks.bsmash || attacks.fsmash), variant: 'side', dir: dirs };
  return { key: light ? 'jab' : 'nsmash', def: light ? attacks.jab : attacks.nsmash, variant: 'neutral', dir: dirs };
}

// The ability a move will actually cast, read from the same two sources
// resolveAnimDef accepts: the attack table's own designation, else the
// animation's combat entry. The cowboy's Down Light binds Deadeye on the
// ANIMATION (its attack-table row carries no abilityId), so the fallback is
// load-bearing, not a convenience.
function abilityIdForDef(def) {
  if (!def) return null;
  if (def.abilityId) return def.abilityId;
  const anim = def.anim ? getAnimationRaw(def.anim) : null;
  const c = anim && anim.combat;
  return (c && c.abilityId) || null;
}

// True when this move's ability is still cooling down for this fighter.
function abilityCoolingDown(fighter, def) {
  const id = abilityIdForDef(def);
  if (!id) return false;
  const acd = fighter.abilityCooldowns;
  return !!(acd && acd[id] > 0);
}

// Start a new attack instance. The attack takes over control until it finishes:
// no cancels, no restarts, no mid-swing redirection.
function startAttack(fighter, sel) {
  const { def, variant, key } = sel;
  const dir = sel.dir || { left: false, right: false };
  let facing = fighter.facingRight ? 1 : -1;

  // Per-ability cooldown gate. Checked HERE, before anything at all is
  // committed: the press is simply refused, so a cooling move produces no swing,
  // no cast frame and no time dilation, and the player is never locked into a
  // recovery animation for a move that cannot fire. startAttack is the single
  // entry path for EVERY attack (human input, AI synthetic input and the ?probe
  // startAttackForKey helper all funnel through here), so one gate covers all
  // three and no caller can bypass it.
  if (abilityCoolingDown(fighter, def)) return false;

  // Only grounded side attacks turn to face the held direction. This facing is
  // captured for the whole swing so a later input can't flip the hitbox. The
  // direction is the one captured when the press was received (sel.dir), never
  // a fresh read several frames after the button went down.
  if (!def.air && variant === 'side') {
    if (dir.right && !dir.left) { facing = 1; fighter.facingRight = true; }
    else if (dir.left && !dir.right) { facing = -1; fighter.facingRight = false; }
  }

  fighter.attack = _attackPool.pop() || {};
  const attr = fighter.attack;
  const rawAnim = def.anim ? getAnimationRaw(def.anim) : null;
  const rdef = (rawAnim && resolveAnimDef(rawAnim, fighter, key)) || def;
  attr.def = rdef;
  attr.variant = variant;
  attr.key = key;
  attr.frame = 0;
  attr.phase = 'startup';
  attr.facing = facing;
  attr.abilityType = rdef.abilityType || 'hitbox';
  attr.abilityId = rdef.abilityId || null;
  attr.castFrame = rdef.abilityCastFrame || 1;
  attr.abilityCastDone = false;
  // Ability strike (an ability that lands a real blow â€” Shadow Strike, Teleport
  // Strike): the shared-registry hitbox it registers on its cast frame, and how
  // many frames of its damage window are still to run. 0 = no strike. Cleared
  // HERE so a recycled attack object can never inherit the previous cast's
  // strike. suppressStrike is the ability's opt-out (set by its own cast).
  attr.strikeHitboxId = 0;
  attr.strikeFramesLeft = 0;
  attr.suppressStrike = false;
  // A DELAYED cast (the Teleport Strike charges before it warps) sets deferStrike
  // during its own cast: the strike box belongs at the far end of the warp, so
  // runAbility's same-frame hand-off is skipped and advanceNonHitbox registers it
  // once the charge is up. teleportDelayFrames is how long the charge runs for
  // and teleportDone latches the warp so it can only ever fire once.
  attr.deferStrike = false;
  attr.teleportDelayFrames = 0;
  attr.teleportDone = false;
  attr.totalFrames = rdef.abilityType === 'nonHitbox'
    ? Math.max(1, rdef.abilityFrames || (rdef.startup + rdef.active + rdef.recovery))
    : rdef.startup + rdef.active + rdef.recovery;
  attr.hitIds = _hitIdPool.pop() || new Set();
  if (!attr.hitboxIds || attr.hitboxIds.length) attr.hitboxIds = [];
  if (attr.abilityType === 'nonHitbox') {
    // Non-hitbox attacks never touch the hitbox registry.
    attr.hitboxIds = [];
  }
  // Starting a swing cancels a dodge.
  fighter.dodging = false;
  fighter.dodgeTimer = 0;
  fighter.wavedashing = false;
  // Â§45: stamp the global attack-start lock. Measured from THIS start, so a
  // quick jab (0.27s) still enforces a real gap while a long smash (0.57s)
  // naturally satisfies most of it. Every attack type flows through here â€”
  // melee, ability, projectile, character-specific â€” so none can bypass it.
  fighter.attackCooldown = ATTACK_DELAY;

  // Aerial Light recovery bonus: the airborne Light move doubles as a strong
  // upward recovery. On launch we override the attacker's downward velocity so
  // falling speed never eats the assist, then arm the finite launch buff (gravity
  // reduction + boosted air steer, consumed by Fighter.js physics/input every
  // frame). No VFX: a recovery paints nothing. Only when airborne â€” the grounded
  // Light press is completely untouched.
if (sel.key === 'aerialLight' && !fighter.grounded) {
    // Check if aerial light recovery is available (needs ground touch to recharge)
    if (fighter.canUseAerialLightRecovery) {
        // Apply strong upward recovery boost
        fighter.vy = -AERIAL_LIGHT_RECOVERY_FORCE;
        fighter.fastFalling = false;
        fighter._aerialRecoveryTimer = AERIAL_LIGHT_RECOVERY_DURATION;
        // Mark as used - needs ground touch to recharge
        fighter.canUseAerialLightRecovery = false;
    }
    // If not available, just do normal aerial light (no recovery boost)
}

  // Swing voice, played only now â€” this is past every refusal gate (cooldown,
  // state, resources), so a move that was refused never makes a sound.
  playLightAttackVoice(fighter, sel.key);
  return true;
}

// The four light attacks that carry a recorded swing. A Set, not an object
// literal: an object would inherit toString/constructor, so a key like
// 'toString' would match and play a voice for a move that does not exist.
const LIGHT_ATTACK_KEYS = new Set(['jab', 'ftilt', 'aerialLight', 'aerialHeavy']);

// Play the committed swing's voice. The ninja's blade work and the cowboy's are
// separate recordings of the same four moves, chosen from the fighter's own
// character def â€” no second source of truth for "who is this fighter".
// Any other fighter (currently the boxer) shares the cowboy's grunt: there is no
// third recording yet, and a swing that makes no sound would be worse than a
// borrowed one.
function playLightAttackVoice(fighter, key) {
  if (!LIGHT_ATTACK_KEYS.has(key)) return;
  const def = fighter && fighter._fighterDef;
  if (def && def.id === 'ninja') SFX.slash();
  else SFX.cowboyM1s();
}


function variantForKey(key) {
  if (/^(utilt|usmash)$/.test(key)) return 'up';
  if (/^(dtilt|dsmash)$/.test(key)) return 'down';
  if (/^(ftilt|fsmash)$/.test(key)) return 'side';
  if (/^(aerialLight|aerialHeavy)$/.test(key)) return 'air';
  return 'neutral';
}

// [PROBE] Deterministic test-only entry: start a specific attack key with an
// explicit direction snapshot, exactly as selectAttackâ†’startAttack would for a
// fresh press of that move. Used by the runtime verification suite to exercise
// up/back variants that the keyboard path can't reliably produce (up is also the
// jump binding and holding back physically turns the fighter around).
export function startAttackForKey(fighter, key, dirOverride) {
  if (!fighter || !key) return false;
  const def = attacksFor(fighter)[key];
  if (!def) return false;
  // Reports the real outcome: false when the move's ability is on cooldown, so
  // a caller driving this directly can't believe a refused move came out.
  return startAttack(fighter, {
    key,
    def,
    variant: variantForKey(key),
    dir: dirOverride || { up: false, down: false, left: false, right: false },
  });
}

// Call once per frame, AFTER movement/physics/grounding have resolved (so the
// grounded/airborne check is the one the player is actually in right now) and
// right BEFORE attack frames advance (so a press starts counting this frame).
//
// This is the ONE attack-entry path: nothing else in the codebase sets
// `fighter.attack`.
export function combatInput(fighters, inputOverrides) {
  for (const fighter of fighters) {
    const ov = (inputOverrides && inputOverrides[fighter.playerNum]) || null;
    const ih = (ov && ov.isHeld) || isHeld;
    const ijp = (ov && ov.isJustPressed) || isJustPressed;
    // Â§43 block gating (SAME for human + AI â€” this is the only place
    // `shielding` is written). Holding block keeps working; RE-engaging
    // within BLOCK_COOLDOWN of a release is denied, so rapid
    // blockâ†’releaseâ†’block toggling cannot spam.
    const wantShield = ih(fighter.playerNum, 'shield');
    if (wantShield && (fighter.shieldCooldown || 0) > 0) {
      fighter.shielding = false;
    } else {
      if (!wantShield && fighter.shielding) fighter.shieldCooldown = BLOCK_COOLDOWN;
      fighter.shielding = wantShield;
    }

    // Age any queued attack press. The buffer lives exactly BUFFER_FRAMES
    // updates and dies naturally.
    if (fighter.attackBuffer) {
      fighter.attackBuffer.frames--;
      if (fighter.attackBuffer.frames <= 0) fighter.attackBuffer = null;
    }

    // Â§45 attack gate: no new attack may START within ATTACK_DELAY of the
    // previous start. Buffered presses survive only their 5-frame window, so
    // mashing cannot shortcut the lock â€” but a well-timed press fires the
    // exact frame it clears, preserving combo rhythm.
    const busy = fighter.hitstun > 0 || fighter.attack || fighter.dodging
      || fighter._hitLock != null || (fighter.attackCooldown || 0) > 0;

    if (busy) {
      // Queue a press made while mid-swing / mid-dodge so it fires the moment
      // the fighter is free again. Never queue during hitstun (buffering must
      // not bypass hitstun), and don't overwrite a queued input. The direction
      // is snapshotted NOW so the buffered attack's side is already decided.
      if (fighter.hitstun <= 0 && !fighter.attackBuffer) {
        const p = fighter.playerNum;
        if (ijp(p, 'attack')) fighter.attackBuffer = { type: 'attack', frames: BUFFER_FRAMES, dir: readDir(p, ov) };
        else if (ijp(p, 'special')) fighter.attackBuffer = { type: 'special', frames: BUFFER_FRAMES, dir: readDir(p, ov) };
      }
      continue;
    }

    // A queued press executes on the first free frame, ahead of fresh presses.
    // The direction was captured when the press was buffered (buf.dir).
    if (fighter.attackBuffer) {
      const buf = fighter.attackBuffer;
      const sel = selectAttack(fighter, buf.type, buf.dir, ov);
      fighter.attackBuffer = null;
      if (sel) startAttack(fighter, sel);
      continue;
    }

    // Fresh press: capture direction snapshot at the exact moment of the attack
    // press to handle simultaneous D+K / A+K presses where the direction keydown
    // might be processed in the same frame but we want the direction at press time.
    const p = fighter.playerNum;
    const lightPress = ijp(p, 'attack');
    const heavyPress = ijp(p, 'special');
    if (lightPress || heavyPress) {
      const dirSnapshot = readDir(p, ov);
      const type = lightPress ? 'attack' : 'special';
      const sel = selectAttack(fighter, type, dirSnapshot, ov);
      if (sel) startAttack(fighter, sel);
    }
  }
}

// â”€â”€ Attack frame machine â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// startup â†’ active â†’ recovery â†’ finished. A whiffed attack STILL plays its
// full recovery; the hitbox only exists during the active window.
function advanceAttack(fighter, fighters, dt) {
  const a = fighter.attack;
  const def = a.def;
  if (a.abilityType === 'nonHitbox') return advanceNonHitbox(fighter, fighters, dt);
  const total = def.startup + def.active + def.recovery;
  a.frame++;

  let phase;
  if (a.frame <= def.startup) phase = 'startup';
  else if (a.frame <= def.startup + def.active) phase = 'active';
  else if (a.frame <= total) phase = 'recovery';
  else phase = 'finished';

  if (phase !== a.phase) {
    a.phase = phase;
    if (phase === 'active') {
      // Prepare to spawn one or more per-hitbox rects during this window.
      a.hitboxIds = [];
      a.spawnedHitboxes = _spawnedPool.pop() || new Set();
      a.spawnedHitboxes.clear();
      // Aerial Heavy: give the attacker an upward boost when the attack becomes active
      if (a.key === 'aerialHeavy') {
        // 285 = 380 x 0.75 (aerial lift reduction): aerials lift noticeably less
        // than before, so the attacker stays near its own altitude instead of
        // floating upward. This is the ATTACKER's own lift - how high the
        // VICTIM pops is a separate knob (vyScale on the attack def, applied in
        // computeLaunch). Kept per-move so aerialLight/aerialHeavy can diverge.
        // The boxer's Air Uppercut is the exception: its instant lift is halved
        // so the move stays a close-range rising punch instead of a free
        // recovery — the victim's launch (vyScale) is untouched.
        const isBoxer = fighter._fighterDef && fighter._fighterDef.id === 'boxer';
        const upwardBoost = isBoxer ? 140 : 285; // upward velocity boost (px/s)
        fighter.vy = -Math.abs(upwardBoost); // negative = upward in canvas coords
      }
    } else if (phase === 'recovery') {
      // Recovery: no damaging collision whatsoever.
      for (const id of a.hitboxIds) {
        const hb = hitboxes.get(id);
        if (hb) hb.active = false;
      }
      // Apply attacker recovery (recoil) â€” independent of target knockback.
      const recX = def.recoveryX || 0;
      const recY = def.recoveryY || 0;
      const recDur = def.recoveryDuration || 0;
      if (recX !== 0 || recY !== 0) {
        const facing = fighter.facingRight ? 1 : -1;
        // recoveryX is relative to facing (positive = backward recoil)
        fighter.vx += recX * facing;
        fighter.vy += recY;
        // If duration > 0, sustain the force for that many frames.
        if (recDur > 0) {
          const rf = _recForcePool.pop() || {};
          rf.x = recX * facing; rf.y = recY; rf.framesLeft = recDur;
          a.recoveryForce = rf;
        }
      }
    }
  }

  if (phase === 'finished') {
    destroyAttackHitboxes(fighter); // also releases the attack object
    return;
  }

  // Apply sustained recovery force during recovery phase
  if (a.phase === 'recovery' && a.recoveryForce && a.recoveryForce.framesLeft > 0) {
    fighter.vx += a.recoveryForce.x;
    fighter.vy += a.recoveryForce.y;
    a.recoveryForce.framesLeft--;
    if (a.recoveryForce.framesLeft <= 0) {
      a.recoveryForce = null;
    }
  }

// During the active window, spawn each hitbox exactly when its per-hitbox
    // startFrame/duration window begins, then keep it positioned.
    if (a.phase === 'active') {
      // Hitbox timing is stored in ABSOLUTE animation-timeline frames â€” the same
      // numbering the animator scrubs and the editor previews, so what you see on
      // the timeline is exactly when the box is live in-game. a.frame starts at 1
      // on the first update, so t = a.frame - 1 is the 0-based attack/timeline
      // frame that matches the editor's floor(frame).
      const t = a.frame - 1;
      const hbs = hitboxList(def);
      for (let i = 0; i < hbs.length; i++) {
        if (a.spawnedHitboxes && a.spawnedHitboxes.has(i)) continue;
        const hb = hbs[i];
        // Explicit boxes carry their own absolute-frame window. A plain attack
        // def (no `hitboxes` member) is its own implicit single box: it must span
        // the whole active phase â€” [startup, startup+active) â€” or attacks whose
        // startup >= active would never spawn a damaging box at all.
        const start = hb.startFrame != null ? hb.startFrame : (def.startup != null ? def.startup : 0);
        const dur = hb.duration != null ? hb.duration : def.active;
        if (t >= start && t < start + dur) {
          // Reused 2-slot scratch instead of a fresh [facing] / [f, -f] literal â€”
          // this loop runs on every ACTIVE frame, not just the spawn frame.
          _facingScratch[0] = a.facing;
          const sides = def.bothSides ? 2 : 1;
          if (sides === 2) _facingScratch[1] = -a.facing;
          for (let s = 0; s < sides; s++) {
            a.hitboxIds.push(registerHitbox(fighter, hb, _facingScratch[s], a.hitIds).id);
          }
          if (!a.spawnedHitboxes) { a.spawnedHitboxes = _spawnedPool.pop() || new Set(); a.spawnedHitboxes.clear(); }
          a.spawnedHitboxes.add(i);
        }
      }
      for (const id of a.hitboxIds) {
        const hb = hitboxes.get(id);
        if (hb && hb.active) positionHitbox(hb, fighter, hb.facing, hb.def);
      }
    }
}

// Non-hitbox attacks never register a hitbox: the ability fires exactly once
// at castFrame and the attack holds for totalFrames. `phase` is 'startup'
// until the cast, 'active' after â€” never 'recovery' â€” so the animation plays
// for the full ability duration.
function advanceNonHitbox(fighter, fighters, dt) {
  const a = fighter.attack;
  a.frame++;
  if (a.frame >= a.castFrame && !a.abilityCastDone) {
    a.abilityCastDone = true;
    runAbility(fighter, a, fighters);
  }

  // Deferred cast â€” the Teleport Strike's charge. A `warp`-style ability is cast
  // in two beats: run() fires on the cast frame (arming the charge), then the
  // ability's warp() is called here once the delay it asked for has actually
  // elapsed ON THE ATTACK'S OWN FRAME CLOCK â€” the same counter the cast, the
  // animation and the hitbox windows already run on, so the charge is a real
  // 0.8s of game time and cannot drift with the frame rate.
  //
  // Combat owns the clock and the ability owns the behaviour: it knows nothing
  // about teleports, only that an ability may expose a `warp` to call back once
  // its own delay is up (abilities.js must not import combat.js â€” the armed
  // fighter._teleportPending flag is the bridge, same as the Deadeye's).
  //
  // The strike box is registered HERE, immediately after the warp, not back in
  // runAbility: the box belongs at the ninja's ARRIVAL point and faces the way
  // the warp chose, neither of which is known until the warp has happened.
  if (a.abilityCastDone && a.deferStrike && !a.teleportDone) {
    if (!fighter._teleportPending) {
      // The charge was cancelled from under us (hitstun / reset / respawn) â€” the
      // move ends with no teleport and no blow rather than warping late.
      a.teleportDone = true;
    } else if (a.frame >= a.castFrame + (a.teleportDelayFrames || 0)) {
      a.teleportDone = true;
      const ab = getAbility(a.abilityId);
      if (ab && ab.warp) {
        _abilityCtx.fighters = fighters;
        _abilityCtx.stage = _combatStage;
        ab.warp(fighter, a, a.def.abilityCfg || {}, _abilityCtx);
        _abilityCtx.fighters = null;
        _abilityCtx.stage = null;
      }
      // The charge is spent: the flag is cleared whether or not the warp found
      // anything, so a stale arm can never survive into the next cast.
      fighter._teleportPending = null;
      registerStrikeHitbox(fighter, a);
    }
  }

  // Ability strike upkeep (Shadow Strike): the box runAbility registered above
  // is a normal registry hitbox, so all this does is keep it glued to the
  // fighter while its damage window runs â€” the attack table's own `active`
  // frames, counted from the cast â€” and switch collision OFF the instant that
  // window closes, exactly as the melee machine does when it leaves its active
  // phase. The box itself is still released by destroyAttackHitboxes with the
  // move. (Same shape as the cowboy mount's per-frame hitbox upkeep.)
  const strike = a.strikeHitboxId ? hitboxes.get(a.strikeHitboxId) : null;
  if (strike && strike.active) {
    if (a.strikeFramesLeft > 0) {
      a.strikeFramesLeft--;
      positionHitbox(strike, fighter, strike.facing, strike.def);
      fighter._strikeRenderTimer = HIT_RENDER_LINGER;
    } else {
      strike.active = false;
    }
  }

  // Deadeye stepping is NOT driven here: it is fighter-owned (survives this
  // attack's end) and runs every frame from updateProjectiles below.
   
  a.phase = a.frame >= a.castFrame ? 'active' : 'startup';
  if (a.frame >= a.totalFrames) destroyAttackHitboxes(fighter);
  
  // Shadow Dash upkeep: while the dash burst is live, re-assert the
  // cast-captured forward velocity every frame. The attack record's facing was
  // synced at the cast, so this pins the dash to that direction for its whole
  // duration â€” nothing (world coords, target position, facing drift) can
  // reverse or redirect it mid-dash. Ends on its own when dashTimer expires.
  if (a.abilityId === 'ninjaDsmash' && fighter.dashing && fighter.dashTimer > 0
      && fighter._shadowDashSpeed) {
    fighter.vx = a.facing * fighter._shadowDashSpeed;
  }

  // Update Shadow Strike VFX with actual distance traveled if this is the ninjaDsmash ability
  if (a.abilityId === 'ninjaDsmash' && fighter._tempVfx && fighter._tempVfx.length > 0) {
    // Find the shadow dash effect in temp VFX
    for (let i = 0; i < fighter._tempVfx.length; i++) {
      const vfx = fighter._tempVfx[i];
      if (vfx.effect === 'shadowDash') {
        // Calculate distance traveled since the dash started
        // We need to track the starting position when the dash began
        if (!vfx._startX) {
          vfx._startX = fighter.x - (vfx.offsetX || 0);
          vfx._startY = fighter.y - (vfx.offsetY || 0);
        }
        const distanceTraveled = fighter.x - vfx._startX;
        // Update the VFX params with the actual distance traveled
        if (!vfx.params) vfx.params = {};
        vfx.params.distance = Math.abs(distanceTraveled);
        break;
      }
    }
  }
}

// === DEADEYE: fighter-owned homing volley ===
// The cowboy Down Light cast hands combat a config via fighter._deadeyePending
// (abilities.js must not import combat.js â€” the flag is the bridge). Combat
// converts it into fighter._deadeye and keeps updating the volley EVERY frame,
// even after the triggering attack has ended, until every bullet has resolved.
//
//   fighter._deadeye = {
//     cfg,           // firing config (count, delay, speed, dmg, size â€¦)
//     target,        // the current opponent the volley is locked onto
//     shotsFired,    // bullets already spawned
//     resolved,      // bullets that have hit (or expired â€” the failsafe)
//     frameCount,    // real 60fps tick counter for the spawn cadence
//     spawnFrame,    // next real-time tick a shot fires on
//     spawnInterval, // real-time ticks between shots (shotDelay Ã— 60)
//   }
//
// Bullets are re-aimed at the target's CURRENT center every frame and resolve
// with a swept hit â€” the step is always along the line to that center, so a
// bullet can never tunnel past the hit circle (hit rule: dist <= step + reach).

function updateDeadeyeCombat(fighter, fighters, dt) {
  // Adopt an armed hand-off (fresh Down Light cast) when none is running.
  if (!fighter._deadeye && fighter._deadeyePending) {
    const cfg = fighter._deadeyePending;
    fighter._deadeyePending = null;
    let target = null;
    for (const f of fighters) {
      if (f && f !== fighter && f.state !== 'dead' && f.state !== 'respawn') { target = f; break; }
    }
    if (!target) return; // nothing to lock â€” never start an empty volley
    fighter._deadeye = {
      cfg,
      target,
      shotsFired: 0,
      resolved: 0,
      hits: 0,     // bullets that connected on the target (real hits)
      expired: 0,  // bullets that lifetime-expired without touching (failsafe)
      frameCount: 0,
      spawnFrame: 1, // the first shot fires on the very first update after cast
      spawnInterval: Math.max(1, Math.round((cfg.shotDelay || 0.09) * 60)),
    };
    fighter._deadeyeResult = null; // forget any previous volley's tally
  }

  const d = fighter._deadeye;
  if (!d) return;
  d.frameCount++;

  // Explicit termination: the locked-on target is gone. Release the world.
  if (d.target.state === 'dead' || d.target.state === 'respawn') {
    clearDeadeye(fighter);
    releaseTimeDilation();
    return;
  }

  const cfg = d.cfg;

  // Spawn shots on a REAL-time cadence (the world crawls while the bullets
  // rattle off one after another â€” the classic Deadeye rhythm), independent
  // of the time-dilation factor that slows everything else down.
  while (d.shotsFired < cfg.bulletCount && d.frameCount >= d.spawnFrame) {
    spawnHomingBullet(fighter, d.target, cfg);
    d.shotsFired++;
    d.spawnFrame += d.spawnInterval;
  }

  // Home every in-flight bullet onto the target's current center.
  updateHomingBullets(fighter, d.target, cfg, dt);

  // THE active condition: the Deadeye stays live until EVERY spawned bullet
  // has resolved â€” it never ends on animation finish, on the last spawn, on a
  // timer, or on visual proximity. (Bullet lifetime expiry is the failsafe
  // that guarantees this always terminates.)
  if (d.shotsFired >= cfg.bulletCount && d.resolved >= d.shotsFired) {
    // Preserve the volley tally beyond the live state (post-mortem for the
    // probe/tests): how many bullets hit vs expired.
    fighter._deadeyeResult = {
      fired: d.shotsFired,
      hits: d.hits,
      expired: d.expired,
      resolved: d.resolved,
    };
    clearDeadeye(fighter);
    releaseTimeDilation();
  }
}

// Hard teardown of a fighter's Deadeye (target gone, attacker respawned,
// match over, or the whole volley resolved). Idempotent.
export function clearDeadeye(fighter) {
  if (!fighter) return;
  fighter._deadeye = null;
  fighter._deadeyePending = null;
  if (fighter._deadeyeBullets) fighter._deadeyeBullets.length = 0;
  fighter._deadeyeBullets = null;
  if (fighter._deadeyeMuzzleFlashes) fighter._deadeyeMuzzleFlashes.length = 0;
  fighter._deadeyeMuzzleFlashes = null;
}

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// BOXER: the Grab and the Deadeye Assault - fighter-owned, stepped every frame
// Both moves outlive the frame that cast them (the Grab keeps holding its target
// after the attack's startup is over; the Assault keeps pummelling through its
// barrage), so neither is stepped by the attack machine. They live on the
// fighter and are driven from updateAttacks, exactly like the Deadeye volley
// and the horse - and the ability only ever ARMS them (abilities.js cannot
// import this module).
//
//   fighter._boxerGrab = { target, frames, hold, offset, punch, facing }
//   fighter._boxerAssault = { target, tick, ticks, timer, interval, dmg,
//                             offset, finale, facing }

// One opponent by id â€” the hand-off between the ability's cast and the stepper
// resolves the target a frame later, so the record is looked up rather than held.
function fighterById(fighters, id) {
  if (id == null) return null;
  for (const f of fighters) if (f && f.id === id) return f;
  return null;
}

// The Grab: pin the caught target in front of the boxer for the hold, then
// punch it away through the shared hit path. A held fighter is genuinely held â€”
// its attack is cancelled once, at the catch (interruptTarget releases its
// hitboxes and stops any swing), and its position is owned by the hold until the
// punch lands.
function updateBoxerGrab(fighter, fighters, dt) {
  // Adopt a fresh cast when nothing is being held. A second cast during a live
  // hold is impossible (the move is on the attack lock), but the guard costs
  // nothing and keeps the hand-off idempotent.
  if (fighter._boxerGrabPending) {
    const p = fighter._boxerGrabPending;
    fighter._boxerGrabPending = null;
    if (fighter._boxerGrab) releaseBoxerGrab(fighter, false);
    const target = fighterById(fighters, p.targetId);
    // The opponent can be gone between the cast and this frame (hit, KO'd, off
    // stage): the grab then simply never starts.
    if (target && target.state !== 'dead' && !target.eliminated) {
      interruptTarget(target);
      target.hitstun = Math.max(target.hitstun, 0.1);
      target.vx = 0;
      target.vy = 0;
      target.shielding = false;
      fighter._boxerGrab = {
        target,
        frames: 0,
        hold: p.holdFrames,
        offset: p.holdOffset,
        punch: p.punch,
        facing: p.facing,
      };
    }
  }

  const g = fighter._boxerGrab;
  if (!g) return;
  const target = g.target;
  // The hold belongs to the attack that started it. If that attack is gone (the
  // boxer was interrupted, the move ended early, the target left play) the hold
  // is released WITHOUT the punch â€” the boxer can never land a blow from an
  // attack that no longer exists.
  const live = target
    && target.state !== 'dead'
    && !target.eliminated
    && fighter.attack
    && fighter.attack.abilityId === 'boxerDtilt';
  if (!live) {
    releaseBoxerGrab(fighter, false);
    return;
  }

  g.frames += dt * 60;
  // Held in place, facing the boxer, with no velocity of its own to integrate.
  const dir = g.facing >= 0 ? 1 : -1;
  target.x = fighter.x + dir * g.offset;
  target.y = fighter.y;
  target.vx = 0;
  target.vy = 0;
  target.grounded = false;
  target.facingRight = dir < 0;

  if (g.frames >= g.hold) releaseBoxerGrab(fighter, true);
}

// End the hold. `punch` is the move's payoff: the target is thrown across the
// stage by the SHARED hit path (applyAbilityHit â†’ deliverHit), so the grab's
// punch obeys exactly the same damage, knockback, hit-confirm and hitstun rules
// as every other hit in the game instead of a private second damage path.
function releaseBoxerGrab(fighter, punch) {
  const g = fighter._boxerGrab;
  fighter._boxerGrab = null;
  if (!g) return;
  const target = g.target;
  if (!target || target.state === 'dead' || target.eliminated) return;
  if (!punch || !g.punch) return;

  const ix = target.x;
  const iy = target.y;
  // A punch the target slipped through (a Deadeye Roll dodge) resolves as no hit
  // at all, so it gets no impact: the art belongs to the blow, not to the swing.
  if (!applyAbilityHit(fighter, target, g.punch, g.facing)) return;

  // Impact art, PINNED to the point the punch landed: the target is already
  // flying away from it, and an effect that rode the boxer would slide out of
  // the hit it is meant to be standing in.
  const style = fxStyleFor(fighter);
  const r = (target.radius || fighter.radius || 22);
  const unit = (r * 2) / 44;
  spawnTempVfx(fighter, 'boxerPunchImpact', 0.34, 1, 0, 0, 0, {
    anchor: 'character',
    pinnedX: ix,
    pinnedY: iy,
    mirrorX: g.facing,
    params: { unit },
  });
  emitFlash(ix, iy, { style, radius: r * 0.5, life: 0.08, alpha: 0.85, color: '#fff3e0' });
  emitImpactRing(ix, iy, {
    style, wave: true, radius: r * 0.5, growth: r * 2.4,
    life: 0.3, alpha: 0.7, color: '#ff5252',
  });
  emitSparks(ix, iy, 7, {
    style, dir: g.facing >= 0 ? 0 : Math.PI, spread: 0.9, speed: 420,
    life: 0.16, size: 2.2, gravity: 140,
  });
  SFX.punch();
  SFX.launch();
}

// NOTE: the old Deadeye Roll buff (speed/damage/dodge window on _boxerRoll)
// was retired when Down Heavy became the Deadeye Assault (teleport + barrage).
// _boxerRoll is never armed anymore; the stepper below owns the move.



// BOXER: the Deadeye Assault (Down Heavy rework) — fighter-owned, stepped
// every frame like the Grab above. The ability (abilities.js boxerDsmash)
// only teleports the boxer behind the target and arms this; everything after
// lives here:
//   fighter._boxerAssault = { target, tick, ticks, timer, interval, dmg,
//                             offset, finale, facing }
// Each tick pins the target in front of the boxer and deals one fist blow
// through direct percent damage (no knockback mid-barrage — the target must
// stay in place for the next fist); the last tick ends in a launching finale
// through the SHARED hit path (launchFromHit), so shields, weight, hitstun
// and hit-confirm obey exactly the same rules as every other hit. The hold
// belongs to the attack that started it: if that attack is gone (the boxer
// was interrupted, the move ended, the target left play) the barrage ends
// WITHOUT the finale — no free blows from a dead move.
function updateBoxerAssault(fighter, fighters, dt) {
  if (fighter._boxerAssaultPending) {
    const p = fighter._boxerAssaultPending;
    fighter._boxerAssaultPending = null;
    if (fighter._boxerAssault) fighter._boxerAssault = null;
    const target = fighterById(fighters, p.targetId);
    if (target && target.state !== 'dead' && !target.eliminated && (target.invulnTimer || 0) <= 0) {
      interruptTarget(target);
      // Lock the target down for the whole barrage: 0.6s comfortably covers
      // the ~0.45s of ticks, so the victim cannot jab out mid-flurry. The
      // finale overwrites this with its own launch hitstun; an early drop
      // (boxer punished) leaves the remainder as the victim's punish window.
      target.hitstun = Math.max(target.hitstun, 0.6);
      target.vx = 0;
      target.vy = 0;
      fighter._boxerAssault = {
        target,
        tick: 0,
        ticks: Math.max(1, p.ticks || 5),
        timer: 0.06,
        interval: p.tickInterval || 0.09,
        dmg: p.tickDmg != null ? p.tickDmg : 1.2,
        offset: p.holdOffset || 46,
        finale: p.finale || null,
        facing: p.facing >= 0 ? 1 : -1,
      };
    }
  }

  const b = fighter._boxerAssault;
  if (!b) return;
  const target = b.target;
  const live = target
    && target.state !== 'dead'
    && !target.eliminated
    && (target.invulnTimer || 0) <= 0
    && fighter.attack
    && fighter.attack.abilityId === 'boxerDsmash';
  if (!live) {
    fighter._boxerAssault = null;
    return;
  }

  // Both fighters hang in place for the barrage — the boxer hovers through
  // its own gravity while the fists fly, and the target has no velocity of
  // its own to integrate.
  fighter.vx = 0;
  fighter.vy = 0;
  const dir = b.facing >= 0 ? 1 : -1;
  fighter.facingRight = dir >= 0;
  target.x = fighter.x + dir * b.offset;
  target.y = fighter.y;
  target.vx = 0;
  target.vy = 0;
  target.facingRight = dir < 0;

  b.timer -= dt;
  while (b.timer <= 0 && b.tick < b.ticks) {
    b.timer += b.interval;
    assaultTick(fighter, target, b, dir);
  }
  if (b.tick >= b.ticks) releaseBoxerAssault(fighter, true);
}

// One fist of the barrage. Direct percent damage (never knockback — the next
// fist still has to connect), alternating sides so the pummel reads as a
// flurry from both hands. Shielded targets take the same 0.1 chip the shared
// path applies; the finale handles a blocking target through launchFromHit.
function assaultTick(fighter, target, b, dir) {
  const r = target.radius || fighter.radius || 22;
  const side = b.tick % 2 === 0 ? 1 : -1;
  const px = target.x + side * r * 0.35;
  const py = target.y - r * 0.2;
  const shielded = target.shielding && !target.dodging;
  const dmg = b.dmg * (shielded ? 0.1 : 1);
  target.percent = Math.max(0, target.percent + dmg);
  spawnDamageNumber(px, py - r * 0.8, dmg, '#ff8a65');
  const style = fxStyleFor(fighter);
  emitFlash(px, py, { style, radius: r * 0.32, life: 0.07, alpha: 0.8, color: '#fff3e0' });
  emitSparks(px, py, 3, {
    style, dir: dir >= 0 ? 0 : Math.PI, spread: 1.0, speed: 320,
    life: 0.13, size: 1.8, gravity: 120,
  });
  SFX.punch();
  fighter._hitRenderTimer = HIT_RENDER_LINGER;
  b.tick++;
}

// End the barrage. `finale` is the payoff: the target is launched by the
// SHARED hit path (launchFromHit), with the pinned impact art riding the
// point the blow landed (the target is already flying away from it).
function releaseBoxerAssault(fighter, finale) {
  const b = fighter._boxerAssault;
  fighter._boxerAssault = null;
  if (!b) return;
  const target = b.target;
  if (!target || target.state === 'dead' || target.eliminated) return;
  if (!finale || !b.finale) return;
  const dir = b.facing >= 0 ? 1 : -1;
  const ix = target.x;
  const iy = target.y;
  const shielded = target.shielding && !target.dodging;
  launchFromHit(fighter, target, b.finale, dir, shielded, 'dsmash');
  const style = fxStyleFor(fighter);
  const r = target.radius || fighter.radius || 22;
  const unit = (r * 2) / 44;
  spawnTempVfx(fighter, 'boxerPunchImpact', 0.34, 1, 0, 0, 0, {
    anchor: 'character',
    pinnedX: ix,
    pinnedY: iy,
    mirrorX: dir,
    params: { unit },
  });
  emitFlash(ix, iy, { style, radius: r * 0.5, life: 0.08, alpha: 0.85, color: '#fff3e0' });
  emitImpactRing(ix, iy, {
    style, wave: true, radius: r * 0.5, growth: r * 2.4,
    life: 0.3, alpha: 0.7, color: '#ff5252',
  });
  emitSparks(ix, iy, 7, {
    style, dir: dir >= 0 ? 0 : Math.PI, spread: 0.9, speed: 420,
    life: 0.16, size: 2.2, gravity: 140,
  });
  SFX.launch();
}



// Drop every piece of fighter-owned boxer state (a respawn, a match reset, a
// knockout). Exported so the respawn path clears the grab and the assault
// exactly where it already clears the Deadeye volley and the Teleport charge
// a stock that just respawned must not inherit a held opponent or a live
// barrage.
export function clearBoxerState(fighter) {
  if (!fighter) return;
  const g = fighter._boxerGrab;
  if (g && g.target) {
    g.target.vx = 0;
    g.target.vy = 0;
  }
  fighter._boxerGrab = null;
  fighter._boxerGrabPending = null;
  fighter._boxerAssault = null;
  fighter._boxerAssaultPending = null;
}

// Get weapon muzzle (tip) position in world space
function getWeaponMuzzlePosition(fighter) {
  const out = { x: 0, y: 0 };
  if (fighter.anim && fighter.anim.out && fighter.anim.out.weapons) {
    const w = fighter.anim.out.weapons.right || fighter.anim.out.weapons.left;
    if (w && w.def) {
      const va = w.def.vfxAnchor || w.def.anchors?.tip || { x: 0, y: 0 };
      const sx = w.scaleX === undefined ? 1 : w.scaleX;
      const sy = w.scaleY === undefined ? 1 : w.scaleY;
      const r = (w.rot || 0) * Math.PI / 180;
      const c = Math.cos(r), s = Math.sin(r);
      out.x = w.px + c * va.x * sx - s * va.y * sy;
      out.y = w.py + s * va.x * sx + c * va.y * sy;
      return out;
    }
  }
  // Fallback: forward from fighter center
  const dir = fighter.facingRight ? 1 : -1;
  out.x = fighter.x + dir * 40;
  out.y = fighter.y - 10;
  return out;
}

// Spawn a single homing bullet aimed at the target's center at fire time.
function spawnHomingBullet(fighter, target, cfg) {
  const dir = fighter.facingRight ? 1 : -1;
  const muzzlePos = getWeaponMuzzlePosition(fighter);

  // Initial velocity straight at the target's CURRENT center.
  const toTargetX = target.x - muzzlePos.x;
  const toTargetY = target.y - muzzlePos.y;
  const dist = Math.hypot(toTargetX, toTargetY) || 1;
  const vx = (toTargetX / dist) * cfg.bulletSpeed;
  const vy = (toTargetY / dist) * cfg.bulletSpeed;

  const bullet = {
    owner: fighter,
    x: muzzlePos.x,
    y: muzzlePos.y,
    vx: vx,
    vy: vy,
    speed: cfg.bulletSpeed,
    angle: Math.atan2(vy, vx),
    r: cfg.bulletSize * 0.5,
    target: target, // Reference to target - will track CURRENT position
    homingStrength: cfg.homingStrength,
    trail: [],
    trailLength: cfg.trailLength,
    life: cfg.bulletLifetime || 5.0, // Use config lifetime
    maxLife: cfg.bulletLifetime || 5.0,
    dead: false,
    def: {
      name: 'Deadeye Bullet',
      dmg: cfg.bulletDamage,
      kbBase: cfg.bulletKBBase,
      kbGrowth: cfg.bulletKBGrowth,
      angle: cfg.bulletAngle,
      w: cfg.bulletSize,
      h: cfg.bulletSize,
      ox: 0,
      oy: 0,
    },
    facing: dir,
    bulletSize: cfg.bulletSize,
    trailColor: '#ffd54f',
    bodyColor: '#78828c',
    highlightColor: '#b0bec5',
  };

  // Initialize trail with current position
  for (let i = 0; i < cfg.trailLength; i++) {
    bullet.trail.push({ x: muzzlePos.x, y: muzzlePos.y });
  }

  if (!fighter._deadeyeBullets) fighter._deadeyeBullets = [];
  fighter._deadeyeBullets.push(bullet);

  // Muzzle flash effect
  if (!fighter._deadeyeMuzzleFlashes) fighter._deadeyeMuzzleFlashes = [];
  fighter._deadeyeMuzzleFlashes.push({
    x: muzzlePos.x,
    y: muzzlePos.y,
    angle: bullet.angle,
    size: cfg.bulletSize * 3.5,
    life: 4,
    maxLife: 4,
  });

  // Deliberately silent. This used to fire a synthesized shot sting per bullet,
  // which meant six of them 90ms apart â€” a warbling warble stacked on top of
  // itself that read as a "funny warp" noise rather than gunfire. The cast
  // already plays the Deadeye's own revolver recording (SFX.deadeyeShot in
  // abilities.js); a homing bullet needs no voice of its own.
}

// Update all homing bullets for a fighter. Each frame the bullet is re-aimed
// straight at the target's current center, then moves a swept step: because
// the whole step lies on the line to that center, the swept hit rule
//   dist <= speedÂ·dt + (target.radius + bullet.r + 8)
// guarantees the bullet registers the instant it would reach the hit circle â€”
// it can never pass through the target between checks.
function updateHomingBullets(fighter, target, cfg, dt) {
  const bullets = fighter._deadeyeBullets;
  if (!bullets || !bullets.length) return;

  const state = fighter._deadeye;

  // Reverse walk with in-place removal. The previous shape built a `deadBullets`
  // array, then for each dead bullet did an indexOf + splice over the live list
  // â€” an O(kÂ·n) identity sweep on top of the per-frame walk. Reverse iteration
  // makes a same-pass removal safe, so the `dead` flag alone is enough.
  for (let bi = bullets.length - 1; bi >= 0; bi--) {
    const bullet = bullets[bi];
    if (bullet.dead) {
      bullets.splice(bi, 1);
      continue;
    }

    // Homing: aim at the target's CURRENT center (continuously updated).
    const toTargetX = target.x - bullet.x;
    const toTargetY = target.y - bullet.y;
    const distSq = toTargetX * toTargetX + toTargetY * toTargetY;
    const step = bullet.speed * dt;
    const reach = target.radius + bullet.r + 8; // slack so it lands on the entity
    const arriveAt = step + reach; // always >= 0, so the test squares safely

    // Swept arrival check BEFORE moving â€” covers the whole step; no tunneling.
    // Compared on the SQUARED distance: the hit branch never needs the magnitude,
    // so a bullet that lands costs no sqrt at all (and Math.hypot's overflow-safe
    // scaling is avoided on the miss branch too).
    if (distSq <= arriveAt * arriveAt) {
      // Hit! Apply damage
      applyDeadeyeHit(fighter, target, bullet);
      bullet.dead = true;
      bullets.splice(bi, 1);
      if (state) { state.hits++; state.resolved++; }
      continue;
    }

    // Perfect homing: redirect the full velocity toward the target center.
    const dist = Math.sqrt(distSq);
    bullet.vx = (toTargetX / dist) * bullet.speed;
    bullet.vy = (toTargetY / dist) * bullet.speed;
    bullet.angle = Math.atan2(bullet.vy, bullet.vx);

    // Update position
    bullet.x += bullet.vx * dt;
    bullet.y += bullet.vy * dt;

    // Update trail. The newest point goes to the front and the oldest is dropped,
    // so once the trail is at its full length the dropped point is exactly the one
    // to reuse next frame: same array contents and order, zero allocation per
    // frame (this ran for every in-flight bullet on every frame, for the bullet's
    // whole dilated lifetime).
    const trail = bullet.trail;
    let pt;
    if (trail.length >= bullet.trailLength) {
      pt = trail.pop();
    } else {
      pt = { x: 0, y: 0 };
    }
    pt.x = bullet.x;
    pt.y = bullet.y;
    trail.unshift(pt);

    // Lifetime failsafe â€” the ONLY way a bullet settles without touching the
    // locked target (should never trigger against a live opponent).
    bullet.life -= dt;
    if (bullet.life <= 0) {
      bullet.dead = true;
      bullets.splice(bi, 1);
      if (state) { state.expired++; state.resolved++; }
    }

    // NO BOUNDS CHECK - bullets should not expire due to arena bounds
    // They only expire on hit or lifetime
  }

  // Update muzzle flashes
  if (fighter._deadeyeMuzzleFlashes) {
    for (let i = fighter._deadeyeMuzzleFlashes.length - 1; i >= 0; i--) {
      const f = fighter._deadeyeMuzzleFlashes[i];
      f.life--;
      if (f.life <= 0) fighter._deadeyeMuzzleFlashes.splice(i, 1);
    }
  }
}

// Apply deadeye bullet hit â€” the same full hit resolution as melee hitboxes and
// ability projectiles (damage + knockback + hitstun), so a bullet that lands
// always counts on the percent meter.
function applyDeadeyeHit(attacker, target, bullet) {
  const def = bullet.def;
  const facing = attacker.facingRight ? 1 : -1;
  deliverHit(attacker, target, def, facing, 'deadeye');
  // The one hit flash that survives: it is the Deadeye volley itself painting its
  // own impact, so it belongs to the ability. Drawn in Effects.js.
  target._hitFlash = 0.15;
}

// Reused context object â€” no allocation per cast.
const _abilityCtx = { fighters: null, stage: null };

// The live stage, registered by the game when it builds one. Abilities that
// need to know where the stage actually is (a teleport that must not drop the
// fighter inside a platform or off the ledge) read it off the context instead of
// re-deriving the stage geometry â€” the stage stays owned by Game.js/Stage.js.
let _combatStage = null;
export function setCombatStage(stage) { _combatStage = stage || null; }

function runAbility(fighter, a, fighters) {
  const ab = getAbility(a.abilityId);
  if (!ab) return;
  _abilityCtx.fighters = fighters;
  _abilityCtx.stage = _combatStage;
  ab.run(fighter, a, a.def.abilityCfg || {}, _abilityCtx);
  _abilityCtx.fighters = null;
  _abilityCtx.stage = null;

  // Start this ability's cooldown HERE â€” at the cast, not at the attack start.
  // An attack interrupted between its startup and this frame (hitstun, a
  // respawn) therefore costs the player nothing, and a move interrupted after
  // the cast still pays for what it fired. runAbility is the one place every
  // ability fires, so one stamp covers the whole registry.
  const cd = abilityCooldownFor(a.abilityId);
  if (cd > 0) stampAbilityCooldown(fighter, a.abilityId, cd);

  // Initialize Shadow Strike VFX tracking for distance calculation
  if (a.abilityId === 'ninjaDsmash' && fighter._tempVfx && fighter._tempVfx.length > 0) {
    // Find the shadow dash effect in temp VFX and set start position
    for (let i = 0; i < fighter._tempVfx.length; i++) {
      const vfx = fighter._tempVfx[i];
      if (vfx.effect === 'shadowDash') {
        vfx._startX = fighter.x - (vfx.offsetX || 0);
        vfx._startY = fighter.y - (vfx.offsetY || 0);
        break;
      }
    }
  }
  
  // The cowboy's Down Smash mounts a horse: register its trampling hitbox the
  // moment it materializes so it is live from the cast frame (and tests that
  // drive the attack pipeline without updateProjectiles still resolve it).
  const horse = fighter._horse;
  if (horse && !horse.hitboxId) {
    const hb = registerHitbox(fighter, horse.def, horse.dir, a.hitIds);
    a.hitboxIds.push(hb.id);
    horse.hitboxId = hb.id;
    hb.x = horse.x - hb.w / 2;
    hb.y = horse.y - hb.h / 2;
  }
  // An ability that LANDS A BLOW (Shadow Strike's dash-strike, the Teleport
  // Strike) hands its box to the SAME registry the melee machine uses â€”
  // see registerStrikeHitbox below, which is also what a delayed ability calls
  // when its own warp lands.
  //
  // `a.suppressStrike` is the ability's opt-out, set during its own cast when the
  // move decides it has nothing to hit (a teleport with no valid target): the
  // move then plays out as a plain whiff instead of swinging at empty space.
  // `a.deferStrike` is a DELAYED ability's opt-OUT of this hand-off: it registers
  // the box itself once its charge is up (see advanceNonHitbox), because the box
  // belongs at the far end of a warp, not where the move was cast.
  if (ab.strikeHitbox && !a.deferStrike) registerStrikeHitbox(fighter, a);
}

// Hand an ability's own attack-table def to the SAME registry the melee machine
// uses: registerHitbox creates it, resolveHits/applyHit resolve damage,
// knockback, hitstun, shields and the one-hit-per-target rule, and the box rides
// `a.hitboxIds` so destroyAttackHitboxes releases it with the move. The ability
// supplies only the timing (its own cast frame + the attack table's `active`
// window, kept alive by advanceNonHitbox) â€” there is no second collision or
// damage path anywhere.
//
// Called from two places, and that is the point: an immediate ability calls it
// on its cast frame, a delayed one calls it the moment its warp lands. Both hand
// over the same def at the same phase of the move, so the two can never diverge.
function registerStrikeHitbox(fighter, a) {
  if (a.strikeHitboxId || a.suppressStrike) return;
  const hb = registerHitbox(fighter, a.def, a.facing, a.hitIds);
  a.hitboxIds.push(hb.id);
  a.strikeHitboxId = hb.id;
  a.strikeFramesLeft = Math.max(1, a.def.active || (a.totalFrames - a.castFrame));
}

// Tear down a mount: release its hitbox (if it survived its attack) and drop
// the entity. Idempotent â€” also reached through destroyAttackHitboxes so a
// finished / interrupted / reset ride never lingers.
export function removeHorse(fighter) {
  if (!fighter || !fighter._horse) return;
  const horse = fighter._horse;
  if (horse.hitboxId) {
    const hb = hitboxes.get(horse.hitboxId);
    if (hb) {
      hitboxes.delete(horse.hitboxId);
      hb.def = null;
      hb.hitIds = null;
      _hitboxPool.push(hb);
    }
    horse.hitboxId = 0;
  }
  fighter._horse = null;
}

// â”€â”€ Collision + hit resolution â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function resolveHits(fighters) {
  if (hitboxes.size === 0) return;
  // Breakables ride the SAME hitbox pass, not a parallel one: an active
  // attack's rect is tested against every registered destructible here, and the
  // damage comes from the very same attack def the fighter pass uses. A board
  // only ever loses durability from this â€” it never receives knockback, hitstun
  // or a hit-confirm lock, and nothing about the fighter loop changes. The
  // list is null outside the sandbox, so the whole extension costs one null
  // check on a stage with no breakables in it.
  const destructibles = destructibleList();
  // Broadphase: hurtboxes are refreshed once per frame into a scratch array so
  // the inner loop is a cheap squared-distance reject before the exact AABB.
  const nf = fighters.length;
  for (let _i = 0; _i < nf; _i++) {
    const t = fighters[_i];
    _hbCache[_i] = t ? getHurtbox(t) : null;
  }
  for (const hb of hitboxes.values()) {
    if (!hb.active) continue;
    const attacker = hb.owner;
    const hbcx = hb.x + hb.w * 0.5;
    const hbcy = hb.y + hb.h * 0.5;
    const hbr = (hb.w > hb.h ? hb.w : hb.h) * 0.5 + 46;
    const hbr2 = hbr * hbr;
    for (let _ti = 0; _ti < nf; _ti++) {
      const target = fighters[_ti];
      if (!target || target === attacker) continue;
      if (target.invulnTimer > 0) continue;
      if (hb.hitIds.has(target.id)) continue;
      const dx = target.x - hbcx;
      const dy = target.y - hbcy;
      if (dx * dx + dy * dy > hbr2 + target.radius * target.radius * 4) continue;
      if (aabb(hb, _hbCache[_ti])) {
        hb.hitIds.add(target.id);
        applyHit(attacker, target, hb, attacker.attack ? attacker.attack.key : null);
      }
    }
    if (!destructibles) continue;
    for (let i = 0; i < destructibles.length; i++) {
      const d = destructibles[i];
      if (d.dead || hb.hitIds.has(d.id)) continue;
      if (hb.x < d.x + d.width && hb.x + hb.w > d.x && hb.y < d.y + d.height && hb.y + hb.h > d.y) {
        hb.hitIds.add(d.id);
        hitDestructible(d, hb.def);
      }
    }
  }
}

// One hit's worth of durability. The amount is the move's own damage scaled by
// the kind's damageScale, so a board breaks under a similar amount of pressure
// any given attack actually exerts â€” a light attack chips it, a heavy takes a
// real chunk, and a projectile (which carries a much larger dmg) blows through
// it. The minimum keeps a zero-damage utility hit from being a no-op.
function hitDestructible(d, def) {
  const kind = d._kind;
  const scale = kind ? kind.damageScale : 6;
  const floor = kind ? kind.minDamage : 2;
  const amount = Math.max(floor, ((def && def.dmg) || 0) * scale);
  damageDestructible(d, amount, d.x + d.width / 2, d.y + d.height / 2);
}

function applyHit(attacker, target, hb, key) {
    deliverHit(attacker, target, hb.def, hb.facing, key);
}

// Shared hit resolution â€” used by melee hitboxes and ability projectiles so a
// projectile connects with exactly the same damage/knockback/hitstun rules.
// Returns whether the hit actually landed: a Deadeye Roll dodge resolves through
// this same function and must report itself, so a punch that a rolling target
// slipped past does not play an impact it never caused.
export function applyAbilityHit(attacker, target, def, facing) {
    return deliverHit(attacker, target, def, facing);
}

// â”€â”€ Cowboy launcher (per-character knockback override) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€


// â”€â”€ Damage + knockback calculator (central) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// One shared rule for every hit in the game â€” melee hitboxes and ability
// projectiles all resolve through deliverHit. The shape follows COMBAT.txt Â§6:
//   kb = (dmg * 7 + (kbBase + kbGrowth * defenderPercent))
//        * (1 + defenderPercent / 80) * koPower / defenderWeight
// Damage (the percent meter) and knockback are separate concepts: damage is
// added to the target's meter, knockback is a launch vector derived from the
// target's NEW percent, the attack's base/growth/angle, koPower and weight.
//
// Weight comes from the character roster (documented range 0.85â€“1.25). Missing
// or out-of-range values fall back to 1.0 so an unset field never explodes.
function targetWeight(target) {
  const w = target && target._fighterDef && target._fighterDef.weight;
  if (typeof w === 'number' && w >= 0.85 && w <= 1.25) return w;
  return 1.0;
}

// Horizontal launch direction: targets launch AWAY from the attacker. Derived
// from the target's side relative to the attacker at hit time â€” never from the
// attacker's current facing, so a facing change can't reverse a launch. When
// the target is nearly centered on the attacker the hitbox's own direction
// decides (e.g. the outward legs of a bothSides dsmash). An explicit def.kbDir
// (projectiles) always wins.
function resolveHitDir(attacker, target, def, hitboxFacing) {
  if (def.kbDir === 1 || def.kbDir === -1) return def.kbDir;
  const dx = target.x - attacker.x;
  if (Math.abs(dx) < (attacker.radius + target.radius) * 0.65) {
    return hitboxFacing >= 0 ? 1 : -1;
  }
  return dx >= 0 ? 1 : -1;
}

// The one knockback computation. Returns the launch velocity (px/s) and the
// raw knockback magnitude (used for hitstun scaling). `opts.kbMul` carries the
// existing modifiers (e.g. the shield reduction 0.08).
//
// ATTACK-SPECIFIC LAUNCH (no generic x>y branching anywhere): every attack
// owns `launchAngle` (deg: 0 = forward, + = up, - = down). `angle` is a legacy
// alias kept for custom boxes. The launch vector is cos/sin of THAT attack's
// own angle, mirrored only by hitDir (away-from-attacker). Side attacks
// (â‰ˆ15-38Â°) fly mostly horizontal, up attacks (â‰ˆ70-88Â°) fly up, down attacks
// (â‰ˆ-45Â°/-10Â°) spike/angle down, aerials use their own direction. Generic
// collision geometry never picks the direction. `horizontalKnockback` /
// `verticalKnockback` are per-attack metadata documenting the intended axis
// mix (kept in sync with launchAngle); physics uses launchAngle directly.
// Global knockback factor â€” per-attack kbBase/kbGrowth were already halved
// (Ã—0.50) in the tables above, so this stays at its tuned value.
const KNOCKBACK_GLOBAL_MULTIPLIER = 0.55;
function computeKnockbackVector(target, def, opts) {
  const hitDir = opts.hitDir || 1;
  const kbMul = opts.kbMul || 1;
  const angle = opts.angle != null ? opts.angle
    : (def.launchAngle != null ? def.launchAngle : def.angle);
  const percent = target.percent;
  const dmg = def.dmg || 0;
  const base = def.kbBase || 0;
  const growth = def.kbGrowth || 0;
  const ko = def.koPower && def.koPower > 0 ? def.koPower : 1;
  const weight = targetWeight(target);
  const raw = (dmg * 7 + (base + growth * percent)) * (1 + percent / 80) * ko / weight;
  const kb = Math.max(0, raw) * kbMul * KNOCKBACK_GLOBAL_MULTIPLIER;
  const rad = ((angle || 0) * Math.PI) / 180;
  const vx = Math.cos(rad) * kb * hitDir;
  // Canvas Y increases downward, so a positive angle is an upward launch.
  let vy = -Math.sin(rad) * kb;
  // Â§20: Aerial Heavy vertical softening â€” vyScale 0.25 quarters the upward
  // launch (was 0.5) while the move still launches upward (angle kept) and
  // horizontal (vx) plus attack behavior are untouched. Both the cowboy's and
  // the ninja's aerialHeavy share this value so the two characters lift the
  // same amount.
  if (def.vyScale != null && Number.isFinite(def.vyScale)) vy *= def.vyScale;
  let outVx = vx;
  if (def.spike) outVx *= 0.55; // spike: launch mostly straight down
  return { vx: outVx, vy, kb };
}

// â”€â”€ Hit-confirm lock â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// `hitConfirm` attacks defer their knockback: on a successful hit both fighters
// freeze in place for the lock duration, then the stored knockback launches the
// target exactly as a normal hit would. (No default move uses it today, but the
// hook is data-driven and reachable from any attack def.) The lock
// object looks the same on both sides:
//   { attacker|target: null|fighter, def: def|null, hitDir, key, timer }
// A whiffed attack never sets a lock â€” it only exists after a hit resolves,
// and it always self-clears (timer) or is cleared by a reset/interrupt.
function attachHitLock(attacker, target, def, hitDir, duration, key) {
  clearHitLocks(attacker);
  clearHitLocks(target);
  // Freeze both fighters from the very frame the lock attaches: the hit does
  // not apply any velocity until the stored launch resolves.
  target.vx = 0;
  target.vy = 0;
  attacker.vx = 0;
  attacker.vy = 0;
  target._hitLock = { attacker, target: null, def, hitDir, key, timer: duration };
  attacker._hitLock = { attacker: null, target, def: null, hitDir: 0, key: null, timer: duration };
}

// Clear a lock plus its counterpart on the other fighter in the transaction.
export function clearHitLocks(fighter) {
  const lock = fighter._hitLock;
  if (!lock) return;
  const peer = lock.attacker || lock.target;
  if (peer && peer._hitLock) {
    const peerLock = peer._hitLock;
    const ppeer = peerLock.attacker || peerLock.target;
    if (ppeer === fighter) peer._hitLock = null;
  }
  fighter._hitLock = null;
}

// Advance lock timers each frame. When a lock expires the launch is applied
// from the target side (the holder of `def`) before both sides clear, so the
// deferred knockback is always applied exactly once.
function updateHitConfirm(fighters, dt) {
  for (const f of fighters) {
    const lock = f._hitLock;
    if (lock) lock.timer -= dt;
  }
  for (const f of fighters) {
    const lock = f._hitLock;
    if (lock && lock.timer <= 0 && lock.def) {
      launchFromHit(lock.attacker, f, lock.def, lock.hitDir, false, lock.key);
    }
  }
  for (const f of fighters) {
    const lock = f._hitLock;
    if (lock && lock.timer <= 0) clearHitLocks(f);
  }
}

// Cancel whatever the target was doing so a launch has full control of it.
function interruptTarget(target) {
  destroyAttackHitboxes(target);
  target.attack = null;
  target.attackBuffer = null; // a launch wipes any queued attack press
  target.dodging = false;
  target.dodgeTimer = 0;
  target.wavedashing = false;
  target.fastFalling = false;
  target.grounded = false;
  target.groundPlatform = null;
  target.groundType = null;
}

function deliverHit(attacker, target, def, facing, key) {
  const shielded = target.shielding && !target.dodging;

  // Shield interaction: the hit still registers, it is just heavily reduced.
  const dmgMul = shielded ? 0.1 : 1;
  const landedDamage = (def.dmg || 0) * dmgMul;
  target.percent = Math.max(0, target.percent + landedDamage);

  // Floating damage indicator at the point of impact (tinted per attacker).
  // Shielded hits read as a small cyan number instead of the attacker color.
  spawnDamageNumber(
    target.x + (Math.random() * 20 - 10),
    target.y - target.radius - 8,
    landedDamage,
    shielded ? '#7fd4ff' : (attacker.playerNum === 1 ? '#8fc3ff' : '#ff9d9d')
  );

  const hitDir = resolveHitDir(attacker, target, def, facing);

  // Hit-confirm lock: damage lands now, the launch is deferred through a brief
  // freeze of both fighters (see updateHitConfirm).
  if (!shielded && def.hitConfirm > 0) {
    interruptTarget(target);
    attachHitLock(attacker, target, def, hitDir, def.hitConfirm, key);
    // No re-hits and no projectile interference while the lock is live.
    target.invulnTimer = Math.max(target.invulnTimer, def.hitConfirm + HIT_FEEDBACK_INVULN);
    attacker._hitRenderTimer = HIT_RENDER_LINGER;
    SFX.hit();
    return true;
  }

  // Shuriken hit-lock: apply normal hit, then lock target for brief period
  // (prevent movement but allow hitstun to expire normally)
  if (!shielded && def.hitLockDuration > 0) {
    // Apply normal hit first (damage, knockback, hitstun)
    launchFromHit(attacker, target, def, hitDir, shielded, key);

    // A lock that is already running is NEVER extended: a second shuriken
    // that lands mid-lock still deals its damage/knockback above, but the
    // freeze window keeps its original expiry so volleys can't stun-lock.
    if ((target._hitLockTimer || 0) <= 0) {
      const lockDuration = def.hitLockDuration;
      target._hitLockTimer = lockDuration;
      target._hitLockVsx = target.vx; // Stored knockback resumes on release
      target._hitLockVsy = target.vy;
      target.vx = 0;
      target.vy = 0;
      // The spin the player sees during the lock is the shuriken ITSELF: the
      // projectile that landed is buried in the target and kept spinning there
      // for this same window (see updateProjectiles), drawn with the real
      // shuriken.png. Nothing is spawned on the target here â€” a second
      // procedural star would just be a duplicate of the sprite that is already
      // on screen, so the lock stays purely mechanical (above) and visual.
    }

    SFX.hit();
    return true;
  }

  launchFromHit(attacker, target, def, hitDir, shielded, key);
  return true;
}

// Apply the launch portion of a hit: knockback vector + hitstun + air state.
function launchFromHit(attacker, target, def, hitDir, shielded, key) {
  let kbMul = shielded ? 0.08 : 1;
  let angle = def.angle;
  const { vx, vy, kb } = computeKnockbackVector(target, def, { hitDir, kbMul, angle });
  const groundedBefore = target.grounded;
  interruptTarget(target);
  // A downward launch on a grounded fighter would slam straight into the floor,
  // wasting the knockback in a single frame. Ground-angled hits instead keep the
  // fighter on the ground and slide them along it: the down component becomes
  // horizontal skid at full hitstun (friction is skipped during hitstun).
  if (groundedBefore && !shielded && vy > 0) {
    target.grounded = true;
    target.vx = vx;
    target.vy = 0;
  } else {
    target.vx = vx;
    target.vy = vy;
  }
  // Hitstun scales with knockback (and thus with damage percent + weight).
  // Raised slope (0.0009 â†’ 0.0012) + cap (Â§45 combo-compat): only meaningful
  // hits bridge the 0.83s start-lock, so combos come from heavies and
  // high-percent launches â€” never jab spam.
  target.hitstun = Math.min(HITSTUN_CAP, 0.03 + kb * 0.0012);
  target.invulnTimer = Math.max(target.invulnTimer, HIT_FEEDBACK_INVULN);

  if (shielded) SFX.deny();
  else SFX.hit();

  // Tiered hit feedback. The hit-stop is gameplay feel and stays; the screen
  // shake and the launch-trail particles that used to sit beside it are gone, so
  // a connecting hit paints nothing.
  if (!shielded) {
    if (kb > 520) {
      freezeGame(0.08);
    } else if (kb > 240) {
      freezeGame(0.04);
    }
  }

  // Rendering layering: this fighter is now the attacker and draws in front of
  // the target for the interaction window (Game.js render picks the draw order).
  attacker._hitRenderTimer = HIT_RENDER_LINGER;
}

// Main per-frame advance: finish attack frames, resolve hits, purge leftovers.
export function updateAttacks(fighters, dt) {
  for (const fighter of fighters) {
    if (fighter.attack) advanceAttack(fighter, fighters, dt);
    // Fighter-owned ability state: the boxer's Grab and Deadeye Assault outlive
    // the attack that started them, so they step here rather than in advanceAttack.
    // Ordered after the attack machine so a cast made this frame is adopted on
    // the same frame it fired.
    updateBoxerGrab(fighter, fighters, dt);
    updateBoxerAssault(fighter, fighters, dt);
    // Decay the attacker-over-target render window.
    if (fighter._hitRenderTimer > 0) {
      fighter._hitRenderTimer = Math.max(0, fighter._hitRenderTimer - dt);
    }
  }
  // Timed hit-confirm locks release before new hits are resolved this frame.
  updateHitConfirm(fighters, dt);
  resolveHits(fighters);
  // Safety net: no hitbox may outlive its attack. (destroyAttackHitboxes
  // already handles the normal paths; this catches any missed cleanup.)
  // Iterated by key + get() rather than destructuring each [id, hb] entry, and
  // skipped entirely when the registry is empty â€” which is the normal state of
  // most frames, where this was walking zero entries through a Map iterator.
  if (hitboxes.size) {
    for (const id of hitboxes.keys()) {
      const hb = hitboxes.get(id);
      if (!hb.owner.attack) {
        hitboxes.delete(id);
        hb.def = null;
        hb.hitIds = null;
        _hitboxPool.push(hb);
      }
    }
  }
}

// Arena bounds projectiles care about â€” matches Game.js' arena (1200Ã—1100) so
// projectiles die reaching the same off-screen blast edges in every context.
const ARENA = { width: 1200, height: 1100 };

// â”€â”€ Ability horses (mounts) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// A mounted fighter (fighter._horse, created by abilities.js) rides a horse
// that this loop keeps alive every frame:
//   â€¢ the rider is glued to the saddle (lifted above their standing height)
//   â€¢ the horse tracks the rider's position + facing (mirrors on turns)
//   â€¢ the pair rides forward at a constant speed
//   â€¢ the horse's trampling hitbox stays live + positioned (registered at cast)
function updateHorses(fighters) {
  for (const f of fighters) {
    const horse = f._horse;
    if (!horse) continue;
    // The attack that summoned the mount owns it â€” if it is gone, so is the ride.
    if (!f.attack) {
      removeHorse(f);
      continue;
    }
    // Stand on the horse's back for the whole ride.
    f.y = horse.rideBaseY + horse.lift;
    f.vy = 0;
    f.grounded = true;
    // Mirror facing + keep the horse glued beneath the rider.
    horse.dir = f.facingRight ? 1 : -1;
    horse.x = f.x + horse.dir * horse.fx;
    horse.y = f.y + horse.dy;
    // Ride forward.
    f.vx = horse.dir * horse.speed;
    // Registration fallback for any cast that skipped runAbility's hook.
    if (!horse.hitboxId && f.attack) {
      const hb = registerHitbox(f, horse.def, horse.dir, f.attack.hitIds);
      f.attack.hitboxIds.push(hb.id);
      horse.hitboxId = hb.id;
    }
    const hb = horse.hitboxId ? hitboxes.get(horse.hitboxId) : null;
    if (hb) {
      hb.facing = horse.dir;
      hb.x = horse.x - hb.w / 2;
      hb.y = horse.y - hb.h / 2;
    }
  }
}

// â”€â”€ Ability projectiles â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Pure-motion projectiles owned by a fighter (spawned by abilities.js). They
// die on expiry, leaving the stage, or making contact with a hurtbox (a
// non-owner that isn't invulnerable). Lives inside combat so ANY caller of the
// attack pipeline (the game loop AND the verification suites) advances them in
// lockstep with the attacks that spawned them.
export function updateProjectiles(fighters, dt) {
  updateHorses(fighters);
  // Deadeye runs every frame â€” including after the triggering attack has ended
  // â€” until every homing bullet has resolved (see updateDeadeyeCombat).
  for (const f of fighters) {
    if (f._deadeye || f._deadeyePending) updateDeadeyeCombat(f, fighters, dt);
  }
  // Breakables are tested in this pass for the same reason the melee pass tests
  // them: a projectile is a hitbox that happens to move, so it should break a
  // board the same way. Null outside the sandbox.
  const destructibles = destructibleList();
  for (const f of fighters) {
    const list = f._projectiles;
    if (!list || !list.length) continue;
    // Reverse swap-remove: O(1) per kill, no dead[] + indexOf/splice.
    for (let _pi = list.length - 1; _pi >= 0; _pi--) {
      const p = list[_pi];
      let _kill = false;
      p.life -= dt;
      if (p.stuck) {
        // A projectile that landed in a target: it is embedded there, spinning,
        // for exactly the hit-lock window its def asked for (deliverHit froze the
        // target on the same number). It moves nothing and collides with nothing
        // â€” it is out of the fight, only still on screen â€” so it can neither pass
        // through a second target nor stack extra locks.
        p.spin = (p.spin || 0) + dt * 26;
        if (p.life <= 0) _kill = true;
      } else {
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      // Visible spin while in flight (read by the renderer for the shuriken).
      p.spin = (p.spin || 0) + dt * 18;
      if (p.life <= 0 || p.dead || p.x < -100 || p.x > ARENA.width + 100 || p.y > ARENA.height + 200) { _kill = true; }
      if (!_kill && destructibles) {
        const pxPlusR = p.x + p.r;
        const pxMinusR = p.x - p.r;
        const pyPlusR = p.y + p.r;
        const pyMinusR = p.y - p.r;
        for (let i = 0; i < destructibles.length; i++) {
          const d = destructibles[i];
          if (d.dead) continue;
          if (pxPlusR < d.x || pxMinusR > d.x + d.width ||
              pyPlusR < d.y || pyMinusR > d.y + d.height) continue;
          hitDestructible(d, p.def);
          // A bullet that hit a board is spent â€” it does not sail through the
          // splinters into a fighter behind it.
          _kill = true;
          break;
        }
      }
      if (!_kill) {
const pxPlusR = p.x + p.r;
        const pxMinusR = p.x - p.r;
        const pyPlusR = p.y + p.r;
        const pyMinusR = p.y - p.r;
        for (const t of fighters) {
          if (!t || t === p.owner || t.state === 'dead' || t.invulnTimer > 0) continue;
          const hb = getHurtbox(t);
          if (pxPlusR < hb.x || pxMinusR > hb.x + hb.w ||
              pyPlusR < hb.y || pyMinusR > hb.y + hb.h) continue;
          // Projectiles carry their own full damage/knockback def (set at spawn).
          applyAbilityHit(p.owner, t, p.def, p.facing);
          if (p.def && p.def.hitLockDuration > 0) {
            // A locking projectile (the shuriken) buries itself in the target and
            // keeps spinning there for the lock window instead of blinking out of
            // existence the same frame it lands.
            p.stuck = true;
            p.x = t.x;
            p.y = t.y;
            p.vx = 0;
            p.vy = 0;
            p.life = p.def.hitLockDuration;
          } else {
            _kill = true;
          }
          break;
        }
      }
      if (_kill) {
        list[_pi] = list[list.length - 1];
        list.pop();
      }
      } // end else (in-flight branch)
    }
  }
}

// â”€â”€ Debug visualization (toggled with ` in Game.js) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Hurtboxes green Â· startup preview cyan-dashed (non-active) Â· active
// hitboxes red (tagged ACTIVE) Â· spent/recovery hitboxes grey-dashed (tagged
// OFF, proving they stop damaging the instant recovery starts) Â· attack info
// text (name / frame / phase / facing). Renders in world coords â€” call inside
// the camera transform.
export function drawCombatDebug(ctx, fighters) {
  ctx.save();
  ctx.lineWidth = 2;
  ctx.font = '11px Consolas, "Courier New", monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';

  for (const fighter of fighters) {
    const hurt = getHurtbox(fighter);

    ctx.strokeStyle = '#00ff66';
    ctx.strokeRect(hurt.x, hurt.y, hurt.w, hurt.h);

    // Facing marker: a short arrow pointing where the attack will go.
    const dir = fighter.facingRight ? 1 : -1;
    ctx.strokeStyle = '#ffcc44';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(fighter.x + dir * 12, fighter.y);
    ctx.lineTo(fighter.x + dir * 30, fighter.y);
    ctx.lineTo(fighter.x + dir * 25, fighter.y - 5);
    ctx.moveTo(fighter.x + dir * 30, fighter.y);
    ctx.lineTo(fighter.x + dir * 25, fighter.y + 5);
    ctx.stroke();
    ctx.lineWidth = 2;

    ctx.fillStyle = 'rgba(255,255,255,0.7)';
    ctx.fillText(`${fighter.percent.toFixed(0)}%`, fighter.x, hurt.y + hurt.h + 13);

    if (fighter.hitstun > 0) {
      ctx.fillStyle = '#ffd24a';
      ctx.fillText(`STUN ${fighter.hitstun.toFixed(2)}`, fighter.x, fighter.y - fighter.radius - 8);
    }
    if (fighter.attackBuffer) {
      ctx.fillStyle = '#9be8ff';
      ctx.fillText(`BUFFER ${fighter.attackBuffer.type} (${fighter.attackBuffer.frames})`, fighter.x, fighter.y + fighter.radius + 26);
    }

    const a = fighter.attack;
    if (a) {
      ctx.fillStyle = '#ffcc44';
      ctx.fillText(`${a.def.name}`, fighter.x, fighter.y - fighter.radius - 42);
      // Hitbox state on the SAME line so it's easy to read at a glance.
      const hitState = a.phase === 'active' ? 'HIT ON'
        : (a.phase === 'recovery' ? 'HIT OFF' : 'â€”');
      ctx.fillStyle = 'rgba(255,255,255,0.9)';
      ctx.fillText(
        `Frame ${a.frame} Â· ${a.phase} Â· ${a.facing > 0 ? 'Right' : 'Left'} Â· ${hitState}`,
        fighter.x, fighter.y - fighter.radius - 30
      );

      if (a.phase === 'startup') {
        ctx.setLineDash([4, 4]);
        ctx.strokeStyle = '#44ddff';
        for (const facing of a.def.bothSides ? [a.facing, -a.facing] : [a.facing]) {
          const px = fighter.x + a.def.ox * facing - a.def.w / 2;
          const py = fighter.y + a.def.oy - a.def.h / 2;
          ctx.strokeRect(px, py, a.def.w, a.def.h);
        }
        ctx.setLineDash([]);
      }
    }
  }

  // Hitboxes currently in the registry: red + filled when active, grey-dashed
  // when spent (the recovery window, proving no lingering damage).
  for (const hb of hitboxes.values()) {
    if (hb.active) {
      ctx.fillStyle = 'rgba(255,60,60,0.32)';
      ctx.fillRect(hb.x, hb.y, hb.w, hb.h);
      ctx.strokeStyle = '#ff2222';
      ctx.strokeRect(hb.x, hb.y, hb.w, hb.h);
      ctx.fillStyle = '#ffffff';
      ctx.fillText('ACTIVE', hb.x + hb.w / 2, hb.y + hb.h / 2 + 4);
    } else {
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = 'rgba(150,150,150,0.55)';
      ctx.strokeRect(hb.x, hb.y, hb.w, hb.h);
      ctx.setLineDash([]);
      ctx.fillStyle = 'rgba(150,150,150,0.6)';
      ctx.fillText('OFF', hb.x + hb.w / 2, hb.y + hb.h / 2 + 4);
    }
  }

  ctx.restore();
}