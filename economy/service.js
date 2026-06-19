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
const ppqClient = require('./ppq-client');
const telegramRoutes = require('./routes/telegram');
const { execFile } = require('child_process');


const DEFAULT_PORT = 8720;
const DEFAULT_HOST = '127.0.0.1'; // localhost only — no external exposure

function createServer({ port = DEFAULT_PORT, host = DEFAULT_HOST, dbPath = ledger.DEFAULT_DB_PATH } = {}) {
  const app = Fastify({ logger: false }); // quiet logging for MVP
  const db = ledger.openDb(dbPath);

  // ─── In-Memory Service State ────────────────────────────────────
  const serviceState = {
    adminAwardDaily: new Map(), // date (YYYY-MM-DD) → total credits awarded
  };
  // Required for image upload endpoint (POST /portal/campaigns/:id/upload-logo)
  app.register(require('@fastify/multipart'), {
    limits: {
      fileSize: 5 * 1024 * 1024, // 5MB max
      files: 1,
    },
  });

  // ─── Auth Enforcement Hook ──────────────────────────────────────
  // Protects all /internal/*, /credits/*, and /ads/* endpoints.
  // When ECONOMY_AUTH_ENFORCED is set to anything other than 'false',
  // requests must include Authorization: Bearer <ECONO...EY>.
  // To disable auth: set ECONOMY_AUTH_ENFORCED=false.

  const protectedPrefixes = ['/internal/', '/credits/', '/ads/'];

  app.addHook('onRequest', async (req, reply) => {
    const path = req.url.split('?')[0];
    const isProtected = protectedPrefixes.some(p => path.startsWith(p));
    if (!isProtected) return; // public endpoints (health, players, tracking) pass through

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

  // ─── Health Check ──────────────────────────────────────────────

  app.get('/health', async () => {
    return { status: 'ok', service: 'economy', timestamp: new Date().toISOString() };
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
    const dailyAwarded = serviceState.adminAwardDaily.get(today) || 0;
    if (dailyAwarded + amount > maxPerDay) {
      reply.code(429);
      return { error: 'daily admin award limit exceeded' };
    }
    try {
      const result = ledger.awardCredits(db, {
        playerId,
        amount,
        reason,
        eventId: req.body?.idempotency_key || null,
      });
      // Track daily admin award total
      const current = serviceState.adminAwardDaily.get(today) || 0;
      serviceState.adminAwardDaily.set(today, current + amount);
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
  // Flow: validate → deduct credits → call ppq.ai → complete or refund.
  // All endpoints under /credits/ are protected by shared-secret auth.

  app.post('/credits/redeem', async (req, reply) => {
    let playerId, credits, model, prompt, provider;
    try {
      playerId = validate.validateUuid(req.body?.player_id, 'player_id');
      credits = validate.validateAmount(req.body?.credits, 'credits', 100000);
      model = validate.validateModelName(req.body?.model || process.env.PPQ_DEFAULT_MODEL || 'gpt-4o-mini');
      prompt = validate.validatePrompt(req.body?.prompt);
      provider = validate.validateProvider(req.body?.provider || 'ppq');
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

    // Step 2: Call ppq.ai
    try {
      const ppqResult = await ppqClient.chatCompletion({
        model,
        messages: [{ role: 'user', content: prompt }],
        idempotencyKey,
      });

      // Step 3: Mark redemption completed
      const completed = redeem.completeRedemption(db, {
        redemptionId: redemption.id,
        providerRef: ppqResult.model,
        providerResponse: JSON.stringify(ppqResult),
      });

      // Fetch fresh balance after deduction
      const updatedPlayer = ledger.getPlayer(db, playerId);

      return {
        ok: true,
        redemption_id: completed.id,
        status: 'completed',
        content: ppqResult.content,
        model: ppqResult.model,
        usage: ppqResult.usage,
        credits_spent: credits,
        balance_remaining: updatedPlayer ? updatedPlayer.balance : null,
      };
    } catch (ppqErr) {
      // Step 3b: Provider call failed → mark failed, then refund
      try {
        redeem.failRedemption(db, {
          redemptionId: redemption.id,
          reason: `ppq_error: ${ppqErr.message}`,
        });
      } catch (failErr) {
        // If fail marking fails, still attempt refund
      }

      try {
        redeem.refundRedemption(db, {
          redemptionId: redemption.id,
          reason: `ppq_error: ${ppqErr.message}`,
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
        provider_error: ppqErr.message,
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

  // In-memory rate limiter: player_id → last impression timestamp (ms)
  const impressionCooldowns = new Map();
  const IMPRESSION_COOLDOWN_MS = 5000; // 1 impression per 5 seconds per player

  // Server-side cost lookup: campaign_id → cost in micros
  // For house ads (no campaign), cost is 0.
  // For campaign ads, use AD_COST_MICROS_PER_IMPRESSION env var (default 0).
  function resolveImpressionCost(campaignId) {
    if (!campaignId) return 0;
    const configured = parseInt(process.env.AD_COST_MICROS_PER_IMPRESSION || '0', 10);
    if (!Number.isFinite(configured) || configured < 0) return 0;
    return configured;
  }

  app.post('/ads/impression', async (req, reply) => {
    const { campaign_id, player_id, placement_type = 'hud_frame' } = req.body || {};
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
      const now = Date.now();
      const last = impressionCooldowns.get(validatedPlayerId);
      if (last && (now - last) < IMPRESSION_COOLDOWN_MS) {
        reply.code(429);
        return { error: 'rate_limited', retry_after_ms: IMPRESSION_COOLDOWN_MS - (now - last) };
      }
      impressionCooldowns.set(validatedPlayerId, now);
    }
    // Session validation: player must have an active session
    if (validatedPlayerId) {
      const activeSession = db.prepare(
        'SELECT 1 FROM sessions WHERE player_id = ? AND ended_at IS NULL'
      ).get(validatedPlayerId);
      if (!activeSession) {
        reply.code(400);
        return { error: 'no active session' };
      }
    }
    // Determine cost server-side — never trust client input
    const cost_micros = resolveImpressionCost(campaign_id);
    try {
      const id = ledger.logImpression(db, {
        campaignId: campaign_id || null,
        playerId: validatedPlayerId,
        placementType: validate.validatePlacementType(placement_type),
        costMicros: validate.validateNonNegativeInt(cost_micros, 'cost_micros'),
      });
      return { ok: true, impression_id: id };
    } catch (err) {
      reply.code(400);
      return { error: err.message };
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
  const adminPrefixes = ['/portal/admin'];

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

  // ─── Game Integration: Active Campaigns with Creatives ────────────
  // Public endpoint — no auth required. Returns active campaigns with
  // their approved creatives embedded for the game client to render.

  app.get('/api/game/campaigns', async (req, reply) => {
    const campaigns = db.prepare(
      'SELECT id, advertiser_id, name, brand_name, status, placement_type, daily_budget_micros, total_budget_micros, spent_micros, start_date, end_date, created_at FROM campaigns WHERE status = ? ORDER BY created_at DESC LIMIT 10'
    ).all('active');
    // Attach approved creatives to each campaign
    for (const campaign of campaigns) {
      campaign.creatives = ledger.listCreativesForCampaign(db, campaign.id)
        .filter(c => c.status === 'approved')
        .map(c => ({ type: c.type, content: JSON.parse(c.content_json) }));
    }
    return { ok: true, campaigns };
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

  // ─── Static File Serving (Portal Frontend) ─────────────────────
  // Serve the advertiser portal frontend from the portal/ directory.
  // Falls through to API routes if file not found.

  const portalDir = path.join(__dirname, 'portal');

  app.get('/portal', async (req, reply) => {
    reply.redirect('/portal/dashboard.html');
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
