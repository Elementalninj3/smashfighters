// Stage.js — stage definitions, platform layout, blast zones, and
// ground/platform collision resolution.

export const BLAST_MARGIN = 150; // pixels beyond the visible stage for the blast zones

export function createDefaultStage(canvasWidth, canvasHeight) {
  const groundY = canvasHeight * 0.78;
  const groundWidth = canvasWidth * 0.65;
  const groundX = (canvasWidth - groundWidth) / 2;
  const platformWidth = canvasWidth * 0.14;
  const platformHeight = 12;
  const platY1 = groundY - 140;

  return {
    name: 'Battlefield',
    platforms: [
      // Main ground
      {
        x: groundX,
        y: groundY,
        width: groundWidth,
        height: 16,
        isGround: true,
        canDropThrough: false,
        color: '#3a5a3a',
      },
      // Single center floating platform (same normal-platform rules as the floor)
      {
        x: canvasWidth / 2 - platformWidth / 2,
        baseY: platY1,
        y: platY1,
        width: platformWidth,
        height: platformHeight,
        isGround: false,
        canDropThrough: true,
        color: '#4a7a4a',
        bobSpeed: 1.0,
        bobAmp: 3,
        bobPhase: 0,
      },
    ],
    blastZones: {
      left: -BLAST_MARGIN,
      right: canvasWidth + BLAST_MARGIN,
      top: -BLAST_MARGIN * 1.5,
      bottom: canvasHeight + BLAST_MARGIN,
    },
    respawnPoint: { x: canvasWidth / 2, y: groundY - 120 },
    spawnPoints: [
      { x: canvasWidth * 0.35, y: groundY },
      { x: canvasWidth * 0.65, y: groundY },
    ],
  };
}

// Animate floating platforms with gentle bobbing
export function updatePlatforms(stage, time) {
  for (const plat of stage.platforms) {
    if (plat.bobSpeed) {
      plat.y = plat.baseY + Math.sin(time * 0.001 * plat.bobSpeed + plat.bobPhase) * plat.bobAmp;
    }
  }
}

// Check if a fighter's circle overlaps a platform from above.
// Uses previous-position detection for one-way platforms to prevent jitter.
export function resolvePlatformCollision(fighter, platform) {
  const radius = fighter.radius;
  const fx = fighter.x;
  const fy = fighter.y;

  // Check if fighter center is within platform horizontal bounds (with some margin)
  const inHorizontal = fx + radius * 0.6 > platform.x && fx - radius * 0.6 < platform.x + platform.width;

  if (!inHorizontal) return false;

  // Per-player drop-through ignore: skip the platform the fighter is actively dropping through
  if (fighter.dropThroughPlatform === platform) {
    // Restore collision once the fighter's feet are clearly below the platform top
    const fighterBottom = fy + radius;
    if (fighterBottom > platform.y + 18) {
      fighter.dropThroughPlatform = null;
    }
    return false;
  }

  // Top collision: fighter falling onto platform from above
  if (fighter.vy >= 0) {
    const fighterBottom = fy + radius;
    const prevBottom = fighter._prevBottomY || fighterBottom;
    const platformTop = platform.y;

    if (platform.canDropThrough) {
      // One-way platform: only catch if the fighter crossed the platform top this frame
      // Previous bottom was above (or very near) platform top AND current bottom is at/below
      if (prevBottom <= platformTop + 4 && fighterBottom >= platformTop - 2) {
        // Drop-through check: if fighter wants to drop through, skip this collision
        if (fighter.wantsToDropThrough) {
          fighter.dropThroughPlatform = platform;
          return false;
        }
        fighter.y = platformTop - radius;
        fighter.vy = 0;
        fighter.grounded = true;
        fighter.groundPlatform = platform;
        fighter.groundType = 'platform';
        fighter.canDoubleJump = true;
        fighter.jumpsUsed = 0;
        fighter.freeFall = false;
        fighter.dropThroughPlatform = null;
        return true;
      }
    } else {
      // Solid platform (main ground): catch if fighter crossed the platform top this frame
      if (prevBottom <= platformTop + 8 && fighterBottom >= platformTop - 2) {
        fighter.y = platformTop - radius;
        fighter.vy = 0;
        fighter.grounded = true;
        fighter.groundPlatform = platform;
        fighter.groundType = 'main';
        fighter.canDoubleJump = true;
        fighter.jumpsUsed = 0;
        fighter.freeFall = false;
        fighter.dropThroughPlatform = null;
        return true;
      }
    }
  }

  // Bottom collision: fighter jumping through from below
  if (fighter.vy < 0 && platform.canDropThrough) {
    return false;
  }

  // Bottom collision: solid platform from below
  if (!platform.canDropThrough && fighter.vy < 0) {
    const fighterTop = fy - radius;
    const platformBottom = platform.y + platform.height;

    if (fighterTop <= platformBottom && fighterTop >= platformBottom - 10) {
      fighter.y = platformBottom + radius;
      fighter.vy = Math.max(0, fighter.vy);
      return true;
    }
  }

  return false;
}

// Draw the stage — every platform (main floor included) is drawn the same way:
// a plain dark terminal block, no edge markers, no special hitbox indicators.
export function drawStage(ctx, stage, time) {
  for (const plat of stage.platforms) {
    // Platform shadow
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.strokeStyle = '#111111';
    ctx.lineWidth = 3;
    const r = 6;
    ctx.beginPath();
    ctx.moveTo(plat.x + r + 4, plat.y + 4);
    ctx.lineTo(plat.x + plat.width - r + 4, plat.y + 4);
    ctx.quadraticCurveTo(plat.x + plat.width + 4, plat.y + 4, plat.x + plat.width + 4, plat.y + r + 4);
    ctx.lineTo(plat.x + plat.width + 4, plat.y + plat.height + 4);
    ctx.lineTo(plat.x + 4, plat.y + plat.height + 4);
    ctx.lineTo(plat.x + 4, plat.y + r + 4);
    ctx.quadraticCurveTo(plat.x + 4, plat.y + 4, plat.x + r + 4, plat.y + 4);
    ctx.closePath();
    ctx.fill();

    // Platform body — dark terminal block. The gradient is cached per platform
    // (anchored to baseY when the platform bobs, so it never needs rebuilding).
    if (!plat._gradient) {
      const gy = plat.baseY ?? plat.y;
      plat._gradient = ctx.createLinearGradient(plat.x, gy, plat.x, gy + plat.height);
      plat._gradient.addColorStop(0, '#3a3a3a');
      plat._gradient.addColorStop(1, '#1c1c1c');
    }
    ctx.fillStyle = plat._gradient;

    // Rounded rect with outline
    ctx.beginPath();
    ctx.moveTo(plat.x + r, plat.y);
    ctx.lineTo(plat.x + plat.width - r, plat.y);
    ctx.quadraticCurveTo(plat.x + plat.width, plat.y, plat.x + plat.width, plat.y + r);
    ctx.lineTo(plat.x + plat.width, plat.y + plat.height);
    ctx.lineTo(plat.x, plat.y + plat.height);
    ctx.lineTo(plat.x, plat.y + r);
    ctx.quadraticCurveTo(plat.x, plat.y, plat.x + r, plat.y);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = '#111111';
    ctx.lineWidth = 3;
    ctx.stroke();

    // Platform top highlight
    ctx.strokeStyle = 'rgba(243,234,209,0.45)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(plat.x + r + 2, plat.y + 2);
    ctx.lineTo(plat.x + plat.width - r - 2, plat.y + 2);
    ctx.stroke();
  }
}

// Check if a fighter is outside the blast zones
export function isInBlastZone(fighter, stage) {
  const bz = stage.blastZones;
  if (fighter.x < bz.left) return 'left';
  if (fighter.x > bz.right) return 'right';
  if (fighter.y > bz.bottom) return 'bottom';
  if (fighter.y < bz.top) return 'top';
  return null;
}
