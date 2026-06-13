const { GAME_CONFIG } = require('../config/gameConfig');
const { SPONSOR_CONTENT } = require('../content/sponsors');

function repeat(char, count) {
  return new Array(Math.max(0, count)).fill(char).join('');
}

function center(text, width) {
  const value = String(text);
  if (value.length >= width) return value;
  const totalPad = width - value.length;
  const left = Math.floor(totalPad / 2);
  const right = totalPad - left;
  return `${repeat(' ', left)}${value}${repeat(' ', right)}`;
}

function padRight(text, width) {
  const value = String(text);
  if (value.length >= width) return value;
  return value + repeat(' ', width - value.length);
}

function getSponsorLabel(state) {
  const labels = SPONSOR_CONTENT.rotatingShellLabels;
  return labels[state.sponsorLabelIndex % labels.length];
}

function buildArena(state) {
  const grid = Array.from({ length: GAME_CONFIG.height }, () => Array.from({ length: GAME_CONFIG.width }, () => ' '));

  for (let x = 0; x < GAME_CONFIG.width; x += 1) {
    grid[0][x] = '-';
    grid[GAME_CONFIG.height - 1][x] = '-';
  }
  for (let y = 0; y < GAME_CONFIG.height; y += 1) {
    grid[y][0] = '|';
    grid[y][GAME_CONFIG.width - 1] = '|';
  }
  grid[0][0] = '+';
  grid[0][GAME_CONFIG.width - 1] = '+';
  grid[GAME_CONFIG.height - 1][0] = '+';
  grid[GAME_CONFIG.height - 1][GAME_CONFIG.width - 1] = '+';

  for (const pickup of state.pickups) {
    grid[pickup.y][pickup.x] = '$';
  }
  for (const hazard of state.hazards) {
    grid[hazard.y][hazard.x] = hazard.kind === 'corruptor' ? 'X' : 'o';
  }
  if (state.trail) {
    grid[state.trail.y][state.trail.x] = ':';
    if (state.trail.from && state.trail.to) {
      const dx = state.trail.to.x - state.trail.from.x;
      const dy = state.trail.to.y - state.trail.from.y;
      const midX = state.trail.from.x + Math.sign(dx);
      const midY = state.trail.from.y + Math.sign(dy);
      if (midX >= 1 && midX < GAME_CONFIG.width - 1 && midY >= 1 && midY < GAME_CONFIG.height - 1) {
        grid[midY][midX] = dx !== 0 ? '-' : '|';
      }
    }
  }

  grid[state.player.y][state.player.x] = state.invulnerable > 0 ? '@' : (state.moveFlash > 0 ? '#' : (state.inputPulse > 0 ? 'W' : 'A'));
  return grid.map((row) => row.join(''));
}

function renderFrame(state, viewport = { columns: 100, rows: 40 }) {
  const width = Math.max(80, viewport.columns || 100);
  const arenaLines = buildArena(state);
  const shellWidth = Math.max(width, GAME_CONFIG.width + 8);
  const sponsorLabel = `[ ${getSponsorLabel(state)} ]`;
  const title = center('SIGNAL RUSH // TERMINAL ARCADE', shellWidth);
  const sponsor = center(sponsorLabel, shellWidth);
  const hudLeft = `SCORE ${state.score}   CHAIN x${state.combo.toFixed(1)}   HP ${Math.max(0, state.player.health)}/${GAME_CONFIG.startHealth}`;
  const hudRight = `DASH ${state.dashCooldown === 0 ? 'READY' : state.dashCooldown}   CREDITS ${state.credits}   BEST ${state.bestScore}`;
  const status = state.gameOver ? 'RUN LOST' : state.paused ? 'PAUSED' : (state.inputPulse > 0 ? 'INPUT LIVE' : 'LIVE');
  const combinedHud = `${padRight(hudLeft, Math.max(0, shellWidth - hudRight.length - status.length - 6))}${hudRight}   ${status}`;

  const lines = [];
  lines.push(title);
  lines.push(sponsor);
  lines.push(repeat('=', shellWidth));
  lines.push(combinedHud.slice(0, shellWidth));
  lines.push(repeat('-', shellWidth));
  lines.push('');

  for (const row of arenaLines) {
    lines.push(center(row, shellWidth));
  }

  lines.push('');
  lines.push(center(state.message, shellWidth));
  lines.push(center('SHIP=A  MOVE=#  INPUT=W  TRAIL=:-|  ENEMY=o  HEAVY=X  SIGNAL=$', shellWidth));
  lines.push(center('MOVE WASD/ARROWS | DASH SPACE | RESTART R | PAUSE P | QUIT Q', shellWidth));
  lines.push('');

  if (state.gameOver) {
    const cardWidth = Math.min(shellWidth, 72);
    lines.push(center(repeat('=', cardWidth), shellWidth));
    lines.push(center('SPONSOR MOMENT', shellWidth));
    lines.push(center('Premium sponsor placement lives here between runs, never inside active play.', shellWidth));
    lines.push(center('MANUAL TEST MODE: PRESS R TO INSTANTLY RESTART', shellWidth));
    lines.push(center(repeat('=', cardWidth), shellWidth));
  }

  return lines.join('\n');
}

module.exports = {
  renderFrame,
};
