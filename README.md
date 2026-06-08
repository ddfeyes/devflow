# devflow

Autonomous developer workflow for Claude Code: take an epic from a one-line intent to **shipped in production**, hands-off — with independent writer/verifier lanes, machine-checkable gates, and a resumable run journal.

`/devflow <repo> "<epic>"` → recon → plan → implement·test·integrate → blind verify → merge → health-gated deploy.

## The one idea: two engines under one orchestrator

The heavy middle (implement/test/integrate) is stateful and git-heavy — that runs on **Agent Teams + `.coord/`** (a proven multi-agent substrate). The stateless halves (parallel recon scouts, an adversarial verify panel) run on Claude Code's **dynamic Workflow** primitive, which is built for deterministic fan-out + schema-gated output. The `/devflow` command is the orchestrator that sequences both.

```
          /devflow  (orchestrator)
              │
 ┌──────┬─────┼───────────┬─────────┬────────┐
 ▼      ▼     ▼           ▼         ▼        ▼
RECON  PLAN  EXECUTE     VERIFY    MERGE    DEPLOY
Workflow agent Agent-Teams Workflow  gh    Deployer
scouts  +dial  .coord     blind     pr     health-gated
context        impl·test· panel     merge  + auto-rollback
packs          integrate  =merge gate
└── stateless ──┘└─ stateful ─┘└ stateless ┘└── orchestrator ──┘
```

## Why review/merge/deploy are autonomous (and still safe)

Removing the human from review/merge/deploy does **not** remove the gate — it **transfers the gate to the machine**:

- **auto-review** → a *blind* adversarial verify panel (≥2 verifiers + completeness critic + browser-runtime checks for web targets). Its unanimous PASS replaces the human reviewer. It can't be talked into green because it runs on a different engine, never sees the writer's reasoning, and re-runs everything from a clean worktree.
- **auto-merge** → `gh pr merge` behind required-green-CI + branch protection. Reversible via revert.
- **auto-deploy** → the only irreversible-in-a-window step, so it gets two safeguards (below).

### Two safeguards
- **A — health-gated deploy + auto-rollback.** A repo only auto-deploys if it exposes a machine-readable health/SLO signal + rollback hook. Deploy is always `deploy → read live health → auto-promote OR auto-rollback`. No health gate → the loop closes at **merge** for that repo.
- **B — irreversible-ops tripwire.** These always halt for a human (drop/delete data, prod-destructive migration, rotate/read prod creds, disable a killswitch, force-push/history-rewrite). Automation must never do the unrecoverable.

## Modern capability bolt-ons
- **context7 MCP** — implementers/verifiers ground API/SDK usage against live docs (kills stale-API hallucination).
- **chrome-devtools MCP** — verify lane drives the real UI for web targets (console, network, lighthouse).
- **LSP** — precise edits instead of grep-and-pray.
- **graphify + codebase-memory + codebase-search** — retrieval-based per-task Context Packs instead of dumping the repo.

## Layout
```
DEVFLOW.md            # the playbook — full source of truth (roles, phases, gates, safeguards)
commands/devflow.md   # the slash command — the orchestrator script
workflows/devflow.js  # the fan-out engine — modes: recon | verify (stateless only)
selftest/gates.test.mjs  # proves the recon/verify gates fail correctly (run: node selftest/gates.test.mjs)
schemas/*.json        # machine-checkable contracts: acceptance, task, handoff, verdict, run_state
.devflow/quality.example.yml  # per-repo required/conditional CI checks + coverage policy
install.sh            # copy the three core files into ~/.claude and fix the hardcoded path
```

## Install
```bash
git clone <this repo> devflow && cd devflow
./install.sh          # copies into $HOME/.claude and rewrites the engine path
```
Or manually: copy `DEVFLOW.md` → `~/.claude/`, `commands/devflow.md` → `~/.claude/commands/`, `workflows/devflow.js` → `~/.claude/workflows/`, then edit the `scriptPath` in the command to match your home.

Requires: Claude Code with the **team-orchestrator** skill, **graphify**, **codebase-memory-mcp**, and (optional but recommended) **context7** + **chrome-devtools** MCP servers.

## Usage
```bash
/devflow <repo> "<epic intent>"               # closed loop to production (default)
/devflow --supervised <repo> "<epic>"         # + one plan-approval checkpoint
/devflow --pr <repo> "<epic>"                 # stop at a ready PR (escape hatch)
/devflow --resume <runId>                      # resume a detached/interrupted run
```
First run should be a low-stakes repo with `--supervised`. Watch a rollback drill fire before trusting auto-deploy on anything that touches money.

Steer mid-run by editing `.coord/runs/<runId>/control.json` (`pause`/`redirect`/`abort`); honored at the next barrier. Results land in `.coord/runs/<runId>/REPORT.md`.

## Known gotchas (from real runs)
- **The Workflow `args` global may not propagate into `devflow.js`** in some harness versions → `mode:recon` sees an empty epic and falls back to a single epic-wide scout. Workaround: inline the run data into a self-contained copy of the script and invoke it via `scriptPath`, rather than relying on the `args` param.
- **The `Plan` agent type is read-only** (no Write/Edit) — it emits packets inline; spawn a writable agent to persist `.coord` packets.

## Hardening status & roadmap
The gates are not just prompt rules — the fan-out engine's two gates are **strict and proven**:
- **recon gate** fails the run unless *every expected scout* returned a pack with real files (a missing/crashed scout no longer false-greens — it's reported in `missing[]`/`empty[]`).
- **verify gate** requires the *full expected vote count* (N correctness + 1 completeness + runtime-if-web), exact lens coverage, every vote `pass:true`, and **non-empty evidence** on each — "unanimous" can't mean "unanimous among the survivors."
- Parallel agents no longer share a journal/report file (per-agent event files, merged by the orchestrator) — no write races.

`selftest/gates.test.mjs` loads the real engine in a `vm` sandbox and asserts all of the above (8 scenarios incl. missing-scout, partial-quorum, empty-evidence, web-runtime, unknown-mode). It exits non-zero on regression — run it after any change to `devflow.js`.

**Done:** P0 gate fixes • selftest • contract schemas (`schemas/`, `.devflow/quality.example.yml`).
**Next (specified, not yet enforced in code):** a dedicated *Wave Integrator* role for semantic cross-task conflicts; a failure taxonomy with per-class repair paths (flake vs env vs integration vs acceptance); wiring `run_state.json` as the canonical source-of-truth with run locks/epochs; a runner that executes `.devflow/quality.yml`. Until then those are contracts/specs, not yet machine-enforced — treat them as the design target, not a guarantee.

## Status
Validated on real end-to-end runs (greenfield builds and brownfield epics shipped to `main`): the blind verify panel has caught real blockers and majors that would otherwise have merged. Auto-deploy to high-stakes targets stays gated until a rollback drill is observed.
