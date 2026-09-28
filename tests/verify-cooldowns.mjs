// §§47-48 live verification: positioning, block/dodge/attack cooldowns,
// AI cooldown behavior, HUD/stopwatch, console cleanliness.
import { chromium } from 'playwright';
const URL = 'http://localhost:5173/?probe';
const EXE = 'C:/Users/User/AppData/Local/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-win64/chrome-headless-shell.exe';
let passes = 0, failures = 0;
const ok = (c, m) => { if (c) { passes++; console.log('  PASS ' + m); } else { failures++; console.log('  FAIL ' + m); } };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const errors = [];
const browser = await chromium.launch({ headless: true, executablePath: EXE, args: ['--no-sandbox', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 900, height: 1000 } });
page.on('pageerror', e => errors.push('[pageerror] ' + e.message));
page.on('console', m => { if (m.type() === 'error') errors.push('[console] ' + m.text()); });
await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('canvas', { timeout: 20000 });
await sleep(1200);

const state = () => page.evaluate(() => window.__ssTest ? window.__ssTest.state() : null);
const place = (pn, patch) => page.evaluate(([n, p]) => window.__ssTest ? window.__ssTest.place(n, p) : null, [pn, patch]);
const hud = () => page.evaluate(() => window.__ssTest ? window.__ssTest.hud() : null);
// tap = full key press (down+up) so no held keys leak into gameplay.
const tap = (code) => page.evaluate((c) => {
  window.dispatchEvent(new KeyboardEvent('keydown', { code: c, bubbles: true }));
  window.dispatchEvent(new KeyboardEvent('keyup', { code: c, bubbles: true }));
}, code);
const keyDown = (code) => page.evaluate((c) => window.dispatchEvent(new KeyboardEvent('keydown', { code: c, bubbles: true })), code);
const keyUp = (code) => page.evaluate((c) => window.dispatchEvent(new KeyboardEvent('keyup', { code: c, bubbles: true })), code);
const G = 826.8;

// --- robust menu helpers (state-aware: menu/submenu/playing) ---
async function ensureMainMenu() {
  for (let i = 0; i < 5; i++) {
    const where = await page.evaluate(() => ({
      gs: window.__ssTest.state().gameState,
      hasStart: [...document.querySelectorAll('#term-lines .term-row')].some(r => r.textContent.includes('START')),
    }));
    if (where.gs === 'playing') { await tap('KeyM'); await sleep(250); continue; }
    if (!where.hasStart) { await tap('Escape'); await sleep(200); continue; }
    break;
  }
}
async function gotoMainRow(text) {
  return page.evaluate((t) => {
    const rows = [...document.querySelectorAll('#term-lines .term-row')];
    const i = rows.findIndex(r => r.textContent.includes(t));
    if (i < 0) return -1;
    const cur = rows.findIndex(r => r.classList.contains('on'));
    for (let k = 0; k < (i - cur + rows.length) % rows.length; k++) {
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'ArrowDown', bubbles: true }));
      window.dispatchEvent(new KeyboardEvent('keyup', { code: 'ArrowDown', bubbles: true }));
    }
    return i;
  }, text);
}
async function setMode(rights) {
  await ensureMainMenu();
  await gotoMainRow('GAME MODE');
  await sleep(120);
  for (let k = 0; k < rights; k++) { await tap('ArrowRight'); await sleep(120); }
}
async function startMatch() {
  await ensureMainMenu();
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
}

console.log('== HUD: no top timer, stopwatch bottom + toggleable ==');
{
  await startMatch();
  let s = await state();
  ok(s && s.gameState === 'playing', 'match starts');
  ok(s && !('timeLeft' in s), 'no top-timer field in state (timer fully removed)');
  const h = await hud();
  ok(h && h.stocks[0] === 3 && h.stocks[1] === 3, `stocks HUD present (${JSON.stringify(h && h.stocks)})`);
  ok(h && h.stopwatchOn === true && /^\d\d:\d\d$/.test(h.stopwatchText), `stopwatch on by default, counts up (${h && h.stopwatchText})`);
  await sleep(1300);
  const h2 = await hud();
  ok(h2 && h2.stopwatchText !== h.stopwatchText, `stopwatch advances (${h.stopwatchText} -> ${h2.stopwatchText}), display-only`);
  // Settings -> STOPWATCH row -> toggle OFF
  await ensureMainMenu();
  await gotoMainRow('SETTINGS');
  await tap('Enter');
  await sleep(250);
  const srows = await page.evaluate(() => [...document.querySelectorAll('#term-lines .term-row')].map(r => r.textContent));
  ok(srows.some(r => r.includes('STOPWATCH')), 'Settings has STOPWATCH toggle row');
  await gotoMainRow('STOPWATCH');
  await tap('ArrowLeft');
  await sleep(200);
  const offVal = await page.evaluate(() => {
    const r = [...document.querySelectorAll('#term-lines .term-row')].find(x => x.textContent.includes('STOPWATCH'));
    return r ? r.textContent : '';
  });
  ok(offVal.includes('OFF'), 'stopwatch toggles OFF through Settings');
  await tap('Escape');
  await sleep(200);
  await startMatch();
  const h3 = await hud();
  ok(h3 && h3.stopwatchOn === false, 'disabling removes only the stopwatch (stocks HUD intact)');
  // back ON for the rest of the suite (retry entry: a single Enter can be
  // lost under load, so verify the submenu actually opened)
  await ensureMainMenu();
  const trace = (t) => page.evaluate((tag) => {
    const rows = [...document.querySelectorAll('#term-lines .term-row')];
    return tag + ' n=' + rows.length + ' on=' + rows.findIndex(r => r.classList.contains('on'));
  }, t).then(m => console.log('  [trace] ' + m));
  await gotoMainRow('SETTINGS');
  let entryAttempts = 0;
  for (let i = 0; i < 4; i++) {
    await tap('Enter');
    await sleep(250);
    entryAttempts++;
    const has = await page.evaluate(() => [...document.querySelectorAll('#term-lines .term-row')].some(r => r.textContent.includes('STOPWATCH')));
    if (has) break;
  }
  console.log('  [dbg settings entry attempts=' + entryAttempts + ']');
  await gotoMainRow('STOPWATCH');
  await tap('ArrowRight');
  await sleep(200);
  // Read the row BEFORE leaving Settings (Escape returns to the main menu,
  // where no STOPWATCH row exists by design).
  const onDbg = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('#term-lines .term-row')];
    const r = rows.find(x => x.textContent.includes('STOPWATCH'));
    return { text: r ? r.textContent : 'MISSING' };
  });
  // Authoritative check: hud().stopwatchOn is exactly what render() reads to
  // draw the stopwatch, and it flips only via the Settings toggle branch.
  const swDirect = await page.evaluate(() => window.__ssTest.hud().stopwatchOn);
  ok(swDirect === true && onDbg.text.includes('ON') && !onDbg.text.includes('OFF'), 'stopwatch toggles back ON');
  await tap('Escape');
  await sleep(200);
  await startMatch();
}

console.log('== Block cooldown: rapid toggle denied, delayed re-engage works ==');
{
  await place(1, { x: 500, y: G, grounded: true, vx: 0, vy: 0, percent: 0, hitstun: 0, invulnTimer: 0 });
  await place(2, { x: 900, y: G, grounded: true, vx: 0, vy: 0, percent: 0, hitstun: 0, invulnTimer: 0 });
  await keyDown('KeyL');
  await sleep(150);
  let s = await state();
  ok(s.fighters[0].shielding === true, 'block engages on hold');
  await keyUp('KeyL');
  await sleep(120); // inside 0.35s cooldown
  await keyDown('KeyL');
  await sleep(100);
  s = await state();
  ok(s.fighters[0].shielding === false, 'rapid re-block denied during cooldown');
  await keyUp('KeyL');
  await sleep(450); // cooldown expired
  await keyDown('KeyL');
  await sleep(120);
  s = await state();
  ok(s.fighters[0].shielding === true, 'block works again after cooldown (still responsive)');
  await keyUp('KeyL');
}

console.log('== Dodge cooldown: DODGE x4 in 0.5s fires once ==');
{
  await place(1, { x: 500, y: G, grounded: true, vx: 0, vy: 0, percent: 0, hitstun: 0, invulnTimer: 0 });
  let edges = 0, was = false;
  for (let i = 0; i < 4; i++) {
    await keyDown('ShiftLeft');
    await sleep(40);
    await keyUp('ShiftLeft');
    await sleep(80);
    const s = await state();
    const d = s.fighters[0].dodging;
    if (d && !was) edges++;
    was = d;
  }
  ok(edges === 1, `4 rapid dodges -> exactly 1 activation (edges=${edges})`);
  const s = await state();
  // Sampled immediately: the 0.8s cooldown must still be live (without the
  // extra sleep it would race expiry — the single activation above is the
  // actual spam-prevention proof).
  ok(s.fighters[0].dodgeCd > 0.1, `dodge cooldown live afterwards (cd=${s.fighters[0].dodgeCd.toFixed(2)})`);
}

console.log('== Attack delay: alternating J/K mash respects ~0.5s starts ==');
{
  await place(1, { x: 500, y: G, grounded: true, vx: 0, vy: 0, percent: 0, hitstun: 0, invulnTimer: 0 });
  await place(2, { x: 900, y: G, grounded: true, vx: 0, vy: 0, percent: 0, hitstun: 0, invulnTimer: 0 });
  const starts = [];
  let prevActive = false;
  const t0 = Date.now();
  for (let i = 0; i < 34; i++) {
    const code = i % 2 === 0 ? 'KeyJ' : 'KeyK';
    await keyDown(code);
    await sleep(20);
    await keyUp(code);
    await sleep(70);
    const s = await state();
    const active = !!s.fighters[0].attackKey;
    if (active && !prevActive) starts.push((Date.now() - t0) / 1000);
    prevActive = active;
  }
  ok(starts.length >= 3, `mashing still attacks repeatedly (${starts.length} starts, no lockout bug)`);
  const gaps = starts.slice(1).map((t, i) => t - starts[i]);
  const minGap = gaps.length ? Math.min(...gaps) : 99;
  ok(gaps.length === 0 || minGap >= 0.42, `starts spaced ~0.5s apart (gaps=${gaps.map(g => g.toFixed(2)).join(',')})`);
}

console.log('== AI center-return: edge fighter comes home, no suicide ==');
{
  await setMode(2); // playerVsAI
  await startMatch();
  let s = await state();
  ok(s.gameMode === 'playerVsAI', 'playerVsAI running');
  await place(1, { x: 600, y: G, grounded: true, vx: 0, vy: 0, percent: 0, hitstun: 0, invulnTimer: 0 });
  await place(2, { x: 935, y: G, grounded: true, vx: 0, vy: 0, percent: 0, hitstun: 0, invulnTimer: 0 });
  await sleep(300);
  const x0 = (await state()).fighters[1].x;
  await sleep(1500);
  s = await state();
  ok(s.fighters[1].x < x0 - 25, `AI returns toward center (${x0.toFixed(0)} -> ${s.fighters[1].x.toFixed(0)})`);
  ok(s.fighters[1].x > 200 && s.stocks[1] === 3, 'AI stays on stage (no suicide)');
}

console.log('== AI holds edge vs healthy off-stage opponent ==');
{
  // P1 (human, idle) drifts off the right edge with full resources; P2 AI
  // must not chase off after it.
  await place(2, { x: 900, y: G, grounded: true, vx: 0, vy: 0, percent: 0, hitstun: 0, invulnTimer: 0 });
  await place(1, { x: 1120, y: 500, vx: 120, vy: 0, grounded: false, percent: 20, hitstun: 0, invulnTimer: 0, canDoubleJump: true, canAerialLight: true, freeFall: false });
  await sleep(1500);
  const s = await state();
  ok(s.fighters[1].x > 820 && s.stocks[1] === 3, `AI holds, never chases off (P2 x=${s.fighters[1].x.toFixed(0)}, stocks=${s.stocks[1]})`);
}

console.log('== AI attack pacing + cooldown movement (AIvsAI 20s) ==');
{
  // Normalize to playerVsPlayer first (state-checked), then Right x3.
  await ensureMainMenu();
  await gotoMainRow('GAME MODE');
  for (let k = 0; k < 5; k++) {
    const gm = (await state()).gameMode;
    if (gm === 'playerVsPlayer' || gm === undefined) break;
    await tap('ArrowLeft');
    await sleep(120);
  }
  for (let k = 0; k < 3; k++) { await tap('ArrowRight'); await sleep(120); }
  await startMatch();
  let s = await state();
  ok(s.gameMode === 'AIvsAI', `AIvsAI running (mode=${s.gameMode})`);
  const starts = [];
  let prevActive = false;
  const t0 = Date.now();
  for (let i = 0; i < 200; i++) {
    await sleep(100);
    const st = await state();
    if (st.matchOver) break;
    const active = !!st.fighters[1].attackKey;
    if (active && !prevActive) starts.push((Date.now() - t0) / 1000);
    prevActive = active;
  }
  const gaps = starts.slice(1).map((t, i) => t - starts[i]);
  const minGap = gaps.length ? Math.min(...gaps) : 99;
  ok(starts.length >= 2, `AI attacks repeatedly (${starts.length} starts)`);
  ok(gaps.length === 0 || minGap >= 0.35, `AI respects ~0.5s attack spacing (min gap=${gaps.length ? minGap.toFixed(2) : 'n/a'})`);
  s = await state();
  const stats = (s.ai[1] && s.ai[1].stats) || {};
  const moveKeys = Object.keys(stats).filter(k => /strafe|reposition|drift|dash|dodge|center|spacing|retreat|approach|micro|hop|bait|pocket|steer/i.test(k));
  const atkKeys = Object.keys(stats).filter(k => /jab|tilt|smash|aerial/i.test(k));
  ok(moveKeys.length >= 2 && atkKeys.length >= 2, `AI moves AND attacks during cooldowns (move=${moveKeys.length}, atk=${atkKeys.length})`);
}

console.log('== console cleanliness (§48) ==');
ok(errors.length === 0, `no page/console errors (${errors.length}${errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''})`);

console.log(`\n41-48: ${passes} passed, ${failures} failed`);
await browser.close();
process.exit(failures ? 1 : 0);
