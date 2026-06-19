#!/usr/bin/env node
// scripts/replay-test.js — Test the replay viewer
//
// Creates a game with a known seed, generates a receipt, saves it to
// a temp state file, then runs the replay script and verifies output.

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

const { createEngine } = require('../src/core/engine');

function tmpStatePath() {
  return path.join(os.tmpdir(), `signal-rush-replay-${process.pid}-${Date.now()}.json`);
}

function cleanup(p) { try { fs.unlinkSync(p); } catch {} }

function testReplayGeneratesFrames() {
  // Create a game and manually build a receipt
  const seed = 7777;
  const engine = createEngine({ mode: 'aiHunt', seed });
  const inputs = [];

  // Play 30 ticks
  for (let i = 0; i < 30; i++) {
    if (engine.state.gameOver) break;
    const input = { move: { x: 1, y: 0 } };
    inputs.push(input);
    engine.step(input);
  }

  // Build a receipt
  const receipt = {
    version: 1,
    timestamp: new Date().toISOString(),
    seed,
    mode: 'aiHunt',
    inputCount: inputs.length,
    inputs,
    finalScore: engine.state.score,
    finalLevel: engine.state.level || 1,
    signature: 'test-skip-verification',
  };

  // Write to temp state file
  const statePath = tmpStatePath();
  fs.writeFileSync(statePath, JSON.stringify({
    version: 2,
    bestScores: { aiHunt: engine.state.score, frogger: 0 },
    bestLevels: { frogger: 0 },
    totalRuns: { aiHunt: 1, frogger: 0 },
    totalPickups: 0,
    totalCredits: 0,
    lastPlayedAt: new Date().toISOString(),
    lastMode: 'aiHunt',
    signature: null,
    runReceipts: [receipt],
  }));

  try {
    // Run replay script
    const output = execSync(`node scripts/replay.js 0`, {
      env: { ...process.env, SIGNAL_RUSH_STATE: statePath },
      encoding: 'utf8',
      timeout: 10000,
    });

    assert(output.includes('Replaying'), 'should show replay header');
    assert(output.includes(`Seed: ${seed}`), 'should show seed');
    assert(output.includes('Replay complete'), 'should complete');
    console.log('PASS testReplayGeneratesFrames');
  } finally {
    cleanup(statePath);
  }
}

function testReplayListOfReceipts() {
  const statePath = tmpStatePath();
  fs.writeFileSync(statePath, JSON.stringify({
    version: 2,
    runReceipts: [
      { mode: 'aiHunt', finalScore: 100, seed: 1, timestamp: '2026-01-01T00:00:00Z', inputs: [] },
      { mode: 'frogger', finalScore: 200, seed: 2, timestamp: '2026-01-02T00:00:00Z', inputs: [] },
    ],
  }));

  try {
    const output = execSync(`node scripts/replay.js --list`, {
      env: { ...process.env, SIGNAL_RUSH_STATE: statePath },
      encoding: 'utf8',
      timeout: 10000,
    });

    assert(output.includes('aiHunt'), 'should list AI Hunt receipt');
    assert(output.includes('frogger'), 'should list Frogger receipt');
    assert(output.includes('Score: 100'), 'should show AI Hunt score');
    assert(output.includes('Score: 200'), 'should show Frogger score');
    console.log('PASS testReplayListOfReceipts');
  } finally {
    cleanup(statePath);
  }
}

function testReplayVerifiesScore() {
  const seed = 5555;
  const engine = createEngine({ mode: 'aiHunt', seed });
  const inputs = [{ move: { x: 1, y: 0 } }, { move: { x: 0, y: -1 } }];
  for (const input of inputs) engine.step(input);

  const statePath = tmpStatePath();
  fs.writeFileSync(statePath, JSON.stringify({
    version: 2,
    runReceipts: [{
      version: 1,
      timestamp: new Date().toISOString(),
      seed,
      mode: 'aiHunt',
      inputCount: inputs.length,
      inputs,
      finalScore: engine.state.score,
      finalLevel: 1,
      signature: 'test',
    }],
  }));

  try {
    const output = execSync(`node scripts/replay.js 0`, {
      env: { ...process.env, SIGNAL_RUSH_STATE: statePath },
      encoding: 'utf8',
      timeout: 10000,
    });

    assert(output.includes('match receipt claims'), 'should verify matching score');
    console.log('PASS testReplayVerifiesScore');
  } finally {
    cleanup(statePath);
  }
}

const tests = [
  testReplayGeneratesFrames,
  testReplayListOfReceipts,
  testReplayVerifiesScore,
];

let failed = 0;
for (const t of tests) {
  try { t(); } catch (e) {
    failed++;
    console.error(`FAIL ${t.name}: ${e.message}`);
  }
}
if (failed) { console.error(`\n${failed} test(s) failed.`); process.exit(1); }
console.log(`\nReplay tests passed: ${tests.length}`);
