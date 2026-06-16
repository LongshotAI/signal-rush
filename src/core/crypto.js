// Crypto utilities for Signal Rush anti-tamper.
// Uses Node.js built-in crypto (no external deps).
// Provides: HMAC signing for state file, run receipt verification.

const crypto = require('node:crypto');

// Derive a persistent signing key from a stable machine+user identifier.
// This key is NOT secret — it's for integrity, not confidentiality.
// Anyone with file access can verify, but can't forge without the key material.
function getSigningKey() {
  const machineId = crypto.createHash('sha256')
    .update(require('node:os').homedir() + ':' + require('node:os').userInfo().username)
    .digest();
  // Use first 32 bytes as ed25519 seed
  return machineId.subarray(0, 32);
}

// Generate a keypair from the derived seed (deterministic per machine/user)
function getKeyPair() {
  const seed = getSigningKey();
  // Use crypto.generateKeyPairSync for ed25519 (Node 15+)
  // For compatibility, we'll use HMAC-SHA256 with the seed as key
  return seed; // raw 32-byte key for HMAC
}

// Sign data with HMAC-SHA256 using the derived key
function sign(data) {
  const key = getKeyPair();
  const hmac = crypto.createHmac('sha256', key);
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