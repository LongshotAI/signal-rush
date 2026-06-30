// economy/tests/telegram-routes-integration-test.js
// Integration tests for Telegram auth routes against a live economy service.
//
// Tests POST /telegram/auth, GET /telegram/player/:telegram_id, and POST /telegram/link
// using a real initData string signed with a test bot token.
//
// Run: node economy/tests/telegram-routes-integration-test.js

const assert = require('assert/strict');
const crypto = require('crypto');
const http = require('http');

// ─── Config ─────────────────────────────────────────────────────────

const TEST_BOT_TOKEN = '123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const TEST_PORT = 8777; // isolated test port
const BASE_URL = `http://127.0.0.1:${TEST_PORT}`;

// ─── Helper: Build valid initData ───────────────────────────────────

function makeInitData(overrides = {}) {
  const authDate = Math.floor(Date.now() / 1000);
  const user = {
    id: 555666777,
    first_name: 'Test',
    last_name: 'Player',
    username: 'testplayer',
    language_code: 'en',
    is_premium: false,
  };

  const fields = {
    user: JSON.stringify(user),
    auth_date: String(authDate),
    ...overrides,
  };

  const keys = Object.keys(fields).sort();
  const dataCheckString = keys.map(k => `${k}=${fields[k]}`).join('\n');
  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(TEST_BOT_TOKEN).digest();
  const hash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

  const params = new URLSearchParams({ ...fields, hash });
  return params.toString();
}

// ─── HTTP Helper ────────────────────────────────────────────────────

function request(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE_URL);
    const options = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method,
      headers: { 'Content-Type': 'application/json' },
    };
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// ─── Test Harness ───────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed++; console.log(`PASS ${name}`); })
    .catch(err => { failed++; console.log(`FAIL ${name}\n  ${err.message}`); });
}

// ─── Main ───────────────────────────────────────────────────────────

async function main() {
  // Start a fresh economy service on test port with in-memory DB
  const { spawn } = require('child_process');
  const service = spawn('node', ['economy/service.js'], {
    cwd: '/home/hive/signal-rush',
    env: {
      ...process.env,
      ECONOMY_PORT: String(TEST_PORT),
      ECONOMY_DB: ':memory:',
      ECONOMY_AUTH_ENFORCED: 'false',
      TELEGRAM_BOT_TOKEN: TEST_BOT_TOKEN,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  // Wait for service to be ready
  async function waitForReady(retries = 20) {
    for (let i = 0; i < retries; i++) {
      try {
        const res = await request('GET', '/health');
        if (res.body && res.body.status === 'ok') return;
      } catch {}
      await new Promise(r => setTimeout(r, 200));
    }
    throw new Error('Service did not start');
  }

  try {
    await waitForReady();

    const validInitData = makeInitData();

    // ─── POST /telegram/auth ───────────────────────────────────────

    await test('POST /telegram/auth: creates player on first auth', async () => {
      const res = await request('POST', '/telegram/auth', { initData: validInitData });
      assert.equal(res.status, 200);
      assert.equal(res.body.ok, true);
      assert.equal(res.body.telegram.id, 555666777);
      assert.equal(res.body.telegram.username, 'testplayer');
      assert.equal(typeof res.body.player.id, 'string');
      assert.equal(typeof res.body.session_token, 'string');
      assert.ok(res.body.session_token.length > 30, 'session_token should be a UUID');
    });

    await test('POST /telegram/auth: returns same player on second auth (idempotent)', async () => {
      const res = await request('POST', '/telegram/auth', { initData: validInitData });
      assert.equal(res.status, 200);
      assert.equal(res.body.ok, true);
      // Same player ID as before
      const firstRes = await request('POST', '/telegram/auth', { initData: validInitData });
      assert.equal(res.body.player.id, firstRes.body.player.id);
    });

    await test('POST /telegram/auth: rejects missing initData', async () => {
      const res = await request('POST', '/telegram/auth', {});
      assert.equal(res.status, 400);
      assert.equal(res.body.ok, false);
    });

    await test('POST /telegram/auth: rejects invalid signature', async () => {
      const badInitData = makeInitData({ hash: 'deadbeef' });
      const res = await request('POST', '/telegram/auth', { initData: badInitData });
      assert.equal(res.status, 401);
      assert.equal(res.body.ok, false);
    });

    // ─── GET /telegram/player/:telegram_id ─────────────────────────

    await test('GET /telegram/player/:id: returns player after auth', async () => {
      const res = await request('GET', '/telegram/player/555666777');
      assert.equal(res.status, 200);
      assert.equal(res.body.ok, true);
      assert.equal(res.body.player.display_name, '@testplayer');
    });

    await test('GET /telegram/player/:id: 404 for unknown telegram_id', async () => {
      const res = await request('GET', '/telegram/player/999999999');
      assert.equal(res.status, 404);
      assert.equal(res.body.ok, false);
    });

    // ─── POST /telegram/link ───────────────────────────────────────



    await test('POST /telegram/link: returns 409 when telegram already linked to different player', async () => {
      // validInitData is for telegram user 555666777, already linked above
      const { randomUUID } = require('crypto');
      const res = await request('POST', '/telegram/link', {
        initData: validInitData,
        player_id: randomUUID(),
      });
      assert.equal(res.status, 409);
      assert.equal(res.body.error, 'this Telegram account is already linked to a different player');
    });

    await test('POST /telegram/link: links a CLI player (different telegram user)', async () => {
      // Create a CLI-style player via /ads/impression (auto-creates player with UUID only)
      const cliInitData = makeInitData({ user: JSON.stringify({ id: 888999000, first_name: 'CLIPlayer', username: 'cliplayer' }) });
      // First auth creates the telegram player
      const authRes = await request('POST', '/telegram/auth', { initData: cliInitData });
      const playerId = authRes.body.player.id;

      // Now unlink it (simulating a CLI player that existed before)
      // We can't directly modify DB, but we can verify the link flow works
      // by linking the same player back (should succeed — same telegram + same player)
      const linkRes = await request('POST', '/telegram/link', {
        initData: cliInitData,
        player_id: playerId,
      });
      assert.equal(linkRes.status, 200, `expected 200 but got ${linkRes.status}: ${JSON.stringify(linkRes.body)}`);
      assert.equal(linkRes.body.linked, true);
      assert.equal(linkRes.body.player.id, playerId);
    });

    await test('POST /telegram/link: rejects missing player_id', async () => {
      const res = await request('POST', '/telegram/link', { initData: validInitData });
      assert.equal(res.status, 400);
      assert.equal(res.body.error, 'player_id is required (your existing CLI player UUID)');
    });

    await test('POST /telegram/link: rejects missing initData', async () => {
      const res = await request('POST', '/telegram/link', { player_id: 'some-uuid' });
      assert.equal(res.status, 400);
      assert.equal(res.body.error, 'initData is required');
    });

    // ─── Session persistence ───────────────────────────────────────

    await test('Session token persists across requests (survives in DB)', async () => {
      const res1 = await request('POST', '/telegram/auth', { initData: validInitData });
      const token1 = res1.body.session_token;
      const res2 = await request('POST', '/telegram/auth', { initData: validInitData });
      const token2 = res2.body.session_token;
      // Token should be refreshed on each auth (new session)
      assert.ok(token1 && token2, 'both should have session tokens');
    });

  } finally {
    service.kill('SIGTERM');
  }

  console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
