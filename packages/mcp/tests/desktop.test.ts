/**
 * `agentgit_desktop`, as the MCP tools present it.
 *
 * This tool is the joint between the two halves of the feature. A hook notices that a workspace has
 * opted into coordination and asks the user; the conversation creates the task, and only after the
 * user agrees. Neither half can see the other, so this file is where they agree - and the two ways
 * it can go wrong are both invisible in a UI:
 *
 * 1. **Asking must not count as answering.** A bare call is a question, and if answering it wrote a
 *    record the tool would suppress the very offer it was asked about. There is a test for that,
 *    because "reading something changed it" is the kind of bug that only shows up as "the offer
 *    stopped appearing and nobody knows why".
 * 2. **Recording must actually stop the offer.** Both terminal answers are checked through the
 *    library's own rule rather than through a string match, so this test fails if the tool writes a
 *    field the hook does not read.
 */

import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  desktopStatePath,
  readDesktopState,
  shouldOfferDesktop,
  workspacePaths,
  writeDesktopState,
  type DesktopState,
} from '@agentgit/core'
import { createServer, type Server } from '../src/server.ts'

let root: string
let server: Server

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'agentgit-mcp-desktop-'))
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

/** What the hook would decide on its next run, read from the same record the tool wrote. */
function offerStanding(): boolean {
  const state = readDesktopState(workspacePaths(root))
  return shouldOfferDesktop(state, new Date())
}

function state(): DesktopState | null {
  return readDesktopState(workspacePaths(root))
}

/** The tool result, for an assertion about a failure the model is meant to read and act on. */
function isError(result: Record<string, unknown>): boolean {
  return result.isError === true
}

describe('asking is not answering', () => {
  test('a bare call reports that nothing has been decided, and writes nothing', async () => {
    // If this call created a record, the tool would suppress the offer it was asked about, and the
    // feature would stop working with no error anywhere.
    const result = await call('agentgit_desktop')

    assert.equal(isError(result), false)
    assert.match(textOf(result), /no record yet/i)
    assert.equal(existsSync(desktopStatePath(workspacePaths(root))), false, 'a question must not write')
    assert.equal(offerStanding(), true, 'the offer must still be pending')
  })

  test('reports the record once one exists, and still writes nothing', async () => {
    await call('agentgit_desktop', { threadId: 'thread-1', automationId: 'auto-1' })
    const before = readFileSync(desktopStatePath(workspacePaths(root)), 'utf8')

    const result = await call('agentgit_desktop')

    assert.equal(isError(result), false)
    assert.match(textOf(result), /thread-1/)
    assert.match(textOf(result), /auto-1/)
    assert.equal(readFileSync(desktopStatePath(workspacePaths(root)), 'utf8'), before, 'a read must not write')
  })
})

describe('recording the setup', () => {
  test('a threadId is remembered, and ends the offer', async () => {
    const result = await call('agentgit_desktop', { threadId: 'thread-1' })

    assert.equal(isError(result), false)
    assert.equal(state()?.threadId, 'thread-1')
    assert.equal(offerStanding(), false, 'a workspace with a task must never be offered a second one')
  })

  test('the automation id is kept with it', async () => {
    await call('agentgit_desktop', { threadId: 'thread-1', automationId: 'auto-1' })
    assert.equal(state()?.automationId, 'auto-1')
  })

  test('a partial call does not erase what is already recorded', async () => {
    // The heartbeat calls this on every run with only the ruling. If that replaced the record, the
    // task id would vanish on the first tick and the workspace would be offered a second task.
    await call('agentgit_desktop', { threadId: 'thread-1', automationId: 'auto-1' })
    await call('agentgit_desktop', { lastRulingId: 'hub-abc', lastReportedAt: '2026-01-01T00:00:00.000Z' })

    assert.equal(state()?.threadId, 'thread-1')
    assert.equal(state()?.automationId, 'auto-1')
    assert.equal(state()?.lastRulingId, 'hub-abc')
    assert.equal(state()?.lastReportedAt, '2026-01-01T00:00:00.000Z')
  })

  test('the workspace is recorded, so the file says what it is about', async () => {
    await call('agentgit_desktop', { threadId: 'thread-1' })
    assert.equal(state()?.workspace, root)
  })
})

describe('recording a refusal', () => {
  test('declined is remembered, and ends the offer', async () => {
    const result = await call('agentgit_desktop', { decision: 'declined' })

    assert.equal(isError(result), false)
    assert.ok(state()?.declinedAt, 'the refusal must be recorded')
    assert.equal(offerStanding(), false, 'a refused workspace must not be asked again')
  })

  test('a refusal does not pretend a task exists', async () => {
    await call('agentgit_desktop', { decision: 'declined' })
    assert.equal(state()?.threadId, null)
  })

  test('any other decision is refused, because only a refusal is a decision this tool records', async () => {
    // An "accepted" with no task id would be a record of something that did not happen, and it would
    // suppress the offer that is the only way the task ever gets created.
    for (const decision of ['accepted', 'yes', 'approved']) {
      const result = await call('agentgit_desktop', { decision })
      assert.equal(isError(result), true, `${decision} must not be accepted as a decision`)
      assert.match(textOf(result), /declined/)
    }
    assert.equal(existsSync(desktopStatePath(workspacePaths(root))), false, 'nothing may be written')
  })

  test('an empty string counts as absent rather than as a bad decision', async () => {
    // A host that sends `""` for an unset enum should get a bare call, not an error: the alternative
    // turns "the model passed no decision" into a failure the model then has to reason about.
    const result = await call('agentgit_desktop', { decision: '' })
    assert.equal(isError(result), false)
    assert.equal(existsSync(desktopStatePath(workspacePaths(root))), false)
  })
})

describe('recording what /agentgit did', () => {
  test('a pinned conversation is recorded, and a second one is added rather than replacing it', async () => {
    await call('agentgit_desktop', { pinnedThreadId: 'thread-1' })
    const result = await call('agentgit_desktop', { pinnedThreadId: 'thread-2' })

    assert.deepEqual(
      Object.keys(state()?.pinnedThreads ?? {}).sort(),
      ['thread-1', 'thread-2'],
      'a workspace has many conversations, and pinning one must not unpin another',
    )
    assert.match(textOf(result), /thread-1/)
    assert.match(textOf(result), /thread-2/)
  })

  test('pinning the same conversation twice keeps one entry', async () => {
    await call('agentgit_desktop', { pinnedThreadId: 'thread-1' })
    await call('agentgit_desktop', { pinnedThreadId: 'thread-1' })

    assert.deepEqual(Object.keys(state()?.pinnedThreads ?? {}), ['thread-1'])
  })

  test('a pin is not an acceptance, so the task offer still stands', async () => {
    // Enabling a workspace and accepting a pinned coordination task are two different answers, and
    // conflating them would silently cancel the task offer for a workspace that only asked to be
    // switched on.
    await call('agentgit_desktop', { pinnedThreadId: 'thread-1' })

    assert.equal(state()?.threadId, null)
    assert.equal(offerStanding(), true)
  })

  test('enabled is recorded when it was not set, and reported', async () => {
    const result = await call('agentgit_desktop', { enabled: true })

    assert.ok(state()?.enabledAt, 'the instant must be recorded')
    assert.match(textOf(result), /enabled/)
    assert.deepEqual((result.structuredContent as { changed?: string[] }).changed, ['enabledAt'])
  })

  test('enabling keeps the first instant, so a second enable does not move it', async () => {
    // The field answers "since when", so overwriting it would make the answer wrong.
    writeDesktopState(workspacePaths(root), { enabledAt: '2026-01-01T00:00:00.000Z' })
    await call('agentgit_desktop', { enabled: true })

    assert.equal(state()?.enabledAt, '2026-01-01T00:00:00.000Z')
  })

  test('one call can pin and enable, and both are reported as changed', async () => {
    const result = await call('agentgit_desktop', { pinnedThreadId: 'thread-1', enabled: true })
    const structured = result.structuredContent as { changed?: string[] }

    assert.equal(state()?.pinnedThreads['thread-1'] !== undefined, true)
    assert.ok(state()?.enabledAt)
    assert.deepEqual([...(structured.changed ?? [])].sort(), ['enabledAt', 'pinnedThreads'])
  })
})

describe('the heartbeat\'s bookkeeping', () => {
  test('the last reported ruling is kept so the same one is not reported twice', async () => {
    await call('agentgit_desktop', { threadId: 'thread-1' })
    await call('agentgit_desktop', { lastRulingId: 'hub-abc', lastReportedAt: '2026-01-01T00:00:00.000Z' })

    assert.equal(state()?.lastRulingId, 'hub-abc')
    // A quiet run still records that it looked, which is what tells a quiet task from a dead one.
    assert.equal(state()?.lastReportedAt, '2026-01-01T00:00:00.000Z')
  })

  test('a heartbeat run does not disturb whether the workspace was offered', async () => {
    await call('agentgit_desktop', { threadId: 'thread-1', automationId: 'auto-1' })
    await call('agentgit_desktop', { lastRulingId: 'hub-abc' })

    assert.equal(offerStanding(), false)
    assert.equal(state()?.threadId, 'thread-1')
  })
})

describe('the tool says what it is', () => {
  test('its result carries the record as structure, not only as prose', async () => {
    const result = await call('agentgit_desktop', { threadId: 'thread-1' })
    const structured = result.structuredContent as { desktop?: DesktopState; changed?: string[] }

    assert.equal(structured.desktop?.threadId, 'thread-1')
    assert.deepEqual(structured.changed, ['threadId'])
  })

  test('it declares itself as writing, and as safe to repeat', async () => {
    const response = await server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
    const tools = ((response as { result?: { tools: Record<string, unknown>[] } }).result?.tools ?? [])
    const descriptor = tools.find((tool) => tool.name === 'agentgit_desktop')

    assert.ok(descriptor, 'agentgit_desktop must be listed')
    const annotations = descriptor.annotations as { readOnlyHint: boolean; destructiveHint: boolean }
    // It writes one file of its own bookkeeping, so it is not read-only; it creates and destroys
    // nothing in the workspace, so it is not destructive either.
    assert.equal(annotations.readOnlyHint, false)
    assert.equal(annotations.destructiveHint, false)
    const description = String(descriptor.description)
    assert.match(description, /never creates a task/, 'the description is the contract the model reads')
  })
})
