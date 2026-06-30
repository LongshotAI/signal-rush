// economy/routes/vmco.js
// Signal Rush — VMCO Sub-key Provisioning Routes
//
// Flow:
//   POST /vmco/claim                 — player creates or tops up their VMCO sub-key
//   GET  /vmco/sub-key/:player_id    — player fetches their existing sub-key
//   DELETE /vmco/sub-key/:player_id  — player revokes their sub-key
//   GET  /vmco/account               — admin: master account balance
//   GET  /vmco/health                — admin: verify VMCO reachable
//
// The sub-key is a portable Bearer token the player can paste into their
// own agent/harness. All usage bills the master Signal Rush account.

const crypto = require('crypto');
const vmcoClient = require('../vmco-client');
const ledger = require('../ledger');

// VMCO pricing: 100 credits = $1.00 → 1 credit = $0.01
// Signal Rush micros: 1,000,000 micros = $1.00 → 1 micro = $0.000001
// Conversion: $0.01 / $0.000001 = 10,000 micros per VMCO credit
const MICROS_PER_CREDIT = 10_000;     // 10,000 micros earned → 1 VMCO credit ($0.01)
const CLAIM_COOLDOWN_MS = 60_000;     // 1 claim per minute per player
const MAX_BUDGET_PER_CLAIM = 1_000_000; // 1M micros earned → 100 credits = $1.00 per claim
const MIN_CLAIM_MICROS = 10_000;     // Need at least 10,000 micros to claim (≥1 credit)
const MASTER_BALANCE_FLOOR = 50;     // Refuse claims if master balance < 50 credits ($0.50)

function logAudit(db, entry) {
  try {
    db.prepare(`
      INSERT INTO claim_audit (player_id, provider, amount_micros, result, reason, claim_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
    `).run(
      entry.player_id || null,
      entry.provider || 'vmco',
      entry.amount_micros || 0,
      entry.result || 'unknown',
      entry.reason || null,
      entry.claim_id || null
    );
  } catch (e) {
    // claim_audit table may not exist; never let audit failure break the flow
  }
}

function getPlayerRewards(db, playerId) {
  return db.prepare(
    `SELECT earned_micros, claimed_micros FROM player_rewards WHERE player_id = ?`
  ).get(playerId);
}

function decPlayerRewards(db, playerId, micros) {
  // Use existing ledger pattern: increment claimed_micros by the amount being redeemed
  db.prepare(
    `UPDATE player_rewards
        SET claimed_micros = claimed_micros + ?, updated_at = datetime('now')
      WHERE player_id = ?`
  ).run(micros, playerId);
}

function incRewardsPoolClaimed(db, micros) {
  db.prepare(
    `UPDATE rewards_pool
        SET total_claimed_micros = total_claimed_micros + ?, updated_at = datetime('now')
      WHERE id = 1`
  ).run(micros);
}

function recordVmcoClaim(db, { playerId, subKeyId, amountMicros, idempotencyKey }) {
  // Record the claim in reward_claims so the audit trail is consistent.
  // Include an explicit UUID; TEXT PRIMARY KEY does not auto-generate one.
  db.prepare(`
    INSERT INTO reward_claims
      (id, player_id, amount_micros, status, ppq_account, idempotency_key, claimed_at, completed_at)
    VALUES (?, ?, ?, 'completed', ?, ?, datetime('now'), datetime('now'))
  `).run(crypto.randomUUID(), playerId, amountMicros, `vmco:${subKeyId}`, idempotencyKey || null);
}

function getPlayer(db, playerId) {
  return db.prepare(
    `SELECT id, display_name, telegram_id, vmco_sub_key, vmco_sub_key_id,
            vmco_sub_key_created_at, vmco_sub_key_budget_credits
       FROM players WHERE id = ?`
  ).get(playerId);
}

function register(app, { db }) {
  // ─── Auth gate for player-facing endpoints ────────────────────────
  // Same pattern as /rewards/claim: validate session_token against player_id.
  function verifyPlayerAuth(req, reply, playerId) {
    const sessionToken = req.body?.session_token || req.query?.session_token;
    const authEnforced = process.env.ECONOMY_AUTH_ENFORCED !== 'false';
    if (authEnforced || sessionToken) {
      if (!sessionToken) {
        reply.code(401);
        return { error: 'session token required' };
      }
      const player = db.prepare('SELECT session_token FROM players WHERE id = ?').get(playerId);
      if (!player || player.session_token !== sessionToken) {
        reply.code(403);
        return { error: 'session token mismatch — claim denied' };
      }
    }
    return null;
  }

  // ─── POST /vmco/claim ─────────────────────────────────────────────
  // Player claims N micros → VMCO creates or tops up their sub-key.
  //
  // Body: { player_id, amount_micros, session_token, idempotency_key? }
  // Response: { ok, sub_key, sub_key_id, budget_credits, claimed_micros }

  app.post('/vmco/claim', async (req, reply) => {
    const playerId = req.body?.player_id;
    const amountMicros = parseInt(req.body?.amount_micros, 10);
    const idempotencyKey = req.body?.idempotency_key ? String(req.body.idempotency_key).slice(0, 64) : null;

    // Validate
    if (!playerId || typeof playerId !== 'string' || !/^[0-9a-f-]{36}$/.test(playerId)) {
      reply.code(400);
      return { error: 'player_id is required (must be UUID)' };
    }
    if (!Number.isFinite(amountMicros) || amountMicros <= 0) {
      reply.code(400);
      return { error: 'amount_micros is required and must be > 0' };
    }
    if (amountMicros > MAX_BUDGET_PER_CLAIM) {
      reply.code(400);
      const maxCredits = Math.floor(MAX_BUDGET_PER_CLAIM / MICROS_PER_CREDIT);
      return { error: `max claim is ${MAX_BUDGET_PER_CLAIM} micros (${maxCredits} credits)` };
    }
    if (amountMicros < MIN_CLAIM_MICROS) {
      reply.code(400);
      return { error: `minimum claim is ${MIN_CLAIM_MICROS} micros (${MIN_CLAIM_MICROS/MICROS_PER_CREDIT} credit)` };
    }
    // Claim must be a whole number of VMCO credits (no fractional credits)
    if (amountMicros % MICROS_PER_CREDIT !== 0) {
      reply.code(400);
      const rounded = Math.floor(amountMicros / MICROS_PER_CREDIT) * MICROS_PER_CREDIT;
      return { error: `amount must be a multiple of ${MICROS_PER_CREDIT} micros (try ${rounded} or ${rounded + MICROS_PER_CREDIT})` };
    }

    // Auth
    const authErr = verifyPlayerAuth(req, reply, playerId);
    if (authErr) return authErr;

    // Rate limit
    const cd = ledger.checkCooldown(db, 'vmco_claim:' + playerId, CLAIM_COOLDOWN_MS);
    if (cd.limited) {
      logAudit(db, { player_id: playerId, amount_micros: amountMicros, result: 'rate_limited' });
      reply.code(429);
      return { error: 'claim rate limited — please wait', retry_after_seconds: cd.retryAfter };
    }

    // Idempotency
    if (idempotencyKey) {
      const existing = db.prepare(
        `SELECT id FROM reward_claims WHERE idempotency_key = ? AND player_id = ?`
      ).get(idempotencyKey, playerId);
      if (existing) {
        return { ok: true, idempotent: true };
      }
    }

    // Check player has enough unclaimed rewards
    const rewards = getPlayerRewards(db, playerId);
    const available = (rewards?.earned_micros || 0) - (rewards?.claimed_micros || 0);
    if (available < amountMicros) {
      reply.code(409);
      logAudit(db, { player_id: playerId, amount_micros: amountMicros, result: 'insufficient', reason: `available=${available}` });
      return { error: `insufficient rewards — available ${available} micros` };
    }

    // Convert micros → VMCO credits (integer division, already validated as multiple)
    const creditsToAdd = amountMicros / MICROS_PER_CREDIT;  // exact integer after modulo check

    // Get current player state for existing sub-key
    const player = getPlayer(db, playerId);
    if (!player) {
      reply.code(404);
      return { error: 'player not found' };
    }

    // Master key check (so we fail fast with a useful error)
    let masterAcct;
    try {
      masterAcct = await vmcoClient.getAccount(); // throws if env var missing or auth bad
    } catch (err) {
      reply.code(503);
      logAudit(db, { player_id: playerId, amount_micros: amountMicros, result: 'failed', reason: 'master_key_missing' });
      return { error: 'VMCO integration not configured (master key missing)' };
    }

    // Low balance guard — protect the master account from draining to $0
    if ((masterAcct.balance_credits || 0) < MASTER_BALANCE_FLOOR) {
      reply.code(503);
      logAudit(db, { player_id: playerId, amount_micros: amountMicros, result: 'failed', reason: 'master_balance_low' });
      return { error: 'VMCO master account temporarily low — claims paused', balance_credits: masterAcct.balance_credits };
    }

    try {
      let result;
      let subKeyId;
      let subKeyValue;
      let newBudget;

      if (player.vmco_sub_key_id) {
        // Top up existing sub-key
        const currentBudget = player.vmco_sub_key_budget_credits || 0;
        newBudget = currentBudget + creditsToAdd;
        const updated = await vmcoClient.updateSubKey(player.vmco_sub_key_id, { budget_credits: newBudget });
        subKeyId = player.vmco_sub_key_id;
        subKeyValue = player.vmco_sub_key;  // unchanged
        result = updated;
      } else {
        // Create new sub-key
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
        result = created;
      }

      // Persist to DB
      const now = new Date().toISOString();
      if (player.vmco_sub_key_id) {
        db.prepare(
          `UPDATE players SET vmco_sub_key_budget_credits = ? WHERE id = ?`
        ).run(newBudget, playerId);
      } else {
        db.prepare(
          `UPDATE players SET vmco_sub_key = ?, vmco_sub_key_id = ?,
                  vmco_sub_key_created_at = ?, vmco_sub_key_budget_credits = ?
            WHERE id = ?`
        ).run(subKeyValue, subKeyId, now, newBudget, playerId);
      }

      // Decrement player's available rewards (ledger-style)
      decPlayerRewards(db, playerId, amountMicros);

      // Keep aggregate pool accounting consistent with /rewards/claim.
      incRewardsPoolClaimed(db, amountMicros);

      // Record in reward_claims for audit
      recordVmcoClaim(db, {
        playerId,
        subKeyId,
        amountMicros,
        idempotencyKey,
      });

      logAudit(db, { player_id: playerId, amount_micros: amountMicros, result: 'completed', claim_id: subKeyId });

      // Cooldown set AFTER successful claim (matches /rewards/claim pattern)
      ledger.setCooldown(db, 'vmco_claim:' + playerId);

      return {
        ok: true,
        sub_key: subKeyValue,
        sub_key_id: subKeyId,
        budget_credits: newBudget,
        claimed_micros: amountMicros,
        is_new: !player.vmco_sub_key_id,
      };
    } catch (err) {
      logAudit(db, { player_id: playerId, amount_micros: amountMicros, result: 'failed', reason: err.message });
      reply.code(502);
      return { error: 'VMCO API call failed', detail: err.message };
    }
  });

  // ─── GET /vmco/sub-key/:player_id ────────────────────────────────
  // Player fetches their existing sub-key value.
  // Useful if they lost it — they can re-display it.

  app.get('/vmco/sub-key/:player_id', async (req, reply) => {
    const playerId = req.params.player_id;
    const authErr = verifyPlayerAuth(req, reply, playerId);
    if (authErr) return authErr;

    const player = getPlayer(db, playerId);
    if (!player) {
      reply.code(404);
      return { error: 'player not found' };
    }
    if (!player.vmco_sub_key_id) {
      return { ok: true, has_sub_key: false };
    }
    return {
      ok: true,
      has_sub_key: true,
      sub_key: player.vmco_sub_key,
      sub_key_id: player.vmco_sub_key_id,
      budget_credits: player.vmco_sub_key_budget_credits,
      created_at: player.vmco_sub_key_created_at,
    };
  });

  // ─── DELETE /vmco/sub-key/:player_id ─────────────────────────────
  // Player revokes their sub-key (e.g., "I lost my laptop, kill the key").

  app.delete('/vmco/sub-key/:player_id', async (req, reply) => {
    const playerId = req.params.player_id;
    const authErr = verifyPlayerAuth(req, reply, playerId);
    if (authErr) return authErr;

    const player = getPlayer(db, playerId);
    if (!player) {
      reply.code(404);
      return { error: 'player not found' };
    }
    if (!player.vmco_sub_key_id) {
      return { ok: true, already_revoked: true };
    }

    try {
      await vmcoClient.deleteSubKey(player.vmco_sub_key_id);
    } catch (err) {
      // Best-effort — still clear local copy
    }

    db.prepare(
      `UPDATE players SET vmco_sub_key = NULL, vmco_sub_key_id = NULL,
              vmco_sub_key_created_at = NULL, vmco_sub_key_budget_credits = NULL
        WHERE id = ?`
    ).run(playerId);

    return { ok: true, revoked: true };
  });

  // ─── GET /vmco/account ───────────────────────────────────────────
  // Admin: master account balance + name.

  app.get('/vmco/account', async (req, reply) => {
    try {
      const acct = await vmcoClient.getAccount();
      return {
        ok: true,
        id: acct.id,
        name: acct.name,
        email: acct.email || null,
        balance_credits: acct.balance_credits,
      };
    } catch (err) {
      reply.code(502);
      return { error: 'vmco API call failed', detail: err.message };
    }
  });

  // ─── GET /vmco/health ────────────────────────────────────────────
  // Liveness + auth check.

  app.get('/vmco/health', async (req, reply) => {
    const result = await vmcoClient.healthCheck();
    reply.code(result.ok ? 200 : 503);
    return result;
  });
}

module.exports = { register };