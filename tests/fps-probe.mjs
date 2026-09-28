// fps-probe.mjs — measures in-match frame rate, sim speed, and the exact time
// the cowboy Down Smash horse appears, to diagnose timing-sensitive failures.
import { chromium } from 'playwright';

const URL = 'http://localhost:5173/?probe';
const EXE = 'C:/Users/User/AppData/Local/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-win64/chrome-headless-shell.exe';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const browser = await chromium.launch({ headless: true, executablePath: EXE, args: ['--no-sandbox', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 800, height: 940 } });
page.on('pageerror', e => console.log('[pageerror]', e.message));

const measure = () => page.evaluate(() => new Promise(res => {
  let frames = 0;
  const t0 = performance.now();
  function tick() {
    frames++;
    if (performance.now() - t0 < 2000) requestAnimationFrame(tick);
    else res(+(frames / ((performance.now() - t0) / 1000)).toFixed(1));
  }
  requestAnimationFrame(tick);
}));

await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('canvas', { timeout: 20000 });
await sleep(1200);

console.log('FPS in menu:', await measure());

// Start the match exactly like verify-combat does.
await page.evaluate(() => {
  const r = [...document.querySelectorAll('#term-lines .term-row')].find(x => x.textContent.includes('START'));
  if (r) r.click();
  window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', bubbles: true }));
  window.dispatchEvent(new KeyboardEvent('keyup', { code: 'Space', bubbles: true }));
});
await sleep(600);

console.log('FPS in match (idle):', await measure());

const gp = (x) => ({ x, y: 826.8, grounded: true, vx: 0, vy: 0, percent: 0, hitstun: 0, invulnTimer: 0, facingRight: true });
await page.evaluate(([p]) => window.__ssTest.place(1, p), [gp(300)]);
await page.evaluate(([p]) => window.__ssTest.place(2, p), [gp(700)]);

// Fire dsmash, poll for the horse with timestamps + worldFx state.
const t0 = Date.now();
await page.evaluate(() => window.__ssTest.attack(1, 'dsmash', { down: true }));
let appeared = null;
let lastFx = null;
while (Date.now() - t0 < 2500) {
  const snap = await page.evaluate(() => ({
    h: window.__ssTest.horse(1),
    fx: window.__ssTest.worldFx(),
    atk: (window.__ssTest.state().fighters[0] || {}).atk || null,
  }));
  lastFx = snap.fx;
  if (snap.h) { appeared = Date.now() - t0; console.log('horse appeared at +', appeared, 'ms; fx=', JSON.stringify(snap.fx)); break; }
  await sleep(20);
}
if (!appeared) console.log('horse NEVER appeared within 2500ms; last fx=', JSON.stringify(lastFx));

console.log('FPS during ride:', await measure());
console.log('worldFx now:', JSON.stringify(await page.evaluate(() => window.__ssTest.worldFx())));

// Wait for despawn, then report.
await sleep(2000);
const h = await page.evaluate(() => window.__ssTest.horse(1));
console.log('horse after 2s more:', h ? 'STILL PRESENT' : 'gone');

await browser.close();
