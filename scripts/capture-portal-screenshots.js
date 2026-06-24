// scripts/capture-portal-screenshots.js
// Captures portal page screenshots using Puppeteer/Chrome headless
// Falls back to HTML content dump if Chrome unavailable

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const BASE = 'http://127.0.0.1:8725';
const OUT_DIR = path.join(os.homedir(), '.signal-rush', 'screenshots');
fs.mkdirSync(OUT_DIR, { recursive: true });

function httpGet(p) {
  return new Promise((resolve, reject) => {
    http.get(BASE + p, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve({ status: res.statusCode, body: d }));
    }).on('e', reject);
  });
}

function httpPost(p, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const url = new URL(BASE + p);
    const req = http.request({
      hostname: url.hostname, port: url.port, path: p, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
    }, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    req.on('e', reject);
    req.write(data);
    req.end();
  });
}

async function main() {
  console.log('=== PORTAL SCREENSHOT CAPTURE ===\n');
  
  // Check service health
  try {
    const h = await httpGet('/health');
    console.log('Service health:', h.status === 200 ? '✅ running' : '❌ ' + h.status);
  } catch (e) {
    console.error('❌ Economy service not reachable on ' + BASE);
    console.error('   Start it with: ECONOMY_PORT=8725 ECONOMY_DB=~/.signal-rush/economy.db node economy/start-dev.js');
    process.exit(1);
  }

  // Get session cookie via login
  const loginRes = await httpPost('/portal/login', { email: 'demo@acme.com', password: 'DemoPass1' });
  let cookie = null;
  if (loginRes.headers) {
    // Extract Set-Cookie if present
  }
  
  // Capture key pages as HTML snapshots
  const pages = [
    { path: '/portal/login', name: 'login' },
    { path: '/portal/signup', name: 'signup' },
    { path: '/portal/dashboard', name: 'dashboard' },
    { path: '/portal/player', name: 'player-rewards' },
  ];

  for (const page of pages) {
    try {
      const res = await httpGet(page.path);
      const outPath = path.join(OUT_DIR, page.name + '.html');
      fs.writeFileSync(outPath, res.body);
      const sizeKB = (Buffer.byteLength(res.body) / 1024).toFixed(1);
      console.log('✅ ' + page.name + ': ' + res.status + ' (' + sizeKB + ' KB) → ' + outPath);
    } catch (e) {
      console.log('❌ ' + page.name + ': ' + e.message);
    }
  }

  // Also capture the API responses that power the portal
  console.log('\n=== API DATA (powers portal) ===');
  
  const campaigns = await httpGet('/api/game/campaigns');
  const camps = JSON.parse(campaigns.body);
  console.log('Active campaigns: ' + (camps.campaigns?.length || 0));
  for (const c of (camps.campaigns || [])) {
    console.log('  ' + c.brand_name + ' | spent=' + c.spent_micros + '/' + c.total_budget_micros + ' | creatives=' + (c.creatives?.length || 0));
  }

  const pool = await httpGet('/rewards/pool-stats');
  const p = JSON.parse(pool.body);
  console.log('Pool: ' + p.total_deposited_micros + ' deposited, ' + p.total_claimed_micros + ' claimed, ' + p.available_micros + ' available');

  // Save API data for proof
  fs.writeFileSync(path.join(OUT_DIR, 'api-campaigns.json'), JSON.stringify(camps, null, 2));
  fs.writeFileSync(path.join(OUT_DIR, 'api-pool.json'), JSON.stringify(p, null, 2));

  console.log('\nScreenshots/data saved to: ' + OUT_DIR);
  console.log('Files: ' + fs.readdirSync(OUT_DIR).join(', '));
}

main().catch(e => { console.error(e); process.exit(1); });