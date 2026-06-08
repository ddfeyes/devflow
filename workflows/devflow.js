export const meta = {
  name: 'devflow-fanout',
  description: 'Stateless fan-out engine for devflow. mode:"recon" spawns parallel read-only scouts that cut one context_pack.md per subsystem/task from graphify + codebase-memory + codebase-search, grounded against context7 live docs. mode:"verify" spawns a BLIND adversarial release panel (>=2 verifiers + 1 completeness critic, +chrome-devtools runtime checks for web targets) that judges committed work it never wrote. Read/verify only: never writes feature code, never does git integration. Stateful execution (implement/test/integrate) runs on Agent Teams .coord, NOT here.',
  phases: [
    { title: 'recon' },
    { title: 'verify' },
  ],
}

// ---------------------------------------------------------------------------
// devflow.js v2 — the fan-out HALF of devflow only. The /devflow command is the
// top orchestrator; it calls this twice (mode:recon, then mode:verify) and runs
// the stateful middle (implement/test/integrate) on Agent Teams .coord. This
// script does pure deterministic fan-out + schema gates; all FS/git/MCP I/O is
// inside the agents. Constraints: JS not TS; no wall-clock or RNG runtime calls
// anywhere in this text; parallel() = barrier; .filter(Boolean) before aggregate.
// ---------------------------------------------------------------------------

const A = (args && typeof args === 'object') ? args : {}
const MODE = A.mode || 'recon'
const RID = A.runId || '<run>'
const EPIC_ID = A.epicId || A.epicSlug || RID   // stable id for .coord/epics/<EPIC_ID>/ paths
const EPIC = A.epic || ''
const PANEL = A.panel || 2          // blind verifiers per task; risk-zone -> +1
const TASKS = Array.isArray(A.tasks) ? A.tasks : []

const GUARD = `THIS lane is READ + VERIFY ONLY: it never deploys, never merges, never integrates, never writes feature code — deployment/integration happens in other phases, not here. If any of the following IRREVERSIBLE operations would be required to proceed, do NOT do them — instead STOP, write .coord/epics/${EPIC_ID}/BLOCKED.md, and return a blocked/fail verdict for THIS item only: rotate creds or read plaintext secrets; force-push / history rewrite / branch delete; delete data / drop DB / prod migrations; enable a non-gateio exchange; disable a killswitch; ambiguous money-path or auth semantics; missing required creds. Never guess live numbers (gas/prices/balances/latency) — query the live system or stop.`

const lane = (role, label) => `You are the **${role}** for devflow run ${RID}. cwd is the target git repo. Do NOT append to any shared file. Write your OWN single-object event file at .coord/runs/${RID}/events/${label}.json containing exactly { "label": "${label}", "role": "${role}", "note": "<one line on what you did>" } (omit any seq field — the orchestrator merges every events/*.json into journal.ndjson later and assigns seq then). No two agents share a write path. ${GUARD}`

// ---- schemas (flat for reliable StructuredOutput) --------------------------
const PACK = {
  type: 'object', additionalProperties: false,
  required: ['item', 'ok', 'files', 'godNodes', 'notes'],
  properties: {
    item: { type: 'string', description: 'subsystem or task id this pack covers' },
    ok: { type: 'boolean', description: 'false if no real files could be cited' },
    files: { type: 'array', items: { type: 'string' }, description: 'concrete repo-relative files in scope' },
    godNodes: { type: 'array', items: { type: 'string' }, description: 'high-degree nodes from graphify in the blast radius' },
    notes: { type: 'string', description: 'call paths, semantic seeds, risk flags, context7 docs consulted' },
  },
}
const VERDICT = {
  type: 'object', additionalProperties: false,
  required: ['task', 'lens', 'pass', 'reason', 'evidence'],
  properties: {
    task: { type: 'string' },
    lens: { type: 'string', description: 'correctness | runtime | completeness' },
    pass: { type: 'boolean' },
    reason: { type: 'string' },
    evidence: { type: 'array', items: { type: 'string' }, description: 'commands run + observed output, file:line' },
  },
}

// ===========================================================================
if (MODE === 'recon') {
  phase('recon')
  log(`devflow recon: ${TASKS.length || 'subsystem'} scout(s) for "${EPIC.slice(0, 90)}"`)
  const units = TASKS.length ? TASKS : [{ id: 'epic', intent: EPIC }]
  const raw = await parallel(units.map((u) => () => {
    const label = `scout:${u.id}`
    return agent(
      `${lane('Scout/Recon (read-only)', label)}
EPIC: ${EPIC}
SCOPE: ${u.id} — ${u.intent || ''} ${u.ownedPaths ? `owned paths: ${JSON.stringify(u.ownedPaths)}` : ''}
Cut ONE context_pack.md for this scope: god-nodes + community (graphify GRAPH_REPORT / get_architecture), traced call paths + blast radius (codebase-memory trace_call_path), semantic seeds (codebase-search), durable memory/*.md facts, and the concrete owned files. For any external library/SDK/API in scope, pull current usage from the context7 MCP (resolve-library-id -> query-docs) and cite it — do NOT rely on training-data memory of the API. Do NOT read whole trees. Write .coord/epics/${EPIC_ID}/context/${u.id}/context_pack.md. Set PACK.item EXACTLY to "${u.id}" (it is matched against the requested scope id — any mismatch counts the unit as MISSING). Return PACK.`,
      { label, phase: 'recon', schema: PACK })
  }))
  const packs = raw.filter(Boolean)                         // null = failed/skipped scout
  const byId = new Map(packs.map(p => [p.item, p]))         // pack.item -> pack
  const missing = units.filter(u => !byId.has(u.id)).map(u => u.id)   // null returns AND id mismatch
  const empty = packs.filter(p => !p.ok || !Array.isArray(p.files) || p.files.length === 0).map(p => p.item)
  return {
    mode: 'recon', runId: RID,
    ok: units.length > 0 && missing.length === 0 && empty.length === 0,
    missing,
    empty,
    packs: packs.map(p => ({ item: p.item, files: p.files, godNodes: p.godNodes })),
  }
}

// ===========================================================================
if (MODE === 'verify') {
  phase('verify')
  if (!TASKS.length) return { mode: 'verify', runId: RID, ok: false, reason: 'no tasks passed to verify' }
  log(`devflow verify: adversarial panel over ${TASKS.length} task(s)`)

  const judge = (t) => {
    const n = t.riskZone ? PANEL + 1 : PANEL
    const at = t.sha ? `committed sha ${t.sha}` : `HEAD of ${t.branch}`
    const expectedVotes = n + 1 + (t.web ? 1 : 0)
    const blind = Array.from({ length: n }, (_u, i) => () => {
      const label = `verify:${t.id}#${i + 1}`
      return agent(
        `${lane(`Verifier-${i + 1} (BLIND, independent)`, label)}
TASK ${t.id}: ${t.intent}
Acceptance: ${JSON.stringify(t.acceptance || [])}.
VERIFY lane: you may NOT edit code and must NOT read the implementer's handoff prose. Check out ${at} in a SEPARATE worktree, build it, run the relevant suite yourself, and judge whether acceptance is OBJECTIVELY met. Where the code calls an external API/SDK, confirm the usage against context7 live docs (resolve-library-id -> query-docs) — flag stale/wrong API calls. Default pass:false if anything is unproven. Write your verdict to its OWN file .coord/epics/${EPIC_ID}/verify/${t.id}/correctness-${i + 1}.json (do NOT append to any shared report). lens="correctness". Populate evidence[] with the commands you ran + observed output (file:line); an empty evidence[] is treated as a FAIL. Return VERDICT.`,
        { label, phase: 'verify', schema: VERDICT })
    })
    const critic = () => {
      const label = `critic:${t.id}`
      return agent(
        `${lane('Completeness critic', label)}
TASK ${t.id} intent: ${t.intent}. Compare epic intent to the actual diff on ${t.branch}. Confirm NOTHING in scope was silently dropped/stubbed/faked. Write your verdict to its OWN file .coord/epics/${EPIC_ID}/verify/${t.id}/completeness-1.json (do NOT append to any shared report). lens="completeness". Populate evidence[] (empty evidence[] is treated as a FAIL). Return VERDICT (pass:false if any acceptance item is missing).`,
        { label, phase: 'verify', schema: VERDICT })
    }
    const runtime = t.web ? [() => {
      const label = `runtime:${t.id}`
      return agent(
        `${lane('Runtime verifier (web)', label)}
TASK ${t.id}: ${t.intent}. Build & serve the app from ${at}, then drive the ACTUAL UI with the chrome-devtools MCP: navigate the affected pages, assert zero uncaught console errors, check the relevant network requests succeed, and run a lighthouse pass if a route changed. Write your verdict to its OWN file .coord/epics/${EPIC_ID}/verify/${t.id}/runtime-1.json (do NOT append to any shared report). lens="runtime". Populate evidence[] (empty evidence[] is treated as a FAIL). Return VERDICT (pass:false on any console error / failed request / broken flow tied to this task).`,
        { label, phase: 'verify', schema: VERDICT })
    }] : []
    return parallel([...blind, critic, ...runtime]).then(rs => {
      const v = rs.filter(Boolean)
      const byLens = v.reduce((m, x) => { m[x.lens] = (m[x.lens] || 0) + 1; return m }, {})
      const taskPass =
        v.length === expectedVotes &&
        byLens.correctness === n &&
        byLens.completeness === 1 &&
        (!t.web || byLens.runtime === 1) &&
        v.every(x => x.pass === true) &&
        v.every(x => Array.isArray(x.evidence) && x.evidence.length > 0)
      return {
        task: t.id,
        pass: taskPass,
        votes: v.map(x => ({ lens: x.lens, pass: x.pass })),
        missingVotes: expectedVotes - v.length,
        evidence: v.flatMap(x => x.evidence || []),
      }
    })
  }

  const verdicts = (await parallel(TASKS.map(t => () => judge(t)))).filter(Boolean)
  return {
    mode: 'verify', runId: RID,
    ok: verdicts.length === TASKS.length,
    pass: TASKS.length > 0 && verdicts.every(v => v.pass),
    verdicts,
    failed: verdicts.filter(v => !v.pass).map(v => ({
      task: v.task,
      reason: [
        v.missingVotes > 0 ? `${v.missingVotes} missing vote(s)` : null,
        v.votes.filter(x => !x.pass).map(x => `${x.lens}:fail`).join(', ') || null,
      ].filter(Boolean).join(' | ') || 'no evidence / lens coverage gap',
    })),
  }
}

return { ok: false, reason: `unknown mode "${MODE}" (expected recon|verify)` }
