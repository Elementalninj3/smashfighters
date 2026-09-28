// SandboxSession.js â€” playing inside the Sandbox.
//
// This is the point of the feature: a sandbox you can actually fight in. The
// session builds a fresh stage from the editor's document, spawns the authored
// characters into real fighters, and then hands the roster to the SAME per-frame
// step a competitive match runs (session.js) against the SAME movement, physics,
// platform collision, camera, AI, hitbox and projectile systems. There is no
// sandbox combat engine, no sandbox physics and no sandbox camera: gravity, jump
// arcs, drop-through, blocking, dodging, knockback, hitstun, damage numbers,
// Deadeye, the cowboy's horse, the shuriken and the breakable boards all run
// through the code the match uses.
//
// What the sandbox changes, deliberately and only here:
//   â€¢ the stage object (its own platforms, spawn points, blast zones, camera
//     framing) â€” the main map's stage is never touched
//   â€¢ stocks: falling out of the blast zone soft-respawns instead of costing a
//     stock, and there is no match end, no winner and no victory dance
//   â€¢ roster size: up to MAX_SANDBOX_FIGHTERS, each with its own AIController
//     or passive input feeding the real input paths

import { createFighter } from '../../fighter/Fighter.js';
import { loadHandGearFor } from '../../render/HandGear.js';
import { attachAnimator } from '../../anim/animator.js';
import {
  updatePlatforms,
  isInBlastZone,
  drawStage,
  createSandboxStage,
  applySandboxObjects,
  sandboxBackground,
  MAX_SANDBOX_FIGHTERS,
} from '../Stage.js';
import { stepDestructibles, clearDestructibles, drawDestructibles, destructibleCount } from './destructible.js';
import {
  stepRosterMovement,
  stepRosterCombat,
  stepRosterFinish,
  softResetFighter,
  inputForSlot,
  DUMMY_INPUT,
  resolveFighterSkin,
} from '../../fighter/session.js';
import { updateCamera, updateCameraZoom, applyCameraTransform, resetCamera, snapCameraToFit, setFollowActive } from '../../core/camera.js';
import { resetCombat, setCombatStage, clearDeadeye, removeAttackerHitboxes, clearHitLocks, drawCombatDebug } from '../../fighter/combat.js';
import { AIController, AI_DIFFICULTIES } from '../../ai/ai.js';
import { ALL_FIGHTERS } from '../../content/Menu.js';
import { drawFighter, drawAbilityFx, drawHorse } from '../../render/Effects.js';
import { drawFighterVfx } from '../../effects/vfx.js';
import {
  updateDamageIndicators,
  drawDamageIndicators,
  resetDamageIndicators,
  stepTimeDilation,
  resetTimeDilation,
  drawTimeDilationPost,
  timeDilationState,
  updateWorldFx,
  drawWorldFx,
  resetWorldFx,
} from '../../render/worldFx.js';

const FALLBACK_ENV = {
  background: 'void',
  backgroundColor: '#101010',
  gridColor: '#1e1e1e',
  showGrid: true,
  gridSize: 40,
  platformColor: '#4a7a4a',
};

// â”€â”€ State â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
let active = false;
let env = null;
let doc = { objects: [] };
let stage = null;
let fighters = [];
let controllers = [];
let arenaW = 1200;
let arenaH = 1100;
let paused = false;
let timeScale = 1;
let debug = false;
let sessionsStarted = 0;

// Input.js ships exactly two keyboard bindings, so at most two spawns can be
// human; every slot past those is driven by its own AIController or a passive
// input. Player numbers stay unique per session so the input overrides and the
// controllers never collide on a slot key.
const HUMAN_SLOTS = 2;
const DEFAULT_DIFFICULTY = 'Normal';

export function isSandboxPlaying() {
  return active;
}

export function getSandboxStage() {
  return stage;
}

export function getSandboxSessionCount() {
  return sessionsStarted;
}

// Read-only roster view for the probe: the real fighter objects' live values,
// tagged with the document entry each one came from.
export function getSandboxRoster() {
  const spawns = doc.objects.filter((o) => o.type === 'entity');
  return fighters.map((f, i) => ({
    playerNum: f.playerNum,
    id: f.id,
    charId: spawns[i] ? spawns[i].charId : null,
    control: controllerKindFor(f),
    x: Math.round(f.x),
    y: Math.round(f.y),
    percent: Number(f.percent.toFixed(2)),
    grounded: !!f.grounded,
    attack: f.attack ? f.attack.def.name : null,
  }));
}

function controllerKindFor(fighter) {
  for (let i = 0; i < controllers.length; i++) {
    if (controllers[i] && controllers[i].fighter === fighter) {
      return controllers[i].isDummy ? 'dummy' : 'bot';
    }
  }
  return fighter.playerNum <= HUMAN_SLOTS ? 'human' : 'bot';
}

// The createFighter option set a character def implies, mirroring what Game.js
// passes when it builds a match's fighters. A spawn used to pass none of this,
// so every sandbox fighter silently ran on createFighter's neutral defaults
// (radius 22, generic run/jump) regardless of who it was â€” the differences
// between characters were only visible in a real match.
function statsForDef(def) {
  const runSpeed = def.runSpeed || 91;
  const jumpForce = def.jumpForce || 680;
  return {
    radius: def.radius || 26,
    skinScale: def.skinScale || 0.85,
    runSpeed,
    airSpeed: runSpeed * 0.85,
    jumpForce,
    doubleJumpForce: jumpForce * 1.2,
    handGear: loadHandGearFor(def.id, def.handGear),
  };
}

// â”€â”€ Start / stop â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
export function startSandboxSession(document_, width, height) {
  stopSandboxSession();
  // Snapshot, do not alias: the editor keeps owning its document and the
  // environment settings, so a session can never write a broken board's state
  // (or a half-applied setting) back into what the editor will show on return.
  doc = document_ && Array.isArray(document_.objects)
    ? { objects: document_.objects.map((o) => ({ ...o })) }
    : { objects: [] };
  env = (document_ && document_.env) ? { ...document_.env } : FALLBACK_ENV;
  arenaW = width || 1200;
  arenaH = height || 1100;

  // A brand-new stage, rebuilt from the document on every run. That is what
  // makes PLAY â†’ EDIT â†’ PLAY idempotent: a board broken in the last session is
  // back at full durability, and nothing survives in the platform list.
  stage = createSandboxStage(env, arenaW, arenaH);
  applySandboxObjects(stage, doc.objects, arenaW, arenaH, env);

  fighters = [];
  controllers = [];
  const spawns = doc.objects.filter((o) => o.type === 'entity');
  let humanSlots = 0;
  let botSlots = 0;

  for (let i = 0; i < spawns.length && fighters.length < MAX_SANDBOX_FIGHTERS; i++) {
    const o = spawns[i];
    const def = ALL_FIGHTERS.find((f) => f.id === o.charId) || ALL_FIGHTERS[0];
    let playerNum;
    if (o.control === 'human' && humanSlots < HUMAN_SLOTS) {
      playerNum = humanSlots + 1;
      humanSlots++;
    } else {
      botSlots++;
      playerNum = HUMAN_SLOTS + botSlots;
    }
    const f = createFighter(playerNum, o.x, o.y, resolveFighterSkin(def), {
      id: `s${playerNum}`,
      color: playerNum === 1 ? '#4a9eff' : playerNum === 2 ? '#ff4a4a' : '#e8c25a',
      // The sandbox has no stock rules: a fall is a respawn, not a loss.
      stocks: Infinity,
      ...statsForDef(def),
    });
    // Same animator the match attaches, so stepRosterFinish's combat/state â†’
    // animation mapping and drawFighter's hand/weapon output are identical here.
    attachAnimator(f);
    // The character def, hung on exactly as the match does it. Without this the
    // spawned fighter is un-identified: attacksFor() would hand a sandbox ninja
    // the cowboy's table, resolveHandColor() would miss the ninja's gloves, and
    // a character with built-in hand gear would come out bare.
    f._fighterDef = def;
    // Respawn exactly where the spawn marker was placed, not at "spawn point N"
    // â€” a free-for-all roster's player numbers do not line up with doc order
    // once humans and bots are interleaved.
    f._respawnPoint = { x: o.x, y: o.y };
    fighters.push(f);
    // A passive spawn gets a controller-shaped stub so the control array stays
    // index-aligned with the roster; a bot gets the real AIController.
    if (o.control === 'dummy') controllers.push(makeDummyController(f));
    else if (o.control === 'bot') controllers.push(makeBotController(f, nearestOpponent(fighters, f), def));
  }

  // Bots created before their target existed need a live opponent; fill those in
  // now that the whole roster exists.
  for (let i = 0; i < controllers.length; i++) {
    const c = controllers[i];
    if (c.isDummy || !c.fighter) continue;
    c.setOpponent(nearestOpponent(fighters, c.fighter));
  }

  // A sandbox with nothing spawned still needs a subject for the camera, so it
  // gets the same default pair the first-run document ships with.
  if (!fighters.length) {
    const def = ALL_FIGHTERS[0];
    const y = arenaH * 0.6;
    const a = createFighter(1, arenaW / 2 - 90, y, resolveFighterSkin(def), { id: 's1', stocks: Infinity, ...statsForDef(def) });
    const b = createFighter(2, arenaW / 2 + 90, y, resolveFighterSkin(def), { id: 's2', stocks: Infinity, ...statsForDef(def) });
    a._fighterDef = def;
    b._fighterDef = def;
    attachAnimator(a);
    attachAnimator(b);
    fighters.push(a);
    fighters.push(b);
  }

  resetCombat();
  setCombatStage(stage);
  resetCamera();
  setFollowActive(true);
  resetDamageIndicators();
  resetTimeDilation();
  resetWorldFx();
  paused = false;
  timeScale = 1;
  snapCameraToFit(fighters, arenaW, arenaH, stage);
  active = true;
  sessionsStarted++;
  return true;
}

export function stopSandboxSession() {
  for (let i = 0; i < controllers.length; i++) {
    const c = controllers[i];
    if (c && typeof c.dispose === 'function') {
      try { c.dispose(); } catch (_) {}
    }
  }
  controllers.length = 0;
  for (let i = 0; i < fighters.length; i++) {
    const f = fighters[i];
    if (!f) continue;
    // Leave no live hitbox, lock or Deadeye volley behind â€” the shared combat
    // registry outlives the session, so anything left in it would hit whatever
    // runs next.
    removeAttackerHitboxes(f);
    clearHitLocks(f);
    clearDeadeye(f);
  }
  fighters.length = 0;
  clearDestructibles();
  resetCombat();
  resetTimeDilation();
  resetWorldFx();
  paused = false;
  active = false;
}

function makeBotController(fighter, opponent, def) {
  const c = new AIController(fighter, opponent, null, {
    difficulty: AI_DIFFICULTIES.indexOf(DEFAULT_DIFFICULTY) !== -1 ? DEFAULT_DIFFICULTY : 'Normal',
    charId: def ? def.id : undefined,
  });
  c.isDummy = false;
  // Free-for-all target refresh: each frame the controller is re-pointed at the
  // nearest other fighter (see updateSandboxSession), so N bots never all stare
  // at player 1. AIState caches its own opponent reference, so BOTH are swapped
  // here â€” a state.reset() would also be correct but would wipe the bot's plan
  // and adaptation memory on every retarget.
  c.setOpponent = (target) => {
    if (!target || target === c.opponent) return;
    c.opponent = target;
    if (c.state) c.state.opponent = target;
  };
  return c;
}

// A passive slot: all-false input, no-op controller. Same signature an
// AIController exposes, so the roster's control array stays uniform.
function makeDummyController(fighter) {
  return {
    fighter,
    opponent: null,
    isDummy: true,
    update() {},
    getInput() { return DUMMY_INPUT; },
    postFrame() {},
    setOpponent() {},
    dispose() {},
  };
}

function nearestOpponent(all, self) {
  let best = null;
  let bestD = Infinity;
  for (let i = 0; i < all.length; i++) {
    const o = all[i];
    if (!o || o === self || o.state === 'dead' || o.eliminated) continue;
    const d = Math.abs(o.x - self.x) + Math.abs(o.y - self.y);
    if (d < bestD) { bestD = d; best = o; }
  }
  return best;
}

// â”€â”€ Input resolution â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// A slot's controller (or its absence) decides which input triple the real
// movement + combat paths read. Human slots fall through to Input.js, which is
// how the sandbox gets the game's real controls without any of its own.
function inputFor(fighter) {
  for (let i = 0; i < controllers.length; i++) {
    const c = controllers[i];
    if (c && c.fighter === fighter) return inputForSlot(c) || DUMMY_INPUT;
  }
  return null;
}

function buildOverrides() {
  let n = 0;
  const overrides = {};
  for (let i = 0; i < fighters.length; i++) {
    const input = inputFor(fighters[i]);
    if (input) { overrides[fighters[i].playerNum] = input; n++; }
  }
  return n ? overrides : null;
}

// â”€â”€ Update â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
export function updateSandboxSession(dt, now) {
  if (!active || !stage) return;
  // Paused freezes the world completely, including the global slow-mo clock â€”
  // otherwise unpausing would fast-forward the pending dilation.
  if (paused) return;

  // Global time dilation rides the same clock as the match's (cowboy Down
  // Light) so slow-mo behaves identically here.
  const effDt = stepTimeDilation(dt) * timeScale;
  if (effDt <= 0) return;

  updatePlatforms(stage, now);

  // Controllers read the REAL stage for off-stage / recovery geometry, the same
  // way the match feeds them.
  for (let i = 0; i < controllers.length; i++) {
    const c = controllers[i];
    if (!c || c.isDummy) continue;
    if (typeof c.setOpponent === 'function') c.setOpponent(nearestOpponent(fighters, c.fighter));
    try { c.update(effDt, now, stage); } catch (e) { console.error('[sandbox] AI update failed:', e); }
  }

  stepRosterMovement(fighters, stage, effDt, inputFor);
  stepRosterCombat(fighters, buildOverrides(), effDt);
  stepRosterFinish(fighters, effDt, null);

  // Blast zone: soft respawn at the spawn point. No stock, no elimination, no
  // match end â€” the sandbox is a practice arena.
  for (let i = 0; i < fighters.length; i++) {
    const f = fighters[i];
    if (f && isInBlastZone(f, stage)) softResetFighter(f, stage);
  }

  // Breakables: flash decay, break shards, and the sweep that pulls a broken
  // board out of the platform list. After the roster step, so a board broken
  // this frame is gone before the next frame's collision pass reads it.
  stepDestructibles(effDt);

  updateDamageIndicators(effDt);
  updateWorldFx(effDt);
  updateCameraZoom(effDt);
  updateCamera(fighters, arenaW, arenaH, effDt, stage);

  for (let i = 0; i < controllers.length; i++) {
    const c = controllers[i];
    if (c && typeof c.postFrame === 'function') { try { c.postFrame(); } catch (_) {} }
  }
}

// â”€â”€ Sandbox controls â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
export function toggleSandboxPause() {
  paused = !paused;
  return paused;
}

export function isSandboxPaused() {
  return paused;
}

export function setSandboxTimeScale(scale) {
  timeScale = Math.max(0.1, Math.min(1, scale || 1));
}

export function getSandboxTimeScale() {
  return timeScale;
}

export function toggleSandboxDebug() {
  debug = !debug;
  return debug;
}

// â”€â”€ Render â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// The same layer order as the match render: background, stage, breakables, then
// per-fighter (horse, body, VFX, ability FX) with the attacker-on-top rule
// applied across the whole roster. A bot that just landed a hit draws in front
// of everyone for the same interaction window a match uses.
export function renderSandboxSession(ctx, time) {
  if (!active || !ctx) return;
  const W = arenaW;
  const H = arenaH;

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = env.backgroundColor || FALLBACK_ENV.backgroundColor;
  ctx.fillRect(0, 0, W, H);

  // The arena backdrop is the pre-rendered offscreen fill + grid (see
  // sandboxBackground() in Stage.js) â€” a static image, so it is blitted rather
  // than repainted.
  const bg = sandboxBackground(env, W, H);
  if (bg) ctx.drawImage(bg, 0, 0);

  applyCameraTransform(ctx);
  ctx.save();
  // drawStage paints platform art; destructibles own theirs (destructible.js),
  // which is why drawStage skips the records flagged `destructible`.
  drawStage(ctx, stage, time, env.platformColor);
  drawDestructibles(ctx);
  if (debug) drawCombatDebug(ctx, fighters);

  let anyFront = false;
  for (let i = 0; i < fighters.length; i++) {
    if (fighters[i] && (fighters[i]._hitRenderTimer || 0) > 0) { anyFront = true; break; }
  }
  for (let pass = 0; pass < 2; pass++) {
    // Second pass is the attacker-on-top pass and only runs when some fighter is
    // inside the hit window. With no attacker it would draw the whole roster a
    // second time on top of itself, so it is skipped outright.
    if (pass === 1 && !anyFront) break;
    for (let i = 0; i < fighters.length; i++) {
      const f = fighters[i];
      if (!f) continue;
      // With no attacker in the window everyone draws in roster order.
      const front = (f._hitRenderTimer || 0) > 0;
      if (anyFront && front !== (pass === 1)) continue;
      try { drawHorse(ctx, f, time); } catch (_) {}
      try { drawFighter(ctx, f, time); } catch (_) {}
      try { drawFighterVfx(ctx, f); } catch (_) {}
      try { drawAbilityFx(ctx, f, time); } catch (_) {}
    }
  }
  ctx.restore();

  drawDamageIndicators(ctx, time);
  drawWorldFx(ctx);
  if (timeDilationState().active) drawTimeDilationPost(ctx, W, H);
  drawSandboxHud(ctx);
}

// A compact sandbox HUD: one percent meter per fighter, in world space beside
// its owner, plus a screen-space footer with the breakable count. The match's
// health bars live in Game.js and are laid out for its two fighters, so this is
// a few lines rather than a second health-bar widget.
function drawSandboxHud(ctx) {
  for (let i = 0; i < fighters.length; i++) {
    const f = fighters[i];
    if (!f) continue;
    const w = 92;
    const x = f.x - w / 2;
    const y = f.y - f.radius - 30;
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(x, y, w, 6);
    const frac = Math.max(0, Math.min(1, f.percent / 150));
    ctx.fillStyle = f.percent > 100 ? '#ff5a4a' : f.percent > 50 ? '#e8c25a' : '#7fd4ff';
    ctx.fillRect(x, y, w * frac, 6);
    ctx.font = '11px Consolas, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.fillText(`${f.percent.toFixed(0)}%`, f.x, y - 2);
  }

  // Footer, in screen space (outside the camera transform).
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.font = '12px Consolas, monospace';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = 'rgba(0,0,0,0.6)';
  ctx.fillRect(0, arenaH - 30, arenaW, 30);
  ctx.fillStyle = '#cbbf9f';
  ctx.fillText(
    `SANDBOX   ${fighters.length} fighters   ${destructibleCount()} breakables left   `
    + `ESC back to editor   I pause   V 0.25x   B hitboxes   M main menu`,
    16, arenaH - 15
  );
}
