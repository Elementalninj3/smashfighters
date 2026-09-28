// verify-ai-evolution.mjs — deeper evolution checks:
// same-character training, diversity/crossover/mutation evidence, elitism
// (best preserved), difficulty behavior differences, no regressions.
import { chromium } from 'playwright';

const URL = 'http://localhost:5173/?probe';
const EXE = 'C:/Users/User/AppData/Local/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-win64/chrome-headless-shell.exe';

let passes = 0, failures = 0;
function ok(cond, msg) {
  if (cond) { passes++; console.log('  PASS  ' + msg); }
  else { failures++; console.log('  FAIL  ' + msg); }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const browser = await chromium.launch({ headless: true, executablePath: EXE, args: ['--enable-unsafe-swiftshader', '--no-first-run'] });
const page = await browser.newPage({ viewport: { width: 1200, height: 1100 } });
const errors = [];
page.on('pageerror', (err) => { errors.push(err.message); console.log('[pageerror]', err.message); });

await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('canvas', { timeout: 15000 });
await sleep(1000);

console.log('== same-character training: Cowboy vs Cowboy, pop 6, gens 6 ==');
await page.evaluate(() => window.__ssTest.aiTraining().open());
await page.evaluate(() => window.__ssTest.aiTraining().set({ ai1: 0, ai2: 0, populationSize: 6, maxGenerations: 6, mutationRate: 0.05, speed: 'Fastest', showSim: false }));
await page.evaluate(() => window.__ssTest.aiTraining().start());
let prog = null, waited = 0;
const gensSeen = [];
while (waited < 240000) {
  await sleep(2000);
  waited += 2000;
  prog = await page.evaluate(() => window.__ssTest.aiTraining().progress());
  if (prog) {
    if (!gensSeen.length || gensSeen[gensSeen.length - 1].gen !== prog.generation) {
      gensSeen.push({ gen: prog.generation, best: Math.round(prog.best), avg: Math.round(prog.avg), divA: +((prog.diversityA || 0).toFixed(3)) });
      console.log(`   gen ${prog.generation}: best=${Math.round(prog.best)} avg=${Math.round(prog.avg)} divA=${(prog.diversityA || 0).toFixed(3)}`);
    }
    if (!prog.running) break;
  }
}
ok(prog && !prog.running && prog.generation === 6, `6 same-char generations completed (got ${prog && prog.generation})`);
ok(prog && prog.matchesPlayed === 36, `36 matches played (got ${prog && prog.matchesPlayed})`);
// Mutation/diversity: gene pool must not be clones of one genome.
const lastDiv = prog && (prog.diversityA || 0);
ok(lastDiv > 0.001, `population keeps genetic diversity (divA=${lastDiv})`);
// Fitness moves across generations (selection + crossover do something).
// Use the trainer's own per-generation history (polls can miss fast gens).
const histBests = (prog.history || []).map((h) => Math.round(h.best));
console.log('   history bests per gen:', histBests.join(' -> '));
ok(histBests.length === 6, `history covers all 6 gens (got ${histBests.length})`);
const spread = histBests.length ? Math.max(...histBests) - Math.min(...histBests) : 0;
ok(spread > 1, `fitness varies across generations (spread=${Math.round(spread)})`);
// Elitism: best-ever must be at least as good as every generation best.
const savedBest = (await page.evaluate(() => window.__ssTest.state().trainedModels) || [])
  .filter((m) => m.character === 'cowboy');
console.log('   saved cowboy:', JSON.stringify(savedBest));
ok(savedBest.length > 0 && savedBest[0].fitness >= Math.max(...histBests) - 1e-6, 'best genome preserved and saved (elitism)');

console.log('== difficulty actually changes AI behavior ==');
const easy = await page.evaluate(() => window.__ssTest.aiConfig('Easy', 'cowboy'));
const expert = await page.evaluate(() => window.__ssTest.aiConfig('Expert', 'cowboy'));
const trained = await page.evaluate(() => window.__ssTest.aiConfig('Trained', 'cowboy'));
console.log('   Easy:', JSON.stringify({ rt: easy.personality.reactionTime, def: easy.personality.defense, mist: easy.mistakeRate, neuro: easy.neuroInfluence }));
console.log('   Expert:', JSON.stringify({ rt: expert.personality.reactionTime, def: expert.personality.defense, mist: expert.mistakeRate, neuro: expert.neuroInfluence, model: expert.hasModel }));
console.log('   Trained:', JSON.stringify({ mist: trained.mistakeRate, neuro: trained.neuroInfluence, model: trained.hasModel, weights: trained.weightCount }));
ok(easy.personality.reactionTime > expert.personality.reactionTime, 'Easy reacts slower than Expert');
ok(easy.personality.defense < expert.personality.defense, 'Easy defends worse than Expert');
ok(easy.mistakeRate > expert.mistakeRate, 'Easy makes more mistakes than Expert');
ok(expert.neuroInfluence > 0 && expert.hasModel, 'Expert uses the trained network when a model exists');
ok(trained.neuroInfluence === 1 && trained.weightCount === 868, 'Trained runs the full 868-weight network');
const easyNinja = await page.evaluate(() => window.__ssTest.aiConfig('Easy', 'cowboy'));
ok(easyNinja.neuroInfluence === 0 && !easyNinja.hasModel, 'Easy stays scripted (no network)');
const unknown = await page.evaluate(() => window.__ssTest.aiConfig('Trained', 'nonexistent-char'));
ok(unknown.neuroInfluence === 0 && !unknown.hasModel, 'unknown character falls back to scripted, no crash');

console.log('== trained cowboy model reused by Expert/Trained, fallback safe ==');
await page.evaluate(() => window.__ssTest.aiTraining().close());
await page.evaluate(() => window.__ssTest.setMode('AIvsAI'));
await page.evaluate(() => window.__ssTest.setDifficulty('Expert'));
await page.evaluate(() => {
  const row = [...document.querySelectorAll('#term-lines .term-row')].find((x) => x.textContent.includes('START MATCH'));
  if (row) row.click();
  // The start gate needs a confirming press before the match begins: dispatch a
  // real Space keydown/keyup AFTER the click (startNewMatch flushes edges, so the
  // press must come after it) to open the gate.
  window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', bubbles: true }));
  window.dispatchEvent(new KeyboardEvent('keyup', { code: 'Space', bubbles: true }));
});
await sleep(5000);
let s = await page.evaluate(() => window.__ssTest.state());
ok(s && s.gameState === 'playing', 'AIvsAI match starts on Expert');
ok(s && s.ai && s.ai[0] && s.ai[1], 'both AI controllers live');
const acts = [s.ai[0].action, s.ai[1].action];
console.log('   AI actions:', JSON.stringify(s.ai.map((a) => a && a.state)));
ok(s.ai.some((a) => a && a.state && a.state !== 'init'), 'Expert AI makes decisions');
await page.keyboard.press('KeyM');
await sleep(400);

console.log('== console error check ==');
const realErrors = errors.filter((e) => !/swiftshader|WebGL|AudioContext/i.test(e));
ok(realErrors.length === 0, `no page errors (${realErrors.length})`);

console.log(`\nRESULT: ${passes} passed, ${failures} failed`);
await browser.close();
process.exit(failures ? 1 : 0);
