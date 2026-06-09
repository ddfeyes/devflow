#!/usr/bin/env node
// devflow quality-profile runner  —  formalizes GPT critique #11.
//
// "Required green CI" is defined PER-REPO here, not inherited from chance.
// The runner reads `.devflow/quality.yml` (the documented shape lives in
// `.devflow/quality.example.yml`) and enforces it:
//
//   - every `required` check is run (its `cmd` is spawned via the shell);
//   - every `conditional` block whose `when:` flag is active (passed via
//     --stack) is run; inactive blocks are SKIPPED, not failed;
//   - `coverage.min_line` is a hard floor; `coverage.no_decrease` is a
//     ratchet against a baseline file (only if that file exists).
//
// It prints a PASS/FAIL table and process.exit(1) if ANY required-or-active
// check fails OR coverage is below the floor / below the baseline.
//
// CLI:
//   node scripts/quality.mjs [--stack web|go|node|migration ...] \
//                            [--coverage <pct>] [--config <path>]
//
// `--stack` may be repeated (or comma-joined): `--stack web --stack go` or
// `--stack web,go`. A stack flag with no matching `when:` block is a harmless
// no-op (e.g. `node` is valid even though no example block keys off it).
//
// `--coverage <pct>` injects an already-MEASURED line-coverage percentage
// (e.g. produced upstream by the test run) and is compared against
// `coverage.min_line`. When omitted, the runner falls back to running
// `coverage.cmd` and parsing the first number out of its stdout.
//
// no_decrease baseline: read from `.devflow/coverage-baseline.json`
// (`{ "line": <pct> }`) or a plaintext percentage in the same file, RELATIVE
// to the config's directory. If the file is absent, the ratchet is skipped
// (there is nothing to regress against yet).
//
// `must_be_reversible` (migration dry-run) is parse-tolerated but NOT
// enforced here — the destructive apply is a tripwire handled elsewhere.
//
// Design contract for the selftest: `runQuality(config, opts)` takes the
// ALREADY-PARSED config object (not a path), spawns checks, and RETURNS a
// result. It NEVER calls process.exit — only the CLI `main` block does.

import { spawn } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import { dirname, resolve, isAbsolute } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import yaml from 'js-yaml'

// ---------------------------------------------------------------------------
// Config loading — the ONLY YAML-touching code.
// ---------------------------------------------------------------------------
export function loadConfig(path) {
  const abs = isAbsolute(path) ? path : resolve(process.cwd(), path)
  const raw = readFileSync(abs, 'utf8')
  // JSON_SCHEMA restricts parsing to plain JSON types (no custom/!!js tags),
  // so a hostile config can never construct arbitrary objects. The config is
  // pure data: maps, lists, strings, numbers, bools.
  const cfg = yaml.load(raw, { schema: yaml.JSON_SCHEMA })
  if (!cfg || typeof cfg !== 'object') {
    throw new Error(`quality config at ${abs} did not parse to an object`)
  }
  // Stamp the source dir so coverage-baseline resolution is relative to the
  // config (a repo's .devflow/), not to the runner's cwd.
  Object.defineProperty(cfg, '__dir', { value: dirname(abs), enumerable: false })
  return cfg
}

// ---------------------------------------------------------------------------
// Spawn a shell command; resolve to its exit code (and captured output).
// ---------------------------------------------------------------------------
function runCmd(cmd, cwd) {
  return new Promise((res) => {
    const child = spawn(cmd, {
      shell: true,
      cwd: cwd || process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => { out += d.toString() })
    child.stderr.on('data', (d) => { err += d.toString() })
    child.on('error', (e) => res({ code: 127, out, err: err + String(e && e.message || e) }))
    child.on('close', (code) => res({ code: code == null ? 1 : code, out, err }))
  })
}

// Pull the first numeric (optionally decimal) token out of a coverage
// command's stdout — e.g. "TOTAL ... 87%" or "coverage: 87.4".
function parsePct(text) {
  const m = String(text).match(/(\d+(?:\.\d+)?)\s*%?/)
  return m ? Number(m[1]) : null
}

// Read the no_decrease baseline relative to the config dir. Returns a number
// (the baseline line-pct) or null when there is nothing to ratchet against.
function readBaseline(cfgDir) {
  const dir = cfgDir || process.cwd()
  const file = resolve(dir, 'coverage-baseline.json')
  if (!existsSync(file)) return null
  const raw = readFileSync(file, 'utf8').trim()
  try {
    const j = JSON.parse(raw)
    if (typeof j === 'number') return j
    if (j && typeof j.line === 'number') return j.line
    if (j && typeof j.min_line === 'number') return j.min_line
  } catch {
    // plaintext percentage fallback
  }
  return parsePct(raw)
}

// ---------------------------------------------------------------------------
// Core: run the profile, return a result. NO process.exit in here.
//   result = {
//     ok: boolean,
//     rows: [{ name, type, status:'PASS'|'FAIL'|'SKIP', detail }],
//     failed: [name, ...],        // required/active checks that failed
//     coverage: { measured, min_line, baseline, status } | null,
//   }
// opts = { stacks: string[]|Set, coverage?: number }
// ---------------------------------------------------------------------------
export async function runQuality(config, opts = {}) {
  const cfg = config || {}
  const cfgDir = cfg.__dir || process.cwd()
  const stackList = opts.stacks instanceof Set
    ? opts.stacks
    : new Set(Array.isArray(opts.stacks) ? opts.stacks : (opts.stacks ? [opts.stacks] : []))

  const rows = []
  const failed = []

  // --- required: always run --------------------------------------------------
  const required = cfg.required && typeof cfg.required === 'object' ? cfg.required : {}
  for (const [name, spec] of Object.entries(required)) {
    if (!spec || !spec.cmd) {
      rows.push({ name, type: 'required', status: 'FAIL', detail: 'no cmd defined' })
      failed.push(name)
      continue
    }
    const { code, err } = await runCmd(spec.cmd, cfgDir)
    if (code === 0) {
      rows.push({ name, type: 'required', status: 'PASS', detail: spec.cmd })
    } else {
      rows.push({ name, type: 'required', status: 'FAIL', detail: `exit ${code}${err ? ' — ' + err.trim().split('\n').pop() : ''}` })
      failed.push(name)
    }
  }

  // --- conditional: run only blocks whose `when` flag is active --------------
  const conditional = Array.isArray(cfg.conditional) ? cfg.conditional : []
  for (const block of conditional) {
    if (!block || typeof block !== 'object') continue
    const when = block.when
    const active = stackList.has(when)
    for (const [key, spec] of Object.entries(block)) {
      if (key === 'when') continue
      const label = `${key} (when:${when})`
      if (!active) {
        rows.push({ name: label, type: 'conditional', status: 'SKIP', detail: `${when} not active` })
        continue
      }
      if (!spec || !spec.cmd) {
        rows.push({ name: label, type: 'conditional', status: 'FAIL', detail: 'no cmd defined' })
        failed.push(label)
        continue
      }
      const { code, err } = await runCmd(spec.cmd, cfgDir)
      if (code === 0) {
        rows.push({ name: label, type: 'conditional', status: 'PASS', detail: spec.cmd })
      } else {
        rows.push({ name: label, type: 'conditional', status: 'FAIL', detail: `exit ${code}${err ? ' — ' + err.trim().split('\n').pop() : ''}` })
        failed.push(label)
      }
    }
  }

  // --- coverage: floor + optional no-decrease ratchet -----------------------
  let coverage = null
  const cov = cfg.coverage && typeof cfg.coverage === 'object' ? cfg.coverage : null
  if (cov) {
    const minLine = typeof cov.min_line === 'number' ? cov.min_line : null
    // measured: injected via opts.coverage, else run cov.cmd and parse stdout.
    let measured = typeof opts.coverage === 'number' ? opts.coverage : null
    let covDetail = ''
    if (measured == null && cov.cmd) {
      const { code, out, err } = await runCmd(cov.cmd, cfgDir)
      if (code !== 0) {
        coverage = { measured: null, min_line: minLine, baseline: null, status: 'FAIL' }
        rows.push({ name: 'coverage', type: 'coverage', status: 'FAIL', detail: `coverage cmd exit ${code}${err ? ' — ' + err.trim().split('\n').pop() : ''}` })
        failed.push('coverage')
      } else {
        measured = parsePct(out)
        covDetail = `from cmd stdout`
      }
    } else if (measured != null) {
      covDetail = `injected --coverage`
    }

    if (coverage == null) {
      const baseline = cov.no_decrease ? readBaseline(cfgDir) : null
      let status = 'PASS'
      const reasons = []
      if (measured == null) {
        status = 'FAIL'
        reasons.push('no coverage measurement available')
      } else {
        if (minLine != null && measured < minLine) {
          status = 'FAIL'
          reasons.push(`${measured}% < min_line ${minLine}%`)
        }
        if (baseline != null && measured < baseline) {
          status = 'FAIL'
          reasons.push(`${measured}% < baseline ${baseline}% (no_decrease)`)
        }
      }
      coverage = { measured, min_line: minLine, baseline, status }
      const okBits = []
      if (measured != null) okBits.push(`${measured}%`)
      if (minLine != null) okBits.push(`floor ${minLine}%`)
      if (baseline != null) okBits.push(`baseline ${baseline}%`)
      rows.push({
        name: 'coverage',
        type: 'coverage',
        status,
        detail: status === 'PASS' ? `${okBits.join(', ')} ${covDetail}`.trim() : reasons.join('; '),
      })
      if (status === 'FAIL') failed.push('coverage')
    }
  }

  const ok = failed.length === 0
  return { ok, rows, failed, coverage }
}

// ---------------------------------------------------------------------------
// Pretty PASS/FAIL table for the CLI.
// ---------------------------------------------------------------------------
export function renderTable(result) {
  const rows = result.rows || []
  const wName = Math.max(5, ...rows.map((r) => r.name.length))
  const wType = Math.max(4, ...rows.map((r) => r.type.length))
  const wStat = 6
  const head = `${'CHECK'.padEnd(wName)}  ${'TYPE'.padEnd(wType)}  ${'STATUS'.padEnd(wStat)}  DETAIL`
  const sep = '-'.repeat(head.length)
  const lines = [head, sep]
  for (const r of rows) {
    lines.push(`${r.name.padEnd(wName)}  ${r.type.padEnd(wType)}  ${r.status.padEnd(wStat)}  ${r.detail || ''}`)
  }
  lines.push(sep)
  const passed = rows.filter((r) => r.status === 'PASS').length
  const skipped = rows.filter((r) => r.status === 'SKIP').length
  lines.push(`${result.ok ? 'PASS' : 'FAIL'}  —  ${passed} passed, ${result.failed.length} failed, ${skipped} skipped`)
  if (!result.ok) lines.push(`failing checks: ${result.failed.join(', ')}`)
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// CLI arg parsing.
// ---------------------------------------------------------------------------
export function parseArgs(argv) {
  const out = { stacks: [], coverage: undefined, config: undefined }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--stack') {
      const v = argv[++i]
      if (v) out.stacks.push(...v.split(',').map((s) => s.trim()).filter(Boolean))
    } else if (a.startsWith('--stack=')) {
      out.stacks.push(...a.slice('--stack='.length).split(',').map((s) => s.trim()).filter(Boolean))
    } else if (a === '--coverage') {
      out.coverage = Number(argv[++i])
    } else if (a.startsWith('--coverage=')) {
      out.coverage = Number(a.slice('--coverage='.length))
    } else if (a === '--config') {
      out.config = argv[++i]
    } else if (a.startsWith('--config=')) {
      out.config = a.slice('--config='.length)
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// CLI main — the ONLY place that touches files-by-path and process.exit.
// ---------------------------------------------------------------------------
async function main() {
  const args = parseArgs(process.argv.slice(2))
  const __dirname = dirname(fileURLToPath(import.meta.url))
  const configPath = args.config || resolve(__dirname, '..', '.devflow', 'quality.yml')
  if (!existsSync(configPath)) {
    console.error(`quality config not found: ${configPath}`)
    console.error(`(provide one with --config, or drop a .devflow/quality.yml — see .devflow/quality.example.yml)`)
    process.exit(2)
  }
  let cfg
  try {
    cfg = loadConfig(configPath)
  } catch (e) {
    console.error(`failed to parse quality config: ${e && e.message || e}`)
    process.exit(2)
  }
  const opts = {
    stacks: args.stacks,
    coverage: Number.isFinite(args.coverage) ? args.coverage : undefined,
  }
  const result = await runQuality(cfg, opts)
  console.log(renderTable(result))
  process.exit(result.ok ? 0 : 1)
}

// Only run the CLI when executed directly (not when imported by the selftest).
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main()
}
