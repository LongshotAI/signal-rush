/**
 * entry.js — Mini App entry point
 *
 * External module so it can be loaded under a strict CSP that disallows
 * inline scripts (script-src 'self' https://telegram.org).
 *
 * Responsibilities:
 *   1. Bootstrap the game via init() with global error handlers
 *   2. Show a diagnostic overlay if init hangs for 15s
 *   3. Run a sanity check at 3s to catch silent UI failures
 *   4. Wire keyboard shortcuts (P=pause, R=reset)
 */

import { init, destroy } from './game.js?v=20260630';

function showError(title, detail) {
  const ov = document.createElement('div');
  ov.id = 'error-overlay';
  ov.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.95);z-index:9999;color:#ff3355;font-family:monospace;font-size:12px;padding:16px;overflow:auto;white-space:pre-wrap;word-break:break-word;';
  ov.textContent = title + '\n\n' + detail;
  document.body.appendChild(ov);
  const spinner = document.getElementById('loading-spinner');
  if (spinner) spinner.style.display = 'none';
}

window.addEventListener('error', (e) => showError('JS Error: ' + e.message, e.error?.stack || ''));
window.addEventListener('unhandledrejection', (e) => showError('Promise Rejection:', e.reason?.stack || String(e.reason)));

const loadTimeout = setTimeout(() => {
  showError('Game stuck loading after 15 seconds',
    'window.Telegram: ' + (window.Telegram ? 'exists' : 'missing') + '\n' +
    'Telegram.WebApp: ' + (window.Telegram?.WebApp ? 'exists' : 'missing') + '\n' +
    'userAgent: ' + navigator.userAgent.substring(0, 100) + '\n' +
    'scripts loaded: ' + document.querySelectorAll('script').length + '\n' +
    'game-container: ' + (document.getElementById('game-container') ? 'exists' : 'missing')
  );
}, 15000);

try {
  let engine = await init('#game-container');
  clearTimeout(loadTimeout);

  setTimeout(() => {
    const canvas = document.querySelector('canvas');
    const bar = document.getElementById('mode-selector-bar');
    const chips = bar ? bar.querySelectorAll('button') : [];
    let diag = 'SANITY CHECK (3s after load):\n';
    diag += 'canvas: ' + (canvas ? canvas.width + 'x' + canvas.height : 'MISSING') + '\n';
    diag += 'canvas visible: ' + (canvas && canvas.width > 0 && canvas.offsetParent !== null ? 'YES' : 'NO') + '\n';
    diag += 'mode chips: ' + chips.length + '\n';
    diag += 'game-container: ' + (() => { const c = document.getElementById('game-container'); return c ? c.offsetWidth + 'x' + c.offsetHeight : 'MISSING'; })() + '\n';
    diag += 'game-wrapper: ' + (() => { const w = document.getElementById('game-wrapper'); return w ? w.offsetWidth + 'x' + w.offsetHeight : 'MISSING'; })() + '\n';
    diag += 'body size: ' + window.innerWidth + 'x' + window.innerHeight + '\n';
    if ((engine) && (!canvas || canvas.width < 10 || chips.length === 0)) {
      showError('Game loaded but UI is broken:\n' + diag, 'Check console for details.');
    }
    console.log('[SignalRush] ' + diag);
  }, 3000);

  window.addEventListener('keydown', (e) => {
    if (e.code === 'KeyP' && engine) {
      engine.step({ pause: true });
    }
    if (e.code === 'KeyR' && engine) {
      engine.reset();
    }
  });

  window.addEventListener('beforeunload', () => {
    destroy();
  });
} catch (err) {
  console.error('[SignalRush] Init failed:', err);
  showError('Init failed: ' + err.message, err.stack || '');
  const container = document.querySelector('#game-container');
  if (container) {
    container.innerHTML = `<div style="color:#ff3355;padding:20px;text-align:center;font-family:monospace;">
      Failed to load game: ${err.message}<br>
      <small>${err.stack || ''}</small>
    </div>`;
  }
}