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
// Walk right for ~2.5s (run speed ~172 px/s from 420 -> ~850), then jab.
await page.keyboard.down('KeyD');
await sleep(1600);
await page.keyboard.up('KeyD');
let sMid = await state();
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

console.log('== down-air real-aerial hit-confirm ==');
{
  // Make sure P1 is fully out of any attack from the previous section before
  // re-placing, so the fresh aerial input is actually accepted.
  for (let i = 0; i < 60; i++) {
    const st = await state();
    if (!st.fighters[0].attack && !st.fighters[1].attack) break;
    await sleep(50);
  }
  // Real aerial flow: P1 airborne directly above a GROUNDED P2 (same x). P1 falls
  // onto the target; a real down-air input (hold DOWN, then press HEAVY a few
  // frames later, keep holding) connects as it descends. Key events are dispatched
  // through the page's own keydown pipeline (window.dispatchEvent) so delivery
  // order is deterministic (headless CDP key delivery races otherwise). Retried a
  // few times to absorb rAF timing, like a real player mashing would.
  const keyEvt = (type, code) => page.evaluate(([t, c]) => {
    window.dispatchEvent(new KeyboardEvent(t, { code: c, key: c.replace('Key', '').toLowerCase(), bubbles: true }));
  }, [type, code]);
  let locked = null, launchedUp = null, sawAttack = null;
  for (let attempt = 0; attempt < 4 && !launchedUp; attempt++) {
    await place(2, { x: 600, y: 826.8, grounded: true, vx: 0, vy: 0, percent: 0, hitstun: 0, invulnTimer: 0, facingRight: false });
    await place(1, { x: 600, y: 760, grounded: false, vx: 0, vy: 0, percent: 0, hitstun: 0, invulnTimer: 0, facingRight: true });
    await keyEvt('keydown', 'KeyS'); // DOWN held first...
    await sleep(60);
    await keyEvt('keydown', 'KeyK'); // ...then HEAVY pressed mid-hold -> dair
    await sleep(40);
    await keyEvt('keyup', 'KeyK');
    await keyEvt('keyup', 'KeyS');
    for (let i = 0; i < 80 && !launchedUp; i++) {
      await sleep(25);
      const st = await state();
      const p1 = st.fighters[0], p2 = st.fighters[1];
      if (p1.attack && !sawAttack) sawAttack = p1.attack;
      if (p1.locked && p2.locked && !locked) locked = { p1, p2 };
      if (p2.vy < -50 && p2.hitstun > 0) launchedUp = p2;
    }
    await sleep(300); // let the scene settle before a retry
  }
  ok(!!locked, `dair hit-confirm locks BOTH fighters on a successful hit (attack=${sawAttack}, real aerial setup)`);
  ok(!!launchedUp, `dair launches the target upward with real velocity (attack=${sawAttack}, vy=${launchedUp?launchedUp.vy.toFixed(1):'none'})`);
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