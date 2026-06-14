#!/usr/bin/env node
'use strict';

const { createEngine } = require('../src/core/engine');
const { renderFrame } = require('../src/cli/render');

const engine = createEngine({ mode: 'frogger', rng: () => 0.5 });
const frame = renderFrame(engine.state, { columns: 92, rows: 40 }, { colors: false });

const checks = {
  // Mode is rebranded: was 'SIGNAL RUSH // FROGGER', now 'SIGNAL RUSH // PACKET HOP'.
  title: frame.includes('SIGNAL RUSH // PACKET HOP'),
  goalBar: /GOAL\s+\[_ _ _ _ _\]\s+0\/5/.test(frame),
  homeSlots: /_\s+_\s+_\s+_\s+_/.test(frame),
  water: frame.includes('~~~~'),
  logs: frame.includes('='),
  cars: frame.includes('>') && frame.includes('<'),
  getReady: frame.includes('GET READY'),
};

const failed = Object.entries(checks)
  .filter(([, ok]) => !ok)
  .map(([name]) => name);

if (failed.length) {
  console.error('Missing Frogger render elements:', failed.join(', '));
  process.exit(1);
}

console.log('Frogger render verified: GOAL bar, home slots, water/log lanes, cars, and GET READY are present.');
