// End-to-end test: real signed Stripe webhook must be accepted by the service.
// Verifies the rawBody capture (custom JSON parser) preserves exact signed bytes.
// Uses Stripe's own test header generator — does NOT call Stripe's API.

const Stripe = require('stripe');
const http = require('http');
const { createServer } = require('../service.js');

// Use safe placeholder values — Stripe's generateTestHeaderString works with any string.
const FAKE_KEY = 'sk_test_placeholder_for_local_signature_test_only_xxxxx';
const FAKE_SECRET = 'whsec_test_secret_for_local_signature_verification_xxxxx';

(async () => {
  // Inject env BEFORE service touches them.
  process.env.STRIPE_SECRET_KEY = FAKE_KEY;
  process.env.STRIPE_WEBHOOK_SECRET = FAKE_SECRET;

  const server = createServer({ port: 8732, host: '127.0.0.1', dbPath: ':memory:' });
  await server.start();

  // Build a real signed payload using Stripe's test helper.
  const stripe = Stripe(FAKE_KEY);
  const payload = JSON.stringify({
    id: 'evt_test_' + Date.now(),
    object: 'event',
    api_version: '2024-06-20',
    type: 'checkout.session.completed',
    data: { object: { metadata: { advertiser_id: '00000000-0000-0000-0000-000000000000', amount_micros: '0' } } },
    created: Math.floor(Date.now() / 1000),
  });
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = stripe.webhooks.generateTestHeaderString({
    payload, secret: FAKE_SECRET, timestamp,
  });

  const req = http.request({
    hostname: '127.0.0.1', port: 8732, path: '/portal/webhooks/stripe', method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'stripe-signature': signature,
      'Content-Length': Buffer.byteLength(payload),
    },
  }, (res) => {
    let body = '';
    res.on('data', c => body += c);
    res.on('end', () => {
      console.log('STRIPE WEBHOOK STATUS:', res.statusCode);
      console.log('STRIPE WEBHOOK BODY:', body);
      const pass = res.statusCode === 200;
      console.log(pass ? 'PASS: signature verified with rawBody capture' : 'FAIL: signature rejected');
      server.stop().then(() => process.exit(pass ? 0 : 1));
    });
  });
  req.write(payload);
  req.end();
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });