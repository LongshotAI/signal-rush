#!/usr/bin/env node

const { randomUUID } = require('crypto');
const readline = require('node:readline');
const { GAME_CONFIG, getTickMsForMode } = require('../config/gameConfig');
const { createEngine } = require('../core/engine');
const { renderFrame, renderMenuFrame, buildInterstitialFrame, MENU_MODES } = require('./render');
const { createInputBuffer } = require('./input');
const { applyMenuKey } = require('./menuKeyHandler');
const eventBridge = require('../core/eventBridge');
const { getCampaign, fetchActiveCampaigns, apiCampaignToSponsor, setActiveCampaigns } = require('../content/sponsors');

const args = process.argv.slice(2);
const isDemo = args.includes('--demo');
const useColor = !args.includes('--no-color');

const modeArg = args.find((a) => a.startsWith('--mode='));
const initialMode = modeArg ? modeArg.split('=')[1] : null;

let engine = null;
let engineMode = null;       // null = menu, 'aiHunt' | 'frogger' = in game
let inputBuffer = null;
let menuSelection = 0;        // 0 = aiHunt, 1 = frogger
let menuMode = true;          // true until user picks a mode
let pendingMenu = false;      // true after game-over + M to schedule return to menu
let pendingQuit = false;
let showInterstitial = false; // true when interstitial sponsor card is displayed
let interstitialTimer = null; // auto-dismiss timer for interstitial
let timer = null;
let shuttingDown = false;
let viewport = {
  columns: process.stdout.columns || 100,
  rows: process.stdout.rows || 40,
};
let nextTickAt = 0;

// Economy bridge state — only active when not in demo mode
let economyPlayerId = null;
let economySessionId = null;

function enterScreen() {
  process.stdout.write('\x1b[?1049h\x1b[?25l\x1b[H');
}

function exitScreen() {
  process.stdout.write('\x1b[?25h\x1b[0m\x1b[?1049l');
}

function refreshViewport() {
  viewport = {
    columns: process.stdout.columns || 100,
    rows: process.stdout.rows || 40,
  };
}

function startEngine(mode) {
  engine = createEngine({ mode });
  engineMode = mode;
  // Frogger wants discrete hops (tap to hop, then stop); AI Hunt wants
  // continuous movement (hold to glide). The singleShot flag on the
  // input buffer toggles the first behaviour on.
  inputBuffer = createInputBuffer({ singleShot: mode === 'frogger' });
  menuMode = false;
  showInterstitial = false;
  if (interstitialTimer) {
    clearTimeout(interstitialTimer);
    interstitialTimer = null;
  }
  if (!isDemo) inputBuffer.handleKeypress('up', { name: 'up', sequence: '\x1b[A' });

  // Initialize economy session for this run (only in non-demo mode)
  if (!isDemo) {
    if (!economyPlayerId) {
      economyPlayerId = eventBridge.getPlayerId();
    }
    // New session for each run — enables per-run tracking
    economySessionId = randomUUID();
  }
}

function returnToMenu() {
  engine = null;
  engineMode = null;
  inputBuffer = null;
  menuMode = true;
  menuSelection = 0;
  pendingMenu = false;
  showInterstitial = false;
  if (interstitialTimer) {
    clearTimeout(interstitialTimer);
    interstitialTimer = null;
  }
}

function draw() {
  refreshViewport();
  let frame;
  if (menuMode) {
    frame = renderMenuFrame(menuSelection, { colors: useColor });
  } else if (showInterstitial && engine) {
    frame = buildInterstitialFrame(engine.state, viewport, { colors: useColor });
  } else {
    frame = renderFrame(engine.state, viewport, { colors: useColor });
  }
  process.stdout.write('\x1b[H');
  process.stdout.write(frame);
  process.stdout.write('\x1b[J');
}

function shutdown(message) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (timer) clearTimeout(timer);
  if (interstitialTimer) clearTimeout(interstitialTimer);
  if (inputBuffer) process.stdin.off('keypress', inputBuffer.handleKeypress);
  process.stdin.off('keypress', onMenuKey);
  process.stdout.off('resize', refreshViewport);
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  process.stdin.pause();
  exitScreen();
  if (message) {
    console.log(message);
  }
  process.exit(0);
}

function scheduleNextTick() {
  if (shuttingDown) return;
  const now = Date.now();
  const delay = Math.max(0, nextTickAt - now);
  timer = setTimeout(step, delay);
}

function step() {
  const frameStart = Date.now();
  // Centralised tick rate so Frogger runs slower than AI Hunt.
  const tickMs = getTickMsForMode(engineMode);
  if (pendingQuit) {
    shutdown('Exited Signal Rush CLI.');
    return;
  }
  if (pendingMenu) {
    // Return-to-menu path: clear the engine first, THEN draw — so the
    // user sees the menu, not one last frame of the game they just left.
    // The previous ordering (draw -> returnToMenu) made the game over
    // card flash for one tick before the menu appeared, and the
    // subsequent \x1b[J clear left artifacts from the taller game frame.
    returnToMenu();
    draw();
    nextTickAt = Date.now() + getTickMsForMode(null);
    scheduleNextTick();
    return;
  }
  if (menuMode) {
    if (isDemo) {
      // Demo with no mode selected = default to aiHunt
      startEngine('aiHunt');
      nextTickAt = Date.now() + getTickMsForMode('aiHunt');
      scheduleNextTick();
      return;
    }
    // In menu: redraw every tick so animations (cursor blink, preview
    // motion) keep flowing. Without this, the menu would only refresh
    // on keypresses — which made up/down feel like nothing was happening.
    draw();
    nextTickAt = Date.now() + getTickMsForMode(null);
    scheduleNextTick();
    return;
  }

  const input = isDemo ? {} : inputBuffer.consume();
  if (input.quit) {
    shutdown('Exited Signal Rush CLI.');
    return;
  }

  // Capture credits BEFORE step() for diffing — the bridge compares
  // engine.state.credits after vs before to catch ALL credit changes
  // (pickups, slots, level clears) regardless of engine events.
  const creditsBefore = (!isDemo && economyPlayerId && economySessionId)
    ? engine.state.credits : 0;

  engine.step(input);

  // Forward events to economy service (non-demo mode only).
  // Fire-and-forget: if the economy service is down, events are queued
  // locally and retried later. Gameplay is NEVER blocked.
  if (!isDemo && economyPlayerId && economySessionId) {
    eventBridge.forwardStep(economyPlayerId, economySessionId, engine, creditsBefore)
      .catch(() => {}); // already handled inside bridge
  }

  // Log ad impressions from engine events.
  // sponsor_impression fires every 40 ticks; interstitial_impression fires
  // when the interstitial is shown. Both are fire-and-forget.
  if (!isDemo && economyPlayerId) {
    const events = engine.state.lastEvents || [];
    for (const event of events) {
      if (event.type === 'sponsor_impression') {
        const campaignId = getCampaign().id || null;
        eventBridge.logAdImpression(economyPlayerId, 'hud_frame', campaignId)
          .catch(() => {});
      }
    }
  }

  // Trigger interstitial on first game over tick.
  // The interstitial shows the sponsor card before the restart prompt.
  if (engine.state.gameOver && !showInterstitial && !pendingMenu) {
    showInterstitial = true;
    // Auto-dismiss after 3 seconds if no keypress
    if (interstitialTimer) clearTimeout(interstitialTimer);
    interstitialTimer = setTimeout(() => {
      showInterstitial = false;
      draw();
    }, 3000);
  }

  // pendingMenu is set by the M keypress handler at any time (gameplay,
  // pause, game over). Honour it here regardless of gameOver state so
  // the player can always bail back to the menu mid-run.
  if (pendingMenu) {
    returnToMenu();
    draw();
    nextTickAt = Date.now() + getTickMsForMode(null);
    scheduleNextTick();
    return;
  }
  draw();
  if (isDemo && engine.state.tick >= 20) {
    shutdown('Signal Rush CLI demo smoke test complete.');
    return;
  }
  const elapsed = Date.now() - frameStart;
  nextTickAt += tickMs;
  if (nextTickAt < Date.now()) {
    nextTickAt = Date.now() + Math.max(0, tickMs - elapsed);
  }
  scheduleNextTick();
}

function onMenuKey(sequence, key = {}) {
  // The menu keypress handler must only act while we are on the menu.
  // Otherwise it would intercept game-input keys (WASD/arrows/Enter/Q)
  // and silently mutate menuSelection, which made menu navigation look
  // broken AND meant pressing Enter mid-game could swap the active mode.
  // The pure keypress logic is in menuKeyHandler.js so it can be unit
  // tested without a real terminal.
  const result = applyMenuKey(
    { menuMode, menuSelection, menuLength: MENU_MODES.length },
    sequence,
    key
  );
  let selectionChanged = result.menuSelection !== menuSelection;
  let modeChanged = result.menuMode !== menuMode;
  menuSelection = result.menuSelection;
  menuMode = result.menuMode;
  if (result.action === 'quit') {
    pendingQuit = true;
  } else if (result.action === 'select') {
    startEngine(MENU_MODES[menuSelection]);
    nextTickAt = Date.now() + getTickMsForMode(MENU_MODES[menuSelection]);
  }
  if (selectionChanged || modeChanged || result.action !== 'noop') {
    // Trigger an immediate redraw so the user sees the cursor move /
    // the new mode launch without waiting for the next tick. Without
    // this call the menu would only refresh on the 120ms tick boundary
    // and navigation felt broken.
    draw();
  }
}

function bindExitGuards() {
  process.on('SIGINT', () => shutdown('Exited Signal Rush CLI.'));
  process.on('SIGTERM', () => shutdown());
  process.on('uncaughtException', (error) => {
    exitScreen();
    console.error(error);
    process.exit(1);
  });
}

function start() {
  bindExitGuards();
  enterScreen();
  readline.emitKeypressEvents(process.stdin);
  if (!isDemo && process.stdin.isTTY) {
    process.stdin.setRawMode(true);
  }
  process.stdin.resume();
  process.stdin.on('keypress', onMenuKey);
  process.stdin.on('keypress', (seq, key) => {
    // Interstitial dismiss: any keypress during interstitial shows game-over frame
    if (showInterstitial) {
      showInterstitial = false;
      if (interstitialTimer) {
        clearTimeout(interstitialTimer);
        interstitialTimer = null;
      }
      draw();
      return;
    }
    if (menuMode || !inputBuffer) return;
    if (key && key.name && key.name.toLowerCase() === 'm') {
      // M works at any time — gameplay, pause, or game over — so the
      // player can always bail back to the menu. The previous behaviour
      // required the player to die first, which made the menu feel
      // unreachable in the middle of a run.
      pendingMenu = true;
      return;
    }
    inputBuffer.handleKeypress(seq, key);
  });
  process.stdout.on('resize', refreshViewport);

  if (initialMode) {
    // --mode=aiHunt|frogger skips the menu
    startEngine(initialMode);
  } else if (isDemo) {
    // demo runs aiHunt by default for backward compat
    startEngine('aiHunt');
  }
  // else: stay on menu, wait for user input

  draw();
  nextTickAt = Date.now() + getTickMsForMode(initialMode || (isDemo ? 'aiHunt' : null));
  scheduleNextTick();

  // Fetch active campaigns from the economy service.
  // Fire-and-forget: if the service is down or slow, the static CAMPAIGNS
  // fallback is already in place. The fetch resolves async and updates
  // the active campaign for all subsequent renders.
  //
  // Only campaigns with at least one approved logo creative uploaded will
  // override the static USP × Temple Works fallback. This ensures the
  // game always shows a polished sponsor experience — no generic block
  // letters, no placeholder text.
  if (!isDemo) {
    fetchActiveCampaigns().then((campaigns) => {
      if (campaigns && campaigns.length > 0) {
        // Filter to campaigns with logo creatives BEFORE converting.
        const withLogos = campaigns.filter(c =>
          c.creatives && c.creatives.some(cr => cr.type === 'logo')
        );
        if (withLogos.length > 0) {
          const sponsorData = withLogos.map((c) => apiCampaignToSponsor(c));
          setActiveCampaigns(sponsorData);
        }
      }
    }).catch(() => {
      // Static fallback already in place — nothing to do.
    });
  }
}

start();
