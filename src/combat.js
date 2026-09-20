// combat.js — data-driven melee foundation for the movement arena.
//
// Flow per frame:    Movement / physics → grounded resolve
//                    → combatInput (a fresh press — or a buffered press — starts
//                      a new attack instance, capturing type/direction/facing)
//                    → Attack frame machine (startup → active → recovery)
//                    → Hitbox spawn / position / collision
//                    → Hit resolution (percent / knockback / hitstun)
//                    → Cleanup (no lingering hitboxes)
//
// The model is deliberately simple:
//   - One hurtbox per fighter (a square from their ball radius).
//   - Hitbox = a rect defined by attack data, mirrored by facing.
//   - One shared hitbox registry, cleaned up every frame.
//
// Future characters only need to define `character.attacks` — the same engine
// executes them. No character-specific collision code anywhere.

import { isHeld, isJustPressed } from './Input.js';
import { SFX } from './Engine.js';
import { getAnimationRaw } from './anim/library.js';
import { getAbility } from './abilities.js';
import { getCustomHitboxes } from './hitboxData.js';

// One frame of committed action. The attack still plays out startup → active →
// recovery even if it whiffs — a missed heavy attack is punishable.
const HITSTUN_CAP = 0.55;   // seconds, strongest smash ≈ 0.4
// Tiny post-hit grace (~2 frames). Re-hits are already prevented per-attack by
// the shared `hitIds` set — this only stops two hitboxes from resolving onto
// the same target in the same moment, without gating combo pressure.
const HIT_FEEDBACK_INVULN = 0.03;

// After a successful hit the attacker renders ON TOP of the knocked-away
// target for this window (see Game.js render). Simple, facing-agnostic rule:
// whoever most recently landed a hit draws last while their timer is alive.
const HIT_RENDER_LINGER = 0.28;

// Input buffering: a light/heavy press made just before the current attack or
// dodge ends is remembered and executed on the first free frame (~5 frames ≈
// 83ms). Buffering only covers "I want to act very soon" — it is never set or
// honored while in hitstun, and it never queues an input indefinitely.
const BUFFER_FRAMES = 5;

// Snapshot the currently held directions so the attack side is fixed at the
// exact moment the attack button is pressed — never resolved later from a
// direction that may have changed.
function readDir(p) {
  return {
    up: isHeld(p, 'up'),
    down: isHeld(p, 'down'),
    left: isHeld(p, 'left'),
    right: isHeld(p, 'right'),
  };
}

// ── Attack definitions — the whole moveset is data, not code ─────────────
// Frames are 1-indexed at 60fps. Positions are relative to the attacker's
// center: `ox` mirrors with facing, `oy` is vertical offset (+ = below).
// Angle in degrees: 0 = straight forward, positive tilts up, negative tilts
// down (Canvas Y increases downward).
//
// Hitboxes are intentionally GENEROUS — this is a fun platform-fighter, not a
// pixel-precise 2D fighter. Each hitbox is tuned so it visually anchors to the
// player's body and reaches clearly toward the attack direction, so a melee
// attack connects without pixel-perfect spacing. The reach is the player→hitbox
// relationship: the farther the intended range, the farther `ox`/`oy` push it.
// The `anim` id connects each attack to the Hand/Weapon Animator animation that
// drives the character's hands while this attack plays (library.js). It is pure
// metadata — no combat behaviour depends on it.
//
// The HEAVY attacks (neutral/side/up/down smash — the `special` type) have
// startup: 0 on purpose: their damaging hitbox must be live on the very same
// game update as the input press. The active window then runs its normal frame
// count and hot-swaps to recovery (hitbox deactivated) the instant it ends.
//
// `anim` is pure visual metadata: which of the library's SEVEN base animations
// drives the hands while the attack plays. Every attack maps to one of the
// seven (Neutral Light/Heavy, Forward Light/Heavy, Aerial Light/Heavy,
// Shield/Blocking); up/down/back variants reuse the closest of those poses.
const DEFAULT_ATTACKS = {
  jab:    { name: 'Jab',          anim: 'jab',    startup: 3,  active: 5,  recovery: 8,  dmg: 3,  kbBase: 90,  kbGrowth: 0.8, angle: 15,  w: 60, h: 32, ox: 42,  oy: -4 },
  nsmash: { name: 'Neutral Smash',anim: 'nsmash', startup: 0,  active: 6,  recovery: 24, dmg: 14, kbBase: 280, kbGrowth: 1.6, angle: 30,  w: 82, h: 40, ox: 46,  oy: -4 },
  ftilt:  { name: 'Side Tilt',    anim: 'ftilt',  startup: 5,  active: 5,  recovery: 12, dmg: 7,  kbBase: 170, kbGrowth: 1.1, angle: 35,  w: 76, h: 36, ox: 54,  oy: -4 },
  fsmash: { name: 'Side Smash',   anim: 'fsmash', startup: 0,  active: 6,  recovery: 28, dmg: 16, kbBase: 330, kbGrowth: 1.9, angle: 38,  w: 92, h: 44, ox: 66,  oy: -4 },
  utilt:  { name: 'Up Tilt',      anim: 'nair',   startup: 5,  active: 5,  recovery: 12, dmg: 6,  kbBase: 150, kbGrowth: 1.0, angle: 75,  w: 50, h: 60, ox: 8,   oy: -46 },
  usmash: { name: 'Up Smash',     anim: 'nsmash', startup: 0,  active: 7,  recovery: 26, dmg: 15, kbBase: 300, kbGrowth: 1.8, angle: 88,  w: 70, h: 80, ox: 4,   oy: -68 },
  dtilt:  { name: 'Down Tilt',    anim: 'ftilt',  startup: 4,  active: 5,  recovery: 10, dmg: 5,  kbBase: 130, kbGrowth: 1.0, angle: -30, w: 68, h: 28, ox: 36,  oy: 12 },
  dsmash: { name: 'Down Smash',   anim: 'nsmash', startup: 0,  active: 6,  recovery: 26, dmg: 14, kbBase: 310, kbGrowth: 1.8, angle: -45, w: 74, h: 36, ox: 50,  oy: 16, bothSides: true },
  nair:   { name: 'Neutral Air',  anim: 'nair',   startup: 5,  active: 8,  recovery: 13, dmg: 7,  kbBase: 160, kbGrowth: 1.2, angle: 72,  w: 66, h: 64, ox: 0,   oy: 0, air: true },
  fair:   { name: 'Forward Air',  anim: 'fair',   startup: 6,  active: 7,  recovery: 15, dmg: 9,  kbBase: 200, kbGrowth: 1.4, angle: 30,  w: 70, h: 38, ox: 50,  oy: -2, air: true },
  bair:   { name: 'Back Air',     anim: 'fair',   startup: 7,  active: 7,  recovery: 17, dmg: 10, kbBase: 220, kbGrowth: 1.5, angle: -12, w: 70, h: 40, ox: -48, oy: 0, air: true },
  uair:   { name: 'Up Air',       anim: 'nair',   startup: 5,  active: 8,  recovery: 13, dmg: 8,  kbBase: 180, kbGrowth: 1.3, angle: 85,  w: 62, h: 62, ox: 4,   oy: -40, air: true },
  // The Cowboy's down-air is a hit-confirm launcher: the strike connects, both
  // fighters freeze for `hitConfirm` seconds, then the stored knockback launches
  // the target UP (the attack's angle) into a normal hitstun. `dive` drives the
  // attacker down while the hitbox is live, so the move is a real descending
  // stomp instead of a hover.
  dair:   { name: 'Down Air',     anim: 'fair',   startup: 7,  active: 7,  recovery: 17, dmg: 10, kbBase: 170, kbGrowth: 1.6, angle: 88, koPower: 3, w: 60, h: 46, ox: 6,   oy: 48, hitConfirm: 0.12, dive: 950, air: true },
  dash:   { name: 'Dash',         anim: 'dash',   startup: 0,  active: 8,  recovery: 10, dmg: 5,  kbBase: 130, kbGrowth: 0.9, angle: 20,  w: 100, h: 50, ox: 50,  oy: 0 },
};

function attacksFor(fighter) {
  return (fighter._fighterDef && fighter._fighterDef.attacks) || DEFAULT_ATTACKS;
}

// ── Per-animation combat data ─────────────────────────────────────────────
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
// one for animator-only animations) overlaid with combat data. Not cached —
// it runs only at attack start, and caching risks stale data after a save.
//
// `attackKey` is the input-selected attack id (e.g. 'dair'). Several attacks
// share one library animation (`anim`), but the Hitbox Customizer store is
// keyed by the ATTACK id so up/back/down variants can each own a box. When no
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
  const custom = charId ? getCustomHitboxes(charId, attackKey || anim.id) : null;
  if (custom !== null) {
    // A stored entry is authoritative — including an explicit empty list,
    // which means "this move deliberately has no hitbox".
    return mergeHitboxDef(fighter, anim, custom, null, attackKey);
  }
  if (!anim.combat || !anim.combat.type) return null;
  const combat = anim.combat;
  // Prefer the attack-keyed table entry (up/back/down attacks share one anim,
  // so the shared-anim lookup would pick the wrong variant's phases/recovery).
  const base = (attackKey && (attacksFor(fighter) || {})[attackKey]) || getAttackDefForAnimId(anim.id, fighter);

  if (combat.type === 'hitbox') {
    const hbs = Array.isArray(combat.hitboxes) ? combat.hitboxes : (combat.hitbox ? [combat.hitbox] : []);
    return mergeHitboxDef(fighter, anim, hbs, combat, attackKey);
  }

  if (combat.type === 'nonHitbox') {
    const out = base ? { ...base } : {
      name: anim.name || anim.id,
      anim: anim.id,
      startup: 0, active: 0, recovery: 0,
      dmg: 0, kbBase: 0, kbGrowth: 0, angle: 0,
      w: 40, h: 40, ox: 0, oy: 0,
    };
    out.abilityType = 'nonHitbox';
    out.abilityId = combat.abilityId || null;
    out.abilityCfg = combat.cfg || {};
    const ab = getAbility(out.abilityId);
    if (ab) {
      out.abilityFrames = ab.frames;
      out.abilityCastFrame = ab.castFrame || 1;
    } else {
      out.abilityFrames = Math.max(6, base ? base.startup + base.active + base.recovery : 18);
      out.abilityCastFrame = 1;
    }
    return out;
  }

  return base;
}

// Effective attack definition for a specific attack id (e.g. 'dair') — the
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
  const hbs = (hbsSrc || []).map(hb => {
    if (!hb) return null;
    const n = { ...hb };
    if (n.startFrame == null) n.startFrame = n.startup != null ? n.startup : 0;
    if (n.duration == null) n.duration = n.active != null ? n.active : 4;
    return n;
  }).filter(Boolean);
  // Keep the explicit list — an EMPTY list means "this attack has no hitbox"
  // (a deliberately de-hitspaced swing), never a silent fallback to stray values.
  out.hitboxes = hbs;
  if (hbs.length) {
    const first = hbs[0];
    // keep top-level hitbox fields for code that expects a single hitbox
    for (const k of ['w','h','ox','oy','dmg','kbBase','kbGrowth','angle']) {
      if (first[k] != null) out[k] = first[k];
    }
  }
  // Attack phase timing is derived from the union of the hitbox windows so
  // the active phase always covers exactly the damaging frames; explicit
  // combat.startup/active override it. Recovery is the one phase that is not
  // represented by a window — it is preserved from the base attack so a
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

// The hitboxes a def actually spawns: an explicit array is authoritative (even
// an empty one — "deliberately no hitbox"); a plain attack def with no
// `hitboxes` member is its own single box (the pre-animator default case).
export function hitboxList(def) {
  if (def && Array.isArray(def.hitboxes)) return def.hitboxes;
  return def ? [def] : [];
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

// ── Hitbox registry (shared, cleaned up every frame) ──────────────────────
const hitboxes = new Map(); // id → { id, owner, def, facing, active, x, y, w, h, hitIds }
let nextHitboxId = 1;

// Freelists — light attacks can chain dozens of hitboxes + per-attack hit Sets
// + attack objects per minute. Reusing instead of reallocating keeps repeated
// attacks allocation-free. Objects on a freelist hold no live references (their
// def/hitIds are nulled on release and rewritten on the next take).
const _hitboxPool = [];
const _hitIdPool = [];
const _attackPool = [];

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
  fighter.attack = null;
  a.def = null;
  a.hitIds = null;
  a.hitboxIds = null;
  _attackPool.push(a);
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
}

// Temporary diagnostic: live hitbox registry snapshot ({probe} tests).
export function __debugHitboxes() {
  return [...hitboxes.values()].map(h => ({
    x: +h.x.toFixed(1), y: +h.y.toFixed(1), w: h.w, h: h.h,
    active: h.active, owner: h.owner.playerNum,
  }));
}

// ── Hurtbox: one AABB per fighter, from their ball radius ────────────────
export function getHurtbox(fighter) {
  // Reuse a cached object to avoid per-frame allocations during collision checks.
  if (!fighter._hurtbox) fighter._hurtbox = { x: 0, y: 0, w: 0, h: 0 };
  const h = fighter._hurtbox;
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

// ── Input → Attack selection ─────────────────────────────────────────────
// Grounded:  (no dir / side / up / down) × (light / heavy)
// Airborne:  no dir → nair · facing-relative → fair/bair · up → uair · down → dair
// `type` is 'attack' (light) or 'special' (heavy). When given, the press is
// already known (e.g. from the input buffer); otherwise it reads fresh presses.
// `dir` is an optional direction snapshot captured at press time — when present
// it fully determines the attack side, so a direction changed after the press
// (or a direction resolved several frames later) never affects the attack.
function selectAttack(fighter, type, dir) {
  const p = fighter.playerNum;
  const light = type ? type === 'attack' : isJustPressed(p, 'attack');
  const heavy = type ? type === 'special' : isJustPressed(p, 'special');
  if (!light && !heavy) return null;

  const dirs = dir || readDir(p);
  const up = dirs.up;
  const down = dirs.down;
  const left = dirs.left;
  const right = dirs.right;
  const attacks = attacksFor(fighter);

  if (!fighter.grounded) {
    const facing = fighter.facingRight ? 1 : -1;
    if (up) return { key: 'uair', def: attacks.uair, variant: 'up', dir: dirs };
    if (down) return { key: 'dair', def: attacks.dair, variant: 'down', dir: dirs };
    if (left || right) {
      const forward = (facing === 1 && right && !left) || (facing === -1 && left && !right);
      return forward
        ? { key: 'fair', def: attacks.fair, variant: 'fwd', dir: dirs }
        : { key: 'bair', def: attacks.bair, variant: 'back', dir: dirs };
    }
    return { key: 'nair', def: attacks.nair, variant: 'neutral', dir: dirs };
  }

  // Dash attack: attacking during a dash burst lunges forward with the dash
  // attack's hitbox — the same animator-customizable source as every other
  // attack. Custom fighter attack tables can override it; the built-in
  // fallback always exists.
  if (fighter.dashing) return { key: 'dash', def: attacks.dash || DEFAULT_ATTACKS.dash, variant: 'side', dir: dirs };

  if (up) return { key: light ? 'utilt' : 'usmash', def: light ? attacks.utilt : attacks.usmash, variant: 'up', dir: dirs };
  if (down) return { key: light ? 'dtilt' : 'dsmash', def: light ? attacks.dtilt : attacks.dsmash, variant: 'down', dir: dirs };
  if (left || right) return { key: light ? 'ftilt' : 'fsmash', def: light ? attacks.ftilt : attacks.fsmash, variant: 'side', dir: dirs };
  return { key: light ? 'jab' : 'nsmash', def: light ? attacks.jab : attacks.nsmash, variant: 'neutral', dir: dirs };
}

// Start a new attack instance. The attack takes over control until it finishes:
// no cancels, no restarts, no mid-swing redirection.
function startAttack(fighter, sel) {
  const { def, variant, key } = sel;
  const dir = sel.dir || { left: false, right: false };
  let facing = fighter.facingRight ? 1 : -1;

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
  attr.frame = 0;
  attr.phase = 'startup';
  attr.facing = facing;
  attr.abilityType = rdef.abilityType || 'hitbox';
  attr.abilityId = rdef.abilityId || null;
  attr.castFrame = rdef.abilityCastFrame || 1;
  attr.abilityCastDone = false;
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
}

function variantForKey(key) {
  if (/^(utilt|usmash|uair)$/.test(key)) return 'up';
  if (/^(dtilt|dsmash|dair)$/.test(key)) return 'down';
  if (/^(ftilt|fsmash|fair)$/.test(key)) return 'side';
  if (key === 'bair') return 'back';
  return 'neutral';
}

// [PROBE] Deterministic test-only entry: start a specific attack key with an
// explicit direction snapshot, exactly as selectAttack→startAttack would for a
// fresh press of that move. Used by the runtime verification suite to exercise
// up/back variants that the keyboard path can't reliably produce (up is also the
// jump binding and holding back physically turns the fighter around).
export function startAttackForKey(fighter, key, dirOverride) {
  if (!fighter || !key) return false;
  const def = attacksFor(fighter)[key];
  if (!def) return false;
  startAttack(fighter, {
    key,
    def,
    variant: variantForKey(key),
    dir: dirOverride || { up: false, down: false, left: false, right: false },
  });
  return true;
}

// Call once per frame, AFTER movement/physics/grounding have resolved (so the
// grounded/airborne check is the one the player is actually in right now) and
// right BEFORE attack frames advance (so a press starts counting this frame).
//
// This is the ONE attack-entry path: nothing else in the codebase sets
// `fighter.attack`.
export function combatInput(fighters) {
  for (const fighter of fighters) {
    fighter.shielding = isHeld(fighter.playerNum, 'shield');

    // Age any queued attack press. The buffer lives exactly BUFFER_FRAMES
    // updates and dies naturally.
    if (fighter.attackBuffer) {
      fighter.attackBuffer.frames--;
      if (fighter.attackBuffer.frames <= 0) fighter.attackBuffer = null;
    }

    const busy = fighter.hitstun > 0 || fighter.attack || fighter.dodging || fighter._hitLock != null;

    if (busy) {
      // Queue a press made while mid-swing / mid-dodge so it fires the moment
      // the fighter is free again. Never queue during hitstun (buffering must
      // not bypass hitstun), and don't overwrite a queued input. The direction
      // is snapshotted NOW so the buffered attack's side is already decided.
      if (fighter.hitstun <= 0 && !fighter.attackBuffer) {
        const p = fighter.playerNum;
        if (isJustPressed(p, 'attack')) fighter.attackBuffer = { type: 'attack', frames: BUFFER_FRAMES, dir: readDir(p) };
        else if (isJustPressed(p, 'special')) fighter.attackBuffer = { type: 'special', frames: BUFFER_FRAMES, dir: readDir(p) };
      }
      continue;
    }

    // A queued press executes on the first free frame, ahead of fresh presses.
    // The direction was captured when the press was buffered (buf.dir).
    if (fighter.attackBuffer) {
      const buf = fighter.attackBuffer;
      const sel = selectAttack(fighter, buf.type, buf.dir);
      fighter.attackBuffer = null;
      if (sel) startAttack(fighter, sel);
      continue;
    }

    const sel = selectAttack(fighter);
    if (sel) startAttack(fighter, sel);
  }
}

// ── Attack frame machine ────────────────────────────────────────────────
// startup → active → recovery → finished. A whiffed attack STILL plays its
// full recovery; the hitbox only exists during the active window.
function advanceAttack(fighter, fighters) {
  const a = fighter.attack;
  const def = a.def;
  if (a.abilityType === 'nonHitbox') return advanceNonHitbox(fighter, fighters);
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
      a.spawnedHitboxes = new Set();
    } else if (phase === 'recovery') {
      // Recovery: no damaging collision whatsoever.
      for (const id of a.hitboxIds) {
        const hb = hitboxes.get(id);
        if (hb) hb.active = false;
      }
    }
  }

  if (phase === 'finished') {
    destroyAttackHitboxes(fighter); // also releases the attack object
    return;
  }

// During the active window, spawn each hitbox exactly when its per-hitbox
    // startFrame/duration window begins, then keep it positioned.
    if (a.phase === 'active') {
      // Hitbox timing is stored in ABSOLUTE animation-timeline frames — the same
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
        // the whole active phase — [startup, startup+active) — or attacks whose
        // startup >= active would never spawn a damaging box at all.
        const start = hb.startFrame != null ? hb.startFrame : (def.startup != null ? def.startup : 0);
        const dur = hb.duration != null ? hb.duration : def.active;
        if (t >= start && t < start + dur) {
          for (const facing of def.bothSides ? [a.facing, -a.facing] : [a.facing]) {
            a.hitboxIds.push(registerHitbox(fighter, hb, facing, a.hitIds).id);
          }
          if (!a.spawnedHitboxes) a.spawnedHitboxes = new Set();
          a.spawnedHitboxes.add(i);
        }
      }
      for (const id of a.hitboxIds) {
        const hb = hitboxes.get(id);
        if (hb && hb.active) positionHitbox(hb, fighter, hb.facing, hb.def);
      }

      // A diving attack (the Cowboy's down-air) drives the attacker downward for
      // real — not just in the animation. Applied as a speed floor so it can only
      // speed a fall up, never fight gravity on the way out. Cleared during hit-confirm
      // lock so both fighters are frozen in place.
      if (def.dive && !fighter.grounded && fighter.vy < def.dive && !fighter._hitLock) {
        fighter.vy = def.dive;
      }
    }
}

// Non-hitbox attacks never register a hitbox: the ability fires exactly once
// at castFrame and the attack holds for totalFrames. `phase` is 'startup'
// until the cast, 'active' after — never 'recovery' — so the animation plays
// for the full ability duration.
function advanceNonHitbox(fighter, fighters) {
  const a = fighter.attack;
  a.frame++;
  if (a.frame >= a.castFrame && !a.abilityCastDone) {
    a.abilityCastDone = true;
    runAbility(fighter, a, fighters);
  }
  a.phase = a.frame >= a.castFrame ? 'active' : 'startup';
  if (a.frame >= a.totalFrames) destroyAttackHitboxes(fighter);
}

// Reused context object — no allocation per cast.
const _abilityCtx = { fighters: null };

function runAbility(fighter, a, fighters) {
  const ab = getAbility(a.abilityId);
  if (!ab) return;
  _abilityCtx.fighters = fighters;
  ab.run(fighter, a, a.def.abilityCfg || {}, _abilityCtx);
  _abilityCtx.fighters = null;
}

// ── Collision + hit resolution ───────────────────────────────────────────
let _anyHitboxActive = false;

function resolveHits(fighters) {
  if (hitboxes.size === 0) return;
  _anyHitboxActive = false;
  for (const hb of hitboxes.values()) {
    if (!hb.active) continue;
    _anyHitboxActive = true;
    const attacker = hb.owner;
    for (const target of fighters) {
      if (!target || target === attacker) continue;
      if (target.invulnTimer > 0) continue;
      if (hb.hitIds.has(target.id)) continue;
      if (aabb(hb, getHurtbox(target))) {
        hb.hitIds.add(target.id);
        applyHit(attacker, target, hb);
      }
    }
  }
}

function applyHit(attacker, target, hb) {
  deliverHit(attacker, target, hb.def, hb.facing);
}

// Shared hit resolution — used by melee hitboxes and ability projectiles so a
// projectile connects with exactly the same damage/knockback/hitstun rules.
export function applyAbilityHit(attacker, target, def, facing) {
  deliverHit(attacker, target, def, facing);
}

// ── Cowboy launcher (per-character knockback override) ───────────────────
// ONLY the Cowboy's down-air is a launcher: on a confirmed (unshielded) connect
// the target is knocked SHARPLY upward with very high vertical knockback, like
// a Smash-style launcher. Every other move keeps its raw per-attack angle and
// knockback — the down-air is identified by its defining fields (hitConfirm
// lock + dive), which nothing else on the roster uses.
// This is a purely per-character override applied INSIDE the central knockback
// path (launchFromHit), so there is no second knockback implementation:
//   - the fully-computed knockback (damage/base/growth/percent/weight already
//     folded into `kb`) is boosted by kbMul,
//   - the launch angle is forced to COWBOY_LAUNCH.angle (near-vertical up),
//   - %-scaling, weight, hitstun, hit effects and hit-confirm timing all keep
//     working exactly as the shared calculator defines them.
// Any other fighter — or any other Cowboy move — has no entry and keeps its raw
// per-attack angles.
const COWBOY_LAUNCH = { angle: 85, kbMul: 2.1 };
function isDownAirHit(def) {
  return !!(def && def.hitConfirm > 0 && def.dive > 0);
}
function cowboyLaunchFor(attacker, def) {
  if (attacker && attacker._fighterDef && attacker._fighterDef.id === 'cowboy' && isDownAirHit(def)) return COWBOY_LAUNCH;
  return null;
}

// ── Damage + knockback calculator (central) ──────────────────────────────
// One shared rule for every hit in the game — melee hitboxes and ability
// projectiles all resolve through deliverHit. The shape follows COMBAT.txt §6:
//   kb = (dmg * 7 + (kbBase + kbGrowth * defenderPercent))
//        * (1 + defenderPercent / 80) * koPower / defenderWeight
// Damage (the percent meter) and knockback are separate concepts: damage is
// added to the target's meter, knockback is a launch vector derived from the
// target's NEW percent, the attack's base/growth/angle, koPower and weight.
//
// Weight comes from the character roster (documented range 0.85–1.25). Missing
// or out-of-range values fall back to 1.0 so an unset field never explodes.
function targetWeight(target) {
  const w = target && target._fighterDef && target._fighterDef.weight;
  if (typeof w === 'number' && w >= 0.85 && w <= 1.25) return w;
  return 1.0;
}

// Horizontal launch direction: targets launch AWAY from the attacker. Derived
// from the target's side relative to the attacker at hit time — never from the
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
function computeKnockbackVector(target, def, opts) {
  const hitDir = opts.hitDir || 1;
  const kbMul = opts.kbMul || 1;
  const angle = opts.angle != null ? opts.angle : def.angle; // launch-angle override (Cowboy launcher)
  const percent = target.percent;
  const dmg = def.dmg || 0;
  const base = def.kbBase || 0;
  const growth = def.kbGrowth || 0;
  const ko = def.koPower && def.koPower > 0 ? def.koPower : 1;
  const weight = targetWeight(target);
  const raw = (dmg * 7 + (base + growth * percent)) * (1 + percent / 80) * ko / weight;
  const kb = Math.max(0, raw) * kbMul;
  const rad = ((angle || 0) * Math.PI) / 180;
  let vx = Math.cos(rad) * kb * hitDir;
  // Canvas Y increases downward, so a positive angle is an upward launch.
  let vy = -Math.sin(rad) * kb;
  if (def.spike) vx *= 0.55; // spike: launch mostly straight down
  return { vx, vy, kb };
}

// ── Hit-confirm lock ──────────────────────────────────────────────────────
// `hitConfirm` attacks (the Cowboy's down-air) defer their knockback: on a
// successful hit both fighters freeze in place for the lock duration, then the
// stored knockback launches the target exactly as a normal hit would. The lock
// object looks the same on both sides:
//   { attacker|target: null|fighter, def: def|null, hitDir, timer }
// A whiffed attack never sets a lock — it only exists after a hit resolves,
// and it always self-clears (timer) or is cleared by a reset/interrupt.
function attachHitLock(attacker, target, def, hitDir, duration) {
  clearHitLocks(attacker);
  clearHitLocks(target);
  // Freeze both fighters from the very frame the lock attaches: the hit does
  // not apply any velocity until the stored launch resolves.
  target.vx = 0;
  target.vy = 0;
  attacker.vx = 0;
  attacker.vy = 0;
  target._hitLock = { attacker, target: null, def, hitDir, timer: duration };
  attacker._hitLock = { attacker: null, target, def: null, hitDir: 0, timer: duration };
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
      launchFromHit(lock.attacker, f, lock.def, lock.hitDir, false);
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

function deliverHit(attacker, target, def, facing) {
  const shielded = target.shielding && !target.dodging;

  // Shield interaction: the hit still registers, it's just heavily reduced.
  const dmgMul = shielded ? 0.1 : 1;
  target.percent = Math.max(0, target.percent + (def.dmg || 0) * dmgMul);

  const hitDir = resolveHitDir(attacker, target, def, facing);

  // Hit-confirm lock: damage lands now, the launch is deferred through a brief
  // freeze of both fighters (see updateHitConfirm).
  if (!shielded && def.hitConfirm > 0) {
    interruptTarget(target);
    attachHitLock(attacker, target, def, hitDir, def.hitConfirm);
    // No re-hits and no projectile interference while the lock is live.
    target.invulnTimer = Math.max(target.invulnTimer, def.hitConfirm + HIT_FEEDBACK_INVULN);
    target._hitFlash = 0.12;
    attacker._hitRenderTimer = HIT_RENDER_LINGER;
    SFX.hit();
    return;
  }

  launchFromHit(attacker, target, def, hitDir, shielded);
}

// Apply the launch portion of a hit: knockback vector + hitstun + air state.
function launchFromHit(attacker, target, def, hitDir, shielded) {
  let kbMul = shielded ? 0.08 : 1;
  let angle = def.angle;
  // Cowboy launcher: an unshielded DOWN-AIR connect pops the target sharply
  // upward. The shared calculator still owns the math — this only swaps in the
  // Cowboy's near-vertical angle and a high-magnitude multiplier on the
  // computed kb. All other moves (Cowboy or not) keep their raw angles.
  if (!shielded) {
    const launch = cowboyLaunchFor(attacker, def);
    if (launch) { kbMul *= launch.kbMul; angle = launch.angle; }
  }
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
  target.hitstun = Math.min(HITSTUN_CAP, 0.03 + kb * 0.0009);
  target.invulnTimer = Math.max(target.invulnTimer, HIT_FEEDBACK_INVULN);
  target._hitFlash = 0.12;

  if (shielded) SFX.deny();
  else SFX.hit();

  // Rendering layering: this fighter is now the attacker and draws in front of
  // the target for the interaction window (Game.js render picks the draw order).
  attacker._hitRenderTimer = HIT_RENDER_LINGER;
}

// Main per-frame advance: finish attack frames, resolve hits, purge leftovers.
export function updateAttacks(fighters, dt) {
  for (const fighter of fighters) {
    if (fighter.attack) advanceAttack(fighter, fighters);
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
  for (const [id, hb] of hitboxes) {
    if (!hb.owner.attack) {
      hitboxes.delete(id);
      hb.def = null;
      hb.hitIds = null;
      _hitboxPool.push(hb);
    }
  }
}

// ── Debug visualization (toggled with ` in Game.js) ─────────────────────
// Hurtboxes green · startup preview cyan-dashed (non-active) · active
// hitboxes red (tagged ACTIVE) · spent/recovery hitboxes grey-dashed (tagged
// OFF, proving they stop damaging the instant recovery starts) · attack info
// text (name / frame / phase / facing). Renders in world coords — call inside
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
        : (a.phase === 'recovery' ? 'HIT OFF' : '—');
      ctx.fillStyle = 'rgba(255,255,255,0.9)';
      ctx.fillText(
        `Frame ${a.frame} · ${a.phase} · ${a.facing > 0 ? 'Right' : 'Left'} · ${hitState}`,
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