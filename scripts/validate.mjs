#!/usr/bin/env node
// devflow contract validator.
//
// Makes the JSON Schemas in ../schemas/ actually enforced. Compiles a schema
// with Ajv (draft 2020-12 build, allErrors + ajv-formats), resolves any
// cross-$ref between the sibling schema files (e.g. task.schema.json ->
// acceptance.schema.json), validates a document, prints errors, and exits 1 on
// invalid / 0 on valid.
//
// CLI:   node scripts/validate.mjs <schema-path> <doc-path|->
//   <doc-path> of "-" (or omitted) reads the document JSON from stdin.
//
// Library: import { validateDoc } from './scripts/validate.mjs'
//   validateDoc(schemaObj, doc) -> { valid: boolean, errors: object[] }

import Ajv2020 from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve, basename } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SCHEMA_DIR = resolve(__dirname, '..', 'schemas')

// Build an Ajv instance with every sibling schema preloaded so that any
// cross-$ref (resolved by $id or by relative filename against the entry
// schema's $id base) is satisfiable. We add schemas by both their declared
// $id and their bare filename to cover relative-path refs.
function buildAjv() {
  const ajv = new Ajv2020({ allErrors: true, strict: false })
  addFormats(ajv)

  let files = []
  try {
    files = readdirSync(SCHEMA_DIR).filter((f) => f.endsWith('.schema.json'))
  } catch {
    files = []
  }

  for (const f of files) {
    let obj
    try {
      obj = JSON.parse(readFileSync(join(SCHEMA_DIR, f), 'utf8'))
    } catch {
      continue
    }
    // Register under the declared $id (preferred resolution key).
    if (obj && typeof obj.$id === 'string' && !ajv.getSchema(obj.$id)) {
      ajv.addSchema(obj, obj.$id)
    }
    // Also register under the bare filename so relative refs like
    // "acceptance.schema.json" resolve even if base resolution differs.
    const fname = basename(f)
    if (!ajv.getSchema(fname)) {
      // Clone without $id to avoid a duplicate-$id collision in Ajv.
      const { $id, ...rest } = obj || {}
      ajv.addSchema(rest, fname)
    }
  }
  return ajv
}

// Compile a specific schema object against the shared Ajv (with siblings loaded
// for ref resolution). If the schema carries a $id already registered, reuse the
// compiled validator; otherwise compile it directly.
function compileFor(ajv, schemaObj) {
  if (schemaObj && typeof schemaObj.$id === 'string') {
    const existing = ajv.getSchema(schemaObj.$id)
    if (existing) return existing
  }
  return ajv.compile(schemaObj)
}

/**
 * Validate a document against a schema object, resolving cross-$refs to the
 * sibling schemas in ../schemas/.
 * @param {object} schemaObj  parsed JSON Schema (the entry schema)
 * @param {*} doc             parsed document to validate
 * @returns {{valid: boolean, errors: object[]}}
 */
export function validateDoc(schemaObj, doc) {
  const ajv = buildAjv()
  // Ensure the entry schema participates in ref resolution too. If it shares an
  // $id with a preloaded sibling, compileFor reuses that compiled instance.
  const validate = compileFor(ajv, schemaObj)
  const valid = !!validate(doc)
  return { valid, errors: valid ? [] : (validate.errors || []) }
}

function readStdin() {
  try {
    return readFileSync(0, 'utf8')
  } catch {
    return ''
  }
}

function main(argv) {
  const [schemaPath, docPathArg] = argv
  if (!schemaPath) {
    process.stderr.write(
      'usage: node scripts/validate.mjs <schema-path> <doc-path|->\n'
    )
    return 2
  }

  let schemaObj
  try {
    schemaObj = JSON.parse(readFileSync(resolve(schemaPath), 'utf8'))
  } catch (e) {
    process.stderr.write(`error: cannot read/parse schema ${schemaPath}: ${e.message}\n`)
    return 2
  }

  let rawDoc
  const fromStdin = !docPathArg || docPathArg === '-'
  try {
    rawDoc = fromStdin ? readStdin() : readFileSync(resolve(docPathArg), 'utf8')
  } catch (e) {
    process.stderr.write(`error: cannot read doc ${fromStdin ? '<stdin>' : docPathArg}: ${e.message}\n`)
    return 2
  }

  let doc
  try {
    doc = JSON.parse(rawDoc)
  } catch (e) {
    process.stderr.write(`error: doc is not valid JSON: ${e.message}\n`)
    return 2
  }

  let result
  try {
    result = validateDoc(schemaObj, doc)
  } catch (e) {
    // Schema-compilation failures (bad schema, unresolved $ref) land here.
    process.stderr.write(`error: schema compilation failed: ${e.message}\n`)
    return 2
  }

  const label = `${basename(schemaPath)} <- ${fromStdin ? '<stdin>' : basename(docPathArg)}`
  if (result.valid) {
    process.stdout.write(`VALID: ${label}\n`)
    return 0
  }

  process.stderr.write(`INVALID: ${label}\n`)
  for (const err of result.errors) {
    const where = err.instancePath || '(root)'
    process.stderr.write(`  ${where} ${err.message}` +
      (err.params && Object.keys(err.params).length
        ? ` ${JSON.stringify(err.params)}`
        : '') + '\n')
  }
  return 1
}

// Run as CLI only when invoked directly (not when imported).
const invokedDirectly =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invokedDirectly) {
  process.exit(main(process.argv.slice(2)))
}
