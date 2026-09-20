// cowboy-al.js — converted muzzle-fire preset art. Three stateless draw effects:
//   bullet — one bright bullet tracer + muzzle flash (single shot)
//   spray  — fan of short spark flecks + heat embers (loose muzzle spray)
//   blast  — core flash + extended cone shockwave ring + tracer fan (big hit)
//
// Contract (see gemini-vfx-prompts.txt): draw(ctx, v, p) is a pure function of
// v.progress. All motion comes from progress; rotation is authored in degrees;
// v.scale scales the whole thing; v.color overrides the primary color.
// Transform order is translate → scale(mirrorX) → rotate: the horizontal flip of
// local +x is rotated into the correct mirrored bearing, so a left-facing blast
// fires down-left instead of up-left. v.mirrorX is set by the game's
// updateFighterVfx; editor preview always faces right.

export const VFX_EFFECTS = {
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
      const easeOutExpo = t => (t === 1 ? 1 : 1 - Math.pow(2, -10 * t));

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
      const easeOutQuad = t => t * (2 - t);

      ctx.globalCompositeOperation = 'lighter';

      // Spark flecks fanning out along +x.
      ctx.save();
      ctx.globalAlpha = Math.max(0, 1 - prog);
      ctx.strokeStyle = '#ffdd44';
      ctx.lineWidth = 2.0;
      ctx.lineCap = 'round';
      const sparkSeeds = [-0.65, -0.42, -0.2, -0.02, 0.16, 0.38, 0.6];
      sparkSeeds.forEach((angle, i) => {
        const speedMult = 1 + ((i * 37) % 5) * 0.2;
        const startDist = easeOutQuad(prog) * 75 * speedMult;
        const sparkLen = (1 - prog) * 24;
        const endDist = startDist + sparkLen;
        ctx.beginPath();
        ctx.moveTo(Math.cos(angle) * startDist, Math.sin(angle) * startDist);
        ctx.lineTo(Math.cos(angle) * endDist, Math.sin(angle) * endDist);
        ctx.stroke();
      });
      ctx.lineCap = 'butt';
      ctx.restore();

      // Heat embers drifting up from the muzzle.
      if (prog > 0.15) {
        const emberProg = (prog - 0.15) / 0.85;
        ctx.save();
        ctx.globalAlpha = (1 - emberProg) * 0.85;
        ctx.fillStyle = '#ff4400';
        const embers = [-0.4, -0.14, 0.08, 0.32];
        embers.forEach((angle, i) => {
          const dist = easeOutQuad(emberProg) * (65 + i * 16);
          const ex = Math.cos(angle) * dist;
          const ey = Math.sin(angle) * dist + emberProg * -6;
          const size = Math.max(0.5, (1 - emberProg) * 3);
          ctx.beginPath();
          ctx.arc(ex, ey, size, 0, Math.PI * 2);
          ctx.fill();
        });
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

      const easeOutQuad = t => t * (2 - t);
      const easeOutExpo = t => (t === 1 ? 1 : 1 - Math.pow(2, -10 * t));

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
      const mainTracers = [
        { angle: -0.5, len: 110, w: 3.5, color: '#ffffff' },
        { angle: -0.28, len: 140, w: 4.5, color: mainColor },
        { angle: -0.08, len: 165, w: 5.5, color: '#ffffff' },
        { angle: 0.08, len: 160, w: 5.5, color: '#ffffff' },
        { angle: 0.28, len: 135, w: 4.5, color: mainColor },
        { angle: 0.5, len: 105, w: 3.5, color: '#ffffff' },
      ];
      mainTracers.forEach(t => {
        const headProgress = easeOutExpo(prog);
        const tailProgress = easeOutQuad(prog * 0.8);
        const startDist = tailProgress * t.len;
        const endDist = headProgress * t.len;
        const x1 = Math.cos(t.angle) * startDist;
        const y1 = Math.sin(t.angle) * startDist;
        const x2 = Math.cos(t.angle) * endDist;
        const y2 = Math.sin(t.angle) * endDist;
        ctx.strokeStyle = t.color;
        ctx.lineWidth = t.w * (1 - prog * 0.4);
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();
      });
      ctx.lineCap = 'butt';
      ctx.restore();

      // 4. Spark Flecks.
      ctx.save();
      ctx.globalAlpha = Math.max(0, 1 - prog);
      ctx.strokeStyle = '#ffdd44';
      ctx.lineWidth = 2.0;
      ctx.lineCap = 'round';
      const sparkSeeds = [-0.6, -0.4, -0.18, -0.02, 0.15, 0.35, 0.55];
      sparkSeeds.forEach((angle, i) => {
        const speedMult = 1 + ((i * 37) % 5) * 0.2;
        const startDist = easeOutQuad(prog) * 80 * speedMult;
        const sparkLen = (1 - prog) * 25;
        const endDist = startDist + sparkLen;
        const x1 = Math.cos(angle) * startDist;
        const y1 = Math.sin(angle) * startDist;
        const x2 = Math.cos(angle) * endDist;
        const y2 = Math.sin(angle) * endDist;
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();
      });
      ctx.lineCap = 'butt';
      ctx.restore();

      // 5. Heat Embers.
      if (prog > 0.15) {
        const emberProg = (prog - 0.15) / 0.85;
        ctx.save();
        ctx.globalAlpha = (1 - emberProg) * 0.85;
        ctx.fillStyle = '#ff4400';
        const embers = [-0.35, -0.12, 0.06, 0.3];
        embers.forEach((angle, i) => {
          const dist = easeOutQuad(emberProg) * (70 + i * 18);
          const ex = Math.cos(angle) * dist;
          const ey = Math.sin(angle) * dist + emberProg * -6;
          const size = Math.max(0.5, (1 - emberProg) * 3);
          ctx.beginPath();
          ctx.arc(ex, ey, size, 0, Math.PI * 2);
          ctx.fill();
        });
        ctx.restore();
      }

      ctx.restore();
    },
  },
};

// Usage:
//   vfxManager.play('bullet' | 'spray' | 'blast', x, y, { scale, rotation: angleDeg, duration });