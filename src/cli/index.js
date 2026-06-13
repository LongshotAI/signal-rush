#!/usr/bin/env node

const readline = require('node:readline');
const { GAME_CONFIG } = require('../config/gameConfig');
const { createEngine } = require('../core/engine');
const { renderFrame } = require('./render');
const { createInputBuffer } = require('./input');

const args = process.argv.slice(2);
const isDemo = args.includes('--demo');

const engine = createEngine();
const inputBuffer = createInputBuffer();
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

function draw() {
  refreshViewport();
  const frame = renderFrame(engine.state, viewport);
  process.stdout.write('\x1b[H');
  process.stdout.write(frame);
  process.stdout.write('\x1b[J');
}

function shutdown(message) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (timer) clearTimeout(timer);
  process.stdin.off('keypress', inputBuffer.handleKeypress);
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
  const input = isDemo ? {} : inputBuffer.consume();
  if (input.quit) {
    shutdown('Exited Signal Rush CLI.');
    return;
  }
  engine.step(input);
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
  process.stdin.on('keypress', inputBuffer.handleKeypress);
  process.stdout.on('resize', refreshViewport);
  draw();
  nextTickAt = Date.now() + GAME_CONFIG.tickMs;
  scheduleNextTick();
}

start();
