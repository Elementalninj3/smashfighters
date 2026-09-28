// effects.js — THE character VFX art module. One file, one contract.
//
// Every effect here is stateless and character-bound: draw(ctx, v, p) is a pure
// function of v.progress, with rotation authored in degrees, v.scale scaling the
// whole effect and v.mirrorX flipping it to match the attack's direction. The
// game re-draws each effect from scratch every frame, so nothing here may keep a
// clock, a timer or a random value that changes between frames — the source
// demos' Math.random() calls became deterministic hashes of the particle index.
// That is what lets the animator start, scrub or drop an effect at any moment
// and still paint the identical picture.
//
// Every effect here is ability art: the registry is what the animator's effect
// picker and src/effects/vfx.js read, and only a move bound to a Cowboy/Ninja ability is
// allowed to paint. The general gameplay effects that used to live here —
// jumpVfx, landingVfx, hardLandingVfx, fastFallVfx, directionChangeVfx,
// recoveryVfx, recoveryTrailVfx, aerialLightRecoveryVfx (all movement/recovery
// dust) and the Shadow Push pair shadowPoof + shadowBlast — are GONE, not
// hidden: their triggers were removed along with the last animations that
// placed them, so nothing reached them. `bullet` stays as the registry's
// unknown-effect fallback (vfx.js: VFX_EFFECTS[v.effect] || VFX_EFFECTS.bullet)
// even though no ability authors it any more.
//
// Three converted art sources live here, each with its own header above its
// section explaining the demo it came from and the math that replaced it:
//   • COWBOY_AL_VFX  — cowboyMuzzle (Side Smash report), bullet / spray / blast
//                      (Side Smash report), cowboyTrail (rifle round),
//                      ninjaMuzzle (Shuriken Throw), ninjaTrail (shuriken),
//                      slash (Teleport Strike)
//   • SHADOW_DASH_VFX — the ninja Shadow Strike afterimage trail
//   • SMOKE_VFX       — the ninja Teleport Strike smoke bomb
//   • BOXER_VFX       — the boxer's Deadeye Roll aura, the Grab's punch-away
//                      impact, and the Straight Right's reach streak
//
// They are merged into one module because they share this contract and the same
// single consumer (src/effects/vfx.js); their helpers are name-prefixed per art so the
// three sets can never shadow each other.


// ── Shared easing + static seed tables (module scope) ────────────────────
// These were closures/array literals rebuilt inside every draw() call, plus
// per-draw forEach closures. Hoisted here: identical math, zero per-frame
// allocation. easeOutExpo uses a multiply chain instead of Math.pow.
function artEaseOutExpo(t) { return t >= 1 ? 1 : 1 - Math.pow(2, -10 * t); }
function artEaseOutQuad(t) { return t * (2 - t); }
const TAU = Math.PI * 2;
const _SPRAY_SEEDS = [-0.65, -0.42, -0.2, -0.02, 0.16, 0.38, 0.6];
const _SPRAY_EMBERS = [-0.4, -0.14, 0.08, 0.32];
const _BLAST_SEEDS = [-0.6, -0.4, -0.18, -0.02, 0.15, 0.35, 0.55];
const _BLAST_EMBERS = [-0.35, -0.12, 0.06, 0.3];
const _BLAST_TRACERS = [
  [-0.5, 110, 3.5, 0], [-0.28, 140, 4.5, 1], [-0.08, 165, 5.5, 0],
  [0.08, 160, 5.5, 0], [0.28, 135, 4.5, 1], [0.5, 105, 3.5, 0],
];

const COWBOY_AL_VFX = {
  bullet: {
    name: 'Bullet',
    color: '#ff9900',
    draw(ctx, v, p) {
      ctx.save();
      ctx.translate(p.x, p.y);
      const s = v.scale || 1;
      const mx = v.mirrorX == null ? 1 : v.mirrorX;
      if (s !== 1 || mx !== 1) ctx.scale(s * mx, s);
      if (v.rotation) ctx.rotate((v.rotation * Math.PI) / 180);

      const prog = v.progress;
      const mainColor = v.color || '#ff9900';
      const easeOutExpo = artEaseOutExpo;

      ctx.globalCompositeOperation = 'lighter';

      // Muzzle flash (first third).
      if (prog < 0.3) {
        const flashAlpha = 1 - prog / 0.3;
        const flashRadius = (1 - easeOutExpo(prog / 0.3)) * 20 + 3;
        ctx.save();
        ctx.globalAlpha = flashAlpha;
        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        ctx.arc(0, 0, flashRadius, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = mainColor;
        ctx.beginPath();
        ctx.arc(0, 0, flashRadius * 1.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }

      // Single long tracer racing out along +x.
      ctx.globalAlpha = Math.max(0, 1 - prog);
      const len = 150;
      const end = easeOutExpo(prog) * len;
      const w = 4.5 * (1 - prog * 0.4);
      ctx.lineCap = 'round';

      ctx.strokeStyle = mainColor;
      ctx.lineWidth = w;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(end, 0);
      ctx.stroke();

      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = w * 0.5;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(end, 0);
      ctx.stroke();
      ctx.lineCap = 'butt';

      ctx.restore();
    },
  },

  spray: {
    name: 'Spray',
    color: '#ffdd44',
    draw(ctx, v, p) {
      ctx.save();
      ctx.translate(p.x, p.y);
      const s = v.scale || 1;
      const mx = v.mirrorX == null ? 1 : v.mirrorX;
      if (s !== 1 || mx !== 1) ctx.scale(s * mx, s);
      if (v.rotation) ctx.rotate((v.rotation * Math.PI) / 180);

      const prog = v.progress;
      const easeOutQuad = artEaseOutQuad;

      ctx.globalCompositeOperation = 'lighter';

      // Spark flecks fanning out along +x.
      ctx.save();
      ctx.globalAlpha = Math.max(0, 1 - prog);
      ctx.strokeStyle = '#ffdd44';
      ctx.lineWidth = 2.0;
      ctx.lineCap = 'round';
      {
        const q = easeOutQuad(prog);
        const sparkLen = (1 - prog) * 24;
        for (let i = 0; i < _SPRAY_SEEDS.length; i++) {
          const angle = _SPRAY_SEEDS[i];
          const speedMult = 1 + ((i * 37) % 5) * 0.2;
          const startDist = q * 75 * speedMult;
          const endDist = startDist + sparkLen;
          const c = Math.cos(angle), sn = Math.sin(angle);
          ctx.beginPath();
          ctx.moveTo(c * startDist, sn * startDist);
          ctx.lineTo(c * endDist, sn * endDist);
          ctx.stroke();
        }
      }
      ctx.lineCap = 'butt';
      ctx.restore();

      // Heat embers drifting up from the muzzle.
      if (prog > 0.15) {
        const emberProg = (prog - 0.15) / 0.85;
        ctx.save();
        ctx.globalAlpha = (1 - emberProg) * 0.85;
        ctx.fillStyle = '#ff4400';
        {
          const q = easeOutQuad(emberProg);
          const lift = emberProg * -6;
          const size = Math.max(0.5, (1 - emberProg) * 3);
          for (let i = 0; i < _SPRAY_EMBERS.length; i++) {
            const angle = _SPRAY_EMBERS[i];
            const dist = q * (65 + i * 16);
            const ex = Math.cos(angle) * dist;
            const ey = Math.sin(angle) * dist + lift;
            ctx.beginPath();
            ctx.arc(ex, ey, size, 0, TAU);
            ctx.fill();
          }
        }
        ctx.restore();
      }

      ctx.restore();
    },
  },

  blast: {
    name: 'Blast',
    color: '#ff9900',
    draw(ctx, v, p) {
      ctx.save();
      ctx.translate(p.x, p.y);
      const s = v.scale || 1;
      const mx = v.mirrorX == null ? 1 : v.mirrorX;
      if (s !== 1 || mx !== 1) ctx.scale(s * mx, s);
      if (v.rotation) ctx.rotate((v.rotation * Math.PI) / 180);

      const prog = v.progress;
      const mainColor = v.color || '#ff9900';

      const easeOutQuad = artEaseOutQuad;
      const easeOutExpo = artEaseOutExpo;

      ctx.globalCompositeOperation = 'lighter';

      // 1. Core Flash.
      if (prog < 0.35) {
        const flashAlpha = 1 - prog / 0.35;
        const flashRadius = (1 - easeOutExpo(prog / 0.35)) * 32 + 4;
        ctx.save();
        ctx.globalAlpha = flashAlpha;
        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        ctx.arc(0, 0, flashRadius, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = mainColor;
        ctx.beginPath();
        ctx.arc(0, 0, flashRadius * 1.6, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }

      // 2. Extended Cone Shockwave Ring.
      if (prog > 0.05 && prog < 0.8) {
        const waveProg = (prog - 0.05) / 0.75;
        const waveAlpha = 1 - waveProg;
        const radius = easeOutExpo(waveProg) * 75;
        ctx.save();
        ctx.globalAlpha = waveAlpha * 0.6;
        ctx.strokeStyle = '#ffe49e';
        ctx.lineWidth = 3 * (1 - waveProg);
        ctx.beginPath();
        ctx.arc(0, 0, radius, -Math.PI * 0.3, Math.PI * 0.3);
        ctx.stroke();
        ctx.restore();
      }

      // 3. High-Reach Bullet Tracer Fan.
      ctx.save();
      ctx.globalAlpha = Math.max(0, 1 - easeOutQuad(prog));
      {
        const headProgress = easeOutExpo(prog);
        const tailProgress = easeOutQuad(prog * 0.8);
        const wScale = 1 - prog * 0.4;
        ctx.lineCap = 'round';
        for (let i = 0; i < _BLAST_TRACERS.length; i++) {
          const t = _BLAST_TRACERS[i];
          const angle = t[0], len = t[1], w = t[2];
          const startDist = tailProgress * len;
          const endDist = headProgress * len;
          const c = Math.cos(angle), sn = Math.sin(angle);
          ctx.strokeStyle = t[3] ? mainColor : '#ffffff';
          ctx.lineWidth = w * wScale;
          ctx.beginPath();
          ctx.moveTo(c * startDist, sn * startDist);
          ctx.lineTo(c * endDist, sn * endDist);
          ctx.stroke();
        }
      }
      ctx.lineCap = 'butt';
      ctx.restore();

      // 4. Spark Flecks.
      ctx.save();
      ctx.globalAlpha = Math.max(0, 1 - prog);
      ctx.strokeStyle = '#ffdd44';
      ctx.lineWidth = 2.0;
      ctx.lineCap = 'round';
      {
        const q = easeOutQuad(prog);
        const sparkLen = (1 - prog) * 25;
        for (let i = 0; i < _BLAST_SEEDS.length; i++) {
          const angle = _BLAST_SEEDS[i];
          const speedMult = 1 + ((i * 37) % 5) * 0.2;
          const startDist = q * 80 * speedMult;
          const endDist = startDist + sparkLen;
          const c = Math.cos(angle), sn = Math.sin(angle);
          ctx.beginPath();
          ctx.moveTo(c * startDist, sn * startDist);
          ctx.lineTo(c * endDist, sn * endDist);
          ctx.stroke();
        }
      }
      ctx.lineCap = 'butt';
      ctx.restore();

      // 5. Heat Embers.
      if (prog > 0.15) {
        const emberProg = (prog - 0.15) / 0.85;
        ctx.save();
        ctx.globalAlpha = (1 - emberProg) * 0.85;
        ctx.fillStyle = '#ff4400';
        {
          const q = easeOutQuad(emberProg);
          const lift = emberProg * -6;
          const size = Math.max(0.5, (1 - emberProg) * 3);
          for (let i = 0; i < _BLAST_EMBERS.length; i++) {
            const angle = _BLAST_EMBERS[i];
            const dist = q * (70 + i * 18);
            const ex = Math.cos(angle) * dist;
            const ey = Math.sin(angle) * dist + lift;
            ctx.beginPath();
            ctx.arc(ex, ey, size, 0, TAU);
            ctx.fill();
          }
        }
        ctx.restore();
      }

      ctx.restore();
    },
  },
  cowboyMuzzle: {
    name: 'Cowboy Muzzle',
    color: '#f59e0b',
    draw(ctx, v, p) {
      ctx.save();
      ctx.translate(p.x, p.y);
      const s = v.scale || 1;
      const mx = v.mirrorX == null ? 1 : v.mirrorX;
      if (s !== 1 || mx !== 1) ctx.scale(s * mx, s);
      if (v.rotation) ctx.rotate((v.rotation * Math.PI) / 180);
      ctx.globalCompositeOperation = 'lighter';

      const prog = v.progress;
      const easeOutExpo = t => (t === 1 ? 1 : 1 - Math.pow(2, -10 * t));

      // Central Toon Starburst (first third).
      if (prog < 0.3) {
        const flashAlpha = 1 - prog / 0.3;
        const flashRadius = (1 - easeOutExpo(prog / 0.3)) * 22 + 4;
        const spikeCount = 7;
        ctx.save();
        ctx.globalAlpha = flashAlpha;
        ctx.strokeStyle = '#000000';
        ctx.lineWidth = 3.5;
        ctx.lineJoin = 'miter';
        ctx.fillStyle = flashAlpha > 0.5 ? '#ffffff' : '#fbbf24';
        ctx.beginPath();
        const step = (Math.PI * 2) / (spikeCount * 2);
        for (let i = 0; i < spikeCount * 2; i++) {
          const r = (i % 2 === 0) ? flashRadius : flashRadius * 0.35;
          const a = i * step;
          const px = Math.cos(a) * r;
          const py = Math.sin(a) * r;
          if (i === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        }
        ctx.closePath();
        ctx.stroke();
        ctx.fill();
        // Inner hot core
        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        ctx.arc(0, 0, flashRadius * 0.25, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }

      // Radial flying toon sparks.
      ctx.save();
      const sparkCount = 10;
      for (let i = 0; i < sparkCount; i++) {
        const seed = i * 37;
        const angle = (seed % 360) * Math.PI / 180;
        const speed = 80 + (seed % 5) * 15;
        const dist = easeOutExpo(Math.min(1, prog * 1.5)) * speed;
        const sparkAlpha = Math.max(0, 1 - prog * 1.8);
        if (sparkAlpha <= 0) continue;
        const sx = Math.cos(angle) * dist;
        const sy = Math.sin(angle) * dist;
        const size = Math.max(0.5, (1 - prog * 1.8) * 5);
        ctx.globalAlpha = sparkAlpha;
        ctx.strokeStyle = '#000000';
        ctx.lineWidth = 2;
        ctx.fillStyle = '#f59e0b';
        ctx.beginPath();
        ctx.arc(sx, sy, size, 0, Math.PI * 2);
        ctx.stroke();
        ctx.fill();
      }
      ctx.restore();

      ctx.restore();
    },
  },
  cowboyTrail: {
    name: 'Cowboy Trail',
    color: '#f59e0b',
    draw(ctx, v, p) {
      ctx.save();
      ctx.translate(p.x, p.y);
      const s = v.scale || 1;
      const mx = v.mirrorX == null ? 1 : v.mirrorX;
      if (s !== 1 || mx !== 1) ctx.scale(s * mx, s);
      if (v.rotation) ctx.rotate((v.rotation * Math.PI) / 180);
      ctx.globalCompositeOperation = 'lighter';

      const prog = v.progress;
      const trailLen = 55;
      const headR = 6.5;

      // Outer black toon outline (bullet trail shape).
      ctx.beginPath();
      ctx.arc(0, 0, headR, -Math.PI / 2, Math.PI / 2, false);
      ctx.lineTo(-trailLen, 1.2);
      ctx.lineTo(-trailLen, -1.2);
      ctx.closePath();
      ctx.strokeStyle = '#000000';
      ctx.lineWidth = 3.5;
      ctx.lineJoin = 'round';
      ctx.stroke();

      // Golden brass bullet fill.
      ctx.fillStyle = '#f59e0b';
      ctx.fill();

      // Inner bright tracer core.
      ctx.beginPath();
      ctx.arc(0, 0, headR * 0.5, -Math.PI / 2, Math.PI / 2, false);
      ctx.lineTo(-trailLen * 0.7, 0.5);
      ctx.lineTo(-trailLen * 0.7, -0.5);
      ctx.closePath();
      ctx.fillStyle = '#fffbeb';
      ctx.fill();

      // Cartoon speed accent lines.
      ctx.strokeStyle = '#000000';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(-10, -headR - 3);
      ctx.lineTo(-trailLen * 0.85, -headR - 3);
      ctx.moveTo(-6, headR + 3);
      ctx.lineTo(-trailLen * 0.75, headR + 3);
      ctx.stroke();

      ctx.restore();
    },
  ninjaTrail: {
    name: 'Ninja Trail',
    color: '#2c3e50',
    draw(ctx, v, p) {
      ctx.save();
      ctx.translate(p.x, p.y);
      const s = v.scale || 1;
      const mx = v.mirrorX == null ? 1 : v.mirrorX;
      if (s !== 1 || mx !== 1) ctx.scale(s * mx, s);
      if (v.rotation) ctx.rotate((v.rotation * Math.PI) / 180);
      ctx.globalCompositeOperation = 'lighter';

      const prog = v.progress;
      const trailLen = 45;
      const headR = 5.5;

      // Shuriken shape - 4-pointed star
      const points = 4;
      const outerR = headR;
      const innerR = headR * 0.4;

      // Trail body (dark shadow)
      ctx.beginPath();
      ctx.arc(0, 0, outerR, -Math.PI / 2, Math.PI / 2, false);
      ctx.lineTo(-trailLen, 1.5);
      ctx.lineTo(-trailLen, -1.5);
      ctx.closePath();
      ctx.strokeStyle = '#000000';
      ctx.lineWidth = 3;
      ctx.lineJoin = 'round';
      ctx.stroke();

      // Trail fill (dark blue)
      ctx.fillStyle = '#1a252f';
      ctx.fill();

      // Inner bright core
      ctx.beginPath();
      ctx.arc(0, 0, headR * 0.45, -Math.PI / 2, Math.PI / 2, false);
      ctx.lineTo(-trailLen * 0.65, 0.4);
      ctx.lineTo(-trailLen * 0.65, -0.4);
      ctx.closePath();
      ctx.fillStyle = '#3498db';
      ctx.fill();

      // Shuriken star at head
      ctx.beginPath();
      for (let i = 0; i < points * 2; i++) {
        const angle = (i * Math.PI) / points - Math.PI / 2;
        const r = i % 2 === 0 ? outerR : innerR;
        const x = Math.cos(angle) * r;
        const y = Math.sin(angle) * r;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.strokeStyle = '#000000';
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.fillStyle = '#2c3e50';
      ctx.fill();

      // Inner glow on shuriken
      ctx.beginPath();
      ctx.arc(0, 0, outerR * 0.5, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(52, 152, 219, 0.6)';
      ctx.fill();

      ctx.restore();
    },
  },
},
  slash: {
    name: 'Slash',
    color: '#3498db',
    draw(ctx, v, p) {
      ctx.save();
      ctx.translate(p.x, p.y);
      const s = v.scale || 1;
      const mx = v.mirrorX == null ? 1 : v.mirrorX;
      if (s !== 1 || mx !== 1) ctx.scale(s * mx, s);
      if (v.rotation) ctx.rotate((v.rotation * Math.PI) / 180);
      ctx.globalCompositeOperation = 'lighter';

      const prog = v.progress;
      const easeOutQuad = t => t * (2 - t);
      const eased = easeOutQuad(prog);

      // Slash arc
      const arcLength = 90;
      const arcWidth = 12 * (1 - eased * 0.3);

      ctx.lineCap = 'round';
      ctx.lineWidth = arcWidth;
      ctx.strokeStyle = '#1a252f';
      ctx.beginPath();
      ctx.arc(0, 0, 20, -Math.PI / 2 - arcLength / 2 * Math.PI / 180, -Math.PI / 2 + arcLength / 2 * Math.PI / 180);
      ctx.stroke();

      ctx.lineWidth = arcWidth * 0.7;
      ctx.strokeStyle = '#3498db';
      ctx.beginPath();
      ctx.arc(0, 0, 20, -Math.PI / 2 - arcLength / 2 * Math.PI / 180 + eased * 0.3, -Math.PI / 2 + arcLength / 2 * Math.PI / 180 - eased * 0.3);
      ctx.stroke();

      ctx.lineWidth = arcWidth * 0.35;
      ctx.strokeStyle = '#ffffff';
      ctx.globalAlpha = 1 - eased;
      ctx.beginPath();
      ctx.arc(0, 0, 20, -Math.PI / 2 - arcLength / 2 * Math.PI / 180 + eased * 0.5, -Math.PI / 2 + arcLength / 2 * Math.PI / 180 - eased * 0.5);
      ctx.stroke();

      ctx.lineCap = 'butt';
      ctx.restore();
    },
  },
  ninjaMuzzle: {
    name: 'Ninja Muzzle',
    color: '#3498db',
    draw(ctx, v, p) {
      ctx.save();
      ctx.translate(p.x, p.y);
      const s = v.scale || 1;
      const mx = v.mirrorX == null ? 1 : v.mirrorX;
      if (s !== 1 || mx !== 1) ctx.scale(s * mx, s);
      if (v.rotation) ctx.rotate((v.rotation * Math.PI) / 180);
      ctx.globalCompositeOperation = 'lighter';

      const prog = v.progress;
      const easeOutExpo = t => (t === 1 ? 1 : 1 - Math.pow(2, -10 * t));

      // Quick flash
      if (prog < 0.4) {
        const flashAlpha = 1 - prog / 0.4;
        const flashRadius = (1 - easeOutExpo(prog / 0.4)) * 15 + 5;
        ctx.save();
        ctx.globalAlpha = flashAlpha;
        ctx.fillStyle = '#3498db';
        ctx.beginPath();
        ctx.arc(0, 0, flashRadius, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        ctx.arc(0, 0, flashRadius * 0.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }

      // Shuriken spin effect
      ctx.save();
      ctx.rotate(prog * Math.PI * 4);
      for (let i = 0; i < 4; i++) {
        const angle = i * Math.PI / 2;
        const dist = easeOutExpo(Math.min(1, prog * 2)) * 20;
        const x = Math.cos(angle) * dist;
        const y = Math.sin(angle) * dist;
        ctx.fillStyle = 'rgba(52, 152, 219, ' + (1 - prog) + ')';
        ctx.beginPath();
        ctx.moveTo(x, y - 4);
        ctx.lineTo(x + 4, y);
        ctx.lineTo(x, y + 4);
        ctx.lineTo(x - 4, y);
        ctx.closePath();
        ctx.fill();
      }
      ctx.restore();

      ctx.restore();
    },
  },
};


// ═══════════════════════════════════════════════════════════════════════════
// Shadow Strike trail (converted from GA/vfx/shadowdash.html)
// ═══════════════════════════════════════════════════════════════════════════
export const SHADOW_DASH = {
  // The demo's player body (44×76) is the reference the art was composed around;
  // the game scales it by unit = fighterDiameter / refBodyHeight.
  refBodyWidth: 44,
  refBodyHeight: 76,
  // The demo's dash: 14 frames at 22 px/frame, afterimages dropped every 2nd
  // frame, plus the arrival burst on the final frame.
  dashFrames: 14,
  ghostEvery: 2,
  // Total art timeline: the last trail streak (spawned on the final dash frame)
  // fades out 20 frames later, so the sequence reads 0 → 34 frames.
  artFrames: 34,
  // Fallbacks when the effect is placed from the animator (no params): the
  // Shadow Strike ability's own dash distance (NINJA_ATTACKS.dsmash.dashDistance)
  // and its remaining frames. The ability normally passes the distance it
  // actually travelled, so this only matters for a param-less placement.
  defaultDistance: 192,
  strikeFrames: 22,
};

// ── deterministic stand-ins for the demo's Math.random() ──────────────────
// The game re-draws the effect from scratch every frame, so a value has to be a
// function of WHO it belongs to (particle/frame index), never of when it was
// drawn — otherwise every streak would flicker. This is the usual GLSL-style
// hash: same index in, same [0,1) out, on every machine.
function sdHash01(n) {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}
// Memoized hash: every call site passes a fixed per-particle index, so the
// value set is tiny (~100 unique inputs per effect). The sin is computed once
// ever per input instead of once per particle per frame — identical output.
const _sdHashCache = new Map();
function sdHash01c(n) {
  let h = _sdHashCache.get(n);
  if (h === undefined) {
    h = sdHash01(n);
    if (_sdHashCache.size < 1024) _sdHashCache.set(n, h);
  }
  return h;
}

// ── the demo's per-frame particle integration, solved for the age ─────────
// The demo stepped every particle once per rendered frame:
//   p += v;  v *= 0.88;  life -= decay
// Both the travelled offset and the live velocity therefore have closed forms —
// so a particle can be reconstructed at any age without ever being stepped.
const DRAG = 0.88;
const SD_DRAG_SUM = 1 - DRAG;
// Math.exp(age * ln) instead of Math.pow(DRAG, age): same value (to <1e-12),
// single libm call instead of pow's slow path — and this runs per particle
// per frame in the densest effect in the game.
const LN_DRAG = Math.log(DRAG);

function sdTravel(v, age) { return (v * (1 - Math.exp(age * LN_DRAG))) / SD_DRAG_SUM; }
function sdLive(v, age) { return v * Math.exp(age * LN_DRAG); }
function sdFade(age, decay) { return 1 - decay * age; }

const SD_TAU = Math.PI * 2;
const SD_NO_PARAMS = {};

// A single streak: a line drawn from the particle's position back along 2× its
// live velocity (the demo's shape for every 'streak' particle).
function sdStreak(ctx, x, y, vx, vy, size, life, color) {
  ctx.globalAlpha = life;
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(1, size * life);
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x - vx * 2, y - vy * 2);
  ctx.stroke();
}

// A single round spark ('circle' particle): radius shrinks with its life.
function sdSpark(ctx, x, y, size, life, color) {
  ctx.globalAlpha = life;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(x, y, Math.max(0.5, size * life), 0, SD_TAU);
  ctx.fill();
}

// ── the effect ────────────────────────────────────────────────────────────
const SHADOW_DASH_VFX = {
  shadowDash: {
    name: 'Shadow Dash',
    color: '#a855f7',
    draw(ctx, v, p) {
      // Standard VFX transform: translate → scale(scale × mirror) → rotate, so a
      // left-facing Shadow Strike mirrors the whole trail instead of firing it
      // the wrong way.
      ctx.save();
      ctx.translate(p.x, p.y);
      const s = v.scale || 1;
      const mx = v.mirrorX == null ? 1 : v.mirrorX;
      if (s !== 1 || mx !== 1) ctx.scale(s * mx, s);
      if (v.rotation) ctx.rotate((v.rotation * Math.PI) / 180);

      const P = v.params || SD_NO_PARAMS;
      const u = P.unit == null ? 1 : P.unit;                        // fighter-body scale
      const distance = P.distance == null ? SHADOW_DASH.defaultDistance : P.distance;
      const gh = SHADOW_DASH.refBodyHeight * u;                     // vertical spread
      const bodyR = gh / 2;                                         // = fighter.radius (ghost circle radius)
      const f = (v.progress == null ? 0 : v.progress) * SHADOW_DASH.artFrames;

      // 1) Afterimages — one circle dropped every 2nd dash frame at the spot the
      //    fighter (a ball in-game) occupied at that moment, newest first (the
      //    demo's draw order).
      const ghosts = Math.floor(SHADOW_DASH.dashFrames / SHADOW_DASH.ghostEvery);
      for (let i = ghosts - 1; i >= 0; i--) {
        const at = (i + 1) * SHADOW_DASH.ghostEvery;               // art frames 2,4,…,14
        const age = f - at;
        if (age < 0) continue;
        const life = sdFade(age, 0.08);
        if (life <= 0) continue;
        const gx = -distance + distance * (at / SHADOW_DASH.dashFrames);
        // The game paints VFX above the fighter (the demo painted its ghosts
        // behind its player), so the circle still inside the fighter's own
        // body is skipped — it is the part nobody ever saw in the demo either.
        if (Math.abs(gx) < bodyR) continue;

        ctx.globalAlpha = 0.85 * life * 0.6;
        ctx.fillStyle = '#09090b';
        ctx.strokeStyle = '#a855f7';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(gx, 0, bodyR, 0, SD_TAU);
        ctx.fill();
        ctx.stroke();
      }

      // 2) Departure burst — the dark energy blast + sharp purple spark ring the
      //    demo fired the instant the dash began, at the departure point.
      for (let i = 0; i < 18; i++) {
        const life = sdFade(f, 0.06);
        if (life <= 0) continue;
        const a = sdHash01c(i * 7 + 1) * SD_TAU;
        const sp = (3 + sdHash01c(i * 7 + 2) * 9) * u;
        const vx = Math.cos(a) * sp;
        const vy = Math.sin(a) * sp;
        sdStreak(ctx, -distance + sdTravel(vx, f), sdTravel(vy, f), sdLive(vx, f), sdLive(vy, f),
          (5 + sdHash01c(i * 7 + 4) * 6) * u, life,
          sdHash01c(i * 7 + 3) > 0.4 ? '#09090b' : '#3b0764');
      }
      for (let i = 0; i < 8; i++) {
        const life = sdFade(f, 0.08);
        if (life <= 0) continue;
        const a = (i / 8) * SD_TAU;
        const sp = 7 * u;
        sdSpark(ctx, -distance + sdTravel(Math.cos(a) * sp, f), sdTravel(Math.sin(a) * sp, f),
          3 * u, life, '#a855f7');
      }

      // 3) Dash trail — the tapered shadow streaks the demo spawned behind the
      //    fighter on (almost) every dash frame, along the path it covered.
      for (let frame = 1; frame <= SHADOW_DASH.dashFrames; frame++) {
        const age = f - frame;
        if (age < 0) continue;
        if (sdHash01c(frame * 7 + 200) < 0.2) continue;               // the demo's ~20% skip
        const life = sdFade(age, 0.05);
        if (life <= 0) continue;
        const along = -distance + distance * (frame / SHADOW_DASH.dashFrames);
        const sx = along - (15 + sdHash01c(frame * 7 + 201) * 25) * u;
        const sy = (sdHash01c(frame * 7 + 204) - 0.5) * gh;
        const vx = -(2 + sdHash01c(frame * 7 + 202) * 4) * u;
        const vy = (sdHash01c(frame * 7 + 203) - 0.5) * 2 * u;
        sdStreak(ctx, sx + sdTravel(vx, age), sy + sdTravel(vy, age), sdLive(vx, age), sdLive(vy, age),
          (4 + sdHash01c(frame * 7 + 205) * 6) * u, life,
          sdHash01c(frame * 7 + 206) > 0.5 ? '#18181b' : '#581c87');
      }

      // 4) Arrival burst — the short dark impact fan that fires backwards on the
      //    dash's final frame, now that it has cleared the fighter's body.
      const endAge = f - SHADOW_DASH.dashFrames;
      if (endAge > 0) {
        for (let i = 0; i < 10; i++) {
          const life = sdFade(endAge, 0.07);
          if (life <= 0) continue;
          const a = Math.PI + (sdHash01c(i * 5 + 301) - 0.5) * 1.2;   // backwards cone
          const sp = (2 + sdHash01c(i * 5 + 302) * 6) * u;
          const vx = Math.cos(a) * sp;
          const vy = Math.sin(a) * sp;
          sdStreak(ctx, sdTravel(vx, endAge), sdTravel(vy, endAge), sdLive(vx, endAge), sdLive(vy, endAge),
            4 * u, life, '#3b0764');
        }
      }

      ctx.restore();
    },
  },
};

// ═══════════════════════════════════════════════════════════════════════════
// Smoke bomb (converted from GA/vfx/smoke.html)
// ═══════════════════════════════════════════════════════════════════════════
export const SMOKE = {
  // Fighter body the art is proportional to: a 44px-wide body, the same
  // reference shadowdash.js uses, so the cloud and the dash trail read at the
  // same size on the same fighter.
  refBody: 44,
  // The demo's own particle counts, resolved once. A single bomb is one
  // shockwave ring, this many grey puffs and this many star sparks; the demo
  // randomised the counts by ±, and here they are simply fixed so the
  // composition is identical on every spawn.
  puffs: 18,
  sparkles: 9,
  // Total art timeline in demo frames (60fps). The slowest puffs decay at
  // 0.015/frame, so the whole cloud is essentially spent by frame ~60.
  artFrames: 60,
  // Fallbacks when the effect is placed from the animator (no params).
  defaultUnit: 1,
};

// ── deterministic stand-ins for the demo's Math.random() ──────────────────
// The game re-draws the effect from scratch every frame, so every "random"
// value has to be a function of WHO it belongs to (particle / sub-particle
// index), never of when it was drawn — otherwise the whole cloud would flicker.
// Same hash style as shadowdash.js: same index in, same [0,1) out, every machine.
function smHash01(n) {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}
// Memoized smoke hash — same reasoning as sdHash01c above: fixed index set,
// sin computed once ever per input, identical output.
const _smHashCache = new Map();
function smHash01c(n) {
  let h = _smHashCache.get(n);
  if (h === undefined) {
    h = smHash01(n);
    if (_smHashCache.size < 1024) _smHashCache.set(n, h);
  }
  return h;
}

// ── closed forms of the demo's per-frame integration ─────────────────────
const SM_TAU = Math.PI * 2;
const SM_NO_PARAMS = {};

// Puff / spark drag. smTravel(n) is the demo's `v *= drag` summed over n steps.
const PUFF_DRAG = 0.86;
const SPARK_DRAG = 0.84;
const BUOYANCY = 0.04;          // the demo's per-frame upward pull on puff vy
const PUFF_SPRING = 0.2;        // the demo's puff size spring rate
const RING_SPRING = 0.25;       // the demo's shockwave radius spring rate

const LN_PUFF_DRAG = Math.log(PUFF_DRAG);
const LN_SPARK_DRAG = Math.log(SPARK_DRAG);
const LN_PUFF_SPRING = Math.log(1 - PUFF_SPRING);
function smTravel(drag, n) {
  // exp form of pow(drag, n); picks the precomputed log for the two known
  // drag constants, falls back to Math.log for any other caller.
  const ln = drag === PUFF_DRAG ? LN_PUFF_DRAG : drag === SPARK_DRAG ? LN_SPARK_DRAG : Math.log(drag);
  return (1 - Math.exp(n * ln)) / (1 - drag);
}
function smFade(n, decay) { return 1 - decay * n; }

// Puff x at age n (no buoyancy on x — the demo only lifted y).
function puffX(x0, vx, n) { return x0 + vx * smTravel(PUFF_DRAG, n); }
// Puff y at age n: the drag integral plus the per-frame buoyancy term, which
// integrates to -B*(n - smTravel(n)) because vy is pulled after it is dragged.
function puffY(y0, vy, n) {
  const t = smTravel(PUFF_DRAG, n);
  return y0 + vy * t - BUOYANCY * (n - t);
}
// Puff radius at age n — the demo's "pop-in" spring from a 4px seed.
function puffRadius(n, target) { return 4 + (target - 4) * (1 - Math.exp(n * LN_PUFF_SPRING)); }

// The demo's toon grey smoke shades with their bold dark comic outlines.
const GREYS = [
  { fill: '#f3f4f6', stroke: '#1f2937' },  // very light silver / dark slate
  { fill: '#e5e7eb', stroke: '#111827' },  // soft cool grey / near black
  { fill: '#d1d5db', stroke: '#1f2937' },  // classic neutral grey
  { fill: '#9ca3af', stroke: '#111827' },  // medium charcoal grey
];
const SPARK_COLORS = ['#f3f4f6', '#e5e7eb', '#9ca3af', '#ffffff'];

// One grey smoke cloud: a rosette of 4–6 distinct, non-overlapping puff bubbles
// that share a centre, rotate slowly and expand as they fade.
function smokePuff(ctx, i, n, u) {
  const life = smFade(n, 0.015 + smHash01c(i * 7 + 3) * 0.015);
  if (life <= 0) return;
  const target = 22 + smHash01c(i * 7 + 4) * 28;
  const a = smHash01c(i * 7 + 1) * SM_TAU;
  const speed = 2.5 + smHash01c(i * 7 + 2) * 6.5;
  const vx = Math.cos(a) * speed;
  const vy = Math.sin(a) * speed - 1.5;      // the demo's upward drift
  const x = puffX((smHash01c(i * 7 + 9) - 0.5) * 15, vx, n);
  const y = puffY((smHash01c(i * 7 + 10) - 0.5) * 15, vy, n);
  const rot = smHash01c(i * 7 + 5) * SM_TAU + (smHash01c(i * 7 + 6) - 0.5) * 0.04 * n;
  const grey = GREYS[Math.floor(smHash01c(i * 7 + 7) * GREYS.length) % GREYS.length];

  ctx.save();
  ctx.translate(x * u, y * u);
  ctx.rotate(rot);
  ctx.globalAlpha = life;

  // The bubbles are laid out on the UNSCALED target radius and then drawn at
  // `scaleFactor` (the demo's currentRadius/targetRadius), so the pop-in grows
  // the whole cloud instead of sliding the circles around inside it.
  const scaleFactor = puffRadius(n, target) / target;
  const count = 4 + Math.floor(smHash01c(i * 7 + 8) * 3);
  ctx.fillStyle = grey.fill;
  ctx.strokeStyle = grey.stroke;
  ctx.lineWidth = 4;                            // bold cartoon comic outline
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  for (let b = 0; b < count; b++) {
    const bAngle = (b / count) * SM_TAU + (smHash01c(i * 13 + b * 3 + 20) - 0.5) * 0.2;
    const bx = Math.cos(bAngle) * target * 0.55 * scaleFactor;
    const by = Math.sin(bAngle) * target * 0.55 * scaleFactor;
    const br = target * 0.42 * scaleFactor;
    ctx.beginPath();
    ctx.arc(bx, by, br, 0, SM_TAU);
    ctx.fill();
    ctx.stroke();
  }
  ctx.restore();
}

// The expanding light-grey shockwave ring the bomb opens with.
function shockwave(ctx, n, u) {
  const life = smFade(n, 0.05);
  if (life <= 0) return;
  const max = 130 + smHash01c(1) * 40;
  const radius = (max - (max - 10) * Math.pow(1 - RING_SPRING, n)) * u;
  ctx.globalAlpha = life * 0.8;
  ctx.strokeStyle = '#d1d5db';
  ctx.lineWidth = Math.max(1, 5 * life * u);
  ctx.beginPath();
  ctx.arc(0, 0, radius, 0, SM_TAU);
  ctx.stroke();
}

// One crisp 4-point cartoon star spark, thrown outward on a drag of its own.
function sparkle(ctx, i, n, u) {
  const life = smFade(n, 0.04 + smHash01c(i * 5 + 403) * 0.03);
  if (life <= 0) return;
  const a = smHash01c(i * 5 + 401) * SM_TAU;
  const speed = 4 + smHash01c(i * 5 + 402) * 7;
  const t = smTravel(SPARK_DRAG, n);
  const x = Math.cos(a) * speed * t;
  const y = Math.sin(a) * speed * t;
  const size = (8 + smHash01c(i * 5 + 404) * 10) * u;
  const rot = smHash01c(i * 5 + 405) * Math.PI + (smHash01c(i * 5 + 406) - 0.5) * 0.2 * n;

  ctx.save();
  ctx.translate(x * u, y * u);
  ctx.rotate(rot);
  // The demo's twinkle: the star pulses as it dies.
  const scale = life * (0.8 + 0.2 * Math.sin(life * 12));
  ctx.globalAlpha = life;
  ctx.fillStyle = SPARK_COLORS[Math.floor(smHash01c(i * 5 + 407) * SPARK_COLORS.length) % SPARK_COLORS.length];
  ctx.strokeStyle = '#111827';
  ctx.lineWidth = 2.5 * u;
  ctx.beginPath();
  for (let k = 0; k < 4; k++) {
    ctx.lineTo(0, -size * scale);
    ctx.rotate(Math.PI / 4);
    ctx.lineTo(0, -size * 0.35 * scale);
    ctx.rotate(Math.PI / 4);
  }
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

// ── the effect ────────────────────────────────────────────────────────────
const SMOKE_VFX = {
  smokeBomb: {
    name: 'Smoke Bomb',
    color: '#d1d5db',
    draw(ctx, v, p) {
      // Standard VFX transform: translate → scale(scale × mirror) → rotate, so a
      // left-facing poof mirrors the whole cloud instead of firing it the wrong
      // way.
      ctx.save();
      ctx.translate(p.x, p.y);
      const s = v.scale || 1;
      const mx = v.mirrorX == null ? 1 : v.mirrorX;
      if (s !== 1 || mx !== 1) ctx.scale(s * mx, s);
      if (v.rotation) ctx.rotate((v.rotation * Math.PI) / 180);

      const P = v.params || SM_NO_PARAMS;
      // The art's own pixel sizes are in `u` units (v.scale is already applied by
      // the transform above); `unit` is the fighter-body scale from the spawner.
      const u = P.unit == null ? SMOKE.defaultUnit : P.unit;
      const f = (v.progress == null ? 0 : v.progress) * SMOKE.artFrames;

      ctx.lineCap = 'round';
      shockwave(ctx, f, u);
      for (let i = 0; i < SMOKE.puffs; i++) smokePuff(ctx, i, f, u);
      for (let i = 0; i < SMOKE.sparkles; i++) sparkle(ctx, i, f, u);

      ctx.restore();
    },
  },
};

// ═══════════════════════════════════════════════════════════════════════════
// BOXER VFX — gloves, wrap and impact. Authored in the same 44-wide body space
// as the art above, so a `params.unit` (fighter diameter / 44) fits every piece
// onto the real fighter. Same contract: pure functions of v.progress, rotation
// in degrees, v.mirrorX for the attack's direction, and every "random" value a
// deterministic hash of the particle index so a frame can be scrubbed or dropped
// and still paint the identical picture.
// ═══════════════════════════════════════════════════════════════════════════

function bxHash01(i, salt) {
  const x = Math.sin(i * 127.1 + (salt || 0) * 311.7) * 43758.5453;
  return x - Math.floor(x);
}
// Memoized boxer hash — fixed (i, salt) pairs, identical output, sin once ever.
const _bxHashCache = new Map();
function bxHash01c(i, salt) {
  const n = i * 32 + (salt || 0);
  let h = _bxHashCache.get(n);
  if (h === undefined) {
    h = bxHash01(i, salt);
    if (_bxHashCache.size < 1024) _bxHashCache.set(n, h);
  }
  return h;
}
const BX_TAU = Math.PI * 2;
const BX_NO_PARAMS = {};

// Cached unit-radius ground-glow gradient for the roll aura (per context).
// The aura draws it through a scale(R*1.3) transform, which is pixel-identical
// to a fresh gradient built at radius R*1.3 — concentric radial gradients are
// a function of relative distance.
let _boxerGlowCtx = null;
let _boxerGlowGrad = null;
function boxerGlowGradient(ctx) {
  if (_boxerGlowGrad && _boxerGlowCtx === ctx) return _boxerGlowGrad;
  _boxerGlowCtx = ctx;
  _boxerGlowGrad = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
  _boxerGlowGrad.addColorStop(0, 'rgba(255,82,82,0.55)');
  _boxerGlowGrad.addColorStop(1, 'rgba(255,82,82,0)');
  return _boxerGlowGrad;
}

const BOXER_VFX = {
  // The Deadeye Roll aura: the buff's whole visual identity. It is spawned once
  // with the roll's own lifetime and rides the fighter, so the aura is always
  // exactly as long as the buff it belongs to — it fades in fast, breathes for
  // the rest of the roll, and fades out with it. No per-frame spawning.
  boxerRollAura: {
    name: 'Roll Aura',
    color: '#ff5252',
    draw(ctx, v, p) {
      const P = v.params || BX_NO_PARAMS;
      const unit = P.unit == null ? 1 : P.unit;
      const t = v.progress;
      const fadeIn = t < 0.1 ? t / 0.1 : 1;
      const fadeOut = t > 0.85 ? Math.max(0, 1 - (t - 0.85) / 0.15) : 1;
      const alpha = fadeIn * fadeOut;
      if (alpha <= 0) return;

      // A slow breath on the radius: the buff reads as something held, not a
      // static decal.
      const breath = 0.86 + 0.14 * Math.sin(t * BX_TAU * 3);
      const R = 22 * unit * breath;

      ctx.save();
      ctx.translate(p.x, p.y);
      if (v.rotation) ctx.rotate((v.rotation * Math.PI) / 180);
      ctx.globalCompositeOperation = 'lighter';
      ctx.lineCap = 'round';

      // Two counter-rotating arcs at different radii — the guard traced twice,
      // the way a roll reads at speed.
      for (let i = 0; i < 2; i++) {
        const dir = i === 0 ? 1 : -1;
        const rr = R * (i === 0 ? 1 : 0.76);
        const spin = t * BX_TAU * 1.5 * dir;
        const sweep = 2.1;
        ctx.lineWidth = (i === 0 ? 3.4 : 2.4) * unit;
        ctx.strokeStyle = i === 0 ? 'rgba(255,82,82,0.9)' : 'rgba(255,255,255,0.75)';
        ctx.globalAlpha = alpha * (i === 0 ? 0.9 : 0.6);
        ctx.beginPath();
        ctx.arc(0, 0, rr, spin, spin + sweep);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(0, 0, rr, spin + Math.PI, spin + Math.PI + sweep * 0.6);
        ctx.stroke();
      }

      // Rising motes. Each climbs its own offset track and fades in and out of
      // its own life, so the ring always has something travelling along it.
      for (let i = 0; i < 8; i++) {
        const h1 = bxHash01c(i, 1);
        const h2 = bxHash01c(i, 2);
        const ph = (t * (0.6 + h2 * 0.8) + h1) % 1;
        const a = h1 * BX_TAU;
        const rad = R * (0.55 + 0.5 * h2);
        const mx = Math.cos(a) * rad;
        const my = Math.sin(a) * rad - ph * 26 * unit;
        const fade = Math.sin(ph * Math.PI);
        ctx.globalAlpha = alpha * fade * 0.8;
        ctx.fillStyle = i % 2 === 0 ? '#ff8a65' : '#ffe0b2';
        ctx.beginPath();
        ctx.arc(mx, my, (1.4 + h1 * 1.6) * unit * (0.5 + fade * 0.5), 0, BX_TAU);
        ctx.fill();
      }

      // Ground glow under the stance: a speed buff has to be visible in the
      // feet, not only in the halo. The unit-radius gradient is cached per
      // context and drawn through a scale, so no gradient object is built per
      // frame (same technique as the projectile orb in Effects.js).
      ctx.globalAlpha = alpha * 0.5;
      ctx.save();
      ctx.scale(R * 1.3, R * 1.3);
      ctx.fillStyle = boxerGlowGradient(ctx);
      ctx.beginPath();
      ctx.ellipse(0, (R * 0.85) / (R * 1.3), 1.25 / 1.3, (R * 0.4) / (R * 1.3), 0, 0, BX_TAU);
      ctx.fill();
      ctx.restore();

      ctx.restore();
    },
  },

  // The Grab's punch-away: the one place the boxer is allowed to bloom. The
  // shockwave opens fast and the streaks fire outward, so the frame that shows
  // the hit is the frame that reads hardest.
  boxerPunchImpact: {
    name: 'Punch Impact',
    color: '#ff5252',
    draw(ctx, v, p) {
      const P = v.params || BX_NO_PARAMS;
      const unit = P.unit == null ? 1 : P.unit;
      const t = v.progress;
      const mx = v.mirrorX == null ? 1 : v.mirrorX;
      const s = (v.scale || 1) * unit;
      const fade = Math.max(0, 1 - t);

      ctx.save();
      ctx.translate(p.x, p.y);
      if (s !== 1 || mx !== 1) ctx.scale(s * mx, s);
      ctx.globalCompositeOperation = 'lighter';

      // Shockwave: one hard ring that snaps open and thins as it dies.
      const r = 6 + 52 * (1 - (1 - t) * (1 - t));
      ctx.globalAlpha = fade * 0.9;
      ctx.lineWidth = 7 * (1 - t) + 1;
      ctx.strokeStyle = '#ff5252';
      ctx.beginPath();
      ctx.arc(0, 0, r, 0, BX_TAU);
      ctx.stroke();
      ctx.globalAlpha = fade * 0.55;
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = '#fff3e0';
      ctx.beginPath();
      ctx.arc(0, 0, r * 0.66, 0, BX_TAU);
      ctx.stroke();

      // Knuckle streaks, one per ray, deterministic.
      ctx.lineCap = 'round';
      for (let i = 0; i < 9; i++) {
        const h = bxHash01c(i, 7);
        const a = (i / 9) * BX_TAU + h * 0.3;
        const len = (16 + h * 30) * (0.35 + t * 1.15);
        ctx.globalAlpha = fade * (0.35 + h * 0.4);
        ctx.lineWidth = 2 + h * 2.4;
        ctx.strokeStyle = i % 3 === 0 ? '#ffffff' : '#ff8a65';
        ctx.beginPath();
        ctx.moveTo(Math.cos(a) * 6, Math.sin(a) * 6);
        ctx.lineTo(Math.cos(a) * len, Math.sin(a) * len);
        ctx.stroke();
      }

      // White core, gone by a third of the way in.
      const cf = Math.max(0, 1 - t * 3);
      if (cf > 0) {
        ctx.globalAlpha = cf;
        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        ctx.arc(0, 0, 13 * cf + 4, 0, BX_TAU);
        ctx.fill();
      }

      ctx.restore();
    },
  },

  // The Straight Right: deliberately the quietest piece of art in the file. No
  // ring, no burst, no motes — just the line of the arm going out, reaching and
  // thinning. "Subtle" is the whole point of the move's feedback.
  boxerStraightPunch: {
    name: 'Straight Punch',
    color: '#ffd6c2',
    draw(ctx, v, p) {
      const P = v.params || BX_NO_PARAMS;
      const unit = P.unit == null ? 1 : P.unit;
      const t = v.progress;
      const mx = v.mirrorX == null ? 1 : v.mirrorX;
      const s = (v.scale || 1) * unit;
      const fade = Math.max(0, 1 - t);

      ctx.save();
      ctx.translate(p.x, p.y);
      if (s !== 1 || mx !== 1) ctx.scale(s * mx, s);
      ctx.globalCompositeOperation = 'lighter';
      ctx.lineCap = 'round';

      const reach = 10 + 74 * (1 - (1 - t) * (1 - t));
      for (let i = 0; i < 3; i++) {
        const off = (i - 1) * 5.5;
        const w = (4.2 - i * 1.1) * Math.max(0, 1 - t * 0.8);
        ctx.globalAlpha = fade * 0.8 * (i === 1 ? 1 : 0.45);
        ctx.lineWidth = Math.max(0.5, w);
        ctx.strokeStyle = i === 1 ? '#ffffff' : '#ffab91';
        ctx.beginPath();
        ctx.moveTo(4, off);
        ctx.lineTo(reach, off * 0.25);
        ctx.stroke();
      }

      // A faint cap so the reach has a tip without blooming into a flash.
      const cf = Math.max(0, 1 - t);
      ctx.globalAlpha = fade * 0.5;
      ctx.fillStyle = '#ffe0b2';
      ctx.beginPath();
      ctx.ellipse(reach, 0, 7 * cf, 3.2 * cf, 0, 0, BX_TAU);
      ctx.fill();

      ctx.restore();
    },
  },
};

export { COWBOY_AL_VFX, SHADOW_DASH_VFX, SMOKE_VFX, BOXER_VFX };

// The single effect registry src/effects/vfx.js re-exports as VFX_EFFECTS.
export const VFX_EFFECTS = {
  ...COWBOY_AL_VFX,
  ...SHADOW_DASH_VFX,
  ...SMOKE_VFX,
  ...BOXER_VFX,
};
