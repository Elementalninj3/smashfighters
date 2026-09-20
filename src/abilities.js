// abilities.js — non-hitbox ability registry. Abilities are assigned to an
// animation through the editor (anim.combat = { type: 'nonHitbox', abilityId }).
// When an attack whose animation carries one of these plays, combat.js routes
// it here instead of spawning a hitbox: the ability fires once at castFrame and
// the attack lasts `frames` total frames. All procedural — no assets.

import { SFX } from './Engine.js';

export const ABILITIES = {
  teleport: {
    name: 'Teleport',
    frames: 18,
    castFrame: 6,
    run(fighter, atk, cfg) {
      const dist = (cfg && cfg.distance) || 260;
      fighter.vx = 0;
      fighter.vy = 0;
      const dir = atk.facing || (fighter.facingRight ? 1 : -1);
      fighter.x += dir * dist;
      SFX.smokePoof();
    },
  },
  dash: {
    name: 'Dash',
    frames: 20,
    castFrame: 2,
    run(fighter, atk, cfg) {
      const dir = atk.facing || (fighter.facingRight ? 1 : -1);
      fighter.vx = dir * ((cfg && cfg.speed) || 620);
      fighter.dashing = true;
      fighter.dashTimer = (cfg && cfg.duration) || 0.14;
      SFX.smokePoof();
    },
  },
  lockOn: {
    name: 'Lock On',
    frames: 16,
    castFrame: 3,
    run(fighter, atk, cfg, ctx) {
      const others = ctx && ctx.fighters || [];
      let best = null, bd = Infinity;
      for (const t of others) {
        if (!t || t === fighter || t.state === 'dead') continue;
        const d = Math.hypot(t.x - fighter.x, t.y - fighter.y);
        if (d < bd) { bd = d; best = t; }
      }
      fighter._lockedTarget = best;
      fighter._lockTimer = (cfg && cfg.duration) || 1.2;
      SFX.lockIn();
    },
  },
  projectile: {
    name: 'Projectile',
    frames: 14,
    castFrame: 7,
    run(fighter, atk, cfg) {
      const dir = atk.facing || (fighter.facingRight ? 1 : -1);
      const list = fighter._projectiles || (fighter._projectiles = []);
      list.push({
        owner: fighter,
        x: fighter.x + dir * 42,
        y: fighter.y - 6,
        vx: dir * ((cfg && cfg.speed) || 520),
        vy: 0,
        r: 9,
        facing: dir,
        life: (cfg && cfg.life) || 1.4,
        dead: false,
        def: {
          name: 'Projectile',
          dmg: (cfg && cfg.dmg) || 8,
          kbBase: (cfg && cfg.kbBase) || 140,
          kbGrowth: 0.9,
          angle: 0,
          kbDir: dir,
          w: 28, h: 28, ox: 0, oy: 0,
        },
      });
      SFX.bloomShot();
    },
  },
};

export function getAbility(id) {
  return ABILITIES[id] || null;
}

export function listAbilities() {
  return Object.keys(ABILITIES).map(id => ({ id, name: ABILITIES[id].name }));
}