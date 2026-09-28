// verify-camera-start.mjs — match starts at final gameplay zoom: no startup
// zoom animation, dynamic tracking preserved, restart stays correct.
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
const cam = () => page.evaluate(() => window.__ssTest.camera());
const startMatch = () => page.evaluate(() => {
  const row = [...document.querySelectorAll('#term-lines .term-row')].find((x) => x.textContent.includes('START MATCH'));
  if (row) row.click();
  // The start gate needs a confirming press before the match begins: dispatch a
  // real Space keydown/keyup AFTER the click (startNewMatch flushes edges, so the
  // press must come after it) to open the gate.
  window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', bubbles: true }));
  window.dispatchEvent(new KeyboardEvent('keyup', { code: 'Space', bubbles: true }));
  return !!row;
});

await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('canvas', { timeout: 15000 });
await sleep(1200);
await page.evaluate(() => window.__ssTest.setMode('playerVsPlayer'));

console.log('== frame-1 zoom equals settled zoom (no startup animation) ==');
await startMatch();
await sleep(120); // first gameplay frames, fighters untouched at spawn
const z0 = await cam();
console.log('   frame-1:', JSON.stringify(z0));
// Spawn spread: x 420/780 (360px) → want = min(1200/520, 1100/160) = 2.0 clamp;
// composed = 1*1*1*2.0*1.15 = 2.3.
ok(Math.abs(z0.zoom - 2.3) < 0.05, `frame-1 zoom is final gameplay zoom (${z0.zoom.toFixed(3)} ≈ 2.3)`);
await page.screenshot({ path: 'tests/cam-frame1.png' });
await sleep(3000); // fighters idle at spawn: spread constant, zoom must not drift
const z1 = await cam();
console.log('   +3s idle:', JSON.stringify(z1));
await page.screenshot({ path: 'tests/cam-settled.png' });
ok(Math.abs(z1.zoom - z0.zoom) < 0.03, `no zoom drift over 3 idle seconds (${z0.zoom.toFixed(3)} → ${z1.zoom.toFixed(3)})`);
ok(Math.abs((z1.trackZoom || 0) - 2.0) < 0.05, `track zoom settled at formation value (${(z1.trackZoom || 0).toFixed(3)})`);

console.log('== dynamic zoom still works ==');
await page.evaluate(() => { window.__ssTest.place(1, { x: 250, y: 820 }); window.__ssTest.place(2, { x: 950, y: 820 }); });
await sleep(2500);
const zFar = await cam();
console.log('   far apart:', JSON.stringify(zFar));
ok(zFar.zoom < z1.zoom - 0.15, `zooms out when apart (${z1.zoom.toFixed(3)} → ${zFar.zoom.toFixed(3)})`);
await page.evaluate(() => { window.__ssTest.place(1, { x: 550, y: 820 }); window.__ssTest.place(2, { x: 650, y: 820 }); });
await sleep(2500);
const zNear = await cam();
console.log('   close:', JSON.stringify(zNear));
ok(zNear.zoom > zFar.zoom + 0.15, `zooms back in when close (${zFar.zoom.toFixed(3)} → ${zNear.zoom.toFixed(3)})`);

console.log('== restart starts at final zoom too ==');
await page.keyboard.press('KeyM');
await sleep(500);
await startMatch();
await sleep(150);
const zR = await cam();
ok(Math.abs(zR.zoom - 2.3) < 0.05, `restarted match opens at final zoom (${zR.zoom.toFixed(3)})`);
await sleep(2000);
const zR2 = await cam();
ok(Math.abs(zR2.zoom - zR.zoom) < 0.03, `no drift after restart (${zR.zoom.toFixed(3)} → ${zR2.zoom.toFixed(3)})`);

console.log('== console ==');
const realErrors = errors.filter((e) => !/swiftshader|WebGL|AudioContext/i.test(e));
ok(realErrors.length === 0, `no page errors (${realErrors.length}: ${realErrors.slice(0, 2).join(' | ')})`);

console.log(`\nRESULT: ${passes} passed, ${failures} failed`);
await browser.close();
process.exit(failures ? 1 : 0);
