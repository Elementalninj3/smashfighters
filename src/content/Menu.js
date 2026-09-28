// Menu.js — fighter roster for the movement sandbox. The canvas title/char-select
// screens are gone (the terminal overlay in index.html handles selection); this
// module only supplies the roster data and the saved skin-scale lookups.

import { getSkinImage } from '../render/Accessories.js';

// All available fighters.
// Balance: runSpeed ×0.60 then §22 ×1.15 (103→118, 120→138), then §46 ×0.60
// (118→71, 138→83) alongside Fighter.js. Jump forces untouched — vertical
// mobility + recovery stay responsive.
export const ALL_FIGHTERS = [
  {
    id: 'cowboy',
    name: 'Cowboy',
    color: '#c8a24a',
    skin: '/GA/skins/cowboy.png',
    skinScale: 0.85,
    weight: 1.0,
    radius: 31.2,
    runSpeed: 71,
    jumpForce: 712,
  },
  {
    id: 'ninja',
    name: 'Ninja',
    color: '#2c3e50',
    skin: '/GA/skins/ninga.png',
    skinScale: 0.85,
    weight: 0.85,  // Lighter than cowboy
    radius: 31.2,
    runSpeed: 83,  // Faster (still the faster fighter)
    jumpForce: 750, // Higher jump
  },
  // Boxer — the third fighter, appended last so the existing roster indices (and
  // everything that walks the list in order) are unchanged.
  //
  // Deliberately the SLOWEST fighter on both axes: runSpeed below even the
  // cowboy's, and the lowest jump force of the three. What it trades mobility
  // for is committed damage — see BOXER_ATTACKS in combat.js, where the smashes
  // out-hit both existing characters in exchange for long recovery.
  //
  // No `attacks` entry: it uses the BOXER_ATTACKS table, picked by id in
  // attacksFor, the same way the ninja is.
  //
  // `handGear` is this character's BUILT-IN hand gear, applied by
  // loadHandGearFor only when the player has nothing stored for the fighter yet
  // — so the boxer comes out already gloved, and the hand-gear customiser can
  // still take the gloves off or put different gear on either hand.
  {
    id: 'boxer',
    name: 'Boxer',
    color: '#c62828',
    skin: '/GA/skins/boxer.png',
    skinScale: 0.85,
    weight: 1.15,     // Heaviest of the three — gets pushed around least
    radius: 31.2,
    runSpeed: 63,     // Slowest
    jumpForce: 690,   // Lowest jump
    handGear: 'boxinggloves',
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