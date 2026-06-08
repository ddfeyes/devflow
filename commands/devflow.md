---
description: Take an epic from intent to SHIPPED IN PRODUCTION, fully autonomously. One orchestrator drives two engines — a dynamic Workflow for the stateless halves (recon scouts, blind adversarial verify panel) and Agent Teams / team-orchestrator .coord for the stateful middle (implement·test·integrate) — then closes the loop: the verify panel's unanimous PASS replaces the human reviewer, the orchestrator merges on green CI, and a Deployer ships behind a live health gate with automatic rollback. Two safeguards always hold: health-gated deploy + auto-rollback, and an irreversible-ops tripwire. Escape hatch --pr stops at a ready PR.
argument-hint: [--supervised | --pr] <repo> "<epic intent>" [--resume <runId>]
allowed-tools: Workflow, Read, Bash(git:*), Bash(gh:*), Agent, Skill, mcp__codebase-memory-mcp__search_graph, mcp__codebase-memory-mcp__get_architecture, mcp__codebase-memory-mcp__trace_call_path
---

# /devflow — Autonomous Developer Workflow (v3, closed-loop)

You are the **orchestrator**. Take the epic in `$ARGUMENTS` to **production** by sequencing two engines (see `DEVFLOW.md §0`). You do NOT implement the epic yourself, and you do NOT run implement/test/integrate inside a Workflow. The default closes the loop (review→merge→deploy); the human is out of the loop, so the **machine gates must carry the decisions** — never weaken them.

## 1. Read the playbook
Read `DEVFLOW.md` (repo root, else `~/.claude/DEVFLOW.md`) end-to-end FIRST — it owns the roles, substrate split, gates, the autonomy dial, the two safeguards, and the `.coord` layout. If absent, ABORT and tell the user to create it.

## 2. Parse the invocation (don't pre-parse the epic text)
- `--supervised` → insert one plan-approval checkpoint after the DAG; otherwise no human touch.
- `--pr` → stop at a ready PR (escape hatch; skip merge + deploy).
- `--resume <runId>` → resume; skip the clean-tree check.
- Default (no flag) → **closed loop to production.**
- Everything else = `<repo>` + `"<epic intent>"`, forwarded verbatim.

## 3. Preconditions (machine-checkable, fail fast)
On any failure STOP and report the exact failing check — never "fix" by committing/stashing the user's work.
- **Git repo:** `git rev-parse --is-inside-work-tree` true.
- **Clean tree:** `git status --porcelain` empty (skip on `--resume`). Dirty → ABORT.
- **Remote:** `git remote get-url origin` succeeds. None → ABORT.
- **gh ready:** `gh auth status` succeeds (needed to open AND merge the PR).

## 4. Ensure context graphs exist (build if missing)
- **graphify:** `graphify-out/GRAPH_REPORT.md` absent → Skill graphify (build); stale vs HEAD → graphify `update` (AST-only).
- **codebase-memory:** probe `get_architecture`; empty → build/refresh per the **codebase-memory-reference** Skill.
- **codebase-search** best-effort; absence does not block.
Scoped Skill/MCP reads only — never shell out to a graphify/memory CLI.

## 5. Run the pipeline

**(a) recon — dynamic Workflow.** Invoke **Workflow** with `scriptPath: "/home/hui20metrov/.claude/workflows/devflow.js"`, `args: { mode: "recon", runId, epic, tasks }`. Gate: every pack `ok` with real files; any `empty` → ABORT.

**(b) plan — Planner agent.** Spawn a Planner (**writing-plans** Skill): acyclic DAG into `.coord/epics/<E>/` — per-task `T-nnn.md` (intent, `owned_paths`, machine-checkable acceptance, `riskZone`, and `web:true` for browser-verifiable targets), waves with **pairwise-disjoint `owned_paths`** (serialize shared `go.mod`/types/schema/router/migration index into their own wave — never overlap). Record packet count in `manifest.json`.
- `--supervised` → surface the DAG + risk flags, STOP for human OK. Otherwise proceed. Irreversible-ops packets (§7) checkpoint regardless.

**(c) implement · test · integrate — Agent Teams.** Hand the planned `.coord` epic to the **team-orchestrator** Skill (Opus-direct per `create-team-A/-O/-AO`; AO lane for risk zones to keep writer/verify lanes independent). The team spawns one ephemeral implementer per ready packet (worktree-isolated, TDD, **LSP** edits, **context7** live API docs), kills each via `shutdown_request` after handoff, runs the tester loop, cherry-picks locally-green commits onto the epic branch. Launch teams ONLY via `TeamCreate` + `Agent` with `team_name`; never local, never `codex exec`. Security auditor is always-on for money-path/auth/migration zones.

**(d) verify = merge gate — dynamic Workflow.** Collect each integrated task's `{id, intent, acceptance, branch, sha, riskZone, web}` from `.coord` handoffs, then invoke **Workflow** with `args: { mode: "verify", runId, tasks }`. The blind panel (≥2 verifiers +1 for risk, completeness critic, +chrome-devtools runtime for `web:true`) must return `pass:true` **unanimously**. This PASS *replaces the human reviewer* — do not soften it. FAIL → bounded repair through the team (max 3), then ABORT-to-FLAGGED.

**(e) merge — Releaser.** On unanimous PASS: open the PR (body auto-rendered from packets + verify-reports), wait for **required green CI**, then `gh pr merge` (branch protection on). `--pr` → STOP here, report the ready PR.

**(f) deploy — Deployer agent, health-gated (Safeguard A).** Spawn a Deployer (Agent/team with this repo's deploy creds):
  1. Confirm the repo exposes a **machine-readable health/SLO signal + rollback hook** (read the repo to discover its deploy mechanism — do not assume). **Absent → STOP at merge for this repo, flag it; deploy stays manual until a health gate exists.**
  2. Deploy via the repo's own mechanism (canary/staged where available).
  3. Poll **live** health — a real tool call against the running system, **never a guessed number** (CLAUDE.md hard rule).
  4. Within SLO → promote. Breach → **auto-rollback**, halt the pipeline, alert. Killswitch stays armed throughout.
  - **Rollout maturity:** trading-go deploy is gated until a rollback **drill** has been observed firing; prove the closed loop on tax-workbench / mm-dashboard first.

**(g) postship.** reconcile `count(packets)==count(outcomes)`, `graphify update .`, append verified durable facts to `reference_*.md` + `MEMORY.md`, render `.coord/runs/<runId>/REPORT.md`. Run detached; resume idempotently from the journaled `runId`.

## 6. Blast radius (closing the loop expands access)
Deploy means the Deployer holds ssh/docker/registry creds for the target servers — beyond the git/gh the rest of the pipeline uses. Scope per-repo; never read or echo plaintext secrets (§7).

## 7. Irreversible-ops tripwire (Safeguard B — always halts the lane, write BLOCKED.md, require a human)
Not "you reviewing code" — "automation must not do the unrecoverable": drop/delete data; prod-destructive migration; rotate or read plaintext prod creds; **disable the killswitch**; **enable any non-gateio exchange** (trading stays gateio-only); force-push / history rewrite / branch delete. Everything else flows to prod with no human.
