// tests/node/_env.mjs — minimal browser-global stubs so pure game logic
// (combat, fighters, AI, storage) can be exercised in plain Node.
// No rendering happens here; anything touching canvas/DOM/audio is stubbed.

if (typeof globalThis.localStorage === 'undefined') {
  const _mem = new Map();
  globalThis.localStorage = {
    getItem: (k) => (_mem.has(String(k)) ? _mem.get(String(k)) : null),
    setItem: (k, v) => { _mem.set(String(k), String(v)); },
    removeItem: (k) => { _mem.delete(String(k)); },
    clear: () => _mem.clear(),
  };
}

if (typeof globalThis.window === 'undefined') {
  globalThis.window = globalThis;
}

if (typeof globalThis.document === 'undefined') {
  const stubCtx = () => new Proxy({}, {
    get: (t, p) => {
      if (p === 'canvas') return undefined;
      if (p === 'measureText') return () => ({ width: 10 });
      if (p === 'getImageData') return () => ({ data: [] });
      return typeof p === 'string' ? (..._) => stubCtx() : undefined;
    },
    set: () => true,
  });
  globalThis.document = {
    createElement: () => ({
      width: 0, height: 0, style: {},
      getContext: () => stubCtx(),
    }),
    getElementById: () => null,
    addEventListener: () => {},
  };
}

if (typeof globalThis.requestAnimationFrame === 'undefined') {
  globalThis.requestAnimationFrame = () => 0;
  globalThis.cancelAnimationFrame = () => {};
}

export function resetEnvStorage() {
  try { globalThis.localStorage.clear(); } catch (_) {}
}
