// Anti-cheat mitigation tests for Signal Rush.
// Proves: state file integrity, run receipts, and verification.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const cryptoUtil = require('../src/core/crypto');
const persistence = require('../src/state/persistence');
const { createEngine } = require('../src/core/engine');

const TEST_PATH = path.join(os.tmpdir(), 'signal-rush-anticheat-test-' + Date.now() + '.json');

function cleanup() {
  try { fs.unlinkSync(TEST_PATH); } catch {}
  try { fs.unlinkSync(TEST_PATH + '.tampered-' + Date.now()); } catch {}
}

function testHMACSigningAndVerification() {
  console.log('Testing: HMAC signing and verification...');
  const data = JSON.stringify({ test: 'data', value: 42 });
  const signature = cryptoUtil.sign(data);
  assert(cryptoUtil.verify(data, signature), 'Valid signature should verify');
  assert(!cryptoUtil.verify(data + 'tampered', signature), 'Tampered data should not verify');
  console.log('  PASS');
}

function testStateFileIntegrity() {
  console.log('Testing: State file HMAC integrity...');
  const state = {
    version: 2,
    bestScores: { aiHunt: 1500, frogger: 800 },
    bestLevels: { frogger: 5 },
    totalRuns: { aiHunt: 10, frogger: 3 },
    totalPickups: 42,
    totalCredits: 100,
    lastPlayedAt: new Date().toISOString(),
    lastMode: 'aiHunt',
  };
  // Save with signature
  persistence.save(state, TEST_PATH);
  assert(fs.existsSync(TEST_PATH), 'State file should exist after save');
  // Load and verify
  const loaded = persistence.load(TEST_PATH);
  assert.equal(loaded.bestScores.aiHunt, 1500, 'Best score should match after load');
  assert.equal(loaded.totalPickups, 42, 'Total pickups should match');
  console.log('  PASS');
}

function testStateTamperingDetected() {
  console.log('Testing: State tampering detection...');
  // Save valid state
  const state = {
    version: 2,
    bestScores: { aiHunt: 1000, frogger: 500 },
    bestLevels: { frogger: 2 },
    totalRuns: { aiHunt: 5, frogger: 1 },
    totalPickups: 20,
    totalCredits: 50,
    lastPlayedAt: new Date().toISOString(),
    lastMode: 'aiHunt',
  };
  persistence.save(state, TEST_PATH);
  // Tamper with the file
  const raw = fs.readFileSync(TEST_PATH, 'utf8');
  const parsed = JSON.parse(raw);
  parsed.bestScores.aiHunt = 999999; // Cheat attempt
  fs.writeFileSync(TEST_PATH, JSON.stringify(parsed, null, 2), 'utf8');
  // Load should detect tampering and return empty state
  const loaded = persistence.load(TEST_PATH);
  assert.equal(loaded.bestScores.aiHunt, 0, 'Tampered state should reset to defaults');
  assert.equal(loaded.totalPickups, 0, 'Tampered state should have zero pickups');
  console.log('  PASS');
}

function testRunReceiptCreation() {
  console.log('Testing: Run receipt creation...');
  const engine = createEngine({ mode: 'aiHunt', seed: 12345 });
  const inputs = [];
  for (let i = 0; i < 50; i += 1) {
    const input = i % 10 === 0 ? { move: { x: 1, y: 0 }, dash: true } : { move: { x: 1, y: 0 } };
    inputs.push(input);
    engine.step(input);
    if (engine.state.gameOver) break;
  }
  const receipt = cryptoUtil.createRunReceipt({
    seed: 12345,
    mode: 'aiHunt',
    inputs,
    finalState: { ...engine.state },
    finalScore: engine.state.score,
    finalLevel: engine.state.level || 1,
  });
  assert(receipt.signature, 'Receipt should have a signature');
  assert.equal(receipt.seed, 12345, 'Receipt should preserve seed type');
  assert.equal(receipt.mode, 'aiHunt', 'Receipt should store mode');
  assert.equal(receipt.inputCount, inputs.length, 'Receipt should store input count');
  assert(receipt.inputsHash, 'Receipt should store input hash');
  assert(receipt.finalStateHash, 'Receipt should store final state hash');
  console.log('  PASS');
}

function testRunReceiptVerification() {
  console.log('Testing: Run receipt verification...');
  const engine = createEngine({ mode: 'aiHunt', seed: 999 });
  const inputs = [{ move: { x: 1, y: 0 } }, { move: { x: 1, y: 0 } }, { move: { x: 0, y: 1 } }];
  for (const input of inputs) engine.step(input);
  const receipt = cryptoUtil.createRunReceipt({
    seed: 999,
    mode: 'aiHunt',
    inputs,
    finalState: { ...engine.state },
    finalScore: engine.state.score,
    finalLevel: engine.state.level || 1,
  });
  // Verify without re-simulation (just signature)
  let result = cryptoUtil.verifyRunReceipt(receipt);
  assert(result.valid, 'Valid receipt should verify');
  // Verify with re-simulation
  result = cryptoUtil.verifyRunReceipt(receipt, {
    reSimulate: true,
    engineFactory: (opts) => createEngine(opts),
  });
  assert(result.valid, 'Valid receipt should verify with re-simulation');
  console.log('  PASS');
}

function testRunReceiptTamperingDetected() {
  console.log('Testing: Receipt tampering detection...');
  const engine = createEngine({ mode: 'aiHunt', seed: 777 });
  const inputs = [{ move: { x: 1, y: 0 } }];
  for (const input of inputs) engine.step(input);
  const receipt = cryptoUtil.createRunReceipt({
    seed: 777,
    mode: 'aiHunt',
    inputs,
    finalState: { ...engine.state },
    finalScore: engine.state.score,
    finalLevel: engine.state.level || 1,
  });
  // Tamper with the score
  receipt.finalScore = 99999;
  const result = cryptoUtil.verifyRunReceipt(receipt);
  assert(!result.valid, 'Tampered receipt should not verify');
  assert.equal(result.reason, 'Invalid signature', 'Should report signature failure');
  console.log('  PASS');
}

function testRecordRunWithReceipt() {
  console.log('Testing: recordRun creates receipts when seed/inputs provided...');
  const state = {
    version: 2,
    bestScores: { aiHunt: 0, frogger: 0 },
    bestLevels: { frogger: 0 },
    totalRuns: { aiHunt: 0, frogger: 0 },
    totalPickups: 0,
    totalCredits: 0,
    lastPlayedAt: null,
    lastMode: null,
  };
  const engine = createEngine({ mode: 'aiHunt', seed: 555 });
  const inputs = [{ move: { x: 1, y: 0 } }, { move: { x: 1, y: 0 } }];
  for (const input of inputs) engine.step(input);
  const result = persistence.recordRun(state, {
    mode: 'aiHunt',
    score: engine.state.score,
    level: 1,
    seed: 555,
    inputs,
    finalState: { ...engine.state },
  });
  assert(result.receipt, 'Should return a receipt');
  assert(result.receipt.signature, 'Receipt should be signed');
  assert(result.state.runReceipts.length === 1, 'State should have one run receipt');
  // Verify the stored receipt
  const verifyResult = cryptoUtil.verifyRunReceipt(result.state.runReceipts[0]);
  assert(verifyResult.valid, 'Stored receipt should verify');
  console.log('  PASS');
}

function testStateHashing() {
  console.log('Testing: State hashing...');
  const state1 = { score: 100, mode: 'aiHunt' };
  const state2 = { score: 100, mode: 'aiHunt' };
  const state3 = { score: 200, mode: 'aiHunt' };
  const hash1 = cryptoUtil.hashState(state1);
  const hash2 = cryptoUtil.hashState(state2);
  const hash3 = cryptoUtil.hashState(state3);
  assert.equal(hash1, hash2, 'Identical states should hash identically');
  assert.notEqual(hash1, hash3, 'Different states should hash differently');
  console.log('  PASS');
}

function testSecurityModelDocumented() {
  console.log('Testing: security model is explicitly documented...');
  // Read the source file and check it has a SECURITY MODEL section
  const fs = require('node:fs');
  const path = require('node:path');
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'core', 'crypto.js'),
    'utf8'
  );
  assert(source.includes('SECURITY MODEL'), 'crypto.js should have a SECURITY MODEL section');
  assert(source.includes('INTEGRITY') || source.includes('integrity'),
    'SECURITY MODEL should mention integrity');
  assert(source.includes('NOT') || source.includes('not'),
    'SECURITY MODEL should note limitations');
  console.log('  PASS');
}

function testEnvVarValidKey() {
  console.log('Testing: SIGNAL_RUSH_HMAC_KEY with valid 64-char hex key...');
  const original = process.env.SIGNAL_RUSH_HMAC_KEY;
  // Deterministic 32-byte key (64 hex chars)
  const testKey = 'a'.repeat(64); // 64 hex chars = 32 bytes of 0xAA
  process.env.SIGNAL_RUSH_HMAC_KEY = testKey;
  try {
    // Flush require cache so getSigningKey re-evaluates the env var
    delete require.cache[require.resolve('../src/core/crypto')];
    const cryptoMod = require('../src/core/crypto');

    const data = JSON.stringify({ env: 'test', value: 123 });
    const sig = cryptoMod.sign(data);
    assert(sig, 'Signature should be produced with env var key');
    assert(cryptoMod.verify(data, sig), 'Signature created with env key should verify');
    assert(!cryptoMod.verify(data + 'x', sig), 'Tampered data should fail even with env key');

    // Verify getSigningKey returns exactly 32 bytes
    const key = cryptoMod.getSigningKey();
    assert.equal(key.length, 32, 'Key from env var should be 32 bytes');
    // Verify it matches our input
    assert.equal(key.toString('hex'), testKey, 'Key should match the env var hex value');
    console.log('  PASS');
  } finally {
    if (original === undefined) {
      delete process.env.SIGNAL_RUSH_HMAC_KEY;
    } else {
      process.env.SIGNAL_RUSH_HMAC_KEY = original;
    }
    // Restore cached module
    delete require.cache[require.resolve('../src/core/crypto')];
  }
}

function testEnvVarInvalidKey() {
  console.log('Testing: SIGNAL_RUSH_HMAC_KEY with invalid length falls back...');
  const original = process.env.SIGNAL_RUSH_HMAC_KEY;
  const originalWrite = process.stderr.write;
  let warningOutput = '';
  // Capture stderr to verify warning is emitted
  process.stderr.write = function(chunk) {
    warningOutput += chunk.toString();
    return true;
  };
  try {
    // Set a key that is not 64 hex chars (too short)
    process.env.SIGNAL_RUSH_HMAC_KEY = 'aabbcc';
    delete require.cache[require.resolve('../src/core/crypto')];
    const cryptoMod = require('../src/core/crypto');

    // Should still work — falls back to machine key
    const data = JSON.stringify({ env: 'test', value: 456 });
    const sig = cryptoMod.sign(data);
    assert(sig, 'Signature should be produced after fallback');
    assert(cryptoMod.verify(data, sig), 'Signature created with fallback key should verify');

    // Key should still be 32 bytes (machine-derived)
    const key = cryptoMod.getSigningKey();
    assert.equal(key.length, 32, 'Fallback key should be 32 bytes');

    // Warning should have been emitted
    assert(warningOutput.includes('WARNING'), 'Warning message should be emitted on invalid key');
    assert(warningOutput.includes('64 hex chars'), 'Warning should mention 64 hex char requirement');
    console.log('  PASS');
  } finally {
    process.stderr.write = originalWrite;
    if (original === undefined) {
      delete process.env.SIGNAL_RUSH_HMAC_KEY;
    } else {
      process.env.SIGNAL_RUSH_HMAC_KEY = original;
    }
    delete require.cache[require.resolve('../src/core/crypto')];
  }
}

function testReceiptVerificationWithEnvKey() {
  console.log('Testing: Receipt creation and verification with SIGNAL_RUSH_HMAC_KEY...');
  const original = process.env.SIGNAL_RUSH_HMAC_KEY;
  const testKey = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  process.env.SIGNAL_RUSH_HMAC_KEY = testKey;
  try {
    delete require.cache[require.resolve('../src/core/crypto')];
    const cryptoMod = require('../src/core/crypto');
    const { createEngine } = require('../src/core/engine');

    const engine = createEngine({ mode: 'aiHunt', seed: 4242 });
    const inputs = [{ move: { x: 1, y: 0 } }, { move: { x: 0, y: 1 } }, { move: { x: 1, y: 0 } }];
    for (const input of inputs) engine.step(input);

    const receipt = cryptoMod.createRunReceipt({
      seed: 4242,
      mode: 'aiHunt',
      inputs,
      finalState: { ...engine.state },
      finalScore: engine.state.score,
      finalLevel: engine.state.level || 1,
    });

    // Verify with signature check only
    let result = cryptoMod.verifyRunReceipt(receipt);
    assert(result.valid, 'Receipt should verify with env var key (signature check)');

    // Verify with full re-simulation
    result = cryptoMod.verifyRunReceipt(receipt, {
      reSimulate: true,
      engineFactory: (opts) => createEngine(opts),
    });
    assert(result.valid, 'Receipt should verify with env var key + re-simulation');

    // Tamper and ensure it fails
    receipt.finalScore = 999999;
    result = cryptoMod.verifyRunReceipt(receipt);
    assert(!result.valid, 'Tampered receipt with env key should fail verification');

    console.log('  PASS');
  } finally {
    if (original === undefined) {
      delete process.env.SIGNAL_RUSH_HMAC_KEY;
    } else {
      process.env.SIGNAL_RUSH_HMAC_KEY = original;
    }
    delete require.cache[require.resolve('../src/core/crypto')];
  }
}

// Run all tests
console.log('\n=== Signal Rush Anti-Cheat Tests ===\n');

try {
  testHMACSigningAndVerification();
  testStateFileIntegrity();
  testStateTamperingDetected();
  testRunReceiptCreation();
  testRunReceiptVerification();
  testRunReceiptTamperingDetected();
  testRecordRunWithReceipt();
  testStateHashing();
  testSecurityModelDocumented();
  testEnvVarValidKey();
  testEnvVarInvalidKey();
  testReceiptVerificationWithEnvKey();
  cleanup();
  console.log('\n✅ ALL ANTI-CHEAT TESTS PASSED');
} catch (e) {
  console.error('\n❌ TEST FAILED:', e.message);
  cleanup();
  process.exit(1);
}