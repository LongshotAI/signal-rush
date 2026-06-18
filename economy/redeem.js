// economy/redeem.js
// Signal Rush — Token Redemption Module
//
// Players redeem earned credits for AI API calls via external providers.
// All operations are atomic (single SQLite transaction).
// Idempotency keys prevent double-spend on network retries.
//
// Flow:
//   1. redeemCredits() — validates balance, deducts credits, creates pending redemption
//   2. External provider (ppq.ai) is called by the service layer
//   3. completeRedemption() — marks redemption completed, stores provider response
//   4. On failure: refundRedemption() — refunds credits, marks refunded

const { randomUUID } = require('crypto');

// ─── Redeem Credits ────────────────────────────────────────────────
// Validates balance, deducts credits, creates a pending redemption record.
// Returns the redemption object (status: 'pending').
// The service layer is responsible for calling the external provider,
// then calling completeRedemption() or refundRedemption().

function redeemCredits(db, {
  playerId,
  provider,
  amountMicros,
  model,
  prompt,
  idempotencyKey,
}) {
  if (!playerId) throw new Error('redeemCredits: playerId is required');
  if (!provider) throw new Error('redeemCredits: provider is required');
  if (!amountMicros || amountMicros <= 0) throw new Error('redeemCredits: amountMicros must be positive');
  if (!prompt) throw new Error('redeemCredits: prompt is required');
  if (!idempotencyKey) throw new Error('redeemCredits: idempotencyKey is required');

  const tx = db.transaction(() => {
    // Idempotency check — if this key was already processed, return existing
    const existing = db.prepare('SELECT * FROM redemptions WHERE idempotency_key = ?').get(idempotencyKey);
    if (existing) {
      return { idempotent: true, redemption: existing };
    }

    // Check player exists
    const player = db.prepare('SELECT balance FROM players WHERE id = ?').get(playerId);
    if (!player) throw new Error(`redeemCredits: player ${playerId} not found`);

    // Check provider exists and is enabled
    const prov = db.prepare('SELECT * FROM providers WHERE id = ? AND enabled = 1').get(provider);
    if (!prov) throw new Error(`redeemCredits: provider '${provider}' not found or disabled`);

    // Check player balance (convert balance to micro-credits for comparison)
    const balanceMicros = player.balance * prov.credit_rate;
    if (balanceMicros < amountMicros) {
      throw new Error(`redeemCredits: insufficient balance (${balanceMicros} < ${amountMicros})`);
    }

    // Check redemption limits
    if (amountMicros < prov.min_redemption) {
      throw new Error(`redeemCredits: amount ${amountMicros} below minimum ${prov.min_redemption}`);
    }
    if (amountMicros > prov.max_redemption) {
      throw new Error(`redeemCredits: amount ${amountMicros} above maximum ${prov.max_redemption}`);
    }

    // Check daily redemption limit
    const maxPerDay = parseInt(process.env.MAX_REDEMPTION_PER_DAY) || 100000;
    const today = new Date().toISOString().split('T')[0];
    const dailyTotal = db.prepare(
      "SELECT COALESCE(SUM(amount_micros), 0) as total FROM redemptions WHERE player_id = ? AND status != 'failed' AND status != 'refunded' AND date(created_at) = ?"
    ).get(playerId, today).total;
    if (dailyTotal + amountMicros > maxPerDay) {
      throw new Error(`redeemCredits: daily redemption limit exceeded (${dailyTotal + amountMicros} > ${maxPerDay})`);
    }

    // Deduct credits (convert micro-credits back to credits for the balance column)
    const creditsToDeduct = Math.ceil(amountMicros / prov.credit_rate);
    db.prepare(
      'UPDATE players SET balance = balance - ?, total_spent = total_spent + ? WHERE id = ?'
    ).run(creditsToDeduct, creditsToDeduct, playerId);

    // Record spend transaction (store credits, not micros, to match balance unit)
    const spendTxId = randomUUID();
    db.prepare(
      'INSERT INTO transactions (id, player_id, type, amount, reason, event_id) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(spendTxId, playerId, 'spend', creditsToDeduct, `redeem:${provider}`, idempotencyKey);

    // Create redemption record
    const redemptionId = randomUUID();
    const now = new Date().toISOString();
    db.prepare(
      'INSERT INTO redemptions (id, player_id, provider, amount_micros, model, prompt, status, idempotency_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(redemptionId, playerId, provider, amountMicros, model || 'gpt-4o-mini', prompt, 'pending', idempotencyKey, now);

    // Upsert token_balances
    db.prepare(
      'INSERT INTO token_balances (player_id, provider, total_redeemed, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(player_id, provider) DO UPDATE SET total_redeemed = total_redeemed + ?, updated_at = ?'
    ).run(playerId, provider, amountMicros, now, amountMicros, now);

    // Audit log
    const auditId = randomUUID();
    db.prepare(
      'INSERT INTO redemption_audit (id, redemption_id, player_id, action, detail) VALUES (?, ?, ?, ?, ?)'
    ).run(auditId, redemptionId, playerId, 'created', JSON.stringify({ provider, amount_micros: amountMicros }));

    const redemption = db.prepare('SELECT * FROM redemptions WHERE id = ?').get(redemptionId);
    return { idempotent: false, redemption };
  });

  return tx();
}

// ─── Complete Redemption ───────────────────────────────────────────
// Marks a pending redemption as completed, stores provider response.
// Called by the service layer after a successful provider API call.

function completeRedemption(db, { redemptionId, providerRef = null, providerResponse = null }) {
  if (!redemptionId) throw new Error('completeRedemption: redemptionId is required');

  const tx = db.transaction(() => {
    const redemption = db.prepare('SELECT * FROM redemptions WHERE id = ?').get(redemptionId);
    if (!redemption) throw new Error(`completeRedemption: redemption ${redemptionId} not found`);
    if (redemption.status !== 'pending') {
      throw new Error(`completeRedemption: redemption is '${redemption.status}', expected 'pending'`);
    }

    const now = new Date().toISOString();
    db.prepare(
      "UPDATE redemptions SET status = 'completed', provider_ref = ?, provider_response = ?, completed_at = ? WHERE id = ?"
    ).run(providerRef, providerResponse ? JSON.stringify(providerResponse) : null, now, redemptionId);

    // Audit log
    const auditId = randomUUID();
    db.prepare(
      'INSERT INTO redemption_audit (id, redemption_id, player_id, action, detail) VALUES (?, ?, ?, ?, ?)'
    ).run(auditId, redemptionId, redemption.player_id, 'completed', JSON.stringify({ provider_ref: providerRef }));

    return db.prepare('SELECT * FROM redemptions WHERE id = ?').get(redemptionId);
  });

  return tx();
}

// ─── Refund Redemption ─────────────────────────────────────────────
// Refunds credits to the player and marks the redemption as refunded.
// Called by the service layer when the provider API call fails.
// Idempotent — safe to call multiple times.

function refundRedemption(db, { redemptionId, reason = 'provider_error' }) {
  if (!redemptionId) throw new Error('refundRedemption: redemptionId is required');

  const tx = db.transaction(() => {
    const redemption = db.prepare('SELECT * FROM redemptions WHERE id = ?').get(redemptionId);
    if (!redemption) throw new Error(`refundRedemption: redemption ${redemptionId} not found`);

    // Idempotency — already refunded
    if (redemption.status === 'refunded') {
      return { idempotent: true, redemption };
    }

    // Can only refund pending or failed redemptions
    if (redemption.status !== 'pending' && redemption.status !== 'failed') {
      throw new Error(`refundRedemption: cannot refund redemption with status '${redemption.status}'`);
    }

    const now = new Date().toISOString();

    // Refund credits (convert micro-credits back to credits)
    const prov = db.prepare('SELECT credit_rate FROM providers WHERE id = ?').get(redemption.provider);
    const creditRate = prov ? prov.credit_rate : 1000; // fallback to default
    const creditsToRefund = Math.ceil(redemption.amount_micros / creditRate);

    db.prepare(
      'UPDATE players SET balance = balance + ?, total_spent = total_spent - ? WHERE id = ?'
    ).run(creditsToRefund, creditsToRefund, redemption.player_id);

    // Record refund transaction (store credits, not micros)
    const spendTxId = randomUUID();
    db.prepare(
      'INSERT INTO transactions (id, player_id, type, amount, reason, event_id) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(spendTxId, redemption.player_id, 'award', creditsToRefund, `refund:${redemption.provider}`, `refund-${redemptionId}`);

    // Update redemption status
    db.prepare(
      "UPDATE redemptions SET status = 'refunded', completed_at = ? WHERE id = ?"
    ).run(now, redemptionId);

    // Update token_balances (reverse the redemption)
    db.prepare(
      'UPDATE token_balances SET total_redeemed = MAX(0, total_redeemed - ?), updated_at = ? WHERE player_id = ? AND provider = ?'
    ).run(redemption.amount_micros, now, redemption.player_id, redemption.provider);

    // Audit log
    const auditId = randomUUID();
    db.prepare(
      'INSERT INTO redemption_audit (id, redemption_id, player_id, action, detail) VALUES (?, ?, ?, ?, ?)'
    ).run(auditId, redemptionId, redemption.player_id, 'refunded', JSON.stringify({ reason }));

    const updated = db.prepare('SELECT * FROM redemptions WHERE id = ?').get(redemptionId);
    return { idempotent: false, redemption: updated };
  });

  return tx();
}

// ─── Mark Redemption Failed ────────────────────────────────────────
// Marks a pending redemption as failed (before refund).
// Useful for tracking failure reasons.

function failRedemption(db, { redemptionId, reason = 'unknown' }) {
  if (!redemptionId) throw new Error('failRedemption: redemptionId is required');

  const tx = db.transaction(() => {
    const redemption = db.prepare('SELECT * FROM redemptions WHERE id = ?').get(redemptionId);
    if (!redemption) throw new Error(`failRedemption: redemption ${redemptionId} not found`);
    if (redemption.status !== 'pending') {
      throw new Error(`failRedemption: redemption is '${redemption.status}', expected 'pending'`);
    }

    db.prepare(
      "UPDATE redemptions SET status = 'failed' WHERE id = ?"
    ).run(redemptionId);

    // Audit log
    const auditId = randomUUID();
    db.prepare(
      'INSERT INTO redemption_audit (id, redemption_id, player_id, action, detail) VALUES (?, ?, ?, ?, ?)'
    ).run(auditId, redemptionId, redemption.player_id, 'failed', JSON.stringify({ reason }));

    return db.prepare('SELECT * FROM redemptions WHERE id = ?').get(redemptionId);
  });

  return tx();
}

// ─── Get Redemption Status ─────────────────────────────────────────

function getRedemptionStatus(db, redemptionId) {
  if (!redemptionId) throw new Error('getRedemptionStatus: redemptionId is required');
  return db.prepare('SELECT * FROM redemptions WHERE id = ?').get(redemptionId);
}

// ─── List Player Redemptions ───────────────────────────────────────

function getPlayerRedemptions(db, playerId, { limit = 50, offset = 0 } = {}) {
  if (!playerId) throw new Error('getPlayerRedemptions: playerId is required');

  const redemptions = db.prepare(
    'SELECT * FROM redemptions WHERE player_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?'
  ).all(playerId, limit, offset);

  const total = db.prepare(
    'SELECT COUNT(*) as count FROM redemptions WHERE player_id = ?'
  ).get(playerId).count;

  return { redemptions, total, limit, offset };
}

// ─── Get Player Token Balances ─────────────────────────────────────

function getPlayerTokenBalances(db, playerId) {
  if (!playerId) throw new Error('getPlayerTokenBalances: playerId is required');
  return db.prepare('SELECT * FROM token_balances WHERE player_id = ?').all(playerId);
}

module.exports = {
  redeemCredits,
  completeRedemption,
  refundRedemption,
  failRedemption,
  getRedemptionStatus,
  getPlayerRedemptions,
  getPlayerTokenBalances,
};
