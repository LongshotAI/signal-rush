#!/usr/bin/env node

const readline = require('node:readline');
const { GAME_CONFIG } = require('../config/gameConfig');
const { createEngine } = require('../core/engine');
const { renderFrame, renderMenuFrame, MENU_MODES } = require('./render');
const { createInputBuffer } = require('./input');

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
let timer = null;
let shuttingDown = false;
let viewport = {
  columns: process.stdout.columns || 100,
  rows: process.stdout.rows || 40,
};
let nextTickAt = 0;

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
  inputBuffer = createInputBuffer();
  menuMode = false;
  if (!isDemo) inputBuffer.handleKeypress('up', { name: 'up', sequence: '\x1b[A' });
}

function returnToMenu() {
  engine = null;
  engineMode = null;
  inputBuffer = null;
  menuMode = true;
  menuSelection = 0;
  pendingMenu = false;
}

function draw() {
  refreshViewport();
  let frame;
  if (menuMode) {
    frame = renderMenuFrame(menuSelection, { colors: useColor });
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
  if (pendingQuit) {
    shutdown('Exited Signal Rush CLI.');
    return;
  }
  if (pendingMenu) {
    returnToMenu();
    draw();
    nextTickAt = Date.now() + GAME_CONFIG.tickMs;
    scheduleNextTick();
    return;
  }
  if (menuMode) {
    if (isDemo) {
      // Demo with no mode selected = default to aiHunt
      startEngine('aiHunt');
      nextTickAt = Date.now() + GAME_CONFIG.tickMs;
      scheduleNextTick();
      return;
    }
    // In menu, no per-tick work, just keep the loop alive for redraw
    nextTickAt = Date.now() + GAME_CONFIG.tickMs;
    scheduleNextTick();
    return;
  }

  const input = isDemo ? {} : inputBuffer.consume();
  if (input.quit) {
    shutdown('Exited Signal Rush CLI.');
    return;
  }
  engine.step(input);
  if (input.restart && engine.state.gameOver) {
    // R was pressed during game over — restart already happened in step()
  }
  // Check for M key (return to menu) from game over
  if (engine.state.gameOver && pendingMenu) {
    draw();
    returnToMenu();
    nextTickAt = Date.now() + GAME_CONFIG.tickMs;
    scheduleNextTick();
    return;
  }
  draw();
  if (isDemo && engine.state.tick >= 20) {
    shutdown('Signal Rush CLI demo smoke test complete.');
    return;
  }
  const elapsed = Date.now() - frameStart;
  nextTickAt += GAME_CONFIG.tickMs;
  if (nextTickAt < Date.now()) {
    nextTickAt = Date.now() + Math.max(0, GAME_CONFIG.tickMs - elapsed);
  }
  scheduleNextTick();
}

function onMenuKey(sequence, key = {}) {
  const name = (key.name || '').toLowerCase();
  const seq = typeof sequence === 'string' ? sequence.toLowerCase() : '';
  const lookup = name || seq;
  if (key.sequence === '\u0003') {
    pendingQuit = true;
    return;
  }
  if (lookup === 'q') {
    pendingQuit = true;
    return;
  }
  if (lookup === 'up' || seq === '\x1b[a') {
    menuSelection = (menuSelection + MENU_MODES.length - 1) % MENU_MODES.length;
    return;
  }
  if (lookup === 'down' || seq === '\x1b[b') {
    menuSelection = (menuSelection + 1) % MENU_MODES.length;
    return;
  }
  if (key.name === 'return' || key.name === 'enter' || seq === '\r' || seq === '\n') {
    const mode = MENU_MODES[menuSelection];
    startEngine(mode);
    nextTickAt = Date.now() + GAME_CONFIG.tickMs;
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
    if (menuMode || !inputBuffer) return;
    if (key && key.name && key.name.toLowerCase() === 'm') {
      if (engine.state.gameOver) {
        pendingMenu = true;
      }
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
  nextTickAt = Date.now() + GAME_CONFIG.tickMs;
  scheduleNextTick();
}

start();
