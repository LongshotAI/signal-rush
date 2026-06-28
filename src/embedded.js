// Embedded widget entry point.
//
// This is the public surface an agent plugin (Hermes / Claude Code /
// Codex) imports. It is intentionally small and side-effect free until
// `start()` is called.
//
// Hard rules enforced here:
//   - We NEVER call setRawMode(true). The agent's TUI keeps all
//     keystrokes. We render only.
//   - We do not own the terminal. We claim a fixed bottom band via
//     scroll-region (CSI Ps;Ps r) and absolute cursor positioning.
//   - We restore the terminal on stop() AND on SIGINT/SIGTERM/uncaught.
//   - We persist via state/persistence.js so best scores survive
//     across sessions.
//
// Usage from an agent plugin:
//
//   const game = require('signal-rush-cli/embedded');
//   const w = game.start({ rows: 8, columns: 80 });
//   // When the user submits a prompt: w.show()
//   // When the agent starts streaming: w.hide()
//   // When the agent is rate-limited: w.show() and w.focus(true)
//   // On plugin unload: w.stop()
//
// `out` defaults to process.stdout. In a TUI environment the host
// may pass a different stream (e.g. a virtual buffer for tests).

const fs = require('node:fs');
const { createEngine } = require('./core/engine');
const { renderCompact } = require('./cli/renderCompact');
const persistence = require('./state/persistence');
// eventBridge is loaded lazily inside start() so that:
//   1. Test environments without a network stack still work
//   2. Hosts that pass eventBridge: false bypass it entirely
//   3. Missing /economy service degrades gracefully (queued offline)
let _eventBridge = null;
function loadEventBridge() {
  if (_eventBridge) return _eventBridge;
  try {
    _eventBridge = require('./core/eventBridge');
  } catch (e) {
    // eventBridge.js requires HTTP — if it fails (e.g., edge runtime),
    // the widget still works, just without ad/earning integration.
    _eventBridge = null;
  }
  return _eventBridge;
}

const DEFAULTS = {
  rows: 8,
  columns: 80,
  persistPath: null,           // null → ~/.signal-rush/state.json
  presentation: 'idle',       // 'idle' | 'play' | 'hidden'
  mode: 'aiHunt',
  seed: null,                 // null = non-deterministic; number/string = reproducible
  noColor: false,
  fpsCap: 15,                 // max redraws per second
  autoClearOnStop: true,
  out: null,                  // null → process.stdout
  // autoStep: when true, the widget's internal ticker calls
  // engine.step() in addition to draw(). This is opt-in: hosts that
  // want to drive the engine themselves (e.g., piping game state to a
  // remote renderer) leave this false. Standalone CLI demos set it
  // true so the game actually animates without a host loop.
  autoStep: false,
  // eventBridge: when true (default), wire the widget into the
  // economy service — fire ad impressions on every tick and forward
  // skill-based rewards on game-over. When false, the widget is a
  // pure renderer with no network side effects. Tests pass false.
  eventBridge: true,
  // Impression cadence. PLAY mode fires every N ticks (matches CLI
  // sponsorImpressionEveryTicks=40). IDLE mode fires 2.5x less
  // frequently so a non-playing widget doesn't spam the economy.
  impressionEveryTicksPlay: 40,
  impressionEveryTicksIdle: 100,
  // Fetch claimable reward balance every N ticks during PLAY so the
  // HUD can display "X µ claimable" without re-fetching on every render.
  rewardFetchEveryTicks: 80,
  // `lifecycle` is an optional hook object. The host can plug in
  // callbacks so the widget knows when to auto-show/hide. These are
  // documentation-grade stubs; the host is expected to call
  // widget.show() / widget.hide() directly in their event loop.
};

function start(opts = {}) {
  if (start.singleton) {
    // Idempotent: if a widget is already running, return it.
    return start.singleton;
  }
  const config = { ...DEFAULTS, ...opts };
  if (!config.out) config.out = process.stdout;
  if (!config.persistPath) config.persistPath = persistence.resolvePath();
  // Validate mode up front so we don't end up with a half-initialised
  // engine that the renderer can't display.
  if (config.mode !== 'aiHunt' && config.mode !== 'frogger') {
    throw new Error(`embedded.start: invalid mode '${config.mode}', expected 'aiHunt' or 'frogger'`);
  }
  // Clamp the row budget up front. The renderer's minimum is 4; if
  // the caller passes rows=2 we'd otherwise end up with a 2-row ctx
  // drawing a 4-row frame and visually overflowing.
  config.rows = Math.max(4, Math.min(12, Math.floor(Number(config.rows) || DEFAULTS.rows)));
  config.columns = Math.max(40, Math.min(120, Math.floor(Number(config.columns) || DEFAULTS.columns)));

  const persisted = persistence.load(config.persistPath);
  const engine = createEngine({ mode: config.mode, seed: config.seed });
  const ctx = {
    config,
    engine,
    state: persisted,
    running: true,
    presentation: config.presentation,
    mode: config.mode,
    // `focused` means the widget currently has the agent's attention
    // and is allowed to step the engine. Default: true so a freshly
    // started widget looks "live" rather than dimmed. Hosts should
    // call focus(false) when they need the attention back (e.g., user
    // is typing a new prompt).
    focused: true,
    width: config.columns,
    height: config.rows,
    raf: null,
    lastDrawn: 0,
    listeners: [],
    // Anti-cheat: log every input the engine receives during a run,
    // so persistence can build a receipt for verification.
    // Cap to prevent memory growth in long sessions / AI Hunt auto-play.
    inputLog: [],
    maxInputLog: 1000,
    // Seed used for the current run (for reproducible verification).
    runSeed: config.seed || null,
    // ── Economy integration state ──────────────────────────────────
    // playerId is resolved lazily on first use so the persistence
    // file write side-effect doesn't run at module import time.
    playerId: null,
    // Tick counters for cadence-controlled impression firing.
    // impressionTickCounter: incremented on every tick(); impression
    //   fires when this hits the per-mode interval.
    // rewardFetchTickCounter: incremented on every tick(); reward
    //   balance is fetched when this hits rewardFetchEveryTicks.
    impressionTickCounter: 0,
    rewardFetchTickCounter: 0,
    // Last-known reward balance (claimable micros). Displayed in HUD
    // when > 0. Updated by fetchRewardBalance().
    rewardBalanceMicros: 0,
    // Diagnostic: how many impressions the widget has fired in this
    // session. Exposed via getStats() for the plugin / dashboards.
    impressionCount: 0,
    // Track the previous gameOver flag so we can detect the transition
    // 0 → 1 and fire the interstitial impression + forwardReward only
    // once per death.
    lastGameOver: false,
  };

  function isTTY() {
    return ctx.config.out && typeof ctx.config.out.isTTY === 'boolean' ? ctx.config.out.isTTY : false;
  }

  function write(s) {
    if (!ctx.config.out || !ctx.config.out.write) return;
    try { ctx.config.out.write(s); } catch (e) { /* stream closed */ }
  }

  // Claim a fixed bottom band. We set the host's scroll region to
  // rows-1..terminalHeight so the host can write to everything above
  // our band. We position the cursor at the start of our band before
  // each redraw.
  function setScrollRegion() {
    if (!isTTY()) return;
    // \x1b[?25l  hide cursor
    // \x1b[<rows>;<cols>r  set scroll region to (rows..cols) of full
    //                    screen. The host sees only the upper area.
    // \x1b[H    cursor home
    const termHeight = ctx.config.out.rows || process.stdout.rows || 24;
    const top = Math.max(1, termHeight - ctx.height + 1);
    write(`\x1b[?25l\x1b[${top};${termHeight}r`);
  }

  function restoreScrollRegion() {
    if (!isTTY()) return;
    // Restore: full screen scroll region, show cursor, reset attrs.
    write(`\x1b[r\x1b[?25h\x1b[0m`);
  }

  function positionCursor() {
    if (!isTTY()) return;
    const termHeight = ctx.config.out.rows || process.stdout.rows || 24;
    const top = Math.max(1, termHeight - ctx.height + 1);
    write(`\x1b[${top};1H`);
  }

  function draw() {
    const now = Date.now();
    const minInterval = 1000 / Math.max(1, ctx.config.fpsCap);
    // Rate-limit only the ticker; explicit calls (show/hide/focus/stop)
    // bypass via the forceDraw path so user actions are never silently
    // dropped on the floor.
    if (now - ctx.lastDrawn < minInterval && !ctx._forceDraw) return;
    ctx.lastDrawn = now;
    ctx._forceDraw = false;
    const mode = ctx.mode;
    // Get latest engine state. If focused, drive the engine forward.
    const stats = {
      best: ctx.state.bestScores[mode] || 0,
    };
    let engineState = null;
    if (ctx.presentation !== 'hidden') {
      engineState = ctx.engine.state;
      // Detect a new best in this state
      if (Number.isFinite(engineState?.score) && engineState.score > (stats.best || 0)) {
        stats.best = engineState.score;
      }
    }
    const { lines } = renderCompact(engineState, ctx.presentation, {
      rows: ctx.height,
      cols: ctx.width,
      noColor: ctx.config.noColor,
      stats,
      isNewBest: ctx._isNewBest === true,
      focus: ctx.focused,
    });
    positionCursor();
    // Erase our band first
    for (let i = 0; i < ctx.height; i += 1) write('\x1b[2K');
    positionCursor();
    for (const l of lines) write(l + '\n');
  }

  // ── Economy bridge ────────────────────────────────────────────
  // Lazy-load eventBridge on first use so that:
  //   - Tests don't crash if the economy service is unreachable
  //   - Hosts that disable eventBridge incur zero load overhead
  //   - The widget can still render when the economy is down
  // Returns the eventBridge module or null.
  function getBridge() {
    if (!ctx.config.eventBridge) return null;
    return loadEventBridge();
  }

  // Resolve the persistent CLI player UUID. eventBridge writes it to
  // ~/.signal-rush/player.json on first call. We cache it in ctx so
  // subsequent fires don't re-read the file.
  function getPlayerId() {
    if (ctx.playerId) return ctx.playerId;
    const bridge = getBridge();
    if (!bridge) return null;
    try {
      ctx.playerId = bridge.getPlayerId();
    } catch (e) {
      ctx.playerId = null;
    }
    return ctx.playerId;
  }

  // Fire a hud_frame impression. Safe to call at any cadence — the
  // bridge handles offline queueing and rate limiting.
  function fireHudImpression() {
    const bridge = getBridge();
    if (!bridge) return;
    const pid = getPlayerId();
    if (!pid) return;
    try {
      // Fire-and-forget — never blocks the game loop.
      bridge.logAdImpression(pid, 'hud_frame').catch(() => {});
      ctx.impressionCount += 1;
    } catch (e) { /* swallow */ }
  }

  // Fire an interstitial impression (high-value placement, used at
  // game-over and on transitions to PLAY from idle).
  function fireInterstitialImpression() {
    const bridge = getBridge();
    if (!bridge) return;
    const pid = getPlayerId();
    if (!pid) return;
    try {
      bridge.logAdImpression(pid, 'interstitial').catch(() => {});
      ctx.impressionCount += 1;
    } catch (e) { /* swallow */ }
  }

  // Forward end-of-run skill-based reward. Returns the amount in
  // micros if the economy service responds; null on failure.
  function forwardEndOfRunReward() {
    const bridge = getBridge();
    if (!bridge) return;
    const pid = getPlayerId();
    if (!pid) return;
    const engine = ctx.engine;
    if (!engine || !engine.state) return;
    const s = engine.state;
    try {
      const diffTier = typeof s.difficultyTier === 'number'
        ? s.difficultyTier
        : Math.min(8, Math.floor((s.tick || 0) / 100));
      bridge.forwardReward(pid, {
        score: s.score || 0,
        combo: s.combo || 0,
        level: s.level || 1,
        tickCount: s.tick || 0,
        difficultyTier: diffTier,
      }).catch(() => {});
    } catch (e) { /* swallow */ }
  }

  // Fetch the player's current claimable reward balance and cache it
  // on ctx.rewardBalanceMicros. Read by renderCompact's status line.
  function fetchRewardBalance() {
    const bridge = getBridge();
    if (!bridge) return;
    const pid = getPlayerId();
    if (!pid) return;
    try {
      bridge.fetchRewardBalance(pid).then((data) => {
        if (data && typeof data.available_micros === 'number') {
          ctx.rewardBalanceMicros = data.available_micros;
        }
      }).catch(() => {});
    } catch (e) { /* swallow */ }
  }

  // Detect gameOver transition and fire the high-value events.
  // Idempotent — only fires once per death.
  function maybeFireGameOverEvents() {
    if (ctx.lastGameOver) return;
    if (!ctx.engine || !ctx.engine.state || !ctx.engine.state.gameOver) return;
    ctx.lastGameOver = true;
    fireInterstitialImpression();
    forwardEndOfRunReward();
  }

  // ── Economy-side ticker ────────────────────────────────────────
  // Independent of the isTTY-gated render ticker. Fires impressions
  // and fetches reward balance on a wall-clock schedule so non-TTY
  // hosts (Telegram bot, CI, background cron, headless daemon) get
  // the same ad-revenue cadence as a TTY user.
  //
  // Without this, a widget spawned by a non-TTY host (which is the
  // common case for agent plugins) would render correctly but never
  // fire impressions — silently losing 100% of ad revenue.
  //
  // Cadence: 4 wall-clock seconds between PLAY impressions (~50% of
  // the 40-tick TTY cadence at 80ms/tick), 10s between IDLE impressions
  // (less frequent because the user is not actively playing).
  const IMPRESSION_INTERVAL_PLAY_MS = 4000;
  const IMPRESSION_INTERVAL_IDLE_MS = 10000;
  const REWARD_FETCH_INTERVAL_MS = 8000;
  let _impressionInterval = null;
  let _lastImpressionFiredAt = 0;
  let _lastRewardFetchAt = 0;

  function startEconomyTicker() {
    if (_impressionInterval) return; // already running
    _impressionInterval = setInterval(() => {
      if (!ctx.running) return;
      if (ctx.presentation === 'hidden') return;
      const now = Date.now();
      const intervalMs = ctx.presentation === 'play'
        ? IMPRESSION_INTERVAL_PLAY_MS
        : IMPRESSION_INTERVAL_IDLE_MS;
      if (now - _lastImpressionFiredAt >= intervalMs) {
        _lastImpressionFiredAt = now;
        fireHudImpression();
      }
      if (ctx.presentation === 'play' && now - _lastRewardFetchAt >= REWARD_FETCH_INTERVAL_MS) {
        _lastRewardFetchAt = now;
        fetchRewardBalance();
      }
      // Game-over transition detection — fire interstitial + reward
      // once per death (idempotent via lastGameOver flag).
      maybeFireGameOverEvents();
    }, 1000);
  }

  function stopEconomyTicker() {
    if (_impressionInterval) {
      clearInterval(_impressionInterval);
      _impressionInterval = null;
    }
  }

  function tick() {
    if (!ctx.running) return;
    // When autoStep is on, advance the engine one tick before
    // drawing. We only step when the widget is focused (i.e. the
    // host has indicated the user is actually playing). This keeps
    // the simulation paused while the host is in another workflow.
    if (ctx.config.autoStep && ctx.focused && ctx.presentation === 'play' && !ctx.engine.state.gameOver) {
      if (ctx.inputLog.length < ctx.maxInputLog) ctx.inputLog.push({});
      ctx.engine.step({});
    }

    // ── Cadence-controlled impression firing ────────────────────────
    // PLAY mode: every impressionEveryTicksPlay ticks
    // IDLE mode (visible, not hidden, not playing): every
    //   impressionEveryTicksIdle ticks — gentler so non-playing
    //   widgets don't spam the economy service.
    // HIDDEN: never fires (widget isn't visible).
    // The widget earns impressions on its own tick boundary, NOT on
    // the engine's tick counter, because the widget tick rate is
    // ~12 fps and we want time-based impressions, not gameplay-based.
    if (ctx.presentation !== 'hidden') {
      ctx.impressionTickCounter += 1;
      const interval = ctx.presentation === 'play'
        ? ctx.config.impressionEveryTicksPlay
        : ctx.config.impressionEveryTicksIdle;
      if (interval > 0 && ctx.impressionTickCounter >= interval) {
        ctx.impressionTickCounter = 0;
        fireHudImpression();
      }
      if (ctx.presentation === 'play' && ctx.config.rewardFetchEveryTicks > 0) {
        ctx.rewardFetchTickCounter += 1;
        if (ctx.rewardFetchTickCounter >= ctx.config.rewardFetchEveryTicks) {
          ctx.rewardFetchTickCounter = 0;
          fetchRewardBalance();
        }
      }
    }

    // Game-over transition detection — fire interstitial + reward once.
    maybeFireGameOverEvents();

    draw();
    ctx.raf = setTimeout(tick, 80);
  }

  function resize() {
    const termHeight = ctx.config.out.rows || process.stdout.rows || 24;
    const termWidth = ctx.config.out.columns || process.stdout.columns || 80;
    // Adapt widget height to no more than 1/3 of the terminal, capped.
    // Also honor the explicit rows request.
    const requested = ctx.config.rows;
    const adaptive = Math.max(4, Math.min(12, Math.floor(termHeight / 3)));
    ctx.height = Math.min(requested, adaptive, termHeight - 4);
    ctx.width = Math.max(40, Math.min(120, termWidth - 1));
    setScrollRegion();
    draw();
  }

  function onResize() { resize(); }
  function onSigInt() { stop(); }
  function onSigTerm() { stop(); }
  function onExit() { stop(); }

  ctx.listeners.push({ target: ctx.config.out, event: 'resize', fn: onResize });
  ctx.listeners.push({ target: process, event: 'SIGINT', fn: onSigInt });
  ctx.listeners.push({ target: process, event: 'SIGTERM', fn: onSigTerm });
  // process 'exit' doesn't allow async, but restoreScrollRegion is sync.
  ctx.listeners.push({ target: process, event: 'exit', fn: onExit });
  for (const l of ctx.listeners) {
    try { l.target.on(l.event, l.fn); } catch (e) { /* listener attach failed */ }
  }

  // Public API
  const widget = {
    show() {
      ctx.presentation = 'idle';
      ctx._forceDraw = true;
      draw();
    },
    hide() {
      ctx.presentation = 'hidden';
      ctx._forceDraw = true;
      draw();
    },
    focus(on = true) {
      ctx.focused = !!on;
      if (on) {
        ctx.presentation = 'play';
        // NOTE: We skip GET READY here because focus(true) means "the user
        // is actively playing right now" — the host should only call this
        // when the player is ready to go. If you want GET READY to run,
        // use setPresentation('play') instead, which preserves the countdown.
        ctx.engine.state.getReadyTicks = 0;
        // Allow the next gameOver to fire fresh interstitial + reward.
        ctx.lastGameOver = false;
      } else {
        ctx.presentation = 'idle';
      }
      ctx._forceDraw = true;
      draw();
    },
    pause() {
      ctx.running = false;
      if (ctx.raf) clearTimeout(ctx.raf);
    },
    resume() {
      if (ctx.running) return;
      ctx.running = true;
      tick();
    },
    setMode(mode) {
      if (mode !== 'aiHunt' && mode !== 'frogger') return false;
      if (ctx.mode === mode) return true;
      // Persist the current run before switching.
      if (ctx.engine.state.score > 0 || ctx.engine.state.credits > 0) {
        const { state: next, isNewBest } = persistence.recordRun(ctx.state, {
          mode: ctx.mode,
          score: ctx.engine.state.score || 0,
          level: ctx.engine.state.level || 1,
          seed: ctx.runSeed,
          inputs: ctx.inputLog,
          finalState: { ...ctx.engine.state },
        });
        ctx.state = next;
        ctx._isNewBest = isNewBest;
        try { persistence.save(ctx.state, ctx.config.persistPath); } catch {}
      }
      ctx.mode = mode;
      // Reset engine with new mode, preserving seed for reproducible receipt chains
      const fresh = createEngine({ mode, seed: ctx.runSeed });
      ctx.engine = fresh;
      // Reset input log for the new run
      ctx.inputLog = [];
      // Reset gameOver transition tracker so the new run can fire its
      // own interstitial impression on death.
      ctx.lastGameOver = false;
      ctx._forceDraw = true;
      draw();
      return true;
    },
    setPresentation(p) {
      if (!['idle', 'play', 'hidden'].includes(p)) return false;
      ctx.presentation = p;
      ctx._forceDraw = true;
      draw();
      return true;
    },
    // Step the engine one tick with optional input. Host can call this
    // to advance the simulation when focus is on.
    step(input = {}) {
      // Log input for run receipt (anti-cheat)
      if (ctx.inputLog.length < ctx.maxInputLog) ctx.inputLog.push(input);
      ctx.engine.step(input);
      // If the run ended, record it with full receipt data.
      if (ctx.engine.state.gameOver) {
        const { state: next, isNewBest, receipt } = persistence.recordRun(ctx.state, {
          mode: ctx.mode,
          score: ctx.engine.state.score || 0,
          level: ctx.engine.state.level || 1,
          seed: ctx.runSeed,
          inputs: ctx.inputLog,
          finalState: { ...ctx.engine.state },
        });
        ctx.state = next;
        ctx._isNewBest = isNewBest;
        try { persistence.save(ctx.state, ctx.config.persistPath); } catch {}
        ctx._isNewBest = isNewBest;
        // Reset input log for next run
        ctx.inputLog = [];
        // Fire interstitial impression + skill-based reward once on the
        // 0→1 gameOver transition. Idempotent via maybeFireGameOverEvents.
        maybeFireGameOverEvents();
      } else {
        // Reset the lastGameOver flag on every non-gameOver step so the
        // next death can fire fresh events.
        ctx.lastGameOver = false;
      }
    },
    // ── Input adapter for non-TTY hosts (Telegram inline keyboards,
    // chat commands, web UI buttons, etc.) ────────────────────────
    // The widget never calls setRawMode — keystrokes are owned by the
    // host TUI. To play from a non-TTY environment, the host calls
    // widget.input('up' | 'down' | 'left' | 'right' | 'dash' | 'pause'
    //               | 'restart' | 'menu')
    // and the widget translates that into the engine's input shape.
    //
    // Returns true if the input was understood, false on invalid input.
    // On invalid input, the engine is NOT stepped (cheap, safe no-op).
    input(action) {
      if (typeof action !== 'string') return false;
      const a = action.toLowerCase();
      // NOTE: We do NOT trim() the input — single-space actions (' ')
      // are valid (e.g. Space key for dash) and would be lost to trim.
      // Idle widget: only 'play' / 'enter' transitions to PLAY mode.
      if (ctx.presentation === 'idle') {
        if (a === 'play' || a === 'enter') {
          ctx.focused = true;
          ctx.presentation = 'play';
          ctx.engine.state.getReadyTicks = 0;
          ctx.lastGameOver = false;
          ctx._forceDraw = true;
          draw();
          return true;
        }
        // Any other input in idle is a no-op — user must opt in.
        return false;
      }
      // Hidden widget: inputs ignored entirely.
      if (ctx.presentation === 'hidden') return false;
      // Translate action → engine input shape.
      let engineInput = null;
      switch (a) {
        case 'up':
        case 'w':
          engineInput = { move: { x: 0, y: -1 } };
          break;
        case 'down':
        case 's':
          engineInput = { move: { x: 0, y: 1 } };
          break;
        case 'left':
        case 'a':
          engineInput = { move: { x: -1, y: 0 } };
          break;
        case 'right':
        case 'd':
          engineInput = { move: { x: 1, y: 0 } };
          break;
        case 'dash':
        case ' ':
        case 'space':
        case 'j':
          engineInput = { dash: true };
          break;
        case 'pause':
        case 'p':
          engineInput = { pause: true };
          break;
        case 'restart':
        case 'r':
          engineInput = { restart: true };
          break;
        case 'menu':
        case 'm':
        case 'esc':
        case 'escape':
          // Menu returns to idle (caller may then call stop()).
          ctx.presentation = 'idle';
          ctx.focused = false;
          ctx._forceDraw = true;
          draw();
          return true;
        case 'play':
        case 'enter':
          // Already playing — no-op.
          return true;
        default:
          return false;
      }
      if (engineInput) {
        widget.step(engineInput);
        ctx._forceDraw = true;
        draw();
        return true;
      }
      return false;
    },
    getStats() {
      return {
        bestScores: { ...ctx.state.bestScores },
        bestLevels: { ...ctx.state.bestLevels },
        totalRuns: { ...ctx.state.totalRuns },
        lastPlayedAt: ctx.state.lastPlayedAt,
        lastMode: ctx.state.lastMode,
        presentation: ctx.presentation,
        mode: ctx.mode,
        focused: ctx.focused,
        // Economy integration diagnostics (zero values mean disabled
        // or the economy service is unreachable — never an error).
        playerId: ctx.playerId,
        impressionCount: ctx.impressionCount,
        rewardBalanceMicros: ctx.rewardBalanceMicros,
        eventBridgeEnabled: ctx.config.eventBridge === true,
      };
    },
    getPlayerId,
    setPlayerId(id) {
      if (id && typeof id === 'string' && /^[0-9a-f-]{36}$/.test(id)) {
        ctx.playerId = id;
        return true;
      }
      return false;
    },
    getEngineState() { return ctx.engine.state; },
    setRows(n) {
      const r = Math.max(4, Math.min(12, Math.floor(n)));
      ctx.config.rows = r;
      resize();
    },
    stop,
    // For tests
    _internal: { ctx, draw, restoreScrollRegion, setScrollRegion },
  };

  function stop() {
    if (!ctx.running && !start.singleton) return;
    ctx.running = false;
    if (ctx.raf) clearTimeout(ctx.raf);
    stopEconomyTicker();
    if (ctx.config.autoClearOnStop) {
      // Erase our band
      for (let i = 0; i < ctx.height; i += 1) write('\x1b[2K');
    }
    restoreScrollRegion();
    // Detach listeners
    for (const l of ctx.listeners) {
      try { l.target.off(l.event, l.fn); } catch (e) {}
    }
    // Persist any in-progress run as a final record (best-effort)
    if (ctx.engine && ctx.engine.state) {
      try {
        const { state: next } = persistence.recordRun(ctx.state, {
          mode: ctx.mode,
          score: ctx.engine.state.score || 0,
          level: ctx.engine.state.level || 1,
          seed: ctx.runSeed,
          inputs: ctx.inputLog,
          finalState: { ...ctx.engine.state },
        });
        persistence.save(next, ctx.config.persistPath);
      } catch (e) { /* best-effort */ }
    }
    start.singleton = null;
  }

  // Start
  setScrollRegion();
  draw();
  if (isTTY()) tick();
  else {
    // Non-TTY: single draw, no ticker (e.g., piped output, tests)
    draw();
  }
  // Economy ticker is ALWAYS started, regardless of isTTY. The
  // render ticker is TTY-gated (no point redrawing a non-TTY host),
  // but impressions and reward fetches must fire on a wall-clock
  // schedule in ALL environments to keep ad-revenue flowing.
  // Cadence constants are inside startEconomyTicker.
  startEconomyTicker();

  start.singleton = widget;
  return widget;
}

// Test-only: clear the singleton so the next start() creates a fresh
// widget. Useful when a test failed mid-way and left a live widget
// behind. Production code should never need this.
function _resetForTests() {
  if (start.singleton) {
    try { start.singleton.stop(); } catch (e) { /* swallow */ }
  }
  start.singleton = null;
}

module.exports = { start, persistence, renderCompact, _resetForTests };
