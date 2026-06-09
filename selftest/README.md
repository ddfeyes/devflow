# devflow self-tests

Two self-test files, both runnable with plain `node` (no test runner, no install beyond the deps already in `package.json`). Each prints `PASS`/`FAIL` per scenario, a `SUMMARY` line, and exits non-zero on any failure, so both double as CI regression gates against accidental loosening of the contracts they pin.

## `gates.test.mjs` — fan-out gate self-test (8 scenarios)

Run with `node selftest/gates.test.mjs` (no install, no external deps; needs Node with `node:vm`). It loads the first-party engine `workflows/devflow.js` as text, strips the leading `export` keywords, and executes the source inside a `node:vm` sandbox wrapped between two constant string literals (`(async()=>{` … `})()`) so the engine's top-level `await`/`return` are legal — the only thing concatenated into executed code is our own trusted engine source, never any external or user input. The sandbox supplies stub globals (`args`, `agent`, `parallel`, `phase`, `log`); the `agent` stub returns canonical recon packs / verify verdicts keyed purely off `opts.label`, with per-scenario overrides that drop a vote to `null`, empty a pack's `files`, or strip a verdict's `evidence`. It guarantees the hardened gates hold: recon `ok` is true only when every scout returns a non-empty pack and false when any unit is missing (`R2`) or has empty files (`R3`); verify `pass` is true only with the full panel (2 blind verifiers + 1 completeness critic, plus 1 runtime verifier for web tasks) where every vote passes with non-empty evidence, and false on a missing vote (`V2`), empty evidence (`V3`), a missing required web runtime vote (`V4`), or an unknown mode (`M1`). Expected: `SUMMARY 8/8 scenarios passed`.

## `contracts.test.mjs` — contract self-test (8 scenarios)

Run with `node selftest/contracts.test.mjs`. Unlike `gates.test.mjs`, these modules are plain Node ESM, so it imports them directly from `../scripts/` and exercises the three newly-enforced contracts:

- **run-state machine** (`scripts/run_state.mjs`): `RS1` `createRun` yields a fresh `INIT` state; `RS2` `INIT->RECON_DONE` succeeds while `INIT->DEPLOYED` throws `illegal transition`; `RS3` `ROLLED_BACK` is reachable only from `DEPLOYED` (`DEPLOYED->ROLLED_BACK` ok, `INIT->ROLLED_BACK` throws); `RS4` `assertFresh` with an epoch lower than the current `locks.epoch` throws `stale epoch`.
- **contract validator** (`scripts/validate.mjs` against the real `schemas/verdict.schema.json`): `VAL1` a well-formed verdict passes `validateDoc`; `VAL2` a malformed verdict fails — both `evidence:[]` (violates `minItems:1`) and a doc missing a required field are rejected.
- **quality runner** (`scripts/quality.mjs`): `Q1` an all-pass fixture returns `ok:true` (mapped to exit 0); `Q2` a fixture with one failing required check returns `ok:false` (exit 1) and names the failing check in `result.failed`.

The quality scenarios spawn each check's `cmd` through the shell, using the POSIX builtins `true`/`false` (exit 0/1) so no project state is touched. Throw-expecting scenarios assert on the thrown message and treat a non-throwing call as a failure (`did not throw`), so they cannot pass vacuously. Expected: `SUMMARY 8/8 scenarios passed`.
