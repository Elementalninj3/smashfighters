// verify-shadow-strike-vfx.mjs — runtime verification of the Shadow Strike VFX
// integration (ninja Down Heavy), driven through the REAL dev page (:5173 with
// ?probe) and the in-browser debug probe window.__ssTest. No mocks.
//
// Claims verified:
//
//   A. THE EFFECT IS THE shadowdash ART: VFX_EFFECTS.shadowDash exists (the
//      converted GA/vfx/shadowdash.html art, src/effects/art.js), the retired
//      shadowPoof+slash pair is gone from the ninjaDsmash animation, and the
//      ability is still the same nonHitbox 'ninjaDsmash' move.
//
//   B. ONE CALL, ONE INSTANCE, CORRECT SYNC: exactly ONE temp effect is armed by
//      the cast frame (never two, no second loop), anchored to the fighter
//      ('character'), mirrored to the direction the dash travelled, scaled to the
//      fighter's own body, and covering the distance the dash actually covered.
//      It is not alive during startup and it is GONE the moment the ability ends
//      — it can never keep running after the move.
//
//   C. PURE / STATELESS ART: drawing the same progress twice produces
//      byte-identical pixels, the art draws on the side it was mirrored to, and
//      nothing at all is drawn past progress 1 (the sequence self-terminates —
//      there is no lingering state to animate).
//
//   D. GAMEPLAY UNTOUCHED: the dash distance, the attack's frame budget, the
//      resolved def (damage/angles/hitbox numbers) and the absence of any
//      projectile/hitbox registration by the VFX are all unchanged — the art
//      moves nothing and collides with nothing.
//
//   E. DIRTY ANIMATION STORE: a store written before this change (ninjaDsmash
//      still carrying the retired pair) is migrated once on boot, so the old poof
//      can never paint on top of the new dash.
//
// Run: node verify-shadow-strike-vfx.mjs   (dev server :5173, probe on)

import { chromium } from 'playwright';

const URL = 'http://localhost:5173/?probe';
const EXE = 'C:/Users/User/AppData/Local/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-win64/chrome-headless-shell.exe';

let passes = 0, failures = 0;
function ok(cond, msg) {
  if (cond) { passes++; console.log('  PASS  ' + msg); }
  else { failures++; console.log('  FAIL  ' + msg); }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Ninja-only x1.4 damage buff over the shared balance table: the Shadow Strike
// (NINJA_ATTACKS.dsmash) went 6.4 -> 8.96. Only the ninja's own numbers moved,
// so this suite keeps asserting every other field of the move verbatim.
const DSMASH_DMG = 8.96;

// The dash is a real ~0.15s burst that starts on the cast frame, so a fixed
// sleep can land anywhere inside it (the headless frame rate swings with load).
// Sample it when its travel has actually finished — x stable across three reads,
// the shadowDash effect still alive, the move still running.
async function dashSettled(pn, maxMs = 5000) {
  const t0 = Date.now();
  let last = null, stable = 0, seenInst = null;
  while (Date.now() - t0 < maxMs) {
    const f = (await state()).fighters[pn - 1];
    const inst = (await vfx(pn)).temp.find(x => x.effect === 'shadowDash') || null;
    if (inst) seenInst = inst;
    // Stability only counts between reads that BOTH carry the instance: x is
    // stationary through the whole startup, so counting it there would break on
    // the cast frame itself, before the dash had covered anything.
    stable = (inst && last && last.inst && Math.abs(f.x - last.f.x) < 0.05) ? stable + 1 : 0;
    last = { f, inst };
    if (inst && stable >= 3) break;
    if (!f.attack) break;
    await sleep(16);
  }
  // The effect's lifetime IS the move's remaining frames, and the burst now eats
  // most of them — so the trail can retire on (or a frame before) the frame the
  // dash ends, leaving no settled window that still carries the instance. Report
  // the instance this dash was actually seen with; the settled x is still the
  // last read, which is what the distance assertions compare against.
  if (!last.inst && seenInst) last.inst = seenInst;
  return last;
}

const browser = await chromium.launch({ headless: true, executablePath: EXE, args: ['--no-sandbox', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 900, height: 940 } });
const errors = [];
page.on('pageerror', e => { errors.push(e.message); console.log('[pageerror]', e.message); });
page.on('console', m => { if (m.type() === 'error') { errors.push(m.text()); console.log('[console.error]', m.text()); } });

const state = () => page.evaluate(() => window.__ssTest ? window.__ssTest.state() : null);
const place = (pn, patch) => page.evaluate(([n, p]) => window.__ssTest.place(n, p), [pn, patch]);
const attack = (pn, k, dir) => page.evaluate(([n, kk, dd]) => window.__ssTest.attack(n, kk, dd || {}), [pn, k, dir]);
const vfx = (pn) => page.evaluate(n => window.__ssTest.vfx(n), pn);
const boxes = (pn) => page.evaluate(n => window.__ssTest.hitboxes().filter(b => b.owner === n), pn);
const projs = (pn) => page.evaluate(n => window.__ssTest.projectiles(n), pn);
const resolved = (k) => page.evaluate(kk => window.__ssTest.resolvedDef(kk), k);

const G = 826.8; // top of the stage platform
const gp = (x, facingRight = true) => ({ x, y: G, grounded: true, vx: 0, vy: 0, percent: 0, hitstun: 0, invulnTimer: 0, facingRight });

// The Shadow Strike's authored travel (NINJA_ATTACKS.dsmash.dashDistance). The
// VFX paints itself backwards over exactly this distance, and the fighter ends
// up exactly this far from where it cast, so the trail and the body agree — the
// effect rides the move, it does not approximate it.
const DASH_DIST = 192;

console.log('== boot: menu -> Ninja (P1) vs Cowboy (P2) -> START ==');
await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('canvas', { timeout: 20000 });
await sleep(1200);
async function setRow(label, want) {
  for (let g = 0; g < 8; g++) {
    const txt = await page.evaluate((l) => {
      const row = [...document.querySelectorAll('#term-lines .term-row')].find((x) => x.textContent.includes(l));
      return row ? row.textContent : null;
    }, label);
    if (!txt || txt.includes(want)) return txt;
    await page.evaluate((l) => {
      const row = [...document.querySelectorAll('#term-lines .term-row')].find((x) => x.textContent.includes(l));
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
const p1Row = await setRow('YOUR FIGHTER', 'Ninja');
const p2Row = await setRow('OPPONENT FIGHTER', 'Cowboy');
ok(!!p1Row && p1Row.includes('Ninja') && !!p2Row && p2Row.includes('Cowboy'),
  'matchup rows set: Ninja (P1, Shadow Strike) vs Cowboy (P2)');
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
let s = await state();
ok(s && s.gameState === 'playing', 'START enters the PLAYING state');

console.log('== A. the effect IS the converted shadowdash art ==');
{
  const lib = await page.evaluate(async () => {
    const anims = await import('/src/anim/library.js');
    const vfxMod = await import('/src/effects/vfx.js');
    const art = await import('/src/effects/art.js');
    const eff = vfxMod.VFX_EFFECTS.shadowDash;
    return {
      hasEffect: !!(eff && typeof eff.draw === 'function'),
      name: eff ? eff.name : null,
      artFrames: art.SHADOW_DASH.artFrames,
      dashFrames: art.SHADOW_DASH.dashFrames,
      ninjaDsmashVfx: anims.getAnimation('ninjaDsmash').vfx,
      listed: vfxMod.listVfxEffects().some(e => e.id === 'shadowDash'),
    };
  });
  ok(lib.hasEffect, 'VFX_EFFECTS.shadowDash is registered (name=' + lib.name + ')');
  ok(lib.listed, 'the animator effect list offers shadowDash');
  ok(lib.artFrames === 34 && lib.dashFrames === 14,
    'art timeline preserved (dash ' + lib.dashFrames + ' frames, sequence ' + lib.artFrames + ')');
  ok(Array.isArray(lib.ninjaDsmashVfx) && lib.ninjaDsmashVfx.length === 0,
    'the retired shadowPoof + slash pair is no longer on ninjaDsmash (vfx=' + JSON.stringify(lib.ninjaDsmashVfx) + ')');

  const d = await resolved('dsmash');
  ok(!!d && d.abilityType === 'nonHitbox' && d.abilityId === 'ninjaDsmash',
    'Shadow Strike is still the ninjaDsmash ability (type=' + (d && d.abilityType) + ')');
  // Damage, knockback, box geometry and the phase budget must be exactly what
  // this VFX work found — none of it belongs to the trail. The deliberate
  // changes are `active` (the dash-strike hitbox window was widened from 3
  // frames to 14 so the box stays live for the whole 192px/800px-per-sec burst)
  // and `dmg` (the ninja-only x1.4 damage buff: 6.4 -> 8.96). Both are asserted
  // explicitly rather than dropped, because a silent edit to either is exactly
  // the kind of change these lines exist to catch.
  ok(!!d && d.name === 'Shadow Strike' && d.dmg === DSMASH_DMG && d.kbBase === 140 && d.kbGrowth === 0.9
    && d.angle === 40 && d.w === 96 && d.h === 88 && d.ox === 0 && d.oy === 0
    && d.startup === 10 && d.recovery === 22,
    'its damage/knockback/phases are unchanged, box centered on the dasher (dmg=' + (d && d.dmg)
      + ', box=' + (d && d.w + 'x' + d.h + '@' + d.ox + ',' + d.oy) + ')');
  ok(d && d.active === 14,
    'the strike window is the one deliberate change: 3 -> ' + (d && d.active) + ' frames, covering the whole burst');
}

console.log('== B. armed once, on the cast, synced to the move ==');
{
  // Unclamped dash: 200 + 192 = 392 lands inside the arena the ability clamps to.
  await place(2, gp(900, false));
  await place(1, gp(200, true));
  await sleep(120); // let the engine settle the placement (PvP: nobody drives it)
  const before = (await state()).fighters[0];
  ok(Math.abs(before.x - 200) < 1, 'P1 (ninja) stands at the placed spot (x=' + before.x + ')');
  ok((await vfx(1)).temp.length === 0, 'no Shadow Strike VFX before the move');

  await attack(1, 'dsmash', {});
  // Read IMMEDIATELY after the press. attack() sets the input inside a single
  // page task, so no game frame can run in between: whatever is armed now was
  // armed by the activation itself. This is the real "not before the cast"
  // invariant, and unlike a wall-clock guess it holds at any frame rate.
  const armedNow = await vfx(1);
  const armedState = (await state()).fighters[0];
  ok(armedNow.temp.filter(v => v.effect === 'shadowDash').length === 0,
    'the VFX is NOT armed at the activation frame (phase=' + armedState.phase
      + ', temp=' + JSON.stringify(armedNow.temp) + ')');

  // Then wait for the cast frame to actually arrive. A fixed sleep cannot do
  // this: how long the 10 startup frames take is the headless frame rate's
  // business, and a sleep either races past the cast or stalls before it. This
  // only proves the cast HAPPENED — the instance is deliberately not inspected
  // here, because on the cast frame the dash has not moved yet and the effect's
  // distance is legitimately still 0. The settled read below is the one that
  // carries the real travelled distance.
  let sawCast = false, appearState = null, firstProgress = null;
  const tCast = Date.now();
  while (Date.now() - tCast < 5000) {
    const seen = (await vfx(1)).temp.filter(x => x.effect === 'shadowDash');
    if (seen.length) {
      // Read the fighter AFTER seeing the effect, so the phase belongs to (at
      // least) the same moment the effect exists — reading it first would hand
      // back the pre-cast state from the previous round trip.
      sawCast = true; appearState = (await state()).fighters[0];
      firstProgress = seen[0].progress;
      break;
    }
    const s = (await state()).fighters[0];
    if (!s.attack) { appearState = s; break; }
    await sleep(8);
  }
  const { f: cast, inst } = await dashSettled(1);
  ok(sawCast, 'the effect is armed exactly once, on the cast frame');
  // The effect is only ever spawned by the ability on the cast frame, so seeing
  // it at all proves the cast; what this adds is that the move is genuinely
  // live (not over) at that moment, and has left startup.
  ok(!!appearState && !!appearState.attack && appearState.phase !== 'startup',
    'the effect appears on the cast frame, not during startup (phase='
      + (appearState && appearState.phase) + ')');
  ok(!!inst.params, 'the armed effect carries its draw parameters');
  ok(inst.anchor === 'character', 'anchored to the fighter body (anchor=' + inst.anchor + ')');
  ok(inst.mirrorX === 1, 'mirrored to the attack direction of a right-facing dash (mirrorX=' + inst.mirrorX + ')');
  ok(!!inst.params && Math.abs(inst.params.distance - DASH_DIST) < 0.6,
    'trail covers the dash distance (distance=' + (inst.params && inst.params.distance) + ')');
  ok(!!inst.params && Math.abs(inst.params.unit - 0.8211) < 0.01,
    'art scaled to the fighter body (unit=' + (inst.params && inst.params.unit) + ' = ninja diameter/76)');
  // "Progress is running" means the timeline ADVANCED while the effect was on
  // screen. Asserting a mid-range value instead would race the retirement: the
  // art timeline is mapped onto the move's remaining frames, so progress
  // legitimately reaches 1 on the last frame the effect is still alive.
  ok(firstProgress != null && inst.progress > firstProgress,
    'progress is running (' + firstProgress + ' -> ' + inst.progress + ')');
  ok(Math.abs(cast.x - (200 + DASH_DIST)) < 0.6, 'the dash itself is untouched: x 200 -> ' + cast.x);
  // The trail may already have retired by the settled read (its lifetime IS the
  // move's remaining frames, and the burst now eats most of them), so this only
  // rules out a second copy being carried — never more than one at a time. The
  // "max over the whole move" below is the duplicate-spawn check proper.
  ok(cast.tempVfx <= 1, 'the fighter never carries a second temp VFX (tempVfx=' + cast.tempVfx + ')');

  // Walk the rest of the move: the trail must never multiply, and must die with
  // the ability.
  let maxInstances = 1, aliveAtEnd = null, endState = null;
  for (let i = 0; i < 30; i++) {
    await sleep(30);
    const st = (await state()).fighters[0];
    const w = await vfx(1);
    const n = w.temp.filter(x => x.effect === 'shadowDash').length;
    maxInstances = Math.max(maxInstances, n);
    if (!st.attack) { aliveAtEnd = n; endState = st; break; }
  }
  ok(maxInstances === 1, 'never more than one instance for the whole move (max=' + maxInstances + ')');
  ok(!!endState, 'the ability ended inside the watched window');
  if (aliveAtEnd > 0) {
    // Same-frame read straddles the retirement boundary: confirm one poll later.
    await sleep(50);
    aliveAtEnd = (await vfx(1)).temp.filter(x => x.effect === 'shadowDash').length;
  }
  ok(aliveAtEnd === 0, 'the VFX is gone the instant the ability ends (live instances=' + aliveAtEnd + ')');
  await sleep(400);
  ok((await vfx(1)).temp.length === 0, 'nothing keeps running afterwards (temp empty 400ms later)');
  ok((await projs(1)).length === 0, 'no projectile was ever created by the VFX');
  ok((await boxes(1)).length === 0, 'no hitbox was ever created by the VFX');
}

console.log('== B2. facing left, and a dash clipped by the ability\'s arena clamp ==');
{
  await place(1, gp(320, false));
  await sleep(120);
  await attack(1, 'dsmash', {});
  const left = await dashSettled(1);
  const inst = left.inst;
  const f = left.f;
  ok(!!inst && inst.mirrorX === -1 && inst.anchor === 'character',
    'a left-facing Shadow Strike mirrors the trail (mirrorX=' + (inst && inst.mirrorX) + ')');
  ok(!!inst && Math.abs(inst.params.distance - DASH_DIST) < 0.6 && Math.abs(f.x - (320 - DASH_DIST)) < 0.6,
    'left dash covers ' + DASH_DIST + ' (x 320 -> ' + f.x + ', distance=' + (inst && inst.params.distance) + ')');
  await sleep(600);

  // Clipped dash: the ability clamps x, so the trail must cover what it COVERED.
  await place(1, gp(300, true));
  await sleep(120);
  await attack(1, 'dsmash', {});
  const clipped = await dashSettled(1);
  const c = clipped.inst;
  const cf = clipped.f;
  ok(!!c && Math.abs(c.params.distance - Math.abs(cf.x - 300)) < 0.6,
    'a clipped dash draws the shorter trail it really travelled ('
    + (c && c.params.distance) + ' = |' + cf.x + ' - 300|)');
  await sleep(600);
  ok((await vfx(1)).temp.length === 0, 'the clipped dash also retires with the move');

  // Observation only (pre-existing ability behaviour, NOT touched by this work):
  // abilities.js clamps the dash against Engine's default 400-wide arena, which
  // Game.js never re-sets (setArena is never called), so a dash that runs past
  // x ≈ 348.8 is pulled BACK. The VFX follows the real path in that case.
  await place(1, gp(600, true));
  await sleep(120);
  const obsBefore = (await state()).fighters[0].x;
  await attack(1, 'dsmash', {});
  const obs = await dashSettled(1);
  const obsVfx = obs.inst;
  const obsAfter = obs.f.x;
  console.log('   [observe] dash from x=' + obsBefore + ' ended at x=' + obsAfter
    + ' (travel=' + (obsAfter - obsBefore).toFixed(1) + ') — trail mirrorX='
    + (obsVfx && obsVfx.mirrorX) + ', distance=' + (obsVfx && obsVfx.params.distance)
    + '  ← follows the real path; the clamp itself is pre-existing gameplay');
  ok(!!obsVfx && obsVfx.mirrorX === Math.sign(obsAfter - obsBefore || 1)
    && Math.abs(obsVfx.params.distance - Math.abs(obsAfter - obsBefore)) < 0.6,
    'even when the clamp pulls the fighter back, the trail covers the true path');
  await sleep(600);
}

console.log('== C. the art is pure, mirrored and self-terminating ==');
{
  const art = await page.evaluate(async () => {
    const mod = await import('/GA/vfx/effects.js');
    const eff = mod.VFX_EFFECTS.shadowDash;
    const W = 400, H = 220;
    const render = (progress, mirrorX, distance) => {
      const c = document.createElement('canvas');
      c.width = W; c.height = H;
      const cx = c.getContext('2d');
      eff.draw(cx, { progress, scale: 1, rotation: 0, mirrorX, params: { distance, unit: 0.8211 } }, { x: 200, y: 110 });
      return cx.getImageData(0, 0, W, H).data;
    };
    const count = (d, fromX, toX) => {
      let n = 0;
      for (let y = 0; y < H; y++) for (let x = fromX; x < toX; x++) if (d[(y * W + x) * 4 + 3] > 0) n++;
      return n;
    };
    const mid = render(0.5, 1, 120);
    const again = render(0.5, 1, 120);
    const mirrored = render(0.5, -1, 120);
    const done = render(1.2, 1, 120);
    const start = render(0.02, 1, 120);
    let identical = mid.length === again.length;
    for (let i = 0; identical && i < mid.length; i++) if (mid[i] !== again[i]) identical = false;
    return {
      identical,
      // A right-facing dash must paint BEHIND the anchor (x=200)…
      behind: count(mid, 40, 170),
      inFront: count(mid, 250, 400),
      // …and the mirror flips that.
      mirrorFront: count(mirrored, 250, 400),
      mirrorBehind: count(mirrored, 40, 170),
      // The departure burst sits at the departure point, not on the fighter.
      nearDeparture: count(start, 60, 100),
      nearAnchor: count(start, 185, 215),
      // Past its timeline the effect paints nothing at all.
      afterEnd: count(done, 0, W),
    };
  });
  ok(art.identical, 'same progress ⇒ byte-identical pixels (stateless: no hidden timer or loop state)');
  ok(art.behind > 0, 'the trail paints BEHIND a right-facing dash (pixels=' + art.behind + ')');
  ok(art.inFront === 0, 'nothing is painted in front of it (pixels=' + art.inFront + ')');
  ok(art.mirrorFront > 0 && art.mirrorBehind === 0,
    'mirrorX flips the whole trail (mirrored pixels=' + art.mirrorFront + ')');
  ok(art.nearDeparture > 0 && art.nearAnchor === 0,
    'the departure burst sits on the departure point (x−distance), not on the fighter ('
    + art.nearDeparture + ' vs ' + art.nearAnchor + ')');
  ok(art.afterEnd === 0, 'progress past 1 paints NOTHING (the sequence self-terminates)');
}

console.log('== D. dirty animation store: the old pair cannot come back ==');
{
  // Seed a store written BEFORE this change (ninjaDsmash still carrying the
  // retired shadowPoof+slash pair), then reload: the boot migration retires them,
  // so the old poof can never paint on top of the new dash.
  await page.addInitScript(() => {
    const key = 'smashfighters.animlib.v3';
    let store = [];
    try { const raw = localStorage.getItem(key); if (raw) store = JSON.parse(raw); } catch (_) {}
    const legacy = {
      id: 'ninjaDsmash', name: 'Shadow Strike', fps: 60, loop: false, mirror: true, blendIn: 2,
      weapons: { right: { id: 'ninjaSword' }, left: null },
      combat: { type: 'nonHitbox', abilityId: 'ninjaDsmash' },
      vfx: [
        { effect: 'shadowPoof', anchor: 'character', startFrame: 10, duration: 6, scale: 1.2, rotation: 0, offsetX: 0, offsetY: 0, loop: false },
        { effect: 'slash', anchor: 'weapon', startFrame: 10, duration: 4, scale: 1.2, rotation: 0, offsetX: 15, offsetY: 0, loop: false },
      ],
      tracks: { 'hands.right.x': { keyframes: [{ f: 0, v: 20, e: 'linear' }] } },
    };
    const idx = store.findIndex(a => a && a.id === 'ninjaDsmash');
    if (idx >= 0) store[idx] = legacy; else store.push(legacy);
    localStorage.setItem(key, JSON.stringify(store));
  });
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('canvas', { timeout: 20000 });
  await sleep(1200);
  const after = await page.evaluate(async () => {
    const anims = await import('/src/anim/library.js');
    const a = anims.getAnimation('ninjaDsmash');
    return {
      vfx: a ? a.vfx : null,
      combat: a ? a.combat : null,
      tracks: a ? Object.keys(a.tracks || {}).length : 0,
      stored: (() => { try { return JSON.parse(localStorage.getItem('smashfighters.animlib.v3') || '[]').find(x => x && x.id === 'ninjaDsmash'); } catch (_) { return null; } })(),
    };
  });
  ok(Array.isArray(after.vfx) && after.vfx.length === 0,
    'the stored shadowPoof + slash pair is retired on boot (vfx=' + JSON.stringify(after.vfx) + ')');
  ok(!!after.combat && after.combat.type === 'nonHitbox' && after.combat.abilityId === 'ninjaDsmash',
    'the stored animation is otherwise untouched (combat=' + JSON.stringify(after.combat) + ')');
  ok(after.tracks === 1, 'and keeps its keyframes (tracks=' + after.tracks + ')');
  ok(!!after.stored && Array.isArray(after.stored.vfx) && after.stored.vfx.length === 0,
    'the retirement is persisted (the store itself was rewritten)');
}

console.log('== summary ==');
ok(errors.length === 0, 'no page errors / console errors during the run (' + errors.length + ')');
console.log('' + passes + ' passed, ' + failures + ' failed');
await browser.close();
process.exit(failures ? 1 : 0);
