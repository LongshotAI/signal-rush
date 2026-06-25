#!/usr/bin/env node
/**
 * Signal Rush — 20-Second Commercial Script
 * 
 * Usage: node scripts/commercial.js
 * 
 * A cinematic, self-contained terminal commercial that:
 * 1. Opens with a dramatic reveal
 * 2. Shows both game modes (AI Hunt + Packet Hop) in action
 * 3. Highlights the ad-powered economy
 * 4. Ends with branding + call-to-action
 * 
 * No user input required — fully automated, loops once, exits.
 */

const { spawn } = require('child_process');
const path = require('path');

// ─── Timing (20 seconds total) ───────────────────────────────────
const SCENES = [
  { name: 'black',      duration: 800 },
  { name: 'logo',       duration: 2500 },
  { name: 'tagline',    duration: 1500 },
  { name: 'gameplay1',  duration: 4000 },  // AI Hunt
  { name: 'gameplay2',  duration: 4000 },  // Packet Hop
  { name: 'economy',    duration: 2500 },
  { name: 'sponsors',   duration: 2000 },
  { name: 'cta',        duration: 2500 },
  { name: 'black',      duration: 200 },
];

const TOTAL_DURATION = SCENES.reduce((s, x) => s + x.duration, 0);

// ─── ANSI helpers ─────────────────────────────────────────────────
const ESC = '\x1b';
const reset = `${ESC}[0m`;
const bold = `${ESC}[1m`;
const dim = `${ESC}[2m`;
const italic = `${ESC}[3m`;
const underline = `${ESC}[4m`;
const blink = `${ESC}[5m`;
const reverse = `${ESC}[7m`;
const hidden = `${ESC}[8m`;

const fg = (n) => `${ESC}[38;5;${n}m`;
const bg = (n) => `${ESC}[48;5;${n}m`;
const fg256 = (r, g, b) => `${ESC}[38;2;${r};${g};${b}m`;
const bg256 = (r, g, b) => `${ESC}[48;2;${r};${g};${b}m`;

const clear = `${ESC}[2J${ESC}[H`;
const hideCursor = `${ESC}[?25l`;
const showCursor = `${ESC}[?25h`;
const altScreen = `${ESC}[?1049h`;
const normalScreen = `${ESC}[?1049l`;

// Brand colors
const CYAN = fg256(0, 255, 255);
const MAGENTA = fg256(255, 0, 255);
const GREEN = fg256(0, 255, 128);
const YELLOW = fg256(255, 255, 0);
const WHITE = fg256(255, 255, 255);
const ORANGE = fg256(255, 165, 0);
const RED = fg256(255, 60, 60);
const BLUE = fg256(80, 180, 255);
const GRAY = fg256(140, 140, 160);
const DARK = fg256(60, 60, 80);

// ─── Frame buffer ─────────────────────────────────────────────────
const COLS = 80;
const ROWS = 24;
let frame = [];

function initFrame() {
  frame = Array.from({ length: ROWS }, () => Array(COLS).fill(' '));
}

function writeText(str, row, col, color = '') {
  for (let i = 0; i < str.length && col + i < COLS; i++) {
    if (row >= 0 && row < ROWS && col + i >= 0) {
      frame[row][col + i] = { ch: str[i], color };
    }
  }
}

function writeChar(ch, row, col, color = '') {
  if (row >= 0 && row < ROWS && col >= 0 && col < COLS) {
    frame[row][col] = { ch, color };
  }
}

function drawBox(row, col, w, h, color = GRAY) {
  const chars = { tl: '╔', tr: '╗', bl: '╚', br: '╝', h: '═', v: '║' };
  for (let x = 0; x < w; x++) {
    writeChar(chars.h, row, col + x, color);
    writeChar(chars.h, row + h - 1, col + x, color);
  }
  for (let y = 0; y < h; y++) {
    writeChar(chars.v, row + y, col, color);
    writeChar(chars.v, row + y, col + w - 1, color);
  }
  writeChar(chars.tl, row, col, color);
  writeChar(chars.tr, row, col + w - 1, color);
  writeChar(chars.bl, row + h - 1, col, color);
  writeChar(chars.br, row + h - 1, col + w - 1, color);
}

function renderFrame() {
  let output = clear;
  for (let r = 0; r < ROWS; r++) {
    let line = '';
    let currentColor = '';
    for (let c = 0; c < COLS; c++) {
      const cell = frame[r][c];
      if (typeof cell === 'object') {
        if (cell.color !== currentColor) {
          line += reset + (cell.color || '');
          currentColor = cell.color;
        }
        line += cell.ch;
      } else {
        if (currentColor !== '') {
          line += reset;
          currentColor = '';
        }
        line += cell;
      }
    }
    output += line + '\n';
  }
  process.stdout.write(output);
}

// ─── Scene: Black ─────────────────────────────────────────────────
function sceneBlack() {
  initFrame();
  renderFrame();
}

// ─── Scene: Logo ──────────────────────────────────────────────────
function sceneLogo(t) {
  initFrame();
  
  // Animated signal waves
  const wave = Math.floor(t / 100) % 20;
  
  // Logo ASCII art
  const logo = [
    '  ███████╗██╗ ██████╗ ███╗   ██╗ █████╗ ██╗     ██████╗ ██╗   ██╗███████╗██╗  ██╗',
    '  ██╔════╝██║██╔════╝ ████╗  ██║██╔══██╗██║     ██╔══██╗██║   ██║██╔════╝██║  ██║',
    '  ███████╗██║██║  ███╗██╔██╗ ██║███████║██║     ██████╔╝██║   ██║███████╗███████║',
    '  ╚════██║██║██║   ██║██║╚██╗██║██╔══██║██║     ██╔══██╗██║   ██║╚════██║██╔══██║',
    '  ███████║██║╚██████╔╝██║ ╚████║██║  ██║███████╗██║  ██║╚██████╔╝███████║██║  ██║',
    '  ╚══════╝╚═╝ ╚═════╝ ╚═╝  ╚═══╝╚═╝  ╚═╝╚══════╝╚═╝  ╚═╝ ╚═════╝ ╚══════╝╚═╝  ╚═╝',
  ];
  
  // Draw logo with color gradient
  for (let i = 0; i < logo.length; i++) {
    const row = 6 + i;
    for (let j = 0; j < logo[i].length; j++) {
      const ch = logo[i][j];
      if (ch === '█') {
        const color = j < 25 ? CYAN : j < 50 ? MAGENTA : ORANGE;
        writeChar(ch, row, 2 + j, color + bold);
      } else if (ch !== ' ') {
        writeChar(ch, row, 2 + j, GRAY);
      }
    }
  }
  
  // Animated signal bars
  for (let i = 0; i < 8; i++) {
    const h = 2 + Math.floor(Math.sin((t / 300) + i * 0.8) * 2 + 2);
    for (let y = 0; y < h; y++) {
      const color = i < 3 ? CYAN : i < 5 ? MAGENTA : ORANGE;
      writeChar('█', 18 - y, 10 + i * 8, color + bold);
      writeChar('█', 18 - y, 11 + i * 8, color + bold);
    }
  }
  
  // Tagline
  const tag = 'THE AD-POWERED ARCADE';
  writeText(tag, 20, Math.floor((COLS - tag.length) / 2), WHITE + bold);
  
  renderFrame();
}

// ─── Scene: Tagline ───────────────────────────────────────────────
function sceneTagline(t) {
  initFrame();
  
  const messages = [
    { text: 'PLAY GAMES', color: CYAN, size: 'big' },
    { text: 'EARN REWARDS', color: GREEN, size: 'big' },
    { text: 'BRANDS PAY THE BILLS', color: ORANGE, size: 'small' },
  ];
  
  const idx = Math.floor(t / 500) % messages.length;
  const msg = messages[idx];
  
  // Big text
  writeText(msg.text, 10, Math.floor((COLS - msg.text.length) / 2), msg.color + bold);
  
  // Subtitle
  const sub = 'Ad-funded gaming. Real rewards. Zero cost to play.';
  writeText(sub, 13, Math.floor((COLS - sub.length) / 2), GRAY);
  
  // Decorative line
  for (let i = 10; i < 70; i++) {
    writeChar('─', 15, i, DARK);
  }
  
  renderFrame();
}

// ─── Scene: Gameplay 1 (AI Hunt) ──────────────────────────────────
function sceneGameplay1(t) {
  initFrame();
  
  // Header
  writeText('▶ AI HUNT', 1, 2, CYAN + bold);
  writeText('Dodge AI patrols • Collect data packets • Survive', 1, 20, GRAY);
  
  // Game viewport
  drawBox(3, 2, 50, 16, DARK);
  
  // Animated player
  const px = 8 + Math.floor(Math.sin(t / 400) * 5);
  const py = 5 + Math.floor(Math.cos(t / 500) * 3);
  writeChar('◆', py, px, GREEN + bold);
  
  // AI enemies
  const enemies = [
    { x: 20 + Math.floor(Math.sin(t / 600) * 8), y: 6 },
    { x: 35 + Math.floor(Math.cos(t / 700) * 5), y: 10 },
    { x: 42, y: 8 + Math.floor(Math.sin(t / 550) * 3) },
  ];
  for (const e of enemies) {
    writeChar('▲', e.y, e.x, RED + bold);
    writeChar('▼', e.y + 1, e.x, RED);
  }
  
  // Data packets
  const packets = [
    { x: 15, y: 12, collected: Math.floor(t / 1000) % 3 === 0 },
    { x: 28, y: 7, collected: Math.floor(t / 1000) % 4 === 0 },
    { x: 38, y: 14, collected: false },
  ];
  for (const p of packets) {
    if (!p.collected) {
      writeChar('●', p.y, p.x, YELLOW + bold);
    }
  }
  
  // HUD
  writeText(`SCORE: ${1247 + Math.floor(t / 10) % 500}`, 3, 54, WHITE + bold);
  writeText(`LIVES: ♥ ♥ ♥`, 5, 54, RED);
  writeText(`COMBO: x${3 + Math.floor(t / 800) % 5}`, 7, 54, ORANGE);
  writeText(`SHIELD: ████████░░`, 9, 54, CYAN);
  
  // Sponsor card (corner)
  drawBox(14, 54, 24, 5, DARK);
  writeText('SPONSORED BY', 14, 56, GRAY);
  writeText('ACME CORP', 15, 58, WHITE + bold);
  writeText('500 impressions today', 16, 56, GRAY);
  
  renderFrame();
}

// ─── Scene: Gameplay 2 (Packet Hop) ───────────────────────────────
function sceneGameplay2(t) {
  initFrame();
  
  // Header
  writeText('▶ PACKET HOP', 1, 2, MAGENTA + bold);
  writeText('Cross the network • Avoid firewalls • Reach the server', 1, 22, GRAY);
  
  // Game viewport
  drawBox(3, 2, 50, 16, DARK);
  
  // Lanes
  for (let lane = 0; lane < 5; lane++) {
    const y = 5 + lane * 3;
    for (let x = 4; x < 50; x++) {
      writeChar('·', y, x, DARK);
    }
  }
  
  // Player (hopping animation)
  const hopPhase = (t / 200) % 3;
  const playerLane = 2 + Math.floor(Math.sin(t / 800) * 2);
  const playerY = 5 + playerLane * 3;
  const playerX = 8 + Math.floor(Math.sin(t / 300) * 3);
  const playerChar = hopPhase < 1 ? '○' : hopPhase < 2 ? '◉' : '●';
  writeChar(playerChar, playerY - 1, playerX, GREEN + bold);
  writeChar('│', playerY, playerX, GREEN);
  
  // Obstacles (firewalls)
  const obstacles = [
    { x: 18 + Math.floor(Math.sin(t / 500) * 3), y: 5 },
    { x: 30, y: 11 },
    { x: 40 + Math.floor(Math.cos(t / 600) * 2), y: 8 },
    { x: 25, y: 14 },
  ];
  for (const o of obstacles) {
    writeChar('▓', o.y, o.x, RED + bold);
    writeChar('▓', o.y, o.x + 1, RED);
  }
  
  // Goal
  writeChar('▣', 10, 48, YELLOW + bold);
  writeText('SERVER', 11, 46, YELLOW);
  
  // HUD
  writeText(`LEVEL: ${2 + Math.floor(t / 2000) % 3}`, 3, 54, WHITE + bold);
  writeText(`LATENCY: ${42 + Math.floor(t / 100) % 20}ms`, 5, 54, GREEN);
  writeText(`PACKETS: ${156 + Math.floor(t / 50) % 100}`, 7, 54, CYAN);
  writeText(`FIREWALLS: ████░░░░`, 9, 54, RED);
  
  // Sponsor card
  drawBox(14, 54, 24, 5, DARK);
  writeText('SPONSORED BY', 14, 56, GRAY);
  writeText('TECHSTART.IO', 15, 57, WHITE + bold);
  writeText('1.2K impressions today', 16, 56, GRAY);
  
  renderFrame();
}

// ─── Scene: Economy ───────────────────────────────────────────────
function sceneEconomy(t) {
  initFrame();
  
  writeText('HOW IT WORKS', 2, Math.floor((COLS - 12) / 2), WHITE + bold);
  
  // Flow diagram
  const steps = [
    { icon: '🏢', label: 'ADVERTISERS', sub: 'Fund the reward pool', color: ORANGE },
    { icon: '🎮', label: 'PLAYERS', sub: 'Play free games', color: CYAN },
    { icon: '💰', label: 'REWARDS', sub: 'Earn real value', color: GREEN },
    { icon: '📊', label: 'ANALYTICS', sub: 'Track performance', color: MAGENTA },
  ];
  
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    const x = 5 + i * 19;
    const pulse = Math.floor(t / 300) % 4 === i;
    
    // Box
    drawBox(5, x, 16, 8, pulse ? s.color : DARK);
    
    // Icon
    writeText(s.icon, 6, x + 6, s.color + bold);
    
    // Label
    writeText(s.label, 8, x + Math.floor((16 - s.label.length) / 2), s.color + bold);
    
    // Sub
    writeText(s.sub, 10, x + Math.floor((16 - s.sub.length) / 2), GRAY);
    
    // Arrow to next
    if (i < 3) {
      writeText('──▶', 9, x + 15, DARK);
    }
  }
  
  // Stats
  const stats = [
    { label: 'TOTAL POOL', value: '$2,847.32', color: GREEN },
    { label: 'PLAYERS TODAY', value: '1,247', color: CYAN },
    { label: 'ADS SERVED', value: '34.2K', color: ORANGE },
    { label: 'PAYOUT RATE', value: '20%', color: MAGENTA },
  ];
  
  for (let i = 0; i < stats.length; i++) {
    const s = stats[i];
    const x = 5 + i * 19;
    writeText(s.label, 15, x + 2, GRAY);
    writeText(s.value, 16, x + 3, s.color + bold);
  }
  
  renderFrame();
}

// ─── Scene: Sponsors ──────────────────────────────────────────────
function sceneSponsors(t) {
  initFrame();
  
  writeText('TRUSTED BY BRANDS', 2, Math.floor((COLS - 17) / 2), WHITE + bold);
  
  // Fake sponsor logos (ASCII)
  const sponsors = [
    { name: 'ACME CORP', tagline: 'Innovation for all', color: ORANGE },
    { name: 'TECHSTART', tagline: 'Build the future', color: CYAN },
    { name: 'CLOUDIFY', tagline: 'Scale infinitely', color: BLUE },
    { name: 'DATASTREAM', tagline: 'Real-time insights', color: GREEN },
    { name: 'PIXELWORKS', tagline: 'Design matters', color: MAGENTA },
    { name: 'NETGEAR+', tagline: 'Connect everything', color: YELLOW },
  ];
  
  for (let i = 0; i < sponsors.length; i++) {
    const s = sponsors[i];
    const col = i % 3;
    const row = Math.floor(i / 3);
    const x = 5 + col * 25;
    const y = 5 + row * 7;
    
    const pulse = Math.floor(t / 400) % 6 === i;
    
    drawBox(y, x, 22, 5, pulse ? s.color : DARK);
    writeText(s.name, y + 1, x + Math.floor((22 - s.name.length) / 2), s.color + bold);
    writeText(s.tagline, y + 3, x + Math.floor((22 - s.tagline.length) / 2), GRAY);
  }
  
  renderFrame();
}

// ─── Scene: Call to Action ────────────────────────────────────────
function sceneCTA(t) {
  initFrame();
  
  // Big CTA
  const pulse = Math.floor(t / 500) % 2 === 0;
  
  // Top decoration
  for (let i = 0; i < COLS; i++) {
    writeChar('═', 2, i, pulse ? CYAN : DARK);
  }
  
  // Main message
  writeText('PLAY FREE. EARN REAL.', 5, Math.floor((COLS - 21) / 2), WHITE + bold);
  
  // Sub message
  const sub = 'The ad-powered arcade where your time has value';
  writeText(sub, 7, Math.floor((COLS - sub.length) / 2), GRAY);
  
  // URL (big)
  const url = 'signalrush.gg';
  writeText(url, 10, Math.floor((COLS - url.length) / 2), CYAN + bold + (pulse ? blink : ''));
  
  // QR placeholder
  drawBox(13, 30, 20, 8, DARK);
  writeText('┌──────────────┐', 13, 30, GRAY);
  writeText('│ ▄▄▄ █▀▄ ▄▄▄ │', 14, 30, WHITE);
  writeText('█ █▄█ ▄▀█ █▄█', 15, 31, WHITE);
  writeText('█ ▄▀▄ █▀▄ ▄▀▄', 16, 31, WHITE);
  writeText('▀ ▀▀▀ ▀▀▀ ▀▀▀', 17, 31, WHITE);
  writeText('└──────────────┘', 18, 30, GRAY);
  writeText('SCAN TO PLAY', 19, 33, GRAY);
  
  // Bottom features
  const features = '✦ FREE TO PLAY  ✦ REAL REWARDS  ✦ NO ADS IN-GAME  ✦ INSTANT PAYOUTS';
  writeText(features, 22, Math.floor((COLS - features.length) / 2), DARK);
  
  renderFrame();
}

// ─── Main loop ────────────────────────────────────────────────────
function main() {
  process.stdout.write(altScreen + hideCursor);
  
  let sceneIndex = 0;
  let sceneStart = Date.now();
  let lastFrame = 0;
  
  function tick() {
    const now = Date.now();
    const elapsed = now - sceneStart;
    
    // Find current scene
    let acc = 0;
    let currentScene = 0;
    for (let i = 0; i < SCENES.length; i++) {
      acc += SCENES[i].duration;
      if (elapsed < acc) {
        currentScene = i;
        break;
      }
      if (i === SCENES.length - 1) {
        // Done
        process.stdout.write(showCursor + normalScreen + reset);
        process.exit(0);
      }
    }
    
    const sceneTime = elapsed - (acc - SCENES[currentScene].duration);
    
    // Render scene
    switch (SCENES[currentScene].name) {
      case 'black': sceneBlack(); break;
      case 'logo': sceneLogo(sceneTime); break;
      case 'tagline': sceneTagline(sceneTime); break;
      case 'gameplay1': sceneGameplay1(sceneTime); break;
      case 'gameplay2': sceneGameplay2(sceneTime); break;
      case 'economy': sceneEconomy(sceneTime); break;
      case 'sponsors': sceneSponsors(sceneTime); break;
      case 'cta': sceneCTA(sceneTime); break;
    }
    
    // ~30fps
    const nextFrame = now + 33;
    const delay = Math.max(0, nextFrame - Date.now());
    setTimeout(tick, delay);
  }
  
  // Handle exit
  process.on('SIGINT', () => {
    process.stdout.write(showCursor + normalScreen + reset);
    process.exit(0);
  });
  
  // Key press exits (only in TTY)
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.on('data', () => {
      process.stdout.write(showCursor + normalScreen + reset);
      process.exit(0);
    });
  }
  
  tick();
}

main();
