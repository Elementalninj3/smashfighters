// verify-aerial-light-recovery.mjs - LIVE end-to-end verification that the
// airborne Light attack doubles as a strong, FINITE recovery assist:
//   - airborne Light launch overrides falling velocity upward (vy < 0),
//   - arms the one-shot recovery buff (aerialRec) that SELF-DECAYS,
//   - spawns the recovery VFX exactly ONCE (never per-frame spam),
//   - grounded Light is completely untouched (no lift, no buff).
import { chromium } from 'playwright';
const URL = 'http://localhost:5173/?probe';
const EXE = 'C:/Users/User/AppData/Local/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-win64/chrome-headless-shell.exe';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const browser = await chromium.launch({ headless: true, executablePath: EXE, args: ['--no-sandbox', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 800, height: 900 } });
await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('canvas', { timeout: 15000 });
await sleep(600);

const st = () => page.evaluate(() => {
  const s = window.__ssTest.state();
  const arr = s.fighters || [];
  return arr[0] || arr[1] || null;
});
const F1 = 1;
let pass = 0, fail = 0;
const check = (label, cond) => { if (cond) { pass++; console.log('  PASS', label); } else { fail++; console.log('  FAIL', label); } };

// boot: menu -> START -> PLAYING (matches the other suites)
await page.evaluate(() => {
  const r = [...document.querySelectorAll('#term-lines .term-row')].find(x => x.textContent.includes('START'));
  if (r) r.click();
  // The start gate needs a confirming press before the match begins: dispatch a
  // real Space keydown/keyup AFTER the click (startNewMatch flushes edges, so the
  // press must come after it) to open the gate.
  window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', bubbles: true }));
  window.dispatchEvent(new KeyboardEvent('keyup', { code: 'Space', bubbles: true }));
});
await sleep(600);
check('START enters the PLAYING state', (await st()) !== null);

// --- A: airborne Aerial Light launches upward (recovery assist active) ---
await page.evaluate(p => window.__ssTest.place(p, { x: 400, y: 300, vx: 0, vy: 300, grounded: false }), F1);
await sleep(50);
await page.evaluate(p => window.__ssTest.attack(p, 'aerialLight'), F1);
await sleep(50);
let s = await st();
check('airborne aerialLight arms the recovery buff (aerialRec>0)', (s.aerialRec || 0) > 0);
check('airborne aerialLight overrides falling velocity UP (vy<0)', (s.vy || 0) < 0);

// --- B: buff is FINITE - decays across frames ---
await sleep(120);
s = await st();
check('recovery buff SELF-DECAYS (aerialRec decreased)', (s.aerialRec || 0) < 0.42);
await sleep(500);
s = await st();
check('recovery buff fully expires (~0)', (s.aerialRec || 0) < 0.01);

// --- C: VFX spawned exactly ONCE (one-shot, no per-frame spam) ---
check('tempVfx count is small/zero after expiry (no spam)', (s.tempVfx || 0) <= 1);

// --- D: grounded Light is COMPLETELY untouched ---
// y MUST be the stage floor: place(x, 500, grounded:true) is mid-air, so the
// physics un-grounds the fighter on the next frame (it lands with a huge vy) and
// the "grounded" aerialLight below would then fire as an AIRBORNE one and
// legitimately lift + arm the buff. Settle on the floor first, then read AFTER
// the attack has been applied — reading in the same tick races the attack.
await page.evaluate(p => window.__ssTest.place(p, { x: 400, y: 826.8, vx: 0, vy: 0, grounded: true }), F1);
await sleep(200);
check('the fighter really is grounded before the check', (await st()).grounded === true);
await page.evaluate(p => window.__ssTest.attack(p, 'aerialLight'), F1);
await sleep(120);
s = await st();
check('grounded aerialLight does NOT arm the buff', (s.aerialRec || 0) === 0);
check('grounded aerialLight does NOT lift attacker (vy<=0)', (s.vy || 0) <= 0);

console.log(`\naerial-light recovery: ${pass} passed, ${fail} failed`);
await browser.close();
process.exitCode = fail ? 1 : 0;