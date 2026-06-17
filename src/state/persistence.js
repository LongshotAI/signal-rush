// Persistent game state across sessions.
// Persistent game state across sessions.
// Stores per-mode best scores and lifetime stats in a small JSON file.
// Atomic write: write to .tmp, then rename — so a crash mid-write
// never leaves the file half-truncated.
//
// File location: ~/.signal-rush/state.json by default, override via
// SIGNAL_RUSH_STATE env var or the explicit path argument.
//
// INTEGRITY: State file is HMAC-signed to detect tampering.
// Run receipts are stored for each completed run to enable verification.

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const cryptoUtil = require('../core/crypto');

const DEFAULT_PATH = path.join(
  os.homedir(),
  '.signal-rush',
  'state.json'
);

const DEFAULTS = {
  version: 2, // v2 adds HMAC signature and run receipts
  bestScores: { aiHunt: 0, frogger: 0 },
  bestLevels: { frogger: 0 },
  totalRuns: { aiHunt: 0, frogger: 0 },
  totalPickups: 0,
  totalCredits: 0,
  lastPlayedAt: null,
  lastMode: null,
  // Integrity
  signature: null,
  // Run history for verification (last 50 runs)
  runReceipts: [],
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
    const merged = {
      ...emptyState(),
      ...parsed,
      bestScores: { ...DEFAULTS.bestScores, ...(parsed.bestScores || {}) },
      bestLevels: { ...DEFAULTS.bestLevels, ...(parsed.bestLevels || {}) },
      totalRuns: { ...DEFAULTS.totalRuns, ...(parsed.totalRuns || {}) },
    };
    // Verify signature if present (v2+)
    if (merged.version >= 2 && merged.signature) {
      const { signature, ...dataToVerify } = merged;
      const isValid = cryptoUtil.verify(JSON.stringify(dataToVerify), signature);
      if (!isValid) {
        // Tampering detected — back up and return empty state
        try {
          const backup = filePath + '.tampered-' + Date.now();
          fs.copyFileSync(filePath, backup);
          process.stderr.write(`[signal-rush] STATE TAMPERING DETECTED — backed up to ${backup}\n`);
        } catch {}
        return emptyState();
      }
    }
    return merged;
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

function signState(state) {
  const { signature, ...dataToSign } = state;
  return cryptoUtil.sign(JSON.stringify(dataToSign));
}

function save(state, filePath = resolvePath()) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  // Merge with defaults first so signature covers the full persisted shape
  const fullState = {
    ...emptyState(),
    ...state,
  };
  // Sign the state before saving (sign without the signature field itself)
  const signedState = { ...fullState, signature: signState(fullState) };
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(signedState, null, 2), 'utf8');
  // Atomic on the same filesystem.
  fs.renameSync(tmp, filePath);
}

// Record a finished run. Returns the new state plus a flag indicating
// whether the player just set a new personal best — useful for the
// end-of-run UI to show a celebration line.
// Also creates a cryptographic run receipt for verification.
function recordRun(state, { mode, score, level, seed, inputs, finalState }) {
  if (!mode || !['aiHunt', 'frogger'].includes(mode)) return { state, isNewBest: false, receipt: null };
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
  // Create run receipt if we have the data
  let receipt = null;
  if (seed != null && inputs && finalState) {
    receipt = cryptoUtil.createRunReceipt({
      seed,
      mode,
      inputs,
      finalState,
      finalScore: safeScore,
      finalLevel: safeLevel,
    });
    // Store receipt (keep last 50)
    next.runReceipts = [receipt, ...(next.runReceipts || [])].slice(0, 50);
  }
  return { state: next, isNewBest: safeScore > (state.bestScores[mode] || 0), receipt };
}

function recordPickup(state) {
  return { ...state, totalPickups: (state.totalPickups || 0) + 1 };
}

// NOTE: recordCredits() has been removed. The old JSON-based totalCredits
// field was never wired up and is superseded by the economy.db SQLite ledger
// (see economy/ledger.js). Credit mutations go through economy/service.js.

module.exports = {
  load,
  save,
  recordRun,
  recordPickup,
  emptyState,
  resolvePath,
  DEFAULT_PATH,
  // Crypto utilities for external verification
  verifyRunReceipt: cryptoUtil.verifyRunReceipt,
  hashState: cryptoUtil.hashState,
};
