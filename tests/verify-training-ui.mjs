// verify-training-ui.mjs — (G) AI training interface: 10 browser checks.
// Setup rows + validation, start/stop/pause/resume, progress, history,
// models, eval, import/export, delete, and empty states — all against the
// live ?probe dev server on :5173. Run: node tests/verify-training-ui.mjs
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
page.on('pageerror', err => console.log('[pageerror]', err.message));
await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('canvas', { timeout: 10000 });
await sleep(1200);

const train = (expr) => page.evaluate((e) => window.__ssTest ? eval(e) : null, expr);
const lines = () => page.evaluate(() => document.querySelector('#term-lines') ? document.querySelector('#term-lines').textContent : '');
const key = (code) => page.evaluate((c) => window.dispatchEvent(new KeyboardEvent('keydown', { code: c, bubbles: true })), code);

// open training submenu
await train(`window.__ssTest.aiTraining().open()`);
await sleep(300);

// 1. setup rows present with valid values.
{
  const t = await lines();
  const has = ['AI TRAINING', 'VIEW', 'TRAINING MODE', 'OPPONENT TYPE', 'START MODE', 'SCRIPTED STRENGTH', 'EVAL MATCHES'].every((s) => t.includes(s));
  ok(has, 'setup view shows view/mode/opp/start/difficulty/eval rows');
}
// 2. invalid config rejected, valid applied.
{
  const before = await lines();
  await train(`window.__ssTest.aiTraining().set({mode:'bogus',oppType:'nope',populationSize:5,maxGenerations:1,evalMatches:2})`);
  await sleep(200);
  const after = await lines();
  ok(after.includes('MATCHUP') && !after.includes('BOGUS'), 'invalid mode/opp rejected');
  await train(`window.__ssTest.aiTraining().set({mode:'character',oppType:'scripted',startMode:'new',scriptedDifficulty:'Easy',populationSize:2,maxGenerations:1,speed:'Fastest',showSim:false,evalMatches:2})`);
  await sleep(200);
  const t2 = await lines();
  ok(t2.includes('CHARACTER') && t2.includes('SCRIPTED'), 'valid mode/opp applied');
}
// 3. tiny run completes; progress carries phase/mode fields; history recorded.
{
  const h0 = await train(`window.__ssTest.aiTraining().history().length`);
  await train(`window.__ssTest.aiTraining().set({mode:'character',oppType:'scripted',startMode:'new',populationSize:2,maxGenerations:3,speed:'Fastest',showSim:false,evalMatches:2})`);
  await train(`window.__ssTest.aiTraining().start()`);
  // Poll early: browser bouts finish fast, so catch the live phase quickly.
  let live = null;
  for (let i = 0; i < 40; i++) {
    await sleep(150);
    const p = await train(`window.__ssTest.aiTraining().progress()`);
    if (p && p.running) { live = p; break; }
  }
  ok(live && live.phase === 'training' && live.mode === 'character' && live.oppType === 'scripted', `progress live (${live && live.phase}/${live && live.mode}/${live && live.oppType})`);
  let done = null;
  for (let i = 0; i < 150; i++) {
    await sleep(1000);
    const q = await train(`window.__ssTest.aiTraining().progress()`);
    if (q && !q.running) { done = q; break; }
  }
  const h1 = await train(`window.__ssTest.aiTraining().history().length`);
  ok(!!done && done.generation >= 3 && h1 === h0 + 1, `run completes + history recorded (gen ${done && done.generation})`);
}
// 4. pause/resume mid-run.
{
  await train(`window.__ssTest.aiTraining().set({mode:'matchup',oppType:'coevolve',populationSize:2,maxGenerations:6,speed:'Fastest',showSim:false})`);
  await train(`window.__ssTest.aiTraining().start()`);
  // Pause on the same tick: runs finish in seconds, so don't wait first.
  const paused = await train(`window.__ssTest.aiTraining().pause()`);
  const snap = await train(`window.__ssTest.aiTraining().progress()`);
  const m0 = snap ? snap.matchesPlayed : -1;
  await sleep(600);
  const snap2 = await train(`window.__ssTest.aiTraining().progress()`);
  const resumed = await train(`window.__ssTest.aiTraining().resume()`);
  ok(paused === true && snap && snap.paused === true && resumed === true && snap2.matchesPlayed === m0, 'pause freezes progress, resume works');
  for (let i = 0; i < 150; i++) {
    await sleep(1000);
    const q = await train(`window.__ssTest.aiTraining().progress()`);
    if (q && !q.running) break;
  }
  const q2 = await train(`window.__ssTest.aiTraining().progress()`);
  ok(q2 && !q2.running && q2.generation >= 6, `resumed run finishes (gen ${q2 && q2.generation})`);
}
// 5. models saved + activate/rename via probe.
{
  const models = await train(`window.__ssTest.aiTraining().models('cowboy')`);
  ok(Array.isArray(models) && models.length >= 1 && models[0].id, `model saved for cowboy (${models.length})`);
  const id = models[0].id;
  const rn = await train(`window.__ssTest.aiTraining().rename('cowboy','${id}','uitest')`);
  const act = await train(`window.__ssTest.aiTraining().activate('cowboy','${id}')`);
  const m = await train(`window.__ssTest.aiTraining().model('cowboy','${id}')`);
  ok(rn === true && act === true && m && m.name === 'uitest', 'rename + activate work');
}
// 6. evaluation returns a real report.
{
  const models = await train(`window.__ssTest.aiTraining().models('cowboy')`);
  const rep = await train(`window.__ssTest.aiTraining().evalModel('cowboy','${models[0].id}',2)`);
  ok(rep && rep.ok && rep.matches === 2 && rep.perMatch.length === 2 && Number.isFinite(rep.winRate), `eval real report (${rep && rep.wins}/${rep && rep.matches} wins)`);
}
// 7. export/import roundtrip; malformed rejected.
{
  const models = await train(`window.__ssTest.aiTraining().models('cowboy')`);
  const exp = await train(`window.__ssTest.aiTraining().exportJson('cowboy','${models[0].id}')`);
  const bad = await train(`window.__ssTest.aiTraining().importJson('##not-json##',{})`);
  ok(exp && exp.ok && exp.json.length > 1000 && !bad.ok, 'export produces JSON, garbage rejected');
  const n0 = (await train(`window.__ssTest.aiTraining().models('cowboy')`)).length;
  const imp2 = await page.evaluate(async () => {
    const exp2 = window.__ssTest.aiTraining().exportJson('cowboy', window.__ssTest.aiTraining().models('cowboy')[0].id);
    return window.__ssTest.aiTraining().importJson(exp2.json, {});
  });
  const n1 = (await train(`window.__ssTest.aiTraining().models('cowboy')`)).length;
  ok(imp2.ok && n1 === n0 + 1, 'valid export re-imports as new version');
}
// 8. delete removes; history view shows runs.
{
  const models = await train(`window.__ssTest.aiTraining().models('cowboy')`);
  const victim = models[models.length - 1].id;
  const del = await train(`window.__ssTest.aiTraining().remove('cowboy','${victim}')`);
  const gone = await train(`window.__ssTest.aiTraining().model('cowboy','${victim}')`);
  ok(del === true && gone === null, 'delete removes model');
  // history view DOM lists runs
  await key('ArrowRight'); await sleep(250); // setup -> progress
  await key('ArrowRight'); await sleep(250); // progress -> history
  const t = await lines();
  ok(t.includes('RUN 1') || t.includes('RUNS') || /RUN [0-9a-f]/.test(t) || t.includes('GENS'), 'history view lists runs');
}
// 9. models view DOM renders (navigate to models).
{
  await key('ArrowRight'); await sleep(250); // history -> models
  const t = await lines();
  ok(t.includes('MODELS') && (t.includes('CHARACTER') || t.includes('NO SAVED MODELS') || t.includes('SELECTED')), 'models view renders');
}
// 10. empty-state: remove all cowboy models -> models view shows empty text.
{
  const models = await train(`window.__ssTest.aiTraining().models('cowboy')`);
  for (const m of models) await train(`window.__ssTest.aiTraining().remove('cowboy','${m.id}')`);
  const left = await train(`window.__ssTest.aiTraining().models('cowboy')`);
  // Probe deletes bypass the UI cache; cycling views refreshes it like real use.
  await key('ArrowRight'); await sleep(200); // models -> setup
  await key('ArrowRight'); await sleep(200); // setup -> progress
  await key('ArrowRight'); await sleep(200); // progress -> history
  await key('ArrowRight'); await sleep(300); // history -> models (refresh)
  const t = await lines();
  ok(left.length === 0 && (t.includes('NO SAVED MODELS') || t.includes('no models')), 'empty models state shown');
}

console.log('== summary ==');
console.log(`${passes} passed, ${failures} failed`);
await browser.close();
process.exit(failures ? 1 : 0);
