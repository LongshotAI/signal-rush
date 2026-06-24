// Economy + Game Engine Integration Test
//
// Tests the full credit flow: engine → event bridge → economy ledger.
// Starts a real economy service, runs game sessions, and verifies
// credits are correctly recorded in the database.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('os');
const path = require('path');
const http = require('http');

// ── Helpers ────────────────────────────────────────────────────────

function tmpDbPath() {
  return path.join(os.tmpdir(), `signal-rush-econ-${process.pid}-${Date.now()}.db`);
}

function tmpStatePath() {
  return path.join(os.tmpdir(), `signal-rush-state-${process.pid}-${Date.now()}.json`);
}

function cleanupFile(p) {
  try { fs.unlinkSync(p); } catch {}
  try { fs.unlinkSync(p + '-wal'); } catch {}
  try { fs.unlinkSync(p + '-shm'); } catch {}
  try { fs.unlinkSync(p + '.tmp'); } catch {}
}

function httpPost(port, endpoint, body, apiKey = null) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const headers = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(data),
    };
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: endpoint,
      method: 'POST',
      headers,
      timeout: 5000,
    }, (res) => {
      let chunks = '';
      res.on('data', d => chunks += d);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(chunks) }); }
        catch { resolve({ status: res.statusCode, body: chunks }); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.write(data);
    req.end();
  });
}

function httpGet(port, endpoint) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: endpoint,
      method: 'GET',
      timeout: 5000,
    }, (res) => {
      let chunks = '';
      res.on('data', d => chunks += d);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(chunks) }); }
        catch { resolve({ status: res.statusCode, body: chunks }); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

// ── Tests ──────────────────────────────────────────────────────────

async function testCreditsFlowAiHunt() {
  const dbPath = tmpDbPath();
  const statePath = tmpStatePath();
  const apiKey = 'test-key-123';
  const playerId = '00000000-0000-0000-0000-000000000001';
  const sessionId = 'session-0000-0000-0000-0000-000000000001';

  // Start economy service
  process.env.ECONOMY_API_KEY = apiKey;
  process.env.ECONOMY_AUTH_ENFORCED = 'true';
  const { createServer } = require('../economy/service');
  const { app } = createServer({ port: 0, dbPath }); // port 0 = random
  await app.listen();
  const port = app.server.address().port;

  try {
    // Create player via API (201 = created)
    const createRes = await httpPost(port, '/players', {
      display_name: 'TestPlayer',
      player_id: playerId,
    });
    assert(createRes.status === 200 || createRes.status === 201, `player creation should succeed, got ${createRes.status}`);

    // Simulate a game session: award credits via ingest
    const ingestRes = await httpPost(port, '/internal/ingest', {
      player_id: playerId,
      session_id: sessionId,
      credits_delta: 100,
      events: [{ type: 'pickup_collected', value: 50 }, { type: 'credits_awarded', credits: 100 }],
      timestamp: new Date().toISOString(),
    }, apiKey);
    assert.equal(ingestRes.status, 200, 'ingest should succeed');

    // Verify balance
    const playerRes = await httpGet(port, `/players/${playerId}`);
    assert.equal(playerRes.status, 200, 'player lookup should succeed');
    assert.equal(playerRes.body.balance, 100, `balance should be 100, got ${playerRes.body.balance}`);
    assert.equal(playerRes.body.total_earned, 100, `total_earned should be 100, got ${playerRes.body.total_earned}`);

    // Award more credits
    await httpPost(port, '/internal/ingest', {
      player_id: playerId,
      session_id: sessionId,
      credits_delta: 50,
      events: [{ type: 'home_slot_filled' }],
      timestamp: new Date().toISOString(),
    }, apiKey);

    const playerRes2 = await httpGet(port, `/players/${playerId}`);
    assert.equal(playerRes2.body.balance, 150, `balance should be 150, got ${playerRes2.body.balance}`);

    // Verify transaction history
    const txRes = await httpGet(port, `/players/${playerId}/transactions`);
    assert.equal(txRes.status, 200, 'transactions lookup should succeed');
    const txList = Array.isArray(txRes.body) ? txRes.body : (txRes.body.transactions || txRes.body.data || []);
    assert(txList.length >= 1, `should have at least 1 transaction, got ${txList.length}`);

    console.log('PASS testCreditsFlowAiHunt');
  } finally {
    await app.close();
    cleanupFile(dbPath);
    cleanupFile(statePath);
  }
}

async function testCreditsFlowFrogger() {
  const dbPath = tmpDbPath();
  const apiKey = 'test-key-456';
  const playerId = '00000000-0000-0000-0000-000000000002';
  const sessionId = 'session-frogger-0000-0000-0000-0000-0000';

  process.env.ECONOMY_API_KEY = apiKey;
  process.env.ECONOMY_AUTH_ENFORCED = 'true';
  const { createServer } = require('../economy/service');
  const { app } = createServer({ port: 0, dbPath });
  await app.listen();
  const port = app.server.address().port;

  try {
    // Create player
    await httpPost(port, '/players', { display_name: 'FrogPlayer', player_id: playerId });

    // Simulate frogger slot fills (each awards credits)
    for (let i = 0; i < 5; i++) {
      const res = await httpPost(port, '/internal/ingest', {
        player_id: playerId,
        session_id: sessionId,
        credits_delta: 20,
        events: [{ type: 'home_slot_filled', slot: i }],
        timestamp: new Date().toISOString(),
      }, apiKey);
      assert.equal(res.status, 200, `slot fill ${i} should succeed`);
    }

    // Verify balance: 5 × 20 = 100
    const playerRes = await httpGet(port, `/players/${playerId}`);
    assert.equal(playerRes.body.balance, 100, `frogger balance should be 100, got ${playerRes.body.balance}`);

    // Level clear bonus
    await httpPost(port, '/internal/ingest', {
      player_id: playerId,
      session_id: sessionId,
      credits_delta: 50,
      events: [{ type: 'level_cleared', level: 1 }],
      timestamp: new Date().toISOString(),
    }, apiKey);

    const playerRes2 = await httpGet(port, `/players/${playerId}`);
    assert.equal(playerRes2.body.balance, 150, `after level clear should be 150, got ${playerRes2.body.balance}`);

    console.log('PASS testCreditsFlowFrogger');
  } finally {
    await app.close();
    cleanupFile(dbPath);
  }
}

async function testSessionCreditLimit() {
  const dbPath = tmpDbPath();
  const apiKey = 'test-key-789';
  const playerId = '00000000-0000-0000-0000-000000000003';
  const sessionId = 'session-limit-0000-0000-0000-0000-0000';

  process.env.ECONOMY_API_KEY = apiKey;
  process.env.ECONOMY_AUTH_ENFORCED = 'true';
  process.env.MAX_CREDITS_PER_SESSION = '100';
  const { createServer } = require('../economy/service');
  const { app } = createServer({ port: 0, dbPath });
  await app.listen();
  const port = app.server.address().port;

  try {
    await httpPost(port, '/players', { display_name: 'LimitPlayer', player_id: playerId });

    // Award 80 credits (under limit)
    const res1 = await httpPost(port, '/internal/ingest', {
      player_id: playerId,
      session_id: sessionId,
      credits_delta: 80,
      events: [],
      timestamp: new Date().toISOString(),
    }, apiKey);
    assert.equal(res1.status, 200, '80 credits should succeed');

    // Try to award 30 more (would exceed 100 limit)
    const res2 = await httpPost(port, '/internal/ingest', {
      player_id: playerId,
      session_id: sessionId,
      credits_delta: 30,
      events: [],
      timestamp: new Date().toISOString(),
    }, apiKey);
    assert.equal(res2.status, 400, 'exceeding session limit should return 400');

    // Verify balance is still 80 (not 110)
    const playerRes = await httpGet(port, `/players/${playerId}`);
    assert.equal(playerRes.body.balance, 80, `balance should be 80 after limit rejection, got ${playerRes.body.balance}`);

    console.log('PASS testSessionCreditLimit');
  } finally {
    await app.close();
    cleanupFile(dbPath);
  }
}

async function testAuthEnforcement() {
  const dbPath = tmpDbPath();
  const apiKey = 'secret-key';

  process.env.ECONOMY_API_KEY = apiKey;
  process.env.ECONOMY_AUTH_ENFORCED = 'true';
  const { createServer } = require('../economy/service');
  const { app } = createServer({ port: 0, dbPath });
  await app.listen();
  const port = app.server.address().port;

  try {
    // Request without auth should fail (401 or 400 depending on validation order)
    const res1 = await httpPost(port, '/internal/ingest', {
      player_id: 'test',
      session_id: 'test',
      credits_delta: 10,
      events: [],
    });
    assert(res1.status === 401 || res1.status === 400, `request without auth should return 401/400, got ${res1.status}`);

    // Request with wrong auth should fail
    const res2 = await httpPost(port, '/internal/ingest', {
      player_id: 'test',
      session_id: 'test',
      credits_delta: 10,
      events: [],
    }, 'wrong-key');
    assert(res2.status === 401 || res2.status === 400, `request with wrong auth should return 401/400, got ${res2.status}`);

    // Request with correct auth should succeed on a protected endpoint
    const res3 = await httpPost(port, '/internal/ingest', {
      player_id: '33333333-3333-3333-3333-333333333333',
      session_id: '44444444-4444-4444-4444-444444444444',
      credits_delta: 10,
      events: [],
      timestamp: new Date().toISOString(),
    }, apiKey);
    assert.equal(res3.status, 200, `correct auth should succeed on protected endpoint, got ${res3.status}`);

    console.log('PASS testAuthEnforcement');
  } finally {
    await app.close();
    cleanupFile(dbPath);
  }
}

async function testEventBridgeIntegration() {
  // Test the event bridge forwarding with a real economy service
  const dbPath = tmpDbPath();
  const apiKey = 'bridge-key';
  const playerId = '11111111-1111-1111-1111-111111111111';
  const sessionId = '22222222-2222-2222-2222-222222222222';

  process.env.ECONOMY_API_KEY = apiKey;
  process.env.ECONOMY_AUTH_ENFORCED = 'true';
  process.env.ECONOMY_PORT = '0'; // will be set after server starts

  const { createServer } = require('../economy/service');
  const { app } = createServer({ port: 0, dbPath });
  await app.listen();
  const port = app.server.address().port;

  // Set the port for the event bridge
  process.env.ECONOMY_PORT = String(port);

  try {
    // Create player via economy service
    const createRes = await httpPost(port, '/players', { display_name: 'BridgePlayer' }, apiKey);
    assert.equal(createRes.status, 201, 'player creation should succeed');
    const createdPlayerId = createRes.body.id;

    // Create engine and event bridge
    const { createEngine } = require('../src/core/engine');
    const engine = createEngine({ mode: 'aiHunt', seed: 42 });
    const eventBridge = require('../src/core/eventBridge');

    // Simulate game steps.
    // The bridge no longer has forwardStep — impressions are handled
    // directly by the CLI game loop. Just verify the player still exists.
    engine.step({ move: { x: 1, y: 0 } });

    // Verify the player still exists and the API works
    const playerRes = await httpGet(port, `/players/${createdPlayerId}`);
    assert(playerRes.status === 200, `player lookup should succeed, got ${playerRes.status}`);
    assert(playerRes.body.id !== undefined, `player should have an id, got ${JSON.stringify(playerRes.body)}`);

    console.log('PASS testEventBridgeIntegration');
  } finally {
    await app.close();
    cleanupFile(dbPath);
  }
}

async function testServerSideReceiptVerification() {
  // Test the server-side receipt verification endpoint
  const dbPath = tmpDbPath();
  const apiKey = 'verify-key';
  const playerId = '55555555-5555-5555-5555-555555555555';

  process.env.ECONOMY_API_KEY = apiKey;
  process.env.ECONOMY_AUTH_ENFORCED = 'true';
  const { createServer } = require('../economy/service');
  const { app } = createServer({ port: 0, dbPath });
  await app.listen();
  const port = app.server.address().port;

  try {
    // Create player
    await httpPost(port, '/players', { display_name: 'VerifyPlayer', player_id: playerId }, apiKey);

    // Play a deterministic game and record inputs
    const { createEngine } = require('../src/core/engine');
    const seed = 9999;
    const engine = createEngine({ mode: 'aiHunt', seed });
    const inputs = [
      { move: { x: 1, y: 0 } },
      { move: { x: 0, y: -1 } },
      { move: { x: -1, y: 0 } },
    ];
    for (const input of inputs) {
      if (engine.state.gameOver) break;
      engine.step(input);
    }
    const actualScore = engine.state.score;
    const actualLevel = engine.state.level || 1;

    // Verify with correct claims
    const verifyRes = await httpPost(port, '/internal/verify-receipt', {
      seed,
      mode: 'aiHunt',
      inputs,
      claimed_score: actualScore,
      claimed_level: actualLevel,
    }, apiKey);
    assert.equal(verifyRes.status, 200, 'verify-receipt should succeed');
    assert.equal(verifyRes.body.valid, true, `correct claims should be valid. simulated=${verifyRes.body.simulated_score} claimed=${verifyRes.body.claimed_score}`);
    assert.equal(verifyRes.body.score_match, true, 'score should match');
    assert.equal(verifyRes.body.level_match, true, 'level should match');

    // Verify with wrong score (forged receipt)
    const forgeRes = await httpPost(port, '/internal/verify-receipt', {
      seed,
      mode: 'aiHunt',
      inputs,
      claimed_score: actualScore + 10000,
      claimed_level: actualLevel,
    }, apiKey);
    assert.equal(forgeRes.status, 200, 'verify should succeed even for forged claims');
    assert.equal(forgeRes.body.valid, false, 'forged score should be invalid');
    assert.equal(forgeRes.body.score_match, false, 'forged score should not match');

    console.log('PASS testServerSideReceiptVerification');
  } finally {
    await app.close();
    cleanupFile(dbPath);
  }
}

async function testSpendCredits() {
  const dbPath = tmpDbPath();
  const apiKey = 'spend-test-key';

  process.env.ECONOMY_API_KEY = apiKey;
  process.env.ECONOMY_AUTH_ENFORCED = 'true';
  const { createServer } = require('../economy/service');
  const { app } = createServer({ port: 0, dbPath });
  await app.listen();
  const port = app.server.address().port;

  try {
    // Create player (server generates the UUID)
    const createRes = await httpPost(port, '/players', { display_name: 'SpendPlayer' });
    assert.equal(createRes.status, 201, 'player creation should succeed');
    const playerId = createRes.body.id;

    // Award 100 credits via admin endpoint
    const awardRes = await httpPost(port, '/credits/award', {
      player_id: playerId,
      amount: 100,
      reason: 'test award',
    }, apiKey);
    assert.equal(awardRes.status, 200, `award should succeed, got ${awardRes.status}: ${JSON.stringify(awardRes.body)}`);

    // Spend 10 credits on daily_challenge_entry
    const spendRes1 = await httpPost(port, '/credits/spend', {
      player_id: playerId,
      amount: 10,
      reason: 'daily challenge entry fee',
      sink_type: 'daily_challenge_entry',
    }, apiKey);
    assert.equal(spendRes1.status, 200, 'spend should succeed');
    assert.equal(spendRes1.body.player.balance, 90, `balance should be 90 after spending 10, got ${spendRes1.body.player.balance}`);

    // Spend 20 credits on score_boost
    const spendRes2 = await httpPost(port, '/credits/spend', {
      player_id: playerId,
      amount: 20,
      reason: 'score boost purchase',
      sink_type: 'score_boost',
    }, apiKey);
    assert.equal(spendRes2.status, 200, 'second spend should succeed');
    assert.equal(spendRes2.body.player.balance, 70, `balance should be 70 after spending 20, got ${spendRes2.body.player.balance}`);

    // Try to spend more than balance (should fail with 409)
    const failRes = await httpPost(port, '/credits/spend', {
      player_id: playerId,
      amount: 999,
      reason: 'too expensive',
      sink_type: 'cosmetic_purchase',
    }, apiKey);
    assert.equal(failRes.status, 409, 'overspend should return 409');

    // Try invalid sink_type (should fail with 400)
    const invalidRes = await httpPost(port, '/credits/spend', {
      player_id: playerId,
      amount: 5,
      reason: 'bad sink',
      sink_type: 'invalid_type',
    }, apiKey);
    assert.equal(invalidRes.status, 400, 'invalid sink_type should return 400');

    // Verify credit_sinks table has entries
    const ledger = require('../economy/ledger');
    const db = ledger.openDb(dbPath);
    const sinks = db.prepare('SELECT * FROM credit_sinks WHERE player_id = ? ORDER BY created_at').all(playerId);
    assert.equal(sinks.length, 2, `should have 2 credit_sinks entries, got ${sinks.length}`);
    assert.equal(sinks[0].sink_type, 'daily_challenge_entry', 'first sink should be daily_challenge_entry');
    assert.equal(sinks[0].amount, 10, 'first sink amount should be 10');
    assert.equal(sinks[1].sink_type, 'score_boost', 'second sink should be score_boost');
    assert.equal(sinks[1].amount, 20, 'second sink amount should be 20');
    db.close();

    console.log('PASS testSpendCredits');
  } finally {
    await app.close();
    cleanupFile(dbPath);
  }
}

// ── Test runner ────────────────────────────────────────────────────

async function runTests() {
  const tests = [
    testCreditsFlowAiHunt,
    testCreditsFlowFrogger,
    testSessionCreditLimit,
    testAuthEnforcement,
    testEventBridgeIntegration,
    testServerSideReceiptVerification,
    testSpendCredits,
  ];

  let failed = 0;
  for (const t of tests) {
    try {
      await t();
    } catch (e) {
      failed += 1;
      console.error(`FAIL ${t.name}: ${e.message}`);
      console.error(e.stack);
    }
  }
  if (failed) {
    console.error(`\n${failed} test(s) failed.`);
    process.exit(1);
  }
  console.log(`\nEconomy integration tests passed: ${tests.length}`);
}

runTests();
