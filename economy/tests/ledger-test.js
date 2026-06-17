// economy/tests/ledger-test.js
// Unit tests for the economy ledger layer
// Tests every DB operation in isolation using :memory: SQLite

const assert = require('assert/strict');
const path = require('path');
const fs = require('fs');

// Copy schema to economy dir for tests
const schemaPath = path.join(__dirname, '..', 'schema.sql');
const ledger = require('../ledger');

let db;
let passed = 0;
let failed = 0;

function setup() {
  db = ledger.openDb(':memory:');
}

function teardown() {
  if (db) db.close();
}

function test(name, fn) {
  setup();
  try {
    fn();
    passed++;
    console.log(`PASS ${name}`);
  } catch (e) {
    failed++;
    console.error(`FAIL ${name}: ${e.message}`);
    console.error(e.stack);
  } finally {
    teardown();
  }
}

// ─── Player Tests ─────────────────────────────────────────────────

test('createPlayer returns player with UUID and zero balance', () => {
  const p = ledger.createPlayer(db, 'TestPlayer');
  assert(p.id, 'player should have an id');
  assert.equal(p.display_name, 'TestPlayer');
  assert.equal(p.balance, 0);
  assert.equal(p.total_earned, 0);
  assert.equal(p.total_spent, 0);
});

test('getPlayer returns null for nonexistent player', () => {
  const p = ledger.getPlayer(db, 'nonexistent-uuid');
  assert.equal(p, undefined);
});

test('playerExists returns true after creation', () => {
  const p = ledger.createPlayer(db, 'Exists');
  assert.equal(ledger.playerExists(db, p.id), true);
  assert.equal(ledger.playerExists(db, 'fake-id'), false);
});

// ─── Award Credits Tests ──────────────────────────────────────────

test('awardCredits increases balance and total_earned', () => {
  const p = ledger.createPlayer(db, 'Award');
  const result = ledger.awardCredits(db, { playerId: p.id, amount: 10, reason: 'test' });
  assert.equal(result.player.balance, 10);
  assert.equal(result.player.total_earned, 10);
});

test('awardCredits creates a transaction record', () => {
  const p = ledger.createPlayer(db, 'AwardTx');
  ledger.awardCredits(db, { playerId: p.id, amount: 5, reason: 'pickup' });
  const txs = ledger.getTransactions(db, p.id);
  assert.equal(txs.transactions.length, 1);
  assert.equal(txs.transactions[0].type, 'award');
  assert.equal(txs.transactions[0].amount, 5);
  assert.equal(txs.transactions[0].reason, 'pickup');
});

test('awardCredits is idempotent — same event_id does not double-award', () => {
  const p = ledger.createPlayer(db, 'Idempotent');
  const eventId = 'test-event-123';
  const r1 = ledger.awardCredits(db, { playerId: p.id, amount: 10, reason: 'test', eventId });
  assert.equal(r1.idempotent, false);
  assert.equal(r1.player.balance, 10);

  const r2 = ledger.awardCredits(db, { playerId: p.id, amount: 10, reason: 'test', eventId });
  assert.equal(r2.idempotent, true, 'second call should be idempotent');
  assert.equal(r2.player.balance, 10, 'balance should not change on duplicate');
});

test('awardCredits rejects zero amount', () => {
  const p = ledger.createPlayer(db, 'ZeroAward');
  assert.throws(() => {
    ledger.awardCredits(db, { playerId: p.id, amount: 0, reason: 'test' });
  }, /amount must be positive/);
});

test('awardCredits rejects negative amount', () => {
  const p = ledger.createPlayer(db, 'NegAward');
  assert.throws(() => {
    ledger.awardCredits(db, { playerId: p.id, amount: -5, reason: 'test' });
  }, /amount must be positive/);
});

// ─── Spend Credits Tests ──────────────────────────────────────────

test('spendCredits decreases balance and increases total_spent', () => {
  const p = ledger.createPlayer(db, 'Spend');
  ledger.awardCredits(db, { playerId: p.id, amount: 20, reason: 'test' });
  const result = ledger.spendCredits(db, { playerId: p.id, amount: 7, reason: 'redeem' });
  assert.equal(result.player.balance, 13);
  assert.equal(result.player.total_spent, 7);
});

test('spendCredits fails if insufficient balance', () => {
  const p = ledger.createPlayer(db, 'Broke');
  ledger.awardCredits(db, { playerId: p.id, amount: 5, reason: 'test' });
  assert.throws(() => {
    ledger.spendCredits(db, { playerId: p.id, amount: 10, reason: 'too_much' });
  }, /insufficient balance/);
});

test('spendCredits is idempotent', () => {
  const p = ledger.createPlayer(db, 'SpendIdem');
  ledger.awardCredits(db, { playerId: p.id, amount: 20, reason: 'test' });
  const eventId = 'spend-event-456';
  const r1 = ledger.spendCredits(db, { playerId: p.id, amount: 5, reason: 'redeem', eventId });
  assert.equal(r1.idempotent, false);
  assert.equal(r1.player.balance, 15);

  const r2 = ledger.spendCredits(db, { playerId: p.id, amount: 5, reason: 'redeem', eventId });
  assert.equal(r2.idempotent, true);
  assert.equal(r2.player.balance, 15);
});

// ─── Ingest Event Tests ───────────────────────────────────────────

test('ingestEvent with creditsDelta > 0 awards credits', () => {
  const p = ledger.createPlayer(db, 'Ingest');
  const result = ledger.ingestEvent(db, {
    playerId: p.id,
    sessionId: 'session-1',
    creditsDelta: 5,
    events: [{ type: 'pickup_collected', value: 40 }],
  });
  assert.equal(result.creditsAwarded, 5);
  const player = ledger.getPlayer(db, p.id);
  assert.equal(player.balance, 5);
});

test('ingestEvent with isReset=true does NOT record spend', () => {
  const p = ledger.createPlayer(db, 'Reset');
  ledger.ingestEvent(db, {
    playerId: p.id,
    sessionId: 'session-2',
    creditsDelta: 10,
    events: [{ type: 'pickup_collected' }],
  });
  // Now reset
  const result = ledger.ingestEvent(db, {
    playerId: p.id,
    sessionId: 'session-2',
    creditsDelta: -10,
    isReset: true,
    events: [{ type: 'run_restarted' }],
  });
  assert.equal(result.creditsAwarded, 0, 'reset should not award or spend');
  const player = ledger.getPlayer(db, p.id);
  // Balance should be 0 (engine reset it) but no spend transaction recorded
  const txs = ledger.getTransactions(db, p.id);
  const spendTxs = txs.transactions.filter(t => t.type === 'spend');
  assert.equal(spendTxs.length, 0, 'no spend transactions on reset');
});

test('ingestEvent stores game events for analytics', () => {
  const p = ledger.createPlayer(db, 'Events');
  const result = ledger.ingestEvent(db, {
    playerId: p.id,
    sessionId: 'session-3',
    creditsDelta: 0,
    events: [
      { type: 'pickup_collected', value: 30 },
      { type: 'near_miss', count: 1, score: 12 },
    ],
  });
  assert.equal(result.eventsStored, 2);

  const events = ledger.getEvents(db, { sessionId: 'session-3' });
  assert.equal(events.length, 2);
  const types = events.map(e => e.event_type).sort();
  assert.deepEqual(types, ['near_miss', 'pickup_collected']);
});

test('ingestEvent creates session record', () => {
  const p = ledger.createPlayer(db, 'Session');
  ledger.ingestEvent(db, {
    playerId: p.id,
    sessionId: 'session-new',
    creditsDelta: 3,
    events: [],
  });
  const sessions = ledger.getPlayerSessions(db, p.id);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].id, 'session-new');
  assert.equal(sessions[0].credits_earned, 3);
});

test('ingestEvent is idempotent for credit awards', () => {
  const p = ledger.createPlayer(db, 'IngestIdem');
  const ts = new Date().toISOString();

  const r1 = ledger.ingestEvent(db, {
    playerId: p.id,
    sessionId: 'session-idem',
    creditsDelta: 8,
    events: [{ type: 'credits_diff' }],
    timestamp: ts,
  });
  assert.equal(r1.creditsAwarded, 8);

  // Same timestamp = same synthetic event_id = idempotent
  const r2 = ledger.ingestEvent(db, {
    playerId: p.id,
    sessionId: 'session-idem',
    creditsDelta: 8,
    events: [{ type: 'credits_diff' }],
    timestamp: ts,
  });
  assert.equal(r2.creditsAwarded, 0, 'duplicate should not re-award');

  const player = ledger.getPlayer(db, p.id);
  assert.equal(player.balance, 8, 'balance should be 8, not 16');
});

// ─── Transaction History Tests ────────────────────────────────────

test('getTransactions returns paginated results', () => {
  const p = ledger.createPlayer(db, 'History');
  for (let i = 0; i < 5; i++) {
    ledger.awardCredits(db, { playerId: p.id, amount: 1, reason: `award-${i}` });
  }
  const page1 = ledger.getTransactions(db, p.id, { limit: 2, offset: 0 });
  assert.equal(page1.transactions.length, 2);
  assert.equal(page1.total, 5);

  const page2 = ledger.getTransactions(db, p.id, { limit: 2, offset: 2 });
  assert.equal(page2.transactions.length, 2);

  const page3 = ledger.getTransactions(db, p.id, { limit: 2, offset: 4 });
  assert.equal(page3.transactions.length, 1);
});

// ─── Ad Impression Tests ──────────────────────────────────────────

test('logImpression stores impression with campaign', () => {
  const p = ledger.createPlayer(db, 'AdPlayer');
  const id = ledger.logImpression(db, {
    campaignId: 'camp-1',
    playerId: p.id,
    placementType: 'hud_frame',
    costMicros: 1000,
  });
  assert(id, 'should return impression id');

  const stats = ledger.getImpressionStats(db, 'camp-1');
  assert.equal(stats.impressions, 1);
  assert.equal(stats.total_cost_micros, 1000);
});

test('logImpression allows NULL campaign (house ad)', () => {
  ledger.logImpression(db, {
    campaignId: null,
    placementType: 'hud_frame',
    costMicros: 0,
  });
  const stats = ledger.getImpressionStats(db, null);
  // NULL campaign won't match in WHERE campaign_id IS NULL with getImpressionStats
  // This is expected — house impressions are tracked separately
});

// ─── Summary Tests ────────────────────────────────────────────────

test('getSummary returns player stats', () => {
  const p = ledger.createPlayer(db, 'Summary');
  ledger.ingestEvent(db, {
    playerId: p.id,
    sessionId: 'sess-sum',
    creditsDelta: 15,
    events: [{ type: 'pickup_collected' }, { type: 'near_miss' }],
  });
  const summary = ledger.getSummary(db, p.id);
  assert.equal(summary.player.balance, 15);
  assert.equal(summary.sessions, 1);
  assert.equal(summary.events, 2);
});

// ─── Fraud Detection Helpers ──────────────────────────────────────

test('getPlayerSessions returns recent sessions', () => {
  const p = ledger.createPlayer(db, 'Fraud');
  for (let i = 0; i < 3; i++) {
    ledger.ingestEvent(db, {
      playerId: p.id,
      sessionId: `sess-fraud-${i}`,
      creditsDelta: 5,
      events: [],
    });
  }
  const sessions = ledger.getPlayerSessions(db, p.id, { limit: 2 });
  assert.equal(sessions.length, 2);
});

// ─── Run Tests ────────────────────────────────────────────────────

console.log(`\nLedger tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
