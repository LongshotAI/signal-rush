const { renderMenuFrame, renderFrame } = require('../src/cli/render');
const { setActiveCampaigns, apiCampaignToSponsor } = require('../src/content/sponsors');
const fs = require('fs');

// Menu without sponsor (default)
const menuDefault = renderMenuFrame(0, { colors: true });

// Menu with active client campaign
setActiveCampaigns([apiCampaignToSponsor({
  id: 'acme-corp',
  brand_name: 'Acme Corp',
  name: 'Acme Summer Campaign',
  placement_type: 'menu_frame',
  creatives: [
    { type: 'logo', content: { lines: [
      '  ▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄  ',
      '  █░░░░░░░░░░░░░░░░░░░█  ',
      '  █░█▀▀▀█░█░█▀▀▀█░█▀▀░█  ',
      '  █░█░░░█░█░█░░░█░█░░░█  ',
      '  █░█▄▄▄█░█░█▄▄▄█░█▄▄░█  ',
      '  █░░░░░░░░░░░░░░░░░░░█  ',
      '  ▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀  ',
    ]}},
    { type: 'label', content: { text: '[ ACME ]' }},
    { type: 'interstitial', content: { headline: 'Powered by Acme', body: 'Acme Corp — building the future.', cta: 'Visit acme.com' }},
  ],
})]);
const menuSponsor = renderMenuFrame(0, { colors: true });

// Reset
setActiveCampaigns([]);

// Gameplay frame
const sampleState = {
  mode: 'aiHunt',
  player: { x: 9, y: 6, health: 6 },
  hazards: [
    { x: 3, y: 2, kind: 'standard' },
    { x: 7, y: 3, kind: 'standard' },
    { x: 12, y: 2, kind: 'corruptor' },
    { x: 5, y: 7, kind: 'standard' },
  ],
  pickups: [
    { x: 2, y: 1 }, { x: 10, y: 1 }, { x: 14, y: 1 },
    { x: 11, y: 5 }, { x: 3, y: 8 },
  ],
  trail: { x: 8, y: 5, from: { x: 7, y: 6 }, to: { x: 9, y: 6 } },
  score: 1250, combo: 2.5, credits: 45, dashCooldown: 0,
  nearMissStreak: 3, message: 'CHAIN x2.5  +$30',
  sponsorLabelIndex: 0, gameOver: false, paused: false,
  invulnerable: 0, moveFlash: 0, inputPulse: 0, bestScore: 3400,
};
const gameView = renderFrame(sampleState, { columns: 100, rows: 40 }, { colors: true });

// ANSI to HTML
const colorMap = {
  '31': '#ff6b6b', '32': '#50fa7b', '33': '#ffd93d', '34': '#5dade2',
  '35': '#bd93f9', '36': '#00d4ff', '37': '#e6edf3'
};

function cssFor(cls) {
  const styles = [];
  let bold = false, dim = false;
  for (const c of cls) {
    if (c === '1') bold = true;
    else if (c === '2') dim = true;
    else if (colorMap[c]) styles.push('color:' + colorMap[c]);
  }
  if (bold) styles.push('font-weight:bold');
  if (dim) styles.push('opacity:0.45');
  return styles.join(';');
}

function lineToHtml(line) {
  const parts = line.split(/(\x1b\[[0-9;]*m)/);
  let html = [];
  let cls = [];
  for (const p of parts) {
    const m = p.match(/\x1b\[([0-9;]*)m/);
    if (m) {
      for (const c of m[1].split(';')) {
        if (c === '0') cls = [];
        else cls.push(c);
      }
    } else if (p) {
      const e = p.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
      if (cls.length) {
        html.push('<span style="' + cssFor(cls) + '">' + e + '</span>');
      } else {
        html.push(e);
      }
    }
  }
  return html.join('');
}

function renderToHtml(ansiText) {
  return ansiText.split('\n').map(l => lineToHtml(l)).join('\n');
}

const html = `<!DOCTYPE html>
<html><head><style>
body{background:#0d1117;color:#e6edf3;font-family:'Courier New',monospace;font-size:12px;line-height:1.3;white-space:pre;padding:20px;}
h2{color:#00d4ff;font-size:14px;margin:10px 0 5px;}
.wrap{background:#161b22;border:1px solid #30363d;border-radius:6px;padding:8px 12px;margin-bottom:20px;}
</style></head><body>
<h2>SIGNAL RUSH - START MENU (Default, no sponsor)</h2>
<div class="wrap">${renderToHtml(menuDefault)}</div>
<h2>SIGNAL RUSH - START MENU (With Acme Corp sponsor campaign)</h2>
<div class="wrap">${renderToHtml(menuSponsor)}</div>
<h2>SIGNAL RUSH - GAMEPLAY (AI HUNT MODE)</h2>
<div class="wrap">${renderToHtml(gameView)}</div>
</body></html>`;

fs.writeFileSync('/tmp/game-render.html', html);
console.log('Done');
