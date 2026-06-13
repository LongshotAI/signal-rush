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

Run it with:

```bash
cd signal-rush-project
npm run cli
```

Or:

```bash
node src/cli/index.js
```

Run verification with:

```bash
npm test
```

This runs deterministic mechanics checks plus the CLI smoke test.

Latest local audit note:

- `docs/FUNCTIONALITY_AUDIT_2026-06-13.md`

## Design direction

- shared engine first
- multiple renderers later
- terminal CLI as the first native game surface
- web and ad/admin layers can attach around the same core rules

## Status

This is an early codebase foundation, not a production release.
