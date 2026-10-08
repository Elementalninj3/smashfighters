
// ── merged from core/eventBus.js ──
// assets.js — the game's publish/subscribe bus.
//
// A single process-wide bus. Systems publish facts ("sfxPlay") rather than
// calling each other, so the audio layer can announce a playback without
// knowing who cares, and a future HUD/analytics listener can attach without any
// producer being edited.

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


// ── merged from core/sfx.js ──
// assets.js — the whole audio layer: Web Audio synthesis plus an MP3 player.
//
// Three layers, each above the last:
//   1. Web Audio synthesis primitives (oscillators + filtered noise).
//   2. SFX object — every synthesized fallback sound built from those
//      primitives.
//   3. playSfx() / playSfxFromPath() — MP3 player with per-path
//      caching and broken-path tracking.


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
  slash: '/GA/audio/slash.mp3',           // ninja + knight: neutral/forward light, both aerials
  cowboyM1s: '/GA/audio/cowboym1s.mp3',   // cowboy: the same four light moves
  boxerM1: '/GA/audio/boxerm1.mp3',       // boxer: basic attacks
  boxerGrab: '/GA/audio/boxergrab.mp3',   // boxer: grab catch
  depseyDodge: '/GA/audio/depseydodge.mp3', // depsey roll: autododge sting
  usus: '/GA/audio/usus.mp3',             // boxer basics while depsey roll runs
  walking: '/GA/audio/walking.mp3',       // footsteps while moving grounded
  shadowDash: '/GA/audio/shadowdash.mp3', // ninja Down Smash (Shadow Strike)
  rifle: '/GA/audio/cowboyrifle.mp3',     // cowboy Side Smash (rifle shot)
  horse: '/GA/audio/cowboyhorse.mp3',     // cowboy Down Smash (horse summon)
  revolver: '/GA/audio/cowboyrevolver.mp3', // cowboy Down Light (Deadeye)
  shurikenThrow: '/GA/audio/shurikenthrow.mp3', // ninja Side Smash
  koPillar: '/GA/audio/KOPillar.mp3',     // the KO pillar beam (every disappearance)
  chargedSword: '/GA/audio/chargedsword.mp3', // knight Side Smash (Charged Sword Strike)
  shieldBash: '/GA/audio/shieldbash.mp3', // knight Down Light (Shield Bash)
  shieldCounter: '/GA/audio/shieldcounter.mp3', // knight Neutral Heavy (Shield Counter)
  cannon: '/GA/audio/cannonshot.mp3', // pirate Cannon Blast + Broadside Burst
  flintKnock: '/GA/audio/flintknock.mp3', // pirate Cutlass Lunge
  ropeSwing: '/GA/audio/ropeswing.mp3', // pirate Rope Swing
  anchorDrop: '/GA/audio/anchor.mp3', // pirate Anchor Drop
  plundered: '/GA/audio/plundered.mp3', // pirate Treasure Hunt reward shout
  treasureDigging: '/GA/audio/treasuredigging.mp3', // pirate digging loop
  treasureChest: '/GA/audio/treasure.mp3', // pirate chest unearth
};

// Play a recorded voice, synthesizing `synthFn` only when the recording cannot
// play. The fallback is a callback, never an SFX method name: a name would let a
// voice name itself as its own fallback and recurse forever. The fallback runs
// both when playback cannot even start (missing/broken path) AND when the
// play() itself rejects (404 on first touch, blocked autoplay) — otherwise a
// first-play failure degrades to silence instead of to the sound it replaced.
function playVoice(path, synthFn, volume) {
  if (playSfxFromPath(path, volume == null ? 0.7 : volume, { onFail: synthFn })) return true;
  if (typeof synthFn === 'function') synthFn();
  return false;
}

// The synthesis slash.mp3 replaced. Shared, not inlined: the knight plays the
// SAME recording quieter (see knightSlash), and both takes must degrade to one
// and the same sound rather than to two subtly different ones.
function slashFallback() {
  playNoiseBurst({ duration: 0.07, volume: 0.22, filterFreq: 2400, filterType: 'highpass' });
  playTone(420, { duration: 0.06, type: 'sawtooth', volume: 0.12, sweepTo: 160 });
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
  // Treasure Hunt (pirate passive): dirt thump for an empty hole, wooden
  // knock + gold shimmer when a chest comes up, warm major rise when the
  // Golden Orb is granted. All synthesized like the rest of the catalogue.
  digThud() {
    playTone(120, { duration: 0.12, type: 'triangle', volume: 0.20, sweepTo: 60 });
    playNoiseBurst({ duration: 0.10, volume: 0.12, filterFreq: 400, filterType: 'lowpass', filterSweepTo: 120 });
  },
  chestUnearth() {
    playTone(180, { duration: 0.10, type: 'triangle', volume: 0.22, sweepTo: 90 });
    playNoiseBurst({ duration: 0.08, volume: 0.10, filterFreq: 900, filterType: 'lowpass', filterSweepTo: 300 });
    [880, 1174, 1568].forEach((f, i) => {
      playTone(f, { duration: 0.12, type: 'triangle', volume: 0.14, delay: 0.08 + i * 0.07 });
    });
    playNoiseBurst({ duration: 0.20, volume: 0.05, filterFreq: 6000, filterType: 'highpass' });
  },
  goldOrb() {
    [523, 659, 784, 1046].forEach((f, i) => {
      playTone(f, { duration: 0.16, type: 'sine', volume: 0.14, delay: i * 0.07 });
    });
    playNoiseBurst({ duration: 0.25, volume: 0.04, filterFreq: 7000, filterType: 'highpass' });
  },
  // ── The pirate's recorded treasure kit ───────────────────────────────
  // Real recordings layered over the synth fallbacks above (same playVoice
  // pattern as the rest of the catalogue): the cannon's own report rather
  // than the cowboy's rifle, the reward shout, the digging and the chest.
  // Fallbacks name the pure-synth methods, never a playVoice method, so a
  // missing file degrades to the same timing rather than recursing.
  cannonShot(volume = 0.7) {
    playVoice(VOICE.cannon, () => {
      playTone(120, { duration: 0.20, type: 'sawtooth', volume: 0.25, sweepTo: 50 });
      playNoiseBurst({ duration: 0.22, volume: 0.30, filterFreq: 900, filterType: 'lowpass', filterSweepTo: 90 });
    }, volume);
  },
  // Cutlass Lunge (pirate Forward Light): the recorded flintknock, falling
  // back to the plain slash synthesis it replaces.
  flintKnock(volume = 0.6) {
    playVoice(VOICE.flintKnock, slashFallback, volume);
  },
  // Rope Swing (pirate Down Light): the recorded swing, falling back to the
  // plain slash synthesis it replaces.
  ropeSwing(volume = 0.6) {
    playVoice(VOICE.ropeSwing, slashFallback, volume);
  },
  // Anchor Drop (pirate Down Heavy): the recorded slam, falling back to the
  // punch thump it replaces.
  anchorDrop(volume = 0.7) {
    playVoice(VOICE.anchorDrop, () => SFX.punch(), volume);
  },
  plundered(volume = 0.7) {
    playVoice(VOICE.plundered, () => SFX.goldOrb(), volume);
  },
  treasureDigging(volume = 0.7) {
    playVoice(VOICE.treasureDigging, () => SFX.digThud(), volume);
  },
  treasureChest(volume = 0.7) {
    playVoice(VOICE.treasureChest, () => SFX.chestUnearth(), volume);
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
  // down rather than matched - and the knight's take of that same recording
  // (knightSlash) sits under it again, since the knight stacks three more
  // recorded swings on top of these four.
  walking(volume = 0.018) {
    playVoice(VOICE.walking, () => {
      playNoiseBurst({ duration: 0.05, volume: 0.10, filterFreq: 900, filterType: 'lowpass', filterSweepTo: 300 });
    }, volume);
  },
  slash(volume = 0.2) {
    playVoice(VOICE.slash, slashFallback, volume);
  },
  // The knight's take on the same four light swings: slash.mp3 again, but well
  // under the ninja's. It is the same already-busy attack cadence and the same
  // already-harsh recording, and the knight adds three more recorded swings on
  // top of it (the smashes, the bash, the counter), so its basics are pulled
  // down rather than matched — 0.12 against the ninja's 0.2.
  knightSlash(volume = 0.12) {
    playVoice(VOICE.slash, slashFallback, volume);
  },
  cowboyM1s(volume = 0.6) {
    playVoice(VOICE.cowboyM1s, () => {
      playNoiseBurst({ duration: 0.07, volume: 0.22, filterFreq: 1800, filterType: 'bandpass', filterSweepTo: 600 });
      playTone(340, { duration: 0.07, type: 'square', volume: 0.13, sweepTo: 140 });
    }, volume);
  },
  boxerM1s(volume = 0.42) {
    playVoice(VOICE.boxerM1, () => {
      playNoiseBurst({ duration: 0.07, volume: 0.22, filterFreq: 1800, filterType: 'bandpass', filterSweepTo: 600 });
      playTone(340, { duration: 0.07, type: 'square', volume: 0.13, sweepTo: 140 });
    }, volume);
  },
  depseyDodge(volume = 0.7) {
    playVoice(VOICE.depseyDodge, () => SFX.dodge(), volume);
  },
  usus(volume = 0.6) {
    playVoice(VOICE.usus, () => SFX.boxerM1s(volume), volume);
  },
  boxerGrab(volume = 0.7) {
    playVoice(VOICE.boxerGrab, () => SFX.grabImpact(), volume);
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
  // ── The knight's recorded specials ─────────────────────────────────
  // Charged Sword Strike (Side Smash): its own swing, mixed under the light
  // attacks so the charge reads as the heaviest of the four. Falls back to the
  // plain slash synthesis.
  chargedSword(volume = 0.55) {
    playVoice(VOICE.chargedSword, slashFallback, volume);
  },
  // Shield Bash (Down Light): the recorded shove, with the original punch thump
  // as its fallback (same transient, so a missing file keeps the timing).
  shieldBash(volume = 0.6) {
    playVoice(VOICE.shieldBash, () => SFX.punch(), volume);
  },
  // Shield Counter (Neutral Heavy): the recorded answering slash. Played on the
  // counter that actually CONNECTS, not on the stance cast — the cast is silent
  // anticipation, and this is the payoff. Falls back to the original critical
  // impact that used to play here.
  shieldCounter(volume = 0.65) {
    playVoice(VOICE.shieldCounter, () => SFX.hit(true), volume);
  },
  // The KO pillar: the recorded beam ignition, with the original explosion as
  // its fallback. Plays on EVERY pillar, so a simultaneous double KO lands two.
  koPillar(volume = 0.7) {
    playVoice(VOICE.koPillar, () => SFX.explosion(), volume);
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

// Plays an MP3 from a path; returns the node if playback started, false if the
// path was null/broken (so the caller can fall back to SFX.*).
// opts.force lets a caller play even while muted (e.g. a cutscene's own
// theme); force-played nodes are exempt from being paused by setSfxMuted.
// opts.onFail fires if the async play() rejects (missing file on first touch,
// blocked autoplay): the caller (playVoice) uses it to run its synth fallback,
// so a rejected play degrades to the replaced sound rather than to silence.
// The path is NOT marked broken here — a rejection can be transient (autoplay
// block), and a genuinely missing file still trips the pool's error listener,
// which marks it for next time.
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
    if (p && typeof p.catch === 'function') p.catch(() => {
      try { if (typeof opts.onFail === 'function') opts.onFail(); } catch (e) {}
    });
    eventBus.emit('sfxPlay', { path });
    return node;
  } catch (e) {
    return false;
  }
}
