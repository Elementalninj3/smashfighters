// t4-training.mjs — (D) AI training algorithm: 10 targeted checks.
// Covers init, mini-runs, elitism, mutation, crossover, pause/resume,
// stop-saves, continue-seeding, selection pressure, clone isolation.
// Run: node tests/node/t4-training.mjs
import './_env.mjs';
import { createTrainer, evaluateModels } from '../../src/ai.js';
import {
  initPopulation, nextGeneration, tournamentSelect, crossoverGenomes,
  mutateGenome, cloneGenome, computeFitness, bestOf,
} from '../../src/ai.js';
import { NeuralNetwork, NN_WEIGHT_COUNT } from '../../src/ai.js';
import { getActiveModel, listRunHistory } from '../../src/ai.js';
import { ALL_FIGHTERS } from '../../src/combat.js';

let passes = 0, failures = 0;
function ok(cond, msg) {
  if (cond) { passes++; console.log('  PASS  ' + msg); }
  else { failures++; console.log('  FAIL  ' + msg); }
}
const defA = ALL_FIGHTERS[0], defB = ALL_FIGHTERS[1];
const runTrainer = (opts) => new Promise((res) => {
  const tr = createTrainer({ ...opts, onDone: (info) => res({ tr, info }) });
  tr.start();
});

// 1. population init: size, valid weights, behavior ranges.
{
  const pop = initPopulation(8);
  const wOk = pop.every((g) => Array.isArray(g.weights) && g.weights.length === NN_WEIGHT_COUNT && g.weights.every(Number.isFinite));
  const bOk = pop.every((g) => g.behavior.aggression >= 0.2 && g.behavior.aggression <= 1.0 && g.behavior.reactionTime >= 0.10 && g.behavior.reactionTime <= 0.24);
  ok(pop.length === 8 && wOk && bOk, 'init: 8 genomes, valid weights, behavior in ranges');
}
// 2. mini coevolve run completes with finite fitness and full match count.
{
  const { info } = await runTrainer({ charA: 'cowboy', charB: 'ninja', defA, defB, populationSize: 2, maxGenerations: 1, framesPerChunk: 3000 });
  ok(info.reason === 'done' && info.generation === 1 && info.matchesPlayed === 2, `mini-run completes (gen ${info.generation}, matches ${info.matchesPlayed})`);
  ok(Number.isFinite(info.best) && Number.isFinite(info.avg), `fitness finite (best ${info.best}, avg ${info.avg})`);
}
// 3. elitism: the champion's weights survive breeding untouched.
{
  const pop = initPopulation(6);
  pop.forEach((g, i) => { g.fitness = i * 10; });
  const bestW = pop[5].weights.slice();
  const next = nextGeneration(pop, { eliteRate: 0.2, tournamentSize: 2, mutationRate: 0, mutationStrength: 0, bigKickChance: 0 });
  ok(next.length === 6 && next.some((g) => g.weights.every((w, i) => w === bestW[i])), 'elite clone preserves champion weights');
}
// 4. mutation perturbs weights.
{
  const g = cloneGenome(initPopulation(2)[0]);
  const before = g.weights.slice();
  mutateGenome(g, 1.0, 0.5, 0);
  ok(g.weights.some((w, i) => w !== before[i]), 'mutation changes weights at rate 1.0');
}
// 5. crossover mixes both parents (never a pure clone over many children).
{
  const a = initPopulation(2)[0], b = initPopulation(2)[1];
  let fromA = 0, fromB = 0;
  for (let i = 0; i < 12; i++) {
    const c = crossoverGenomes(a, b);
    for (let k = 0; k < c.weights.length; k += 37) {
      if (c.weights[k] === a.weights[k]) fromA++;
      if (c.weights[k] === b.weights[k]) fromB++;
    }
  }
  ok(fromA > 0 && fromB > 0, `crossover mixes parents (A:${fromA} B:${fromB})`);
}
// 6. pause/resume completes a run.
{
  const tr = createTrainer({ charA: 'cowboy', charB: 'ninja', defA, defB, populationSize: 2, maxGenerations: 2, framesPerChunk: 600 });
  tr.start();
  await new Promise((r) => setTimeout(r, 250));
  const paused = tr.pause();
  const snapP = tr.snapshot();
  const resumed = tr.resume();
  const info = await new Promise((res) => {
    const iv = setInterval(() => { if (!tr.isRunning()) { clearInterval(iv); res(tr.snapshot()); } }, 200);
  });
  ok(paused && snapP.paused && resumed, 'pause/resume cycle works');
  ok(info.generation === 2 && info.matchesPlayed === 4, `resumed run finishes (gen ${info.generation}, matches ${info.matchesPlayed})`);
}
// 7. stop saves a v2 model and a run record.
{
  const before = listRunHistory(50).length;
  const tr = createTrainer({ charA: 'cowboy', charB: 'ninja', defA, defB, populationSize: 2, maxGenerations: 50, framesPerChunk: 600 });
  tr.start();
  await new Promise((r) => setTimeout(r, 400));
  tr.stop();
  const m = getActiveModel('cowboy');
  const after = listRunHistory(50).length;
  ok(!!m && Array.isArray(m.weights) && m.weights.length === NN_WEIGHT_COUNT, 'stop saves active cowboy model');
  ok(after === before + 1, 'stop records run history');
}
// 8. continue mode seeds from the saved model.
{
  const tr = createTrainer({ charA: 'cowboy', charB: 'ninja', defA, defB, populationSize: 2, maxGenerations: 3, framesPerChunk: 3000, startMode: 'continue' });
  tr.start();
  await new Promise((r) => setTimeout(r, 150));
  const snap = tr.snapshot();
  tr.stop();
  ok(snap.warnings.some((w) => w.includes('continued')), `continue seeds from saved model (${JSON.stringify(snap.warnings)})`);
}
// 9. tournament selection favors the fittest over the weakest.
{
  const pop = initPopulation(10);
  pop.forEach((g, i) => { g.fitness = i; });
  let bestWins = 0, worstWins = 0;
  for (let i = 0; i < 40; i++) {
    const pick = tournamentSelect(pop, 5);
    if (pick === pop[9]) bestWins++;
    if (pick === pop[0]) worstWins++;
  }
  ok(bestWins > worstWins + 5, `selection favors champion ${bestWins} over weakest ${worstWins} (40 picks)`);
}
// 10. clones are isolated (mutating a clone never touches the original).
{
  const g = initPopulation(2)[0];
  const c = cloneGenome(g);
  const before = g.weights[0];
  c.weights[0] = before + 123.456;
  c.behavior.aggression = -999;
  ok(g.weights[0] === before && g.behavior.aggression !== -999, 'clone is a deep copy');
}

console.log(`== t4: ${passes} passed, ${failures} failed ==`);
process.exit(failures ? 1 : 0);
