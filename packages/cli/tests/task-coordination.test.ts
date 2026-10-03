/** Exercise shared task operations through both public entry points against real Git state. */
import { afterEach, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  acquireLease, appendEvent, buildBoardView, buildEvent, checkpointCommit,
  ensureWorkspace, headOid, loadLeases, publishContract, readAllEvents,
  recordAssumption, runGit, statusShort, type IntegrationItem, type StaleAssumption,
} from '@agentgit/core'
import { createServer, type Server } from '@agentgit/mcp'
import { createHubPublisher } from '@agentgit/daemon'
import { removeScratch } from './housekeeping.ts'

const CLI = join(import.meta.dirname, '../src/main.ts')
let root: string
let server: Server

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'agentgit-task-coordination-'))
  git('init', '-b', 'main')
  git('config', 'user.name', 'AgenticGit Test')
  git('config', 'user.email', 'test@example.com')
  git('config', 'commit.gpgsign', 'false')
  git('config', 'core.autocrlf', 'false')
  writeFileSync(join(root, 'shared.ts'), 'export const value = 0\n')
  git('add', 'shared.ts')
  git('commit', '-m', 'seed')
  ensureWorkspace(root)
  server = createServer({ workspace: root })
})

afterEach(() => removeScratch(root))

function git(...args: string[]): string {
  const result = runGit(args, root)
  assert.equal(result.ok, true, result.stderr)
  return result.stdout
}

function cli(...args: string[]) {
  const result = spawnSync(process.execPath, [CLI, ...args, '--workspace', root, '--session', 'cli-session'], {
    encoding: 'utf8',
  })
  assert.equal(result.error, undefined)
  return result
}

async function call<T>(name: string, args: Record<string, unknown>): Promise<T> {
  const response = await server.handle({
    jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: { name, arguments: { workspace: root, session: 'mcp-session', ...args } },
  })
  assert.ok(response && 'result' in response, JSON.stringify(response))
  const result = response.result as { isError?: boolean; structuredContent: T }
  assert.notEqual(result.isError, true, JSON.stringify(result))
  return result.structuredContent
}

test('CLI and MCP checkpoints leave other tasks untouched, and finish releases only the owner', async () => {
  const started = cli('task', 'start', 'cli-task', '--no-worktree', '--path', 'declared.ts', '--intent', 'CLI work')
  assert.equal(started.status, 0, started.stderr)
  await call('agentgit_task', { action: 'start', task: 'mcp-task', worktree: false, paths: ['declared.ts'], intent: 'MCP work' })
  const paths = ensureWorkspace(root)
  for (const [taskId, file] of [['cli-task', 'a.ts'], ['mcp-task', 'b.ts'], ['other-task', 'c.ts']]) {
    writeFileSync(join(root, file), `${taskId}\n`)
    acquireLease(paths, { entityKey: `file::${file}`, taskId, sessionId: taskId, reason: 'working', minutes: 20 })
    appendEvent(paths, buildEvent({
      kind: 'file_write', timestampUtc: new Date().toISOString(), sessionId: taskId, taskId,
      entities: [{ kind: 'file', identifier: file, path: file }],
    }))
  }
  writeFileSync(join(root, 'declared.ts'), 'declared only, no recorded write\n')

  const checkpoint = cli('task', 'checkpoint', 'cli-task', '--json')
  assert.equal(checkpoint.status, 0, checkpoint.stderr)
  assert.deepEqual(JSON.parse(checkpoint.stdout).files, ['a.ts'])
  assert.equal(git('show', '--pretty=format:', '--name-only', 'HEAD').trim(), 'a.ts')
  const fromMcp = await call<{ committed: boolean; files: string[] }>('agentgit_task', { action: 'checkpoint', task: 'mcp-task' })
  assert.equal(fromMcp.committed, true)
  assert.deepEqual(fromMcp.files, ['b.ts'])
  assert.equal(git('show', '--pretty=format:', '--name-only', 'HEAD').trim(), 'b.ts')
  assert.ok(statusShort(root).includes('?? c.ts'))
  assert.ok(statusShort(root).includes('?? declared.ts'))

  const beforeFinish = headOid(root)
  assert.equal(cli('task', 'finish', 'cli-task').status, 0)
  await call('agentgit_task', { action: 'finish', task: 'mcp-task' })
  assert.equal(headOid(root), beforeFinish, 'finishing must not merge or create a commit')
  assert.deepEqual(loadLeases(paths).leases.map(lease => lease.taskId), ['other-task'])
  const events = readAllEvents(paths).events
  for (const [taskId, hostEvent, sessionId] of [['cli-task', 'cli', 'cli-session'], ['mcp-task', 'mcp', 'mcp-session']]) {
    const taskEvents = events.filter(event => event.taskId === taskId)
    for (const kind of ['task_registered', 'lifecycle_validated']) {
      const event = taskEvents.find(event => event.kind === kind)
      assert.equal(event?.hostEvent, hostEvent)
      assert.equal(event?.sessionId, sessionId)
    }
    assert.equal(taskEvents.some(event => event.kind === 'lifecycle_integrated'), false)
  }
})

test('CLI, MCP and daemon retain dependency order, stale versions and non-mutating conflict previews', async () => {
  await call('agentgit_task', { action: 'start', task: 'consumer', intent: 'Use the API' })
  const started = cli('task', 'start', 'producer', '--intent', 'Change the API')
  assert.equal(started.status, 0, started.stderr)
  const paths = ensureWorkspace(root)
  for (const taskId of ['consumer', 'producer']) {
    const tree = join(root, '.agentgit', 'worktrees', taskId)
    writeFileSync(join(tree, 'shared.ts'), `export const value = '${taskId}'\n`)
    assert.equal(checkpointCommit(tree, ['shared.ts'], taskId).committed, true)
  }
  publishContract(paths, { name: 'api', breaking: false, publishedBy: 'producer', summary: 'v1' })
  recordAssumption(paths, {
    taskId: 'consumer', sessionId: 'mcp-session', contract: 'api', version: 1,
    source: 'declared', path: 'shared.ts', recordedAt: new Date().toISOString(),
  })
  publishContract(paths, { name: 'api', breaking: true, publishedBy: 'producer', summary: 'v2' })
  writeFileSync(join(root, 'unfinished.ts'), 'uncommitted work\n')
  const before = { head: headOid(root), refs: git('show-ref'), status: statusShort(root) }

  const result = cli('reconcile', '--json')
  assert.equal(result.status, 1, 'a stale dependency and merge conflict require attention')
  const fromCli = JSON.parse(result.stdout) as {
    stale: StaleAssumption[]; order: IntegrationItem[];
    merge: { a: string; b: string; clean: boolean; message: string }[];
  }
  const fromMcp = await call<{
    stale: StaleAssumption[]; order: IntegrationItem[];
    merge: { a: string; b: string; clean: boolean; note: string }[];
  }>('agentgit_reconcile', {})
  assert.deepEqual(fromCli.order.map(item => item.taskId), ['producer', 'consumer'])
  assert.deepEqual(fromMcp.order, fromCli.order)
  assert.deepEqual(fromMcp.stale, fromCli.stale)
  assert.equal(fromCli.stale[0].breaking, true)
  assert.equal(fromCli.merge[0].clean, false)
  assert.equal(fromMcp.merge[0].clean, false)
  assert.equal(fromCli.merge[0].message, fromMcp.merge[0].note)
  assert.deepEqual([fromCli.merge[0].a, fromCli.merge[0].b], ['producer', 'consumer'])
  assert.deepEqual([fromMcp.merge[0].a, fromMcp.merge[0].b], ['consumer', 'producer'])

  const publisher = createHubPublisher({ publish: false })
  const hub = publisher.rule(root, paths, buildBoardView(paths))
  assert.deepEqual(hub?.integration, fromCli.order)
  assert.deepEqual({ head: headOid(root), refs: git('show-ref'), status: statusShort(root) }, before)
})
