import { chromium } from 'playwright';
const EXE = 'C:/Users/User/AppData/Local/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-win64/chrome-headless-shell.exe';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const b = await chromium.launch({ headless: true, executablePath: EXE, args: ['--no-sandbox', '--enable-unsafe-swiftshader'] });
const page = await b.newPage({ viewport: { width: 900, height: 940 } });
page.on('pageerror', e => console.log('[pageerror]', e.message));
await page.goto('http://localhost:5173/?probe', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('canvas');
await sleep(1000);
const state = () => page.evaluate(() => window.__ssTest.state());
const place = (pn, p) => page.evaluate(([n, q]) => window.__ssTest.place(n, q), [pn, p]);
await page.evaluate(() => {
  const r = [...document.querySelectorAll('#term-lines .term-row')].find(x => x.textContent.includes('START'));
  if (r) r.click();
  window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', bubbles: true }));
  window.dispatchEvent(new KeyboardEvent('keyup', { code: 'Space', bubbles: true }));
});
await sleep(500);
// put P1 on the floating platform area first (simulate repeated-section end state)
await place(1, { x: 615, y: 687, grounded: false, vx: 0, vy: 0, percent: 0, hitstun: 0, invulnTimer: 0, facingRight: true });
await sleep(300);
let s = await state();
console.log('after platform place:', s.fighters[0].x.toFixed(0), s.fighters[0].y.toFixed(0));
// now the suite placement
await place(1, { x: 620, y: 820, grounded: false, vx: 0, vy: 0, percent: 0, hitstun: 0, invulnTimer: 0, facingRight: true });
const r = await place(1, { x: 620, y: 820, grounded: false, vx: 0, vy: 0, percent: 0, hitstun: 0, invulnTimer: 0, facingRight: true });
s = await state();
console.log('place returned:', r, 'pos now:', s.fighters[0].x.toFixed(0), s.fighters[0].y.toFixed(0));
await sleep(500);
s = await state();
console.log('pos +500ms:', s.fighters[0].x.toFixed(0), s.fighters[0].y.toFixed(0), 'grounded:', s.fighters[0].grounded);
await b.close();
