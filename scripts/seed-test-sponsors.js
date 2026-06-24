// scripts/seed-test-sponsors.js
// Seeds owned test sponsor campaigns: USPai.io + Temple LLC
// Direct DB approach — no auth required.
// Run with: node scripts/seed-test-sponsors.js [economy_db_path]

const Database = require('better-sqlite3');
const { randomUUID } = require('crypto');
const path = require('path');
const os = require('os');

const DB_PATH = process.argv[2] || path.join(os.homedir(), '.signal-rush', 'economy.db');
const db = new Database(DB_PATH);

// Import ledger for proper campaign creation
const ledger = require('../economy/ledger');

// ─── Helper: hash key like the service does ─────────────────────
function hashApiKey(raw) {
  const crypto = require('crypto');
  const salt = crypto.randomBytes(64).toString('hex');
  const hash = crypto.createHash('sha256').update(raw + salt).digest('hex');
  return `${hash}:100000:${salt}`;
}

// ─── USPai.io Sponsor ─────────────────────────────────────────────
const uspaiId = randomUUID();
const uspaiApiKey = 'uspai-' + randomUUID().replace(/-/g, '').slice(0, 24);

db.prepare(`
  INSERT INTO advertiser_accounts (id, email, password_hash, company_name, api_key, status, balance_micros, created_at)
  VALUES (?, ?, ?, ?, ?, 'active', ?, datetime('now'))
`).run(uspaiId, 'ads@uspai.io', hashApiKey('uspai-admin-2026'), 'USPai.io', uspaiApiKey, 500000000); // 500K credits

console.log('✅ Created advertiser: USPai.io (id=' + uspaiId.slice(0, 8) + '..., balance=500M µ)');

// USPai.io campaign 1: HUD frame
const uspaiCampaignId = randomUUID();
db.prepare(`
  INSERT INTO campaigns (id, advertiser_id, name, brand_name, status, placement_type, daily_budget_micros, total_budget_micros, spent_micros, daily_spent_micros, daily_spent_date, start_date, end_date, created_at)
  VALUES (?, ?, ?, ?, 'active', 'hud_frame', ?, ?, 0, 0, ?, ?, ?, datetime('now'))
`).run(uspaiCampaignId, uspaiId, 'USPai.io Launch', 'USPai.io', 20000000, 200000000, null, '2026-06-19', '2027-06-19');

// Creatives for USPai.io
const creativeTypes = [
  { type: 'logo', content: { ascii: ['╔═╗╔═╗╔═╗╔═╗╦ ╦╔═╗╦','║ ╦╠═╣╠╣ ╠═╝╚╦╝║ ║║','╚═╝╩ ╩╚  ╩  ╩ ╚═╝╩'], text: 'USPai.io', colors: { primary: 'cyan', secondary: 'white' } } },
  { type: 'label', content: { text: 'Intelligent AI for everyone — USPai.io' } },
  { type: 'interstitial', content: { headline: 'Powered by USPai.io', body: 'Unified Semantic Processing. Built for agents, by agents.', cta: 'Try it at uspai.io' } },
];
for (const ct of creativeTypes) {
  db.prepare(`INSERT INTO creatives (id, campaign_id, type, content_json, status, created_at) VALUES (?, ?, ?, ?, 'approved', datetime('now'))`)
    .run(randomUUID(), uspaiCampaignId, ct.type, JSON.stringify(ct.content));
}
console.log('  ✅ Campaign: USPai.io Launch (status=active, daily=20M, total=200M)');
console.log('  ✅ Creatives: logo + label + interstitial (all approved)');

// ─── Temple LLC Sponsor ───────────────────────────────────────────
const templeId = randomUUID();
const templeApiKey = 'temple-' + randomUUID().replace(/-/g, '').slice(0, 24);

db.prepare(`
  INSERT INTO advertiser_accounts (id, email, password_hash, company_name, api_key, status, balance_micros, created_at)
  VALUES (?, ?, ?, ?, ?, 'active', ?, datetime('now'))
`).run(templeId, 'ads@templellc.com', hashApiKey('temple-admin-2026'), 'Temple LLC', templeApiKey, 750000000); // 750K credits

console.log('\n✅ Created advertiser: Temple LLC (id=' + templeId.slice(0, 8) + '..., balance=750M µ)');

// Temple LLC campaign 1: HUD frame
const templeCampaignId = randomUUID();
db.prepare(`
  INSERT INTO campaigns (id, advertiser_id, name, brand_name, status, placement_type, daily_budget_micros, total_budget_micros, spent_micros, daily_spent_micros, daily_spent_date, start_date, end_date, created_at)
  VALUES (?, ?, ?, ?, 'active', 'hud_frame', ?, ?, 0, 0, ?, ?, ?, datetime('now'))
`).run(templeCampaignId, templeId, 'Temple LLC Brand Push', 'Temple LLC', 15000000, 150000000, null, '2026-06-19', '2027-06-19');

const templeCreativeTypes = [
  { type: 'logo', content: { ascii: ['╔╦╗╦ ╦╔═╗╦  ╔═╗╦  ╦',' ║ ╚╦╝╠═╣║  ║ ║║  ║',' ╩  ╩ ╩ ╩╩═╝╚═╝╩═╝╩'], text: 'Temple LLC', colors: { primary: 'yellow', secondary: 'white' } } },
  { type: 'label', content: { text: 'Built by Temple LLC — Enterprise AI Infrastructure' } },
  { type: 'interstitial', content: { headline: 'This run was powered by', body: 'Temple LLC — enterprise-grade AI infrastructure for agentic systems.', cta: 'Learn more at temple-llc.com' } },
];
for (const ct of templeCreativeTypes) {
  db.prepare(`INSERT INTO creatives (id, campaign_id, type, content_json, status, created_at) VALUES (?, ?, ?, ?, 'approved', datetime('now'))`)
    .run(randomUUID(), templeCampaignId, ct.type, JSON.stringify(ct.content));
}
console.log('  ✅ Campaign: Temple LLC Brand Push (status=active, daily=15M, total=150M)');
console.log('  ✅ Creatives: logo + label + interstitial (all approved)');

// ─── Also create the existing test campaign structure ──────────────
const testAdvertiserId = randomUUID();
const testApiKey = 'test-' + randomUUID().replace(/-/g, '').slice(0, 24);
db.prepare(`
  INSERT INTO advertiser_accounts (id, email, password_hash, company_name, api_key, status, balance_micros, created_at)
  VALUES (?, ?, ?, ?, ?, 'active', ?, datetime('now'))
`).run(testAdvertiserId, 'demo@acme.com', hashApiKey('DemoPass1'), 'Acme Test Corp', testApiKey, 10000000);

const testCampaignId = randomUUID();
db.prepare(`
  INSERT INTO campaigns (id, advertiser_id, name, brand_name, status, placement_type, daily_budget_micros, total_budget_micros, spent_micros, daily_spent_micros, daily_spent_date, start_date, end_date, created_at)
  VALUES (?, ?, ?, ?, 'active', 'hud_frame', ?, ?, 0, 0, ?, ?, ?, datetime('now'))
`).run(testCampaignId, testAdvertiserId, 'Test Campaign', 'Acme Test Corp', 5000000, 50000000, null, '2026-06-19', '2027-06-19');

const testCreativeTypes = [
  { type: 'logo', content: { ascii: ['╔═╗╔═╗╦ ╦╔═╗','║  ║ ║║ ║╚═╗','╚═╝╚═╝╚═╝╚═╝'], text: 'Acme Test', colors: { primary: 'green', secondary: 'white' } } },
  { type: 'label', content: { text: 'Acme Test Corp — Built Different' } },
  { type: 'interstitial', content: { headline: 'Sponsored by', body: 'Acme Test Corp — building the future of testing.', cta: 'Learn more' } },
];
for (const ct of testCreativeTypes) {
  db.prepare(`INSERT INTO creatives (id, campaign_id, type, content_json, status, created_at) VALUES (?, ?, ?, ?, 'approved', datetime('now'))`)
    .run(randomUUID(), testCampaignId, ct.type, JSON.stringify(ct.content));
}
console.log('\n✅ Created test advertiser: Acme Test Corp');
console.log('  ✅ Campaign: Test Campaign (active, daily=5M, total=50M)');

// ─── Summary ──────────────────────────────────────────────────────
console.log('\n═══ SEED SUMMARY ═══');
const advertisers = db.prepare('SELECT company_name, balance_micros FROM advertiser_accounts').all();
const campaignCount = db.prepare('SELECT COUNT(*) as c FROM campaigns WHERE status = ?').get('active');
console.log('Advertisers: ' + advertisers.map(a => a.company_name + ' (' + (a.balance_micros / 1000000).toFixed(1) + 'M µ)').join(', '));
console.log('Active campaigns: ' + campaignCount.c);
console.log('Total advertiser balance: ' + db.prepare('SELECT SUM(balance_micros) as t FROM advertiser_accounts').get().t + ' µ');

// Print IDs for reference
console.log('\nReference IDs:');
console.log('  USPai.io campaign:  ' + uspaiCampaignId);
console.log('  Temple LLC campaign: ' + templeCampaignId);
console.log('  Acme Test campaign:  ' + testCampaignId);

db.close();