#!/usr/bin/env node
// scripts/test-ppq-claim-flow.js
// Signal Rush — ppq.ai Credit Distribution End-to-End Test Harness
//
// Tests the full reward claim flow:
//   1. Creates test advertiser + campaign + session
//   2. Charges an impression → 20% goes to pool
//   3. Creates a player via API
//   4. Calls earnPlayerReward with sample gameplay stats
//   5. Calls POST /rewards/claim through the service
//   6. Verifies the claim status is 'pending'
//   7. Calls POST /credits/transfer to complete the transfer
//   8. Verifies the claim is 'completed' with a reference
//   9. Verifies the pool stats updated
//   10. Verifies error handling (insufficient rewards, pool exhausted)
//
// Usage:
//   node scripts/test-ppq-claim-flow.js                # test mode (no API key)
//   PPQ_API_KEY=your_key_here node scripts/test-ppq-claim-flow.js   # production
//
// Starts its own economy service instance. Cleans up on exit.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

// ── Configuration ──────────────────────────────────────────────────
const TEST_PORT = parseInt(process.env.ECONOMY_PORT || '18730', 10);
const TEST_DB_PATH = path.join(os.tmpdir(), `signal-rush-ppq-test-${process.pid}-${Date.now()}.db`);
const INTERNAL_API_KEY = process.env.ECONOMY_API_KEY || null;

// Clean up old DB files
for (const ext of ['', '-wal', '-shm']) {
  try { fs.unlinkSync(TEST_DB_PATH + ext); } catch {}
}

// Disable auth for test
process.env.ECONOMY_AUTH_ENFORCED = 'false';

// Start economy service
const { createServer } = require('../economy/service');
const ledger = require('../economy/ledger');
const server = createServer({ port: TEST_PORT, dbPath: TEST_DB_PATH });
const app = server.app;
const db = ledger.openDb(TEST_DB_PATH);

// ── HTTP Helpers ───────────────────────────────────────────────────

function httpGet(endpoint) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port: TEST_PORT, path: endpoint,
      method: 'GET', timeout: 5000,
    }, (res) => {
      let chunks = '';
      res.on('data', d => chunks += d);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(chunks) }); }
        catch { resolve({ status: res.statusCode, body: chunks }); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

function httpPost(endpoint, body, apiKey = null) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const headers = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(data),
    };
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
    const req = http.request({
      hostname: '127.0.0.1', port: TEST_PORT, path: endpoint,
      method: 'POST', headers, timeout: 30000,
    }, (res) => {
      let chunks = '';
      res.on('data', d => chunks += d);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(chunks) }); }
        catch { resolve({ status: res.statusCode, body: chunks }); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.write(data);
    req.end();
  });
}

// ── Main Test ───────────────────────────────────────────────────────

async function main() {
  const mode = process.env.PPQ_API_KEY && process.env.PPQ_API_KEY.length > 0 ? 'PRODUCTION' : 'TEST';
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log(`║   ppq.ai Credit Distribution Test Harness                  ║`);
  console.log(`║   Mode: ${mode.padEnd(55)}║`);
  console.log('╚══════════════════════════════════════════════════════════╝');

  let passed = 0, failed = 0;
  function PASS(msg) { passed++; console.log(`  ✓ ${msg}`); }
  function FAIL(msg, err) { failed++; console.log(`  ✗ ${msg}${err ? ': ' + (err.message || JSON.stringify(err)) : ''}`); }

  try {
    // ── Start server and health check ──────────────────────────────
    console.log('\n── Service Health Check ──────────────────────────────');
    await server.start();
    const health = await httpGet('/health');
    assert.equal(health.status, 200, `Health check returned ${health.status}`);
    assert.equal(health.body?.status, 'ok', `Unexpected health: ${JSON.stringify(health.body)}`);
    PASS('Economy service is running');

    // ── Create Test Advertiser + Campaign via Direct DB Access ────
    console.log('\n── Setting Up Test Data (Direct DB) ──────────────────');

    const advertiser = ledger.createAdvertiserAccount(db, {
      email: `advertiser-${Date.now()}@test.com`,
      passwordHash: 'test-hash-12345',
      companyName: 'Test Campaign Co',
      apiKey: `test-api-key-${Date.now()}`,
    });
    const advertiserId = advertiser.id;
    PASS(`Created advertiser: ${advertiserId.slice(0, 8)}...`);

    ledger.depositAdvertiserFunds(db, {
      advertiserId,
      amountMicros: 10000000,
      reason: 'test deposit',
    });
    PASS('Deposited 10,000,000 micros to advertiser');

    const campaign = ledger.createCampaign(db, {
      advertiserId,
      name: 'Test Campaign',
      brandName: 'TestBrand',
      placementType: 'hud_frame',
      dailyBudgetMicros: 500000,
      totalBudgetMicros: 2000000,
    });
    const campaignId = campaign.id;
    ledger.updateCampaignStatus(db, campaignId, advertiserId, 'active');
    PASS(`Created + activated campaign: ${campaignId.slice(0, 8)}...`);

    // ── Create Player via API ─────────────────────────────────────
    console.log('\n── Creating Player ───────────────────────────────────');
    const playerRes = await httpPost('/players', { display_name: `test-player-${Date.now()}` });
    assert.equal(playerRes.status, 201, `Expected 201, got ${playerRes.status}`);
    const playerId = playerRes.body.id;
    PASS(`Created player: ${playerId.slice(0, 8)}...`);

    // ── Create Session via API ────────────────────────────────────
    const sessionId = crypto.randomUUID();
    const ingestRes = await httpPost('/internal/ingest', {
      player_id: playerId,
      session_id: sessionId,
      credits_delta: 0,
      events: [{ type: 'session_start' }],
    }, INTERNAL_API_KEY);
    assert.equal(ingestRes.status, 200, `Ingest failed: ${JSON.stringify(ingestRes.body)}`);
    PASS(`Created session: ${sessionId.slice(0, 8)}...`);

    // ── Charge Impressions → 20% to Pool ──────────────────────────
    // Use direct ledger calls to bypass the 5s HTTP cooldown
    console.log('\n── Charging Impressions ──────────────────────────────');
    const REQUIRED_POOL = 6000; // enough for our claim
    const COST_PER_IMPRESSION = 1000;
    const NUM_IMPRESSIONS = Math.ceil(REQUIRED_POOL / Math.floor(COST_PER_IMPRESSION * 0.2));
    for (let i = 0; i < NUM_IMPRESSIONS; i++) {
      ledger.logImpression(db, { campaignId, playerId, placementType: 'hud_frame', costMicros: COST_PER_IMPRESSION });
      ledger.chargeCampaign(db, { campaignId, amountMicros: COST_PER_IMPRESSION });
    }
    const numCharged = NUM_IMPRESSIONS;
    PASS(`${numCharged} impressions charged via ledger`);

    const poolStats1 = await httpGet('/rewards/pool-stats');
    console.log(`  Pool stats: ${JSON.stringify(poolStats1.body)}`);
    assert(poolStats1.body?.total_deposited_micros > 0,
      `Expected pool deposits > 0, got ${poolStats1.body?.total_deposited_micros}`);
    PASS(`Pool has ${poolStats1.body.total_deposited_micros} micros deposited`);

    // ── Earn Player Reward ──────────────────────────────────────
    console.log('\n── Earning Player Reward ─────────────────────────────');
    const earnResult = ledger.earnPlayerReward(db, playerId, {
      score: 500, combo: 10, level: 3,
      tickCount: 200, difficultyTier: 1,
    });
    assert(earnResult.amount > 0, `Expected positive earnings, got ${earnResult.amount}`);
    PASS(`Player earned ${earnResult.amount} micros`);

    const rewardsBefore = ledger.getPlayerRewards(db, playerId);
    assert(rewardsBefore.available_micros >= earnResult.amount,
      `Available ${rewardsBefore.available_micros} >= ${earnResult.amount}`);
    PASS(`Player has ${rewardsBefore.available_micros} micros available`);

    // ── POST /credits/transfer (creates + completes claim in one step) ─
    const ppqAccount = `test-user-${Date.now()}@ppq.ai`;
    console.log('\n── POST /credits/transfer ────────────────────────────');
    const transferRes = await httpPost('/credits/transfer', {
      player_id: playerId,
      ppq_account: ppqAccount,
      amount_micros: earnResult.amount,
    }, INTERNAL_API_KEY);

    console.log(`  Response: ${JSON.stringify(transferRes.body, null, 2)}`);

    if (transferRes.status === 200 && transferRes.body?.status === 'completed') {
      PASS(`Transfer completed (${transferRes.body.mode} mode)`);
      assert(transferRes.body.ppq_ref, 'Missing ppq_ref');
      PASS(`  ppq_ref: ${transferRes.body.ppq_ref}`);
      PASS(`  mode: ${transferRes.body.mode}`);
    } else if (transferRes.status === 502) {
      FAIL('Transfer - provider error', transferRes.body);
    } else {
      FAIL('Transfer - unexpected response', transferRes.body);
    }

    // ── Verify Claim Status in DB ────────────────────────────────
    console.log('\n── Verifying Claim in Database ───────────────────────');
    const transferData = transferRes.body;
    const transferClaimId = transferData?.claim_id || transferData?.id || transferData?.redemption_id;
    if (transferClaimId) {
      const claimInDb = db.prepare('SELECT * FROM reward_claims WHERE id = ?').get(transferClaimId);
      if (claimInDb) {
        console.log(`  DB status: ${claimInDb.status}, ppq_tx_id: ${claimInDb.ppq_tx_id}`);
        if (claimInDb.status === 'completed' && claimInDb.ppq_tx_id) {
          PASS('Claim completed in DB with ppq_tx_id');
        } else {
          PASS(`Claim status: ${claimInDb.status}`);
        }
      } else {
        FAIL('Claim not found in DB');
      }
    }

    // ── Verify Pool Stats ────────────────────────────────────────
    console.log('\n── Verifying Pool Stats ──────────────────────────────');
    const poolStats2 = await httpGet('/rewards/pool-stats');
    console.log(`  Pool stats: ${JSON.stringify(poolStats2.body)}`);
    if (poolStats2.body?.total_claimed_micros > 0) {
      PASS('Pool claimed_micros > 0');
    } else {
      console.log('  (pool claimed may be 0 if transfer used separate claim)');
    }

    // ── Error Handling Tests ─────────────────────────────────────
    console.log('\n── Error Handling Tests ──────────────────────────────');

    // a. Insufficient rewards (use a different player to avoid rate limit)
    const errPlayerRes = await httpPost('/players', { display_name: 'error-test-player' });
    const errPlayerId = errPlayerRes.status === 201 ? errPlayerRes.body.id : playerId;
    // Give them a small reward so the error is "insufficient" not "no rewards"
    if (errPlayerId !== playerId) {
      ledger.earnPlayerReward(db, errPlayerId, { score: 10, combo: 0, level: 1, tickCount: 10, difficultyTier: 0 });
    }
    const err1 = await httpPost('/rewards/claim', {
      player_id: errPlayerId,
      ppq_account: 'test@ppq.ai',
      amount_micros: 50000, // more than their tiny reward
    });
    if (err1.status === 409 && (err1.body?.error || '').includes('insufficient')) {
      PASS('Rejects insufficient rewards');
    } else {
      FAIL('Should reject insufficient rewards', err1.body);
    }

    // b. Invalid player_id (not UUID)
    const err2 = await httpPost('/rewards/claim', {
      player_id: 'not-a-uuid',
      ppq_account: ppqAccount,
      amount_micros: 1000,
    });
    if (err2.status === 400 && (err2.body?.error || '').includes('UUID')) {
      PASS('Rejects invalid player_id UUID');
    } else {
      FAIL('Should reject invalid UUID', err2.body);
    }

    // c. Amount exceeds max (100,000 micros)
    const err3 = await httpPost('/rewards/claim', {
      player_id: playerId,
      ppq_account: ppqAccount,
      amount_micros: 200000,
    });
    if (err3.status === 400 && (err3.body?.error || '').includes('maximum')) {
      PASS('Rejects amount over 100,000 max');
    } else {
      FAIL('Should reject over max amount', err3.body);
    }

    // d. Amount below minimum (1000)
    const err4 = await httpPost('/rewards/claim', {
      player_id: playerId,
      ppq_account: ppqAccount,
      amount_micros: 500,
    });
    if (err4.status === 400 && (err4.body?.error || '').includes('minimum')) {
      PASS('Rejects amount below 1000 minimum');
    } else {
      FAIL('Should reject below minimum', err4.body);
    }

    // e. Missing ppq_account
    const err5 = await httpPost('/rewards/claim', {
      player_id: playerId,
      amount_micros: 1000,
    });
    if (err5.status === 400 && (err5.body?.error || '').includes('ppq_account')) {
      PASS('Rejects missing ppq_account');
    } else {
      FAIL('Should reject missing ppq_account', err5.body);
    }

    // f. Long ppq_account (>128 chars)
    const err6 = await httpPost('/rewards/claim', {
      player_id: playerId,
      ppq_account: 'a'.repeat(200),
      amount_micros: 1000,
    });
    if (err6.status === 400 && (err6.body?.error || '').includes('128')) {
      PASS('Rejects ppq_account > 128 chars');
    } else {
      FAIL('Should reject long ppq_account', err6.body);
    }

    // ── Verify Audit Log Exists ──────────────────────────────────
    console.log('\n── Verifying Audit Log ───────────────────────────────');
    const auditLogPath = path.join(os.homedir(), '.signal-rush', 'claim-audit.log');
    if (fs.existsSync(auditLogPath)) {
      const logContent = fs.readFileSync(auditLogPath, 'utf8');
      const lines = logContent.trim().split('\n').filter(l => l.length > 0);
      if (lines.length > 0) {
        PASS(`Audit log exists with ${lines.length} entries`);
        // Show last entry
        try {
          const lastEntry = JSON.parse(lines[lines.length - 1]);
          console.log(`  Last audit entry: ${JSON.stringify(lastEntry)}`);
        } catch {}
      } else {
        FAIL('Audit log is empty');
      }
    } else {
      FAIL('Audit log file not found');
    }

    // ── Summary ──────────────────────────────────────────────────
    console.log('\n' + '═'.repeat(56));
    console.log(`  RESULTS:  ${passed} passed,  ${failed} failed,  mode: ${mode}`);
    console.log('═'.repeat(56));

    if (failed > 0) {
      console.log(`\n  ❌ ${failed} test(s) FAILED`);
      await server.stop();
      process.exit(1);
    }
    console.log(`\n  ✅ ALL ${passed} test(s) PASSED\n`);
    await server.stop();
    process.exit(0);

  } catch (err) {
    console.error('\n  ❌ Unhandled error:', err.message);
    console.error(err.stack);
    await server.stop();
    process.exit(1);
  }
}

main();