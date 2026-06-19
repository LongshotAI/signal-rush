#!/usr/bin/env node
// scripts/replay.js — Replay viewer for Signal Rush run receipts
//
// Usage:
//   node scripts/replay.js                    # replay latest receipt
//   node scripts/replay.js <receipt-index>    # replay specific receipt (0 = latest)
//   node scripts/replay.js --list             # list all receipts
//
// Reads receipts from ~/.signal-rush/state.json, re-simulates the run
// using the stored seed and input log, and displays the game frames.

const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');

const { createEngine } = require('../src/core/engine');
const { renderFrame } = require('../src/cli/render');

const STATE_PATH = process.env.SIGNAL_RUSH_STATE || path.join(os.homedir(), '.signal-rush', 'state.json');

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  } catch (e) {
    console.error(`Could not load state from ${STATE_PATH}: ${e.message}`);
    process.exit(1);
  }
}

function listReceipts(state) {
  const receipts = state.runReceipts || [];
  if (receipts.length === 0) {
    console.log('No run receipts found.');
    return;
  }
  console.log(`\nFound ${receipts.length} receipt(s):\n`);
  receipts.forEach((r, i) => {
    const date = r.timestamp ? new Date(r.timestamp).toLocaleString() : 'unknown';
    console.log(`  [${i}] ${r.mode} | Score: ${r.finalScore} | Level: ${r.finalLevel || 1} | Seed: ${r.seed} | ${date}`);
  });
  console.log('\nRun: node scripts/replay.js <index>');
}

function replayReceipt(receipt, fps = 10) {
  console.log(`\n▶ Replaying: ${receipt.mode} | Seed: ${receipt.seed} | Claimed Score: ${receipt.finalScore}\n`);

  const inputs = receipt.inputs || [];
  if (inputs.length === 0) {
    console.log('No input log in receipt. Cannot replay.');
    return;
  }

  const engine = createEngine({ seed: receipt.seed, mode: receipt.mode });

  // Replay each input and render key frames
  const frameInterval = Math.max(1, Math.floor(inputs.length / 30)); // ~30 frames max
  let frameCount = 0;

  for (let i = 0; i < inputs.length; i++) {
    if (engine.state.gameOver) break;
    engine.step(inputs[i]);

    // Render every Nth frame, plus the last frame and game over frame
    if (i % frameInterval === 0 || i === inputs.length - 1 || engine.state.gameOver) {
      frameCount++;
      const frame = renderFrame(engine.state, { columns: 80, rows: 24, noColor: true });
      // Print compact frame (first 8 lines)
      const lines = frame.split('\n').slice(0, 8);
      console.log(`\n--- Tick ${engine.state.tick} | Score: ${engine.state.score} ---`);
      console.log(lines.join('\n'));
    }
  }

  console.log(`\n✓ Replay complete. ${engine.state.gameOver ? 'Game Over' : 'Run ended'} at tick ${engine.state.tick}, score ${engine.state.score}`);
  console.log(`  Receipt claimed: score=${receipt.finalScore}, level=${receipt.finalLevel || 1}`);

  // Verification
  const scoreMatch = engine.state.score === receipt.finalScore;
  const levelMatch = (engine.state.level || 1) === (receipt.finalLevel || 1);
  if (scoreMatch && levelMatch) {
    console.log('  ✓ Score and level match receipt claims');
  } else {
    console.log(`  ✗ Mismatch! Simulated: score=${engine.state.score}, level=${engine.state.level || 1}`);
  }
}

// ── Main ────────────────────────────────────────────────────────────

const args = process.argv.slice(2);

if (args.includes('--list') || args.includes('-l')) {
  listReceipts(loadState());
  process.exit(0);
}

const state = loadState();
const receipts = state.runReceipts || [];

if (receipts.length === 0) {
  console.log('No run receipts found. Play a game first!');
  process.exit(0);
}

const index = args[0] ? parseInt(args[1] || args[0], 10) : 0;
const receipt = receipts[index];

if (!receipt) {
  console.error(`Receipt index ${index} not found. Use --list to see available receipts.`);
  process.exit(1);
}

replayReceipt(receipt);
