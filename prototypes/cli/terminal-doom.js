#!/usr/bin/env node
'use strict';

// TERMINAL DOOM - Raycasting FPS in the terminal
// W/S = move  A/D = strafe  ←/→ = look  Space = shoot  Q = quit  R = restart

const readline = require('node:readline');

// ─── Display ───────────────────────────────────────────────────────────────
const W    = Math.min(process.stdout.columns || 80, 160);
const H    = Math.max(Math.min((process.stdout.rows || 28) - 6, 45), 12);
const TICK = 50;                // ms per frame (20 fps)
const MOVE  = 0.09;
const ROT   = 0.07;

// ─── Map ────────────────────────────────────────────────────────────────────
// '#' = wall, '.' = floor
const MAP = [
  '####################',
  '#..................#',
  '#..###.............#',
  '#..#...............#',
  '#..#...####........#',
  '#..................#',
  '#.......#..........#',
  '#.......#..........#',
  '#..................#',
  '#...####...........#',
  '#..................#',
  '#..........#.......#',
  '#..........#.......#',
  '#..................#',
  '##..###............#',
  '#..................#',
  '#.......####.......#',
  '#..................#',
  '#..................#',
  '####################',
];
const MW = MAP[0].length;
const MH = MAP.length;

function wallAt(x, y) {
  const mx = Math.floor(x), my = Math.floor(y);
  if (mx < 0 || mx >= MW || my < 0 || my >= MH) return true;
  return MAP[my][mx] === '#';
}

// ─── ANSI ───────────────────────────────────────────────────────────────────
const A = {
  R:  '\x1b[0m',
  bW: '\x1b[1;97m',   // bright white  (near walls)
  dW: '\x1b[2;37m',   // dim white     (far / dark-side walls)
  dB: '\x1b[2;34m',   // dim blue      (ceiling)
  dY: '\x1b[2;33m',   // dim yellow    (floor near)
  dG: '\x1b[2;37m',   // dim gray      (floor far)
  rd: '\x1b[1;31m',   // bright red    (IMP)
  mg: '\x1b[1;35m',   // magenta       (DEMON)
  yw: '\x1b[1;33m',   // yellow        (BARON)
  cy: '\x1b[1;36m',   // cyan          (UI)
  gn: '\x1b[1;32m',   // green         (win)
};

// ─── State ──────────────────────────────────────────────────────────────────
let state;

function newGame() {
  return {
    tick:    0,
    score:   0,
    gameOver: false,
    won:     false,
    msg:     'Find and eliminate all demons!',
    player: {
      x: 1.5, y: 1.5,
      dx: 1,  dy: 0,    // view direction (unit vector)
      px: 0,  py: 0.66, // camera plane (perpendicular to dir, |plane|=tan(FOV/2))
      hp: 100,
      ammo: 50,
      shootCD: 0,
      muzzle:  0,
    },
    enemies: [
      { x:  8.5, y:  3.5, hp: 2, maxHp: 2, alive: true, type: 'IMP',   cd: 0, period: 8, dmg: 8  },
      { x:  5.5, y:  7.5, hp: 2, maxHp: 2, alive: true, type: 'IMP',   cd: 0, period: 9, dmg: 8  },
      { x: 14.5, y:  6.5, hp: 4, maxHp: 4, alive: true, type: 'DEMON', cd: 0, period: 5, dmg: 15 },
      { x: 11.5, y: 13.5, hp: 4, maxHp: 4, alive: true, type: 'DEMON', cd: 0, period: 6, dmg: 15 },
      { x: 17.5, y: 17.5, hp: 8, maxHp: 8, alive: true, type: 'BARON', cd: 0, period: 3, dmg: 25 },
    ],
    // cached per-frame ray data (set by step, consumed by render)
    _ray: null,
    _spr: null,
  };
}

state = newGame();

// ─── Input ──────────────────────────────────────────────────────────────────
const K = {
  fwd: false, bck: false,
  sl:  false, sr:  false,
  rl:  false, rr:  false,
  shoot: false, quit: false, restart: false,
};

function handleKey(ch, key = {}) {
  const n = (key.name || '').toLowerCase();
  const s = key.sequence || (typeof ch === 'string' ? ch : '');
  if (s === '' || n === 'q') { K.quit    = true; return; }
  if (n === 'r')                    { K.restart = true; return; }
  if (n === 'w' || n === 'up')      K.fwd   = true;
  if (n === 's' || n === 'down')    K.bck   = true;
  if (n === 'a')                    K.sl    = true;
  if (n === 'd')                    K.sr    = true;
  if (n === 'left')                 K.rl    = true;
  if (n === 'right')                K.rr    = true;
  if (n === 'space' || s === ' ')   K.shoot = true;
}

function consumeInput() {
  const i = { ...K };
  K.fwd = K.bck = K.sl = K.sr = K.rl = K.rr = K.shoot = K.restart = K.quit = false;
  return i;
}

// ─── Raycasting (DDA) ───────────────────────────────────────────────────────
function castRays() {
  const p = state.player;
  const zBuf = new Float64Array(W);
  const cols = [];

  for (let x = 0; x < W; x++) {
    const camX = 2 * x / W - 1;       // -1 (left) to +1 (right)
    const rdx  = p.dx + p.px * camX;
    const rdy  = p.dy + p.py * camX;

    let mx = Math.floor(p.x), my = Math.floor(p.y);

    const ddx = rdx === 0 ? 1e30 : Math.abs(1 / rdx);
    const ddy = rdy === 0 ? 1e30 : Math.abs(1 / rdy);

    let sdx, sdy, stepX, stepY;
    if (rdx < 0) { stepX = -1; sdx = (p.x - mx) * ddx; }
    else         { stepX =  1; sdx = (mx + 1 - p.x) * ddx; }
    if (rdy < 0) { stepY = -1; sdy = (p.y - my) * ddy; }
    else         { stepY =  1; sdy = (my + 1 - p.y) * ddy; }

    let side = 0;
    // DDA march
    for (let guard = 0; guard < 64; guard++) {
      if (sdx < sdy) { sdx += ddx; mx += stepX; side = 0; }
      else           { sdy += ddy; my += stepY; side = 1; }
      if (wallAt(mx, my)) break;
    }

    const dist = side === 0 ? sdx - ddx : sdy - ddy;
    zBuf[x] = Math.max(0.01, dist);

    const lh  = Math.floor(H / dist);
    const ds  = Math.max(0,     Math.floor((H - lh) / 2));
    const de  = Math.min(H - 1, Math.floor((H + lh) / 2));
    const dark = side === 1 || dist > 5;

    // Wall char: block density = depth shading
    let wch;
    if      (dist < 1.5) wch = '█';
    else if (dist < 3.0) wch = dark ? '▓' : '█';
    else if (dist < 5.5) wch = dark ? '▒' : '▓';
    else if (dist < 9.0) wch = dark ? '░' : '▒';
    else                 wch = '░';

    cols.push({ ds, de, wch, dark });
  }

  return { zBuf, cols };
}

// ─── Sprite projection ───────────────────────────────────────────────────────
function projectSprites(zBuf) {
  const p   = state.player;
  const det = p.px * p.dy - p.dx * p.py; // determinant of camera matrix
  const inv = det === 0 ? 1e30 : 1 / det;
  const out = [];

  for (const e of state.enemies) {
    if (!e.alive) continue;
    const sx = e.x - p.x, sy = e.y - p.y;
    // transform into camera space
    const tx  = inv * ( p.dy * sx - p.dx * sy);
    const ty  = inv * (-p.py * sx + p.px * sy);
    if (ty <= 0.15) continue; // behind camera

    const screenX = Math.floor(W / 2 * (1 + tx / ty));
    const sprH    = Math.abs(Math.floor(H / ty));
    const sprW    = Math.max(1, Math.floor(sprH / 2)); // chars ~2:1, narrow sprites

    const x0 = screenX - Math.floor(sprW / 2);
    const x1 = screenX + Math.floor(sprW / 2);
    const y0 = Math.max(0,     Math.floor((H - sprH) / 2));
    const y1 = Math.min(H - 1, Math.floor((H + sprH) / 2));

    out.push({ e, ty, screenX, sprW, x0, x1, y0, y1 });
  }

  out.sort((a, b) => b.ty - a.ty); // draw far first
  return out;
}

// ─── Enemy sprite characters ─────────────────────────────────────────────────
function spriteChar(type, relY) {
  if (type === 'IMP')   return relY < 0.25 ? 'O' : relY < 0.6 ? 'I' : 'v';
  if (type === 'DEMON') return relY < 0.25 ? '@' : relY < 0.6 ? 'W' : 'M';
  /* BARON */           return relY < 0.2  ? 'Q' : relY < 0.55? 'H' : 'Y';
}
function spriteColor(type) {
  if (type === 'IMP')   return A.rd;
  if (type === 'DEMON') return A.mg;
  /* BARON */           return A.yw;
}

// ─── Weapon sprites ──────────────────────────────────────────────────────────
const GUN_IDLE = [
  '    ____  ',
  '   |    | ',
  '___|____|_',
  '|________|',
];
const GUN_FIRE = [
  '    _**_  ',
  '   |    | ',
  '___|____|_',
  '|________|',
];

function drawWeapon(grid, flash) {
  const frame  = flash ? GUN_FIRE : GUN_IDLE;
  const startY = H - frame.length;
  const startX = Math.floor(W / 2) - Math.floor(frame[0].length / 2);
  for (let r = 0; r < frame.length; r++) {
    const y = startY + r;
    if (y < 0 || y >= H) continue;
    for (let c = 0; c < frame[r].length; c++) {
      const x = startX + c;
      if (x < 0 || x >= W || frame[r][c] === ' ') continue;
      grid[y][x] = { ch: frame[r][c], col: flash && frame[r][c] === '*' ? A.yw : A.dW };
    }
  }
}

// ─── Render ──────────────────────────────────────────────────────────────────
function render() {
  const { zBuf, cols } = state._ray || castRays();
  const sprites        = state._spr || projectSprites(zBuf);
  const p              = state.player;
  const mid            = H / 2;

  // Build pixel grid
  const grid = Array.from({ length: H }, () =>
    Array.from({ length: W }, () => ({ ch: ' ', col: '' }))
  );

  // Walls, ceiling, floor
  for (let x = 0; x < W; x++) {
    const col = cols[x];
    for (let y = 0; y < H; y++) {
      const cell = grid[y][x];
      if (y < col.ds) {
        // ceiling
        cell.ch  = y < mid * 0.3 ? ' ' : '.';
        cell.col = A.dB;
      } else if (y <= col.de) {
        // wall
        cell.ch  = col.wch;
        cell.col = col.dark ? A.dW : A.bW;
      } else {
        // floor
        const t = (y - mid) / mid;
        cell.ch  = t > 0.75 ? '=' : ',';
        cell.col = t > 0.75 ? A.dG : A.dY;
      }
    }
  }

  // Enemy sprites
  for (const s of sprites) {
    const color = spriteColor(s.e.type);
    for (let x = s.x0; x <= s.x1; x++) {
      if (x < 0 || x >= W) continue;
      if (s.ty >= zBuf[x])  continue; // occluded by wall
      for (let y = s.y0; y <= s.y1; y++) {
        if (y < 0 || y >= H) continue;
        // draw only the vertical "spine" + narrow band for body width
        const relX = Math.abs(x - s.screenX) / Math.max(1, Math.floor(s.sprW / 2) + 0.5);
        if (relX > 0.55) continue;
        const relY = (y - s.y0) / Math.max(1, s.y1 - s.y0);
        grid[y][x] = { ch: spriteChar(s.e.type, relY), col: color };
      }
    }
  }

  // Weapon
  if (!state.gameOver) drawWeapon(grid, p.muzzle > 0);

  // ── Build output ──────────────────────────────────────────────────────────
  const kills  = state.enemies.filter(e => !e.alive).length;
  const total  = state.enemies.length;
  const hpPct  = Math.max(0, p.hp) / 100;
  const hpBar  = A.rd + '▓'.repeat(Math.round(hpPct * 10)) + A.dG + '░'.repeat(10 - Math.round(hpPct * 10)) + A.R;
  const hud    = `${A.rd}HP${A.R} ${hpBar} ${String(p.hp).padStart(3)}  ` +
                 `${A.yw}AMMO${A.R} ${String(p.ammo).padStart(3)}  ` +
                 `${A.cy}SCORE${A.R} ${state.score}  ` +
                 `${A.mg}KILLS${A.R} ${kills}/${total}`;

  const lines = [hud];

  for (let y = 0; y < H; y++) {
    let row = '', prev = '';
    for (let x = 0; x < W; x++) {
      const cell = grid[y][x];
      if (cell.col !== prev) { row += cell.col || A.R; prev = cell.col; }
      row += cell.ch;
    }
    row += A.R;
    lines.push(row);
  }

  lines.push(`${A.dW}${state.msg}${A.R}`);

  if (state.gameOver) {
    if (state.won) {
      lines.push(`${A.gn}★ ALL DEMONS SLAIN! Glory to the Slayer! Score: ${state.score} ★${A.R}  Press R to restart, Q to quit`);
    } else {
      lines.push(`${A.rd}✖ YOU DIED! Score: ${state.score}${A.R}  Press R to restart, Q to quit`);
    }
  } else {
    lines.push(`${A.dW}[W/S=move  A/D=strafe  ←/→=look  Space=shoot  Q=quit]${A.R}`);
  }

  process.stdout.write('\x1b[H' + lines.map(l => l + '\x1b[K').join('\n') + '\x1b[J');
}

// ─── Game update ─────────────────────────────────────────────────────────────
function step() {
  const i = consumeInput();

  if (i.quit) { shutdown(); return; }

  if (state.gameOver) {
    if (i.restart) { state = newGame(); render(); }
    return;
  }

  state.tick++;
  const p = state.player;
  p.shootCD = Math.max(0, p.shootCD - 1);
  p.muzzle  = Math.max(0, p.muzzle  - 1);

  // ── Player movement ───────────────────────────────────────────────────────
  if (i.fwd || i.bck) {
    const spd = i.fwd ? MOVE : -MOVE;
    const nx = p.x + p.dx * spd;
    const ny = p.y + p.dy * spd;
    if (!wallAt(nx, p.y)) p.x = nx;
    if (!wallAt(p.x, ny)) p.y = ny;
  }

  if (i.sl || i.sr) {
    // strafe right = direction perpendicular to view: (-dy, dx)
    const spd = i.sr ? MOVE : -MOVE;
    const nx = p.x + (-p.dy) * spd;
    const ny = p.y + p.dx   * spd;
    if (!wallAt(nx, p.y)) p.x = nx;
    if (!wallAt(p.x, ny)) p.y = ny;
  }

  if (i.rl || i.rr) {
    const a = i.rl ? -ROT : ROT;
    const cosA = Math.cos(a), sinA = Math.sin(a);
    const ndx = p.dx * cosA - p.dy * sinA;
    const ndy = p.dx * sinA + p.dy * cosA;
    const npx = p.px * cosA - p.py * sinA;
    const npy = p.px * sinA + p.py * cosA;
    p.dx = ndx; p.dy = ndy;
    p.px = npx; p.py = npy;
  }

  // ── Pre-compute ray data (shared by shooting + render) ───────────────────
  const ray = castRays();
  state._ray = ray;
  const sprites = projectSprites(ray.zBuf);
  state._spr = sprites;

  // ── Shooting ─────────────────────────────────────────────────────────────
  if (i.shoot) {
    if (p.ammo <= 0) {
      state.msg = 'OUT OF AMMO! (click)';
    } else if (p.shootCD === 0) {
      p.ammo--;
      p.shootCD = 8;
      p.muzzle  = 3;

      const centerX = Math.floor(W / 2);
      let hitEnemy = null, hitDist = Infinity;

      for (const s of sprites) {
        if (s.x0 <= centerX && centerX <= s.x1 && s.ty < ray.zBuf[centerX]) {
          if (s.ty < hitDist) { hitDist = s.ty; hitEnemy = s.e; }
        }
      }

      if (hitEnemy) {
        hitEnemy.hp--;
        if (hitEnemy.hp <= 0) {
          hitEnemy.alive = false;
          const pts = hitEnemy.type === 'BARON' ? 500 : hitEnemy.type === 'DEMON' ? 200 : 100;
          state.score += pts;
          state.msg = `${hitEnemy.type} SLAIN! +${pts} pts`;
        } else {
          state.msg = `Hit ${hitEnemy.type}! (${hitEnemy.hp}/${hitEnemy.maxHp} HP)`;
        }
      } else {
        state.msg = 'BLAM!';
      }
    }
  }

  // ── Enemy AI ─────────────────────────────────────────────────────────────
  for (const e of state.enemies) {
    if (!e.alive) continue;
    e.cd--;
    if (e.cd > 0) continue;
    e.cd = e.period;

    const dx   = p.x - e.x, dy = p.y - e.y;
    const dist = Math.sqrt(dx * dx + dy * dy);

    if (dist < 0.65) {
      // Melee attack
      p.hp -= e.dmg;
      state.msg = `${e.type} hits you for ${e.dmg} damage!`;
      if (p.hp <= 0) {
        p.hp = 0;
        state.gameOver = true;
        state.msg = `Killed by a ${e.type}!`;
      }
    } else {
      // Walk toward player
      const spd = 0.35;
      const nx  = e.x + (dx / dist) * spd;
      const ny  = e.y + (dy / dist) * spd;
      if      (!wallAt(nx, ny)) { e.x = nx; e.y = ny; }
      else if (!wallAt(nx, e.y)) { e.x = nx; }
      else if (!wallAt(e.x, ny)) { e.y = ny; }
    }
  }

  // ── Win check ─────────────────────────────────────────────────────────────
  if (!state.gameOver && state.enemies.every(e => !e.alive)) {
    state.gameOver = true;
    state.won      = true;
    state.msg      = 'ALL DEMONS ELIMINATED! GLORY TO THE SLAYER!';
  }

  render();
}

// ─── Startup / shutdown ──────────────────────────────────────────────────────
let interval  = null;
let exiting   = false;

function shutdown() {
  if (exiting) return;
  exiting = true;
  if (interval) clearInterval(interval);
  process.stdin.off('keypress', handleKey);
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  process.stdin.pause();
  process.stdout.write('\x1b[2J\x1b[H\x1b[?25h');
  console.log('TERMINAL DOOM - Thanks for playing! Final score: ' + (state ? state.score : 0));
  process.exit(0);
}

function start() {
  process.stdout.write('\x1b[?25l'); // hide cursor
  readline.emitKeypressEvents(process.stdin);
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on('keypress', handleKey);
  render();
  interval = setInterval(step, TICK);
}

start();
