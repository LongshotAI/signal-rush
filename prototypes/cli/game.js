#!/usr/bin/env node

const readline = require('node:readline');

const WIDTH = 32;
const HEIGHT = 18;
const TICK_MS = 100;
const HAZARD_SPAWN_MIN = 4;
const PICKUP_TARGET_MIN = 2;
const DASH_COOLDOWN_TICKS = 10;
const INVULN_TICKS = 4;
const START_HEALTH = 5;
const BANNER = 'SPONSOR SLOT: Agent Forge Residency x Signal Rush';

const keyState = {
  move: null,
  dash: false,
  restart: false,
  quit: false,
  pause: false,
};

const state = {
  running: true,
  paused: false,
  gameOver: false,
  tick: 0,
  score: 0,
  credits: 0,
  combo: 1,
  bestScore: 0,
  dashCooldown: 0,
  invulnerable: 0,
  message: 'Survive, collect signal, and route clean.',
  player: null,
  hazards: [],
  pickups: [],
};

function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function createPlayer() {
  return {
    x: Math.floor(WIDTH / 2),
    y: Math.floor(HEIGHT / 2),
    health: START_HEALTH,
  };
}

function resetGame() {
  state.paused = false;
  state.gameOver = false;
  state.tick = 0;
  state.score = 0;
  state.credits = 0;
  state.combo = 1;
  state.dashCooldown = 0;
  state.invulnerable = 0;
  state.message = 'Run live. WASD or arrows to move, space to dash.';
  state.player = createPlayer();
  state.hazards = [];
  state.pickups = [];
  for (let i = 0; i < 3; i += 1) spawnPickup();
}

function randomOpenCell(avoidCenter = false) {
  for (let tries = 0; tries < 200; tries += 1) {
    const x = randInt(1, WIDTH - 2);
    const y = randInt(1, HEIGHT - 2);
    if (avoidCenter) {
      const dist = Math.abs(x - state.player.x) + Math.abs(y - state.player.y);
      if (dist < 6) continue;
    }
    const occupiedByHazard = state.hazards.some((h) => h.x === x && h.y === y);
    const occupiedByPickup = state.pickups.some((p) => p.x === x && p.y === y);
    const occupiedByPlayer = state.player && state.player.x === x && state.player.y === y;
    if (!occupiedByHazard && !occupiedByPickup && !occupiedByPlayer) return { x, y };
  }
  return null;
}

function spawnPickup() {
  const cell = randomOpenCell(true);
  if (!cell) return;
  state.pickups.push({ x: cell.x, y: cell.y, value: randInt(12, 22), ttl: randInt(45, 75) });
}

function spawnHazard() {
  const edges = [];
  for (let x = 1; x < WIDTH - 1; x += 1) {
    edges.push({ x, y: 1 });
    edges.push({ x, y: HEIGHT - 2 });
  }
  for (let y = 2; y < HEIGHT - 2; y += 1) {
    edges.push({ x: 1, y });
    edges.push({ x: WIDTH - 2, y });
  }
  for (let tries = 0; tries < 200; tries += 1) {
    const cell = edges[randInt(0, edges.length - 1)];
    const conflict = state.hazards.some((h) => h.x === cell.x && h.y === cell.y);
    const playerConflict = state.player.x === cell.x && state.player.y === cell.y;
    if (!conflict && !playerConflict) {
      state.hazards.push({ x: cell.x, y: cell.y, kind: Math.random() < 0.2 ? 'corruptor' : 'packet' });
      return;
    }
  }
}

function consumeInput() {
  const input = {
    move: keyState.move,
    dash: keyState.dash,
    restart: keyState.restart,
    quit: keyState.quit,
    pause: keyState.pause,
  };
  keyState.move = null;
  keyState.dash = false;
  keyState.restart = false;
  keyState.quit = false;
  keyState.pause = false;
  return input;
}

function moveToward(targetX, targetY, x, y) {
  const dx = targetX - x;
  const dy = targetY - y;
  if (Math.abs(dx) > Math.abs(dy)) {
    return { x: x + Math.sign(dx), y };
  }
  if (Math.abs(dy) > 0) {
    return { x, y: y + Math.sign(dy) };
  }
  return { x, y };
}

function stepGame() {
  const input = consumeInput();

  if (input.quit) {
    shutdown('Exited Signal Rush CLI.');
    return;
  }

  if (input.pause && !state.gameOver) {
    state.paused = !state.paused;
    state.message = state.paused ? 'Paused. Press p to resume.' : 'Resumed.';
  }

  if (state.gameOver) {
    if (input.restart) {
      resetGame();
    }
    render();
    return;
  }

  if (state.paused) {
    render();
    return;
  }

  state.tick += 1;
  state.dashCooldown = Math.max(0, state.dashCooldown - 1);
  state.invulnerable = Math.max(0, state.invulnerable - 1);

  const player = state.player;

  let move = input.move;
  let steps = 1;
  if (input.dash && move && state.dashCooldown === 0) {
    steps = 2;
    state.dashCooldown = DASH_COOLDOWN_TICKS;
    state.message = 'Dash fired.';
  }

  if (move) {
    for (let i = 0; i < steps; i += 1) {
      player.x = clamp(player.x + move.x, 1, WIDTH - 2);
      player.y = clamp(player.y + move.y, 1, HEIGHT - 2);
    }
  }

  for (const hazard of state.hazards) {
    const next = moveToward(player.x, player.y, hazard.x, hazard.y);
    hazard.x = clamp(next.x, 1, WIDTH - 2);
    hazard.y = clamp(next.y, 1, HEIGHT - 2);
  }

  let tookHit = false;
  state.hazards = state.hazards.filter((hazard) => {
    const hit = hazard.x === player.x && hazard.y === player.y;
    if (!hit) return true;
    if (state.invulnerable > 0) return false;
    tookHit = true;
    player.health -= hazard.kind === 'corruptor' ? 2 : 1;
    state.combo = 1;
    state.invulnerable = INVULN_TICKS;
    state.message = hazard.kind === 'corruptor' ? 'Corruptor hit, integrity breached.' : 'Packet collision, reroute failed.';
    return false;
  });

  state.pickups = state.pickups.filter((pickup) => {
    pickup.ttl -= 1;
    if (pickup.ttl <= 0) return false;
    if (pickup.x === player.x && pickup.y === player.y) {
      state.combo = Math.min(9.9, Number((state.combo + 0.3).toFixed(1)));
      const gained = Math.floor(pickup.value * state.combo);
      state.score += gained;
      state.credits += Math.max(1, Math.floor(gained / 18));
      state.message = `Signal secured, +${gained} score.`;
      return false;
    }
    return true;
  });

  if (!tookHit) {
    state.score += Math.floor(4 * state.combo);
  }

  const hazardFloor = Math.min(18, 4 + Math.floor(state.tick / 18));
  if (state.hazards.length < hazardFloor && Math.random() < 0.65) {
    spawnHazard();
  }

  if (state.tick % 7 === 0 && state.hazards.length < HAZARD_SPAWN_MIN) {
    spawnHazard();
  }

  while (state.pickups.length < PICKUP_TARGET_MIN) {
    spawnPickup();
  }
  if (state.tick % 12 === 0 && state.pickups.length < 4) {
    spawnPickup();
  }

  if (player.health <= 0) {
    state.bestScore = Math.max(state.bestScore, state.score);
    state.gameOver = true;
    state.message = `Run over. Final score ${state.score}. Press r to restart.`;
  }

  render();
}

function render() {
  const grid = Array.from({ length: HEIGHT }, () => Array.from({ length: WIDTH }, () => ' '));

  for (let x = 0; x < WIDTH; x += 1) {
    grid[0][x] = '#';
    grid[HEIGHT - 1][x] = '#';
  }
  for (let y = 0; y < HEIGHT; y += 1) {
    grid[y][0] = '#';
    grid[y][WIDTH - 1] = '#';
  }

  for (const pickup of state.pickups) {
    grid[pickup.y][pickup.x] = '+';
  }
  for (const hazard of state.hazards) {
    grid[hazard.y][hazard.x] = hazard.kind === 'corruptor' ? 'X' : '*';
  }

  const playerGlyph = state.invulnerable > 0 ? '@' : 'O';
  grid[state.player.y][state.player.x] = playerGlyph;

  const lines = [];
  lines.push(BANNER);
  lines.push(`Score ${String(state.score).padStart(5, ' ')} | Combo x${state.combo.toFixed(1)} | HP ${state.player.health}/${START_HEALTH} | Credits ${state.credits} | Dash ${state.dashCooldown === 0 ? 'READY' : state.dashCooldown}`);
  lines.push(`Tick ${state.tick} | Hazards ${state.hazards.length} | Pickups ${state.pickups.length} | Best ${state.bestScore} ${state.paused ? '| PAUSED' : ''} ${state.gameOver ? '| GAME OVER' : ''}`);
  lines.push('');
  for (const row of grid) lines.push(row.join(''));
  lines.push('');
  lines.push(state.message);
  lines.push('Controls: WASD or arrows move, space dash, p pause, r restart after death, q quit');

  process.stdout.write('\x1b[2J\x1b[H');
  process.stdout.write(lines.join('\n'));
}

function handleKeypress(_, key = {}) {
  if (key.sequence === '\u0003') {
    shutdown('Exited Signal Rush CLI.');
    return;
  }

  const name = key.name || '';
  const seq = typeof _ === 'string' ? _.toLowerCase() : '';
  if (name === 'up' || name === 'w' || seq === 'w') keyState.move = { x: 0, y: -1 };
  else if (name === 'down' || name === 's' || seq === 's') keyState.move = { x: 0, y: 1 };
  else if (name === 'left' || name === 'a' || seq === 'a') keyState.move = { x: -1, y: 0 };
  else if (name === 'right' || name === 'd' || seq === 'd') keyState.move = { x: 1, y: 0 };
  else if (name === 'space' || seq === ' ') keyState.dash = true;
  else if (name === 'r' || _.toLowerCase() === 'r') keyState.restart = true;
  else if (name === 'q' || _.toLowerCase() === 'q') keyState.quit = true;
  else if (name === 'p' || _.toLowerCase() === 'p') keyState.pause = true;
}

let interval = null;
let shuttingDown = false;

function shutdown(message) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (interval) clearInterval(interval);
  process.stdin.off('keypress', handleKeypress);
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  process.stdin.pause();
  process.stdout.write('\x1b[2J\x1b[H');
  console.log(message);
  process.exit(0);
}

function start() {
  resetGame();
  readline.emitKeypressEvents(process.stdin);
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on('keypress', handleKeypress);
  render();
  interval = setInterval(stepGame, TICK_MS);
}

start();
