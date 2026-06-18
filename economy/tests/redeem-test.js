// economy/tests/redeem-test.js
// Signal Rush — Redemption Module Unit Tests
//
// Tests the core redemption logic in isolation using a fresh in-memory DB.
// No external services, no HTTP, no mocks — just DB operations.
//
// Unit conventions:
//   - Player.balance is in credits (game unit)
//   - redemptions.amount_micros is in micro-credits (1 credit = 1000 micros)
//   - providers.credit_rate = 1000 (micro-credits per credit)
//   - creditsToDeduct = Math.ceil(amountMicros / credit_rate)

const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const redeem = require('../redeem');

// ─── Test Helpers ──────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(condition, msg) {
  if (condition) {
    passed++;
    console.log(`PASS ${msg}`);
  } else {
    failed++;
    console.log(`FAIL ${msg}`);
  }
}

function assertThrows(fn, expectedMsg, testName) {
  try {
    fn();
    failed++;
    console.log(`FAIL ${testName}: expected throw but none`);
  } catch (e) {
    if (expectedMsg && !e.message.includes(expectedMsg)) {
      failed++;
      console.log(`FAIL ${testName}: wrong error: ${e.message}`);
    } else {
      passed++;
      console.log(`PASS ${testName}`);
    }
  }
}

// ─── Setup ─────────────────────────────────────────────────────────

function createTestDb() {
  const db = new Database(':memory:');
  db.pragma('journal_mode=WAL');
  db.pragma('foreign_keys=ON');

  // Load schema
  const schemaPath = path.join(__dirname, '..', 'schema.sql');
  const schema = fs.readFileSync(schemaPath, 'utf8');
  db.exec(schema);

  return db;
}

function createPlayer(db, id = 'player-1', balance = 5000) {
  db.prepare('INSERT INTO players (id, display_name, balance, total_earned) VALUES (?, ?, ?, ?)')
    .run(id, `Player ${id}`, balance, balance);
  return id;
}

// ─── Tests ─────────────────────────────────────────────────────────

console.log('── redeemCredits ──');

// Test 1: Basic redemption (1000 micros = 1 credit at rate 1000)
{
  const db = createTestDb();
  const pid = createPlayer(db);
  const result = redeem.redeemCredits(db, {
    playerId: pid,
    provider: 'ppq',
    amountMicros: 1000,  // = 1 credit
    model: 'gpt-4o-mini',
    prompt: 'Hello world',
    idempotencyKey: 'key-1',
  });
  assert(!result.idempotent, 'basic: not idempotent');
  assert(result.redemption.status === 'pending', 'basic: status is pending');
  assert(result.redemption.amount_micros === 1000, 'basic: amount stored');
  assert(result.redemption.model === 'gpt-4o-mini', 'basic: model stored');
  assert(result.redemption.prompt === 'Hello world', 'basic: prompt stored');

  // Verify balance deducted (1000 micros / 1000 rate = 1 credit)
  const player = db.prepare('SELECT balance FROM players WHERE id = ?').get(pid);
  assert(player.balance === 4999, 'basic: balance deducted (5000 → 4999)');

  // Verify transaction recorded (amount in credits)
  const tx = db.prepare('SELECT * FROM transactions WHERE event_id = ?').get('key-1');
  assert(tx !== undefined, 'basic: spend transaction recorded');
  assert(tx.type === 'spend', 'basic: transaction type is spend');
  assert(tx.amount === 1, 'basic: transaction amount is 1 credit');

  // Verify token_balances updated (in micros)
  const tb = db.prepare('SELECT * FROM token_balances WHERE player_id = ? AND provider = ?').get(pid, 'ppq');
  assert(tb !== undefined, 'basic: token_balance row created');
  assert(tb.total_redeemed === 1000, 'basic: total_redeemed is 1000 micros');

  // Verify audit log
  const audit = db.prepare('SELECT * FROM redemption_audit WHERE redemption_id = ?').get(result.redemption.id);
  assert(audit !== undefined, 'basic: audit log entry created');
  assert(audit.action === 'created', 'basic: audit action is created');
}

// Test 2: Idempotent redemption (same key)
{
  const db = createTestDb();
  const pid = createPlayer(db);
  const result1 = redeem.redeemCredits(db, {
    playerId: pid, provider: 'ppq', amountMicros: 5000,  // = 5 credits
    model: 'gpt-4o-mini', prompt: 'test', idempotencyKey: 'idem-1',
  });
  const result2 = redeem.redeemCredits(db, {
    playerId: pid, provider: 'ppq', amountMicros: 5000,
    model: 'gpt-4o-mini', prompt: 'test', idempotencyKey: 'idem-1',
  });
  assert(!result1.idempotent, 'idempotent: first call not idempotent');
  assert(result2.idempotent, 'idempotent: second call is idempotent');
  assert(result2.redemption.id === result1.redemption.id, 'idempotent: same redemption returned');

  // Balance should only be deducted once (5000 micros = 5 credits)
  const player = db.prepare('SELECT balance FROM players WHERE id = ?').get(pid);
  assert(player.balance === 4995, 'idempotent: balance deducted only once (5000 → 4995)');
}

// Test 3: Insufficient balance (player has 100 credits = 100,000 micros, tries 200,000 micros)
{
  const db = createTestDb();
  const pid = createPlayer(db, 'p3', 100);
  assertThrows(() => {
    redeem.redeemCredits(db, {
      playerId: pid, provider: 'ppq', amountMicros: 200000,  // = 200 credits > 100 balance
      model: 'gpt-4o-mini', prompt: 'test', idempotencyKey: 'key-3',
    });
  }, 'insufficient balance', 'insufficient balance: throws');
}

// Test 4: Provider not found
{
  const db = createTestDb();
  const pid = createPlayer(db);
  assertThrows(() => {
    redeem.redeemCredits(db, {
      playerId: pid, provider: 'nonexistent', amountMicros: 1000,
      model: 'gpt-4o-mini', prompt: 'test', idempotencyKey: 'key-4',
    });
  }, 'not found or disabled', 'invalid provider: throws');
}

// Test 5: Below minimum redemption (min is 100 micros)
{
  const db = createTestDb();
  const pid = createPlayer(db);
  assertThrows(() => {
    redeem.redeemCredits(db, {
      playerId: pid, provider: 'ppq', amountMicros: 50,  // < 100 min
      model: 'gpt-4o-mini', prompt: 'test', idempotencyKey: 'key-5',
    });
  }, 'below minimum', 'below min: throws');
}

// Test 6: Above maximum redemption (max is 100,000 micros = 100 credits)
{
  const db = createTestDb();
  const pid = createPlayer(db, 'p6', 200000);
  assertThrows(() => {
    redeem.redeemCredits(db, {
      playerId: pid, provider: 'ppq', amountMicros: 200000,  // > 100,000 max
      model: 'gpt-4o-mini', prompt: 'test', idempotencyKey: 'key-6',
    });
  }, 'above maximum', 'above max: throws');
}

// Test 7: Missing required fields
{
  const db = createTestDb();
  const base = { playerId: 'x', provider: 'ppq', amountMicros: 1000, model: 'gpt-4o-mini', prompt: 'test', idempotencyKey: 'k' };
  assertThrows(() => redeem.redeemCredits(db, { ...base, playerId: '' }), 'playerId is required', 'missing playerId');
  assertThrows(() => redeem.redeemCredits(db, { ...base, provider: '' }), 'provider is required', 'missing provider');
  assertThrows(() => redeem.redeemCredits(db, { ...base, amountMicros: 0 }), 'amountMicros must be positive', 'zero amount');
  assertThrows(() => redeem.redeemCredits(db, { ...base, amountMicros: -1 }), 'amountMicros must be positive', 'negative amount');
  assertThrows(() => redeem.redeemCredits(db, { ...base, prompt: '' }), 'prompt is required', 'missing prompt');
  assertThrows(() => redeem.redeemCredits(db, { ...base, idempotencyKey: '' }), 'idempotencyKey is required', 'missing idempotencyKey');
}

console.log('');
console.log('── completeRedemption ──');

// Test 8: Complete a pending redemption
{
  const db = createTestDb();
  const pid = createPlayer(db);
  const r = redeem.redeemCredits(db, {
    playerId: pid, provider: 'ppq', amountMicros: 5000,
    model: 'gpt-4o-mini', prompt: 'test', idempotencyKey: 'key-8',
  });
  const completed = redeem.completeRedemption(db, {
    redemptionId: r.redemption.id,
    providerRef: 'ppq-ref-123',
    providerResponse: { choices: [{ message: { content: 'Hello!' } }] },
  });
  assert(completed.status === 'completed', 'complete: status is completed');
  assert(completed.provider_ref === 'ppq-ref-123', 'complete: provider_ref stored');
  assert(completed.completed_at !== null, 'complete: completed_at set');

  // Verify audit
  const audit = db.prepare('SELECT * FROM redemption_audit WHERE redemption_id = ? AND action = ?').get(r.redemption.id, 'completed');
  assert(audit !== undefined, 'complete: audit log entry created');
}

// Test 9: Complete non-pending redemption fails
{
  const db = createTestDb();
  const pid = createPlayer(db);
  const r = redeem.redeemCredits(db, {
    playerId: pid, provider: 'ppq', amountMicros: 5000,
    model: 'gpt-4o-mini', prompt: 'test', idempotencyKey: 'key-9',
  });
  redeem.completeRedemption(db, { redemptionId: r.redemption.id });
  assertThrows(() => {
    redeem.completeRedemption(db, { redemptionId: r.redemption.id });
  }, 'expected \'pending\'', 'complete already-completed: throws');
}

// Test 10: Complete nonexistent redemption
{
  const db = createTestDb();
  assertThrows(() => {
    redeem.completeRedemption(db, { redemptionId: 'nonexistent' });
  }, 'not found', 'complete nonexistent: throws');
}

console.log('');
console.log('── failRedemption ──');

// Test 11: Fail a pending redemption
{
  const db = createTestDb();
  const pid = createPlayer(db);
  const r = redeem.redeemCredits(db, {
    playerId: pid, provider: 'ppq', amountMicros: 5000,
    model: 'gpt-4o-mini', prompt: 'test', idempotencyKey: 'key-11',
  });
  const failed = redeem.failRedemption(db, { redemptionId: r.redemption.id, reason: 'timeout' });
  assert(failed.status === 'failed', 'fail: status is failed');

  // Verify audit
  const audit = db.prepare('SELECT * FROM redemption_audit WHERE redemption_id = ? AND action = ?').get(r.redemption.id, 'failed');
  assert(audit !== undefined, 'fail: audit log entry created');
}

// Test 12: Fail non-pending redemption
{
  const db = createTestDb();
  const pid = createPlayer(db);
  const r = redeem.redeemCredits(db, {
    playerId: pid, provider: 'ppq', amountMicros: 5000,
    model: 'gpt-4o-mini', prompt: 'test', idempotencyKey: 'key-12',
  });
  redeem.completeRedemption(db, { redemptionId: r.redemption.id });
  assertThrows(() => {
    redeem.failRedemption(db, { redemptionId: r.redemption.id });
  }, 'expected \'pending\'', 'fail completed: throws');
}

console.log('');
console.log('── refundRedemption ──');

// Test 13: Refund a pending redemption (1000 micros = 1 credit)
{
  const db = createTestDb();
  const pid = createPlayer(db);
  const r = redeem.redeemCredits(db, {
    playerId: pid, provider: 'ppq', amountMicros: 1000,  // = 1 credit
    model: 'gpt-4o-mini', prompt: 'test', idempotencyKey: 'key-13',
  });
  const refunded = redeem.refundRedemption(db, { redemptionId: r.redemption.id, reason: 'provider_error' });
  assert(!refunded.idempotent, 'refund: not idempotent');
  assert(refunded.redemption.status === 'refunded', 'refund: status is refunded');

  // Verify balance restored (1 credit refunded)
  const player = db.prepare('SELECT balance FROM players WHERE id = ?').get(pid);
  assert(player.balance === 5000, 'refund: balance restored (5000)');

  // Verify refund transaction (amount in credits = 1)
  const tx = db.prepare('SELECT * FROM transactions WHERE event_id = ?').get(`refund-${r.redemption.id}`);
  assert(tx !== undefined, 'refund: refund transaction recorded');
  assert(tx.type === 'award', 'refund: transaction type is award');
  assert(tx.amount === 1, 'refund: transaction amount is 1 credit');

  // Verify token_balances reversed
  const tb = db.prepare('SELECT * FROM token_balances WHERE player_id = ? AND provider = ?').get(pid, 'ppq');
  assert(tb.total_redeemed === 0, 'refund: total_redeemed reversed to 0');

  // Verify audit
  const audit = db.prepare('SELECT * FROM redemption_audit WHERE redemption_id = ? AND action = ?').get(r.redemption.id, 'refunded');
  assert(audit !== undefined, 'refund: audit log entry created');
}

// Test 14: Refund a failed redemption
{
  const db = createTestDb();
  const pid = createPlayer(db);
  const r = redeem.redeemCredits(db, {
    playerId: pid, provider: 'ppq', amountMicros: 5000,  // = 5 credits
    model: 'gpt-4o-mini', prompt: 'test', idempotencyKey: 'key-14',
  });
  redeem.failRedemption(db, { redemptionId: r.redemption.id, reason: 'timeout' });
  const refunded = redeem.refundRedemption(db, { redemptionId: r.redemption.id });
  assert(refunded.redemption.status === 'refunded', 'refund failed: status is refunded');

  const player = db.prepare('SELECT balance FROM players WHERE id = ?').get(pid);
  assert(player.balance === 5000, 'refund failed: balance restored');
}

// Test 15: Refund is idempotent
{
  const db = createTestDb();
  const pid = createPlayer(db);
  const r = redeem.redeemCredits(db, {
    playerId: pid, provider: 'ppq', amountMicros: 5000,
    model: 'gpt-4o-mini', prompt: 'test', idempotencyKey: 'key-15',
  });
  redeem.failRedemption(db, { redemptionId: r.redemption.id });
  const ref1 = redeem.refundRedemption(db, { redemptionId: r.redemption.id });
  const ref2 = redeem.refundRedemption(db, { redemptionId: r.redemption.id });
  assert(!ref1.idempotent, 'refund idempotent: first call not idempotent');
  assert(ref2.idempotent, 'refund idempotent: second call is idempotent');

  // Balance should only be restored once
  const player = db.prepare('SELECT balance FROM players WHERE id = ?').get(pid);
  assert(player.balance === 5000, 'refund idempotent: balance restored only once');
}

// Test 16: Refund completed redemption fails
{
  const db = createTestDb();
  const pid = createPlayer(db);
  const r = redeem.redeemCredits(db, {
    playerId: pid, provider: 'ppq', amountMicros: 5000,
    model: 'gpt-4o-mini', prompt: 'test', idempotencyKey: 'key-16',
  });
  redeem.completeRedemption(db, { redemptionId: r.redemption.id });
  assertThrows(() => {
    redeem.refundRedemption(db, { redemptionId: r.redemption.id });
  }, 'cannot refund', 'refund completed: throws');
}

console.log('');
console.log('── getRedemptionStatus ──');

// Test 17: Get status
{
  const db = createTestDb();
  const pid = createPlayer(db);
  const r = redeem.redeemCredits(db, {
    playerId: pid, provider: 'ppq', amountMicros: 5000,
    model: 'gpt-4o-mini', prompt: 'test', idempotencyKey: 'key-17',
  });
  const status = redeem.getRedemptionStatus(db, r.redemption.id);
  assert(status.id === r.redemption.id, 'status: returns correct redemption');
  assert(status.status === 'pending', 'status: correct status');
}

// Test 18: Get nonexistent
{
  const db = createTestDb();
  const status = redeem.getRedemptionStatus(db, 'nonexistent');
  assert(status === undefined, 'status: nonexistent returns undefined');
}

console.log('');
console.log('── getPlayerRedemptions ──');

// Test 19: List redemptions
{
  const db = createTestDb();
  const pid = createPlayer(db);
  for (let i = 0; i < 3; i++) {
    redeem.redeemCredits(db, {
      playerId: pid, provider: 'ppq', amountMicros: 1000,
      model: 'gpt-4o-mini', prompt: `test ${i}`, idempotencyKey: `list-key-${i}`,
    });
  }
  const list = redeem.getPlayerRedemptions(db, pid);
  assert(list.redemptions.length === 3, 'list: returns 3 redemptions');
  assert(list.total === 3, 'list: total is 3');
  const prompts = new Set(list.redemptions.map(r => r.prompt));
  assert(prompts.has('test 0') && prompts.has('test 1') && prompts.has('test 2'), 'list: all prompts present');
}

// Test 20: Pagination
{
  const db = createTestDb();
  const pid = createPlayer(db);
  for (let i = 0; i < 5; i++) {
    redeem.redeemCredits(db, {
      playerId: pid, provider: 'ppq', amountMicros: 1000,
      model: 'gpt-4o-mini', prompt: `test ${i}`, idempotencyKey: `page-key-${i}`,
    });
  }
  const list = redeem.getPlayerRedemptions(db, pid, { limit: 2, offset: 0 });
  assert(list.redemptions.length === 2, 'pagination: limit 2 returns 2');
  assert(list.total === 5, 'pagination: total is still 5');
}

console.log('');
console.log('── getPlayerTokenBalances ──');

// Test 21: Token balances
{
  const db = createTestDb();
  const pid = createPlayer(db);
  redeem.redeemCredits(db, {
    playerId: pid, provider: 'ppq', amountMicros: 1000,
    model: 'gpt-4o-mini', prompt: 'test', idempotencyKey: 'tb-key-1',
  });
  const balances = redeem.getPlayerTokenBalances(db, pid);
  assert(balances.length === 1, 'balances: returns 1 entry');
  assert(balances[0].provider === 'ppq', 'balances: provider is ppq');
  assert(balances[0].total_redeemed === 1000, 'balances: total_redeemed is 1000 micros');
}

// Test 22: Multiple redemptions accumulate
{
  const db = createTestDb();
  const pid = createPlayer(db);
  redeem.redeemCredits(db, {
    playerId: pid, provider: 'ppq', amountMicros: 5000,
    model: 'gpt-4o-mini', prompt: 'test1', idempotencyKey: 'acc-key-1',
  });
  redeem.redeemCredits(db, {
    playerId: pid, provider: 'ppq', amountMicros: 3000,
    model: 'gpt-4o-mini', prompt: 'test2', idempotencyKey: 'acc-key-2',
  });
  const balances = redeem.getPlayerTokenBalances(db, pid);
  assert(balances[0].total_redeemed === 8000, 'accumulate: total_redeemed is 8000 micros');
}

console.log('');
console.log('── Full Lifecycle ──');

// Test 23: Complete lifecycle — redeem → complete (2000 micros = 2 credits)
{
  const db = createTestDb();
  const pid = createPlayer(db, 'life-1', 10000);

  // Redeem
  const r = redeem.redeemCredits(db, {
    playerId: pid, provider: 'ppq', amountMicros: 2000,  // = 2 credits
    model: 'gpt-4o-mini', prompt: 'Say hello', idempotencyKey: 'life-key-1',
  });
  assert(r.redemption.status === 'pending', 'lifecycle: pending after redeem');

  const midBalance = db.prepare('SELECT balance FROM players WHERE id = ?').get(pid);
  assert(midBalance.balance === 9998, 'lifecycle: balance 9998 after redeem (10000 - 2)');

  // Complete
  const completed = redeem.completeRedemption(db, {
    redemptionId: r.redemption.id,
    providerRef: 'ppq-abc-123',
    providerResponse: { choices: [{ message: { content: 'Hello!' } }] },
  });
  assert(completed.status === 'completed', 'lifecycle: completed');
  assert(completed.provider_ref === 'ppq-abc-123', 'lifecycle: provider_ref stored');

  const finalBalance = db.prepare('SELECT balance FROM players WHERE id = ?').get(pid);
  assert(finalBalance.balance === 9998, 'lifecycle: balance still 9998 after complete');

  const tb = db.prepare('SELECT * FROM token_balances WHERE player_id = ?').get(pid);
  assert(tb.total_redeemed === 2000, 'lifecycle: total_redeemed 2000 micros');
}

// Test 24: Full lifecycle — redeem → fail → refund (3000 micros = 3 credits)
{
  const db = createTestDb();
  const pid = createPlayer(db, 'life-2', 10000);

  const r = redeem.redeemCredits(db, {
    playerId: pid, provider: 'ppq', amountMicros: 3000,  // = 3 credits
    model: 'gpt-4o-mini', prompt: 'test', idempotencyKey: 'life-key-2',
  });
  assert(r.redemption.status === 'pending', 'refund lifecycle: pending');

  const failed = redeem.failRedemption(db, { redemptionId: r.redemption.id, reason: 'provider_timeout' });
  assert(failed.status === 'failed', 'refund lifecycle: failed');

  const refunded = redeem.refundRedemption(db, { redemptionId: r.redemption.id, reason: 'provider_timeout' });
  assert(refunded.redemption.status === 'refunded', 'refund lifecycle: refunded');

  const finalBalance = db.prepare('SELECT balance FROM players WHERE id = ?').get(pid);
  assert(finalBalance.balance === 10000, 'refund lifecycle: balance fully restored');

  const tb = db.prepare('SELECT * FROM token_balances WHERE player_id = ?').get(pid);
  assert(tb.total_redeemed === 0, 'refund lifecycle: total_redeemed reversed');

  // Verify all audit entries
  const audits = db.prepare('SELECT * FROM redemption_audit WHERE redemption_id = ? ORDER BY created_at').all(r.redemption.id);
  assert(audits.length === 3, 'refund lifecycle: 3 audit entries (created, failed, refunded)');
  assert(audits[0].action === 'created', 'refund lifecycle: first audit is created');
  assert(audits[1].action === 'failed', 'refund lifecycle: second audit is failed');
  assert(audits[2].action === 'refunded', 'refund lifecycle: third audit is refunded');
}

// Test 25: Large redemption (50,000 micros = 50 credits)
{
  const db = createTestDb();
  const pid = createPlayer(db, 'large-1', 1000);
  const r = redeem.redeemCredits(db, {
    playerId: pid, provider: 'ppq', amountMicros: 50000,  // = 50 credits
    model: 'gpt-4o-mini', prompt: 'Large redemption test', idempotencyKey: 'large-key-1',
  });
  assert(r.redemption.status === 'pending', 'large: pending');
  assert(r.redemption.amount_micros === 50000, 'large: amount stored correctly');

  const player = db.prepare('SELECT balance FROM players WHERE id = ?').get(pid);
  assert(player.balance === 950, 'large: balance deducted 50 credits (1000 → 950)');
}

console.log('');
console.log(`─── Results: ${passed} passed, ${failed} failed ───`);
if (failed > 0) process.exit(1);
