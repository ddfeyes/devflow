---
description: Sync a repo's three copies — local ↔ GitHub ↔ server — at a checkpoint. Fetches, fast-forwards/rebases local onto origin, secret-scans the outgoing diff (strict for PUBLIC remotes), pushes, and — only if the repo has an opt-in line in ~/.claude/devsync.targets — pulls + redeploys on its server. Never pushes unscanned; never blind-ssh-deploys. Run it whenever local/GitHub/server may have drifted, or let devflow postship call it.
argument-hint: [repo-path] [--no-push]
allowed-tools: Bash(bash:*), Bash(git:*), Read
---

# /devsync — keep local ↔ GitHub ↔ server in sync (checkpoint, not per-edit)

Run the sync script on the target repo and report the result plainly. Do **not** re-implement the logic inline — the script is the source of truth and carries the secret-scan gate.

## Do this
1. Target repo = first non-flag arg in `$ARGUMENTS`, else the current repo (`$PWD`). `--no-push` → pull/scan only.
2. Run: `bash ~/.claude/scripts/devsync.sh <repo> [--no-push]`
3. Report exactly what it did (pulled N / pushed N / server synced / already current).

## Exit codes → what to say
- **0** — synced. State the legs that moved (e.g. "pulled 2 from origin, pushed 1, server redeployed").
- **2** — nothing to do / skipped (not a git repo, no origin). Say so; don't treat as failure.
- **3** — **BLOCKED.** The script refused. Surface the exact reason verbatim:
  - secret found in outgoing diff → show the flagged lines; sanitize the diff (or, if a true false-positive, add a note to `~/.claude/devsync.public-deny.txt`), then re-run. **Do NOT** `git push` manually to bypass the scan.
  - diverged-with-conflicts / mid-rebase / detached HEAD → resolve by hand, then re-run.
  - server sync/deploy failed → the server was left untouched; investigate before retrying.

## Notes
- The server leg only runs for repos listed in `~/.claude/devsync.targets` (gitignored, local-only: `<repo-name> <ssh-host> <remote-path> <deploy-cmd>`). No entry → git-only sync. This is deliberate: never blind-ssh-deploy.
- This is the **checkpoint** push path. Pull is safe to automate (SessionStart ff-only); push goes through here or devflow postship so it is always secret-scanned first. Never wire push into the per-edit hook.
