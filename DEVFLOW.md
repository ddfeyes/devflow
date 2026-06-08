# DEVFLOW — Autonomous Developer Workflow (v3, closed-loop)

## 0. Substrate decision (read this first)
devflow runs **two engines under one orchestrator** (the `/devflow` command), each on the work it's good at. v3 closes the loop: the default now goes intent → **shipped in production**, with machine gates replacing the human at review/merge/deploy.

| phase | engine | why this engine |
|---|---|---|
| **recon** | dynamic Workflow — `devflow.js mode:recon` | parallel read-only fan-out + schema gates; stateless |
| **plan** | one Planner agent (+ optional dial gate) | a single DAG; cheap to checkpoint |
| **implement · test · integrate** | **Agent Teams + team-orchestrator `.coord/`** | stateful, iterative, git-heavy — the *proven* substrate (7 epics / 74+ commits / zero regressions) |
| **verify (= merge gate)** | dynamic Workflow — `devflow.js mode:verify` | blind adversarial panel; its unanimous PASS is what *replaces the human reviewer* |
| **merge** | orchestrator (`gh`) | `gh pr merge` behind required-green-CI + branch protection; reversible via revert |
| **deploy (health-gated)** | Deployer agent / team | the only irreversible-in-a-window step: deploy → read live health → auto-promote or **auto-rollback** |
| **postship** | orchestrator | reconcile, graphify update, memory, REPORT |

**The principle that makes this safe:** "I don't review/merge/deploy myself" does not remove the gate — it **transfers the gate to the machine**. Every former human decision is now a machine-checkable gate strong enough to stand in for it. The dynamic Workflow primitive is deterministic fan-out + schema gates (great for scouts/verify, wrong for stateful execution); execution/merge/deploy stay off it.

## 1. What & when
`/devflow <repo> "<epic>"` takes an epic from intent to **production**, hands-off. Use it for any epic with 3+ tasks. Default = closed loop (review→merge→deploy with the two safeguards in §6). Escape hatch: `--pr` stops at a ready PR. Not for: one-file tweaks, or anything tripping the irreversible-ops tripwire (§6) — that always halts for a human.

## 2. Role roster
| role | lane | engine | mandate |
|---|---|---|---|
| Orchestrator | engine | command | sequence engines, apply dial, gate merge/deploy, reconcile |
| Scout/Recon | recon (RO) | Workflow | cut per-scope Context Pack (graphify, codebase-memory, codebase-search, **context7**) |
| Planner | plan | agent | DAG + path-ownership + machine-checkable acceptance |
| Implementer (+TDD) | write | Agent Team | RED→GREEN on owned paths; **LSP** edits, **context7** API grounding |
| Reviewer | write | Agent Team | consultative in-place review, sees writer reasoning |
| Security auditor | write (always-on for money/auth) | Agent Team | gate money-path/auth/migration zones — BLOCK or OK |
| Verifier (≥2) | verify (independent) | Workflow | **blind** PASS/FAIL; their unanimity *is the merge gate* |
| Runtime verifier (web) | verify | Workflow | drive the real UI via **chrome-devtools** |
| Completeness critic | verify | Workflow | intent↔diff coverage, no silent scope drop |
| **Releaser** | engine | orchestrator | merge PR on PASS + green CI |
| **Deployer** | deploy | agent/team | deploy via the repo's own mechanism, poll **live** health, auto-promote or **auto-rollback**, keep killswitch armed |

**Independence stays the heart:** the Reviewer improves work in-place (write lane); the Verifier panel runs on a *different engine*, blind, and **its PASS is now load-bearing** — it merges code. So the panel is non-negotiable: ≥2 blind verifiers (+1 for risk zones) + completeness critic + (web) runtime, unanimous, or no merge. Execution/verify teams run **Opus-direct** (`create-team-A/-O/-AO`), AO lane for risk zones.

## 3. Modern capability bolt-ons (verified present in this environment)
- **context7 MCP** — implementers/verifiers ground external API/SDK usage against *live docs* (`resolve-library-id` → `query-docs`). Kills stale-API hallucination.
- **chrome-devtools MCP** — web targets: verify lane drives the real UI (console, network, lighthouse). Runtime truth.
- **LSP** — precise diagnostics/rename/find-refs instead of grep-and-pray.
- **plan-gate dial** — `writing-plans` + an optional human checkpoint after the DAG (`--supervised`).
- **deploy access (NEW blast radius)** — closing the loop means the Deployer needs the repo's deploy credentials (ssh/docker/registry). This is a real expansion of what the automation can touch beyond git/gh; it is scoped per-repo and never reads plaintext secrets (tripwire §6).

## 4. Phase pipeline (gates are machine-checkable)
1. **recon** — `mode:recon` fans out one Scout per scope → `context_pack.md`. Gate: every pack `ok` + real files, else ABORT. Stale graph → `graphify update .` first.
2. **plan** — Planner (`writing-plans`) emits an acyclic DAG; waves have **pairwise-disjoint `owned_paths`**. Shared `go.mod`/types/schema/router/migration index → **serialize** into their own wave, never lie. Optional dial gate (§5).
3. **implement · test · integrate** — **team-orchestrator** (Agent Teams `.coord`): one ephemeral Opus implementer per ready packet (worktree-isolated, TDD with RED failing for the right reason, **LSP** + **context7**), killed via `shutdown_request` after handoff; tester loops-until-dry; team cherry-picks locally-green commits onto the epic branch.
4. **verify = merge gate** — `mode:verify`: `parallel()` barrier of ≥2 blind verifiers (+1 risk) + completeness critic + (web) runtime verifier. Exit: unanimous `{pass:true}`. FAIL → bounded repair through the team (max 3), then ABORT-to-FLAGGED. **This PASS replaces the human reviewer.**
5. **merge** — Releaser opens the PR, waits for **required green CI**, then `gh pr merge` (branch-protection on). PR body auto-rendered from packets + verify-reports for the audit trail.
6. **deploy (health-gated)** — Deployer: (a) confirm the repo exposes a **machine-readable health/SLO signal + rollback hook**; absent → STOP at merge for this repo, flag it. (b) deploy via the repo's own mechanism (canary/staged where available). (c) poll **live** health (a real tool call — never a guessed number; per CLAUDE.md). (d) within SLO → promote; breach → **auto-rollback**, halt the pipeline, alert. Killswitch stays armed throughout.
7. **postship** — reconcile `count(packets)==count(outcomes)`, `graphify update .`, append `reference_*.md` + `MEMORY.md`, render `REPORT.md`.

Every gate emits `{pass, reason, evidence}`. **No gate → no advance.** The two fan-out gates are strict and proven by `selftest/gates.test.mjs`: **recon** fails unless every expected scout returned a pack with real files (a missing scout is surfaced, not silently dropped); **verify** requires the full expected vote count + exact lens coverage + every vote `pass:true` with non-empty evidence (no "unanimous among survivors"). Parallel agents write per-agent event files (no shared-journal races). Task/acceptance/handoff/verdict contracts live in `schemas/*.json`; per-repo CI in `.devflow/quality.yml`.

## 5. Autonomy dial
```
--supervised   plan → [human OK] → … → deploy     (one optional touch, before any tokens spent)
DEFAULT        recon → … → verify → merge → deploy (closed loop, no human)
--pr           recon → … → verify → ready PR (STOP) (escape hatch: you take it from the PR)
```
All paths obey §6. The irreversible-ops tripwire halts regardless of dial.

## 6. The two safeguards (this is what makes closed-loop defensible)
**Safeguard A — health-gated deploy + auto-rollback.** A repo only auto-deploys if it exposes a machine-readable health/SLO signal and a rollback hook. Deploy is always `deploy → read live health → auto-promote OR auto-rollback`, killswitch armed. No health gate in a repo → the loop closes at **merge** for that repo until one is built. **Rollout maturity:** prove the closed loop on the lowest-stakes repo first (tax workbench / dashboard); trading graduates to auto-deploy **last**, and only after a rollback **drill** has been observed actually firing.

**Safeguard B — irreversible-ops tripwire.** These still halt the lane (write `BLOCKED.md`, require a human) — not because you're babysitting code, but because automation must never do the unrecoverable:
- drop / delete data; prod-destructive migration
- rotate or read plaintext prod credentials
- **disable the killswitch**
- **enable any non-gateio exchange** (trading stays gateio-only, always)
- force-push / history rewrite / branch delete

Everything else flows to prod with no human.

## 7. Manageability & resume
`runId` = git-committed `.coord/runs/<runId>/`: `journal.ndjson` (append-only, seq-keyed, includes merge SHA + deploy/rollback events), `control.json` (pause/redirect/abort at barriers), per-task `handoff.md`/`verify-report.md`, `REPORT.md` (deterministic render). **Resume:** `/devflow --resume <runId>` reconciles `.coord` against existing branches/PRs/deploys, skips already-journaled SHAs. **reconcile gate:** `count(input packets) == count(distinct terminal outcomes)`. Status enum: `SHIPPED|DEPLOYED|ROLLED_BACK|VERIFIED|SKIPPED|FLAGGED|FAILED`.

## 8. How to invoke
- `/devflow <repo> "<epic intent>"` — closed loop to production (default).
- `/devflow --supervised <repo> "<epic>"` — add the one plan checkpoint.
- `/devflow --pr <repo> "<epic>"` — stop at a ready PR.
- `/devflow --resume <runId>` — resume a detached/interrupted run.
- Steer: edit `.coord/runs/<runId>/control.json` (`pause`/`redirect`/`abort`).

Examples:
- `/devflow tax-workbench "add local-fiat FX conversion to the report"` (low-stakes — first proving ground)
- `/devflow mm-dashboard "fix phantom balances: verify balanceOf before display"`
- `/devflow trading-go "add 4-tier trailing stop-loss to gateio executor"` (deploy gated until rollback drill passes)
