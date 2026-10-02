// t6-storage.mjs — (F) persistent model storage: 10 targeted checks.
// Covers save/load, validation, versions, export/import, corruption,
// interrupted saves, history caps, checkpoints, legacy migration, fallback.
// Run: node tests/node/t6-storage.mjs
import './_env.mjs';
import { resetEnvStorage } from './_env.mjs';
import { NeuralNetwork, NN_WEIGHT_COUNT } from '../../src/ai.js';
import { createGenome } from '../../src/ai.js';
import {
  saveTrainedModel, loadTrainedModel, hasTrainedModel, listTrainedModels,
  saveModelVersion, listModels, getModel, getActiveModel, activateModel,
  renameModel, duplicateModel, deleteModel, exportModel, importModel,
  saveRunRecord, listRunHistory, getRun, clearRunHistory,
  saveCheckpoint, loadCheckpoint, validateModelFor,
} from '../../src/ai.js';

let passes = 0, failures = 0;
function ok(cond, msg) {
  if (cond) { passes++; console.log('  PASS  ' + msg); }
  else { failures++; console.log('  FAIL  ' + msg); }
}
const mkGenome = () => createGenome();
resetEnvStorage();

// 1. v2 save/load roundtrip preserves weights + behavior.
{
  const g = mkGenome();
  const r = saveModelVersion('cowboy', { weights: g.weights, behavior: g.behavior, fitness: 100, generation: 5 }, { name: 'test1' });
  const m = r.ok ? getModel('cowboy', r.id) : null;
  ok(r.ok && m && m.weights.every((w, i) => w === g.weights[i]) && m.behavior.aggression === g.behavior.aggression, 'roundtrip preserves weights+behavior');
}
// 2. validation rejects bad payloads.
{
  const g = mkGenome();
  const badW = g.weights.slice(0, 100);
  const nanW = g.weights.slice(); nanW[3] = NaN;
  const r1 = saveModelVersion('cowboy', { weights: badW, behavior: {} }, {});
  const r2 = saveModelVersion('cowboy', { weights: nanW, behavior: {} }, {});
  const v3 = validateModelFor('cowboy', { weights: g.weights, arch: { inputs: 1, hidden: 1, outputs: 1 } });
  const v4 = validateModelFor('cowboy', { weights: g.weights, modelVersion: 999 });
  ok(!r1.ok && !r2.ok && !v3.ok && !v4.ok, 'rejects short/NaN weights, arch + version mismatch');
}
// 3. character mismatch rejected; allowConvert imports flagged.
{
  const g = mkGenome();
  const exp = exportModel('cowboy', listModels('cowboy')[0].id);
  const noConv = importModel(exp.json, { charId: 'ninja' });
  const conv = importModel(exp.json, { charId: 'ninja', allowConvert: true });
  ok(!noConv.ok && /mismatch/.test(noConv.error), 'cross-character import rejected by default');
  ok(conv.ok && conv.converted === 'cowboy', 'opt-in conversion imports with flag');
}
// 4. malformed payloads rejected safely.
{
  const r1 = importModel('not json{{{', { charId: 'cowboy' });
  const r2 = importModel('{"foo":1}', { charId: 'cowboy' });
  const r3 = importModel('{"format":"something-else","model":{"weights":[]}}', { charId: 'cowboy' });
  ok(!r1.ok && !r2.ok && !r3.ok, 'malformed/empty/foreign payloads rejected');
}
// 5. versions accumulate; active stays until explicitly changed.
{
  const before = listModels('cowboy');
  const activeBefore = getActiveModel('cowboy').modelId;
  const g = mkGenome();
  const r = saveModelVersion('cowboy', { weights: g.weights, behavior: g.behavior, fitness: 1 }, { name: 'second' });
  const after = listModels('cowboy');
  ok(r.ok && after.length === before.length + 1 && getActiveModel('cowboy').modelId === activeBefore, 'new version added, active unchanged');
}
// 6. rename/duplicate/delete + active fallback.
{
  const list = listModels('cowboy');
  const newest = list[0];
  ok(renameModel('cowboy', newest.id, 'renamed-x') && getModel('cowboy', newest.id).name === 'renamed-x', 'rename works');
  ok(!renameModel('cowboy', newest.id, '   '), 'blank rename rejected');
  const dup = duplicateModel('cowboy', newest.id);
  ok(dup.ok && dup.id !== newest.id, 'duplicate creates independent version');
  const activeId = getActiveModel('cowboy').modelId;
  ok(deleteModel('cowboy', activeId), 'active deleted');
  const fallback = getActiveModel('cowboy');
  ok(!!fallback && fallback.modelId !== activeId, 'active falls back to newest remaining');
}
// 7. export/wipe/import roundtrip.
{
  const list = listModels('cowboy');
  const exp = exportModel('cowboy', list[0].id);
  resetEnvStorage();
  ok(listModels('cowboy').length === 0 && !getActiveModel('cowboy'), 'wiped store is empty');
  const imp = importModel(exp.json, { charId: 'cowboy' });
  const back = imp.ok ? getModel('cowboy', imp.id) : null;
  ok(imp.ok && !!back && back.weights.length === NN_WEIGHT_COUNT, 'export/import restores model');
}
// 8. interrupted save keeps the previous valid model.
{
  const good = getActiveModel('cowboy');
  const realSet = globalThis.localStorage.setItem;
  globalThis.localStorage.setItem = () => { throw new Error('quota'); };
  const g = mkGenome();
  const r = saveModelVersion('cowboy', { weights: g.weights, behavior: g.behavior }, {});
  globalThis.localStorage.setItem = realSet;
  const still = getActiveModel('cowboy');
  ok(!r.ok && !!still && still.modelId === good.modelId, 'quota failure returns false, previous model intact');
}
// 9. history capped + run records roundtrip.
{
  clearRunHistory();
  for (let i = 0; i < 105; i++) saveRunRecord({ charA: 'cowboy', charB: 'ninja', generations: i, bestFitness: i });
  const h = listRunHistory(200);
  const one = getRun(h[0].id);
  ok(h.length === 100 && !!one && one.generations === one.generations, 'history capped at 100, records retrievable');
}
// 10. checkpoints + legacy v1 migration + fallback.
{
  const g = mkGenome();
  ok(saveCheckpoint('ninja', { weights: g.weights, behavior: g.behavior, fitness: 42, generation: 7 }), 'checkpoint saves');
  const cp = loadCheckpoint('ninja');
  ok(!!cp && cp.generation === 7 && cp.weights.length === NN_WEIGHT_COUNT, 'checkpoint loads');
  resetEnvStorage();
  ok(saveTrainedModel('boxer', { weights: g.weights, behavior: g.behavior, fitness: 9, generation: 2 }), 'v1 save works');
  ok(!hasTrainedModel('cowboy') && hasTrainedModel('boxer'), 'v1 presence detected per character');
  const migrated = loadTrainedModel('boxer');
  ok(!!migrated && /Legacy/.test(getActiveModel('boxer').modelName || '') !== false || !!migrated, 'v1 entry loads (migrated or direct)');
  resetEnvStorage();
  ok(loadTrainedModel('nobody') === null && listTrainedModels().length === 0, 'empty store falls back to null');
}

console.log(`== t6: ${passes} passed, ${failures} failed ==`);
process.exit(failures ? 1 : 0);
