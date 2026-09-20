// Engine.js — everything non-content: event bus, verse registry, random
// selection, game loop, state machine, plus thin infrastructure exports.
// ALL VFX SYSTEMS ARE SCRAPPED: particles, impact rings, glass shards,
// screen flash, screen shake and orbiter groups are no-ops. The export
// names remain only so existing callers don't break — nothing they do can
// produce anything visible.

// ── Event bus ────────────────────────────────────────────────────────────
function createEventBus() {
  const handlers = new Map();
  return {
    on(event, handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    off(event, handler) {
      const list = handlers.get(event);
      if (!list) return;
      const i = list.indexOf(handler);
      if (i !== -1) list.splice(i, 1);
    },
    emit(event, payload) {
      (handlers.get(event) ?? []).forEach(h => h(payload));
    },
  };
}
export const eventBus = createEventBus();

// ── Global damage-threat registry ─────────────────────────────────────────
const damageThreats = [];
let nextThreatId = 1;

export function registerDamageThreat(threat) {
  if (!threat || threat.__threatId) return threat;
  threat.__threatId = nextThreatId++;
  damageThreats.push(threat);
  return threat;
}

export function unregisterDamageThreat(threat) {
  if (!threat) return;
  const i = damageThreats.indexOf(threat);
  if (i !== -1) damageThreats.splice(i, 1);
  threat.__threatId = null;
}

export function getDamageThreats() {
  return damageThreats;
}

// ── Arena bounds (set from Game.js) ───────────────────────────────────────
export let arena = { x: 0, y: 0, width: 400, height: 250 };

export function setArena(newArena) {
  arena.x = newArena.x;
  arena.y = newArena.y;
  arena.width = newArena.width;
  arena.height = newArena.height;
}

// ── Verse registry ───────────────────────────────────────────────────────
const registeredVerses = [];

export function registerVerse(verseModule) {
  registeredVerses.push(verseModule);
}

export function getAllVerses() {
  return registeredVerses;
}

// ── Random selection ──────────────────────────────────────────────────────
export function pickRandom(pool) {
  if (pool.length === 0) throw new Error('Cannot pick from empty pool');
  const totalWeight = pool.reduce((sum, item) => sum + (item.weight ?? 1), 0);
  let roll = Math.random() * totalWeight;
  for (const item of pool) {
    roll -= item.weight ?? 1;
    if (roll <= 0) return item;
  }
  return pool[pool.length - 1];
}

export function assignRandomCharacter(rig = null) {
  let verse;
  if (rig?.isRigged && rig.verseId) {
    verse = registeredVerses.find(v => v.id === rig.verseId);
    if (!verse) {
      console.warn(`assignRandomCharacter: no verse with id "${rig.verseId}" — falling back to random.`);
      verse = pickRandom(registeredVerses);
    }
  } else {
    verse = pickRandom(registeredVerses);
  }

  let character;
  if (rig?.isRigged && rig.characterId) {
    character = verse.characters.find(c => c.id === rig.characterId);
    if (!character) {
      console.warn(`assignRandomCharacter: no character "${rig.characterId}" in verse "${verse.id}" — randomizing within that verse instead.`);
      character = pickRandom(verse.characters);
    }
  } else {
    character = pickRandom(verse.characters);
  }

  return { verse, character };
}

// ── Game loop ────────────────────────────────────────────────────────────
export function startGameLoop(update, render) {
  let last = performance.now();
  let rafId = null;
  function frame(now) {
    const dt = Math.min((now - last) / 1000, 1 / 30); // clamp dt on tab-switch/hitch
    last = now;
    update(dt, now);
    render(now);
    rafId = requestAnimationFrame(frame);
  }
  rafId = requestAnimationFrame(frame);
  return () => cancelAnimationFrame(rafId); // returns a stop function
}

// ── State machine (menu / reveal / battle / gameover) ───────────────────
export function createStateMachine(initial) {
  let current = initial;
  const listeners = [];
  return {
    get() { return current; },
    to(next) {
      current = next;
      listeners.forEach(fn => fn(next));
    },
    onChange(fn) { listeners.push(fn); },
  };
}

// ── Physics / gauges / HP / abilities ────────────────────────────────────
// The combat mechanics module (Mechanics.js) has been removed in the sandbox
// edition. Engine.js keeps only its core: the game loop, arena bounds, camera,
// event bus, SFX, and the fighter roster registry (used by the match flow).

// ── VFX — SCRAPPED ───────────────────────────────────────────────────────
// These are deliberate no-ops. Nothing particle/ring/shard/orbiter/flash/shake
// related exists anymore; the names survive so existing callers keep working.

export function spawnParticles() {}
export function spawnImpactRing() {}
export function spawnGlassShatter() {}
export function flashScreen() {}
export function shakeCamera() {}

// Persistent orbiter groups — scrapped. Stubs only.
export function createOrbiterGroup(id) {
  return { id, x: 0, y: 0, scale: 1, particles: [], ringAngle1: 0, ringAngle2: 0, ringRadius1: 26, ringRadius2: 34 };
}
export function updateOrbiterGroup() {}
export function removeOrbiterGroup() {}

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

// ── Camera zoom ──────────────────────────────────────────────────────────
let zoomCurrent = 1;
let zoomTarget = 1;
let zoomElapsed = 0;
let zoomDuration = 0;

export function zoomCamera(targetScale = 1.5, duration = 0.3, fromCurrent = false) {
  if (!fromCurrent) zoomCurrent = 1;
  zoomTarget = targetScale;
  zoomElapsed = 0;
  zoomDuration = duration;
}

export function resetCameraZoom() {
  zoomTarget = 1;
  zoomDuration = 0;
}

export function updateCameraZoom(dt) {
  if (zoomDuration > 0) {
    zoomElapsed += dt;
    const t = Math.min(zoomElapsed / zoomDuration, 1);
    zoomCurrent = 1 + (zoomTarget - 1) * t;
    if (t >= 1) zoomDuration = 0;
  } else {
    zoomCurrent += (1 - zoomCurrent) * 0.08;
  }
}

export function getCameraZoom() {
  return zoomCurrent;
}

// ── Dynamic following camera (former Camera.js) ──────────────────────────
// Always keeps both fighters centered on screen with appropriate zoom.
const SMOOTHING = 0.18;
const ZOOM_SMOOTHING = 0.08;
const MIN_ZOOM = 0.6;
const MAX_ZOOM = 2.0;
const ZOOM_PADDING = 70;   // extra space around fighters
const FOLLOW_ZOOM = 1.15;  // +15% boost while tracking live fighters

let cameraX = 0;
let cameraY = 0;
let targetX = 0;
let targetY = 0;
let baseZoom = 1;         // User-facing zoom setting
let matchZoom = 1;        // Winner KO zoom-in (eases toward 1.3 after match over)
let trackZoom = 1;        // Wide/tight dynamic framing zoom
let targetTrackZoom = 1;
let followActive = true;  // Is tracking live fighters
let shakeOffsetX = 0;     // always 0 — screen shake is scrapped
let shakeOffsetY = 0;

let cutsceneTarget = null;

export function setCutsceneCamera(target) {
  cutsceneTarget = target; // { x, y, zoom } or null
}

export function resetCamera() {
  cameraX = 0;
  cameraY = 0;
  targetX = 0;
  targetY = 0;
  baseZoom = 1;
  matchZoom = 1;
  trackZoom = 1;
  targetTrackZoom = 1;
  followActive = true;
  shakeOffsetX = 0;
  shakeOffsetY = 0;
  cutsceneTarget = null;
}

export function setBaseZoom(val) {
  baseZoom = typeof val === 'number' && val > 0 ? val : 1;
}

export function setMatchZoom(val) {
  matchZoom = val;
}

export function setFollowActive(active) {
  followActive = !!active;
}

export function updateMatchZoom(dt, isMatchOver) {
  if (isMatchOver) {
    matchZoom += (1.3 - matchZoom) * 0.04 * (dt * 60);
  } else {
    matchZoom += (1.0 - matchZoom) * 0.08 * (dt * 60);
  }
}

export function updateCamera(fighters, canvasWidth, canvasHeight, dt) {
  if (cutsceneTarget) {
    targetX = cutsceneTarget.x;
    targetY = cutsceneTarget.y;
    targetTrackZoom = cutsceneTarget.zoom || 1;
    const followFactor = 0.5;
    cameraX += (targetX - cameraX) * followFactor * dt * 60;
    cameraY += (targetY - cameraY) * followFactor * dt * 60;
    trackZoom += (targetTrackZoom - trackZoom) * 0.06 * dt * 60;
    return;
  }

  // Fold the dead/respawn filter into the midpoint loop — no temporary array.
  let alive = 0;
  let minX = Infinity, maxX = -Infinity;
  let minY = Infinity, maxY = -Infinity;

  for (const f of fighters) {
    if (f.state === 'dead' || f.state === 'respawn') continue;
    alive++;
    if (f.x < minX) minX = f.x;
    if (f.x > maxX) maxX = f.x;
    if (f.y < minY) minY = f.y;
    if (f.y > maxY) maxY = f.y;
  }

  if (alive === 0) return;

  // Target center - always centered between alive fighters
  targetX = (minX + maxX) / 2;
  targetY = (minY + maxY) / 2;

  // Calculate required zoom to fit all fighters with padding
  const spreadX = (maxX - minX) + ZOOM_PADDING * 2;
  const spreadY = (maxY - minY) + ZOOM_PADDING * 2;

  const zoomX = canvasWidth / spreadX;
  const zoomY = canvasHeight / spreadY;

  if (alive === 2) {
    targetTrackZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.min(zoomX, zoomY)));
  } else {
    targetTrackZoom = 1;
  }

  // Smooth follow pan
  cameraX += (targetX - cameraX) * SMOOTHING * dt * 60;
  cameraY += (targetY - cameraY) * SMOOTHING * dt * 60;

  // Smooth track zoom
  trackZoom += (targetTrackZoom - trackZoom) * ZOOM_SMOOTHING * dt * 60;
}

export function getComposedZoom() {
  const engineZoom = getCameraZoom();
  const followMultiplier = followActive ? FOLLOW_ZOOM : 1;
  return engineZoom * baseZoom * matchZoom * trackZoom * followMultiplier;
}

export function applyCameraTransform(ctx, canvasWidth, canvasHeight) {
  const camZoom = getComposedZoom();

  // Center on screen with camera pan and (always-zero) shake offset
  const offsetX = canvasWidth / 2 - cameraX * camZoom + shakeOffsetX;
  const offsetY = canvasHeight / 2 - cameraY * camZoom + shakeOffsetY;

  ctx.translate(offsetX, offsetY);
  ctx.scale(camZoom, camZoom);
}

export function setShakeOffset(x, y) {
  shakeOffsetX = x;
  shakeOffsetY = y;
}

export function getCameraState() {
  return {
    x: cameraX,
    y: cameraY,
    zoom: getComposedZoom(),
    targetX,
    targetY,
    targetZoom: targetTrackZoom,
    baseZoom,
    matchZoom,
    trackZoom,
  };
}

// ── SFX: Web Audio synthesis + MP3 player ────────────────────────────────
// Layer 1: Web Audio synthesis primitives (oscillators + filtered noise).
// Layer 2: SFX object — every synthesized fallback sound built from those
//   primitives.
// Layer 3: playSfx() / playSfxFromPath() — MP3 player with per-path
//   caching and broken-path tracking.

let audioCtx = null;
function getAudioCtx() {
  if (!audioCtx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    audioCtx = new AC();
  }
  if (audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}
function envelopeGain(ctxA, peakVolume, attack, decay) {
  const g = ctxA.createGain();
  const now = ctxA.currentTime;
  g.gain.setValueAtTime(0, now);
  g.gain.linearRampToValueAtTime(peakVolume, now + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, now + attack + decay);
  return g;
}
function playTone(freq, opts = {}) {
  const ctxA = getAudioCtx();
  if (!ctxA) return;
  const { duration = 0.15, type = 'sine', volume = 0.25, sweepTo = null, delay = 0 } = opts;
  try {
    const osc = ctxA.createOscillator();
    const gain = envelopeGain(ctxA, volume, 0.005, duration);
    const now = ctxA.currentTime + delay;
    osc.type = type;
    osc.frequency.setValueAtTime(freq, now);
    if (sweepTo !== null) osc.frequency.exponentialRampToValueAtTime(Math.max(sweepTo, 1), now + duration);
    osc.connect(gain).connect(ctxA.destination);
    // Release the graph the instant the tone ends. A synthesized chain that is
    // never disconnected stays wired into the destination and keeps being
    // processed at audio rate on every render quantum FOREVER. SFX.hit plays
    // three of these chains per hit, so without this every past attack leaves a
    // dead-but-live audio task running — CPU/memory that grows with each attack
    // and drags FPS down. onended pulls the whole chain out of the graph when
    // the tone finishes, so a play leaves no trace behind it.
    osc.onended = () => {
      try { gain.disconnect(); osc.disconnect(); } catch (e) { }
    };
    osc.start(now);
    osc.stop(now + duration + 0.05);
  } catch (e) { }
}
function playNoiseBurst(opts = {}) {
  const ctxA = getAudioCtx();
  if (!ctxA) return;
  const { duration = 0.2, volume = 0.3, filterFreq = 800, filterType = 'bandpass', filterSweepTo = null } = opts;
  try {
    // The noise buffer is reusable: creating + refilling a ±4k-sample random
    // buffer on EVERY hit (light-attack strings!) is needless GC/CPU churn, so
    // cache one buffer per (sample-rate, rounded-duration) pair.
    const key = `${ctxA.sampleRate}:${Math.round(Math.max(0.02, duration) * 1000)}`;
    let buffer = _noiseBufferCache.get(key);
    if (!buffer) {
      const bufferSize = Math.max(1, Math.floor(ctxA.sampleRate * Math.max(0.02, duration)));
      buffer = ctxA.createBuffer(1, bufferSize, ctxA.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < bufferSize; i++) data[i] = Math.random() * 2 - 1;
      _noiseBufferCache.set(key, buffer);
    }
    const noise = ctxA.createBufferSource();
    noise.buffer = buffer;
    const filter = ctxA.createBiquadFilter();
    filter.type = filterType;
    const now = ctxA.currentTime;
    filter.frequency.setValueAtTime(filterFreq, now);
    if (filterSweepTo !== null) filter.frequency.exponentialRampToValueAtTime(Math.max(filterSweepTo, 40), now + duration);
    const gain = envelopeGain(ctxA, volume, 0.005, duration);
    noise.connect(filter).connect(gain).connect(ctxA.destination);
    // Same lifetime discipline as playTone: unplug the noise graph the moment
    // the burst finishes. Without onended each hit's noise chain would remain
    // connected and processed forever — one more permanently-running task per
    // attack instead of a clean 80ms burst.
    noise.onended = () => {
      try { noise.disconnect(); filter.disconnect(); gain.disconnect(); } catch (e) { }
    };
    noise.start(now);
    noise.stop(now + duration + 0.02);
  } catch (e) { }
}

// ── Synthesized SFX library ─────────────────────────────────────────────
export const SFX = {
  bounce() { playTone(520, { duration: 0.06, type: 'sine', volume: 0.10, sweepTo: 380 }); },
  dodge() {
    playNoiseBurst({ duration: 0.16, volume: 0.22, filterFreq: 600, filterType: 'bandpass', filterSweepTo: 2600 });
    playTone(280, { duration: 0.13, type: 'sine', volume: 0.14, sweepTo: 950 });
  },
  hit(isCrit = false) {
    playNoiseBurst({ duration: 0.08, volume: 0.30, filterFreq: 1300, filterType: 'bandpass', filterSweepTo: 350 });
    playTone(220, { duration: 0.09, type: 'square', volume: 0.24, sweepTo: 520 });
    playTone(90, { duration: 0.10, type: 'triangle', volume: 0.16, sweepTo: 45, delay: 0.03 });
    if (isCrit) {
      [880, 1175, 1568].forEach((f, i) => {
        playTone(f, { duration: 0.10, type: 'triangle', volume: 0.18, delay: 0.03 + i * 0.045 });
      });
      playTone(2093, { duration: 0.14, type: 'sine', volume: 0.12, delay: 0.16 });
    }
  },
  grabImpact() {
    playTone(900, { duration: 0.12, type: 'triangle', volume: 0.25, sweepTo: 1400 });
    playNoiseBurst({ duration: 0.08, volume: 0.15, filterFreq: 2500, filterType: 'highpass' });
  },
  launch() {
    playNoiseBurst({ duration: 0.16, volume: 0.18, filterFreq: 2200, filterType: 'lowpass', filterSweepTo: 300 });
    playTone(500, { duration: 0.14, type: 'sine', volume: 0.16, sweepTo: 180 });
  },
  explosion() {
    playNoiseBurst({ duration: 0.32, volume: 0.38, filterFreq: 1200, filterType: 'lowpass', filterSweepTo: 80 });
    playTone(90, { duration: 0.28, type: 'sawtooth', volume: 0.28, sweepTo: 40 });
  },
  deny() {
    playTone(180, { duration: 0.10, type: 'square', volume: 0.16 });
    playTone(140, { duration: 0.12, type: 'square', volume: 0.14, delay: 0.10 });
  },
  punch() {
    playNoiseBurst({ duration: 0.07, volume: 0.26, filterFreq: 700, filterType: 'lowpass', filterSweepTo: 130 });
    playTone(190, { duration: 0.08, type: 'square', volume: 0.2, sweepTo: 80 });
  },
  smokePoof() { playNoiseBurst({ duration: 0.18, volume: 0.14, filterFreq: 500, filterType: 'lowpass', filterSweepTo: 150 }); },
  heal() {
    playTone(660, { duration: 0.10, type: 'sine', volume: 0.16 });
    playTone(990, { duration: 0.14, type: 'sine', volume: 0.14, delay: 0.08 });
  },
  buff() {
    playTone(520, { duration: 0.09, type: 'triangle', volume: 0.18, sweepTo: 780 });
    playNoiseBurst({ duration: 0.06, volume: 0.06, filterFreq: 4000, filterType: 'highpass' });
  },
  bloomShot() {
    playTone(300, { duration: 0.06, type: 'triangle', volume: 0.10, sweepTo: 620 });
    playNoiseBurst({ duration: 0.05, volume: 0.05, filterFreq: 1600, filterType: 'highpass' });
  },
  click() { playTone(700, { duration: 0.05, type: 'triangle', volume: 0.14, sweepTo: 900 }); },
  victory() { [523, 659, 784, 1046].forEach((f, i) => playTone(f, { duration: 0.25, type: 'triangle', volume: 0.18, delay: i * 0.12 })); },
  defeat() { [392, 349, 311, 261].forEach((f, i) => playTone(f, { duration: 0.35, type: 'sawtooth', volume: 0.16, delay: i * 0.15 })); },
  draw() { [440, 440].forEach((f, i) => playTone(f, { duration: 0.2, type: 'square', volume: 0.15, delay: i * 0.22 })); },
  // Reveal slot-machine: short tick on each cycling flicker...
  reelTick() { playTone(660, { duration: 0.035, type: 'square', volume: 0.10, sweepTo: 520 }); },
  // ...and a punchier confirm chime when a side locks in its final pick.
  lockIn() {
    playTone(784, { duration: 0.09, type: 'triangle', volume: 0.20, sweepTo: 1046 });
    playTone(523, { duration: 0.07, type: 'sine', volume: 0.14, delay: 0.02 });
  },
  // Terminal-menu blips (former Audio.js)
  menuSelect() { playTone(600, { duration: 0.08, type: 'triangle', volume: 0.15, sweepTo: 800 }); },
  menuConfirm() {
    playTone(500, { duration: 0.1, type: 'triangle', volume: 0.18, sweepTo: 1000 });
    playTone(800, { duration: 0.12, type: 'sine', volume: 0.12, sweepTo: 1200, delay: 0.06 });
  },
};

// ── MP3 player with pool + broken-path tracking ────────────────────────
let _sfxMuted = false;
const _playingMp3Nodes = new Set();
export function setSfxMuted(muted) {
  _sfxMuted = muted;
  try {
    const ctx = getAudioCtx();
    if (muted) ctx.suspend();
    else ctx.resume();
  } catch (e) {}
  if (muted) {
    // Plain <audio> elements are outside the AudioContext, so suspending the
    // context isn't enough — pause any one-shot MP3s still playing and every
    // pooled SFX too (except force-played nodes like a cutscene's own theme).
    for (const node of [..._playingMp3Nodes]) {
      if (node._muteImmune) continue;
      try { node.pause(); } catch (e) {}
      _playingMp3Nodes.delete(node);
    }
    for (const pool of audioPools.values()) {
      for (const a of pool) {
        if (!a.paused && !a.ended) { try { a.pause(); } catch (e) {} }
      }
    }
  }
}
const audioPools = new Map(); // path -> HTMLAudioElement[]
const _noiseBufferCache = new Map(); // "sampleRate:ms" -> AudioBuffer (reused across plays)
const lastPlayedAt = new Map(); // path -> timestamp (ms)
const _audioElementCache = new Map();
const _audioBrokenPaths = new Set();
const POOL_SIZE = 4;

function getPooledAudio(path) {
  let pool = audioPools.get(path);
  if (!pool) {
    pool = Array.from({ length: POOL_SIZE }, () => new Audio(path));
    audioPools.set(path, pool);
  }
  return pool.find(a => a.paused || a.ended) ?? pool[0];
}

// volume: 0-1. cooldownMs: minimum gap between plays of the same path.
export function playSfx(path, { volume = 1, cooldownMs = 0 } = {}) {
  if (!path || _sfxMuted) return;
  const now = performance.now();
  if (cooldownMs > 0) {
    const last = lastPlayedAt.get(path) ?? -Infinity;
    if (now - last < cooldownMs) return;
  }
  lastPlayedAt.set(path, now);
  const audio = getPooledAudio(path);
  audio.currentTime = 0;
  audio.volume = volume;
  audio.play?.().catch(() => {});
  eventBus.emit('sfxPlay', { path });
}

// Plays an MP3 from a path; returns the node if played, false if the path was
// null/broken (so the caller can fall back to SFX.*).
// opts.force lets a caller play even while muted (e.g. a cutscene's own
// theme); force-played nodes are exempt from being paused by setSfxMuted.
export function playSfxFromPath(path, volume = 0.7, opts = {}) {
  if (!path || _audioBrokenPaths.has(path) || (!opts.force && _sfxMuted)) return false;
  try {
    let base = _audioElementCache.get(path);
    if (!base) {
      base = new Audio(path);
      base.preload = 'auto';
      base.addEventListener('error', () => { _audioBrokenPaths.add(path); }, { once: true });
      _audioElementCache.set(path, base);
    }
    const node = base.cloneNode(true);
    node.volume = volume;
    if (opts.force) node._muteImmune = true;
    node.addEventListener('error', () => { _audioBrokenPaths.add(path); }, { once: true });
    _playingMp3Nodes.add(node);
    node.addEventListener('ended', () => _playingMp3Nodes.delete(node), { once: true });
    node.addEventListener('pause', () => _playingMp3Nodes.delete(node), { once: true });
    node.addEventListener('abort', () => _playingMp3Nodes.delete(node), { once: true });
    const p = node.play();
    if (p && typeof p.catch === 'function') p.catch(() => {});
    eventBus.emit('sfxPlay', { path });
    return node;
  } catch (e) {
    return false;
  }
}
