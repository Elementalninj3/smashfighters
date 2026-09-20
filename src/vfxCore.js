// vfxCore.js — fighter body renderer. Draws circular bodies (skin image with
// fallback to flat color), detached hands, and the Mahoraga aura. This is NOT
// the old particle/impact-ring/orbiter VFX system — all of that is scrapped.

// ── Skin image cache ──────────────────────────────────────────────────────
// One Image object per skin path, kept alive for the lifetime of the page.
// status: 'loading' | 'loaded' | 'error'
const skinImageCache = new Map();

export function getSkinImage(path) {
  if (!path) return null;
  let entry = skinImageCache.get(path);
  if (entry) {
    // A previously-failed skin is retried (throttled) so it recovers without
    // a page refresh once the asset is actually served.
    if (entry.status === 'error' && performance.now() - entry.lastAttempt > 3000) {
      retrySkinImage(entry, path);
    }
    return entry;
  }
  entry = { status: 'loading' };
  skinImageCache.set(path, entry);
  retrySkinImage(entry, path);
  return entry;
}

function retrySkinImage(entry, path) {
  entry.status = 'loading';
  entry.lastAttempt = performance.now();
  const img = new Image();
  entry.img = img;
  img.onload  = () => { entry.status = 'loaded'; };
  img.onerror = () => {
    entry.status = 'error';
    console.warn(`[skin] failed to load skin image at "${path}" — falling back to flat-color circle.`);
  };
  img.src = path;
}

// ── Body drawing ──────────────────────────────────────────────────────────
// Draws one circular body. Prefers the character skin image (cover-cropped)
// and falls back to a plain flat-color circle if the image is missing / still
// loading / errored.
export function drawBody(ctx, body) {
  if (body.hidden) return;
  drawAura(ctx, body);

  let pulseScope = false;
  if (body._sizePulseStart != null) {
    const elapsed = performance.now() - body._sizePulseStart;
    if (elapsed < 600) {
      const t = elapsed / 600;
      const pulse = 1 + 0.25 * Math.sin(t * Math.PI * 3) * (1 - t * 0.5);
      ctx.save();
      ctx.translate(body.x, body.y);
      ctx.scale(pulse, pulse);
      ctx.translate(-body.x, -body.y);
      pulseScope = true;
    }
  }

  if (body._blinkUntil && performance.now() < body._blinkUntil) {
    if (Math.floor(performance.now() / 80) % 2 === 0) { if (pulseScope) ctx.restore(); return; }
  }
  const entry = body.skin ? getSkinImage(body.skin) : null;

  if (!entry || entry.status !== 'loaded') {
    // Fallback: flat color circle
    ctx.beginPath();
    ctx.arc(body.x, body.y, body.radius, 0, Math.PI * 2);
    ctx.fillStyle   = body.color ?? '#8888ff';
    ctx.fill();
    ctx.strokeStyle = '#111';
    ctx.lineWidth   = 2;
    ctx.stroke();
  } else {
    const { img } = entry;
    const skinScale = body.skinScale ?? 1;
    const size  = body.radius * 2 * skinScale;
    // Cover-crop: scale so the shorter image dimension fills the circle's
    // bounding box, then center the overflow on the longer dimension.
    const scale  = size / Math.min(img.width, img.height);
    const drawW  = img.width  * scale;
    const drawH  = img.height * scale;
    const c = body.skinCenter;
    const cx = c ? c.x * scale : 0;
    const cy = c ? c.y * scale : 0;

    ctx.save();
    ctx.beginPath();
    ctx.arc(body.x, body.y, body.radius, 0, Math.PI * 2);
    ctx.clip();
    ctx.drawImage(img, body.x - drawW / 2 + cx, body.y - drawH / 2 + cy, drawW, drawH);
    ctx.restore();

    ctx.beginPath();
    ctx.arc(body.x, body.y, body.radius, 0, Math.PI * 2);
    ctx.strokeStyle = '#111';
    ctx.lineWidth   = 2;
    ctx.stroke();
  }

  // Purple transfiguration tint — Mahito's Domain Expansion gradually turns
  // the frozen target purple over the domain's duration.
  if (body._domainTintStart != null && body._domainTintUntil != null && performance.now() < body._domainTintUntil) {
    const now = performance.now();
    const progress = Math.min(1, (now - body._domainTintStart) / 6000);
    const alpha = progress * 0.6 * (0.85 + 0.15 * Math.sin(now / 300));
    ctx.save();
    ctx.beginPath();
    ctx.arc(body.x, body.y, body.radius, 0, Math.PI * 2);
    ctx.clip();
    ctx.globalAlpha = alpha;
    ctx.fillStyle = body._domainTintColor || '#9b30ff';
    ctx.fillRect(body.x - body.radius, body.y - body.radius, body.radius * 2, body.radius * 2);
    ctx.restore();
  }

  // White adaptation flash — solid white overlay during Mahoraga's adaptation
  if (body._whiteFlashUntil && performance.now() < body._whiteFlashUntil) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(body.x, body.y, body.radius + 2, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.45)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.7)';
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.restore();
  }

  // Pitch-black cinematic blackout — Final Cut turns the victim's skin black
  if (body._blackOutUntil && performance.now() < body._blackOutUntil) {
    ctx.save();
    const remain = body._blackOutUntil - performance.now();
    ctx.globalAlpha = Math.min(1, remain / 250);
    ctx.beginPath();
    ctx.arc(body.x, body.y, body.radius, 0, Math.PI * 2);
    ctx.clip();
    ctx.fillStyle = '#000000';
    ctx.fillRect(body.x - body.radius, body.y - body.radius, body.radius * 2, body.radius * 2);
    ctx.restore();
  }

  // Red damage flash overlay — flickers rapidly when _damageFlashUntil is in the future
  if (body._damageFlashUntil && performance.now() < body._damageFlashUntil) {
    const flashPhase = Math.floor(performance.now() / 60) % 2;
    if (flashPhase === 0) {
      ctx.save();
      ctx.beginPath();
      ctx.arc(body.x, body.y, body.radius + 2, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255, 40, 40, 0.45)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(255, 0, 0, 0.7)';
      ctx.lineWidth = 3;
      ctx.stroke();
      ctx.restore();
    }
  }

  if (pulseScope) ctx.restore();
}

// ── Aura ──
let _auraTime = 0;
const _auraParticles = [];
const AURA_COLORS = ['#FFD700', '#FFC107', '#FFF8DC', '#FFEB3B', '#FFE082'];

export function stepAura(dt) { _auraTime += dt; }

function spawnAuraParticle(x, y) {
  const angle = Math.random() * Math.PI * 2;
  const speed = Math.random() * 2.5 + 1;
  _auraParticles.push({
    x, y, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed,
    radius: Math.random() * 6 + 3,
    color: AURA_COLORS[Math.floor(Math.random() * AURA_COLORS.length)],
    life: 1, decay: Math.random() * 0.02 + 0.01,
  });
}

function drawAura(ctx, body) {
  if (!body._fullyAdaptedGrown) return;
  const t = _auraTime;
  const r = body.radius;
  const cx = body.x;
  const cy = body.y;

  // three pulsing gold glow rings
  ctx.save();
  const ringCount = 3;
  for (let i = 0; i < ringCount; i++) {
    const ringOffset = (t * 0.04 + i * (Math.PI * 2 / ringCount)) % (Math.PI * 2);
    const pulseRadius = r + 15 + (i * 25) + Math.sin(ringOffset) * 10;
    const alpha = Math.max(0, 0.4 - (i * 0.1) + Math.sin(ringOffset) * 0.15);
    ctx.shadowBlur = 40;
    ctx.shadowColor = '#FFC107';
    ctx.fillStyle = `rgba(255, 215, 0, ${alpha})`;
    ctx.beginPath();
    ctx.arc(cx, cy, pulseRadius, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();

  // manage particle count
  while (_auraParticles.length < 35) spawnAuraParticle(cx, cy);

  // update and draw particles
  for (let i = _auraParticles.length - 1; i >= 0; i--) {
    const p = _auraParticles[i];
    p.x += p.vx;
    p.y += p.vy;
    p.life -= p.decay;
    p.radius *= 0.98;

    if (p.life <= 0 || Math.hypot(p.x - cx, p.y - cy) > 400) {
      p.x = cx; p.y = cy;
      const angle = Math.random() * Math.PI * 2;
      const speed = Math.random() * 2.5 + 1;
      p.vx = Math.cos(angle) * speed;
      p.vy = Math.sin(angle) * speed;
      p.radius = Math.random() * 6 + 3;
      p.color = AURA_COLORS[Math.floor(Math.random() * AURA_COLORS.length)];
      p.life = 1;
      p.decay = Math.random() * 0.02 + 0.01;
      continue;
    }

    ctx.save();
    ctx.globalAlpha = Math.max(p.life, 0);
    ctx.shadowBlur = 25;
    ctx.shadowColor = '#FFD700';
    ctx.fillStyle = p.color;
    ctx.strokeStyle = '#000000';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(p.x, p.y, Math.max(p.radius, 0.1), 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }
}

// ── Hands ─────────────────────────────────────────────────────────────────
// Draws two detached circular hands.
const HAND_GAP = 110 * Math.PI / 180; // 110 degrees between hands

export function drawHands(ctx, body) {
  if (!body.hands || body.hidden) return;

  const r  = body.radius;
  const hr = r * 0.22;
  const d  = r + 0.14 * hr;

  const hx = body._handsCenterOverride ? body._handsCenterOverride.x : body.x;
  const hy = body._handsCenterOverride ? body._handsCenterOverride.y : body.y;

  const rigAngle = body.handsAngle ?? 0;

  function drawCircleHand(hand, canvasAngle) {
    if (hand.hidden) return;
    if (hand.punchT > 0) hand.punchT = Math.max(0, hand.punchT - 0.06);

    const blackout = body._blackOutUntil && performance.now() < body._blackOutUntil;
    const fillColor = blackout ? '#000000' : (hand.color || '#ffe0bd');
    const blackoutAlpha = blackout ? Math.min(1, (body._blackOutUntil - performance.now()) / 250) : 1;

    const punchExtend = hand.punchT * r * 1.2;
    const fistScale = 1 + hand.punchT * 0.35;
    const cx = hx + Math.cos(canvasAngle) * (d + punchExtend);
    const cy = hy + Math.sin(canvasAngle) * (d + punchExtend);
    const hRad = hr * fistScale;

    ctx.save();
    if (blackout) ctx.globalAlpha = blackoutAlpha;
    if (hand.glow) {
      ctx.shadowBlur = 30;
      ctx.shadowColor = hand.glow;
    }

    if (hand.fist) {
      const thumbAngle = canvasAngle - Math.PI * 0.45;
      const thumbX = cx + Math.cos(thumbAngle) * hRad * 0.6;
      const thumbY = cy + Math.sin(thumbAngle) * hRad * 0.6;

      ctx.beginPath();
      ctx.arc(thumbX, thumbY, hRad * 0.32, 0, Math.PI * 2);
      ctx.fillStyle = fillColor;
      ctx.fill();
      ctx.strokeStyle = '#111';
      ctx.lineWidth = 1.5;
      ctx.stroke();

      ctx.beginPath();
      ctx.arc(cx, cy, hRad, 0, Math.PI * 2);
      ctx.fillStyle = fillColor;
      ctx.fill();
      ctx.strokeStyle = '#111';
      ctx.lineWidth = 2;
      ctx.stroke();

      ctx.beginPath();
      ctx.arc(cx, cy, hRad * 0.65, canvasAngle - 0.5, canvasAngle + 0.5);
      ctx.strokeStyle = 'rgba(17,17,17,0.25)';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    } else {
      ctx.beginPath();
      ctx.arc(cx, cy, hRad, 0, Math.PI * 2);
      ctx.fillStyle = fillColor;
      ctx.fill();
      ctx.strokeStyle = '#111';
      ctx.lineWidth = 2;
      ctx.stroke();

      for (let f = -1; f <= 1; f++) {
        const fa = canvasAngle + f * 0.45;
        const fx1 = cx + Math.cos(fa) * hRad * 0.3;
        const fy1 = cy + Math.sin(fa) * hRad * 0.3;
        const fx2 = cx + Math.cos(fa) * hRad * 0.85;
        const fy2 = cy + Math.sin(fa) * hRad * 0.85;
        ctx.beginPath();
        ctx.moveTo(fx1, fy1);
        ctx.lineTo(fx2, fy2);
        ctx.strokeStyle = 'rgba(17,17,17,0.3)';
        ctx.lineWidth = 1.2;
        ctx.stroke();
      }
    }

    if (hand.spike) {
      const spikeLen = hRad * 1.6;
      const spikeWidth = hRad * 0.5;
      const sx = cx + Math.cos(canvasAngle) * hRad * 0.6;
      const sy = cy + Math.sin(canvasAngle) * hRad * 0.6;
      ctx.beginPath();
      ctx.moveTo(sx + Math.cos(canvasAngle) * spikeLen, sy + Math.sin(canvasAngle) * spikeLen);
      ctx.lineTo(sx + Math.cos(canvasAngle + 0.5) * spikeWidth, sy + Math.sin(canvasAngle + 0.5) * spikeWidth);
      ctx.lineTo(sx + Math.cos(canvasAngle - 0.5) * spikeWidth, sy + Math.sin(canvasAngle - 0.5) * spikeWidth);
      ctx.closePath();
      ctx.fillStyle = fillColor;
      ctx.fill();
      ctx.strokeStyle = '#111';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }

    ctx.restore();
  }

  if (!body._handsHidden) {
    if (body._useIndependentAngles) {
      drawCircleHand(body.hands.right, body.hands.right.angle ?? 0);
      drawCircleHand(body.hands.left, body.hands.left.angle ?? HAND_GAP);
    } else if (body._handsLocked) {
      const lockedAngle = body.handsAngle ?? rigAngle;
      drawCircleHand(body.hands.right, lockedAngle);
      drawCircleHand(body.hands.left,  lockedAngle + HAND_GAP);
    } else {
      drawCircleHand(body.hands.right, rigAngle);
      drawCircleHand(body.hands.left,  rigAngle + HAND_GAP);
    }
  }
}
