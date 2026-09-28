// ai.js — Dedicated AI system for Smash Fighters.
//
// Architecture: each AI-controlled fighter owns ONE AIController. Every frame
// Game.js calls controller.update(dt, now, stage), then reads synthetic inputs
// via controller.getInput() — an { isHeld, isJustPressed, isJustReleased }
// triple with the SAME signature as Input.js. Those triples are passed to BOTH
// handleFighterInput (movement/jump/dodge/up-special) AND combatInput
// (attacks/shield), so the AI drives the EXACT same code paths as a human
// player: no parallel movement, no parallel attack spawning, no desync.
//
// Separation: ALL AI logic lives here. Fighter.js / combat.js never import
// this file for decisions — they only consume the synthetic input triple.
// Player input/control logic is untouched.
//
// Perception: every decision builds a full situation snapshot (own + opponent
// position, h/v distance, above/below, grounded/airborne, velocities, stage +
// blast geometry, percents, attack/hitstun/knockback/cooldown state,
// double-jump + Aerial-Light availability, opponent attack/vulnerability/
// recovery state). Movement, attack, combo, defense, recovery and edgeguard
// all read the SAME perception object.
//
// Resources (double jump / aerial-light recovery / up-special free-fall) are
// NEVER cached: every decision reads fighter.canDoubleJump,
// fighter.canUseAerialLightRecovery and fighter.freeFall live, so AI tracking
// cannot desynchronize from the character state. Landing recharges both (see
// Fighter.js stepFighterPhysics + Stage.js resolvePlatformCollision).
//
// No timers, no intervals, no event listeners, no DOM access — all state lives
// on the controller and is dropped on reset()/dispose(), so mode switches and
// restarts cannot leak.

import { attacksFor, resolveAttackDef } from '../fighter/combat.js';
import { GRAVITY } from '../fighter/Fighter.js';
import { NeuralNetwork, buildNNInputs, nnOutputForAttackKey } from './ai-neural-network.js';
import { loadTrainedModel } from './ai-model-storage.js';

// ── Personality ─────────────────────────────────────────────────────────────
// Configurable per-controller parameters. They influence DECISION SCORING —
// never replace the underlying logic. Game.js constructs AIvsAI with slightly
// different personalities so the two fighters naturally diverge (the fight
// emerges from independent decisions, never a script).
const AI_PARAMS = {
  aggression: 0.7,       // 0 = passive spacer, 1 = relentless pressure
  defense: 0.55,         // 0 = never blocks, 1 = very reactive blocker/dodger
  reactionTime: 0.16,    // seconds between reassessments (lower = twitchier)
  attackFrequency: 0.62, // base chance to strike when in range (0..1)
  preferredRange: 110,   // px horizontal distance the AI likes to fight at
  minimumSafeDistance: 55,   // px — closer than this feels crowded: create space
  maximumEngagementDistance: 260, // px — farther than this: approach/zone
  riskTolerance: 0.5,    // 0 = only safe pokes, 1 = frequent smash attempts
  recoveryPriority: 1.0, // 0..1 urgency multiplier for spending recovery resources
  edgeguardPriority: 0.6,// 0 = never leaves stage, 1 = deep pursuits
  comboPriority: 0.7,    // 0 = never chases, 1 = always chases follow-ups
  decisionInterval: 0.16,// legacy alias of reactionTime (seconds)
};

function resolvePersonality(overrides) {
  const base = { ...AI_PARAMS };
  if (overrides && typeof overrides === 'object') {
    for (const k of Object.keys(base)) {
      if (typeof overrides[k] === 'number' && Number.isFinite(overrides[k])) base[k] = overrides[k];
    }
  }
  // reactionTime and decisionInterval stay in sync (either may be set).
  if (overrides && typeof overrides.reactionTime === 'number') base.decisionInterval = base.reactionTime;
  else if (overrides && typeof overrides.decisionInterval === 'number') base.reactionTime = base.decisionInterval;
  return base;
}

// ── AI difficulty ─────────────────────────────────────────────────────────
// Difficulty changes DECISION QUALITY, not speed: reaction time, defensive
// reliability, attack selection discipline, combo/edgeguard sophistication,
// neural-network influence, and deliberate mistake rate. Higher difficulties
// decide better; lower ones fumble, hesitate and pick worse moves.
const AI_DIFFICULTIES = ['Easy', 'Normal', 'Hard', 'Expert', 'Trained'];

const AI_DIFFICULTY_PRESETS = {
  Easy: {
    reactionTime: 0.30, defense: 0.25, attackFrequency: 0.38,
    aggression: 0.40, riskTolerance: 0.30, edgeguardPriority: 0.30,
    comboPriority: 0.35, neuroInfluence: 0, mistakeRate: 0.28,
  },
  Normal: {
    reactionTime: 0.22, defense: 0.45, attackFrequency: 0.55,
    aggression: 0.60, riskTolerance: 0.50, edgeguardPriority: 0.55,
    comboPriority: 0.60, neuroInfluence: 0, mistakeRate: 0.14,
  },
  Hard: {
    reactionTime: 0.16, defense: 0.60, attackFrequency: 0.68,
    aggression: 0.70, riskTolerance: 0.60, edgeguardPriority: 0.70,
    comboPriority: 0.75, neuroInfluence: 0.5, mistakeRate: 0.06,
  },
  Expert: {
    reactionTime: 0.12, defense: 0.72, attackFrequency: 0.78,
    aggression: 0.80, riskTolerance: 0.70, edgeguardPriority: 0.85,
    comboPriority: 0.85, neuroInfluence: 0.85, mistakeRate: 0.02,
  },
  Trained: {
    reactionTime: 0.12, defense: 0.72, attackFrequency: 0.78,
    aggression: 0.80, riskTolerance: 0.70, edgeguardPriority: 0.85,
    comboPriority: 0.85, neuroInfluence: 1.0, mistakeRate: 0.0,
  },
};

function difficultyPreset(name) {
  return AI_DIFFICULTY_PRESETS[name] || AI_DIFFICULTY_PRESETS.Normal;
}

// Build the full controller config for a difficulty + character: personality
// overrides, mistake rate, and (for Hard+) the trained neural model when one
// exists for that character. Falls back to pure scripted AI — never crashes,
// never invents a fake model.
function configForDifficulty(name, charId) {
  const preset = difficultyPreset(name);
  const out = {
    personality: { ...preset },
    mistakeRate: preset.mistakeRate,
    neuroInfluence: preset.neuroInfluence,
    neuroWeights: null,
    difficulty: name,
  };
  delete out.personality.neuroInfluence;
  delete out.personality.mistakeRate;
  if ((name === 'Hard' || name === 'Expert' || name === 'Trained') && charId) {
    try {
      const model = loadTrainedModel(charId);
      if (model && Array.isArray(model.weights)) {
        out.neuroWeights = model.weights;
        if (name === 'Trained' && model.behavior && typeof model.behavior === 'object') {
          // The trained genome's behavior IS the personality on Trained.
          for (const k of Object.keys(out.personality)) {
            if (typeof model.behavior[k] === 'number' && Number.isFinite(model.behavior[k])) {
              out.personality[k] = model.behavior[k];
            }
          }
        }
      } else if (name === 'Trained') {
        // No model: fall back to Expert scripted, no network.
        const fb = difficultyPreset('Expert');
        out.personality = { ...fb };
        delete out.personality.neuroInfluence;
        delete out.personality.mistakeRate;
        out.mistakeRate = fb.mistakeRate;
        out.neuroInfluence = 0;
      } else {
        out.neuroInfluence = 0; // Hard/Expert without a model = strong scripted
      }
    } catch (_) {
      if (name !== 'Hard' && name !== 'Expert') { out.neuroInfluence = 0; }
      else out.neuroInfluence = 0;
    }
  } else if (name !== 'Hard' && name !== 'Expert' && name !== 'Trained') {
    out.neuroInfluence = 0;
    out.neuroWeights = null;
  }
  return out;
}

// All synthetic button names the AI can hold. Must cover every action the
// movement + combat systems read: left/right/up/down/jump/attack/special/
// shield/dodge (grab is pause — the AI never touches it).
const BUTTONS = ['left', 'right', 'up', 'down', 'jump', 'attack', 'special', 'shield', 'dodge'];
const _availKeysCache = new Map();
const _AVAIL_KEYS_FALLBACK = ['jab', 'nsmash', 'ftilt', 'fsmash', 'utilt', 'usmash', 'dtilt', 'dsmash', 'aerialLight', 'aerialHeavy'];

function emptyHeld() {
  return { left: false, right: false, up: false, down: false, jump: false, attack: false, special: false, shield: false, dodge: false };
}

// Button glyph for the AI debug read-out, in the same order the old per-frame
// build used. Called on demand (probe getDebug) instead of every AI frame.
function holdString(held) {
  return `${held.left ? 'L' : ''}${held.right ? 'R' : ''}${held.jump ? 'J' : ''}${held.attack ? 'A' : ''}${held.special ? 'S' : ''}${held.shield ? 'B' : ''}${held.dodge ? 'D' : ''}${held.up ? 'U' : ''}${held.down ? 'N' : ''}`;
}

function mainGround(stage) {
  if (!stage || !Array.isArray(stage.platforms)) return null;
  // Index loop, not .find(p => p.isGround): this runs on the AI's recovery /
  // off-stage reads, and a 2-element platform list doesn't need a predicate
  // closure built and invoked for it.
  const plats = stage.platforms;
  for (let i = 0; i < plats.length; i++) {
    if (plats[i].isGround) return plats[i];
  }
  return plats[0] || null;
}

// Recovery urgency for a fighter given the REAL stage:
// 0 = safe (grounded or above solid ground), 1 = off-stage (airborne outside
// the main ground's horizontal span — steer back), 2 = urgent (below the main
// ground top or outside blast zones — spend resources NOW).
function recoveryUrgency(f, stage) {
  if (!f) return 0;
  if (f.grounded) return 0;
  if (!stage) {
    if (f.x < 0 || f.x > 1200 || f.y < -100 || f.y > 1100) return 2;
    return 0;
  }
  const g = mainGround(stage);
  const bz = stage.blastZones || { left: -150, right: 1350, top: -225, bottom: 1250 };
  if (f.x < bz.left || f.x > bz.right || f.y < bz.top || f.y > bz.bottom) return 2;
  if (!g) return 0;
  const belowTop = f.y > g.y + 10;
  const outsideX = f.x < g.x - 20 || f.x > g.x + g.width + 20;
  if (belowTop) return 2;
  if (outsideX) return 1;
  return 0;
}

function isOffStage(f, stage) {
  return recoveryUrgency(f, stage) > 0;
}

// ── Full-situation perception ───────────────────────────────────────────────
// One snapshot per decision. Every AI subsystem (movement, attack, combo,
// defense, recovery, edgeguard, adaptation) reads this — nothing reaches
// around it to re-derive geometry inconsistently.
function buildPerception(f, opp, stage) {
  const dx = (opp ? opp.x - f.x : 0) || 0;
  const dy = (opp ? opp.y - f.y : 0) || 0; // negative = opponent above
  const hDist = Math.abs(dx);
  const vDist = dy;
  const dist = Math.sqrt(dx * dx + dy * dy);
  const g = mainGround(stage);
  const bz = (stage && stage.blastZones) || { left: -150, right: 1350, top: -225, bottom: 1250 };
  const stageLeft = g ? g.x : 210;
  const stageRight = g ? g.x + g.width : 990;
  const stageTop = g ? g.y : 858;
  const distToBlastL = f.x - bz.left;
  const distToBlastR = bz.right - f.x;
  const distToBlastB = bz.bottom - f.y;
  const nearEdge = f.grounded && g
    ? Math.min(f.x - g.x, (g.x + g.width) - f.x)
    : Infinity;
  const oppNearEdge = opp && opp.grounded && g
    ? Math.min(opp.x - g.x, (g.x + g.width) - opp.x)
    : Infinity;
  const _fvx = f.vx || 0, _fvy = f.vy || 0;
  const _ovx = opp ? opp.vx || 0 : 0, _ovy = opp ? opp.vy || 0 : 0;
  const ownSpeed = Math.sqrt(_fvx * _fvx + _fvy * _fvy);
  const oppSpeed = opp ? Math.sqrt(_ovx * _ovx + _ovy * _ovy) : 0;
  const oppAttacking = !!(opp && opp.attack);
  const oppPhase = opp && opp.attack ? opp.attack.phase : null;
  const oppVulnerable = !!(opp && (opp.hitstun > 0 || (opp.attack && opp.attack.phase === 'recovery')));
  const oppWhiff = !!(opp && opp.attack && opp.attack.phase === 'recovery' && opp.hitstun <= 0);
  const oppRecovery = opp ? recoveryUrgency(opp, stage) : 0;
  // Vertical fighting detail (§30): falling toward us, and who holds the high ground.
  const oppFallingToward = opp ? (!opp.grounded && opp.vy > 120 && Math.abs(dy) < 220 && hDist < 200) : false;
  const aiAbove = dy > 60; // we are above the opponent
  // Incoming projectile threat (§26): opponent-owned projectiles + Deadeye
  // slugs heading our way. Time-to-hit gates the dodge (no perfect dodges —
  // reactionTime + uncertainty apply at decision time).
  let incoming = null;
  try {
    const lists = [];
    if (opp) {
      if (Array.isArray(opp._projectiles)) for (const pr of opp._projectiles) lists.push(pr);
      if (Array.isArray(opp._deadeyeBullets)) for (const b of opp._deadeyeBullets) if (!b.dead) lists.push(b);
    }
    let bestT = Infinity;
    for (const pr of lists) {
      const rx = (f.x - pr.x), ry = (f.y - pr.y);
      const d2 = rx * rx + ry * ry;
      if (d2 > 420 * 420) continue;
      const d = Math.sqrt(d2);
      const _pvx = pr.vx || 0, _pvy = pr.vy || 0;
      const sp = Math.sqrt(_pvx * _pvx + _pvy * _pvy) || 1;
      const closing = -((rx * (pr.vx || 0) + ry * (pr.vy || 0)) / (d * sp));
      if (closing < 0.35) continue; // not heading at us
      const t = d / sp;
      if (t < bestT) { bestT = t; incoming = { x: pr.x, y: pr.y, vx: pr.vx || 0, vy: pr.vy || 0, dist: d, timeToHit: t }; }
    }
  } catch (_) { incoming = null; }
  // §41 stage-positioning detail: platform center/edges, signed distance
  // inside the platform (negative = already past the edge), drift direction
  // vs. velocity, and whether the opponent is edge-side. Cooldown readiness
  // (§46) is read live — never cached — so the AI obeys the same locks as
  // the player (attack/block/dodge) plus its resource state.
  const centerX = g ? g.x + g.width / 2 : 600;
  const edgeL = g ? g.x : 210, edgeR = g ? g.x + g.width : 990;
  const signedInside = g ? Math.min(f.x - edgeL, edgeR - f.x) : Infinity;
  const edgeSide = (f.x - centerX) >= 0 ? 1 : -1; // which edge we are nearest
  const movingTowardEdge = Math.sign(f.vx || 0) === edgeSide && Math.abs(f.vx || 0) > 60;
  const centerDir = f.x < centerX - 12 ? 1 : f.x > centerX + 12 ? -1 : 0;
  const oppEdgeInside = opp && g ? Math.min(opp.x - edgeL, edgeR - opp.x) : Infinity;
  return {
    dx, dy, hDist, vDist, dist,
    oppAbove: dy < -45, oppBelow: dy > 45, oppLevel: Math.abs(dy) <= 45,
    oppAboveFar: dy < -90,
    oppFallingToward, aiAbove, incoming,
    centerX, edgeL, edgeR, signedInside, edgeSide, movingTowardEdge, centerDir,
    oppEdgeInside,
    attackReady: (f.attackCooldown || 0) <= 0,
    blockReady: (f.shieldCooldown || 0) <= 0,
    dodgeReady: (f.dodgeCooldown || 0) <= 0,
    ownGrounded: !!f.grounded, oppGrounded: opp ? !!opp.grounded : true,
    oppAirborne: opp ? !opp.grounded : false, ownAirborne: !f.grounded,
    ownVx: f.vx || 0, ownVy: f.vy || 0, oppVx: opp ? opp.vx || 0 : 0, oppVy: opp ? opp.vy || 0 : 0,
    ownSpeed, oppSpeed,
    oppApproaching: opp ? (Math.sign(opp.vx || 0) === -Math.sign(dx) && Math.abs(opp.vx || 0) > 40) : false,
    oppRetreating: opp ? (Math.sign(opp.vx || 0) === Math.sign(dx) && Math.abs(opp.vx || 0) > 40) : false,
    stageLeft, stageRight, stageTop, blast: bz,
    distToBlast: Math.min(distToBlastL, distToBlastR, distToBlastB),
    nearEdge, oppNearEdge,
    ownPercent: f.percent || 0, oppPercent: opp ? opp.percent || 0 : 0,
    ownAttack: f.attack || null, ownPhase: f.attack ? f.attack.phase : null,
    ownHitstun: f.hitstun || 0, oppHitstun: opp ? opp.hitstun || 0 : 0,
    ownDodgeCd: f.dodgeCooldown || 0, oppDodgeCd: opp ? opp.dodgeCooldown || 0 : 0,
    canDoubleJump: !!f.canDoubleJump, canAerialLight: !!f.canUseAerialLightRecovery,
    freeFall: !!f.freeFall,
    oppAttack: opp ? opp.attack || null : null, oppAttacking, oppPhase,
    oppVulnerable, oppWhiff,
    oppRecovery, ownUrgency: recoveryUrgency(f, stage),
    oppShielding: opp ? !!opp.shielding : false, oppDodging: opp ? !!opp.dodging : false,
    // Vertical-accuracy detail: absolute opponent height + landing detection
    // (airborne, falling fast, close above a floor → about to land → punish
    // with low/fast moves). Canvas Y grows downward: larger y = lower.
    oppY: opp ? opp.y : f.y,
    oppLanding: opp ? (!opp.grounded && (opp.vy || 0) > 150 && (stageTop - opp.y) < 260 && (stageTop - opp.y) > -40) : false,
  };
}

// ── Attack profiles (scoring metadata, NOT physics) ─────────────────────────
// Physics (damage/kb/angle) lives in combat.js tables. These profiles describe
// HOW to pick each move: effective reach, vertical bias, speed, risk. Real
// startup/recovery from attacksFor() further weight the score at decision time.
const ATTACK_PROFILES = {
  jab:          { range: 80,  vBias: 'level', speed: 1.0, risk: 0.1 },
  ftilt:        { range: 150, vBias: 'level', speed: 0.8, risk: 0.25 },
  fsmash:       { range: 210, vBias: 'level', speed: 0.45, risk: 0.8 },
  utilt:        { range: 120, vBias: 'above', speed: 0.8, risk: 0.25 },
  usmash:       { range: 150, vBias: 'above', speed: 0.5, risk: 0.75 },
  dtilt:        { range: 140, vBias: 'below', speed: 0.85, risk: 0.3 },
  dsmash:       { range: 130, vBias: 'below', speed: 0.45, risk: 0.85 },
  aerialLight:  { range: 110, vBias: 'any',   speed: 0.9, risk: 0.2 },
  aerialHeavy:  { range: 130, vBias: 'above', speed: 0.6, risk: 0.5 },
  dash:         { range: 160, vBias: 'level', speed: 0.7, risk: 0.4 },
  nsmash:       { range: 130, vBias: 'level', speed: 0.5, risk: 0.7 },
  btilt:        { range: 150, vBias: 'level', speed: 0.8, risk: 0.25 },
  bsmash:       { range: 210, vBias: 'level', speed: 0.8, risk: 0.8 },
};

// ── Per-attack reach model + trajectory prediction (no cheating) ──────────
// The hitboxes and collision stay authoritative in combat.js — this only
// ESTIMATES, from the real def numbers, whether an attack can plausibly
// connect, so the AI stops swinging at air. Reach mirrors combat's own rect
// math (hitboxRectFor: x = fx + ox*facing − w/2, y = fy + oy − h/2); the
// hurtbox is the opponent's radius square (getHurtbox). vDist uses canvas
// coordinates (Y down): positive vDist = opponent BELOW us.

// Effective def: what the game would actually use right now (custom hitboxes
// and ability routing included), falling back to the character table.
function effDefFor(f, key, table) {
  try {
    const r = resolveAttackDef(key, f);
    if (r) return r;
  } catch (_) {}
  return (table && table[key]) || null;
}

// Classify how an attack reaches the opponent. Returns:
// { kind, fwd, back, halfH, oy, t, needsGround, directed }
// fwd/back: horizontal reach from attacker center (px). halfH/oy: vertical
// half-size + center offset. t: seconds until the hit can land. directed:
// true when the attack only threatens the faced direction.
function attackReach(key, def, f) {
  const d = def || {};
  const startup = Math.max(0, d.startup != null ? d.startup : 5);
  const cast = Math.max(0, d.abilityCastFrame != null ? d.abilityCastFrame : 0);
  const base = { oy: d.oy || 0, halfH: (d.h || 30) / 2, t: (Math.max(startup, cast) + 2) / 60, needsGround: false, directed: true };
  // Deadeye volley (cowboy Down Light): homing bullets — long reach, tall
  // capture volume, no facing requirement once locked.
  if (d.abilityType === 'nonHitbox' && d.abilityId === 'cowboyDownLight') {
    return { ...base, kind: 'deadeye', fwd: 480, back: 120, halfH: 170, oy: 0, t: cast / 60 + 0.12, directed: false };
  }
  // Horse ride (cowboy Down Heavy): tramples forward along the ground.
  if (d.abilityType === 'nonHitbox' && d.abilityId === 'cowboyDownHeavy') {
    return { ...base, kind: 'horse', fwd: 260, back: 0, halfH: 45, oy: 10, t: cast / 60 + 0.1, needsGround: true };
  }
  // Deadeye Assault (boxer Down Heavy): blinks in behind the target anywhere
  // in range, then pummels up close. Facing-agnostic (the blink faces for
  // free); scored as a gap-closing punish like the Shadow Strike dash.
  if (d.abilityType === 'nonHitbox' && d.abilityId === 'boxerDsmash') {
    return { ...base, kind: 'dash', fwd: 420, back: 0, halfH: 60, oy: 0, t: cast / 60 + 0.1, directed: false };
  }
  // Rifle bullet (cowboy Side Smash): fast projectile downrange.
  if (d.abilityType === 'nonHitbox' && d.abilityId === 'cowboyFwdHeavy') {
    return { ...base, kind: 'projectile', fwd: 550, back: 0, halfH: 60, oy: -4, t: 0.06 };
  }
  // Shuriken + any authored projectile: travels, needs rough height alignment.
  if (d.isProjectile) {
    return { ...base, kind: 'projectile', fwd: 450, back: 0, halfH: 80, oy: d.oy || 0, t: 0.08 };
  }
  // Shadow Strike (ninja Down Heavy): dashes forward, then slashes.
  if (d.dashDistance) {
    const w = d.w || 60;
    const ox = Math.abs(d.ox || 0);
    return { ...base, kind: 'dash', fwd: ox + w / 2 + (d.dashDistance || 0), back: 0, t: startup / 60 + 0.06 };
  }
  // Plain melee (hitbox defs, possibly bothSides or aerial).
  const w = d.w || 40, ox = Math.abs(d.ox || 0);
  const both = !!d.bothSides;
  const air = key === 'aerialLight' || key === 'aerialHeavy';
  return {
    ...base,
    kind: 'melee',
    fwd: ox + w / 2,
    back: (both || air) ? ox + w / 2 : Math.max(0, w / 2 - ox),
    directed: !(both || air),
  };
}

// Where will the opponent's center be in t seconds? Grounded targets mostly
// slide horizontally; airborne ones follow gravity (same GRAVITY the physics
// integrates). Conservative — no air-control assumptions.
function predictOppCenter(opp, oppGrounded, t) {
  const px = opp.x + (opp.vx || 0) * t;
  let py;
  if (oppGrounded) {
    py = opp.y + Math.min(0, opp.vy || 0) * t;
  } else {
    py = opp.y + (opp.vy || 0) * t + 0.5 * GRAVITY * t * t;
  }
  return { x: px, y: py };
}

// Realistic connect chance 0..1 for one attack, right now: predicted hurtbox
// vs. the hitbox rect the game would spawn (attacker assumed stationary and
// already facing the opponent — facing is enforced separately before firing).
// Melee uses exact rect overlap with linear falloff; lunges/projectiles use
// swept volumes. This never touches collision — it only informs the decision.
function connectChance(R, P, f, opp) {
  if (!opp || !R) return 0;
  const dx = opp.x - f.x;
  const toward = dx >= 0 ? 1 : -1;
  const facing = f.facingRight ? 1 : -1;
  const pred = predictOppCenter(opp, P.oppGrounded, R.t || 0.1);
  const hr = opp.radius || 26;
  const hbTop = f.y + (R.oy || 0) - (R.halfH || 15);
  const hbBottom = f.y + (R.oy || 0) + (R.halfH || 15);

  if (R.kind === 'deadeye') {
    // Homing volley: needs rough volume containment, facing-agnostic.
    const hInside = Math.abs(pred.x - f.x) < (R.fwd || 480) + hr;
    const vOverlap = pred.y + hr > f.y - 170 && pred.y - hr < f.y + 170;
    if (!hInside || !vOverlap) return 0;
    const hScore = 1 - Math.min(1, Math.abs(pred.x - f.x) / 560);
    const vScore = 1 - Math.min(1, Math.abs(pred.y - f.y) / 260);
    return Math.max(0, Math.min(1, 0.45 + 0.55 * (hScore * 0.6 + vScore * 0.4)));
  }
  if (R.kind === 'projectile') {
    // Must be fired toward the opponent and share a height band.
    if (toward !== facing) return 0;
    const hDist = Math.abs(pred.x - f.x);
    if (hDist > (R.fwd || 450) + hr) return 0;
    const vMiss = Math.abs((pred.y) - (f.y + (R.oy || 0))) - ((R.halfH || 60) + hr);
    if (vMiss > 0) return Math.max(0, 1 - vMiss / 120);
    if (hDist < 40) return 0.35; // point-blank: muzzle past them, risky
    return 0.55 + 0.45 * (1 - hDist / ((R.fwd || 450) + hr));
  }
  if (R.kind === 'horse') {
    // Swept ground volume ahead of the rider.
    if (toward !== facing) return 0;
    const ahead = (pred.x - f.x) * facing;
    if (ahead < -(hr + 20) || ahead > (R.fwd || 260) + hr) return 0;
    const vMiss = Math.abs(pred.y - (f.y + (R.oy || 10))) - ((R.halfH || 45) + hr);
    if (vMiss > 0) return Math.max(0, 1 - vMiss / 90);
    return 0.6 + 0.4 * (1 - Math.max(0, ahead) / ((R.fwd || 260) + hr));
  }
  // Melee + dash lunge: exact rect overlap at the predicted position. The
  // rect extends from the attacker toward the OPPONENT's side (facing-aware:
  // forward reach when facing them, back reach otherwise).
  const edge = toward === facing ? (R.fwd || 60) : (R.back || 0);
  const hbX0 = toward > 0 ? f.x : f.x - edge;
  const hbX1 = toward > 0 ? f.x + edge : f.x;
  const oX0 = pred.x - hr, oX1 = pred.x + hr;
  const oY0 = pred.y - hr, oY1 = pred.y + hr;
  const overlapX = Math.min(hbX1, oX1) - Math.max(hbX0, oX0);
  const overlapY = Math.min(hbBottom, oY1) - Math.max(hbTop, oY0);
  if (overlapX > 0 && overlapY > 0) {
    // Solid overlap: scale by centrality (dead-center = surest).
    const cX = 1 - Math.min(1, Math.abs((pred.x - f.x) - toward * edge * 0.5) / Math.max(1, edge));
    return Math.max(0.55, Math.min(1, 0.7 + 0.3 * cX));
  }
  // Near-miss falloff: how far outside the rect (px) → 0 at 70px out.
  const missX = overlapX >= 0 ? 0 : -overlapX;
  const missY = overlapY >= 0 ? 0 : -overlapY;
  const miss = Math.sqrt(missX * missX + missY * missY) + (toward !== facing && R.directed ? 40 : 0);
  return Math.max(0, 1 - miss / 70) * 0.5;
}

function facingOppNow(f, dx) {
  if (Math.abs(dx) < 8) return true;
  return (dx >= 0) === !!f.facingRight;
}

class AIState {
  constructor(fighter, opponent, personality) {
    this.fighter = fighter || null;
    this.opponent = opponent || null;
    this.personality = resolvePersonality(personality);
    this.held = emptyHeld();
    this.prevHeld = emptyHeld();
    this.plan = null;
    this.planUntil = 0;
    this.lastDecision = 0;
    // Reaction-time jitter: decisions fire at personality.reactionTime ± 25%.
    this.nextDecisionAt = 0;
    this.releaseAt = {};
    this.shieldUntil = 0;
    this.lastShieldAt = -1e9;
    this.comboCount = 0;
    this.lastHitOppPercent = -1;
    this.lastOppAttackRef = null;
    this.oppPattern = [];
    // ── Lightweight adaptation (no ML) ──────────────────────────────────
    // Counts/scores updated every frame + every decision. Decisions read the
    // derived rates (jumpFreq, blockFreq, ...) to bias scoring.
    this.adapt = {
      samples: 0,
      attackCounts: {},   // opp attack key -> times seen
      rangeSum: 0, rangeN: 0, // preferred attack range accumulator
      jumps: 0, approaches: 0, retreats: 0,
      blocks: 0, dodges: 0,
      recoveryDir: { left: 0, right: 0, center: 0 },
      sideHits: { left: 0, right: 0 }, // which side opp attacks from
      lastOppY: 0, lastOppX: 0,
      lastOppGrounded: true,
    };
    this.stuckCheck = { x: 0, y: 0, t: 0, count: 0 };
    this.lastActionKey = 'idle';
    this.repeatCount = 0;
    // §24/29/32: movement bookkeeping — strafe direction, post-attack
    // repositioning, ability-variety counts (so the whole kit gets used).
    this.strafeDir = 1;
    this.strafeUntil = 0;
    this.lastAttackEndedAt = -1e9;
    this.wasAttacking = false;
    this.abilityUses = {}; // own attack key -> times used (variety bonus)
    this.moveTicks = 0;    // decisions spent moving without attacking
    this.debug = { state: 'init', action: 'none' };
    this.stats = {};
    this._stageHint = null;
    this._lastOppPercent = 0;
    // ── Neural-network influence (training / difficulty) ──────────────
    // neuroNet: a NeuralNetwork whose forward() output biases scoring.
    // neuroInfluence 0 = pure scripted AI; 1 = network strongly steers picks.
    // mistakeRate: probability a neutral decision deliberately fumbles (lower
    // difficulties play worse on purpose). The network never bypasses the
    // game's legality gates — combatInput re-validates everything.
    this.neuroNet = null;
    this.neuroInfluence = 0;
    this.mistakeRate = 0;
    this._nnOut = null;
    // ── Aimed-attack intent (move into range, then strike) ──────────────
    // aimKey: the attack we want; aimDist: the distance to hold; aimUntil:
    // expiry. Set when nothing connects yet or we must turn first; cleared
    // on fire, expiry, or reset. Movement scoring closes the gap meanwhile.
    this.aimKey = null;
    this.aimUntil = 0;
    this.aimDist = 90;
    // ── Accuracy instrumentation (read-only observability) ──────────────
    // attacks: swings started by chooseAndFire; hits: opponent damage events
    // observed afterwards (delayed projectile/Deadeye hits still credit).
    // Shields/denies correctly count as non-hits. Never affects decisions.
    this.combatStats = { attacks: 0, hits: 0, _lastOppPct: -1, _lastOwnAttack: null };
    // Decision diagnostics: where potential swings die (observability only).
    this.diag = { freqBlock: 0, gateBlock: 0, fired: 0, noScore: 0, turnFix: 0 };
    this.recentAttacks = []; // chosen swing history (variety penalty window)
    this.lastZonerAt = -1e9; // last projectile/volley fire (zoner pacing)
  }

  // Attach a trained genome: behavior becomes personality, weights become the
  // steering network. influence 0..1 scales how strongly the net steers.
  setGenome(genome, influence = 1.0) {
    if (genome && genome.behavior && typeof genome.behavior === 'object') {
      this.personality = resolvePersonality({ ...this.personality, ...genome.behavior });
    }
    if (genome && Array.isArray(genome.weights)) {
      try {
        this.neuroNet = new NeuralNetwork(genome.weights);
      } catch (_) { this.neuroNet = null; }
    } else {
      this.neuroNet = null;
    }
    this.neuroInfluence = Math.max(0, Math.min(1, influence));
    this._nnOut = null;
  }

  setNeuralModel(weights, influence = 1.0) {
    if (Array.isArray(weights)) {
      try { this.neuroNet = new NeuralNetwork(weights); }
      catch (_) { this.neuroNet = null; }
    } else {
      this.neuroNet = null;
    }
    this.neuroInfluence = Math.max(0, Math.min(1, influence));
    this._nnOut = null;
  }

  // Run the steering network for the current situation. Called once per
  // decision (never per frame) so training populations cost nothing when idle
  // and live matches pay a single small forward pass per ~150ms.
  ensureNeuro() {
    if (!this.neuroNet || !(this.neuroInfluence > 0)) {
      this._nnOut = null;
      return null;
    }
    try {
      const inputs = buildNNInputs(this.fighter, this.opponent, this._stageHint);
      const out = this.neuroNet.forward(inputs);
      // Reuse the output array instead of Array.from() per decision: the
      // network's _out is stable per instance, but two controllers must never
      // share one reference, so copy into a per-controller scratch array.
      if (!this._nnOut || this._nnOut.length !== out.length) this._nnOut = new Array(out.length);
      for (let i = 0; i < out.length; i++) this._nnOut[i] = out[i];
      return this._nnOut;
    } catch (_) {
      this._nnOut = null;
      return null;
    }
  }

  // Multiplier in [1-influence, 1+influence] from a tanh network output.
  _neuroBias(idx, fallbackIdx = -1) {
    const out = this._nnOut;
    const infl = this.neuroInfluence || 0;
    if (!out || !(infl > 0)) return 1;
    let v = (idx >= 0 && idx < out.length) ? out[idx] : 0;
    if (!Number.isFinite(v) && fallbackIdx >= 0 && fallbackIdx < out.length) v = out[fallbackIdx];
    if (!Number.isFinite(v)) return 1;
    return 1 + infl * Math.max(-1, Math.min(1, v));
  }

  setHeld(name, v) {
    if (name in this.held) this.held[name] = !!v;
  }

  pressButton(name, holdMs, now) {
    this.setHeld(name, true);
    this.releaseAt[name] = now + holdMs;
  }

  agePresses(now) {
    for (const k of Object.keys(this.releaseAt)) {
      if (now >= this.releaseAt[k]) {
        this.setHeld(k, false);
        delete this.releaseAt[k];
      }
    }
    if (this.shieldUntil && now >= this.shieldUntil) {
      this.setHeld('shield', false);
      this.shieldUntil = 0;
    }
    if (this.plan && now >= this.planUntil) {
      this.plan = null;
    }
  }

  trackOpponent(now) {
    const opp = this.opponent, f = this.fighter;
    if (!opp || !f) return;
    const a = this.adapt;
    a.samples++;
    // Attack repetition + range preference.
    const ref = opp.attack || null;
    if (ref && ref !== this.lastOppAttackRef) {
      this.lastOppAttackRef = ref;
      const key = ref.key || '?';
      a.attackCounts[key] = (a.attackCounts[key] || 0) + 1;
      const h = Math.abs(opp.x - f.x);
      a.rangeSum += h; a.rangeN++;
      a.sideHits[opp.x < f.x ? 'left' : 'right']++;
      this.oppPattern.push({ key, t: now });
      if (this.oppPattern.length > 8) this.oppPattern.shift();
      // Repeated same attack 3+ times in window → exploitable habit.
    } else if (!ref) {
      this.lastOppAttackRef = null;
    }
    // Jump frequency: grounded → airborne edge = a jump.
    if (!this._prevOppTracked) this._prevOppTracked = true;
    if (a.lastOppGrounded && !opp.grounded) a.jumps++;
    // Approach / retreat from horizontal velocity toward/away.
    const dx = opp.x - f.x;
    if (Math.abs(opp.vx || 0) > 60) {
      if (Math.sign(opp.vx) === -Math.sign(dx || 1)) a.approaches++;
      else a.retreats++;
    }
    if (opp.shielding) a.blocks++;
    if (opp.dodging) a.dodges++;
    // Recovery direction when off-stage.
    if (!opp.grounded && isOffStage(opp, this._stageHint)) {
      const g = mainGround(this._stageHint);
      const cx = g ? g.x + g.width / 2 : 600;
      if (Math.abs(opp.x - cx) < 120) a.recoveryDir.center++;
      else if (opp.x < cx) a.recoveryDir.left++;
      else a.recoveryDir.right++;
    }
    a.lastOppX = opp.x; a.lastOppY = opp.y; a.lastOppGrounded = !!opp.grounded;
    // Swing + hit accounting, observed from game truth (not button presses):
    // a fresh fighter.attack instance = one real swing, however it started
    // (fresh press, input-buffer queue, recovery aerial). Opponent damage
    // rising = one of our swings connected (delayed projectiles/Deadeye
    // credit here too). Shields/denies correctly count as non-hits.
    try {
      const cs = this.combatStats;
      const atk = f.attack || null;
      if (atk && atk !== cs._lastOwnAttack) {
        cs.attacks++;
        cs._lastOwnAttack = atk;
      } else if (!atk) {
        cs._lastOwnAttack = null;
      }
      const cur = opp.percent || 0;
      if (cs._lastOppPct >= 0 && cur > cs._lastOppPct + 0.001) cs.hits++;
      cs._lastOppPct = cur;
    } catch (_) {}
  }

  adaptRates() {
    const a = this.adapt;
    const n = Math.max(1, a.samples);
    return {
      jumpFreq: a.jumps / n,
      blockFreq: a.blocks / n,
      dodgeFreq: a.dodges / n,
      approachRate: a.approaches / n,
      avgRange: a.rangeN ? a.rangeSum / a.rangeN : 110,
      // Most-spammed attack key (null when no habit yet).
      spamKey: (() => {
        let best = null, bn = 0, tot = 0;
        for (const k of Object.keys(a.attackCounts)) { tot += a.attackCounts[k]; if (a.attackCounts[k] > bn) { bn = a.attackCounts[k]; best = k; } }
        return (tot >= 3 && bn / tot >= 0.45) ? best : null;
      })(),
      recoveryBias: (() => {
        const r = a.recoveryDir;
        const t = r.left + r.right + r.center;
        if (t < 2) return null;
        if (r.left > r.right && r.left > r.center) return 'left';
        if (r.right > r.left && r.right > r.center) return 'right';
        return 'center';
      })(),
    };
  }

  updateStuck(now) {
    const f = this.fighter;
    if (!f) return false;
    if (!this.stuckCheck.t) {
      this.stuckCheck = { x: f.x, y: f.y, t: now, count: 0 };
      return false;
    }
    if (now - this.stuckCheck.t > 1500) {
      const _sdx = f.x - this.stuckCheck.x, _sdy = f.y - this.stuckCheck.y;
      const moved = Math.sqrt(_sdx * _sdx + _sdy * _sdy);
      const wantsMove = this.held.left || this.held.right;
      let stuck = false;
      if (wantsMove && moved < 25 && !f.grounded) stuck = true;
      else if (wantsMove && moved < 12) stuck = true;
      this.stuckCheck = { x: f.x, y: f.y, t: now, count: stuck ? this.stuckCheck.count + 1 : 0 };
      return stuck;
    }
    return false;
  }

  noteAction(key) {
    if (key === this.lastActionKey) this.repeatCount += 1;
    else {
      this.lastActionKey = key;
      this.repeatCount = 0;
    }
    this.stats[key] = (this.stats[key] || 0) + 1;
    // §27: track own ability usage so scoring can bonus rarely-used moves
    // (full-kit usage without random cycling).
    if (/smash|tilt|jab|aerial|dash|nsmash|dtilt|dsmash|fsmash|usmash|utilt|ftilt/i.test(key)) {
      const base = key.replace(/-zone$/, '');
      this.abilityUses[base] = (this.abilityUses[base] || 0) + 1;
    }
  }

  // Cached per character id: the owned attack-key list never changes mid-match,
  // so scoring iterates a shared array instead of building a Set from
  // Object.keys on every decision.
  availableKeys() {
    try {
      const f = this.fighter;
      const cid = (f && f._fighterDef && f._fighterDef.id) || '?';
      let arr = _availKeysCache.get(cid);
      if (!arr) {
        const table = attacksFor(f) || {};
        arr = Object.keys(table);
        if (!arr.length) arr = ['jab', 'nsmash', 'ftilt', 'fsmash', 'utilt', 'usmash', 'dtilt', 'dsmash', 'aerialLight', 'aerialHeavy'];
        if (_availKeysCache.size > 32) _availKeysCache.clear();
        _availKeysCache.set(cid, arr);
      }
      return arr;
    } catch (_) {
      return _AVAIL_KEYS_FALLBACK;
    }
  }

  doAttack(type, dir, now, holdMs = 90) {
    this.setHeld('up', !!(dir && dir.up));
    this.setHeld('down', !!(dir && dir.down));
    if (dir && (dir.left || dir.right)) {
      this.setHeld('left', !!dir.left);
      this.setHeld('right', !!dir.right);
    }
    this.pressButton(type === 'special' ? 'special' : 'attack', holdMs, now);
  }

  doJump(now, holdMs = 120) {
    this.pressButton('jump', holdMs, now);
  }

  // §46: both helpers report readiness — false means the shared cooldown
  // (identical to the player's) is live, so callers pick another defense
  // instead of pressing a locked button. The game re-gates regardless.
  doDodge(now, dirX = 0) {
    if ((this.fighter && this.fighter.dodgeCooldown || 0) > 0) return false;
    if (dirX < 0) {
      this.setHeld('left', true);
      this.setHeld('right', false);
    } else if (dirX > 0) {
      this.setHeld('left', false);
      this.setHeld('right', true);
    }
    this.pressButton('dodge', 90, now);
    return true;
  }

  doShield(now, ms = 420) {
    if ((this.fighter && this.fighter.shieldCooldown || 0) > 0) return false;
    // Never permanently hold block: cap single holds, enforce gaps between them.
    const capped = Math.min(ms, 520);
    if (now - this.lastShieldAt < 260) return false;
    this.lastShieldAt = now;
    this.setHeld('shield', true);
    this.shieldUntil = now + capped;
    return true;
  }

  // The horse/shadow ride drives forward — only summon it when there is solid
  // ground ahead in the facing direction, never off an edge / off-stage.
  horseSafe() {
    const f = this.fighter;
    if (!f || !f.grounded) return false;
    try {
      const g = mainGround(this._stageHint);
      if (!g) return true;
      const dir = f.facingRight ? 1 : -1;
      const aheadX = f.x + dir * 200;
      return aheadX > g.x && aheadX < g.x + g.width;
    } catch (_) {
      return true;
    }
  }

  // ── Scored attack selection (entire moveset) ────────────────────────────
  // Every owned key is scored on: distance fit, vertical fit, opponent
  // velocity/state, real startup/recovery/cooldown, combo opportunity,
  // vulnerability, stage position, risk, connect chance, personality and
  // adaptation. Highest score wins (with soft randomness so AIvsAI diverges).
  scoreAttacks(P, now) {
    const f = this.fighter;
    const keys = this.availableKeys();
    const pers = this.personality;
    const rates = this.adaptRates();
    let table = {};
    try { table = attacksFor(f) || {}; } catch (_) { table = {}; }
    const out = [];
    const oppFallingOntoUs = P.oppAirborne && P.oppVy > 60 && P.vDist < -30 && P.vDist > -190;
    const oppY = f.y + P.vDist;
    // Hoisted: the variety bonus used to run Object.values().reduce() per
    // candidate (12x per decision). One pass here instead.
    let _totalUses = 0;
    try {
      const _au = this.abilityUses;
      for (const _k in _au) _totalUses += _au[_k];
    } catch (_) {}
    for (const key of keys) {
      const def = effDefFor(f, key, table);
      if (!def) continue;
      const prof = ATTACK_PROFILES[key] || { range: 120, vBias: 'level', speed: 0.7, risk: 0.4 };
      // Real reach for THIS attack (character-specific def, custom boxes and
      // ability routing included) + predicted connect chance. No two attacks
      // share an artificial range anymore.
      const R = attackReach(key, def, f);
      const prefDist = Math.max(30, (R.fwd || 60) * 0.65);
      const connect = connectChance(R, P, f, this.opponent);
      let s = 1.0;
      // Distance fit: Gaussian around this attack's preferred distance.
      const dh = Math.abs(P.hDist - prefDist);
      const sigma = Math.max(30, prefDist * 0.55);
      s *= Math.exp(-(dh * dh) / (2 * sigma * sigma));
      // Vertical fit.
      if (!f.grounded) {
        // Airborne: exactly the two direction-independent aerials.
        if (key !== 'aerialLight' && key !== 'aerialHeavy') { s *= 0.02; }
        else if (key === 'aerialHeavy' && (P.oppAbove || oppFallingOntoUs)) s *= 1.7;
        else if (key === 'aerialLight' && P.oppLevel) s *= 1.4;
      } else {
        if (prof.vBias === 'above') s *= P.oppAbove ? 1.9 : (P.oppLevel ? 0.5 : 0.25);
        else if (prof.vBias === 'below') s *= P.oppBelow ? 1.7 : (P.oppLevel ? 0.55 : 0.35);
        else if (prof.vBias === 'level') s *= P.oppLevel ? 1.35 : 0.75;
        // Grounded fighter never picks aerials.
        if (key === 'aerialLight' || key === 'aerialHeavy') s *= 0.02;
        // Dash attack only while dashing (combat routes it then); down-weight otherwise.
        if (key === 'dash' && !f.dashing) s *= 0.15;
      }
      // Opponent velocity: lead fast movers with zoners, punish approachers.
      if (P.oppSpeed > 260 && (key === 'fsmash' || key === 'dtilt' || key === 'ftilt')) s *= 1.25;
      if (P.oppApproaching && (key === 'ftilt' || key === 'jab' || key === 'utilt')) s *= 1.3;
      // Vulnerability / combo: fast startup wins the punish.
      const startup = (def.startup != null ? def.startup : 5);
      const recovery = (def.recovery != null ? def.recovery : 12);
      if (P.oppVulnerable) {
        s *= (1.2 + pers.comboPriority * 0.9);
        s *= startup <= 5 ? 1.5 : (startup <= 8 ? 1.1 : 0.8);
      }
      if (P.oppWhiff) s *= 1.5; // punish missed attacks
      // Risk: laggy moves penalized when threatened or at high percent near blast.
      const threatened = P.oppAttacking && P.hDist < 150;
      if (threatened) s *= 1 - prof.risk * (0.35 + pers.defense * 0.4);
      if (P.ownPercent > 80 && P.distToBlast < 320) s *= 1 - prof.risk * 0.45 * (1 - pers.riskTolerance);
      // Personality: aggression loves heavies, defense loves safe pokes.
      if (/smash/i.test(key) || key === 'dsmash' || key === 'fsmash' || key === 'usmash' || key === 'nsmash') {
        s *= 0.55 + pers.aggression * 0.9 + pers.riskTolerance * 0.5;
        // Kill-hunting: at high opponent percent, heavies become finishers —
        // boost them (still gated by reach/risk above, never a blind suicide).
        if (P.oppPercent > 60) s *= 1.35;
        if (P.oppPercent > 100) s *= 1.25;
      } else {
        s *= 0.8 + (1 - pers.riskTolerance) * 0.3 + (1 - pers.aggression) * 0.2;
      }
      // Stage position: never horse-ride off an edge; prefer safe pokes there.
      // Horse-only: the boxer's blink lands clamped behind the target and the
      // ninja's dash is steered, so neither needs the ride-off-an-edge guard.
      if ((key === 'dsmash') && R.kind === 'horse' && !this.horseSafe() && !f.grounded) s *= 0.1;
      if ((key === 'dsmash') && R.kind === 'horse' && f.grounded && !this.horseSafe()) s *= 0.25;
      if (P.nearEdge < 60 && prof.risk > 0.6) s *= 0.6;
      // Cooldowns: respect own dodge/attack lockout implicitly (decisions skip
      // while busy), plus dodge-cooldown pressure for committal moves.
      if (f.dodgeCooldown > 0.25 && prof.risk > 0.6) s *= 0.8;
      // Adaptation:
      // - Opp jumps a lot → anti-air premium.
      if (rates.jumpFreq > 0.04 && (key === 'utilt' || key === 'usmash' || key === 'aerialHeavy')) s *= 1.35;
      // - Opp blocks a lot → delay/space: punish with quick pokes, avoid laggy smashes into shield.
      if (rates.blockFreq > 0.05 && prof.risk > 0.6) s *= 0.7;
      if (rates.blockFreq > 0.05 && (key === 'jab' || key === 'ftilt')) s *= 1.2;
      // - Opp dodges a lot → prefer fast startup, avoid committing.
      if (rates.dodgeFreq > 0.04 && startup > 8) s *= 0.7;
      if (rates.dodgeFreq > 0.04 && startup <= 4) s *= 1.25;
      // - Opp spams one attack → pick the counter-range (if they spam side,
      //   meet with up; the scoring already reflects geometry, add a nudge).
      if (rates.spamKey && rates.spamKey !== key) s *= 1.05;
      // §27 full-kit variety: rarely-used owned abilities get a small bonus
      // so the AI rotates through specials/projectiles instead of camping on
      // jab/ftilt. Bonus is capped and never overrides geometry/risk.
      const uses = this.abilityUses[key.replace(/-zone$/, '')] || 0;
      const totalUses = _totalUses;
      if (totalUses >= 6 && uses === 0) s *= 1.3;
      else if (totalUses >= 10 && uses * 4 < totalUses) s *= 1.15;
      // §30 vertical positioning — explicit axis bonuses on top of vBias:
      // falling toward us → anti-air premium; we are above → downward/aerial
      // premium; opp far above → jump/uppercut premium (handled by caller too).
      if (P.oppFallingToward && (key === 'utilt' || key === 'usmash' || key === 'aerialHeavy')) s *= 1.4;
      if (P.aiAbove && !f.grounded && (key === 'aerialLight' || key === 'aerialHeavy')) s *= 1.25;
      if (P.aiAbove && f.grounded && key === 'dtilt') s *= 1.15;
      // ── Down-attack intelligence (situation-driven, never random) ──
      // Down Light: close, grounded or landing opponent at/below our level;
      // approaching, vulnerable, or punishable targets; valid combo starter
      // (fast startup) and follow-up when the victim drops low.
      if (key === 'dtilt' && f.grounded) {
        const lowBand = P.vDist >= -24 && P.vDist <= 72;
        const inReach = P.hDist < (R.fwd || 80) + 30;
        if (R.kind === 'deadeye') {
          // Deadeye volley: homing bullets punish approaches, pressure and
          // vulnerable targets at close-to-mid range. Never waste it while a
          // volley is already live.
          if (f._deadeye) s *= 0.05;
          else if (P.hDist < 430) {
            s *= 1.2;
            if (P.oppApproaching || P.oppAttacking) s *= 1.5;
            if (P.oppVulnerable || P.oppWhiff) s *= 1.5;
            if (P.oppLanding) s *= 1.35;
            if (P.hDist < 200) s *= 1.25; // close volleys barely miss
            if (P.oppGrounded && lowBand) s *= 1.2;
          } else s *= 0.3;
        } else if (lowBand && inReach && P.oppGrounded) {
          s *= 1.6; // Low Sweep class: the core grounded punish/poke
          if (P.oppApproaching) s *= 1.3;
          if (P.oppVulnerable || P.oppWhiff) s *= 1.5; // combo starter
          if (P.oppLanding) s *= 1.4;
        } else if (P.oppLanding && P.hDist < (R.fwd || 80) + 60) {
          s *= 1.35; // meet the landing
        } else if ((P.oppVulnerable || P.oppWhiff) && inReach) {
          s *= 1.4; // punish, even slightly off-level
        }
        // Combo follow-up: victim stunned and dropping toward the ground.
        if ((P.oppVulnerable) && !P.oppGrounded && P.oppVy > 40 && P.hDist < 220) s *= 1.4;
        // Wrong tool when the opponent holds the high ground (melee only —
        // Deadeye homing still works from below).
        if (P.oppAbove && R.kind !== 'deadeye') s *= 0.35;
      }
      // Down Heavy: downward/ground-oriented punish. Horse needs grounded foe
      // in front at ride range; Shadow Strike dashes gaps to punish landing,
      // recovering or vulnerable targets — never a blind neutral swing.
      if (key === 'dsmash' && f.grounded) {
        if (R.kind === 'horse') {
          const groundedFoe = P.oppGrounded && P.vDist >= -40 && P.vDist <= 56;
          const rideBand = P.hDist > 50 && P.hDist < 300;
          if (groundedFoe && rideBand && this.horseSafe()) {
            s *= 1.7;
            if (P.oppApproaching) s *= 1.3;
            if (P.oppLanding) s *= 1.4;
            if (P.oppVulnerable || P.oppWhiff) s *= 1.5;
          } else if (P.oppRecovery > 0 && Math.abs(oppY - f.y) < 90 && P.hDist < 300 && this.horseSafe()) {
            s *= 1.6; // recovering low → trample the recovery
          } else if (!this.horseSafe()) {
            s *= 0.15; // never ride off an edge
          } else s *= 0.55;
          if (P.oppAbove) s *= 0.4;
        } else if (R.kind === 'dash') {
          // Shadow Strike: slow startup, so punish-only.
          const punishWindow = P.oppVulnerable || P.oppWhiff || P.oppLanding || P.oppRecovery > 0;
          if (punishWindow && P.hDist > 70 && P.hDist < 300) s *= 1.6;
          else if (!punishWindow) s *= 0.6;
          if (P.oppAbove) s *= 0.4;
        }
      }
      // Combo follow-up routing by launch direction: victim popped upward →
      // up/aerial tools (down tools suppressed); victim stunned and sinking →
      // down tools become the follow-up.
      if (P.oppVulnerable && !P.oppGrounded) {
        if (P.oppVy < -120 && (key === 'dtilt' || key === 'dsmash')) s *= 0.5;
        if (P.oppVy > 60 && (key === 'dtilt' || key === 'dsmash') && P.hDist < 220) {
          const landsNear = (P.stageTop - oppY) < 200;
          if (landsNear) s *= 1.5;
        }
      }
      // Predicted connect chance gates the score: real alignment (this
      // attack's hitbox vs. the predicted hurtbox) beats any static range.
      // Lunges keep partial credit (they close distance); dead reads die.
      if (R.kind === 'dash' || R.kind === 'horse') s *= 0.45 + 0.55 * connect;
      else if (R.kind === 'projectile' || R.kind === 'deadeye') s *= 0.35 + 0.65 * connect;
      else s *= 0.2 + 0.8 * connect;
      // Recency variety: repeating the same swing scores worse, so the AI
      // rotates through Light / Heavy / Down / Smash / aerial / special
      // instead of camping one move. Reachability (the connect gate in
      // chooseAndFire) always outranks variety — this only reorders VALID
      // options, never forces a random or unreachable pick. Punishes and
      // combo follow-ups take half the penalty so true sequences still flow.
      if (this.recentAttacks && this.recentAttacks.length) {
        const idx = this.recentAttacks.lastIndexOf(key);
        if (idx >= 0) {
          const ago = this.recentAttacks.length - 1 - idx; // 0 = previous swing
          let pen = ago === 0 ? 0.35 : ago === 1 ? 0.55 : ago === 2 ? 0.7 : ago === 3 ? 0.82 : 0.9;
          if (P.oppVulnerable || P.oppWhiff) pen = 1 - (1 - pen) * 0.5;
          s *= pen;
        }
      }
      // Zoner pacing: projectiles/Deadeye volleys need no approach, so
      // without pacing the AI camps one zoning move forever. After firing one,
      // other zoners are strongly suppressed for 2.5s — forcing the AI to
      // close distance and use its melee mix instead. Still fires a zoner when
      // it is the only reachable option (score reorder only, gate untouched).
      if (now != null && (R.kind === 'projectile' || R.kind === 'deadeye')
          && now - (this.lastZonerAt || -1e9) < 2500) {
        s *= 0.3;
      }
      // Neural steering: the trained net biases (never dictates) the pick.
      // Illegal options are still filtered by the attack gate + combatInput.
      if (this.neuroNet && this.neuroInfluence > 0 && this._nnOut) {
        s *= this._neuroBias(nnOutputForAttackKey(key));
      }
      out.push({ key, def, score: s, startup, recovery, risk: prof.risk, connect, kind: R.kind, prefDist, fwd: R.fwd || 60 });
    }
    out.sort((a, b) => b.score - a.score);
    return out;
  }

  chooseAndFire(now, hDist, vDist, allowPacing = false) {
    const f = this.fighter;
    if (!f) return false;
    const P = buildPerception(f, this.opponent, this._stageHint);
    const pers = this.personality;
    // §46 attack gate — the full pre-attack checklist, same locks as the
    // player: cooldown ready AND able to act AND target in reasonable range.
    // (Range/situation validity is scored below; combatInput re-gates anyway.)
    // When the lock is live the caller falls through to movement/defense, so
    // the AI repositions during cooldowns instead of standing still.
    if (!P.attackReady) return false;
    if (f.hitstun > 0 || f.attack || f.dodging || f._hitLock) return false;
    // Attack-frequency gate: not every in-range decision must swing (human
    // pacing + AIvsAI variety). Combos/punishes bypass the gate.
    const mustStrike = P.oppVulnerable || P.oppWhiff;
    if (!mustStrike && Math.random() > pers.attackFrequency + pers.aggression * 0.25) {
      try { this.diag.freqBlock++; } catch (_) {}
      return false;
    }
    const scored = this.scoreAttacks(P, now);
    if (!scored.length || scored[0].score < 0.12) {
      try { this.diag.noScore++; } catch (_) {}
      return false;
    }
    // Accuracy gate: only attacks with a realistic predicted connection may
    // fire. Punishes accept a thinner margin; everything else must plausibly
    // land. When nothing connects, do NOT swing anyway — remember the best
    // option as approach intent and close the distance instead.
    // (mustStrike is defined above at the frequency gate.)
    const gate = mustStrike ? 0.2 : 0.3;
    const reachable = scored.filter((e) => (e.connect || 0) >= gate && e.score >= 0.12);
    if (!reachable.length) {
      try { this.diag.gateBlock++; } catch (_) {}
      const want = scored[0];
      if (want) {
        this.aimKey = want.key;
        this.aimUntil = now + 1500;
        this.aimDist = want.prefDist || 90;
        this.plan = { move: P.dx > 10 ? 1 : P.dx < -10 ? -1 : 0 };
        this.planUntil = now + 200;
        this.noteAction('approach-range');
        this.debug.state = 'approach-range';
      }
      return false;
    }
    // Soft pick among reachable attacks: usually the best, sometimes the
    // runner-up (unpredictability). Lower difficulties second-guess more.
    // No re-sort: scoreAttacks already returned best-first and filter preserves
    // order, so reachable inherits it.
    // Deliberate pacing (§24/32) — neutral only, and ONLY when there is no
    // high-confidence opening. A reachable attack at connect ≥ 0.55 strikes
    // immediately instead of strafing away a real chance.
    const mustVary = this.repeatCount >= 4;
    if (allowPacing && !mustStrike && !mustVary
        && (reachable[0].connect || 0) < 0.55
        && Math.random() > pers.attackFrequency + 0.1) {
      const r = Math.random();
      if (r < 0.4) {
        if (now >= this.strafeUntil) { this.strafeDir = Math.random() < 0.5 ? -1 : 1; this.strafeUntil = now + 400; }
        this.plan = { move: this.strafeDir };
        this.planUntil = now + 200;
        this.noteAction('strafe');
      } else if (r < 0.55 && f.grounded) {
        this.doJump(now, 115);
        this.plan = { move: this.strafeDir };
        this.planUntil = now + 200;
        this.noteAction('reposition-hop');
      } else {
        this.plan = { move: 0 };
        this.planUntil = now + 160;
        this.noteAction('micro-spacing');
      }
      this.moveTicks++;
      return false;
    }
    let pick = reachable[0];
    const wobble = 0.22 + (this.mistakeRate || 0) * 0.9;
    if (reachable.length > 1 && Math.random() < wobble) pick = reachable[1];
    // Risk gate: laggy picks need a calm moment unless very aggressive.
    if (pick.risk > 0.65 && P.oppAttacking && P.hDist < 130 && Math.random() > pers.riskTolerance) {
      const safe = reachable.find((c) => c.risk < 0.4);
      if (safe) pick = safe;
    }
    const key = pick.key;
    const dx = (this.opponent ? this.opponent.x - f.x : 0) || 0;
    const wantLeft = dx < -8;
    const wantRight = dx > 8;
    const sideDir = { left: wantLeft, right: wantRight };
    // Alignment: directed attacks only threaten the faced direction. If we
    // are not facing the opponent, turn + close in first — never swing
    // backwards into empty space.
    const directedKind = pick.kind === 'melee' || pick.kind === 'dash'
      || pick.kind === 'horse' || pick.kind === 'projectile';
    if (directedKind && !facingOppNow(f, dx)) {
      this.aimKey = key;
      this.aimUntil = now + 1200;
      this.aimDist = pick.prefDist || 90;
      this.plan = { move: dx > 0 ? 1 : -1 };
      this.planUntil = now + 200;
      this.noteAction('turn-approach');
      try { this.diag.turnFix++; } catch (_) {}
      this.debug.state = 'turn-approach';
      return false;
    }
    try { this.diag.fired++; } catch (_) {}
    const fire = (type, dir, note) => {
      this.doAttack(type, dir, now);
      this.noteAction(note || key);
      this.aimKey = null;
      // Zoner pacing timestamp (projectile / Deadeye volley just fired).
      try {
        if (pick.kind === 'projectile' || pick.kind === 'deadeye') this.lastZonerAt = now;
      } catch (_) {}
      // Recency window for the variety penalty (last 8 chosen swings).
      try {
        this.recentAttacks.push(key);
        if (this.recentAttacks.length > 8) this.recentAttacks.shift();
      } catch (_) {}
      this.debug.action = note || key;
    };
    if (!f.grounded) {
      if (key === 'aerialHeavy') { fire('special', {}, 'aerialHeavy'); return true; }
      fire('attack', {}, 'aerialLight'); return true;
    }
    // Map key → real input (light vs heavy + direction), exactly as a human.
    if (key === 'jab') fire('attack', {}, 'jab');
    else if (key === 'nsmash') fire('special', {}, 'nsmash');
    else if (key === 'ftilt' || key === 'btilt') fire('attack', sideDir, key);
    else if (key === 'fsmash' || key === 'bsmash') fire('special', sideDir, key);
    else if (key === 'utilt') fire('attack', { up: true }, 'utilt');
    else if (key === 'usmash') fire('special', { up: true }, 'usmash');
    else if (key === 'dtilt') fire('attack', { down: true }, 'dtilt');
    else if (key === 'dsmash') fire('special', { down: true }, 'dsmash');
    else if (key === 'dash') fire('attack', sideDir, 'dash');
    else fire('attack', {}, key);
    return true;
  }

  makeDecision(now, stage) {
    const f = this.fighter;
    const opp = this.opponent;
    if (!f || !opp) return;
    const pers = this.personality;
    // Refresh the steering network once per decision (cheap: one forward pass
    // per ~150ms). All scoring below reads this._nnOut as bias terms only.
    if (stage) this._stageHint = stage;
    try { this.ensureNeuro(); } catch (_) { this._nnOut = null; }

    // Never decide while locked out — hold current inputs and wait.
    if (f.hitstun > 0 || f.attack || f.dodging || f._hitLock) {
      this.debug.state = 'busy';
      return;
    }

    const P = buildPerception(f, opp, stage);
    const stuck = this.updateStuck(now);
    const mustVary = this.repeatCount >= 4;

    // ── 1. RECOVERY (highest priority) ──────────────────────────────
    // Separate resources, never wasted together: exactly ONE resource per
    // decision (DJ → Aerial-Light → up-special), re-evaluated next tick.
    if (P.ownUrgency > 0) {
      this.debug.state = P.ownUrgency === 2 ? 'recover-urgent' : 'recover';
      const g = mainGround(stage);
      const targetX = g ? g.x + g.width / 2 : 600;
      const toward = targetX - f.x;
      this.plan = { move: toward > 10 ? 1 : toward < -10 ? -1 : 0, holdUp: false, holdDown: false };
      this.planUntil = now + 220;

      const falling = f.vy > 60;
      const belowStage = g ? f.y > g.y - 20 : f.y > 800;
      const needNow = (falling || belowStage || P.ownUrgency === 2) && !f.grounded;
      if (needNow) {
        const urgencyScale = pers.recoveryPriority;
        // Double jump first (the reusable height engine) — not at the apex,
        // only when falling/below or truly urgent.
        if (f.canDoubleJump && (falling || belowStage || P.ownUrgency === 2) && Math.random() < 0.35 + urgencyScale * 0.65) {
          this.doJump(now, 130);
          this.noteAction('dj-recover');
          this.debug.action = 'double-jump';
          return;
        }
        // Then Aerial Light (strong self-launch, independent of DJ).
        if (f.canUseAerialLightRecovery && Math.random() < 0.35 + urgencyScale * 0.65) {
          this.doAttack('attack', {}, now);
          this.noteAction('al-recover');
          this.debug.action = 'aerialLight-recover';
          return;
        }
        // Last resort: up-special (consumes free-fall — never first).
        if (!f.freeFall) {
          this.setHeld('up', true);
          this.setHeld('left', toward < 0);
          this.setHeld('right', toward > 0);
          this.pressButton('special', 100, now);
          this.noteAction('up-special');
          this.debug.action = 'up-special';
          return;
        }
      }
      return;
    }

    // ── 1b. STAGE-CENTER SAFETY (§41 — never fight the edge for free) ──
    // Continuous positioning monitor, checked every decision before any
    // aggression (recovery already ran above and owns the off-stage case —
    // DJ/AL/up-special steering there aims at center too). Tiers:
    //   safe (inside ≥ 150, or edgeguarding) → normal combat below;
    //   drifting (inside < 150 + moving toward edge) → bias home, may attack;
    //   close (inside < 70) → strongly return; attack only on instant punish;
    //   airborne + sliding out → steer home (recovery owns DJ/AL spending).
    // Opponent off-stage ⇒ we belong at the edge (edgeguard next), so this
    // branch yields. Chasing a healthy on-stage opponent past the edge is
    // never worth it — hold the line instead.
    if (P.ownUrgency === 0 && P.oppRecovery === 0) {
      // A punishable victim overrides positioning: fall through to combo/
      // punish below (which gates the actual swing on the attack lock) so a
      // stunned opponent at the edge gets finished, not abandoned. A
      // high-percent opponent is hunted the same way — letting them reset to
      // neutral at 100%+ is how grinds happen.
      const immediatePunish = ((P.oppVulnerable || P.oppWhiff) && P.hDist < 200)
        || P.oppPercent > 90;
      const closeEdge = P.signedInside < 70;
      // Drift veto applies when sliding toward the edge AWAY from the
      // opponent (bad positioning) — never when chasing them toward it.
      // (Chases die at the lip via the grounded clamp + edgeguard logic.)
      const driftingOut = P.signedInside < 150 && P.movingTowardEdge
        && Math.sign(f.vx || 0) !== Math.sign(P.dx || 0);
      if ((closeEdge || driftingOut) && !immediatePunish) {
        const home = P.centerDir !== 0 ? P.centerDir : -P.edgeSide;
        if (!f.grounded) {
          // Airborne but still over/near the platform: steer home, no
          // resource spending here (recovery branch owns DJ/AL).
          this.debug.state = 'center-steer';
          this.plan = { move: home };
          this.planUntil = now + 200;
          this.noteAction('center-steer');
          return;
        }
        this.debug.state = 'center-return';
        const threatened = P.oppAttacking && P.hDist < 200;
        // Urgent (at the lip or pressured): dash-dodge home when ready —
        // the §23 dash-dodge, same cooldown the player obeys.
        if ((P.signedInside < 35 || threatened) && P.dodgeReady && Math.random() < 0.6 + pers.defense * 0.3) {
          this.doDodge(now, home);
          this.plan = { move: home };
          this.planUntil = now + 200;
          this.noteAction('center-dash');
          this.debug.action = 'dodge-center';
          return;
        }
        // Otherwise walk/run home; hop the gap shut when far from center.
        this.plan = { move: home };
        this.planUntil = now + 220;
        if (Math.abs(f.x - P.centerX) > 200 && Math.random() < 0.35) {
          this.doJump(now, 125);
          this.noteAction('center-hop');
        } else {
          this.noteAction('center-return');
        }
        return;
      }
    }

    // ── 2. EDGEGUARD ────────────────────────────────────────────────
    // Opp off-stage + vulnerable: pursue only when safe, intercept with the
    // right aerial, always keep a way home. Never suicide. At high opp
    // percent the AI hunts the finish (higher pursuit chance, deeper but
    // still resource-safe). §41 chase-risk: a grounded fighter never runs
    // past the edge after a healthy opponent — hold the edge and punish the
    // recovery instead.
    const killHunt = P.oppPercent > 70 ? 0.25 : (P.oppPercent > 45 ? 0.12 : 0);
    if (P.oppRecovery > 0 && P.ownUrgency === 0 && Math.random() < Math.min(1, pers.edgeguardPriority + killHunt)) {
      this.debug.state = 'edgeguard';
      const g = mainGround(stage);
      const oppVuln = opp.hitstun > 0 || opp.freeFall || !opp.canDoubleJump;
      if (g) {
        // Stand at the edge nearest the opponent (adapt to their recovery side).
        const edgeX = opp.x < (g.x + g.width / 2) ? g.x + 30 : g.x + g.width - 30;
        const ex = edgeX - f.x;
        this.plan = { move: ex > 15 ? 1 : ex < -15 ? -1 : 0 };
        this.planUntil = now + 220;
      }
      // Safe aerial pursuit: airborne, have resources to return, opp low/close.
      const canPursue = !f.grounded
        ? (f.canDoubleJump || f.canUseAerialLightRecovery)
        : (f.canDoubleJump && f.canUseAerialLightRecovery);
      const deepRisk = P.distToBlast < 220 || Math.abs(opp.y - f.y) > 320;
      if (!f.grounded && canPursue && !deepRisk && P.dist < 200 && (oppVuln || Math.random() < 0.5)) {
        // Intercept with the geometry-correct aerial (above → heavy, else light).
        this.chooseAndFire(now, P.hDist, P.vDist);
        return;
      }
      if (f.grounded && P.hDist < 175 && Math.abs(P.vDist) < 190) {
        this.chooseAndFire(now, P.hDist, P.vDist);
        return;
      }
      // Jump to meet a high-recovering opponent when grounded and safe.
      if (f.grounded && P.vDist < -90 && P.hDist < 200 && oppVuln && Math.random() < 0.5) {
        this.doJump(now, 130);
        this.plan = { move: P.dx > 0 ? 1 : -1 };
        this.planUntil = now + 220;
        this.noteAction('edgeguard-jump');
        return;
      }
      // Deep intercept vs a HIGH-PERCENT recovery: the reward justifies
      // leaving the edge when both resources are banked (DJ + AL — one out,
      // one home). Below 80% the chase-risk rule below holds instead.
      if (f.grounded && P.oppPercent >= 80 && P.oppEdgeInside < -40
        && f.canDoubleJump && f.canUseAerialLightRecovery
        && Math.random() < pers.edgeguardPriority) {
        this.doJump(now, 130);
        this.plan = { move: P.dx > 0 ? 1 : -1 };
        this.planUntil = now + 260;
        this.noteAction('edgeguard-deep');
        this.debug.action = 'edgeguard-deep';
        return;
      }
      // §41 chase-risk: grounded at the edge vs a HEALTHY opponent far
      // off-stage — do NOT run off after them. Hold inside the edge; the
      // grounded punish above fires when they come back in range.
      if (f.grounded && !oppVuln && P.oppEdgeInside < -60 && P.oppPercent < 80) {
        this.debug.state = 'edgeguard-hold';
        this.plan = { move: 0 };
        this.planUntil = now + 220;
        this.noteAction('edgeguard-hold');
        return;
      }
      return;
    }

    // ── 3. DEFENSE ──────────────────────────────────────────────────
    // Block / dodge / move / jump / fast-fall / retreat. Never permanently
    // hold block (doShield caps + gaps). Punish whiffs immediately after.
    if (P.oppWhiff && P.hDist < 185 && !mustVary) {
      this.debug.state = 'punish';
      this.plan = { move: P.dx > 10 ? 1 : P.dx < -10 ? -1 : 0 };
      this.planUntil = now + 200;
      this.chooseAndFire(now, P.hDist, P.vDist);
      return;
    }
    if (!mustVary && P.oppAttacking && P.hDist < 140) {
      const rates = this.adaptRates();
      // Anticipate spammed attacks: defend earlier vs the habit.
      const defendBias = pers.defense + (rates.spamKey ? 0.15 : 0);
      if (Math.random() < defendBias) {
        const r = Math.random();
        // Fast-fall escape when juggled from below.
        if (!f.grounded && P.oppBelow && f.vy > -50 && Math.random() < 0.35) {
          this.setHeld('down', true);
          this.plan = { move: P.dx > 0 ? -1 : 1, holdDown: true };
          this.planUntil = now + 180;
          this.noteAction('fastfall-escape');
          this.debug.state = 'defense-fastfall';
          return;
        }
        // §46: check the SAME cooldowns the player obeys — block only when
        // blockReady, dodge only when dodgeReady, otherwise fall through to
        // retreat/reposition instead of mashing a locked defense.
        if (r < 0.52 && f.grounded && P.blockReady) {
          this.debug.state = 'block';
          this.doShield(now, 300 + Math.random() * 200);
          this.noteAction('block');
          this.debug.action = 'block';
          return;
        }
        if (P.dodgeReady && Math.random() < pers.riskTolerance + 0.3) {
          this.debug.state = 'dodge';
          // Dodge AWAY from the opponent (or toward, rarely, to cross up).
          const away = P.dx > 0 ? -1 : 1;
          this.doDodge(now, Math.random() < 0.85 ? away : -away);
          this.noteAction('dodge');
          this.debug.action = 'dodge';
          return;
        }
        // Otherwise retreat + reposition (walk, not dodge).
        this.debug.state = 'retreat';
        this.plan = { move: P.dx > 0 ? -1 : 1 };
        this.planUntil = now + 200;
        // Jump over a grounded rush.
        if (f.grounded && P.oppGrounded && P.hDist < 90 && Math.random() < 0.4) {
          this.doJump(now, 130);
          this.noteAction('defense-jump');
        }
        return;
      }
    }

    // ── 4. COMBO / FOLLOW-UP ────────────────────────────────────────
    // Hit connects (opp percent rose or opp in hitstun after our strike):
    // predict trajectory, drift into follow-up position, strike with the
    // geometry-correct move. Adaptive, never scripted.
    const oppVulnerable = P.oppVulnerable;
    if (!mustVary && oppVulnerable && P.hDist < 195 && Math.random() < pers.comboPriority) {
      this.comboCount += 1;
      if (this.comboCount <= 4) {
        this.debug.state = 'combo';
        // Predict where the victim will be (~0.25s ahead with gravity).
        const t = 0.25;
        const predX = opp.x + (opp.vx || 0) * t;
        const predY = opp.y + (opp.vy || 0) * t + 0.5 * 1750 * t * t * 0.4;
        const cdx = predX - f.x;
        this.plan = { move: cdx > 12 ? 1 : cdx < -12 ? -1 : 0 };
        this.planUntil = now + 200;
        // Chase airborne victims into the air when it pays.
        if (f.grounded && (predY < f.y - 80) && Math.random() < 0.45 + pers.comboPriority * 0.3) {
          this.doJump(now, 130);
          this.noteAction('combo-chase-jump');
          this.debug.action = 'jump';
          return;
        }
        this.chooseAndFire(now, P.hDist, P.vDist);
        return;
      }
    } else if (!oppVulnerable) {
      this.comboCount = 0;
    }

    // ── 5. STUCK UNSTICK ────────────────────────────────────────────
    if (stuck) {
      this.debug.state = 'unstick';
      this.plan = { move: (f.facingRight ? -1 : 1) };
      this.planUntil = now + 350;
      if (!f.grounded && f.canDoubleJump) this.doJump(now, 130);
      else if (f.grounded && Math.random() < 0.7) this.doJump(now, 130);
      this.noteAction('unstick');
      return;
    }

    // ── 6. UNIFIED NEUTRAL (§24/25/28/30/31/32) ───────────────────────────
    // One pipeline, re-evaluated every decision (never a fixed script):
    //   game state → desired position (distance bands) → threat → approach or
    //   retreat? → defensive options? → attacks? → vertical? → vulnerability?
    //   → score movement AND attack actions together → execute best.
    // Movement actions (approach/retreat/strafe/dash/jump/fast-fall/
    // reposition) compete with attacks every tick, so the AI visibly moves,
    // creates distance, and sometimes deliberately repositions instead of
    // forcing an attack (§32).
    this.debug.state = 'neutral';
    const rates = this.adaptRates();
    const minSafe = pers.minimumSafeDistance ?? 55;
    const maxEngage = pers.maximumEngagementDistance ?? 260;
    const tooClose = P.hDist < minSafe;
    const tooFar = P.hDist > maxEngage;
    const inPocket = !tooClose && !tooFar;

    // §29 post-attack reposition: our swing just ended — knockback, positions
    // and the opponent's likely reply decide follow-up vs safe distance vs
    // intercept jump (never auto-stand beside them).
    if (this.wasAttacking && !f.attack && now - this.lastAttackEndedAt < 500) {
      this.wasAttacking = false;
      const oppFlying = P.oppHitstun > 0 && P.oppSpeed > 200;
      if (oppFlying && P.hDist < 195 && Math.random() < pers.comboPriority) {
        // Continue: combo branch below handles the chase; fall through.
      } else if (tooClose && Math.random() < 0.55 + (1 - pers.aggression) * 0.3) {
        this.debug.state = 'reposition';
        // Back out to preferred range (dash-dodge out when pressured).
        if (f.dodgeCooldown <= 0 && (P.oppAttacking || P.oppSpeed > 200) && Math.random() < 0.5) {
          this.doDodge(now, P.dx > 0 ? -1 : 1);
          this.noteAction('reposition-dash');
          this.debug.action = 'dodge-reposition';
        } else {
          this.plan = { move: P.dx > 0 ? -1 : 1 };
          this.planUntil = now + 200;
          this.noteAction('reposition-retreat');
        }
        return;
      } else if (!tooClose && Math.random() < 0.35) {
        // Strafe to a new angle instead of standing still.
        this.strafeDir = Math.random() < 0.5 ? -1 : 1;
        this.strafeUntil = now + 260;
        this.plan = { move: this.strafeDir };
        this.planUntil = now + 220;
        this.noteAction('reposition-strafe');
        return;
      }
      // Else fall through to the unified scoring below.
    }

    // Score movement + attack actions TOGETHER (§28). Each entry: {do, score}.
    const actions = [];
    const wantDir = P.dx > 0 ? 1 : -1; // toward opponent
    const awayDir = -wantDir;
    // — spacing desires from the distance bands (§25)
    if (tooClose) {
      actions.push({ id: 'create-distance', score: 1.5 + (1 - pers.aggression) * 0.8 });
      actions.push({ id: 'attack', score: 0.7 + pers.aggression * 0.6 });
    } else if (tooFar) {
      actions.push({ id: 'approach', score: 1.5 + pers.aggression * 0.5 });
      actions.push({ id: 'attack', score: P.dist > 340 ? 0.6 : 0.25 }); // zone only
    } else {
      actions.push({ id: 'attack', score: 1.05 });
      actions.push({ id: 'reposition', score: 0.9 + (1 - pers.aggression) * 0.4 });
      actions.push({ id: 'approach', score: 0.5 });
    }
    if (P.oppAttacking && P.hDist < 200) actions.push({ id: 'defend', score: 1.2 + pers.defense * 0.8 });
    if (P.incoming && P.incoming.timeToHit < 0.55) actions.push({ id: 'dodge-projectile', score: 1.8 });
    if (P.oppAboveFar || (P.oppAbove && f.grounded)) actions.push({ id: 'vertical-meet', score: 1.1 });
    if (P.aiAbove && !f.grounded) actions.push({ id: 'vertical-descend', score: 0.9 });
    if (P.oppFallingToward) actions.push({ id: 'anti-air', score: 1.4 });
    // Neural steering for movement: the net's directional preferences bias
    // (never dictate) the winning action. Indices follow NN_OUTPUT_LABELS.
    if (this.neuroNet && this.neuroInfluence > 0 && this._nnOut) {
      for (const a of actions) {
        if (a.id === 'approach') a.score *= this._neuroBias(17);
        else if (a.id === 'create-distance') a.score *= this._neuroBias(18);
        else if (a.id === 'reposition') a.score *= this._neuroBias(2);
        else if (a.id === 'defend') a.score *= Math.max(this._neuroBias(4), this._neuroBias(5));
        else if (a.id === 'attack') {
          const atk = this._nnOut;
          let mean = 0, n = 0;
          for (let oi = 6; oi <= 16 && oi < atk.length; oi++) {
            if (Number.isFinite(atk[oi])) { mean += atk[oi]; n++; }
          }
          mean = n ? mean / n : 0;
          a.score *= 1 + (this.neuroInfluence || 0) * Math.max(-1, Math.min(1, mean));
        }
        else if (a.id === 'anti-air' || a.id === 'vertical-meet') a.score *= this._neuroBias(10, 15);
        else if (a.id === 'vertical-descend') a.score *= this._neuroBias(14, 3);
        else if (a.id === 'dodge-projectile') a.score *= this._neuroBias(5);
      }
      // Directional nudge: moveLeft/moveRight outputs tilt approach/retreat
      // toward the side the network prefers when it disagrees with geometry.
      try {
        const nl = this._nnOut[0] || 0, nr = this._nnOut[1] || 0;
        const pref = nr - nl; // >0 = prefers moving right
        if (Number.isFinite(pref) && Math.abs(pref) > 0.25) {
          const wantRight = wantDir > 0;
          const agrees = (pref > 0) === wantRight;
          for (const a of actions) {
            if (a.id === 'approach') a.score *= agrees ? 1 + this.neuroInfluence * 0.25 : 1 - this.neuroInfluence * 0.15;
          }
        }
      } catch (_) {}
    }
    // Aimed intent: we want a specific attack but are out of its range —
    // close to its preferred distance instead of swinging something random.
    // This also runs through the 0.83s attack lock, so the AI keeps working
    // (approach/reposition) while waiting for the next legal swing.
    if (this.aimKey && now < this.aimUntil && P.oppRecovery === 0 && P.hDist > (this.aimDist || 90) + 20) {
      for (const a of actions) {
        if (a.id === 'approach') a.score *= 2.2;
        if (a.id === 'attack') a.score *= 0.4;
      }
    } else if (this.aimKey && now >= this.aimUntil) {
      this.aimKey = null;
    }
    // Weight by personality: movers move, aggressors press.
    for (const a of actions) {
      if (a.id === 'attack') a.score *= 0.6 + pers.attackFrequency * 0.8 + pers.aggression * 0.3;
      if (a.id === 'reposition' || a.id === 'create-distance') a.score *= 0.7 + (1 - pers.aggression) * 0.5 + 0.3;
      // §46: attack on cooldown scores ~zero, so movement/defense win the
      // tick and the AI repositions through the lock instead of queuing air.
      if (a.id === 'attack' && !P.attackReady) a.score *= 0.05;
      if (a.id === 'anti-air' && !P.attackReady) a.score *= 0.4;
    }
    actions.sort((a, b) => b.score - a.score);
    let choice = actions.length ? actions[0].id : 'reposition';
    // Difficulty mistake injection: lower levels deliberately fumble a share
    // of neutral decisions (wrong spacing, hesitant strafe) instead of
    // playing the best move. Higher levels (mistakeRate ~0) never hit this.
    if (this.mistakeRate > 0 && actions.length > 1 && Math.random() < this.mistakeRate) {
      const alt = actions[1 + ((Math.random() * (actions.length - 1)) | 0)];
      if (alt) choice = alt.id;
    }

    // Edge safety shared by all movement choices: never walk off a ledge.
    const edgeBlocked = (() => {
      if (!f.grounded) return false;
      const g = mainGround(stage);
      if (!g) return false;
      const aheadX = f.x + wantDir * 80;
      return aheadX < g.x || aheadX > g.x + g.width;
    })();

    if (choice === 'dodge-projectile' && P.incoming) {
      // §26 projectile: dash/jump/reposition off the trajectory, imperfectly.
      this.debug.state = 'dodge-projectile';
      if (Math.random() < pers.defense * 0.9 + 0.1) {
        const sideAway = (f.y <= P.incoming.y) ? -1 : 1; // vertical queen first
        if (f.dodgeCooldown <= 0 && Math.random() < 0.6) {
          this.doDodge(now, P.dx > 0 ? -1 : 1);
          this.noteAction('projectile-dash');
          this.debug.action = 'dodge-projectile';
        } else if (f.grounded && sideAway < 0 && Math.random() < 0.55) {
          this.doJump(now, 120);
          this.plan = { move: awayDir };
          this.planUntil = now + 200;
          this.noteAction('projectile-jump');
        } else {
          this.plan = { move: awayDir };
          this.planUntil = now + 200;
          this.noteAction('projectile-reposition');
        }
      } else {
        // Reaction failure: keep pressure (looks human, not perfect).
        this.plan = { move: wantDir };
        this.planUntil = now + 160;
      }
      return;
    }

    if (choice === 'anti-air' || choice === 'vertical-meet') {
      // §30 opponent above / falling onto us: uppercut, aerial, jump or slide out.
      this.debug.state = 'vertical';
      const r = Math.random();
      if (!f.grounded && Math.random() < 0.55) {
        this.chooseAndFire(now, P.hDist, P.vDist); // aerialHeavy vs above
        return;
      }
      if (f.grounded && r < 0.45) {
        if (this.chooseAndFire(now, P.hDist, P.vDist)) return; // utilt/usmash via scoring
      } else if (f.grounded && r < 0.7) {
        this.doJump(now, 130);
        this.plan = { move: P.dx > 0 ? 1 : -1 };
        this.planUntil = now + 220;
        this.noteAction('anti-air-jump');
        this.debug.action = 'jump';
        return;
      }
      this.plan = { move: Math.abs(P.hDist) < 90 ? awayDir : wantDir };
      this.planUntil = now + 180;
      this.noteAction('vertical-reposition');
      return;
    }

    if (choice === 'vertical-descend') {
      // §30 we are above: aerial, drift down onto them, or fast-fall to land.
      if (Math.random() < 0.5) {
        this.chooseAndFire(now, P.hDist, P.vDist);
        return;
      }
      if (f.vy > 30 && P.oppGrounded && Math.random() < 0.5) {
        this.setHeld('down', true);
        this.plan = { move: P.dx > 10 ? 1 : P.dx < -10 ? -1 : 0, holdDown: true };
        this.planUntil = now + 200;
        this.noteAction('fastfall-descend');
        return;
      }
      this.plan = { move: P.dx > 10 ? 1 : P.dx < -10 ? -1 : 0 };
      this.planUntil = now + 180;
      return;
    }

    if (choice === 'defend') {
      // Threat response: dash-dodge away (§23/26/31), block, or retreat+jump.
      // Imperfect: defense gate keeps mistakes in.
      if (Math.random() < pers.defense + 0.15) {
        if (f.dodgeCooldown <= 0 && Math.random() < 0.55 + pers.defense * 0.25) {
          this.debug.state = 'defense-dash';
          this.doDodge(now, Math.random() < 0.8 ? awayDir : wantDir);
          this.noteAction('defense-dash');
          this.debug.action = 'dodge-defense';
          return;
        }
        if (f.grounded && Math.random() < 0.45) {
          this.debug.state = 'block';
          this.doShield(now, 280 + Math.random() * 200);
          this.noteAction('block');
          this.debug.action = 'block';
          return;
        }
        this.debug.state = 'retreat';
        this.plan = { move: awayDir };
        this.planUntil = now + 200;
        if (f.grounded && P.hDist < 90 && Math.random() < 0.4) {
          this.doJump(now, 130);
          this.noteAction('defense-jump');
        }
        return;
      }
      // Failed to react in time — fall through to spacing below.
    }

    if (choice === 'create-distance') {
      // §25 too close: dash away / retreat / jump away, then re-engage.
      this.debug.state = 'create-distance';
      if (f.dodgeCooldown <= 0 && Math.random() < 0.45 + (1 - pers.aggression) * 0.3) {
        this.doDodge(now, awayDir); // §31 defensive dash
        this.noteAction('spacing-dash');
        this.debug.action = 'dodge-spacing';
        return;
      }
      if (f.grounded && P.hDist < 45 && Math.random() < 0.35) {
        this.doJump(now, 125);
        this.plan = { move: awayDir };
        this.planUntil = now + 220;
        this.noteAction('spacing-jump');
        return;
      }
      this.plan = { move: awayDir };
      this.planUntil = now + 200;
      this.noteAction('spacing-retreat');
      // Re-engage with the right tool once space exists (next decision).
      return;
    }

    if (choice === 'approach') {
      // §25 too far / closing: approach, with offensive dash (§31), jumps,
      // zoning, and edge safety. Dangerous approaches become baits.
      const dangerClose = P.oppAttacking && P.hDist < 260 && Math.random() < pers.defense * 0.55;
      if (dangerClose && Math.random() < 0.45) {
        this.plan = { move: 0 }; // bait: hold, then punish the whiff
        this.planUntil = now + 180;
        this.noteAction('approach-bait');
        return;
      }
      if (edgeBlocked) {
        this.plan = { move: 0 };
        this.planUntil = now + 180;
        if (P.vDist < -90 && Math.random() < 0.4) {
          this.doJump(now, 130);
          this.noteAction('approach-jump');
        }
        return;
      }
      // §31 offensive dash: close distance / chase / enter range quickly.
      if (P.hDist > 190 && P.hDist < 430 && f.dodgeCooldown <= 0 && Math.random() < 0.28 + pers.aggression * 0.25) {
        this.doDodge(now, wantDir);
        this.plan = { move: wantDir };
        this.planUntil = now + 200;
        this.noteAction('offense-dash');
        this.debug.action = 'dodge-approach';
        return;
      }
      this.plan = { move: wantDir };
      this.planUntil = now + 200;
      if (P.dist > 340 && Math.random() < 0.3) {
        if (this.chooseAndFire(now, P.hDist, P.vDist)) return; // zone with projectile
      }
      if (!f.grounded) return; // airborne steering continues
      if ((P.vDist < -90 || P.hDist > 260) && Math.random() < 0.3) {
        this.doJump(now, 130);
        this.noteAction('approach-jump');
        this.debug.action = 'jump';
        return;
      }
      return;
    }

    if (choice === 'attack') {
      // In pocket: strike, or sometimes strafe/jump to make an opening first.
      if (!f.grounded || !opp.grounded) {
        if (f.grounded && P.vDist < -70 && Math.random() < 0.45 + (rates.jumpFreq > 0.04 ? 0.2 : 0)) {
          this.doJump(now, 130);
          this.plan = { move: wantDir };
          this.planUntil = now + 220;
          this.noteAction('anti-air-jump');
          this.debug.action = 'jump';
          return;
        }
        if (!f.grounded && f.vy > 40 && P.oppGrounded && P.vDist > 120 && Math.random() < 0.3) {
          this.setHeld('down', true);
          this.noteAction('fastfall-land');
        }
      }
      // §32 deliberate pacing: well-defended opponents get repositioned on,
      // not swung on — creates openings instead of forcing attacks.
      const oppEntrenched = (opp.shielding || opp.dodging) && !P.oppVulnerable && !P.oppWhiff;
      if (oppEntrenched && Math.random() < 0.5) {
        this.strafeDir = -this.strafeDir;
        this.plan = { move: this.strafeDir };
        this.planUntil = now + 220;
        this.noteAction('strafe-opening');
        this.moveTicks++;
        return;
      }
      // Pacing now lives inside chooseAndFire (skipped on real openings).
      this.chooseAndFire(now, P.hDist, P.vDist, true);
      return;
    }

    // choice === 'reposition': constant movement even without attacking (§24).
    this.debug.state = 'reposition';
    if (now >= this.strafeUntil) { this.strafeDir = Math.random() < 0.5 ? -1 : 1; this.strafeUntil = now + 500; }
    const rr = Math.random();
    if (rr < 0.5) {
      this.plan = { move: this.strafeDir };
      this.planUntil = now + 220;
      this.noteAction('strafe');
    } else if (rr < 0.65 && f.grounded) {
      this.doJump(now, 115);
      this.plan = { move: this.strafeDir };
      this.planUntil = now + 220;
      this.noteAction('reposition-hop');
    } else if (rr < 0.75 && f.dodgeCooldown <= 0 && P.hDist > 120) {
      this.doDodge(now, this.strafeDir); // dash reposition (§31)
      this.noteAction('reposition-dash');
    } else {
      this.plan = { move: wantDir }; // drift toward pocket
      this.planUntil = now + 180;
      this.noteAction('drift-pocket');
    }
    this.moveTicks++;
  }

  // Per-frame update: age presses, run decisions at intervals, then translate
  // plan + reactive recovery steering into the held map.
  update(dt, now, stage) {
    const f = this.fighter;
    if (!f) return;
    const opp = this.opponent;
    if (!opp) {
      this.held = emptyHeld();
      return;
    }
    if (typeof now !== 'number') now = performance.now();
    this._stageHint = stage || null;

    this.agePresses(now);
    this.trackOpponent(now);

    // §29 post-attack edge: our swing just finished → stamp it so the next
    // decision repositions (follow-up vs safe distance) instead of standing.
    if (this.wasAttacking && !f.attack) {
      this.lastAttackEndedAt = now;
    }
    this.wasAttacking = !!f.attack;

    const pers = this.personality;
    const intervalMs = (pers.reactionTime || 0.16) * 1000;
    if (now - this.lastDecision >= intervalMs * (0.75 + Math.random() * 0.5)) {
      try {
        this.makeDecision(now, stage);
      } catch (e) {
        console.error('[ai] decision failed:', e);
      }
      this.lastDecision = now;
    }

    // §41 grounded stage clamp (backstop behind every decision): a grounded
    // plan that would walk off the platform is zeroed before it touches the
    // held map — edgeguard holds the edge, it never crosses it, and chases
    // die at the lip instead of becoming suicides. Airborne drift is owned
    // by recovery/center-steer decisions, never clamped here.
    if (this.plan && f.grounded && recoveryUrgency(f, stage) === 0) {
      try {
        const g = mainGround(stage);
        if (g && this.plan.move !== 0) {
          const lookX = f.x + this.plan.move * 46;
          if (lookX < g.x + 10 || lookX > g.x + g.width - 10) this.plan.move = 0;
        }
      } catch (_) {}
    }

    // Reactive per-frame steering: recovery ALWAYS holds toward the stage
    // (even between decisions) and never fights the plan otherwise.
    const urg = recoveryUrgency(f, stage);
    if (urg > 0) {
      const g = mainGround(stage);
      const targetX = g ? g.x + g.width / 2 : 600;
      const toward = targetX - f.x;
      if (!f.attack && !f.dodging) {
        this.setHeld('left', toward < -8);
        this.setHeld('right', toward > 8);
      } else {
        if (!f.grounded) {
          this.setHeld('left', toward < -8);
          this.setHeld('right', toward > 8);
        }
      }
      this.setHeld('down', false);
    } else if (this.plan && !f.attack && !f.dodging && f.hitstun <= 0) {
      if (this.plan.move > 0) {
        this.setHeld('left', false);
        this.setHeld('right', true);
      } else if (this.plan.move < 0) {
        this.setHeld('left', true);
        this.setHeld('right', false);
      } else {
        const attackHeld = this.held.attack || this.held.special;
        if (!attackHeld) {
          this.setHeld('left', false);
          this.setHeld('right', false);
        }
      }
      // Fast-fall intent from the plan (escape/land) — held only while airborne.
      if (this.plan.holdDown && !f.grounded) this.setHeld('down', true);
      else if (!this.held.attack && !this.held.special) {
        // Don't stick down otherwise (would crouch into fast-fall dives).
        if (!this.plan.holdDown) this.setHeld('down', false);
      }
    } else if (!this.plan && urg === 0 && !f.attack && !f.dodging) {
      const attackHeld = this.held.attack || this.held.special;
      if (!attackHeld && !this.held.shield) {
        this.setHeld('left', false);
        this.setHeld('right', false);
      }
    }
  }

  postFrame() {
    for (const k of BUTTONS) this.prevHeld[k] = this.held[k];
  }

  getInput() {
    // The triple is built once per controller and reused. Game.js asks for it
    // every frame for every AI fighter, and it used to allocate a fresh object
    // plus three closures each time; the closures read `held`/`prevHeld` live, so
    // one persistent triple behaves identically to a fresh one.
    if (!this._inputTriple) {
      const self = this;
      this._inputTriple = {
        isHeld: (pn, action) => {
          if (pn !== self.fighter?.playerNum) return false;
          return !!self.held[action];
        },
        isJustPressed: (pn, action) => {
          if (pn !== self.fighter?.playerNum) return false;
          return !!self.held[action] && !self.prevHeld[action];
        },
        isJustReleased: (pn, action) => {
          if (pn !== self.fighter?.playerNum) return false;
          return !self.held[action] && !!self.prevHeld[action];
        },
      };
    }
    return this._inputTriple;
  }

  getAction() {
    return this.debug.action || 'none';
  }

  getPreviousAction() {
    return this.lastActionKey || 'none';
  }

  reset(fighter, opponent) {
    if (fighter) this.fighter = fighter;
    if (opponent) this.opponent = opponent;
    this.held = emptyHeld();
    this.prevHeld = emptyHeld();
    this.plan = null;
    this.planUntil = 0;
    this.lastDecision = 0;
    this.nextDecisionAt = 0;
    this.releaseAt = {};
    this.shieldUntil = 0;
    this.lastShieldAt = -1e9;
    this.comboCount = 0;
    this.lastHitOppPercent = -1;
    this.lastOppAttackRef = null;
    this.oppPattern = [];
    this.adapt = {
      samples: 0, attackCounts: {}, rangeSum: 0, rangeN: 0,
      jumps: 0, approaches: 0, retreats: 0, blocks: 0, dodges: 0,
      recoveryDir: { left: 0, right: 0, center: 0 },
      sideHits: { left: 0, right: 0 },
      lastOppY: 0, lastOppX: 0, lastOppGrounded: true,
    };
    this._prevOppTracked = false;
    this.stuckCheck = { x: 0, y: 0, t: 0, count: 0 };
    this.lastActionKey = 'idle';
    this.repeatCount = 0;
    this.strafeDir = 1;
    this.strafeUntil = 0;
    this.lastAttackEndedAt = -1e9;
    this.wasAttacking = false;
    this.abilityUses = {};
    this.moveTicks = 0;
    this.debug = { state: 'init', action: 'none' };
    this.stats = {};
    this._stageHint = null;
    this._lastOppPercent = 0;
    this._nnOut = null;
    this.aimKey = null;
    this.aimUntil = 0;
    this.aimDist = 90;
    this.combatStats = { attacks: 0, hits: 0, _lastOppPct: -1, _lastOwnAttack: null };
    this.diag = { freqBlock: 0, gateBlock: 0, fired: 0, noScore: 0, turnFix: 0 };
    this.recentAttacks = [];
    this.lastZonerAt = -1e9;
    // NOTE: neuroNet / neuroInfluence / mistakeRate intentionally survive
    // reset(): they describe WHO the AI is (genome/difficulty), not the match.
  }

  dispose() {
    this.fighter = null;
    this.opponent = null;
    this.held = emptyHeld();
    this.prevHeld = emptyHeld();
    this.plan = null;
    this.releaseAt = {};
    this._stageHint = null;
  }
}

class AIController {
  constructor(fighter, opponent, personality, options) {
    // AIvsAI independence: when no explicit personality is given, jitter the
    // defaults per-controller so the two fighters naturally diverge (one may
    // press, the other may space) instead of mirroring each other.
    // Baselines tuned for fast action-heavy 20–50s pacing: high pressure +
    // frequent edgeguards/combos, moderate defense (hits land, KOs come).
    //
    // options: { difficulty, charId, neuroWeights, neuroInfluence,
    //            mistakeRate, genome, genomeInfluence }. `difficulty` loads the
    // real difficulty pipeline (personality + trained model when present).
    // `genome` (training) overrides everything: evolved behavior + network.
    let p = personality;
    if (!p) {
      p = {
        aggression: 0.6 + Math.random() * 0.3,
        defense: 0.35 + Math.random() * 0.3,
        reactionTime: 0.13 + Math.random() * 0.05,
        attackFrequency: 0.6 + Math.random() * 0.2,
        preferredRange: 100 + Math.random() * 35,
        minimumSafeDistance: 50 + Math.random() * 20,
        maximumEngagementDistance: 240 + Math.random() * 50,
        riskTolerance: 0.4 + Math.random() * 0.35,
        recoveryPriority: 0.9 + Math.random() * 0.1,
        edgeguardPriority: 0.6 + Math.random() * 0.3,
        comboPriority: 0.65 + Math.random() * 0.25,
      };
    }
    this.fighter = fighter;
    this.opponent = opponent;
    this.state = new AIState(fighter, opponent, p);
    this.difficulty = null;
    try {
      const opts = options || {};
      if (opts.difficulty) this.applyDifficulty(opts.difficulty, opts.charId);
      if (opts.genome) {
        this.state.setGenome(opts.genome, opts.genomeInfluence != null ? opts.genomeInfluence : 1.0);
        if (typeof opts.mistakeRate === 'number') this.state.mistakeRate = opts.mistakeRate;
      } else {
        if (Array.isArray(opts.neuroWeights)) {
          this.state.setNeuralModel(opts.neuroWeights, opts.neuroInfluence != null ? opts.neuroInfluence : 0.85);
        } else if (typeof opts.neuroInfluence === 'number') {
          this.state.neuroInfluence = Math.max(0, Math.min(1, opts.neuroInfluence));
        }
        if (typeof opts.mistakeRate === 'number') this.state.mistakeRate = opts.mistakeRate;
      }
    } catch (_) {}
  }

  applyDifficulty(name, charId) {
    this.difficulty = AI_DIFFICULTIES.includes(name) ? name : 'Normal';
    try {
      const cfg = configForDifficulty(this.difficulty, charId);
      this.state.personality = resolvePersonality({ ...this.state.personality, ...cfg.personality });
      this.state.mistakeRate = cfg.mistakeRate || 0;
      if (cfg.neuroWeights) this.state.setNeuralModel(cfg.neuroWeights, cfg.neuroInfluence);
      else this.state.neuroInfluence = cfg.neuroInfluence || 0;
    } catch (_) {}
  }

  setGenome(genome, influence) {
    try { this.state.setGenome(genome, influence != null ? influence : 1.0); } catch (_) {}
  }

  update(dtOrNow, nowOrStage, maybeStage) {
    let now;
    let stage = null;
    if (typeof dtOrNow === 'number' && typeof nowOrStage === 'number') {
      now = nowOrStage;
      stage = maybeStage || null;
    } else if (typeof dtOrNow === 'number') {
      now = dtOrNow;
      stage = nowOrStage || null;
    } else {
      now = performance.now();
    }
    this.state.update(0, now, stage);
  }

  postFrame() {
    this.state.postFrame();
  }

  getInput() {
    return this.state.getInput();
  }

  getAction() {
    return this.state.getAction();
  }

  getPreviousAction() {
    return this.state.getPreviousAction();
  }

  getDebug() {
    const cs = this.state.combatStats || { attacks: 0, hits: 0 };
    const acc = cs.attacks > 0 ? cs.hits / cs.attacks : 0;
    return {
      ...this.state.debug,
      // `hold` is a live view of this.state.held, not a stored string: building
      // the 9-conditional button glyph on every AI frame cost a string concat per
      // controller per frame, and the only reader is this probe-facing getter.
      hold: holdString(this.state.held),
      fighter: this.fighter?.playerNum ?? null,
      stats: { ...this.state.stats },
      combat: { attacks: cs.attacks, hits: cs.hits, acc: Math.round(acc * 1000) / 1000 },
      diag: { ...(this.state.diag || {}) },
    };
  }

  // Observability for tests/tuning: current scored attack list (top 6) with
  // connect chance + kind, from live state. Never affects decisions.
  debugScores() {
    try {
      const st = this.state;
      if (!st || !st.fighter || !st.opponent) return [];
      const P = buildPerception(st.fighter, st.opponent, st._stageHint);
      return st.scoreAttacks(P).slice(0, 6).map((e) => ({
        key: e.key, kind: e.kind,
        score: Math.round(e.score * 1000) / 1000,
        connect: Math.round((e.connect || 0) * 1000) / 1000,
      }));
    } catch (_) {
      return [];
    }
  }

  reset() {
    this.state.reset(this.fighter, this.opponent);
  }

  dispose() {
    this.state.dispose();
  }
}

export { AIController, AI_PARAMS, AI_DIFFICULTIES, configForDifficulty, difficultyPreset };
// Pure estimators exported for deterministic unit tests (no game state).
export { attackReach, predictOppCenter, connectChance, facingOppNow, effDefFor };
