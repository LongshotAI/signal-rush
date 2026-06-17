// Signal Rush — Sponsor Content & Campaign Data
//
// Single source of truth for ALL sponsor-facing content in the game.
// The engine reads sponsorLabelIndex from state and the renderers read
// content from this file. Nothing hardcoded in renderers.
//
// On startup, the CLI fetches active campaigns from the economy service
// (GET /portal/admin/campaigns?status=active). If the fetch succeeds, the
// first active campaign replaces the static default. If the economy service
// is unreachable, we fall back to the static CAMPAIGNS array — the game
// must always work offline.

const http = require('http');

const CAMPAIGNS = [
  {
    id: 'usp-x-temple-works',
    brand: 'USP × Temple Works',
    rotatingLabels: [
      'Presented by Temple Works',
      'Powered by USP',
      'Built by Temple Works × USP',
    ],
    logoFull: [
      '██╗   ██╗███████╗██████╗ ',
      '██║   ██║██╔════╝██╔══██╗',
      '██║   ██║███████╗██████╔╝',
      '██║   ██║╚════██║██╔═══╝ ',
      '╚██████╔╝███████║██║     ',
      ' ╚═════╝ ╚══════╝╚═╝     ',
    ],
    logoCompact: '[ USP × TW ]',
    interstitial: {
      headline: 'This run was powered by',
      body: 'USP × Temple Works — building the surface Signal Rush runs on.',
      cta: 'Learn more: templeworks.io',
    },
    tagline: 'Premium dev shop. Premium placement.',
    placements: ['hud_frame', 'interstitial'],
    frequencyCapTicks: 40,
    colors: { primary: 'yellow', secondary: 'white' },
  },
];

let activeCampaign = null;

function getActiveCampaign() {
  return activeCampaign || CAMPAIGNS[0];
}

function getRotatingLabels() {
  return getActiveCampaign().rotatingLabels;
}

function getLabel(labelIndex) {
  const labels = getRotatingLabels();
  return labels[labelIndex % labels.length];
}

function getCompactLogo() {
  return getActiveCampaign().logoCompact;
}

function getFullLogo() {
  return getActiveCampaign().logoFull;
}

function getInterstitial() {
  return getActiveCampaign().interstitial;
}

function getPresentedBy() {
  return `Presented by ${getActiveCampaign().brand}`;
}

function getCampaign() {
  return getActiveCampaign();
}

function setActiveCampaigns(campaigns) {
  if (campaigns && campaigns.length > 0) {
    activeCampaign = {
      ...CAMPAIGNS[0],
      ...campaigns[0],
      rotatingLabels: campaigns[0].rotatingLabels || CAMPAIGNS[0].rotatingLabels,
    };
  }
}

// ─── Live Campaign Fetch ───────────────────────────────────────────
//
// Fetches active campaigns from the economy service on game startup.
// Uses a short timeout (2s) so the game doesn't hang if the service is down.
// Falls back to static CAMPAIGNS on any failure — gameplay is never blocked.

const CAMPAIGN_FETCH_TIMEOUT_MS = 2000;

function getEconomyBaseUrl() {
  const port = parseInt(process.env.ECONOMY_PORT) || 8720;
  const host = process.env.ECONOMY_HOST || '127.0.0.1';
  return `http://${host}:${port}`;
}

/**
 * Fetch active campaigns from the economy service.
 * @returns {Promise<object[]|null>} Array of campaign objects, or null on failure.
 */
function fetchActiveCampaigns() {
  return new Promise((resolve) => {
    const url = new URL(`${getEconomyBaseUrl()}/portal/admin/campaigns?status=active`);
    const req = http.request({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method: 'GET',
      timeout: CAMPAIGN_FETCH_TIMEOUT_MS,
    }, (res) => {
      let chunks = '';
      res.on('data', d => chunks += d);
      res.on('end', () => {
        try {
          const data = JSON.parse(chunks);
          if (data.ok && Array.isArray(data.campaigns) && data.campaigns.length > 0) {
            resolve(data.campaigns);
          } else {
            resolve(null);
          }
        } catch {
          resolve(null);
        }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.end();
  });
}

/**
 * Convert an API campaign object to the internal sponsor format.
 * The economy service stores campaigns with different field names than
 * the game's internal format. This bridges the gap.
 */
function apiCampaignToSponsor(apiCampaign) {
  return {
    id: apiCampaign.id || 'live-campaign',
    brand: apiCampaign.brand_name || apiCampaign.name || 'Sponsor',
    rotatingLabels: [
      `Presented by ${apiCampaign.brand_name || 'Sponsor'}`,
      `Powered by ${apiCampaign.brand_name || 'Sponsor'}`,
      `${apiCampaign.brand_name || 'Sponsor'} — Signal Rush`,
    ],
    logoFull: [
      '█▀█ █▀█ █▀█ █▀█',
      '█▀▀ █▀▀ █▄█ █▄█',
      '▀  ▀   ▀   ▀  ',
    ],
    logoCompact: `[ ${apiCampaign.brand_name || 'SPONSOR'} ]`,
    interstitial: {
      headline: 'This run was powered by',
      body: `${apiCampaign.brand_name || 'Sponsor'} — advertising in Signal Rush.`,
      cta: `Campaign: ${apiCampaign.name || 'Live'}`,
    },
    tagline: `Live campaign: ${apiCampaign.name || 'Active'}`,
    placements: [apiCampaign.placement_type || 'hud_frame'],
    frequencyCapTicks: 40,
    colors: { primary: 'yellow', secondary: 'white' },
  };
}

const CAMPAIGN = CAMPAIGNS[0];

// Backward compatibility: render.js and renderCompact.js import SPONSOR_CONTENT
const SPONSOR_CONTENT = {
  get rotatingShellLabels() {
    return getRotatingLabels();
  },
  interstitials: [
    {
      title: 'Sponsor Card',
      body: 'This game session is sponsored. Strong play quality drives stronger partner value.',
    },
    {
      title: 'Partner Surface',
      body: 'Terminal sponsorship should feel premium, visible, and non-intrusive to the run itself.',
    },
  ],
  partnerPitches: {
    templeWorks: 'Long-form, narrative-driven product work — building the surface signal-rush runs on.',
    uglySweaterParty: 'Community-first indie brand — high attention, low-friction placement for short sessions.',
  },
};

module.exports = {
  CAMPAIGN,
  CAMPAIGNS,
  getActiveCampaign,
  getRotatingLabels,
  getLabel,
  getCompactLogo,
  getFullLogo,
  getInterstitial,
  getPresentedBy,
  getCampaign,
  setActiveCampaigns,
  fetchActiveCampaigns,
  apiCampaignToSponsor,
  SPONSOR_CONTENT,
};
