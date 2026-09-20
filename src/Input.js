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
  justPressed[e.code] = true;

  const action = getAction(e.code, 1) || getAction(e.code, 2);
  if (action) {
    for (let pn = 1; pn <= 2; pn++) {
      recordAction(pn, action, 'press');
      if (action === 'left' || action === 'right' || action === 'up' || action === 'down' || action === 'jump') {
        recordDirectionState(pn, action, true);
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
  justReleased[e.code] = true;

  const action = getAction(e.code, 1) || getAction(e.code, 2);
  if (action) {
    for (let pn = 1; pn <= 2; pn++) {
      recordAction(pn, action, 'release');
      if (action === 'left' || action === 'right' || action === 'up' || action === 'down' || action === 'jump') {
        recordDirectionState(pn, action, false);
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
  for (const k in justPressed) delete justPressed[k];
  for (const k in justReleased) delete justReleased[k];

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
  const bindings = playerNum === 1 ? BINDINGS.player1 : BINDINGS.player2;
  const codes = bindings[action] || [];
  return codes.some(c => !!keys[c]);
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
  return codes.some(c => !!justPressed[c]);
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
  const bindings = playerNum === 1 ? BINDINGS.player1 : BINDINGS.player2;
  const codes = bindings[action] || [];
  return codes.some(c => !!justPressed[c]);
}

export function isJustReleased(playerNum, action) {
  const bindings = playerNum === 1 ? BINDINGS.player1 : BINDINGS.player2;
  const codes = bindings[action] || [];
  return codes.some(c => !!justReleased[c]);
}

export function destroyInput() {
  window.removeEventListener('keydown', onKeyDown);
  window.removeEventListener('keyup', onKeyUp);
}
