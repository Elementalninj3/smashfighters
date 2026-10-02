// main.js — entry point for the platform fighter. Boots the game loop,
// initializes all systems, and runs the game.

import { startGameLoop } from './physics.js';
import { initGame, update, render } from './Game.js';
import { fitCanvasElement } from './render.js';

// [PROFILER] Opt-in perf HUD — loaded ONLY when the URL has ?perf.
// Loads as a classic script (keeps the game loop's first rAF from starting
// before the wrappers are installed). Zero cost when absent. REMOVE TOGETHER
// WITH src/tools/__perfHook.js once profiling is done.
if (new URLSearchParams(window.location.search).has('perf')) {
  const s = document.createElement('script');
  s.src = '/src/tools/__perfHook.js?h=' + Date.now();
  (document.head || document.documentElement).appendChild(s);
}

// Canvas setup — fixed 1080×1080 logical viewport (see render.js).
// The backing store is VIEW × devicePixelRatio for crisp output; the CSS box
// is a uniformly-scaled square centred in the window (letterboxed, never
// stretched). Game logic, camera framing and HUD layout all work in logical
// 1080 pixels and never see the backing scale.
const urlParams = new URLSearchParams(window.location.search);
const handsBehind = urlParams.get('hands') === 'behind';
window.RENDER_HANDS_IN_FRONT = !handsBehind;
const canvas = document.createElement('canvas');
canvas.style.display = 'block';
canvas.style.position = 'fixed';
canvas.style.top = '50%';
canvas.style.left = '50%';
canvas.style.transform = 'translate(-50%, -50%)';
canvas.style.background = '#000';
canvas.style.border = '1px solid #222';
document.body.style.margin = '0';
document.body.style.padding = '0';
document.body.style.overflow = 'hidden';
document.body.style.background = '#000';
document.body.appendChild(canvas);

// Square fit + DPR backing, refreshed on anything that can change the window
// geometry or the display density (resize, rotation, fullscreen, monitor
// move / browser zoom — the backing sync inside is idempotent, so calling it
// redundantly costs a comparison, never a realloc). Skipped while a canvas
// takeover editor (animator / hitbox customizer) owns the canvas: those run
// their own fullscreen layout and re-fit themselves, and a game-viewport
// refit underneath them is exactly what stretches their UI.
function refit() {
  try {
    if (canvas.dataset && canvas.dataset.editorTakeover) return;
    fitCanvasElement(canvas);
  } catch (_) {}
}
refit();
window.addEventListener('resize', refit);
window.addEventListener('orientationchange', refit);
document.addEventListener('fullscreenchange', refit);
try {
  if (typeof window.matchMedia === 'function') {
    const mq = window.matchMedia('(resolution: 1dppx)');
    if (mq && typeof mq.addEventListener === 'function') {
      mq.addEventListener('change', refit);
    } else if (mq && typeof mq.addListener === 'function') {
      mq.addListener(refit);
    }
  }
} catch (_) {}

// Initialize the game
initGame(canvas);

// Start the game loop
startGameLoop(update, render);
