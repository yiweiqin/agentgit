import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

/**
 * The module criterion as the CLI actually invokes it.
 *
 * The unit tests hand `preflight` a query object with a path already in it, which is exactly
 * the thing the CLI used to throw away: `--symbol` dropped `entityPath`, so a symbol-level
 * preflight could never be placed in a module and the dependency edge could never be seen.
 * These cases go through argument parsing, so that regression cannot come back unnoticed.
 */
const repo = join(import.meta.dirname, '../../..')
const cli = join(repo, 'packages/cli/src/main.ts')

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'agentgit-cli-module-preflight-'))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

function write(rel: string, contents: string): void {
  const file = join(root, rel)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, contents, 'utf8')
}

/** `packages/cli` imports `packages/core`, resolved through the workspace package names. */
function wiredWorkspace(): void {
  write('packages/core/package.json', JSON.stringify({ name: '@agentgit/core' }))
  write('packages/core/src/entity.ts', 'export const x = 1\n')
  write('packages/cli/package.json', JSON.stringify({ name: '@agentgit/cli' }))
  write('packages/cli/src/main.ts', "import { x } from '@agentgit/core'\n")
}

function run(args: string[]): { status: number | null; out: string; json: unknown } {
  const result = spawnSync(process.execPath, [cli, ...args, '--workspace', root], { encoding: 'utf8', cwd: root })
  const out = `${result.stdout}${result.stderr}`
  let json: unknown = null
  try {
    json = JSON.parse(result.stdout)
  } catch {
    json = null
  }
  return { status: result.status, out, json }
}

test('a symbol-level preflight still carries its path, so the dependency edge is seen', () => {
  wiredWorkspace()
  // T1 lands in the consumer module. Different file, different words, so the entity view is
  // empty and the only thing that can connect the two is the import edge.
  const first = run(['preflight', 'packages/cli/src/main.ts', '--task', 'T1', '--session', 's1',
    '--intent', 'render the settings screen', '--claim'])
  assert.equal(first.status, 0, first.out)

  const second = run(['preflight', 'packages/core/src/entity.ts', '--symbol=entity.x',
    '--task', 'T2', '--session', 's2', '--intent', 'change the identity helper', '--json'])
  const result = second.json as { verdict: string; entityKey: string; reason: string }
  assert.equal(result.entityKey, 'symbol::entity.x')
  assert.equal(result.verdict, 'review', second.out)
  assert.match(result.reason, /is imported by packages\/cli/)
  assert.match(result.reason, /task T1/)
})

test('moduleRouting=off turns the CLI criterion off, which is the ablation', () => {
  wiredWorkspace()
  run(['config', 'moduleRouting', 'off'])
  run(['preflight', 'packages/cli/src/main.ts', '--task', 'T1', '--session', 's1',
    '--intent', 'render the settings screen', '--claim'])

  const result = run(['preflight', 'packages/core/src/entity.ts', '--symbol=entity.x',
    '--task', 'T2', '--session', 's2', '--intent', 'change the identity helper', '--json']).json as { verdict: string }
  assert.equal(result.verdict, 'allow')
})
