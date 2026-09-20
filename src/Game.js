// Game.js — movement arena orchestrator + simplified terminal start menu.
// Two human fighters share the arena, move/jump/dash/dodge freely, and fight
// with the data-driven attack system in combat.js (light=J, heavy=K). Damage
// is a percent meter — no stocks, no stocks, soft blast-zone respawn only.
//
// The terminal overlay in index.html handles selection: pick a fighter, fit the
// skin to the circle (SKIN SIZE), wear accessories, then START FREE PLAY.

import { initInput, flushInput, isJustPressed } from './Input.js';
import {
  createFighter,
  updateFighterState,
  handleFighterInput,
  stepFighterPhysics,
  applySoftPlayerSeparation,
} from './Fighter.js';
import {
  createDefaultStage,
  resolvePlatformCollision,
  drawStage,
  updatePlatforms,
  isInBlastZone,
} from './Stage.js';
import {
  updateCamera,
  applyCameraTransform,
  resetCamera,
  updateCameraZoom,
  updateMatchZoom,
  SFX,
} from './Engine.js';
import {
  combatInput,
  updateAttacks,
  drawCombatDebug,
  resetCombat,
  removeAttackerHitboxes,
  clearHitLocks,
  getHurtbox,
  __debugHitboxes,
  applyAbilityHit,
  startAttackForKey,
} from './combat.js';
import { getSkinImage } from './vfxCore.js';
import { drawFighter, drawAbilityFx } from './Effects.js';
import { drawFighterVfx } from './vfx.js';
import { handConfig, resolveHandColor } from './HandAnim.js';
import {
  ACCESSORIES,
  accessoryName,
  loadAccessoryFor,
  saveAccessoryFor,
  cloneAccessory,
  drawAccessory,
} from './Accessories.js';
import { ALL_FIGHTERS } from './Menu.js';
import {
  openEditor,
  closeEditor,
  updateEditor,
  renderEditor,
  isEditorOpen,
  setEditorCloseHandler,
} from './anim/editor.js';
import {
  openHitboxCustomizer,
  closeHitboxCustomizer,
  updateHitboxCustomizer,
  renderHitboxCustomizer,
  setHitboxCustomizerCloseHandler,
} from './anim/hitboxCustomizer.js';
import { setAnimationLoader, requestAnimation, updateAnimator, attachAnimator, stopAnimation } from './anim/animator.js';
import { getAnimation, setAnimLibChangeListener } from './anim/library.js';

const MONO = 'Consolas, "Courier New", monospace';

// Pre-computed canvas strings — avoids per-frame string allocation.
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
let currentGameState = 'menu'; // 'menu' | 'animator' | 'hitboxes' | 'playing'

// Hitbox debug visualization
let showHitboxes = false;

// Pre-rendered background grid — static, drawn once, blitted every frame.
let _gridCanvas = null;

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

// Reused fighter pair array — avoids allocating a fresh [fighter1, fighter2]
// array several times per frame. Consumers iterate it synchronously.
const _fightersPair = [null, null];
function fightersPair() { _fightersPair[0] = fighter1; _fightersPair[1] = fighter2; return _fightersPair; }

// ── Start menu (terminal) settings ─────────────────────────────────────
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
  p2: Math.min(1, ALL_FIGHTERS.length - 1),
};

const TERM_ROWS = [
  { id: 'player',   label: 'YOUR FIGHTER' },
  { id: 'opponent', label: 'OPPONENT FIGHTER' },
  { id: 'skins',    label: 'SKIN SIZE' },
  { id: 'accys',    label: 'ACCESSORIES' },
  { id: 'anim',     label: 'HAND/WEAPON ANIMATOR' },
  { id: 'hit',      label: 'HITBOX CUSTOMIZER' },
  { id: 'settings', label: 'SETTINGS' },
  { id: 'start',    label: 'START FREE PLAY' },
];

let termMode = 'main';
let termCursor = 0;
let termSkinCursor = 0;
let termAccyCursor = 0;
let previewFighterIdx = 0;
let previewCanvas = null;
let previewCtx = null;
let selectOverlay = null;
let termLinesEl = null;

function resolveSkin(fighterDef) {
  if (!fighterDef || !fighterDef.skin) return null;
  // Store the path; drawFighter looks up live status from getSkinImage.
  return { loaded: false, img: null, name: fighterDef.name, path: fighterDef.skin };
}

function drawHealthBar(ctx, fighter) {
  // Damage percent meter above the fighter.
  // Called inside the camera transform, so fighter.x/y are already world coords.
  const pct = Math.max(0, Math.min(1, fighter.percent / 150));

  ctx.fillStyle = _fillBgDim;
  ctx.fillRect(fighter.x - 40, fighter.y - fighter.radius - 20, 80, 8);

  ctx.fillStyle = fighter.playerNum === 1 ? _fillHealthP1 : _fillHealthP2;
  ctx.fillRect(fighter.x - 40, fighter.y - fighter.radius - 20, 80 * pct, 8);

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
  initInput();

  // Pre-render the background grid into an offscreen canvas so render()
  // draws it with a single drawImage instead of 54 path operations per frame.
  _gridCanvas = document.createElement('canvas');
  _gridCanvas.width = arena.width;
  _gridCanvas.height = arena.height;
  const gctx = _gridCanvas.getContext('2d');
  gctx.fillStyle = '#000';
  gctx.fillRect(0, 0, arena.width, arena.height);
  gctx.strokeStyle = 'rgba(255,255,255,0.05)';
  gctx.lineWidth = 1;
  gctx.beginPath();
  for (let gy = 20; gy < arena.height; gy += 20) {
    gctx.moveTo(0, gy);
    gctx.lineTo(arena.width, gy);
  }
  gctx.stroke();

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

  showSelectOverlay();

  // [PROBE] Opt-in test hook — loaded ONLY when the URL has ?probe. Exposes a
  // state snapshot plus a place() helper so automated browser tests can set up
  // deterministic scenarios (knockback, down-air lock, menu keys).
  if (new URLSearchParams(location.search).has('probe')) {
    window.__ssTest = getProbeApi();
  }
}

// ── Test probe (?probe) ─────────────────────────────────────────────────
// Debug/test API exposed only when the page loads with `?probe`. Provides a
// state snapshot and a place() helper for deterministic runtime tests. None of
// this runs when the URL flag is absent.
function getProbeApi() {
  // Snapshot of the animator's resolved world-space output — the exact data the
  // renderer draws (hand/weapon px/py/rot/scale/…). Carries the animation frame
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
        paused: isPaused,
        overlay: selectOverlay ? selectOverlay.style.display : null,
        fighters: [fighter1, fighter2].map(f => f ? {
          pn: f.playerNum,
          x: f.x, y: f.y, vx: f.vx, vy: f.vy,
          percent: f.percent,
          hitstun: f.hitstun,
          invulnTimer: f.invulnTimer,
          grounded: !!f.grounded,
          facingRight: !!f.facingRight,
          shielding: !!f.shielding,
          locked: !!f._hitLock,
          lockTimer: f._hitLock ? Math.max(0, f._hitLock.timer) : 0,
          attack: f.attack ? (f.attack.def ? f.attack.def.name : '?') : null,
          phase: f.attack ? f.attack.phase : null,
        } : null),
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
      return true;
    },
    hitboxes() {
      return __debugHitboxes();
    },
    attack(pn, key, dir) {
      const f = pn === 1 ? fighter1 : fighter2;
      return f ? startAttackForKey(f, key, dir) : false;
    },
    pose(pn) {
      return poseSnapshot(pn === 1 ? fighter1 : fighter2);
    },
    // Re-resolve the CURRENT animation frame for a given facing without
    // advancing it — the same updateAnimator/sampleInto path the renderer
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
  };
}

// Hitbox overlay toggle: ` (backtick) shows the active hitboxes in the arena.
// M during free play exits back to the terminal menu (no page reload needed).
function onPlayKey(e) {
  if (e.code === 'Backquote') {
    e.preventDefault();
    showHitboxes = !showHitboxes;
  } else if (e.code === 'KeyM' && currentGameState === 'playing') {
    e.preventDefault();
    returnToMenu();
  }
}

// Leave free play and return to the MENU state. Resets combat leftovers
// (damage, hit locks, in-flight projectiles, the camera, the debug hitbox
// overlay) so the next match starts clean — the menu paints an opaque
// background, so nothing from the match carries over visually either.
function returnToMenu() {
  showHitboxes = false;
  for (const f of fightersPair()) {
    if (f) softResetFighter(f);
  }
  resetCombat();
  resetCamera();
  showSelectOverlay();
}

function showSelectOverlay() {
  if (selectOverlay) selectOverlay.style.display = 'flex';
  currentGameState = 'menu';
  isPaused = false;
  renderTermMenu();
}

// ── Terminal start menu ────────────────────────────────────────────────
function termValue(row) {
  switch (row.id) {
    case 'player':   return ALL_FIGHTERS[matchSettings.p1].name;
    case 'opponent': return ALL_FIGHTERS[matchSettings.p2].name;
    case 'skins':    return 'EDIT';
    case 'accys':    return 'EDIT';
    case 'anim':     return 'OPEN';
    case 'hit':      return 'OPEN';
    case 'settings': return ' ';
    case 'start':    return 'ENTER';
    default:         return '';
  }
}

function termCycle(row, dir) {
  if (row.id === 'player') {
    matchSettings.p1 = (matchSettings.p1 + dir + ALL_FIGHTERS.length) % ALL_FIGHTERS.length;
  } else if (row.id === 'opponent') {
    matchSettings.p2 = (matchSettings.p2 + dir + ALL_FIGHTERS.length) % ALL_FIGHTERS.length;
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
    } else if (row.id === 'anim') {
      line.addEventListener('click', openAnimatorEditor);
    } else if (row.id === 'hit') {
      line.addEventListener('click', openHitboxCustomizerEditor);
    } else if (row.id === 'settings') {
      line.addEventListener('click', () => {
        termCursor = i;
        SFX.menuSelect();
        renderTermMenu();
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

  drawMainPreview();
}

function updateTermHints() {
  const h = document.getElementById('term-hints');
  if (!h) return;
  if (termMode === 'skins') {
    h.innerHTML = 'SIZE row: drag the slider, type a number, or use < / > or A/D arrows (Shift = x10). '
      + 'R = reset size, ESC/Backspace = back. Fits the skin to the circle — auto-saves per fighter.';
  } else if (termMode === 'accys') {
    h.innerHTML = 'ACCESSORY: cycle hats with < / > (or A/D). SIZE/ANGLE adjust, X/Y POSITION move it, FLIP mirrors, '
      + 'LAYER toggles behind/front, R = reset. DRAG the hat in the preview to set X/Y, double-click recentres. '
      + 'ESC/Backspace = back. Auto-saves per fighter.';
  } else {
    h.innerHTML = 'UP/DOWN or W/S pick a row. < / > or A/D cycle values, ENTER opens/confirms, ESC = back. '
      + 'START FREE PLAY puts two fighters in the arena — no attacks, no stocks: just movement. '
      + 'P1: WASD move / Shift dodge · P2: Numpad. Bounce off the one floating platform — it drops through with DOWN. '
      + 'HAND/WEAPON ANIMATOR opens the visual editor for hands + weapons (timespace, anchors, library). '
      + 'HITBOX CUSTOMIZER lives per fighter / move — tune every attack box right where it lands in play.';
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
  drawAccyMinifig(pctx, 0, 0, R, f, conf);
  pctx.restore();

  pctx.textAlign = 'center';
  pctx.font = 'bold 16px monospace';
  pctx.fillStyle = '#111';
  pctx.fillText(f.name, W / 2, 404);
  pctx.font = '11px monospace';
  pctx.fillStyle = '#555';
  pctx.fillText('movement sandbox · no attacks, no stocks', W / 2, 422);
  pctx.fillText('P1: WASD + Shift dodge   ·   P2: Numpad', W / 2, 440);
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
  if ((termMode === 'skins' || termMode === 'accys') && nativeFocused) {
    if (k === 'Escape' || (k === 'Backspace' && focusedEl.type !== 'text')) {
      e.preventDefault();
      if (termMode === 'skins') exitSkinEditor();
      else if (termMode === 'accys') exitAccyEditor();
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
    if (TERM_ROWS[termCursor] && TERM_ROWS[termCursor].id === 'anim') {
      openAnimatorEditor();
      return;
    }
    if (TERM_ROWS[termCursor] && TERM_ROWS[termCursor].id === 'hit') {
      openHitboxCustomizerEditor();
      return;
    }
    if (TERM_ROWS[termCursor] && TERM_ROWS[termCursor].id === 'settings') {
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

// ── SKIN SIZE customiser ────────────────────────────────────────────────
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

  // The full (unclipped) skin image box — shows how much the circle crops.
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
  pctx.fillText(`${f.name} — movement sandbox`, cx, cy + r + 48);
  pctx.fillText('grow/shrink the skin until it fits the circle', cx, cy + r + 64);
}

function renderSkinEditor() {
  const header = document.createElement('div');
  header.className = 'term-row head';
  header.textContent = 'SKIN SIZE  ·  fit the fighter to its circle';
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

// ── ACCESSORIES editor ─────────────────────────────────────────────────
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

function drawAccyMinifig(ctx, x, y, R, f, conf) {
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
  const handState = (hx, hy) => {
    ctx.beginPath();
    ctx.arc(x + hx, y + hy, handR, 0, Math.PI * 2);
    ctx.fillStyle = handFill;
    ctx.fill();
    ctx.strokeStyle = '#222222';
    ctx.lineWidth = 2.5 / ACCY_PREVIEW_ZOOM;
    ctx.stroke();
  };

  // Back hand (behind the body)
  handState(-dirHand * R * neutralPose.start.back.x, R * neutralPose.start.back.y);

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
  handState(dirHand * R * neutralPose.start.front.x, R * neutralPose.start.front.y);

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
  drawAccyMinifig(pctx, 0, 0, R, f, conf);
  pctx.restore();

  pctx.textAlign = 'left';
  pctx.font = '11px monospace';
  pctx.fillStyle = '#444';
  pctx.fillText(`X ${conf.shiftX.toFixed(2)}  ·  Y ${conf.shiftY.toFixed(2)}`, 10, 18);
  pctx.fillText(`SIZE ${conf.scale.toFixed(2)}  ·  ANGLE ${conf.angle}°`, 10, 34);
  pctx.textAlign = 'center';
  pctx.font = 'bold 16px monospace';
  pctx.fillStyle = '#111';
  pctx.fillText(`${accessoryName(conf.type)}`, W / 2, 404);
  pctx.font = '11px monospace';
  pctx.fillText('drag the hat to position it · auto-saves', W / 2, 422);
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
    case 'angle': return `${conf.angle}°`;
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
  header.textContent = 'ACCESSORIES  ·  wear hats & gear (auto-saves)';
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

// ── Match (free play) ──────────────────────────────────────────────────
function startFromTerm() {
  SFX.menuConfirm();
  if (selectOverlay) selectOverlay.style.display = 'none';
  startNewMatch();
}

// ── Hand/Weapon Animator editor ────────────────────────────────────────
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

// ── Hitbox Customizer ───────────────────────────────────────────────────
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

function startNewMatch() {
  const f1Def = ALL_FIGHTERS[matchSettings.p1];
  const f2Def = ALL_FIGHTERS[matchSettings.p2];
  const skin1 = resolveSkin(f1Def);
  const skin2 = resolveSkin(f2Def);

  stage = createDefaultStage(arena.width, arena.height);
  const sp1 = stage.spawnPoints[0];
  const sp2 = stage.spawnPoints[1];

  fighter1 = createFighter(1, sp1.x, sp1.y - 30, skin1, {
    id: 'player1',
    color: '#4a9eff',
    radius: f1Def.radius || 26,
    skinScale: skinScaleFor(f1Def),
    accessory: loadAccessoryFor(f1Def.id),
    runSpeed: f1Def.runSpeed || 220,
    airSpeed: (f1Def.runSpeed || 220) * 0.85,
    jumpForce: f1Def.jumpForce || 680,
    doubleJumpForce: (f1Def.jumpForce || 680) * 1.2,
  });
  fighter1._fighterDef = f1Def;
  fighter1._match = null;

  fighter2 = createFighter(2, sp2.x, sp2.y - 30, skin2, {
    id: 'player2',
    color: '#ff4a4a',
    radius: f2Def.radius || 26,
    skinScale: skinScaleFor(f2Def),
    accessory: loadAccessoryFor(f2Def.id),
    runSpeed: f2Def.runSpeed || 220,
    airSpeed: (f2Def.runSpeed || 220) * 0.85,
    jumpForce: f2Def.jumpForce || 680,
    doubleJumpForce: (f2Def.jumpForce || 680) * 1.2,
  });
  fighter2._fighterDef = f2Def;
  fighter2._match = null;

  attachAnimator(fighter1);
  attachAnimator(fighter2);

  resetCamera();
  isPaused = false;
  resetCombat(); // clear any leftover hitboxes from a previous match
  currentGameState = 'playing';
}

// Soft blast-zone fall: no stocks, no KO — the fighter simply reappears at
// their spawn point with a brief invulnerability blink.
function softResetFighter(f) {
  const spawn = (f.playerNum === 1 ? stage.spawnPoints[0] : stage.spawnPoints[1]) || stage.respawnPoint;
  f.x = spawn.x;
  f.y = spawn.y - 30;
  f.vx = 0;
  f.vy = 0;
  f.grounded = false;
  f.groundPlatform = null;
  f.dodging = false;
  f.dodgeTimer = 0;
  f.wavedashing = false;
  f.canDoubleJump = true;
  f.jumpsUsed = 0;
  f.fastFalling = false;
  f.freeFall = false;
  f.coyoteTimer = 0;
  f.jumpBufferTimer = 0;
  f.wasGrounded = false;
  f.invulnTimer = 1.2;
  // Combat state: cancel any in-progress attack, remove its hitboxes, clear
  // hitstun, empty the input buffer, and zero the damage meter back to 0%.
  removeAttackerHitboxes(f);
  clearHitLocks(f);
  f.attack = null;
  f.attackBuffer = null;
  f.hitstun = 0;
  f.shielding = false;
  f.percent = 0;
  f._hitFlash = 0;
  f._hitRenderTimer = 0;
  // Ability state: drop any live projectiles and break locks on respawn.
  if (f._projectiles) f._projectiles.length = 0;
  f._lockedTarget = null;
  f._lockTimer = 0;
}

// ── Animator sync ──────────────────────────────────────────────────────
// The animator is requested ONLY for the library's seven-base-animation
// combat actions (attacks + shield). Walking left/right, running, jumping,
// falling, dodging and hitstun are NOT animator-driven: those keep the
// original movement pose system (Effects/HandAnim) and default-pose hands,
// exactly as before the animator existed.
function combatAnim(f) {
  if (f.shielding) return 'shield';
  if (f.attack) {
    // The attack animation plays while the hitbox can still hit (startup +
    // active). The instant recovery starts the hitbox is gone — return null so
    // the animator releases the hands back to the default pose instead of
    // finishing the swing on top of a no-longer-damaging attack.
    return f.attack.phase === 'recovery' ? null : (f.attack.def.anim || null);
  }
  return null;
}

function syncFighterAnim(f, dt) {
  if (!f.anim) return;
  const name = combatAnim(f);
  if (name) {
    // Only start/replace the animation when the name actually changed.
    // During a single attack, updateAnimator runs every frame but the
    // animation is started only once.
    if (f.anim.animId !== name) requestAnimation(f, name);
    updateAnimator(f, dt);
  } else if (f.anim.blendFrom && f.anim.blendProgress < 1) {
    // Mid-crossfade back to the default pose — keep driving the blend so it
    // finishes and hands control back to the legacy movement pose system.
    updateAnimator(f, dt);
  } else if (f.anim.animId || f.anim.playing) {
    // Combat action finished (or its active window ended) — blend the hands
    // smoothly back to the default pose instead of snapping via resetAnimator.
    stopAnimation(f);
  }
}

// ── Update ─────────────────────────────────────────────────────────────
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

  // Playing state
  if (!fighter1 || !fighter2) return;

  // Pause toggle (I / V)
  if (isJustPressed(1, 'grab') || isJustPressed(2, 'grab')) {
    isPaused = !isPaused;
    flushInput();
    return;
  }
  if (isPaused) return;

  // Animate floating platforms
  updatePlatforms(stage, now);

  // Fighter input (both human — no AI in the sandbox)
  handleFighterInput(fighter1, stage, dt);
  handleFighterInput(fighter2, stage, dt);

  // Reset grounded flags
  fighter1.grounded = false;
  fighter1.groundPlatform = null;
  fighter2.grounded = false;
  fighter2.groundPlatform = null;

  // Physics
  stepFighterPhysics(fighter1, dt);
  stepFighterPhysics(fighter2, dt);

  // Soft player separation: gentle push apart when too close horizontally.
  applySoftPlayerSeparation(fighter1, fighter2, dt);

  // Platform pass (main floor + one-way upper platform)
  for (const plat of stage.platforms) {
    resolvePlatformCollision(fighter1, plat);
    resolvePlatformCollision(fighter2, plat);
  }

  // Soft blast-zone reset (no KO — straight back to spawn)
  if (isInBlastZone(fighter1, stage)) softResetFighter(fighter1);
  if (isInBlastZone(fighter2, stage)) softResetFighter(fighter2);

  // Combat input: starts attacks from fresh presses (or the small input buffer).
  // Runs NOW — after physics and platform pass resolved grounded this frame — so
  // "attack right as you land" correctly reads as a grounded attack, and a press
  // the frame a dodge/attack ends is seen immediately. This is the ONLY place
  // that starts attacks.
  combatInput(fightersPair());

  // Combat resolution: advance attack frames, spawn/move/destroy hitboxes,
  // resolve collisions → percent / knockback / hitstun.
  updateAttacks(fightersPair(), dt);

  // Ability projectiles: move, expire and resolve collisions the same way an
  // active hitbox would (same damage/knockback rules).
  updateProjectiles(fightersPair(), dt);

  updateFighterState(fighter1);
  updateFighterState(fighter2);

  // Animator: map combat/state → animation names, sample + blend, mirror.
  syncFighterAnim(fighter1, dt);
  syncFighterAnim(fighter2, dt);

  // Landing squish
  for (const f of fightersPair()) {
    if (f._justLanded) {
      f._justLanded = false;
      f.squishX = 1.25;
      f.squishY = 0.78;
      f.squishTimer = 0.15;
    }
  }

  updateCameraZoom(dt);
  updateMatchZoom(dt, false);
  updateCamera(fightersPair(), arena.width, arena.height, dt);

  flushInput();
}

// ── Ability projectiles ─────────────────────────────────────────────────
// Pure-motion projectiles owned by a fighter (spawned by abilities.js). They
// die on expiry, leaving the stage, or making contact with a hitbox/hurtbox
// (a non-owner that isn't invulnerable).
function updateProjectiles(fighters, dt) {
  for (const f of fighters) {
    const list = f._projectiles;
    if (!list || !list.length) continue;
    const dead = [];
    for (const p of list) {
      p.life -= dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      if (p.life <= 0 || p.dead || p.y > arena.height + 200) { dead.push(p); continue; }
      for (const t of fighters) {
        if (!t || t === p.owner || t.state === 'dead' || t.invulnTimer > 0) continue;
        const hb = getHurtbox(t);
        if (p.x + p.r < hb.x || p.x - p.r > hb.x + hb.w ||
            p.y + p.r < hb.y || p.y - p.r > hb.y + hb.h) continue;
        // Projectiles carry their own full damage/knockback def (set at spawn).
        applyAbilityHit(p.owner, t, p.def, p.facing);
        p.dead = true;
        dead.push(p);
        break;
      }
    }
    for (const p of dead) {
      const i = list.indexOf(p);
      if (i !== -1) list.splice(i, 1);
    }
  }
  // Lock-on is a timed buff: release both the reticle and the target here.
  for (const f of fighters) {
    if (f._lockTimer > 0) {
      f._lockTimer = Math.max(0, f._lockTimer - dt);
      if (f._lockTimer === 0) f._lockedTarget = null;
    }
  }
}

// ── Render ─────────────────────────────────────────────────────────────
const _fontMenuTitle = `20px ${MONO}`;
const _fontMenuSub = `13px ${MONO}`;
const _menuLines = [
  'light attacks = J/Z (P1) · heavy attacks = K/X (P1)',
  'shield = L/C · dodge = Shift · ` shows hitboxes',
  'hold DOWN on a floating platform to drop through it',
  'fall past the edges and you softly respawn at your start spot',
];
export function render(now) {
  if (!canvas || !ctx || !arena) return;
  const time = now || performance.now();

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
    ctx.fillText('> ball platform fighter — movement sandbox', arena.width / 2, arena.height * 0.26);
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

  // ── Playing state render ──
  // Blit the pre-rendered background (black fill + grid lines) in one call.
  ctx.drawImage(_gridCanvas, 0, 0);

  ctx.save();
  applyCameraTransform(ctx, arena.width, arena.height);

  drawStage(ctx, stage, time);

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
      drawFighter(ctx, fighter2, time);
      drawFighterVfx(ctx, fighter2);
      drawFighter(ctx, fighter1, time);
      drawFighterVfx(ctx, fighter1);
    } else {
      drawFighter(ctx, fighter1, time);
      drawFighterVfx(ctx, fighter1);
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

  // Draw damage percent meters
  drawHealthBar(ctx, fighter1, time);
  drawHealthBar(ctx, fighter2, time);

  ctx.restore();

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
}