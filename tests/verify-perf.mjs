// verify-perf.mjs — checks the ?perf HUD actually mounts and shows numbers.
import { chromium } from 'playwright';

const browser = await chromium.launch({
  headless: true,
  executablePath: 'C:/Users/User/AppData/Local/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-win64/chrome-headless-shell.exe',
  args: ['--enable-unsafe-swiftshader', '--no-first-run'],
});
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });

const errors = [];
page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
page.on('console', m => { if (m.type() === 'error') errors.push('CONSOLE: ' + m.text()); });

await page.goto('http://localhost:5173/?perf', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('canvas');
await new Promise(r => setTimeout(r, 3000));

const state = await page.evaluate(() => {
  const huds = [...document.querySelectorAll('div')].filter(d => (d.style.cssText || '').includes('99999'));
  const snap = typeof window.__perfSnapshot === 'function' ? window.__perfSnapshot() : null;
  return {
    hookInstalled: window.__PERF_HOOK_INSTALLED === true,
    hasSnapshot: typeof window.__perfSnapshot === 'function',
    hudCount: huds.length,
    hudText: huds[0] ? huds[0].textContent.slice(0, 300) : null,
    snapshot: snap,
  };
});

console.log('installed        ', state.hookInstalled);
console.log('hasSnapshot      ', state.hasSnapshot);
console.log('hudCount         ', state.hudCount);
console.log('hudText:');
console.log(state.hudText);
console.log('snapshot         ', JSON.stringify(state.snapshot));
console.log('errors:');
for (const e of errors) console.log('  ' + e);
if (!errors.length) console.log('  (none)');

// start a match so the HUD reflects real gameplay paint
await page.evaluate(() => {
  const rows = [...document.querySelectorAll('#term-lines .term-row')];
  const start = rows.find(r => r.textContent.includes('START'));
  if (start) { start.click(); return true; }
  return false;
});
// Space, not Enter: START MATCH now only ARMS the match and waits for a
// confirming press, and Enter is not bound to any action so it cannot open the
// gate. Space is P1's jump key, which the gate accepts.
await page.keyboard.press('Space');
await new Promise(r => setTimeout(r, 3000));
const hudText2 = await page.evaluate(() => {
  const huds = [...document.querySelectorAll('div')].filter(d => (d.style.cssText || '').includes('99999'));
  return huds[0] ? huds[0].textContent : null;
});
console.log('\nhud during gameplay:');
console.log(hudText2);
await page.screenshot({ path: 'perf-hud.png' });
await browser.close();