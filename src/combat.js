import { getAnimationRaw, requestAnimation, updateAnimator, stopAnimation } from './anim.js';
import { SFX } from './assets.js';
import { resolveWorldAnchor, playShadowStrikeVFX, playSmokePoofVFX, triggerTimeDilation, emitAbilityFx, emitFlash, emitImpactRing, emitSparks, emitDustPuff, emitStreak, emitGhost, fxStyleFor, spawnFloatingText, releaseTimeDilation, spawnDamageNumber } from './fx.js';
import { spawnTempVfx, isHeld, isJustPressed, clearGrid, insertObject, queryNearby, projectilePool, hitboxPool, damageNumberPool, scratchVec2, clearTempArray, tempArray32, freezeGame, destructibleList, damageDestructible, AERIAL_LIGHT_RECOVERY_FORCE, AERIAL_LIGHT_RECOVERY_DURATION, BLOCK_COOLDOWN, DI_MAX_ANGLE, DI_WINDOW, stampAbilityCooldown, handleFighterInput, stepFighterPhysics, updateFighterState, resetAbilityCooldowns, applySoftPlayerSeparation, resolvePlatformCollision } from './physics.js';
import { notifyCinematicHit, getSkinImage, updateHandOrbit, syncHeldRotSnap } from './render.js';


// ── merged from fighter/smashCombat.js ──
// smashCombat.js — UNIFIED Smash-style combat core (authoritative).
//
// Single pipeline for EVERY hit: damage -> knockback -> angle/velocity ->
// hitstun/hitlag -> recoil -> DI. No attack bypasses it; specials feed it too.
//
// ── Weight scale ── numeric, gameplay attribute (higher = harder to launch):
//   70-89  lightweight (easy to launch, usually mobile)
//   90-110 middleweight (balanced)
//   111-130 heavyweight (hard to launch, usually slower / weaker recovery)
//   Roster: ninja 100 (mid), cowboy 100 (mid), boxer 122 (heavy).
//   Weight NEVER changes damage dealt — only launch taken (plus momentum feel).
//
// ── Coordinate convention ── canvas Y grows DOWNWARD. Launch angle in degrees:
//   0 = straight forward (horizontal), + = up, - = down.
//   LaunchX = KB * cos(angle) * hitDir   (hitDir = away-from-attacker, +/-1)
//   LaunchY = -KB * sin(angle)           (positive angle launches upward)
//
// ── Final knockback formula ──
//   P  = target percent AFTER this hit's damage (landed)
//   D  = damage dealt by this hit
//   DS = damageScaling(P, D) = 1 + 3.2 * (P / (P + 90)) + D * 0.04
//        At P=0,D=5: ~1.2 · P=60: ~2.5 · P=150: ~3.2 · asymptotes ~4.2+D-term.
//        Smooth, bounded, diminishing returns — never exponential.
//   WScale = weightScaling(W) = clamp((100 / W) ^ 0.85, 0.70, 1.35)
//        W=100 -> 1.0 · W=122 -> ~0.85. Smooth, no jumps.
//   KB = (BKB + KBG * DS * KB_SCALE) * WScale * AttackMult * ChargeMult * GlobalMult
//        BKB = base knockback (initial launch), KBG = knockback growth (scaling).
//        KB_SCALE = 90, GlobalMult = COMBAT_CONFIG.globalKnockback (1.0).
//        AttackMult = def.launchMultiplier * charMod · ChargeMult = smash charge.
//        Clamped to [KB_MIN=40, KB_MAX=1650], NaN/negative-safe (floor at min
//        only when base intent > 0; true zero-damage moves deal no launch).
//
// ── Hitstun ── HS = clamp(HS_BASE + KB * HS_PER_KB, HS_MIN, HS_MAX) * hitstunMult
//   HS_BASE=0.12, HS_PER_KB=0.0011, MIN=0.12, MAX=1.15. Stronger hits stun longer.
//   Disabled actions: move/jump/dodge/attack/up-special/aerial-recovery. Ends by
//   timer; landing clears launch but hitstun itself only expires. New hits replace it.
// ── Hitlag ── HL = clamp(HL_BASE + D*HL_PER_DMG + KB*HL_PER_KB, HL_MIN, HL_MAX)
//   * hitlagMult. BASE=0.02, PER_DMG=0.004, PER_KB=0.00004, MIN=0.02, MAX=0.12.
//   Freezes attacker + target (physics/anim/particles/inputs/AI all pause — the
//   freeze is global via freezeGame, so nothing desyncs, no duplicate hits).
// ── Recoil ── per-attack {x,y} impulse to ATTACKER only, applied once at
//   active/recovery entry. Never scaled by victim weight/percent.
// ── DI ── during DI_WINDOW=0.45s after launch, held direction rotates velocity
//   toward held bearing, budget DI_MAX_ANGLE=0.32rad (~18°), rate 1.7rad/s,
//   speed preserved. Sampled continuously from held keys (keyboard/AI/mobile
//   identical). Cannot cancel knockback — bends only.

export const COMBAT_CONFIG = {
  globalDamage: 1.0,
  globalKnockback: 0.75, // -25% total launch on every path (standard +
                         // fixedKnockback); tables, curve, weight, angles untouched
  kbScale: 90,            // KB_SCALE above (px/s per growth unit)
  kbMin: 40,
  kbMax: 1650,            // safety ceiling (soft-cap shapes curve; this stops breaks)
  damageSoftCap: 90,      // P/(P+90) half-point
  damageGrowth: 3.2,      // asymptote weight of percent term
  damageDealtFactor: 0.04,
  weightRef: 100,
  weightPower: 0.85,
  weightMin: 0.70,
  weightMax: 1.35,
  hitstunBase: 0.12,
  hitstunPerKB: 0.0011, // strong launches stun through the arc (KB800 -> ~1.0s)
  hitstunMin: 0.12,
  hitstunMax: 1.15,
  hitlagBase: 0.02,
  hitlagPerDmg: 0.004,
  hitlagPerKB: 0.00004,
  hitlagMin: 0.02,
  hitlagMax: 0.12,
  diMaxAngle: 0.32,       // rad total budget per launch
  diWindow: 0.45,         // seconds
  diRate: 1.7,            // rad/s spend rate
  smashChargeMaxTime: 1.2, // seconds hold for full charge
  smashChargeBonus: 0.5,   // +50% damage/KB at full charge (mult 1.0->1.5)
  smashChargeMaxMult: 1.5,
  shieldDamageMul: 0.1,
  shieldKbMul: 0.08,
};

export const WEIGHT_SCALE_DOC = {
  min: 70, lightMax: 89, midMax: 110, max: 130,
  reference: 100,
  describe(w) {
    if (w <= 89) return 'lightweight';
    if (w <= 110) return 'middleweight';
    return 'heavyweight';
  },
};

// ── Central character stats (weight + movement/physics identity) ──
export const CHARACTER_STATS = {
  cowboy: {
    id: 'cowboy', weight: 100, runSpeed: 71, airSpeed: 58,
    accel: 2100, friction: 840, airAccel: 840, airFriction: 300,
    jumpForce: 712, gravityMul: 1.0, fallMaxMul: 1.0, airControl: 1.0,
    launchResist: 1.0, recoveryStrength: 1.0, recoveryRange: 1.0,
    damageDealtMul: 1.0, knockbackDealtMul: 1.0,
  },
  ninja: {
    id: 'ninja', weight: 100, runSpeed: 83, airSpeed: 66,
    accel: 2300, friction: 780, airAccel: 980, airFriction: 260,
    jumpForce: 750, gravityMul: 1.0, fallMaxMul: 1.0, airControl: 1.15,
    launchResist: 1.0, recoveryStrength: 1.1, recoveryRange: 1.2,
    damageDealtMul: 1.0, knockbackDealtMul: 1.0,
  },
  boxer: {
    id: 'boxer', weight: 122, runSpeed: 63, airSpeed: 52,
    accel: 1900, friction: 950, airAccel: 720, airFriction: 340,
    jumpForce: 690, gravityMul: 1.05, fallMaxMul: 1.0, airControl: 0.9,
    launchResist: 1.0, recoveryStrength: 0.85, recoveryRange: 0.85,
    damageDealtMul: 1.0, knockbackDealtMul: 1.0,
  },
};

// ── Attack schema defaults ──
export const ATTACK_DEFAULTS = {
  category: 'jab', direction: 'neutral', state: 'ground',
  baseDamage: 0, baseKnockback: 0, knockbackGrowth: 0,
  launchAngle: 0, startup: 3, active: 5, recovery: 10,
  hitlagMult: 1, hitstunMult: 1, chargeable: false, chargeScale: 1,
  multiHit: false, hits: 1, hitInterval: 0,
  armor: 0, recoilX: 0, recoilY: 0, recoilDuration: 0,
  launchMultiplier: 1, damageMultiplier: 1,
  cooldown: 0, usableInAir: false, usableDuringHitstun: false,
};

const VALID_CATEGORIES = new Set(['jab', 'tilt', 'smash', 'aerial', 'dash', 'special']);
const VALID_DIRECTIONS = new Set(['neutral', 'forward', 'backward', 'up', 'down']);

export function normalizeAttack(id, charId, raw) {
  const d = { ...ATTACK_DEFAULTS, ...(raw || {}) };
  d.id = id; d.charId = charId;
  if (!VALID_CATEGORIES.has(d.category)) d.category = ATTACK_DEFAULTS.category;
  if (!VALID_DIRECTIONS.has(d.direction)) d.direction = 'neutral';
  // Backwards-compat: legacy fields map onto canonical ones (single read path).
  if (d.baseDamage == null || d.baseDamage === 0) d.baseDamage = raw.dmg || 0;
  if (d.baseKnockback == null || d.baseKnockback === 0) d.baseKnockback = raw.kbBase || 0;
  if (d.knockbackGrowth == null || d.knockbackGrowth === 0) d.knockbackGrowth = raw.kbGrowth || 0;
  if ((d.launchAngle == null || d.launchAngle === 0) && raw.launchAngle == null) d.launchAngle = raw.angle || 0;
  else if (raw.launchAngle != null && d.launchAngle === 0 && !('launchAngle' in (raw || {}))) d.launchAngle = raw.angle || 0;
  if (raw.launchAngle != null) d.launchAngle = raw.launchAngle;
  else if (raw.angle != null && (d.launchAngle === 0)) d.launchAngle = raw.angle;
  if (raw.recoveryX != null) d.recoilX = d.recoilX || raw.recoveryX;
  if (raw.recoveryY != null) d.recoilY = d.recoilY || raw.recoveryY;
  if (raw.recoveryDuration != null) d.recoilDuration = d.recoilDuration || raw.recoveryDuration;
  if (raw.launchMultiplier != null) d.launchMultiplier = raw.launchMultiplier;
  if (raw.hitstunMultiplier != null) d.hitstunMult = raw.hitstunMultiplier;
  if (raw.hitlagMultiplier != null) d.hitlagMult = raw.hitlagMultiplier;
  if (raw.dmg != null) d.baseDamage = raw.dmg;
  if (raw.kbBase != null) d.baseKnockback = raw.kbBase;
  if (raw.kbGrowth != null) d.knockbackGrowth = raw.kbGrowth;
  d.startup = Math.max(0, d.startup | 0);
  d.active = Math.max(0, d.active | 0);
  d.recovery = Math.max(0, d.recovery | 0);
  return d;
}

// ── Directional input classification ──
// Priority: up > down > side > neutral. Fresh press (<250ms) beats stale hold;
// a direction held purely for movement longer than grace does NOT force a
// directional smash — the attack button must fall within the intent window.
// Diagonal: most-recently-pressed axis wins (vertical bias only on true ties).
// Keyboard + AI synthetic + mobile all feed {up,down,left,right} booleans plus
// optional pressedAt timestamps, so classification is identical everywhere.
export const INPUT_CLASSIFY = { freshMs: 250, heldGraceMs: 250 };

export function classifyDirection(dirs, meta) {
  const d = dirs || {};
  const now = (meta && meta.now) || 0;
  const pressedAt = (meta && meta.pressedAt) || {};
  const fresh = (k) => {
    const t = pressedAt[k];
    return typeof t === 'number' && now - t <= INPUT_CLASSIFY.freshMs;
  };
  const held = (k) => !!d[k];
  const upHeld = held('up'), downHeld = held('down');
  const leftHeld = held('left'), rightHeld = held('right');
  const sideHeld = leftHeld || rightHeld;
  // Fresh-press priority decides diagonals deterministically.
  if (upHeld || downHeld) {
    const upF = upHeld && fresh('up'), downF = downHeld && fresh('down');
    if (upF && downF) return (pressedAt.up >= pressedAt.down) ? 'up' : 'down';
    if (upF) return 'up';
    if (downF) return 'down';
    // Both stale-held: vertical still wins over side (explicit tilt intent),
    // up preferred only if it is the sole vertical hold.
    if (upHeld && !downHeld) return 'up';
    if (downHeld && !upHeld) return 'down';
  }
  if (sideHeld) return 'side';
  if (upHeld) return 'up';
  if (downHeld) return 'down';
  return 'neutral';
}

// Map (button, direction-class, grounded, dashing) -> attack key.
export function classifyAttack({ light, heavy, dirClass, grounded, dashing, facingRight, dirs }) {
  if (!light && !heavy) return null;
  const btn = light ? 'J' : 'K'; // J = light, K = heavy(smash)/aerial-heavy
  if (!grounded) return light ? 'aerialLight' : 'aerialHeavy';
  if (dashing) return 'dash';
  if (dirClass === 'up') return light ? 'utilt' : 'usmash';
  if (dirClass === 'down') return light ? 'dtilt' : 'dsmash';
  if (dirClass === 'side') {
    // Forward vs backward both map to side variants (facing-relative).
    const fwd = facingRight ? dirs?.right : dirs?.left;
    const back = facingRight ? dirs?.left : dirs?.right;
    void fwd; void back;
    return light ? 'ftilt' : 'fsmash';
  }
  // Neutral: J -> jab, K grounded -> neutral smash (all grounded K are smash).
  return light ? 'jab' : 'nsmash';
}

export function isSmashKey(key) {
  return key === 'nsmash' || key === 'fsmash' || key === 'usmash' || key === 'dsmash';
}

// ── Smash charging ── hold grounded K to charge (max 1.2s, mult 1.0->1.5).
export function chargeMultiplier(holdSeconds) {
  const t = Math.max(0, Math.min(COMBAT_CONFIG.smashChargeMaxTime, holdSeconds || 0));
  const m = 1 + COMBAT_CONFIG.smashChargeBonus * (t / COMBAT_CONFIG.smashChargeMaxTime);
  return Math.min(COMBAT_CONFIG.smashChargeMaxMult, m);
}

// ── Core math (pure, single implementation) ──
export function effectiveWeight(target, def) {
  const w = target?._fighterDef?.weight ?? target?.weight ?? COMBAT_CONFIG.weightRef;
  const base = (typeof w === 'number' && w >= 70 && w <= 130) ? w : COMBAT_CONFIG.weightRef;
  const infl = (def && typeof def.weightInfluence === 'number') ? def.weightInfluence : 1;
  const effW = COMBAT_CONFIG.weightRef + (base - COMBAT_CONFIG.weightRef) * infl;
  const resist = (target && Number.isFinite(target.launchResist) && target.launchResist > 0) ? target.launchResist : 1;
  return Math.max(40, effW * resist);
}

export function weightScaling(weight) {
  const w = (typeof weight === 'number' && weight > 0) ? weight : COMBAT_CONFIG.weightRef;
  const s = Math.pow(COMBAT_CONFIG.weightRef / w, COMBAT_CONFIG.weightPower);
  if (!Number.isFinite(s)) return 1;
  return Math.max(COMBAT_CONFIG.weightMin, Math.min(COMBAT_CONFIG.weightMax, s));
}

export function damageScaling(percentAfter, damageDealt) {
  const P = Math.max(0, percentAfter || 0);
  const D = Math.max(0, damageDealt || 0);
  const C = COMBAT_CONFIG.damageSoftCap;
  const ds = 1 + COMBAT_CONFIG.damageGrowth * (P / (P + C)) + D * COMBAT_CONFIG.damageDealtFactor;
  return Number.isFinite(ds) ? ds : 1;
}

// Central damage: base * char/damage mults * global * charge. Returns landed dmg.
export function computeDamage(attacker, def, chargeMult = 1) {
  const n = normalizeAttack(def?.id || 'hit', attacker?._fighterDef?.id || '?', def);
  const charMul = attacker?._fighterDef?.damageDealtMul ?? 1;
  const dmg = (n.baseDamage || 0) * (n.damageMultiplier || 1) * (charMul || 1)
    * COMBAT_CONFIG.globalDamage * (chargeMult || 1);
  if (!Number.isFinite(dmg) || dmg <= 0) return 0;
  return dmg;
}

// Central knockback magnitude. percentAfter includes this hit's damage.
export function computeKnockback({ percentAfter, damageDealt, baseKnockback, knockbackGrowth, targetWeight: w, attackMultiplier = 1, chargeMult = 1 }) {
  const BKB = Math.max(0, baseKnockback || 0);
  const KBG = Math.max(0, knockbackGrowth || 0);
  if (BKB <= 0 && KBG <= 0) return 0;
  const DS = damageScaling(percentAfter, damageDealt);
  const WS = weightScaling(w);
  let kb = (BKB + KBG * DS * COMBAT_CONFIG.kbScale) * WS
    * (attackMultiplier || 1) * (chargeMult || 1) * COMBAT_CONFIG.globalKnockback;
  if (!Number.isFinite(kb) || kb < 0) kb = 0;
  if (kb > 0) kb = Math.max(COMBAT_CONFIG.kbMin, Math.min(COMBAT_CONFIG.kbMax, kb));
  return kb;
}

export function resolveAttackAngleDeg(def, opts, target) {
  const raw = (opts && opts.angle != null) ? opts.angle
    : (def.launchAngle != null ? def.launchAngle : def.angle);
  if ((def && def.angleType === 'sakurai') || raw === 361) {
    const grounded = !!(target && target.grounded);
    const gA = (def && def.sakuraiGroundAngle != null) ? def.sakuraiGroundAngle : 40;
    const aA = (def && def.sakuraiAirAngle != null) ? def.sakuraiAirAngle : 45;
    return grounded ? gA : aA;
  }
  const a = Number(raw) || 0;
  return Math.max(-90, Math.min(90, a));
}

// angleDeg: 0 fwd, +up. hitDir +/-1 (away from attacker).
export function launchVelocity(kb, angleDeg, hitDir) {
  const rad = (angleDeg || 0) * Math.PI / 180;
  const dir = hitDir >= 0 ? 1 : -1;
  return { vx: Math.cos(rad) * kb * dir, vy: -Math.sin(rad) * kb };
}

export function computeHitstun(kb, hitstunMult = 1) {
  let hs = COMBAT_CONFIG.hitstunBase + Math.max(0, kb) * COMBAT_CONFIG.hitstunPerKB;
  hs *= (hitstunMult || 1);
  if (!Number.isFinite(hs)) hs = COMBAT_CONFIG.hitstunBase;
  return Math.max(COMBAT_CONFIG.hitstunMin, Math.min(COMBAT_CONFIG.hitstunMax, hs));
}

export function computeHitlag(damageDealt, kb, hitlagMult = 1) {
  let hl = COMBAT_CONFIG.hitlagBase + Math.max(0, damageDealt) * COMBAT_CONFIG.hitlagPerDmg
    + Math.max(0, kb) * COMBAT_CONFIG.hitlagPerKB;
  hl *= (hitlagMult || 1);
  if (!Number.isFinite(hl)) hl = COMBAT_CONFIG.hitlagBase;
  return Math.max(COMBAT_CONFIG.hitlagMin, Math.min(COMBAT_CONFIG.hitlagMax, hl));
}

// Full per-hit pipeline result (pure except no side effects).
export function resolveHit({ attacker, target, def, hitDir = 1, shielded = false, chargeMult = 1 }) {
  const n = normalizeAttack(def?.id || def?.name || 'hit', attacker?._fighterDef?.id, def);
  let dmg = computeDamage(attacker, { ...def, ...n }, chargeMult);
  let kbMul = shielded ? COMBAT_CONFIG.shieldKbMul : 1;
  if (shielded) dmg *= COMBAT_CONFIG.shieldDamageMul;
  const percentAfter = Math.max(0, (target.percent || 0) + dmg);
  const w = effectiveWeight(target, def);
  const charKb = attacker?._fighterDef?.knockbackDealtMul ?? 1;
  let kb;
  if (def && def.fixedKnockback != null && def.fixedKnockback >= 0) {
    kb = Math.max(0, def.fixedKnockback) * kbMul * (n.launchMultiplier || 1) * COMBAT_CONFIG.globalKnockback;
    kb = Math.min(COMBAT_CONFIG.kbMax, kb);
  } else {
    kb = computeKnockback({
      percentAfter, damageDealt: dmg,
      baseKnockback: n.baseKnockback, knockbackGrowth: n.knockbackGrowth,
      targetWeight: w, attackMultiplier: (n.launchMultiplier || 1) * (charKb || 1),
      chargeMult: shielded ? 1 : chargeMult,
    });
    kb *= kbMul;
  }
  const angle = resolveAttackAngleDeg({ ...def, launchAngle: n.launchAngle }, { angle: def.angle }, target);
  let { vx, vy } = launchVelocity(kb, angle, hitDir);
  if (Number.isFinite(def.vyScale)) vy *= def.vyScale;
  if (def.spike) vx *= 0.55;
  const hitstun = computeHitstun(kb, n.hitstunMult ?? def.hitstunMultiplier ?? 1);
  const hitlag = computeHitlag(dmg, kb, n.hitlagMult ?? def.hitlagMultiplier ?? 1);
  return { damage: dmg, percentAfter, knockback: kb, vx, vy, angle, hitstun, hitlag, weight: w };
}


// ── merged from fighter/hitboxData.js ──
// ── Per-character, per-move hitbox store ─────────────────────────────────
// The Hitbox Customizer's source of truth. Stored keyed by character → move,
// so `Cowboy → Dash` never touches `Cowboy → Neutral Light` or any other
// character's Dash. combat.resolveAnimDef reads this at every attack start
// (via getCustomHitboxes) so a saved box overrides the DEFAULT_ATTACKS
// fallback in the real game — there is no separate preview-only database.
//
// A move whose key is PRESENT in the store owns its hitbox data completely,
// even when the stored list is empty ([] = "this move deliberately has no
// hitbox"). A move with NO entry falls through to the base/default def.
//
// The hitbox shape is the same canonical object the animation combat data
// uses: { w, h, ox, oy, startFrame, duration, dmg, kbBase, kbGrowth, angle,
// launchAngle, horizontalKnockback, verticalKnockback }.
// `ox`/`oy` are offsets from the fighter center and mirror with facing.
// Launch direction is per-attack (launchAngle authoritative, angle alias).

export const HITBOX_STORE_KEY = 'smashfighters.hitboxes.v1';

let _store = null; // { [charId]: { [moveKey]: [hitbox, ...] } }

function loadStore() {
  if (_store) return _store;
  _store = {};
  try {
    const raw = localStorage.getItem(HITBOX_STORE_KEY);
    if (!raw) return _store;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') _store = parsed;
  } catch (_) {}
  return _store;
}

function saveStore() {
  try { localStorage.setItem(HITBOX_STORE_KEY, JSON.stringify(_store)); } catch (_) {}
}

function moveKey(animId) {
  return String(animId || '').trim();
}

// Live editable array for the entry (creates it when absent). Returns the
// actual stored array — the customizer edits it in place then calls
// saveHitboxEntry to persist.
function entryFor(charId, animId) {
  if (!charId || !animId) return null;
  const s = loadStore();
  if (!s[charId]) s[charId] = {};
  if (!Array.isArray(s[charId][animId])) s[charId][animId] = [];
  return s[charId][animId];
}

// A saved copy of the hitboxes for this character+move, or null when the move
// has no custom entry at all. The parsed copy is cached per store version so
// hot paths (attack start + every AI scoring candidate) never pay a JSON
// clone per call. Consumers (mergeHitboxDef) copy each box before mutating,
// so sharing the cached array is safe; the cache is dropped on any write.
// Missing entries are cached as a null marker to avoid repeated lookups.
//
// The cache is a NESTED map (charId -> moveKey -> array|null) rather than one
// flat map keyed by a concatenated string. The old `charId + '|' + moveKey`
// key built a fresh string on every lookup — and this runs once per candidate
// attack key per AI decision, i.e. hundreds of times a second — then hashed it
// twice (a `has` plus a `get`). Two map hops on interned strings, no
// allocation, one hash per level.
let _customCache = new Map();
function _charCache(charId) {
  let c = _customCache.get(charId);
  if (!c) { c = new Map(); _customCache.set(charId, c); }
  return c;
}
function _invalidateCustomCache(charId) {
  if (!charId) { _customCache = new Map(); return; }
  _customCache.delete(charId);
}
export function getCustomHitboxes(charId, animId) {
  if (!charId || !animId) return null;
  const c = _customCache.get(charId);
  if (c !== undefined) {
    const hit = c.get(animId);
    if (hit !== undefined) return hit;
  }
  const s = loadStore();
  const byMove = s[charId];
  const value = (!byMove || !(animId in byMove)) ? null : JSON.parse(JSON.stringify(byMove[animId]));
  const cc = _charCache(charId);
  // Bound the cache: the roster is tiny, but a test harness can probe many keys.
  if (cc.size > 512) cc.clear();
  cc.set(animId, value);
  return value;
}

// True when this character+move has its own custom entry (even an empty one).
export function hasCustomHitboxes(charId, animId) {
  if (!charId || !animId) return false;
  const s = loadStore();
  return !!(s[charId] && (animId in s[charId]));
}

// Persist hitboxes for one character+move. `hbs` may be [] to mean "this move
// has no hitbox". Idempotent — repeated saves lay over the same key.
export function setCustomHitboxes(charId, animId, hbs) {
  const mk = moveKey(animId);
  if (!charId || !mk) return;
  const arr = entryFor(charId, mk);
  arr.length = 0;
  for (const hb of (hbs || [])) {
    arr.push(hb == null ? null : { ...hb });
  }
  _invalidateCustomCache(charId);
  saveStore();
}

// Forget one move's custom entry (back to the default/fallback hitbox).
export function clearCustomHitboxes(charId, animId) {
  const mk = moveKey(animId);
  if (!charId || !mk) return;
  const s = loadStore();
  if (s[charId] && (mk in s[charId])) {
    delete s[charId][mk];
    _invalidateCustomCache(charId);
    saveStore();
  }
}

// Forget everything a character saved (keeps other characters' data).
export function clearCharacterHitboxes(charId) {
  const s = loadStore();
  if (s[charId]) {
    delete s[charId];
    _invalidateCustomCache(charId);
    saveStore();
  }
}

// Whole-store reset (used by the test harness / a future "reset all" button).
export function resetHitboxStore() {
  _store = {};
  _customCache = new Map();
  try { localStorage.removeItem(HITBOX_STORE_KEY); } catch (_) {}
}

export function hitboxStoreToJSON() {
  return JSON.stringify(loadStore());
}

// Import a whole store snapshot (test harness / backup restore).
export function importHitboxStore(json) {
  try {
    const parsed = JSON.parse(json);
    if (parsed && typeof parsed === 'object') {
      _store = parsed;
      _customCache = new Map();
      saveStore();
      return true;
    }
  } catch (_) {}
  return false;
}


// ── merged from fighter/abilities.js ──
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
// Balance (unified Smash refactor): values authored for smashCombat.js. launchAngle authoritative per attack (angle kept as alias).
const HORSE_PRESET = {
  sprite: '/GA/weapons/cowboyhorse.png',
  drawW: 144,
  drawH: 96,
  back: 0.30,   // saddle height above the horse's center, as a fraction of drawH
  fx: 16,       // horse center ahead of the rider's center, in the facing direction
  speed: 137,   // 228 Ã— 0.60 (Â§46) forward ride speed while mounted
  hitbox: {
    name: 'Horse Ride',
    dmg: 15.0,
    kbBase: 300,
    kbGrowth: 1.75,
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

// â”€â”€ Boxer: the Grab, the Depsey Roll, the Straight Right â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// The boxer's three signature moves. All three follow the same split as the
// Teleport Strike: the ability owns WHAT happens and hands the frame stepping to
// combat.js, because abilities.js must never import combat.js.
//
//   Grab (Down Light)  â€” a reach, a hold, then a punch that sends the target
//                        away. `run()` only finds the target and announces the
//                        move; combat.js owns the hold and applies the punch
//                        through the shared deliverHit path.
//   Depsey Roll (Down Heavy) - a self-buff: faster movement, longer and
//                        farther dodges with more i-frames and ghost
//                        afterimages, faster attacks and faster cooldowns.
//                        run() only stamps the buff record.
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
  // Unified-pipeline values (see BOXER_ATTACKS), and the
  // launch is a flat outward send â€” the grab's whole point is that the target
  // leaves, not that it spikes.
  punch: {
    name: 'Grab Punch',
    dmg: 12.0,
    kbBase: 210,
    kbGrowth: 1.25,
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

// ── Depsey Roll (boxer Down Heavy) tuning ───────────────────────────────
// A self-buff, not an attack: for `duration` seconds the boxer moves faster,
// dashes farther, dodges longer with more i-frames and a ghost trail, starts
// attacks sooner (shorter attack lock) and cools abilities down faster. The
// record carries its own multipliers so readers (Fighter movement/dodge,
// combat attack pacing) need no import back into this module.
const BOXER_ROLL = {
  duration: 6.0,
  speedMul: 2.0,     // run/air/recovery drift via moveSpeedScale
  dashMul: 1.4,      // dodge-burst velocity (and therefore distance)
  dodgeTime: 0.35,   // dodge active window (ground + air)
  dodgeIframes: 0.3, // invulnerability on dodge start
  attackHaste: 0.55, // attack-start lock multiplier (faster attacks)
  cdRate: 2.0,       // ability-cooldown decay multiplier
};

// The roll's cooldown, in seconds. It outlasts the buff itself so the move
// can never be re-armed while a roll is still running. combat.js owns the
// gate and stamps the timer at the cast, so an interrupted cast costs nothing
// (see abilityCooldownFor).
const BOXER_ROLL_COOLDOWN = 6.5;

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
          dmg: 15.0,
          kbBase: 310,
          kbGrowth: 1.8,
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
        bulletDamage: cfg && cfg.bulletDamage != null ? cfg.bulletDamage : 4.5,
        bulletKBBase: cfg && cfg.bulletKBBase != null ? cfg.bulletKBBase : 130,
        bulletKBGrowth: cfg && cfg.bulletKBGrowth != null ? cfg.bulletKBGrowth : 0.7,
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
          dmg: (cfg && cfg.dmg) || 8.0,
          kbBase: (cfg && cfg.kbBase) || 170,
          kbGrowth: 1.0,
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
      // fx.js) is spawned here â€” the single call that arms it â€” and
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
      // converted in fx.js), pinned to the activation spot and living
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
          const hi = (bz.right != null ? bz.right : 1080) - r;
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
        tx = Math.max(r, Math.min(1080 - r, tx));
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
      // registers no strike box of its own, so there is nothing to suppress —
      // the move simply reaches at nothing and recovers.
      if (!target) return;
      // Depsey Roll autododge works on grabs too: a charged target phases out
      // of the catch (no hold, no punch), costing one dodge charge.
      {
        const gr = target._boxerRoll;
        if (gr && gr.timeLeft > 0 && gr.dodgesLeft > 0) {
          gr.dodgesLeft--;
          const gdir = target.x < fighter.x ? -1 : 1;
          target.x = Math.max(40, Math.min(1160, target.x + gdir * 26));
          target.vx = gdir * 120;
          target.invulnTimer = Math.max(target.invulnTimer || 0, 0.3);
          try { emitGhost(target); } catch (_) {}
          try { emitGhost(target); } catch (_) {}
          try { SFX.depseyDodge(); } catch (_) {}
          return;
        }
      }
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
      SFX.boxerGrab();
    },
  },

  // â”€â”€ The Depsey Roll (boxer Down Heavy) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // A self-buff: stamps the Depsey Roll record (faster movement, longer and
  // farther dodges with more i-frames, faster attacks, faster cooldowns) and
  // announces it with floating text. No teleport, no target needed.
  boxerDsmash: {
    name: 'Depsey Roll',
    frames: 24,
    castFrame: 1,
    cooldown: BOXER_ROLL_COOLDOWN,
    run(fighter, atk, cfg, ctx) {
      // Self-buff: no teleport, no target needed. Stamps the roll record
      // (multipliers included, so no reader imports back here), announces it
      // in words, and plays the buff sting. A live roll cannot be
      // re-armed — the cooldown outlasts the buff, and this guard covers any
      // path that reaches the cast anyway.
      if (fighter._boxerRoll && fighter._boxerRoll.timeLeft > 0) return;
      const R = BOXER_ROLL;
      fighter._boxerRoll = {
        timeLeft: (cfg && cfg.duration) || R.duration,
        duration: (cfg && cfg.duration) || R.duration,
        dodgesLeft: (cfg && cfg.dodges) || 5,
        speedMul: (cfg && cfg.speedMul) || R.speedMul,
        dashMul: (cfg && cfg.dashMul) || R.dashMul,
        dodgeTime: (cfg && cfg.dodgeTime) || R.dodgeTime,
        dodgeIframes: (cfg && cfg.dodgeIframes) || R.dodgeIframes,
        attackHaste: (cfg && cfg.attackHaste) || R.attackHaste,
        cdRate: (cfg && cfg.cdRate) || R.cdRate,
      };
      const r = fighter.radius || 22;
      spawnFloatingText(
        fighter.x,
        fighter.y - r - 34,
        'DEPSEY ROLL',
        '#00ff73',
        { life: 1.2, size: 24 }
      );
      // Unmissable arm cue: green ring + flash + triple ghost, so a live
      // roll (and its 5 autododges) always reads the instant it starts.
      try {
        const style = fxStyleFor(fighter);
        emitImpactRing(fighter.x, fighter.y, {
          style, wave: true, radius: r * 0.6, growth: r * 2.6,
          life: 0.35, alpha: 0.8, color: '#00ff73',
        });
        emitFlash(fighter.x, fighter.y, {
          style, radius: r * 0.7, life: 0.12, alpha: 0.8, color: '#d6ffe2',
        });
        emitGhost(fighter);
        emitGhost(fighter);
        emitGhost(fighter);
      } catch (_) {}
      SFX.buff();
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

  // Shield Counter (knight Neutral Heavy, GA/vfx/shieldcounter.html): a rooted
  // counter stance. The cast plants the stance window; any hit taken while it
  // is live is negated and answered with an answering slash through the shared
  // deliverHit (see tryKnightCounter in combat.js). Unanswered, the stance
  // simply expires into the move's recovery. The 6s cooldown stamps at the
  // cast via the shared runAbility gate, so stances can't chain.
  knightShieldCounter: {
    name: 'Shield Counter',
    // startup 4 + active 26 + recovery 15 from KNIGHT_ATTACKS.nsmash.
    frames: 45,
    castFrame: 2,
    cooldown: 6,
    run(fighter, atk, cfg) {
      fighter._knightCounter = 0.45;
      const r = fighter.radius || 22;
      const style = fxStyleFor(fighter);
      // Stance shimmer: faint gold guard light while the window is live (the
      // full counter art fires on the answer, in combat.js).
      emitFlash(fighter.x, fighter.y - r * 0.3, {
        style, radius: r * 0.9, life: 0.2, alpha: 0.4, color: '#ffe9a3',
      });
      SFX.draw();
    },
  },

  // Shield Bash (knight Down Light): a quick forward shield push for close
  // ground approaches and defensive counterattacks. `strikeHitbox` hands the
  // table row's melee box to the shared registry on the cast frame, so
  // damage/launch/hitstun resolve through deliverHit like every other swing —
  // the ability adds only the short step-in, the shield flash, and the sound.
  // No cooldown of its own: the 12-frame recovery plus the shared attack lock
  // are the cost.
  knightShieldBash: {
    name: 'Shield Bash',
    // startup 5 + active 4 + recovery 12 from KNIGHT_ATTACKS.dtilt.
    frames: 21,
    castFrame: 2,
    strikeHitbox: true,
    run(fighter, atk, cfg) {
      const dir = atk.facing || (fighter.facingRight ? 1 : -1);
      const r = fighter.radius || 22;
      // Short step-in: a grounded shove, not a dash — ground friction eats it
      // within a few frames, so the bash reaches without carrying.
      if (fighter.grounded) fighter.vx = dir * 320;
      else fighter.vx = dir * 200;
      const style = fxStyleFor(fighter);
      const x = fighter.x + dir * r * 1.1;
      const y = fighter.y - 4;
      // Shield Bash impact art (GA/vfx/shieldbash.html): blue arc burst off
      // the shield face, pooled and weapon-anchored through the shared temp
      // VFX path — plus speed lines trailing behind the user for the push.
      // The dash streak and dust below stay as the push read.
      spawnTempVfx(fighter, 'knightBash', 0.45, 1, 0, 0, 0, {
        anchor: 'character', offsetX: dir * r * 1.1, offsetY: -4, mirrorX: dir,
      });
      spawnTempVfx(fighter, 'knightSpeedLines', 0.15, 1, 0, 0, 0, {
        anchor: 'character', mirrorX: dir,
      });
      emitFlash(x, y, { style, radius: r * 0.45, life: 0.08, alpha: 0.7, color: '#dfe9f2' });
      emitStreak(x, y, dir, 0, { style, length: r * 1.4, width: 3, life: 0.1, alpha: 0.5 });
      emitDustPuff(fighter.x - dir * r * 0.4, fighter.y + r * 0.7, 3, {
        style, dir: dir >= 0 ? Math.PI : 0, spread: 0.9, speed: 110,
        size: r * 0.12, life: 0.22, gravity: 60, alpha: 0.3,
      });
      SFX.shieldBash();
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


// ── merged from fighter/combat.js ──
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
const HITSTUN_CAP = 1.25; // raised for launch arcs (was 1.05)   // Â§45 combo-compat: must exceed ATTACK_DELAY (0.83)
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
// Optional per-move launch tuning (all neutral when absent - existing moves
// behave exactly as before, retune here without touching the physics code):
//   fixedKnockback  - flat launch strength, skips percent/weight scaling
//   launchMultiplier - scales the final launch of this move only
//   hitstunMultiplier - stretches/shrinks this move's hitstun window only
//   weightInfluence - 1 = full weight effect, 0 = weight ignored
//   specialZoom - opt-in Smash-style hit cinematic (true or
//     { zoomStrength, zoomDuration, slowmo, minCharge }). Only fires on a
//     clean connected hit; reserved for signature heavies, never every move.
//   angleType: 'sakurai' (or launchAngle 361) - grounded targets launch at
//     sakuraiGroundAngle (default 40), airborne at sakuraiAirAngle (45)
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
// ── UNIFIED Smash-style attack tables (values authored FOR smashCombat.js) ──
// J (light/tilt/aerialLight): fast startup, low recovery, BKB 120-170, KBG 0.55-0.85.
// K grounded (ALL smash): deliberate startup 10-16, recovery 24-34, BKB 280-380,
//   KBG 1.5-2.2, chargeable. K air -> aerialHeavy. Explicit launchAngle each row.
const DEFAULT_ATTACKS = {
  jab:    { name: 'Jab', anim: 'jab', category: 'jab', direction: 'neutral', state: 'ground', startup: 3, active: 5, recovery: 8, dmg: 4.0, kbBase: 130, kbGrowth: 0.65, angle: 15, launchAngle: 15, w: 60, h: 32, ox: 42, oy: -4 },
  nsmash: { name: 'Neutral Smash', anim: 'nsmash', category: 'smash', direction: 'neutral', state: 'ground', startup: 12, active: 5, recovery: 26, dmg: 15.0, kbBase: 300, kbGrowth: 1.7, angle: 32, launchAngle: 32, w: 82, h: 40, ox: 46, oy: -4, chargeable: true },
  ftilt:  { name: 'Side Tilt', anim: 'ftilt', category: 'tilt', direction: 'forward', state: 'ground', startup: 5, active: 5, recovery: 12, dmg: 7.0, kbBase: 150, kbGrowth: 0.75, angle: 35, launchAngle: 35, w: 76, h: 36, ox: 54, oy: -4 },
  fsmash: { name: 'Side Smash', anim: 'fsmash', category: 'smash', direction: 'forward', state: 'ground', startup: 14, active: 5, recovery: 30, dmg: 17.0, kbBase: 330, kbGrowth: 1.9, angle: 38, launchAngle: 38, w: 92, h: 44, ox: 66, oy: -4, chargeable: true, abilityType: 'nonHitbox', abilityId: 'cowboyFwdHeavy', abilityCfg: {}, specialZoom: { minCharge: 1.2 } },
  utilt:  { name: 'Up Tilt', anim: 'nair', category: 'tilt', direction: 'up', state: 'ground', startup: 5, active: 5, recovery: 12, dmg: 6.5, kbBase: 145, kbGrowth: 0.7, angle: 75, launchAngle: 75, w: 50, h: 60, ox: 8, oy: -46 },
  usmash: { name: 'Up Smash', anim: 'nsmash', category: 'smash', direction: 'up', state: 'ground', startup: 13, active: 6, recovery: 28, dmg: 16.0, kbBase: 310, kbGrowth: 1.8, angle: 85, launchAngle: 85, w: 70, h: 80, ox: 4, oy: -68, chargeable: true },
  dtilt:  { name: 'Down Light', anim: 'cowboyDownLight', category: 'special', direction: 'down', state: 'ground', startup: 6, active: 0, recovery: 14, dmg: 0, kbBase: 0, kbGrowth: 0, angle: 0, launchAngle: 0, w: 40, h: 40, ox: 0, oy: 0, usableInAir: false },
  dsmash: { name: 'Down Smash', anim: 'cowboyDownHeavy', category: 'smash', direction: 'down', state: 'ground', startup: 14, active: 5, recovery: 28, dmg: 15.0, kbBase: 300, kbGrowth: 1.75, angle: 30, launchAngle: 30, w: 74, h: 36, ox: 50, oy: 16, bothSides: true, chargeable: true },
  aerialLight: { name: 'Aerial Light', anim: 'nair', category: 'aerial', direction: 'neutral', state: 'air', startup: 5, active: 8, recovery: 13, dmg: 6.5, kbBase: 140, kbGrowth: 0.7, angle: 10, launchAngle: 10, w: 66, h: 64, ox: 0, oy: 0, air: true, usableInAir: true },
  aerialHeavy: { name: 'Aerial Heavy', anim: 'fair', category: 'aerial', direction: 'forward', state: 'air', startup: 9, active: 8, recovery: 20, dmg: 13.0, kbBase: 260, kbGrowth: 1.5, angle: 60, launchAngle: 60, vyScale: 0.6, w: 70, h: 48, ox: 52, oy: -4, air: true, usableInAir: true, recoveryX: -6, recoveryY: -9, recoveryDuration: 6 },
  dash:   { name: 'Dash Attack', anim: 'dash', category: 'dash', direction: 'forward', state: 'ground', startup: 4, active: 7, recovery: 12, dmg: 7.5, kbBase: 165, kbGrowth: 0.85, angle: 22, launchAngle: 22, w: 100, h: 50, ox: 50, oy: 0 },
};

// Ninja-specific attacks â€” authored for the unified pipeline like every table.
// kb Ã—0.50, per-attack launchAngle authoritative â€” see DEFAULT_ATTACKS header),
// then a NINJA-ONLY damage buff on top, applied TWICE: every row below is Ã—1.4
// twice over, so the ninja's effective damage is now original Ã— 0.784
// (0.40 shared rule Ã— 1.4 Ã— 1.4). Knockback is deliberately NOT buffed â€” the ninja
// trades reach for power, not for launch distance, so its knockback numbers are
// still the shared Ã—0.50 rule. Buffed per-attack (never through a single global
// multiplier) so a single move can still be retuned on its own. The shuriken's
// real damage in abilities.js (ninjaFsmash) is kept in lockstep with this table.
const NINJA_ATTACKS = {
  jab:    { name: 'Quick Slash', anim: 'ninjaJab', category: 'jab', direction: 'neutral', state: 'ground', startup: 2, active: 4, recovery: 6, dmg: 3.5, kbBase: 120, kbGrowth: 0.6, angle: 20, launchAngle: 20, w: 50, h: 28, ox: 38, oy: -2 },
  ftilt:  { name: 'Forward Slash', anim: 'ninjaFtilt', category: 'tilt', direction: 'forward', state: 'ground', startup: 4, active: 5, recovery: 10, dmg: 6.0, kbBase: 145, kbGrowth: 0.72, angle: 30, launchAngle: 30, w: 65, h: 32, ox: 48, oy: -2 },
  fsmash: { name: 'Shuriken Throw', anim: 'ninjaFsmash', category: 'special', direction: 'forward', state: 'ground', startup: 10, active: 2, recovery: 20, dmg: 8.0, kbBase: 170, kbGrowth: 1.0, angle: 15, launchAngle: 15, w: 30, h: 30, ox: 60, oy: 0, isProjectile: true, hitLockDuration: 0.5 },
  utilt:  { name: 'Upward Slash', anim: 'ninjaUtilt', category: 'tilt', direction: 'up', state: 'ground', startup: 4, active: 5, recovery: 10, dmg: 5.5, kbBase: 140, kbGrowth: 0.68, angle: 80, launchAngle: 80, w: 45, h: 55, ox: 6, oy: -40 },
  usmash: { name: 'Rising Slash', anim: 'ninjaUsmash', category: 'smash', direction: 'up', state: 'ground', startup: 12, active: 6, recovery: 26, dmg: 14.0, kbBase: 290, kbGrowth: 1.65, angle: 85, launchAngle: 85, w: 55, h: 70, ox: 4, oy: -60, chargeable: true },
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
  dtilt:  { name: 'Teleport Strike', anim: 'ninjaDtilt', category: 'special', direction: 'down', state: 'ground', startup: 3, active: 5, recovery: 8, dmg: 8.5, kbBase: 200, kbGrowth: 1.0, angle: 0, launchAngle: 0, w: 55, h: 20, ox: 42, oy: 10, abilityType: 'nonHitbox', abilityId: 'ninjaDtilt', abilityCfg: {} },
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
  dsmash: { name: 'Shadow Strike', anim: 'ninjaDsmash', category: 'special', direction: 'down', state: 'ground', startup: 10, active: 14, recovery: 22, dmg: 13.0, kbBase: 280, kbGrowth: 1.5, angle: 40, launchAngle: 40, w: 96, h: 88, ox: 0, oy: 0, dashDistance: 192, specialZoom: true },
  aerialLight: { name: 'Aerial Slash', anim: 'ninjaNair', category: 'aerial', direction: 'neutral', state: 'air', startup: 4, active: 7, recovery: 12, dmg: 5.5, kbBase: 135, kbGrowth: 0.65, angle: 10, launchAngle: 10, w: 60, h: 55, ox: 0, oy: 0, air: true, usableInAir: true },
  aerialHeavy: { name: 'Aerial Kick', anim: 'ninjaFair', category: 'aerial', direction: 'forward', state: 'air', startup: 8, active: 8, recovery: 18, dmg: 11.5, kbBase: 240, kbGrowth: 1.4, angle: 60, launchAngle: 60, vyScale: 0.6, w: 65, h: 45, ox: 48, oy: -2, air: true, usableInAir: true, recoveryX: -5, recoveryY: -7, recoveryDuration: 5 },
  dash:   { name: 'Dash Attack', anim: 'ninjaDash', category: 'dash', direction: 'forward', state: 'ground', startup: 3, active: 6, recovery: 12, dmg: 7.0, kbBase: 160, kbGrowth: 0.8, angle: 25, launchAngle: 25, w: 80, h: 40, ox: 45, oy: 0 },
  nsmash: { name: 'Shadow Push', anim: 'ninjaNsmash', category: 'smash', direction: 'neutral', state: 'ground', startup: 12, active: 6, recovery: 26, dmg: 14.0, kbBase: 290, kbGrowth: 1.65, angle: 35, launchAngle: 35, w: 80, h: 50, ox: 40, oy: -4, bothSides: true, chargeable: true },
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
//   dsmash = the Depsey Roll (self-buff: haste + dodge, 3.5s cooldown)
//   fsmash = the Straight Right (the heaviest single hit in the game)
//
// The ability owns the move's behaviour and its tuning constants live with it in
// abilities.js; the numbers below are what the shared hit path reads, so the
// punch, the straight and every other hit in the game resolve through the same
// deliverHit with the same knockback and hitstun rules.
const BOXER_ATTACKS = {
  jab:    { name: 'Jab', anim: 'boxerJab', category: 'jab', direction: 'neutral', state: 'ground', startup: 2, active: 4, recovery: 7, dmg: 3.5, kbBase: 75, kbGrowth: 0.45, angle: 12, launchAngle: 12, w: 56, h: 30, ox: 40, oy: -4 },
  ftilt:  { name: 'Lead Hook', anim: 'boxerFtilt', category: 'tilt', direction: 'forward', state: 'ground', startup: 4, active: 5, recovery: 12, dmg: 6.5, kbBase: 105, kbGrowth: 0.60, angle: 32, launchAngle: 32, w: 70, h: 34, ox: 50, oy: -4 },
  nsmash: { name: 'Cross', anim: 'boxerNsmash', category: 'smash', direction: 'neutral', state: 'ground', startup: 13, active: 5, recovery: 30, dmg: 13.0, kbBase: 235, kbGrowth: 1.30, angle: 28, launchAngle: 28, w: 86, h: 44, ox: 48, oy: -4, chargeable: true },
  // The Straight Right: the single hardest-hitting move in the game (9.6, above
  // the Grab's punch) with a launch long enough to send a stock back toward the
  // ledge, and the longest recovery â€” a whiff is a free punish. It is still a
  // real melee box: the ability adds a reach streak and a punch sound, and hands
  // THIS row to the shared hitbox registry on the cast frame.
  fsmash: { name: 'Straight Right', anim: 'boxerFsmash', category: 'smash', direction: 'forward', state: 'ground', startup: 15, active: 5, recovery: 34, dmg: 16.0, kbBase: 292, kbGrowth: 2.25, angle: 36, launchAngle: 36, w: 104, h: 46, ox: 74, oy: -4, chargeable: true, abilityType: 'nonHitbox', abilityId: 'boxerFsmash', abilityCfg: {}, specialZoom: { minCharge: 1.15 } },
  // Uppercut: the character's signature. Low horizontal push, almost all vertical,
  // so it spikes nothing — it lifts.
  utilt:  { name: 'Uppercut', anim: 'boxerUtilt', category: 'tilt', direction: 'up', state: 'ground', startup: 3, active: 5, recovery: 12, dmg: 7.0, kbBase: 110, kbGrowth: 0.65, angle: 82, launchAngle: 82, w: 52, h: 58, ox: 10, oy: -44 },
  usmash: { name: 'Rising Upper', anim: 'boxerUsmash', category: 'smash', direction: 'up', state: 'ground', startup: 14, active: 6, recovery: 30, dmg: 15.0, kbBase: 250, kbGrowth: 1.40, angle: 88, launchAngle: 88, w: 72, h: 78, ox: 6, oy: -66, chargeable: true },
  // Down Light is the Grab. The row carries no melee box at all: the ability
  // finds the target, combat holds it, and the punch that ends the move is
  // resolved through the shared hit path (see BOXER_GRAB.punch). The punch
  // numbers live with the ability; `active` is only kept non-zero so the move's
  // length and the animator's phases read sensibly.
  dtilt:  { name: 'Grab', anim: 'boxerDtilt', category: 'special', direction: 'down', state: 'ground', startup: 6, active: 5, recovery: 12, dmg: 0, kbBase: 0, kbGrowth: 0, angle: 0, launchAngle: 0, w: 66, h: 26, ox: 46, oy: 12, abilityType: 'nonHitbox', abilityId: 'boxerDtilt', abilityCfg: {} },
  dsmash: { name: 'Depsey Roll', anim: 'boxerDsmash', category: 'special', direction: 'down', state: 'ground', startup: 6, active: 0, recovery: 18, dmg: 0, kbBase: 0, kbGrowth: 0, angle: 0, launchAngle: 0, w: 78, h: 40, ox: 44, oy: 20, abilityType: 'nonHitbox', abilityId: 'boxerDsmash', abilityCfg: {} },
  aerialLight:  { name: 'Air Jab', anim: 'boxerAerialLight', category: 'aerial', direction: 'neutral', state: 'air', startup: 4, active: 7, recovery: 12, dmg: 5.5, kbBase: 90, kbGrowth: 0.50, angle: 5, launchAngle: 5, w: 62, h: 60, ox: 0, oy: 0, air: true, usableInAir: true },
  aerialHeavy:  { name: 'Air Uppercut', anim: 'boxerAerialHeavy', category: 'aerial', direction: 'up', state: 'air', startup: 8, active: 8, recovery: 20, dmg: 11.5, kbBase: 185, kbGrowth: 1.05, angle: 75, launchAngle: 75, vyScale: 0.6, w: 74, h: 50, ox: 48, oy: -6, air: true, usableInAir: true, recoveryX: -5, recoveryY: -8, recoveryDuration: 5 },
  dash:   { name: 'Shoulder Charge', anim: 'boxerDash', category: 'dash', direction: 'forward', state: 'ground', startup: 3, active: 7, recovery: 12, dmg: 6.5, kbBase: 115, kbGrowth: 0.65, angle: 22, launchAngle: 22, w: 92, h: 46, ox: 46, oy: 0 },
};

// Knight attacks — bare-handed like the boxer, balanced defensive. Numbers sit between
// the cowboy's and the boxer's: honest midweight damage with midweight launch,
// no gimmick multipliers anywhere in the table. The signature mechanics live
// OUTSIDE the table — the shield parry (below), the Shield Bash ability and
// the Shield Counter stance (abilities.js) — so every blow resolves through
// the exact same deliverHit as the rest of the roster.
const KNIGHT_ATTACKS = {
  jab:    { name: 'Sword Slash', anim: 'knightJab', category: 'jab', direction: 'neutral', state: 'ground', startup: 3, active: 4, recovery: 7, dmg: 4.5, kbBase: 74, kbGrowth: 0.65, angle: 18, launchAngle: 18, w: 62, h: 30, ox: 44, oy: -2 },
  ftilt:  { name: 'Side Slash', anim: 'knightFtilt', category: 'tilt', direction: 'forward', state: 'ground', startup: 5, active: 5, recovery: 11, dmg: 7.0, kbBase: 85, kbGrowth: 0.75, angle: 30, launchAngle: 30, w: 78, h: 34, ox: 56, oy: -2 },
  // Neutral Heavy is the Shield Counter: a rooted counter stance (the active
  // window) that answers any hit taken during it with an answering slash. The
  // retaliation numbers live on the ability; the row carries no box of its own.
  nsmash: { name: 'Shield Counter', anim: 'knightShield', category: 'special', direction: 'neutral', state: 'ground', startup: 4, active: 26, recovery: 15, dmg: 0, kbBase: 0, kbGrowth: 0, angle: 0, launchAngle: 0, w: 70, h: 60, ox: 30, oy: -10, abilityType: 'nonHitbox', abilityId: 'knightShieldCounter', abilityCfg: {} },
  fsmash: { name: 'Charged Sword Strike', anim: 'knightFsmash', category: 'smash', direction: 'forward', state: 'ground', startup: 14, active: 5, recovery: 30, dmg: 17.0, kbBase: 182, kbGrowth: 1.9, angle: 38, launchAngle: 38, w: 92, h: 44, ox: 66, oy: -4, chargeable: true, specialZoom: { minCharge: 1.2 } },
  utilt:  { name: 'Rising Guard', anim: 'knightUtilt', category: 'tilt', direction: 'up', state: 'ground', startup: 5, active: 5, recovery: 12, dmg: 6.5, kbBase: 83, kbGrowth: 0.7, angle: 80, launchAngle: 80, w: 50, h: 58, ox: 8, oy: -44 },
  usmash: { name: 'Skyward Oath', anim: 'knightUsmash', category: 'smash', direction: 'up', state: 'ground', startup: 13, active: 6, recovery: 28, dmg: 15.0, kbBase: 168, kbGrowth: 1.75, angle: 85, launchAngle: 85, w: 68, h: 78, ox: 4, oy: -66, chargeable: true },
  // Down Light is the Shield Bash: a real strike box (strikeHitbox hands this
  // row to the registry on the cast frame) plus a short step-in owned by the
  // ability. Same designation pattern as the boxer/ninja signature rows.
  dtilt:  { name: 'Shield Bash', anim: 'knightDtilt', category: 'special', direction: 'down', state: 'ground', startup: 5, active: 4, recovery: 12, dmg: 6.0, kbBase: 102, kbGrowth: 0.9, angle: 15, launchAngle: 15, w: 64, h: 30, ox: 48, oy: 10, abilityType: 'nonHitbox', abilityId: 'knightShieldBash', abilityCfg: {} },
  dsmash: { name: 'Spinning Sweep', anim: 'knightDsmash', category: 'smash', direction: 'down', state: 'ground', startup: 12, active: 6, recovery: 26, dmg: 14.0, kbBase: 160, kbGrowth: 1.6, angle: 30, launchAngle: 30, w: 94, h: 38, ox: 47, oy: 8, bothSides: true },
  // Aerial Light is the Rising Sword Slash AND the Heroic Ascent: the shared
  // aerial-light recovery mechanic (upward boost + launch assist, one use per
  // airtime, recharged on ground touch) fires for every character's aerial
  // light, and the knight's above-average recoveryStrength makes this one a
  // genuine recovery move — no separate code path, no extra launches.
  aerialLight: { name: 'Rising Sword Slash', anim: 'knightAerialLight', category: 'aerial', direction: 'neutral', state: 'air', startup: 5, active: 7, recovery: 13, dmg: 7.0, kbBase: 83, kbGrowth: 0.75, angle: 70, launchAngle: 70, w: 60, h: 62, ox: 6, oy: -44, air: true, usableInAir: true },
  aerialHeavy: { name: 'Falling Sword Strike', anim: 'knightAerialHeavy', category: 'aerial', direction: 'forward', state: 'air', startup: 10, active: 8, recovery: 20, dmg: 13.5, kbBase: 149, kbGrowth: 1.5, angle: -55, launchAngle: -55, spike: true, w: 66, h: 60, ox: 48, oy: -6, air: true, usableInAir: true, recoveryX: -5, recoveryY: -8, recoveryDuration: 5 },
  dash:   { name: 'Oath Lunge', anim: 'knightDash', category: 'dash', direction: 'forward', state: 'ground', startup: 4, active: 6, recovery: 12, dmg: 7.0, kbBase: 88, kbGrowth: 0.8, angle: 22, launchAngle: 22, w: 96, h: 46, ox: 48, oy: 0 },
};

// ── Knight Shield Parry ──────────────────────────────────────────────────
// The knight's signature: a precisely timed shield parry on the shield-press
// edge (see combatInput). A successful parry negates the hit outright and arms
// a 2x damage / 2x knockback bonus on the knight's NEXT connecting attack,
// consumed on landing. Defensive timing skill, never a holdable wall: the
// window is short, a whiff locks the guard briefly, and every stance (hit or
// miss) runs the same cooldown.
const KNIGHT_PARRY_WINDOW = 0.30;   // seconds of active parry after shield press
const KNIGHT_PARRY_COOLDOWN = 1.1;  // seconds before another stance may start
const KNIGHT_PARRY_WHIFF_LOCK = 0.45; // guard lockout after an unanswered stance
const KNIGHT_PARRY_ABILITY = 'knightParry';

function isKnight(f) { return !!f && !!f._fighterDef && f._fighterDef.id === 'knight'; }

function knightCanAct(f) {
  if (!f) return false;
  if ((f.hitstun || 0) > 0) return false;
  if (f.attack || f.dodging) return false;
  if (f.state === 'dead' || f.eliminated) return false;
  return true;
}

// Enter the parry stance. Called on the shield-press edge only — holding
// shield never re-arms it, so parry cannot be held indefinitely and every
// attempt costs a release + repress through the shared block cooldown.
function tryKnightParryStance(fighter) {
  if (!isKnight(fighter) || !knightCanAct(fighter)) return false;
  if ((fighter.shieldCooldown || 0) > 0) return false;
  const acd = fighter.abilityCooldowns;
  if (acd && acd[KNIGHT_PARRY_ABILITY] > 0) return false;
  fighter._parryWindow = KNIGHT_PARRY_WINDOW;
  try {
    emitFlash(fighter.x, fighter.y - fighter.radius, {
      style: fxStyleFor(fighter), radius: fighter.radius * 0.8, life: 0.12, alpha: 0.55, color: '#ffe9a3',
    });
  } catch (_) {}
  try { SFX.draw(); } catch (_) {}
  return true;
}

// Resolve a hit against a parrying knight. Returns true when the parry
// connects: damage and knockback fully negated, impact pause, ring + spark +
// floating text, and the 2x counter bonus armed for the next attack. Melee
// and projectiles funnel through the same deliverHit, so both are parryable;
// nothing in the roster is flagged unparryable.
function tryKnightParry(target, attacker) {
  if (!isKnight(target) || !(target._parryWindow > 0)) return false;
  if (!attacker || attacker === target) return false;
  if (!knightCanAct(target)) return false;
  target._parryWindow = 0;
  target._parryBuff = { dmgMul: 2, kbMul: 2 };
  try { stampAbilityCooldown(target, KNIGHT_PARRY_ABILITY, KNIGHT_PARRY_COOLDOWN); } catch (_) {}
  // Short impact pause (the shared hit-stop clock — presentation feel only,
  // combat timing untouched) plus a restrained gold impact.
  try { freezeGame(0.09); } catch (_) {}
  try {
    const r = target.radius || 22;
    const style = fxStyleFor(target);
    emitFlash(target.x, target.y - r * 0.4, { style, radius: r * 1.0, life: 0.14, alpha: 0.85, color: '#ffe9a3' });
    emitImpactRing(target.x, target.y - r * 0.4, { style, wave: true, radius: r * 0.5, growth: r * 3.0, life: 0.3, alpha: 0.8, color: '#d9a92e' });
    emitSparks(target.x, target.y - r * 0.4, 8, { style, speed: 260, size: 4, life: 0.3 });
    spawnFloatingText(target.x, target.y - r - 40, 'PARRY!', '#ffd76a', { life: 0.9, size: 26 });
  } catch (_) {}
  try { SFX.hit(true); } catch (_) {}
  return true;
}

// ── Knight Shield Counter ────────────────────────────────────────────
// The answering half of the knightShieldCounter stance (abilities.js): any
// hit taken while the stance window is live is negated and answered with a
// retaliatory slash through the shared deliverHit — same damage/knockback/
// hitstun rules as every other blow, so a banked parry bonus doubles it
// naturally and charge/weight math is untouched.
//
// Reentrancy: the retaliation re-enters deliverHit with the roles swapped, so
// a fighter already answering (or a dodging/invulnerable attacker) can never
// trigger a second answer — no counter ping-pong, and i-frames are respected.
const KNIGHT_COUNTER_DEF = {
  name: 'Shield Counter', dmg: 12.0, kbBase: 165, kbGrowth: 1.7,
  angle: 40, launchAngle: 40,
};
function tryKnightCounter(target, attacker) {
  if (!isKnight(target) || !(target._knightCounter > 0)) return false;
  if (!attacker || attacker === target) return false;
  // NB: unlike the parry tap, the counter stance IS an attack in progress, so
  // being mid-swing must not disqualify it — only genuine inability to act
  // does (stun, dodge, death, elimination, or an answer already resolving).
  if ((target.hitstun || 0) > 0 || target.dodging) return false;
  if (target.state === 'dead' || target.eliminated) return false;
  if (target._counterResolving) return false;
  if ((attacker.invulnTimer || 0) > 0 || attacker.dodging) {
    // Negated on the shield, but no one to answer — stance spent, no blow.
    target._knightCounter = 0;
    return true;
  }
  target._knightCounter = 0;
  target._counterResolving = true;
  let landed = false;
  try {
    const dir = (attacker.x >= target.x) ? 1 : -1;
    try {
      spawnTempVfx(target, 'knightCounter', 0.5, 1.2, 0, 0, 0, {
        anchor: 'character', mirrorX: dir,
      });
    } catch (_) {}
    try { freezeGame(0.09); } catch (_) {}
    landed = !!applyAbilityHit(target, attacker, KNIGHT_COUNTER_DEF, dir);
    if (landed) {
      try {
        spawnFloatingText(target.x, target.y - (target.radius || 22) - 40,
          'COUNTER!', '#ffd76a', { life: 0.9, size: 26 });
      } catch (_) {}
      // The answer is the recording's moment (shieldcounter.mp3), so the generic
      // critical impact it replaces would only double it up.
      try { SFX.shieldCounter(); } catch (_) {}
    }
  } finally {
    target._counterResolving = false;
  }
  return true;
}

// Royal Guard impact: the knight's block resolves through the standard
// shield reduction (never full negation, never a bonus) — this is only the
// restrained shield-hit art that marks it as a guard, not a parry.
function knightGuardImpact(target) {
  try {
    const r = target.radius || 22;
    const dir = target.facingRight ? 1 : -1;
    const style = fxStyleFor(target);
    emitSparks(target.x + dir * r * 0.9, target.y - 6, 5, { style, speed: 170, size: 3, life: 0.22 });
    emitImpactRing(target.x + dir * r * 0.9, target.y - 6, { style, radius: r * 0.3, growth: r * 1.2, life: 0.18, alpha: 0.5, color: '#8fa3b8' });
  } catch (_) {}
}

// Sword rows that paint a clean trail for the swing's duration (spawned once
// at attack start through the shared temp-VFX pool — pooled, culled and drawn
// by the existing fighter-VFX path, no new system). The Spinning Sweep paints
// its own converted art (GA/vfx/spinningsweep.html) instead of the slash, the
// Charged Sword Strike paints the blue slash (GA/vfx/blueslash.html), and the
// Oath Lunge paints a circle-burst launch flash.
const KNIGHT_TRAIL_KEYS = new Set(['jab', 'ftilt', 'fsmash', 'dsmash', 'aerialLight', 'aerialHeavy', 'dash']);
// Incoming-animation twin of the spawnTempVfx timeline rule. This spawner
// fires synchronously on the attack-start frame, BEFORE syncFighterAnim
// attaches the new animation — judging the CURRENT animation here would read
// the PREVIOUS move's timeline: a freshly edited entry would paint twice
// (timeline + code fallback), and a deleted entry would paint never. Judge
// the animation this attack is ABOUT to play instead (force:true bypasses
// the shared guard, already decided correctly here).
function incomingOwnsEffect(def, effectId) {
  if (!def || !def.anim) return false;
  try {
    const anim = getAnimationRaw(def.anim);
    const list = anim && anim.vfx;
    if (!Array.isArray(list)) return false;
    for (let i = 0; i < list.length; i++) {
      if (list[i] && list[i].effect === effectId) return true;
    }
  } catch (_) {}
  return false;
}
function knightSwingTrail(fighter, key, def) {
  if (!isKnight(fighter) || !KNIGHT_TRAIL_KEYS.has(key)) return;
  try {
    const total = (def.startup || 0) + (def.active || 0);
    const isSweep = key === 'dsmash';
    const isBlue = key === 'fsmash';
    const isDash = key === 'dash';
    const life = isSweep ? Math.max(0.3, Math.min(0.45, total / 60))
      : Math.max(0.12, Math.min(0.4, total / 60));
    const dir = fighter.facingRight ? 1 : -1;
    // Sweep scale 0.5: knightSweep's blades reach ~6.8U (U=30) at scale 1, and
    // the Spinning Sweep box reaches ~94px from center (w94 ox47, both sides)
    // — half scale lands the blades on roughly the hitbox edge. Blue scale
    // 1.15: the charged slash should read bigger than a plain swing.
    const trailScale = isSweep ? 0.5 : isBlue ? 1.15 : 1.0;
    const trailId = isSweep ? 'knightSweep' : isBlue ? 'knightBlueSlash' : 'knightSlash';
    if (!isDash && !incomingOwnsEffect(def, trailId)) {
      spawnTempVfx(fighter, trailId, life, trailScale, 0, 0, 0, { anchor: 'weapon', mirrorX: dir, force: true });
    }
    // Dash launch flash: short circle burst at the body.
    if (isDash && !incomingOwnsEffect(def, 'knightCircleBurst')) {
      spawnTempVfx(fighter, 'knightCircleBurst', 0.35, 1.0, 0, 0, 0, { anchor: 'character', mirrorX: dir, force: true });
    }
  } catch (_) {}
}

export function attacksFor(fighter) {
  const def = fighter._fighterDef;
  if (def && def.id === 'ninja') return NINJA_ATTACKS;
  if (def && def.id === 'boxer') return BOXER_ATTACKS;
  if (def && def.id === 'knight') return KNIGHT_ATTACKS;
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

// Shared empty hitbox source, so mergeHitboxDef never allocates a throwaway
// `[]` for a def that has no hitbox list.
const EMPTY_HB_SRC = [];
// Hoisted field list — the old inline literal allocated a fresh 15-element
// array on every mergeHitboxDef call.
const _TOP_HB_FIELDS = ['w','h','ox','oy','dmg','kbBase','kbGrowth','angle','launchAngle','horizontalKnockback','verticalKnockback','vyScale','recoveryX','recoveryY','recoveryDuration'];

// Build a hitbox-type def from a hitbox list (either the custom store's or an
// animation's legacy combat data). Always a fresh object — the hitbox/ability
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
  //
  // Built in ONE pass into a right-sized array. The previous form was
  // `.map(...).filter(Boolean)` plus two more `.map()` calls feeding
  // `Math.min(...arr)` / `Math.max(...arr)`: four intermediate arrays, two
  // closures, one spread-per-hitbox, all of it re-created for every candidate
  // attack key on every AI decision (~12 x several times a second). The loop
  // below produces the same array with a single pass and no spread, and tracks
  // the start/end windows as it goes.
  const src = hbsSrc || EMPTY_HB_SRC;
  const nSrc = src.length;
  const hbs = [];
  let start = 0, end = 1;
  for (let i = 0; i < nSrc; i++) {
    const hb = src[i];
    if (!hb) continue;
    const n = { ...hb };
    if (n.startFrame == null) n.startFrame = n.startup != null ? n.startup : 0;
    if (n.duration == null) n.duration = n.active != null ? n.active : 4;
    hbs.push(n);
    if (hbs.length === 1) {
      start = n.startFrame || 0;
      end = start + Math.max(1, n.duration || 1);
    } else {
      const s0 = n.startFrame || 0;
      if (s0 < start) start = s0;
      const e0 = s0 + Math.max(1, n.duration || 1);
      if (e0 > end) end = e0;
    }
  }
  // Keep the explicit list — an EMPTY list means "this attack has no hitbox"
  // (a deliberately de-hitspaced swing), never a silent fallback to stray values.
  out.hitboxes = hbs;
  if (hbs.length) {
    const first = hbs[0];
    // keep top-level hitbox fields for code that expects a single hitbox
    for (let i = 0; i < _TOP_HB_FIELDS.length; i++) {
      const k = _TOP_HB_FIELDS[i];
      if (first[k] != null) out[k] = first[k];
    }
    // launchAngle mirrors angle when only one is customized.
    if (first.angle != null && first.launchAngle == null) out.launchAngle = first.angle;
    if (first.launchAngle != null && first.angle == null) out.angle = first.launchAngle;
  }
  // Attack phase timing is derived from the union of the hitbox windows so
  // the active phase always covers exactly the damaging frames; explicit
  // combat.startup/active override it. Recovery is the one phase that is not
  // represented by a window — it is preserved from the base attack so a
  // customized hitbox never swallows the punish window.
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
  const attacks = attacksFor(fighter);
  const facingRight = fighter.facingRight;
  // Centralized input classification (smashCombat.js): fresh-press priority,
  // up > down > side > neutral; stale movement holds do not force directionals.
  const dirClass = classifyDirection(dirs, null);
  const mapped = classifyAttack({ light, heavy, dirClass, grounded: fighter.grounded,
    dashing: fighter.dashing, facingRight, dirs });
  if (!fighter.grounded) {
    // Aerial attacks: exactly two â€” Light and Heavy.
    // Selection does NOT depend on horizontal input, facing direction, or vertical input.
    // Light button â†’ Aerial Light; Heavy button â†’ Aerial Heavy. Always.
    const akey = mapped || (light ? 'aerialLight' : 'aerialHeavy');
    return { key: akey, def: attacks[akey], variant: 'air', dir: dirs };
  }

  // Dash attack: attacking during a dash burst lunges forward with the dash
  // attack's hitbox â€” the same animator-customizable source as every other
  // attack. Custom fighter attack tables can override it; the built-in
  // fallback always exists.
  if (fighter.dashing || mapped === 'dash') return { key: 'dash', def: attacks.dash || DEFAULT_ATTACKS.dash, variant: 'side', dir: dirs };
  const key = mapped || (light ? 'jab' : 'nsmash');
  const variant = key === 'utilt' || key === 'usmash' ? 'up'
    : key === 'dtilt' || key === 'dsmash' ? 'down'
    : key === 'ftilt' || key === 'fsmash' || key === 'btilt' || key === 'bsmash' ? 'side'
    : key === 'aerialLight' || key === 'aerialHeavy' ? 'air' : 'neutral';
  const fallback = key === 'btilt' ? (attacks.btilt || attacks.ftilt)
    : key === 'bsmash' ? (attacks.bsmash || attacks.fsmash) : attacks[key];
  return { key, def: fallback, variant, dir: dirs };
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
  attr.chargeMult = sel.chargeMult || 1;
  attr.charged = (sel.chargeMult || 1) > 1.01;
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
  // Depsey Roll haste: a buffed boxer restarts attacks sooner.
  fighter.attackCooldown = ATTACK_DELAY *
    (fighter._boxerRoll && fighter._boxerRoll.timeLeft > 0
      ? (fighter._boxerRoll.attackHaste || 1) : 1);

  // Aerial Light recovery bonus: the airborne Light move doubles as a strong
  // upward recovery. On launch we override the attacker's downward velocity so
  // falling speed never eats the assist, then arm the finite launch buff (gravity
  // reduction + boosted air steer, consumed by Fighter.js physics/input every
  // frame). No VFX: a recovery paints nothing. Only when airborne â€” the grounded
  // Light press is completely untouched.
if (sel.key === 'aerialLight' && !fighter.grounded && fighter.launchTimer <= 0) {
    // Check if aerial light recovery is available (needs ground touch to recharge)
    if (fighter.canUseAerialLightRecovery) {
        // Apply strong upward recovery boost (character recovery strength)
        const recoveryStrength = fighter.recoveryStrength || 1;
        const recoveryRange = fighter.recoveryRange || 1;
        fighter.vy = -AERIAL_LIGHT_RECOVERY_FORCE * (fighter.recoveryMul || 1) * recoveryStrength;
        // Add horizontal recovery boost based on held direction
        // Note: direction is determined by the attack's facing, not input here
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
  // Knight sword trails: one pooled weapon-anchored arc for the swing's
  // duration. Fired here (past every gate) so refused moves paint nothing.
  knightSwingTrail(fighter, sel.key, sel.def);
  return true;
}

// The four light attacks that carry a recorded swing. A Set, not an object
// literal: an object would inherit toString/constructor, so a key like
// 'toString' would match and play a voice for a move that does not exist.
const LIGHT_ATTACK_KEYS = new Set(['jab', 'ftilt', 'aerialLight', 'aerialHeavy']);

// Play the committed swing's voice. Each character owns its recording of the
// same four basic moves, chosen from the fighter's own character def — no
// second source of truth for "who is this fighter".
function playLightAttackVoice(fighter, key) {
  const def = fighter && fighter._fighterDef;
  // The knight's Charged Sword Strike (fsmash) is not one of the four light
  // moves, but it owns a recording like they do — a heavy, charged one. Checked
  // before the light-move gate so the other roster's Side Smashes (which speak
  // through their own abilities on the cast frame) are not claimed here.
  if (key === 'fsmash') {
    if (def && def.id === 'knight') SFX.chargedSword();
    return;
  }
  if (!LIGHT_ATTACK_KEYS.has(key)) return;
  if (def && def.id === 'ninja') SFX.slash();
  else if (def && def.id === 'knight') SFX.knightSlash();
  else if (def && def.id === 'boxer') {
    // Depsey mode swaps the basics to the usus voice while the roll runs.
    if (fighter._boxerRoll && fighter._boxerRoll.timeLeft > 0) SFX.usus();
    else SFX.boxerM1s();
  }
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
    // Knight Shield Parry stance rides the shield-press edge: a fresh press
    // opens the parry window (holding shield never re-arms it). Human, AI and
    // dummy inputs all flow through this one write, so every controller gets
    // identical timing, cooldowns and whiff punishment.
    const shieldEdge = wantShield && !fighter._prevShieldHeld;
    fighter._prevShieldHeld = wantShield;
    if (shieldEdge) tryKnightParryStance(fighter);

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
    // Smash charging: holding grounded Heavy charges (max 1.2s, up to 1.5x).
    // Movement locked while charging; release/tag-hit cancels correctly.
    if (fighter._charging) {
      const ch = fighter._charging;
      const stillHeld = ih(fighter.playerNum, 'special');
      ch.t += (ov && ov.dt) || (1 / 60);
      if (fighter.hitstun > 0 || !fighter.grounded) {
        fighter._charging = null; // interrupted or walked off — no free charge
      } else if (!stillHeld || ch.t >= COMBAT_CONFIG.smashChargeMaxTime) {
        const mult = chargeMultiplier(ch.t);
        fighter._charging = null;
        if (fighter.hitstun <= 0 && !fighter.attack) {
          const selc = selectAttack(fighter, ch.type, ch.dir, ov);
          if (selc) { selc.chargeMult = mult; startAttack(fighter, selc); }
        }
      }
      continue;
    }
    const busy = fighter.hitstun > 0 || fighter.attack || fighter.dodging
      || fighter._hitLock != null || (fighter.attackCooldown || 0) > 0
      || (fighter._hitLockTimer || 0) > 0;

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
      // Grounded smashable Heavy begins charging; tap = uncharged smash.
      // Aerial/dash/special-ability heavies fire instantly (no charge).
      if (heavyPress && fighter.grounded && !fighter.dashing) {
        const peek = selectAttack(fighter, type, dirSnapshot, ov);
        if (peek && isSmashKey(peek.key) && (peek.def && peek.def.chargeable !== false)) {
          fighter._charging = { type, dir: dirSnapshot, t: 0, key: peek.key };
          continue;
        }
      }
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
        // Attacker lift, tuned with AERIAL_LIFT below: enough to hold altitude
        // through the swing, never a free recovery by itself. The victim's pop
        // is a separate knob (vyScale on the attack def, applied in
        // computeLaunch). The boxer's Air Uppercut lifts less so the move
        // stays a close-range rising punch - the victim's launch (vyScale)
        // is untouched.
        const isBoxer = fighter._fighterDef && fighter._fighterDef.id === 'boxer';
        const upwardBoost = isBoxer ? AERIAL_LIFT.boxer : AERIAL_LIFT.other;
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
      if ((recX !== 0 || recY !== 0) && !a.recoveryForce) {
        const facing = fighter.facingRight ? 1 : -1;
        // recoveryX is relative to facing (positive = backward recoil)
        fighter.vx += recX * facing * AERIAL_RECOIL.entryShare;
        fighter.vy += recY * AERIAL_RECOIL.entryShare;
        // Sustain the force over the duration with a linear fade (bounded -
        // see AERIAL_RECOIL). Never re-arms while live, so re-entry cannot stack.
        // The entry frame carries the impulse only; sustain starts next frame so
        // no single frame ever applies the full force at once.
        if (recDur > 0) {
          const rf = _recForcePool.pop() || {};
          rf.x = recX * facing; rf.y = recY;
          rf.framesLeft = recDur; rf.total = recDur;
          rf.fresh = true;
          a.recoveryForce = rf;
        }
      }
    }
  }

  if (phase === 'finished') {
    destroyAttackHitboxes(fighter); // also releases the attack object
    return;
  }

  // Sustained recoil during the recovery phase: fading steps (bounded total).
  // Cleared safely on landing, death or hitstun instead of dragging the
  // fighter - destroyAttackHitboxes already recycles the record itself.
  if (a.phase === 'recovery' && a.recoveryForce && a.recoveryForce.framesLeft > 0) {
    if (fighter.state === 'dead' || fighter.grounded || fighter.hitstun > 0) {
      _recForcePool.push(a.recoveryForce);
      a.recoveryForce = null;
    } else {
      const rf = a.recoveryForce;
      if (rf.fresh) {
        rf.fresh = false; // impulse already applied on entry; sustain begins next frame
      } else {
        const step = computeRecoilSustain(rf.x, rf.y, rf.framesLeft, rf.total || rf.framesLeft);
        fighter.vx += step.x;
        fighter.vy += step.y;
        rf.framesLeft--;
        if (rf.framesLeft <= 0) {
          _recForcePool.push(rf);
          a.recoveryForce = null;
        }
      }
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
// BOXER: the Grab is fighter-owned and stepped every frame - it outlives the
// attack that cast it (keeps holding its target after startup), so it steps
// from updateAttacks rather than the attack machine, exactly like the Deadeye
// volley and the horse - and the ability only ever ARMS it (abilities.js
// cannot import this module). (The Depsey Roll is a buff record, not a
// stepper - Fighter.js owns its clock.)
//
//   fighter._boxerGrab = { target, frames, hold, offset, punch, facing }

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
  // A punch the target slipped through (a Depsey Roll dodge) resolves as no hit
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

// NOTE: the old Depsey Roll buff (speed/damage/dodge window on _boxerRoll)
// was retired when Down Heavy became the Deadeye Assault (teleport + barrage).
// _boxerRoll is never armed anymore; the stepper below owns the move.


// BOXER: the Depsey Roll is a self-buff armed directly by abilities.js
// (fighter._boxerRoll with its own multipliers) — there is no assault record,
// no pending hand-off and no stepper here. Readers: Fighter.js (movement,
// dodge, cooldowns, buff clock) and startAttack below (attack pacing).


// Drop every piece of fighter-owned boxer state (a respawn, a match reset, a
// knockout). Exported so the respawn path clears the grab and the roll buff
// exactly where it already clears the Deadeye volley and the Teleport charge
// a stock that just respawned must not inherit a held opponent or a live buff.
export function clearBoxerState(fighter) {
  if (!fighter) return;
  const g = fighter._boxerGrab;
  if (g && g.target) {
    g.target.vx = 0;
    g.target.vy = 0;
  }
  fighter._boxerGrab = null;
  fighter._boxerGrabPending = null;
  fighter._boxerRoll = null;
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
// Returns whether the hit actually landed: a Depsey Roll dodge resolves through
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
function targetWeight(target, def) {
  let _w = target && target._fighterDef && target._fighterDef.weight;
  if (typeof _w === 'number' && _w > 0 && _w < 10) _w = _w * 100;
  const w = _w;
  const base = (typeof w === 'number' && w >= 70 && w <= 130) ? w : 100;
  // Per-move weight influence (1 = full weight effect, 0 = weight ignored),
  // blended around 1 so nearby values never jump; plus the fighter's own
  // launchResist multiplier. Both neutral by default — existing moves behave
  // exactly as before.
  const infl = def && typeof def.weightInfluence === 'number' ? def.weightInfluence : 1;
  const effW = 100 + (base - 100) * infl;
  const resist = target && Number.isFinite(target.launchResist) && target.launchResist > 0
    ? target.launchResist : 1;
  return Math.max(0.25, (effW * resist) / 100);
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
// Damage-scaled knockback (soft-capped) - centralized tuning for how victim
// damage feeds launch strength:
//
//   K = Kbase + Dmg*dmgFactor + Kbase*Growth*Strength*D/(D + softCap)
//
// D/(D+softCap) rises with damage but asymptotes to 1, so the damage-based
// contribution is bounded by Kbase*Growth*Strength instead of accelerating
// without limit (the old (1+D/80) multiplier applied to the whole sum,
// making knockback effectively quadratic in D). At D=0 the formula reduces
// to Kbase + Dmg*dmgFactor - identical to the previous fresh-hit behavior -
// so move feel at low percent is preserved by construction.
//   strength: global growth coefficient (tune all scaling at once).
//   softCap:  damage at which the growth term reaches half its maximum.
//   dmgFactor: static per-move damage contribution (NOT damage scaling -
//     constant per move, preserves each move's fresh-hit identity).
// Legacy export kept for test-compat; delegates to the unified damageScaling:
// growth term = KBG * DS(P,D=0) * kbScale (percent-only portion).
export const KNOCKBACK_SCALING = {
  strength: 1.5,
  softCap: COMBAT_CONFIG.damageSoftCap,
  dmgFactor: COMBAT_CONFIG.damageDealtFactor,
  kbScale: COMBAT_CONFIG.kbScale,
};
export function knockbackGrowthTerm(base, growth, damage) {
  if (!(base > 0) || !(growth > 0)) return 0;
  const ds = damageScaling(damage, 0);
  return growth * ds * COMBAT_CONFIG.kbScale;
}
// Aerial Heavy attacker lift (px/s upward snap on active-start, per character
// class) and recoil shaping. Recoil splits the def's (recoveryX, recoveryY)
// into one entry impulse plus a linearly FADING sustain, so the total added
// velocity is bounded at entryShare + sustainShare*D/2 (about 2x the entry
// for typical durations) instead of the full force re-added every frame.
export const AERIAL_LIFT = { other: 250, boxer: 120 };
export const AERIAL_RECOIL = { entryShare: 0.5, sustainShare: 0.5 };
// Pure per-frame sustain step (px/frame) for tests and the attack machine:
// linearly fades to zero across the duration - no stacking, no bursts.
export function computeRecoilSustain(recX, recY, framesLeft, total) {
  const t = total > 0 ? Math.max(0, Math.min(1, framesLeft / total)) : 0;
  const k = AERIAL_RECOIL.sustainShare * t;
  return { x: recX * k, y: recY * k };
}
const KNOCKBACK_GLOBAL_MULTIPLIER = COMBAT_CONFIG.globalKnockback;
const KNOCKBACK_MAX = COMBAT_CONFIG.kbMax;

// Resolve an attack's launch angle in degrees. Ordinary moves use their
// launchAngle (angle is the legacy alias). A Sakurai-type angle (angleType:
// 'sakurai', or the 361 convention value) is NOT a fixed direction: grounded
// targets go out low, airborne targets go up, each from its own configurable
// knob — isolated here so tuning it never touches fixed-angle moves.
// Legacy alias: single angle implementation lives in smashCombat.js.
function resolveLaunchAngle(def, opts, target) {
  return resolveAttackAngleDeg(def, opts, target);
}
export function computeKnockbackVector(target, def, opts) {
  const o = opts || {};
  const hitDir = o.hitDir || 1;
  const kbMul = o.kbMul || 1;
  const chargeMult = o.chargeMult || 1;
  const launchMul = (def && def.launchMultiplier) || 1;
  const angle = resolveAttackAngleDeg(def, o, target);
  const dmg = def.dmg || def.baseDamage || 0;
  const base = def.kbBase != null ? def.kbBase : (def.baseKnockback || 0);
  const growth = def.kbGrowth != null ? def.kbGrowth : (def.knockbackGrowth || 0);
  const ko = def.koPower && def.koPower > 0 ? def.koPower : 1;
  const _wraw = target && target._fighterDef && target._fighterDef.weight;
  const _w = (typeof _wraw === 'number' && _wraw > 0 && _wraw < 10) ? _wraw * 100 : (_wraw || 100);
  const weight = _w;
  // fixedKnockback moves skip percent/weight scaling entirely (still shielded
  // and globally scaled, so they sit in the same balance frame as the rest).
  // Standard path: fresh-hit base plus the SOFT-CAPPED growth term. Damage
  // scaling is applied exactly once, here - never in a second system.
  const percentAfter = Math.max(0, (target.percent || 0));
  let kb;
  if (def && def.fixedKnockback != null && def.fixedKnockback >= 0) {
    kb = Math.max(0, def.fixedKnockback) * kbMul * launchMul * KNOCKBACK_GLOBAL_MULTIPLIER;
  } else {
    kb = computeKnockback({ percentAfter, damageDealt: dmg, baseKnockback: base,
      knockbackGrowth: growth, targetWeight: weight,
      attackMultiplier: launchMul * ko, chargeMult });
    kb *= kbMul;
  }
  if (!Number.isFinite(kb)) kb = 0;
  kb = Math.min(KNOCKBACK_MAX, kb);
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
  target._charging = null; // hit cancels any held smash charge
  target._recoveryRamp = 0; // a launch cancels any unfinished lift ramp
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

// Depsey Roll autododge: a buffed boxer with charges left phases through any
// incoming shared-path hit (melee, projectile, finale alike) — no damage, no
// launch, no hitstun — and sidesteps away from the attacker (left or right)
// with brief i-frames so same-volley follow-ups phase through too. One
// charge per dodged hit; ghosts + dodge sting make the phase read. Returns
// true when the hit was eaten.
function tryAutoDodge(target, attacker) {
  const roll = target && target._boxerRoll;
  if (!roll || !(roll.timeLeft > 0) || !(roll.dodgesLeft > 0)) return false;
  roll.dodgesLeft--;
  const dir = attacker && target.x < attacker.x ? -1 : 1;
  target.x = Math.max(40, Math.min(ARENA.width - 40, target.x + dir * 26));
  target.vx = dir * 120;
  target.invulnTimer = Math.max(target.invulnTimer || 0, 0.3);
  try { emitGhost(target); } catch (_) {}
  try { emitGhost(target); } catch (_) {}
  try { SFX.depseyDodge(); } catch (_) {}
  return true;
}

function deliverHit(attacker, target, def, facing, key) {
  if (tryAutoDodge(target, attacker)) return false;
  // Shield Counter answers first (a rooted stance beats a timed tap), then
  // the parry. Either way the incoming hit is fully negated.
  if (tryKnightCounter(target, attacker)) return true;
  // Parried outright: no damage, no knockback, counter bonus armed.
  if (tryKnightParry(target, attacker)) return true;
  // Parry counter bonus: the knight's next connecting attack deals 2x damage
  // and 2x knockback. Applied to a COPY of the row (never the shared table),
  // so resolveHit below and the launch re-resolve in launchFromHit compute the
  // same buffed numbers exactly once per stage — the bonus can never double
  // through the two stages, and charge/weight/percent math is untouched.
  // Consumed here, on the hit that connects (shielded or not); anything that
  // never reaches a target (whiffed swings, dodged phantoms) leaves it armed.
  let effDef = def;
  const pb = attacker && attacker._parryBuff;
  if (pb) {
    const baseDmg = (def.dmg != null ? def.dmg : def.baseDamage) || 0;
    const baseKb = (def.kbBase != null ? def.kbBase : def.baseKnockback) || 0;
    const baseKbG = (def.kbGrowth != null ? def.kbGrowth : def.knockbackGrowth) || 0;
    effDef = { ...def, dmg: baseDmg * 2, kbBase: baseKb * 2, kbGrowth: baseKbG * 2 };
    attacker._parryBuff = null;
    try {
      emitFlash(target.x, target.y - (target.radius || 22), {
        style: fxStyleFor(attacker), radius: (target.radius || 22) * 0.9, life: 0.12, alpha: 0.7, color: '#ffd76a',
      });
    } catch (_) {}
  }
  const shielded = target.shielding && !target.dodging;
  // Royal Guard art: a knight's held block keeps the standard shield
  // reduction — this only paints the restrained shield-hit read.
  if (shielded && isKnight(target)) knightGuardImpact(target);
  // Central pipeline: damage + knockback + hitstun + hitlag resolved once.
  const chargeMult = (attacker && attacker.attack && attacker.attack.chargeMult) || 1;
  const pre = resolveHit({ attacker, target, def: effDef, hitDir: 1, shielded, chargeMult });
  const landedDamage = pre.damage;
  target.percent = pre.percentAfter;
  target._lastHitCharge = chargeMult;

  // Floating damage indicator at the point of impact (tinted per attacker).
  // Shielded hits read as a small cyan number instead of the attacker color.
  spawnDamageNumber(
    target.x + (Math.random() * 20 - 10),
    target.y - target.radius - 8,
    landedDamage,
    shielded ? '#7fd4ff' : (attacker.playerNum === 1 ? '#8fc3ff' : '#ff9d9d')
  );

  const hitDir = resolveHitDir(attacker, target, effDef, facing);

  // Hit-confirm lock: damage lands now, the launch is deferred through a brief
  // freeze of both fighters (see updateHitConfirm).
  if (!shielded && effDef.hitConfirm > 0) {
    interruptTarget(target);
    attachHitLock(attacker, target, effDef, hitDir, effDef.hitConfirm, key);
    // No re-hits and no projectile interference while the lock is live.
    target.invulnTimer = Math.max(target.invulnTimer, effDef.hitConfirm + HIT_FEEDBACK_INVULN);
    attacker._hitRenderTimer = HIT_RENDER_LINGER;
    SFX.hit();
    return true;
  }

  // Shuriken hit-lock: apply normal hit, then lock target for brief period
  // (prevent movement but allow hitstun to expire normally)
  if (!shielded && effDef.hitLockDuration > 0) {
    // Apply normal hit first (damage, knockback, hitstun)
    launchFromHit(attacker, target, effDef, hitDir, shielded, key);

    // A lock that is already running is NEVER extended: a second shuriken
    // that lands mid-lock still deals its damage/knockback above, but the
    // freeze window keeps its original expiry so volleys can't stun-lock.
    if ((target._hitLockTimer || 0) <= 0) {
      const lockDuration = effDef.hitLockDuration;
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

  launchFromHit(attacker, target, effDef, hitDir, shielded, key);
  return true;
}

// Apply the launch portion of a hit: knockback vector + hitstun + air state.
function launchFromHit(attacker, target, def, hitDir, shielded, key) {
  let kbMul = shielded ? COMBAT_CONFIG.shieldKbMul : 1;
  const chargeMult = (attacker && attacker.attack && attacker.attack.chargeMult)
    || target._lastHitCharge || 1;
  // Re-resolve centrally so hitstun/hitlag/angle stay consistent with damage.
  // Percent already includes this hit (deliverHit stamped it), so compute with
  // percentAfter = current percent and damageDealt = last landed damage.
  const lastDmg = Math.min(target.percent, (def.dmg || def.baseDamage || 0) * chargeMult * (shielded ? COMBAT_CONFIG.shieldDamageMul : 1));
  const wraw = target && target._fighterDef && target._fighterDef.weight;
  const w = (typeof wraw === 'number' && wraw > 0 && wraw < 10) ? wraw * 100 : (wraw || 100);
  const nKb = computeKnockback({ percentAfter: target.percent, damageDealt: Math.max(0, lastDmg),
    baseKnockback: def.kbBase != null ? def.kbBase : (def.baseKnockback || 0),
    knockbackGrowth: def.kbGrowth != null ? def.kbGrowth : (def.knockbackGrowth || 0),
    targetWeight: w,
    attackMultiplier: (def.launchMultiplier || 1) * (def.koPower > 0 ? def.koPower : 1),
    chargeMult: shielded ? 1 : chargeMult });
  let kb = nKb * kbMul;
  const angle = resolveAttackAngleDeg(def, { angle: def.angle }, target);
  let { vx, vy } = launchVelocity(kb, angle, hitDir);
  if (def.vyScale != null && Number.isFinite(def.vyScale)) vy *= def.vyScale;
  if (def.spike) vx *= 0.55;
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
  // Slope lives in COMBAT_CONFIG.hitstunPerKB (0.0011): only meaningful hits
  // bridge the 0.83s start-lock, so combos come from heavies and high-percent
  // launches — never jab spam. hitstunMultiplier (per move, default 1)
  // stretches or shrinks the window without touching the launch.
  target.hitstun = computeHitstun(kb, def.hitstunMultiplier || def.hitstunMult || 1);
  target.hitstun = Math.min(HITSTUN_CAP, target.hitstun);
  target.invulnTimer = Math.max(target.invulnTimer, HIT_FEEDBACK_INVULN);
  // Launch/tumble state: persists after hitstun ends, restricts recovery actions
  // but allows DI and air movement. Duration scales with knockback.
  // Base launch time + kb scaling, capped.
  target.launchTimer = Math.min(1.5, 0.3 + kb * 0.0011); // tumble covers the arc
  // Stamp the DI budget: a fresh launch re-arms influence (Fighter.applyDI
  // spends it during the window). Every launch path funnels through here —
  // melee, projectiles, mounts, volleys, deferred hit-confirms alike.
  target._diWindow = DI_WINDOW;
  target._diBudget = DI_MAX_ANGLE;
  // Cinematic hook: record the resolved hit for Special/Finish Zoom + launch
  // trails. Presentation only — the record is consumed by updateCinematic in
  // the main-match loop; sandbox/training never process it. Never throws.
  try {
    notifyCinematicHit({
      attacker, target, def, hitDir, kb, angle,
      x: (attacker.x + target.x) / 2, y: (attacker.y + target.y) / 2,
      shielded: !!shielded, chargeMult,
      targetStocks: target.stocks, targetHitstun: target.hitstun,
    });
  } catch (_) {}

  if (shielded) SFX.deny();
  else SFX.hit();

  // Tiered hit feedback. The hit-stop is gameplay feel and stays; the screen
  // shake and the launch-trail particles that used to sit beside it are gone, so
  // a connecting hit paints nothing.
  if (!shielded) {
    // Central hitlag: scales with damage + launch strength, bounded.
    const hl = computeHitlag(lastDmg, kb, def.hitlagMultiplier || def.hitlagMult || 1);
    if (hl > 0.025) freezeGame(Math.min(0.12, hl));
  }

  // Rendering layering: this fighter is now the attacker and draws in front of
  // the target for the interaction window (Game.js render picks the draw order).
  attacker._hitRenderTimer = HIT_RENDER_LINGER;
}

// Main per-frame advance: finish attack frames, resolve hits, purge leftovers.
export function updateAttacks(fighters, dt) {
  for (const fighter of fighters) {
    if (fighter.attack) advanceAttack(fighter, fighters, dt);
    // Fighter-owned ability state: the boxer's Grab outlives the attack that
    // started it, so it steps here rather than in advanceAttack. Ordered
    // after the attack machine so a cast made this frame is adopted on the
    // same frame it fired. (The Depsey Roll is a buff record, not a
    // stepper — Fighter.js owns its clock.)
    updateBoxerGrab(fighter, fighters, dt);
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

// Arena bounds projectiles care about — matches the 1080×1080 viewport, so
// projectiles die reaching the same off-screen blast edges in every context.
const ARENA = { width: 1080, height: 1080 };

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
// lockstep with the attacks that spawned them.
export function updateProjectiles(fighters, dt) {
  // Clear and rebuild spatial grid for broad-phase collision
  clearGrid();
  // Hoisted to function scope: destructibleList() returns null when the stage
  // has no breakables (the common case), and the same list serves both the
  // grid insert below and the projectile-board test further down. Previously
  // this was declared inside the fighter loop, so the later reference was an
  // out-of-scope ReferenceError whenever a projectile was live.
  const destructibles = destructibleList();
  for (const f of fighters) {
    if (f && f.state !== 'dead') {
      const hb = getHurtbox(f);
      insertObject(f, hb.x + hb.w/2, hb.y + hb.h/2, Math.max(hb.w, hb.h)/2 + 50);
    }
  }
  // Insert destructibles once (not once per fighter) for projectile-board collision
  if (destructibles) {
    for (const d of destructibles) {
      if (!d.dead) {
        insertObject(d, d.x + d.width/2, d.y + d.height/2, Math.max(d.width, d.height)/2);
      }
    }
  }

  updateHorses(fighters);
  // Deadeye runs every frame — including after the triggering attack has ended
  // — until every homing bullet has resolved (see updateDeadeyeCombat).
  for (const f of fighters) {
    if (f._deadeye || f._deadeyePending) updateDeadeyeCombat(f, fighters, dt);
  }

  // Use spatial grid for projectile-fighter collision (broad-phase)
  const nearbyFighters = tempArray32;
  for (const f of fighters) {
    const list = f._projectiles;
    if (!list || !list.length) continue;
    // Reverse swap-remove: O(1) per kill, no dead[] + indexOf/splice.
    for (let _pi = list.length - 1; _pi >= 0; _pi--) {
      const p = list[_pi];
      let _kill = false;
      p.life -= dt;
      if (p.stuck) {
        p.spin = (p.spin || 0) + dt * 26;
        if (p.life <= 0) _kill = true;
      } else {
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.spin = (p.spin || 0) + dt * 18;
        
        // View frustum culling - kill projectiles far off-screen
        if (p.life <= 0 || p.dead || p.x < -200 || p.x > ARENA.width + 200 || p.y > ARENA.height + 300) { 
          _kill = true; 
        }
        
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
            _kill = true;
            break;
          }
        }
        
        if (!_kill) {
          // Broad-phase: query spatial grid for nearby fighters only
          clearTempArray(nearbyFighters);
          queryNearby(p.x, p.y, p.r + 50, nearbyFighters);
          
          for (let i = 0; i < nearbyFighters.length; i++) {
            const t = nearbyFighters[i];
            if (!t || t === p.owner || t.state === 'dead' || t.invulnTimer > 0) continue;
            const hb = getHurtbox(t);
            const pxPlusR = p.x + p.r;
            const pxMinusR = p.x - p.r;
            const pyPlusR = p.y + p.r;
            const pyMinusR = p.y - p.r;
            if (pxPlusR < hb.x || pxMinusR > hb.x + hb.w ||
                pyPlusR < hb.y || pyMinusR > hb.y + hb.h) continue;
            // Projectiles carry their own full damage/knockback def (set at spawn).
            applyAbilityHit(p.owner, t, p.def, p.facing);
            if (p.def && p.def.hitLockDuration > 0) {
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
      }
      if (_kill) {
        list[_pi] = list[list.length - 1];
        list.pop();
      }
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
    const _wt = fighter._fighterDef && fighter._fighterDef.weight;
    ctx.fillText(`${fighter.percent.toFixed(0)}%${_wt ? ' W' + _wt : ''}`, fighter.x, hurt.y + hurt.h + 13);

    // Anatomical hand labels (L / R) so the facing-turn hand switch is readable
    // at a glance. `_handWorld` is written every draw by drawFighter.
    const hw = fighter._handWorld;
    if (hw) {
      ctx.font = 'bold 12px Consolas, "Courier New", monospace';
      const tag = (h, txt) => {
        if (!h) return;
        ctx.fillStyle = '#00e5ff';
        ctx.beginPath();
        ctx.arc(h.x, h.y, 3.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#001f26';
        ctx.fillText(txt, h.x, h.y - 8);
        ctx.fillStyle = '#00e5ff';
        ctx.strokeStyle = '#001f26';
        ctx.lineWidth = 3;
        ctx.strokeText(txt, h.x, h.y - 8);
        ctx.fillText(txt, h.x, h.y - 8);
        ctx.lineWidth = 2;
      };
      tag(hw.left, 'L');
      tag(hw.right, 'R');
      ctx.font = '11px Consolas, "Courier New", monospace';
    }

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
      const _cat = a.def.category || (a.key && /smash/.test(a.key) ? 'smash' : '');
      ctx.fillText(`${a.def.name}${_cat ? ' [' + _cat + ']' : ''}`, fighter.x, fighter.y - fighter.radius - 42);
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


// ── merged from content/Menu.js ──
// Menu.js — fighter roster for the movement sandbox. The canvas title/char-select
// screens are gone (the terminal overlay in index.html handles selection); this
// module only supplies the roster data and the saved skin-scale lookups.


// All available fighters.
// Balance: runSpeed ×0.60 then §22 ×1.15 (103→118, 120→138), then §46 ×0.60
// (118→71, 138→83) alongside Fighter.js. Jump forces untouched — vertical
// mobility + recovery stay responsive.
export const ALL_FIGHTERS = [
  {
    id: 'cowboy',
    name: 'Cowboy',
    color: '#c8a24a',
    skin: '/GA/skins/cowboy.png',
    skinScale: 0.85,
    weight: 100,
    radius: 31.2,
    runSpeed: 71,
    jumpForce: 712,
    // Per-character physics config (all neutral = shared constants; tune per
    // fighter without touching Fighter.js): gravity/terminal/air-control
    // feel, recovery lift, and extra launch dampening on top of weight.
    // Recovery config: strength (vertical lift), range (horizontal reach),
    // cooldown (seconds between recovery uses).
    gravityMul: 1.0,
    fallMaxMul: 1.0,
    airAccelMul: 1.0,
    recoveryMul: 1.0,
    launchResist: 1.0,
    recoveryStrength: 1.0,
    recoveryRange: 1.0,
    recoveryCooldown: 0,
  },
  {
    id: 'ninja',
    name: 'Ninja',
    color: '#2c3e50',
    skin: '/GA/skins/ninga.png',
    skinScale: 0.85,
    weight: 100, // Middleweight — same launch resistance as the cowboy
    radius: 31.2,
    runSpeed: 83,  // Faster (still the faster fighter)
    jumpForce: 750, // Higher jump
    gravityMul: 1.0,
    fallMaxMul: 1.0,
    airAccelMul: 1.0,
    recoveryMul: 1.0,
    launchResist: 1.0,
    recoveryStrength: 1.1,  // Ninja has strong recovery
    recoveryRange: 1.2,     // Good horizontal recovery reach
    recoveryCooldown: 0,
  },
  // Boxer — the third fighter, appended last so the existing roster indices (and
  // everything that walks the list in order) are unchanged.
  //
  // Deliberately the SLOWEST fighter on both axes: runSpeed below even the
  // cowboy's, and the lowest jump force of the three. What it trades mobility
  // for is committed damage — see BOXER_ATTACKS in combat.js, where the smashes
  // out-hit both existing characters in exchange for long recovery.
  //
  // No `attacks` entry: it uses the BOXER_ATTACKS table, picked by id in
  // attacksFor, the same way the ninja is.
  //
  // No `handGear`: every fighter comes out bare-fisted. (Clean-slate rule —
  // no character ships with built-in hand gear; anything equipped later comes
  // only from the Hand Weapons editor.)
  {
    id: 'boxer',
    name: 'Boxer',
    color: '#c62828',
    skin: '/GA/skins/boxer.png',
    skinScale: 0.85,
    weight: 122,     // Heavyweight — launched ~15% softer than mid
    radius: 31.2,
    runSpeed: 63,     // Slowest
    jumpForce: 690,     // Lowest jump
    gravityMul: 1.0,
    fallMaxMul: 1.0,
    airAccelMul: 1.0,
    recoveryMul: 1.0,
    launchResist: 1.0,
    recoveryStrength: 0.85, // Boxer has weaker recovery
    recoveryRange: 0.85,    // Limited horizontal reach
    recoveryCooldown: 0,
  },
  // Knight — the fourth fighter, appended last so the existing roster indices
  // (and everything that walks the list in order) are unchanged.
  //
  // Balanced defensive sword-and-shield fighter: midweight verging heavy,
  // moderate run speed and jump, and a stronger-than-average aerial-light
  // recovery (the Heroic Ascent rides the shared aerial-light recovery
  // mechanic — one rising slash per airtime, recharged on ground touch).
  //
  // No `attacks` entry: it uses the KNIGHT_ATTACKS table, picked by id in
  // attacksFor, the same way the ninja and boxer are.
  //
  // No `heldWeapons` for now: the persistent lead-sword + trailing-shield
  // equipment was removed so the Knight fights (and previews) with bare hands,
  // which lets fist gear be seen and edited on both hands. Attacks are still
  // animation-driven, so combat is unchanged; re-add a `heldWeapons` array here
  // to bring the persistent equipment back. The universal held-weapons layer
  // (Effects.js) remains and works for any fighter that defines one.
  {
    id: 'knight',
    name: 'Knight',
    color: '#8fa3b8',
    skin: '/GA/skins/knight.png',
    skinScale: 0.85,
    weight: 112,     // Mid-heavy — launched a touch softer than mid
    radius: 31.2,
    runSpeed: 66,    // Moderate: between cowboy and boxer
    jumpForce: 700,  // Moderate jump
    gravityMul: 1.0,
    fallMaxMul: 1.0,
    airAccelMul: 1.0,
    recoveryMul: 1.0,
    launchResist: 1.0,
    recoveryStrength: 1.25, // Heroic Ascent: strong rising recovery
    recoveryRange: 1.0,
    recoveryCooldown: 0,
  },
];

// Statis stage list for the sandbox (single arena layout).
export const STAGES = [
  { id: 'battlefield', name: 'Battlefield', icon: '🌿' },
];

// Cached skin lookup used by the terminal previews.
let resolveSkinCache = {};
export function resolveSkinCached(path) {
  if (!path) return null;
  const cached = resolveSkinCache[path];
  if (cached && (cached.loaded || cached.failed)) return cached;
  const entry = getSkinImage(path);
  if (!entry) return null;
  const out = { loaded: entry.status === 'loaded', img: entry.img, name: path };
  if (out.loaded) resolveSkinCache[path] = out;
  return out;
}


// ── merged from fighter/session.js ──
// session.js — the shared per-frame roster step.
//
// The competitive match (Game.js) and the Sandbox (sandbox.js)
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

// Shared no-input triple for HUMAN slots. inputForSlot returns null for a
// human fighter, and the movement step used to substitute a fresh `{}` for
// that null — one throwaway object per human fighter per frame, handed
// straight to handleFighterInput which reads `input.isHeld || ...` off it and
// never uses anything else. This record is never mutated.
const NO_INPUT = { isHeld: null, isJustPressed: null, isJustReleased: null };

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
    handleFighterInput(f, stage, dt, inputFor(f, i) || NO_INPUT);
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
    f._dt = dt; // Pass dt for launchTimer decay in updateFighterState
    updateFighterState(f);
    updateHandOrbit(f, dt); // Shared hand-orbit angle (facing-turn travel)
    // While the animator owns the hands the held layer is hidden, so a facing
    // change mid-animation would leave held-weapon rotation stale and sweep
    // on release — keep it snapped to live facing (same condition drawFighter
    // uses to pick the animated path).
    if (f.anim && f.anim.out && (f.anim.animId || f.anim.playing || f.anim.blendFrom)) syncHeldRotSnap(f);
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
  // Held-guard pose: the shared weaponless base 'shield' for everyone — the
  // knight fights bare-handed like the boxer.
  if (f.shielding) return 'shield';
  if (f.attack) {
    // The attack animation plays for the WHOLE attack — startup, active AND
    // recovery — so gameplay poses match the Hand Animator frame for frame.
    // Hitboxes still arm and expire on phase (recovery hits nothing); only
    // the hands follow the authored motion to its end instead of snapping
    // back to idle the instant the hitbox is gone.
    return f.attack.def.anim || null;
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
  f._floorY = null; // re-pinned to the new floor on first ground touch
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
  f._recoveryRamp = 0;
  f.jumpsUsed = 0;
  f.fastFalling = false;
  f.freeFall = false;
  f.coyoteTimer = 0;
  f.jumpBufferTimer = 0;
  f.wasGrounded = false;
  f.launchTimer = 0; // Reset launch/tumble state on respawn
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
  // Same for the knight's parry state: no live window, no banked counter
  // bonus, no stale shield edge after a respawn.
  f._parryWindow = 0;
  f._parryBuff = null;
  f._prevShieldHeld = false;
  // ...and no live counter stance either.
  f._knightCounter = 0;
  f._counterResolving = false;
}
