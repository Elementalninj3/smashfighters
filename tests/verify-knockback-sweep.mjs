// verify-knockback-sweep.mjs — exhaustive runtime knockback sweep.
// Exercises EVERY default attack (light/heavy × neutral/side/up/down, all
// aerials, dash) against real hitboxes and asserts the Smash-style damage →
// knockback behavior: connects, applies its damage, launches with real
// velocity, aims away from the attacker / up for up-angles / down for
// down-angles, scales with target percent and the target's weight.
//
// Adds nothing to the game; assumes the ?probe dev server on :5173.

import { chromium } from 'playwright';

const URL = 'http://localhost:5173/?probe';
const EXE = 'C:/Users/User/AppData/Local/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-win64/chrome-headless-shell.exe';

let passes = 0;
let failures = 0;
function ok(cond, msg) {
  if (cond) { passes++; console.log('  PASS  ' + msg); }
  else { failures++; console.log('  FAIL  ' + msg); }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const browser = await chromium.launch({
  headless: true,
  executablePath: EXE,
  args: ['--enable-unsafe-swiftshader', '--no-first-run'],
});
const page = await browser.newPage({ viewport: { width: 1200, height: 1100 } });
page.on('pageerror', err => console.log('[pageerror]', err.message));

const state = () => page.evaluate(() => window.__ssTest ? window.__ssTest.state() : null);
const place = (pn, patch) => page.evaluate(([p, pa]) => window.__ssTest.place(p, pa), [pn, patch]);
const hitboxesNow = () => page.evaluate(() => window.__ssTest ? window.__ssTest.hitboxes() : []);

// Per-frame in-page recorder: captures EVERY game frame so fire() never skips
// the true launch frame (CDP polling can miss it under load/jank).
async function traceStart() {
  await page.evaluate(() => {
    if (window.__trRaf) cancelAnimationFrame(window.__trRaf);
    window.__tr = [];
    const tick = () => {
      try { if (window.__ssTest) window.__tr.push(window.__ssTest.state()); } catch (e) { /* ignore */ }
      window.__trRaf = requestAnimationFrame(tick);
    };
    window.__trRaf = requestAnimationFrame(tick);
  });
}
const tmark = () => page.evaluate(() => window.__tr ? window.__tr.length : 0);
const tslice = (from) => page.evaluate(f => window.__tr ? window.__tr.slice(f) : [], from);

console.log('== load ==');
await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('canvas', { timeout: 10000 });
await sleep(1200);
let s = await state();
ok(s && s.gameState === 'menu' && s.overlay === 'flex', 'boots into the MENU state');

await page.evaluate(() => {
  const r = [...document.querySelectorAll('#term-lines .term-row')].find(x => x.textContent.includes('START'));
  if (r) r.click();
  // The start gate needs a confirming press before the match begins: dispatch a
  // real Space keydown/keyup AFTER the click (startNewMatch flushes edges, so the
  // press must come after it) to open the gate.
  window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', bubbles: true }));
  window.dispatchEvent(new KeyboardEvent('keyup', { code: 'Space', bubbles: true }));
});
await sleep(400);
s = await state();
ok(s && s.gameState === 'playing' && s.overlay === 'none', 'START enters PLAYING');
await traceStart();

// ── Helpers ────────────────────────────────────────────────────────────
// Fire an attack given an input recipe: optional direction keys to HOLD for a
// few frames before the attack press, then the attack key (light/special).
// Traces until the launch resolves and returns the max-speed snapshot of P2.
async function fire({ p1, p2, dir, attack, probe }) {
  await sleep(700); // let any previous swing fully recover
  await page.keyboard.up('Numpad3');
  await place(1, p1);
  await place(2, p2);
  const from = await tmark();
  if (probe) {
    // Deterministic entry for up/back variants: the keyboard path for these is
    // unreliable because the jump binding is also the up-direction binding and
    // holding back physically turns the fighter around.
    const dirObj = {};
    for (const k of dir || []) {
      dirObj[k === 'ArrowLeft' ? 'left' : k === 'ArrowRight' ? 'right' : k === 'ArrowUp' ? 'up' : 'down'] = true;
    }
    await page.evaluate(([k, d]) => window.__ssTest.attack(1, k, d), [probe, dirObj]);
  } else {
    const downKeys = [];
    for (const k of dir || []) { await page.keyboard.down(k); downKeys.push(k); }
    if (downKeys.length) await sleep(20);
    await page.keyboard.press(attack);
    await sleep(40);
    for (const k of downKeys) await page.keyboard.up(k);
  }

  // Snapshot every frame: the first damaged frame is `hit`, the first damaged
  // frame in hitstun is the true `launch` (post-lock for hit-confirm moves).
  await sleep(900);
  const frames = await tslice(from);
  let best = null;
  let hit = null;
  let launched = null;
  for (const s2 of frames) {
    const p2s = s2.fighters[1];
    if (!p2s || p2s.percent <= 0.01) continue;
    if (!hit) hit = p2s;
    if (!launched && p2s.hitstun > 0) launched = p2s;
    if (!best || speed(p2s) > speed(best)) best = p2s;
  }
  return { hit, launched, best };
}

const speed = p => Math.hypot(p.vx, p.vy);
// Render helper: a launch that was never observed is reported as '?', not a
// crash. `speed(b)` is interpolated into these messages for a FAILING case too,
// where b is null, so it has to tolerate a null snapshot.
const spd = p => (p ? speed(p).toFixed(0) : '?');
const GROUND = 826.8;

// Standard setups: P1 attacks with facing right (+1), P2 on the RIGHT.
function stdG(x1 = 540, x2 = 600) {
  return {
    p1: { x: x1, y: GROUND, grounded: true, vx: 0, vy: 0, percent: 0, hitstun: 0, invulnTimer: 0, facingRight: true },
    p2: { x: x2, y: GROUND, grounded: true, vx: 0, vy: 0, percent: 0, hitstun: 0, invulnTimer: 0, facingRight: false },
  };
}
function stdAir(y, x1 = 540, x2 = 600) {
  return {
    p1: { x: x1, y, grounded: false, vx: 0, vy: 0, percent: 0, hitstun: 0, invulnTimer: 0, facingRight: true },
    p2: { x: x2, y, grounded: false, vx: 0, vy: 0, percent: 0, hitstun: 0, invulnTimer: 0, facingRight: false },
  };
}
function withPercent(setup, percent, pn = 2) {
  const out = JSON.parse(JSON.stringify(setup));
  out[pn === 1 ? 'p1' : 'p2'].percent = percent;
  return out;
}

// ── Ground light attacks ───────────────────────────────────────────────
console.log('== ground attacks ==');
// Balance (2026-09): knockback ×0.50 → floors halved (same assertions, new scale).
const groundPlans = [
  { name: 'jab',     def: 'jab',     dir: [],          attack: 'KeyJ', expected: { vx: 1, vy: -1 }, floor: 30 },
  { name: 'ftilt',   def: 'ftilt',   dir: ['ArrowRight'], attack: 'KeyJ', expected: { vx: 1, vy: -1 }, floor: 60 },
  { name: 'utilt',   def: 'utilt',   dir: ['ArrowUp'], attack: 'KeyJ', probe: 'utilt', expected: { vx: 0, vy: -1 }, floor: 55 },
  { name: 'dtilt',   def: 'dtilt',   dir: ['ArrowDown'], attack: 'KeyJ', expected: { vx: 1, vy: 0 }, floor: 40 },
  { name: 'nsmash',  def: 'nsmash',  dir: [],          attack: 'KeyK', expected: { vx: 1, vy: -1 }, floor: 100 },
  { name: 'fsmash',  def: 'fsmash',  dir: ['ArrowRight'], attack: 'KeyK', expected: { vx: 1, vy: -1 }, floor: 125 },
];
for (const plan of groundPlans) {
  const setup = plan.def === 'utilt'
    ? { p1: stdG(540, 540).p1, p2: { x: 540, y: 738, grounded: true, vx: 0, vy: 0, percent: 0, hitstun: 0, invulnTimer: 0, facingRight: false } }
    : stdG(540, 600);
  const r0 = await fire({ ...plan, p1: setup.p1, p2: setup.p2 });
  const r100 = await fire({ ...plan, p1: setup.p1, p2: withPercent(setup, 100).p2 });
  const b = r0.launched, h = r0.launched;
  ok(r0.launched, `${plan.name} connects at 0%`);
  ok(h && h.hitstun > 0, `${plan.name} applies hitstun`);
  ok(b && speed(b) >= plan.floor,
    `${plan.name} has real knockback (${b ? speed(b).toFixed(0) : '?'} >= ${plan.floor})`);
  ok(b && (plan.expected.vx === 1 ? b.vx > 0 : Math.abs(b.vx) < Math.abs(b.vy)),
    `${plan.name} launches in the correct horizontal direction (${plan.expected.vx === 1 ? 'away' : 'vertical'})`);
  ok(b && (plan.expected.vy === -1 ? b.vy < 0 : plan.expected.vy === 1 ? b.vy > 0 : plan.expected.vy === 0 ? Math.abs(b.vy) < speed(b) * 0.2 : true),
    `${plan.name} launches ${plan.expected.vy === -1 ? 'up' : plan.expected.vy === 1 ? 'down' : plan.expected.vy === 0 ? 'flat along the floor' : 'correctly'}`);
  ok(r100.launched && speed(r100.launched) > speed(b) * 1.3,
    `${plan.name} knockback scales with percent (${spd(b)} -> ${spd(r100.launched)})`);
}

console.log('== usmash (up) / dsmash (down) ==');
{
  const up = { p1: stdG(540, 540).p1, p2: { x: 540, y: 720, grounded: true, vx: 0, vy: 0, percent: 0, hitstun: 0, invulnTimer: 0, facingRight: false } };
  const r0 = await fire({ p1: up.p1, p2: up.p2, dir: ['ArrowUp'], attack: 'KeyK', probe: 'usmash' });
  const r100 = await fire({ p1: up.p1, p2: withPercent(up, 100).p2, dir: ['ArrowUp'], attack: 'KeyK', probe: 'usmash' });
  const b = r0.launched;
  ok(r0.launched, 'usmash connects');
  ok(b && speed(b) >= 115, `usmash has real knockback (${speed(b).toFixed(0)})`);
  ok(b && b.vy < 0 && Math.abs(b.vx) < Math.abs(b.vy), 'usmash launches nearly straight up');
  ok(r100.launched && speed(r100.launched) > speed(b) * 1.3, `usmash scales (${spd(b)} -> ${spd(r100.launched)})`);

  // Down smash summons the horse ride: its trample hitbox launches the grounded
  // opponent UPWARD-OUTWARD (a strong up-angle away from the rider) — nothing
  // is wasted into the floor.
  const d = stdG(540, 555);
  const d0 = await fire({ p1: d.p1, p2: d.p2, dir: ['ArrowDown'], attack: 'KeyK' });
  const d100 = await fire({ p1: d.p1, p2: withPercent(d, 100).p2, dir: ['ArrowDown'], attack: 'KeyK' });
  const db = d0.launched;
  ok(d0.launched, 'dsmash horse connects');
  ok(db && speed(db) >= 115, `dsmash horse has real knockback (${speed(db).toFixed(0)})`);
  ok(db && db.vy < 0 && Math.abs(db.vy) > Math.abs(db.vx) * 1.2,
    'dsmash horse launches the target UPWARD-OUTWARD (not into the floor)');
  ok(d100.launched && speed(d100.launched) > speed(db) * 1.3, `dsmash scales (${spd(db)} -> ${spd(d100.launched)})`);
}

console.log('== dash attack (dash state) ==');
{
  const d = stdG(540, 595);
  const r0 = await fire({ p1: { ...d.p1, dashing: true, dashTimer: 0.3 }, p2: d.p2, dir: [], attack: 'KeyJ' });
  const r100 = await fire({ p1: { ...d.p1, dashing: true, dashTimer: 0.3 }, p2: withPercent(d, 100).p2, dir: [], attack: 'KeyJ' });
  const b = r0.launched;
  ok(r0.launched, 'dash attack connects');
  ok(b && speed(b) >= 45, `dash attack has real knockback (${speed(b).toFixed(0)})`);
  ok(b && b.vx > 0, 'dash attack launches forward');
  ok(r100.launched && speed(r100.launched) > speed(b) * 1.3, `dash attack scales (${spd(b)} -> ${spd(r100.launched)})`);
}

// ── Aerial attacks ─────────────────────────────────────────────────────
console.log('== aerial attacks ==');
const airPlans = [
  { name: 'nair', dir: [], attack: 'KeyJ', setup: stdAir(700, 540, 540), floor: 55, vx: 1, vy: 0 },
  { name: 'fair', dir: ['ArrowRight'], attack: 'KeyJ', setup: stdAir(700, 540, 600), floor: 70, vx: 1, vy: -1 },
  { name: 'bair', dir: ['ArrowLeft'], attack: 'KeyJ', probe: 'bair', setup: { p1: { x: 760, y: 700, grounded: false, vx: 0, vy: -20, percent: 0, hitstun: 0, invulnTimer: 0, facingRight: true }, p2: { x: 700, y: 700, grounded: false, vx: 0, vy: -20, percent: 0, hitstun: 0, invulnTimer: 0, facingRight: false } }, floor: 80, vx: -1, vy: 1 },
  { name: 'uair', dir: ['ArrowUp'], attack: 'KeyJ', probe: 'uair', setup: { p1: { x: 540, y: 760, grounded: false, vx: 0, vy: 0, percent: 0, hitstun: 0, invulnTimer: 0, facingRight: true }, p2: { x: 540, y: 700, grounded: false, vx: 0, vy: 0, percent: 0, hitstun: 0, invulnTimer: 0, facingRight: false } }, floor: 65, vx: 0, vy: -1 },
  { name: 'dair', dir: ['ArrowDown'], attack: 'KeyJ', setup: { p1: { x: 430, y: 660, grounded: false, vx: 0, vy: 0, percent: 0, hitstun: 0, invulnTimer: 0, facingRight: true }, p2: { x: 430, y: 730, grounded: false, vx: 0, vy: 0, percent: 0, hitstun: 0, invulnTimer: 0, facingRight: true } }, floor: 65, vx: 0, vy: -1 },
];
for (const plan of airPlans) {
  const r0 = await fire({ ...plan, p1: plan.setup.p1, p2: plan.setup.p2 });
  const r100 = await fire({ ...plan, p1: plan.setup.p1, p2: withPercent(plan.setup, 100).p2 });
  const b = r0.launched, h = r0.launched;
  ok(r0.launched, `${plan.name} connects at 0%`);
  ok(h && h.hitstun > 0, `${plan.name} applies hitstun`);
  ok(b && speed(b) >= plan.floor, `${plan.name} has real knockback (${b ? speed(b).toFixed(0) : '?'})`);
  ok(b && (plan.vx === 1 ? b.vx > 0 : plan.vx === -1 ? b.vx < 0 : Math.abs(b.vx) < Math.abs(b.vy)),
    `${plan.name} launches in the correct horizontal direction`);
  ok(b && (plan.vy === -1 ? b.vy < 0 : plan.vy === 1 ? b.vy > 0 : plan.vy === 0 ? Math.abs(b.vy) < speed(b) * 0.2 : true),
    `${plan.name} launches ${plan.vy === -1 ? 'up' : plan.vy === 1 ? 'down' : plan.vy === 0 ? 'flat (not up)' : 'correctly'}`);
  ok(r100.launched && speed(r100.launched) > speed(b) * 1.3,
    `${plan.name} knockback scales with percent (${spd(b)} -> ${spd(r100.launched)})`);
}

// ── Weight scaling on a heavy hitter at fixed percent ──────────────────
console.log('== weight scaling ==');
{
  for (const w of [0.85, 1.0, 1.25]) {
    const setup = stdG(540, 610);
    setup.p2.weight = w;
    setup.p2.percent = 80;
    const r = await fire({ p1: setup.p1, p2: setup.p2, dir: [], attack: 'KeyK' });
    ok(r.launched, `nsmash connects vs weight ${w}`);
  }
}
{
  const sL = stdG(540, 610); sL.p2.weight = 0.85; sL.p2.percent = 80;
  const sH = stdG(540, 610); sH.p2.weight = 1.25; sH.p2.percent = 80;
  const rL = await fire({ p1: sL.p1, p2: sL.p2, dir: [], attack: 'KeyK' });
  const rH = await fire({ p1: sH.p1, p2: sH.p2, dir: [], attack: 'KeyK' });
  ok(rL.launched && rH.launched && speed(rL.launched) > speed(rH.launched) * 1.2,
    `lighter target flies farther (${rL.launched ? speed(rL.launched).toFixed(0) : '?'} vs ${rH.launched ? speed(rH.launched).toFixed(0) : '?'})`);
}

// ── Hitbox lifecycle: exists only during the active window ─────────────
console.log('== hitbox lifecycle ==');
{
  const s = stdG(540, 600);
  await sleep(700);
  await place(1, s.p1); await place(2, s.p2);
  await page.keyboard.press('KeyK'); // nsmash: startup 0, active 6
  await sleep(30); // ~2 frames: should be inside the active window
  let live = (await hitboxesNow()).filter(h => h.active);
  ok(live.length >= 1, `nsmash hitbox is live during the active window (${live.length})`);
  await sleep(600); // recovery + finish
  live = (await hitboxesNow()).filter(h => h.active);
  ok(live.length === 0, 'hitbox is gone after the attack finishes');
}

console.log('== summary ==');
console.log(`${passes} passed, ${failures} failed`);
await browser.close();
process.exit(failures ? 1 : 0);