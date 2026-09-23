/**
 * Tests for the product layer: contracts, leases and the six-verdict preflight.
 *
 * These are the tests that matter most, because every surface — the CLI, the MCP
 * tools, the panel, the board — is a rendering of these decisions. A defect here is
 * a defect everywhere, and it would be reported to a user as confident advice.
 */

import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  acquireLease,
  contestedLeases,
  currentVersion,
  contractsTouchingPath,
  globMatches,
  leasesHeldBy,
  leasesOn,
  liveLeases,
  loadAssumptions,
  loadContracts,
  loadLeases,
  publishContract,
  recordAssumption,
  releaseLease,
  staleAssumptions,
} from '../src/index.ts'
import { buildEvent, entityKey } from '../src/ledger.ts'
import { appendEvent, ensureWorkspace, workspacePaths } from '../src/workspace.ts'
import { kindOfVerdict, preflight, preflightAndClaim, summariseTask } from '../src/preflight.ts'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'agentgit-core-'))
  ensureWorkspace(root)
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function paths() {
  return workspacePaths(root)
}

function write(sessionId: string, taskId: string | null, path: string, intent: string | null, atIso: string): void {
  appendEvent(paths(), buildEvent({
    kind: 'file_write',
    timestampUtc: atIso,
    sessionId,
    taskId,
    entities: [{ kind: 'file', identifier: path, path }],
    intentText: intent,
    hostEvent: 'test',
  }), new Date(atIso))
}

/* -------------------------------------------------------------------------- */
/* contracts                                                                   */
/* -------------------------------------------------------------------------- */

describe('contracts', () => {
  test('versions a name upward and refuses to reuse a version number', () => {
    const first = publishContract(paths(), {
      name: 'auth.identity',
      symbol: 'resolveIdentity',
      declaredIn: 'src/auth.ts',
      breaking: false,
      publishedBy: 'task-a',
      summary: 'resolveIdentity takes a request',
    })
    assert.equal(first.contract.version, 1)
    assert.equal(first.previous, null)

    const second = publishContract(paths(), {
      name: 'auth.identity',
      symbol: 'resolveIdentity',
      declaredIn: 'src/auth.ts',
      breaking: true,
      publishedBy: 'task-a',
      summary: 'resolveIdentity is now async',
    })
    assert.equal(second.contract.version, 2)
    assert.equal(second.previous?.version, 1)

    assert.throws(
      () => publishContract(paths(), {
        name: 'auth.identity',
        version: 1,
        breaking: false,
        publishedBy: 'task-b',
        summary: 'reuse',
      }),
      /not newer/,
    )
  })

  test('reports an assumption behind a breaking version as stale, with the publisher', () => {
    publishContract(paths(), {
      name: 'auth.identity',
      breaking: false,
      publishedBy: 'task-a',
      summary: 'v1',
      publishedAt: '2026-09-01T00:00:00Z',
    })
    recordAssumption(paths(), {
      taskId: 'task-b',
      sessionId: 'session-b',
      contract: 'auth.identity',
      version: 1,
      recordedAt: '2026-09-01T01:00:00Z',
      source: 'declared',
      path: 'src/views.ts',
    })
    publishContract(paths(), {
      name: 'auth.identity',
      breaking: true,
      publishedBy: 'task-a',
      summary: 'now async',
      publishedAt: '2026-09-02T00:00:00Z',
    })

    const stale = staleAssumptions(loadAssumptions(paths()), loadContracts(paths()))
    assert.equal(stale.length, 1)
    assert.equal(stale[0].taskId, 'task-b')
    assert.equal(stale[0].assumedVersion, 1)
    assert.equal(stale[0].currentVersion, 2)
    assert.equal(stale[0].breaking, true)
    assert.equal(stale[0].publishedBy, 'task-a')
  })

  test('a later assumption replaces the earlier one for the same task and contract', () => {
    publishContract(paths(), { name: 'x', breaking: false, publishedBy: 'a', summary: 'v1' })
    recordAssumption(paths(), { taskId: 'b', sessionId: 's', contract: 'x', version: 1, recordedAt: 't1', source: 'inferred', path: null })
    recordAssumption(paths(), { taskId: 'b', sessionId: 's', contract: 'x', version: 1, recordedAt: 't2', source: 'declared', path: null })
    const ledger = loadAssumptions(paths())
    assert.equal(ledger.assumptions.length, 1)
    assert.equal(ledger.assumptions[0].source, 'declared')
  })

  test('finds contracts by declared file and by consumer glob', () => {
    publishContract(paths(), {
      name: 'auth.identity',
      declaredIn: 'src/auth.ts',
      consumers: ['src/views/**/*.ts'],
      breaking: false,
      publishedBy: 'a',
      summary: 'v1',
    })
    const touched = contractsTouchingPath(loadContracts(paths()), 'src/views/user.ts')
    assert.deepEqual(touched.map((contract) => contract.name), ['auth.identity'])
    assert.deepEqual(
      contractsTouchingPath(loadContracts(paths()), 'src/other.ts').map((c) => c.name),
      [],
    )
  })

  test('globs do not let a single star cross a directory boundary', () => {
    assert.equal(globMatches('src/*.ts', 'src/a.ts'), true)
    assert.equal(globMatches('src/*.ts', 'src/deep/a.ts'), false)
    assert.equal(globMatches('src/**/*.ts', 'src/deep/a.ts'), true)
  })

  test('a non-breaking bump is reported but not flagged as breaking', () => {
    publishContract(paths(), { name: 'x', breaking: false, publishedBy: 'a', summary: 'v1', publishedAt: '2026-01-01T00:00:00Z' })
    recordAssumption(paths(), { taskId: 'b', sessionId: 's', contract: 'x', version: 1, recordedAt: 't', source: 'declared', path: null })
    publishContract(paths(), { name: 'x', breaking: false, publishedBy: 'a', summary: 'v2', publishedAt: '2026-01-02T00:00:00Z' })
    const stale = staleAssumptions(loadAssumptions(paths()), loadContracts(paths()))
    assert.equal(stale.length, 1)
    assert.equal(stale[0].breaking, false)
  })
})

/* -------------------------------------------------------------------------- */
/* leases                                                                      */
/* -------------------------------------------------------------------------- */

describe('leases', () => {
  const base = new Date('2026-09-23T10:00:00Z')

  test('grants, then reports a conflict to a different task instead of failing', () => {
    const first = acquireLease(paths(), {
      entityKey: 'file::src/a.ts',
      taskId: 'task-a',
      sessionId: 'session-a',
      reason: 'adding the parser',
      minutes: 20,
    }, base)
    assert.equal(first.granted, true)

    const second = acquireLease(paths(), {
      entityKey: 'file::src/a.ts',
      taskId: 'task-b',
      sessionId: 'session-b',
      reason: 'adding the parser too',
      minutes: 20,
    }, base)
    assert.equal(second.granted, false)
    assert.equal(second.conflicts.length, 1)
    assert.equal(second.conflicts[0].taskId, 'task-a')
  })

  test('expires on its own, so a crashed agent cannot wedge a workspace', () => {
    acquireLease(paths(), {
      entityKey: 'file::src/a.ts',
      taskId: 'task-a',
      sessionId: 'session-a',
      reason: 'x',
      minutes: 5,
    }, base)
    const later = new Date(base.getTime() + 6 * 60_000)
    assert.equal(liveLeases(loadLeases(paths()), later).length, 0)
    const retry = acquireLease(paths(), {
      entityKey: 'file::src/a.ts',
      taskId: 'task-b',
      sessionId: 'session-b',
      reason: 'y',
      minutes: 5,
    }, later)
    assert.equal(retry.granted, true)
  })

  test('renewing keeps the original grant time, so it is one lease and not two', () => {
    acquireLease(paths(), { entityKey: 'file::a.ts', taskId: 't', sessionId: 's', reason: 'x', minutes: 5 }, base)
    const renewed = acquireLease(paths(), {
      entityKey: 'file::a.ts',
      taskId: 't',
      sessionId: 's',
      reason: 'x',
      minutes: 5,
    }, new Date(base.getTime() + 60_000))
    assert.equal(renewed.granted, true)
    assert.equal(renewed.lease?.grantedAt, base.toISOString())
    assert.equal(loadLeases(paths()).leases.length, 1)
  })

  test('a steal takes over deliberately when two tasks genuinely share an entity', () => {
    acquireLease(paths(), { entityKey: 'file::a.ts', taskId: 'a', sessionId: 's1', reason: 'x', minutes: 5 }, base)
    const stolen = acquireLease(paths(), {
      entityKey: 'file::a.ts',
      taskId: 'b',
      sessionId: 's2',
      reason: 'y',
      minutes: 5,
      steal: true,
    }, base)
    assert.equal(stolen.granted, true)
    assert.equal(stolen.conflicts[0].taskId, 'a')
  })

  test('releases one entity or all of them', () => {
    acquireLease(paths(), { entityKey: 'file::a.ts', taskId: 't', sessionId: 's', reason: 'x', minutes: 5 }, base)
    acquireLease(paths(), { entityKey: 'file::b.ts', taskId: 't', sessionId: 's', reason: 'x', minutes: 5 }, base)
    assert.equal(leasesHeldBy(loadLeases(paths()), 't', base).length, 2)
    assert.deepEqual(releaseLease(paths(), 't', 'file::a.ts').released, ['file::a.ts'])
    assert.equal(leasesHeldBy(loadLeases(paths()), 't', base).length, 1)
    assert.deepEqual(releaseLease(paths(), 't').released, ['file::b.ts'])
    assert.equal(loadLeases(paths()).leases.length, 0)
  })

  test('reports two live tasks on one entity as contested', () => {
    acquireLease(paths(), { entityKey: 'file::a.ts', taskId: 'a', sessionId: 's1', reason: 'x', minutes: 5 }, base)
    acquireLease(paths(), { entityKey: 'file::a.ts', taskId: 'b', sessionId: 's2', reason: 'y', minutes: 5, steal: true }, base)
    const contested = contestedLeases(loadLeases(paths()), base)
    assert.equal(contested.length, 1)
    assert.deepEqual(contested[0].tasks, ['a', 'b'])
  })

  test('excludes the caller from its own conflicts', () => {
    acquireLease(paths(), { entityKey: 'file::a.ts', taskId: 'a', sessionId: 's1', reason: 'x', minutes: 5 }, base)
    assert.equal(leasesOn(loadLeases(paths()), 'file::a.ts', 'a', base).length, 0)
    assert.equal(leasesOn(loadLeases(paths()), 'file::a.ts', 'b', base).length, 1)
  })

  test('shareWith lets a named task write under someone else’s lease', () => {
    acquireLease(paths(), {
      entityKey: 'file::a.ts',
      taskId: 'a',
      sessionId: 's1',
      reason: 'x',
      minutes: 5,
      shareWith: ['b'],
    }, base)
    const shared = acquireLease(paths(), {
      entityKey: 'file::a.ts',
      taskId: 'b',
      sessionId: 's2',
      reason: 'y',
      minutes: 5,
    }, base)
    assert.equal(shared.granted, true)
  })
})

/* -------------------------------------------------------------------------- */
/* preflight                                                                   */
/* -------------------------------------------------------------------------- */

describe('preflight verdicts', () => {
  test('allows a write nobody else is on', () => {
    const result = preflight(paths(), {
      taskId: 'task-a',
      sessionId: 'session-a',
      entityKey: 'file::src/a.ts',
      entityPath: 'src/a.ts',
      intentText: 'add a parser helper',
    })
    assert.equal(result.verdict, 'allow')
    assert.equal(result.evidence.competitors.length, 0)
  })

  test('allows a task to keep writing a file it already owns', () => {
    write('session-a', 'task-a', 'src/a.ts', 'add a parser helper', '2026-09-23T09:00:00Z')
    const result = preflight(paths(), {
      taskId: 'task-a',
      sessionId: 'session-a',
      entityKey: 'file::src/a.ts',
      entityPath: 'src/a.ts',
      intentText: 'add a parser helper',
    })
    assert.equal(result.verdict, 'allow')
  })

  test('says reuse when another task is doing the same thing', () => {
    write('session-a', 'task-a', 'src/views.py', 'return json from the view', '2026-09-23T09:00:00Z')
    const result = preflight(paths(), {
      taskId: 'task-b',
      sessionId: 'session-b',
      entityKey: 'file::src/views.py',
      entityPath: 'src/views.py',
      intentText: 'return json from the view',
    })
    assert.equal(result.verdict, 'reuse')
    assert.equal(result.evidence.detection, 'duplicate-intent')
  })

  test('says replan when another task wants the same file for different work', () => {
    write('session-a', 'task-a', 'src/views.py', 'cache the rendered template', '2026-09-23T09:00:00Z')
    const result = preflight(paths(), {
      taskId: 'task-b',
      sessionId: 'session-b',
      entityKey: 'file::src/views.py',
      entityPath: 'src/views.py',
      intentText: 'return json from the view',
    })
    assert.equal(result.verdict, 'replan')
    assert.equal(result.evidence.detection, 'cross-task-conflict')
  })

  test('says reuse when the same task is already writing through another session', () => {
    write('session-a', 'task-a', 'src/views.py', 'return json', '2026-09-23T09:00:00Z')
    const result = preflight(paths(), {
      taskId: 'task-a',
      sessionId: 'session-b',
      entityKey: 'file::src/views.py',
      entityPath: 'src/views.py',
      intentText: 'return json',
    })
    assert.equal(result.verdict, 'reuse')
    assert.equal(result.evidence.detection, 'cross-session-same-task')
  })

  test('says reuse when another task holds a lease for the same work', () => {
    acquireLease(paths(), {
      entityKey: 'file::src/a.ts',
      taskId: 'task-a',
      sessionId: 'session-a',
      reason: 'add a parser helper',
      minutes: 20,
    })
    const result = preflight(paths(), {
      taskId: 'task-b',
      sessionId: 'session-b',
      entityKey: 'file::src/a.ts',
      entityPath: 'src/a.ts',
      intentText: 'add a parser helper',
    })
    assert.equal(result.verdict, 'reuse')
    assert.equal(result.evidence.leaseConflicts.length, 1)
  })

  test('says replan when a lease is held for different work', () => {
    acquireLease(paths(), {
      entityKey: 'file::src/a.ts',
      taskId: 'task-a',
      sessionId: 'session-a',
      reason: 'rewrite the whole module around streams',
      minutes: 20,
    })
    const result = preflight(paths(), {
      taskId: 'task-b',
      sessionId: 'session-b',
      entityKey: 'file::src/a.ts',
      entityPath: 'src/a.ts',
      intentText: 'fix a typo in the docstring',
    })
    assert.equal(result.verdict, 'replan')
  })

  test('says refresh when an assumption is behind a breaking interface', () => {
    publishContract(paths(), {
      name: 'auth.identity',
      symbol: 'resolveIdentity',
      declaredIn: 'src/auth.ts',
      breaking: false,
      publishedBy: 'task-a',
      summary: 'v1',
      publishedAt: '2026-09-01T00:00:00Z',
    })
    recordAssumption(paths(), {
      taskId: 'task-b',
      sessionId: 'session-b',
      contract: 'auth.identity',
      version: 1,
      recordedAt: '2026-09-01T01:00:00Z',
      source: 'declared',
      path: 'src/views.ts',
    })
    publishContract(paths(), {
      name: 'auth.identity',
      symbol: 'resolveIdentity',
      declaredIn: 'src/auth.ts',
      breaking: true,
      publishedBy: 'task-a',
      summary: 'resolveIdentity is now async',
      publishedAt: '2026-09-02T00:00:00Z',
    })

    const result = preflight(paths(), {
      taskId: 'task-b',
      sessionId: 'session-b',
      entityKey: 'file::src/views.ts',
      entityPath: 'src/views.ts',
      intentText: 'render the user name',
    })
    assert.equal(result.verdict, 'refresh')
    assert.equal(result.evidence.staleAssumptions.length, 1)
  })

  test('says review when the breaking interface is the very thing being written', () => {
    publishContract(paths(), {
      name: 'auth.identity',
      symbol: 'resolveIdentity',
      declaredIn: 'src/auth.ts',
      breaking: false,
      publishedBy: 'task-a',
      summary: 'v1',
      publishedAt: '2026-09-01T00:00:00Z',
    })
    recordAssumption(paths(), {
      taskId: 'task-b',
      sessionId: 'session-b',
      contract: 'auth.identity',
      version: 1,
      recordedAt: '2026-09-01T01:00:00Z',
      source: 'declared',
      path: 'src/auth.ts',
    })
    publishContract(paths(), {
      name: 'auth.identity',
      symbol: 'resolveIdentity',
      declaredIn: 'src/auth.ts',
      breaking: true,
      publishedBy: 'task-a',
      summary: 'resolveIdentity is now async',
      publishedAt: '2026-09-02T00:00:00Z',
    })

    const result = preflight(paths(), {
      taskId: 'task-b',
      sessionId: 'session-b',
      entityKey: 'file::src/auth.ts',
      entityPath: 'src/auth.ts',
      intentText: 'add a second argument to resolveIdentity',
    })
    assert.equal(result.verdict, 'review')
    assert.equal(result.evidence.contractConflicts.length, 1)
  })

  test('says wait while the producer of the interface is still in flight', () => {
    publishContract(paths(), {
      name: 'auth.identity',
      symbol: 'resolveIdentity',
      declaredIn: 'src/auth.ts',
      breaking: false,
      publishedBy: 'task-a',
      summary: 'v1',
      publishedAt: '2026-09-01T00:00:00Z',
    })
    recordAssumption(paths(), {
      taskId: 'task-b',
      sessionId: 'session-b',
      contract: 'auth.identity',
      version: 1,
      recordedAt: '2026-09-01T01:00:00Z',
      source: 'declared',
      path: 'src/views.ts',
    })
    publishContract(paths(), {
      name: 'auth.identity',
      symbol: 'resolveIdentity',
      declaredIn: 'src/auth.ts',
      breaking: true,
      publishedBy: 'task-a',
      summary: 'resolveIdentity is now async',
      publishedAt: '2026-09-02T00:00:00Z',
    })
    // task-a is still working: it has written something and reached no terminal state.
    write('session-a', 'task-a', 'src/auth.ts', 'make resolveIdentity async', new Date().toISOString())

    const result = preflight(paths(), {
      taskId: 'task-b',
      sessionId: 'session-b',
      entityKey: 'file::src/views.ts',
      entityPath: 'src/views.ts',
      intentText: 'render the user name',
    })
    assert.equal(result.verdict, 'wait')
  })

  test('carries a version that changes when the inputs change, so a cache cannot go stale', () => {
    const first = preflight(paths(), {
      taskId: 'task-b',
      sessionId: 'session-b',
      entityKey: 'file::src/a.ts',
      entityPath: 'src/a.ts',
      intentText: 'x',
    })
    assert.equal(first.verdict, 'allow')

    write('session-a', 'task-a', 'src/a.ts', 'cache the rendered template', new Date().toISOString())
    const second = preflight(paths(), {
      taskId: 'task-b',
      sessionId: 'session-b',
      entityKey: 'file::src/a.ts',
      entityPath: 'src/a.ts',
      intentText: 'x',
    })
    assert.equal(second.verdict, 'replan')
    assert.notEqual(first.version, second.version) }
  )

  test('a non-blocking bump still allows the write, with the note', () => {
    publishContract(paths(), { name: 'x', breaking: false, publishedBy: 'a', summary: 'v1', publishedAt: '2026-01-01T00:00:00Z' })
    recordAssumption(paths(), { taskId: 'task-b', sessionId: 'session-b', contract: 'x', version: 1, recordedAt: 't', source: 'declared', path: null })
    publishContract(paths(), { name: 'x', breaking: false, publishedBy: 'a', summary: 'v2', publishedAt: '2026-01-02T00:00:00Z' })
    const result = preflight(paths(), {
      taskId: 'task-b',
      sessionId: 'session-b',
      entityKey: 'file::src/a.ts',
      entityPath: 'src/a.ts',
      intentText: 'x',
    })
    assert.equal(result.verdict, 'allow')
    assert.match(result.reason, /without a breaking change/)
  })
})

describe('preflightAndClaim', () => {
  test('records the decision and claims the entity when it is free', () => {
    const result = preflightAndClaim(paths(), {
      taskId: 'task-a',
      sessionId: 'session-a',
      entityKey: 'file::src/a.ts',
      entityPath: 'src/a.ts',
      intentText: 'add a parser helper',
    })
    assert.equal(result.verdict, 'allow')
    const held = leasesHeldBy(loadLeases(paths()), 'task-a')
    assert.equal(held.length, 1)
    assert.equal(held[0].entityKey, 'file::src/a.ts')
  })

  test('does not claim what someone else holds a conflicting lease on', () => {
    acquireLease(paths(), {
      entityKey: 'file::src/a.ts',
      taskId: 'task-a',
      sessionId: 'session-a',
      reason: 'rewrite the module around streams',
      minutes: 20,
    })
    const result = preflightAndClaim(paths(), {
      taskId: 'task-b',
      sessionId: 'session-b',
      entityKey: 'file::src/a.ts',
      entityPath: 'src/a.ts',
      intentText: 'fix a typo',
    })
    assert.equal(result.verdict, 'replan')
    assert.equal(leasesHeldBy(loadLeases(paths()), 'task-b').length, 0)
  })

  test('writes an entity-bearing event, so the ledger sees the touch', () => {
    preflightAndClaim(paths(), {
      taskId: 'task-a',
      sessionId: 'session-a',
      entityKey: 'file::src/a.ts',
      entityPath: 'src/a.ts',
      intentText: 'add a parser helper',
    })
    const again = preflight(paths(), {
      taskId: 'task-b',
      sessionId: 'session-b',
      entityKey: 'file::src/a.ts',
      entityPath: 'src/a.ts',
      intentText: 'add a parser helper',
    })
    assert.equal(again.verdict, 'reuse')
  })
})

describe('summariseTask', () => {
  test('reports the worst verdict rather than the most common one', () => {
    write('session-a', 'task-a', 'src/a.ts', 'cache the template', new Date().toISOString())
    const summary = summariseTask(paths(), 'task-b', 'session-b', ['file::src/a.ts', 'file::src/b.ts'], 'render json')
    assert.equal(summary.verdict, 'replan')
    assert.equal(summary.results.length, 2)
  })
})

describe('quoting', () => {
  test('entity keys and verdict ordering are stable', () => {
    assert.equal(entityKey({ kind: 'file', identifier: 'src/a.ts', path: 'src/a.ts' }), 'file::src/a.ts')
    assert.equal(entityKey({ kind: 'symbol', identifier: 'x', path: 'x' }), 'symbol::x')
    // `review` outranks `allow`; the helper is exported so the CLI cannot reorder it.
    assert.equal(kindOfVerdict('review'), 'blocking')
    assert.equal(kindOfVerdict('allow'), 'clear')
    assert.equal(kindOfVerdict('reuse'), 'advisory')
  })
})
