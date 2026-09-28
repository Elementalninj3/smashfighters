// verify-ninja-variety.mjs — ninja skin + sword-in-hand + AI attack variety.
import { chromium } from 'playwright';

const URL = 'http://localhost:5173/?probe';
const EXE = 'C:/Users/User/AppData/Local/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-win64/chrome-headless-shell.exe';

let passes = 0, failures = 0;
function ok(cond, msg) {
  if (cond) { passes++; console.log('  PASS  ' + msg); }
  else { failures++; console.log('  FAIL  ' + msg); }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const browser = await chromium.launch({ headless: true, executablePath: EXE, args: ['--enable-unsafe-swiftshader', '--no-first-run'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 1100 } });
const errors = [];
page.on('pageerror', (err) => { errors.push(err.message); console.log('[pageerror]', err.message); });
page.on('console', (msg) => { if (msg.type() === 'error') { errors.push(msg.text()); console.log('[console.error]', msg.text()); } });
const state = () => page.evaluate(() => (window.__ssTest ? window.__ssTest.state() : null));

await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('canvas', { timeout: 15000 });
await sleep(1200);

console.log('== 1. ninja skin asset ==');
const skin = await page.evaluate(async () => {
  try {
    const res = await fetch('/GA/skins/ninga.png');
    if (!res.ok) return { ok: false, status: res.status };
    const blob = await res.blob();
    const bmp = await createImageBitmap(blob);
    return { ok: true, w: bmp.width, h: bmp.height };
  } catch (e) { return { ok: false, error: String(e) }; }
});
ok(skin.ok && skin.w > 100 && skin.h > 100, `ninga.png loads and decodes (${skin.w}x${skin.h})`);

console.log('== 2. ninja sword in weapon system ==');
const lib = await page.evaluate(async () => {
  const m = await import('/src/anim/weapons.js');
  const w = m.getWeapon('ninjaSword');
  const anims = await import('/src/anim/library.js');
  const ids = ['ninjaJab', 'ninjaFtilt', 'ninjaNsmash', 'ninjaUtilt', 'ninjaUsmash', 'ninjaDtilt', 'ninjaDsmash', 'ninjaNair', 'ninjaFair', 'ninjaDash'];
  const refs = {};
  for (const id of ids) {
    const a = anims.getAnimation(id);
    refs[id] = a && a.weapons && a.weapons.right ? a.weapons.right.id : null;
  }
  return { def: w ? { id: w.id, sprite: w.sprite, w: w.w, h: w.h, grip: w.anchors.grip, tip: w.anchors.tip } : null, refs };
});
ok(!!lib.def && lib.def.sprite === '/GA/weapons/sword.png', `ninjaSword registered with sprite (${JSON.stringify(lib.def)})`);
const katanaLeft = Object.entries(lib.refs).filter(([, v]) => v === 'katana');
const swordRefs = Object.entries(lib.refs).filter(([, v]) => v === 'ninjaSword');
console.log('   ninja anim weapon refs:', JSON.stringify(lib.refs));
ok(katanaLeft.length === 0, 'no ninja anim still points at procedural katana');
ok(swordRefs.length >= 8, `${swordRefs.length} ninja anims wield the sword`);

console.log('== 3. sword follows the hand live ==');
await page.evaluate(() => window.__ssTest.setMode('AIvsAI'));
await page.evaluate(() => window.__ssTest.setDifficulty('Hard'));
// Re-query rows on every click: each click re-renders the menu (stale refs
// would silently no-op and leave the wrong matchup selected).
async function setRow(label, want) {
  for (let g = 0; g < 6; g++) {
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
await setRow('YOUR FIGHTER', 'Cowboy');
await setRow('OPPONENT FIGHTER', 'Ninja');
const matchup = await page.evaluate(() => [...document.querySelectorAll('#term-lines .term-row')]
  .filter((x) => x.textContent.includes('FIGHTER')).map((x) => x.textContent));
console.log('   matchup rows:', JSON.stringify(matchup));
ok(matchup.some((x) => x.includes('YOUR FIGHTER') && x.includes('Cowboy'))
  && matchup.some((x) => x.includes('OPPONENT FIGHTER') && x.includes('Ninja')),
  'Cowboy-vs-Ninja matchup selected');
await page.evaluate(() => {
  const row = [...document.querySelectorAll('#term-lines .term-row')].find((x) => x.textContent.includes('START MATCH'));
  if (row) row.click();
  // The start gate needs a confirming press before the match begins: dispatch a
  // real Space keydown/keyup AFTER the click (startNewMatch flushes edges, so the
  // press must come after it) to open the gate.
  window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', bubbles: true }));
  window.dispatchEvent(new KeyboardEvent('keyup', { code: 'Space', bubbles: true }));
});
await sleep(800);
// Catch the ninja (P2) mid-swing and read the resolved hand weapon. The
// shuriken-throw (fsmash) correctly wields the shuriken; every other ninja
// swing must resolve the sword. Skip the opening seconds (spawn spacing means
// pure zoning — no melee to catch) and poll the mid-game mix instead.
await sleep(8000);
let wield = null, shurikenOk = false;
for (let i = 0; i < 400 && !wield; i++) {
  const s = await state();
  if (s && s.gameState === 'playing' && s.fighters[1] && s.fighters[1].attackKey) {
    const atk = s.fighters[1].attackKey;
    const pose = await page.evaluate(() => window.__ssTest.pose(2));
    const right = pose && pose.weapons && pose.weapons.right;
    if (right && right.id) {
      if (atk === 'fsmash') {
        if (right.id === 'shuriken') shurikenOk = true;
      } else {
        wield = { attack: atk, weapon: right.id, anim: pose.animId };
      }
    }
  }
  await sleep(40);
}
console.log('   caught wield:', JSON.stringify(wield), 'shuriken-throw ok:', shurikenOk);
ok(!!wield && wield.weapon === 'ninjaSword', `sword resolved in ninja hand mid-attack (${wield && wield.weapon} during ${wield && wield.attack})`);
await page.screenshot({ path: 'tests/ninja-sword.png' });

console.log('== 4. AI attack variety (30s AIvsAI) ==');
await sleep(30000);
const s = await state();
const per = (ai) => {
  const st = (ai && ai.stats) || {};
  const atkKeys = ['jab', 'nsmash', 'ftilt', 'fsmash', 'utilt', 'usmash', 'dtilt', 'dsmash', 'aerialLight', 'aerialHeavy', 'dash'];
  const counts = {};
  let total = 0;
  for (const k of atkKeys) { const v = st[k] || 0; if (v > 0) { counts[k] = v; total += v; } }
  const distinct = Object.keys(counts).length;
  const top = total ? Math.max(...Object.values(counts)) / total : 0;
  return { counts, total, distinct, top, combat: (ai && ai.combat) || {} };
};
const p1 = per(s.ai[0]), p2 = per(s.ai[1]);
console.log('   P1:', JSON.stringify(p1));
console.log('   P2:', JSON.stringify(p2));
for (const [i, p] of [p1, p2].entries()) {
  ok(p.total >= 8, `P${i + 1} threw volume (${p.total} tracked swings)`);
  ok(p.distinct >= 4, `P${i + 1} uses ${p.distinct} distinct attacks (no one-trick)`);
  ok(p.top <= 0.65, `P${i + 1} top move share ${(p.top * 100).toFixed(0)}% (no spam loop)`);
}
ok((p1.counts.dtilt || 0) + (p2.counts.dtilt || 0) >= 2, 'Down Light in the mix');
ok((p1.counts.dsmash || 0) + (p2.counts.dsmash || 0) >= 1, 'Down Heavy in the mix');
const acc = [p1, p2].map((p) => p.combat);
for (const [i, c] of acc.entries()) {
  // Damage events per swing. The connect gate (≥0.3, ≥0.2 punish) structurally
  // guarantees every swing was reachable when thrown; remaining misses are
  // the allowed kind (dodges, blocks, mispredicts). Ninja carries no volley,
  // so its acc IS hit rate — clearly above blind-whiff territory.
  if (c.attacks >= 6) ok(c.acc >= 0.3, `P${i + 1} still connects (acc=${c.acc}, ${c.hits}/${c.attacks})`);
}
await page.keyboard.press('KeyM');
await sleep(400);

console.log('== console ==');
const realErrors = errors.filter((e) => !/swiftshader|WebGL|AudioContext/i.test(e));
ok(realErrors.length === 0, `no page errors (${realErrors.length}: ${realErrors.slice(0, 3).join(' | ')})`);

console.log(`\nRESULT: ${passes} passed, ${failures} failed`);
await browser.close();
process.exit(failures ? 1 : 0);
