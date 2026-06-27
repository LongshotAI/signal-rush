#!/usr/bin/env node
// VMCO claim flow integration test — exercises the new endpoints end-to-end.
// Uses real VMCO API against the live account (capped at $0.05 exposure).
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

(async () => {
  console.log('══════════════════════════════════════════════════════════');
  console.log(' VMCO CLAIM FLOW — end-to-end integration test');
  console.log('══════════════════════════════════════════════════════════');

  // Setup: create a fake test player with linked telegram_id and 5000 earned_micros
  const playerId = crypto.randomUUID();  // real UUID format
  console.log(`\nSetup: creating test player ${playerId}`);
  dbExec(
    `INSERT INTO players (id, display_name, telegram_id, total_earned, total_spent, balance)
     VALUES ('${playerId}', '@VMCOTest', '${playerId}', 5000, 0, 0)`
  );
  dbExec(
    `INSERT INTO player_rewards (player_id, earned_micros, claimed_micros)
     VALUES ('${playerId}', 5000, 0)`
  );
  // Create a session token so the auth check passes
  const sessionToken = crypto.randomUUID();
  dbExec(`UPDATE players SET session_token = '${sessionToken}' WHERE id = '${playerId}'`);

  console.log('Test player ready: telegram_id=' + playerId + ', earned=5000 micros');

  // ─── TEST 1: /vmco/health ─────────────────────────────────────
  console.log('\n── TEST 1: GET /vmco/health ──');
  const h = await call('GET', '/vmco/health');
  console.log(`  status=${h.status}, ok=${h.body.ok}, name=${h.body.name}, balance=${h.body.balance_credits}`);
  if (!h.body.ok) { console.log('❌ FAIL: VMCO health check failed'); process.exit(1); }

  // ─── TEST 2: First claim — create sub-key ─────────────────────
  console.log('\n── TEST 2: POST /vmco/claim (2000 micros → 20 credits, NEW sub-key) ──');
  const c1 = await call('POST', '/vmco/claim', {
    player_id: playerId,
    amount_micros: 2000,
    session_token: sessionToken,
    idempotency_key: 'test1-' + Date.now(),
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
  console.log(`  ✓ Budget: ${c1.body.budget_credits} credits, is_new=${c1.body.is_new}`);

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

  // ─── TEST 4: Second claim — top up same sub-key ────────────────
  // Clear cooldown so test runs fast (in prod, cooldown is 60s)
  dbExec(`DELETE FROM rate_limit_cooldowns WHERE key = 'vmco_claim:${playerId}'`);
  console.log('\n── TEST 4: POST /vmco/claim (3000 micros → 30 credits, TOP UP) ──');
  const c2 = await call('POST', '/vmco/claim', {
    player_id: playerId,
    amount_micros: 3000,
    session_token: sessionToken,
    idempotency_key: 'test2-' + Date.now(),
  });
  console.log(`  status=${c2.status}`);
  console.log(`  Budget: ${c2.body.budget_credits} credits (was ${c1.body.budget_credits}, expected ${c1.body.budget_credits + 30})`);
  console.log(`  is_new: ${c2.body.is_new} (expected false)`);
  if (c2.status !== 200 || c2.body.budget_credits !== c1.body.budget_credits + 30 || c2.body.is_new !== false) {
    console.log('❌ FAIL: Top-up claim incorrect');
    process.exit(1);
  }
  console.log('  ✓ Same sub-key, budget increased by 30 credits');

  // ─── TEST 5: GET /vmco/sub-key/:player_id — fetch existing ────
  console.log('\n── TEST 5: GET /vmco/sub-key/:player_id (re-fetch) ──');
  const g = await call('GET', `/vmco/sub-key/${playerId}?session_token=${sessionToken}`);
  console.log(`  status=${g.status}, has_sub_key=${g.body.has_sub_key}, budget=${g.body.budget_credits}`);
  console.log(`  Same sub_key as claim 1? ${g.body.sub_key === SUB_KEY_1 ? 'YES ✓' : 'NO ❌'}`);
  if (g.body.sub_key !== SUB_KEY_1) { console.log('FAIL'); process.exit(1); }

  // ─── TEST 6: Reward accounting — earned/claimed balance ────────
  console.log('\n── TEST 6: player_rewards accounting correct ──');
  const rewards = dbExec(`SELECT earned_micros, claimed_micros FROM player_rewards WHERE player_id = '${playerId}'`);
  console.log(`  player_rewards: ${rewards}`);
  const [earned, claimed] = rewards.split('|').map(Number);
  if (claimed !== 5000 || earned !== 5000) {
    console.log(`❌ FAIL: expected earned=5000 claimed=5000, got earned=${earned} claimed=${claimed}`);
    process.exit(1);
  }
  console.log('  ✓ claimed_micros correctly incremented');

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
  console.log('  ✓ VMCO claim recorded with provider prefix');

  // ─── TEST 8: Auth rejection — wrong session token ─────────────
  console.log('\n── TEST 8: Wrong session token rejected ──');
  const wrongAuth = await call('POST', '/vmco/claim', {
    player_id: playerId,
    amount_micros: 1000,
    session_token: 'wrong-token',
  });
  console.log(`  status=${wrongAuth.status}, error="${wrongAuth.body.error}"`);
  if (wrongAuth.status !== 403) {
    console.log('❌ FAIL: expected 403 for bad token');
    process.exit(1);
  }
  console.log('  ✓ 403 returned for mismatched session token');

  // ─── TEST 9: Insufficient rewards rejected ────────────────────
  // Clear cooldown (set by previous successful claims) so we test balance check, not rate limit
  dbExec(`DELETE FROM rate_limit_cooldowns WHERE key = 'vmco_claim:${playerId}'`);
  console.log('\n── TEST 9: Claim exceeding balance rejected ──');
  // Player has 5000 micros; try to claim 6000 (above balance, below max)
  const tooMuch = await call('POST', '/vmco/claim', {
    player_id: playerId,
    amount_micros: 6000,
    session_token: sessionToken,
  });
  console.log(`  status=${tooMuch.status}, error="${tooMuch.body.error}"`);
  if (tooMuch.status !== 409) {
    console.log('❌ FAIL: expected 409 for insufficient rewards');
    process.exit(1);
  }
  console.log('  ✓ 409 returned for insufficient rewards');

  // ─── TEST 10: DELETE /vmco/sub-key — revoke ──────────────────
  console.log('\n── TEST 10: DELETE /vmco/sub-key/:player_id (revoke) ──');
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
  dbExec(`DELETE FROM reward_claims WHERE player_id = '${playerId}'`);
  dbExec(`DELETE FROM player_rewards WHERE player_id = '${playerId}'`);
  dbExec(`DELETE FROM players WHERE id = '${playerId}'`);
  console.log('  ✓ Test player + rewards + claims cleaned up');

  console.log('\n══════════════════════════════════════════════════════════');
  console.log(' ✅ ALL 10 VMCO INTEGRATION TESTS PASSED');
  console.log('══════════════════════════════════════════════════════════');
})();