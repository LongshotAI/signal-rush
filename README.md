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

### Safe GitHub sync guard

This repo includes a local sync guard so updates do not stay only on one machine.

Manual safe sync:

```bash
npm run sync:github
```

Deeper proof sync with a fresh GitHub clone:

```bash
npm run sync:github:fresh
```

Install the local auto-sync hook on a developer machine:

```bash
npm run install:auto-sync
```

After installation, every local commit runs `scripts/safe-sync-github.sh` automatically. The guard:

- refuses to push if the working tree has uncommitted changes
- checks for tracked local state/secret-looking files
- runs `npm test`
- pushes `main` to `https://github.com/LongshotAI/signal-rush.git`
- fetches back from GitHub
- verifies local `HEAD`, `origin/main`, and GitHub `refs/heads/main` are identical
- writes a local log to `.git/signal-rush-sync.log`

If the hook fails, the commit remains local and the fix is to resolve the reported issue, commit/stash remaining changes, then run `npm run sync:github`.

Latest local audit note:

- `docs/FUNCTIONALITY_AUDIT_2026-06-13.md`

## Design direction

- shared engine first
- multiple renderers later
- terminal CLI as the first native game surface
- web and ad/admin layers can attach around the same core rules

## Status

This is an early codebase foundation, not a production release.
