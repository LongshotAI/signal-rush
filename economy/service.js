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


const DEFAULT_PORT = 8720;
const DEFAULT_HOST = '127.0.0.1'; // localhost only — no external exposure

function createServer({ port = DEFAULT_PORT, host = DEFAULT_HOST, dbPath = ledger.DEFAULT_DB_PATH } = {}) {
  const app = Fastify({ logger: false }); // quiet logging for MVP
  const db = ledger.openDb(dbPath);

  // ─── Auth Enforcement Hook ──────────────────────────────────────
  // Protects all /internal/*, /credits/*, and /ads/* endpoints.
  // When ECONOMY_AUTH_ENFORCED='true', requests must include
  // Authorization: Bearer <ECONOMY_API_KEY>.

  const protectedPrefixes = ['/internal/', '/credits/', '/ads/'];

  app.addHook('onRequest', async (req, reply) => {
    const path = req.url.split('?')[0];
    const isProtected = protectedPrefixes.some(p => path.startsWith(p));
    if (!isProtected) return; // public endpoints (health, players, tracking) pass through

    const result = auth.validateAuth(req.headers.authorization);
    if (!result.ok) {
      reply.code(401);
      return { error: 'unauthorized' };
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

    // Anti-fraud: per-session credit limit
    const maxPerSession = parseInt(process.env.MAX_CREDITS_PER_SESSION) || 10000;
    if (rawDelta > 0 && validatedPlayerId) {
      const sessionEarned = db.prepare(
        'SELECT COALESCE(credits_earned, 0) as total FROM sessions WHERE id = ?'
      ).get(session_id.trim());
      const currentEarned = sessionEarned?.total || 0;
      if (currentEarned + rawDelta > maxPerSession) {
        reply.code(400);
        return { error: `session credit limit exceeded (max ${maxPerSession} per session)` };
      }
    }

    try {
      const result = ledger.ingestEvent(db, {
        playerId: validatedPlayerId,
        sessionId: session_id.trim(),
        creditsDelta: rawDelta,
        isReset: Boolean(is_reset),
        events: Array.isArray(events) ? events : [],
        timestamp: timestamp || new Date().toISOString(),
      });
      return { ok: true, ...result };
    } catch (err) {
      reply.code(500);
      return { error: 'ingest failed' };
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
    try {
      const result = ledger.awardCredits(db, {
        playerId,
        amount,
        reason,
        eventId: req.body?.idempotency_key || null,
      });
      return result;
    } catch (err) {
      reply.code(400);
      return { error: err.message };
    }
  });

  app.post('/credits/spend', async (req, reply) => {
    let playerId, amount, reason;
    try {
      playerId = validate.validateUuid(req.body?.player_id, 'player_id');
      amount = validate.validateAmount(req.body?.amount, 'amount');
      reason = validate.validateReason(req.body?.reason);
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

  app.post('/ads/impression', async (req, reply) => {
    const { campaign_id, player_id, placement_type = 'hud_frame', cost_micros = 0 } = req.body || {};
    let validatedPlayerId = null;
    if (player_id) {
      try {
        validatedPlayerId = validate.validateUuid(player_id, 'player_id');
      } catch (err) {
        reply.code(400);
        return { error: err.message };
      }
    }
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
        return { error: 'unauthorized' };
      }
      return;
    }

    // Protected portal endpoints (not signup/login)
    const isProtected = portalProtectedPrefixes.some(p => path.startsWith(p));
    if (!isProtected) return;

    const result = auth.validateAdvertiserAuth(db, req.headers.authorization);
    if (!result.ok) {
      reply.code(401);
      return { error: result.error || 'unauthorized' };
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
