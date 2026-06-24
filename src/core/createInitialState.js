const { GAME_CONFIG } = require('../config/gameConfig');

function createPlayer() {
  return {
    x: Math.floor(GAME_CONFIG.width / 2),
    y: Math.floor(GAME_CONFIG.height / 2),
    health: GAME_CONFIG.startHealth,
    shield: 0,
  };
}

function createAiHuntState() {
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
    nearMissStreak: 0,
    consecutivePickups: 0,
    comboDecayTimer: 0,
    shieldPickupActive: false,
    telegraphs: [],  // upcoming hazard spawn positions with ttl
    difficultyTier: 0,
    rewardMicros: 0,
  };
}

function createFroggerState() {
  const cfg = GAME_CONFIG.modes.frogger;
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
    message: cfg.tagline,
    player: { x: cfg.spawnX, y: cfg.spawnRow, health: 1 },
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
    // Frogger-specific
    lives: cfg.lives,
    maxLives: cfg.lives,
    level: 1,
    homeSlots: [false, false, false, false, false],
    timeLeft: cfg.timePerLevel,
    maxTime: cfg.timePerLevel,
    onLog: null,
    lastFroggerCause: null,
    bestProgressY: cfg.spawnRow,
    // GET READY countdown (vehicles frozen, no deaths) at the start of
    // every level — first run and after each level clear / respawn.
    getReadyTicks: cfg.getReadyTicks,
    lanes: cfg.lanes.map((l) => ({
      y: l.y,
      type: l.type,
      direction: l.direction || 0,
      speed: l.speed || 0,
      vehicles: (l.vehicles || []).map((v) => ({ x: v.x })),
    })),
    rewardMicros: 0,
  };
}

function createInitialState(options = {}) {
  const mode = options.mode || 'aiHunt';
  const base = mode === 'frogger' ? createFroggerState() : createAiHuntState();
  base.mode = mode;
  return base;
}

module.exports = {
  createInitialState,
  createPlayer,
};
