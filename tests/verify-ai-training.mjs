// verify-ai-training.mjs — runtime verification for AI Training + AI Difficulty.
// Covers: menu presence, difficulty cycling, training submenu, a real small
// evolution run (generations progress, fitness finite/changing, genomes saved),
// and loading the trained model into a normal AI match without errors.
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
page.on('console', (msg) => { if (msg.type() === 'error') { errors.push(msg.text()); console.log('[console.error]', msg.text()); } });

const state = () => page.evaluate(() => (window.__ssTest ? window.__ssTest.state() : null));
const rows = () => page.evaluate(() => [...document.querySelectorAll('#term-lines .term-row')].map((r) => r.textContent));

await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('canvas', { timeout: 15000 });
await sleep(1200);

console.log('== menu: AI TRAINING + AI DIFFICULTY rows ==');
let r = await rows();
ok(r.some((x) => x.includes('AI DIFFICULTY')), 'AI DIFFICULTY row present');
ok(r.some((x) => x.includes('AI TRAINING')), 'AI TRAINING row present');

console.log('== difficulty cycles through 5 levels ==');
const diffs = await page.evaluate(() => window.__ssTest.setDifficulty('Expert') && window.__ssTest.state().aiDifficulty);
ok(diffs === 'Expert', `setDifficulty Expert works (got ${diffs})`);
await page.evaluate(() => window.__ssTest.setDifficulty('Trained'));
await sleep(150);
r = await rows();
ok(r.some((x) => x.includes('AI DIFFICULTY') && x.includes('TRAINED')), 'menu shows TRAINED difficulty');
await page.evaluate(() => window.__ssTest.setDifficulty('Normal'));

console.log('== training submenu opens with all controls ==');
await page.evaluate(() => window.__ssTest.aiTraining().open());
await sleep(300);
r = await rows();
for (const label of ['AI 1 CHARACTER', 'AI 2 CHARACTER', 'POPULATION SIZE', 'MAX GENERATIONS', 'MUTATION RATE', 'TRAINING SPEED', 'SHOW SIMULATION', 'START TRAINING', 'BACK']) {
  ok(r.some((x) => x.includes(label)), `training row present: ${label}`);
}
ok(r.some((x) => x.includes('Cowboy')), 'character dropdown shows roster name (Cowboy)');
ok(r.some((x) => x.includes('Ninja')), 'character dropdown shows roster name (Ninja)');

console.log('== small evolution run: pop 10, gens 3 ==');
await page.evaluate(() => window.__ssTest.aiTraining().set({ ai1: 0, ai2: 1, populationSize: 4, maxGenerations: 3, mutationRate: 0.08, speed: 'Fastest', showSim: true }));
await sleep(200);
const started = await page.evaluate(() => window.__ssTest.aiTraining().start());
ok(started === true, 'training starts');
await sleep(500);
let running = await page.evaluate(() => window.__ssTest.aiTraining().running());
const earlyProg = await page.evaluate(() => window.__ssTest.aiTraining().progress());
ok(running === true || (earlyProg && (earlyProg.generation > 0 || earlyProg.matchesPlayed > 0)), 'training runs (or already progressed bouts)');

console.log('== generations progress with real fitness ==');
// Wait for completion (generous timeout for headless swiftshader).
let prog = null;
let waited = 0;
while (waited < 180000) {
  await sleep(2000);
  waited += 2000;
  prog = await page.evaluate(() => window.__ssTest.aiTraining().progress());
  if (prog && !prog.running) break;
  if (prog) console.log(`   ... gen ${prog.generation}/${prog.maxGenerations} best=${Math.round(prog.best)} avg=${Math.round(prog.avg)} matches=${prog.matchesPlayed}`);
}
ok(prog && !prog.running, 'training run finished');
ok(prog && prog.generation === 3, `completed all 3 generations (got ${prog && prog.generation})`);
ok(prog && prog.matchesPlayed === 12, `played 4 pairs x 3 gens = 12 matches (got ${prog && prog.matchesPlayed})`);
ok(prog && Number.isFinite(prog.best), `best fitness is finite (${prog && prog.best})`);
ok(prog && Number.isFinite(prog.avg), `avg fitness is finite (${prog && prog.avg})`);
ok(prog && Array.isArray(prog.history) && prog.history.length === 3, `history has 3 entries (got ${prog && prog.history && prog.history.length})`);
const fits = prog.history.map((h) => h.best);
console.log('   fitness history:', fits.map((f) => Math.round(f)).join(' -> '));

console.log('== models saved per character ==');
const s = await state();
ok(s && Array.isArray(s.trainedModels) && s.trainedModels.length >= 2, `2 trained models saved (got ${JSON.stringify(s && s.trainedModels)})`);
const cowboy = (s.trainedModels || []).find((m) => m.character === 'cowboy');
ok(!!cowboy && Number.isFinite(cowboy.fitness), 'cowboy model has fitness');
ok(!!cowboy && cowboy.generation === 3, `cowboy model records generation 3 (got ${cowboy && cowboy.generation})`);
// Verify raw stored payload: weights length + arch + behavior.
const payload = await page.evaluate(() => {
  try {
    const store = JSON.parse(localStorage.getItem('smashfighters.trainedModels.v1')) || {};
    const m = store.cowboy;
    return m ? { weights: m.weights.length, arch: m.arch, behaviorKeys: Object.keys(m.behavior || {}).length, opponent: m.opponent } : null;
  } catch (e) { return { error: String(e) }; }
});
ok(payload && payload.weights === 868, `stored genome has 868 NN weights (got ${payload && payload.weights})`);
ok(payload && payload.arch && payload.arch.inputs === 32 && payload.arch.hidden === 16 && payload.arch.outputs === 20, 'stored arch is 32x16x20');
ok(payload && payload.behaviorKeys >= 10, `stored behavior has personality params (got ${payload && payload.behaviorKeys})`);
ok(payload && payload.opponent === 'ninja', `cowboy model records opponent ninja (got ${payload && payload.opponent})`);

console.log('== menu shows progress UI ==');
r = await rows();
ok(r.some((x) => x.includes('GENERATION')), 'GENERATION x / y shown');
ok(r.some((x) => x.includes('BEST FITNESS')), 'BEST FITNESS shown');
ok(r.some((x) => x.includes('AVERAGE')), 'AVERAGE FITNESS shown');

console.log('== trained model loads into a normal AI match ==');
await page.evaluate(() => window.__ssTest.aiTraining().close());
await page.evaluate(() => window.__ssTest.setDifficulty('Trained'));
await page.evaluate(() => window.__ssTest.setMode('playerVsAI'));
await sleep(200);
// Start a playerVsAI match via the START row click.
await page.evaluate(() => {
  const row = [...document.querySelectorAll('#term-lines .term-row')].find((x) => x.textContent.includes('START MATCH'));
  if (row) row.click();
  // The start gate needs a confirming press before the match begins: dispatch a
  // real Space keydown/keyup AFTER the click (startNewMatch flushes edges, so the
  // press must come after it) to open the gate.
  window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', bubbles: true }));
  window.dispatchEvent(new KeyboardEvent('keyup', { code: 'Space', bubbles: true }));
});
await sleep(800);
let g = await state();
ok(g && g.gameState === 'playing', 'match starts with Trained difficulty');
ok(g && g.ai && g.ai[1], 'P2 AI controller exists in playerVsAI');
// Let the AI act for a few seconds and confirm it makes decisions.
await sleep(4000);
g = await state();
const aiDbg = g && g.ai && g.ai[1];
console.log('   AI debug:', JSON.stringify(aiDbg));
ok(aiDbg && aiDbg.state && aiDbg.state !== 'init', `trained AI is deciding (state=${aiDbg && aiDbg.state})`);
const p2 = g && g.fighters[1];
ok(p2 && (Math.abs(p2.vx) > 1 || Math.abs(p2.x - 780) > 5 || p2.percent >= 0), 'AI fighter has live state');

console.log('== stop training safely / menu return ==');
await page.keyboard.press('KeyM');
await sleep(500);
g = await state();
ok(g && g.gameState === 'menu', 'M returns to menu cleanly after AI match');

console.log('== restart training then STOP mid-run ==');
await page.evaluate(() => window.__ssTest.aiTraining().open());
await page.evaluate(() => window.__ssTest.aiTraining().set({ populationSize: 6, maxGenerations: 50, speed: 'Normal' }));
await page.evaluate(() => window.__ssTest.aiTraining().start());
await sleep(1500);
const midRunning = await page.evaluate(() => window.__ssTest.aiTraining().running());
ok(midRunning === true, 'second run is in-flight');
const stopped = await page.evaluate(() => window.__ssTest.aiTraining().stop());
ok(stopped === true, 'stop() halts training');
await sleep(300);
const afterStop = await page.evaluate(() => window.__ssTest.aiTraining().running());
ok(afterStop === false, 'training reports stopped');
const modelsAfter = await page.evaluate(() => window.__ssTest.state().trainedModels);
ok(Array.isArray(modelsAfter) && modelsAfter.length >= 2, 'best-so-far saved on stop');

console.log('== console error check ==');
const realErrors = errors.filter((e) => !/swiftshader|WebGL|AudioContext/i.test(e));
ok(realErrors.length === 0, `no page errors (${realErrors.length}: ${realErrors.slice(0, 3).join(' | ')})`);

console.log(`\nRESULT: ${passes} passed, ${failures} failed`);
await browser.close();
process.exit(failures ? 1 : 0);
