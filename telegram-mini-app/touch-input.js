/**
 * touch-input.js — Mobile touch input module for Signal Rush
 *
 * Provides three simultaneous input methods:
 *   1. Virtual D-pad overlay (4 directional buttons rendered on screen)
 *   2. Touch-and-drag gestures (swipe in any direction on the canvas)
 *   3. Tap-to-move (tap a canvas quadrant to move that direction)
 *
 * All methods emit the same {x, y} move format the engine expects
 * where each component is -1, 0, or 1.
 *
 * Works alongside existing keyboard input — both are active simultaneously.
 *
 * Exports:
 *   initTouchInput(canvasEl, onMove)  — set up all touch listeners
 *   destroyTouchInput()               — tear down everything
 */

// ── State ────────────────────────────────────────────────────────────────────

let _canvasEl = null;
let _onMove = null;
let _dPadEl = null;
let _dPadState = { up: false, down: false, left: false, right: false };

// Drag state
let _dragActive = false;
let _dragStartX = 0;
let _dragStartY = 0;
let _lastDragMove = null;

// Bound handler references (for removal)
let _boundHandlers = [];

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Initialise touch input on the given canvas element.
 *
 * @param {HTMLCanvasElement} canvasEl  The game canvas
 * @param {function({x:number, y:number}):void} onMove  Callback receiving moves
 */
export function initTouchInput(canvasEl, onMove) {
  _canvasEl = canvasEl;
  _onMove = onMove;

  _buildDPad();
  _attachCanvasGestures();
}

/**
 * Tear down all touch input listeners and remove the D-pad from the DOM.
 */
export function destroyTouchInput() {
  // Remove all tracked event listeners
  for (const { target, event, handler, opts } of _boundHandlers) {
    target.removeEventListener(event, handler, opts);
  }
  _boundHandlers = [];

  // Remove D-pad
  if (_dPadEl && _dPadEl.parentNode) {
    _dPadEl.parentNode.removeChild(_dPadEl);
  }
  _dPadEl = null;
  _dPadState = { up: false, down: false, left: false, right: false };

  _canvasEl = null;
  _onMove = null;
  _dragActive = false;
  _lastDragMove = null;
}

// ── D-Pad overlay ────────────────────────────────────────────────────────────

function _buildDPad() {
  // Create D-pad container
  const container = document.createElement('div');
  container.id = 'touch-dpad';
  Object.assign(container.style, {
    position: 'fixed',
    bottom: '24px',
    left: '16px',
    zIndex: '1000',
    width: '160px',
    height: '160px',
    opacity: '0.7',
    touchAction: 'none',
    userSelect: 'none',
    WebkitUserSelect: 'none',
    pointerEvents: 'auto',
  });

  // Button layout: 3×3 grid
  const grid = document.createElement('div');
  Object.assign(grid.style, {
    display: 'grid',
    gridTemplateColumns: 'repeat(3, 1fr)',
    gridTemplateRows: 'repeat(3, 1fr)',
    gap: '4px',
    width: '100%',
    height: '100%',
  });

  const btnStyle = {
    width: '100%',
    height: '100%',
    background: 'rgba(255,255,255,0.06)',
    border: '1px solid rgba(255,255,255,0.12)',
    borderRadius: '10px',
    color: 'rgba(255,255,255,0.5)',
    fontSize: '22px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    touchAction: 'none',
    userSelect: 'none',
    WebkitUserSelect: 'none',
    cursor: 'pointer',
    transition: 'background 0.1s, border-color 0.1s, color 0.1s',
  };

  const activeStyle = {
    background: 'rgba(0,255,136,0.18)',
    borderColor: 'rgba(0,255,136,0.35)',
    color: '#00ff88',
  };

  // Build buttons: [ , ↑,  , ←,  , →,  , ↓,  ]
  const layout = [
    { dir: null, label: '' },
    { dir: 'up', label: '↑' },
    { dir: null, label: '' },
    { dir: 'left', label: '←' },
    { dir: null, label: '' },
    { dir: 'right', label: '→' },
    { dir: null, label: '' },
    { dir: 'down', label: '↓' },
    { dir: null, label: '' },
  ];

  for (const item of layout) {
    const btn = document.createElement('button');
    btn.textContent = item.label;
    Object.assign(btn.style, btnStyle);

    if (item.dir) {
      // Touch start
      _addListener(btn, 'touchstart', (e) => {
        e.preventDefault();
        _dPadState[item.dir] = true;
        Object.assign(btn.style, activeStyle);
        _emitDPadMove();
      }, { passive: false });

      // Touch end
      _addListener(btn, 'touchend', (e) => {
        e.preventDefault();
        _dPadState[item.dir] = false;
        Object.assign(btn.style, btnStyle);
        _emitDPadMove();
      }, { passive: false });

      // Touch cancel
      _addListener(btn, 'touchcancel', () => {
        _dPadState[item.dir] = false;
        Object.assign(btn.style, btnStyle);
        _emitDPadMove();
      });

      // Mouse fallback (for testing on desktop)
      _addListener(btn, 'mousedown', () => {
        _dPadState[item.dir] = true;
        Object.assign(btn.style, activeStyle);
        _emitDPadMove();
      });
      _addListener(btn, 'mouseup', () => {
        _dPadState[item.dir] = false;
        Object.assign(btn.style, btnStyle);
        _emitDPadMove();
      });
      _addListener(btn, 'mouseleave', () => {
        if (_dPadState[item.dir]) {
          _dPadState[item.dir] = false;
          Object.assign(btn.style, btnStyle);
          _emitDPadMove();
        }
      });
    }

    grid.appendChild(btn);
  }

  container.appendChild(grid);

  // Only show on touch devices (coarse pointer)
  if (window.matchMedia('(pointer: coarse)').matches) {
    document.body.appendChild(container);
  } else {
    // Still add to DOM so it's available if touch is detected later,
    // but hidden via CSS
    container.style.display = 'none';
    document.body.appendChild(container);

    // Show if touch events are detected
    const showOnTouch = () => {
      container.style.display = 'block';
      window.removeEventListener('touchstart', showOnTouch);
    };
    window.addEventListener('touchstart', showOnTouch, { once: true });
  }

  _dPadEl = container;
}

function _emitDPadMove() {
  if (!_onMove) return;
  let x = 0, y = 0;
  if (_dPadState.up)    y -= 1;
  if (_dPadState.down)  y += 1;
  if (_dPadState.left)  x -= 1;
  if (_dPadState.right) x += 1;
  if (x === 0 && y === 0) return;
  _onMove({ x, y });
}

// ── Canvas gestures (swipe + tap-to-move) ───────────────────────────────────

function _attachCanvasGestures() {
  if (!_canvasEl) return;

  // Swipe / drag gesture
  _addListener(_canvasEl, 'touchstart', (e) => {
    e.preventDefault();
    const touch = e.touches[0];
    _dragActive = true;
    _dragStartX = touch.clientX;
    _dragStartY = touch.clientY;
    _lastDragMove = null;
  }, { passive: false });

  _addListener(_canvasEl, 'touchmove', (e) => {
    if (!_dragActive) return;
    e.preventDefault();

    const touch = e.touches[0];
    const dx = touch.clientX - _dragStartX;
    const dy = touch.clientY - _dragStartY;

    // Threshold: 20px for swipe detection
    const threshold = 20;
    let mx = 0, my = 0;
    if (Math.abs(dx) > threshold) mx = dx > 0 ? 1 : -1;
    if (Math.abs(dy) > threshold) my = dy > 0 ? 1 : -1;

    if (mx !== 0 || my !== 0) {
      const move = { x: mx, y: my };
      // Only emit when direction changes
      if (!_lastDragMove || _lastDragMove.x !== move.x || _lastDragMove.y !== move.y) {
        _lastDragMove = move;
        if (_onMove) _onMove(move);
      }
    }
  }, { passive: false });

  _addListener(_canvasEl, 'touchend', (e) => {
    if (!_dragActive) return;
    e.preventDefault();
    _dragActive = false;
    _lastDragMove = null;
  }, { passive: false });

  _addListener(_canvasEl, 'touchcancel', () => {
    _dragActive = false;
    _lastDragMove = null;
  });

  // Tap-to-move: tap on a canvas quadrant to move that direction
  let _tapStartX = 0;
  let _tapStartY = 0;

  _addListener(_canvasEl, 'touchstart', (e) => {
    const touch = e.touches[0];
    _tapStartX = touch.clientX;
    _tapStartY = touch.clientY;
  }, { passive: false });

  _addListener(_canvasEl, 'touchend', (e) => {
    // Only treat as tap if drag didn't activate
    if (_dragActive) return;

    const touch = e.changedTouches[0];
    const dx = touch.clientX - _tapStartX;
    const dy = touch.clientY - _tapStartY;

    // If finger moved less than 10px, treat as tap
    if (Math.abs(dx) < 10 && Math.abs(dy) < 10) {
      _handleTapToMove(touch.clientX, touch.clientY);
    }
  }, { passive: false });
}

/**
 * Determine which direction to move based on where the user tapped
 * relative to the canvas center.
 */
function _handleTapToMove(clientX, clientY) {
  if (!_canvasEl || !_onMove) return;

  const rect = _canvasEl.getBoundingClientRect();
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;

  const dx = clientX - cx;
  const dy = clientY - cy;

  let mx = 0, my = 0;
  if (Math.abs(dx) > Math.abs(dy)) {
    mx = dx > 0 ? 1 : -1;
  } else {
    my = dy > 0 ? 1 : -1;
  }

  if (mx !== 0 || my !== 0) {
    _onMove({ x: mx, y: my });
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function _addListener(target, event, handler, opts) {
  target.addEventListener(event, handler, opts);
  _boundHandlers.push({ target, event, handler, opts });
}
