// core/loop.js — the frame loop and the hit-stop clock that rides on it.
//
// Two independent pieces of timing, kept together because they are the only
// code that decides WHEN a frame happens:
//   - startGameLoop() owns requestAnimationFrame and never dies.
//   - freezeGame()/stepFreeze() own the brief pause that makes heavy ability
//     detonations land.

// ── Game loop ────────────────────────────────────────────────────────────
// Fixed-timestep accumulator over a variable rAF cadence: simulation always
// advances in 1/60s steps so attacks (frame-counted), physics and AI behave
// identically on 60Hz/120Hz/144Hz displays, while rendering still runs every
// rAF. At most MAX_STEPS steps run per frame so a hitch can never spiral into
// catch-up; leftover time is dropped (slow-mo under extreme hitch, never a
// spike). Single rAF chain, never dies on exception.
const FIXED_DT = 1 / 60;
const MAX_STEPS = 3;
export function startGameLoop(update, render) {
  let last = performance.now();
  let acc = 0;
  let rafId = null;
  function frame(now) {
    let elapsed = (now - last) / 1000;
    last = now;
    // Clamp tab-switch/hitch input, then accumulate fixed steps.
    if (elapsed > 0.25) elapsed = 0.25;
    if (elapsed < 0) elapsed = 0;
    acc += elapsed;
    if (acc > FIXED_DT * MAX_STEPS) acc = FIXED_DT * MAX_STEPS;
    let steps = 0;
    try {
      while (acc >= FIXED_DT && steps < MAX_STEPS) {
        update(FIXED_DT, now);
        acc -= FIXED_DT;
        steps++;
      }
      // If no step ran (high-refresh rAF faster than 60Hz), still render.
      // Leftover fractional time stays in acc for the next frame.
    } catch (e) {
      console.error('[game-loop] update failed:', e);
      acc = 0;
    }
    try {
      render(now);
    } catch (e) {
      console.error('[game-loop] render failed:', e);
    }
    rafId = requestAnimationFrame(frame);
  }
  rafId = requestAnimationFrame(frame);
  return () => cancelAnimationFrame(rafId); // returns a stop function
}

// ── Freeze frames (hitstop) ──────────────────────────────────────────────
// Briefly pauses gameplay. Used for dramatic impact frames on big ability
// detonations. Calling freezeGame() while already frozen extends the freeze.
let freezeRemaining = 0;

export function freezeGame(duration = 0.08) {
  freezeRemaining = Math.max(freezeRemaining, duration);
}

// Returns true while the game is frozen. Call once per frame from update().
export function stepFreeze(dt) {
  if (freezeRemaining > 0) {
    freezeRemaining = Math.max(0, freezeRemaining - dt);
    return true;
  }
  return false;
}
