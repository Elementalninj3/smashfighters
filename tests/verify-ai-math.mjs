// verify-ai-math.mjs — deterministic unit tests for the AI reach model,
// trajectory prediction and connect-chance estimator (pure functions).
import { attackReach, predictOppCenter, connectChance, facingOppNow } from '../src/ai/ai.js';
import { attacksFor } from '../src/fighter/combat.js';

let passes = 0, failures = 0;
function ok(cond, msg) {
  if (cond) { passes++; console.log('  PASS  ' + msg); }
  else { failures++; console.log('  FAIL  ' + msg); }
}
const cowboy = { _fighterDef: { id: 'cowboy' }, radius: 31.2, x: 500, y: 826, vx: 0, vy: 0, grounded: true, facingRight: true };
const ninja = { _fighterDef: { id: 'ninja' }, radius: 28, x: 0, y: 0, vx: 0, vy: 0, grounded: true, facingRight: false };
const N = (over) => ({ ...ninja, ...over });
const C = (over) => ({ ...cowboy, ...over });
const P = (f, o) => ({
  hDist: Math.abs(o.x - f.x), vDist: o.y - f.y,
  oppGrounded: !!o.grounded, oppY: o.y, stageTop: 858,
});

console.log('== reach model per character ==');
const jabC = attackReach('jab', attacksFor(C())[ 'jab'], C());
ok(jabC.kind === 'melee' && jabC.fwd === 72, `cowboy jab fwd=72 (got ${jabC.fwd})`);
const sweepN = attackReach('dtilt', attacksFor(N()).dtilt, N());
ok(sweepN.kind === 'melee' && sweepN.fwd === 42 + 27.5, `ninja sweep fwd=69.5 (got ${sweepN.fwd})`);
const shadN = attackReach('dsmash', attacksFor(N()).dsmash, N());
ok(shadN.kind === 'dash' && shadN.fwd === 55 + 35 + 120, `shadow strike lunges 210 (got ${shadN.fwd})`);
const shuN = attackReach('fsmash', attacksFor(N()).fsmash, N());
ok(shuN.kind === 'projectile' && shuN.fwd === 450, 'shuriken is long-range projectile');
console.log('   (cowboy Deadeye/horse/rifle resolve via anim combat at runtime — covered in live tests)');

console.log('== prediction ==');
const fall = predictOppCenter({ x: 600, y: 500, vx: 100, vy: 0 }, false, 0.2);
ok(fall.x === 620, `horizontal carries (x=${fall.x})`);
ok(fall.y > 500 && fall.y < 600, `gravity pulls down (y=${fall.y.toFixed(1)})`);
const g = predictOppCenter({ x: 600, y: 826, vx: -80, vy: 0 }, true, 0.2);
ok(g.x === 584 && g.y === 826, 'grounded target slides, no sink');

console.log('== connect: grounded close, facing ==');
const f = C({ facingRight: true });
const o = N({ x: 575, y: 845 });
const cJab = connectChance(jabC, P(f, o), f, o);
ok(cJab > 0.5, `jab connects close/facing (${cJab.toFixed(2)})`);
const cSweep = connectChance(sweepN, P(N({ x: 575, y: 845, facingRight: false }), N({ x: 500, y: 826 })), N({ x: 575, y: 845, facingRight: false }), N({ x: 500, y: 826 }));
ok(cSweep > 0.5, `sweep connects close (${cSweep.toFixed(2)})`);

console.log('== connect: facing away / far / misaligned ==');
const cAway = connectChance(jabC, P(C({ facingRight: false }), o), C({ facingRight: false }), o);
ok(cAway < 0.25, `jab fails facing away (${cAway.toFixed(2)})`);
const cFar = connectChance(jabC, P(f, N({ x: 900, y: 826 })), f, N({ x: 900, y: 826 }));
ok(cFar < 0.2, `jab fails far away (${cFar.toFixed(2)})`);
const cHigh = connectChance(jabC, P(f, N({ x: 575, y: 500 })), f, N({ x: 575, y: 500 }));
ok(cHigh < 0.2, `jab fails vs high target (${cHigh.toFixed(2)})`);

console.log('== connect: predicted movement ==');
const runner = N({ x: 620, y: 826, vx: 400 }); // sprinting away, jab t~0.08s
const cRun = connectChance(jabC, P(f, runner), f, runner);
ok(cRun < cJab, `fleeing target scores lower (${cRun.toFixed(2)} < ${cJab.toFixed(2)})`);
const incoming = N({ x: 660, y: 826, vx: -400 }); // rushing in: reachable at impact
const cIn = connectChance(jabC, P(f, incoming), f, incoming);
ok(cIn > 0.3, `rusher predicted into range (${cIn.toFixed(2)})`);

console.log('== facing helper ==');
ok(facingOppNow(C({ facingRight: true }), 50) === true, 'facing right, opp right');
ok(facingOppNow(C({ facingRight: true }), -50) === false, 'facing right, opp left');
ok(facingOppNow(C({ facingRight: false }), 3) === true, 'tiny dx either way');

console.log(`\nRESULT: ${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
