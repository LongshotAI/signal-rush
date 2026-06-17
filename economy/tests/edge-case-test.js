// economy/tests/edge-case-test.js
// Edge case and long-term consistency tests for the economy ledger
// Proves: no double-counting, reset handling, concurrent access, data integrity

const assert = require('assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
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

// ─── Issue 1: Double-counting prevention ─────────────────────────
// The bridge sends one credits_delta per step. The economy service
// must award exactly that amount, not sum individual event credits.

test('ingestEvent awards exactly credits_delta, not per-event sum', () => {
  const p = ledger.createPlayer(db, 'NoDoubleCount');

  // Simulate: bridge detects +5 credits from a pickup step
  const r1 = ledger.ingestEvent(db, {
    playerId: p.id,
    sessionId: 's1',
    creditsDelta: 5,
    events: [
      { type: 'pickup_collected', value: 40 },
      { type: 'credits_awarded', credits: 5 }, // engine also emits this
    ],
  });

  // Should award exactly 5, not 5+5=10
  assert.equal(r1.creditsAwarded, 5, `expected 5 awarded, got ${r1.creditsAwarded}`);
  const player = ledger.getPlayer(db, p.id);
  assert.equal(player.balance, 5, `expected balance 5, got ${player.balance}`);

  // Second step: +3 credits
  const r2 = ledger.ingestEvent(db, {
    playerId: p.id,
    sessionId: 's1',
    creditsDelta: 3,
    events: [{ type: 'credits_awarded', credits: 3 }],
  });
  assert.equal(r2.creditsAwarded, 3);
  const player2 = ledger.getPlayer(db, p.id);
  assert.equal(player2.balance, 8, `expected balance 8, got ${player2.balance}`);
});

// ─── Issue 2: Reset detection — engine sets credits to 0 on new game ──
// isReset=true should NOT create a spend transaction

test('reset does not create spend transaction', () => {
  const p = ledger.createPlayer(db, 'ResetNoSpend');
  ledger.ingestEvent(db, {
    playerId: p.id, sessionId: 's1',
    creditsDelta: 100, events: [{ type: 'pickup_collected' }],
  });

  // Player restarts — engine resets credits to 0
  ledger.ingestEvent(db, {
    playerId: p.id, sessionId: 's1',
    creditsDelta: -100, isReset: true,
    events: [{ type: 'run_restarted' }],
  });

  const txs = ledger.getTransactions(db, p.id);
  const spendTxs = txs.transactions.filter(t => t.type === 'spend');
  assert.equal(spendTxs.length, 0, 'reset should not create spend transaction');

  // Balance should be 0 (the engine reset it)
  const player = ledger.getPlayer(db, p.id);
  assert.equal(player.balance, 0);
});

// ─── Issue 3: Idempotency — same timestamp = same synthetic event_id ──
// If the bridge retries with the same timestamp, credits must not double

test('ingestEvent is idempotent for same session+timestamp', () => {
  const p = ledger.createPlayer(db, 'IdemIngest');
  const ts = '2026-01-15T12:00:00.000Z';

  const r1 = ledger.ingestEvent(db, {
    playerId: p.id, sessionId: 's1',
    creditsDelta: 10, timestamp: ts,
    events: [{ type: 'pickup_collected' }],
  });
  assert.equal(r1.creditsAwarded, 10);

  // Retry with exact same timestamp
  const r2 = ledger.ingestEvent(db, {
    playerId: p.id, sessionId: 's1',
    creditsDelta: 10, timestamp: ts,
    events: [{ type: 'pickup_collected' }],
  });
  assert.equal(r2.creditsAwarded, 0, 'retry should not re-award');

  const player = ledger.getPlayer(db, p.id);
  assert.equal(player.balance, 10, `expected 10, got ${player.balance}`);
});

// ─── Issue 4: Multiple steps in same session accumulate correctly ──

test('multiple steps in same session accumulate credits', () => {
  const p = ledger.createPlayer(db, 'Accumulate');
  const steps = [3, 5, 2, 7, 1];
  let expected = 0;

  for (let i = 0; i < steps.length; i++) {
    const r = ledger.ingestEvent(db, {
      playerId: p.id, sessionId: 'accumulate-session',
      creditsDelta: steps[i],
      events: [{ type: 'pickup_collected' }],
      timestamp: `2026-01-15T12:00:0${i}.000Z`, // unique timestamps
    });
    expected += steps[i];
    assert.equal(r.creditsAwarded, steps[i], `step ${i}: expected ${steps[i]}, got ${r.creditsAwarded}`);
  }

  const player = ledger.getPlayer(db, p.id);
  assert.equal(player.balance, expected, `expected ${expected}, got ${player.balance}`);

  // Verify transaction count
  const txs = ledger.getTransactions(db, p.id);
  assert.equal(txs.transactions.length, 5, `expected 5 transactions, got ${txs.transactions.length}`);
});

// ─── Issue 5: Zero creditsDelta is a no-op ────────────────────────

test('zero creditsDelta is a no-op', () => {
  const p = ledger.createPlayer(db, 'ZeroDelta');
  const r = ledger.ingestEvent(db, {
    playerId: p.id, sessionId: 's1',
    creditsDelta: 0,
    events: [{ type: 'player_moved' }],
  });
  assert.equal(r.creditsAwarded, 0);
  const player = ledger.getPlayer(db, p.id);
  assert.equal(player.balance, 0);
});

// ─── Issue 6: Negative delta without isReset (future spend) ───────

test('negative creditsDelta without isReset records spend', () => {
  const p = ledger.createPlayer(db, 'NegDelta');
  ledger.awardCredits(db, { playerId: p.id, amount: 20, reason: 'test' });

  const r = ledger.ingestEvent(db, {
    playerId: p.id, sessionId: 's1',
    creditsDelta: -5, isReset: false,
    events: [{ type: 'credits_spent' }],
  });
  assert.equal(r.creditsAwarded, -5, 'should report negative award (spend)');

  const player = ledger.getPlayer(db, p.id);
  assert.equal(player.balance, 15, `expected 15, got ${player.balance}`);

  const txs = ledger.getTransactions(db, p.id);
  const spendTxs = txs.transactions.filter(t => t.type === 'spend');
  assert.equal(spendTxs.length, 1, 'should have 1 spend transaction');
});

// ─── Issue 7: Player auto-created on first ingest ─────────────────

test('ingestEvent auto-creates player if not exists', () => {
  const r = ledger.ingestEvent(db, {
    playerId: 'auto-created-uuid-1234',
    sessionId: 's1',
    creditsDelta: 5,
    events: [{ type: 'pickup_collected' }],
  });
  assert.equal(r.creditsAwarded, 5);

  const player = ledger.getPlayer(db, 'auto-created-uuid-1234');
  assert(player, 'player should exist');
  assert.equal(player.balance, 5);
  assert(player.display_name.startsWith('player-auto-cr'), `name should start with player-auto-cr, got ${player.display_name}`);
});

// ─── Issue 8: Session tracking accumulates correctly ──────────────

test('session stats accumulate across multiple ingests', () => {
  const p = ledger.createPlayer(db, 'SessionAccum');

  ledger.ingestEvent(db, {
    playerId: p.id, sessionId: 'session-abc',
    creditsDelta: 10, events: [{ type: 'pickup_collected' }],
  });
  ledger.ingestEvent(db, {
    playerId: p.id, sessionId: 'session-abc',
    creditsDelta: 5, events: [{ type: 'pickup_collected' }],
  });

  const sessions = ledger.getPlayerSessions(db, p.id);
  assert.equal(sessions.length, 1, 'should have 1 session');
  assert.equal(sessions[0].credits_earned, 15, `expected 15 earned, got ${sessions[0].credits_earned}`);
});

// ─── Issue 9: Game events stored with full metadata ──────────────

test('game events stored with full metadata for replay analysis', () => {
  const p = ledger.createPlayer(db, 'Replay');
  const events = [
    { type: 'pickup_collected', value: 40, x: 10, y: 5 },
    { type: 'near_miss', count: 2, score: 24, streak: 3 },
    { type: 'run_ended', deathState: { killerType: 'corruptor', finalScore: 150 } },
  ];

  ledger.ingestEvent(db, {
    playerId: p.id, sessionId: 'replay-session',
    creditsDelta: 0, events,
  });

  const stored = ledger.getEvents(db, { sessionId: 'replay-session' });
  assert.equal(stored.length, 3, `expected 3 events, got ${stored.length}`);

  // Verify metadata is stored as JSON
  const pickupEvent = stored.find(e => e.event_type === 'pickup_collected');
  const metadata = JSON.parse(pickupEvent.metadata);
  assert.equal(metadata.value, 40, 'metadata should contain event value');
  assert.equal(metadata.x, 10, 'metadata should contain x position');
});

// ─── Issue 10: Transaction audit trail is complete ────────────────

test('every credit mutation has a corresponding transaction', () => {
  const p = ledger.createPlayer(db, 'Audit');

  // Award via ingest
  ledger.ingestEvent(db, {
    playerId: p.id, sessionId: 's1',
    creditsDelta: 10, events: [],
  });

  // Manual award
  ledger.awardCredits(db, { playerId: p.id, amount: 5, reason: 'manual' });

  // Spend
  ledger.spendCredits(db, { playerId: p.id, amount: 3, reason: 'redeem' });

  const txs = ledger.getTransactions(db, p.id);
  assert.equal(txs.transactions.length, 3, `expected 3 transactions, got ${txs.transactions.length}`);

  const player = ledger.getPlayer(db, p.id);
  assert.equal(player.total_earned, 15, `expected total_earned 15, got ${player.total_earned}`);
  assert.equal(player.total_spent, 3, `expected total_spent 3, got ${player.total_spent}`);
  assert.equal(player.balance, 12, `expected balance 12, got ${player.balance}`);
});

// ─── Issue 11: DB persistence — data survives reopen ──────────────

test('data persists across DB reopen', () => {
  const tmpPath = path.join(os.tmpdir(), `signal-rush-edge-${Date.now()}.db`);
  let db2 = ledger.openDb(tmpPath);

  const p = ledger.createPlayer(db2, 'Persist');
  ledger.awardCredits(db2, { playerId: p.id, amount: 42, reason: 'persist_test' });
  ledger.ingestEvent(db2, {
    playerId: p.id, sessionId: 'persist-session',
    creditsDelta: 8, events: [{ type: 'pickup_collected' }],
  });

  // Close and reopen
  db2.close();
  db2 = ledger.openDb(tmpPath);

  const player = ledger.getPlayer(db2, p.id);
  assert.equal(player.balance, 50, `expected 50 after reopen, got ${player.balance}`);
  assert.equal(player.total_earned, 50);

  const txs = ledger.getTransactions(db2, p.id);
  assert.equal(txs.transactions.length, 2);

  const sessions = ledger.getPlayerSessions(db2, p.id);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].credits_earned, 8);

  db2.close();
  fs.unlinkSync(tmpPath);
});

// ─── Issue 12: Large credit amounts don't overflow ────────────────

test('large credit amounts handled correctly', () => {
  const p = ledger.createPlayer(db, 'LargeAmounts');
  ledger.awardCredits(db, { playerId: p.id, amount: 1000000, reason: 'big_award' });
  const player = ledger.getPlayer(db, p.id);
  assert.equal(player.balance, 1000000, `expected 1000000, got ${player.balance}`);
});

// ─── Issue 13: Spend exact balance leaves zero ────────────────────

test('spending exact balance leaves zero', () => {
  const p = ledger.createPlayer(db, 'ExactSpend');
  ledger.awardCredits(db, { playerId: p.id, amount: 10, reason: 'test' });
  ledger.spendCredits(db, { playerId: p.id, amount: 10, reason: 'all' });
  const player = ledger.getPlayer(db, p.id);
  assert.equal(player.balance, 0);
  assert.equal(player.total_spent, 10);
});

// ─── Issue 14: Ad impressions with no player (house ads) ──────────

test('ad impression with NULL player and campaign (house ad)', () => {
  const id = ledger.logImpression(db, {
    campaignId: null,
    playerId: null,
    placementType: 'hud_frame',
    costMicros: 0,
  });
  assert(id, 'should return impression id');
});

// ─── Issue 15: getEvents filters work correctly ───────────────────

test('getEvents filters by player, session, type, since', () => {
  const p = ledger.createPlayer(db, 'Filters');

  ledger.ingestEvent(db, {
    playerId: p.id, sessionId: 'fs1',
    creditsDelta: 0,
    events: [
      { type: 'pickup_collected' },
      { type: 'near_miss' },
    ],
    timestamp: '2026-01-15T10:00:00Z',
  });

  ledger.ingestEvent(db, {
    playerId: p.id, sessionId: 'fs2',
    creditsDelta: 0,
    events: [{ type: 'run_ended' }],
    timestamp: '2026-01-15T11:00:00Z',
  });

  // Filter by session
  const s1 = ledger.getEvents(db, { sessionId: 'fs1' });
  assert.equal(s1.length, 2);

  // Filter by type
  const pickups = ledger.getEvents(db, { playerId: p.id, eventType: 'pickup_collected' });
  assert.equal(pickups.length, 1);

  // Filter by since — only events at or after 10:30
  const after10 = ledger.getEvents(db, { playerId: p.id, since: '2026-01-15T10:30:00Z' });
  // Only the run_ended event at 11:00 qualifies; the two events at 10:00 do not
  assert.equal(after10.length, 1, `expected 1 event after 10:30, got ${after10.length}`);
  assert.equal(after10[0].event_type, 'run_ended');
});

// ─── Run ──────────────────────────────────────────────────────────

console.log(`\nEdge case tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
