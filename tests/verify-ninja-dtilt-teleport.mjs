// verify-ninja-dtilt-teleport.mjs — regression for the REAL-game bug where the
// ninja's Down Light (Teleport Strike) "did not activate" at all.
//
// The move only warps because ninjaDtilt routes to ABILITIES.ninjaDtilt. That
// routing is declared in TWO places, on purpose:
//
//   1. the ninjaDtilt animation's `combat` payload (the normal source), and
//   2. the ninja attack table's `dtilt` row (abilityType/abilityId).
//
// A saved animation store (localStorage: smashfighters.animlib.v3) REPLACES a
// built-in animation WHOLESALE, so any profile that stored ninjaDtilt before the
// move existed loads an animation with `combat: null` — no ability, no warp, the
// move is just a sweep. Same failure mode the cowboy's Side Smash had, which is
// why the table designation exists and is authoritative (see resolveAnimDef).
//
// A fresh headless context has an EMPTY store, so the ordinary suites can never
// see this. This suite seeds a combat-less ninjaDtilt before boot — exactly what
// an old animator save leaves behind — and then proves Down Light STILL warps
// behind the opponent and still strikes.
//
// Run: node verify-ninja-dtilt-teleport.mjs   (dev server :5173, probe on)

import { chromium } from 'playwright';

const URL = 'http://localhost:5173/?probe';
const EXE = 'C:/Users/User/AppData/Local/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-win64/chrome-headless-shell.exe';

let passes = 0, failures = 0;
function ok(cond, msg) {
  if (cond) { passes++; console.log('  PASS  ' + msg); }
  else { failures++; console.log('  FAIL  ' + msg); }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const browser = await chromium.launch({ headless: true, executablePath: EXE, args: ['--no-sandbox', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 900, height: 940 } });
const errors = [];
page.on('pageerror', e => { errors.push(e.message); console.log('[pageerror]', e.message); });
page.on('console', m => { if (m.type() === 'error') { errors.push(m.text()); console.log('[console.error]', m.text()); } });

// A saved 'ninjaDtilt' WITH keyframes but NO combat payload — the exact shape an
// old/partial animator save leaves behind, and the shape that silently turned
// Down Light back into a plain sweep.
const bareNinjaDtilt = {
  id: 'ninjaDtilt', name: 'Low Sweep', fps: 60, loop: false, mirror: true, blendIn: 1,
  weapons: { right: { id: 'ninjaSword', mountX: 0, mountY: -2 }, left: null },
  combat: null,
  vfx: [],
  tracks: { 'hands.right.x': { keyframes: [{ f: 0, v: 20, e: 'linear' }] } },
};

await page.addInitScript((anim) => {
  const key = 'smashfighters.animlib.v3';
  let store = [];
  try {
    const raw = localStorage.getItem(key);
    if (raw) store = JSON.parse(raw);
  } catch (_) {}
  const idx = store.findIndex(a => a && a.id === 'ninjaDtilt');
  if (idx >= 0) store[idx] = anim; else store.push(anim);
  localStorage.setItem(key, JSON.stringify(store));
}, bareNinjaDtilt);

const state = () => page.evaluate(() => window.__ssTest ? window.__ssTest.state() : null);
const place = (pn, patch) => page.evaluate(([n, p]) => window.__ssTest ? window.__ssTest.place(n, p) : null, [pn, patch]);
const attack = (pn, k, dir) => page.evaluate(([n, kk, dd]) => window.__ssTest ? window.__ssTest.attack(n, kk, dd || {}) : null, [pn, k, dir]);
const resolved = (k) => page.evaluate(kk => window.__ssTest ? window.__ssTest.resolvedDef(kk) : null, k);
const vfxOf = (pn) => page.evaluate(n => window.__ssTest ? window.__ssTest.vfx(n) : null, pn);

const G = 826.8; // top of the stage platform
const gp = (x, facingRight = true) => ({ x, y: G, grounded: true, vx: 0, vy: 0, percent: 0, hitstun: 0, invulnTimer: 0, facingRight });

async function waitFor(pn, pred, maxMs = 8000) {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < maxMs) {
    const s = await state();
    if (s && s.fighters[pn - 1]) { last = s.fighters[pn - 1]; if (pred(last)) return last; }
    await sleep(8);
  }
  return last;
}

console.log('== boot: menu -> Ninja (P1) vs Cowboy (P2) -> START, WITH a combat-less stored ninjaDtilt ==');
await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('canvas', { timeout: 20000 });
await sleep(1200);
let s = await state();
ok(s && s.gameState === 'menu', 'boots into the MENU state');
// The dirty store was seeded before boot, and by now the Teleport Strike
// migration must have repaired it IN PLACE: the ability binding is back, and the
// animator's own keyframes are still the ones the "user" saved.
const stored = await page.evaluate(() => {
  try {
    const raw = localStorage.getItem('smashfighters.animlib.v3');
    if (!raw) return null;
    return JSON.parse(raw).find(x => x && x.id === 'ninjaDtilt') || null;
  } catch (_) { return null; }
});
ok(!!stored, 'the seeded store still holds the saved ninjaDtilt entry');
ok(!!stored && stored.combat && stored.combat.type === 'nonHitbox' && stored.combat.abilityId === 'ninjaDtilt',
  'the store is repaired: ninjaDtilt is bound to the ability again (combat=' + JSON.stringify(stored && stored.combat) + ')');
ok(!!stored && !!stored.tracks && !!stored.tracks['hands.right.x'],
  'and the repair is IN PLACE — the animator\'s own keyframes were kept, not overwritten');

async function setRow(label, want) {
  for (let g = 0; g < 8; g++) {
    const txt = await page.evaluate((l) => {
      const row = [...document.querySelectorAll('#term-lines .term-row')].find(x => x.textContent.includes(l));
      return row ? row.textContent : null;
    }, label);
    if (!txt || txt.includes(want)) return txt;
    await page.evaluate((l) => {
      const row = [...document.querySelectorAll('#term-lines .term-row')].find(x => x.textContent.includes(l));
      if (row) row.click();
      // The start gate needs a confirming press before the match begins: dispatch a
      // real Space keydown/keyup AFTER the click (startNewMatch flushes edges, so the
      // press must come after it) to open the gate.
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', bubbles: true }));
      window.dispatchEvent(new KeyboardEvent('keyup', { code: 'Space', bubbles: true }));
    }, label);
    await sleep(150);
  }
  return null;
}
const r1 = await setRow('YOUR FIGHTER', 'Ninja');
const r2 = await setRow('OPPONENT FIGHTER', 'Cowboy');
ok(!!r1 && r1.includes('Ninja') && !!r2 && r2.includes('Cowboy'), 'matchup is Ninja (P1) vs Cowboy (P2)');
await page.evaluate(() => {
  const r = [...document.querySelectorAll('#term-lines .term-row')].find(x => x.textContent.includes('START'));
  if (r) r.click();
  // The start gate needs a confirming press before the match begins: dispatch a
  // real Space keydown/keyup AFTER the click (startNewMatch flushes edges, so the
  // press must come after it) to open the gate.
  window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', bubbles: true }));
  window.dispatchEvent(new KeyboardEvent('keyup', { code: 'Space', bubbles: true }));
});
await sleep(700);
s = await state();
ok(s && s.gameState === 'playing', 'START enters the PLAYING state');

console.log('== the move still routes to the Teleport Strike ==');
let DELAY_MS = 400, DTILT_DMG = 3.36;
{
  const d = await resolved('dtilt');
  ok(!!d && d.abilityType === 'nonHitbox' && d.abilityId === 'ninjaDtilt',
    'Down Light STILL resolves to the ninjaDtilt ability despite the combat-less saved animation (type='
      + (d && d.abilityType) + ', id=' + (d && d.abilityId) + ')');
  ok(!!d && d.name === 'Teleport Strike', 'and it is still the Teleport Strike (name=' + (d && d.name) + ')');
  // The move CHARGES before it teleports: 0.4s of delay between the activation
  // and the warp. Read the numbers off the live def so the timing assertions
  // below can never drift out of sync with the source.
  ok(!!d && d.abilityDelayFrames === 24,
    'it declares a 0.4s (24 frame) charge before it teleports (abilityDelayFrames=' + (d && d.abilityDelayFrames) + ')');
  ok(!!d && d.abilityFrames >= d.abilityCastFrame + d.abilityDelayFrames + 5,
    'and the move is long enough to hold the whole charge AND the strike (frames=' + (d && d.abilityFrames)
      + ', cast=' + (d && d.abilityCastFrame) + ')');
  if (d) {
    DELAY_MS = (d.abilityDelayFrames || 24) / 60 * 1000;
    DTILT_DMG = d.dmg;
  }
}

console.log('== and it STILL teleports behind the opponent, both facings ==');
for (const [tgtFace, behind, label] of [[true, 1, 'RIGHT'], [false, -1, 'LEFT']]) {
  await place(1, gp(300, !tgtFace));
  await place(2, gp(520, tgtFace));
  await waitFor(1, f => !f.attack);
  await waitFor(2, f => !f.attack);
  await sleep(150);
  const t1 = (await state()).fighters[1];
  const p1x = (await state()).fighters[0].x;
  await attack(1, 'dtilt', {});

  // The charge: the move is running, the smoke is up on the spot it was activated
  // on, and the ninja has NOT moved yet.
  await waitFor(1, f => !!f.teleport, 2000);
  const charged = (await state()).fighters[0];
  ok(!!charged.teleport, 'facing ' + label + ': pressing it ARMS a charge (teleport=' + JSON.stringify(charged.teleport) + ')');
  ok(!!charged.teleport && Math.abs(charged.teleport.fromX - p1x) < 0.5,
    'facing ' + label + ': the charge remembers the spot it was ACTIVATED on (x=' + p1x.toFixed(1) + ')');
  const cloud = await vfxOf(1);
  const puffs = ((cloud && cloud.temp) || []).filter(v => v.effect === 'smokeBomb');
  ok(puffs.length > 0, 'facing ' + label + ': the smoke-bomb VFX goes off on the activation (' + puffs.length + ' live instance(s))');
  ok(puffs.length > 0 && Math.abs(puffs[0].pinnedX - p1x) < 0.5,
    'facing ' + label + ': and it is PINNED to that world point, not riding the fighter (pinnedX='
      + (puffs[0] && puffs[0].pinnedX) + ' vs ' + p1x.toFixed(1) + ')');

  // The delay: the ninja must still be exactly where they were well before the
  // charge is up (half of it, so the assertion is not a coin-flip on timing).
  await sleep(DELAY_MS * 0.5);
  const midway = (await state()).fighters[0];
  ok(Math.abs(midway.x - p1x) < 1 && !!midway.attack,
    'facing ' + label + ': ' + (DELAY_MS * 0.5).toFixed(0) + 'ms in (half the charge) it has NOT teleported yet (x=' + midway.x.toFixed(1) + ')');

  // ...and then it does.
  let landed = null;
  for (let i = 0; i < 120; i++) {
    const fs = (await state()).fighters;
    if (Math.abs(fs[0].x - p1x) > 20) { landed = { x: fs[0].x, y: fs[0].y, facingRight: fs[0].facingRight }; break; }
    if (!fs[0].attack && i > 8) break;
    await sleep(10);
  }
  ok(!!landed, 'facing ' + label + ': the ninja WARPS off its start x=' + p1x.toFixed(1) + ' once the charge is up (no plain sweep)');
  if (landed) {
    const dx = t1.x - landed.x;
    ok(Math.sign(dx) === behind,
      'facing ' + label + ': it lands BEHIND the opponent (target ' + t1.x.toFixed(1) + ', ninja ' + landed.x.toFixed(1) + ')');
    ok(landed.facingRight === (behind > 0),
      'facing ' + label + ': it turns to FACE the opponent (facingRight=' + landed.facingRight + ')');
  }
  const hit = await waitFor(2, f => f.percent > 0, 3000);
  ok(hit && Math.abs(hit.percent - DTILT_DMG) < 0.01,
    'facing ' + label + ': the follow-up strike lands the attack table damage (percent=' + (hit && hit.percent)
      + ', expected ' + DTILT_DMG + ')');
  await waitFor(2, f => !f.attack, 3000);
  await sleep(200);
}

console.log('== the charge cannot outlive its move ==');
{
  await place(1, gp(300, true));
  await place(2, gp(520, true));
  await waitFor(1, f => !f.attack);
  await waitFor(2, f => !f.attack);
  await sleep(150);
  await attack(1, 'dtilt', {});
  await waitFor(1, f => !!f.teleport, 2000);
  await waitFor(1, f => !f.attack, 3000);
  const done = (await state()).fighters[0];
  ok(!done.teleport, 'a finished move leaves no charge armed behind (teleport=' + JSON.stringify(done.teleport) + ')');
  await sleep(200);
}

console.log('== no console / page errors ==');
{
  const real = errors.filter(e => !/favicon|Autofill/i.test(e));
  ok(real.length === 0, 'zero page/console errors (' + real.length + ')' + (real.length ? ': ' + real.slice(0, 5).join(' | ') : ''));
}

console.log('== summary ==');
console.log('' + passes + ' passed, ' + failures + ' failed');
await browser.close();
process.exit(failures ? 1 : 0);
