# Space Glow

Minimal playable prototype for **Space Glow**, an austere one-tap timing game with invisible phase telemetry.

## What is included

- Browser-playable canvas MVP in `index.html`
- TypeScript script files in `src/` for core game logic
- Thin generated browser modules in `dist/`
- Deterministic seeded randomness via `?seed=your-seed`
- Debug overlay via `?debug=1` or the `D` key
- Two-minute measured session with three phases:
  - `0-40s` stable rhythm
  - `40-80s` target drift volatility
  - `80-120s` recovery / stable rules
- Full session JSON download from the end screen
- Construct 3 bridge notes in `construct3/`

## Run locally

```bash
node tools/build.mjs
python3 -m http.server 4173 --bind 127.0.0.1
```

Then open:

```text
http://127.0.0.1:4173/
```

Useful test URL:

```text
http://127.0.0.1:4173/?debug=1&seed=space-glow-mvp
```

## Verify core logic

```bash
node tools/build.mjs
node tests/core-smoke.mjs
```

## Notes

The current deliverable is intentionally small: one input, one volatility manipulation, no lives, no game-over, and neutral player-facing language. Phase 1 and Phase 3 use the same mechanics. Phase 2 only drifts the target before launch and freezes it once the player launches.
