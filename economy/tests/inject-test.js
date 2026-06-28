const { createServer } = require('../service.js');
const Stripe = require('stripe');
const fs = require('fs');

(async () => {
  process.env.STRIPE_SECRET_KEY = process.argv[2] || 'sk_liv...8pWV';
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_Etmc9VnPVsi37UjVRP8WCnjaIlGP6uPh';
  process.env.ECONOMY_AUTH_ENFORCED = 'false';

  const server = createServer({ port: 8793, host: '127.0.0.1', dbPath: ':memory:' });
  await server.start();

  const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
  const ts = Math.floor(Date.now() / 1000);
  const payload = JSON.stringify({
    id: 'evt_inject_' + Date.now(),
    object: 'event', api_version: '2024-06-20',
    type: 'checkout.session.completed',
    data: { object: {
      metadata: { advertiser_id: 'inject-adv-001', amount_micros: '4000000' },
      customer_details: { email: 'inject@test.local' },
    }},
    created: ts,
  });
  const sig = stripe.webhooks.generateTestHeaderString({
    payload,
    secret: 'whsec_Etmc9VnPVsi37UjVRP8WCnjaIlGP6uPh',
    timestamp: ts,
  });

  const res = await server.app.inject({
    method: 'POST',
    url: '/portal/webhooks/stripe',
    headers: { 'Content-Type': 'application/json', 'stripe-signature': sig },
    payload: payload,
  });

  fs.writeFileSync('/tmp/inject_result.txt', 'STATUS: ' + res.statusCode + '\nBODY: ' + res.body);
  await server.stop();
})().catch(e => {
  fs.writeFileSync('/tmp/inject_result.txt', 'ERROR: ' + e.message + '\n' + e.stack);
});
