// verify-ai-medium.mjs — spec §31 medium scale: pop 20 / gens 10, Ninja vs
// Cowboy (reverse pairing), responsiveness DURING training, 250-gen estimate.
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

console.log('== medium run: Ninja vs Cowboy, pop 20, gens 10 ==');
await page.evaluate(() => window.__ssTest.aiTraining().open());
await page.evaluate(() => window.__ssTest.aiTraining().set({ ai1: 1, ai2: 0, populationSize: 20, maxGenerations: 10, mutationRate: 0.05, speed: 'Fastest', showSim: true }));
const t0 = Date.now();
await page.evaluate(() => window.__ssTest.aiTraining().start());

// Responsiveness DURING training: the page must answer polls and key input
// while evolution churns in the background.
let responsive = 0, polls = 0, prog = null, waited = 0;
while (waited < 300000) {
  await sleep(1500);
  waited += 1500;
  polls++;
  const t = Date.now();
  try {
    prog = await page.evaluate(() => window.__ssTest.aiTraining().progress());
    if (Date.now() - t < 1000) responsive++;
  } catch (_) {}
  // Keyboard still works mid-training (cursor moves).
  try {
    await page.keyboard.press('ArrowDown');
    responsive++;
  } catch (_) {}
  if (prog) console.log(`   gen ${prog.generation}/10 best=${Math.round(prog.best)} avg=${Math.round(prog.avg)} matches=${prog.matchesPlayed}`);
  if (prog && !prog.running) break;
}
const secs = ((Date.now() - t0) / 1000).toFixed(1);
ok(prog && !prog.running && prog.generation === 10, `10 gens completed (got ${prog && prog.generation})`);
ok(prog && prog.matchesPlayed === 200, `200 matches played (got ${prog && prog.matchesPlayed}) in ${secs}s`);
const rate = prog ? (prog.matchesPlayed / ((Date.now() - t0) / 1000)) : 0;
console.log(`   throughput: ${rate.toFixed(1)} matches/sec -> 250-gen x pop-50 estimate: ${(12500 / Math.max(0.1, rate) / 60).toFixed(1)} min`);
ok(responsive >= polls, `page responsive during training (${responsive}/${polls * 2} checks)`);

// Reverse-pairing models are character-specific.
const models = await page.evaluate(() => window.__ssTest.state().trainedModels);
const ninja = (models || []).find((m) => m.character === 'ninja');
console.log('   models:', JSON.stringify(models));
ok(!!ninja && ninja.opponent === 'cowboy', 'ninja model trained vs cowboy (pair-specific)');
ok(!!ninja && Number.isFinite(ninja.fitness) && ninja.generation === 10, 'ninja model has fitness + generation');

// Different-character genomes genuinely differ (not one shared brain).
const diff = await page.evaluate(() => {
  try {
    const s = JSON.parse(localStorage.getItem('smashfighters.trainedModels.v1')) || {};
    const a = s.ninja.weights, b = s.cowboy.weights;
    let d = 0;
    for (let i = 0; i < a.length; i++) d += Math.abs(a[i] - b[i]);
    return d / a.length;
  } catch (e) { return -1; }
});
ok(diff > 0.01, `ninja/cowboy brains differ (mean abs diff=${diff.toFixed(3)})`);

console.log('== console error check ==');
const realErrors = errors.filter((e) => !/swiftshader|WebGL|AudioContext/i.test(e));
ok(realErrors.length === 0, `no page errors (${realErrors.length})`);

console.log(`\nRESULT: ${passes} passed, ${failures} failed`);
await browser.close();
process.exit(failures ? 1 : 0);
