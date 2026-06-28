const fs = require('fs');
const path = require('path');
const envPath = path.join(__dirname, '..', 'economy.env');
const envContent = fs.readFileSync(envPath, 'utf8');
const envLines = envContent.split('\n');
function getEnv(name) {
  const line = envLines.find(l => l.startsWith(name + '='));
  return line ? line.substring(name.length + 1).trim() : '';
}

const { createServer } = require('../service.js');
const Stripe = require('stripe');
const http = require('http');

(async () => {
  process.env.STRIPE_SECRET_KEY=***  process.env.STRIPE_WEBHOOK_SECRET=***  process.env.ECONOMY_AUTH_ENFORCED='***';

  const server = createServer({ port: 8798, host: '127.0.0.1', dbPath: ':memory:' });
  await server.start();

  const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
  const ts = Math.floor(Date.now() / 1000);
  const payload = JSON.stringify({
    id: 'evt_cmp_' + Date.now(), object: 'event', api_version: '2024-06-20',
    type: 'checkout.session.completed',
    data: { object: {
      metadata: { advertiser_id: 'cmp-adv-003', amount_micros: '6000000' },
      customer_details: { email: 'cmp@test.local' },
    }}, created: ts,
  });
  const sig = stripe.webhooks.generateTestHeaderString({
    payload, secret: process.env.STRIPE_WEBHOOK_SECRET, timestamp: ts,
  });

  const line = 'KEY_LEN=' + process.env.STRIPE_SECRET_KEY.length + ' WEBHOOK_LEN=' + process.env.STRIPE_WEBHOOK_SECRET.length + '\n';

  // Test A: inject
  const injectRes = await server.app.inject({
    method: 'POST', url: '/portal/webhooks/stripe',
    headers: { 'Content-Type': 'application/json', 'stripe-signature': sig },
    payload: payload,
  });
  const result = line + 'INJECT: ' + injectRes.statusCode + ' - ' + injectRes.body + '\n';

  // Test B: HTTP round-trip
  const httpRes = await new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port: 8798, path: '/portal/webhooks/stripe', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'stripe-signature': sig, 'Content-Length': Buffer.byteLength(payload) },
    }, (res) => {
      let b = '';
      res.on('data', c => b += c);
      res.on('end', () => resolve({ status: res.statusCode, body: b }));
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
  fs.writeFileSync('/tmp/cmp_result.txt', result + 'HTTP: ' + httpRes.status + ' - ' + httpRes.body + '\n');
  await server.stop();
})().catch(e => {
  const kl = process.env.STRIPE_SECRET_KEY ? process.env.STRIPE_SECRET_KEY.length : 0;
  const wl = process.env.STRIPE_WEBHOOK_SECRET ? process.env.STRIPE_WEBHOOK_SECRET.length : 0;
  fs.writeFileSync('/tmp/cmp_result.txt', 'KEY_LEN=' + kl + ' WEBHOOK_LEN=' + wl + '\nERROR: ' + e.message + '\n');
});
