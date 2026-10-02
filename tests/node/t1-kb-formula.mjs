// t1-kb-formula.mjs — (A) soft-capped knockback: 10 targeted checks.
// Run: node tests/node/t1-kb-formula.mjs
import './_env.mjs';
import { computeKnockbackVector, knockbackGrowthTerm, KNOCKBACK_SCALING } from '../../src/combat.js';

let passes = 0, failures = 0;
function ok(cond, msg) {
  if (cond) { passes++; console.log('  PASS  ' + msg); }
  else { failures++; console.log('  FAIL  ' + msg); }
}
const T = (percent, weight = 1.0) => ({ percent, _fighterDef: { id: 'cowboy', weight }, launchResist: 1 });
const DEF = { dmg: 6.4, kbBase: 165, kbGrowth: 0.95, launchAngle: 38 };
const speedOf = (r) => Math.hypot(r.vx, r.vy);
// Old (pre-softcap) raw formula, replicated for regression comparison.
const oldRaw = (dmg, base, gr, D) => (dmg * 7 + (base + gr * D)) * (1 + D / 80);

const DS = [0, 10, 20, 40, 60, 80, 100, 150, 200, 500];
const speeds = DS.map((D) => speedOf(computeKnockbackVector(T(D), DEF, { hitDir: 1, kbMul: 1 })));

// 1. finite + non-negative at every probe damage, including extreme.
ok(speeds.every(Number.isFinite) && speeds.every((v) => v >= 0), `finite non-negative speeds 0..500 (${speeds.map((v) => v.toFixed(0)).join(',')})`);
// 2. monotonically non-decreasing (damage never makes a move weaker).
ok(speeds.every((v, i) => i === 0 || v >= speeds[i - 1] - 1e-9), 'monotonic across 0..500');
// 3. fresh-hit identical to the old formula (zero low-percent regression).
{
  const fresh = speedOf(computeKnockbackVector(T(0), DEF, { hitDir: 1, kbMul: 1 }));
  const expected = (oldRaw(6.4, 165, 0.95, 0) / 1) * 0.55;
  ok(Math.abs(fresh - expected) < 1e-6, `D=0 matches old formula (${fresh.toFixed(3)} == ${expected.toFixed(3)})`);
}
// 4. diminishing returns: late growth << early growth (the soft cap bites).
{
  const early = speeds[4] - speeds[0]; // 0 -> 60
  const late = speeds[9] - speeds[7];  // 80 -> 500
  ok(late < early * 0.6, `late growth ${late.toFixed(1)} << early growth ${early.toFixed(1)}`);
}
// 5. growth term asymptotes to base*growth*strength.
{
  const limit = 165 * 0.95 * KNOCKBACK_SCALING.strength;
  const huge = knockbackGrowthTerm(165, 0.95, 1e6);
  ok(Math.abs(huge - limit) / limit < 0.01, `asymptote ${huge.toFixed(1)} ~= ${limit.toFixed(1)}`);
}
// 6. invalid inputs never throw and stay finite.
{
  let threw = false, vals = [];
  try {
    for (const bad of [NaN, -30, undefined, Infinity]) {
      vals.push(speedOf(computeKnockbackVector(T(bad), DEF, { hitDir: 1, kbMul: 1 })));
    }
  } catch (_) { threw = true; }
  ok(!threw && vals.every(Number.isFinite), `invalid percents safe (${vals.map((v) => String(v)).join(',')})`);
}
// 7. fixedKnockback ignores damage entirely.
{
  const fdef = { ...DEF, fixedKnockback: 300 };
  const a = speedOf(computeKnockbackVector(T(0), fdef, { hitDir: 1, kbMul: 1 }));
  const b = speedOf(computeKnockbackVector(T(200), fdef, { hitDir: 1, kbMul: 1 }));
  ok(a === b && a > 0, `fixedKnockback constant across damage (${a.toFixed(1)})`);
}
// 8. weight still orders launches (light flies farther).
{
  const l = speedOf(computeKnockbackVector(T(80, 0.85), DEF, { hitDir: 1, kbMul: 1 }));
  const h = speedOf(computeKnockbackVector(T(80, 1.25), DEF, { hitDir: 1, kbMul: 1 }));
  ok(l > h * 1.2, `weight ordering ${l.toFixed(0)} > ${h.toFixed(0)}`);
}
// 9. vyScale touches only the vertical component.
{
  const plain = computeKnockbackVector(T(60), DEF, { hitDir: 1, kbMul: 1 });
  const scaled = computeKnockbackVector(T(60), { ...DEF, vyScale: 0.25 }, { hitDir: 1, kbMul: 1 });
  ok(Math.abs(scaled.vx - plain.vx) < 1e-9 && Math.abs(scaled.vy - plain.vy * 0.25) < 1e-9, 'vyScale vertical-only');
}
// 10. hard cap holds under absurd stacking.
{
  const thunder = computeKnockbackVector(T(999), { dmg: 99, kbBase: 900, kbGrowth: 9, launchAngle: 45, koPower: 5 }, { hitDir: 1, kbMul: 5, });
  const s = Math.hypot(thunder.vx, thunder.vy);
  ok(Number.isFinite(s) && s <= 2400, `capped at 2400 (got ${s.toFixed(0)})`);
}

console.log(`== t1: ${passes} passed, ${failures} failed ==`);
process.exit(failures ? 1 : 0);
