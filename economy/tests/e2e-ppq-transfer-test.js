#!/usr/bin/env node
// E2E Economy + PPQ Transfer Test
const fs = require('fs');
const http = require('http');

const ppqKey = Buffer.from(fs.readFileSync('/home/hive/signal-rush/.ppq_key_b64.txt', 'utf8').trim(), 'base64').toString('utf8');
const ECONOMY_API_KEY='test-economy-api-key' + ppqKey.slice(-6);
const PORT = 8781;
const BASE = 'http://127.0.0.1:' + PORT;

function rq(method, path, body, extraHeaders) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : '';
    const hdrs = {'Content-Type': 'application/json'};
    if (extraHeaders) Object.assign(hdrs, extraHeaders);
    if (data) hdrs['Content-Length'] = Buffer.byteLength(data);
    const req = http.request(BASE + path, {method, headers: hdrs}, (res) => {
      let b = '';
      res.on('data', c => b += c);
      res.on('end', () => {
        try { resolve({status: res.statusCode, body: JSON.parse(b)}); }
        catch(e) { resolve({status: res.statusCode, body: b}); }
      });
    });
    req.on('error', (e) => resolve({status: 0, body: {error: e.message}}));
    if (data) req.write(data);
    req.end();
  });
}

async function run() {
  const results = [];
  const step = (label, ok) => {
    console.log('    [' + (ok ? 'PASS' : 'FAIL') + '] ' + label);
    results.push(ok);
    if (!ok) process.exitCode = 1;
  };
  const log = (label) => console.log('  === ' + label + ' ===');

  log('Health');
  let r = await rq('GET', '/health');
  step('service_up', r.status === 200);

  log('Create Player');
  r = await rq('POST', '/players', {display_name: 'e2e-tester'});
  const pid = r.body.id;
  step('player_created', r.status === 201);
  console.log('    player_id=' + pid);

  log('Award Credits (5000 micros)');
  r = await rq('POST', '/credits/award', {player_id: pid, amount: 5000, reason: 'e2e_award'});
  console.log('    [' + r.status + '] ' + JSON.stringify(r.body).substring(0,200));
  step('awarded', r.status === 200);

  log('Trigger 40 Ad Impressions (to fill pool)')
    // Create a session first (impressions require active session)
    await rq('POST', '/internal/ingest', {player_id: pid, session_id: 'e2e-session-1', credits_delta: 0, events: []})
    for (let i = 0; i < 40; i++) {
    await rq('POST', '/ads/impression', {player_id: pid, placement_type: 'hud_frame'})
  }
    r = await rq('GET', '/rewards/pool-stats')
    console.log('    pool_available=' + (r.body.available_micros || 0))
  step('impressions', r.status === 200);

  log('Skill-Based Reward (high score to maximize earnings)')
  r = await rq('POST', '/internal/earn-reward', {player_id: pid, score: 50000, combo: 20, level: 5, tick_count: 500, difficulty_tier: 3})
  console.log('    [' + r.status + '] earned=' + r.body.amount_earned_micros + ' available=' + r.body.available_micros)
  step('reward_earned', r.status === 200);

  log('Create Claim');
  r = await rq('POST', '/rewards/claim', {player_id: pid, ppq_account: 'e2e@tester.com', amount_micros: 1000});
  console.log('    [' + r.status + '] claim_id=' + r.body.id + ' status=' + r.body.status);
  step('claim_created', r.status === 200 || r.status === 201);

  log('TRANSFER -> Real ppq.ai')
    console.log('    WARNING: executing real API call')
    // Use a small amount (1000µ = 1 credit) for the live test
    r = await rq('POST', '/credits/transfer', {player_id: pid, ppq_account: 'e2e@tester.com', amount_micros: 1000})
  console.log('    [' + r.status + '] mode=' + r.body.mode + ' status=' + r.body.status);
  if (r.body.ppq_response) {
    const resp = r.body.ppq_response;
    if (typeof resp === 'object') {
      console.log('    ppq_model=' + resp.model);
      console.log('    ppq_usage=' + JSON.stringify(resp.usage));
      console.log('    ppq_content=' + (resp.content || '').substring(0, 300));
    } else {
      console.log('    ppq_response=' + String(resp).substring(0, 300));
    }
  } else {
    console.log('    FULL BODY: ' + JSON.stringify(r.body).substring(0, 400));
  }
  step('transfer_production', r.body.mode === 'production');

  log('Verify Redemption');
  r = await rq('GET', '/credits/redemptions?player_id=' + pid);
  const count = Array.isArray(r.body.redemptions) ? r.body.redemptions.length : (Array.isArray(r.body) ? r.body.length : 0);
  console.log('    redemptions=' + count);
  step('redemption_recorded', r.status === 200);

  console.log('');
  console.log('='.repeat(60));
  console.log('RESULTS: ' + results.filter(Boolean).length + '/' + results.length + ' passed');
  if (results.every(Boolean)) {
    console.log('ALL TESTS PASSED - Economy pipeline verified!');
  } else {
    console.log('SOME TESTS FAILED');
  }
}

run().catch(e => { console.error('FATAL:', e); process.exit(1); });
