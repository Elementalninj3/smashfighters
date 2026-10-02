// verify-ninja-shadow-dash-shuriken.mjs — live end-to-end verification of the
// two ninja moves in the REAL shipped game (dev page :5173 with ?probe, driven
// through window.__ssTest). No mocks, no doubles — this is the same code a
// player hits.
//
// Every measurement is EVENT driven (wait for the move to start / the burst to
// begin / the move to end), never a fixed wall-clock sleep: the headless
// browser's frame rate swings with machine load, and a sleep-based test would
// measure a half-finished move instead of the move.
//
// Claims verified:
//
//   A. SHADOW DASH TRAVELS FORWARD IN THE PLAYER'S FACING DIRECTION, ALWAYS.
//      Facing right -> strictly +X. Facing left -> strictly -X. The travelled
//      distance is the same from EVERY position on the map, it is never aimed at
//      a fixed/world coordinate, a mouse position, a target or a previous
//      position, and nothing (world coords, opponent position, a facing flip, a
//      held opposite direction) can reverse or redirect it mid-dash.
//
//   B. THE EXISTING SHADOW DASH VFX IS PRESERVED AND ARMED ONCE: exactly one
//      shadowDash temp effect, on the cast frame, gone when the move ends.
//
//   C. THE SHURIKEN LIVES IN THE EXISTING WEAPON REGISTRY (anim.js):
//      registered by id, sprite-backed, mountable by an animation, and the
//      ninjaFsmash animation really carries it. No second weapon system.
//
//   D. SHURIKEN THROW SPAWNS AT THE HAND/WEAPON ANCHOR (never the fighter
//      centre) and flies forward in the facing direction, spinning in flight.
//
//   E. SHORT RANGE: max travel = speed x life (~315px). It connects inside that
//      and is GONE at max range; it never survives a hit (no pass-through) and
//      never leaves the stage.
//
//   F. ON-HIT: configured damage through the normal damage system, then a
//      ~0.5s hit-lock that genuinely freezes the TARGET in place (position
//      pinned, no input, no acting), released cleanly back to normal physics.
//      A second shuriken landing mid-lock deals its damage but NEVER extends
//      the lock.
//
//   G. NO CONSOLE / PAGE ERRORS during any of the above.
//
// Run: node tests/verify-ninja-shadow-dash-shuriken.mjs   (dev server :5173)

import { chromium } from 'playwright';

const URL = 'http://localhost:5173/?probe';
const EXE  = 'C:/Users/User/AppData/Local/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-win64/chrome-headless-shell.exe';

// The ninja's damage is buffed x1.4 TWICE over the shared balance table
// (see NINJA_ATTACKS header), so the two moves this suite measures are
// 4.8 -> 9.408 (the shuriken, whose damage lives in ABILITIES.ninjaFsmash)
// and 2.4 -> 4.704 (the Teleport Strike, NINJA_ATTACKS.dtilt).
// Named once here so the expectations below read as "the move's own number"
// rather than a magic literal repeated in six places.
const SHURIKEN_DMG = 9.408;
const DTILT_DMG = 4.704;

let passes = 0, failures = 0;
function ok(cond, msg) {
  if (cond) { passes++; console.log('  PASS  ' + msg); }
  else { failures++; console.log('  FAIL  ' + msg); }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const browser = await chromium.launch({ headless: true, executablePath: EXE, args: ['--no-sandbox', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 900, height: 940 } });
const errors = [];
page.on('pageerror', e => { errors.push('pageerror: ' + e.message); console.log('[pageerror]', e.message); });
page.on('console', m => {
  if (m.type() === 'error') { errors.push('console.error: ' + m.text()); console.log('[console.error]', m.text()); }
});

const state   = () => page.evaluate(() => window.__ssTest ? window.__ssTest.state() : null);
const place   = (pn, p) => page.evaluate(([n, q]) => window.__ssTest.place(n, q), [pn, p]);
const attack  = (pn, k, dir) => page.evaluate(([n, kk, dd]) => window.__ssTest.attack(n, kk, dd || {}), [pn, k, dir]);
const resolved= (k) => page.evaluate(kk => window.__ssTest.resolvedDef(kk), k);
const projs   = (pn) => page.evaluate(n => window.__ssTest.projectiles(n), pn);
const vfx     = (pn) => page.evaluate(n => window.__ssTest.vfx(n), pn);
const pose    = (pn) => page.evaluate(n => window.__ssTest.pose(n), pn);

const G = 826.8; // top of the stage platform
const gp = (x, facingRight = true) => ({ x, y: G, grounded: true, vx: 0, vy: 0, percent: 0, hitstun: 0, invulnTimer: 0, facingRight });

const fighter = async (pn) => (await state()).fighters[pn - 1];

// Wait until `pred(fighterState)` is true (or 8s). Returns the last state read.
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

// Trigger a move and follow it to completion. Returns the x/y trace plus the
// moment the burst actually started (first frame with the burst velocity), so
// callers can act mid-move without depending on the frame rate.
async function runMove(pn, key, dir, onBurst, faceLeftOnPress) {
  if (faceLeftOnPress) {
    // Plant the facing and press in the SAME task, so no game frame can run in
    // between and re-orient the body before the direction is captured.
    await page.evaluate(([n, kk, dd]) => {
      window.__ssTest.place(n, { facingRight: false });
      window.__ssTest.attack(n, kk, dd || {});
    }, [pn, key, dir]);
  } else {
    await attack(pn, key, dir);
  }
  const tr = [];
  let seenStart = false, burstIdx = -1, endMs = -1;
  const t0 = Date.now();
  while (Date.now() - t0 < 12000) {
    const s = await state();
    const f = s && s.fighters[pn - 1];
    if (!f) { await sleep(8); continue; }
    tr.push({ x: f.x, y: f.y, vx: f.vx, vy: f.vy, atk: f.attack, lock: f.hitLockTimer, pct: f.percent });
    if (f.attack) seenStart = true;
    if (burstIdx < 0 && Math.abs(f.vx) > 200) {
      burstIdx = tr.length - 1;
      if (onBurst) await onBurst();          // flip the facing / poke input mid-dash
    }
    if (seenStart && f.attack === null && burstIdx >= 0) { endMs = Date.now() - t0; break; }
    if (seenStart && f.attack === null && tr.length > 6) { endMs = Date.now() - t0; break; }
    await sleep(8);
  }
  return { tr, burstIdx, endMs };
}

// The dash pays out of a fixed pixel budget, so the travel is the authored
// dashDistance, not a frame-rate-dependent approximation. Sub-pixel tolerance
// only, for the trace's own sampling.
const DIST_TOL = 1.5;

console.log('== boot: menu -> Ninja (P1) vs Cowboy (P2) -> START ==');
await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('canvas', { timeout: 20000 });
await sleep(1200);
let s = await state();
ok(s && s.gameState === 'menu', 'boots into the MENU state');
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
ok(s && s.fighters[0] && s.fighters[0].attackKey === null, 'P1 is the ninja and starts idle');

// ── A. SHADOW DASH: forward in the facing direction, from anywhere ────────
console.log('== A. Shadow Dash travels FORWARD in the facing direction (never toward a world coord) ==');
{
  const d = await resolved('dsmash');
  ok(!!d && d.abilityType === 'nonHitbox' && d.abilityId === 'ninjaDsmash',
    'Down Smash resolves to the existing nonHitbox ninjaDsmash ability (id=' + (d && d.abilityId) + ')');
  const dashDistance = d ? d.dashDistance : null;
  ok(dashDistance != null && dashDistance > 0, 'the move owns a fixed dash distance (dashDistance=' + dashDistance + ')');
  // The strike box is declared to stay live for the WHOLE burst: the dash runs
  // dashDistance / dashSpeed = 192 / 800 = 0.24s = ~14 frames at 60fps.
  ok(d && d.active === 14,
    'the dash-strike hitbox window covers the whole burst (active=' + (d && d.active) + ' frames)');
  ok(d && d.active + d.startup < 32,
    'and it still fits inside the move (cast ' + d.startup + ' + active ' + d.active
      + ' < the ability\'s 32 frames), so the move is not made longer');

  // Opponent parked far off to the RIGHT of a left-facing dash: the dash must
  // ignore him completely and travel LEFT.
  await place(1, gp(600, false));
  await place(2, gp(950, false));
  await waitFor(1, f => !f.attack);
  const L = await runMove(1, 'dsmash', { down: true });
  const lDx = L.tr[L.tr.length - 1].x - L.tr[0].x;
  ok(lDx < -20, 'facing LEFT -> the dash travels LEFT (dx=' + lDx.toFixed(1) + ')');
  const lBurst = L.tr.slice(L.burstIdx);
  ok(lBurst.every((p, i) => i === 0 || p.x <= lBurst[i - 1].x + 1.5),
    'never moves BACKWARD mid-dash (monotonic, ' + lBurst.length + ' frames)');
  ok(Math.abs(lDx) > dashDistance * 0.8 && Math.abs(lDx) < dashDistance * 1.2,
    'travels the fixed distance forward, not to a target (|dx|=' + Math.abs(lDx).toFixed(1) + ' vs ' + dashDistance + ')');

  // Same move, facing RIGHT, from a different spot.
  await place(1, gp(600, true));
  await place(2, gp(250, true));
  await waitFor(1, f => !f.attack);
  const R = await runMove(1, 'dsmash', { down: true });
  const rDx = R.tr[R.tr.length - 1].x - R.tr[0].x;
  ok(rDx > 20, 'facing RIGHT -> the dash travels RIGHT (dx=' + rDx.toFixed(1) + ')');
  const rBurst = R.tr.slice(R.burstIdx);
  ok(rBurst.every((p, i) => i === 0 || p.x >= rBurst[i - 1].x - 1.5),
    'never moves BACKWARD mid-dash (monotonic, ' + rBurst.length + ' frames)');
  ok(Math.abs(Math.abs(rDx) - Math.abs(lDx)) < DIST_TOL,
    'right and left dashes cover the SAME distance (' + rDx.toFixed(1) + ' vs ' + lDx.toFixed(1) + ')');

  // The longer strike window, proven by BEHAVIOUR rather than by reading the
  // number: park the opponent so the ninja only reaches them near the END of the
  // burst. The 96px box (centred on the fighter) touches the opponent's hurtbox
  // only after ~90px of the 192px dash — about frame 7 at 800px/s. With the old
  // 3-frame window the box was already dead by then and the dash whiffed; with
  // the window covering the burst it connects.
  await place(1, gp(300, true));
  const lateGap = 192 - 30;          // opponent this far downstage of the start
  await place(2, gp(300 + lateGap, true));
  await waitFor(1, f => !f.attack);
  await waitFor(2, f => !f.attack);
  await sleep(200);
  // Precondition: the opponent really is out of reach of a 3-frame strike box.
  // The 96px box is centred on the fighter, so it touches the opponent's hurtbox
  // only after ~90px of the 192px dash — frame ~7 at 800px/s.
  ok(lateGap - 48 - 22 > 3 * (800 / 60),
    'the opponent is placed out of a 3-frame box\'s reach (first contact at ~'
      + ((lateGap - 48 - 22) / (800 / 60)).toFixed(1) + ' frames into the burst)');
  await runMove(1, 'dsmash', { down: true });
  const lateF = await waitFor(2, f => f.percent > 0, 3000);
  ok(lateF && lateF.percent > 0,
    'the strike box is STILL live late in the burst and connects (percent=' + (lateF && lateF.percent) + ')');
  await waitFor(2, f => !f.attack, 3000);
  await sleep(200);

  // Different map positions: the END position must always be start +/- fixed,
  // never the same world coordinate. The opponent is parked clear of the dash
  // path — body separation would otherwise push the dashing fighter around and
  // pollute the distance being measured.
  const runs = [];
  for (const [startX, face] of [[260, true], [480, true], [760, false], [930, false]]) {
    await place(1, gp(startX, face));
    // Parked clear of the whole burst: the dash ends at start +/- dashDistance,
    // and the opponent's near edge is kept a further body-width beyond that, so
    // body separation can never reach into the distance being measured.
    await place(2, gp(face ? startX + dashDistance + 60 : startX - dashDistance - 60, face));
    await waitFor(1, f => !f.attack);
    const m = await runMove(1, 'dsmash', { down: true });
    runs.push({ startX: m.tr[0].x, endX: m.tr[m.tr.length - 1].x, dx: m.tr[m.tr.length - 1].x - m.tr[0].x, face });
  }
  for (const r of runs) {
    const want = (r.face ? 1 : -1) * dashDistance;
    ok(Math.sign(r.dx) === (r.face ? 1 : -1) && Math.abs(r.dx - want) < DIST_TOL,
      'from x=' + r.startX.toFixed(0) + ' facing ' + (r.face ? 'RIGHT' : 'LEFT') + ': dx=' + r.dx.toFixed(1) + ' (want ' + want + ')');
  }
  const ends = new Set(runs.map(r => Math.round(r.endX)));
  ok(ends.size === runs.length,
    'the dash never lands on a FIXED map coordinate (end x = ' + [...ends].sort((p, q) => p - q).join(', ') + ')');

  // Mid-dash facing flip must NOT reverse the dash: flip the instant the burst
  // starts, while it is genuinely live.
  await place(1, gp(600, false));
  await place(2, gp(950, true));
  await waitFor(1, f => !f.attack);
  let flipped = false;
  const F = await runMove(1, 'dsmash', { down: true }, async () => {
    flipped = true;
    await place(1, { facingRight: true });
  });
  const fDx = F.tr[F.tr.length - 1].x - F.tr[0].x;
  ok(flipped, 'the facing was flipped WHILE the burst was live (mid-dash)');
  ok(fDx < -20, 'flipping the facing MID-DASH does not reverse it (dx=' + fDx.toFixed(1) + ')');
  ok(Math.abs(fDx + dashDistance) < DIST_TOL,
    'the flipped-facing dash still travelled ~' + dashDistance + 'px forward (dx=' + fDx.toFixed(1) + ')');

  // A direction held during startup must not re-aim the dash either: the facing
  // is captured at activation, so holding the opposite way is exactly what a
  // player does. Re-plant and press in ONE task so no game frame can turn the
  // body back before the direction is captured.
  await page.keyboard.down('ArrowRight');
  await sleep(200);                               // let the held key walk/turn the body
  await waitFor(1, f => !f.attack);
  const H = await runMove(1, 'dsmash', { down: true }, null, true);
  await page.keyboard.up('ArrowRight');
  const hXs = H.tr.map(p => p.x);
  ok(Math.min(...hXs) < 600 - 60,
    'holding the OPPOSITE direction (right) with the body facing LEFT still dashes LEFT (min x=' + Math.min(...hXs).toFixed(1) + ')');
  ok(Math.max(...hXs) < 600 + 60,
    'the opposite held direction never re-aims it to the right (max x=' + Math.max(...hXs).toFixed(1) + ')');
}

console.log('== B. the existing Shadow Dash VFX is preserved and armed once ==');
{
  await place(1, gp(400, true));
  await place(2, gp(950, true));
  await waitFor(1, f => !f.attack);
  // Let the PREVIOUS move's effect retire first, so this is a real baseline
  // rather than a race with the tail of the last dash.
  const tBase = Date.now();
  while (Date.now() - tBase < 2000
         && (await vfx(1)).temp.filter(v => v.effect === 'shadowDash').length > 0) await sleep(20);
  const before = await vfx(1);
  ok(before.temp.filter(v => v.effect === 'shadowDash').length === 0, 'no shadowDash VFX before the move');

  await attack(1, 'dsmash', { down: true });
  // The VFX is armed on the cast frame and dies with the move, so watch for its
  // APPEARANCE rather than guessing when it should already be on screen.
  let peak = 0, dup = false, armed = null;
  const t0 = Date.now();
  while (Date.now() - t0 < 4000) {
    const st = await state();
    const f = st.fighters[0];
    const list = (await vfx(1)).temp.filter(v => v.effect === 'shadowDash');
    if (list.length > peak) { peak = list.length; armed = list[0] || armed; }
    if (list.length > 1) dup = true;
    if (peak > 0 && f.attack === null) break;   // move finished
    await sleep(10);
  }
  ok(peak === 1, 'exactly ONE shadowDash effect is armed by the cast (peak on screen=' + peak + ')');
  ok(!dup, 'it is never stacked/duplicated during the dash');
  ok(armed && armed.anchor === 'character', 'it is anchored to the fighter body (anchor=' + (armed && armed.anchor) + ')');
  ok(armed && armed.mirrorX === 1, 'it is mirrored to the dash direction (mirrorX=' + (armed && armed.mirrorX) + ')');
  await waitFor(1, f => !f.attack);
  await sleep(60);
  const after = await vfx(1);
  ok(after.temp.filter(v => v.effect === 'shadowDash').length === 0, 'the VFX is GONE once the move ends');
  const ps = await projs(1);
  ok(Array.isArray(ps) && ps.length === 0, 'the dash registers no projectile (it is not a bullet)');
}

console.log('== C. the Shuriken is in the EXISTING weapon registry ==');
{
  const lib = await page.evaluate(async () => {
    const w = await import('/src/anim.js');
    const a = await import('/src/anim.js');
    const all = w.allWeapons();
    const raw = all.find(x => x.id === 'shuriken');
    const def = w.getWeapon('shuriken');
    return {
      count: all.length,
      has: !!raw,
      def: def ? { id: def.id, name: def.name, type: def.type, sprite: def.sprite, w: def.w, h: def.h, mirror: def.mirror, anchors: def.anchors, vfxAnchor: def.vfxAnchor } : null,
      listed: all.some(x => x.id === 'shuriken'),
      animWeapon: (a.getAnimationRaw('ninjaFsmash') || {}).weapons,
    };
  });
  ok(lib.has && lib.listed, 'shuriken is registered in the shared weapon library (id present in allWeapons())');
  ok(lib.def && lib.def.sprite === '/GA/weapons/shuriken.png', 'it is backed by the provided asset (sprite=' + (lib.def && lib.def.sprite) + ')');
  ok(lib.def && lib.def.type === 'throwing' && lib.def.anchors && lib.def.anchors.grip && lib.def.anchors.tip,
    'it carries normal weapon anchors (grip/tip) like every other weapon');
  ok(!!(lib.animWeapon && lib.animWeapon.right && lib.animWeapon.right.id === 'shuriken'),
    'the ninjaFsmash animation mounts it through the normal per-animation weapon config');
  const imgOk = await page.evaluate(() => new Promise(res => {
    const im = new Image();
    im.onload = () => res({ w: im.naturalWidth, h: im.naturalHeight });
    im.onerror = () => res({ w: 0, h: 0 });
    im.src = '/GA/weapons/shuriken.png';
  }));
  ok(imgOk.w > 0 && imgOk.h > 0, 'the shuriken sprite loads in the browser (' + imgOk.w + 'x' + imgOk.h + ')');
  const fd = await resolved('fsmash');
  ok(!!fd && fd.abilityType === 'nonHitbox' && fd.abilityId === 'ninjaFsmash',
    'Side Smash resolves to the existing nonHitbox ninjaFsmash ability (id=' + (fd && fd.abilityId) + ')');
  ok(!!fd && fd.name === 'Shuriken Throw' && fd.dmg === SHURIKEN_DMG,
    'it is the Shuriken Throw with its configured damage (name=' + (fd && fd.name) + ', dmg=' + (fd && fd.dmg) + ')');
}

console.log('== D. Shuriken Throw spawns at the HAND and flies forward, spinning ==');
{
  await place(1, gp(400, true));
  await place(2, gp(950, false));   // out of the shuriken's range, so its flight can be watched
  await waitFor(1, f => !f.attack);
  await attack(1, 'fsmash', { right: true });
  // The shuriken's life is short (~0.15s), so its trace has to be collected in
  // the SAME loop that spots its birth: any extra round trip between the two —
  // a fighter read, a pose read — can eat most of the flight that is left, and
  // the trace ends up with a sample or two.
  const flight = [];
  let born = null, hand = null, f = null;
  const tb = Date.now();
  while (Date.now() - tb < 6000) {
    const list = await projs(1);
    if (!list.length) { if (born) break; await sleep(6); continue; }
    if (!born) {
      born = list[0];
      f = (await state()).fighters[0];
      const pp = await pose(1);
      hand = pp && pp.weapons && pp.weapons.right;
    }
    flight.push(list[0]);
    await sleep(6);
  }
  ok(!!born, 'exactly ONE shuriken spawns');
  ok(born && born.def && born.def.name === 'Shuriken Throw', 'it carries the move\'s own damage def (name=' + (born && born.def && born.def.name) + ')');
  ok(born && born.vx > 0 && born.vy === 0, 'facing RIGHT -> flies FORWARD horizontally (vx=' + (born && born.vx) + ', vy=' + (born && born.vy) + ')');
  ok(born && f && born.x > f.x + 20, 'it spawns AHEAD of the body, at the hand/weapon (x=' + (born && born.x) + ' vs body ' + (f && f.x.toFixed(1)) + ')');
  ok(born && f && born.x - f.x < 140 && Math.abs(born.y - f.y) < 70,
    'it spawns at the WEAPON anchor, not the fighter centre (offset ' + (born && (born.x - f.x).toFixed(1)) + ',' + (born && (born.y - f.y).toFixed(1)) + ')');
  ok(hand && born && Math.hypot(hand.px - born.x, hand.py - born.y) < 90,
    'the spawn sits on the drawn weapon (weapon px,py=' + (hand && hand.px.toFixed(0) + ',' + hand.py.toFixed(0)) + ')');
  const last = flight[flight.length - 1];
  ok(flight.length > 2 && last.x > born.x, 'it keeps travelling forward (x ' + born.x + ' -> ' + last.x + ')');
  ok(flight.length > 2 && last.spin > born.spin, 'it SPINS in flight (spin ' + born.spin + ' -> ' + last.spin + ')');
  ok((await projs(1)).length === 0, 'it is consumed / expires, leaving nothing behind');
  const travel = last.x - born.x;
  // Authored range = speed x life = 720 x 0.15 = 108px (half the previous
  // 216px throw). The measured travel is a little under that because the first
  // frame retires the life clock before it moves, so the band is "about 108px",
  // wide enough for sub-pixel sampling but nowhere near the old 216 or the
  // generic bullet's ~730.
  ok(travel > 60 && travel < 130,
    'its range is ~108px, half the old throw (speed x life, measured ' + travel.toFixed(0) + 'px)');
  // The thrown object is the REGISTERED shuriken weapon, which is what makes the
  // renderer draw the real shuriken.png through the shared weapon renderer
  // instead of a shape generated just for the projectile.
  ok(born.weaponId === 'shuriken',
    'the projectile IS the registered shuriken weapon (weaponId=' + born.weaponId + '), so it is drawn as the real sprite');
  // Drawn at SHURIKEN_DRAW_SCALE (1.2x) of the registered weapon's authored
  // 32px, so the blade reads as a thrown star without dwarfing the fighter.
  const authoredW = await page.evaluate(async () => {
    const w = await import('/src/anim.js');
    const d = w.getWeapon('shuriken');
    return d ? d.w : null;
  });
  ok(!!born.drawSize && authoredW != null && Math.abs(born.drawSize - authoredW * 1.2) < 0.01,
    'it is drawn at the authored weapon scale (drawSize=' + born.drawSize
      + ' = 1.2 x ' + authoredW + 'px)');
  // The hurtbox is derived from the SAME number as the art, and is held at the
  // move's original ~8px core so shrinking the drawing did not quietly weaken
  // the throw.
  ok(!!born.r && born.r > 6 && born.r <= 9,
    'the hurtbox stayed at the original ~8px core while the art shrank (r=' + born.r + ')');

  // Facing left: mirror.
  await place(1, gp(700, false));
  await place(2, gp(540, true));
  await waitFor(1, f2 => !f2.attack);
  const fL = await fighter(1);
  await attack(1, 'fsmash', { left: true });
  const bornL = await (async () => {
    const t0 = Date.now();
    while (Date.now() - t0 < 6000) {
      const list = await projs(1);
      if (list.length) return list[0];
      await sleep(6);
    }
    return null;
  })();
  ok(bornL && bornL.vx < 0, 'facing LEFT -> flies BACKWARD (vx=' + (bornL && bornL.vx) + ')');
  ok(bornL && bornL.x < fL.x - 20, 'it spawns AHEAD in the left direction (x=' + (bornL && bornL.x) + ' vs body ' + fL.x.toFixed(1) + ')');
  await waitFor(1, f2 => !f2.attack);
  await sleep(400);
}

console.log('== E. short range: connects in range, dies at max range, never passes through ==');
{
  // In range (150px): connects.
  await place(1, gp(400, true));
  await place(2, gp(550, false));
  await waitFor(1, f => !f.attack);
  await attack(1, 'fsmash', { right: true });
  const hit = await waitFor(2, f => f.percent > 0, 4000);
  ok(hit && Math.abs(hit.percent - SHURIKEN_DMG) < 0.01,
    'a shuriken inside range HITS (percent=' + (hit && hit.percent) + ' = ' + SHURIKEN_DMG + ')');

  // On a hit the shuriken does NOT blink out and does NOT sail on through the
  // target: it buries itself in the target and stays there, inert, for the hit
  // lock. So it is still tracked right after the hit, it is AT the target (not
  // beyond it), and it never deals the damage a second time while stuck.
  const stuckNow = (await projs(1))[0];
  const tgtNow = (await state()).fighters[1];
  ok(!!stuckNow && stuckNow.stuck === true,
    'the shuriken STICKS in the target on the hit instead of vanishing');
  ok(!!stuckNow && Math.abs(stuckNow.x - tgtNow.x) < 1 && Math.abs(stuckNow.y - tgtNow.y) < 1,
    'the stuck shuriken sits ON the target, not past it (dx=' +
      (stuckNow ? (stuckNow.x - tgtNow.x).toFixed(1) : 'n/a') + ')');
  // Watch it for the whole lock window: it must not deal damage again, and it
  // must be cleaned up once the lock is over. The window is generous on purpose:
  // the engine clamps dt to 1/30, so when the headless frame rate drops, GAME
  // time runs slower than wall-clock and 0.5s of lock can take seconds of real
  // time. What is asserted is that it IS cleaned up, not that it is quick.
  const stickSamples = [];
  const tStick = Date.now();
  let cleanedUp = false;
  while (Date.now() - tStick < 6000) {
    const s = await state();
    const list = await projs(1);
    stickSamples.push({ pct: s.fighters[1].percent, n: list.length, spin: list[0] ? list[0].spin : null });
    if (!list.length) { cleanedUp = true; break; }
    await sleep(20);
  }
  const spinVals = stickSamples.map(s => s.spin).filter(v => typeof v === 'number');
  ok(spinVals.length > 1 && spinVals[spinVals.length - 1] > spinVals[0],
    'the stuck shuriken KEEPS SPINNING while it is embedded (spin ' +
      (spinVals.length ? spinVals[0].toFixed(2) + ' -> ' + spinVals[spinVals.length - 1].toFixed(2) : 'n/a') + ')');
  ok(stickSamples.every(s => Math.abs(s.pct - SHURIKEN_DMG) < 0.01),
    'the embedded shuriken never damages the target a second time (percent stayed ' +
      stickSamples[stickSamples.length - 1].pct + ')');
  ok(cleanedUp, 'the stuck shuriken is cleaned up when the lock ends');

  // Out of range (600px): never reaches, expires, no damage.
  await place(1, gp(300, true));
  await place(2, gp(900, false));
  await waitFor(1, f => !f.attack);
  await sleep(700); // let the previous target recover
  await place(2, gp(900, false));
  await place(1, gp(300, true));
  await attack(1, 'fsmash', { right: true });
  const seen = [];
  const t0 = Date.now();
  while (Date.now() - t0 < 4000) {
    const list = await projs(1);
    if (list[0]) { seen.push(list[0].x); await sleep(20); }
    else if (seen.length) break;
  }
  const st = await state();
  ok(st.fighters[1].percent === 0, 'a shuriken BEYOND max range never damages the target (percent=' + st.fighters[1].percent + ')');
  ok(seen.length > 0 && Math.max(...seen) - 300 < 200,
    'it dies well short of a distant target (max x=' + (seen.length ? Math.max(...seen).toFixed(0) : 'n/a')
      + ', target at 900 — ' + (seen.length ? (Math.max(...seen) - 300).toFixed(0) : 'n/a') + 'px of travel)');
  ok(seen.length > 0, 'it EXPIRES at max range and is cleaned up');
}

console.log('== F. on-hit: damage, then a ~0.5s lock that FREEZES the target, then release ==');
{
  await place(1, gp(400, true));
  await place(2, gp(550, false));
  await waitFor(1, f => !f.attack);
  await attack(1, 'fsmash', { right: true });

  // Watch the target: the lock must be REAL (position pinned), not a visual pause.
  let lockSeen = 0, maxLock = 0, frozenOK = true, actedWhileLocked = false;
  const samples = [];
  const t0 = Date.now();
  let hitPct = 0, releasedAt = -1, xAtRelease = 0;
  while (Date.now() - t0 < 8000) {
    const st = await state();
    const t = st.fighters[1];
    samples.push({ x: t.x, y: t.y, lock: t.hitLockTimer, hitstun: t.hitstun, atk: t.attack, pct: t.percent, inv: t.invulnTimer });
    if (t.percent > hitPct) hitPct = t.percent;
    if (t.hitLockTimer > 0) {
      lockSeen++;
      maxLock = Math.max(maxLock, t.hitLockTimer);
      if (samples.length > 2) {
        const prev = samples[samples.length - 2];
        if (Math.abs(t.x - prev.x) > 0.6 || Math.abs(t.y - prev.y) > 0.6) frozenOK = false;
      }
      if (t.attack) actedWhileLocked = true;
    } else if (maxLock > 0 && releasedAt < 0) {
      releasedAt = Date.now() - t0;
      xAtRelease = t.x;
    }
    if (releasedAt > 0 && Date.now() - t0 > releasedAt + 700) break;
    await sleep(12);
  }
  const st2 = await state();
  const maxX = Math.max(...samples.map(s2b => s2b.x));
  ok(hitPct > SHURIKEN_DMG - 0.5 && hitPct < SHURIKEN_DMG + 0.5,
    'the hit deals its configured damage (percent=' + hitPct.toFixed(2) + ', expected ' + SHURIKEN_DMG + ')');
  ok(maxLock > 0.3 && maxLock <= 0.52, 'the lock is ~0.5s (max=' + maxLock.toFixed(3) + ')');
  ok(lockSeen >= 5, 'the lock is live for a real number of frames (' + lockSeen + ' samples)');
  ok(frozenOK, 'the TARGET is genuinely FROZEN in place during the lock (no movement)');
  ok(!actedWhileLocked, 'the target cannot act during the lock');
  ok(releasedAt > 0, 'the lock RELEASES cleanly (at +' + releasedAt + 'ms, hitLockTimer=' + st2.fighters[1].hitLockTimer + ')');
  ok(releasedAt > 0 && maxX - xAtRelease > 1.5,
    'the target MOVES again after the release (x ' + xAtRelease.toFixed(1) + ' -> ' + maxX.toFixed(1) + ')');
  ok(st2.fighters[1].attack === null && st2.fighters[1].grounded !== undefined,
    'normal control/physics are restored after the release');

  // A second shuriken landing mid-lock must deal damage but NOT extend the lock.
  await place(1, gp(380, true));
  await place(2, gp(530, false));
  await waitFor(1, f => !f.attack);
  await attack(1, 'fsmash', { right: true });
  const locked = await waitFor(2, f => f.hitLockTimer > 0, 4000);
  const lk = locked ? locked.hitLockTimer : 0;
  await attack(1, 'fsmash', { right: true }); // second throw (probe bypasses the start lock)
  const after = await waitFor(2, f => f.percent > 9.5, 4000);
  ok(lk > 0, 'the first shuriken started a lock (timer=' + lk.toFixed(3) + ')');
  ok(after && after.percent > 9.5, 'the second shuriken still deals damage (percent=' + (after && after.percent.toFixed(2)) + ')');
  const afterF = await fighter(2);
  ok(afterF.hitLockTimer < lk,
    'the second shuriken NEVER extends the running lock (' + lk.toFixed(3) + ' -> ' + afterF.hitLockTimer.toFixed(3) + ')');
  await waitFor(2, f => f.hitLockTimer === 0, 4000);
  const rel = await fighter(2);
  ok(rel.hitLockTimer === 0, 'the lock still releases on schedule after the double hit');
  ok(rel.grounded !== undefined, 'the target keeps normal physics after release');
}

console.log('== H. Down Light is a real Teleport Strike (not a plain sweep) ==');
{
  // It must be routed to the ability through the existing animation binding,
  // and the strike's numbers must still be the shared attack table's.
  const d = await resolved('dtilt');
  ok(d && d.abilityId === 'ninjaDtilt',
    'Down Light resolves to the existing nonHitbox ninjaDtilt ability (id=' + (d && d.abilityId) + ')');
  ok(d && d.name === 'Teleport Strike', 'it is the Teleport Strike (name=' + (d && d.name) + ')');
  ok(d && d.dmg === DTILT_DMG, 'the strike keeps the attack table damage (dmg=' + (d && d.dmg) + ', expected ' + DTILT_DMG + ')');
  ok(d && d.angle === 0 && d.horizontalKnockback === 1 && d.verticalKnockback === 0,
    'the strike is pure HORIZONTAL knockback (angle=' + (d && d.angle)
      + ', h=' + (d && d.horizontalKnockback) + ', v=' + (d && d.verticalKnockback) + ')');

  // Target facing RIGHT -> "behind" is on the target's LEFT, and vice versa. The
  // ninja must land on that side, at the opponent's height, facing into the
  // strike. `behind` is the sign of (target.x - ninja.x): +1 = the ninja landed
  // to the target's left, -1 = to its right.
  for (const [tgtFace, behind, label] of [[true, 1, 'RIGHT'], [false, -1, 'LEFT']]) {
    await place(1, gp(300, !tgtFace));   // start on the opposite side of the target
    await place(2, gp(520, tgtFace));
    await waitFor(1, f => !f.attack);
    await waitFor(2, f => !f.attack);
    await sleep(150);
    const p1x = (await fighter(1)).x;
    const t1 = (await state()).fighters[1];
    await attack(1, 'dtilt', {});
    // The warp happens on the cast frame; sample densely for the landing.
    let landed = null;
    for (let i = 0; i < 60; i++) {
      const s = (await state()).fighters;
      const moved = Math.abs(s[0].x - p1x) > 20;
      if (moved) { landed = { x: s[0].x, y: s[0].y, facingRight: s[0].facingRight }; break; }
      if (!s[0].attack && i > 8) break;
      await sleep(10);
    }
    ok(!!landed, 'facing ' + label + ': the ninja teleports (moved off x=' + p1x.toFixed(1) + ')');
    if (landed) {
      const dxToTarget = t1.x - landed.x;
      ok(Math.sign(dxToTarget) === behind,
        'facing ' + label + ': it lands BEHIND the opponent (target ' + t1.x.toFixed(1)
          + ', ninja ' + landed.x.toFixed(1) + ', dx=' + dxToTarget.toFixed(1) + ' = ' + (behind > 0 ? 'left' : 'right') + ')');
      ok(Math.abs(landed.y - t1.y) < 30,
        'facing ' + label + ': it lands at the opponent height (y ' + landed.y.toFixed(1) + ' vs ' + t1.y.toFixed(1) + ')');
      ok(landed.facingRight === (behind > 0),
        'facing ' + label + ': it turns to FACE the opponent (facingRight=' + landed.facingRight + ')');
      ok(Math.abs(Math.abs(dxToTarget) - 62) < 6,
        'facing ' + label + ': it stops just outside contact range (gap=' + Math.abs(dxToTarget).toFixed(1) + 'px)');
    }
    // And the strike that follows is a real, shared-registry hit: damage from
    // the attack table, launched horizontally AWAY from the ninja.
    const hitF = await waitFor(2, f => f.percent > 0, 3000);
    ok(hitF && Math.abs(hitF.percent - DTILT_DMG) < 0.01,
      'facing ' + label + ': the strike lands the attack table damage (percent=' + (hitF && hitF.percent) + ')');
    const s2 = await state();
    const tk = s2.fighters[1], nk = s2.fighters[0];
    // "Away from the ninja" means moving further along (target.x - ninja.x):
    // target to the right of the ninja -> vx positive, and vice versa.
    ok(tk.vx * (tk.x - nk.x) > 0,
      'facing ' + label + ': the knockback goes horizontally AWAY from the ninja (target vx='
        + tk.vx.toFixed(1) + ' at dx=' + (tk.x - nk.x).toFixed(1) + ')');
    ok(Math.abs(tk.vy) < 1e-6,
      'facing ' + label + ': the launch is horizontal, not up (vy=' + tk.vy.toFixed(3) + ')');
    await waitFor(2, f => !f.attack, 3000);
    await sleep(200);
  }

  // No opponent in range: the move must NOT warp and must NOT swing at nothing.
  await place(1, gp(300, true));
  await place(2, gp(1000, true));
  await waitFor(1, f => !f.attack);
  await sleep(200);
  const preX = (await fighter(1)).x;
  await attack(1, 'dtilt', {});
  await sleep(120);
  const far = await fighter(1);
  ok(Math.abs(far.x - preX) < 30,
    'with the opponent out of range the ninja does NOT warp (x ' + preX.toFixed(1) + ' -> ' + far.x.toFixed(1) + ')');
  await sleep(400);
  const far2 = (await state()).fighters[1];
  ok(far2.percent === 0, 'and it does not hit anything either (percent=' + far2.percent + ')');
}

console.log('== G. no console / page errors anywhere in this run ==');
{
  const real = errors.filter(e => !/favicon|Autofill/i.test(e));
  ok(real.length === 0, 'zero page/console errors (' + real.length + ')' + (real.length ? ': ' + real.slice(0, 5).join(' | ') : ''));
}

console.log('== summary ==');
console.log('' + passes + ' passed, ' + failures + ' failed');
await browser.close();
process.exit(failures ? 1 : 0);
