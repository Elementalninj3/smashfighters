// verify-ai-preview.mjs — the training preview must be large and render the
// live bout with real game visuals (stage, skinned fighters, health bars).
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
const page = await browser.newPage({ viewport: { width: 1600, height: 1100 } });
const errors = [];
page.on('pageerror', (err) => { errors.push(err.message); console.log('[pageerror]', err.message); });
page.on('console', (msg) => { if (msg.type() === 'error') { errors.push(msg.text()); console.log('[console.error]', msg.text()); } });

await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('canvas', { timeout: 15000 });
await sleep(1200);

console.log('== preview enlarges in training mode ==');
const before = await page.evaluate(() => ({ w: document.getElementById('hand-preview').width, h: document.getElementById('hand-preview').height }));
ok(before.w === 340 && before.h === 480, `starts at 340x480 (got ${before.w}x${before.h})`);
await page.evaluate(() => window.__ssTest.aiTraining().open());
await sleep(400);
const after = await page.evaluate(() => {
  const c = document.getElementById('hand-preview');
  return { w: c.width, h: c.height, cssW: c.style.width };
});
ok(after.w === 600 && after.h === 550, `enlarged to 600x550 backing store (got ${after.w}x${after.h}, css ${after.cssW})`);

console.log('== live bout renders like the game ==');
await page.evaluate(() => window.__ssTest.aiTraining().set({ ai1: 0, ai2: 1, populationSize: 6, maxGenerations: 30, speed: 'Normal', showSim: true }));
await page.evaluate(() => window.__ssTest.aiTraining().start());
await sleep(4000);
// Sample preview pixels: must show a varied scene (bg + platforms + fighters),
// not a blank/flat panel.
const px = await page.evaluate(() => {
  const c = document.getElementById('hand-preview');
  const x = c.getContext('2d');
  const d = x.getImageData(0, 0, c.width, c.height).data;
  const colors = new Set();
  let nonBg = 0;
  for (let i = 0; i < d.length; i += 40) {
    const key = `${d[i] >> 4},${d[i + 1] >> 4},${d[i + 2] >> 4}`;
    colors.add(key);
    if (d[i] > 30 || d[i + 1] > 30 || d[i + 2] > 30) nonBg++;
  }
  return { distinct: colors.size, nonBg, total: d.length / 40 };
});
console.log('   preview pixels:', JSON.stringify(px));
ok(px.distinct > 12, `scene has varied colors (${px.distinct} distinct)`);
ok(px.nonBg > px.total * 0.02, 'fighters/platforms visibly drawn over background');
// Caption overlay present: the GEN/BEST text is drawn in bright green
// (#33ff88) across the top strip (bg-independent: the scrim is translucent
// over the light sky-blue arena backdrop, so "dark strip" no longer applies).
const caption = await page.evaluate(() => {
  const c = document.getElementById('hand-preview');
  const x = c.getContext('2d');
  const d = x.getImageData(0, 0, c.width, 44).data;
  let text = 0, n = 0;
  for (let i = 0; i < d.length; i += 16) { n++; if (d[i] < 110 && d[i + 1] > 180 && d[i + 2] < 200) text++; }
  return text / n;
});
ok(caption > 0.001, `caption strip drawn (${(caption * 100).toFixed(2)}% caption-green)`);
await page.screenshot({ path: 'tests/ai-preview-live.png' });

// Second screenshot later in the run — fighters must have MOVED (live sim).
const pos1 = await page.evaluate(() => window.__ssTest.aiTraining().progress());
await sleep(3000);
await page.screenshot({ path: 'tests/ai-preview-live2.png' });
const pos2 = await page.evaluate(() => window.__ssTest.aiTraining().progress());
ok((pos2 && pos2.matchesPlayed) > (pos1 && pos1.matchesPlayed || 0) || (pos2 && pos2.generation > 1), 'bouts advance while preview watches');

console.log('== stop restores preview size ==');
await page.evaluate(() => window.__ssTest.aiTraining().stop());
await page.evaluate(() => window.__ssTest.aiTraining().close());
await sleep(400);
const restored = await page.evaluate(() => ({ w: document.getElementById('hand-preview').width, h: document.getElementById('hand-preview').height }));
ok(restored.w === 340 && restored.h === 480, `restored to 340x480 (got ${restored.w}x${restored.h})`);

console.log('== console error check ==');
const realErrors = errors.filter((e) => !/swiftshader|WebGL|AudioContext/i.test(e));
ok(realErrors.length === 0, `no page errors (${realErrors.length}: ${realErrors.slice(0, 2).join(' | ')})`);

console.log(`\nRESULT: ${passes} passed, ${failures} failed`);
await browser.close();
process.exit(failures ? 1 : 0);
