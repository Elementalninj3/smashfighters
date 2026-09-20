// vfx.js — effect library for per-animation VFX. Exactly three presets exist:
// bullet / spray / blast (authored in GA/vfx/cowboy-al.js). An animation can
// own a list of anchored visual effects; the animator stamps them onto the
// fighter every animated frame (updateFighterVfx) and the renderer draws them
// in the same world transform as the fighter (drawFighterVfx), so editor
// preview and gameplay are identical.
//
// Anchors are authored in CANONICAL space (fighter faces right): 'frontHand'
// and 'weapon' resolve to the right-side track, 'backHand' to the left. The
// animator mirrors tracks at runtime, so the resolved `out` objects are already
// in the fighter's world space — the effect rides whichever hand carries it.
//
// Per-frame allocation is avoided: instances live in a small per-fighter pool
// rebuilt only when the animation id changes, and anchors resolve into one
// scratch vector.

import { VFX_EFFECTS as cowboyAlVfx } from '../GA/vfx/cowboy-al.js';

export const VFX_EFFECTS = { ...cowboyAlVfx };

const EMPTY_VFX = [];

const _pos = { x: 0, y: 0 };

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
  const pool = fighter._vfxPool;
  if (!pool || !pool.length) return;
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

export function resetFighterVfx(fighter) {
  fighter._vfxAnimId = null;
  if (fighter._vfxPool) fighter._vfxPool.length = 0;
}
