// destructible.js â€” breakable world objects for the Sandbox arena.
//
// A destructible IS a platform record. It has the exact shape Stage.js draws,
// bobs and resolves collisions against, plus a few extra fields (kindId, hp,
// destructible). That is deliberate: a breakable board has to be standable and
// block from below using the REAL platform collision, so making it a platform is
// what keeps this out of the business of writing a second collision system. What
// this module adds is only what a platform record does not have:
//
//   â€¢ durability (hp / maxHp) and damage intake
//   â€¢ registration, so the existing hitbox and projectile passes in combat.js
//     can find it and feed it the same damage numbers those moves deal
//   â€¢ a cheap break effect, and self-cleanup once hp reaches zero
//
// Isolation is the point of the design. A destructible only ever CONSUMES
// durability: it never receives knockback, hitstun, a hit lock, a damage number
// or a fighter flag, so it cannot change a player's percent, momentum, combo
// state or hitbox. Fighters fight each other exactly as they do on the main
// stage; the boards just happen to be in the way. The registry is empty outside
// the sandbox, so the main match pays nothing â€” combat.js' two new passes bail
// on a null list before touching a single fighter.

import { SFX } from '../../core/sfx.js';

// â”€â”€ Kinds â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Adding a breakable object to the sandbox is adding an entry here: its
// durability, how hard the game's real damage numbers bite into it, its
// silhouette and its art. Nothing downstream special-cases a kind.
export const DESTRUCTIBLE_KINDS = [
  {
    id: 'board',
    name: 'WOOD BOARD',
    w: 180, h: 24, hp: 100, damageScale: 6.5, minDamage: 2.0,
    color: '#8a6a3f', edge: '#3a2a14', plank: '#a8834f', grain: '#5c4324',
  },
  {
    id: 'crate',
    name: 'CRATE',
    w: 76, h: 76, hp: 70, damageScale: 5.0, minDamage: 1.5,
    color: '#7a5a34', edge: '#33240f', plank: '#96703f', grain: '#4e3719',
  },
  {
    id: 'barrel',
    name: 'BARREL',
    w: 64, h: 84, hp: 55, damageScale: 4.5, minDamage: 1.5,
    color: '#5d5f4a', edge: '#26281a', plank: '#767960', grain: '#3a3c2b',
  },
  {
    id: 'glass',
    name: 'GLASS BLOCK',
    w: 70, h: 70, hp: 26, damageScale: 3.2, minDamage: 1.0,
    color: '#4a6d78', edge: '#1b2c33', plank: '#6f97a4', grain: '#33505a',
  },
];

const KIND_BY_ID = {};
for (const k of DESTRUCTIBLE_KINDS) KIND_BY_ID[k.id] = k;

export function destructibleKind(kindId) {
  return KIND_BY_ID[kindId] || KIND_BY_ID.board;
}

// â”€â”€ Registry â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// One flat array, swapped by index (never filter/splice-rebuild) so a removal
// allocates nothing. combat.js reads this list once per pass.
let _destructibles = [];

// Break-effect pool. Plain rectangles falling out of the broken object's
// footprint: no particles, no gradients, no per-frame allocation. Capped, and
// the oldest shard is dropped rather than growing the pool.
const _breakFx = [];
const BREAK_FX_PER_BOARD = 8;
const BREAK_FX_MAX = 96;

let _nextId = 1;

export function createDestructible(kindId, opts) {
  const kind = destructibleKind(kindId);
  const width = opts.width ?? kind.w;
  const height = opts.height ?? kind.h;
  return {
    id: opts.id || `d${_nextId++}`,
    // Platform fields (Stage.js drawStage skips destructible:true, which is what
    // lets this module own their art, and resolvePlatformCollision treats them
    // as solid, exactly like the main ground).
    x: opts.x || 0,
    y: opts.y || 0,
    baseY: opts.y || 0,
    width,
    height,
    isGround: false,
    canDropThrough: opts.canDropThrough ?? false,
    color: kind.color,
    // Destructible fields
    destructible: true,
    kindId: kind.id,
    hp: opts.hp ?? kind.hp,
    maxHp: opts.hp ?? kind.hp,
    stage: null,      // the stage this board is currently placed in
    dead: false,
    _flash: 0,        // white hit flash, aged by stepDestructibles
    _kind: kind,      // cached so the break effect can reuse the palette
    _gradient: null,
  };
}

export function registerDestructible(d) {
  if (!d || d.dead) return;
  if (_destructibles.indexOf(d) === -1) _destructibles.push(d);
}

export function unregisterDestructible(d) {
  const i = _destructibles.indexOf(d);
  if (i !== -1) { _destructibles[i] = _destructibles[_destructibles.length - 1]; _destructibles.pop(); }
  if (d && d.stage) removeFromStage(d);
}

export function clearDestructibles() {
  _destructibles.length = 0;
  _breakFx.length = 0;
}

export function destructibleCount() {
  return _destructibles.length;
}

// The hot-path accessor combat.js calls: the live list, or null when there is
// nothing to hit. A null check is the whole cost of this feature on a stage
// with no breakables in it.
export function destructibleList() {
  return _destructibles.length ? _destructibles : null;
}

// â”€â”€ Damage â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// The only way durability is lost. amount is already scaled by the kind's
// damageScale by the caller, which is also what feeds the hit flash.
export function damageDestructible(d, amount, hx, hy) {
  if (!d || d.dead || amount <= 0) return false;
  d.hp -= amount;
  d._flash = 0.1;
  if (d.hp <= 0) {
    d.hp = 0;
    d.dead = true;
    breakDestructible(d);
    return true;
  }
  // A small, non-blocking puff: the board reacting, not a full hit VFX, and
  // deliberately NOT spawnTempVfx (that pool belongs to fighters and is aged
  // by their own input handler).
  spawnBreakFx(d, hx, hy, 2);
  return false;
}

function breakDestructible(d) {
  spawnBreakFx(d, d.x + d.width / 2, d.y + d.height / 2, BREAK_FX_PER_BOARD);
  // Drop it out of the stage it was placed in: once hp is gone the board stops
  // being a platform, so the collision that stood a fighter on top of it is
  // gone with it (the fighter simply falls).
  unregisterDestructible(d);
  d.dead = true;
  SFX.grabImpact();
}

function spawnBreakFx(d, ox, oy, count) {
  const cx = ox !== undefined ? ox : d.x + d.width / 2;
  const cy = oy !== undefined ? oy : d.y + d.height / 2;
  for (let i = 0; i < count; i++) {
    if (_breakFx.length >= BREAK_FX_MAX) _breakFx.shift();
    const size = 4 + Math.random() * 7;
    _breakFx.push({
      x: d.x + Math.random() * d.width,
      y: d.y + Math.random() * d.height,
      vx: (cx - (d.x + d.width / 2)) * 0.9 + (Math.random() * 2 - 1) * 130,
      vy: -90 - Math.random() * 170,
      size,
      life: 0.45 + Math.random() * 0.35,
      maxLife: 0.8,
      color: Math.random() < 0.5 ? d.color : (d._kind ? d._kind.plank : '#8a6a3f'),
    });
  }
}

// â”€â”€ Per-frame step â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Ages the hit flash, sweeps broken boards out of their stage, and integrates
// the shard pool. Compaction is in place â€” no filter, no allocation.
export function stepDestructibles(dt) {
  if (!_destructibles.length && !_breakFx.length) return;

  for (let i = 0; i < _destructibles.length; i++) {
    const d = _destructibles[i];
    if (d.dead) {
      unregisterDestructible(d);
      i--;
      continue;
    }
    if (d._flash > 0) d._flash = Math.max(0, d._flash - dt);
  }

  let w = 0;
  for (let i = 0; i < _breakFx.length; i++) {
    const p = _breakFx[i];
    p.life -= dt;
    if (p.life <= 0) continue;
    p.vy += 900 * dt;
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    _breakFx[w++] = p;
  }
  _breakFx.length = w;
}

function removeFromStage(d) {
  const plats = d.stage && d.stage.platforms;
  if (!plats) return;
  const i = plats.indexOf(d);
  if (i !== -1) { plats[i] = plats[plats.length - 1]; plats.pop(); }
  d.stage = null;
}

// â”€â”€ Render â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Solid fills and straight lines only. The gradient is built once per board and
// cached on the record (the same trick Stage.js uses for its platform gradient).
export function drawDestructibles(ctx) {
  const list = _destructibles;
  for (let i = 0; i < list.length; i++) {
    const d = list[i];
    if (d.dead) continue;
    const kind = destructibleKind(d.kindId);
    const h = d.height;
    const w = d.width;

    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.fillRect(d.x + 4, d.y + 4, w, h);

    if (!d._gradient) {
      const g = ctx.createLinearGradient(d.x, d.baseY, d.x, d.baseY + h);
      g.addColorStop(0, kind.plank);
      g.addColorStop(1, kind.color);
      d._gradient = g;
    }
    ctx.fillStyle = d._gradient;
    ctx.fillRect(d.x, d.y, w, h);

    // Plank seams / panel lines â€” the only texture a board gets.
    ctx.strokeStyle = kind.grain;
    ctx.lineWidth = 1;
    ctx.beginPath();
    if (kind.id === 'barrel' || kind.id === 'glass') {
      // Rounds read as bands; the glass block gets a frame instead.
      if (kind.id === 'barrel') {
        ctx.moveTo(d.x, d.y + h * 0.3);
        ctx.lineTo(d.x + w, d.y + h * 0.3);
        ctx.moveTo(d.x, d.y + h * 0.7);
        ctx.lineTo(d.x + w, d.y + h * 0.7);
      } else {
        ctx.moveTo(d.x + 5, d.y + 5);
        ctx.lineTo(d.x + w - 5, d.y + 5);
        ctx.lineTo(d.x + w - 5, d.y + h - 5);
        ctx.lineTo(d.x + 5, d.y + h - 5);
        ctx.closePath();
      }
    } else {
      const seams = kind.id === 'crate' ? 2 : 4;
      for (let s = 1; s <= seams; s++) {
        const px = d.x + (w / (seams + 1)) * s;
        ctx.moveTo(px, d.y);
        ctx.lineTo(px, d.y + h);
      }
    }
    ctx.stroke();

    ctx.strokeStyle = kind.edge;
    ctx.lineWidth = 2;
    ctx.strokeRect(d.x + 1, d.y + 1, w - 2, h - 2);

    // Damage read: cracks creep in as durability drops, so a board tells you
    // how close it is without needing a number.
    const wear = 1 - d.hp / d.maxHp;
    if (wear > 0.25) {
      ctx.strokeStyle = kind.grain;
      ctx.lineWidth = 1 + wear;
      ctx.beginPath();
      const cracks = Math.ceil(wear * 4);
      for (let c = 0; c < cracks; c++) {
        const cx = d.x + ((c + 1) / (cracks + 1)) * w;
        ctx.moveTo(cx, d.y);
        ctx.lineTo(cx + (c % 2 ? 4 : -4), d.y + h * 0.5);
        ctx.lineTo(cx, d.y + h);
      }
      ctx.stroke();
    }

    if (d._flash > 0) {
      ctx.fillStyle = `rgba(255,255,255,${(d._flash / 0.1) * 0.45})`;
      ctx.fillRect(d.x, d.y, w, h);
    }
  }

  for (let i = 0; i < _breakFx.length; i++) {
    const p = _breakFx[i];
    const a = Math.min(1, p.life / p.maxLife);
    ctx.fillStyle = p.color;
    ctx.globalAlpha = a;
    ctx.fillRect(p.x, p.y, p.size, p.size);
  }
  if (_breakFx.length) ctx.globalAlpha = 1;
}

// Durability readout, drawn only while a board is selected in the editor (the
// play session shows it on the hovered board instead â€” see SandboxEditor/Session).
export function drawDestructibleHp(ctx, d) {
  const barW = Math.max(24, d.width);
  const barH = 4;
  const barY = d.y - 9;
  ctx.fillStyle = 'rgba(0,0,0,0.6)';
  ctx.fillRect(d.x, barY, barW, barH);
  const frac = Math.max(0, Math.min(1, d.hp / d.maxHp));
  ctx.fillStyle = frac > 0.5 ? '#8fd46a' : frac > 0.2 ? '#e8c25a' : '#e0664a';
  ctx.fillRect(d.x, barY, barW * frac, barH);
}
