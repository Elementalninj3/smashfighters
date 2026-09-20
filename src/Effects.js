// Effects.js — fighter rendering. The body is always drawn the same way; hands
// and weapons come from ONE of two sources:
//   • animator output (fighter.anim.out) — keyframeable hands + weapons
//   • the legacy neutral pose system (HandAnim) — fallback
//
// Layering: drawables with z < 0 sit behind the body, everything else (z ≥ 0)
// draws on top. When no animator is attached nothing changes and the actor
// looks exactly as before.

import { getSkinImage } from './vfxCore.js';
import { handConfig, resolveHandColor } from './HandAnim.js';
import { drawAccessory } from './Accessories.js';
import { drawWeapon } from './anim/weapons.js';

// Reused drawable buffer — collectAnimatedItems is called every animated frame
// and would otherwise allocate a fresh array + copies each time. The resolved
// out objects already carry `type` ('hand'|'weapon') and are rebuilt in place
// by the animator, so we push them straight into a reusable sorted list.
const _animatedItems = [];
const _SIDES = ['left', 'right'];
const _DEG_TO_RAD = Math.PI / 180;
function _byZ(a, b) { return (a.z || 0) - (b.z || 0); }

function collectAnimatedItems(fighter) {
  const out = fighter.anim.out;
  const items = _animatedItems;
  items.length = 0;
  for (const side of _SIDES) {
    const h = out.hands[side];
    if (h && h.visible !== false && h.opacity > 0) items.push(h);
    const w = out.weapons[side];
    if (w && w.visible !== false && w.opacity > 0) items.push(w);
  }
  items.sort(_byZ);
  return items;
}

// Per-fighter cached hand-base position { x, y } — updated in place so the
// legacy render path never allocates a new object each frame.
function _hb(fighter, key, x, y) {
  const cache = fighter._handCache || (fighter._handCache = {});
  let obj = cache[key];
  if (!obj) obj = cache[key] = { x, y };
  else { obj.x = x; obj.y = y; }
  return obj;
}

// Per-fighter cached hand draw-state (layer, px, py, scale, rotation,
// opacity, visibility). Updated in place each frame.
function _hst(fighter, key, px, py, layer) {
  const cache = fighter._handStateCache || (fighter._handStateCache = {});
  let st = cache[key];
  if (!st) {
    st = cache[key] = {
      layer, px, py,
      sx: 1, sy: 1,
      rot: 0,
      opacity: 1,
      visible: true,
    };
  } else {
    st.layer = layer;
    st.px = px;
    st.py = py;
  }
  return st;
}

function directionalShadow(ctx, x, y, radius) {
  ctx.fillStyle = 'rgba(0,0,0,0.2)';
  ctx.beginPath();
  ctx.ellipse(x, y + radius + 2, radius * 0.8, radius * 0.3, 0, 0, Math.PI * 2);
  ctx.fill();
}

function lookUpSkin(skin) {
  if (!skin) return { loaded: false, img: null };
  if (skin.loaded) return skin;
  if (skin.path) {
    const entry = getSkinImage(skin.path);
    if (entry && entry.status === 'loaded' && entry.img) {
      skin.loaded = true;
      skin.img = entry.img;
    }
  }
  return skin;
}

function drawBody(ctx, fighter, skin) {
  const { x, y, radius, color, skinScale, skinCenter } = fighter;
  if (skin && skin.img) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.clip();

    const img = skin.img;
    const ss = skinScale || 1;
    const size = radius * 2 * ss;
    const scale = size / Math.min(img.width, img.height);
    const drawW = img.width * scale;
    const drawH = img.height * scale;
    const cx = skinCenter ? skinCenter.x * scale : 0;
    const cy = skinCenter ? skinCenter.y * scale : 0;

    ctx.drawImage(img, x - drawW / 2 + cx, y - drawH / 2 + cy, drawW, drawH);
    ctx.restore();
  } else {
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
  }

  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.strokeStyle = '#222222';
  ctx.lineWidth = 3;
  ctx.stroke();
}

function drawAnimatedHand(ctx, st, handR, handFill) {
  const rx = (st.width > 0 ? st.width / 2 : handR) * Math.abs(st.scaleX || 1);
  const ry = (st.height > 0 ? st.height / 2 : handR) * Math.abs(st.scaleY || 1);
  ctx.save();
  ctx.globalAlpha = st.opacity ?? 1;
  ctx.beginPath();
  ctx.ellipse(st.px, st.py, rx, ry, ((st.rot ?? 0) * _DEG_TO_RAD), 0, Math.PI * 2);
  ctx.fillStyle = handFill;
  ctx.fill();
  ctx.strokeStyle = '#222222';
  ctx.lineWidth = 2.5;
  ctx.stroke();
  ctx.restore();
}

function drawAnimatedWeapon(ctx, st) {
  ctx.save();
  ctx.globalAlpha = st.opacity ?? 1;
  ctx.translate(st.px, st.py);
  ctx.rotate(((st.rot || 0) * _DEG_TO_RAD));
  ctx.scale(st.scaleX || 1, st.scaleY || 1);
  drawWeapon(ctx, st.def, { color: st.def.color, accent: st.def.accent });
  ctx.restore();
}

// Draw the animated hands + weapons for one layer ("behind" = z < 0,
// anything else = front). `type` is 'hand' or 'weapon' (set by the animator).
function drawAnimatedLayer(ctx, items, behind, handR, handFill) {
  for (const it of items) {
    const isBehind = (it.z || 0) < 0;
    if (isBehind !== behind) continue;
    if (it.type === 'hand') drawAnimatedHand(ctx, it, handR, handFill);
    else drawAnimatedWeapon(ctx, it);
  }
}

function _drawHandState(ctx, st, handR, handFill) {
  if (!st || st.visible === false || st.opacity <= 0) return;
  ctx.save();
  ctx.globalAlpha = st.opacity ?? 1;
  ctx.beginPath();
  ctx.ellipse(
    st.px, st.py,
    handR * (st.sx ?? 1),
    handR * (st.sy ?? 1),
    ((st.rot ?? 0) * _DEG_TO_RAD),
    0,
    Math.PI * 2
  );
  ctx.fillStyle = handFill;
  ctx.fill();
  ctx.strokeStyle = '#222222';
  ctx.lineWidth = 2.5;
  ctx.stroke();
  ctx.restore();
}

// Draw a fighter: body circle (skin image or flat color), resting hands tuned
// by the neutral hand pose, cosmetic accessories, and movement-state markers.
export function drawFighter(ctx, fighter, time) {
  if (fighter.state === 'dead') return;

  const { x, y, radius, color, skin } = fighter;

  // Invulnerability blink (used by the soft blast-zone respawn)
  if (fighter.invulnTimer > 0) {
    if (Math.floor(time / 80) % 2 === 0) return;
  }

  ctx.save();

  // Squish effect (jump/landing stretch)
  const sx = fighter.squishX || 1;
  const sy = fighter.squishY || 1;
  if (sx !== 1 || sy !== 1) {
    ctx.translate(x, y);
    ctx.scale(sx, sy);
    ctx.translate(-x, -y);
  }

  // Draw shadow on ground
  if (fighter.grounded) directionalShadow(ctx, x, y, radius);

  // Behind-the-player accessories (hides behind the body).
  if (fighter.accessory && fighter.accessory.type && fighter.accessory.layer === 'behind') {
    drawAccessory(ctx, x, y, radius, fighter.accessory);
  }

  // Look up live skin status from the cache (skin.path is set by resolveSkin)
  const skinLive = lookUpSkin(skin);

  // ── Body + hands/layers ────────────────────────────────────────────────
  const handR = radius * 0.35;
  const handFill = resolveHandColor(fighter._fighterDef ? fighter._fighterDef.id : fighter.id, color);
  // Animator output is used ONLY while a combat action (attack / shield —
  // the library's seven base animations) is active. Normal movement — idle,
  // walking left/right, running, jumping — always renders through the
  // original legacy pose system below, never through animator playback.
  const animated = !!(
    fighter.anim &&
    fighter.anim.out &&
    (fighter.anim.animId || fighter.anim.playing || fighter.anim.blendFrom)
  );

  if (animated) {
    const items = collectAnimatedItems(fighter);
    drawAnimatedLayer(ctx, items, true, handR, handFill);
    drawBody(ctx, fighter, skinLive);
    drawAnimatedLayer(ctx, items, false, handR, handFill);
  } else {
    const dirHand = fighter.facingRight ? 1 : -1;

    // Neutral hand offsets — the resting pose (live-editable via the terminal
    // menu's SKIN SIZE / accessories editors; hand poses come from handConfig).
    const neutralPose = handConfig.actions.neutral;
    const backBase = _hb(fighter, 'backBase', -dirHand * radius * neutralPose.start.back.x, radius * neutralPose.start.back.y);
    const frontBase = _hb(fighter, 'frontBase', dirHand * radius * neutralPose.start.front.x, radius * neutralPose.start.front.y);

    const neutralBack = _hb(fighter, 'neutralBack', backBase.x, backBase.y);
    const neutralFront = _hb(fighter, 'neutralFront', frontBase.x, frontBase.y);
    const bob = Math.sin(time * 0.005) * 2; // subtle breathing
    neutralFront.y = frontBase.y + bob;
    neutralBack.y = backBase.y - bob * 0.6;

    if (fighter.grounded && !fighter.dodging && Math.abs(fighter.vx) > 120) {
      const pump = Math.abs(Math.sin(time * 0.016)) * radius * 0.28;
      neutralFront.x = frontBase.x + dirHand * pump;
      neutralFront.y = frontBase.y - pump * 0.5;
      neutralBack.x = backBase.x - dirHand * pump * 0.6;
      neutralBack.y = backBase.y + pump * 0.4;
    }

    if (!fighter.grounded && !fighter.dodging) {
      neutralFront.y -= radius * neutralPose.airLiftY;
      neutralBack.y -= radius * neutralPose.airLiftY;
      neutralFront.x += dirHand * radius * neutralPose.airSpreadX;
      neutralBack.x -= dirHand * radius * neutralPose.airSpreadX;
    }

    if (fighter.dodging) {
      neutralFront.x = frontBase.x * 0.35;
      neutralBack.x = backBase.x * 0.35;
      neutralFront.y = frontBase.y + radius * 0.15;
      neutralBack.y = backBase.y + radius * 0.1;
    }

    // Ease the displayed hands toward the neutral targets so every pose settles
    // back onto the same resting offsets.
    const smooth = Math.min(1, 0.42);
    if (!fighter._handBack) fighter._handBack = { x: backBase.x, y: backBase.y };
    if (!fighter._handFront) fighter._handFront = { x: frontBase.x, y: frontBase.y };
    fighter._handBack.x += (neutralBack.x - fighter._handBack.x) * smooth;
    fighter._handBack.y += (neutralBack.y - fighter._handBack.y) * smooth;
    fighter._handFront.x += (neutralFront.x - fighter._handFront.x) * smooth;
    fighter._handFront.y += (neutralFront.y - fighter._handFront.y) * smooth;

    // Reuse pre-allocated state objects for rendering.
    const backSt = _hst(fighter, 'back', x + fighter._handBack.x, y + fighter._handBack.y, 'back');
    const frontSt = _hst(fighter, 'front', x + fighter._handFront.x, y + fighter._handFront.y, 'front');

    if (backSt.layer === 'front') {
      _drawHandState(ctx, frontSt, handR, handFill);
      drawBody(ctx, fighter, skinLive);
      _drawHandState(ctx, backSt, handR, handFill);
    } else {
      _drawHandState(ctx, backSt, handR, handFill);
      drawBody(ctx, fighter, skinLive);
      _drawHandState(ctx, frontSt, handR, handFill);
    }
  }

  // Cosmetic accessory (hats & co.) — on top, unless set to draw behind.
  if (fighter.accessory && fighter.accessory.type && fighter.accessory.layer !== 'behind') {
    drawAccessory(ctx, x, y, radius, fighter.accessory);
  }

  // Dodge afterimage
  if (fighter.dodging) {
    ctx.globalAlpha = 0.3;
    ctx.beginPath();
    ctx.arc(x - fighter.dodgeDirection.x * 15, y, radius * 0.9, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  // Free-fall indicator: subtle downward-tinted glow when recovery is consumed
  if (fighter.freeFall && !fighter.grounded) {
    ctx.globalAlpha = 0.25 + 0.15 * Math.sin(time * 0.012);
    ctx.beginPath();
    ctx.arc(x, y, radius + 5, 0, Math.PI * 2);
    ctx.strokeStyle = '#ff4444';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  // Direction indicator (small arrow on top)
  const arrowY = y - radius - 10;
  const arrowX = x;
  ctx.fillStyle = '#111111';
  ctx.beginPath();
  ctx.moveTo(arrowX, arrowY);
  ctx.lineTo(arrowX - 4, arrowY - 6);
  ctx.lineTo(arrowX + 4, arrowY - 6);
  ctx.closePath();
  ctx.fill();

  ctx.restore();
}

function darkenColor(hex, amount) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgb(${Math.floor(r * (1 - amount))},${Math.floor(g * (1 - amount))},${Math.floor(b * (1 - amount))})`;
}

// Ability-world effects: projectile orbs (held fleetingly, then fired) and the
// lock-on reticle around the target while _lockTimer is running. World-space —
// call inside the camera transform, after the fighters.
export function drawAbilityFx(ctx, fighter, time) {
  const proj = fighter._projectiles;
  if (proj && proj.length) {
    for (const p of proj) {
      const pulse = 1 + 0.15 * Math.sin(time * 0.02);
      const g = ctx.createRadialGradient(p.x, p.y, 1, p.x, p.y, p.r * pulse + 4);
      g.addColorStop(0, 'rgba(255,255,255,0.95)');
      g.addColorStop(0.4, 'rgba(120,220,255,0.9)');
      g.addColorStop(1, 'rgba(80,140,255,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r * pulse + 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = 'rgba(180,230,255,0.8)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r * pulse, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  if (fighter._lockedTarget && fighter._lockTimer > 0 && fighter._lockedTarget.state !== 'dead') {
    const t = fighter._lockedTarget;
    const r = t.radius + 16;
    const spin = time * 0.01;
    ctx.strokeStyle = 'rgba(255,70,70,0.9)';
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 6]);
    ctx.beginPath();
    for (let i = 0; i <= 24; i++) {
      const a = spin + i * Math.PI / 12;
      const rr = r + Math.sin(i * 0.5) * 3;
      const px = t.x + Math.cos(a) * rr;
      const py = t.y + Math.sin(a) * rr;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.closePath();
    ctx.stroke();
    ctx.setLineDash([]);
  }
}