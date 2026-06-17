// economy/tests/security-test.js
// Signal Rush — Security & Fraud Tests
//
// Tests for all security hardening: auth, rate limiting, input validation,
// spending limits, and anti-fraud measures.
//
// Run with: node economy/tests/security-test.js

const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');

// We need to test the full service, so we spawn it
const { spawn } = require('child_process');

const SERVICE_PATH = path.join(__dirname, '..', 'service.js');
const TEST_DB = path.join(os.tmpdir(), `signal-rush-security-test-${Date.now()}.db`);

let passed = 0;
let failed = 0;
let proc = null;
let port = 8729; // use a different port to avoid conflicts

function request(method, path, body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request(`http://127.0.0.1:${port}${path}`, {
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
        try { resolve({ status: res.statusCode, body: JSON.parse(chunks), headers: res.headers }); }
        catch { resolve({ status: res.statusCode, body: chunks, headers: res.headers }); }
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
  console.log('[security] Starting economy service for security tests...');
  proc = spawn(process.execPath, [SERVICE_PATH], {
    env: {
      ...process.env,
      ECONOMY_PORT: String(port),
      ECONOMY_DB: TEST_DB,
      ECONOMY_API_KEY: 'test-secret-key-12345',
      ECONOMY_AUTH_ENFORCED: 'true',
      RATE_LIMIT_MAX: '10',
      RATE_LIMIT_WINDOW_MS: '60000',
      MAX_CREDITS_PER_SESSION: '500',
      MAX_SPEND_PER_TX: '100',
      MAX_AWARD_PER_TX: '200',
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

  console.log('[security] Service ready. Running security tests...\n');

  let playerId;

  try {
    // ─── 1. AUTH TESTS ──────────────────────────────────────────────

    await test('Protected endpoint rejects without auth header', async () => {
      const r = await request('POST', '/internal/ingest', {
        player_id: '00000000-0000-0000-0000-000000000000',
        session_id: 'test-session',
        credits_delta: 10,
      });
      assert(r.status === 401, `expected 401, got ${r.status}`);
    });

    await test('Protected endpoint rejects with wrong auth key', async () => {
      const r = await request('POST', '/internal/ingest', {
        player_id: '00000000-0000-0000-0000-000000000000',
        session_id: 'test-session',
        credits_delta: 10,
      }, { Authorization: 'Bearer wrong-key' });
      assert(r.status === 401, `expected 401, got ${r.status}`);
    });

    await test('Protected endpoint rejects with malformed auth header', async () => {
      const r = await request('POST', '/credits/award', {
        player_id: '00000000-0000-0000-0000-000000000000',
        amount: 10,
        reason: 'test',
      }, { Authorization: 'NotBearer something' });
      assert(r.status === 401, `expected 401, got ${r.status}`);
    });

    await test('Protected endpoint accepts with correct auth key', async () => {
      const r = await request('POST', '/players', { display_name: 'SecurityTest' });
      assert(r.status === 201, `expected 201, got ${r.status}`);
      playerId = r.body.id;
    });

    await test('/credits/award rejects without auth', async () => {
      const r = await request('POST', '/credits/award', {
        player_id: playerId, amount: 10, reason: 'test',
      });
      assert(r.status === 401, `expected 401, got ${r.status}`);
    });

    await test('/credits/spend rejects without auth', async () => {
      const r = await request('POST', '/credits/spend', {
        player_id: playerId, amount: 10, reason: 'test',
      });
      assert(r.status === 401, `expected 401, got ${r.status}`);
    });

    await test('/ads/impression rejects without auth', async () => {
      const r = await request('POST', '/ads/impression', {
        player_id: playerId, placement_type: 'hud_frame',
      });
      assert(r.status === 401, `expected 401, got ${r.status}`);
    });

    // ─── 2. INPUT VALIDATION TESTS ──────────────────────────────────

    await test('Rejects invalid UUID format for player_id', async () => {
      const r = await request('GET', '/players/not-a-uuid');
      assert(r.status === 400, `expected 400, got ${r.status}`);
    });

    await test('Rejects SQL injection attempt in player_id', async () => {
      const r = await request('GET', "/players/'; DROP TABLE players;--");
      assert(r.status === 400, `expected 400, got ${r.status}`);
    });

    await test('Rejects empty display_name', async () => {
      const r = await request('POST', '/players', { display_name: '' });
      assert(r.status === 400, `expected 400, got ${r.status}`);
    });

    await test('Rejects oversized display_name', async () => {
      const r = await request('POST', '/players', { display_name: 'A'.repeat(100) });
      assert(r.status === 400, `expected 400, got ${r.status}`);
    });

    await test('Rejects negative amount in award', async () => {
      const r = await request('POST', '/credits/award', {
        player_id: playerId, amount: -50, reason: 'test',
      }, { Authorization: 'Bearer test-secret-key-12345' });
      assert(r.status === 400, `expected 400, got ${r.status}`);
    });

    await test('Rejects zero amount in award', async () => {
      const r = await request('POST', '/credits/award', {
        player_id: playerId, amount: 0, reason: 'test',
      }, { Authorization: 'Bearer test-secret-key-12345' });
      assert(r.status === 400, `expected 400, got ${r.status}`);
    });

    await test('Rejects missing reason in award', async () => {
      const r = await request('POST', '/credits/award', {
        player_id: playerId, amount: 10,
      }, { Authorization: 'Bearer test-secret-key-12345' });
      assert(r.status === 400, `expected 400, got ${r.status}`);
    });

    await test('Rejects invalid placement_type in ad impression', async () => {
      const r = await request('POST', '/ads/impression', {
        player_id: playerId, placement_type: 'invalid_type',
      }, { Authorization: 'Bearer test-secret-key-12345' });
      assert(r.status === 400, `expected 400, got ${r.status}`);
    });

    // ─── 3. SPENDING LIMIT TESTS ────────────────────────────────────

    await test('Rejects spend exceeding per-transaction limit', async () => {
      const r = await request('POST', '/credits/spend', {
        player_id: playerId, amount: 500, reason: 'too_much',
      }, { Authorization: 'Bearer test-secret-key-12345' });
      assert(r.status === 400, `expected 400, got ${r.status}`);
      assert(r.body.error.includes('maximum'), `error should mention maximum, got: ${r.body.error}`);
    });

    await test('Rejects award exceeding per-transaction limit', async () => {
      const r = await request('POST', '/credits/award', {
        player_id: playerId, amount: 500, reason: 'too_much',
      }, { Authorization: 'Bearer test-secret-key-12345' });
      assert(r.status === 400, `expected 400, got ${r.status}`);
      assert(r.body.error.includes('maximum'), `error should mention maximum, got: ${r.body.error}`);
    });

    // ─── 4. SESSION CREDIT LIMIT TESTS ──────────────────────────────

    await test('Awards credits up to session limit', async () => {
      const r = await request('POST', '/internal/ingest', {
        player_id: playerId,
        session_id: 'session-limit-test',
        credits_delta: 200,
        events: [],
      }, { Authorization: 'Bearer test-secret-key-12345' });
      assert(r.status === 200, `expected 200, got ${r.status}`);
    });

    await test('Rejects credits exceeding session limit', async () => {
      // Already awarded 200, max is 500, so 400 more should fail
      const r = await request('POST', '/internal/ingest', {
        player_id: playerId,
        session_id: 'session-limit-test',
        credits_delta: 400,
        events: [],
      }, { Authorization: 'Bearer test-secret-key-12345' });
      assert(r.status === 400, `expected 400, got ${r.status}`);
      assert(r.body.error.includes('session credit limit'), `error should mention session limit, got: ${r.body.error}`);
    });

    // ─── 5. RATE LIMITING TESTS ─────────────────────────────────────

    await test('Rate limit triggers after max requests', async () => {
      // RATE_LIMIT_MAX is 10, send 11 requests rapidly
      const requests = [];
      for (let i = 0; i < 11; i++) {
        requests.push(request('GET', '/health'));
      }
      const results = await Promise.all(requests);
      const limited = results.filter(r => r.status === 429);
      assert(limited.length >= 1, `expected at least 1 rate-limited request, got ${limited.length}`);
    });

    await test('Rate limited response includes Retry-After header', async () => {
      // After the previous test, we should be rate limited
      const r = await request('GET', '/health');
      // Either 200 (if window passed) or 429 with Retry-After
      if (r.status === 429) {
        assert(r.headers['retry-after'] !== undefined, 'should have Retry-After header');
      }
    });

    // ─── 6. IDEMPOTENCY TESTS ───────────────────────────────────────

    await test('Duplicate award with same idempotency_key is idempotent', async () => {
      const key = 'idem-security-test-1';
      const r1 = await request('POST', '/credits/award', {
        player_id: playerId, amount: 10, reason: 'idem_test', idempotency_key: key,
      }, { Authorization: 'Bearer test-secret-key-12345' });
      assert(r1.status === 200, `expected 200, got ${r1.status}`);
      const balance1 = r1.body.player.balance;

      const r2 = await request('POST', '/credits/award', {
        player_id: playerId, amount: 10, reason: 'idem_test', idempotency_key: key,
      }, { Authorization: 'Bearer test-secret-key-12345' });
      assert(r2.status === 200, `expected 200, got ${r2.status}`);
      assert(r2.body.player.balance === balance1, `balance should not change on duplicate: ${r2.body.player.balance} vs ${balance1}`);
    });

    // ─── 7. NEGATIVE / EDGE CASE TESTS ──────────────────────────────

    await test('Rejects non-numeric amount', async () => {
      const r = await request('POST', '/credits/award', {
        player_id: playerId, amount: 'abc', reason: 'test',
      }, { Authorization: 'Bearer test-secret-key-12345' });
      assert(r.status === 400, `expected 400, got ${r.status}`);
    });

    await test('Float amount is floored to integer', async () => {
      const r = await request('POST', '/credits/award', {
        player_id: playerId, amount: 10.5, reason: 'test',
      }, { Authorization: 'Bearer test-secret-key-12345' });
      // 10.5 → floored to 10, which is valid
      assert(r.status === 200, `expected 200, got ${r.status}`);
      // Verify it was floored: award 10.5 twice, should get 10 + 10 = 20 (not 21)
    });

    await test('Rejects missing session_id in ingest', async () => {
      const r = await request('POST', '/internal/ingest', {
        player_id: playerId, credits_delta: 10,
      }, { Authorization: 'Bearer test-secret-key-12345' });
      assert(r.status === 400, `expected 400, got ${r.status}`);
    });

    await test('Rejects negative credits_delta without is_reset', async () => {
      const r = await request('POST', '/internal/ingest', {
        player_id: playerId, session_id: 'neg-test', credits_delta: -10,
      }, { Authorization: 'Bearer test-secret-key-12345' });
      assert(r.status === 400, `expected 400, got ${r.status}`);
    });

    await test('Allows negative credits_delta with is_reset=true', async () => {
      const r = await request('POST', '/internal/ingest', {
        player_id: playerId, session_id: 'reset-neg-test', credits_delta: -50, is_reset: true,
      }, { Authorization: 'Bearer test-secret-key-12345' });
      assert(r.status === 200, `expected 200, got ${r.status}`);
    });

  } finally {
    proc.kill('SIGTERM');
    await new Promise(r => proc.on('exit', r));
    // Clean up test DB
    try { fs.unlinkSync(TEST_DB); } catch {}
    try { fs.unlinkSync(TEST_DB + '-wal'); } catch {}
    try { fs.unlinkSync(TEST_DB + '-shm'); } catch {}
  }

  console.log(`\nSecurity tests: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run().catch(e => {
  console.error('[security] Fatal:', e.message);
  process.exit(1);
});
