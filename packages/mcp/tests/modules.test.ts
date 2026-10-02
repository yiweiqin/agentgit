import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createServer } from '../src/server.ts'

function write(root: string, rel: string, contents: string): void {
  const file = join(root, rel)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, contents, 'utf8')
}

test('agentgit_modules reports the derived graph and resolves a path to its module', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agentgit-mcp-modules-'))
  try {
    write(root, 'packages/core/package.json', JSON.stringify({ name: '@app/core' }))
    write(root, 'packages/core/src/entity.ts', 'export const x = 1\n')
    write(root, 'packages/cli/package.json', JSON.stringify({ name: '@app/cli' }))
    write(root, 'packages/cli/src/main.ts', "import { x } from '@app/core'\n")

    const server = createServer()
    const call = async (args: Record<string, unknown> = {}) => {
      const response = await server.handle({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'agentgit_modules', arguments: { workspace: root, session: 's1', task: 't1', ...args } },
      })
      const result = (response as { result: { isError?: boolean; structuredContent: unknown } }).result
      assert.ok(result)
      assert.notEqual(result.isError, true, JSON.stringify(result))
      return result.structuredContent as Record<string, unknown>
    }

    const view = await call()
    assert.equal(view.moduleCount, 2)
    assert.equal(view.importEdges, 1)
    assert.equal((view.core as Array<{ id: string }>)[0].id, 'packages/core')

    const detail = await call({ path: 'packages/cli/src/main.ts' })
    assert.deepEqual(detail.dependsOn, ['packages/core'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
