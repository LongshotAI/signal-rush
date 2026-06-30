#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { createEngine } = require('../src/core/engine');
const { renderFrame } = require('../src/cli/render');

const outDir = '/tmp/signal-rush-video';
fs.mkdirSync(outDir, { recursive: true });
const assPath = path.join(outDir, 'gameplay.ass');
const mp4Path = path.join(outDir, 'signal-rush-gameplay-proof.mp4');

function assTime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const cs = Math.floor((seconds - Math.floor(seconds)) * 100);
  return `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}.${String(cs).padStart(2,'0')}`;
}

function escAss(s) {
  return String(s)
    .replace(/\\/g, '\\\\')
    .replace(/\{/g, '\\{')
    .replace(/\}/g, '\\}')
    .replace(/\r?\n/g, '\\N');
}

function frameText(title, lines) {
  const body = Array.isArray(lines) ? lines.join('\n') : String(lines);
  return `${title}\n${'='.repeat(96)}\n${body}`;
}

function stepSequence(engine, moves, frames, title) {
  for (let i = 0; i < moves.length; i++) {
    const move = moves[i];
    engine.step(move ? { move } : {});
    if (i % 2 === 0) {
      const lines = renderFrame(engine.state, { columns: 100, rows: 38 }, { noColor: true });
      frames.push(frameText(title, lines));
    }
  }
}

const frames = [];

// AI Hunt proof sequence
const ai = createEngine({ mode: 'aiHunt', seed: 'launch-video-ai-hunt' });
frames.push(frameText('SIGNAL RUSH — AI HUNT GAMEPLAY', renderFrame(ai.state, { columns: 100, rows: 38 }, { noColor: true })));
stepSequence(ai, [
  {x:0,y:-1},{x:1,y:0},{x:1,y:0},{x:0,y:1},{x:0,y:1},{x:-1,y:0},
  {x:-1,y:0},{x:0,y:-1},{x:1,y:0},{x:0,y:-1},{x:1,y:0},{x:0,y:1},
  {x:0,y:1},{x:-1,y:0},{x:0,y:-1},{x:1,y:0},{x:1,y:0},{x:0,y:1},
], frames, 'SIGNAL RUSH — AI HUNT: dodge AI, collect signal, earn rewards');

// Packet Hop proof sequence, including countdown then playable logs/cars
const frog = createEngine({ mode: 'frogger', seed: 'launch-video-packet-hop' });
frames.push(frameText('SIGNAL RUSH — PACKET HOP COUNTDOWN LOCK', renderFrame(frog.state, { columns: 100, rows: 38 }, { noColor: true })));
for (let i = 0; i < 32; i++) {
  // Attempted movement during countdown should remain locked until GO.
  frog.step({ move: { x: 0, y: -1 } });
  if (i % 5 === 0 || i === 31) frames.push(frameText('PACKET HOP — GET READY / WAIT FOR GO', renderFrame(frog.state, { columns: 100, rows: 38 }, { noColor: true })));
}
stepSequence(frog, [
  {x:0,y:-1},{x:0,y:-1},{x:1,y:0},{x:0,y:-1},{x:0,y:-1},{x:-1,y:0},
  {x:0,y:-1},{x:1,y:0},{x:0,y:-1},{x:0,y:-1},{x:-1,y:0},{x:0,y:-1},
], frames, 'SIGNAL RUSH — PACKET HOP: logs, cars, goal slots');

const header = `[Script Info]\nTitle: Signal Rush Gameplay Proof\nScriptType: v4.00+\nPlayResX: 1920\nPlayResY: 1080\nWrapStyle: 0\nScaledBorderAndShadow: yes\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Mono,DejaVu Sans Mono,24,&H00E8FFF2,&H0000FFFF,&H00100000,&HAA000000,0,0,0,0,100,100,0,0,1,2,0,7,40,40,35,1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n`;

let t = 0;
const dur = 0.38;
const events = frames.map((txt) => {
  const start = assTime(t);
  t += dur;
  const end = assTime(t);
  return `Dialogue: 0,${start},${end},Mono,,0,0,0,,${escAss(txt)}`;
}).join('\n');

fs.writeFileSync(assPath, header + events + '\n');

const ff = spawnSync('ffmpeg', [
  '-y',
  '-f', 'lavfi',
  '-i', `color=c=0x020208:s=1920x1080:d=${Math.ceil(t + 1)}:r=30`,
  '-vf', `subtitles=${assPath}:fontsdir=/usr/share/fonts/truetype/dejavu`,
  '-c:v', 'libx264',
  '-pix_fmt', 'yuv420p',
  '-movflags', '+faststart',
  mp4Path,
], { encoding: 'utf8' });

if (ff.status !== 0) {
  console.error(ff.stderr || ff.stdout);
  process.exit(ff.status || 1);
}

console.log(mp4Path);
console.log(`frames=${frames.length} duration=${t.toFixed(2)}s`);
