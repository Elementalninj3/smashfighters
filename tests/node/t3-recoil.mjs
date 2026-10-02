// t3-recoil.mjs — (C) aerial Heavy recoil: 10 targeted checks.
// Verifies bounded smooth recoil (entry impulse + fading sustain), no stacking,
// safe cleanup on landing/death/hitstun, facing mirror, and full lifecycle.
// Run: node tests/node/t3-recoil.mjs
import './_env.mjs';
import { createFighter } from '../../src/physics.js';
import {
  startAttackForKey, updateAttacks, resetCombat, attacksFor,
} from '../../src/combat.js';
import { ALL_FIGHTERS } from '../../src/combat.js';

const DT = 1 / 60;
let passes = 0, failures = 0;
function ok(cond, msg) {
  if (cond) { passes++; console.log('  PASS  ' + msg); }
  else { failures++; console.log('  FAIL  ' + msg); }
}
const defFor = (id) => ALL_FIGHTERS.find((f) => f.id === id);
function mkAir(charId, facingRight = true) {
  const def = defFor(charId);
  const f = createFighter(1, 500, 500, null, { id: 'r1', color: '#fff', radius: 26, runSpeed: 70, jumpForce: 700 });
  f._fighterDef = def;
  f.facingRight = facingRight;
  f.grounded = false;
  f.percent = 0;
  return f;
}
// Run one aerialHeavy to completion, tracking recovery-phase velocity deltas.
function runRecoil(charId, mutate) {
  resetCombat();
  const a = mkAir(charId);
  const v = mkAir('cowboy');
  v.x = 900;
  const started = startAttackForKey(a, 'aerialHeavy', {});
  const t = { started, frames: 0, entered: false, vx0: 0, vy0: 0, dvx: 0, dvy: 0, maxStep: 0, maxRf: 0, rfSawIncrease: false, lastRf: -1, finished: false };
  const table = attacksFor(a);
  const total = table.aerialHeavy.startup + table.aerialHeavy.active + table.aerialHeavy.recovery + 10;
  for (let i = 0; i < total; i++) {
    const pvx = a.vx, pvy = a.vy;
    updateAttacks([a, v], DT);
    t.frames++;
    if (a.attack && a.attack.phase === 'recovery' && !t.entered) {
      t.entered = true; t.vx0 = a.vx; t.vy0 = a.vy;
    }
    if (t.entered && a.attack) {
      t.dvx += a.vx - pvx; t.dvy += a.vy - pvy;
      t.maxStep = Math.max(t.maxStep, Math.abs(a.vy - pvy), Math.abs(a.vx - pvx));
      const rf = a.attack.recoveryForce;
      if (rf) {
        t.maxRf = Math.max(t.maxRf, rf.framesLeft);
        if (rf.framesLeft > t.lastRf && t.lastRf >= 0) t.rfSawIncrease = true;
        t.lastRf = rf.framesLeft;
      }
    }
    if (mutate) mutate(a, v, i, t);
    if (a.attack === null && t.entered) { t.finished = true; break; }
  }
  t.attacker = a;
  return t;
}
const RECS = { cowboy: [-6, -9, 6], ninja: [-5, -7, 5], boxer: [-5, -8, 5] };

for (const charId of ['cowboy', 'ninja', 'boxer']) {
  const [rx, ry, dur] = RECS[charId];
  const t = runRecoil(charId);
  const bound = (dur + 3) / 4; // entry 0.5 + fading sustain 0.5*(D+1)/2
  ok(t.started && t.entered && t.finished, `${charId}: recovery runs to completion`);
  ok(Math.abs(t.dvx) <= Math.abs(rx) * bound + 1e-6 && Math.abs(t.dvy) <= Math.abs(ry) * bound + 1e-6,
    `${charId}: bounded total (${t.dvx.toFixed(1)},${t.dvy.toFixed(1)} <= ${Math.abs(rx) * bound},${Math.abs(ry) * bound})`);
  ok(t.maxStep <= Math.max(Math.abs(rx), Math.abs(ry)) * 0.5 + 1e-6,
    `${charId}: no sudden burst (max step ${t.maxStep.toFixed(2)})`);
  ok(Math.abs(t.dvy) >= Math.abs(ry) * 0.5 - 1e-6, `${charId}: still useful lift (${t.dvy.toFixed(1)})`);
  ok(!t.rfSawIncrease && t.maxRf <= dur, `${charId}: sustain never re-arms (max framesLeft ${t.maxRf})`);
}
// 7. landing clears sustain mid-recovery.
{
  let cleared = false;
  const t = runRecoil('cowboy', (a, v, i) => {
    if (a.attack && a.attack.phase === 'recovery' && a.attack.recoveryForce) {
      a.grounded = true;
    }
    if (a.attack && a.attack.phase === 'recovery' && !a.attack.recoveryForce && !cleared) cleared = true;
  });
  ok(cleared, 'landing clears live sustain');
}
// 8. death clears sustain.
{
  let cleared = false;
  runRecoil('ninja', (a) => {
    if (a.attack && a.attack.phase === 'recovery' && a.attack.recoveryForce) a.state = 'dead';
    if (a.attack && a.attack.phase === 'recovery' && !a.attack.recoveryForce) cleared = true;
  });
  ok(cleared, 'death clears live sustain');
}
// 8b. hitstun clears sustain (belt-and-suspenders behind interruptTarget).
{
  let cleared = false;
  runRecoil('boxer', (a) => {
    if (a.attack && a.attack.phase === 'recovery' && a.attack.recoveryForce) a.hitstun = 0.5;
    if (a.attack && a.attack.phase === 'recovery' && !a.attack.recoveryForce) cleared = true;
  });
  ok(cleared, 'hitstun clears live sustain');
}
// 9. facing mirrors horizontal recoil.
{
  resetCombat();
  const a = mkAir('cowboy', false); // facing left
  const v = mkAir('cowboy');
  v.x = 100;
  startAttackForKey(a, 'aerialHeavy', {});
  let entryDx = 0, saw = false;
  const table = attacksFor(a);
  const total = table.aerialHeavy.startup + table.aerialHeavy.active + table.aerialHeavy.recovery + 5;
  let prevPhase = 'startup';
  for (let i = 0; i < total; i++) {
    const pvx = a.vx;
    updateAttacks([a, v], DT);
    if (a.attack && prevPhase !== 'recovery' && a.attack.phase === 'recovery') {
      entryDx = a.vx - pvx; saw = true;
    }
    if (a.attack) prevPhase = a.attack.phase;
    if (!a.attack && saw) break;
  }
  // recX=-6, facing -1, entry share 0.5 -> vx += +3
  ok(saw && entryDx > 0 && Math.abs(entryDx - 3) < 1e-6, `facing mirrors recoil (entry ${entryDx.toFixed(2)})`);
}
// 10. aerialLight carries no recoil + second heavy works (pool reuse).
{
  resetCombat();
  const a = mkAir('cowboy');
  const v = mkAir('cowboy');
  v.x = 900;
  startAttackForKey(a, 'aerialLight', {});
  let rfSeen = false;
  for (let i = 0; i < 40; i++) {
    updateAttacks([a, v], DT);
    if (a.attack && a.attack.recoveryForce) rfSeen = true;
    if (!a.attack) break;
  }
  ok(!rfSeen, 'aerialLight has no recoil force');
  const t2 = runRecoil('cowboy');
  ok(t2.finished && Math.abs(t2.dvy) > 0, 'second heavy reuses pooled record cleanly');
}

console.log(`== t3: ${passes} passed, ${failures} failed ==`);
process.exit(failures ? 1 : 0);
