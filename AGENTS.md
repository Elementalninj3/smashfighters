# AGENTS.md — working agreement for this repo

## Default workflow: IMPLEMENT → STOP

When asked to add or modify an ability, mechanic, VFX, weapon, character feature,
or any other game functionality: **make the change, then stop and report what you
changed.** Do not launch the dev server, do not open a browser, and do not run
tests to "confirm" the work.

### Never run these unless the user explicitly asks

- `npm test`, `npm run test:*` (any suite in `tests/`)
- `node tests/*.mjs` — any individual suite
- `npm run build`
- ad-hoc Playwright / `chromium` scripts written to poke at a change
- repeated runs of the same suite to "check for flakiness"

Tests run **only** when the user says something like *"test it"*, *"test this"*,
*"run tests"*, *"verify"*, or names a specific suite. Absent that, the request to
implement is the whole request.

The trigger is the user's word, not your confidence. A change that looks
complete still stops unverified — say what you changed and let them decide.

## Why

Every suite here drives a real headless Chromium against a live dev server on
`http://localhost:5173/?probe`. The full set takes many minutes of wall clock and
software-rendered rendering, which also makes the timing-sensitive suites
(`verify-cooldowns`, `verify-knockback-sweep`) report flaky failures that have
nothing to do with the change under test. That cost is only worth paying on
request.

## What "basic code correctness" means here

Keep the code obviously correct while editing: match the surrounding style,
finish every branch you open, don't leave a half-applied refactor. That is the
standard — not a test run. Re-reading the file you just edited is fine.

## Testing (when the user asks for it)

Start the dev server first — every suite needs it on port 5173:

```
npm run dev            # leave running in its own terminal
```

Then run whatever the user asked for:

| Command | Suite |
| --- | --- |
| `npm test` | `tests/perf-smoke.mjs` — frame-time smoke |
| `npm run test:all` | the reliable core set, sequentially (minutes) |
| `npm run test:combat` | `tests/verify-combat.mjs` |
| `npm run test:side-smash` | `tests/verify-side-smash-animstore.mjs` |
| `npm run test:ninja` | the three ninja suites |
| `node tests/<file>.mjs` | any single suite, by name |

Longer / more timing-sensitive suites, run individually on request only:
`verify-ai-accuracy`, `verify-ai-evolution`, `verify-ai-training`,
`verify-ai-medium`, `verify-ai-preview`, `verify-ai-keys`, `verify-ai-math`,
`verify-real`, `verify-perf`, `verify-cooldowns`, `verify-knockback-sweep`,
`verify-camera-start`, `probe-keys`.

Report the pass/fail counts you actually got. If a suite fails, say whether it is
related to the change rather than assuming either way.

## The `?probe` API is test infrastructure — leave it in place

`src/Game.js` exposes `window.__ssTest` **only** when the page is loaded with
`?probe` (see the `[PROBE]` block). It is inert in normal play and every suite
depends on it. Do not remove it, and do not gate it behind a build flag. It does
not run anything by itself.

## Scope rules

- Change only the testing *workflow*, never gameplay. Removing a probe field or a
  suite's helpers to make a run quieter is out of bounds.
- Don't duplicate a system to avoid touching the original; extend it.
- Don't delete `tests/*.mjs` files. They stay available for when they're wanted.
