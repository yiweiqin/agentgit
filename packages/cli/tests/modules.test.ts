import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const repo = join(import.meta.dirname, '../../..')
const cli = join(repo, 'packages/cli/src/main.ts')

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'agentgit-cli-modules-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function write(rel: string, contents: string): void {
  const file = join(root, rel)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, contents, 'utf8')
}
function run(args: string[]) {
  // `--no-co-change` keeps the git walk out of a temp directory that is not a repository.
  return spawnSync(process.execPath, [cli, 'modules', ...args, '--workspace', root, '--no-co-change'], {
    encoding: 'utf8',
    cwd: root,
  })
}

test('agentgit modules prints the derived graph and one module in detail', () => {
  write('packages/core/package.json', JSON.stringify({ name: '@app/core' }))
  write('packages/core/src/entity.ts', 'export const x = 1\n')
  write('packages/cli/package.json', JSON.stringify({ name: '@app/cli' }))
  write('packages/cli/src/main.ts', "import { x } from '@app/core'\n")

  const json = run(['--json'])
  assert.equal(json.status, 0, json.stderr)
  const view = JSON.parse(json.stdout)
  assert.equal(view.moduleCount, 2)
  assert.equal(view.importEdges, 1)
  assert.equal(view.core[0].id, 'packages/core')

  const detail = run(['packages/cli', '--json'])
  assert.equal(detail.status, 0, detail.stderr)
  assert.deepEqual(JSON.parse(detail.stdout).dependsOn, ['packages/core'])

  const missing = run(['nope'])
  assert.equal(missing.status, 2)
  assert.match(missing.stderr, /no module 'nope'/)
})

test('agentgit modules reports what the scan could not resolve', () => {
  write('src/a.ts', "import 'lodash'\n")
  const json = run(['--json'])
  assert.equal(json.status, 0, json.stderr)
  assert.equal(JSON.parse(json.stdout).unresolved, 1)
})
