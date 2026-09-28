// ai-neural-network.js — lightweight neural network for AI decision-making.
//
// The network NEVER executes actions directly. It produces action-preference
// scores (one per output) from a normalized game-state snapshot. ai.js reads
// those scores as bias terms on top of its existing scored pipelines
// (scoreAttacks + unified neutral movement scoring). The existing gameplay
// systems (combatInput cooldowns, hitstun locks, platform collision, resource
// limits) remain the sole authority on whether an action is legal.
//
// Architecture: INPUT_SIZE -> HIDDEN_SIZE -> OUTPUT_SIZE, tanh activations.
// Weights are a single flat Float64 array so genomes can crossover/mutate them
// trivially: [W1 (I*H), b1 (H), W2 (H*O), b2 (O)].

export const NN_INPUT_SIZE = 32;
export const NN_HIDDEN_SIZE = 16;
export const NN_OUTPUT_SIZE = 20;

export const NN_INPUT_LABELS = [
  'ownX', 'ownY', 'ownVx', 'ownVy', 'ownPercent', 'grounded', 'facing',
  'hitstun', 'blocking', 'dodging', 'canDoubleJump', 'canAerialLight',
  'dashReady', 'attackReady', 'distCenter', 'distEdge',
  'offStage', 'oppX', 'oppY', 'hDist', 'vDist', 'oppVx', 'oppVy',
  'oppPercent', 'oppGrounded', 'oppAttacking', 'oppBlocking', 'oppHitstun',
  'oppRecovery', 'stageCenter', 'stageWidth', 'distBlast',
];

// Output action preferences. Indices are stable — genomes trained against one
// version load against the same mapping. ai.js maps these onto its real moves.
export const NN_OUTPUT_LABELS = [
  'moveLeft', 'moveRight', 'stop', 'jump', 'block', 'dodge',
  'jab', 'ftilt', 'fsmash', 'utilt', 'usmash', 'dtilt', 'dsmash',
  'nsmash', 'aerialLight', 'aerialHeavy', 'dashAttack',
  'approach', 'retreat', 'recover',
];

export const NN_WEIGHT_COUNT =
  NN_INPUT_SIZE * NN_HIDDEN_SIZE + NN_HIDDEN_SIZE +
  NN_HIDDEN_SIZE * NN_OUTPUT_SIZE + NN_OUTPUT_SIZE;

function clamp1(v) {
  if (!Number.isFinite(v)) return 0;
  return v > 1 ? 1 : v < -1 ? -1 : v;
}

function randn() {
  // Box-Muller gaussian, mean 0 std 1.
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

export class NeuralNetwork {
  constructor(weights) {
    const I = NN_INPUT_SIZE, H = NN_HIDDEN_SIZE, O = NN_OUTPUT_SIZE;
    this.I = I; this.H = H; this.O = O;
    if (weights && weights.length === NN_WEIGHT_COUNT) {
      this.w = Float64Array.from(weights);
    } else {
      this.w = new Float64Array(NN_WEIGHT_COUNT);
      this.randomize();
    }
    // Scratch buffers reused across forwards (no per-frame allocation).
    this._hidden = new Float64Array(H);
    this._out = new Float64Array(O);
  }

  randomize(scale = 0.7) {
    for (let i = 0; i < this.w.length; i++) this.w[i] = randn() * scale;
  }

  getWeights() {
    return Array.from(this.w);
  }

  setWeights(arr) {
    if (!arr || arr.length !== NN_WEIGHT_COUNT) return false;
    for (let i = 0; i < arr.length; i++) {
      const v = arr[i];
      this.w[i] = Number.isFinite(v) ? Math.max(-8, Math.min(8, v)) : 0;
    }
    return true;
  }

  clone() {
    return new NeuralNetwork(this.w);
  }

  forward(inputs) {
    const { I, H, O, w, _hidden, _out } = this;
    const w1End = I * H;
    const b1End = w1End + H;
    const w2End = b1End + H * O;
    for (let h = 0; h < H; h++) {
      let s = w[w1End + h];
      for (let i = 0; i < I; i++) {
        const iv = (inputs && Number.isFinite(inputs[i])) ? inputs[i] : 0;
        s += iv * w[i * H + h];
      }
      _hidden[h] = Math.tanh(s);
    }
    for (let o = 0; o < O; o++) {
      let s = w[w2End + o];
      const base = b1End + o * H;
      for (let h = 0; h < H; h++) s += _hidden[h] * w[base + h];
      _out[o] = Math.tanh(s);
    }
    return _out;
  }

  // Controlled mutation: each weight perturbed with probability `rate` by
  // gaussian noise of std `strength`. Occasional larger kicks preserve
  // diversity (anti premature-convergence).
  mutate(rate = 0.05, strength = 0.25, bigKickChance = 0.02) {
    for (let i = 0; i < this.w.length; i++) {
      const r = Math.random();
      if (r < bigKickChance) {
        this.w[i] = randn() * 0.7;
      } else if (r < bigKickChance + rate) {
        this.w[i] += randn() * strength;
        if (this.w[i] > 8) this.w[i] = 8;
        else if (this.w[i] < -8) this.w[i] = -8;
      }
    }
  }

  // Uniform crossover: each weight picked from either parent. Returns a new
  // NeuralNetwork (child). Never just clones one parent.
  static crossover(a, b) {
    const child = new NeuralNetwork();
    const wa = a.w, wb = b.w, wc = child.w;
    for (let i = 0; i < wc.length; i++) {
      wc[i] = Math.random() < 0.5 ? wa[i] : wb[i];
    }
    return child;
  }
}

// ── Input builder ─────────────────────────────────────────────────────────
// Builds the 32 normalized inputs from live fighter state. Mirrors the
// perception fields ai.js already computes — no new physics, no caching.
// Reused input scratch: buildNNInputs runs once per AI decision and its result
// is consumed synchronously by forward(), so sharing one array is safe and
// saves a 32-element alloc + fill per decision.
const _nnInScratch = new Array(NN_INPUT_SIZE).fill(0);
export function buildNNInputs(f, opp, stage) {
  const out = _nnInScratch;
  for (let _zi = 0; _zi < NN_INPUT_SIZE; _zi++) out[_zi] = 0;
  if (!f) return out;
  const AW = 1200, AH = 1100;
  let g = null;
  try {
    if (stage && Array.isArray(stage.platforms)) {
      const _plats = stage.platforms;
      for (let _pi = 0; _pi < _plats.length; _pi++) {
        if (_plats[_pi].isGround) { g = _plats[_pi]; break; }
      }
      if (!g) g = _plats[0] || null;
    }
  } catch (_) { g = null; }
  const bz = (stage && stage.blastZones) || { left: -150, right: 1350, top: -225, bottom: 1250 };
  const centerX = g ? g.x + g.width / 2 : 600;
  const stageW = g ? g.width : 780;
  const edgeL = g ? g.x : 210, edgeR = g ? g.x + g.width : 990;
  const signedInside = g ? Math.min(f.x - edgeL, edgeR - f.x) : 999;
  const offStage = (!f.grounded && (f.x < edgeL - 20 || f.x > edgeR + 20 || (g && f.y > g.y + 10))) ? 1 : -1;
  const clampN = (v, s) => clamp1(v / s);

  out[0] = clamp1((f.x / AW) * 2 - 1);
  out[1] = clamp1((f.y / AH) * 2 - 1);
  out[2] = clampN(f.vx || 0, 600);
  out[3] = clampN(f.vy || 0, 1000);
  out[4] = clamp1((f.percent || 0) / 150);
  out[5] = f.grounded ? 1 : -1;
  out[6] = f.facingRight ? 1 : -1;
  out[7] = clamp1((f.hitstun || 0) / 0.75);
  out[8] = f.shielding ? 1 : -1;
  out[9] = f.dodging ? 1 : -1;
  out[10] = f.canDoubleJump ? 1 : -1;
  out[11] = f.canUseAerialLightRecovery ? 1 : -1;
  out[12] = (f.dodgeCooldown || 0) <= 0 ? 1 : -1;
  out[13] = (f.attackCooldown || 0) <= 0 ? 1 : -1;
  out[14] = clampN((f.x || 0) - centerX, 600);
  out[15] = clamp1(signedInside / 400);
  out[16] = offStage;
  if (opp) {
    out[17] = clamp1((opp.x / AW) * 2 - 1);
    out[18] = clamp1((opp.y / AH) * 2 - 1);
    out[19] = clamp1(Math.abs(opp.x - f.x) / 600);
    out[20] = clampN(opp.y - f.y, 600);
    out[21] = clampN(opp.vx || 0, 600);
    out[22] = clampN(opp.vy || 0, 1000);
    out[23] = clamp1((opp.percent || 0) / 150);
    out[24] = opp.grounded ? 1 : -1;
    out[25] = opp.attack ? 1 : -1;
    out[26] = opp.shielding ? 1 : -1;
    out[27] = clamp1((opp.hitstun || 0) / 0.75);
    let urg = 0;
    try {
      if (!opp.grounded && g) {
        const below = opp.y > g.y + 10;
        const outside = opp.x < edgeL - 20 || opp.x > edgeR + 20;
        urg = below ? 1 : outside ? 0.5 : 0;
      }
    } catch (_) { urg = 0; }
    out[28] = clamp1(urg);
  } else {
    out[17] = 0; out[18] = 0; out[19] = 1; out[20] = 0;
    out[21] = 0; out[22] = 0; out[23] = 0; out[24] = 1;
    out[25] = -1; out[26] = -1; out[27] = -1; out[28] = 0;
  }
  out[29] = clamp1((centerX / AW) * 2 - 1);
  out[30] = clamp1(stageW / 800);
  const dBlast = Math.min(f.x - bz.left, bz.right - f.x, bz.bottom - f.y);
  out[31] = clamp1(dBlast / 600);
  for (let i = 0; i < out.length; i++) if (!Number.isFinite(out[i])) out[i] = 0;
  return out;
}

// Map an owned attack key to the NN output index that biases it.
export function nnOutputForAttackKey(key) {
  switch (key) {
    case 'jab': return 6;
    case 'ftilt': case 'btilt': return 7;
    case 'fsmash': case 'bsmash': return 8;
    case 'utilt': return 9;
    case 'usmash': return 10;
    case 'dtilt': return 11;
    case 'dsmash': return 12;
    case 'nsmash': return 13;
    case 'aerialLight': return 14;
    case 'aerialHeavy': return 15;
    case 'dash': return 16;
    default: return 6;
  }
}
