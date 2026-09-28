// weapons.js — reusable weapon library (§12). Weapons live SEPARATELY from
// animations. Each weapon is a data object:
//   {
//     id, name, type,              // art flavour
//     w, h,                        // sprite base size (px)
//     color, accent,               // art colours
//     mirror,                      // participates in left/right mirroring
//     pivot:   { x, y },           // rotation pivot (= grip by default)
//     anchors: { grip: {x,y}, tip: {x,y}, center: {x,y}, custom: [{id,x,y}] }
//   }
// Anchor coordinates are in WEAPON-SPRITE space: origin = sprite center,
// +x = right, +y = down. They are never mirrored — the art flips instead, so
// the grip/tip stay glued to the correct spots of the weapon.
//
// Baseline library ships in repo (human-readable); user-created weapons are
// layered on top from localStorage. Export produces the same JSON you can drop
// back into the weapons folder.

// v2 — the v1 store carried locally-created weapons from the old editor that
// duplicated the GA folder assets. Shipping the GA sprite weapons clean means
// starting fresh instead of merging stale editor weapons on top of defaults.
export const WEAPON_STORE_KEY = 'smashfighters.weapons.v2';

const ANCHOR = (x, y) => ({ x, y });

const DEFAULT_WEAPONS = [
  {
    id: 'sword', name: 'Sword', type: 'sword', w: 16, h: 92,
    color: '#d8d8d8', accent: '#7b68ee', mirror: true,
    pivot: { x: 0, y: 40 },
    anchors: {
      grip: ANCHOR(0, 40), tip: ANCHOR(0, -40),
      center: ANCHOR(0, 0), custom: [ANCHOR(0, 8)],
    },
  },
  {
    id: 'gun', name: 'Gun', type: 'gun', w: 64, h: 20,
    color: '#2b2b2b', accent: '#44aaff', mirror: true,
    pivot: { x: -14, y: 0 },
    anchors: {
      grip: ANCHOR(-14, 0), tip: ANCHOR(30, 0),
      center: ANCHOR(0, 0), custom: [ANCHOR(0, 0)],
    },
  },
  {
    id: 'hammer', name: 'Hammer', type: 'hammer', w: 96, h: 100,
    color: '#8a6d45', accent: '#c9b17e', mirror: true,
    pivot: { x: 0, y: 34 },
    anchors: {
      grip: ANCHOR(0, 34), tip: ANCHOR(0, -42),
      center: ANCHOR(0, -12), custom: [ANCHOR(0, 34)],
    },
  },
  {
    id: 'shield', name: 'Shield', type: 'shield', w: 56, h: 66,
    color: '#c0392b', accent: '#f1c40f', mirror: true,
    pivot: { x: 0, y: 0 },
    anchors: {
      grip: ANCHOR(0, 4), tip: ANCHOR(0, -28),
      center: ANCHOR(0, 0), custom: [ANCHOR(-18, -14)],
    },
  },
  {
    id: 'staff', name: 'Staff', type: 'staff', w: 14, h: 110,
    color: '#7a4a9e', accent: '#e0b0ff', mirror: true,
    pivot: { x: 0, y: 34 },
    anchors: {
      grip: ANCHOR(0, 34), tip: ANCHOR(0, -50),
      center: ANCHOR(0, -4), custom: [ANCHOR(0, 34)],
    },
  },
  {
    id: 'revolver', name: 'Revolver', type: 'gun', w: 64, h: 20,
    color: '#2b2b2b', accent: '#44aaff', mirror: true,
    sprite: '/GA/weapons/revolver.png',
    pivot: { x: -10, y: 4 },
    anchors: {
      grip: ANCHOR(-10, 4), tip: ANCHOR(11, -5),
      center: ANCHOR(0, 0), custom: [],
    },
  },
  {
    id: 'rifle', name: 'Rifle', type: 'gun', w: 80, h: 24,
    color: '#2b2b2b', accent: '#44aaff', mirror: true,
    sprite: '/GA/weapons/rifle.png',
    pivot: { x: -29, y: 3 },
    anchors: {
      grip: ANCHOR(-29, 3), tip: ANCHOR(30, -4),
      center: ANCHOR(0, 0), custom: [],
    },
  },
  {
    id: 'katana', name: 'Katana', type: 'sword', w: 16, h: 80,
    color: '#34495e', accent: '#7f8c8d', mirror: true,
    pivot: { x: 0, y: 30 },
    anchors: {
      grip: ANCHOR(0, 30), tip: ANCHOR(0, -40),
      center: ANCHOR(0, -5), custom: [ANCHOR(0, 25)],
    },
  },
  // Ninja sword (GA sprite): the blade is authored diagonally (guard near
  // bottom-left, tip top-right), so grip/tip anchors sit at the handle middle
  // and the tip in sprite space. The hand-attachment math is identical to
  // every other weapon (grip glued to the hand) — only the art + anchors are
  // new, no second weapon system.
  {
    id: 'ninjaSword', name: 'Ninja Sword', type: 'sword', w: 132, h: 88,
    color: '#d8d8d8', accent: '#e8b53a', mirror: true,
    sprite: '/GA/weapons/sword.png',
    pivot: { x: -43, y: 24 },
    anchors: {
      grip: ANCHOR(-43, 24), tip: ANCHOR(62, -42),
      center: ANCHOR(10, -9), custom: [],
    },
  },
  {
    id: 'shuriken', name: 'Shuriken', type: 'throwing', w: 32, h: 32,
    color: '#2c3e50', accent: '#3498db', mirror: true,
    sprite: '/GA/weapons/shuriken.png',
    pivot: { x: 0, y: 0 },
    anchors: {
      grip: ANCHOR(0, 0), tip: ANCHOR(0, -12),
      center: ANCHOR(0, 0), custom: [],
    },
  },
];

let weaponLib = new Map();
for (const w of DEFAULT_WEAPONS) weaponLib.set(w.id, w);

// Merge localStorage weapons over the baseline.
try {
  if (typeof localStorage !== 'undefined') {
    const raw = localStorage.getItem(WEAPON_STORE_KEY);
    if (raw) {
      for (const w of JSON.parse(raw)) weaponLib.set(w.id, normalizeWeapon(w));
    }
  }
} catch (err) { /* corrupt store — ignore */ }

function normalizeWeapon(w) {
  return {
    mirror: true,
    ...w,
    anchors: {
      grip: w.anchors?.grip || ANCHOR(0, 0),
      tip: w.anchors?.tip || ANCHOR(0, -10),
      center: w.anchors?.center || ANCHOR(0, 0),
      custom: Array.isArray(w.anchors?.custom) ? w.anchors.custom : [],
    },
    pivot: w.pivot || w.anchors?.grip || ANCHOR(0, 0),
    scale: w.scale == null ? 1 : w.scale,
    rotation: w.rotation || 0,
    offsetX: w.offsetX || 0,
    offsetY: w.offsetY || 0,
    handAnchor: w.handAnchor || 'right',
    vfxAnchor: w.vfxAnchor || w.anchors?.tip || ANCHOR(0, -10),
    sprite: w.sprite || null,
  };
}

// getWeapon is called every animated frame (per side, per fighter) — resolving
// the same def each time. normalizeWeapon spreads + allocates a new object, so
// cache the normalized result per id. Runtime only READS weapon defs in
// resolveWeapon (pivot/anchors/size), never mutates them, so sharing one
// object is safe. Every mutation path below invalidates the cache.
const _weaponDefCache = new Map();

// Sprite image cache — one Image per weapon sprite path, loaded lazily.
// status: 'loading' | 'loaded' | 'error'
const _spriteCache = new Map();

export function getWeaponSprite(spritePath) {
  if (!spritePath) return null;
  let entry = _spriteCache.get(spritePath);
  if (entry) {
    if (entry.status === 'error' && performance.now() - entry.lastAttempt > 5000) {
      entry.status = 'loading';
      entry.lastAttempt = performance.now();
      const img = new Image();
      entry.img = img;
      img.onload = () => { entry.status = 'loaded'; };
      img.onerror = () => { entry.status = 'error'; };
      img.src = spritePath;
    }
    return entry;
  }
  entry = { status: 'loading', lastAttempt: performance.now() };
  _spriteCache.set(spritePath, entry);
  const img = new Image();
  entry.img = img;
  img.onload = () => { entry.status = 'loaded'; };
  img.onerror = () => { entry.status = 'error'; };
  img.src = spritePath;
  return entry;
}

function persist() {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(WEAPON_STORE_KEY, JSON.stringify([...weaponLib.values()]));
  } catch (err) { /* ignore */ }
}

function invalidateWeaponCache() {
  _weaponDefCache.clear();
}

export function getWeapon(id) {
  if (!id) return null;
  const raw = weaponLib.get(id);
  if (!raw) return null;
  let w = _weaponDefCache.get(id);
  if (!w) {
    w = normalizeWeapon(raw);
    _weaponDefCache.set(id, w);
  }
  return w;
}

export function getWeaponRaw(id) {
  return weaponLib.get(id) || null;
}

export function allWeapons() {
  return [...weaponLib.values()].map(normalizeWeapon);
}

export function addWeapon(def) {
  const w = normalizeWeapon(def);
  if (!w.id) return null;
  weaponLib.set(w.id, w);
  persist();
  invalidateWeaponCache();
  return w;
}

export function updateWeapon(id, patch) {
  const cur = weaponLib.get(id);
  if (!cur) return null;
  const w = normalizeWeapon({ ...cur, ...patch });
  weaponLib.set(id, w);
  persist();
  invalidateWeaponCache();
  return w;
}

export function deleteWeapon(id) {
  weaponLib.delete(id);
  persist();
  invalidateWeaponCache();
}

export function resetWeaponLibrary() {
  weaponLib = new Map();
  for (const w of DEFAULT_WEAPONS) weaponLib.set(w.id, w);
  persist();
  invalidateWeaponCache();
}

export function weaponsToJSON() {
  return JSON.stringify([...weaponLib.values()], null, 2);
}

export function importWeaponsJSON(text) {
  const list = JSON.parse(text);
  if (!Array.isArray(list)) throw new Error('Weapon list must be an array.');
  for (const w of list) {
    if (w && w.id) addWeapon(w); // addWeapon invalidates the def cache
  }
}

// A fresh weapon assignment config for an animation (§5: hand anchors +
// grip offsets + mirroring live here, per side).
export function emptyWeaponCfg(id = null) {
  return { id, mountX: 0, mountY: 0, gripOffsetX: 0, gripOffsetY: 0, gripRot: 0, mirror: true };
}

// ── procedural weapon art ────────────────────────────────────────────────
// Draws the weapon in SPRITE space: (0,0) is the sprite center, +x right, +y
// down. size is w×h as given in the def. Anchors/pivot can be overlaid for
// editor editing.
export function drawWeapon(ctx, def, overrides = {}) {
  const w = def.w || 40;
  const h = def.h || 40;
  const c = overrides.color || def.color || '#cccccc';
  const a = overrides.accent || def.accent || '#888888';
  const type = def.type || 'sword';

  // Sprite-based weapon: draw the image centered at (0,0) in sprite space.
  if (def.sprite) {
    const entry = getWeaponSprite(def.sprite);
    if (entry && entry.status === 'loaded' && entry.img) {
      const img = entry.img;
      const scale = Math.min(w / img.width, h / img.height);
      const dw = img.width * scale;
      const dh = img.height * scale;
      ctx.drawImage(img, -dw / 2, -dh / 2, dw, dh);
      return;
    }
    // Sprite still loading or errored — fall through to procedural draw
  }

  ctx.save();
  ctx.lineWidth = 2;
  ctx.strokeStyle = '#111111';

  switch (type) {
    case 'sword': {
      // blade up, crossguard at grip (y=+34 area)
      ctx.fillStyle = c;
      ctx.fillRect(-3.5, -h / 2 + 8, 7, h * 0.58);                 // blade
      ctx.fillStyle = a;
      ctx.fillRect(-13, h * 0.20, 26, 4);                          // guard
      ctx.fillRect(-3.5, h * 0.20, 7, h * 0.30);                   // handle
      ctx.strokeRect(-3.5, -h / 2 + 8, 7, h * 0.58);
      ctx.strokeRect(-13, h * 0.20, 26, 4);
      ctx.strokeRect(-3.5, h * 0.20, 7, h * 0.30);
      break;
    }
    case 'gun': {
      ctx.fillStyle = c;
      ctx.fillRect(-w / 2, -h / 2, w, h);                          // body
      ctx.fillRect(w / 2 - 10, -h / 2 - 6, 6, 12);                // muzzle lip
      ctx.fillStyle = a;
      ctx.fillRect(-w / 2 + 4, -h / 2 + 4, w * 0.4, h * 0.4);     // grip block
      ctx.fillRect(-20, h / 2, 14, 12);                            // pistol grip
      ctx.strokeRect(-w / 2, -h / 2, w, h);
      break;
    }
    case 'hammer': {
      // handle + heavy head
      ctx.fillStyle = a;
      ctx.fillRect(-4, -h / 2 + 6, 8, h * 0.6);                    // handle
      ctx.fillStyle = c;
      ctx.fillRect(-h * 0.30, -h / 2 + 2, h * 0.60, 20);           // head
      ctx.strokeRect(-h * 0.30, -h / 2 + 2, h * 0.60, 20);
      ctx.strokeRect(-4, -h / 2 + 6, 8, h * 0.6);
      break;
    }
    case 'shield': {
      ctx.beginPath();
      ctx.ellipse(0, 2, w / 2, h / 2, 0, 0, Math.PI * 2);
      ctx.fillStyle = c;
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = a;
      ctx.beginPath();
      ctx.arc(0, 2, w * 0.22, 0, Math.PI * 2);
      ctx.fill();
      break;
    }
    case 'staff': {
      ctx.fillStyle = c;
      ctx.fillRect(-4, -h / 2, 8, h);                              // shaft
      ctx.fillStyle = a;
      ctx.beginPath();
      ctx.arc(0, -h / 2 + 6, 9, 0, Math.PI * 2);                  // orb
      ctx.fill();
      ctx.strokeRect(-4, -h / 2, 8, h);
      break;
    }
    case 'throwing': {
      // Shuriken fallback (used only while the GA sprite is loading or on
      // error — the registered sprite above is the real art): a 4-point star
      // so the hand never holds an empty/generic box.
      ctx.fillStyle = c;
      ctx.beginPath();
      for (let i = 0; i < 8; i++) {
        const ang = (i * Math.PI) / 4 - Math.PI / 2;
        const r = i % 2 === 0 ? Math.min(w, h) / 2 : Math.min(w, h) / 5;
        const x = Math.cos(ang) * r, y = Math.sin(ang) * r;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = a;
      ctx.beginPath();
      ctx.arc(0, 0, Math.min(w, h) / 8, 0, Math.PI * 2);
      ctx.fill();
      break;
    }
    default: { // generic box
      ctx.fillStyle = c;
      ctx.fillRect(-w / 2, -h / 2, w, h);
      ctx.strokeRect(-w / 2, -h / 2, w, h);
    }
  }
  ctx.restore();
}

// Draw the anchor/pivot markers of a weapon (editor overlay, sprite space).
export function drawWeaponGuides(ctx, def) {
  if (!def) return;
  ctx.save();
  ctx.lineWidth = 1.5;
  const drawAnchor = (p, color, label) => {
    if (!p) return;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.strokeStyle = '#000';
    ctx.stroke();
    if (label) {
      ctx.font = '9px Consolas, monospace';
      ctx.fillStyle = '#fff';
      ctx.strokeText(label, p.x + 6, p.y - 5);
      ctx.fillStyle = '#000';
      ctx.fillText(label, p.x + 6, p.y - 5);
    }
  };
  if (def.pivot) drawAnchor(def.pivot, '#ffd24a', 'P');
  if (def.anchors.grip) drawAnchor(def.anchors.grip, '#4ade80', 'G');
  if (def.anchors.tip) drawAnchor(def.anchors.tip, '#ff5555', 'T');
  if (def.anchors.center) drawAnchor(def.anchors.center, '#9be8ff', 'C');
  for (const c of def.anchors.custom || []) drawAnchor(c, '#c792ea', 'X');
  ctx.restore();
}