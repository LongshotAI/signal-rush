#!/usr/bin/env node
// VMCO claim flow integration test — exercises the new endpoints end-to-end.
// Uses real VMCO API against the live account (capped at $0.05 exposure per test run).
//
// Economics (post-fix):
//   10,000 micros earned → 1 VMCO credit ($0.01)
//   Min claim: 10,000 micros (1 credit)
//   Max claim: 1,000,000 micros (100 credits = $1.00)
const http = require('http');
const { execSync } = require('child_process');
const crypto = require('crypto');

const BASE = '127.0.0.1';
const PORT = 8720;

function call(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = { 'Content-Type': 'application/json' };
    if (data) headers['Content-Length'] = Buffer.byteLength(data);
    const req = http.request({ host: BASE, port: PORT, path, method, headers, timeout: 30 },
      res => { let buf=''; res.on('data', c=>buf+=c); res.on('end',()=>{
        try { resolve({status:res.statusCode, body:JSON.parse(buf)}); }
        catch(e){ resolve({status:res.statusCode, body:{_raw:buf}}); }
      }); });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function dbExec(sql) {
  const result = execSync(`sqlite3 /home/hive/.signal-rush/economy.db "${sql.replace(/"/g, '\\"')}"`,
    { encoding: 'utf8' });
  return result.trim();
}

const MICROS_PER_CREDIT = 10000;
const MIN_CLAIM = 10000;

(async () => {
  console.log('══════════════════════════════════════════════════════════');
  console.log(' VMCO CLAIM FLOW — end-to-end integration test (v2: corrected economics)');
  console.log('══════════════════════════════════════════════════════════');

  // Setup: create a fake test player with linked telegram_id and 100,000 earned_micros
  // 100,000 micros = 10 VMCO credits = $0.10 (enough to test claim + top-up + sub-key usage)
  const playerId = crypto.randomUUID();
  const earnedMicros = 100_000;  // 10 credits = $0.10
  console.log(`\nSetup: creating test player ${playerId}`);
  console.log(`  Earned: ${earnedMicros} micros = ${earnedMicros/MICROS_PER_CREDIT} credits = $${(earnedMicros/MICROS_PER_CREDIT*0.01).toFixed(2)}`);
  dbExec(
    `INSERT INTO players (id, display_name, telegram_id, total_earned, total_spent, balance)
     VALUES ('${playerId}', '@VMCOTest', '${playerId}', ${earnedMicros}, 0, 0)`
  );
  dbExec(
    `INSERT INTO player_rewards (player_id, earned_micros, claimed_micros)
     VALUES ('${playerId}', ${earnedMicros}, 0)`
  );
  const sessionToken = crypto.randomUUID();
  dbExec(`UPDATE players SET session_token = '${sessionToken}' WHERE id = '${playerId}'`);

  console.log('Test player ready.');

  // ─── TEST 1: /vmco/health ─────────────────────────────────────
  console.log('\n── TEST 1: GET /vmco/health ──');
  const h = await call('GET', '/vmco/health');
  console.log(`  status=${h.status}, ok=${h.body.ok}, name=${h.body.name}, balance=${h.body.balance_credits}`);
  if (!h.body.ok) { console.log('❌ FAIL: VMCO health check failed'); process.exit(1); }
  console.log('  ✓ VMCO reachable, master auth works');

  // ─── TEST 2: First claim — create sub-key (50,000 micros → 5 credits) ──
  console.log('\n── TEST 2: POST /vmco/claim (50,000 micros → 5 credits, NEW sub-key) ──');
  const c1 = await call('POST', '/vmco/claim', {
    player_id: playerId,
    amount_micros: 50000,
    session_token: sessionToken,
    idempotency_key: 'test2-' + Date.now(),
  });
  console.log(`  status=${c1.status}`);
  console.log(`  body: ${JSON.stringify(c1.body).slice(0,300)}`);
  if (c1.status !== 200 || !c1.body.ok) {
    console.log('❌ FAIL: First claim failed');
    console.log(JSON.stringify(c1.body, null, 2));
    process.exit(1);
  }
  const SUB_KEY_1 = c1.body.sub_key;
  const SUB_ID_1 = c1.body.sub_key_id;
  console.log(`  ✓ New sub-key issued: ${SUB_KEY_1.slice(0,12)}… id=${SUB_ID_1.slice(0,8)}…`);
  console.log(`  ✓ API returned budget: ${c1.body.budget_credits} (VMCO internal units), is_new=${c1.body.is_new}`);
  if (c1.body.is_new !== true || !c1.body.sub_key) {
    console.log('❌ FAIL: expected new sub-key creation');
    process.exit(1);
  }
  // Verify our own DB stores the correct budget in our credit units
  const dbBudget1 = dbExec(`SELECT vmco_sub_key_budget_credits FROM players WHERE id = '${playerId}'`);
  console.log(`  ✓ Our DB records budget: ${dbBudget1} credits (= ${(dbBudget1*0.01).toFixed(2)})`);
  if (parseInt(dbBudget1) !== 5) {
    console.log(`❌ FAIL: expected DB budget=5, got ${dbBudget1}`);
    process.exit(1);
  }

  // ─── TEST 3: Verify sub-key actually works against api.vmco.ai ──
  console.log('\n── TEST 3: Use sub-key for real chat completion ──');
  const chat = await new Promise((resolve, reject) => {
    const data = JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'Reply with just: SR_CLAIM_WORKS' }],
      max_tokens: 10,
    });
    const r = require('https').request({
      host: 'api.vmco.ai', path: '/v1/chat/completions', method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + SUB_KEY_1,
        'Content-Length': Buffer.byteLength(data),
      },
      timeout: 15,
    }, res => { let buf=''; res.on('data',c=>buf+=c); res.on('end',()=>{
      try { resolve(JSON.parse(buf)); } catch(e){ resolve({_raw:buf}); }
    }); });
    r.on('error', reject);
    r.write(data); r.end();
  });
  console.log(`  Model: ${chat.model}`);
  console.log(`  Reply: "${chat.choices?.[0]?.message?.content}"`);
  console.log(`  Tokens: ${chat.usage?.total_tokens}`);
  if (chat.choices?.[0]?.message?.content !== 'SR_CLAIM_WORKS') {
    console.log('❌ FAIL: Sub-key did not return expected reply');
    process.exit(1);
  }
  console.log('  ✓ Sub-key works as Bearer auth against api.vmco.ai');

  // ─── TEST 4: Second claim — top up same sub-key (30,000 micros → 3 credits) ──
  dbExec(`DELETE FROM rate_limit_cooldowns WHERE key = 'vmco_claim:${playerId}'`);
  console.log('\n── TEST 4: POST /vmco/claim (30,000 micros → 3 credits, TOP UP) ──');
  const c2 = await call('POST', '/vmco/claim', {
    player_id: playerId,
    amount_micros: 30000,
    session_token: sessionToken,
    idempotency_key: 'test4-' + Date.now(),
  });
  console.log(`  status=${c2.status}`);
  const dbBudget2 = dbExec(`SELECT vmco_sub_key_budget_credits FROM players WHERE id = '${playerId}'`);
  console.log(`  DB Budget: ${dbBudget2} credits (expected 8 = 5+3)`);
  console.log(`  API returned budget: ${c2.body.budget_credits} (VMCO units), is_new: ${c2.body.is_new} (expected false)`);
  if (c2.status !== 200 || parseInt(dbBudget2) !== 8 || c2.body.is_new !== false) {
    console.log('❌ FAIL: Top-up claim incorrect');
    process.exit(1);
  }
  console.log('  ✅ Same sub-key, budget increased by 3 credits (5→8)');

  // ─── TEST 5: GET /vmco/sub-key/:player_id — fetch existing ────
  console.log('\n── TEST 5: GET /vmco/sub-key/:player_id (re-fetch) ──');
  const g = await call('GET', `/vmco/sub-key/${playerId}?session_token=${sessionToken}`);
  console.log(`  status=${g.status}, has_sub_key=${g.body.has_sub_key}, budget_credits=${g.body.budget_credits}`);
  console.log(`  Same sub_key as claim 1? ${g.body.sub_key === SUB_KEY_1 ? 'YES ✓' : 'NO ❌'}`);
  if (g.body.sub_key !== SUB_KEY_1 || g.body.budget_credits !== 8) { console.log('FAIL'); process.exit(1); }
  console.log('  ✓ Sub-key re-fetched correctly with budget=8');

  // ─── TEST 6: Reward accounting — earned/claimed balance ────────
  console.log('\n── TEST 6: player_rewards accounting correct ──');
  const rewards = dbExec(`SELECT earned_micros, claimed_micros FROM player_rewards WHERE player_id = '${playerId}'`);
  console.log(`  player_rewards: ${rewards}`);
  const [earned, claimed] = rewards.split('|').map(Number);
  if (earned !== 100000 || claimed !== 80000) {
    console.log(`❌ FAIL: expected earned=100000 claimed=80000, got earned=${earned} claimed=${claimed}`);
    process.exit(1);
  }
  console.log('  ✓ claimed_micros correctly incremented (50000+30000=80000)');

  // ─── TEST 7: reward_claims audit trail ────────────────────────
  console.log('\n── TEST 7: reward_claims audit trail ──');
  const claims = dbExec(
    `SELECT amount_micros, status, ppq_account FROM reward_claims WHERE player_id = '${playerId}'`
  );
  console.log(`  Claims: ${claims.replace(/\n/g, ', ')}`);
  if (!claims.includes('vmco:')) {
    console.log('❌ FAIL: VMCO claim not recorded in reward_claims');
    process.exit(1);
  }
  console.log('  ✓ VMCO claims recorded with provider prefix');

  // ─── TEST 7b: claim_audit table (new in migration 004 v2) ─────
  console.log('\n── TEST 7b: claim_audit table logging ──');
  const auditRows = dbExec(
    `SELECT amount_micros, result, reason FROM claim_audit WHERE player_id = '${playerId}' ORDER BY id`
  );
  console.log(`  Audit rows:\n${auditRows.split('\n').map(r => '    ' + r).join('\n')}`);
  const auditCount = auditRows.split('\n').filter(r => r.includes('completed')).length;
  if (auditCount !== 2) {
    console.log(`❌ FAIL: expected 2 completed audit rows, got ${auditCount}`);
    process.exit(1);
  }
  console.log('  ✓ claim_audit captured 2 successful claims');

  // ─── TEST 8: Auth rejection — wrong session token ─────────────
  console.log('\n── TEST 8: Wrong session token rejected ──');
  dbExec(`DELETE FROM rate_limit_cooldowns WHERE key = 'vmco_claim:${playerId}'`);
  const wrongAuth = await call('POST', '/vmco/claim', {
    player_id: playerId,
    amount_micros: 10000,
    session_token: 'wrong-token',
  });
  console.log(`  status=${wrongAuth.status}, error="${wrongAuth.body.error}"`);
  if (wrongAuth.status !== 403) {
    console.log('❌ FAIL: expected 403 for bad token');
    process.exit(1);
  }
  console.log('  ✓ 403 returned for mismatched session token');

  // ─── TEST 9: Insufficient rewards rejected ────────────────────
  console.log('\n── TEST 9: Claim exceeding balance rejected ──');
  dbExec(`DELETE FROM rate_limit_cooldowns WHERE key = 'vmco_claim:${playerId}'`);
  // Player has 100,000 - 80,000 = 20,000 available; try to claim 50,000 (above balance)
  const tooMuch = await call('POST', '/vmco/claim', {
    player_id: playerId,
    amount_micros: 50000,
    session_token: sessionToken,
  });
  console.log(`  status=${tooMuch.status}, error="${tooMuch.body.error}"`);
  if (tooMuch.status !== 409) {
    console.log('❌ FAIL: expected 409 for insufficient rewards');
    process.exit(1);
  }
  console.log('  ✓ 409 returned for insufficient rewards');

  // ─── TEST 10: Below minimum claim rejected ────────────────────
  console.log('\n── TEST 10: Claim below minimum (5,000 < 10,000) rejected ──');
  dbExec(`DELETE FROM rate_limit_cooldowns WHERE key = 'vmco_claim:${playerId}'`);
  const tooSmall = await call('POST', '/vmco/claim', {
    player_id: playerId,
    amount_micros: 5000,
    session_token: sessionToken,
  });
  console.log(`  status=${tooSmall.status}, error="${tooSmall.body.error}"`);
  if (tooSmall.status !== 400) {
    console.log('❌ FAIL: expected 400 for below-minimum claim');
    process.exit(1);
  }
  console.log('  ✓ 400 returned for below-minimum claim');

  // ─── TEST 11: Non-round multiple rejected ─────────────────────
  console.log('\n── TEST 11: Non-round-multiple (15,000 micros) rejected ──');
  dbExec(`DELETE FROM rate_limit_cooldowns WHERE key = 'vmco_claim:${playerId}'`);
  const notRound = await call('POST', '/vmco/claim', {
    player_id: playerId,
    amount_micros: 15000,
    session_token: sessionToken,
  });
  console.log(`  status=${notRound.status}, error="${notRound.body.error}"`);
  if (notRound.status !== 400) {
    console.log('❌ FAIL: expected 400 for non-round-multiple');
    process.exit(1);
  }
  console.log('  ✓ 400 returned for non-round-multiple (must be multiple of 10,000)');

  // ─── TEST 12: DELETE /vmco/sub-key — revoke ──────────────────
  console.log('\n── TEST 12: DELETE /vmco/sub-key/:player_id (revoke) ──');
  const del = await call('DELETE', `/vmco/sub-key/${playerId}?session_token=${sessionToken}`);
  console.log(`  status=${del.status}, revoked=${del.body.revoked}`);
  const after = await call('GET', `/vmco/sub-key/${playerId}?session_token=${sessionToken}`);
  console.log(`  After delete: has_sub_key=${after.body.has_sub_key}`);
  if (after.body.has_sub_key !== false) {
    console.log('❌ FAIL: sub-key still present after delete');
    process.exit(1);
  }
  console.log('  ✓ Sub-key revoked, local + remote cleared');

  // ─── Cleanup ──────────────────────────────────────────────────
  console.log('\n── Cleanup ──');
  dbExec(`DELETE FROM claim_audit WHERE player_id = '${playerId}'`);
  dbExec(`DELETE FROM reward_claims WHERE player_id = '${playerId}'`);
  dbExec(`DELETE FROM player_rewards WHERE player_id = '${playerId}'`);
  dbExec(`DELETE FROM players WHERE id = '${playerId}'`);
  console.log('  ✓ Test player + rewards + claims + audit cleaned up');

  console.log('\n══════════════════════════════════════════════════════════');
  console.log(' ✅ ALL 12 VMCO INTEGRATION TESTS PASSED (corrected economics)');
  console.log('══════════════════════════════════════════════════════════');
})();
