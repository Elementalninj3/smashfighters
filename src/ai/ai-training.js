// ai-training.js â€” headless evolutionary training harness.
//
// What it does: pits two genome-driven AI controllers against each other in
// REAL matches (same Fighter/combat/Stage code paths as live play, just
// without rendering/audio), records per-match stat bundles, converts them to
// weighted fitness (ai-genetic-algorithm.js), then selects/crosses/mutates.
//
// What it does NOT do: no simplified damage math, no fake fitness, no visual
// frame rendering. Speed comes from (a) fixed 1/60 steps with no draw calls,
// (b) 1-stock bouts, (c) chunked async execution so the browser stays alive.
//
// Two populations co-evolve (one per character pick), paired round-robin each
// generation. Same-character training works: two independent gene pools.

import { createFighter, handleFighterInput, stepFighterPhysics, applySoftPlayerSeparation, updateFighterState, resetAbilityCooldowns } from '../fighter/Fighter.js';
import { createDefaultStage, resolvePlatformCollision, isInBlastZone, updatePlatforms } from '../stage/Stage.js';
import { loadAccessoryFor } from '../render/Accessories.js';
import { loadHandGearFor } from '../render/HandGear.js';
import { combatInput, updateAttacks, updateProjectiles, resetCombat } from '../fighter/combat.js';
import { AIController } from './ai.js';
import { initPopulation, nextGeneration, computeFitness, populationStats, bestOf, cloneGenome } from './ai-genetic-algorithm.js';
import { saveTrainedModel } from './ai-model-storage.js';
import { SFX } from '../core/sfx.js';
import { resetTimeDilation, stepTimeDilation, resetDamageIndicators } from '../render/worldFx.js';

const SIM_DT = 1 / 60;
const TRAIN_STOCKS = 1;          // 1-stock bouts keep generations fast
const MAX_SECONDS_PER_MATCH = 30;
const MAX_FRAMES = MAX_SECONDS_PER_MATCH * 60;

function emptyStats() {
  return {
    win: 0, stocksTaken: 0, stocksLost: 0,
    damageDealt: 0, damageTaken: 0, hitsLanded: 0,
    combos: 0, blocks: 0, dodges: 0, punishes: 0,
    recoveries: 0, edgeguards: 0, whiffs: 0,
    wastedRecoveries: 0, idleFrames: 0, offStageFrames: 0,
    failedActions: 0, centerTime: 0, aliveFrames: 0,
    attacksStarted: 0, attacksHit: 0,
  };
}

function mainGround(stage) {
  if (!stage || !Array.isArray(stage.platforms)) return null;
  return stage.platforms.find((p) => p.isGround) || stage.platforms[0] || null;
}

function signedInside(f, stage) {
  const g = mainGround(stage);
  if (!g) return 999;
  return Math.min(f.x - g.x, (g.x + g.width) - f.x);
}

function offStage(f, stage) {
  const g = mainGround(stage);
  if (!g) return false;
  if (f.grounded) return false;
  return f.x < g.x - 20 || f.x > g.x + g.width + 20 || f.y > g.y + 10;
}

function makeHeadlessFighter(playerNum, def) {
  const f = createFighter(playerNum, 0, 0, null, {
    id: `train-p${playerNum}`,
    color: playerNum === 1 ? '#4a9eff' : '#ff4a4a',
    radius: def.radius || 26,
    runSpeed: def.runSpeed || 68,
    airSpeed: (def.runSpeed || 68) * 0.85,
    jumpForce: def.jumpForce || 680,
    doubleJumpForce: (def.jumpForce || 680) * 1.2,
  });
  f._fighterDef = def;
  f.stocks = TRAIN_STOCKS;
  f.eliminated = false;
  // Presentation (for the live game-view preview): same skin path, scale and
  // accessory the real match uses, so the preview draws these fighters with
  // the EXACT same code as live play. Zero effect on simulation.
  f.skin = def.skin ? { path: def.skin } : null;
  f.skinScale = def.skinScale || 0.85;
  try { f.accessory = loadAccessoryFor(def.id); } catch (_) { f.accessory = null; }
  try { f.handGear = loadHandGearFor(def.id, def.handGear); } catch (_) { f.handGear = null; }
  return f;
}

function placeAtSpawns(f1, f2, stage) {
  const sp1 = stage.spawnPoints[0], sp2 = stage.spawnPoints[1];
  for (const [f, sp] of [[f1, sp1], [f2, sp2]]) {
    f.x = sp.x; f.y = sp.y - 30;
    f.vx = 0; f.vy = 0;
    f.percent = 0; f.hitstun = 0;
    f.attack = null; f.attackBuffer = null;
    f.grounded = false; f.groundPlatform = null;
    f.canDoubleJump = true; f.canUseAerialLightRecovery = true;
    f.freeFall = false; f.dodging = false;
    f.shielding = false; f.shieldCooldown = 0; f.attackCooldown = 0;
    f.dodgeCooldown = 0; f.invulnTimer = 0;
    resetAbilityCooldowns(f);
    f.stocks = TRAIN_STOCKS; f.eliminated = false; f.state = 'idle';
    if (f._projectiles) f._projectiles.length = 0;
    f._horse = null;
  }
}

// â”€â”€ One headless match â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// A resumable closure: call step(N) to advance up to N frames; done() reports
// completion; result() returns { winner, stats1, stats2 }. The trainer drives
// these in chunks so the UI thread never blocks.
export function createHeadlessMatch(defA, defB, genomeA, genomeB) {
  const stage = createDefaultStage(1200, 1100);
  const f1 = makeHeadlessFighter(1, defA);
  const f2 = makeHeadlessFighter(2, defB);
  placeAtSpawns(f1, f2, stage);
  resetCombat();
  resetTimeDilation();
  resetDamageIndicators();

  const c1 = new AIController(f1, f2, null, { genome: genomeA, genomeInfluence: 1.0, mistakeRate: 0 });
  const c2 = new AIController(f2, f1, null, { genome: genomeB, genomeInfluence: 1.0, mistakeRate: 0 });

  const s1 = emptyStats(), s2 = emptyStats();
  let frame = 0;
  let finished = false;
  let winner = 0;

  // Per-fighter tracking for attribution.
  const T = [
    null,
    { prevPercent: 0, wasAttack: false, curHit: false, lastEndFrame: -1e9, lastHit: false, wasDJ: true, wasAL: true, djUseFrame: -1e9, alUseFrame: -1e9, landedSinceUse: true, wasOff: false, prevHeldAtk: false, prevHeldSp: false },
    { prevPercent: 0, wasAttack: false, curHit: false, lastEndFrame: -1e9, lastHit: false, wasDJ: true, wasAL: true, djUseFrame: -1e9, alUseFrame: -1e9, landedSinceUse: true, wasOff: false, prevHeldAtk: false, prevHeldSp: false },
  ];

  function blastCheck(f, foe, stats, foeStats) {
    const zone = isInBlastZone(f, stage);
    if (!zone) return false;
    f.stocks = Math.max(0, (f.stocks ?? 1) - 1);
    stats.stocksLost++;
    foeStats.stocksTaken++;
    // Wasted recovery accounting: burned DJ/AL shortly before dying.
    const t = T[f.playerNum];
    if ((frame - t.djUseFrame < 180 || frame - t.alUseFrame < 180) && !t.landedSinceUse) {
      stats.wastedRecoveries++;
    }
    if (f.stocks <= 0) {
      f.eliminated = true;
      finished = true;
      winner = foe.playerNum;
      stats.win = 0; foeStats.win = 1;
      return true;
    }
    // Respawn at 0% (same rule as live play).
    const sp = stage.spawnPoints[f.playerNum - 1] || stage.respawnPoint;
    f.x = sp.x; f.y = sp.y - 30;
    f.vx = 0; f.vy = 0; f.percent = 0;
    f.attack = null; f.hitstun = 0;
    f.canDoubleJump = true; f.canUseAerialLightRecovery = true;
    f.invulnTimer = 1.0;
    T[f.playerNum].prevPercent = 0;
    return false;
  }

  function stepFrame() {
    const simNow = frame * SIM_DT * 1000;
    const effDt = stepTimeDilation(SIM_DT);
    // Floating platforms bob exactly like live play (same function, sim clock).
    try { updatePlatforms(stage, simNow); } catch (_) {}

    try { c1.update(0, simNow, stage); } catch (_) {}
    try { c2.update(0, simNow, stage); } catch (_) {}

    const input1 = c1.getInput();
    const input2 = c2.getInput();
    // Busy snapshot BEFORE combatInput for failed-action accounting.
    const busy1 = f1.hitstun > 0 || f1.attack || f1.dodging || f1._hitLock || (f1.attackCooldown || 0) > 0;
    const busy2 = f2.hitstun > 0 || f2.attack || f2.dodging || f2._hitLock || (f2.attackCooldown || 0) > 0;

    try { handleFighterInput(f1, stage, effDt, input1 || {}); } catch (_) {}
    try { handleFighterInput(f2, stage, effDt, input2 || {}); } catch (_) {}

    if (!f1._horse) { f1.grounded = false; f1.groundPlatform = null; }
    if (!f2._horse) { f2.grounded = false; f2.groundPlatform = null; }
    try { stepFighterPhysics(f1, effDt); } catch (_) {}
    try { stepFighterPhysics(f2, effDt); } catch (_) {}
    try { applySoftPlayerSeparation(f1, f2, effDt); } catch (_) {}
    try {
      if (!f1._horse) for (const plat of stage.platforms) resolvePlatformCollision(f1, plat);
      if (!f2._horse) for (const plat of stage.platforms) resolvePlatformCollision(f2, plat);
    } catch (_) {}

    if (blastCheck(f1, f2, s1, s2)) return;
    if (blastCheck(f2, f1, s2, s1)) return;

    try {
      combatInput([f1, f2], { 1: input1, 2: input2 });
    } catch (_) {}
    try { updateAttacks([f1, f2], effDt); } catch (_) {}
    try { updateProjectiles([f1, f2], effDt); } catch (_) {}
    try { updateFighterState(f1); updateFighterState(f2); } catch (_) {}

    // â”€â”€ Stat harvesting (per fighter, perspective-correct) â”€â”€
    const pairs = [[f1, f2, s1, s2, c1, busy1, 1], [f2, f1, s2, s1, c2, busy2, 2]];
    for (const [me, foe, stats, foeStats, ctrl, wasBusy, pn] of pairs) {
      const t = T[pn];
      // Damage dealt / taken + hit attribution.
      const dp = me === f1 ? (f2.percent - T[2].prevPercent) : (f1.percent - T[1].prevPercent);
      // (Handled symmetrically below via foe delta; keep per-foe logic clear:)
      void dp; void foeStats;
      // Attack lifecycle.
      const atkActive = !!me.attack;
      if (atkActive && !t.wasAttack) {
        stats.attacksStarted++;
        t.curHit = false;
        // Punish: started up while the foe was vulnerable.
        if (foe.hitstun > 0 || (foe.attack && foe.attack.phase === 'recovery')) stats.punishes++;
      }
      if (!atkActive && t.wasAttack) {
        t.lastEndFrame = frame;
        t.lastHit = t.curHit;
        if (!t.curHit) stats.whiffs++;
        else stats.attacksHit++;
      }
      t.wasAttack = atkActive;
      // Resource tracking (DJ / Aerial-Light consumption).
      if (t.wasDJ && !me.canDoubleJump && !me.grounded) {
        t.djUseFrame = frame; t.landedSinceUse = false;
      }
      if (t.wasAL && !me.canUseAerialLightRecovery && !me.grounded) {
        t.alUseFrame = frame; t.landedSinceUse = false;
      }
      t.wasDJ = !!me.canDoubleJump;
      t.wasAL = !!me.canUseAerialLightRecovery;
      if (me.grounded) t.landedSinceUse = true;
      // Recovery: was off-stage, now back on solid ground alive.
      const isOff = offStage(me, stage);
      if (t.wasOff && !isOff && me.grounded) stats.recoveries++;
      t.wasOff = isOff;
      if (isOff) stats.offStageFrames++;
      // Positioning / activity.
      if (signedInside(me, stage) > 150 && me.grounded) stats.centerTime++;
      stats.aliveFrames++;
      const held = ctrl && ctrl.state ? ctrl.state.held : null;
      const hDist = Math.abs(foe.x - me.x);
      if (held && me.grounded && !me.attack && me.hitstun <= 0 && hDist > 250 &&
          !held.left && !held.right && !held.jump && !held.attack && !held.special) {
        stats.idleFrames++;
      }
      // Defense: shielding/dodging while the foe threatens.
      const foeThreat = foe.attack && hDist < 220;
      if (me.shielding && foeThreat) stats.blocks++;
      if (!me.dodging && me.dodgeCooldown > 0 && foeThreat) {
        // Dodge started this frame under threat (cooldown freshly set).
        if (me.dodgeTimer > 0.2) stats.dodges++;
      }
      // Failed actions: fresh attack/special presses while busy.
      if (held) {
        const atkEdge = held.attack && !t.prevHeldAtk;
        const spEdge = held.special && !t.prevHeldSp;
        if ((atkEdge || spEdge) && wasBusy) stats.failedActions++;
        t.prevHeldAtk = !!held.attack;
        t.prevHeldSp = !!held.special;
      }
    }
    // Damage deltas (foe perspective): attribute to the attacker.
    const d1 = f1.percent - T[1].prevPercent; // damage f1 took
    const d2 = f2.percent - T[2].prevPercent; // damage f2 took
    if (d2 > 0.01) {
      s1.damageDealt += d2; s2.damageTaken += d2;
      const t = T[1];
      if (f1.attack) t.curHit = true;
      else if (frame - t.lastEndFrame < 30) { t.lastHit = true; s1.attacksHit++; }
      s1.hitsLanded++;
      if (f2.hitstun > 0) s1.combos++;
      if (offStage(f2, stage)) s1.edgeguards++;
    }
    if (d1 > 0.01) {
      s2.damageDealt += d1; s1.damageTaken += d1;
      const t = T[2];
      if (f2.attack) t.curHit = true;
      else if (frame - t.lastEndFrame < 30) { t.lastHit = true; s2.attacksHit++; }
      s2.hitsLanded++;
      if (f1.hitstun > 0) s2.combos++;
      if (offStage(f1, stage)) s2.edgeguards++;
    }
    T[1].prevPercent = f1.percent;
    T[2].prevPercent = f2.percent;

    try { c1.postFrame(); } catch (_) {}
    try { c2.postFrame(); } catch (_) {}

    frame++;
    if (frame >= MAX_FRAMES && !finished) {
      finished = true;
      // Timeout: higher remaining stock + lower percent wins; tie = draw.
      if (f1.stocks !== f2.stocks) {
        winner = f1.stocks > f2.stocks ? 1 : 2;
      } else if (Math.abs(f1.percent - f2.percent) > 0.01) {
        winner = f1.percent < f2.percent ? 1 : 2;
      } else {
        winner = 0;
      }
      if (winner === 1) { s1.win = 1; }
      else if (winner === 2) { s2.win = 1; }
      else { s1.win = 0.25; s2.win = 0.25; }
    }
  }

  return {
    step(n) {
      let i = 0;
      while (!finished && i < n) { stepFrame(); i++; }
      return finished;
    },
    done() { return finished; },
    frame() { return frame; },
    result() {
      return { winner, stats1: s1, stats2: s2, frames: frame };
    },
    snapshot() {
      return {
        frame,
        p1: { x: Math.round(f1.x), y: Math.round(f1.y), percent: Math.round(f1.percent), stocks: f1.stocks },
        p2: { x: Math.round(f2.x), y: Math.round(f2.y), percent: Math.round(f2.percent), stocks: f2.stocks },
      };
    },
    // Live object refs for the game-view preview (same thread â€” safe to read
    // between chunks; the preview only READS, never writes).
    fighters() { return [f1, f2]; },
    getStage() { return stage; },
    dispose() {
      try { c1.dispose(); } catch (_) {}
      try { c2.dispose(); } catch (_) {}
      resetCombat();
      resetTimeDilation();
      resetDamageIndicators();
    },
  };
}

// â”€â”€ Trainer â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Chunked co-evolutionary loop.Driven via start(); progress via callbacks.
// Stopping is safe at any chunk boundary: best-so-far is saved, audio
// restored, registries cleared, no handles leak.
export function createTrainer(opts = {}) {
  const cfg = {
    charA: opts.charA || 'cowboy',
    charB: opts.charB || 'ninja',
    defA: opts.defA,
    defB: opts.defB,
    populationSize: Math.max(2, Math.min(200, opts.populationSize | 0 || 50)),
    maxGenerations: Math.max(1, Math.min(2000, opts.maxGenerations | 0 || 250)),
    mutationRate: typeof opts.mutationRate === 'number' ? opts.mutationRate : 0.05,
    mutationStrength: typeof opts.mutationStrength === 'number' ? opts.mutationStrength : 0.25,
    eliteRate: typeof opts.eliteRate === 'number' ? opts.eliteRate : 0.1,
    tournamentSize: opts.tournamentSize | 0 || 3,
    framesPerChunk: opts.framesPerChunk | 0 || 600,
    onProgress: typeof opts.onProgress === 'function' ? opts.onProgress : null,
    onLive: typeof opts.onLive === 'function' ? opts.onLive : null,
  };

  const state = {
    running: false,
    stopped: false,
    liveMatch: null,
    generation: 0,
    popA: [],
    popB: [],
    bestA: null,
    bestB: null,
    history: [],
    matchesPlayed: 0,
    timer: null,
    lastResult: null,
  };

  let savedSfx = null;
  function muteAudio() {
    try {
      savedSfx = {};
      for (const k of Object.keys(SFX)) {
        if (typeof SFX[k] === 'function') {
          savedSfx[k] = SFX[k];
          SFX[k] = () => {};
        }
      }
    } catch (_) {}
  }
  function restoreAudio() {
    try {
      if (savedSfx) {
        for (const k of Object.keys(savedSfx)) SFX[k] = savedSfx[k];
        savedSfx = null;
      }
    } catch (_) {}
  }

  // Mean per-weight std across the population (sampled indices) â€” a live
  // diversity readout. Collapses toward 0 only if the gene pool converges.
  function diversityOf(pop) {
    try {
      if (!pop.length || !pop[0].weights) return 0;
      const idx = [0, 7, 53, 129, 300, 512, 640, 800, 867];
      let acc = 0;
      for (const k of idx) {
        let mean = 0;
        for (const g of pop) mean += g.weights[k] || 0;
        mean /= pop.length;
        let v = 0;
        for (const g of pop) { const d = (g.weights[k] || 0) - mean; v += d * d; }
        acc += Math.sqrt(v / pop.length);
      }
      return acc / idx.length;
    } catch (_) { return 0; }
  }

  function snapshot() {
    const stA = populationStats(state.popA);
    const stB = populationStats(state.popB);
    return {
      running: state.running,
      generation: state.generation,
      maxGenerations: cfg.maxGenerations,
      populationSize: cfg.populationSize,
      charA: cfg.charA,
      charB: cfg.charB,
      best: Math.max(stA.best, stB.best),
      avg: (stA.avg + stB.avg) / 2,
      bestWins: Math.max(stA.bestWins, stB.bestWins),
      bestA: stA.best, bestB: stB.best,
      avgA: stA.avg, avgB: stB.avg,
      diversityA: diversityOf(state.popA),
      diversityB: diversityOf(state.popB),
      matchesPlayed: state.matchesPlayed,
      lastResult: state.lastResult,
      history: state.history.slice(-50),
    };
  }

  function emit(live) {
    if (cfg.onProgress) {
      try { cfg.onProgress(snapshot()); } catch (_) {}
    }
    if (live && cfg.onLive) {
      try { cfg.onLive(live); } catch (_) {}
    }
  }

  // Run one generation (all pairs) across many chunks. Returns via callbacks.
  function runGeneration(done) {
    const n = cfg.populationSize;
    const order = Array.from({ length: n }, (_, i) => i);
    // Shuffle pairings so genomes meet different opponents each generation.
    for (let i = order.length - 1; i > 0; i--) {
      const j = (Math.random() * (i + 1)) | 0;
      [order[i], order[j]] = [order[j], order[i]];
    }
    let pairIdx = 0;
    let match = null;
    state.liveMatch = match;

    function nextChunk() {
      if (state.stopped) { finishStopped(); return; }
      if (pairIdx >= n) {
        if (match) { try { match.dispose(); } catch (_) {} match = null; }
        state.liveMatch = null;
        done();
        return;
      }
      if (!match) {
        const gA = state.popA[pairIdx];
        const gB = state.popB[order[pairIdx]];
        try {
          match = createHeadlessMatch(cfg.defA, cfg.defB, gA, gB);
          state.liveMatch = match;
        } catch (e) {
          // A broken pairing must never kill training: score both zero.
          gA.fitness = -1000; gB.fitness = -1000;
          pairIdx++;
          state.timer = setTimeout(nextChunk, 0);
          return;
        }
      }
      let mDone = false;
      try {
        mDone = match.step(cfg.framesPerChunk);
      } catch (e) {
        mDone = true;
        try {
          const r = match.result();
          r.stats1.win = 0; r.stats2.win = 0;
        } catch (_) {}
      }
      // Live visualization hook (throttled: every chunk while running).
      if (cfg.onLive) {
        try {
          const snap = match.snapshot();
          cfg.onLive({
            generation: state.generation + 1,
            match: pairIdx + 1,
            of: n,
            ...snap,
          });
        } catch (_) {}
      }
      if (mDone) {
        try {
          const r = match.result();
          const gA = state.popA[pairIdx];
          const gB = state.popB[order[pairIdx]];
          gA.stats = r.stats1; gB.stats = r.stats2;
          gA.fitness = computeFitness(r.stats1);
          gB.fitness = computeFitness(r.stats2);
          gA.matches = (gA.matches || 0) + 1;
          gB.matches = (gB.matches || 0) + 1;
          if (r.winner === 1) gA.wins = (gA.wins || 0) + 1;
          if (r.winner === 2) gB.wins = (gB.wins || 0) + 1;
          state.matchesPlayed++;
          state.lastResult = {
            gen: state.generation + 1,
            match: pairIdx + 1,
            winner: r.winner,
            frames: r.frames,
            fitA: Math.round(gA.fitness),
            fitB: Math.round(gB.fitness),
          };
        } catch (_) {}
        try { match.dispose(); } catch (_) {}
        match = null;
        state.liveMatch = null;
        pairIdx++;
        emit();
      }
      state.timer = setTimeout(nextChunk, 0);
    }
    nextChunk();
  }

  function evolveAndContinue() {
    if (state.stopped) { finishStopped(); return; }
    // Record + preserve bests.
    const bA = bestOf(state.popA), bB = bestOf(state.popB);
    if (bA && (!state.bestA || (bA.fitness || 0) > (state.bestA.fitness || 0))) {
      state.bestA = cloneGenome(bA);
      state.bestA.fitness = bA.fitness; state.bestA.wins = bA.wins;
    }
    if (bB && (!state.bestB || (bB.fitness || 0) > (state.bestB.fitness || 0))) {
      state.bestB = cloneGenome(bB);
      state.bestB.fitness = bB.fitness; state.bestB.wins = bB.wins;
    }
    const stA = populationStats(state.popA);
    const stB = populationStats(state.popB);
    state.history.push({
      gen: state.generation + 1,
      best: Math.max(stA.best, stB.best),
      avg: (stA.avg + stB.avg) / 2,
    });
    state.generation++;
    emit();
    if (state.generation >= cfg.maxGenerations) {
      finishDone();
      return;
    }
    // Breed next generation for both pools.
    try {
      state.popA = nextGeneration(state.popA, {
        eliteRate: cfg.eliteRate,
        tournamentSize: cfg.tournamentSize,
        mutationRate: cfg.mutationRate,
        mutationStrength: cfg.mutationStrength,
      });
      state.popB = nextGeneration(state.popB, {
        eliteRate: cfg.eliteRate,
        tournamentSize: cfg.tournamentSize,
        mutationRate: cfg.mutationRate,
        mutationStrength: cfg.mutationStrength,
      });
    } catch (e) {
      finishStopped();
      return;
    }
    runGeneration(evolveAndContinue);
  }

  function saveBests() {
    const out = { savedA: false, savedB: false };
    try {
      let bA = state.bestA || bestOf(state.popA);
      let bB = state.bestB || bestOf(state.popB);
      // Same-character training (Cowboy vs Cowboy): both pools share one
      // model key â€” keep the better genome instead of letting the second
      // pool blindly overwrite the first.
      if (cfg.charA === cfg.charB && bA && bB) {
        if ((bB.fitness || 0) > (bA.fitness || 0)) bA = bB;
        bB = null;
      }
      if (bA) {
        out.savedA = saveTrainedModel(cfg.charA, {
          weights: bA.weights,
          behavior: bA.behavior,
          fitness: bA.fitness,
          wins: bA.wins,
          generation: state.generation,
          opponent: cfg.charB,
          config: {
            populationSize: cfg.populationSize,
            maxGenerations: cfg.maxGenerations,
            mutationRate: cfg.mutationRate,
          },
        });
      }
      if (bB && cfg.charB !== cfg.charA) {
        out.savedB = saveTrainedModel(cfg.charB, {
          weights: bB.weights,
          behavior: bB.behavior,
          fitness: bB.fitness,
          wins: bB.wins,
          generation: state.generation,
          opponent: cfg.charA,
          config: {
            populationSize: cfg.populationSize,
            maxGenerations: cfg.maxGenerations,
            mutationRate: cfg.mutationRate,
          },
        });
      }
    } catch (_) {}
    return out;
  }

  function cleanup() {
    if (state.timer) { clearTimeout(state.timer); state.timer = null; }
    state.liveMatch = null;
    state.running = false;
    restoreAudio();
    try { resetCombat(); } catch (_) {}
    try { resetTimeDilation(); } catch (_) {}
    try { resetDamageIndicators(); } catch (_) {}
  }

  function finishDone() {
    const saved = saveBests();
    cleanup();
    emit();
    if (opts.onDone) {
      try {
        opts.onDone({ reason: 'done', ...snapshot(), saved });
      } catch (_) {}
    }
  }

  function finishStopped() {
    const saved = saveBests();
    cleanup();
    emit();
    if (opts.onDone) {
      try {
        opts.onDone({ reason: 'stopped', ...snapshot(), saved });
      } catch (_) {}
    }
  }

  return {
    start() {
      if (state.running) return false;
      state.running = true;
      state.stopped = false;
      state.generation = 0;
      state.matchesPlayed = 0;
      state.history = [];
      state.bestA = null;
      state.bestB = null;
      try {
        state.popA = initPopulation(cfg.populationSize);
        state.popB = initPopulation(cfg.populationSize);
      } catch (_) {
        state.running = false;
        return false;
      }
      muteAudio();
      emit();
      runGeneration(evolveAndContinue);
      return true;
    },
    stop() {
      if (!state.running) return false;
      state.stopped = true;
      if (state.timer) { clearTimeout(state.timer); state.timer = null; }
      // Finish synchronously so UI state is consistent immediately.
      finishStopped();
      return true;
    },
    isRunning() { return state.running; },
    // Live view for the game-view preview: { stage, f1, f2 } or null when no
    // bout is in flight. Read-only for the caller.
    getLiveView() {
      try {
        const m = state.liveMatch;
        if (!m) return null;
        const fs = m.fighters();
        return { stage: m.getStage(), f1: fs[0], f2: fs[1] };
      } catch (_) {
        return null;
      }
    },
    snapshot,
    getConfig() { return { ...cfg, onProgress: undefined, onLive: undefined }; },
  };
}
