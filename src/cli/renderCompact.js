// Compact renderer for the embedded widget mode.
//
// Goal: produce a self-contained frame that fits inside a small fixed
// row budget (default 8 rows, min 4) at the bottom of a host terminal.
// The widget is a *passive observer* in the host TUI — it does not own
// the terminal. The caller (Phase C: embedded.js) is responsible for
// positioning the cursor and writing the frame to its claimed region.
//
// Three presentation modes:
//   'idle'    : title + mode chips + hint. No arena — minimal noise
//              when the user is just chatting.
//   'play'    : full arena + HUD. Used when the user is actively
//              playing during a downtime.
//   'hidden'  : caller is expected to skip rendering entirely. We still
//              produce a single blank line so the host can keep its
//              scroll region stable if it likes.
//
// The compact renderer does NOT call setRawMode. It does not process
// input. It only renders.

const { GAME_CONFIG, getTickMsForMode } = require('../config/gameConfig');
const { SPONSOR_CONTENT, getCompactLogo } = require('../content/sponsors');

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
  gray:    '\x1b[90m',
};

const ANSI_RE = /\x1b\[[0-9;]*m/g;
function visibleLength(s) { return String(s).replace(ANSI_RE, '').length; }
function padRight(s, n) {
  s = String(s);
  const pad = Math.max(0, n - visibleLength(s));
  return s + ' '.repeat(pad);
}
function center(s, n) {
  s = String(s);
  const v = visibleLength(s);
  if (v >= n) return s;
  const total = n - v;
  const l = Math.floor(total / 2);
  return ' '.repeat(l) + s + ' '.repeat(total - l);
}
function repeat(ch, n) { return new Array(Math.max(0, n)).fill(ch).join(''); }

function paint(code, ch) { return `${code}${ch}${COLORS.reset}`; }

const MODE_LABELS = {
  aiHunt:  'AI HUNT',
  // Display label for the hop-the-lanes game mode. The internal mode
  // id is still 'frogger' (a code constant) but the user-facing brand
  // is 'PACKET HOP' to avoid any association with Konami's Frogger.
  frogger: 'PACKET HOP',
};

function getSponsorSlot(state) {
  // Rotate a sponsor label per render call. The host decides how
  // often to re-render; this function is pure.
  const labels = SPONSOR_CONTENT.rotatingShellLabels;
  const i = (state && Number.isFinite(state.sponsorLabelIndex))
    ? (state.sponsorLabelIndex % labels.length)
    : 0;
  return labels[Math.max(0, i)];
}

// Build the title bar: a single line with branding + status pill +
// compact sponsor logo. Adapts to narrow widths by dropping the logo
// when there isn't enough room.

function buildTitleLine({ mode, isNewBest, width, stats, presentation }) {
  const title = paint(COLORS.bold + COLORS.cyan, '🏓 SIGNAL RUSH');
  const sep = paint(COLORS.dim, '  ·  ');
  const modeLabel = paint(COLORS.bold + COLORS.cyan, MODE_LABELS[mode] || 'AI HUNT');
  const status = isNewBest
    ? paint(COLORS.bold + COLORS.green, '★ NEW BEST')
    : (presentation === 'play'
        ? paint(COLORS.bold + COLORS.green, '● PLAYING')
        : paint(COLORS.dim + COLORS.white, 'idle'));
  // Right-aligned: "BEST 1200" or "BEST 0" + compact sponsor logo
  const logo = paint(COLORS.bold + COLORS.yellow, getCompactLogo());
  const best = paint(COLORS.dim, 'BEST ') + paint(COLORS.bold + COLORS.yellow, String(stats?.best || 0));
  // Combined: title · mode · status ... [spacer] ... best · logo
  const left = `${title}${sep}${modeLabel}${sep}${status}`;
  const leftV = visibleLength(left);
  const logoV = visibleLength(logo);
  const bestV = visibleLength(best);
  const totalRightV = bestV + logoV + 3; // "BEST N" + space + logo
  const pad = Math.max(2, width - leftV - totalRightV);

  // If the line would exceed width, drop the logo to fit
  if (leftV + totalRightV > width) {
    // Without logo: just best right-aligned
    if (leftV + bestV <= width) {
      const padNoLogo = width - leftV - bestV;
      return left + ' '.repeat(padNoLogo) + best;
    }
    // Extreme narrow: truncate
    const full = left + ' ' + best;
    if (visibleLength(full) <= width) return full;
    return full.slice(0, width);
  }

  return left + ' '.repeat(pad) + best + ' ' + logo;
}

// Build a row of mode chips. Caller can mark the active one.
function buildModeChips({ active, width }) {
  const entries = ['aiHunt', 'frogger'];
  const chips = entries.map((m) => {
    const isActive = m === active;
    const label = MODE_LABELS[m];
    if (isActive) {
      return paint(COLORS.bold + COLORS.cyan, '▸ ' + label);
    }
    return paint(COLORS.dim, '  ' + label);
  });
  const joined = chips.join(paint(COLORS.dim, '   '));
  return center(joined, width);
}

// Compact arena grid for AI Hunt.
// Maps a (row, col) subset of the full 28x56 arena down to a small box.
// We sample the full arena's rows+cols and pick the cells that fit.
function buildCompactAiHuntArena(state, rows, cols, noColor = false) {
  const p = noColor ? (code, ch) => String(ch) : paint;
  const dim = noColor ? '' : (COLORS.dim + COLORS.gray);
  const out = Array.from({ length: rows }, () => Array.from({ length: cols }, () => p(dim, '·')));
  const sr = GAME_CONFIG.height;
  const sc = GAME_CONFIG.width;
  for (let y = 0; y < rows; y += 1) {
    for (let x = 0; x < cols; x += 1) {
      const ay = Math.floor((y / rows) * sr);
      const ax = Math.floor((x / cols) * sc);
      // First pass: wall frame.
      if (y === 0 || y === rows - 1 || x === 0 || x === cols - 1) {
        out[y][x] = p(dim, '·');
      } else {
        out[y][x] = ' ';
      }
      // Pickup
      for (const pk of state.pickups || []) {
        if (Math.abs(pk.x - ax) <= Math.floor(sc / cols / 2) && Math.abs(pk.y - ay) <= Math.floor(sr / rows / 2)) {
          out[y][x] = p(noColor ? '' : (COLORS.bold + COLORS.green), '$');
        }
      }
      // Hazard
      for (const h of state.hazards || []) {
        if (Math.abs(h.x - ax) <= 1 && Math.abs(h.y - ay) <= 1) {
          out[y][x] = p(noColor ? '' : (h.kind === 'corruptor' ? (COLORS.bold + COLORS.magenta) : COLORS.red), h.kind === 'corruptor' ? 'X' : 'o');
        }
      }
      // Player
      if (state.player && Math.abs(state.player.x - ax) <= 1 && Math.abs(state.player.y - ay) <= 1) {
        const pc = state.invulnerable > 0 ? '@' : (state.moveFlash > 0 ? '#' : 'A');
        out[y][x] = p(noColor ? '' : (COLORS.bold + COLORS.white), pc);
      }
    }
  }
  return out;
}

// Compact Frogger arena. Renders lanes simplified, home slots, frog.
function buildCompactFroggerArena(state, rows, cols, noColor = false) {
  const p = noColor ? (code, ch) => String(ch) : paint;
  const dim = noColor ? '' : (COLORS.dim + COLORS.gray);
  const out = Array.from({ length: rows }, () => Array.from({ length: cols }, () => ' '));
  const lanes = (state.lanes || []).filter((l) => l.type !== 'home' && l.type !== 'median');
  // Map full arena y=0..21 to our compact rows. Top = home row.
  const SOURCE_TOP = 0;     // y=0 in source = wall
  const SOURCE_BOT = 22;    // bottom of meaningful content
  const sourceHeight = SOURCE_BOT - SOURCE_TOP;
  // Lane to compact row index.
  function laneYToCompactRow(laneY) {
    const rel = (laneY - SOURCE_TOP) / sourceHeight;
    return Math.max(0, Math.min(rows - 1, Math.floor(rel * rows)));
  }
  // For each compact row, find the corresponding source y (and lane if any).
  for (let y = 0; y < rows; y += 1) {
    const srcY = Math.floor((y / rows) * sourceHeight) + SOURCE_TOP;
    const lane = (state.lanes || []).find((l) => l.y === srcY);
    for (let x = 0; x < cols; x += 1) {
      if (y === 0 || y === rows - 1 || x === 0 || x === cols - 1) {
        out[y][x] = p(dim, '·');
        continue;
      }
      if (!lane) {
        out[y][x] = ' ';
        continue;
      }
      // Sample vehicle positions by checking if any vehicle falls in
      // this compact column's source-column range.
      const colW = GAME_CONFIG.width / (cols - 2);
      const srcX = Math.floor((x / cols) * GAME_CONFIG.width);
      if (lane.type === 'river') {
        out[y][x] = p(noColor ? '' : (COLORS.dim + COLORS.cyan), '~');
        for (const v of (lane.vehicles || [])) {
          if (Math.abs(v.x - srcX) <= Math.max(1, Math.floor(colW / 2))) {
            out[y][x] = p(noColor ? '' : (COLORS.bold + COLORS.yellow), '=');
          }
        }
      } else if (lane.type === 'road') {
        out[y][x] = p(noColor ? '' : (COLORS.dim + COLORS.white), ':');
        for (const v of (lane.vehicles || [])) {
          if (Math.abs(v.x - srcX) <= Math.max(1, Math.floor(colW / 2))) {
            out[y][x] = p(noColor ? '' : COLORS.red, lane.direction > 0 ? '>' : '<');
          }
        }
      } else if (lane.type === 'home') {
        // Show filled slots at compact column of the source x positions.
        const slotXs = GAME_CONFIG.modes.frogger.homeSlotXs;
        for (let i = 0; i < slotXs.length; i += 1) {
          if (Math.abs(slotXs[i] - srcX) <= Math.max(1, Math.floor(colW / 2))) {
            const filled = (state.homeSlots || [])[i];
            out[y][x] = p(noColor ? '' : (filled ? (COLORS.bold + COLORS.green) : (COLORS.dim + COLORS.white)), filled ? 'F' : '_');
          }
        }
      } else {
        out[y][x] = ' ';
      }
    }
  }
  // Player
  if (state.player) {
    const py = laneYToCompactRow(state.player.y);
    const px = Math.floor((state.player.x / GAME_CONFIG.width) * cols);
    if (py >= 0 && py < rows && px >= 0 && px < cols) {
      const onLog = state.onLog != null;
      out[py][px] = p(noColor ? '' : (onLog ? (COLORS.bold + COLORS.cyan) : (COLORS.bold + COLORS.green)), 'F');
    }
  }
  return out;
}

// One-line status: e.g. "Score 1200  Lives 3  Time 42"
function buildStatusLine({ mode, state, width, noColor }) {
  const p = noColor ? (c, ch) => String(ch) : paint;
  const dim = noColor ? '' : COLORS.dim;
  const cyan = noColor ? '' : (COLORS.bold + COLORS.cyan);
  const yellow = noColor ? '' : (COLORS.bold + COLORS.yellow);
  const red = noColor ? '' : (COLORS.bold + COLORS.red);
  const green = noColor ? '' : (COLORS.bold + COLORS.green);
  if (mode === 'frogger') {
    const lives = Math.max(0, state.lives || 0);
    const time = Math.max(0, state.timeLeft || 0);
    const score = state.score || 0;
    const lvl = state.level || 1;
    const t = p(time <= 10 ? red : yellow, String(time));
    return p(dim, 'LVL ') + p(cyan, String(lvl)) +
      p(dim, '  SCORE ') + p(yellow, String(score)) +
      p(dim, '  TIME ') + t +
      p(dim, '  LIVES ') + p(green, String(lives));
  }
  const score = state.score || 0;
  const hp = Math.max(0, state.player?.health || 0);
  const dash = state.dashCooldown === 0
    ? p(green, 'READY')
    : p(dim, String(state.dashCooldown));
  return p(dim, 'SCORE ') + p(yellow, String(score)) +
    p(dim, '  CHAIN ') + p(yellow, 'x' + (state.combo || 1).toFixed(1)) +
    p(dim, '  HP ') + p(hp <= 2 ? red : yellow, String(hp) + '/' + GAME_CONFIG.startHealth) +
    p(dim, '  DASH ') + dash;
}

// Build a hint line that adapts to the mode + idle/play state.
function buildHintLine({ mode, presentation, width, noColor }) {
  const p = noColor ? (c, ch) => String(ch) : paint;
  const dim = noColor ? '' : COLORS.dim;
  const accent = noColor ? '' : (COLORS.bold + COLORS.cyan);
  if (presentation === 'idle') {
    const hotkey = p(accent, 'Ctrl+S');
    return p(dim, 'Press ') + hotkey + p(dim, ' to play');
  }
  if (mode === 'frogger') {
    return p(dim, 'WASD/arrows:hop  P:pause  R:restart  Esc:return');
  }
  return p(dim, 'WASD/arrows:move  Space:dash  P:pause  R:restart  Esc:return');
}

// Public entry point.
//
// state        : engine state object (or null for header-only frames)
// presentation : 'idle' | 'play' | 'hidden'
// opts:
//   rows       : total row budget (default 8)
//   cols       : total column budget (default 80)
//   width      : alias for cols
//   isNewBest  : show "★ NEW BEST" in the title
//   stats      : { best: 0 } — best score to show in the title
//   focus      : when false, dim everything (we are backgrounded)
//   noColor    : when true, strip ANSI
function renderCompact(state, presentation, opts = {}) {
  if (presentation === 'hidden') return { lines: [''], height: 1 };
  const rows = Math.max(4, Math.min(12, Number(opts.rows) || 8));
  const cols = Math.max(40, Math.min(120, Number(opts.cols) || Number(opts.width) || 80));
  const noColor = opts.noColor === true;
  const p = noColor ? (code, ch) => String(ch) : paint;
  const dim = noColor ? '' : COLORS.dim;
  const isNewBest = opts.isNewBest === true;
  const focus = opts.focus !== false; // default: focused

  // Plan the rows.
  // Top row: title bar
  // Then arena (rows-3 total) for 'play', or 1-row mode chips for 'idle'
  // Then status (only 'play' and only if rows >= 7)
  // Bottom row: hint
  const out = [];

  // Row 0: title
  if (noColor) {
    const status = isNewBest ? '★ NEW BEST' : (presentation === 'play' ? '● PLAYING' : 'idle');
    // Right-align BEST N, mirroring the colored buildTitleLine's split-pad.
    const left = `🏓 SIGNAL RUSH · ${MODE_LABELS[state?.mode] || 'AI HUNT'} · ${status}`;
    const right = `BEST ${opts.stats?.best || 0}`;
    const pad = Math.max(2, cols - left.length - right.length);
    out.push(left + ' '.repeat(pad) + right);
  } else {
    out.push(focus ? buildTitleLine({ mode: state?.mode, isNewBest, width: cols, stats: opts.stats, presentation }) : padRight(paint(COLORS.dim, '🏓 signal-rush (paused)'), cols));
  }

  if (presentation === 'idle') {
    // Row 1: mode chips
    const activeLabel = MODE_LABELS[state?.mode] || MODE_LABELS.aiHunt;
    const otherLabel = state?.mode === 'frogger' ? MODE_LABELS.aiHunt : MODE_LABELS.frogger;
    if (noColor) {
      out.push(padRight(`▸ ${activeLabel}     ${otherLabel}`, cols));
    } else {
      out.push(buildModeChips({ active: state?.mode || 'aiHunt', width: cols }));
    }
    // Partner surface was removed per product direction. The line is
    // gone in all row budgets. The hint line and the title's BEST pill
    // carry the only persistent branding.
    // Rows 2..rows-2: blank
    while (out.length < rows - 1) out.push('');
    // Last row: hint
    out.push(buildHintLine({ mode: state?.mode, presentation: 'idle', width: cols, noColor }));
  } else {
    // play
    // Allocate rows:
    //   rows >= 8  → arena gets rows-3, status + hint bottom
    //   rows == 6-7 → arena gets rows-2, hint only at the bottom
    //                (status is sacrificed for arena fidelity)
    //   rows == 4-5 → arena gets rows-1, hint only
    const wantStatus = rows >= 8;
    const overhead = wantStatus ? 3 : 2;
    const arenaRows = Math.max(2, rows - overhead);
    const arenaCols = cols;
    let arena;
    if (state?.mode === 'frogger') arena = buildCompactFroggerArena(state, arenaRows, arenaCols, noColor);
    else arena = buildCompactAiHuntArena(state, arenaRows, arenaCols, noColor);
    for (const r of arena) out.push(r.join(''));
    if (wantStatus) {
      out.push(buildStatusLine({ mode: state?.mode, state, width: cols, noColor }));
    }
    out.push(buildHintLine({ mode: state?.mode, presentation: 'play', width: cols, noColor }));
  }
  // Trim or pad to exact rows.
  while (out.length < rows) out.push('');
  if (out.length > rows) out.length = rows;
  return { lines: out, height: out.length };
}

module.exports = {
  renderCompact,
  // Exposed for tests
  _internal: {
    buildTitleLine,
    buildModeChips,
    buildCompactAiHuntArena,
    buildCompactFroggerArena,
    buildStatusLine,
    buildHintLine,
  },
  COLORS,
};
