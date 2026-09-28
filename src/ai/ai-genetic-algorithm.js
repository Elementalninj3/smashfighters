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

import { NeuralNetwork } from './ai-neural-network.js';

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

// ── Fitness ───────────────────────────────────────────────────────────────
// Weighted multi-factor fitness. No single metric dominates: winning matters
// most but damage, aggression quality, defense, positioning and efficiency all
// contribute, while passivity, recklessness and whiffing are penalized.
//
// `s` is the per-match stat bundle recorded by the headless harness (see
// ai-training.js runHeadlessMatch). All fields are plain numbers.
export function computeFitness(s) {
  if (!s || typeof s !== 'object') return 0;
  const n = (v) => (Number.isFinite(v) ? v : 0);
  let f = 0;
  // Positive: winning, damage, clean KOs, successful offense/defense.
  f += 500 * n(s.win);
  f += 120 * n(s.stocksTaken);
  f += 3.0 * n(s.damageDealt);
  f += 10 * n(s.hitsLanded);
  f += 6 * n(s.combos);
  f += 4 * n(s.blocks);
  f += 4 * n(s.dodges);
  f += 8 * n(s.punishes);
  f += 15 * n(s.recoveries);
  f += 12 * n(s.edgeguards);
  f += 0.4 * Math.min(1500, n(s.centerTime));   // useful positioning
  f += 0.15 * Math.min(2000, n(s.aliveFrames)); // survival (capped)
  // Negative: taking damage, dying, waste, passivity, recklessness.
  f -= 2.0 * n(s.damageTaken);
  f -= 150 * n(s.stocksLost);
  f -= 5 * n(s.whiffs);                 // swinging at air
  f -= 3 * n(s.wastedRecoveries);       // burning DJ/AL off-stage pointlessly
  f -= 0.25 * Math.min(3000, n(s.idleFrames)); // standing still
  f -= 0.3 * Math.min(2000, n(s.offStageFrames)); // reckless edge time (capped)
  f -= 2 * n(s.failedActions);          // pressing locked buttons
  if (!Number.isFinite(f)) return 0;
  return f;
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
