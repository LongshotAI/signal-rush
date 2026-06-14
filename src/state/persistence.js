// Persistent game state across sessions.
//
// Stores per-mode best scores and lifetime stats in a small JSON file.
// Atomic write: write to .tmp, then rename — so a crash mid-write
// never leaves the file half-truncated.
//
// File location: ~/.signal-rush/state.json by default, override via
// SIGNAL_RUSH_STATE env var or the explicit path argument.

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const DEFAULT_PATH = path.join(
  os.homedir(),
  '.signal-rush',
  'state.json'
);

const DEFAULTS = {
  version: 1,
  bestScores: { aiHunt: 0, frogger: 0 },
  bestLevels: { frogger: 0 },
  totalRuns: { aiHunt: 0, frogger: 0 },
  totalPickups: 0,
  totalCredits: 0,
  lastPlayedAt: null,
  lastMode: null,
};

function resolvePath(explicit) {
  if (explicit) return explicit;
  if (process.env.SIGNAL_RUSH_STATE) return process.env.SIGNAL_RUSH_STATE;
  return DEFAULT_PATH;
}

function emptyState() {
  return JSON.parse(JSON.stringify(DEFAULTS));
}

function load(filePath = resolvePath()) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    // Merge defaults so a state.json from an older schema still works.
    return {
      ...emptyState(),
      ...parsed,
      bestScores: { ...DEFAULTS.bestScores, ...(parsed.bestScores || {}) },
      bestLevels: { ...DEFAULTS.bestLevels, ...(parsed.bestLevels || {}) },
      totalRuns: { ...DEFAULTS.totalRuns, ...(parsed.totalRuns || {}) },
    };
  } catch (e) {
    if (e.code === 'ENOENT') return emptyState();
    // Corrupt file — back it up so the user can recover manually, then
    // start fresh. Don't silently swallow this: the user might be
    // running automated tooling that depends on the file.
    if (e instanceof SyntaxError) {
      try {
        const backup = filePath + '.corrupt-' + Date.now();
        fs.copyFileSync(filePath, backup);
        // Best-effort log; this code path can run before the agent
        // TUI is fully wired up.
        try { process.stderr.write(`[signal-rush] corrupt state backed up to ${backup}\n`); } catch {}
      } catch {}
      return emptyState();
    }
    throw e;
  }
}

function save(state, filePath = resolvePath()) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
  // Atomic on the same filesystem.
  fs.renameSync(tmp, filePath);
}

// Record a finished run. Returns the new state plus a flag indicating
// whether the player just set a new personal best — useful for the
// end-of-run UI to show a celebration line.
function recordRun(state, { mode, score, level }) {
  if (!mode || !['aiHunt', 'frogger'].includes(mode)) return { state, isNewBest: false };
  const safeScore = Number.isFinite(score) ? Math.max(0, Math.floor(score)) : 0;
  const safeLevel = Number.isFinite(level) ? Math.max(0, Math.floor(level)) : 0;
  const next = {
    ...state,
    bestScores: { ...state.bestScores, [mode]: Math.max(state.bestScores[mode] || 0, safeScore) },
    bestLevels: { ...state.bestLevels, [mode]: Math.max(state.bestLevels[mode] || 0, safeLevel) },
    totalRuns: { ...state.totalRuns, [mode]: (state.totalRuns[mode] || 0) + 1 },
    lastPlayedAt: new Date().toISOString(),
    lastMode: mode,
  };
  return { state: next, isNewBest: safeScore > (state.bestScores[mode] || 0) };
}

function recordPickup(state) {
  return { ...state, totalPickups: (state.totalPickups || 0) + 1 };
}

function recordCredits(state, credits) {
  return { ...state, totalCredits: (state.totalCredits || 0) + Math.max(0, credits) };
}

module.exports = {
  load,
  save,
  recordRun,
  recordPickup,
  recordCredits,
  emptyState,
  resolvePath,
  DEFAULT_PATH,
};
