import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appendEvent, buildEvent, configureChecks, readChecks, ensureWorkspace, type WorkspacePaths } from '@agentgit/core'
import { createChecksDispatcher } from '../src/checks.ts'
import { startBoard } from '../src/serve.ts'

let root: string
let paths: WorkspacePaths
const coordinator = '11111111-1111-4111-8111-111111111111'
const target = '22222222-2222-4222-8222-222222222222'
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'agentgit-dispatch-'))
  paths = ensureWorkspace(root)
  configureChecks(paths, coordinator, process.execPath)
  writeFileSync(join(paths.state, 'hub.json'), JSON.stringify({ version: 1, id: 'hub-test', generatedAt: new Date().toISOString(), workspace: root, authority: 'advisory', targets: ['a.ts'], advisory: 'test', holders: [], integration: [], metrics: {}, parallelism: {}, stale: [], rulings: [{ entityKey: 'file::a.ts', word: 'reuse', sessions: [target], path: 'a.ts', intents: ['same work'], owner: { taskId: coordinator } }] }))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))
test('a new conflict wakes only the coordinator, once across ticks and restarts', async () => {
  const calls: string[][] = []
  const send = async (...args: string[]) => { calls.push(args) }
  const dispatcher = createChecksDispatcher(send)
  await dispatcher.tick(paths)
  await dispatcher.tick(paths)
  await createChecksDispatcher(send).tick(paths)
  assert.equal(calls.length, 1)
  assert.equal(calls[0][1], coordinator)
  assert.match(calls[0][2], /coordinate.md/)
  assert.equal(readChecks(paths).wake?.status, 'queued')
})
test('queue rejection is saved as failure rather than delivery', async () => {
  await createChecksDispatcher(async () => { throw new Error('Codex offline') }).tick(paths)
  assert.equal(readChecks(paths).wake?.status, 'failed')
  assert.match(readChecks(paths).wake?.error ?? '', /offline/)
})
test('overlapping ticks do not dispatch twice', async () => {
  let release!: () => void
  let calls = 0
  const dispatcher = createChecksDispatcher(async () => { calls++; await new Promise<void>(r => { release = r }) })
  const first = dispatcher.tick(paths)
  await dispatcher.tick(paths)
  assert.equal(calls, 1)
  release(); await first
})
test('the actual daemon timer discovers ledger changes and records a rejected transport', async () => {
  // The configured executable is Node, not Codex. It rejects `queue`; no real chat is touched.
  const board = await startBoard({ roots: [root], port: 0, quiet: true, watch: false, intervalMs: 25 })
  try {
    const now = new Date()
    for (const sessionId of [coordinator, target]) appendEvent(paths, buildEvent({
      kind: 'file_write', timestampUtc: now.toISOString(), sessionId, taskId: sessionId,
      entities: [{ kind: 'file', identifier: 'timer.ts', path: 'timer.ts' }], intentText: 'implement timer',
    }), now)
    const deadline = Date.now() + 5000
    while (!readChecks(paths).wake && Date.now() < deadline) await new Promise(r => setTimeout(r, 25))
    assert.equal(readChecks(paths).jobs[0]?.entity, 'file::timer.ts')
    assert.equal(readChecks(paths).wake?.status, 'failed')
  } finally { await board.close() }
})
