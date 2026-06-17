// economy/tests/fraud-test.js
// Signal Rush — Fraud Simulation & Concurrency Tests
//
// Simulates various attack scenarios:
// 1. Rapid credit farming (bot detection)
// 2. Replay attacks (same events sent multiple times)
// 3. Invalid player ID spoofing
// 4. Concurrent sessions from different "players"
// 5. Balance manipulation attempts
//
// Run with: node economy/tests/fraud-test.js

const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');

const SERVICE_PATH = path.join(__dirname, '..', 'service.js');
const TEST_DB = path.join(os.tmpdir(), `signal-rush-fraud-test-${Date.now()}.db`);
const PORT = 8732;

let passed = 0;
let failed = 0;
let proc = null;

function request(method, path, body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request(`http://127.0.0.1:${PORT}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
        ...headers,
      },
    }, (res) => {
      let chunks = '';
      res.on('data', d => chunks += d);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(chunks) }); }
        catch { resolve({ status: res.statusCode, body: chunks }); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function assert(condition, msg) {
  if (!condition) throw new Error(msg);
}

function test(name, fn) {
  return fn().then(() => {
    passed++;
    console.log(`PASS ${name}`);
  }).catch(e => {
    failed++;
    console.error(`FAIL ${name}: ${e.message}`);
  });
}

async function run() {
  console.log('[fraud] Starting economy service for fraud tests...');
  proc = spawn(process.execPath, [SERVICE_PATH], {
    env: {
      ...process.env,
      ECONOMY_PORT: String(PORT),
      ECONOMY_DB: TEST_DB,
      ECONOMY_API_KEY: 'fraud-test-secret',
      ECONOMY_AUTH_ENFORCED: 'true',
      RATE_LIMIT_MAX: '200',
      RATE_LIMIT_WINDOW_MS: '60000',
      MAX_CREDITS_PER_SESSION: '1000',
      MAX_SPEND_PER_TX: '50',
      MAX_AWARD_PER_TX: '100',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Service start timeout')), 5000);
    proc.stdout.on('data', (d) => {
      if (d.toString().includes('running')) {
        clearTimeout(timeout);
        resolve();
      }
    });
    proc.stderr.on('data', (d) => {
      console.error('[service stderr]', d.toString().trim());
    });
    proc.on('exit', (code) => {
      if (code !== 0 && code !== null) {
        clearTimeout(timeout);
        reject(new Error(`Service exited with code ${code}`));
      }
    });
  });

  console.log('[fraud] Service ready. Running fraud simulation tests...\n');

  const AUTH = { Authorization: 'Bearer fraud-test-secret' };
  let playerId;
  let player2Id;

  try {
    // Setup: create two players
    const p1 = await request('POST', '/players', { display_name: 'Fraud Test P1' });
    playerId = p1.body.id;
    const p2 = await request('POST', '/players', { display_name: 'Fraud Test P2' });
    player2Id = p2.body.id;

    // ─── 1. RAPID CREDIT FARMING (BOT DETECTION) ────────────────────

    await test('Session credit limit prevents farming', async () => {
      // Create a new player for this test
      const p3 = await request('POST', '/players', { display_name: 'Farmer' });
      const p3Id = p3.body.id;

      // Award up to the session limit (1000)
      let awarded = 0;
      let hitLimit = false;
      for (let i = 0; i < 15; i++) {
        const r = await request('POST', '/internal/ingest', {
          player_id: p3Id,
          session_id: 'farm-session',
          credits_delta: 100,
          events: [],
        }, AUTH);
        if (r.status === 400 && r.body.error.includes('session credit limit')) {
          hitLimit = true;
          break;
        }
        if (r.status === 200) awarded += 100;
      }
      assert(hitLimit, 'should hit session credit limit');
      assert(awarded <= 1000, `should not exceed 1000 credits, got ${awarded}`);
    });

    await test('Rapid requests are rate limited', async () => {
      // Test rate limiting on /health endpoint (not used by other tests)
      // Rate limit is 200 per window, we send 210 to trigger it
      const requests = [];
      for (let i = 0; i < 210; i++) {
        requests.push(request('GET', '/health'));
      }
      const results = await Promise.all(requests);
      const succeeded = results.filter(r => r.status === 200);
      const limited = results.filter(r => r.status === 429);
      assert(succeeded.length > 0, 'some requests should succeed');
      assert(limited.length > 0, 'some requests should be rate limited');
    });

    // ─── 2. REPLAY ATTACKS ──────────────────────────────────────────

    await test('Replay with same idempotency key does not double-award', async () => {
      const key = 'replay-attack-key-1';
      const r1 = await request('POST', '/credits/award', {
        player_id: playerId, amount: 50, reason: 'replay_test', idempotency_key: key,
      }, AUTH);
      assert(r1.status === 200, `expected 200, got ${r1.status}`);
      const balance1 = r1.body.player.balance;

      // Replay exact same request
      const r2 = await request('POST', '/credits/award', {
        player_id: playerId, amount: 50, reason: 'replay_test', idempotency_key: key,
      }, AUTH);
      assert(r2.status === 200, `expected 200, got ${r2.status}`);
      assert(r2.body.player.balance === balance1, `balance should not change on replay: ${r2.body.player.balance} vs ${balance1}`);
    });

    await test('Replay without idempotency key creates separate awards', async () => {
      // Without idempotency key, same request creates separate awards
      // (this is expected — idempotency is opt-in via key)
      const r1 = await request('POST', '/credits/award', {
        player_id: playerId, amount: 10, reason: 'no_idem_test',
      }, AUTH);
      const r2 = await request('POST', '/credits/award', {
        player_id: playerId, amount: 10, reason: 'no_idem_test',
      }, AUTH);
      assert(r1.status === 200, `expected 200, got ${r1.status}`);
      assert(r2.status === 200, `expected 200, got ${r2.status}`);
      // Both should succeed (no idempotency key = no dedup)
      assert(r2.body.player.balance === r1.body.player.balance + 10,
        `without idempotency key, second award should add: ${r2.body.player.balance} vs ${r1.body.player.balance + 10}`);
    });

    // ─── 3. PLAYER ID SPOOFING ──────────────────────────────────────

    await test('Cannot query another player data with invalid UUID', async () => {
      const r = await request('GET', '/players/;DROP TABLE players;--');
      assert(r.status === 400, `expected 400, got ${r.status}`);
    });

    await test('Cannot award credits to non-existent player', async () => {
      const r = await request('POST', '/credits/award', {
        player_id: '00000000-0000-0000-0000-000000000000',
        amount: 100, reason: 'spoof',
      }, AUTH);
      assert(r.status === 404, `expected 404, got ${r.status}`);
    });

    await test('Cannot spend from non-existent player', async () => {
      const r = await request('POST', '/credits/spend', {
        player_id: '00000000-0000-0000-0000-000000000000',
        amount: 100, reason: 'spoof',
      }, AUTH);
      // Returns 400 (validation error) or 404 (not found) — both are acceptable
      assert(r.status === 400 || r.status === 404, `expected 400 or 404, got ${r.status}`);
    });

    // ─── 4. CONCURRENT MULTI-PLAYER SESSIONS ────────────────────────

    await test('Concurrent sessions do not corrupt balances', async () => {
      // Create fresh players for this test (avoid rate limit from previous tests)
      const cp1 = await request('POST', '/players', { display_name: 'Concurrent P1' });
      const cp2 = await request('POST', '/players', { display_name: 'Concurrent P2' });
      const cp1Id = cp1.body.id;
      const cp2Id = cp2.body.id;

      // Both players earn credits concurrently
      const requests = [];
      for (let i = 0; i < 5; i++) {
        requests.push(request('POST', '/internal/ingest', {
          player_id: cp1Id,
          session_id: `concurrent-p1-${i}`,
          credits_delta: 10,
          events: [],
        }, AUTH));
        requests.push(request('POST', '/internal/ingest', {
          player_id: cp2Id,
          session_id: `concurrent-p2-${i}`,
          credits_delta: 20,
          events: [],
        }, AUTH));
      }

      const results = await Promise.all(requests);
      const succeeded = results.filter(r => r.status === 200);
      assert(succeeded.length === 10, `all 10 concurrent requests should succeed, got ${succeeded.length}`);

      // Verify balances are correct
      const p1Check = await request('GET', `/players/${cp1Id}`);
      const p2Check = await request('GET', `/players/${cp2Id}`);
      assert(p1Check.body.balance === 50, `p1 balance should be 50, got ${p1Check.body.balance}`);
      assert(p2Check.body.balance === 100, `p2 balance should be 100, got ${p2Check.body.balance}`);
    });

    await test('Concurrent spends do not cause negative balance', async () => {
      // Create a fresh player with known balance
      const csP = await request('POST', '/players', { display_name: 'Spend Test' });
      const csId = csP.body.id;
      // Award enough credits for the test
      await request('POST', '/credits/award', {
        player_id: csId, amount: 50, reason: 'concurrent_spend_test',
      }, AUTH);

      // Try to spend more than balance concurrently (10 × 10 = 100, but only have 50)
      const spendRequests = [];
      for (let i = 0; i < 10; i++) {
        spendRequests.push(request('POST', '/credits/spend', {
          player_id: csId, amount: 10, reason: 'concurrent_spend',
        }, AUTH));
      }
      const results = await Promise.all(spendRequests);

      // Some should succeed, some should fail with insufficient balance
      const succeeded = results.filter(r => r.status === 200);
      const failed_balance = results.filter(r => r.status === 409);

      assert(succeeded.length > 0, 'some spends should succeed');
      assert(failed_balance.length > 0, 'some spends should fail with insufficient balance');

      // Final balance must be >= 0
      const finalCheck = await request('GET', `/players/${csId}`);
      assert(finalCheck.body.balance >= 0, `final balance must be >= 0, got ${finalCheck.body.balance}`);
      assert(finalCheck.body.balance === 50 - succeeded.length * 10,
        `balance should be exactly ${50 - succeeded.length * 10}, got ${finalCheck.body.balance}`);
    });

    // ─── 5. BALANCE MANIPULATION ────────────────────────────────────

    await test('Cannot spend more than per-transaction limit', async () => {
      const r = await request('POST', '/credits/spend', {
        player_id: playerId, amount: 100, reason: 'over_limit',
      }, AUTH);
      assert(r.status === 400, `expected 400, got ${r.status}`);
      assert(r.body.error.includes('maximum'), `should mention maximum, got: ${r.body.error}`);
    });

    await test('Cannot award more than per-transaction limit', async () => {
      const r = await request('POST', '/credits/award', {
        player_id: playerId, amount: 500, reason: 'over_limit',
      }, AUTH);
      assert(r.status === 400, `expected 400, got ${r.status}`);
    });

    await test('Cannot spend zero credits', async () => {
      const r = await request('POST', '/credits/spend', {
        player_id: playerId, amount: 0, reason: 'zero',
      }, AUTH);
      assert(r.status === 400, `expected 400, got ${r.status}`);
    });

    await test('Cannot award zero credits', async () => {
      const r = await request('POST', '/credits/award', {
        player_id: playerId, amount: 0, reason: 'zero',
      }, AUTH);
      assert(r.status === 400, `expected 400, got ${r.status}`);
    });

    // ─── 6. AUTH BYPASS ATTEMPTS ────────────────────────────────────

    await test('Stolen/empty auth token rejected', async () => {
      const r = await request('POST', '/credits/award', {
        player_id: playerId, amount: 10, reason: 'stolen',
      }, { Authorization: '' });
      assert(r.status === 401, `expected 401, got ${r.status}`);
    });

    await test('Auth with wrong scheme rejected', async () => {
      const r = await request('POST', '/credits/award', {
        player_id: playerId, amount: 10, reason: 'wrong_scheme',
      }, { Authorization: 'Basic dXNlcjpwYXNz' });
      assert(r.status === 401, `expected 401, got ${r.status}`);
    });

    // ─── 7. DATA INTEGRITY ──────────────────────────────────────────

    await test('All balances non-negative after fraud attempts', async () => {
      const p1 = await request('GET', `/players/${playerId}`);
      const p2 = await request('GET', `/players/${player2Id}`);
      assert(p1.body.balance >= 0, `p1 balance must be >= 0: ${p1.body.balance}`);
      assert(p2.body.balance >= 0, `p2 balance must be >= 0: ${p2.body.balance}`);
    });

  } finally {
    proc.kill('SIGTERM');
    await new Promise(r => proc.on('exit', r));
    try { fs.unlinkSync(TEST_DB); } catch {}
    try { fs.unlinkSync(TEST_DB + '-wal'); } catch {}
    try { fs.unlinkSync(TEST_DB + '-shm'); } catch {}
  }

  console.log(`\nFraud simulation tests: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run().catch(e => {
  console.error('[fraud] Fatal:', e.message);
  process.exit(1);
});
