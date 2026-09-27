/**
 * `agentgit desktop`, for the records the two new flows write.
 *
 * The command is the way back for both of them: `/agentgit` writes the workspace record through the
 * MCP tool, and the offer to a repository that has not opted in writes a machine-level one. This
 * file checks the pair of things that cannot be checked anywhere else:
 *
 * 1. **Declining must not opt the repository in.** `workspaceOf` creates `.agentgit`, so a refusal
 *    routed through it would create the very thing the offer was careful not to create. That is why
 *    the machine-level flags resolve the root without claiming it, and why the assertion here is
 *    about a directory that must still be empty.
 * 2. **The records are readable, and a refusal is terminal.** Both are checked through the library's
 *    own rules rather than through a string match, so this fails if the command writes a field the
 *    hook does not read.
 */

import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { initOfferFor, initOffersPath, readDesktopState, shouldOfferInit, workspacePaths } from '@agentgit/core'

const REPO = join(import.meta.dirname, '..', '..', '..')
const CLI = join(REPO, 'packages', 'cli', 'src', 'main.ts')

let workspace: string
let machine: string

interface Run {
  readonly code: number
  readonly out: string
  readonly err: string
}

/** The CLI as the user runs it, with the machine-level record pointed at a scratch directory. */
function cli(...args: string[]): Run {
  const result = spawnSync(process.execPath, [CLI, ...args, '--workspace', workspace], {
    encoding: 'utf8',
    env: { ...process.env, AGENTGIT_HOME: machine, AGENTGIT_SESSION: 'mine' },
  })
  if (result.error) throw result.error
  return { code: result.status ?? -1, out: result.stdout ?? '', err: result.stderr ?? '' }
}

function initOffers() {
  return initOfferFor(workspace, { AGENTGIT_HOME: machine })
}

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'agentgit-desktop-cli-'))
  machine = mkdtempSync(join(tmpdir(), 'agentgit-desktop-cli-home-'))
})

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true })
  rmSync(machine, { recursive: true, force: true })
})

describe('declining the offer for a repository that has not opted in', () => {
  test('records the refusal without creating anything in the repository', () => {
    const run = cli('desktop', '--decline-init')

    assert.equal(run.code, 0, run.err)
    assert.equal(existsSync(join(workspace, '.agentgit')), false, 'a refusal must not opt the repository in')
    assert.ok(initOffers()?.declinedAt, 'the refusal must be recorded on the machine')
    // And it is terminal, by the rule the hook itself runs.
    assert.equal(shouldOfferInit(initOffers(), 'repo', new Date()), false)
  })

  test('reports where it was recorded, and how to undo it', () => {
    const run = cli('desktop', '--decline-init')

    assert.match(run.out, /will not be enabled/i)
    assert.match(run.out, /--clear-init/)
    assert.ok(run.out.includes(initOffersPath({ AGENTGIT_HOME: machine })))
  })

  test('clearing it makes the repository offerable again', () => {
    cli('desktop', '--decline-init')
    const run = cli('desktop', '--clear-init')

    assert.equal(run.code, 0, run.err)
    assert.equal(initOffers(), null)
    assert.equal(shouldOfferInit(initOffers(), 'repo', new Date()), true)
  })

  test('clearing a repository that was never refused is a no-op, not an error', () => {
    const run = cli('desktop', '--clear-init')

    assert.equal(run.code, 0, run.err)
    assert.match(run.out, /nothing to clear/i)
  })
})

describe('the two records /agentgit writes', () => {
  test('pinning and enabling are recorded, and shown in the report', () => {
    const run = cli('desktop', '--pin', 'thread-1', '--enable')

    assert.equal(run.code, 0, run.err)
    const state = readDesktopState(workspacePaths(workspace))
    assert.ok(state?.pinnedThreads['thread-1'], 'the conversation is pinned')
    assert.ok(state?.enabledAt, 'and the workspace is marked enabled')
    assert.match(run.out, /thread-1/)
    assert.match(run.out, /enabled/)
  })

  test('a second enable does not move the first instant', () => {
    cli('desktop', '--enable')
    const first = readDesktopState(workspacePaths(workspace))?.enabledAt
    cli('desktop', '--enable')

    assert.equal(readDesktopState(workspacePaths(workspace))?.enabledAt, first)
  })

  test('a second conversation can be pinned without unpinning the first', () => {
    cli('desktop', '--pin', 'thread-1')
    cli('desktop', '--pin', 'thread-2')

    assert.deepEqual(
      Object.keys(readDesktopState(workspacePaths(workspace))?.pinnedThreads ?? {}).sort(),
      ['thread-1', 'thread-2'],
    )
  })

  test('--json carries both records as structure', () => {
    cli('desktop', '--pin', 'thread-1', '--enable')
    const run = cli('desktop', '--json')
    const parsed = JSON.parse(run.out) as {
      state: { pinnedThreads: Record<string, string>; enabledAt: string | null }
    }

    assert.equal(parsed.state.pinnedThreads['thread-1'] !== undefined, true)
    assert.ok(parsed.state.enabledAt)
  })
})
