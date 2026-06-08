#!/usr/bin/env node
// Self-test for the hardened devflow fan-out gates in ../workflows/devflow.js.
// Mechanism: we run the FIRST-PARTY engine source inside node:vm. The ONLY thing
// concatenated into executed code is the trusted engine source between two CONSTANT
// string literals (PRE/POST); no external/user variable is ever placed into the
// executed code, so this is not arbitrary-code-injection.
import vm from 'node:vm'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ENGINE = join(__dirname, '..', 'workflows', 'devflow.js')

// Read OUR OWN repo engine file as text and strip the leading `export ` so the
// top-level declarations become plain consts runnable inside the IIFE.
const rawSrc = readFileSync(ENGINE, 'utf8')
// Strip only the single leading `export ` at the very start of the file so the
// top-level declaration becomes a plain const. Anchored to start-of-file (no g/m
// flags) so a stray `export ` inside a template literal can never be corrupted.
const src = rawSrc.replace(/^export\s+/, '')

// The engine uses top-level `return`/`await`; wrap it in an async IIFE so both are
// legal. PRE and POST are CONSTANT literals — nothing else is concatenated in.
const PRE = '(async()=>{'
const POST = '})()'

// Build the canonical (passing) shape for a given label, derived purely from the
// label prefix — never from the prompt text.
function canonicalFor(label) {
  if (label.startsWith('scout:')) {
    const id = label.slice('scout:'.length)
    return { item: id, ok: true, files: ['f.ts'], godNodes: [], notes: '' }
  }
  if (label.startsWith('verify:')) {
    const task = label.slice('verify:'.length).split('#')[0]
    return { task, lens: 'correctness', pass: true, reason: '', evidence: ['ev'] }
  }
  if (label.startsWith('critic:')) {
    const task = label.slice('critic:'.length)
    return { task, lens: 'completeness', pass: true, reason: '', evidence: ['ev'] }
  }
  if (label.startsWith('runtime:')) {
    const task = label.slice('runtime:'.length)
    return { task, lens: 'runtime', pass: true, reason: '', evidence: ['ev'] }
  }
  return null
}

// Run the engine once with the given args and per-scenario overrides.
// overrides = {
//   drop:           Set<label>   -> agent returns null for that label
//   stripEvidence:  Set<label>   -> verdict returned with evidence:[]
//   emptyFiles:     Set<label>   -> scout pack returned with files:[]
// }
async function runEngine(args, overrides = {}) {
  const drop = overrides.drop || new Set()
  const stripEvidence = overrides.stripEvidence || new Set()
  const emptyFiles = overrides.emptyFiles || new Set()

  // Fresh agent stub per scenario, closing over this scenario's overrides only.
  const agent = async (_prompt, opts) => {
    const label = opts && opts.label
    if (drop.has(label)) return null
    const obj = canonicalFor(label)
    if (!obj) return null
    if (emptyFiles.has(label) && 'files' in obj) obj.files = []
    if (stripEvidence.has(label) && 'evidence' in obj) obj.evidence = []
    return obj
  }

  const sandbox = {
    args,
    agent,
    parallel: (thunks) => Promise.all(thunks.map((t) => t())), // null returns survive
    phase: () => {},
    log: () => {},
  }

  return vm.runInNewContext(PRE + src + POST, sandbox)
}

// ---- test harness ---------------------------------------------------------
let failures = 0
const lines = []
function check(name, cond, detail = '') {
  const ok = !!cond
  if (!ok) failures++
  const line = `${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : `  -> ${detail}`}`
  lines.push(line)
  console.log(line)
}

// ===========================================================================
// SCENARIOS
// ===========================================================================
const reconUnits = [
  { id: 'A', intent: 'unit a' },
  { id: 'B', intent: 'unit b' },
]

// R1: recon, all units ok -> result.ok === true
{
  const r = await runEngine({ mode: 'recon', runId: 'r1', epicId: 'E', tasks: reconUnits })
  check('R1 recon all units ok', r.ok === true,
    `ok=${r.ok} missing=${JSON.stringify(r.missing)} empty=${JSON.stringify(r.empty)}`)
}

// R2: one scout returns null (drop scout:B) -> ok false && missing includes 'B'
{
  const r = await runEngine(
    { mode: 'recon', runId: 'r2', epicId: 'E', tasks: reconUnits },
    { drop: new Set(['scout:B']) })
  check('R2 recon one scout null', r.ok === false && Array.isArray(r.missing) && r.missing.includes('B'),
    `ok=${r.ok} missing=${JSON.stringify(r.missing)}`)
}

// R3: one pack files:[] -> ok false && empty includes that id
{
  const r = await runEngine(
    { mode: 'recon', runId: 'r3', epicId: 'E', tasks: reconUnits },
    { emptyFiles: new Set(['scout:B']) })
  check('R3 recon pack files:[]', r.ok === false && Array.isArray(r.empty) && r.empty.includes('B'),
    `ok=${r.ok} empty=${JSON.stringify(r.empty)} missing=${JSON.stringify(r.missing)}`)
}

// Default verify task (non-web, non-risk): 2 verifiers + 1 critic = 3 votes.
const vTask = { id: 'T1', intent: 'do the thing', acceptance: ['x'], branch: 'feat', sha: 'abc' }

// V1: full panel, all pass + evidence -> pass true
{
  const r = await runEngine({ mode: 'verify', runId: 'v1', epicId: 'E', tasks: [vTask] })
  check('V1 verify full panel passes', r.pass === true,
    `pass=${r.pass} ok=${r.ok} failed=${JSON.stringify(r.failed)}`)
}

// V2: one verifier dropped to null (only 2 of 3 votes) -> pass false (ok stays true).
{
  const r = await runEngine(
    { mode: 'verify', runId: 'v2', epicId: 'E', tasks: [vTask] },
    { drop: new Set(['verify:T1#2']) })
  check('V2 verify missing verifier vote', r.pass === false,
    `pass=${r.pass} ok=${r.ok} failed=${JSON.stringify(r.failed)}`)
}

// V3: a vote with evidence:[] -> pass false
{
  const r = await runEngine(
    { mode: 'verify', runId: 'v3', epicId: 'E', tasks: [vTask] },
    { stripEvidence: new Set(['verify:T1#1']) })
  check('V3 verify empty-evidence vote', r.pass === false,
    `pass=${r.pass} ok=${r.ok} failed=${JSON.stringify(r.failed)}`)
}

// V4: web task needs a runtime vote. Drop runtime -> fail; include -> pass.
const webTask = { id: 'T1', intent: 'web thing', acceptance: ['x'], branch: 'feat', sha: 'abc', web: true }
{
  const dropped = await runEngine(
    { mode: 'verify', runId: 'v4a', epicId: 'E', tasks: [webTask] },
    { drop: new Set(['runtime:T1']) })
  const present = await runEngine({ mode: 'verify', runId: 'v4b', epicId: 'E', tasks: [webTask] })
  check('V4 web task requires runtime vote',
    dropped.pass === false && present.pass === true,
    `droppedPass=${dropped.pass} presentPass=${present.pass} ` +
    `droppedFailed=${JSON.stringify(dropped.failed)} presentFailed=${JSON.stringify(present.failed)}`)
}

// M1: unknown mode -> ok false
{
  const r = await runEngine({ mode: 'bogus', runId: 'm1', epicId: 'E', tasks: [] })
  check('M1 unknown mode', r.ok === false, `ok=${r.ok} reason=${r.reason}`)
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
