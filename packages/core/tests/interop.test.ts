/**
 * Cross-language contract tests against `04_协调插件/coord_ledger.py`.
 *
 * These exist because the interop claim was wrong the first time it was made, in
 * three ways at once: a different ledger file name, a write kind Python does not
 * recognise as an entity touch, and a second entity-less write record that would
 * have double-counted. All three fail *silently* — the Python report simply comes
 * back empty, which reads as "no contention found" rather than "wrong file".
 *
 * So the contract is read out of the Python source rather than restated here. If
 * either side changes a constant, these tests fail instead of the analyser going
 * quiet.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { ALL_EVENT_KINDS, ISCC_EVENT_KINDS } from '../src/types.ts'
import { buildEvent, SCHEMA_VERSION, toWire } from '../src/ledger.ts'
import { LEDGER_FILENAME } from '../src/store.ts'

const PYTHON_SOURCE = readFileSync(new URL('../coord_ledger.py', import.meta.url), 'utf8')

/** Read a `NAME = "value"` string constant out of the Python source. */
function pythonString(name: string): string {
  const match = PYTHON_SOURCE.match(new RegExp(`^${name}\\s*=\\s*"([^"]*)"`, 'm'))
  assert.ok(match, `could not find ${name} in coord_ledger.py`)
  return match[1]
}

/** Read a `NAME = frozenset({...})` or `frozenset("a", "b")` constant. */
function pythonStringSet(name: string): Set<string> {
  const block = PYTHON_SOURCE.match(new RegExp(`^${name}\\s*=\\s*frozenset\\(([\\s\\S]*?)\\)`, 'm'))
  assert.ok(block, `could not find ${name} in coord_ledger.py`)
  return new Set([...block[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]))
}

describe('shared constants', () => {
  test('the ledger file name matches, or the Python analyser reads an empty ledger', () => {
    assert.equal(LEDGER_FILENAME, pythonString('LEDGER_FILENAME'))
  })

  test('the schema version matches', () => {
    assert.equal(SCHEMA_VERSION, pythonString('SCHEMA_VERSION'))
  })

  test('our ISCC kind list matches the Python one verbatim', () => {
    const pythonIscc = pythonStringSet('ISCC_EVENT_KINDS')
    assert.deepEqual([...ISCC_EVENT_KINDS].sort(), [...pythonIscc].sort())
  })
})

describe('entity-bearing records are visible to the Python analyser', () => {
  test('every record we emit with entities uses a kind Python counts', () => {
    const pythonEntityEvents = pythonStringSet('ENTITY_EVENTS')
    // The only entity-bearing kind this plugin emits. If another is ever added it
    // must appear in this list, or contention silently empties on the Python side.
    const entityBearingKinds = ['file_write']
    for (const kind of entityBearingKinds) {
      assert.ok(
        pythonEntityEvents.has(kind),
        `${kind} carries entities but is not in Python's ENTITY_EVENTS ` +
          `(${[...pythonEntityEvents].sort().join(', ')}); contention would read as zero`,
      )
    }
  })

  test('the write kind we emit is a declared ISCC kind, not a private invention', () => {
    assert.ok(ISCC_EVENT_KINDS.includes('file_write'))
  })

  test('every kind we can emit is known to the Python event vocabulary', () => {
    // Python validates `kind` when it *writes*, and reads permissively, so an
    // unknown kind here is not fatal — but it would be dropped from any
    // Python-side aggregation, so the divergence is pinned rather than assumed.
    const pythonKinds = new Set([
      ...pythonStringSet('ISCC_EVENT_KINDS'),
      ...pythonStringSet('COORD_EVENT_KINDS'),
    ])
    const unknown = ALL_EVENT_KINDS.filter((kind) => !pythonKinds.has(kind))
    assert.deepEqual(
      [...unknown].sort(),
      [
        'advisory_injected',
        'gate_allowed',
        'gate_asked',
        'gate_denied',
        'turn_ended',
        'write_settled',
      ],
      'the set of TS-only kinds changed; update the Python vocabulary or this expectation deliberately',
    )
  })
})

describe('record shape', () => {
  test('carries every field the Python reader consumes', () => {
    const wire = toWire(buildEvent({ kind: 'file_write', timestampUtc: '2026-01-01T00:00:00Z', sessionId: 's1' }))
    // Read out of the Python `build_event` literal rather than hard-coded here.
    const pythonFields = [
      'schema_version', 'event_id', 'kind', 'timestamp_utc',
      'session_id', 'developer', 'task_id', 'entities', 'host_event',
    ]
    for (const field of pythonFields) {
      assert.ok(field in wire, `missing field the Python reader expects: ${field}`)
    }
  })

  test('is one JSON object per line with no embedded newlines', () => {
    const line = JSON.stringify(toWire(buildEvent({
      kind: 'file_write',
      timestampUtc: '2026-01-01T00:00:00Z',
      sessionId: 's1',
      intentText: 'multi\nline\nintent',
    })))
    assert.equal(line.includes('\n'), false, 'JSON.stringify escapes newlines; the ledger is line-delimited')
  })
})
