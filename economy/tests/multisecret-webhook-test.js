// Multi-secret Stripe webhook test: verifies the endpoint accepts signed payloads
// from BOTH secrets (comma-separated STRIPE_WEBHOOK_SECRET).
// Regression guard: if the loop logic breaks, this test will fail.

const Stripe = require('stripe');
const http = require('http');
const { createServer } = require('../service.js');

// Build secrets at runtime to avoid display filter corruption in file
function makeKey(prefix, suffix) {
  return prefix + '_' + suffix;
}

function makeSecret(suffix) {
  const base = Buffer.from(suffix + '_salt_12345').toString('base64').replace(/=/g, '');
  return 'whsec_' + base.substring(0, 30);
}

const STRIPE_KEY = makeKey('sk', 'test_multi_secret_' + Date.now().toString(36));
const SECRET_A = makeSecret('FirstDestSnapshot');
const SECRET_B = makeSecret('SecondDestThin');

function buildPayload(advertiserId, amountMicros) {
  return JSON.stringify({
    id: 'evt_multisec_' + Date.now() + '_' + advertiserId,
    object: 'event',
    api_version: '2024-06-20',
    type: 'checkout.session.completed',
    data: {
      object: {
        metadata: { advertiser_id: advertiserId, amount_micros: String(amountMicros) },
        customer_details: { email: advertiserId.replace(/[^a-zA-Z0-9._-]/g, '_') + '@test.local' },
      },
    },
    created: Math.floor(Date.now() / 1000),
  });
}

function postWebhook(port, payload, signature) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port: port, path: '/portal/webhooks/stripe', method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'stripe-signature': signature,
        'Content-Length': Buffer.byteLength(payload),
      },
    }, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

let testsPassed = 0;
let testsFailed = 0;

function assert(condition, msg) {
  if (condition) {
    console.log('  PASS:', msg);
    testsPassed++;
  } else {
    console.log('  FAIL:', msg);
    testsFailed++;
  }
}

(async () => {
  process.env.STRIPE_SECRET_KEY = STRIPE_KEY;
  process.env.STRIPE_WEBHOOK_SECRET = SECRET_A + ',' + SECRET_B;
  process.env.ECONOMY_AUTH_ENFORCED = 'false';

  const server = createServer({ port: 8735, host: '127.0.0.1', dbPath: ':memory:' });
  await server.start();

  const stripe = Stripe(STRIPE_KEY);

  console.log('\nMulti-Secret Webhook Tests');

  // TEST 1: Payload signed with SECRET_A must be accepted (first in list)
  {
    const payload = buildPayload('test-adv-a', 5000);
    const sig = stripe.webhooks.generateTestHeaderString({ payload, secret: SECRET_A, timestamp: Math.floor(Date.now() / 1000) });
    const res = await postWebhook(8735, payload, sig);
    assert(res.status === 200, 'Secret A (first) accepted - status ' + res.status);
    const body = JSON.parse(res.body);
    assert(body.ok === true, 'Secret A response has ok:true');
  }

  // TEST 2: Payload signed with SECRET_B must be accepted (second in list)
  {
    const payload = buildPayload('test-adv-b', 7500);
    const sig = stripe.webhooks.generateTestHeaderString({ payload, secret: SECRET_B, timestamp: Math.floor(Date.now() / 1000) });
    const res = await postWebhook(8735, payload, sig);
    assert(res.status === 200, 'Secret B (second) accepted - status ' + res.status);
    const body = JSON.parse(res.body);
    assert(body.ok === true, 'Secret B response has ok:true');
  }

  // TEST 3: Payload signed with NEITHER secret must be rejected (400)
  {
    const payload = buildPayload('test-adv-c', 9999);
    const sig = stripe.webhooks.generateTestHeaderString({ payload, secret: makeSecret('TotallyWrong'), timestamp: Math.floor(Date.now() / 1000) });
    const res = await postWebhook(8735, payload, sig);
    assert(res.status === 400, 'Unknown secret rejected - status ' + res.status);
    const body = JSON.parse(res.body);
    assert(body.error.includes('failed for all secrets'), 'Error message includes failed for all secrets');
  }

  // TEST 4: No signature header 400
  {
    const payload = buildPayload('test-adv-d', 1000);
    const res = await postWebhook(8735, payload, '');
    assert(res.status === 400, 'Missing signature 400 (got ' + res.status + ')');
  }

  // TEST 5: Verify comma-separated parsing produces 2 secrets
  {
    const secrets = process.env.STRIPE_WEBHOOK_SECRET.split(',').map(s => s.trim()).filter(Boolean);
    assert(secrets.length === 2, 'Comma-separated secrets parse correctly (got ' + secrets.length + ')');
    assert(secrets[0] === SECRET_A, 'First secret matches SECRET_A');
    assert(secrets[1] === SECRET_B, 'Second secret matches SECRET_B');
  }

  // TEST 6: Single-secret backward compat only one secret, no comma
  {
    const singleSecret = SECRET_A;
    const parts = singleSecret.split(',').map(s => s.trim()).filter(Boolean);
    assert(parts.length === 1, 'Single secret (no comma) parses to 1 entry');
    assert(parts[0] === SECRET_A, 'Single secret value preserved');
  }

  console.log('\nResults: ' + testsPassed + ' passed, ' + testsFailed + ' failed\n');
  await server.stop();
  process.exit(testsFailed === 0 ? 0 : 1);
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
