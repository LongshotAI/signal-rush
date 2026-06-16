# Signal Rush CLI

Terminal-native playable build of Signal Rush.

## What it is

A local ASCII version of the core survival loop:
- move the player node through a bounded arena
- avoid incoming packets and corruptors
- collect signal pickups
- build combo, score, and credits
- use dash carefully, then restart fast

This version follows the locked v0.1 terminal contract:
1. player input resolves first
2. player move or dash resolves
3. hazards move toward the player
4. player-vs-hazard collisions resolve
5. pickups, score, and render update

No hazard-vs-hazard collisions in v0.1.

## Run

From the workspace root:

```bash
node signal-rush-cli/game.js
```

Or from inside the folder:

```bash
cd signal-rush-cli
node game.js
```

## Controls

- `WASD` or arrow keys: move
- `Space`: dash in your last move direction for a 2-cell burst
- `P`: pause/resume
- `R`: restart after death
- `Q`: quit
- `Ctrl+C`: force quit

## Symbols

- `O` player node
- `@` player while briefly invulnerable after a hit
- `*` packet hazard
- `X` corruptor hazard, heavier damage
- `+` signal pickup
- `#` arena wall

## Notes

- No external packages required
- Designed for Node 18+ and standard local terminals
- Existing web MVP files are untouched
