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
    'SELECT id, display_name, username, created_at, total_earned, total_spent, balance FROM players WHERE id = ?'
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

  const allowedFields = ['name', 'brand_name', 'daily_budget_micros', 'total_budget_micros', 'start_date', 'end_date', 'status'];
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

    // Check campaign date range (if configured)
    const today = new Date().toISOString().split('T')[0];
    if (campaign.start_date && today < campaign.start_date) {
      throw new Error('campaign has not started yet');
    }
    if (campaign.end_date && today > campaign.end_date) {
      throw new Error('campaign has ended');
    }

    // Check daily budget using campaign's own daily_spent tracking
    if (campaign.daily_budget_micros > 0) {
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
    db.prepare(
      'UPDATE campaigns SET spent_micros = spent_micros + ?, daily_spent_micros = daily_spent_micros + ?, daily_spent_date = ? WHERE id = ?'
    ).run(amountMicros, amountMicros, today, campaignId);

    // Auto-complete if total budget exhausted
    const updated = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(campaignId);
    if (updated.total_budget_micros > 0 && updated.spent_micros >= updated.total_budget_micros) {
      db.prepare("UPDATE campaigns SET status = 'completed', updated_at = datetime('now') WHERE id = ?").run(campaignId);
    }

    // Allocate 20% of the charge to the player rewards pool
    const rewardAllocation = Math.floor(amountMicros * 0.2);
    if (rewardAllocation > 0) {
      db.prepare(
        "UPDATE rewards_pool SET total_deposited_micros = total_deposited_micros + ?, updated_at = datetime('now') WHERE id = 1"
      ).run(rewardAllocation);
    }

    return {
      charged: amountMicros,
      campaign_spent_micros: updated.spent_micros,
      advertiser_balance_micros: db.prepare('SELECT balance_micros FROM advertiser_accounts WHERE id = ?').get(campaign.advertiser_id).balance_micros,
    };
  });

  return tx();
}

// ─── Player Reward Pool (20% of ad revenue) ─────────────────────────
// On every successful chargeCampaign, 20% goes to the rewards pool.
// Players then earn from this pool based on skill (score, combo, level).

function allocateToRewardsPool(db, amountMicros) {
  if (amountMicros <= 0) return;
  const rewardAmount = Math.floor(amountMicros * 0.2); // 20%
  if (rewardAmount <= 0) return;
  db.prepare(
    "UPDATE rewards_pool SET total_deposited_micros = total_deposited_micros + ?, updated_at = datetime('now') WHERE id = 1"
  ).run(rewardAmount);
  return rewardAmount;
}

// Skill-based earning: conservative, company-favorable formula
// Base: 2 micros per tick survived
// Combo multiplier: 1.0 + (combo × 0.05), capped at 2.0
// Score multiplier: score / 100, capped at 3.0
// Level multiplier: 1.0 + (level - 1) × 0.2
// Difficulty tier bonus: tier × 0.1
// Per-session cap: 5000 micros (5 credits at 1000 micros/credit)
// Per-day cap: 25000 micros (25 credits)
function calculateSkillEarnings({ score = 0, combo = 0, level = 1, tickCount = 0, difficultyTier = 0 }) {
  const base = Math.max(0, tickCount) * 2;
  const comboMult = Math.min(2.0, 1.0 + Math.max(0, combo) * 0.05);
  const scoreMult = Math.min(3.0, Math.max(0, score) / 100);
  const levelMult = 1.0 + Math.max(0, level - 1) * 0.2;
  const tierBonus = 1.0 + Math.max(0, difficultyTier) * 0.1;
  const raw = Math.floor(base * comboMult * scoreMult * levelMult * tierBonus);
  return Math.min(5000, raw); // per-session cap
}

function earnPlayerReward(db, playerId, { score = 0, combo = 0, level = 1, tickCount = 0, difficultyTier = 0 }) {
  if (!playerId) throw new Error('earnPlayerReward: playerId is required');
  const amount = calculateSkillEarnings({ score, combo, level, tickCount, difficultyTier });
  if (amount <= 0) return { amount: 0 };

  const tx = db.transaction(() => {
    // Check daily cap (per player)
    const today = new Date().toISOString().split('T')[0];
    const dailyRow = db.prepare(
      "SELECT COALESCE(SUM(amount_micros), 0) as total FROM reward_claims WHERE player_id = ? AND date(claimed_at) = ? AND status IN ('completed', 'pending')"
    ).get(playerId, today);
    const dailyTotal = dailyRow ? dailyRow.total : 0;
    const DAILY_EARN_CAP = 25000;
    const remainingDaily = Math.max(0, DAILY_EARN_CAP - dailyTotal);

    // Check pool health: cap earnings to what the pool can actually support
    const pool = db.prepare('SELECT * FROM rewards_pool WHERE id = 1').get();
    const poolAvailable = Math.max(0, pool.total_deposited_micros - pool.total_claimed_micros);

    // Get total unclaimed rewards across ALL players (committed but not yet claimed)
    const totalUnclaimedRow = db.prepare(
      'SELECT COALESCE(SUM(earned_micros - claimed_micros), 0) as total FROM player_rewards'
    ).get();
    const totalUnclaimed = totalUnclaimedRow ? totalUnclaimedRow.total : 0;

    // Available pool capacity for new earnings
    const poolHeadroom = Math.max(0, poolAvailable - totalUnclaimed);

    // Player's existing unclaimed balance
    const existingRewards = db.prepare('SELECT * FROM player_rewards WHERE player_id = ?').get(playerId);
    const existingAvailable = existingRewards ? Math.max(0, existingRewards.earned_micros - existingRewards.claimed_micros) : 0;

    // Cap to the tightest constraint
    const finalAmount = Math.min(amount, remainingDaily, Math.max(0, poolHeadroom + existingAvailable));

    if (finalAmount <= 0) return { amount: 0, reason: poolHeadroom <= 0 ? 'pool_exhausted' : 'daily_cap' };

    // Upsert player_rewards
    db.prepare(
      "INSERT INTO player_rewards (player_id, earned_micros, claimed_micros, last_earned_at, updated_at) VALUES (?, ?, 0, datetime('now'), datetime('now')) ON CONFLICT(player_id) DO UPDATE SET earned_micros = earned_micros + ?, last_earned_at = datetime('now'), updated_at = datetime('now')"
    ).run(playerId, finalAmount, finalAmount);

    return { amount: finalAmount };
  });

  return tx();
}

function getPlayerRewards(db, playerId) {
  if (!playerId) return null;
  const row = db.prepare('SELECT * FROM player_rewards WHERE player_id = ?').get(playerId);
  if (!row) return { player_id: playerId, earned_micros: 0, claimed_micros: 0, available_micros: 0 };
  return {
    player_id: row.player_id,
    earned_micros: row.earned_micros,
    claimed_micros: row.claimed_micros,
    available_micros: Math.max(0, row.earned_micros - row.claimed_micros),
    last_earned_at: row.last_earned_at,
  };
}

function getRewardsPoolStats(db) {
  return db.prepare('SELECT * FROM rewards_pool WHERE id = 1').get() || { total_deposited_micros: 0, total_claimed_micros: 0 };
}

// ─── Leaderboard ─────────────────────────────────────────────────
function getLeaderboard(db, { limit = 10, offset = 0 } = {}) {
  const rows = db.prepare(
    'SELECT player_id, earned_micros, claimed_micros FROM player_rewards ORDER BY earned_micros DESC LIMIT ? OFFSET ?'
  ).all(limit, offset);

  const total = db.prepare(
    'SELECT COUNT(*) as count FROM player_rewards'
  ).get().count;

  return { leaderboard: rows, total, limit, offset };
}

// ─── Pool Health ──────────────────────────────────────────────────
function getPoolHealth(db) {
  const pool = getRewardsPoolStats(db);
  const available = Math.max(0, pool.total_deposited_micros - pool.total_claimed_micros);

  const depositsRow = db.prepare(
    "SELECT COALESCE(SUM(cost_micros) * 0.2, 0) as deposits FROM ad_impressions WHERE created_at >= datetime('now', '-1 day')"
  ).get();

  const claimsRow = db.prepare(
    "SELECT COALESCE(SUM(amount_micros), 0) as claims FROM reward_claims WHERE completed_at >= datetime('now', '-1 day') AND status = 'completed'"
  ).get();

  const depositsLast24h = Math.floor(depositsRow?.deposits || 0);
  const claimsLast24h = claimsRow?.claims || 0;

  let estimatedDepletionHours = null;
  if (claimsLast24h > 0) {
    const hourlyClaimRate = claimsLast24h / 24;
    estimatedDepletionHours = hourlyClaimRate > 0 ? (available / hourlyClaimRate) : null;
  }

  return {
    total_deposited_micros: pool.total_deposited_micros,
    total_claimed_micros: pool.total_claimed_micros,
    available_micros: available,
    deposit_rate_micros_per_hour: depositsLast24h > 0 ? depositsLast24h / 24 : 0,
    claim_rate_micros_per_hour: claimsLast24h > 0 ? claimsLast24h / 24 : 0,
    deposits_last_24h: depositsLast24h,
    claims_last_24h: claimsLast24h,
    estimated_depletion_hours: estimatedDepletionHours,
  };
}

function claimReward(db, { playerId, ppqAccount, amountMicros, idempotencyKey }) {
  if (!playerId) throw new Error('claimReward: playerId is required');
  if (!ppqAccount) throw new Error('claimReward: ppqAccount is required');
  if (!amountMicros || amountMicros <= 0) throw new Error('claimReward: amountMicros must be positive');

  const tx = db.transaction(() => {
    const rewards = db.prepare('SELECT * FROM player_rewards WHERE player_id = ?').get(playerId);
    if (!rewards) throw new Error('no rewards for this player');
    const available = Math.max(0, rewards.earned_micros - rewards.claimed_micros);
    if (available < amountMicros) throw new Error(`insufficient rewards (${available} < ${amountMicros})`);

    // Check pool has funds
    const pool = db.prepare('SELECT * FROM rewards_pool WHERE id = 1').get();
    const poolAvailable = Math.max(0, pool.total_deposited_micros - pool.total_claimed_micros);
    if (poolAvailable < amountMicros) throw new Error(`rewards pool insufficient (${poolAvailable} < ${amountMicros})`);

    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    // Create claim record
    db.prepare(
      'INSERT INTO reward_claims (id, player_id, amount_micros, ppq_account, status, idempotency_key, claimed_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(id, playerId, amountMicros, ppqAccount, 'pending', idempotencyKey, now);

    // Deduct from player's available rewards
    db.prepare(
      "UPDATE player_rewards SET claimed_micros = claimed_micros + ?, updated_at = datetime('now') WHERE player_id = ?"
    ).run(amountMicros, playerId);

    // Deduct from pool
    db.prepare(
      "UPDATE rewards_pool SET total_claimed_micros = total_claimed_micros + ?, updated_at = datetime('now') WHERE id = 1"
    ).run(amountMicros);

    const claim = db.prepare('SELECT * FROM reward_claims WHERE id = ?').get(id);
    return { idempotent: false, claim };
  });

  return tx();
}

function completeRewardClaim(db, { claimId, ppqTxId }) {
  if (!claimId) throw new Error('completeRewardClaim: claimId is required');
  const tx = db.transaction(() => {
    const claim = db.prepare('SELECT * FROM reward_claims WHERE id = ?').get(claimId);
    if (!claim) throw new Error('claim not found');
    if (claim.status !== 'pending') throw new Error(`claim is '${claim.status}', expected 'pending'`);
    db.prepare(
      "UPDATE reward_claims SET status = 'completed', ppq_tx_id = ?, completed_at = datetime('now') WHERE id = ?"
    ).run(ppqTxId || null, claimId);
    return db.prepare('SELECT * FROM reward_claims WHERE id = ?').get(claimId);
  });
  return tx();
}

function failRewardClaim(db, claimId) {
  if (!claimId) throw new Error('failRewardClaim: claimId is required');
  const tx = db.transaction(() => {
    const claim = db.prepare('SELECT * FROM reward_claims WHERE id = ?').get(claimId);
    if (!claim) throw new Error('claim not found');
    if (claim.status !== 'pending') throw new Error(`claim is '${claim.status}', expected 'pending'`);
    // Refund the player and pool
    db.prepare(
      'UPDATE player_rewards SET claimed_micros = claimed_micros - ? WHERE player_id = ?'
    ).run(claim.amount_micros, claim.player_id);
    db.prepare(
      'UPDATE rewards_pool SET total_claimed_micros = total_claimed_micros - ? WHERE id = 1'
    ).run(claim.amount_micros);
    db.prepare(
      "UPDATE reward_claims SET status = 'failed' WHERE id = ?"
    ).run(claimId);
    return db.prepare('SELECT * FROM reward_claims WHERE id = ?').get(claimId);
  });
  return tx();
}

// ─── Persisted Rate Limit Helpers ────────────────────────────────────
// These replace in-memory Maps so rate limits survive server restarts.
// Keys use a prefix convention: "impression:<player_id>", "claim:<player_id>", "admin_daily:<YYYY-MM-DD>"
// All timestamp values are Unix epoch milliseconds.

function checkCooldown(db, key, cooldownMs) {
  const row = db.prepare('SELECT last_timestamp FROM rate_limit_cooldowns WHERE key = ?').get(key);
  if (!row) return { limited: false, retryAfter: 0 };
  const elapsed = Date.now() - row.last_timestamp;
  if (elapsed < cooldownMs) {
    return { limited: true, retryAfter: Math.ceil((cooldownMs - elapsed) / 1000) };
  }
  return { limited: false, retryAfter: 0 };
}

function setCooldown(db, key) {
  db.prepare(
    'INSERT INTO rate_limit_cooldowns (key, last_timestamp) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET last_timestamp = excluded.last_timestamp'
  ).run(key, Date.now());
}

function getAdminDailyAwardTotal(db, dateStr) {
  const row = db.prepare('SELECT total_micros FROM admin_daily_awards WHERE date = ?').get(dateStr);
  return row ? row.total_micros : 0;
}

function addAdminDailyAward(db, dateStr, amount) {
  db.prepare(
    'INSERT INTO admin_daily_awards (date, total_micros) VALUES (?, ?) ON CONFLICT(date) DO UPDATE SET total_micros = total_micros + ?, updated_at = datetime(\'now\')'
  ).run(dateStr, amount, amount);
}

function getPlayerDailyAwardTotal(db, playerId, dateStr) {
  const row = db.prepare('SELECT total_micros FROM player_daily_awards WHERE player_id = ? AND date = ?').get(playerId, dateStr);
  return row ? row.total_micros : 0;
}

function addPlayerDailyAward(db, playerId, dateStr, amount) {
  db.prepare(
    'INSERT INTO player_daily_awards (player_id, date, total_micros) VALUES (?, ?, ?) ON CONFLICT(player_id, date) DO UPDATE SET total_micros = total_micros + ?'
  ).run(playerId, dateStr, amount, amount);
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
  // Player reward pool
  allocateToRewardsPool,
  calculateSkillEarnings,
  earnPlayerReward,
  getPlayerRewards,
  getRewardsPoolStats,
  getLeaderboard,
  getPoolHealth,
  claimReward,
  completeRewardClaim,
  failRewardClaim,
  // Persisted rate limit helpers
  checkCooldown,
  setCooldown,
  getAdminDailyAwardTotal,
  addAdminDailyAward,
  getPlayerDailyAwardTotal,
  addPlayerDailyAward,
};
