// vfx.js — effect library for per-animation VFX. The effect art itself lives in
// src/effects/art.js (one merged module holding every converted art source: the
// cowboy's muzzle/slash presets, the ninja's shadow-dash trail and the teleport
// smoke bomb). An animation can own a list of anchored visual effects; the
// animator stamps them onto the fighter every animated frame (updateFighterVfx)
// and the renderer draws them in the same world transform as the fighter
// (drawFighterVfx), so editor preview and gameplay are identical.
//
// Anchors are authored in CANONICAL space (fighter faces right): 'frontHand'
// and 'weapon' resolve to the right-side track, 'backHand' to the left. The
// animator mirrors tracks at runtime, so the resolved `out` objects are already
// in the fighter's world space — the effect rides whichever hand carries it.
//
// Per-frame allocation is avoided: instances live in a small per-fighter pool
// rebuilt only when the animation id changes, and anchors resolve into one
// scratch vector.

import { VFX_EFFECTS as artVfx, SHADOW_DASH, SMOKE } from './art.js';
import { spawnTempVfx } from '../fighter/Fighter.js';

export const VFX_EFFECTS = artVfx;

const EMPTY_VFX = [];

const _pos = { x: 0, y: 0 };

// View culling (same contract as Effects.js / worldFx.js): world-space visible
// rect set once per frame by Game.js. A fighter fully outside it skips its
// entire VFX pools — simulation is untouched, only rasterization is saved.
let _vx0 = -1e9, _vy0 = -1e9, _vx1 = 1e9, _vy1 = 1e9;
export function setVfxViewBounds(x0, y0, x1, y1) {
  _vx0 = x0; _vy0 = y0; _vx1 = x1; _vy1 = y1;
}

export function listVfxEffects() {
  return Object.keys(VFX_EFFECTS).map(id => ({ id, name: VFX_EFFECTS[id].name }));
}

export function getVfxEffect(id) {
  return VFX_EFFECTS[id] || null;
}

const ANCHOR_LABEL = {
  character: 'Body',
  frontHand: 'Front hand',
  backHand: 'Back hand',
  weapon: 'Weapon',
};

export function listVfxAnchors() {
  return Object.keys(ANCHOR_LABEL).map(id => ({ id, name: ANCHOR_LABEL[id] }));
}

// Resolve the attach point for an instance into `out` (world space). Public
// wrapper so non-render code (ability spawn positions) can share the SAME
// anchor math as the drawn VFX — the spawn point and the muzzle flash can
// never drift apart.
export function resolveWorldAnchor(fighter, v, out) {
  resolveAnchor(fighter, v, out);
  return out;
}

// Resolve the attach point for an instance into `out` (world space).
function resolveAnchor(fighter, v, out) {
  const O = fighter.anim && fighter.anim.out;
  const a = v.anchor || 'weapon';
  if (a === 'character') { out.x = fighter.x; out.y = fighter.y; return out; }
  if (a === 'frontHand') {
    const h = O && O.hands && O.hands.right;
    out.x = h ? h.px : fighter.x;
    out.y = h ? h.py : fighter.y;
    return out;
  }
  if (a === 'backHand') {
    const h = O && O.hands && O.hands.left;
    out.x = h ? h.px : fighter.x;
    out.y = h ? h.py : fighter.y;
    return out;
  }
  // weapon anchor: transform the weapon def's vfxAnchor (sprite-space) by the
  // same translate→rotate→scale chain the renderer uses.
  const ws = O && O.weapons;
  const w = (ws && (ws.right || ws.left)) || null;
  if (!w || !w.def) { out.x = fighter.x; out.y = fighter.y; return out; }
  const va = w.def.vfxAnchor || w.def.anchors.tip || w.def.anchors.center || { x: 0, y: 0 };
  const sx = w.scaleX === undefined ? 1 : w.scaleX;
  const sy = w.scaleY === undefined ? 1 : w.scaleY;
  const r = (w.rot || 0) * Math.PI / 180;
  const c = Math.cos(r), s = Math.sin(r);
  out.x = w.px + c * va.x * sx - s * va.y * sy;
  out.y = w.py + s * va.x * sx + c * va.y * sy;
  return out;
}

// Rebuild the per-fighter pool from the current animation's vfx list, then
// compute every instance's progress from the current frame. The pool objects
// are reused across frames (fields rewritten in place); only grows on demand.
export function updateFighterVfx(fighter, frame) {
  const A = fighter.anim;
  const anim = (A && A.anim) || null;
  const list = (anim && anim.vfx) || EMPTY_VFX;
  const pid = (A && A.animId) || '';
  if (!fighter._vfxPool || fighter._vfxAnimId !== pid) {
    fighter._vfxAnimId = pid;
    fighter._vfxPool = [];
  }
  const pool = fighter._vfxPool;
  for (let i = 0; i < list.length; i++) {
    const src = list[i];
    let v = pool[i];
    if (!v) v = pool[i] = {};
    v.effect = src.effect || 'bullet';
    v.color = src.color || null;
    v.anchor = src.anchor || 'weapon';
    v.startFrame = src.startFrame || 0;
    v.duration = Math.max(1, src.duration || 10);
    v.scale = src.scale == null ? 1 : src.scale;
    v.rotation = src.rotation || 0;
    v.offsetX = src.offsetX || 0;
    v.offsetY = src.offsetY || 0;
    v.loop = !!src.loop;
    v.mirrorX = fighter.facingRight ? 1 : -1;
    if (v.loop) {
      const m = (frame - v.startFrame) % v.duration;
      v.progress = (m < 0 ? m + v.duration : m) / v.duration;
    } else {
      v.progress = (frame - v.startFrame) / v.duration;
    }
  }
  if (pool.length > list.length) pool.length = list.length;
}

export function drawFighterVfx(ctx, fighter) {
  // Whole-fighter cull (margin covers hand/weapon-anchored effects). Pinned
  // effects (teleport smoke) live at fixed world points away from the body, so
  // when the fighter is outside the view the pinned points are tested too — a
  // visible poof is never culled just because its owner teleported off-screen.
  if (fighter.x < _vx0 - 220 || fighter.x > _vx1 + 220 ||
      fighter.y < _vy0 - 220 || fighter.y > _vy1 + 220) {
    const _tmp = fighter._tempVfx;
    let _keep = false;
    if (_tmp) {
      for (let _i = 0; _i < _tmp.length; _i++) {
        const _v = _tmp[_i];
        if (_v && _v.pinnedX != null &&
            _v.pinnedX > _vx0 - 80 && _v.pinnedX < _vx1 + 80 &&
            _v.pinnedY > _vy0 - 80 && _v.pinnedY < _vy1 + 80) { _keep = true; break; }
      }
    }
    if (!_keep) return;
  }
  const pool = fighter._vfxPool;
  if (pool && pool.length) {
    for (let i = 0; i < pool.length; i++) {
      const v = pool[i];
      if (!v || v.progress < 0 || v.progress > 1) continue;
      const eff = VFX_EFFECTS[v.effect] || VFX_EFFECTS.bullet;
      resolveAnchor(fighter, v, _pos);
      _pos.x += v.offsetX || 0;
      _pos.y += v.offsetY || 0;
      ctx.save();
      eff.draw(ctx, v, _pos);
      ctx.restore();
    }
  }
  // Draw temporary VFX (e.g., for jumps, landings, etc.)
  const temp = fighter._tempVfx;
  if (temp && temp.length) {
    for (let i = 0; i < temp.length; i++) {
      const v = temp[i];
      if (!v || v.progress < 0 || v.progress > 1) continue;
      const eff = VFX_EFFECTS[v.effect] || VFX_EFFECTS.bullet;
      if (v.pinnedX != null) {
        // A PINNED effect is anchored to a fixed WORLD point instead of the
        // fighter: the anchor is resolved once, at spawn, and frozen here, so the
        // effect stays exactly where it was thrown even after the fighter has
        // moved (the Teleport Strike's smoke stays on the spot the move was
        // activated on while the ninja blinks out of it). Offsets are ignored —
        // the spawner folds them into the pinned point.
        _pos.x = v.pinnedX;
        _pos.y = v.pinnedY;
      } else {
        resolveAnchor(fighter, v, _pos);
        _pos.x += v.offsetX || 0;
        _pos.y += v.offsetY || 0;
      }
      ctx.save();
      eff.draw(ctx, v, _pos);
      ctx.restore();
    }
  }
}

export function resetFighterVfx(fighter) {
  fighter._vfxAnimId = null;
  if (fighter._vfxPool) fighter._vfxPool.length = 0;
}

// ── Shadow Strike (ninja Down Heavy) — the ONE entry point ────────────────
// The ability dashes the fighter a fixed distance forward in the facing
// direction (abilities.js sets a constant velocity for a fixed duration),
// so this is called once, on the cast frame, from abilities.js: it spawns the
// shadow-dash effect at the fighter's position and captured facing, and the
// art paints the whole sequence (departure burst → afterimage trail → arrival
// burst → fade-out) BACKWARDS across the distance the dash actually covers.
//
//   direction — the attack direction captured at the cast
//   opts.travelled — the signed distance the fighter moved during the dash (the
//                    trail's true length and side)
//   opts.distance  — explicit length, used when `travelled` is not supplied
//   opts.frames    — the ability's remaining frames (the effect's lifetime)
//   opts.scale     — extra art scale on top of the fighter-body fit
//
// The effect is purely visual: it moves nothing, registers no hitbox and owns no
// collision — dash distance, hitbox, damage and timing stay in abilities.js /
// combat.js. It rides the fighter's temp-VFX list, so it can never outlive the
// move: Fighter.js ages it out with the lifetime below, which is the ability's
// own remaining frames, and Game.js drops the pool on respawn. No loop, no
// canvas, no state of its own — draw() only reads the progress it is handed.
export function playShadowStrikeVFX(player, direction, opts) {
  if (!player) return null;
  const o = opts || {};
  // The trail has to cover the path the dash actually took. `direction` (the
  // attack direction captured at the cast) gives the trail its facing and is the
  // only source when the dash covered no ground at all; `travelled` (the signed
  // distance the fighter moved during the dash) is the honest path — the two can
  // only disagree when the ability's own arena clamp moved the fighter back the
  // other way, and then drawing the real path is the correct thing to do.
  const hasPath = o.travelled != null;
  const distance = hasPath
    ? Math.abs(o.travelled)
    : (o.distance == null ? SHADOW_DASH.defaultDistance : o.distance);
  const dir = (hasPath && o.travelled !== 0) ? (o.travelled > 0 ? 1 : -1) : (direction >= 0 ? 1 : -1);
  // Expiry is measured on the same clock the move ends on: the art timeline is
  // mapped onto the ability's remaining frames instead of a fixed duration, so a
  // short cast plays the identical sequence slightly faster rather than leaving a
  // trail running after the move.
  const frames = o.frames == null ? SHADOW_DASH.strikeFrames : o.frames;
  const lifetime = Math.max(1 / 60, frames / 60);
  // The art was composed around a 44×76 body; the game's fighter is a ball, so
  // the afterimage circles are scaled to its real diameter (both fighters'
  // radii are read from the fighter itself, never hard-coded).
  const unit = ((player.radius || SHADOW_DASH.refBodyHeight / 2) * 2) / SHADOW_DASH.refBodyHeight;
  return spawnTempVfx(player, 'shadowDash', lifetime, o.scale == null ? 1 : o.scale, 0, 0, 0, {
    anchor: 'character',   // the fighter's body center, in world space
    mirrorX: dir,          // the direction the dash travelled (the attack direction)
    params: { distance, unit },
  });
}

// ── Smoke Bomb — the Teleport Strike's poof ──────────────────────────────
// The ninja's Down Light teleports a beat AFTER the player presses it, so the
// cloud has to stay on the spot the move was activated on while the fighter
// warps away to its destination. The instance is PINNED to that world point (see
// drawFighterVfx), so the poof cannot ride the fighter to its arrival point the
// way an ordinary fighter-anchored effect would.
//
//   opts.x / opts.y  — the world point the poof belongs to (defaults: the
//                      fighter's own center at call time)
//   opts.lifetime    — how long the cloud lives, in seconds
//   opts.scale       — extra art scale on top of the fighter-body fit
//
// Cosmetic only, exactly like the Shadow Strike trail: it moves nothing,
// registers no hitbox and owns no collision. It rides the fighter's temp-VFX
// list, so it is aged out and dropped with the move (and cleared on respawn).
export function playSmokePoofVFX(player, opts) {
  if (!player) return null;
  const o = opts || {};
  const x = o.x == null ? player.x : o.x;
  const y = o.y == null ? player.y : o.y;
  const lifetime = Math.max(1 / 60, o.lifetime == null ? 0.6 : o.lifetime);
  // The art was composed at its own pixel scale; scale it by the fighter's real
  // body so the cloud is proportional to whoever threw it (radius is read from
  // the fighter, never hard-coded).
  const unit = ((player.radius || SMOKE.refBody / 2) * 2) / SMOKE.refBody;
  return spawnTempVfx(player, 'smokeBomb', lifetime, o.scale == null ? 1 : o.scale, 0, 0, 0, {
    anchor: 'character',   // the fighter's body center, where the poof is born
    pinnedX: x,            // …but it is drawn HERE for its whole life
    pinnedY: y,
    params: { unit },
  });
}
