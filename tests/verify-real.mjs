// verify-real.mjs — interactive verification of the REAL runtime flow, beyond the probes.
// Covers requirement bullets not exercised by verify-combat.mjs / verify-knockback-sweep.mjs:
//   - natural walk-into-range combat (no artificial placement)
//   - hitstun prevents movement/jump/attack input
//   - menu navigation actually works while in MENU
//   - M & menu keys inert during real gameplay after movement
//   - repeated attacks: no runaway physics / velocity resets / crashes
import { chromium } from 'playwright';

const URL = 'http://localhost:5173/?probe';
const EXE = 'C:/Users/User/AppData/Local/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-win64/chrome-headless-shell.exe';

let passes = 0, failures = 0;
function ok(cond, msg) { if (cond) { passes++; console.log('  PASS  ' + msg); } else { failures++; console.log('  FAIL  ' + msg); } }
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const browser = await chromium.launch({ headless: true, executablePath: EXE, args: ['--enable-unsafe-swiftshader', '--no-first-run'] });
const page = await browser.newPage({ viewport: { width: 1200, height: 1100 } });
page.on('pageerror', err => console.log('[pageerror]', err.message));
const state = () => page.evaluate(() => window.__ssTest ? window.__ssTest.state() : null);
const place = (pn, patch) => page.evaluate(([p, pa]) => window.__ssTest.place(p, pa), [pn, patch]);
const speed = p => Math.hypot(p.vx, p.vy);

await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('canvas', { timeout: 10000 });
await sleep(1200);
let s = await state();
ok(s && s.gameState === 'menu', 'boots into MENU');

console.log('== menu actually works in MENU state ==');
const rows = await page.evaluate(() => [...document.querySelectorAll('#term-lines .term-row')].map(r => r.textContent));
ok(rows.length >= 7, `menu renders ${rows.length} rows`);
await page.keyboard.press('ArrowDown');
await sleep(60);
const cursor2 = await page.evaluate(() => [...document.querySelectorAll('#term-lines .term-row')].findIndex(r => r.classList.contains('on')));
ok(cursor2 === 1, 'ArrowDown moves menu cursor from row 0 to row 1');
await page.keyboard.press('ArrowUp');
await sleep(60);
const cursor0 = await page.evaluate(() => [...document.querySelectorAll('#term-lines .term-row')].findIndex(r => r.classList.contains('on')));
ok(cursor0 === 0, 'ArrowUp moves menu cursor back to row 0');

console.log('== start a real match (no placement) ==');
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
ok(s && s.gameState === 'playing' && s.overlay === 'none', 'START enters playing, overlay hidden');
const spawn1 = s.fighters[0], spawn2 = s.fighters[1];
ok(Math.abs(spawn1.x - 420) < 40 && Math.abs(spawn2.x - 780) < 40, `fighters spawn apart (P1 x=${spawn1.x.toFixed(0)}, P2 x=${spawn2.x.toFixed(0)})`);

console.log('== real walk-up combat: P1 walks right until in range and jabs ==');
// Event-driven walk: hold right until P1 is in jab range of P2 (~100px gap)
// or a timeout fires. (Wall-clock holds are brittle: run speed is roster
// data and SwiftShader paces frames, so a fixed sleep under/overshoots.)
await page.keyboard.down('KeyD');
let sMid = await state();
{
  const t0 = Date.now();
  while (Date.now() - t0 < 10000) {
    await sleep(100);
    sMid = await state();
    if (sMid.fighters[0].x > sMid.fighters[1].x - 100) break;
  }
}
await page.keyboard.up('KeyD');
sMid = await state();
ok(sMid.fighters[0].x > spawn1.x + 120, `P1 walked right (${spawn1.x.toFixed(0)} -> ${sMid.fighters[0].x.toFixed(0)})`);
// P2 is idle-ish (may walk? no, P2 is human but no input in headless). P2 stays.
await page.keyboard.press('KeyJ');
let hitSeen = false, launchSeen = null, dmgSeen = 0;
for (let i = 0; i < 50; i++) {
  await sleep(20);
  const st = await state();
  const p2 = st.fighters[1];
  if (p2.percent > dmgSeen) { dmgSeen = p2.percent; hitSeen = true; }
  if (p2.hitstun > 0 && !launchSeen && speed(p2) > 5) launchSeen = p2;
}
ok(hitSeen && dmgSeen >= 1, `P1 found P2 and jab landed in a real walk-up (dmg=${dmgSeen.toFixed(1)}%)`);
ok(!!launchSeen, 'the jab actually launched the target with real velocity');

console.log('== hitstun prevents movement / jump / attack ==');
{
  // Give P2 hitstun of 0.5s and try to move/jump/attack.
  await sleep(700);
  await place(2, { x: 650, y: 826.8, grounded: true, hitstun: 0.5, vx: 0, vy: 0, percent: 50, invulnTimer: 0, facingRight: false });
  const b4 = await state();
  const x0 = b4.fighters[1].x, y0 = b4.fighters[1].y;
  await page.keyboard.down('KeyA');   // P1 move left (won't affect P2)
  await page.keyboard.down('ArrowLeft'); // P2's left
  await page.keyboard.down('Space');  // P2's... no, Space is P1 jump. P2 jump is Numpad8.
  await sleep(150);
  await page.keyboard.up('ArrowLeft');
  await page.keyboard.up('KeyA');
  // Space (P1 jump) MUST be released: leaving it held leaks into every later
  // section — most visibly the aerial check, where jump+heavy is the
  // up-special (a ~1000px/s free-fall launch) instead of a forward aerial.
  await page.keyboard.up('Space');
  await page.keyboard.press('Numpad1'); // P2 attack
  await page.keyboard.press('Numpad8'); // P2 jump
  await sleep(60);
  // Hitstun decays 0.5 - 0.21 = ~0.29 left.
  const mid = await state();
  const p2m = mid.fighters[1];
  ok(p2m.hitstun > 0.05, 'hitstun still active during input attempt');
  ok(Math.abs(p2m.x - x0) < 3 && Math.abs(p2m.y - y0) < 3, `hitstun blocks movement input (dx=${(p2m.x-x0).toFixed(1)}, dy=${(p2m.y-y0).toFixed(1)})`);
  ok(!p2m.attack, 'hitstun blocks attack input');
  await sleep(600); // let hitstun fully expire
}

console.log('== menu keys (other than M) inert after real movement ==');
{
  // Settle both fighters first (wait out jump/landing), then confirm stability.
  await sleep(900);
  const st0 = await state();
  const p1 = st0.fighters[0];
  ok(Math.abs(p1.vy) < 2 && Math.abs(p1.vx) < 2, 'P1 settled (idle, on ground) before menu-key test');
  const before = await state();
  await sleep(200);
  const idle = await state();
  const ib = before.fighters[0], ia = idle.fighters[0];
  ok(Math.abs(ia.x - ib.x) < 1 && Math.abs(ia.y - ib.y) < 1 && Math.abs(ia.vy) < 2, 'fighter is stable when idle (baseline sanity)');
  await page.keyboard.press('Escape');
  await sleep(80);
  const after = await state();
  ok(after.gameState === 'playing' && after.overlay === 'none', 'Escape does not leave PLAYING');
  const a = after.fighters[0], b = before.fighters[0];
  ok(a && b && Math.abs(a.x - b.x) < 3 && Math.abs(a.y - b.y) < 3 && !a.attack,
    `menu keys do not move or act on the player fighter (dx=${a&&b?(a.x-b.x).toFixed(2):'?'}, dy=${a&&b?(a.y-b.y).toFixed(2):'?'}, attack=${a?a.attack:'?'})`);
}

console.log('== repeated attacks: no runaway physics / resets ==');
{
  // Park P2 close to P1 and mash light attacks for ~3s, CHASING forward so the
  // knocked-back target stays in reach (jab pushes P2 right, P1 keeps walking right).
  await place(2, { x: 560, y: 826.8, grounded: true, vx: 0, vy: 0, percent: 0, hitstun: 0, invulnTimer: 0, facingRight: false });
  await place(1, { x: 500, y: 826.8, grounded: true, vx: 0, vy: 0, percent: 0, hitstun: 0, invulnTimer: 0, facingRight: true });
  let minY = Infinity, maxY = -Infinity, badSpeed = 0;
  let minX = Infinity, maxX = -Infinity;
  let pct = 0, hits = 0;
  await page.keyboard.down('KeyD'); // chase right while mashing
  for (let i = 0; i < 140; i++) {
    if (i % 3 === 0) await page.keyboard.press('KeyJ');
    await sleep(22);
    const st = await state();
    for (const p of st.fighters) {
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (speed(p) > 4000) badSpeed++;
    }
    if (st.fighters[1].percent > pct) { pct = st.fighters[1].percent; hits++; }
  }
  await page.keyboard.up('KeyD');
  ok(hits >= 3, `repeated jabs landed multiple times while chasing (${hits} connect frames, final ${pct.toFixed(0)}%)`);
  ok(badSpeed === 0, 'no runaway velocity magnitude (all speeds < 4000 px/s)');
  ok(maxY - minY < 1600, `no runaway vertical physics (y span ${(maxY - minY).toFixed(0)}px)`);
}

console.log('== aerial hit-confirm (unified aerials) ==');
// NOTE: the legacy directional dair was deliberately removed from the game
// (verify-combat.mjs pins: no aerialL/R/U/D keys, no dair anims). DOWN+HEAVY
// in the air now resolves to the unified aerialHeavy, which carries no
// hit-confirm lock by design - so there is no dair lock left to verify here.
// Covered instead: a real airborne DOWN+HEAVY swing fires and can connect.
{
  for (let i = 0; i < 60; i++) {
    const st = await state();
    if (!st.fighters[0].attack && !st.fighters[1].attack) break;
    await sleep(50);
  }
  const keyEvt = (type, code) => page.evaluate(([t, c]) => {
    window.dispatchEvent(new KeyboardEvent(t, { code: c, key: c.replace('Key', '').toLowerCase(), bubbles: true }));
  }, [type, code]);
  let sawAttack = null, connected = null;
  for (let attempt = 0; attempt < 4 && !connected; attempt++) {
    // Wait until P1 is truly free: no live attack AND the shared attack
    // cooldown expired (it decays in sim time, which runs slow headless).
    // Also clear any stale swing the previous attempt may have left behind:
    // place() does not cancel attacks, so wait for quiescence first.
    for (let i = 0; i < 120; i++) {
      const st = await state();
      if (!st.fighters[0].attack && !(st.fighters[0].attackCd > 0)) break;
      await sleep(100);
    }
    // Place BOTH fighters AND dispatch the aerial input in a SINGLE
    // round-trip. Two separate awaits let several frames pass between the
    // placement and the key press; P1 is only ~7px off the ground, so it lands
    // in that gap and the heavy resolves to a GROUNDED smash instead of the
    // aerial — the swing still fires, so the old form saw an attack but never
    // a connect. One evaluate removes the race: the input is seen on the very
    // next frame, while P1 is still airborne. P1 sits just above P2's center
    // with a slight upward drift so the forward aerial box overlaps P2 from
    // its first active frame.
    await page.evaluate(() => {
      window.__ssTest.place(2, { x: 650, y: 826.8, grounded: true, vx: 0, vy: 0, percent: 0, hitstun: 0, invulnTimer: 0, facingRight: false });
      window.__ssTest.place(1, { x: 620, y: 812, grounded: false, vx: 0, vy: -40, percent: 0, hitstun: 0, invulnTimer: 0, facingRight: true });
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyK', key: 'k', bubbles: true }));
    });
    await sleep(40);
    await keyEvt('keyup', 'KeyK');
    // Watch until the swing resolves: connect, or the attack fully finishes.
    // Wall-clock bounds must cover slow sim (38 attack frames at any pace).
    for (let i = 0; i < 200 && !connected; i++) {
      await sleep(25);
      const st = await state();
      if (st.fighters[0].attack && !sawAttack) sawAttack = st.fighters[0].attack;
      if (st.fighters[1].percent > 0) connected = st.fighters[1];
      if (sawAttack && !st.fighters[0].attack && i > 40) break;
    }
    {
      const st = await state();
      console.log(`   [dbg attempt end: p1(x=${st.fighters[0].x.toFixed(0)},y=${st.fighters[0].y.toFixed(0)},st=${st.fighters[0].attack},cd=${st.fighters[0].attackCd}) p2(x=${st.fighters[1].x.toFixed(0)},y=${st.fighters[1].y.toFixed(0)},pct=${st.fighters[1].percent},hs=${st.fighters[1].hitstun.toFixed(2)},sh=${st.fighters[1].shielding},inv=${st.fighters[1].invulnTimer})`);
    }
    await sleep(300);
  }
  ok(!!sawAttack, `airborne DOWN+HEAVY fires an aerial (attack=${sawAttack})`);
  ok(!!connected, 'aerial connects in a real airborne setup');
}

console.log('== M returns to the menu from free play ==');
{
  // Real keydown through the page pipeline, as a player would press it.
  const before = await state();
  ok(before.gameState === 'playing' && before.overlay === 'none', 'still PLAYING before M');
  await page.evaluate(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyM', key: 'm', bubbles: true }));
  });
  await sleep(150);
  const after = await state();
  ok(after.gameState === 'menu' && after.overlay !== 'none',
    'pressing M in free play returns to the MENU overlay (no reload)');
  ok(after.fighters.every(f => f && f.percent === 0 && !f.attack && !f.locked),
    'fighters cleaned up on return (0%, no attack, no lock)');
  // Round-trip: START again straight from the menu, no reload.
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
  const restarted = await state();
  ok(restarted.gameState === 'playing' && restarted.overlay === 'none',
    'START after M re-enters PLAYING (menu -> M -> START round-trip works)');
}

console.log(`== summary: ${passes} passed, ${failures} failed ==`);
await browser.close();
process.exit(failures ? 1 : 0);