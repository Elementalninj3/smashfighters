// worldFx.js — THE global effect layer: one pooled, capped, world-space
// particle engine plus the two arena-wide overlays that ride the same frame —
// the floating damage numbers and the time-dilation spectacle.
//
// SCOPE: ABILITY VFX ONLY.
//   The general gameplay-event layer that used to live here — the jump, landing,
//   fast-fall, dash, direction-change, attack, hit, launch, recovery and knockout
//   emitters, the per-fighter movement drivers, the generic sword ribbon and the
//   screen flash — has been removed along with every call site. A fighter moving,
//   landing, swinging, hitting or being hit now paints NOTHING. The particles
//   that remain are fired only by an ability.
//
// WHERE THIS SITS IN THE EXISTING ARCHITECTURE
//   vfx.js + Fighter.spawnTempVfx is the ANIMATION layer: effects an animation
//   authors (muzzle flashes, slash art, the shadow-dash afterimage), anchored to
//   a hand or a weapon and stamped by the animator every animated frame. That
//   layer is untouched — this module does not replace it and does not compete
//   with it.
//
//   This module is the ABILITY layer: the short-lived world-space effects an
//   ability casts (emitAbilityFx), and the arena-wide Deadeye time dilation an
//   ability triggers. Effects never decide anything, and no gameplay code ever
//   reads state back out of here.
//
// PERFORMANCE CONTRACT (the reason this is one module and not five)
//   • One flat pool of particle records, reused forever — no per-frame garbage.
//   • Hard cap (MAX_PARTICLES). On overflow the OLDEST record is recycled, so a
//     burst always keeps its newest (and most relevant) effects on screen.
//   • Live-list removal is swap-remove: O(1), no splice shifting, stable identity.
//   • One pass per particle; no gradient/shadowBlur allocated per frame, no DOM,
//     no offscreen canvas.
//   • Everything short-circuits when the lists are empty — the idle cost is a
//     couple of array-length checks.

// ── Styles: per-character visual identity ────────────────────────────────
// A style is a plain colour/behaviour record. A fighter's style is resolved from
// its roster def (`_fighterDef.fxStyle`, else the def's own id), so a NEW
// character gets its own identity by adding one entry (or by pointing its def at
// an existing style) — nothing here hard-codes the two fighters that ship today.
export const NEUTRAL_STYLE = {
  id: 'neutral',
  spark: '#fff2c4',     // hit sparks (light)
  spark2: '#ffb03a',    // hit sparks (hot core / trailing fleck)
  dust: '#d9cbb2',      // ground dust
  dust2: '#a08d6f',
  debris: '#8d7a5f',
  slash: '#f2f8ff',     // slash / arc highlight
  slash2: '#9fd8ff',    // slash trailing edge
  trail: '#ffffff',     // dash + launch streaks
  ghost: '#ffffff',     // afterimage body
  ghostAlpha: 0.26,
  dustAlpha: 0.5,
  ring: '#fff6d8',
  slashScale: 1,
};

const FX_STYLES = {
  neutral: NEUTRAL_STYLE,

  // Cowboy: warm, dusty, gunpowder. Gold muzzle light, tan boot dust, embers.
  cowboy: {
    id: 'cowboy',
    spark: '#fff3b0',
    spark2: '#ff8a1e',
    dust: '#e0c9a0',
    dust2: '#9c7f52',
    debris: '#8a6a3d',
    slash: '#ffeec2',
    slash2: '#ff9d3a',
    trail: '#ffd27a',
    ghost: '#ffcf8a',
    ghostAlpha: 0.24,
    dustAlpha: 0.55,
    ring: '#ffd08a',
    slashScale: 1.05,
  },

  // Ninja: shadow and steel. Dark smoke ghosts, cold violet sparks, white edge.
  ninja: {
    id: 'ninja',
    spark: '#e8e2ff',
    spark2: '#b06bff',
    dust: '#9aa3b0',
    dust2: '#4a5260',
    debris: '#3a4658',
    slash: '#eaf1ff',
    slash2: '#8fb6ff',
    trail: '#2f3a4d',
    ghost: '#151c28',
    ghostAlpha: 0.42,   // dark ghost: it has to READ against a bright stage
    dustAlpha: 0.45,
    ring: '#c9a4ff',
    slashScale: 1.0,
  },

  // Boxer: red leather and white wrap. Hot red core, tan leather dust — the
  // loudest palette in the game, matching the heaviest damage in it.
  boxer: {
    id: 'boxer',
    spark: '#fff3e0',
    spark2: '#ff5252',
    dust: '#e8c9bd',
    dust2: '#a4553f',
    debris: '#7d3b2a',
    slash: '#ffe0b2',
    slash2: '#ff7043',
    trail: '#ffab91',
    ghost: '#ffb59b',
    ghostAlpha: 0.28,
    dustAlpha: 0.5,
    ring: '#ff8a65',
    slashScale: 1.05,
  },
};

// Register (or replace) a character style. Exported so a new character can ship
// its identity from its own module instead of editing this one.
export function registerFxStyle(id, style) {
  if (!id || !style) return null;
  const merged = { ...NEUTRAL_STYLE, ...style, id };
  FX_STYLES[id] = merged;
  return merged;
}

export function fxStyleFor(fighter) {
  const def = fighter && fighter._fighterDef;
  if (def) {
    if (def.fxStyle && FX_STYLES[def.fxStyle]) return FX_STYLES[def.fxStyle];
    if (def.id && FX_STYLES[def.id]) return FX_STYLES[def.id];
  }
  return NEUTRAL_STYLE;
}

// ── View culling ─────────────────────────────────────────────────────────
// World-space visible rect, set once per frame by Game.js render(). Particles
// and indicators outside it (with margin) skip drawing but still simulate, so
// gameplay is unaffected — only rasterization is saved.
let _vx0 = -1e9, _vy0 = -1e9, _vx1 = 1e9, _vy1 = 1e9;
export function setWorldFxViewBounds(x0, y0, x1, y1) {
  _vx0 = x0; _vy0 = y0; _vx1 = x1; _vy1 = y1;
}

// ── Particle records + pool ──────────────────────────────────────────────
// Kinds are numbers so the draw switch and the emitters stay allocation-free.
const K_DUST = 0;   // soft round puff that drifts and fades
const K_SPARK = 1;  // short bright line along its own velocity
const K_STREAK = 2; // long thin motion line (ability trails / streaks)
const K_RING = 3;   // expanding stroked ring
const K_FLASH = 4;  // bright additive impact flash
const K_DEBRIS = 5; // small tumbling chip
const K_GHOST = 6;  // afterimage of a body circle
const K_ARC = 7;    // crescent slash arc
const K_WAVE = 8;   // thicker, slower shockwave ring

// Hard cap. A 4-fighter sandbox with projectiles and AI all fighting at once
// still cannot exceed this: the oldest record is recycled instead of growing.
const MAX_PARTICLES = 340;

const _pool = [];   // free records
const _live = [];   // active records, unordered (swap-remove)
let _seq = 0;       // monotonic spawn counter — "oldest" is the smallest seq

function _take() {
  let p = _pool.pop();
  if (!p) {
    p = {
      seq: 0, kind: 0,
      x: 0, y: 0, vx: 0, vy: 0,
      life: 0, maxLife: 1,
      size: 1, size2: 1,
      rot: 0, spin: 0,
      gravity: 0, drag: 1,
      color: '#ffffff', color2: null,
      alpha: 1, additive: true,
      follow: null, fx: 0, fy: 0,
    };
  } else {
    // A recycled record must never inherit the previous effect's motion, colours
    // or its bond to a fighter. Emitters write everything they need AFTER take.
    p.follow = null; p.fx = 0; p.fy = 0;
    p.vx = 0; p.vy = 0; p.rot = 0; p.spin = 0;
    p.color2 = null; p.drag = 1; p.gravity = 0;
    p.alpha = 1; p.additive = true;
  }
  return p;
}

function _release(p) {
  _pool.push(p);
}

// Push a fully-configured record into the live list, enforcing the cap.
function _push(p) {
  if (_live.length >= MAX_PARTICLES) {
    // Evict the oldest live record. Linear, but only ever runs on overflow (a
    // heavy multi-hit frame) and never allocates.
    let oldest = 0;
    let oldestSeq = _live[0].seq;
    for (let i = 1; i < _live.length; i++) {
      if (_live[i].seq < oldestSeq) { oldestSeq = _live[i].seq; oldest = i; }
    }
    const dead = _live[oldest];
    _live[oldest] = _live[_live.length - 1];
    _live.pop();
    _release(dead);
  }
  p.seq = ++_seq;
  p.life = p.maxLife;
  _live.push(p);
  return p;
}

// ── Small shared helpers (no allocation) ─────────────────────────────────
// Shared empty options record: every emitter reads `opts` defensively, so a
// caller can pass nothing and still allocate nothing.
const EMPTY = {};

// ── Quality scaler ─────────────────────────────────────────────────────
// 1 = full particle counts (HIGH default, identical to before). Lower values
// spawn proportionally fewer particles per burst. Gameplay is untouched —
// only the visual density of ability particles changes.
let _fxQuality = 1;
export function setFxQuality(scale) {
  _fxQuality = (typeof scale === 'number' && scale > 0) ? Math.min(1, scale) : 1;
}
function _scaledCount(n, min = 1) {
  if (_fxQuality >= 1) return n;
  return Math.max(min, Math.round(n * _fxQuality));
}

// ── Particle primitives ───────────────────────────────────────────────────
// Every ability emitter below (and Engine.js' legacy names) is built from
// these. None of them allocates: records come from the pool, options are read
// and dropped.

// A puff of dust / smoke. Soft, non-additive, drifts and settles.
export function emitDustPuff(x, y, count, opts) {
  const o = opts || EMPTY;
  const style = o.style || NEUTRAL_STYLE;
  const n = _scaledCount(Math.max(1, Math.min(18, count | 0)));
  const spread = o.spread == null ? Math.PI * 2 : o.spread;
  const base = o.dir == null ? 0 : o.dir;
  const speed = o.speed == null ? 60 : o.speed;
  const life = o.life == null ? 0.28 : o.life;
  const size = o.size == null ? 4 : o.size;
  const alpha = o.alpha == null ? style.dustAlpha : o.alpha;
  const color = o.color || style.dust;
  const color2 = o.color2 || style.dust2;
  const gravity = o.gravity == null ? 90 : o.gravity;
  const jitter = o.jitter == null ? 4 : o.jitter;
  for (let i = 0; i < n; i++) {
    const a = base + (Math.random() - 0.5) * spread;
    const sp = speed * (0.55 + Math.random() * 0.75);
    const p = _take();
    p.kind = K_DUST;
    p.x = x + (Math.random() - 0.5) * jitter;
    p.y = y + (Math.random() - 0.5) * jitter;
    p.vx = Math.cos(a) * sp;
    p.vy = Math.sin(a) * sp;
    p.maxLife = life * (0.7 + Math.random() * 0.6);
    p.size = size * (0.7 + Math.random() * 0.7);
    p.size2 = 1 + Math.random() * 0.6;   // growth factor over the life
    p.gravity = gravity;
    p.drag = 0.88;
    p.alpha = alpha;
    p.additive = !!o.additive;
    p.color = Math.random() < 0.5 ? color : color2;
    _push(p);
  }
}

// An expanding ring (impact ring / shockwave). `wave` picks the thicker, slower
// shockwave, the bigger read for an ability landing on something.
export function emitImpactRing(x, y, opts) {
  const o = opts || EMPTY;
  const style = o.style || NEUTRAL_STYLE;
  const p = _take();
  p.kind = o.wave ? K_WAVE : K_RING;
  p.x = x; p.y = y;
  p.maxLife = o.life == null ? 0.22 : o.life;
  p.size = o.radius == null ? 10 : o.radius;      // start radius
  p.size2 = o.growth == null ? 34 : o.growth;     // total growth
  p.alpha = o.alpha == null ? 0.75 : o.alpha;
  p.color = o.color || style.ring;
  p.additive = o.additive !== false;
  p.drag = 1;
  return _push(p);
}

// Tumbling chips — the debris an ability knocks loose.
export function emitDebris(x, y, count, opts) {
  const o = opts || EMPTY;
  const style = o.style || NEUTRAL_STYLE;
  const n = _scaledCount(Math.max(1, Math.min(16, count | 0)));
  const spread = o.spread == null ? Math.PI : o.spread;
  const base = o.dir == null ? -Math.PI / 2 : o.dir;
  const speed = o.speed == null ? 170 : o.speed;
  for (let i = 0; i < n; i++) {
    const a = base + (Math.random() - 0.5) * spread;
    const sp = speed * (0.5 + Math.random() * 0.9);
    const p = _take();
    p.kind = K_DEBRIS;
    p.x = x; p.y = y;
    p.vx = Math.cos(a) * sp;
    p.vy = Math.sin(a) * sp - 40;
    p.maxLife = (o.life == null ? 0.55 : o.life) * (0.7 + Math.random() * 0.6);
    p.size = (o.size == null ? 3.4 : o.size) * (0.6 + Math.random() * 0.9);
    p.rot = Math.random() * Math.PI;
    p.spin = (Math.random() - 0.5) * 22;
    p.gravity = o.gravity == null ? 640 : o.gravity;
    p.drag = 0.99;
    p.alpha = o.alpha == null ? 0.9 : o.alpha;
    p.additive = false;
    p.color = o.color || style.debris;
    _push(p);
  }
}

// Generic burst — the Engine.spawnParticles delegate. Sparks when `opts.spark`,
// dust otherwise.
export function emitParticles(x, y, opts) {
  const o = opts || EMPTY;
  const count = o.count == null ? 6 : o.count;
  if (o.spark) return emitSparks(x, y, count, o);
  return emitDustPuff(x, y, count, o);
}

// Directional sparks: short bright lines thrown along `dir` (radians).
export function emitSparks(x, y, count, opts) {
  const o = opts || EMPTY;
  const style = o.style || NEUTRAL_STYLE;
  const n = _scaledCount(Math.max(1, Math.min(20, count | 0)));
  const dir = o.dir == null ? 0 : o.dir;
  const spread = o.spread == null ? 0.9 : o.spread;
  const speed = o.speed == null ? 320 : o.speed;
  const life = o.life == null ? 0.16 : o.life;
  const size = o.size == null ? 2 : o.size;
  const hot = o.hot === undefined ? true : o.hot;
  for (let i = 0; i < n; i++) {
    const a = dir + (Math.random() - 0.5) * spread;
    const sp = speed * (0.45 + Math.random() * 1.0);
    const p = _take();
    p.kind = K_SPARK;
    p.x = x; p.y = y;
    p.vx = Math.cos(a) * sp;
    p.vy = Math.sin(a) * sp;
    p.maxLife = life * (0.6 + Math.random() * 0.8);
    p.size = size * (0.7 + Math.random() * 0.8);
    p.drag = 0.86;
    p.gravity = o.gravity == null ? 240 : o.gravity;
    p.alpha = o.alpha == null ? 1 : o.alpha;
    p.additive = true;
    p.color = hot ? style.spark : style.spark2;
    _push(p);
  }
}

// A long thin motion line — dashes, fast falls, launches, recovery trails.
// `follow` ties the line to a fighter for its (short) life, which is what makes
// a dash trail travel with the dash instead of hanging in the world.
export function emitStreak(x, y, dirX, dirY, opts) {
  const o = opts || EMPTY;
  const style = o.style || NEUTRAL_STYLE;
  const p = _take();
  p.kind = K_STREAK;
  p.x = x; p.y = y;
  const sp = o.speed == null ? 0 : o.speed;
  p.vx = dirX * sp;
  p.vy = dirY * sp;
  // The DIRECTION is kept on the record itself, independent of any travel, so a
  // streak that only marks a heading (a launch trail, a fast fall) still knows
  // which way to point when it is drawn.
  p.rot = Math.atan2(dirY, dirX);
  p.maxLife = o.life == null ? 0.2 : o.life;
  p.size = o.length == null ? 26 : o.length;
  p.size2 = o.width == null ? 2.2 : o.width;
  p.alpha = o.alpha == null ? 0.8 : o.alpha;
  p.color = o.color || style.trail;
  p.additive = o.additive !== false;
  p.drag = 1;
  if (o.follow) { p.follow = o.follow; p.fx = o.offsetX || 0; p.fy = o.offsetY || 0; }
  return _push(p);
}

// Afterimage of a body circle at the fighter's CURRENT position — the cheap,
// honest ghost (the radius and colour are already known; snapshotting the sprite
// would cost a canvas per ghost). Short-lived by construction.
export function emitGhost(fighter, opts) {
  if (!fighter) return null;
  const o = opts || EMPTY;
  const style = o.style || fxStyleFor(fighter);
  const p = _take();
  p.kind = K_GHOST;
  p.x = fighter.x; p.y = fighter.y;
  p.size = fighter.radius || 22;
  p.maxLife = o.life == null ? 0.2 : o.life;
  p.alpha = o.alpha == null ? style.ghostAlpha : o.alpha;
  p.color = o.color || style.ghost;
  p.additive = o.additive === true;
  p.drag = 1;
  p.vx = fighter.vx || 0;
  p.vy = fighter.vy || 0;
  return _push(p);
}

// A crescent slash arc. Anchored at a world point; `rot` is the bearing in
// RADIANS (the sweep is centred on it), `size` the arc radius.
export function emitSlashArc(x, y, rot, opts) {
  const o = opts || EMPTY;
  const style = o.style || NEUTRAL_STYLE;
  const p = _take();
  p.kind = K_ARC;
  p.x = x; p.y = y;
  p.rot = rot;
  p.maxLife = o.life == null ? 0.16 : o.life;
  p.size = (o.radius == null ? 40 : o.radius) * (style.slashScale || 1);
  p.size2 = o.sweep == null ? 1.5 : o.sweep;   // total sweep, radians
  p.alpha = o.alpha == null ? 0.9 : o.alpha;
  p.color = o.color || style.slash;
  p.color2 = o.color2 || style.slash2;
  p.additive = true;
  p.drag = 1;
  return _push(p);
}

// A bright micro-flash. `radius` sizes the blob; the life is deliberately tiny
// (the hit-feedback rules) so it reads as an impact and never as a glow.
export function emitFlash(x, y, opts) {
  const o = opts || EMPTY;
  const style = o.style || NEUTRAL_STYLE;
  const p = _take();
  p.kind = K_FLASH;
  p.x = x; p.y = y;
  p.maxLife = o.life == null ? 0.08 : o.life;
  p.size = o.radius == null ? 16 : o.radius;
  p.alpha = o.alpha == null ? 0.85 : o.alpha;
  p.color = o.color || '#ffffff';
  p.color2 = o.color2 || style.spark2;
  p.additive = true;
  p.drag = 1;
  return _push(p);
}

// ── Abilities ────────────────────────────────────────────────────────────
// The Shadow Dash's own streak: darker, longer and cleaner than a plain dash —
// the direction is the direction the dash was CAST in, not the current facing,
// so a dash that got reversed by an arena clamp still paints the real path.
export function emitShadowDashStreak(fighter, direction) {
  if (!fighter) return;
  const style = fxStyleFor(fighter);
  const r = fighter.radius || 22;
  const dir = direction >= 0 ? 1 : -1;
  emitStreak(fighter.x - dir * r * 0.4, fighter.y, dir, 0, {
    style, length: r * 5.2, width: 6, life: 0.26, alpha: 0.55,
    color: style.trail,
  });
  emitStreak(fighter.x, fighter.y, dir, 0, {
    style, length: r * 2.4, width: 2.4, life: 0.2, alpha: 0.7, color: style.slash,
  });
  emitGhost(fighter, { style, life: 0.26, alpha: (style.ghostAlpha || 0.3) * 1.5 });
}

// An ability declares an `fx` kind (abilities.js) and combat.js calls this once,
// at the cast — the single place every ability fires. An ability that already
// computed an exact spawn point stashes it on the attack record during its own
// run (atk.fxX / fxY / fxDir), so the flash leaves the real muzzle instead of the
// fighter's centre. New abilities add a case here, or reuse an existing one.
export function emitAbilityFx(fighter, atk, kind) {
  if (!fighter || !kind) return;
  const style = fxStyleFor(fighter);
  const r = fighter.radius || 22;
  const face = ((atk && atk.facing) || (fighter.facingRight ? 1 : -1)) >= 0 ? 1 : -1;
  const dir = (atk && atk.fxDir != null) ? (atk.fxDir >= 0 ? 1 : -1) : face;
  const x = (atk && atk.fxX != null) ? atk.fxX : fighter.x + dir * r;
  const y = (atk && atk.fxY != null) ? atk.fxY : fighter.y;
  const away = dir > 0 ? 0 : Math.PI;

  switch (kind) {
    // Firearm: muzzle flash + a short spray + a small smoke puff off the barrel.
    // Same impact language the bullets themselves use.
    case 'muzzle': {
      emitFlash(x, y, { style, radius: r * 0.55, life: 0.07, alpha: 0.9, color: '#fff8d0' });
      emitSparks(x, y, 5, {
        style, dir: away, spread: 0.7, speed: 380, life: 0.12, size: 1.8, gravity: 90,
      });
      emitDustPuff(x + dir * r * 0.5, y, 3, {
        style, dir: away, spread: 0.8, speed: 90, size: r * 0.12,
        life: 0.26, gravity: -40, alpha: 0.35,
      });
      break;
    }
    // Thrown weapon: a release flash and a short streak in the throw direction,
    // so the throw itself has weight (the flight art belongs to the animation).
    case 'throw': {
      emitFlash(x, y, { style, radius: r * 0.4, life: 0.06, alpha: 0.8 });
      emitStreak(x, y, dir, 0, {
        style, length: r * 2.2, width: 2.6, life: 0.14, alpha: 0.45,
      });
      break;
    }
    // Mount / summon: a dust kick off the ground the mount appears on.
    case 'mount': {
      emitDustPuff(x, y + r * 0.9, 6, {
        style, spread: Math.PI * 1.1, speed: 140, size: r * 0.22,
        life: 0.34, gravity: 120, jitter: r,
      });
      break;
    }
    // Warp: a dark ring and a few motes at the spot left behind.
    case 'teleport': {
      emitImpactRing(x, y, {
        style, wave: true, radius: r * 0.5, growth: r * 2.6,
        life: 0.3, alpha: 0.6, color: style.ghost,
      });
      emitDustPuff(x, y, 5, {
        style, spread: Math.PI * 2, speed: 70, size: r * 0.18,
        life: 0.3, gravity: -50, alpha: 0.45, color: style.dust2, color2: style.ghost,
      });
      break;
    }
    // A volley cast: the muzzle pops; the bullets keep their own art.
    case 'volley': {
      emitFlash(x, y, { style, radius: r * 0.5, life: 0.08, alpha: 0.85, color: '#ffe9a8' });
      break;
    }
    default: break;
  }
}

// ═══════════════════════════════════════════════════════════════════════
// UPDATE / DRAW / RESET
// ═══════════════════════════════════════════════════════════════════════

// Advance every live effect. `dt` is world time — the same dilated,
// hit-stop-scaled dt gameplay gets — so ability particles hold with the world
// during a freeze frame. `realDt` is accepted and ignored: the screen flash that
// used to ride real time is gone.
export function updateWorldFx(dt) {
  if (_live.length === 0 || dt <= 0) return;

  for (let i = _live.length - 1; i >= 0; i--) {
    const p = _live[i];
    p.life -= dt;
    // Expiry, or a bound effect whose fighter has left play: both are dropped
    // here, by swap-remove, with the record returned to the pool.
    if (p.life <= 0 || (p.follow && p.follow.state === 'dead')) {
      _live[i] = _live[_live.length - 1];
      _live.pop();
      _release(p);
      continue;
    }
    if (p.follow) {
      // A bound effect tracks its fighter instead of integrating — that is what
      // makes a dash trail follow the dash.
      p.x = p.follow.x + p.fx;
      p.y = p.follow.y + p.fy;
      continue;
    }
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    if (p.drag !== 1) {
      // Linear damping rather than Math.pow(drag, dt*60) per particle: over a
      // frame's worth of time the two agree to well under a pixel, and this is
      // one multiply instead of a libm call inside the hottest loop here.
      const k = Math.max(0, 1 - (1 - p.drag) * dt * 60);
      p.vx *= k;
      p.vy *= k;
    }
    if (p.gravity) p.vy += p.gravity * dt;
    if (p.spin) p.rot += p.spin * dt;
  }
}

// World-space pass — call inside the camera transform, after the fighters.
export function drawWorldFx(ctx) {
  const n = _live.length;
  if (n === 0) return;
  // Cull-first: a particle outside the view is skipped before any canvas state
  // work. The per-particle composite toggle stays inside drawParticle (exact
  // same blending as before) — the win here is skipping off-screen particles
  // and the early-out when the list is empty.
  for (let i = 0; i < n; i++) {
    const p = _live[i];
    if (p.x < _vx0 - 60 || p.x > _vx1 + 60 || p.y < _vy0 - 60 || p.y > _vy1 + 60) continue;
    drawParticle(ctx, p);
  }
}

function drawParticleAdditive(ctx, p) {
  drawParticle(ctx, p);
}

function drawParticle(ctx, p) {
  const t = p.life / p.maxLife;      // 1 → 0
  const grow = 1 - t;
  // Full strength for the first ~60% of the life, then a clean fade.
  const fade = t < 0.4 ? t / 0.4 : 1;
  ctx.save();
  if (p.additive) ctx.globalCompositeOperation = 'lighter';

  switch (p.kind) {
    case K_DUST: {
      ctx.globalAlpha = p.alpha * t;
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size * (0.55 + grow * p.size2), 0, Math.PI * 2);
      ctx.fill();
      break;
    }
    case K_SPARK: {
      ctx.globalAlpha = p.alpha * fade;
      ctx.strokeStyle = p.color;
      ctx.lineCap = 'round';
      ctx.lineWidth = Math.max(0.6, p.size * fade);
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(p.x - p.vx * 0.035, p.y - p.vy * 0.035);
      ctx.stroke();
      break;
    }
    case K_STREAK: {
      // Direction lives in `rot` (radians) and length in `size`, so a streak does
      // not have to be moving to know which way it points.
      const dx = Math.cos(p.rot) * p.size;
      const dy = Math.sin(p.rot) * p.size;
      ctx.globalAlpha = p.alpha * fade;
      ctx.strokeStyle = p.color;
      ctx.lineCap = 'round';
      ctx.lineWidth = p.size2 * (0.5 + 0.5 * fade);
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(p.x - dx, p.y - dy);
      ctx.stroke();
      break;
    }
    case K_RING:
    case K_WAVE: {
      const wave = p.kind === K_WAVE;
      ctx.globalAlpha = p.alpha * fade;
      ctx.strokeStyle = p.color;
      ctx.lineWidth = wave ? 5 - 3 * grow : 1.6 + 2.2 * grow;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size + grow * p.size2, 0, Math.PI * 2);
      ctx.stroke();
      break;
    }
    case K_FLASH: {
      // Flat concentric fills instead of a radial gradient: identical read, no
      // gradient object built per frame.
      const a = p.alpha * t * t;
      const r = p.size * (0.85 + grow * 0.45);
      ctx.fillStyle = p.color2;
      ctx.globalAlpha = a * 0.22;
      ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2); ctx.fill();
      ctx.globalAlpha = a * 0.45;
      ctx.beginPath(); ctx.arc(p.x, p.y, r * 0.55, 0, Math.PI * 2); ctx.fill();
      ctx.globalAlpha = a * 0.95;
      ctx.fillStyle = p.color;
      ctx.beginPath(); ctx.arc(p.x, p.y, r * 0.3, 0, Math.PI * 2); ctx.fill();
      break;
    }
    case K_DEBRIS: {
      const s = p.size * (0.55 + 0.45 * t);
      ctx.globalAlpha = p.alpha * fade;
      ctx.fillStyle = p.color;
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.fillRect(-s * 0.5, -s * 0.5, s, s);
      break;
    }
    case K_GHOST: {
      ctx.globalAlpha = p.alpha * fade;
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
      ctx.fill();
      break;
    }
    case K_ARC: {
      // A crescent: a few short arc segments whose width tapers to nothing at
      // both ends, so it reads as a blade sweep rather than a circle.
      const r = p.size * (0.7 + 0.3 * grow);
      const a0 = p.rot - p.size2 / 2;
      const segs = 5;
      ctx.lineCap = 'round';
      for (let i = 0; i < segs; i++) {
        const f0 = i / segs;
        const f1 = (i + 1) / segs;
        const taper = Math.sin(Math.PI * (f0 + f1) * 0.5);
        ctx.globalAlpha = p.alpha * fade * (0.2 + 0.8 * taper);
        ctx.strokeStyle = i % 2 ? p.color2 : p.color;
        ctx.lineWidth = (1.6 + 6 * taper) * (0.55 + 0.45 * fade);
        ctx.beginPath();
        ctx.arc(p.x, p.y, r, a0 + p.size2 * f0, a0 + p.size2 * f1);
        ctx.stroke();
      }
      break;
    }
    default: break;
  }
  ctx.restore();
}

// Hard reset — new match / back to menu / teardown / sandbox stop. Idempotent.
export function resetWorldFx() {
  for (let i = 0; i < _live.length; i++) _release(_live[i]);
  _live.length = 0;
}

// Snapshot for the probe / tests: how much is live.
export function worldFxState() {
  return {
    particles: _live.length,
    pooled: _pool.length,
    cap: MAX_PARTICLES,
  };
}

// ═══════════════════════════════════════════════════════════════════════
// FLOATING DAMAGE NUMBERS + ACTION TEXT
// ═══════════════════════════════════════════════════════════════════════
// One stored indicator per active hit; the list is never big (a handful of hits
// per second at most), so a plain array is fine. Spawned from combat.js'
// deliverHit, the single choke point for every hit that damages the meter, so
// the number is the exact value that lands on the percent meter (including the
// heavy reduction when the hit is shielded). Drawn in world space inside the
// camera transform so it floats over the stage wherever the fight is, and aged
// with the effective delta time — so it rides the Deadeye slow-mo too.
//
// A record may instead carry `text` (spawnFloatingText), which is how an
// ability NAMES itself on screen — the boxer's GRAB and DEADEYE ROLL. It rides
// this same list, this same float/fade/pop math and this same draw call, so a
// named move can never get a second, drifting copy of the float-up behaviour.

let _damageNumbers = [];

// How long a number stays on screen (seconds).
const INDICATOR_LIFE = 0.75;
// World-units the number floats upward over its life.
const INDICATOR_RISE = 44;

// Pooled indicator records: hits can spawn several per second and each used
// to allocate a fresh object + two Math.random() calls with float jitter.
// Records are recycled; jitter uses one random scaled twice.
const _dmgPool = [];
export function spawnDamageNumber(x, y, amount, color) {
  // Cap: under extreme hit rates the oldest indicator is dropped instead of
  // growing the list (same oldest-recycled contract as the particle pool).
  if (_damageNumbers.length >= 24) {
    const old = _damageNumbers.shift();
    if (old) _dmgPool.push(old);
  }
  const d = _dmgPool.pop() || {};
  const j = Math.random();
  d.x = x + (j * 26 - 13);
  d.y0 = y - (j * 26 % 6);
  d.age = 0;
  d.life = INDICATOR_LIFE;
  d.amount = amount;
  d.text = undefined;
  d.size = undefined;
  d.color = color || '#ffffff';
  _damageNumbers.push(d);
}

// A word instead of a number: an ability announcing itself. `opts.life` and
// `opts.size` exist because a move name wants to sit on screen longer and
// read bigger than a 3-digit percent.
export function spawnFloatingText(x, y, text, color, opts) {
  const o = opts || EMPTY;
  if (_damageNumbers.length >= 24) {
    const old = _damageNumbers.shift();
    if (old) _dmgPool.push(old);
  }
  const d = _dmgPool.pop() || {};
  const j = Math.random();
  d.x = x + (j * 26 - 13);
  d.y0 = y - (j * 26 % 6);
  d.age = 0;
  d.life = o.life == null ? INDICATOR_LIFE * 1.6 : o.life;
  d.amount = 0;
  d.text = text == null ? '' : String(text);
  d.size = o.size == null ? 20 : o.size;
  d.color = color || '#ffffff';
  _damageNumbers.push(d);
}

export function updateDamageIndicators(dt) {
  const total = _damageNumbers.length;
  if (!total) return;
  // Swap-remove in place, taking the last LIVE element on every pass. `w` is the
  // high-water mark of the live prefix: the list shrinks inside this loop, so a
  // total captured up front goes stale the moment anything is removed and copies
  // a hole (undefined) into the list. A hole is unrecoverable from here — the
  // next update would throw on it before it could ever be aged out — so the
  // source index is re-read per removal instead. Two indicators can expire in the
  // same call (same-frame spawns, or one long dt crossing several thresholds at
  // once), which is exactly the case the stale index got wrong.
  let w = total;
  for (let i = total - 1; i >= 0; i--) {
    const d = _damageNumbers[i];
    d.age += dt;
    if (d.age >= d.life) {
      _damageNumbers[i] = _damageNumbers[--w];
      _damageNumbers.length = w;
      // Recycle the expired record (text/size refs are overwritten on reuse).
      d.text = undefined;
      if (_dmgPool.length < 32) _dmgPool.push(d);
    }
  }
}

// Cached font strings: sizes are bucketed to whole pixels so a floating
// indicator reuses one of a handful of font strings instead of building a
// template per indicator per frame.
const _dmgFonts = new Map();
function _dmgFont(sz) {
  const b = Math.round(sz);
  let f = _dmgFonts.get(b);
  if (!f) {
    f = `${b}px Consolas, "Courier New", monospace`;
    if (_dmgFonts.size < 24) _dmgFonts.set(b, f);
  }
  return f;
}

export function drawDamageIndicators(ctx, time) {
  const n = _damageNumbers.length;
  if (!n) return;
  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  // Stroke state is identical for every indicator — set once.
  ctx.lineWidth = 4;
  ctx.lineJoin = 'round';
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.9)';

  for (let i = 0; i < n; i++) {
    const d = _damageNumbers[i];
    // A throw here kills the whole render frame, so a list that somehow holds a
    // hole drops that one indicator instead of taking the game down with it.
    if (!d) continue;
    // Cull indicators outside the view before any text work.
    if (d.x < _vx0 - 60 || d.x > _vx1 + 60 || d.y0 < _vy0 - 80 || d.y0 > _vy1 + 40) continue;
    const t = d.age / d.life;
    // Float up from the spawn point, easing to a soft stop near the end.
    const y = d.y0 - INDICATOR_RISE * (1 - (1 - t) * (1 - t));
    // Fade out over the last 30% of life.
    const alpha = t > 0.7 ? 1 - (t - 0.7) / 0.3 : 1;
    // Pop scale right at spawn.
    const base = d.size || 17;
    const sz = base * (d.age < 0.12 ? 1 + (1 - d.age / 0.12) * 0.45 : 1);
    // Cache the formatted amount on the record: percent values only change on
    // spawn (amount is fixed), so the string is built once, not per frame.
    let text = d.text;
    if (text == null) {
      if (d._amountStr == null || d._amountVal !== d.amount) {
        d._amountVal = d.amount;
        d._amountStr = Number.isInteger(d.amount) ? String(d.amount) : d.amount.toFixed(1);
      }
      text = d._amountStr;
    }

    ctx.font = _dmgFont(sz);
    ctx.globalAlpha = alpha;

    // Dark outline for contrast against any background.
    ctx.strokeText(text, d.x, y);

    // Bright fill in the attacker's tint.
    ctx.fillStyle = d.color;
    ctx.fillText(text, d.x, y);
  }

  ctx.restore();
}

export function resetDamageIndicators() {
  for (let i = 0; i < _damageNumbers.length; i++) {
    const d = _damageNumbers[i];
    if (d && _dmgPool.length < 32) { d.text = undefined; _dmgPool.push(d); }
  }
  _damageNumbers.length = 0;
}

// ═══════════════════════════════════════════════════════════════════════
// TIME DILATION — the "the whole arena slows down" spectacle
// ═══════════════════════════════════════════════════════════════════════
// A global real-time effect (cowboy Down Light's Deadeye): gameplay advances at
// a fraction of its normal rate while a full-screen orange tint covers the arena,
// then both ease back to normal. Driven entirely in wall-clock time so it plays
// the same no matter where the fighters are, and it never mutates the arena's
// own colors — the tint is an overlay the renderer fades out.
//
// Lifecycle (real seconds):
//   rampIn  : ease 1x -> factor (a deliberate slow-down, not an instant snap)
//   hold    : constant slow factor — the dramatic beat
//   fade    : ease factor -> 1x AND tint -> 0 together (smooth return)
// A short orange flash pulse rides the very start as the impact beat.
//
// `holdUntilRelease`: the effect enters its hold phase and STAYS there
// indefinitely — combat calls releaseTimeDilation() the moment every Deadeye
// bullet has resolved, so the slow-mo never cuts off the volley early and never
// lingers after it. A release before the hold would have ended simply jumps
// straight to the fade.
//
// Performance: one state object, no per-frame allocation; stepTimeDilation is
// a single scalar multiply once per frame and the overlay is one fillRect.
const _time = {
  active: false,
  factor: 0.12,        // More dramatic slow-mo (12% speed = 8.3x slower)
  elapsed: 0,
  rampIn: 0.15,        // Longer ramp-in for more dramatic buildup
  hold: 1.20,          // Longer hold for extended dramatic moment
  fade: 1.00,          // Longer fade for smoother return
  tintMax: 0.40,       // Stronger orange tint
  flashDur: 0.20,      // Longer flash pulse
  invertMax: 0,        // Colour inversion strength (0 = off, 1 = full negative)
  attackerPlayerNum: 1, // Which player triggered the effect (for target highlighting)
  holdUntilRelease: false, // while true the hold phase never starts its own fade
  // Written every step for the renderer / tests — reading these is free.
  phase: 'off',
  curFactor: 1,
  curTint: 0,
  curFlash: 0,
  curInvert: 0,
};

export function triggerTimeDilation(opts) {
  const s = _time;
  s.factor = opts && opts.factor != null ? opts.factor : 0.12;
  s.rampIn = opts && opts.rampIn != null ? opts.rampIn : 0.15;
  s.hold = opts && opts.hold != null ? opts.hold : 1.20;
  s.fade = opts && opts.fade != null ? opts.fade : 1.00;
  s.tintMax = opts && opts.tintMax != null ? opts.tintMax : 0.40;
  s.flashDur = opts && opts.flashDur != null ? opts.flashDur : 0.20;
  s.invertMax = opts && opts.invertMax != null ? opts.invertMax : 0;
  s.attackerPlayerNum = opts && opts.attackerPlayerNum != null ? opts.attackerPlayerNum : 1;
  s.holdUntilRelease = !!(opts && opts.holdUntilRelease);
  s.elapsed = 0;
  s.active = true;
  return s.active;
}

const _smoothstep = p => p * p * (3 - 2 * p); // smoothstep

// Advance the effect by `dt` real seconds and return the dt gameplay systems
// should actually scale by this frame. Safe to call every update; no-ops (and
// returns dt untouched) while the effect is idle.
export function stepTimeDilation(dt) {
  const s = _time;
  if (!s.active) return dt;
  s.elapsed += dt;
  const e = s.elapsed;

  let factor;
  let p = 0;
  if (e < s.rampIn) {
    s.phase = 'rampIn';
    p = e / s.rampIn;
    factor = s.factor + (1 - s.factor) * (1 - _smoothstep(p)); // ease-out into slow-mo
  } else if (s.holdUntilRelease) {
    // Deadeye hold: stay at the slow factor until releaseTimeDilation() says
    // every bullet has resolved. Never auto-advances to the fade on its own.
    s.phase = 'hold';
    p = 1;
    factor = s.factor;
  } else if (e < s.rampIn + s.hold) {
    s.phase = 'hold';
    p = 1;
    factor = s.factor;
  } else if (e < s.rampIn + s.hold + s.fade) {
    s.phase = 'fade';
    p = Math.min(1, (e - s.rampIn - s.hold) / s.fade);
    factor = s.factor + (1 - s.factor) * _smoothstep(p); // ease back to full speed
  } else {
    s.phase = 'off';
    s.active = false;
    s.curFactor = 1;
    s.curTint = 0;
    s.curFlash = 0;
    s.curInvert = 0;
    return dt;
  }
  s.curFactor = factor;

  // One shared envelope drives the orange tint and the colour inversion, so both
  // ramp in, hold and fade back together and neither can end stranded at full
  // strength.
  const env = s.phase === 'rampIn'
    ? _smoothstep(p)
    : (s.phase === 'hold' ? 1 : (1 - _smoothstep(p)));
  s.curTint = s.tintMax * env;
  s.curInvert = s.invertMax * env;

  s.curFlash = e < s.flashDur ? Math.sin((e / s.flashDur) * Math.PI) * 0.18 : 0;

  return dt * factor;
}

// End a holdUntilRelease hold early (cowboy Deadeye): jump to the fade now.
// The renderer / tests read `holdUntilRelease` so the release is observable.
// Safe to call while idle -> no-op.
export function releaseTimeDilation() {
  const s = _time;
  if (!s.active || !s.holdUntilRelease) return false;
  s.holdUntilRelease = false;
  // Start the fade immediately (never earlier than the current point).
  s.elapsed = Math.max(s.elapsed, s.rampIn + s.hold);
  return true;
}

// Allocation-free read for the per-frame renderer: returns the live state
// object (read-only — do not mutate). timeDilationState() below stays the
// copy-based snapshot for probe/tests.
export function peekTimeDilation() {
  return _time;
}

// Snapshot for the renderer / probe tests.
export function timeDilationState() {
  const s = _time;
  return {
    active: s.active,
    phase: s.phase,
    elapsed: +s.elapsed.toFixed(4),
    factor: +s.curFactor.toFixed(4),
    tint: +s.curTint.toFixed(4),
    flash: +s.curFlash.toFixed(4),
    invert: +s.curInvert.toFixed(4),
    attackerPlayerNum: s.attackerPlayerNum,
    holdUntilRelease: !!s.holdUntilRelease,
  };
}

// ── Colour inversion (post-process) ─────────────────────────────────────
// A whole-frame effect that can only be applied to the FINISHED image, so it
// lives here rather than in the arena draw calls. A white 'difference' fill is a
// photographic negative, and painting white back over it at (1 - strength) walks
// the frame from normal to fully inverted. Canvas 2D has no direct "invert by
// N%", so this is the cheapest honest approximation of a blend toward the
// negative.
//
// The negative is then washed with orange. The arena's own orange tint is drawn
// BEFORE this pass, so inverting the finished frame flips that tint to cyan and
// the effect loses all warmth; painting orange back on afterwards is what keeps
// the inverted arena reading as hot rather than cold. INVERT_ORANGE is a
// fraction of full inversion — the knob for how strong the tinge reads.
const INVERT_ORANGE = 0.35;

export function drawTimeDilationPost(ctx, canvas) {
  const s = _time;
  if (!s.active || s.curInvert <= 0.001) return false;
  const w = canvas.width, h = canvas.height;
  if (!w || !h) return false;

  ctx.save();
  // Identity: the post-process works in raw canvas pixels, not world space.
  ctx.setTransform(1, 0, 0, 1, 0, 0);

  const amt = Math.min(1, s.curInvert);
  ctx.globalCompositeOperation = 'difference';
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1 - amt;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);
  // Warm the negative back up, scaled by how strongly the frame is inverted so
  // the tinge fades out with the effect.
  ctx.globalAlpha = amt * INVERT_ORANGE;
  ctx.fillStyle = '#ff8a00';
  ctx.fillRect(0, 0, w, h);
  ctx.globalAlpha = 1;

  ctx.restore();
  return true;
}

// Hard stop — new match / back-to-menu / teardown.
export function resetTimeDilation() {
  const s = _time;
  s.active = false;
  s.phase = 'off';
  s.elapsed = 0;
  s.curFactor = 1;
  s.curTint = 0;
  s.curFlash = 0;
  s.curInvert = 0;
  s.attackerPlayerNum = 1;
  s.holdUntilRelease = false;
}


