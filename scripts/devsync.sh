#!/usr/bin/env bash
# devsync — keep one repo's three copies (local ↔ GitHub ↔ server) in sync at a CHECKPOINT.
#
# Why a script and not an edit-hook: pushing must be SCANNED for secrets first (the devflow
# repo is PUBLIC) and must not ship broken intermediate states — so push happens here, at an
# explicit checkpoint (manual /devsync or devflow postship), never on every edit.
#
#   local  → GitHub : fetch, sync local onto origin (ff or rebase), scan, push
#   GitHub → server : ONLY if this repo has a line in ~/.claude/devsync.targets (opt-in, gitignored)
#
# Usage:  devsync.sh [REPO_DIR]        (default: $PWD)
#         devsync.sh --no-push REPO    (pull/scan only)
# Exit:   0 synced • 2 nothing-to-do/skipped • 3 BLOCKED (secret found / diverged / conflict)
set -uo pipefail

NO_PUSH=0
REPO=""
for a in "$@"; do
  case "$a" in
    --no-push) NO_PUSH=1 ;;
    *) REPO="$a" ;;
  esac
done
REPO="${REPO:-$PWD}"

say()  { printf '%s\n' "$*"; }
die3() { printf 'BLOCKED: %s\n' "$*" >&2; exit 3; }

cd "$REPO" 2>/dev/null || die3 "no such dir: $REPO"
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || { say "skip: $REPO is not a git repo"; exit 2; }
REPO="$(git rev-parse --show-toplevel)"; cd "$REPO"
NAME="$(basename "$REPO")"

git remote get-url origin >/dev/null 2>&1 || { say "skip: $NAME has no origin remote"; exit 2; }
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
[ "$BRANCH" = "HEAD" ] && die3 "$NAME is in detached HEAD — refusing to sync"

# Refuse to act mid-operation (rebase/merge/cherry-pick in progress).
GITDIR="$(git rev-parse --git-dir)"
if [ -d "$GITDIR/rebase-merge" ] || [ -d "$GITDIR/rebase-apply" ] || [ -f "$GITDIR/MERGE_HEAD" ] || [ -f "$GITDIR/CHERRY_PICK_HEAD" ]; then
  die3 "$NAME has a rebase/merge/cherry-pick in progress — resolve it first"
fi

say "── devsync: $NAME @ $BRANCH ──"
git fetch --quiet origin || die3 "git fetch failed for $NAME"

# ---- local ← GitHub : bring local current without clobbering work ----
UP="$(git rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null || true)"
if [ -n "$UP" ]; then
  AHEAD="$(git rev-list --count "$UP"..HEAD 2>/dev/null || echo 0)"
  BEHIND="$(git rev-list --count HEAD.."$UP" 2>/dev/null || echo 0)"
  if [ "$BEHIND" -gt 0 ]; then
    if [ "$AHEAD" -eq 0 ]; then
      git merge --ff-only "$UP" >/dev/null 2>&1 || die3 "$NAME: cannot fast-forward (unexpected divergence)"
      say "  pulled $BEHIND commit(s) from origin (fast-forward)"
    else
      # diverged: replay local commits on top of origin; abort cleanly on conflict.
      if git -c rebase.autoStash=true rebase "$UP" >/dev/null 2>&1; then
        say "  rebased $AHEAD local commit(s) onto origin (was behind $BEHIND)"
      else
        git rebase --abort >/dev/null 2>&1 || true
        die3 "$NAME: local and origin diverged with conflicts — resolve by hand"
      fi
    fi
  fi
else
  say "  (no upstream set for $BRANCH)"
fi

# ---- secret scan before any push ----
# The patch that WOULD be pushed = commits reachable from HEAD but on NO origin/* ref. This is
# correct for BOTH the ahead-of-upstream case AND a brand-new branch with no upstream yet, and it
# is empty ONLY when nothing is genuinely outgoing — never merely because a base ref was
# indeterminate. Fail CLOSED: if it can't be computed, refuse to push (don't fall through unscanned).
PATCH=""
if ! PATCH="$(git log HEAD --not --remotes=origin -p --no-color 2>/dev/null)"; then
  [ "$NO_PUSH" -eq 1 ] || die3 "$NAME: cannot compute outgoing diff to scan — refusing to push"
fi

if [ -n "$PATCH" ]; then
  # visibility: PUBLIC remotes get the strict deny list; PRIVATE only the universal-secret list.
  VIS="UNKNOWN"
  if command -v gh >/dev/null 2>&1; then
    SLUG="$(git remote get-url origin | sed -E 's@.*github.com[:/]+@@; s@\.git$@@')"
    VIS="$(gh repo view "$SLUG" --json visibility -q .visibility 2>/dev/null | tr a-z A-Z || echo UNKNOWN)"
  fi
  # Universal high-confidence secrets (block on ANY remote):
  UNIVERSAL='-----BEGIN [A-Z ]*PRIVATE KEY-----|AKIA[0-9A-Z]{16}|ghp_[0-9A-Za-z]{36}|xox[baprs]-[0-9A-Za-z-]{10,}|AIza[0-9A-Za-z_-]{35}'
  HITS="$(printf '%s' "$PATCH" | grep -nEi -e "$UNIVERSAL" | grep -E '^[0-9]+:\+' || true)"
  # Public-only deny list. Builtins are GENERIC/structural only (no secret literals, so this
  # script is itself publishable); site-specific identifiers (server IPs, SSH aliases, emails,
  # home paths) live in the gitignored ~/.claude/devsync.public-deny.txt.
  if [ "$VIS" = "PUBLIC" ] || [ "$VIS" = "UNKNOWN" ]; then
    PUBDENY='[A-Za-z0-9_]*MASTER_KEY[A-Za-z0-9_]*\s*=|\b[0-9a-f]{64}\b'
    DENYFILE="$HOME/.claude/devsync.public-deny.txt"
    if [ -f "$DENYFILE" ]; then
      EXTRA="$(grep -vE '^\s*(#|$)' "$DENYFILE" | paste -sd'|' - 2>/dev/null || true)"
      [ -n "$EXTRA" ] && PUBDENY="$PUBDENY|$EXTRA"
    fi
    PUBHITS="$(printf '%s' "$PATCH" | grep -nEi -e "$PUBDENY" | grep -E '^[0-9]+:\+' || true)"
    HITS="$(printf '%s\n%s' "$HITS" "$PUBHITS" | grep -E '.' || true)"
  fi
  if [ -n "$HITS" ]; then
    say "  secret scan ($VIS remote) found candidate secrets in the outgoing diff:"
    printf '%s\n' "$HITS" | head -n 12 | sed 's/^/    /'
    die3 "$NAME: refusing to push — sanitize the diff above (or add a false-positive note) and re-run"
  fi
  say "  secret scan clean ($VIS remote)"
fi

# ---- local → GitHub ----
if [ "$NO_PUSH" -eq 1 ]; then
  say "  --no-push: skipping push"
else
  AHEAD="$(git rev-list --count "${UP:-HEAD}"..HEAD 2>/dev/null || echo 0)"
  if [ -z "$UP" ]; then
    git push --quiet -u origin "$BRANCH" && say "  pushed (set upstream origin/$BRANCH)" || die3 "$NAME: push failed (set-upstream)"
  elif [ "$AHEAD" -gt 0 ]; then
    git push --quiet origin "$BRANCH" && say "  pushed $AHEAD commit(s) to origin/$BRANCH" || die3 "$NAME: push rejected (protected branch?)"
  else
    say "  origin/$BRANCH already up to date"
  fi
fi

# ---- GitHub → server (opt-in, per-repo, never blind) ----
# Format of ~/.claude/devsync.targets (gitignored, local only), one repo per line:
#   <repo-name> <ssh-host> <remote-path> <deploy-command>
# e.g.  myapp  my-deploy-host  /srv/myapp  "git pull --ff-only && docker compose up -d --build"
TARGETS="$HOME/.claude/devsync.targets"
if [ -f "$TARGETS" ]; then
  LINE="$(grep -E "^\s*${NAME}\s" "$TARGETS" | grep -vE '^\s*#' | head -n1 || true)"
  if [ -n "$LINE" ]; then
    HOST="$(awk '{print $2}' <<<"$LINE")"
    RPATH="$(awk '{print $3}' <<<"$LINE")"
    DCMD="$(cut -d' ' -f4- <<<"$LINE" | sed -E 's/^\s+//')"
    say "  server leg: $HOST:$RPATH"
    if ssh -o BatchMode=yes -o ConnectTimeout=10 "$HOST" "cd '$RPATH' && git pull --ff-only && ${DCMD:-true}"; then
      say "  server synced + deployed"
    else
      die3 "$NAME: server sync/deploy failed on $HOST (left untouched — investigate)"
    fi
  fi
fi

say "✓ $NAME synced"
exit 0
