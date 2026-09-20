// Menu.js — fighter roster for the movement sandbox. The canvas title/char-select
// screens are gone (the terminal overlay in index.html handles selection); this
// module only supplies the roster data and the saved skin-scale lookups.

import { getSkinImage } from './vfxCore.js';

// All available fighters. The Cowboy is the only character in the roster; skin
// size and cosmetics are edited live from the terminal menu.
export const ALL_FIGHTERS = [
  {
    id: 'cowboy',
    name: 'Cowboy',
    color: '#c8a24a',
    skin: '/GA/skins/cowboy.png',
    skinScale: 0.85,
    weight: 1.0,
    radius: 31.2,
    runSpeed: 172,
    jumpForce: 712,
  },
];

// Statis stage list for the sandbox (single arena layout).
export const STAGES = [
  { id: 'battlefield', name: 'Battlefield', icon: '🌿' },
];

// Cached skin lookup used by the terminal previews.
let resolveSkinCache = {};
export function resolveSkinCached(path) {
  if (!path) return null;
  const cached = resolveSkinCache[path];
  if (cached && (cached.loaded || cached.failed)) return cached;
  const entry = getSkinImage(path);
  if (!entry) return null;
  const out = { loaded: entry.status === 'loaded', img: entry.img, name: path };
  if (out.loaded) resolveSkinCache[path] = out;
  return out;
}