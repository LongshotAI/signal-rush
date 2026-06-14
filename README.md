# Signal Rush Project

Structured project workspace for the Signal Rush game.

## What is here

- `src/core/` shared game engine logic
- `src/cli/` terminal renderer and runtime
- `src/config/` tuning constants
- `src/content/` sponsor and UX copy stubs
- `scripts/` smoke tests and utility scripts
- `docs/` product and technical docs migrated from the planning files

## Current runnable surface

The CLI game is the active executable surface.

### Team launch from GitHub

For a fresh machine or teammate device:

```bash
git clone https://github.com/LongshotAI/signal-rush.git
cd signal-rush
npm install
node src/cli/index.js
```

The start menu includes:

- **AI Hunt** — the original survival arcade mode
- **Frogger** — lane-crossing mode with home slots, water/log lanes, cars, score, lives, timer, and a visible GOAL bar

Controls:

- Move: **WASD**, **arrow keys**, or **vim keys** (`K/J` in menus)
- Pause: `P`
- Restart current mode: `R`
- Return to menu: `M`
- Quit: `Q`

Run a specific mode directly:

```bash
node src/cli/index.js --mode=aiHunt
node src/cli/index.js --mode=frogger
```

Run verification with:

```bash
npm test
```

This runs deterministic mechanics checks, the CLI smoke test, and a Frogger render verification that confirms the GOAL bar, home slots, water/log lanes, cars, and GET READY overlay are present in the GitHub copy.

Latest local audit note:

- `docs/FUNCTIONALITY_AUDIT_2026-06-13.md`

## Design direction

- shared engine first
- multiple renderers later
- terminal CLI as the first native game surface
- web and ad/admin layers can attach around the same core rules

## Status

This is an early codebase foundation, not a production release.
