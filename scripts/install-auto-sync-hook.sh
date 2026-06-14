#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "ERROR: run this from inside the Signal Rush git repo" >&2
  exit 1
}
cd "$REPO_ROOT"

HOOK_PATH=".git/hooks/post-commit"
SYNC_SCRIPT="$REPO_ROOT/scripts/safe-sync-github.sh"
LOG_FILE=".git/signal-rush-sync.log"

test -f "$SYNC_SCRIPT" || {
  echo "ERROR: missing $SYNC_SCRIPT" >&2
  exit 1
}
chmod +x "$SYNC_SCRIPT"

if [ -f "$HOOK_PATH" ] && ! grep -q 'Signal Rush auto GitHub sync' "$HOOK_PATH"; then
  BACKUP="$HOOK_PATH.backup.$(date -u +%Y%m%dT%H%M%SZ)"
  cp "$HOOK_PATH" "$BACKUP"
  echo "Existing post-commit hook backed up to $BACKUP"
fi

cat > "$HOOK_PATH" <<'HOOK'
#!/usr/bin/env bash
set -euo pipefail

# Signal Rush auto GitHub sync
# Runs after every local commit. It refuses to push if the working tree is dirty,
# runs the full verification suite, pushes main to GitHub, fetches back, and
# proves local HEAD == origin/main == GitHub refs/heads/main.

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || exit 0
cd "$REPO_ROOT"

# Avoid recursive or nested sync attempts.
if [ "${SIGNAL_RUSH_SYNC_IN_PROGRESS:-0}" = "1" ]; then
  exit 0
fi
export SIGNAL_RUSH_SYNC_IN_PROGRESS=1

# Keep post-commit output concise while preserving full logs.
LOG_FILE=".git/signal-rush-sync.log"
echo "[Signal Rush] post-commit auto-sync starting; full log: $LOG_FILE"

if ./scripts/safe-sync-github.sh; then
  echo "[Signal Rush] post-commit auto-sync complete: GitHub is up to date."
else
  code=$?
  echo "[Signal Rush] post-commit auto-sync FAILED with exit code $code. See $LOG_FILE" >&2
  echo "[Signal Rush] Your commit still exists locally; GitHub may not be up to date until you fix the error and run: npm run sync:github" >&2
  exit $code
fi
HOOK

chmod +x "$HOOK_PATH"

echo "Installed Signal Rush post-commit auto-sync hook at $HOOK_PATH"
echo "Log file: $LOG_FILE"
