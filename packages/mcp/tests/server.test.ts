/**
 * Protocol and tool behaviour, driven through the server object directly.
 *
 * These are the assertions about *shape* — which tools exist, what a failure looks like,
 * what a notification does — and they belong here rather than in a spawned process
 * because the interesting failures are cheap to provoke and expensive to reproduce
 * through a pipe. The spawned-process test next door covers the framing that only a real
 * stdio session can prove.
 */

import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createServer, type Server } from '../src/server.ts'
import { ErrorCodes, ToolError } from '../src/protocol.ts'
import { TOOLS } from '../src/tools.ts'
import { APP_MIME_TYPE, APP_RESOURCE_URI } from '@agentgit/app'
import { panelReference } from '@agentgit/board'

let root: string
let server: Server

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'agentgit-mcp-'))
  server = createServer()
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/** A `tools/call` for a workspace, returning the raw result payload. */
async function call(name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const response = await server.handle({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name, arguments: { workspace: root, ...args } },
  })
  assert.ok(response, 'a request with an id must always be answered')
  const result = (response as { result?: Record<string, unknown> }).result
  assert.ok(result, `expected a result, got ${JSON.stringify(response)}`)
  return result
}

function textOf(result: Record<string, unknown>): string {
  const content = result.content as { type: string; text: string }[]
  return content.map((block) => block.text).join('\n')
}

describe('initialize', () => {
  test('reports the tool capability and a name the host can show', async () => {
    const response = await server.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
    const result = (response as { result: Record<string, unknown> }).result

    assert.equal(result.protocolVersion, '2025-06-18', 'the newest supported revision is offered by default')
    assert.deepEqual(result.capabilities, {
      tools: { listChanged: false },
      resources: { listChanged: false, subscribe: false },
      extensions: { 'io.modelcontextprotocol/ui': { mimeTypes: ['text/html;profile=mcp-app'] } },
    })
    assert.deepEqual((result.serverInfo as { name: string }).name, 'agentgit')
    assert.match(String(result.instructions), /preflight/)
  })

  test('echoes an older revision the host asked for rather than insisting on the newest', async () => {
    const response = await server.handle({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2024-11-05' },
    })
    const result = (response as { result: Record<string, unknown> }).result
    assert.equal(result.protocolVersion, '2024-11-05')
  })

  test('falls back to the newest revision when the host asks for one nobody speaks', async () => {
    const response = await server.handle({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '1999-01-01' },
    })
    const result = (response as { result: Record<string, unknown> }).result
    assert.equal(result.protocolVersion, '2025-06-18')
  })
})

describe('notifications', () => {
  test('are never answered, because answering one is a protocol error', async () => {
    assert.equal(
      await server.handle({ jsonrpc: '2.0', id: null, method: 'notifications/initialized', params: {} }),
      null,
    )
    assert.equal(await server.handle({ jsonrpc: '2.0', id: null, method: 'tools/call', params: { name: 'nope' } }), null)
  })
})

describe('tools/list', () => {
  test('lists every tool with a description and a schema', async () => {
    const response = await server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
    const tools = ((response as { result: { tools: Record<string, unknown>[] } }).result.tools) ?? []

    assert.equal(tools.length, TOOLS.length)
    for (const tool of tools) {
      assert.equal(typeof tool.name, 'string')
      assert.ok(String(tool.name).startsWith('agentgit_'), `${tool.name} is namespaced`)
      assert.ok(String(tool.description).length > 80, `${tool.name} explains itself`)
      assert.equal(typeof tool.inputSchema, 'object')
      assert.equal(typeof (tool.annotations as Record<string, unknown>).readOnlyHint, 'boolean')
    }
  })

  test('names the tools the skill tells the model to call', async () => {
    const names = TOOLS.map((tool) => tool.name)
    for (const expected of [
      'agentgit_panel',
      'agentgit_ui',
      'agentgit_graph',
      'agentgit_explain',
      'agentgit_status',
      'agentgit_board',
      'agentgit_preflight',
      'agentgit_reconcile',
      'agentgit_why',
      'agentgit_contracts',
      'agentgit_claim',
      'agentgit_release',
      'agentgit_publish_contract',
      'agentgit_assume',
      'agentgit_task',
    ]) {
      assert.ok(names.includes(expected), `the skill documents ${expected}, so it must exist`)
    }
  })

  test('exactly one tool declares the panel as its UI, and only that one', async () => {
    const response = await server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
    const tools = (response as { result: { tools: Record<string, unknown>[] } }).result.tools

    const withUi = tools.filter((tool) => {
      const meta = tool._meta as { ui?: { resourceUri?: string } } | undefined
      return meta?.ui?.resourceUri !== undefined
    })
    assert.deepEqual(
      withUi.map((tool) => tool.name),
      ['agentgit_ui'],
      'a second tool pointing at the panel would mount a second iframe for one answer',
    )
    const meta = withUi[0]!._meta as { ui: { resourceUri: string } }
    assert.equal(meta.ui.resourceUri, APP_RESOURCE_URI)
  })

  test('the data tools carry no UI, so a host without MCP Apps still gets text', async () => {
    const response = await server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
    const tools = (response as { result: { tools: Record<string, unknown>[] } }).result.tools
    for (const name of ['agentgit_graph', 'agentgit_explain']) {
      const tool = tools.find((candidate) => candidate.name === name)
      assert.ok(tool, `${name} exists`)
      assert.equal(tool!._meta, undefined, `${name} must not advertise UI`)
    }
  })
})

describe('agentgit_whoami', () => {
  test('says how the session was decided, so a wrong attribution is visible', async () => {
    const result = await call('agentgit_whoami')
    const text = textOf(result)
    assert.match(text, /workspace\s+:/)
    assert.match(text, /session\s+:/)
    assert.match(text, /task\s+:/)

    const structured = result.structuredContent as Record<string, unknown>
    assert.equal(structured.workspace, root)
    assert.ok(['argument', 'environment', 'ledger', 'placeholder'].includes(String(structured.sessionSource)))
  })

  test('marks an inferred session as a guess and says what to do about it', async () => {
    const result = await call('agentgit_whoami')
    const structured = result.structuredContent as Record<string, unknown>
    assert.equal(structured.sessionIsGuess, true, 'a fresh workspace has no session to read')
    assert.match(textOf(result), /pass `session` explicitly/)
  })

  test('uses a session that was passed in, and stops calling it a guess', async () => {
    const result = await call('agentgit_whoami', { session: 'session-from-skill' })
    const structured = result.structuredContent as Record<string, unknown>
    assert.equal(structured.sessionId, 'session-from-skill')
    assert.equal(structured.sessionSource, 'argument')
    assert.equal(structured.sessionIsGuess, false)
    assert.equal(
      structured.taskId,
      'session-from-skill',
      'the task falls back to the session id itself, spelled exactly as the hook spells it',
    )
  })
})

describe('agentgit_preflight', () => {
  test('answers a free entity with allow and a reason', async () => {
    const result = await call('agentgit_preflight', { path: 'src/untouched.ts', intent: 'add a helper' })
    const structured = result.structuredContent as Record<string, unknown>

    assert.equal(structured.verdict, 'allow')
    assert.equal(
      structured.entityKey,
      'file::src/untouched.ts',
      'workspace-relative, so two clones of one repository agree on the key',
    )
    assert.ok(String(structured.reason).length > 0)
    assert.equal(structured.ttlSeconds, 300, 'a clear verdict is cacheable for longer than a contested one')
    assert.match(String(structured.version), /^pf-/)
    assert.equal(result.isError, undefined)
    assert.match(textOf(result), /VERDICT: ALLOW/)
  })

  test('needs a path or a symbol, and says which', async () => {
    const result = await call('agentgit_preflight', { intent: 'something' })
    assert.equal(result.isError, true)
    assert.match(textOf(result), /`path` or `symbol`/)
    assert.match(textOf(result), /Use `path` for a file/)
  })

  test('records nothing unless it is asked to', async () => {
    await call('agentgit_preflight', { path: 'src/untouched.ts', intent: 'look only' })
    const board = await call('agentgit_board')
    const structured = board.structuredContent as { tasks: unknown[] }
    assert.deepEqual(structured.tasks, [], 'a read-only question must not create a task')
  })

  test('claims and records when asked, so the next agent sees the ground is taken', async () => {
    const first = await call('agentgit_preflight', {
      path: 'src/shared.ts',
      intent: 'add rate limiting to the login endpoint',
      claim: true,
      session: 'session-one',
    })
    assert.equal((first.structuredContent as Record<string, unknown>).verdict, 'allow')

    const second = await call('agentgit_preflight', {
      path: 'src/shared.ts',
      intent: 'add rate limiting for login attempts',
      session: 'session-two',
    })
    const verdict = String((second.structuredContent as Record<string, unknown>).verdict)
    assert.ok(['reuse', 'replan'].includes(verdict), `expected a contested verdict, got ${verdict}`)
    assert.match(textOf(second), /Competing work:|held by/)
  })

  /**
   * A breaking interface at v2, with one consumer still coded against v1, and the
   * producer's task closed so the result is not `wait`.
   */
  async function breakingChangeLanded(): Promise<void> {
    await call('agentgit_publish_contract', {
      name: 'auth.limit',
      summary: 'throttle(identifier, limit)',
      declaredIn: 'src/limiter.ts',
      session: 'publisher',
    })
    await call('agentgit_assume', { contract: 'auth.limit', session: 'consumer' })
    await call('agentgit_publish_contract', {
      name: 'auth.limit',
      summary: 'throttle(identifier, budget)',
      declaredIn: 'src/limiter.ts',
      breaking: true,
      session: 'publisher',
    })
    // No `task` argument: the publisher never declared one, so its work is attributed to
    // its session id, and that is the capsule `integrate` has to close. Naming a task it
    // never used would mark a capsule nobody opened and leave the real one in flight.
    await call('agentgit_task', { action: 'integrate', session: 'publisher' })
  }

  test('waits while the interface is still being landed, then reviews once it has', async () => {
    await call('agentgit_publish_contract', {
      name: 'auth.limit',
      summary: 'throttle(identifier, limit)',
      declaredIn: 'src/limiter.ts',
      session: 'publisher',
    })
    await call('agentgit_assume', { contract: 'auth.limit', session: 'consumer' })
    await call('agentgit_publish_contract', {
      name: 'auth.limit',
      summary: 'throttle(identifier, budget)',
      declaredIn: 'src/limiter.ts',
      breaking: true,
      session: 'publisher',
    })

    const waiting = await call('agentgit_preflight', {
      path: 'src/limiter.ts',
      intent: 'call the limiter',
      contracts: ['auth.limit'],
      session: 'consumer',
    })
    assert.equal(
      (waiting.structuredContent as Record<string, unknown>).verdict,
      'wait',
      'the publisher is still working, so replanning now would aim at a moving target',
    )

    // Marking the merge as done is what turns the change into a stable thing to replan
    // against. Without it every consumer of a breaking change waits forever. The task is
    // named by its session, because that is the capsule the publisher's work opened.
    await call('agentgit_task', { action: 'integrate', session: 'publisher' })

    const result = await call('agentgit_preflight', {
      path: 'src/limiter.ts',
      intent: 'call the limiter',
      contracts: ['auth.limit'],
      session: 'consumer',
    })
    const verdict = String((result.structuredContent as Record<string, unknown>).verdict)
    assert.equal(verdict, 'review')
    assert.equal(result.isError, undefined, 'a blocking verdict is still a successful call')
    assert.match(textOf(result), /This is advisory/)
  })

  test('stops treating a silent publisher as in flight, so wait cannot last forever', async () => {
    // The producer publishes a breaking change and never says anything again. If
    // `wait` keyed on "the capsule has not closed", this consumer would wait on a task
    // that will never speak, and no lease expiry would rescue it.
    await call('agentgit_publish_contract', {
      name: 'auth.limit',
      summary: 'throttle(identifier, limit)',
      declaredIn: 'src/limiter.ts',
      session: 'publisher',
    })
    await call('agentgit_assume', { contract: 'auth.limit', session: 'consumer' })
    await call('agentgit_publish_contract', {
      name: 'auth.limit',
      summary: 'throttle(identifier, budget)',
      declaredIn: 'src/limiter.ts',
      breaking: true,
      session: 'publisher',
    })

    const dir = join(root, '.agentgit')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'config.json'), `${JSON.stringify({ version: 1, inFlightMinutes: 0 }, null, 2)}\n`, 'utf8')

    const result = await call('agentgit_preflight', {
      path: 'src/limiter.ts',
      contracts: ['auth.limit'],
      session: 'consumer',
    })
    assert.equal(
      (result.structuredContent as Record<string, unknown>).verdict,
      'review',
      'once the window passes, the interface counts as settled and the answer becomes actionable',
    )
  })

  test('does not call it review when the change has nothing to do with the interface', async () => {
    // `review` is the one stop signal. Spending it on a file the interface never
    // mentions would teach the model to ignore it.
    await breakingChangeLanded()

    const result = await call('agentgit_preflight', {
      path: 'src/unrelated-view.tsx',
      contracts: ['auth.limit'],
      session: 'consumer',
    })
    assert.equal((result.structuredContent as Record<string, unknown>).verdict, 'refresh')
  })
})

describe('agentgit_publish_contract and agentgit_assume', () => {
  test('refuses to publish without a summary, and says what a summary is for', async () => {
    const result = await call('agentgit_publish_contract', { name: 'auth.limit' })
    assert.equal(result.isError, true)
    assert.match(textOf(result), /`summary` is required/)
    assert.match(textOf(result), /written for the tasks that will read it/)
  })

  test('refuses to record an assumption against something never published', async () => {
    const result = await call('agentgit_assume', { contract: 'never.published' })
    assert.equal(result.isError, true)
    assert.match(textOf(result), /has never been published/)
    assert.match(textOf(result), /Publish it first/)
  })

  test('warns when an assumption is already behind rather than pretending it is current', async () => {
    await call('agentgit_publish_contract', { name: 'auth.limit', summary: 'v1 shape' })
    const result = await call('agentgit_assume', { contract: 'auth.limit', version: 1 })
    assert.equal((result.structuredContent as Record<string, unknown>).behind, false)

    await call('agentgit_publish_contract', { name: 'auth.limit', summary: 'v2 shape', breaking: true })
    const behind = await call('agentgit_assume', { contract: 'auth.limit', version: 1 })
    assert.equal((behind.structuredContent as Record<string, unknown>).behind, true)
    assert.match(textOf(behind), /already behind/)
  })

  test('a breaking publish lists who it just stranded', async () => {
    await call('agentgit_publish_contract', { name: 'auth.limit', summary: 'v1 shape', session: 'publisher' })
    await call('agentgit_assume', { contract: 'auth.limit', session: 'consumer' })

    const result = await call('agentgit_publish_contract', {
      name: 'auth.limit',
      summary: 'v2 shape',
      breaking: true,
      session: 'publisher',
    })
    assert.match(textOf(result), /1 task\(s\) are now coded against an older version/)
  })
})

describe('agentgit_claim and agentgit_release', () => {
  test('a claim on free ground is granted, and a second claim learns who has it', async () => {
    const first = await call('agentgit_claim', { path: 'src/a.ts', reason: 'refactoring', session: 'one' })
    assert.match(textOf(first), /granted/)

    const second = await call('agentgit_claim', { path: 'src/a.ts', reason: 'also refactoring', session: 'two' })
    assert.match(textOf(second), /not granted/)
    assert.match(textOf(second), /Also held by:/)
    assert.match(
      textOf(second),
      /A shared entity is not an error/,
      'the model is told what to do, not just what happened',
    )
  })

  test('release with all reports the count, and release on nothing says so', async () => {
    await call('agentgit_claim', { path: 'src/a.ts', reason: 'refactoring', session: 'one' })
    assert.match(textOf(await call('agentgit_release', { path: 'src/a.ts', session: 'one' })), /Released 1 lease/)

    const again = await call('agentgit_release', { path: 'src/a.ts', session: 'one' })
    assert.match(textOf(again), /Nothing to release/)
    assert.equal(again.isError, undefined, 'releasing nothing is not a failure')
  })
})

describe('agentgit_panel', () => {
  test('returns a reference bracketed by the private-use characters, and writes both files', async () => {
    const result = await call('agentgit_panel')
    const artifact = result.structuredContent as { path: string; fragmentPath: string; reference: string }

    assert.ok(existsSync(artifact.path), 'the referenced file must exist, or the host renders nothing')
    assert.ok(existsSync(artifact.fragmentPath))

    const PREFIX = '\uE200visualize\uE202'
    assert.ok(artifact.reference.startsWith(PREFIX))
    assert.ok(artifact.reference.endsWith('\uE201'))

    const payload = JSON.parse(artifact.reference.slice(PREFIX.length, -1))
    assert.equal(payload.path, artifact.path, 'the reference must point at the file that was written')
  })

  test('the reference survives the round trip as the exact characters the host looks for', () => {
    const reference = panelReference('C:/tmp/panel.html')
    assert.deepEqual(
      [...reference].slice(0, 11).map((char) => char.codePointAt(0)),
      [0xe200, 0x76, 0x69, 0x73, 0x75, 0x61, 0x6c, 0x69, 0x7a, 0x65, 0xe202],
      'U+E200 "visualize" U+E202 is the literal the host parses; one wrong character renders nothing',
    )
    assert.equal(reference.codePointAt(reference.length - 1), 0xe201)
  })

  test('the standalone document is a whole document, and the fragment is not', async () => {
    const result = await call('agentgit_panel')
    const artifact = result.structuredContent as { path: string; fragmentPath: string }

    const document = readFileSync(artifact.path, 'utf8')
    const fragment = readFileSync(artifact.fragmentPath, 'utf8')

    assert.match(document, /^<!doctype html>/i, 'a file opened directly needs a real document')
    assert.match(document, /<style>/, 'and needs the theme, because it has no host to inherit one from')
    for (const forbidden of ['<!doctype', '<html', '<body']) {
      assert.ok(
        !fragment.toLowerCase().includes(forbidden),
        `the fragment must not contain ${forbidden}: the host injects it into an existing page`,
      )
    }
  })

  test('says to put the reference on its own line and not to edit it', async () => {
    const text = textOf(await call('agentgit_panel'))
    assert.match(text, /own line/)
    assert.match(text, /Do not edit it/)
  })
})

describe('agentgit_why', () => {
  test('an unknown entity is answered with the reason, not with an error', async () => {
    const result = await call('agentgit_why', { target: 'src/nobody.ts' })
    assert.equal(result.isError, undefined)
    assert.match(textOf(result), /Nothing in the ledger mentions/)
    assert.match(textOf(result), /That is itself an answer/)
  })

  test('needs a target and says what counts as one', async () => {
    const result = await call('agentgit_why', {})
    assert.equal(result.isError, true)
    assert.match(textOf(result), /`target` is required/)
  })
})

describe('agentgit_reconcile', () => {
  test('says there is nothing to order when no task branch exists', async () => {
    const result = await call('agentgit_reconcile')
    assert.equal(result.isError, undefined)
    assert.match(textOf(result), /No task branch exists yet/)
  })
})

describe('failure handling', () => {
  test('an unknown tool is a protocol error and lists what does exist', async () => {
    const response = await server.handle({
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: { name: 'agentgit_nonexistent', arguments: {} },
    })
    const error = (response as { error: { code: number; message: string; data: { available: string[] } } }).error

    assert.equal(error.code, ErrorCodes.methodNotFound)
    assert.match(error.message, /agentgit_nonexistent/)
    assert.ok(
      error.data.available.includes('agentgit_preflight'),
      'listing the real tools is what lets a host recover instead of giving up',
    )
  })

  test('a missing tool name is an invalid-params error, not a crash', async () => {
    const response = await server.handle({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: {} })
    assert.equal((response as { error: { code: number } }).error.code, ErrorCodes.invalidParams)
  })

  test('an unknown method is reported, so a host can tell which side is out of date', async () => {
    const response = await server.handle({ jsonrpc: '2.0', id: 9, method: 'sampling/createMessage', params: {} })
    assert.equal((response as { error: { code: number } }).error.code, ErrorCodes.methodNotFound)
  })

  test('a tool failure is a successful call reporting failure, so the model reads the hint', async () => {
    const result = await call('agentgit_task', { action: 'sideways' })
    assert.equal(result.isError, true)
    assert.match(textOf(result), /Unknown action 'sideways'/)
    assert.match(textOf(result), /start, checkpoint, finish/)
  })

  test('resources/list advertises the panel, and nothing a host cannot render', async () => {
    const response = await server.handle({ jsonrpc: '2.0', id: 10, method: 'resources/list', params: {} })
    const result = (response as { result: { resources: Record<string, unknown>[] } }).result
    assert.equal(result.resources.length, 1)
    const panelResource = result.resources[0]!
    assert.equal(panelResource.uri, APP_RESOURCE_URI)
    assert.equal(panelResource.mimeType, APP_MIME_TYPE)
    assert.equal((panelResource._meta as { ui: { prefersBorder: boolean } }).ui.prefersBorder, true)
  })

  test('resources/read serves the panel document, with the workspace name in its title', async () => {
    const response = await server.handle({
      jsonrpc: '2.0',
      id: 11,
      method: 'resources/read',
      params: { uri: APP_RESOURCE_URI },
    })
    const result = (response as { result: { contents: { uri: string; mimeType: string; text: string }[] } }).result
    assert.equal(result.contents.length, 1)
    assert.equal(result.contents[0]!.mimeType, APP_MIME_TYPE)
    assert.match(result.contents[0]!.text, /^<!doctype html>/)
    assert.match(result.contents[0]!.text, /AgenticGit for/)
  })

  test('an unknown resource is a miss that names what exists', async () => {
    const response = await server.handle({
      jsonrpc: '2.0',
      id: 12,
      method: 'resources/read',
      params: { uri: 'ui://agentgit/nope.html' },
    })
    const error = (response as { error: { message: string; data: { available: string[] } } }).error
    assert.match(error.message, /Unknown resource/)
    assert.deepEqual(error.data.available, [APP_RESOURCE_URI])
  })

  test('ToolError carries a hint separately from the message, so callers can format them apart', () => {
    const error = new ToolError('something went wrong', 'try this instead')
    assert.equal(error.message, 'something went wrong')
    assert.equal(error.hint, 'try this instead')
    assert.equal(error.name, 'ToolError')
  })
})

describe('the commit graph tools', () => {
  test('agentgit_graph returns the view as structure and as text', async () => {
    const result = await call('agentgit_graph')
    const structured = result.structuredContent as { workspaceName: string; nodes: unknown[]; lanes: number }
    assert.equal(typeof structured.workspaceName, 'string')
    assert.equal(Array.isArray(structured.nodes), true)
    assert.equal(typeof structured.lanes, 'number')
    assert.match(textOf(result), /AgenticGit for/)
  })

  test('agentgit_graph is read-only, so a timer may call it', () => {
    const tool = TOOLS.find((candidate) => candidate.name === 'agentgit_graph')!
    assert.equal(tool.annotations.readOnlyHint, true)
    assert.equal(tool.annotations.destructiveHint, false)
  })

  test('agentgit_explain without an id fails with a hint rather than guessing', async () => {
    const result = await call('agentgit_explain')
    assert.equal(result.isError, true)
    assert.match(textOf(result), /needs `oid`/)
    assert.match(textOf(result), /task id/)
  })

  test('agentgit_explain on a commit nobody can find reports a miss without throwing', async () => {
    const result = await call('agentgit_explain', { oid: 'deadbeef' })
    assert.equal(result.isError, true)
    const structured = result.structuredContent as { found: boolean }
    assert.equal(structured.found, false)
    assert.match(textOf(result), /No commit in this graph matches/)
  })

  test('agentgit_ui returns the same view the panel renders itself from', async () => {
    const result = await call('agentgit_ui')
    const structured = result.structuredContent as { nodes: unknown[]; overlay: unknown[] }
    assert.equal(Array.isArray(structured.nodes), true)
    assert.equal(Array.isArray(structured.overlay), true)
  })

  test('a workspace that is not a repository is an empty graph, not a tool failure', async () => {
    const result = await call('agentgit_graph')
    const structured = result.structuredContent as { nodes: unknown[]; diagnostics: { gitError: string | null } }
    assert.deepEqual(structured.nodes, [])
    assert.equal(typeof structured.diagnostics.gitError, 'string', 'the reason git said nothing is reported')
    assert.notEqual(result.isError, true, 'a missing repository is not a failed call')
  })
})
