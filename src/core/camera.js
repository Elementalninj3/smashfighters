// core/camera.js — the single dynamic camera, plus the shake offset it draws
// with. Every world->screen transform in the game goes through
// applyCameraTransform(), so this file owns all camera state.
//
// Smash-style dynamic camera
// --------------------------
// One camera, two framing regimes, chosen per frame inside computeFraming().
// Tracks BOTH players: midpoint follow + dynamic zoom, vertical-aware,
// off-stage-aware. Smooth interpolation, no snapping, stage-bound clamping,
// deadzone against jitter, slow zoom rate so it never pumps. Shake is
// tiny/controlled (see shakeCamera) and decays fast.
//
// Two regimes:
//   - BOTH players in play: the framing zoom is pure geometry from their actual
//     separation on BOTH axes, clamped to [TWO_PLAYER_MIN_ZOOM,
//     TWO_PLAYER_MAX_ZOOM] - wider as they part, tighter as they close. The
//     clamp is what keeps the view from collapsing onto them mid-match.
//   - ONE player in play (the other eliminated/respawning, or fallen past the
//     OFFSTAGE_CAMERA_THRESHOLD below the main platform): stop trying to fit
//     two and settle onto the survivor at SOLE_SURVIVOR_ZOOM.
//
// The off-stage cut is VERTICAL ONLY, so two players merely drifting apart
// horizontally never flips the camera into winner focus; and it is a threshold,
// not a latch - a player who climbs back above it restores two-player framing.

// ── Camera configuration ─────────────────────────────────────────────────
const CAMERA_SMOOTHING = 0.12;   // pan easing (higher = snappier, no popping)
// Zoom easing is ASYMMETRIC on purpose. Widening is urgent - a fighter who is
// about to leave the frame has to be kept in it - so it runs on a fast ramp.
// Tightening is lazy, because chasing a shrink is what makes a camera pump.
const ZOOM_SMOOTHING = 0.05;         // slow: zooming IN
const ZOOM_OUT_SMOOTHING = 0.35;     // fast: zooming OUT to re-accommodate
const ZOOM_IN_RATE = 0.35;           // max zoom-in units per second
const ZOOM_OUT_RATE = 6.0;           // max zoom-out units per second
// Two players in play.
//
// TWO_PLAYER_MAX_ZOOM is a hard ceiling on the zoom-IN: the view never gets
// tighter than this, however close the two fighters are. Everything wider is
// the camera accommodating them - see the fit below, which widens by exactly as
// much as the current positions require and no more.
//
// The visible world width is arenaWidth / zoom, so the ceiling is really "how
// much stage do we show". The stage is 1200 wide with a 780-wide main ground:
//   1.15 (old) -> ~1043px visible, wider than the whole stage. Lots of dead air.
//   2.00      -> ~600px visible. Two fighters plus a real margin, filling the
//                 frame, and the resting view for ordinary spacing.
//   min 0.78 -> widest the view may go; keeps fighters readable, never tiny.
// Players at opposite edges of the main ground (780px apart) fit at ~1.4, so
// the full tight-to-wide range stays available and always fits both.
const TWO_PLAYER_MIN_ZOOM = 0.78;
const TWO_PLAYER_MAX_ZOOM = 2.0;
// Margin kept between the players' bounding box and the edge of the frame.
// Two-player framing only - the winner/single-player branch reads
// SOLE_SURVIVOR_ZOOM and ignores this, so padding changes cannot alter winner or
// off-stage behaviour.
const ZOOM_PADDING = 40;
// How far BELOW the main platform a fighter must fall before the camera stops
// framing them. Matches the vertical follow tolerance the clamps already use
// (g.y + 260), so the cut and the pan limits agree.
const OFFSTAGE_CAMERA_THRESHOLD = 260;
// A single fighter is the only thing left in frame: a clear push-in so they are
// unambiguously the subject. This is the live-match value (a fighter past the
// off-stage cut also leaves one subject) and is deliberately modest.
const SOLE_SURVIVOR_ZOOM = 1.3;
// Winner announced: a HARD close-up so the winner fills the frame. This is the
// framing target, and it compounds with WINNER_MATCH_ZOOM below — at match end
// both are live at once, so the total push-in is the product.
const WINNER_CAMERA_ZOOM = 2.2;

// The second, softer layer: eases in over about a second once the match is over.
// Kept as its own constant (rather than folded into WINNER_CAMERA_ZOOM) so the
// two effects stay independently tunable, and because updateMatchZoom is what
// animates the arrival — the framing number above is reached via the camera's
// own asymmetric zoom easing.
const WINNER_MATCH_ZOOM = 1.6;
const FOLLOW_ZOOM = 1.15;  // closer default view; zoom math still fits both
const CAM_DEADZONE = 5; // px — ignore smaller target moves (no jitter)
const MAX_PAN_PER_FRAME = 14; // px at 60fps — avoids snapping on launches

let cameraX = 0;
let cameraY = 0;
let targetX = 0;
let targetY = 0;
let baseZoom = 1;         // User-facing zoom setting
let matchZoom = 1;        // Winner KO zoom-in (eases toward WINNER_MATCH_ZOOM)
let trackZoom = 1;        // Wide/tight dynamic framing zoom
let targetTrackZoom = 1;
let followActive = true;  // Is tracking live fighters
let shakeOffsetX = 0;
let shakeOffsetY = 0;

let cutsceneTarget = null;

// ── Camera shake ─────────────────────────────────────────────────────────
// Screen shake. Deliberately tiny and always self-decaying: strong hits, hard
// landings and knockouts only, never constant. `decay` lets a knockout hold its
// (still small) shake a fraction longer than a hit; the magnitude is clamped
// hard so the fighters can never become hard to track.
const SHAKE_DECAY = 0.18;
const SHAKE_MAX = 6;
let _shakeMag = 0;
let _shakeTime = 0;
let _shakeDecay = SHAKE_DECAY;

export function shakeCamera(mag = 2, decay = SHAKE_DECAY) {
  const m = Math.max(0, Math.min(SHAKE_MAX, Number(mag) || 0));
  if (m <= 0) return;
  _shakeMag = Math.max(_shakeMag, m);
  _shakeDecay = Math.max(0.08, Math.min(0.4, Number(decay) || SHAKE_DECAY));
  _shakeTime = _shakeDecay;
}

// ── Camera zoom ramp ─────────────────────────────────────────────────────
// A one-shot scripted zoom (zoomCamera) layered under the dynamic framing
// zoom. It is a separate layer because it answers a different question: not
// "where are the fighters" but "the match just started / ended, push in".
let zoomCurrent = 1;
let zoomTarget = 1;
let zoomElapsed = 0;
let zoomDuration = 0;

export function zoomCamera(targetScale = 1.5, duration = 0.3, fromCurrent = false) {
  if (!fromCurrent) zoomCurrent = 1;
  zoomTarget = targetScale;
  zoomElapsed = 0;
  zoomDuration = duration;
}

export function resetCameraZoom() {
  zoomTarget = 1;
  zoomDuration = 0;
}

export function updateCameraZoom(dt) {
  if (zoomDuration > 0) {
    zoomElapsed += dt;
    const t = Math.min(zoomElapsed / zoomDuration, 1);
    zoomCurrent = 1 + (zoomTarget - 1) * t;
    if (t >= 1) zoomDuration = 0;
  } else {
    zoomCurrent += (1 - zoomCurrent) * 0.08;
  }
}

export function getCameraZoom() {
  return zoomCurrent;
}

export function setCutsceneCamera(target) {
  cutsceneTarget = target; // { x, y, zoom } or null
}

export function resetCamera() {
  cameraX = 0;
  cameraY = 0;
  targetX = 0;
  targetY = 0;
  baseZoom = 1;
  matchZoom = 1;
  trackZoom = 1;
  targetTrackZoom = 1;
  followActive = true;
  shakeOffsetX = 0;
  shakeOffsetY = 0;
  _shakeMag = 0;
  _shakeTime = 0;
  _shakeDecay = SHAKE_DECAY;
  cutsceneTarget = null;
}

export function setBaseZoom(val) {
  baseZoom = typeof val === 'number' && val > 0 ? val : 1;
}

export function setMatchZoom(val) {
  matchZoom = val;
}

export function setFollowActive(active) {
  followActive = !!active;
}

// The match-end push-in layer. Eases toward WINNER_MATCH_ZOOM while the match
// is over and back to 1 once it is not (a rematch / a return to the menu), so
// the close-up arrives on its own instead of snapping. It multiplies the
// framing zoom, which computeFraming has already aimed at the lone survivor.
export function updateMatchZoom(dt, isMatchOver) {
  if (isMatchOver) {
    matchZoom += (WINNER_MATCH_ZOOM - matchZoom) * 0.04 * (dt * 60);
  } else {
    matchZoom += (1.0 - matchZoom) * 0.08 * (dt * 60);
  }
}

// ── Shared framing computation (single source of truth) ────────────────
// Pure geometry: midpoint + stage-clamped pan target + dynamic zoom want for
// the CURRENT fighter positions. updateCamera eases toward it every frame;
// snapCameraToFit assigns it directly (match start — no animation).
//
// The result is a single reused record, not a fresh object per frame. Both
// callers (snapCameraToFit, updateCamera) read every field out of it before
// returning, and neither holds onto it past that, so sharing one record is
// equivalent to allocating a new one and costs no garbage on the camera path.
const _framing = { x: 0, y: 0, zoom: 1, alive: 0 };

function computeFraming(fighters, canvasWidth, canvasHeight, stage, isMatchOver) {
  const W = canvasWidth || 1200, H = canvasHeight || 1100;

  // Main platform first: the off-stage cut below is measured from it, and the
  // pan clamps reuse the same lookup. Index loop instead of
  // platforms.find(p => p.isGround): a 2-element stage doesn't need a predicate
  // closure allocated and called on every frame.
  let g = null;
  try {
    const plats = stage && stage.platforms;
    if (plats) {
      for (let i = 0; i < plats.length; i++) {
        if (plats[i].isGround) { g = plats[i]; break; }
      }
      if (!g) g = plats[0];
    }
  } catch (_) {}

  // A fighter is treated as off-stage (out of the framing) once they are this
  // far BELOW the main platform. Vertical only - horizontal distance never
  // triggers it. Null when the stage exposes no platform, in which case only
  // the dead/respawn state test below applies.
  const offstageCut = g ? g.y + OFFSTAGE_CAMERA_THRESHOLD : null;

  let alive = 0;
  let minX = Infinity, maxX = -Infinity;
  let minY = Infinity, maxY = -Infinity;
  // Highest off-stage fighter, kept as a last-resort subject (see below).
  let hiY = Infinity, hiF = null;

  for (let i = 0; i < fighters.length; i++) {
    const f = fighters[i];
    if (!f || f.state === 'dead' || f.state === 'respawn') continue;
    if (offstageCut !== null && f.y > offstageCut) {
      if (f.y < hiY) { hiY = f.y; hiF = f; }
      continue;
    }
    alive++;
    if (f.x < minX) minX = f.x;
    if (f.x > maxX) maxX = f.x;
    if (f.y < minY) minY = f.y;
    if (f.y > maxY) maxY = f.y;
  }

  // Everyone fell past the cut (e.g. a simultaneous double KO). Returning null
  // would hand updateCamera an early return and freeze the view mid-air, so
  // frame the highest one instead - the camera always keeps a subject.
  if (alive === 0) {
    if (!hiF) return null;
    alive = 1;
    minX = maxX = hiF.x; minY = maxY = hiF.y;
  }

  let wantX = (minX + maxX) / 2;
  let wantY = (minY + maxY) / 2;
  // Vertical spread biases the view upward to give the action headroom. Safe at
  // any magnitude now: the fit below is derived from the final pan position, so
  // a bias that would push the lower player toward the edge widens the view by
  // itself instead of clipping.
  const vSpread = maxY - minY;
  if (vSpread > 260) wantY -= Math.min(60, (vSpread - 260) * 0.12);

  let clampL = W * 0.15, clampR = W * 0.85, clampT = H * 0.1, clampB = H * 0.95;
  // Sandbox-only override (stage.cameraFraming). The main map never sets it,
  // so the two-fighter framing below is byte-for-byte what it always was. When a
  // stage DOES set it, the arena's own pan box replaces the ground-platform
  // guess — a sandbox arena has an authored shape that does not have to match
  // its widest block — and the fit uses the real roster count instead of
  // "exactly two or treat it as a winner shot".
  const cf = (stage && stage.cameraFraming) || null;
  if (cf && cf.pan) {
    clampL = cf.pan.left; clampR = cf.pan.right; clampT = cf.pan.top; clampB = cf.pan.bottom;
  } else if (g) {
    clampL = g.x - 120; clampR = g.x + g.width + 120;
    clampT = g.y - 520; clampB = g.y + 260;
  } else {
    try {
      if (stage && stage.blastZones) {
        clampL = stage.blastZones.left + 80; clampR = stage.blastZones.right - 80;
        clampT = stage.blastZones.top + 80; clampB = stage.blastZones.bottom - 80;
      }
    } catch (_) {}
  }
  wantX = Math.max(clampL, Math.min(clampR, wantX));
  wantY = Math.max(clampT, Math.min(clampB, wantY));

  // Fit the pair into the window that is actually going to be rendered, which
  // is not always the box centred on their midpoint: the pan gets clamped to
  // the stage bounds and biased upward for tall spreads. Deriving the zoom from
  // the FINAL pan position, instead of from the raw separation alone, is what makes
  // the fit a guarantee - whenever clamping or biasing would push one of them
  // toward an edge, this widens by exactly as much as that requires and no more.
  // With an unclamped, unbiased pan it reduces to the familiar
  // min(W / (spreadX + 2 * padding), H / (spreadY + 2 * padding)).
  const halfX = Math.max(Math.abs(minX - wantX), Math.abs(maxX - wantX)) + ZOOM_PADDING;
  const halfY = Math.max(Math.abs(minY - wantY), Math.abs(maxY - wantY)) + ZOOM_PADDING;
  const fitZoom = Math.min(W / (2 * halfX), H / (2 * halfY));
  // Two players in play: bounded at both ends. TWO_PLAYER_MAX_ZOOM is the hard
  // limit on zooming in; anything the fit needs beyond the ceiling is clamped
  // away, and anything wider than the fit is allowed through so both always
  // fit. One player left: stop accommodating two and push in on the survivor.
  // A stage that opted into cameraFraming (the sandbox) frames whatever roster
  // it was given with the same fit, bounded by that stage's own zoom limits.
  //
  // "One player left" covers two different moments, so it gets two different
  // pushes. During a live match it also happens whenever a fighter drops past
  // the off-stage cut, and that is NOT a victory — it keeps the old, modest
  // SOLE_SURVIVOR_ZOOM so ordinary play is untouched. Only once the match is
  // actually decided does the winner get the real WINNER_CAMERA_ZOOM close-up.
  const wantZoom = cf && cf.fitAnyRoster
    ? Math.max(cf.minZoom || 0.4, Math.min(cf.maxZoom || 1.4, fitZoom))
    : (alive === 2
      ? Math.max(TWO_PLAYER_MIN_ZOOM, Math.min(TWO_PLAYER_MAX_ZOOM, fitZoom))
      : (isMatchOver ? WINNER_CAMERA_ZOOM : SOLE_SURVIVOR_ZOOM));
  _framing.x = wantX; _framing.y = wantY; _framing.zoom = wantZoom; _framing.alive = alive;
  return _framing;
}

// Match-start snap: establish the FINAL gameplay framing synchronously — no
// timers, no lerp, no intro animation. Dynamic tracking continues normally
// afterwards (updateCamera eases from these correct values).
export function snapCameraToFit(fighters, canvasWidth, canvasHeight, stage) {
  let fr = null;
  try {
    fr = computeFraming(fighters, canvasWidth, canvasHeight, stage);
  } catch (_) { fr = null; }
  if (!fr) return false;
  cameraX = fr.x; cameraY = fr.y;
  targetX = fr.x; targetY = fr.y;
  trackZoom = fr.zoom; targetTrackZoom = fr.zoom;
  return true;
}

export function updateCamera(fighters, canvasWidth, canvasHeight, dt, stage, isMatchOver) {
  // Shake decay runs even for cutscenes (tiny, never constant).
  if (_shakeTime > 0) {
    _shakeTime -= dt;
    if (_shakeTime <= 0) { _shakeMag = 0; shakeOffsetX = 0; shakeOffsetY = 0; }
    else {
      const k = _shakeMag * (_shakeTime / _shakeDecay);
      shakeOffsetX = (Math.random() * 2 - 1) * k;
      shakeOffsetY = (Math.random() * 2 - 1) * k;
    }
  } else if (shakeOffsetX !== 0 || shakeOffsetY !== 0) {
    shakeOffsetX = 0; shakeOffsetY = 0;
  }

  if (cutsceneTarget) {
    targetX = cutsceneTarget.x;
    targetY = cutsceneTarget.y;
    targetTrackZoom = cutsceneTarget.zoom || 1;
    const followFactor = 0.5;
    cameraX += (targetX - cameraX) * followFactor * dt * 60;
    cameraY += (targetY - cameraY) * followFactor * dt * 60;
    trackZoom += (targetTrackZoom - trackZoom) * 0.06 * dt * 60;
    return;
  }

  // Framing geometry from the single shared helper (identical numbers the
  // snap uses at match start); only the EASING below is per-frame dynamic.
  let fr = null;
  try {
    fr = computeFraming(fighters, canvasWidth, canvasHeight, stage, isMatchOver);
  } catch (_) { fr = null; }
  if (!fr) return;

  // Deadzone: ignore tiny moves (avoids constant micro-jitter).
  let wantX = fr.x, wantY = fr.y;
  if (Math.abs(wantX - targetX) < CAM_DEADZONE) wantX = targetX;
  if (Math.abs(wantY - targetY) < CAM_DEADZONE) wantY = targetY;
  targetX = wantX; targetY = wantY;

  // Zoom eases toward the framing want in BOTH regimes: widening to
  // re-accommodate the pair, and onto WINNER_CAMERA_ZOOM once only the survivor
  // is left. The survivor case used to snap straight to 1, which both threw
  // away the framing want and read as a hard jump the instant the loser was
  // eliminated.
  //
  // The two directions get different rates. Widening is on a fast ramp because
  // it is what keeps a fighter who is being launched across the stage inside
  // the frame - at the old shared 0.35/sec the camera needed well over a second
  // to open up, so a hard side-special carried the player clean off screen
  // before the view had moved. Tightening keeps the old lazy rate, since
  // eagerly chasing a shrink is what makes a camera pump.
  const widening = fr.zoom < targetTrackZoom;
  const maxStep = (widening ? ZOOM_OUT_RATE : ZOOM_IN_RATE) * dt + 0.002;
  const dZoom = fr.zoom - targetTrackZoom;
  targetTrackZoom += Math.max(-maxStep, Math.min(maxStep, dZoom));

  // Smooth follow pan, capped per-frame (no snapping on launches) and eased at
  // CAMERA_SMOOTHING, so the handover from two-player to winner framing glides
  // onto the survivor instead of cutting.
  const f = Math.min(1, CAMERA_SMOOTHING * dt * 60);
  let nx = cameraX + (targetX - cameraX) * f;
  let ny = cameraY + (targetY - cameraY) * f;
  // sqrt, not Math.hypot: hypot's overflow-safe path costs several extra
  // comparisons per call, and this magnitude is only ever used as a ratio
  // against `cap`, so the cheap form is numerically identical here.
  const ddx = nx - cameraX, ddy = ny - cameraY;
  const step = Math.sqrt(ddx * ddx + ddy * ddy);
  const cap = MAX_PAN_PER_FRAME * dt * 60;
  if (step > cap && step > 0) {
    const k = cap / step;
    nx = cameraX + (nx - cameraX) * k;
    ny = cameraY + (ny - cameraY) * k;
  }
  // First frames: snap only when camera is uninitialized at origin.
  if (cameraX === 0 && cameraY === 0 && targetX !== 0) { cameraX = targetX; cameraY = targetY; }
  else { cameraX = nx; cameraY = ny; }

  // Zoom interpolation, still a ramp rather than a cut (no snapping) but fast
  // on the way out so the widened view actually lands while it is needed.
  const zSmooth = (targetTrackZoom < trackZoom) ? ZOOM_OUT_SMOOTHING : ZOOM_SMOOTHING;
  trackZoom += (targetTrackZoom - trackZoom) * Math.min(1, zSmooth * dt * 60);
}

export function getComposedZoom() {
  const engineZoom = getCameraZoom();
  const followMultiplier = followActive ? FOLLOW_ZOOM : 1;
  return engineZoom * baseZoom * matchZoom * trackZoom * followMultiplier;
}

export function applyCameraTransform(ctx, canvasWidth, canvasHeight) {
  const camZoom = getComposedZoom();

  // Center on screen with camera pan and shake offset
  const offsetX = canvasWidth / 2 - cameraX * camZoom + shakeOffsetX;
  const offsetY = canvasHeight / 2 - cameraY * camZoom + shakeOffsetY;

  ctx.translate(offsetX, offsetY);
  ctx.scale(camZoom, camZoom);
}

export function setShakeOffset(x, y) {
  shakeOffsetX = x;
  shakeOffsetY = y;
}

export function getCameraState() {
  return {
    x: cameraX,
    y: cameraY,
    zoom: getComposedZoom(),
    targetX,
    targetY,
    targetZoom: targetTrackZoom,
    baseZoom,
    matchZoom,
    trackZoom,
  };
}
