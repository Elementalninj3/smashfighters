// verify-side-smash-animstore.mjs — regression for the REAL-game bug where the
// cowboy's Side Smash silently stopped firing its rifle bullet.
//
// The shipped library declares fsmash as the cowboyFwdHeavy ability (nonHitbox)
// ON THE ANIMATION's combat entry. But a player who has a saved animation store
// (localStorage: smashfighters.animlib.v3) whose `fsmash` entry dropped its
// combat payload would have their Side Smash resolve as a plain melee swing —
// no bullet, even though the HITBOX-store immunity (verify-combat §"Side Smash
// is an ABILITY") only guarded the interaction with the hitbox store.
//
// This suite seeds that dirty animation store BEFORE boot, then drives Side
// Smash and asserts it STILL fires exactly one cowboyTrail projectile (16 dmg)
// from the rifle muzzle — proving the attack table's ability designation is
// authoritative even when the saved animation is missing its combat data.
//
// Run: node verify-side-smash-animstore.mjs   (dev server :5173, probe on)

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
const page = await browser.newPage({ viewport: { width: 800, height: 940 } });
page.on('pageerror', e => console.log('[pageerror]', e.message));

// A saved 'fsmash' animation WITH keyframes but NO combat payload — exactly the
// shape an old/partial animator save leaves behind.
const bareFsmash = {
  id: 'fsmash', name: 'Side Smash', fps: 60, loop: false, mirror: true, blendIn: 2,
  weapons: { right: null, left: null },
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
  const idx = store.findIndex(a => a && a.id === 'fsmash');
  if (idx >= 0) store[idx] = anim; else store.push(anim);
  localStorage.setItem(key, JSON.stringify(store));
}, bareFsmash);

const state = () => page.evaluate(() => window.__ssTest ? window.__ssTest.state() : null);
const place = (pn, patch) => page.evaluate(([n, p]) => window.__ssTest ? window.__ssTest.place(n, p) : null, [pn, patch]);
const attack = (pn, k, dir) => page.evaluate(([n, kk, dd]) => window.__ssTest ? window.__ssTest.attack(n, kk, dd || {}) : null, [pn, k, dir]);
const resolved = (k) => page.evaluate(kk => window.__ssTest ? window.__ssTest.resolvedDef(kk) : null, k);
const projs = (pn) => page.evaluate(n => window.__ssTest ? window.__ssTest.projectiles(n) : [], pn);

const G = 826.8;
const gp = (x) => ({ x, y: G, grounded: true, vx: 0, vy: 0, percent: 0, hitstun: 0, invulnTimer: 0, facingRight: true });

console.log('== dirty animation store: cowboy Side Smash KEEPS its rifle bullet ==');
await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('canvas', { timeout: 20000 });
await sleep(1200);
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
let s = await state();
ok(s && s.gameState === 'playing', 'boots into the PLAYING state');

// The stored fsmash animation is what the resolver sees: no combat payload.
const r = await resolved('fsmash');
ok(!!r && r.abilityType === 'nonHitbox' && r.abilityId === 'cowboyFwdHeavy',
  'Side Smash STILL resolves to the cowboyFwdHeavy ability despite the combat-less saved fsmash (type=' + (r && r.abilityType) + ', id=' + (r && r.abilityId) + ')');

await place(1, { ...gp(300), percent: 0, hitstun: 0, facingRight: true });
await place(2, { ...gp(720), percent: 0, hitstun: 0, facingRight: false });
await attack(1, 'fsmash', { right: true });
await sleep(170); // cast (frame 6 ≈ 100ms) + a few frames of straight travel
const ps = await projs(1);
ok(Array.isArray(ps) && ps.length === 1, 'Side Smash fires exactly ONE rifle bullet (projectiles=' + (ps && ps.length) + ')');
ok(!!ps[0] && ps[0].trail === 'cowboyTrail', 'rifle bullet carries the cowboyTrail VFX (trail=' + (ps[0] && ps[0].trail) + ')');
ok(!!ps[0] && ps[0].x > 335 && ps[0].vx > 600,
  'bullet spawns at the rifle muzzle tip and flies FORWARD (x=' + (ps[0] && ps[0].x) + ', vx=' + (ps[0] && ps[0].vx) + ')');

await page.evaluate(() => { try { localStorage.removeItem('smashfighters.animlib.v3'); } catch (_) {} });

console.log('== summary ==');
console.log('' + passes + ' passed, ' + failures + ' failed');
await browser.close();
process.exit(failures ? 1 : 0);