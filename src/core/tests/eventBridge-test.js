// src/core/tests/eventBridge-test.js
// Unit tests for the event bridge
// Tests credit diffing logic, reset handling, queue management, and HTTP forwarding

// IMPORTANT: Set mock server env vars BEFORE requiring the bridge module
process.env.ECONOMY_PORT = '18720';
process.env.ECONOMY_HOST = '127.0.0.1';

const assert = require('assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const eventBridge = require('../eventBridge');

let passed = 0;
let failed = 0;
let mockServer = null;
let receivedPayloads = [];
let mockShouldFail = false;

function setupMockServer() {
  return new Promise((resolve) => {
    receivedPayloads = [];
    mockShouldFail = false;
    mockServer = http.createServer((req, res) => {
      let chunks = '';
      req.on('data', d => chunks += d);
      req.on('end', () => {
        if (mockShouldFail) {
          res.writeHead(500);
          res.end('Internal Server Error');
          return;
        }
        try {
          receivedPayloads.push(JSON.parse(chunks));
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } catch {
          res.writeHead(400);
          res.end('Bad JSON');
        }
      });
    });
    mockServer.listen(18720, '127.0.0.1', () => resolve());
  });
}

function teardownMockServer() {
  return new Promise((resolve) => {
    if (mockServer) {
      mockServer.close(() => resolve());
    } else {
      resolve();
    }
  });
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
  await setupMockServer();

  // Clear any existing queue
  const queueFile = path.join(os.homedir(), '.signal-rush', 'event-queue.json');
  try { fs.unlinkSync(queueFile); } catch {}

  try {
    const playerId = 'test-player-uuid';
    const sessionId = 'test-session-uuid';

    // ─── Credit Diffing Tests ─────────────────────────────────────

    await test('forwardStep detects positive credit delta (pickup)', async () => {
      const engine = { state: { credits: 5, lastEvents: [{ type: 'pickup_collected', value: 40 }] } };
      await eventBridge.forwardStep(playerId, sessionId, engine, 0);

      assert.equal(receivedPayloads.length, 1, 'should have sent 1 payload');
      const p = receivedPayloads[receivedPayloads.length - 1];
      assert.equal(p.credits_delta, 5, 'delta should be 5');
      assert.equal(p.is_reset, false, 'should not be reset');
      assert.equal(p.player_id, playerId);
      assert.equal(p.session_id, sessionId);
      assert.equal(p.events.length, 1);
    });

    await test('forwardStep detects zero delta (no-op)', async () => {
      const engine = { state: { credits: 5, lastEvents: [{ type: 'player_moved' }] } };
      await eventBridge.forwardStep(playerId, sessionId, engine, 5);

      const p = receivedPayloads[receivedPayloads.length - 1];
      assert.equal(p.credits_delta, 0, 'delta should be 0');
      assert.equal(p.is_reset, false);
    });

    await test('forwardStep detects reset (credits to 0)', async () => {
      const engine = { state: { credits: 0, lastEvents: [{ type: 'run_restarted' }] } };
      await eventBridge.forwardStep(playerId, sessionId, engine, 50);

      const p = receivedPayloads[receivedPayloads.length - 1];
      assert.equal(p.credits_delta, 0, 'delta should be 0 on reset');
      assert.equal(p.is_reset, true, 'should be marked as reset');
    });

    // ─── Multiple Steps Test ──────────────────────────────────────

    await test('forwardStep handles multiple sequential steps', async () => {
      const steps = [
        { before: 0, after: 3, events: [{ type: 'pickup_collected' }] },
        { before: 3, after: 8, events: [{ type: 'pickup_collected' }] },
        { before: 8, after: 8, events: [{ type: 'player_moved' }] },
        { before: 8, after: 15, events: [{ type: 'level_cleared', level: 1 }] },
      ];

      for (const step of steps) {
        const engine = { state: { credits: step.after, lastEvents: step.events } };
        await eventBridge.forwardStep(playerId, sessionId + '-multi', engine, step.before);
      }

      const newPayloads = receivedPayloads.slice(-4);
      assert.equal(newPayloads[0].credits_delta, 3);
      assert.equal(newPayloads[1].credits_delta, 5);
      assert.equal(newPayloads[2].credits_delta, 0);
      assert.equal(newPayloads[3].credits_delta, 7);
    });

    // ─── Game Over + Restart Test ─────────────────────────────────

    await test('forwardStep handles game over then restart', async () => {
      const beforeCount = receivedPayloads.length;

      const gameOverEngine = {
        state: { credits: 100, lastEvents: [{ type: 'run_ended', deathState: { finalScore: 500 } }] },
      };
      await eventBridge.forwardStep(playerId, sessionId + '-eol', gameOverEngine, 100);

      const restartEngine = {
        state: { credits: 0, lastEvents: [{ type: 'run_restarted' }] },
      };
      await eventBridge.forwardStep(playerId, sessionId + '-eol', restartEngine, 100);

      const newPayloads = receivedPayloads.slice(beforeCount);
      assert.equal(newPayloads[0].credits_delta, 0, 'game over: no delta');
      assert.equal(newPayloads[0].is_reset, false, 'game over: not a reset');
      assert.equal(newPayloads[1].credits_delta, 0, 'restart: delta is 0');
      assert.equal(newPayloads[1].is_reset, true, 'restart: marked as reset');
    });

    // ─── Queue / Retry Test ───────────────────────────────────────

    await test('forwardStep queues when economy service is down', async () => {
      const beforeCount = receivedPayloads.length;
      mockShouldFail = true;

      const engine = { state: { credits: 10, lastEvents: [{ type: 'pickup_collected' }] } };
      await eventBridge.forwardStep(playerId, sessionId + '-fail', engine, 0);

      assert.equal(receivedPayloads.length, beforeCount, 'no new payloads when service down');
      assert(fs.existsSync(queueFile), 'queue file should exist');
      const queue = JSON.parse(fs.readFileSync(queueFile, 'utf8'));
      assert(queue.length > 0, 'queue should have pending events');

      mockShouldFail = false;
      await eventBridge.flushQueue();
      assert(receivedPayloads.length > beforeCount, 'payload delivered after flush');
    });

    // ─── getPlayerId Test ──────────────────────────────────────────

    await test('getPlayerId returns existing player', async () => {
      const id1 = eventBridge.getPlayerId();
      const id2 = eventBridge.getPlayerId();
      assert.equal(id1, id2, 'should return same player id');
      const playerFile = path.join(os.homedir(), '.signal-rush', 'player.json');
      const data = JSON.parse(fs.readFileSync(playerFile, 'utf8'));
      assert.equal(data.player_id, id1, 'player file should match');
    });

  } finally {
    await teardownMockServer();
    try { fs.unlinkSync(queueFile); } catch {}
  }

  console.log(`\nEventBridge tests: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run().catch(e => {
  console.error('Fatal:', e.message);
  process.exit(1);
});
