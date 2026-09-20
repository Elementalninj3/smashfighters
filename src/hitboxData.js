// ── Per-character, per-move hitbox store ─────────────────────────────────
// The Hitbox Customizer's source of truth. Stored keyed by character → move,
// so `Cowboy → Dash` never touches `Cowboy → Neutral Light` or any other
// character's Dash. combat.resolveAnimDef reads this at every attack start
// (via getCustomHitboxes) so a saved box overrides the DEFAULT_ATTACKS
// fallback in the real game — there is no separate preview-only database.
//
// A move whose key is PRESENT in the store owns its hitbox data completely,
// even when the stored list is empty ([] = "this move deliberately has no
// hitbox"). A move with NO entry falls through to the base/default def.
//
// The hitbox shape is the same canonical object the animation combat data
// uses: { w, h, ox, oy, startFrame, duration, dmg, kbBase, kbGrowth, angle }.
// `ox`/`oy` are offsets from the fighter center and mirror with facing.

export const HITBOX_STORE_KEY = 'smashfighters.hitboxes.v1';

let _store = null; // { [charId]: { [moveKey]: [hitbox, ...] } }

function loadStore() {
  if (_store) return _store;
  _store = {};
  try {
    const raw = localStorage.getItem(HITBOX_STORE_KEY);
    if (!raw) return _store;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') _store = parsed;
  } catch (_) {}
  return _store;
}

function saveStore() {
  try { localStorage.setItem(HITBOX_STORE_KEY, JSON.stringify(_store)); } catch (_) {}
}

function moveKey(animId) {
  return String(animId || '').trim();
}

// Live editable array for the entry (creates it when absent). Returns the
// actual stored array — the customizer edits it in place then calls
// saveHitboxEntry to persist.
function entryFor(charId, animId) {
  if (!charId || !animId) return null;
  const s = loadStore();
  if (!s[charId]) s[charId] = {};
  if (!Array.isArray(s[charId][animId])) s[charId][animId] = [];
  return s[charId][animId];
}

// A saved copy of the hitboxes for this character+move, or null when the move
// has no custom entry at all. Ruturn a copy so the caller can never mutate
// the persisted store by accident.
export function getCustomHitboxes(charId, animId) {
  const mk = moveKey(animId);
  if (!charId || !mk) return null;
  const s = loadStore();
  const byMove = s[charId];
  if (!byMove || !(mk in byMove)) return null;
  return JSON.parse(JSON.stringify(byMove[mk]));
}

// True when this character+move has its own custom entry (even an empty one).
export function hasCustomHitboxes(charId, animId) {
  const mk = moveKey(animId);
  if (!charId || !mk) return false;
  const s = loadStore();
  return !!(s[charId] && (mk in s[charId]));
}

// Persist hitboxes for one character+move. `hbs` may be [] to mean "this move
// has no hitbox". Idempotent — repeated saves lay over the same key.
export function setCustomHitboxes(charId, animId, hbs) {
  const mk = moveKey(animId);
  if (!charId || !mk) return;
  const arr = entryFor(charId, mk);
  arr.length = 0;
  for (const hb of (hbs || [])) {
    arr.push(hb == null ? null : { ...hb });
  }
  saveStore();
}

// Forget one move's custom entry (back to the default/fallback hitbox).
export function clearCustomHitboxes(charId, animId) {
  const mk = moveKey(animId);
  if (!charId || !mk) return;
  const s = loadStore();
  if (s[charId] && (mk in s[charId])) {
    delete s[charId][mk];
    saveStore();
  }
}

// Forget everything a character saved (keeps other characters' data).
export function clearCharacterHitboxes(charId) {
  const s = loadStore();
  if (s[charId]) {
    delete s[charId];
    saveStore();
  }
}

// Whole-store reset (used by the test harness / a future "reset all" button).
export function resetHitboxStore() {
  _store = {};
  try { localStorage.removeItem(HITBOX_STORE_KEY); } catch (_) {}
}

export function hitboxStoreToJSON() {
  return JSON.stringify(loadStore());
}

// Import a whole store snapshot (test harness / backup restore).
export function importHitboxStore(json) {
  try {
    const parsed = JSON.parse(json);
    if (parsed && typeof parsed === 'object') {
      _store = parsed;
      saveStore();
      return true;
    }
  } catch (_) {}
  return false;
}