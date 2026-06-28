const Stripe = require('stripe');
const http = require('http');
const fs = require('fs');

(async () => {
  const stripe = Stripe(process.env.SK);
  const ts = Math.floor(Date.now() / 1000);
  const payload = JSON.stringify({
    id: 'evt_dbg', object: 'event', api_version: '2024-06-20',
    type: 'checkout.session.completed',
    data: { object: {
      metadata: { advertiser_id: 'dbg-adv', amount_micros: '8000000' },
      customer_details: { email: 'dbg@test.local' },
    }}, created: ts,
  });
  const sig = stripe.webhooks.generateTestHeaderString({
    payload, secret: process.env.WS, timestamp: ts,
  });

  // Also verify locally
  try {
    const localEvt = stripe.webhooks.constructEvent(payload, sig, process.env.WS);
    fs.appendFileSync('/tmp/debug_result.txt', 'LOCAL_VERIFY: OK type=' + localEvt.type + '\n');
  } catch(e) {
    fs.appendFileSync('/tmp/debug_result.txt', 'LOCAL_VERIFY: FAIL ' + e.message + '\n');
  }

  const res = await new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port: 8781, path: '/portal/webhooks/stripe', method: 'POST',
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

  // Test debug endpoint
  const debugRes = await new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port: 8781, path: '/debug/rawbody', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'stripe-signature': sig, 'Content-Length': Buffer.byteLength(payload) },
    }, (res) => {
      let b = '';
      res.on('data', c => b += c);
      res.on('end', () => resolve(JSON.parse(b)));
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });

  fs.appendFileSync('/tmp/debug_result.txt',
    'WEBHOOK_STATUS: ' + res.status + '\n' +
    'RAWBODY_LEN: ' + (debugRes.rawBody?.length || 'undefined') + '\n' +
    'RAWBODY_MATCH: ' + (debugRes.rawBody === payload) + '\n' +
    'BODY_KEYS: ' + JSON.stringify(Object.keys(debugRes.body || {})) + '\n'
  );
})().catch(e => {
  fs.appendFileSync('/tmp/debug_result.txt', 'ERROR: ' + e.message + '\n');
});
