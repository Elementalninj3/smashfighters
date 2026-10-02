// t2-attacks.mjs — (B) character attack tuning: 10 headless behavioral cases.
// Fires real attacks through startAttackForKey + updateAttacks/updateProjectiles
// and verifies damage, single-application launch vectors, hitstun, projectiles,
// ability routing, and lifecycle cleanup. Run: node tests/node/t2-attacks.mjs
import './_env.mjs';
import { createFighter } from '../../src/physics.js';
import { createDefaultStage } from '../../src/physics.js';
import {
  startAttackForKey, updateAttacks, updateProjectiles, resetCombat,
  computeKnockbackVector, attacksFor,
} from '../../src/combat.js';
import { ALL_FIGHTERS } from '../../src/combat.js';

const DT = 1 / 60;
let passes = 0, failures = 0;
function ok(cond, msg) {
  if (cond) { passes++; console.log('  PASS  ' + msg); }
  else { failures++; console.log('  FAIL  ' + msg); }
}
const defFor = (id) => ALL_FIGHTERS.find((f) => f.id === id);
function mkFighter(pn, def, x, y, airborne) {
  const f = createFighter(pn, x, y, null, {
    id: `t${pn}`, color: '#fff', radius: def.radius || 26,
    runSpeed: def.runSpeed || 70, jumpForce: def.jumpForce || 700,
  });
  f._fighterDef = def;
  f.grounded = !airborne;
  f.percent = 30;
  f.invulnTimer = 0;
  return f;
}
// Place attacker + victim; step attack frames; capture first damage frame.
function swing(charId, key, opts = {}) {
  resetCombat();
  const def = defFor(charId);
  const stage = createDefaultStage(1200, 1100);
  const air = !!opts.air;
  const a = mkFighter(1, def, 500, air ? 600 : 790, air);
  const v = mkFighter(2, defFor(opts.victim || 'cowboy'), opts.vx || 560, air ? 600 : 790, air);
  v.percent = opts.percent != null ? opts.percent : 30;
  const table = attacksFor(a);
  const started = startAttackForKey(a, key, {});
  if (!started) return { started: false };
  const total = (table[key].startup || 0) + (table[key].active || 0) + (table[key].recovery || 0);
  let hit = null;
  const frames = total + (opts.extra || 120);
  for (let i = 0; i < frames; i++) {
    const before = v.percent;
    updateAttacks([a, v], DT);
    updateProjectiles([a, v], DT);
    if (!hit && v.percent > before + 1e-9) {
      hit = { frame: i, vx: v.vx, vy: v.vy, dealt: v.percent - before, hitstun: v.hitstun, defUsed: a.attack ? { ...a.attack.def } : null };
    }
    if (a.attack === null && hit && i > total) break;
  }
  return { started: true, hit, done: a.attack === null, victim: v, attacker: a, table };
}
const spd = (x, y) => Math.hypot(x, y);

function exactCase(name, charId, key, air) {
  const r = swing(charId, key, { air });
  ok(r.started, `${name} starts`);
  ok(!!r.hit, `${name} lands (dealt ${r.hit ? r.hit.dealt.toFixed(2) : '?'})`);
  if (!r.hit) return;
  const d = r.hit.defUsed;
  ok(Math.abs(r.hit.dealt - d.dmg) < 1e-6, `${name} damage == table (${r.hit.dealt.toFixed(3)} == ${d.dmg})`);
  // Single application: victim launch must equal one computeKnockbackVector pass.
  const pred = computeKnockbackVector({ percent: 30 + d.dmg, _fighterDef: { id: 'cowboy', weight: 1.0 }, launchResist: 1 }, d, { hitDir: 1, kbMul: 1 });
  const got = spd(r.hit.vx, r.hit.vy), want = spd(pred.vx, pred.vy);
  ok(Math.abs(got - want) / Math.max(1, want) < 0.05, `${name} launch applied once (${got.toFixed(1)} ~= ${want.toFixed(1)})`);
  ok(r.hit.hitstun > 0, `${name} applies hitstun`);
  ok(r.done, `${name} lifecycle finishes clean`);
}

function abilityCase(name, charId, key, dmg, extra) {
  const r = swing(charId, key, { extra });
  ok(r.started, `${name} starts`);
  ok(!!r.hit, `${name} ability lands`);
  if (!r.hit) return;
  ok(Math.abs(r.hit.dealt - dmg) < 1e-6, `${name} ability damage == table (${r.hit.dealt.toFixed(3)} == ${dmg})`);
  ok(r.done, `${name} lifecycle finishes clean`);
}

exactCase('cowboy jab', 'cowboy', 'jab', false);
abilityCase('cowboy fsmash rifle', 'cowboy', 'fsmash', 6.4, 180);
exactCase('cowboy aerialHeavy', 'cowboy', 'aerialHeavy', true);
exactCase('ninja jab', 'ninja', 'jab', false);
abilityCase('ninja shuriken', 'ninja', 'fsmash', 9.408, 180);
abilityCase('ninja teleport strike', 'ninja', 'dtilt', 4.704, 200);
abilityCase('ninja shadow strike', 'ninja', 'dsmash', 12.544, 200);
exactCase('boxer jab', 'boxer', 'jab', false);
abilityCase('boxer straight right', 'boxer', 'fsmash', 24.0, 200);
exactCase('boxer air uppercut', 'boxer', 'aerialHeavy', true);

console.log(`== t2: ${passes} passed, ${failures} failed ==`);
process.exit(failures ? 1 : 0);
