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

const DEFAULTS = {
  rows: 8,
  columns: 80,
  persistPath: null,           // null → ~/.signal-rush/state.json
  presentation: 'idle',       // 'idle' | 'play' | 'hidden'
  mode: 'aiHunt',
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
  const engine = createEngine({ mode: config.mode });
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
    // Input log for run receipts (anti-cheat)
    inputLog: [],
    // Seed used for this run (for reproducible verification)
    runSeed: config.seed || null,
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

  function tick() {
    if (!ctx.running) return;
    // When autoStep is on, advance the engine one tick before
    // drawing. We only step when the widget is focused (i.e. the
    // host has indicated the user is actually playing). This keeps
    // the simulation paused while the host is in another workflow.
    if (ctx.config.autoStep && ctx.focused && ctx.presentation === 'play' && !ctx.engine.state.gameOver) {
      ctx.engine.step({});
    }
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
        ctx.engine.state.getReadyTicks = 0;  // skip past GET READY
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
        });
        ctx.state = next;
        ctx._isNewBest = isNewBest;
        try { persistence.save(ctx.state, ctx.config.persistPath); } catch {}
      }
      ctx.mode = mode;
      // Reset engine with new mode
      const fresh = createEngine({ mode });
      ctx.engine = fresh;
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
      ctx.engine.step(input);
      // If the run ended, record it.
      if (ctx.engine.state.gameOver) {
        const { state: next, isNewBest } = persistence.recordRun(ctx.state, {
          mode: ctx.mode,
          score: ctx.engine.state.score || 0,
          level: ctx.engine.state.level || 1,
        });
        ctx.state = next;
        ctx._isNewBest = isNewBest;
        try { persistence.save(ctx.state, ctx.config.persistPath); } catch {}
        ctx._isNewBest = isNewBest;
      }
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
      };
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
