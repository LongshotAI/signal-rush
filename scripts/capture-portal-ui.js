// scripts/capture-portal-ui.js
// Captures portal UI screenshots using Playwright
const { chromium } = require('playwright');
const path = require('path');
const os = require('os');
const fs = require('fs');

const BASE = 'http://127.0.0.1:8725';
const OUT_DIR = path.join(os.homedir(), '.signal-rush', 'screenshots');
fs.mkdirSync(OUT_DIR, { recursive: true });

async function main() {
  console.log('=== PORTAL UI SCREENSHOT CAPTURE ===\n');
  
  let browser;
  try {
    browser = await chromium.launch({ 
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    });
  } catch (e) {
    console.error('❌ Failed to launch Chromium:', e.message);
    console.error('   Run: npx playwright install chromium');
    process.exit(1);
  }

  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();

  const pages = [
    { url: BASE + '/portal/login.html', name: '01-login', waitFor: 'h1' },
    { url: BASE + '/portal/signup.html', name: '02-signup', waitFor: 'h1' },
    { url: BASE + '/portal/dashboard.html', name: '03-dashboard', waitFor: 'h1' },
    { url: BASE + '/portal/campaign-new.html', name: '04-campaign-new', waitFor: 'h1' },
    { url: BASE + '/portal/player.html', name: '05-player-rewards', waitFor: 'h1' },
    { url: BASE + '/portal/admin.html', name: '06-admin', waitFor: 'h1' },
    { url: BASE + '/portal/account.html', name: '07-account', waitFor: 'h1' },
  ];

  for (const p of pages) {
    try {
      await page.goto(p.url, { waitUntil: 'networkidle', timeout: 10000 });
      // Wait for content
      try { await page.waitForSelector(p.waitFor, { timeout: 5000 }); } catch {}
      // Small delay for rendering
      await page.waitForTimeout(500);
      
      const outPath = path.join(OUT_DIR, p.name + '.png');
      await page.screenshot({ path: outPath, fullPage: false });
      const sizeKB = (fs.statSync(outPath).size / 1024).toFixed(1);
      console.log('✅ ' + p.name + ': ' + sizeKB + ' KB → ' + outPath);
    } catch (e) {
      console.log('❌ ' + p.name + ': ' + e.message.slice(0, 80));
    }
  }

  // Also capture the player page with data (simulate a player with rewards)
  try {
    await page.goto(BASE + '/portal/player.html', { waitUntil: 'networkidle', timeout: 10000 });
    // Inject a player ID to show the dashboard
    await page.evaluate(() => {
      localStorage.setItem('sr-player-id', 'demo-player-12345');
      // Trigger input event
      const input = document.getElementById('player-id-input');
      if (input) {
        input.value = 'demo-player-12345';
        input.dispatchEvent(new Event('input'));
      }
    });
    await page.waitForTimeout(1000);
    const outPath = path.join(OUT_DIR, '08-player-with-data.png');
    await page.screenshot({ path: outPath, fullPage: false });
    const sizeKB = (fs.statSync(outPath).size / 1024).toFixed(1);
    console.log('✅ 08-player-with-data: ' + sizeKB + ' KB → ' + outPath);
  } catch (e) {
    console.log('❌ 08-player-with-data: ' + e.message.slice(0, 80));
  }

  await browser.close();
  
  console.log('\nScreenshots saved to: ' + OUT_DIR);
  const files = fs.readdirSync(OUT_DIR).filter(f => f.endsWith('.png'));
  console.log('Files: ' + files.join(', '));
  console.log('Total: ' + files.length + ' screenshots');
}

main().catch(e => { console.error(e); process.exit(1); });