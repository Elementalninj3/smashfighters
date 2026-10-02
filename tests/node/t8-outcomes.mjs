// t8-outcomes.mjs — (H) training outcome reviews: 10 targeted checks.
// Verifies evaluation reports reflect real bouts, aggregates recompute,
// breakdown integrity, variety/spam math, back-compat, and run records.
// Run: node tests/node/t8-outcomes.mjs
import './_env.mjs';
import { resetEnvStorage } from './_env.mjs';
import { evaluateModels, createTrainer } from '../../src/ai.js';
import { computeFitness, computeFitnessBreakdown } from '../../src/ai.js';
import { listRunHistory } from '../../src/ai.js';
import { ALL_FIGHTERS } from '../../src/combat.js';

let passes = 0, failures = 0;
function ok(cond, msg) {
  if (cond) { passes++; console.log('  PASS  ' + msg); }
  else { failures++; console.log('  FAIL  ' + msg); }
}
const defA = ALL_FIGHTERS[0], defB = ALL_FIGHTERS[1];
resetEnvStorage();

// 1. report shape: counts add up, per-match recorded.
{
  const r = evaluateModels({ defA, defB, genomeA: null, oppB: { kind: 'dummy' }, matches: 4 });
  ok(r.ok && r.matches === 4 && r.perMatch.length === 4 && r.wins + r.losses + r.draws === 4, 'report counts reconcile');
}
// 2. aggregates recompute exactly from per-match rows (no fabrication).
{
  const r = evaluateModels({ defA, defB, genomeA: null, oppB: { kind: 'dummy' }, matches: 4 });
  const dealt = r.perMatch.reduce((a, m) => a + m.dealt, 0) / r.matches;
  const wins = r.perMatch.filter((m) => m.winner === 1).length;
  ok(Math.abs(dealt - r.avgDealt) < 1e-9 && wins === r.wins, 'averages match per-match rows');
}
// 3. rates bounded in [0,1].
{
  const r = evaluateModels({ defA, defB, genomeA: null, oppB: { kind: 'scripted', difficulty: 'Easy', charId: 'ninja' }, matches: 3 });
  ok(r.winRate >= 0 && r.winRate <= 1 && r.hitRate >= 0 && r.hitRate <= 1 && r.recRate >= 0 && r.recRate <= 1, `rates bounded (${r.winRate},${r.hitRate},${r.recRate})`);
}
// 4. run record fitness curve matches generations after a real mini-run.
{
  const before = listRunHistory(50).length;
  await new Promise((res) => {
    const tr = createTrainer({ charA: 'cowboy', charB: 'ninja', defA, defB, populationSize: 2, maxGenerations: 2, framesPerChunk: 3000, onDone: () => res() });
    tr.start();
  });
  const after = listRunHistory(50);
  const rec = after[after.length - 1 - before] || after[0];
  const latest = after[0];
  ok(after.length === before + 1 && latest.generations === 2 && latest.fitnessCurve.length === 2 && latest.matches === 4,
    `run record truthful (gens ${latest.generations}, curve ${latest.fitnessCurve.length}, matches ${latest.matches})`);
}
// 5. breakdown parts sum to the total on varied bundles.
{
  const bundles = [
    { win: 1, stocksTaken: 1, damageDealt: 40, hitsLanded: 5, combos: 2, blocks: 1, dodges: 1, punishes: 1, recoveries: 1, recoveryAttempts: 2, edgeguards: 0, centerTime: 300, aliveFrames: 900, damageTaken: 20, stocksLost: 0, whiffs: 2, wastedRecoveries: 0, idleFrames: 10, offStageFrames: 50, failedActions: 1, attacksStarted: 8, attacksHit: 5, moveUses: { jab: 3, ftilt: 2, utilt: 2, usmash: 1 }, moveHits: { jab: 2 } },
    { win: 0, damageDealt: 5, damageTaken: 60, stocksLost: 1, whiffs: 9, idleFrames: 500, moveUses: { jab: 9, ftilt: 1 }, attacksStarted: 10, attacksHit: 1 },
    { win: 0.25, damageDealt: 10, damageTaken: 10 },
  ];
  ok(bundles.every((s) => {
    const b = computeFitnessBreakdown(s);
    return Math.abs((b.parts.win + b.parts.stocks + b.parts.damage + b.parts.offense + b.parts.defense + b.parts.position + b.parts.variety + b.parts.penalties) - b.total) < 1e-9
      && b.total === computeFitness(s);
  }), 'breakdown sums to total == computeFitness on 3 bundles');
}
// 6. variety beats spam, all else equal.
{
  const base = { win: 0, damageDealt: 30, hitsLanded: 6, attacksStarted: 8, attacksHit: 5, damageTaken: 10 };
  const varied = { ...base, moveUses: { jab: 2, ftilt: 2, utilt: 2, usmash: 2 } };
  const spammy = { ...base, moveUses: { jab: 8 } };
  ok(computeFitness(varied) > computeFitness(spammy), `variety ${computeFitness(varied).toFixed(1)} > spam ${computeFitness(spammy).toFixed(1)}`);
}
// 7. old-style bundles (no moveUses) stay neutral: no variety, no spam.
{
  const b = computeFitnessBreakdown({ win: 1, damageDealt: 20 });
  ok(b.parts.variety === 0 && b.parts.penalties === 0, 'legacy bundles unaffected by new terms');
}
// 8. missing defs fail closed (never a fake report).
{
  const r = evaluateModels({ defA: null, defB, matches: 2 });
  ok(!r.ok && r.error, 'missing defs return error, not data');
}
// 9. two evaluations under identical scenarios are independent + comparable.
{
  const o = { defA, defB, genomeA: null, oppB: { kind: 'dummy' }, matches: 2 };
  const a = evaluateModels(o), b = evaluateModels(o);
  ok(a.perMatch.length === 2 && b.perMatch.length === 2 && a !== b && a.perMatch !== b.perMatch, 'independent comparable reports');
}
// 10. interrupted run records status=stopped with models + history intact.
{
  const before = listRunHistory(50).length;
  const tr = createTrainer({ charA: 'cowboy', charB: 'ninja', defA, defB, populationSize: 2, maxGenerations: 50, framesPerChunk: 600 });
  tr.start();
  await new Promise((r) => setTimeout(r, 400));
  tr.stop();
  const after = listRunHistory(50);
  ok(after.length === before + 1 && after[0].status === 'stopped' && after[0].savedModelIds.length >= 1, `interrupted run recorded (${after[0].status}, models ${after[0].savedModelIds.length})`);
}

console.log(`== t8: ${passes} passed, ${failures} failed ==`);
process.exit(failures ? 1 : 0);
