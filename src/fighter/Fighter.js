// Fighter.js — merged: Physics + Fighter data/state + FighterController input.
// Movement + combat sandbox: run / jump / double jump / fast fall / dash /
// dodge / drop-through plus the data-driven attack system from combat.js.
// Fighters carry `percent` (the damage meter), an active `attack` instance,
// `hitstun` (attack lockout), and a `shielding` flag refreshed each frame.

import { isHeld as __isHeld, isJustPressed as __isJustPressed, isJustReleased as __isJustReleased } from '../input/Input.js';
import { emitDustPuff, emitImpactRing, fxStyleFor } from '../render/worldFx.js';

// ============================================================================
// PHYSICS CONSTANTS (from Physics.js)
// ============================================================================

// Lighter, more airborne feel: reduced gravity + lower terminal fall speed.
export const GRAVITY = 1750;
export const MAX_FALL_SPEED = 950;
export const FAST_FALL_MULTIPLIER = 1.8;

// Ground movement. VERY snappy for Smash-like feel.
// Balance: max horizontal speeds ×0.60 (165→99) then §22 ×1.15 (99→114), then
// §46 ×0.60 (114→68) to slow the fighters down. Accel/decel/friction are scaled
// by the SAME ×0.60 so the time-to-top-speed ratio is preserved — the fighters
// simply cover less ground per second instead of feeling twitchier.
export const RUN_SPEED = 68;  // 114 × 0.60 — noticeably heavier, same handling
export const GROUND_ACCEL = 2100;   // 3500 × 0.60 — same time-to-top-speed
export const GROUND_DECEL = 1080;   // 1800 × 0.60 — same stop curve
export const GROUND_FRICTION = 840; // 1400 × 0.60 — same deceleration feel

// Air movement - snappier for Smash-like controls (§46: ×0.60 alongside ground)
export const AIR_SPEED = 58;   // 97 × 0.60
export const AIR_ACCEL = 840;        // 1400 × 0.60 — same air-control authority
export const AIR_FRICTION = 300;      // 500 × 0.60
export const AIR_DRAG = 0.94;         // Slightly more drag for tighter control

// Jump
export const JUMP_FORCE = 680;
export const DOUBLE_JUMP_FORCE = 680; // Increased from 580 for better recovery
export const JUMP_CUT_MULTIPLIER = 0.4; // releasing jump early cuts velocity
export const SHORTHOP_FORCE = 420;
export const DOUBLE_JUMP_COUNT = 1;

// Recovery - tunable constants
export const RECOVERY_UPWARD_FORCE = 1200; // Increased from default up-special force
export const RECOVERY_HORIZONTAL_FORCE = 186; // 310 × 0.60 (§46) — horizontal control during recovery
export const RECOVERY_AIR_CONTROL = 1.3; // Air control multiplier during recovery

// ── Aerial Light recovery tuning ─────────────────────────────────────────
// The mid-air Light attack doubles as a strong upward recovery move. All of
// the recovery tuning lives here so it can be retuned in one obvious place.
// Ground Light (J grounded) is untouched — only the AIRBORNE J uses this.
// Airborne J = immediate strong upward launch to SELF (not attack knockback):
// counters downward velocity, launches strongly up, enough to recover from
// far below, preserves horizontal steering. Configurable via
// AERIAL_LIGHT_RECOVERY_FORCE.
export const AERIAL_LIGHT_RECOVERY_FORCE = 307.5; // 410 × 0.75 (aerial lift reduction, matches aerialHeavy's 380 → 285) — still meaningful: counters fall speed, launches up, recovers from below, keeps steering (jump ≈ 680, up-special ≈ 1200)
export const AERIAL_LIGHT_RECOVERY_DURATION = 0.2; // seconds the launch assist stays live (gravity cut + boosted steer)
export const AERIAL_LIGHT_GRAVITY_REDUCTION = 0.05; // gravity multiplier while the assist runs — near-zero keeps the launch strong
export const AERIAL_LIGHT_AIR_CONTROL = 1.5;        // horizontal air-accel multiplier during the assist (aim the recovery)

// Dash — §46: ×0.60 with the rest of the locomotion. Duration/cooldown keep
// fast action-heavy pace. The dash doubles as the dodge tool (§23): quick burst
// out of danger with short deliberate i-frames (see dodge below).
export const DASH_SPEED = 110;
export const DASH_DURATION = 0.12; // seconds
export const DASH_COOLDOWN = 0.18;

// ── Defensive cooldowns (§43/§44 — ONE shared system, player + AI alike) ──
// Both fighters run the exact same gating in combatInput/handleFighterInput,
// so the AI obeys identical restrictions automatically. Tune here only.
//   BLOCK_COOLDOWN — set on block RELEASE; re-engaging block sooner is denied.
//     0.35s stops block→release→block spam while keeping defense responsive.
//   DODGE_COOLDOWN / AIR_DODGE_COOLDOWN — set on dodge START; repeat dodges
//     are denied until it clears. Long enough to stop DODGE×4 spam, short
//     enough for skilled defensive play.
export const BLOCK_COOLDOWN = 0.35;
export const DODGE_COOLDOWN = 0.8;
export const AIR_DODGE_COOLDOWN = 1.0;

// ── Soft Player Separation ──────────────────────────────────────────────────
// Lightweight non-collision separation that gently pushes players apart when
// they get too close, without making them solid physics objects.
export const PLAYER_SEPARATION_DISTANCE = 50; // minimum horizontal gap between players
const SEPARATION_SPEED = 8.0; // interpolation speed factor (higher = faster correction)

// ============================================================================
// FIGHTER STATE MACHINE
// ============================================================================

export const STATES = {
  IDLE: 'idle',
  RUN: 'run',
  JUMP: 'jump',
  FALL: 'fall',
  AIRBORNE: 'airborne',
  DASH: 'dash',
  DODGE: 'dodge',
  AIR_DODGE: 'airdodge',
  ATTACK: 'attack',
  HITSTUN: 'hitstun',
};

export function createFighter(playerNum, x, y, skin, options = {}) {
  return {
    id: options.id || `p${playerNum}`,
    playerNum,
    x, y,
    vx: 0, vy: 0,
    radius: options.radius || 22,
    color: options.color || (playerNum === 1 ? '#4a9eff' : '#ff4a4a'),
    skin: skin || null,
    skinScale: options.skinScale || 1,
    skinCenter: options.skinCenter || null,
    accessory: options.accessory ? { ...options.accessory } : null,
    // Cosmetic gear worn on the hands, per arm: { left, right }. Copied (not
    // shared) like `accessory` above, because the customiser hands out a
    // per-fighter set and the renderer only ever reads it.
    handGear: options.handGear
      ? { left: { ...options.handGear.left }, right: { ...options.handGear.right } }
      : null,

    // Combat — damage meter, active attack instance (managed by combat.js),
    // and hitstun lockout. Percent only ever goes up within a stock; a
    // blast-zone fall costs one stock (Game.js onBlastKO) and respawns at 0%.
    percent: 0,
    stocks: options.stocks ?? 3, // stocks remaining in the current match
    eliminated: false,           // true once the last stock is lost
    attack: null,
    attackBuffer: null, // queued { type, frames } from combat.js input buffering
    hitstun: 0,
    shielding: false,
    _hitFlash: 0,
    _hitLock: null,     // timed hit-confirm lock set by combat.js on a landed hit

    // Non-hitbox abilities / projectiles
    _projectiles: [],
    // A mount entity (the cowboy's horse ride) while one is active. Lives on
    // the fighter so combat (hitbox), render (Effects) and Game.js (platform
    // skip, probe) all see the same object. null when not riding.
    _horse: null,

    // State
    state: STATES.IDLE,
    facingRight: playerNum === 1,
    grounded: false,
    groundPlatform: null,

    // Movement
    runSpeed: options.runSpeed || RUN_SPEED,
    airSpeed: options.airSpeed || AIR_SPEED,
    jumpForce: options.jumpForce || JUMP_FORCE,
    doubleJumpForce: options.doubleJumpForce || DOUBLE_JUMP_FORCE,

    // Jump
    canDoubleJump: true,
    fastFalling: false,
    jumpPressed: false, // was jump held last frame
    jumpsUsed: 0,

    // Dash
_tempVfx: [],
    // A charged teleport waiting to fire: { fromX, fromY } is the spot the move
    // was ACTIVATED on (where its smoke goes off), armed by ABILITIES.ninjaDtilt
    // and consumed by combat.js when the charge elapses. null = no charge.
    _teleportPending: null,
    dashing: false,
    dashTimer: 0,
    dashCooldown: 0,
    dashDirection: 1,
    // Remaining shadow-dash travel in pixels; -1 means "no shadow-dash burst
    // running", which is deliberately distinct from 0 ("the budget is spent, but
    // the burst has not ended yet") so the leftover frames of the burst window
    // cannot add distance past dashDistance.
    _shadowDashRemain: -1,
    lastGroundedX: 0,
    // Aerial Light recovery assist: seconds remaining of the upward launch
    // buff (gravity reduction + boosted air control). Set by combat.js when an
    // airborne Light attack starts; decays every frame and landing naturally
    // ends it. Finite — the recovery is never infinite.
    _aerialRecoveryTimer: 0,

    // Hands runtime state (rendering only)
    _handBack: null,    // smoothed back-hand pose (rendering only)
    _handFront: null,   // smoothed front-hand pose (rendering only)

    // Free-fall: recovery is consumed after a double jump once airborne —
    // the free-fall glow shows while falling without a jump left.
    freeFall: false,

    // Dodge
    dodging: false,
    dodgeTimer: 0,
    dodgeCooldown: 0,
    dodgeDirection: { x: 0, y: 0 },

    // Shared cooldowns (§43 block / §45 attack). Decayed in
    // stepFighterPhysics; gated in combatInput/handleFighterInput — the same
    // path for human and AI input, so both obey identical rules.
    shieldCooldown: 0, // §43: set on block release, blocks re-engage while > 0
    attackCooldown: 0, // §45: set on every attack start, min 0.83s between starts

    // Per-ABILITY cooldowns, keyed by ability id: { cowboyDownLight: 4.2, … }.
    // The remaining seconds, not an absolute stamp, so they ride the same clock
    // and the same step as the shared cooldowns above — no parallel timing
    // system. Stamped by combat.js when the ability fires, decayed below.
    abilityCooldowns: {},

    // Invulnerability
    invulnTimer: 0,

    // Wavedash
    wavedashing: false,

    // Drop-through
    wantsToDropThrough: false,
    dropThroughPlatform: null, // platform being dropped through (per-player ignore)
    groundType: null,          // 'main' | 'platform' | null

    // Previous bottom Y for one-way platform detection
    _prevBottomY: 0,

    // Visual
    scale: 1,
    squishX: 1,  // horizontal squish factor
    squishY: 1,  // vertical squish factor
    squishTimer: 0,

    // Fall speed
    fallSpeed: options.fallSpeed || 1.0,

    // Coyote time (grace period after leaving ground to still jump)
    coyoteTimer: 0,

    // Jump buffer (press jump slightly before landing, auto-jump on land)
    jumpBufferTimer: 0,

    // Track if was airborne last frame (for landing detection)
    wasGrounded: true,
    // Tracks if double jump is available (needs to touch ground to recharge)
    canDoubleJump: true,
    // Tracks if aerial light recovery is available (needs to touch ground to recharge)
    canUseAerialLightRecovery: true,

    // Fighter roster definition (set by Game.js, used for skin/accessory lookup)
    _fighterDef: null,
  };
}

// Update fighter state based on current conditions
export function updateFighterState(fighter) {
  if (fighter.state === STATES.DEAD) return;

  // Invulnerability blink
  if (fighter.invulnTimer > 0) {
    fighter.scale = 1 + 0.05 * Math.sin(fighter.invulnTimer * 30);
  } else {
    fighter.scale = 1;
  }

  // Combat states take precedence over movement states. Hitstun is a result of
  // being hit (attack already cancelled); an in-progress attack locks the
  // fighter into the ATTACK pose for its full startup → active → recovery.
  if (fighter.hitstun > 0) {
    fighter.state = STATES.HITSTUN;
    return;
  }
  if (fighter.attack) {
    fighter.state = STATES.ATTACK;
    return;
  }

  // Dodge state
  if (fighter.dodging) {
    fighter.state = fighter.grounded ? STATES.DODGE : STATES.AIR_DODGE;
    return;
  }

  // Dashing
  if (fighter.dashing) {
    fighter.state = STATES.DASH;
    return;
  }

  // Airborne states
  if (!fighter.grounded) {
    fighter.state = fighter.vy < 0 ? STATES.JUMP : STATES.FALL;
    return;
  }

  // Grounded states
  const isMoving = Math.abs(fighter.vx) > 10;
  fighter.state = isMoving ? STATES.RUN : STATES.IDLE;
}

// ══ Physics rules ════════════════════════════════════════════════════

// End a dash burst. The Shadow Dash (abilities.js ninjaDsmash) is a
// FIXED-DISTANCE forward move: it sets a constant velocity for
// `distance / speed` seconds and `dashing` suppresses friction for the whole
// window, so without this the leftover burst velocity would coast on under
// normal deceleration — making the travelled distance a function of the ground
// friction constant instead of the move's own `dashDistance`. Zeroing the
// velocity here makes the travel exactly the distance the ability asked for,
// from any position on the map, in the direction captured at activation.
//
// Scoped to the shadow dash (`_shadowDashSpeed`): the generic Dash ability
// keeps its existing burst-then-settle behaviour, and the dodge is unaffected
// (it runs on dodgeTimer, not dashTimer).
function endDashBurst(fighter) {
  if (fighter._shadowDashSpeed) fighter.vx = 0;
  fighter.dashTimer = 0;
  fighter.dashing = false;
  fighter._shadowDashDir = 0;
  fighter._shadowDashSpeed = 0;
  fighter._shadowDashRemain = -1;
}
export function stepFighterPhysics(fighter, dt) {
  if (fighter.state === 'dead') return;

  // Hitstun decays here, after knockback velocity has been applied but before
  // the ground/air drag would erase it.
  if (fighter.hitstun > 0) {
    fighter.hitstun -= dt;
    if (fighter.hitstun < 0) fighter.hitstun = 0;
  }

  // Hit flash decays
  if (fighter._hitFlash > 0) {
    fighter._hitFlash -= dt;
    if (fighter._hitFlash < 0) fighter._hitFlash = 0;
  }

  // Shuriken hit-lock: while the timer runs the target is genuinely frozen
  // in place — velocities held at zero, no gravity, no position integration,
  // no friction. Hitstun / invuln / hit-flash above keep decaying on their own
  // clocks, so the lock respects the normal rules and always releases cleanly;
  // on expiry the stored knockback velocity resumes and physics continues.
  if ((fighter._hitLockTimer || 0) > 0) {
    fighter._hitLockTimer -= dt;
    fighter.vx = 0;
    fighter.vy = 0;
    if (fighter.invulnTimer > 0) {
      fighter.invulnTimer -= dt;
      if (fighter.invulnTimer < 0) fighter.invulnTimer = 0;
    }
    if (fighter._hitLockTimer <= 0) {
      // Release: restore the knockback stored at lock time, then fall through
      // to normal physics this same frame so movement resumes immediately.
      if (fighter._hitLockVsx !== undefined && fighter._hitLockVsy !== undefined) {
        fighter.vx = fighter._hitLockVsx;
        fighter.vy = fighter._hitLockVsy;
        fighter._hitLockVsx = undefined;
        fighter._hitLockVsy = undefined;
      }
      fighter._hitLockTimer = 0;
    } else {
      // Still locked: tick the time-based defensive/attack clocks so the
      // freeze can't stall them, then skip all motion for this frame.
      if (fighter.dashTimer > 0) {
        fighter.dashTimer -= dt;
        if (fighter.dashTimer <= 0) {
          endDashBurst(fighter);
        }
      }
      if (fighter.dodgeCooldown > 0) fighter.dodgeCooldown = Math.max(0, fighter.dodgeCooldown - dt);
      if (fighter.shieldCooldown > 0) fighter.shieldCooldown = Math.max(0, fighter.shieldCooldown - dt);
      if (fighter.attackCooldown > 0) fighter.attackCooldown = Math.max(0, fighter.attackCooldown - dt);
      return;
    }
  } else {
    // Clear stored velocity if timer is not active
    fighter._hitLockVsx = undefined;
    fighter._hitLockVsy = undefined;
  }

  // Aerial Light recovery assist is finite: the launch buff decays on its own
  // each frame (and landing cuts it short — gravity is only reduced airborne).
  if (fighter._aerialRecoveryTimer > 0) {
    fighter._aerialRecoveryTimer -= dt;
    if (fighter._aerialRecoveryTimer < 0) fighter._aerialRecoveryTimer = 0;
  }

  // Save previous bottom Y for one-way platform detection
  fighter._prevBottomY = fighter.y + fighter.radius;

  // Hit-confirm lock: both fighters freeze in place for the brief window
  // before the deferred knockback launches the target (combat.js). Invuln
  // still decays so post-lock i-frames are just the normal hit feedback.
  if (fighter._hitLock) {
    fighter.vx = 0;
    fighter.vy = 0;
    if (fighter.invulnTimer > 0) {
      fighter.invulnTimer -= dt;
      if (fighter.invulnTimer < 0) fighter.invulnTimer = 0;
    }
    return;
  }

  // Apply gravity
  if (!fighter.grounded) {
    let grav = GRAVITY;
    // Aerial Light recovery assist: while the buff is live the airborne fighter
    // skates through a strong upward drift that isn't instantly erased by full
    // gravity — the launch stays high enough to actually recover the stage.
    if (fighter._aerialRecoveryTimer > 0) {
      grav *= AERIAL_LIGHT_GRAVITY_REDUCTION;
    }
    // Fast fall
    if (fighter.fastFalling) {
      grav *= FAST_FALL_MULTIPLIER;
    }
    fighter.vy += grav * dt;
    const fallCap = fighter.fastFalling ? 1150 : MAX_FALL_SPEED;
    if (fighter.vy > fallCap) fighter.vy = fallCap;
  }

  // Apply velocity
  if (fighter._shadowDashRemain >= 0) {
    // The shadow dash pays out of a fixed pixel budget, so the travel is
    // exactly `dashDistance` instead of "however far velocity × whole frames"
    // lands on at this frame rate. Scoped to that move: everything else keeps
    // the plain `vx * dt` integration.
    const step = fighter.vx * dt;
    if (Math.abs(step) >= fighter._shadowDashRemain) {
      fighter.x += Math.sign(step) * fighter._shadowDashRemain;
      fighter._shadowDashRemain = 0;
    } else {
      fighter.x += step;
      fighter._shadowDashRemain -= Math.abs(step);
    }
  } else {
    fighter.x += fighter.vx * dt;
  }
  fighter.y += fighter.vy * dt;

  // Ground friction / air friction — skipped during hitstun so knockback
  // velocity isn't erased while the defender is being launched.
  if (fighter.hitstun <= 0) {
    if (fighter.grounded) {
      if (Math.abs(fighter.vx) > 0 && !fighter.dashing) {
        const decel = GROUND_DECEL * dt;
        if (Math.abs(fighter.vx) <= decel) {
          fighter.vx = 0;
        } else {
          fighter.vx -= Math.sign(fighter.vx) * decel;
        }
      }
    } else if (!fighter.dashing) {
      // Air drag (skipped while dashing — a dash burst keeps its captured
      // forward velocity for its whole duration).
      fighter.vx *= airDragFactor(dt);
    }
  }

  // Dash timer
  if (fighter.dashTimer > 0) {
    fighter.dashTimer -= dt;
    if (fighter.dashTimer <= 0) {
      endDashBurst(fighter);
    }
  }

  // Dash cooldown
  if (fighter.dashCooldown > 0) {
    fighter.dashCooldown -= dt;
    if (fighter.dashCooldown < 0) fighter.dashCooldown = 0;
  }

  // Dodge cooldown
  if (fighter.dodgeCooldown > 0) {
    fighter.dodgeCooldown -= dt;
    if (fighter.dodgeCooldown < 0) fighter.dodgeCooldown = 0;
  }

  // Shared defensive/offensive cooldowns (§43/§45) decay alongside everything
  // else, in the same step, on the same clock — no parallel timing systems.
  if (fighter.shieldCooldown > 0) {
    fighter.shieldCooldown -= dt;
    if (fighter.shieldCooldown < 0) fighter.shieldCooldown = 0;
  }
  if (fighter.attackCooldown > 0) {
    fighter.attackCooldown -= dt;
    if (fighter.attackCooldown < 0) fighter.attackCooldown = 0;
  }
  // Per-ability cooldowns, same clock and same step as the shared ones above.
  // Finished entries are deleted rather than left at 0 so the map can't grow a
  // key per ability for the rest of the match. The set of live ids is mirrored
  // into a tiny per-fighter array (`_abilityCdLive`) so the common case — one
  // reverse index loop over the handful of abilities actually cooling down —
  // replaces a `for...in` (own-keys snapshot) plus `delete` (which pins the
  // object in V8 dictionary mode permanently) on every frame of the match. The
  // plain object stays the source of truth: stampAbilityCooldown writes it, the
  // ?probe API reads it.
  const acd = fighter.abilityCooldowns;
  if (acd) {
    const live = fighter._abilityCdLive || (fighter._abilityCdLive = []);
    // Re-sync only while the mirror is empty, which also self-heals a map that was
    // populated directly instead of via stampAbilityCooldown (the ?probe and
    // ai-training setup paths). An empty `for...in` costs a shared empty keys
    // array, not a new one, and a non-empty one costs one pass — then the mirror
    // is non-empty and this branch is skipped again.
    if (live.length === 0) {
      for (const id in acd) live.push(id);
    }
    for (let i = live.length - 1; i >= 0; i--) {
      const id = live[i];
      const left = acd[id] - dt;
      if (left > 0) {
        acd[id] = left;
      } else {
        delete acd[id];
        live[i] = live[live.length - 1];
        live.pop();
      }
    }
  }

  // Invulnerability timer
  if (fighter.invulnTimer > 0) {
    fighter.invulnTimer -= dt;
    if (fighter.invulnTimer < 0) fighter.invulnTimer = 0;
  }

  // Subtle footstep dust while running on the ground. Timed, not per-frame: a
  // couple of small puffs at the feet every ~0.22s of fast ground movement.
  // Counts ride the shared quality scaler (emitDustPuff), so low-end settings
  // trim this first and gameplay never reads it back.
  if (fighter.grounded && !fighter.dashing && !fighter.dodging && !fighter.attack
      && fighter.hitstun <= 0 && !fighter._hitLock && !(fighter._hitLockTimer > 0)) {
    if (Math.abs(fighter.vx) > 45) {
      fighter._stepFxTimer = (fighter._stepFxTimer || 0) + dt;
      if (fighter._stepFxTimer >= 0.22) {
        fighter._stepFxTimer = 0;
        const sr = fighter.radius || 22;
        emitDustPuff(fighter.x - Math.sign(fighter.vx) * sr * 0.4, fighter.y + sr * 0.75, 2, {
          style: fxStyleFor(fighter), spread: Math.PI * 2, speed: 50,
          size: sr * 0.11, life: 0.3, gravity: 60, alpha: 0.32,
        });
      }
    } else if (fighter._stepFxTimer) {
      fighter._stepFxTimer = 0;
    }
  } else if (fighter._stepFxTimer) {
    fighter._stepFxTimer = 0;
  }

  // Squish decay — spring back to 1,1
  if (fighter.squishTimer > 0) {
    fighter.squishTimer -= dt;
    if (fighter.squishTimer <= 0) {
      fighter.squishTimer = 0;
    }
  }
  const squishSpring = 1 - Math.min(1, dt * 12);
  fighter.squishX += (1 - fighter.squishX) * squishSpring;
  fighter.squishY += (1 - fighter.squishY) * squishSpring;
  if (Math.abs(fighter.squishX - 1) < 0.005) fighter.squishX = 1;
  if (Math.abs(fighter.squishY - 1) < 0.005) fighter.squishY = 1;

// Landing detection: was airborne, now grounded → recharge the jump resources.
// ONLY actual landing recharges double jump + Aerial-Light (never walls,
// enemies, or midair jumps — no other code path touches these flags).
     if (!fighter.wasGrounded && fighter.grounded) {
      fighter._justLanded = true;
      // Recharge both jump and aerial light recovery when touching ground
      fighter.canDoubleJump = true;
      fighter.canUseAerialLightRecovery = true;
     }
     fighter.wasGrounded = fighter.grounded;


  // Coyote timer: set when leaving ground without jumping, decays over time
  if (fighter.wasGrounded && !fighter.grounded && fighter.vy >= 0) {
    // Leaving ground (not from jump)
    if (fighter.coyoteTimer <= 0) {
      fighter.coyoteTimer = 0.1; // 100ms coyote time
    }
  }
  if (fighter.coyoteTimer > 0) {
    fighter.coyoteTimer -= dt;
    if (fighter.coyoteTimer < 0) fighter.coyoteTimer = 0;
  }

  // Jump buffer: decays over time
  if (fighter.jumpBufferTimer > 0) {
    fighter.jumpBufferTimer -= dt;
    if (fighter.jumpBufferTimer < 0) fighter.jumpBufferTimer = 0;
  }
}

// ── Soft Player Separation ──────────────────────────────────────────────────
// Lightweight non-collision separation that gently pushes players apart when
// they get too close, without making them solid physics objects.

function applySoftPlayerSeparation(fighterA, fighterB, dt) {
  // Don't separate if either is dead
  if (fighterA.state === 'dead' || fighterB.state === 'dead') {
    return false;
  }

  // Only push while the fighters are roughly at the same height. If one is
  // clearly above the other (e.g. jumping over), the push drops out so the
  // airborne fighter can pass freely overhead.
  const dy = Math.abs(fighterB.y - fighterA.y);
  const verticalBand = (fighterA.radius + fighterB.radius) * 0.6;
  if (dy > verticalBand) {
    return false;
  }

  // Calculate horizontal distance between players
  const dx = fighterB.x - fighterA.x;
  const dist = Math.abs(dx);

  // If players are far enough apart, no separation needed
  if (dist >= PLAYER_SEPARATION_DISTANCE || dist < 0.1) {
    return false;
  }

  // Calculate overlap (how much they're too close)
  const overlap = PLAYER_SEPARATION_DISTANCE - dist;

  // Don't apply tiny corrections (prevents jitter when barely overlapping)
  if (overlap < 1) {
    return false;
  }

  // Calculate direction: positive = B is to the right of A
  const direction = dx > 0 ? 1 : -1;

  // Split the correction between both players (gentle push apart)
  // Each gets half the correction, scaled by separation speed for smoothness
  const correctionPerPlayer = (overlap * 0.5) * SEPARATION_SPEED * dt;

  // Apply soft separation - push them apart horizontally
  fighterA.x -= direction * correctionPerPlayer;
  fighterB.x += direction * correctionPerPlayer;

  return true;
}

export { applySoftPlayerSeparation };

// Movement speed multiplier, read rather than stored. `runSpeed` / `airSpeed`
// are NEVER mutated by a temporary buff: every movement target is multiplied
// by this scale instead, so a buff cannot leak into anything else that reads
// the fighter's real speed (AI spacing, camera framing, the roster sheet).
// (The old Deadeye Roll speed buff is gone — Down Heavy is now a teleport +
// barrage — so this currently returns 1. The hook stays so a future buff
// cannot leak either.)
export function moveSpeedScale(fighter) {
  const roll = fighter && fighter._boxerRoll;
  return roll && roll.speedMul ? roll.speedMul : 1;
}

// Spawn a temporary VFX effect that will be automatically removed after its
// lifetime. `extra` (optional) overrides/extends the instance: effects that need
// their own parameters carry them there (the shadow dash needs the distance it
// has to cover), and a caller can pin a direction other than the fighter's live
// facing. The live instance is returned so the caller can keep tuning it.
export function spawnTempVfx(fighter, effectName, lifetime, scale = 1, rotation = 0, offsetX = 0, offsetY = 0, extra = null) {
  if (!fighter._tempVfx) fighter._tempVfx = [];
  const v = {
    effect: effectName,
    lifetime,
    age: 0,
    progress: 0,
    scale,
    rotation,
    offsetX,
    offsetY,
    anchor: 'character', // default anchor; can be changed if needed
    mirrorX: fighter.facingRight ? 1 : -1
  };
  if (extra) Object.assign(v, extra);
  fighter._tempVfx.push(v);
  return v;
}

// Start (or restart) an ability's cooldown. The plain object stays the value
// every reader uses; the id is also recorded in the per-fighter `_abilityCdLive`
// list that stepFighterPhysics walks to age the cooldowns down, so no frame ever
// has to enumerate the object's keys.
export function stampAbilityCooldown(fighter, id, seconds) {
  if (!id || !(seconds > 0)) return;
  if (!fighter.abilityCooldowns) fighter.abilityCooldowns = {};
  fighter.abilityCooldowns[id] = seconds;
  const live = fighter._abilityCdLive || (fighter._abilityCdLive = []);
  if (live.indexOf(id) === -1) live.push(id);
}

// Clear every ability cooldown (respawn / headless reset). The mirrored live-id
// list is cleared with the map so the two can't drift: a stale id left in the
// list would otherwise be aged against a value that is no longer there.
export function resetAbilityCooldowns(fighter) {
  if (fighter.abilityCooldowns) fighter.abilityCooldowns = {};
  if (fighter._abilityCdLive) fighter._abilityCdLive.length = 0;
}

// Air drag for one frame: AIR_DRAG^(dt*60). The exponent depends only on dt, so
// the result is memoised — Math.pow is one of the slower libm entry points in V8
// and this sits in the physics step of every airborne fighter every frame. At a
// steady frame time the cache hits on every call.
let _airDragDt = -1;
let _airDragValue = 1;
function airDragFactor(dt) {
  if (dt !== _airDragDt) {
    _airDragDt = dt;
    _airDragValue = Math.pow(AIR_DRAG, dt * 60);
  }
  return _airDragValue;
}

// ── Input handling / controller ────────────────────────────────────────────
export function handleFighterInput(fighter, stage, dt, inputFunctions = {}) {
   // Use provided input functions or fall back to default ones
   const isHeld = inputFunctions.isHeld || __isHeld;
   const isJustPressed = inputFunctions.isJustPressed || __isJustPressed;
   const isJustReleased = inputFunctions.isJustReleased || __isJustReleased;

  if (fighter.state === STATES.DEAD || fighter.state === STATES.RESPAWN) return;

// Update temporary VFX. Compacts IN PLACE — one pass that walks the list, keeps
  // the survivors, then truncates — so the array's identity is stable for the
  // readers that index it live (vfx.js draw, combat.js ninjaDsmash), instead of
  // allocating a replacement array from .filter() plus two arrow closures on every
  // frame of every fighter. Order is preserved, so draw order is unchanged.
   const tempVfx = fighter._tempVfx;
   if (tempVfx && tempVfx.length) {
     let w = 0;
     for (let i = 0; i < tempVfx.length; i++) {
       const v = tempVfx[i];
       v.age += dt;
       v.progress = v.age / v.lifetime;
       if (v.progress < 1) tempVfx[w++] = v;
     }
     tempVfx.length = w;
   }

  // The recovery trail is gone: a recovery paints nothing. The upward force,
  // the drift and the free-fall state below are unchanged.

  const p = fighter.playerNum;
  const radius = fighter.radius;

  // Aerial Light recovery assist — air steer. While the launch buff is live the
  // airborne fighter keeps a strong horizontal leash even though the attack lock
  // below normally freezes them mid-swing. This runs BEFORE the combat lock so
  // steering stays responsive through the whole aerialLight swing: hold toward
  // the stage to aim the drift, and the assist's boosted air accel makes that
  // drift feel deliberate rather than locked-straight.
  if (fighter.attack && fighter._aerialRecoveryTimer > 0 && !fighter.grounded && fighter.hitstun <= 0 && !fighter._hitLock && !(fighter._hitLockTimer > 0)) {
    const steerLeft = isHeld(p, 'left');
    const steerRight = isHeld(p, 'right');
    const targetSpeed = fighter.airSpeed * AERIAL_LIGHT_AIR_CONTROL * moveSpeedScale(fighter);
    if (steerLeft && !steerRight) {
      if (fighter.vx > -targetSpeed) {
        fighter.vx = Math.max(-targetSpeed, fighter.vx - AIR_ACCEL * AERIAL_LIGHT_AIR_CONTROL * dt);
      }
      fighter.facingRight = false;
    } else if (steerRight && !steerLeft) {
      if (fighter.vx < targetSpeed) {
        fighter.vx = Math.min(targetSpeed, fighter.vx + AIR_ACCEL * AERIAL_LIGHT_AIR_CONTROL * dt);
      }
      fighter.facingRight = true;
    }
  }

  // Combat lock: while committed to an attack, locked in a hit-confirm, held
  // by a shuriken hit-lock, or knocked into hitstun, the fighter cannot move,
  // jump, dodge, or act. (Shielding is refreshed by combatInput every frame,
  // so a blocker keeps reducing incoming hits.)
  if (fighter.attack || fighter.hitstun > 0 || fighter._hitLock || (fighter._hitLockTimer || 0) > 0) {
    fighter.wantsToDropThrough = false;
    return;
  }

  // Drop-through: set flag when pressing down while grounded on a drop-through
  // platform. Stage.js handles the actual collision skip and velocity.
  fighter.wantsToDropThrough = false;
  if (isHeld(p, 'down') && fighter.grounded && fighter.groundPlatform && fighter.groundPlatform.canDropThrough) {
    fighter.wantsToDropThrough = true;
    // Actually initiate drop-through: unset grounded, give downward velocity
    fighter.grounded = false;
    fighter.groundPlatform = null;
    fighter.groundType = null;
    fighter.vy = 80;
  }

  // === DODGE / DASH-DODGE (§23) ===
  // The dash is a real defensive option: a quick burst that moves the fighter
  // out of danger (escape pressure, dodge attacks/projectiles, create or
  // close distance, reposition). I-frames are SHORT and deliberate (first
  // ~0.15s of the burst) — never the whole dash — so it evades without making
  // the player invincible.
  if (isJustPressed(p, 'dodge') && fighter.dodgeCooldown <= 0) {
    if (fighter.grounded) {
      // Ground dash-dodge
      fighter.dodging = true;
      fighter.dodgeTimer = 0.25;
      fighter.dodgeCooldown = DODGE_COOLDOWN;
      const dir = fighter.facingRight ? 1 : -1;
      fighter.dodgeDirection = { x: dir, y: 0 };
      fighter.vx = dir * 360;
      fighter.invulnTimer = 0.15;
    } else {
      // Air dodge (or wavedash if angled into ground)
      fighter.dodging = true;
      fighter.dodgeTimer = 0.3;
      fighter.dodgeCooldown = AIR_DODGE_COOLDOWN;
      const dx = (isHeld(p, 'right') ? 1 : 0) - (isHeld(p, 'left') ? 1 : 0);
      const dy = isHeld(p, 'down') ? 1 : (isHeld(p, 'jump') ? -1 : 0);
      if (dx === 0 && dy === 0) {
        fighter.dodgeDirection = { x: fighter.facingRight ? 1 : -1, y: 0 };
      } else {
        const len = Math.hypot(dx, dy) || 1;
        fighter.dodgeDirection = { x: dx / len, y: dy / len };
      }
      // Wavedash: if angling down and near ground, convert to horizontal burst
      const isWavedash = dy > 0.5 && Math.abs(fighter.y - (stage.platforms.find(p2 => p2.isGround)?.y || 0) + fighter.radius) < 50;
      if (isWavedash) {
        fighter.dodgeTimer = 0.15;
        fighter.invulnTimer = 0.1;
        fighter.vx = fighter.dodgeDirection.x * 312;
        fighter.vy = 0;
        fighter.grounded = true; // snap to ground
        fighter.wavedashing = true;
      } else {
        fighter.vx = fighter.dodgeDirection.x * 300;
        fighter.vy = fighter.dodgeDirection.y * 300;
        fighter.invulnTimer = 0.15;
      }
    }
  }

  // Dodge timer
  if (fighter.dodging) {
    fighter.dodgeTimer -= dt;
    if (fighter.dodgeTimer <= 0) {
      fighter.dodging = false;
      fighter.dodgeTimer = 0;
      if (fighter.wavedashing) {
        // Wavedash end: friction burst
        fighter.vx *= 0.6;
        fighter.wavedashing = false;
      } else {
        fighter.vx *= 0.3;
        fighter.vy *= 0.3;
      }
    }
    return; // no other input during dodge
  }

// Recovery moves: up-special (only when airborne and not in free-fall).
// Single application per press: sets upward velocity, adds horizontal drift and
// enters free-fall (consumes further up-specials until landing). No VFX.
if (!fighter.grounded && !fighter.freeFall) {
  if (isJustPressed(p, 'special') && isHeld(p, 'up')) {
    // Apply recovery upward force
    fighter.vy = -RECOVERY_UPWARD_FORCE;
    const dx = (isHeld(p, 'right') ? 1 : 0) - (isHeld(p, 'left') ? 1 : 0);
    fighter.vx += dx * RECOVERY_HORIZONTAL_FORCE;
    fighter.freeFall = true;
  }
}
  // === MOVEMENT ===
  const left = isHeld(p, 'left');
  const right = isHeld(p, 'right');
  const jumpHeld = isHeld(p, 'jump');
  const jumpJustPressed = isJustPressed(p, 'jump');
  const jumpJustReleased = isJustReleased(p, 'jump');
  const down = isHeld(p, 'down');

  // The Deadeye Roll's boost, applied to BOTH the ground and the air targets —
  // a buff that only doubled the ground speed would read as "he slides around
  // faster", not as "he is faster".
  const speedScale = moveSpeedScale(fighter);

  // Horizontal movement
  if (fighter.grounded) {
    // Ground movement
    if (left && !right) {
      const targetVx = -fighter.runSpeed * speedScale;
      if (fighter.vx > targetVx) {
        fighter.vx = Math.max(targetVx, fighter.vx - GROUND_ACCEL * dt);
      } else {
        fighter.vx = targetVx;
      }
      fighter.facingRight = false;
    } else if (right && !left) {
      const targetVx = fighter.runSpeed * speedScale;
      if (fighter.vx < targetVx) {
        fighter.vx = Math.min(targetVx, fighter.vx + GROUND_ACCEL * dt);
      } else {
        fighter.vx = targetVx;
      }
      fighter.facingRight = true;
    }
  } else {
    // Air movement
    if (left && !right) {
      if (fighter.vx > -fighter.airSpeed * speedScale) {
        fighter.vx = Math.max(-fighter.airSpeed * speedScale, fighter.vx - AIR_ACCEL * dt);
      }
      fighter.facingRight = false;
    } else if (right && !left) {
      if (fighter.vx < fighter.airSpeed * speedScale) {
        fighter.vx = Math.min(fighter.airSpeed * speedScale, fighter.vx + AIR_ACCEL * dt);
      }
      fighter.facingRight = true;
    }
  }

  // === JUMP ===
  // Coyote time: allow jumping briefly after leaving ground
  const canCoyoteJump = fighter.coyoteTimer > 0 && !fighter.grounded && fighter.jumpsUsed === 0;
  const canBufferJump = fighter.jumpBufferTimer > 0 && fighter.grounded;

  if (jumpJustPressed && (fighter.grounded || canCoyoteJump)) {
    // Normal jump (with coyote time support)
    fighter.vy = down ? SHORTHOP_FORCE : -fighter.jumpForce;
    fighter.grounded = false;
    fighter.groundPlatform = null;
    fighter.canDoubleJump = true;
    fighter.jumpsUsed = 0;
    fighter.jumpPressed = true;
    fighter.fastFalling = false;
    fighter.coyoteTimer = 0;
    fighter.jumpBufferTimer = 0;
    // Reset aerial light recovery when jumping
    fighter.canUseAerialLightRecovery = true;
    // Subtle jump squash: horizontal squash, vertical stretch
    fighter.squishX = 0.88;
    fighter.squishY = 1.12;
    fighter.squishTimer = 0.18;
} else if (canBufferJump && jumpJustPressed) {
    // Buffer: jump pressed just before landing, execute on land
    fighter.vy = down ? SHORTHOP_FORCE : -fighter.jumpForce;
    fighter.grounded = false;
    fighter.groundPlatform = null;
    fighter.canDoubleJump = true;
    fighter.jumpsUsed = 0;
    fighter.jumpPressed = true;
    fighter.fastFalling = false;
    fighter.jumpBufferTimer = 0;
    fighter.squishX = 0.88;
    fighter.squishY = 1.12;
    fighter.squishTimer = 0.18;
    // Reset aerial light recovery when jumping (buffered)
    fighter.canUseAerialLightRecovery = true;
} else if (jumpJustPressed && fighter.canDoubleJump && fighter.jumpsUsed < 1 && !fighter.freeFall) {
    // Double jump (blocked during free-fall)
    fighter.vy = -fighter.doubleJumpForce;
    fighter.canDoubleJump = false;
    fighter.jumpsUsed++;
    fighter.jumpPressed = true;
    fighter.fastFalling = false;
    fighter.squishX = 0.90;
    fighter.squishY = 1.10;
    fighter.squishTimer = 0.15;
    // Allow direction change on double jump
    if (left && !right) fighter.facingRight = false;
    else if (right && !left) fighter.facingRight = true;
    // Subtle double-jump pop: a small ring + a few dust motes kicked
    // downward at the feet. Visual only — velocity and resources untouched.
    {
      const dr = fighter.radius || 22;
      const dstyle = fxStyleFor(fighter);
      emitImpactRing(fighter.x, fighter.y + dr * 0.5, {
        style: dstyle, radius: dr * 0.4, growth: dr * 1.4,
        life: 0.22, alpha: 0.5,
      });
      emitDustPuff(fighter.x, fighter.y + dr * 0.6, 3, {
        style: dstyle, spread: Math.PI * 0.9, dir: Math.PI / 2, speed: 120,
        size: dr * 0.12, life: 0.28, gravity: 160, alpha: 0.4,
      });
    }
}

  // Variable jump height: cut velocity when releasing jump early
  if (jumpJustReleased && fighter.vy < 0 && fighter.jumpPressed) {
    fighter.vy *= JUMP_CUT_MULTIPLIER;
    fighter.jumpPressed = false;
  }

  // Fast fall
  if (down && !fighter.grounded && fighter.vy > 0 && !fighter.fastFalling && !fighter.dropThroughPlatform) {
    fighter.fastFalling = true;
  }
  if (fighter.grounded) {
    fighter.fastFalling = false;
  }

  // Face direction from movement
  if (left && !right) fighter.facingRight = false;
  else if (right && !left) fighter.facingRight = true;
}