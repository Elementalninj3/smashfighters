import { SFX } from './assets.js';
import { emitDustPuff, emitImpactRing, emitGhost, fxStyleFor } from './fx.js';

// Default (non-injected) input queries. Fighter.js used these through an
// aliased import (`isHeld as __isHeld`, …); the alias lives here now that
// input state and fighter logic share this module. handleFighterInput still
// prefers an injected triple when the caller provides one.
const __isHeld = isHeld;
const __isJustPressed = isJustPressed;
const __isJustReleased = isJustReleased;


// ── merged from core/loop.js ──
// physics.js — the frame loop and the hit-stop clock that rides on it.
// Two independent pieces of timing, kept together because they are the only
// code that decides WHEN a frame happens:
//   - startGameLoop() owns requestAnimationFrame and never dies.
//   - freezeGame()/stepFreeze() own the brief pause that makes heavy ability
//     detonations land.
//
// PERFORMANCE: Added frame budget tracking, adaptive quality scaling,
// and idle detection to prevent unnecessary work.

// ── Game loop ────────────────────────────────────────────────────────────
// Fixed-timestep accumulator over a variable rAF cadence: simulation always
// advances in 1/60s steps so attacks (frame-counted), physics and AI behave
// identically on 60Hz/120Hz/144Hz displays, while rendering still runs every
// rAF. At most MAX_STEPS steps run per frame so a hitch can never spiral into
// catch-up; leftover time is dropped (slow-mo under extreme hitch, never a
// spike). Single rAF chain, never dies on exception.
const FIXED_DT = 1 / 60;
const MAX_STEPS = 3;

// Frame budget: target 16.67ms (60fps).
//
// SENSOR CHOICE (the important part). The old controller averaged the JS cost of
// update()+render() (performance.now() around the frame body). That number
// ignores everything the main thread does NOT do: GPU rasterization, canvas
// compositing, and the browser's own vsync wait. On a GPU-bound frame JS can be
// 4ms while the real frame lands 33ms later, so the sensor reported a healthy
// game forever and adaptive quality never stepped down — while the player saw
// 30fps. That mismatch is exactly the "inconsistent fps" symptom: a game that
// looks fine in the counter yet visibly stutters.
//
// The sensor must measure the REAL cadence — the rAF-to-rAF delta, which is
// the only value that actually reflects what the player experiences. The JS
// cost is still measured and reported, but only as a diagnostic.
const FRAME_BUDGET_MS = 16.67;
// Step DOWN above ~19.5ms (sustained sub-52fps), step UP below ~14.5ms
// (sustained ~69fps). The wide gap between the two is deliberate hysteresis:
// 60Hz vsync sits at 16.67ms, so a narrow gap makes the tier flap every frame
// near the threshold, which reads as its own stutter.
const FRAME_DOWN_MS = 19.5;
const FRAME_UP_MS = 14.5;
const QUALITY_WINDOW_MS = 1200;
const QUALITY_COOLDOWN_MS = 2500;
// A single catastrophic frame (tab restore, GC pause, a big ability detonation)
// must never drop the tier. A minimum sample count plus an outlier clamp keeps
// the controller honest: quality reacts to sustained load, never to one spike.
const QUALITY_MIN_SAMPLES = 30;
const OUTLIER_CLAMP_MS = 60;

let _cadAccum = 0;      // sum of clamped rAF deltas in the current window
let _cadCount = 0;     // frames sampled in the current window
let _jsAccum = 0;      // JS-only cost, diagnostics
let _frameCount = 0;
let _avgFrameTime = 16.67;
let _avgJsTime = 0;
let _qualityLevel = 2; // 0=low, 1=medium, 2=high
let _lastQualityCheck = 0;
let _lastTierChangeAt = 0;
const _qualityListeners = [];

export function getQualityLevel() { return _qualityLevel; }
export function setQualityLevel(q) { _qualityLevel = Math.max(0, Math.min(2, q | 0)); }
export function getAvgFrameTime() { return _avgFrameTime; }
// Real cadence, smoothed. This is what the player sees; unlike the old
// JS-only figure it includes GPU + compositing + vsync wait.
export function getAvgFrameCadence() { return _cadCount ? _cadAccum / _cadCount : _avgFrameTime; }
// Diagnostics only: the JS cost of update()+render() per frame.
export function getAvgJsTime() { return _avgJsTime; }
// Consumer bridge (Game.js subscribes): notified only on actual tier changes,
// never per frame. Lets the dead tracker above drive real renderers.
export function onLoopQualityChange(cb) {
  if (typeof cb === 'function') _qualityListeners.push(cb);
  return () => {
    const i = _qualityListeners.indexOf(cb);
    if (i >= 0) _qualityListeners.splice(i, 1);
  };
}
function _notifyQuality(level) {
  for (const cb of _qualityListeners) {
    try { cb(level); } catch (_) {}
  }
}

export function startGameLoop(update, render) {
  let last = performance.now();
  let acc = 0;
  let rafId = null;
  
  // Reusable frame timing object to avoid allocation
  const frameTiming = { dt: FIXED_DT, now: 0, frameBudget: FRAME_BUDGET_MS };
  
  function frame(now) {
    const frameStart = performance.now();
    // Real cadence: rAF timestamp minus the previous rAF timestamp. This is the
    // value the adaptive controller must judge, because it is the only one that
    // reflects what the player actually experiences.
    const cadence = now - last;
    let elapsed = cadence / 1000;
    last = now;
    // Clamp tab-switch/hitch input, then accumulate fixed steps.
    if (elapsed > 0.25) elapsed = 0.25;
    if (elapsed < 0) elapsed = 0;
    acc += elapsed;
    if (acc > FIXED_DT * MAX_STEPS) acc = FIXED_DT * MAX_STEPS;
    let steps = 0;
    try {
      while (acc >= FIXED_DT && steps < MAX_STEPS) {
        frameTiming.dt = FIXED_DT;
        frameTiming.now = now;
        update(FIXED_DT, now);
        acc -= FIXED_DT;
        steps++;
      }
    } catch (e) {
      console.error('[game-loop] update failed:', e);
      acc = 0;
    }
    try {
      frameTiming.now = now;
      render(now);
    } catch (e) {
      console.error('[game-loop] render failed:', e);
    }
    
    // Frame budget tracking. JS cost is recorded as a diagnostic only; the
    // adaptive decision below runs off the real rAF cadence.
    const jsTime = performance.now() - frameStart;
    _jsAccum += jsTime;
    _frameCount++;
    _avgJsTime = _jsAccum / _frameCount;

    // Clamp the cadence sample so one catastrophic frame (tab restore, GC
    // pause, ability detonation) cannot poison a whole window. A frame longer
    // than OUTLIER_CLAMP_MS is recorded as exactly the clamp, which still reads
    // as "over budget" without being able to fake sustained overload.
    const sample = (cadence >= 0 && cadence < 1000) ? Math.min(cadence, OUTLIER_CLAMP_MS) : FRAME_BUDGET_MS;
    _cadAccum += sample;
    _cadCount++;

    // Adaptive quality: judged on a time window (not a frame count, which
    // changes meaning with refresh rate), gated on a minimum sample count,
    // with wide hysteresis and a cooldown so it cannot flap.
    const checkNow = performance.now();
    if (checkNow - _lastQualityCheck >= QUALITY_WINDOW_MS && _cadCount >= QUALITY_MIN_SAMPLES) {
      _lastQualityCheck = checkNow;
      _avgFrameTime = _cadAccum / _cadCount;
      if (checkNow - _lastTierChangeAt >= QUALITY_COOLDOWN_MS) {
        if (_avgFrameTime > FRAME_DOWN_MS && _qualityLevel > 0) {
          _qualityLevel--;
          _lastTierChangeAt = checkNow;
          _notifyQuality(_qualityLevel);
        } else if (_avgFrameTime < FRAME_UP_MS && _qualityLevel < 2) {
          _qualityLevel++;
          _lastTierChangeAt = checkNow;
          _notifyQuality(_qualityLevel);
        }
      }
      _cadAccum = 0;
      _cadCount = 0;
      _jsAccum = 0;
      _frameCount = 0;
    }

    rafId = requestAnimationFrame(frame);
  }
  rafId = requestAnimationFrame(frame);
  return () => cancelAnimationFrame(rafId); // returns a stop function
}

// ── Freeze frames (hitstop) ──────────────────────────────────────────────
// Briefly pauses gameplay. Used for dramatic impact frames on big ability
// detonations. Calling freezeGame() while already frozen extends the freeze.
let freezeRemaining = 0;

export function freezeGame(duration = 0.08) {
  freezeRemaining = Math.max(freezeRemaining, duration);
}

// Returns true while the game is frozen. Call once per frame from update().
export function stepFreeze(dt) {
  if (freezeRemaining > 0) {
    freezeRemaining = Math.max(0, freezeRemaining - dt);
    return true;
  }
  return false;
}


// ── merged from core/spatialGrid.js ──
// physics.js — uniform grid spatial partitioning for broad-phase collision detection.
// Reduces O(n²) collision checks to O(n) by only testing nearby objects.
// Cell size tuned for typical fighter/projectile interaction ranges (~200px).

export const CELL_SIZE = 200;
const INV_CELL_SIZE = 1 / CELL_SIZE;

// Pre-allocated arrays to avoid per-frame allocation
const _cellKeys = [];
const _cellEntries = new Map();

// Scratch objects for coordinate conversion. min/max use SEPARATE records:
// worldToCell reuses one shared object, so holding its result across a second
// call aliases (both names would point at the max corner and only one cell
// would ever be indexed - projectiles passing straight through fighters).
const _scratch = { x: 0, y: 0 };
const _minCell = { x: 0, y: 0 };
const _maxCell = { x: 0, y: 0 };

export function clearGrid() {
  _cellKeys.length = 0;
  _cellEntries.clear();
}

function cellKey(cx, cy) {
  return (cx << 16) ^ (cy & 0xFFFF); // Fast integer key combining
}

function worldToCell(x, y) {
  _scratch.x = Math.floor(x * INV_CELL_SIZE);
  _scratch.y = Math.floor(y * INV_CELL_SIZE);
  return _scratch;
}

function cellRange(x, y, radius, outMin, outMax) {
  outMin.x = Math.floor((x - radius) * INV_CELL_SIZE);
  outMin.y = Math.floor((y - radius) * INV_CELL_SIZE);
  outMax.x = Math.floor((x + radius) * INV_CELL_SIZE);
  outMax.y = Math.floor((y + radius) * INV_CELL_SIZE);
}

export function insertObject(obj, x, y, radius) {
  cellRange(x, y, radius, _minCell, _maxCell);
  const min = _minCell, max = _maxCell;

  for (let cx = min.x; cx <= max.x; cx++) {
    for (let cy = min.y; cy <= max.y; cy++) {
      const key = cellKey(cx, cy);
      let arr = _cellEntries.get(key);
      if (!arr) {
        arr = [];
        _cellEntries.set(key, arr);
        _cellKeys.push(key);
      }
      arr.push(obj);
    }
  }
}

export function queryNearby(x, y, radius, outArray) {
  cellRange(x, y, radius, _minCell, _maxCell);
  const min = _minCell, max = _maxCell;
  outArray.length = 0;
  
  for (let cx = min.x; cx <= max.x; cx++) {
    for (let cy = min.y; cy <= max.y; cy++) {
      const key = cellKey(cx, cy);
      const arr = _cellEntries.get(key);
      if (arr) {
        for (let i = 0; i < arr.length; i++) {
          outArray.push(arr[i]);
        }
      }
    }
  }
  return outArray;
}

export function queryCell(cx, cy, outArray) {
  const key = cellKey(cx, cy);
  const arr = _cellEntries.get(key);
  outArray.length = 0;
  if (arr) {
    for (let i = 0; i < arr.length; i++) outArray.push(arr[i]);
  }
  return outArray;
}

// For debugging: get cell stats
export function getGridStats() {
  let total = 0, maxCell = 0;
  for (const key of _cellKeys) {
    const arr = _cellEntries.get(key);
    if (arr) {
      total += arr.length;
      if (arr.length > maxCell) maxCell = arr.length;
    }
  }
  return { cells: _cellKeys.length, totalEntries: total, maxCellSize: maxCell };
}


// ── merged from core/objectPool.js ──
// physics.js — high-performance object pooling to eliminate GC pressure.
// All pools are pre-allocated, reusable, and have hard caps to bound memory.

// Generic pool factory
export function createPool(createFn, resetFn, initialSize = 64, maxSize = 512) {
  const pool = [];
  const active = [];
  
  // Pre-allocate
  for (let i = 0; i < initialSize; i++) {
    pool.push(createFn());
  }
  
  return {
    acquire(...args) {
      let obj = pool.pop();
      if (!obj) {
        if (active.length >= maxSize) {
          // Pool exhausted - recycle oldest active (should rarely happen)
          obj = active.shift();
          if (resetFn) resetFn(obj);
        } else {
          obj = createFn();
        }
      }
      if (resetFn) resetFn(obj, ...args);
      active.push(obj);
      return obj;
    },
    
    release(obj) {
      const idx = active.indexOf(obj);
      if (idx >= 0) {
        active.splice(idx, 1);
        if (resetFn) resetFn(obj);
        if (pool.length < maxSize) {
          pool.push(obj);
        }
      }
    },
    
    releaseAll() {
      for (const obj of active) {
        if (resetFn) resetFn(obj);
        if (pool.length < maxSize) pool.push(obj);
      }
      active.length = 0;
    },
    
    getActive() { return active; },
    getActiveCount() { return active.length; },
    getPoolCount() { return pool.length; },
    clear() {
      active.length = 0;
      pool.length = 0;
    }
  };
}

// ── Projectile Pool ──────────────────────────────────────────────────────
const _projCreate = () => ({
  x: 0, y: 0, vx: 0, vy: 0, r: 8,
  life: 1, maxLife: 1, dead: false, stuck: false,
  weaponId: null, drawSize: null, facing: 1,
  spin: 0, trail: null, def: null, owner: null
});

const _projReset = (p, x, y, vx, vy, r, life, def, owner, facing, weaponId, drawSize, trail) => {
  p.x = x; p.y = y; p.vx = vx; p.vy = vy; p.r = r;
  p.life = life; p.maxLife = life; p.dead = false; p.stuck = false;
  p.weaponId = weaponId || null; p.drawSize = drawSize || null; p.facing = facing;
  p.spin = 0; p.trail = trail || null; p.def = def; p.owner = owner;
};

export const projectilePool = createPool(_projCreate, _projReset, 128, 1024);

// ── VFX Instance Pool ────────────────────────────────────────────────────
const _vfxCreate = () => ({
  effect: 'bullet', color: null, anchor: 'weapon',
  startFrame: 0, duration: 10, scale: 1, rotation: 0,
  offsetX: 0, offsetY: 0, loop: false, mirrorX: 1,
  progress: 0, pinnedX: null, pinnedY: null, params: null
});

const _vfxReset = (v) => {
  v.effect = 'bullet'; v.color = null; v.anchor = 'weapon';
  v.startFrame = 0; v.duration = 10; v.scale = 1; v.rotation = 0;
  v.offsetX = 0; v.offsetY = 0; v.loop = false; v.mirrorX = 1;
  v.progress = 0; v.pinnedX = null; v.pinnedY = null; v.params = null;
};

export const vfxPool = createPool(_vfxCreate, _vfxReset, 256, 2048);

// ── Particle Pool (for worldFx) ──────────────────────────────────────────
const _particleCreate = () => ({
  type: 0, x: 0, y: 0, vx: 0, vy: 0,
  life: 0, maxLife: 1, size: 4, color: '#ffffff',
  alpha: 1, gravity: 0, drag: 1, spin: 0, spinSpeed: 0
});

const _particleReset = (p) => {
  p.type = 0; p.x = 0; p.y = 0; p.vx = 0; p.vy = 0;
  p.life = 0; p.maxLife = 1; p.size = 4; p.color = '#ffffff';
  p.alpha = 1; p.gravity = 0; p.drag = 1; p.spin = 0; p.spinSpeed = 0;
};

export const particlePool = createPool(_particleCreate, _particleReset, 512, 4096);

// ── Hitbox Pool ──────────────────────────────────────────────────────────
const _hitboxCreate = () => ({
  id: 0, owner: null, x: 0, y: 0, w: 0, h: 0,
  dmg: 0, kbBase: 0, kbGrowth: 0, angle: 0,
  launchAngle: 0, horizontalKnockback: 0, verticalKnockback: 0,
  hitIds: null, active: true, frame: 0
});

const _hitboxReset = (h) => {
  h.id = 0; h.owner = null; h.x = 0; h.y = 0; h.w = 0; h.h = 0;
  h.dmg = 0; h.kbBase = 0; h.kbGrowth = 0; h.angle = 0;
  h.launchAngle = 0; h.horizontalKnockback = 0; h.verticalKnockback = 0;
  h.hitIds = null; h.active = true; h.frame = 0;
};

export const hitboxPool = createPool(_hitboxCreate, _hitboxReset, 64, 512);

// ── Damage Number Pool ───────────────────────────────────────────────────
const _dmgNumCreate = () => ({
  x: 0, y: 0, value: 0, life: 0, maxLife: 1,
  color: '#ffffff', scale: 1, vy: -30
});

const _dmgNumReset = (d) => {
  d.x = 0; d.y = 0; d.value = 0; d.life = 0; d.maxLife = 1;
  d.color = '#ffffff'; d.scale = 1; d.vy = -30;
};

export const damageNumberPool = createPool(_dmgNumCreate, _dmgNumReset, 64, 256);

// ── Break Effect Pool ────────────────────────────────────────────────────
const _breakFxCreate = () => ({
  x: 0, y: 0, vx: 0, vy: 0, size: 4,
  life: 0, maxLife: 1, color: '#8a6a3f', gravity: 800
});

const _breakFxReset = (b) => {
  b.x = 0; b.y = 0; b.vx = 0; b.vy = 0; b.size = 4;
  b.life = 0; b.maxLife = 1; b.color = '#8a6a3f'; b.gravity = 800;
};

export const breakFxPool = createPool(_breakFxCreate, _breakFxReset, 128, 1024);

// ── Scratch Objects (reusable temporaries) ───────────────────────────────
export const scratchVec2 = { x: 0, y: 0 };
export const scratchRect = { x: 0, y: 0, w: 0, h: 0 };

// Pre-allocated arrays to avoid allocation in hot paths
export const tempArray8 = new Array(8);
export const tempArray16 = new Array(16);
export const tempArray32 = new Array(32);
export const tempArray64 = new Array(64);

export function clearTempArray(arr) { arr.length = 0; }


// ── merged from input/Input.js ──
// Input.js — centralized input manager for keyboard (and future gamepad).
// Never reads game state — only tracks what keys are currently pressed
// and provides query helpers for the Fighter state machine.

// ── Configurable input timing ───────────────────────────────────────────────
// These control how forgiving directional+attack recognition is.
// Tunable without touching combat logic.
export const INPUT_CONFIG = {
  // How long a direction remains "recently active" for combo recognition.
  // This is the main window for DOWN→LIGHT / LIGHT→DOWN recognition.
  directionBufferMs: 200,

  // How long an attack press is remembered for combo/early-press buffering.
  attackBufferMs: 150,

  // Combo string input buffer (how early the next attack can be queued).
  comboWindowMs: 200,

  // Grace window for "held direction counts as directional intent".
  // After this long of continuously holding a direction without pressing attack,
  // we still allow it to modify an attack, but we keep it bounded so the system
  // does not accidentally turn every attack into a directional attack forever.
  heldDirectionGraceMs: 250,
};

const DIRECTION_BUFFER = INPUT_CONFIG.directionBufferMs / 1000;
const ATTACK_BUFFER = INPUT_CONFIG.attackBufferMs / 1000;
const COMBO_WINDOW = INPUT_CONFIG.comboWindowMs / 1000;
const HELD_DIRECTION_GRACE = INPUT_CONFIG.heldDirectionGraceMs / 1000;

const keys = {};
const justPressed = {};
const justReleased = {};
// Per-frame edge flags are cleared in flushInput(). Tracking which codes were
// actually stamped lets the clear be an O(set) walk of a plain array instead of
// a `for...in` + `delete` sweep — the delete permanently pushed these objects
// into V8 dictionary mode and re-scanned every key every frame.
const justPressedCodes = [];
const justReleasedCodes = [];
const virtualKeys = {}; // AI overrides: { playerNum: { action: true/false } }

// Event history for reliable combination recognition.
// We keep the most recent event per action per player, plus a small ordered
// event log so we can robustly detect both DOWN→LIGHT and LIGHT→DOWN.
const eventHistory = {}; // { playerNum: { action: { time, type } } }

// Directional activity state: we track both press-time and hold-state so we can
// distinguish:
//  - recently pressed direction (strong intent)
//  - currently held direction (valid modifier)
//  - stale held direction (no modifier)
const directionState = {}; // { playerNum: { dir: { pressedAt, releasedAt, heldSince } } }

// Pre-hoisted direction arrays — avoid per-call allocation in hot paths.
const _DIRS_4 = ['up', 'down', 'left', 'right'];
const _DIRS_5 = ['left', 'right', 'up', 'down', 'jump'];

// Light attack string timing constants (combo reliability, not combat stats)
export { COMBO_WINDOW, DIRECTION_BUFFER, ATTACK_BUFFER, HELD_DIRECTION_GRACE };

// Key action mappings (action -> set of key codes)
const BINDINGS = {
  player1: {
    left:       ['ArrowLeft', 'KeyA'],
    right:      ['ArrowRight', 'KeyD'],
    jump:       ['ArrowUp', 'KeyW', 'Space'],
    attack:     ['KeyJ', 'KeyZ'],
    special:    ['KeyK', 'KeyX'],
    shield:     ['KeyL', 'KeyC'],
    dodge:      ['ShiftLeft', 'ShiftRight'],
    grab:       ['KeyI', 'KeyV'],
    down:       ['ArrowDown', 'KeyS'],
  },
  player2: {
    left:       ['Numpad4'],
    right:      ['Numpad6'],
    jump:       ['Numpad8', 'Numpad5'],
    attack:     ['Numpad1'],
    special:    ['Numpad9'],
    shield:     ['Numpad3'],
    dodge:      ['Numpad0'],
    grab:       ['Numpad7'],
    down:       ['Numpad2'],
  },
};

// Reversed lookup: keyCode -> action (for player1)
const codeToAction1 = {};
for (const [action, codes] of Object.entries(BINDINGS.player1)) {
  for (const code of codes) codeToAction1[code] = action;
}
const codeToAction2 = {};
for (const [action, codes] of Object.entries(BINDINGS.player2)) {
  for (const code of codes) codeToAction2[code] = action;
}

function nowMs() {
  return performance.now();
}

function recordAction(playerNum, action, type) {
  if (!eventHistory[playerNum]) eventHistory[playerNum] = {};
  eventHistory[playerNum][action] = { time: nowMs(), type };
}

function recordDirectionState(playerNum, action, pressed) {
  if (!directionState[playerNum]) directionState[playerNum] = {};
  const ds = directionState[playerNum][action];
  if (pressed) {
    if (!ds) {
      directionState[playerNum][action] = { pressedAt: nowMs(), releasedAt: 0, heldSince: nowMs() };
    } else if (ds.releasedAt) {
      // Re-pressed after release: restart intent
      directionState[playerNum][action] = { pressedAt: nowMs(), releasedAt: 0, heldSince: nowMs() };
    }
  } else if (ds) {
    // Only record release once
    if (!ds.releasedAt) directionState[playerNum][action].releasedAt = nowMs();
  }
}

function onKeyDown(e) {
  if (e.repeat) return;
  keys[e.code] = true;
  if (!justPressed[e.code]) justPressedCodes.push(e.code);
  justPressed[e.code] = true;

  const action = getAction(e.code, 1) || getAction(e.code, 2);
  if (action) {
    for (let pn = 1; pn <= 2; pn++) {
      recordAction(pn, action, 'press');
      if (action === 'left' || action === 'right' || action === 'up' || action === 'down' || action === 'jump') {
        recordDirectionState(pn, action, true);
      }
      // Platform-fighter convention: the jump buttons (ArrowUp/KeyW/Space,
      // Numpad8/5) ALSO count as the "up" direction for up-tilt/up-smash and
      // up-special recovery. Without this alias isHeld(p,'up') is always false
      // (there is no separate 'up' binding) so up attacks could never fire.
      if (action === 'jump') {
        recordAction(pn, 'up', 'press');
        recordDirectionState(pn, 'up', true);
      }
    }
  }

  // Prevent page scroll on arrow keys / space
  if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) {
    e.preventDefault();
  }
}

function onKeyUp(e) {
  keys[e.code] = false;
  if (!justReleased[e.code]) justReleasedCodes.push(e.code);
  justReleased[e.code] = true;

  const action = getAction(e.code, 1) || getAction(e.code, 2);
  if (action) {
    for (let pn = 1; pn <= 2; pn++) {
      recordAction(pn, action, 'release');
      if (action === 'left' || action === 'right' || action === 'up' || action === 'down' || action === 'jump') {
        recordDirectionState(pn, action, false);
      }
      // Release the 'up' alias together with jump so held-up never sticks.
      if (action === 'jump') {
        recordAction(pn, 'up', 'release');
        recordDirectionState(pn, 'up', false);
      }
    }
  }
}

export function initInput() {
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
}

// Call once per frame at the END of update, after all input reads.
// Frame-only flags are cleared here. Historical intent (direction + attack)
// persists and is aged out by time, so buffered inputs can still be read.
export function flushInput() {
  // Cleared by assignment, not `delete`. Every reader of these two objects tests
  // truthiness only (isJustPressed / isJustReleased / isActionJustPressed), never
  // `'code' in obj` or Object.keys, so a stored `false` is indistinguishable from
  // an absent key. Assigning keeps both objects in V8's fast-properties mode
  // instead of pinning them in dictionary mode the way a delete would, and only
  // the handful of codes actually stamped since the last flush are touched.
  for (let i = 0; i < justPressedCodes.length; i++) justPressed[justPressedCodes[i]] = false;
  for (let i = 0; i < justReleasedCodes.length; i++) justReleased[justReleasedCodes[i]] = false;
  justPressedCodes.length = 0;
  justReleasedCodes.length = 0;

  const now = nowMs();
  ageHistory(now);
}

function ageHistory(now) {
  // Event history: keep one most-recent event per action per player permanently
  // (we use timestamps for window checks). We do not wipe it every frame.
  // This avoids losing the info needed for DOWN→LIGHT / LIGHT→DOWN.

  // Direction state: age out stale held directions that have exceeded grace.
  for (let pn = 1; pn <= 2; pn++) {
    if (!directionState[pn]) continue;
    for (const dir of _DIRS_5) {
      const ds = directionState[pn][dir];
      if (!ds) continue;
      if (ds.releasedAt) {
        // Released: keep pressedAt for recognition while within buffer window.
        // No need to zero it here; window checks use timestamps.
      } else {
        // Still held: if held longer than grace, mark as stale by setting a fake
        // releasedAt so old holds stop behaving like fresh directional intent.
        const heldDuration = now - ds.heldSince;
        if (heldDuration > HELD_DIRECTION_GRACE) {
          // Keep it valid as "held direction" but mark intent as stale.
          // We do this by ensuring pressedAt is older than buffer window.
          if (now - ds.pressedAt > DIRECTION_BUFFER) {
            // treat as stale held direction — still held, but weak intent
            // (we handle this in getDirectionalIntent).
          }
        }
      }
    }
  }
}

function getAction(code, playerNum) {
  if (playerNum === 1) return codeToAction1[code] || null;
  if (playerNum === 2) return codeToAction2[code] || null;
  return null;
}

// Query API for a specific player (1 or 2)
export function isHeld(playerNum, action) {
  // Check virtual key overrides (for AI)
  const vk = virtualKeys[playerNum];
  if (vk && action in vk) return vk[action];
  // 'up' has no dedicated binding — it aliases the jump keys (see onKeyDown).
  // This keeps isHeld(p,'up') truthful for both humans (ArrowUp held) and AI
  // virtual overrides (which set 'up' explicitly; the vk check above wins).
  const bindings = playerNum === 1 ? BINDINGS.player1 : BINDINGS.player2;
  if (action === 'up') {
    if (vk && 'jump' in vk && vk['jump']) return true;
    const jumpCodes = bindings.jump || [];
    for (let i = 0; i < jumpCodes.length; i++) if (keys[jumpCodes[i]]) return true;
    return false;
  }
  const codes = bindings[action] || [];
  for (let i = 0; i < codes.length; i++) if (keys[codes[i]]) return true;
  return false;
}

// Did this action get pressed recently (within configured window)?
export function isActionPressedRecently(playerNum, action, maxAgeMs = INPUT_CONFIG.directionBufferMs) {
  const he = eventHistory[playerNum];
  if (!he || !he[action]) return false;
  return (nowMs() - he[action].time) <= maxAgeMs;
}

// Did this action get pressed this frame?
export function isActionJustPressed(playerNum, action) {
  const bindings = playerNum === 1 ? BINDINGS.player1 : BINDINGS.player2;
  const codes = bindings[action] || [];
  for (let i = 0; i < codes.length; i++) if (justPressed[codes[i]]) return true;
  return false;
}

// Directional intent for combat.
// Returns { dir, strength } where dir is 'up'|'down'|'left'|'right'|null and
// strength is 'fresh' | 'held' | 'stale'.
//
// Priority:
//  1. A direction freshly pressed within directionBuffer window (strong intent)
//  2. A direction currently held and still within grace window (valid modifier)
//  3. Otherwise null (no meaningful directional intent for combat)
export function getDirectionalIntent(playerNum) {
  const now = nowMs();
  const ds = directionState[playerNum];
  if (!ds) return { dir: null, strength: 'none', ageMs: 0 };

  const dirs = _DIRS_4;
  let best = null;

  for (const d of dirs) {
    const s = ds[d];
    if (!s) continue;

    // Fresh press is strongest intent.
    if (s.pressedAt && (now - s.pressedAt) <= DIRECTION_BUFFER) {
      if (!best || (now - s.pressedAt) < (now - best.pressedAt)) {
        best = { dir: d, pressedAt: s.pressedAt, releasedAt: s.releasedAt, heldSince: s.heldSince };
      }
    }
  }

  if (best) {
    return {
      dir: best.dir,
      strength: 'fresh',
      ageMs: now - best.pressedAt,
    };
  }

  // No fresh press: check currently held directions that are still within grace.
  for (const d of dirs) {
    const s = ds[d];
    if (!s || s.releasedAt) continue;
    const heldDuration = now - s.heldSince;
    if (heldDuration <= HELD_DIRECTION_GRACE) {
      if (!best || s.heldSince > best.heldSince) {
        best = { dir: d, pressedAt: 0, releasedAt: 0, heldSince: s.heldSince };
      }
    }
  }

  if (best) {
    return {
      dir: best.dir,
      strength: 'held',
      ageMs: now - best.heldSince,
    };
  }

  return { dir: null, strength: 'none', ageMs: 0 };
}

// Has a direction been released recently (for LIGHT→DIR recognition)?
export function isDirectionReleasedRecently(playerNum, direction) {
  const ds = directionState[playerNum];
  if (!ds || !ds[direction] || !ds[direction].releasedAt) return false;
  return (nowMs() - ds[direction].releasedAt) <= DIRECTION_BUFFER;
}

// Whether an attack press happened recently (for combo/early attack buffering).
export function isAttackPressedRecently(playerNum, maxAgeMs = ATTACK_BUFFER) {
  return isActionPressedRecently(playerNum, 'attack', maxAgeMs);
}

// Whether an attack was released recently (useful for tap/hold distinctions).
export function isAttackReleasedRecently(playerNum, maxAgeMs = INPUT_CONFIG.attackBufferMs) {
  return isActionPressedRecently(playerNum, 'attack', maxAgeMs) && false; // kept for completeness; we use event type instead
}

// Legacy compat (renamed for clarity). Do not use for new logic.
export function isDirectionRecentlyActive(playerNum, direction) {
  return isActionPressedRecently(playerNum, direction, INPUT_CONFIG.directionBufferMs);
}

// Legacy compat.
export function getRecentDirection(playerNum) {
  const intent = getDirectionalIntent(playerNum);
  return intent.dir;
}

// Set virtual held state for AI (call before frame, clear after)
export function setVirtualHeld(playerNum, action, held) {
  if (!virtualKeys[playerNum]) virtualKeys[playerNum] = {};
  virtualKeys[playerNum][action] = held;
}

export function clearVirtualHeld(playerNum) {
  virtualKeys[playerNum] = {};
}

export function isJustPressed(playerNum, action) {
  // 'up' aliases jump presses (same convention as isHeld).
  if (action === 'up') action = 'jump';
  const bindings = playerNum === 1 ? BINDINGS.player1 : BINDINGS.player2;
  const codes = bindings[action] || [];
  for (let i = 0; i < codes.length; i++) if (justPressed[codes[i]]) return true;
  return false;
}

export function isJustReleased(playerNum, action) {
  if (action === 'up') action = 'jump';
  const bindings = playerNum === 1 ? BINDINGS.player1 : BINDINGS.player2;
  const codes = bindings[action] || [];
  for (let i = 0; i < codes.length; i++) if (justReleased[codes[i]]) return true;
  return false;
}

export function destroyInput() {
  window.removeEventListener('keydown', onKeyDown);
  window.removeEventListener('keyup', onKeyUp);
}


// ── merged from fighter/Fighter.js ──
// Fighter.js — merged: Physics + Fighter data/state + FighterController input.
// Movement + combat sandbox: run / jump / double jump / fast fall / dash /
// dodge / drop-through plus the data-driven attack system from combat.js.
// Fighters carry `percent` (the damage meter), an active `attack` instance,
// `hitstun` (attack lockout), and a `shielding` flag refreshed each frame.


// ============================================================================
// PHYSICS CONSTANTS (from Physics.js)
// ============================================================================

// Lighter, more airborne feel: reduced gravity + lower terminal fall speed.
export const GRAVITY = 1750;
export const MAX_FALL_SPEED = 950;
export const FAST_FALL_MULTIPLIER = 1.8;

// Ground movement. VERY snappy for Smash-like feel.
// Balance: max horizontal speeds ×0.60 (165→99) then §22 ×1.15 (99→114), then
// §46 ×0.60 (114→68) to slow the fighters down. Accel/decel/friction are scaled
// by the SAME ×0.60 so the time-to-top-speed ratio is preserved — the fighters
// simply cover less ground per second instead of feeling twitchier.
export const RUN_SPEED = 68;  // 114 × 0.60 — noticeably heavier, same handling
export const GROUND_ACCEL = 2100;   // 3500 × 0.60 — same time-to-top-speed
export const GROUND_DECEL = 1080;   // 1800 × 0.60 — same stop curve
export const GROUND_FRICTION = 840; // 1400 × 0.60 — same deceleration feel

// Air movement - snappier for Smash-like controls (§46: ×0.60 alongside ground)
export const AIR_SPEED = 58;   // 97 × 0.60
export const AIR_ACCEL = 840;        // 1400 × 0.60 — same air-control authority
export const AIR_FRICTION = 300;      // 500 × 0.60
export const AIR_DRAG = 0.94;         // Slightly more drag for tighter control
// ── Launch physics ─────────────────────────────────────────────────────
// LAUNCH_GRAVITY_MUL isolates launch arcs from ordinary platforming: while a
// fighter is in hitstun (knocked out, no input), gravity is scaled by this so
// strong hits fly a real arc instead of popping up and dropping. Jumps, falls,
// fast-fall and recovery all use full gravity — only launched victims get relief.
export const LAUNCH_GRAVITY_MUL = 0.55;

// Jump
export const JUMP_FORCE = 680;
export const DOUBLE_JUMP_FORCE = 680; // Increased from 580 for better recovery
export const JUMP_CUT_MULTIPLIER = 0.4; // releasing jump early cuts velocity
export const SHORTHOP_FORCE = 420;
export const DOUBLE_JUMP_COUNT = 1;

// Recovery - tunable constants
export const RECOVERY_UPWARD_FORCE = 750; // Reduced up-special lift
export const RECOVERY_HORIZONTAL_FORCE = 186; // Preserve current drift
export const RECOVERY_AIR_CONTROL = 1.3; // Preserve current air control
// Up-special ramp: the lift snaps partway on press (immediate response) and
// accelerates through the rest over this window, so recovery rises smoothly
// instead of popping. Total lift still equals RECOVERY_UPWARD_FORCE.
export const RECOVERY_RAMP_TIME = 0.12;
export const RECOVERY_RAMP_SNAP = 0.45;

// ── Directional Influence (DI) tuning ────────────────────────────────────
// Smash-style launch influence: while freshly launched (hitstun + window),
// held directions rotate the launch velocity toward the held bearing. Speed
// is preserved exactly — DI bends the trajectory, never cancels it.
//   DI_MAX_ANGLE — total rotation budget stamped per launch (rad, ~18°)
//   DI_WINDOW    — seconds after a launch during which DI applies
//   DI_RATE      — how fast the budget can be spent (rad/s)
export const DI_MAX_ANGLE = 0.32;
export const DI_WINDOW = 0.45;
export const DI_RATE = 1.7;

// ── Aerial Light recovery tuning ─────────────────────────────────────────
// The mid-air Light attack doubles as a strong upward recovery move. All of
// the recovery tuning lives here so it can be retuned in one obvious place.
// Ground Light (J grounded) is untouched — only the AIRBORNE J uses this.
// Airborne J = immediate strong upward launch to SELF (not attack knockback):
// counters downward velocity, launches strongly up, enough to recover from
// far below, preserves horizontal steering. Configurable via
// AERIAL_LIGHT_RECOVERY_FORCE.
export const AERIAL_LIGHT_RECOVERY_FORCE = 220; // Reduced airborne J self-launch
export const AERIAL_LIGHT_RECOVERY_DURATION = 0.2; // seconds the launch assist stays live (gravity cut + boosted steer)
export const AERIAL_LIGHT_GRAVITY_REDUCTION = 0.05; // gravity multiplier while the assist runs — near-zero keeps the launch strong
export const AERIAL_LIGHT_AIR_CONTROL = 1.5;        // horizontal air-accel multiplier during the assist (aim the recovery)

// Dash — §46: ×0.60 with the rest of the locomotion. Duration/cooldown keep
// fast action-heavy pace. The dash doubles as the dodge tool (§23): quick burst
// out of danger with short deliberate i-frames (see dodge below).
export const DASH_SPEED = 110;
export const DASH_DURATION = 0.12; // seconds
export const DASH_COOLDOWN = 0.18;

// ── Defensive cooldowns (§43/§44 — ONE shared system, player + AI alike) ──
// Both fighters run the exact same gating in combatInput/handleFighterInput,
// so the AI obeys identical restrictions automatically. Tune here only.
//   BLOCK_COOLDOWN — set on block RELEASE; re-engaging block sooner is denied.
//     0.35s stops block→release→block spam while keeping defense responsive.
//   DODGE_COOLDOWN / AIR_DODGE_COOLDOWN — set on dodge START; repeat dodges
//     are denied until it clears. Long enough to stop DODGE×4 spam, short
//     enough for skilled defensive play.
export const BLOCK_COOLDOWN = 0.35;
export const DODGE_COOLDOWN = 0.8;
export const AIR_DODGE_COOLDOWN = 1.0;

// ── Soft Player Separation ──────────────────────────────────────────────────
// Lightweight non-collision separation that gently pushes players apart when
// they get too close, without making them solid physics objects.
export const PLAYER_SEPARATION_DISTANCE = 50; // floor for the per-pair gap (actual gap is radiusA + radiusB)
const SEPARATION_SPEED = 8.0; // interpolation speed factor (higher = faster correction)

// ============================================================================
// FIGHTER STATE MACHINE
// ============================================================================

export const STATES = {
  IDLE: 'idle',
  RUN: 'run',
  JUMP: 'jump',
  FALL: 'fall',
  AIRBORNE: 'airborne',
  DASH: 'dash',
  DODGE: 'dodge',
  AIR_DODGE: 'airdodge',
  ATTACK: 'attack',
  HITSTUN: 'hitstun',
  // Launch/tumble state: persists after hitstun ends, restricts recovery actions
  // but allows DI and air movement. Duration scales with knockback.
  LAUNCH: 'launch',
};

export function createFighter(playerNum, x, y, skin, options = {}) {
  return {
    id: options.id || `p${playerNum}`,
    playerNum,
    x, y,
    vx: 0, vy: 0,
    radius: options.radius || 22,
    color: options.color || (playerNum === 1 ? '#4a9eff' : '#ff4a4a'),
    skin: skin || null,
    skinScale: options.skinScale || 1,
    skinCenter: options.skinCenter || null,
    accessory: options.accessory ? { ...options.accessory } : null,
    // Cosmetic gear worn on the hands, per arm: { left, right }. Copied (not
    // shared) like `accessory` above, because the customiser hands out a
    // per-fighter set and the renderer only ever reads it.
    handGear: options.handGear
      ? { left: { ...options.handGear.left }, right: { ...options.handGear.right } }
      : null,

    // Combat — damage meter, active attack instance (managed by combat.js),
    // and hitstun lockout. Percent only ever goes up within a stock; a
    // blast-zone fall costs one stock (Game.js onBlastKO) and respawns at 0%.
    percent: 0,
    stocks: options.stocks ?? 3, // stocks remaining in the current match
    eliminated: false,           // true once the last stock is lost
    attack: null,
    attackBuffer: null, // queued { type, frames } from combat.js input buffering
    hitstun: 0,
    shielding: false,
    _hitFlash: 0,
    _hitLock: null,     // timed hit-confirm lock set by combat.js on a landed hit

    // Non-hitbox abilities / projectiles
    _projectiles: [],
    // A mount entity (the cowboy's horse ride) while one is active. Lives on
    // the fighter so combat (hitbox), render (Effects) and Game.js (platform
    // skip, probe) all see the same object. null when not riding.
    _horse: null,

    // State
    state: STATES.IDLE,
    facingRight: playerNum === 1,
    grounded: false,
    groundPlatform: null,

    // Movement
    runSpeed: options.runSpeed || RUN_SPEED,
    airSpeed: options.airSpeed || AIR_SPEED,
    jumpForce: options.jumpForce || JUMP_FORCE,
    doubleJumpForce: options.doubleJumpForce || DOUBLE_JUMP_FORCE,

    // Per-character physics multipliers (all 1 = neutral). Read from the
    // roster def at construction (Game.js / sandbox / training) so heavier /
    // floatier characters can differ without touching the shared constants:
    // gravityMul (fall weight), fallMaxMul (terminal velocity), airAccelMul
    // (air control authority), recoveryMul (up-special + aerial-light lift),
    // launchResist (extra launch dampening, multiplied with weight).
    // Recovery config: recoveryStrength (vertical lift), recoveryRange (horizontal reach),
    // recoveryCooldown (seconds between recovery uses).
    gravityMul: options.gravityMul || 1,
    fallMaxMul: options.fallMaxMul || 1,
    airAccelMul: options.airAccelMul || 1,
    recoveryMul: options.recoveryMul || 1,
    launchResist: options.launchResist || 1,
    recoveryStrength: options.recoveryStrength || 1,
    recoveryRange: options.recoveryRange || 1,
    recoveryCooldown: options.recoveryCooldown || 0,

    // Jump
    canDoubleJump: true,
    fastFalling: false,
    jumpPressed: false, // was jump held last frame
    jumpsUsed: 0,

    // Dash
_tempVfx: [],
    // A charged teleport waiting to fire: { fromX, fromY } is the spot the move
    // was ACTIVATED on (where its smoke goes off), armed by ABILITIES.ninjaDtilt
    // and consumed by combat.js when the charge elapses. null = no charge.
    _teleportPending: null,
    dashing: false,
    dashTimer: 0,
    dashCooldown: 0,
    dashDirection: 1,
    // Remaining shadow-dash travel in pixels; -1 means "no shadow-dash burst
    // running", which is deliberately distinct from 0 ("the budget is spent, but
    // the burst has not ended yet") so the leftover frames of the burst window
    // cannot add distance past dashDistance.
    _shadowDashRemain: -1,
    lastGroundedX: 0,
    // Aerial Light recovery assist: seconds remaining of the upward launch
    // buff (gravity reduction + boosted air control). Set by combat.js when an
    // airborne Light attack starts; decays every frame and landing naturally
    // ends it. Finite — the recovery is never infinite.
    _aerialRecoveryTimer: 0,

    // Hands runtime state (rendering only). Per ANATOMICAL side — the displayed
    // offsets are never stored per screen role (that made the hands jump on a
    // turn). `_handWorld` is the world-space pair for debug/probe.
    _handL: null,       // smoothed left-hand pose (rendering only)
    _handR: null,       // smoothed right-hand pose (rendering only)
    _handWorld: null,   // { left:{x,y}, right:{x,y} } world positions (debug)

    // Free-fall: recovery is consumed after a double jump once airborne —
    // the free-fall glow shows while falling without a jump left.
    freeFall: false,

    // Dodge
    dodging: false,
    dodgeTimer: 0,
    dodgeCooldown: 0,
    dodgeDirection: { x: 0, y: 0 },

    // Shared cooldowns (§43 block / §45 attack). Decayed in
    // stepFighterPhysics; gated in combatInput/handleFighterInput — the same
    // path for human and AI input, so both obey identical rules.
    shieldCooldown: 0, // §43: set on block release, blocks re-engage while > 0
    attackCooldown: 0, // §45: set on every attack start, min 0.83s between starts

    // Per-ABILITY cooldowns, keyed by ability id: { cowboyDownLight: 4.2, … }.
    // The remaining seconds, not an absolute stamp, so they ride the same clock
    // and the same step as the shared cooldowns above — no parallel timing
    // system. Stamped by combat.js when the ability fires, decayed below.
    abilityCooldowns: {},

    // Invulnerability
    invulnTimer: 0,

    // Wavedash
    wavedashing: false,

    // Drop-through
    wantsToDropThrough: false,
    dropThroughPlatform: null, // platform being dropped through (per-player ignore)
    groundType: null,          // 'main' | 'platform' | null

    // Previous bottom Y for one-way platform detection
    _prevBottomY: 0,

    // Visual
    scale: 1,
    squishX: 1,  // horizontal squish factor
    squishY: 1,  // vertical squish factor
    squishTimer: 0,

    // Fall speed
    fallSpeed: options.fallSpeed || 1.0,

    // Coyote time (grace period after leaving ground to still jump)
    coyoteTimer: 0,

    // Jump buffer (press jump slightly before landing, auto-jump on land)
    jumpBufferTimer: 0,

    // Track if was airborne last frame (for landing detection)
    wasGrounded: true,
    // Tracks if double jump is available (needs to touch ground to recharge)
    canDoubleJump: true,
    // Tracks if aerial light recovery is available (needs to touch ground to recharge)
    canUseAerialLightRecovery: true,

    // Launch/tumble state timer: set when hit, decays after hitstun ends.
    // While > 0, restricts recovery actions (double jump, aerial light, up-special)
    // but allows DI and normal air movement.
    launchTimer: 0,

    // Fighter roster definition (set by Game.js, used for skin/accessory lookup)
    _fighterDef: null,
  };
}

// Update fighter state based on current conditions
export function updateFighterState(fighter) {
  if (fighter.state === STATES.DEAD) return;

  // Invulnerability blink
  if (fighter.invulnTimer > 0) {
    fighter.scale = 1 + 0.05 * Math.sin(fighter.invulnTimer * 30);
  } else {
    fighter.scale = 1;
  }

  // Combat states take precedence over movement states. Hitstun is a result of
  // being hit (attack already cancelled); an in-progress attack locks the
  // fighter into the ATTACK pose for its full startup → active → recovery.
  if (fighter.hitstun > 0) {
    fighter.state = STATES.HITSTUN;
    return;
  }
  // Launch/tumble state: persists after hitstun ends, restricts recovery actions
  // (double jump, aerial light, up-special) but allows DI and air movement.
  // Decays here so it ticks down every frame.
  if (fighter.launchTimer > 0) {
    fighter.launchTimer = Math.max(0, fighter.launchTimer - (fighter._dt || 0));
    fighter.state = STATES.LAUNCH;
    return;
  }
  if (fighter.attack) {
    fighter.state = STATES.ATTACK;
    return;
  }

  // Dodge state
  if (fighter.dodging) {
    fighter.state = fighter.grounded ? STATES.DODGE : STATES.AIR_DODGE;
    return;
  }

  // Dashing
  if (fighter.dashing) {
    fighter.state = STATES.DASH;
    return;
  }

  // Airborne states
  if (!fighter.grounded) {
    fighter.state = fighter.vy < 0 ? STATES.JUMP : STATES.FALL;
    return;
  }

  // Grounded states
  const isMoving = Math.abs(fighter.vx) > 10;
  fighter.state = isMoving ? STATES.RUN : STATES.IDLE;
}

// ══ Physics rules ════════════════════════════════════════════════════

// End a dash burst. The Shadow Dash (abilities.js ninjaDsmash) is a
// FIXED-DISTANCE forward move: it sets a constant velocity for
// `distance / speed` seconds and `dashing` suppresses friction for the whole
// window, so without this the leftover burst velocity would coast on under
// normal deceleration — making the travelled distance a function of the ground
// friction constant instead of the move's own `dashDistance`. Zeroing the
// velocity here makes the travel exactly the distance the ability asked for,
// from any position on the map, in the direction captured at activation.
//
// Scoped to the shadow dash (`_shadowDashSpeed`): the generic Dash ability
// keeps its existing burst-then-settle behaviour, and the dodge is unaffected
// (it runs on dodgeTimer, not dashTimer).
function endDashBurst(fighter) {
  if (fighter._shadowDashSpeed) fighter.vx = 0;
  fighter.dashTimer = 0;
  fighter.dashing = false;
  fighter._shadowDashDir = 0;
  fighter._shadowDashSpeed = 0;
  fighter._shadowDashRemain = -1;
}
export function stepFighterPhysics(fighter, dt) {
  if (fighter.state === 'dead') return;

  // Hitstun decays here, after knockback velocity has been applied but before
  // the ground/air drag would erase it.
  if (fighter.hitstun > 0) {
    fighter.hitstun -= dt;
    if (fighter.hitstun < 0) fighter.hitstun = 0;
  }

  // Hit flash decays
  if (fighter._hitFlash > 0) {
    fighter._hitFlash -= dt;
    if (fighter._hitFlash < 0) fighter._hitFlash = 0;
  }

  // Shuriken hit-lock: while the timer runs the target is genuinely frozen
  // in place — velocities held at zero, no gravity, no position integration,
  // no friction. Hitstun / invuln / hit-flash above keep decaying on their own
  // clocks, so the lock respects the normal rules and always releases cleanly;
  // on expiry the stored knockback velocity resumes and physics continues.
  if ((fighter._hitLockTimer || 0) > 0) {
    fighter._hitLockTimer -= dt;
    fighter.vx = 0;
    fighter.vy = 0;
    if (fighter.invulnTimer > 0) {
      fighter.invulnTimer -= dt;
      if (fighter.invulnTimer < 0) fighter.invulnTimer = 0;
    }
    if (fighter._hitLockTimer <= 0) {
      // Release: restore the knockback stored at lock time, then fall through
      // to normal physics this same frame so movement resumes immediately.
      if (fighter._hitLockVsx !== undefined && fighter._hitLockVsy !== undefined) {
        fighter.vx = fighter._hitLockVsx;
        fighter.vy = fighter._hitLockVsy;
        fighter._hitLockVsx = undefined;
        fighter._hitLockVsy = undefined;
      }
      fighter._hitLockTimer = 0;
    } else {
      // Still locked: tick the time-based defensive/attack clocks so the
      // freeze can't stall them, then skip all motion for this frame.
      if (fighter.dashTimer > 0) {
        fighter.dashTimer -= dt;
        if (fighter.dashTimer <= 0) {
          endDashBurst(fighter);
        }
      }
      if (fighter.dodgeCooldown > 0) fighter.dodgeCooldown = Math.max(0, fighter.dodgeCooldown - dt);
      if (fighter.shieldCooldown > 0) fighter.shieldCooldown = Math.max(0, fighter.shieldCooldown - dt);
      if (fighter.attackCooldown > 0) fighter.attackCooldown = Math.max(0, fighter.attackCooldown - dt);
      return;
    }
  } else {
    // Clear stored velocity if timer is not active
    fighter._hitLockVsx = undefined;
    fighter._hitLockVsy = undefined;
  }

  // Aerial Light recovery assist is finite: the launch buff decays on its own
  // each frame (and landing cuts it short — gravity is only reduced airborne).
  if (fighter._aerialRecoveryTimer > 0) {
    fighter._aerialRecoveryTimer -= dt;
    if (fighter._aerialRecoveryTimer < 0) fighter._aerialRecoveryTimer = 0;
  }

  // Save previous bottom Y for one-way platform detection
  fighter._prevBottomY = fighter.y + fighter.radius;

  // Hit-confirm lock: both fighters freeze in place for the brief window
  // before the deferred knockback launches the target (combat.js). Invuln
  // still decays so post-lock i-frames are just the normal hit feedback.
  if (fighter._hitLock) {
    fighter.vx = 0;
    fighter.vy = 0;
    if (fighter.invulnTimer > 0) {
      fighter.invulnTimer -= dt;
      if (fighter.invulnTimer < 0) fighter.invulnTimer = 0;
    }
    return;
  }

  // Apply gravity (relieved while launched: full gravity erased upward
  // launches in ~0.1s, so hitstun victims fly at LAUNCH_GRAVITY_MUL)
  if (!fighter.grounded) {
    let grav = GRAVITY * (fighter.gravityMul || 1);
    if (fighter.hitstun > 0) grav *= LAUNCH_GRAVITY_MUL;
    // Aerial Light recovery assist: while the buff is live the airborne fighter
    // skates through a strong upward drift that isn't instantly erased by full
    // gravity — the launch stays high enough to actually recover the stage.
    if (fighter._aerialRecoveryTimer > 0) {
      grav *= AERIAL_LIGHT_GRAVITY_REDUCTION;
    }
    // Fast fall
    if (fighter.fastFalling) {
      grav *= FAST_FALL_MULTIPLIER;
    }
    fighter.vy += grav * dt;
    const fallCap = (fighter.fastFalling ? 1150 : MAX_FALL_SPEED) * (fighter.fallMaxMul || 1);
    if (fighter.vy > fallCap) fighter.vy = fallCap;
    // Up-special ramp: accelerate through the remaining lift after the press
    // snap, clamped at the target so it can never overshoot into extra hang
    // time. Runs under normal gravity — no float, no delay.
    if ((fighter._recoveryRamp || 0) > 0) {
      fighter._recoveryRamp -= dt;
      const tgt = fighter._recoveryRampTarget;
      if (Number.isFinite(tgt)) {
        fighter.vy += ((tgt * (1 - RECOVERY_RAMP_SNAP)) / RECOVERY_RAMP_TIME) * dt;
        if (fighter.vy < tgt) fighter.vy = tgt;
      }
      if (fighter._recoveryRamp <= 0) fighter._recoveryRamp = 0;
    }
  }

  // Apply velocity
  if (fighter._shadowDashRemain >= 0) {
    // The shadow dash pays out of a fixed pixel budget, so the travel is
    // exactly `dashDistance` instead of "however far velocity × whole frames"
    // lands on at this frame rate. Scoped to that move: everything else keeps
    // the plain `vx * dt` integration.
    const step = fighter.vx * dt;
    if (Math.abs(step) >= fighter._shadowDashRemain) {
      fighter.x += Math.sign(step) * fighter._shadowDashRemain;
      fighter._shadowDashRemain = 0;
    } else {
      fighter.x += step;
      fighter._shadowDashRemain -= Math.abs(step);
    }
  } else {
    fighter.x += fighter.vx * dt;
  }
  fighter.y += fighter.vy * dt;

  // Ground friction / air friction — skipped during hitstun so knockback
  // velocity isn't erased while the defender is being launched. Air drag is
  // additionally skipped through the whole tumble (launchTimer): it used to
  // resume the instant hitstun ended and erase ~84% of horizontal momentum in
  // 0.5s (0.94/frame). Ground friction still applies on landing skids.
  if (fighter.hitstun <= 0) {
    if (fighter.grounded) {
      if (Math.abs(fighter.vx) > 0 && !fighter.dashing) {
        const decel = GROUND_DECEL * dt;
        if (Math.abs(fighter.vx) <= decel) {
          fighter.vx = 0;
        } else {
          fighter.vx -= Math.sign(fighter.vx) * decel;
        }
      }
    } else if (!fighter.dashing && fighter.launchTimer <= 0) {
      // Air drag (skipped while dashing — a dash burst keeps its captured
      // forward velocity for its whole duration — and while tumbling).
      fighter.vx *= airDragFactor(dt);
    }
  }

  // Dash timer
  if (fighter.dashTimer > 0) {
    fighter.dashTimer -= dt;
    if (fighter.dashTimer <= 0) {
      endDashBurst(fighter);
    }
  }

  // Dash cooldown
  if (fighter.dashCooldown > 0) {
    fighter.dashCooldown -= dt;
    if (fighter.dashCooldown < 0) fighter.dashCooldown = 0;
  }

  // Dodge cooldown
  if (fighter.dodgeCooldown > 0) {
    fighter.dodgeCooldown -= dt;
    if (fighter.dodgeCooldown < 0) fighter.dodgeCooldown = 0;
  }

  // Shared defensive/offensive cooldowns (§43/§45) decay alongside everything
  // else, in the same step, on the same clock — no parallel timing systems.
  if (fighter.shieldCooldown > 0) {
    fighter.shieldCooldown -= dt;
    if (fighter.shieldCooldown < 0) fighter.shieldCooldown = 0;
  }
  if (fighter.attackCooldown > 0) {
    fighter.attackCooldown -= dt;
    if (fighter.attackCooldown < 0) fighter.attackCooldown = 0;
  }
  // Depsey Roll buff clock: ticks down on the same step; expiry clears the
  // record so movement, dodge and attack pacing return to normal exactly.
  if (fighter._boxerRoll && fighter._boxerRoll.timeLeft > 0) {
    fighter._boxerRoll.timeLeft -= dt;
    if (fighter._boxerRoll.timeLeft <= 0) fighter._boxerRoll = null;
  }
  // Knight parry window: same step, same clock. Expiring unanswered is a
  // WHIFF — the guard locks briefly (via the shared shieldCooldown gate, so
  // no second timing system), leaving the knight punishable. A successful
  // parry zeroes the window in combat, so this path never fires for it.
  if (fighter._parryWindow > 0) {
    fighter._parryWindow -= dt;
    if (fighter._parryWindow <= 0) {
      fighter._parryWindow = 0;
      fighter.shieldCooldown = Math.max(fighter.shieldCooldown || 0, 0.45);
    }
  }
  // Knight counter stance: ticks down on the same step. Expiring unanswered
  // simply ends the stance into the move's own recovery — the whiff cost is
  // the recovery frames, so no extra lockout here (unlike the parry tap).
  if (fighter._knightCounter > 0) {
    fighter._knightCounter -= dt;
    if (fighter._knightCounter <= 0) fighter._knightCounter = 0;
  }
  const _rollCd = fighter._boxerRoll && fighter._boxerRoll.timeLeft > 0
    ? (fighter._boxerRoll.cdRate || 1) : 1;

  // Per-ability cooldowns, same clock and same step as the shared ones above.
  // Finished entries are deleted rather than left at 0 so the map can't grow a
  // key per ability for the rest of the match. The set of live ids is mirrored
  // into a tiny per-fighter array (`_abilityCdLive`) so the common case — one
  // reverse index loop over the handful of abilities actually cooling down —
  // replaces a `for...in` (own-keys snapshot) plus `delete` (which pins the
  // object in V8 dictionary mode permanently) on every frame of the match. The
  // plain object stays the source of truth: stampAbilityCooldown writes it, the
  // ?probe API reads it.
  const acd = fighter.abilityCooldowns;
  if (acd) {
    const live = fighter._abilityCdLive || (fighter._abilityCdLive = []);
    // Re-sync only while the mirror is empty, which also self-heals a map that was
    // populated directly instead of via stampAbilityCooldown (the ?probe and
    // ai-training setup paths). An empty `for...in` costs a shared empty keys
    // array, not a new one, and a non-empty one costs one pass — then the mirror
    // is non-empty and this branch is skipped again.
    if (live.length === 0) {
      for (const id in acd) live.push(id);
    }
    for (let i = live.length - 1; i >= 0; i--) {
      const id = live[i];
      const left = acd[id] - dt * _rollCd;
      if (left > 0) {
        acd[id] = left;
      } else {
        delete acd[id];
        live[i] = live[live.length - 1];
        live.pop();
      }
    }
  }

  // Invulnerability timer
  if (fighter.invulnTimer > 0) {
    fighter.invulnTimer -= dt;
    if (fighter.invulnTimer < 0) fighter.invulnTimer = 0;
  }

  // Subtle footstep dust while running on the ground. Timed, not per-frame: a
  // couple of small puffs at the feet every ~0.22s of fast ground movement.
  // Counts ride the shared quality scaler (emitDustPuff), so low-end settings
  // trim this first and gameplay never reads it back.
  if (fighter.grounded && !fighter.dashing && !fighter.dodging && !fighter.attack
      && fighter.hitstun <= 0 && !fighter._hitLock && !(fighter._hitLockTimer > 0)) {
    if (Math.abs(fighter.vx) > 45) {
      fighter._stepFxTimer = (fighter._stepFxTimer || 0) + dt;
      if (fighter._stepFxTimer >= 0.22) {
        fighter._stepFxTimer = 0;
        const sr = fighter.radius || 22;
        emitDustPuff(fighter.x - Math.sign(fighter.vx) * sr * 0.4, fighter.y + sr * 0.75, 2, {
          style: fxStyleFor(fighter), spread: Math.PI * 2, speed: 50,
          size: sr * 0.11, life: 0.3, gravity: 60, alpha: 0.32,
        });
      }
    } else if (fighter._stepFxTimer) {
      fighter._stepFxTimer = 0;
    }
  } else if (fighter._stepFxTimer) {
    fighter._stepFxTimer = 0;
  }

  // Knight movement trail: steel afterimages while moving fast, ground or
  // air. Timed pool emissions (Depsey Roll precedent), so a fast knight always
  // carries a wake behind him. Visual only — gameplay never reads it back.
  if (fighter._fighterDef && fighter._fighterDef.id === 'knight' && fighter.state !== 'dead') {
    if (Math.abs(fighter.vx) > 120 && !fighter.dodging) {
      fighter._knightTrailT = (fighter._knightTrailT || 0) + dt;
      if (fighter._knightTrailT >= 0.08) {
        fighter._knightTrailT = 0;
        try { emitGhost(fighter, { life: 0.22 }); } catch (_) {}
      }
    } else if (fighter._knightTrailT) {
      fighter._knightTrailT = 0;
    }
  }

  // Squish decay — spring back to 1,1
  if (fighter.squishTimer > 0) {
    fighter.squishTimer -= dt;
    if (fighter.squishTimer <= 0) {
      fighter.squishTimer = 0;
    }
  }
  const squishSpring = 1 - Math.min(1, dt * 12);
  fighter.squishX += (1 - fighter.squishX) * squishSpring;
  fighter.squishY += (1 - fighter.squishY) * squishSpring;
  if (Math.abs(fighter.squishX - 1) < 0.005) fighter.squishX = 1;
  if (Math.abs(fighter.squishY - 1) < 0.005) fighter.squishY = 1;

// Landing detection: was airborne, now grounded → recharge the jump resources.
// ONLY actual landing recharges double jump + Aerial-Light (never walls,
// enemies, or midair jumps — no other code path touches these flags).
     if (!fighter.wasGrounded && fighter.grounded) {
      fighter._justLanded = true;
      // Recharge both jump and aerial light recovery when touching ground
      fighter.canDoubleJump = true;
      fighter.canUseAerialLightRecovery = true;
      fighter._recoveryRamp = 0; // a landing cancels any unfinished lift ramp
     }
     fighter.wasGrounded = fighter.grounded;


  // Coyote timer: set when leaving ground without jumping, decays over time
  if (fighter.wasGrounded && !fighter.grounded && fighter.vy >= 0) {
    // Leaving ground (not from jump)
    if (fighter.coyoteTimer <= 0) {
      fighter.coyoteTimer = 0.1; // 100ms coyote time
    }
  }
  if (fighter.coyoteTimer > 0) {
    fighter.coyoteTimer -= dt;
    if (fighter.coyoteTimer < 0) fighter.coyoteTimer = 0;
  }

  // Jump buffer: decays over time
  if (fighter.jumpBufferTimer > 0) {
    fighter.jumpBufferTimer -= dt;
    if (fighter.jumpBufferTimer < 0) fighter.jumpBufferTimer = 0;
  }
}

// ── Soft Player Separation ──────────────────────────────────────────────────
// Lightweight non-collision separation that gently pushes players apart when
// they get too close, without making them solid physics objects.

function applySoftPlayerSeparation(fighterA, fighterB, dt, minDist) {
  // Don't separate if either is dead
  if (fighterA.state === 'dead' || fighterB.state === 'dead') {
    return false;
  }

  // Per-character spacing: bodies touch at radiusA + radiusB (62.4px for the
  // current roster), plus a 20% breathing margin (~75px total) so fighters rest
  // visibly apart instead of edge-to-edge. The global stays as a floor for
  // missing radii; callers may pass an explicit minDist to widen it further.
  const need = minDist != null ? minDist
    : Math.max(PLAYER_SEPARATION_DISTANCE,
        ((fighterA.radius || 22) + (fighterB.radius || 22)) * 1.2);

  // Only push while the fighters are roughly at the same height. If one is
  // clearly above the other (e.g. jumping over), the push drops out so the
  // airborne fighter can pass freely overhead.
  const dy = Math.abs(fighterB.y - fighterA.y);
  const verticalBand = (fighterA.radius + fighterB.radius) * 0.6;
  if (dy > verticalBand) {
    return false;
  }

  // Calculate horizontal distance between players
  const dx = fighterB.x - fighterA.x;
  const dist = Math.abs(dx);

  // If players are far enough apart, no separation needed
  if (dist >= need || dist < 0.1) {
    return false;
  }

  // Calculate overlap (how much they're too close)
  const overlap = need - dist;

  // Don't apply tiny corrections (prevents jitter when barely overlapping)
  if (overlap < 1) {
    return false;
  }

  // Calculate direction: positive = B is to the right of A
  const direction = dx > 0 ? 1 : -1;

  // Split the correction between both players (gentle push apart)
  // Each gets half the correction, scaled by separation speed for smoothness
  const correctionPerPlayer = (overlap * 0.5) * SEPARATION_SPEED * dt;

  // Apply soft separation - push them apart horizontally
  fighterA.x -= direction * correctionPerPlayer;
  fighterB.x += direction * correctionPerPlayer;

  return true;
}

export { applySoftPlayerSeparation };

// Movement speed multiplier, read rather than stored. `runSpeed` / `airSpeed`
// are NEVER mutated by a temporary buff: every movement target is multiplied
// by this scale instead, so a buff cannot leak into anything else that reads
// the fighter's real speed (AI spacing, camera framing, the roster sheet).
// (The old Depsey Roll speed buff is gone — Down Heavy is now a teleport +
// barrage — so this currently returns 1. The hook stays so a future buff
// cannot leak either.)
export function moveSpeedScale(fighter) {
  const roll = fighter && fighter._boxerRoll;
  return roll && roll.speedMul ? roll.speedMul : 1;
}

// ── Directional Influence ────────────────────────────────────────────────
// Rotates a freshly-launched fighter's velocity toward the held bearing,
// spending the per-launch budget stamped by combat.js (launchFromHit).
// Speed is preserved exactly: DI bends the trajectory, never adds speed,
// reverses, or grants movement — and it only runs during hitstun inside the
// DI window, so ordinary (and recovery) movement is untouched. Reads the
// same held-direction triple as everything else, so keyboard, AI synthetic
// input and any future mobile binding feed it identically.
export function applyDI(fighter, dt, p, isHeld) {
  if (fighter.hitstun <= 0) return;
  if ((fighter._diWindow || 0) <= 0 || (fighter._diBudget || 0) <= 0) return;
  const sp2 = fighter.vx * fighter.vx + fighter.vy * fighter.vy;
  if (sp2 < 1) return;
  const ix = (isHeld(p, 'right') ? 1 : 0) - (isHeld(p, 'left') ? 1 : 0);
  const iy = (isHeld(p, 'down') ? 1 : 0) - (isHeld(p, 'up') ? 1 : 0);
  fighter._diWindow -= dt;
  if (ix === 0 && iy === 0) return;
  const velAng = Math.atan2(fighter.vy, fighter.vx);
  const inAng = Math.atan2(iy, ix);
  let diff = inAng - velAng;
  while (diff > Math.PI) diff -= Math.PI * 2;
  while (diff < -Math.PI) diff += Math.PI * 2;
  const step = Math.max(-DI_RATE * dt, Math.min(DI_RATE * dt, diff));
  const allow = fighter._diBudget;
  const applied = Math.abs(step) > allow ? Math.sign(step) * allow : step;
  if (applied === 0) return;
  fighter._diBudget = allow - Math.abs(applied);
  const sp = Math.sqrt(sp2);
  const na = velAng + applied;
  fighter.vx = Math.cos(na) * sp;
  fighter.vy = Math.sin(na) * sp;
}

// Spawn a temporary VFX effect that will be automatically removed after its
// lifetime. `extra` (optional) overrides/extends the instance: effects that need
// their own parameters carry them there (the shadow dash needs the distance it
// has to cover), and a caller can pin a direction other than the fighter's live
// facing. The live instance is returned so the caller can keep tuning it.
export function spawnTempVfx(fighter, effectName, lifetime, scale = 1, rotation = 0, offsetX = 0, offsetY = 0, extra = null) {
  // Timeline deference (the single rule behind every code-driven trail and
  // burst): if the fighter's CURRENT animation carries its own timeline entry
  // for the same effect, the animator's pool already paints it — with the
  // user's timing, scale, rotation and X/Y offsets — so queuing a second
  // instance here would double-draw. Delete the timeline entry and this code
  // fallback returns. This is what makes every ability VFX editable in the
  // Hand Animator: attach/tune it on the move, and the game honors it.
  if (fighter && animOwnsEffect(fighter, effectName)) return null;
  if (!fighter._tempVfx) fighter._tempVfx = [];
  const v = {
    effect: effectName,
    lifetime,
    age: 0,
    progress: 0,
    scale,
    rotation,
    offsetX,
    offsetY,
    anchor: 'character', // default anchor; can be changed if needed
    mirrorX: fighter.facingRight ? 1 : -1
  };
  if (extra) Object.assign(v, extra);
  fighter._tempVfx.push(v);
  return v;
}

// True when the fighter's current animation owns a timeline VFX entry for
// the effect (same shape the Hand Animator edits and persists).
function animOwnsEffect(fighter, effectId) {
  const list = fighter && fighter.anim && fighter.anim.anim && fighter.anim.anim.vfx;
  if (!Array.isArray(list)) return false;
  for (let i = 0; i < list.length; i++) {
    if (list[i] && list[i].effect === effectId) return true;
  }
  return false;
}

// Start (or restart) an ability's cooldown. The plain object stays the value
// every reader uses; the id is also recorded in the per-fighter `_abilityCdLive`
// list that stepFighterPhysics walks to age the cooldowns down, so no frame ever
// has to enumerate the object's keys.
export function stampAbilityCooldown(fighter, id, seconds) {
  if (!id || !(seconds > 0)) return;
  if (!fighter.abilityCooldowns) fighter.abilityCooldowns = {};
  fighter.abilityCooldowns[id] = seconds;
  const live = fighter._abilityCdLive || (fighter._abilityCdLive = []);
  if (live.indexOf(id) === -1) live.push(id);
}

// Clear every ability cooldown (respawn / headless reset). The mirrored live-id
// list is cleared with the map so the two can't drift: a stale id left in the
// list would otherwise be aged against a value that is no longer there.
export function resetAbilityCooldowns(fighter) {
  if (fighter.abilityCooldowns) fighter.abilityCooldowns = {};
  if (fighter._abilityCdLive) fighter._abilityCdLive.length = 0;
}

// Air drag for one frame: AIR_DRAG^(dt*60). The exponent depends only on dt, so
// the result is memoised — Math.pow is one of the slower libm entry points in V8
// and this sits in the physics step of every airborne fighter every frame. At a
// steady frame time the cache hits on every call.
let _airDragDt = -1;
let _airDragValue = 1;
function airDragFactor(dt) {
  if (dt !== _airDragDt) {
    _airDragDt = dt;
    _airDragValue = Math.pow(AIR_DRAG, dt * 60);
  }
  return _airDragValue;
}

// ── Input handling / controller ────────────────────────────────────────────
export function handleFighterInput(fighter, stage, dt, inputFunctions = {}) {
   // Use provided input functions or fall back to default ones
   const isHeld = inputFunctions.isHeld || __isHeld;
   const isJustPressed = inputFunctions.isJustPressed || __isJustPressed;
   const isJustReleased = inputFunctions.isJustReleased || __isJustReleased;

  if (fighter.state === STATES.DEAD || fighter.state === STATES.RESPAWN) return;

// Update temporary VFX. Compacts IN PLACE — one pass that walks the list, keeps
  // the survivors, then truncates — so the array's identity is stable for the
  // readers that index it live (vfx.js draw, combat.js ninjaDsmash), instead of
  // allocating a replacement array from .filter() plus two arrow closures on every
  // frame of every fighter. Order is preserved, so draw order is unchanged.
   const tempVfx = fighter._tempVfx;
   if (tempVfx && tempVfx.length) {
     let w = 0;
     for (let i = 0; i < tempVfx.length; i++) {
       const v = tempVfx[i];
       v.age += dt;
       v.progress = v.age / v.lifetime;
       if (v.progress < 1) tempVfx[w++] = v;
     }
     tempVfx.length = w;
   }

  // The recovery trail is gone: a recovery paints nothing. The upward force,
  // the drift and the free-fall state below are unchanged.

  const p = fighter.playerNum;
  const radius = fighter.radius;

  // Directional Influence: bend a fresh launch toward the held bearing. Runs
  // before (and independently of) the combat lock below, which is exactly the
  // point — DI is the one trajectory input a launched fighter keeps.
  applyDI(fighter, dt, p, isHeld);

  // Aerial Light recovery assist — air steer. While the launch buff is live the
  // airborne fighter keeps a strong horizontal leash even though the attack lock
  // below normally freezes them mid-swing. This runs BEFORE the combat lock so
  // steering stays responsive through the whole aerialLight swing: hold toward
  // the stage to aim the drift, and the assist's boosted air accel makes that
  // drift feel deliberate rather than locked-straight.
  if (fighter.attack && fighter._aerialRecoveryTimer > 0 && !fighter.grounded && fighter.hitstun <= 0 && !fighter._hitLock && !(fighter._hitLockTimer > 0)) {
    const steerLeft = isHeld(p, 'left');
    const steerRight = isHeld(p, 'right');
    const targetSpeed = fighter.airSpeed * AERIAL_LIGHT_AIR_CONTROL * moveSpeedScale(fighter);
    const steerAccel = AIR_ACCEL * AERIAL_LIGHT_AIR_CONTROL * (fighter.airAccelMul || 1);
    if (steerLeft && !steerRight) {
      if (fighter.vx > -targetSpeed) {
        fighter.vx = Math.max(-targetSpeed, fighter.vx - steerAccel * dt);
      }
      fighter.facingRight = false;
    } else if (steerRight && !steerLeft) {
      if (fighter.vx < targetSpeed) {
        fighter.vx = Math.min(targetSpeed, fighter.vx + steerAccel * dt);
      }
      fighter.facingRight = true;
    }
  }

  // Combat lock: while committed to an attack, locked in a hit-confirm, held
  // by a shuriken hit-lock, or knocked into hitstun, the fighter cannot move,
  // jump, dodge, or act. (Shielding is refreshed by combatInput every frame,
  // so a blocker keeps reducing incoming hits.)
  if (fighter.attack || fighter.hitstun > 0 || fighter._hitLock || (fighter._hitLockTimer || 0) > 0) {
    fighter.wantsToDropThrough = false;
    return;
  }

  // Drop-through: set flag when pressing down while grounded on a drop-through
  // platform. Stage.js handles the actual collision skip and velocity.
  fighter.wantsToDropThrough = false;
  if (isHeld(p, 'down') && fighter.grounded && fighter.groundPlatform && fighter.groundPlatform.canDropThrough) {
    fighter.wantsToDropThrough = true;
    // Actually initiate drop-through: unset grounded, give downward velocity
    fighter.grounded = false;
    fighter.groundPlatform = null;
    fighter.groundType = null;
    fighter.vy = 80;
  }

  // === DODGE / DASH-DODGE (§23) ===
  // The dash is a real defensive option: a quick burst that moves the fighter
  // out of danger (escape pressure, dodge attacks/projectiles, create or
  // close distance, reposition). I-frames are SHORT and deliberate (first
  // ~0.15s of the burst) — never the whole dash — so it evades without making
  // the player invincible.
  // Depsey Roll buff record (boxer Down Heavy): longer, farther dodges
  // with more i-frames. Read here so the ability module never gets imported
  // back into movement code.
  const roll = fighter._boxerRoll && fighter._boxerRoll.timeLeft > 0 ? fighter._boxerRoll : null;
  const rollDash = roll ? (roll.dashMul || 1) : 1;
  const rollIframes = roll ? (roll.dodgeIframes || 0.15) : 0.15;
  const rollDodgeTime = roll ? (roll.dodgeTime || 0.25) : 0.25;

  if (isJustPressed(p, 'dodge') && fighter.dodgeCooldown <= 0) {
    if (fighter.grounded) {
      // Ground dash-dodge
      fighter.dodging = true;
      fighter.dodgeTimer = rollDodgeTime;
      fighter.dodgeCooldown = DODGE_COOLDOWN;
      const dir = fighter.facingRight ? 1 : -1;
      // Write into the record the fighter already owns (init at createFighter)
      // instead of allocating a new one. Three separate literals here gave the
      // property three different hidden classes, making every later
      // `dodgeDirection.x` read on a dodging fighter megamorphic.
      fighter.dodgeDirection.x = dir;
      fighter.dodgeDirection.y = 0;
      fighter.vx = dir * 360 * rollDash;
      fighter.invulnTimer = Math.max(fighter.invulnTimer, rollIframes);
      fighter._rollGhostTimer = 0;
    } else {
      // Air dodge (or wavedash if angled into ground)
      fighter.dodging = true;
      fighter.dodgeTimer = 0.3;
      fighter.dodgeCooldown = AIR_DODGE_COOLDOWN;
      const dx = (isHeld(p, 'right') ? 1 : 0) - (isHeld(p, 'left') ? 1 : 0);
      const dy = isHeld(p, 'down') ? 1 : (isHeld(p, 'jump') ? -1 : 0);
      if (dx === 0 && dy === 0) {
        fighter.dodgeDirection.x = fighter.facingRight ? 1 : -1;
        fighter.dodgeDirection.y = 0;
      } else {
        const len = Math.hypot(dx, dy) || 1;
        fighter.dodgeDirection.x = dx / len;
        fighter.dodgeDirection.y = dy / len;
      }
      // Wavedash: if angling down and near ground, convert to horizontal burst.
      // Indexed loop for the ground platform: the previous
      // `platforms.find(p2 => p2.isGround)` allocated a fresh arrow closure and
      // walked the array on every air-dodge attempt, including every whiffed one.
      let groundY = 0;
      const plats = stage && stage.platforms;
      if (plats) {
        for (let pi = 0; pi < plats.length; pi++) {
          if (plats[pi].isGround) { groundY = plats[pi].y || 0; break; }
        }
      }
      const isWavedash = dy > 0.5 && Math.abs(fighter.y - groundY + fighter.radius) < 50;
      if (isWavedash) {
        fighter.dodgeTimer = roll ? (roll.dodgeTime || 0.15) : 0.15;
        fighter.invulnTimer = Math.max(fighter.invulnTimer, roll ? (roll.dodgeIframes || 0.1) : 0.1);
        fighter.vx = fighter.dodgeDirection.x * 312 * rollDash;
        fighter.vy = 0;
        fighter.grounded = true; // snap to ground
        fighter.wavedashing = true;
      } else {
        fighter.dodgeTimer = roll ? (roll.dodgeTime || 0.3) : 0.3;
        fighter.vx = fighter.dodgeDirection.x * 300 * rollDash;
        fighter.vy = fighter.dodgeDirection.y * 300 * rollDash;
        fighter.invulnTimer = Math.max(fighter.invulnTimer, rollIframes);
      }
      fighter._rollGhostTimer = 0;
    }
  }

  // Dodge timer
  if (fighter.dodging) {
    fighter.dodgeTimer -= dt;
    // Depsey Roll afterimages: a ghost trail while a buffed dodge runs.
    if (roll) {
      fighter._rollGhostTimer = (fighter._rollGhostTimer || 0) - dt;
      if (fighter._rollGhostTimer <= 0) {
        fighter._rollGhostTimer = 0.04;
        try { emitGhost(fighter); } catch (_) {}
      }
    }
    if (fighter.dodgeTimer <= 0) {
      fighter.dodging = false;
      fighter.dodgeTimer = 0;
      if (fighter.wavedashing) {
        // Wavedash end: friction burst
        fighter.vx *= 0.6;
        fighter.wavedashing = false;
      } else {
        fighter.vx *= 0.3;
        fighter.vy *= 0.3;
      }
    }
    return; // no other input during dodge
  }

// Recovery moves: up-special (only when airborne and not in free-fall).
// Single application per press: snaps partway to the lift velocity for an
// immediate response, then ramps the rest over RECOVERY_RAMP_TIME (stepped in
// stepFighterPhysics); adds horizontal drift and enters free-fall (consumes
// further up-specials until landing). No VFX.
// Blocked during launch/tumble state (launchTimer > 0).
if (!fighter.grounded && !fighter.freeFall && fighter.launchTimer <= 0) {
  if (isJustPressed(p, 'special') && isHeld(p, 'up')) {
    // Apply recovery upward force (character recovery strength)
    const recoveryStrength = fighter.recoveryStrength || 1;
    const recoveryRange = fighter.recoveryRange || 1;
    const targetVy = -RECOVERY_UPWARD_FORCE * (fighter.recoveryMul || 1) * recoveryStrength;
    if (fighter.vy > targetVy * RECOVERY_RAMP_SNAP) fighter.vy = targetVy * RECOVERY_RAMP_SNAP;
    fighter._recoveryRamp = RECOVERY_RAMP_TIME;
    fighter._recoveryRampTarget = targetVy;
    const dx = (isHeld(p, 'right') ? 1 : 0) - (isHeld(p, 'left') ? 1 : 0);
    fighter.vx += dx * RECOVERY_HORIZONTAL_FORCE * recoveryRange;
    fighter.freeFall = true;
  }
}
  // === MOVEMENT ===
  const left = isHeld(p, 'left');
  const right = isHeld(p, 'right');
  const jumpHeld = isHeld(p, 'jump');
  const jumpJustPressed = isJustPressed(p, 'jump');
  const jumpJustReleased = isJustReleased(p, 'jump');
  const down = isHeld(p, 'down');

  // The Depsey Roll's boost, applied to BOTH the ground and the air targets —
  // a buff that only doubled the ground speed would read as "he slides around
  // faster", not as "he is faster".
  const speedScale = moveSpeedScale(fighter);

  // Horizontal movement
  if (fighter.grounded) {
    // Ground movement
    if (left && !right) {
      const targetVx = -fighter.runSpeed * speedScale;
      if (fighter.vx > targetVx) {
        fighter.vx = Math.max(targetVx, fighter.vx - GROUND_ACCEL * dt);
      } else {
        fighter.vx = targetVx;
      }
      fighter.facingRight = false;
    } else if (right && !left) {
      const targetVx = fighter.runSpeed * speedScale;
      if (fighter.vx < targetVx) {
        fighter.vx = Math.min(targetVx, fighter.vx + GROUND_ACCEL * dt);
      } else {
        fighter.vx = targetVx;
      }
      fighter.facingRight = true;
    }
  } else {
    // Air movement (character air-control authority via airAccelMul).
    const airAccel = AIR_ACCEL * (fighter.airAccelMul || 1);
    if (left && !right) {
      if (fighter.vx > -fighter.airSpeed * speedScale) {
        fighter.vx = Math.max(-fighter.airSpeed * speedScale, fighter.vx - airAccel * dt);
      }
      fighter.facingRight = false;
    } else if (right && !left) {
      if (fighter.vx < fighter.airSpeed * speedScale) {
        fighter.vx = Math.min(fighter.airSpeed * speedScale, fighter.vx + airAccel * dt);
      }
      fighter.facingRight = true;
    }
  }

  // === JUMP ===
  // Coyote time: allow jumping briefly after leaving ground
  const canCoyoteJump = fighter.coyoteTimer > 0 && !fighter.grounded && fighter.jumpsUsed === 0;
  const canBufferJump = fighter.jumpBufferTimer > 0 && fighter.grounded;

  if (jumpJustPressed && (fighter.grounded || canCoyoteJump)) {
    // Normal jump (with coyote time support)
    fighter.vy = down ? SHORTHOP_FORCE : -fighter.jumpForce;
    fighter.grounded = false;
    fighter.groundPlatform = null;
    fighter.canDoubleJump = true;
    fighter.jumpsUsed = 0;
    fighter.jumpPressed = true;
    fighter.fastFalling = false;
    fighter.coyoteTimer = 0;
    fighter.jumpBufferTimer = 0;
    // Reset aerial light recovery when jumping
    fighter.canUseAerialLightRecovery = true;
    // Subtle jump squash: horizontal squash, vertical stretch
    fighter.squishX = 0.88;
    fighter.squishY = 1.12;
    fighter.squishTimer = 0.18;
} else if (canBufferJump && jumpJustPressed) {
    // Buffer: jump pressed just before landing, execute on land
    fighter.vy = down ? SHORTHOP_FORCE : -fighter.jumpForce;
    fighter.grounded = false;
    fighter.groundPlatform = null;
    fighter.canDoubleJump = true;
    fighter.jumpsUsed = 0;
    fighter.jumpPressed = true;
    fighter.fastFalling = false;
    fighter.jumpBufferTimer = 0;
    fighter.squishX = 0.88;
    fighter.squishY = 1.12;
    fighter.squishTimer = 0.18;
    // Reset aerial light recovery when jumping (buffered)
    fighter.canUseAerialLightRecovery = true;
} else if (jumpJustPressed && fighter.canDoubleJump && fighter.jumpsUsed < 1 && !fighter.freeFall && fighter.launchTimer <= 0) {
    // Double jump (blocked during free-fall and launch/tumble state)
    fighter.vy = -fighter.doubleJumpForce;
    fighter.canDoubleJump = false;
    fighter.jumpsUsed++;
    fighter.jumpPressed = true;
    fighter.fastFalling = false;
    fighter.squishX = 0.90;
    fighter.squishY = 1.10;
    fighter.squishTimer = 0.15;
    // Allow direction change on double jump
    if (left && !right) fighter.facingRight = false;
    else if (right && !left) fighter.facingRight = true;
    // Subtle double-jump pop: a small ring + a few dust motes kicked
    // downward at the feet. Visual only — velocity and resources untouched.
    {
      const dr = fighter.radius || 22;
      const dstyle = fxStyleFor(fighter);
      emitImpactRing(fighter.x, fighter.y + dr * 0.5, {
        style: dstyle, radius: dr * 0.4, growth: dr * 1.4,
        life: 0.22, alpha: 0.5,
      });
      emitDustPuff(fighter.x, fighter.y + dr * 0.6, 3, {
        style: dstyle, spread: Math.PI * 0.9, dir: Math.PI / 2, speed: 120,
        size: dr * 0.12, life: 0.28, gravity: 160, alpha: 0.4,
      });
    }
}

  // Variable jump height: cut velocity when releasing jump early
  if (jumpJustReleased && fighter.vy < 0 && fighter.jumpPressed) {
    fighter.vy *= JUMP_CUT_MULTIPLIER;
    fighter.jumpPressed = false;
  }

  // Fast fall
  if (down && !fighter.grounded && fighter.vy > 0 && !fighter.fastFalling && !fighter.dropThroughPlatform) {
    fighter.fastFalling = true;
  }
  if (fighter.grounded) {
    fighter.fastFalling = false;
  }

  // Face direction from movement
  if (left && !right) fighter.facingRight = false;
  else if (right && !left) fighter.facingRight = true;
}


// ── merged from stage/sandbox/destructible.js ──
// destructible.js â€” breakable world objects for the Sandbox arena.
//
// A destructible IS a platform record. It has the exact shape Stage.js draws,
// bobs and resolves collisions against, plus a few extra fields (kindId, hp,
// destructible). That is deliberate: a breakable board has to be standable and
// block from below using the REAL platform collision, so making it a platform is
// what keeps this out of the business of writing a second collision system. What
// this module adds is only what a platform record does not have:
//
//   â€¢ durability (hp / maxHp) and damage intake
//   â€¢ registration, so the existing hitbox and projectile passes in combat.js
//     can find it and feed it the same damage numbers those moves deal
//   â€¢ a cheap break effect, and self-cleanup once hp reaches zero
//
// Isolation is the point of the design. A destructible only ever CONSUMES
// durability: it never receives knockback, hitstun, a hit lock, a damage number
// or a fighter flag, so it cannot change a player's percent, momentum, combo
// state or hitbox. Fighters fight each other exactly as they do on the main
// stage; the boards just happen to be in the way. The registry is empty outside
// the sandbox, so the main match pays nothing â€” combat.js' two new passes bail
// on a null list before touching a single fighter.


// â”€â”€ Kinds â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Adding a breakable object to the sandbox is adding an entry here: its
// durability, how hard the game's real damage numbers bite into it, its
// silhouette and its art. Nothing downstream special-cases a kind.
export const DESTRUCTIBLE_KINDS = [
  {
    id: 'board',
    name: 'WOOD BOARD',
    w: 180, h: 24, hp: 100, damageScale: 6.5, minDamage: 2.0,
    color: '#8a6a3f', edge: '#3a2a14', plank: '#a8834f', grain: '#5c4324',
  },
  {
    id: 'crate',
    name: 'CRATE',
    w: 76, h: 76, hp: 70, damageScale: 5.0, minDamage: 1.5,
    color: '#7a5a34', edge: '#33240f', plank: '#96703f', grain: '#4e3719',
  },
  {
    id: 'barrel',
    name: 'BARREL',
    w: 64, h: 84, hp: 55, damageScale: 4.5, minDamage: 1.5,
    color: '#5d5f4a', edge: '#26281a', plank: '#767960', grain: '#3a3c2b',
  },
  {
    id: 'glass',
    name: 'GLASS BLOCK',
    w: 70, h: 70, hp: 26, damageScale: 3.2, minDamage: 1.0,
    color: '#4a6d78', edge: '#1b2c33', plank: '#6f97a4', grain: '#33505a',
  },
];

const KIND_BY_ID = {};
for (const k of DESTRUCTIBLE_KINDS) KIND_BY_ID[k.id] = k;

export function destructibleKind(kindId) {
  return KIND_BY_ID[kindId] || KIND_BY_ID.board;
}

// â”€â”€ Registry â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// One flat array, swapped by index (never filter/splice-rebuild) so a removal
// allocates nothing. combat.js reads this list once per pass.
let _destructibles = [];

// Break-effect pool. Plain rectangles falling out of the broken object's
// footprint: no particles, no gradients, no per-frame allocation. Capped, and
// the oldest shard is dropped rather than growing the pool.
const _breakFx = [];
const BREAK_FX_PER_BOARD = 8;
const BREAK_FX_MAX = 96;

let _nextId = 1;

export function createDestructible(kindId, opts) {
  const kind = destructibleKind(kindId);
  const width = opts.width ?? kind.w;
  const height = opts.height ?? kind.h;
  return {
    id: opts.id || `d${_nextId++}`,
    // Platform fields (Stage.js drawStage skips destructible:true, which is what
    // lets this module own their art, and resolvePlatformCollision treats them
    // as solid, exactly like the main ground).
    x: opts.x || 0,
    y: opts.y || 0,
    baseY: opts.y || 0,
    width,
    height,
    isGround: false,
    canDropThrough: opts.canDropThrough ?? false,
    color: kind.color,
    // Destructible fields
    destructible: true,
    kindId: kind.id,
    hp: opts.hp ?? kind.hp,
    maxHp: opts.hp ?? kind.hp,
    stage: null,      // the stage this board is currently placed in
    dead: false,
    _flash: 0,        // white hit flash, aged by stepDestructibles
    _kind: kind,      // cached so the break effect can reuse the palette
    _gradient: null,
  };
}

export function registerDestructible(d) {
  if (!d || d.dead) return;
  if (_destructibles.indexOf(d) === -1) _destructibles.push(d);
}

export function unregisterDestructible(d) {
  const i = _destructibles.indexOf(d);
  if (i !== -1) { _destructibles[i] = _destructibles[_destructibles.length - 1]; _destructibles.pop(); }
  if (d && d.stage) removeFromStage(d);
}

export function clearDestructibles() {
  _destructibles.length = 0;
  _breakFx.length = 0;
}

export function destructibleCount() {
  return _destructibles.length;
}

// The hot-path accessor combat.js calls: the live list, or null when there is
// nothing to hit. A null check is the whole cost of this feature on a stage
// with no breakables in it.
export function destructibleList() {
  return _destructibles.length ? _destructibles : null;
}

// â”€â”€ Damage â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// The only way durability is lost. amount is already scaled by the kind's
// damageScale by the caller, which is also what feeds the hit flash.
export function damageDestructible(d, amount, hx, hy) {
  if (!d || d.dead || amount <= 0) return false;
  d.hp -= amount;
  d._flash = 0.1;
  if (d.hp <= 0) {
    d.hp = 0;
    d.dead = true;
    breakDestructible(d);
    return true;
  }
  // A small, non-blocking puff: the board reacting, not a full hit VFX, and
  // deliberately NOT spawnTempVfx (that pool belongs to fighters and is aged
  // by their own input handler).
  spawnBreakFx(d, hx, hy, 2);
  return false;
}

function breakDestructible(d) {
  spawnBreakFx(d, d.x + d.width / 2, d.y + d.height / 2, BREAK_FX_PER_BOARD);
  // Drop it out of the stage it was placed in: once hp is gone the board stops
  // being a platform, so the collision that stood a fighter on top of it is
  // gone with it (the fighter simply falls).
  unregisterDestructible(d);
  d.dead = true;
  SFX.grabImpact();
}

function spawnBreakFx(d, ox, oy, count) {
  const cx = ox !== undefined ? ox : d.x + d.width / 2;
  const cy = oy !== undefined ? oy : d.y + d.height / 2;
  for (let i = 0; i < count; i++) {
    if (_breakFx.length >= BREAK_FX_MAX) _breakFx.shift();
    const size = 4 + Math.random() * 7;
    _breakFx.push({
      x: d.x + Math.random() * d.width,
      y: d.y + Math.random() * d.height,
      vx: (cx - (d.x + d.width / 2)) * 0.9 + (Math.random() * 2 - 1) * 130,
      vy: -90 - Math.random() * 170,
      size,
      life: 0.45 + Math.random() * 0.35,
      maxLife: 0.8,
      color: Math.random() < 0.5 ? d.color : (d._kind ? d._kind.plank : '#8a6a3f'),
    });
  }
}

// â”€â”€ Per-frame step â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Ages the hit flash, sweeps broken boards out of their stage, and integrates
// the shard pool. Compaction is in place â€” no filter, no allocation.
export function stepDestructibles(dt) {
  if (!_destructibles.length && !_breakFx.length) return;

  for (let i = 0; i < _destructibles.length; i++) {
    const d = _destructibles[i];
    if (d.dead) {
      unregisterDestructible(d);
      i--;
      continue;
    }
    if (d._flash > 0) d._flash = Math.max(0, d._flash - dt);
  }

  let w = 0;
  for (let i = 0; i < _breakFx.length; i++) {
    const p = _breakFx[i];
    p.life -= dt;
    if (p.life <= 0) continue;
    p.vy += 900 * dt;
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    _breakFx[w++] = p;
  }
  _breakFx.length = w;
}

function removeFromStage(d) {
  const plats = d.stage && d.stage.platforms;
  if (!plats) return;
  const i = plats.indexOf(d);
  if (i !== -1) { plats[i] = plats[plats.length - 1]; plats.pop(); }
  d.stage = null;
}

// â”€â”€ Render â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Cached damage-flash overlay strings, alpha quantized to 16 steps. The old
// inline template built a value essentially unique to every board on every
// frame (the flash decays continuously), so it allocated a string and forced a
// full CSS colour re-parse per damaged board per frame.
const _flashOverlay = new Array(16);
for (let i = 0; i < 16; i++) _flashOverlay[i] = `rgba(255,255,255,${((i / 15) * 0.45).toFixed(3)})`;

// View-culling bounds for this pass. Destructibles are the only world-space
// draw pass that had none, so a board wall spanning the arena paid its full
// ~7 draw ops per board every frame no matter where the camera pointed. Fed
// the same rect the stage/fighter/VFX passes already receive; until bounds
// are published culling stays off, which is correct for the sandbox editor's
// own camera.
let _dvx0 = 0, _dvy0 = 0, _dvx1 = 0, _dvy1 = 0, _dvCull = false;
export function setDestructibleViewBounds(x0, y0, x1, y1) {
  if (x1 < x0) { const t = x0; x0 = x1; x1 = t; }
  if (y1 < y0) { const t = y0; y0 = y1; y1 = t; }
  _dvx0 = x0; _dvy0 = y0; _dvx1 = x1; _dvy1 = y1;
  _dvCull = true;
}
export function clearDestructibleViewBounds() { _dvCull = false; }

// ── Render ───────────────────────────────────────────────────────────────
// Solid fills and straight lines only. The gradient is built once per board and
// cached on the record (the same trick Stage.js uses for its platform gradient).
export function drawDestructibles(ctx) {
  const list = _destructibles;
  // A small margin so a board straddling the edge still draws its seams.
  const pad = 8;
  for (let i = 0; i < list.length; i++) {
    const d = list[i];
    if (d.dead) continue;
    const h = d.height;
    const w = d.width;
    if (_dvCull
      && (d.x + w < _dvx0 - pad || d.x > _dvx1 + pad
        || d.y + h < _dvy0 - pad || d.y > _dvy1 + pad)) continue;
    const kind = d._kind || (d._kind = destructibleKind(d.kindId));

    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.fillRect(d.x + 4, d.y + 4, w, h);

    if (!d._gradient) {
      const g = ctx.createLinearGradient(d.x, d.baseY, d.x, d.baseY + h);
      g.addColorStop(0, kind.plank);
      g.addColorStop(1, kind.color);
      d._gradient = g;
    }
    ctx.fillStyle = d._gradient;
    ctx.fillRect(d.x, d.y, w, h);

    // Plank seams / panel lines â€” the only texture a board gets.
    ctx.strokeStyle = kind.grain;
    ctx.lineWidth = 1;
    ctx.beginPath();
    if (kind.id === 'barrel' || kind.id === 'glass') {
      // Rounds read as bands; the glass block gets a frame instead.
      if (kind.id === 'barrel') {
        ctx.moveTo(d.x, d.y + h * 0.3);
        ctx.lineTo(d.x + w, d.y + h * 0.3);
        ctx.moveTo(d.x, d.y + h * 0.7);
        ctx.lineTo(d.x + w, d.y + h * 0.7);
      } else {
        ctx.moveTo(d.x + 5, d.y + 5);
        ctx.lineTo(d.x + w - 5, d.y + 5);
        ctx.lineTo(d.x + w - 5, d.y + h - 5);
        ctx.lineTo(d.x + 5, d.y + h - 5);
        ctx.closePath();
      }
    } else {
      const seams = kind.id === 'crate' ? 2 : 4;
      for (let s = 1; s <= seams; s++) {
        const px = d.x + (w / (seams + 1)) * s;
        ctx.moveTo(px, d.y);
        ctx.lineTo(px, d.y + h);
      }
    }
    ctx.stroke();

    ctx.strokeStyle = kind.edge;
    ctx.lineWidth = 2;
    ctx.strokeRect(d.x + 1, d.y + 1, w - 2, h - 2);

    // Damage read: cracks creep in as durability drops, so a board tells you
    // how close it is without needing a number.
    const wear = 1 - d.hp / d.maxHp;
    if (wear > 0.25) {
      ctx.strokeStyle = kind.grain;
      ctx.lineWidth = 1 + wear;
      ctx.beginPath();
      const cracks = Math.ceil(wear * 4);
      for (let c = 0; c < cracks; c++) {
        const cx = d.x + ((c + 1) / (cracks + 1)) * w;
        ctx.moveTo(cx, d.y);
        ctx.lineTo(cx + (c % 2 ? 4 : -4), d.y + h * 0.5);
        ctx.lineTo(cx, d.y + h);
      }
      ctx.stroke();
    }

    if (d._flash > 0) {
      // Cached flash overlay strings. `_flash` decays continuously from 0.1, so
      // the old inline template produced a value essentially unique to every
      // board on every frame — a fresh string plus a full CSS colour re-parse
      // per damaged board per frame. 16 steps is indistinguishable.
      const fq = ((d._flash / 0.1) * 15) | 0;
      ctx.fillStyle = _flashOverlay[fq < 0 ? 0 : (fq > 15 ? 15 : fq)];
      ctx.fillRect(d.x, d.y, w, h);
    }
  }

  for (let i = 0; i < _breakFx.length; i++) {
    const p = _breakFx[i];
    const a = Math.min(1, p.life / p.maxLife);
    ctx.fillStyle = p.color;
    ctx.globalAlpha = a;
    ctx.fillRect(p.x, p.y, p.size, p.size);
  }
  if (_breakFx.length) ctx.globalAlpha = 1;
}

// Durability readout, drawn only while a board is selected in the editor (the
// play session shows it on the hovered board instead â€” see SandboxEditor/Session).
export function drawDestructibleHp(ctx, d) {
  const barW = Math.max(24, d.width);
  const barH = 4;
  const barY = d.y - 9;
  ctx.fillStyle = 'rgba(0,0,0,0.6)';
  ctx.fillRect(d.x, barY, barW, barH);
  const frac = Math.max(0, Math.min(1, d.hp / d.maxHp));
  ctx.fillStyle = frac > 0.5 ? '#8fd46a' : frac > 0.2 ? '#e8c25a' : '#e0664a';
  ctx.fillRect(d.x, barY, barW * frac, barH);
}


// ── merged from stage/Stage.js ──
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
export const BLAST_MARGIN = 0; // the death box IS the arena edge — any hurtbox
// touch past it KOs immediately, no grace zone

// ── Customizable death zone (menu-owned persistence, physics-owned math) ──
// Margins are extra pixels BEYOND each arena edge. 0 preserves the historical
// behavior exactly (death box == arena edge). Positive pushes the KO line
// outward (more forgiving), negative pulls it inward (less forgiving, can
// overlap the playable arena if the player insists).
export const DEFAULT_DEATH_MARGINS = { left: 0, right: 0, top: 0, bottom: 0 };
export const DEATHZONE_MIN = -2000; // inward: may overlap deep into (or past) the arena (allowed, validated)
export const DEATHZONE_MAX = 6000;  // outward: very forgiving, still bounded so the preview/camera stay sane
export const DEATHZONE_STEP = 20;

export function sanitizeDeathZone(raw) {
  const out = { ...DEFAULT_DEATH_MARGINS };
  if (!raw || typeof raw !== 'object') return out;
  for (const k of ['left', 'right', 'top', 'bottom']) {
    const v = Number(raw[k]);
    if (!Number.isFinite(v)) continue;
    out[k] = Math.max(DEATHZONE_MIN, Math.min(DEATHZONE_MAX, Math.round(v)));
  }
  return out;
}

// Absolute blast rect for a W×H arena with the given margins. Clamped so the
// box can never invert (left < right, top < bottom always hold).
export function blastRectFor(width, height, margins) {
  const m = sanitizeDeathZone(margins);
  const W = Number.isFinite(width) && width > 0 ? width : 1080;
  const H = Number.isFinite(height) && height > 0 ? height : 1080;
  const left = Math.min(-m.left, W - 40);
  const right = Math.max(W + m.right, 40);
  const top = Math.min(-m.top, H - 40);
  const bottom = Math.max(H + m.bottom, 40);
  return {
    left: Math.min(left, right - 20),
    right: Math.max(right, left + 20),
    top: Math.min(top, bottom - 20),
    bottom: Math.max(bottom, top + 20),
  };
}

// Apply custom margins onto a live stage in place. Safe point: match start,
// menu edit, or any frame the match is not deciding a KO.
export function applyDeathZoneToStage(stage, margins, width, height) {
  if (!stage) return null;
  try {
    const W = Number.isFinite(width) && width > 0 ? width
      : (Number.isFinite(stage._arenaW) && stage._arenaW > 0 ? stage._arenaW : 1080);
    const H = Number.isFinite(height) && height > 0 ? height
      : (Number.isFinite(stage._arenaH) && stage._arenaH > 0 ? stage._arenaH : 1080);
    stage.blastZones = blastRectFor(W, H, margins);
    stage._arenaW = W;
    stage._arenaH = H;
  } catch (_) {}
  return stage;
}

// Only the Sandbox section below touches destructibles, but the import is hoisted
// with the rest of the module graph. The chain is one-way and acyclic:
// Stage.js -> physics.js -> Engine.js -> worldFx.js.


export function createDefaultStage(canvasWidth, canvasHeight, deathMargins) {
  const groundY = canvasHeight * 0.78;
  const groundWidth = canvasWidth * 0.65;
  const groundX = (canvasWidth - groundWidth) / 2;
  const platformWidth = canvasWidth * 0.14;
  const platformHeight = 12;
  const platY1 = groundY - 140;

  return {
    name: 'Battlefield',
    _arenaW: canvasWidth,
    _arenaH: canvasHeight,
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
    blastZones: blastRectFor(canvasWidth, canvasHeight, deathMargins),
    respawnPoint: { x: canvasWidth / 2, y: groundY - 120 },
    spawnPoints: [
      { x: canvasWidth * 0.35, y: groundY },
      { x: canvasWidth * 0.65, y: groundY },
    ],
  };
}

// Animate floating platforms with gentle bobbing
export function updatePlatforms(stage, time) {
  // Indexed loop: the for-of allocated an array iterator on every frame.
  const plats = stage.platforms;
  for (let i = 0; i < plats.length; i++) {
    const plat = plats[i];
    if (plat.bobSpeed) {
      plat.y = plat.baseY + Math.sin(time * 0.001 * plat.bobSpeed + plat.bobPhase) * plat.bobAmp;
    }
  }
  // Cached ground-platform top edge, refreshed here because this function
  // already walks the whole list every frame. Consumers (the wavedash check in
  // Fighter.js, edge safety in the AI) used to re-find the ground platform with
  // their own scan — and Fighter's allocated a closure for it.
  stage._groundY = null;
  for (let i = 0; i < plats.length; i++) {
    if (plats[i].isGround) { stage._groundY = plats[i].y; break; }
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
        // Landing cancels launch/tumble state (Smash-style)
        fighter.launchTimer = 0;
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
        // Landing cancels launch/tumble state (Smash-style)
        fighter.launchTimer = 0;
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
// Rounded-top platform outline, built once per platform size in LOCAL space
// (origin at the platform's top-left) and cached on the record.
//
// The body and the drop shadow are the same shape — the shadow is the body
// offset by (+4, +4) — so one cached path serves both. Previously each was
// rebuilt from scratch with 7 path ops per platform per frame, which in a
// sandbox arena with 40 platforms is ~1700 path operations a frame for
// rectangles that move by a 3px bob.
//
// NOTE: only the TOP two corners are rounded (that is the existing look), so
// ctx.roundRect() is deliberately not used here — it would round all four.
// The highlight line is a straight 2-point path, cheap enough to leave inline.
const _PLAT_R = 6;
const _hasPath2D = typeof Path2D === 'function';
function platPath(plat) {
  const w = plat.width, h = plat.height;
  let p = plat._path;
  if (p && plat._pathW === w && plat._pathH === h) return p;
  if (!_hasPath2D) return null;
  const r = Math.min(_PLAT_R, w / 2, h / 2);
  p = new Path2D();
  p.moveTo(r, 0);
  p.lineTo(w - r, 0);
  p.quadraticCurveTo(w, 0, w, r);
  p.lineTo(w, h);
  p.lineTo(0, h);
  p.lineTo(0, r);
  p.quadraticCurveTo(0, 0, r, 0);
  p.closePath();
  plat._path = p;
  plat._pathW = w;
  plat._pathH = h;
  return p;
}

// Inline fallback: the original per-frame path, used only where Path2D is
// unavailable. Identical geometry.
function platPathInline(ctx, x, y, w, h) {
  const r = Math.min(_PLAT_R, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h);
  ctx.lineTo(x, y + h);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

export function drawStage(ctx, stage, time, platformColorOverride = null, view = null) {
  const hasView = !!(view && Number.isFinite(view.x0));
  const plats = stage.platforms;
  for (let pi = 0; pi < plats.length; pi++) {
    const plat = plats[pi];
    // Breakables live in the same platform list (that is what makes them
    // standable and collidable through the real system), but they have their
    // own art in physics.js — cracks, a durability read, a break
    // effect. Skipping them here keeps one painter per object.
    if (plat.destructible) continue;
    if (hasView) {
      if (plat.x > view.x1 || plat.x + plat.width < view.x0 ||
          plat.y > view.y1 || plat.y + plat.height < view.y0) continue;
    }
    const pth = platPath(plat);
    const pw = plat.width, ph = plat.height;

    // Platform shadow. Fill-only, so no strokeStyle/lineWidth here (the body
    // pass below sets the stroke state it needs itself).
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    if (pth) {
      ctx.save();
      ctx.translate(plat.x + 4, plat.y + 4);
      ctx.fill(pth);
      ctx.restore();
    } else {
      platPathInline(ctx, plat.x + 4, plat.y + 4, pw, ph);
      ctx.fill();
    }

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
    if (pth) {
      ctx.save();
      ctx.translate(plat.x, plat.y);
      ctx.fill(pth);
      ctx.strokeStyle = '#111111';
      ctx.lineWidth = 3;
      ctx.stroke(pth);
      ctx.restore();
    } else {
      platPathInline(ctx, plat.x, plat.y, pw, ph);
      ctx.fill();
      ctx.strokeStyle = '#111111';
      ctx.lineWidth = 3;
      ctx.stroke();
    }

    // Platform top highlight
    const r = Math.min(_PLAT_R, pw / 2, ph / 2);
    ctx.strokeStyle = 'rgba(243,234,209,0.45)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(plat.x + r + 2, plat.y + 2);
    ctx.lineTo(plat.x + pw - r - 2, plat.y + 2);
    ctx.stroke();
  }
}

// Check if a fighter is outside the blast zones
// Uses the fighter's hurtbox (center + radius) for more accurate detection,
// preventing false KOs from visual offsets or sprite transparency.
export function isInBlastZone(fighter, stage) {
  const bz = stage.blastZones;
  const radius = fighter.radius || 32; // Default fallback radius
  // Check if the fighter's hurtbox crosses the blast zone boundary
  if (fighter.x - radius < bz.left) return 'left';
  if (fighter.x + radius > bz.right) return 'right';
  if (fighter.y + radius > bz.bottom) return 'bottom';
  if (fighter.y - radius < bz.top) return 'top';
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
    return { ...defaultSandboxEnv(1080, 1080), ...parsed };
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
// authored arena is fully playable; a plain 1080×1080 arena gets the same
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
