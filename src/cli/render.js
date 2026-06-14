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

const PRESENTED_BY = 'Presented by USP x Temple Works';

// How many game ticks correspond to one "second" of the GET READY
// countdown. The config sets getReadyTicks to 30, so each visible
// number covers ~10 ticks. Tweak in one place if the cadence changes.
function getFroggerSecondsDivisor() {
  return 10;
}

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

  // Visual-only danger halos make enemy pressure readable at a glance.
  // They mark the one-cell near-miss zone without changing collision rules.
  //
  // Two passes:
  //   1. Count how many hazards have each empty cell in their halo (the
  //      "overlap count") and the minimum Manhattan distance from any
  //      contributing hazard to the player. The count drives the glyph
  //      ramp (1 -> dim, 2 -> mid, 3+ -> hot); the distance tints the
  //      glyph hotter when the overlap is close to the player. This is
  //      what the bar's discrete THREAT tier is rendering spatially.
  //   2. Paint exactly once per cell. The previous "last write wins" loop
  //      would silently drop a halo on top of a previously-painted halo;
  //      now overlap compounds visually instead of being lost.
  const halo = new Map(); // key = "x,y" -> { count, minDistToPlayer }
  for (const hazard of state.hazards) {
    const haloCells = [
      { x: hazard.x + 1, y: hazard.y },
      { x: hazard.x - 1, y: hazard.y },
      { x: hazard.x, y: hazard.y + 1 },
      { x: hazard.x, y: hazard.y - 1 },
    ];
    const dist = Math.abs(hazard.x - state.player.x) + Math.abs(hazard.y - state.player.y);
    for (const cell of haloCells) {
      if (cell.x <= 0 || cell.x >= GAME_CONFIG.width - 1 || cell.y <= 0 || cell.y >= GAME_CONFIG.height - 1) continue;
      const key = cell.x + ',' + cell.y;
      const existing = halo.get(key);
      if (existing) {
        existing.count += 1;
        if (dist < existing.minDistToPlayer) existing.minDistToPlayer = dist;
      } else {
        halo.set(key, { count: 1, minDistToPlayer: dist });
      }
    }
  }
  for (const [key, info] of halo) {
    const [xStr, yStr] = key.split(',');
    const cx = Number(xStr);
    const cy = Number(yStr);
    if (grid[cy][cx] !== ' ') continue; // don't overwrite walls, pickups, enemies
    let glyph;
    let color;
    if (info.count >= 3) {
      glyph = '!';
      color = COLORS.bold + COLORS.red;
    } else if (info.count === 2) {
      glyph = ':';
      color = info.minDistToPlayer <= 2 ? (COLORS.bold + COLORS.yellow) : (COLORS.dim + COLORS.yellow);
    } else {
      glyph = '·';
      color = info.minDistToPlayer <= 2 ? (COLORS.dim + COLORS.red) : (COLORS.dim + COLORS.white);
    }
    grid[cy][cx] = p(color, glyph);
  }

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
    // Lives: numeric value first (so partners / spectators can read the
    // count at a glance), then the dot pattern for a glanceable game
    // status. Numeric first because a single "1" beats a 5-char glyph
    // when the player is mid-jump and the screen is moving.
    const livesNum = Math.max(0, state.lives);
    return (
      `${p(COLORS.dim, 'LVL')} ${p(COLORS.bold + COLORS.cyan, String(state.level))}` +
      `   ${p(COLORS.dim, 'SCORE')} ${p(COLORS.bold + COLORS.yellow, String(state.score))}` +
      `   ${p(COLORS.dim, 'TIME')} ${p(timeColor, String(Math.max(0, state.timeLeft)))}` +
      `   ${p(COLORS.dim, 'LIVES')} ${p(COLORS.bold + COLORS.green, String(livesNum))}`
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
  const riskText = state.nearMissStreak > 0
    ? `   ${p(COLORS.dim, 'RISK')} ${p(COLORS.bold + COLORS.magenta, 'x' + state.nearMissStreak)}`
    : '';
  return (
    `${p(COLORS.dim, 'DASH')} ${dashText}` +
    riskText +
    `   ${p(COLORS.dim, 'CREDITS')} ${p(COLORS.bold + COLORS.yellow, String(state.credits))}` +
    `   ${p(COLORS.dim, 'BEST')} ${p(COLORS.bold + COLORS.yellow, String(state.bestScore))}`
  );
}

function buildFroggerGoalBar(state, options = {}) {
  // Always-visible goal indicator for Frogger mode. The home row sits
  // at the very top of the arena (y=1), so on small terminals it gets
  // clipped and the player has no idea what they're hopping toward.
  // This bar lives in the header above the arena, where the HUD lives,
  // so it's never scrolled off.
  const p = (code, ch) => paint(code, ch, options);
  const homeSlots = state.homeSlots || [false, false, false, false, false];
  const filled = homeSlots.filter(Boolean).length;
  // Per-slot chip: bold green F (filled) or dim underscore (empty),
  // separated by spaces so they're readable even without ANSI colour.
  const slotChips = homeSlots.map((isFilled) =>
    isFilled
      ? p(COLORS.bold + COLORS.green, 'F')
      : p(COLORS.dim + COLORS.white, '_')
  );
  const slotStr = '[' + slotChips.join(' ') + ']';
  const timeColor = state.timeLeft <= 10
    ? (COLORS.bold + COLORS.red)
    : (COLORS.bold + COLORS.yellow);
  const lives = Math.max(0, state.lives || 0);
  const maxLives = Math.max(0, state.maxLives || 0);
  const livesStr = 'F'.repeat(lives) + '.'.repeat(Math.max(0, maxLives - lives));
  return (
    p(COLORS.bold + COLORS.cyan, 'GOAL ') +
    slotStr +
    ' ' +
    p(COLORS.dim + COLORS.cyan, filled + '/5') +
    p(COLORS.dim, '   |   ') +
    p(COLORS.dim, 'SCORE ') + p(COLORS.bold + COLORS.yellow, String(state.score || 0)) +
    p(COLORS.dim, '   TIME ') + p(timeColor, String(Math.max(0, state.timeLeft || 0))) +
    p(COLORS.dim, '   LIVES ') + p(COLORS.bold + COLORS.green, livesStr)
  );
}

function buildAiHuntMissionBar(state, options = {}) {
  const p = (code, ch) => paint(code, ch, options);
  const hp = Math.max(0, state.player && typeof state.player.health === 'number' ? state.player.health : 0);
  const maxHp = GAME_CONFIG.startHealth;
  const hpPips = '█'.repeat(Math.min(hp, maxHp)) + '░'.repeat(Math.max(0, maxHp - hp));
  const hpColor = hp <= 2 ? (COLORS.bold + COLORS.red) : (COLORS.bold + COLORS.green);
  const maxThreat = GAME_CONFIG.hazardRamp && GAME_CONFIG.hazardRamp.max ? GAME_CONFIG.hazardRamp.max : 12;
  const threat = Array.isArray(state.hazards) ? state.hazards.length : 0;
  const threatColor = threat >= Math.ceil(maxThreat * 0.75)
    ? (COLORS.bold + COLORS.red)
    : threat >= Math.ceil(maxThreat * 0.4)
      ? (COLORS.bold + COLORS.yellow)
      : (COLORS.bold + COLORS.cyan);
  const risk = state.nearMissStreak > 0
    ? p(COLORS.dim, '   |   RISK ') + p(COLORS.bold + COLORS.magenta, 'x' + state.nearMissStreak)
    : '';
  return (
    p(COLORS.bold + COLORS.cyan, 'MISSION ') +
    p(COLORS.dim + COLORS.white, 'SURVIVE') +
    p(COLORS.dim, '   |   COLLECT ') + p(COLORS.bold + COLORS.green, '$') +
    p(COLORS.dim, '   |   CHAIN ') + p(COLORS.bold + COLORS.yellow, 'x' + state.combo.toFixed(1)) +
    p(COLORS.dim, '   |   HP ') + p(hpColor, '[' + hpPips + ']') +
    p(COLORS.dim, '   |   THREAT ') + p(threatColor, `${threat}/${maxThreat}`) +
    risk
  );
}

function renderFrame(state, viewport = { columns: 100, rows: 40 }, options = {}) {
  const p = (code, ch) => paint(code, ch, options);
  const width = Math.max(80, viewport.columns || 100);
  const arenaLines = buildArena(state, options);
  const shellWidth = Math.max(width, GAME_CONFIG.width + 8);
  const sponsorLabel = `[ ${getSponsorLabel(state)} ]`;
  // Display label for the hop-the-lanes mode. Internal mode id stays
  // 'frogger' (code constant), but user-facing title is rebranded to
  // avoid any association with Konami's Frogger trademark.
  const modeTag = state.mode === 'frogger' ? 'PACKET HOP' : 'AI HUNT';
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
  lines.push(center(p(COLORS.dim + COLORS.cyan, PRESENTED_BY), shellWidth));
  lines.push(sponsor);
  lines.push(repeat('=', shellWidth));
  lines.push(combinedHud);
  if (state.mode === 'frogger') {
    // Always-visible GOAL bar: the home row sits at the very top of the
    // arena and gets clipped on small terminals, leaving the player with
    // no idea what they're hopping toward. The bar lives in the header
    // above the arena so it's never scrolled off, and explicitly shows
    // the 5 home slots (filled vs empty), score, time, and lives.
    lines.push(center(buildFroggerGoalBar(state, options), shellWidth));
  } else {
    lines.push(center(buildAiHuntMissionBar(state, options), shellWidth));
  }
  lines.push(repeat('-', shellWidth));

  // When the run is over, replace the live arena with a compact summary
  // card. The previous design rendered the full arena AND the game-over
  // card stacked, which on a default 40-row terminal pushed the score,
  // combo, and restart prompt off the bottom of the screen — players
  // never saw the actual end-of-run stats. The "RIDGE" approach below
  // shaves the arena down to a small decorative title row so the card
  // sits in view on any 40+ row terminal.
  if (state.gameOver) {
    // One centered "RUN ENDED" banner in the arena slot.
    lines.push(center(p(COLORS.dim + COLORS.white, '· · ·  R U N   E N D E D  · · ·'), shellWidth));
  } else {
    for (const row of arenaLines) {
      lines.push(center(row, shellWidth));
    }
  }

  // GET READY overlay — show a big countdown centered on the arena when
  // the level hasn't started yet. We splice it in just below the arena
  // (between arena and the message line) so the whole frame stays
  // predictable in height.
  if (state.mode === 'frogger' && typeof state.getReadyTicks === 'number' && state.getReadyTicks > 0) {
    const seconds = Math.max(0, Math.ceil(state.getReadyTicks / getFroggerSecondsDivisor()));
    // Show "GO!" the instant the countdown ends instead of a misleading
    // "0…" — the old code showed "GET READY — 0…" for the final sub-second
    // which read as "the timer never started" to first-time players.
    const readyText = seconds > 0
      ? `GET READY — ${seconds}…`
      : 'GO!';
    lines.push(center(p(COLORS.bold + COLORS.yellow, readyText), shellWidth));
  }

  lines.push('');
  lines.push(center(state.message, shellWidth));
  if (state.mode === 'frogger') {
    lines.push(center(p(COLORS.dim, 'FROG=F  LOG==  WATER=~  CAR=><  HOME=_  FILLED=F  GRASS=.'), shellWidth));
    lines.push(center(p(COLORS.dim, 'MOVE WASD/ARROWS | PAUSE P | RESTART R | QUIT Q'), shellWidth));
  } else {
    lines.push(center(p(COLORS.dim, 'SHIP=A  MOVE=#  INPUT=W  TRAIL=:-|  WARNING=!  ENEMY=o  HEAVY=X  SIGNAL=$'), shellWidth));
    lines.push(center(p(COLORS.dim, 'MOVE WASD/ARROWS | DASH SPACE | RESTART R | PAUSE P | QUIT Q'), shellWidth));
  }

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

    // Compact the game-over card so it fits inside a default 40-row
    // terminal viewport. The previous layout had blank lines between
    // every block and a redundant dev-only "MANUAL TEST MODE" line that
    // pushed the bottom prompt off-screen.
    lines.push(border);
    lines.push(header);
    lines.push(border);
    lines.push(scoreLine);
    lines.push(bestLine);
    if (extraLine) lines.push(extraLine);
    lines.push(comboLine);
    lines.push(creditsLine);
    lines.push(restartMsg);
    lines.push(border);
  }

  return lines.join('\n');
}

// === MINI ARENA PREVIEW (used by the start menu) ===
//
// A small, hand-composed snapshot of each mode's visual language so the
// menu reads as part of the same world as the game itself — same tiles,
// same colors, same walls, same vibe.

function buildMiniArenaPreview(mode, options = {}) {
  const p = (code, ch) => paint(code, ch, options);
  const width = 18;
  const height = 9;
  const grid = [];
  for (let i = 0; i < height; i += 1) {
    grid.push(Array.from({ length: width }, () => ' '));
  }
  // Walls
  for (let x = 0; x < width; x += 1) {
    grid[0][x] = p(COLORS.dim + COLORS.white, '-');
    grid[height - 1][x] = p(COLORS.dim + COLORS.white, '-');
  }
  for (let y = 0; y < height; y += 1) {
    grid[y][0] = p(COLORS.dim + COLORS.white, '|');
    grid[y][width - 1] = p(COLORS.dim + COLORS.white, '|');
  }
  grid[0][0] = p(COLORS.dim + COLORS.white, '+');
  grid[0][width - 1] = p(COLORS.dim + COLORS.white, '+');
  grid[height - 1][0] = p(COLORS.dim + COLORS.white, '+');
  grid[height - 1][width - 1] = p(COLORS.dim + COLORS.white, '+');

  if (mode === 'frogger') {
    // Row 1 = home with one filled slot
    for (let x = 1; x < width - 1; x += 1) grid[1][x] = p(COLORS.dim + COLORS.white, '_');
    grid[1][4] = p(COLORS.bold + COLORS.green, 'F');
    grid[1][10] = p(COLORS.bold + COLORS.green, 'F');
    // Rows 2-3 = river with logs
    for (let x = 1; x < width - 1; x += 1) grid[2][x] = p(COLORS.dim + COLORS.cyan, '~');
    grid[2][3] = p(COLORS.bold + COLORS.yellow, '=');
    grid[2][4] = p(COLORS.bold + COLORS.yellow, '=');
    grid[2][5] = p(COLORS.bold + COLORS.yellow, '=');
    grid[2][12] = p(COLORS.bold + COLORS.yellow, '=');
    for (let x = 1; x < width - 1; x += 1) grid[3][x] = p(COLORS.dim + COLORS.cyan, '~');
    grid[3][7] = p(COLORS.bold + COLORS.yellow, '=');
    grid[3][8] = p(COLORS.bold + COLORS.yellow, '=');
    grid[3][9] = p(COLORS.bold + COLORS.yellow, '=');
    // Row 4 = median (safe grass)
    for (let x = 1; x < width - 1; x += 1) grid[4][x] = p(COLORS.dim + COLORS.green, '.');
    // Rows 5-6 = road with cars
    for (let x = 1; x < width - 1; x += 1) grid[5][x] = p(COLORS.dim + COLORS.white, ':');
    grid[5][2] = p(COLORS.red, '>');
    grid[5][3] = p(COLORS.red, '>');
    grid[5][11] = p(COLORS.red, '>');
    grid[5][12] = p(COLORS.red, '>');
    grid[5][13] = p(COLORS.red, '>');
    for (let x = 1; x < width - 1; x += 1) grid[6][x] = p(COLORS.dim + COLORS.white, ':');
    grid[6][4] = p(COLORS.red, '<');
    grid[6][5] = p(COLORS.red, '<');
    grid[6][14] = p(COLORS.red, '<');
    // Row 7 = safe median
    for (let x = 1; x < width - 1; x += 1) grid[7][x] = p(COLORS.dim + COLORS.green, '.');
    // Frog on the bottom median
    grid[7][9] = p(COLORS.bold + COLORS.green, 'F');
  } else {
    // AI Hunt: pickups, hazards, player, trail
    grid[1][3] = p(COLORS.bold + COLORS.green, '$');
    grid[1][10] = p(COLORS.bold + COLORS.green, '$');
    grid[1][15] = p(COLORS.bold + COLORS.green, '$');
    grid[2][6] = p(COLORS.red, 'o');
    grid[2][13] = p(COLORS.red, 'o');
    grid[3][2] = p(COLORS.red, 'o');
    grid[3][9] = p(COLORS.bold + COLORS.magenta, 'X');
    grid[3][14] = p(COLORS.red, 'o');
    grid[4][4] = p(COLORS.dim + COLORS.cyan, ':');
    grid[4][5] = p(COLORS.dim + COLORS.cyan, '-');
    grid[4][6] = p(COLORS.dim + COLORS.cyan, ':');
    grid[5][7] = p(COLORS.bold + COLORS.white, 'A');
    grid[6][5] = p(COLORS.red, 'o');
    grid[6][12] = p(COLORS.bold + COLORS.green, '$');
    grid[7][2] = p(COLORS.bold + COLORS.green, '$');
    grid[7][9] = p(COLORS.red, 'o');
  }
  return grid.map((row) => row.join(''));
}

// === MENU RENDERER ===

const MENU_MODES = ['aiHunt', 'frogger'];

function renderMenuFrame(selection = 0, options = {}) {
  const p = (code, ch) => paint(code, ch, options);
  const outerWidth = 78;
  const innerWidth = outerWidth - 2;  // for the ┃ borders
  const selectedMode = MENU_MODES[selection] || 'aiHunt';
  const modeLabels = {
    aiHunt:  'AI HUNT MODE',
    frogger: 'PACKET HOP MODE',  // rebranded: was 'FROGGER MODE'
  };
  const modeSubtitles = {
    aiHunt:  'survival arcade with homing hazards',
    frogger: 'cross the road, ride the river, fill five slots',
  };
  const modeTaglines = {
    aiHunt:  GAME_CONFIG.modes.aiHunt.tagline,
    frogger: GAME_CONFIG.modes.frogger.tagline,
  };
  const modeStats = {
    aiHunt:  'HP 8   •   DASH   •   CHAIN   •   CREDITS',
    frogger: 'LIVES 3   •   TIME 60s   •   SLOTS 5   •   COMBO',
  };

  const hbar = repeat('━', innerWidth);
  const dbar = repeat('═', innerWidth);
  const topBorder    = '┏' + hbar + '┓';
  const sepBorder    = '┣' + hbar + '┫';
  const botBorder    = '┗' + hbar + '┛';
  const dblTopBorder = '╔' + dbar + '╗';
  const dblBotBorder = '╚' + dbar + '╝';

  // Pad a content string to the inner width and wrap it in a ┃ border.
  function framed(content) {
    const vlen = visibleLength(content);
    const pad = Math.max(0, innerWidth - vlen);
    return '┃' + content + repeat(' ', pad) + '┃';
  }
  function dblFramed(content) {
    const vlen = visibleLength(content);
    const pad = Math.max(0, innerWidth - vlen);
    return '║' + content + repeat(' ', pad) + '║';
  }
  // Same as dblFramed but centers the content within the frame.
  function dblFramedCentered(content) {
    const vlen = visibleLength(content);
    const totalPad = Math.max(0, innerWidth - vlen);
    const left = Math.floor(totalPad / 2);
    const right = totalPad - left;
    return '║' + repeat(' ', left) + content + repeat(' ', right) + '║';
  }

  const out = [];
  // Top branding block — double-line frame for the title.
  out.push(dblTopBorder);
  out.push(dblFramed(''));
  out.push(dblFramedCentered(
    p(COLORS.bold + COLORS.cyan, 'S I G N A L    R U S H') +
    '   ' +
    p(COLORS.dim + COLORS.cyan, '// TERMINAL ARCADE')
  ));
  out.push(dblFramed(''));
  // Decorative rule under the title
  out.push(dblFramedCentered(p(COLORS.dim + COLORS.cyan, repeat('·', 24))));
  out.push(dblFramed(''));
  out.push(dblFramedCentered(
    p(COLORS.dim + COLORS.white, '> > >') +
    '  ' +
    p(COLORS.bold + COLORS.white, 'P R E S E N T E D   B Y') +
    '  ' +
    p(COLORS.dim + COLORS.white, '< < <')
  ));
  out.push(dblFramed(''));
  out.push(dblFramedCentered(
    p(COLORS.bold + COLORS.yellow, '★  ') +
    p(COLORS.bold + COLORS.white, 'U S P') +
    p(COLORS.bold + COLORS.yellow, '  ×  ') +
    p(COLORS.bold + COLORS.white, 'T E M P L E   W O R K S') +
    p(COLORS.bold + COLORS.yellow, '  ★')
  ));
  out.push(dblFramed(''));
  out.push(dblBotBorder);

  // Mode selector + mini arena preview, side by side.
  out.push(sepBorder);
  out.push(framed(''));
  out.push(framed(
    p(COLORS.bold + COLORS.cyan, 'SELECT MODE') +
    p(COLORS.dim, '  ·  ') +
    p(COLORS.dim + COLORS.cyan, modeSubtitles[selectedMode])
  ));
  out.push(framed(''));

  // Render the mode list and the mini preview as parallel columns.
  const previewLines = buildMiniArenaPreview(selectedMode, options);
  // Mode list lines (we show both options, the selected one with a cursor + highlight).
  const labelFor = (i) => {
    const isSelected = i === selection;
    const tag = isSelected
      ? p(COLORS.bold + COLORS.yellow, '▶ ' + modeLabels[MENU_MODES[i]])
      : p(COLORS.dim + COLORS.white, '  ' + modeLabels[MENU_MODES[i]]);
    const sub = isSelected
      ? p(COLORS.dim + COLORS.cyan, '  ' + modeSubtitles[MENU_MODES[i]])
      : p(COLORS.dim, '  ' + modeSubtitles[MENU_MODES[i]]);
    return { tag, sub };
  };
  const modeLine0 = labelFor(0);
  const modeLine1 = labelFor(1);

  // Build the side-by-side rows: each row has [preview] + [mode list fragment].
  const leftCol  = '  ' + p(COLORS.dim + COLORS.white, '▌');   // left rail with thin bar
  const middle   = ' ';                                          // gap between preview and mode list
  const rows = [];
  // Row 0: top of preview + mode line 0
  rows.push(framed(leftCol + previewLines[0] + middle + modeLine0.tag));
  // Row 1: row 1 of preview + mode line 0 subtitle
  rows.push(framed(leftCol + previewLines[1] + middle + modeLine0.sub));
  // Row 2: row 2 of preview + blank
  rows.push(framed(leftCol + previewLines[2] + middle));
  // Row 3: row 3 of preview + mode line 1 (with cursor)
  rows.push(framed(leftCol + previewLines[3] + middle + modeLine1.tag));
  // Row 4: row 4 of preview + mode line 1 subtitle
  rows.push(framed(leftCol + previewLines[4] + middle + modeLine1.sub));
  // Rows 5..end: rest of preview
  for (let y = 5; y < previewLines.length; y += 1) {
    rows.push(framed(leftCol + previewLines[y] + middle));
  }
  for (const r of rows) out.push(r);

  out.push(framed(''));
  out.push(sepBorder);
  out.push(framed(''));
  out.push(framed(
    p(COLORS.dim, 'MODE OVERVIEW — ') +
    p(COLORS.bold + COLORS.cyan, modeLabels[selectedMode])
  ));
  out.push(framed(''));
  // Word-wrap the tagline into lines that fit.
  const tagline = modeTaglines[selectedMode];
  const taglineLines = wrapText(tagline, innerWidth - 4);
  for (const line of taglineLines) {
    out.push(framed('  ' + p(COLORS.dim + COLORS.cyan, line)));
  }
  out.push(framed(''));
  out.push(framed('  ' + p(COLORS.dim + COLORS.yellow, modeStats[selectedMode])));
  out.push(framed(''));
  out.push(botBorder);

  // Controls + footer (under the framed block).
  out.push('');
  out.push(center(
    p(COLORS.bold + COLORS.cyan, '↑ ↓') + p(COLORS.dim, '  /  ') +
    p(COLORS.bold + COLORS.cyan, 'W S') + p(COLORS.dim, '  /  ') +
    p(COLORS.bold + COLORS.cyan, 'K J') + p(COLORS.dim, '  select     ') +
    p(COLORS.bold + COLORS.cyan, 'ENTER') + p(COLORS.dim, '  launch     ') +
    p(COLORS.bold + COLORS.cyan, 'Q') + p(COLORS.dim, '  quit'),
    outerWidth + 4
  ));
  out.push(center(
    p(COLORS.dim, 'Game controls:  ') +
    p(COLORS.bold + COLORS.white, 'WASD/arrows') + p(COLORS.dim, '  move   ') +
    p(COLORS.bold + COLORS.white, 'SPACE') + p(COLORS.dim, '  dash   ') +
    p(COLORS.bold + COLORS.white, 'P') + p(COLORS.dim, '  pause   ') +
    p(COLORS.bold + COLORS.white, 'R') + p(COLORS.dim, '  restart   ') +
    p(COLORS.bold + COLORS.white, 'M') + p(COLORS.dim, '  menu'),
    outerWidth + 4
  ));
  out.push('');
  out.push(center(
    p(COLORS.dim + COLORS.white, '© 2026 ') +
    p(COLORS.bold + COLORS.white, 'U S P') +
    p(COLORS.dim + COLORS.yellow, '  ×  ') +
    p(COLORS.bold + COLORS.white, 'T E M P L E   W O R K S') +
    p(COLORS.dim + COLORS.white, '   //   ') +
    p(COLORS.dim + COLORS.cyan, 'SIGNAL RUSH TERMINAL ARCADE'),
    outerWidth + 4
  ));

  return out.join('\n');
}

function wrapText(text, maxWidth) {
  const words = String(text).split(/\s+/);
  const lines = [];
  let current = '';
  for (const w of words) {
    if (!current) {
      current = w;
      continue;
    }
    if (current.length + 1 + w.length <= maxWidth) {
      current += ' ' + w;
    } else {
      lines.push(current);
      current = w;
    }
  }
  if (current) lines.push(current);
  return lines;
}

module.exports = {
  renderFrame,
  renderMenuFrame,
  buildMiniArenaPreview,
  buildFroggerGoalBar,
  buildAiHuntMissionBar,
  visibleLength,
  paint,
  COLORS,
  MENU_MODES,
  PRESENTED_BY,
};
