const Stripe = require('stripe');
const http = require('http');
const fs = require('fs');

(async () => {
  const sk = fs.readFileSync('/tmp/sk.txt', 'utf8').trim();
  const ws = fs.readFileSync('/tmp/ws.txt', 'utf8').trim();
  const stripe = Stripe(sk);
  const ts = Math.floor(Date.now() / 1000);
  const payload = JSON.stringify({
    id: 'evt_e2e_' + Date.now(), object: 'event', api_version: '2024-06-20',
    type: 'checkout.session.completed',
    data: { object: {
      metadata: { advertiser_id: 'e2e-adv-001', amount_micros: '8000000' },
      customer_details: { email: 'e2e@test.local' },
    }}, created: ts,
  });
  const sig = stripe.webhooks.generateTestHeaderString({
    payload, secret: ws, timestamp: ts,
  });

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

  // Also test local verification
  let localOk = false;
  try {
    stripe.webhooks.constructEvent(payload, sig, ws);
    localOk = true;
  } catch(e) {}

  fs.writeFileSync('/tmp/e2e_result.txt',
    'KEY_LEN=' + sk.length + '\n' +
    'WEBHOOK_LEN=' + ws.length + '\n' +
    'LOCAL_VERIFY=' + localOk + '\n' +
    'HTTP_STATUS=' + res.status + '\n' +
    'HTTP_BODY=' + res.body + '\n'
  );
})().catch(e => {
  fs.writeFileSync('/tmp/e2e_result.txt', 'ERROR: ' + e.message + '\n');
});
