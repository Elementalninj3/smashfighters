// verify-hitbox-customizer.mjs — runtime verification of the Hitbox
// Customizer's INPUT HANDLING, driving the REAL dev page (:5173 with ?probe)
// through the in-browser probe and real pointer events on the live canvas.
//
//   A. A held +/- button repeats while held, and STOPS the instant the button
//      is released. The repeat chain used to be started by kickStep() and never
//      stopped: hcOnPointerUp cleared the ANIMATOR's hold (a different, equally
//      named function with no effect here) while the customizer's own
//      hcClearStepHold() was dead code — so after one click on "+", W/H (or any
//      row) climbed forever with no button held.
//
// Run: node verify-hitbox-customizer.mjs   (dev server :5173, probe on)

import { chromium } from 'playwright';

const URL = 'http://localhost:5173/?probe';
const EXE  = 'C:/Users/User/AppData/Local/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-win64/chrome-headless-shell.exe';

let passes = 0, failures = 0;
function ok(cond, msg) {
  if (cond) { passes++; console.log('  PASS  ' + msg); }
  else { failures++; console.log('  FAIL  ' + msg); }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const browser = await chromium.launch({ headless: true, executablePath: EXE, args: ['--no-sandbox', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1400, height: 940 } });
page.on('pageerror', e => console.log('[pageerror]', e.message));

const ui = () => page.evaluate(() => window.__ssTest ? window.__ssTest.customizerUi() : null);
const boxes = () => page.evaluate(() => window.__ssTest ? window.__ssTest.customizerBoxes() : null);
const move = (k) => page.evaluate(kk => window.__ssTest.customizerMove(kk), k);
const openIt = () => page.evaluate(() => window.__ssTest.customizerOpen(true));
const closeIt = () => page.evaluate(() => window.__ssTest.customizerOpen(false));

await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('canvas', { timeout: 20000 });
await sleep(1200);

// The panel's regions are produced by its own render pass, which only runs in
// the playing loop — so get into a match first.
await page.evaluate(() => {
  const r = [...document.querySelectorAll('#term-lines .term-row')].find(x => x.textContent.includes('START'));
  if (r) r.click();
  window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', bubbles: true }));
  window.dispatchEvent(new KeyboardEvent('keyup', { code: 'Space', bubbles: true }));
});
await sleep(600);

await openIt();
await sleep(500);
{
  const ids = ((await ui()).hits || []).map(h => h.id);
  console.log('   panel regions:', JSON.stringify(ids));
}

console.log('== the +/- steppers stop when the button is released ==');
for (const [key, field] of [['nr-w-p', 'w'], ['nr-h-p', 'h']]) {
  await move('jab');
  await sleep(200);
  const uiState = await ui();
  const hit = (uiState.hits || []).find(h => h.id === key);
  ok(!!hit, `${field}: the "+" button exists on the live panel (id=${key})`);
  if (!hit) continue;

  const startVal = (await boxes())[0][field];
  const cx = hit.x + hit.w / 2, cy = hit.y + hit.h / 2;

  // Press and HOLD past the repeat delay — the value must climb while held.
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await sleep(700);
  const heldVal = (await boxes())[0][field];
  ok(heldVal > startVal, `${field}: holds auto-increment while the button is down (${startVal} -> ${heldVal})`);

  // Release — the repeat must stop dead. This is the regression.
  await page.mouse.up();
  await sleep(120);
  const afterRelease = (await boxes())[0][field];
  await sleep(900);
  const later = (await boxes())[0][field];
  ok(later === afterRelease,
    `${field}: STOPS incrementing after release (${afterRelease} -> ${later} over 900ms)`);
}

console.log('== a stray pointerup (press started elsewhere) also stops the hold ==');
{
  await move('jab');
  await sleep(150);
  const hit = (await ui()).hits.find(h => h.id === 'nr-w-p');
  if (hit) {
    const cx = hit.x + hit.w / 2, cy = hit.y + hit.h / 2;
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await sleep(600);
    // Release OUTSIDE the button rect, so the release cannot be mistaken for a
    // normal in-button click.
    await page.mouse.move(cx, cy - 400);
    await page.mouse.up();
    await sleep(120);
    const a = (await boxes())[0].w;
    await sleep(900);
    const b = (await boxes())[0].w;
    ok(b === a, `a release away from the button still stops the hold (${a} -> ${b})`);
  }
}

console.log('== closing the panel mid-hold stops the repeat ==');
{
  await move('jab');
  await sleep(150);
  const hit = (await ui()).hits.find(h => h.id === 'nr-h-p');
  if (hit) {
    await page.mouse.move(hit.x + hit.w / 2, hit.y + hit.h / 2);
    await page.mouse.down();
    await sleep(600);
    await page.mouse.up();
    await closeIt();
    await sleep(900);
    await openIt();
    await sleep(300);
    const v1 = (await boxes())[0].h;
    await sleep(900);
    const v2 = (await boxes())[0].h;
    ok(v1 === v2, `the repeat is not left running after close/reopen (${v1} -> ${v2})`);
  }
}

await closeIt();
console.log(`\n== summary ==\n${passes} passed, ${failures} failed`);
await browser.close();
process.exit(failures ? 1 : 0);