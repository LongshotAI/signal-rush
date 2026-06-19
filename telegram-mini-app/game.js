/**
 * game.js — Signal Rush Canvas Renderer for Telegram Mini App
 *
 * Loads the browser-loadable engine bundle, creates a game instance,
 * and renders it to an HTML canvas at 60 fps with keyboard + touch controls,
 * Telegram Mini App SDK integration, and mode selection.
 */

import engineBundle from '/dist/signal-rush-engine.mjs';
import { initTouchInput, destroyTouchInput } from './touch-input.js';
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

const ECONOMY_BASE_URL = 'http://localhost:8720';

// ── Configuration ────────────────────────────────────────────────────────────

const CANVAS_COLS = 56;   // GAME_CONFIG.width
const CANVAS_ROWS = 28;   // GAME_CONFIG.height
const CELL_SIZE   = 18;   // pixels per grid cell
const CANVAS_W    = CANVAS_COLS * CELL_SIZE;
const CANVAS_H    = CANVAS_ROWS * CELL_SIZE;

const TICK_MS = 120; // Engine tick rate (ms per engine step)

const GAME_MODES = ['aiHunt', 'frogger', 'packetHop'];
const GAME_MODE_LABELS = {
  aiHunt:    'AI Hunt',
  frogger:   'Frogger',
  packetHop: 'Packet Hop',
};

// Colours
const C = {
  bg:          '#0a0a1a',
  grid:        'rgba(255,255,255,0.04)',
  gridLine:    'rgba(255,255,255,0.06)',
  player:      '#00ff88',
  playerGlow:  'rgba(0,255,136,0.35)',
  playerTrail: 'rgba(0,255,136,0.15)',
  hazard:      '#ff3355',
  hazardGlow:  'rgba(255,51,85,0.30)',
  pickup:      '#ffdd44',
  pickupGlow:  'rgba(255,221,68,0.30)',
  pickupPulse: 'rgba(255,221,68,0.12)',
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
let gameOverCooldown = false; // prevents accidental restart

// Touch move queue — moves from touch input are consumed on the next tick
let touchMove = null;

// High-DPI scaling
let dpr = 1;
let ctx = null;

// Previous state for detecting events (pickup collection, damage)
let prevHealth = null;
let prevPickupCount = null;

// DOM refs
let canvasEl = null;
let hudEl   = null;
let modeSelectorEl = null;

// ── Economy State ─────────────────────────────────────────────────────────────

let economyClient = null;
let sessionManager = null;
let redemptionUI = null;
let playerId = null;
let creditBalance = 0;
let lastReceiptResult = null;
let economyOnline = false;

// ── Initialisation ──────────────────────────────────────────────────────────

export async function init(containerSelector = '#game-container') {
  const container = document.querySelector(containerSelector);
  if (!container) {
    throw new Error(`Container "${containerSelector}" not found`);
  }

  // Init Telegram Mini App SDK
  const tgInfo = await initTelegramMiniApp();
  console.log('[SignalRush] Telegram mode:', tgInfo.isTelegramMode);

  // Init economy client
  economyClient = new EconomyClient({ baseUrl: ECONOMY_BASE_URL });

  // If we have Telegram initData, authenticate with economy
  if (tgInfo.initData) {
    const authResult = await economyClient.auth(tgInfo.initData);
    if (authResult.ok && authResult.player) {
      playerId = authResult.player.id;
      creditBalance = authResult.player.balance || 0;
      economyOnline = true;
      console.log('[SignalRush] Economy online, player:', playerId);
    } else if (authResult.offline) {
      console.log('[SignalRush] Economy offline — playing without credits');
    }
  }

  // Detect device pixel ratio for crisp rendering
  dpr = window.devicePixelRatio || 1;

  // Build DOM
  container.innerHTML = '';
  container.style.position = 'relative';
  container.style.display = 'inline-block';

  canvasEl = document.createElement('canvas');
  canvasEl.width  = CANVAS_W * dpr;
  canvasEl.height = CANVAS_H * dpr;
  canvasEl.style.width  = `${CANVAS_W}px`;
  canvasEl.style.height = `${CANVAS_H}px`;
  canvasEl.style.display = 'block';
  canvasEl.style.borderRadius = '8px';
  canvasEl.style.boxShadow = '0 0 40px rgba(0,255,136,0.10)';
  canvasEl.style.touchAction = 'none'; // prevent browser zoom/scroll
  container.appendChild(canvasEl);

  ctx = canvasEl.getContext('2d');
  ctx.scale(dpr, dpr);

  // HUD overlay
  hudEl = document.createElement('div');
  Object.assign(hudEl.style, {
    position: 'absolute',
    top: '0',
    left: '0',
    right: '0',
    padding: '8px 12px',
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    fontFamily: "'JetBrains Mono', 'SF Mono', 'Fira Code', monospace",
    fontSize: '13px',
    color: C.hudText,
    background: C.hudBg,
    borderRadius: '8px 8px 0 0',
    pointerEvents: 'none',
    zIndex: '10',
  });
  container.appendChild(hudEl);

  // Wire keyboard
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup',   onKeyUp);

  // Initialise touch input
  initTouchInput(canvasEl, (move) => {
    touchMove = move;
  });

  // Create engine
  currentMode = 'aiHunt';
  _createEngine();

  // Hide Telegram MainButton initially
  hideMainButton();

  // Build mode selector UI
  _buildModeSelector(containerSelector);

  // Kick off render loop
  rafId = requestAnimationFrame(loop);

  return engine;
}

// ── Mode selector ───────────────────────────────────────────────────────────

function _buildModeSelector(containerSelector) {
  const container = document.querySelector(containerSelector);
  if (!container) return;

  // If a mode-selector bar already exists above the game-container, reuse it.
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
    marginBottom: '12px',
    flexWrap: 'wrap',
  });

  for (const mode of GAME_MODES) {
    const chip = document.createElement('button');
    chip.textContent = GAME_MODE_LABELS[mode] || mode;
    chip.dataset.mode = mode;
    Object.assign(chip.style, {
      padding: '6px 16px',
      borderRadius: '20px',
      border: '1px solid rgba(255,255,255,0.15)',
      background: mode === currentMode ? 'rgba(0,255,136,0.15)' : 'rgba(255,255,255,0.05)',
      color: mode === currentMode ? '#00ff88' : 'rgba(255,255,255,0.5)',
      fontFamily: "'JetBrains Mono', 'SF Mono', 'Fira Code', monospace",
      fontSize: '12px',
      cursor: 'pointer',
      transition: 'background 0.2s, color 0.2s, border-color 0.2s',
      touchAction: 'manipulation',
      userSelect: 'none',
      WebkitUserSelect: 'none',
    });

    chip.addEventListener('click', () => {
      if (currentMode === mode && engine && !engine.state.gameOver) return;
      currentMode = mode;
      hapticFeedback('light');

      // Update chip styles
      for (const sibling of bar.querySelectorAll('button')) {
        const isActive = sibling.dataset.mode === mode;
        sibling.style.background = isActive ? 'rgba(0,255,136,0.15)' : 'rgba(255,255,255,0.05)';
        sibling.style.color      = isActive ? '#00ff88' : 'rgba(255,255,255,0.5)';
        sibling.style.borderColor = isActive ? 'rgba(0,255,136,0.3)' : 'rgba(255,255,255,0.15)';
      }

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

  // Insert before the game container
  container.parentNode.insertBefore(bar, container);
}

function _createEngine() {
  engine = createEngine({ mode: currentMode, seed: Date.now() });
  lastTickTime = 0;
  gameOverCooldown = false;
  touchMove = null;
  prevHealth = null;
  prevPickupCount = null;
  lastReceiptResult = null;
  hideMainButton();

  // Start economy session
  sessionManager = new SessionManager();
  if (economyOnline) {
    sessionManager.startSession(currentMode, engine.state.seed || Date.now());
  }

  // Init redemption UI on first engine create
  if (!redemptionUI && playerId) {
    redemptionUI = new RedemptionUI();
    redemptionUI.init(economyClient, playerId, creditBalance);
  }
}

// ── Keyboard ─────────────────────────────────────────────────────────────────

function onKeyDown(e) {
  keys.add(e.code);
  // Prevent scrolling with arrows/space
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

function loop(timestamp) {
  rafId = requestAnimationFrame(loop);

  // Run engine.step() on the configured tick cadence
  if (timestamp - lastTickTime >= TICK_MS) {
    lastTickTime = timestamp;

    if (engine) {
      const state = engine.state;

      if (state.gameOver && !gameOverCooldown) {
        gameOverCooldown = true;

        // Submit receipt to economy
        _submitReceipt();

        // Show Telegram MainButton for restart
        showMainButton('⚡ Play Again', () => {
          _createEngine();
          hideMainButton();
        }, { color: '#00ff88', textColor: '#000000' });

        // Allow restart with Enter or Space
        if (keys.has('Enter') || keys.has('Space')) {
          engine.reset();
          gameOverCooldown = false;
          hideMainButton();
        }
      } else if (!state.gameOver) {
        // Track previous state for event detection
        const healthBefore = state.player.health;
        const pickupsBefore = state.pickups.length;

        // Merge keyboard and touch input
        let move = currentMove();
        if (!move && touchMove) {
          move = touchMove;
          touchMove = null;
        }

        // Record input for receipt
        if (sessionManager) {
          sessionManager.recordInput(move, state.tick);
        }

        engine.step({ move });

        // Detect events for haptic feedback
        _detectEvents(healthBefore, pickupsBefore);
      }
    }
  }

  render();
}

/**
 * Detect pickup collection and damage events and trigger haptic feedback.
 */
function _detectEvents(healthBefore, pickupsBefore) {
  if (!engine) return;
  const state = engine.state;

  // Pickup collected: fewer pickups than before
  if (state.pickups.length < pickupsBefore) {
    hapticFeedback('light');
  }

  // Damage taken: health decreased
  if (state.player.health < healthBefore) {
    hapticFeedback('heavy');
  }

  // Game over
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
    // Submit for server-side verification
    const verifyResult = await economyClient.submitReceipt({
      seed: receipt.seed,
      mode: receipt.mode,
      inputs: receipt.inputs,
      claimedScore: receipt.score,
      claimedLevel: receipt.level,
    });

    if (verifyResult.ok && verifyResult.valid) {
      // Receipt verified — award credits
      const creditsEarned = Math.floor(receipt.score / 10);
      if (creditsEarned > 0) {
        const ingestResult = await economyClient.submitCredits({
          playerId,
          sessionId: receipt.sessionId,
          creditsDelta: creditsEarned,
          events: [{ type: 'game_complete', score: receipt.score, level: receipt.level }],
        });
        if (ingestResult.ok) {
          creditBalance = ingestResult.new_balance ?? creditBalance + creditsEarned;
          if (redemptionUI) redemptionUI.updateBalance(creditBalance);
        }
      }
      lastReceiptResult = { ok: true, creditsEarned, score: receipt.score };
    } else {
      lastReceiptResult = { ok: false, reason: 'receipt rejected by server' };
    }
  } catch (err) {
    console.error('[SignalRush] Receipt submission failed:', err.message);
    lastReceiptResult = { ok: false, reason: err.message };
  }
}

// ── Rendering ────────────────────────────────────────────────────────────────

function render() {
  if (!ctx || !engine) return;
  const state = engine.state;
  const G = state; // shorthand

  // Clear
  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

  // Draw grid
  drawGrid();

  // Draw border wall
  drawBorder();

  // Draw pickups (under player)
  state.pickups.forEach((p) => drawPickup(p));

  // Draw hazards
  state.hazards.forEach((h) => drawHazard(h));

  // Draw trail
  if (G.trail) {
    ctx.fillStyle = C.playerTrail;
    ctx.fillRect(G.trail.x * CELL_SIZE, G.trail.y * CELL_SIZE, CELL_SIZE, CELL_SIZE);
  }

  // Draw player
  drawPlayer(state.player, G.invulnerable > 0);

  // Draw HUD
  drawHUD(state);

  // Game-over overlay
  if (state.gameOver) {
    drawGameOver(state);
  }

  // Paused overlay
  if (G.paused && !state.gameOver) {
    drawPaused();
  }
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
  ctx.strokeStyle = 'rgba(255,51,85,0.50)';
  ctx.lineWidth = 2;
  ctx.strokeRect(CELL_SIZE, CELL_SIZE, (CANVAS_COLS - 2) * CELL_SIZE, (CANVAS_ROWS - 2) * CELL_SIZE);
}

function drawPlayer(player, invulnerable) {
  const cx = player.x * CELL_SIZE + CELL_SIZE / 2;
  const cy = player.y * CELL_SIZE + CELL_SIZE / 2;
  const r = CELL_SIZE * 0.42;

  // Glow
  const glow = ctx.createRadialGradient(cx, cy, r * 0.3, cx, cy, r * 2.2);
  glow.addColorStop(0, C.playerGlow);
  glow.addColorStop(1, 'rgba(0,255,136,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(cx - r * 2.5, cy - r * 2.5, r * 5, r * 5);

  // Body
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = invulnerable
    ? `rgba(0,255,136,${0.5 + 0.5 * Math.sin(Date.now() / 80)})`
    : C.player;
  ctx.fill();

  // Eye / direction indicator
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

  // Glow
  const glow = ctx.createRadialGradient(cx, cy, r * 0.2, cx, cy, r * 2);
  glow.addColorStop(0, C.hazardGlow);
  glow.addColorStop(1, 'rgba(255,51,85,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(cx - r * 2.5, cy - r * 2.5, r * 5, r * 5);

  // Body – diamond shape
  ctx.beginPath();
  ctx.moveTo(cx, cy - r);
  ctx.lineTo(cx + r, cy);
  ctx.lineTo(cx, cy + r);
  ctx.lineTo(cx - r, cy);
  ctx.closePath();
  ctx.fillStyle = C.hazard;
  ctx.fill();
}

function drawPickup(p) {
  const cx = p.x * CELL_SIZE + CELL_SIZE / 2;
  const cy = p.y * CELL_SIZE + CELL_SIZE / 2;
  const pulse = 0.8 + 0.2 * Math.sin(Date.now() / 250 + p.x + p.y);
  const r = CELL_SIZE * 0.32 * pulse;

  // Glow
  const glow = ctx.createRadialGradient(cx, cy, r * 0.2, cx, cy, r * 2.5);
  glow.addColorStop(0, C.pickupGlow);
  glow.addColorStop(1, 'rgba(255,221,68,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(cx - r * 3, cy - r * 3, r * 6, r * 6);

  // Body – circle with cross
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = C.pickup;
  ctx.fill();

  // Value indicator (small number inside)
  if (r > 5) {
    ctx.fillStyle = '#000';
    ctx.font = `bold ${Math.max(8, r)}px monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(p.value), cx, cy + 1);
  }
}

function drawHUD(state) {
  const healthHearts = '♥'.repeat(Math.max(0, state.player.health));
  const healthEmpty = '♡'.repeat(Math.max(0, 8 - state.player.health));
  const creditDisplay = economyOnline ? `💰${creditBalance}` : '—';
  const redeemBtn = playerId
    ? `<button id="hud-redeem-btn" style="background:none;border:1px solid rgba(0,255,136,0.3);color:#00ff88;padding:2px 8px;border-radius:4px;cursor:pointer;font-family:inherit;font-size:11px;margin-left:6px;">💰 Redeem</button>`
    : '';

  hudEl.innerHTML = `
    <span style="color:${C.hudAccent}">SCORE</span> ${state.score}
    <span style="margin:0 8px;color:rgba(255,255,255,0.2)">│</span>
    <span style="color:${C.hudWarning}">COMBO</span> ×${state.combo.toFixed(1)}
    <span style="margin:0 8px;color:rgba(255,255,255,0.2)">│</span>
    <span style="color:${C.hudAccent}">CREDITS</span> ${state.credits}
    <span style="margin:0 8px;color:rgba(255,255,255,0.2)">│</span>
    <span style="color:${C.hudDanger}">${healthHearts}</span><span style="color:rgba(255,51,85,0.3)">${healthEmpty}</span>
    <span style="margin:0 8px;color:rgba(255,255,255,0.2)">│</span>
    <span style="opacity:0.6">TICK ${state.tick}</span>
    <span style="margin:0 8px;color:rgba(255,255,255,0.2)">│</span>
    <span style="color:#ffdd44">${creditDisplay}</span>${redeemBtn}
  `;

  // Wire redeem button
  const btn = hudEl.querySelector('#hud-redeem-btn');
  if (btn) {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (redemptionUI) redemptionUI.toggle();
    });
  }
}

function drawGameOver(state) {
  ctx.fillStyle = 'rgba(0,0,0,0.65)';
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  ctx.font = 'bold 36px monospace';
  ctx.fillStyle = C.hudDanger;
  ctx.fillText('GAME OVER', CANVAS_W / 2, CANVAS_H / 2 - 40);

  ctx.font = '18px monospace';
  ctx.fillStyle = C.hudText;
  ctx.fillText(`Final Score: ${state.score}`, CANVAS_W / 2, CANVAS_H / 2);
  ctx.fillText(`Best Score:  ${state.bestScore}`, CANVAS_W / 2, CANVAS_H / 2 + 26);

  ctx.font = '14px monospace';
  ctx.fillStyle = 'rgba(255,255,255,0.6)';
  ctx.fillText('Press ENTER or SPACE to restart', CANVAS_W / 2, CANVAS_H / 2 + 62);

  // Show receipt result
  if (lastReceiptResult) {
    ctx.font = '12px monospace';
    if (lastReceiptResult.ok) {
      ctx.fillStyle = '#00ff88';
      ctx.fillText(
        `✅ Receipt verified — +${lastReceiptResult.creditsEarned} credits`,
        CANVAS_W / 2, CANVAS_H / 2 + 88
      );
    } else {
      ctx.fillStyle = 'rgba(255,255,255,0.4)';
      ctx.fillText(
        `⚠️ ${lastReceiptResult.reason || 'Receipt not submitted'}`,
        CANVAS_W / 2, CANVAS_H / 2 + 88
      );
    }
  }
}

function drawPaused() {
  ctx.fillStyle = 'rgba(0,0,0,0.45)';
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = 'bold 32px monospace';
  ctx.fillStyle = 'rgba(255,255,255,0.8)';
  ctx.fillText('⏸  PAUSED', CANVAS_W / 2, CANVAS_H / 2);
}

// ── Cleanup ──────────────────────────────────────────────────────────────────

export function destroy() {
  if (rafId) cancelAnimationFrame(rafId);
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
  economyOnline = false;
}

// ── Auto-init when not imported as a module (standalone <script> tag) ───────

if (typeof window !== 'undefined' && document.readyState !== 'loading') {
  // Will be initialised from index.html
}
