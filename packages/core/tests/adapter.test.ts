/**
 * Adapter tests. The translation from host payloads to ledger vocabulary is the
 * most likely place for a silent coverage hole: a tool whose arguments are not
 * understood records nothing, and the loss is invisible unless it is measured.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import {
  PATH_ARGUMENT_KEYS,
  classifyTool,
  extractIntent,
  extractPaths,
  safeHandler,
  sessionIdOf,
  toEntities,
} from '../src/adapter.ts'

describe('classifyTool', () => {
  test('recognises the write family', () => {
    assert.equal(classifyTool('write'), 'write')
    assert.equal(classifyTool('str_replace_editor'), 'write')
    assert.equal(classifyTool('Write'), 'write', 'matching is case-insensitive')
  })

  test('recognises shells, whose file effects are not statically visible', () => {
    assert.equal(classifyTool('bash'), 'shell')
  })

  test('reports unknown names rather than guessing', () => {
    assert.equal(classifyTool('some_mcp_tool'), 'unknown')
    assert.equal(classifyTool(null), 'unknown')
    assert.equal(classifyTool(''), 'unknown')
  })
})

describe('extractPaths', () => {
  test('reads the priority argument keys', () => {
    assert.deepEqual(extractPaths({ file_path: 'src/a.py' }), ['src/a.py'])
    assert.deepEqual(extractPaths({ path: 'src/a.py' }), ['src/a.py'])
  })

  test('normalises separators and leading ./ so contention is not defeated by spelling', () => {
    assert.deepEqual(extractPaths({ file_path: './src\\a.py' }), ['src/a.py'])
  })

  test('walks multi-file container shapes one level deep', () => {
    assert.deepEqual(
      extractPaths({ edits: [{ file_path: 'a.py' }, { file_path: 'b.py' }] }),
      ['a.py', 'b.py'],
    )
    assert.deepEqual(extractPaths({ files: ['a.py', 'b.py'] }), ['a.py', 'b.py'])
  })

  test('returns every candidate, because keeping one would understate contention', () => {
    assert.deepEqual(extractPaths({ file_path: 'a.py', target: 'b.py' }), ['a.py', 'b.py'])
  })

  test('deduplicates repeats', () => {
    assert.deepEqual(extractPaths({ edits: [{ file_path: 'a.py' }, { path: 'a.py' }] }), ['a.py'])
  })

  test('returns nothing for unrecognised, empty or malformed arguments', () => {
    for (const args of [{ command: 'ls' }, {}, null, undefined, 42, { file_path: '' }, { path: '   ' }]) {
      assert.deepEqual(extractPaths(args), [], `args=${JSON.stringify(args)}`)
    }
  })

  test('accepts a bare string argument', () => {
    assert.deepEqual(extractPaths('a.py'), ['a.py'])
  })
})

describe('extractIntent', () => {
  test("prefers the agent's own description", () => {
    assert.equal(extractIntent({ description: 'add caching', command: 'python -c 1' }), 'add caching')
  })

  test('falls back to the edited literals, which describe the change when no goal is stated', () => {
    const intent = extractIntent({ old_str: 'return str(x)', new_str: 'return jsonify(x)' })
    assert.match(intent!, /old_str=return str\(x\)/)
    assert.match(intent!, /new_str=return jsonify\(x\)/)
  })

  test('falls back to the raw command last', () => {
    assert.equal(extractIntent({ command: 'pytest -q' }), 'pytest -q')
  })

  test('returns null when there is nothing to read', () => {
    assert.equal(extractIntent({}), null)
    assert.equal(extractIntent(null), null)
    assert.equal(extractIntent({ command: '   ' }), null)
  })

  test('caps length so one huge patch cannot flood the ledger', () => {
    const intent = extractIntent({ new_str: 'x'.repeat(5000) }, 100)
    assert.equal(intent!.length, 100)
  })
})

describe('toEntities', () => {
  test('produces file entities by default and symbol entities on request', () => {
    assert.deepEqual(toEntities(['a.py']), [{ kind: 'file', identifier: 'a.py', path: 'a.py' }])
    assert.deepEqual(toEntities(['a.py'], 'symbol'), [{ kind: 'symbol', identifier: 'a.py', path: 'a.py' }])
  })
})

describe('sessionIdOf', () => {
  test('reads the id shapes the host uses', () => {
    assert.equal(sessionIdOf('sess-1'), 'sess-1')
    assert.equal(sessionIdOf({ id: 'sess-1' }), 'sess-1')
    assert.equal(sessionIdOf({ sessionId: 'sess-1' }), 'sess-1')
    assert.equal(sessionIdOf({ session: { id: 'sess-1' } }), 'sess-1')
  })

  test('is stable for the same object, so later events keep the same attribution', () => {
    const opaque = { some: 'host object with no id' }
    const first = sessionIdOf(opaque)
    assert.ok(first)
    assert.equal(sessionIdOf(opaque), first, 'a repeated lookup must not mint a new identity')
  })

  test('gives distinct identities to distinct anonymous objects', () => {
    assert.notEqual(sessionIdOf({ a: 1 }), sessionIdOf({ b: 2 }))
  })

  test('returns null when there is nothing to attribute', () => {
    assert.equal(sessionIdOf(null), null)
    assert.equal(sessionIdOf(undefined), null)
    assert.equal(sessionIdOf(42), null)
    assert.equal(sessionIdOf(''), null)
  })
})

describe('safeHandler', () => {
  test('contains a synchronous throw and reports it', () => {
    const errors: string[] = []
    const wrapped = safeHandler('step', () => {
      throw new Error('boom')
    }, (name, error) => errors.push(`${name}:${(error as Error).message}`))

    assert.equal(wrapped(), undefined)
    assert.deepEqual(errors, ['step:boom'])
  })

  test('contains an asynchronous rejection, which is the likelier failure in a waterfall', async () => {
    const errors: string[] = []
    const wrapped = safeHandler('pre-execute', async () => {
      throw new Error('async boom')
    }, (name) => errors.push(name))

    const result = await wrapped()
    assert.equal(result, undefined)
    assert.deepEqual(errors, ['pre-execute'])
  })

  test('passes through a successful result untouched, including falsy ones', () => {
    const ok = safeHandler('x', (n: number) => n * 2, () => {})
    assert.equal(ok(21), 42)
    const falsy = safeHandler('x', () => 0, () => {})
    assert.equal(falsy(), 0)
  })

  test('forwards arguments, so a waterfall handler can still call next()', () => {
    const wrapped = safeHandler('x', (a: string, b: string) => a + b, () => {})
    assert.equal(wrapped('a', 'b'), 'ab')
  })
})

describe('path argument coverage', () => {
  test('the declared keys are all actually consulted', () => {
    for (const key of PATH_ARGUMENT_KEYS) {
      assert.deepEqual(extractPaths({ [key]: 'a.py' }), ['a.py'], `key ${key} was not consulted`)
    }
  })
})
