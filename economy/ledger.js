// economy/ledger.js
// Signal Rush Token Economy — Database Layer
//
// All credit operations are atomic (single SQLite transaction).
// Ingest is idempotent — duplicate event_ids are silently ignored.
// Balance is never negative — enforced by DB constraint + application check.
// Every mutation creates a transaction row — full append-only audit trail.

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

const DEFAULT_DB_PATH = path.join(os.homedir(), '.signal-rush', 'economy.db');

function openDb(dbPath = DEFAULT_DB_PATH) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode=WAL');
  db.pragma('foreign_keys=ON');

  // Load and execute schema
  const schemaPath = path.join(__dirname, 'schema.sql');
  if (fs.existsSync(schemaPath)) {
    const schema = fs.readFileSync(schemaPath, 'utf8');
    db.exec(schema);
  }

  return db;
}

// ─── Player Operations ────────────────────────────────────────────

function createPlayer(db, displayName) {
  const id = crypto.randomUUID();
  db.prepare(
    'INSERT INTO players (id, display_name) VALUES (?, ?)'
  ).run(id, displayName);
  return getPlayer(db, id);
}

function getPlayer(db, playerId) {
  if (!playerId) return null;
  return db.prepare(
    'SELECT id, display_name, created_at, total_earned, total_spent, balance FROM players WHERE id = ?'
  ).get(playerId);
}

function playerExists(db, playerId) {
  return !!db.prepare('SELECT 1 FROM players WHERE id = ?').get(playerId);
}

// ─── Credit Operations ────────────────────────────────────────────

function awardCredits(db, { playerId, amount, reason, eventId = null, sourceEventTypes = null }) {
  if (amount <= 0) throw new Error('awardCredits: amount must be positive');

  const tx = db.transaction(() => {
    // Idempotency check — if this event was already processed, skip
    if (eventId) {
      const existing = db.prepare('SELECT 1 FROM transactions WHERE event_id = ?').get(eventId);
      if (existing) {
        return { idempotent: true, player: getPlayer(db, playerId) };
      }
    }

    const txId = crypto.randomUUID();
    db.prepare(
      'INSERT INTO transactions (id, player_id, type, amount, reason, event_id, source_event_types) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(txId, playerId, 'award', amount, reason, eventId, sourceEventTypes);

    db.prepare(
      'UPDATE players SET balance = balance + ?, total_earned = total_earned + ? WHERE id = ?'
    ).run(amount, amount, playerId);

    return { idempotent: false, player: getPlayer(db, playerId) };
  });

  return tx();
}

function spendCredits(db, { playerId, amount, reason, eventId = null, sinkType = null }) {
  if (amount <= 0) throw new Error('spendCredits: amount must be positive');

  const tx = db.transaction(() => {
    // Check balance first
    const player = db.prepare('SELECT balance FROM players WHERE id = ?').get(playerId);
    if (!player) throw new Error(`spendCredits: player ${playerId} not found`);
    if (player.balance < amount) {
      throw new Error(`spendCredits: insufficient balance (${player.balance} < ${amount})`);
    }

    // Idempotency check
    if (eventId) {
      const existing = db.prepare('SELECT 1 FROM transactions WHERE event_id = ?').get(eventId);
      if (existing) {
        return { idempotent: true, player: getPlayer(db, playerId) };
      }
    }

    const txId = crypto.randomUUID();
    db.prepare(
      'INSERT INTO transactions (id, player_id, type, amount, reason, event_id) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(txId, playerId, 'spend', amount, reason, eventId);

    db.prepare(
      'UPDATE players SET balance = balance - ?, total_spent = total_spent + ? WHERE id = ?'
    ).run(amount, amount, playerId);

    // Record credit sink entry for analytics
    if (sinkType) {
      const sinkId = crypto.randomUUID();
      db.prepare(
        'INSERT INTO credit_sinks (id, player_id, sink_type, amount) VALUES (?, ?, ?, ?)'
      ).run(sinkId, playerId, sinkType, amount);
    }

    return { idempotent: false, player: getPlayer(db, playerId) };
  });

  return tx();
}

// ─── Event Ingestion (called by event bridge) ──────────────────────

function ingestEvent(db, { playerId, sessionId, creditsDelta = 0, isReset = false, events = [], timestamp = null, maxPerSession = null }) {
  if (!sessionId) throw new Error('ingestEvent: sessionId is required');

  const ts = timestamp || new Date().toISOString();
  const result = { creditsAwarded: 0, eventsStored: 0, reset: isReset };

  const tx = db.transaction(() => {
    // Ensure player exists (create on first sight for MVP)
    // Use the provided playerId as the player's id — don't generate a new one
    if (playerId && !playerExists(db, playerId)) {
      db.prepare('INSERT INTO players (id, display_name) VALUES (?, ?)')
        .run(playerId, `player-${playerId.slice(0, 8)}`);
    }

    // Anti-fraud: per-session credit limit check (inside the transaction)
    if (maxPerSession != null && creditsDelta > 0 && playerId) {
      const sessionRow = db.prepare(
        'SELECT COALESCE(credits_earned, 0) as total FROM sessions WHERE id = ?'
      ).get(sessionId);
      const currentEarned = sessionRow?.total || 0;
      if (currentEarned + creditsDelta > maxPerSession) {
        throw new Error(`session credit limit exceeded (max ${maxPerSession} per session)`);
      }
    }

    // Handle credit delta from the bridge diff
    // creditsDelta > 0 means credits were earned
    // creditsDelta < 0 (with isReset=false) means credits were spent
    // isReset=true means the engine reset credits to 0 — not a spend, just zero the balance
    if (isReset && playerId) {
      // Engine reset credits to 0 — atomically read current balance and zero it
      // so concurrent resets cannot lose credits.
      const before = db.prepare('SELECT balance FROM players WHERE id = ?').get(playerId);
      const preResetBalance = before ? before.balance : 0;
      db.prepare('UPDATE players SET balance = 0 WHERE id = ?').run(playerId);
      result.preResetBalance = preResetBalance;
    } else if (creditsDelta > 0 && playerId) {
      const eventId = `diff-${sessionId}-${ts}`;
      // Generate a synthetic event_id for idempotency
      // Use a hash of session+timestamp to prevent double-counting on retry
      const awardResult = awardCredits(db, {
        playerId,
        amount: creditsDelta,
        reason: 'gameplay',
        eventId,
        sourceEventTypes: JSON.stringify(events.map(e => e.type || e)),
      });
      result.creditsAwarded = awardResult.idempotent ? 0 : creditsDelta;
    } else if (creditsDelta < 0 && !isReset && playerId) {
      // Future: credits were spent in-game
      const eventId = `spend-${sessionId}-${ts}`;
      spendCredits(db, {
        playerId,
        amount: Math.abs(creditsDelta),
        reason: 'gameplay_spend',
        eventId,
      });
      result.creditsAwarded = creditsDelta; // negative = spent
    }

    // Store each engine event for analytics
    if (playerId && events && events.length > 0) {
      for (const event of events) {
        const eventId = crypto.randomUUID();
        db.prepare(
          'INSERT OR IGNORE INTO game_events (id, player_id, session_id, event_type, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?)'
        ).run(
          eventId,
          playerId,
          sessionId,
          event.type || 'unknown',
          JSON.stringify(event),
          ts,
        );
        result.eventsStored++;
      }
    }

    // Ensure session record exists
    if (playerId) {
      const existing = db.prepare('SELECT 1 FROM sessions WHERE id = ?').get(sessionId);
      if (!existing) {
        db.prepare(
          'INSERT INTO sessions (id, player_id, started_at) VALUES (?, ?, ?)'
        ).run(sessionId, playerId, ts);
      }
      // Update session stats
      if (creditsDelta > 0) {
        db.prepare('UPDATE sessions SET credits_earned = credits_earned + ? WHERE id = ?').run(creditsDelta, sessionId);
      } else if (creditsDelta < 0 && !isReset) {
        db.prepare('UPDATE sessions SET credits_spent = credits_spent + ? WHERE id = ?').run(Math.abs(creditsDelta), sessionId);
      }
    }

    return result;
  });

  return tx();
}

// ─── Transaction History ──────────────────────────────────────────

function getTransactions(db, playerId, { limit = 50, offset = 0 } = {}) {
  const transactions = db.prepare(
    'SELECT id, type, amount, reason, event_id, source_event_types, created_at FROM transactions WHERE player_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?'
  ).all(playerId, limit, offset);

  const total = db.prepare(
    'SELECT COUNT(*) as count FROM transactions WHERE player_id = ?'
  ).get(playerId).count;

  return { transactions, total, limit, offset };
}

// ─── Analytics / Tracking ─────────────────────────────────────────

function getEvents(db, { playerId = null, sessionId = null, eventType = null, since = null, limit = 100 } = {}) {
  let sql = 'SELECT * FROM game_events WHERE 1=1';
  const params = [];

  if (playerId) { sql += ' AND player_id = ?'; params.push(playerId); }
  if (sessionId) { sql += ' AND session_id = ?'; params.push(sessionId); }
  if (eventType) { sql += ' AND event_type = ?'; params.push(eventType); }
  if (since) { sql += ' AND created_at >= ?'; params.push(since); }

  sql += ' ORDER BY created_at DESC LIMIT ?';
  params.push(limit);

  return db.prepare(sql).all(...params);
}

function getSummary(db, playerId) {
  const player = getPlayer(db, playerId);
  if (!player) return null;

  const sessionCount = db.prepare('SELECT COUNT(*) as count FROM sessions WHERE player_id = ?').get(playerId).count;
  const eventCount = db.prepare('SELECT COUNT(*) as count FROM game_events WHERE player_id = ?').get(playerId).count;

  return {
    player: player,
    sessions: sessionCount,
    events: eventCount,
  };
}

// ─── Ad Impressions ───────────────────────────────────────────────

function logImpression(db, { campaignId = null, playerId = null, placementType = 'hud_frame', costMicros = 0 }) {
  const id = crypto.randomUUID();
  db.prepare(
    'INSERT INTO ad_impressions (id, campaign_id, player_id, placement_type, cost_micros) VALUES (?, ?, ?, ?, ?)'
  ).run(id, campaignId, playerId, placementType, costMicros);
  return id;
}

function getImpressionStats(db, campaignId) {
  return db.prepare(
    'SELECT COUNT(*) as impressions, COALESCE(SUM(cost_micros), 0) as total_cost_micros FROM ad_impressions WHERE campaign_id = ?'
  ).get(campaignId);
}

// ─── Fraud Detection Helpers (Phase 2, instrumented now) ──────────

function getSessionRate(db, sessionId) {
  // Returns events per minute for anomaly detection
  const result = db.prepare(
    'SELECT COUNT(*) as event_count, MIN(created_at) as first_event, MAX(created_at) as last_event FROM game_events WHERE session_id = ?'
  ).get(sessionId);
  if (!result || result.event_count === 0) return null;
  return result;
}

function getPlayerSessions(db, playerId, { limit = 10 } = {}) {
  return db.prepare(
    'SELECT id, mode, started_at, ended_at, credits_earned, credits_spent, score, tick_count FROM sessions WHERE player_id = ? ORDER BY started_at DESC LIMIT ?'
  ).all(playerId, limit);
}

// ─── Advertiser Account Operations ─────────────────────────────────

function createAdvertiserAccount(db, { email, passwordHash, companyName, apiKey }) {
  const id = crypto.randomUUID();
  const apiKeyHash = crypto.createHash('sha256').update(apiKey).digest('hex');
  db.prepare(
    'INSERT INTO advertiser_accounts (id, email, password_hash, company_name, api_key, api_key_hash, status, balance_micros) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(id, email, passwordHash, companyName, apiKey, apiKeyHash, 'active', 0);
  return { id, email, company_name: companyName, api_key: apiKey, status: 'active', balance_micros: 0 };
}

function getAdvertiserByEmail(db, email) {
  if (!email) return null;
  return db.prepare(
    'SELECT id, email, password_hash, company_name, api_key, status, balance_micros, created_at FROM advertiser_accounts WHERE email = ?'
  ).get(email);
}

function getAdvertiserByKey(db, apiKey) {
  if (!apiKey) return null;
  const apiKeyHash = crypto.createHash('sha256').update(apiKey).digest('hex');
  return db.prepare(
    'SELECT id, email, company_name, api_key, status, balance_micros, created_at FROM advertiser_accounts WHERE api_key_hash = ?'
  ).get(apiKeyHash);
}

function getAdvertiserBalance(db, advertiserId) {
  const row = db.prepare(
    'SELECT balance_micros FROM advertiser_accounts WHERE id = ?'
  ).get(advertiserId);
  return row ? row.balance_micros : null;
}

function depositAdvertiserFunds(db, { advertiserId, amountMicros, reason }) {
  if (amountMicros <= 0) throw new Error('deposit amount must be positive');

  const tx = db.transaction(() => {
    const before = db.prepare('SELECT balance_micros FROM advertiser_accounts WHERE id = ?').get(advertiserId);
    if (!before) throw new Error('advertiser not found');

    db.prepare(
      'UPDATE advertiser_accounts SET balance_micros = balance_micros + ? WHERE id = ?'
    ).run(amountMicros, advertiserId);

    const after = db.prepare('SELECT balance_micros FROM advertiser_accounts WHERE id = ?').get(advertiserId);
    return { balance_before: before.balance_micros, balance_after: after.balance_micros };
  });

  return tx();
}

// ─── Campaign Operations ───────────────────────────────────────────

function createCampaign(db, { advertiserId, name, brandName, placementType, dailyBudgetMicros, totalBudgetMicros, startDate, endDate }) {
  const id = crypto.randomUUID();
  db.prepare(
    'INSERT INTO campaigns (id, advertiser_id, name, brand_name, status, placement_type, daily_budget_micros, total_budget_micros, spent_micros, start_date, end_date) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(id, advertiserId, name, brandName, 'draft', placementType, dailyBudgetMicros, totalBudgetMicros, 0, startDate || null, endDate || null);

  // Also add to campaign_placements
  db.prepare(
    'INSERT INTO campaign_placements (campaign_id, placement_type) VALUES (?, ?)'
  ).run(id, placementType);

  return getCampaign(db, id);
}

function getCampaign(db, campaignId) {
  if (!campaignId) return null;
  return db.prepare(
    'SELECT id, advertiser_id, name, brand_name, status, placement_type, daily_budget_micros, total_budget_micros, spent_micros, daily_spent_micros, daily_spent_date, start_date, end_date, created_at, updated_at FROM campaigns WHERE id = ?'
  ).get(campaignId);
}

function listCampaignsForAdvertiser(db, advertiserId, { limit = 50, offset = 0 } = {}) {
  const campaigns = db.prepare(
    'SELECT id, advertiser_id, name, brand_name, status, placement_type, daily_budget_micros, total_budget_micros, spent_micros, daily_spent_micros, daily_spent_date, start_date, end_date, created_at, updated_at FROM campaigns WHERE advertiser_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?'
  ).all(advertiserId, limit, offset);

  const total = db.prepare(
    'SELECT COUNT(*) as count FROM campaigns WHERE advertiser_id = ?'
  ).get(advertiserId).count;

  return { campaigns, total, limit, offset };
}

function updateCampaign(db, campaignId, advertiserId, updates) {
  // Verify ownership first
  const existing = db.prepare('SELECT * FROM campaigns WHERE id = ? AND advertiser_id = ?').get(campaignId, advertiserId);
  if (!existing) throw new Error('campaign not found or access denied');

  const allowedFields = ['name', 'brand_name', 'daily_budget_micros', 'total_budget_micros', 'start_date', 'end_date'];
  const setClauses = [];
  const values = [];

  for (const field of allowedFields) {
    if (updates[field] !== undefined) {
      setClauses.push(`${field} = ?`);
      values.push(updates[field]);
    }
  }

  if (setClauses.length === 0) return existing;

  setClauses.push("updated_at = datetime('now')");
  values.push(campaignId);
  values.push(advertiserId);

  db.prepare(
    `UPDATE campaigns SET ${setClauses.join(', ')} WHERE id = ? AND advertiser_id = ?`
  ).run(...values);

  return getCampaign(db, campaignId);
}

function updateCampaignStatus(db, campaignId, advertiserId, newStatus) {
  // Verify ownership
  const existing = db.prepare('SELECT * FROM campaigns WHERE id = ? AND advertiser_id = ?').get(campaignId, advertiserId);
  if (!existing) throw new Error('campaign not found or access denied');

  db.prepare(
    "UPDATE campaigns SET status = ?, updated_at = datetime('now') WHERE id = ? AND advertiser_id = ?"
  ).run(newStatus, campaignId, advertiserId);

  return getCampaign(db, campaignId);
}

function deleteCampaign(db, campaignId, advertiserId) {
  // Verify ownership and that campaign is in draft status
  const existing = db.prepare('SELECT * FROM campaigns WHERE id = ? AND advertiser_id = ?').get(campaignId, advertiserId);
  if (!existing) throw new Error('campaign not found or access denied');
  if (existing.status !== 'draft') throw new Error('only draft campaigns can be deleted');

  // CASCADE will handle creatives and campaign_placements
  db.prepare('DELETE FROM campaigns WHERE id = ?').run(campaignId);
  return { deleted: true };
}

// ─── Creative Operations ───────────────────────────────────────────

function createCreative(db, { campaignId, type, contentJson }) {
  const id = crypto.randomUUID();
  db.prepare(
    'INSERT INTO creatives (id, campaign_id, type, content_json, status) VALUES (?, ?, ?, ?, ?)'
  ).run(id, campaignId, type, contentJson, 'pending');
  return { id, campaign_id: campaignId, type, content_json: contentJson, status: 'pending' };
}

function listCreativesForCampaign(db, campaignId) {
  return db.prepare(
    'SELECT id, campaign_id, type, content_json, status, reviewed_at, created_at FROM creatives WHERE campaign_id = ? ORDER BY created_at DESC'
  ).all(campaignId);
}

function updateCreativeStatus(db, creativeId, newStatus) {
  const existing = db.prepare('SELECT * FROM creatives WHERE id = ?').get(creativeId);
  if (!existing) throw new Error('creative not found');

  const reviewedAt = (newStatus === 'approved' || newStatus === 'rejected') ? new Date().toISOString() : null;

  db.prepare(
    'UPDATE creatives SET status = ?, reviewed_at = ? WHERE id = ?'
  ).run(newStatus, reviewedAt, creativeId);

  return { id: creativeId, status: newStatus, reviewed_at: reviewedAt };
}

// ─── Campaign Analytics ────────────────────────────────────────────

function getCampaignStats(db, campaignId) {
  const campaign = getCampaign(db, campaignId);
  if (!campaign) return null;

  const impressionStats = db.prepare(
    'SELECT COUNT(*) as impressions, COALESCE(SUM(cost_micros), 0) as total_cost_micros FROM ad_impressions WHERE campaign_id = ?'
  ).get(campaignId);

  return {
    campaign_id: campaignId,
    name: campaign.name,
    brand_name: campaign.brand_name,
    status: campaign.status,
    placement_type: campaign.placement_type,
    daily_budget_micros: campaign.daily_budget_micros,
    total_budget_micros: campaign.total_budget_micros,
    spent_micros: campaign.spent_micros,
    daily_spent_micros: campaign.daily_spent_micros,
    impressions: impressionStats?.impressions || 0,
    total_impression_cost_micros: impressionStats?.total_cost_micros || 0,
  };
}

// ─── Campaign Billing ──────────────────────────────────────────────

function chargeCampaign(db, { campaignId, amountMicros }) {
  if (amountMicros <= 0) throw new Error('charge amount must be positive');

  const tx = db.transaction(() => {
    // Get campaign and advertiser
    const campaign = db.prepare(
      'SELECT c.*, a.balance_micros as advertiser_balance FROM campaigns c JOIN advertiser_accounts a ON c.advertiser_id = a.id WHERE c.id = ?'
    ).get(campaignId);

    if (!campaign) throw new Error('campaign not found');
    if (campaign.status !== 'active') throw new Error('campaign is not active');
    if (campaign.advertiser_balance < amountMicros) throw new Error('insufficient advertiser balance');

    // Check daily budget using campaign's own daily_spent tracking
    if (campaign.daily_budget_micros > 0) {
      const today = new Date().toISOString().split('T')[0];
      // Reset daily spent if it's a new day
      if (campaign.daily_spent_date !== today) {
        db.prepare('UPDATE campaigns SET daily_spent_micros = 0, daily_spent_date = ? WHERE id = ?').run(today, campaignId);
        campaign.daily_spent_micros = 0;
      }
      if (campaign.daily_spent_micros + amountMicros > campaign.daily_budget_micros) {
        throw new Error('daily budget exceeded');
      }
    }

    // Check total budget
    if (campaign.total_budget_micros > 0) {
      if (campaign.spent_micros + amountMicros > campaign.total_budget_micros) {
        throw new Error('total budget exceeded');
      }
    }

    // Deduct from advertiser balance
    db.prepare(
      'UPDATE advertiser_accounts SET balance_micros = balance_micros - ? WHERE id = ?'
    ).run(amountMicros, campaign.advertiser_id);

    // Increment campaign spent (total + daily)
    const today = new Date().toISOString().split('T')[0];
    db.prepare(
      'UPDATE campaigns SET spent_micros = spent_micros + ?, daily_spent_micros = daily_spent_micros + ?, daily_spent_date = ? WHERE id = ?'
    ).run(amountMicros, amountMicros, today, campaignId);

    // Auto-complete if total budget exhausted
    const updated = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(campaignId);
    if (updated.total_budget_micros > 0 && updated.spent_micros >= updated.total_budget_micros) {
      db.prepare("UPDATE campaigns SET status = 'completed', updated_at = datetime('now') WHERE id = ?").run(campaignId);
    }

    return {
      charged: amountMicros,
      campaign_spent_micros: updated.spent_micros,
      advertiser_balance_micros: db.prepare('SELECT balance_micros FROM advertiser_accounts WHERE id = ?').get(campaign.advertiser_id).balance_micros,
    };
  });

  return tx();
}

module.exports = {
  openDb,
  createPlayer,
  getPlayer,
  playerExists,
  awardCredits,
  spendCredits,
  ingestEvent,
  getTransactions,
  getEvents,
  getSummary,
  logImpression,
  getImpressionStats,
  getSessionRate,
  getPlayerSessions,
  DEFAULT_DB_PATH,
  // Advertiser portal
  createAdvertiserAccount,
  getAdvertiserByEmail,
  getAdvertiserByKey,
  createCampaign,
  getCampaign,
  listCampaignsForAdvertiser,
  updateCampaign,
  updateCampaignStatus,
  deleteCampaign,
  createCreative,
  listCreativesForCampaign,
  updateCreativeStatus,
  getCampaignStats,
  depositAdvertiserFunds,
  getAdvertiserBalance,
  chargeCampaign,
};
