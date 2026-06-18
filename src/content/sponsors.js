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

// ─── Signal Rush Game Logo (always constant) ──────────────────────
// Compact "SGNLRUSH" ASCII art — the game's identity mark.
// Fits within 76-char inner width. NEVER replaced by sponsor content.
const GAME_LOGO = [
  '███████╗ ██████╗ ███╗   ██╗██╗     ██████╗ ██╗   ██╗███████╗██╗  ██╗',
  '██╔════╝██╔════╝ ████╗  ██║██║     ██╔══██╗██║   ██║██╔════╝██║  ██║',
  '███████╗██║  ███╗██╔██╗ ██║██║     ██████╔╝██║   ██║███████╗███████║',
  '╚════██║██║   ██║██║╚██╗██║██║     ██╔══██╗██║   ██║╚════██║██╔══██║',
  '███████║╚██████╔╝██║ ╚████║███████╗██║  ██║╚██████╔╝███████║██║  ██║',
  '╚══════╝ ╚═════╝ ╚═╝  ╚═══╝╚══════╝╚═╝  ╚═╝ ╚═════╝ ╚══════╝╚═╝  ╚═╝',
];

// Compact version for HUD header during gameplay
const GAME_LOGO_COMPACT = 'SIGNAL RUSH';

const CAMPAIGNS = [
  {
    id: 'usp-x-temple-works',
    brand: 'USP × Temple Works',
    rotatingLabels: [
      'Presented by Temple Works',
      'Powered by USP',
      'Built by Temple Works × USP',
    ],
    // Default sponsor logo (used when no client campaign is active).
    // Shown in the ad placement area, NOT in the game branding area.
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

// Game logo — always the Signal Rush game logo.
// This is NEVER replaced by sponsor content. The top header of the menu
// always shows the game's own branding.
function getGameLogo() {
  return GAME_LOGO;
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

// ─── Developer Brand (always constant) ─────────────────────────────
// The developer credit is separate from the sponsor. No matter which
// campaign is active, the footer always reads "© 2026 USP × TEMPLE WORKS".
const DEVELOPER = {
  brand: 'USP × Temple Works',
  spacedBrand: 'U S P   ×   T E M P L E   W O R K S',
};

function getDeveloper() {
  return DEVELOPER;
}

function setActiveCampaigns(campaigns) {
  if (campaigns && campaigns.length > 0) {
    const first = campaigns[0];
    // Check if this is an API-format campaign (has creatives array)
    // or an internal-format campaign (has logoFull directly)
    if (first.creatives !== undefined) {
      // API format — convert to internal sponsor format
      activeCampaign = apiCampaignToSponsor(first);
    } else {
      // Internal format — merge with defaults
      activeCampaign = {
        ...CAMPAIGNS[0],
        ...first,
        rotatingLabels: first.rotatingLabels || CAMPAIGNS[0].rotatingLabels,
      };
    }
  } else {
    // Empty array or null → reset to static default
    activeCampaign = null;
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
 * Uses the /api/game/campaigns endpoint which includes approved creatives.
 * @returns {Promise<object[]|null>} Array of campaign objects with creatives, or null on failure.
 */
function fetchActiveCampaigns() {
  return new Promise((resolve) => {
    const url = new URL(`${getEconomyBaseUrl()}/api/game/campaigns`);
    const req = http.request({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
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
 * Generate a 3-line ASCII block letter from a single character.
 * Used for live campaign logos when no custom ASCII art is uploaded.
 * Covers A-Z with recognizable block-letter shapes.
 */
function generateLogoFromChar(ch) {
  const logos = {
    A: ['█▀█', '█▀█', '▀ ▀'],
    B: ['█▀▄', '█▀▄', '▀▀ '],
    C: ['█▀▀', '█  ', '▀▀▀'],
    D: ['█▀▄', '█ █', '▀▀▀'],
    E: ['█▀▀', '█▀▀', '▀▀▀'],
    F: ['█▀▀', '█▀▀', '▀  '],
    G: ['█▀▀', '█ █', '▀▀▀'],
    H: ['█ █', '█▀█', '▀ ▀'],
    I: ['▀█▀', ' █ ', '▀▀▀'],
    J: ['  █', '█ █', '▀▀ '],
    K: ['█ ▄', '█▀ ', '▀ ▀'],
    L: ['█  ', '█  ', '▀▀▀'],
    M: ['█▄█', '█ █', '▀ ▀'],
    N: ['█▄█', '█ █', '▀ ▀'],
    O: ['█▀█', '█ █', '▀▀▀'],
    P: ['█▀█', '█▀▀', '▀  '],
    Q: ['█▀█', '█ █', '▀▀█'],
    R: ['█▀█', '█▀▄', '▀ ▀'],
    S: ['█▀▀', '▀▀█', '▀▀▀'],
    T: ['▀█▀', ' █ ', ' ▀ '],
    U: ['█ █', '█ █', '▀▀▀'],
    V: ['█ █', '█ █', ' ▀ '],
    W: ['█ █', '█▄█', '▀ ▀'],
    X: ['█ █', ' ▀ ', '▀ ▀'],
    Y: ['█ █', ' ▀ ', ' ▀ '],
    Z: ['▀▀█', ' ▄ ', '█▀▀'],
  };
  return logos[ch] || logos['S'];
}

/**
 * Convert an API campaign object to the internal sponsor format.
 * The economy service stores campaigns with different field names than
 * the game's internal format. This bridges the gap.
 */
function apiCampaignToSponsor(apiCampaign) {
  const brand = apiCampaign.brand_name || apiCampaign.name || 'Sponsor';
  const firstChar = brand.charAt(0).toUpperCase();
  // Extract uploaded creatives (if any) from the campaign data.
  // creatives[] has { type: 'logo'|'label'|'interstitial', content: any }
  const creatives = apiCampaign.creatives || [];
  const logoCreative = creatives.find(c => c.type === 'logo');
  const labelCreative = creatives.find(c => c.type === 'label');
  const interstitialCreative = creatives.find(c => c.type === 'interstitial');

  // Use uploaded logo art if available, otherwise generate from first letter.
  // logoCreative.content can be:
  //   - { lines: string[] } (from economy service creative upload)
  //   - string[] (array of ASCII art lines, legacy)
  //   - string (single-line logo, wrap in array)
  let logoFull;
  if (logoCreative) {
    const lc = logoCreative.content;
    if (lc && typeof lc === 'object' && !Array.isArray(lc) && Array.isArray(lc.lines)) {
      logoFull = lc.lines; // economy service format: { lines: [...] }
    } else if (Array.isArray(lc)) {
      logoFull = lc; // legacy: direct array
    } else {
      logoFull = [String(lc)]; // fallback: wrap in array
    }
  } else {
    logoFull = generateLogoFromChar(firstChar);
  }

  // Use uploaded compact logo if available
  const logoCompact = labelCreative
    ? (typeof labelCreative.content === 'string' ? labelCreative.content : labelCreative.content?.text || `[ ${brand} ]`)
    : `[ ${brand} ]`;

  // Use uploaded interstitial content if available
  const interstitial = interstitialCreative
    ? {
        headline: interstitialCreative.content.headline || 'This run was powered by',
        body: interstitialCreative.content.body || `${brand} — advertising in Signal Rush.`,
        cta: interstitialCreative.content.cta || `Campaign: ${apiCampaign.name || 'Live'}`,
      }
    : {
        headline: 'This run was powered by',
        body: `${brand} — advertising in Signal Rush.`,
        cta: `Campaign: ${apiCampaign.name || 'Live'}`,
      };

  return {
    id: apiCampaign.id || 'live-campaign',
    brand,
    rotatingLabels: [
      `Presented by ${brand}`,
      `Powered by ${brand}`,
      `${brand} — Signal Rush`,
    ],
    logoFull,
    logoCompact,
    interstitial,
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
  GAME_LOGO,
  GAME_LOGO_COMPACT,
  CAMPAIGN,
  CAMPAIGNS,
  getActiveCampaign,
  getRotatingLabels,
  getLabel,
  getCompactLogo,
  getFullLogo,
  getGameLogo,
  getInterstitial,
  getPresentedBy,
  getCampaign,
  getDeveloper,
  setActiveCampaigns,
  fetchActiveCampaigns,
  apiCampaignToSponsor,
  SPONSOR_CONTENT,
};
