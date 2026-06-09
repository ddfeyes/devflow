#!/usr/bin/env node
// run_state.mjs — the canonical run-state source-of-truth for a devflow run (GPT critique #13).
//
// This module owns the in-memory shape AND the on-disk persistence of one run's
// resumable snapshot (`.coord/runs/<runId>/run_state.json`). It is the single
// source of truth the orchestrator reconciles against branches/PRs/deploys on
// --resume.
//
// Design notes:
//  - The *pure-ish* functions (createRun / transition / acquireLock / assertFresh
//    / setTask) never touch the filesystem and never throw on I/O. They return a
//    NEW state object (no in-place mutation of the caller's argument) so callers
//    can treat state as immutable and reason about epochs cleanly.
//  - Persistence (load / save) is the only place that touches disk. save() does an
//    ATOMIC write (write to a same-directory tmp file, then rename) so a crash
//    mid-write can never leave a torn/partial JSON snapshot — readers either see
//    the previous complete file or the new complete file, never a half one.
//  - save() is the single enforcement CHOKEPOINT. Before writing it (a) validates
//    the snapshot SHAPE against schemas/run_state.schema.json via the shared
//    `validateDoc` from ./validate.mjs (AJV-backed), AND (b) re-checks legality
//    against the ON-DISK prior: the on-disk -> requested phase must be a legal
//    transition() and the writer's epoch must pass assertFresh(). So even a caller
//    that bypasses the pure functions (sets state.phase directly, or mutates from a
//    superseded epoch) cannot land an illegal/ stale snapshot on disk — the only
//    way onto disk is through this guard. We import validate.mjs lazily (inside the
//    I/O functions) so the pure state machine remains usable — and unit-testable —
//    even before/without the validator module or AJV being resolvable.
//
// Wall-clock (Date.now / new Date) is acceptable here per the task: updatedAt is an
// observational timestamp, not a logical clock — the `locks.epoch` fence token is
// the authority for ordering/staleness, not the wall clock.

import { mkdir, writeFile, readFile, rename } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))

// The run_state schema lives alongside the other contracts in ../schemas/.
const RUN_STATE_SCHEMA_PATH = resolve(__dirname, '..', 'schemas', 'run_state.schema.json')

// ---------------------------------------------------------------------------
// Phase lifecycle
// ---------------------------------------------------------------------------

// The linear forward lifecycle. Each phase's only legal successor is the next
// element. (ROLLED_BACK is intentionally NOT in this list — it is a special edge
// reachable only from DEPLOYED, handled in transition().)
export const PHASES = Object.freeze([
  'INIT',
  'RECON_DONE',
  'PLAN_DONE',
  'WAVE_INTEGRATED',
  'VERIFY_DONE',
  'MERGED',
  'DEPLOYED',
  'REPORT_DONE',
])

// The terminal failure phase, reachable ONLY from DEPLOYED (a health-gated deploy
// that auto-rolled-back). It is terminal: nothing legally transitions out of it.
export const ROLLED_BACK = 'ROLLED_BACK'

// Per-task states (mirrors run_state.schema.json -> tasks.*.state enum).
export const TASK_STATES = Object.freeze([
  'READY',
  'IMPLEMENTED',
  'INTEGRATED',
  'VERIFIED',
  'FAILED',
  'FLAGGED',
  'SHIPPED',
])

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

// Deep-ish clone of a run state. The state is plain JSON (no functions, no Dates,
// no cycles) so structuredClone (or JSON round-trip fallback) is exact and safe.
function cloneState(state) {
  if (typeof structuredClone === 'function') return structuredClone(state)
  return JSON.parse(JSON.stringify(state))
}

function nowIso() {
  return new Date().toISOString()
}

// Resolve the on-disk path for a run's snapshot, rooted at cwd (the repo running
// the orchestrator). Kept here so load/save agree on the layout.
function runDir(runId) {
  return join(process.cwd(), '.coord', 'runs', String(runId))
}
function runStatePath(runId) {
  return join(runDir(runId), 'run_state.json')
}

// ---------------------------------------------------------------------------
// Pure-ish state machine
// ---------------------------------------------------------------------------

/**
 * createRun({runId, epicBranch}) -> fresh INIT state.
 * @returns {object} {runId, phase:'INIT', epicBranch, tasks:{}, locks:{owner:null, epoch:0}, updatedAt}
 */
export function createRun({ runId, epicBranch } = {}) {
  if (!runId || typeof runId !== 'string') {
    throw new Error('createRun: runId (non-empty string) is required')
  }
  if (!epicBranch || typeof epicBranch !== 'string') {
    throw new Error('createRun: epicBranch (non-empty string) is required')
  }
  return {
    runId,
    phase: 'INIT',
    epicBranch,
    tasks: {},
    locks: { owner: null, epoch: 0 },
    updatedAt: nowIso(),
  }
}

/**
 * transition(state, toPhase) -> NEW state.
 * Legal iff toPhase is:
 *   - the immediate next phase in PHASES, OR
 *   - the same phase (idempotent re-assert), OR
 *   - the ROLLED_BACK edge, and only from DEPLOYED.
 * Otherwise THROWS Error('illegal transition X->Y').
 */
export function transition(state, toPhase) {
  const from = state.phase

  // Idempotent: re-asserting the current phase is always a no-op success.
  if (toPhase === from) {
    const next = cloneState(state)
    next.updatedAt = nowIso()
    return next
  }

  // Special edge: ROLLED_BACK is reachable ONLY from DEPLOYED.
  if (toPhase === ROLLED_BACK) {
    if (from === 'DEPLOYED') {
      const next = cloneState(state)
      next.phase = ROLLED_BACK
      next.updatedAt = nowIso()
      return next
    }
    throw new Error(`illegal transition ${from}->${toPhase}`)
  }

  // Nothing transitions OUT of the terminal phase.
  if (from === ROLLED_BACK) {
    throw new Error(`illegal transition ${from}->${toPhase}`)
  }

  // Forward-by-one along the linear lifecycle.
  const fromIdx = PHASES.indexOf(from)
  const toIdx = PHASES.indexOf(toPhase)
  if (fromIdx === -1) {
    throw new Error(`illegal transition ${from}->${toPhase}`)
  }
  if (toIdx === -1) {
    // toPhase is not a known forward phase (e.g. garbage, or ROLLED_BACK from a
    // non-DEPLOYED phase already handled above).
    throw new Error(`illegal transition ${from}->${toPhase}`)
  }
  if (toIdx === fromIdx + 1) {
    const next = cloneState(state)
    next.phase = toPhase
    next.updatedAt = nowIso()
    return next
  }

  throw new Error(`illegal transition ${from}->${toPhase}`)
}

/**
 * acquireLock(state, owner) -> {state, epoch}.
 * Bumps the fence token (epoch) and records the new owner. The bump is what makes
 * any prior holder stale (see assertFresh). Returns a NEW state plus the new epoch
 * so the acquirer knows the token it must present on subsequent mutations.
 */
export function acquireLock(state, owner) {
  if (owner == null || typeof owner !== 'string' || owner.length === 0) {
    throw new Error('acquireLock: owner (non-empty string) is required')
  }
  const next = cloneState(state)
  const epoch = (next.locks?.epoch ?? 0) + 1
  next.locks = { owner, epoch }
  next.updatedAt = nowIso()
  return { state: next, epoch }
}

/**
 * assertFresh(state, epoch) -> void.
 * THROWS Error('stale epoch') if the presented epoch is older than the current
 * fence token — i.e. a lock holder that has since been superseded must not mutate.
 * An equal or newer epoch is accepted (the current holder is fresh).
 */
export function assertFresh(state, epoch) {
  const current = state.locks?.epoch ?? 0
  // Number.isInteger rejects non-numbers AND NaN (typeof NaN === 'number' but
  // NaN < current is always false, which would otherwise let a NaN epoch slip past).
  if (!Number.isInteger(epoch) || epoch < current) {
    throw new Error('stale epoch')
  }
}

/**
 * setTask(state, id, patch) -> NEW state.
 * Merges the given patch into tasks[id]. Allowed patch fields: state, sha, prUrl.
 * Creates the task entry if absent. Existing fields are preserved unless the patch
 * overrides them. (Validation of enum/format is enforced at save() time against the
 * JSON schema; this function keeps the in-memory merge simple and total.)
 */
export function setTask(state, id, patch = {}) {
  if (!id || typeof id !== 'string') {
    throw new Error('setTask: task id (non-empty string) is required')
  }
  const next = cloneState(state)
  if (!next.tasks || typeof next.tasks !== 'object') next.tasks = {}
  const prev = next.tasks[id] || {}
  const merged = { ...prev }
  // Only copy the three allowed fields when present (additionalProperties:false in
  // the schema would reject anything else — keep the snapshot clean).
  if (patch.state !== undefined) merged.state = patch.state
  if (patch.sha !== undefined) merged.sha = patch.sha
  if (patch.prUrl !== undefined) merged.prUrl = patch.prUrl
  next.tasks[id] = merged
  next.updatedAt = nowIso()
  return next
}

// ---------------------------------------------------------------------------
// Persistence (atomic write + schema validation)
// ---------------------------------------------------------------------------

// Build the schema-conformant projection of a state. The schema declares
// additionalProperties:false at the top level with required runId/phase/epicBranch/
// tasks, plus optional locks. We DO persist `updatedAt`? — No: the schema forbids
// unknown top-level keys, so `updatedAt` (not in the schema) would fail validation.
// We therefore strip it from the validated/persisted document. updatedAt remains an
// in-memory convenience only.
function toSnapshot(state) {
  const snap = {
    runId: state.runId,
    phase: state.phase,
    epicBranch: state.epicBranch,
    tasks: state.tasks ?? {},
  }
  if (state.locks !== undefined) {
    // Schema requires owner to be a string (empty string when unheld), not null.
    // Normalize the in-memory `null` sentinel to '' for the persisted snapshot.
    const owner = state.locks.owner == null ? '' : state.locks.owner
    snap.locks = { owner, epoch: state.locks.epoch ?? 0 }
  }
  return snap
}

// Lazily load the shared AJV validator authored in ./validate.mjs. We import it at
// call time (not at module top) so the pure state machine above stays usable even
// if validate.mjs / AJV is not yet resolvable in the environment.
//
// validate.mjs contract:  validateDoc(schemaObj, doc) -> { valid:boolean, errors:object[] }
// i.e. the FIRST argument is the parsed JSON-Schema OBJECT (not a name), so we read
// run_state.schema.json from ../schemas/ and hand the parsed object in.
async function getValidateDoc() {
  const mod = await import('./validate.mjs')
  const fn = mod.validateDoc || (mod.default && mod.default.validateDoc) || mod.default
  if (typeof fn !== 'function') {
    throw new Error('run_state: ./validate.mjs does not export a validateDoc function')
  }
  return fn
}

// Read + cache the parsed run_state schema object (the entry schema validateDoc wants).
let _schemaObj
function getSchemaObject() {
  if (_schemaObj === undefined) {
    _schemaObj = JSON.parse(readFileSync(RUN_STATE_SCHEMA_PATH, 'utf8'))
  }
  return _schemaObj
}

// Validate a snapshot against the run_state schema. THROWS with the AJV errors if
// invalid, so an illegal snapshot can never be persisted.
async function assertValidSnapshot(snapshot) {
  const validateDoc = await getValidateDoc()
  const result = await validateDoc(getSchemaObject(), snapshot)
  // validateDoc returns { valid, errors }; tolerate a bare boolean / throwing impl too.
  if (result === true || result === undefined) return
  if (result && result.valid === true) return
  const errs = (result && result.errors) ? JSON.stringify(result.errors) : String(result)
  throw new Error(`run_state: snapshot failed schema validation: ${errs}`)
}

/**
 * save(state) -> Promise<string> (the path written).
 * save() is the SINGLE enforcement chokepoint — a caller that bypasses the pure
 * state machine (sets state.phase directly, or mutates from a superseded epoch)
 * must not be able to persist that. Before writing it:
 *   1) projects state -> schema snapshot and validates it (throws if invalid SHAPE),
 *   2) re-checks against the on-disk truth: the on-disk -> new phase edge must be a
 *      legal transition() and the writer's epoch must be fresh (assertFresh) — so an
 *      illegal phase jump or a stale-epoch write can NEVER reach disk even if the
 *      caller skipped transition()/assertFresh(); a brand-new run may only start at INIT,
 *   3) writes atomically (tmp file in the SAME dir, then rename over the target).
 */
export async function save(state) {
  const snapshot = toSnapshot(state)
  await assertValidSnapshot(snapshot)

  // Re-derive legality from on-disk truth, not from the caller's in-memory claims.
  let prior = null
  try {
    prior = await load(state.runId)
  } catch (e) {
    if (!(e && e.code === 'ENOENT')) throw e
    prior = null
  }
  if (prior === null) {
    if (state.phase !== 'INIT') {
      throw new Error(`run_state: first save of run ${state.runId} must start at INIT, got ${state.phase}`)
    }
  } else {
    // A superseded epoch holder must not write over a newer one.
    assertFresh(prior, state.locks?.epoch ?? 0)
    // The on-disk -> requested phase edge must be legal (throws 'illegal transition' otherwise).
    transition(prior, state.phase)
  }

  const dir = runDir(state.runId)
  const target = runStatePath(state.runId)
  await mkdir(dir, { recursive: true })

  const body = JSON.stringify(snapshot, null, 2) + '\n'
  // Unique tmp name in the same directory so rename() is atomic (same filesystem).
  const tmp = join(dir, `.run_state.${process.pid}.${Date.now()}.tmp`)
  await writeFile(tmp, body, 'utf8')
  await rename(tmp, target) // atomic replace
  return target
}

/**
 * load(runId) -> Promise<state>.
 * Reads + parses the persisted snapshot, re-validates it (a corrupt or hand-edited
 * file that violates the schema is rejected rather than silently trusted), and
 * rehydrates the in-memory state (locks.owner '' -> null sentinel, updatedAt set).
 */
export async function load(runId) {
  const target = runStatePath(runId)
  const raw = await readFile(target, 'utf8')
  const snapshot = JSON.parse(raw)
  await assertValidSnapshot(snapshot)

  const state = {
    runId: snapshot.runId,
    phase: snapshot.phase,
    epicBranch: snapshot.epicBranch,
    tasks: snapshot.tasks ?? {},
    locks: snapshot.locks
      ? { owner: snapshot.locks.owner === '' ? null : snapshot.locks.owner, epoch: snapshot.locks.epoch ?? 0 }
      : { owner: null, epoch: 0 },
    updatedAt: nowIso(),
  }
  return state
}

// ---------------------------------------------------------------------------
// Smoke test (run directly: `node scripts/run_state.mjs`)
// ---------------------------------------------------------------------------
// Exercises ONLY the pure state machine (no disk, no validate.mjs needed) so it is
// runnable standalone. Asserts the three required behaviors and prints results.
const isMain = (() => {
  try {
    return process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
  } catch {
    return false
  }
})()

if (isMain) {
  const out = []
  const ok = (label, v) => out.push(`  [ok]    ${label}${v !== undefined ? ' -> ' + v : ''}`)
  const fail = (label, e) => out.push(`  [FAIL]  ${label}: ${e}`)
  let failures = 0

  // 1) createRun
  const s0 = createRun({ runId: 'smoke-1', epicBranch: 'epic/smoke' })
  if (s0.phase === 'INIT' && s0.runId === 'smoke-1' && s0.locks.epoch === 0 && s0.locks.owner === null) {
    ok('createRun', `phase=${s0.phase} locks.epoch=${s0.locks.epoch}`)
  } else { failures++; fail('createRun', JSON.stringify(s0)) }

  // 2) transition INIT->RECON_DONE (ok)
  let s1
  try {
    s1 = transition(s0, 'RECON_DONE')
    if (s1.phase === 'RECON_DONE') ok('transition INIT->RECON_DONE', s1.phase)
    else { failures++; fail('transition INIT->RECON_DONE', `phase=${s1.phase}`) }
  } catch (e) { failures++; fail('transition INIT->RECON_DONE', e.message) }

  // 3) transition RECON_DONE->DEPLOYED (must THROW)
  try {
    transition(s1, 'DEPLOYED')
    failures++; fail('transition RECON_DONE->DEPLOYED (expected throw)', 'did not throw')
  } catch (e) {
    if (/illegal transition/.test(e.message)) ok('transition RECON_DONE->DEPLOYED throws', `"${e.message}"`)
    else { failures++; fail('transition RECON_DONE->DEPLOYED', e.message) }
  }

  // 4) acquireLock then assertFresh with an OLDER epoch (must THROW 'stale epoch')
  const { state: s2, epoch } = acquireLock(s1, 'orchestrator')
  if (s2.locks.owner === 'orchestrator' && epoch === 1) ok('acquireLock', `owner=${s2.locks.owner} epoch=${epoch}`)
  else { failures++; fail('acquireLock', JSON.stringify(s2.locks)) }

  // fresh holder (current epoch) passes
  try { assertFresh(s2, epoch); ok('assertFresh(current epoch) passes', `epoch=${epoch}`) }
  catch (e) { failures++; fail('assertFresh(current epoch)', e.message) }

  // stale holder (older epoch) throws
  try {
    assertFresh(s2, epoch - 1)
    failures++; fail('assertFresh(older epoch) (expected throw)', 'did not throw')
  } catch (e) {
    if (/stale epoch/.test(e.message)) ok('assertFresh(older epoch) throws', `"${e.message}"`)
    else { failures++; fail('assertFresh(older epoch)', e.message) }
  }

  // bonus: idempotent transition + legal ROLLED_BACK edge
  try { const same = transition(s2, 'RECON_DONE'); ok('transition same-phase idempotent', same.phase) }
  catch (e) { failures++; fail('transition same-phase idempotent', e.message) }
  try {
    // walk to DEPLOYED then roll back
    let w = createRun({ runId: 'smoke-2', epicBranch: 'e' })
    for (const p of ['RECON_DONE','PLAN_DONE','WAVE_INTEGRATED','VERIFY_DONE','MERGED','DEPLOYED']) w = transition(w, p)
    const rb = transition(w, 'ROLLED_BACK')
    if (rb.phase === 'ROLLED_BACK') ok('transition DEPLOYED->ROLLED_BACK', rb.phase)
    else { failures++; fail('transition DEPLOYED->ROLLED_BACK', rb.phase) }
    // illegal: ROLLED_BACK from non-DEPLOYED
    try { transition(createRun({ runId: 'x', epicBranch: 'e' }), 'ROLLED_BACK'); failures++; fail('ROLLED_BACK from INIT (expected throw)', 'did not throw') }
    catch (e2) { if (/illegal transition/.test(e2.message)) ok('ROLLED_BACK from INIT throws', `"${e2.message}"`); else { failures++; fail('ROLLED_BACK from INIT', e2.message) } }
  } catch (e) { failures++; fail('ROLLED_BACK edge', e.message) }

  console.log('run_state.mjs smoke test:')
  console.log(out.join('\n'))
  console.log(failures === 0 ? '\nSMOKE: PASS' : `\nSMOKE: FAIL (${failures} failures)`)
  process.exit(failures === 0 ? 0 : 1)
}
