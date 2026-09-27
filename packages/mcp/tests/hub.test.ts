/**
 * The hub, as the MCP tools present it.
 *
 * Two things are worth pinning here, and neither is a string match on prose:
 *
 * 1. **A verdict always carries the unified ruling.** `agentgit_preflight` is the one call the
 *    product asks for before every write, so it is the degradation path that needs no host
 *    cooperation at all. If the hub is only reachable through the hook, then a workspace where
 *    hooks are untrusted has no hub.
 * 2. **Read, never recomputed.** The tool layer reads the projection the daemon writes, because
 *    recomputing here would make one tool call's cost grow with the ledger and could let two
 *    windows answer from subtly different states.
 *
 * The brain's one write is tested for the property that makes it safe: the *earliest* answer for
 * a contention is the conclusion, so a second window answering the same question cannot produce
 * a second conclusion.
 */

import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  acquireLease,
  appendEvent,
  buildEvent,
  computeHubVerdict,
  publishHubVerdict,
  readAllEvents,
  workspacePaths,
  writeHubMarker,
} from '@agentgit/core'
import { createServer, type Server } from '../src/server.ts'

let root: string
let server: Server

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'agentgit-mcp-hub-'))
  server = createServer()
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

async function call(name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const response = await server.handle({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name, arguments: { workspace: root, ...args } },
  })
  const result = (response as { result?: Record<string, unknown> }).result
  assert.ok(result, `expected a result, got ${JSON.stringify(response)}`)
  return result
}

function textOf(result: Record<string, unknown>): string {
  return (result.content as { type: string; text: string }[]).map((block) => block.text).join('\n')
}

/** Word lists, chosen to land in a known band of the lexical matcher. See hub.test.ts. */
const SAME_A = 'alpha beta gamma delta'
const SAME_B = 'alpha beta gamma epsilon'
const UNDECIDABLE_A = 'alpha beta gamma delta'
const UNDECIDABLE_B = 'alpha beta epsilon'
const DIFFERENT = 'epsilon zeta eta theta'

function write(taskId: string, intent: string | null, path = 'src/limiter.ts'): void {
  const at = new Date()
  appendEvent(
    workspacePaths(root),
    buildEvent({
      kind: 'file_write',
      timestampUtc: at.toISOString(),
      sessionId: taskId,
      taskId,
      entities: [{ kind: 'file', identifier: path, path }],
      intentText: intent,
      hostEvent: 'test',
    }),
    at,
  )
}

/** Publish a ruling the way the daemon does, so the tools have something to read. */
function publish(): string {
  const verdict = computeHubVerdict(workspacePaths(root), new Date())
  publishHubVerdict(workspacePaths(root), verdict)
  return verdict.id
}

function resolves() {
  return readAllEvents(workspacePaths(root)).events.filter((event) => event.hostEvent === 'hub/resolve')
}

/* -------------------------------------------------------------------------- */

describe('a verdict always carries the one ruling', () => {
  test('preflight reports the hub conclusion alongside its own, and says they differ in kind', async () => {
    write('task-a', SAME_A)
    write('task-b', SAME_B)
    const id = publish()

    const result = await call('agentgit_preflight', { path: 'src/limiter.ts', intent: SAME_B, task: 'task-b' })
    const text = textOf(result)

    assert.match(text, /VERDICT:/)
    assert.match(text, /hub ruling \(one conclusion, shared by every window\)/)
    assert.match(text, /src\/limiter\.ts/)
    const structured = result.structuredContent as Record<string, unknown>
    const hub = structured.hub as { id: string; authority: string; ruling: { word: string } }
    assert.equal(hub.id, id)
    assert.equal(hub.authority, 'advisory')
    assert.equal(hub.ruling.word, 'reuse')
  })

  test('a workspace with no ruling still answers, and says there is none', async () => {
    // The hub is an addition; a verdict must never depend on it having run.
    const result = await call('agentgit_preflight', { path: 'src/limiter.ts', intent: 'anything' })
    assert.match(textOf(result), /VERDICT:/)
    assert.equal((result.structuredContent as Record<string, unknown>).hub, undefined)
  })

  test('preflight reports a reservation as reserved, before any collision exists', async () => {
    write('task-a', SAME_A)
    acquireLease(
      workspacePaths(root),
      { entityKey: 'file::src/limiter.ts', taskId: 'task-a', sessionId: 'task-a', reason: 'adding the limiter', minutes: 20 },
      new Date(),
    )
    publish()

    const result = await call('agentgit_preflight', { path: 'src/limiter.ts', intent: 'add rate limiting', task: 'window-b' })
    assert.match(textOf(result), /reserved by task-a/)
    const hub = (result.structuredContent as Record<string, unknown>).hub as {
      ruling: unknown
      holder: { taskId: string }
    }
    assert.equal(hub.ruling, null, 'one writer is a reservation, not a contention')
    assert.equal(hub.holder.taskId, 'task-a')
  })

  test('brief reports what the hub ruled since this window was last shown one', async () => {
    write('task-a', SAME_A)
    write('task-b', SAME_B)
    const id = publish()

    const result = await call('agentgit_brief', { session: 'window-b' })
    const text = textOf(result)
    assert.match(text, /Hub ruling changed since this window was last shown one/)
    assert.match(text, /src\/limiter\.ts/)
    assert.equal((result.structuredContent as Record<string, unknown>).hubChanged, true)

    // Once the hook has pushed it, the same window is told it is current rather than re-reading
    // the whole ruling — which is the token cost this whole mechanism is trying to avoid.
    writeHubMarker(workspacePaths(root), 'window-b', {
      rulingId: id,
      at: new Date().toISOString(),
      event: 'PreToolUse',
    })
    const again = await call('agentgit_brief', { session: 'window-b' })
    assert.match(textOf(again), /Hub ruling unchanged since this window was last shown it/)
    assert.equal((again.structuredContent as Record<string, unknown>).hubChanged, false)
  })

  test('status reports the ruling with effective parallelism beside it', async () => {
    write('task-a', SAME_A)
    write('task-b', SAME_B)
    publish()

    const text = textOf(await call('agentgit_status'))
    assert.match(text, /hub ruling hub-/)
    assert.match(text, /undecided/)
    assert.match(text, /effective parallelism P/)
    assert.match(text, /authority advisory/)
  })
})

describe('the brain answers once, and the answer is a ledger fact', () => {
  test('answering an undecided ruling records a decision event and stops it asking', async () => {
    write('task-a', UNDECIDABLE_A)
    write('task-b', UNDECIDABLE_B)
    publish()

    const result = await call('agentgit_hub_resolve', {
      entityKey: 'file::src/limiter.ts',
      decision: 'reuse',
      reason: 'the same throttle, extending theirs',
      session: 'window-b',
    })
    assert.match(textOf(result), /answered REUSE/)

    const recorded = resolves()
    assert.equal(recorded.length, 1)
    assert.equal(recorded[0].kind, 'decision')
    assert.equal(recorded[0].sessionId, 'window-b')
    assert.equal(recorded[0].detail?.decision, 'reuse')
    assert.ok(typeof recorded[0].detail?.signature === 'string')

    // The hub now applies it, so the ambiguity is gone rather than merely annotated.
    const after = computeHubVerdict(workspacePaths(root), new Date())
    assert.equal(after.rulings[0].word, 'reuse')
    assert.equal(after.rulings[0].resolvedBy, 'window-b')
    assert.equal(after.metrics.ambiguous, 0)
  })

  test('a second window answering the same question cannot produce a second conclusion', async () => {
    write('task-a', UNDECIDABLE_A)
    write('task-b', UNDECIDABLE_B)
    publish()

    await call('agentgit_hub_resolve', {
      entityKey: 'file::src/limiter.ts',
      decision: 'reuse',
      reason: 'same job',
      session: 'window-b',
    })
    await call('agentgit_hub_resolve', {
      entityKey: 'file::src/limiter.ts',
      decision: 'replan',
      reason: 'different job actually',
      session: 'window-c',
    })

    assert.equal(resolves().length, 2, 'the losing answer is still recorded: the ledger is append-only')

    const after = computeHubVerdict(workspacePaths(root), new Date())
    assert.equal(after.rulings[0].word, 'reuse', 'the earliest answer is the conclusion')
    assert.equal(after.rulings[0].resolvedBy, 'window-b')
    assert.equal(after.rulings[0].supersededAnswers, 1)
  })

  test('refuses to reopen a collision that recorded evidence already decided', async () => {
    write('task-a', SAME_A)
    write('task-b', DIFFERENT)
    publish()

    const result = await call('agentgit_hub_resolve', {
      entityKey: 'file::src/limiter.ts',
      decision: 'reuse',
      reason: 'they are the same, trust me',
      session: 'window-b',
    })

    assert.equal(result.isError, true)
    assert.match(textOf(result), /already ruled REPLAN/)
    assert.match(textOf(result), /one conclusion per contention/)
    assert.equal(resolves().length, 0)
  })

  test('refuses a decision that is neither of the two words, and lists them', async () => {
    write('task-a', UNDECIDABLE_A)
    write('task-b', UNDECIDABLE_B)
    publish()

    const result = await call('agentgit_hub_resolve', {
      entityKey: 'file::src/limiter.ts',
      decision: 'maybe',
      session: 'window-b',
    })
    assert.equal(result.isError, true)
    assert.match(textOf(result), /"reuse" or "replan"/)
  })

  test('refuses to answer an entity nobody is contesting, and says how to find the right one', async () => {
    write('task-a', SAME_A)
    write('task-b', SAME_B)
    publish()

    const result = await call('agentgit_hub_resolve', {
      entityKey: 'file::src/nobody-cares.ts',
      decision: 'reuse',
      session: 'window-b',
    })
    assert.equal(result.isError, true)
    assert.match(textOf(result), /not in the hub's current ruling/)
    assert.match(textOf(result), /agentgit_preflight/)
  })

  test('refuses to answer before anything has been published, rather than inventing a set', async () => {
    const result = await call('agentgit_hub_resolve', {
      entityKey: 'file::src/limiter.ts',
      decision: 'reuse',
      session: 'window-b',
    })
    assert.equal(result.isError, true)
    assert.match(textOf(result), /agentgit up/)
    assert.equal(resolves().length, 0)
  })

  test('accepts a path instead of an entity key, resolving it the same way a claim does', async () => {
    write('task-a', UNDECIDABLE_A)
    write('task-b', UNDECIDABLE_B)
    publish()

    const result = await call('agentgit_hub_resolve', {
      path: 'src/limiter.ts',
      decision: 'replan',
      reason: 'different work, we will split it',
      session: 'window-b',
    })
    assert.equal(result.isError, undefined)
    assert.equal(resolves()[0].detail?.entityKey, 'file::src/limiter.ts')
  })

  test('is listed with the other tools, so a model scanning the list can find it', async () => {
    const response = await server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
    const tools = (response as { result: { tools: { name: string }[] } }).result.tools.map((tool) => tool.name)
    assert.ok(tools.includes('agentgit_hub_resolve'))
    assert.ok(tools.includes('agentgit_brief'), 'the brief exists but was missing from the skill list once already')
  })
})
