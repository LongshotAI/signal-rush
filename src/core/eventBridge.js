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
    const headers = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
    };
    // Pass shared secret for /internal/* endpoints when ECONOMY_API_KEY is set
    const apiKey = process.env.ECONOMY_API_KEY || null;
    if (apiKey && endpoint.startsWith('/internal/')) {
      headers['Authorization'] = `Bearer ${apiKey}`;
    }
    const req = http.request(
      {
        hostname,
        port,
        path: endpoint,
        method: 'POST',
        headers,
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

let flushPromise = null;

/**
 * Flush any queued events to the economy service.
 * Called after a successful send to clear the backlog.
 * Uses a promise mutex to prevent concurrent flushes.
 */
async function flushQueue() {
  if (flushPromise) return flushPromise; // Already flushing — wait for existing
  flushPromise = _flushQueueInner();
  try {
    return await flushPromise;
  } finally {
    flushPromise = null;
  }
}

async function _flushQueueInner() {
  if (pendingQueue.length === 0) return;

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
}

// ─── Player Identity ──────────────────────────────────────────────
//
// CLI players are identified by a UUID stored in ~/.signal-rush/player.json.
// This is separate from Telegram-authenticated players (Mini App).
// For production, a merge/linking flow should be added.

const PLAYER_FILE = path.join(os.homedir(), '.signal-rush', 'player.json');

function getPlayerId() {
  try {
    if (fs.existsSync(PLAYER_FILE)) {
      const data = JSON.parse(fs.readFileSync(PLAYER_FILE, 'utf-8'));
      if (data.player_id) return data.player_id;
    }
  } catch {
    // Corrupt file — regenerate
  }
  const newId = randomUUID();
  try {
    fs.mkdirSync(path.dirname(PLAYER_FILE), { recursive: true });
    fs.writeFileSync(PLAYER_FILE, JSON.stringify({
      player_id: newId,
      created_at: new Date().toISOString(),
    }, null, 2));
  } catch {
    // Best-effort — return ephemeral ID if we can't persist
  }
  return newId;
}

// ─── Reward Balance Fetch ──────────────────────────────────────────
/**
 * Fetch a player's current claimable reward balance from the economy service.
 * Used by the CLI to display "X µ claimable" in the HUD.
 * Returns { available_micros: number } or null on failure.
 */
async function fetchRewardBalance(playerId) {
  try {
    const res = await new Promise((resolve, reject) => {
      const { hostname, port } = getEconomyHost();
      const req = http.request(
        { hostname, port, path: `/players/${encodeURIComponent(playerId)}/rewards`, method: 'GET', timeout: 3000 },
        (res) => {
          let d = '';
          res.on('data', c => d += c);
          res.on('end', () => {
            try { resolve(JSON.parse(d)); } catch { resolve(null); }
          });
        }
      );
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
      req.end();
    });
    if (res && res.ok) {
      return { available_micros: res.available_micros || 0 };
    }
    return null;
  } catch {
    return null; // Economy service down — graceful degradation
  }
}

// ─── Forward Skill-Based Reward ────────────────────────────────────
/**
 * Forward end-of-run session stats to the economy service for skill-based
 * reward calculation. POST /internal/earn-reward
 * The economy service calculates earnings based on score/combo/level/tickCount
 * and caps to available pool headroom.
 * Returns { amount: number } or null on failure.
 */
async function forwardReward(playerId, { score, combo, level, tickCount, difficultyTier }) {
  try {
    const res = await new Promise((resolve, reject) => {
      const { hostname, port } = getEconomyHost();
      const body = JSON.stringify({
        player_id: playerId,
        score: score || 0,
        combo: combo || 0,
        level: level || 1,
        tick_count: tickCount || 0,
        difficulty_tier: difficultyTier || 0,
      });
      const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) };
      const apiKey = process.env.ECONOMY_API_KEY || null;
      if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
      const req = http.request(
        { hostname, port, path: '/internal/earn-reward', method: 'POST',
          headers, timeout: 3000 },
        (res) => {
          let d = '';
          res.on('data', c => d += c);
          res.on('end', () => {
            try { resolve(JSON.parse(d)); } catch { resolve(null); }
          });
        }
      );
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
      req.write(body);
      req.end();
    });
    if (res && res.ok) {
      return { amount: res.amount || 0 };
    }
    return null;
  } catch {
    return null; // Economy service down — graceful degradation
  }
}

module.exports = {
  logAdImpression,
  enqueue,
  flushQueue,
  getPlayerId,
  fetchRewardBalance,
  forwardReward,
};