// Signal Rush Widget Bridge for Hermes Agent
// This script runs the embedded widget and accepts JSON commands via stdin
// Outputs ANSI frames to stdout, JSON responses to stderr

const path = require('path');

let widget = null;
let isRunning = false;

// Resolve signal-rush-project path - prioritize plugin's own node_modules
function getSignalRushProjectPath() {
    // 1. Check env var (allows override)
    if (process.env.SIGNAL_RUSH_PATH) {
        return process.env.SIGNAL_RUSH_PATH;
    }
    // 2. Check plugin's own node_modules (installed copy)
    const pluginDir = path.dirname(__filename);
    const localCandidate = path.join(pluginDir, 'node_modules', 'signal-rush-project');
    if (require('fs').existsSync(localCandidate)) {
        return path.resolve(localCandidate);
    }
    // 3. Try relative to plugin dir (legacy: /home/hive/.hermes/signal-rush)
    const relCandidate = path.join(pluginDir, '..', '..', 'signal-rush');
    if (require('fs').existsSync(relCandidate)) {
        return path.resolve(relCandidate);
    }
    // 4. Fallback to standard install location
    return path.join(pluginDir, '..', '..', 'signal-rush');
}

// Add signal-rush-project to require path
const signalRushPath = getSignalRushProjectPath();
const nodeModulesPath = path.join(signalRushPath, 'node_modules');
if (require('fs').existsSync(nodeModulesPath)) {
    module.paths.unshift(nodeModulesPath);
}

// Now require after path setup - use direct relative require for source repo
const { start, _resetForTests } = require(path.join(signalRushPath, 'src', 'embedded.js'));

function sendResponse(response) {
    // Write JSON response to stderr (for Python to read)
    // stdout is reserved for ANSI frame rendering
    process.stderr.write(JSON.stringify(response) + '\n');
}

function handleCommand(cmd) {
    if (!widget) {
        sendResponse({ success: false, error: 'Widget not initialized' });
        return;
    }

    try {
        switch (cmd.action) {
            case 'show':
                widget.show();
                sendResponse({ success: true, action: 'show' });
                break;
            case 'hide':
                widget.hide();
                sendResponse({ success: true, action: 'hide' });
                break;
            case 'focus':
                widget.focus(cmd.on !== false);
                sendResponse({ success: true, action: 'focus', on: cmd.on !== false });
                break;
            case 'input':
                // Non-TTY input adapter: host sends a string command
                // (e.g. from a Telegram inline keyboard callback query).
                // The widget translates it into engine input shape.
                if (typeof cmd.direction !== 'string' && typeof cmd.command !== 'string') {
                    sendResponse({ success: false, error: 'input action requires direction or command' });
                    break;
                }
                const direction = cmd.direction || cmd.command;
                const accepted = widget.input(direction);
                sendResponse({ success: accepted, action: 'input', direction, accepted });
                break;
            case 'stop':
                widget.stop();
                widget = null;
                isRunning = false;
                sendResponse({ success: true, action: 'stop' });
                break;
            case 'pause':
                widget.pause();
                sendResponse({ success: true, action: 'pause' });
                break;
            case 'resume':
                widget.resume();
                sendResponse({ success: true, action: 'resume' });
                break;
            case 'setMode':
                const result = widget.setMode(cmd.mode);
                sendResponse({ success: result, action: 'setMode', mode: cmd.mode });
                break;
            case 'getStats':
                const stats = widget.getStats();
                sendResponse({ success: true, action: 'getStats', stats });
                break;
            case 'getPlayerId':
                const playerId = widget.getPlayerId();
                sendResponse({ success: true, action: 'getPlayerId', playerId });
                break;
            case 'setPlayerId':
                // Host injects a playerId (e.g. from Hermes session identity).
                // Overrides the lazy-loaded ~/.signal-rush/player.json default.
                if (typeof cmd.playerId !== 'string') {
                    sendResponse({ success: false, error: 'setPlayerId requires playerId string' });
                    break;
                }
                const setResult = widget.setPlayerId(cmd.playerId);
                sendResponse({ success: setResult, action: 'setPlayerId', playerId: cmd.playerId });
                break;
            default:
                sendResponse({ success: false, error: `Unknown action: ${cmd.action}` });
        }
    } catch (err) {
        sendResponse({ success: false, error: err.message });
    }
}

function initWidget() {
    if (isRunning) return;

    try {
        // Start the widget with configuration suitable for Hermes TUI
        // rows: 8 (compact), columns: 80 (will adapt), mode: 'aiHunt', autoStep: true
        widget = start({
            rows: 8,
            columns: 80,
            mode: 'aiHunt',
            autoStep: true,
            presentation: 'idle',  // Start in idle mode (shows title + mode chips)
            fpsCap: 15,
        });
        isRunning = true;
        sendResponse({ success: true, action: 'init' });
    } catch (err) {
        sendResponse({ success: false, error: err.message });
        process.exit(1);
    }
}

// Handle stdin commands
process.stdin.on('data', (data) => {
    const lines = data.toString().trim().split('\n');
    for (const line of lines) {
        if (!line.trim()) continue;
        try {
            const cmd = JSON.parse(line);
            handleCommand(cmd);
        } catch (err) {
            sendResponse({ success: false, error: `Invalid JSON: ${err.message}` });
        }
    }
});

// Handle process signals for cleanup
process.on('SIGINT', () => {
    if (widget) {
        widget.stop();
    }
    process.exit(0);
});

process.on('SIGTERM', () => {
    if (widget) {
        widget.stop();
    }
    process.exit(0);
});

process.on('exit', () => {
    if (widget) {
        widget.stop();
    }
});

// Handle stdin close (Python process ended)
process.stdin.on('close', () => {
    if (widget) {
        widget.stop();
    }
    process.exit(0);
});

// Initialize widget on startup
initWidget();

// Send ready signal
sendResponse({ success: true, event: 'ready' });

// Keep process alive
setInterval(() => {}, 1000);
