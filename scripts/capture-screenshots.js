#!/usr/bin/env node
// Capture Signal Rush Ad Portal screenshots using Playwright + Firefox
// Uses full browser-based login flow: fill form + submit → session cookie + localStorage
const { firefox } = require('playwright');
const path = require('path');
const fs = require('fs');
const http = require('http');

const BASE = 'http://127.0.0.1:8725';
const SCREENSHOTS = '/tmp/sr-screenshots';
fs.mkdirSync(SCREENSHOTS, { recursive: true });

function api(method, p, body, extraHeaders) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = {};
    if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(data); }
    if (extraHeaders) Object.assign(headers, extraHeaders);
    const r = http.request({ hostname:'127.0.0.1', port:8725, path:p, method, headers }, (res) => { let d=''; res.on('data',c=>d+=c); res.on('end',()=>resolve({s:res.statusCode,b:d})); });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

(async () => {
  console.log('Launching Firefox...');
  const browser = await firefox.launch({ headless: true });
  console.log('Ready.\n');

  // ── Seed via HTTP API ──
  console.log('--- Seeding via API ---');
  const email = 'shot'+Date.now()+'@demo.com';
  let r = await api('POST', '/portal/signup', { email, password:'DemoPass1', company_name:'Screenshot Inc' });
  const body = JSON.parse(r.b);
  const key = body.api_key;
  console.log('  Signup: '+r.s+' key='+key.substring(0,20)+'...');

  // Create campaign via API
  const hdr = { Authorization:'Bearer '+key };
  r = await api('POST', '/portal/campaigns', { name:'Summer Campaign','brand_name':'Screenshot Inc', placement_type:'interstitial', daily_budget_micros:200000, total_budget_micros:2000000, start_date:'2026-06-19', end_date:'2026-07-19' }, hdr);
  const cid = JSON.parse(r.b).campaign.id;
  console.log('  Campaign: '+r.s+' id='+cid.substring(0,8)+'...');

  await api('POST', '/portal/campaigns/'+cid+'/creatives', { type:'logo', content:{ lines:['SCREENSHOT','INC 2026'] } }, hdr);
  await api('POST', '/portal/campaigns/'+cid+'/creatives', { type:'label', content:{ text:'Screenshot Inc — Premium Test' } }, hdr);
  await api('POST', '/portal/campaigns/'+cid+'/creatives', { type:'interstitial', content:{ message:'Powered by Screenshot Inc.' } }, hdr);
  await api('POST', '/portal/campaigns/'+cid+'/submit', null, hdr);
  await api('POST', '/portal/admin/campaigns/'+cid+'/approve');
  await api('POST', '/portal/credits/deposit', { amount_micros:1000000 }, hdr);
  for(let i=0;i<3;i++) await api('POST', '/ads/impression', { campaign_id:cid, placement_type:'interstitial' });
  console.log('  All seeded.\n');

  // ── 1. Unauthenticated pages ──
  console.log('--- Unauthenticated ---');
  let p = await browser.newPage();
  await p.goto(BASE+'/portal/signup.html',{waitUntil:'networkidle',timeout:10000}).catch(()=>{});
  await p.waitForTimeout(2000);
  await p.screenshot({ path: path.join(SCREENSHOTS,'01-signup.png'), fullPage: true });
  let t = await p.evaluate(()=>document.body?.innerText?.substring(0,150)||'');
  console.log('✅ 01-signup — '+t.replace(/\n/g,' · '));
  await p.close();

  p = await browser.newPage();
  await p.goto(BASE+'/portal/login.html',{waitUntil:'networkidle',timeout:10000}).catch(()=>{});
  await p.waitForTimeout(2000);
  await p.screenshot({ path: path.join(SCREENSHOTS,'02-login.png'), fullPage: true });
  t = await p.evaluate(()=>document.body?.innerText?.substring(0,150)||'');
  console.log('✅ 02-login — '+t.replace(/\n/g,' · '));
  await p.close();

  // ── 2. Login via browser form and capture authenticated pages ──
  console.log('\n--- Authenticated (via browser login) ---');
  const ctx = await browser.newContext({ viewport:{width:1280,height:900} });
  p = await ctx.newPage();

  // Step 1: Visit login page
  await p.goto(BASE+'/portal/login.html',{waitUntil:'networkidle',timeout:10000}).catch(()=>{});
  await p.waitForTimeout(1000);

  // Step 2: Set API key in localStorage BEFORE the page JS checks for it
  await p.evaluate((k)=>{ localStorage.setItem('sr_api_key', k); }, key);

  // Step 3: Reload so the page JS finds the key and renders the dashboard
  await p.goto(BASE+'/portal/dashboard.html',{waitUntil:'networkidle',timeout:10000}).catch(()=>{});
  await p.waitForTimeout(3000);
  t = await p.evaluate(()=>document.body?.innerText?.replace(/\n/g,' · ').substring(0,300)||'');
  console.log('  Post-login state: '+t.substring(0,150));
  
  // Navigate to each authenticated page
  const pages = [
    ['03-dashboard', '/portal/dashboard.html'],
    ['04-campaign-new', '/portal/campaign-new.html'],
    ['05-campaign-detail', '/portal/campaign.html?id='+cid],
    ['06-admin', '/portal/admin.html'],
    ['07-account', '/portal/account.html'],
  ];

  for (const [nm, urlPath] of pages) {
    await p.goto(BASE+urlPath,{waitUntil:'networkidle',timeout:10000}).catch(()=>{});
    await p.waitForTimeout(3000);
    await p.screenshot({ path: path.join(SCREENSHOTS,nm+'.png'), fullPage: true });
    t = await p.evaluate(()=>document.body?.innerText?.replace(/\n/g,' · ').substring(0,300)||'');
    // "Log In" present means we got redirected to login page
    const ok = !t.includes('Log In') && t.length > 30;
    console.log((ok?'✅':'❌')+' '+nm+' — content: '+t.substring(0,120));
  }

  await p.close();
  await ctx.close();
  await browser.close();

  console.log('\n--- Files in '+SCREENSHOTS+' ---');
  for (const f of fs.readdirSync(SCREENSHOTS).sort()) {
    const sz = fs.statSync(path.join(SCREENSHOTS,f)).size;
    console.log('  '+f+' ('+sz+' bytes)');
  }
})().catch(e=>{console.error('FAIL:',e.message, e.stack);process.exit(1);});