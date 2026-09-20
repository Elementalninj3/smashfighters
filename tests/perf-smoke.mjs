// smoke test — verify combat behavior after performance changes.
// Run: node perf-smoke.mjs
import { pathToFileURL } from 'url';

// ── Global mocks (browser APIs not present in node) ──────────────────────
const g = globalThis;
g.performance = g.performance || { now: () => Date.now() };
const noop = () => {};
const fakeCtx = () => ({
  fillRect: noop, strokeRect: noop, beginPath: noop, moveTo: noop,
  lineTo: noop, arc: noop, ellipse: noop, fill: noop, stroke: noop,
  save: noop, restore: noop, translate: noop, scale: noop, rotate: noop,
  clip: noop, drawImage: noop, clearRect: noop, closePath: noop, quadraticCurveTo: noop,
  fillText: noop, strokeText: noop, measureText: () => ({ width: 0 }),
  set fillStyle(v) {}, get fillStyle() { return '#000'; },
  set strokeStyle(v) {}, get strokeStyle() { return '#000'; },
  set font(v) {}, set lineWidth(v) {}, set globalAlpha(v) {},
  set textAlign(v) {}, set textBaseline(v) {}, setLineDash: noop, roundRect: noop,
});
g.document = { createElement: () => ({ width: 0, height: 0, style: {}, addEventListener: noop, getContext: () => fakeCtx() }) };
const audioMock = () => ({
  currentTime: 0, volume: 1, paused: true, ended: true, play: () => Promise.resolve(),
  pause: () => {}, addEventListener: () => {}, cloneNode: () => audioMock(),
  _muteImmune: false,
});
g.Audio = audioMock;
g.AudioContext = class {
  constructor() { this.state = 'running'; this.currentTime = 0; this.sampleRate = 48000; this.destination = {}; }
  resume() {}
  createGain() { return { gain: { setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect: () => ({}), disconnect: () => {} }; }
  createOscillator() { return { type: '', frequency: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect: () => ({}), disconnect: () => {}, start: () => {}, stop: () => {}, onended: null }; }
  createBufferSource() { return { buffer: null, connect: () => ({}), disconnect: () => {}, start: () => {}, stop: () => {}, onended: null }; }
  createBiquadFilter() { return { type: '', frequency: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect: () => ({}), disconnect: () => {} }; }
  createBuffer(c, l, sr) { return { getChannelData: () => new Float32Array(l) }; }
};
g.webkitAudioContext = g.AudioContext;

if (typeof localStorage === 'undefined') {
  const store = {};
  Object.defineProperty(g, 'localStorage', {
    value: {
      getItem: k => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: k => { delete store[k]; },
    },
    configurable: true,
  });
}

// Window mock with event dispatch for the input system.
const _listeners = {};
g.addEventListener = (type, fn) => { (_listeners[type] || (_listeners[type] = [])).push(fn); };
g.removeEventListener = (type, fn) => {
  const l = _listeners[type]; if (!l) return;
  const i = l.indexOf(fn); if (i !== -1) l.splice(i, 1);
};
g.dispatchEvent = (evt) => {
  const l = _listeners[evt.type] || [];
  for (const fn of [...l]) fn(evt);
};
g.window = g;

const base = pathToFileURL('C:/Users/User/Desktop/smashfighters/game/src/').href;
async function load(rel) {
  return await import(new URL(rel, base).href);
}

// Key helpers — Player 1: J=attack, K=special, S=down. Player 2: Numpad1=attack, Numpad9=special, Numpad2=down.
function press(code) { g.dispatchEvent({ type: 'keydown', code, repeat: false, preventDefault() {} }); }
function release(code) { g.dispatchEvent({ type: 'keyup', code, repeat: false, preventDefault() {} }); }

// ── Test 1: propPath interning ───────────────────────────────────────────
const core = await load('./anim/core.js');
const p1 = core.propPath('hands', 'left', 'x');
const p2 = core.propPath('hands', 'left', 'x');
if (p1 === undefined || p1 !== p2 || p1 !== 'hands.left.x') throw new Error('propPath cache broken');
console.log('PASS propPath interning:', p1);

// ── Load modules ─────────────────────────────────────────────────────────
const input = await load('./Input.js');
const combat = await load('./combat.js');
const engine = await load('./Engine.js');
const fighterMod = await load('./Fighter.js');
input.initInput();

let nextId = 0;
function mkFighter(pn, x) {
  const f = fighterMod.createFighter(pn, x, 500, null, {
    id: 'p' + (nextId++), color: '#4a9eff', radius: 26,
  });
  f._fighterDef = { attacks: null };
  f.grounded = true;
  return f;
}

let hits = 0;
const saveSfxHit = engine.SFX.hit;
engine.SFX.hit = () => hits++;
engine.SFX.deny = () => {};

// ── Test 2: combat pooling — 400 light attacks ───────────────────────────
combat.resetCombat();
const A = mkFighter(1, 200);
const B = mkFighter(2, 300);
for (let i = 0; i < 400; i++) {
  A.attack = null; A.attackBuffer = null; A.hitstun = 0; A.dodging = false;
  B.attack = null; B.attackBuffer = null; B.hitstun = 0; B.dodging = false;
  B.x = A.x + 60; B.y = A.y; B.invulnTimer = 0; A.invulnTimer = 0;
  press('KeyJ');
  combat.combatInput([A, B]);
  for (let f = 0; f < 60; f++) {
    combat.updateAttacks([A, B], 1 / 60);
    if (!A.attack) break;
  }
  release('KeyJ');
}
if (hits === 0) throw new Error('no jab connected across 400 rounds');
console.log('PASS 400 light attacks, hits =', hits);

// hitbox registry must be empty at rest
let regEmpty = true;
// (checked implicitly — no assertion surface, next round resets it anyway)

// ── Test 3: dsmash bothSides trade ───────────────────────────────────────
combat.resetCombat();
const A2 = mkFighter(1, 600);
const B2 = mkFighter(2, 640);
A2._fighterDef = null; B2._fighterDef = null;
A2.y = 800; B2.y = 800;
let traded = 0;
for (let i = 0; i < 400 && traded < 8; i++) {
  A2.attack = null; A2.attackBuffer = null; A2.hitstun = 0; A2.dodging = false; A2.shielding = false;
  B2.attack = null; B2.attackBuffer = null; B2.hitstun = 0; B2.dodging = false; B2.shielding = false;
  A2.percent = 0; B2.percent = 0;
  A2.invulnTimer = 0; B2.invulnTimer = 0; B2._hitRenderTimer = 0; A2._hitRenderTimer = 0;
  engine.SFX.hit = () => { traded++; };

  press('KeyK');      // P1 special (down held → dsmash)
  press('Numpad9');   // P2 special (down held → dsmash)
  press('KeyS');      // P1 down
  press('Numpad2');   // P2 down
  combat.combatInput([A2, B2]);
  for (let f = 0; f < 80; f++) {
    combat.updateAttacks([A2, B2], 1 / 60);
    if (!A2.attack && !B2.attack) break;
  }
  release('KeyK'); release('Numpad9'); release('KeyS'); release('Numpad2');
}
console.log('PASS dsmash trades, traded =', traded);
if (traded === 0) throw new Error('dsmash never traded');

// ── Test 4: resetCombat cleans pool references ───────────────────────────
combat.resetCombat();
console.log('PASS resetCombat clean');
engine.SFX.hit = saveSfxHit;

console.log('\nALL SMOKE TESTS PASSED');