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
 * Poll the current D-pad direction state.
 * Returns {x: number, y: number} where each component is -1, 0, or 1,
 * or null if no direction is pressed.
 *
 * This is the primary input source for mobile — called every game tick
 * so holding a direction produces continuous movement.
 */
export function getDPadState() {
  let x = 0, y = 0;
  if (_dPadState.up)    y -= 1;
  if (_dPadState.down)  y += 1;
  if (_dPadState.left)  x -= 1;
  if (_dPadState.right) x += 1;
  if (x === 0 && y === 0) return null;
  return { x, y };
}

function _directionToMove(dir) {
  if (dir === 'up') return { x: 0, y: -1 };
  if (dir === 'down') return { x: 0, y: 1 };
  if (dir === 'left') return { x: -1, y: 0 };
  if (dir === 'right') return { x: 1, y: 0 };
  return null;
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
    bottom: '8px',
    left: '50%',
    transform: 'translateX(-50%)',
    zIndex: '1000',
    width: '150px',
    height: '150px',
    opacity: '0.50',
    touchAction: 'none',
    userSelect: 'none',
    WebkitUserSelect: 'none',
    pointerEvents: 'auto',
  });

  // Button layout: cross pattern using CSS
  const btnStyle = {
    position: 'absolute',
    width: '48px',
    height: '48px',
    background: 'rgba(255,255,255,0.07)',
    border: '1px solid rgba(255,255,255,0.10)',
    borderRadius: '12px',
    color: 'rgba(255,255,255,0.55)',
    fontSize: '20px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    touchAction: 'none',
    userSelect: 'none',
    WebkitUserSelect: 'none',
    cursor: 'pointer',
    transition: 'background 0.08s, border-color 0.08s, color 0.08s',
    backdropFilter: 'blur(4px)',
    WebkitBackdropFilter: 'blur(4px)',
  };

  const activeStyle = {
    background: 'rgba(0,255,136,0.20)',
    borderColor: 'rgba(0,255,136,0.40)',
    color: '#00ff88',
  };

  const buttons = [
    { dir: 'up',    label: '↑', top: '0',   left: '50%',  transform: 'translateX(-50%)' },
    { dir: 'down',  label: '↓', bottom: '0', left: '50%',  transform: 'translateX(-50%)' },
    { dir: 'left',  label: '←', top: '50%',  left: '0',    transform: 'translateY(-50%)' },
    { dir: 'right', label: '→', top: '50%',  right: '0',   transform: 'translateY(-50%)' },
  ];

  for (const item of buttons) {
    const btn = document.createElement('button');
    btn.textContent = item.label;
    Object.assign(btn.style, btnStyle);
    btn.style.top = item.top;
    btn.style.bottom = item.bottom;
    btn.style.left = item.left;
    btn.style.right = item.right;
    if (item.transform) btn.style.transform = item.transform;

    // Touch start
    _addListener(btn, 'touchstart', (e) => {
      e.preventDefault();
      _dPadState[item.dir] = true;
      const move = _directionToMove(item.dir);
      if (_onMove && move) _onMove(move);
      Object.assign(btn.style, { ...btnStyle, ...activeStyle });
      if (item.top) btn.style.top = item.top;
      if (item.bottom) btn.style.bottom = item.bottom;
      if (item.left) btn.style.left = item.left;
      if (item.right) btn.style.right = item.right;
      if (item.transform) btn.style.transform = item.transform;
    }, { passive: false });

    // Touch end
    _addListener(btn, 'touchend', (e) => {
      e.preventDefault();
      _dPadState[item.dir] = false;
      Object.assign(btn.style, btnStyle);
      if (item.top) btn.style.top = item.top;
      if (item.bottom) btn.style.bottom = item.bottom;
      if (item.left) btn.style.left = item.left;
      if (item.right) btn.style.right = item.right;
      if (item.transform) btn.style.transform = item.transform;
    }, { passive: false });

    // Touch cancel
    _addListener(btn, 'touchcancel', () => {
      _dPadState[item.dir] = false;
      Object.assign(btn.style, btnStyle);
      if (item.top) btn.style.top = item.top;
      if (item.bottom) btn.style.bottom = item.bottom;
      if (item.left) btn.style.left = item.left;
      if (item.right) btn.style.right = item.right;
      if (item.transform) btn.style.transform = item.transform;
    });

    // Mouse fallback (for testing on desktop)
    _addListener(btn, 'mousedown', () => {
      _dPadState[item.dir] = true;
      const move = _directionToMove(item.dir);
      if (_onMove && move) _onMove(move);
      Object.assign(btn.style, { ...btnStyle, ...activeStyle });
      if (item.top) btn.style.top = item.top;
      if (item.bottom) btn.style.bottom = item.bottom;
      if (item.left) btn.style.left = item.left;
      if (item.right) btn.style.right = item.right;
      if (item.transform) btn.style.transform = item.transform;
    });
    _addListener(btn, 'mouseup', () => {
      _dPadState[item.dir] = false;
      Object.assign(btn.style, btnStyle);
      if (item.top) btn.style.top = item.top;
      if (item.bottom) btn.style.bottom = item.bottom;
      if (item.left) btn.style.left = item.left;
      if (item.right) btn.style.right = item.right;
      if (item.transform) btn.style.transform = item.transform;
    });
    _addListener(btn, 'mouseleave', () => {
      if (_dPadState[item.dir]) {
        _dPadState[item.dir] = false;
        Object.assign(btn.style, btnStyle);
        if (item.top) btn.style.top = item.top;
        if (item.bottom) btn.style.bottom = item.bottom;
        if (item.left) btn.style.left = item.left;
        if (item.right) btn.style.right = item.right;
        if (item.transform) btn.style.transform = item.transform;
      }
    });

    container.appendChild(btn);
  }

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
  // Use Map keyed by touch identifier for multi-touch safety
  const _tapStarts = new Map();

  _addListener(_canvasEl, 'touchstart', (e) => {
    for (let i = 0; i < e.changedTouches.length; i++) {
      const touch = e.changedTouches[i];
      _tapStarts.set(touch.identifier, { x: touch.clientX, y: touch.clientY });
    }
  }, { passive: false });

  _addListener(_canvasEl, 'touchend', (e) => {
    // Only treat as tap if drag didn't activate
    if (_dragActive) return;

    const touch = e.changedTouches[0];
    const start = _tapStarts.get(touch.identifier);
    _tapStarts.delete(touch.identifier);
    if (!start) return;

    const dx = touch.clientX - start.x;
    const dy = touch.clientY - start.y;

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
