// Crypto utilities for Signal Rush anti-tamper.
// Uses Node.js built-in crypto (no external deps).
// Provides: HMAC signing for state file, run receipt verification.
//
// SECURITY MODEL — IMPORTANT
// ──────────────────────────
// This module provides INTEGRITY detection, not authentication.
// The signing key is derived from a public, stable identifier
// (homedir + username), which means:
//
//   ✅ Detects: casual file editing, accidental corruption, state file
//      rollback, manual score inflation by the user themselves.
//
//   ❌ Does NOT detect: a determined attacker who knows your username
//      (e.g., from Telegram). They can recompute the key and forge
//      signatures. This is acceptable for the current single-machine,
//      single-user game model.
//
// When credits gain real value, migrate to:
//   - A real secret in the OS keychain (keytar, libsecret), OR
//   - Server-authoritative verification (client submits receipt,
//     server re-simulates and validates the claimed score).

const crypto = require('node:crypto');

// Derive a non-secret signing key from a stable machine+user identifier.
// Stable across runs (same homedir+username → same key) but NOT secret.
//
// Override: set SIGNAL_RUSH_HMAC_KEY env var to a hex-encoded 32-byte key
// for production deployments where real integrity guarantees are needed.
// When unset, falls back to the machine-derived key (casual/local use).
function getSigningKey() {
  const envKey = process.env.SIGNAL_RUSH_HMAC_KEY;
  if (envKey) {
    const buf = Buffer.from(envKey, 'hex');
    if (buf.length === 32) return buf;
    // Invalid env key length — fall back rather than crash
    try { process.stderr.write('[signal-rush] WARNING: SIGNAL_RUSH_HMAC_KEY must be 64 hex chars (32 bytes), ignoring\n'); } catch {}
  }
  const machineId = crypto.createHash('sha256')
    .update(require('node:os').homedir() + ':' + require('node:os').userInfo().username)
    .digest();
  return machineId.subarray(0, 32); // 32-byte HMAC key
}

// Return the HMAC key. Named for historical reasons (was once a keypair
// concept); now just returns the raw 32-byte key derived above.
function getKey() {
  return getSigningKey();
}

// Sign data with HMAC-SHA256 using the derived key
function sign(data) {
  const hmac = crypto.createHmac('sha256', getKey());
  hmac.update(data);
  return hmac.digest('hex');
}

// Verify HMAC signature
function verify(data, signature) {
  const expected = sign(data);
  // Constant-time comparison
  return crypto.timingSafeEqual(
    Buffer.from(signature, 'hex'),
    Buffer.from(expected, 'hex')
  );
}

// Create a run receipt that can be independently verified
// Contains everything needed to re-simulate and verify the run
function createRunReceipt({ seed, mode, inputs, finalState, finalScore, finalLevel }) {
  // Strip non-deterministic fields (rng functions, etc.) from state hash
  const cleanState = { ...finalState };
  delete cleanState.rng;
  delete cleanState.lastEvents; // event log is verbose and not needed for verification
  delete cleanState.trail; // transient visual state
  const receipt = {
    version: 1,
    timestamp: new Date().toISOString(),
    seed: seed, // Preserve original type (number or string) for re-simulation
    mode,
    inputCount: inputs.length,
    inputs: inputs, // Store full input log for re-simulation
    inputsHash: crypto.createHash('sha256').update(JSON.stringify(inputs)).digest('hex'),
    finalScore,
    finalLevel,
    finalStateHash: crypto.createHash('sha256').update(JSON.stringify(cleanState)).digest('hex'),
  };
  receipt.signature = sign(JSON.stringify(receipt));
  return receipt;
}

// Verify a run receipt by checking signature and (optionally) re-simulating
function verifyRunReceipt(receipt, { reSimulate = false, engineFactory } = {}) {
  // 1. Verify signature
  const { signature, ...receiptData } = receipt;
  if (!verify(JSON.stringify(receiptData), signature)) {
    return { valid: false, reason: 'Invalid signature' };
  }

  // 2. Optional: re-simulate to verify inputs produce claimed final state
  if (reSimulate && engineFactory) {
    try {
      const engine = engineFactory({ seed: receipt.seed, mode: receipt.mode });
      for (const input of receipt.inputs || []) {
        if (engine.state.gameOver) break;
        engine.step(input);
      }
      const simulatedScore = engine.state.score || 0;
      const simulatedLevel = engine.state.level || 1;

      if (simulatedScore !== receipt.finalScore) {
        return { valid: false, reason: `Score mismatch: simulated ${simulatedScore} vs receipt ${receipt.finalScore}`, simulatedScore, receiptScore: receipt.finalScore };
      }
      if (simulatedLevel !== receipt.finalLevel) {
        return { valid: false, reason: `Level mismatch: simulated ${simulatedLevel} vs receipt ${receipt.finalLevel}` };
      }
    } catch (e) {
      return { valid: false, reason: `Re-simulation error: ${e.message}` };
    }
  }

  return { valid: true };
}

// Hash a state object for integrity checking
function hashState(state) {
  return crypto.createHash('sha256').update(JSON.stringify(state)).digest('hex');
}

module.exports = {
  sign,
  verify,
  createRunReceipt,
  verifyRunReceipt,
  hashState,
  getSigningKey,
};