// verify-combat.mjs — runtime verification for the combat fixes:
//   1. Central Smash-style damage → knockback calculator in combat.js
//   2. Cowboy down-air hit-confirm lock (activate → freeze both → launch upward),
//      plus its real descending dive speed while the box is live
//   3. State-aware menu input (M & friends are inert during gameplay)
//   4. Aerials (Aerial Light / Aerial Uppercut) launching through the real
//      centralized knockback path instead of only animating
//
// Inputs: a running dev server on :5173 (npm run dev in game/).
// Run:    node verify-combat.mjs
//
// The game is driven headlessly with Playwright; the `?probe` URL flag
// activates a minimal test API in Game.js (snapshot + place()).

import { chromium } from 'playwright';

const URL = 'http://localhost:5173/?probe';
const EXE = 'C:/Users/User/AppData/Local/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-win64/chrome-headless-shell.exe';

const GROUND_Y = 826.8; // ground top 858 - radius 31.2

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

// Per-frame in-page recorder: captures EVERY game frame, so a measurement never
// skips the true launch frame (CDP polling can miss it under load/jank).
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
ok(s && s.gameState === 'menu' && s.overlay === 'flex', 'boots into the MENU state with the overlay open');

console.log('== M key / menu-state-aware input ==');
const rowCount = await page.evaluate(() => document.querySelectorAll('#term-lines .term-row').length);
for (const k of ['KeyM', 'Escape', 'KeyP']) {
  await page.keyboard.press(k);
  await sleep(70);
  s = await state();
  ok(s && s.gameState === 'menu' && s.overlay === 'flex', `menu keys inert in MENU on ${k}`);
}
ok((await page.evaluate(() => document.querySelectorAll('#term-lines .term-row').length)) === rowCount,
  'menu rows unchanged after menu-state keypresses');

await page.evaluate(() => {
  const r = [...document.querySelectorAll('#term-lines .term-row')].find(x => x.textContent.includes('START'));
  if (r) r.click();
});
await sleep(400);
s = await state();
ok(s && s.gameState === 'playing' && s.overlay === 'none', 'START enters the PLAYING state and hides the overlay');
await traceStart();

const before = await state();
// M is deliberately excluded: M is the exit-back-to-menu key during free play.
for (const k of ['Escape', 'KeyP', 'KeyN', 'KeyB']) {
  await page.keyboard.press(k);
  await sleep(70);
  s = await state();
  const okState = s && s.gameState === 'playing' && s.overlay === 'none';
  const p1 = s.fighters[0], b1 = before.fighters[0];
  const okInert = p1 && b1 && !p1.attack && p1.percent === b1.percent && Math.abs(p1.x - b1.x) < 1;
  ok(okState && okInert, `M-like keys do not exit gameplay or act on fighters (${k})`);
}
s = await state();
ok(s && s.gameState === 'playing', 'still playing after all menu-ish keys');

console.log('== knockback calculator (grounded jab / nsmash) ==');
async function jabMeasure(opts = {}) {
  await sleep(700); // let the previous attack fully recover
  await page.keyboard.up('Numpad3');
  const patch = { x: 610, y: GROUND_Y, grounded: true, vx: 0, vy: 0, percent: opts.percent || 0, hitstun: 0, invulnTimer: 0, facingRight: false };
  if (opts.shield) patch.shielding = true;
  if (typeof opts.weight === 'number') patch.weight = opts.weight;
  await place(1, { x: 540, y: GROUND_Y, grounded: true, vx: 0, vy: 0, percent: 0, hitstun: 0, invulnTimer: 0, facingRight: true });
  await place(2, patch);
  if (opts.shield) await page.keyboard.down('Numpad3');
  await page.keyboard.press('KeyJ');
  const res = await launchTrace();
  if (opts.shield) await page.keyboard.up('Numpad3');
  return res;
}

async function launchTrace() {
  // Snapshot every frame and return the TRUE launch frame: the first frame the
  // target is both damaged and in hitstun. That frame holds the exact launch
  // velocity the hit applied, before gravity/landing can alter it (robust to
  // poll-frame timing and machine load).
  const from = await tmark();
  await sleep(800);
  const frames = await tslice(from);
  let launched = null;
  let best = null;
  for (const s of frames) {
    const p2 = s.fighters[1];
    if (!p2 || p2.percent <= 0.01) continue;
    if (p2.hitstun > 0 && !launched) launched = p2;
    if (!best || speed(p2) > speed(best)) best = p2;
  }
  return launched || best;
}

async function nsmashMeasure() {
  await sleep(700);
  const patch = { x: 610, y: GROUND_Y, grounded: true, vx: 0, vy: 0, percent: 0, hitstun: 0, invulnTimer: 0, facingRight: false };
  await place(1, { x: 540, y: GROUND_Y, grounded: true, vx: 0, vy: 0, percent: 0, hitstun: 0, invulnTimer: 0, facingRight: true });
  await place(2, patch);
  await page.keyboard.press('KeyK');
  return launchTrace();
}

const speed = p2 => Math.hypot(p2.vx, p2.vy);

const jab0 = await jabMeasure();
ok(jab0, 'jab connects at 0%');
ok(jab0.percent >= 3, 'jab adds its damage (3%)');
ok(jab0.hitstun > 0, 'jab applies hitstun');
ok(jab0.vx > 0, 'target on the right launches to the right (away from attacker)');
ok(jab0.vy < 0, 'jab angle launches upward (vy < 0)');

const jab100 = await jabMeasure({ percent: 100 });
ok(jab100, 'jab connects at 100%');
ok(speed(jab100) > speed(jab0) * 1.5, `knockback scales with target % ${speed(jab0).toFixed(0)} -> ${speed(jab100).toFixed(0)}`);

const lightW = await jabMeasure({ weight: 0.85 });
const heavyW = await jabMeasure({ weight: 1.25 });
ok(lightW && heavyW, 'weight test hits land');
ok(speed(lightW) > speed(heavyW) * 1.2, `lighter target flies farther ${speed(lightW).toFixed(0)} vs ${speed(heavyW).toFixed(0)}`);

const shieldHit = await jabMeasure({ shield: true });
ok(shieldHit, 'shielded hit registers');
ok(shieldHit.percent < 1, `shield reduces damage (${shieldHit.percent.toFixed(1)}%)`);
ok(speed(shieldHit) < speed(jab0) * 0.15, `shield heavily reduces knockback (${speed(shieldHit).toFixed(1)} vs ${speed(jab0).toFixed(0)})`);

const smash0 = await nsmashMeasure();
ok(smash0, 'nsmash connects at 0%');
ok(speed(smash0) > speed(jab0) * 2, `heavy attacks launch much farther than lights (${speed(smash0).toFixed(0)} vs ${speed(jab0).toFixed(0)})`);

console.log('== knockback direction (bair behind / facing flip) ==');
await sleep(700);
await place(1, { x: 700, y: GROUND_Y, grounded: true, vx: 0, vy: 0, percent: 0, hitstun: 0, invulnTimer: 0, facingRight: false });
await place(2, { x: 630, y: GROUND_Y, grounded: true, vx: 0, vy: 0, percent: 0, hitstun: 0, invulnTimer: 0, facingRight: false });
await page.keyboard.press('KeyJ');
const fbRes = await launchTrace();
ok(fbRes && fbRes.percent > 0, 'left-facing attacker connects');
ok(fbRes && fbRes.vx < 0, 'attacker facing left, target on the left -> launches left (away), not reversed');
ok(fbRes && Math.abs(speed(fbRes) - speed(jab0)) < Math.max(40, speed(jab0) * 0.3),
  `direction flip does not change knockback magnitude (${speed(fbRes).toFixed(0)} vs ${speed(jab0).toFixed(0)})`);

console.log('== back air (target behind attacker launches away) ==');
await sleep(700);
await place(1, { x: 760, y: 700, grounded: false, vx: 0, vy: -20, percent: 0, hitstun: 0, invulnTimer: 0, facingRight: true });
await place(2, { x: 700, y: 700, grounded: false, vx: 0, vy: -20, percent: 0, hitstun: 0, invulnTimer: 0, facingRight: false });
// Deterministic back-air: holding a direction would physically turn the fighter
// (and ArrowUp is the jump key), so a keyboard press can't reliably cause a
// back air. Drive it through the probe entry which starts the exact move.
const bairOk = await page.evaluate(() => window.__ssTest.attack(1, 'bair', { left: true }));
ok(bairOk, 'bair started via probe entry');
const ba = await launchTrace();
ok(ba && ba.percent > 0, 'bair connects');
ok(ba && ba.vx < 0, `bair sends the target AWAY from the attacker (vx=${ba ? ba.vx.toFixed(0) : '?'})`);

console.log('== cowboy down-air hit-confirm lock ==');
function dairTrace(p2x, p2y) {
  return (async () => {
    await sleep(700);
    await place(1, { x: 430, y: 660, grounded: false, vx: 0, vy: 0, percent: 0, hitstun: 0, invulnTimer: 0, facingRight: true });
    await place(2, { x: p2x, y: p2y, grounded: false, vx: 0, vy: 0, percent: 0, hitstun: 0, invulnTimer: 0, facingRight: true });
    const from = await tmark();
    await page.keyboard.down('ArrowDown');
    await sleep(20);
    await page.keyboard.press('KeyJ');
    await sleep(40);
    await page.keyboard.up('ArrowDown');
    await sleep(900);
    return await tslice(from);
  })();
}

const hit = await dairTrace(430, 730);
const connect = hit.find(t => t.fighters[1].percent > 0.01);
const duringLock = hit.filter(t => t.fighters[1].locked);
const launched = hit.find(t => t.fighters[1].percent > 0.01 && !t.fighters[1].locked && t.fighters[1].hitstun > 0);

ok(!!connect, 'dair connects (damage applied)');
ok(connect && connect.fighters[1].percent >= 9.5, `dair applies its damage on activation (${connect ? connect.fighters[1].percent.toFixed(1) : '?'}%)`);
ok(connect && connect.fighters[1].locked && connect.fighters[0].locked,
  'dair hit locks BOTH fighters at activation');
ok(connect && connect.fighters[1].hitstun === 0, 'no hitstun/launch during the activation frame');
ok(duringLock.length >= 2, `lock is brief but observable (${duringLock.length} samples)`);
const frozen = duringLock.every(t => Math.abs(t.fighters[1].vx) < 1 && Math.abs(t.fighters[1].vy) < 1 && t.fighters[0].locked);
ok(frozen, 'both fighters hold still during the lock (no drift/launch)');
// The freeze must be real movement/physics, not just a held animation: neither
// fighter's position may advance while the other is locked.
const lockA = duringLock[0], lockB = duringLock[duringLock.length - 1];
const attackerHeld = Math.abs(lockB.fighters[0].y - lockA.fighters[0].y) < 1
  && Math.abs(lockB.fighters[0].x - lockA.fighters[0].x) < 1
  && Math.abs(lockB.fighters[0].vy) < 1 && Math.abs(lockB.fighters[0].vx) < 1;
const targetHeld = Math.abs(lockB.fighters[1].y - lockA.fighters[1].y) < 1
  && Math.abs(lockB.fighters[1].x - lockA.fighters[1].x) < 1;
ok(attackerHeld, `attacker physics is frozen in place during the lock (Δx=${(lockB.fighters[0].x - lockA.fighters[0].x).toFixed(2)} Δy=${(lockB.fighters[0].y - lockA.fighters[0].y).toFixed(2)})`);
ok(targetHeld, `target physics is frozen in place during the lock (Δx=${(lockB.fighters[1].x - lockA.fighters[1].x).toFixed(2)} Δy=${(lockB.fighters[1].y - lockA.fighters[1].y).toFixed(2)})`);
ok(launched && launched.fighters[1].hitstun > 0, 'after the lock the target enters normal hitstun');
ok(launched && launched.fighters[1].vy < 0, 'dair launches the target UPWARD');
ok(launched && !launched.fighters[1].locked && !launched.fighters[0].locked,
  'lock ends cleanly for both fighters after release');
// ...and Cowboy keeps playing normally afterwards: its own physics resumes.
const resume = launched ? hit.slice(hit.indexOf(launched)) : [];
const afterDy = resume.length > 1 ? Math.max(...resume.map(t => Math.abs(t.fighters[0].y - resume[0].fighters[0].y))) : 0;
ok(resume.length > 1 && afterDy > 1,
  `attacker resumes normal physics after the freeze (Δy=${afterDy.toFixed(1)}px over ${resume.length} frames)`);

const miss = await dairTrace(900, 730);
ok(miss.length > 0 && miss.every(t => t.fighters[1].percent === 0), 'whiffed dair deals no damage');
ok(miss.every(t => !t.fighters[1].locked && !t.fighters[0].locked), 'whiffed dair does not lock anyone');

console.log('== down-air lock cleanup on interrupt ==');
await sleep(700);
await place(1, { x: 430, y: 660, grounded: false, vx: 0, vy: 0, percent: 0, hitstun: 0, invulnTimer: 0, facingRight: true });
await place(2, { x: 430, y: 730, grounded: false, vx: 0, vy: 0, percent: 0, hitstun: 0, invulnTimer: 0, facingRight: true });
await page.keyboard.down('ArrowDown');
await sleep(20);
await page.keyboard.press('KeyJ');
await sleep(40);
await page.keyboard.up('ArrowDown');
let lockedSeen = false;
for (let i = 0; i < 30; i++) {
  await sleep(20);
  const s = await state();
  if (s.fighters[1].locked) { lockedSeen = true; break; }
}
ok(lockedSeen, 'lock engaged before interrupt');
if (lockedSeen) {
  await place(1, { x: -500, y: 700, grounded: false, vx: 0, vy: 0 }); // blast zone -> soft reset
  await sleep(150);
  s = await state();
  ok(!s.fighters[0].locked && !s.fighters[1].locked, 'attacker respawn clears the lock on BOTH fighters');
  ok(s.fighters[1].hitstun === 0, 'cleared lock never launches the target');
}

console.log('== aerials launch upward through the real knockback path ==');
// The soft separation band is (rA+rB)*0.6 = 37.4px of vertical offset, so a
// target 50px above/below the attacker still overlaps the aerial's box and the
// two fall in lockstep (the offset never changes), keeping box on hurtbox for
// the whole active window.
async function aerialMeasure(key, targetDy, targetDx) {
  await sleep(700);
  const ax = 430, ay = 560;
  await place(1, { x: ax, y: ay, grounded: false, vx: 0, vy: 0, percent: 0, hitstun: 0, invulnTimer: 0, facingRight: true });
  await place(2, { x: ax + targetDx, y: ay + targetDy, grounded: false, vx: 0, vy: 0, percent: 0, hitstun: 0, invulnTimer: 0, facingRight: true });
  // Probe entry: holding a direction would turn the fighter and ArrowUp is the
  // jump key, so the move is started exactly as a fresh press of it would.
  const started = await page.evaluate(k => window.__ssTest.attack(1, k, { right: true }), key);
  return started ? await launchTrace() : null;
}

const nairRes = await aerialMeasure('nair', 50, 0);
ok(nairRes && nairRes.percent > 0, 'aerial light (nair) connects');
ok(nairRes && nairRes.hitstun > 0, 'aerial light applies real hitstun + knockback (not animation only)');
ok(nairRes && nairRes.vy < 0, `aerial light launches the target UPWARD (vy=${nairRes ? nairRes.vy.toFixed(0) : '?'})`);
ok(nairRes && nairRes.vy < 0 && Math.abs(nairRes.vy) > Math.abs(nairRes.vx) * 2,
  'aerial light launches steeply upward (|vy| >> |vx|, i.e. the def angle is really applied)');

const uairRes = await aerialMeasure('uair', -50, 4);
ok(uairRes && uairRes.percent > 0, 'aerial uppercut (uair) connects');
ok(uairRes && uairRes.hitstun > 0, 'aerial uppercut applies real hitstun + knockback (not animation only)');
ok(uairRes && uairRes.vy < 0, `aerial uppercut launches the target UPWARD (vy=${uairRes ? uairRes.vy.toFixed(0) : '?'})`);
ok(uairRes && uairRes.vy < 0 && Math.abs(uairRes.vy) > Math.abs(uairRes.vx) * 5,
  'aerial uppercut is a near-vertical launcher (|vy| > 5*|vx|)');

console.log('== down-air dive: real descending speed while the box is live ==');
// The dive comes from the attack def, not the player's fast-fall input, so it is
// started through the probe (no ArrowDown held -> the physics fall cap stays at
// MAX_FALL_SPEED) and measured against a control aerial with no `dive`.
async function dropAndAttack(key) {
  await sleep(700);
  await place(1, { x: 430, y: 420, grounded: false, vx: 0, vy: 0, percent: 0, hitstun: 0, invulnTimer: 0, facingRight: true });
  await place(2, { x: 1000, y: 420, grounded: false, vx: 0, vy: 0, percent: 0, hitstun: 0, invulnTimer: 0, facingRight: true });
  const from = await tmark();
  const started = await page.evaluate(k => window.__ssTest.attack(1, k, { down: true }), key);
  await sleep(450);
  return { started, frames: await tslice(from) };
}
const inMove = (f, name) => f.fighters[0] && f.fighters[0].attack === name && !f.fighters[0].grounded;
const maxVy = (frames) => frames.reduce((m, f) => Math.max(m, f.fighters[0].vy), 0);

const dive = await dropAndAttack('dair');
const diveFrames = dive.frames.filter(f => inMove(f, 'Down Air'));
const diveMax = maxVy(diveFrames);
ok(dive.started && diveFrames.length > 0, 'down-air dive frames observed in flight');
ok(diveMax >= 900,
  `down-air actually dives at fall-terminal speed (max vy=${diveMax.toFixed(0)}; gravity alone needs 0.54s to reach 950)`);
ok(diveFrames.some((f, i) => i > 0 && f.fighters[0].y > diveFrames[i - 1].fighters[0].y),
  'the dive really moves the fighter down (y increases frame over frame)');

const ctl = await dropAndAttack('nair');
const ctlFrames = ctl.frames.filter(f => inMove(f, 'Neutral Air'));
const ctlMax = maxVy(ctlFrames);
ok(ctlFrames.length > 0 && ctlMax < 900,
  `an aerial with no dive never reaches dive speed in the same window (nair max vy=${ctlMax.toFixed(0)})`);

console.log('== M exits free play back to the menu (no reload) ==');
{
  const mBefore = await state();
  ok(mBefore.gameState === 'playing' && mBefore.overlay === 'none', 'still PLAYING before M');
  await page.keyboard.press('KeyM');
  await sleep(150);
  const mAfter = await state();
  ok(mAfter.gameState === 'menu' && mAfter.overlay !== 'none',
    'pressing M in free play returns to the MENU overlay without reloading');
  ok(mAfter.fighters.every(f => f && f.percent === 0 && !f.attack && !f.locked),
    'return-to-menu cleans up fighters (0%, no attack, no lock)');
  // Round-trip: START again straight from the menu, still no reload.
  await page.evaluate(() => {
    const r = [...document.querySelectorAll('#term-lines .term-row')].find(x => x.textContent.includes('START'));
    if (r) r.click();
  });
  await sleep(400);
  const re = await state();
  ok(re.gameState === 'playing' && re.overlay === 'none',
    'START after M re-enters PLAYING (menu -> M -> START round-trip works)');
}

console.log('== summary ==');
console.log(`${passes} passed, ${failures} failed`);
await browser.close();
process.exit(failures ? 1 : 0);