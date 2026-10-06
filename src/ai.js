import { SFX } from './assets.js';
import { attacksFor, resolveAttackDef, combatInput, updateAttacks, updateProjectiles, resetCombat } from './combat.js';
import { resetTimeDilation, stepTimeDilation, resetDamageIndicators } from './fx.js';
import { GRAVITY, createFighter, handleFighterInput, stepFighterPhysics, applySoftPlayerSeparation, updateFighterState, resetAbilityCooldowns, createDefaultStage, resolvePlatformCollision, isInBlastZone, updatePlatforms } from './physics.js';
import { loadAccessoryFor, loadHandGearFor } from './render.js';


// ── merged from ai/ai-neural-network.js ──
// ai-neural-network.js — lightweight neural network for AI decision-making.
//
// The network NEVER executes actions directly. It produces action-preference
// scores (one per output) from a normalized game-state snapshot. ai.js reads
// those scores as bias terms on top of its existing scored pipelines
// (scoreAttacks + unified neutral movement scoring). The existing gameplay
// systems (combatInput cooldowns, hitstun locks, platform collision, resource
// limits) remain the sole authority on whether an action is legal.
//
// Architecture: INPUT_SIZE -> HIDDEN_SIZE -> OUTPUT_SIZE, tanh activations.
// Weights are a single flat Float64 array so genomes can crossover/mutate them
// trivially: [W1 (I*H), b1 (H), W2 (H*O), b2 (O)].

export const NN_INPUT_SIZE = 32;
export const NN_HIDDEN_SIZE = 16;
export const NN_OUTPUT_SIZE = 20;

// v3 unified combat: 32 inputs UNCHANGED (saved genomes stay loadable).
// ownPercent/oppPercent are now read alongside live fighter weight
// (70-130 scale) in ai.js scripted scoring; the net learns weight effects
// through KO/damage outcomes in fitness. Do not add inputs without bumping
// AI_MODEL_VERSION and rejecting mismatched weights.
export const NN_INPUT_LABELS = [
  'ownX', 'ownY', 'ownVx', 'ownVy', 'ownPercent', 'grounded', 'facing',
  'hitstun', 'blocking', 'dodging', 'canDoubleJump', 'canAerialLight',
  'dashReady', 'attackReady', 'distCenter', 'distEdge',
  'offStage', 'oppX', 'oppY', 'hDist', 'vDist', 'oppVx', 'oppVy',
  'oppPercent', 'oppGrounded', 'oppAttacking', 'oppBlocking', 'oppHitstun',
  'oppRecovery', 'stageCenter', 'stageWidth', 'distBlast',
];

// Output action preferences. Indices are stable — genomes trained against one
// version load against the same mapping. ai.js maps these onto its real moves.
export const NN_OUTPUT_LABELS = [
  'moveLeft', 'moveRight', 'stop', 'jump', 'block', 'dodge',
  'jab', 'ftilt', 'fsmash', 'utilt', 'usmash', 'dtilt', 'dsmash',
  'nsmash', 'aerialLight', 'aerialHeavy', 'dashAttack',
  'approach', 'retreat', 'recover',
];

export const NN_WEIGHT_COUNT =
  NN_INPUT_SIZE * NN_HIDDEN_SIZE + NN_HIDDEN_SIZE +
  NN_HIDDEN_SIZE * NN_OUTPUT_SIZE + NN_OUTPUT_SIZE;

function clamp1(v) {
  if (!Number.isFinite(v)) return 0;
  return v > 1 ? 1 : v < -1 ? -1 : v;
}

function randn() {
  // Box-Muller gaussian, mean 0 std 1.
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

export class NeuralNetwork {
  constructor(weights) {
    const I = NN_INPUT_SIZE, H = NN_HIDDEN_SIZE, O = NN_OUTPUT_SIZE;
    this.I = I; this.H = H; this.O = O;
    if (weights && weights.length === NN_WEIGHT_COUNT) {
      this.w = Float64Array.from(weights);
    } else {
      this.w = new Float64Array(NN_WEIGHT_COUNT);
      this.randomize();
    }
    // Scratch buffers reused across forwards (no per-frame allocation).
    this._hidden = new Float64Array(H);
    this._out = new Float64Array(O);
  }

  randomize(scale = 0.7) {
    for (let i = 0; i < this.w.length; i++) this.w[i] = randn() * scale;
  }

  getWeights() {
    return Array.from(this.w);
  }

  setWeights(arr) {
    if (!arr || arr.length !== NN_WEIGHT_COUNT) return false;
    for (let i = 0; i < arr.length; i++) {
      const v = arr[i];
      this.w[i] = Number.isFinite(v) ? Math.max(-8, Math.min(8, v)) : 0;
    }
    return true;
  }

  clone() {
    return new NeuralNetwork(this.w);
  }

  forward(inputs) {
    const { I, H, O, w, _hidden, _out } = this;
    const w1End = I * H;
    const b1End = w1End + H;
    const w2End = b1End + H * O;
    for (let h = 0; h < H; h++) {
      let s = w[w1End + h];
      for (let i = 0; i < I; i++) {
        const iv = (inputs && Number.isFinite(inputs[i])) ? inputs[i] : 0;
        s += iv * w[i * H + h];
      }
      _hidden[h] = Math.tanh(s);
    }
    for (let o = 0; o < O; o++) {
      let s = w[w2End + o];
      const base = b1End + o * H;
      for (let h = 0; h < H; h++) s += _hidden[h] * w[base + h];
      _out[o] = Math.tanh(s);
    }
    return _out;
  }

  // Controlled mutation: each weight perturbed with probability `rate` by
  // gaussian noise of std `strength`. Occasional larger kicks preserve
  // diversity (anti premature-convergence).
  mutate(rate = 0.05, strength = 0.25, bigKickChance = 0.02) {
    for (let i = 0; i < this.w.length; i++) {
      const r = Math.random();
      if (r < bigKickChance) {
        this.w[i] = randn() * 0.7;
      } else if (r < bigKickChance + rate) {
        this.w[i] += randn() * strength;
        if (this.w[i] > 8) this.w[i] = 8;
        else if (this.w[i] < -8) this.w[i] = -8;
      }
    }
  }

  // Uniform crossover: each weight picked from either parent. Returns a new
  // NeuralNetwork (child). Never just clones one parent.
  static crossover(a, b) {
    const child = new NeuralNetwork();
    const wa = a.w, wb = b.w, wc = child.w;
    for (let i = 0; i < wc.length; i++) {
      wc[i] = Math.random() < 0.5 ? wa[i] : wb[i];
    }
    return child;
  }
}

// ── Input builder ─────────────────────────────────────────────────────────
// Builds the 32 normalized inputs from live fighter state. Mirrors the
// perception fields ai.js already computes — no new physics, no caching.
// Reused input scratch: buildNNInputs runs once per AI decision and its result
// is consumed synchronously by forward(), so sharing one array is safe and
// saves a 32-element alloc + fill per decision.
const _nnInScratch = new Array(NN_INPUT_SIZE).fill(0);
export function buildNNInputs(f, opp, stage) {
  const out = _nnInScratch;
  for (let _zi = 0; _zi < NN_INPUT_SIZE; _zi++) out[_zi] = 0;
  if (!f) return out;
  const AW = 1080, AH = 1080;
  let g = null;
  try {
    if (stage && Array.isArray(stage.platforms)) {
      const _plats = stage.platforms;
      for (let _pi = 0; _pi < _plats.length; _pi++) {
        if (_plats[_pi].isGround) { g = _plats[_pi]; break; }
      }
      if (!g) g = _plats[0] || null;
    }
  } catch (_) { g = null; }
  const bz = (stage && stage.blastZones) || { left: -150, right: 1350, top: -225, bottom: 1250 };
  const centerX = g ? g.x + g.width / 2 : 600;
  const stageW = g ? g.width : 780;
  const edgeL = g ? g.x : 210, edgeR = g ? g.x + g.width : 990;
  const signedInside = g ? Math.min(f.x - edgeL, edgeR - f.x) : 999;
  const offStage = (!f.grounded && (f.x < edgeL - 20 || f.x > edgeR + 20 || (g && f.y > g.y + 10))) ? 1 : -1;
  const clampN = (v, s) => clamp1(v / s);

  out[0] = clamp1((f.x / AW) * 2 - 1);
  out[1] = clamp1((f.y / AH) * 2 - 1);
  out[2] = clampN(f.vx || 0, 600);
  out[3] = clampN(f.vy || 0, 1000);
  out[4] = clamp1((f.percent || 0) / 150);
  out[5] = f.grounded ? 1 : -1;
  out[6] = f.facingRight ? 1 : -1;
  out[7] = clamp1((f.hitstun || 0) / 0.75);
  out[8] = f.shielding ? 1 : -1;
  out[9] = f.dodging ? 1 : -1;
  out[10] = f.canDoubleJump ? 1 : -1;
  out[11] = f.canUseAerialLightRecovery ? 1 : -1;
  out[12] = (f.dodgeCooldown || 0) <= 0 ? 1 : -1;
  out[13] = (f.attackCooldown || 0) <= 0 ? 1 : -1;
  out[14] = clampN((f.x || 0) - centerX, 600);
  out[15] = clamp1(signedInside / 400);
  out[16] = offStage;
  if (opp) {
    out[17] = clamp1((opp.x / AW) * 2 - 1);
    out[18] = clamp1((opp.y / AH) * 2 - 1);
    out[19] = clamp1(Math.abs(opp.x - f.x) / 600);
    out[20] = clampN(opp.y - f.y, 600);
    out[21] = clampN(opp.vx || 0, 600);
    out[22] = clampN(opp.vy || 0, 1000);
    out[23] = clamp1((opp.percent || 0) / 150);
    out[24] = opp.grounded ? 1 : -1;
    out[25] = opp.attack ? 1 : -1;
    out[26] = opp.shielding ? 1 : -1;
    out[27] = clamp1((opp.hitstun || 0) / 0.75);
    let urg = 0;
    try {
      if (!opp.grounded && g) {
        const below = opp.y > g.y + 10;
        const outside = opp.x < edgeL - 20 || opp.x > edgeR + 20;
        urg = below ? 1 : outside ? 0.5 : 0;
      }
    } catch (_) { urg = 0; }
    out[28] = clamp1(urg);
  } else {
    out[17] = 0; out[18] = 0; out[19] = 1; out[20] = 0;
    out[21] = 0; out[22] = 0; out[23] = 0; out[24] = 1;
    out[25] = -1; out[26] = -1; out[27] = -1; out[28] = 0;
  }
  out[29] = clamp1((centerX / AW) * 2 - 1);
  out[30] = clamp1(stageW / 800);
  const dBlast = Math.min(f.x - bz.left, bz.right - f.x, bz.bottom - f.y);
  out[31] = clamp1(dBlast / 600);
  for (let i = 0; i < out.length; i++) if (!Number.isFinite(out[i])) out[i] = 0;
  return out;
}

// Map an owned attack key to the NN output index that biases it.
export function nnOutputForAttackKey(key) {
  switch (key) {
    case 'jab': return 6;
    case 'ftilt': case 'btilt': return 7;
    case 'fsmash': case 'bsmash': return 8;
    case 'utilt': return 9;
    case 'usmash': return 10;
    case 'dtilt': return 11;
    case 'dsmash': return 12;
    case 'nsmash': return 13;
    case 'aerialLight': return 14;
    case 'aerialHeavy': return 15;
    case 'dash': return 16;
    default: return 6;
  }
}


// ── merged from ai/ai-genetic-algorithm.js ──
// ai-genetic-algorithm.js — real evolutionary loop for Smash Fighters AI.
//
// Pipeline per generation:
//   1. population already initialized (random genomes)
//   2. fitness evaluated by REAL headless matches (see ai-training.js)
//   3. selection: elitism (top N survive untouched) + tournament selection
//   4. crossover: uniform per-weight blend of two parents + behavior blending
//   5. mutation: controlled gaussian perturbation of weights + behavior params
//   6. new population replaces the old; repeat.
//
// Genome:
//   { weights: [...], behavior: {...personality params...},
//     fitness, wins, stats }


export const GA_DEFAULTS = {
  eliteRate: 0.1,        // top 10% survive untouched
  tournamentSize: 3,     // tournament selection pressure
  mutationRate: 0.05,    // per-weight mutation probability
  mutationStrength: 0.25,// gaussian std for weight perturbation
  bigKickChance: 0.02,   // occasional full re-randomization of a weight
};

// Behavior parameter ranges — every individual samples its own profile so the
// population can develop genuinely different styles (rusher, spacer, turtler).
const BEHAVIOR_RANGES = {
  aggression: [0.2, 1.0],
  defense: [0.15, 0.9],
  reactionTime: [0.10, 0.24],
  attackFrequency: [0.3, 0.9],
  preferredRange: [70, 160],
  minimumSafeDistance: [35, 80],
  maximumEngagementDistance: [200, 320],
  riskTolerance: [0.15, 0.9],
  recoveryPriority: [0.7, 1.0],
  edgeguardPriority: [0.3, 0.95],
  comboPriority: [0.35, 0.95],
};

function randIn([lo, hi]) {
  return lo + Math.random() * (hi - lo);
}

export function randomBehavior() {
  const b = {};
  for (const k of Object.keys(BEHAVIOR_RANGES)) b[k] = randIn(BEHAVIOR_RANGES[k]);
  return b;
}

export function createGenome(weights, behavior) {
  const nn = weights ? new NeuralNetwork(weights) : new NeuralNetwork();
  return {
    weights: nn.getWeights(),
    behavior: behavior ? { ...behavior } : randomBehavior(),
    fitness: 0,
    wins: 0,
    matches: 0,
    stats: null,
  };
}

export function initPopulation(size) {
  const pop = [];
  const n = Math.max(2, Math.floor(size) || 50);
  for (let i = 0; i < n; i++) pop.push(createGenome());
  return pop;
}

export function cloneGenome(g) {
  return {
    weights: Array.isArray(g.weights) ? g.weights.slice() : new NeuralNetwork().getWeights(),
    behavior: { ...g.behavior },
    fitness: 0,
    wins: 0,
    matches: 0,
    stats: null,
  };
}

// ── Selection ─────────────────────────────────────────────────────────────
function sortedByFitness(pop) {
  return pop.slice().sort((a, b) => (b.fitness || 0) - (a.fitness || 0));
}

export function tournamentSelect(pop, tournamentSize = 3) {
  const n = pop.length;
  let best = null;
  const k = Math.max(2, Math.min(n, tournamentSize | 0));
  for (let i = 0; i < k; i++) {
    const cand = pop[(Math.random() * n) | 0];
    if (!best || (cand.fitness || 0) > (best.fitness || 0)) best = cand;
  }
  return best;
}

// ── Crossover ─────────────────────────────────────────────────────────────
// Child weights: uniform per-weight pick (real recombination, not a copy).
// Child behavior: per-param pick-or-blend of the parents.
export function crossoverGenomes(parentA, parentB) {
  const nnA = new NeuralNetwork(parentA.weights);
  const nnB = new NeuralNetwork(parentB.weights);
  const childNN = NeuralNetwork.crossover(nnA, nnB);
  const behavior = {};
  const keys = Object.keys(BEHAVIOR_RANGES);
  for (const k of keys) {
    const a = parentA.behavior[k], b = parentB.behavior[k];
    const r = Math.random();
    if (r < 0.4) behavior[k] = a;
    else if (r < 0.8) behavior[k] = b;
    else behavior[k] = (a + b) / 2; // blend keeps interpolation in the gene pool
  }
  return {
    weights: childNN.getWeights(),
    behavior,
    fitness: 0,
    wins: 0,
    matches: 0,
    stats: null,
  };
}

// ── Mutation ──────────────────────────────────────────────────────────────
function gauss() {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

export function mutateGenome(genome, mutationRate = 0.05, mutationStrength = 0.25, bigKickChance = 0.02) {
  const nn = new NeuralNetwork(genome.weights);
  nn.mutate(mutationRate, mutationStrength, bigKickChance);
  genome.weights = nn.getWeights();
  // Behavior params drift slightly (clamped to legal ranges).
  for (const k of Object.keys(BEHAVIOR_RANGES)) {
    if (Math.random() < 0.15) {
      const [lo, hi] = BEHAVIOR_RANGES[k];
      const span = hi - lo;
      genome.behavior[k] += gauss() * span * 0.08;
      if (genome.behavior[k] < lo) genome.behavior[k] = lo;
      if (genome.behavior[k] > hi) genome.behavior[k] = hi;
    }
  }
  return genome;
}

// ── Next generation ───────────────────────────────────────────────────────
// Elites (deep clones, fitness reset for the new season) survive untouched;
// the rest are tournament-selected crossover children + mutation.
export function nextGeneration(pop, opts = {}) {
  const cfg = { ...GA_DEFAULTS, ...opts };
  const n = pop.length;
  if (n === 0) return [];
  const ranked = sortedByFitness(pop);
  const eliteCount = Math.max(1, Math.round(n * cfg.eliteRate));
  const next = [];
  for (let i = 0; i < eliteCount && i < ranked.length; i++) {
    next.push(cloneGenome(ranked[i]));
  }
  let guard = 0;
  while (next.length < n && guard++ < n * 50) {
    const pA = tournamentSelect(ranked, cfg.tournamentSize);
    const pB = tournamentSelect(ranked, cfg.tournamentSize);
    // Avoid pure self-breeding when the population allows it.
    let b = pB, tries = 0;
    while (b === pA && ranked.length > 1 && tries++ < 4) {
      b = tournamentSelect(ranked, cfg.tournamentSize);
    }
    const child = crossoverGenomes(pA, b);
    mutateGenome(child, cfg.mutationRate, cfg.mutationStrength, cfg.bigKickChance);
    next.push(child);
  }
  return next;
}

// ── Fitness ──────────────────────────────────────────────────────────────────────
// Weighted multi-factor fitness. No single metric dominates: winning matters
// most but damage, aggression quality, defense, positioning, variety and
// efficiency all contribute, while passivity, recklessness, spam and whiffing
// are penalized.
//
// `s` is the per-match stat bundle recorded by the headless harness (see
// ai-training.js runHeadlessMatch). All fields are plain numbers.
// computeFitnessBreakdown exposes the parts so the outcome review can show
// WHAT the AI is being rewarded for - same total as computeFitness.
function statNum(v) {
  return Number.isFinite(v) ? v : 0;
}

export function computeFitnessBreakdown(s) {
  const n = statNum;
  const parts = { win: 0, stocks: 0, damage: 0, offense: 0, defense: 0, position: 0, variety: 0, penalties: 0 };
  if (!s || typeof s !== 'object') return { total: 0, parts };
  // Positive: winning, damage, clean KOs, successful offense/defense.
  parts.win = 500 * n(s.win);
  parts.stocks = 120 * n(s.stocksTaken);
  parts.damage = 3.0 * n(s.damageDealt);
  parts.offense = 10 * n(s.hitsLanded)
    + 6 * n(s.combos)
    + 8 * n(s.punishes)
    + 12 * n(s.edgeguards);
  parts.defense = 4 * n(s.blocks)
    + 4 * n(s.dodges)
    + 15 * n(s.recoveries)
    + recoveryRateBonus(s);
  parts.position = 0.4 * Math.min(1500, n(s.centerTime))
    + 0.15 * Math.min(2000, n(s.aliveFrames));
  parts.variety = varietyScore(s);
  // Negative: taking damage, dying, waste, passivity, recklessness, spam.
  parts.penalties = -(2.0 * n(s.damageTaken)
    + 150 * n(s.stocksLost)
    + 5 * n(s.whiffs)
    + 3 * n(s.wastedRecoveries)
    + 0.25 * Math.min(3000, n(s.idleFrames))
    + 0.3 * Math.min(2000, n(s.offStageFrames))
    + 2 * n(s.failedActions)
    + spamPenalty(s));
  const total = parts.win + parts.stocks + parts.damage + parts.offense
    + parts.defense + parts.position + parts.variety + parts.penalties;
  if (!Number.isFinite(total)) return { total: 0, parts };
  return { total, parts };
}

// Recovery efficiency: successfully converting off-stage escapes into
// recoveries, on top of the flat per-recovery reward above.
function recoveryRateBonus(s) {
  const att = statNum(s.recoveryAttempts);
  if (att < 2) return 0;
  const rec = statNum(s.recoveries);
  return 25 * Math.max(0, Math.min(1, rec / att));
}

// Move variety: entropy bonus for using the kit (capped), so full-kit usage
// beats one-button spam without randomness for its own sake. Needs
// s.moveUses {key: count}; absent (old bundles) = neutral zero.
function varietyScore(s) {
  const uses = s.moveUses;
  if (!uses || typeof uses !== 'object') return 0;
  let total = 0;
  for (const k of Object.keys(uses)) total += statNum(uses[k]);
  if (total < 4) return 0;
  let ent = 0;
  for (const k of Object.keys(uses)) {
    const p = statNum(uses[k]) / total;
    if (p > 0) ent -= p * Math.log(p);
  }
  return Math.min(120, ent * 60);
}

// Spam penalty: one move dominating the offense. Zero for varied play.
function spamPenalty(s) {
  const uses = s.moveUses;
  if (!uses || typeof uses !== 'object') return 0;
  let total = 0, top = 0;
  for (const k of Object.keys(uses)) {
    const v = statNum(uses[k]);
    total += v;
    if (v > top) top = v;
  }
  if (total < 6) return 0;
  const share = top / total;
  if (share <= 0.6) return 0;
  return (share - 0.6) * 400;
}

export function computeFitness(s) {
  return computeFitnessBreakdown(s).total;
}

export function populationStats(pop) {
  if (!pop.length) return { best: 0, avg: 0, worst: 0, bestWins: 0 };
  let best = -Infinity, worst = Infinity, sum = 0, bestWins = 0;
  for (const g of pop) {
    const f = g.fitness || 0;
    if (f > best) { best = f; bestWins = g.wins || 0; }
    if (f < worst) worst = f;
    sum += f;
  }
  return { best, avg: sum / pop.length, worst, bestWins };
}

export function bestOf(pop) {
  let best = null;
  for (const g of pop) {
    if (!best || (g.fitness || 0) > (best.fitness || 0)) best = g;
  }
  return best;
}


// ── merged from ai/ai-model-storage.js ──
// ai-model-storage.js — persistence for trained AI models.
//
// Two layers, one pattern (localStorage JSON, try/catch everywhere so a
// corrupt profile can never crash the game):
//   v1 (legacy): one entry per character id — the latest training result.
//     Kept for backward compatibility: old saves still load.
//   v2 (current): per-character MODEL LIBRARIES (many versions, one active),
//     training-run history, and resume checkpoints.
//
// Model data is small (868 float weights ≈ ~15KB JSON), so localStorage is
// the suitable store — no IndexedDB needed. Every mutation validates BEFORE
// writing; a failed write leaves the previous valid store untouched.


const STORE_KEY = 'smashfighters.trainedModels.v1';
const STORE2_KEY = 'smashfighters.aiModels.v2';
const MODEL_FORMAT = 'smashfighters-ai-model';
export const AI_MODEL_VERSION = 3; // v3 = unified Smash combat (weight 70-130, J/K categories)
// Migration: v1/v2 genomes share the 32-input layout and load as LEGACY
// (usable, flagged legacy:true so Hard+ blends less neuro influence until retrained).
// Any future input-size change must bump this and reject mismatched weights.
export function modelVersionOf(m) { return (m && m.version) || ((m && m.weights) ? 1 : 0); }
export function isLegacyModel(m) { const v = modelVersionOf(m); return v > 0 && v < AI_MODEL_VERSION; }
const MODEL_FORMAT_VERSION = 1;
const MAX_HISTORY = 100;

function readStore() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (_) {
    return {};
  }
}

function writeStore(store) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(store));
    return true;
  } catch (_) {
    return false;
  }
}

export function nnArch() {
  return { inputs: NN_INPUT_SIZE, hidden: NN_HIDDEN_SIZE, outputs: NN_OUTPUT_SIZE };
}

function validWeights(w) {
  return Array.isArray(w) && w.length === NN_WEIGHT_COUNT && w.every(Number.isFinite);
}

function validBehavior(b) {
  return b && typeof b === 'object' && !Array.isArray(b);
}

// ── v1 legacy API (unchanged behavior) ────────────────────────────────────

// Save the best genome of a training run for a character.
export function saveTrainedModel(charId, data) {
  if (!charId || !data || !validWeights(data.weights)) return false;
  try {
    const store = readStore();
    store[charId] = {
      version: AI_MODEL_VERSION,
      character: charId,
      opponent: data.opponent || null,
      arch: nnArch(),
      weights: data.weights.slice(),
      behavior: { ...(data.behavior || {}) },
      fitness: Number.isFinite(data.fitness) ? data.fitness : 0,
      wins: Number.isFinite(data.wins) ? data.wins : 0,
      generation: Number.isFinite(data.generation) ? data.generation : 0,
      config: { ...(data.config || {}) },
      savedAt: new Date().toISOString(),
    };
    return writeStore(store);
  } catch (_) {
    return false;
  }
}

// Load the trained model for a character. Prefers the v2 active model;
// falls back to a v1 entry (or a lazily migrated one) when none exists.
// Returns null when nothing valid exists — callers must use scripted AI.
export function loadTrainedModel(charId) {
  if (!charId) return null;
  try {
    const active = getActiveModel(charId);
    if (active) return active;
  } catch (_) {}
  try {
    const store = readStore();
    const m = store[charId];
    if (!m || typeof m !== 'object') return null;
    if (!m.arch || m.arch.inputs !== NN_INPUT_SIZE || m.arch.hidden !== NN_HIDDEN_SIZE || m.arch.outputs !== NN_OUTPUT_SIZE) return null;
    if (!validWeights(m.weights)) return null;
    if (isLegacyModel(m)) return { ...m, legacy: true };
    return m;
  } catch (_) {
    return null;
  }
}

export function hasTrainedModel(charId) {
  return loadTrainedModel(charId) !== null;
}

export function listTrainedModels() {
  try {
    const out = [];
    const seen = new Set();
    // v2 actives first (current), then any v1-only entries.
    try {
      const s2 = readStore2();
      for (const cid of Object.keys(s2.chars || {})) {
        const active = getActiveModel(cid);
        if (active) {
          seen.add(cid);
          out.push({
            character: cid,
            opponent: active.opponent || null,
            fitness: active.fitness || 0,
            generation: active.generation || 0,
            savedAt: active.savedAt || null,
          });
        }
      }
    } catch (_) {}
    const store = readStore();
    for (const k of Object.keys(store)) {
      if (seen.has(k)) continue;
      out.push({
        character: k,
        opponent: store[k].opponent || null,
        fitness: store[k].fitness || 0,
        generation: store[k].generation || 0,
        savedAt: store[k].savedAt || null,
      });
    }
    return out;
  } catch (_) {
    return [];
  }
}

export function deleteTrainedModel(charId) {
  // Deletes from BOTH layers so no ghost entry survives in either.
  let ok = false;
  try {
    const store = readStore();
    if (charId in store) {
      delete store[charId];
      ok = writeStore(store) || ok;
    }
  } catch (_) {}
  try {
    const s2 = readStore2();
    if (s2.chars && s2.chars[charId]) {
      delete s2.chars[charId];
      delete s2.checkpoints[charId];
      ok = writeStore2(s2) || ok;
    } else {
      ok = true;
    }
  } catch (_) {}
  return ok;
}

export function clearTrainedModels() {
  let ok = true;
  try {
    localStorage.removeItem(STORE_KEY);
  } catch (_) { ok = false; }
  try {
    localStorage.removeItem(STORE2_KEY);
  } catch (_) { ok = false; }
  return ok;
}

// ── v2 model libraries ────────────────────────────────────────────────────

function blankStore2() {
  return { version: 2, chars: {}, history: [], checkpoints: {} };
}

function readStore2() {
  try {
    const raw = localStorage.getItem(STORE2_KEY);
    if (!raw) {
      const fresh = blankStore2();
      migrateV1Into(fresh);
      return fresh;
    }
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return blankStore2();
    if (!parsed.chars || typeof parsed.chars !== 'object') parsed.chars = {};
    if (!Array.isArray(parsed.history)) parsed.history = [];
    if (!parsed.checkpoints || typeof parsed.checkpoints !== 'object') parsed.checkpoints = {};
    return parsed;
  } catch (_) {
    return blankStore2();
  }
}

function writeStore2(s2) {
  try {
    localStorage.setItem(STORE2_KEY, JSON.stringify(s2));
    return true;
  } catch (_) {
    return false;
  }
}

// One-time lazy migration: v1 single-model entries become v2 library models
// named "Legacy Gn". Runs on first v2 read when v2 is absent; never deletes v1.
function migrateV1Into(s2) {
  try {
    const v1 = readStore();
    let moved = false;
    for (const cid of Object.keys(v1)) {
      const m = v1[cid];
      if (!m || !validWeights(m.weights)) continue;
      if (s2.chars[cid]) continue;
      const id = newModelId();
      s2.chars[cid] = {
        activeId: id,
        models: {
          [id]: {
            id,
            name: `Legacy G${m.generation || 0}`,
            character: cid,
            modelVersion: 1,
            format: MODEL_FORMAT,
            arch: nnArch(),
            weights: m.weights.slice(),
            behavior: { ...(m.behavior || {}) },
            fitness: Number.isFinite(m.fitness) ? m.fitness : 0,
            wins: Number.isFinite(m.wins) ? m.wins : 0,
            matches: 0,
            generation: Number.isFinite(m.generation) ? m.generation : 0,
            opponent: m.opponent || null,
            mode: 'matchup',
            config: { ...(m.config || {}) },
            eval: null,
            savedAt: m.savedAt || new Date().toISOString(),
          },
        },
      };
      moved = true;
    }
    if (moved) writeStore2(s2);
  } catch (_) {}
}

function newModelId() {
  try {
    return 'm_' + Date.now().toString(36) + '_' + Math.floor(Math.random() * 0xffffff).toString(36);
  } catch (_) {
    return 'm_' + Math.floor(Math.random() * 1e12).toString(36);
  }
}

function cleanName(name, fallback) {
  const s = String(name == null ? fallback : name).trim().slice(0, 40);
  return s || fallback;
}

// Validate a full model record for a character. Returns { ok, error }.
export function validateModelFor(charId, m) {
  if (!m || typeof m !== 'object') return { ok: false, error: 'not an object' };
  if (m.format && m.format !== MODEL_FORMAT) return { ok: false, error: 'unknown format' };
  if (m.modelVersion != null && m.modelVersion !== MODEL_FORMAT_VERSION) {
    return { ok: false, error: `unsupported version ${m.modelVersion}` };
  }
  if (m.character && charId && m.character !== charId) {
    return { ok: false, error: `character mismatch (${m.character} != ${charId})` };
  }
  if (m.arch && (m.arch.inputs !== NN_INPUT_SIZE || m.arch.hidden !== NN_HIDDEN_SIZE || m.arch.outputs !== NN_OUTPUT_SIZE)) {
    return { ok: false, error: 'architecture mismatch' };
  }
  if (!validWeights(m.weights)) return { ok: false, error: 'bad weights' };
  if (m.behavior != null && !validBehavior(m.behavior)) return { ok: false, error: 'bad behavior' };
  return { ok: true };
}

function summarizeModel(m) {
  return {
    id: m.id,
    name: m.name,
    character: m.character,
    fitness: m.fitness || 0,
    wins: m.wins || 0,
    matches: m.matches || 0,
    generation: m.generation || 0,
    opponent: m.opponent || null,
    mode: m.mode || 'matchup',
    savedAt: m.savedAt || null,
    active: !!m.active,
    hasEval: !!m.eval,
    winRate: m.eval && m.eval.matches ? m.eval.wins / m.eval.matches : null,
  };
}

// Save a new versioned model for a character (never overwrites history).
// Returns { ok, id?, error? }.
export function saveModelVersion(charId, data, opts = {}) {
  if (!charId) return { ok: false, error: 'no character' };
  const v = validateModelFor(charId, { ...(data || {}), character: charId });
  if (!v.ok) return { ok: false, error: v.error };
  try {
    const s2 = readStore2();
    if (!s2.chars[charId]) s2.chars[charId] = { activeId: null, models: {} };
    const id = newModelId();
    const now = new Date().toISOString();
    s2.chars[charId].models[id] = {
      id,
      name: cleanName(opts.name, `G${Number.isFinite(data.generation) ? data.generation : 0} ${now.slice(0, 10)}`),
      character: charId,
      modelVersion: MODEL_FORMAT_VERSION,
      format: MODEL_FORMAT,
      arch: nnArch(),
      weights: data.weights.slice(),
      behavior: { ...(data.behavior || {}) },
      fitness: Number.isFinite(data.fitness) ? data.fitness : 0,
      wins: Number.isFinite(data.wins) ? data.wins : 0,
      matches: Number.isFinite(data.matches) ? data.matches : 0,
      generation: Number.isFinite(data.generation) ? data.generation : 0,
      opponent: data.opponent || null,
      mode: data.mode || 'matchup',
      config: { ...(data.config || {}) },
      eval: data.eval && typeof data.eval === 'object' ? { ...data.eval } : null,
      convertedFrom: data.convertedFrom || null,
      savedAt: now,
    };
    // First model for a character becomes active automatically.
    if (!s2.chars[charId].activeId) s2.chars[charId].activeId = id;
    if (opts.activate) s2.chars[charId].activeId = id;
    if (!writeStore2(s2)) return { ok: false, error: 'storage full or unavailable' };
    return { ok: true, id };
  } catch (e) {
    return { ok: false, error: 'save failed' };
  }
}

export function listModels(charId) {
  try {
    const s2 = readStore2();
    const c = s2.chars[charId];
    if (!c) return [];
    return Object.values(c.models || {})
      .sort((a, b) => String(b.savedAt || '').localeCompare(String(a.savedAt || '')))
      .map((m) => summarizeModel({ ...m, active: c.activeId === m.id }));
  } catch (_) {
    return [];
  }
}

export function getModel(charId, id) {
  try {
    const s2 = readStore2();
    const m = s2.chars[charId] && s2.chars[charId].models[id];
    if (!m) return null;
    return { ...m, weights: m.weights.slice(), behavior: { ...m.behavior }, active: s2.chars[charId].activeId === id };
  } catch (_) {
    return null;
  }
}

export function getActiveModel(charId) {
  try {
    const s2 = readStore2();
    const c = s2.chars[charId];
    if (!c || !c.activeId) return null;
    const m = c.models[c.activeId];
    if (!m || !validWeights(m.weights)) return null;
    // Shape matches the v1 record so gameplay loaders need no changes.
    return {
      version: 1,
      character: charId,
      opponent: m.opponent || null,
      arch: nnArch(),
      weights: m.weights.slice(),
      behavior: { ...(m.behavior || {}) },
      fitness: m.fitness || 0,
      wins: m.wins || 0,
      generation: m.generation || 0,
      config: { ...(m.config || {}) },
      savedAt: m.savedAt || null,
      modelId: m.id,
      modelName: m.name,
    };
  } catch (_) {
    return null;
  }
}

export function activateModel(charId, id) {
  try {
    const s2 = readStore2();
    const c = s2.chars[charId];
    if (!c || !c.models[id]) return false;
    c.activeId = id;
    return writeStore2(s2);
  } catch (_) {
    return false;
  }
}

export function renameModel(charId, id, name) {
  const clean = cleanName(name, '');
  if (!clean) return false;
  try {
    const s2 = readStore2();
    const m = s2.chars[charId] && s2.chars[charId].models[id];
    if (!m) return false;
    m.name = clean;
    return writeStore2(s2);
  } catch (_) {
    return false;
  }
}

export function duplicateModel(charId, id, name) {
  try {
    const src = getModel(charId, id);
    if (!src) return { ok: false, error: 'not found' };
    return saveModelVersion(charId, { ...src }, { name: cleanName(name, src.name + ' copy') });
  } catch (_) {
    return { ok: false, error: 'duplicate failed' };
  }
}

export function deleteModel(charId, id) {
  try {
    const s2 = readStore2();
    const c = s2.chars[charId];
    if (!c || !c.models[id]) return false;
    delete c.models[id];
    if (c.activeId === id) {
      const rest = Object.values(c.models).sort((a, b) =>
        String(b.savedAt || '').localeCompare(String(a.savedAt || '')));
      c.activeId = rest.length ? rest[0].id : null;
    }
    if (!Object.keys(c.models).length) delete s2.chars[charId];
    return writeStore2(s2);
  } catch (_) {
    return false;
  }
}

export function attachEval(charId, id, evalSummary) {
  try {
    const s2 = readStore2();
    const m = s2.chars[charId] && s2.chars[charId].models[id];
    if (!m) return false;
    m.eval = evalSummary && typeof evalSummary === 'object' ? { ...evalSummary } : null;
    return writeStore2(s2);
  } catch (_) {
    return false;
  }
}

// ── Export / import ───────────────────────────────────────────────────────

export function exportModel(charId, id) {
  try {
    const m = getModel(charId, id);
    if (!m) return { ok: false, error: 'not found' };
    const payload = {
      format: MODEL_FORMAT,
      formatVersion: MODEL_FORMAT_VERSION,
      exportedAt: new Date().toISOString(),
      game: 'smashfighters',
      model: m,
    };
    return { ok: true, json: JSON.stringify(payload) };
  } catch (_) {
    return { ok: false, error: 'export failed' };
  }
}

// Import a model JSON string. options: { charId (target), overwriteName?,
// allowConvert (accept a model trained as another character, flagged) }.
// Never overwrites an existing model: imports always create a NEW version.
// Returns { ok, id?, name?, converted?, error? }.
export function importModel(json, options = {}) {
  let payload;
  try {
    payload = JSON.parse(json);
  } catch (_) {
    return { ok: false, error: 'not valid JSON' };
  }
  const m = payload && payload.model ? payload.model : payload;
  if (!m || typeof m !== 'object') return { ok: false, error: 'no model payload' };
  if (payload.format && payload.format !== MODEL_FORMAT && m.format !== MODEL_FORMAT) {
    return { ok: false, error: 'not a smashfighters model file' };
  }
  const target = options.charId || m.character;
  if (!target) return { ok: false, error: 'no target character' };
  let converted = null;
  const data = { ...m };
  if (data.character && data.character !== target && !options.allowConvert) {
    return { ok: false, error: `character mismatch (${data.character} != ${target})` };
  }
  if (data.character && data.character !== target && options.allowConvert) {
    converted = data.character;
    data.character = target;
  }
  const v = validateModelFor(target, data);
  if (!v.ok) return { ok: false, error: v.error };
  const res = saveModelVersion(target, { ...data, convertedFrom: converted }, {
    name: options.overwriteName || `${data.name || 'Imported'} (imported)`,
  });
  if (!res.ok) return res;
  return { ok: true, id: res.id, converted };
}

// ── Training-run history ──────────────────────────────────────────────────

export function saveRunRecord(rec) {
  try {
    const s2 = readStore2();
    const now = new Date().toISOString();
    const id = 'r_' + Date.now().toString(36) + '_' + Math.floor(Math.random() * 0xffffff).toString(36);
    s2.history.push({
      id,
      startedAt: (rec && rec.startedAt) || now,
      finishedAt: now,
      charA: (rec && rec.charA) || null,
      charB: (rec && rec.charB) || null,
      mode: (rec && rec.mode) || 'matchup',
      oppType: (rec && rec.oppType) || 'coevolve',
      opponent: (rec && rec.opponent) || null,
      config: (rec && rec.config && typeof rec.config === 'object') ? { ...rec.config } : {},
      generations: (rec && Number.isFinite(rec.generations)) ? rec.generations : 0,
      matches: (rec && Number.isFinite(rec.matches)) ? rec.matches : 0,
      bestFitness: (rec && Number.isFinite(rec.bestFitness)) ? rec.bestFitness : 0,
      avgFitness: (rec && Number.isFinite(rec.avgFitness)) ? rec.avgFitness : 0,
      winsA: (rec && Number.isFinite(rec.winsA)) ? rec.winsA : 0,
      winsB: (rec && Number.isFinite(rec.winsB)) ? rec.winsB : 0,
      savedModelIds: Array.isArray(rec && rec.savedModelIds) ? rec.savedModelIds.slice(0, 8) : [],
      status: (rec && rec.status) || 'done',
      warnings: Array.isArray(rec && rec.warnings) ? rec.warnings.slice(0, 8) : [],
      fitnessCurve: Array.isArray(rec && rec.fitnessCurve) ? rec.fitnessCurve.slice(0, 2000).map(Number).filter(Number.isFinite) : [],
    });
    while (s2.history.length > MAX_HISTORY) s2.history.shift();
    if (!writeStore2(s2)) return { ok: false, error: 'storage full or unavailable' };
    return { ok: true, id };
  } catch (_) {
    return { ok: false, error: 'save failed' };
  }
}

export function listRunHistory(limit = 50) {
  try {
    const s2 = readStore2();
    return s2.history.slice(-Math.max(1, limit | 0)).reverse().map((r) => ({ ...r }));
  } catch (_) {
    return [];
  }
}

export function getRun(id) {
  try {
    const s2 = readStore2();
    const r = s2.history.find((x) => x && x.id === id);
    return r ? { ...r } : null;
  } catch (_) {
    return null;
  }
}

export function clearRunHistory() {
  try {
    const s2 = readStore2();
    s2.history = [];
    return writeStore2(s2);
  } catch (_) {
    return false;
  }
}

// ── Checkpoints (resume training later) ───────────────────────────────────
// Small by design: best genomes + generation + config, not full populations.
// Resume re-seeds populations around the checkpoint bests.
export function saveCheckpoint(charId, data) {
  if (!charId || !data || !validWeights(data.weights)) return false;
  try {
    const s2 = readStore2();
    s2.checkpoints[charId] = {
      weights: data.weights.slice(),
      behavior: { ...(data.behavior || {}) },
      fitness: Number.isFinite(data.fitness) ? data.fitness : 0,
      generation: Number.isFinite(data.generation) ? data.generation : 0,
      opponent: data.opponent || null,
      mode: data.mode || 'matchup',
      config: { ...(data.config || {}) },
      savedAt: new Date().toISOString(),
    };
    return writeStore2(s2);
  } catch (_) {
    return false;
  }
}

export function loadCheckpoint(charId) {
  try {
    const s2 = readStore2();
    const c = s2.checkpoints[charId];
    if (!c || !validWeights(c.weights)) return null;
    return { ...c, weights: c.weights.slice(), behavior: { ...c.behavior } };
  } catch (_) {
    return null;
  }
}

export function clearCheckpoint(charId) {
  try {
    const s2 = readStore2();
    if (charId) delete s2.checkpoints[charId];
    else s2.checkpoints = {};
    return writeStore2(s2);
  } catch (_) {
    return false;
  }
}


// ── merged from ai/ai.js ──
// ai.js — Dedicated AI system for Smash Fighters.
//
// Architecture: each AI-controlled fighter owns ONE AIController. Every frame
// Game.js calls controller.update(dt, now, stage), then reads synthetic inputs
// via controller.getInput() — an { isHeld, isJustPressed, isJustReleased }
// triple with the SAME signature as Input.js. Those triples are passed to BOTH
// handleFighterInput (movement/jump/dodge/up-special) AND combatInput
// (attacks/shield), so the AI drives the EXACT same code paths as a human
// player: no parallel movement, no parallel attack spawning, no desync.
//
// Separation: ALL AI logic lives here. Fighter.js / combat.js never import
// this file for decisions — they only consume the synthetic input triple.
// Player input/control logic is untouched.
//
// Perception: every decision builds a full situation snapshot (own + opponent
// position, h/v distance, above/below, grounded/airborne, velocities, stage +
// blast geometry, percents, attack/hitstun/knockback/cooldown state,
// double-jump + Aerial-Light availability, opponent attack/vulnerability/
// recovery state). Movement, attack, combo, defense, recovery and edgeguard
// all read the SAME perception object.
//
// Resources (double jump / aerial-light recovery / up-special free-fall) are
// NEVER cached: every decision reads fighter.canDoubleJump,
// fighter.canUseAerialLightRecovery and fighter.freeFall live, so AI tracking
// cannot desynchronize from the character state. Landing recharges both (see
// Fighter.js stepFighterPhysics + Stage.js resolvePlatformCollision).
//
// No timers, no intervals, no event listeners, no DOM access — all state lives
// on the controller and is dropped on reset()/dispose(), so mode switches and
// restarts cannot leak.


// ── Personality ─────────────────────────────────────────────────────────────
// Configurable per-controller parameters. They influence DECISION SCORING —
// never replace the underlying logic. Game.js constructs AIvsAI with slightly
// different personalities so the two fighters naturally diverge (the fight
// emerges from independent decisions, never a script).
const AI_PARAMS = {
  aggression: 0.7,       // 0 = passive spacer, 1 = relentless pressure
  defense: 0.55,         // 0 = never blocks, 1 = very reactive blocker/dodger
  reactionTime: 0.16,    // seconds between reassessments (lower = twitchier)
  attackFrequency: 0.62, // base chance to strike when in range (0..1)
  preferredRange: 110,   // px horizontal distance the AI likes to fight at
  minimumSafeDistance: 55,   // px — closer than this feels crowded: create space
  maximumEngagementDistance: 260, // px — farther than this: approach/zone
  riskTolerance: 0.5,    // 0 = only safe pokes, 1 = frequent smash attempts
  recoveryPriority: 1.0, // 0..1 urgency multiplier for spending recovery resources
  edgeguardPriority: 0.6,// 0 = never leaves stage, 1 = deep pursuits
  comboPriority: 0.7,    // 0 = never chases, 1 = always chases follow-ups
  decisionInterval: 0.16,// legacy alias of reactionTime (seconds)
};

function resolvePersonality(overrides) {
  const base = { ...AI_PARAMS };
  if (overrides && typeof overrides === 'object') {
    for (const k of Object.keys(base)) {
      if (typeof overrides[k] === 'number' && Number.isFinite(overrides[k])) base[k] = overrides[k];
    }
  }
  // reactionTime and decisionInterval stay in sync (either may be set).
  if (overrides && typeof overrides.reactionTime === 'number') base.decisionInterval = base.reactionTime;
  else if (overrides && typeof overrides.decisionInterval === 'number') base.reactionTime = base.decisionInterval;
  return base;
}

// ── AI difficulty ─────────────────────────────────────────────────────────
// Difficulty changes DECISION QUALITY, not speed: reaction time, defensive
// reliability, attack selection discipline, combo/edgeguard sophistication,
// neural-network influence, and deliberate mistake rate. Higher difficulties
// decide better; lower ones fumble, hesitate and pick worse moves.
const AI_DIFFICULTIES = ['Easy', 'Normal', 'Hard', 'Expert', 'Trained'];

const AI_DIFFICULTY_PRESETS = {
  Easy: {
    reactionTime: 0.30, defense: 0.25, attackFrequency: 0.38,
    aggression: 0.40, riskTolerance: 0.30, edgeguardPriority: 0.30,
    comboPriority: 0.35, neuroInfluence: 0, mistakeRate: 0.28,
  },
  Normal: {
    reactionTime: 0.22, defense: 0.45, attackFrequency: 0.55,
    aggression: 0.60, riskTolerance: 0.50, edgeguardPriority: 0.55,
    comboPriority: 0.60, neuroInfluence: 0, mistakeRate: 0.14,
  },
  Hard: {
    reactionTime: 0.16, defense: 0.60, attackFrequency: 0.68,
    aggression: 0.70, riskTolerance: 0.60, edgeguardPriority: 0.70,
    comboPriority: 0.75, neuroInfluence: 0.5, mistakeRate: 0.06,
  },
  Expert: {
    reactionTime: 0.12, defense: 0.72, attackFrequency: 0.78,
    aggression: 0.80, riskTolerance: 0.70, edgeguardPriority: 0.85,
    comboPriority: 0.85, neuroInfluence: 0.85, mistakeRate: 0.02,
  },
  Trained: {
    reactionTime: 0.12, defense: 0.72, attackFrequency: 0.78,
    aggression: 0.80, riskTolerance: 0.70, edgeguardPriority: 0.85,
    comboPriority: 0.85, neuroInfluence: 1.0, mistakeRate: 0.0,
  },
};

function difficultyPreset(name) {
  return AI_DIFFICULTY_PRESETS[name] || AI_DIFFICULTY_PRESETS.Normal;
}

// Build the full controller config for a difficulty + character: personality
// overrides, mistake rate, and (for Hard+) the trained neural model when one
// exists for that character. Falls back to pure scripted AI — never crashes,
// never invents a fake model.
function configForDifficulty(name, charId) {
  const preset = difficultyPreset(name);
  const out = {
    personality: { ...preset },
    mistakeRate: preset.mistakeRate,
    neuroInfluence: preset.neuroInfluence,
    neuroWeights: null,
    difficulty: name,
  };
  delete out.personality.neuroInfluence;
  delete out.personality.mistakeRate;
  if ((name === 'Hard' || name === 'Expert' || name === 'Trained') && charId) {
    try {
      const model = loadTrainedModel(charId);
      if (model && Array.isArray(model.weights)) {
        out.neuroWeights = model.weights;
        // v3 migration: legacy (pre-unified-combat) genomes load but blend at
        // half influence until retrained on the new physics.
        if (model.legacy) out.neuroInfluence = (out.neuroInfluence || 0) * 0.5;
        if (name === 'Trained' && model.behavior && typeof model.behavior === 'object') {
          // The trained genome's behavior IS the personality on Trained.
          for (const k of Object.keys(out.personality)) {
            if (typeof model.behavior[k] === 'number' && Number.isFinite(model.behavior[k])) {
              out.personality[k] = model.behavior[k];
            }
          }
        }
      } else if (name === 'Trained') {
        // No model: fall back to Expert scripted, no network.
        const fb = difficultyPreset('Expert');
        out.personality = { ...fb };
        delete out.personality.neuroInfluence;
        delete out.personality.mistakeRate;
        out.mistakeRate = fb.mistakeRate;
        out.neuroInfluence = 0;
      } else {
        out.neuroInfluence = 0; // Hard/Expert without a model = strong scripted
      }
    } catch (_) {
      if (name !== 'Hard' && name !== 'Expert') { out.neuroInfluence = 0; }
      else out.neuroInfluence = 0;
    }
  } else if (name !== 'Hard' && name !== 'Expert' && name !== 'Trained') {
    out.neuroInfluence = 0;
    out.neuroWeights = null;
  }
  return out;
}

// All synthetic button names the AI can hold. Must cover every action the
// movement + combat systems read: left/right/up/down/jump/attack/special/
// shield/dodge (grab is pause — the AI never touches it).
const BUTTONS = ['left', 'right', 'up', 'down', 'jump', 'attack', 'special', 'shield', 'dodge'];
const _availKeysCache = new Map();
const _AVAIL_KEYS_FALLBACK = ['jab', 'nsmash', 'ftilt', 'fsmash', 'utilt', 'usmash', 'dtilt', 'dsmash', 'aerialLight', 'aerialHeavy'];

function emptyHeld() {
  return { left: false, right: false, up: false, down: false, jump: false, attack: false, special: false, shield: false, dodge: false };
}

// Button glyph for the AI debug read-out, in the same order the old per-frame
// build used. Called on demand (probe getDebug) instead of every AI frame.
function holdString(held) {
  return `${held.left ? 'L' : ''}${held.right ? 'R' : ''}${held.jump ? 'J' : ''}${held.attack ? 'A' : ''}${held.special ? 'S' : ''}${held.shield ? 'B' : ''}${held.dodge ? 'D' : ''}${held.up ? 'U' : ''}${held.down ? 'N' : ''}`;
}

function mainGround(stage) {
  if (!stage || !Array.isArray(stage.platforms)) return null;
  // Index loop, not .find(p => p.isGround): this runs on the AI's recovery /
  // off-stage reads, and a 2-element platform list doesn't need a predicate
  // closure built and invoked for it.
  const plats = stage.platforms;
  for (let i = 0; i < plats.length; i++) {
    if (plats[i].isGround) return plats[i];
  }
  return plats[0] || null;
}

// Recovery urgency for a fighter given the REAL stage:
// 0 = safe (grounded or above solid ground), 1 = off-stage (airborne outside
// the main ground's horizontal span — steer back), 2 = urgent (below the main
// ground top or outside blast zones — spend resources NOW).
function recoveryUrgency(f, stage) {
  if (!f) return 0;
  if (f.grounded) return 0;
  if (!stage) {
    if (f.x < 0 || f.x > 1080 || f.y < -100 || f.y > 1080) return 2;
    return 0;
  }
  const g = mainGround(stage);
  const bz = stage.blastZones || { left: -150, right: 1350, top: -225, bottom: 1250 };
  if (f.x < bz.left || f.x > bz.right || f.y < bz.top || f.y > bz.bottom) return 2;
  if (!g) return 0;
  const belowTop = f.y > g.y + 10;
  const outsideX = f.x < g.x - 20 || f.x > g.x + g.width + 20;
  if (belowTop) return 2;
  if (outsideX) return 1;
  return 0;
}

function isOffStage(f, stage) {
  return recoveryUrgency(f, stage) > 0;
}

// ── Full-situation perception ───────────────────────────────────────────────
// One snapshot per decision. Every AI subsystem (movement, attack, combo,
// defense, recovery, edgeguard, adaptation) reads this — nothing reaches
// around it to re-derive geometry inconsistently.
// OPTIMIZATION: Reuses a single pooled object and a shared array to avoid
// per-frame allocations. The returned object is valid only until the next call.
const _perceptionPool = { lists: [] };

// Perception memo.
//
// The old form was a Map keyed by a 12-field template string, valid for 50ms.
// That was a net loss on both axes:
//
//  - Cost: it built a ~60-char string (12 Math.round + 11 concats), hashed it
//    for a Map.get, called performance.now(), and allocated a wrapper object —
//    on EVERY call, including the many that missed. buildPerception is reached
//    from chooseAndFire AND makeDecision, and chooseAndFire is invoked from
//    many branches, so it can run several times per decision. All of that to
//    avoid a few dozen arithmetic ops.
//  - Correctness: a 50ms TTL is ~3 frames at 60Hz, so it routinely returned
//    the opponent's position and velocity from up to 3 frames ago. The AI was
//    deciding against a stale read of the world.
//
// Replaced with a single-slot memo keyed on the (fighter, opponent) pair and a
// tick counter bumped once per controller update. Within one update the world
// genuinely has not changed, so this is both cheaper AND never stale.
let _percTick = 0;
let _percF = null, _percOpp = null, _percAt = -1, _percData = null, _percValid = false;
function beginPerceptionTick() { _percTick++; }

// Cached ground platform reference
let _cachedGround = null;
let _cachedStage = null;
function getCachedGround(stage) {
    if (stage !== _cachedStage) {
        _cachedStage = stage;
        _cachedGround = mainGround(stage);
    }
    return _cachedGround;
}

function buildPerception(f, opp, stage) {
  // Per-tick memo hit: same fighter, same opponent, same tick => the world has
  // not moved since the last build, so the previous result is still exact.
  if (_percValid && _percAt === _percTick && _percF === f && _percOpp === opp) {
    return _percData;
  }
  const dx = (opp ? opp.x - f.x : 0) || 0;
  const dy = (opp ? opp.y - f.y : 0) || 0; // negative = opponent above
  const hDist = Math.abs(dx);
  const vDist = dy;
  const dist = Math.sqrt(dx * dx + dy * dy);
  const g = mainGround(stage);
  const bz = (stage && stage.blastZones) || { left: -150, right: 1350, top: -225, bottom: 1250 };
  const stageLeft = g ? g.x : 210;
  const stageRight = g ? g.x + g.width : 990;
  const stageTop = g ? g.y : 858;
  const distToBlastL = f.x - bz.left;
  const distToBlastR = bz.right - f.x;
  const distToBlastB = bz.bottom - f.y;
  const nearEdge = f.grounded && g
    ? Math.min(f.x - g.x, (g.x + g.width) - f.x)
    : Infinity;
  const oppNearEdge = opp && opp.grounded && g
    ? Math.min(opp.x - g.x, (g.x + g.width) - opp.x)
    : Infinity;
  const _fvx = f.vx || 0, _fvy = f.vy || 0;
  const _ovx = opp ? opp.vx || 0 : 0, _ovy = opp ? opp.vy || 0 : 0;
  const ownSpeed = Math.sqrt(_fvx * _fvx + _fvy * _fvy);
  const oppSpeed = opp ? Math.sqrt(_ovx * _ovx + _ovy * _ovy) : 0;
  const oppAttacking = !!(opp && opp.attack);
  const oppPhase = opp && opp.attack ? opp.attack.phase : null;
  const oppVulnerable = !!(opp && (opp.hitstun > 0 || (opp.attack && opp.attack.phase === 'recovery')));
  const oppWhiff = !!(opp && opp.attack && opp.attack.phase === 'recovery' && opp.hitstun <= 0);
  const oppRecovery = opp ? recoveryUrgency(opp, stage) : 0;
  // Vertical fighting detail (§30): falling toward us, and who holds the high ground.
  const oppFallingToward = opp ? (!opp.grounded && opp.vy > 120 && Math.abs(dy) < 220 && hDist < 200) : false;
  const aiAbove = dy > 60; // we are above the opponent
  // Incoming projectile threat (§26): opponent-owned projectiles + Deadeye
  // slugs heading our way. Time-to-hit gates the dodge (no perfect dodges —
  // reactionTime + uncertainty apply at decision time).
  let incoming = null;
  try {
    const lists = _perceptionPool.lists;
    lists.length = 0; // Reuse array, clear in place
    if (opp) {
      if (Array.isArray(opp._projectiles)) for (const pr of opp._projectiles) lists.push(pr);
      if (Array.isArray(opp._deadeyeBullets)) for (const b of opp._deadeyeBullets) if (!b.dead) lists.push(b);
    }
    let bestT = Infinity;
    for (const pr of lists) {
      const rx = (f.x - pr.x), ry = (f.y - pr.y);
      const d2 = rx * rx + ry * ry;
      if (d2 > 420 * 420) continue;
      const d = Math.sqrt(d2);
      const _pvx = pr.vx || 0, _pvy = pr.vy || 0;
      const sp = Math.sqrt(_pvx * _pvx + _pvy * _pvy) || 1;
      const closing = -((rx * (pr.vx || 0) + ry * (pr.vy || 0)) / (d * sp));
      if (closing < 0.35) continue; // not heading at us
      const t = d / sp;
      if (t < bestT) { bestT = t; incoming = { x: pr.x, y: pr.y, vx: pr.vx || 0, vy: pr.vy || 0, dist: d, timeToHit: t }; }
    }
  } catch (_) { incoming = null; }
  // §41 stage-positioning detail: platform center/edges, signed distance
  // inside the platform (negative = already past the edge), drift direction
  // vs. velocity, and whether the opponent is edge-side. Cooldown readiness
  // (§46) is read live — never cached — so the AI obeys the same locks as
  // the player (attack/block/dodge) plus its resource state.
  const centerX = g ? g.x + g.width / 2 : 600;
  const edgeL = g ? g.x : 210, edgeR = g ? g.x + g.width : 990;
  const signedInside = g ? Math.min(f.x - edgeL, edgeR - f.x) : Infinity;
  const edgeSide = (f.x - centerX) >= 0 ? 1 : -1; // which edge we are nearest
  const movingTowardEdge = Math.sign(f.vx || 0) === edgeSide && Math.abs(f.vx || 0) > 60;
  const centerDir = f.x < centerX - 12 ? 1 : f.x > centerX + 12 ? -1 : 0;
  const oppEdgeInside = opp && g ? Math.min(opp.x - edgeL, edgeR - opp.x) : Infinity;
    const result = {

    dx, dy, hDist, vDist, dist,
    oppAbove: dy < -45, oppBelow: dy > 45, oppLevel: Math.abs(dy) <= 45,
    oppAboveFar: dy < -90,
    oppFallingToward, aiAbove, incoming,
    centerX, edgeL, edgeR, signedInside, edgeSide, movingTowardEdge, centerDir,
    oppEdgeInside,
    attackReady: (f.attackCooldown || 0) <= 0,
    blockReady: (f.shieldCooldown || 0) <= 0,
    dodgeReady: (f.dodgeCooldown || 0) <= 0,
    ownGrounded: !!f.grounded, oppGrounded: opp ? !!opp.grounded : true,
    oppAirborne: opp ? !opp.grounded : false, ownAirborne: !f.grounded,
    ownVx: f.vx || 0, ownVy: f.vy || 0, oppVx: opp ? opp.vx || 0 : 0, oppVy: opp ? opp.vy || 0 : 0,
    ownSpeed, oppSpeed,
    oppApproaching: opp ? (Math.sign(opp.vx || 0) === -Math.sign(dx) && Math.abs(opp.vx || 0) > 40) : false,
    oppRetreating: opp ? (Math.sign(opp.vx || 0) === Math.sign(dx) && Math.abs(opp.vx || 0) > 40) : false,
    stageLeft, stageRight, stageTop, blast: bz,
    distToBlast: Math.min(distToBlastL, distToBlastR, distToBlastB),
    nearEdge, oppNearEdge,
    ownPercent: f.percent || 0, oppPercent: opp ? opp.percent || 0 : 0,
    ownAttack: f.attack || null, ownPhase: f.attack ? f.attack.phase : null,
    ownHitstun: f.hitstun || 0, oppHitstun: opp ? opp.hitstun || 0 : 0,
    ownDodgeCd: f.dodgeCooldown || 0, oppDodgeCd: opp ? opp.dodgeCooldown || 0 : 0,
    canDoubleJump: !!f.canDoubleJump, canAerialLight: !!f.canUseAerialLightRecovery,
    freeFall: !!f.freeFall,
    oppAttack: opp ? opp.attack || null : null, oppAttacking, oppPhase,
    oppVulnerable, oppWhiff,
    oppRecovery, ownUrgency: recoveryUrgency(f, stage),
    oppShielding: opp ? !!opp.shielding : false, oppDodging: opp ? !!opp.dodging : false,
    // Vertical-accuracy detail: absolute opponent height + landing detection
    // (airborne, falling fast, close above a floor → about to land → punish
    // with low/fast moves). Canvas Y grows downward: larger y = lower.
    oppY: opp ? opp.y : f.y,
    oppLanding: opp ? (!opp.grounded && (opp.vy || 0) > 150 && (stageTop - opp.y) < 260 && (stageTop - opp.y) > -40) : false,
  };
  // Memoise for the rest of this tick. The record is read-only to every caller
  // (nothing outside this function assigns to a perception field), so handing
  // back the same object for the rest of the tick is safe.
  _percF = f; _percOpp = opp; _percAt = _percTick; _percData = result; _percValid = true;
  return result;
}

// ── Attack profiles (scoring metadata, NOT physics) ─────────────────────────
// Physics (damage/kb/angle) lives in combat.js tables. These profiles describe
// HOW to pick each move: effective reach, vertical bias, speed, risk. Real
// startup/recovery from attacksFor() further weight the score at decision time.
const ATTACK_PROFILES = {
  jab:          { range: 80,  vBias: 'level', speed: 1.0, risk: 0.1 },
  ftilt:        { range: 150, vBias: 'level', speed: 0.8, risk: 0.25 },
  fsmash:       { range: 210, vBias: 'level', speed: 0.45, risk: 0.8 },
  utilt:        { range: 120, vBias: 'above', speed: 0.8, risk: 0.25 },
  usmash:       { range: 150, vBias: 'above', speed: 0.5, risk: 0.75 },
  dtilt:        { range: 140, vBias: 'below', speed: 0.85, risk: 0.3 },
  dsmash:       { range: 130, vBias: 'below', speed: 0.45, risk: 0.85 },
  aerialLight:  { range: 110, vBias: 'any',   speed: 0.9, risk: 0.2 },
  aerialHeavy:  { range: 130, vBias: 'above', speed: 0.6, risk: 0.5 },
  dash:         { range: 160, vBias: 'level', speed: 0.7, risk: 0.4 },
  nsmash:       { range: 130, vBias: 'level', speed: 0.5, risk: 0.7 },
  btilt:        { range: 150, vBias: 'level', speed: 0.8, risk: 0.25 },
  bsmash:       { range: 210, vBias: 'level', speed: 0.8, risk: 0.8 },
};

// Shared immutable defaults. The old code wrote a fresh object literal for the
// attack table fallback and for any key missing from ATTACK_PROFILES — twice
// per candidate per decision — for values that are compile-time constants.
const EMPTY_TABLE = {};
const DEFAULT_ATTACK_PROFILE = { range: 120, vBias: 'level', speed: 0.7, risk: 0.4 };

// Scored-attempt buffer. scoreAttacks runs for every candidate key on every AI
// decision (a dozen candidates, several times a second) and used to allocate a
// nine-field object literal per candidate plus a fresh sort comparator closure.
// The records are pooled and the comparator is hoisted; the buffer is fully
// consumed synchronously by chooseAndFire (and the debug dump, which copies
// out immediately), so no caller ever observes a recycled record.
const _SCORE_POOL_MAX = 64;
const _scorePool = [];
for (let i = 0; i < 24; i++) {
  _scorePool.push({ key: '', def: null, score: 0, startup: 0, recovery: 0, risk: 0, connect: 0, kind: '', prefDist: 0, fwd: 0 });
}
function _scoreRec(i, key, def, score, startup, recovery, risk, connect, kind, prefDist, fwd) {
  let r = _scorePool[i];
  if (!r) {
    r = { key: '', def: null, score: 0, startup: 0, recovery: 0, risk: 0, connect: 0, kind: '', prefDist: 0, fwd: 0 };
    if (i >= _SCORE_POOL_MAX) return r;   // never grows past the cap
    _scorePool[i] = r;
  }
  r.key = key; r.def = def; r.score = score; r.startup = startup; r.recovery = recovery;
  r.risk = risk; r.connect = connect; r.kind = kind; r.prefDist = prefDist; r.fwd = fwd;
  return r;
}
const _scoreBuf = [];
const _reachableBuf = [];
function _scoreDesc(a, b) { return b.score - a.score; }

// Pooled movement-action buffer (§28). Up to 8 entries, read only within the
// block that builds them, so they can be reused across decisions.
const _actionBuf = [];
const _actionPool = [];
for (let i = 0; i < 8; i++) _actionPool.push({ id: '', score: 0 });
function _actionRec(i) {
  let a = _actionPool[i];
  if (!a) { a = { id: '', score: 0 }; _actionPool[i] = a; }
  return a;
}
function _actionDesc(a, b) { return b.score - a.score; }

// Distance-fit falloff: exp(-(dh/sigma)^2 / 2), tabulated over the standardized
// distance z = dh/sigma in [0, GAUSS_MAX] and linearly interpolated beyond.
//
// Math.exp is one of the slowest libm entry points in V8 and is NOT
// intrinsified, yet this ran once per candidate attack key per AI decision
// (a dozen, several times a second, per AI). The curve is smooth and its only
// job is a multiplicative weight inside a score, so a 256-entry table is
// indistinguishable in practice. Beyond GAUSS_MAX the true value is under
// 4e-4 and effectively zero for scoring, so clamping there is safe.
const GAUSS_N = 256;
const GAUSS_MAX = 6;
const _gaussLut = new Float64Array(GAUSS_N + 1);
for (let i = 0; i <= GAUSS_N; i++) {
  const z = (i / GAUSS_N) * GAUSS_MAX;
  _gaussLut[i] = Math.exp(-(z * z) / 2);
}
function _gauss(dh, sigma) {
  const z = (dh / sigma) * (GAUSS_N / GAUSS_MAX);
  if (z <= 0) return 1;
  const i = z | 0;
  if (i >= GAUSS_N) return _gaussLut[GAUSS_N];
  const f = z - i;
  return _gaussLut[i] + (_gaussLut[i + 1] - _gaussLut[i]) * f;
}

// Set membership instead of a regex in the innermost scoring loop. The old
// `/smash/i.test(key)` ran a regex engine (and allocated its exec state) for
// every candidate on every decision, then still fell through to four explicit
// string comparisons for the same four keys. Set.has on interned strings is a
// pointer hash compare.
const SMASH_KEYS = new Set(['fsmash', 'bsmash', 'usmash', 'dsmash', 'nsmash']);
// Move ids that count toward the §27 "ability usage" variety counter. The old
// form was a 9-alternative case-insensitive regex run on every noteAction call.
// These are exactly the attack-table keys (combat.js), which is what the
// substring alternation was matching; explicit membership is equivalent here
// and free.
const SCOREABLE_KEYS = new Set([
  'jab', 'ftilt', 'fsmash', 'utilt', 'usmash', 'dtilt', 'dsmash',
  'aerialLight', 'aerialHeavy', 'dash', 'nsmash', 'btilt', 'bsmash',
]);
// A move whose id ends in "-zone" shares its parent's use counter. Precomputed
// instead of a regex `.replace()` per key per decision; the vast majority of
// keys have no suffix at all, so they reuse their own (interned) string as the
// key and never allocate.
const _zoneBase = new Map();
function _abilityUseKey(key) {
  let b = _zoneBase.get(key);
  if (b === undefined) {
    b = key.length > 5 && key.charCodeAt(key.length - 5) === 45 /* '-' */
      && key.endsWith('zone') ? key.slice(0, key.length - 5) : key;
    if (_zoneBase.size < 256) _zoneBase.set(key, b);
  }
  return b;
}

// ── Per-attack reach model + trajectory prediction (no cheating) ──────────
// The hitboxes and collision stay authoritative in combat.js — this only
// ESTIMATES, from the real def numbers, whether an attack can plausibly
// connect, so the AI stops swinging at air. Reach mirrors combat's own rect
// math (hitboxRectFor: x = fx + ox*facing − w/2, y = fy + oy − h/2); the
// hurtbox is the opponent's radius square (getHurtbox). vDist uses canvas
// coordinates (Y down): positive vDist = opponent BELOW us.

// Effective def: what the game would actually use right now (custom hitboxes
// and ability routing included), falling back to the character table.
function effDefFor(f, key, table) {
  try {
    const r = resolveAttackDef(key, f);
    if (r) return r;
  } catch (_) {}
  return (table && table[key]) || null;
}

// Classify how an attack reaches the opponent. Returns:
// { kind, fwd, back, halfH, oy, t, needsGround, directed }
// fwd/back: horizontal reach from attacker center (px). halfH/oy: vertical
// half-size + center offset. t: seconds until the hit can land. directed:
// true when the attack only threatens the faced direction.
// Reach model output, cached per (def, key). The result depends only on static
// library/hitbox numbers, so it is recomputed on every candidate for every
// decision for no reason. Callers may hold the returned object (the math suite
// keeps several alive at once), so each distinct input keeps its OWN record —
// only the repeated-call allocation is removed. WeakMap on the def lets the
// cache die with the def itself; a store edit produces a new def, so a changed
// hitbox can never read a stale reach.
const _reachCache = new WeakMap();
function _reachFor(def, key) {
  let byKey = _reachCache.get(def);
  if (!byKey) { byKey = new Map(); _reachCache.set(def, byKey); }
  let R = byKey.get(key);
  if (!R) {
    R = {
      kind: 'melee', fwd: 0, back: 0, halfH: 0, oy: 0, t: 0,
      needsGround: false, directed: true,
    };
    byKey.set(key, R);
  }
  return R;
}
function attackReach(key, def, f) {
  const d = def || {};
  const R = _reachFor(d, key);
  const startup = Math.max(0, d.startup != null ? d.startup : 5);
  const cast = Math.max(0, d.abilityCastFrame != null ? d.abilityCastFrame : 0);
  const oy0 = d.oy || 0;
  const halfH0 = (d.h || 30) / 2;
  const t0 = (Math.max(startup, cast) + 2) / 60;
  R.oy = oy0; R.halfH = halfH0; R.t = t0;
  R.needsGround = false; R.directed = true;
  // Deadeye volley (cowboy Down Light): homing bullets — long reach, tall
  // capture volume, no facing requirement once locked.
  if (d.abilityType === 'nonHitbox' && d.abilityId === 'cowboyDownLight') {
    R.kind = 'deadeye'; R.fwd = 480; R.back = 120; R.halfH = 170; R.oy = 0; R.t = cast / 60 + 0.12; R.directed = false;
    return R;
  }
  // Horse ride (cowboy Down Heavy): tramples forward along the ground.
  if (d.abilityType === 'nonHitbox' && d.abilityId === 'cowboyDownHeavy') {
    R.kind = 'horse'; R.fwd = 260; R.back = 0; R.halfH = 45; R.oy = 10; R.t = cast / 60 + 0.1; R.needsGround = true;
    return R;
  }
  // Depsey Roll (boxer Down Heavy): self-buff, best armed just before
  // engaging. Scored as a close-range setup so the AI pops it on approach.
  if (d.abilityType === 'nonHitbox' && d.abilityId === 'boxerDsmash') {
    R.kind = 'melee'; R.fwd = 120; R.back = 0; R.halfH = 60; R.oy = 0; R.t = cast / 60 + 0.1; R.directed = false;
    return R;
  }
  // Rifle bullet (cowboy Side Smash): fast projectile downrange.
  if (d.abilityType === 'nonHitbox' && d.abilityId === 'cowboyFwdHeavy') {
    R.kind = 'projectile'; R.fwd = 550; R.back = 0; R.halfH = 60; R.oy = -4; R.t = 0.06;
    return R;
  }
  // Pirate cannons. Both are real projectiles, so both are scored as one, but
  // with VERY different reach — that difference is the whole point of the
  // character, so the two ids get their own lines rather than sharing the
  // generic 'projectile' number the shuriken uses:
  //   Cannon Blast — the long gun (~520px of travel before its lifetime ends).
  //   Broadside    — the close cone (~110px), so it only scores in the pocket
  //                  and can never be mistaken for the zoning option.
  if (d.abilityType === 'nonHitbox' && d.abilityId === 'pirateCannonBlast') {
    R.kind = 'projectile'; R.fwd = 560; R.back = 0; R.halfH = 70; R.oy = -6; R.t = 0.06;
    return R;
  }
  if (d.abilityType === 'nonHitbox' && d.abilityId === 'pirateBroadside') {
    R.kind = 'projectile'; R.fwd = 150; R.back = 0; R.halfH = 80; R.oy = -6; R.t = 0.04;
    return R;
  }
  // Rope Swing (pirate Down Light): a pendulum swing on a rope that ends in a
  // strike, so it reaches like the ninja's dash-strike — the box plus the
  // arc travel (dashDistance scale), not just the box.
  if (d.abilityType === 'nonHitbox' && d.abilityId === 'pirateRopeSwing') {
    const w = d.w || 76, ox = Math.abs(d.ox || 0);
    R.kind = 'dash'; R.fwd = ox + w / 2 + (d.dashDistance || 150); R.back = 0;
    R.halfH = 20; R.oy = oy0; R.t = startup / 60 + 0.06;
    return R;
  }
  // Anchor Drop (pirate Down Heavy) and the Cutlass Lunge are short forward
  // strike boxes: scored as plain melee at their own table geometry, which the
  // generic melee branch below already does — no special case needed, and none
  // added so they can never drift from their real hitbox numbers.
  // Shuriken + any authored projectile: travels, needs rough height alignment.
  if (d.isProjectile) {
    R.kind = 'projectile'; R.fwd = 450; R.back = 0; R.halfH = 80; R.oy = oy0; R.t = 0.08;
    return R;
  }
  // Shadow Strike (ninja Down Heavy): dashes forward, then slashes.
  if (d.dashDistance) {
    const w = d.w || 60;
    const ox = Math.abs(d.ox || 0);
    R.kind = 'dash'; R.fwd = ox + w / 2 + (d.dashDistance || 0); R.back = 0; R.t = startup / 60 + 0.06;
    return R;
  }
  // Plain melee (hitbox defs, possibly bothSides or aerial).
  const w = d.w || 40, ox = Math.abs(d.ox || 0);
  const both = !!d.bothSides;
  const air = key === 'aerialLight' || key === 'aerialHeavy';
  R.kind = 'melee';
  R.fwd = ox + w / 2;
  R.back = (both || air) ? ox + w / 2 : Math.max(0, w / 2 - ox);
  R.directed = !(both || air);
  return R;
}

// Where will the opponent's center be in t seconds? Grounded targets mostly
// slide horizontally; airborne ones follow gravity (same GRAVITY the physics
// integrates). Conservative — no air-control assumptions.
function predictOppCenter(opp, oppGrounded, t) {
  const px = opp.x + (opp.vx || 0) * t;
  let py;
  if (oppGrounded) {
    py = opp.y + Math.min(0, opp.vy || 0) * t;
  } else {
    py = opp.y + (opp.vy || 0) * t + 0.5 * GRAVITY * t * t;
  }
  return { x: px, y: py };
}

// Realistic connect chance 0..1 for one attack, right now: predicted hurtbox
// vs. the hitbox rect the game would spawn (attacker assumed stationary and
// already facing the opponent — facing is enforced separately before firing).
// Melee uses exact rect overlap with linear falloff; lunges/projectiles use
// swept volumes. This never touches collision — it only informs the decision.
function connectChance(R, P, f, opp) {
  if (!opp || !R) return 0;
  const dx = opp.x - f.x;
  const toward = dx >= 0 ? 1 : -1;
  const facing = f.facingRight ? 1 : -1;
  const pred = predictOppCenter(opp, P.oppGrounded, R.t || 0.1);
  const hr = opp.radius || 26;
  const hbTop = f.y + (R.oy || 0) - (R.halfH || 15);
  const hbBottom = f.y + (R.oy || 0) + (R.halfH || 15);

  if (R.kind === 'deadeye') {
    // Homing volley: needs rough volume containment, facing-agnostic.
    const hInside = Math.abs(pred.x - f.x) < (R.fwd || 480) + hr;
    const vOverlap = pred.y + hr > f.y - 170 && pred.y - hr < f.y + 170;
    if (!hInside || !vOverlap) return 0;
    const hScore = 1 - Math.min(1, Math.abs(pred.x - f.x) / 560);
    const vScore = 1 - Math.min(1, Math.abs(pred.y - f.y) / 260);
    return Math.max(0, Math.min(1, 0.45 + 0.55 * (hScore * 0.6 + vScore * 0.4)));
  }
  if (R.kind === 'projectile') {
    // Must be fired toward the opponent and share a height band.
    if (toward !== facing) return 0;
    const hDist = Math.abs(pred.x - f.x);
    if (hDist > (R.fwd || 450) + hr) return 0;
    const vMiss = Math.abs((pred.y) - (f.y + (R.oy || 0))) - ((R.halfH || 60) + hr);
    if (vMiss > 0) return Math.max(0, 1 - vMiss / 120);
    if (hDist < 40) return 0.35; // point-blank: muzzle past them, risky
    return 0.55 + 0.45 * (1 - hDist / ((R.fwd || 450) + hr));
  }
  if (R.kind === 'horse') {
    // Swept ground volume ahead of the rider.
    if (toward !== facing) return 0;
    const ahead = (pred.x - f.x) * facing;
    if (ahead < -(hr + 20) || ahead > (R.fwd || 260) + hr) return 0;
    const vMiss = Math.abs(pred.y - (f.y + (R.oy || 10))) - ((R.halfH || 45) + hr);
    if (vMiss > 0) return Math.max(0, 1 - vMiss / 90);
    return 0.6 + 0.4 * (1 - Math.max(0, ahead) / ((R.fwd || 260) + hr));
  }
  // Melee + dash lunge: exact rect overlap at the predicted position. The
  // rect extends from the attacker toward the OPPONENT's side (facing-aware:
  // forward reach when facing them, back reach otherwise).
  const edge = toward === facing ? (R.fwd || 60) : (R.back || 0);
  const hbX0 = toward > 0 ? f.x : f.x - edge;
  const hbX1 = toward > 0 ? f.x + edge : f.x;
  const oX0 = pred.x - hr, oX1 = pred.x + hr;
  const oY0 = pred.y - hr, oY1 = pred.y + hr;
  const overlapX = Math.min(hbX1, oX1) - Math.max(hbX0, oX0);
  const overlapY = Math.min(hbBottom, oY1) - Math.max(hbTop, oY0);
  if (overlapX > 0 && overlapY > 0) {
    // Solid overlap: scale by centrality (dead-center = surest).
    const cX = 1 - Math.min(1, Math.abs((pred.x - f.x) - toward * edge * 0.5) / Math.max(1, edge));
    return Math.max(0.55, Math.min(1, 0.7 + 0.3 * cX));
  }
  // Near-miss falloff: how far outside the rect (px) → 0 at 70px out.
  const missX = overlapX >= 0 ? 0 : -overlapX;
  const missY = overlapY >= 0 ? 0 : -overlapY;
  const miss = Math.sqrt(missX * missX + missY * missY) + (toward !== facing && R.directed ? 40 : 0);
  return Math.max(0, 1 - miss / 70) * 0.5;
}

function facingOppNow(f, dx) {
  if (Math.abs(dx) < 8) return true;
  return (dx >= 0) === !!f.facingRight;
}

class AIState {
  constructor(fighter, opponent, personality) {
    this.fighter = fighter || null;
    this.opponent = opponent || null;
    this.personality = resolvePersonality(personality);
    this.held = emptyHeld();
    this.prevHeld = emptyHeld();
    this.plan = null;
    this.planUntil = 0;
    this.lastDecision = 0;
    // Reaction-time jitter: decisions fire at personality.reactionTime ± 25%.
    this.nextDecisionAt = 0;
    this.releaseAt = {};
    // Live count of pending timed releases, so agePresses (called every frame)
    // can skip its loop entirely when nothing is pending.
    this.releaseCount = 0;
    this.shieldUntil = 0;
    this.lastShieldAt = -1e9;
    this.comboCount = 0;
    this.lastHitOppPercent = -1;
    this.lastOppAttackRef = null;
    this.oppPattern = [];
    // ── Lightweight adaptation (no ML) ──────────────────────────────────
    // Counts/scores updated every frame + every decision. Decisions read the
    // derived rates (jumpFreq, blockFreq, ...) to bias scoring.
    this.adapt = {
      samples: 0,
      attackCounts: {},   // opp attack key -> times seen
      rangeSum: 0, rangeN: 0, // preferred attack range accumulator
      jumps: 0, approaches: 0, retreats: 0,
      blocks: 0, dodges: 0,
      recoveryDir: { left: 0, right: 0, center: 0 },
      sideHits: { left: 0, right: 0 }, // which side opp attacks from
      lastOppY: 0, lastOppX: 0,
      lastOppGrounded: true,
    };
    this.stuckCheck = { x: 0, y: 0, t: 0, count: 0 };
    this.lastActionKey = 'idle';
    this.repeatCount = 0;
    // §24/29/32: movement bookkeeping — strafe direction, post-attack
    // repositioning, ability-variety counts (so the whole kit gets used).
    this.strafeDir = 1;
    this.strafeUntil = 0;
    this.lastAttackEndedAt = -1e9;
    this.wasAttacking = false;
    this.abilityUses = {}; // own attack key -> times used (variety bonus)
    this.moveTicks = 0;    // decisions spent moving without attacking
    this.debug = { state: 'init', action: 'none' };
    this.stats = {};
    this._stageHint = null;
    this._lastOppPercent = 0;
    // ── Neural-network influence (training / difficulty) ──────────────
    // neuroNet: a NeuralNetwork whose forward() output biases scoring.
    // neuroInfluence 0 = pure scripted AI; 1 = network strongly steers picks.
    // mistakeRate: probability a neutral decision deliberately fumbles (lower
    // difficulties play worse on purpose). The network never bypasses the
    // game's legality gates — combatInput re-validates everything.
    this.neuroNet = null;
    this.neuroInfluence = 0;
    this.mistakeRate = 0;
    this._nnOut = null;
    // ── Aimed-attack intent (move into range, then strike) ──────────────
    // aimKey: the attack we want; aimDist: the distance to hold; aimUntil:
    // expiry. Set when nothing connects yet or we must turn first; cleared
    // on fire, expiry, or reset. Movement scoring closes the gap meanwhile.
    this.aimKey = null;
    this.aimUntil = 0;
    this.aimDist = 90;
    // ── Accuracy instrumentation (read-only observability) ──────────────
    // attacks: swings started by chooseAndFire; hits: opponent damage events
    // observed afterwards (delayed projectile/Deadeye hits still credit).
    // Shields/denies correctly count as non-hits. Never affects decisions.
    this.combatStats = { attacks: 0, hits: 0, _lastOppPct: -1, _lastOwnAttack: null };
    // Decision diagnostics: where potential swings die (observability only).
    this.diag = { freqBlock: 0, gateBlock: 0, fired: 0, noScore: 0, turnFix: 0 };
    this.recentAttacks = []; // chosen swing history (variety penalty window)
    this.lastZonerAt = -1e9; // last projectile/volley fire (zoner pacing)
  }

  // Attach a trained genome: behavior becomes personality, weights become the
  // steering network. influence 0..1 scales how strongly the net steers.
  setGenome(genome, influence = 1.0) {
    if (genome && genome.behavior && typeof genome.behavior === 'object') {
      this.personality = resolvePersonality({ ...this.personality, ...genome.behavior });
    }
    if (genome && Array.isArray(genome.weights)) {
      try {
        this.neuroNet = new NeuralNetwork(genome.weights);
      } catch (_) { this.neuroNet = null; }
    } else {
      this.neuroNet = null;
    }
    this.neuroInfluence = Math.max(0, Math.min(1, influence));
    this._nnOut = null;
  }

  setNeuralModel(weights, influence = 1.0) {
    if (Array.isArray(weights)) {
      try { this.neuroNet = new NeuralNetwork(weights); }
      catch (_) { this.neuroNet = null; }
    } else {
      this.neuroNet = null;
    }
    this.neuroInfluence = Math.max(0, Math.min(1, influence));
    this._nnOut = null;
  }

  // Run the steering network for the current situation. Called once per
  // decision (never per frame) so training populations cost nothing when idle
  // and live matches pay a single small forward pass per ~150ms.
  ensureNeuro() {
    if (!this.neuroNet || !(this.neuroInfluence > 0)) {
      this._nnOut = null;
      return null;
    }
    try {
      const inputs = buildNNInputs(this.fighter, this.opponent, this._stageHint);
      const out = this.neuroNet.forward(inputs);
      // Reuse the output array instead of Array.from() per decision: the
      // network's _out is stable per instance, but two controllers must never
      // share one reference, so copy into a per-controller scratch array.
      if (!this._nnOut || this._nnOut.length !== out.length) this._nnOut = new Array(out.length);
      for (let i = 0; i < out.length; i++) this._nnOut[i] = out[i];
      return this._nnOut;
    } catch (_) {
      this._nnOut = null;
      return null;
    }
  }

  // Multiplier in [1-influence, 1+influence] from a tanh network output.
  _neuroBias(idx, fallbackIdx = -1) {
    const out = this._nnOut;
    const infl = this.neuroInfluence || 0;
    if (!out || !(infl > 0)) return 1;
    let v = (idx >= 0 && idx < out.length) ? out[idx] : 0;
    if (!Number.isFinite(v) && fallbackIdx >= 0 && fallbackIdx < out.length) v = out[fallbackIdx];
    if (!Number.isFinite(v)) return 1;
    return 1 + infl * Math.max(-1, Math.min(1, v));
  }

  setHeld(name, v) {
    if (name in this.held) this.held[name] = !!v;
  }

  pressButton(name, holdMs, now) {
    this.setHeld(name, true);
    if (this.releaseAt[name] === undefined) this.releaseCount++;
    this.releaseAt[name] = now + holdMs;
  }

  agePresses(now) {
    // This runs EVERY FRAME for every AI fighter, and the timed-press list is
    // empty the overwhelming majority of the time. The old form called
    // Object.keys() unconditionally — a fresh array plus a for-of iterator on
    // every frame of the match, for a loop that almost always had nothing to
    // do — and then `delete`d expired keys, which permanently pushes the object
    // into V8 dictionary mode so every later property read gets slower.
    //
    // Now: a counter gates the whole thing, and expiry clears the slot back to
    // undefined instead of deleting it, so the object keeps its fast hidden
    // class for the life of the controller.
    if (this.releaseCount > 0) {
      const rel = this.releaseAt;
      for (const k in rel) {
        const at = rel[k];
        if (at === undefined) continue;
        if (now >= at) {
          this.setHeld(k, false);
          rel[k] = undefined;
          this.releaseCount--;
        }
      }
    }
    if (this.shieldUntil && now >= this.shieldUntil) {
      this.setHeld('shield', false);
      this.shieldUntil = 0;
    }
    if (this.plan && now >= this.planUntil) {
      this.plan = null;
    }
  }

  // Set the current movement plan.
  //
  // Previously each of ~39 decision branches built its own `{ move }` (or
  // `{ move, holdUp, holdDown }`) object literal, so nearly every decision
  // allocated, and — because the shapes differed — V8 gave each site a
  // different hidden class, making every later `plan.move` read a megamorphic
  // property load. One persistent record with a fixed shape removes both costs
  // and keeps the plan read monomorphic. `null` still means "no plan", so every
  // existing `if (this.plan)` guard and `this.plan = null` expiry is unchanged.
  _setPlan(move, holdUp, holdDown) {
    let p = this._plan;
    if (!p) p = this._plan = { move: 0, holdUp: false, holdDown: false };
    p.move = move;
    p.holdUp = !!holdUp;
    p.holdDown = !!holdDown;
    this.plan = p;
    return p;
  }

  trackOpponent(now) {
    const opp = this.opponent, f = this.fighter;
    if (!opp || !f) return;
    const a = this.adapt;
    a.samples++;
    // Attack repetition + range preference.
    const ref = opp.attack || null;
    if (ref && ref !== this.lastOppAttackRef) {
      this.lastOppAttackRef = ref;
      const key = ref.key || '?';
      a.attackCounts[key] = (a.attackCounts[key] || 0) + 1;
      const h = Math.abs(opp.x - f.x);
      a.rangeSum += h; a.rangeN++;
      a.sideHits[opp.x < f.x ? 'left' : 'right']++;
      this.oppPattern.push({ key, t: now });
      if (this.oppPattern.length > 8) this.oppPattern.shift();
      // Repeated same attack 3+ times in window → exploitable habit.
    } else if (!ref) {
      this.lastOppAttackRef = null;
    }
    // Jump frequency: grounded → airborne edge = a jump.
    if (!this._prevOppTracked) this._prevOppTracked = true;
    if (a.lastOppGrounded && !opp.grounded) a.jumps++;
    // Approach / retreat from horizontal velocity toward/away.
    const dx = opp.x - f.x;
    if (Math.abs(opp.vx || 0) > 60) {
      if (Math.sign(opp.vx) === -Math.sign(dx || 1)) a.approaches++;
      else a.retreats++;
    }
    if (opp.shielding) a.blocks++;
    if (opp.dodging) a.dodges++;
    // Recovery direction when off-stage.
    if (!opp.grounded && isOffStage(opp, this._stageHint)) {
      const g = mainGround(this._stageHint);
      const cx = g ? g.x + g.width / 2 : 600;
      if (Math.abs(opp.x - cx) < 120) a.recoveryDir.center++;
      else if (opp.x < cx) a.recoveryDir.left++;
      else a.recoveryDir.right++;
    }
    a.lastOppX = opp.x; a.lastOppY = opp.y; a.lastOppGrounded = !!opp.grounded;
    // Swing + hit accounting, observed from game truth (not button presses):
    // a fresh fighter.attack instance = one real swing, however it started
    // (fresh press, input-buffer queue, recovery aerial). Opponent damage
    // rising = one of our swings connected (delayed projectiles/Deadeye
    // credit here too). Shields/denies correctly count as non-hits.
    try {
      const cs = this.combatStats;
      const atk = f.attack || null;
      if (atk && atk !== cs._lastOwnAttack) {
        cs.attacks++;
        cs._lastOwnAttack = atk;
      } else if (!atk) {
        cs._lastOwnAttack = null;
      }
      const cur = opp.percent || 0;
      if (cs._lastOppPct >= 0 && cur > cs._lastOppPct + 0.001) cs.hits++;
      cs._lastOppPct = cur;
    } catch (_) {}
  }

  adaptRates() {
    const a = this.adapt;
    const n = Math.max(1, a.samples);
    return {
      jumpFreq: a.jumps / n,
      blockFreq: a.blocks / n,
      dodgeFreq: a.dodges / n,
      approachRate: a.approaches / n,
      avgRange: a.rangeN ? a.rangeSum / a.rangeN : 110,
      // Most-spammed attack key (null when no habit yet).
      spamKey: (() => {
        let best = null, bn = 0, tot = 0;
        for (const k of Object.keys(a.attackCounts)) { tot += a.attackCounts[k]; if (a.attackCounts[k] > bn) { bn = a.attackCounts[k]; best = k; } }
        return (tot >= 3 && bn / tot >= 0.45) ? best : null;
      })(),
      recoveryBias: (() => {
        const r = a.recoveryDir;
        const t = r.left + r.right + r.center;
        if (t < 2) return null;
        if (r.left > r.right && r.left > r.center) return 'left';
        if (r.right > r.left && r.right > r.center) return 'right';
        return 'center';
      })(),
    };
  }

  updateStuck(now) {
    const f = this.fighter;
    if (!f) return false;
    if (!this.stuckCheck.t) {
      this.stuckCheck = { x: f.x, y: f.y, t: now, count: 0 };
      return false;
    }
    if (now - this.stuckCheck.t > 1500) {
      const _sdx = f.x - this.stuckCheck.x, _sdy = f.y - this.stuckCheck.y;
      const moved = Math.sqrt(_sdx * _sdx + _sdy * _sdy);
      const wantsMove = this.held.left || this.held.right;
      let stuck = false;
      if (wantsMove && moved < 25 && !f.grounded) stuck = true;
      else if (wantsMove && moved < 12) stuck = true;
      this.stuckCheck = { x: f.x, y: f.y, t: now, count: stuck ? this.stuckCheck.count + 1 : 0 };
      return stuck;
    }
    return false;
  }

  noteAction(key) {
    if (key === this.lastActionKey) this.repeatCount += 1;
    else {
      this.lastActionKey = key;
      this.repeatCount = 0;
    }
    this.stats[key] = (this.stats[key] || 0) + 1;
    // §27: track own ability usage so scoring can bonus rarely-used moves
    // (full-kit usage without random cycling).
    // Set membership + the shared suffix stripper, replacing a 9-alternative
    // case-insensitive regex plus a `.replace()` on every noteAction call.
    if (SCOREABLE_KEYS.has(key)) {
      const base = _abilityUseKey(key);
      this.abilityUses[base] = (this.abilityUses[base] || 0) + 1;
    }
  }

  // Cached per character id: the owned attack-key list never changes mid-match,
  // so scoring iterates a shared array instead of building a Set from
  // Object.keys on every decision.
  availableKeys() {
    try {
      const f = this.fighter;
      const cid = (f && f._fighterDef && f._fighterDef.id) || '?';
      let arr = _availKeysCache.get(cid);
      if (!arr) {
        const table = attacksFor(f) || {};
        arr = Object.keys(table);
        if (!arr.length) arr = ['jab', 'nsmash', 'ftilt', 'fsmash', 'utilt', 'usmash', 'dtilt', 'dsmash', 'aerialLight', 'aerialHeavy'];
        if (_availKeysCache.size > 32) _availKeysCache.clear();
        _availKeysCache.set(cid, arr);
      }
      return arr;
    } catch (_) {
      return _AVAIL_KEYS_FALLBACK;
    }
  }

  doAttack(type, dir, now, holdMs = 90) {
    this.setHeld('up', !!(dir && dir.up));
    this.setHeld('down', !!(dir && dir.down));
    if (dir && (dir.left || dir.right)) {
      this.setHeld('left', !!dir.left);
      this.setHeld('right', !!dir.right);
    }
    this.pressButton(type === 'special' ? 'special' : 'attack', holdMs, now);
  }

  doJump(now, holdMs = 120) {
    this.pressButton('jump', holdMs, now);
  }

  // §46: both helpers report readiness — false means the shared cooldown
  // (identical to the player's) is live, so callers pick another defense
  // instead of pressing a locked button. The game re-gates regardless.
  doDodge(now, dirX = 0) {
    if ((this.fighter && this.fighter.dodgeCooldown || 0) > 0) return false;
    if (dirX < 0) {
      this.setHeld('left', true);
      this.setHeld('right', false);
    } else if (dirX > 0) {
      this.setHeld('left', false);
      this.setHeld('right', true);
    }
    this.pressButton('dodge', 90, now);
    return true;
  }

  doShield(now, ms = 420) {
    if ((this.fighter && this.fighter.shieldCooldown || 0) > 0) return false;
    // Never permanently hold block: cap single holds, enforce gaps between them.
    const capped = Math.min(ms, 520);
    if (now - this.lastShieldAt < 260) return false;
    this.lastShieldAt = now;
    this.setHeld('shield', true);
    this.shieldUntil = now + capped;
    return true;
  }

  // The horse/shadow ride drives forward — only summon it when there is solid
  // ground ahead in the facing direction, never off an edge / off-stage.
  horseSafe() {
    const f = this.fighter;
    if (!f || !f.grounded) return false;
    try {
      const g = mainGround(this._stageHint);
      if (!g) return true;
      const dir = f.facingRight ? 1 : -1;
      const aheadX = f.x + dir * 200;
      return aheadX > g.x && aheadX < g.x + g.width;
    } catch (_) {
      return true;
    }
  }

  // ── Scored attack selection (entire moveset) ────────────────────────────
  // Every owned key is scored on: distance fit, vertical fit, opponent
  // velocity/state, real startup/recovery/cooldown, combo opportunity,
  // vulnerability, stage position, risk, connect chance, personality and
  // adaptation. Highest score wins (with soft randomness so AIvsAI diverges).
  scoreAttacks(P, now) {
    const f = this.fighter;
    const keys = this.availableKeys();
    const pers = this.personality;
    const rates = this.adaptRates();
    // Shared empty table, not a fresh literal, so the fallback path allocates
    // nothing. (The old `let table = {}` also allocated on the success path,
    // since the initializer ran before the try block replaced it.)
    let table = EMPTY_TABLE;
    try { const t = attacksFor(f); if (t) table = t; } catch (_) { table = EMPTY_TABLE; }
    const out = _scoreBuf;
    let outN = 0;
    const oppFallingOntoUs = P.oppAirborne && P.oppVy > 60 && P.vDist < -30 && P.vDist > -190;
    const oppY = f.y + P.vDist;
    // Hoisted: the variety bonus used to run Object.values().reduce() per
    // candidate (12x per decision). One pass here instead.
    let _totalUses = 0;
    try {
      const _au = this.abilityUses;
      for (const _k in _au) _totalUses += _au[_k];
    } catch (_) {}
    for (const key of keys) {
      const def = effDefFor(f, key, table);
      if (!def) continue;
      const prof = ATTACK_PROFILES[key] || DEFAULT_ATTACK_PROFILE;
      // Real reach for THIS attack (character-specific def, custom boxes and
      // ability routing included) + predicted connect chance. No two attacks
      // share an artificial range anymore.
      const R = attackReach(key, def, f);
      const prefDist = Math.max(30, (R.fwd || 60) * 0.65);
      const connect = connectChance(R, P, f, this.opponent);
      let s = 1.0;
      // Distance fit: Gaussian around this attack's preferred distance.
      const dh = Math.abs(P.hDist - prefDist);
      const sigma = Math.max(30, prefDist * 0.55);
      s *= _gauss(dh, sigma);
      // Vertical fit.
      if (!f.grounded) {
        // Airborne: exactly the two direction-independent aerials.
        if (key !== 'aerialLight' && key !== 'aerialHeavy') { s *= 0.02; }
        else if (key === 'aerialHeavy' && (P.oppAbove || oppFallingOntoUs)) s *= 1.7;
        else if (key === 'aerialLight' && P.oppLevel) s *= 1.4;
      } else {
        if (prof.vBias === 'above') s *= P.oppAbove ? 1.9 : (P.oppLevel ? 0.5 : 0.25);
        else if (prof.vBias === 'below') s *= P.oppBelow ? 1.7 : (P.oppLevel ? 0.55 : 0.35);
        else if (prof.vBias === 'level') s *= P.oppLevel ? 1.35 : 0.75;
        // Grounded fighter never picks aerials.
        if (key === 'aerialLight' || key === 'aerialHeavy') s *= 0.02;
        // Dash attack only while dashing (combat routes it then); down-weight otherwise.
        if (key === 'dash' && !f.dashing) s *= 0.15;
      }
      // Opponent velocity: lead fast movers with zoners, punish approachers.
      if (P.oppSpeed > 260 && (key === 'fsmash' || key === 'dtilt' || key === 'ftilt')) s *= 1.25;
      if (P.oppApproaching && (key === 'ftilt' || key === 'jab' || key === 'utilt')) s *= 1.3;
      // Vulnerability / combo: fast startup wins the punish.
      const startup = (def.startup != null ? def.startup : 5);
      const recovery = (def.recovery != null ? def.recovery : 12);
      if (P.oppVulnerable) {
        s *= (1.2 + pers.comboPriority * 0.9);
        s *= startup <= 5 ? 1.5 : (startup <= 8 ? 1.1 : 0.8);
      }
      if (P.oppWhiff) s *= 1.5; // punish missed attacks
      // Risk: laggy moves penalized when threatened or at high percent near blast.
      const threatened = P.oppAttacking && P.hDist < 150;
      if (threatened) s *= 1 - prof.risk * (0.35 + pers.defense * 0.4);
      if (P.ownPercent > 80 && P.distToBlast < 320) s *= 1 - prof.risk * 0.45 * (1 - pers.riskTolerance);
      // ── Unified-combat awareness (Smash refactor) ──
      // Weight: heavier targets need more launch — prefer high-growth smash/
      // aerial-heavy finishers vs heavies at high percent; lights for buildup.
      try {
        const _ow = (this.opponent && this.opponent._fighterDef && this.opponent._fighterDef.weight) || 100;
        const _w = (typeof _ow === 'number' && _ow > 0 && _ow < 10) ? _ow * 100 : _ow;
        const _oppP = (this.opponent && this.opponent.percent) || 0;
        const _isSmash = SMASH_KEYS.has(key) || key === 'aerialHeavy';
        const _isLight = key === 'jab' || key === 'ftilt' || key === 'utilt' || key === 'aerialLight';
        if (_oppP < 40) {
          // Build damage first: lights/tilts over committal smashes.
          if (_isSmash) s *= 0.45 + pers.riskTolerance * 0.4;
          if (_isLight) s *= 1.25;
        } else if (_oppP > 80) {
          // Kill window: smash launch scales with percent — commit when in range.
          if (_isSmash && connect > 0.45) s *= 1.35 + pers.riskTolerance * 0.5;
          if (_isLight) s *= 0.8;
          // Heavy targets (high weight) need the biggest growth moves.
          if (_w >= 110 && (def.kbGrowth || 0) >= 1.5) s *= 1.2;
        }
        // Light targets die earlier — even mid-growth moves threaten.
        if (_w <= 89 && _oppP > 60 && connect > 0.5) s *= 1.1;
        // Own weight: heavies survive longer, can afford risk; lights must respect.
        const _mw = (f && f._fighterDef && f._fighterDef.weight) || 100;
        const _mwn = (typeof _mw === 'number' && _mw > 0 && _mw < 10) ? _mw * 100 : _mw;
        if (_mwn <= 89 && P.ownPercent > 70 && (SMASH_KEYS.has(key))) s *= 0.85;
      } catch (_) {}
      // Personality: aggression loves heavies, defense loves safe pokes.
      if (SMASH_KEYS.has(key)) {
        s *= 0.55 + pers.aggression * 0.9 + pers.riskTolerance * 0.5;
        // Kill-hunting: at high opponent percent, heavies become finishers —
        // boost them (still gated by reach/risk above, never a blind suicide).
        if (P.oppPercent > 60) s *= 1.35;
        if (P.oppPercent > 100) s *= 1.25;
      } else {
        s *= 0.8 + (1 - pers.riskTolerance) * 0.3 + (1 - pers.aggression) * 0.2;
      }
      // Stage position: never horse-ride off an edge; prefer safe pokes there.
      // Horse-only: the boxer's blink lands clamped behind the target and the
      // ninja's dash is steered, so neither needs the ride-off-an-edge guard.
      if ((key === 'dsmash') && R.kind === 'horse' && !this.horseSafe() && !f.grounded) s *= 0.1;
      if ((key === 'dsmash') && R.kind === 'horse' && f.grounded && !this.horseSafe()) s *= 0.25;
      if (P.nearEdge < 60 && prof.risk > 0.6) s *= 0.6;
      // Cooldowns: respect own dodge/attack lockout implicitly (decisions skip
      // while busy), plus dodge-cooldown pressure for committal moves.
      if (f.dodgeCooldown > 0.25 && prof.risk > 0.6) s *= 0.8;
      // Adaptation:
      // - Opp jumps a lot → anti-air premium.
      if (rates.jumpFreq > 0.04 && (key === 'utilt' || key === 'usmash' || key === 'aerialHeavy')) s *= 1.35;
      // - Opp blocks a lot → delay/space: punish with quick pokes, avoid laggy smashes into shield.
      if (rates.blockFreq > 0.05 && prof.risk > 0.6) s *= 0.7;
      if (rates.blockFreq > 0.05 && (key === 'jab' || key === 'ftilt')) s *= 1.2;
      // - Opp dodges a lot → prefer fast startup, avoid committing.
      if (rates.dodgeFreq > 0.04 && startup > 8) s *= 0.7;
      if (rates.dodgeFreq > 0.04 && startup <= 4) s *= 1.25;
      // - Opp spams one attack → pick the counter-range (if they spam side,
      //   meet with up; the scoring already reflects geometry, add a nudge).
      if (rates.spamKey && rates.spamKey !== key) s *= 1.05;
      // §27 full-kit variety: rarely-used owned abilities get a small bonus
      // so the AI rotates through specials/projectiles instead of camping on
      // jab/ftilt. Bonus is capped and never overrides geometry/risk.
      const uses = this.abilityUses[_abilityUseKey(key)] || 0;
      const totalUses = _totalUses;
      if (totalUses >= 6 && uses === 0) s *= 1.3;
      else if (totalUses >= 10 && uses * 4 < totalUses) s *= 1.15;
      // §30 vertical positioning — explicit axis bonuses on top of vBias:
      // falling toward us → anti-air premium; we are above → downward/aerial
      // premium; opp far above → jump/uppercut premium (handled by caller too).
      if (P.oppFallingToward && (key === 'utilt' || key === 'usmash' || key === 'aerialHeavy')) s *= 1.4;
      if (P.aiAbove && !f.grounded && (key === 'aerialLight' || key === 'aerialHeavy')) s *= 1.25;
      if (P.aiAbove && f.grounded && key === 'dtilt') s *= 1.15;
      // ── Down-attack intelligence (situation-driven, never random) ──
      // Down Light: close, grounded or landing opponent at/below our level;
      // approaching, vulnerable, or punishable targets; valid combo starter
      // (fast startup) and follow-up when the victim drops low.
      if (key === 'dtilt' && f.grounded) {
        const lowBand = P.vDist >= -24 && P.vDist <= 72;
        const inReach = P.hDist < (R.fwd || 80) + 30;
        if (R.kind === 'deadeye') {
          // Deadeye volley: homing bullets punish approaches, pressure and
          // vulnerable targets at close-to-mid range. Never waste it while a
          // volley is already live.
          if (f._deadeye) s *= 0.05;
          else if (P.hDist < 430) {
            s *= 1.2;
            if (P.oppApproaching || P.oppAttacking) s *= 1.5;
            if (P.oppVulnerable || P.oppWhiff) s *= 1.5;
            if (P.oppLanding) s *= 1.35;
            if (P.hDist < 200) s *= 1.25; // close volleys barely miss
            if (P.oppGrounded && lowBand) s *= 1.2;
          } else s *= 0.3;
        } else if (lowBand && inReach && P.oppGrounded) {
          s *= 1.6; // Low Sweep class: the core grounded punish/poke
          if (P.oppApproaching) s *= 1.3;
          if (P.oppVulnerable || P.oppWhiff) s *= 1.5; // combo starter
          if (P.oppLanding) s *= 1.4;
        } else if (P.oppLanding && P.hDist < (R.fwd || 80) + 60) {
          s *= 1.35; // meet the landing
        } else if ((P.oppVulnerable || P.oppWhiff) && inReach) {
          s *= 1.4; // punish, even slightly off-level
        }
        // Combo follow-up: victim stunned and dropping toward the ground.
        if ((P.oppVulnerable) && !P.oppGrounded && P.oppVy > 40 && P.hDist < 220) s *= 1.4;
        // Wrong tool when the opponent holds the high ground (melee only —
        // Deadeye homing still works from below).
        if (P.oppAbove && R.kind !== 'deadeye') s *= 0.35;
      }
      // Down Heavy: downward/ground-oriented punish. Horse needs grounded foe
      // in front at ride range; Shadow Strike dashes gaps to punish landing,
      // recovering or vulnerable targets — never a blind neutral swing.
      if (key === 'dsmash' && f.grounded) {
        if (R.kind === 'horse') {
          const groundedFoe = P.oppGrounded && P.vDist >= -40 && P.vDist <= 56;
          const rideBand = P.hDist > 50 && P.hDist < 300;
          if (groundedFoe && rideBand && this.horseSafe()) {
            s *= 1.7;
            if (P.oppApproaching) s *= 1.3;
            if (P.oppLanding) s *= 1.4;
            if (P.oppVulnerable || P.oppWhiff) s *= 1.5;
          } else if (P.oppRecovery > 0 && Math.abs(oppY - f.y) < 90 && P.hDist < 300 && this.horseSafe()) {
            s *= 1.6; // recovering low → trample the recovery
          } else if (!this.horseSafe()) {
            s *= 0.15; // never ride off an edge
          } else s *= 0.55;
          if (P.oppAbove) s *= 0.4;
        } else if (R.kind === 'dash') {
          // Shadow Strike: slow startup, so punish-only.
          const punishWindow = P.oppVulnerable || P.oppWhiff || P.oppLanding || P.oppRecovery > 0;
          if (punishWindow && P.hDist > 70 && P.hDist < 300) s *= 1.6;
          else if (!punishWindow) s *= 0.6;
          if (P.oppAbove) s *= 0.4;
        }
      }
      // Combo follow-up routing by launch direction: victim popped upward →
      // up/aerial tools (down tools suppressed); victim stunned and sinking →
      // down tools become the follow-up.
      if (P.oppVulnerable && !P.oppGrounded) {
        if (P.oppVy < -120 && (key === 'dtilt' || key === 'dsmash')) s *= 0.5;
        if (P.oppVy > 60 && (key === 'dtilt' || key === 'dsmash') && P.hDist < 220) {
          const landsNear = (P.stageTop - oppY) < 200;
          if (landsNear) s *= 1.5;
        }
      }
      // Predicted connect chance gates the score: real alignment (this
      // attack's hitbox vs. the predicted hurtbox) beats any static range.
      // Lunges keep partial credit (they close distance); dead reads die.
      if (R.kind === 'dash' || R.kind === 'horse') s *= 0.45 + 0.55 * connect;
      else if (R.kind === 'projectile' || R.kind === 'deadeye') s *= 0.35 + 0.65 * connect;
      else s *= 0.2 + 0.8 * connect;
      // (The pirate's former Plunder nudge lived here — removed with the
      // passive, so cannon moves score on the connect gate alone.)
      // Recency variety: repeating the same swing scores worse, so the AI
      // rotates through Light / Heavy / Down / Smash / aerial / special
      // instead of camping one move. Reachability (the connect gate in
      // chooseAndFire) always outranks variety — this only reorders VALID
      // options, never forces a random or unreachable pick. Punishes and
      // combo follow-ups take half the penalty so true sequences still flow.
      if (this.recentAttacks && this.recentAttacks.length) {
        const idx = this.recentAttacks.lastIndexOf(key);
        if (idx >= 0) {
          const ago = this.recentAttacks.length - 1 - idx; // 0 = previous swing
          let pen = ago === 0 ? 0.35 : ago === 1 ? 0.55 : ago === 2 ? 0.7 : ago === 3 ? 0.82 : 0.9;
          if (P.oppVulnerable || P.oppWhiff) pen = 1 - (1 - pen) * 0.5;
          s *= pen;
        }
      }
      // Zoner pacing: projectiles/Deadeye volleys need no approach, so
      // without pacing the AI camps one zoning move forever. After firing one,
      // other zoners are strongly suppressed for 2.5s — forcing the AI to
      // close distance and use its melee mix instead. Still fires a zoner when
      // it is the only reachable option (score reorder only, gate untouched).
      if (now != null && (R.kind === 'projectile' || R.kind === 'deadeye')
          && now - (this.lastZonerAt || -1e9) < 2500) {
        s *= 0.3;
      }
      // Neural steering: the trained net biases (never dictates) the pick.
      // Illegal options are still filtered by the attack gate + combatInput.
      if (this.neuroNet && this.neuroInfluence > 0 && this._nnOut) {
        s *= this._neuroBias(nnOutputForAttackKey(key));
      }
      _scoreRec(outN, key, def, s, startup, recovery, prof.risk, connect, R.kind, prefDist, R.fwd || 60);
      out[outN] = _scorePool[outN];
      outN++;
    }
    out.length = outN;
    out.sort(_scoreDesc);
    return out;
  }

  chooseAndFire(now, hDist, vDist, allowPacing = false) {
    const f = this.fighter;
    if (!f) return false;
    const P = buildPerception(f, this.opponent, this._stageHint);
    const pers = this.personality;
    // §46 attack gate — the full pre-attack checklist, same locks as the
    // player: cooldown ready AND able to act AND target in reasonable range.
    // (Range/situation validity is scored below; combatInput re-gates anyway.)
    // When the lock is live the caller falls through to movement/defense, so
    // the AI repositions during cooldowns instead of standing still.
    if (!P.attackReady) return false;
    if (f.hitstun > 0 || f.attack || f.dodging || f._hitLock) return false;
    // Attack-frequency gate: not every in-range decision must swing (human
    // pacing + AIvsAI variety). Combos/punishes bypass the gate.
    const mustStrike = P.oppVulnerable || P.oppWhiff;
    if (!mustStrike && Math.random() > pers.attackFrequency + pers.aggression * 0.25) {
      try { this.diag.freqBlock++; } catch (_) {}
      return false;
    }
    const scored = this.scoreAttacks(P, now);
    if (!scored.length || scored[0].score < 0.12) {
      try { this.diag.noScore++; } catch (_) {}
      return false;
    }
    // Accuracy gate: only attacks with a realistic predicted connection may
    // fire. Punishes accept a thinner margin; everything else must plausibly
    // land. When nothing connects, do NOT swing anyway — remember the best
    // option as approach intent and close the distance instead.
    // (mustStrike is defined above at the frequency gate.)
    const gate = mustStrike ? 0.2 : 0.3;
    // In-place filter into a reused buffer. `scored` is already sorted
    // best-first and the gate preserves order, so the reachable set inherits
    // that ranking — the same result the old `.filter()` produced, without
    // allocating a new array plus a closure on every decision.
    const reachable = _reachableBuf;
    let reachN = 0;
    for (let i = 0; i < scored.length; i++) {
      const e = scored[i];
      if ((e.connect || 0) >= gate && e.score >= 0.12) reachable[reachN++] = e;
    }
    reachable.length = reachN;
    if (!reachN) {
      try { this.diag.gateBlock++; } catch (_) {}
      const want = scored[0];
      if (want) {
        this.aimKey = want.key;
        this.aimUntil = now + 1500;
        this.aimDist = want.prefDist || 90;
        this._setPlan(P.dx > 10 ? 1 : P.dx < -10 ? -1 : 0);
        this.planUntil = now + 200;
        this.noteAction('approach-range');
        this.debug.state = 'approach-range';
      }
      return false;
    }
    // Soft pick among reachable attacks: usually the best, sometimes the
    // runner-up (unpredictability). Lower difficulties second-guess more.
    // No re-sort: scoreAttacks already returned best-first and filter preserves
    // order, so reachable inherits it.
    // Deliberate pacing (§24/32) — neutral only, and ONLY when there is no
    // high-confidence opening. A reachable attack at connect ≥ 0.55 strikes
    // immediately instead of strafing away a real chance.
    const mustVary = this.repeatCount >= 4;
    if (allowPacing && !mustStrike && !mustVary
        && (reachable[0].connect || 0) < 0.55
        && Math.random() > pers.attackFrequency + 0.1) {
      const r = Math.random();
      if (r < 0.4) {
        if (now >= this.strafeUntil) { this.strafeDir = Math.random() < 0.5 ? -1 : 1; this.strafeUntil = now + 400; }
        this._setPlan(this.strafeDir);
        this.planUntil = now + 200;
        this.noteAction('strafe');
      } else if (r < 0.55 && f.grounded) {
        this.doJump(now, 115);
        this._setPlan(this.strafeDir);
        this.planUntil = now + 200;
        this.noteAction('reposition-hop');
      } else {
        this._setPlan(0);
        this.planUntil = now + 160;
        this.noteAction('micro-spacing');
      }
      this.moveTicks++;
      return false;
    }
    let pick = reachable[0];
    const wobble = 0.22 + (this.mistakeRate || 0) * 0.9;
    if (reachable.length > 1 && Math.random() < wobble) pick = reachable[1];
    // Risk gate: laggy picks need a calm moment unless very aggressive.
    if (pick.risk > 0.65 && P.oppAttacking && P.hDist < 130 && Math.random() > pers.riskTolerance) {
      const safe = reachable.find((c) => c.risk < 0.4);
      if (safe) pick = safe;
    }
    const key = pick.key;
    const dx = (this.opponent ? this.opponent.x - f.x : 0) || 0;
    const wantLeft = dx < -8;
    const wantRight = dx > 8;
    const sideDir = { left: wantLeft, right: wantRight };
    // Alignment: directed attacks only threaten the faced direction. If we
    // are not facing the opponent, turn + close in first — never swing
    // backwards into empty space.
    const directedKind = pick.kind === 'melee' || pick.kind === 'dash'
      || pick.kind === 'horse' || pick.kind === 'projectile';
    if (directedKind && !facingOppNow(f, dx)) {
      this.aimKey = key;
      this.aimUntil = now + 1200;
      this.aimDist = pick.prefDist || 90;
      this._setPlan(dx > 0 ? 1 : -1);
      this.planUntil = now + 200;
      this.noteAction('turn-approach');
      try { this.diag.turnFix++; } catch (_) {}
      this.debug.state = 'turn-approach';
      return false;
    }
    try { this.diag.fired++; } catch (_) {}
    const fire = (type, dir, note) => {
      this.doAttack(type, dir, now);
      this.noteAction(note || key);
      this.aimKey = null;
      // Zoner pacing timestamp (projectile / Deadeye volley just fired).
      try {
        if (pick.kind === 'projectile' || pick.kind === 'deadeye') this.lastZonerAt = now;
      } catch (_) {}
      // Recency window for the variety penalty (last 8 chosen swings).
      try {
        this.recentAttacks.push(key);
        if (this.recentAttacks.length > 8) this.recentAttacks.shift();
      } catch (_) {}
      this.debug.action = note || key;
    };
    if (!f.grounded) {
      if (key === 'aerialHeavy') { fire('special', {}, 'aerialHeavy'); return true; }
      fire('attack', {}, 'aerialLight'); return true;
    }
    // Map key → real input (light vs heavy + direction), exactly as a human.
    if (key === 'jab') fire('attack', {}, 'jab');
    else if (key === 'nsmash') fire('special', {}, 'nsmash');
    else if (key === 'ftilt' || key === 'btilt') fire('attack', sideDir, key);
    else if (key === 'fsmash' || key === 'bsmash') fire('special', sideDir, key);
    else if (key === 'utilt') fire('attack', { up: true }, 'utilt');
    else if (key === 'usmash') fire('special', { up: true }, 'usmash');
    else if (key === 'dtilt') fire('attack', { down: true }, 'dtilt');
    else if (key === 'dsmash') fire('special', { down: true }, 'dsmash');
    else if (key === 'dash') fire('attack', sideDir, 'dash');
    else fire('attack', {}, key);
    return true;
  }

  makeDecision(now, stage) {
    const f = this.fighter;
    const opp = this.opponent;
    if (!f || !opp) return;
    const pers = this.personality;
    // Refresh the steering network once per decision (cheap: one forward pass
    // per ~150ms). All scoring below reads this._nnOut as bias terms only.
    if (stage) this._stageHint = stage;
    try { this.ensureNeuro(); } catch (_) { this._nnOut = null; }

    // Never decide while locked out — hold current inputs and wait.
    // (update() gates on the same condition so a locked-out fighter never
    // burns its reaction window; this stays as a second line of defence.)
    if (f.hitstun > 0 || f.attack || f.dodging || f._hitLock) {
      this.debug.state = 'busy';
      return;
    }

    const P = buildPerception(f, opp, stage);
    const stuck = this.updateStuck(now);
    const mustVary = this.repeatCount >= 4;

    // ── 1. RECOVERY (highest priority) ──────────────────────────────
    // Separate resources, never wasted together: exactly ONE resource per
    // decision (DJ → Aerial-Light → up-special), re-evaluated next tick.
    if (P.ownUrgency > 0) {
      this.debug.state = P.ownUrgency === 2 ? 'recover-urgent' : 'recover';
      const g = mainGround(stage);
      const targetX = g ? g.x + g.width / 2 : 600;
      const toward = targetX - f.x;
      this._setPlan(toward > 10 ? 1 : toward < -10 ? -1 : 0);
      this.planUntil = now + 220;

      const falling = f.vy > 60;
      const belowStage = g ? f.y > g.y - 20 : f.y > 800;
      const needNow = (falling || belowStage || P.ownUrgency === 2) && !f.grounded;

      // Character recovery properties
      const recoveryStrength = f.recoveryStrength || 1;
      const recoveryRange = f.recoveryRange || 1;
      const recoveryCooldown = f.recoveryCooldown || 0;
      const hasRecoveryCooldown = this._recoveryCooldownTimer > 0;

      if (needNow) {
        const urgencyScale = pers.recoveryPriority;
        // Double jump first (the reusable height engine) — not at the apex,
        // only when falling/below or truly urgent.
        // Adjust probability based on recovery strength
        const djProb = 0.35 + urgencyScale * 0.65 * recoveryStrength;
        if (f.canDoubleJump && (falling || belowStage || P.ownUrgency === 2) && Math.random() < djProb) {
          this.doJump(now, 130);
          this.noteAction('dj-recover');
          this.debug.action = 'double-jump';
          return;
        }
        // Then Aerial Light (strong self-launch, independent of DJ).
        // Consider recovery strength and cooldown
        const alProb = 0.35 + urgencyScale * 0.65 * recoveryStrength;
        if (f.canUseAerialLightRecovery && !hasRecoveryCooldown && Math.random() < alProb) {
          this.doAttack('attack', {}, now);
          this.noteAction('al-recover');
          this.debug.action = 'aerialLight-recover';
          // Start recovery cooldown if configured
          if (recoveryCooldown > 0) this._recoveryCooldownTimer = recoveryCooldown;
          return;
        }
        // Last resort: up-special (consumes free-fall — never first).
        // Consider recovery strength, range, and cooldown
        if (!f.freeFall && !hasRecoveryCooldown) {
          this.setHeld('up', true);
          this.setHeld('left', toward < 0);
          this.setHeld('right', toward > 0);
          this.pressButton('special', 100, now);
          this.noteAction('up-special');
          this.debug.action = 'up-special';
          // Start recovery cooldown if configured
          if (recoveryCooldown > 0) this._recoveryCooldownTimer = recoveryCooldown;
          return;
        }
      }
      return;
    }

    // ── 1b. STAGE-CENTER SAFETY (§41 — never fight the edge for free) ──
    // Continuous positioning monitor, checked every decision before any
    // aggression (recovery already ran above and owns the off-stage case —
    // DJ/AL/up-special steering there aims at center too). Tiers:
    //   safe (inside ≥ 150, or edgeguarding) → normal combat below;
    //   drifting (inside < 150 + moving toward edge) → bias home, may attack;
    //   close (inside < 70) → strongly return; attack only on instant punish;
    //   airborne + sliding out → steer home (recovery owns DJ/AL spending).
    // Opponent off-stage ⇒ we belong at the edge (edgeguard next), so this
    // branch yields. Chasing a healthy on-stage opponent past the edge is
    // never worth it — hold the line instead.
    if (P.ownUrgency === 0 && P.oppRecovery === 0) {
      // A punishable victim overrides positioning: fall through to combo/
      // punish below (which gates the actual swing on the attack lock) so a
      // stunned opponent at the edge gets finished, not abandoned. A
      // high-percent opponent is hunted the same way — letting them reset to
      // neutral at 100%+ is how grinds happen.
      const immediatePunish = ((P.oppVulnerable || P.oppWhiff) && P.hDist < 200)
        || P.oppPercent > 90;
      const closeEdge = P.signedInside < 70;
      // Drift veto applies when sliding toward the edge AWAY from the
      // opponent (bad positioning) — never when chasing them toward it.
      // (Chases die at the lip via the grounded clamp + edgeguard logic.)
      const driftingOut = P.signedInside < 150 && P.movingTowardEdge
        && Math.sign(f.vx || 0) !== Math.sign(P.dx || 0);
      if ((closeEdge || driftingOut) && !immediatePunish) {
        const home = P.centerDir !== 0 ? P.centerDir : -P.edgeSide;
        if (!f.grounded) {
          // Airborne but still over/near the platform: steer home, no
          // resource spending here (recovery branch owns DJ/AL).
          this.debug.state = 'center-steer';
          this._setPlan(home);
          this.planUntil = now + 200;
          this.noteAction('center-steer');
          return;
        }
        this.debug.state = 'center-return';
        const threatened = P.oppAttacking && P.hDist < 200;
        // Urgent (at the lip or pressured): dash-dodge home when ready —
        // the §23 dash-dodge, same cooldown the player obeys.
        if ((P.signedInside < 35 || threatened) && P.dodgeReady && Math.random() < 0.6 + pers.defense * 0.3) {
          this.doDodge(now, home);
          this._setPlan(home);
          this.planUntil = now + 200;
          this.noteAction('center-dash');
          this.debug.action = 'dodge-center';
          return;
        }
        // Otherwise walk/run home; hop the gap shut when far from center.
        this._setPlan(home);
        this.planUntil = now + 220;
        if (Math.abs(f.x - P.centerX) > 200 && Math.random() < 0.35) {
          this.doJump(now, 125);
          this.noteAction('center-hop');
        } else {
          this.noteAction('center-return');
        }
        return;
      }
    }

    // ── 2. EDGEGUARD ────────────────────────────────────────────────
    // Opp off-stage + vulnerable: pursue only when safe, intercept with the
    // right aerial, always keep a way home. Never suicide. At high opp
    // percent the AI hunts the finish (higher pursuit chance, deeper but
    // still resource-safe). §41 chase-risk: a grounded fighter never runs
    // past the edge after a healthy opponent — hold the edge and punish the
    // recovery instead.
    const killHunt = P.oppPercent > 70 ? 0.25 : (P.oppPercent > 45 ? 0.12 : 0);
    if (P.oppRecovery > 0 && P.ownUrgency === 0 && Math.random() < Math.min(1, pers.edgeguardPriority + killHunt)) {
      this.debug.state = 'edgeguard';
      const g = mainGround(stage);
      const oppVuln = opp.hitstun > 0 || opp.freeFall || !opp.canDoubleJump;
      if (g) {
        // Stand at the edge nearest the opponent (adapt to their recovery side).
        const edgeX = opp.x < (g.x + g.width / 2) ? g.x + 30 : g.x + g.width - 30;
        const ex = edgeX - f.x;
        this._setPlan(ex > 15 ? 1 : ex < -15 ? -1 : 0);
        this.planUntil = now + 220;
      }
      // Safe aerial pursuit: airborne, have resources to return, opp low/close.
      const canPursue = !f.grounded
        ? (f.canDoubleJump || f.canUseAerialLightRecovery)
        : (f.canDoubleJump && f.canUseAerialLightRecovery);
      const deepRisk = P.distToBlast < 220 || Math.abs(opp.y - f.y) > 320;
      if (!f.grounded && canPursue && !deepRisk && P.dist < 200 && (oppVuln || Math.random() < 0.5)) {
        // Intercept with the geometry-correct aerial (above → heavy, else light).
        this.chooseAndFire(now, P.hDist, P.vDist);
        return;
      }
      if (f.grounded && P.hDist < 175 && Math.abs(P.vDist) < 190) {
        this.chooseAndFire(now, P.hDist, P.vDist);
        return;
      }
      // Jump to meet a high-recovering opponent when grounded and safe.
      if (f.grounded && P.vDist < -90 && P.hDist < 200 && oppVuln && Math.random() < 0.5) {
        this.doJump(now, 130);
        this._setPlan(P.dx > 0 ? 1 : -1);
        this.planUntil = now + 220;
        this.noteAction('edgeguard-jump');
        return;
      }
      // Deep intercept vs a HIGH-PERCENT recovery: the reward justifies
      // leaving the edge when both resources are banked (DJ + AL — one out,
      // one home). Below 80% the chase-risk rule below holds instead.
      if (f.grounded && P.oppPercent >= 80 && P.oppEdgeInside < -40
        && f.canDoubleJump && f.canUseAerialLightRecovery
        && Math.random() < pers.edgeguardPriority) {
        this.doJump(now, 130);
        this._setPlan(P.dx > 0 ? 1 : -1);
        this.planUntil = now + 260;
        this.noteAction('edgeguard-deep');
        this.debug.action = 'edgeguard-deep';
        return;
      }
      // §41 chase-risk: grounded at the edge vs a HEALTHY opponent far
      // off-stage — do NOT run off after them. Hold inside the edge; the
      // grounded punish above fires when they come back in range.
      if (f.grounded && !oppVuln && P.oppEdgeInside < -60 && P.oppPercent < 80) {
        this.debug.state = 'edgeguard-hold';
        this._setPlan(0);
        this.planUntil = now + 220;
        this.noteAction('edgeguard-hold');
        return;
      }
      return;
    }

    // ── 3. DEFENSE ──────────────────────────────────────────────────
    // Block / dodge / move / jump / fast-fall / retreat. Never permanently
    // hold block (doShield caps + gaps). Punish whiffs immediately after.
    if (P.oppWhiff && P.hDist < 185 && !mustVary) {
      this.debug.state = 'punish';
      this._setPlan(P.dx > 10 ? 1 : P.dx < -10 ? -1 : 0);
      this.planUntil = now + 200;
      this.chooseAndFire(now, P.hDist, P.vDist);
      return;
    }
    if (!mustVary && P.oppAttacking && P.hDist < 140) {
      const rates = this.adaptRates();
      // Anticipate spammed attacks: defend earlier vs the habit.
      const defendBias = pers.defense + (rates.spamKey ? 0.15 : 0);
      if (Math.random() < defendBias) {
        const r = Math.random();
        // Fast-fall escape when juggled from below.
        if (!f.grounded && P.oppBelow && f.vy > -50 && Math.random() < 0.35) {
          this.setHeld('down', true);
          this._setPlan(P.dx > 0 ? -1 : 1, false, true);
          this.planUntil = now + 180;
          this.noteAction('fastfall-escape');
          this.debug.state = 'defense-fastfall';
          return;
        }
        // §46: check the SAME cooldowns the player obeys — block only when
        // blockReady, dodge only when dodgeReady, otherwise fall through to
        // retreat/reposition instead of mashing a locked defense.
        if (r < 0.52 && f.grounded && P.blockReady) {
          this.debug.state = 'block';
          // Knight parry tap: against a committed close foe with the parry off
          // cooldown, tap shield instead of holding — the press edge opens the
          // parry stance timed to the incoming swing. Same windows, cooldowns
          // and whiff lockout as a human knight; the 0.45 gate plus the shield
          // gaps/cooldown keep attempts honest, never perfect.
          const isKnight = f._fighterDef && f._fighterDef.id === 'knight';
          const parryReady = isKnight && !(f.abilityCooldowns && f.abilityCooldowns.knightParry > 0) && !(f._parryWindow > 0);
          if (parryReady && Math.random() < 0.45) this.doShield(now, 110 + Math.random() * 60);
          else this.doShield(now, 300 + Math.random() * 200);
          this.noteAction('block');
          this.debug.action = 'block';
          return;
        }
        if (P.dodgeReady && Math.random() < pers.riskTolerance + 0.3) {
          this.debug.state = 'dodge';
          // Dodge AWAY from the opponent (or toward, rarely, to cross up).
          const away = P.dx > 0 ? -1 : 1;
          this.doDodge(now, Math.random() < 0.85 ? away : -away);
          this.noteAction('dodge');
          this.debug.action = 'dodge';
          return;
        }
        // Otherwise retreat + reposition (walk, not dodge).
        this.debug.state = 'retreat';
        this._setPlan(P.dx > 0 ? -1 : 1);
        this.planUntil = now + 200;
        // Jump over a grounded rush.
        if (f.grounded && P.oppGrounded && P.hDist < 90 && Math.random() < 0.4) {
          this.doJump(now, 130);
          this.noteAction('defense-jump');
        }
        return;
      }
    }

    // ── 4. COMBO / FOLLOW-UP ────────────────────────────────────────
    // Hit connects (opp percent rose or opp in hitstun after our strike):
    // predict trajectory, drift into follow-up position, strike with the
    // geometry-correct move. Adaptive, never scripted.
    const oppVulnerable = P.oppVulnerable;
    if (!mustVary && oppVulnerable && P.hDist < 195 && Math.random() < pers.comboPriority) {
      this.comboCount += 1;
      if (this.comboCount <= 4) {
        this.debug.state = 'combo';
        // Predict where the victim will be (~0.25s ahead with gravity).
        const t = 0.25;
        const predX = opp.x + (opp.vx || 0) * t;
        const predY = opp.y + (opp.vy || 0) * t + 0.5 * 1750 * t * t * 0.4;
        const cdx = predX - f.x;
        this._setPlan(cdx > 12 ? 1 : cdx < -12 ? -1 : 0);
        this.planUntil = now + 200;
        // Chase airborne victims into the air when it pays.
        if (f.grounded && (predY < f.y - 80) && Math.random() < 0.45 + pers.comboPriority * 0.3) {
          this.doJump(now, 130);
          this.noteAction('combo-chase-jump');
          this.debug.action = 'jump';
          return;
        }
        this.chooseAndFire(now, P.hDist, P.vDist);
        return;
      }
    } else if (!oppVulnerable) {
      this.comboCount = 0;
    }

    // ── 5. STUCK UNSTICK ────────────────────────────────────────────
    if (stuck) {
      this.debug.state = 'unstick';
      this._setPlan((f.facingRight ? -1 : 1));
      this.planUntil = now + 350;
      if (!f.grounded && f.canDoubleJump) this.doJump(now, 130);
      else if (f.grounded && Math.random() < 0.7) this.doJump(now, 130);
      this.noteAction('unstick');
      return;
    }

    // ── 6. UNIFIED NEUTRAL (§24/25/28/30/31/32) ───────────────────────────
    // One pipeline, re-evaluated every decision (never a fixed script):
    //   game state → desired position (distance bands) → threat → approach or
    //   retreat? → defensive options? → attacks? → vertical? → vulnerability?
    //   → score movement AND attack actions together → execute best.
    // Movement actions (approach/retreat/strafe/dash/jump/fast-fall/
    // reposition) compete with attacks every tick, so the AI visibly moves,
    // creates distance, and sometimes deliberately repositions instead of
    // forcing an attack (§32).
    this.debug.state = 'neutral';
    const rates = this.adaptRates();
    const minSafe = pers.minimumSafeDistance ?? 55;
    const maxEngage = pers.maximumEngagementDistance ?? 260;
    const tooClose = P.hDist < minSafe;
    const tooFar = P.hDist > maxEngage;
    const inPocket = !tooClose && !tooFar;

    // §29 post-attack reposition: our swing just ended — knockback, positions
    // and the opponent's likely reply decide follow-up vs safe distance vs
    // intercept jump (never auto-stand beside them).
    if (this.wasAttacking && !f.attack && now - this.lastAttackEndedAt < 500) {
      this.wasAttacking = false;
      const oppFlying = P.oppHitstun > 0 && P.oppSpeed > 200;
      if (oppFlying && P.hDist < 195 && Math.random() < pers.comboPriority) {
        // Continue: combo branch below handles the chase; fall through.
      } else if (tooClose && Math.random() < 0.55 + (1 - pers.aggression) * 0.3) {
        this.debug.state = 'reposition';
        // Back out to preferred range (dash-dodge out when pressured).
        if (f.dodgeCooldown <= 0 && (P.oppAttacking || P.oppSpeed > 200) && Math.random() < 0.5) {
          this.doDodge(now, P.dx > 0 ? -1 : 1);
          this.noteAction('reposition-dash');
          this.debug.action = 'dodge-reposition';
        } else {
          this._setPlan(P.dx > 0 ? -1 : 1);
          this.planUntil = now + 200;
          this.noteAction('reposition-retreat');
        }
        return;
      } else if (!tooClose && Math.random() < 0.35) {
        // Strafe to a new angle instead of standing still.
        this.strafeDir = Math.random() < 0.5 ? -1 : 1;
        this.strafeUntil = now + 260;
        this._setPlan(this.strafeDir);
        this.planUntil = now + 220;
        this.noteAction('reposition-strafe');
        return;
      }
      // Else fall through to the unified scoring below.
    }

    // Score movement + attack actions TOGETHER (§28). Each entry: {id, score}.
    // Pooled buffer: this used to allocate up to 8 object literals plus a fresh
    // sort comparator on every neutral decision. The entries are read only
    // within this block, so the buffer can be reused.
    const actions = _actionBuf;
    let aN = 0;
    const pushAction = (id, score) => {
      const a = _actionRec(aN++);
      a.id = id; a.score = score;
      actions[aN - 1] = a;
    };
    const wantDir = P.dx > 0 ? 1 : -1; // toward opponent
    const awayDir = -wantDir;
    // — spacing desires from the distance bands (§25)
    if (tooClose) {
      pushAction('create-distance', 1.5 + (1 - pers.aggression) * 0.8);
      pushAction('attack', 0.7 + pers.aggression * 0.6);
    } else if (tooFar) {
      pushAction('approach', 1.5 + pers.aggression * 0.5);
      pushAction('attack', P.dist > 340 ? 0.6 : 0.25); // zone only
    } else {
      pushAction('attack', 1.05);
      pushAction('reposition', 0.9 + (1 - pers.aggression) * 0.4);
      pushAction('approach', 0.5);
    }
    if (P.oppAttacking && P.hDist < 200) pushAction('defend', 1.2 + pers.defense * 0.8);
    if (P.incoming && P.incoming.timeToHit < 0.55) pushAction('dodge-projectile', 1.8);
    if (P.oppAboveFar || (P.oppAbove && f.grounded)) pushAction('vertical-meet', 1.1);
    if (P.aiAbove && !f.grounded) pushAction('vertical-descend', 0.9);
    if (P.oppFallingToward) pushAction('anti-air', 1.4);
    // Neural steering for movement: the net's directional preferences bias
    // (never dictate) the winning action. Indices follow NN_OUTPUT_LABELS.
    if (this.neuroNet && this.neuroInfluence > 0 && this._nnOut) {
      for (let ai = 0; ai < aN; ai++) {
        const a = actions[ai];
        if (a.id === 'approach') a.score *= this._neuroBias(17);
        else if (a.id === 'create-distance') a.score *= this._neuroBias(18);
        else if (a.id === 'reposition') a.score *= this._neuroBias(2);
        else if (a.id === 'defend') a.score *= Math.max(this._neuroBias(4), this._neuroBias(5));
        else if (a.id === 'attack') {
          const atk = this._nnOut;
          let mean = 0, n = 0;
          for (let oi = 6; oi <= 16 && oi < atk.length; oi++) {
            if (Number.isFinite(atk[oi])) { mean += atk[oi]; n++; }
          }
          mean = n ? mean / n : 0;
          a.score *= 1 + (this.neuroInfluence || 0) * Math.max(-1, Math.min(1, mean));
        }
        else if (a.id === 'anti-air' || a.id === 'vertical-meet') a.score *= this._neuroBias(10, 15);
        else if (a.id === 'vertical-descend') a.score *= this._neuroBias(14, 3);
        else if (a.id === 'dodge-projectile') a.score *= this._neuroBias(5);
      }
      // Directional nudge: moveLeft/moveRight outputs tilt approach/retreat
      // toward the side the network prefers when it disagrees with geometry.
      try {
        const nl = this._nnOut[0] || 0, nr = this._nnOut[1] || 0;
        const pref = nr - nl; // >0 = prefers moving right
        if (Number.isFinite(pref) && Math.abs(pref) > 0.25) {
          const wantRight = wantDir > 0;
          const agrees = (pref > 0) === wantRight;
          for (let ai = 0; ai < aN; ai++) {
            const a = actions[ai];
            if (a.id === 'approach') a.score *= agrees ? 1 + this.neuroInfluence * 0.25 : 1 - this.neuroInfluence * 0.15;
          }
        }
      } catch (_) {}
    }
    // Aimed intent: we want a specific attack but are out of its range —
    // close to its preferred distance instead of swinging something random.
    // This also runs through the 0.83s attack lock, so the AI keeps working
    // (approach/reposition) while waiting for the next legal swing.
    if (this.aimKey && now < this.aimUntil && P.oppRecovery === 0 && P.hDist > (this.aimDist || 90) + 20) {
      for (let ai = 0; ai < aN; ai++) {
        const a = actions[ai];
        if (a.id === 'approach') a.score *= 2.2;
        if (a.id === 'attack') a.score *= 0.4;
      }
    } else if (this.aimKey && now >= this.aimUntil) {
      this.aimKey = null;
    }
    // Weight by personality: movers move, aggressors press.
    for (let ai = 0; ai < aN; ai++) {
      const a = actions[ai];
      if (a.id === 'attack') a.score *= 0.6 + pers.attackFrequency * 0.8 + pers.aggression * 0.3;
      if (a.id === 'reposition' || a.id === 'create-distance') a.score *= 0.7 + (1 - pers.aggression) * 0.5 + 0.3;
      // §46: attack on cooldown scores ~zero, so movement/defense win the
      // tick and the AI repositions through the lock instead of queuing air.
      if (a.id === 'attack' && !P.attackReady) a.score *= 0.05;
      if (a.id === 'anti-air' && !P.attackReady) a.score *= 0.4;
    }
    actions.length = aN;
    actions.sort(_actionDesc);
    let choice = aN ? actions[0].id : 'reposition';
    // Difficulty mistake injection: lower levels deliberately fumble a share
    // of neutral decisions (wrong spacing, hesitant strafe) instead of
    // playing the best move. Higher levels (mistakeRate ~0) never hit this.
    if (this.mistakeRate > 0 && aN > 1 && Math.random() < this.mistakeRate) {
      const alt = actions[1 + ((Math.random() * (aN - 1)) | 0)];
      if (alt) choice = alt.id;
    }

    // Edge safety shared by all movement choices: never walk off a ledge.
    const edgeBlocked = (() => {
      if (!f.grounded) return false;
      const g = mainGround(stage);
      if (!g) return false;
      const aheadX = f.x + wantDir * 80;
      return aheadX < g.x || aheadX > g.x + g.width;
    })();

    if (choice === 'dodge-projectile' && P.incoming) {
      // §26 projectile: dash/jump/reposition off the trajectory, imperfectly.
      this.debug.state = 'dodge-projectile';
      if (Math.random() < pers.defense * 0.9 + 0.1) {
        const sideAway = (f.y <= P.incoming.y) ? -1 : 1; // vertical queen first
        if (f.dodgeCooldown <= 0 && Math.random() < 0.6) {
          this.doDodge(now, P.dx > 0 ? -1 : 1);
          this.noteAction('projectile-dash');
          this.debug.action = 'dodge-projectile';
        } else if (f.grounded && sideAway < 0 && Math.random() < 0.55) {
          this.doJump(now, 120);
          this._setPlan(awayDir);
          this.planUntil = now + 200;
          this.noteAction('projectile-jump');
        } else {
          this._setPlan(awayDir);
          this.planUntil = now + 200;
          this.noteAction('projectile-reposition');
        }
      } else {
        // Reaction failure: keep pressure (looks human, not perfect).
        this._setPlan(wantDir);
        this.planUntil = now + 160;
      }
      return;
    }

    if (choice === 'anti-air' || choice === 'vertical-meet') {
      // §30 opponent above / falling onto us: uppercut, aerial, jump or slide out.
      this.debug.state = 'vertical';
      const r = Math.random();
      if (!f.grounded && Math.random() < 0.55) {
        this.chooseAndFire(now, P.hDist, P.vDist); // aerialHeavy vs above
        return;
      }
      if (f.grounded && r < 0.45) {
        if (this.chooseAndFire(now, P.hDist, P.vDist)) return; // utilt/usmash via scoring
      } else if (f.grounded && r < 0.7) {
        this.doJump(now, 130);
        this._setPlan(P.dx > 0 ? 1 : -1);
        this.planUntil = now + 220;
        this.noteAction('anti-air-jump');
        this.debug.action = 'jump';
        return;
      }
      this._setPlan(Math.abs(P.hDist) < 90 ? awayDir : wantDir);
      this.planUntil = now + 180;
      this.noteAction('vertical-reposition');
      return;
    }

    if (choice === 'vertical-descend') {
      // §30 we are above: aerial, drift down onto them, or fast-fall to land.
      if (Math.random() < 0.5) {
        this.chooseAndFire(now, P.hDist, P.vDist);
        return;
      }
      if (f.vy > 30 && P.oppGrounded && Math.random() < 0.5) {
        this.setHeld('down', true);
        this._setPlan(P.dx > 10 ? 1 : P.dx < -10 ? -1 : 0, false, true);
        this.planUntil = now + 200;
        this.noteAction('fastfall-descend');
        return;
      }
      this._setPlan(P.dx > 10 ? 1 : P.dx < -10 ? -1 : 0);
      this.planUntil = now + 180;
      return;
    }

    if (choice === 'defend') {
      // Threat response: dash-dodge away (§23/26/31), block, or retreat+jump.
      // Imperfect: defense gate keeps mistakes in.
      if (Math.random() < pers.defense + 0.15) {
        if (f.dodgeCooldown <= 0 && Math.random() < 0.55 + pers.defense * 0.25) {
          this.debug.state = 'defense-dash';
          this.doDodge(now, Math.random() < 0.8 ? awayDir : wantDir);
          this.noteAction('defense-dash');
          this.debug.action = 'dodge-defense';
          return;
        }
        if (f.grounded && Math.random() < 0.45) {
          this.debug.state = 'block';
          this.doShield(now, 280 + Math.random() * 200);
          this.noteAction('block');
          this.debug.action = 'block';
          return;
        }
        this.debug.state = 'retreat';
        this._setPlan(awayDir);
        this.planUntil = now + 200;
        if (f.grounded && P.hDist < 90 && Math.random() < 0.4) {
          this.doJump(now, 130);
          this.noteAction('defense-jump');
        }
        return;
      }
      // Failed to react in time — fall through to spacing below.
    }

    if (choice === 'create-distance') {
      // §25 too close: dash away / retreat / jump away, then re-engage.
      this.debug.state = 'create-distance';
      if (f.dodgeCooldown <= 0 && Math.random() < 0.45 + (1 - pers.aggression) * 0.3) {
        this.doDodge(now, awayDir); // §31 defensive dash
        this.noteAction('spacing-dash');
        this.debug.action = 'dodge-spacing';
        return;
      }
      if (f.grounded && P.hDist < 45 && Math.random() < 0.35) {
        this.doJump(now, 125);
        this._setPlan(awayDir);
        this.planUntil = now + 220;
        this.noteAction('spacing-jump');
        return;
      }
      this._setPlan(awayDir);
      this.planUntil = now + 200;
      this.noteAction('spacing-retreat');
      // Re-engage with the right tool once space exists (next decision).
      return;
    }

    if (choice === 'approach') {
      // §25 too far / closing: approach, with offensive dash (§31), jumps,
      // zoning, and edge safety. Dangerous approaches become baits.
      const dangerClose = P.oppAttacking && P.hDist < 260 && Math.random() < pers.defense * 0.55;
      if (dangerClose && Math.random() < 0.45) {
        this._setPlan(0); // bait: hold, then punish the whiff
        this.planUntil = now + 180;
        this.noteAction('approach-bait');
        return;
      }
      if (edgeBlocked) {
        this._setPlan(0);
        this.planUntil = now + 180;
        if (P.vDist < -90 && Math.random() < 0.4) {
          this.doJump(now, 130);
          this.noteAction('approach-jump');
        }
        return;
      }
      // §31 offensive dash: close distance / chase / enter range quickly.
      if (P.hDist > 190 && P.hDist < 430 && f.dodgeCooldown <= 0 && Math.random() < 0.28 + pers.aggression * 0.25) {
        this.doDodge(now, wantDir);
        this._setPlan(wantDir);
        this.planUntil = now + 200;
        this.noteAction('offense-dash');
        this.debug.action = 'dodge-approach';
        return;
      }
      this._setPlan(wantDir);
      this.planUntil = now + 200;
      if (P.dist > 340 && Math.random() < 0.3) {
        if (this.chooseAndFire(now, P.hDist, P.vDist)) return; // zone with projectile
      }
      if (!f.grounded) return; // airborne steering continues
      if ((P.vDist < -90 || P.hDist > 260) && Math.random() < 0.3) {
        this.doJump(now, 130);
        this.noteAction('approach-jump');
        this.debug.action = 'jump';
        return;
      }
      return;
    }

    if (choice === 'attack') {
      // In pocket: strike, or sometimes strafe/jump to make an opening first.
      if (!f.grounded || !opp.grounded) {
        if (f.grounded && P.vDist < -70 && Math.random() < 0.45 + (rates.jumpFreq > 0.04 ? 0.2 : 0)) {
          this.doJump(now, 130);
          this._setPlan(wantDir);
          this.planUntil = now + 220;
          this.noteAction('anti-air-jump');
          this.debug.action = 'jump';
          return;
        }
        if (!f.grounded && f.vy > 40 && P.oppGrounded && P.vDist > 120 && Math.random() < 0.3) {
          this.setHeld('down', true);
          this.noteAction('fastfall-land');
        }
      }
      // §32 deliberate pacing: well-defended opponents get repositioned on,
      // not swung on — creates openings instead of forcing attacks.
      const oppEntrenched = (opp.shielding || opp.dodging) && !P.oppVulnerable && !P.oppWhiff;
      if (oppEntrenched && Math.random() < 0.5) {
        this.strafeDir = -this.strafeDir;
        this._setPlan(this.strafeDir);
        this.planUntil = now + 220;
        this.noteAction('strafe-opening');
        this.moveTicks++;
        return;
      }
      // Pacing now lives inside chooseAndFire (skipped on real openings).
      this.chooseAndFire(now, P.hDist, P.vDist, true);
      return;
    }

    // choice === 'reposition': constant movement even without attacking (§24).
    this.debug.state = 'reposition';
    if (now >= this.strafeUntil) { this.strafeDir = Math.random() < 0.5 ? -1 : 1; this.strafeUntil = now + 500; }
    const rr = Math.random();
    if (rr < 0.5) {
      this._setPlan(this.strafeDir);
      this.planUntil = now + 220;
      this.noteAction('strafe');
    } else if (rr < 0.65 && f.grounded) {
      this.doJump(now, 115);
      this._setPlan(this.strafeDir);
      this.planUntil = now + 220;
      this.noteAction('reposition-hop');
    } else if (rr < 0.75 && f.dodgeCooldown <= 0 && P.hDist > 120) {
      this.doDodge(now, this.strafeDir); // dash reposition (§31)
      this.noteAction('reposition-dash');
    } else {
      this._setPlan(wantDir); // drift toward pocket
      this.planUntil = now + 180;
      this.noteAction('drift-pocket');
    }
    this.moveTicks++;
  }

  // Per-frame update: age presses, run decisions at intervals, then translate
  // plan + reactive recovery steering into the held map.
  update(dt, now, stage) {
    const f = this.fighter;
    if (!f) return;
    const opp = this.opponent;
    if (!opp) {
      this.held = emptyHeld();
      return;
    }
    if (typeof now !== 'number') now = performance.now();
    this._stageHint = stage || null;
    // New tick: invalidate this frame's perception memo. The world is about to
    // be re-read, so nothing computed before this point is still valid.
    beginPerceptionTick();

    // Decay recovery cooldown timer
    if (this._recoveryCooldownTimer > 0) {
      this._recoveryCooldownTimer = Math.max(0, this._recoveryCooldownTimer - dt);
    }

    this.agePresses(now);
    this.trackOpponent(now);

    // §29 post-attack edge: our swing just finished → stamp it so the next
    // decision repositions (follow-up vs safe distance) instead of standing.
    if (this.wasAttacking && !f.attack) {
      this.lastAttackEndedAt = now;
    }
    this.wasAttacking = !!f.attack;

    const pers = this.personality;
    const intervalMs = (pers.reactionTime || 0.16) * 1000;
    // A locked-out fighter (hitstun / mid-attack / dodge / hit-lock) cannot act
    // on any decision, so don't run one and — crucially — don't consume the
    // reaction window. Stamping lastDecision on a 'busy' bail-out meant a long
    // ability that ended while the fighter was plummeting could waste the whole
    // remaining fall before recovery got a turn, killing fighters that still
    // had a double jump and an aerial recovery available. Gating here also
    // keeps the per-decision NN refresh (ensureNeuro) off the frame loop while
    // the fighter is locked out. Recovery now gets its turn the instant the
    // lock clears.
    const lockedOut = f.hitstun > 0 || f.attack || f.dodging || f._hitLock;
    if (!lockedOut && now - this.lastDecision >= intervalMs * (0.75 + Math.random() * 0.5)) {
      try {
        this.makeDecision(now, stage);
      } catch (e) {
        console.error('[ai] decision failed:', e);
      }
      this.lastDecision = now;
    }

    // §41 grounded stage clamp (backstop behind every decision): a grounded
    // plan that would walk off the platform is zeroed before it touches the
    // held map — edgeguard holds the edge, it never crosses it, and chases
    // die at the lip instead of becoming suicides. Airborne drift is owned
    // by recovery/center-steer decisions, never clamped here.
    if (this.plan && f.grounded && recoveryUrgency(f, stage) === 0) {
      try {
        const g = mainGround(stage);
        if (g && this.plan.move !== 0) {
          const lookX = f.x + this.plan.move * 46;
          if (lookX < g.x + 10 || lookX > g.x + g.width - 10) this.plan.move = 0;
        }
      } catch (_) {}
    }

    // Reactive per-frame steering: recovery ALWAYS holds toward the stage
    // (even between decisions) and never fights the plan otherwise.
    const urg = recoveryUrgency(f, stage);
    if (urg > 0) {
      const g = mainGround(stage);
      const targetX = g ? g.x + g.width / 2 : 600;
      const toward = targetX - f.x;
      if (!f.attack && !f.dodging) {
        this.setHeld('left', toward < -8);
        this.setHeld('right', toward > 8);
      } else {
        if (!f.grounded) {
          this.setHeld('left', toward < -8);
          this.setHeld('right', toward > 8);
        }
      }
      this.setHeld('down', false);
    } else if (this.plan && !f.attack && !f.dodging && f.hitstun <= 0) {
      if (this.plan.move > 0) {
        this.setHeld('left', false);
        this.setHeld('right', true);
      } else if (this.plan.move < 0) {
        this.setHeld('left', true);
        this.setHeld('right', false);
      } else {
        const attackHeld = this.held.attack || this.held.special;
        if (!attackHeld) {
          this.setHeld('left', false);
          this.setHeld('right', false);
        }
      }
      // Fast-fall intent from the plan (escape/land) — held only while airborne.
      if (this.plan.holdDown && !f.grounded) this.setHeld('down', true);
      else if (!this.held.attack && !this.held.special) {
        // Don't stick down otherwise (would crouch into fast-fall dives).
        if (!this.plan.holdDown) this.setHeld('down', false);
      }
    } else if (!this.plan && urg === 0 && !f.attack && !f.dodging) {
      const attackHeld = this.held.attack || this.held.special;
      if (!attackHeld && !this.held.shield) {
        this.setHeld('left', false);
        this.setHeld('right', false);
      }
    }
  }

  postFrame() {
    for (const k of BUTTONS) this.prevHeld[k] = this.held[k];
  }

  getInput() {
    // The triple is built once per controller and reused. Game.js asks for it
    // every frame for every AI fighter, and it used to allocate a fresh object
    // plus three closures each time; the closures read `held`/`prevHeld` live, so
    // one persistent triple behaves identically to a fresh one.
    if (!this._inputTriple) {
      const self = this;
      this._inputTriple = {
        isHeld: (pn, action) => {
          if (pn !== self.fighter?.playerNum) return false;
          return !!self.held[action];
        },
        isJustPressed: (pn, action) => {
          if (pn !== self.fighter?.playerNum) return false;
          return !!self.held[action] && !self.prevHeld[action];
        },
        isJustReleased: (pn, action) => {
          if (pn !== self.fighter?.playerNum) return false;
          return !self.held[action] && !!self.prevHeld[action];
        },
      };
    }
    return this._inputTriple;
  }

  getAction() {
    return this.debug.action || 'none';
  }

  getPreviousAction() {
    return this.lastActionKey || 'none';
  }

  reset(fighter, opponent) {
    if (fighter) this.fighter = fighter;
    if (opponent) this.opponent = opponent;
    this.held = emptyHeld();
    this.prevHeld = emptyHeld();
    this.plan = null;
    this.planUntil = 0;
    this.lastDecision = 0;
    this.nextDecisionAt = 0;
    this.releaseAt = {};
    // Live count of pending timed releases, so agePresses (called every frame)
    // can skip its loop entirely when nothing is pending.
    this.releaseCount = 0;
    this.shieldUntil = 0;
    this.lastShieldAt = -1e9;
    this.comboCount = 0;
    this.lastHitOppPercent = -1;
    this.lastOppAttackRef = null;
    this.oppPattern = [];
    this.adapt = {
      samples: 0, attackCounts: {}, rangeSum: 0, rangeN: 0,
      jumps: 0, approaches: 0, retreats: 0, blocks: 0, dodges: 0,
      recoveryDir: { left: 0, right: 0, center: 0 },
      sideHits: { left: 0, right: 0 },
      lastOppY: 0, lastOppX: 0, lastOppGrounded: true,
    };
    this._prevOppTracked = false;
    this.stuckCheck = { x: 0, y: 0, t: 0, count: 0 };
    this.lastActionKey = 'idle';
    this.repeatCount = 0;
    this.strafeDir = 1;
    this.strafeUntil = 0;
    this.lastAttackEndedAt = -1e9;
    this.wasAttacking = false;
    this.abilityUses = {};
    this.moveTicks = 0;
    this.debug = { state: 'init', action: 'none' };
    this.stats = {};
    this._stageHint = null;
    this._lastOppPercent = 0;
    this._nnOut = null;
    this.aimKey = null;
    this.aimUntil = 0;
    this.aimDist = 90;
    this.combatStats = { attacks: 0, hits: 0, _lastOppPct: -1, _lastOwnAttack: null };
    this.diag = { freqBlock: 0, gateBlock: 0, fired: 0, noScore: 0, turnFix: 0 };
    this.recentAttacks = [];
    this.lastZonerAt = -1e9;
    // Recovery cooldown tracking (per character recoveryCooldown)
    this._recoveryCooldownTimer = 0;
    // NOTE: neuroNet / neuroInfluence / mistakeRate intentionally survive
    // reset(): they describe WHO the AI is (genome/difficulty), not the match.
  }

  dispose() {
    this.fighter = null;
    this.opponent = null;
    this.held = emptyHeld();
    this.prevHeld = emptyHeld();
    this.plan = null;
    this.releaseAt = {};
    this.releaseCount = 0;
    this._stageHint = null;
  }
}

class AIController {
  constructor(fighter, opponent, personality, options) {
    // AIvsAI independence: when no explicit personality is given, jitter the
    // defaults per-controller so the two fighters naturally diverge (one may
    // press, the other may space) instead of mirroring each other.
    // Baselines tuned for fast action-heavy 20–50s pacing: high pressure +
    // frequent edgeguards/combos, moderate defense (hits land, KOs come).
    //
    // options: { difficulty, charId, neuroWeights, neuroInfluence,
    //            mistakeRate, genome, genomeInfluence }. `difficulty` loads the
    // real difficulty pipeline (personality + trained model when present).
    // `genome` (training) overrides everything: evolved behavior + network.
    let p = personality;
    if (!p) {
      p = {
        aggression: 0.6 + Math.random() * 0.3,
        defense: 0.35 + Math.random() * 0.3,
        reactionTime: 0.13 + Math.random() * 0.05,
        attackFrequency: 0.6 + Math.random() * 0.2,
        preferredRange: 100 + Math.random() * 35,
        minimumSafeDistance: 50 + Math.random() * 20,
        maximumEngagementDistance: 240 + Math.random() * 50,
        riskTolerance: 0.4 + Math.random() * 0.35,
        recoveryPriority: 0.9 + Math.random() * 0.1,
        edgeguardPriority: 0.6 + Math.random() * 0.3,
        comboPriority: 0.65 + Math.random() * 0.25,
      };
    }
    this.fighter = fighter;
    this.opponent = opponent;
    this.state = new AIState(fighter, opponent, p);
    this.difficulty = null;
    try {
      const opts = options || {};
      if (opts.difficulty) this.applyDifficulty(opts.difficulty, opts.charId);
      if (opts.genome) {
        this.state.setGenome(opts.genome, opts.genomeInfluence != null ? opts.genomeInfluence : 1.0);
        if (typeof opts.mistakeRate === 'number') this.state.mistakeRate = opts.mistakeRate;
      } else {
        if (Array.isArray(opts.neuroWeights)) {
          this.state.setNeuralModel(opts.neuroWeights, opts.neuroInfluence != null ? opts.neuroInfluence : 0.85);
        } else if (typeof opts.neuroInfluence === 'number') {
          this.state.neuroInfluence = Math.max(0, Math.min(1, opts.neuroInfluence));
        }
        if (typeof opts.mistakeRate === 'number') this.state.mistakeRate = opts.mistakeRate;
      }
    } catch (_) {}
  }

  applyDifficulty(name, charId) {
    this.difficulty = AI_DIFFICULTIES.includes(name) ? name : 'Normal';
    try {
      const cfg = configForDifficulty(this.difficulty, charId);
      this.state.personality = resolvePersonality({ ...this.state.personality, ...cfg.personality });
      this.state.mistakeRate = cfg.mistakeRate || 0;
      if (cfg.neuroWeights) this.state.setNeuralModel(cfg.neuroWeights, cfg.neuroInfluence);
      else this.state.neuroInfluence = cfg.neuroInfluence || 0;
    } catch (_) {}
  }

  setGenome(genome, influence) {
    try { this.state.setGenome(genome, influence != null ? influence : 1.0); } catch (_) {}
  }

  update(dtOrNow, nowOrStage, maybeStage) {
    let now;
    let stage = null;
    if (typeof dtOrNow === 'number' && typeof nowOrStage === 'number') {
      now = nowOrStage;
      stage = maybeStage || null;
    } else if (typeof dtOrNow === 'number') {
      now = dtOrNow;
      stage = nowOrStage || null;
    } else {
      now = performance.now();
    }
    this.state.update(0, now, stage);
  }

  postFrame() {
    this.state.postFrame();
  }

  getInput() {
    return this.state.getInput();
  }

  getAction() {
    return this.state.getAction();
  }

  getPreviousAction() {
    return this.state.getPreviousAction();
  }

  getDebug() {
    const cs = this.state.combatStats || { attacks: 0, hits: 0 };
    const acc = cs.attacks > 0 ? cs.hits / cs.attacks : 0;
    return {
      ...this.state.debug,
      // `hold` is a live view of this.state.held, not a stored string: building
      // the 9-conditional button glyph on every AI frame cost a string concat per
      // controller per frame, and the only reader is this probe-facing getter.
      hold: holdString(this.state.held),
      fighter: this.fighter?.playerNum ?? null,
      stats: { ...this.state.stats },
      combat: { attacks: cs.attacks, hits: cs.hits, acc: Math.round(acc * 1000) / 1000 },
      diag: { ...(this.state.diag || {}) },
    };
  }

  // Observability for tests/tuning: current scored attack list with
  // connect chance + kind, from live state. Never affects decisions.
  // `limit` defaults to the historical top-6; tests may ask for the full list.
  debugScores(limit = 6) {
    try {
      const st = this.state;
      if (!st || !st.fighter || !st.opponent) return [];
      const P = buildPerception(st.fighter, st.opponent, st._stageHint);
      const n = Number.isFinite(limit) && limit > 0 ? limit : 6;
      return st.scoreAttacks(P).slice(0, n).map((e) => ({
        key: e.key, kind: e.kind,
        score: Math.round(e.score * 1000) / 1000,
        connect: Math.round((e.connect || 0) * 1000) / 1000,
      }));
    } catch (_) {
      return [];
    }
  }

  reset() {
    this.state.reset(this.fighter, this.opponent);
  }

  dispose() {
    this.state.dispose();
  }
}

export { AIController, AI_PARAMS, AI_DIFFICULTIES, configForDifficulty, difficultyPreset };
// Pure estimators exported for deterministic unit tests (no game state).
export { attackReach, predictOppCenter, connectChance, facingOppNow, effDefFor };


// ── merged from ai/ai-training.js ──
// ai-training.js â€” headless evolutionary training harness.
// v3: trains against the unified Smash pipeline (J=light/tilt, K=smash,
// weight 70-130, central KB/hitstun/hitlag). Fitness rewards KOs + damage,
// so weight-dependent launch outcomes shape selection automatically.
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


const SIM_DT = 1 / 60;
const TRAIN_STOCKS = 1;          // 1-stock bouts keep generations fast
const MAX_SECONDS_PER_MATCH = 30;
const MAX_FRAMES = MAX_SECONDS_PER_MATCH * 60;

// Main-thread budget: sim frames run in bursts no longer than this, then the
// chunk yields to the event loop (setTimeout 0) before spending the rest of
// its framesPerChunk quota. A Fastest chunk (3000 sim frames) used to run as
// ONE synchronous burst — a multi-second total freeze of update()+render().
// 8ms keeps every yield under roughly half a 60Hz frame of perceived cost
// (setTimeout 0 lands on the next macrotask, so the visible frame stretches
// by about the burst length); headless throughput stays 3-5x real time.
const CHUNK_BUDGET_MS = 8;

function emptyStats() {
  return {
    win: 0, stocksTaken: 0, stocksLost: 0,
    damageDealt: 0, damageTaken: 0, hitsLanded: 0,
    combos: 0, blocks: 0, dodges: 0, punishes: 0,
    recoveries: 0, recoveryAttempts: 0, edgeguards: 0, whiffs: 0,
    wastedRecoveries: 0, idleFrames: 0, offStageFrames: 0,
    failedActions: 0, centerTime: 0, aliveFrames: 0,
    attacksStarted: 0, attacksHit: 0,
    moveUses: {}, moveHits: {},
  };
}

// Passive input triple for dummy opponents: never presses anything, but stays
// in the sim (takes hits, falls, respawns) so aggression can be measured.
const DUMMY_TRIPLE = {
  isHeld: () => false,
  isJustPressed: () => false,
  isJustReleased: () => false,
};


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
  try { f.accessory = loadAccessoryFor(def.id, def.accessory); } catch (_) { f.accessory = null; }
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
export function createHeadlessMatch(defA, defB, genomeA, genomeB, opts = {}) {
  const stage = createDefaultStage(1080, 1080);
  const f1 = makeHeadlessFighter(1, defA);
  const f2 = makeHeadlessFighter(2, defB);
  placeAtSpawns(f1, f2, stage);
  resetCombat();
  resetTimeDilation();
  resetDamageIndicators();

  // Opponent spec (backward compatible): genomeB may be a raw genome, or
  // opts.oppB selects { kind: 'genome' | 'scripted' | 'dummy' }.
  const opp = opts.oppB
    || (genomeB && typeof genomeB === 'object' && !Array.isArray(genomeB.weights) && genomeB.kind
      ? genomeB
      : { kind: 'genome', genome: genomeB || null });
  const c1 = new AIController(f1, f2, null, { genome: genomeA, genomeInfluence: 1.0, mistakeRate: 0 });
  let c2 = null;
  if (opp.kind === 'dummy') {
    c2 = null; // passive triple below: takes hits, never acts
  } else if (opp.kind === 'scripted') {
    c2 = new AIController(f2, f1, null, {
      difficulty: opp.difficulty || 'Normal',
      charId: opp.charId || (defB && defB.id),
      mistakeRate: 0,
    });
  } else {
    c2 = new AIController(f2, f1, null, { genome: opp.genome || null, genomeInfluence: 1.0, mistakeRate: 0 });
  }

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
    if (c2) { try { c2.update(0, simNow, stage); } catch (_) {} }

    const input1 = c1.getInput();
    const input2 = c2 ? c2.getInput() : DUMMY_TRIPLE;
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
      // Attack lifecycle + per-move usage (variety scoring needs real counts).
      const atkActive = !!me.attack;
      if (atkActive && !t.wasAttack) {
        stats.attacksStarted++;
        t.curHit = false;
        t.lastHit = false;
        t.curKey = (me.attack && me.attack.key) || 'unknown';
        stats.moveUses[t.curKey] = (stats.moveUses[t.curKey] || 0) + 1;
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
      // Resource tracking (DJ / Aerial-Light consumption). Off-stage uses
      // count as recovery attempts for efficiency scoring.
      const usedDJ = t.wasDJ && !me.canDoubleJump && !me.grounded;
      const usedAL = t.wasAL && !me.canUseAerialLightRecovery && !me.grounded;
      if (usedDJ) {
        t.djUseFrame = frame; t.landedSinceUse = false;
      }
      if (usedAL) {
        t.alUseFrame = frame; t.landedSinceUse = false;
      }
      t.usedRecoveryThisFrame = usedDJ || usedAL;
      t.wasDJ = !!me.canDoubleJump;
      t.wasAL = !!me.canUseAerialLightRecovery;
      if (me.grounded) t.landedSinceUse = true;
      // Recovery: was off-stage, now back on solid ground alive.
      const isOff = offStage(me, stage);
      if (t.wasOff && !isOff && me.grounded) stats.recoveries++;
      if (t.usedRecoveryThisFrame && isOff) stats.recoveryAttempts++;
      t.usedRecoveryThisFrame = false;
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
      else if (frame - t.lastEndFrame < 30 && !t.lastHit) { t.lastHit = true; s1.attacksHit++; }
      s1.hitsLanded++;
      const hk = t.curKey || 'unknown';
      s1.moveHits[hk] = (s1.moveHits[hk] || 0) + 1;
      if (f2.hitstun > 0) s1.combos++;
      if (offStage(f2, stage)) s1.edgeguards++;
    }
    if (d1 > 0.01) {
      s2.damageDealt += d1; s1.damageTaken += d1;
      const t = T[2];
      if (f2.attack) t.curHit = true;
      else if (frame - t.lastEndFrame < 30 && !t.lastHit) { t.lastHit = true; s2.attacksHit++; }
      s2.hitsLanded++;
      const hk = t.curKey || 'unknown';
      s2.moveHits[hk] = (s2.moveHits[hk] || 0) + 1;
      if (f1.hitstun > 0) s2.combos++;
      if (offStage(f1, stage)) s2.edgeguards++;
    }
    T[1].prevPercent = f1.percent;
    T[2].prevPercent = f2.percent;

    try { c1.postFrame(); } catch (_) {}
    if (c2) { try { c2.postFrame(); } catch (_) {} }

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
    // step(n[, budgetMs]): advance at most n sim frames. With budgetMs given,
    // the loop is TIME-capped as well — the caller resumes via setTimeout to
    // keep the main thread responsive (see createTrainer's chunk loop).
    // Returns the number of frames actually consumed (may be < n when the
    // budget or the end of the match cuts the burst short).
    step(n, budgetMs) {
      let i = 0;
      if (budgetMs != null && budgetMs > 0) {
        const hasPerf = typeof performance !== 'undefined' && performance.now;
        const deadline = (hasPerf ? performance.now() : Date.now()) + budgetMs;
        while (!finished && i < n && (hasPerf ? performance.now() : Date.now()) < deadline) {
          stepFrame(); i++;
        }
      } else {
        while (!finished && i < n) { stepFrame(); i++; }
      }
      return i;
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
      if (c2) { try { c2.dispose(); } catch (_) {} }
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
    // Training mode: 'matchup' (both pools co-evolve) | 'character' (only A
    // evolves vs a fixed B) | 'general' (A evolves vs rotating opponents).
    mode: ['matchup', 'character', 'general'].includes(opts.mode) ? opts.mode : 'matchup',
    // Opponent for fixed-opponent modes / B side: 'coevolve' | 'trained' |
    // 'scripted' | 'dummy'.
    oppType: ['coevolve', 'trained', 'scripted', 'dummy'].includes(opts.oppType) ? opts.oppType : 'coevolve',
    scriptedDifficulty: typeof opts.scriptedDifficulty === 'string' ? opts.scriptedDifficulty : 'Normal',
    // Start mode: 'new' (random populations) | 'continue' (seed from the
    // active model or checkpoint, then keep evolving).
    startMode: opts.startMode === 'continue' ? 'continue' : 'new',
    onProgress: typeof opts.onProgress === 'function' ? opts.onProgress : null,
    onLive: typeof opts.onLive === 'function' ? opts.onLive : null,
  };
  // Fixed-opponent modes only ever evolve pool A; matchup+coevolve evolves both.
  const evolvesB = cfg.mode === 'matchup' && cfg.oppType === 'coevolve';

  const state = {
    running: false,
    stopped: false,
    paused: false,
    liveMatch: null,
    generation: 0,
    startGen: 0,
    popA: [],
    popB: [],
    bestA: null,
    bestB: null,
    history: [],
    matchesPlayed: 0,
    winsA: 0,
    winsB: 0,
    timer: null,
    lastResult: null,
    startedAt: 0,
    warnings: [],
    _resume: null,
    _chunkFramesDone: 0, // sim frames already consumed of the current chunk's quota
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
    const stB = evolvesB ? populationStats(state.popB) : { best: 0, avg: 0, worst: 0, bestWins: 0 };
    return {
      running: state.running,
      paused: state.paused,
      phase: !state.running ? 'idle' : state.paused ? 'paused' : 'training',
      generation: state.generation,
      maxGenerations: cfg.maxGenerations,
      populationSize: cfg.populationSize,
      charA: cfg.charA,
      charB: cfg.charB,
      mode: cfg.mode,
      oppType: cfg.oppType,
      best: Math.max(stA.best, stB.best),
      avg: (stA.avg + (evolvesB ? stB.avg : stA.avg)) / 2,
      bestWins: Math.max(stA.bestWins, stB.bestWins),
      bestA: stA.best, bestB: stB.best,
      avgA: stA.avg, avgB: stB.avg,
      diversityA: diversityOf(state.popA),
      diversityB: evolvesB ? diversityOf(state.popB) : 0,
      matchesPlayed: state.matchesPlayed,
      winsA: state.winsA,
      winsB: state.winsB,
      lastResult: state.lastResult,
      history: state.history.slice(-50),
      warnings: state.warnings.slice(-5),
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

  function noteWarning(msg) {
    if (!msg || state.warnings.includes(msg)) return;
    state.warnings.push(msg);
  }

  // Fixed opponent for pair index i (general mode rotates difficulties for
  // varied training scenarios; other modes use the configured opponent).
  function fixedOppFor(i) {
    if (cfg.oppType === 'dummy') return { kind: 'dummy' };
    if (cfg.oppType === 'scripted') {
      if (cfg.mode === 'general') {
        const diffs = ['Easy', 'Normal', 'Hard'];
        return { kind: 'scripted', difficulty: diffs[i % diffs.length], charId: cfg.charB };
      }
      return { kind: 'scripted', difficulty: cfg.scriptedDifficulty, charId: cfg.charB };
    }
    if (cfg.oppType === 'trained') {
      const m = getActiveModel(cfg.charB);
      if (m && Array.isArray(m.weights)) {
        return { kind: 'genome', genome: { weights: m.weights, behavior: m.behavior } };
      }
      noteWarning(`no trained ${cfg.charB} model; fell back to scripted Normal`);
      return { kind: 'scripted', difficulty: 'Normal', charId: cfg.charB };
    }
    return null;
  }

  // Seed a population around a champion genome (continue mode): first slot is
  // the champion itself, the rest are mutated explorations of it.
  function seedFromChampion(champ, size) {
    const pop = [cloneGenome(champ)];
    pop[0].fitness = 0; pop[0].wins = 0; pop[0].matches = 0;
    while (pop.length < size) {
      const child = cloneGenome(champ);
      mutateGenome(child, Math.max(cfg.mutationRate, 0.12), cfg.mutationStrength * 1.5, 0.05);
      child.fitness = 0; child.wins = 0; child.matches = 0;
      pop.push(child);
    }
    return pop;
  }

  function championFor(charId) {
    try {
      const cp = loadCheckpoint(charId);
      if (cp) return { ...cp, fromCheckpoint: true };
      const m = getActiveModel(charId);
      if (m) return { weights: m.weights, behavior: m.behavior, fitness: m.fitness, generation: m.generation, fromCheckpoint: false };
    } catch (_) {}
    return null;
  }

  // Run one generation (all pairs) across many chunks. Pausing takes effect
  // at the next chunk boundary: the in-flight bout is kept, nothing is lost.
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
      if (state.stopped) { state._resume = null; finishStopped(); return; }
      if (state.paused) { state._resume = nextChunk; return; }
      if (pairIdx >= n) {
        if (match) { try { match.dispose(); } catch (_) {} match = null; }
        state.liveMatch = null;
        state._resume = null;
        done();
        return;
      }
      if (!match) {
        const gA = state.popA[pairIdx];
        const oppB = evolvesB
          ? { kind: 'genome', genome: state.popB[order[pairIdx]] }
          : fixedOppFor(pairIdx);
        state._chunkFramesDone = 0;
        try {
          match = createHeadlessMatch(cfg.defA, cfg.defB, gA, null, { oppB });
          state.liveMatch = match;
        } catch (e) {
          // A broken pairing must never kill training: score both zero.
          gA.fitness = -1000;
          if (evolvesB) state.popB[order[pairIdx]].fitness = -1000;
          pairIdx++;
          state.timer = setTimeout(nextChunk, 0);
          return;
        }
      }
      let mDone = false;
      try {
        // Budgeted burst: run a few ms of sim, then yield. The chunk loop
        // re-enters via setTimeout until the full framesPerChunk quota is
        // consumed — identical total throughput, but no burst ever freezes
        // update()+render() the way the old single-shot 1200/3000-frame step
        // did.
        const remaining = cfg.framesPerChunk - state._chunkFramesDone;
        const consumed = match.step(remaining, CHUNK_BUDGET_MS);
        state._chunkFramesDone += consumed;
        if (consumed >= remaining) state._chunkFramesDone = 0;
        mDone = mDone || match.done();
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
          gA.stats = r.stats1;
          gA.fitness = computeFitness(r.stats1);
          gA.matches = (gA.matches || 0) + 1;
          if (r.winner === 1) { gA.wins = (gA.wins || 0) + 1; state.winsA++; }
          if (r.winner === 2) state.winsB++;
          if (evolvesB) {
            const gB = state.popB[order[pairIdx]];
            gB.stats = r.stats2;
            gB.fitness = computeFitness(r.stats2);
            gB.matches = (gB.matches || 0) + 1;
            if (r.winner === 2) gB.wins = (gB.wins || 0) + 1;
          }
          state.matchesPlayed++;
          state.lastResult = {
            gen: state.generation + 1,
            match: pairIdx + 1,
            winner: r.winner,
            frames: r.frames,
            fitA: Math.round(gA.fitness),
            fitB: evolvesB ? Math.round(state.popB[order[pairIdx]].fitness) : null,
          };
        } catch (_) {}
        try { match.dispose(); } catch (_) {}
        match = null;
        state.liveMatch = null;
        pairIdx++;
        emit();
      }
      state._resume = nextChunk;
      state.timer = setTimeout(nextChunk, 0);
    }
    nextChunk();
  }

  function evolveAndContinue() {
    if (state.stopped) { finishStopped(); return; }
    // Record + preserve bests (B only co-evolves in matchup mode).
    const bA = bestOf(state.popA);
    const bB = evolvesB ? bestOf(state.popB) : null;
    if (bA && (!state.bestA || (bA.fitness || 0) > (state.bestA.fitness || 0))) {
      state.bestA = cloneGenome(bA);
      state.bestA.fitness = bA.fitness; state.bestA.wins = bA.wins; state.bestA.stats = bA.stats;
    }
    if (bB && (!state.bestB || (bB.fitness || 0) > (state.bestB.fitness || 0))) {
      state.bestB = cloneGenome(bB);
      state.bestB.fitness = bB.fitness; state.bestB.wins = bB.wins; state.bestB.stats = bB.stats;
    }
    const stA = populationStats(state.popA);
    const stB = evolvesB ? populationStats(state.popB) : stA;
    state.history.push({
      gen: state.generation + 1,
      best: Math.max(stA.best, stB.best),
      avg: (stA.avg + stB.avg) / 2,
    });
    state.generation++;
    // Per-generation checkpoint so an interrupted run can resume near its best.
    try {
      if (state.bestA) {
        saveCheckpoint(cfg.charA, {
          weights: state.bestA.weights, behavior: state.bestA.behavior,
          fitness: state.bestA.fitness, generation: state.generation,
          opponent: cfg.charB, mode: cfg.mode,
          config: { populationSize: cfg.populationSize, mutationRate: cfg.mutationRate },
        });
      }
      if (evolvesB && state.bestB && cfg.charB !== cfg.charA) {
        saveCheckpoint(cfg.charB, {
          weights: state.bestB.weights, behavior: state.bestB.behavior,
          fitness: state.bestB.fitness, generation: state.generation,
          opponent: cfg.charA, mode: cfg.mode,
          config: { populationSize: cfg.populationSize, mutationRate: cfg.mutationRate },
        });
      }
    } catch (_) {}
    emit();
    if (state.generation >= cfg.maxGenerations) {
      finishDone();
      return;
    }
    // Breed next generation (B only when it co-evolves).
    try {
      state.popA = nextGeneration(state.popA, {
        eliteRate: cfg.eliteRate,
        tournamentSize: cfg.tournamentSize,
        mutationRate: cfg.mutationRate,
        mutationStrength: cfg.mutationStrength,
      });
      if (evolvesB) {
        state.popB = nextGeneration(state.popB, {
          eliteRate: cfg.eliteRate,
          tournamentSize: cfg.tournamentSize,
          mutationRate: cfg.mutationRate,
          mutationStrength: cfg.mutationStrength,
        });
      }
    } catch (e) {
      finishStopped();
      return;
    }
    runGeneration(evolveAndContinue);
  }

  function baseConfigSnapshot() {
    return {
      populationSize: cfg.populationSize,
      maxGenerations: cfg.maxGenerations,
      mutationRate: cfg.mutationRate,
      mutationStrength: cfg.mutationStrength,
      eliteRate: cfg.eliteRate,
      tournamentSize: cfg.tournamentSize,
      mode: cfg.mode,
      oppType: cfg.oppType,
      scriptedDifficulty: cfg.scriptedDifficulty,
      startMode: cfg.startMode,
    };
  }

  function saveBests() {
    const out = { savedA: { ok: false }, savedB: { ok: false }, runId: null };
    try {
      const stamp = new Date().toISOString().slice(0, 10);
      let bA = state.bestA || bestOf(state.popA);
      let bB = evolvesB ? (state.bestB || bestOf(state.popB)) : null;
      // Same-character training: both pools share one model key - keep the
      // better genome instead of letting the second pool overwrite the first.
      if (cfg.charA === cfg.charB && bA && bB) {
        if ((bB.fitness || 0) > (bA.fitness || 0)) bA = bB;
        bB = null;
      }
      const nameA = `${cfg.charA} G${state.generation} ${stamp}`;
      if (bA) {
        const res = saveModelVersion(cfg.charA, {
          weights: bA.weights,
          behavior: bA.behavior,
          fitness: bA.fitness,
          wins: bA.wins,
          matches: bA.matches,
          generation: state.generation,
          opponent: cfg.charB,
          mode: cfg.mode,
          config: baseConfigSnapshot(),
        }, { name: nameA, activate: true });
        out.savedA = res;
        // Legacy v1 mirror so older readers keep working.
        try {
          saveTrainedModel(cfg.charA, {
            weights: bA.weights, behavior: bA.behavior, fitness: bA.fitness,
            wins: bA.wins, generation: state.generation, opponent: cfg.charB,
            config: baseConfigSnapshot(),
          });
        } catch (_) {}
      }
      if (bB && cfg.charB !== cfg.charA) {
        const res = saveModelVersion(cfg.charB, {
          weights: bB.weights,
          behavior: bB.behavior,
          fitness: bB.fitness,
          wins: bB.wins,
          matches: bB.matches,
          generation: state.generation,
          opponent: cfg.charA,
          mode: cfg.mode,
          config: baseConfigSnapshot(),
        }, { name: `${cfg.charB} G${state.generation} ${stamp}`, activate: true });
        out.savedB = res;
        try {
          saveTrainedModel(cfg.charB, {
            weights: bB.weights, behavior: bB.behavior, fitness: bB.fitness,
            wins: bB.wins, generation: state.generation, opponent: cfg.charA,
            config: baseConfigSnapshot(),
          });
        } catch (_) {}
      }
      // Permanent run record (history view + outcome review source of truth).
      try {
        const stA = populationStats(state.popA);
        const rec = saveRunRecord({
          startedAt: state.startedAt ? new Date(state.startedAt).toISOString() : new Date().toISOString(),
          charA: cfg.charA,
          charB: cfg.charB,
          mode: cfg.mode,
          oppType: evolvesB ? 'coevolve' : cfg.oppType,
          opponent: cfg.charB,
          config: baseConfigSnapshot(),
          generations: state.generation,
          matches: state.matchesPlayed,
          bestFitness: Math.max(stA.best, 0),
          avgFitness: stA.avg || 0,
          winsA: state.winsA,
          winsB: state.winsB,
          savedModelIds: [out.savedA && out.savedA.id, out.savedB && out.savedB.id].filter(Boolean),
          status: state.stopped ? 'stopped' : 'done',
          warnings: state.warnings.slice(),
          fitnessCurve: state.history.map((h) => h.best),
        });
        out.runId = rec.ok ? rec.id : null;
      } catch (_) {}
    } catch (_) {}
    return out;
  }

  function cleanup() {
    if (state.timer) { clearTimeout(state.timer); state.timer = null; }
    state.liveMatch = null;
    state.running = false;
    state.paused = false;
    state._resume = null;
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
      state.paused = false;
      state._resume = null;
      state.matchesPlayed = 0;
      state.winsA = 0;
      state.winsB = 0;
      state.history = [];
      state.bestA = null;
      state.bestB = null;
      state.warnings = [];
      state.startedAt = Date.now();
      state.generation = 0;
      state.startGen = 0;
      try {
        if (cfg.startMode === 'continue') {
          const champA = championFor(cfg.charA);
          if (champA) {
            state.popA = seedFromChampion(champA, cfg.populationSize);
            state.generation = Math.max(0, champA.generation | 0);
            state.startGen = state.generation;
            state.bestA = cloneGenome(champA);
            state.bestA.fitness = champA.fitness || 0;
            noteWarning(`continued ${cfg.charA} from ${champA.fromCheckpoint ? 'checkpoint' : 'saved model'} G${state.generation}`);
          } else {
            noteWarning(`no saved ${cfg.charA} model/checkpoint; started fresh`);
            state.popA = initPopulation(cfg.populationSize);
          }
          if (evolvesB) {
            const champB = championFor(cfg.charB);
            if (champB) {
              state.popB = seedFromChampion(champB, cfg.populationSize);
              state.bestB = cloneGenome(champB);
              state.bestB.fitness = champB.fitness || 0;
            } else {
              state.popB = initPopulation(cfg.populationSize);
            }
          } else {
            state.popB = [];
          }
          if (state.generation >= cfg.maxGenerations) {
            cfg.maxGenerations = state.generation + 5;
            noteWarning(`extended target to G${cfg.maxGenerations} (checkpoint already at G${state.generation})`);
          }
        } else {
          state.popA = initPopulation(cfg.populationSize);
          state.popB = evolvesB ? initPopulation(cfg.populationSize) : [];
        }
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
      state.paused = false;
      state._resume = null;
      if (state.timer) { clearTimeout(state.timer); state.timer = null; }
      // Finish synchronously so UI state is consistent immediately.
      finishStopped();
      return true;
    },
    pause() {
      if (!state.running || state.stopped || state.paused) return false;
      state.paused = true;
      if (state.timer) { clearTimeout(state.timer); state.timer = null; }
      // Checkpoint the current bests so a paused-then-closed session resumes.
      try {
        if (state.bestA) {
          saveCheckpoint(cfg.charA, {
            weights: state.bestA.weights, behavior: state.bestA.behavior,
            fitness: state.bestA.fitness, generation: state.generation,
            opponent: cfg.charB, mode: cfg.mode,
            config: { populationSize: cfg.populationSize, mutationRate: cfg.mutationRate },
          });
        }
      } catch (_) {}
      emit();
      return true;
    },
    resume() {
      if (!state.running || state.stopped || !state.paused) return false;
      state.paused = false;
      const cont = state._resume;
      state._resume = null;
      if (typeof cont === 'function') {
        state.timer = setTimeout(cont, 0);
        emit();
        return true;
      }
      return false;
    },
    isRunning() { return state.running; },
    isPaused() { return state.paused; },
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

// ── Evaluation ──────────────────────────────────────────────────────────────
// Run a model's genome through real headless matches against a fixed opponent
// (scripted AI, dummy, or another trained genome) and aggregate ACTUAL match
// outcomes. Synchronous and bounded (matches capped) so the UI can run it
// directly; every number in the report comes from played bouts.
// opts: { defA, defB, genomeA, oppB?, matches?, onMatch? }
export function evaluateModels(opts = {}) {
  const defA = opts.defA, defB = opts.defB;
  if (!defA || !defB) return { ok: false, error: 'missing fighter defs' };
  const matches = Math.max(1, Math.min(20, opts.matches | 0 || 6));
  const oppB = opts.oppB || { kind: 'scripted', difficulty: opts.difficulty || 'Normal', charId: defB.id };
  const report = {
    ok: true,
    matches: 0,
    wins: 0,
    losses: 0,
    draws: 0,
    winRate: 0,
    avgDealt: 0,
    avgTaken: 0,
    avgDuration: 0,
    recoveries: 0,
    recoveryAttempts: 0,
    recRate: 0,
    falls: 0,
    hitRate: 0,
    moveUses: {},
    moveHits: {},
    perMatch: [],
  };
  let dealt = 0, taken = 0, dur = 0, started = 0, hit = 0;
  for (let i = 0; i < matches; i++) {
    let m = null;
    try {
      m = createHeadlessMatch(defA, defB, opts.genomeA || null, null, { oppB });
      let guard = 0;
      while (!m.done() && guard++ < 2400) m.step(600);
      const r = m.result();
      const s1 = r.stats1 || {};
      report.matches++;
      if (r.winner === 1) report.wins++;
      else if (r.winner === 2) report.losses++;
      else report.draws++;
      dealt += s1.damageDealt || 0;
      taken += s1.damageTaken || 0;
      dur += r.frames || 0;
      report.recoveries += s1.recoveries || 0;
      report.recoveryAttempts += s1.recoveryAttempts || 0;
      report.falls += s1.stocksLost || 0;
      started += s1.attacksStarted || 0;
      hit += s1.attacksHit || 0;
      for (const k of Object.keys(s1.moveUses || {})) {
        report.moveUses[k] = (report.moveUses[k] || 0) + s1.moveUses[k];
      }
      for (const k of Object.keys(s1.moveHits || {})) {
        report.moveHits[k] = (report.moveHits[k] || 0) + s1.moveHits[k];
      }
      report.perMatch.push({
        winner: r.winner,
        frames: r.frames,
        dealt: Math.round((s1.damageDealt || 0) * 10) / 10,
        taken: Math.round((s1.damageTaken || 0) * 10) / 10,
      });
      if (opts.onMatch) {
        try { opts.onMatch(i + 1, matches, report); } catch (_) {}
      }
    } catch (_) {
      // A broken bout counts as a no-result match, never a crash.
    } finally {
      if (m) { try { m.dispose(); } catch (_) {} }
    }
  }
  if (report.matches > 0) {
    report.winRate = report.wins / report.matches;
    report.avgDealt = dealt / report.matches;
    report.avgTaken = taken / report.matches;
    report.avgDuration = dur / report.matches;
    report.recRate = report.recoveryAttempts > 0 ? report.recoveries / report.recoveryAttempts : 0;
    report.hitRate = started > 0 ? hit / started : 0;
  }
  return report;
}
