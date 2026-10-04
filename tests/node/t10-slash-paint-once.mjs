// t10-slash-paint-once.mjs — (B) presentation: a knight's slash paints ONCE.
//
// The knight's swing art can come from two places at once: the attack-start
// code fallback in combat.knightSwingTrail, and the move's OWN timeline entry
// (which the Hand Animator owns so the effect is tunable per move). When both
// fire, the sword arc is drawn twice — the Charged Sword Strike appeared to
// "play twice" on every swing, charged or not, because knightSwingTrail ran on
// the activation frame BEFORE syncFighterAnim attached the new animation, so
// the shared spawnTempVfx guard judged the PREVIOUS move's timeline, found no
// matching entry, and queued a second slash on top of the timeline's.
//
// Fix: knightSwingTrail judges the INCOMING animation (incomingOwnsEffect) and
// passes force:true, so exactly one of the two sources ever paints.
//
// This asserts the invariant directly: for every knight move that has a slash
// trail, code-spawns + timeline entries must total exactly 1.
// Run: node tests/node/t10-slash-paint-once.mjs
import './_env.mjs';
const g = globalThis;
g.performance = g.performance || { now: () => Date.now() };
g.Audio = function () {
  return { currentTime: 0, volume: 1, paused: true, ended: true, play: () => Promise.resolve(), pause: () => {}, addEventListener: () => {} };
};

const { createFighter } = await import('../../src/physics.js');
const { startAttackForKey, resetCombat, ALL_FIGHTERS } = await import('../../src/combat.js');
const { getAnimationRaw } = await import('../../src/anim.js');

let passes = 0, failures = 0;
function ok(cond, msg) {
  if (cond) { passes++; console.log('  PASS  ' + msg); }
  else { failures++; console.log('  FAIL  ' + msg); }
}
const knight = ALL_FIGHTERS.find((f) => f.id === 'knight');
function mk() {
  const f = createFighter(1, 500, 790, null, { id: 't1', color: '#fff', radius: knight.radius || 26, runSpeed: 70, jumpForce: 700 });
  f._fighterDef = knight; f.grounded = true; f.percent = 30; f.invulnTimer = 0;
  return f;
}
const timelineOf = (animId) => {
  const a = animId ? getAnimationRaw(animId) : null;
  return ((a && a.vfx) || []).map(e => e.effect);
};

// Every knight move that paints a slash/sweep trail. Each is checked for BOTH
// failure modes: painting twice (the reported bug) and painting zero times.
const MOVES = [
  ['jab', 'knightSlash'],
  ['ftilt', 'knightSlash'],
  ['fsmash', 'knightBlueSlash'],
  ['dsmash', 'knightSweep'],
  ['aerialLight', 'knightSlash'],
  ['aerialHeavy', 'knightSlash'],
];

console.log('== each knight slash is painted exactly once ==');
for (const [key, effect] of MOVES) {
  resetCombat();
  const f = mk();
  startAttackForKey(f, key, {});
  const code = (f._tempVfx || []).map(v => v.effect);
  const timeline = timelineOf(f.attack && f.attack.def.anim);
  const total = code.length + timeline.length;
  ok(code.indexOf(effect) === -1,
    `${key}: the code fallback does NOT also spawn ${effect} (code=${JSON.stringify(code)})`);
  ok(timeline.indexOf(effect) !== -1,
    `${key}: the move's own timeline paints ${effect} (timeline=${JSON.stringify(timeline)})`);
  ok(total === 1, `${key}: the slash is painted exactly 1x, not ${total}x`);
}

console.log('== the specific report: Charged Sword Strike, uncharged and charged ==');
for (const hold of [0, 0.7, 1.5]) {
  resetCombat();
  const f = mk();
  // chargeMult is what the hold produces; the painting path must not care.
  f.__chargeProbe = hold;
  startAttackForKey(f, 'fsmash', {});
  if (hold > 0) f.attack.chargeMult = hold;
  const code = (f._tempVfx || []).map(v => v.effect);
  const timeline = timelineOf(f.attack && f.attack.def.anim);
  ok(code.length + timeline.length === 1,
    `fsmash (charge ${hold}s) paints the blue slash 1x, not ${code.length + timeline.length}x`);
}

console.log('== the guard judges the INCOMING animation, not the current one ==');
{
  // Start a jab first so the knight is mid-move on a DIFFERENT animation, then
  // fire the smash: a guard that read the current animation would let the
  // fallback through here.
  resetCombat();
  const f = mk();
  f.attack = null;
  startAttackForKey(f, 'jab', {});
  for (let i = 0; i < 20; i++) f.attack = null;   // leave the knight idle on jab's anim
  startAttackForKey(f, 'fsmash', {});
  const code = (f._tempVfx || []).map(v => v.effect);
  const timeline = timelineOf(f.attack && f.attack.def.anim);
  ok(code.length + timeline.length === 1,
    `a smash fired straight after another move still paints 1x (got ${code.length + timeline.length})`);
}

console.log(`\nt10-slash-paint-once: ${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);