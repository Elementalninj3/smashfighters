// Game.js â€” movement arena orchestrator + simplified terminal start menu.
// Two human fighters share the arena, move/jump/dash/dodge freely, and fight
// with the data-driven attack system in combat.js (light=J, heavy=K). Damage
// is a percent meter â€” no stocks, no stocks, soft blast-zone respawn only.
//
// The terminal overlay in index.html handles selection: pick a fighter, fit the
// skin to the circle (SKIN SIZE), wear accessories, then START FREE PLAY.

import { initInput, flushInput, isJustPressed } from './input/Input.js';
import {
  createFighter,
} from './fighter/Fighter.js';
import {
  createDefaultStage,
  drawStage,
  updatePlatforms,
  isInBlastZone,
} from './stage/Stage.js';
import {
  stepRosterMovement,
  stepRosterCombat,
  stepRosterFinish,
  softResetFighter,
  inputForSlot,
  DUMMY_INPUT,
  resolveFighterSkin,
} from './fighter/session.js';
import { updateCamera, applyCameraTransform, resetCamera, snapCameraToFit, updateCameraZoom, updateMatchZoom, getCameraState } from './core/camera.js';
import { SFX } from './core/sfx.js';
import {
  drawCombatDebug,
  resetCombat,
  removeAttackerHitboxes,
  clearHitLocks,
  clearDeadeye,
  clearBoxerState,
  __debugHitboxes,
  startAttackForKey,
  resolveAttackDef,
  setCombatStage,
} from './fighter/combat.js';
import { getSkinImage } from './render/Accessories.js';
import { drawFighter, drawAbilityFx, drawHorse, handConfig, resolveHandColor, setViewBounds } from './render/Effects.js';
import { drawFighterVfx, setVfxViewBounds } from './effects/vfx.js';
import {
  stepTimeDilation,
  timeDilationState,
  peekTimeDilation,
  resetTimeDilation,
  drawTimeDilationPost,
  updateDamageIndicators,
  drawDamageIndicators,
  resetDamageIndicators,
  updateWorldFx,
  drawWorldFx,
  resetWorldFx,
  setWorldFxViewBounds,
  setFxQuality,
  worldFxState,
} from './render/worldFx.js';
import {
  ACCESSORIES,
  accessoryName,
  loadAccessoryFor,
  saveAccessoryFor,
  cloneAccessory,
  drawAccessory,
} from './render/Accessories.js';
import {
  HAND_GEAR,
  handGearName,
  loadHandGearFor,
  saveHandGearFor,
  saveHandGearSetFor,
  defaultHandGear,
  drawHandGear,
} from './render/HandGear.js';
import { ALL_FIGHTERS } from './content/Menu.js';
import {
  openEditor,
  closeEditor,
  updateEditor,
  renderEditor,
  setEditorCloseHandler,
} from './anim/editor.js';
import {
  openHitboxCustomizer,
  closeHitboxCustomizer,
  updateHitboxCustomizer,
  renderHitboxCustomizer,
  setHitboxCustomizerCloseHandler,
  setCustomizerMove,
  setWorkingBoxValue,
  saveCustomizer,
  resetCustomizerMove,
  getWorkingBoxes,
} from './anim/hitboxCustomizer.js';
import { setAnimationLoader, updateAnimator, attachAnimator } from './anim/animator.js';
import { setCustomHitboxes, clearCustomHitboxes } from './fighter/hitboxData.js';
import { getAnimation, setAnimLibChangeListener } from './anim/library.js';
import { AIController, AI_DIFFICULTIES, configForDifficulty } from './ai/ai.js';
import { createTrainer } from './ai/ai-training.js';
import { loadTrainedModel, listTrainedModels } from './ai/ai-model-storage.js';
import {
  openSandboxEditor,
  closeSandboxEditor,
  updateSandboxEditor,
  renderSandboxEditor,
  isSandboxEditorOpen,
  getSandboxDocument,
  setSandboxArenaSize,
} from './stage/sandbox/SandboxEditor.js';
import {
  startSandboxSession,
  stopSandboxSession,
  updateSandboxSession,
  renderSandboxSession,
  isSandboxPlaying,
  toggleSandboxPause,
  isSandboxPaused,
  setSandboxTimeScale,
  getSandboxTimeScale,
  toggleSandboxDebug,
  getSandboxRoster,
  getSandboxStage,
  getSandboxSessionCount,
} from './stage/sandbox/SandboxSession.js';

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
let arena = { width: 1200, height: 1100 };
let stage = null;
let fighter1 = null;
let fighter2 = null;
let isPaused = false;
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
let matchElapsed = 0; // real seconds since match start â€” stopwatch source only
let matchOverAge = 0;

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
      // Render quality scaler for low-end hardware (HIGH default = full
      // visuals, identical to before). BALANCED trims particle spawn counts,
      // PERFORMANCE trims harder. Gameplay, damage and timing are untouched —
      // only the number of spawned ability particles changes.
      quality: ['high', 'balanced', 'performance'].includes(saved.quality) ? saved.quality : 'high',
    };
  } catch (_) {
    return { backgroundColor: DEFAULT_BACKGROUND_COLOR, platformColor: null, stopwatch: true, showStocks: true, quality: 'high' };
  }
})();
function persistMapSettings() {
  try { localStorage.setItem(MAP_SETTINGS_KEY, JSON.stringify(mapSettings)); } catch (_) {}
}

// Rebuild the background canvas with current settings
function rebuildBackgroundCanvas() {
  if (!_gridCanvas) return;
  const gctx = _gridCanvas.getContext('2d');
  gctx.fillStyle = mapSettings.backgroundColor || DEFAULT_BACKGROUND_COLOR;
  gctx.fillRect(0, 0, arena.width, arena.height);
  // No grid lines - clean background
}

// On-screen FPS counter (always drawn, top-right).
let _fpsValue = '--';
let _fpsFrames = 0;
let _fpsSince = 0;
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
let _hudLabelW = -1;
let _swText = null;
let _swFull = '';
let _swW = 0;
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
function updateViewBounds() {
  try {
    const cam = getCameraState();
    const zoom = cam.zoom || 1;
    const w = arena.width / zoom, h = arena.height / zoom;
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
  } catch (_) {}
}

function resetViewBounds() {
  try {
    setViewBounds(-1e9, -1e9, 1e9, 1e9);
    setWorldFxViewBounds(-1e9, -1e9, 1e9, 1e9);
    setVfxViewBounds(-1e9, -1e9, 1e9, 1e9);
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
  { id: 'quality', label: 'QUALITY', type: 'quality', value: () => (mapSettings.quality || 'high').toUpperCase() },
  { id: 'mapBack', label: 'BACK', type: 'action' },
];
const QUALITY_SCALES = { high: 1, balanced: 0.6, performance: 0.35 };
const QUALITY_ORDER = ['high', 'balanced', 'performance'];
function applyQuality() {
  try { setFxQuality(QUALITY_SCALES[mapSettings.quality] || 1); } catch (_) {}
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
let termMapCursor = 0;
let previewFighterIdx = 0;
let previewCanvas = null;
let previewCtx = null;
let selectOverlay = null;
let termLinesEl = null;

// Precomputed health-bar color LUT: 48 buckets over 0–150% (white → yellow →
// orange → red). Same math the per-frame branch used, evaluated once.
const _healthLut = (() => {
  const lut = new Array(48);
  for (let i = 0; i < 48; i++) {
    const pct = i / 47;
    let r, g, b;
    if (pct <= 0.33) {
      const t = pct / 0.33;
      r = 255; g = 255; b = Math.round(255 * (1 - t));
    } else if (pct <= 0.66) {
      const t = (pct - 0.33) / 0.33;
      r = 255; g = Math.round(255 * (1 - t * 0.5)); b = 0;
    } else {
      const t = (pct - 0.66) / 0.34;
      r = 255; g = Math.round(255 * (1 - t * 0.5)); b = 0;
    }
    lut[i] = `rgb(${r},${g},${b})`;
  }
  return lut;
})();

function drawHealthBar(ctx, fighter, time) {
  // Damage percent meter above the fighter.
  // Called inside the camera transform, so fighter.x/y are already world coords.
  const pct = Math.max(0, Math.min(1, fighter.percent / 150));

  // Background bar
  ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
  ctx.fillRect(fighter.x - 40, fighter.y - fighter.radius - 20, 80, 8);

  // Health color via precomputed LUT (48 buckets white → yellow → orange →
  // red). Identical colors within ~3%; replaces the per-frame rgb() template.
  const _hbIdx = Math.min(47, (pct * 47) | 0);

  // Foreground bar (health/damage) â€” always full width, color changes with damage
  ctx.fillStyle = _healthLut[_hbIdx];
  ctx.fillRect(fighter.x - 40, fighter.y - fighter.radius - 20, 80, 8);

  // Text
  ctx.fillStyle = 'white';
  ctx.font = _fontHealth;
  ctx.textAlign = 'center';
  ctx.fillText(Math.round(fighter.percent) + '%', fighter.x, fighter.y - fighter.radius - 25);
}

export function initGame(canvasEl) {
  canvas = canvasEl;
  ctx = canvas.getContext('2d');
  arena = { width: canvas.width, height: canvas.height };
  stage = createDefaultStage(arena.width, arena.height);
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
          persistAIConfig();
          try { renderTermMenu(); } catch (_) {}
          return true;
        },
        start: () => startTraining(),
        stop: () => stopTraining(),
        running: () => isTraining(),
        progress: () => (activeTrainer ? activeTrainer.snapshot() : trainProgress || trainDoneInfo || null),
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
    aiScores(pn) {
      try {
        const c = pn === 1 ? aiControllers[0] : aiControllers[1];
        if (!c || typeof c.debugScores !== 'function') return [];
        return c.debugScores();
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
  };
}

// Hitbox overlay toggle: ` (backtick) shows the active hitboxes in the arena.
// M during free play exits back to the terminal menu (no page reload needed).
// In the sandbox M leaves the sandbox entirely for the same menu.
function onPlayKey(e) {
  const inPlay = currentGameState === 'playing' || currentGameState === 'ready';
  if (e.code === 'Backquote' && (inPlay || currentGameState === 'sandboxPlay')) {
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
  } else if (row.id === 'quality') {
    // Render quality scaler (HIGH default = full visuals). Gameplay-agnostic:
    // only the ability-particle spawn counts change.
    const order = QUALITY_ORDER;
    const cur = order.indexOf(mapSettings.quality || 'high');
    mapSettings.quality = order[(cur + dir + order.length) % order.length];
    persistMapSettings();
    applyQuality();
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
    } else if (row.type === 'action') {
      line.addEventListener('click', () => {
        SFX.menuSelect();
        exitMapSettings();
      });
    }
    termLinesEl.appendChild(line);
  });
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
  trainDoneInfo = null;
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
    case 'toggle': return isTraining() ? 'STOP' : 'START';
    case 'back': return 'ENTER';
    default: return '';
  }
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
  try { renderTermMenu(); } catch (_) {}
  return true;
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

function renderAITraining() {
  const header = document.createElement('div');
  header.className = 'term-row head';
  header.textContent = 'AI TRAINING  Â·  evolve neural fighters (real bouts, real evolution)';
  termLinesEl.appendChild(header);

  const rows = [
    { id: 'ai1', label: 'AI 1 CHARACTER' },
    { id: 'ai2', label: 'AI 2 CHARACTER' },
    { id: 'pop', label: 'POPULATION SIZE' },
    { id: 'gens', label: 'MAX GENERATIONS' },
    { id: 'mut', label: 'MUTATION RATE' },
    { id: 'speed', label: 'TRAINING SPEED' },
    { id: 'showsim', label: 'SHOW SIMULATION' },
    { id: 'toggle', label: isTraining() ? 'STOP TRAINING' : 'START TRAINING' },
    { id: 'back', label: 'BACK' },
  ];
  if (termTrainCursor >= rows.length) termTrainCursor = 0;

  rows.forEach((row, i) => {
    // Config rows lock while running (changing the gene pool mid-evolution
    // would corrupt the run); START becomes STOP.
    const locked = isTraining() && ['ai1', 'ai2', 'pop', 'gens', 'mut', 'speed'].includes(row.id);
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
        if (termTrainCursor === i && row.id !== 'toggle' && row.id !== 'back') cycleTrainRow(row.id, 1);
        termTrainCursor = i;
        SFX.menuSelect();
        if (row.id === 'toggle') {
          if (isTraining()) stopTraining();
          else startTraining();
        } else if (row.id === 'back') {
          exitAITraining();
          return;
        }
        renderTermMenu();
      });
    }
    termLinesEl.appendChild(line);
  });

  // â”€â”€ Status block (read-only info lines, same DOM, no new architecture) â”€â”€
  const info = (text, cls) => {
    const d = document.createElement('div');
    d.className = 'term-row head' + (cls ? ' ' + cls : '');
    d.textContent = text;
    termLinesEl.appendChild(d);
  };
  info(trainedModelsLine());
  const p = trainProgress;
  if (p) {
    const gen = p.generation || 0;
    const max = p.maxGenerations || trainSettings.maxGenerations;
    info(`GENERATION ${gen} / ${max}`);
    info(progressBar(gen / Math.max(1, max)));
    info(`BEST FITNESS ${fmtFit(p.best)}   AVERAGE ${fmtFit(p.avg)}   BEST WINS ${p.bestWins || 0}`);
    const lr = p.lastResult;
    if (lr) {
      const w = lr.winner === 1 ? ALL_FIGHTERS[trainSettings.ai1].name : lr.winner === 2 ? ALL_FIGHTERS[trainSettings.ai2].name : 'draw';
      info(`LAST: GEN ${lr.gen} MATCH ${lr.match} WIN ${w} FIT ${lr.fitA}/${lr.fitB}`);
    }
  } else if (trainDoneInfo) {
    info(`DONE (${trainDoneInfo.reason}) â€” models saved`);
  } else {
    info(`${ALL_FIGHTERS[trainSettings.ai1].name} vs ${ALL_FIGHTERS[trainSettings.ai2].name} â€” press START TRAINING`);
  }
  if (trainSettings.showSim) {
    const live = document.createElement('div');
    live.className = 'term-row head';
    live.id = 'train-live-line';
    live.textContent = liveLineText();
    termLinesEl.appendChild(live);
  }
  drawTrainingPreview();
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
  const rows = ['ai1', 'ai2', 'pop', 'gens', 'mut', 'speed', 'showsim', 'toggle', 'back'];
  if (k === 'Escape' || k === 'Backspace') {
    exitAITraining();
    return;
  }
  if (k === 'ArrowUp' || k === 'KeyW') {
    termTrainCursor = (termTrainCursor - 1 + rows.length) % rows.length;
  } else if (k === 'ArrowDown' || k === 'KeyS') {
    termTrainCursor = (termTrainCursor + 1) % rows.length;
  } else if (k === 'ArrowLeft' || k === 'KeyA' || k === 'Minus' || k === 'NumpadSubtract') {
    cycleTrainRow(rows[termTrainCursor], -1);
  } else if (k === 'ArrowRight' || k === 'KeyD' || k === 'Equal' || k === 'NumpadAdd') {
    cycleTrainRow(rows[termTrainCursor], 1);
  } else if (k === 'Enter' || k === 'NumpadEnter' || k === 'Space') {
    const id = rows[termTrainCursor];
    if (id === 'back') { exitAITraining(); return; }
    if (id === 'toggle') {
      if (isTraining()) stopTraining();
      else startTraining();
      renderTermMenu();
      return;
    }
    if (id === 'pop' || id === 'gens') {
      // Custom numeric entry on top of the preset cycling.
      const cur = id === 'pop' ? trainSettings.populationSize : trainSettings.maxGenerations;
      const raw = prompt(`Enter ${id === 'pop' ? 'population size (2-200)' : 'max generations (1-2000)'}:`, String(cur));
      if (raw !== null) {
        const v = parseInt(raw, 10);
        if (Number.isFinite(v)) {
          if (id === 'pop') trainSettings.populationSize = Math.max(2, Math.min(200, v));
          else trainSettings.maxGenerations = Math.max(1, Math.min(2000, v));
          persistAIConfig();
        }
      }
      renderTermMenu();
      return;
    }
    cycleTrainRow(id, 1);
  } else if (k.slice(0, 5) === 'Digit') {
    const n = parseInt(k.slice(5), 10);
    if (n >= 1 && n <= rows.length) termTrainCursor = n - 1;
  } else {
    return;
  }
  SFX.menuSelect();
  renderTermMenu();
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
      + 'MATCH BOTH HANDS copies the edited hand onto the other, R resets both to the character default. '
      + 'ESC/Backspace = back. Auto-saves per fighter.';
  } else if (termMode === 'mapSettings') {
     h.innerHTML = 'MAP SETTINGS: UP/DOWN to select. LEFT/RIGHT to cycle colors. ENTER to input custom color, CLICK to cycle. ESC/BACKSPACE to go back.';
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
  const conf = loadAccessoryFor(f.id);
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
    // For color settings, prompt for custom input
    if (row.type === 'color') {
      const currentValue = typeof row.value === 'function' ? row.value() : row.value;
      const input = prompt('Enter color (HEX, RGB, or color name):', currentValue || '#ffffff');
      if (input !== null) {
        // Simple validation - if it's not empty, try to use it
        // The browser will handle invalid colors in the CSS parsing
        if (input.trim() !== '') {
          if (row.id === 'mapBgColor') {
            mapSettings.backgroundColor = input.trim();
          } else if (row.id === 'mapPlatColor') {
            // Handle special case for "DEFAULT"
            if (input.trim().toUpperCase() === 'DEFAULT') {
              mapSettings.platformColor = null;
            } else {
              mapSettings.platformColor = input.trim();
            }
          }
          persistMapSettings();
          if (row.id === 'mapBgColor') {
            rebuildBackgroundCanvas();
          } else {
            // Clear custom gradient cache so platforms redraw with new color
            if (stage && stage.platforms) {
              for (const plat of stage.platforms) {
                plat._customGradient = null;
                plat._customColor = null;
              }
            }
          }
        }
      }
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
    const scale = (r * 2 * skinScaleFor(f)) / Math.min(img.width, img.height);
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
  const conf = loadAccessoryFor(f.id);
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

function drawAccyMinifig(ctx, x, y, R, f, conf, gear) {
  const dirHand = 1; // facing right

  // Ground shadow
  ctx.fillStyle = 'rgba(0,0,0,0.18)';
  ctx.beginPath();
  ctx.ellipse(x, y + R + 1.5, R * 0.8, R * 0.28, 0, 0, Math.PI * 2);
  ctx.fill();

  // Behind-layer accessory sits behind the body
  if (conf && conf.type && conf.type !== 'none' && conf.layer === 'behind') {
    drawAccessory(ctx, x, y, R, conf);
  }

  // Neutral hands: back (non-striking) hand behind the body, front over it.
  const neutralPose = (handConfig.actions && handConfig.actions.neutral) || {
    start: { back: { x: 0.7, y: 0.35 }, front: { x: 0.7, y: 0.12 } },
  };
  const handR = R * 0.35;
  const handFill = resolveHandColor(f.id, f.color);
  // The minifig faces right, so its leading (front) hand is the fighter's RIGHT
  // hand and the trailing one is the LEFT â€” the same mapping drawFighter uses.
  const handState = (hx, hy, side) => {
    const px = x + hx, py = y + hy;
    ctx.beginPath();
    ctx.arc(px, py, handR, 0, Math.PI * 2);
    ctx.fillStyle = handFill;
    ctx.fill();
    ctx.strokeStyle = '#222222';
    ctx.lineWidth = 2.5 / ACCY_PREVIEW_ZOOM;
    ctx.stroke();
    if (gear && gear[side]) drawHandGear(ctx, px, py, handR, gear[side]);
  };

  // Back hand (behind the body)
  handState(-dirHand * R * neutralPose.start.back.x, R * neutralPose.start.back.y, 'left');

  // Body ball + skin, exactly the in-game formula
  const skinEntry = getSkinImage(f.skin);
  const skinLoaded = skinEntry && skinEntry.status === 'loaded' && skinEntry.img;
  if (skinLoaded) {
    const img = skinEntry.img;
    const scale = (R * 2 * skinScaleFor(f)) / Math.min(img.width, img.height);
    ctx.save();
    ctx.beginPath();
    ctx.arc(x, y, R, 0, Math.PI * 2);
    ctx.clip();
    ctx.drawImage(img, x - (img.width * scale) / 2, y - (img.height * scale) / 2, img.width * scale, img.height * scale);
    ctx.restore();
  } else {
    ctx.beginPath();
    ctx.arc(x, y, R, 0, Math.PI * 2);
    ctx.fillStyle = f.color;
    ctx.fill();
  }
  ctx.beginPath();
  ctx.arc(x, y, R, 0, Math.PI * 2);
  ctx.strokeStyle = '#222222';
  ctx.lineWidth = 3 / ACCY_PREVIEW_ZOOM;
  ctx.stroke();

  // Front hand (over the body)
  handState(dirHand * R * neutralPose.start.front.x, R * neutralPose.start.front.y, 'right');

  // Front-layer accessory on top
  if (conf && conf.type && conf.type !== 'none' && conf.layer !== 'behind') {
    drawAccessory(ctx, x, y, R, conf);
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
  const conf = loadAccessoryFor(f.id);
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
  const conf = loadAccessoryFor(ALL_FIGHTERS[previewFighterIdx].id);
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
  const conf = loadAccessoryFor(f.id);
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
  const conf = loadAccessoryFor(f.id);
  conf.shiftX = 0;
  conf.shiftY = 0;
  saveAccessoryFor(f.id, conf);
  SFX.menuSelect();
  drawAccyPreview();
  renderTermMenu();
}

function accyRowValue(row) {
  const f = ALL_FIGHTERS[previewFighterIdx];
  const conf = loadAccessoryFor(f.id);
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
      const conf = loadAccessoryFor(f.id);
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
        const cur = loadAccessoryFor(f.id);
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
        const cur = loadAccessoryFor(f.id);
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
// The one structural difference is the EDITING HAND row. LEFT HAND GEAR and
// RIGHT HAND GEAR each set their own side directly, but SIZE / ANGLE / FLIP act
// on ONE hand at a time â€” otherwise there would be six near-identical rows. The
// edited hand is shown in each of those row labels, so the binding is never
// hidden, and MATCH BOTH HANDS is the shortcut for the common case.
const GEAR_ROWS = [
  { type: 'fighter', label: 'PREVIEW FIGHTER' },
  { type: 'hand',     label: 'EDITING HAND' },
  { type: 'gearLeft', label: 'LEFT HAND GEAR' },
  { type: 'gearRight', label: 'RIGHT HAND GEAR' },
  // Labels carry the hand they act on, so they are built per render.
  { type: 'size',  label: () => `${termGearHand.toUpperCase()} SIZE` },
  { type: 'angle', label: () => `${termGearHand.toUpperCase()} ANGLE` },
  { type: 'flip',  label: () => `${termGearHand.toUpperCase()} FLIP` },
  { type: 'match', label: 'MATCH BOTH HANDS' },
  { type: 'reset', label: 'RESET TO DEFAULT' },
];

function moveGearCursor(dir) {
  termGearCursor = (termGearCursor + dir + GEAR_ROWS.length) % GEAR_ROWS.length;
}

// Read-modify-write one hand. `mutate` returns nothing and edits `conf` in
// place; a null mutate means the row only changed which hand is targeted (the
// EDITING HAND row), which must NOT be persisted â€” termGearHand is UI state,
// and writing it out would be meaningless data in the store.
function editGearHand(f, side, mutate) {
  const gear = loadHandGearFor(f.id, f.handGear);
  if (mutate) {
    mutate(gear[side]);
    saveHandGearFor(f.id, side, gear[side]);
  }
  SFX.menuSelect();
  renderTermMenu();
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
  if (row.type === 'gearLeft' || row.type === 'gearRight') {
    const target = row.type === 'gearLeft' ? 'left' : 'right';
    editGearHand(f, target, (conf) => {
      let i = HAND_GEAR.findIndex((g) => g.id === conf.type);
      if (i < 0) i = 0;
      conf.type = HAND_GEAR[(i + dir + HAND_GEAR.length) % HAND_GEAR.length].id;
    });
    return;
  }
  if (row.type === 'size') {
    editGearHand(f, side, (conf) => {
      conf.scale = Math.min(2.0, Math.max(0.4, (conf.scale || 1) + dir * (coarse ? 0.1 : 0.01)));
    });
    return;
  }
  if (row.type === 'angle') {
    editGearHand(f, side, (conf) => {
      conf.angle = ((conf.angle || 0) + dir * (coarse ? 10 : 1) + 180) % 360 - 180;
    });
    return;
  }
  if (row.type === 'flip') {
    editGearHand(f, side, (conf) => { conf.flip = !conf.flip; });
    return;
  }
  if (row.type === 'match') {
    // Copy the edited hand onto the other one. Loaded fresh so the copy
    // includes the SIZE / ANGLE / FLIP tweaks made above, not just the type.
    const gear = loadHandGearFor(f.id, f.handGear);
    saveHandGearSetFor(f.id, { left: { ...gear[side] }, right: { ...gear[side] } });
    SFX.menuSelect();
    renderTermMenu();
    return;
  }
  if (row.type === 'reset') {
    // Back to the character's own default on BOTH hands â€” the boxer comes out
    // gloved again, everyone else comes out bare.
    saveHandGearSetFor(f.id, { left: defaultHandGear(f.handGear), right: defaultHandGear(f.handGear) });
    SFX.menuSelect();
    renderTermMenu();
  }
}

function gearRowLabel(row) {
  return typeof row.label === 'function' ? row.label() : row.label;
}

function gearRowValue(row) {
  const f = ALL_FIGHTERS[previewFighterIdx];
  const gear = loadHandGearFor(f.id, f.handGear);
  switch (row.type) {
    case 'fighter': return f.name;
    case 'hand': return termGearHand === 'left' ? 'LEFT' : 'RIGHT';
    case 'gearLeft': return handGearName(gear.left.type);
    case 'gearRight': return handGearName(gear.right.type);
    case 'size': return gear[termGearHand].scale.toFixed(2);
    case 'angle': return `${gear[termGearHand].angle}Â°`;
    case 'flip': return gear[termGearHand].flip ? 'MIRRORED' : 'NORMAL';
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
  const conf = loadAccessoryFor(f.id);
  const gear = loadHandGearFor(f.id, f.handGear);
  const R = ACCY_PREVIEW_RADIUS;
  const S = ACCY_PREVIEW_ZOOM;

  pctx.save();
  pctx.translate(W / 2, 240);
  pctx.scale(S, S);
  drawAccyMinifig(pctx, 0, 0, R, f, conf, gear);
  pctx.restore();

  // Mark the hand currently being edited so SIZE/ANGLE/FLIP have a visible
  // subject. A ring, not a fill: it must not obscure the gear underneath.
  const neutralPose = (handConfig.actions && handConfig.actions.neutral) || {
    start: { back: { x: 0.7, y: 0.35 }, front: { x: 0.7, y: 0.12 } } };
  const handR = R * 0.35;
  const hx = (termGearHand === 'right' ? 1 : -1) * R * neutralPose.start[termGearHand === 'right' ? 'front' : 'back'].x;
  const hy = R * neutralPose.start[termGearHand === 'right' ? 'front' : 'back'].y;
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

  pctx.textAlign = 'left';
  pctx.font = '11px monospace';
  pctx.fillStyle = '#444';
  pctx.fillText(`EDITING ${termGearHand.toUpperCase()} HAND`, 10, 18);
  pctx.fillText(`L: ${handGearName(gear.left.type)}  Â·  R: ${handGearName(gear.right.type)}`, 10, 34);
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
  header.textContent = 'HAND GEAR  Â·  gloves & hand gear, per hand (auto-saves)';
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
      row.type === 'gearLeft' || row.type === 'gearRight' || row.type === 'flip';

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
    } else if (row.type === 'size' || row.type === 'angle') {
      const f = ALL_FIGHTERS[previewFighterIdx];
      const confKey = row.type === 'size' ? 'scale' : 'angle';
      const bounds = row.type === 'size'
        ? { min: 0.4, max: 2.0, step: 0.01 }
        : { min: -180, max: 180, step: 1 };
      const startVal = loadHandGearFor(f.id, f.handGear)[termGearHand][confKey];
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
      num.value = row.type === 'size' ? startVal.toFixed(2) : startVal;
      // The row is rendered per hand, so it writes the hand that was current
      // when the control was built â€” re-read from the captured `side` rather
      // than termGearHand, which can move while a drag is in flight.
      const side = termGearHand;
      const write = (v) => {
        const gear = loadHandGearFor(f.id, f.handGear);
        gear[side][confKey] = v;
        saveHandGearFor(f.id, side, gear[side]);
        drawGearPreview();
      };
      range.addEventListener('input', () => {
        const v = parseFloat(range.value);
        write(v);
        num.value = row.type === 'size' ? v.toFixed(2) : v;
      });
      num.addEventListener('change', () => {
        const v = Math.min(bounds.max, Math.max(bounds.min, parseFloat(num.value) || 1));
        const clamped = Math.round(v * 100) / 100;
        write(clamped);
        range.value = clamped;
        num.value = row.type === 'size' ? clamped.toFixed(2) : clamped;
      });
      line.appendChild(range);
      line.appendChild(num);
    } else if (row.type === 'match' || row.type === 'reset') {
      const btn = document.createElement('span');
      btn.className = 'btn';
      btn.textContent = row.type === 'match' ? 'MATCH' : 'RESET';
      btn.addEventListener('click', () => { termGearCursor = i; adjustGearRow(row, 1, false); });
      const val = document.createElement('span');
      val.className = 'v';
      val.style.width = 'auto';
      val.textContent = row.type === 'match' ? 'COPY' : 'R';
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
  setSandboxArenaSize(arena.width, arena.height);
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
  setSandboxArenaSize(arena.width, arena.height);
  startSandboxSession(document_, arena.width, arena.height);
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
  stage = createDefaultStage(arena.width, arena.height);
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

  stage = createDefaultStage(arena.width, arena.height);
  setCombatStage(stage);
  const sp1 = stage.spawnPoints[0];
  const sp2 = stage.spawnPoints[1];

  fighter1 = createFighter(1, sp1.x, sp1.y - 30, skin1, {
    id: 'player1',
    color: '#4a9eff',
    radius: f1Def.radius || 26,
    skinScale: skinScaleFor(f1Def),
    accessory: loadAccessoryFor(f1Def.id),
    handGear: loadHandGearFor(f1Def.id, f1Def.handGear),
    runSpeed: f1Def.runSpeed || 91,
    airSpeed: (f1Def.runSpeed || 91) * 0.85,
    jumpForce: f1Def.jumpForce || 680,
    doubleJumpForce: (f1Def.jumpForce || 680) * 1.2,
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
    accessory: loadAccessoryFor(f2Def.id),
    handGear: loadHandGearFor(f2Def.id, f2Def.handGear),
    runSpeed: f2Def.runSpeed || 91,
    airSpeed: (f2Def.runSpeed || 91) * 0.85,
    jumpForce: f2Def.jumpForce || 680,
    doubleJumpForce: (f2Def.jumpForce || 680) * 1.2,
  });
  fighter2._fighterDef = f2Def;
  fighter2._match = null;
  fighter2.stocks = matchSettings.stocks;
  fighter2.eliminated = false;

 attachAnimator(fighter1);
   attachAnimator(fighter2);

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
  try { snapCameraToFit(fightersPair(), arena.width, arena.height, stage); } catch (_) {}
  isPaused = false;
  matchOver = false;
  matchWinner = null;
  matchOverAge = 0;
  matchElapsed = 0; // stopwatch restarts at 00:00 every match
  resetCombat(); // clear any leftover hitboxes from a previous match
  resetTimeDilation(); // and any leftover slow-mo / orange tint
  resetDamageIndicators(); // and any stale floating damage numbers
  resetWorldFx(); // clear any lingering ability particles
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
function onBlastKO(f) {
  if (matchOver || !f || f.eliminated) return;
  f.stocks = Math.max(0, (f.stocks ?? 1) - 1);
  const other = f === fighter1 ? fighter2 : fighter1;
  const otherBlasted = other && !other.eliminated && isInBlastZone(other, stage);
  if (otherBlasted) {
    other.stocks = Math.max(0, (other.stocks ?? 1) - 1);
  }
  const fOut = f.stocks <= 0;
  const otherOut = otherBlasted && other.stocks <= 0;
  if (fOut || otherOut) {
    for (const [who, blasted] of [[f, true], [other, otherBlasted]]) {
      if (!who || !blasted) continue;
      if (who.stocks <= 0) {
        who.eliminated = true;
        who.state = 'dead';
        who.vx = 0; who.vy = 0;
        removeAttackerHitboxes(who);
        clearHitLocks(who);
        who.attack = null;
        who.attackBuffer = null;
        who.hitstun = 0;
        if (who._projectiles) who._projectiles.length = 0;
        who._teleportPending = null;
        who._horse = null;
        clearDeadeye(who);
        clearBoxerState(who);
      } else {
        softResetFighter(who, stage);
      }
    }
    if (fOut && otherOut) {
      matchWinner = 0; // draw
    } else if (fOut) {
      matchWinner = other === fighter1 ? 1 : 2;
    } else {
      matchWinner = f === fighter1 ? 1 : 2;
    }
    matchOver = true;
    matchOverAge = 0;
    resetTimeDilation(); // no lingering slow-mo over the result
    return;
  }
  softResetFighter(f, stage);
  if (otherBlasted) softResetFighter(other, stage);
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
    if (confirm) currentGameState = 'playing';
    return;
  }

  // Playing state
  if (!fighter1 || !fighter2) return;

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

  // Floating damage numbers age with the effective world time.
  updateDamageIndicators(effDt);

  // Ability particle layer (they age with effDt so they hold with the world
  // through a hit-stop freeze and ride the Deadeye slow-mo).
  updateWorldFx(effDt);

  // State resolve + animator mapping (combat/state â†’ animation, sample, blend,
  // mirror) + the landing squish, again from the shared step.
  stepRosterFinish(fightersPair(), effDt, victoryAnimFor);

  updateCameraZoom(effDt);
  updateMatchZoom(effDt, matchOver);
  updateCamera(fightersPair(), arena.width, arena.height, effDt, stage, matchOver);

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
let _matchupSprite = null; // { canvas, baseline }
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
  const c = document.createElement('canvas');
  const m = c.getContext('2d');
  m.font = _MATCHUP_FONT;
  m.textAlign = 'left';
  m.textBaseline = 'alphabetic';
  const mt = m.measureText(text);
  const asc = mt.actualBoundingBoxAscent || 40;
  const desc = mt.actualBoundingBoxDescent || 12;
  c.width = Math.max(1, Math.ceil(mt.width) + _MATCHUP_PAD * 2);
  c.height = Math.max(1, Math.ceil(asc + desc) + _MATCHUP_PAD * 2);

  // Re-apply state: resizing a canvas resets its 2D context.
  m.font = _MATCHUP_FONT;
  m.textAlign = 'left';
  m.textBaseline = 'alphabetic';
  m.lineJoin = 'round';
  m.lineWidth = _MATCHUP_STROKE_W;
  m.strokeStyle = _MATCHUP_STROKE;
  m.strokeText(text, _MATCHUP_PAD, _MATCHUP_PAD + asc);
  m.fillStyle = _MATCHUP_FILL;
  m.fillText(text, _MATCHUP_PAD, _MATCHUP_PAD + asc);

  _matchupSprite = { canvas: c, baseline: _MATCHUP_PAD + asc };
}

function drawMatchupText(ctx) {
  ensureMatchupFont();
  const plat = mainGroundPlatform(stage);
  if (!plat) return;
  const d1 = fighter1 && fighter1._fighterDef;
  const d2 = fighter2 && fighter2._fighterDef;
  // The label is rebuilt only when the matchup itself changes, never per frame.
  const key = `${d1 ? d1.id : '?'}|${d2 ? d2.id : '?'}`;
  if (key !== _matchupKey) {
    _matchupKey = key;
    buildMatchupSprite(`${d1 ? d1.name : 'Player 1'} vs ${d2 ? d2.name : 'Player 2'}`);
  }
  const spr = _matchupSprite;
  if (!spr) return;
  ctx.drawImage(
    spr.canvas,
    plat.x + plat.width / 2 - spr.canvas.width / 2,
    (plat.y - _MATCHUP_LIFT) - spr.baseline
  );
}

export function render(now) {
  if (!canvas || !ctx || !arena) return;
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
  // Blit the pre-rendered background in one call.
  ctx.drawImage(_gridCanvas, 0, 0);

  // Visible world rect for this frame (derived from the composed camera zoom +
  // pan): feeds the view-culling bounds in Effects / worldFx and the stage
  // platform skip. Computed once, reused by every world-space pass.
  updateViewBounds();

  ctx.save();
  applyCameraTransform(ctx, arena.width, arena.height);

  drawStage(ctx, stage, time, mapSettings.platformColor, _viewRect);

  // Matchup banner: background art centred on the main platform. Drawn here so
  // the fighters, their horses, VFX and the HUD all paint over it.
  drawMatchupText(ctx);

  // Fighter layering: after a successful hit the ATTACKER draws in front of
  // the fighter taking damage for the interaction window (set by combat.js on
  // applyHit, decayed in updateAttacks). Hands/weapons ride along with their
  // fighter since they're drawn inside drawFighter. Deterministic: if exactly
  // one fighter owns the window they draw last (on top); if both or neither,
  // the default order (fighter1, then fighter2) is kept.
  if (fighter1 && fighter2) {
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

  ctx.restore();

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
    const scale = 1 / (window.devicePixelRatio || 1);
    const w = canvas.width * scale;
    const h = canvas.height * scale;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = Math.min(0.55, tfx.curTint + tfx.curFlash);
    ctx.fillStyle = '#ff8a00';
    ctx.fillRect(0, 0, w, h);
    ctx.restore();
  }

  // â”€â”€ Round HUD: stocks + round timer (screen space, always visible) â”€â”€
  // â”€â”€ Round HUD: stocks-only pill (top center). Â§42: NO timer here - the
  // old countdown UI and its rendering are fully removed, not hidden. The
  // separate display-only stopwatch lives bottom-left (see below).
  // The pill itself is toggleable in Settings (STOCK COUNTER); hiding it is
  // purely visual and never affects stock tracking or the result.
  if (mapSettings.showStocks !== false) {
    const scale = 1 / (window.devicePixelRatio || 1);
    const w = canvas.width * scale;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const cx = w / 2, y = 10;
    const total = Math.max(fighter1.stocks ?? 0, fighter2.stocks ?? 0, matchSettings.stocks);
    const pipR = 6, gap = 17;
    const half = (total * gap) / 2;
    ctx.font = _fontHudBold;
    // The label never changes: measure once, reuse the cached width.
    if (_hudLabelW < 0) _hudLabelW = ctx.measureText('P1      P2').width;
    const pillW = _hudLabelW + half * 2 + 36, pillH = 26;
    ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
    ctx.fillRect(cx - pillW / 2, y, pillW, pillH);
    // Player tags
    ctx.fillStyle = '#4a9eff';
    ctx.textAlign = 'right';
    ctx.fillText('P1', cx - 14, y + 6);
    ctx.fillStyle = '#ff4a4a';
    ctx.textAlign = 'left';
    ctx.fillText('P2', cx + 14, y + 6);
    // Stock pips: filled = remaining, hollow = lost. Batched by style: all
    // fills first, then all hollow strokes, so fill/stroke state toggles once
    // per group instead of per pip.
    _drawPips(ctx, fighter1.stocks ?? 0, false, '#4a9eff', total, cx, y, pillH, pipR, gap);
    _drawPips(ctx, fighter2.stocks ?? 0, true, '#ff4a4a', total, cx, y, pillH, pipR, gap);
    ctx.restore();
  }

  // â”€â”€ Stopwatch (Â§42: display-only, bottom-left, toggleable in Settings) â”€â”€
  // Counts up from 00:00 every match. Reads matchElapsed only â€” nothing in
  // gameplay reads it back, so it can never end or affect a match.
  if (mapSettings.stopwatch !== false) {
    const scale = 1 / (window.devicePixelRatio || 1);
    const w = canvas.width * scale;
    const h = canvas.height * scale;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
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
    const scale = 1 / (window.devicePixelRatio || 1);
    const w = canvas.width * scale;
    const h = canvas.height * scale;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
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

  drawFps(ctx, arena.width, arena.height, time);

// Time-dilation post-process LAST, so the colour inversion covers the entire
// finished frame â€” world, HUD and all â€” rather than stopping at the point in
// the draw order where it happened to be inserted. A no-op unless the cowboy
// Down Light effect is active.
drawTimeDilationPost(ctx, canvas);
}