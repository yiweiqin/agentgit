/**
 * The path canonicalisation both halves of the plugin depend on.
 *
 * These tests exist because every failure mode here is silent. A key built from the
 * wrong base does not raise anything — it just matches nothing, so collisions go
 * unreported and two agents edit one file while the ledger insists the ground is free.
 * The only way to notice is to pin the exact strings.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, posix, win32 } from 'node:path'

import { canonicalEntityPath, toWorkspaceRelative } from '../src/workspace.ts'
import { keyOf } from '../src/preflight.ts'

const WINDOWS = process.platform === 'win32'

/** A root in the platform's own spelling, so `resolve` does not mangle it. */
function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'agentgit-paths-'))
}

describe('toWorkspaceRelative', () => {
  test('makes an absolute path inside the workspace relative', () => {
    const root = tempRoot()
    try {
      assert.equal(toWorkspaceRelative(root, join(root, 'src', 'auth.py')), 'src/auth.py')
      assert.equal(toWorkspaceRelative(root, join(root, 'a', 'b', 'c.ts')), 'a/b/c.ts')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('always answers with forward slashes, whatever the platform uses', () => {
    const root = tempRoot()
    try {
      const nested = toWorkspaceRelative(root, join(root, 'deeply', 'nested', 'file.ts'))
      assert.ok(nested && !nested.includes('\\'), 'a backslash here would split one entity into two on Windows')
      assert.equal(nested, 'deeply/nested/file.ts')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('resolves a relative path against the workspace root, not the process directory', () => {
    const root = tempRoot()
    try {
      // The process directory here is the repository this test lives in, which is
      // exactly the mismatch that used to produce a plausible but wrong key.
      assert.equal(toWorkspaceRelative(root, 'src/auth.py'), 'src/auth.py')
      assert.equal(toWorkspaceRelative(root, './src/auth.py'), 'src/auth.py')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('refuses paths that cannot be expressed relative to the workspace', () => {
    const root = tempRoot()
    try {
      assert.equal(toWorkspaceRelative(root, root), null, 'the root itself has no relative spelling')
      assert.equal(toWorkspaceRelative(root, join(root, '..')), null, 'a parent escape is not inside')
      assert.equal(toWorkspaceRelative(root, join(root, '..', 'elsewhere', 'a.ts')), null)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('rejects a path on another volume instead of leaking it back as absolute', { skip: !WINDOWS }, () => {
    // `path.relative` between two Windows volumes returns the absolute target rather
    // than a `..` climb, so a check that only looked for `..` reported success and the
    // caller stored an absolute path believing it was relative.
    assert.equal(toWorkspaceRelative('C:\\workspace', 'D:\\other\\a.ts'), null)
    assert.equal(toWorkspaceRelative('C:\\workspace\\sub', 'D:\\other\\a.ts'), null)
  })

  test('does not depend on the workspace root existing', () => {
    // The daemon and the hook compute keys before a directory necessarily exists.
    assert.equal(toWorkspaceRelative(join(tmpdir(), 'agentgit-absent-root'), join(tmpdir(), 'agentgit-absent-root', 'x.ts')), 'x.ts')
  })
})

describe('canonicalEntityPath', () => {
  test('gives one file one spelling, however it was written down', () => {
    const root = tempRoot()
    try {
      const absolute = join(root, 'src', 'auth.py')
      const expected = 'src/auth.py'

      assert.equal(canonicalEntityPath(root, absolute), expected, 'an absolute path from the host')
      assert.equal(canonicalEntityPath(root, 'src/auth.py'), expected, 'a relative path from the model')
      assert.equal(canonicalEntityPath(root, './src/auth.py'), expected)
      assert.equal(canonicalEntityPath(root, '  src/auth.py  '), expected)
      assert.equal(canonicalEntityPath(root, absolute.replace(/\//g, '\\')), expected, 'a Windows path from the host')
      assert.equal(canonicalEntityPath(root, '<root>/src/auth.py'.replace('<root>', root)), expected)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('keeps a file outside the workspace as an absolute path rather than mangling it', () => {
    const root = tempRoot()
    try {
      const outside = join(root, '..', 'outside-the-workspace', 'a.ts').replace(/\\/g, '/')
      const result = canonicalEntityPath(root, outside)
      assert.ok(result.startsWith('/') || /^[A-Za-z]:/.test(result), `expected an absolute path, got ${result}`)
      assert.ok(!result.startsWith('..'), 'a parent escape must never survive as a relative path')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('is idempotent, so a key that round-trips through the ledger does not drift', () => {
    const root = tempRoot()
    try {
      const once = canonicalEntityPath(root, join(root, 'src', 'auth.py'))
      assert.equal(canonicalEntityPath(root, once), once)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('an empty string stays empty instead of becoming the workspace root', () => {
    assert.equal(canonicalEntityPath('C:/anywhere', ''), '')
    assert.equal(canonicalEntityPath('C:/anywhere', '   '), '')
  })

  test('two clones of one repository agree on the key, which is what makes a shared ledger work', () => {
    // The planned cross-machine story: contracts travel through Git, and the events
    // that reference them must mean the same entity on both machines. Absolute keys
    // would make each clone look like separate ground.
    const rootA = WINDOWS ? win32.join('C:', 'work', 'proj') : posix.join('/work', 'proj')
    const rootB = WINDOWS ? win32.join('D:', 'backup', 'proj') : posix.join('/backup', 'proj')

    const keyA = keyOf(canonicalEntityPath(rootA, win32.join(rootA, 'src', 'auth.py')))
    const keyB = keyOf(canonicalEntityPath(rootB, win32.join(rootB, 'src', 'auth.py')))
    assert.equal(keyA, keyB)
    assert.equal(keyA, 'file::src/auth.py')
  })
})
