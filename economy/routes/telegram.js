// economy/routes/telegram.js
// Signal Rush — Telegram Mini App API Routes
//
// Endpoints:
//   POST /telegram/auth  — Validate initData, find or create player, return session token
//   GET  /telegram/player/:telegram_id — Return player info by telegram_id
//
// These routes are designed to be registered on a Fastify instance.
// They require the following environment variables:
//   TELEGRAM_BOT_TOKEN — the bot token used to validate initData
//
// Usage:
//   const telegramRoutes = require('./routes/telegram');
//   telegramRoutes.register(app, { db });

const crypto = require('crypto');
const { randomUUID } = require('crypto');
const telegramAuth = require('../telegram-auth');
const vmcoClient = require('../vmco-client');
const ledger = require('../ledger');

// ─── Bot-auth constants ──────────────────────────────────────────
// VMCO pricing matches routes/vmco.js: 10,000 micros = 1 VMCO credit ($0.01)
const MICROS_PER_CREDIT = 10_000;
const MAX_REDEEM_MICROS = 1_000_000; // cap per command so a fat-finger
// doesn't drain a player's balance. Same cap as the player-facing
// /vmco/claim endpoint.
const MIN_REDEEM_MICROS = MICROS_PER_CREDIT; // 1 credit minimum

/**
 * Bot-authenticated redeem endpoint. The Signal Rush Telegram bot
 * (the only holder of ECONOMY_API_KEY) can call this on behalf of a
 * user who initiated /redeem from chat. Returns the newly created
 * (or topped-up) VMCO sub-key value, which the bot can DM back to
 * the user.
 *
 * Flow:
 *   1. Authenticate via ECONOMY_API_KEY (bot-only, server-to-server)
 *   2. Look up player by telegram_id
 *   3. Validate redeem amount (min/max/multiples of MICROS_PER_CREDIT)
 *   4. Provision or top up VMCO sub-key
 *   5. Decrement player_rewards.claimed_micros
 *   6. Record in reward_claims for audit
 *   7. Return sub_key (the bot DMs this to the user)
 *
 * Body: { "telegram_id": "...", "amount_micros": N }
 * Auth:  Authorization: Bearer <ECONOMY_API_KEY>
 * Response: { ok, sub_key, sub_key_id, budget_credits, claimed_micros }
 */

/**
 * Register Telegram routes on a Fastify app instance.
 *
 * @param {import('fastify').FastifyInstance} app
 * @param {{ db: import('better-sqlite3').Database }} opts
 */
function register(app, { db }) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN || null;

  // ─── POST /telegram/auth ──────────────────────────────────────────
  // Validates Telegram initData, finds or creates a player, returns player info + session token.
  //
  // Body: { "initData": "query-string-from-telegram" }
  // Response: { ok: true, player: { id, display_name, balance, ... }, session_token: "..." }
  // Error:    { ok: false, error: "..." }

  app.post('/telegram/auth', async (req, reply) => {
    const { initData } = req.body || {};

    if (!initData || typeof initData !== 'string') {
      reply.code(400);
      return { ok: false, error: 'initData is required' };
    }

    if (!botToken) {
      reply.code(500);
      return { ok: false, error: 'server misconfigured: no bot token' };
    }

    // Validate the initData with Telegram's signature check
    const result = telegramAuth.validateInitData(initData, botToken);
    if (!result.ok) {
      reply.code(401);
      return { ok: false, error: result.error };
    }

    const tgUser = result.user;
    const telegramId = String(tgUser.id);

    // Try to find an existing player linked to this Telegram ID
    let player = db.prepare(
      'SELECT id, display_name, created_at, total_earned, total_spent, balance FROM players WHERE telegram_id = ?'
    ).get(telegramId);

    if (!player) {
      // No linked player — create one
      const displayName = tgUser.username
        ? `@${tgUser.username}`
        : tgUser.first_name || `player_${telegramId}`;

      const playerId = randomUUID();
      db.prepare(
        'INSERT INTO players (id, display_name, telegram_id) VALUES (?, ?, ?)'
      ).run(playerId, displayName, telegramId);

      player = db.prepare(
        'SELECT id, display_name, created_at, total_earned, total_spent, balance FROM players WHERE id = ?'
      ).get(playerId);
    }

    // Generate a session token and persist it to the player record
    const sessionToken = randomUUID();
    const now = new Date().toISOString();
    db.prepare(
      'UPDATE players SET session_token = ?, session_created_at = COALESCE(session_created_at, ?), last_login_at = ? WHERE id = ?'
    ).run(sessionToken, now, now, player.id);

    reply.code(200);
    return {
      ok: true,
      player: {
        id: player.id,
        display_name: player.display_name,
        balance: player.balance,
        total_earned: player.total_earned,
        total_spent: player.total_spent,
        created_at: player.created_at,
      },
      telegram: {
        id: tgUser.id,
        first_name: tgUser.first_name,
        username: tgUser.username || null,
      },
      session_token: sessionToken,
    };
  });

  // ─── GET /telegram/player/:telegram_id ────────────────────────────
  // Returns player info by Telegram user ID.
  // Response: { ok: true, player: { ... } }
  // Error:    { ok: false, error: "player not found" }

  app.get('/telegram/player/:telegram_id', async (req, reply) => {
    const { telegram_id } = req.params;

    if (!telegram_id) {
      reply.code(400);
      return { ok: false, error: 'telegram_id is required' };
    }

    const player = db.prepare(
      'SELECT id, display_name, created_at, total_earned, total_spent, balance FROM players WHERE telegram_id = ?'
    ).get(telegram_id);

    if (!player) {
      reply.code(404);
      return { ok: false, error: 'player not found' };
    }

    return {
      ok: true,
      player: {
        id: player.id,
        display_name: player.display_name,
        balance: player.balance,
        total_earned: player.total_earned,
        total_spent: player.total_spent,
        created_at: player.created_at,
      },
    };
  });

  // ─── POST /telegram/link ──────────────────────────────────────────
  // Links an existing CLI player (UUID) to a Telegram account.
  // Requires valid initData + the player's existing UUID.
  // This enables a player who started on CLI to continue on Telegram
  // with the same balance, rewards, and history.
  //
  // Body: { "initData": "...", "player_id": "uuid-from-cli" }
  // Response: { ok: true, player: { ... }, linked: true }
  // Error:    { ok: false, error: "..." }

  app.post('/telegram/link', async (req, reply) => {
    const { initData, player_id } = req.body || {};

    if (!initData || typeof initData !== 'string') {
      reply.code(400);
      return { ok: false, error: 'initData is required' };
    }

    if (!player_id || typeof player_id !== 'string') {
      reply.code(400);
      return { ok: false, error: 'player_id is required (your existing CLI player UUID)' };
    }

    if (!botToken) {
      reply.code(500);
      return { ok: false, error: 'server misconfigured: no bot token' };
    }

    // Validate Telegram initData
    const result = telegramAuth.validateInitData(initData, botToken);
    if (!result.ok) {
      reply.code(401);
      return { ok: false, error: result.error };
    }

    const tgUser = result.user;
    const telegramId = String(tgUser.id);

    // Check if this Telegram ID is already linked to a different player
    const existingByTg = db.prepare(
      'SELECT id FROM players WHERE telegram_id = ?'
    ).get(telegramId);

    if (existingByTg && existingByTg.id !== player_id) {
      reply.code(409);
      return { ok: false, error: 'this Telegram account is already linked to a different player' };
    }

    // Find the CLI player by UUID
    const cliPlayer = db.prepare(
      'SELECT id, telegram_id FROM players WHERE id = ?'
    ).get(player_id);

    if (!cliPlayer) {
      reply.code(404);
      return { ok: false, error: 'player not found — check your player_id' };
    }

    if (cliPlayer.telegram_id && cliPlayer.telegram_id !== telegramId) {
      reply.code(409);
      return { ok: false, error: 'this player is already linked to a different Telegram account' };
    }

    // Link them
    const sessionToken = randomUUID();
    const now = new Date().toISOString();
    db.prepare(
      'UPDATE players SET telegram_id = ?, session_token = ?, session_created_at = COALESCE(session_created_at, ?), last_login_at = ? WHERE id = ?'
    ).run(telegramId, sessionToken, now, now, player_id);

    const player = db.prepare(
      'SELECT id, display_name, created_at, total_earned, total_spent, balance FROM players WHERE id = ?'
    ).get(player_id);

    reply.code(200);
    return {
      ok: true,
      linked: true,
      player: {
        id: player.id,
        display_name: player.display_name,
        balance: player.balance,
        total_earned: player.total_earned,
        total_spent: player.total_spent,
        created_at: player.created_at,
      },
      telegram: {
        id: tgUser.id,
        first_name: tgUser.first_name,
        username: tgUser.username || null,
      },
      session_token: sessionToken,
    };
  });

  // ─── POST /players/ensure ─────────────────────────────────────────
  // Bot-authenticated. Creates a player by UUID if they don't exist,
  // otherwise returns the existing player. Used by the Hermes plugin
  // to guarantee a player record exists for the current session's
  // playerId before wiring it into the widget via setPlayerId().
  //
  // Auth:  Authorization: Bearer ${ECONOMY_API_KEY} (bot-only)
  // Body:  { player_id: "uuid", display_name?: "..." }
  // Response: { ok, player: { id, display_name, balance, ... }, created: boolean }
  app.post('/players/ensure', async (req, reply) => {
    const expectedKey = (process.env.ECONOMY_API_KEY || '').trim();
    if (!expectedKey) {
      reply.code(503);
      return { ok: false, error: 'server misconfigured: ECONOMY_API_KEY not set' };
    }
    const authHeader = req.headers.authorization || '';
    const match = authHeader.match(/^Bearer\s+(.+)$/);
    const provided = match ? match[1].trim() : '';
    if (!provided || !crypto.timingSafeEqual(
      Buffer.from(provided.padEnd(64, '\0').slice(0, 64)),
      Buffer.from(expectedKey.padEnd(64, '\0').slice(0, 64)),
    )) {
      reply.code(401);
      return { ok: false, error: 'unauthorized — bot auth required' };
    }

    const { player_id, display_name } = req.body || {};
    if (!player_id || typeof player_id !== 'string' || !/^[0-9a-f-]{36}$/.test(player_id)) {
      reply.code(400);
      return { ok: false, error: 'player_id is required (must be UUID)' };
    }

    const existing = db.prepare(
      'SELECT id, display_name, created_at, total_earned, total_spent, balance FROM players WHERE id = ?'
    ).get(player_id);

    if (existing) {
      return {
        ok: true,
        created: false,
        player: {
          id: existing.id,
          display_name: existing.display_name,
          balance: existing.balance,
          total_earned: existing.total_earned,
          total_spent: existing.total_spent,
          created_at: existing.created_at,
        },
      };
    }

    // Create new player
    const name = (display_name && typeof display_name === 'string')
      ? display_name.slice(0, 64)
      : `hermes_${player_id.slice(0, 8)}`;
    const now = new Date().toISOString();
    db.prepare(
      'INSERT INTO players (id, display_name, created_at) VALUES (?, ?, ?)'
    ).run(player_id, name, now);

    return {
      ok: true,
      created: true,
      player: {
        id: player_id,
        display_name: name,
        balance: 0,
        total_earned: 0,
        total_spent: 0,
        created_at: now,
      },
    };
  });

  // ─── POST /telegram/redeem ───────────────────────────────────────
  // Bot-authenticated. The Signal Rush Telegram bot (the only holder
  // of ECONOMY_API_KEY) calls this when a user sends /redeem. Returns
  // the player's VMCO sub-key so the bot can DM it to the user.
  //
  // We require an Authorization header that matches ECONOMY_API_KEY.
  // Without that header, the request is rejected with 401 — regular
  // players must use the initData-validated /telegram/auth flow to
  // obtain a session_token and then call /vmco/claim directly.
  app.post('/telegram/redeem', async (req, reply) => {
    const expectedKey = (process.env.ECONOMY_API_KEY || '').trim();
    if (!expectedKey) {
      reply.code(503);
      return { ok: false, error: 'server misconfigured: ECONOMY_API_KEY not set' };
    }
    const authHeader = req.headers.authorization || '';
    const match = authHeader.match(/^Bearer\s+(.+)$/);
    const provided = match ? match[1].trim() : '';
    if (!provided || !crypto.timingSafeEqual(
      Buffer.from(provided.padEnd(64, '\0').slice(0, 64)),
      Buffer.from(expectedKey.padEnd(64, '\0').slice(0, 64)),
    )) {
      reply.code(401);
      return { ok: false, error: 'unauthorized — bot auth required' };
    }

    const { telegram_id, player_id, amount_micros } = req.body || {};
    if ((!telegram_id || typeof telegram_id !== 'string') && (!player_id || typeof player_id !== 'string')) {
      reply.code(400);
      return { ok: false, error: 'telegram_id or player_id is required' };
    }
    const amt = parseInt(amount_micros, 10);
    if (!Number.isFinite(amt) || amt <= 0) {
      reply.code(400);
      return { ok: false, error: 'amount_micros is required and must be > 0' };
    }
    if (amt < MIN_REDEEM_MICROS) {
      reply.code(400);
      return { ok: false, error: `minimum redeem is ${MIN_REDEEM_MICROS} micros (1 credit)` };
    }
    if (amt > MAX_REDEEM_MICROS) {
      reply.code(400);
      return { ok: false, error: `maximum redeem is ${MAX_REDEEM_MICROS} micros (100 credits)` };
    }
    if (amt % MICROS_PER_CREDIT !== 0) {
      reply.code(400);
      const rounded = Math.floor(amt / MICROS_PER_CREDIT) * MICROS_PER_CREDIT;
      return {
        ok: false,
        error: `amount must be a multiple of ${MICROS_PER_CREDIT} micros`,
        suggestion: rounded,
      };
    }

    // Find the player by telegram_id or player_id
    let player;
    if (telegram_id) {
      player = db.prepare(
        'SELECT id, display_name, telegram_id, vmco_sub_key, vmco_sub_key_id, vmco_sub_key_budget_credits FROM players WHERE telegram_id = ?'
      ).get(telegram_id);
    } else {
      player = db.prepare(
        'SELECT id, display_name, telegram_id, vmco_sub_key, vmco_sub_key_id, vmco_sub_key_budget_credits FROM players WHERE id = ?'
      ).get(player_id);
    }
    if (!player) {
      reply.code(404);
      return { ok: false, error: 'player not found — ask the user to play once first' };
    }

    // Check available rewards
    const rewards = db.prepare(
      'SELECT earned_micros, claimed_micros FROM player_rewards WHERE player_id = ?'
    ).get(player.id);
    const available = (rewards?.earned_micros || 0) - (rewards?.claimed_micros || 0);
    if (available < amt) {
      reply.code(409);
      return {
        ok: false,
        error: `insufficient rewards — have ${available} micros, requested ${amt}`,
        available_micros: available,
      };
    }

    // Cooldown: prevent spam-redeem (5s per player)
    const cooldownKey = 'telegram_redeem:' + (telegram_id || player_id);
    const cd = ledger.checkCooldown(db, cooldownKey, 5000);
    if (cd.limited) {
      reply.code(429);
      return { ok: false, error: 'redeem cooldown — please wait', retry_after_seconds: cd.retryAfter };
    }

    // Idempotency: if a request_id was provided, check if already processed
    if (req.body?.request_id) {
      const existing = db.prepare(
        `SELECT id FROM reward_claims WHERE idempotency_key = ? AND player_id = ? AND status = 'completed'`
      ).get('req:' + req.body.request_id, player.id);
      if (existing) {
        reply.code(409);
        return { ok: false, error: 'duplicate request — already processed' };
      }
    }

    // Set cooldown BEFORE the slow VMCO call (prevents retry racing)
    ledger.setCooldown(db, cooldownKey);

    // Check VMCO master key + balance
    let masterAcct;
    try {
      masterAcct = await vmcoClient.getAccount();
    } catch (err) {
      reply.code(503);
      return { ok: false, error: 'VMCO integration not configured (master key missing)' };
    }
    if ((masterAcct.balance_credits || 0) < 50) {
      reply.code(503);
      return {
        ok: false,
        error: 'VMCO master account temporarily low — redeem paused',
        balance_credits: masterAcct.balance_credits,
      };
    }

    // Provision or top up
    const creditsToAdd = amt / MICROS_PER_CREDIT;
    try {
      let subKeyId, subKeyValue, newBudget, isNew;
      if (player.vmco_sub_key_id) {
        const currentBudget = player.vmco_sub_key_budget_credits || 0;
        newBudget = currentBudget + creditsToAdd;
        await vmcoClient.updateSubKey(player.vmco_sub_key_id, { budget_credits: newBudget });
        subKeyId = player.vmco_sub_key_id;
        subKeyValue = player.vmco_sub_key;
        isNew = false;
      } else {
        const defaultModels = (process.env.VMCO_DEFAULT_ALLOWED_MODELS || '')
          .split(',').map(s => s.trim()).filter(Boolean);
        const created = await vmcoClient.createSubKey({
          name: `tg_${player.telegram_id || player.id.slice(0, 8)}`,
          budget_credits: creditsToAdd,
          allowed_models: defaultModels.length > 0 ? defaultModels : null,
        });
        subKeyId = created.id;
        subKeyValue = created.api_key;
        newBudget = creditsToAdd;
        isNew = true;
      }

      // Persist accounting atomically after the VMCO API call succeeds.
      const now = new Date().toISOString();
      const claimId = randomUUID();
      const claimKey = req.body?.request_id ? `req:${req.body.request_id}` : `bot:${randomUUID()}`;
      const tx = db.transaction(() => {
        if (isNew) {
          db.prepare(
            `UPDATE players SET vmco_sub_key = ?, vmco_sub_key_id = ?,
                    vmco_sub_key_created_at = ?, vmco_sub_key_budget_credits = ?
              WHERE id = ?`
          ).run(subKeyValue, subKeyId, now, newBudget, player.id);
        } else {
          db.prepare(
            'UPDATE players SET vmco_sub_key_budget_credits = ? WHERE id = ?'
          ).run(newBudget, player.id);
        }

        db.prepare(
          `UPDATE player_rewards
              SET claimed_micros = claimed_micros + ?, updated_at = datetime('now')
            WHERE player_id = ?`
        ).run(amt, player.id);

        db.prepare(
          `UPDATE rewards_pool
              SET total_claimed_micros = total_claimed_micros + ?, updated_at = datetime('now')
            WHERE id = 1`
        ).run(amt);

        db.prepare(
          `INSERT INTO reward_claims
            (id, player_id, amount_micros, status, ppq_account, idempotency_key, claimed_at, completed_at)
            VALUES (?, ?, ?, 'completed', ?, ?, datetime('now'), datetime('now'))`
        ).run(claimId, player.id, amt, `vmco:${subKeyId}`, claimKey);
      });
      tx();

      return {
        ok: true,
        sub_key: subKeyValue,
        sub_key_id: subKeyId,
        budget_credits: newBudget,
        claimed_micros: amt,
        is_new: isNew,
      };
    } catch (err) {
      reply.code(502);
      return { ok: false, error: 'VMCO API call failed', detail: err.message };
    }
  });
}

module.exports = { register };
