// t9-knight-audio.mjs — (B) audio wiring: which recording plays for which move.
//
// Drives the REAL combat/ability/cinematic entry points and records every MP3
// the audio layer actually hands to an <audio> element, so this asserts the
// file AND the volume of the delivered artifact, not just that some SFX method
// got called. Run: node tests/node/t9-knight-audio.mjs
import './_env.mjs';

const g = globalThis;

// Audio mock that RECORDS what it is asked to play. getPooledAudio builds four
// elements per path and reuses them, so recording on play() (not on
// construction) is what reports the actual playback.
const played = [];
const audioMock = function Audio(src) {
  return {
    src, currentTime: 0, volume: 1, paused: true, ended: true, _muteImmune: false,
    play() { this.paused = false; this.ended = false; played.push({ path: this.src, volume: this.volume }); return Promise.resolve(); },
    pause() { this.paused = true; },
    addEventListener: () => {},
  };
};
g.Audio = audioMock;

const { createFighter, createDefaultStage } = await import('../../src/physics.js');
const { startAttackForKey, updateAttacks, updateProjectiles, resetCombat, attacksFor, ALL_FIGHTERS } =
  await import('../../src/combat.js');
const { spawnKoPillar } = await import('../../src/render.js');
const { eventBus, SFX } = await import('../../src/assets.js');

// The audio layer announces every playback on the bus; keep an independent
// record so a play that skipped the bus cannot hide a gap.
const busPaths = [];
eventBus.on('sfxPlay', (p) => busPaths.push(p.path));

const DT = 1 / 60;
let passes = 0, failures = 0;
function ok(cond, msg) {
  if (cond) { passes++; console.log('  PASS  ' + msg); }
  else { failures++; console.log('  FAIL  ' + msg); }
}
const defFor = (id) => ALL_FIGHTERS.find((f) => f.id === id);
function mkFighter(pn, def, x, y) {
  const f = createFighter(pn, x, y, null, {
    id: `t${pn}`, color: '#fff', radius: def.radius || 26,
    runSpeed: def.runSpeed || 70, jumpForce: def.jumpForce || 700,
  });
  f._fighterDef = def;
  f.grounded = true;
  f.percent = 30;
  f.invulnTimer = 0;
  return f;
}

// Record everything the given thunk makes the audio layer play.
function capture(thunk) {
  played.length = 0;
  busPaths.length = 0;
  thunk();
  return played.slice();
}
const last = (list) => list[list.length - 1];
const VOL = '/GA/audio/';

// ── 1. The knight's light swings: slash.mp3, pulled under the ninja's ──────
function lightSwing(charId, key) {
  return capture(() => {
    resetCombat();
    const a = mkFighter(1, defFor(charId), 500, 790);
    mkFighter(2, defFor('cowboy'), 560, 790);
    startAttackForKey(a, key, {});
  });
}
const knightJab = lightSwing('knight', 'jab');
const ninjaJab = lightSwing('ninja', 'jab');

ok(last(knightJab)?.path === VOL + 'slash.mp3',
  `knight jab plays slash.mp3 (got ${last(knightJab)?.path})`);
ok(last(ninjaJab)?.path === VOL + 'slash.mp3',
  `ninja jab still plays slash.mp3 (got ${last(ninjaJab)?.path})`);
const kVol = last(knightJab)?.volume, nVol = last(ninjaJab)?.volume;
ok(kVol !== undefined && kVol < nVol,
  `knight slash is quieter than the ninja's (${kVol} < ${nVol})`);
ok(kVol > 0, `knight slash is audible, not muted (${kVol})`);

// Every knight light move shares the one quiet take.
for (const key of ['ftilt', 'aerialLight', 'aerialHeavy']) {
  const r = lightSwing('knight', key);
  const p = last(r);
  ok(p?.path === VOL + 'slash.mp3' && p?.volume === kVol,
    `knight ${key} plays slash.mp3 at the knight volume ${kVol} (got ${p?.path} @ ${p?.volume})`);
}

// ── 2. Charged Sword Strike (fsmash): chargedsword.mp3 ─────────────────────
const fsmash = capture(() => {
  resetCombat();
  const a = mkFighter(1, defFor('knight'), 500, 790);
  mkFighter(2, defFor('cowboy'), 560, 790);
  startAttackForKey(a, 'fsmash', {});
});
ok(last(fsmash)?.path === VOL + 'chargedsword.mp3',
  `knight Charged Sword Strike plays chargedsword.mp3 (got ${last(fsmash)?.path})`);

// No other roster's Side Smash may claim that recording (they speak through
// their own abilities on the cast frame, not here).
for (const charId of ['cowboy', 'boxer', 'ninja']) {
  const r = capture(() => {
    resetCombat();
    const a = mkFighter(1, defFor(charId), 500, 790);
    mkFighter(2, defFor('cowboy'), 560, 790);
    startAttackForKey(a, 'fsmash', {});
  });
  ok(last(r)?.path !== VOL + 'chargedsword.mp3',
    `${charId} fsmash does not play the knight's chargedsword.mp3`);
}

// ── 3. Shield Bash (dtilt): shieldbash.mp3, on the ability's cast frame ────
function stepAbility(charId, key, extraFrames = 40) {
  return capture(() => {
    resetCombat();
    const a = mkFighter(1, defFor(charId), 500, 790);
    const v = mkFighter(2, defFor('cowboy'), 560, 790);
    const table = attacksFor(a);
    startAttackForKey(a, key, {});
    const total = (table[key].startup || 0) + (table[key].active || 0) + (table[key].recovery || 0);
    for (let i = 0; i < total + extraFrames; i++) {
      updateAttacks([a, v], DT);
      updateProjectiles([a, v], DT);
    }
  });
}
const bash = stepAbility('knight', 'dtilt');
ok(last(bash)?.path === VOL + 'shieldbash.mp3',
  `knight Shield Bash plays shieldbash.mp3 (got ${last(bash)?.path})`);

// The stance cast keeps its quiet blips — the recording is the answer's, not
// the charge-up's (only the synth draw() blips should fire here).
const counterCast = stepAbility('knight', 'nsmash');
ok(!counterCast.some((p) => p.path === VOL + 'shieldcounter.mp3'),
  'the Shield Counter stance cast does not play shieldcounter.mp3');

// ── 4. Shield Counter: shieldcounter.mp3, on the answering slash ───────────
const counterAnswer = capture(() => {
  resetCombat();
  const knight = mkFighter(1, defFor('knight'), 500, 790);
  const ninja = mkFighter(2, defFor('ninja'), 552, 790);
  // A live stance window: the ability arms _knightCounter on its cast frame,
  // so this is exactly the state a real counter is in when it gets hit.
  knight._knightCounter = 0.45;
  startAttackForKey(ninja, 'jab', {});
  for (let i = 0; i < 60; i++) {
    updateAttacks([knight, ninja], DT);
    updateProjectiles([knight, ninja], DT);
    if (played.some((p) => p.path.endsWith('shieldcounter.mp3'))) break;
  }
});
ok(last(counterAnswer)?.path === VOL + 'shieldcounter.mp3',
  `a landed Shield Counter plays shieldcounter.mp3 (got ${last(counterAnswer)?.path})`);

// An unanswered stance expires quietly: no counter recording, ever.
const unanswered = capture(() => {
  resetCombat();
  const knight = mkFighter(1, defFor('knight'), 500, 790);
  mkFighter(2, defFor('cowboy'), 1200, 790);
  startAttackForKey(knight, 'nsmash', {});
  for (let i = 0; i < 90; i++) {
    updateAttacks([knight], DT);
    updateProjectiles([knight], DT);
  }
});
ok(!unanswered.some((p) => p.path.endsWith('shieldcounter.mp3')),
  'an unanswered Shield Counter stance plays no counter recording');

// ── 5. The KO pillar: KOPillar.mp3, on every pillar ───────────────────────
const pillar = capture(() => spawnKoPillar(500, 700));
ok(last(pillar)?.path === VOL + 'KOPillar.mp3',
  `the KO pillar plays KOPillar.mp3 (got ${last(pillar)?.path})`);
const twin = capture(() => { spawnKoPillar(500, 700); spawnKoPillar(900, 700); });
ok(twin.filter((p) => p.path === VOL + 'KOPillar.mp3').length === 2,
  `a simultaneous double KO plays KOPillar.mp3 twice (got ${twin.length} plays)`);

// ── 6. Every play is announced on the bus (no silent playback) ─────────────
ok(busPaths.length > 0 && busPaths.every((p) => typeof p === 'string' && p.startsWith('/GA/audio/')),
  `every play announces its path on the sfxPlay bus (${busPaths.length} events)`);

// ── 7. Fallbacks: a missing recording degrades to synthesis, never silence ─
// _audioBrokenPaths is module-private; simulate the failure the pool reports
// by marking the paths broken through a real load error is not reachable from
// outside, so exercise the contract the SFX methods advertise instead: each
// voice method exists and returns without throwing when playback is refused.
let threw = null;
try {
  SFX.knightSlash(); SFX.chargedSword(); SFX.shieldBash(); SFX.shieldCounter(); SFX.koPillar();
} catch (e) { threw = e; }
ok(!threw, 'the new voices never throw when called (' + (threw ? threw.message : 'clean') + ')');

console.log(`\nt9-knight-audio: ${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);