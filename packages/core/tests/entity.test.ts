/**
 * Entity subjects: the two resolutions a write can be named at.
 *
 * The assertion that matters most here is the one keeping a shared *file* from becoming a
 * duplicate on its own. Overlap alone is not evidence of the same work, and a detector that
 * forgets it fires on every pair of agents editing one large file.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import {
  entitySubjectOf,
  isStructuralDuplicate,
  matchStrength,
  strongestStrength,
  subjectOfProposal,
} from '../src/entity.ts'

describe('entity subjects', () => {
  test('a file entity has a file and no symbol', () => {
    assert.deepEqual(entitySubjectOf({ kind: 'file', identifier: 'src/a.py', path: 'src/a.py' }), {
      file: 'src/a.py',
      symbol: null,
    })
  })

  test('a symbol entity keeps the file it lives in', () => {
    assert.deepEqual(entitySubjectOf({ kind: 'symbol', identifier: 'resolve', path: 'src/a.py' }), {
      symbol: 'resolve',
      file: 'src/a.py',
    })
  })

  test('a symbol whose path is itself carries no file, rather than echoing the symbol as one', () => {
    assert.deepEqual(entitySubjectOf({ kind: 'symbol', identifier: 'resolve', path: 'resolve' }), {
      symbol: 'resolve',
      file: null,
    })
  })
})

describe('proposal subjects', () => {
  test('the key decides which entity this is, even when the path says otherwise', () => {
    // The path is the human-facing spelling and may be a leftover default. The key is
    // authoritative, and reading the path first would compare two unrelated entities as one.
    assert.deepEqual(subjectOfProposal({ entityKey: 'file::z.py', entityPath: 'a.py' }), {
      file: 'z.py',
      symbol: null,
    })
  })

  test('a symbol key is read as a symbol, not as a file with an odd name', () => {
    assert.deepEqual(subjectOfProposal({ entityKey: 'symbol::resolve', entityPath: 'src/a.py' }), {
      symbol: 'resolve',
      file: 'src/a.py',
    })
  })

  test('a separate symbol field is kept alongside the file it lives in', () => {
    assert.deepEqual(
      subjectOfProposal({ entityKey: 'symbol::resolve', entityPath: 'src/a.py', symbol: 'resolve' }),
      { symbol: 'resolve', file: 'src/a.py' },
    )
  })
})

describe('match strength', () => {
  test('a shared symbol outranks a shared file', () => {
    assert.equal(
      matchStrength({ file: 'src/a.py', symbol: 'resolve' }, { file: 'src/b.py', symbol: 'resolve' }),
      'symbol',
    )
    assert.equal(
      matchStrength({ file: 'src/a.py', symbol: null }, { file: 'src/a.py', symbol: null }),
      'file',
    )
  })

  test('a symbol claim meets a path claim about the same file at file strength', () => {
    assert.equal(
      matchStrength({ file: 'src/a.py', symbol: 'resolve' }, { file: 'src/a.py', symbol: null }),
      'file',
    )
  })

  test('unrelated entities do not match', () => {
    assert.equal(matchStrength({ file: 'src/a.py', symbol: null }, { file: 'src/z.py', symbol: null }), null)
    assert.equal(matchStrength({ file: null, symbol: 'resolve' }, { file: null, symbol: 'other' }), null)
  })

  test('strongestStrength folds a list without weakening', () => {
    assert.equal(strongestStrength(null, 'file'), 'file')
    assert.equal(strongestStrength('file', 'symbol'), 'symbol')
    assert.equal(strongestStrength(null, null), null)
  })
})

describe('structural duplication', () => {
  test('only a symbol match stands on its own', () => {
    assert.equal(isStructuralDuplicate('symbol'), true)
    assert.equal(isStructuralDuplicate('file'), false)
    assert.equal(isStructuralDuplicate(null), false)
  })
})
