/**
 * One agent, three writers, one task.
 *
 * Three separate programs attribute work to a task, and they cannot import each other's
 * rule: the hook is a dependency-free script Codex spawns per tool call, the CLI is a
 * user-facing command, and the MCP server is a long-lived process the host launches. Each
 * carries its own fallback for "nobody declared a task, so the session is the task".
 *
 * When two of those spellings drift apart the failure is nearly invisible. The ledger
 * still fills, the board still renders, and the counts look plausible — but one agent's
 * work is split across two task ids, so its own earlier write is no longer recognised as
 * its own ground. Every collision it should have reported reads as clear, and the product
 * fails exactly where it claims to work. Nothing short of driving all three and reading
 * the ledger catches that, which is what this file does.
 */

import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { buildBoardView, readAllEvents, workspacePaths } from '@agentgit/core'

const REPO = join(import.meta.dirname, '..', '..', '..')
const TRACK = join(REPO, 'plugins', 'agentgit', 'scripts', 'track.mjs')
const CLI = join(REPO, 'packages', 'cli', 'src', 'main.ts')
const MCP = join(REPO, 'packages', 'mcp', 'src', 'main.ts')

/** One session, in one workspace, doing one thing. */
const SESSION = 'session-attribution'
const FILE = 'src/limiter.py'

let workspace: string

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'agentgit-attribution-'))
  // A claimed workspace, so the hook is permitted to record in it.
  mkdirSync(join(workspace, '.agentgit'), { recursive: true })
})

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true })
})

/** The hook, as Codex runs it: payload in, nothing out. */
function hookWrite(): void {
  const payload = {
    hook_event_name: 'PreToolUse',
    session_id: SESSION,
    cwd: workspace,
    tool_name: 'str_replace',
    tool_input: { file_path: join(workspace, FILE), description: 'add rate limiting' },
  }
  const result = spawnSync(process.execPath, [TRACK], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...process.env, AGENTGIT_MACHINE: 'test-machine' },
  })
  assert.equal(result.status, 0, `the hook failed: ${result.stderr}`)
}

/** The CLI, as a user or a wrapper script runs it. The path is a positional. */
function cliPreflight(): void {
  const result = spawnSync(
    process.execPath,
    [CLI, 'preflight', FILE, '--workspace', workspace, '--session', SESSION, '--intent', 'add rate limiting', '--claim'],
    { encoding: 'utf8' },
  )
  assert.equal(
    result.status === 0 || result.status === 1,
    true,
    `the CLI failed (exit ${result.status}): ${result.stderr}${result.stdout}`,
  )
}

/** The MCP server, as the host runs it: newline-delimited JSON-RPC on stdio. */
function mcpPreflightClaim(): Record<string, unknown>[] {
  const messages = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'agentgit_preflight',
        arguments: {
          session: SESSION,
          path: FILE,
          intent: 'add rate limiting',
          claim: true,
        },
      },
    },
  ]
  const result = spawnSync(process.execPath, [MCP, '--workspace', workspace], {
    input: `${messages.map((message) => JSON.stringify(message)).join('\n')}\n`,
    encoding: 'utf8',
  })
  assert.equal(result.status, 0, `the MCP server failed: ${result.stderr}`)
  return result.stdout
    .trim()
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

describe('one session is one task, whichever program recorded the work', () => {
  test('the hook, the CLI and the MCP server all attribute to the same task', () => {
    hookWrite()
    cliPreflight()
    const responses = mcpPreflightClaim()

    // The call must have succeeded, or the rest of this test would be measuring the
    // absence of a record rather than its attribution.
    const call = responses.find((response) => response.id === 2)
    assert.ok(call, 'the MCP server answered the tool call')
    assert.equal(
      (call.result as Record<string, unknown> | undefined)?.isError,
      undefined,
      `the MCP call failed: ${JSON.stringify(call)}`,
    )

    const { events, malformed } = readAllEvents(workspacePaths(workspace))
    assert.equal(malformed, 0)
    assert.ok(events.length >= 3, `expected all three writers to land, got ${events.length}`)

    const attributed = new Set(events.map((event) => event.taskId))
    assert.deepEqual(
      [...attributed],
      [SESSION],
      `three programs wrote ${attributed.size} task ids for one session: ${[...attributed].join(', ')}`,
    )

    // The unjoined consequence: one task, not three, so the agent's own earlier write is
    // recognised as its own work and the collision is reported.
    const view = buildBoardView(workspacePaths(workspace))
    assert.equal(view.tasks.length, 1, 'one session doing one thing is one task')
    assert.equal(view.tasks[0]?.taskId, SESSION)
  })
})
