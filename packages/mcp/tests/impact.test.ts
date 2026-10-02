import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from '../src/server.ts'

test('MCP declarations route to the consumer, expose evidence, and acknowledge without sending chats', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agentgit-mcp-impact-'))
  try {
    const server = createServer()
    const call = async (name: string, session: string, args: Record<string, unknown> = {}) => {
      const response = await server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call',
        params: { name, arguments: { workspace: root, session, ...args } } })
      const result = (response as { result: { isError?: boolean; structuredContent: any } }).result
      assert.ok(result)
      assert.notEqual(result.isError, true, JSON.stringify(result))
      return result.structuredContent
    }
    await call('agentgit_impact_state', 'b', { state: { goal: 'report export', dependencies: [{ entity: 'symbol::Auth.login', relation: 'call' }] } })
    await call('agentgit_impact_publish', 'a', { change: { stream: 'login', revision: 1, summary: 'returns an object', compatibility: 'breaking',
      entities: [{ key: 'symbol::Auth.login', access: 'write' }], evidence: ['src/auth.ts:42'] } })
    const inbox = await call('agentgit_impacts', 'b')
    assert.equal(inbox.notifications[0].category, 'breaking_dependency')
    assert.deepEqual(inbox.notifications[0].references, ['src/auth.ts:42'])
    assert.equal((await call('agentgit_impacts', 'c')).notifications.length, 0)
    await call('agentgit_impact_ack', 'b', { id: inbox.notifications[0].id })
    assert.equal((await call('agentgit_impacts', 'b')).notifications[0].status, 'acknowledged')
  } finally { rmSync(root, { recursive: true, force: true }) }
})
