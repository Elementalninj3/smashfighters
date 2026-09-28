// session.js — the shared per-frame roster step.
//
// The competitive match (Game.js) and the Sandbox (stage/sandbox/SandboxSession.js)
// run the SAME gameplay; they just hand it different rosters. Two fighters on
// the main stage, or however many spawn points the sandbox document defines on
// the sandbox stage. Everything in here is the orchestration that walks a
// ROSTER of fighters through the real systems — input, gravity/physics, the
// Stage.js platform pass, the attack frame machine, the shared hitbox registry
// and the projectile pass. No gameplay rule lives here, so a four-fighter
// sandbox arena moves, collides and fights through byte-for-byte the same code a
// two-fighter match does; there is no second physics, collision or combat
// implementation anywhere in the sandbox.
//
// These functions were lifted out of Game.js' update loop so the per-frame
// ORDER exists exactly once:
//   stepRosterMovement() — input → physics → separation → platform pass
//   stepRosterCombat()   — attack entry → attack frames/hitboxes → projectiles
//   stepRosterFinish()   — state resolve → animator → landing squish
// Also here, because both callers need them: the post-blast respawn reset, the
// two animator helpers, and the input-triple resolution that lets a slot be
// human, AI-driven or a passive dummy.

import {
  handleFighterInput,
  stepFighterPhysics,
  updateFighterState,
  resetAbilityCooldowns,
  applySoftPlayerSeparation,
} from './Fighter.js';
import { resolvePlatformCollision } from '../stage/Stage.js';
import {
  combatInput,
  updateAttacks,
  updateProjectiles,
  removeAttackerHitboxes,
  clearHitLocks,
  clearDeadeye,
  clearBoxerState,
} from './combat.js';
import { requestAnimation, updateAnimator, stopAnimation } from '../anim/animator.js';
import { emitDustPuff, emitImpactRing, fxStyleFor } from '../render/worldFx.js';

// ── Per-fighter input resolution ─────────────────────────────────────────
// - AI-controlled fighter → the controller's synthetic triple (same signature
//   as Input.js, driving the REAL movement + combat paths).
// - Dummy fighter → all-false triple: fully passive, never reacts to human keys.
// - Human fighter → null (callers fall back to the real Input.js queries).
export function inputForSlot(aiController) {
  if (!aiController) return null;
  if (typeof aiController.getInput === 'function') return aiController.getInput();
  return null;
}

// Passive dummy input: every query is false, so Numpad/human keys can never
// wake a dummy up.
export const DUMMY_INPUT = {
  isHeld: () => false,
  isJustPressed: () => false,
  isJustReleased: () => false,
};

// Turn a Menu.js fighter definition into the skin record createFighter stores.
// The record is a lazy handle, not an image: drawFighter looks the live bitmap
// up through Accessories' getSkinImage cache, so a fighter built on a later
// frame (sandbox spawn) still draws the right art.
export function resolveFighterSkin(fighterDef) {
  if (!fighterDef || !fighterDef.skin) return null;
  return { loaded: false, img: null, name: fighterDef.name, path: fighterDef.skin };
}

// ── Movement / physics ───────────────────────────────────────────────────
// inputFor(fighter, index) returns that slot's input triple (or null for human).
export function stepRosterMovement(fighters, stage, dt, inputFor) {
  for (let i = 0; i < fighters.length; i++) {
    const f = fighters[i];
    if (!f) continue;
    handleFighterInput(f, stage, dt, inputFor(f, i) || {});
  }

  // Reset grounded flags. A mounted rider stands on the horse (not the stage),
  // so their grounded state is owned by the horse update, not this reset.
  for (let i = 0; i < fighters.length; i++) {
    const f = fighters[i];
    if (f && !f._horse) { f.grounded = false; f.groundPlatform = null; }
  }

  for (let i = 0; i < fighters.length; i++) {
    if (fighters[i]) stepFighterPhysics(fighters[i], dt);
  }

  // Remember each airborne fighter's falling speed BEFORE the platform pass
  // resolves (and zeroes) it — the landing puff below scales with impact.
  for (let i = 0; i < fighters.length; i++) {
    const f = fighters[i];
    if (f && !f.grounded) f._landVy = f.vy;
  }

  // Soft player separation: gentle push apart when too close horizontally, only
  // for slots at a similar height (Fighter.js owns the rule). Every unordered
  // pair, so it is identical for two fighters and scales to a sandbox full.
  for (let i = 0; i < fighters.length; i++) {
    const a = fighters[i];
    if (!a) continue;
    for (let j = i + 1; j < fighters.length; j++) {
      const b = fighters[j];
      if (b) applySoftPlayerSeparation(a, b, dt);
    }
  }

  // Platform pass (main floor + one-way upper platforms). A mounted rider is
  // lifted onto the horse and must NOT be snapped back to the floor — they also
  // ignore platform collision for the duration of the ride.
  for (let i = 0; i < fighters.length; i++) {
    const f = fighters[i];
    if (!f || f._horse) continue;
    const plats = stage.platforms;
    for (let p = 0; p < plats.length; p++) resolvePlatformCollision(f, plats[p]);
  }
}

// ── Combat ───────────────────────────────────────────────────────────────
// Runs AFTER the platform pass, so "attack right as you land" reads the
// grounded state the fighter is actually in right now. combatInput is the ONLY
// attack-entry path and overrides ride it exactly as they do for human presses.
export function stepRosterCombat(fighters, inputOverrides, dt) {
  combatInput(fighters, inputOverrides);
  // Advance attack frames, spawn/move/destroy hitboxes, resolve collisions →
  // percent / knockback / hitstun (and destructible durability, see combat.js).
  updateAttacks(fighters, dt);
  // Ability projectiles: move, expire and resolve collisions the same way an
  // active hitbox would (same damage rules).
  updateProjectiles(fighters, dt);
}

// ── State + animation + landing squish ───────────────────────────────────
// victoryNameFor(f) is optional: the match passes the winner's victory dance
// (which outranks every other animation), the sandbox passes nothing because it
// has no match end.
export function stepRosterFinish(fighters, dt, victoryNameFor) {
  for (let i = 0; i < fighters.length; i++) {
    const f = fighters[i];
    if (!f) continue;
    updateFighterState(f);
    syncFighterAnim(f, dt, victoryNameFor ? victoryNameFor(f) : null);
  }
  // Landing squish + landing dust. The puff scales with impact speed (soft
  // touches kick up 3 motes, hard falls up to 6 plus a small ring). Visual
  // only — squish, physics and resources are untouched.
  for (let i = 0; i < fighters.length; i++) {
    const f = fighters[i];
    if (f && f._justLanded) {
      f._justLanded = false;
      f.squishX = 1.25;
      f.squishY = 0.78;
      f.squishTimer = 0.15;
      const impact = Math.max(0, f._landVy || 0);
      f._landVy = 0;
      if (impact > 120) {
        const lr = f.radius || 22;
        const lstyle = fxStyleFor(f);
        emitDustPuff(f.x, f.y + lr * 0.8, impact > 650 ? 6 : impact > 350 ? 4 : 3, {
          style: lstyle, spread: Math.PI * 1.2, speed: 130,
          size: lr * 0.14, life: 0.3, gravity: 120, alpha: 0.4,
        });
        if (impact > 700) {
          emitImpactRing(f.x, f.y + lr * 0.8, {
            style: lstyle, radius: lr * 0.5, growth: lr * 1.8,
            life: 0.25, alpha: 0.45,
          });
        }
      }
    }
  }
}

// ── Animator sync ────────────────────────────────────────────────────────
// The animator is requested ONLY for the library's seven-base-animation combat
// actions (attacks + shield). Walking left/right, running, jumping, falling,
// dodging and hitstun are NOT animator-driven: those keep the original movement
// pose system (in Effects.js) and default-pose hands, exactly as before the
// animator existed.
function combatAnim(f, victory) {
  // Victory outranks everything: the winner celebrates even if a stray input
  // still has an attack running as the final KO lands.
  if (victory) return victory;
  if (f.shielding) return 'shield';
  if (f.attack) {
    // The attack animation plays while the hitbox can still hit (startup +
    // active). The instant recovery starts the hitbox is gone — return null so
    // the animator releases the hands back to the default pose instead of
    // finishing the swing on top of a no-longer-damaging attack.
    return f.attack.phase === 'recovery' ? null : (f.attack.def.anim || null);
  }
  return null;
}

export function syncFighterAnim(f, dt, victory) {
  if (!f.anim) return;
  const name = combatAnim(f, victory);
  if (name) {
    // Only start/replace the animation when the name actually changed.
    // During a single attack, updateAnimator runs every frame but the
    // animation is started only once.
    if (f.anim.animId !== name) requestAnimation(f, name);
    updateAnimator(f, dt);
  } else if (f.anim.blendFrom && f.anim.blendProgress < 1) {
    // Mid-crossfade back to the default pose — keep driving the blend so it
    // finishes and hands control back to the legacy movement pose system.
    updateAnimator(f, dt);
  } else if (f.anim.animId || f.anim.playing) {
    // Combat action finished (or its active window ended) — blend the hands
    // smoothly back to the default pose instead of snapping via resetAnimator.
    stopAnimation(f);
  }
}

// ── Blast-zone respawn ───────────────────────────────────────────────────
// Soft respawn: the fighter reappears at their spawn point with a brief
// invulnerability blink and percent reset to 0%. The match spends a stock on
// top of this (Game.js onBlastKO); the sandbox just calls it, which is exactly
// the "no stocks, no match end" behaviour its blast zones need.
export function softResetFighter(f, stage) {
  // A session that authored its own spawns (the sandbox) pins each fighter to the
  // exact point it was placed at; the match has no such field and falls through
  // to its per-player spawn list, then the stage's single respawn point.
  const spawn = f._respawnPoint
    || (stage.spawnPoints[(f.playerNum || 1) - 1]) || stage.respawnPoint;
  f.x = spawn.x;
  f.y = spawn.y - 30;
  f.vx = 0;
  f.vy = 0;
  f.grounded = false;
  f.groundPlatform = null;
  f.dodging = false;
  f.dodgeTimer = 0;
  f.wavedashing = false;
  f.canDoubleJump = true;
  f.canUseAerialLightRecovery = true;
  f._aerialRecoveryTimer = 0;
  f.jumpsUsed = 0;
  f.fastFalling = false;
  f.freeFall = false;
  f.coyoteTimer = 0;
  f.jumpBufferTimer = 0;
  f.wasGrounded = false;
  f.invulnTimer = 1.2;
  // Combat state: cancel any in-progress attack, remove its hitboxes, clear
  // hitstun, empty the input buffer, zero the damage meter back to 0%, and
  // clear the shared cooldowns (§43/§45) so a respawn never inherits a lock.
  removeAttackerHitboxes(f);
  clearHitLocks(f);
  f.attack = null;
  f.attackBuffer = null;
  f.hitstun = 0;
  f.shielding = false;
  f.shieldCooldown = 0;
  f.attackCooldown = 0;
  // Per-ability cooldowns too: a respawn must never inherit a Deadeye lock.
  resetAbilityCooldowns(f);
  f.percent = 0;
  f._hitFlash = 0;
  f._hitRenderTimer = 0;
  // Ability state: drop any live projectiles and break locks on respawn.
  if (f._projectiles) f._projectiles.length = 0;
  // Temporary VFX (ability art, the Shadow Strike trail, …) are aged inside
  // handleFighterInput, which bails the moment the fighter is out of play — a
  // frozen one would hang on screen through the blink-in. Empty the pool so a
  // respawn never inherits a decaying effect.
  if (f._tempVfx) f._tempVfx.length = 0;
  // A Teleport Strike charge in progress dies with the respawn: the ninja must
  // not blink out of a stock it no longer has.
  f._teleportPending = null;
  f._horse = null;
  clearDeadeye(f); // no lingering Deadeye volley/glow after a respawn
  // Same for the boxer's fighter-owned ability state: a respawn must not come
  // back holding an opponent, mid-roll, or with an unspent dodge charge.
  clearBoxerState(f);
}
