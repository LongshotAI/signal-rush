const canvas = document.getElementById("gameCanvas");
const ctx = canvas.getContext("2d");

const startOverlay = document.getElementById("startOverlay");
const pauseOverlay = document.getElementById("pauseOverlay");
const gameOverOverlay = document.getElementById("gameOverOverlay");
const summaryText = document.getElementById("summaryText");

const startButton = document.getElementById("startButton");
const restartButton = document.getElementById("restartButton");

const scoreValue = document.getElementById("scoreValue");
const comboValue = document.getElementById("comboValue");
const creditsValue = document.getElementById("creditsValue");
const healthValue = document.getElementById("healthValue");

const state = {
  running: false,
  paused: false,
  ended: false,
  time: 0,
  lastTick: 0,
  score: 0,
  credits: 0,
  combo: 1,
  spawnTimer: 0,
  pickupTimer: 0,
  dashCooldown: 0,
  keys: new Set(),
  player: null,
  hazards: [],
  pickups: [],
  particles: [],
};

function resetState() {
  state.running = false;
  state.paused = false;
  state.ended = false;
  state.time = 0;
  state.lastTick = 0;
  state.score = 0;
  state.credits = 0;
  state.combo = 1;
  state.spawnTimer = 0;
  state.pickupTimer = 0;
  state.dashCooldown = 0;
  state.hazards = [];
  state.pickups = [];
  state.particles = [];
  state.player = {
    x: canvas.width / 2,
    y: canvas.height / 2,
    radius: 14,
    speed: 240,
    dashSpeed: 540,
    health: 100,
    invulnerable: 0,
  };
  syncHud();
}

function startRun() {
  resetState();
  state.running = true;
  hideAllOverlays();
  window.requestAnimationFrame(loop);
}

function endRun() {
  state.running = false;
  state.ended = true;
  summaryText.textContent = `You converted ${Math.floor(state.score)} signal into ${state.credits} credits.`;
  showOverlay(gameOverOverlay);
}

function togglePause() {
  if (!state.running || state.ended) {
    return;
  }
  state.paused = !state.paused;
  if (state.paused) {
    showOverlay(pauseOverlay);
  } else {
    hideAllOverlays();
    state.lastTick = 0;
    window.requestAnimationFrame(loop);
  }
}

function syncHud() {
  scoreValue.textContent = Math.floor(state.score);
  comboValue.textContent = `x${state.combo.toFixed(1)}`;
  creditsValue.textContent = state.credits;
  healthValue.textContent = Math.max(0, Math.ceil(state.player ? state.player.health : 100));
}

function hideAllOverlays() {
  startOverlay.classList.remove("active");
  pauseOverlay.classList.remove("active");
  gameOverOverlay.classList.remove("active");
}

function showOverlay(node) {
  hideAllOverlays();
  node.classList.add("active");
}

function spawnHazard() {
  const edge = Math.floor(Math.random() * 4);
  const speed = 110 + Math.random() * 70 + state.time * 4;
  const radius = 9 + Math.random() * 16;
  let x = 0;
  let y = 0;

  if (edge === 0) {
    x = Math.random() * canvas.width;
    y = -40;
  } else if (edge === 1) {
    x = canvas.width + 40;
    y = Math.random() * canvas.height;
  } else if (edge === 2) {
    x = Math.random() * canvas.width;
    y = canvas.height + 40;
  } else {
    x = -40;
    y = Math.random() * canvas.height;
  }

  const dx = state.player.x - x;
  const dy = state.player.y - y;
  const len = Math.hypot(dx, dy) || 1;

  state.hazards.push({
    x,
    y,
    radius,
    vx: (dx / len) * speed,
    vy: (dy / len) * speed,
  });
}

function spawnPickup() {
  state.pickups.push({
    x: 80 + Math.random() * (canvas.width - 160),
    y: 80 + Math.random() * (canvas.height - 160),
    radius: 10,
    value: 10 + Math.floor(Math.random() * 20),
    life: 8,
  });
}

function emitParticles(x, y, color, count) {
  for (let i = 0; i < count; i += 1) {
    state.particles.push({
      x,
      y,
      vx: (Math.random() - 0.5) * 180,
      vy: (Math.random() - 0.5) * 180,
      life: 0.5 + Math.random() * 0.4,
      color,
    });
  }
}

function update(dt) {
  const player = state.player;
  state.time += dt;
  state.spawnTimer -= dt;
  state.pickupTimer -= dt;
  state.dashCooldown = Math.max(0, state.dashCooldown - dt);
  player.invulnerable = Math.max(0, player.invulnerable - dt);

  let moveX = 0;
  let moveY = 0;

  if (state.keys.has("ArrowUp") || state.keys.has("w")) moveY -= 1;
  if (state.keys.has("ArrowDown") || state.keys.has("s")) moveY += 1;
  if (state.keys.has("ArrowLeft") || state.keys.has("a")) moveX -= 1;
  if (state.keys.has("ArrowRight") || state.keys.has("d")) moveX += 1;

  const mag = Math.hypot(moveX, moveY) || 1;
  const speed = state.keys.has(" ") && state.dashCooldown === 0 ? player.dashSpeed : player.speed;

  if (state.keys.has(" ") && state.dashCooldown === 0 && (moveX !== 0 || moveY !== 0)) {
    state.dashCooldown = 1.4;
    emitParticles(player.x, player.y, "#76f6ff", 14);
  }

  player.x += (moveX / mag) * speed * dt;
  player.y += (moveY / mag) * speed * dt;
  player.x = Math.max(player.radius, Math.min(canvas.width - player.radius, player.x));
  player.y = Math.max(player.radius, Math.min(canvas.height - player.radius, player.y));

  if (state.spawnTimer <= 0) {
    spawnHazard();
    state.spawnTimer = Math.max(0.18, 0.95 - state.time * 0.02);
  }

  if (state.pickupTimer <= 0) {
    spawnPickup();
    state.pickupTimer = 1.9;
  }

  state.hazards.forEach((hazard) => {
    hazard.x += hazard.vx * dt;
    hazard.y += hazard.vy * dt;
  });

  state.pickups.forEach((pickup) => {
    pickup.life -= dt;
  });

  state.particles.forEach((particle) => {
    particle.x += particle.vx * dt;
    particle.y += particle.vy * dt;
    particle.life -= dt;
  });

  state.hazards = state.hazards.filter((hazard) => {
    const hit = Math.hypot(hazard.x - player.x, hazard.y - player.y) < hazard.radius + player.radius;
    if (hit && player.invulnerable === 0) {
      player.health -= 18;
      player.invulnerable = 0.7;
      state.combo = 1;
      emitParticles(player.x, player.y, "#ff6f79", 18);
      return false;
    }
    return hazard.x > -80 && hazard.x < canvas.width + 80 && hazard.y > -80 && hazard.y < canvas.height + 80;
  });

  state.pickups = state.pickups.filter((pickup) => {
    if (pickup.life <= 0) {
      return false;
    }

    const collected = Math.hypot(pickup.x - player.x, pickup.y - player.y) < pickup.radius + player.radius;
    if (collected) {
      state.combo = Math.min(5, state.combo + 0.2);
      state.score += pickup.value * state.combo;
      state.credits += Math.max(1, Math.floor((pickup.value * state.combo) / 12));
      emitParticles(pickup.x, pickup.y, "#6dffbe", 14);
      return false;
    }

    return true;
  });

  state.particles = state.particles.filter((particle) => particle.life > 0);
  state.score += dt * 8 * state.combo;

  if (player.health <= 0) {
    endRun();
  }

  syncHud();
}

function renderBackground() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const gradient = ctx.createLinearGradient(0, 0, canvas.width, canvas.height);
  gradient.addColorStop(0, "#071523");
  gradient.addColorStop(1, "#03070d");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.save();
  ctx.strokeStyle = "rgba(118, 246, 255, 0.08)";
  ctx.lineWidth = 1;
  for (let x = 0; x < canvas.width; x += 40) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, canvas.height);
    ctx.stroke();
  }
  for (let y = 0; y < canvas.height; y += 40) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(canvas.width, y);
    ctx.stroke();
  }
  ctx.restore();
}

function renderEntities() {
  renderBackground();

  state.pickups.forEach((pickup) => {
    ctx.beginPath();
    ctx.fillStyle = "#6dffbe";
    ctx.shadowColor = "#6dffbe";
    ctx.shadowBlur = 14;
    ctx.arc(pickup.x, pickup.y, pickup.radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
  });

  state.hazards.forEach((hazard) => {
    ctx.beginPath();
    ctx.fillStyle = "#ff6f79";
    ctx.shadowColor = "#ff6f79";
    ctx.shadowBlur = 16;
    ctx.arc(hazard.x, hazard.y, hazard.radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
  });

  state.particles.forEach((particle) => {
    ctx.globalAlpha = Math.max(0, particle.life);
    ctx.fillStyle = particle.color;
    ctx.fillRect(particle.x, particle.y, 3, 3);
    ctx.globalAlpha = 1;
  });

  const player = state.player;
  ctx.beginPath();
  ctx.fillStyle = player.invulnerable > 0 ? "#ffcf5c" : "#76f6ff";
  ctx.shadowColor = ctx.fillStyle;
  ctx.shadowBlur = 18;
  ctx.arc(player.x, player.y, player.radius, 0, Math.PI * 2);
  ctx.fill();
  ctx.shadowBlur = 0;

  ctx.strokeStyle = "rgba(236, 251, 255, 0.45)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(player.x, player.y, player.radius + 8, 0, Math.PI * 2);
  ctx.stroke();

  ctx.fillStyle = "rgba(255, 207, 92, 0.9)";
  ctx.fillRect(18, 18, 180 * (state.dashCooldown > 0 ? 1 - state.dashCooldown / 1.4 : 1), 8);
  ctx.strokeStyle = "rgba(255, 207, 92, 0.3)";
  ctx.strokeRect(18, 18, 180, 8);
}

function loop(timestamp) {
  if (!state.running || state.paused || state.ended) {
    renderEntities();
    return;
  }

  if (!state.lastTick) {
    state.lastTick = timestamp;
  }

  const dt = Math.min(0.032, (timestamp - state.lastTick) / 1000);
  state.lastTick = timestamp;

  update(dt);
  renderEntities();

  if (state.running) {
    window.requestAnimationFrame(loop);
  }
}

document.addEventListener("keydown", (event) => {
  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
  state.keys.add(key);

  if (key === "p" || key === "P") {
    togglePause();
  }

  if (key === "Enter" && (!state.running || state.ended)) {
    startRun();
  }
});

document.addEventListener("keyup", (event) => {
  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
  state.keys.delete(key);
});

startButton.addEventListener("click", startRun);
restartButton.addEventListener("click", startRun);

resetState();
renderEntities();
