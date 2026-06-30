/**
 * game.js — Signal Rush Canvas Renderer for Telegram Mini App
 *
 * Loads the browser-loadable engine bundle, creates a game instance,
 * and renders it to an HTML canvas at 60 fps with keyboard + touch controls,
 * Telegram Mini App SDK integration, and mode selection.
 */

import engineBundle from '/dist/signal-rush-engine.mjs';
import { initTouchInput, destroyTouchInput, getDPadState } from './touch-input.js';

/**
 * Sanitize user-controlled text before innerHTML insertion.
 * Prevents XSS from sponsor names, creative content, etc.
 * Escapes HTML special characters.
 */
function sanitizeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
import {
  initTelegramMiniApp,
  hapticFeedback,
  showMainButton,
  hideMainButton,
  closeMiniApp,
  isTelegramMode,
} from './telegram-sdk.js';
import { EconomyClient } from './economy-client.js';
import { SessionManager } from './session-manager.js';
import { RedemptionUI } from './redemption-ui.js';

const { createEngine } = engineBundle.default || engineBundle;

// ── Economy Config ────────────────────────────────────────────────────────────

const ECONOMY_BASE_URL = '';

// ── Helpers ────────────────────────────────────────────────────────────────────

// Convert a Telegram user ID to a deterministic UUID v4-format string.
// This ensures the same Telegram user ALWAYS maps to the same UUID,
// so their points, rewards, and history persist across sessions.
function _telegramIdToUuid(telegramId) {
  // Hash the telegram ID into 16 bytes, then format as UUID
  // Simple deterministic approach: pad/hash into 32 hex chars
  const hash = _stableHash(String(telegramId));
  const hex = hash.padStart(32, '0').slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

// Simple stable hash (FNV-1a variant) that gives deterministic output per input
function _stableHash(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0')
    + ((h * 0x12345678) >>> 0).toString(16).padStart(8, '0')
    + ((h * 0x9abcdef0) >>> 0).toString(16).padStart(8, '0')
    + ((h * 0x13579bdf) >>> 0).toString(16).padStart(8, '0');
}


// ── Configuration ────────────────────────────────────────────────────────────

let CANVAS_COLS = 56;   // GAME_CONFIG.width  — reduced on mobile for readability
let CANVAS_ROWS = 28;   // GAME_CONFIG.height
let CELL_SIZE   = 18;     // pixels per grid cell (overridden on mobile)
let CANVAS_W    = 1008;
let CANVAS_H    = 504;

const TICK_MS = 120; // Engine tick rate (ms per engine step)

// Two modes: both use the aiHunt engine underneath (packetHop mode TBD in engine)
const GAME_MODES = ['aiHunt', 'packetHop'];
const GAME_MODE_LABELS = {
  aiHunt:    'AI Hunt',
  packetHop: 'Packet Hop',
};
const GAME_MODE_TAGLINES = {
  aiHunt:    'Dodge AI. Chase pickups. Survive.',
  packetHop: 'Cross the grid. Reach the goal.',
};

// Colours
const isMobile = (typeof window !== 'undefined' && window.innerWidth < 600);
const C = {
  bg:          isMobile ? '#0d0d20' : '#0a0a1a',
  grid:        isMobile ? 'rgba(255,255,255,0.06)' : 'rgba(255,255,255,0.04)',
  gridLine:    isMobile ? 'rgba(255,255,255,0.10)' : 'rgba(255,255,255,0.06)',
  player:      '#00ff88',
  playerGlow:  'rgba(0,255,136,0.35)',
  playerShield:'rgba(0,180,255,0.30)',
  playerTrail: 'rgba(0,255,136,0.15)',
  hazard:      '#ff3355',
  hazardGlow:  'rgba(255,51,85,0.30)',
  hazardPatrol:'#ff8844',
  hazardPatrolGlow:'rgba(255,136,68,0.30)',
  pickup:      '#ffdd44',
  pickupGlow:  'rgba(255,221,68,0.30)',
  pickupPulse: 'rgba(255,221,68,0.12)',
  pickupShield:'#44bbff',
  pickupShieldGlow:'rgba(68,187,255,0.35)',
  hudBg:       'rgba(0,0,0,0.70)',
  hudText:     '#ffffff',
  hudAccent:   '#00ff88',
  hudDanger:   '#ff3355',
  hudWarning:  '#ffdd44',
};

// ── State ────────────────────────────────────────────────────────────────────

let engine = null;
let currentMode = 'aiHunt';
let lastTickTime = 0;
let rafId = null;
let keys = new Set();
let gameOverCooldown = false;

let touchMove = null;

let dpr = 1;
let ctx = null;

let canvasEl = null;
let hudEl   = null;
let modeSelectorEl = null;

// ── Economy State ─────────────────────────────────────────────────────────────

let economyClient = null;
let sessionManager = null;
let redemptionUI = null;
let playerId = null;
let creditBalance = 0;
let _initData = null;
let sponsorBalance = 0;
let lastReceiptResult = null;
let economyOnline = false;
let activeSponsor = null;
let sponsorLogoImage = null;
let interstitialImpressionLogged = false;
let allCampaigns = [];       // All active campaigns for rotation
let campaignRotationIndex = 0;
let campaignRotationTimer = null;
let campaignRefreshTimer = null;

// ── Visual Effects State ──────────────────────────────────────────────────────

let stars = [];
let starsFar = [];
let starfieldFrame = 0;
let scorePopups = []; // {x, y, text, ttl, color}
let _popupsInitialized = false;
let wrapFlash = 0; // frames remaining for wrap-around visual effect
let lastPickupPositions = []; // track pickup positions for popup spawning
let nearMissFlash = 0;        // frames remaining for near-miss flash overlay
let comboScale = 1;           // current combo text scale (1 = normal)
let comboTargetScale = 1;
let froggerDeathFlash = 0;    // frames remaining for death flash (frogger mode)
let froggerLevelFlash = 0;    // frames remaining for level clear flash
let slotFillPulse = 0;        // frames remaining for slot-fill pulse

function initStarfield(count = 60) {
  stars = [];
  starsFar = [];
  for (let i = 0; i < count; i++) {
    stars.push({
      x: Math.random(),
      y: Math.random(),
      r: 0.3 + Math.random() * 1.2,
      speed: 0.2 + Math.random() * 0.6,
      phase: Math.random() * Math.PI * 2,
    });
  }
  // Far layer — smaller, slower, more numerous
  for (let i = 0; i < count * 0.6; i++) {
    starsFar.push({
      x: Math.random(),
      y: Math.random(),
      r: 0.15 + Math.random() * 0.4,
      speed: 0.05 + Math.random() * 0.15,
      phase: Math.random() * Math.PI * 2,
    });
  }
}

function drawStarfield() {
  starfieldFrame++;

  // Far layer (parallax background)
  for (const s of starsFar) {
    const alpha = 0.1 + 0.25 * (0.5 + 0.5 * Math.sin(starfieldFrame * 0.01 * s.speed + s.phase));
    ctx.fillStyle = `rgba(150,180,255,${alpha})`;
    ctx.fillRect(s.x * CANVAS_W, s.y * CANVAS_H, s.r, s.r);
  }

  // Near layer (foreground)
  for (const s of stars) {
    const alpha = 0.15 + 0.5 * (0.5 + 0.5 * Math.sin(starfieldFrame * 0.02 * s.speed + s.phase));
    ctx.fillStyle = `rgba(255,255,255,${alpha})`;
    ctx.fillRect(s.x * CANVAS_W, s.y * CANVAS_H, s.r, s.r);
  }
}

// ── Initialisation ──────────────────────────────────────────────────────────

export async function init(containerSelector = '#game-container') {
  const container = document.querySelector(containerSelector);
  if (!container) {
    throw new Error(`Container "${containerSelector}" not found`);
  }

  // Init economy client before any async Telegram auth callback can use it.
  economyClient = new EconomyClient({ baseUrl: ECONOMY_BASE_URL });

  async function applyTelegramAuth(tgInfo) {
    _initData = tgInfo?.initData || null;

    // Only create a local/dev player after we know Telegram did not provide initData.
    // Do not create a temporary random ID while Telegram auth is still pending.
    if (!_initData) {
      if (!playerId) {
        playerId = crypto.randomUUID();
        economyOnline = false;
        console.log('[SignalRush] Local mode (no Telegram auth), player:', playerId);
      }
      return;
    }

    const authResult = await economyClient.auth(_initData);
    if (authResult.ok && authResult.player) {
      playerId = authResult.player.id;
      creditBalance = authResult.player.balance || 0;
      economyOnline = true;
      console.log('[SignalRush] Economy online, player:', playerId);

      // If auth completes after the engine was created, attach economy features now.
      if (engine && sessionManager && !sessionManager.active) {
        sessionManager.startSession(currentMode, engine.state.seed || Date.now());
      }
      if (!redemptionUI && playerId) {
        redemptionUI = new RedemptionUI();
        redemptionUI.init(economyClient, playerId, creditBalance, _initData);
      }
    } else if (authResult.offline) {
      console.log('[SignalRush] Economy offline');
    }
  }

  // Fire Telegram init immediately but DON'T await it — we want the DOM
  // to render while the SDK/auth/campaigns load in the background.
  // In Telegram WebView, ready() is called synchronously (no network needed).
  const tgPromise = initTelegramMiniApp()
    .then(tgInfo => {
      applyTelegramAuth(tgInfo).catch(err => console.warn('[SignalRush] Telegram auth failed:', err.message));
      return tgInfo;
    })
    .catch(err => {
      console.warn('[SignalRush] Telegram init failed:', err.message);
      applyTelegramAuth({ initData: null }).catch(() => {});
      return { initData: null };
    });

  // Calculate cell size — fill available width, clamp height
  const vw = window.innerWidth || 390;
  const vh = window.innerHeight || 700;

  // Keep engine's native grid dimensions (56×28) — the engine logic uses
  // GAME_CONFIG.width/height for bounds. We just scale cells to fit the screen.
  // Frogger has 22 lanes (y:1-22), all fit within 28 rows.
  CANVAS_COLS = 56;
  CANVAS_ROWS = 28;

  // Reserve room: header(~30) + mode-bar(~28) + HUD(~24) + touch-area(~120)
  // On mobile we CSS-scale the canvas, so we don't need to reserve as much — just the UI chrome
  const uiChrome = vw < 600 ? 82 : 170;
  const availableW = vw - 12;
  const availableH = Math.max(vh - uiChrome, 250);

  if (vw < 600) {
    // On mobile: keep engine's 56×28 grid, compute cell size to fill width
    // Canvas CSS will stretch to fill the wrapper completely
    CELL_SIZE = Math.max(8, Math.floor(availableW / CANVAS_COLS));
    CANVAS_W = CANVAS_COLS * CELL_SIZE;
    CANVAS_H = CANVAS_ROWS * CELL_SIZE;
    // The canvas backing store will be resized to match wrapper in the mobile block below
  } else {
    CELL_SIZE = Math.max(10, Math.min(18, Math.floor(availableW / CANVAS_COLS)));
    let calcH = CANVAS_ROWS * CELL_SIZE;
    if (calcH > availableH) {
      CELL_SIZE = Math.max(8, Math.floor(availableH / CANVAS_ROWS));
      calcH = CANVAS_ROWS * CELL_SIZE;
    }
    CANVAS_W = CANVAS_COLS * CELL_SIZE;
    CANVAS_H = calcH;
  }
  console.log(`[SignalRush] Canvas: ${CANVAS_W}x${CANVAS_H} (${CELL_SIZE}px/cell)`);

  // Init starfield
  initStarfield();

  // Telegram auth continues in the background via applyTelegramAuth().
  // Until it resolves, playerId stays null so we do not create a fake player
  // and accidentally wire rewards/campaigns to the wrong identity.

  // SECURITY: Do NOT use initDataUnsafe for player ID generation.
  // initDataUnsafe is client-controlled and NOT cryptographically verified.
  // Only trust player IDs from server-validated initData (auth endpoint).
  // Falling back to initDataUnsafe would allow session hijacking.

  // Local/dev player fallback is created only after Telegram init resolves with no initData.
  // See applyTelegramAuth() above.

  // Fetch active campaigns — ONLY update sponsor data here.
  // Do NOT touch DOM elements (gameWrapper, canvasEl) in this callback
  // because DOM creation happens synchronously AFTER this await chain.
  economyClient.fetchActiveCampaigns().then(result => {
    if (result.ok && result.campaigns && result.campaigns.length > 0) {
      allCampaigns = result.campaigns;
      const campaignCount = allCampaigns.length;
      let hash = 0;
      const seed = playerId || 'default';
      for (let i = 0; i < seed.length; i++) {
        hash = ((hash << 5) - hash + seed.charCodeAt(i)) | 0;
      }
      campaignRotationIndex = Math.abs(hash) % campaignCount;
      activeSponsor = allCampaigns[campaignRotationIndex];
      console.log('[SignalRush] Active sponsor:', activeSponsor.brand_name, '(' + (campaignRotationIndex + 1) + '/' + campaignCount + ')');
      _updateSponsorBanners();
      _startCampaignRotation();
      // Fetch logo as JSON (canvas-renderable)
      if (activeSponsor.id) {
        economyClient.getCampaignLogo(activeSponsor.id).then(logoResult => {
          if (logoResult.ok && logoResult.content) {
            if (logoResult.content.ascii) {
              sponsorLogoImage = logoResult.content;
            } else if (logoResult.content.text) {
              sponsorLogoImage = logoResult.content;
            }
          }
        }).catch(() => {});
      }
    }
  }).catch(() => {});

  dpr = window.devicePixelRatio || 1;

  // Build DOM — full-screen centered game container
  container.innerHTML = '';

  // Create the centered game wrapper that holds canvas + HUD
  const gameWrapper = document.createElement('div');
  gameWrapper.id = 'game-wrapper';
  gameWrapper.style.position = 'fixed';
  gameWrapper.style.top = '50%';
  gameWrapper.style.left = '50%';
  gameWrapper.style.transform = 'translate(-50%, -50%)';
  gameWrapper.style.display = 'flex';
  gameWrapper.style.flexDirection = 'column';
  gameWrapper.style.alignItems = 'center';
  // On mobile: make game wrapper fill viewport for maximum play area
  if (vw < 600) {
    gameWrapper.style.position = 'relative';
    gameWrapper.style.top = 'auto';
    gameWrapper.style.left = 'auto';
    gameWrapper.style.transform = 'none';
    gameWrapper.style.flex = '1 1 0%';
    gameWrapper.style.minHeight = '0';
    gameWrapper.style.width = '100%';
    gameWrapper.style.justifyContent = 'center';
  }

  canvasEl = document.createElement('canvas');
  canvasEl.width  = CANVAS_W * dpr;
  canvasEl.height = CANVAS_H * dpr;
  canvasEl.style.width  = `${CANVAS_W}px`;
  canvasEl.style.height = `${CANVAS_H}px`;
  canvasEl.style.display = 'block';
  canvasEl.style.borderRadius = '10px';
  canvasEl.style.boxShadow = '0 0 60px rgba(0,255,136,0.12), 0 0 30px rgba(255,51,85,0.08)';
  canvasEl.style.touchAction = 'none';
  // On mobile: canvas fills wrapper completely, no dead space
  if (vw < 600) {
    canvasEl.style.width = '100%';
    canvasEl.style.height = '100%';
    canvasEl.style.objectFit = 'fill';
    canvasEl.style.borderRadius = '0';
    canvasEl.style.boxShadow = 'none';
    gameWrapper.style.borderRadius = '0';
    gameWrapper.style.overflow = 'hidden';
    // Remove container border-radius and overflow clipping on mobile
    container.style.borderRadius = '0';
    container.style.overflow = 'visible';
    container.style.boxShadow = 'none';
    // Remove body padding on mobile for edge-to-edge game
    document.body.style.padding = '0';
  }
  gameWrapper.appendChild(canvasEl);

  // Floating score popups container
  const popupContainer = document.createElement('div');
  popupContainer.id = 'score-popups';
  popupContainer.style.position = 'absolute';
  popupContainer.style.top = '0';
  popupContainer.style.left = '0';
  popupContainer.style.width = '100%';
  popupContainer.style.height = '100%';
  popupContainer.style.pointerEvents = 'none';
  popupContainer.style.zIndex = '20';
  gameWrapper.appendChild(popupContainer);

  ctx = canvasEl.getContext('2d');
  ctx.scale(dpr, dpr);

  // HUD overlay
  hudEl = document.createElement('div');
  const hudPadding = vw < 600 ? '3px 6px' : '6px 10px';
  const hudFontSize = vw < 600 ? '9px' : '11px';
  Object.assign(hudEl.style, {
    position: 'absolute',
    top: '0',
    left: '0',
    right: '0',
    padding: hudPadding,
    display: 'flex',
    flexDirection: 'column',
    gap: '1px',
    fontFamily: "'JetBrains Mono', 'SF Mono', 'Fira Code', monospace",
    fontSize: hudFontSize,
    color: C.hudText,
    background: 'rgba(6,6,15,0.75)',
    backdropFilter: 'blur(4px)',
    WebkitBackdropFilter: 'blur(4px)',
    borderRadius: '0',
    pointerEvents: 'none',
    zIndex: '10',
  });
  gameWrapper.appendChild(hudEl);

  container.appendChild(gameWrapper);
  // On mobile: resize canvas to fill wrapper exactly after DOM layout
  if (vw < 600) {
    // Use rAF to ensure layout has settled before measuring
    // (prevents zero-height rect on first paint in some WebViews)
    requestAnimationFrame(() => {
      const rect = gameWrapper.getBoundingClientRect();
      const targetW = Math.max(300, Math.floor(rect.width));
      const targetH = Math.max(200, Math.floor(rect.height));
      canvasEl.width = targetW * dpr;
      canvasEl.height = targetH * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      canvasEl.style.width = targetW + 'px';
      canvasEl.style.height = targetH + 'px';
      CELL_SIZE = Math.max(6, Math.floor(targetW / CANVAS_COLS));
      CANVAS_W = CANVAS_COLS * CELL_SIZE;
      CANVAS_H = CANVAS_ROWS * CELL_SIZE;
      if (CANVAS_W < targetW) CANVAS_W = targetW;
      if (CANVAS_H < targetH) CANVAS_H = targetH;
      console.log(`[SignalRush] Mobile canvas: ${canvasEl.width}x${canvasEl.height} (${targetW}x${targetH} CSS), grid ${CANVAS_COLS}x${CANVAS_ROWS}, cell ${CELL_SIZE}px`);
    });
  }

  // ── Sponsor Ad Banner (HTML, below canvas — hidden on Mobile during gameplay) ──
  if (activeSponsor && vw >= 600) {
    const primaryColor = activeSponsor.creatives?.find(c => c.type === 'logo')?.content?.colors?.primary || '#ffdd44';
    const brandColors = { cyan: '#00ffff', yellow: '#ffdd44', green: '#00ff88', white: '#ffffff', red: '#ff5555', magenta: '#ff44ff' };
    const accent = brandColors[primaryColor] || primaryColor;
    const label = activeSponsor.creatives?.find(c => c.type === 'label');
    const interstitial = activeSponsor.creatives?.find(c => c.type === 'interstitial');

    let sponsorAd = document.getElementById('sponsor-ad-banner');
    if (!sponsorAd) {
      sponsorAd = document.createElement('div');
      sponsorAd.id = 'sponsor-ad-banner';
      container.appendChild(sponsorAd);
    }
    sponsorAd.innerHTML = `
      <div style="
        display:flex; flex-direction:column; gap:2px;
        padding:8px 12px; margin:4px auto 0;
        max-width:390px; width:calc(100% - 16px);
        background:rgba(0,0,0,0.7); border-radius:8px;
        border:1px solid ${accent}44;
        font-family:'JetBrains Mono','SF Mono',monospace;
      ">
        <div style="display:flex;align-items:center;gap:8px;">
          <span style="color:${accent};font:bold 12px monospace;white-space:nowrap;">${sanitizeHtml(activeSponsor.brand_name)}</span>
          ${interstitial?.content?.headline ? `<span style="color:rgba(255,255,255,0.5);font:10px monospace;">${sanitizeHtml(interstitial.content.headline)}</span>` : ''}
        </div>
        ${interstitial?.content?.body ? `<div style="color:rgba(255,255,255,0.4);font:9px monospace;margin-top:1px;">${sanitizeHtml(interstitial.content.body)}</div>` : ''}
        ${interstitial?.content?.cta ? `<div style="color:${accent};font:bold 10px monospace;margin-top:2px;opacity:0.7;">${sanitizeHtml(interstitial.content.cta)}</div>` : ''}
      </div>
    `;
  }

  // Wire keyboard
  window.removeEventListener('keydown', onKeyDown);
  window.removeEventListener('keyup',   onKeyUp);
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup',   onKeyUp);

  // Handle viewport resize (rotate, expand, etc.)
  window.addEventListener('resize', () => {
    if (!canvasEl) return;
    const newVw = window.innerWidth;
    if (newVw < 600) {
      const rect = gameWrapper.getBoundingClientRect();
      const targetW = Math.floor(rect.width);
      const targetH = Math.floor(rect.height);
      canvasEl.width = targetW * dpr;
      canvasEl.height = targetH * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      canvasEl.style.width = targetW + 'px';
      canvasEl.style.height = targetH + 'px';
      CELL_SIZE = Math.max(6, Math.floor(targetW / CANVAS_COLS));
      CANVAS_W = CANVAS_COLS * CELL_SIZE;
      CANVAS_H = CANVAS_ROWS * CELL_SIZE;
      if (CANVAS_W < targetW) CANVAS_W = targetW;
      if (CANVAS_H < targetH) CANVAS_H = targetH;
    }
  });

  // Init touch input
  initTouchInput(canvasEl, (move) => {
    touchMove = move;
  });

  // Create engine
  currentMode = 'aiHunt';
  _createEngine();

  hideMainButton();

  // Build mode selector
  _buildModeSelector(containerSelector, vw);

  rafId = requestAnimationFrame(loop);

  return engine;
}

// ── Mode selector ───────────────────────────────────────────────────────────

function _buildModeSelector(containerSelector, vw) {
  const container = document.querySelector(containerSelector);
  if (!container) return;

  let bar = document.getElementById('mode-selector-bar');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'mode-selector-bar';
  } else {
    bar.innerHTML = '';
  }

  Object.assign(bar.style, {
    display: 'flex',
    gap: '8px',
    justifyContent: 'center',
    marginBottom: '10px',
    flexWrap: 'wrap',
  });

  // Update subtitle when mode changes
  function updateTagline(mode) {
    const subtitle = document.getElementById('game-subtitle');
    if (subtitle) {
      subtitle.textContent = GAME_MODE_TAGLINES[mode] || 'Dodge noise. Collect signals. Survive.';
    }
  }

  for (const mode of GAME_MODES) {
    const chip = document.createElement('button');
    chip.textContent = GAME_MODE_LABELS[mode] || mode;
    chip.dataset.mode = mode;

    const isActive = mode === currentMode;
    const mobilePadding = vw < 600 ? '3px 10px' : '5px 16px';
    const mobileFontSize = vw < 600 ? '10px' : '12px';
    Object.assign(chip.style, {
      padding: mobilePadding,
      borderRadius: '18px',
      border: isActive ? '1px solid rgba(0,255,136,0.4)' : '1px solid rgba(255,255,255,0.15)',
      background: isActive ? 'rgba(0,255,136,0.15)' : 'rgba(255,255,255,0.05)',
      color: isActive ? '#00ff88' : 'rgba(255,255,255,0.5)',
      fontFamily: "'JetBrains Mono', 'SF Mono', 'Fira Code', monospace",
      fontSize: mobileFontSize,
      cursor: 'pointer',
      transition: 'all 0.2s',
      touchAction: 'manipulation',
      userSelect: 'none',
      WebkitUserSelect: 'none',
    });

    chip.addEventListener('click', () => {
      if (currentMode === mode && engine && !engine.state.gameOver) return;
      currentMode = mode;
      hapticFeedback('light');

      for (const sibling of bar.querySelectorAll('button')) {
        const sa = sibling.dataset.mode === mode;
        sibling.style.background = sa ? 'rgba(0,255,136,0.15)' : 'rgba(255,255,255,0.05)';
        sibling.style.color      = sa ? '#00ff88' : 'rgba(255,255,255,0.5)';
        sibling.style.borderColor = sa ? 'rgba(0,255,136,0.4)' : 'rgba(255,255,255,0.15)';
      }

      updateTagline(mode);
      _createEngine();
    });

    chip.addEventListener('mouseenter', () => {
      if (chip.dataset.mode !== currentMode) {
        chip.style.borderColor = 'rgba(255,255,255,0.3)';
      }
    });
    chip.addEventListener('mouseleave', () => {
      if (chip.dataset.mode !== currentMode) {
        chip.style.borderColor = 'rgba(255,255,255,0.15)';
      }
    });

    bar.appendChild(chip);
  }

  if (container.parentNode) {
    container.parentNode.insertBefore(bar, container);

    // Sponsor banner on menu/home screen
    if (activeSponsor) {
      const primaryColor = activeSponsor.creatives?.find(c => c.type === 'logo')?.content?.colors?.primary || '#ffdd44';
      const brandColors = { cyan: '#00ffff', yellow: '#ffdd44', green: '#00ff88', white: '#ffffff', red: '#ff5555', magenta: '#ff44ff' };
      const accent = brandColors[primaryColor] || primaryColor;
      const label = activeSponsor.creatives?.find(c => c.type === 'label');

      let sponsorBanner = document.getElementById('sponsor-menu-banner');
      if (!sponsorBanner) {
        sponsorBanner = document.createElement('div');
        sponsorBanner.id = 'sponsor-menu-banner';
        container.parentNode.insertBefore(sponsorBanner, container);
      }
      sponsorBanner.innerHTML = `
        <div style="display:flex;align-items:center;gap:8px;padding:4px 10px;margin-bottom:8px;border-radius:6px;background:rgba(0,0,0,0.5);border:1px solid ${accent}33;">
          <span style="color:${accent};font:bold 10px monospace;white-space:nowrap">${sanitizeHtml(activeSponsor.brand_name)}</span>
          ${label?.content?.text ? `<span style="color:rgba(255,255,255,0.45);font:9px monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${sanitizeHtml(label.content.text)}</span>` : ''}
        </div>
      `;
    }
  }
}

function _createEngine() {
  if (typeof createEngine !== 'function') {
    console.error('[SignalRush] Engine bundle not loaded');
    return;
  }

  if (sessionManager && sessionManager.active && engine) {
    sessionManager.endSession(engine.state);
  }

  // Two modes: AI Hunt (aiHunt engine) | Packet Hop (frogger engine)
  const isFrogger = currentMode === 'packetHop';
  const engineMode = currentMode === 'packetHop' ? 'frogger' : currentMode;
  engine = createEngine({ mode: engineMode, seed: Date.now() });
  lastTickTime = 0;
  gameOverCooldown = false;
  touchMove = null;
  lastReceiptResult = null;
  interstitialImpressionLogged = false;
  nearMissFlash = 0;
  comboScale = 1;
  comboTargetScale = 1;
  froggerDeathFlash = 0;
  froggerLevelFlash = 0;
  slotFillPulse = 0;
  hideMainButton();

  sessionManager = new SessionManager();
  if (economyOnline) {
    sessionManager.startSession(currentMode, engine.state.seed || Date.now());
  }

  if (!redemptionUI && playerId) {
    redemptionUI = new RedemptionUI();
    redemptionUI.init(economyClient, playerId, creditBalance, _initData);
  }
}

// ── Keyboard ─────────────────────────────────────────────────────────────────

function onKeyDown(e) {
  keys.add(e.code);
  if (['ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Space'].includes(e.code)) {
    e.preventDefault();
  }
}

function onKeyUp(e) {
  keys.delete(e.code);
}

function currentMove() {
  let x = 0, y = 0;
  if (keys.has('ArrowUp')    || keys.has('KeyW')) y -= 1;
  if (keys.has('ArrowDown')  || keys.has('KeyS')) y += 1;
  if (keys.has('ArrowLeft')  || keys.has('KeyA')) x -= 1;
  if (keys.has('ArrowRight') || keys.has('KeyD')) x += 1;
  if (x === 0 && y === 0) return null;
  return { x, y };
}

// ── Game loop ────────────────────────────────────────────────────────────────

let _submitting = false;

function loop(timestamp) {
  rafId = requestAnimationFrame(loop);

  // Run engine.step() on configured tick cadence
  if (timestamp - lastTickTime >= TICK_MS) {
    lastTickTime = timestamp;

    if (engine) {
      const state = engine.state;

      if (state.gameOver && !gameOverCooldown) {
        gameOverCooldown = true;

        if (!interstitialImpressionLogged && economyOnline && playerId) {
          interstitialImpressionLogged = true;
          economyClient.logAdImpression({
            campaignId: activeSponsor?.id || null,
            playerId,
            placementType: 'interstitial',
          }).catch(() => {});
        }

        if (!_submitting) {
          _submitting = true;
          _submitReceipt().finally(() => { _submitting = false; });
        }

        showMainButton('⚡ Play Again', () => {
          if (_submitting) return;
          _createEngine();
          hideMainButton();
        }, { color: '#00ff88', textColor: '#000000' });

        if (keys.has('Enter') || keys.has('Space')) {
          _createEngine();
          gameOverCooldown = false;
          hideMainButton();
        }
      } else if (!state.gameOver) {
        const healthBefore = state.player.health;
        const pickupsBefore = state.pickups.length;

        let move = currentMove();
        if (!move && touchMove) {
          move = touchMove;
          touchMove = null;
        }
        // Poll D-pad state every tick for continuous movement
        if (!move) {
          move = getDPadState();
        }

        if (sessionManager) {
          sessionManager.recordInput(move, state.tick);
        }

        // Track pickup positions before step (for popup spawn)
        lastPickupPositions = state.pickups.map(p => ({ x: p.x, y: p.y }));

        const prevPX = state.player.x;
        engine.step({ move });

        // Detect Pac-Man wrap (player teleported from one edge to other)
        if (Math.abs(state.player.x - prevPX) > CANVAS_COLS * 0.5) {
          wrapFlash = 8;
        }
        if (wrapFlash > 0) wrapFlash--;

        // Log HUD ad impressions from sponsor_impression engine events
        // This mirrors the CLI's eventBridge.logAdImpression() behavior
        if (economyOnline && playerId && state.lastEvents) {
          const sponsorEvents = state.lastEvents.filter(e => e.type === 'sponsor_impression');
          for (const ev of sponsorEvents) {
            economyClient.logAdImpression({
              campaignId: activeSponsor?.id || null,
              playerId,
              placementType: 'hud_frame',
            }).catch(() => {});
          }
        }

        _detectEvents(healthBefore, pickupsBefore);
      }
    }
  }

  render();
}

function _detectEvents(healthBefore, pickupsBefore) {
  if (!engine) return;
  const state = engine.state;

  // Near miss detection (AI Hunt)
  const nearMissCount = state.lastEvents ? state.lastEvents.filter(e => e.type === 'near_miss').length : 0;
  if (nearMissCount > 0) {
    nearMissFlash = Math.max(nearMissFlash, 6);
  }

  // Shield break detection
  const shieldBlocked = state.lastEvents ? state.lastEvents.filter(e => e.type === 'shield_blocked').length : 0;
  if (shieldBlocked > 0) {
    nearMissFlash = Math.max(nearMissFlash, 4); // subtle flash on shield save
  }

  // Frogger event detection
  if (state.mode === 'frogger') {
    const deathEvents = state.lastEvents ? state.lastEvents.filter(e =>
      e.type === 'player_hop' && false // placeholder — actual death detected by state
    ).length : 0;
    // Detect life loss: old lives > new lives
    if (state.lastFroggerCause) {
      froggerDeathFlash = 15; // red flash for 15 frames
    }
    // Detect level clear
    const levelClears = state.lastEvents ? state.lastEvents.filter(e => e.type === 'level_cleared').length : 0;
    if (levelClears > 0) {
      froggerLevelFlash = 30; // green celebration for 30 frames
    }
    // Detect slot fill
    const slotFills = state.lastEvents ? state.lastEvents.filter(e => e.type === 'home_slot_filled').length : 0;
    if (slotFills > 0) {
      slotFillPulse = 20;
    }
  }

  // Combo scale animation
  if (state.combo > 1) {
    comboTargetScale = 1.2;
  }
  comboScale += (comboTargetScale - comboScale) * 0.3;
  comboTargetScale = 1;

  if (state.pickups.length < pickupsBefore) {
    hapticFeedback('light');
    // Find which pickup was collected (compare arrays)
    const collected = pickupsBefore - state.pickups.length;
    // Use the last known pickup position for popup
    if (lastPickupPositions.length > 0) {
      const pos = lastPickupPositions.pop();
      spawnScorePopup(pos.x, pos.y, state.score > 0 ? Math.max(1, Math.floor(state.score / 10)) : 5);
    }
  }

  if (state.player.health < healthBefore) {
    hapticFeedback('heavy');
  }

  if (state.gameOver) {
    hapticFeedback('error');
  }
}

// ── Economy Receipt ───────────────────────────────────────────────────────────

async function _submitReceipt() {
  if (!sessionManager || !economyOnline || !economyClient) return;

  const receipt = sessionManager.endSession(engine.state);
  if (!receipt) return;

  try {
    const verifyResult = await economyClient.submitReceipt({
      seed: receipt.seed,
      mode: receipt.mode,
      inputs: receipt.inputs,
      claimedScore: receipt.score,
      claimedLevel: receipt.level,
    });

    if (verifyResult.ok && verifyResult.valid) {
      // Credits are ad-funded only — we no longer award gameplay credits.
      // The only redeemable value comes from the 20% ad revenue pool.
      let sponsorMicros = 0;
      try {
        const rewardRes = await economyClient.getRewards(playerId);
        if (rewardRes.ok) sponsorMicros = rewardRes.available_micros || 0;
      } catch {}

      // Also submit session stats for skill-based reward calculation
      economyClient.submitEarnReward({
        playerId,
        score: receipt.score,
        combo: receipt.combo || 0,
        level: receipt.level,
        tickCount: receipt.tickCount || receipt.inputs?.length || 0,
        difficultyTier: receipt.difficultyTier || 0,
      }).catch(() => {});

      sponsorBalance = sponsorMicros;
      lastReceiptResult = { ok: true, creditsEarned: 0, score: receipt.score, sponsorMicros };
    } else {
      lastReceiptResult = { ok: false, reason: 'receipt rejected' };
    }
  } catch (err) {
    console.error('[SignalRush] Receipt submission failed:', err.message);
    lastReceiptResult = { ok: false, reason: err.message };
  }
}

// ── Score Popups (floating +N text on pickup) ────────────────────────────────

function spawnScorePopup(x, y, text, color = '#ffdd44') {
  scorePopups.push({
    x: x * CELL_SIZE + CELL_SIZE / 2,
    y: y * CELL_SIZE + CELL_SIZE / 2,
    text: `+${text}`,
    ttl: 40, // frames
    maxTtl: 40,
    color,
    vy: -1.2, // upward drift
  });
}

function updateAndDrawPopups() {
  for (let i = scorePopups.length - 1; i >= 0; i--) {
    const p = scorePopups[i];
    p.y += p.vy;
    p.ttl--;
    if (p.ttl <= 0) {
      scorePopups.splice(i, 1);
      continue;
    }
    const alpha = p.ttl / p.maxTtl;
    const scale = 1 + (1 - alpha) * 0.5; // grows as it fades
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.font = `bold ${Math.max(10, Math.floor(CELL_SIZE * 0.6 * scale))}px monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = p.color;
    ctx.shadowColor = p.color;
    ctx.shadowBlur = 6;
    ctx.fillText(p.text, p.x, p.y);
    ctx.restore();
  }
}

// ── XP / Rank System ─────────────────────────────────────────────────────────

const RANKS = [
  { name: 'Iron',     min: 0 },
  { name: 'Bronze',   min: 500 },
  { name: 'Silver',   min: 2000 },
  { name: 'Gold',     min: 5000 },
  { name: 'Platinum', min: 15000 },
  { name: 'Diamond',  min: 50000 },
  { name: 'Master',   min: 100000 },
  { name: 'Legend',   min: 250000 },
];

function getRank(score) {
  let rank = RANKS[0];
  for (const r of RANKS) {
    if (score >= r.min) rank = r;
  }
  return rank;
}

function getNextRank(score) {
  for (const r of RANKS) {
    if (score < r.min) return r;
  }
  return null; // already max
}

function getRankProgress(score) {
  const rank = getRank(score);
  const next = getNextRank(score);
  if (!next) return 100;
  return Math.min(100, ((score - rank.min) / (next.min - rank.min)) * 100);
}

// ── Rendering ────────────────────────────────────────────────────────────────

// ── Campaign Rotation ─────────────────────────────────────────────────
// Rotates through active campaigns every 60s so players see different
// sponsors during a long session. Refreshes campaign list every 5 min
// to pick up new approvals or pull out expired/exhausted campaigns.
const CAMPAIGN_ROTATION_INTERVAL_MS = 60_000;
const CAMPAIGN_REFRESH_INTERVAL_MS = 300_000;

function _startCampaignRotation() {
  // Clear any existing timers (safe to call multiple times)
  if (campaignRotationTimer) clearInterval(campaignRotationTimer);
  if (campaignRefreshTimer) clearInterval(campaignRefreshTimer);
  // Rotate active campaign every 60s
  campaignRotationTimer = setInterval(() => {
    if (allCampaigns.length === 0) return;
    campaignRotationIndex = (campaignRotationIndex + 1) % allCampaigns.length;
    activeSponsor = allCampaigns[campaignRotationIndex];
    console.log('[SignalRush] Rotated to:', activeSponsor.brand_name, '(' + (campaignRotationIndex + 1) + '/' + allCampaigns.length + ')');
    _updateSponsorBanners();
    // Fetch fresh logo for new sponsor
    if (activeSponsor.id) {
      economyClient.getCampaignLogo(activeSponsor.id).then(logoResult => {
        if (logoResult.ok && logoResult.content) {
          sponsorLogoImage = logoResult.content;
        }
      }).catch(() => {});
    }
  }, CAMPAIGN_ROTATION_INTERVAL_MS);

  // Refresh campaign list from server every 5 min
  // (picks up new approvals, removes expired/exhausted)
  campaignRefreshTimer = setInterval(() => {
    economyClient.fetchActiveCampaigns().then(result => {
      if (result.ok && result.campaigns && result.campaigns.length > 0) {
        const prevCount = allCampaigns.length;
        allCampaigns = result.campaigns;
        // Adjust index if campaigns shrank
        if (campaignRotationIndex >= allCampaigns.length) {
          campaignRotationIndex = 0;
        }
        activeSponsor = allCampaigns[campaignRotationIndex];
        if (prevCount !== allCampaigns.length) {
          console.log('[SignalRush] Campaign list updated:', prevCount, '→', allCampaigns.length);
        }
        _updateSponsorBanners();
      } else {
        // Server returned empty — clear campaigns, fall back to house ads
        allCampaigns = [];
        activeSponsor = null;
        console.log('[SignalRush] No active campaigns from server');
      }
    }).catch(() => {
      // Network failure — keep current campaigns, will retry in 5 min
    });
  }, CAMPAIGN_REFRESH_INTERVAL_MS);
}

// ── HTML Sponsor Banners (created async when campaigns load) ──────────
function _updateSponsorBanners() {
  if (!activeSponsor) return;
  const primaryColor = activeSponsor.creatives?.find(c => c.type === 'logo')?.content?.colors?.primary || '#ffdd44';
  const brandColors = { cyan: '#00ffff', yellow: '#ffdd44', green: '#00ff88', white: '#ffffff', red: '#ff5555', magenta: '#ff44ff' };
  const accent = brandColors[primaryColor] || primaryColor;
  const interstitial = activeSponsor.creatives?.find(c => c.type === 'interstitial');
  const label = activeSponsor.creatives?.find(c => c.type === 'label');

  // Main ad banner (below canvas during gameplay)
  let sponsorAd = document.getElementById('sponsor-ad-banner');
  if (!sponsorAd) {
    sponsorAd = document.createElement('div');
    sponsorAd.id = 'sponsor-ad-banner';
    const gameContainer = document.querySelector('#game-container');
    if (gameContainer) gameContainer.appendChild(sponsorAd);
    else document.body.appendChild(sponsorAd);
  }
  sponsorAd.innerHTML = `
      <div style="
        display:flex; flex-direction:column; gap:2px;
        padding:8px 12px; margin:4px auto 0;
        max-width:390px; width:calc(100% - 16px);
        background:rgba(0,0,0,0.7); border-radius:8px;
        border:1px solid ${accent}44;
        font-family:'JetBrains Mono','SF Mono',monospace;
      ">
        <div style="display:flex;align-items:center;gap:8px;">
          <span style="color:${accent};font:bold 12px monospace;white-space:nowrap;">${sanitizeHtml(activeSponsor.brand_name)}</span>
          ${interstitial?.content?.headline ? `<span style="color:rgba(255,255,255,0.5);font:10px monospace;">${sanitizeHtml(interstitial.content.headline)}</span>` : ''}
        </div>
        ${interstitial?.content?.body ? `<div style="color:rgba(255,255,255,0.4);font:9px monospace;margin-top:1px;">${sanitizeHtml(interstitial.content.body)}</div>` : ''}
        ${interstitial?.content?.cta ? `<div style="color:${accent};font:bold 10px monospace;margin-top:2px;opacity:0.7;">${sanitizeHtml(interstitial.content.cta)}</div>` : ''}
      </div>
    `;

  // Menu banner (on home screen) — inside container on mobile for proper layout
  let menuBanner = document.getElementById('sponsor-menu-banner');
  if (!menuBanner) {
    menuBanner = document.createElement('div');
    menuBanner.id = 'sponsor-menu-banner';
    if (window.innerWidth < 600) {
      // Inside container, before game-wrapper
      const gameContainer = document.querySelector('#game-container');
      if (gameContainer) gameContainer.insertBefore(menuBanner, gameContainer.firstChild);
      else document.body.appendChild(menuBanner);
    } else {
      const bar = document.getElementById('mode-selector-bar');
      if (bar && bar.parentNode) bar.parentNode.insertBefore(menuBanner, bar.nextSibling);
      else document.body.appendChild(menuBanner);
    }
  }
  menuBanner.innerHTML = `
    <div style="display:flex;align-items:center;gap:8px;padding:4px 10px;margin-bottom:8px;border-radius:6px;background:rgba(0,0,0,0.5);border:1px solid ${accent}33;">
      <span style="color:${accent};font:bold 10px monospace;white-space:nowrap">${sanitizeHtml(activeSponsor.brand_name)}</span>
      ${label?.content?.text ? `<span style="color:rgba(255,255,255,0.45);font:9px monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${sanitizeHtml(label.content.text)}</span>` : ''}
    </div>
  `;
}

// ── Game Over Sponsor Ad (HTML overlay — readable on phone) ──────────
function _showGameOverSponsorAd() {
  if (!activeSponsor) return;
  const primaryColor = activeSponsor.creatives?.find(c => c.type === 'logo')?.content?.colors?.primary || '#ffdd44';
  const brandColors = { cyan: '#00ffff', yellow: '#ffdd44', green: '#00ff88', white: '#ffffff', red: '#ff5555', magenta: '#ff44ff' };
  const accent = brandColors[primaryColor] || primaryColor;
  const interstitial = activeSponsor.creatives?.find(c => c.type === 'interstitial');
  const logo = activeSponsor.creatives?.find(c => c.type === 'logo');

  let overlay = document.getElementById('sponsor-gameover-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'sponsor-gameover-overlay';
    if (window.innerWidth < 600) {
      // Inside container on mobile (part of game layout)
      const gameContainer = document.querySelector('#game-container');
      if (gameContainer) gameContainer.appendChild(overlay);
      else document.body.appendChild(overlay);
    } else {
      const container = document.querySelector('#game-container');
      if (container) container.parentNode.insertBefore(overlay, container.nextSibling);
      else document.body.appendChild(overlay);
    }
  }
  overlay.innerHTML = `
    <div style="
      margin:4px auto 0; padding:10px 14px;
      max-width:390px; width:calc(100% - 16px);
      background:rgba(0,0,0,0.85); border-radius:10px;
      border:1px solid ${accent}66;
      font-family:'JetBrains Mono','SF Mono',monospace;
      text-align:center;
      animation: fadeIn 0.3s ease-out;
    ">
      ${logo?.content?.text ? `<div style="color:${accent};font:bold 14px monospace;margin-bottom:4px;">${sanitizeHtml(logo.content.text)}</div>` : ''}
      <div style="color:${accent};font:11px monospace;margin-bottom:2px;">${interstitial?.content?.headline || 'This round powered by'}</div>
      <div style="color:#ffffff;font:bold 16px monospace;margin-bottom:4px;">${sanitizeHtml(activeSponsor.brand_name)}</div>
      ${interstitial?.content?.body ? `<div style="color:rgba(255,255,255,0.6);font:11px monospace;margin-bottom:4px;">${sanitizeHtml(interstitial.content.body)}</div>` : ''}
      ${interstitial?.content?.cta ? `<div style="color:${accent};font:bold 11px monospace;">${sanitizeHtml(interstitial.content.cta)}</div>` : ''}
    </div>
  `;
  overlay.style.display = 'block';
}

function _hideGameOverSponsorAd() {
  const overlay = document.getElementById('sponsor-gameover-overlay');
  if (overlay) overlay.style.display = 'none';
}

function render() {
  if (!ctx || !engine) return;
  const state = engine.state;
  const G = state;
  const isFrogger = currentMode === 'packetHop';

  // Clear
  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

  // Starfield background
  drawStarfield();

  if (isFrogger) {
    // ── FROGGER RENDER ──────────────────────────────────────
    // Decay effects
    if (froggerDeathFlash > 0) froggerDeathFlash -= 1;
    if (froggerLevelFlash > 0) froggerLevelFlash -= 1;
    if (slotFillPulse > 0) slotFillPulse -= 1;

    drawFroggerLanes(state);

    // Level clear celebration flash
    if (froggerLevelFlash > 0) {
      const lAlpha = 0.08 * (froggerLevelFlash / 30);
      ctx.fillStyle = `rgba(0,255,136,${lAlpha})`;
      ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);
    }

    // Death flash
    if (froggerDeathFlash > 0) {
      const dAlpha = 0.12 * (froggerDeathFlash / 15);
      ctx.fillStyle = `rgba(255,51,85,${dAlpha})`;
      ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);
    }

    // Draw home slots at top
    drawHomeSlots(state);

    // Draw player as frog
    drawFrogPlayer(state);

    // Draw HUD (frogger style)
    drawFroggerHUD(state);

    // Get Ready overlay
    if (state.getReadyTicks > 0 && !state.gameOver) {
      drawGetReady(state);
    }

    // Game-over overlay
    if (state.gameOver) {
      drawFroggerGameOver(state);
      _showGameOverSponsorAd();
    } else {
      _hideGameOverSponsorAd();
    }
  } else {
    // ── AI HUNT RENDER ──────────────────────────────────────
    // Decay near miss flash
    if (nearMissFlash > 0) nearMissFlash -= 1;

    // Draw grid
    drawGrid();

    // Draw border
    drawBorder();

    // Draw hazard telegraphs (warning markers)
    if (state.telegraphs) {
      for (const t of state.telegraphs) {
        const tx = t.x * CELL_SIZE + CELL_SIZE / 2;
        const ty = t.y * CELL_SIZE + CELL_SIZE / 2;
        const tAlpha = 0.15 + 0.15 * Math.sin(Date.now() / 100 + t.ttl);
        const tSize = CELL_SIZE * 0.8;
        // Pulsing X marker
        ctx.strokeStyle = `rgba(255,200,50,${tAlpha})`;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(tx - tSize/2, ty - tSize/2);
        ctx.lineTo(tx + tSize/2, ty + tSize/2);
        ctx.moveTo(tx + tSize/2, ty - tSize/2);
        ctx.lineTo(tx - tSize/2, ty + tSize/2);
        ctx.stroke();
        // Outer warning ring
        ctx.strokeStyle = `rgba(255,200,50,${tAlpha * 0.5})`;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(tx, ty, tSize, 0, Math.PI * 2);
        ctx.stroke();
      }
    }

    // Draw pickups (under player)
    state.pickups.forEach((p) => drawPickup(p));

    // Draw hazards
    state.hazards.forEach((h) => drawHazard(h));

    // Danger zone pulse — subtle ring around player when hazards nearby
    const nearbyHazards = state.hazards.filter(h => {
      const dx = Math.abs(h.x - state.player.x);
      const dy = Math.abs(h.y - state.player.y);
      return dx <= 3 && dy <= 3;
    });
    if (nearbyHazards.length > 0 && !state.gameOver) {
      const dangerIntensity = Math.min(1, nearbyHazards.length * 0.3);
      const dangerPulse = 0.3 + 0.7 * (0.5 + 0.5 * Math.sin(Date.now() / 150));
      const cx = state.player.x * CELL_SIZE + CELL_SIZE / 2;
      const cy = state.player.y * CELL_SIZE + CELL_SIZE / 2;
      const dangerGrad = ctx.createRadialGradient(cx, cy, CELL_SIZE * 1.5, cx, cy, CELL_SIZE * 4);
      dangerGrad.addColorStop(0, `rgba(255,51,85,0)`);
      dangerGrad.addColorStop(0.5, `rgba(255,51,85,${0.06 * dangerIntensity * dangerPulse})`);
      dangerGrad.addColorStop(1, `rgba(255,51,85,0)`);
      ctx.fillStyle = dangerGrad;
      ctx.fillRect(cx - CELL_SIZE * 5, cy - CELL_SIZE * 5, CELL_SIZE * 10, CELL_SIZE * 10);
    }

    // Draw trail
    if (G.trail) {
      ctx.fillStyle = C.playerTrail;
      ctx.fillRect(G.trail.x * CELL_SIZE, G.trail.y * CELL_SIZE, CELL_SIZE, CELL_SIZE);
    }

    // Draw player
    drawPlayer(state.player, G.invulnerable > 0);

    // Near miss flash overlay
    if (nearMissFlash > 0) {
      const flashAlpha = 0.15 * (nearMissFlash / 6);
      ctx.fillStyle = `rgba(0,255,136,${flashAlpha})`;
      ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);
    }

    // HUD
    drawHUD(state);

    // Game-over overlay
    if (state.gameOver) {
      drawGameOver(state);
      // Show HTML sponsor overlay (full-width, readable on phone)
      _showGameOverSponsorAd();
    } else {
      _hideGameOverSponsorAd();
    }
  }

  // Paused overlay (both modes)
  if (G.paused && !state.gameOver) {
    drawPaused();
  }

  // Sponsor badge during gameplay
  if (activeSponsor && !state.gameOver && state.tick > 5) {
    drawSponsorBadge();
  }

  // Floating score popups (drawn last — on top of everything)
  updateAndDrawPopups();
}

function drawGrid() {
  ctx.strokeStyle = C.gridLine;
  ctx.lineWidth = 0.5;
  for (let x = 0; x <= CANVAS_COLS; x++) {
    ctx.beginPath();
    ctx.moveTo(x * CELL_SIZE, 0);
    ctx.lineTo(x * CELL_SIZE, CANVAS_H);
    ctx.stroke();
  }
  for (let y = 0; y <= CANVAS_ROWS; y++) {
    ctx.beginPath();
    ctx.moveTo(0, y * CELL_SIZE);
    ctx.lineTo(CANVAS_W, y * CELL_SIZE);
    ctx.stroke();
  }
}

function drawBorder() {
  // Subtle corner markers instead of hard red box
  const cornerLen = CELL_SIZE * 3;
  const cornerW = 2;
  ctx.strokeStyle = 'rgba(255,51,85,0.35)';
  ctx.lineWidth = cornerW;
  ctx.lineCap = 'round';

  // Top-left corner
  ctx.beginPath();
  ctx.moveTo(cornerLen, CELL_SIZE);
  ctx.lineTo(CELL_SIZE, CELL_SIZE);
  ctx.lineTo(CELL_SIZE, cornerLen);
  ctx.stroke();

  // Top-right corner
  ctx.beginPath();
  ctx.moveTo(CANVAS_W - cornerLen, CELL_SIZE);
  ctx.lineTo(CANVAS_W - CELL_SIZE, CELL_SIZE);
  ctx.lineTo(CANVAS_W - CELL_SIZE, cornerLen);
  ctx.stroke();

  // Bottom-left corner
  ctx.beginPath();
  ctx.moveTo(cornerLen, CANVAS_H - CELL_SIZE);
  ctx.lineTo(CELL_SIZE, CANVAS_H - CELL_SIZE);
  ctx.lineTo(CELL_SIZE, CANVAS_H - cornerLen);
  ctx.stroke();

  // Bottom-right corner
  ctx.beginPath();
  ctx.moveTo(CANVAS_W - cornerLen, CANVAS_H - CELL_SIZE);
  ctx.lineTo(CANVAS_W - CELL_SIZE, CANVAS_H - CELL_SIZE);
  ctx.lineTo(CANVAS_W - CELL_SIZE, CANVAS_H - cornerLen);
  ctx.stroke();

  // Subtle edge lines
  ctx.strokeStyle = 'rgba(255,51,85,0.12)';
  ctx.lineWidth = 0.5;
  ctx.beginPath();
  ctx.moveTo(CELL_SIZE, CELL_SIZE);
  ctx.lineTo(CANVAS_W - CELL_SIZE, CELL_SIZE);
  ctx.moveTo(CELL_SIZE, CANVAS_H - CELL_SIZE);
  ctx.lineTo(CANVAS_W - CELL_SIZE, CANVAS_H - CELL_SIZE);
  ctx.stroke();
}

function drawSponsorBadge() {
  if (!activeSponsor) return;

  // Get interstitial creative for richer display
  const interstitial = activeSponsor.creatives?.find(c => c.type === 'interstitial');
  const label = activeSponsor.creatives?.find(c => c.type === 'label');
  const primaryColor = activeSponsor.creatives?.find(c => c.type === 'logo')?.content?.colors?.primary || '#ffdd44';

  // Color mapping for sponsor brand accents
  const brandColors = { cyan: '#00ffff', yellow: '#ffdd44', green: '#00ff88', white: '#ffffff', red: '#ff5555', magenta: '#ff44ff' };
  const accentColor = brandColors[primaryColor] || primaryColor;

  // Draw branded strip at bottom of playfield
  const barH = 22;
  const barY = CANVAS_H - barH;

  // Semi-transparent background with brand accent border
  ctx.fillStyle = 'rgba(0,0,0,0.75)';
  ctx.fillRect(0, barY, CANVAS_W, barH);
  ctx.fillStyle = accentColor;
  ctx.globalAlpha = 0.6;
  ctx.fillRect(0, barY, CANVAS_W, 1.5);  // top accent line
  ctx.globalAlpha = 1.0;

  // Brand name on left
  ctx.font = 'bold 10px monospace';
  ctx.fillStyle = accentColor;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(activeSponsor.brand_name, 8, barY + barH / 2);

  // Label text on right (the tagline from creative)
  if (label?.content?.text) {
    ctx.font = '9px monospace';
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.textAlign = 'right';
    const maxLabelW = CANVAS_W - 100;
    let labelText = label.content.text;
    // Truncate if too wide
    while (ctx.measureText(labelText).width > maxLabelW && labelText.length > 10) {
      labelText = labelText.slice(0, -4) + '…';
    }
    ctx.fillText(labelText, CANVAS_W - 8, barY + barH / 2);
  }

  // "Sponsored" indicator dot
  ctx.fillStyle = accentColor;
  ctx.globalAlpha = 0.4 + 0.3 * Math.abs(Math.sin(Date.now() / 1500)); // slow pulse
  ctx.beginPath();
  ctx.arc(CANVAS_W - 6, barY + 5, 2, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = 1.0;
}

function drawPlayer(player, invulnerable) {
  const cx = player.x * CELL_SIZE + CELL_SIZE / 2;
  const cy = player.y * CELL_SIZE + CELL_SIZE / 2;
  const r = CELL_SIZE * 0.42;

  // Shield ring (when player has shield charges)
  if (player.shield > 0) {
    const shieldPulse = 0.7 + 0.3 * Math.sin(Date.now() / 250);
    ctx.beginPath();
    ctx.arc(cx, cy, r * 1.5, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(0,180,255,${0.25 * shieldPulse})`;
    ctx.lineWidth = 2.5;
    ctx.stroke();
    // Inner shield glow
    const shieldGlow = ctx.createRadialGradient(cx, cy, r * 0.5, cx, cy, r * 1.8);
    shieldGlow.addColorStop(0, 'rgba(0,180,255,0.08)');
    shieldGlow.addColorStop(1, 'rgba(0,180,255,0)');
    ctx.fillStyle = shieldGlow;
    ctx.fillRect(cx - r * 2.5, cy - r * 2.5, r * 5, r * 5);
  }

  // Glow
  const glow = ctx.createRadialGradient(cx, cy, r * 0.3, cx, cy, r * 2.2);
  glow.addColorStop(0, C.playerGlow);
  glow.addColorStop(1, 'rgba(0,255,136,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(cx - r * 2.5, cy - r * 2.5, r * 5, r * 5);

  // Wrap flash effect (Pac-Man teleport sparkle)
  if (wrapFlash > 0) {
    const flashAlpha = wrapFlash / 8;
    const flashR = r * (1.5 + (8 - wrapFlash) * 0.3);
    ctx.beginPath();
    ctx.arc(cx, cy, flashR, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(0,255,200,${flashAlpha * 0.6})`;
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  // Body
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = invulnerable
    ? `rgba(0,255,136,${0.5 + 0.5 * Math.sin(Date.now() / 80)})`
    : C.player;
  ctx.fill();

  // Direction indicator
  if (engine.state.lastMove) {
    const mx = engine.state.lastMove.x;
    const my = engine.state.lastMove.y;
    const eyeOffX = mx * r * 0.35;
    const eyeOffY = my * r * 0.35;
    ctx.beginPath();
    ctx.arc(cx + eyeOffX, cy + eyeOffY, r * 0.25, 0, Math.PI * 2);
    ctx.fillStyle = '#000';
    ctx.fill();
  }
}

function drawHazard(h) {
  const cx = h.x * CELL_SIZE + CELL_SIZE / 2;
  const cy = h.y * CELL_SIZE + CELL_SIZE / 2;
  const r = CELL_SIZE * 0.38;
  const pulse = 0.9 + 0.1 * Math.sin(Date.now() / 200 + h.x);

  // Patrol hazards are orange, homing are red
  const isPatrol = h.behavior === 'patrol';
  const hazardColor = isPatrol ? C.hazardPatrol : C.hazard;
  const hazardGlowCol = isPatrol ? C.hazardPatrolGlow : C.hazardGlow;
  const hazardShape = isPatrol ? 'square' : 'diamond';

  // Glow
  const glow = ctx.createRadialGradient(cx, cy, r * 0.2 * pulse, cx, cy, r * 2 * pulse);
  glow.addColorStop(0, hazardGlowCol);
  glow.addColorStop(1, 'rgba(255,51,85,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(cx - r * 2.5 * pulse, cy - r * 2.5 * pulse, r * 5 * pulse, r * 5 * pulse);

  // Shape
  ctx.fillStyle = hazardColor;
  if (hazardShape === 'square') {
    ctx.fillRect(cx - r * 0.65, cy - r * 0.65, r * 1.3, r * 1.3);
  } else {
    // Diamond (existing)
    ctx.beginPath();
    ctx.moveTo(cx, cy - r * pulse);
    ctx.lineTo(cx + r * pulse, cy);
    ctx.lineTo(cx, cy + r * pulse);
    ctx.lineTo(cx - r * pulse, cy);
    ctx.closePath();
    ctx.fill();
  }

  // Direction indicator for patrol hazards
  if (isPatrol && h.dirX) {
    const arrowSize = 3;
    ctx.fillStyle = 'rgba(255,255,255,0.20)';
    if (h.dirX > 0) {
      ctx.beginPath();
      ctx.moveTo(cx + r * 0.6, cy - arrowSize);
      ctx.lineTo(cx + r * 0.6 + arrowSize, cy);
      ctx.lineTo(cx + r * 0.6, cy + arrowSize);
      ctx.closePath();
      ctx.fill();
    } else if (h.dirX < 0) {
      ctx.beginPath();
      ctx.moveTo(cx - r * 0.6, cy - arrowSize);
      ctx.lineTo(cx - r * 0.6 - arrowSize, cy);
      ctx.lineTo(cx - r * 0.6, cy + arrowSize);
      ctx.closePath();
      ctx.fill();
    }
  }
}

function drawPickup(p) {
  const cx = p.x * CELL_SIZE + CELL_SIZE / 2;
  const cy = p.y * CELL_SIZE + CELL_SIZE / 2;
  const pulse = 0.8 + 0.2 * Math.sin(Date.now() / 250 + p.x + p.y);
  const r = CELL_SIZE * 0.32 * pulse;

  // Check pickup type
  const isShield = p.type === 'shield';
  const isHighValue = !isShield && p.value >= 35;
  const isSuperValue = !isShield && p.value >= 45;

  let pickupColor, pickupGlowCol;
  if (isShield) {
    pickupColor = C.pickupShield;
    pickupGlowCol = C.pickupShieldGlow;
  } else if (isSuperValue) {
    pickupColor = '#ff88ff';
    pickupGlowCol = 'rgba(255,136,255,0.35)';
  } else if (isHighValue) {
    pickupColor = '#00ddff';
    pickupGlowCol = 'rgba(0,221,255,0.30)';
  } else {
    pickupColor = C.pickup;
    pickupGlowCol = C.pickupGlow;
  }

  // Glow
  const glow = ctx.createRadialGradient(cx, cy, r * 0.2, cx, cy, r * 2.5);
  glow.addColorStop(0, pickupGlowCol);
  glow.addColorStop(1, 'rgba(255,221,68,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(cx - r * 3, cy - r * 3, r * 6, r * 6);

  // Body
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = pickupColor;
  ctx.fill();

  // Shield pickup icon
  if (isShield) {
    // Small shield icon inside the pickup
    ctx.fillStyle = '#fff';
    ctx.font = `bold ${Math.max(7, r * 1.2)}px monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('🛡', cx, cy + 1);

    // Pulsing ring
    const ringPulse = 0.6 + 0.4 * Math.sin(Date.now() / 150 + p.x);
    ctx.strokeStyle = `rgba(68,187,255,${0.35 * ringPulse})`;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(cx, cy, r * 1.7, 0, Math.PI * 2);
    ctx.stroke();
  } else if (isSuperValue) {
    const ringPulse = 0.6 + 0.4 * Math.sin(Date.now() / 180 + p.x);
    ctx.strokeStyle = `rgba(255,136,255,${0.3 * ringPulse})`;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(cx, cy, r * 1.6, 0, Math.PI * 2);
    ctx.stroke();
  } else if (isHighValue) {
    const ringPulse = 0.6 + 0.4 * Math.sin(Date.now() / 200 + p.x);
    ctx.strokeStyle = `rgba(0,221,255,${0.25 * ringPulse})`;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(cx, cy, r * 1.5, 0, Math.PI * 2);
    ctx.stroke();
  }

  // Value indicator (only for credit pickups)
  if (r > 5 && !isShield) {
    ctx.fillStyle = '#000';
    ctx.font = `bold ${Math.max(8, r)}px monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(p.value), cx, cy + 1);
  }
}

function drawHUD(state) {
  // Compact HUD — score + combo + health + sponsor in one line
  const healthHearts = '♥'.repeat(Math.max(0, state.player.health));
  const healthEmpty = '♡'.repeat(Math.max(0, 8 - state.player.health));
  const creditDisplay = economyOnline && creditBalance > 0 ? `💰${creditBalance}` : '';
  const modeIcon = currentMode === 'packetHop' ? '📡' : '🎯';
  // Animated comma combo with scale
  const comboStyle = state.combo > 2
    ? `color:#ffdd44;font-weight:bold;font-size:${10 * comboScale}px`
    : `color:${C.hudWarning};font-size:10px`;
  const comboLabel = state.combo > 2 ? `🔥×${state.combo.toFixed(1)}` : `×${state.combo.toFixed(1)}`;
  // Danger indicator — show when hazards are within 2 cells
  const nearbyThreat = state.hazards.filter(h => {
    const dx = Math.abs(h.x - state.player.x);
    const dy = Math.abs(h.y - state.player.y);
    return dx <= 2 && dy <= 2;
  }).length;
  const dangerIcon = nearbyThreat > 0
    ? `<span style="color:${C.hudDanger};font-size:10px;font-weight:bold">⚠${nearbyThreat > 1 ? nearbyThreat : ''}</span>`
    : '';
  // Shield indicator
  const shieldDisplay = state.player?.shield > 0
    ? `<span style="color:#44bbff;font-size:10px">🛡${state.player.shield}</span>`
    : '';
  // Streak indicator
  const streakCount = state.consecutivePickups || 0;
  const streakDisplay = streakCount > 2
    ? `<span style="color:#ffdd44;font-size:9px">⚡${streakCount}</span>`
    : '';
  // Difficulty tier indicator (subtle, only shows at tier 2+)
  const tierDisplay = (state.difficultyTier || 0) >= 2
    ? `<span style="color:rgba(255,150,50,0.5);font-size:9px">T${state.difficultyTier}</span>`
    : '';

  const sponsorDisplay = activeSponsor
    ? `<span style="color:${(() => { const c = activeSponsor.creatives?.find(cr => cr.type === 'logo')?.content?.colors?.primary; const m = { cyan: '#00ffff', yellow: '#ffdd44', green: '#00ff88', white: '#ffffff' }; return m[c] || '#ffdd44'; })()};font-size:10px;font-weight:bold;margin-left:4px">${sanitizeHtml(activeSponsor.brand_name)}</span>`
    : '';

  hudEl.innerHTML = `
    <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;width:100%;">
      <span style="color:${C.hudAccent};font-weight:bold">${state.score}</span>
      <span style="color:rgba(255,255,255,0.25)">/</span>
      <span style="${comboStyle}">${comboLabel}</span>
      <span style="color:rgba(255,255,255,0.25)">|</span>
      <span style="color:${C.hudDanger};font-size:10px">${healthHearts}</span>
      <span style="color:rgba(255,51,85,0.2);font-size:10px">${healthEmpty}</span>
      ${shieldDisplay}
      <span style="flex:1"></span>
      ${tierDisplay}
      ${streakDisplay}
      ${dangerIcon}
      <span style="color:${C.hudAccent};font-size:10px">${modeIcon}</span>
      ${creditDisplay ? `<span style="color:#ffdd44;font-size:10px">${creditDisplay}</span>` : ''}
      ${sponsorBalance > 0 ? `<span style="color:#44bbff;font-size:10px">🎯${sponsorBalance}µ</span>` : ''}
      ${sponsorDisplay}
    </div>
    <!-- XP / Rank Progress Bar -->
    <div style="display:flex;align-items:center;gap:4px;width:100%;">
      <span style="font-size:9px;color:${C.hudAccent};white-space:nowrap">${getRank(state.score).name}</span>
      <div style="flex:1;height:3px;background:rgba(255,255,255,0.1);border-radius:2px;overflow:hidden;">
        <div style="height:100%;width:${getRankProgress(state.score)}%;background:linear-gradient(90deg,#00ff88,#ffdd44);border-radius:2px;transition:width 0.3s;"></div>
      </div>
      <span style="font-size:9px;color:rgba(255,255,255,0.3);white-space:nowrap">${getNextRank(state.score) ? getNextRank(state.score).name : 'MAX'}</span>
    </div>
  `;
}

function drawGameOver(state) {
  // Overlay
  ctx.fillStyle = 'rgba(0,0,0,0.70)';
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  // GAME OVER title
  ctx.font = `bold ${Math.max(24, Math.floor(CANVAS_W / 28))}px monospace`;
  ctx.fillStyle = C.hudDanger;
  ctx.fillText('GAME OVER', CANVAS_W / 2, CANVAS_H / 2 - CANVAS_H * 0.22);

  // Sponsor interstitial — full creative rendering
  if (activeSponsor) {
    const interstitial = activeSponsor.creatives?.find(c => c.type === 'interstitial');
    const label = activeSponsor.creatives?.find(c => c.type === 'label');
    const primaryColor = activeSponsor.creatives?.find(c => c.type === 'logo')?.content?.colors?.primary || '#ffdd44';
    const brandColors = { cyan: '#00ffff', yellow: '#ffdd44', green: '#00ff88', white: '#ffffff', red: '#ff5555', magenta: '#ff44ff' };
    const accentColor = brandColors[primaryColor] || primaryColor;

    // Accent line separator
    ctx.fillStyle = accentColor;
    ctx.globalAlpha = 0.4;
    ctx.fillRect(CANVAS_W * 0.2, CANVAS_H / 2 - CANVAS_H * 0.20, CANVAS_W * 0.6, 1);
    ctx.globalAlpha = 1.0;

    // Logo rendering (ASCII art or text)
    if (sponsorLogoImage) {
      const logoY = CANVAS_H / 2 - CANVAS_H * 0.16;
      if (sponsorLogoImage.ascii && Array.isArray(sponsorLogoImage.ascii)) {
        const asciiLines = sponsorLogoImage.ascii;
        const lineHeight = Math.max(10, Math.min(14, CANVAS_H * 0.035));
        const totalH = asciiLines.length * lineHeight;
        const startY = logoY - totalH / 2;
        ctx.font = `${lineHeight}px monospace`;
        ctx.fillStyle = accentColor;
        ctx.textAlign = 'center';
        for (let i = 0; i < asciiLines.length; i++) {
          ctx.fillText(asciiLines[i], CANVAS_W / 2, startY + i * lineHeight);
        }
      } else if (sponsorLogoImage.text) {
        ctx.font = 'bold 16px monospace';
        ctx.fillStyle = accentColor;
        ctx.textAlign = 'center';
        ctx.fillText(sponsorLogoImage.text, CANVAS_W / 2, logoY);
      } else if (sponsorLogoImage.width && sponsorLogoImage.height) {
        const maxLogoW = Math.min(160, CANVAS_W * 0.4);
        const maxLogoH = 60;
        const scale = Math.min(maxLogoW / sponsorLogoImage.width, maxLogoH / sponsorLogoImage.height, 1);
        const logoW = sponsorLogoImage.width * scale;
        const logoH = sponsorLogoImage.height * scale;
        ctx.drawImage(sponsorLogoImage, (CANVAS_W - logoW) / 2, logoY - logoH / 2, logoW, logoH);
      }
    }

    // Headline from interstitial creative
    const headline = interstitial?.content?.headline || 'This round powered by';
    ctx.font = '11px monospace';
    ctx.fillStyle = accentColor;
    ctx.textAlign = 'center';
    ctx.fillText(headline, CANVAS_W / 2, CANVAS_H / 2 - CANVAS_H * 0.08);

    // Brand name (always shown)
    ctx.font = 'bold 15px monospace';
    ctx.fillStyle = '#ffffff';
    ctx.fillText(activeSponsor.brand_name, CANVAS_W / 2, CANVAS_H / 2 - CANVAS_H * 0.03);

    // Body text from interstitial creative
    if (interstitial?.content?.body) {
      ctx.font = '10px monospace';
      ctx.fillStyle = 'rgba(255,255,255,0.6)';
      ctx.fillText(interstitial.content.body, CANVAS_W / 2, CANVAS_H / 2 + CANVAS_H * 0.03);
    }

    // CTA from interstitial creative
    if (interstitial?.content?.cta) {
      ctx.font = 'bold 10px monospace';
      ctx.fillStyle = accentColor;
      ctx.globalAlpha = 0.7 + 0.3 * Math.abs(Math.sin(Date.now() / 1000));
      ctx.fillText(interstitial.content.cta, CANVAS_W / 2, CANVAS_H / 2 + CANVAS_H * 0.08);
      ctx.globalAlpha = 1.0;
    }
  }

  const fontSize = Math.max(14, Math.floor(CANVAS_W / 40));
  ctx.font = `${fontSize}px monospace`;
  ctx.fillStyle = C.hudText;
  ctx.fillText(`Score: ${state.score}`, CANVAS_W / 2, CANVAS_H / 2 + CANVAS_H * 0.02);
  ctx.fillText(`Best:  ${state.bestScore}`, CANVAS_W / 2, CANVAS_H / 2 + CANVAS_H * 0.08);

  ctx.font = '11px monospace';
  ctx.fillStyle = 'rgba(255,255,255,0.5)';
  ctx.fillText('Tap Play Again to retry', CANVAS_W / 2, CANVAS_H / 2 + CANVAS_H * 0.16);

  // Receipt result
  if (lastReceiptResult) {
    ctx.font = '10px monospace';
    if (lastReceiptResult.ok) {
      ctx.fillStyle = '#00ff88';
      ctx.fillText(`+${lastReceiptResult.sponsorMicros || 0} µ claimable rewards`, CANVAS_W / 2, CANVAS_H / 2 + CANVAS_H * 0.22);
      // Sponsor rewards (from 20% pool)
      if (lastReceiptResult?.ok && lastReceiptResult.sponsorMicros > 0) {
        ctx.fillStyle = '#44bbff';
        ctx.fillText(`🎯 +${lastReceiptResult.sponsorMicros} µ from sponsors`, CANVAS_W / 2, CANVAS_H / 2 + CANVAS_H * 0.28);
      }
    } else {
      ctx.fillStyle = 'rgba(255,255,255,0.3)';
      ctx.fillText('Receipt pending', CANVAS_W / 2, CANVAS_H / 2 + CANVAS_H * 0.22);
    }
  }
}

function drawPaused() {
  ctx.fillStyle = 'rgba(0,0,0,0.45)';
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `bold ${Math.max(24, Math.floor(CANVAS_W / 22))}px monospace`;
  ctx.fillStyle = 'rgba(255,255,255,0.8)';
  ctx.fillText('⏸  PAUSED', CANVAS_W / 2, CANVAS_H / 2);
}

// ── Frogger (Packet Hop) Rendering ──────────────────────────────────────────

const FROGGER_COLORS = {
  road:       '#1a1a2e',
  roadLine:   'rgba(255,255,50,0.08)',
  roadPulse:  'rgba(255,255,50,0.03)',
  river:      '#0a1a2e',
  riverLine:  'rgba(0,150,255,0.08)',
  riverLine2: 'rgba(0,150,255,0.12)',
  car:        '#ff6644',
  carGlow:    'rgba(255,102,68,0.25)',
  carHL:      'rgba(255,255,255,0.35)',
  log:        '#8B5E3C',
  logGlow:    'rgba(139,94,60,0.20)',
  frog:       '#00ff88',
  frogGlow:   'rgba(0,255,136,0.30)',
  homeFilled: '#00ff88',
  homeEmpty:  'rgba(255,255,255,0.10)',
  slotGlow:   'rgba(0,255,136,0.15)',
  goal:       '#ffdd44',
  timeWarn:   '#ff3355',
};

function drawFroggerLanes(state) {
  if (!state.lanes) return;

  const time = Date.now() / 1000;

  for (const lane of state.lanes) {
    const y = lane.y * CELL_SIZE;
    const isRoad = lane.type === 'road';
    const isRiver = lane.type === 'river';

    // Lane background
    ctx.fillStyle = isRoad ? FROGGER_COLORS.road : FROGGER_COLORS.river;
    ctx.fillRect(0, y, CANVAS_W, CELL_SIZE);

    if (isRoad) {
      // Lane center line
      ctx.strokeStyle = FROGGER_COLORS.roadLine;
      ctx.lineWidth = 0.5;
      ctx.beginPath();
      ctx.moveTo(0, y + CELL_SIZE / 2);
      ctx.lineTo(CANVAS_W, y + CELL_SIZE / 2);
      ctx.stroke();

      // Subtle pulse on road lanes
      const pulse = 0.5 + 0.5 * Math.sin(time * 2 + lane.y);
      ctx.fillStyle = `rgba(255,255,50,${0.02 * pulse})`;
      ctx.fillRect(0, y, CANVAS_W, CELL_SIZE);
    } else if (isRiver) {
      // Animated river ripple lines — move with current direction
      const rippleSpeed = (lane.direction || 1) * 60;
      const t = (time * rippleSpeed) % CANVAS_W;

      // Under-glow
      ctx.fillStyle = `rgba(0,150,255,${0.02 + 0.02 * Math.sin(time * 1.5 + lane.y)})`;
      ctx.fillRect(0, y, CANVAS_W, CELL_SIZE);

      // Flowing ripple lines
      for (let r = 0; r < 3; r++) {
        const ry = y + CELL_SIZE * (0.25 + r * 0.25);
        ctx.strokeStyle = r === 1 ? FROGGER_COLORS.riverLine2 : FROGGER_COLORS.riverLine;
        ctx.lineWidth = r === 1 ? 0.8 : 0.4;
        ctx.beginPath();
        ctx.moveTo(0, ry);
        ctx.lineTo(CANVAS_W, ry);
        ctx.stroke();
      }

      // Flowing dots / sparkles on river
      for (let d = 0; d < 3; d++) {
        const dx = ((t + d * CANVAS_W / 3) % (CANVAS_W + 20)) - 10;
        const dy = y + CELL_SIZE * (0.15 + Math.sin(time + lane.y + d) * 0.3);
        const da = 0.1 + 0.1 * Math.sin(time * 3 + d * 2);
        ctx.fillStyle = `rgba(0,200,255,${da})`;
        ctx.beginPath();
        ctx.arc(dx, dy, 1.5, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // Draw vehicles
    if (lane.vehicles) {
      for (const v of lane.vehicles) {
        const vx = v.x * CELL_SIZE;
        if (isRoad) {
          // Car — rounded rectangle
          const carW = CELL_SIZE * 1.8;
          const carH = CELL_SIZE * 0.7;
          const carX = vx;
          const carY = y + (CELL_SIZE - carH) / 2;
          // Per-lane car color for visual variety (10 distinct colors)
          const laneColors = ['#ff6644','#ff8844','#ff4466','#ffaa33','#cc4455','#ff7755','#dd6633','#ee5533','#ff6633','#dd4455'];
          const laneCarColor = laneColors[lane.y % laneColors.length];
          // Car glow — use same base color at low alpha
          ctx.fillStyle = laneCarColor.replace(')', '').replace(/[^,]+\)/, ',0.25)');

          // Car glow
          ctx.fillStyle = FROGGER_COLORS.carGlow;
          ctx.beginPath();
          ctx.roundRect(carX - 2, carY - 2, carW + 4, carH + 4, 4);
          ctx.fill();

          // Car body (per-lane color)
          ctx.fillStyle = laneCarColor;
          ctx.beginPath();
          ctx.roundRect(carX, carY, carW, carH, 3);
          ctx.fill();

          // Car highlight (top stripe)
          ctx.fillStyle = 'rgba(255,255,255,0.15)';
          ctx.beginPath();
          ctx.roundRect(carX + 2, carY + 2, carW - 4, carH * 0.35, 2);
          ctx.fill();

          // Headlights — small triangle on the front edge
          const hlSize = 4;
          ctx.fillStyle = FROGGER_COLORS.carHL;
          if (lane.direction > 0) {
            // Moving right — headlights on the right
            ctx.beginPath();
            ctx.moveTo(carX + carW, carY + 2);
            ctx.lineTo(carX + carW + hlSize, carY + carH / 2);
            ctx.lineTo(carX + carW, carY + carH - 2);
            ctx.closePath();
            ctx.fill();
          } else {
            // Moving left — headlights on the left
            ctx.beginPath();
            ctx.moveTo(carX, carY + 2);
            ctx.lineTo(carX - hlSize, carY + carH / 2);
            ctx.lineTo(carX, carY + carH - 2);
            ctx.closePath();
            ctx.fill();
          }
        } else if (isRiver) {
          // Log — rounded rect
          const logW = CELL_SIZE * 2.2;
          const logH = CELL_SIZE * 0.65;
          const logX = vx;
          const logY = y + (CELL_SIZE - logH) / 2;

          // Log glow
          ctx.fillStyle = FROGGER_COLORS.logGlow;
          ctx.beginPath();
          ctx.roundRect(logX - 2, logY - 2, logW + 4, logH + 4, 6);
          ctx.fill();

          // Log body
          ctx.fillStyle = FROGGER_COLORS.log;
          ctx.beginPath();
          ctx.roundRect(logX, logY, logW, logH, 5);
          ctx.fill();

          // Log rings
          ctx.fillStyle = 'rgba(0,0,0,0.15)';
          ctx.fillRect(logX + logW * 0.2, logY + 2, 3, logH - 4);
          ctx.fillRect(logX + logW * 0.5, logY + 2, 3, logH - 4);
          ctx.fillRect(logX + logW * 0.8, logY + 2, 3, logH - 4);
        }
      }
    }
  }
}

function drawHomeSlots(state) {
  // Draw home slots at the top of the play area (row 0)
  const slotYs = [0, 1]; // home slots are at row 0, display at top of row 0
  const cfg = { homeSlotXs: [6, 17, 28, 39, 50] }; // matches gameConfig.js exactly

  // Goal bar background
  ctx.fillStyle = 'rgba(255,221,68,0.06)';
  ctx.fillRect(0, 0, CANVAS_W, CELL_SIZE * 1.5);

  // Goal text
  ctx.fillStyle = FROGGER_COLORS.goal;
  ctx.font = `bold ${Math.max(8, Math.floor(CELL_SIZE * 0.6))}px monospace`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText('🏠 GOAL', 6, CELL_SIZE * 0.75);

  // Draw home slots
  for (let i = 0; i < cfg.homeSlotXs.length; i++) {
    const sx = cfg.homeSlotXs[i] * CELL_SIZE;
    const sy = CELL_SIZE * 0.15;
    const sw = CELL_SIZE * 1.2;
    const sh = CELL_SIZE * 1.2;

    const filled = state.homeSlots && state.homeSlots[i];

    // Slot background
    if (filled) {
      ctx.fillStyle = FROGGER_COLORS.slotGlow;
      ctx.beginPath();
      ctx.roundRect(sx - sw / 2, sy, sw, sh, 4);
      ctx.fill();
    }

    ctx.strokeStyle = filled ? FROGGER_COLORS.homeFilled : FROGGER_COLORS.homeEmpty;
    ctx.lineWidth = filled ? 2 : 1;
    ctx.beginPath();
    ctx.roundRect(sx - sw / 2, sy, sw, sh, 4);
    ctx.stroke();

    if (filled) {
      ctx.fillStyle = FROGGER_COLORS.homeFilled;
      ctx.font = `${Math.max(10, Math.floor(CELL_SIZE * 0.7))}px monospace`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('✓', sx, sy + sh / 2);
    }
  }
}

function drawFrogPlayer(state) {
  const player = state.player;
  if (!player) return;
  const cx = player.x * CELL_SIZE + CELL_SIZE / 2;
  const cy = player.y * CELL_SIZE + CELL_SIZE / 2;
  const r = CELL_SIZE * 0.4;

  // Glow
  const glow = ctx.createRadialGradient(cx, cy, r * 0.2, cx, cy, r * 2);
  glow.addColorStop(0, FROGGER_COLORS.frogGlow);
  glow.addColorStop(1, 'rgba(0,255,136,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(cx - r * 2.5, cy - r * 2.5, r * 5, r * 5);

  // Frog body (circle)
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = FROGGER_COLORS.frog;
  ctx.fill();

  // Eyes
  const eyeR = r * 0.22;
  const eyeY = cy - r * 0.25;
  ctx.fillStyle = '#fff';
  ctx.beginPath();
  ctx.arc(cx - r * 0.25, eyeY, eyeR, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(cx + r * 0.25, eyeY, eyeR, 0, Math.PI * 2);
  ctx.fill();

  // Pupils
  ctx.fillStyle = '#000';
  ctx.beginPath();
  ctx.arc(cx - r * 0.25, eyeY, eyeR * 0.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(cx + r * 0.25, eyeY, eyeR * 0.5, 0, Math.PI * 2);
  ctx.fill();
}

function drawFroggerHUD(state) {
  const lives = state.lives != null ? state.lives : 3;
  const level = state.level || 1;
  const timeLeft = state.timeLeft != null ? state.timeLeft : 0;
  const modeIcon = '📡';
  const livesStr = '🐸'.repeat(Math.max(0, lives));
  // Frogger combo (increments on slot fill)
  const froggerCombo = state.combo || 1;
  const comboStr = froggerCombo > 1
    ? `<span style="color:#ffdd44;font-size:10px${slotFillPulse > 10 ? ';font-weight:bold' : ''}">×${froggerCombo.toFixed(1)}</span>`
    : '';
  // Time warning pulse when time is low
  const timeWarn = timeLeft < 5;
  const timePulse = timeWarn ? 0.3 + 0.7 * Math.abs(Math.sin(Date.now() / 200)) : 1;
  const timeColor = timeWarn
    ? `rgba(255,51,85,${timePulse})`
    : timeLeft < 10 ? '#ffdd44' : 'rgba(255,255,255,0.6)';

  const sponsorText = activeSponsor
    ? `<span style="color:${(() => { const c = activeSponsor.creatives?.find(cr => cr.type === 'logo')?.content?.colors?.primary; const m = { cyan: '#00ffff', yellow: '#ffdd44', green: '#00ff88', white: '#ffffff' }; return m[c] || '#ffdd44'; })()};font-size:10px;font-weight:bold;margin-left:4px">${sanitizeHtml(activeSponsor.brand_name)}</span>`
    : '';

  hudEl.innerHTML = `
    <div style="display:flex;align-items:center;gap:5px;flex-wrap:wrap;width:100%;">
      <span style="color:#ffdd44;font-weight:bold">${state.score}</span>
      <span style="color:rgba(255,255,255,0.25)">|</span>
      <span style="color:#00ff88;font-size:10px">L${level}</span>
      ${comboStr ? `<span style="color:rgba(255,255,255,0.25)">|</span>${comboStr}` : ''}
      <span style="color:rgba(255,255,255,0.25)">|</span>
      <span style="color:${timeColor};font-size:10px${timeWarn ? ';font-weight:bold' : ''}">${timeLeft}s</span>
      ${timeWarn ? `<span style="color:${C.hudDanger};font-size:8px">⚠</span>` : ''}
      <span style="flex:1"></span>
      <span style="font-size:10px">${livesStr}</span>
      <span style="color:${C.hudAccent};font-size:10px">${modeIcon}</span>
      ${sponsorText}
    </div>
  `;
}

function drawGetReady(state) {
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  // Countdown number animation
  const ticksLeft = state.getReadyTicks || 0;
  const seconds = Math.ceil(ticksLeft / 10);
  const secFrac = (ticksLeft % 10) / 10;

  // Big pulsing number
  const numSize = Math.max(48, Math.floor(CANVAS_W / 8));
  const numPulse = 0.9 + 0.1 * Math.sin(secFrac * Math.PI * 2);
  ctx.font = `bold ${numSize * numPulse}px monospace`;
  ctx.fillStyle = seconds > 1 ? '#ffdd44' : '#ff3355';
  ctx.fillText(String(seconds), CANVAS_W / 2, CANVAS_H / 2 - 30);

  // Label
  ctx.font = `bold ${Math.max(14, Math.floor(CANVAS_W / 24))}px monospace`;
  ctx.fillStyle = 'rgba(255,255,255,0.7)';
  ctx.fillText('GET READY', CANVAS_W / 2, CANVAS_H / 2 + 30);

  if (seconds <= 1) {
    ctx.font = '11px monospace';
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.fillText('📡 Cross the grid. Reach the goal.', CANVAS_W / 2, CANVAS_H / 2 + 55);
  }
}

function drawFroggerGameOver(state) {
  ctx.fillStyle = 'rgba(0,0,0,0.70)';
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  ctx.font = `bold ${Math.max(22, Math.floor(CANVAS_W / 28))}px monospace`;
  ctx.fillStyle = C.hudDanger;
  ctx.fillText('ROUTE LOST', CANVAS_W / 2, CANVAS_H / 2 - CANVAS_H * 0.20);

  // Sponsor interstitial — full creative rendering
  if (activeSponsor) {
    const interstitial = activeSponsor.creatives?.find(c => c.type === 'interstitial');
    const primaryColor = activeSponsor.creatives?.find(c => c.type === 'logo')?.content?.colors?.primary || '#ffdd44';
    const brandColors = { cyan: '#00ffff', yellow: '#ffdd44', green: '#00ff88', white: '#ffffff', red: '#ff5555', magenta: '#ff44ff' };
    const accentColor = brandColors[primaryColor] || primaryColor;

    // Accent line separator
    ctx.fillStyle = accentColor;
    ctx.globalAlpha = 0.4;
    ctx.fillRect(CANVAS_W * 0.2, CANVAS_H / 2 - CANVAS_H * 0.16, CANVAS_W * 0.6, 1);
    ctx.globalAlpha = 1.0;

    // Headline
    const headline = interstitial?.content?.headline || 'This round powered by';
    ctx.font = '10px monospace';
    ctx.fillStyle = accentColor;
    ctx.fillText(headline, CANVAS_W / 2, CANVAS_H / 2 - CANVAS_H * 0.11);

    // Brand name
    ctx.font = 'bold 15px monospace';
    ctx.fillStyle = '#ffffff';
    ctx.fillText(activeSponsor.brand_name, CANVAS_W / 2, CANVAS_H / 2 - CANVAS_H * 0.06);

    // Body text
    if (interstitial?.content?.body) {
      ctx.font = '10px monospace';
      ctx.fillStyle = 'rgba(255,255,255,0.6)';
      ctx.fillText(interstitial.content.body, CANVAS_W / 2, CANVAS_H / 2 - CANVAS_H * 0.01);
    }

    // CTA
    if (interstitial?.content?.cta) {
      ctx.font = 'bold 10px monospace';
      ctx.fillStyle = accentColor;
      ctx.globalAlpha = 0.7 + 0.3 * Math.abs(Math.sin(Date.now() / 1000));
      ctx.fillText(interstitial.content.cta, CANVAS_W / 2, CANVAS_H / 2 + CANVAS_H * 0.04);
      ctx.globalAlpha = 1.0;
    }
  }

  const fs = Math.max(13, Math.floor(CANVAS_W / 42));
  ctx.font = `${fs}px monospace`;
  ctx.fillStyle = C.hudText;
  ctx.fillText(`Score: ${state.score}`, CANVAS_W / 2, CANVAS_H / 2 + CANVAS_H * 0.02);
  ctx.fillText(`Level: ${state.level || 1} | Best: ${state.bestScore}`, CANVAS_W / 2, CANVAS_H / 2 + CANVAS_H * 0.09);

  ctx.font = '10px monospace';
  ctx.fillStyle = 'rgba(255,255,255,0.5)';
  ctx.fillText('Tap Play Again to retry', CANVAS_W / 2, CANVAS_H / 2 + CANVAS_H * 0.17);
}

// ── Cleanup ──────────────────────────────────────────────────────────────────

export function destroy() {
  if (rafId) cancelAnimationFrame(rafId);
  // Clear campaign rotation timers
  if (campaignRotationTimer) { clearInterval(campaignRotationTimer); campaignRotationTimer = null; }
  if (campaignRefreshTimer) { clearInterval(campaignRefreshTimer); campaignRefreshTimer = null; }
  window.removeEventListener('keydown', onKeyDown);
  window.removeEventListener('keyup',   onKeyUp);
  destroyTouchInput();
  if (redemptionUI) {
    redemptionUI.hide();
    redemptionUI = null;
  }
  if (canvasEl && canvasEl.parentNode) {
    canvasEl.parentNode.innerHTML = '';
  }
  engine = null;
  sessionManager = null;
  economyClient = null;
  playerId = null;
  creditBalance = 0;
  sponsorBalance = 0;
  economyOnline = false;
  allCampaigns = [];
  activeSponsor = null;
}

// ── Auto-init ────────────────────────────────────────────────────────────────

if (typeof window !== 'undefined' && document.readyState !== 'loading') {
  // Will be initialised from index.html
}