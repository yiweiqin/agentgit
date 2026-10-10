import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { codeFingerprint } from '../src/code-duplicates.ts'
import { buildEvent } from '../src/ledger.ts'
import { appendEvent, ensureWorkspace } from '../src/workspace.ts'
import { computeHubVerdict, hubVerdictId } from '../src/hub.ts'
import { configureChecks, syncChecks } from '../src/checks.ts'

const a = 'export function totalOrders(items: number[]) { const result = items.filter(item => item > 0).map(item => item * 0.9); return result.reduce((sum, item) => sum + item, 0) }'
const b = 'export function sumPurchases(values: number[]) { const output = values.filter(value => value > 0).map(value => value * 0.9); return output.reduce((acc, value) => acc + value, 0) }'

test('renaming preserves evidence, but changed literals, APIs and bindings do not', () => {
  assert.ok(codeFingerprint(a))
  assert.equal(codeFingerprint(a), codeFingerprint('// renamed\n' + b))
  for (const different of [b.replace('0.9', '0.8'), b.replace('.filter', '.find'), b.replace('acc + value', 'value + value')]) {
    assert.notEqual(codeFingerprint(a), codeFingerprint(different))
  }
  assert.equal(codeFingerprint('const a = 1'), null)
  assert.equal(codeFingerprint('const a = `template`'), null)
})

test('different intents and an additional shared file still route code evidence to both windows', () => {
  const root = mkdtempSync(join(tmpdir(), 'agentgit-code-'))
  try {
    const paths = ensureWorkspace(root), now = new Date()
    const tasks = ['22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333']
    configureChecks(paths, '11111111-1111-4111-8111-111111111111', process.execPath)
    writeFileSync(join(paths.state, 'impact-protocol.json'), '{"version":1}')
    for (const [i, code] of [a, b].entries()) {
      const path = `${i}.ts`
      writeFileSync(join(root, path), code)
      appendEvent(paths, buildEvent({ kind: 'file_write', sessionId: tasks[i], taskId: tasks[i], timestampUtc: now.toISOString(),
        entities: [{ kind: 'file', identifier: path, path }, { kind: i ? 'file' : 'symbol', identifier: i ? 'shared.ts' : 'discountA', path: 'shared.ts' }], intentText: i ? 'purchase aggregation' : 'discount implementation' }))
    }
    const hub = computeHubVerdict(paths, now)
    assert.equal(hub.duplicateWork[0].basis, 'code-structure')
    assert.notEqual(hubVerdictId(hub), hubVerdictId({ ...hub, duplicateWork: [] }))
    const jobs = syncChecks(paths, hub, now).jobs.filter(j => j.verdict === 'duplicate-code')
    assert.deepEqual(jobs.map(j => j.target).sort(), tasks)
    assert.equal(syncChecks(paths, hub, now).jobs.filter(j => j.verdict === 'duplicate-code').length, jobs.length)
    assert.equal(syncChecks(paths, hub, now).jobs.filter(j => j.verdict === 'same-file').length, 2)
    writeFileSync(join(root, '1.ts'), b.replace('0.9', '0.8'))
    assert.equal(computeHubVerdict(paths, now).duplicateWork.length, 0)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
