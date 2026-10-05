import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { configureChecks, editChecks, readChecks, ensureWorkspace, recordImpactChange, recordImpactSession, type WorkspacePaths } from '@agentgit/core'
import { createChecksDispatcher, resolveCodexExecutable } from '../src/checks.ts'
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
test('a stale wake target is replaced by the newest Codex build beside it', () => {
  const home = mkdtempSync(join(tmpdir(), 'agentgit-codex-'))
  const bin = join(home, 'Codex', 'bin')
  const older = join(bin, 'aaaa', 'codex.exe')
  const newer = join(bin, 'bbbb', 'codex.exe')
  mkdirSync(dirname(older), { recursive: true })
  mkdirSync(dirname(newer), { recursive: true })
  writeFileSync(older, 'old')
  writeFileSync(newer, 'new')
  utimesSync(older, new Date('2020-01-01'), new Date('2020-01-01'))
  utimesSync(newer, new Date('2026-01-01'), new Date('2026-01-01'))
  try {
    // A recorded path that is still there wins, even though a newer build sits beside it.
    assert.equal(resolveCodexExecutable(older, { platform: 'win32', env: {} }), older)
    // A recorded path that a Codex update moved is replaced instead of failing every wake.
    assert.equal(resolveCodexExecutable(join(bin, 'gone', 'codex.exe'), { platform: 'win32', env: {} }), newer)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('a stale wake target falls back to the per-user install, then to nothing', () => {
  const home = mkdtempSync(join(tmpdir(), 'agentgit-codex-home-'))
  const found = join(home, 'OpenAI', 'Codex', 'bin', 'cccc', 'codex.exe')
  mkdirSync(dirname(found), { recursive: true })
  writeFileSync(found, 'x')
  try {
    assert.equal(resolveCodexExecutable('', { platform: 'win32', env: { LOCALAPPDATA: home } }), found)
    // Nothing recorded and nothing installed: null, so the dispatcher records a readable failure
    // rather than calling a path it invented.
    assert.equal(resolveCodexExecutable('', { platform: 'win32', env: {} }), null)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('a PATH install is found when no bin directory is known', () => {
  // The separator follows the platform, so this uses the Windows shape on Windows rather than
  // feeding a drive-letter colon into a POSIX split.
  const dir = mkdtempSync(join(tmpdir(), 'agentgit-codex-path-'))
  const file = join(dir, 'codex.exe')
  writeFileSync(file, 'x')
  try {
    assert.equal(resolveCodexExecutable('', { platform: 'win32', env: { PATH: dir } }), file)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a resolved stale path is written back before the wake is sent', async () => {
  const home = mkdtempSync(join(tmpdir(), 'agentgit-codex-writeback-'))
  const bin = join(home, 'Codex', 'bin')
  const real = join(bin, 'dddd', 'codex.exe')
  mkdirSync(dirname(real), { recursive: true })
  writeFileSync(real, 'x')
  const previous = process.env.LOCALAPPDATA
  try {
    // The recorded path is gone and no sibling exists, so the per-user fallback is the fix.
    editChecks(paths, state => { if (state.config) state.config.codex = join(bin, 'gone', 'codex.exe') })
    process.env.LOCALAPPDATA = home
    const calls: string[][] = []
    await createChecksDispatcher(async (...args: string[]) => { calls.push(args) }).tick(paths)
    assert.equal(calls.length, 1)
    assert.equal(calls[0][0], real, 'the wake used the resolved executable')
    assert.equal(readChecks(paths).config?.codex, real, 'and the fresh path was recorded for the next tick')
  } finally {
    if (previous === undefined) delete process.env.LOCALAPPDATA
    else process.env.LOCALAPPDATA = previous
    rmSync(home, { recursive: true, force: true })
  }
})

test('the actual daemon timer discovers ledger changes and records a rejected transport', async () => {
  // The configured executable is Node, not Codex. It rejects `queue`; no real chat is touched.
  const board = await startBoard({ roots: [root], port: 0, quiet: true, watch: false, intervalMs: 25 })
  try {
    const now = new Date()
    recordImpactSession(paths, { dependencies: [{ entity: 'file::timer.ts', relation: 'import' }] },
      { sessionId: target, taskId: target }, now)
    recordImpactChange(paths, { stream: 'timer', revision: 1, summary: 'Timer API changed', compatibility: 'breaking',
      entities: [{ key: 'file::timer.ts', access: 'write' }] }, { sessionId: coordinator, taskId: coordinator }, now)
    const deadline = Date.now() + 5000
    while (!readChecks(paths).wake && Date.now() < deadline) await new Promise(r => setTimeout(r, 25))
    assert.equal(readChecks(paths).jobs[0]?.entity, 'file::timer.ts')
    assert.equal(readChecks(paths).jobs[0]?.target, target)
    assert.equal(readChecks(paths).jobs[0]?.verdict, 'breaking_dependency')
    assert.equal(readChecks(paths).wake?.status, 'failed')
  } finally { await board.close() }
})
