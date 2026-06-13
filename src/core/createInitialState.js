const { GAME_CONFIG } = require('../config/gameConfig');

function createPlayer() {
  return {
    x: Math.floor(GAME_CONFIG.width / 2),
    y: Math.floor(GAME_CONFIG.height / 2),
    health: GAME_CONFIG.startHealth,
  };
}

function createInitialState() {
  return {
    running: true,
    paused: false,
    gameOver: false,
    tick: 0,
    score: 0,
    credits: 0,
    combo: 1,
    bestScore: 0,
    dashCooldown: 0,
    invulnerable: 0,
    message: GAME_CONFIG.initialMessage,
    player: createPlayer(),
    hazards: [],
    pickups: [],
    trail: null,
    inputPulse: 0,
    moveFlash: 0,
    deathState: null,
    lastMove: { x: 0, y: -1 },
    currentMove: null,
    lastEvents: [],
    lastMilestoneIndex: -1,
    sponsorLabelIndex: 0,
  };
}

module.exports = {
  createInitialState,
  createPlayer,
};
