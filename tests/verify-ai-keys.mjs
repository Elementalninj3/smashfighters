// verify-ai-keys.mjs — keyboard-only drive of the AI Training submenu:
// navigate to AI TRAINING, open with Enter, cycle values, start/stop training.
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
const rows = () => page.evaluate(() => [...document.querySelectorAll('#term-lines .term-row')].map((r) => r.textContent));
const cursor = () => page.evaluate(() => [...document.querySelectorAll('#term-lines .term-row')].findIndex((r) => r.classList.contains('on')));

await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('canvas', { timeout: 15000 });
await sleep(1000);

// Walk down to the AI TRAINING row and open it with Enter.
// (Main menu order: player, opponent, skins, accys, handGear, anim, hit,
// sandbox, settings, mode, aiDifficulty, stocks, aiTraining, start.)
for (let i = 0; i < 12; i++) { await page.keyboard.press('ArrowDown'); await sleep(50); }
ok((await cursor()) === 12, 'keyboard reaches AI TRAINING row');
await page.keyboard.press('Enter');
await sleep(300);
let r = await rows();
ok(r.some((x) => x.includes('AI 1 CHARACTER')), 'Enter opens AI Training submenu');

// Setup view rows: VIEW, AI 1, AI 2, MODE, OPP, STARTMODE, OPDIFF, POP(8),
// GENS(9), ... — move to AI 1, then cycle right (Cowboy -> Ninja).
await page.keyboard.press('ArrowDown'); // VIEW -> AI 1
await sleep(150);
await page.keyboard.press('ArrowRight');
await sleep(200);
r = await rows();
const ai1 = r.find((x) => x.includes('AI 1 CHARACTER'));
ok(ai1 && ai1.includes('Ninja'), `AI 1 cycles to Ninja (${(ai1 || '').trim()})`);

// Jump to POPULATION (digit 8), shrink it, set gens via digit 9.
await page.keyboard.press('Digit8');
await sleep(150);
// DOM index runs +1 (header row precedes the value rows).
ok((await cursor()) === 8, 'Digit8 jumps to POPULATION SIZE');
await page.keyboard.press('ArrowLeft'); // 50 -> 30
await sleep(150);
await page.keyboard.press('ArrowLeft'); // 30 -> 20
await sleep(150);
r = await rows();
ok(r.some((x) => x.includes('POPULATION SIZE') && x.includes('20')), 'population cycles down to 20');

// Generations: digit 9 -> cycle left twice (250 -> 100 -> 50).
await page.keyboard.press('Digit9');
await sleep(150);
ok((await cursor()) === 9, 'Digit9 jumps to MAX GENERATIONS');
await page.keyboard.press('ArrowLeft');
await sleep(150);
await page.keyboard.press('ArrowLeft');
await sleep(150);
r = await rows();
ok(r.some((x) => x.includes('MAX GENERATIONS') && x.includes('50')), 'generations cycle down to 50');

// Override to a tiny run via probe set (keyboard already proven), start via keyboard.
await page.evaluate(() => window.__ssTest.aiTraining().set({ populationSize: 4, maxGenerations: 2, speed: 'Fastest' }));
// TOGGLE row is index 13: walk down from gens (8) with arrows.
for (let i = 0; i < 5; i++) { await page.keyboard.press('ArrowDown'); await sleep(80); }
ok((await cursor()) === 14, 'arrows reach START TRAINING');
await page.keyboard.press('Enter');
await sleep(600);
let running = await page.evaluate(() => window.__ssTest.aiTraining().running());
const early = await page.evaluate(() => window.__ssTest.aiTraining().progress());
ok(running || (early && early.matchesPlayed > 0), 'keyboard starts training');
let prog = null, waited = 0;
while (waited < 120000) {
  await sleep(1500); waited += 1500;
  prog = await page.evaluate(() => window.__ssTest.aiTraining().progress());
  if (prog && !prog.running) break;
}
ok(prog && !prog.running && prog.generation === 2, `keyboard-started run completes 2 gens (got ${prog && prog.generation})`);

// ESC returns to main menu.
await page.keyboard.press('Escape');
await sleep(300);
r = await rows();
ok(r.some((x) => x.includes('START MATCH')), 'ESC backs out to main menu');

const realErrors = errors.filter((e) => !/swiftshader|WebGL|AudioContext/i.test(e));
ok(realErrors.length === 0, `no page errors (${realErrors.length})`);
console.log(`\nRESULT: ${passes} passed, ${failures} failed`);
await browser.close();
process.exit(failures ? 1 : 0);
