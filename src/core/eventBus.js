// core/eventBus.js — the game's publish/subscribe bus.
//
// A single process-wide bus. Systems publish facts ("sfxPlay") rather than
// calling each other, so the audio layer can announce a playback without
// knowing who cares, and a future HUD/analytics listener can attach without any
// producer being edited.

function createEventBus() {
  const handlers = new Map();
  return {
    on(event, handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    off(event, handler) {
      const list = handlers.get(event);
      if (!list) return;
      const i = list.indexOf(handler);
      if (i !== -1) list.splice(i, 1);
    },
    emit(event, payload) {
      (handlers.get(event) ?? []).forEach(h => h(payload));
    },
  };
}

export const eventBus = createEventBus();
