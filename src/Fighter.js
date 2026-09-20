// Fighter.js — merged: Physics + Fighter data/state + FighterController input.
// Movement + combat sandbox: run / jump / double jump / fast fall / dash /
// dodge / drop-through plus the data-driven attack system from combat.js.
// Fighters carry `percent` (the damage meter), an active `attack` instance,
// `hitstun` (attack lockout), and a `shielding` flag refreshed each frame.

import { isHeld, isJustPressed, isJustReleased } from './Input.js';

// ============================================================================
// PHYSICS CONSTANTS (from Physics.js)
// ============================================================================

// Lighter, more airborne feel: reduced gravity + lower terminal fall speed.
export const GRAVITY = 1750;
export const MAX_FALL_SPEED = 950;
export const FAST_FALL_MULTIPLIER = 1.8;

// Ground movement. VERY snappy for Smash-like feel.
export const RUN_SPEED = 165;  // Slightly faster
export const GROUND_ACCEL = 3500;   // Increased from 2400 - much faster accel
export const GROUND_DECEL = 1800;   // Increased from 1260 - quicker stop
export const GROUND_FRICTION = 1400; // Increased from 1050 - snappier deceleration

// Air movement - snappier for Smash-like controls
export const AIR_SPEED = 140;   // Slightly faster
export const AIR_ACCEL = 1400;        // Increased from 980 - much faster air control
export const AIR_FRICTION = 500;      // Increased from 350 - quicker air stop
export const AIR_DRAG = 0.94;         // Slightly more drag for tighter control

// Jump
export const JUMP_FORCE = 680;
export const DOUBLE_JUMP_FORCE = 580;
export const JUMP_CUT_MULTIPLIER = 0.4; // releasing jump early cuts velocity
export const SHORTHOP_FORCE = 420;
export const DOUBLE_JUMP_COUNT = 1;

// Dash (reduced ~30%)
export const DASH_SPEED = 266;
export const DASH_DURATION = 0.12; // seconds
export const DASH_COOLDOWN = 0.18;

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

    // Combat — damage meter, active attack instance (managed by combat.js),
    // and hitstun lockout. Percent only ever goes up — no stocks, no KO.
    percent: 0,
    attack: null,
    attackBuffer: null, // queued { type, frames } from combat.js input buffering
    hitstun: 0,
    shielding: false,
    _hitFlash: 0,
    _hitLock: null,     // timed hit-confirm lock set by combat.js on a landed hit

    // Non-hitbox abilities / projectiles
    _projectiles: [],
    _lockedTarget: null,
    _lockTimer: 0,

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
    dashing: false,
    dashTimer: 0,
    dashCooldown: 0,
    dashDirection: 1,
    lastGroundedX: 0,

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
    // Fast fall: increased gravity when holding down during a fall
    if (fighter.fastFalling) {
      grav *= FAST_FALL_MULTIPLIER;
    }
    fighter.vy += grav * dt;
    const fallCap = fighter.fastFalling ? 1150 : MAX_FALL_SPEED;
    if (fighter.vy > fallCap) fighter.vy = fallCap;
  }

  // Apply velocity
  fighter.x += fighter.vx * dt;
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
    } else {
      // Air drag
      fighter.vx *= Math.pow(AIR_DRAG, dt * 60);
    }
  }

  // Dash timer
  if (fighter.dashTimer > 0) {
    fighter.dashTimer -= dt;
    if (fighter.dashTimer <= 0) {
      fighter.dashTimer = 0;
      fighter.dashing = false;
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

  // Invulnerability timer
  if (fighter.invulnTimer > 0) {
    fighter.invulnTimer -= dt;
    if (fighter.invulnTimer < 0) fighter.invulnTimer = 0;
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

  // Landing detection: was airborne, now grounded → trigger landing effects
  if (!fighter.wasGrounded && fighter.grounded) {
    fighter._justLanded = true;
    fighter._landingSpeed = Math.abs(fighter.vy) || 0;
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

// ── Input handling / controller ────────────────────────────────────────────
export function handleFighterInput(fighter, stage, dt) {
  if (fighter.state === STATES.DEAD || fighter.state === STATES.RESPAWN) return;

  const p = fighter.playerNum;
  const radius = fighter.radius;

  // Combat lock: while committed to an attack, locked in a hit-confirm, or
  // knocked into hitstun, the fighter cannot move, jump, dodge, or act.
  // (Shielding is refreshed by combatInput every frame, so a blocker keeps
  // reducing incoming hits.)
  if (fighter.attack || fighter.hitstun > 0 || fighter._hitLock) {
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

  // === DODGE ===
  if (isJustPressed(p, 'dodge') && fighter.dodgeCooldown <= 0) {
    if (fighter.grounded) {
      // Ground dodge
      fighter.dodging = true;
      fighter.dodgeTimer = 0.25;
      fighter.dodgeCooldown = 0.4;
      const dir = fighter.facingRight ? 1 : -1;
      fighter.dodgeDirection = { x: dir, y: 0 };
      fighter.vx = dir * 600;
      fighter.invulnTimer = 0.25;
    } else {
      // Air dodge (or wavedash if angled into ground)
      fighter.dodging = true;
      fighter.dodgeTimer = 0.3;
      fighter.dodgeCooldown = 0.6;
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
        fighter.vx = fighter.dodgeDirection.x * 520;
        fighter.vy = 0;
        fighter.grounded = true; // snap to ground
        fighter.wavedashing = true;
      } else {
        fighter.vx = fighter.dodgeDirection.x * 500;
        fighter.vy = fighter.dodgeDirection.y * 500;
        fighter.invulnTimer = 0.3;
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

  // === MOVEMENT ===
  const left = isHeld(p, 'left');
  const right = isHeld(p, 'right');
  const jumpHeld = isHeld(p, 'jump');
  const jumpJustPressed = isJustPressed(p, 'jump');
  const jumpJustReleased = isJustReleased(p, 'jump');
  const down = isHeld(p, 'down');

  // Horizontal movement
  if (fighter.grounded) {
    // Ground movement
    if (left && !right) {
      const targetVx = -fighter.runSpeed;
      if (fighter.vx > targetVx) {
        fighter.vx = Math.max(targetVx, fighter.vx - GROUND_ACCEL * dt);
      } else {
        fighter.vx = targetVx;
      }
      fighter.facingRight = false;
    } else if (right && !left) {
      const targetVx = fighter.runSpeed;
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
      if (fighter.vx > -fighter.airSpeed) {
        fighter.vx = Math.max(-fighter.airSpeed, fighter.vx - AIR_ACCEL * dt);
      }
      fighter.facingRight = false;
    } else if (right && !left) {
      if (fighter.vx < fighter.airSpeed) {
        fighter.vx = Math.min(fighter.airSpeed, fighter.vx + AIR_ACCEL * dt);
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
  } else if (jumpJustPressed && !fighter.grounded) {
    // Airborne but no jump available: buffer the jump for landing
    fighter.jumpBufferTimer = 0.1;
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