// economy/tests/integration-test.js
// Integration test: start the service, hit every endpoint with curl, verify responses
// This proves the full stack works: HTTP → Fastify → ledger → SQLite

const { spawn } = require('child_process');
const path = require('path');
const http = require('http');

const SERVICE_PATH = path.join(__dirname, '..', 'service.js');
const PORT = 8720;
const BASE = `http://127.0.0.1:${PORT}`;

let passed = 0;
let failed = 0;

function request(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request(`${BASE}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
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
  // Start the service
  console.log('[integration] Starting economy service...');
  const proc = spawn(process.execPath, [SERVICE_PATH], {
    env: { ...process.env, ECONOMY_PORT: String(PORT), ECONOMY_DB: ':memory:', ECONOMY_AUTH_ENFORCED: 'false' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  // Wait for service to be ready
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
      if (code !== 0) {
        clearTimeout(timeout);
        reject(new Error(`Service exited with code ${code}`));
      }
    });
  });

  console.log('[integration] Service ready. Running tests...\n');

  try {
    // ─── Health Check ────────────────────────────────────────────
    await test('GET /health returns ok', async () => {
      const r = await request('GET', '/health');
      assert(r.status === 200, `expected 200, got ${r.status}`);
      assert(r.body.status === 'ok', `expected status ok, got ${r.body.status}`);
    });

    // ─── Player CRUD ─────────────────────────────────────────────
    let playerId;

    await test('POST /players creates player', async () => {
      const r = await request('POST', '/players', { display_name: 'IntegrationTest' });
      assert(r.status === 201, `expected 201, got ${r.status}`);
      assert(r.body.id, 'should have id');
      assert(r.body.display_name === 'IntegrationTest', 'name should match');
      assert(r.body.balance === 0, 'balance should be 0');
      playerId = r.body.id;
    });

    await test('POST /players rejects empty name', async () => {
      const r = await request('POST', '/players', { display_name: '' });
      assert(r.status === 400, `expected 400, got ${r.status}`);
    });

    await test('POST /players rejects missing name', async () => {
      const r = await request('POST', '/players', {});
      assert(r.status === 400, `expected 400, got ${r.status}`);
    });

    await test('GET /players/:id returns player', async () => {
      const r = await request('GET', `/players/${playerId}`);
      assert(r.status === 200, `expected 200, got ${r.status}`);
      assert(r.body.id === playerId, 'id should match');
    });

    await test('GET /players/:id returns 404 for unknown', async () => {
      const r = await request('GET', '/players/00000000-0000-0000-0000-000000000000');
      assert(r.status === 404, `expected 404, got ${r.status}`);
    });

    // ─── Credit Operations ───────────────────────────────────────
    await test('POST /credits/award adds credits', async () => {
      const r = await request('POST', '/credits/award', {
        player_id: playerId,
        amount: 50,
        reason: 'test_award',
      });
      assert(r.status === 200, `expected 200, got ${r.status}`);
      assert(r.body.player.balance === 50, `expected balance 50, got ${r.body.player.balance}`);
    });

    await test('POST /credits/award is idempotent', async () => {
      const r1 = await request('POST', '/credits/award', {
        player_id: playerId, amount: 25, reason: 'idem_test',
        idempotency_key: 'idem-123',
      });
      assert(r1.body.player.balance === 75, `expected 75, got ${r1.body.player.balance}`);

      const r2 = await request('POST', '/credits/award', {
        player_id: playerId, amount: 25, reason: 'idem_test',
        idempotency_key: 'idem-123',
      });
      assert(r2.body.player.balance === 75, `expected still 75, got ${r2.body.player.balance}`);
    });

    await test('POST /credits/spend deducts credits', async () => {
      const r = await request('POST', '/credits/spend', {
        player_id: playerId, amount: 20, reason: 'test_spend',
      });
      assert(r.status === 200, `expected 200, got ${r.status}`);
      assert(r.body.player.balance === 55, `expected 55, got ${r.body.player.balance}`);
    });

    await test('POST /credits/spend fails with insufficient balance', async () => {
      const r = await request('POST', '/credits/spend', {
        player_id: playerId, amount: 999, reason: 'too_much',
      });
      assert(r.status === 409, `expected 409, got ${r.status}`);
    });

    // ─── Transaction History ─────────────────────────────────────
    await test('GET /players/:id/transactions returns history', async () => {
      const r = await request('GET', `/players/${playerId}/transactions`);
      assert(r.status === 200, `expected 200, got ${r.status}`);
      assert(r.body.transactions.length >= 3, `expected >= 3 transactions, got ${r.body.transactions.length}`);
      assert(r.body.total >= 3, `expected total >= 3, got ${r.body.total}`);
    });

    // ─── Internal Ingest (event bridge simulation) ───────────────
    await test('POST /internal/ingest processes credit delta', async () => {
      const r = await request('POST', '/internal/ingest', {
        player_id: playerId,
        session_id: 'test-session-1',
        credits_delta: 10,
        events: [{ type: 'pickup_collected', value: 40 }],
      });
      assert(r.status === 200, `expected 200, got ${r.status}`);
      assert(r.body.creditsAwarded === 10, `expected 10 awarded, got ${r.body.creditsAwarded}`);

      const player = await request('GET', `/players/${playerId}`);
      assert(player.body.balance === 65, `expected 65, got ${player.body.balance}`);
    });

    await test('POST /internal/ingest handles reset correctly', async () => {
      const r = await request('POST', '/internal/ingest', {
        player_id: playerId,
        session_id: 'test-session-1',
        credits_delta: -65,
        is_reset: true,
        events: [{ type: 'run_restarted' }],
      });
      assert(r.status === 200, `expected 200, got ${r.status}`);
      assert(r.body.reset === true, 'should be marked as reset');
    });

    await test('POST /internal/ingest rejects missing session_id', async () => {
      const r = await request('POST', '/internal/ingest', { player_id: playerId });
      assert(r.status === 400, `expected 400, got ${r.status}`);
    });

    // ─── Tracking / Analytics ────────────────────────────────────
    await test('GET /tracking/events returns events', async () => {
      const r = await request('GET', `/tracking/events?session_id=test-session-1`);
      assert(r.status === 200, `expected 200, got ${r.status}`);
      assert(r.body.length >= 1, `expected >= 1 event, got ${r.body.length}`);
    });

    await test('GET /tracking/summary returns player summary', async () => {
      const r = await request('GET', `/tracking/summary?player_id=${playerId}`);
      assert(r.status === 200, `expected 200, got ${r.status}`);
      assert(r.body.player !== undefined, 'should have player');
      assert(r.body.sessions >= 1, `expected >= 1 session, got ${r.body.sessions}`);
    });

    // ─── Ad Impressions ──────────────────────────────────────────
    await test('POST /ads/impression logs impression', async () => {
      const r = await request('POST', '/ads/impression', {
        campaign_id: 'camp-test-1',
        player_id: playerId,
        placement_type: 'hud_frame',
        cost_micros: 500,
      });
      assert(r.status === 200, `expected 200, got ${r.status}`);
      assert(r.body.impression_id, 'should return impression_id');
    });

    // ─── Summary ─────────────────────────────────────────────────
    await test('GET /players/:id/summary returns full summary', async () => {
      const r = await request('GET', `/players/${playerId}/summary`);
      assert(r.status === 200, `expected 200, got ${r.status}`);
      assert(r.body.player.balance >= 0, 'balance should be non-negative');
      assert(r.body.sessions >= 1, 'should have sessions');
      assert(r.body.events >= 1, 'should have events');
    });

  } finally {
    proc.kill('SIGTERM');
    await new Promise(r => proc.on('exit', r));
  }

  console.log(`\nIntegration tests: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run().catch(e => {
  console.error('[integration] Fatal:', e.message);
  process.exit(1);
});
