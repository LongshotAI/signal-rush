#!/usr/bin/env node
'use strict';

const { createEngine } = require('../src/core/engine');
const { renderFrame } = require('../src/cli/render');

const engine = createEngine({ mode: 'aiHunt' });
engine.state.player.health = 6;
engine.state.combo = 2.2;
engine.state.nearMissStreak = 4;
engine.state.pickups = [{ x: 12, y: 12, value: 25, ttl: 50 }];
engine.state.hazards = [
  { x: 10, y: 10, kind: 'packet' },
  { x: 20, y: 14, kind: 'corruptor' },
];

const frame = renderFrame(engine.state, { columns: 100, rows: 40 }, { colors: false });
const lines = frame.split('\n');
const missionLine = lines.findIndex((line) => line.includes('MISSION'));
const arenaLine = lines.findIndex((line) => line.includes('+--'));

const checks = {
  title: frame.includes('SIGNAL RUSH // AI HUNT'),
  missionBar: frame.includes('MISSION') && frame.includes('SURVIVE') && frame.includes('COLLECT $'),
  hpPips: frame.includes('HP [██████░░]'),
  threatMeter: frame.includes('THREAT 2/12'),
  riskStreak: frame.includes('RISK x4'),
  dangerHalo: frame.includes('!o!') || frame.includes('!o') || frame.includes('o!'),
  pickupStillVisible: frame.includes('$'),
  playerStillVisible: frame.includes('A'),
  missionAboveArena: missionLine !== -1 && arenaLine !== -1 && missionLine < arenaLine,
  noFroggerGoalLeak: !frame.includes('GOAL [_ _ _ _ _]'),
};

const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name);
if (failed.length > 0) {
  console.error('AI Hunt polish verification failed:', failed.join(', '));
  console.error(frame);
  process.exit(1);
}

console.log('AI Hunt polish verified: mission bar, HP pips, threat meter, risk streak, danger halos, and mode isolation are present.');
