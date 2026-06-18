// tests/live-campaign-test.js
// Signal Rush — Live Campaign Integration Tests
//
// Tests the campaign fetch flow:
// 1. fetchActiveCampaigns() — HTTP fetch from economy service
// 2. apiCampaignToSponsor() — API format to internal format conversion
// 3. End-to-end: fetch → convert → setActiveCampaigns → renderers use live data

const http = require('http');
const path = require('path');

// We test sponsors.js functions directly
const sponsors = require('../src/content/sponsors');

let passed = 0;
let failed = 0;
let mockServer = null;
let mockPort = 18720;

function assert(condition, msg) {
  if (!condition) throw new Error(msg);
}

function test(name, fn) {
  return fn().then(() => {
    passed++;
    console.log(`PASS ${name}`);
  }).catch(e => {
    failed++;
    console.error(`FAIL ${name}: ${e.message}`);
  });
}

// ─── Mock Economy Server ──────────────────────────────────────────

function startMockServer(handler) {
  return new Promise((resolve) => {
    mockServer = http.createServer(handler);
    mockServer.listen(mockPort, '127.0.0.1', () => resolve());
  });
}

function stopMockServer() {
  return new Promise((resolve) => {
    if (mockServer) {
      mockServer.close(() => { mockServer = null; resolve(); });
    } else {
      resolve();
    }
  });
}

// ─── Test Suite ──────────────────────────────────────────────────

async function run() {

  // ── 1. apiCampaignToSponsor Tests ─────────────────────────────

  await test('apiCampaignToSponsor: converts full API campaign', async () => {
    const api = {
      id: 'abc-123',
      name: 'Summer Blast',
      brand_name: 'Acme Corp',
      placement_type: 'hud_frame',
    };
    const result = sponsors.apiCampaignToSponsor(api);
    assert(result.id === 'abc-123', `expected id 'abc-123', got '${result.id}'`);
    assert(result.brand === 'Acme Corp', `expected brand 'Acme Corp', got '${result.brand}'`);
    assert(Array.isArray(result.rotatingLabels), 'rotatingLabels should be array');
    assert(result.rotatingLabels.length === 3, `expected 3 labels, got ${result.rotatingLabels.length}`);
    assert(result.rotatingLabels[0] === 'Presented by Acme Corp', `wrong label: ${result.rotatingLabels[0]}`);
    assert(Array.isArray(result.logoFull), 'logoFull should be array');
    assert(typeof result.logoCompact === 'string', 'logoCompact should be string');
    assert(result.interstitial.headline === 'This run was powered by', 'wrong headline');
    assert(result.interstitial.body.includes('Acme Corp'), 'body should include brand');
    assert(result.placements[0] === 'hud_frame', 'placement should be hud_frame');
  });

  await test('apiCampaignToSponsor: handles missing optional fields', async () => {
    const api = { id: 'minimal' };
    const result = sponsors.apiCampaignToSponsor(api);
    assert(result.brand === 'Sponsor', `expected 'Sponsor', got '${result.brand}'`);
    assert(result.rotatingLabels[0] === 'Presented by Sponsor', 'default label wrong');
    assert(result.placements[0] === 'hud_frame', 'default placement should be hud_frame');
  });

  await test('apiCampaignToSponsor: handles empty object', async () => {
    const result = sponsors.apiCampaignToSponsor({});
    assert(result.id === 'live-campaign', `expected 'live-campaign', got '${result.id}'`);
    assert(result.brand === 'Sponsor', 'default brand should be Sponsor');
  });

  // ── 2. fetchActiveCampaigns Tests ─────────────────────────────

  await test('fetchActiveCampaigns: returns campaigns when service responds', async () => {
    await startMockServer((req, res) => {
      if (req.url.startsWith('/api/game/campaigns')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          ok: true,
          campaigns: [
            { id: 'c1', name: 'Test Campaign', brand_name: 'TestCo', placement_type: 'hud_frame' },
          ],
        }));
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    // Override the economy port to point to our mock
    const origPort = process.env.ECONOMY_PORT;
    const origHost = process.env.ECONOMY_HOST;
    process.env.ECONOMY_PORT = String(mockPort);
    process.env.ECONOMY_HOST = '127.0.0.1';

    try {
      const campaigns = await sponsors.fetchActiveCampaigns();
      assert(campaigns !== null, 'campaigns should not be null');
      assert(Array.isArray(campaigns), 'campaigns should be array');
      assert(campaigns.length === 1, `expected 1 campaign, got ${campaigns.length}`);
      assert(campaigns[0].id === 'c1', `expected id 'c1', got '${campaigns[0].id}'`);
      assert(campaigns[0].brand_name === 'TestCo', 'brand_name mismatch');
    } finally {
      process.env.ECONOMY_PORT = origPort;
      process.env.ECONOMY_HOST = origHost;
      await stopMockServer();
    }
  });

  await test('fetchActiveCampaigns: returns null when service is down', async () => {
    // Don't start any server — port 18721 should be unreachable
    const origPort = process.env.ECONOMY_PORT;
    const origHost = process.env.ECONOMY_HOST;
    process.env.ECONOMY_PORT = '18721';
    process.env.ECONOMY_HOST = '127.0.0.1';

    try {
      const campaigns = await sponsors.fetchActiveCampaigns();
      assert(campaigns === null, `expected null, got ${JSON.stringify(campaigns)}`);
    } finally {
      process.env.ECONOMY_PORT = origPort;
      process.env.ECONOMY_HOST = origHost;
    }
  });

  await test('fetchActiveCampaigns: returns null when service returns empty campaigns', async () => {
    await startMockServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, campaigns: [] }));
    });

    const origPort = process.env.ECONOMY_PORT;
    const origHost = process.env.ECONOMY_HOST;
    process.env.ECONOMY_PORT = String(mockPort);
    process.env.ECONOMY_HOST = '127.0.0.1';

    try {
      const campaigns = await sponsors.fetchActiveCampaigns();
      assert(campaigns === null, `expected null for empty campaigns, got ${JSON.stringify(campaigns)}`);
    } finally {
      process.env.ECONOMY_PORT = origPort;
      process.env.ECONOMY_HOST = origHost;
      await stopMockServer();
    }
  });

  await test('fetchActiveCampaigns: returns null when service returns invalid JSON', async () => {
    await startMockServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('not json {{{');
    });

    const origPort = process.env.ECONOMY_PORT;
    const origHost = process.env.ECONOMY_HOST;
    process.env.ECONOMY_PORT = String(mockPort);
    process.env.ECONOMY_HOST = '127.0.0.1';

    try {
      const campaigns = await sponsors.fetchActiveCampaigns();
      assert(campaigns === null, `expected null for invalid JSON, got ${JSON.stringify(campaigns)}`);
    } finally {
      process.env.ECONOMY_PORT = origPort;
      process.env.ECONOMY_HOST = origHost;
      await stopMockServer();
    }
  });

  await test('fetchActiveCampaigns: returns null when service returns ok:false', async () => {
    await startMockServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'unauthorized' }));
    });

    const origPort = process.env.ECONOMY_PORT;
    const origHost = process.env.ECONOMY_HOST;
    process.env.ECONOMY_PORT = String(mockPort);
    process.env.ECONOMY_HOST = '127.0.0.1';

    try {
      const campaigns = await sponsors.fetchActiveCampaigns();
      assert(campaigns === null, `expected null for ok:false, got ${JSON.stringify(campaigns)}`);
    } finally {
      process.env.ECONOMY_PORT = origPort;
      process.env.ECONOMY_HOST = origHost;
      await stopMockServer();
    }
  });

  await test('fetchActiveCampaigns: returns multiple campaigns', async () => {
    await startMockServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ok: true,
        campaigns: [
          { id: 'c1', name: 'First', brand_name: 'BrandA', placement_type: 'hud_frame' },
          { id: 'c2', name: 'Second', brand_name: 'BrandB', placement_type: 'interstitial' },
        ],
      }));
    });

    const origPort = process.env.ECONOMY_PORT;
    const origHost = process.env.ECONOMY_HOST;
    process.env.ECONOMY_PORT = String(mockPort);
    process.env.ECONOMY_HOST = '127.0.0.1';

    try {
      const campaigns = await sponsors.fetchActiveCampaigns();
      assert(campaigns !== null, 'campaigns should not be null');
      assert(campaigns.length === 2, `expected 2 campaigns, got ${campaigns.length}`);
      assert(campaigns[0].brand_name === 'BrandA', 'first brand mismatch');
      assert(campaigns[1].brand_name === 'BrandB', 'second brand mismatch');
    } finally {
      process.env.ECONOMY_PORT = origPort;
      process.env.ECONOMY_HOST = origHost;
      await stopMockServer();
    }
  });

  // ── 3. Integration: fetch → convert → setActiveCampaigns ──────

  await test('integration: fetched campaign replaces static default', async () => {
    // Before setting, should get static campaign
    const before = sponsors.getActiveCampaign();
    assert(before.id === 'usp-x-temple-works', `expected static id, got '${before.id}'`);

    // Simulate what index.js does: fetch → convert → set
    const apiCampaigns = [
      { id: 'live-1', name: 'Live Campaign', brand_name: 'LiveCo', placement_type: 'interstitial' },
    ];
    const sponsorData = apiCampaigns.map((c) => sponsors.apiCampaignToSponsor(c));
    sponsors.setActiveCampaigns(sponsorData);

    const after = sponsors.getActiveCampaign();
    assert(after.id === 'live-1', `expected 'live-1', got '${after.id}'`);
    assert(after.brand === 'LiveCo', `expected 'LiveCo', got '${after.brand}'`);
    assert(after.rotatingLabels[0] === 'Presented by LiveCo', `wrong label: ${after.rotatingLabels[0]}`);

    // Reset for other tests
    sponsors.setActiveCampaigns([]);
  });

  await test('integration: renderers use live campaign after setActiveCampaigns', async () => {
    const { getPresentedBy, getLabel, getCompactLogo, getInterstitial } = sponsors;

    // Set a live campaign
    sponsors.setActiveCampaigns([
      sponsors.apiCampaignToSponsor({ id: 'r1', name: 'Render Test', brand_name: 'RenderCo', placement_type: 'hud_frame' }),
    ]);

    // Verify renderers see the live data
    const presented = getPresentedBy();
    assert(presented.includes('RenderCo'), `getPresentedBy should include RenderCo, got: ${presented}`);

    const label = getLabel(0);
    assert(label.includes('RenderCo'), `getLabel should include RenderCo, got: ${label}`);

    const compact = getCompactLogo();
    assert(compact.includes('RenderCo'), `getCompactLogo should include RenderCo, got: ${compact}`);

    const interstitial = getInterstitial();
    assert(interstitial.body.includes('RenderCo'), `interstitial.body should include RenderCo, got: ${interstitial.body}`);

    // Reset
    sponsors.setActiveCampaigns([]);
  });

  await test('integration: setActiveCampaigns with empty array resets to default', async () => {
    // First set a live campaign
    sponsors.setActiveCampaigns([
      sponsors.apiCampaignToSponsor({ id: 'temp', name: 'Temp', brand_name: 'TempCo', placement_type: 'hud_frame' }),
    ]);
    const before = sponsors.getActiveCampaign();
    assert(before.id === 'temp', `expected 'temp', got '${before.id}'`);

    // Setting empty array should reset to static default
    sponsors.setActiveCampaigns([]);
    const after = sponsors.getActiveCampaign();
    assert(after.id === 'usp-x-temple-works', `expected 'usp-x-temple-works' (reset), got '${after.id}'`);
  });

  // ── 4. Backward Compatibility ─────────────────────────────────

  await test('backward compat: SPONSOR_CONTENT getter still works', async () => {
    const { SPONSOR_CONTENT } = sponsors;
    assert(Array.isArray(SPONSOR_CONTENT.rotatingShellLabels), 'rotatingShellLabels should be array');
    assert(SPONSOR_CONTENT.rotatingShellLabels.length === 3, `expected 3 labels, got ${SPONSOR_CONTENT.rotatingShellLabels.length}`);
  });

  await test('backward compat: CAMPAIGN export is static default', async () => {
    const { CAMPAIGN } = sponsors;
    assert(CAMPAIGN.id === 'usp-x-temple-works', `expected static CAMPAIGN, got '${CAMPAIGN.id}'`);
  });

  await test('backward compat: CAMPAIGNS array is unchanged', async () => {
    const { CAMPAIGNS } = sponsors;
    assert(Array.isArray(CAMPAIGNS), 'CAMPAIGNS should be array');
    assert(CAMPAIGNS.length >= 1, 'CAMPAIGNS should have at least 1 entry');
    assert(CAMPAIGNS[0].id === 'usp-x-temple-works', 'first campaign should be static default');
  });

  // ── Summary ───────────────────────────────────────────────────

  console.log(`\nLive campaign tests: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
