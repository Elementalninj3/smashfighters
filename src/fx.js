import { spawnTempVfx } from './physics.js';


// ── merged from effects/art.js ──
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
// picker and fx.js read, and only a move bound to a Cowboy/Ninja ability is
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
//   • BOXER_VFX       — the boxer's Depsey Roll aura, the Grab's punch-away
//                      impact, and the Straight Right's reach streak
//
// They are merged into one module because they share this contract and the same
// single consumer (fx.js); their helpers are name-prefixed per art so the
// three sets can never shadow each other.


// ── Shared easing + static seed tables (module scope) ────────────────────
// These were closures/array literals rebuilt inside every draw() call, plus
// per-draw forEach closures. Hoisted here: identical math, zero per-frame
// allocation. easeOutExpo uses a multiply chain instead of Math.pow.
function artEaseOutExpo(t) { return t >= 1 ? 1 : 1 - Math.pow(2, -10 * t); }
function artEaseOutQuad(t) { return t * (2 - t); }
// Deterministic per-index pseudo-random in [0, 1): the spinningsweep demo
// rolls blade parameters once at spawn, but a pooled effect instance carries
// no spawn state — hashing the index reproduces a fixed "roll" so the sweep
// draws identically every replay with zero per-frame allocation.
function knightPrand(i, salt) {
  const x = Math.sin(i * 127.1 + salt * 311.7) * 43758.5453;
  return x - Math.floor(x);
}
// Static blade table for the sweep: the per-blade "rolls" never change, so
// they hash once on first use instead of re-running six sin-based hashes per
// blade per frame (156 sins/frame saved while the sweep is live).
const _SWEEP_BLADES = [];
const _SWEEP_PAL = [['#0a5cff', '#4aa8ff'], ['#1f8cff', '#8fdcff'], ['#5cc8ff', '#e2f8ff']];
function sweepBlades() {
  if (_SWEEP_BLADES.length) return _SWEEP_BLADES;
  for (let i = 0; i < 26; i++) {
    const bl = i >= 18;
    const k = 0.05 + 0.95 * knightPrand(i, 1);
    _SWEEP_BLADES.push({
      bl, k,
      ph0: knightPrand(i, 2) * 6.283,
      sp: (5 + 4 * knightPrand(i, 3)) * (1.5 - k * 0.7),
      span: (0.8 + 1.1 * knightPrand(i, 4)) * (bl ? 0.8 : 1),
      w: (bl ? 0.1 + 0.08 * knightPrand(i, 5) : 0.3 + 0.45 * knightPrand(i, 5)) * (1.2 - k * 0.45),
      ci: i % 3,
      kr: bl ? 0.9 + 0.6 * knightPrand(i, 6) : 0,
    });
  }
  return _SWEEP_BLADES;
}
// Cached rgba() strings for the shuriken blade fill, alpha quantized to 17
// steps over [0, 1] so the endpoints (fully opaque at spawn, fully faded out)
// are both exactly representable. Building these inline per blade per frame
// allocated a string and forced a CSS colour re-parse on every draw.
const _SHURIKEN_STEPS = 16;
const _rgbaBlue = new Array(_SHURIKEN_STEPS + 1);
for (let i = 0; i <= _SHURIKEN_STEPS; i++) _rgbaBlue[i] = `rgba(52, 152, 219, ${(i / _SHURIKEN_STEPS).toFixed(3)})`;
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

      // Central Toon Starburst (first third).
      if (prog < 0.3) {
        const flashAlpha = 1 - prog / 0.3;
        const flashRadius = (1 - artEaseOutExpo(prog / 0.3)) * 22 + 4;
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
      const sparkDist = artEaseOutExpo(Math.min(1, prog * 1.5));
      for (let i = 0; i < sparkCount; i++) {
        const seed = i * 37;
        const angle = (seed % 360) * Math.PI / 180;
        const speed = 80 + (seed % 5) * 15;
        const dist = sparkDist * speed;
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
      const eased = artEaseOutQuad(prog);

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

      // Quick flash
      if (prog < 0.4) {
        const flashAlpha = 1 - prog / 0.4;
        const flashRadius = (1 - artEaseOutExpo(prog / 0.4)) * 15 + 5;
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
      // Quantized alpha: the old inline template built (and the CSS parser
      // re-parsed) a brand-new rgba() string for each of the 4 blades on every
      // frame of the effect's life. 17 cached strings cover the whole fade.
      let sh = Math.round((1 - prog) * _SHURIKEN_STEPS);
      if (sh < 0) sh = 0; else if (sh > _SHURIKEN_STEPS) sh = _SHURIKEN_STEPS;
      const shurikenFill = _rgbaBlue[sh];
      const bladeDist = artEaseOutExpo(Math.min(1, prog * 2)) * 20;
      for (let i = 0; i < 4; i++) {
        const angle = i * Math.PI / 2;
        const dist = bladeDist;
        const x = Math.cos(angle) * dist;
        const y = Math.sin(angle) * dist;
        ctx.fillStyle = shurikenFill;
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

// ── Smoke-bomb sprite baking ────────────────────────────────────────────
//
// Pre-rasterize every bakeable art piece so the first use of an effect is
// already a plain blit. Called at the ready -> playing transition; see
// Game.js `_warmRenderCaches`. Each bake is a one-shot few-hundred-microsecond
// rasterization, which is invisible during a menu but is a visible hitch if it
// lands on the frame a player first throws a smoke bomb.
export function warmArtSprites() {
  for (const group of [VFX_EFFECTS, COWBOY_AL_VFX, SMOKE_VFX, SHADOW_DASH_VFX, BOXER_VFX]) {
    if (!group || typeof group !== 'object') continue;
    for (const eff of Object.values(group)) {
      if (!eff) continue;
      // The art modules keep their procedural art in module-local functions; the
      // public surface to warm is the smoke bomb's particle sprites, which are
      // the expensive ones (18 puffs + 9 sparks, each with stroked outlines).
      if (eff === SMOKE_VFX.smokeBomb) _warmSmokeSprites();
    }
  }
}

function _warmSmokeSprites() {
  // Drive one synthetic frame through the real draw path; it bakes every puff
  // and sparkle sprite as a side effect, with no risk of baking a partial set.
  try {
    const c = document.createElement('canvas');
    c.width = c.height = 8;
    const m = c.getContext('2d');
    const v = { progress: 0.5, scale: 1, mirrorX: 1, rotation: 0, params: { unit: 1 } };
    SMOKE_VFX.smokeBomb.draw(m, v, { x: 0, y: 0 });
  } catch (_) {}
}
//
// The smoke bomb was the single most expensive effect in the game: 18 puffs x
// 4-6 bubbles, each bubble a fresh arc + fill + a THICK stroke, plus 9 star
// sparkles of their own — roughly 400 canvas operations and ~80 stroke
// tessellations for ONE effect, every frame it was on screen. Stroke
// tessellation is several times the cost of a fill.
//
// But every one of those shapes is STATIC: the bubble layout, the colours and
// the star geometry are all deterministic functions of the particle index, and
// only three things vary per frame — overall alpha, the pop-in growth scale and
// the translate. So each puff's rosette and each sparkle's star are rasterized
// once into a small sprite and blitted thereafter.
//
// The bake uses scale 1 and the artwork's own line widths, and the blit
// re-applies exactly the transform the vector pass had (alpha, growth scale,
// rotate, translate), so the outlines land at the same thickness.
// The bake scales below are art-px per sprite-px, and they are sized to roughly
// the art's on-screen footprint rather than arbitrarily large. A downscaling
// blit still samples the ENTIRE source, so an oversized sprite costs far more
// than it saves — the win here is dropping ~80 stroke tessellations, not
// trading them for a bigger resample.
const SMOKE_BAKE_HALF = 54;    // covers the widest bubble rosette + its outline
const SMOKE_BAKE_SCALE = 1.1;  // a puff displays at ~2x its target radius
const SPARK_BAKE_HALF = 22;
const SPARK_BAKE_SCALE = 1.6;

function _bakeArtSprite(half, scale, drawFn) {
  const px = Math.ceil(half * 2 * scale);
  const c = document.createElement('canvas');
  c.width = px;
  c.height = px;
  const m = c.getContext('2d');
  m.translate(px / 2, px / 2);
  m.scale(scale, scale);
  drawFn(m);
  return c;
}

const _puffSprites = new Array(SMOKE.puffs);
for (let i = 0; i < SMOKE.puffs; i++) _puffSprites[i] = null;
const _sparkSprites = new Array(SMOKE.sparkles);
for (let i = 0; i < SMOKE.sparkles; i++) _sparkSprites[i] = null;

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

  // The bubbles are laid out on the UNSCALED target radius and then drawn at
  // `scaleFactor` (the demo's currentRadius/targetRadius), so the pop-in grows
  // the whole cloud instead of sliding the circles around inside it.
  const scaleFactor = puffRadius(n, target) / target;

  ctx.save();
  ctx.translate(x * u, y * u);
  ctx.rotate(rot);
  ctx.globalAlpha = life;
  ctx.scale(scaleFactor, scaleFactor);

  let spr = _puffSprites[i];
  if (spr === null) {
    spr = _bakeArtSprite(SMOKE_BAKE_HALF, SMOKE_BAKE_SCALE, (m) => {
      m.fillStyle = grey.fill;
      m.strokeStyle = grey.stroke;
      m.lineWidth = 4;                          // bold cartoon comic outline
      m.lineJoin = 'round';
      m.lineCap = 'round';
      const count = 4 + Math.floor(smHash01c(i * 7 + 8) * 3);
      for (let b = 0; b < count; b++) {
        const bAngle = (b / count) * SM_TAU + (smHash01c(i * 13 + b * 3 + 20) - 0.5) * 0.2;
        const bx = Math.cos(bAngle) * target * 0.55;
        const by = Math.sin(bAngle) * target * 0.55;
        const br = target * 0.42;
        m.beginPath();
        m.arc(bx, by, br, 0, SM_TAU);
        m.fill();
        m.stroke();
      }
    });
    _puffSprites[i] = spr;
  }
  const H = SMOKE_BAKE_HALF;
  ctx.drawImage(spr, -H, -H, H * 2, H * 2);
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
  const baseSize = 8 + smHash01c(i * 5 + 404) * 10;
  const rot = smHash01c(i * 5 + 405) * Math.PI + (smHash01c(i * 5 + 406) - 0.5) * 0.2 * n;

  ctx.save();
  ctx.translate(x * u, y * u);
  ctx.rotate(rot);
  // The demo's twinkle: the star pulses as it dies.
  const scale = life * (0.8 + 0.2 * Math.sin(life * 12));
  ctx.globalAlpha = life;
  // Baked at u = 1; the u scale below reproduces both the original's `size * u`
  // and its `lineWidth * u` exactly.
  ctx.scale(u, u);

  let spr = _sparkSprites[i];
  if (spr === null) {
    const col = SPARK_COLORS[Math.floor(smHash01c(i * 5 + 407) * SPARK_COLORS.length) % SPARK_COLORS.length];
    spr = _bakeArtSprite(SPARK_BAKE_HALF, SPARK_BAKE_SCALE, (m) => {
      m.fillStyle = col;
      m.strokeStyle = '#111827';
      m.lineWidth = 2.5;
      m.beginPath();
      for (let k = 0; k < 4; k++) {
        m.lineTo(0, -baseSize);
        m.rotate(Math.PI / 4);
        m.lineTo(0, -baseSize * 0.35);
        m.rotate(Math.PI / 4);
      }
      m.closePath();
      m.fill();
      m.stroke();
    });
    _sparkSprites[i] = spr;
  }
  ctx.scale(scale, scale);
  const H = SPARK_BAKE_HALF;
  ctx.drawImage(spr, -H, -H, H * 2, H * 2);
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
  // The Depsey Roll aura: the buff's whole visual identity. It is spawned once
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

// ── Knight sword-trail ─────────────────────────────────────────────────
// A clean crescent arc in steel-blue and white with a hair of gold — the same
// shape language as the shared `slash` above, palette-matched to the knight's
// armor. Anchored to the weapon by the spawner (combat.js knightSwingTrail),
// mirrored with facing, scaled up for the Spinning Sweep. One stroked arc in
// three passes: deliberately faint so the swing reads, never the effect.
//
// Crescent layers + ribbon painter for the blue slash below (the demo's
// LAYERS table and crescent(), game-sized, module scope so no per-frame
// allocation).
const _BLUE_SLASH_LAYERS = [
  { R: 96, W: 30, d: 0 },
  { R: 82, W: 15, d: 0.015 },
  { R: 110, W: 12, d: 0.03 },
  { R: 102, W: 5, d: 0.045 },
  { R: 88, W: 6, d: 0.06 },
];
function _blueSlashCrescent(ctx, R, Wd, a0, a1, alpha) {
  if (a1 - a0 < 0.02 || alpha <= 0) return;
  const N = 30;
  ctx.beginPath();
  for (let i = 0; i <= N; i++) {
    const u = i / N, a = a0 + (a1 - a0) * u;
    const w = Wd * Math.pow(Math.sin(Math.PI * u), 0.7) * 0.5;
    const px = (R + w) * Math.cos(a), py = (R + w) * Math.sin(a);
    if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
  }
  for (let i = N; i >= 0; i--) {
    const u = i / N, a = a0 + (a1 - a0) * u;
    const w = Wd * Math.pow(Math.sin(Math.PI * u), 0.7) * 0.5;
    ctx.lineTo((R - w) * Math.cos(a), (R - w) * Math.sin(a));
  }
  ctx.closePath();
  const aq = alpha > 1 ? 1 : alpha;
  const g = ctx.createRadialGradient(0, 0, Math.max(0, R - Wd / 2), 0, 0, R + Wd / 2);
  g.addColorStop(0, 'rgba(0,110,255,0)');
  g.addColorStop(0.3, 'rgba(40,150,255,' + (0.85 * aq).toFixed(3) + ')');
  g.addColorStop(0.58, 'rgba(200,235,255,' + aq.toFixed(3) + ')');
  g.addColorStop(1, 'rgba(0,100,255,0)');
  ctx.fillStyle = g;
  ctx.fill();
  // Crisp rim light around the ribbon (additive, so it reads on any
  // background): retraces the closed ribbon path at the pass's own alpha.
  if (aq > 0.01) {
    ctx.globalAlpha = aq;
    ctx.strokeStyle = '#e6f5ff';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.globalAlpha = 1;
  }
}
// ═══════════════════════════════════════════════════════════════════════════
// PIRATE EFFECTS  (GA/vfx/ rope swing · cutlass lunge · anchor drop · cannon blast)
// ═══════════════════════════════════════════════════════════════════════════
// Converted from the four pirate demos in GA/vfx, the same way every other
// character set in this file was: the demo's standalone character, camera and
// background are gone, and what remains is the effect itself, re-timed onto the
// move's own frame clock and scaled to the game's world units. All procedural
// and all draw-only — none of these owns a hitbox, damage or collision.
//
//   pirateRope          — Rope Swing (GA/vfx/Rope swing.html). The thrown
//                        grapple: a taut rope to a hook head at its far end,
//                        with the demo's three-layer warm comet wake streaming
//                        off the swinging body. Anchored to the front hand, so
//                        it rides the dash exactly as the demo's trail rode
//                        the ball.
//   pirateCutlassSlash  — Cutlass Lunge (GA/vfx/Cutlasslunge.html). The
//                        world-anchored crescent that sweeps in along the
//                        lunge's path — pinned at the spot the lunge started,
//                        so it stays in the world while the body moves through
//                        it, which is what the demo's "world-anchored, sweeps
//                        in as the ball launches" comment describes.
//   pirateAnchorSlam    — Anchor Drop (GA/vfx/Anchor drop.html). The ground
//                        eruption: gold light pillars, radial cracks, an
//                        expanding shock ring, tumbling rock and rising embers.
//   pirateCannonTrail   — Cannon Blast (GA/vfx/cannon blast.html). The round
//                        itself: a dark iron ball with the demo's rim sheen
//                        inside its three-layer flame wake. Rides the bullet.
//   pirateCannonImpact  — the same demo's detonation: core flash, dome
//                        shockwave, ground ring and debris spikes, spawned
//                        wherever the round actually resolved.
//   pirateBroadside     — the wide close-range cone on the Broadside Burst.
//   pirateHitBurst      — the shared connect burst every pirate melee move
//                        lands through (one effect, not one per move), so a
//                        rope, a cutlass and an anchor all burst the same way.

// ── Pirate helpers ───────────────────────────────────────────────────────
// Deterministic per-index pseudo-random, memoized on the same (i, salt)
// pattern the boxer set uses. Nothing in a pirate effect may roll a fresh
// number between frames or the animator's scrub would repaint a different
// picture every pass; hashing the index reproduces a fixed "roll" instead.
function pirateHash01(i, salt) {
  const x = Math.sin(i * 91.7 + (salt || 0) * 47.3) * 43758.5453;
  return x - Math.floor(x);
}
const _pirateHashCache = new Map();
function pirateHash01c(i, salt) {
  const n = i * 32 + (salt || 0);
  let h = _pirateHashCache.get(n);
  if (h === undefined) {
    h = pirateHash01(i, salt);
    if (_pirateHashCache.size < 1024) _pirateHashCache.set(n, h);
  }
  return h;
}
const PIRATE_TAU = Math.PI * 2;
const PIRATE_NO_PARAMS = {};

// Alpha quantized to 17 steps over [0, 1]: the fill loops below run per
// fragment per frame, and a template-literal rgba() there would allocate a
// string and force a CSS colour re-parse every single one. Both endpoints
// (fully opaque, fully faded) are exactly representable on the ramp.
const _PR_A_STEPS = 16;
function pirateRamp(rgb) {
  const r = new Array(_PR_A_STEPS + 1);
  for (let i = 0; i <= _PR_A_STEPS; i++) {
    r[i] = 'rgba(' + rgb + ',' + (i / _PR_A_STEPS).toFixed(3) + ')';
  }
  return r;
}
const _prFlameOut = pirateRamp('255,90,10');
const _prFlameMid = pirateRamp('255,200,80');
const _prFlameCore = pirateRamp('255,255,230');
const _prGold = pirateRamp('255,190,80');
const _prGoldHot = pirateRamp('255,235,170');
const _prSteel = pirateRamp('160,220,255');
const _prCyan = pirateRamp('110,200,255');
const _prShield = pirateRamp('150,215,255');
const _prRock = pirateRamp('90,71,51');
// Alpha -> ramp index, clamped at both ends.
function prA(a) {
  if (a <= 0) return 0;
  if (a >= 1) return _PR_A_STEPS;
  return (a * _PR_A_STEPS) | 0;
}

// Cached unit-radius glow gradients, one per context (the boxer aura's
// precedent). Drawn through a scale(R, R) transform, which is pixel-identical
// to a fresh gradient built at radius R: a concentric radial gradient's colour
// is a function of RELATIVE distance. Building one per frame per effect would
// cost three addColorStop parses plus an allocation on every live frame.
let _prGoldCtx = null;
let _prGoldGrad = null;
function pirateGoldGlow(ctx) {
  if (_prGoldGrad && _prGoldCtx === ctx) return _prGoldGrad;
  _prGoldCtx = ctx;
  _prGoldGrad = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
  _prGoldGrad.addColorStop(0, 'rgba(255,205,120,0.55)');
  _prGoldGrad.addColorStop(1, 'rgba(255,170,40,0)');
  return _prGoldGrad;
}
let _prFlameCtx = null;
let _prFlameGrad = null;
function pirateFlameGlow(ctx) {
  if (_prFlameGrad && _prFlameCtx === ctx) return _prFlameGrad;
  _prFlameCtx = ctx;
  _prFlameGrad = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
  _prFlameGrad.addColorStop(0, 'rgba(255,170,60,0.42)');
  _prFlameGrad.addColorStop(1, 'rgba(255,90,10,0)');
  return _prFlameGrad;
}

// A tapered ribbon along a quadratic bezier from parameter u0 to u1 — the
// shape the demo's `swoosh` (cutlass) is built from. The half-width swells and
// pinches at the ends so the stroke has a drawn start and a drawn tip instead
// of two flat cuts.
function pirateRibbon(ctx, x0, y0, cx, cy, x1, y1, u0, u1, w, style) {
  if (u1 - u0 <= 0.001) return;
  const N = 10;
  ctx.beginPath();
  for (let i = 0; i <= N; i++) {
    const u = u0 + (u1 - u0) * (i / N);
    const iv = 1 - u;
    const h = w * Math.sin(Math.PI * (0.08 + 0.84 * u));
    const x = iv * iv * x0 + 2 * iv * u * cx + u * u * x1;
    const y = iv * iv * y0 + 2 * iv * u * cy + u * u * y1;
    if (i) ctx.lineTo(x, y - h); else ctx.moveTo(x, y - h);
  }
  for (let i = N; i >= 0; i--) {
    const u = u0 + (u1 - u0) * (i / N);
    const iv = 1 - u;
    const h = w * Math.sin(Math.PI * (0.08 + 0.84 * u));
    ctx.lineTo(iv * iv * x0 + 2 * iv * u * cx + u * u * x1,
      iv * iv * y0 + 2 * iv * u * cy + u * u * y1 + h);
  }
  ctx.closePath();
  ctx.fillStyle = style;
  ctx.fill();
}

// The demo's three-layer comet wake, streaming BACKWARD along local -x (the
// effect's own transform already points +x down the direction of travel or
// down the captured facing, so -x is always "behind"). The wobble is driven by
// the caller's clock rather than a fresh random, so a scrubbed frame paints
// identically every pass.
const _PI_WAKE = [
  { k: 1.00, w: 1.00 },
  { k: 0.66, w: 0.56 },
  { k: 0.34, w: 0.24 },
];
function pirateWake(ctx, len, wid, clock, ramp) {
  const N = 9;
  for (let li = 0; li < _PI_WAKE.length; li++) {
    const L = _PI_WAKE[li];
    ctx.beginPath();
    ctx.moveTo(0, -wid * L.w);
    for (let i = 1; i <= N; i++) {
      const u = i / N;
      const wob = Math.sin(u * 6.5 + clock * 9 + li * 2.1) * wid * L.w * 0.3 * u;
      ctx.lineTo(-len * L.k * u, -wid * L.w * (1 - u * 0.7) + wob);
    }
    for (let i = N; i >= 1; i--) {
      const u = i / N;
      const wob = Math.sin(u * 6.5 + clock * 9 + li * 2.1 + 1.6) * wid * L.w * 0.3 * u;
      ctx.lineTo(-len * L.k * u, wid * L.w * (1 - u * 0.7) + wob);
    }
    ctx.closePath();
    ctx.fillStyle = ramp[li];
    ctx.fill();
  }
}

// The three slash layers, widest/softest first. `lag` is how far behind the
// head each layer's tail trails, in arc parameter — the gap between them is
// what gives the stroke its white leading edge over a blue body.
const _PI_SLASH_LAYERS = [
  { w: 0.19, lag: 0.86, a: 0.26, ramp: _prSteel },
  { w: 0.105, lag: 0.66, a: 0.72, ramp: _prSteel },
  { w: 0.038, lag: 0.46, a: 1.0, ramp: _prShield },
];
// Static index tables for the loops below. Only `.length` and `i` are ever
// read, so a plain filled array is the whole requirement — building these as
// literals at each use site was the old cost.
function pirateCount(n) {
  const a = new Array(n);
  for (let i = 0; i < n; i++) a[i] = i;
  return a;
}
const _PI_PILLARS = pirateCount(9);
const _PI_ROCKS = pirateCount(9);
const _PI_EMBERS = pirateCount(14);
const _PI_SPIKES = pirateCount(20);
const _PI_BURST_RAYS = pirateCount(11);
const _PI_CRACKS = pirateCount(9);
const _PI_CRACK_NODES = 7;
const _PI_BURST_CRESCENTS = [
  { ox: 8, r: 30, w: 5, a: 0.7 },
  { ox: 4, r: 21, w: 3, a: 0.85 },
  { ox: 0, r: 13, w: 1.8, a: 1 },
];

const PIRATE_VFX = {
  // ── Rope Swing ──────────────────────────────────────────────────────────
  // The thrown grapple. Anchored to the front hand, so the rope, the hook and
  // the wake all travel with the swing — the demo's rope, hook and trail all
  // moved with its ball, and this is the same relationship to a different
  // body. Drawn forward (+x) so it points down the captured facing under the
  // caller's mirrorX.
  pirateRope: {
    name: 'Pirate Rope',
    color: '#c9b489',
    draw(ctx, v, p) {
      ctx.save();
      ctx.translate(p.x, p.y);
      const s = v.scale || 1;
      const mx = v.mirrorX == null ? 1 : v.mirrorX;
      if (s !== 1 || mx !== 1) ctx.scale(s * mx, s);
      if (v.rotation) ctx.rotate((v.rotation * Math.PI) / 180);
      const prog = v.progress;
      const P = v.params || PIRATE_NO_PARAMS;
      const len = (P.length || 78) * (0.35 + 0.65 * Math.min(1, prog * 2.2));
      // Wake first and underneath: the rope and the hook are the hard read,
      // the comet stream is the motion behind them.
      ctx.globalCompositeOperation = 'lighter';
      pirateWake(ctx, len * 1.5, 9 + 12 * Math.min(1, prog * 2), prog * 6, _prFlameMid);
      ctx.globalCompositeOperation = 'source-over';
      // Rope: dark under-stroke, fibre highlight, then the hook head.
      ctx.lineCap = 'round';
      ctx.strokeStyle = '#4a3f2c';
      ctx.lineWidth = 3.4;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.quadraticCurveTo(len * 0.5, 7 * (1 - prog), len, 0);
      ctx.stroke();
      ctx.strokeStyle = '#c9b489';
      ctx.lineWidth = 1.6;
      ctx.stroke();
      ctx.strokeStyle = '#2f2a22';
      ctx.lineWidth = 3.2;
      ctx.beginPath();
      ctx.arc(len, 0, 5.6, -1.9, 1.5);
      ctx.stroke();
      ctx.strokeStyle = '#d8dde6';
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.restore();
    },
  },

  // ── Cutlass Lunge ───────────────────────────────────────────────────────
  // The lunge's crescent. PINNED at the world point the lunge started from
  // (spawnTempVfx's pinnedX/pinnedY), so as the body moves along the path the
  // blade arc stays behind in the world and the fighter visibly passes through
  // it. The head runs ahead of the tail by a fixed arc length, which is what
  // makes it read as a blade travelling rather than a shape being scaled up.
  pirateCutlassSlash: {
    name: 'Cutlass Slash',
    color: '#9fd8ff',
    draw(ctx, v, p) {
      ctx.save();
      ctx.translate(p.x, p.y);
      const s = v.scale || 1;
      const mx = v.mirrorX == null ? 1 : v.mirrorX;
      if (s !== 1 || mx !== 1) ctx.scale(s * mx, s);
      if (v.rotation) ctx.rotate((v.rotation * Math.PI) / 180);
      const prog = v.progress;
      if (prog >= 1) return;
      const P = v.params || PIRATE_NO_PARAMS;
      const unit = P.unit == null ? 1 : P.unit;
      const reach = (P.reach || 96) * unit;
      // Head races out over the first third, then the whole arc holds its
      // shape while it fades.
      const head = artEaseOutExpo(Math.min(1, prog / 0.34));
      const alpha = prog < 0.34 ? 1 : Math.max(0, 1 - (prog - 0.34) / 0.66);
      if (alpha <= 0.004) return;
      // The demo's blade path: up out of the ground behind, through a low
      // control point, up and forward past the tip.
      const x0 = -reach * 0.16, y0 = reach * 0.30;
      const cx = reach * 0.42, cy = reach * 0.34;
      const x1 = reach * 0.82, y1 = -reach * 0.14;
      ctx.globalCompositeOperation = 'lighter';
      for (let li = 0; li < _PI_SLASH_LAYERS.length; li++) {
        const L = _PI_SLASH_LAYERS[li];
        // Each layer's tail lags its head, so the three read as one stroke
        // with a hot leading edge and a soft trailing one.
        const tail = Math.max(0, head - L.lag);
        pirateRibbon(ctx, x0, y0, cx, cy, x1, y1, tail, head,
          reach * L.w, L.ramp[prA(alpha * L.a)]);
      }
      // Bloom at the leading tip, while the head is still travelling.
      if (prog < 0.5) {
        const g = (1 - prog * 2) * 0.5;
        if (g > 0.01) {
          const iv = 1 - head;
          const hx = iv * iv * x0 + 2 * iv * head * cx + head * head * x1;
          const hy = iv * iv * y0 + 2 * iv * head * cy + head * head * y1;
          const R = reach * 0.3 * g;
          ctx.save();
          ctx.globalAlpha = g;
          ctx.translate(hx, hy);
          ctx.scale(R, R);
          ctx.fillStyle = _prCyan[_PR_A_STEPS];
          ctx.beginPath();
          ctx.arc(0, 0, 1, 0, PIRATE_TAU);
          ctx.fill();
          ctx.restore();
        }
      }
      ctx.restore();
    },
  },

  // ── Anchor Drop ─────────────────────────────────────────────────────────
  // The ground eruption. Gold light pillars and radial cracks are the demo's
  // signature, so they lead; the shock ring, tumbling rock and rising embers
  // fill in behind them.
  pirateAnchorSlam: {
    name: 'Pirate Anchor Slam',
    color: '#ffbe50',
    draw(ctx, v, p) {
      ctx.save();
      ctx.translate(p.x, p.y);
      const s = v.scale || 1;
      const mx = v.mirrorX == null ? 1 : v.mirrorX;
      if (s !== 1 || mx !== 1) ctx.scale(s * mx, s);
      if (v.rotation) ctx.rotate((v.rotation * Math.PI) / 180);
      const prog = v.progress;
      if (prog >= 1) return;
      const P = v.params || PIRATE_NO_PARAMS;
      const U = P.unit == null ? 1 : P.unit;
      // Crack reach runs out first, the ring just behind it, everything else
      // rides the whole life.
      const reachE = artEaseOutExpo(Math.min(1, prog / 0.22));
      const ringE = artEaseOutExpo(Math.min(1, prog / 0.4));
      const fade = Math.max(0, 1 - prog);

      // Gold light pillars, rising off the floor.
      ctx.globalCompositeOperation = 'lighter';
      const pf = Math.max(0, 1 - Math.max(0, prog - 0.1) / 0.9);
      if (pf > 0.01) {
        for (let i = 0; i < _PI_PILLARS.length; i++) {
          const h1 = pirateHash01c(i, 3);
          const h2 = pirateHash01c(i, 4);
          const x = (i - 4) * 9 * U + (h1 - 0.5) * 5 * U;
          const w = (5 + h2 * 6) * U;
          const h = (60 + h1 * 70) * U * artEaseOutExpo(Math.min(1, prog / 0.16));
          ctx.globalAlpha = pf * (0.32 + h2 * 0.26);
          ctx.fillStyle = _prGold[prA(0.55 + h1 * 0.4)];
          ctx.fillRect(x - w * 0.5, -h, w, h);
        }
        ctx.globalAlpha = 1;
      }
      // Ground bloom.
      if (prog < 0.5) {
        const R = (26 + 40 * ringE) * U;
        ctx.save();
        ctx.scale(R * 1.5, R * 0.42);
        ctx.fillStyle = pirateGoldGlow(ctx);
        ctx.beginPath();
        ctx.arc(0, 0, 1, 0, PIRATE_TAU);
        ctx.fill();
        ctx.restore();
      }
      ctx.globalCompositeOperation = 'source-over';

      // Radial cracks, thrown out along the floor.
      ctx.lineCap = 'round';
      for (let i = 0; i < _PI_CRACKS.length; i++) {
        const a0 = pirateHash01c(i, 5) * PIRATE_TAU;
        let r = 0;
        ctx.strokeStyle = _prGold[prA(fade * 0.85)];
        ctx.lineWidth = (1.6 + pirateHash01c(i, 6) * 1.4) * U;
        ctx.beginPath();
        for (let j = 0; j < _PI_CRACK_NODES; j++) {
          r += (14 + pirateHash01c(i * 8 + j, 7) * 14) * U;
          const a = a0 + (pirateHash01c(i * 8 + j, 8) - 0.5) * 0.18;
          const x = Math.cos(a) * r * reachE * 1.15;
          const y = Math.sin(a) * r * reachE * 0.28;
          if (j) ctx.lineTo(x, y); else ctx.moveTo(x, y);
        }
        ctx.stroke();
      }

      // Shock ring.
      if (ringE < 1) {
        ctx.globalCompositeOperation = 'lighter';
        ctx.strokeStyle = _prGoldHot[prA((1 - ringE) * 0.8)];
        ctx.lineWidth = 4 * U * (1 - ringE * 0.6) + 0.5;
        ctx.beginPath();
        ctx.ellipse(0, 0, (18 + 96 * ringE) * U, (6 + 26 * ringE) * U, 0, 0, PIRATE_TAU);
        ctx.stroke();
        ctx.globalCompositeOperation = 'source-over';
      }

      // Tumbling rock, on gravity arcs.
      for (let i = 0; i < _PI_ROCKS.length; i++) {
        const h1 = pirateHash01c(i, 9);
        const h2 = pirateHash01c(i, 10);
        const a = -0.15 - h1 * 2.5;
        const sp = 0.5 + h2 * 1.4;
        const d = (30 + h1 * 70) * U * sp * artEaseOutExpo(Math.min(1, prog * 2.4));
        const y = Math.sin(a) * d + 340 * U * prog * prog;
        if (y > 0) continue;
        ctx.save();
        ctx.translate(Math.cos(a) * d, y);
        ctx.rotate(prog * (4 + h2 * 8) * (h1 > 0.5 ? 1 : -1));
        ctx.globalAlpha = fade;
        ctx.fillStyle = _prRock[_PR_A_STEPS];
        const sz = (2.6 + h1 * 3) * U;
        ctx.beginPath();
        ctx.moveTo(-sz, -sz * 0.5);
        ctx.lineTo(0, -sz);
        ctx.lineTo(sz, 0);
        ctx.lineTo(sz * 0.3, sz);
        ctx.lineTo(-sz, sz * 0.4);
        ctx.closePath();
        ctx.fill();
        ctx.strokeStyle = '#17110c';
        ctx.lineWidth = 1.4 * U;
        ctx.stroke();
        ctx.restore();
      }
      ctx.globalAlpha = 1;

      // Embers drifting up.
      ctx.globalCompositeOperation = 'lighter';
      for (let i = 0; i < _PI_EMBERS.length; i++) {
        const h1 = pirateHash01c(i, 11);
        const h2 = pirateHash01c(i, 12);
        const x = (h1 - 0.5) * 90 * U;
        const y = -((14 + h2 * 26) * U + prog * (50 + h1 * 70) * U);
        const a = fade * Math.sin(Math.PI * Math.min(1, prog * 1.4));
        ctx.fillStyle = _prGoldHot[prA(a * 0.9)];
        ctx.beginPath();
        ctx.arc(x, y, (1.2 + h1 * 1.6) * U, 0, PIRATE_TAU);
        ctx.fill();
      }
      ctx.restore();
    },
  },

  // ── Cannon Blast (in flight) ────────────────────────────────────────────
  // The round itself. The demo drew a dark iron ball with a bright rim sheen
  // inside a three-layer flame wake; that is what rides the projectile here.
  // Local +x points down the travel direction (the renderer sets `rotation`
  // from the velocity and `mirrorX` from the facing), so the wake streams off
  // behind in -x. `p.spin` is the projectile's own advancing clock, used only
  // to make the flame writhe — the ball's motion already carries the wake
  // down the screen.
  pirateCannonTrail: {
    name: 'Pirate Cannon Trail',
    color: '#ffbe50',
    draw(ctx, v, p) {
      ctx.save();
      ctx.translate(p.x, p.y);
      const s = v.scale || 1;
      const mx = v.mirrorX == null ? 1 : v.mirrorX;
      if (s !== 1 || mx !== 1) ctx.scale(s * mx, s);
      if (v.rotation) ctx.rotate((v.rotation * Math.PI) / 180);
      const r = p.r || 10;
      const clock = (p.spin || 0) * 0.35;
      ctx.globalCompositeOperation = 'lighter';
      pirateWake(ctx, r * 5.4, r * 1.25, clock, _prFlameOut);
      pirateWake(ctx, r * 4.4, r * 0.95, clock * 1.3, _prFlameMid);
      pirateWake(ctx, r * 2.6, r * 0.55, clock * 1.7, _prFlameCore);
      const R = r * 2.6;
      ctx.save();
      ctx.scale(R, R);
      ctx.fillStyle = pirateFlameGlow(ctx);
      ctx.beginPath();
      ctx.arc(0, 0, 1, 0, PIRATE_TAU);
      ctx.fill();
      ctx.restore();
      // The ball.
      ctx.globalCompositeOperation = 'source-over';
      ctx.fillStyle = '#2b2f38';
      ctx.beginPath();
      ctx.arc(0, 0, r, 0, PIRATE_TAU);
      ctx.fill();
      ctx.strokeStyle = '#0b0c10';
      ctx.lineWidth = 2.4;
      ctx.stroke();
      ctx.strokeStyle = 'rgba(190,200,220,0.7)';
      ctx.lineWidth = 1.8;
      ctx.beginPath();
      ctx.arc(0, 0, Math.max(1, r - 1.6), 3.6, 4.7);
      ctx.stroke();
      ctx.restore();
    },
  },

  // ── Cannon Blast (detonation) ───────────────────────────────────────────
  // Spawned by combat.js wherever a round actually RESOLVES — a landed hit, a
  // shielded block, a destructible it blew through. Never on a round that
  // simply ran out of life or left the arena, so an air fireball never paints
  // an explosion over empty stage. `params.unit` scales the whole burst off
  // the round's own radius, so a Plunder-enhanced ball bursts bigger.
  pirateCannonImpact: {
    name: 'Pirate Cannon Impact',
    color: '#ffbe50',
    draw(ctx, v, p) {
      ctx.save();
      ctx.translate(p.x, p.y);
      const s = v.scale || 1;
      const mx = v.mirrorX == null ? 1 : v.mirrorX;
      if (s !== 1 || mx !== 1) ctx.scale(s * mx, s);
      const prog = v.progress;
      if (prog >= 1) return;
      const P = v.params || PIRATE_NO_PARAMS;
      const U = P.unit == null ? 1 : P.unit;
      const fade = Math.max(0, 1 - prog);
      const flash = Math.max(0, 1 - prog / 0.22);
      const dome = artEaseOutExpo(Math.min(1, prog / 0.5));

      ctx.globalCompositeOperation = 'lighter';
      // Core flash.
      if (flash > 0.01) {
        const R = 90 * U * (0.6 + 0.4 * flash);
        ctx.save();
        ctx.scale(R, R);
        ctx.globalAlpha = flash;
        ctx.fillStyle = _prFlameCore[_PR_A_STEPS];
        ctx.beginPath();
        ctx.arc(0, 0, 1, 0, PIRATE_TAU);
        ctx.fill();
        ctx.restore();
      }
      // Dome shockwave.
      if (prog < 0.55) {
        const dr = 130 * U * dome;
        const da = (1 - prog / 0.55) * 0.7;
        ctx.strokeStyle = _prFlameMid[prA(da)];
        ctx.lineWidth = 4 * U * (1 - dome) + 1;
        ctx.beginPath();
        ctx.arc(0, 0, dr, 0, PIRATE_TAU);
        ctx.stroke();
        ctx.strokeStyle = _prFlameCore[prA(da * 0.8)];
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(0, 0, dr * 0.88, 3.6, 4.6);
        ctx.stroke();
      }
      // Ground ring, flattened like the demo's.
      if (dome < 1) {
        ctx.strokeStyle = _prFlameOut[prA((1 - dome) * 0.8)];
        ctx.lineWidth = 7 * U * (1 - dome * 0.7) + 0.5;
        ctx.beginPath();
        ctx.ellipse(0, 0, 210 * U * dome, 210 * U * dome * 0.14, 0, 0, PIRATE_TAU);
        ctx.stroke();
      }
      // Debris spikes thrown out radially.
      ctx.lineCap = 'round';
      for (let i = 0; i < _PI_SPIKES.length; i++) {
        const h1 = pirateHash01c(i, 13);
        const h2 = pirateHash01c(i, 14);
        const a = h1 * PIRATE_TAU;
        const len = 90 * U * (0.6 + h2 * 1.5) * artEaseOutExpo(Math.min(1, prog * 2.6));
        if (len < 3) continue;
        ctx.strokeStyle = (i % 2 ? _prFlameMid : _prFlameCore)[prA(fade * (0.5 + h1 * 0.5))];
        ctx.lineWidth = (1.6 + h2 * 2.4) * U;
        ctx.beginPath();
        ctx.moveTo(Math.cos(a) * 10 * U, Math.sin(a) * 10 * U);
        ctx.lineTo(Math.cos(a) * len, Math.sin(a) * len);
        ctx.stroke();
      }
      ctx.globalCompositeOperation = 'source-over';
      // Scorch left behind.
      if (prog > 0.06) {
        ctx.globalAlpha = Math.max(0, 0.5 * (1 - Math.max(0, prog - 0.1) / 0.9));
        ctx.fillStyle = '#120c08';
        ctx.beginPath();
        ctx.ellipse(0, 0, 70 * U, 12 * U, 0, 0, PIRATE_TAU);
        ctx.fill();
      }
      ctx.restore();
    },
  },

  // The broadside's wide, short cone of shot. Params: { scale } rides on `s`;
  // the burst always widens along +x (canonical space), and the caller mirrors
  // it with mirrorX, so it reads forward in both facings without a second art.
  pirateBroadside: {
    name: 'Pirate Broadside',
    color: '#ffd98a',
    draw(ctx, v, p) {
      ctx.save();
      ctx.translate(p.x, p.y);
      const s = v.scale || 1;
      const mx = v.mirrorX == null ? 1 : v.mirrorX;
      if (s !== 1 || mx !== 1) ctx.scale(s * mx, s);
      if (v.rotation) ctx.rotate((v.rotation * Math.PI) / 180);
      const prog = v.progress;
      const ease = 1 - (1 - prog) * (1 - prog);
      ctx.globalCompositeOperation = 'lighter';
      const len = 46 * ease;
      const halfH = 30 * ease;
      // Wide cone: a triangle swept forward, plus a hot inner core and a rim.
      ctx.beginPath();
      ctx.moveTo(0, -halfH * 0.42);
      ctx.lineTo(len, -halfH);
      ctx.lineTo(len, halfH);
      ctx.lineTo(0, halfH * 0.42);
      ctx.closePath();
      ctx.fillStyle = 'rgba(255, 200, 110, 0.5)';
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(0, -halfH * 0.24);
      ctx.lineTo(len * 0.72, -halfH * 0.52);
      ctx.lineTo(len * 0.72, halfH * 0.52);
      ctx.lineTo(0, halfH * 0.24);
      ctx.closePath();
      ctx.fillStyle = 'rgba(255, 245, 210, 0.55)';
      ctx.fill();
      ctx.globalCompositeOperation = 'source-over';
      // Shot pellets fanning out of the muzzle.
      ctx.globalAlpha = 1 - prog;
      ctx.fillStyle = '#2b2721';
      for (let i = 0; i < 5; i++) {
        const t = i / 4;
        const d = len * (0.35 + t * 0.6);
        const y = (t - 0.5) * halfH * 1.5;
        ctx.beginPath();
        ctx.arc(d, y, Math.max(0.6, 2.6 * (1 - prog)), 0, PIRATE_TAU);
        ctx.fill();
      }
      ctx.restore();
    },
  },

  // ── Shared melee connect burst ──────────────────────────────────────────
  // ONE effect for every pirate melee move (rope, cutlass, anchor) rather than
  // three near-identical ones: the moves differ in what they throw, not in what
  // a landed blow looks like. Spawned by combat.js at the point of contact and
  // PINNED there, because the target is already flying away from the spot and
  // an effect that rode the attacker would slide out of the hit it is standing
  // in. `params.shielded` swaps the palette to the game's cyan block read, so a
  // blocked blow reads as blocked instead of landing clean.
  pirateHitBurst: {
    name: 'Pirate Hit Burst',
    color: '#ffbe50',
    draw(ctx, v, p) {
      ctx.save();
      ctx.translate(p.x, p.y);
      const s = v.scale || 1;
      const mx = v.mirrorX == null ? 1 : v.mirrorX;
      if (s !== 1 || mx !== 1) ctx.scale(s * mx, s);
      const prog = v.progress;
      if (prog >= 1) return;
      const P = v.params || PIRATE_NO_PARAMS;
      const U = P.unit == null ? 1 : P.unit;
      const shielded = !!P.shielded;
      const fade = Math.max(0, 1 - prog);
      const hot = shielded ? _prShield : _prGold;
      const mid = shielded ? _prCyan : _prFlameMid;
      const core = shielded ? _prShield : _prFlameCore;
      const e = artEaseOutExpo(Math.min(1, prog / 0.4));

      ctx.globalCompositeOperation = 'lighter';
      // Shock ring.
      const rr = (7 + 46 * e) * U;
      ctx.strokeStyle = hot[prA(fade * 0.85)];
      ctx.lineWidth = 6 * U * (1 - prog) + 0.8;
      ctx.beginPath();
      ctx.arc(0, 0, rr, 0, PIRATE_TAU);
      ctx.stroke();
      ctx.strokeStyle = core[prA(fade * 0.6)];
      ctx.lineWidth = 2.4;
      ctx.beginPath();
      ctx.arc(0, 0, rr * 0.64, 0, PIRATE_TAU);
      ctx.stroke();
      // Crescents thrown down the attack direction (+x, already mirrored).
      for (let i = 0; i < _PI_BURST_CRESCENTS.length; i++) {
        const C = _PI_BURST_CRESCENTS[i];
        ctx.strokeStyle = (i === 1 ? mid : core)[prA(fade * C.a)];
        ctx.lineWidth = C.w * U * (1 - prog * 0.5);
        ctx.beginPath();
        ctx.arc(C.ox * U, 0, C.r * U * (0.5 + 0.6 * e), -1.1, 1.1);
        ctx.stroke();
      }
      // Radial streaks.
      ctx.lineCap = 'round';
      for (let i = 0; i < _PI_BURST_RAYS.length; i++) {
        const h1 = pirateHash01c(i, 15);
        const h2 = pirateHash01c(i, 16);
        const a = (i / _PI_BURST_RAYS.length) * PIRATE_TAU + h1 * 0.3;
        const len = (14 + h1 * 28) * U * (0.3 + e * 1.2);
        ctx.strokeStyle = (i % 3 === 0 ? core : hot)[prA(fade * (0.35 + h2 * 0.45))];
        ctx.lineWidth = (1.6 + h2 * 2.2) * U;
        ctx.beginPath();
        ctx.moveTo(Math.cos(a) * 5 * U, Math.sin(a) * 5 * U);
        ctx.lineTo(Math.cos(a) * len, Math.sin(a) * len);
        ctx.stroke();
      }
      // Hot core, gone by a third of the way in.
      const cf = Math.max(0, 1 - prog * 3);
      if (cf > 0) {
        ctx.globalAlpha = cf;
        ctx.fillStyle = core[_PR_A_STEPS];
        ctx.beginPath();
        ctx.arc(0, 0, (11 * cf + 3) * U, 0, PIRATE_TAU);
        ctx.fill();
      }
      ctx.restore();
    },
  },
};

const KNIGHT_VFX = {
  knightSlash: {
    name: 'Knight Slash',
    color: '#bcd2e8',
    draw(ctx, v, p) {
      ctx.save();
      ctx.translate(p.x, p.y);
      const s = v.scale || 1;
      const mx = v.mirrorX == null ? 1 : v.mirrorX;
      if (s !== 1 || mx !== 1) ctx.scale(s * mx, s);
      if (v.rotation) ctx.rotate((v.rotation * Math.PI) / 180);

      const prog = v.progress;
      const eased = artEaseOutQuad(prog);

      const arcLength = 100;
      const arcWidth = 10 * (1 - eased * 0.35);

      ctx.lineCap = 'round';
      ctx.lineWidth = arcWidth;
      ctx.strokeStyle = '#3a4a5a';
      ctx.beginPath();
      ctx.arc(0, 0, 26, -Math.PI / 2 - arcLength / 2 * Math.PI / 180, -Math.PI / 2 + arcLength / 2 * Math.PI / 180);
      ctx.stroke();

      ctx.lineWidth = arcWidth * 0.65;
      ctx.strokeStyle = '#bcd2e8';
      ctx.beginPath();
      ctx.arc(0, 0, 26, -Math.PI / 2 - arcLength / 2 * Math.PI / 180 + eased * 0.3, -Math.PI / 2 + arcLength / 2 * Math.PI / 180 - eased * 0.3);
      ctx.stroke();

      ctx.lineWidth = Math.max(1, arcWidth * 0.3);
      ctx.strokeStyle = '#ffe9a3';
      ctx.globalAlpha = Math.max(0, 1 - eased);
      ctx.beginPath();
      ctx.arc(0, 0, 26, -Math.PI / 2 - arcLength / 2 * Math.PI / 180 + eased * 0.5, -Math.PI / 2 + arcLength / 2 * Math.PI / 180 - eased * 0.5);
      ctx.stroke();

      ctx.lineCap = 'butt';
      ctx.restore();
    },
  },
  // Charged Sword Slash (knight fsmash, GA/vfx/blueslash.html): the demo's
  // crescent battery + blue glow wash, minus the staging (the game draws its
  // own fighter and weapon underneath — no character, sword, particles or
  // shake here). Five crescent layers, each a wide faint pass plus a narrow
  // bright pass, the head sweeping -2.5 to 0.75 rad while the tail chases,
  // with a white-hot leading core. Deterministic: fixed layers and angles,
  // driven purely by progress, so it draws identically every replay.
  // Weapon-anchored by combat.js knightSwingTrail, mirrored with facing.
  knightBlueSlash: {
    name: 'Knight Blue Slash',
    color: '#4aa8ff',
    draw(ctx, v, p) {
      ctx.save();
      ctx.translate(p.x, p.y);
      const s = v.scale || 1;
      const mx = v.mirrorX == null ? 1 : v.mirrorX;
      if (s !== 1 || mx !== 1) ctx.scale(s * mx, s);
      if (v.rotation) ctx.rotate((v.rotation * Math.PI) / 180);
      ctx.globalCompositeOperation = 'lighter';
      const pr = v.progress;
      const prog = pr < 0 ? 0 : pr > 1 ? 1 : pr;

      // Blue glow wash: strongest at release, gone by the end.
      const ga = 0.22 * (1 - prog);
      if (ga > 0.004) {
        const g = ctx.createRadialGradient(0, 0, 8, 0, 0, 150);
        g.addColorStop(0, 'rgba(60,150,255,' + ga.toFixed(3) + ')');
        g.addColorStop(1, 'rgba(0,110,255,0)');
        ctx.fillStyle = g;
        ctx.fillRect(-150, -150, 300, 300);
      }

      // Five crescent layers (the demo's LAYERS, game-sized).
      for (let li = 0; li < _BLUE_SLASH_LAYERS.length; li++) {
        const L = _BLUE_SLASH_LAYERS[li];
        const t2 = prog - L.d;
        if (t2 <= 0) continue;
        const hq = t2 / 0.3;
        const hc = hq < 0 ? 0 : hq > 1 ? 1 : hq;
        const head = -2.5 + 3.25 * (1 - (1 - hc) * (1 - hc) * (1 - hc));
        const tq = (t2 - 0.05) / 0.4;
        const tc = tq < 0 ? 0 : tq > 1 ? 1 : tq;
        const tail = -2.5 + 3.25 * tc * tc * tc;
        const aq = (t2 - 0.35) / 0.35;
        const al = 1 - (aq < 0 ? 0 : aq > 1 ? 1 : aq);
        if (al <= 0.004 || head - tail < 0.02) continue;
        _blueSlashCrescent(ctx, L.R, L.W * 2.3, tail, head, al * 0.25);
        _blueSlashCrescent(ctx, L.R, L.W, tail, head, al);
      }

      // White-hot leading core: thin, early, first to fade. A dark outline
      // rides under it (source-over, so it reads on bright backgrounds) with
      // the white core redrawn additively on top.
      if (prog < 0.4) {
        const q = prog / 0.4;
        const e = 1 - (1 - q) * (1 - q) * (1 - q);
        const a0 = -2.5 + 3.25 * e - 0.5, a1 = -2.5 + 3.25 * e;
        ctx.globalCompositeOperation = 'source-over';
        ctx.globalAlpha = (1 - q) * 0.9;
        ctx.lineCap = 'round';
        ctx.lineWidth = 7;
        ctx.strokeStyle = '#0a1c33';
        ctx.beginPath();
        ctx.arc(0, 0, 100, a0, a1);
        ctx.stroke();
        ctx.globalCompositeOperation = 'lighter';
        ctx.globalAlpha = (1 - q) * 0.9;
        ctx.lineWidth = 4;
        ctx.strokeStyle = '#ffffff';
        ctx.beginPath();
        ctx.arc(0, 0, 100, a0, a1);
        ctx.stroke();
      }
      ctx.restore();
    },
  },
  // Circle explosion (knight dash launch): a white flash core, two expanding
  // rings (steel-blue, then gold), and ten deterministic radial shards.
  // Fixed angles/distances per index — no per-frame random, no allocation.
  knightCircleBurst: {
    name: 'Knight Circle Burst',
    color: '#ffd23a',
    draw(ctx, v, p) {
      ctx.save();
      ctx.translate(p.x, p.y);
      const s = v.scale || 1;
      const mx = v.mirrorX == null ? 1 : v.mirrorX;
      if (s !== 1 || mx !== 1) ctx.scale(s * mx, s);
      if (v.rotation) ctx.rotate((v.rotation * Math.PI) / 180);
      ctx.globalCompositeOperation = 'lighter';
      ctx.lineCap = 'round';
      const pr = v.progress;
      const prog = pr < 0 ? 0 : pr > 1 ? 1 : pr;
      const e = prog * (2 - prog);

      // Flash core: full white, gone in the first third.
      if (prog < 0.35) {
        const q = prog / 0.35;
        ctx.globalAlpha = 1 - q;
        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        ctx.arc(0, 0, 26 * (1 - q) + 6, 0, Math.PI * 2);
        ctx.fill();
      }
      // Lead ring (steel-blue) + chasing ring (gold).
      const fade = 1 - prog;
      ctx.globalAlpha = fade * 0.9;
      ctx.lineWidth = Math.max(1, 7 * fade);
      ctx.strokeStyle = '#4aa8ff';
      ctx.beginPath();
      ctx.arc(0, 0, 10 + 90 * e, 0, Math.PI * 2);
      ctx.stroke();
      if (prog > 0.12) {
        const q2 = (prog - 0.12) / 0.88;
        const e2 = q2 * (2 - q2);
        ctx.globalAlpha = (1 - q2) * 0.8;
        ctx.lineWidth = Math.max(1, 5 * (1 - q2));
        ctx.strokeStyle = '#ffd23a';
        ctx.beginPath();
        ctx.arc(0, 0, 6 + 70 * e2, 0, Math.PI * 2);
        ctx.stroke();
      }
      // Ten radial shards, alternating steel and gold.
      ctx.globalAlpha = fade;
      ctx.fillStyle = '#bcd2e8';
      for (let i = 0; i < 10; i++) {
        const a = (i / 10) * Math.PI * 2 + 0.31;
        const d = e * (46 + (i % 3) * 14);
        const sx = Math.cos(a) * d, sy = Math.sin(a) * d;
        const sz = 6 * fade + 1;
        ctx.save();
        ctx.translate(sx, sy);
        ctx.rotate(a + prog * 2);
        ctx.beginPath();
        ctx.moveTo(0, -sz);
        ctx.lineTo(sz * 0.35, 0);
        ctx.lineTo(0, sz);
        ctx.lineTo(-sz * 0.35, 0);
        ctx.closePath();
        ctx.fillStyle = (i % 2) ? '#ffd23a' : '#bcd2e8';
        ctx.fill();
        ctx.restore();
      }
      ctx.restore();
    },
  },
  // Shield Bash push (knight dtilt): eight speed lines trailing behind the
  // user while the shield shoves forward. Streak geometry is indexed (never
  // random per frame) so the pooled instance draws identically every replay.
  // Character-anchored by the Shield Bash ability, mirrored with facing.
  knightSpeedLines: {
    name: 'Knight Speed Lines',
    color: '#bfe6ff',
    draw(ctx, v, p) {
      ctx.save();
      ctx.translate(p.x, p.y);
      const s = v.scale || 1;
      const mx = v.mirrorX == null ? 1 : v.mirrorX;
      if (s !== 1 || mx !== 1) ctx.scale(s * mx, s);
      if (v.rotation) ctx.rotate((v.rotation * Math.PI) / 180);
      ctx.globalCompositeOperation = 'lighter';
      ctx.lineCap = 'round';
      const pr = v.progress;
      const prog = pr < 0 ? 0 : pr > 1 ? 1 : pr;
      const fade = 1 - prog;
      for (let i = 0; i < 8; i++) {
        const y = -21 + i * 6;
        const tailX = -8 - i * 10 - prog * 90;
        ctx.globalAlpha = fade * (0.55 - i * 0.05);
        ctx.lineWidth = Math.max(1, 4 - i * 0.3);
        ctx.strokeStyle = (i % 2) ? '#4aa8ff' : '#bfe6ff';
        ctx.beginPath();
        ctx.moveTo(tailX, y);
        ctx.lineTo(tailX + 60 - i * 5, y - 3);
        ctx.stroke();
      }
      ctx.restore();
    },
  },
  // Shield Bash impact (GA/vfx/shieldbash.html): a triple blue arc bursting
  // off the shield face, a gold star pop and a short spray of gold shards.
  // Deterministic geometry (indexed, never random per frame) so the pooled
  // instance draws identically every replay.
  knightBash: {
    name: 'Knight Bash',
    color: '#7fd4ff',
    draw(ctx, v, p) {
      ctx.save();
      ctx.translate(p.x, p.y);
      const s = v.scale || 1;
      const mx = v.mirrorX == null ? 1 : v.mirrorX;
      if (s !== 1 || mx !== 1) ctx.scale(s * mx, s);
      if (v.rotation) ctx.rotate((v.rotation * Math.PI) / 180);
      const prog = Math.max(0, Math.min(1, v.progress));
      const e = artEaseOutQuad(prog);
      const fade = Math.max(0, 1 - prog);

      // Triple expanding arc, lead white into blue.
      const rad = 16 + e * 52;
      const cols = ['#ffffff', '#7fd4ff', '#1f6bff'];
      ctx.lineCap = 'round';
      for (let i = 0; i < 3; i++) {
        ctx.globalAlpha = fade * (1 - i * 0.25);
        ctx.lineWidth = Math.max(1, (10 - i * 2.5) * (1 - e * 0.5));
        ctx.strokeStyle = cols[i];
        ctx.beginPath();
        ctx.arc(-rad * 0.55, 0, rad - i * 5, -1.0, 1.0);
        ctx.stroke();
      }
      // Gold star pop over the first third.
      if (prog < 0.45) {
        const q = prog / 0.45;
        const sc = 10 + (1 - q) * 22;
        ctx.globalAlpha = 1 - q;
        ctx.translate(6, 0);
        ctx.beginPath();
        for (let i = 0; i < 18; i++) {
          const a = (i / 18) * Math.PI * 2;
          const rr = i % 2 ? sc * 0.45 : sc;
          const px = Math.cos(a) * rr, py = Math.sin(a) * rr;
          if (i === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        }
        ctx.closePath();
        ctx.fillStyle = '#ffd23a';
        ctx.fill();
        ctx.lineWidth = 2.5;
        ctx.strokeStyle = '#ff9a1a';
        ctx.stroke();
      }
      // Gold shards fanning forward.
      ctx.globalAlpha = Math.min(1, fade * 2);
      ctx.fillStyle = '#ffc933';
      for (let i = 0; i < 6; i++) {
        const a = -0.9 + i * 0.36;
        const d = e * (26 + (i % 3) * 10);
        const sx = Math.cos(a) * d + 4, sy = Math.sin(a) * d;
        const sz = 5 * (1 - e * 0.6);
        ctx.save();
        ctx.translate(sx, sy);
        ctx.rotate(a + e * 2);
        ctx.beginPath();
        ctx.moveTo(0, -sz);
        ctx.lineTo(sz * 0.35, 0);
        ctx.lineTo(0, sz);
        ctx.lineTo(-sz * 0.35, 0);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
      }
      ctx.restore();
    },
  },
  // Spinning Sweep (GA/vfx/spinningsweep.html), ported 1:1: the same 26
  // blade ribbons (16 wide + 10 thin dark), palette, envelope and growth —
  // only the demo's ball/sword/shadow staging is left out, since the game
  // draws its own fighter and weapon underneath. Per-blade randomness is a
  // deterministic function of the blade index (the demo rolls it once at
  // spawn; a pooled effect must draw identically every replay), and phase
  // advance is the same integral expressed in progress instead of wall time.
  // Full ring rather than the demo's clipped front/back halves: the game
  // composites the fighter separately, so there is no screen half to clip to.
  knightSweep: {
    name: 'Knight Sweep',
    color: '#5cc8ff',
    draw(ctx, v, p) {
      ctx.save();
      ctx.translate(p.x, p.y);
      const s = v.scale || 1;
      const mx = v.mirrorX == null ? 1 : v.mirrorX;
      if (s !== 1 || mx !== 1) ctx.scale(s * mx, s);
      const prog = Math.max(0, Math.min(1, v.progress));
      const env = prog < 0.12 ? prog / 0.12 : prog > 0.75 ? (1 - prog) / 0.25 : 1;
      if (env <= 0.01) { ctx.restore(); return; }
      const U = 30; // world-px unit: blades reach ~6.8U, like ball radius s
      const blades = sweepBlades();
      const grow = 0.6 + 0.4 * Math.min(1, prog * 4);
      ctx.globalAlpha = Math.min(1, env * 1.4);
      for (let bi = 0; bi < blades.length; bi++) {
        const b = blades[bi];
        const bl = b.bl;
        const ph = b.ph0 + b.sp * 1.5 * prog;
        const rx = U * (2.2 + 3.4 * b.k + b.kr * 0.5) * grow;
        const ry = rx * 0.42;
        const w = U * b.w;
        // Thin dark blades paint once; wide blades paint twice (base + light
        // inner pass). No per-blade layer arrays — the sweep lives for a third
        // of a second and must not allocate on its hottest path.
        for (let li = 0; li < (bl ? 1 : 2); li++) {
          const c = bl ? '#000000' : (li === 0 ? _SWEEP_PAL[b.ci][0] : _SWEEP_PAL[b.ci][1]);
          const m = bl ? 1 : (li === 0 ? 1 : 0.45);
          ctx.beginPath();
          const n = 22;
          for (let j = 0; j <= n; j++) {
            const f = j / n;
            const th = ph - b.span * (1 - f);
            const g = w * m * Math.sin(Math.PI * Math.pow(f, 1.5)) / (2 * rx);
            const ox = rx * (1 + g) * Math.cos(th), oy = ry * (1 + g) * Math.sin(th);
            if (j === 0) ctx.moveTo(ox, oy);
            else ctx.lineTo(ox, oy);
          }
          for (let j = n; j >= 0; j--) {
            const f = j / n;
            const th = ph - b.span * (1 - f);
            const g = w * m * Math.sin(Math.PI * Math.pow(f, 1.5)) / (2 * rx);
            ctx.lineTo(rx * (1 - g) * Math.cos(th), ry * (1 - g) * Math.sin(th));
          }
          ctx.closePath();
          ctx.fillStyle = c;
          ctx.fill();
        }
      }
      ctx.restore();
    },
  },
  // Shield Counter (GA/vfx/shieldcounter.html): two phases. Early: the blue
  // block crescent and tick marks of the catch. Late: the rising counter
  // swoosh, gold star and shockwave ring of the answering slash.
  knightCounter: {
    name: 'Knight Counter',
    color: '#6cc8ff',
    draw(ctx, v, p) {
      ctx.save();
      ctx.translate(p.x, p.y);
      const s = v.scale || 1;
      const mx = v.mirrorX == null ? 1 : v.mirrorX;
      if (s !== 1 || mx !== 1) ctx.scale(s * mx, s);
      if (v.rotation) ctx.rotate((v.rotation * Math.PI) / 180);
      const prog = Math.max(0, Math.min(1, v.progress));
      if (prog < 0.38) {
        // Catch: block crescent + ticks.
        const q = prog / 0.38;
        ctx.globalAlpha = Math.min(1, q * 3);
        ctx.fillStyle = '#6cc8ff';
        ctx.beginPath();
        ctx.arc(-14, 0, 24, -1, 1);
        ctx.arc(-4, 0, 21, 1, -1, true);
        ctx.closePath();
        ctx.fill();
        ctx.strokeStyle = '#111111';
        ctx.lineWidth = 3;
        ctx.lineCap = 'round';
        for (let i = 0; i < 2; i++) {
          const a = -1.1 + i * 0.6;
          ctx.beginPath();
          ctx.moveTo(8, -26);
          ctx.lineTo(8 + Math.cos(a) * 20, -26 + Math.sin(a) * 20);
          ctx.stroke();
        }
      } else {
        // Answer: swoosh + star + ring.
        const q = (prog - 0.38) / 0.62;
        const fade = Math.max(0, 1 - q);
        const swooshCols = ['#1f78ff', '#5cc0ff', '#ffffff'];
        for (let i = 0; i < 3; i++) {
          ctx.globalAlpha = fade * (1 - i * 0.2);
          ctx.strokeStyle = swooshCols[i];
          ctx.lineWidth = Math.max(1, 12 * (1 - i * 0.35) * (1 - q * 0.5));
          ctx.lineCap = 'round';
          ctx.beginPath();
          ctx.arc(0, 0, 52, -2.4 + q * 1.2 + i * 0.08, 0.4 + q * 0.6 + i * 0.08);
          ctx.stroke();
        }
        if (q < 0.5) {
          const sc = 12 + (1 - q * 2) * 26;
          ctx.globalAlpha = 1 - q * 2;
          ctx.beginPath();
          for (let i = 0; i < 20; i++) {
            const a = (i / 20) * Math.PI * 2;
            const rr = i % 2 ? sc * 0.5 : sc;
            const px = Math.cos(a) * rr + 10, py = Math.sin(a) * rr;
            if (i === 0) ctx.moveTo(px, py);
            else ctx.lineTo(px, py);
          }
          ctx.closePath();
          ctx.fillStyle = '#ffd23a';
          ctx.fill();
          ctx.lineWidth = 3;
          ctx.strokeStyle = '#111111';
          ctx.stroke();
        }
        ctx.globalAlpha = fade;
        ctx.lineWidth = Math.max(1, 8 * fade);
        ctx.strokeStyle = '#ffffff';
        ctx.beginPath();
        ctx.arc(0, 0, 20 + q * 60, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.restore();
    },
  },
};

// The single effect registry, defined here as VFX_EFFECTS.
export const VFX_EFFECTS = {
  ...COWBOY_AL_VFX,
  ...SHADOW_DASH_VFX,
  ...SMOKE_VFX,
  ...BOXER_VFX,
  ...KNIGHT_VFX,
  ...PIRATE_VFX,
};


// ── merged from effects/vfx.js ──
// vfx.js — effect library for per-animation VFX. The effect art itself lives in
// fx.js (one merged module holding every converted art source: the
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


// Local wrapper (rather than `export { warmEffectSprites }`) so this module
// always provides the named export even if the art import is still resolving
// or gets tree-shaken — Game.js imports it from here.
export function warmEffectSprites() {
  try { warmArtSprites(); } catch (_) {}
}

const EMPTY_VFX = [];

const _pos = { x: 0, y: 0 };

// View culling (same contract as Effects.js / worldFx.js): world-space visible
// rect set once per frame by Game.js. A fighter fully outside it skips its
// entire VFX pools — simulation is untouched, only rasterization is saved.
let _evx0 = -1e9, _evy0 = -1e9, _evx1 = 1e9, _evy1 = 1e9;
export function setVfxViewBounds(x0, y0, x1, y1) {
  _evx0 = x0; _evy0 = y0; _evx1 = x1; _evy1 = y1;
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
    // Opaque art params (e.g. the Straight Right's size unit) ride along
    // read-only; effects never mutate them.
    v.params = src.params || null;
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
  if (fighter.x < _evx0 - 220 || fighter.x > _evx1 + 220 ||
      fighter.y < _evy0 - 220 || fighter.y > _evy1 + 220) {
    const _tmp = fighter._tempVfx;
    let _keep = false;
    if (_tmp) {
      for (let _i = 0; _i < _tmp.length; _i++) {
        const _v = _tmp[_i];
        if (_v && _v.pinnedX != null &&
            _v.pinnedX > _evx0 - 80 && _v.pinnedX < _evx1 + 80 &&
            _v.pinnedY > _evy0 - 80 && _v.pinnedY < _evy1 + 80) { _keep = true; break; }
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
      // Timeline offsets are authored canonically (facing right), so they
      // mirror with the fighter — the muzzle stays in front of the gun on
      // both facings. (Temp-pool spawners pre-mirror their own offsets, so
      // that path below is untouched.)
      _pos.x += (v.mirrorX && v.mirrorX < 0 ? -1 : 1) * (v.offsetX || 0);
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


// ── merged from render/worldFx.js ──
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

  // Knight: polished steel and gold. Bright steel sparks, pale stone dust,
  // gold rings — regal and restrained next to the boxer's red.
  knight: {
    id: 'knight',
    spark: '#ffe9a3',
    spark2: '#d9a92e',
    dust: '#c3ccd4',
    dust2: '#6e7b85',
    debris: '#4a545c',
    slash: '#eef3f7',
    slash2: '#8fa3b8',
    trail: '#bcd2e8',
    ghost: '#9fb2c6',
    ghostAlpha: 0.3,
    dustAlpha: 0.5,
    ring: '#d9a92e',
    slashScale: 1.0,
  },

  // Pirate: salt-bleached rope, dark oak and brass. Warm gunpowder embers over
  // grey rope-fibre dust — the same gun brass the cowboy uses for its muzzle
  // pops, pushed toward a cooler grey dust so the rope reads as fibre, not
  // more gunpowder.
  pirate: {
    id: 'pirate',
    spark: '#ffd98a',
    spark2: '#c8862a',
    dust: '#cbc2b2',
    dust2: '#7a6d5c',
    debris: '#4d4437',
    slash: '#f2ead9',
    slash2: '#c8a24a',
    trail: '#b9a887',
    ghost: '#a2947c',
    ghostAlpha: 0.3,
    dustAlpha: 0.48,
    ring: '#e0b256',
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
const K_ARC = 7;   // crescent slash arc
const K_WAVE = 8;  // thicker, slower shockwave ring
const K_FIST = 9;  // barrage fist-ball: solid fill + dark outline, grows in flight

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
    // Evict the oldest live record. The previous form scanned the whole array
    // for the minimum seq on EVERY push once the cap was reached — and sitting
    // at the cap is exactly the state a heavy fight is in, so one muzzle pop
    // (flash + 5 sparks + 3 dust = 9 pushes) cost ~3000 comparisons.
    //
    // Records are appended in spawn order and only reordered by swap-removes,
    // so the minimum is almost always at or near the head. The scan starts at a
    // rotating hint and wraps, so it still visits every index and therefore
    // still finds the true minimum — it just finds it in a couple of steps.
    const n = _live.length;
    let oldest = 0;
    let oldestSeq = _live[0].seq;
    let start = _evictHint;
    if (start >= n) start = 0;
    for (let k = 0; k < n; k++) {
      let idx = start + k;
      if (idx >= n) idx -= n;
      const s = _live[idx].seq;
      if (s < oldestSeq) { oldestSeq = s; oldest = idx; }
    }
    _evictHint = oldest + 1;
    if (_evictHint >= n) _evictHint = 0;
    const dead = _live[oldest];
    _live[oldest] = _live[n - 1];
    _live.length = n - 1;
    _release(dead);
  }
  p.seq = ++_seq;
  p.life = p.maxLife;
  _live.push(p);
  return p;
}
// Rotating start index for the eviction scan above.
let _evictHint = 0;

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

// ── Render detail (adaptive quality, render-only) ──────────────────────
// particleDetail: 0=full, 1=reduced (2-layer flash, 3-seg arcs), 2=minimal.
// postDetail: 0=full 3-pass invert, 1=2-pass approx, 2=skip invert (tint stays).
// _batchParticles: fast path without per-particle save/restore (default on).
let _particleDetail = 0;
let _postDetail = 0;
let _batchParticles = true;
export function setParticleDetail(d) { _particleDetail = Math.max(0, Math.min(2, d | 0)); }
export function setPostDetail(d) { _postDetail = Math.max(0, Math.min(2, d | 0)); }
export function setWorldFxBatch(on) { _batchParticles = on !== false; }

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

// Barrage fist-ball (GA/vfx/boxerbarrage.html): a light-blue ball with a bold
// dark outline that grows as it travels and fades in fast. Fired by the boxer
// barrage hold along the facing cone; pooled like every other kind.
export function emitBarrageFist(x, y, dirX, dirY, opts) {
  const o = opts || EMPTY;
  const n = _scaledCount(Math.max(1, Math.min(8, (o.count | 0) || 2)));
  const base = Math.atan2(dirY, dirX);
  const spread = o.spread == null ? 0.8 : o.spread;
  const speed = o.speed == null ? 380 : o.speed;
  const life = o.life == null ? 0.3 : o.life;
  const size = o.size == null ? 14 : o.size;
  const jitter = o.jitter == null ? 8 : o.jitter;
  for (let i = 0; i < n; i++) {
    const a = base + (Math.random() - 0.5) * spread;
    const sp = speed * (0.7 + Math.random() * 0.6);
    const p = _take();
    p.kind = K_FIST;
    p.x = x + (Math.random() - 0.5) * jitter;
    p.y = y + (Math.random() - 0.5) * jitter;
    p.vx = Math.cos(a) * sp;
    p.vy = Math.sin(a) * sp;
    p.maxLife = life * (0.8 + Math.random() * 0.4);
    p.size = size * (0.8 + Math.random() * 0.5);
    p.drag = 0.99;
    p.gravity = 0;
    p.alpha = o.alpha == null ? 1 : o.alpha;
    p.additive = false;
    p.color = o.color || '#8fd8ff';
    p.color2 = o.outline || '#111111';
    _push(p);
  }
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
    // Pirate cannon (Cannon Blast): the shared firearm muzzle pop off the
    // barrel, sized off the projectile's own radius so a Plunder-Enhanced
    // (bigger) ball gets a proportionally bigger flash.
    case 'cannon': {
      const pr = (atk && atk.fxProjR) || r * 0.45;
      emitFlash(x, y, { style, radius: pr * 1.5, life: 0.08, alpha: 0.9, color: '#fff3c4' });
      emitSparks(x, y, 6, {
        style, dir: away, spread: 0.55, speed: 420, life: 0.13, size: 2, gravity: 120,
      });
      emitDustPuff(x + dir * pr, y, 4, {
        style, dir: away, spread: 0.7, speed: 120, size: r * 0.16,
        life: 0.34, gravity: -50, alpha: 0.4,
      });
      break;
    }
    // Pirate anchor (Anchor Drop): a heavy downward kick off the floor at the
    // impact point. The ground ring/chip art is the ability's own VFX instance
    // (pirateAnchorSlam); this is the dust kick that reads under it.
    case 'anchor': {
      emitDustPuff(x, y + r * 0.6, 7, {
        style, spread: Math.PI, speed: 170, size: r * 0.2,
        life: 0.36, gravity: 150, jitter: r * 0.7, alpha: 0.5,
      });
      emitFlash(x, y, { style, radius: r * 0.55, life: 0.09, alpha: 0.5, color: '#e8dcc4' });
      break;
    }
    // Pirate cutlass (Cutlass Lunge): the point of the blade goes bright at
    // the cast. The swept crescent the lunge leaves in the world is the
    // ability's own pirateCutlassSlash instance (pinned, so the body passes
    // through it) — this is only the spark at the hand that throws it.
    case 'cutlass': {
      emitFlash(x, y, { style, radius: r * 0.32, life: 0.06, alpha: 0.6, color: '#dcefff' });
      emitStreak(x, y, dir, 0, { style, length: r * 1.5, width: 2.6, life: 0.12, alpha: 0.45 });
      break;
    }
    // Pirate rope (Rope Swing): the hook throw pops at the hand.
    case 'rope': {
      emitFlash(x, y, { style, radius: r * 0.3, life: 0.06, alpha: 0.6, color: '#ffeec2' });
      emitStreak(x, y, dir, 0, { style, length: r * 1.8, width: 2.2, life: 0.12, alpha: 0.4 });
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
  // Fast path (default): simple particles draw without save/restore — they use
  // absolute coords and touch only alpha/style/width, so one pass with a
  // tracked composite is pixel-identical and saves ~2 stack ops per particle.
  // DEBRIS (translate/rotate) and K_ARC keep their isolated path. Set
  // worldFxBatch(false) or FLAGS.legacy for the original per-particle path.
  if (!_batchParticles) {
    for (let i = 0; i < n; i++) {
      const p = _live[i];
      if (p.x < _vx0 - 60 || p.x > _vx1 + 60 || p.y < _vy0 - 60 || p.y > _vy1 + 60) continue;
      drawParticle(ctx, p);
    }
    return;
  }
  let comp = 'source-over';
  let capSet = false;
  for (let i = 0; i < n; i++) {
    const p = _live[i];
    if (p.x < _vx0 - 60 || p.x > _vx1 + 60 || p.y < _vy0 - 60 || p.y > _vy1 + 60) continue;
    const t = p.life / p.maxLife;
    // Minimal detail: drop the invisible fade-out tail of soft decorative
    // puffs. Sparks/rings/flashes (gameplay feedback) are never culled here.
    if (_particleDetail >= 2 && (p.kind === K_DUST || p.kind === K_GHOST) && t < 0.25) continue;
    if (p.kind === K_DEBRIS || p.kind === K_ARC) {
      if (comp !== 'source-over') { ctx.globalCompositeOperation = 'source-over'; comp = 'source-over'; }
      if (capSet) { ctx.lineCap = 'butt'; capSet = false; }
      ctx.globalAlpha = 1;
      drawParticleComplex(ctx, p, t);
      continue;
    }
    const want = p.additive ? 'lighter' : 'source-over';
    if (want !== comp) { ctx.globalCompositeOperation = want; comp = want; }
    drawParticleSimple(ctx, p, t, capSet);
    if (p.kind === K_SPARK || p.kind === K_STREAK || p.kind === K_RING || p.kind === K_WAVE) capSet = true;
  }
  if (comp !== 'source-over') ctx.globalCompositeOperation = 'source-over';
  if (capSet) ctx.lineCap = 'butt';
  ctx.globalAlpha = 1;
}

function drawParticleAdditive(ctx, p) {
  drawParticle(ctx, p);
}

// Simple kinds: absolute coords only, no transform/clip. Caller owns the
// composite tracking; exit alpha is the particle's own (reset once per pass).
function drawParticleSimple(ctx, p, t, capSet) {
  const grow = 1 - t;
  const fade = t < 0.4 ? t / 0.4 : 1;
  const TAU = Math.PI * 2;
  switch (p.kind) {
    case K_DUST: {
      ctx.globalAlpha = p.alpha * t;
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size * (0.55 + grow * p.size2), 0, TAU);
      ctx.fill();
      break;
    }
    case K_SPARK: {
      ctx.globalAlpha = p.alpha * fade;
      ctx.strokeStyle = p.color;
      if (!capSet) ctx.lineCap = 'round';
      ctx.lineWidth = Math.max(0.6, p.size * fade);
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(p.x - p.vx * 0.035, p.y - p.vy * 0.035);
      ctx.stroke();
      break;
    }
    case K_STREAK: {
      const dx = Math.cos(p.rot) * p.size;
      const dy = Math.sin(p.rot) * p.size;
      ctx.globalAlpha = p.alpha * fade;
      ctx.strokeStyle = p.color;
      if (!capSet) ctx.lineCap = 'round';
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
      ctx.arc(p.x, p.y, p.size + grow * p.size2, 0, TAU);
      ctx.stroke();
      break;
    }
    case K_FLASH: {
      const a = p.alpha * t * t;
      const r = p.size * (0.85 + grow * 0.45);
      // Reduced detail: 2 layers instead of 3 (outer halo merged away).
      if (_particleDetail >= 1) {
        ctx.fillStyle = p.color2;
        ctx.globalAlpha = a * 0.4;
        ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, TAU); ctx.fill();
        ctx.globalAlpha = a * 0.95;
        ctx.fillStyle = p.color;
        ctx.beginPath(); ctx.arc(p.x, p.y, r * 0.4, 0, TAU); ctx.fill();
      } else {
        ctx.fillStyle = p.color2;
        ctx.globalAlpha = a * 0.22;
        ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, TAU); ctx.fill();
        ctx.globalAlpha = a * 0.45;
        ctx.beginPath(); ctx.arc(p.x, p.y, r * 0.55, 0, TAU); ctx.fill();
        ctx.globalAlpha = a * 0.95;
        ctx.fillStyle = p.color;
        ctx.beginPath(); ctx.arc(p.x, p.y, r * 0.3, 0, TAU); ctx.fill();
      }
      break;
    }
    case K_GHOST: {
      ctx.globalAlpha = p.alpha * fade;
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size, 0, TAU);
      ctx.fill();
      break;
    }
    case K_FIST: {
      // Grows with age (like the reference), fades in over the first quarter.
      // Bold outline: the fill is light blue, which washes out against the
      // light sky background without a heavy dark edge.
      const rr = p.size * (0.15 + 0.85 * grow);
      ctx.globalAlpha = p.alpha * Math.min(1, grow * 4);
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, rr, 0, TAU);
      ctx.fill();
      ctx.lineWidth = 5;
      ctx.strokeStyle = p.color2 || '#111111';
      ctx.stroke();
      break;
    }
    default: break;
  }
}

// Complex kinds: isolated state (translate/rotate or multi-segment strokes).
function drawParticleComplex(ctx, p, t) {
  const grow = 1 - t;
  const fade = t < 0.4 ? t / 0.4 : 1;
  ctx.save();
  if (p.additive) ctx.globalCompositeOperation = 'lighter';
  if (p.kind === K_DEBRIS) {
    const s = p.size * (0.55 + 0.45 * t);
    ctx.globalAlpha = p.alpha * fade;
    ctx.fillStyle = p.color;
    ctx.translate(p.x, p.y);
    ctx.rotate(p.rot);
    ctx.fillRect(-s * 0.5, -s * 0.5, s, s);
  } else if (p.kind === K_ARC) {
    const r = p.size * (0.7 + 0.3 * grow);
    const a0 = p.rot - p.size2 / 2;
    // Fewer taper segments at reduced detail (same silhouette, fewer strokes).
    const segs = _particleDetail >= 2 ? 2 : _particleDetail >= 1 ? 3 : 5;
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
  }
  ctx.restore();
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
      ctx.arc(p.x, p.y, p.size, 0, TAU);
      ctx.fill();
      break;
    }
    case K_FIST: {
      const rr = p.size * (0.15 + 0.85 * grow);
      ctx.globalAlpha = p.alpha * Math.min(1, grow * 4);
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, rr, 0, Math.PI * 2);
      ctx.fill();
      ctx.lineWidth = 5;
      ctx.strokeStyle = p.color2 || '#111111';
      ctx.stroke();
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
// ability NAMES itself on screen — the boxer's GRAB. It rides
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

    // Cached sprite path (default on): outlined+filled text pre-rendered once
    // per (text|color|size). drawImage replaces strokeText+fillText (~2x text
    // raster cost) and stays pixel-identical; alpha fade applies via
    // globalAlpha. Falls back to direct text on any cache failure.
    if (_textCache) {
      const sprite = _dmgSprite(text, d.color, Math.round(sz));
      if (sprite) {
        ctx.drawImage(sprite.c, d.x - sprite.w / 2, y - sprite.h / 2, sprite.w, sprite.h);
        continue;
      }
    }

    // Dark outline for contrast against any background.
    ctx.strokeText(text, d.x, y);

    // Bright fill in the attacker's tint.
    ctx.fillStyle = d.color;
    ctx.fillText(text, d.x, y);
  }

  ctx.restore();
}

// Bounded pre-rendered damage-number sprites. Key: text|color|sizeBucket.
// Max 64 entries, FIFO eviction (Map insertion order). Each sprite holds the
// stroke+fill once, so hot numbers (integers, repeated colors) rasterize once
// instead of twice per frame. Alpha/pop are applied at draw time, never baked.
//
// DMG_SS supersamples the bake: these numbers draw in WORLD space, under the
// camera transform, so a 1x bake is magnified by the live zoom (typically
// 1.3–2.3x in play, more on close-ups) and reads as blurry. Baking at 4x —
// the same rationale as BODY_SS in Effects.js — keeps them sharp at any
// framing; the blit passes explicit logical dw/dh so layout is unchanged.
const DMG_SS = 4;
const _dmgSprites = new Map();
let _textCache = true;
export function setDamageTextCache(on) { _textCache = on !== false; }
function _dmgSprite(text, color, sizeBucket) {
  const key = text + '|' + color + '|' + sizeBucket;
  let rec = _dmgSprites.get(key);
  if (rec) return rec;
  if (_dmgSprites.size >= 64) {
    const oldest = _dmgSprites.keys().next().value;
    _dmgSprites.delete(oldest);
  }
  try {
    const font = `${sizeBucket}px Consolas, "Courier New", monospace`;
    const meas = document.createElement('canvas').getContext('2d');
    meas.font = font;
    const w = Math.ceil(meas.measureText(text).width) + 12;
    const h = sizeBucket + 14;
    if (w <= 0 || h <= 0 || w > 512 || h > 128) return null;
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.ceil(w * DMG_SS));
    c.height = Math.max(1, Math.ceil(h * DMG_SS));
    const g = c.getContext('2d');
    g.scale(DMG_SS, DMG_SS);
    g.font = font;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.lineWidth = 4;
    g.lineJoin = 'round';
    g.strokeStyle = 'rgba(0, 0, 0, 0.9)';
    g.strokeText(text, w / 2, h / 2);
    g.fillStyle = color;
    g.fillText(text, w / 2, h / 2);
    rec = { c, w, h };
    _dmgSprites.set(key, rec);
    return rec;
  } catch (_) {
    return null;
  }
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
  // Minimal post detail: skip the invert reads entirely. The orange gameplay
  // tint (Game.js, driven by curTint/curFlash) still renders, so the Deadeye
  // beat keeps its warmth with none of the fullscreen difference cost.
  if (_postDetail >= 2) return false;
  const w = canvas.width, h = canvas.height;
  if (!w || !h) return false;

  ctx.save();
  // Identity: the post-process works in raw canvas pixels, not world space.
  ctx.setTransform(1, 0, 0, 1, 0, 0);

  const amt = Math.min(1, s.curInvert);
  if (_postDetail >= 1) {
    // Simplified: difference + single warm fill (2 passes instead of 3).
    // Slightly stronger orange in one coat approximates white+orange overdraw.
    ctx.globalCompositeOperation = 'difference';
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = Math.min(1, (1 - amt) + amt * INVERT_ORANGE);
    ctx.fillStyle = '#ffd9a8';
    ctx.fillRect(0, 0, w, h);
    ctx.globalAlpha = 1;
  } else {
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
  }

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
