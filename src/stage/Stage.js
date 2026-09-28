// Stage.js — stage definitions, platform layout, blast zones, ground/platform
// collision resolution, and the Sandbox's own authored-environment builder.
//
// It is one module because a stage IS one thing: the competitive map and the
// sandbox arena are both "a platform list, blast zones, a respawn point and
// spawn points", and the sandbox half reuses the same BLAST_MARGIN, the same
// record shape the camera and the collision pass already consume, and the same
// destructible registry. Keeping them together means the sandbox can never
// drift from the layout constants the match depends on.
//
// Nothing in the Sandbox section below reads or writes `createDefaultStage()`'s
// result, and nothing in the main match reads a sandbox object. The sandbox gets
// its own stage record, platform list, spawn points, blast zones, camera framing
// and localStorage keys — so editing a board, resizing the floor or recolouring
// the background can never reach the competitive map, and starting a match can
// never reach the sandbox.

// Match pacing (2026-09): tighter blast zones pair with the reduced
// damage (×0.40) / knockback (×0.50) so AIvsAI KOs land in the 20–50s window
// (fast ~20s, normal ~30–40s, long ~40–50s) instead of 1–3 minute grinds.
// Attacks/combos/recovery all still have room to breathe — the stage is just
// less forgiving far off-stage.
// Match pacing with the §45 0.83s attack lock: slightly tighter blast zones
// keep stock finishes in a reasonable window without touching the fixed
// damage/knockback multipliers.
export const BLAST_MARGIN = 60; // pixels beyond the visible stage for the blast zones

// Only the Sandbox section below touches destructibles, but the import is hoisted
// with the rest of the module graph. The chain is one-way and acyclic:
// Stage.js -> stage/sandbox/destructible.js -> Engine.js -> worldFx.js.
import {
  DESTRUCTIBLE_KINDS,
  destructibleKind,
  createDestructible,
  registerDestructible,
  clearDestructibles,
} from './sandbox/destructible.js';

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
        // Touching the ground recharges aerial-light recovery (same rule as
        // the double jump — one use per airtime, see Fighter.js).
        fighter.canUseAerialLightRecovery = true;
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
        // Touching the ground recharges aerial-light recovery (same rule as
        // the double jump — one use per airtime, see Fighter.js).
        fighter.canUseAerialLightRecovery = true;
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
// `view` is an optional {x0,y0,x1,y1} world-space visible rect: platforms fully
// outside it are skipped (Game.js passes the camera-derived rect; editors pass
// nothing and draw everything as before).
export function drawStage(ctx, stage, time, platformColorOverride = null, view = null) {
  const hasView = !!(view && Number.isFinite(view.x0));
  for (const plat of stage.platforms) {
    // Breakables live in the same platform list (that is what makes them
    // standable and collidable through the real system), but they have their
    // own art in stage/sandbox/destructible.js — cracks, a durability read, a break
    // effect. Skipping them here keeps one painter per object.
    if (plat.destructible) continue;
    if (hasView) {
      if (plat.x > view.x1 || plat.x + plat.width < view.x0 ||
          plat.y > view.y1 || plat.y + plat.height < view.y0) continue;
    }
    // Platform shadow. Note: fill-only, so no strokeStyle/lineWidth here (the
    // body pass below sets the stroke state it needs itself).
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
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

    // Platform body — use custom color if provided, otherwise default gradient
    if (platformColorOverride) {
      // Create a simple gradient based on the custom color
      if (!plat._customGradient || plat._customColor !== platformColorOverride) {
        const gy = plat.baseY ?? plat.y;
        plat._customGradient = ctx.createLinearGradient(plat.x, gy, plat.x, gy + plat.height);
        // Lighten/darken the custom color for gradient effect
        const c = platformColorOverride;
        // Parse hex color
        let r = 0, g = 0, b = 0;
        if (c.startsWith('#')) {
          const hex = c.slice(1);
          if (hex.length === 6) {
            r = parseInt(hex.slice(0, 2), 16);
            g = parseInt(hex.slice(2, 4), 16);
            b = parseInt(hex.slice(4, 6), 16);
          } else if (hex.length === 3) {
            r = parseInt(hex[0] + hex[0], 16);
            g = parseInt(hex[1] + hex[1], 16);
            b = parseInt(hex[2] + hex[2], 16);
          }
        }
        const lighten = (val) => Math.min(255, Math.floor(val * 1.3));
        const darken = (val) => Math.max(0, Math.floor(val * 0.7));
        const lightColor = `rgb(${lighten(r)}, ${lighten(g)}, ${lighten(b)})`;
        const darkColor = `rgb(${darken(r)}, ${darken(g)}, ${darken(b)})`;
        plat._customGradient.addColorStop(0, lightColor);
        plat._customGradient.addColorStop(1, darkColor);
        plat._customColor = platformColorOverride;
      }
      ctx.fillStyle = plat._customGradient;
    } else {
      // Default gradient
      if (!plat._gradient) {
        const gy = plat.baseY ?? plat.y;
        plat._gradient = ctx.createLinearGradient(plat.x, gy, plat.x, gy + plat.height);
        plat._gradient.addColorStop(0, '#3a3a3a');
        plat._gradient.addColorStop(1, '#1c1c1c');
      }
      ctx.fillStyle = plat._gradient;
    }

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

// ═══════════════════════════════════════════════════════════════════════
// SANDBOX ENVIRONMENT
// ═══════════════════════════════════════════════════════════════════════
// The Sandbox's own environment, isolated from the main map. The stage it
// produces is the SAME shape the camera and the collision pass already consume
// (platforms / blastZones / respawnPoint / spawnPoints), which is why a sandbox
// arena is walked by the real systems rather than by a parallel set of them.

const ENV_KEY = 'smashfighters.sandboxEnv';
const DOC_KEY = 'smashfighters.sandboxDoc';

// ── Platform / environment types ─────────────────────────────────────────
// Each type maps onto a capability Stage.js already has — solid vs one-way
// (canDropThrough) and bobbing (bobSpeed/bobAmp) — so "add a different platform
// type" is picking an entry here, never writing new collision code.
export const PLATFORM_TYPES = [
  { id: 'solid', name: 'SOLID BLOCK', w: 220, h: 24, canDropThrough: false, bob: false, color: '#3a5a3a' },
  { id: 'oneway', name: 'ONE-WAY', w: 200, h: 14, canDropThrough: true, bob: false, color: '#4a7a4a' },
  { id: 'floating', name: 'FLOATING', w: 180, h: 14, canDropThrough: true, bob: true, color: '#4a7a4a' },
  { id: 'slim', name: 'SLIM LEDGE', w: 130, h: 12, canDropThrough: true, bob: false, color: '#54684f' },
  { id: 'pillar', name: 'PILLAR', w: 44, h: 300, canDropThrough: false, bob: false, color: '#3d4f5a' },
];

const TYPE_BY_ID = {};
for (const t of PLATFORM_TYPES) TYPE_BY_ID[t.id] = t;

export function platformType(typeId) {
  return TYPE_BY_ID[typeId] || TYPE_BY_ID.solid;
}

export const BACKGROUND_PRESETS = [
  { id: 'void', name: 'VOID', color: '#101010', grid: '#1e1e1e' },
  { id: 'ink', name: 'INK', color: '#141824', grid: '#232a3a' },
  { id: 'slate', name: 'SLATE', color: '#181818', grid: '#262626' },
  { id: 'sepia', name: 'SEPIA', color: '#1a1610', grid: '#2b2418' },
  { id: 'deep', name: 'DEEP', color: '#0c1014', grid: '#18222a' },
];

export function backgroundPreset(presetId) {
  return BACKGROUND_PRESETS.find((p) => p.id === presetId) || BACKGROUND_PRESETS[0];
}

export const MAX_SANDBOX_FIGHTERS = 4;

// ── Environment ──────────────────────────────────────────────────────────
// The editable environment settings. Persisted under its own key so the map
// settings object the match uses is never touched.
export function defaultSandboxEnv(width, height) {
  const preset = BACKGROUND_PRESETS[0];
  return {
    background: preset.id,
    backgroundColor: preset.color,
    gridColor: preset.grid,
    showGrid: true,
    gridSize: 40,
    platformColor: '#4a7a4a',
    cameraBounds: true,
  };
}

export function loadSandboxEnv() {
  try {
    const raw = localStorage.getItem(ENV_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    return { ...defaultSandboxEnv(1200, 1100), ...parsed };
  } catch (_) {
    return null;
  }
}

export function saveSandboxEnv(env) {
  try { localStorage.setItem(ENV_KEY, JSON.stringify(env)); } catch (_) {}
}

export function loadSandboxDoc() {
  try {
    const raw = localStorage.getItem(DOC_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.objects)) return null;
    return parsed;
  } catch (_) {
    return null;
  }
}

export function saveSandboxDoc(doc) {
  try { localStorage.setItem(DOC_KEY, JSON.stringify(doc)); } catch (_) {}
}

// A blank arena with a floor to build on: one ground platform wide enough to
// stand on, and two spawn points above it.
export function defaultSandboxObjects(width, height) {
  const groundY = Math.round(height * 0.78);
  const groundW = Math.round(width * 0.7);
  return [
    {
      id: 'p1', type: 'platform', typeId: 'solid', x: Math.round((width - groundW) / 2),
      y: groundY, width: groundW, height: 24, isGround: true,
    },
    { id: 'e1', type: 'entity', charId: 'cowboy', control: 'human', x: Math.round(width * 0.4), y: groundY - 60 },
    { id: 'e2', type: 'entity', charId: 'ninja', control: 'bot', x: Math.round(width * 0.6), y: groundY - 60 },
  ];
}

// ── Stage construction ───────────────────────────────────────────────────
// Creates the sandbox's stage record. Its own object every time, so a fresh
// play session always starts from the document rather than from leftovers.
export function createSandboxStage(env, width, height) {
  const stage = {
    name: 'Sandbox',
    platforms: [],
    blastZones: {
      left: -BLAST_MARGIN,
      right: width + BLAST_MARGIN,
      top: -BLAST_MARGIN * 1.5,
      bottom: height + BLAST_MARGIN,
    },
    respawnPoint: { x: width / 2, y: height * 0.78 - 120 },
    spawnPoints: [],
    // Sandbox-only camera framing. The main map has no `cameraFraming` key at
    // all, so Engine.js' framing is byte-for-byte unchanged for a match — here
    // it tells the camera to keep a variable roster in frame (the main camera
    // only knows how to frame exactly two, and pushes in for any other count)
    // and to pan inside the authored arena instead of the ground-platform guess.
    cameraFraming: {
      fitAnyRoster: true,
      minZoom: 0.55,
      maxZoom: 1.05,
      pan: { left: 0, right: width, top: 0, bottom: height * 0.9 },
    },
  };
  clearDestructibles();
  stage.platforms.length = 0;
  stage.spawnPoints.length = 0;
  applySandboxObjects(stage, [], width, height, env);
  return stage;
}

// Rebuild a sandbox stage's contents from an editor document. Called when play
// starts (a fresh copy of the document every time) and by the editor whenever
// the document changes shape. Destructibles are created here, so the play
// session always starts with full durability.
export function applySandboxObjects(stage, objects, width, height, env) {
  clearDestructibles();
  stage.platforms.length = 0;
  stage.spawnPoints.length = 0;

  for (let i = 0; i < objects.length; i++) {
    const o = objects[i];
    if (!o) continue;
    if (o.type === 'platform') stage.platforms.push(makePlatform(o));
    else if (o.type === 'destructible') {
      const d = makeDestructible(o);
      if (d) { stage.platforms.push(d); registerDestructible(d); d.stage = stage; }
    }
    else if (o.type === 'entity') stage.spawnPoints.push({ x: o.x, y: o.y });
  }

  // The camera's off-stage cut and pan clamps are measured from the first
  // `isGround` platform. If the author never placed one, the widest solid block
  // stands in, so the camera still has a stage to frame.
  if (!hasGround(stage) && stage.platforms.length) {
    let widest = stage.platforms[0];
    for (let i = 1; i < stage.platforms.length; i++) {
      if (stage.platforms[i].width > widest.width) widest = stage.platforms[i];
    }
    widest.isGround = true;
  }

  if (!stage.spawnPoints.length) {
    stage.spawnPoints.push({ x: width / 2, y: height * 0.7 }, { x: width / 2, y: height * 0.7 });
  }
  stage.respawnPoint = { x: stage.spawnPoints[0].x, y: stage.spawnPoints[0].y };
  if (env) applyEnvToStage(stage, env, width, height);
  return stage;
}

function hasGround(stage) {
  for (let i = 0; i < stage.platforms.length; i++) {
    if (stage.platforms[i].isGround) return true;
  }
  return false;
}

function makePlatform(o) {
  const t = platformType(o.typeId);
  const p = {
    x: o.x, y: o.y, baseY: o.y,
    width: o.width ?? t.w,
    height: o.height ?? t.h,
    isGround: !!o.isGround,
    canDropThrough: o.isGround ? false : t.canDropThrough,
    color: o.color || t.color,
    destructible: false,
  };
  if (t.bob) {
    // Gentle bob, same shape the default stage's floating platform uses.
    p.bobSpeed = 1.0;
    p.bobAmp = 3;
    p.bobPhase = 0;
  }
  return p;
}

function makeDestructible(o) {
  const kind = destructibleKind(o.kindId);
  return createDestructible(o.kindId, {
    id: o.id,
    x: o.x,
    y: o.y,
    width: o.width ?? kind.w,
    height: o.height ?? kind.h,
    hp: o.hp ?? kind.hp,
  });
}

// The blast zones and camera pan follow the arena box, so a tall or wide
// authored arena is fully playable; a plain 1200×1100 arena gets the same
// margins the main stage uses.
export function applyEnvToStage(stage, env, width, height) {
  const preset = backgroundPreset(env.background);
  stage.name = 'Sandbox';
  stage.blastZones.left = -BLAST_MARGIN;
  stage.blastZones.right = width + BLAST_MARGIN;
  stage.blastZones.top = -BLAST_MARGIN * 1.5;
  stage.blastZones.bottom = height + BLAST_MARGIN;
  stage.cameraFraming.fitAnyRoster = true;
  stage.cameraFraming.pan.left = 0;
  stage.cameraFraming.pan.right = width;
  stage.cameraFraming.pan.top = 0;
  stage.cameraFraming.pan.bottom = height * 0.9;
  if (env.cameraBounds === false) stage.cameraFraming.pan = null;
  stage.background = { color: env.backgroundColor || preset.color, gridColor: env.gridColor || preset.grid };
}

// ── Background ───────────────────────────────────────────────────────────
// The arena backdrop is a static, one-time offscreen render (a flat fill plus a
// grid) — there is nothing to animate, so re-painting it every frame would be
// pure waste. Rebuilt only when the environment settings change.
let _bgCanvas = null;
let _bgKey = '';

export function sandboxBackground(env, width, height) {
  const key = `${env.backgroundColor}|${env.gridColor}|${env.showGrid ? env.gridSize : 0}|${width}x${height}`;
  if (_bgCanvas && _bgKey === key) return _bgCanvas;
  const preset = backgroundPreset(env.background);
  const c = document.createElement('canvas');
  c.width = width;
  c.height = height;
  const g = c.getContext('2d');
  g.fillStyle = env.backgroundColor || preset.color;
  g.fillRect(0, 0, width, height);
  if (env.showGrid) {
    const step = Math.max(10, env.gridSize || 40);
    g.strokeStyle = env.gridColor || preset.grid;
    g.lineWidth = 1;
    g.beginPath();
    for (let x = step; x < width; x += step) { g.moveTo(x + 0.5, 0); g.lineTo(x + 0.5, height); }
    for (let y = step; y < height; y += step) { g.moveTo(0, y + 0.5); g.lineTo(width, y + 0.5); }
    g.stroke();
  }
  _bgCanvas = c;
  _bgKey = key;
  return c;
}

export function invalidateSandboxBackground() {
  _bgCanvas = null;
  _bgKey = '';
}

// Total count of breakable objects in a document (used by the editor's status
// line and by the play session's roster cap check).
export function countDestructibles(objects) {
  let n = 0;
  for (let i = 0; i < objects.length; i++) if (objects[i] && objects[i].type === 'destructible') n++;
  return n;
}

export function countEntities(objects) {
  let n = 0;
  for (let i = 0; i < objects.length; i++) if (objects[i] && objects[i].type === 'entity') n++;
  return n;
}

export { DESTRUCTIBLE_KINDS };
