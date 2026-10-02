import './_env.mjs';

const t = await import('../../src/ai.js');
const { ALL_FIGHTERS } = await import('../../src/combat.js');
const defA = ALL_FIGHTERS[0], defB = ALL_FIGHTERS[1];

// 1. coevolve mini-run: pop 2, 1 generation
{
  const tr = t.createTrainer({
    charA: 'cowboy', charB: 'ninja', defA, defB,
    populationSize: 2, maxGenerations: 1, framesPerChunk: 3000,
  });
  const done = await new Promise((res) => {
    const tr2 = t.createTrainer({
      charA: 'cowboy', charB: 'ninja', defA, defB,
      populationSize: 2, maxGenerations: 1, framesPerChunk: 3000,
      onDone: (info) => res(info),
    });
    tr2.start();
  });
  console.log('coevolve done:', done.reason, 'gen:', done.generation, 'matches:', done.matchesPlayed,
    'savedA:', JSON.stringify(done.saved && done.saved.savedA && done.saved.savedA.ok),
    'runId:', !!(done.saved && done.saved.runId));
}

// 2. fixed-opponent (scripted) + pause/resume
{
  const tr = t.createTrainer({
    charA: 'cowboy', charB: 'ninja', defA, defB, mode: 'character', oppType: 'scripted',
    scriptedDifficulty: 'Normal', populationSize: 2, maxGenerations: 2, framesPerChunk: 600,
  });
  tr.start();
  await new Promise((r) => setTimeout(r, 300));
  const p = tr.snapshot();
  console.log('running:', p.running, 'phase:', p.phase, 'mode:', p.mode, 'opp:', p.oppType);
  console.log('pause:', tr.pause(), 'paused:', tr.snapshot().paused);
  await new Promise((r) => setTimeout(r, 200));
  console.log('resume:', tr.resume());
  const info = await new Promise((res) => {
    const iv = setInterval(() => {
      if (!tr.isRunning()) { clearInterval(iv); res(tr.snapshot()); }
    }, 200);
  });
  console.log('finished gen:', info.generation, 'matches:', info.matchesPlayed);
}

// 3. evaluateModels vs dummy (fast, deterministic-ish)
{
  const rep = t.evaluateModels({ defA, defB, genomeA: null, oppB: { kind: 'dummy' }, matches: 3 });
  console.log('eval:', rep.ok, 'matches:', rep.matches, 'wins:', rep.wins,
    'avgDealt:', rep.avgDealt.toFixed(1), 'moveUses keys:', Object.keys(rep.moveUses).length);
}
console.log('ALL SMOKE OK');
process.exit(0);
