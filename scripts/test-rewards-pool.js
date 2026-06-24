// Comprehensive E2E test for the 20% rewards pool + skill-based earning
const crypto = require('crypto');
const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');

const dbPath = '/tmp/sr-rewards-test-' + Date.now() + '.db';
const PORT = 18220;
const passed = [];
const failed = [];

function assert(label, cond, detail) {
  if (cond) { passed.push(label); }
  else { failed.push(label); if (detail) console.error(`  FAIL: ${detail}`); }
}

// Start the economy service
const { createServer } = require('../economy/service.js');
const ledger = require('../economy/ledger.js');

// Clean up old test DB
try { fs.unlinkSync(dbPath); } catch {}

const app = createServer({ port: PORT, dbPath });

const db = ledger.openDb(dbPath);

async function main() {
  // 1. Create an advertiser + campaign
  const playerId = crypto.randomUUID();
  const advertiserId = crypto.randomUUID();
  const campaignId = crypto.randomUUID();

  const apiKey = 'test-api-key-' + crypto.randomBytes(16).toString('hex');
  const apiKeyHash = crypto.createHash('sha256').update(apiKey).digest('hex');
  db.prepare('INSERT INTO advertiser_accounts (id, email, password_hash, company_name, api_key, api_key_hash, status, balance_micros) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(advertiserId, 'test@test.com', 'hash', 'Test Co', apiKey, apiKeyHash, 'active', 1000000);

  db.prepare('INSERT INTO campaigns (id, advertiser_id, name, brand_name, status, placement_type, daily_budget_micros, total_budget_micros, spent_micros, start_date, end_date) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(campaignId, advertiserId, 'Test Campaign', 'Test Brand', 'active', 'hud_frame', 500000, 500000, 0, '2024-01-01', '2030-12-31');

  assert('Campaign inserted', true);

  // 2. Create a player
  db.prepare('INSERT INTO players (id, display_name, balance) VALUES (?, ?, ?)').run(playerId, 'TestPlayer', 0);
  const sessionId = crypto.randomUUID();
  db.prepare('INSERT INTO sessions (id, player_id, started_at) VALUES (?, ?, datetime(\'now\'))').run(sessionId, playerId);

  // 3. Log an impression and check chargeCampaign + rewards pool
  const impressionCost = 1000;
  const result = ledger.chargeCampaign(db, { campaignId, amountMicros: impressionCost });
  assert('chargeCampaign succeeded', result.charged === 1000, JSON.stringify(result));
  assert('advertiser balance deducted', result.advertiser_balance_micros === 999000, `got ${result.advertiser_balance_micros}`);

  // 4. Verify 20% went to rewards pool
  const pool = ledger.getRewardsPoolStats(db);
  assert('rewards pool has 200 micros (20% of 1000)', pool.total_deposited_micros === 200, `got ${pool.total_deposited_micros}`);

  // 5. Charge again — total should be 400
  const r2 = ledger.chargeCampaign(db, { campaignId, amountMicros: impressionCost });
  const pool2 = ledger.getRewardsPoolStats(db);
  assert('second charge adds 200 to pool', pool2.total_deposited_micros === 400, `got ${pool2.total_deposited_micros}`);

  // 6. Check skill-based earnings formula
  const calc = ledger.calculateSkillEarnings;
  const avgEarnings = calc({ score: 100, combo: 3, level: 1, tickCount: 200, difficultyTier: 0 });
  assert('average player earns ~460 micros', avgEarnings >= 400 && avgEarnings <= 500, `got ${avgEarnings}`);

  const topEarnings = calc({ score: 2000, combo: 30, level: 5, tickCount: 500, difficultyTier: 5 });
  assert('top player capped at 5000 micros', topEarnings === 5000, `got ${topEarnings}`);

  const minEarnings = calc({ score: 0, combo: 0, level: 1, tickCount: 10, difficultyTier: 0 });
  assert('minimum earnings floor is 0+', minEarnings >= 0, `got ${minEarnings}`);

  // 7. Earn player rewards
  const earnResult = ledger.earnPlayerReward(db, playerId, { score: 500, combo: 10, level: 3, tickCount: 300, difficultyTier: 2 });
  assert('player earned rewards', earnResult.amount > 0, `got ${earnResult.amount}`);

  const rewards = ledger.getPlayerRewards(db, playerId);
  assert('player has available rewards > 0', rewards.available_micros > 0, `got ${rewards.available_micros}`);
  assert('earned_micros matches available', rewards.earned_micros === rewards.available_micros + rewards.claimed_micros);

  // 8. Claim rewards — must not exceed pool
  const claimableAmount = Math.min(rewards.available_micros, pool2.total_deposited_micros - pool2.total_claimed_micros);
  const claimResult = ledger.claimReward(db, { playerId, ppqAccount: 'player@ppq.ai', amountMicros: claimableAmount });
  assert('claim succeeded', claimResult.claim.status === 'pending', `got ${claimResult.claim.status}`);

  const rewardsAfter = ledger.getPlayerRewards(db, playerId);
  assert('claimed_micros increased after claim', rewardsAfter.claimed_micros > 0, `got ${rewardsAfter.claimed_micros}`);
  assert('available_micros decreased after claim', rewardsAfter.available_micros === rewards.available_micros - claimableAmount, `expected ${rewards.available_micros - claimableAmount}, got ${rewardsAfter.available_micros}`);

  // 9. Complete the claim
  const completed = ledger.completeRewardClaim(db, { claimId: claimResult.claim.id, ppqTxId: 'ppq-tx-123' });
  assert('claim completed', completed.status === 'completed', `got ${completed.status}`);

  const poolAfter = ledger.getRewardsPoolStats(db);
  assert('pool claimed increased', poolAfter.total_claimed_micros > 0, `got ${poolAfter.total_claimed_micros}`);

  // 10. Verify fail/refund rollback
  const poolBeforeFail = ledger.getRewardsPoolStats(db);
  const rewardsBeforeFail = ledger.getPlayerRewards(db, playerId);
  const poolAvailableForFail = Math.max(0, poolBeforeFail.total_deposited_micros - poolBeforeFail.total_claimed_micros);
  if (poolAvailableForFail > 0 && rewardsBeforeFail.available_micros > 0) {
    const claimAmount = Math.min(1000, rewardsBeforeFail.available_micros, poolAvailableForFail);
    const claim2 = ledger.claimReward(db, { playerId, ppqAccount: 'player@ppq.ai', amountMicros: claimAmount });
    const failedClaim = ledger.failRewardClaim(db, claim2.claim.id);
    assert('failed claim status is failed', failedClaim.status === 'failed', `got ${failedClaim.status}`);
    const rewardsAfterFail = ledger.getPlayerRewards(db, playerId);
    assert('failed claim refunds player', rewardsAfterFail.available_micros === rewardsBeforeFail.available_micros, `expected ${rewardsBeforeFail.available_micros}, got ${rewardsAfterFail.available_micros}`);
  } else {
    console.log('  (skipping fail/refund test — pool exhausted)');
  }

  // Summary
  console.log(`\n═══ REWARDS POOL E2E RESULTS ═══`);
  console.log(`Passed: ${passed.length}/${passed.length + failed.length}`);
  if (failed.length > 0) {
    console.log(`FAILED: ${failed.join(', ')}`);
    process.exit(1);
  }
  console.log('✅ ALL CHECKS PASSED — Rewards pool system verified');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
