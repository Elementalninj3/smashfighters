// verify-ai-accuracy.mjs — AI combat accuracy + Down-attack usage.
// AIvsAI bouts: Down Light / Down Heavy must appear in real play, swings must
// connect at a healthy rate (no blind air-swinging), no errors/NaN.
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
const page = await browser.newPage({ viewport: { width: 1200, height: 1100 } });
const errors = [];
page.on('pageerror', (err) => { errors.push(err.message); console.log('[pageerror]', err.message); });
page.on('console', (msg) => { if (msg.type() === 'error') { errors.push(msg.text()); console.log('[console.error]', msg.text()); } });
const state = () => page.evaluate(() => (window.__ssTest ? window.__ssTest.state() : null));

async function runBout(p1idx, p2idx, difficulty, seconds, label) {
  console.log(`== ${label} ==`);
  await page.evaluate(() => window.__ssTest.setMode('AIvsAI'));
  await page.evaluate(() => window.__ssTest.setDifficulty('Normal'));
  // Set fighters via menu rows (re-query every click: each click re-renders
  // the menu AND the first click on a row only selects it — stale/assumed
  // clicks silently select the wrong matchup).
  const names = ['Cowboy', 'Ninja'];
  async function setRow(label, want) {
    for (let g = 0; g < 8; g++) {
      const txt = await page.evaluate((l) => {
        const row = [...document.querySelectorAll('#term-lines .term-row')].find((x) => x.textContent.includes(l));
        return row ? row.textContent : null;
      }, label);
      if (!txt || txt.includes(names[want])) return txt;
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
  await setRow('YOUR FIGHTER', p1idx);
  await setRow('OPPONENT FIGHTER', p2idx);
  const matchup = await page.evaluate(() => [...document.querySelectorAll('#term-lines .term-row')]
    .filter((x) => x.textContent.includes('FIGHTER')).map((x) => x.textContent));
  ok(matchup.some((x) => x.includes('YOUR FIGHTER') && x.includes(names[p1idx]))
    && matchup.some((x) => x.includes('OPPONENT FIGHTER') && x.includes(names[p2idx])),
    `${label}: matchup ${names[p1idx]}-vs-${names[p2idx]} selected`);
  await page.evaluate((d) => window.__ssTest.setDifficulty(d), difficulty);
  await sleep(250);
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
  let s = await state();
  ok(s && s.gameState === 'playing', `${label}: bout starts`);
  // Sample mid-bout: positions must stay finite, AI deciding.
  await sleep((seconds * 1000) / 2);
  s = await state();
  const finite = s && s.fighters.every((f) => Number.isFinite(f.x) && Number.isFinite(f.y) && Number.isFinite(f.percent));
  ok(finite, `${label}: positions/percents finite mid-bout`);
  ok(s && s.ai && s.ai[0] && s.ai[1], `${label}: both AI live mid-bout`);
  await sleep((seconds * 1000) / 2);
  s = await state();
  const a0 = s.ai[0], a1 = s.ai[1];
  const st0 = (a0 && a0.stats) || {}, st1 = (a1 && a1.stats) || {};
  const c0 = (a0 && a0.combat) || { attacks: 0, hits: 0, acc: 0 };
  const c1 = (a1 && a1.combat) || { attacks: 0, hits: 0, acc: 0 };
  const dtilt = (st0.dtilt || 0) + (st1.dtilt || 0);
  const dsmash = (st0.dsmash || 0) + (st1.dsmash || 0);
  console.log(`   P1 combat=${JSON.stringify(c0)} dtilt=${st0.dtilt || 0} dsmash=${st0.dsmash || 0} state=${a0 && a0.state}`);
  console.log(`   P2 combat=${JSON.stringify(c1)} dtilt=${st1.dtilt || 0} dsmash=${st1.dsmash || 0} state=${a1 && a1.state}`);
  console.log(`   percents: P1=${s.fighters[0].percent.toFixed(1)} P2=${s.fighters[1].percent.toFixed(1)} stocks=${s.stocks}`);
  await page.keyboard.press('KeyM');
  await sleep(400);
  return { c0, c1, dtilt, dsmash, s };
}

await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('canvas', { timeout: 15000 });
await sleep(1200);

const r1 = await runBout(0, 1, 'Normal', 36, 'Test 1/2 — Cowboy vs Ninja, Normal, 36s');
ok(r1.dtilt >= 2, `Down Light used in real play (total ${r1.dtilt})`);
ok(r1.c0.attacks >= 4 && r1.c1.attacks >= 4, `AI threw meaningful volume (${r1.c0.attacks}/${r1.c1.attacks} swings)`);
for (const [i, c] of [r1.c0, r1.c1].entries()) {
  // Damage events per swing: volleys/projectiles can exceed 1; blind
  // air-swinging would sit near 0. Healthy bar: clearly above whiff territory.
  if (c.attacks >= 6) ok(c.acc >= 0.4, `P${i + 1} connects at healthy rate (acc=${c.acc}, ${c.hits}/${c.attacks})`);
}

const r2 = await runBout(1, 0, 'Hard', 30, 'Test 4 — Ninja vs Cowboy, Hard, 30s');
ok(r2.dtilt + r2.dsmash >= 2, `down attacks appear reversed matchup (dtilt=${r2.dtilt} dsmash=${r2.dsmash})`);
ok(r1.dsmash + r2.dsmash >= 2, `Down Heavy used across bouts (total ${r1.dsmash + r2.dsmash})`);
for (const [i, c] of [r2.c0, r2.c1].entries()) {
  if (c.attacks >= 6) ok(c.acc >= 0.3, `P${i + 1} connects reversed matchup (acc=${c.acc}, ${c.hits}/${c.attacks})`);
}

console.log('== Situational scoring (crafted states, live match) ==');
// Fresh AIvsAI bout (P1 = Cowboy) purely as a scoring stage.
await page.evaluate(() => window.__ssTest.setMode('AIvsAI'));
await page.evaluate(() => window.__ssTest.setDifficulty('Normal'));
async function setRow2(label, want) {
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
await setRow2('YOUR FIGHTER', 'Cowboy');
await setRow2('OPPONENT FIGHTER', 'Ninja');
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
// Helper: place fighters, sample scores fast, retry if the AI turned away.
async function situScores(p1patch, p2patch, needFacing = true) {
  for (let t = 0; t < 6; t++) {
    await page.evaluate(([a, b]) => { window.__ssTest.place(1, a); window.__ssTest.place(2, b); }, [p1patch, p2patch]);
    await sleep(90);
    const r = await page.evaluate(() => {
    const s = window.__ssTest.state();
    return { scores: window.__ssTest.aiScores(1, 40), f1: s.fighters[0], f2: s.fighters[1] };
  });
    if (!needFacing) return { ...r, dx: r.f2.x - r.f1.x };
    const dx = r.f2.x - r.f1.x;
    const facing = Math.abs(dx) < 8 || ((dx >= 0) === r.f1.facingRight);
    if (facing) return { ...r, dx };
  }
  return null;
}
const byKey = (list) => Object.fromEntries((list || []).map((e) => [e.key, e]));
// SIT-A: cowboy, grounded foe ahead at ride range, facing → horse + volley connect.
{
  const r = await situScores(
    { x: 450, y: 826, grounded: true, vx: 0, vy: 0, facingRight: true },
    { x: 600, y: 830, grounded: true, vx: 0, vy: 0, hitstun: 0 },
  );
  ok(!!r, 'SIT-A sampled facing the foe');
  if (r) {
    const m = byKey(r.scores);
    console.log('   SIT-A:', JSON.stringify(r.scores.slice(0, 4)));
    ok(m.dsmash && m.dsmash.connect > 0.35, `horse connects vs grounded foe ahead (${m.dsmash && m.dsmash.connect})`);
    ok(m.dtilt && m.dtilt.connect > 0.4, `volley connects vs grounded foe (${m.dtilt && m.dtilt.connect})`);
  }
}
// SIT-B: P2 ninja, grounded foe close in front/below → sweep must connect.
{
  let got = null;
  for (let t = 0; t < 6 && !got; t++) {
    await page.evaluate(() => {
      window.__ssTest.place(2, { x: 600, y: 826, grounded: true, vx: 0, vy: 0, facingRight: false });
      window.__ssTest.place(1, { x: 525, y: 845, grounded: true, vx: 0, vy: 0, facingRight: true });
    });
    await sleep(90);
    const r = await page.evaluate(() => {
      const s = window.__ssTest.state();
      return { scores: window.__ssTest.aiScores(2, 40), f1: s.fighters[0], f2: s.fighters[1] };
    });
    const dx = r.f1.x - r.f2.x;
    if (Math.abs(dx) < 8 || ((dx >= 0) === r.f2.facingRight)) got = r;
  }
  ok(!!got, 'SIT-B sampled (ninja facing foe)');
  if (got) {
    const m = Object.fromEntries((got.scores || []).map((e) => [e.key, e]));
    console.log('   SIT-B:', JSON.stringify((got.scores || []).slice(0, 4)));
    ok(m.dtilt && m.dtilt.connect > 0.4, `sweep connects vs low grounded foe (${m.dtilt && m.dtilt.connect})`);
    ok(m.dtilt && m.dtilt.score > 0.3, `sweep scores competitively (${m.dtilt && m.dtilt.score})`);
  }
}
// SIT-C: foe high above → down tools suppressed, up tools preferred.
// (Suppression is facing-independent, so no facing gate here.)
{
  const r = await situScores(
    { x: 600, y: 826, grounded: true, vx: 0, vy: 0, facingRight: true },
    { x: 620, y: 480, grounded: false, vx: 0, vy: 0, hitstun: 0 },
    false,
  );
  ok(!!r, 'SIT-C sampled');
  if (r) {
    const m = byKey(r.scores);
    console.log('   SIT-C:', JSON.stringify(r.scores.slice(0, 4)));
    const upBest = Math.max(m.utilt ? m.utilt.score : 0, m.usmash ? m.usmash.score : 0,
      m.aerialLight ? m.aerialLight.score : 0, m.aerialHeavy ? m.aerialHeavy.score : 0);
    ok(!m.dsmash || m.dsmash.score <= upBest, 'Down Heavy suppressed vs high foe');
  }
}
// SIT-D: foe across the stage → melee dead, long tools lead.
{
  const r = await situScores(
    { x: 420, y: 826, grounded: true, vx: 0, vy: 0, facingRight: true },
    { x: 780, y: 826, grounded: true, vx: 0, vy: 0, hitstun: 0 },
  );
  ok(!!r, 'SIT-D sampled');
  if (r) {
    const m = byKey(r.scores);
    console.log('   SIT-D:', JSON.stringify(r.scores.slice(0, 4)));
    ok(!m.jab || m.jab.connect < 0.2, `jab correctly reads unreachable (${m.jab ? m.jab.connect : 'not in top-6'})`);
    ok(r.scores[0] && (r.scores[0].kind === 'projectile' || r.scores[0].kind === 'deadeye'),
      `long tool leads at range (${r.scores[0] && r.scores[0].key})`);
  }
}
await page.keyboard.press('KeyM');
await sleep(400);

console.log('== Test 5 — console ==');
const realErrors = errors.filter((e) => !/swiftshader|WebGL|AudioContext/i.test(e));
ok(realErrors.length === 0, `no page errors (${realErrors.length}: ${realErrors.slice(0, 3).join(' | ')})`);

console.log(`\nRESULT: ${passes} passed, ${failures} failed`);
await browser.close();
process.exit(failures ? 1 : 0);
