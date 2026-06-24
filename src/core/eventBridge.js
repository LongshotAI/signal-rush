// src/core/eventBridge.js
// Signal Rush — Event Bridge
//
// Sits between the CLI game loop and the economy service.
// Forwards sponsor impression events to the ad system.
// NOTE: The old credit-diffing /internal/ingest flow is REMOVED.
// The only redeemable value comes from the 20% ad-funded rewards pool.
// The CLI and Mini App handle sponsor_impression events directly with
// proper campaign_id context — see src/cli/index.js and telegram-mini-app/game.js.

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const { randomUUID } = require('crypto');

// ─── Ad Impression Logging ─────────────────────────────────────────

/**
 * Log an ad impression to the economy service.
 * Fire-and-forget: if the economy service is down, the impression is queued
 * for later retry so impressions are not silently lost.
 *
 * @param {string} playerId - The player's UUID
 * @param {string} placementType - 'hud_frame' or 'interstitial'
 * @param {string|null} campaignId - The campaign UUID (null for house ads)
 */
async function logAdImpression(playerId, placementType = 'hud_frame', campaignId = null) {
  const payload = {
    campaign_id: campaignId,
    player_id: playerId,
    placement_type: placementType,
    cost_micros: 0, // house ads cost 0; campaign ads use server-side CPM
  };

  try {
    await postToEconomyPayload('/ads/impression', payload);
  } catch {
    // Economy service is down — queue the impression for later retry
    enqueue('/ads/impression', payload);
  }
}

// ─── HTTP Helper ───────────────────────────────────────────────────

function postToEconomy(data) {
  return postToEconomyPayload('/internal/ingest', data);
}

function postToEconomyPayload(endpoint, payload) {
  const { hostname, port } = getEconomyHost();
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = http.request(
      {
        hostname,
        port,
        path: endpoint,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
        timeout: 500, // don't block the game loop
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => resolve(data));
      },
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('timeout'));
    });
    req.write(body);
    req.end();
  });
}

function getEconomyHost() {
  const port = parseInt(process.env.ECONOMY_PORT) || 8720;
  const host = process.env.ECONOMY_HOST || '127.0.0.1';
  return { hostname: host, port };
}

// ─── Queue for Offline Economy Service ─────────────────────────────

const QUEUE_DIR = path.join(os.homedir(), '.signal-rush');
const QUEUE_FILE = path.join(QUEUE_DIR, 'event-queue.json');

let pendingQueue = [];
let flushInProgress = false;

loadQueue();

function ensureQueueDir() {
  if (!fs.existsSync(QUEUE_DIR)) {
    fs.mkdirSync(QUEUE_DIR, { recursive: true });
  }
}

function saveQueue() {
  try {
    ensureQueueDir();
    fs.writeFileSync(QUEUE_FILE, JSON.stringify(pendingQueue));
  } catch {
    // Best-effort — queue is in-memory only if persist fails
  }
}

function loadQueue() {
  try {
    if (fs.existsSync(QUEUE_FILE)) {
      const raw = fs.readFileSync(QUEUE_FILE, 'utf-8');
      pendingQueue = JSON.parse(raw);
      // Clean out stale queue entries older than 1 hour
      const oneHourAgo = Date.now() - 60 * 60 * 1000;
      pendingQueue = pendingQueue.filter((item) => {
        const ts = item.timestamp ? new Date(item.timestamp).getTime() : 0;
        return ts > oneHourAgo;
      });
    }
  } catch {
    pendingQueue = [];
  }
}

/**
 * Enqueue a payload for later retry when the economy service is down.
 *
 * Two styles:
 *   enqueue('/ads/impression', payload)   — new-style with explicit endpoint
 *   enqueue(payload)                       — old-style (deprecated, for backward compat)
 */
function enqueue(payloadOrEndpoint, maybePayload) {
  const item = maybePayload !== undefined
    ? { endpoint: payloadOrEndpoint, payload: maybePayload, timestamp: new Date().toISOString() }
    : { endpoint: '/internal/ingest', payload: payloadOrEndpoint, timestamp: new Date().toISOString() };

  pendingQueue.push(item);
  saveQueue();
}

/**
 * Flush any queued events to the economy service.
 * Called after a successful send to clear the backlog.
 */
async function flushQueue() {
  if (flushInProgress || pendingQueue.length === 0) return;
  flushInProgress = true;

  const batch = [...pendingQueue];
  pendingQueue = [];
  saveQueue();

  for (const item of batch) {
    const endpoint = item.endpoint || '/internal/ingest';
    try {
      await postToEconomyPayload(endpoint, item.payload);
    } catch {
      // Put it back in the queue — it will be retried on the next flush
      enqueue(endpoint, item.payload);
    }
  }

  flushInProgress = false;
}

// ─── Deprecated: forwardStep (removed) ─────────────────────────────
//
// The old forwardStep() function compared engine.state.credits before/after
// step() and sent credits_delta to /internal/ingest. With the removal of the
// legacy credit economy, this function is no longer needed. All sponsor
// impression forwarding is now handled directly by the CLI game loop
// (src/cli/index.js) and Mini App (telegram-mini-app/game.js), which attach
// the correct campaign_id context.

module.exports = {
  logAdImpression,
  enqueue,
  flushQueue,
};