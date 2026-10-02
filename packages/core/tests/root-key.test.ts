/**
 * Directory identity: one directory, one key.
 *
 * The bug these pin is platform-specific by nature, so the tests state the rule rather than
 * assert one platform's behaviour as universal: {@link rootKey} folds case exactly where the
 * filesystem does. On Linux the case-distinct assertions are the real ones — merging two
 * genuinely different directories would be a worse bug than the one being fixed.
 *
 * Named `root-key.test.ts` rather than `paths.test.ts` because this repository already had a
 * `paths.test.ts`, covering the path canonicalisation in `workspace.ts` and `preflight.ts`. The
 * two are different subjects and both sets of tests have to exist.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { isWithinRoot, normalizeRoot, rootKey, sameRoot } from '../src/paths.ts'
import { removeScratch } from './helpers.ts'

const CASE_INSENSITIVE_FS = process.platform === 'win32' || process.platform === 'darwin'

describe('normalizeRoot', () => {
  test('resolves to an absolute path without throwing on a directory that does not exist', () => {
    const missing = join(tmpdir(), 'agentgit-paths-definitely-not-here')
    assert.equal(normalizeRoot(missing), missing)
  })

  test('returns the casing the filesystem uses for a directory that exists', () => {
    const root = mkdtempSync(join(tmpdir(), 'agentgit-paths-'))
    try {
      // `mkdtempSync` already returns the on-disk casing, so this is a round trip: whatever the
      // platform produced must survive normalisation unchanged.
      assert.equal(normalizeRoot(root), root)
    } finally {
      removeScratch(root)
    }
  })
})

describe('rootKey', () => {
  test('collapses two casings of one directory on a case-insensitive filesystem', () => {
    const upper = join(tmpdir(), 'AgentGit-Case').replace(/^([A-Za-z]):/, (m) => m.toUpperCase())
    const lower = upper.toLowerCase()
    if (CASE_INSENSITIVE_FS) {
      assert.equal(rootKey(upper), rootKey(lower))
    } else {
      assert.notEqual(rootKey(upper), rootKey(lower), 'on Linux these are two real directories')
    }
  })

  test('makes sameRoot follow the same rule', () => {
    const a = join(tmpdir(), 'agentgit-same-root')
    assert.equal(sameRoot(a, a), true)
    assert.equal(sameRoot(a, `${a}-other`), false)
  })
})

describe('isWithinRoot', () => {
  test('treats a directory as inside itself', () => {
    const root = join(tmpdir(), 'agentgit-contain')
    assert.equal(isWithinRoot(root, root), true)
  })

  test('treats a child as inside its parent', () => {
    const root = join(tmpdir(), 'agentgit-contain')
    mkdirSync(join(root, 'src'), { recursive: true })
    try {
      assert.equal(isWithinRoot(root, join(root, 'src')), true)
    } finally {
      removeScratch(root)
    }
  })

  test('does not treat a prefix-sharing sibling as a child', () => {
    // `/repo-other` starts with `/repo`; a raw string-prefix test would call it contained.
    const root = join(tmpdir(), 'agentgit-contain')
    assert.equal(isWithinRoot(root, `${root}-other`), false)
  })

  test('ignores case where the filesystem does', () => {
    const root = join(tmpdir(), 'agentgit-contain')
    if (!CASE_INSENSITIVE_FS) return
    assert.equal(isWithinRoot(root, join(root.toUpperCase(), 'src')), true)
  })
})
