#!/usr/bin/env node
// Self-test for the newly-enforced devflow CONTRACTS:
//   - the run-state machine        (../scripts/run_state.mjs)
//   - the AJV-backed validator     (../scripts/validate.mjs + ../schemas/*.schema.json)
//   - the quality-profile runner   (../scripts/quality.mjs)
//
// Unlike gates.test.mjs (which loads the fan-out engine inside node:vm), these
// modules are plain Node ESM, so we import them directly. No external test deps;
// it does need the same dependencies the modules themselves use (ajv, ajv-formats),
// which are already declared in devflow's package.json.
//
// It prints PASS/FAIL per scenario, a SUMMARY line, and process.exit(1) on any
// failure — so it doubles as a CI regression gate against accidental loosening of
// these contracts.

import { readFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import {
  createRun,
  transition,
  acquireLock,
  assertFresh,
  save,
  load,
  setTask,
} from '../scripts/run_state.mjs'
import { validateDoc } from '../scripts/validate.mjs'
import { runQuality } from '../scripts/quality.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))

// The real verdict schema — load it from disk (NOT an inlined copy) so this test
// pins the actual contract file the verify panel emits against.
const VERDICT_SCHEMA = JSON.parse(
  readFileSync(join(__dirname, '..', 'schemas', 'verdict.schema.json'), 'utf8')
)

// ---- test harness (mirrors gates.test.mjs) --------------------------------
let failures = 0
const lines = []
function check(name, cond, detail = '') {
  const ok = !!cond
  if (!ok) failures++
  const line = `${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : `  -> ${detail}`}`
  lines.push(line)
  console.log(line)
}

// Helper for "this call MUST throw with a message matching `re`". Calling fn()
// inside try then asserting on the NEXT line means a non-throwing fn is a real
// FAIL ('did not throw'), not a silently-passing empty catch.
function expectThrow(name, fn, re) {
  try {
    fn()
    check(name, false, 'did not throw')
  } catch (e) {
    check(name, re.test(e.message), `threw "${e.message}" (expected /${re.source}/)`)
  }
}

// Async variant for the disk-backed (save/load) scenarios.
async function expectThrowAsync(name, fn, re) {
  try {
    await fn()
    check(name, false, 'did not throw')
  } catch (e) {
    check(name, re.test(e.message), `threw "${e.message}" (expected /${re.source}/)`)
  }
}

// ===========================================================================
// RUN_STATE SCENARIOS
// ===========================================================================

// RS1: createRun -> fresh INIT state.
{
  const s = createRun({ runId: 'rs1', epicBranch: 'epic/rs1' })
  check('RS1 run_state createRun -> phase INIT',
    s.phase === 'INIT' && s.runId === 'rs1' && s.locks.epoch === 0 && s.locks.owner === null,
    `phase=${s.phase} runId=${s.runId} locks=${JSON.stringify(s.locks)}`)
}

// RS2: INIT->RECON_DONE succeeds; INIT->DEPLOYED throws 'illegal transition'.
{
  const init = createRun({ runId: 'rs2', epicBranch: 'epic/rs2' })
  let okLeg = false
  let okDetail = ''
  try {
    const next = transition(init, 'RECON_DONE')
    okLeg = next.phase === 'RECON_DONE' && init.phase === 'INIT' // immutable input
    okDetail = `next.phase=${next.phase} init.phase=${init.phase}`
  } catch (e) {
    okDetail = `unexpected throw: ${e.message}`
  }
  let throwLeg = false
  let throwDetail = ''
  try {
    transition(init, 'DEPLOYED')
    throwDetail = 'did not throw'
  } catch (e) {
    throwLeg = /illegal transition/.test(e.message)
    throwDetail = `threw "${e.message}"`
  }
  check('RS2 run_state INIT->RECON_DONE ok; INIT->DEPLOYED throws',
    okLeg && throwLeg, `${okDetail}; ${throwDetail}`)
}

// RS3: ROLLED_BACK legal ONLY from DEPLOYED (DEPLOYED->ROLLED_BACK ok;
//      INIT->ROLLED_BACK throws).
{
  // Walk the linear lifecycle to DEPLOYED, then roll back.
  let s = createRun({ runId: 'rs3', epicBranch: 'epic/rs3' })
  for (const p of ['RECON_DONE', 'PLAN_DONE', 'WAVE_INTEGRATED', 'VERIFY_DONE', 'MERGED', 'DEPLOYED']) {
    s = transition(s, p)
  }
  let okLeg = false
  let okDetail = ''
  try {
    const rb = transition(s, 'ROLLED_BACK')
    okLeg = rb.phase === 'ROLLED_BACK'
    okDetail = `DEPLOYED->ROLLED_BACK phase=${rb.phase}`
  } catch (e) {
    okDetail = `unexpected throw: ${e.message}`
  }
  let throwLeg = false
  let throwDetail = ''
  const init = createRun({ runId: 'rs3b', epicBranch: 'epic/rs3b' })
  try {
    transition(init, 'ROLLED_BACK')
    throwDetail = 'INIT->ROLLED_BACK did not throw'
  } catch (e) {
    throwLeg = /illegal transition/.test(e.message)
    throwDetail = `INIT->ROLLED_BACK threw "${e.message}"`
  }
  check('RS3 run_state ROLLED_BACK only from DEPLOYED',
    okLeg && throwLeg, `${okDetail}; ${throwDetail}`)
}

// RS4: assertFresh with an epoch lower than current locks.epoch throws 'stale epoch'.
{
  const init = createRun({ runId: 'rs4', epicBranch: 'epic/rs4' })
  const { state, epoch } = acquireLock(init, 'orchestrator') // epoch becomes 1
  // sanity: a fresh (current) epoch must NOT throw
  let freshOk = true
  try { assertFresh(state, epoch) } catch { freshOk = false }
  // the real assertion: an older epoch (epoch-1) must throw 'stale epoch'
  let staleThrew = false
  let detail = `acquired epoch=${epoch} freshOk=${freshOk}`
  try {
    assertFresh(state, epoch - 1)
    detail += '; older epoch did not throw'
  } catch (e) {
    staleThrew = /stale epoch/.test(e.message)
    detail += `; older epoch threw "${e.message}"`
  }
  check('RS4 run_state assertFresh(stale epoch) throws',
    freshOk && epoch === 1 && staleThrew, detail)
}

// RS5 + RS6: save() is the single enforcement CHOKEPOINT — an illegal phase jump
// or a stale-epoch write that BYPASSES the pure functions (the bug the blind
// verifier reproduced) must NOT reach disk. run_state roots persistence at
// process.cwd(), so isolate these in a throwaway temp dir.
{
  const origCwd = process.cwd()
  const tmp = mkdtempSync(join(tmpdir(), 'devflow-rs-'))
  process.chdir(tmp)
  try {
    // RS5: set phase directly (skipping transition()) then save() -> must throw.
    const s = createRun({ runId: 'rs5', epicBranch: 'epic/rs5' })
    await save(s) // legit INIT snapshot on disk
    const bypass = { ...s, phase: 'DEPLOYED' } // illegal jump, bypassed transition()
    await expectThrowAsync('RS5 save() rejects illegal phase jump (bypass closed)',
      () => save(bypass), /illegal transition/)

    // RS6: a superseded epoch holder's save() -> must throw 'stale epoch'.
    const base = createRun({ runId: 'rs6', epicBranch: 'epic/rs6' })
    await save(base) // epoch 0 on disk
    const { state: held } = acquireLock(await load('rs6'), 'holderB') // epoch 1
    await save(held) // disk advances to epoch 1
    const stale = setTask({ ...base, locks: { owner: 'holderA', epoch: 0 } }, 'T-001', { state: 'IMPLEMENTED' })
    await expectThrowAsync('RS6 save() rejects stale-epoch write (bypass closed)',
      () => save(stale), /stale epoch/)
  } finally {
    process.chdir(origCwd)
  }
}

// ===========================================================================
// VALIDATE SCENARIOS  (against the REAL ../schemas/verdict.schema.json)
// ===========================================================================

// VAL1: a GOOD verdict doc passes validateDoc.
{
  const good = {
    task: 'T-001',
    lens: 'correctness',
    pass: true,
    reason: 'rebuilt and ran the suite; all green',
    evidence: ['npm test -> 12 passing', 'src/foo.ts:42 returns 200'],
  }
  const res = validateDoc(VERDICT_SCHEMA, good)
  check('VAL1 validate good verdict passes',
    res && res.valid === true,
    `valid=${res && res.valid} errors=${JSON.stringify(res && res.errors)}`)
}

// VAL2: a BAD verdict fails validateDoc. We assert BOTH failure modes:
//   (a) evidence:[] violates minItems:1, and
//   (b) a doc missing a required field (reason) is also rejected.
{
  const emptyEvidence = {
    task: 'T-001',
    lens: 'correctness',
    pass: true,
    reason: 'claims pass but offers no proof',
    evidence: [],
  }
  const missingRequired = {
    task: 'T-001',
    lens: 'correctness',
    pass: false,
    // reason omitted (required)
    evidence: ['some evidence'],
  }
  const rEmpty = validateDoc(VERDICT_SCHEMA, emptyEvidence)
  const rMissing = validateDoc(VERDICT_SCHEMA, missingRequired)
  check('VAL2 validate bad verdict fails (empty evidence + missing required)',
    rEmpty && rEmpty.valid === false && rMissing && rMissing.valid === false,
    `emptyEvidence.valid=${rEmpty && rEmpty.valid} missingRequired.valid=${rMissing && rMissing.valid}`)
}

// ===========================================================================
// QUALITY SCENARIOS  (runQuality spawns its check cmds via the shell;
//   `true`/`false` are POSIX shell builtins exiting 0 / 1.)
// ===========================================================================

// Q1: all-pass fixture -> ok true (we map ok -> exit 0).
{
  const cfg = { required: { lint: { cmd: 'true' }, test: { cmd: 'true' } } }
  const result = await runQuality(cfg, {})
  const exit = result.ok ? 0 : 1
  check('Q1 quality all-pass -> success/exit 0',
    result.ok === true && exit === 0 && result.failed.length === 0,
    `ok=${result.ok} exit=${exit} failed=${JSON.stringify(result.failed)}`)
}

// Q2: one failing required check -> ok false (exit 1) AND result.failed names it.
{
  const cfg = { required: { good: { cmd: 'true' }, bad: { cmd: 'false' } } }
  const result = await runQuality(cfg, {})
  const exit = result.ok ? 0 : 1
  check('Q2 quality one failing required -> failure/exit 1 names check',
    result.ok === false && exit === 1 &&
      Array.isArray(result.failed) && result.failed.includes('bad') && !result.failed.includes('good'),
    `ok=${result.ok} exit=${exit} failed=${JSON.stringify(result.failed)}`)
}

// ---- summary --------------------------------------------------------------
const total = lines.length
const passed = total - failures
const summary = `SUMMARY ${passed}/${total} scenarios passed`
console.log(summary)
if (failures > 0) {
  console.error(`FAILED: ${failures} scenario(s) failed`)
  process.exit(1)
}
