const fs = require('fs');
fs.writeFileSync('/tmp/env_check.txt',
  'SK_LEN: ' + process.env.STRIPE_SECRET_KEY.length + '\n' +
  'WS_LEN: ' + process.env.STRIPE_WEBHOOK_SECRET.length + '\n' +
  'WS_VAL: ' + process.env.STRIPE_WEBHOOK_SECRET.substring(0, 20) + '\n' +
  'SK_PREFIX: ' + process.env.STRIPE_SECRET_KEY.substring(0, 7) + '\n'
);
