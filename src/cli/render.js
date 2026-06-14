const { GAME_CONFIG } = require('../config/gameConfig');
const { SPONSOR_CONTENT } = require('../content/sponsors');

const COLORS = {
  reset:   '\x1b[0m',
  bold:    '\x1b[1m',
  dim:     '\x1b[2m',
  red:     '\x1b[31m',
  green:   '\x1b[32m',
  yellow:  '\x1b[33m',
  magenta: '\x1b[35m',
  cyan:    '\x1b[36m',
  white:   '\x1b[37m',
};

const ANSI_RE = /\x1b\[[0-9;]*m/g;

function visibleLength(s) {
  return s.replace(ANSI_RE, '').length;
}

function paint(code, char, options = {}) {
  if (options.colors === false) return String(char);
  return `${code}${char}${COLORS.reset}`;
}

function repeat(char, count) {
  return new Array(Math.max(0, count)).fill(char).join('');
}

function center(text, width) {
  const value = String(text);
  const v = visibleLength(value);
  if (v >= width) return value;
  const totalPad = width - v;
  const left = Math.floor(totalPad / 2);
  const right = totalPad - left;
  return `${repeat(' ', left)}${value}${repeat(' ', right)}`;
}

function padRight(text, width) {
  const value = String(text);
  const v = visibleLength(value);
  if (v >= width) return value;
  return value + repeat(' ', width - v);
}

function getSponsorLabel(state) {
  const labels = SPONSOR_CONTENT.rotatingShellLabels;
  return labels[state.sponsorLabelIndex % labels.length];
}

function buildArena(state, options = {}) {
  const p = (code, ch) => paint(code, ch, options);
  const grid = Array.from({ length: GAME_CONFIG.height }, () => Array.from({ length: GAME_CONFIG.width }, () => ' '));

  // Walls and corners
  for (let x = 0; x < GAME_CONFIG.width; x += 1) {
    grid[0][x] = p(COLORS.dim + COLORS.white, '-');
    grid[GAME_CONFIG.height - 1][x] = p(COLORS.dim + COLORS.white, '-');
  }
  for (let y = 0; y < GAME_CONFIG.height; y += 1) {
    grid[y][0] = p(COLORS.dim + COLORS.white, '|');
    grid[y][GAME_CONFIG.width - 1] = p(COLORS.dim + COLORS.white, '|');
  }
  grid[0][0] = p(COLORS.dim + COLORS.white, '+');
  grid[0][GAME_CONFIG.width - 1] = p(COLORS.dim + COLORS.white, '+');
  grid[GAME_CONFIG.height - 1][0] = p(COLORS.dim + COLORS.white, '+');
  grid[GAME_CONFIG.height - 1][GAME_CONFIG.width - 1] = p(COLORS.dim + COLORS.white, '+');

  // Pickups
  for (const pickup of state.pickups) {
    grid[pickup.y][pickup.x] = p(COLORS.bold + COLORS.green, '$');
  }
  // Hazards
  for (const hazard of state.hazards) {
    const isCorruptor = hazard.kind === 'corruptor';
    const color = isCorruptor ? (COLORS.bold + COLORS.magenta) : COLORS.red;
    const ch = isCorruptor ? 'X' : 'o';
    grid[hazard.y][hazard.x] = p(color, ch);
  }
  // Trail
  if (state.trail) {
    grid[state.trail.y][state.trail.x] = p(COLORS.dim + COLORS.cyan, ':');
    if (state.trail.from && state.trail.to) {
      const dx = state.trail.to.x - state.trail.from.x;
      const dy = state.trail.to.y - state.trail.from.y;
      const midX = state.trail.from.x + Math.sign(dx);
      const midY = state.trail.from.y + Math.sign(dy);
      if (midX >= 1 && midX < GAME_CONFIG.width - 1 && midY >= 1 && midY < GAME_CONFIG.height - 1) {
        grid[midY][midX] = p(COLORS.dim + COLORS.cyan, dx !== 0 ? '-' : '|');
      }
    }
  }
  // Player ship
  let playerChar;
  if (state.invulnerable > 0) playerChar = '@';
  else if (state.moveFlash > 0) playerChar = '#';
  else if (state.inputPulse > 0) playerChar = 'W';
  else playerChar = 'A';
  grid[state.player.y][state.player.x] = p(COLORS.bold + COLORS.white, playerChar);

  return grid.map((row) => row.join(''));
}

function buildStatus(state, options = {}) {
  const p = (code, ch) => paint(code, ch, options);
  // We only need the color string and text; render-time applies them.
  if (state.gameOver) {
    return { text: 'RUN LOST', color: COLORS.bold + COLORS.red, paint: p };
  }
  if (state.paused) {
    return { text: 'PAUSED', color: COLORS.bold + COLORS.yellow, paint: p };
  }
  if (state.inputPulse > 0) {
    return { text: 'INPUT LIVE', color: COLORS.bold + COLORS.cyan, paint: p };
  }
  return { text: 'LIVE', color: COLORS.dim + COLORS.white, paint: p };
}

function buildHudLeft(state, options = {}) {
  const p = (code, ch) => paint(code, ch, options);
  const hpValue = Math.max(0, state.player.health);
  const hpColor = hpValue <= 2
    ? (COLORS.bold + COLORS.red)
    : (COLORS.bold + COLORS.yellow);
  return (
    `${p(COLORS.dim, 'SCORE')} ${p(COLORS.bold + COLORS.yellow, String(state.score))}` +
    `   ${p(COLORS.dim, 'CHAIN')} ${p(COLORS.bold + COLORS.yellow, 'x' + state.combo.toFixed(1))}` +
    `   ${p(COLORS.dim, 'HP')} ${p(hpColor, String(hpValue) + '/' + GAME_CONFIG.startHealth)}`
  );
}

function buildHudRight(state, options = {}) {
  const p = (code, ch) => paint(code, ch, options);
  const dashText = state.dashCooldown === 0
    ? p(COLORS.bold + COLORS.green, 'READY')
    : p(COLORS.dim, String(state.dashCooldown));
  return (
    `${p(COLORS.dim, 'DASH')} ${dashText}` +
    `   ${p(COLORS.dim, 'CREDITS')} ${p(COLORS.bold + COLORS.yellow, String(state.credits))}` +
    `   ${p(COLORS.dim, 'BEST')} ${p(COLORS.bold + COLORS.yellow, String(state.bestScore))}`
  );
}

function renderFrame(state, viewport = { columns: 100, rows: 40 }, options = {}) {
  const p = (code, ch) => paint(code, ch, options);
  const width = Math.max(80, viewport.columns || 100);
  const arenaLines = buildArena(state, options);
  const shellWidth = Math.max(width, GAME_CONFIG.width + 8);
  const sponsorLabel = `[ ${getSponsorLabel(state)} ]`;
  const title = center(p(COLORS.bold + COLORS.cyan, 'SIGNAL RUSH // TERMINAL ARCADE'), shellWidth);
  const sponsor = center(p(COLORS.dim + COLORS.white, sponsorLabel), shellWidth);

  const hudLeft = buildHudLeft(state, options);
  const hudRight = buildHudRight(state, options);
  const status = buildStatus(state, options);
  const statusText = p(status.color, status.text);

  // Reserve 6 chars of spacing: 3 left of hudRight, 3 left of status
  const paddingWidth = Math.max(0, shellWidth - visibleLength(hudLeft) - visibleLength(hudRight) - visibleLength(statusText) - 6);
  const combinedHud = `${padRight(hudLeft, paddingWidth + visibleLength(hudLeft))}   ${hudRight}   ${statusText}`;

  const lines = [];
  lines.push(title);
  lines.push(sponsor);
  lines.push(repeat('=', shellWidth));
  lines.push(combinedHud);
  lines.push(repeat('-', shellWidth));
  lines.push('');

  for (const row of arenaLines) {
    lines.push(center(row, shellWidth));
  }

  lines.push('');
  lines.push(center(state.message, shellWidth));
  lines.push(center(p(COLORS.dim, 'SHIP=A  MOVE=#  INPUT=W  TRAIL=:-|  ENEMY=o  HEAVY=X  SIGNAL=$'), shellWidth));
  lines.push(center(p(COLORS.dim, 'MOVE WASD/ARROWS | DASH SPACE | RESTART R | PAUSE P | QUIT Q'), shellWidth));
  lines.push('');

  if (state.gameOver) {
    const cardWidth = Math.min(shellWidth, 72);
    const ds = state.deathState;
    const finalScore = ds ? ds.finalScore : state.score;
    const finalCombo = ds ? ds.finalCombo : state.combo;
    const finalCredits = ds ? ds.finalCredits : state.credits;
    const best = state.bestScore;
    const newRecord = ds ? ds.bestScoreUpdated : false;

    const border = center(p(COLORS.dim + COLORS.white, repeat('=', cardWidth)), shellWidth);
    const header = center(p(COLORS.bold + COLORS.red, 'RUN ENDED'), shellWidth);
    const scoreLine = center(
      `${p(COLORS.dim, 'Final Score')} ${p(COLORS.bold + COLORS.yellow, String(finalScore))}`,
      shellWidth
    );
    const bestLine = center(
      `${p(COLORS.dim, 'Best Score')} ${p(COLORS.bold + COLORS.yellow, String(best))}` +
      (newRecord ? '   ' + p(COLORS.bold + COLORS.green, '* NEW *') : ''),
      shellWidth
    );
    const comboLine = center(
      `${p(COLORS.dim, 'Final Combo')} ${p(COLORS.bold + COLORS.yellow, 'x' + finalCombo.toFixed(1))}`,
      shellWidth
    );
    const creditsLine = center(
      `${p(COLORS.dim, 'Credits Earned')} ${p(COLORS.bold + COLORS.yellow, String(finalCredits))}`,
      shellWidth
    );
    const restartMsg = center(p(COLORS.bold + COLORS.cyan, 'PRESS R TO RESTART'), shellWidth);
    const devMsg = center(p(COLORS.dim + COLORS.white, 'MANUAL TEST MODE: PRESS R TO INSTANTLY RESTART'), shellWidth);

    lines.push(border);
    lines.push(header);
    lines.push(border);
    lines.push(scoreLine);
    lines.push(bestLine);
    lines.push(comboLine);
    lines.push(creditsLine);
    lines.push('');
    lines.push(restartMsg);
    lines.push(devMsg);
    lines.push(border);
  }

  return lines.join('\n');
}

module.exports = {
  renderFrame,
  visibleLength,
  paint,
  COLORS,
};
