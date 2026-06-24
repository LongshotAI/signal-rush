// src/core/tests/eventBridge-test.js
// Unit tests for the event bridge (ad impression logging only)
//
// NOTE: forwardStep was REMOVED. The old credit-diffing flow sent credits_delta
// to /internal/ingest — that code path is dead. The bridge now only logs
// ad impressions via logAdImpression(). All sponsor_impression handling is
// done directly in the CLI game loop and Mini App with proper campaign_id context.

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
let receivedEndpoints = [];
let mockShouldFail = false;

function setupMockServer() {
  return new Promise((resolve) => {
    receivedPayloads = [];
    receivedEndpoints = [];
    mockShouldFail = false;
    mockServer = http.createServer((req, res) => {
      let chunks = '';
      receivedEndpoints.push(req.url);
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
    const campaignId = 'test-campaign-uuid';

    // ─── logAdImpression Tests ─────────────────────────────────────

    await test('logAdImpression sends HUD impression with campaign_id', async () => {
      const beforeCount = receivedPayloads.length;
      await eventBridge.logAdImpression(playerId, 'hud_frame', campaignId);
      assert.equal(receivedPayloads.length, beforeCount + 1, 'should have sent 1 payload');
      const p = receivedPayloads[receivedPayloads.length - 1];
      assert.equal(p.campaign_id, campaignId);
      assert.equal(p.player_id, playerId);
      assert.equal(p.placement_type, 'hud_frame');
    });

    await test('logAdImpression sends interstitial impression', async () => {
      const beforeCount = receivedPayloads.length;
      await eventBridge.logAdImpression(playerId, 'interstitial', campaignId);
      assert.equal(receivedPayloads.length, beforeCount + 1);
      const p = receivedPayloads[receivedPayloads.length - 1];
      assert.equal(p.placement_type, 'interstitial');
    });

    await test('logAdImpression sends house ad impression (null campaign)', async () => {
      const beforeCount = receivedPayloads.length;
      await eventBridge.logAdImpression(playerId, 'hud_frame', null);
      assert.equal(receivedPayloads.length, beforeCount + 1);
      const p = receivedPayloads[receivedPayloads.length - 1];
      assert.equal(p.campaign_id, null);
    });

    await test('logAdImpression sends to correct endpoint', async () => {
      const lastIdx = receivedEndpoints.length;
      await eventBridge.logAdImpression(playerId, 'hud_frame', campaignId);
      assert(receivedEndpoints[receivedEndpoints.length - 1].includes('/ads/impression'),
        'endpoint should be /ads/impression');
    });

    await test('logAdImpression queues when economy service is down', async () => {
      const beforeCount = receivedPayloads.length;
      mockShouldFail = true;

      await eventBridge.logAdImpression(playerId, 'hud_frame', campaignId);

      // Queue should exist now
      assert(fs.existsSync(queueFile), 'queue file should exist');
      const queue = JSON.parse(fs.readFileSync(queueFile, 'utf8'));
      assert(queue.length > 0, 'queue should have pending events');
      const lastItem = queue[queue.length - 1];
      assert(lastItem.endpoint.includes('/ads/impression'), 'queued item should use ads endpoint');
      assert.equal(lastItem.payload.campaign_id, campaignId);

      mockShouldFail = false;
      await eventBridge.flushQueue();
      assert(receivedPayloads.length > beforeCount, 'payload delivered after flush');
    });

    // ─── enqueue / flush tests ─────────────────────────────────────

    await test('enqueue adds to queue and persists', async () => {
      const beforeCount = JSON.parse(fs.readFileSync(queueFile, 'utf8')).length;
      eventBridge.enqueue('/ads/impression', { player_id: playerId, campaign_id: 'test' });
      const queue = JSON.parse(fs.readFileSync(queueFile, 'utf8'));
      assert(queue.length > beforeCount, 'queue should have grown');
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