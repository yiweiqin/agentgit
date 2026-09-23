/**
 * Store tests. The ledger's path resolution is the one piece of configuration that
 * silently ruins an experiment when wrong: every arm writing to the same file
 * would merge five arms' data into one and make the comparison meaningless.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { LEDGER_FILENAME, appendLedgerLine, ledgerFilePath } from '../src/store.ts'

describe('ledgerFilePath', () => {
  test('treats a bare directory as a directory and appends the fixed file name', () => {
    // Expectations use `resolve` too, so the assertions describe the same
    // semantics on POSIX and Windows rather than pinning one platform's separators.
    const resolved = ledgerFilePath('.coord-ledger', '/work')
    assert.equal(resolved, join(resolve('/work', '.coord-ledger'), LEDGER_FILENAME))
  })

  test('honours an explicit .jsonl path as the file itself', () => {
    assert.equal(ledgerFilePath('runs/A1/ledger.jsonl', '/work'), resolve('/work', 'runs/A1/ledger.jsonl'))
  })

  test('honours an absolute directory', () => {
    const resolved = ledgerFilePath('/var/ledgers/A3', '/work')
    assert.equal(resolved, join('/var/ledgers/A3', LEDGER_FILENAME))
    assert.ok(resolved.includes('A3'), 'the arm directory must survive into the path')
  })

  test('falls back to the working directory when unset, rather than writing nowhere', () => {
    assert.equal(ledgerFilePath('', '/work'), join('/work', LEDGER_FILENAME))
  })

  test('distinct arm paths stay distinct, which is what keeps arms separate', () => {
    const a = ledgerFilePath('runs/A1', '/work')
    const b = ledgerFilePath('runs/A2', '/work')
    assert.notEqual(a, b)
  })
})

describe('appendLedgerLine', () => {
  test('creates missing directories and appends in order without overwriting', () => {
    const root = mkdtempSync(join(tmpdir(), 'coord-ledger-'))
    const file = join(root, 'nested', 'deeper', LEDGER_FILENAME)
    appendLedgerLine(file, '{"n":1}\n')
    appendLedgerLine(file, '{"n":2}\n')
    assert.equal(readFileSync(file, 'utf8'), '{"n":1}\n{"n":2}\n')
  })

  test('appends LF-terminated records, so a ledger diffs cleanly across platforms', () => {
    const root = mkdtempSync(join(tmpdir(), 'coord-ledger-'))
    const file = join(root, LEDGER_FILENAME)
    appendLedgerLine(file, '{"n":1}\n')
    assert.equal(readFileSync(file, 'utf8').endsWith('\n'), true)
  })
})
