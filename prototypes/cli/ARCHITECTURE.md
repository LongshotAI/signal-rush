# Signal Rush CLI Architecture Note

## Goal
Keep the CLI build isolated from the browser MVP while preserving the same game feel decisions.

## Structure
- `game.js`: single-file terminal runtime and game loop
- `README.md`: launch and controls

## Loop Contract
Each tick resolves in this order:
1. consume buffered input
2. resolve player movement or dash
3. move hazards one cell toward the player
4. resolve player-vs-hazard collisions only
5. resolve pickups and score updates
6. render ASCII frame

## Why this shape
Terminal play benefits from a strict readable loop. Player-first resolution preserves fairness and keeps the game from feeling cheap under terminal latency.
