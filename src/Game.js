import { AIController, AI_DIFFICULTIES, configForDifficulty, createTrainer, evaluateModels, loadTrainedModel, listTrainedModels, listModels, getModel, getActiveModel, activateModel, renameModel, duplicateModel, deleteModel, exportModel, importModel, attachEval, listRunHistory, getRun, clearRunHistory, loadCheckpoint, computeFitnessBreakdown } from './ai.js';
import { allWeapons, getWeapon, setAnimationLoader, updateAnimator, attachAnimator, getAnimation, setAnimLibChangeListener } from './anim.js';
import { SFX } from './assets.js';
import { stepRosterMovement, stepRosterCombat, stepRosterFinish, softResetFighter, inputForSlot, DUMMY_INPUT, resolveFighterSkin, drawCombatDebug, resetCombat, removeAttackerHitboxes, clearHitLocks, clearDeadeye, clearBoxerState, __debugHitboxes, startAttackForKey, resolveAttackDef, setCombatStage, ALL_FIGHTERS, setCustomHitboxes, clearCustomHitboxes, drawTreasures, drawGoldOrbUnder, drawDigShovel } from './combat.js';
import { openEditor, closeEditor, updateEditor, renderEditor, setEditorCloseHandler, openHitboxCustomizer, closeHitboxCustomizer, updateHitboxCustomizer, renderHitboxCustomizer, setHitboxCustomizerCloseHandler, setCustomizerMove, setWorkingBoxValue, saveCustomizer, resetCustomizerMove, getWorkingBoxes, isHitboxCustomizerOpen, hitboxCustomizerHits } from './editors.js';
import { drawFighterVfx, setVfxViewBounds, warmEffectSprites, stepTimeDilation, timeDilationState, peekTimeDilation, resetTimeDilation, drawTimeDilationPost, updateDamageIndicators, drawDamageIndicators, resetDamageIndicators, updateWorldFx, drawWorldFx, resetWorldFx, setWorldFxViewBounds, setFxQuality, setParticleDetail, setPostDetail, setWorldFxBatch, setDamageTextCache, worldFxState } from './fx.js';
import { initInput, flushInput, isJustPressed, createFighter, createDefaultStage, drawStage, updatePlatforms, isInBlastZone, onLoopQualityChange, setDestructibleViewBounds, clearDestructibleViewBounds, sanitizeDeathZone, applyDeathZoneToStage, blastRectFor, DEFAULT_DEATH_MARGINS, DEATHZONE_MIN, DEATHZONE_MAX, DEATHZONE_STEP } from './physics.js';
import { updateCamera, applyCameraTransform, resetCamera, snapCameraToFit, updateCameraZoom, updateMatchZoom, getCameraState, getCameraStateInto, worldToScreen, VIEW_W, VIEW_H, syncCanvasBacking, backingScaleFor, setRenderScale, getSkinImage, drawFighter, drawAbilityFx, drawHorse, drawBoxerRollUnder, drawHeldLayer, holdCoversSide, handConfig, resolveHandColor, setViewBounds, setEffectBatch, warmFighterSprites, warmFighterArt, saveRig, clearRig, resolveHeld, resolveHoldSlot, orbitHandPose, orbitFrontSide, orbitTarget, resolveOrbitRig, resolveSkinMeta, updateCinematic, drawCinematicWorld, cinematicTint, resetCinematic, notifyCinematicKO, ACCESSORIES, accessoryName, loadAccessoryFor, saveAccessoryFor, cloneAccessory, drawAccessory, tickSkinImageRetries, handGearName, loadHandGearFor, saveHandGearSetFor, defaultHandGear, defaultGearIdFor, drawHandGear } from './render.js';
import { openSandboxEditor, closeSandboxEditor, updateSandboxEditor, renderSandboxEditor, isSandboxEditorOpen, getSandboxDocument, setSandboxArenaSize, startSandboxSession, stopSandboxSession, updateSandboxSession, renderSandboxSession, isSandboxPlaying, toggleSandboxPause, isSandboxPaused, setSandboxTimeScale, getSandboxTimeScale, toggleSandboxDebug, getSandboxRoster, getSandboxStage, getSandboxSessionCount } from './sandbox.js';


// ── merged from Game.js ──
// Game.js â€” movement arena orchestrator + simplified terminal start menu.
// Two human fighters share the arena, move/jump/dash/dodge freely, and fight
// with the data-driven attack system in combat.js (light=J, heavy=K). Damage
// is a percent meter â€” no stocks, no stocks, soft blast-zone respawn only.
//
// The terminal overlay in index.html handles selection: pick a fighter, fit the
// skin to the circle (SKIN SIZE), wear accessories, then START FREE PLAY.


const MONO = 'Consolas, "Courier New", monospace';

// Pre-computed canvas strings â€” avoids per-frame string allocation.
const _fontFps = `12px ${MONO}`;
const _fontHealth = `10px ${MONO}`;
const _fillBgDim = 'rgba(0, 0, 0, 0.5)';
const _fillFpsShadow = 'rgba(0,0,0,0.55)';
const _fillFpsGreen = '#33ff88';
const _fillHealthP1 = '#4a9eff';
const _fillHealthP2 = '#ff4a4a';

// Game state
let canvas = null;
let ctx = null;
// Logical viewport: always exactly 1080 × 1080 (see render.js).
// Sharpness comes from the DPR-scaled backing store, not from a larger
// logical size — world coordinates, physics, hitboxes and character sizes
// are unchanged, only the camera framing adapts to the square format.
// The ARENA (playable world) is wider than tall-vista: same 1080 width, but
// extended downward so there is real fall space below the stage. The stage
// layout itself stays anchored to the top 1080 (ground/platform/spawns exactly
// where they always were); only the pit + bottom KO line move down.
const ARENA_W = VIEW_W;
const ARENA_H = 1400;
let arena = { width: ARENA_W, height: ARENA_H };
let stage = null;
let fighter1 = null;
let fighter2 = null;
let isPaused = false;
// In-match damage panel: always visible during play (screen space, outside
// the camera viewport). T focuses it for editing and freezes the sim like a
// pause; type digits to set an exact percent, or nudge with arrows.
let tweakEditing = false;
let tweakCursor = 0;
let tweakDraft = '';
let currentGameState = 'menu'; // 'menu' | 'animator' | 'hitboxes' | 'sandbox' | 'sandboxPlay' | 'ready' | 'playing'
let gameMode = 'playerVsPlayer'; // 'playerVsPlayer', 'playerVsDummy', 'playerVsAI', 'AIvsAI'
let aiControllers = [null, null]; // AI controllers for fighter 1 and 2

// â”€â”€ Stock match state (Â§42: NO timer, NO time limit, NO timeout) â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Stocks are decided in the menu (matchSettings.stocks, 1â€“5). Each blast-zone
// fall costs one stock and respawns the fighter at 0%; losing the last stock
// eliminates the fighter and ends the match. matchWinner: null = live, 1/2 =
// winner, 0 = draw. matchElapsed feeds the display-only stopwatch; nothing
// in gameplay reads it.
let matchOver = false;
let matchWinner = null;
let matchElapsed = 0; // real seconds since match start — stopwatch source only
let matchOverAge = 0;
// Match-ending camera zoom starts only after the deciding-KO disappearance +
// KO pillar (see onBlastKO sequence). matchOver flips immediately; the camera
// layers wait for this delay so the pillar is visible before the push-in.
const MATCH_ZOOM_DELAY = 0.45;
function cameraMatchOver() {
  return matchOver && matchOverAge >= MATCH_ZOOM_DELAY;
}

// Hitbox debug visualization
let showHitboxes = false;

// Pre-rendered background â€” static, drawn once, blitted every frame.
let _gridCanvas = null;

// Map appearance settings (persisted in localStorage)
const MAP_SETTINGS_KEY = 'smashfighters.mapSettings';

// The arena's default backdrop. Light sky blue, so it reads as open sky behind
// the stage rather than the old black void.
const DEFAULT_BACKGROUND_COLOR = '#87CEFA';
// The previous default. A save that still holds this exact value was never a
// deliberate pick by the player â€” it was just the old default being persisted â€”
// so it is migrated to the new default instead of pinning them to black forever.
const LEGACY_DEFAULT_BACKGROUND_COLOR = '#000000';

let mapSettings = (() => {
  try {
    const saved = JSON.parse(localStorage.getItem(MAP_SETTINGS_KEY)) || {};
    const savedBg = saved.backgroundColor;
    const bg = (!savedBg || savedBg === LEGACY_DEFAULT_BACKGROUND_COLOR)
      ? DEFAULT_BACKGROUND_COLOR
      : savedBg;
    return {
      backgroundColor: bg,
      platformColor: saved.platformColor || null, // null = use default gradient
      // §42 stopwatch: display-only count-up clock (default ON), toggled in
      // Settings. Never affects gameplay, never ends matches.
      stopwatch: saved.stopwatch !== false,
      // Top-of-screen stock pill (default ON). Display-only like the stopwatch:
      // hiding it changes nothing about stock tracking, knockouts or the result.
      showStocks: saved.showStocks !== false,
      // Stage matchup banner ("X vs Y" background art, default ON).
      // Display-only like the stopwatch: hiding it changes nothing about
      // fighters, matchups or gameplay, the text is simply not drawn.
      showMatchup: saved.showMatchup !== false,
      // Render quality scaler for low-end hardware (HIGH default = full
      // visuals, identical to before). BALANCED trims particle spawn counts,
      // PERFORMANCE trims harder. Gameplay, damage and timing are untouched —
      // only the number of spawned ability particles changes.
      quality: ['high', 'balanced', 'performance'].includes(saved.quality) ? saved.quality : 'high',
      // Internal rendering resolution (PERFORMANCE default = adaptive tier
      // scaling, smoothness first — full 1080-line backing on capable machines,
      // stepped down only under sustained load). 480p/720p/1080p/1440p pin the
      // backing to that line count (square viewport, so 1440p = 1440×1440
      // backing — the 1440p-display equivalent, never stretched). 480p is the
      // escape hatch for very weak rasterizers (software rendering).
      // Render-only like quality above: world units and physics never see it.
      resolution: ['performance', '480p', '720p', '1080p', '1440p'].includes(saved.resolution) ? saved.resolution : 'performance',
      // Death-zone margins (px beyond each arena edge). 0/0/0/0 preserves the
      // historical behavior exactly (death box == arena edge). Validated and
      // applied to stage.blastZones; older saves without it load fine.
      deathZone: sanitizeDeathZone(saved.deathZone),
    };
  } catch (_) {
    return { backgroundColor: DEFAULT_BACKGROUND_COLOR, platformColor: null, stopwatch: true, showStocks: true, showMatchup: true, quality: 'high', resolution: 'performance', deathZone: { ...DEFAULT_DEATH_MARGINS } };
  }
})();
function persistMapSettings() {
  try { localStorage.setItem(MAP_SETTINGS_KEY, JSON.stringify(mapSettings)); } catch (_) {}
}
// Live-apply the menu's death-zone margins onto the active match stage.
function syncDeathZoneToStage() {
  try {
    mapSettings.deathZone = sanitizeDeathZone(mapSettings.deathZone);
    if (stage) applyDeathZoneToStage(stage, mapSettings.deathZone, arena.width, arena.height);
  } catch (_) {}
}
// Build the match stage: platform/spawn layout anchored to the top-1080 vista
// (identical to the old map), with the blast box extended to the full arena
// height so the extra pit below is real KO space, not decoration.
function buildMatchStage() {
  const st = createDefaultStage(arena.width, VIEW_H, mapSettings.deathZone);
  applyDeathZoneToStage(st, mapSettings.deathZone, arena.width, arena.height);
  return st;
}

// Rebuild the background canvas with current settings
function rebuildBackgroundCanvas() {
  if (!_gridCanvas) return;
  const gctx = _gridCanvas.getContext('2d');
  gctx.fillStyle = mapSettings.backgroundColor || DEFAULT_BACKGROUND_COLOR;
  gctx.fillRect(0, 0, arena.width, arena.height);
  // No grid lines - clean background
}

// Pre-build every sprite the renderer can bake on first use, so the cost never
// lands as a mid-fight hitch. Each of these caches is a one-shot rasterization
// (a few hundred microseconds each), but "a few hundred microseconds on the
// frame a player first throws a smoke bomb" is exactly the kind of thing that
// reads as a stutter. Done once at the ready -> playing transition, where a
// single dropped frame is invisible.
let _warmed = false;
function _warmRenderCaches() {
  if (_warmed) return;
  _warmed = true;
  try {
    // Stock pill.
    if (mapSettings.showStocks !== false && canvas) {
      const s = screenTransform();
      ctx.font = _fontHudBold;
      if (_hudLabelW < 0) _hudLabelW = ctx.measureText('P1      P2').width;
      const total = Math.max(fighter1 ? fighter1.stocks ?? 0 : 0, fighter2 ? fighter2.stocks ?? 0 : 0, matchSettings.stocks);
      const half = (total * 17) / 2;
      const pillW = _hudLabelW + half * 2 + 36;
      _pillKey = null;                       // force the rebuild on the next frame
      _buildPillSprite(pillW, 26, half, total, VIEW_W / 2, 10,
        fighter1 ? fighter1.stocks ?? 0 : 0, fighter2 ? fighter2.stocks ?? 0 : 0, 6, 17, s);
      screenTransform();
    }
    // Percent labels across the whole legal range.
    for (let p = 0; p <= 150; p += 5) _pctSprite(p + '%');
  } catch (_) {}
  try { warmEffectSprites(); } catch (_) {}
  try { warmFighterSprites(); } catch (_) {}
}

// On-screen FPS counter (always drawn, top-right).
let _fpsValue = '--';
let _fpsFrames = 0;
let _fpsSince = 0;
// The on-screen counter is the REAL frame cadence (rAF-to-rAF), which is what
// the player perceives and what the adaptive controller in physics.js now
// judges. It used to be derived from a JS-cost timer that ignored GPU and
// compositing entirely, so a game stuttering at 30fps could still report a
// healthy number while the quality controller refused to step down.
// Single choke point: every render path ends here.
function drawFps(ctx, width, height, time) {
  _fpsFrames += 1;
  if (time - _fpsSince >= 500) {
    _fpsValue = String(Math.round(_fpsFrames * 1000 / (time - _fpsSince)));
    _fpsSince = time;
    _fpsFrames = 0;
  }
  ctx.save();
  ctx.textAlign = 'right';
  ctx.textBaseline = 'top';
  ctx.font = _fontFps;
  ctx.fillStyle = _fillFpsShadow;
  ctx.fillText(_fpsValue + ' fps', width - 7, 7);
  ctx.fillStyle = _fillFpsGreen;
  ctx.fillText(_fpsValue + ' fps', width - 8, 6);
  ctx.restore();
}

// Reused fighter pair array â€” avoids allocating a fresh [fighter1, fighter2]
// array several times per frame. Consumers iterate it synchronously.
const _fightersPair = [null, null];
function fightersPair() { _fightersPair[0] = fighter1; _fightersPair[1] = fighter2; return _fightersPair; }

// Reused per-frame input routing (see update()): stable resolver + override
// map, written each frame, never reallocated.
let _slotIn1 = null;
let _slotIn2 = null;
function _slotInputFor(f) { return f === fighter1 ? _slotIn1 : _slotIn2; }
const _overrides = {};
let _ovCount = 0;

// Visible world rect, recomputed once per rendered playing frame from the live
// camera state. Shared (read-only) with the world-space culling bounds and
// the stage platform skip.
// Cached HUD metrics: the pill label is static (measured once); the pip pass
// is a hoisted module function (no per-frame closure). The stopwatch text only
// changes once per second, so its string + width are cached across frames.
const _fontHudBold = `bold 13px ${MONO}`;
const _fontHudStopwatch = `13px ${MONO}`;
// Backing-store scale for the screen-space HUD passes. The canvas holds
// VIEW × dpr device pixels, so logical 1080 coordinates reach the screen
// through a dpr-scaled transform (one logical pixel = dpr device pixels —
// exact, never resampled). Derived from the backing store itself, so it
// stays correct if main.js re-fits the canvas for a new window size, monitor
// or browser zoom. Five separate blocks in render() (plus the cache-warmer)
// share one refresh per frame instead of reading window.devicePixelRatio live.
let _backing = 1;
function screenScale() {
  const s = canvas ? backingScaleFor(canvas, VIEW_W) : 1;
  _backing = s;
  return s;
}
// Install the screen-space transform (logical 1080 units). World code draws
// under this plus the camera; HUD code draws directly under it.
function screenTransform() {
  const s = screenScale();
  try { ctx.setTransform(s, 0, 0, s, 0, 0); } catch (_) {}
  return s;
}
let _hudLabelW = -1;
let _swText = null;
let _swFull = '';
let _swW = 0;
// Cached stock-pill sprite.
//
// This is the single most expensive thing the HUD drew. It was rebuilt from
// scratch every single frame — a fillRect, TWO fillText calls (text
// rasterization is one of the most expensive canvas operations there is), and
// an arc+fill/stroke per pip for both players. Profiling an idle match put it
// at roughly a third of ALL canvas operations in the frame, for artwork that
// only changes when a fighter actually loses a stock.
//
// It is now rasterized once into an offscreen canvas and blitted, rebuilt only
// when the stock counts change. One drawImage replaces ~20 ops including two
// text rasterizations.
let _pillSprite = null;
let _pillKey = null;
let _pillScale = 0; // backing scale the cached sprite was rasterized at
function _buildPillSprite(pillW, pillH, half, total, cx, y, stocks1, stocks2, pipR, gap, scale) {
  // Rasterized at the backing-store density (one logical pixel = scale device
  // pixels) so the blit lands on exact device pixels instead of an upscaled
  // 1x image. Blitted with explicit logical dw/dh at the call site.
  const s = (typeof scale === 'number' && scale > 0) ? scale : _backing;
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.ceil(pillW * s));
  c.height = Math.max(1, Math.ceil(pillH * s));
  const m = c.getContext('2d');
  m.scale(s, s);
  // Sprite-local origin: the pill's top-left. Everything below is expressed
  // relative to it so the sprite is position independent.
  const ox = cx - pillW / 2;
  const oy = y;
  void oy;
  m.textAlign = 'center';
  m.textBaseline = 'top';
  m.font = _fontHudBold;
  m.fillStyle = 'rgba(0, 0, 0, 0.55)';
  m.fillRect(0, 0, pillW, pillH);
  m.fillStyle = '#4a9eff';
  m.textAlign = 'right';
  m.fillText('P1', cx - ox - 14, 6);
  m.fillStyle = '#ff4a4a';
  m.textAlign = 'left';
  m.fillText('P2', cx - ox + 14, 6);
  _pipsInto(m, stocks1, false, '#4a9eff', total, cx - ox, pillH, pipR, gap);
  _pipsInto(m, stocks2, true, '#ff4a4a', total, cx - ox, pillH, pipR, gap);
  _pillSprite = { canvas: c, w: pillW, h: pillH };
  _pillScale = s;
}

// Pip pass, already in sprite-local space. The live-frame version below is a
// one-line blit; only the (rare) rebuild path walks the pips.
function _pipsInto(ctx, stocks, right, color, total, cx, pillH, pipR, gap) {
  const py = pillH / 2;
  ctx.fillStyle = color;
  for (let i = 0; i < stocks && i < total; i++) {
    const px = right ? cx + 44 + i * gap : cx - 44 - i * gap;
    ctx.beginPath();
    ctx.arc(px, py, pipR, 0, Math.PI * 2);
    ctx.fill();
  }
  if (stocks < total) {
    ctx.strokeStyle = 'rgba(255,255,255,0.45)';
    ctx.lineWidth = 1.5;
    for (let i = Math.max(0, stocks); i < total; i++) {
      const px = right ? cx + 44 + i * gap : cx - 44 - i * gap;
      ctx.beginPath();
      ctx.arc(px, py, pipR, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
}

function _drawPips(ctx, stocks, right, color, total, cx, y, pillH, pipR, gap) {
  const py = y + pillH / 2;
  ctx.fillStyle = color;
  for (let i = 0; i < stocks && i < total; i++) {
    const px = right ? cx + 44 + i * gap : cx - 44 - i * gap;
    ctx.beginPath();
    ctx.arc(px, py, pipR, 0, Math.PI * 2);
    ctx.fill();
  }
  if (stocks < total) {
    ctx.strokeStyle = 'rgba(255,255,255,0.45)';
    ctx.lineWidth = 1.5;
    for (let i = Math.max(0, stocks); i < total; i++) {
      const px = right ? cx + 44 + i * gap : cx - 44 - i * gap;
      ctx.beginPath();
      ctx.arc(px, py, pipR, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
}

const _viewRect = { x0: -1e9, y0: -1e9, x1: 1e9, y1: 1e9 };
const _camScratch = { x: 0, y: 0, zoom: 1 };
const _w2sScratch = { x: 0, y: 0 };
// Off-screen fighter markers (Smash-style edge pips): visual aid only. A live
// fighter outside the camera view gets a small colored triangle + P1/P2 tag
// pinned to the viewport edge pointing toward them. Never affects physics,
// KO detection, or timing; removed when the fighter returns or is eliminated.
function drawOffscreenMarkers() {
  try {
    if (!fighter1 && !fighter2) return;
    screenTransform();
    const pair = fightersPair();
    for (let i = 0; i < pair.length; i++) {
      const f = pair[i];
      if (!f || f.eliminated || f.state === 'dead') continue;
      if (f.x >= _viewRect.x0 && f.x <= _viewRect.x1 && f.y >= _viewRect.y0 && f.y <= _viewRect.y1) continue;
      worldToScreen(f.x, f.y, _w2sScratch, VIEW_W, VIEW_H);
      const m = 34;
      const cx = Math.max(m, Math.min(VIEW_W - m, _w2sScratch.x));
      const cy = Math.max(m, Math.min(VIEW_H - m, _w2sScratch.y));
      const ang = Math.atan2(_w2sScratch.y - cy || (f.y - cy), _w2sScratch.x - cx || 1);
      const col = f === fighter1 ? '#4a9eff' : '#ff4a4a';
      const tag = f === fighter1 ? 'P1' : 'P2';
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(ang);
      ctx.fillStyle = col;
      ctx.strokeStyle = 'rgba(0,0,0,0.85)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(14, 0);
      ctx.lineTo(-8, -10);
      ctx.lineTo(-8, 10);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.rotate(-ang);
      ctx.font = 'bold 13px Consolas, monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(0,0,0,0.85)';
      ctx.strokeText(tag, 0, -12);
      ctx.fillStyle = '#ffffff';
      ctx.fillText(tag, 0, -12);
      ctx.restore();
    }
  } catch (_) {}
}
function updateViewBounds() {
  try {
    const cam = getCameraStateInto(_camScratch);
    const zoom = cam.zoom || 1;
    // Visible window = the 1080² viewport at the live zoom (not the taller
    // arena — the screen itself is still square).
    const w = VIEW_W / zoom, h = VIEW_H / zoom;
    // Margin: culling bounds in Effects/worldFx carry their own margins; the
    // rect itself is exact, with a small slack for the stage skip.
    _viewRect.x0 = cam.x - w / 2 - 40;
    _viewRect.y0 = cam.y - h / 2 - 40;
    _viewRect.x1 = cam.x + w / 2 + 40;
    _viewRect.y1 = cam.y + h / 2 + 40;
  } catch (_) {
    _viewRect.x0 = -1e9; _viewRect.y0 = -1e9; _viewRect.x1 = 1e9; _viewRect.y1 = 1e9;
  }
  try {
    setViewBounds(_viewRect.x0, _viewRect.y0, _viewRect.x1, _viewRect.y1);
    setWorldFxViewBounds(_viewRect.x0, _viewRect.y0, _viewRect.x1, _viewRect.y1);
    setVfxViewBounds(_viewRect.x0, _viewRect.y0, _viewRect.x1, _viewRect.y1);
    setDestructibleViewBounds(_viewRect.x0, _viewRect.y0, _viewRect.x1, _viewRect.y1);
  } catch (_) {}
}

function resetViewBounds() {
  try {
    setViewBounds(-1e9, -1e9, 1e9, 1e9);
    setWorldFxViewBounds(-1e9, -1e9, 1e9, 1e9);
    setVfxViewBounds(-1e9, -1e9, 1e9, 1e9);
    clearDestructibleViewBounds();
  } catch (_) {}
}

// â”€â”€ Start menu (terminal) settings â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Per-fighter skin sizes saved in the browser (skin customiser).
const SKIN_SCALE_KEY = 'smashfighters.skinScale';
const skinScaleCache = (() => {
  try { return JSON.parse(localStorage.getItem(SKIN_SCALE_KEY)) || {}; } catch (_) { return {}; }
})();
function persistSkinScaleCache() {
  try { localStorage.setItem(SKIN_SCALE_KEY, JSON.stringify(skinScaleCache)); } catch (_) {}
}
function skinScaleFor(f) {
  const s = skinScaleCache[f.id];
  return typeof s === 'number' ? s : (f.skinScale || 0.85);
}
// Skin scale actually used for rendering: a skin-meta override (SKIN_META /
// fighter def / rig store) wins, otherwise the skin customiser's stored value.
// Keeps every preview and the in-game body on one value.
function effectiveSkinScale(f) {
  const m = resolveSkinMeta(f);
  return (m && m.skinScale != null) ? m.skinScale : skinScaleFor(f);
}

let matchSettings = {
  p1: 0,
  p2: 0,
  stocks: 3,   // stocks per fighter per match (1â€“5, decided in the menu)
  // Â§42: no round timer, no time limit â€” matches end on stocks only.
  aiDifficulty: 'Normal', // Easy | Normal | Hard | Expert | Trained
};

// â”€â”€ AI Training + difficulty config (persisted, same localStorage pattern) â”€
const AI_CONFIG_KEY = 'smashfighters.aiConfig';
let trainSettings = (() => {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(AI_CONFIG_KEY)) || {}; } catch (_) { saved = {}; }
  if (saved.aiDifficulty && AI_DIFFICULTIES.includes(saved.aiDifficulty)) {
    matchSettings.aiDifficulty = saved.aiDifficulty;
  }
  return {
    ai1: Number.isInteger(saved.ai1) ? Math.max(0, Math.min(ALL_FIGHTERS.length - 1, saved.ai1)) : 0,
    ai2: Number.isInteger(saved.ai2) ? Math.max(0, Math.min(ALL_FIGHTERS.length - 1, saved.ai2)) : 1 % ALL_FIGHTERS.length,
    populationSize: [10, 20, 30, 50, 80, 100, 150, 200].includes(saved.populationSize) ? saved.populationSize : 50,
    maxGenerations: [5, 25, 50, 100, 250, 500, 1000].includes(saved.maxGenerations) ? saved.maxGenerations : 250,
    mutationRate: typeof saved.mutationRate === 'number' ? Math.min(0.2, Math.max(0.005, saved.mutationRate)) : 0.05,
    speed: ['Normal', 'Fast', 'Fastest'].includes(saved.speed) ? saved.speed : 'Fast',
    showSim: saved.showSim !== false,
    // Training mode: matchup (both evolve) | character (A vs fixed B) |
    // general (A vs rotating opponents).
    mode: ['matchup', 'character', 'general'].includes(saved.mode) ? saved.mode : 'matchup',
    // Opponent type for fixed-opponent training.
    oppType: ['coevolve', 'trained', 'scripted', 'dummy'].includes(saved.oppType) ? saved.oppType : 'coevolve',
    // New run vs continuing from the saved model/checkpoint.
    startMode: saved.startMode === 'continue' ? 'continue' : 'new',
    scriptedDifficulty: ['Easy', 'Normal', 'Hard', 'Expert'].includes(saved.scriptedDifficulty) ? saved.scriptedDifficulty : 'Normal',
    evalMatches: [2, 4, 6, 10].includes(saved.evalMatches) ? saved.evalMatches : 4,
  };
})();
function persistAIConfig() {
  try {
    localStorage.setItem(AI_CONFIG_KEY, JSON.stringify({
      aiDifficulty: matchSettings.aiDifficulty,
      ...trainSettings,
    }));
  } catch (_) {}
}

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// SESSION PARAMETER AUTOSAVE
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// Restores the terminal-menu parameters that otherwise fell back to their
// defaults on every page load: your fighter, the opponent, stock count, and game
// mode. The rest of that menu (skin size, accessories, hand/weapon animator,
// hitbox customizer, map settings, AI difficulty and AI training) already has its
// own persisted store, so this deliberately does not duplicate those â€” extend the
// store that already owns a value rather than shadowing it here.
//
// Same storage pattern as ai-model-storage.js: localStorage JSON with try/catch
// everywhere, so a corrupt or over-quota profile can never crash the game. Stored
// values are re-validated on read, because a saved fighter index goes stale if a
// fighter is ever removed from the roster.
//
// It lives here rather than in its own module because Game.js is its only
// consumer: it restores the menu state on the very next line and writes it back
// from the menu handlers.
const AUTOSAVE_STORE_KEY = 'smashfighters.autosave.v1';
const AUTOSAVE_SCHEMA_VERSION = 1;

// The selectable game modes. Labeled in `gameModeLabels` and cycled through
// this same list, so it is declared once here rather than re-declared per call
// site.
const GAME_MODES = ['playerVsPlayer', 'playerVsDummy', 'playerVsAI', 'AIvsAI'];

const MIN_STOCKS = 1;
const MAX_STOCKS = 5;
const DEFAULT_STOCKS = 3;

// Must match the pre-autosave defaults exactly, so a profile with no autosave
// (or a cleared one) behaves exactly as it did before this existed.
function defaultSessionParams() {
  return { p1: 0, p2: 0, stocks: DEFAULT_STOCKS, gameMode: 'playerVsPlayer' };
}

function readSessionStore() {
  try {
    const raw = localStorage.getItem(AUTOSAVE_STORE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (_) {
    return null;
  }
}

function writeSessionStore(store) {
  try {
    localStorage.setItem(AUTOSAVE_STORE_KEY, JSON.stringify(store));
    return true;
  } catch (_) {
    return false;
  }
}

// A stored fighter index is only meaningful while the roster still has that
// entry, so clamp into range and reject non-integers outright.
function clampFighterIndex(value, fighterCount) {
  const count = Math.floor(Number(fighterCount) || 0);
  if (count < 1 || !Number.isInteger(value)) return null;
  return Math.max(0, Math.min(count - 1, value));
}

function clampStocks(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const rounded = Math.round(value);
  if (rounded < MIN_STOCKS || rounded > MAX_STOCKS) return null;
  return rounded;
}

// Coerce a stored record into something usable. Each field falls back to its own
// default independently, so one bad entry can't discard the rest of the autosave.
function sanitizeSessionParams(raw, fighterCount) {
  const out = defaultSessionParams();
  if (!raw || typeof raw !== 'object') return out;
  const p1 = clampFighterIndex(raw.p1, fighterCount);
  if (p1 !== null) out.p1 = p1;
  const p2 = clampFighterIndex(raw.p2, fighterCount);
  if (p2 !== null) out.p2 = p2;
  const stocks = clampStocks(raw.stocks);
  if (stocks !== null) out.stocks = stocks;
  if (GAME_MODES.includes(raw.gameMode)) out.gameMode = raw.gameMode;
  return out;
}

// The saved session parameters merged over the defaults, ready to be applied at
// boot. `fighterCount` is the live roster length, used to validate stored picks.
function loadSessionParams(fighterCount) {
  return sanitizeSessionParams(readSessionStore(), fighterCount);
}

// Merge `patch` into the stored record and write it back. Callers may pass a
// partial patch: fields they omit keep their stored value, and fields they supply
// invalidly are ignored rather than allowed to poison the record.
function saveSessionParams(patch, fighterCount) {
  if (!patch || typeof patch !== 'object') return false;
  try {
    const next = sanitizeSessionParams(readSessionStore(), fighterCount);
    const p1 = clampFighterIndex(patch.p1, fighterCount);
    if (p1 !== null) next.p1 = p1;
    const p2 = clampFighterIndex(patch.p2, fighterCount);
    if (p2 !== null) next.p2 = p2;
    const stocks = clampStocks(patch.stocks);
    if (stocks !== null) next.stocks = stocks;
    if (GAME_MODES.includes(patch.gameMode)) next.gameMode = patch.gameMode;
    return writeSessionStore({
      version: AUTOSAVE_SCHEMA_VERSION,
      savedAt: new Date().toISOString(),
      p1: next.p1,
      p2: next.p2,
      stocks: next.stocks,
      gameMode: next.gameMode,
    });
  } catch (_) {
    return false;
  }
}

// Whether anything has been autosaved yet.
function hasSessionParams() {
  return readSessionStore() !== null;
}

// Forget the autosave so the next load starts from the defaults again.
function clearSessionParams() {
  try {
    localStorage.removeItem(AUTOSAVE_STORE_KEY);
    return true;
  } catch (_) {
    return false;
  }
}

// â”€â”€ Session parameter autosave â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Your fighter, the opponent, stock count and game mode used to fall back to
// their defaults on every page load, so a reload meant re-picking all of them.
// The autosave above restores the previous session's values here, and every menu
// change below writes straight back through persistSessionParams().
const sessionParams = loadSessionParams(ALL_FIGHTERS.length);
matchSettings.p1 = sessionParams.p1;
matchSettings.p2 = sessionParams.p2;
matchSettings.stocks = sessionParams.stocks;
gameMode = sessionParams.gameMode;

function persistSessionParams() {
  saveSessionParams({
    p1: matchSettings.p1,
    p2: matchSettings.p2,
    stocks: matchSettings.stocks,
    gameMode,
  }, ALL_FIGHTERS.length);
}

// Every change already persists immediately, so this is only a safety net for
// values that could change outside the menu handlers (and for future call sites
// that forget to persist). Runs on pagehide rather than beforeunload because
// beforeunload is not guaranteed on mobile.
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('pagehide', persistSessionParams);
}

// Floor-based M:SS for the display-only stopwatch (starts at 00:00).
export function formatStopwatch(sec) {
  const s = Math.max(0, Math.floor(sec || 0));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

const TERM_ROWS = [
  { id: 'player',   label: 'YOUR FIGHTER' },
  { id: 'opponent', label: 'OPPONENT FIGHTER' },
  { id: 'skins',    label: 'SKIN SIZE' },
  { id: 'accys',    label: 'ACCESSORIES' },
  { id: 'handGear', label: 'HAND GEAR' },
  { id: 'anim',     label: 'HAND/WEAPON ANIMATOR' },
  { id: 'hit',      label: 'HITBOX CUSTOMIZER' },
  { id: 'sandbox',  label: 'INTERACTIVE SANDBOX' },
  { id: 'settings', label: 'SETTINGS' },
  { id: 'mode',     label: 'GAME MODE' },
  { id: 'aiDifficulty', label: 'AI DIFFICULTY' },
  { id: 'stocks',   label: 'STOCKS' },
  { id: 'aiTraining', label: 'AI TRAINING' },
  { id: 'start',    label: 'START MATCH' },
];


// Map settings submenu
const MAP_SETTINGS_ROWS = [
  { id: 'mapBgColor', label: 'BACKGROUND COLOR', type: 'color', value: () => mapSettings.backgroundColor },
  { id: 'mapPlatColor', label: 'PLATFORM COLOR', type: 'color', value: () => mapSettings.platformColor || 'DEFAULT' },
  { id: 'stopwatch', label: 'STOPWATCH', type: 'toggle', value: () => (mapSettings.stopwatch !== false ? 'ON' : 'OFF') },
  { id: 'showStocks', label: 'STOCK COUNTER', type: 'toggle', value: () => (mapSettings.showStocks !== false ? 'ON' : 'OFF') },
  { id: 'showMatchup', label: 'VERSUS TEXT', type: 'toggle', value: () => (mapSettings.showMatchup !== false ? 'ON' : 'OFF') },
  { id: 'quality', label: 'QUALITY', type: 'quality', value: () => (mapSettings.quality || 'high').toUpperCase() },
  { id: 'resolution', label: 'RESOLUTION', type: 'resolution', value: () => (mapSettings.resolution || 'performance').toUpperCase() },
  // Death zone: px beyond each arena edge. 0 = KO exactly at the edge
  // (historical default). Positive = more forgiving, negative = tighter.
  { id: 'dzLeft', label: 'DEATH ZONE LEFT', type: 'deathzone', value: () => `${mapSettings.deathZone.left >= 0 ? '+' : ''}${mapSettings.deathZone.left}px` },
  { id: 'dzRight', label: 'DEATH ZONE RIGHT', type: 'deathzone', value: () => `${mapSettings.deathZone.right >= 0 ? '+' : ''}${mapSettings.deathZone.right}px` },
  { id: 'dzTop', label: 'DEATH ZONE TOP', type: 'deathzone', value: () => `${mapSettings.deathZone.top >= 0 ? '+' : ''}${mapSettings.deathZone.top}px` },
  { id: 'dzBottom', label: 'DEATH ZONE BOTTOM', type: 'deathzone', value: () => `${mapSettings.deathZone.bottom >= 0 ? '+' : ''}${mapSettings.deathZone.bottom}px` },
  { id: 'dzReset', label: 'RESET DEATH ZONE', type: 'deathzoneReset', value: () => 'ENTER' },
  { id: 'mapBack', label: 'BACK', type: 'action' },
];
const QUALITY_SCALES = { high: 1, balanced: 0.6, performance: 0.35 };
const QUALITY_ORDER = ['high', 'balanced', 'performance'];
// Fixed internal-resolution scales, relative to the 1080-line logical
// viewport: 720p = 720-line backing, 1080p = full, 1440p = 1440-line backing
// (the sharpness a 1440p display resolves — a real resolution lift, not a
// stretched 1080p image). 'performance' is absent: it means adaptive, handled
// by the tier path below rather than a pinned value.
const RESOLUTION_SCALES = { '480p': 480 / 1080, '720p': 720 / 1080, '1080p': 1, '1440p': 1440 / 1080 };
const RESOLUTION_ORDER = ['performance', '480p', '720p', '1080p', '1440p'];
// Applies the manual Settings ceiling to every render consumer, then lets the
// adaptive tier (loop sensor -> perf mapper) reduce below it under load.
// Render-only: physics, damage, timing untouched.
function _applyPerfTier(info) {
  try {
    setFxQuality(info && info.fxScale != null ? info.fxScale : getActiveFxScale());
    // Backing resolution: a pinned RESOLUTION setting wins exactly (the player
    // asked for that sharpness), otherwise the adaptive tier drives it as
    // before. The canvas resize lands via the per-frame store sync in
    // render() — no realloc here, no new monitoring; this runs only on actual
    // tier changes (hysteresis + cooldown gated in loop/perf) or settings
    // edits, never per frame.
    try {
      const pinned = RESOLUTION_SCALES[mapSettings.resolution];
      setRenderScale(pinned != null ? pinned
        : (info && info.renderScale != null ? info.renderScale : getActiveRenderScale()));
    } catch (_) {}
    const m = (info && info.modes) || null;
    setParticleDetail(m ? m.particleDetail : 0);
    setPostDetail(m ? m.postDetail : 0);
    setWorldFxBatch(m ? m.batchParticles : !FLAGS.legacy);
    setEffectBatch(m ? m.batchTrails : !FLAGS.legacy);
    setDamageTextCache(m ? m.textCache : !FLAGS.legacy);
  } catch (_) {}
}
let _perfWired = false;
function applyQuality() {
  try { setFxQuality(QUALITY_SCALES[mapSettings.quality] || 1); } catch (_) {}
  try { setManualFxScale(QUALITY_SCALES[mapSettings.quality] || 1); } catch (_) {}
  // Manual quality changes also move the resolution ceiling immediately (the
  // tier listener only fires on tier changes, not on settings edits).
  try { setRenderScale(getActiveRenderScale()); } catch (_) {}
  try {
    if (!_perfWired) {
      _perfWired = true;
      try { onQualityChange(_applyPerfTier); } catch (_) {}
      try { onLoopQualityChange((lvl) => { try { setTierFromLoop(lvl); } catch (_) {} }); } catch (_) {}
    }
    _applyPerfTier(null);
  } catch (_) {}
}

// Game mode labels
const gameModeLabels = {
  playerVsPlayer: 'PLAYER VS PLAYER',
  playerVsDummy:  'PLAYER VS DUMMY',
  playerVsAI:     'PLAYER VS AI',
  AIvsAI:         'AI VS AI'
};

// Resolve the per-fighter input functions for this frame now lives in
// session.js (inputForSlot / DUMMY_INPUT), because the sandbox roster resolves
// its slots the same way:
// - AI-controlled fighter â†’ the controller's synthetic triple (same signature
//   as Input.js, driving the REAL movement + combat paths).
// - Dummy fighter (playerVsDummy P2) â†’ all-false triple: fully passive, never
//   reacts to human keys.
// - Human fighter â†’ null (callers fall back to the real Input.js queries).

let termMode = 'main';
let termCursor = 0;
let termSkinCursor = 0;
let termAccyCursor = 0;
let termGearCursor = 0;
// Which hand the hand-gear editor is currently pointing at. Separate from
// termAccyCursor because the two editors are separate submenus.
let termGearHand = 'right';
// Gear-editor preview state (never saved): which way the minifig faces, and
// whether hand-anchor/grip guides draw. Toggling facing previews the SAME rig
// configuration through the facing transform — never a second value set.
let previewFacingRight = true;
let gearGuidesOn = true;
let termMapCursor = 0;
let previewFighterIdx = 0;
let previewCanvas = null;
let previewCtx = null;
let selectOverlay = null;
let termLinesEl = null;

// Precomputed health-bar color LUT: 48 buckets over 0–150% (white → yellow →
// orange → red → maroon, in that damage order). Same math the per-frame
// branch used, evaluated once.
const _healthLut = (() => {
  // Five damage stops: white (fresh) → yellow → orange → red → maroon (max).
  const STOPS = [
    [255, 255, 255], // white
    [255, 255, 0],   // yellow
    [255, 165, 0],   // orange
    [255, 0, 0],     // red
    [128, 0, 0],     // maroon
  ];
  const lut = new Array(48);
  for (let i = 0; i < 48; i++) {
    const pct = i / 47;
    const seg = Math.min(STOPS.length - 2, Math.floor(pct * (STOPS.length - 1)));
    const t = pct * (STOPS.length - 1) - seg;
    const a = STOPS[seg], b = STOPS[seg + 1];
    const r = Math.round(a[0] + (b[0] - a[0]) * t);
    const g = Math.round(a[1] + (b[1] - a[1]) * t);
    const bl = Math.round(a[2] + (b[2] - a[2]) * t);
    lut[i] = `rgb(${r},${g},${bl})`;
  }
  return lut;
})();

function drawHealthBar(ctx, fighter, time) {
  // Damage percent meter above the fighter.
  // Called inside the camera transform, so fighter.x/y are already world coords.
  // Stroke + subtle drop shadow keep the bar readable over any background;
  // dimensions and values are unchanged (gameplay-agnostic).
  const pct = Math.max(0, Math.min(1, fighter.percent / 150));
  const bx = fighter.x - 40, by = fighter.y - fighter.radius - 20;

  ctx.save();
  // Flat drop strip instead of a shadowBlur drop shadow: same depth read for
  // the bar, no blur pass (blur is one of the slowest canvas ops, and this
  // runs per fighter per frame).
  ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
  ctx.fillRect(bx, by, 80, 8);
  ctx.fillStyle = 'rgba(0, 0, 0, 0.35)';
  ctx.fillRect(bx + 2, by + 8, 76, 2);

  // Health color via precomputed LUT (48 buckets white → yellow → orange →
  // red → maroon). Identical colors within ~3%; replaces the per-frame rgb() template.
  const _hbIdx = Math.min(47, (pct * 47) | 0);

  // Foreground bar (health/damage) — always full width, color changes with damage
  ctx.fillStyle = _healthLut[_hbIdx];
  ctx.fillRect(bx, by, 80, 8);
  // Crisp outline following the bar's exact shape.
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = 'rgba(0,0,0,0.85)';
  ctx.strokeRect(bx + 0.75, by + 0.75, 80 - 1.5, 8 - 1.5);
  ctx.restore();

  // Text. Cached per rounded percent value: fillText is a full text shaping +
  // rasterization pass, and this ran for both fighters every frame for a
  // string drawn from a small, repeating set. Sprites are rasterized at the
  // backing density and blitted at logical size, so they stay sharp on hidpi.
  // The sprite itself carries the outline + shadow bake (see _pctSprite).
  const label = Math.round(fighter.percent) + '%';
  const spr = _pctSprite(label);
  if (spr) ctx.drawImage(spr.c, fighter.x - spr.w / 2, fighter.y - fighter.radius - 25 - spr.h / 2, spr.w, spr.h);
  else {
    ctx.save();
    ctx.font = _fontHealth;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(0,0,0,0.85)';
    ctx.shadowColor = 'rgba(0,0,0,0.5)';
    ctx.shadowBlur = 3;
    ctx.shadowOffsetY = 1;
    ctx.strokeText(label, fighter.x, fighter.y - fighter.radius - 25);
    ctx.fillStyle = 'white';
    ctx.fillText(label, fighter.x, fighter.y - fighter.radius - 25);
    ctx.restore();
  }
}

// (The pirate's former Plunder meter lived here — five pips above the damage
// readout. The passive is removed, so the meter, its thresholds and its label
// cache are gone with it.)

// Bounded percent-label sprite cache (FIFO eviction at 96 entries). The set of
// distinct labels actually on screen at once is tiny, so this is effectively a
// permanent hit rate. Labels draw in WORLD space (above the fighters, under
// the camera), so they bake at WORLD_TEXT_SS — a 1x bake would be magnified
// by the live zoom and read as blurry (same rationale as BODY_SS). Blitted at
// logical size, so layout is unchanged and no rebuild is ever needed on DPR
// changes.
const WORLD_TEXT_SS = 4;
const _pctSprites = new Map();
function _pctSprite(text) {
  const s = WORLD_TEXT_SS;
  let rec = _pctSprites.get(text);
  if (rec) return rec;
  try {
    const m = document.createElement('canvas').getContext('2d');
    m.font = _fontHealth;
    const w = Math.ceil(m.measureText(text).width) + 8;
    const h = 20;
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.ceil(w * s));
    c.height = Math.max(1, Math.ceil(h * s));
    const g = c.getContext('2d');
    g.scale(s, s);
    g.font = _fontHealth;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.lineJoin = 'round';
    // Outline + subtle shadow baked once per label: per-frame blits stay free.
    g.shadowColor = 'rgba(0,0,0,0.5)';
    g.shadowBlur = 2;
    g.shadowOffsetY = 1;
    g.lineWidth = 3;
    g.strokeStyle = 'rgba(0,0,0,0.85)';
    g.strokeText(text, w / 2, h / 2);
    g.shadowColor = 'rgba(0,0,0,0)';
    g.shadowBlur = 0;
    g.shadowOffsetY = 0;
    g.fillStyle = 'white';
    g.fillText(text, w / 2, h / 2);
    rec = { c, w, h };
  } catch (_) { return null; }
  if (_pctSprites.size >= 96) _pctSprites.delete(_pctSprites.keys().next().value);
  _pctSprites.set(text, rec);
  return rec;
}

export function initGame(canvasEl) {
  canvas = canvasEl;
  // Opaque canvas: every state fills an opaque backdrop each frame, so alpha
  // is never needed — telling the browser up front lets it skip alpha
  // compositing on present. Zero visual change (page behind is black).
  try { ctx = canvas.getContext('2d', { alpha: false }); }
  catch (_) { ctx = canvas.getContext('2d'); }
  // Logical viewport is fixed at 1080 × 1080 regardless of the canvas backing
  // size (VIEW × DPR) or CSS size (uniform square fit). World coordinates,
  // physics and character sizes are therefore untouched by the viewport work.
  try { syncCanvasBacking(canvas); } catch (_) {}
  screenTransform();
  arena = { width: ARENA_W, height: ARENA_H };
  stage = buildMatchStage();
  // Abilities that need to know where the stage is (the Teleport Strike's
  // placement checks) read it from the combat context, so the stage is
  // registered with the combat system whenever it is (re)built.
  setCombatStage(stage);
  initInput();

  // Pre-render the background into an offscreen canvas so render()
  // draws it with a single drawImage instead of path operations per frame.
  _gridCanvas = document.createElement('canvas');
  _gridCanvas.width = arena.width;
  _gridCanvas.height = arena.height;
  const gctx = _gridCanvas.getContext('2d');
  gctx.fillStyle = mapSettings.backgroundColor || DEFAULT_BACKGROUND_COLOR;
  gctx.fillRect(0, 0, arena.width, arena.height);
  // No grid lines - clean background

  // Animator: gameplay requests animations by name; the library resolves them.
  // Playback keeps ONE read-only clone per animation id so starting a new
  // attack reuses it instead of deep-cloning the whole animation (a JSON
  // stringify+parse per attack caused GC churn while stringing light attacks).
  // Nothing in the gameplay animator mutates A.anim, so sharing is safe; the
  // cache is invalidated whenever the editor changes the library.
  const _animPlaybackCache = new Map();
  setAnimationLoader(name => {
    if (!name) return null;
    if (!_animPlaybackCache.has(name)) _animPlaybackCache.set(name, getAnimation(name));
    return _animPlaybackCache.get(name);
  });
  setAnimLibChangeListener(() => _animPlaybackCache.clear());
  setEditorCloseHandler(() => {
    if (currentGameState !== 'animator') return;
    closeAnimatorEditor();
  });
  setHitboxCustomizerCloseHandler(() => {
    if (currentGameState !== 'hitboxes') return;
    closeHitboxCustomizerEditor();
  });

  // Apply saved skin sizes from the SKIN SIZE customiser onto the roster so the
  // previews and the fighters all agree.
  for (const f of ALL_FIGHTERS) {
    f._defaultSkinScale = f.skinScale || 0.85;
    f.skinScale = skinScaleFor(f);
  }

  // Set up the terminal-style start menu
  selectOverlay = document.getElementById('select-overlay');
  termLinesEl = document.getElementById('term-lines');
  previewCanvas = document.getElementById('hand-preview');
  previewCtx = previewCanvas ? previewCanvas.getContext('2d') : null;
  if (previewCanvas) {
    previewCanvas.addEventListener('pointerdown', onAccyPreviewPointerDown);
    previewCanvas.addEventListener('pointermove', onAccyPreviewPointerMove);
    previewCanvas.addEventListener('pointerup', onAccyPreviewPointerUp);
    previewCanvas.addEventListener('pointercancel', onAccyPreviewPointerUp);
    previewCanvas.addEventListener('dblclick', onAccyPreviewDoubleClick);
  }
  renderTermMenu();
  window.addEventListener('keydown', onTermKey);
  window.addEventListener('keydown', onPlayKey);

  applyQuality();
  showSelectOverlay();

  // [PROBE] Opt-in test hook â€” loaded ONLY when the URL has ?probe. Exposes a
  // state snapshot plus helpers so automated browser tests can set up
  // deterministic scenarios (knockback, aerials, recovery, projectiles, menu keys).
  if (new URLSearchParams(location.search).has('probe')) {
    window.__ssTest = getProbeApi();
  }
}

// â”€â”€ Test probe (?probe) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Debug/test API exposed only when the page loads with `?probe`. Provides a
// state snapshot and a place() helper for deterministic runtime tests. None of
// this runs when the URL flag is absent.
function getProbeApi() {
  // Game state to restore when the probe closes the Hitbox Customizer.
  let _hcPrevState = null;
  // Snapshot of the animator's resolved world-space output â€” the exact data the
  // renderer draws (hand/weapon px/py/rot/scale/â€¦). Carries the animation frame
  // and facing so tests can compare two poses sampled at the same frame.
  function poseSnapshot(f) {
    const A = f && f.anim;
    if (!A || !A.out) return null;
    const item = (o) => (o ? {
      type: o.type,
      id: o.def ? o.def.id : null,
      px: o.px, py: o.py, rot: o.rot, scaleX: o.scaleX, scaleY: o.scaleY,
      width: o.width, height: o.height, z: o.z || 0,
      opacity: o.opacity, visible: o.visible !== false,
    } : null);
    return {
      animId: A.animId, frame: A.frame, fps: A.fps,
      playing: !!A.playing, paused: !!A.paused,
      blending: !!(A.blendFrom && A.blendProgress < 1),
      x: f.x, y: f.y, facingRight: !!f.facingRight,
      hands: { left: item(A.out.hands.left), right: item(A.out.hands.right) },
      weapons: { left: item(A.out.weapons.left), right: item(A.out.weapons.right) },
    };
  }

  return {
    state() {
      return {
        gameState: currentGameState,
        gameMode,
        aiDifficulty: matchSettings.aiDifficulty,
        training: (() => {
          try {
            if (activeTrainer) return activeTrainer.snapshot();
          } catch (_) {}
          return { running: false, generation: 0 };
        })(),
        trainedModels: (() => {
          try { return listTrainedModels(); } catch (_) { return []; }
        })(),
        paused: isPaused,
        overlay: selectOverlay ? selectOverlay.style.display : null,
        stocks: [fighter1 ? fighter1.stocks : null, fighter2 ? fighter2.stocks : null],
        elapsed: matchElapsed, // stopwatch source (display-only)
        stopwatch: mapSettings.stopwatch !== false,
        matchOver,
        winner: matchWinner,
        ai: [aiControllers[0], aiControllers[1]].map(c => {
          if (!c) return null;
          try {
            const d = typeof c.getDebug === 'function' ? c.getDebug() : { action: c.getAction ? c.getAction() : '?' };
            return d;
          } catch (_) { return { state: 'error' }; }
        }),
        fighters: [fighter1, fighter2].map(f => f ? {
          pn: f.playerNum,
          x: f.x, y: f.y, vx: f.vx, vy: f.vy,
          percent: f.percent,
          stocks: f.stocks,
          eliminated: !!f.eliminated,
          hitstun: f.hitstun,
          invulnTimer: f.invulnTimer,
          grounded: !!f.grounded,
          facingRight: !!f.facingRight,
          shielding: !!f.shielding,
          dodging: !!f.dodging,
          canDoubleJump: !!f.canDoubleJump,
          canAerialLight: !!f.canUseAerialLightRecovery,
          freeFall: !!f.freeFall,
          attackCd: +(f.attackCooldown || 0).toFixed(3),
          shieldCd: +(f.shieldCooldown || 0).toFixed(3),
          dodgeCd: +(f.dodgeCooldown || 0).toFixed(3),
          // Per-ability cooldowns still ticking down, in seconds remaining.
          // Empty object = every ability is ready.
          abilityCds: Object.assign({}, f.abilityCooldowns || {}),
          locked: !!f._hitLock,
          lockTimer: f._hitLock ? Math.max(0, f._hitLock.timer) : 0,
          hitLockTimer: +Math.max(0, f._hitLockTimer || 0).toFixed(3),
          attack: f.attack ? (f.attack.def ? f.attack.def.name : '?') : null,
          attackKey: f.attack ? (f.attack.key || null) : null,
          phase: f.attack ? f.attack.phase : null,
          aerialRec: Math.max(0, f._aerialRecoveryTimer || 0),
          tempVfx: Array.isArray(f._tempVfx) ? f._tempVfx.length : 0,
          // A charged teleport waiting to fire (the ninja's Down Light), with the
          // spot it was ACTIVATED on â€” the departure point its smoke goes off at.
          // null = no charge running.
          teleport: f._teleportPending
            ? { fromX: +f._teleportPending.fromX.toFixed(1), fromY: +f._teleportPending.fromY.toFixed(1) }
            : null,
          projectiles: Array.isArray(f._projectiles) ? f._projectiles.length : 0,
        } : null),
        // Sandbox: read-only. The editor's document plus, while a sandbox
        // session runs, its live roster and stage â€” enough to drive the editor
        // and the arena from a test without reaching into module internals.
        sandbox: (() => {
          try {
            const doc = isSandboxEditorOpen() || isSandboxPlaying() ? getSandboxDocument() : null;
            const st = isSandboxPlaying() ? getSandboxStage() : null;
            return {
              editorOpen: isSandboxEditorOpen(),
              playing: isSandboxPlaying(),
              objects: doc ? doc.objects.map((o) => ({ ...o })) : [],
              platforms: st ? st.platforms.length : 0,
              spawnPoints: st ? st.spawnPoints.length : 0,
              roster: isSandboxPlaying() ? getSandboxRoster() : [],
              paused: isSandboxPaused(),
              timeScale: getSandboxTimeScale(),
              sessions: getSandboxSessionCount(),
            };
          } catch (e) { return { error: String(e) }; }
        })(),
      };
    },
    place(pn, patch) {
      const f = pn === 1 ? fighter1 : fighter2;
      if (!f) return false;
      if (patch && typeof patch.weight === 'number' && f._fighterDef) {
        // Per-fighter weight override (the roster def is shared between players).
        f._fighterDef = { ...f._fighterDef, weight: patch.weight };
      }
      if (patch && typeof patch.x === 'number') f.x = patch.x;
      if (patch && typeof patch.y === 'number') f.y = patch.y;
      if (patch && typeof patch.vx === 'number') f.vx = patch.vx;
      if (patch && typeof patch.vy === 'number') f.vy = patch.vy;
      if (patch && typeof patch.percent === 'number') f.percent = patch.percent;
      if (patch && typeof patch.hitstun === 'number') f.hitstun = patch.hitstun;
      if (patch && typeof patch.invulnTimer === 'number') f.invulnTimer = patch.invulnTimer;
      if (patch && typeof patch.facingRight === 'boolean') f.facingRight = patch.facingRight;
      if (patch && typeof patch.shielding === 'boolean') f.shielding = patch.shielding;
      if (patch && typeof patch.dashing === 'boolean') f.dashing = patch.dashing;
      if (patch && typeof patch.dashTimer === 'number') f.dashTimer = patch.dashTimer;
      if (patch && typeof patch.grounded === 'boolean') {
        f.grounded = patch.grounded;
        if (!patch.grounded) f.groundPlatform = null;
      }
      if (patch && typeof patch.canDoubleJump === 'boolean') f.canDoubleJump = patch.canDoubleJump;
      if (patch && typeof patch.canAerialLight === 'boolean') f.canUseAerialLightRecovery = patch.canAerialLight;
      if (patch && typeof patch.freeFall === 'boolean') f.freeFall = patch.freeFall;
      if (patch && typeof patch.stocks === 'number') f.stocks = Math.max(0, patch.stocks);
      if (patch && typeof patch.eliminated === 'boolean') f.eliminated = patch.eliminated;
      return true;
    },
    setMatch(patch) {
      // Â§42: stocks only â€” there is no round timer anymore, so `time` is
      // deliberately not accepted here.
      if (!patch || typeof patch !== 'object') return false;
      if (typeof patch.stocks === 'number') {
        matchSettings.stocks = ((Math.round(patch.stocks) - 1 + 5) % 5) + 1;
        persistSessionParams();
      }
      return true;
    },
    hitboxes() {
      return __debugHitboxes();
    },
    camera() {
      return getCameraState();
    },
    hud() {
      // What the HUD draws this frame: stocks pill (top center) + the
      // display-only stopwatch (bottom-left, when enabled). There is NO top
      // timer by design (Â§42) â€” hence no timer field here at all.
      return {
        stocks: [fighter1 ? fighter1.stocks : null, fighter2 ? fighter2.stocks : null],
        stopwatchOn: mapSettings.stopwatch !== false,
        stopwatchText: formatStopwatch(matchElapsed),
      };
    },
    attack(pn, key, dir) {
      const f = pn === 1 ? fighter1 : fighter2;
      return f ? startAttackForKey(f, key, dir) : false;
    },
    pose(pn) {
      return poseSnapshot(pn === 1 ? fighter1 : fighter2);
    },
    // Anatomical hand positions + orbit state, live (written by drawFighter).
    // Used to watch the facing-turn hand switch without rendering guesses.
    hands(pn) {
      const f = pn === 1 ? fighter1 : fighter2;
      if (!f) return null;
      const hw = f._handWorld;
      const o = f._orbit;
      const pt = (p) => (p ? { x: +p.x.toFixed(2), y: +p.y.toFixed(2) } : null);
      return {
        facingRight: !!f.facingRight,
        x: +f.x.toFixed(2), y: +f.y.toFixed(2),
        phi: o && typeof o.phi === 'number' ? +o.phi.toFixed(4) : null,
        orbitT: o ? +o.t.toFixed(4) : null,
        orbitActive: !!(o && o.t < 1),
        left: pt(hw && hw.left),
        right: pt(hw && hw.right),
        handL: pt(f._handL),
        handR: pt(f._handR),
      };
    },
    // Re-resolve the CURRENT animation frame for a given facing without
    // advancing it â€” the same updateAnimator/sampleInto path the renderer
    // consumes, so the returned numbers are what gets drawn.
    resolveAt(pn, facingRight) {
      const f = pn === 1 ? fighter1 : fighter2;
      if (!f || !f.anim) return null;
      const prev = f.facingRight;
      f.facingRight = !!facingRight;
      updateAnimator(f, 0);
      f.facingRight = prev;
      return poseSnapshot(f);
    },
    // Freeze/resume the animator on its current frame (renders a static pose).
    freezeAnim(pn, paused) {
      const f = pn === 1 ? fighter1 : fighter2;
      if (!f || !f.anim) return false;
      f.anim.paused = !!paused;
      return true;
    },
    // Whether an animation id exists in the library (refreshes from defaults on
    // a clean profile, so this verifies the SHIPPED library, not a stale save).
    animExists(id) {
      return !!getAnimation(id);
    },
    // Live snapshot of a fighter's in-flight projectiles (ability world).
    projectiles(pn) {
      const f = pn === 1 ? fighter1 : fighter2;
      return ((f && f._projectiles) || []).map(p => ({
        x: +p.x.toFixed(1), y: +p.y.toFixed(1),
        vx: +p.vx.toFixed(1), vy: +p.vy.toFixed(1),
        r: p.r,
        life: +p.life.toFixed(3),
        dead: !!p.dead,
        stuck: !!p.stuck,
        weaponId: p.weaponId || null,
        drawSize: p.drawSize || null,
        facing: p.facing,
        spin: +(p.spin || 0).toFixed(3),
        trail: p.trail || null,
        def: p.def ? {
          name: p.def.name, dmg: p.def.dmg,
          kbBase: p.def.kbBase, kbGrowth: p.def.kbGrowth,
          angle: p.def.angle, kbDir: p.def.kbDir,
        } : null,
        owner: p.owner ? p.owner.playerNum : null,
      }));
    },
    // Live snapshot of a fighter's mount (the cowboy's horse ride). Null when
    // not riding â€” lets tests watch the ride spawn/track/despawn.
    horse(pn) {
      const f = pn === 1 ? fighter1 : fighter2;
      const h = f && f._horse;
      if (!h) return null;
      return {
        x: +h.x.toFixed(1), y: +h.y.toFixed(1),
        dir: h.dir,
        sprite: h.sprite,
        drawW: h.drawW, drawH: h.drawH,
        lift: +h.lift.toFixed(1),
        def: h.def ? {
          name: h.def.name, dmg: h.def.dmg,
          kbBase: h.def.kbBase, kbGrowth: h.def.kbGrowth,
          angle: h.def.angle, w: h.def.w, h: h.def.h,
        } : null,
        hitboxActive: !!(h.hitboxId && __debugHitboxes().some(b => b.owner === pn)),
      };
    },
    // Live snapshot of a fighter's VFX: the animator-driven pool (the effects an
    // animation carries) and the temporary pool (effects an ability fires, such
    // as the Shadow Strike shadow dash). Lets a suite prove an effect spawns on
    // the cast frame, at the fighter's own position/direction/scale, and is gone
    // once the move ends â€” with no second copy and nothing left running.
    vfx(pn) {
      const f = pn === 1 ? fighter1 : fighter2;
      if (!f) return null;
      const inst = (v) => ({
        effect: v.effect,
        progress: +(+v.progress || 0).toFixed(3),
        anchor: v.anchor || null,
        mirrorX: v.mirrorX == null ? null : v.mirrorX,
        // A pinned effect draws at a fixed WORLD point instead of following the
        // fighter (the Teleport Strike's smoke stays on the spot the move was
        // activated on while the ninja blinks out of it).
        pinnedX: v.pinnedX == null ? null : +(+v.pinnedX).toFixed(1),
        pinnedY: v.pinnedY == null ? null : +(+v.pinnedY).toFixed(1),
        params: v.params ? {
          distance: +(+v.params.distance || 0).toFixed(1),
          unit: +(+v.params.unit || 0).toFixed(4),
        } : null,
      });
      return {
        animId: (f.anim && f.anim.animId) || null,
        anim: (f._vfxPool || []).map(inst),
        temp: (f._tempVfx || []).map(inst),
        x: +f.x.toFixed(1),
        y: +f.y.toFixed(1),
        facingRight: !!f.facingRight,
      };
    },
    // Hitbox-store control for tests: seed/clear a character+move custom box
    // (backed by the same localStorage hitboxData.js reads at attack time), so
    // the suite can prove a stored box can never break an ability move.
    setCustomHitbox(charId, animId, hbs) {
      setCustomHitboxes(charId, animId, hbs);
      return true;
    },
    clearCustomHitbox(charId, animId) {
      clearCustomHitboxes(charId, animId);
      return true;
    },
    // Live snapshot of a fighter's Deadeye state (cowboy Down Light): the
    // active counter, how many shots are in flight/resolved, the locked target
    // and each bullet's position. Null payload when idle.
    deadeye(pn) {
      const f = pn === 1 ? fighter1 : fighter2;
      if (!f) return null;
      const d = f._deadeye;
      const r = f._deadeyeResult; // tally of the last completed volley
      return {
        live: !!d,
        shotsFired: d ? d.shotsFired : (r ? r.fired : 0),
        resolved: d ? d.resolved : (r ? r.resolved : 0),
        hits: d ? d.hits : (r ? r.hits : 0),
        expired: d ? d.expired : (r ? r.expired : 0),
        bulletCount: d ? d.cfg.bulletCount : (r ? r.fired : 0),
        bulletSize: d ? d.cfg.bulletSize : 0,
        target: d && d.target ? {
          pn: d.target.playerNum,
          x: +d.target.x.toFixed(1),
          y: +d.target.y.toFixed(1),
        } : null,
        bullets: ((f && f._deadeyeBullets) || []).map(b => ({
          x: +b.x.toFixed(1), y: +b.y.toFixed(1),
          dead: !!b.dead, life: +b.life.toFixed(2),
        })),
      };
    },
    // The attack def the game would actually use for a key right now â€” the same
    // resolution an in-game press goes through (customize store first).
    resolvedDef(key) {
      const f = fighter1;
      const d = f && resolveAttackDef(key, f);
      if (!d) return null;
      const hbs = Array.isArray(d.hitboxes) ? d.hitboxes : (d.abilityType === 'nonHitbox' ? [] : [d]);
      return {
        name: d.name, anim: d.anim || null,
        startup: d.startup, active: d.active, recovery: d.recovery,
        dmg: d.dmg, kbBase: d.kbBase, kbGrowth: d.kbGrowth, angle: d.angle,
        horizontalKnockback: d.horizontalKnockback,
        verticalKnockback: d.verticalKnockback,
        w: d.w, h: d.h, ox: d.ox, oy: d.oy,
        recoveryX: d.recoveryX != null ? d.recoveryX : 0,
        recoveryY: d.recoveryY != null ? d.recoveryY : 0,
        recoveryDuration: d.recoveryDuration != null ? d.recoveryDuration : 0,
        abilityType: d.abilityType || 'hitbox',
        abilityId: d.abilityId || null,
        // A non-hitbox move's own frame budget: how long the ability lasts, the
        // frame it casts on, and â€” for a delayed one like the Teleport Strike â€”
        // how long it charges before it acts.
        abilityFrames: d.abilityFrames != null ? d.abilityFrames : null,
        abilityCastFrame: d.abilityCastFrame != null ? d.abilityCastFrame : null,
        abilityDelayFrames: d.abilityDelayFrames != null ? d.abilityDelayFrames : null,
        // Move-specific behaviour budgets: the Shadow Dash's fixed forward
        // travel, and the Shuriken Throw's on-hit lock.
        dashDistance: d.dashDistance != null ? d.dashDistance : null,
        hitLockDuration: d.hitLockDuration != null ? d.hitLockDuration : null,
        hitboxes: hbs.length,
      };
    },
    // Live snapshot of the global time-dilation effect (cowboy Down Light):
    // active/factor/tint/flash so tests (and the renderer) read the same
    // numbers. Null/zeros when no effect is running.
    effect() {
      return timeDilationState();
    },
    // Live snapshot of the pooled world visual effects layer.
    worldFx() {
      return worldFxState();
    },
    // Drive the REAL Hitbox Customizer save path: open it for the Cowboy, load a
    // move, set its attack recovery (box 0), save, close. Returns the saved box
    // (or null). `reset` clears the stored override afterwards â€” the tests use
    // it to prove saveâ†’apply without leaving permanent store pollution.
    aiTraining() {
      return {
        open: () => { enterAITraining(); return true; },
        close: () => { exitAITraining(); return true; },
        set: (patch) => {
          if (!patch || typeof patch !== 'object') return false;
          const n = ALL_FIGHTERS.length;
          if (Number.isInteger(patch.ai1)) trainSettings.ai1 = Math.max(0, Math.min(n - 1, patch.ai1));
          if (Number.isInteger(patch.ai2)) trainSettings.ai2 = Math.max(0, Math.min(n - 1, patch.ai2));
          if (Number.isFinite(patch.populationSize)) trainSettings.populationSize = Math.max(2, Math.min(200, patch.populationSize | 0));
          if (Number.isFinite(patch.maxGenerations)) trainSettings.maxGenerations = Math.max(1, Math.min(2000, patch.maxGenerations | 0));
          if (Number.isFinite(patch.mutationRate)) trainSettings.mutationRate = Math.min(0.2, Math.max(0.005, patch.mutationRate));
          if (typeof patch.speed === 'string' && TRAIN_SPEEDS.includes(patch.speed)) trainSettings.speed = patch.speed;
          if (typeof patch.showSim === 'boolean') trainSettings.showSim = patch.showSim;
          if (typeof patch.mode === 'string' && ['matchup', 'character', 'general'].includes(patch.mode)) trainSettings.mode = patch.mode;
          if (typeof patch.oppType === 'string' && ['coevolve', 'trained', 'scripted', 'dummy'].includes(patch.oppType)) trainSettings.oppType = patch.oppType;
          if (typeof patch.startMode === 'string' && ['new', 'continue'].includes(patch.startMode)) trainSettings.startMode = patch.startMode;
          if (typeof patch.scriptedDifficulty === 'string') trainSettings.scriptedDifficulty = patch.scriptedDifficulty;
          if (Number.isFinite(patch.evalMatches)) trainSettings.evalMatches = Math.max(1, Math.min(20, patch.evalMatches | 0));
          persistAIConfig();
          try { renderTermMenu(); } catch (_) {}
          return true;
        },
        start: () => startTraining(),
        stop: () => stopTraining(),
        pause: () => pauseTraining(),
        resume: () => resumeTraining(),
        running: () => isTraining(),
        progress: () => (activeTrainer ? activeTrainer.snapshot() : trainProgress || trainDoneInfo || null),
        history: () => { try { return listRunHistory(50); } catch (_) { return []; } },
        run: (id) => { try { return getRun(id); } catch (_) { return null; } },
        models: (charId) => { try { return listModels(charId); } catch (_) { return []; } },
        model: (charId, id) => { try { return getModel(charId, id); } catch (_) { return null; } },
        activate: (charId, id) => { try { return activateModel(charId, id); } catch (_) { return false; } },
        rename: (charId, id, name) => { try { return renameModel(charId, id, name); } catch (_) { return false; } },
        duplicate: (charId, id, name) => { try { return duplicateModel(charId, id, name); } catch (_) { return { ok: false }; } },
        remove: (charId, id) => { try { return deleteModel(charId, id); } catch (_) { return false; } },
        exportJson: (charId, id) => { try { return exportModel(charId, id); } catch (_) { return { ok: false }; } },
        importJson: (json, opts) => { try { return importModel(json, opts || {}); } catch (_) { return { ok: false }; } },
        checkpoint: (charId) => { try { return loadCheckpoint(charId); } catch (_) { return null; } },
        evalModel: (charId, id, matches) => {
          try {
            const def = ALL_FIGHTERS.find((f) => f.id === charId);
            const m = def ? getModel(charId, id) : null;
            if (!def || !m) return { ok: false, error: 'model not found' };
            const oppDef = ALL_FIGHTERS[(ALL_FIGHTERS.indexOf(def) + 1) % ALL_FIGHTERS.length] || def;
            return evaluateModels({
              defA: def, defB: oppDef,
              genomeA: { weights: m.weights, behavior: m.behavior },
              oppB: { kind: 'scripted', difficulty: 'Normal', charId: oppDef.id },
              matches: Math.max(1, Math.min(20, matches | 0 || 4)),
            });
          } catch (_) { return { ok: false, error: 'eval failed' }; }
        },
      };
    },
    setDifficulty(name) {
      if (!AI_DIFFICULTIES.includes(name)) return false;
      matchSettings.aiDifficulty = name;
      persistAIConfig();
      try { renderTermMenu(); } catch (_) {}
      return true;
    },
    setMode(name) {
      if (!GAME_MODES.includes(name)) return false;
      gameMode = name;
      persistSessionParams();
      try { renderTermMenu(); } catch (_) {}
      return true;
    },
    // Session autosave: `params()` reads back what is stored, `save(patch)`
    // writes it, `clear()` forgets it so the next load starts from the defaults.
    autosave() {
      return {
        params: () => loadSessionParams(ALL_FIGHTERS.length),
        has: () => hasSessionParams(),
        save: (patch) => {
          if (!patch || typeof patch !== 'object') return false;
          const ok = saveSessionParams(patch, ALL_FIGHTERS.length);
          if (ok) {
            // Apply immediately so a test that saves then reads live state (or
            // starts a match) sees the same values the next page load would.
            const next = loadSessionParams(ALL_FIGHTERS.length);
            matchSettings.p1 = next.p1;
            matchSettings.p2 = next.p2;
            matchSettings.stocks = next.stocks;
            gameMode = next.gameMode;
          }
          return ok;
        },
        clear: () => {
          const ok = clearSessionParams();
          if (ok) {
            const next = loadSessionParams(ALL_FIGHTERS.length);
            matchSettings.p1 = next.p1;
            matchSettings.p2 = next.p2;
            matchSettings.stocks = next.stocks;
            gameMode = next.gameMode;
          }
          return ok;
        },
        reset: () => {
          const ok = clearSessionParams();
          if (ok) {
            matchSettings.p1 = 0;
            matchSettings.p2 = 0;
            matchSettings.stocks = 3;
            gameMode = 'playerVsPlayer';
          }
          return ok;
        },
      };
    },
    aiScores(pn, limit) {
      try {
        const c = pn === 1 ? aiControllers[0] : aiControllers[1];
        if (!c || typeof c.debugScores !== 'function') return [];
        return c.debugScores(limit);
      } catch (e) {
        return [];
      }
    },
    aiConfig(name, charId) {
      try {
        const c = configForDifficulty(name, charId);
        return {
          personality: c.personality,
          mistakeRate: c.mistakeRate,
          neuroInfluence: c.neuroInfluence,
          hasModel: Array.isArray(c.neuroWeights),
          weightCount: Array.isArray(c.neuroWeights) ? c.neuroWeights.length : 0,
        };
      } catch (e) {
        return { error: String(e) };
      }
    },
    customRecovery(moveKey, patch, opts) {
      openHitboxCustomizer(canvas, () => ({ ...ALL_FIGHTERS[0] }));
      setCustomizerMove(moveKey);
      for (const k of ['recoveryX', 'recoveryY', 'recoveryDuration']) {
        if (patch && typeof patch[k] === 'number') setWorkingBoxValue(0, k, patch[k]);
      }
      const saved = saveCustomizer();
      const box = getWorkingBoxes()[0] || null;
      if (opts && opts.reset) resetCustomizerMove(moveKey);
      closeHitboxCustomizer();
      return saved && box ? box : null;
    },
    // The customizer's LIVE click regions (id + rect), and its open state. Lets
    // the suite drive the real canvas buttons by coordinate instead of guessing
    // pixels: open the panel, look up the +/- button's rect, and dispatch real
    // pointer events at it to prove a held increment stops on release.
    customizerUi() {
      return {
        open: isHitboxCustomizerOpen(),
        hits: hitboxCustomizerHits(),
      };
    },
    customizerMove(k) {
      setCustomizerMove(k);
      return true;
    },
    customizerBoxes() {
      return getWorkingBoxes();
    },
    customizerOpen(open) {
      // Mirror openHitboxCustomizerEditor / closeHitboxCustomizerEditor: the
      // panel only renders (and so only registers its click regions) while the
      // game state is 'hitboxes', so opening the editor alone would leave a
      // live but unpainted panel.
      if (open) {
        _hcPrevState = currentGameState;
        if (selectOverlay) selectOverlay.style.display = 'none';
        openHitboxCustomizer(canvas, () => ({ ...ALL_FIGHTERS[0] }));
        currentGameState = 'hitboxes';
      } else {
        closeHitboxCustomizer();
        currentGameState = _hcPrevState || 'menu';
      }
      return isHitboxCustomizerOpen();
    },
  };
}

// In-match damage panel helpers: P1 = cursor 0, P2 = 1. Percent is the damage
// meter only (knockback scales off it); editing it can never end a match,
// which still ends on stocks/blast zones alone.
function tweakTarget() { return tweakCursor === 0 ? fighter1 : fighter2; }
function tweakNudge(dir, step) {
  const f = tweakTarget();
  if (!f) return;
  tweakDraft = '';
  f.percent = Math.min(999, Math.max(0, f.percent + dir * step));
}
function tweakTypeDigit(d) {
  if (tweakDraft.length >= 3) return;
  tweakDraft += d;
  const v = parseInt(tweakDraft, 10);
  if (Number.isFinite(v)) {
    const f = tweakTarget();
    if (f) f.percent = Math.min(999, Math.max(0, v));
  }
}
function tweakEraseDigit() {
  tweakDraft = tweakDraft.slice(0, -1);
}
function tweakResetRow() {
  const f = tweakTarget();
  if (!f) return;
  tweakDraft = '';
  f.percent = 0;
}
function closeTweakWindow() {
  tweakEditing = false;
  tweakDraft = '';
  try { flushInput(); } catch (_) {} // drop UI-navigation edges so they never leak into gameplay
}

// Hitbox overlay toggle: ` (backtick) shows the active hitboxes in the arena.
// M during free play exits back to the terminal menu (no page reload needed).
// In the sandbox M leaves the sandbox entirely for the same menu.
function onPlayKey(e) {
  const inPlay = currentGameState === 'playing' || currentGameState === 'ready';
  // Damage-panel editing first: while focused, gameplay keys drive the panel
  // (the sim is frozen, so nothing moves) and repeat scrolls values.
  if (tweakEditing && currentGameState === 'playing') {
    const k = e.code;
    if (k === 'ArrowUp' || k === 'KeyW') { e.preventDefault(); tweakCursor = (tweakCursor + 1) % 2; tweakDraft = ''; return; }
    if (k === 'ArrowDown' || k === 'KeyS') { e.preventDefault(); tweakCursor = (tweakCursor + 1) % 2; tweakDraft = ''; return; }
    if (k === 'ArrowLeft' || k === 'KeyA' || k === 'ArrowRight' || k === 'KeyD') {
      e.preventDefault();
      const dir = (k === 'ArrowLeft' || k === 'KeyA') ? -1 : 1;
      tweakNudge(dir, e.shiftKey ? 10 : 1);
      return;
    }
    if (k.slice(0, 5) === 'Digit' || k.slice(0, 7) === 'Numpad') {
      const d = k.slice(0, 5) === 'Digit' ? k.slice(5) : k.slice(7);
      if (d >= '0' && d <= '9') { e.preventDefault(); tweakTypeDigit(d); return; }
    }
    if (k === 'Backspace') { e.preventDefault(); tweakEraseDigit(); return; }
    if (k === 'Enter' || k === 'NumpadEnter' || k === 'Space') {
      e.preventDefault();
      if (tweakDraft === '') tweakResetRow();
      else { tweakDraft = ''; }
      return;
    }
    if (k === 'Escape' || k === 'KeyT') { e.preventDefault(); closeTweakWindow(); return; }
    // Anything else (e.g. M) falls through to the normal handling below.
  }
  if (e.code === 'KeyT' && currentGameState === 'playing' && fighter1 && fighter2) {
    e.preventDefault();
    if (tweakEditing) closeTweakWindow();
    else { tweakEditing = true; tweakCursor = 0; tweakDraft = ''; }
  } else if (e.code === 'Backquote' && (inPlay || currentGameState === 'sandboxPlay')) {
    e.preventDefault();
    showHitboxes = !showHitboxes;
  } else if (e.code === 'KeyM') {
    if (inPlay) {
      e.preventDefault();
      returnToMenu();
    } else if (currentGameState === 'sandboxPlay') {
      e.preventDefault();
      endSandboxPlay();
      showSelectOverlay();
    } else if (currentGameState === 'sandbox') {
      e.preventDefault();
      closeSandboxEditor();
    }
  } else if (currentGameState === 'sandboxPlay' && !e.repeat) {
    // Sandbox-only session keys. I and V are both P1 'grab' bindings, so they
    // are read as raw codes rather than as one action edge. None of these are
    // bound in Input.js, so nothing here competes with the roster's controls.
    if (e.code === 'KeyI') {
      e.preventDefault();
      toggleSandboxPause();
    } else if (e.code === 'KeyV') {
      e.preventDefault();
      setSandboxTimeScale(getSandboxTimeScale() > 0.5 ? 0.25 : 1);
    } else if (e.code === 'KeyB') {
      e.preventDefault();
      toggleSandboxDebug();
    } else if (e.code === 'Escape') {
      e.preventDefault();
      returnToSandboxEditor();
    }
  }
}

// Leave free play and return to the MENU state. Resets combat leftovers
// (damage, hit locks, in-flight projectiles, the camera, the debug hitbox
// overlay) so the next match starts clean â€” the menu paints an opaque
// background, so nothing from the match carries over visually either.
function returnToMenu() {
  showHitboxes = false;
  tweakEditing = false; tweakDraft = '';
  matchOver = false;
  matchWinner = null;
  matchOverAge = 0;
  matchElapsed = 0;
  resetTimeDilation(); // a lingering slow-mo effect must not survive the match
  for (const f of fightersPair()) {
    if (f) softResetFighter(f, stage);
  }
  resetCombat();
  resetCamera();
  // Drop AI controllers completely: they reference match fighters and must not
  // survive into the menu (or leak across mode switches/restarts).
  for (const c of aiControllers) {
    if (c && typeof c.dispose === 'function') {
      try { c.dispose(); } catch (_) {}
    }
  }
  aiControllers[0] = null;
  aiControllers[1] = null;
  showSelectOverlay();
}

function showSelectOverlay() {
  if (selectOverlay) selectOverlay.style.display = 'flex';
  currentGameState = 'menu';
  isPaused = false;
  tweakEditing = false; tweakDraft = '';
  renderTermMenu();
}

// â”€â”€ Terminal start menu â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function termValue(row) {
  switch (row.id) {
    case 'player':   return ALL_FIGHTERS[matchSettings.p1].name;
    case 'opponent': return ALL_FIGHTERS[matchSettings.p2].name;
    case 'skins':    return 'EDIT';
    case 'accys':    return 'EDIT';
    case 'anim':     return 'OPEN';
    case 'hit':      return 'OPEN';
    case 'sandbox':  return 'OPEN';
    case 'settings': return ' ';
    case 'mode':     return gameModeLabels[gameMode];
    case 'aiDifficulty': {
      const d = matchSettings.aiDifficulty || 'Normal';
      const trainedMark = (() => {
        try {
          const def = ALL_FIGHTERS[matchSettings.p2];
          if ((d === 'Hard' || d === 'Expert' || d === 'Trained') && def && loadTrainedModel(def.id)) return '*';
        } catch (_) {}
        return '';
      })();
      return d.toUpperCase() + trainedMark;
    }
    case 'stocks':   return String(matchSettings.stocks);
    case 'aiTraining': return isTraining() ? 'RUNNING' : 'OPEN';
    case 'start':    return 'ENTER';
    default:         return '';
  }
}

function termCycle(row, dir) {
  if (row.id === 'player') {
    matchSettings.p1 = (matchSettings.p1 + dir + ALL_FIGHTERS.length) % ALL_FIGHTERS.length;
    persistSessionParams();
  } else if (row.id === 'opponent') {
    matchSettings.p2 = (matchSettings.p2 + dir + ALL_FIGHTERS.length) % ALL_FIGHTERS.length;
    persistSessionParams();
  } else if (row.id === 'mode') {
    const currentIndex = GAME_MODES.indexOf(gameMode);
    gameMode = GAME_MODES[(currentIndex + dir + GAME_MODES.length) % GAME_MODES.length];
    persistSessionParams();
  } else if (row.id === 'aiDifficulty') {
    const idx = AI_DIFFICULTIES.indexOf(matchSettings.aiDifficulty);
    const next = AI_DIFFICULTIES[(idx + dir + AI_DIFFICULTIES.length) % AI_DIFFICULTIES.length];
    matchSettings.aiDifficulty = next;
    persistAIConfig();
  } else if (row.id === 'stocks') {
    // 1â€“5 stocks, wraps around in both directions.
    matchSettings.stocks = ((matchSettings.stocks - 1 + dir + 5) % 5) + 1;
    persistSessionParams();
  }
}

function enterSkinEditor() {
  termMode = 'skins';
  renderTermMenu();
}

function exitSkinEditor() {
  termMode = 'main';
  renderTermMenu();
}

function enterAccyEditor() {
  termMode = 'accys';
  renderTermMenu();
}

function exitAccyEditor() {
  termMode = 'main';
  renderTermMenu();
}

function enterGearEditor() {
  termMode = 'handGear';
  termGearCursor = 0;
  renderTermMenu();
}

function exitGearEditor() {
  termMode = 'main';
  renderTermMenu();
}

function enterMapSettings() {
  termMode = 'mapSettings';
  termMapCursor = 0;
  renderTermMenu();
}

function exitMapSettings() {
  termMode = 'main';
  renderTermMenu();
}

// ── Custom hex colors (map settings) ─────────────────────────────────────
// Normalize user input to #rrggbb (accepts #rgb, #rrggbb, with/without #).
// Returns null when the input is not a valid hex color.
function normalizeHexColor(input) {
  if (input == null) return null;
  let s = String(input).trim().toLowerCase();
  if (s === 'default') return 'DEFAULT';
  if (s[0] === '#') s = s.slice(1);
  if (/^[0-9a-f]{3}$/.test(s)) s = s[0] + s[0] + s[1] + s[1] + s[2] + s[2];
  if (!/^[0-9a-f]{6}$/.test(s)) return null;
  return '#' + s;
}

// Apply a validated custom color to a map color row (persist + repaint).
function applyMapColor(row, value) {
  if (row.id === 'mapBgColor') {
    mapSettings.backgroundColor = value;
    persistMapSettings();
    rebuildBackgroundCanvas();
  } else if (row.id === 'mapPlatColor') {
    mapSettings.platformColor = (value === 'DEFAULT') ? null : value;
    persistMapSettings();
    if (stage && stage.platforms) {
      for (const plat of stage.platforms) {
        plat._customGradient = null;
        plat._customColor = null;
      }
    }
  }
  renderTermMenu();
}

function cycleMapSetting(row, dir) {
  if (row.id === 'mapBgColor') {
    // Cycle through some preset colors or allow custom input
    const presets = [DEFAULT_BACKGROUND_COLOR, '#ffffff', '#3498db', '#e74c3c', '#2ecc71', '#f39c12', '#9b59b6', '#000000', '#1a1a1a', '#0d1b2a', '#1b1b2f', '#2d1b1b', '#1b2d1b'];
    const current = mapSettings.backgroundColor;
    const idx = presets.indexOf(current);
    const nextIdx = (idx + dir + presets.length) % presets.length;
    mapSettings.backgroundColor = presets[nextIdx];
    persistMapSettings();
    rebuildBackgroundCanvas();
  } else if (row.id === 'mapPlatColor') {
    const presets = [null, '#ffffff', '#cccccc', '#888888', '#444444', '#ff0000', '#00ff00', '#0000ff', '#ffff00', '#ff00ff', '#00ffff'];
    const current = mapSettings.platformColor;
    const idx = presets.indexOf(current);
    const nextIdx = (idx + dir + presets.length) % presets.length;
    mapSettings.platformColor = presets[nextIdx];
    persistMapSettings();
    // Clear custom gradient cache so platforms redraw with new color
    if (stage && stage.platforms) {
      for (const plat of stage.platforms) {
        plat._customGradient = null;
        plat._customColor = null;
      }
    }
  } else if (row.id === 'stopwatch') {
    // Â§42 stopwatch toggle: display-only clock on/off. Gameplay-agnostic.
    mapSettings.stopwatch = !(mapSettings.stopwatch !== false);
    persistMapSettings();
  } else if (row.id === 'showStocks') {
    // Top-of-screen stock pill on/off. Display-only — stocks are still tracked
    // and a match still ends at zero, the pill is simply not drawn.
    mapSettings.showStocks = !(mapSettings.showStocks !== false);
    persistMapSettings();
  } else if (row.id === 'showMatchup') {
    // Stage versus banner ("X vs Y") on/off. Display-only — the matchup is
    // unchanged, the background text is simply not drawn.
    mapSettings.showMatchup = !(mapSettings.showMatchup !== false);
    persistMapSettings();
  } else if (row.id === 'quality') {
    // Render quality scaler (HIGH default = full visuals). Gameplay-agnostic:
    // only the ability-particle spawn counts change.
    const order = QUALITY_ORDER;
    const cur = order.indexOf(mapSettings.quality || 'high');
    mapSettings.quality = order[(cur + dir + order.length) % order.length];
    persistMapSettings();
    applyQuality();
  } else if (row.id === 'resolution') {
    // Internal rendering resolution (PERFORMANCE default). PERFORMANCE =
    // adaptive tier scaling (smoothness first); 720p/1080p/1440p pin the
    // backing line count. Render-only: world units, physics and camera framing
    // never see it. Applies live — no restart — via the next frame's store sync.
    const order = RESOLUTION_ORDER;
    const cur = order.indexOf(mapSettings.resolution || 'performance');
    mapSettings.resolution = order[(cur + dir + order.length) % order.length];
    persistMapSettings();
    applyQuality();
  } else if (row.id === 'dzLeft' || row.id === 'dzRight' || row.id === 'dzTop' || row.id === 'dzBottom') {
    // Death-zone margin per edge (px beyond the arena). Live-applies to the
    // active stage so KO detection uses it immediately; validated + persisted.
    const key = row.id === 'dzLeft' ? 'left' : row.id === 'dzRight' ? 'right' : row.id === 'dzTop' ? 'top' : 'bottom';
    mapSettings.deathZone = sanitizeDeathZone(mapSettings.deathZone);
    const cur = mapSettings.deathZone[key] || 0;
    mapSettings.deathZone[key] = Math.max(DEATHZONE_MIN, Math.min(DEATHZONE_MAX, cur + dir * DEATHZONE_STEP));
    persistMapSettings();
    syncDeathZoneToStage();
  } else if (row.id === 'dzReset') {
    mapSettings.deathZone = { ...DEFAULT_DEATH_MARGINS };
    persistMapSettings();
    syncDeathZoneToStage();
  }
  renderTermMenu();
}

function renderMapSettings() {
  if (!termLinesEl) return;
  termLinesEl.innerHTML = '';
  updateTermHints();
  const header = document.createElement('div');
  header.className = 'term-row head';
  header.textContent = 'MAP SETTINGS';
  termLinesEl.appendChild(header);

  MAP_SETTINGS_ROWS.forEach((row, i) => {
    const isOn = i === termMapCursor;
    const line = document.createElement('div');
    line.className = 'term-row' + (isOn ? ' on' : '');
    const numText = (i < 9 ? ' ' : '') + (i + 1);
    const label = row.label;

    const key = document.createElement('span');
    key.className = 'k';
    key.textContent = `${isOn ? '>' : ' '} [${numText}] ${label}${'.'.repeat(Math.max(1, 22 - label.length))}`;

    const val = document.createElement('span');
    val.className = 'v';
    const value = typeof row.value === 'function' ? row.value() : row.value;
    val.textContent = value || 'DEFAULT';

    line.appendChild(key);
    line.appendChild(val);

    if (row.type === 'color') {
      line.addEventListener('click', () => {
        if (termMapCursor === i) cycleMapSetting(row, 1);
        termMapCursor = i;
        SFX.menuSelect();
        renderTermMenu();
      });
      // Inline custom color: native swatch picker + hex text field, so any
      // hex code can be typed without cycling presets. Events are stopped
      // from reaching the row (no preset cycle) and the window key handler
      // (no menu shortcuts fire while typing).
      try {
        const cur = String(typeof row.value === 'function' ? row.value() : row.value || '');
        const norm = normalizeHexColor(cur);
        const pick = document.createElement('input');
        pick.type = 'color';
        pick.className = 'swatch';
        pick.title = 'Pick a custom color';
        pick.value = norm && norm !== 'DEFAULT' ? norm : '#87cefa';
        pick.addEventListener('click', (e) => e.stopPropagation());
        pick.addEventListener('input', () => applyMapColor(row, pick.value));
        line.appendChild(pick);
        const hex = document.createElement('input');
        hex.type = 'text';
        hex.className = 'hex';
        hex.value = cur || '';
        hex.maxLength = 7;
        hex.spellcheck = false;
        hex.placeholder = '#rrggbb';
        hex.title = 'Type a hex color, Enter to apply';
        hex.addEventListener('click', (e) => e.stopPropagation());
        hex.addEventListener('keydown', (e) => {
          e.stopPropagation();
          if (e.code === 'Enter' || e.code === 'NumpadEnter') {
            const v = normalizeHexColor(hex.value);
            if (v) applyMapColor(row, v);
            else hex.value = cur || '';
            hex.blur();
          } else if (e.code === 'Escape') {
            hex.value = cur || '';
            hex.blur();
          }
        });
        hex.addEventListener('change', () => {
          const v = normalizeHexColor(hex.value);
          if (v) applyMapColor(row, v);
          else hex.value = cur || '';
        });
        line.appendChild(hex);
      } catch (_) {}
    } else if (row.type === 'toggle') {
      line.addEventListener('click', () => {
        termMapCursor = i;
        SFX.menuSelect();
        cycleMapSetting(row, 1);
      });
    } else if (row.type === 'quality') {
      line.addEventListener('click', () => {
        termMapCursor = i;
        SFX.menuSelect();
        cycleMapSetting(row, 1);
      });
    } else if (row.type === 'resolution') {
      line.addEventListener('click', () => {
        termMapCursor = i;
        SFX.menuSelect();
        cycleMapSetting(row, 1);
      });
    } else if (row.type === 'deathzone') {
      line.addEventListener('click', () => {
        termMapCursor = i;
        SFX.menuSelect();
        cycleMapSetting(row, 1);
      });
    } else if (row.type === 'deathzoneReset') {
      line.addEventListener('click', () => {
        termMapCursor = i;
        SFX.menuSelect();
        cycleMapSetting(row, 1);
      });
    } else if (row.type === 'action') {
      line.addEventListener('click', () => {
        SFX.menuSelect();
        exitMapSettings();
      });
    }
    termLinesEl.appendChild(line);
  });
  // Live side preview: the actual map inside its death-zone box. The whole
  // preview fits the DEATH ZONE (outer red box); the arena + platforms draw
  // inside at their true relative size, so widening a margin visibly pushes
  // the KO line outward and shrinking pulls it in. Visual aid only.
  try { drawDeathZonePreview(); } catch (_) {}
}

// Death-zone preview on the menu side canvas (hand-preview). Layout mirrors
// createDefaultStage proportions so it reads as the real map: sky fill,
// main ground + floating platform, spawn dots, arena edge (white) and the
// death-zone KO box (red, dashed). The selected edge row highlights yellow.
function drawDeathZonePreview() {
  if (!previewCtx || !previewCanvas) return;
  const pctx = previewCtx;
  const W = previewCanvas.width, H = previewCanvas.height;
  const dz = sanitizeDeathZone(mapSettings.deathZone);
  const bz = blastRectFor(arena.width, arena.height, dz);
  // Fit the whole DEATH ZONE into the canvas with a label band on top.
  const topBand = 64;
  const pad = 14;
  const availW = W - pad * 2, availH = H - topBand - pad;
  const bw = Math.max(1, bz.right - bz.left), bh = Math.max(1, bz.bottom - bz.top);
  const s = Math.min(availW / bw, availH / bh);
  const ox = pad + (availW - bw * s) / 2 - bz.left * s;
  const oy = topBand + (availH - bh * s) / 2 - bz.top * s;
  const X = (wx) => ox + wx * s;
  const Y = (wy) => oy + wy * s;

  pctx.clearRect(0, 0, W, H);
  pctx.fillStyle = '#f3ead1';
  pctx.fillRect(0, 0, W, H);
  // Title + live values.
  pctx.textAlign = 'center';
  pctx.fillStyle = '#111';
  pctx.font = 'bold 15px monospace';
  pctx.fillText('DEATH ZONE PREVIEW', W / 2, 22);
  pctx.font = '11px monospace';
  pctx.fillStyle = '#555';
  pctx.fillText(`L${dz.left >= 0 ? '+' : ''}${dz.left} R${dz.right >= 0 ? '+' : ''}${dz.right} T${dz.top >= 0 ? '+' : ''}${dz.top} B${dz.bottom >= 0 ? '+' : ''}${dz.bottom} px`, W / 2, 40);
  pctx.fillText('red = KO line  ·  white = arena edge', W / 2, 54);

  // Death-zone KO box (outer). The preview IS the size of the deadzone.
  pctx.save();
  pctx.strokeStyle = '#c0392b';
  pctx.lineWidth = 2;
  pctx.setLineDash([6, 4]);
  pctx.strokeRect(X(bz.left), Y(bz.top), bw * s, bh * s);
  pctx.setLineDash([]);
  pctx.fillStyle = 'rgba(192,57,43,0.08)';
  pctx.fillRect(X(bz.left), Y(bz.top), bw * s, bh * s);
  pctx.restore();

  // Arena (inner — full height including the deep pit; stage layout itself is
  // anchored to the top-1080 vista, same as in-game).
  pctx.fillStyle = mapSettings.backgroundColor || '#87CEFA';
  pctx.fillRect(X(0), Y(0), arena.width * s, arena.height * s);
  pctx.strokeStyle = '#ffffff';
  pctx.lineWidth = 2;
  pctx.strokeRect(X(0), Y(0), arena.width * s, arena.height * s);

  // Platforms at the real anchored stage proportions (groundY=.78*1080,
  // width=.65W, floater -140) — identical to buildMatchStage.
  try {
    const gY = VIEW_H * 0.78, gW = arena.width * 0.65, gX = (arena.width - gW) / 2;
    const pW = arena.width * 0.14, pX = arena.width / 2 - pW / 2, pY = gY - 140;
    pctx.fillStyle = mapSettings.platformColor || '#3a5a3a';
    pctx.fillRect(X(gX), Y(gY), gW * s, Math.max(2, 16 * s));
    pctx.fillStyle = '#4a7a4a';
    pctx.fillRect(X(pX), Y(pY), pW * s, Math.max(2, 12 * s));
    // Spawn dots.
    pctx.fillStyle = '#111';
    for (const sx of [arena.width * 0.35, arena.width * 0.65]) {
      pctx.beginPath();
      pctx.arc(X(sx), Y(gY - 30), Math.max(2.5, 6 * s), 0, Math.PI * 2);
      pctx.fill();
    }
  } catch (_) {}

  // Highlight the selected edge row, if any.
  try {
    const row = MAP_SETTINGS_ROWS[termMapCursor];
    const edge = row && row.id === 'dzLeft' ? 'left' : row && row.id === 'dzRight' ? 'right' : row && row.id === 'dzTop' ? 'top' : row && row.id === 'dzBottom' ? 'bottom' : null;
    if (edge) {
      pctx.save();
      pctx.strokeStyle = '#f1c40f';
      pctx.lineWidth = 3;
      pctx.beginPath();
      if (edge === 'left') { pctx.moveTo(X(bz.left), Y(bz.top)); pctx.lineTo(X(bz.left), Y(bz.bottom)); }
      else if (edge === 'right') { pctx.moveTo(X(bz.right), Y(bz.top)); pctx.lineTo(X(bz.right), Y(bz.bottom)); }
      else if (edge === 'top') { pctx.moveTo(X(bz.left), Y(bz.top)); pctx.lineTo(X(bz.right), Y(bz.top)); }
      else { pctx.moveTo(X(bz.left), Y(bz.bottom)); pctx.lineTo(X(bz.right), Y(bz.bottom)); }
      pctx.stroke();
      pctx.restore();
    }
  } catch (_) {}
}

// â”€â”€ AI TRAINING submenu â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Native part of the terminal menu: pick both characters (from the live
// roster â€” never hardcoded), population, generations, mutation, speed, then
// evolve. Progress reuses the same term-lines DOM as every other submenu.
let termTrainCursor = 0;
let activeTrainer = null;
let trainProgress = null;   // last onProgress snapshot
let trainLive = null;       // last onLive per-chunk snapshot
let trainDoneInfo = null;   // onDone payload ({reason, saved, ...})
let _lastTrainRender = 0;

const TRAIN_POP_PRESETS = [10, 20, 30, 50, 80, 100, 150, 200];
const TRAIN_GEN_PRESETS = [5, 25, 50, 100, 250, 500, 1000];
const TRAIN_MUT_PRESETS = [0.01, 0.03, 0.05, 0.08, 0.12];
const TRAIN_EVAL_PRESETS = [2, 4, 6, 10];
const TRAIN_SPEEDS = ['Normal', 'Fast', 'Fastest'];
const TRAIN_SPEED_FRAMES = { Normal: 400, Fast: 1200, Fastest: 3000 };

function isTraining() {
  try { return !!(activeTrainer && activeTrainer.isRunning()); } catch (_) { return false; }
}

// The training preview renders the live bout with the EXACT same draw calls
// as a real match (stage, fighters, horses, projectiles, health bars), just
// scaled 0.5x â€” so it looks like the actual game. The canvas is enlarged
// while this submenu is open and restored on exit.
const TRAIN_PREVIEW_W = 600;
const TRAIN_PREVIEW_H = 550;
const TRAIN_PREVIEW_SCALE = 0.5;
let _previewSaved = null;

function enterAITraining() {
  termMode = 'aiTraining';
  termTrainCursor = 0;
  trainView = 'setup';
  trainDoneInfo = null;
  try { refreshTrainCaches(); } catch (_) {}
  try {
    if (previewCanvas && !_previewSaved) {
      const termWindow = document.getElementById('term-window');
      _previewSaved = {
        w: previewCanvas.width,
        h: previewCanvas.height,
        styleW: previewCanvas.style.width,
        styleH: previewCanvas.style.height,
        termW: termWindow ? termWindow.style.width : '',
        termMax: termWindow ? termWindow.style.maxWidth : '',
      };
      previewCanvas.width = TRAIN_PREVIEW_W;
      previewCanvas.height = TRAIN_PREVIEW_H;
      previewCanvas.style.width = `min(${TRAIN_PREVIEW_W}px, 44vw)`;
      previewCanvas.style.height = 'auto';
      if (termWindow) {
        termWindow.style.width = '560px';
        termWindow.style.maxWidth = '52vw';
      }
    }
  } catch (_) {}
  renderTermMenu();
}

function exitAITraining() {
  try {
    if (previewCanvas && _previewSaved) {
      previewCanvas.width = _previewSaved.w;
      previewCanvas.height = _previewSaved.h;
      previewCanvas.style.width = _previewSaved.styleW;
      previewCanvas.style.height = _previewSaved.styleH;
      const termWindow = document.getElementById('term-window');
      if (termWindow) {
        termWindow.style.width = _previewSaved.termW;
        termWindow.style.maxWidth = _previewSaved.termMax;
      }
      _previewSaved = null;
    }
  } catch (_) {}
  termMode = 'main';
  renderTermMenu();
}

// Current live bout for the preview (read-only refs into the headless sim).
function trainingLiveView() {
  try {
    if (!isTraining() || !trainSettings.showSim) return null;
    if (activeTrainer && typeof activeTrainer.getLiveView === 'function') {
      return activeTrainer.getLiveView();
    }
  } catch (_) {}
  return null;
}

function cyclePreset(list, cur, dir) {
  let i = list.indexOf(cur);
  if (i < 0) {
    // Snap to nearest preset when holding a custom value.
    let best = 0, bd = Infinity;
    for (let k = 0; k < list.length; k++) {
      const d = Math.abs(list[k] - cur);
      if (d < bd) { bd = d; best = k; }
    }
    i = best;
  }
  return list[(i + dir + list.length) % list.length];
}

function cycleTrainRow(id, dir) {
  if (id === 'ai1') {
    trainSettings.ai1 = (trainSettings.ai1 + dir + ALL_FIGHTERS.length) % ALL_FIGHTERS.length;
  } else if (id === 'ai2') {
    trainSettings.ai2 = (trainSettings.ai2 + dir + ALL_FIGHTERS.length) % ALL_FIGHTERS.length;
  } else if (id === 'pop') {
    trainSettings.populationSize = cyclePreset(TRAIN_POP_PRESETS, trainSettings.populationSize, dir);
  } else if (id === 'gens') {
    trainSettings.maxGenerations = cyclePreset(TRAIN_GEN_PRESETS, trainSettings.maxGenerations, dir);
  } else if (id === 'mut') {
    trainSettings.mutationRate = cyclePreset(TRAIN_MUT_PRESETS, trainSettings.mutationRate, dir);
  } else if (id === 'speed') {
    const i = TRAIN_SPEEDS.indexOf(trainSettings.speed);
    trainSettings.speed = TRAIN_SPEEDS[(i + dir + TRAIN_SPEEDS.length) % TRAIN_SPEEDS.length];
  } else if (id === 'showsim') {
    trainSettings.showSim = !trainSettings.showSim;
  } else if (id === 'mode') {
    const modes = ['matchup', 'character', 'general'];
    const i = modes.indexOf(trainSettings.mode);
    trainSettings.mode = modes[(i + dir + modes.length) % modes.length];
    // Co-evolution only exists in matchup mode; leaving it reverts the
    // opponent to scripted so the setup can never describe an impossible run.
    if (trainSettings.mode !== 'matchup' && trainSettings.oppType === 'coevolve') {
      trainSettings.oppType = 'scripted';
    }
  } else if (id === 'opp') {
    const opps = trainSettings.mode === 'matchup'
      ? ['coevolve', 'trained', 'scripted', 'dummy']
      : ['trained', 'scripted', 'dummy'];
    const i = opps.indexOf(trainSettings.oppType);
    trainSettings.oppType = opps[(i + dir + opps.length) % opps.length];
  } else if (id === 'startmode') {
    trainSettings.startMode = trainSettings.startMode === 'continue' ? 'new' : 'continue';
  } else if (id === 'opdiff') {
    const ds = ['Easy', 'Normal', 'Hard', 'Expert'];
    const i = ds.indexOf(trainSettings.scriptedDifficulty);
    trainSettings.scriptedDifficulty = ds[(i + dir + ds.length) % ds.length];
  } else if (id === 'evaln') {
    trainSettings.evalMatches = cyclePreset(TRAIN_EVAL_PRESETS, trainSettings.evalMatches, dir);
  }
  persistAIConfig();
}

function trainRowValue(id) {
  switch (id) {
    case 'ai1': return ALL_FIGHTERS[trainSettings.ai1].name;
    case 'ai2': return ALL_FIGHTERS[trainSettings.ai2].name;
    case 'pop': return String(trainSettings.populationSize);
    case 'gens': return String(trainSettings.maxGenerations);
    case 'mut': return `${Math.round(trainSettings.mutationRate * 100)}%`;
    case 'speed': return trainSettings.speed;
    case 'showsim': return trainSettings.showSim ? 'ON' : 'OFF';
    case 'mode': return trainSettings.mode.toUpperCase();
    case 'opp': return trainSettings.oppType.toUpperCase();
    case 'startmode': return trainSettings.startMode.toUpperCase();
    case 'opdiff': return trainSettings.scriptedDifficulty.toUpperCase();
    case 'evaln': return String(trainSettings.evalMatches);
    case 'toggle': return isTraining() ? 'STOP' : 'START';
    case 'pause': return 'ENTER';
    case 'view': return trainViewLabel();
    case 'back': return 'ENTER';
    case 'hclear': return 'ENTER';
    case 'hnone': case 'mnone': return '';
    case 'mchar': {
      const def = ALL_FIGHTERS[trainModelChar] || ALL_FIGHTERS[0];
      return def ? def.name.toUpperCase() : '?';
    }
    case 'mactivate': case 'meval': case 'mcompare': case 'mrename':
    case 'mduplicate': case 'mexport': case 'mimport': case 'mdelete':
      return 'ENTER';
    default: break;
  }
  if (id.indexOf('run:') === 0) {
    const r = (trainHistoryCache || [])[parseInt(id.slice(4), 10)];
    return r ? fmtRunLine(r) : '';
  }
  if (id.indexOf('model:') === 0) {
    const m = (trainModelsCache || [])[parseInt(id.slice(6), 10)];
    if (!m) return '';
    const wr = m.winRate != null ? ` ${(m.winRate * 100).toFixed(0)}%` : '';
    return `${m.active ? '* ' : ''}${m.name} G${m.generation} F${fmtFit(m.fitness)}${wr}`;
  }
  return '';
}

function progressBar(frac, width = 20) {
  const f = Math.max(0, Math.min(1, frac || 0));
  const filled = Math.round(f * width);
  return `[${'â–ˆ'.repeat(filled)}${'â–‘'.repeat(width - filled)}] ${Math.round(f * 100)}%`;
}

function fmtFit(v) {
  if (!Number.isFinite(v)) return '--';
  return (Math.round(v * 10) / 10).toString();
}

function startTraining() {
  if (isTraining() || currentGameState !== 'menu') return false;
  const defA = ALL_FIGHTERS[trainSettings.ai1];
  const defB = ALL_FIGHTERS[trainSettings.ai2];
  if (!defA || !defB) return false;
  trainProgress = null;
  trainLive = null;
  trainDoneInfo = null;
  trainEvalReport = null;
  trainCompareReport = null;
  trainNotice = '';
  _trainSceneDrawn = false;
  const framesPerChunk = TRAIN_SPEED_FRAMES[trainSettings.speed] || 1200;
  try {
    activeTrainer = createTrainer({
      charA: defA.id,
      charB: defB.id,
      defA,
      defB,
      populationSize: trainSettings.populationSize,
      maxGenerations: trainSettings.maxGenerations,
      mutationRate: trainSettings.mutationRate,
      mode: trainSettings.mode,
      oppType: trainSettings.mode === 'matchup' ? trainSettings.oppType : (trainSettings.oppType === 'coevolve' ? 'scripted' : trainSettings.oppType),
      scriptedDifficulty: trainSettings.scriptedDifficulty,
      startMode: trainSettings.startMode,
      framesPerChunk,
      onProgress: (snap) => {
        trainProgress = snap;
        const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
        if (now - _lastTrainRender > 300 && termMode === 'aiTraining') {
          _lastTrainRender = now;
          try { renderTermMenu(); } catch (_) {}
        }
      },
      onLive: (live) => {
        trainLive = live;
        if (termMode === 'aiTraining' && trainSettings.showSim) {
          try { updateTrainingLive(); } catch (_) {}
        }
      },
      onDone: (info) => {
        trainDoneInfo = info;
        trainProgress = info;
        try { refreshTrainCaches(); } catch (_) {}
        try { renderTermMenu(); } catch (_) {}
        try { SFX.menuConfirm(); } catch (_) {}
      },
    });
    const ok = activeTrainer.start();
    if (!ok) activeTrainer = null;
    return ok;
  } catch (e) {
    console.error('[ai-training] start failed:', e);
    activeTrainer = null;
    return false;
  }
}

function stopTraining() {
  if (!isTraining()) return false;
  try {
    activeTrainer.stop();
  } catch (_) {}
  try { refreshTrainCaches(); } catch (_) {}
  try { renderTermMenu(); } catch (_) {}
  return true;
}

function pauseTraining() {
  if (!isTraining()) return false;
  try { return activeTrainer.pause(); } catch (_) { return false; }
}

function resumeTraining() {
  try {
    if (!activeTrainer || typeof activeTrainer.resume !== 'function') return false;
    return activeTrainer.resume();
  } catch (_) { return false; }
}

// ── Training views: setup / progress / history / models ───────────────────
let trainView = 'setup';
let trainHistoryCache = [];
let trainRunSel = 0;
let trainModelsCache = [];
let trainModelChar = 0;
let trainModelSel = 0;
let trainEvalReport = null;
let trainEvalBusy = false;
let trainCompareReport = null;
let trainNotice = '';

function refreshTrainCaches() {
  try { trainHistoryCache = listRunHistory(50); } catch (_) { trainHistoryCache = []; }
  try {
    const def = ALL_FIGHTERS[trainModelChar] || ALL_FIGHTERS[0];
    trainModelsCache = def ? listModels(def.id) : [];
  } catch (_) { trainModelsCache = []; }
  if (trainRunSel >= trainHistoryCache.length) trainRunSel = 0;
  if (trainModelSel >= trainModelsCache.length) trainModelSel = 0;
}

function trainSetupRows(running) {
  const locked = !!running;
  const rows = [
    { id: 'view', label: 'VIEW', locked: false },
    { id: 'ai1', label: 'AI 1 CHARACTER (TRAINED)', locked },
    { id: 'ai2', label: 'AI 2 CHARACTER', locked },
    { id: 'mode', label: 'TRAINING MODE', locked },
    { id: 'opp', label: 'OPPONENT TYPE', locked },
    { id: 'opdiff', label: 'SCRIPTED STRENGTH', locked },
    { id: 'startmode', label: 'START MODE', locked },
    { id: 'pop', label: 'POPULATION SIZE', locked },
    { id: 'gens', label: 'MAX GENERATIONS', locked },
    { id: 'mut', label: 'MUTATION RATE', locked },
    { id: 'evaln', label: 'EVAL MATCHES', locked: false },
    { id: 'speed', label: 'TRAINING SPEED', locked },
    { id: 'showsim', label: 'SHOW SIMULATION', locked: false },
    { id: 'toggle', label: running ? (trainProgress && trainProgress.paused ? 'RESUME TRAINING' : 'STOP TRAINING') : 'START TRAINING', locked: false },
  ];
  if (running && !(trainProgress && trainProgress.paused)) {
    rows.push({ id: 'pause', label: 'PAUSE TRAINING', locked: false });
  }
  rows.push({ id: 'back', label: 'BACK', locked: false });
  return rows;
}

function trainViewLabel() {
  return ({ setup: 'SETUP', progress: 'PROGRESS', history: 'HISTORY', models: 'MODELS' })[trainView] || 'SETUP';
}

function cycleTrainView(dir) {
  const vs = ['setup', 'progress', 'history', 'models'];
  const i = vs.indexOf(trainView);
  trainView = vs[(i + dir + vs.length) % vs.length];
  if (trainView === 'history' || trainView === 'models') refreshTrainCaches();
}

// Evaluate a stored model under identical scripted conditions. Synchronous
// and bounded (evalMatches bouts); the report is attached to the model so the
// models view and comparisons show measured - not claimed - performance.
function runModelEval(charId, modelId) {
  if (trainEvalBusy) return { ok: false, error: 'evaluation already running' };
  const def = ALL_FIGHTERS.find((f) => f.id === charId);
  const m = def ? getModel(charId, modelId) : null;
  if (!def || !m) return { ok: false, error: 'model not found' };
  trainEvalBusy = true;
  try {
    const oppDef = ALL_FIGHTERS[(ALL_FIGHTERS.indexOf(def) + 1) % ALL_FIGHTERS.length] || def;
    const report = evaluateModels({
      defA: def,
      defB: oppDef,
      genomeA: { weights: m.weights, behavior: m.behavior },
      oppB: { kind: 'scripted', difficulty: 'Normal', charId: oppDef.id },
      matches: trainSettings.evalMatches,
    });
    report.modelId = modelId;
    report.modelName = m.name;
    report.character = charId;
    report.at = new Date().toISOString();
    try { attachEval(charId, modelId, report); } catch (_) {}
    try { refreshTrainCaches(); } catch (_) {}
    return { ok: true, report };
  } catch (e) {
    return { ok: false, error: 'evaluation failed' };
  } finally {
    trainEvalBusy = false;
  }
}

// Compare two models for one character under the SAME scenarios: each plays
// evalMatches scripted bouts; both reports are shown side by side with no
// automatic "winner" label beyond the raw numbers.
function runModelCompare(charId, idA, idB) {
  if (trainEvalBusy) return { ok: false, error: 'evaluation already running' };
  const def = ALL_FIGHTERS.find((f) => f.id === charId);
  const mA = def ? getModel(charId, idA) : null;
  const mB = def ? getModel(charId, idB) : null;
  if (!def || !mA || !mB) return { ok: false, error: 'model not found' };
  if (idA === idB) return { ok: false, error: 'pick two different models' };
  trainEvalBusy = true;
  try {
    const oppDef = ALL_FIGHTERS[(ALL_FIGHTERS.indexOf(def) + 1) % ALL_FIGHTERS.length] || def;
    const mk = (m) => evaluateModels({
      defA: def,
      defB: oppDef,
      genomeA: { weights: m.weights, behavior: m.behavior },
      oppB: { kind: 'scripted', difficulty: 'Normal', charId: oppDef.id },
      matches: trainSettings.evalMatches,
    });
    const rA = mk(mA); rA.modelName = mA.name;
    const rB = mk(mB); rB.modelName = mB.name;
    return { ok: true, a: rA, b: rB, at: new Date().toISOString() };
  } catch (e) {
    return { ok: false, error: 'comparison failed' };
  } finally {
    trainEvalBusy = false;
  }
}

function exportModelFile(charId, modelId) {
  const res = exportModel(charId, modelId);
  if (!res.ok) { trainNotice = `export failed: ${res.error}`; return false; }
  try {
    const blob = new Blob([res.json], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `smashfighters-ai-${charId}-${modelId}.json`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { try { URL.revokeObjectURL(a.href); a.remove(); } catch (_) {} }, 500);
    trainNotice = 'model exported - keep the file as a portable backup';
    return true;
  } catch (_) {
    trainNotice = 'export failed in this browser';
    return false;
  }
}

function importModelFile(file) {
  if (!file) return;
  const def = ALL_FIGHTERS[trainModelChar] || ALL_FIGHTERS[0];
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const text = typeof reader.result === 'string' ? reader.result : '';
      const res = importModel(text, { charId: def.id });
      trainNotice = res.ok
        ? `imported as "${getModel(def.id, res.id).name}"${res.converted ? ` (converted from ${res.converted})` : ''}`
        : `import rejected: ${res.error}`;
    } catch (_) {
      trainNotice = 'import rejected: unreadable file';
    }
    try { refreshTrainCaches(); } catch (_) {}
    try { renderTermMenu(); } catch (_) {}
  };
  reader.onerror = () => {
    trainNotice = 'import rejected: unreadable file';
    try { renderTermMenu(); } catch (_) {}
  };
  try { reader.readAsText(file); } catch (_) { trainNotice = 'import rejected: unreadable file'; }
}

let _trainFileInput = null;
function promptModelImport() {
  try {
    if (!_trainFileInput) {
      _trainFileInput = document.createElement('input');
      _trainFileInput.type = 'file';
      _trainFileInput.accept = '.json,application/json';
      _trainFileInput.style.display = 'none';
      document.body.appendChild(_trainFileInput);
      _trainFileInput.addEventListener('change', () => {
        const f = _trainFileInput.files && _trainFileInput.files[0];
        _trainFileInput.value = '';
        importModelFile(f);
      });
    }
    _trainFileInput.click();
  } catch (_) {
    trainNotice = 'import unavailable in this browser';
  }
}

function trainedModelsLine() {
  try {
    const models = listTrainedModels();
    if (!models.length) return 'TRAINED: none yet â€” run training to evolve one';
    return 'TRAINED: ' + models.map((m) => `${m.character} (G${m.generation} F${fmtFit(m.fitness)})`).join(' Â· ');
  } catch (_) {
    return 'TRAINED: n/a';
  }
}

// ── Training views: row lists ───────────────────────────────────────────
function trainRows() {
  const running = isTraining();
  if (trainView === 'history') {
    const rows = [{ id: 'view', label: 'VIEW' }];
    const list = trainHistoryCache || [];
    if (!list.length) rows.push({ id: 'hnone', label: 'NO SAVED RUNS', locked: true });
    for (let i = 0; i < list.length; i++) rows.push({ id: 'run:' + i, label: 'RUN ' + (i + 1) });
    rows.push({ id: 'hclear', label: 'CLEAR HISTORY' });
    rows.push({ id: 'back', label: 'BACK' });
    return rows;
  }
  if (trainView === 'models') {
    const rows = [{ id: 'view', label: 'VIEW' }, { id: 'mchar', label: 'CHARACTER' }];
    const list = trainModelsCache || [];
    if (!list.length) rows.push({ id: 'mnone', label: 'NO SAVED MODELS', locked: true });
    for (let i = 0; i < list.length; i++) rows.push({ id: 'model:' + i, label: 'MODEL ' + (i + 1) });
    rows.push({ id: 'mactivate', label: 'ACTIVATE SELECTED' });
    rows.push({ id: 'meval', label: 'EVALUATE SELECTED' });
    rows.push({ id: 'mcompare', label: 'COMPARE VS ACTIVE' });
    rows.push({ id: 'mrename', label: 'RENAME SELECTED' });
    rows.push({ id: 'mduplicate', label: 'DUPLICATE SELECTED' });
    rows.push({ id: 'mexport', label: 'EXPORT SELECTED' });
    rows.push({ id: 'mimport', label: 'IMPORT FILE' });
    rows.push({ id: 'mdelete', label: 'DELETE SELECTED' });
    rows.push({ id: 'back', label: 'BACK' });
    return rows;
  }
  if (trainView === 'progress') {
    const rows = [{ id: 'view', label: 'VIEW' }];
    if (running) {
      const paused = !!(trainProgress && trainProgress.paused);
      rows.push({ id: 'toggle', label: paused ? 'RESUME TRAINING' : 'STOP TRAINING' });
      if (!paused) rows.push({ id: 'pause', label: 'PAUSE TRAINING' });
    } else {
      rows.push({ id: 'toggle', label: 'START TRAINING' });
    }
    rows.push({ id: 'back', label: 'BACK' });
    return rows;
  }
  return trainSetupRows(running);
}

function selectedTrainModel() {
  try {
    const def = ALL_FIGHTERS[trainModelChar] || ALL_FIGHTERS[0];
    const list = trainModelsCache || [];
    const m = list[trainModelSel];
    if (!def || !m) return null;
    return { character: def.id, id: m.id, summary: m };
  } catch (_) {
    return null;
  }
}

function promptTrainNumber(id) {
  const isPop = id === 'pop';
  const cur = isPop ? trainSettings.populationSize : trainSettings.maxGenerations;
  let raw = null;
  try {
    raw = prompt(`Enter ${isPop ? 'population size (2-200)' : 'max generations (1-2000)'}:`, String(cur));
  } catch (_) { raw = null; }
  if (raw !== null) {
    const v = parseInt(raw, 10);
    if (Number.isFinite(v)) {
      if (isPop) trainSettings.populationSize = Math.max(2, Math.min(200, v));
      else trainSettings.maxGenerations = Math.max(1, Math.min(2000, v));
      persistAIConfig();
    }
  }
}

function loadRunConfig(i) {
  const run = (trainHistoryCache || [])[i];
  if (!run) return;
  try {
    const names = ALL_FIGHTERS.map((f) => f.id);
    if (names.includes(run.charA)) trainSettings.ai1 = names.indexOf(run.charA);
    if (names.includes(run.charB)) trainSettings.ai2 = names.indexOf(run.charB);
    if (run.mode) trainSettings.mode = run.mode;
    if (run.oppType) trainSettings.oppType = run.oppType;
    const c = run.config || {};
    if (Number.isFinite(c.populationSize)) trainSettings.populationSize = Math.max(2, Math.min(200, c.populationSize | 0));
    if (Number.isFinite(c.maxGenerations)) trainSettings.maxGenerations = Math.max(1, Math.min(2000, c.maxGenerations | 0));
    if (Number.isFinite(c.mutationRate)) trainSettings.mutationRate = Math.min(0.2, Math.max(0.005, c.mutationRate));
    persistAIConfig();
    trainView = 'setup';
    trainNotice = `loaded config from run ${run.id.slice(0, 8)} - press START TRAINING`;
  } catch (_) {
    trainNotice = 'could not load that run config';
  }
}

// Central dispatcher for training-menu activation (click or ENTER).
// viaEnter distinguishes ENTER (numeric prompt) from click (cycle).
function trainActivateRow(id, viaEnter) {
  if (id === 'view') { cycleTrainView(1); return; }
  if (id === 'back') { exitAITraining(); return; }
  if (id === 'toggle') {
    if (isTraining()) {
      if (trainProgress && trainProgress.paused) resumeTraining();
      else stopTraining();
    } else startTraining();
    return;
  }
  if (id === 'pause') { pauseTraining(); return; }
  const setupValueIds = ['ai1', 'ai2', 'pop', 'gens', 'mut', 'speed', 'showsim', 'mode', 'opp', 'startmode', 'opdiff', 'evaln'];
  if (setupValueIds.includes(id)) {
    if (isTraining() && ['ai1', 'ai2', 'pop', 'gens', 'mut', 'speed', 'mode', 'opp', 'startmode', 'opdiff'].includes(id)) return;
    if ((id === 'pop' || id === 'gens') && viaEnter) { promptTrainNumber(id); return; }
    cycleTrainRow(id, 1);
    return;
  }
  if (id.indexOf('run:') === 0) { loadRunConfig(parseInt(id.slice(4), 10)); return; }
  if (id === 'hclear') {
    let yes = false;
    try { yes = confirm('Clear all saved training history? Models are kept.'); } catch (_) { yes = false; }
    if (yes) {
      clearRunHistory();
      refreshTrainCaches();
      trainNotice = 'history cleared - models kept';
    }
    return;
  }
  if (id === 'mchar') {
    trainModelChar = (trainModelChar + 1) % ALL_FIGHTERS.length;
    trainModelSel = 0;
    refreshTrainCaches();
    return;
  }
  if (id.indexOf('model:') === 0) {
    trainModelSel = parseInt(id.slice(6), 10) || 0;
    return;
  }
  const sel = selectedTrainModel();
  if (id === 'mimport') { promptModelImport(); return; }
  if (!sel) { trainNotice = 'no model selected'; return; }
  if (id === 'mactivate') {
    trainNotice = activateModel(sel.character, sel.id) ? `"${sel.summary.name}" is now active` : 'activation failed';
    refreshTrainCaches();
    return;
  }
  if (id === 'mrename') {
    let name = null;
    try { name = prompt('Rename model:', sel.summary.name); } catch (_) { name = null; }
    if (name !== null) {
      trainNotice = renameModel(sel.character, sel.id, name) ? 'renamed' : 'rename failed (1-40 chars)';
      refreshTrainCaches();
    }
    return;
  }
  if (id === 'mduplicate') {
    const res = duplicateModel(sel.character, sel.id);
    trainNotice = res.ok ? 'duplicated' : `duplicate failed: ${res.error}`;
    refreshTrainCaches();
    return;
  }
  if (id === 'mexport') {
    exportModelFile(sel.character, sel.id);
    return;
  }
  if (id === 'mdelete') {
    let yes = false;
    try { yes = confirm(`Delete model "${sel.summary.name}"? This cannot be undone.`); } catch (_) { yes = false; }
    if (yes) {
      trainNotice = deleteModel(sel.character, sel.id) ? 'deleted' : 'delete failed';
      refreshTrainCaches();
    }
    return;
  }
  if (id === 'meval') {
    trainNotice = 'evaluating...';
    try { renderTermMenu(); } catch (_) {}
    const res = runModelEval(sel.character, sel.id);
    if (res.ok) {
      trainEvalReport = res.report;
      trainNotice = `evaluated ${res.report.matches} bouts - win rate ${(res.report.winRate * 100).toFixed(0)}%`;
    } else {
      trainNotice = `evaluation failed: ${res.error}`;
    }
    return;
  }
  if (id === 'mcompare') {
    const def = ALL_FIGHTERS[trainModelChar] || ALL_FIGHTERS[0];
    let active = null;
    try { active = getActiveModel(def.id); } catch (_) { active = null; }
    const activeId = active && (active.modelId || null);
    if (!activeId) { trainNotice = 'no active model to compare against'; return; }
    if (activeId === sel.id) { trainNotice = 'selected model IS the active one - pick another'; return; }
    trainNotice = 'comparing...';
    try { renderTermMenu(); } catch (_) {}
    const res = runModelCompare(def.id, sel.id, activeId);
    if (res.ok) {
      trainCompareReport = res;
      trainNotice = 'comparison complete - raw numbers below, no auto-winner';
    } else {
      trainNotice = `comparison failed: ${res.error}`;
    }
    return;
  }
}

// ── Training status blocks (DOM text from real snapshots/records) ─────────
function sparkAscii(values, width) {
  const w = Math.max(4, Math.min(40, width | 0 || 28));
  const vs = (values || []).filter(Number.isFinite);
  if (vs.length < 2) return '(need 2+ generations)';
  let mn = Math.min(...vs), mx = Math.max(...vs);
  if (!(mx > mn)) return '(flat)';
  const glyphs = ' .:-=+*#%@';
  const step = Math.max(1, Math.floor(vs.length / w));
  let out = '';
  for (let i = 0; i < vs.length; i += step) {
    const lvl = Math.max(0, Math.min(glyphs.length - 1, Math.round(((vs[i] - mn) / (mx - mn)) * (glyphs.length - 1))));
    out += glyphs[lvl];
  }
  return out + `  [${fmtFit(mn)}..${fmtFit(mx)}]`;
}

function trainStatusSetup(info) {
  info(trainedModelsLine());
  const p = trainProgress;
  if (p) {
    const gen = p.generation || 0;
    const max = p.maxGenerations || trainSettings.maxGenerations;
    info(`GENERATION ${gen} / ${max}${p.paused ? ' (PAUSED)' : ''}`);
    info(progressBar(gen / Math.max(1, max)));
    info(`BEST FITNESS ${fmtFit(p.best)}   AVERAGE FITNESS ${fmtFit(p.avg)}   BEST WINS ${p.bestWins || 0}   MATCHES ${p.matchesPlayed || 0}`);
    const lr = p.lastResult;
    if (lr) {
      const w = lr.winner === 1 ? ALL_FIGHTERS[trainSettings.ai1].name : lr.winner === 2 ? ALL_FIGHTERS[trainSettings.ai2].name : 'draw';
      info(`LAST: GEN ${lr.gen} MATCH ${lr.match} WIN ${w} FIT ${lr.fitA}/${lr.fitB == null ? '-' : lr.fitB}`);
    }
    if (p.warnings && p.warnings.length) info('NOTE: ' + p.warnings.join(' | '));
  } else if (trainDoneInfo) {
    info(`DONE (${trainDoneInfo.reason}) - models saved`);
  } else {
    info(`${ALL_FIGHTERS[trainSettings.ai1].name} vs ${ALL_FIGHTERS[trainSettings.ai2].name} - press START TRAINING`);
  }
  if (trainNotice) info(trainNotice);
  if (trainSettings.showSim) {
    const live = document.createElement('div');
    live.className = 'term-row head';
    live.id = 'train-live-line';
    live.textContent = liveLineText();
    termLinesEl.appendChild(live);
  }
  drawTrainingPreview();
}

function trainStatusProgress(info) {
  const p = trainProgress;
  if (!p && !isTraining()) {
    info('no training data yet - START TRAINING from SETUP');
    if (trainNotice) info(trainNotice);
    drawTrainingPreview();
    return;
  }
  const snap = p || {};
  info(`STATUS: ${!isTraining() ? 'IDLE' : snap.paused ? 'PAUSED' : 'TRAINING'}  ${snap.charA || ''} vs ${snap.charB || ''}  ${snap.mode || ''}/${snap.oppType || ''}`);
  info(`GENERATION ${snap.generation || 0} / ${snap.maxGenerations || trainSettings.maxGenerations}`);
  info(progressBar((snap.generation || 0) / Math.max(1, snap.maxGenerations || trainSettings.maxGenerations)));
  info(`BEST ${fmtFit(snap.best)}  AVG ${fmtFit(snap.avg)}  WINS A/B ${snap.winsA || 0}/${snap.winsB || 0}  MATCHES ${snap.matchesPlayed || 0}`);
  info(`DIVERSITY A ${fmtFit(snap.diversityA)}${snap.diversityB ? `  B ${fmtFit(snap.diversityB)}` : ''}`);
  const hist = (snap.history || []).map((h) => h.best);
  info('FITNESS CURVE: ' + sparkAscii(hist, 28));
  if (snap.warnings && snap.warnings.length) info('NOTE: ' + snap.warnings.join(' | '));
  if (trainNotice) info(trainNotice);
  if (trainSettings.showSim) {
    const live = document.createElement('div');
    live.className = 'term-row head';
    live.id = 'train-live-line';
    live.textContent = liveLineText();
    termLinesEl.appendChild(live);
  }
  drawTrainingPreview();
}

function fmtRunLine(r) {
  const date = String(r.finishedAt || '').slice(0, 10);
  return `G${r.generations} F${fmtFit(r.bestFitness)} W${r.winsA}-${r.winsB} ${r.status} ${date}`;
}

function trainStatusHistory(info) {
  const list = trainHistoryCache || [];
  if (!list.length) {
    info('no saved runs yet - completed or stopped runs are recorded here');
    if (trainNotice) info(trainNotice);
    return;
  }
  const run = list[Math.min(trainRunSel, list.length - 1)];
  if (!run) return;
  info(`RUN ${run.id.slice(0, 8)}  ${run.charA} vs ${run.charB}  ${run.mode}/${run.oppType}`);
  info(`GENS ${run.generations}  MATCHES ${run.matches}  BEST ${fmtFit(run.bestFitness)}  AVG ${fmtFit(run.avgFitness)}`);
  info(`WINS A/B ${run.winsA}/${run.winsB}  STATUS ${run.status}  ${String(run.finishedAt || '').slice(0, 16).replace('T', ' ')}`);
  try {
    const c = run.config || {};
    info(`POP ${c.populationSize} MUT ${(c.mutationRate * 100).toFixed(0)}% OPP ${run.opponent || run.charB}`);
  } catch (_) {}
  if (run.warnings && run.warnings.length) info('NOTE: ' + run.warnings.join(' | '));
  info('FITNESS: ' + sparkAscii(run.fitnessCurve || [], 28));
  if (trainNotice) info(trainNotice);
  info('ENTER on a run loads its config into SETUP');
}

function fmtEvalLine(prefix, r) {
  if (!r || !r.ok && !r.matches) return `${prefix}: no data`;
  return `${prefix}: ${r.wins}/${r.matches} wins (${(r.winRate * 100).toFixed(0)}%) dealt ${r.avgDealt.toFixed(1)} taken ${r.avgTaken.toFixed(1)} rec ${(r.recRate * 100).toFixed(0)}% hit ${(r.hitRate * 100).toFixed(0)}%`;
}

function trainStatusModels(info) {
  const def = ALL_FIGHTERS[trainModelChar] || ALL_FIGHTERS[0];
  const list = trainModelsCache || [];
  info(`CHARACTER: ${def ? def.name : '?'}  (${list.length} saved)  storage: browser localStorage (exports back up)`);
  const m = list[Math.min(trainModelSel, Math.max(0, list.length - 1))];
  if (m) {
    info(`SELECTED: "${m.name}"${m.active ? ' [ACTIVE]' : ''} G${m.generation} F${fmtFit(m.fitness)} W${m.wins} ${String(m.savedAt || '').slice(0, 10)} OPP ${m.opponent || '-'}`);
    if (m.hasEval && m.winRate != null) {
      info(`LAST EVAL: ${(m.winRate * 100).toFixed(0)}% wins - see EVALUATE for a fresh report`);
    }
  } else {
    info('no models for this character yet - train or import one');
  }
  if (trainEvalReport && trainEvalReport.ok !== false) {
    const r = trainEvalReport;
    info(fmtEvalLine(`EVAL "${r.modelName || ''}"`, r));
    const tops = Object.entries(r.moveUses || {}).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, v]) => `${k}x${v}`).join(' ');
    if (tops) info(`MOVES: ${tops}`);
  }
  if (trainCompareReport && trainCompareReport.ok) {
    info(fmtEvalLine(`A "${trainCompareReport.a.modelName}"`, trainCompareReport.a));
    info(fmtEvalLine(`B "${trainCompareReport.b.modelName}"`, trainCompareReport.b));
    info('same scenarios, same opponent - numbers above, no auto-winner');
  }
  if (trainNotice) info(trainNotice);
}

function renderAITraining() {
  const header = document.createElement('div');
  header.className = 'term-row head';
  header.textContent = `AI TRAINING  -  ${trainViewLabel()}  (real bouts, real evolution)`;
  termLinesEl.appendChild(header);

  const rows = trainRows();
  if (termTrainCursor >= rows.length) termTrainCursor = 0;
  rows.forEach((row, i) => {
    const locked = !!row.locked;
    const isOn = i === termTrainCursor;
    const line = document.createElement('div');
    line.className = 'term-row' + (isOn ? ' on' : '') + (locked ? ' off' : '');
    const numText = (i < 9 ? ' ' : '') + (i + 1);
    const key = document.createElement('span');
    key.className = 'k';
    key.textContent = `${isOn ? '>' : ' '} [${numText}] ${row.label}${'.'.repeat(Math.max(1, 22 - row.label.length))}`;
    const val = document.createElement('span');
    val.className = 'v';
    val.style.width = 'auto';
    val.style.textAlign = 'left';
    val.textContent = trainRowValue(row.id);
    line.appendChild(key);
    line.appendChild(val);
    if (!locked) {
      line.addEventListener('click', () => {
        termTrainCursor = i;
        SFX.menuSelect();
        trainActivateRow(row.id, false);
        renderTermMenu();
      });
    }
    termLinesEl.appendChild(line);
  });

  // Status block (read-only info lines, same DOM, no new architecture).
  const info = (text) => {
    const d = document.createElement('div');
    d.className = 'term-row head';
    d.textContent = text;
    termLinesEl.appendChild(d);
  };
  if (trainView === 'progress') trainStatusProgress(info);
  else if (trainView === 'history') trainStatusHistory(info);
  else if (trainView === 'models') trainStatusModels(info);
  else trainStatusSetup(info);
}

function liveLineText() {
  if (!trainLive) return 'LIVE: waiting for first boutâ€¦';
  const t = trainLive;
  const a = ALL_FIGHTERS[trainSettings.ai1].name;
  const b = ALL_FIGHTERS[trainSettings.ai2].name;
  return `LIVE G${t.generation} M${t.match}/${t.of}: ${a} (${t.p1.x},${t.p1.y} ${t.p1.percent}%) vs ${b} (${t.p2.x},${t.p2.y} ${t.p2.percent}%)`;
}

// Live visualization: the REAL headless bout drawn with the EXACT same calls
// as a live match (background, stage, horses, fighters, ability fx, health
// bars), scaled to fit the enlarged preview. No fake animation â€” these are
// the sim's live fighter objects.
let _trainSceneDrawn = false;
function drawTrainingPreview(now) {
  if (!previewCtx || !previewCanvas) return;
  const time = now || ((typeof performance !== 'undefined' && performance.now) ? performance.now() : 0);
  const view = trainingLiveView();
  if (view && view.stage && view.f1 && view.f2) {
    drawTrainingScene(time, view);
    _trainSceneDrawn = true;
    return;
  }
  // Between bouts the sim briefly has no live match â€” keep the last live
  // frame instead of flashing the idle panel. Only draw idle when no bout is
  // in flight and none was ever drawn (stopped/finished state).
  if (isTraining() && _trainSceneDrawn) return;
  _trainSceneDrawn = false;
  drawTrainingIdlePanel();
}

function drawTrainingScene(time, view) {
  const pctx = previewCtx;
  const W = previewCanvas.width;
  const H = previewCanvas.height;
  const { stage, f1, f2 } = view;
  try {
    pctx.setTransform(1, 0, 0, 1, 0, 0);
    // Same arena backdrop as the real render (pre-rendered bg equivalent).
    pctx.fillStyle = mapSettings.backgroundColor || DEFAULT_BACKGROUND_COLOR;
    pctx.fillRect(0, 0, W, H);
    pctx.save();
    pctx.scale(TRAIN_PREVIEW_SCALE, TRAIN_PREVIEW_SCALE);
    drawStage(pctx, stage, time, mapSettings.platformColor);
    // Same attacker-on-top layering rule as the playing render.
    const aFront = (f1._hitRenderTimer || 0) > 0;
    const bFront = (f2._hitRenderTimer || 0) > 0;
    const drawOne = (f) => {
      try { drawHorse(pctx, f, time); } catch (_) {}
      try { drawFighter(pctx, f, time); } catch (_) {}
      try { drawFighterVfx(pctx, f); } catch (_) {}
      try { drawAbilityFx(pctx, f, time); } catch (_) {}
    };
    if (aFront && !bFront) { drawOne(f2); drawOne(f1); }
    else { drawOne(f1); drawOne(f2); }
    try {
      if (!f1.eliminated) drawHealthBar(pctx, f1, time);
      if (!f2.eliminated) drawHealthBar(pctx, f2, time);
    } catch (_) {}
    pctx.restore();
    // Readable caption (screen space): generation, bout, fitness, percents.
    const p = trainProgress;
    const gen = p ? p.generation : 0;
    const max = p ? p.maxGenerations : trainSettings.maxGenerations;
    pctx.fillStyle = 'rgba(0, 0, 0, 0.62)';
    pctx.fillRect(0, 0, W, 44);
    pctx.textAlign = 'left';
    pctx.textBaseline = 'top';
    pctx.font = 'bold 13px Consolas, monospace';
    pctx.fillStyle = '#33ff88';
    const lv = trainLive;
    const mTxt = lv ? `M${lv.match}/${lv.of}` : '';
    pctx.fillText(`GEN ${gen}/${max} ${mTxt}  BEST ${fmtFit(p ? p.best : NaN)}`, 10, 6);
    pctx.font = '12px Consolas, monospace';
    const a = ALL_FIGHTERS[trainSettings.ai1];
    const b = ALL_FIGHTERS[trainSettings.ai2];
    pctx.fillStyle = '#4a9eff';
    pctx.fillText(`${a.name} ${Math.round(f1.percent)}%`, 10, 25);
    const right = `${b.name} ${Math.round(f2.percent)}%`;
    pctx.fillStyle = '#ff4a4a';
    pctx.textAlign = 'right';
    pctx.fillText(right, W - 10, 25);
    // Thin progress bar along the bottom (same milestone as the text UI).
    const frac = Math.max(0, Math.min(1, gen / Math.max(1, max)));
    pctx.fillStyle = 'rgba(0,0,0,0.62)';
    pctx.fillRect(0, H - 10, W, 10);
    pctx.fillStyle = '#33ff88';
    pctx.fillRect(0, H - 10, W * frac, 10);
  } catch (e) {
    console.error('[ai-training] preview scene failed:', e);
  }
}

// Idle panel (no live bout): title, progress, sparkline â€” on the enlarged
// canvas so the layout never jumps between idle and live.
function drawTrainingIdlePanel() {
  const pctx = previewCtx;
  const W = previewCanvas.width;
  const H = previewCanvas.height;
  pctx.setTransform(1, 0, 0, 1, 0, 0);
  pctx.fillStyle = '#f3ead1';
  pctx.fillRect(0, 0, W, H);
  pctx.textAlign = 'center';
  pctx.font = 'bold 17px Consolas, monospace';
  pctx.fillStyle = '#111';
  const a = ALL_FIGHTERS[trainSettings.ai1];
  const b = ALL_FIGHTERS[trainSettings.ai2];
  pctx.fillText(`${a.name} vs ${b.name}`, W / 2, 30);
  const p = trainProgress;
  pctx.font = '13px Consolas, monospace';
  pctx.fillStyle = '#555';
  if (p) pctx.fillText(`GEN ${p.generation}/${p.maxGenerations}  BEST ${fmtFit(p.best)}  AVG ${fmtFit(p.avg)}`, W / 2, 54);
  else if (trainDoneInfo) pctx.fillText('training complete â€” models saved', W / 2, 54);
  else pctx.fillText(trainSettings.showSim ? 'press START TRAINING to watch live bouts' : 'SHOW SIMULATION is OFF â€” enable it to watch bouts', W / 2, 54);
  // History sparkline (best fitness per generation), enlarged.
  if (p && Array.isArray(p.history) && p.history.length > 1) {
    const hist = p.history.slice(-60);
    let mn = Infinity, mxv = -Infinity;
    for (const h of hist) { if (h.best < mn) mn = h.best; if (h.best > mxv) mxv = h.best; }
    const span = Math.max(1, mxv - mn);
    const x0 = 30, x1 = W - 30, y0 = 90, y1 = H - 40;
    pctx.strokeStyle = 'rgba(17,17,17,0.25)';
    pctx.lineWidth = 1;
    pctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
    pctx.strokeStyle = '#111';
    pctx.lineWidth = 2;
    pctx.beginPath();
    hist.forEach((h, i) => {
      const x = x0 + (i / Math.max(1, hist.length - 1)) * (x1 - x0);
      const y = y1 - ((h.best - mn) / span) * (y1 - y0);
      if (i === 0) pctx.moveTo(x, y);
      else pctx.lineTo(x, y);
    });
    pctx.stroke();
    pctx.font = '11px Consolas, monospace';
    pctx.fillStyle = '#555';
    pctx.fillText('best fitness / generation', W / 2, H - 18);
  } else {
    pctx.font = '12px Consolas, monospace';
    pctx.fillStyle = '#888';
    pctx.fillText('live match view appears here during training', W / 2, H / 2);
    pctx.fillText('fitness curve appears here after generation 2', W / 2, H / 2 + 22);
  }
}

// Throttled live refresh: per-chunk callbacks can fire dozens of times per
// second at high speed â€” the canvas only needs ~10fps.
let _lastTrainPreviewDraw = 0;
function updateTrainingLive() {
  const el = document.getElementById('train-live-line');
  if (el) el.textContent = liveLineText();
  const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
  if (now - _lastTrainPreviewDraw < 100) return;
  _lastTrainPreviewDraw = now;
  try { drawTrainingPreview(now); } catch (_) {}
}

// Per-frame hook from render(): keeps time-based visuals (breathing, flashes,
// platform bob echo) alive even between sim chunks.
function maybeRedrawTrainingPreview(now) {
  if (termMode !== 'aiTraining') return;
  if (!trainSettings.showSim || !isTraining()) return;
  if (now - _lastTrainPreviewDraw < 120) return;
  _lastTrainPreviewDraw = now;
  try { drawTrainingPreview(now); } catch (_) {}
}

function onAITrainingKey(e) {
  const k = e.code;
  const rows = trainRows().map((r) => r.id);
  if (k === 'Escape' || k === 'Backspace') {
    exitAITraining();
    return;
  }
  if (k === 'ArrowUp' || k === 'KeyW') {
    termTrainCursor = (termTrainCursor - 1 + rows.length) % rows.length;
  } else if (k === 'ArrowDown' || k === 'KeyS') {
    termTrainCursor = (termTrainCursor + 1) % rows.length;
  } else if (k === 'ArrowLeft' || k === 'KeyA' || k === 'Minus' || k === 'NumpadSubtract') {
    const id = rows[termTrainCursor];
    if (id === 'view') cycleTrainView(-1);
    else if (id === 'mchar') {
      trainModelChar = (trainModelChar + ALL_FIGHTERS.length - 1) % ALL_FIGHTERS.length;
      trainModelSel = 0;
      refreshTrainCaches();
    } else cycleTrainRowLeft(id);
  } else if (k === 'ArrowRight' || k === 'KeyD' || k === 'Equal' || k === 'NumpadAdd') {
    const id = rows[termTrainCursor];
    if (id === 'view') cycleTrainView(1);
    else if (id === 'mchar') {
      trainModelChar = (trainModelChar + 1) % ALL_FIGHTERS.length;
      trainModelSel = 0;
      refreshTrainCaches();
    } else if (trainSetupValueId(id)) trainActivateRow(id, false);
  } else if (k === 'Enter' || k === 'NumpadEnter' || k === 'Space') {
    trainActivateRow(rows[termTrainCursor], true);
    renderTermMenu();
    return;
  } else if (k.slice(0, 5) === 'Digit') {
    const n = parseInt(k.slice(5), 10);
    if (n >= 1 && n <= rows.length) termTrainCursor = n - 1;
  } else {
    return;
  }
  SFX.menuSelect();
  renderTermMenu();
}

// Left/Right on setup value rows cycles the value (click parity).
function trainSetupValueId(id) {
  return ['ai1', 'ai2', 'pop', 'gens', 'mut', 'speed', 'showsim', 'mode', 'opp', 'startmode', 'opdiff', 'evaln'].includes(id);
}
function cycleTrainRowLeft(id) {
  if (!trainSetupValueId(id)) return;
  if (isTraining() && ['ai1', 'ai2', 'pop', 'gens', 'mut', 'speed', 'mode', 'opp', 'startmode', 'opdiff'].includes(id)) return;
  cycleTrainRow(id, -1);
}

function renderTermMenu() {
  if (!termLinesEl) return;
  termLinesEl.innerHTML = '';
  updateTermHints();

  if (termMode === 'skins') {
    renderSkinEditor();
    return;
  }
  if (termMode === 'accys') {
    renderAccyEditor();
    return;
  }
  if (termMode === 'handGear') {
    renderGearEditor();
    return;
  }
  if (termMode === 'mapSettings') {
    renderMapSettings();
    return;
  }
  if (termMode === 'aiTraining') {
    renderAITraining();
    return;
  }

  TERM_ROWS.forEach((row, i) => {
    const line = document.createElement('div');
    line.className = 'term-row' + (i === termCursor ? ' on' : '');
    const num = i + 1;

    const key = document.createElement('span');
    key.className = 'k';
    key.textContent = `${i === termCursor ? '>' : ' '} [${num}] ${row.label}${'.'.repeat(Math.max(1, 22 - row.label.length))}`;

    const val = document.createElement('span');
    val.className = 'v';
    val.textContent = termValue(row) || 'ENTER';

    line.appendChild(key);
    line.appendChild(val);

    if (row.id === 'skins') {
      line.addEventListener('click', enterSkinEditor);
    } else if (row.id === 'accys') {
      line.addEventListener('click', enterAccyEditor);
    } else if (row.id === 'handGear') {
      line.addEventListener('click', enterGearEditor);
    } else if (row.id === 'anim') {
      line.addEventListener('click', openAnimatorEditor);
    } else if (row.id === 'hit') {
      line.addEventListener('click', openHitboxCustomizerEditor);
    } else if (row.id === 'sandbox') {
      line.addEventListener('click', openSandbox);
    } else if (row.id === 'settings') {
      line.addEventListener('click', () => {
        termCursor = i;
        SFX.menuSelect();
        enterMapSettings();
      });

    } else if (row.id === 'mode' || row.id === 'aiDifficulty') {
      line.addEventListener('click', () => {
        termCursor = i;
        SFX.menuSelect();
        termCycle(TERM_ROWS[termCursor], 1);
        renderTermMenu();
      });
    } else if (row.id === 'aiTraining') {
      line.addEventListener('click', () => {
        termCursor = i;
        SFX.menuConfirm();
        enterAITraining();
      });
    } else if (row.id !== 'start') {
      line.addEventListener('click', () => {
        if (termCursor === i) termCycle(row, 1);
        termCursor = i;
        SFX.menuSelect();
        renderTermMenu();
      });
    } else {
      line.addEventListener('click', startFromTerm);
    }
    termLinesEl.appendChild(line);
  });

  // Last-build changelog footnote: proves the current build's changes are live
  // and records when they were applied (local time at boot). Update the text
  // whenever the combat/movement behavior ships a visible change.
  const changelog = document.createElement('div');
  changelog.className = 'term-line term-sub';
  changelog.textContent = `${termBuildStamp}  TWO direction-independent aerials (Light knocks flat Â· Heavy launches up with upward recoil) Â· DOWN+HEAVY summons a horse the cowboy mounts and RIDES forward (trampling hitbox, upward-outward launch) â€” attack recovery is tunable per move in the Hitbox Customizer.`;
  termLinesEl.appendChild(changelog);

  drawMainPreview();
}

// When the build was applied (local time, computed once at boot) â€” shown in the
// terminal menu so it is always obvious the latest combat changes are live.
const _termBootTime = new Date();
const termBuildStamp = `[BUILD ${_termBootTime.getFullYear()}-${String(_termBootTime.getMonth() + 1).padStart(2, '0')}-${String(_termBootTime.getDate()).padStart(2, '0')} ${String(_termBootTime.getHours()).padStart(2, '0')}:${String(_termBootTime.getMinutes()).padStart(2, '0')}]`;

function updateTermHints() {
  const h = document.getElementById('term-hints');
  if (!h) return;
  if (termMode === 'skins') {
    h.innerHTML = 'SIZE row: drag the slider, type a number, or use < / > or A/D arrows (Shift = x10). '
      + 'R = reset size, ESC/Backspace = back. Fits the skin to the circle â€” auto-saves per fighter.';
  } else if (termMode === 'accys') {
    h.innerHTML = 'ACCESSORY: cycle hats with < / > (or A/D). SIZE/ANGLE adjust, X/Y POSITION move it, FLIP mirrors, '
      + 'LAYER toggles behind/front, R = reset. DRAG the hat in the preview to set X/Y, double-click recentres. '
      + 'ESC/Backspace = back. Auto-saves per fighter.';
  } else if (termMode === 'handGear') {
    h.innerHTML = 'HAND GEAR dresses each hand separately. EDITING HAND picks which arm LEFT/RIGHT GEAR, SIZE, ANGLE and FLIP act on. '
      + 'Shaping a bare hand auto-equips gloves so the change is visible; LEFT/RIGHT HAND GEAR still unequips to NONE. '
      + 'MATCH BOTH HANDS copies the edited hand onto the other, R resets both to the character default. '
      + 'ESC/Backspace = back. Auto-saves per fighter.'
  } else if (termMode === 'mapSettings') {
      h.innerHTML = 'MAP SETTINGS: UP/DOWN to select. LEFT/RIGHT to cycle colors and death-zone margins (±20px). The side preview fits the DEATH ZONE (red KO box) with the real arena + platforms inside — selected edge highlights yellow. ESC/BACKSPACE to go back.';
   } else if (termMode === 'aiTraining') {
     h.innerHTML = 'AI TRAINING: UP/DOWN pick a row. LEFT/RIGHT cycle values. ENTER on POPULATION/GENERATIONS types a custom number, on START/STOP begins/ends evolution. ESC/BACKSPACE = back. '
       + 'Two gene pools (one per character) fight real 1-stock bouts â€” selection keeps the best, crossover + mutation breed the rest. Best models auto-save per character and load via AI DIFFICULTY (Hard/Expert/Trained, * = model present).';
   } else {
    h.innerHTML = 'UP/DOWN or W/S pick a row. < / > or A/D cycle values, ENTER opens/confirms, ESC = back. '
      + 'START FREE PLAY puts two fighters in the arena â€” no attacks, no stocks: just movement. '
      + 'P1: WASD move / Shift dodge Â· P2: Numpad. Bounce off the one floating platform â€” it drops through with DOWN. '
      + 'HAND/WEAPON ANIMATOR opens the visual editor for hands + weapons (timespace, anchors, library). '
      + 'HITBOX CUSTOMIZER lives per fighter / move â€” tune every attack box right where it lands in play. '
      + 'INTERACTIVE SANDBOX is a SEPARATE arena: build platforms and breakable boards, place spawns, then hit PLAY to fight in it with the real physics and combat. The main map is never modified.';
  }
}

// Main-menu preview: the current fighter ball + skin + accessory, exactly as it
// will look in the arena.
function drawMainPreview() {
  if (!previewCtx || !previewCanvas) return;
  const pctx = previewCtx;
  const W = previewCanvas.width;
  const H = previewCanvas.height;
  pctx.clearRect(0, 0, W, H);
  pctx.fillStyle = '#f3ead1';
  pctx.fillRect(0, 0, W, H);

  const f = ALL_FIGHTERS[previewFighterIdx];
  const conf = loadAccessoryFor(f.id, f.accessory);
  const R = 26;
  const S = 3.4;
  pctx.save();
  pctx.translate(W / 2, 240);
  pctx.scale(S, S);
  drawAccyMinifig(pctx, 0, 0, R, f, conf, loadHandGearFor(f.id, f.handGear));
  pctx.restore();

  pctx.textAlign = 'center';
  pctx.font = 'bold 16px monospace';
  pctx.fillStyle = '#111';
  pctx.fillText(f.name, W / 2, 404);
  pctx.font = '11px monospace';
  pctx.fillStyle = '#555';
  pctx.fillText('movement sandbox Â· no attacks, no stocks', W / 2, 422);
  pctx.fillText('P1: WASD + Shift dodge   Â·   P2: Numpad', W / 2, 440);
}

function onTermKey(e) {
  // State-aware routing: the terminal menu's keys may only act while the game
  // is actually in the MENU state and the overlay is visibly open. A stray
  // keypress during gameplay (e.g. M) can never navigate or reopen the menu.
  if (currentGameState !== 'menu') return;
  if (!selectOverlay || selectOverlay.style.display === 'none') return;
  const k = e.code;

  // When a slider or number box has focus, let the native control own the keys.
  const focusedEl = document.activeElement;
  const nativeFocused = (focusedEl instanceof HTMLInputElement && (focusedEl.type === 'range' || focusedEl.type === 'number' || focusedEl.type === 'text'))
    || focusedEl instanceof HTMLSelectElement;
  if ((termMode === 'skins' || termMode === 'accys' || termMode === 'handGear') && nativeFocused) {
    if (k === 'Escape' || (k === 'Backspace' && focusedEl.type !== 'text')) {
      e.preventDefault();
      if (termMode === 'skins') exitSkinEditor();
      else if (termMode === 'accys') exitAccyEditor();
      else if (termMode === 'handGear') exitGearEditor();
    }
    return;
  }

  if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space', 'Enter', 'NumpadEnter', 'Escape', 'Backspace'].includes(k)) {
    e.preventDefault();
  }

  if (termMode === 'skins') {
    onSkinEditorKey(e);
    return;
  }
  if (termMode === 'accys') {
    onAccyEditorKey(e);
    return;
  }
  if (termMode === 'handGear') {
    onGearEditorKey(e);
    return;
  }
  if (termMode === 'mapSettings') {
    onMapSettingsKey(e);
    return;
  }
  if (termMode === 'aiTraining') {
    onAITrainingKey(e);
    return;
  }

  if (k === 'ArrowUp' || k === 'KeyW') {
    termCursor = (termCursor - 1 + TERM_ROWS.length) % TERM_ROWS.length;
  } else if (k === 'ArrowDown' || k === 'KeyS') {
    termCursor = (termCursor + 1) % TERM_ROWS.length;
  } else if (k === 'ArrowLeft' || k === 'KeyA' || k === 'Minus' || k === 'NumpadSubtract') {
    if (termCursor < TERM_ROWS.length - 1) termCycle(TERM_ROWS[termCursor], -1);
  } else if (k === 'ArrowRight' || k === 'KeyD' || k === 'Equal' || k === 'NumpadAdd') {
    if (termCursor < TERM_ROWS.length - 1) termCycle(TERM_ROWS[termCursor], 1);
  } else if (k === 'Enter' || k === 'NumpadEnter' || k === 'Space') {
    if (TERM_ROWS[termCursor] && TERM_ROWS[termCursor].id === 'skins') {
      enterSkinEditor();
      return;
    }
    if (TERM_ROWS[termCursor] && TERM_ROWS[termCursor].id === 'accys') {
      enterAccyEditor();
      return;
    }
    if (TERM_ROWS[termCursor] && TERM_ROWS[termCursor].id === 'handGear') {
      enterGearEditor();
      return;
    }
    if (TERM_ROWS[termCursor] && TERM_ROWS[termCursor].id === 'anim') {
      openAnimatorEditor();
      return;
    }
    if (TERM_ROWS[termCursor] && TERM_ROWS[termCursor].id === 'hit') {
      openHitboxCustomizerEditor();
      return;
    }
    if (TERM_ROWS[termCursor] && TERM_ROWS[termCursor].id === 'sandbox') {
      openSandbox();
      return;
    }
if (TERM_ROWS[termCursor] && TERM_ROWS[termCursor].id === 'settings') {
        SFX.menuSelect();
        enterMapSettings();
        return;
      }
      if (TERM_ROWS[termCursor] && TERM_ROWS[termCursor].id === 'mode') {
        SFX.menuSelect();
        termCycle(TERM_ROWS[termCursor], 1);
        renderTermMenu();
        return;
      }
      if (TERM_ROWS[termCursor] && TERM_ROWS[termCursor].id === 'aiDifficulty') {
        SFX.menuSelect();
        termCycle(TERM_ROWS[termCursor], 1);
        renderTermMenu();
        return;
      }
      if (TERM_ROWS[termCursor] && TERM_ROWS[termCursor].id === 'aiTraining') {
        SFX.menuConfirm();
        enterAITraining();
        return;
      }
      startFromTerm();
    return;
  } else if (k.slice(0, 5) === 'Digit') {
    const n = parseInt(k.slice(5), 10);
    if (n >= 1 && n <= TERM_ROWS.length) termCursor = n - 1;
  } else {
    return;
  }
  SFX.menuSelect();
  renderTermMenu();
}

function onMapSettingsKey(e) {
  const k = e.code;
  if (k === 'Escape' || k === 'Backspace') {
    exitMapSettings();
    return;
  }
  if (k === 'ArrowUp' || k === 'KeyW') {
    termMapCursor = (termMapCursor - 1 + MAP_SETTINGS_ROWS.length) % MAP_SETTINGS_ROWS.length;
  } else if (k === 'ArrowDown' || k === 'KeyS') {
    termMapCursor = (termMapCursor + 1) % MAP_SETTINGS_ROWS.length;
  } else if (k === 'ArrowLeft' || k === 'KeyA' || k === 'Minus' || k === 'NumpadSubtract') {
    cycleMapSetting(MAP_SETTINGS_ROWS[termMapCursor], -1);
    return;
  } else if (k === 'ArrowRight' || k === 'KeyD' || k === 'Equal' || k === 'NumpadAdd') {
    cycleMapSetting(MAP_SETTINGS_ROWS[termMapCursor], 1);
    return;
  } else if (k === 'Enter' || k === 'NumpadEnter' || k === 'Space') {
    const row = MAP_SETTINGS_ROWS[termMapCursor];
    if (row.type === 'action') {
      exitMapSettings();
      return;
    }
    // Toggle rows (stopwatch) flip on Enter/Space, same as Left/Right.
    if (row.type === 'toggle') {
      cycleMapSetting(row, 1);
      return;
    }
    if (row.type === 'deathzoneReset') {
      cycleMapSetting(row, 1);
      return;
    }
    // For color settings, focus the row's inline hex field for custom input.
    if (row.type === 'color') {
      try {
        const rows = termLinesEl ? termLinesEl.children : null;
        // Header occupies the first child; rows follow in order.
        const line = rows ? rows[termMapCursor + 1] : null;
        const hex = line ? line.querySelector('input.hex') : null;
        if (hex) { hex.focus(); hex.select(); }
      } catch (_) {}
      return;
    }
  } else {
    return;
  }
  SFX.menuSelect();
  renderTermMenu();
}

// â”€â”€ SKIN SIZE customiser â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const SKIN_EDITOR_ROWS = [
  { type: 'fighter', label: 'PREVIEW FIGHTER' },
  { type: 'scale', label: 'SKIN SIZE' },
  { type: 'reset', label: 'RESET SIZE' },
];

function moveSkinCursor(dir) {
  termSkinCursor = (termSkinCursor + dir + SKIN_EDITOR_ROWS.length) % SKIN_EDITOR_ROWS.length;
}

function adjustSkinRow(row, dir, coarse) {
  const f = ALL_FIGHTERS[previewFighterIdx];
  const step = coarse ? 0.1 : 0.01;
  if (row.type === 'fighter') {
    previewFighterIdx = (previewFighterIdx + dir + ALL_FIGHTERS.length) % ALL_FIGHTERS.length;
  } else if (row.type === 'scale') {
    const next = Math.min(2.5, Math.max(0.3, skinScaleFor(f) + dir * step));
    f.skinScale = Math.round(next * 100) / 100;
    skinScaleCache[f.id] = f.skinScale;
    persistSkinScaleCache();
  } else if (row.type === 'reset') {
    delete skinScaleCache[f.id];
    f.skinScale = f._defaultSkinScale || 0.85;
    persistSkinScaleCache();
  }
  SFX.menuSelect();
  renderTermMenu();
}

function drawSkinPreview() {
  if (!previewCtx || !previewCanvas) return;
  const pctx = previewCtx;
  const W = previewCanvas.width;
  const H = previewCanvas.height;
  pctx.clearRect(0, 0, W, H);
  pctx.fillStyle = '#f3ead1';
  pctx.fillRect(0, 0, W, H);

  const f = ALL_FIGHTERS[previewFighterIdx];
  const cx = W / 2;
  const cy = 190;
  const r = 118;

  // The full (unclipped) skin image box â€” shows how much the circle crops.
  const skinEntry = getSkinImage(f.skin);
  let drawW = 0, drawH = 0;
  if (skinEntry && skinEntry.status === 'loaded' && skinEntry.img) {
    const img = skinEntry.img;
    const scale = (r * 2 * effectiveSkinScale(f)) / Math.min(img.width, img.height);
    drawW = img.width * scale;
    drawH = img.height * scale;
  }
  pctx.setLineDash([6, 6]);
  pctx.strokeStyle = 'rgba(17,17,17,0.35)';
  pctx.lineWidth = 1.5;
  pctx.strokeRect(cx - drawW / 2, cy - drawH / 2, drawW, drawH);
  pctx.setLineDash([]);

  pctx.beginPath();
  pctx.arc(cx, cy, r, 0, Math.PI * 2);
  pctx.fillStyle = 'rgba(0,0,0,0.06)';
  pctx.fill();

  if (skinEntry && skinEntry.status === 'loaded' && skinEntry.img) {
    const img = skinEntry.img;
    pctx.save();
    pctx.beginPath();
    pctx.arc(cx, cy, r, 0, Math.PI * 2);
    pctx.clip();
    pctx.drawImage(img, cx - drawW / 2, cy - drawH / 2, drawW, drawH);
    pctx.restore();
  } else {
    pctx.beginPath();
    pctx.arc(cx, cy, r, 0, Math.PI * 2);
    pctx.fillStyle = f.color;
    pctx.fill();
  }

  pctx.beginPath();
  pctx.arc(cx, cy, r, 0, Math.PI * 2);
  pctx.strokeStyle = f.color;
  pctx.lineWidth = 3;
  pctx.stroke();

  pctx.font = 'bold 17px monospace';
  pctx.textAlign = 'center';
  pctx.fillStyle = '#111';
  pctx.fillText(`SIZE ${skinScaleFor(f).toFixed(2)}`, cx, cy + r + 30);
  pctx.font = '11px monospace';
  pctx.fillText(`${f.name} â€” movement sandbox`, cx, cy + r + 48);
  pctx.fillText('grow/shrink the skin until it fits the circle', cx, cy + r + 64);
}

function renderSkinEditor() {
  const header = document.createElement('div');
  header.className = 'term-row head';
  header.textContent = 'SKIN SIZE  Â·  fit the fighter to its circle';
  termLinesEl.appendChild(header);

  SKIN_EDITOR_ROWS.forEach((row, i) => {
    const isOn = i === termSkinCursor;
    const line = document.createElement('div');
    line.className = 'term-row' + (isOn ? ' on' : '');
    const numText = (i < 9 ? ' ' : '') + (i + 1);
    const label = row.label;
    const key = document.createElement('span');
    key.className = 'k';
    key.textContent = `${isOn ? '>' : ' '} [${numText}] ${label}${'.'.repeat(Math.max(1, 22 - label.length))}`;
    line.appendChild(key);

    if (row.type === 'fighter') {
      const prevBtn = document.createElement('span');
      prevBtn.className = 'btn';
      prevBtn.textContent = '<';
      const nextBtn = document.createElement('span');
      nextBtn.className = 'btn';
      nextBtn.textContent = '>';
      prevBtn.addEventListener('click', () => { termSkinCursor = i; adjustSkinRow(row, -1, false); });
      nextBtn.addEventListener('click', () => { termSkinCursor = i; adjustSkinRow(row, 1, false); });
      const val = document.createElement('span');
      val.className = 'v';
      val.style.width = 'auto';
      val.style.textAlign = 'left';
      val.textContent = ALL_FIGHTERS[previewFighterIdx].name;
      line.appendChild(prevBtn);
      line.appendChild(nextBtn);
      line.appendChild(val);
    } else if (row.type === 'scale') {
      const f = ALL_FIGHTERS[previewFighterIdx];
      const range = document.createElement('input');
      range.type = 'range';
      range.min = 0.3;
      range.max = 2.5;
      range.step = 0.01;
      range.value = skinScaleFor(f);
      range.addEventListener('input', () => {
        f.skinScale = parseFloat(range.value);
        skinScaleCache[f.id] = f.skinScale;
        persistSkinScaleCache();
        num.value = f.skinScale.toFixed(2);
        drawSkinPreview();
      });
      const num = document.createElement('input');
      num.type = 'number';
      num.min = 0.3;
      num.max = 2.5;
      num.step = 0.01;
      num.className = 'num';
      num.value = skinScaleFor(f).toFixed(2);
      num.addEventListener('change', () => {
        const v = Math.min(2.5, Math.max(0.3, parseFloat(num.value) || 0.85));
        f.skinScale = Math.round(v * 100) / 100;
        skinScaleCache[f.id] = f.skinScale;
        persistSkinScaleCache();
        range.value = f.skinScale;
        num.value = f.skinScale.toFixed(2);
        drawSkinPreview();
      });
      line.appendChild(range);
      line.appendChild(num);
    } else if (row.type === 'reset') {
      const btn = document.createElement('span');
      btn.className = 'btn';
      btn.textContent = 'RESET';
      btn.addEventListener('click', () => { termSkinCursor = i; adjustSkinRow(row, 1, false); });
      const val = document.createElement('span');
      val.className = 'v';
      val.style.width = 'auto';
      val.textContent = 'R';
      line.appendChild(btn);
      line.appendChild(val);
    }

    line.addEventListener('click', () => {
      termSkinCursor = i;
      renderTermMenu();
    });

    termLinesEl.appendChild(line);
  });

  drawSkinPreview();
}

function onSkinEditorKey(e) {
  const k = e.code;
  if (k === 'ArrowUp' || k === 'KeyW') {
    moveSkinCursor(-1);
  } else if (k === 'ArrowDown' || k === 'KeyS') {
    moveSkinCursor(1);
  } else if (k === 'ArrowLeft' || k === 'KeyA' || k === 'Minus' || k === 'NumpadSubtract') {
    adjustSkinRow(SKIN_EDITOR_ROWS[termSkinCursor], -1, e.shiftKey);
    return;
  } else if (k === 'ArrowRight' || k === 'KeyD' || k === 'Equal' || k === 'NumpadAdd') {
    adjustSkinRow(SKIN_EDITOR_ROWS[termSkinCursor], 1, e.shiftKey);
    return;
  } else if (k === 'KeyR') {
    adjustSkinRow({ type: 'reset' }, 1, false);
    return;
  } else if (['Escape', 'Backspace', 'Enter', 'NumpadEnter', 'Space'].includes(k)) {
    exitSkinEditor();
    return;
  } else if (k.slice(0, 5) === 'Digit') {
    const n = parseInt(k.slice(5), 10);
    if (n >= 1 && n <= SKIN_EDITOR_ROWS.length) termSkinCursor = n - 1;
  } else {
    return;
  }
  SFX.menuSelect();
  renderTermMenu();
}

// â”€â”€ ACCESSORIES editor â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const ACCY_EDITOR_ROWS = [
  { type: 'fighter', label: 'PREVIEW FIGHTER' },
  { type: 'accy', label: 'ACCESSORY' },
  { type: 'size', label: 'SIZE' },
  { type: 'angle', label: 'ANGLE' },
  { type: 'shiftx', label: 'X POSITION' },
  { type: 'shifty', label: 'Y POSITION' },
  { type: 'flip', label: 'FLIP' },
  { type: 'layer', label: 'LAYER' },
  { type: 'reset', label: 'RESET' },
];

function moveAccyCursor(dir) {
  termAccyCursor = (termAccyCursor + dir + ACCY_EDITOR_ROWS.length) % ACCY_EDITOR_ROWS.length;
}

function adjustAccyRow(row, dir, coarse) {
  const f = ALL_FIGHTERS[previewFighterIdx];
  const conf = loadAccessoryFor(f.id, f.accessory);
  if (row.type === 'fighter') {
    previewFighterIdx = (previewFighterIdx + dir + ALL_FIGHTERS.length) % ALL_FIGHTERS.length;
  } else if (row.type === 'accy') {
    let i = ACCESSORIES.findIndex((a) => a.id === conf.type);
    if (i < 0) i = 0;
    conf.type = ACCESSORIES[(i + dir + ACCESSORIES.length) % ACCESSORIES.length].id;
  } else if (row.type === 'size') {
    conf.scale = Math.min(2.0, Math.max(0.4, (conf.scale || 1) + dir * (coarse ? 0.1 : 0.01)));
  } else if (row.type === 'angle') {
    conf.angle = ((conf.angle || 0) + dir * (coarse ? 10 : 1) + 180) % 360 - 180;
  } else if (row.type === 'shiftx') {
    conf.shiftX = Math.min(2.0, Math.max(-1.2, (conf.shiftX || 0) + dir * (coarse ? 0.1 : 0.02)));
  } else if (row.type === 'shifty') {
    conf.shiftY = Math.min(2.0, Math.max(-1.5, (conf.shiftY || 0) + dir * (coarse ? 0.1 : 0.02)));
  } else if (row.type === 'flip') {
    conf.flip = !conf.flip;
  } else if (row.type === 'layer') {
    conf.layer = conf.layer === 'behind' ? 'front' : 'behind';
  } else if (row.type === 'reset') {
    Object.assign(conf, cloneAccessory(null));
  }
  saveAccessoryFor(f.id, conf);
  SFX.menuSelect();
  renderTermMenu();
}

const ACCY_PREVIEW_RADIUS = 26;  // in-game ball radius
const ACCY_PREVIEW_ZOOM = 3.4;   // scale-up so the small fighter fills the panel

function drawAccyMinifig(ctx, x, y, R, f, conf, gear, opts) {
  // Preview facing (gear editor toggle; accessories previews stay right).
  // Anatomical mapping like the game: hands sit on the shared orbit at the
  // settled angle, so gear/weapon sides never swap between facings.
  const facing = !opts || opts.facingRight !== false;
  const showGuides = !!(opts && opts.guides);

  // One coordinate record for the preview body, hands and equipment — the same
  // SKIN_META + orbit rig the in-game renderer uses, so the preview can never
  // drift from the real rest pose.
  const meta = resolveSkinMeta(f);
  const rig = resolveOrbitRig(f);
  const vR = (typeof meta.bodyRadiusMul === 'number' && meta.bodyRadiusMul > 0) ? R * meta.bodyRadiusMul : R;

  // Ground shadow
  ctx.fillStyle = 'rgba(0,0,0,0.18)';
  ctx.beginPath();
  ctx.ellipse(x, y + vR + 1.5, vR * 0.8, vR * 0.28, 0, 0, Math.PI * 2);
  ctx.fill();

  // Behind-layer accessory sits behind the body
  if (conf && conf.type && conf.type !== 'none' && conf.layer === 'behind') {
    drawAccessory(ctx, x, y, vR, conf, facing ? 1 : -1);
  }

  // Orbit base hands at the preview facing (settled orbit angle, no travel):
  // the same canonical arrangement the game draws, so the preview shows the
  // real rest pose with correct anatomical sides in both facings.
  const previewPhi = orbitTarget(facing);
  const oPR = orbitHandPose(previewPhi, 'right', {}, rig);
  const oPL = orbitHandPose(previewPhi, 'left', {}, rig);
  const previewFront = orbitFrontSide(previewPhi, facing, false);
  const previewBack = previewFront === 'right' ? 'left' : 'right';
  const previewPosOf = (side) => (side === 'right' ? oPR : oPL);
  const handR = vR * (typeof meta.handRadius === 'number' ? meta.handRadius : 0.35);
  const handFill = resolveHandColor(f.id, f.color);
  const handState = (hx, hy, side) => {
    const px = x + hx, py = y + hy;
    ctx.beginPath();
    ctx.arc(px, py, handR, 0, Math.PI * 2);
    ctx.fillStyle = handFill;
    ctx.fill();
    ctx.strokeStyle = '#222222';
    ctx.lineWidth = 2.5 / ACCY_PREVIEW_ZOOM;
    ctx.stroke();
    // Fist gear hides where a held weapon grips (same rule as in game).
    if (gear && gear[side] && !holdCoversSide({ _fighterDef: f }, side)) {
      drawHandGear(ctx, px, py, handR, gear[side], !facing);
    }
    return { px, py };
  };

  // Fake fighter for the shared held layer (orbit rest pose, preview facing).
  // Anatomical hand records (left/right), matching the in-game fighter.
  const fake = {
    x, y, radius: vR, facingRight: facing, _fighterDef: f,
    _handL: { x: previewPosOf('left').x * vR, y: previewPosOf('left').y * vR },
    _handR: { x: previewPosOf('right').x * vR, y: previewPosOf('right').y * vR },
  };

  // Rear-layer weapons that are explicitly layer 'back' sit behind the body.
  drawHeldLayer(ctx, fake, x, y, 'back', false, vR);
  drawHeldLayer(ctx, fake, x, y, 'back', true, vR);

  // Body ball + skin, exactly the in-game formula (meta scale + centre offset)
  const skinEntry = getSkinImage(f.skin);
  const skinLoaded = skinEntry && skinEntry.status === 'loaded' && skinEntry.img;
  if (skinLoaded) {
    const img = skinEntry.img;
    const scale = (vR * 2 * effectiveSkinScale(f)) / Math.min(img.width, img.height);
    const ccx = meta.skinCenterX != null ? meta.skinCenterX : 0;
    const ccy = meta.skinCenterY != null ? meta.skinCenterY : 0;
    ctx.save();
    ctx.beginPath();
    ctx.arc(x, y, vR, 0, Math.PI * 2);
    ctx.clip();
    ctx.drawImage(img, x + ccx * scale - (img.width * scale) / 2, y + ccy * scale - (img.height * scale) / 2, img.width * scale, img.height * scale);
    ctx.restore();
  } else {
    ctx.beginPath();
    ctx.arc(x, y, vR, 0, Math.PI * 2);
    ctx.fillStyle = f.color;
    ctx.fill();
  }
  ctx.beginPath();
  ctx.arc(x, y, vR, 0, Math.PI * 2);
  ctx.strokeStyle = '#222222';
  ctx.lineWidth = 3 / ACCY_PREVIEW_ZOOM;
  ctx.stroke();

  // Fists draw over the body (rear then front), weapons over their fist.
  const backPt = handState(previewPosOf(previewBack).x * vR, previewPosOf(previewBack).y * vR, previewBack);
  drawHeldLayer(ctx, fake, x, y, 'front', false, vR);
  const frontPt = handState(previewPosOf(previewFront).x * vR, previewPosOf(previewFront).y * vR, previewFront);
  drawHeldLayer(ctx, fake, x, y, 'front', true, vR);

  // Anchor + grip guides (gear editor toggle): gold rings on the fist
  // anchors, cyan dots on each held weapon's grip with a connecting line.
  if (showGuides) {
    ctx.save();
    ctx.lineWidth = 2 / ACCY_PREVIEW_ZOOM;
    ctx.strokeStyle = '#d9a92e';
    for (const pt of [backPt, frontPt]) {
      if (!pt) continue;
      ctx.beginPath();
      ctx.arc(pt.px, pt.py, handR * 1.5, 0, Math.PI * 2);
      ctx.stroke();
    }
    try {
      const held = resolveHeld(f);
      const dir = facing ? 1 : -1;
      if (held) {
        for (const e of held) {
          if (!e) continue;
          const slot = { _fighterDef: f, facingRight: facing };
          const bs = resolveHoldSlot(e.hand || (e.hands === 'both' ? (e.primary || 'lead') : 'right'), slot);
          const hp = bs === 'right' ? fake._handR : fake._handL;
          const gx = x + hp.x + (e.mirror !== false ? dir : 1) * (e.dx || 0) * vR;
          const gy = y + hp.y + (e.dy || 0) * vR;
          ctx.strokeStyle = '#1d6fd6';
          ctx.beginPath();
          ctx.moveTo(x + hp.x, y + hp.y);
          ctx.lineTo(gx, gy);
          ctx.stroke();
          ctx.fillStyle = '#1d9fd6';
          ctx.beginPath();
          ctx.arc(gx, gy, 4 / ACCY_PREVIEW_ZOOM + 2, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    } catch (_) {}
    ctx.restore();
  }

  // Front-layer accessory on top
  if (conf && conf.type && conf.type !== 'none' && conf.layer !== 'behind') {
    drawAccessory(ctx, x, y, vR, conf, facing ? 1 : -1);
  }
}

function drawAccyPreview() {
  if (!previewCtx || !previewCanvas) return;
  const pctx = previewCtx;
  const W = previewCanvas.width;
  const H = previewCanvas.height;
  pctx.clearRect(0, 0, W, H);
  pctx.fillStyle = '#f3ead1';
  pctx.fillRect(0, 0, W, H);

  const f = ALL_FIGHTERS[previewFighterIdx];
  const conf = loadAccessoryFor(f.id, f.accessory);
  const R = ACCY_PREVIEW_RADIUS;
  const S = ACCY_PREVIEW_ZOOM;
  const px = W / 2;
  const py = 240;

  pctx.save();
  pctx.translate(px, py);
  pctx.scale(S, S);
  drawAccyMinifig(pctx, 0, 0, R, f, conf, loadHandGearFor(f.id, f.handGear));
  pctx.restore();

  pctx.textAlign = 'left';
  pctx.font = '11px monospace';
  pctx.fillStyle = '#444';
  pctx.fillText(`X ${conf.shiftX.toFixed(2)}  Â·  Y ${conf.shiftY.toFixed(2)}`, 10, 18);
  pctx.fillText(`SIZE ${conf.scale.toFixed(2)}  Â·  ANGLE ${conf.angle}Â°`, 10, 34);
  pctx.textAlign = 'center';
  pctx.font = 'bold 16px monospace';
  pctx.fillStyle = '#111';
  pctx.fillText(`${accessoryName(conf.type)}`, W / 2, 404);
  pctx.font = '11px monospace';
  pctx.fillText('drag the hat to position it Â· auto-saves', W / 2, 422);
  pctx.fillText(f.name, W / 2, 440);
}

let accyDragState = null;

function onAccyPreviewPointerDown(e) {
  if (termMode !== 'accys' || !previewCanvas) return;
  e.preventDefault();
  const conf = loadAccessoryFor(ALL_FIGHTERS[previewFighterIdx].id, ALL_FIGHTERS[previewFighterIdx].accessory);
  accyDragState = {
    pointerId: e.pointerId,
    startX: e.clientX,
    startY: e.clientY,
    shiftX: conf.shiftX || 0,
    shiftY: conf.shiftY || 0,
  };
  previewCanvas.setPointerCapture(e.pointerId);
}

function onAccyPreviewPointerMove(e) {
  if (!accyDragState) return;
  e.preventDefault();
  const f = ALL_FIGHTERS[previewFighterIdx];
  const conf = loadAccessoryFor(f.id, f.accessory);
  const ppu = ACCY_PREVIEW_RADIUS * ACCY_PREVIEW_ZOOM; // pixels per radius unit
  conf.shiftX = Math.min(2.0, Math.max(-1.2, accyDragState.shiftX + (e.clientX - accyDragState.startX) / ppu));
  conf.shiftY = Math.min(2.0, Math.max(-1.5, accyDragState.shiftY + (e.clientY - accyDragState.startY) / ppu));
  saveAccessoryFor(f.id, conf);
  drawAccyPreview();
}

function onAccyPreviewPointerUp(e) {
  if (!accyDragState) return;
  e.preventDefault();
  accyDragState = null;
  if (previewCanvas && previewCanvas.releasePointerCapture) {
    previewCanvas.releasePointerCapture(e.pointerId);
  }
  renderTermMenu(); // re-sync the X/Y slider + number boxes to the drag result
}

function onAccyPreviewDoubleClick() {
  if (termMode !== 'accys') return;
  const f = ALL_FIGHTERS[previewFighterIdx];
  const conf = loadAccessoryFor(f.id, f.accessory);
  conf.shiftX = 0;
  conf.shiftY = 0;
  saveAccessoryFor(f.id, conf);
  SFX.menuSelect();
  drawAccyPreview();
  renderTermMenu();
}

function accyRowValue(row) {
  const f = ALL_FIGHTERS[previewFighterIdx];
  const conf = loadAccessoryFor(f.id, f.accessory);
  switch (row.type) {
    case 'fighter': return f.name;
    case 'accy': return accessoryName(conf.type);
    case 'size': return conf.scale.toFixed(2);
    case 'angle': return `${conf.angle}Â°`;
    case 'shiftx': return conf.shiftX.toFixed(2);
    case 'shifty': return conf.shiftY.toFixed(2);
    case 'flip': return conf.flip ? 'MIRRORED' : 'NORMAL';
    case 'layer': return conf.layer === 'behind' ? 'BEHIND' : 'FRONT';
    default: return '';
  }
}

function renderAccyEditor() {
  const header = document.createElement('div');
  header.className = 'term-row head';
  header.textContent = 'ACCESSORIES  Â·  wear hats & gear (auto-saves)';
  termLinesEl.appendChild(header);

  ACCY_EDITOR_ROWS.forEach((row, i) => {
    const isOn = i === termAccyCursor;
    const line = document.createElement('div');
    line.className = 'term-row' + (isOn ? ' on' : '');
    const numText = (i < 9 ? ' ' : '') + (i + 1);
    const label = row.label;
    const key = document.createElement('span');
    key.className = 'k';
    key.textContent = `${isOn ? '>' : ' '} [${numText}] ${label}${'.'.repeat(Math.max(1, 22 - label.length))}`;
    line.appendChild(key);

    if (row.type === 'accy' || row.type === 'fighter' || row.type === 'flip' || row.type === 'layer') {
      const prevBtn = document.createElement('span');
      prevBtn.className = 'btn';
      prevBtn.textContent = '<';
      const nextBtn = document.createElement('span');
      nextBtn.className = 'btn';
      nextBtn.textContent = '>';
      prevBtn.addEventListener('click', () => { termAccyCursor = i; adjustAccyRow(row, -1, false); });
      nextBtn.addEventListener('click', () => { termAccyCursor = i; adjustAccyRow(row, 1, false); });
      const val = document.createElement('span');
      val.className = 'v';
      val.style.width = 'auto';
      val.style.textAlign = 'left';
      val.textContent = accyRowValue(row);
      line.appendChild(prevBtn);
      line.appendChild(nextBtn);
      line.appendChild(val);
    } else if (row.type === 'size' || row.type === 'angle' || row.type === 'shiftx' || row.type === 'shifty') {
      const f = ALL_FIGHTERS[previewFighterIdx];
      const conf = loadAccessoryFor(f.id, f.accessory);
      const rowKey = row.type;
      const CONF_KEY = { size: 'scale', angle: 'angle', shiftx: 'shiftX', shifty: 'shiftY' };
      const confKey = CONF_KEY[rowKey] || rowKey;
      const bounds = {
        size: { min: 0.4, max: 2.0, step: 0.01 },
        angle: { min: -180, max: 180, step: 1 },
        shiftx: { min: -1.2, max: 2.0, step: 0.02 },
        shifty: { min: -1.5, max: 2.0, step: 0.02 },
      }[rowKey];
      const range = document.createElement('input');
      range.type = 'range';
      range.min = bounds.min;
      range.max = bounds.max;
      range.step = bounds.step;
      range.value = conf[confKey];
      range.addEventListener('input', () => {
        const cur = loadAccessoryFor(f.id, f.accessory);
        cur[confKey] = parseFloat(range.value);
        saveAccessoryFor(f.id, cur);
        num.value = cur[confKey].toFixed(2);
        drawAccyPreview();
      });
      const num = document.createElement('input');
      num.type = 'number';
      num.min = bounds.min;
      num.max = bounds.max;
      num.step = bounds.step;
      num.className = 'num';
      num.value = conf[confKey].toFixed(2);
      num.addEventListener('change', () => {
        const cur = loadAccessoryFor(f.id, f.accessory);
        const v = Math.min(bounds.max, Math.max(bounds.min, parseFloat(num.value) || 1));
        cur[confKey] = Math.round(v * 100) / 100;
        saveAccessoryFor(f.id, cur);
        range.value = cur[confKey];
        num.value = cur[confKey].toFixed(2);
        drawAccyPreview();
      });
      line.appendChild(range);
      line.appendChild(num);
    } else if (row.type === 'reset') {
      const btn = document.createElement('span');
      btn.className = 'btn';
      btn.textContent = 'RESET';
      btn.addEventListener('click', () => { termAccyCursor = i; adjustAccyRow(row, 1, false); });
      const val = document.createElement('span');
      val.className = 'v';
      val.style.width = 'auto';
      val.textContent = 'R';
      line.appendChild(btn);
      line.appendChild(val);
    }

    line.addEventListener('click', () => {
      termAccyCursor = i;
      renderTermMenu();
    });

    termLinesEl.appendChild(line);
  });

  drawAccyPreview();
}

function onAccyEditorKey(e) {
  const k = e.code;
  if (k === 'ArrowUp' || k === 'KeyW') {
    moveAccyCursor(-1);
  } else if (k === 'ArrowDown' || k === 'KeyS') {
    moveAccyCursor(1);
  } else if (k === 'ArrowLeft' || k === 'KeyA' || k === 'Minus' || k === 'NumpadSubtract') {
    adjustAccyRow(ACCY_EDITOR_ROWS[termAccyCursor], -1, e.shiftKey);
    return;
  } else if (k === 'ArrowRight' || k === 'KeyD' || k === 'Equal' || k === 'NumpadAdd') {
    adjustAccyRow(ACCY_EDITOR_ROWS[termAccyCursor], 1, e.shiftKey);
    return;
  } else if (k === 'KeyR') {
    adjustAccyRow({ type: 'reset' }, 1, false);
    return;
  } else if (['Escape', 'Backspace', 'Enter', 'NumpadEnter', 'Space'].includes(k)) {
    exitAccyEditor();
    return;
  } else if (k.slice(0, 5) === 'Digit') {
    const n = parseInt(k.slice(5), 10);
    if (n >= 1 && n <= ACCY_EDITOR_ROWS.length) termAccyCursor = n - 1;
  } else {
    return;
  }
  SFX.menuSelect();
  renderTermMenu();
}

// â”€â”€ Hand-gear editor â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// The per-hand counterpart to the accessories editor above, and deliberately the
// same shape: a row list, a < / > stepper per row, live sliders, a shared
// minifig preview, and a save on every change.
//
// Basics only: which WEAPON each hand holds, plus that weapon's
// SIZE, X/Y offset and ANGLE. The EDITING HAND row picks which hand the WPN
// rows act on. RESET TO DEFAULT clears the fighter's held weapons and fist
// gear back to the built-in loadout.
const GEAR_ROWS = [
  { type: 'fighter', label: 'PREVIEW FIGHTER' },
  { type: 'hand',     label: 'EDITING HAND' },
  // Labels carry the hand they act on, so they are built per render.
  { type: 'weapon', label: () => `${termGearHand.toUpperCase()} WEAPON` },
  { type: 'wscale', label: () => `${termGearHand.toUpperCase()} WPN SIZE` },
  { type: 'wangle', label: () => `${termGearHand.toUpperCase()} WPN ANGLE` },
  { type: 'wx', label: () => `${termGearHand.toUpperCase()} WPN X OFF` },
  { type: 'wy', label: () => `${termGearHand.toUpperCase()} WPN Y OFF` },
  { type: 'reset', label: 'RESET TO DEFAULT' },
];

function moveGearCursor(dir) {
  termGearCursor = (termGearCursor + dir + GEAR_ROWS.length) % GEAR_ROWS.length;
}

// Basics-only hand editor: EDITING HAND picks the side (UI state, never
// persisted); every other row writes the editing hand's held-weapon entry
// through the rig store via saveRig.
// ── Rig + held-weapon editing helpers ────────────────────────────────────
// The editor works on a mutable COPY of the effective held array (def config
// overlaid by the rig-store override); every write saves the copy back via
// saveRig, so the game keeps reading an immutable array per frame.
function editHeldCopy(f) {
  const cur = resolveHeld(f);
  return (cur || []).map((e) => ({ ...(e || {}) }));
}
const _rigProbe = { _fighterDef: null, facingRight: true };
// Index of the one-handed entry covering a body side, or -1. Both-handed
// entries match through their primary slot.
function rigEntryIndex(copy, f, bodySide) {
  _rigProbe._fighterDef = f;
  for (let i = 0; i < copy.length; i++) {
    const e = copy[i];
    if (!e) continue;
    const slot = e.hands === 'both'
      ? resolveHoldSlot(e.primary || 'lead', _rigProbe)
      : resolveHoldSlot(e.hand || 'right', _rigProbe);
    if (slot === bodySide) return i;
  }
  return -1;
}
function rigWeaponIds() {
  const ids = ['NONE'];
  try {
    for (const w of allWeapons()) if (w && w.id) ids.push(w.id);
  } catch (_) {}
  return ids;
}
// Read helpers for the value column (no creation, no saving).
function rigEntryForValue(f, side) {
  const copy = editHeldCopy(f);
  const idx = rigEntryIndex(copy, f, side);
  return idx >= 0 ? copy[idx] : null;
}
function rigEntryWeapon(f, side) {
  const e = rigEntryForValue(f, side);
  return (e && e.weapon) || null;
}
function rigRowNumber(f, side, rowType) {
  const copy = editHeldCopy(f);
  const e = copy[rigEntryIndex(copy, f, side)];
  if (rowType === 'wscale') return e && typeof e.scale === 'number' ? e.scale : 1;
  if (rowType === 'wangle') return e && typeof e.angle === 'number' ? e.angle : 0;
  if (rowType === 'wx') return e && typeof e.dx === 'number' ? e.dx : 0;
  if (rowType === 'wy') return e && typeof e.dy === 'number' ? e.dy : 0;
  return 0;
}
function rigWriteNumber(f, side, rowType, v) {
  const copy = editHeldCopy(f);
  let idx = rigEntryIndex(copy, f, side);
  if (idx < 0) {
    copy.push({ weapon: null, hand: side, scale: 1, angle: 0, dx: 0, dy: 0, mirror: true, layer: 'front' });
    idx = copy.length - 1;
  }
  const e = copy[idx];
  if (rowType === 'wscale') e.scale = Math.max(0.2, Math.min(2.5, v));
  else if (rowType === 'wangle') e.angle = Math.max(-180, Math.min(180, v));
  else if (rowType === 'wx') e.dx = Math.max(-2, Math.min(2, v));
  else if (rowType === 'wy') e.dy = Math.max(-2, Math.min(2, v));
  saveRig(f.id, { held: copy });
}

function adjustGearRow(row, dir, coarse) {
  const f = ALL_FIGHTERS[previewFighterIdx];
  const side = termGearHand;
  const other = side === 'left' ? 'right' : 'left';
  if (row.type === 'fighter') {
    previewFighterIdx = (previewFighterIdx + dir + ALL_FIGHTERS.length) % ALL_FIGHTERS.length;
    SFX.menuSelect();
    renderTermMenu();
    return;
  }
  if (row.type === 'hand') {
    termGearHand = other;
    SFX.menuSelect();
    renderTermMenu();
    return;
  }
  if (row.type === 'wscale' || row.type === 'wangle' || row.type === 'wx' || row.type === 'wy') {
    const cur = rigRowNumber(f, side, row.type);
    const step = row.type === 'wscale' ? 0.01
      : row.type === 'wangle' ? 1 : 0.02;
    const jump = row.type === 'wscale' ? 0.1
      : row.type === 'wangle' ? 10 : 0.1;
    rigWriteNumber(f, side, row.type, cur + dir * (coarse ? jump : step));
    SFX.menuSelect();
    renderTermMenu();
    return;
  }
  if (row.type === 'weapon') {
    const ids = rigWeaponIds();
    const copy = editHeldCopy(f);
    const idx = rigEntryIndex(copy, f, side);
    const curId = idx >= 0 && copy[idx].weapon ? copy[idx].weapon : 'NONE';
    let at = ids.indexOf(curId);
    if (at < 0) at = 0;
    const next = ids[(at + dir + ids.length) % ids.length];
    if (next === 'NONE') {
      if (idx >= 0) copy.splice(idx, 1);
    } else if (idx >= 0) {
      copy[idx] = { ...copy[idx], weapon: next };
    } else {
      copy.push({ weapon: next, hand: side, scale: 1, angle: 0, dx: 0, dy: 0, mirror: true, layer: 'front' });
    }
    saveRig(f.id, { held: copy });
    SFX.menuSelect();
    renderTermMenu();
    return;
  }
  if (row.type === 'reset') {
    // Back to the character's own defaults: clears held weapons (whole rig
    // override) plus fist gear on BOTH hands — everyone comes out bare.
    clearRig(f.id);
    saveHandGearSetFor(f.id, {
      left: defaultHandGear(defaultGearIdFor(f.handGear, 'left')),
      right: defaultHandGear(defaultGearIdFor(f.handGear, 'right')),
    });
    SFX.menuSelect();
    renderTermMenu();
  }
}

function gearRowLabel(row) {
  return typeof row.label === 'function' ? row.label() : row.label;
}

function gearRowValue(row) {
  const f = ALL_FIGHTERS[previewFighterIdx];
  switch (row.type) {
    case 'fighter': return f.name;
    case 'hand': return termGearHand === 'left' ? 'LEFT' : 'RIGHT';
    case 'weapon': {
      const wid = rigEntryWeapon(f, termGearHand);
      if (!wid) return 'NONE';
      try {
        const w = getWeapon(wid);
        return (w && w.name ? w.name : wid).toUpperCase();
      } catch (_) { return 'NONE'; }
    }
    case 'wscale': return rigRowNumber(f, termGearHand, 'wscale').toFixed(2);
    case 'wangle': return `${Math.round(rigRowNumber(f, termGearHand, 'wangle'))}°`;
    case 'wx': return rigRowNumber(f, termGearHand, 'wx').toFixed(2);
    case 'wy': return rigRowNumber(f, termGearHand, 'wy').toFixed(2);
    default: return '';
  }
}

function drawGearPreview() {
  if (!previewCtx || !previewCanvas) return;
  const pctx = previewCtx;
  const W = previewCanvas.width;
  const H = previewCanvas.height;
  pctx.clearRect(0, 0, W, H);
  pctx.fillStyle = '#f3ead1';
  pctx.fillRect(0, 0, W, H);

  const f = ALL_FIGHTERS[previewFighterIdx];
  const conf = loadAccessoryFor(f.id, f.accessory);
  const gear = loadHandGearFor(f.id, f.handGear);
  const R = ACCY_PREVIEW_RADIUS;
  const S = ACCY_PREVIEW_ZOOM;

  pctx.save();
  pctx.translate(W / 2, 240);
  pctx.scale(S, S);
  // Isolated: a failure in the minifig paint must never freeze the preview or
  // swallow the value updates — the ring + status text below always paint, and
  // the error itself is shown on-canvas so a silent freeze becomes reportable.
  let minifigError = null;
  try {
    drawAccyMinifig(pctx, 0, 0, R, f, conf, gear, { facingRight: previewFacingRight, guides: gearGuidesOn });
  } catch (err) {
    minifigError = err;
    try { console.error('[gear-preview]', err); } catch (_) {}
  }
  pctx.restore();
  if (minifigError) {
    pctx.save();
    pctx.textAlign = 'center';
    pctx.font = 'bold 12px monospace';
    pctx.fillStyle = '#c0392b';
    pctx.fillText('PREVIEW PAINT ERROR', W / 2, 200);
    pctx.font = '10px monospace';
    pctx.fillStyle = '#555';
    const msg = String((minifigError && minifigError.message) || minifigError).slice(0, 44);
    pctx.fillText(msg, W / 2, 216);
    pctx.restore();
  }

  // Mark the hand currently being edited so the rows have a visible subject.
  // A ring, not a fill: it must not obscure the gear underneath. Uses the same
  // orbit rest pose as the minifig above, so the ring sits on the edited
  // anatomical hand in both facings.
  const editRig = resolveOrbitRig(f);
  const editMeta = resolveSkinMeta(f);
  const editVR = (typeof editMeta.bodyRadiusMul === 'number' && editMeta.bodyRadiusMul > 0) ? R * editMeta.bodyRadiusMul : R;
  const editPose = orbitHandPose(orbitTarget(previewFacingRight), termGearHand, {}, editRig);
  const handR = editVR * (typeof editMeta.handRadius === 'number' ? editMeta.handRadius : 0.35);
  const hx = editPose.x * editVR;
  const hy = editPose.y * editVR;
  try {
    pctx.save();
    pctx.translate(W / 2, 240);
    pctx.scale(S, S);
    pctx.beginPath();
    pctx.arc(hx, hy, handR * 2.05, 0, Math.PI * 2);
    pctx.strokeStyle = '#1d6fd6';
    pctx.lineWidth = 2 / ACCY_PREVIEW_ZOOM;
    pctx.setLineDash([6 / ACCY_PREVIEW_ZOOM, 4 / ACCY_PREVIEW_ZOOM]);
    pctx.stroke();
    pctx.restore();
  } catch (_) {
    try { pctx.restore(); } catch (_) {}
  }

  pctx.textAlign = 'left';
  pctx.font = '11px monospace';
  pctx.fillStyle = '#444';
  pctx.fillText(`EDITING ${termGearHand.toUpperCase()} HAND`, 10, 18);
  pctx.fillText(`L: ${handGearName(gear.left.type)}  ·  R: ${handGearName(gear.right.type)}`, 10, 34);
  const gc = gear[termGearHand];
  pctx.fillText(`X ${(gc.shiftX || 0).toFixed(2)}  ·  Y ${(gc.shiftY || 0).toFixed(2)}`, 10, 50);
  // Tell the user when the edited gear can't be seen: a gripped held weapon
  // covers fist gear by design, so shaping
  // it looks like nothing happens. Visual aid only — game logic untouched.
  let coverNote = '';
  try {
    if (gc.type !== 'none' && holdCoversSide({ _fighterDef: f }, termGearHand)) {
      coverNote = '  ·  HIDDEN BY HELD WEAPON';
    }
  } catch (_) {}
  pctx.fillText(`FACING ${previewFacingRight ? 'RIGHT' : 'LEFT'}${gearGuidesOn ? '  ·  GUIDES ON' : ''}${coverNote}`, 10, 64);
  pctx.textAlign = 'center';
  pctx.font = 'bold 16px monospace';
  pctx.fillStyle = '#111';
  pctx.fillText(handGearName(gear[termGearHand].type), W / 2, 404);
  pctx.font = '11px monospace';
  pctx.fillText('gear follows the hand through every move', W / 2, 422);
  pctx.fillText(f.name, W / 2, 440);
}

function renderGearEditor() {
  const header = document.createElement('div');
  header.className = 'term-row head';
  header.textContent = 'HAND WEAPONS - weapon per hand (auto-saves)';
  termLinesEl.appendChild(header);

  GEAR_ROWS.forEach((row, i) => {
    const isOn = i === termGearCursor;
    const line = document.createElement('div');
    line.className = 'term-row' + (isOn ? ' on' : '');
    const numText = (i < 9 ? ' ' : '') + (i + 1);
    const label = gearRowLabel(row);
    const key = document.createElement('span');
    key.className = 'k';
    key.textContent = `${isOn ? '>' : ' '} [${numText}] ${label}${'.'.repeat(Math.max(1, 22 - label.length))}`;
    line.appendChild(key);

    const isStepper = row.type === 'fighter' || row.type === 'hand' ||
      row.type === 'weapon';

    if (isStepper) {
      const prevBtn = document.createElement('span');
      prevBtn.className = 'btn';
      prevBtn.textContent = '<';
      const nextBtn = document.createElement('span');
      nextBtn.className = 'btn';
      nextBtn.textContent = '>';
      prevBtn.addEventListener('click', () => { termGearCursor = i; adjustGearRow(row, -1, false); });
      nextBtn.addEventListener('click', () => { termGearCursor = i; adjustGearRow(row, 1, false); });
      const val = document.createElement('span');
      val.className = 'v';
      val.style.width = 'auto';
      val.style.textAlign = 'left';
      val.textContent = gearRowValue(row);
      line.appendChild(prevBtn);
      line.appendChild(nextBtn);
      line.appendChild(val);
    } else if (row.type === 'wscale' || row.type === 'wangle' || row.type === 'wx' || row.type === 'wy') {
      // Held-weapon numeric rows (rig store): same slider + number pattern,
      // writing through rigWriteNumber.
      const f = ALL_FIGHTERS[previewFighterIdx];
      const bounds = {
        wscale: { min: 0.2, max: 2.5, step: 0.01 },
        wangle: { min: -180, max: 180, step: 1 },
        wx: { min: -2, max: 2, step: 0.02 },
        wy: { min: -2, max: 2, step: 0.02 },
      }[row.type];
      const startVal = rigRowNumber(f, termGearHand, row.type);
      const isAngle = row.type === 'wangle';
      const fmt = (v) => (isAngle ? Math.round(v) : v.toFixed(2));
      const range = document.createElement('input');
      range.type = 'range';
      range.min = bounds.min;
      range.max = bounds.max;
      range.step = bounds.step;
      range.value = startVal;
      const num = document.createElement('input');
      num.type = 'number';
      num.min = bounds.min;
      num.max = bounds.max;
      num.step = bounds.step;
      num.className = 'num';
      num.value = fmt(startVal);
      const side = termGearHand;
      const write = (v) => {
        rigWriteNumber(f, side, row.type, v);
        drawGearPreview();
      };
      range.addEventListener('input', () => {
        const v = parseFloat(range.value);
        write(v);
        num.value = fmt(v);
      });
      num.addEventListener('change', () => {
        const v = Math.min(bounds.max, Math.max(bounds.min, parseFloat(num.value) || 0));
        write(Math.round(v * 100) / 100);
        range.value = v;
        num.value = fmt(v);
      });
      line.appendChild(range);
      line.appendChild(num);
    } else if (row.type === 'reset') {
      const btn = document.createElement('span');
      btn.className = 'btn';
      btn.textContent = 'RESET';
      btn.addEventListener('click', () => { termGearCursor = i; adjustGearRow(row, 1, false); });
      const val = document.createElement('span');
      val.className = 'v';
      val.style.width = 'auto';
      val.textContent = 'R';
      line.appendChild(btn);
      line.appendChild(val);
    }

    line.addEventListener('click', () => {
      termGearCursor = i;
      renderTermMenu();
    });

    termLinesEl.appendChild(line);
  });

  drawGearPreview();
}

function onGearEditorKey(e) {
  const k = e.code;
  if (k === 'ArrowUp' || k === 'KeyW') {
    moveGearCursor(-1);
  } else if (k === 'ArrowDown' || k === 'KeyS') {
    moveGearCursor(1);
  } else if (k === 'ArrowLeft' || k === 'KeyA' || k === 'Minus' || k === 'NumpadSubtract') {
    adjustGearRow(GEAR_ROWS[termGearCursor], -1, e.shiftKey);
    return;
  } else if (k === 'ArrowRight' || k === 'KeyD' || k === 'Equal' || k === 'NumpadAdd') {
    adjustGearRow(GEAR_ROWS[termGearCursor], 1, e.shiftKey);
    return;
  } else if (k === 'KeyR') {
    adjustGearRow({ type: 'reset' }, 1, false);
    return;
  } else if (['Escape', 'Backspace', 'Enter', 'NumpadEnter', 'Space'].includes(k)) {
    exitGearEditor();
    return;
  } else if (k.slice(0, 5) === 'Digit') {
    const n = parseInt(k.slice(5), 10);
    if (n >= 1 && n <= GEAR_ROWS.length) termGearCursor = n - 1;
  } else {
    return;
  }
  SFX.menuSelect();
  renderTermMenu();
}
function startFromTerm() {
  SFX.menuConfirm();
  if (selectOverlay) selectOverlay.style.display = 'none';
  startNewMatch();
}

// â”€â”€ Hand/Weapon Animator editor â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function openAnimatorEditor() {
  if (!canvas) return;
  SFX.menuConfirm();
  if (selectOverlay) selectOverlay.style.display = 'none';
  const def = () => (ALL_FIGHTERS[matchSettings.p1] ? { ...ALL_FIGHTERS[matchSettings.p1] } : {});
  openEditor(canvas, def);
  currentGameState = 'animator';
}

function closeAnimatorEditor() {
  closeEditor();
  showSelectOverlay();
}

// â”€â”€ Hitbox Customizer â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function openHitboxCustomizerEditor() {
  if (!canvas) return;
  SFX.menuConfirm();
  if (selectOverlay) selectOverlay.style.display = 'none';
  const def = () => (ALL_FIGHTERS[matchSettings.p1] ? { ...ALL_FIGHTERS[matchSettings.p1] } : {});
  openHitboxCustomizer(canvas, def);
  currentGameState = 'hitboxes';
}

function closeHitboxCustomizerEditor() {
  closeHitboxCustomizer();
  showSelectOverlay();
}

// â”€â”€ Interactive Sandbox / map editor â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// A separate arena with its own stage, spawn points, blast zones, camera
// framing and document, plus a real playable session. It never touches the
// main map: createDefaultStage() is only ever called for a match, and the
// sandbox builds its own stage object (the Sandbox section of Stage.js). Entering and
// leaving it tears its session down, so nothing â€” fighter, projectile, AI
// controller, breakable or hitbox â€” survives into a match that runs next.
//
// In the editor the sandbox owns the keyboard (its listeners run in the capture
// phase and stop propagation). In a session the editor is detached and the keys
// below are read in onPlayKey: I pause, V quarter speed, B hitboxes, ESC back to
// the editor, M main menu.
function openSandbox() {
  if (!canvas) return;
  SFX.menuConfirm();
  if (selectOverlay) selectOverlay.style.display = 'none';
  // Any live match or training run releases the loop first, so headless bouts
  // and sandbox fighters can never both be simulating.
  try { stopTraining(); } catch (_) {}
  stopSandboxSession();
  // The sandbox keeps its own square arena — the taller match pit stays out.
  setSandboxArenaSize(VIEW_W, VIEW_H);
  openSandboxEditor(canvas, {
    onClose: closeSandbox,
    onPlay: startSandboxPlay,
  });
  currentGameState = 'sandbox';
}

function closeSandbox() {
  stopSandboxSession();
  currentGameState = 'menu';
  showSelectOverlay();
}

// PLAY: hand the editor's document to a real session and simulate it. The
// document itself is untouched, so ESC returns to an editor showing exactly the
// arena the session just played.
function startSandboxPlay() {
  if (!arena) return;
  SFX.menuConfirm();
  const document_ = getSandboxDocument();
  // Silent close: the editor steps aside, it is not dismissed â€” firing the close
  // handler here would bounce straight back to the main menu.
  closeSandboxEditor(true);
  setSandboxArenaSize(VIEW_W, VIEW_H);
  startSandboxSession(document_, VIEW_W, VIEW_H);
  currentGameState = 'sandboxPlay';
}

function endSandboxPlay() {
  stopSandboxSession();
  // Hand the simulation back to the shared systems: a match that starts next
  // must not inherit a hitbox, a lock or a stage reference from the sandbox.
  resetCombat();
  resetCamera();
  resetTimeDilation();
  resetDamageIndicators();
  // The match owns the stage again. Safe even if no match has run yet, because
  // the default stage is a pure function of the arena size.
  stage = buildMatchStage();
  setCombatStage(stage);
}

 // The sandbox session's per-frame entry. Its own key handling lives in
// onPlayKey (I / V are two bindings of the same 'grab' action, so an edge query
// cannot tell them apart â€” raw key codes can), and the rest is the shared step.
function updateSandboxPlay(dt, now) {
  updateSandboxSession(dt, now);
  // The session's fighters read Input.js just-pressed edges through the same
  // paths a match uses, so the frame's edges must be cleared here or a held key
  // would re-trigger its action every frame.
  flushInput();
}

// Back to the editor with the document intact. The editor was only closed
// silently when the session started, so its listeners and state are all that is
// needed to resume â€” no document reload, no lost edits.
function returnToSandboxEditor() {
  endSandboxPlay();
  openSandboxEditor(canvas, { onClose: closeSandbox, onPlay: startSandboxPlay });
  currentGameState = 'sandbox';
}

function startNewMatch() {
  // A live match owns the simulation loop â€” any running training session is
  // stopped first (best-so-far is saved) so headless bouts never leak into it.
  try { stopTraining(); } catch (_) {}
  const f1Def = ALL_FIGHTERS[matchSettings.p1];
  const f2Def = ALL_FIGHTERS[matchSettings.p2];
  const skin1 = resolveFighterSkin(f1Def);
  const skin2 = resolveFighterSkin(f2Def);

  stage = buildMatchStage();
  setCombatStage(stage);
  const sp1 = stage.spawnPoints[0];
  const sp2 = stage.spawnPoints[1];

  fighter1 = createFighter(1, sp1.x, sp1.y - 30, skin1, {
    id: 'player1',
    color: '#4a9eff',
    radius: f1Def.radius || 26,
    skinScale: skinScaleFor(f1Def),
    accessory: loadAccessoryFor(f1Def.id, f1Def.accessory),
    handGear: loadHandGearFor(f1Def.id, f1Def.handGear),
    runSpeed: f1Def.runSpeed || 91,
    airSpeed: (f1Def.runSpeed || 91) * 0.85,
    jumpForce: f1Def.jumpForce || 680,
    doubleJumpForce: (f1Def.jumpForce || 680) * 1.2,
    gravityMul: f1Def.gravityMul || 1,
    fallMaxMul: f1Def.fallMaxMul || 1,
    airAccelMul: f1Def.airAccelMul || 1,
    recoveryMul: f1Def.recoveryMul || 1,
    launchResist: f1Def.launchResist || 1,
    recoveryStrength: f1Def.recoveryStrength || 1,
    recoveryRange: f1Def.recoveryRange || 1,
    recoveryCooldown: f1Def.recoveryCooldown || 0,
  });
  fighter1._fighterDef = f1Def;
  fighter1._match = null;
  fighter1.stocks = matchSettings.stocks;
  fighter1.eliminated = false;

  fighter2 = createFighter(2, sp2.x, sp2.y - 30, skin2, {
    id: 'player2',
    color: '#ff4a4a',
    radius: f2Def.radius || 26,
    skinScale: skinScaleFor(f2Def),
    accessory: loadAccessoryFor(f2Def.id, f2Def.accessory),
    handGear: loadHandGearFor(f2Def.id, f2Def.handGear),
    runSpeed: f2Def.runSpeed || 91,
    airSpeed: (f2Def.runSpeed || 91) * 0.85,
    jumpForce: f2Def.jumpForce || 680,
    doubleJumpForce: (f2Def.jumpForce || 680) * 1.2,
    gravityMul: f2Def.gravityMul || 1,
    fallMaxMul: f2Def.fallMaxMul || 1,
    airAccelMul: f2Def.airAccelMul || 1,
    recoveryMul: f2Def.recoveryMul || 1,
    launchResist: f2Def.launchResist || 1,
    recoveryStrength: f2Def.recoveryStrength || 1,
    recoveryRange: f2Def.recoveryRange || 1,
    recoveryCooldown: f2Def.recoveryCooldown || 0,
  });
  fighter2._fighterDef = f2Def;
  fighter2._match = null;
  fighter2.stocks = matchSettings.stocks;
  fighter2.eliminated = false;

  attachAnimator(fighter1);
    attachAnimator(fighter2);

  // Pre-decode + upload match art now (skins, hats, weapon sprites) so the
  // first in-match draws never hitch on network/decode/upload mid-fight.
  try { warmFighterArt([fighter1, fighter2]); } catch (_) {}

    // Initialize AI controllers based on game mode. Old controllers are
    // disposed first so restarted matches never keep stale fighter refs.
    for (const c of aiControllers) {
      if (c && typeof c.dispose === 'function') {
        try { c.dispose(); } catch (_) {}
      }
    }
    aiControllers[0] = null;
    aiControllers[1] = null;

    switch (gameMode) {
      case 'playerVsPlayer':
        // Both players human - no AI controllers
        break;
      case 'playerVsDummy':
        // Player 1 human, Player 2 dummy (no AI â€” dummy input stays passive).
        break;
      case 'playerVsAI': {
        // Player 1 human, Player 2 AI at the selected difficulty (trained
        // model loads automatically when the difficulty needs one; falls
        // back to scripted AI when no model exists â€” never crashes).
        const diff = matchSettings.aiDifficulty || 'Normal';
        aiControllers[1] = new AIController(fighter2, fighter1, null, {
          difficulty: diff,
          charId: f2Def.id,
        });
        break;
      }
      case 'AIvsAI':
        // Both players AI â€” independent controllers, independent decisions.
        // Each side uses its own character's model at the set difficulty.
        aiControllers[0] = new AIController(fighter1, fighter2, null, {
          difficulty: matchSettings.aiDifficulty || 'Normal',
          charId: f1Def.id,
        });
        aiControllers[1] = new AIController(fighter2, fighter1, null, {
          difficulty: matchSettings.aiDifficulty || 'Normal',
          charId: f2Def.id,
        });
        break;
    }

   resetCamera();
  // Frame-1 final zoom: snap pan + dynamic zoom straight onto the spawn
  // formation, synchronously â€” no intro animation, no easing from wide.
  // updateCamera() then tracks dynamically from these correct values.
  try { snapCameraToFit(fightersPair(), VIEW_W, VIEW_H, stage); } catch (_) {}
  isPaused = false;
  tweakEditing = false; tweakDraft = '';
  matchOver = false;
  matchWinner = null;
  matchOverAge = 0;
  matchElapsed = 0; // stopwatch restarts at 00:00 every match
  resetCombat(); // clear any leftover hitboxes from a previous match
  resetTimeDilation(); // and any leftover slow-mo / orange tint
  resetDamageIndicators(); // and any stale floating damage numbers
  resetWorldFx(); // clear any lingering ability particles
  resetCinematic(); // clear any cinematic camera, tint or KO/trail particles
  // START MATCH only ARMS the match. It goes to 'ready' and waits for the player
  // to confirm with SPACE, so the fight never begins while they are still getting
  // to it. The arming keypress is dropped here on purpose - otherwise the very
  // press that armed the gate would also satisfy it and the wait would be a no-op.
  currentGameState = 'ready';
  // Clear this frame's key edges so the arming press cannot register as a jump
  // (Space is P1's jump key) or an attack once the match really begins. Only the
  // edges are cleared; genuinely held keys still read as held.
  flushInput();
}

// A blast-zone fall costs one stock. Survivors respawn at 0% via the existing
// soft reset (stocks preserved); a fighter losing its last stock is
// eliminated ('dead' â€” skipped by camera, physics and rendering) and the
// match ends immediately. Same-frame double KOs: both lose a stock; if both
// hit zero it is a draw, otherwise the survivor wins.
function _eliminateFighter(who) {
  who.eliminated = true;
  who.state = 'dead';
  who.vx = 0; who.vy = 0;
  removeAttackerHitboxes(who);
  clearHitLocks(who);
  who.attack = null;
  who.attackBuffer = null;
  who.hitstun = 0;
  who.launchTimer = 0;
  if (who._projectiles) who._projectiles.length = 0;
  who._teleportPending = null;
  who._horse = null;
  who._parryWindow = 0;
  who._parryBuff = null;
  who._knightCounter = 0;
  who._counterResolving = false;
  clearDeadeye(who);
  clearBoxerState(who);
}

// Completed disappearance event: the fighter is already removed above, is no
// longer rendered/tracked, and its final world position (captured before the
// removal) is handed to the existing KO pillar exactly once.
function _onFighterDisappeared(x, y) {
  try {
    if (Number.isFinite(x) && Number.isFinite(y)) notifyCinematicKO(x, y);
  } catch (_) {}
}
function onBlastKO(f) {
  if (matchOver || !f || f.eliminated) return;
  // Capture the final valid world position FIRST (before any reset moves
  // the fighter), then register the KO exactly once.
  const kx = f.x, ky = f.y;
  f.stocks = Math.max(0, (f.stocks ?? 1) - 1);
  const other = f === fighter1 ? fighter2 : fighter1;
  const otherBlasted = other && !other.eliminated && isInBlastZone(other, stage);
  let okx = null, oky = null;
  if (otherBlasted) {
    okx = other.x; oky = other.y;
    other.stocks = Math.max(0, (other.stocks ?? 1) - 1);
  }
  // Deciding-KO from authoritative stock state (existing winner rules).
  const fOut = f.stocks <= 0;
  const otherOut = otherBlasted && other.stocks <= 0;
  const deciding = fOut || otherOut;
  if (deciding) {
    // Remove the decided fighter(s) from active gameplay + rendering.
    const pairs = [[f, true], [other, otherBlasted]];
    for (let pi = 0; pi < pairs.length; pi++) {
      const who = pairs[pi][0], blasted = pairs[pi][1];
      if (!who || !blasted) continue;
      if (who.stocks <= 0) _eliminateFighter(who);
      else softResetFighter(who, stage);
    }
    // Pillar(s) at the exact disappearance point(s) - before any zoom.
    _onFighterDisappeared(kx, ky);
    if (otherBlasted) _onFighterDisappeared(okx, oky);
    if (fOut && otherOut) {
      matchWinner = 0; // draw
    } else if (fOut) {
      matchWinner = other === fighter1 ? 1 : 2;
    } else {
      matchWinner = f === fighter1 ? 1 : 2;
    }
    // Match ends now; the CAMERA zoom itself is gated until
    // MATCH_ZOOM_DELAY elapses (see cameraMatchOver), so the zoom provably
    // starts after disappearance + pillar.
    matchOver = true;
    matchOverAge = 0;
    resetTimeDilation();
    return;
  }
  // Non-deciding KO: disappearance via soft reset, pillar at that point,
  // match continues with no match-ending zoom.
  softResetFighter(f, stage);
  if (otherBlasted) softResetFighter(other, stage);
  _onFighterDisappeared(kx, ky);
  if (otherBlasted) _onFighterDisappeared(okx, oky);
}

// Soft blast-zone respawn (costs one stock, handled in onBlastKO above) now
// lives in session.js as softResetFighter(f, stage): the sandbox arena soft-
// respawns on a blast-zone fall too, and both need the identical reset.

// The victory dance the winner plays once the match ends. Keyed by character id
// because the animator hides a weapon whose animation has no entry for it
// (animator.js sampleInto), so cowboy and ninja need their own victory anim.
// A draw (matchWinner 0) celebrates nobody. This is the match's own addition to
// the shared combatâ†’animation mapping in session.js (syncFighterAnim), which
// takes the victory name as a parameter precisely so a mode with no winner â€” the
// sandbox â€” can use the same mapping.
function victoryAnimFor(f) {
  if (!matchOver || !f || f.state === 'dead' || matchWinner !== f.playerNum) return null;
  const def = f === fighter1 ? ALL_FIGHTERS[matchSettings.p1] : ALL_FIGHTERS[matchSettings.p2];
  // Per-character, because the animator HIDES a weapon declared as null â€” a
  // shared victory anim would make the winner's gun/sword/anything vanish. The
  // boxer fights bare-handed, so it gets its own weaponless anim.
  if (def && def.id === 'ninja') return 'ninjaVictory';
  if (def && def.id === 'boxer') return 'boxerVictory';
  if (def && def.id === 'knight') return 'knightVictory';
  if (def && def.id === 'pirate') return 'pirateVictory';
  return 'cowboyVictory';
}

// â”€â”€ Update â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
export function update(dt, now) {
  if (currentGameState === 'menu') {
    // Everything is driven by the HTML terminal overlay.
    flushInput();
    return;
  }
  if (currentGameState === 'animator') {
    updateEditor(dt);
    flushInput();
    return;
  }
  if (currentGameState === 'hitboxes') {
    updateHitboxCustomizer(dt);
    flushInput();
    return;
  }
  if (currentGameState === 'sandbox') {
    // The editor simulates nothing â€” it is a document editor over a live
    // preview of the arena. The sandbox's own document is the only thing it
    // can change, and the main map is not involved.
    updateSandboxEditor(dt);
    flushInput();
    return;
  }
  if (currentGameState === 'sandboxPlay') {
    updateSandboxPlay(dt, now);
    return;
  }

  // Armed but not yet started: the arena is drawn and the fighters are at their
  // spawn points, but NOTHING simulates until the player confirms. Space is the
  // documented confirm (it is also P1's jump binding, which is why startNewMatch
  // flushes the arming press); attack/special keys work too so the gate is never
  // a dead end. The confirming press is flushed below so it cannot double as a
  // jump/attack on the match's first frame.
  if (currentGameState === 'ready') {
    const confirm = isJustPressed(1, 'jump') || isJustPressed(1, 'attack') || isJustPressed(1, 'special')
      || isJustPressed(2, 'jump') || isJustPressed(2, 'attack') || isJustPressed(2, 'special');
    flushInput();
    if (confirm) { currentGameState = 'playing'; _warmRenderCaches(); }
    return;
  }

  // Playing state
  if (!fighter1 || !fighter2) return;

  // Damage panel focused: hard freeze like a pause (match clock, rematch gate
  // and pause toggle all hold). Edges are flushed so UI keys never leak into
  // play; T / Esc handling lives in onPlayKey, independent of update.
  if (tweakEditing) { flushInput(); return; }

  // Match over does NOT freeze the simulation. The fighters keep running so the
  // winner can play their victory dance and normal physics (gravity, drift,
  // landing) keeps resolving, instead of the arena locking mid-pose behind a
  // result screen. What stops is the MATCH itself, not the game loop:
  //   - onBlastKO() early-returns while matchOver, so no further KOs,
  //   - the stopwatch stops accumulating (see below),
  //   - the rematch press stays gated behind a beat so it cannot be mashed.
  // The camera still settles on the winner: updateMatchZoom(dt, true) eases the
  // view to WINNER_MATCH_ZOOM and computeFraming excludes the eliminated loser.
  // `matchOver` is also handed to updateCamera, which is what switches the
  // single-subject framing from the modest live-match push-in to the full
  // winner close-up â€” so the zoom-in really is part of the announcement.
  if (matchOver) {
    matchOverAge += dt;
    const rematch =
      isJustPressed(1, 'attack') || isJustPressed(1, 'special') || isJustPressed(1, 'jump') ||
      isJustPressed(2, 'attack') || isJustPressed(2, 'special') || isJustPressed(2, 'jump');
    if (rematch && matchOverAge > 1.0) {
      startNewMatch();
      return;
    }
  }

  // Pause toggle (I / V)
  if (isJustPressed(1, 'grab') || isJustPressed(2, 'grab')) {
    isPaused = !isPaused;
    flushInput();
    return;
  }
  if (isPaused) return;

  // Global time-dilation (cowboy Down Light): while active, gameplay advances
  // at a fraction of its normal rate (movement, attacks, projectiles, VFX â€”
  // everything below gets the scaled dt), then eases back to full speed.
  // The orange arena tint rides the same timeline, read by render() each frame.
  const effDt = stepTimeDilation(dt);

 // Animate floating platforms
   updatePlatforms(stage, now);

    // Update AI controllers with the REAL stage (off-stage/recovery geometry).
    // Each controller owns independent synthetic inputs driving the exact same
    // movement + combat paths as human keys.
    if (aiControllers[0]) {
      try { aiControllers[0].update(effDt, now, stage); } catch (e) { console.error('[ai] P1 update failed:', e); }
    }
    if (aiControllers[1]) {
      try { aiControllers[1].update(effDt, now, stage); } catch (e) { console.error('[ai] P2 update failed:', e); }
    }

// Fighter input - human players read the real keyboard; AI fighters read
// their controller's synthetic triple; the dummy reads all-false (passive).
    const isDummy2 = gameMode === 'playerVsDummy';
    const input1 = inputForSlot(aiControllers[0]);
    const input2 = aiControllers[1] ? inputForSlot(aiControllers[1]) : (isDummy2 ? DUMMY_INPUT : null);

  // Movement / physics / platform pass, in the shared order (session.js). The
  // sandbox runs this same three-line body over its own roster and its own
  // stage, which is what makes a sandbox fight behave like a match fight.
  // Reused slot inputs + a stable resolver closure: the per-frame arrow
  // closure and the overrides object/keys array below used to allocate on
  // every update. _slotIn1/_slotIn2 are written here and read by the shared
  // _slotInputFor, so no closure or object is created per frame.
  _slotIn1 = input1;
  _slotIn2 = input2;
  stepRosterMovement(fightersPair(), stage, effDt, _slotInputFor);

  // Blast-zone fall costs a stock (respawn at 0%); last stock eliminates.
  if (isInBlastZone(fighter1, stage)) onBlastKO(fighter1);
  if (!matchOver && isInBlastZone(fighter2, stage)) onBlastKO(fighter2);
  // No early return when a KO just ended the match: the simulation deliberately
  // continues now (the winner celebrates), so this frame finishes like any other.
  // onBlastKO() itself early-returns while matchOver, so no second KO can land.

  // Â§42: no countdown, no time limit â€” the clock below is stopwatch-only.
  // It holds its final value once the match is over rather than ticking on.
  if (!matchOver) matchElapsed += dt;

  // Combat: attack entry from fresh presses (or the small input buffer), then
  // attack frames + hitbox resolution, then projectiles. combatInput is the ONLY
  // place that starts attacks, and it runs AFTER the platform pass resolved
  // grounded this frame â€” so "attack right as you land" correctly reads as a
  // grounded attack. AI overrides ride the same path as human presses.
  {
    _ovCount = 0;
    if (input1) { _overrides[1] = input1; _ovCount++; }
    else if (_overrides[1]) delete _overrides[1];
    if (input2) { _overrides[2] = input2; _ovCount++; }
    else if (_overrides[2]) delete _overrides[2];
    stepRosterCombat(fightersPair(), _ovCount ? _overrides : null, effDt);
  }

  // Cinematic layer (Special/Finish Zoom + launch trails): real dt so its
  // timers progress under slow-mo; processes the hit combat.js recorded and
  // drives the cutscene camera that updateCamera below eases toward.
  try { updateCinematic(dt, fightersPair(), stage, { matchOver }); } catch (_) {}

  // Floating damage numbers age with the effective world time.
  updateDamageIndicators(effDt);

  // Refreshes the failed-image retry clock. Lives here, in the update, so the
  // draw path never has to read the clock itself.
  try { tickSkinImageRetries(); } catch (_) {}

  // Ability particle layer (they age with effDt so they hold with the world
  // through a hit-stop freeze and ride the Deadeye slow-mo).
  updateWorldFx(effDt);

  // State resolve + animator mapping (combat/state â†’ animation, sample, blend,
  // mirror) + the landing squish, again from the shared step.
  stepRosterFinish(fightersPair(), effDt, victoryAnimFor);

  updateCameraZoom(effDt);
  updateMatchZoom(effDt, cameraMatchOver());
  updateCamera(fightersPair(), VIEW_W, VIEW_H, effDt, stage, cameraMatchOver());

  // Commit AI edge detection (held â†’ prevHeld) AFTER every consumer has read
  // this frame's synthetic inputs, then clear the frame's real-key edges.
  if (aiControllers[0] && typeof aiControllers[0].postFrame === 'function') {
    try { aiControllers[0].postFrame(); } catch (_) {}
  }
  if (aiControllers[1] && typeof aiControllers[1].postFrame === 'function') {
    try { aiControllers[1].postFrame(); } catch (_) {}
  }
  flushInput();
}

// â”€â”€ Render â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const _fontMenuTitle = `20px ${MONO}`;
const _fontMenuSub = `13px ${MONO}`;
const _menuLines = [
  'light attacks = J/Z (P1) Â· heavy attacks = K/X (P1)',
  'shield = L/C Â· dodge = Shift Â· ` shows hitboxes',
  'hold DOWN on a floating platform to drop through it',
  'fall past the edges and you lose a stock â€” last stock out ends the match',
];
// â”€â”€ Matchup banner: background text behind the fighters â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// "Cowboy vs Ninja" â€” the two players' chosen characters â€” centred over the
// main platform in WORLD space, so it tracks the stage exactly as the camera
// pans instead of sitting at a fixed spot on screen. Drawn straight after the
// platforms, which puts it underneath the fighters, their horses and every VFX
// layer (the requested layering: background art, not HUD).
// Milker (BrandSemut) is a single 400-weight face that already reads as
// extra-bold, so 400 is requested deliberately â€” asking for 700 would make the
// browser synthesise a smeared faux-bold on top of it. The monospace stack stays
// behind it as the fallback if the face is missing.
const _MATCHUP_FONT = `400 29px Milker, ${MONO}`;
const _MATCHUP_FILL = 'rgba(255,255,255,0.85)';
const _MATCHUP_STROKE = 'rgba(0,0,0,0.35)';
const _MATCHUP_STROKE_W = 5;
const _MATCHUP_PAD = 5;    // room for the outline stroke to fit inside the sprite
const _MATCHUP_LIFT = 30;  // baseline height above the platform's top surface

let _matchupKey = null;
let _matchupSprite = null; // { canvas, w, h, baseline }
let _matchupFontRequested = false;

// Milker is a webfont, so it arrives AFTER the first frames have already drawn.
// The banner sprite is cached and only rebuilt when the matchup changes, so
// without this it would rasterize in the fallback face and then keep those
// glyphs for the whole match. Invalidating the key on load forces exactly one
// rebuild with the real face. A failed/absent font simply resolves to an empty
// face list and costs one harmless rebuild in the fallback.
function ensureMatchupFont() {
  if (_matchupFontRequested) return;
  _matchupFontRequested = true;
  try {
    if (!document.fonts || !document.fonts.load) return;
    document.fonts.load(_MATCHUP_FONT, 'vs').then(() => { _matchupKey = null; }, () => {});
  } catch (_) {}
}

function mainGroundPlatform(st) {
  if (!st || !st.platforms) return null;
  for (let i = 0; i < st.platforms.length; i++) {
    if (st.platforms[i].isGround) return st.platforms[i];
  }
  return st.platforms[0] || null;
}

// Rasterized once per matchup change, then blitted. Stroking AND filling a
// ~20-glyph 48px string twice a frame is real rasterization work; a cached
// sprite turns the whole banner into one drawImage.
function buildMatchupSprite(text) {
  // Baked at WORLD_TEXT_SS like the other world-space text: the banner draws
  // under the camera transform, so a 1x (or DPR-only) bake is magnified by
  // the live zoom and reads as blurry. Blitted at logical size below.
  const s = WORLD_TEXT_SS;
  const c = document.createElement('canvas');
  const m = c.getContext('2d');
  m.font = _MATCHUP_FONT;
  m.textAlign = 'left';
  m.textBaseline = 'alphabetic';
  const mt = m.measureText(text);
  const asc = mt.actualBoundingBoxAscent || 40;
  const desc = mt.actualBoundingBoxDescent || 12;
  const w = Math.max(1, Math.ceil(mt.width) + _MATCHUP_PAD * 2);
  const h = Math.max(1, Math.ceil(asc + desc) + _MATCHUP_PAD * 2);
  c.width = Math.max(1, Math.ceil(w * s));
  c.height = Math.max(1, Math.ceil(h * s));

  // Re-apply state: resizing a canvas resets its 2D context.
  m.scale(s, s);
  m.font = _MATCHUP_FONT;
  m.textAlign = 'left';
  m.textBaseline = 'alphabetic';
  m.lineJoin = 'round';
  m.lineWidth = _MATCHUP_STROKE_W;
  m.strokeStyle = _MATCHUP_STROKE;
  m.strokeText(text, _MATCHUP_PAD, _MATCHUP_PAD + asc);
  m.fillStyle = _MATCHUP_FILL;
  m.fillText(text, _MATCHUP_PAD, _MATCHUP_PAD + asc);

  _matchupSprite = { canvas: c, w, h, baseline: _MATCHUP_PAD + asc };
}

function drawMatchupText(ctx) {
  // VERSUS TEXT setting (default ON): hides the stage "X vs Y" banner art.
  if (mapSettings.showMatchup === false) return;
  ensureMatchupFont();
  const plat = mainGroundPlatform(stage);
  if (!plat) return;
  const d1 = fighter1 && fighter1._fighterDef;
  const d2 = fighter2 && fighter2._fighterDef;
  // The label is rebuilt only when the matchup itself changes, never per
  // frame (the fixed-supersample bake needs no rebuild on DPR changes).
  const key = `${d1 ? d1.id : '?'}|${d2 ? d2.id : '?'}`;
  if (key !== _matchupKey) {
    _matchupKey = key;
    buildMatchupSprite(`${d1 ? d1.name : 'Player 1'} vs ${d2 ? d2.name : 'Player 2'}`);
  }
  const spr = _matchupSprite;
  if (!spr) return;
  ctx.drawImage(
    spr.canvas,
    plat.x + plat.width / 2 - spr.w / 2,
    (plat.y - _MATCHUP_LIFT) - spr.baseline,
    spr.w,
    spr.h
  );
}

export function render(now) {
  if (!canvas || !ctx || !arena) return;
  // Re-sync the backing store every frame: idempotent (a comparison when
  // nothing changed), and it picks up monitor moves / browser zoom / window
  // resizes that main.js listeners may have missed. Resizing resets context
  // state, so the screen transform + smoothing are re-installed right after.
  try { syncCanvasBacking(canvas); } catch (_) {}
  screenTransform();
  try {
    if (ctx.imageSmoothingEnabled !== true) ctx.imageSmoothingEnabled = true;
    if ('imageSmoothingQuality' in ctx && ctx.imageSmoothingQuality !== 'high') ctx.imageSmoothingQuality = 'high';
  } catch (_) {}
  const time = now || performance.now();
  // Default: no culling. The playing path below narrows these to the live
  // camera rect via updateViewBounds(); every other state (menu, editors,
  // sandbox with its own camera) draws everything, exactly as before. Reset
  // here so bounds from a previous match can never leak into another camera.
  resetViewBounds();

  // Live training preview: redraw the enlarged game-view canvas while an
  // AI-training bout is in flight (throttled inside).
  if (currentGameState === 'menu') {
    try { maybeRedrawTrainingPreview(time); } catch (_) {}
  }

  if (currentGameState === 'menu') {
    // Opaque full-canvas fill makes an explicit clearRect redundant.
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, arena.width, arena.height);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = _fontMenuTitle;
    ctx.fillStyle = '#33ff88';
    ctx.fillText('SMASH FIGHTERS', arena.width / 2, arena.height * 0.22);
    ctx.font = _fontMenuSub;
    ctx.fillStyle = '#1f7a45';
    ctx.fillText('> ball platform fighter â€” movement sandbox', arena.width / 2, arena.height * 0.26);
    ctx.fillStyle = '#2a9e55';
    for (let i = 0; i < _menuLines.length; i++) ctx.fillText(_menuLines[i], arena.width / 2, arena.height * 0.32 + i * 22);
    drawFps(ctx, arena.width, arena.height, time);
    return;
  }

  if (currentGameState === 'animator') {
    // The editor does not paint its own opaque background every frame.
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, arena.width, arena.height);
    renderEditor();
    drawFps(ctx, arena.width, arena.height, time);
    return;
  }

  if (currentGameState === 'hitboxes') {
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, arena.width, arena.height);
    renderHitboxCustomizer();
    drawFps(ctx, arena.width, arena.height, time);
    return;
  }

  if (currentGameState === 'sandbox') {
    // The editor paints its own opaque chrome (panel, top bar, status line)
    // over an arena preview built with the real stage/fighter renderers.
    renderSandboxEditor();
    drawFps(ctx, arena.width, arena.height, time);
    return;
  }

  if (currentGameState === 'sandboxPlay') {
    renderSandboxSession(ctx, time);
    drawFps(ctx, arena.width, arena.height, time);
    return;
  }

  // â”€â”€ Playing state render â”€â”€
  // Blit-free backdrop: the background is a FLAT OPAQUE COLOR (see
  // rebuildBackgroundCanvas — one fillRect, nothing else), so blitting it as a
  // 1080×1080 image every frame was painting 1,166,400 identical pixels per
  // frame. Profiling the real game canvas measured that single call at 96.6%
  // of ALL pixel work in the frame. A solid fillRect hits the rasterizer's
  // opaque-fill fast path instead: no source sampling, no per-pixel alpha
  // blend, no image surface lookup. Per-frame fill+blit pixels drop ~30x.
  ctx.fillStyle = mapSettings.backgroundColor || DEFAULT_BACKGROUND_COLOR;
  ctx.fillRect(0, 0, VIEW_W, VIEW_H);

  // Visible world rect for this frame (derived from the composed camera zoom +
  // pan): feeds the view-culling bounds in Effects / worldFx and the stage
  // platform skip. Computed once, reused by every world-space pass.
  updateViewBounds();

  ctx.save();
  // Backing scale snaps the camera pan to whole device pixels (no pan
  // shimmer on sharp edges); the camera state itself stays fractional.
  applyCameraTransform(ctx, VIEW_W, VIEW_H, screenScale());

  drawStage(ctx, stage, time, mapSettings.platformColor, _viewRect);

  // Matchup banner: background art centred on the main platform. Drawn here so
  // the fighters, their horses, VFX and the HUD all paint over it.
  drawMatchupText(ctx);

  // Treasure Hunt X markers (pirate passive): world objects on the ground,
  // under the fighters and their VFX.
  try { drawTreasures(ctx, time); } catch (_) {}

  // Fighter layering: after a successful hit the ATTACKER draws in front of
  // the fighter taking damage for the interaction window (set by combat.js on
  // applyHit, decayed in updateAttacks). Hands/weapons ride along with their
  // fighter since they're drawn inside drawFighter. Deterministic: if exactly
  // one fighter owns the window they draw last (on top); if both or neither,
  // the default order (fighter1, then fighter2) is kept.
  if (fighter1 && fighter2) {
    // Buff auras sit BEHIND the bodies: paint before either fighter layer.
    try { drawBoxerRollUnder(ctx, fighter1, time); } catch (_) {}
    try { drawBoxerRollUnder(ctx, fighter2, time); } catch (_) {}
    // Golden Orb halos (pirate Treasure Hunt): same behind-the-body slot.
    try { drawGoldOrbUnder(ctx, fighter1); } catch (_) {}
    try { drawGoldOrbUnder(ctx, fighter2); } catch (_) {}
    const aFront = (fighter1._hitRenderTimer || 0) > 0;
    const bFront = (fighter2._hitRenderTimer || 0) > 0;
    if (aFront && !bFront) {
      drawHorse(ctx, fighter2, time);
      drawFighter(ctx, fighter2, time);
      drawFighterVfx(ctx, fighter2);
      drawHorse(ctx, fighter1, time);
      drawFighter(ctx, fighter1, time);
      drawFighterVfx(ctx, fighter1);
    } else {
      drawHorse(ctx, fighter1, time);
      drawFighter(ctx, fighter1, time);
      drawFighterVfx(ctx, fighter1);
      drawHorse(ctx, fighter2, time);
      drawFighter(ctx, fighter2, time);
      drawFighterVfx(ctx, fighter2);
    }
    drawAbilityFx(ctx, fighter1, time);
    drawAbilityFx(ctx, fighter2, time);
    // Digging shovels read as held tools: over the bodies that grip them.
    try { drawDigShovel(ctx, fighter1, time); } catch (_) {}
    try { drawDigShovel(ctx, fighter2, time); } catch (_) {}
  }

  // Draw hitbox debug visualization (already inside the camera transform)
  if (showHitboxes) {
    drawCombatDebug(ctx, fightersPair());
  }

  // Draw damage percent meters (skipped for eliminated fighters)
  if (!fighter1.eliminated) drawHealthBar(ctx, fighter1, time);
  if (!fighter2.eliminated) drawHealthBar(ctx, fighter2, time);

  // Pasted-on-top damage numbers for each landed hit (world space).
  drawDamageIndicators(ctx, time);

  // World-space VFX pass (the ability particle layer: muzzle pops, warp rings,
  // mount dust). Nothing is drawn here for ordinary movement or combat.
  drawWorldFx(ctx);

  // Cinematic world-space pass (KO pillar, launch trails, final bursts).
  try { drawCinematicWorld(ctx); } catch (_) {}

  ctx.restore();

  // Off-screen markers: alive-but-outside-view fighters only (visual aid).
  try { drawOffscreenMarkers(); } catch (_) {}

  // Down Light time-dilation overlay: a full-screen ORANGE tint across the
  // entire arena while the world is in slow motion (semi-transparent so the
  // gameplay stays visible below). Screen-space, after the camera restore, so
  // it covers the whole arena no matter where the fighters are â€” and it is
  // purely an overlay, so once the effect fades the arena's colors return to
  // normal untouched.
  // Allocation-free read of the live dilation state (no snapshot object per
  // frame). Values are only read, never mutated, here.
  const tfx = peekTimeDilation();
  // The Deadeye target's glowing red mark is drawn in WORLD space by
  // Effects.drawAbilityFx inside the camera transform â€” it is glued to the
  // locked target entity and follows it exactly (no manual screen conversion).

  // Down Light time-dilation overlay: a full-screen ORANGE tint across the
  // entire arena while the world is in slow motion (semi-transparent so the
  // gameplay stays visible below). Screen-space, after the camera restore, so
  // it covers the whole arena no matter where the fighters are â€” and it is
  // purely an overlay, so once the effect fades the arena's colors return to
  // normal untouched.
  // Note: peek returns the live record, whose fields are curTint/curFlash
  // (tint/flash only exist on the timeDilationState() snapshot copy).
  if (tfx.active && (tfx.curTint > 0 || tfx.curFlash > 0)) {
    screenTransform();
    ctx.save();
    ctx.globalAlpha = Math.min(0.55, tfx.curTint + tfx.curFlash);
    ctx.fillStyle = '#ff8a00';
    ctx.fillRect(0, 0, VIEW_W, VIEW_H);
    ctx.restore();
  }

  // Cinematic tint (cyan for Special Zoom, red for Finish Zoom).
  try {
    const ct = cinematicTint();
    if (ct) {
      screenTransform();
      ctx.save();
      ctx.globalAlpha = ct.alpha;
      ctx.fillStyle = `rgb(${ct.color})`;
      ctx.fillRect(0, 0, VIEW_W, VIEW_H);
      ctx.restore();
    }
  } catch (_) {}

  // â”€â”€ Round HUD: stocks + round timer (screen space, always visible) â”€â”€
  // â”€â”€ Round HUD: stocks-only pill (top center). Â§42: NO timer here - the
  // old countdown UI and its rendering are fully removed, not hidden. The
  // separate display-only stopwatch lives bottom-left (see below).
  // The pill itself is toggleable in Settings (STOCK COUNTER); hiding it is
  // purely visual and never affects stock tracking or the result.
  if (mapSettings.showStocks !== false) {
    const s = screenTransform();
    ctx.save();
    const cx = VIEW_W / 2, y = 10;
    const s1 = fighter1.stocks ?? 0;
    const s2 = fighter2.stocks ?? 0;
    const total = Math.max(s1, s2, matchSettings.stocks);
    const pipR = 6, gap = 17;
    const half = (total * gap) / 2;
    // The label never changes: measure once, reuse the cached width.
    if (_hudLabelW < 0) {
      ctx.font = _fontHudBold;
      _hudLabelW = ctx.measureText('P1      P2').width;
    }
    const pillW = _hudLabelW + half * 2 + 36, pillH = 26;
    // Rebuild only when the stocks (or the backing density) actually change;
    // every other frame this is a single drawImage instead of ~20 ops
    // including two text rasterizations.
    const key = s1 + '|' + s2 + '|' + total + '|' + s.toFixed(3);
    if (key !== _pillKey || _pillScale !== s) {
      _pillKey = key;
      _buildPillSprite(pillW, pillH, half, total, cx, y, s1, s2, pipR, gap, s);
    }
    if (_pillSprite) ctx.drawImage(_pillSprite.canvas, cx - pillW / 2, y, pillW, pillH);
    ctx.restore();
  }

  // â”€â”€ Stopwatch (Â§42: display-only, bottom-left, toggleable in Settings) â”€â”€
  // Counts up from 00:00 every match. Reads matchElapsed only â€” nothing in
  // gameplay reads it back, so it can never end or affect a match.
  if (mapSettings.stopwatch !== false) {
    screenTransform();
    const w = VIEW_W;
    const h = VIEW_H;
    ctx.save();
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    ctx.font = _fontHudStopwatch;
    ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
    // The text only changes once per second: re-measure only then, and reuse
    // the cached string + width across the ~60 frames in between.
    const sw = formatStopwatch(matchElapsed);
    if (sw !== _swText) {
      _swText = sw;
      _swFull = `⏱ ${sw}`;
      _swW = ctx.measureText(_swFull).width;
    }
    ctx.fillRect(10, h - 30, _swW + 16, 22);
    ctx.fillStyle = '#9be8ff';
    ctx.fillText(_swFull, 18, h - 8);
    ctx.restore();
  }

  // Match over: deliberately NO overlay, NO scrim and NO text. The only feedback
  // is the camera â€” updateMatchZoom punches in to WINNER_MATCH_ZOOM and
  // computeFraming closes to WINNER_CAMERA_ZOOM with the eliminated loser
  // excluded, so the shot lands hard on the winner and then keeps closing in.
  // Rematch (any attack/jump press after a beat) and M-for-menu still work; they
  // are just no longer advertised on screen.

  // Armed-but-not-started: deliberately silent. The gate is a timing beat, not
  // a dialog, so there is no prompt here â€” the arena just sits frozen until the
  // player presses to begin.

  // Pause overlay
  if (isPaused) {
    screenTransform();
    const w = VIEW_W;
    const h = VIEW_H;
    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(0, 0, w, h);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = 'bold 72px "Segoe UI", Arial, sans-serif';
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = '#000000';
    ctx.lineWidth = 5;
    ctx.strokeText('PAUSED', w / 2, h * 0.4);
    ctx.fillText('PAUSED', w / 2, h * 0.4);
    ctx.font = '24px "Segoe UI", Arial, sans-serif';
    ctx.fillStyle = '#cccccc';
    ctx.fillText('Press GRAB to resume', w / 2, h * 0.55);
    ctx.restore();
  }

  // In-match damage panel: always visible during play, bottom-right in screen
  // space (outside the camera viewport). T focuses it for editing; the sim
  // freezes only while focused.
  if (currentGameState === 'playing' && (fighter1 || fighter2)) {
    screenTransform();
    const w = VIEW_W;
    const h = VIEW_H;
    ctx.save();
    const rows = [
      { label: 'P1', f: fighter1, color: '#4a9eff' },
      { label: 'P2', f: fighter2, color: '#ff4a4a' },
    ];
    if (tweakEditing) {
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      ctx.fillRect(0, 0, w, h);
    }
    const pw = 208, ph = tweakEditing ? 128 : 76;
    const px = w - pw - 12, py = h - ph - 12;
    ctx.fillStyle = tweakEditing ? '#f3ead1' : 'rgba(0, 0, 0, 0.55)';
    ctx.fillRect(px, py, pw, ph);
    ctx.strokeStyle = tweakEditing ? '#111' : 'rgba(255,255,255,0.35)';
    ctx.lineWidth = 2;
    ctx.strokeRect(px + 1, py + 1, pw - 2, ph - 2);
    ctx.textBaseline = 'top';
    ctx.fillStyle = tweakEditing ? '#111' : '#9be8ff';
    ctx.font = 'bold 12px Consolas, "Courier New", monospace';
    ctx.textAlign = 'center';
    ctx.fillText(tweakEditing ? 'SET DAMAGE' : 'DAMAGE [T]', px + pw / 2, py + 8);
    ctx.font = '13px Consolas, "Courier New", monospace';
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const ry = py + 28 + i * 22;
      const focused = tweakEditing && i === tweakCursor;
      if (focused) {
        ctx.fillStyle = '#111';
        ctx.fillRect(px + 8, ry - 2, pw - 16, 20);
        ctx.fillStyle = '#f3ead1';
      } else {
        ctx.fillStyle = tweakEditing ? r.color : '#ffffff';
      }
      const live = r.f ? Math.round(r.f.percent) + '%' : '--';
      const val = (focused && tweakDraft !== '') ? tweakDraft + '%' : live;
      ctx.textAlign = 'left';
      ctx.fillText((focused ? '> ' : '  ') + r.label, px + 16, ry);
      ctx.textAlign = 'right';
      ctx.fillText(val, px + pw - 16, ry);
    }
    if (tweakEditing) {
      ctx.textAlign = 'center';
      ctx.fillStyle = '#555';
      ctx.font = '10px Consolas, "Courier New", monospace';
      ctx.fillText('type 0-999 - ENTER apply', px + pw / 2, py + 74);
      ctx.fillText('ARROWS +-1 (SHIFT x10)', px + pw / 2, py + 88);
      ctx.fillText('UP/DOWN player - T/ESC done', px + pw / 2, py + 102);
    }
    ctx.restore();
  }

  drawFps(ctx, arena.width, arena.height, time);

// Time-dilation post-process LAST, so the colour inversion covers the entire
// finished frame â€” world, HUD and all â€” rather than stopping at the point in
// the draw order where it happened to be inserted. A no-op unless the cowboy
// Down Light effect is active.
drawTimeDilationPost(ctx, canvas);
}


// ── merged from core/perf.js ──
// Game.js — centralized performance configuration, feature flags,
// adaptive-quality state, and lightweight diagnostics.
//
// LAYER: performance infrastructure only. No gameplay, no physics, no input.
// Renderers read from here; nothing here ever writes gameplay state.
//
// DESIGN:
// - Sensible defaults preserve current appearance/behavior (all flags on the
//   safe path, quality HIGH, renderScale 1).
// - Manual quality (Settings > QUALITY) is the ceiling. Adaptive quality may
//   only REDUCE below the ceiling under sustained load, never exceed it.
// - Feature flags resolve to a single `modes` snapshot per frame (or on
//   change) so hot loops check one boolean, not dozens of flags.
// - All caches/pools stay bounded; every optimized path has a fallback.

export const PERF_DEFAULTS = {
  // Manual ceiling from Settings: 1 | 0.6 | 0.35
  manualFxScale: 1,
  // Detail knobs derived from the active tier (renderers read these).
  // particleDetail: 0=full, 1=reduced, 2=minimal
  // postDetail: 0=full, 1=simplified, 2=off (except essential tint)
  // textCache / batchParticles / batchTrails: safe optimized paths.
  renderScale: 1, // unused (backing resolution is owned by render.js); never changed live
};

const _cfg = { ...PERF_DEFAULTS };

// Quality tiers: render-only workload. Index 0=high .. 3=verylow.
export const QUALITY_TIERS = [
  { name: 'high',   fxScale: 1,    particleDetail: 0, postDetail: 0 },
  { name: 'medium', fxScale: 0.6,  particleDetail: 1, postDetail: 0 },
  { name: 'low',    fxScale: 0.35, particleDetail: 1, postDetail: 1 },
  { name: 'verylow', fxScale: 0.2, particleDetail: 2, postDetail: 2 },
];

let _tierIndex = 0;          // active adaptive tier (0=high)
let _manualCeiling = 0;      // index cap from manual setting (0=high..2)
let _listeners = [];

// Feature flags — risky paths stay behind these; all default to the safe
// optimized path that preserves visuals. `legacy` forces original code.
export const FLAGS = {
  batchParticles: true,
  batchTrails: true,
  textCache: true,
  simplifiedPost: true,
  legacy: false, // when true: original per-particle save/restore, per-seg trails
};

// Resolved once per frame by the orchestrator (Game.js render).
export const modes = {
  particleDetail: 0,
  postDetail: 0,
  batchParticles: true,
  batchTrails: true,
  textCache: true,
  simplifiedPost: true,
};

export function getPerfConfig() { return _cfg; }

export function setManualFxScale(scale) {
  _cfg.manualFxScale = scale;
  // Map manual scale to a ceiling tier: high->0, balanced->1, performance->2.
  _manualCeiling = scale >= 1 ? 0 : scale >= 0.6 ? 1 : 2;
  // Clamp active tier to the ceiling immediately (manual takes priority).
  if (_tierIndex < _manualCeiling) _applyTier(_manualCeiling, true);
  else _resolveModes();
}

export function onQualityChange(cb) {
  if (typeof cb === 'function') _listeners.push(cb);
  return () => { _listeners = _listeners.filter((f) => f !== cb); };
}

function _currentFxScale() {
  // Active scale is min(manual ceiling scale, adaptive tier scale).
  const manual = _cfg.manualFxScale;
  const tier = QUALITY_TIERS[_tierIndex].fxScale;
  return Math.min(manual, tier);
}

export function getActiveFxScale() { return _currentFxScale(); }
export function getTierIndex() { return _tierIndex; }
export function getTierName() { return QUALITY_TIERS[_tierIndex].name; }

// ── Adaptive backing resolution ──────────────────────────────────────────
// Backing-store scale per detail tier (index matches QUALITY_TIERS). Gentler
// than the particle fxScale curve on purpose: resolution is the most visible
// dimension, so tiers trim particles first and pixels second. The manual
// Settings quality caps it from above (high=full, balanced=0.85,
// performance=0.7); the adaptive tier picks the level within that ceiling.
// Gameplay coordinates never see any of this — only backing pixels change,
// and Game.js picks the resize up through its per-frame store sync, so camera,
// UI, input mapping and VFX stay aligned at every scale.
const TIER_RENDER_SCALES = [1, 0.8, 0.65, 0.55];
function _manualRenderCap() {
  const m = _cfg.manualFxScale;
  return m >= 1 ? 1 : m >= 0.6 ? 0.85 : 0.7;
}
export function getActiveRenderScale() {
  const tier = TIER_RENDER_SCALES[Math.max(0, Math.min(TIER_RENDER_SCALES.length - 1, _tierIndex))];
  return Math.min(_manualRenderCap(), tier);
}

function _resolveModes() {
  const t = QUALITY_TIERS[_tierIndex];
  modes.particleDetail = t.particleDetail;
  modes.postDetail = t.postDetail;
  modes.batchParticles = FLAGS.batchParticles && !FLAGS.legacy;
  modes.batchTrails = FLAGS.batchTrails && !FLAGS.legacy;
  modes.textCache = FLAGS.textCache && !FLAGS.legacy;
  modes.simplifiedPost = FLAGS.simplifiedPost && !FLAGS.legacy;
}

function _applyTier(idx, force) {
  idx = Math.max(_manualCeiling, Math.min(QUALITY_TIERS.length - 1, idx));
  if (!force && idx === _tierIndex) return false;
  _tierIndex = idx;
  _resolveModes();
  const scale = _currentFxScale();
  const payload = { tier: _tierIndex, name: getTierName(), fxScale: scale, renderScale: getActiveRenderScale(), modes };
  for (const cb of _listeners) {
    try { cb(payload); } catch (_) {}
  }
  return true;
}

// TIER SOURCE: physics.js owns the only frame-time sensor (real rAF-cadence
// based) and calls setTierFromLoop() on tier changes. The EMA sensor that used
// to live here (noteFrameTime / observeFrameTime) was dormant — nothing ever
// called it — so it was removed rather than left as a second, disagreeing
// set of thresholds.

// Map physics.js quality levels (2=high,1=medium,0=low) onto detail tiers,
// clamped by the manual ceiling. Called only on actual loop tier changes.
// A sustained collapse reaches verylow (not just low): at single-digit fps
// the low floor is still too heavy, and the climb-back hysteresis in the loop
// recovers automatically, so nothing gets stuck down here.
export function setTierFromLoop(loopLevel) {
  const mapped = loopLevel >= 2 ? 0 : loopLevel === 1 ? 1 : 3;
  _applyTier(mapped, false);
}

export function resetPerf() {
  _tierIndex = _manualCeiling;
  _resolveModes();
}

_resolveModes();
