// main.js â€” entry point for the platform fighter. Boots the game loop,
// initializes all systems, and runs the game.

import { startGameLoop } from './core/loop.js';
import { initGame, update, render } from './Game.js';

// [PROFILER] Opt-in perf HUD â€” loaded ONLY when the URL has ?perf.
// Loads as a classic script (keeps the game loop's first rAF from starting
// before the wrappers are installed). Zero cost when absent. REMOVE TOGETHER
// WITH src/tools/__perfHook.js once profiling is done.
if (new URLSearchParams(window.location.search).has('perf')) {
  const s = document.createElement('script');
  s.src = '/src/tools/__perfHook.js?h=' + Date.now();
  (document.head || document.documentElement).appendChild(s);
}

// Canvas setup â€” fixed 1200x1100 viewport
const urlParams = new URLSearchParams(window.location.search);
const handsBehind = urlParams.get('hands') === 'behind';
window.RENDER_HANDS_IN_FRONT = !handsBehind;
const canvas = document.createElement('canvas');
canvas.width = 1200;
canvas.height = 1100;
canvas.style.display = 'block';
canvas.style.position = 'fixed';
canvas.style.top = '50%';
canvas.style.left = '50%';
canvas.style.transform = 'translate(-50%, -50%)';
canvas.style.width = '1200px';
canvas.style.height = '1100px';
canvas.style.background = '#000';
canvas.style.border = '1px solid #222';
document.body.style.margin = '0';
document.body.style.padding = '0';
document.body.style.overflow = 'hidden';
document.body.style.background = '#000';
document.body.appendChild(canvas);

// Initialize the game
initGame(canvas);

// Start the game loop
startGameLoop(update, render);
