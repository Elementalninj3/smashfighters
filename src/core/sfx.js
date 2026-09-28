// core/sfx.js — the whole audio layer: Web Audio synthesis plus an MP3 player.
//
// Three layers, each above the last:
//   1. Web Audio synthesis primitives (oscillators + filtered noise).
//   2. SFX object — every synthesized fallback sound built from those
//      primitives.
//   3. playSfx() / playSfxFromPath() — MP3 player with per-path
//      caching and broken-path tracking.

import { eventBus } from './eventBus.js';

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

// ── Recorded voices (GA/audio) ───────────────────────────────────────────
// Real recordings layered over the synthesized library. Each voice plays its
// MP3 and keeps its original synthesis as a FALLBACK, so a missing file, a muted
// context, or a browser that refuses to start playback degrades to exactly the
// sound it replaced rather than to silence. GA/ is served at /GA (vite.config.js).
const VOICE = {
  slash: '/GA/audio/slash.mp3',           // ninja: neutral/forward light, both aerials
  cowboyM1s: '/GA/audio/cowboym1s.mp3',   // cowboy: the same four light moves
  shadowDash: '/GA/audio/shadowdash.mp3', // ninja Down Smash (Shadow Strike)
  rifle: '/GA/audio/cowboyrifle.mp3',     // cowboy Side Smash (rifle shot)
  horse: '/GA/audio/cowboyhorse.mp3',     // cowboy Down Smash (horse summon)
  revolver: '/GA/audio/cowboyrevolver.mp3', // cowboy Down Light (Deadeye)
  shurikenThrow: '/GA/audio/shurikenthrow.mp3', // ninja Side Smash
};

// Play a recorded voice, synthesizing `synthFn` only when the recording cannot
// play. The fallback is a callback, never an SFX method name: a name would let a
// voice name itself as its own fallback and recurse forever.
function playVoice(path, synthFn, volume) {
  if (playSfxFromPath(path, volume == null ? 0.7 : volume)) return true;
  if (typeof synthFn === 'function') synthFn();
  return false;
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
  // Horse mount (cowboy Down Smash summons its ride): the recorded summon, with
  // the original two low ground-thumps plus dust whoosh as its fallback.
  gallop(volume = 0.7) {
    playVoice(VOICE.horse, () => {
      playTone(170, { duration: 0.08, type: 'triangle', volume: 0.22, sweepTo: 95 });
      playTone(120, { duration: 0.12, type: 'triangle', volume: 0.2, sweepTo: 70, delay: 0.06 });
      playNoiseBurst({ duration: 0.14, volume: 0.12, filterFreq: 700, filterType: 'lowpass', filterSweepTo: 260 });
    }, volume);
  },
  heal() {
    playTone(660, { duration: 0.10, type: 'sine', volume: 0.16 });
    playTone(990, { duration: 0.14, type: 'sine', volume: 0.14, delay: 0.08 });
  },
  buff() {
    playTone(520, { duration: 0.09, type: 'triangle', volume: 0.18, sweepTo: 780 });
    playNoiseBurst({ duration: 0.06, volume: 0.06, filterFreq: 4000, filterType: 'highpass' });
  },
  // Slow-mo break (cowboy Down Light): a deep sawtooth sub-drop for the "time
  // stops" sting plus a faint high shimmer. Synthesized — no asset required.
  timeDilate() {
    playTone(160, { duration: 0.45, type: 'sawtooth', volume: 0.16, sweepTo: 50 });
    playTone(720, { duration: 0.40, type: 'sine', volume: 0.05, sweepTo: 360 });
  },
  click() { playTone(700, { duration: 0.05, type: 'triangle', volume: 0.14, sweepTo: 900 }); },
  victory() { [523, 659, 784, 1046].forEach((f, i) => playTone(f, { duration: 0.25, type: 'triangle', volume: 0.18, delay: i * 0.12 })); },
  defeat() { [392, 349, 311, 261].forEach((f, i) => playTone(f, { duration: 0.35, type: 'sawtooth', volume: 0.16, delay: i * 0.15 })); },
  draw() { [440, 440].forEach((f, i) => playTone(f, { duration: 0.2, type: 'square', volume: 0.15, delay: i * 0.22 })); },
  // Reveal slot-machine: short tick on each cycling flicker...
  reelTick() { playTone(660, { duration: 0.035, type: 'square', volume: 0.10, sweepTo: 520 }); },
  // Terminal-menu blips (former Audio.js)
  menuSelect() { playTone(600, { duration: 0.08, type: 'triangle', volume: 0.15, sweepTo: 800 }); },
  menuConfirm() {
    playTone(500, { duration: 0.1, type: 'triangle', volume: 0.18, sweepTo: 1000 });
    playTone(800, { duration: 0.12, type: 'sine', volume: 0.12, sweepTo: 1200, delay: 0.06 });
  },
  // Ninja SFX
  // Shuriken throw: the recorded spin, original synth as the fallback.
  shurikenThrow(volume = 0.7) {
    playVoice(VOICE.shurikenThrow, () => {
      playTone(1200, { duration: 0.06, type: 'triangle', volume: 0.18, sweepTo: 2000 });
      playNoiseBurst({ duration: 0.04, volume: 0.08, filterFreq: 3000, filterType: 'highpass' });
    }, volume);
  },
  // Shadow Strike (ninja Down Smash, the shadow dash): the recorded dash, with
  // the original sub-drop + noise as the fallback.
  shadowStrike(volume = 0.7) {
    playVoice(VOICE.shadowDash, () => {
      playTone(200, { duration: 0.08, type: 'sawtooth', volume: 0.20, sweepTo: 60 });
      playNoiseBurst({ duration: 0.12, volume: 0.15, filterFreq: 800, filterType: 'lowpass', filterSweepTo: 100 });
    }, volume);
  },
  // ── The four light attacks, one voice per character ───────────────────
  // Same moves, different recordings: the ninja's blade work vs the cowboy's.
  // slash.mp3 is mixed well under the cowboy's set - it sits on top of an
  // already busy attack cadence and reads as harsh at parity, so it is pulled
  // down rather than matched.
  slash(volume = 0.4) {
    playVoice(VOICE.slash, () => {
      playNoiseBurst({ duration: 0.07, volume: 0.22, filterFreq: 2400, filterType: 'highpass' });
      playTone(420, { duration: 0.06, type: 'sawtooth', volume: 0.12, sweepTo: 160 });
    }, volume);
  },
  cowboyM1s(volume = 0.6) {
    playVoice(VOICE.cowboyM1s, () => {
      playNoiseBurst({ duration: 0.07, volume: 0.22, filterFreq: 1800, filterType: 'bandpass', filterSweepTo: 600 });
      playTone(340, { duration: 0.07, type: 'square', volume: 0.13, sweepTo: 140 });
    }, volume);
  },
  // Cowboy rifle (cowboy Side Smash). Its own voice rather than a retune of a
  // shared shot sting, which would put the rifle recording on every other
  // projectile too.
  rifleShot(volume = 0.7) {
    playVoice(VOICE.rifle, () => {
      playTone(300, { duration: 0.06, type: 'triangle', volume: 0.10, sweepTo: 620 });
      playNoiseBurst({ duration: 0.05, volume: 0.05, filterFreq: 1600, filterType: 'highpass' });
    }, volume);
  },
  // Cowboy Down Light (the Deadeye cast): the recorded revolver, falling back to
  // the original slow-mo sub-drop sting. The fallback names a DIFFERENT method
  // than the one being played, so there is no chance of it recursing into
  // playVoice again.
  deadeyeShot(volume = 0.7) {
    playVoice(VOICE.revolver, () => SFX.timeDilate(), volume);
  },
};

// ── MP3 player with pool + broken-path tracking ────────────────────────
let _sfxMuted = false;
export function setSfxMuted(muted) {
  _sfxMuted = muted;
  try {
    const ctx = getAudioCtx();
    if (muted) ctx.suspend();
    else ctx.resume();
  } catch (e) {}
  if (muted) {
    // Plain <audio> elements are outside the AudioContext, so suspending the
    // context isn't enough — pause every pooled SFX (except force-played ones
    // like a cutscene's own theme). All MP3 playback is pooled, so walking the
    // pools covers the one-shots too.
    for (const pool of audioPools.values()) {
      for (const a of pool) {
        if (a._muteImmune) continue;
        if (!a.paused && !a.ended) { try { a.pause(); } catch (e) {} }
      }
    }
  }
}
const audioPools = new Map(); // path -> HTMLAudioElement[]
const _noiseBufferCache = new Map(); // "sampleRate:ms" -> AudioBuffer (reused across plays)
const lastPlayedAt = new Map(); // path -> timestamp (ms)
const _audioBrokenPaths = new Set();
const POOL_SIZE = 4;

function getPooledAudio(path) {
  let pool = audioPools.get(path);
  if (!pool) {
    pool = Array.from({ length: POOL_SIZE }, (_, i) => {
      const a = new Audio(path);
      // Only the FIRST element preloads eagerly. Preloading all four made the
      // first play of a path cost four parallel fetches + decodes of the same
      // file, which showed up as a one-time stall on the opening hit of a
      // match; the rest warm off the HTTP cache (or on their own first play),
      // which is plenty for a handful of KB.
      a.preload = i === 0 ? 'auto' : 'metadata';
      // Mark the path broken on the pool itself rather than on a separate
      // prototype element: every MP3 player now shares these, so one failed
      // load is enough for the synth fallback to kick in from then on.
      a.addEventListener('error', () => { _audioBrokenPaths.add(path); }, { once: true });
      return a;
    });
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
    // Pooled, NOT cloned per play. Every light attack, gunshot and ability call
    // lands here, and building a fresh HTMLAudioElement (plus four listeners)
    // per call meant the browser spun up a media element and a decoder for each
    // one mid-match. It also leaked: a play() that rejected left the element
    // stranded in a tracking Set forever, since only ended/pause/abort ever
    // removed it and a rejected play fires none of those. Reusing the pool
    // playSfx() already has costs nothing, bounds the element count, and
    // setSfxMuted() already walks it.
    const node = getPooledAudio(path);
    node.currentTime = 0;
    node.volume = volume;
    node._muteImmune = !!opts.force;
    const p = node.play();
    if (p && typeof p.catch === 'function') p.catch(() => {});
    eventBus.emit('sfxPlay', { path });
    return node;
  } catch (e) {
    return false;
  }
}
