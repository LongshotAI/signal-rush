const { GAME_CONFIG } = require('../config/gameConfig');
const { SPONSOR_CONTENT } = require('../content/sponsors');

const COLORS = {
  reset:   '\x1b[0m',
  bold:    '\x1b[1m',
  dim:     '\x1b[2m',
  red:     '\x1b[31m',
  green:   '\x1b[32m',
  yellow:  '\x1b[33m',
  brown:   '\x1b[33m',  // terminal-friendly fallback for 256-color brown
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

  if (state.mode === 'frogger') {
    return buildArenaFrogger(state, grid, p);
  }
  return buildArenaAiHunt(state, grid, p);
}

function buildArenaAiHunt(state, grid, p) {
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

  for (const pickup of state.pickups) {
    grid[pickup.y][pickup.x] = p(COLORS.bold + COLORS.green, '$');
  }
  for (const hazard of state.hazards) {
    const isCorruptor = hazard.kind === 'corruptor';
    const color = isCorruptor ? (COLORS.bold + COLORS.magenta) : COLORS.red;
    const ch = isCorruptor ? 'X' : 'o';
    grid[hazard.y][hazard.x] = p(color, ch);
  }
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
  let playerChar;
  if (state.invulnerable > 0) playerChar = '@';
  else if (state.moveFlash > 0) playerChar = '#';
  else if (state.inputPulse > 0) playerChar = 'W';
  else playerChar = 'A';
  grid[state.player.y][state.player.x] = p(COLORS.bold + COLORS.white, playerChar);
  return grid.map((row) => row.join(''));
}

function buildArenaFrogger(state, grid, p) {
  const cfg = GAME_CONFIG.modes.frogger;
  // Walls
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

  // Draw lanes
  for (const lane of state.lanes) {
    if (lane.type === 'river') {
      for (let x = 1; x < GAME_CONFIG.width - 1; x += 1) grid[lane.y][x] = p(COLORS.dim + COLORS.cyan, '~');
      for (const v of lane.vehicles) {
        grid[lane.y][v.x] = p(COLORS.bold + COLORS.brown || COLORS.yellow, '=');
      }
    } else if (lane.type === 'road') {
      for (let x = 1; x < GAME_CONFIG.width - 1; x += 1) grid[lane.y][x] = p(COLORS.dim + COLORS.white, ':');
      for (const v of lane.vehicles) {
        const ch = lane.direction > 0 ? '>' : '<';
        grid[lane.y][v.x] = p(COLORS.red, ch);
      }
    } else if (lane.type === 'median') {
      for (let x = 1; x < GAME_CONFIG.width - 1; x += 1) grid[lane.y][x] = p(COLORS.dim + COLORS.green, '.');
    } else if (lane.type === 'home') {
      // Home slots rendered separately
    }
  }

  // Home slots on row 1
  if (Array.isArray(state.homeSlots)) {
    cfg.homeSlotXs.forEach((slotX, i) => {
      const filled = state.homeSlots[i];
      const ch = filled ? 'F' : '_';
      const color = filled ? (COLORS.bold + COLORS.green) : (COLORS.dim + COLORS.white);
      grid[1][slotX] = p(color, ch);
    });
  }

  // Frog (player)
  const playerOnLog = state.onLog !== null;
  const playerChar = state.inputPulse > 0 ? 'O' : (playerOnLog ? 'F' : 'F');
  const playerColor = state.onLog
    ? (COLORS.bold + COLORS.cyan)
    : (COLORS.bold + COLORS.green);
  if (state.player.y >= 0 && state.player.y < GAME_CONFIG.height &&
      state.player.x >= 0 && state.player.x < GAME_CONFIG.width) {
    grid[state.player.y][state.player.x] = p(playerColor, playerChar);
  }
  return grid.map((row) => row.join(''));
}

// Provide brown via yellow fallback (terminals vary on 256-color SGR)
// (defined in COLORS above)

function buildStatus(state, options = {}) {
  const p = (code, ch) => paint(code, ch, options);
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
  if (state.mode === 'frogger') {
    const timeColor = state.timeLeft <= 10
      ? (COLORS.bold + COLORS.red)
      : (COLORS.bold + COLORS.yellow);
    const livesStr = 'F'.repeat(Math.max(0, state.lives)) + '.'.repeat(Math.max(0, state.maxLives - state.lives));
    return (
      `${p(COLORS.dim, 'LVL')} ${p(COLORS.bold + COLORS.cyan, String(state.level))}` +
      `   ${p(COLORS.dim, 'SCORE')} ${p(COLORS.bold + COLORS.yellow, String(state.score))}` +
      `   ${p(COLORS.dim, 'TIME')} ${p(timeColor, String(Math.max(0, state.timeLeft)))}` +
      `   ${p(COLORS.dim, 'LIVES')} ${p(COLORS.bold + COLORS.green, livesStr)}`
    );
  }
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
  if (state.mode === 'frogger') {
    const slotsFilled = (state.homeSlots || []).filter(Boolean).length;
    return (
      `${p(COLORS.dim, 'SLOTS')} ${p(COLORS.bold + COLORS.green, String(slotsFilled) + '/5')}` +
      `   ${p(COLORS.dim, 'CREDITS')} ${p(COLORS.bold + COLORS.yellow, String(state.credits))}` +
      `   ${p(COLORS.dim, 'BEST')} ${p(COLORS.bold + COLORS.yellow, String(state.bestScore))}`
    );
  }
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
  const modeTag = state.mode === 'frogger' ? 'FROGGER' : 'AI HUNT';
  const title = center(p(COLORS.bold + COLORS.cyan, `SIGNAL RUSH // ${modeTag}`), shellWidth);
  const sponsor = center(p(COLORS.dim + COLORS.white, sponsorLabel), shellWidth);

  const hudLeft = buildHudLeft(state, options);
  const hudRight = buildHudRight(state, options);
  const status = buildStatus(state, options);
  const statusText = p(status.color, status.text);

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
  if (state.mode === 'frogger') {
    lines.push(center(p(COLORS.dim, 'FROG=F  LOG==  WATER=~  CAR=><  HOME=_  FILLED=F  GRASS=.'), shellWidth));
    lines.push(center(p(COLORS.dim, 'MOVE WASD/ARROWS | PAUSE P | RESTART R | QUIT Q'), shellWidth));
  } else {
    lines.push(center(p(COLORS.dim, 'SHIP=A  MOVE=#  INPUT=W  TRAIL=:-|  ENEMY=o  HEAVY=X  SIGNAL=$'), shellWidth));
    lines.push(center(p(COLORS.dim, 'MOVE WASD/ARROWS | DASH SPACE | RESTART R | PAUSE P | QUIT Q'), shellWidth));
  }
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
    let extraLine = '';
    if (state.mode === 'frogger' && ds) {
      const lvl = ds.level || 1;
      const slots = (ds.homeSlots || []).filter(Boolean).length;
      extraLine = center(
        `${p(COLORS.dim, 'Reached Level')} ${p(COLORS.bold + COLORS.cyan, String(lvl))}` +
        `   ${p(COLORS.dim, 'Slots')} ${p(COLORS.bold + COLORS.green, String(slots) + '/5')}`,
        shellWidth
      );
    }
    const comboLine = center(
      `${p(COLORS.dim, state.mode === 'frogger' ? 'Final Combo' : 'Final Combo')} ${p(COLORS.bold + COLORS.yellow, 'x' + finalCombo.toFixed(1))}`,
      shellWidth
    );
    const creditsLine = center(
      `${p(COLORS.dim, 'Credits Earned')} ${p(COLORS.bold + COLORS.yellow, String(finalCredits))}`,
      shellWidth
    );
    const restartMsg = center(p(COLORS.bold + COLORS.cyan, 'PRESS R TO RESTART  |  M FOR MENU'), shellWidth);
    const devMsg = center(p(COLORS.dim + COLORS.white, 'MANUAL TEST MODE: PRESS R TO INSTANTLY RESTART'), shellWidth);

    lines.push(border);
    lines.push(header);
    lines.push(border);
    lines.push(scoreLine);
    lines.push(bestLine);
    if (extraLine) lines.push(extraLine);
    lines.push(comboLine);
    lines.push(creditsLine);
    lines.push('');
    lines.push(restartMsg);
    lines.push(devMsg);
    lines.push(border);
  }

  return lines.join('\n');
}

// === MENU RENDERER ===

const MENU_MODES = ['aiHunt', 'frogger'];

function renderMenuFrame(selection = 0, options = {}) {
  const p = (code, ch) => paint(code, ch, options);
  const width = 80;
  const height = 24;
  const shellWidth = Math.max(width, 88);
  const lines = [];
  for (let i = 0; i < height; i += 1) lines.push('');

  // Title
  const title = center(p(COLORS.bold + COLORS.cyan, 'SIGNAL RUSH // TERMINAL ARCADE'), shellWidth);
  const sub = center(p(COLORS.dim + COLORS.white, '[ Presented by Temple Works ]'), shellWidth);
  const divider1 = center(p(COLORS.dim + COLORS.white, repeat('=', 64)), shellWidth);

  // Mode list
  const modeLabels = {
    aiHunt:  'AI HUNT MODE  -  survival arcade with homing hazards',
    frogger: 'FROGGER MODE  -  cross the road, ride the river, fill five slots',
  };
  const modeTaglines = {
    aiHunt:  GAME_CONFIG.modes.aiHunt.tagline,
    frogger: GAME_CONFIG.modes.frogger.tagline,
  };

  const selectionLabels = MENU_MODES.map((mode, i) => {
    const isSelected = i === selection;
    const cursor = isSelected ? p(COLORS.bold + COLORS.yellow, '> ') : '  ';
    const labelText = modeLabels[mode];
    const labelColor = isSelected
      ? (COLORS.bold + COLORS.yellow)
      : (COLORS.dim + COLORS.white);
    const label = p(labelColor, labelText);
    return cursor + label;
  });

  // Layout: title block, then 1 blank, then mode list, then 1 blank, then tagline of selected, then divider, then help
  const out = [];
  out.push('');
  out.push(title);
  out.push(sub);
  out.push('');
  out.push(divider1);
  out.push('');
  out.push(center(p(COLORS.bold + COLORS.white, 'SELECT MODE'), shellWidth));
  out.push('');
  for (const l of selectionLabels) out.push(center(l, shellWidth));
  out.push('');
  out.push(center(p(COLORS.dim + COLORS.cyan, modeTaglines[MENU_MODES[selection]]), shellWidth));
  out.push('');
  out.push(center(p(COLORS.dim + COLORS.white, repeat('-', 64)), shellWidth));
  out.push('');
  out.push(center(p(COLORS.dim, 'UP / DOWN select     ENTER launch     Q quit'), shellWidth));
  out.push('');
  out.push(center(p(COLORS.dim, 'Game controls: WASD/arrows  |  P pause  |  R restart  |  M menu'), shellWidth));
  out.push('');
  out.push(center(p(COLORS.dim + COLORS.white, repeat('=', 64)), shellWidth));

  return out.join('\n');
}

module.exports = {
  renderFrame,
  renderMenuFrame,
  visibleLength,
  paint,
  COLORS,
  MENU_MODES,
};
