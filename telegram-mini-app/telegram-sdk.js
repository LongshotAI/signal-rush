/**
 * telegram-sdk.js — Telegram Mini App SDK wrapper
 *
 * Provides a clean async interface over the Telegram Web App SDK:
 *   - initTelegramMiniApp()   — ready, expand, theme, return init data
 *   - hapticFeedback(type)   — haptic impact feedback
 *   - showMainButton(text, onClick) — configure & show TG MainButton
 *   - closeMiniApp()          — close the mini app
 *
 * Gracefully degrades when the SDK is not available (local development).
 */

let _tg = null;
let _mainButtonHandler = null;
let _themeHandler = null;

/**
 * Load the Telegram Web App SDK script dynamically.
 * Returns a promise that resolves when the script has loaded.
 *
 * @returns {Promise<void>}
 */
function _loadSDKScript() {
  return new Promise((resolve, reject) => {
    // If already loaded, resolve immediately
    if (window.Telegram && window.Telegram.WebApp) {
      resolve();
      return;
    }

    const script = document.createElement('script');
    script.src = 'https://telegram.org/js/telegram-web-app.js';
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('Failed to load Telegram SDK'));
    document.head.appendChild(script);
  });
}

/**
 * Initialise the Telegram Mini App.
 *
 * Loads the SDK script, calls ready() and expand(), sets up theme handling,
 * and returns the init data.
 *
 * @returns {Promise<{initData: string, initDataUnsafe: object, isTelegramMode: boolean}>}
 */
export async function initTelegramMiniApp() {
  try {
    await _loadSDKScript();
  } catch (_) {
    // SDK failed to load — local dev mode
    console.warn('[telegram-sdk] SDK not available — running in local dev mode');
    return {
      initData: '',
      initDataUnsafe: null,
      isTelegramMode: false,
    };
  }

  _tg = window.Telegram.WebApp;

  // Signal ready to Telegram
  _tg.ready();

  // Expand to full screen
  _tg.expand();

  // Listen for theme changes
  _themeHandler = (evt) => {
    // evt.detail is not standard — colorScheme is on the WebApp object itself
  };
  _tg.onEvent('themeChanged', () => {
    _applyTheme(_tg.colorScheme || 'dark');
  });

  // Apply initial theme
  _applyTheme(_tg.colorScheme || 'dark');

  return {
    initData: _tg.initData || '',
    initDataUnsafe: _tg.initDataUnsafe || null,
    isTelegramMode: true,
  };
}

/**
 * Trigger haptic feedback.
 *
 * @param {string} [type='medium']  — 'light' | 'medium' | 'heavy' | 'rigid' | 'soft'
 *                                     Also supports 'success' | 'warning' | 'error'
 *                                     for notificationFeedback. Falls back to
 *                                     impactOccurred for the standard types.
 */
export function hapticFeedback(type = 'medium') {
  if (!_tg || !_tg.HapticFeedback) return;

  const impactTypes = ['light', 'medium', 'heavy', 'rigid', 'soft'];
  const notificationTypes = ['success', 'warning', 'error'];

  try {
    if (impactTypes.includes(type)) {
      _tg.HapticFeedback.impactOccurred(type);
    } else if (notificationTypes.includes(type)) {
      _tg.HapticFeedback.notificationOccurred(type);
    } else {
      _tg.HapticFeedback.impactOccurred('medium');
    }
  } catch (e) {
    // Silently ignore — haptic is best-effort
  }
}

/**
 * Show and configure the Telegram Main Button.
 *
 * @param {string}   text     — Button label text
 * @param {function} onClick  — Click handler
 * @param {object}   [opts]   — Optional settings
 * @param {string}   [opts.color] — Button background color (hex)
 * @param {string}   [opts.textColor] — Button text color (hex)
 */
export function showMainButton(text, onClick, opts = {}) {
  if (!_tg || !_tg.MainButton) return;

  // Remove previous handler if any
  if (_mainButtonHandler) {
    _tg.MainButton.offClick(_mainButtonHandler);
  }

  _mainButtonHandler = onClick;

  _tg.MainButton.setText(text);

  if (opts.color) _tg.MainButton.color = opts.color;
  if (opts.textColor) _tg.MainButton.textColor = opts.textColor;

  _tg.MainButton.onClick(_mainButtonHandler);
  _tg.MainButton.show();
}

/**
 * Hide the Telegram Main Button.
 */
export function hideMainButton() {
  if (!_tg || !_tg.MainButton) return;
  if (_mainButtonHandler) {
    _tg.MainButton.offClick(_mainButtonHandler);
    _mainButtonHandler = null;
  }
  _tg.MainButton.hide();
}

/**
 * Close the Telegram Mini App.
 */
export function closeMiniApp() {
  if (!_tg || !_tg.close) return;
  _tg.close();
}

/**
 * Check if running inside Telegram.
 *
 * @returns {boolean}
 */
export function isTelegramMode() {
  return _tg !== null;
}

// ── Internal ─────────────────────────────────────────────────────────────────

function _applyTheme(scheme) {
  // scheme is 'light' or 'dark'
  const root = document.documentElement;
  if (scheme === 'light') {
    root.style.setProperty('--tg-bg', '#ffffff');
    root.style.setProperty('--tg-text', '#000000');
    root.style.setProperty('--tg-hint', '#999999');
    root.style.setProperty('--tg-link', '#2481cc');
    root.style.setProperty('--tg-button', '#2481cc');
    root.style.setProperty('--tg-button-text', '#ffffff');
    root.style.setProperty('--tg-secondary-bg', '#f0f0f0');
  } else {
    root.style.setProperty('--tg-bg', '#0a0a1a');
    root.style.setProperty('--tg-text', '#ffffff');
    root.style.setProperty('--tg-hint', '#7d7d80');
    root.style.setProperty('--tg-link', '#6ab2f2');
    root.style.setProperty('--tg-button', '#2481cc');
    root.style.setProperty('--tg-button-text', '#ffffff');
    root.style.setProperty('--tg-secondary-bg', '#1c1c1e');
  }
}
