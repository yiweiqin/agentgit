import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  ensureWorkspace,
  publishImpactProjection,
  recordImpactChange,
  recordImpactSession,
  type WorkspacePaths,
} from '@agentgit/core'

/**
 * Tier gating for the module layer, end to end through the push hook.
 *
 * The module layer's whole claim is that it can warn a consumer whose work does not look like
 * the producer's. That claim is only honest if the warning arrives at the *right* moment, so
 * these tests pin the tier boundary rather than the detection: a mechanical coupling is never
 * a write-time interrupt, and a coupling that only runs the wrong way is never injected at all.
 */
const repo = join(import.meta.dirname, '../../..')
const hook = join(repo, 'plugins/agentgit/scripts/hub.mjs')

let paths: WorkspacePaths
beforeEach(() => {
  paths = ensureWorkspace(mkdtempSync(join(tmpdir(), 'agentgit-module-hook-')))
})
afterEach(() => rmSync(paths.root, { recursive: true, force: true }))

function write(rel: string, contents: string): void {
  const file = join(paths.root, rel)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, contents, 'utf8')
}

/** `packages/cli` imports `packages/core` by package name; nothing is declared by hand. */
function workspaceWithImport(): void {
  write('packages/core/package.json', JSON.stringify({ name: '@agentgit/core' }))
  write('packages/core/src/entity.ts', 'export const x = 1\n')
  write('packages/cli/package.json', JSON.stringify({ name: '@agentgit/cli' }))
  write('packages/cli/src/main.ts', "import { x } from '@agentgit/core'\n")
}

function runHook(event: string, session: string): string {
  const result = spawnSync(process.execPath, [hook], {
    encoding: 'utf8',
    cwd: paths.root,
    input: JSON.stringify({ hook_event_name: event, session_id: session, cwd: paths.root }),
  })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout
}

test('a module-derived impact defers to a safe point and is never injected before a write', () => {
  workspaceWithImport()
  // The consumer says nothing about the changed contract and shares no words with the producer,
  // so only the resolved import can recall it.
  recordImpactSession(paths, {
    goal: 'unrelated words about penguins',
    entities: [{ key: 'file::packages/cli/src/main.ts', path: 'packages/cli/src/main.ts', access: 'write' }],
  }, { sessionId: 'cli', taskId: 'tcli' })
  recordImpactChange(paths, {
    stream: 'core-entity', revision: 1, summary: 'Return type changed', compatibility: 'breaking',
    entities: [{ key: 'file::packages/core/src/entity.ts', path: 'packages/core/src/entity.ts', access: 'write' }],
  }, { sessionId: 'core', taskId: 'tcore' })
  publishImpactProjection(paths)

  // A resolved import proves the modules are wired, not that this change breaks this consumer,
  // so the strongest tier it can reach is the safe point — never the write boundary.
  assert.equal(runHook('PreToolUse', 'cli'), '')
  assert.match(runHook('UserPromptSubmit', 'cli'), /breaking_dependency/)
})

test('a coupling that only runs the wrong way is recorded, never injected', () => {
  workspaceWithImport()
  // The change is in the importer and the receiver is the imported module: the receiver is not a
  // consumer of the change, so the evidence is background and must not reach any hook.
  recordImpactChange(paths, {
    stream: 'cli-main', revision: 1, summary: 'Renderer tweak', compatibility: 'compatible',
    entities: [{ key: 'file::packages/cli/src/main.ts', path: 'packages/cli/src/main.ts', access: 'write' }],
  }, { sessionId: 'cli', taskId: 'tcli' })
  recordImpactSession(paths, {
    goal: 'unrelated words about penguins',
    entities: [{ key: 'file::packages/core/src/entity.ts', path: 'packages/core/src/entity.ts', access: 'write' }],
  }, { sessionId: 'core', taskId: 'tcore' })
  publishImpactProjection(paths)

  assert.equal(runHook('PreToolUse', 'core'), '')
  assert.equal(runHook('UserPromptSubmit', 'core'), '')
})
