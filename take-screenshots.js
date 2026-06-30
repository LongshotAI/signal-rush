#!/usr/bin/env node
// Visit each portal page and take a screenshot, then close the service
const puppeteer = require('puppeteer');
const http = require('http');
const path = require('path');
const fs = require('fs');

const BASE = 'http://127.0.0.1:8725';
const SCREENSHOTS = '/tmp/sr-portal-screenshots';

// Ensure output dir
fs.mkdirSync(SCREENSHOTS, { recursive: true });

// API key from seed; require env in real use so no API-key-looking value is committed.
const API_KEY = process.env.SIGNAL_RUSH_SCREENSHOT_API_KEY || 'TEST_SCREENSHOT_API_KEY_ONLY';
const CAMPAIGN_ID = '2477d7d7-1862-4ce7-bd47-59a71344b1dd';

async function pageText(url) {
  return new Promise((resolve, reject) => {
    http.get(url, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve(d));
    }).on('error', reject);
  });
}

(async () => {
  const browser = await puppeteer.launch({
    headless: true,
    executablePath: '/home/hive/.cache/puppeteer/chrome/linux-149.0.7827.22/chrome-linux64/chrome',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  const pages = {
    '01-dashboard': '/portal/dashboard',
    '02-login': '/portal/login',
    '03-signup': '/portal/signup',
    '04-campaign-list': '/portal/campaigns',
    '05-campaign-detail': '/portal/campaigns/' + CAMPAIGN_ID,
    '06-admin': '/portal/admin',
  };

  for (const [name, urlPath] of Object.entries(pages)) {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    
    // Set auth for pages that need it
    let storageState = null;
    if (name !== '02-login' && name !== '03-signup' && name !== '06-admin') {
      // For authenticated pages, we need to set the token. The portal uses a session cookie.
      // Let's first login to get a session
      await page.goto(BASE + '/portal/login');
      await page.waitForSelector('input[type="email"]', { timeout: 5000 }).catch(() => {});
      await page.type('input[type="email"]', 'demo@acme.com');
      await page.type('input[type="password"]', 'DemoPass1');
      await page.click('button[type="submit"]');
      await new Promise(r => setTimeout(r, 1000));
    }
    
    await page.goto(BASE + urlPath, { waitUntil: 'networkidle0', timeout: 10000 }).catch(() => {});
    await new Promise(r => setTimeout(r, 1000));
    
    await page.screenshot({ path: path.join(SCREENSHOTS, name + '.png'), fullPage: true });
    console.log('Captured: ' + name);
    await page.close();
  }

  // Also capture the game page text
  console.log('\n=== GAME API ===');
  const gameData = await pageText(BASE + '/api/game/campaigns');
  console.log(gameData);
  
  console.log('\n=== PORTAL HTML SNAPSHOTS ===');
  for (const [name, urlPath] of Object.entries(pages)) {
    console.log(`\n--- ${name} (${urlPath}) ---`);
    let html = await pageText(BASE + urlPath);
    // Strip to the <body> content for brevity
    const bodyMatch = html.match(/<body[^>]*>([\s\S]*)<\/body>/i);
    if (bodyMatch) {
      const text = bodyMatch[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      console.log(text.substring(0, 1500));
    }
  }

  await browser.close();
  console.log('\n✅ Screenshots saved to ' + SCREENSHOTS);
  console.log('Files:');
  for (const f of fs.readdirSync(SCREENSHOTS).sort()) {
    console.log('  ' + f + ' (' + fs.statSync(path.join(SCREENSHOTS, f)).size + ' bytes)');
  }
})().catch(e => { console.error('FAILED:', e.message, e.stack); process.exit(1); });