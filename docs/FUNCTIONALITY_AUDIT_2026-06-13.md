# Signal Rush Functionality Audit — 2026-06-13

## Scope
Audited the main Signal Rush codebase at:

`/home/hive/.openclaw/agents/agent-forge/workspace/signal-rush-project`

Compared against adjacent prototypes:

- `signal-rush-cli`
- `signal-rush-mvp`

## Ground Truth
This project is not currently a Git repository:

```text
fatal: not a git repository (or any of the parent directories): .git
```

That means changes must be tracked with explicit files/receipts until this is put under version control.

## Existing Runnable Surface
The active executable surface is the terminal CLI:

```bash
npm run cli
npm run cli:demo
```

Existing smoke test before this audit:

```bash
npm run test:smoke
# Smoke test passed.
```

## Confirmed Issues Found

### 1. Raw initial state rendered an undefined sponsor label
`renderFrame(createInitialState())` produced:

```text
[ undefined ]
```

Root cause: `createInitialState()` did not initialize `sponsorLabelIndex` or other renderer/engine metadata that `resetState()` added later.

Fix: initialized missing state metadata directly in `src/core/createInitialState.js`.

### 2. CLI movement could stick forever
`src/cli/input.js` stored movement in `activeMoves`, but terminal `keypress` events do not provide a reliable keyup/release event in this implementation. Once a direction was added, it stayed active forever.

Fix: changed input handling to one-shot queued movement. Holding a key can still repeat via terminal key repeat, but a single tap no longer causes permanent movement.

### 3. Last-tick pickups could expire before collection
A pickup at the player's position with `ttl: 1` was decremented and removed before collision/collection was checked.

Fix: collect first, then decrement TTL for uncollected pickups.

### 4. No core mechanics regression test existed
Only a demo smoke test existed, so game-feel regressions could pass as long as the demo exited.

Fix: added `scripts/mechanics-test.js` and wired `npm test` to run mechanics + smoke.

## Files Changed

- `package.json`
  - added `test`
  - added `test:mechanics`
- `scripts/mechanics-test.js`
  - new deterministic regression tests
- `src/core/createInitialState.js`
  - initializes `lastMove`, `currentMove`, `lastEvents`, `lastMilestoneIndex`, `sponsorLabelIndex`
- `src/core/engine.js`
  - pickup collection happens before TTL expiry
- `src/cli/input.js`
  - one-shot queued movement instead of permanent active move set

## Verification Output

```bash
npm test
```

Result:

```text
PASS testRawInitialStateRendersCleanSponsorLabel
PASS testDirectionalInputIsOneShotWithoutKeyupSupport
PASS testPickupCollectedBeforeExpiryOnSameTick
PASS testDashUsesLastMoveAndCooldown
Mechanics tests passed: 4
Smoke test passed.
```

Raw initial render verification:

```text
[ Presented by Temple Works ]
contains undefined: false
```

CLI demo verification:

```text
Signal Rush CLI demo smoke test complete.
```

## Remaining Technical Debt

### High priority
1. Put the project under Git/version control.
2. Add deterministic RNG injection so spawn/difficulty tests do not depend on `Math.random`.
3. Add tests for hazard contact, invulnerability, game over, restart, score milestones, and sponsor impression rotation.
4. Add a non-interactive playback/simulation mode for testing scripted input sequences.

### Medium priority
1. Decide whether CLI movement should be one-shot grid input or continuous key-repeat input. Current fix makes one tap safe; smoother continuous movement may need a better raw-key layer.
2. Deduplicate planning docs duplicated at project root and under `docs/`.
3. Promote useful web MVP ideas — canvas renderer, particles, overlays, keyup tracking — into the shared architecture without copying the monolithic MVP structure.
4. Split economy/ad impression events into separate modules as described in `ARCHITECTURE.md`.

### Product/game-feel priority
1. Tune hazard ramp after real playtesting; current smoke tests do not prove fun.
2. Improve visual telegraphing before hazard pressure spikes.
3. Add run summary metrics: survival ticks, pickups collected, hits taken, max combo, credits earned.
4. Add fast restart flow verification under one second.
