/**
 * The argument parser, and the one invariant that keeps it from eating the user's words.
 *
 * The grammar is `--flag value` for anything not in {@link BARE_SAFE}, so a flag that is
 * *read* as a boolean but *missing* from that set silently swallows the next token. The
 * failure is quiet and specific: `agentgit preflight src/a.ts --claim` still works,
 * because there is nothing after it, but `agentgit preflight --claim src/a.ts` reads
 * `src/a.ts` as the value of `--claim` and then reports that no path was given. Nothing
 * crashes and nothing is logged, which is exactly why this file reads the source of the
 * command instead of trusting a hand-written list to stay correct.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { BARE_SAFE, parseArgs } from '../src/args.ts'

const MAIN = join(import.meta.dirname, '..', 'src', 'main.ts')

describe('flags that stand alone', () => {
  test('every flag read as a boolean is declared bare-safe', () => {
    const source = readFileSync(MAIN, 'utf8')
    const read = [...source.matchAll(/args\.boolean\(\s*'([^']+)'/g)].map((match) => match[1])
    assert.ok(read.length > 5, 'the scan found the command source; a rename must not silently empty this test')

    const missing = [...new Set(read)].filter((name) => !BARE_SAFE.has(name))
    assert.deepEqual(
      missing,
      [],
      `these flags are read as booleans but would consume the next argument: ${missing.join(', ')}`,
    )
  })

  test('a bare flag does not eat the positional that follows it', () => {
    // The exact shape that motivated the rule, and the reason it is stated as a property
    // of the set rather than of one flag.
    const parsed = parseArgs(['preflight', '--claim', 'src/auth.ts'])
    assert.deepEqual(parsed.positionals, ['src/auth.ts'])
    assert.equal(parsed.boolean('claim'), true)
  })

  test('a value flag still takes the next token, and `--flag=value` always works', () => {
    const spaced = parseArgs(['preflight', '--intent', 'add a limiter', 'src/auth.ts'])
    assert.equal(spaced.value('intent'), 'add a limiter')
    assert.deepEqual(spaced.positionals, ['src/auth.ts'])

    const joined = parseArgs(['preflight', '--intent=add a limiter', 'src/auth.ts'])
    assert.equal(joined.value('intent'), 'add a limiter')
  })

  test('a flag followed by another flag is true, not the flag itself', () => {
    const parsed = parseArgs(['status', '--json', '--open'])
    assert.equal(parsed.boolean('json'), true)
    assert.equal(parsed.boolean('open'), true)
  })

  test('repeated flags accumulate, because contracts and paths are given more than once', () => {
    const parsed = parseArgs(['preflight', 'a.ts', '--contract', 'auth.limit', '--contract', 'auth.token'])
    assert.deepEqual(parsed.values('contract'), ['auth.limit', 'auth.token'])
  })
})
