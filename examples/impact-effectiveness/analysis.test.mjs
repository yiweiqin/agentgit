import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { analyze } from './analyze.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const results = process.env.IMPACT_RESULTS ? resolve(process.env.IMPACT_RESULTS) : join(here, 'results')
const read = name => JSON.parse(readFileSync(join(results, name), 'utf8'))
const manifest = read('manifest.json')
const plan = read('plan.json')
const truth = read('oracle.json')
const original = readFileSync(join(results, 'trials.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
const run = rows => analyze(plan, truth, rows, { smoke: manifest.smoke })

test('saved results are reproducible from every raw trace and executable oracle', () => {
  assert.deepEqual(run(original), read('summary.json'))
})

test('dropping an entire unfavorable pair cannot silently improve the denominator', () => {
  assert.throws(() => run(original.filter(row => row.pairId !== original[0].pairId)), /No planned pair/)
})

test('a missing arm or duplicate trial is an instrumentation failure', () => {
  assert.throws(() => run(original.slice(1)), /Every pair/)
  assert.throws(() => run([...original, original[0]]), /Duplicate pair/)
})

test('rewrites cannot be invented independently of actual write hashes', () => {
  const rows = structuredClone(original)
  rows[0].metrics.rewrites++
  assert.throws(() => run(rows), /Rewrites must reconcile/)
  const more = structuredClone(original)
  const write = more[0].trace.find(event => event.kind === 'write')
  write.beforeHash = write.afterHash
  assert.throws(() => run(more), /No-op writes/)
})

test('final correctness cannot be asserted while the last independent check failed', () => {
  const rows = structuredClone(original)
  rows[0].finalPass = !rows[0].finalPass
  assert.throws(() => run(rows), assert.AssertionError)
})

test('a treatment cannot finish with a different artifact and claim equal quality', () => {
  const rows = structuredClone(original)
  rows.find(row => row.arm === 'targeted').finalFiles['consumers/web.mjs'] = 'changed-after-validation'
  assert.throws(() => run(rows), /same actual artifacts/)
})

test('a delivered notification cannot be removed from the reading-cost metric', () => {
  const rows = structuredClone(original)
  const row = rows.find(row => row.metrics.reviews > 0)
  assert.ok(row)
  row.metrics.reviews--
  assert.throws(() => run(rows), assert.AssertionError)
})
