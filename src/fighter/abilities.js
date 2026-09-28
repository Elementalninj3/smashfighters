// abilities.js â€” non-hitbox ability registry. Abilities are assigned to an
// animation through the editor (anim.combat = { type: 'nonHitbox', abilityId }).
// When an attack whose animation carries one of these plays, combat.js routes
// it here instead of spawning a hitbox: the ability fires once at castFrame and
// the attack lasts `frames` total frames. All procedural â€” no assets.
//
// Every ability here belongs to a CHARACTER: one is bound to a move on exactly
// one fighter's attack table (cowboy* / ninja* below). There are no generic /
// character-agnostic entries â€” a move that is not on a character's table has no
// ability to bind, and the animator editor's ability menu lists exactly these.
//
// An ability may also declare `cooldown` (seconds). combat.js owns the gate: a
// move whose ability is cooling down does not start at all, and the timer is
// stamped when the ability actually FIRES (not when the swing starts), so an
// attack interrupted before its cast frame costs nothing. See
// abilityCooldownFor() at the foot of this file.

import { SFX } from '../core/sfx.js';
import { spawnTempVfx } from './Fighter.js';
import { resolveWorldAnchor, playShadowStrikeVFX, playSmokePoofVFX } from '../effects/vfx.js';
import {
  triggerTimeDilation,
  emitAbilityFx,
  emitFlash,
  emitImpactRing,
  emitSparks,
  emitDustPuff,
  emitStreak,
  fxStyleFor,
  spawnFloatingText,
} from '../render/worldFx.js';

// â”€â”€ Cowboy horse ride â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Down Heavy (Down Smash) summons a horse beneath the cowboy, who mounts it
// and rides forward while it tramples opponents with its own active hitbox.
// The ride lives on `fighter._horse`; combat.js owns the mount mechanics, the
// renderer draws it underneath the rider (Effects.drawHorse), Game.js skips
// floor collision for the lifted rider, and the shared hitbox registry runs the
// trample (one hit per target per activation via the attack's hitIds).
//
// Geometry is derived from the rider's ball radius so the horse's hooves rest
// on the floor the rider stood on while the rider sits ON the saddle:
//   lift = rider center rises by -(drawH/2 + back) to reach the saddle
//   dy   = horse center sits `radius + back` below the lifted rider center
// (The sprite is GA/weapons/cowboyhorse.png, 1536Ã—1024 â€” drawn at drawH.)
// Balance (2026-09): ability damage Ã—0.40, knockback Ã—0.50 â€” same rule as
// melee tables. launchAngle authoritative per attack (angle kept as alias).
const HORSE_PRESET = {
  sprite: '/GA/weapons/cowboyhorse.png',
  drawW: 144,
  drawH: 96,
  back: 0.30,   // saddle height above the horse's center, as a fraction of drawH
  fx: 16,       // horse center ahead of the rider's center, in the facing direction
  speed: 137,   // 228 Ã— 0.60 (Â§46) forward ride speed while mounted
  hitbox: {
    name: 'Horse Ride',
    dmg: 4.8,
    kbBase: 190,
    kbGrowth: 1.1,
    angle: 62, // strong upward + outward launch
    launchAngle: 62,
    horizontalKnockback: 0.47,
    verticalKnockback: 0.88,
    w: 130,
    h: 100,
  },
};

// The Shuriken's visual size, as a multiple of the registered weapon's authored
// 32px. The drawn sprite and the projectile's hurtbox radius are BOTH derived
// from this one number (see ninjaFsmash), so what the player sees and what the
// projectile hits can never drift apart.
const SHURIKEN_DRAW_SCALE = 1.2;          // 32px art -> ~38px thrown
// The solid core of the star, as a fraction of the drawn width. Deliberately
// sized so the hurtbox stays at the move's ORIGINAL ~8px radius: the art is a
// stylised star whose points are decoration, and shrinking the drawing must not
// quietly weaken the throw. A ~11px gap between the drawn point and the hurtbox
// edge is the cost of that, and is well inside the 108px travel.
const SHURIKEN_HIT_RADIUS_RATIO = 0.2083;  // 38.4px art -> ~8px hurtbox radius

// â”€â”€ Teleport Strike (ninja Down Light) charge â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// The ninja does NOT blink out the instant the button is pressed: the move
// charges first, then teleports. 0.4s of charge, counted in the same 60fps frame
// budget the rest of the game counts in (the Shadow Strike trail does the same
// with frames/60), so the wait is a real 0.4s on screen and not a frame-rate
// accident.
//
// The whole thing is split in two so nothing here needs a clock of its own:
//   run()  â€” fires on the attack's castFrame. Validates the move, marks the spot
//            it was activated on, throws the charge smoke there, and ARMS the
//            delay. It moves the fighter NOTHING.
//   warp() â€” called by combat.js NINJA_TELEPORT_DELAY_FRAMES later, once the
//            delay has actually elapsed on the attack's own frame clock. Re-finds
//            the target (it may have moved during the charge), computes the spot
//            behind it, warps, and lets combat register the strike box there.
const NINJA_TELEPORT_DELAY = 0.4;                       // seconds of charge
const NINJA_TELEPORT_DELAY_FRAMES = Math.round(NINJA_TELEPORT_DELAY * 60); // 24
// The strike window the Teleport Strike's blow runs for, mirrored from
// NINJA_ATTACKS.dtilt.active. It has to be a constant here because the move's
// total length (`frames`) is read at attack START, before the attack table row
// that the ability is merged onto even exists.
const NINJA_TELEPORT_STRIKE_FRAMES = 5;
// How long the departure burst lingers after the ninja has blinked out.
const NINJA_TELEPORT_PUFF_FRAMES = 36;

// â”€â”€ Boxer: the Grab, the Deadeye Roll, the Straight Right â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// The boxer's three signature moves. All three follow the same split as the
// Teleport Strike: the ability owns WHAT happens and hands the frame stepping to
// combat.js, because abilities.js must never import combat.js.
//
//   Grab (Down Light)  â€” a reach, a hold, then a punch that sends the target
//                        away. `run()` only finds the target and announces the
//                        move; combat.js owns the hold and applies the punch
//                        through the shared deliverHit path.
//   Deadeye Roll (Down Heavy) - blink behind the target, then a rapid
//                        barrage of fists ending in a launching finale.
//                        run() only teleports and arms the barrage;
//                        combat.js owns the hold, the ticks and the finale
//                        through the shared hit path (same split as the Grab).
//   Straight Right (Forward Heavy) â€” a real strike box (strikeHitbox) with the
//                        loudest numbers in the game, and deliberately the
//                        quietest art in it.
const BOXER_GRAB = {
  // How far the reach looks for something to hold. Two fighters already in
  // contact are ~60px apart, so this covers a genuine grab and a short step-in.
  range: 88,
  // How long the target hangs in the hold before the punch lands (~0.23s).
  holdFrames: 14,
  // How far in front of the boxer the held target floats.
  holdOffset: 58,
  // The punch that ends the move. `dmg`/`kbBase`/`kbGrowth` are on the shared
  // 0.40 / 0.50 balance rule the attack tables use (see BOXER_ATTACKS), and the
  // launch is a flat outward send â€” the grab's whole point is that the target
  // leaves, not that it spikes.
  punch: {
    name: 'Grab Punch',
    dmg: 9.6,
    kbBase: 200,
    kbGrowth: 1.1,
    angle: 34,
    launchAngle: 34,
    horizontalKnockback: 0.92,
    verticalKnockback: 0.4,
    hitConfirm: 0.05,
  },
  // The catch itself: a small ring + flash on the target. Deliberately modest â€”
  // the PUNCH is the beat that should be loud.
  holdFlash: { radius: 0.42, life: 0.09, alpha: 0.7 },
};

// ── Deadeye Assault (boxer Down Heavy) tuning ─────────────────────────────
// The boxer blinks in BEHIND the target and pummels it with a rapid barrage
// of fists before a launching finale. `run()` only teleports + arms the
// barrage; combat.js owns the hold, the ticks and the finale through the
// shared hit path (same split as the Grab), because abilities.js must never
// import combat.js.
const BOXER_ASSAULT = {
  // How far the roll looks for a target to appear behind.
  range: 420,
  // Distance behind the target the boxer appears at (relative to the
  // TARGET's facing — genuinely behind them, not just beside them).
  standOff: 64,
  // Fist blows before the launcher: count, cadence and per-blow damage.
  // 5 x 1.2 + 5.0 finale ≈ 11 total — the heaviest sequence in the game, on
  // a 3.5s cooldown and only in range.
  ticks: 5,
  tickInterval: 0.09,
  tickDmg: 1.2,
  // How far in front of the boxer the pinned target hangs during the barrage.
  holdOffset: 46,
  // The launching finale. Same balance rule as the attack tables (dmg x0.40,
  // kb x0.50 already applied in these numbers) and resolved through
  // launchFromHit, so shields, weight and hitstun obey the shared rules.
  finale: {
    name: 'Deadeye Finale',
    dmg: 5.0,
    kbBase: 170,
    kbGrowth: 0.9,
    angle: 35,
    launchAngle: 35,
    horizontalKnockback: 0.82,
    verticalKnockback: 0.57,
  },
  // With no target in reach the move blinks a short step forward instead of
  // whiffing in place — a small consolation that can never start a barrage.
  whiffBlink: 150,
};

// The roll's cooldown, in seconds. combat.js owns the gate and stamps the timer
// at the cast, so an interrupted cast costs nothing (see abilityCooldownFor).
const BOXER_ROLL_COOLDOWN = 3.5;

const BOXER_STRAIGHT = {
  // The Straight Right's reach streak: short, thin, and over almost at once.
  reachLife: 0.16,
  reachScale: 1,
};

// Muzzle world-space position for a spawned projectile. Prefers the resolved
// 'weapon' anchor of the attack's animation (hands/rifle hold it at the cast
// pose â€” the bullet leaves the barrel), mirrored correctly when facing left.
// Falls back to a reach-forward offset when no animation/weapon is available.
const _spawnPos = { x: 0, y: 0 };
function projectileSpawn(fighter, dir) {
  if (
    fighter.anim && fighter.anim.out &&
    fighter.anim.out.weapons && (fighter.anim.out.weapons.right || fighter.anim.out.weapons.left)
  ) {
    resolveWorldAnchor(fighter, { anchor: 'weapon' }, _spawnPos);
    return { x: _spawnPos.x, y: _spawnPos.y };
  }
  return { x: fighter.x + dir * 42, y: fighter.y - 6 };
}

export const ABILITIES = {
  cowboyFwdHeavy: {
    name: 'Side Smash',
    frames: 34,
    castFrame: 6,
    run(fighter, atk, cfg) {
      const dir = atk.facing || (fighter.facingRight ? 1 : -1);
      const list = fighter._projectiles || (fighter._projectiles = []);
      const pos = projectileSpawn(fighter, dir);
      list.push({
        owner: fighter,
        x: pos.x,
        y: pos.y,
        vx: dir * 650,
        vy: 0,
        r: 10,
        facing: dir,
        life: 2.0,
        dead: false,
        // The projectile trail is the VFX system's cowboyTrail effect, riding
        // the bullet's world position + travel angle (see Effects.js). It is a
        // draw-only trail â€” never a hitbox of its own.
        trail: 'cowboyTrail',
        def: {
          name: 'Side Smash',
          dmg: 6.4,
          kbBase: 165,
          kbGrowth: 0.95,
          angle: 38,
          launchAngle: 38,
          kbDir: dir,
          w: 28, h: 28, ox: 0, oy: 0,
        },
        muzzleDone: false,
      });
      SFX.rifleShot();
      emitAbilityFx(fighter, atk, 'muzzle');
    },
  },
  cowboyDownLight: {
    name: 'Down Light',
    frames: 26,
    castFrame: 2,
    // 7s. Deadeye is a full-screen, six-bullet homing volley that also dilates
    // time for the whole arena, and the shared 0.83s attack lock (Â§45) is the ONLY
    // thing between two casts of it. Without a cooldown of its own it can be
    // re-cast the instant that lock clears, chaining slow-mos together.
    cooldown: 7,
    run(fighter, atk, cfg) {
      // Trigger the time dilation (orange arena tint + slow-mo). holdUntilRelease
      // keeps the whole arena at the slow factor while the Deadeye volley is
      // live â€” combat.js calls releaseTimeDilation() the instant every bullet
      // has resolved, so the slow-mo can't cut the volley off early or linger.
      triggerTimeDilation({
        factor: cfg && cfg.factor != null ? cfg.factor : 0.12,
        rampIn: cfg && cfg.rampIn != null ? cfg.rampIn : 0.15,
        hold: cfg && cfg.hold != null ? cfg.hold : 1.20,
        fade: cfg && cfg.fade != null ? cfg.fade : 1.00,
        tintMax: cfg && cfg.tintMax != null ? cfg.tintMax : 0.40,
        flashDur: cfg && cfg.flashDur != null ? cfg.flashDur : 0.20,
        attackerPlayerNum: fighter.playerNum,
        holdUntilRelease: true,
        // Down Light is the most distorted state in the game: the arena goes
        // INVERTED (photographic negative) while time is dilated, on top of the
        // orange tint, and rides the same ramp/hold/fade envelope. The post-
        // process washes that negative back with orange so it reads hot rather
        // than the cold cyan a bare inversion would leave. No screen warp â€” it
        // fought the readability of the homing bullets for no gain.
        invertMax: cfg && cfg.invertMax != null ? cfg.invertMax : 0.85,
      });
      SFX.deadeyeShot();
      emitAbilityFx(fighter, atk, 'volley');

      // === DEADEYE: hand the volley config to combat (fighter-owned state) ===
      // The bullet spawning + homing is driven by combat.js every frame (so it
      // keeps working after this attack ends, until EVERY bullet has hit). To
      // avoid an modules cycle (combat.js imports getAbility from here), the
      // cast simply arms fighter._deadeyePending and combat adopts it.
      fighter._deadeyePending = {
        bulletCount: cfg && cfg.bulletCount != null ? cfg.bulletCount : 6,
        shotDelay: cfg && cfg.shotDelay != null ? cfg.shotDelay : 0.09, // 90ms between shots
        bulletSpeed: cfg && cfg.bulletSpeed != null ? cfg.bulletSpeed : 2200, // Faster base speed
        bulletDamage: cfg && cfg.bulletDamage != null ? cfg.bulletDamage : 3.2,
        bulletKBBase: cfg && cfg.bulletKBBase != null ? cfg.bulletKBBase : 100,
        bulletKBGrowth: cfg && cfg.bulletKBGrowth != null ? cfg.bulletKBGrowth : 0.75,
        bulletAngle: cfg && cfg.bulletAngle != null ? cfg.bulletAngle : 15,
        // Smaller visual slug â€” collision stays reliable via the swept homing
        // hit rule (hit radius comes from the bullet r + the target radius,
        // not from the drawn size).
        bulletSize: cfg && cfg.bulletSize != null ? cfg.bulletSize : 6,
        homingStrength: cfg && cfg.homingStrength != null ? cfg.homingStrength : 25.0, // MUCH stronger turn rate
        trailLength: cfg && cfg.trailLength != null ? cfg.trailLength : 5,
        bulletLifetime: cfg && cfg.bulletLifetime != null ? cfg.bulletLifetime : 5.0, // Longer lifetime (seconds)
      };
    },
  },
  cowboyDownHeavy: {
    name: 'Down Heavy',
    frames: 34,
    castFrame: 6,
    run(fighter, atk, cfg) {
      const horse = (cfg && cfg.horse) || HORSE_PRESET;
      const dir = atk.facing || (fighter.facingRight ? 1 : -1);
      const radius = fighter.radius;
      const back = horse.drawH * horse.back;
      // Mount the rider at the height they stood on (rideBaseY) and glue the
      // horse center below it so the hooves hit the same floor line. combat.js
      // positions/glues both every frame and registers the trample hitbox.
      fighter._horse = {
        sprite: horse.sprite,
        dir,
        x: fighter.x + dir * horse.fx,
        y: fighter.y + radius + back,
        fx: horse.fx,
        rideBaseY: fighter.y,
        lift: -(horse.drawH / 2 + back),
        dy: radius + back,
        drawW: horse.drawW,
        drawH: horse.drawH,
        speed: horse.speed,
        hitboxId: 0, // filled by combat.js when the trample hitbox is registered
        def: {
          name: horse.hitbox.name,
          dmg: horse.hitbox.dmg,
          kbBase: horse.hitbox.kbBase,
          kbGrowth: horse.hitbox.kbGrowth,
          angle: horse.hitbox.angle,
          w: horse.hitbox.w,
          h: horse.hitbox.h,
          ox: horse.fx,
          oy: 0,
        },
      };
      SFX.gallop();
      emitAbilityFx(fighter, atk, 'mount');
    },
  },
  ninjaFsmash: {
    name: 'Shuriken Throw',
    frames: 28,
    castFrame: 8,
    run(fighter, atk, cfg) {
      // VERY short-range projectile: spawns at the live hand/weapon anchor (the
      // hand pose at the cast frame â€” never the fighter center), travels forward
      // in the facing direction only, and disappears on its own if it hits
      // nothing. Range = speed Ã— life â‰ˆ 108px, half the previous throw and a
      // fraction of every other projectile in the game (the generic bullet flies
      // ~730px, the cowboy's rifle bullet ~1300px) â€” it is a knife, not a gun.
      // The blade is drawn BIG (see drawSize) so the close range is a visual
      // feature: a huge spinning star that has to be right in front of you.
      const dir = atk.facing || (fighter.facingRight ? 1 : -1);
      const list = fighter._projectiles || (fighter._projectiles = []);
      const pos = projectileSpawn(fighter, dir);
      const speed = (cfg && cfg.speed) || 720;
      // Drawn at SHURIKEN_DRAW_SCALE x the weapon's authored 32px. The same
      // number sizes the hurtbox, so the blade and what it hits stay in step.
      const drawSize = (cfg && cfg.drawSize) || 32 * SHURIKEN_DRAW_SCALE;
      const hitR = drawSize * SHURIKEN_HIT_RADIUS_RATIO;
      list.push({
        owner: fighter,
        x: pos.x,
        y: pos.y,
        vx: dir * speed,
        vy: 0,
        r: hitR,
        facing: dir,
        life: (cfg && cfg.life) || 0.15,
        dead: false,
        spin: 0, // advanced by combat so the shuriken visibly spins in flight
        trail: 'ninjaTrail',
        // The projectile IS the registered `shuriken` weapon, so the renderer
        // draws that weapon's own sprite (GA/weapons/shuriken.png) instead of
        // any generated shape, at SHURIKEN_DRAW_SCALE x its authored size.
        weaponId: 'shuriken',
        drawSize,
        def: {
          name: 'Shuriken Throw',
          // The projectile's damage lives HERE, not in NINJA_ATTACKS.fsmash: this
          // is a nonHitbox ability move, so the attack table's row is only the
          // move's shell (name/anim/geometry) and the blade's real damage is the
          // ability's own default. It therefore has to be buffed in lockstep with
          // the table's ninja buffs â€” see the NINJA_ATTACKS header in combat.js.
          // 9.408 = the table's original 4.8 Ã— 1.4 Ã— 1.4.
          dmg: (cfg && cfg.dmg) || 9.408,
          kbBase: (cfg && cfg.kbBase) || 90,
          kbGrowth: 0.6,
          angle: 15,
          launchAngle: 15,
          kbDir: dir,
          hitLockDuration: (atk && atk.def && atk.def.hitLockDuration) || (cfg && cfg.hitLockDuration) || 0.5,
          w: 24, h: 24, ox: 0, oy: 0,
        },
      });
      SFX.shurikenThrow();
      emitAbilityFx(fighter, atk, 'throw');
    },
  },
  ninjaDsmash: {
    name: 'Shadow Strike',
    frames: 32,
    castFrame: 10,
    // The dash ends in a REAL blow. `strikeHitbox` tells combat.js that this
    // cast lands one, so combat registers the attack's own melee box (damage,
    // knockback, launch angle and geometry â€” all from the attack table, no
    // numbers duplicated here) on the SHARED hitbox registry at the cast frame
    // and runs it for the attack's own `active` window. The box is centered on
    // the fighter (ox/oy 0 â€” it travels WITH the dasher), so anything the dash
    // passes through / lands on takes the knockback. Damage, hitstun, the
    // shield check and the one-hit-per-target rule are therefore the game's
    // existing ones â€” this ability only decides WHERE (the dash) and WHEN (the
    // cast frame) the strike happens. Same hand-off the cowboy's Down Smash uses
    // for its horse (see runAbility / advanceNonHitbox in combat.js).
    strikeHitbox: true,
    run(fighter, atk, cfg) {
      // Shadow Dash travels a FIXED distance FORWARD in the direction the
      // player was facing when the ability STARTED â€” never toward a world
      // coordinate, mouse position, target, or previous position.
      //
      // The direction is `atk.facing`: startAttack captures it from
      // `fighter.facingRight` on the activation frame and nothing can change it
      // for the rest of the swing. Reading the LIVE `fighter.facingRight` here
      // instead (as this used to) made the dash aim at whatever the fighter
      // happened to face by the cast frame ~10 frames later, so a direction
      // change during startup â€” or the AI/movement layer re-aiming the body â€”
      // silently sent the dash the other way. The activation snapshot is the
      // only facing that matches "where the player is looking right now".
      //
      // Travel is a constant velocity held for the dash window and re-asserted
      // every frame by combat (see advanceNonHitbox), so the dash covers its
      // authored distance from ANY position on the map â€” it simply starts where
      // the player is and goes the way they were facing. Nothing â€” world coords,
      // target position, or a facing change â€” can reverse or redirect it.
      const dir = atk.facing || (fighter.facingRight ? 1 : -1);
      const dashDist = (cfg && cfg.dashDistance) || (atk && atk.def && atk.def.dashDistance) || 192;
      // The burst SPEED is a property of the move (dashSpeed), and the distance
      // is a property of the attack table (dashDistance): the window is derived
      // as distance / speed. So raising dashDistance makes the dash travel
      // further at the SAME speed â€” it does not silently turn the move into a
      // faster one, and the feel of the dash is unchanged.
      const dashSpeed = (cfg && cfg.dashSpeed) || 800;
      const dashDur = (cfg && cfg.duration) || (dashDist / dashSpeed);
      // `dashing` suppresses ground friction / air drag for the whole window,
      // and Fighter.js ends the burst by zeroing the velocity â€” so the fighter
      // covers exactly dashDistance and stops, instead of coasting an extra
      // friction-dependent distance that would make "fixed distance" a lie.
      fighter.vx = dir * dashSpeed;
      fighter.vy = 0;
      fighter.dashing = true;
      fighter.dashTimer = dashDur;
      fighter._shadowDashDir = dir;
      fighter._shadowDashSpeed = dashSpeed;
      // Remaining travel for the burst, in pixels. The engine integrates
      // velocity per frame and clamps dt, so a timer-only burst would cover
      // ceil(distance / (speed*dt)) * speed*dt â€” i.e. up to a whole frame of
      // extra travel, making the realised distance frame-rate dependent. This
      // budget lets Fighter.js spend only what is left of `dashDistance`, so
      // the move covers exactly what the attack table asks for, at any frame
      // rate, from any position.
      fighter._shadowDashRemain = dashDist;
      SFX.shadowStrike();
      // Visual: the anime shadow dash (GA/vfx/shadowdash.html art, converted in
      // src/effects/art.js) is spawned here â€” the single call that arms it â€” and
      // paints itself backwards over the distance the dash ACTUALLY covered (a
      // dash clipped by the arena edge draws the shorter trail it really
      // travelled). Its lifetime is this attack's own remaining frames, so it
      // dies with the move. The effect is purely cosmetic: it moves nothing â€”
      // the dash above already did that â€” and it owns no hitbox, no collision
      // and no damage. The blow is the shared-registry hitbox that
      // `strikeHitbox` above hands to combat at this very cast frame.
      const self = ABILITIES.ninjaDsmash;
      playShadowStrikeVFX(fighter, dir, {
        travelled: 0, // Will be updated dynamically in advanceNonHitbox if needed
        frames: Math.max(1, (atk.totalFrames || self.frames) - (atk.frame || self.castFrame)),
      });
    },
  },

  // â”€â”€ Down Light: Teleport Strike â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Warps the ninja to a spot DIRECTLY BEHIND the opponent â€” behind relative to
  // the OPPONENT's own facing, i.e. on the side they are looking away from â€” and
  // lets the move's ordinary melee box run from there. The blow itself is not
  // special-cased: `strikeHitbox` hands NINJA_ATTACKS.dtilt (damage, knockback,
  // geometry) to the shared hitbox registry, and resolveHitDir resolves the launch
  // from the two fighters' positions, so the knockback always goes away from the
  // ninja because the ninja is by construction behind the target.
  //
  // The move is a DELAYED cast (see NINJA_TELEPORT_DELAY above): run() arms the
  // 0.4s charge and throws the smoke on the spot the player pressed, and warp()
  // is called by combat.js once the charge is up. Because the strike box belongs
  // at the ARRIVAL end of the warp, run() sets atk.deferStrike and combat's
  // normal same-frame strike hand-off is skipped â€” the box is registered by
  // combat right after warp() returns, with the facing the warp just chose.
  ninjaDtilt: {
    name: 'Teleport Strike',
    // cast(3) + charge(48) + strike(5) + a short tail, so the move always ends
    // after the blow has landed.
    frames: 3 + NINJA_TELEPORT_DELAY_FRAMES + NINJA_TELEPORT_STRIKE_FRAMES + 4,
    castFrame: 3,
    // The delay the charge runs for, in frames. combat.js reads it off the armed
    // attack to know when to call warp() (see NINJA_TELEPORT_DELAY_FRAMES).
    delayFrames: NINJA_TELEPORT_DELAY_FRAMES,
    strikeHitbox: true,
    run(fighter, atk, cfg, ctx) {
      // No valid target right now: the move plays out as a plain whiff â€” it must
      // not swing at empty space. Refused BEFORE the charge is armed, so a whiff
      // costs nothing: no smoke, no delay, no warp, no strike.
      if (!teleportTarget(fighter, cfg, ctx)) {
        atk.suppressStrike = true;
        return;
      }

      // The spot the move was ACTIVATED on. This is the departure point: the
      // smoke goes off here, and it stays here for the whole charge even though
      // the fighter is about to be somewhere else entirely.
      const fromX = fighter.x;
      const fromY = fighter.y;
      // Arm the charge. combat.js steps this on the attack's own frame clock and
      // calls warp() when the delay is up; clearing the flag (teardown, hitstun,
      // respawn) cancels the teleport outright.
      fighter._teleportPending = { fromX, fromY };
      atk.deferStrike = true;
      atk.teleportDelayFrames = NINJA_TELEPORT_DELAY_FRAMES;
      atk.teleportDone = false;
      // The charge cloud: the demo's grey smoke bomb art (GA/vfx/smoke.html,
      // converted in src/effects/art.js), pinned to the activation spot and living
      // for exactly the charge, so the ninja is visibly standing in smoke the
      // whole time they are about to blink out.
      playSmokePoofVFX(fighter, {
        x: fromX,
        y: fromY,
        lifetime: NINJA_TELEPORT_DELAY,
      });
      SFX.smokePoof();
    },
    // The actual warp, run by combat.js once the charge has elapsed. Everything
    // about WHERE the ninja lands is decided here, against the target's position
    // as it is NOW (0.8s after the press) rather than where it was when the move
    // was cast.
    warp(fighter, atk, cfg, ctx) {
      // The one target this move cares about: a live opponent, in play, in
      // range. Anything else (dead, eliminated, out of reach, off-stage) is not
      // a valid target â€” the move refuses rather than warping nowhere. The target
      // can genuinely be gone by the time the charge is up (it may have been hit,
      // KO'd or simply walked off), in which case the move fizzles exactly like
      // a whiff: no warp and no strike.
      const target = teleportTarget(fighter, cfg, ctx);
      if (!target) {
        atk.suppressStrike = true;
        return;
      }

      // Where "behind the opponent" is, in world space, from the OPPONENT's
      // facing â€” never a fixed point on the map, and never the ninja's own
      // facing: the whole point of the move is to appear on the blind side.
      const back = target.facingRight ? -1 : 1;
      let tx = target.x + back * standOffFor(cfg);
      let ty = target.y;

      // Placement validity. The destination is beside the opponent at the
      // opponent's own height, which is already a spot the opponent occupies
      // legally; the checks below only stop the warp from being pushed off the
      // stage or into solid geometry by the stand-off.
      const r = fighter.radius || 22;
      const stage = (ctx && ctx.stage) || null;
      if (stage && stage.platforms && stage.platforms.length) {
        // Prefer the surface the opponent is actually standing on: keep the
        // landing inside that platform's footprint (inset by the body radius so
        // the ninja cannot end up embedded in the edge).
        const surf = target.groundPlatform && stage.platforms.indexOf(target.groundPlatform) !== -1
          ? target.groundPlatform
          : null;
        if (surf) {
          tx = Math.max(surf.x + r, Math.min(surf.x + surf.width - r, tx));
        } else {
          // Airborne target: keep the landing inside the stage bounds.
          const bz = stage.blastZones || {};
          const lo = (bz.left != null ? bz.left : 0) + r;
          const hi = (bz.right != null ? bz.right : 1200) - r;
          tx = Math.max(lo, Math.min(hi, tx));
        }
        // Never land inside a platform: if the spot falls within one, stand on
        // top of it instead of inside it.
        for (const plat of stage.platforms) {
          if (tx + r * 0.6 > plat.x && tx - r * 0.6 < plat.x + plat.width
              && ty + r > plat.y && ty - r < plat.y + plat.height) {
            ty = plat.y - r;
          }
        }
      } else {
        // No stage registered (tests / headless contexts): fall back to a plain
        // world bound so the warp can never leave the arena.
        tx = Math.max(r, Math.min(1200 - r, tx));
      }

      // The warp itself. Zeroing the velocities is what makes it a teleport
      // rather than a shove: the ninja arrives stopped, and the platform pass
      // resolves the landing normally on the next frame.
      fighter.x = tx;
      fighter.y = ty;
      fighter.vx = 0;
      fighter.vy = 0;
      // Face the opponent from the new spot, and â€” importantly â€” point the
      // ATTACK record the same way, so the strike box combat registers right
      // after this cast extends toward the target rather than away from it.
      const strikeDir = target.x >= tx ? 1 : -1;
      fighter.facingRight = strikeDir >= 0;
      atk.facing = strikeDir;
      atk._teleportTarget = target.id;

      // The departure burst: the ninja is gone from this spot, so the smoke that
      // hides the disappearance goes off on the spot the move was ACTIVATED on
      // (not on the arrival point, and not on wherever the fighter drifted to).
      const pend = fighter._teleportPending;
      const fromX = pend ? pend.fromX : fighter.x;
      const fromY = pend ? pend.fromY : fighter.y;
      playSmokePoofVFX(fighter, {
        x: fromX,
        y: fromY,
        lifetime: NINJA_TELEPORT_PUFF_FRAMES / 60,
      });
      emitAbilityFx(fighter, atk, 'teleport');
    },
  },

  // â”€â”€ The Grab (boxer Down Light) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Reach out, catch the opponent, hold them there for a beat and then punch
  // them across the stage. The hold is real game state owned by combat.js
  // (`fighter._boxerGrab`); this cast only decides WHETHER there is anything to
  // hold, and hands the punch's numbers over. A press with no opponent in range
  // is a plain whiff â€” the same rule the Teleport Strike uses, so the move never
  // swings at empty air and never costs anything for a miss.
  boxerDtilt: {
    name: 'Grab',
    frames: 3 + BOXER_GRAB.holdFrames + 12,
    castFrame: 3,
    run(fighter, atk, cfg, ctx) {
      const target = boxerGrabTarget(fighter, cfg, ctx);
      // No target in reach: the press plays out as a plain whiff. The grab
      // registers no strike box of its own, so there is nothing to suppress â€”
      // the move simply reaches at nothing and recovers.
      if (!target) return;
      // A grab reaches, so the boxer turns to face what it caught â€” and the
      // ATTACK record is pointed the same way, so the punch that follows throws
      // the target away from the boxer rather than back over its own shoulder.
      const dir = target.x >= fighter.x ? 1 : -1;
      fighter.facingRight = dir >= 0;
      atk.facing = dir;
      fighter._boxerGrabPending = {
        targetId: target.id,
        holdFrames: (cfg && cfg.holdFrames) || BOXER_GRAB.holdFrames,
        holdOffset: (cfg && cfg.holdOffset) || BOXER_GRAB.holdOffset,
        punch: (cfg && cfg.punch) || BOXER_GRAB.punch,
        facing: dir,
      };
      // The move announces itself in words, because the hold itself is silent:
      // a frozen opponent with no feedback reads as a bug, not as a grab.
      spawnFloatingText(
        target.x,
        target.y - target.radius - 10,
        'GRAB',
        '#ff8a65',
        { life: 0.9, size: 22 }
      );
      const style = fxStyleFor(fighter);
      const r = target.radius || 22;
      const hf = (cfg && cfg.holdFlash) || BOXER_GRAB.holdFlash;
      emitFlash(target.x, target.y, {
        style, radius: r * hf.radius, life: hf.life, alpha: hf.alpha, color: '#ffd6c2',
      });
      emitImpactRing(target.x, target.y, {
        style, wave: true, radius: r * 0.5, growth: r * 1.1,
        life: 0.22, alpha: 0.5, color: '#ff8a65',
      });
      SFX.grabImpact();
    },
  },

  // â”€â”€ The Deadeye Roll (boxer Down Heavy) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // A blink-and-pummel: the boxer teleports in BEHIND the target and works it
  // over with a rapid barrage of fists, ending in a launching finale. run()
  // only teleports and arms the barrage; combat.js owns the hold, the ticks
  // and the finale (same split as the Grab), stepping fighter._boxerAssault
  // every frame until the move ends or the boxer is interrupted. With no
  // target in reach the move blinks instead.
  boxerDsmash: {
    name: 'Deadeye Roll',
    frames: 48,
    castFrame: 1,
    cooldown: BOXER_ROLL_COOLDOWN,
    run(fighter, atk, cfg, ctx) {
      const style = fxStyleFor(fighter);
      const r = fighter.radius || 22;
      const fromX = fighter.x, fromY = fighter.y;
      let target = teleportTarget(fighter, cfg, ctx);
      // Never pummel an invulnerable (respawning) fighter: that damage would
      // be eaten by i-frames while the barrage still plays out.
      if (target && (target.invulnTimer || 0) > 0) target = null;
      if (!target) {
        // No target in reach: blink a short step forward with dust at both
        // ends. No barrage is armed, so the move is pure (modest) movement.
        const wdir = atk.facing || (fighter.facingRight ? 1 : -1);
        const blink = (cfg && cfg.whiffBlink) || BOXER_ASSAULT.whiffBlink;
        fighter.x = clampToBlast(fighter.x + wdir * blink, ctx, 30);
        fighter.vx = 0;
        fighter.vy = 0;
        emitDustPuff(fromX, fromY, 4, {
          style, spread: Math.PI * 2, speed: 120, size: r * 0.14,
          life: 0.3, gravity: 80, alpha: 0.45,
        });
        emitDustPuff(fighter.x, fighter.y, 4, {
          style, spread: Math.PI * 2, speed: 120, size: r * 0.14,
          life: 0.3, gravity: 80, alpha: 0.45,
        });
        SFX.smokePoof();
        return;
      }
      // Departure burst on the spot the boxer blinks out of.
      emitImpactRing(fromX, fromY, {
        style, wave: true, radius: r * 0.5, growth: r * 2.2,
        life: 0.3, alpha: 0.6, color: '#ff5252',
      });
      emitDustPuff(fromX, fromY, 5, {
        style, spread: Math.PI * 2, speed: 150, size: r * 0.16,
        life: 0.3, gravity: 60, alpha: 0.5,
      });
      // Appear BEHIND the target, relative to the target's own facing.
      const tDir = target.facingRight ? 1 : -1;
      const wantOff = (cfg && cfg.standOff) || BOXER_ASSAULT.standOff;
      const gap = Math.max(wantOff, (target.radius || 22) + r + 10);
      fighter.x = clampToBlast(target.x - tDir * gap, ctx, 30);
      fighter.y = clampToBlastY(target.y, ctx, 30);
      fighter.vx = 0;
      fighter.vy = 0;
      // Face the target, and point the attack record the same way, so the
      // finale throws the target away from the boxer.
      const dir = target.x >= fighter.x ? 1 : -1;
      fighter.facingRight = dir >= 0;
      atk.facing = dir;
      fighter._boxerAssaultPending = {
        targetId: target.id,
        facing: dir,
        ticks: (cfg && cfg.ticks) || BOXER_ASSAULT.ticks,
        tickInterval: (cfg && cfg.tickInterval) || BOXER_ASSAULT.tickInterval,
        tickDmg: (cfg && cfg.tickDmg) != null ? cfg.tickDmg : BOXER_ASSAULT.tickDmg,
        holdOffset: (cfg && cfg.holdOffset) || BOXER_ASSAULT.holdOffset,
        finale: (cfg && cfg.finale) || BOXER_ASSAULT.finale,
      };
      spawnFloatingText(
        target.x,
        target.y - (target.radius || 22) - 10,
        'DEADEYE ROLL',
        '#ff5252',
        { life: 1.1, size: 24 }
      );
      // Arrival burst where the boxer appears.
      emitImpactRing(fighter.x, fighter.y, {
        style, wave: true, radius: r * 0.5, growth: r * 2.0,
        life: 0.28, alpha: 0.6, color: '#ff8a65',
      });
      emitDustPuff(fighter.x, fighter.y + r * 0.7, 5, {
        style, spread: Math.PI * 1.2, speed: 140, size: r * 0.14,
        life: 0.3, gravity: 100, alpha: 0.45,
      });
      SFX.smokePoof();
    },
  },

  // â”€â”€ The Straight Right (boxer Forward Heavy) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // The heaviest single hit in the game, and the move that is allowed to still
  // be a plain strike: `strikeHitbox` hands this row's melee box to the shared
  // hitbox registry, so the damage, launch and hitstun are resolved by exactly
  // the same code as every other swing. The ability adds the art and the sound
  // and nothing else â€” and what it adds is deliberately faint: a reach streak
  // and a hair of flash, no ring and no burst, so the impact itself lands
  // harder than the effect announcing it.
  boxerFsmash: {
    name: 'Straight Right',
    // startup 0 + active 6 + recovery 34 from BOXER_ATTACKS.fsmash. A nonHitbox
    // move's length is the ability's `frames`, so this is what keeps the swing
    // as long (and as punishable) as the row it replaced.
    frames: 40,
    castFrame: 1,
    strikeHitbox: true,
    run(fighter, atk, cfg) {
      const dir = atk.facing || (fighter.facingRight ? 1 : -1);
      const r = fighter.radius || 22;
      const style = fxStyleFor(fighter);
      const unit = (r * 2) / 44;
      const x = fighter.x + dir * r * 0.6;
      const y = fighter.y - 4;
      spawnTempVfx(fighter, 'boxerStraightPunch', BOXER_STRAIGHT.reachLife, BOXER_STRAIGHT.reachScale, 0, 0, 0, {
        anchor: 'character',
        offsetX: dir * r * 0.5,
        offsetY: -4,
        mirrorX: dir,
        params: { unit },
      });
      emitFlash(x, y, { style, radius: r * 0.3, life: 0.06, alpha: 0.6, color: '#ffe0b2' });
      emitStreak(x, y, dir, 0, { style, length: r * 1.6, width: 2.2, life: 0.12, alpha: 0.4 });
      emitDustPuff(fighter.x + dir * r * 0.4, fighter.y + r * 0.7, 3, {
        style, dir: dir >= 0 ? 0 : Math.PI, spread: 0.9, speed: 110,
        size: r * 0.12, life: 0.22, gravity: 60, alpha: 0.3,
      });
      SFX.punch();
    },
  },
};

// The one opponent the Grab considers: a live opponent, in play, in reach.
// Same shape and same rules as the Teleport Strike's target test, so both
// moves refuse the same situations for the same reasons.
function boxerGrabTarget(fighter, cfg, ctx) {
  const others = (ctx && ctx.fighters) || [];
  const maxRange = (cfg && cfg.range) || BOXER_GRAB.range;
  let target = null, bestD = Infinity;
  for (const t of others) {
    if (!t || t === fighter || t.state === 'dead' || t.eliminated) continue;
    const d = Math.hypot(t.x - fighter.x, t.y - fighter.y);
    if (d < bestD) { bestD = d; target = t; }
  }
  return (target && bestD <= maxRange) ? target : null;
}

// The Teleport Strike's range and stand-off, read from the ability cfg exactly
// as the move always has: "close to the opponent", landing just outside contact
// range behind them.
function maxRangeFor(cfg) { return (cfg && cfg.range) || 420; }
function standOffFor(cfg) { return (cfg && cfg.standOff) || 62; }

// The one opponent the Teleport Strike considers: a live opponent, in play, in
// range. Returns null for anything else (dead, eliminated, too far, off-stage),
// so both the cast-time check and the warp-time re-check agree on what counts.
function teleportTarget(fighter, cfg, ctx) {
  const others = (ctx && ctx.fighters) || [];
  const maxRange = maxRangeFor(cfg);
  let target = null, bestD = Infinity;
  for (const t of others) {
    if (!t || t === fighter || t.state === 'dead' || t.eliminated) continue;
    const d = Math.hypot(t.x - fighter.x, t.y - fighter.y);
    if (d < bestD) { bestD = d; target = t; }
  }
  return (target && bestD <= maxRange) ? target : null;
}

// Clamp a blink destination inside the stage's blast zones (with an inset),
// so a teleport can never strand the fighter outside the arena. Falls back
// to the raw value when the stage exposes no blast zones.
function clampToBlast(x, ctx, inset) {
  const bz = ctx && ctx.stage && ctx.stage.blastZones;
  if (!bz) return x;
  return Math.max(bz.left + inset, Math.min(bz.right - inset, x));
}
function clampToBlastY(y, ctx, inset) {
  const bz = ctx && ctx.stage && ctx.stage.blastZones;
  if (!bz) return y;
  return Math.max(bz.top + inset, Math.min(bz.bottom - inset, y));
}

export { HORSE_PRESET };

export function getAbility(id) {
  return ABILITIES[id] || null;
}

// Seconds an ability must cool down for before its move may start again, or 0
// for an ability that declares no cooldown. The number lives on the ability
// itself so the gate and the move it guards can never drift apart.
export function abilityCooldownFor(id) {
  const ab = id ? ABILITIES[id] : null;
  return ab && typeof ab.cooldown === 'number' && ab.cooldown > 0 ? ab.cooldown : 0;
}

export function listAbilities() {
  return Object.keys(ABILITIES).map(id => ({ id, name: ABILITIES[id].name }));
}