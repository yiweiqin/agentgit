import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { computeImpactReport, ensureWorkspace, impactInputStamp, publishImpactProjection, recordImpactChange, recordImpactSession, recordAssumption, seenMarkerName, type WorkspacePaths } from '@agentgit/core'

const repo = join(import.meta.dirname, '../../..')
const hook = join(repo, 'plugins/agentgit/scripts/hub.mjs')
const cli = join(repo, 'packages/cli/src/main.ts')
let paths: WorkspacePaths
beforeEach(() => { paths = ensureWorkspace(mkdtempSync(join(tmpdir(), 'agentgit-impact-hook-'))) })
afterEach(() => rmSync(paths.root, { recursive: true, force: true }))
function fixture(compatibility = 'breaking') {
  recordImpactSession(paths, { goal: 'write caller', contracts: [{ name: 'auth', version: 1 }] }, { sessionId: 'b', taskId: 'tb' })
  recordImpactChange(paths, { stream: 'auth', revision: 1, summary: 'Return type changed',
    contracts: [{ name: 'auth', version: 2, breaking: compatibility === 'breaking' }] }, { sessionId: 'a', taskId: 'ta' })
  publishImpactProjection(paths)
}
function runHook(event: string, session = 'b') {
  const result = spawnSync(process.execPath, [hook], { encoding: 'utf8', cwd: paths.root,
    input: JSON.stringify({ hook_event_name: event, session_id: session, cwd: paths.root }) })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout
}

test('urgent evidence reaches only the affected session, at a boundary, once', () => {
  fixture()
  assert.equal(runHook('PreToolUse', 'unrelated'), '')
  assert.match(runHook('PreToolUse'), /breaking_dependency/)
  assert.equal(runHook('PostToolUse'), '')
  assert.equal(computeImpactReport(paths).notifications[0].status, 'delivered')
})

test('deferred changes wait for a completed tool; unknown events never deliver', () => {
  fixture('compatible')
  assert.equal(runHook('PreToolUse'), '')
  assert.equal(runHook('DuringToolUse'), '')
  assert.match(runHook('PostToolUse'), /soft_relevance/)
  assert.equal(runHook('UserPromptSubmit'), '')
})

test('expired projections and corrupt inboxes are silent, with no broadcast fallback', () => {
  fixture()
  const file = join(paths.state, 'impact-inbox', seenMarkerName('b'))
  const inbox = JSON.parse(readFileSync(file, 'utf8'))
  writeFileSync(file, JSON.stringify({ ...inbox, expiresAt: '2000-01-01T00:00:00Z' }))
  assert.equal(runHook('SessionStart'), '')
  writeFileSync(file, '{broken')
  assert.equal(runHook('SessionStart'), '')
})

test('delivery rechecks recipient adaptation and producer supersession before trusting a cache', () => {
  fixture()
  const stamp = impactInputStamp(paths)
  recordAssumption(paths, { taskId: 'tb', sessionId: 'b', contract: 'auth', version: 2, source: 'declared', path: null, recordedAt: new Date().toISOString() })
  assert.notEqual(impactInputStamp(paths), stamp)
  assert.equal(runHook('PostToolUse'), '')
  publishImpactProjection(paths)
  assert.equal(runHook('PostToolUse'), '')
})

test('superseded source revisions invalidate an inbox before the next daemon poll', () => {
  fixture()
  recordImpactChange(paths, { stream: 'auth', revision: 2, summary: 'Change withdrawn', status: 'cancelled',
    contracts: [{ name: 'auth', version: 2, breaking: true }] }, { sessionId: 'a', taskId: 'ta' })
  assert.equal(runHook('PostToolUse'), '')
  publishImpactProjection(paths)
  assert.equal(runHook('UserPromptSubmit'), '')
})

test('only emitted notifications get receipts when the context budget is full', () => {
  fixture()
  const file = join(paths.state, 'impact-inbox', seenMarkerName('b'))
  const inbox = JSON.parse(readFileSync(file, 'utf8'))
  const first = { ...inbox.notifications[0], text: 'first '.repeat(200) }
  const second = { ...first, id: `impact-${'a'.repeat(24)}`, text: 'second '.repeat(170) }
  writeFileSync(file, JSON.stringify({ ...inbox, notifications: [first, second] }))
  assert.match(runHook('PostToolUse'), /first/)
  assert.match(runHook('PostToolUse'), /second/)
  assert.equal(runHook('PostToolUse'), '')
})

test('CLI state -> publish -> inbox -> ack works through JSON files', () => {
  const run = (args: string[]) => {
    const result = spawnSync(process.execPath, [cli, 'impact', ...args, '--workspace', paths.root, '--json'], { encoding: 'utf8', cwd: paths.root })
    assert.equal(result.status, 0, result.stderr)
    return JSON.parse(result.stdout)
  }
  const stateFile = join(paths.root, 'consumer.json')
  const changeFile = join(paths.root, 'producer.json')
  writeFileSync(stateFile, JSON.stringify({ contracts: [{ name: 'auth', version: 1 }] }))
  writeFileSync(changeFile, JSON.stringify({ stream: 'auth', revision: 1, summary: 'new return type', contracts: [{ name: 'auth', version: 2, breaking: true }] }))
  run(['state', '--session', 'b', '--file', stateFile])
  run(['publish', '--session', 'a', '--file', changeFile])
  const inbox = run(['inbox', '--session', 'b'])
  assert.equal(inbox.notifications.length, 1)
  assert.equal(inbox.notifications[0].category, 'breaking_dependency')
  run(['ack', inbox.notifications[0].id, '--session', 'b'])
  assert.equal(run(['inbox', '--session', 'b']).notifications[0].status, 'acknowledged')
})
