"""
Signal Rush Hermes Plugin
=========================

Embeds the Signal Rush PACKET HOP widget into the Hermes Agent CLI/Gateway.
Shows the widget during agent downtime (thinking, rate-limited, idle),
hides it during active streaming.

The widget runs as a separate Node.js subprocess to avoid interfering with
Hermes' terminal I/O. It uses the Signal Rush embedded API.
"""

from __future__ import annotations

import json
import logging
import os
import subprocess
import sys
import threading
from pathlib import Path
from typing import Any, Dict, Optional

logger = logging.getLogger(__name__)

# Path to the Signal Rush source (can be overridden via config)
# Use the canonical signal-rush repo at /home/hive/signal-rush
DEFAULT_SIGNAL_RUSH_PATH = Path("/home/hive/signal-rush")

# Hook names we care about
HOOK_SESSION_START = "on_session_start"
HOOK_SESSION_FINALIZE = "on_session_finalize"
HOOK_PRE_LLM = "pre_llm_call"
HOOK_POST_LLM = "post_llm_call"
HOOK_API_ERROR = "api_request_error"
HOOK_PRE_GATEWAY = "pre_gateway_dispatch"
HOOK_PRE_API_REQUEST = "pre_api_request"
HOOK_POST_API_REQUEST = "post_api_request"

# Global widget manager
_widget_manager: Optional["SignalRushWidgetManager"] = None
_manager_lock = threading.Lock()

# Cached signal rush path (set during plugin registration)
_signal_rush_path: Path = DEFAULT_SIGNAL_RUSH_PATH

# TTY file handle — opened once, shared by all widget output
_tty: Optional[Any] = None


def _get_tty():
    """Open /dev/tty for writing widget frames to the terminal.

    Hermes captures sys.stdout, so writing widget ANSI frames to
    sys.stdout would buffer them and they'd never reach the screen.
    /dev/tty is the controlling terminal when Hermes runs in a TTY.
    Falls back to sys.stdout when /dev/tty is unavailable (e.g. CI).
    """
    global _tty
    if _tty is None:
        try:
            _tty = open("/dev/tty", "w", buffering=1)
            logger.debug("Signal Rush: opened /dev/tty for widget output")
        except (OSError, IOError):
            logger.debug("Signal Rush: /dev/tty unavailable, falling back to sys.stdout")
            _tty = sys.stdout
    return _tty


class SignalRushWidgetManager:
    """
    Manages the Signal Rush widget subprocess.

    The widget runs as a Node.js process that:
    - Renders to stdout (ANSI frames for the widget band)
    - Accepts JSON commands via stdin
    - Sends JSON responses via stderr
    """

    def __init__(self, signal_rush_path: Path = DEFAULT_SIGNAL_RUSH_PATH):
        self.signal_rush_path = signal_rush_path
        self.widget_process: Optional[subprocess.Popen] = None
        self._running = False
        self._lock = threading.Lock()
        self._ready_event = threading.Event()
        self._stderr_thread: Optional[threading.Thread] = None
        self._stdout_thread: Optional[threading.Thread] = None

    def _get_bridge_path(self) -> Path:
        """Get the widget bridge script path."""
        plugin_dir = Path(__file__).parent
        bridge = plugin_dir / "widget_bridge.js"
        if bridge.exists():
            return bridge
        # Fallback to embedded CLI
        return self.signal_rush_path / "src" / "cli" / "embedded.js"

    def start(self) -> bool:
        """Start the widget subprocess."""
        with self._lock:
            if self._running and self.widget_process and self.widget_process.poll() is None:
                logger.debug("Widget already running")
                return True

            bridge_path = self._get_bridge_path()
            if not bridge_path.exists():
                logger.error(f"Widget bridge not found: {bridge_path}")
                return False

            try:
                env = os.environ.copy()
                # Make sure Signal Rush modules are importable
                env["SIGNAL_RUSH_PATH"] = str(self.signal_rush_path)
                node_modules = self.signal_rush_path / "node_modules"
                if node_modules.exists():
                    env["NODE_PATH"] = str(node_modules)

                tty = _get_tty()
                tty.write("[SIGNAL RUSH DEBUG] Starting widget subprocess...\n")
                tty.flush()

                self.widget_process = subprocess.Popen(
                    ["node", str(bridge_path)],
                    stdin=subprocess.PIPE,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    text=True,
                    bufsize=1,  # Line buffered
                    env=env,
                    cwd=str(self.signal_rush_path),
                )

                self._running = True
                self._ready_event.clear()

                # Start background threads
                self._stderr_thread = threading.Thread(
                    target=self._read_stderr, daemon=True
                )
                self._stderr_thread.start()

                self._stdout_thread = threading.Thread(
                    target=self._read_stdout, daemon=True
                )
                self._stdout_thread.start()

                # Wait for ready signal
                if not self._ready_event.wait(timeout=5):
                    tty.write("[SIGNAL RUSH DEBUG] Widget did not signal ready in time\n")
                    tty.flush()
                    logger.warning("Widget did not signal ready in time")
                    self.stop()
                    return False

                tty.write("[SIGNAL RUSH DEBUG] Widget started and ready\n")
                tty.flush()
                logger.info("Signal Rush widget started")
                return True

            except Exception as e:
                logger.error(f"Failed to start widget: {e}")
                tty = _get_tty()
                tty.write(f"[SIGNAL RUSH DEBUG] Failed to start widget: {e}\n")
                tty.flush()
                self._running = False
                return False

    def _read_stderr(self):
        """Read JSON responses from widget stderr."""
        if not self.widget_process or not self.widget_process.stderr:
            return

        for line in self.widget_process.stderr:
            line = line.strip()
            if not line:
                continue
            try:
                response = json.loads(line)
                if response.get("event") == "ready":
                    self._ready_event.set()
            except json.JSONDecodeError:
                logger.debug(f"Widget stderr (non-JSON): {line}")
            except Exception as e:
                logger.warning(f"Error processing widget response: {e}")

    def _read_stdout(self):
        """Pass widget stdout (ANSI frames) through to the terminal.

        Writes to /dev/tty (the controlling terminal) because Hermes
        captures sys.stdout. Falls back to sys.stdout if /dev/tty is
        not available.
        """
        if not self.widget_process or not self.widget_process.stdout:
            return

        tty = _get_tty()
        tty.write("[SIGNAL RUSH DEBUG] _read_stdout thread started\n")
        tty.flush()
        
        try:
            frame_count = 0
            for chunk in iter(lambda: self.widget_process.stdout.read(4096), ""):
                if not chunk:
                    break
                frame_count += 1
                try:
                    tty.write(chunk)
                    tty.flush()
                    # Log first 100 chars of each frame for debugging
                    if frame_count <= 3:
                        preview = repr(chunk[:200])
                        tty.write(f"[SIGNAL RUSH DEBUG] Frame {frame_count}: {preview}\n")
                        tty.flush()
                except (OSError, IOError) as e:
                    tty.write(f"[SIGNAL RUSH DEBUG] stdout write failed: {e}\n")
                    tty.flush()
                    logger.warning(f"Widget stdout write failed: {e}")
                    break
        finally:
            tty.write(f"[SIGNAL RUSH DEBUG] _read_stdout thread ended (frames: {frame_count})\n")
            tty.flush()

    def _send_command(self, action: str, **kwargs) -> bool:
        """Send a command to the widget process."""
        if not self._running or not self.widget_process or self.widget_process.poll() is not None:
            tty = _get_tty()
            tty.write(f"[SIGNAL RUSH DEBUG] _send_command '{action}': widget process not running\n")
            tty.flush()
            logger.warning("Widget process not running")
            return False

        if not self.widget_process.stdin:
            tty = _get_tty()
            tty.write(f"[SIGNAL RUSH DEBUG] _send_command '{action}': widget stdin not available\n")
            tty.flush()
            logger.warning("Widget stdin not available")
            return False

        try:
            cmd = {"action": action, **kwargs}
            cmd_str = json.dumps(cmd) + "\n"
            tty = _get_tty()
            tty.write(f"[SIGNAL RUSH DEBUG] Sending command: {cmd_str.strip()}\n")
            tty.flush()

            self.widget_process.stdin.write(cmd_str)
            self.widget_process.stdin.flush()
            return True
        except Exception as e:
            logger.error(f"Failed to send command {action}: {e}")
            tty = _get_tty()
            tty.write(f"[SIGNAL RUSH DEBUG] Failed to send command {action}: {e}\n")
            tty.flush()
            return False

    def show(self) -> bool:
        """Show the idle widget (title + mode chips)."""
        return self._send_command("show")

    def hide(self) -> bool:
        """Hide the widget (blank line)."""
        return self._send_command("hide")

    def focus(self, on: bool = True) -> bool:
        """Expand to PLAY mode (live PACKET HOP) or return to idle."""
        return self._send_command("focus", on=on)

    def stop(self) -> bool:
        """Stop the widget and clean up."""
        with self._lock:
            if not self._running:
                return True

            self._running = False
            self._send_command("stop")

            if self.widget_process:
                try:
                    self.widget_process.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    self.widget_process.terminate()
                    try:
                        self.widget_process.wait(timeout=1)
                    except subprocess.TimeoutExpired:
                        self.widget_process.kill()
                self.widget_process = None

            # Close TTY handle if we opened it
            global _tty
            if _tty is not None and _tty is not sys.stdout:
                try:
                    _tty.close()
                except Exception:
                    pass
            _tty = None

            return True

    def set_mode(self, mode: str) -> bool:
        """Set the game mode (aiHunt or frogger)."""
        return self._send_command("setMode", mode=mode)

    def is_running(self) -> bool:
        """Check if widget process is alive."""
        return self._running and self.widget_process and self.widget_process.poll() is None


def get_widget_manager() -> SignalRushWidgetManager:
    """Get or create the global widget manager."""
    global _widget_manager
    with _manager_lock:
        if _widget_manager is None:
            _widget_manager = SignalRushWidgetManager(_signal_rush_path)
        return _widget_manager


def ensure_widget_started() -> bool:
    """Ensure widget is started (for lazy initialization on continued sessions)."""
    manager = get_widget_manager()
    if not manager.is_running():
        if manager.start():
            manager.show()
            logger.info("Signal Rush: widget lazily started (session resume)")
            return True
        else:
            logger.error("Signal Rush: failed to start widget")
    return False


# =============================================================================
# Hook Handlers
# =============================================================================

def on_session_start(**kwargs) -> None:
    """Initialize and show the widget when Hermes session starts."""
    logger.info("Signal Rush: session started, starting widget")
    try:
        # Debug: write directly to tty
        tty = _get_tty()
        tty.write("\n[SIGNAL RUSH DEBUG] on_session_start fired\n")
        tty.flush()
        
        manager = get_widget_manager()
        if manager.start():
            manager.show()
            tty.write("[SIGNAL RUSH DEBUG] widget shown (idle)\n")
            tty.flush()
            logger.info("Signal Rush: widget shown (idle)")
        else:
            tty.write("[SIGNAL RUSH DEBUG] failed to start widget\n")
            tty.flush()
            logger.error("Signal Rush: failed to start widget")
    except Exception as e:
        logger.error(f"Signal Rush: error in on_session_start: {e}")
    
    # --- Identity wiring: ensure player exists in economy DB ---
    try:
        _wire_player_identity()
    except Exception as e:
        logger.warning(f"Signal Rush: identity wiring failed (non-fatal): {e}")


def _wire_player_identity() -> None:
    """Ensure the current playerId exists in the economy DB and is wired into the widget.

    Reads playerId from ~/.signal-rush/player.json, calls POST /players/ensure
    to create the player if missing, then sends setPlayerId to the bridge.
    This is fire-and-forget — failure is non-fatal (widget still works with local ID).
    """
    import urllib.request

    # 1. Read playerId from local persistence
    player_file = Path.home() / ".signal-rush" / "player.json"
    if not player_file.exists():
        logger.debug("Signal Rush: no player.json, skipping identity wiring")
        return

    try:
        with open(player_file) as f:
            local = json.load(f)
        player_id = local.get("player_id")
    except Exception as e:
        logger.debug(f"Signal Rush: could not read player.json: {e}")
        return

    if not player_id:
        logger.debug("Signal Rush: player_id missing from player.json")
        return

    # 2. Call economy service to ensure player exists
    api_key = os.environ.get("ECONOMY_API_KEY", "")
    api_url = os.environ.get("ECONOMY_API_URL", "http://localhost:8720").rstrip("/")

    if not api_key:
        logger.debug("Signal Rush: ECONOMY_API_KEY not set, skipping /players/ensure")
        # Still wire the playerId into the bridge (local-only mode)
        _send_set_player_id(player_id)
        return

    try:
        body = json.dumps({"player_id": player_id}).encode("utf-8")
        req = urllib.request.Request(
            f"{api_url}/players/ensure",
            data=body,
            method="POST",
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {api_key}",
            },
        )
        with urllib.request.urlopen(req, timeout=5) as resp:
            result = json.loads(resp.read())
        if result.get("ok"):
            created = result.get("created", False)
            logger.info(f"Signal Rush: player ensured in economy (created={created})")
        else:
            logger.warning(f"Signal Rush: /players/ensure returned error: {result.get('error')}")
    except Exception as e:
        logger.warning(f"Signal Rush: /players/ensure call failed: {e}")

    # 3. Wire playerId into the widget bridge
    _send_set_player_id(player_id)


def _send_set_player_id(player_id: str) -> bool:
    """Send setPlayerId command to the widget bridge process."""
    manager = get_widget_manager()
    if not manager.is_running():
        return False
    return manager._send_command("setPlayerId", playerId=player_id)


def on_session_finalize(**kwargs) -> None:
    """Stop and cleanup widget when Hermes session ends."""
    global _widget_manager
    logger.info("Signal Rush: session finalizing, stopping widget")
    try:
        tty = _get_tty()
        tty.write("\n[SIGNAL RUSH DEBUG] on_session_finalize fired\n")
        tty.flush()
        
        with _manager_lock:
            if _widget_manager:
                _widget_manager.stop()
                _widget_manager = None
                tty.write("[SIGNAL RUSH DEBUG] widget stopped\n")
                tty.flush()
    except Exception as e:
        logger.error(f"Signal Rush: error in on_session_finalize: {e}")


def pre_llm_call(**kwargs) -> None:
    """
    Called BEFORE the LLM is invoked.
    User just sent a prompt - agent is about to start thinking/streaming.
    Hide the widget so it doesn't interfere with the agent's output.
    """
    try:
        tty = _get_tty()
        tty.write("\n[SIGNAL RUSH DEBUG] pre_llm_call fired\n")
        # DEBUG: Inspect kwargs for model/usage info
        tty.write(f"[SIGNAL RUSH DEBUG] kwargs keys: {list(kwargs.keys())}\n")
        for k, v in kwargs.items():
            tty.write(f"[SIGNAL RUSH DEBUG] kwargs[{k}] = {v}\n")
        tty.flush()
        
        # Lazy-start widget for continued sessions where on_session_start didn't fire
        ensure_widget_started()
        
        manager = get_widget_manager()
        if manager.is_running():
            manager.hide()
            tty.write("[SIGNAL RUSH DEBUG] widget hidden (pre-LLM)\n")
            tty.flush()
            logger.debug("Signal Rush: widget hidden (pre-LLM)")
        else:
            tty.write("[SIGNAL RUSH DEBUG] pre_llm_call: widget not running\n")
            tty.flush()
    except Exception as e:
        logger.warning(f"Signal Rush: error in pre_llm_call: {e}")


def post_llm_call(ctx: Any, response: str = "", **kwargs) -> None:
    """
    Called AFTER the LLM completes.
    Agent finished responding - if it's idle or rate-limited, show the widget.
    """
    try:
        tty = _get_tty()
        tty.write("\n[SIGNAL RUSH DEBUG] post_llm_call fired\n")
        # DEBUG: Inspect ctx for usage data
        tty.write(f"[SIGNAL RUSH DEBUG] ctx type: {type(ctx)}\n")
        tty.write(f"[SIGNAL RUSH DEBUG] ctx dir: {[x for x in dir(ctx) if not x.startswith('_')]}\n")
        if hasattr(ctx, '__dict__'):
            tty.write(f"[SIGNAL RUSH DEBUG] ctx.__dict__: {ctx.__dict__}\n")
        # Check common usage attributes
        for attr in ['usage', 'token_usage', 'tokens', 'prompt_tokens', 'completion_tokens', 'total_tokens', 'model', 'provider']:
            if hasattr(ctx, attr):
                tty.write(f"[SIGNAL RUSH DEBUG] ctx.{attr} = {getattr(ctx, attr)}\n")
        tty.write(f"[SIGNAL RUSH DEBUG] kwargs keys: {list(kwargs.keys())}\n")
        for k, v in kwargs.items():
            tty.write(f"[SIGNAL RUSH DEBUG] kwargs[{k}] = {v}\n")
        tty.flush()
        
        manager = get_widget_manager(ctx)
        if not manager.is_running():
            tty.write("[SIGNAL RUSH DEBUG] post_llm_call: widget not running\n")
            tty.flush()
            return

        # Check if response indicates rate limit
        is_rate_limited = _is_rate_limited(response)

        if is_rate_limited:
            # Rate limited - expand to PLAY mode with PACKET HOP
            manager.focus(True)
            tty.write("[SIGNAL RUSH DEBUG] rate limited, widget expanded to PLAY\n")
            tty.flush()
            logger.info("Signal Rush: rate limited, widget expanded to PLAY")
        else:
            # Normal completion - show idle widget
            tty.write("[SIGNAL RUSH DEBUG] Calling manager.show()\n")
            tty.flush()
            manager.show()
            tty.write("[SIGNAL RUSH DEBUG] manager.show() returned\n")
            tty.flush()
            logger.debug("Signal Rush: widget shown (idle after response)")
    except Exception as e:
        logger.warning(f"Signal Rush: error in post_llm_call: {e}")


def api_request_error(error: Exception = None, **kwargs) -> None:
    """
    Called when an API request fails.
    Specifically watch for HTTP 429 (rate limit).
    """
    try:
        manager = get_widget_manager()
        if not manager.is_running():
            return
        
        if _is_rate_limit_error(error):
            manager.focus(True)
            logger.info("Signal Rush: API rate limit error, widget expanded to PLAY")
        else:
            # Other errors - show idle
            manager.show()
    except Exception as e:
        logger.warning(f"Signal Rush: error in api_request_error: {e}")


def pre_gateway_dispatch(event: Any = None, **kwargs) -> None:
    """
    Called for gateway messages (Telegram, Discord, etc.) before dispatch.
    Manage widget state based on incoming message type.
    """
    try:
        manager = get_widget_manager()
        if not manager.is_running():
            return
        
        # For user messages, hide widget (agent will respond)
        if event and hasattr(event, "text") and event.text:
            manager.hide()
    except Exception as e:
        logger.warning(f"Signal Rush: error in pre_gateway_dispatch: {e}")


def _is_rate_limited(response: str) -> bool:
    """Check if response indicates rate limiting."""
    if not response:
        return False
    response_lower = response.lower()
    return any(phrase in response_lower for phrase in [
        "rate limit",
        "429",
        "too many requests",
        "backing off",
        "quota exceeded",
    ])


def _is_rate_limit_error(error: Optional[Exception]) -> bool:
    """Check if error is a rate limit (HTTP 429)."""
    if not error:
        return False
    error_str = str(error).lower()
    return any(code in error_str for code in ["429", "rate limit", "too many requests"])


# =============================================================================
# Debug Hooks for Token Usage Verification (Phase 0)
# =============================================================================

def on_pre_api_request(**kwargs) -> None:
    """Debug hook: inspect pre_api_request payload."""
    try:
        tty = _get_tty()
        tty.write("\n[SIGNAL RUSH DEBUG] pre_api_request fired\n")
        for k, v in kwargs.items():
            tty.write(f"[SIGNAL RUSH DEBUG]   {k}: {v}\n")
        tty.flush()
    except Exception as e:
        logger.warning(f"Signal Rush: error in on_pre_api_request: {e}")


def on_post_api_request(**kwargs) -> None:
    """Debug hook: inspect post_api_request payload WITH usage data."""
    try:
        tty = _get_tty()
        tty.write("\n[SIGNAL RUSH DEBUG] post_api_request fired\n")
        for k, v in kwargs.items():
            if k == 'usage' and isinstance(v, dict):
                tty.write(f"[SIGNAL RUSH DEBUG]   {k}: {v}\n")
                # Highlight token fields
                for tok_key in ['prompt_tokens', 'completion_tokens', 'total_tokens', 
                                'cache_read_tokens', 'cache_write_tokens', 'reasoning_tokens']:
                    if tok_key in v:
                        tty.write(f"[SIGNAL RUSH DEBUG]     >>> {tok_key}: {v[tok_key]} <<<\n")
            else:
                tty.write(f"[SIGNAL RUSH DEBUG]   {k}: {v}\n")
        tty.flush()
    except Exception as e:
        logger.warning(f"Signal Rush: error in on_post_api_request: {e}")


# =============================================================================
# Plugin Registration
# =============================================================================

def register(ctx: Any) -> None:
    """
    Register the Signal Rush plugin with Hermes.

    This is called by the plugin system when the plugin is loaded.
    The PluginContext provides register_hook() for hooking into lifecycle events.
    """
    # Debug: write directly to tty
    tty = _get_tty()
    tty.write("\n[SIGNAL RUSH DEBUG] register() called\n")
    tty.flush()

    # Allow config override for signal_rush_path
    global _signal_rush_path
    try:
        # Try to get config from the plugin context
        config = getattr(ctx, "config", {})
        if config and "signal_rush_path" in config:
            _signal_rush_path = Path(config["signal_rush_path"])
            logger.info(f"Signal Rush: using custom path: {_signal_rush_path}")
    except Exception:
        pass  # Use default path

    logger.info("Signal Rush: registering hooks")

    # Register all our hooks
    ctx.register_hook(HOOK_SESSION_START, on_session_start)
    tty.write("[SIGNAL RUSH DEBUG] on_session_start registered\n")
    tty.flush()
    ctx.register_hook(HOOK_SESSION_FINALIZE, on_session_finalize)
    ctx.register_hook(HOOK_PRE_LLM, pre_llm_call)
    ctx.register_hook(HOOK_POST_LLM, post_llm_call)
    ctx.register_hook(HOOK_API_ERROR, api_request_error)
    ctx.register_hook(HOOK_PRE_GATEWAY, pre_gateway_dispatch)
    # NEW: Token usage debug hooks
    ctx.register_hook(HOOK_PRE_API_REQUEST, on_pre_api_request)
    ctx.register_hook(HOOK_POST_API_REQUEST, on_post_api_request)

    tty.write("[SIGNAL RUSH DEBUG] all hooks registered\n")
    tty.flush()
    logger.info("Signal Rush: all hooks registered")