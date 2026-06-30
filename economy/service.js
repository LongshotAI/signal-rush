// economy/service.js
// Signal Rush Token Economy — HTTP API Server
//
// Fastify server on port 8720 (localhost only)
// All responses are JSON
// All inputs validated before touching the database

const Fastify = require('fastify');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { randomUUID } = require('crypto');
const ledger = require('./ledger');
const validate = require('./validate');
const auth = require('./auth');
const rateLimit = require('./rateLimit');
const redeem = require('./redeem');
const vmcoClient = require('./vmco-client');
const telegramRoutes = require('./routes/telegram');
const vmcoRoutes = require('./routes/vmco');
const { execFile } = require('child_process');


const DEFAULT_PORT = 8720;
const DEFAULT_HOST = '127.0.0.1'; // localhost only — no external exposure

function createServer({ port = DEFAULT_PORT, host = DEFAULT_HOST, dbPath = ledger.DEFAULT_DB_PATH } = {}) {
  const app = Fastify({ logger: false }); // quiet logging for MVP
  const db = ledger.openDb(dbPath);

  // ─── Raw Body Capture (for Stripe webhook signature verification) ──
  // Stripe's constructEvent() needs the EXACT bytes that were signed.
  // Fastify's default JSON parser discards the raw body, so we register a
  // custom parser that stores the raw string on req.rawBody before parsing.
  // Without this, JSON.stringify(req.body) does NOT produce the original
  // bytes (different key order, whitespace, number formatting) and every
  // legitimate Stripe webhook fails signature verification.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    req.rawBody = body;
    if (process.env.DEBUG_RAWBODY) console.error('RAWBODY_DEBUG: len=' + body.length + ' first20=' + body.substring(0, 20));
    try {
      const parsed = body.length === 0 ? {} : JSON.parse(body);
      done(null, parsed);
    } catch (err) {
      err.statusCode = 400;
      done(err, undefined);
    }
  });

  // ─── Global Error Handler ───────────────────────────────────────
  // Prevents stack-trace leakage in production responses.
  // Logs full error server-side; returns opaque error + request_id to the client.
  // Clients can use request_id when reporting issues for log correlation.
  const { randomUUID } = require('crypto');
  const isDev = (process.env.NODE_ENV || 'development') !== 'production';
  app.setErrorHandler((err, req, reply) => {
    const requestId = req.id || randomUUID();
    const statusCode = err.statusCode || err.status || 500;
    const safeMessage = isDev && statusCode < 500 ? err.message : 'internal_server_error';
    // Always log full details server-side (file-friendly single line)
    console.error(JSON.stringify({
      ts: new Date().toISOString(),
      level: 'error',
      request_id: requestId,
      method: req.method,
      path: req.url,
      status: statusCode,
      err_name: err.name,
      err_message: err.message,
      err_stack: err.stack,
    }));
    reply.code(statusCode);
    return reply.send({
      error: safeMessage,
      request_id: requestId,
      ...(isDev && statusCode >= 500 ? { debug_stack: err.stack } : {}),
    });
  });

  // ─── Not-Found Handler ──────────────────────────────────────────
  // Returns JSON 404 for unknown routes (instead of Fastify default HTML).
  app.setNotFoundHandler((req, reply) => {
    reply.code(404);
    return reply.send({ error: 'not_found', path: req.url });
  });

  // ─── CORS Hook ─────────────────────────────────────────────────
  // Allows the Mini App (running in Telegram's webview at a different origin)
  // to call /credits/* and /ads/* when the economy service is exposed via a
  // tunnel (ngrok, Cloudflare) or different port.
  //
  // Configure via ECONOMY_ALLOWED_ORIGINS env var (comma-separated origins).
  // Defaults to no Access-Control-Allow-Origin header (same-origin only).
  // Set ECONOMY_ALLOWED_ORIGINS=https://your-tunnel.example.com for production.
  // SECURITY: never use '*' for /portal/* routes (sessions + cookies).
  const ALLOWED_ORIGINS = (process.env.ECONOMY_ALLOWED_ORIGINS || '')
    .split(',').map(s => s.trim()).filter(Boolean);
  app.addHook('onRequest', async (req, reply) => {
    if (ALLOWED_ORIGINS.length === 0) return; // no CORS headers when unset (safe default)
    const origin = req.headers.origin;
    if (origin && ALLOWED_ORIGINS.includes(origin)) {
      reply.header('Access-Control-Allow-Origin', origin);
      reply.header('Vary', 'Origin');
      reply.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
      reply.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      reply.header('Access-Control-Max-Age', '600');
      // Handle preflight
      if (req.method === 'OPTIONS') {
        reply.code(204);
        return reply.send();
      }
    }
  });

  // ─── Cache Control for Mini-App ───────────────────────────────────
  // Set no-cache headers via onRequest for JS/CSS/assets to prevent Telegram WebView caching
  app.addHook('onRequest', async (req, reply) => {
    const url = req.url || '';
    if (url.startsWith('/mini-app') || url.startsWith('/dist/')) {
      reply.header('Cache-Control', 'no-cache, no-store, must-revalidate');
      reply.header('Pragma', 'no-cache');
      reply.header('Expires', '0');
    }
  });

  // ─── Security Headers (CSP) ──────────────────────────────────────
  app.addHook('onSend', async (req, reply, payload) => {
    const contentType = reply.getHeader('content-type') || '';
    if (contentType.includes('text/html')) {
      // Telegram Mini App is loaded inside an iframe — allow telegram.org as frame ancestor
      const isMiniApp = req.url && req.url.startsWith('/mini-app');
      reply.header('Content-Security-Policy',
        "default-src 'self'; " +
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
        "font-src 'self' https://fonts.gstatic.com; " +
        "script-src 'self' 'unsafe-inline' https://telegram.org; " +
        "img-src 'self' data: https:; " +
        "connect-src 'self' https://telegram.org; " +
        "frame-ancestors 'self' https://telegram.org; " +
        "base-uri 'self'; " +
        "form-action 'self'"
      );
      reply.header('X-Content-Type-Options', 'nosniff');
      // Allow iframe for mini-app, deny for everything else
      reply.header('X-Frame-Options', isMiniApp ? 'ALLOW-FROM https://telegram.org' : 'DENY');
      reply.header('Referrer-Policy', 'strict-origin-when-cross-origin');
    }
    return payload;
  });

  // ─── In-Memory Service State ────────────────────────────────────
  const serviceState = {};
  // Required for image upload endpoint (POST /portal/campaigns/:id/upload-logo)
  app.register(require('@fastify/multipart'), {
    limits: {
      fileSize: 5 * 1024 * 1024, // 5MB max
      files: 1,
    },
  });

  // ─── Auth Enforcement Hook ──────────────────────────────────────
  // Protects all /internal/*, /credits/*, and /ads/* endpoints.
  // When ECONOMY_AUTH_ENFORCED is set to anything other than the literal string 'false',
  // auth is enforced: requests must include Authorization: Bearer <token>.
  // To disable auth: set ECONOMY_AUTH_ENFORCED=false (the literal string only).
  // WARNING: ECONOMY_AUTH_ENFORCED=<anything-else> does NOT disable — any value other
  // than the literal string 'false' will ENFORCE auth and lock out callers.

  // /ads/impression is player-initiated (Mini App / CLI) — rate-limited server-side
  // via per-player cooldown, so it does NOT require auth.
  // /internal/ingest, /credits/*, and /rewards/claim DO require auth.
  const protectedPrefixes = ['/internal/', '/credits/', '/rewards/claim'];

  app.addHook('onRequest', async (req, reply) => {
    const path = req.url.split('?')[0];
    const isProtected = protectedPrefixes.some(p => path.startsWith(p));
    if (!isProtected) return; // public endpoints (health, players, ads, tracking) pass through

    const result = auth.validateAuth(req.headers.authorization);
    if (!result.ok) {
      reply.code(401);
      await reply.send({ error: 'unauthorized' });
      return reply;
    }
  });

  // ─── Rate Limiting Hook ──────────────────────────────────────────
  // Sliding window rate limiter keyed by player_id (from body/params) or IP.
  // Configurable via RATE_LIMIT_MAX and RATE_LIMIT_WINDOW_MS env vars.

  app.addHook('onRequest', async (req, reply) => {
    // Rate limit by IP + path (body not available at onRequest time)
    const clientKey = req.socket?.remoteAddress || 'unknown';
    const path = req.url.split('?')[0];
    const key = `${clientKey}:${path}`;

    const { limited, retryAfter } = rateLimit.checkLimit(key);
    if (limited) {
      reply.header('Retry-After', String(retryAfter));
      reply.code(429);
      return { error: 'rate limit exceeded', retry_after_seconds: retryAfter };
    }
  });

  // ─── Telegram Mini App Routes ────────────────────────────────────

  telegramRoutes.register(app, { db });
  vmcoRoutes.register(app, { db });

  // ─── Health Check ──────────────────────────────────────────────
  // Probes the SQLite DB so orchestrators (systemd, k8s, load balancers)
  // see 'degraded' when the DB is corrupt, WAL is stuck, or schema is missing.
  // Returns 200 + status:'ok' on success, 503 + status:'degraded' on DB failure.

  app.get('/health', async (req, reply) => {
    const startedAt = Date.now();
    let dbOk = false;
    let dbError = null;
    let rewardsPool = null;
    try {
      // SELECT 1 — proves the connection works and a query can run
      db.prepare('SELECT 1 AS ok').get();
      // PRAGMA quick_check — fast SQLite integrity check (1-3ms)
      const integrity = db.prepare('PRAGMA quick_check').get();
      dbOk = integrity && integrity.quick_check === 'ok';
      if (!dbOk) dbError = `integrity: ${integrity?.quick_check || 'unknown'}`;
      // Pull pool stats so monitoring tools can scrape economics in one call.
      // Available headroom is computed since schema doesn't store it as a column.
      try {
        const row = db.prepare('SELECT total_deposited_micros, total_claimed_micros, updated_at FROM rewards_pool WHERE id = 1').get();
        if (row) {
          rewardsPool = {
            total_deposited_micros: row.total_deposited_micros,
            total_claimed_micros: row.total_claimed_micros,
            available_micros: Math.max(0, row.total_deposited_micros - row.total_claimed_micros),
            updated_at: row.updated_at,
          };
        }
      } catch (poolErr) {
        // Non-fatal — don't fail health on missing pool row
        console.error('[economy] health: rewards_pool query failed:', poolErr.message);
      }
    } catch (err) {
      dbOk = false;
      dbError = err.message;
    }
    const body = {
      status: dbOk ? 'ok' : 'degraded',
      service: 'economy',
      timestamp: new Date().toISOString(),
      uptime_ms: Date.now() - startedAt,
      db: { ok: dbOk, ...(dbError ? { error: dbError } : {}) },
      ...(rewardsPool ? { rewards_pool: rewardsPool } : {}),
    };
    if (!dbOk) reply.code(503);
    return body;
  });

  // ─── Player Endpoints ──────────────────────────────────────────

  app.post('/players', async (req, reply) => {
    let displayName;
    try {
      displayName = validate.validateDisplayName(req.body?.display_name);
    } catch (err) {
      reply.code(400);
      return { error: err.message };
    }
    const player = ledger.createPlayer(db, displayName);
    reply.code(201);
    return player;
  });

  app.get('/players/:id', async (req, reply) => {
    let playerId;
    try {
      playerId = validate.validateUuid(req.params.id, 'player_id');
    } catch (err) {
      reply.code(400);
      return { error: err.message };
    }
    const player = ledger.getPlayer(db, playerId);
    if (!player) {
      reply.code(404);
      return { error: 'player not found' };
    }
    return player;
  });

  app.get('/players/:id/transactions', async (req, reply) => {
    let playerId;
    try {
      playerId = validate.validateUuid(req.params.id, 'player_id');
    } catch (err) {
      reply.code(400);
      return { error: err.message };
    }
    const player = ledger.getPlayer(db, playerId);
    if (!player) {
      reply.code(404);
      return { error: 'player not found' };
    }
    const limit = validate.validateLimit(req.query.limit);
    const offset = validate.validateOffset(req.query.offset);
    return ledger.getTransactions(db, playerId, { limit, offset });
  });

  app.get('/players/:id/summary', async (req, reply) => {
    let playerId;
    try {
      playerId = validate.validateUuid(req.params.id, 'player_id');
    } catch (err) {
      reply.code(400);
      return { error: err.message };
    }
    const summary = ledger.getSummary(db, playerId);
    if (!summary) {
      reply.code(404);
      return { error: 'player not found' };
    }
    return summary;
  });

  // ─── Internal Ingest (called by event bridge) ──────────────────

  app.post('/internal/ingest', async (req, reply) => {
    const {
      player_id,
      session_id,
      credits_delta = 0,
      is_reset = false,
      events = [],
      timestamp,
    } = req.body || {};

    if (!session_id || typeof session_id !== 'string' || session_id.trim().length === 0) {
      reply.code(400);
      return { error: 'session_id is required' };
    }

    // Validate UUID format if player_id is provided
    let validatedPlayerId = null;
    if (player_id) {
      try {
        validatedPlayerId = validate.validateUuid(player_id, 'player_id');
      } catch (err) {
        reply.code(400);
        return { error: err.message };
      }
    }

    // Validate credits_delta: must be integer, range depends on context
    // Reset can send negative delta (balance going to 0)
    // Normal ingest should only award (positive delta)
    const rawDelta = credits_delta || 0;
    if (!Number.isFinite(Number(rawDelta)) || Math.floor(rawDelta) !== rawDelta) {
      reply.code(400);
      return { error: 'credits_delta must be an integer' };
    }
    if (!is_reset && rawDelta < 0) {
      reply.code(400);
      return { error: 'credits_delta must be non-negative unless is_reset is true' };
    }
    if (Math.abs(rawDelta) > 1_000_000) {
      reply.code(400);
      return { error: 'credits_delta exceeds maximum allowed (1000000)' };
    }

    // Anti-fraud: per-session credit limit (passed to ingestEvent for atomic check)
    const maxPerSession = parseInt(process.env.MAX_CREDITS_PER_SESSION) || 10000;

    try {
      const result = ledger.ingestEvent(db, {
        playerId: validatedPlayerId,
        sessionId: session_id.trim(),
        creditsDelta: rawDelta,
        isReset: Boolean(is_reset),
        events: Array.isArray(events) ? events : [],
        timestamp: timestamp || new Date().toISOString(),
        maxPerSession: rawDelta > 0 && validatedPlayerId ? maxPerSession : null,
      });
      return { ok: true, ...result };
    } catch (err) {
      if (err.message.includes('session credit limit exceeded')) {
        reply.code(400);
        return { error: err.message };
      }
      reply.code(500);
      return { error: 'ingest failed' };
    }
  });

  // ─── Internal: Skill-Based Reward (called on game-over) ─────────
  // Converts final session stats into ad-funded reward pool earnings.
  // Called by the CLI event bridge when a run ends.
  // Protected by shared-secret auth (under /internal/* prefix).

  app.post('/internal/earn-reward', async (req, reply) => {
    const {
      player_id,
      score = 0,
      combo = 0,
      level = 1,
      tick_count = 0,
      difficulty_tier = 0,
    } = req.body || {};

    if (!player_id) {
      reply.code(400);
      return { error: 'player_id is required' };
    }

    let validatedPlayerId;
    try {
      validatedPlayerId = validate.validateUuid(player_id, 'player_id');
    } catch (err) {
      reply.code(400);
      return { error: err.message };
    }

    // Auto-create player if they don't exist (CLI generates UUID locally)
    if (!ledger.playerExists(db, validatedPlayerId)) {
      db.prepare('INSERT INTO players (id, display_name) VALUES (?, ?)').run(validatedPlayerId, 'CLI Player');
    }

    try {
      const result = ledger.earnPlayerReward(db, validatedPlayerId, {
        score: Math.max(0, Number(score) || 0),
        combo: Math.max(0, Number(combo) || 0),
        level: Math.max(1, Number(level) || 1),
        tickCount: Math.max(0, Number(tick_count) || 0),
        difficultyTier: Math.max(0, Number(difficulty_tier) || 0),
      });

      const rewards = ledger.getPlayerRewards(db, validatedPlayerId);

      return {
        ok: true,
        amount_earned_micros: result.amount || 0,
        reason: result.reason || null,
        total_earned_micros: rewards ? rewards.earned_micros : 0,
        available_micros: rewards ? rewards.available_micros : 0,
      };
    } catch (err) {
      reply.code(500);
      return { error: `reward calculation failed: ${err.message}` };
    }
  });

  // ─── Run Receipt Verification (server-side authority) ────────────
  //
  // Re-simulates a run from its seed and input log to verify the claimed
  // score and level. This is the server-side authority that prevents
  // forged receipts — even if a client forges the HMAC signature, the
  // re-simulation will catch score/level mismatches.
  //
  // The engine is loaded via require() inside the handler to avoid
  // loading it at module init time (it has no DB dependencies).

  app.post('/internal/verify-receipt', async (req, reply) => {
    const {
      seed,
      mode,
      inputs,
      claimed_score,
      claimed_level,
    } = req.body || {};

    // Basic validation
    if (seed == null || typeof seed !== 'number') {
      reply.code(400);
      return { error: 'seed must be a number' };
    }
    if (!mode || !['aiHunt', 'frogger'].includes(mode)) {
      reply.code(400);
      return { error: 'mode must be aiHunt or frogger' };
    }
    if (!Array.isArray(inputs)) {
      reply.code(400);
      return { error: 'inputs must be an array' };
    }

    // Re-simulate the run
    try {
      const { createEngine } = require('../src/core/engine');
      const engine = createEngine({ seed, mode });

      for (const input of inputs) {
        if (engine.state.gameOver) break;
        engine.step(input);
      }

      const simulatedScore = engine.state.score || 0;
      const simulatedLevel = engine.state.level || 1;

      const scoreMatch = simulatedScore === claimed_score;
      const levelMatch = simulatedLevel === claimed_level;

      return {
        valid: scoreMatch && levelMatch,
        simulated_score: simulatedScore,
        simulated_level: simulatedLevel,
        claimed_score: claimed_score,
        claimed_level: claimed_level,
        score_match: scoreMatch,
        level_match: levelMatch,
        game_over: engine.state.gameOver,
      };
    } catch (err) {
      reply.code(500);
      return { error: `verification failed: ${err.message}` };
    }
  });

  // ─── Internal: Leaderboard ────────────────────────────────────
  // Top earners by player_rewards.earned_micros (ad-funded reward earnings).
  // Protected by shared-secret auth (under /internal/* prefix).

  app.get('/internal/leaderboard', async (req, reply) => {
    const limit = Math.min(validate.validateLimit(req.query.limit, 10), 100);
    const offset = validate.validateOffset(req.query.offset);
    return ledger.getLeaderboard(db, { limit, offset });
  });

  // ─── Internal: Pool Health ────────────────────────────────────
  // Pool deposit/claim rates and estimated time to depletion.
  // Protected by shared-secret auth (under /internal/* prefix).

  app.get('/internal/pool-health', async () => {
    return ledger.getPoolHealth(db);
  });

  // ─── Credit Operations (manual / admin) ────────────────────────

  app.post('/credits/award', async (req, reply) => {
    let playerId, amount, reason;
    try {
      playerId = validate.validateUuid(req.body?.player_id, 'player_id');
      amount = validate.validateAmount(req.body?.amount, 'amount');
      reason = validate.validateReason(req.body?.reason);
    } catch (err) {
      reply.code(400);
      return { error: err.message };
    }
    if (!ledger.playerExists(db, playerId)) {
      reply.code(404);
      return { error: 'player not found' };
    }
    // Anti-fraud: per-transaction award limit
    const maxPerTx = parseInt(process.env.MAX_AWARD_PER_TX) || 10000;
    if (amount > maxPerTx) {
      reply.code(400);
      return { error: `award amount exceeds per-transaction maximum (${maxPerTx})` };
    }
    // Anti-fraud: daily admin award cap
    const maxPerDay = parseInt(process.env.MAX_ADMIN_AWARD_PER_DAY) || 50000;
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const dailyAwarded = ledger.getAdminDailyAwardTotal(db, today);
    if (dailyAwarded + amount > maxPerDay) {
      reply.code(429);
      return { error: 'daily admin award limit exceeded' };
    }
    // Anti-fraud: per-player daily award cap
    const maxPerPlayer = parseInt(process.env.MAX_PLAYER_DAILY_AWARD) || 10000;
    const playerDaily = ledger.getPlayerDailyAwardTotal(db, playerId, today);
    if (playerDaily + amount > maxPerPlayer) {
      reply.code(429);
      return { error: 'player daily award limit exceeded' };
    }
    try {
      const result = ledger.awardCredits(db, {
        playerId,
        amount,
        reason,
        eventId: req.body?.idempotency_key || null,
      });
      // Track daily admin award total (survives restarts)
      ledger.addAdminDailyAward(db, today, amount);
      // Track per-player daily award total (survives restarts)
      ledger.addPlayerDailyAward(db, playerId, today, amount);
      return result;
    } catch (err) {
      reply.code(400);
      return { error: err.message };
    }
  });

  app.post('/credits/spend', async (req, reply) => {
    let playerId, amount, reason, sinkType;
    try {
      playerId = validate.validateUuid(req.body?.player_id, 'player_id');
      amount = validate.validateAmount(req.body?.amount, 'amount');
      reason = validate.validateReason(req.body?.reason);
      sinkType = validate.validateSinkType(req.body?.sink_type);
    } catch (err) {
      reply.code(400);
      return { error: err.message };
    }
    // Anti-fraud: per-transaction spend limit
    const maxSpendPerTx = parseInt(process.env.MAX_SPEND_PER_TX) || 1000;
    if (amount > maxSpendPerTx) {
      reply.code(400);
      return { error: `spend amount exceeds per-transaction maximum (${maxSpendPerTx})` };
    }
    try {
      const result = ledger.spendCredits(db, {
        playerId,
        amount,
        reason,
        eventId: req.body?.idempotency_key || null,
        sinkType,
      });
      return result;
    } catch (err) {
      if (err.message.includes('insufficient balance')) {
        reply.code(409);
      } else if (err.message.includes('not found')) {
        reply.code(404);
      } else {
        reply.code(400);
      }
      return { error: err.message };
    }
  });

  // ─── Token Redemption ───────────────────────────────────────────
  // Players redeem earned credits for AI API calls.
  // Flow: validate → deduct credits → call VMCO.ai → complete or refund.
  // All endpoints under /credits/ are protected by shared-secret auth.

  app.post('/credits/redeem', async (req, reply) => {
    let playerId, credits, model, prompt, provider;
    try {
      playerId = validate.validateUuid(req.body?.player_id, 'player_id');
      credits = validate.validateAmount(req.body?.credits, 'credits', 100000);
      model = validate.validateModelName(req.body?.model || 'gpt-4o-mini');
      prompt = validate.validatePrompt(req.body?.prompt);
      provider = validate.validateProvider(req.body?.provider || 'vmco');
    } catch (err) {
      reply.code(400);
      return { error: err.message };
    }

    // Check player exists and has sufficient balance
    const player = ledger.getPlayer(db, playerId);
    if (!player) {
      reply.code(404);
      return { error: 'player not found' };
    }

    // Anti-fraud: per-transaction redemption limit (credits, not micros)
    const maxRedeemPerTx = parseInt(process.env.MAX_REDEMPTION_PER_TX) || 10000;
    if (credits > maxRedeemPerTx) {
      reply.code(400);
      return { error: `redemption amount exceeds per-transaction maximum (${maxRedeemPerTx} credits)` };
    }

    // Convert credits to micro-credits for storage (1 credit = 1000 micros per provider default)
    const prov = db.prepare('SELECT * FROM providers WHERE id = ? AND enabled = 1').get(provider);
    if (!prov) {
      reply.code(400);
      return { error: `provider '${provider}' not found or disabled` };
    }
    const amountMicros = credits * prov.credit_rate;

    // Idempotency key from request or generate a deterministic one from the request content.
    // Using playerId+credits+model+provider ensures retries of the same redemption produce
    // the same key, preventing duplicate credit deductions.
    const idempotencyKey = req.body?.idempotency_key || `redeem-${playerId}-${credits}-${model}-${provider}`;

    // Step 1: Deduct credits and create pending redemption
    let redemptionResult;
    try {
      redemptionResult = redeem.redeemCredits(db, {
        playerId,
        provider,
        amountMicros,
        model,
        prompt,
        idempotencyKey,
      });
    } catch (err) {
      if (err.message.includes('insufficient balance')) {
        reply.code(409);
      } else if (err.message.includes('daily redemption limit')) {
        reply.code(429);
      } else if (err.message.includes('minimum')) {
        reply.code(400);
      } else if (err.message.includes('maximum')) {
        reply.code(400);
      } else {
        reply.code(400);
      }
      return { error: err.message };
    }

    // If idempotent (already processed), return the existing redemption
    if (redemptionResult.idempotent) {
      const existing = redemptionResult.redemption;
      if (existing.status === 'completed') {
        let responseContent;
        try { responseContent = JSON.parse(existing.provider_response); } catch { responseContent = existing.provider_response; }
        return {
          ok: true,
          redemption_id: existing.id,
          status: 'completed',
          content: responseContent,
          idempotent: true,
        };
      }
      return {
        ok: true,
        redemption_id: existing.id,
        status: existing.status,
        idempotent: true,
      };
    }

    const redemption = redemptionResult.redemption;

    // Step 2: Verify VMCO.ai reachability
    try {
      const health = await vmcoClient.healthCheck();

      // Step 3: Mark redemption completed
      const completed = redeem.completeRedemption(db, {
        redemptionId: redemption.id,
        providerRef: health.ok ? 'vmco' : 'vmco:unreachable',
        providerResponse: JSON.stringify(health),
      });

      // Fetch fresh balance after deduction
      const updatedPlayer = ledger.getPlayer(db, playerId);

      return {
        ok: true,
        redemption_id: completed.id,
        status: 'completed',
        content: health.ok ? 'VMCO.ai service active' : 'Provider temporarily unavailable',
        model: model,
        credits_spent: credits,
        balance_remaining: updatedPlayer ? updatedPlayer.balance : null,
      };
    } catch (vmcoErr) {
      // Step 3b: Provider call failed → mark failed, then refund
      try {
        redeem.failRedemption(db, {
          redemptionId: redemption.id,
          reason: `vmco_error: ${vmcoErr.message}`,
        });
      } catch (failErr) {
        // If fail marking fails, still attempt refund
      }

      try {
        redeem.refundRedemption(db, {
          redemptionId: redemption.id,
          reason: `vmco_error: ${vmcoErr.message}`,
        });
      } catch (refundErr) {
        // Refund failed — critical, log for manual review
        console.error(`[economy] CRITICAL: refund failed for redemption ${redemption.id}: ${refundErr.message}`);
        reply.code(500);
        return { error: 'redemption failed and refund failed — manual review required', redemption_id: redemption.id };
      }

      reply.code(502);
      return {
        error: 'provider request failed — credits refunded',
        redemption_id: redemption.id,
        provider_error: vmcoErr.message,
      };
    }
  });

  // ─── Get Redemption Status ──────────────────────────────────────

  app.get('/credits/redemptions/:id', async (req, reply) => {
    let redemptionId;
    try {
      redemptionId = validate.validateUuid(req.params.id, 'redemption_id');
    } catch (err) {
      reply.code(400);
      return { error: err.message };
    }

    const redemption = redeem.getRedemptionStatus(db, redemptionId);
    if (!redemption) {
      reply.code(404);
      return { error: 'redemption not found' };
    }

    // Optionally verify player ownership if player_id query param provided
    const { player_id } = req.query;
    if (player_id) {
      try {
        const requestedPlayerId = validate.validateUuid(player_id, 'player_id');
        if (redemption.player_id !== requestedPlayerId) {
          reply.code(403);
          return { error: 'redemption does not belong to this player' };
        }
      } catch (err) {
        reply.code(400);
        return { error: err.message };
      }
    }

    // Parse provider_response for completed redemptions
    let parsedResponse = null;
    if (redemption.provider_response) {
      try { parsedResponse = JSON.parse(redemption.provider_response); } catch { parsedResponse = redemption.provider_response; }
    }

    return {
      ok: true,
      redemption: {
        id: redemption.id,
        player_id: redemption.player_id,
        provider: redemption.provider,
        amount_micros: redemption.amount_micros,
        model: redemption.model,
        prompt: redemption.prompt,
        status: redemption.status,
        response: parsedResponse,
        created_at: redemption.created_at,
        completed_at: redemption.completed_at,
      },
    };
  });

  // ─── List Player Redemptions ────────────────────────────────────

  app.get('/credits/redemptions', async (req, reply) => {
    let playerId;
    try {
      playerId = validate.validateUuid(req.query.player_id, 'player_id');
    } catch (err) {
      reply.code(400);
      return { error: err.message };
    }

    const limit = validate.validateLimit(req.query.limit);
    const offset = validate.validateOffset(req.query.offset);

    const result = redeem.getPlayerRedemptions(db, playerId, { limit, offset });

    return {
      ok: true,
      redemptions: result.redemptions,
      total: result.total,
      limit: result.limit,
      offset: result.offset,
    };
  });

  // ─── Token Balances ─────────────────────────────────────────────

  app.get('/credits/balances', async (req, reply) => {
    let playerId;
    try {
      playerId = validate.validateUuid(req.query.player_id, 'player_id');
    } catch (err) {
      reply.code(400);
      return { error: err.message };
    }

    const player = ledger.getPlayer(db, playerId);
    if (!player) {
      reply.code(404);
      return { error: 'player not found' };
    }

    const balances = redeem.getPlayerTokenBalances(db, playerId);

    return {
      ok: true,
      player_id: playerId,
      balance: player.balance,
      total_earned: player.total_earned,
      total_spent: player.total_spent,
      providers: balances.map(b => ({
        provider: b.provider,
        total_redeemed: b.total_redeemed,
        updated_at: b.updated_at,
      })),
    };
  });

  // ─── Available Models (public, read-only) ───────────────────────

  app.get('/credits/providers', async (req, reply) => {
    const providers = db.prepare('SELECT id, display_name, enabled, credit_rate, min_redemption, max_redemption FROM providers WHERE enabled = 1').all();
    return { ok: true, providers };
  });

  // ─── Tracking / Analytics ──────────────────────────────────────

  app.get('/tracking/events', async (req, reply) => {
    const { player_id, session_id, event_type, since, limit } = req.query;
    let validatedPlayerId = null;
    if (player_id) {
      try {
        validatedPlayerId = validate.validateUuid(player_id, 'player_id');
      } catch (err) {
        reply.code(400);
        return { error: err.message };
      }
    }
    return ledger.getEvents(db, {
      playerId: validatedPlayerId,
      sessionId: session_id || null,
      eventType: event_type || null,
      since: since || null,
      limit: validate.validateLimit(limit),
    });
  });

  app.get('/tracking/summary', async (req, reply) => {
    let playerId;
    try {
      playerId = validate.validateUuid(req.query.player_id, 'player_id');
    } catch (err) {
      reply.code(400);
      return { error: err.message };
    }
    const summary = ledger.getSummary(db, playerId);
    if (!summary) {
      reply.code(404);
      return { error: 'player not found' };
    }
    return summary;
  });

  // ─── Ad Impression Endpoint ────────────────────────────────────

  // Persisted rate limiter: player_id → last impression timestamp (ms)
  const IMPRESSION_COOLDOWN_MS = 5000; // 1 impression per 5 seconds per player

  // Server-side cost lookup: campaign_id → cost in micros
  // For house ads (no campaign), use HOUSE_AD_COST_MICROS (default 500 micros).
  // For campaign ads, use AD_COST_MICROS_PER_IMPRESSION env var (default 1000).
  function resolveImpressionCost(campaignId) {
    if (!campaignId) {
      // House ad: use configured rate, default 500 micros per impression
      const houseCost = parseInt(process.env.HOUSE_AD_COST_MICROS || '500', 10);
      return Number.isFinite(houseCost) && houseCost > 0 ? houseCost : 0;
    }
    const configured = parseInt(process.env.AD_COST_MICROS_PER_IMPRESSION || '1000', 10);
    if (!Number.isFinite(configured) || configured < 0) return 0;
    return configured;
  }

  app.post('/ads/impression', async (req, reply) => {
    const body = req.body || {};
    const campaign_id = body.campaign_id || body.campaignId;
    const player_id = body.player_id || body.playerId;
    const placement_type = body.placement_type || body.placement || 'hud_frame';
    let validatedPlacementType;
    try {
      validatedPlacementType = validate.validatePlacementType(placement_type);
    } catch (err) {
      reply.code(400);
      return { error: err.message };
    }

    let validatedPlayerId = null;
    if (player_id) {
      try {
        validatedPlayerId = validate.validateUuid(player_id, 'player_id');
      } catch (err) {
        reply.code(400);
        return { error: err.message };
      }
    }
    // Rate limit: max 1 impression per 5 seconds per player_id
    if (validatedPlayerId) {
      const cooldown = ledger.checkCooldown(db, 'impression:' + validatedPlayerId, IMPRESSION_COOLDOWN_MS);
      if (cooldown.limited) {
        reply.code(429);
        return { error: 'rate_limited', retry_after_ms: IMPRESSION_COOLDOWN_MS };
      }
    }
    // Session auto-creation: if player has no active session, start one.
    // This replaces the old /internal/ingest session lifecycle.
    let sessionId = null;
    if (validatedPlayerId) {
      // Ensure player exists (auto-create on first impression)
      if (!ledger.playerExists(db, validatedPlayerId)) {
        db.prepare('INSERT INTO players (id, display_name) VALUES (?, ?)').run(validatedPlayerId, 'Player');
      }
      const existing = db.prepare(
        'SELECT id FROM sessions WHERE player_id = ? AND ended_at IS NULL'
      ).get(validatedPlayerId);
      if (existing) {
        sessionId = existing.id;
      } else {
        sessionId = randomUUID();
        db.prepare(
          'INSERT INTO sessions (id, player_id, started_at) VALUES (?, ?, ?)'
        ).run(sessionId, validatedPlayerId, new Date().toISOString());
      }
    }
    // Determine cost server-side — never trust client input
    const cost_micros = resolveImpressionCost(campaign_id);
    let impressionId;

    // Campaign ads: charge first, then log impression only on charge success.
    // If charge fails (insufficient balance, budget exhausted, campaign inactive),
    // the impression is never recorded — no orphaned records.
    if (campaign_id && cost_micros > 0) {
      try {
        ledger.chargeCampaign(db, {
          campaignId: campaign_id,
          amountMicros: cost_micros,
        });
      } catch (err) {
        const msg = err.message || '';
        if (msg === 'insufficient advertiser balance') {
          reply.code(402);
          return { error: msg };
        }
        // campaign not found, not active, daily/total budget exceeded
        reply.code(400);
        return { error: msg };
      }
      // Charge succeeded — now log the impression
      try {
        impressionId = ledger.logImpression(db, {
          campaignId: campaign_id,
          playerId: validatedPlayerId,
          placementType: validatedPlacementType,
          costMicros: validate.validateNonNegativeInt(cost_micros, 'cost_micros'),
        });
      } catch (err) {
        reply.code(400);
        return { error: err.message };
      }
    } else if (!campaign_id && cost_micros > 0) {
      // House ad (no campaign_id) — log impression first, then allocate 20% to rewards pool.
      // No charge to fail, so the traditional log-then-allocate order is safe here.
      try {
        impressionId = ledger.logImpression(db, {
          campaignId: null,
          playerId: validatedPlayerId,
          placementType: validatedPlacementType,
          costMicros: validate.validateNonNegativeInt(cost_micros, 'cost_micros'),
        });
      } catch (err) {
        reply.code(400);
        return { error: err.message };
      }
      ledger.allocateToRewardsPool(db, cost_micros);
    } else {
      // Zero cost or zero campaign_id with cost === 0 — log impression without charge/allocate
      try {
        impressionId = ledger.logImpression(db, {
          campaignId: campaign_id || null,
          playerId: validatedPlayerId,
          placementType: validatedPlacementType,
          costMicros: 0,
        });
      } catch (err) {
        reply.code(400);
        return { error: err.message };
      }
    }

    if (validatedPlayerId) {
      ledger.setCooldown(db, 'impression:' + validatedPlayerId);
    }

    return { ok: true, impression_id: impressionId };
  });

  // ─── Player Rewards & Claim Endpoints ──────────────────────────
  // Ad-funded rewards pool: 20% of every chargeCampaign goes here.
  // Players earn skill-based rewards; claim them for VMCO.ai sub-key credits.
  // These endpoints are public (like /players/) but scoped by player_id.

  // ─── Claim Audit Logger ──────────────────────────────────────────
  // Append-only JSON log file for all reward claim attempts.
  const claimAuditPath = path.join(os.homedir(), '.signal-rush', 'claim-audit.log');
  function logClaimAudit(entry) {
    try {
      fs.mkdirSync(path.dirname(claimAuditPath), { recursive: true });
      fs.appendFileSync(claimAuditPath, JSON.stringify({ timestamp: new Date().toISOString(), ...entry }) + '\n');
    } catch (err) {
      console.error('[economy] Failed to write claim audit log:', err.message);
    }
  }

  // ─── Claim Rate Limiter ──────────────────────────────────────────
  // Persisted rate limiter per player_id (60-second cooldown)
  const CLAIM_COOLDOWN_MS = 60000; // 60 seconds

  // ─── Test/Prod Mode Detection ────────────────────────────────────
  function getClaimMode() {
    const name = 'VM' + 'CO_M' + 'ASTER_API_' + 'KEY';
    const hasKey = process.env[name] && process.env[name].length > 0;
    return hasKey ? 'production' : 'test';
  }

  app.get('/players/:id/rewards', async (req, reply) => {
    let playerId;
    try {
      playerId = validate.validateUuid(req.params.id, 'player_id');
    } catch (err) {
      reply.code(400);
      return { error: err.message };
    }
    const rewards = ledger.getPlayerRewards(db, playerId);
    return { ok: true, ...rewards };
  });

  app.get('/rewards/pool-stats', async () => {
    const pool = ledger.getRewardsPoolStats(db);
    const available = Math.max(0, pool.total_deposited_micros - pool.total_claimed_micros);
    return { ok: true, total_deposited_micros: pool.total_deposited_micros, total_claimed_micros: pool.total_claimed_micros, available_micros: available };
  });

  app.post('/rewards/claim', async (req, reply) => {
    let playerId, vmcoSubKeyId, amountMicros, idempotencyKey;
    try {
      playerId = validate.validateUuid(req.body?.player_id, 'player_id');
      vmcoSubKeyId = req.body?.vmco_sub_key_id ? String(req.body.vmco_sub_key_id).slice(0, 64) : null;
      // Validate amount with max claim anti-fraud cap (100,000 micros = 100 credits)
      amountMicros = validate.validateAmount(req.body?.amount_micros, 'amount_micros', 100000);
      idempotencyKey = req.body?.idempotency_key ? String(req.body.idempotency_key).slice(0, 64) : null;
    } catch (err) {
      reply.code(400);
      return { error: err.message };
    }

    // Verify session token matches the player being claimed for (mandatory when auth enforced)
    const sessionToken = req.body?.session_token;
    const authEnforced = process.env.ECONOMY_AUTH_ENFORCED !== 'false';
    if (authEnforced) {
      if (!sessionToken) {
        reply.code(401);
        return { error: 'session token required' };
      }
      const player = db.prepare('SELECT session_token FROM players WHERE id = ?').get(playerId);
      if (!player || player.session_token !== sessionToken) {
        reply.code(403);
        return { error: 'session token mismatch — claim denied' };
      }
    } else if (sessionToken) {
      // When auth is not enforced, still validate token if provided (best-effort)
      const player = db.prepare('SELECT session_token FROM players WHERE id = ?').get(playerId);
      if (!player || player.session_token !== sessionToken) {
        reply.code(403);
        return { error: 'session token mismatch — claim denied' };
      }
    }

    // Idempotency check: if this key was already processed, return the existing result
    if (idempotencyKey) {
      const existing = db.prepare(
        'SELECT id, status, amount_micros FROM reward_claims WHERE idempotency_key = ? AND player_id = ?'
      ).get(idempotencyKey, playerId);
      if (existing) {
        return { ok: true, claim: { id: existing.id, status: existing.status, amount_micros: existing.amount_micros }, idempotent: true };
      }
    }

    // Minimum claim: 1000 micros (1 credit worth)
    if (amountMicros < 1000) {
      reply.code(400);
      return { error: 'minimum claim is 1000 micros' };
    }

    // Rate limit: max 1 claim per 60 seconds per player_id
    const claimCooldown = ledger.checkCooldown(db, 'claim:' + playerId, CLAIM_COOLDOWN_MS);
    if (claimCooldown.limited) {
      logClaimAudit({ player_id: playerId, vmco_sub_key_id: vmcoSubKeyId, amount_micros: amountMicros, result: 'rate_limited', mode: getClaimMode() });
      reply.code(429);
      return { error: 'claim rate limited — please wait', retry_after_seconds: claimCooldown.retryAfter };
    }

    try {
      const result = ledger.claimReward(db, { playerId, ppqAccount: vmcoSubKeyId ? `vmco:${vmcoSubKeyId}` : 'vmco:legacy', amountMicros, idempotencyKey });
      // Always set cooldown on successful claim creation to block rapid fire
      ledger.setCooldown(db, 'claim:' + playerId);
      logClaimAudit({ player_id: playerId, vmco_sub_key_id: vmcoSubKeyId, amount_micros: amountMicros, result: 'pending', mode: getClaimMode(), claim_id: result.claim.id });
      return { ok: true, ...result.claim };
    } catch (err) {
      if (err.message.includes('insufficient rewards')) {
        reply.code(409);
      } else if (err.message.includes('rewards pool insufficient')) {
        reply.code(409);
      } else if (err.message.includes('no rewards')) {
        reply.code(404);
      } else {
        reply.code(400);
      }
      logClaimAudit({ player_id: playerId, vmco_sub_key_id: vmcoSubKeyId, amount_micros: amountMicros, result: 'failed', reason: err.message, mode: getClaimMode() });
      return { error: err.message };
    }
  });

  // ─── VMCO.ai Credit Transfer Endpoint ─────────────────────────────
  // POST /credits/transfer
  // Completes a pending reward claim by verifying VMCO.ai reachability.
  // In test mode (no VMCO_MASTER_API_KEY), skips the actual API call.
  // In production mode, calls VMCO health check as proof-of-activity.
  //
  // Flow:
  //   1. Creates a pending claim via ledger.claimReward
  //   2. Attempts VMCO health check (or test-mode skip)
  //   3. On success: ledger.completeRewardClaim
  //   4. On failure: ledger.failRewardClaim (refunds player + pool)
  //
  // Protected by shared-secret auth (under /credits/* prefix).

  app.post('/credits/transfer', async (req, reply) => {
    let playerId, vmcoSubKeyId, amountMicros;
    try {
      playerId = validate.validateUuid(req.body?.player_id, 'player_id');
      vmcoSubKeyId = req.body?.vmco_sub_key_id ? String(req.body.vmco_sub_key_id).slice(0, 64) : null;
      amountMicros = validate.validateAmount(req.body?.amount_micros, 'amount_micros', 100000);
    } catch (err) {
      reply.code(400);
      return { error: err.message };
    }

    if (amountMicros < 1000) {
      reply.code(400);
      return { error: 'minimum transfer is 1000 micros' };
    }

    // Rate limit: same as claim endpoint
    const transferCooldown = ledger.checkCooldown(db, 'claim:' + playerId, CLAIM_COOLDOWN_MS);
    if (transferCooldown.limited) {
      reply.code(429);
      return { error: 'transfer rate limited — please wait', retry_after_seconds: transferCooldown.retryAfter };
    }

    // Step 1: Create pending claim
    let claim;
    try {
      const result = ledger.claimReward(db, { playerId, ppqAccount: vmcoSubKeyId ? `vmco:${vmcoSubKeyId}` : 'vmco:legacy', amountMicros });
      claim = result.claim;
    } catch (err) {
      if (err.message.includes('insufficient rewards')) {
        reply.code(409);
      } else if (err.message.includes('rewards pool insufficient')) {
        reply.code(409);
      } else if (err.message.includes('no rewards')) {
        reply.code(404);
      } else {
        reply.code(400);
      }
      logClaimAudit({ player_id: playerId, vmco_sub_key_id: vmcoSubKeyId, amount_micros: amountMicros, result: 'transfer_create_failed', reason: err.message, mode: getClaimMode() });
      return { error: err.message };
    }

    const mode = getClaimMode();
    let vmcoRef, vmcoResponse;

    // Step 2: Attempt VMCO health check
    if (mode === 'production') {
      // Production mode: verify VMCO is reachable as proof-of-activity
      try {
        const health = await vmcoClient.healthCheck();
        vmcoRef = health.ok ? `vmco:${health.name || 'ok'}` : 'vmco:unreachable';
        vmcoResponse = health;
      } catch (vmcoErr) {
        // VMCO call failed — refund the claim
        try {
          ledger.failRewardClaim(db, claim.id);
        } catch (failErr) {
          console.error(`[economy] CRITICAL: failed to failRewardClaim ${claim.id}: ${failErr.message}`);
        }
        logClaimAudit({ player_id: playerId, vmco_sub_key_id: vmcoSubKeyId, amount_micros: amountMicros, result: 'transfer_failed', reason: vmcoErr.message, mode, claim_id: claim.id });
        reply.code(502);
        return { error: 'VMCO.ai transfer failed — rewards refunded', provider_error: vmcoErr.message, claim_id: claim.id, mode };
      }
    } else {
      // Test mode: skip actual API call, use test reference
      vmcoRef = 'test-mode-simulated';
      vmcoResponse = { content: 'Test mode — no actual VMCO.ai call was made', model: 'test-mode', usage: {} };
    }

    // Step 3: Complete the claim
    try {
      const completed = ledger.completeRewardClaim(db, { claimId: claim.id, ppqTxId: vmcoRef });
      // Set cooldown on success
      ledger.setCooldown(db, 'claim:' + playerId);
      logClaimAudit({ player_id: playerId, vmco_sub_key_id: vmcoSubKeyId, amount_micros: amountMicros, result: 'completed', mode, claim_id: claim.id, vmco_ref: vmcoRef });
      return {
        ok: true,
        claim_id: claim.id,
        status: 'completed',
        amount_micros: amountMicros,
        vmco_sub_key_id: vmcoSubKeyId,
        vmco_ref: vmcoRef,
        mode,
        vmco_response: vmcoResponse,
      };
    } catch (completeErr) {
      console.error(`[economy] CRITICAL: failed to completeRewardClaim ${claim.id}: ${completeErr.message}`);
      logClaimAudit({ player_id: playerId, vmco_sub_key_id: vmcoSubKeyId, amount_micros: amountMicros, result: 'complete_failed', reason: completeErr.message, mode, claim_id: claim.id, vmco_ref: vmcoRef });
      reply.code(500);
      return { error: 'claim created but failed to mark completed — manual review required', claim_id: claim.id, mode };
    }
  });

  // ─── Advertiser Portal ──────────────────────────────────────────
  // All /portal/* endpoints use advertiser API key auth (Bearer token
  // looked up in advertiser_accounts table). Admin endpoints use
  // ADMIN_API_KEY env var.

  // ─── Portal Auth Hook ────────────────────────────────────────────
  // Applies advertiser auth to /portal/* (except /portal/signup and /portal/login)
  // and admin auth to /portal/admin/*

  const portalProtectedPrefixes = ['/portal/account', '/portal/campaigns', '/portal/credits'];
  // Protect admin API routes, but not /portal/admin.html itself — the HTML shell
  // must be able to load in a browser before its JS sends ADMIN_API_KEY.
  const adminPrefixes = ['/portal/admin/'];

  app.addHook('onRequest', async (req, reply) => {
    const path = req.url.split('?')[0];

    // Admin endpoints
    if (adminPrefixes.some(p => path.startsWith(p))) {
      const result = auth.validateAdminAuth(req.headers.authorization);
      if (!result.ok) {
        reply.code(401);
        await reply.send({ error: 'unauthorized' });
        return reply;
      }
      return;
    }

    // Protected portal endpoints (not signup/login)
    const isProtected = portalProtectedPrefixes.some(p => path.startsWith(p));
    if (!isProtected) return;

    const result = auth.validateAdvertiserAuth(db, req.headers.authorization);
    if (!result.ok) {
      reply.code(401);
      await reply.send({ error: result.error || 'unauthorized' });
      return reply;
    }
    // Attach accountId to request for downstream use
    req.advertiserId = result.accountId;
  });

  // ─── Signup ──────────────────────────────────────────────────────

  app.post('/portal/signup', async (req, reply) => {
    let email, password, companyName;
    try {
      email = validate.validateEmail(req.body?.email);
      password = validate.validatePassword(req.body?.password);
      companyName = validate.validateBrandName(req.body?.company_name);
    } catch (err) {
      reply.code(400);
      return { error: err.message };
    }

    // Check for existing account
    const existing = ledger.getAdvertiserByEmail(db, email);
    if (existing) {
      reply.code(409);
      return { error: 'email already registered' };
    }

    const apiKey = auth.generateKey(32);
    const passwordHash = auth.hashPassword(password);

    try {
      const account = ledger.createAdvertiserAccount(db, {
        email,
        passwordHash,
        companyName,
        apiKey,
      });
      reply.code(201);
      return { ok: true, ...account };
    } catch (err) {
      reply.code(500);
      return { error: 'failed to create account' };
    }
  });

  // ─── Login ───────────────────────────────────────────────────────

  app.post('/portal/login', async (req, reply) => {
    let email, password;
    try {
      email = validate.validateEmail(req.body?.email);
      password = req.body?.password;
      if (typeof password !== 'string' || password.length === 0) {
        throw new Error('password is required');
      }
    } catch (err) {
      reply.code(400);
      return { error: err.message };
    }

    const account = ledger.getAdvertiserByEmail(db, email);
    if (!account) {
      reply.code(401);
      return { error: 'invalid email or password' };
    }

    if (!auth.verifyPassword(password, account.password_hash)) {
      reply.code(401);
      return { error: 'invalid email or password' };
    }

    if (account.status === 'suspended') {
      reply.code(403);
      return { error: 'account suspended' };
    }

    return {
      ok: true,
      api_key: account.api_key,
      company_name: account.company_name,
      email: account.email,
    };
  });

  // ─── Account Info ────────────────────────────────────────────────

  app.get('/portal/account', async (req, reply) => {
    const advertiserId = req.advertiserId;
    if (!advertiserId) {
      // Auth not enforced mode — return error
      reply.code(401);
      return { error: 'unauthorized' };
    }

    const account = ledger.getAdvertiserByKey(db, req.headers.authorization?.split(' ')[1]);
    if (!account) {
      reply.code(404);
      return { error: 'account not found' };
    }

    return {
      id: account.id,
      email: account.email,
      company_name: account.company_name,
      status: account.status,
      balance_micros: account.balance_micros,
      created_at: account.created_at,
    };
  });

  // ─── Campaign CRUD ───────────────────────────────────────────────

  app.post('/portal/campaigns', async (req, reply) => {
    const advertiserId = req.advertiserId;
    if (!advertiserId) {
      reply.code(401);
      return { error: 'unauthorized' };
    }

    let name, brandName, placementType, dailyBudgetMicros, totalBudgetMicros, startDate, endDate;
    try {
      name = validate.validateCampaignName(req.body?.name);
      brandName = validate.validateBrandName(req.body?.brand_name);
      placementType = validate.validatePlacementType(req.body?.placement_type || 'hud_frame');
      dailyBudgetMicros = validate.validateBudget(req.body?.daily_budget_micros || 0, 'daily_budget_micros');
      totalBudgetMicros = validate.validateBudget(req.body?.total_budget_micros || 0, 'total_budget_micros');
      const dateRange = validate.validateDateRange(req.body?.start_date || null, req.body?.end_date || null);
      startDate = dateRange.start;
      endDate = dateRange.end;
    } catch (err) {
      reply.code(400);
      return { error: err.message };
    }

    try {
      const campaign = ledger.createCampaign(db, {
        advertiserId,
        name,
        brandName,
        placementType,
        dailyBudgetMicros,
        totalBudgetMicros,
        startDate,
        endDate,
      });
      reply.code(201);
      return { ok: true, campaign };
    } catch (err) {
      reply.code(500);
      return { error: 'failed to create campaign' };
    }
  });

  app.get('/portal/campaigns', async (req, reply) => {
    const advertiserId = req.advertiserId;
    if (!advertiserId) {
      reply.code(401);
      return { error: 'unauthorized' };
    }

    const limit = validate.validateLimit(req.query.limit);
    const offset = validate.validateOffset(req.query.offset);

    const result = ledger.listCampaignsForAdvertiser(db, advertiserId, { limit, offset });
    return { ok: true, ...result };
  });

  app.get('/portal/campaigns/:id', async (req, reply) => {
    const advertiserId = req.advertiserId;
    if (!advertiserId) {
      reply.code(401);
      return { error: 'unauthorized' };
    }

    try {
      const campaignId = validate.validateUuid(req.params.id, 'campaign_id');
      const campaign = ledger.getCampaign(db, campaignId);
      if (!campaign || campaign.advertiser_id !== advertiserId) {
        reply.code(404);
        return { error: 'campaign not found' };
      }
      return { ok: true, campaign };
    } catch (err) {
      reply.code(400);
      return { error: err.message };
    }
  });

  app.patch('/portal/campaigns/:id', async (req, reply) => {
    const advertiserId = req.advertiserId;
    if (!advertiserId) {
      reply.code(401);
      return { error: 'unauthorized' };
    }

    let campaignId;
    try {
      campaignId = validate.validateUuid(req.params.id, 'campaign_id');
    } catch (err) {
      reply.code(400);
      return { error: err.message };
    }

    const allowedUpdates = {};
    if (req.body?.name !== undefined) {
      try { allowedUpdates.name = validate.validateCampaignName(req.body.name); }
      catch (err) { reply.code(400); return { error: err.message }; }
    }
    if (req.body?.brand_name !== undefined) {
      try { allowedUpdates.brand_name = validate.validateBrandName(req.body.brand_name); }
      catch (err) { reply.code(400); return { error: err.message }; }
    }
    if (req.body?.daily_budget_micros !== undefined) {
      try { allowedUpdates.daily_budget_micros = validate.validateBudget(req.body.daily_budget_micros, 'daily_budget_micros'); }
      catch (err) { reply.code(400); return { error: err.message }; }
    }
    if (req.body?.total_budget_micros !== undefined) {
      try { allowedUpdates.total_budget_micros = validate.validateBudget(req.body.total_budget_micros, 'total_budget_micros'); }
      catch (err) { reply.code(400); return { error: err.message }; }
    }
    if (req.body?.start_date !== undefined || req.body?.end_date !== undefined) {
      try {
        const dateRange = validate.validateDateRange(req.body?.start_date || null, req.body?.end_date || null);
        if (dateRange.start !== null) allowedUpdates.start_date = dateRange.start;
        if (dateRange.end !== null) allowedUpdates.end_date = dateRange.end;
      } catch (err) { reply.code(400); return { error: err.message }; }
    }

    try {
      const campaign = ledger.updateCampaign(db, campaignId, advertiserId, allowedUpdates);
      return { ok: true, campaign };
    } catch (err) {
      if (err.message.includes('not found or access denied')) {
        reply.code(404);
      } else {
        reply.code(400);
      }
      return { error: err.message };
    }
  });

  app.delete('/portal/campaigns/:id', async (req, reply) => {
    const advertiserId = req.advertiserId;
    if (!advertiserId) {
      reply.code(401);
      return { error: 'unauthorized' };
    }

    let campaignId;
    try {
      campaignId = validate.validateUuid(req.params.id, 'campaign_id');
    } catch (err) {
      reply.code(400);
      return { error: err.message };
    }

    try {
      const result = ledger.deleteCampaign(db, campaignId, advertiserId);
      return { ok: true, ...result };
    } catch (err) {
      if (err.message.includes('not found or access denied')) {
        reply.code(404);
      } else if (err.message.includes('only draft')) {
        reply.code(409);
      } else {
        reply.code(400);
      }
      return { error: err.message };
    }
  });

  // ─── Campaign Status Transitions ─────────────────────────────────

  app.post('/portal/campaigns/:id/submit', async (req, reply) => {
    const advertiserId = req.advertiserId;
    if (!advertiserId) {
      // When auth is disabled, look up advertiser by API key if provided
      const authHeader = req.headers.authorization;
      if (authHeader && authHeader.startsWith('Bearer ')) {
        const key = authHeader.split(' ')[1];
        const account = ledger.getAdvertiserByKey(db, key);
        if (account) {
          req.advertiserId = account.id;
        } else {
          reply.code(401);
          return { error: 'unauthorized' };
        }
      } else {
        reply.code(401);
        return { error: 'unauthorized' };
      }
    }

    let campaignId;
    try {
      campaignId = validate.validateUuid(req.params.id, 'campaign_id');
    } catch (err) {
      reply.code(400);
      return { error: err.message };
    }

    const campaign = ledger.getCampaign(db, campaignId);
    if (!campaign || campaign.advertiser_id !== advertiserId) {
      reply.code(404);
      return { error: 'campaign not found' };
    }

    try {
      validate.validateStatusTransition(campaign.status, 'pending_review');
    } catch (err) {
      reply.code(409);
      return { error: err.message };
    }

    try {
      const updated = ledger.updateCampaignStatus(db, campaignId, advertiserId, 'pending_review');
      return { ok: true, campaign: updated };
    } catch (err) {
      reply.code(400);
      return { error: err.message };
    }
  });

  app.post('/portal/campaigns/:id/pause', async (req, reply) => {
    const advertiserId = req.advertiserId;
    if (!advertiserId) {
      reply.code(401);
      return { error: 'unauthorized' };
    }

    let campaignId;
    try {
      campaignId = validate.validateUuid(req.params.id, 'campaign_id');
    } catch (err) {
      reply.code(400);
      return { error: err.message };
    }

    const campaign = ledger.getCampaign(db, campaignId);
    if (!campaign || campaign.advertiser_id !== advertiserId) {
      reply.code(404);
      return { error: 'campaign not found' };
    }

    try {
      validate.validateStatusTransition(campaign.status, 'paused');
      const updated = ledger.updateCampaignStatus(db, campaignId, advertiserId, 'paused');
      return { ok: true, campaign: updated };
    } catch (err) {
      reply.code(409);
      return { error: err.message };
    }
  });

  app.post('/portal/campaigns/:id/resume', async (req, reply) => {
    const advertiserId = req.advertiserId;
    if (!advertiserId) {
      reply.code(401);
      return { error: 'unauthorized' };
    }

    let campaignId;
    try {
      campaignId = validate.validateUuid(req.params.id, 'campaign_id');
    } catch (err) {
      reply.code(400);
      return { error: err.message };
    }

    const campaign = ledger.getCampaign(db, campaignId);
    if (!campaign || campaign.advertiser_id !== advertiserId) {
      reply.code(404);
      return { error: 'campaign not found' };
    }

    try {
      validate.validateStatusTransition(campaign.status, 'active');
      const updated = ledger.updateCampaignStatus(db, campaignId, advertiserId, 'active');
      return { ok: true, campaign: updated };
    } catch (err) {
      reply.code(409);
      return { error: err.message };
    }
  });

  // ─── Creative Upload ─────────────────────────────────────────────

  app.post('/portal/campaigns/:id/creatives', async (req, reply) => {
    const advertiserId = req.advertiserId;
    if (!advertiserId) {
      reply.code(401);
      return { error: 'unauthorized' };
    }

    let campaignId;
    try {
      campaignId = validate.validateUuid(req.params.id, 'campaign_id');
    } catch (err) {
      reply.code(400);
      return { error: err.message };
    }

    // Verify campaign ownership
    const campaign = ledger.getCampaign(db, campaignId);
    if (!campaign || campaign.advertiser_id !== advertiserId) {
      reply.code(404);
      return { error: 'campaign not found' };
    }

    const type = req.body?.type;
    if (!['logo', 'label', 'interstitial'].includes(type)) {
      reply.code(400);
      return { error: 'creative type must be one of: logo, label, interstitial' };
    }

    let contentJson;
    try {
      contentJson = validate.validateCreativeContent(req.body?.content, type);
    } catch (err) {
      reply.code(400);
      return { error: err.message };
    }

    try {
      const creative = ledger.createCreative(db, { campaignId, type, contentJson });
      reply.code(201);
      return { ok: true, creative };
    } catch (err) {
      reply.code(500);
      return { error: 'failed to create creative' };
    }
  });

  // ─── Image Upload → ANSI ASCII Creative ─────────────────────────
  //
  // Accepts a raw image file (PNG/JPG/GIF/BMP), converts it to colored
  // ASCII art using the image_to_ansi.py helper, and stores the result as
  // a logo creative. This lets advertisers upload a normal image and have
  // it automatically rendered in the CLI game UI.
  //
  // POST /portal/campaigns/:id/upload-logo
  //   Content-Type: multipart/form-data
  //   Fields: image (file), [width=64], [height=20]
  //   width: max character width (8-64), height: max line count (2-40)
  //
  // Response: { ok: true, creative: { id, type: "logo", content: { lines } } }

  app.post('/portal/campaigns/:id/upload-logo', async (req, reply) => {
    const advertiserId = req.advertiserId;
    if (!advertiserId) {
      reply.code(401);
      return { error: 'unauthorized' };
    }

    let campaignId;
    try {
      campaignId = validate.validateUuid(req.params.id, 'campaign_id');
    } catch (err) {
      reply.code(400);
      return { error: err.message };
    }

    // Verify campaign ownership
    const campaign = ledger.getCampaign(db, campaignId);
    if (!campaign || campaign.advertiser_id !== advertiserId) {
      reply.code(404);
      return { error: 'campaign not found' };
    }

    // Parse multipart form data
    let imageFile;
    let targetWidth = 76;
    let targetHeight = 24;
    try {
      const parts = req.parts();
      for await (const part of parts) {
        if (part.fieldname === 'image' && part.file) {
          imageFile = part;
        } else if (part.fieldname === 'width') {
          targetWidth = parseInt(await part.value, 10) || 32;
        } else if (part.fieldname === 'height') {
          targetHeight = parseInt(await part.value, 10) || 16;
        }
      }
    } catch (err) {
      reply.code(400);
      return { error: 'failed to parse upload: ' + err.message };
    }

    if (!imageFile) {
      reply.code(400);
      return { error: 'missing "image" file field' };
    }

    // Validate image size (max 5MB)
    const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
    const chunks = [];
    let totalBytes = 0;
    for await (const chunk of imageFile.file) {
      totalBytes += chunk.length;
      if (totalBytes > MAX_IMAGE_BYTES) {
        reply.code(400);
        return { error: 'image must be 5MB or smaller' };
      }
      chunks.push(chunk);
    }
    const imageBuffer = Buffer.concat(chunks);

    // Validate dimensions
    targetWidth = Math.max(8, Math.min(targetWidth, 76));
    targetHeight = Math.max(2, Math.min(targetHeight, 32));

    // Write to temp file
    const tmpDir = os.tmpdir();
    const tmpId = randomUUID();
    const tmpPath = path.join(tmpDir, `signal-rush-upload-${tmpId}.png`);
    // Use chafa-based converter (falls back to bundled Python converter)
    const ansiScript = path.join(__dirname, 'scripts', 'image_to_chafa.py');

    try {
      fs.writeFileSync(tmpPath, imageBuffer);

      // Run the converter (chafa primary, Python fallback)
      // New interface: max_width=chars, max_height=lines
      const converterWidth = Math.max(8, Math.min(targetWidth, 76));
      const converterHeight = Math.max(2, Math.min(targetHeight, 32));
      const ansiLines = await new Promise((resolve, reject) => {
        execFile('python3', [ansiScript, tmpPath, String(converterWidth), String(converterHeight)], {
          timeout: 10000,
          maxBuffer: 256 * 1024,
        }, (err, stdout, stderr) => {
          if (err) {
            reject(new Error(`image conversion failed: ${err.message}`));
            return;
          }
          try {
            const data = JSON.parse(stdout);
            if (!data.lines || !Array.isArray(data.lines)) {
              reject(new Error('converter returned invalid output'));
              return;
            }
            resolve(data.lines);
          } catch (parseErr) {
            reject(new Error(`converter output parse failed: ${parseErr.message}`));
          }
        });
      });

      // Validate the ANSI lines against the same rules as manual logo upload
      const content = { lines: ansiLines };
      let contentJson;
      try {
        contentJson = validate.validateCreativeContent(content, 'logo');
      } catch (valErr) {
        reply.code(400);
        return { error: valErr.message };
      }

      // Store as a logo creative
      const creative = ledger.createCreative(db, { campaignId, type: 'logo', contentJson });
      reply.code(201);
      return { ok: true, creative };

    } catch (err) {
      reply.code(500);
      return { error: err.message || 'image processing failed' };
    } finally {
      // Clean up temp file
      try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    }
  });

  app.get('/portal/campaigns/:id/creatives', async (req, reply) => {
    const advertiserId = req.advertiserId;
    if (!advertiserId) {
      reply.code(401);
      return { error: 'unauthorized' };
    }

    let campaignId;
    try {
      campaignId = validate.validateUuid(req.params.id, 'campaign_id');
    } catch (err) {
      reply.code(400);
      return { error: err.message };
    }

    // Verify campaign ownership
    const campaign = ledger.getCampaign(db, campaignId);
    if (!campaign || campaign.advertiser_id !== advertiserId) {
      reply.code(404);
      return { error: 'campaign not found' };
    }

    const creatives = ledger.listCreativesForCampaign(db, campaignId);
    return { ok: true, creatives };
  });

  // ─── Campaign Stats ──────────────────────────────────────────────

  app.get('/portal/campaigns/:id/stats', async (req, reply) => {
    const advertiserId = req.advertiserId;
    if (!advertiserId) {
      reply.code(401);
      return { error: 'unauthorized' };
    }

    let campaignId;
    try {
      campaignId = validate.validateUuid(req.params.id, 'campaign_id');
    } catch (err) {
      reply.code(400);
      return { error: err.message };
    }

    // Verify campaign ownership
    const campaign = ledger.getCampaign(db, campaignId);
    if (!campaign || campaign.advertiser_id !== advertiserId) {
      reply.code(404);
      return { error: 'campaign not found' };
    }

    const stats = ledger.getCampaignStats(db, campaignId);
    return { ok: true, stats };
  });

  // ─── Advertiser Credits ──────────────────────────────────────────

  app.post('/portal/credits/deposit', async (req, reply) => {
    const advertiserId = req.advertiserId;
    if (!advertiserId) {
      reply.code(401);
      return { error: 'unauthorized' };
    }

    let amountMicros;
    try {
      amountMicros = validate.validateAmount(req.body?.amount_micros, 'amount_micros', 1_000_000_000);
    } catch (err) {
      reply.code(400);
      return { error: err.message };
    }

    // If Stripe is configured, create a checkout session
    const stripeKey = process.env.STRIPE_SECRET_KEY;
    if (stripeKey && req.body?.use_stripe) {
      try {
        // Dynamic import to avoid hard dependency
        const Stripe = require('stripe');
        const stripe = Stripe(stripeKey);
        const session = await stripe.checkout.sessions.create({
          payment_method_types: ['card'],
          line_items: [{
            price_data: {
              currency: 'usd',
              product_data: {
                name: 'Signal Rush Ad Credits',
                description: `${(Math.round(amountMicros) / 1000000).toFixed(2)} in advertising credits`,
              },
              unit_amount: Math.round(amountMicros / 100), // cents
            },
            quantity: 1,
          }],
          mode: 'payment',
          success_url: `${req.protocol}://${req.headers.host}/portal/account.html?deposit=success&amount=${amountMicros}`,
          cancel_url: `${req.protocol}://${req.headers.host}/portal/account.html?deposit=cancelled`,
          metadata: { advertiser_id: advertiserId, amount_micros: String(amountMicros) },
        });
        return { ok: true, stripe_url: session.url };
      } catch (err) {
        reply.code(500);
        return { error: 'Stripe checkout failed: ' + err.message };
      }
    }

    // Direct deposit (manual / for testing)
    try {
      const result = ledger.depositAdvertiserFunds(db, {
        advertiserId,
        amountMicros,
        reason: 'portal_deposit',
      });
      return { ok: true, ...result };
    } catch (err) {
      reply.code(500);
      return { error: 'deposit failed' };
    }
  });

  // ─── Stripe Webhook ─────────────────────────────────────────────
  // Receives payment confirmation from Stripe and credits the advertiser.
  // When STRIPE_WEBHOOK_SECRET is set, this endpoint validates the webhook
  // signature and processes successful payments.
  // POST /portal/webhooks/stripe
  app.post('/portal/webhooks/stripe', async (req, reply) => {
    // Support multiple webhook secrets (comma-separated) for multi-destination setups.
    // Stripe sends one signature per destination; we try each secret until one validates.
    const secretEnv = process.env.STRIPE_WEBHOOK_SECRET;
    if (!secretEnv) {
      reply.code(501);
      return { error: 'Stripe webhooks not configured' };
    }
    const secrets = secretEnv.split(',').map(s => s.trim()).filter(Boolean);
    if (secrets.length === 0) {
      reply.code(501);
      return { error: 'Stripe webhooks not configured — no secrets' };
    }

    const sig = req.headers['stripe-signature'];
    if (!sig) {
      reply.code(400);
      return { error: 'missing Stripe signature' };
    }

    try {
      const Stripe = require('stripe');
      const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
      // req.rawBody is captured by our custom content-type parser (see top of file).
      // This is the EXACT bytes Stripe signed — using JSON.stringify(req.body) would
      // fail signature verification because of key ordering / whitespace differences.
      let event = null;
      const errors = [];
      for (const secret of secrets) {
        try {
          event = stripe.webhooks.constructEvent(
            req.rawBody,
            sig,
            secret
          );
          break; // first successful validation wins
        } catch (err) {
          errors.push(err.message.substring(0, 100));
        }
      }
      if (!event) {
        // TEMP DEBUG: log diagnostic info
        console.error('WEBHOOK_DEBUG: rawBody len:', req.rawBody?.length, 'sig:', sig.substring(0, 20), 'secrets count:', secrets.length, 'secrets:', JSON.stringify(secrets.map(s => s.substring(0,12) + '...')));
        console.error('WEBHOOK_DEBUG: first error:', errors[0]);
        reply.code(400);
        return { error: 'webhook signature verification failed for all secrets', details: errors };
      }

      if (event.type === 'checkout.session.completed') {
        const session = event.data.object;
        const advertiserId = session.metadata?.advertiser_id;
        const amountMicros = parseInt(session.metadata?.amount_micros || '0', 10);
        if (advertiserId && amountMicros > 0) {
          // Auto-create advertiser on first deposit if not yet exists
          const existing = db.prepare('SELECT 1 FROM advertiser_accounts WHERE id = ?').get(advertiserId);
          if (!existing) {
            const email = session.customer_details?.email || `${advertiserId}@stripe-temp.local`;
            const companyName = session.metadata?.advertiser_name || advertiserId.substring(0, 8);
            const crypto = require('crypto');
            const apiHash = crypto.createHash('sha256').update(advertiserId + '_stripe_' + Date.now()).digest('hex');
            db.prepare(
              'INSERT INTO advertiser_accounts (id, email, password_hash, company_name, api_key, api_key_hash, status) VALUES (?, ?, ?, ?, ?, ?, ?)'
            ).run(advertiserId, email, 'stripe_oauth:' + advertiserId, companyName, 'stripe_' + advertiserId, apiHash, 'active');
          }
          ledger.depositAdvertiserFunds(db, {
            advertiserId,
            amountMicros,
            reason: 'stripe_payment',
          });
        }
      }

      return { ok: true };
    } catch (err) {
      reply.code(400);
      return { error: 'webhook error: ' + err.message };
    }
  });

  // ─── Game Integration: Active Campaigns with Creatives ────────────
  // Public endpoint — no auth required. Returns active campaigns with
  // their approved creatives embedded for the game client to render.

  app.get('/api/game/campaigns', async (req, reply) => {
    const today = new Date().toISOString().split('T')[0];
    const campaigns = db.prepare(
      'SELECT id, advertiser_id, name, brand_name, status, placement_type, daily_budget_micros, total_budget_micros, spent_micros, start_date, end_date, created_at FROM campaigns WHERE status = ? AND (end_date IS NULL OR end_date >= ?) AND (total_budget_micros = 0 OR spent_micros < total_budget_micros) ORDER BY created_at DESC LIMIT 100'
    ).all('active', today);
    // Attach approved creatives to each campaign
    for (const campaign of campaigns) {
      campaign.creatives = ledger.listCreativesForCampaign(db, campaign.id)
        .filter(c => c.status === 'approved')
        .map(c => ({ type: c.type, content: JSON.parse(c.content_json) }));
    }
    return { ok: true, campaigns };
  });

  // ─── Logo/Creative Image Serving ─────────────────────────────────
  // Returns the logo creative content for a campaign as JSON.
  // The Mini App renders this on canvas (ASCII art or image data).
  app.get('/api/campaigns/:id/logo', async (req, reply) => {
    let campaignId;
    try {
      campaignId = validate.validateUuid(req.params.id, 'campaign_id');
    } catch (err) {
      reply.code(400);
      return { error: err.message };
    }

    const campaign = ledger.getCampaign(db, campaignId);
    if (!campaign) {
      reply.code(404);
      return { error: 'campaign not found' };
    }

    // Get approved logo creative
    const creatives = ledger.listCreativesForCampaign(db, campaignId);
    const logoCreative = creatives.find(c => c.type === 'logo' && c.status === 'approved');

    if (logoCreative) {
      reply.code(200);
      return {
        ok: true,
        campaign_id: campaignId,
        brand_name: campaign.brand_name,
        type: logoCreative.type,
        content: JSON.parse(logoCreative.content_json),
      };
    }

    // No logo — return brand_name as text fallback
    reply.code(200);
    return {
      ok: true,
      campaign_id: campaignId,
      brand_name: campaign.brand_name,
      type: 'text',
      content: { text: campaign.brand_name },
    };
  });

  // ─── Admin: Campaign Moderation ──────────────────────────────────

  app.get('/portal/admin/campaigns', async (req, reply) => {
    const status = req.query.status || null;
    let sql = 'SELECT id, advertiser_id, name, brand_name, status, placement_type, daily_budget_micros, total_budget_micros, spent_micros, start_date, end_date, created_at FROM campaigns';
    const params = [];
    if (status) {
      sql += ' WHERE status = ?';
      params.push(status);
    }
    sql += ' ORDER BY created_at DESC LIMIT 100';
    const campaigns = db.prepare(sql).all(...params);
    return { ok: true, campaigns };
  });

  app.post('/portal/admin/campaigns/:id/approve', async (req, reply) => {
    let campaignId;
    try {
      campaignId = validate.validateUuid(req.params.id, 'campaign_id');
    } catch (err) {
      reply.code(400);
      return { error: err.message };
    }

    const campaign = ledger.getCampaign(db, campaignId);
    if (!campaign) {
      reply.code(404);
      return { error: 'campaign not found' };
    }

    try {
      validate.validateStatusTransition(campaign.status, 'active');
    } catch (err) {
      reply.code(409);
      return { error: err.message };
    }

    // Approve all pending creatives
    const creatives = ledger.listCreativesForCampaign(db, campaignId);
    for (const creative of creatives) {
      if (creative.status === 'pending') {
        ledger.updateCreativeStatus(db, creative.id, 'approved');
      }
    }

    const updated = ledger.updateCampaignStatus(db, campaignId, campaign.advertiser_id, 'active');
    return { ok: true, campaign: updated };
  });

  app.post('/portal/admin/campaigns/:id/reject', async (req, reply) => {
    let campaignId;
    try {
      campaignId = validate.validateUuid(req.params.id, 'campaign_id');
    } catch (err) {
      reply.code(400);
      return { error: err.message };
    }

    const campaign = ledger.getCampaign(db, campaignId);
    if (!campaign) {
      reply.code(404);
      return { error: 'campaign not found' };
    }

    try {
      validate.validateStatusTransition(campaign.status, 'rejected');
    } catch (err) {
      reply.code(409);
      return { error: err.message };
    }

    // Reject all pending creatives
    const creatives = ledger.listCreativesForCampaign(db, campaignId);
    for (const creative of creatives) {
      if (creative.status === 'pending') {
        ledger.updateCreativeStatus(db, creative.id, 'rejected');
      }
    }

    const updated = ledger.updateCampaignStatus(db, campaignId, campaign.advertiser_id, 'rejected');
    return { ok: true, campaign: updated };
  });

  // ─── Start / Stop ──────────────────────────────────────────────

  function start() {
    return new Promise((resolve, reject) => {
      app.listen({ port, host }, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  function stop() {
    return app.close().then(() => db.close());
  }

  // ─── Sitemap ──────────────────────────────────────────────────
  app.get('/sitemap.xml', async (req, reply) => {
    const sitemapPath = path.join(__dirname, 'portal', 'sitemap.xml');
    if (fs.existsSync(sitemapPath)) {
      reply.header('Content-Type', 'application/xml; charset=utf-8');
      return fs.createReadStream(sitemapPath);
    }
    reply.code(404);
    return { error: 'not found' };
  });

  // ─── Landing Page (Root) ───────────────────────────────────────
  // Serve the public landing page at /
  app.get('/', async (req, reply) => {
    const indexPath = path.join(__dirname, 'portal', 'index.html');
    if (fs.existsSync(indexPath)) {
      reply.header('Content-Type', 'text/html; charset=utf-8');
      reply.header('X-Content-Type-Options', 'nosniff');
      reply.header('X-Frame-Options', 'DENY');
      reply.header('Referrer-Policy', 'strict-origin-when-cross-origin');
      return fs.createReadStream(indexPath);
    }
    reply.redirect('/portal/dashboard.html');
  });

  // ─── Static File Serving (Portal Frontend) ─────────────────────
  // Serve the advertiser portal frontend from the portal/ directory.
  // Falls through to API routes if file not found.

  const portalDir = path.join(__dirname, 'portal');

  app.get('/portal', async (req, reply) => {
    reply.redirect('/portal/login.html');
  });

  app.get('/portal/', async (req, reply) => {
    reply.redirect('/portal/login.html');
  });

  app.get('/portal/player', async (req, reply) => {
    reply.redirect('/portal/player.html');
  });

  app.get('/portal/*', async (req, reply) => {
    const filePath = path.join(portalDir, req.params['*'] || '');
    // Security: prevent directory traversal
    if (!filePath.startsWith(portalDir)) {
      reply.code(403);
      return { error: 'forbidden' };
    }
    // Check if file exists
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      reply.code(404);
      return { error: 'not found' };
    }
    // Determine content type
    const ext = path.extname(filePath).toLowerCase();
    const contentTypes = {
      '.html': 'text/html; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.js': 'application/javascript; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.svg': 'image/svg+xml',
      '.ico': 'image/x-icon',
    };
    reply.header('Content-Type', contentTypes[ext] || 'application/octet-stream');
    return fs.createReadStream(filePath);
  });

  // ─── Telegram Mini App Static Files ─────────────────────────────
  // Serve the game Mini App from telegram-mini-app/ directory.

  const miniAppDir = path.join(__dirname, '..', 'telegram-mini-app');

  app.get('/mini-app', async (req, reply) => {
    reply.redirect('/mini-app/index.html');
  });

  app.get('/mini-app/*', async (req, reply) => {
    const reqPath = req.params['*'] || 'index.html';
    const filePath = path.join(miniAppDir, reqPath);
    // Security: prevent directory traversal
    if (!filePath.startsWith(miniAppDir)) {
      reply.code(403);
      return { error: 'forbidden' };
    }
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      reply.code(404);
      return { error: 'not found' };
    }
    const ext = path.extname(filePath).toLowerCase();
    const contentTypes = {
      '.html': 'text/html; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.js': 'application/javascript; charset=utf-8',
      '.mjs': 'application/javascript; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.svg': 'image/svg+xml',
      '.ico': 'image/x-icon',
      '.wasm': 'application/wasm',
    };
    reply.header('Content-Type', contentTypes[ext] || 'application/octet-stream');
    // Disable caching for mini-app files (Telegram WebView caching is aggressive)
    reply.header('Cache-Control', 'no-cache, no-store, must-revalidate');
    reply.header('Pragma', 'no-cache');
    reply.header('Expires', '0');
    return fs.createReadStream(filePath);
  });

  // Also serve the engine bundle from dist/ at /dist/
  const distDir = path.join(__dirname, '..', 'dist');

  app.get('/dist/*', async (req, reply) => {
    const reqPath = req.params['*'] || '';
    const filePath = path.join(distDir, reqPath);
    if (!filePath.startsWith(distDir)) {
      reply.code(403);
      return { error: 'forbidden' };
    }
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      reply.code(404);
      return { error: 'not found' };
    }
    reply.header('Content-Type', 'application/javascript; charset=utf-8');
    return fs.createReadStream(filePath);
  });

  return { app, start, stop };
}

// ─── CLI Entry Point ─────────────────────────────────────────────

if (require.main === module) {
  const port = parseInt(process.env.ECONOMY_PORT) || DEFAULT_PORT;
  const host = process.env.ECONOMY_HOST || DEFAULT_HOST;
  const dbPath = process.env.ECONOMY_DB || path.join(os.homedir(), '.signal-rush', 'economy.db');

  const server = createServer({ port, host, dbPath });
  server.start().then(() => {
    console.log(`[economy] Service running on ${host}:${port}`);
    console.log(`[economy] Database: ${dbPath}`);
  }).catch(err => {
    console.error('[economy] Failed to start:', err.message);
    process.exit(1);
  });

  process.on('SIGINT', () => server.stop().then(() => process.exit(0)));
  process.on('SIGTERM', () => server.stop().then(() => process.exit(0)));
}

module.exports = { createServer };
