// ai-model-storage.js — persistence for trained AI models.
//
// Uses the project's existing pattern (localStorage JSON, try/catch everywhere
// so a corrupt profile can never crash the game). One entry per character id:
// the latest training result for that character. Falls back to null when no
// model exists — callers must then use the scripted AI, never a fake model.

import { NN_INPUT_SIZE, NN_HIDDEN_SIZE, NN_OUTPUT_SIZE, NN_WEIGHT_COUNT } from './ai-neural-network.js';

const STORE_KEY = 'smashfighters.trainedModels.v1';

function readStore() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (_) {
    return {};
  }
}

function writeStore(store) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(store));
    return true;
  } catch (_) {
    return false;
  }
}

export function nnArch() {
  return { inputs: NN_INPUT_SIZE, hidden: NN_HIDDEN_SIZE, outputs: NN_OUTPUT_SIZE };
}

function validWeights(w) {
  return Array.isArray(w) && w.length === NN_WEIGHT_COUNT && w.every(Number.isFinite);
}

// Save the best genome of a training run for a character.
export function saveTrainedModel(charId, data) {
  if (!charId || !data || !validWeights(data.weights)) return false;
  try {
    const store = readStore();
    store[charId] = {
      version: 1,
      character: charId,
      opponent: data.opponent || null,
      arch: nnArch(),
      weights: data.weights.slice(),
      behavior: { ...(data.behavior || {}) },
      fitness: Number.isFinite(data.fitness) ? data.fitness : 0,
      wins: Number.isFinite(data.wins) ? data.wins : 0,
      generation: Number.isFinite(data.generation) ? data.generation : 0,
      config: { ...(data.config || {}) },
      savedAt: new Date().toISOString(),
    };
    return writeStore(store);
  } catch (_) {
    return false;
  }
}

// Load the trained model for a character, or null when none exists / the
// stored entry is corrupt (wrong arch, bad weights → treated as absent).
export function loadTrainedModel(charId) {
  if (!charId) return null;
  try {
    const store = readStore();
    const m = store[charId];
    if (!m || typeof m !== 'object') return null;
    if (!m.arch || m.arch.inputs !== NN_INPUT_SIZE || m.arch.hidden !== NN_HIDDEN_SIZE || m.arch.outputs !== NN_OUTPUT_SIZE) return null;
    if (!validWeights(m.weights)) return null;
    return m;
  } catch (_) {
    return null;
  }
}

export function hasTrainedModel(charId) {
  return loadTrainedModel(charId) !== null;
}

export function listTrainedModels() {
  try {
    const store = readStore();
    return Object.keys(store).map((k) => ({
      character: k,
      opponent: store[k].opponent || null,
      fitness: store[k].fitness || 0,
      generation: store[k].generation || 0,
      savedAt: store[k].savedAt || null,
    }));
  } catch (_) {
    return [];
  }
}

export function deleteTrainedModel(charId) {
  try {
    const store = readStore();
    if (!(charId in store)) return false;
    delete store[charId];
    return writeStore(store);
  } catch (_) {
    return false;
  }
}

export function clearTrainedModels() {
  try {
    localStorage.removeItem(STORE_KEY);
    return true;
  } catch (_) {
    return false;
  }
}
