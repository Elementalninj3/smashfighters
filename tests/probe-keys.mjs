// probe-keys.mjs - dump what attack keys actually resolve on the LIVE model.
import { chromium } from 'playwright';
const URL = 'http://localhost:5173/?probe';
const EXE = 'C:/Users/User/AppData/Local/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-win64/chrome-headless-shell.exe';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const browser = await chromium.launch({ headless: true, executablePath: EXE, args: ['--no-sandbox', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 800, height: 900 } });
await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('canvas', { timeout: 15000 });
await sleep(600);
const st = () => page.evaluate(() => window.__ssTest ? window.__ssTest.state() : null);
const resolved = (k) => page.evaluate(kk => window.__ssTest.resolvedDef(kk), k);
const animExists = (id) => page.evaluate(i => window.__ssTest.animExists(i), id);
console.log('state keys:', Object.keys(await st() || {}));
const s0 = await st();
console.log('gameState=', s0.gameState甚至是, 'overlay=', s0.overlay);
const keys = ['jab','ftilt','utilt','dtilt','nsmash','fsmash','usmash','dsmash','nspecial','sspecial','uspecial','dspecial','aerialLight','aerialHeavy','nair','fair','bair','uair','dair','dairDive','cowboyDownHeavy','cowboyUpHeavy','cowboySideHeavy','neutral','side','up','down','dodge','roll','spotdodge'];
for (const k of keys) {
  const d = await resolved(k);
  if (d) console.log('RESOLVE', k, '->', JSON.stringify({ name: d.name, abilityType: d.abilityType, abilityId: d.abilityId, hitboxCount: d.hitboxCount, recoveryX: d.recoveryX, recoveryY: d.recoveryY, recoveryDuration: d.recoveryDuration, dmg: d.dmg, kbBase: d.kbBase, kbGrowth: d.kbGrowth }));
}
console.log('--- anims ---');
for (const a of ['nair','fair','bair','uair','dair','dairDiveRise','dairDiveHit','dairDiveDrop','dairDiveLand','cowboyDownHeavy','cowboyTrail','aerialLight','aerialHeavy','hitboxLanded','none']) {
  const e = await animExists(a);
  console.log('anim', a, '=', e);
}
await browser.close();
