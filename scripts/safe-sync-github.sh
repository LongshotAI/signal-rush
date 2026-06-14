#!/usr/bin/env bash
set -euo pipefail

REMOTE="${SIGNAL_RUSH_REMOTE:-origin}"
BRANCH="${SIGNAL_RUSH_BRANCH:-main}"
EXPECTED_REMOTE_URL="https://github.com/LongshotAI/signal-rush.git"
LOG_FILE="${SIGNAL_RUSH_SYNC_LOG:-.git/signal-rush-sync.log}"
RUN_FRESH_CLONE="${SIGNAL_RUSH_FRESH_CLONE:-0}"
ALLOW_DIRTY="${SIGNAL_RUSH_ALLOW_DIRTY:-0}"

mkdir -p "$(dirname "$LOG_FILE")"
exec > >(tee -a "$LOG_FILE") 2>&1

stamp() { date -u '+%Y-%m-%dT%H:%M:%SZ'; }
section() { printf '\n[%s] === %s ===\n' "$(stamp)" "$*"; }
fail() { printf '[%s] ERROR: %s\n' "$(stamp)" "$*"; exit 1; }

section "Signal Rush safe GitHub sync start"

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || fail "not inside a git repository"
cd "$REPO_ROOT"
printf '[%s] repo=%s\n' "$(stamp)" "$REPO_ROOT"

CURRENT_BRANCH="$(git symbolic-ref --quiet --short HEAD 2>/dev/null || true)"
[ "$CURRENT_BRANCH" = "$BRANCH" ] || fail "current branch is '$CURRENT_BRANCH', expected '$BRANCH'"

REMOTE_URL="$(git remote get-url "$REMOTE" 2>/dev/null || true)"
[ -n "$REMOTE_URL" ] || fail "remote '$REMOTE' is missing"
[ "$REMOTE_URL" = "$EXPECTED_REMOTE_URL" ] || fail "remote '$REMOTE' is '$REMOTE_URL', expected '$EXPECTED_REMOTE_URL'"

section "local completeness check"
STATUS="$(git status --porcelain)"
if [ -n "$STATUS" ] && [ "$ALLOW_DIRTY" != "1" ]; then
  printf '%s\n' "$STATUS"
  fail "working tree has uncommitted changes; refusing to push because GitHub would not contain the full local codebase. Commit/stash everything first."
fi
[ -n "$(git rev-parse HEAD 2>/dev/null)" ] || fail "HEAD does not resolve"

section "tracked-file safety scan"
ENV_TRACKED="$(git ls-files | grep -E '(^|/)\.env($|\.)|(^|/)\.openclaw-state/|(^|/)sessions/|(^|/)memory/' || true)"
if [ -n "$ENV_TRACKED" ]; then
  printf '%s\n' "$ENV_TRACKED"
  fail "tracked local state/secret-looking files found"
fi
PREFIX_HITS="$(git grep -I -n -E 'ghp_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|-----BEGIN (RSA |OPENSSH |EC |DSA )?PRIVATE KEY-----' HEAD -- . ':(exclude)docs/**' ':(exclude)README.md' 2>/dev/null || true)"
if [ -n "$PREFIX_HITS" ]; then
  printf '%s\n' "$PREFIX_HITS"
  fail "secret-looking token/key pattern found in tracked source"
fi
printf '[%s] safety scan passed\n' "$(stamp)"

section "test suite"
npm test

section "push to GitHub"
LOCAL_HEAD="$(git rev-parse HEAD)"
printf '[%s] local HEAD before push: %s\n' "$(stamp)" "$LOCAL_HEAD"
git push "$REMOTE" "HEAD:$BRANCH"

section "remote verification"
git fetch "$REMOTE" "$BRANCH"
TRACKING_HEAD="$(git rev-parse "$REMOTE/$BRANCH")"
LS_REMOTE_HEAD="$(git ls-remote "$REMOTE" "refs/heads/$BRANCH" | awk '{print $1}')"
printf '[%s] local HEAD:        %s\n' "$(stamp)" "$LOCAL_HEAD"
printf '[%s] tracking HEAD:     %s\n' "$(stamp)" "$TRACKING_HEAD"
printf '[%s] ls-remote HEAD:    %s\n' "$(stamp)" "$LS_REMOTE_HEAD"
[ "$LOCAL_HEAD" = "$TRACKING_HEAD" ] || fail "origin/$BRANCH does not match local HEAD after push"
[ "$LOCAL_HEAD" = "$LS_REMOTE_HEAD" ] || fail "GitHub remote refs/heads/$BRANCH does not match local HEAD after push"

if [ "$RUN_FRESH_CLONE" = "1" ]; then
  section "fresh clone verification"
  TMP_DIR="$(mktemp -d /tmp/signal-rush-sync-verify.XXXXXX)"
  trap 'rm -rf "$TMP_DIR"' EXIT
  git clone "$REMOTE_URL" "$TMP_DIR/repo"
  cd "$TMP_DIR/repo"
  CLONE_HEAD="$(git rev-parse HEAD)"
  printf '[%s] fresh clone HEAD: %s\n' "$(stamp)" "$CLONE_HEAD"
  [ "$CLONE_HEAD" = "$LOCAL_HEAD" ] || fail "fresh clone HEAD does not match local HEAD"
  npm test
  cd "$REPO_ROOT"
fi

section "Signal Rush safe GitHub sync complete"
printf '[%s] synced %s to %s/%s\n' "$(stamp)" "$LOCAL_HEAD" "$REMOTE" "$BRANCH"
