// src/core/eventBridge.js
// Signal Rush — Event Bridge
//
// Sits between the CLI game loop and the economy service.
// Captures engine events after each step() and forwards them to the economy service.
//
// Key design decisions:
// - Credit diffing: compares engine.state.credits before/after step() to catch ALL
//   credit changes (pickups, slots, level clears) regardless of whether the engine
//   emits a credits_awarded event. Single source of truth.
// - Idempotency: uses session_id + timestamp as the synthetic event_id, so retries
//   are safe and never double-count.
// - Graceful degradation: if the economy service is down, events are queued to a
//   local JSON file and retried on the next successful connection. Gameplay is NEVER
//   blocked.
// - No engine imports: the bridge receives the engine object and events as parameters.
//   It never requires() the engine module.

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const { randomUUID } = require('crypto');

const INGEST_TIMEOUT_MS = 500; // don't block the game loop

function getEconomyUrl() {
  const port = parseInt(process.env.ECONOMY_PORT) || 8720;
  const host = process.env.ECONOMY_HOST || '127.0.0.1';
  return `http://${host}:${port}/internal/ingest`;
}

// Queue file for when economy service is down
const QUEUE_DIR = path.join(os.homedir(), '.signal-rush');
const QUEUE_FILE = path.join(QUEUE_DIR, 'event-queue.json');

// In-memory queue for pending events
let pendingQueue = [];
let flushInProgress = false;

// Load any persisted queue on startup (survives CLI crashes)
loadQueue();

// ─── Queue Management ─────────────────────────────────────────────

function ensureQueueDir() {
  if (!fs.existsSync(QUEUE_DIR)) {
    fs.mkdirSync(QUEUE_DIR, { recursive: true });
  }
}

function loadQueue() {
  ensureQueueDir();
  try {
    if (fs.existsSync(QUEUE_FILE)) {
      const raw = fs.readFileSync(QUEUE_FILE, 'utf8');
      pendingQueue = JSON.parse(raw);
    }
  } catch {
    pendingQueue = [];
  }
  return pendingQueue;
}

function saveQueue() {
  ensureQueueDir();
  try {
    fs.writeFileSync(QUEUE_FILE, JSON.stringify(pendingQueue, null, 2));
  } catch {
    // best-effort — if we can't write, we'll retry in memory
  }
}

function enqueue(payload) {
  pendingQueue.push(payload);
  saveQueue();
}

// ─── HTTP Ingestion ───────────────────────────────────────────────

function postToEconomy(payload) {
  return new Promise((resolve, reject) => {
    const url = new URL(getEconomyUrl());
    const data = JSON.stringify(payload);
    const headers = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(data),
    };
    // Include auth header if API key is configured
    const apiKey = process.env.ECONOMY_API_KEY;
    if (apiKey) {
      headers['Authorization'] = `Bearer ${apiKey}`;
    }
    const req = http.request({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: 'POST',
      headers,
      timeout: INGEST_TIMEOUT_MS,
    }, (res) => {
      let chunks = '';
      res.on('data', d => chunks += d);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve({ ok: true });
        } else {
          reject(new Error(`Economy service returned ${res.statusCode}: ${chunks}`));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Economy service timeout'));
    });
    req.write(data);
    req.end();
  });
}

// ─── Flush Pending Queue ──────────────────────────────────────────

async function flushQueue() {
  if (flushInProgress || pendingQueue.length === 0) return;
  flushInProgress = true;

  loadQueue();
  const toFlush = [...pendingQueue];
  pendingQueue = [];

  const failed = [];
  for (const payload of toFlush) {
    try {
      await postToEconomy(payload);
    } catch {
      failed.push(payload);
    }
  }

  // Put failed ones back in queue
  pendingQueue = [...failed, ...pendingQueue];
  saveQueue();
  flushInProgress = false;
}

// ─── Main Bridge Function ─────────────────────────────────────────

/**
 * Forward a game step's events to the economy service.
 *
 * Called by the CLI after engine.step(input).
 *
 * @param {string} playerId - The player's UUID
 * @param {string} sessionId - The current game session UUID
 * @param {object} engine - The engine object (has .state.credits, .state.lastEvents)
 * @param {number} creditsBefore - engine.state.credits captured BEFORE step()
 */
async function forwardStep(playerId, sessionId, engine, creditsBefore) {
  const creditsAfter = engine.state.credits;
  const delta = creditsAfter - creditsBefore;
  const events = engine.state.lastEvents || [];

  // Detect reset: engine sets credits to 0 on new game / restart
  const isReset = (creditsAfter === 0 && creditsBefore > 0);

  const payload = {
    player_id: playerId,
    session_id: sessionId,
    credits_delta: isReset ? 0 : delta,
    is_reset: isReset,
    events,
    timestamp: new Date().toISOString(),
  };

  try {
    await postToEconomy(payload);
    // Successfully sent — try to flush any pending queue
    flushQueue().catch(() => {});
  } catch {
    // Economy service is down or slow — queue locally, never block the game
    enqueue(payload);
  }
}

// ─── Ad Impression Logging ─────────────────────────────────────────

/**
 * Log an ad impression to the economy service.
 * Fire-and-forget: if the economy service is down, the impression is lost
 * (acceptable for MVP — impressions are best-effort, credits are authoritative).
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
    cost_micros: 0, // house ads cost 0; campaign ads will have real CPM later
  };

  try {
    await postToEconomyPayload('/ads/impression', payload);
  } catch {
    // Economy service is down — queue the impression for later retry
    // so impressions are not silently lost.
    enqueue(payload);
  }
}

/**
 * Post a payload to a specific economy service endpoint.
 * @param {string} endpoint - e.g. '/ads/impression'
 * @param {object} payload
 */
function postToEconomyPayload(endpoint, payload) {
  return new Promise((resolve, reject) => {
    const url = new URL(getEconomyUrl());
    const data = JSON.stringify(payload);
    const headers = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(data),
    };
    // Include auth header if API key is configured
    const apiKey = process.env.ECONOMY_API_KEY;
    if (apiKey) {
      headers['Authorization'] = `Bearer ${apiKey}`;
    }
    const req = http.request({
      hostname: url.hostname,
      port: url.port,
      path: endpoint,
      method: 'POST',
      headers,
      timeout: INGEST_TIMEOUT_MS,
    }, (res) => {
      let chunks = '';
      res.on('data', d => chunks += d);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve({ ok: true });
        } else {
          reject(new Error(`Economy service returned ${res.statusCode}: ${chunks}`));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Economy service timeout'));
    });
    req.write(data);
    req.end();
  });
}

/**
 * Get or create the player ID for this machine.
 * Stored in ~/.signal-rush/player.json
 */
function getPlayerId() {
  const playerFile = path.join(QUEUE_DIR, 'player.json');
  ensureQueueDir();

  try {
    if (fs.existsSync(playerFile)) {
      const data = JSON.parse(fs.readFileSync(playerFile, 'utf8'));
      if (data.player_id) return data.player_id;
    }
  } catch {
    // corrupt file — regenerate
  }

  // Generate new player
  const playerId = randomUUID();
  try {
    fs.writeFileSync(playerFile, JSON.stringify({
      player_id: playerId,
      created_at: new Date().toISOString(),
    }, null, 2));
  } catch {
    // best-effort
  }
  return playerId;
}

module.exports = {
  forwardStep,
  logAdImpression,
  getPlayerId,
  loadQueue,
  flushQueue,
  enqueue,
  // Exported for testing
  _postToEconomy: postToEconomy,
  _postToEconomyPayload: postToEconomyPayload,
};
