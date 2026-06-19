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

const { randomUUID } = require('crypto');
const telegramAuth = require('../telegram-auth');

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

    // Generate a session token (UUID, stored in-memory for now)
    const sessionToken = randomUUID();

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
}

module.exports = { register };
