/**
 * Settings a user can find, change, and trust.
 *
 * Two separate claims are tested here, and they fail in different ways.
 *
 * The first is *discoverability*: a heuristic product is only improvable if the person it
 * is wrong for can find the number that was wrong. So `agentgit config` with no arguments
 * must print every setting with what it does, and `--json` must expose the same fields for a
 * tool that wants to read them.
 *
 * The second is that a setting actually *does* something. A knob that prints a new value and
 * changes no behaviour is worse than no knob, because it converts a complaint into a false
 * sense of having fixed it. That is why the last block drives the real CLI twice on the same
 * ledger under two arms and asserts the verdict differs: the arm has to change the answer,
 * not just the label.
 */

import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { PRODUCT_ARMS } from '@agentgit/core'

const REPO = join(import.meta.dirname, '..', '..', '..')
const CLI = join(REPO, 'packages', 'cli', 'src', 'main.ts')

let workspace: string

interface Run {
  readonly code: number
  readonly out: string
  readonly err: string
}

/** The CLI as the user runs it: a real process, resolved from this workspace. */
function cli(...args: string[]): Run {
  const result = spawnSync(process.execPath, [CLI, ...args, '--workspace', workspace], {
    encoding: 'utf8',
    env: { ...process.env, AGENTGIT_SESSION: 'mine' },
  })
  if (result.error) throw result.error
  return { code: result.status ?? -1, out: result.stdout ?? '', err: result.stderr ?? '' }
}

function configFile(): string {
  return join(workspace, '.agentgit', 'config.json')
}

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'agentgit-config-'))
  mkdirSync(join(workspace, '.agentgit'), { recursive: true })
})

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true })
})

describe('finding a setting', () => {
  test('no arguments lists every setting with what it does and what it costs', () => {
    const run = cli('config')
    assert.equal(run.code, 0, run.err)
    // The value alone is not enough to act on. A user who cannot see the consequence cannot
    // tell which number to suspect, and the number they suspect is the whole report.
    for (const key of ['arm', 'duplicateIntentThreshold', 'inFlightMinutes', 'leaseMinutes']) {
      assert.ok(run.out.includes(key), `${key} must be listed`)
    }
    assert.match(run.out, /effect  :/)
    assert.match(run.out, /caution :/)
    assert.match(run.out, /A3-advisory/, 'the current arm is shown with its meaning')
  })

  test('one setting on its own reports just that one', () => {
    const run = cli('config', 'duplicateIntentThreshold')
    assert.equal(run.code, 0, run.err)
    assert.ok(run.out.includes('0.42'))
    assert.ok(!run.out.includes('leaseMinutes'), 'naming one setting is a question about that setting')
  })

  test('--json exposes the same fields for a tool to read', () => {
    const run = cli('config', '--json')
    assert.equal(run.code, 0, run.err)
    const rows = JSON.parse(run.out) as { key: string; value: unknown; default: unknown; effect: string; caution: string }[]
    assert.ok(rows.length >= 4)
    for (const row of rows) {
      assert.equal(typeof row.effect, 'string')
      assert.ok(row.effect.length > 20, `${row.key} needs a real effect line`)
      assert.ok(row.caution.length > 20, `${row.key} needs a real caution line`)
    }
    const arm = rows.find((row) => row.key === 'arm')
    assert.equal(arm?.value, 'A3-advisory')
    assert.equal(arm?.default, 'A3-advisory')
  })

  test('--arms lists every arm and marks the running one', () => {
    const run = cli('config', '--arms')
    assert.equal(run.code, 0, run.err)
    for (const arm of PRODUCT_ARMS) assert.ok(run.out.includes(arm), `${arm} must be listed`)
    assert.match(run.out, /\* A3-advisory/)

    cli('config', 'arm', 'A4-session-only')
    const after = cli('config', '--arms')
    assert.match(after.out, /\* A4-session-only/, 'the mark follows the switch')
    assert.ok(!/\* A3-advisory/.test(after.out))
  })

  test('an unknown setting is refused by name, not silently accepted', () => {
    const run = cli('config', 'duplicateIntensity')
    assert.equal(run.code, 2, 'a usage error, not a success')
    assert.match(run.err, /unknown setting 'duplicateIntensity'/)
    assert.match(run.err, /Known settings:/)
  })
})

describe('changing a setting', () => {
  test('a value is written and read back', () => {
    const set = cli('config', 'duplicateIntentThreshold', '0.75')
    assert.equal(set.code, 0, set.err)
    assert.match(set.out, /duplicateIntentThreshold = 0\.75/)
    assert.equal(JSON.parse(readFileSync(configFile(), 'utf8')).duplicateIntentThreshold, 0.75)

    const read = cli('config', 'duplicateIntentThreshold', '--json')
    const row = JSON.parse(read.out) as { value: number; default: number; isDefault: boolean }
    assert.equal(row.value, 0.75)
    assert.equal(row.default, 0.42)
    assert.equal(row.isDefault, false, 'a changed setting must not claim to be the default')
  })

  test('changing one setting keeps the others', () => {
    // A settings command that resets everything it does not mention is the one bug that
    // makes people stop using it, and it is invisible until much later.
    cli('config', 'duplicateIntentThreshold', '0.75')
    cli('config', 'leaseMinutes', '5')
    cli('config', 'arm', 'A1-instrument')
    const config = JSON.parse(readFileSync(configFile(), 'utf8'))
    assert.equal(config.duplicateIntentThreshold, 0.75)
    assert.equal(config.leaseMinutes, 5)
    assert.equal(config.arm, 'A1-instrument')
  })

  test('a value out of range is refused and the file is untouched', () => {
    cli('config', 'duplicateIntentThreshold', '0.5')
    const before = readFileSync(configFile(), 'utf8')
    const run = cli('config', 'duplicateIntentThreshold', '1.5')
    assert.equal(run.code, 2)
    assert.match(run.err, /fraction between 0 and 1/)
    assert.equal(readFileSync(configFile(), 'utf8'), before, 'a rejected value must not be half-applied')
  })

  test('minutes must be whole and positive', () => {
    for (const [key, bad] of [['leaseMinutes', '0'], ['inFlightMinutes', '2.5'], ['leaseMinutes', 'soon']] as const) {
      const run = cli('config', key, bad)
      assert.equal(run.code, 2, `${key}=${bad} must be refused`)
    }
  })

  test('an arm the product will not run is refused, and says why', () => {
    // The important one: `A4-gated` would block writes, and the product never does. A quiet
    // downgrade would leave someone believing their agents were gated.
    cli('config', 'arm', 'A3-advisory')
    const before = readFileSync(configFile(), 'utf8')
    const run = cli('config', 'arm', 'A4-gated')
    assert.equal(run.code, 2)
    assert.match(run.err, /refuses writes/)
    assert.equal(readFileSync(configFile(), 'utf8'), before)
    assert.equal(JSON.parse(readFileSync(configFile(), 'utf8')).arm, 'A3-advisory')
  })

  test('a config file naming a refused arm fails loudly rather than silently', () => {
    writeFileSync(configFile(), `${JSON.stringify({ version: 1, arm: 'A4-gated' }, null, 2)}\n`, 'utf8')
    const status = cli('status')
    assert.equal(status.code, 2)
    assert.match(status.err, /A4-gated refuses writes/)
  })
})

describe('the arm is reported where a user looks', () => {
  test('status prints the arm before the numbers it constrains', () => {
    const run = cli('status')
    assert.equal(run.code, 0, run.err)
    assert.match(run.out, /arm\s+: A3-advisory/)
    // Before, not after: the arm decides what the counts below could have seen.
    assert.ok(run.out.indexOf('arm') < run.out.indexOf('coordination debt'), 'the arm explains the numbers')
  })

  test('status shows a switched arm immediately', () => {
    cli('config', 'arm', 'A1-instrument')
    assert.match(cli('status').out, /arm\s+: A1-instrument/)
  })
})

describe('the arm changes a real verdict, not just a label', () => {
  /**
   * Write the same ledger, ask the same question, get different answers.
   *
   * This is the assertion the A/B experiment rests on. If these two agreed, the experiment
   * would run two configurations and report a null effect for a switch wired to nothing.
   */
  test('another session\'s work is visible under the default arm and invisible under the ablation', () => {
    const entity = join(workspace, 'src', 'login.py')
    mkdirSync(join(entity, '..'), { recursive: true })
    writeFileSync(entity, 'def login():\n    pass\n', 'utf8')

    // Another session claims the same file for the same purpose.
    const other = spawnSync(
      process.execPath,
      [CLI, 'preflight', 'src/login.py', '--claim', '--intent', 'add rate limiting to the login endpoint', '--workspace', workspace],
      { encoding: 'utf8', env: { ...process.env, AGENTGIT_SESSION: 'other-session', AGENTGIT_TASK: 'other-task' } },
    )
    assert.equal(other.status, 0, other.stderr)

    const ask = () => JSON.parse(cli('preflight', 'src/login.py', '--intent', 'add rate limiting to login', '--json').out) as {
      verdict: string
      reason: string
    }

    cli('config', 'arm', 'A3-advisory')
    const shared = ask()
    assert.equal(shared.verdict, 'reuse', shared.reason)

    cli('config', 'arm', 'A4-session-only')
    const alone = ask()
    assert.equal(alone.verdict, 'allow', `the ablated arm must not see the other session: ${alone.reason}`)

    cli('config', 'arm', 'A1-instrument')
    const instrument = ask()
    assert.equal(instrument.verdict, 'reuse', 'measurement-only still decides; it just offers no action')
  })

  test('measurement-only withholds the next actions and nothing else', () => {
    const entity = join(workspace, 'src', 'login.py')
    mkdirSync(join(entity, '..'), { recursive: true })
    writeFileSync(entity, 'def login():\n    pass\n', 'utf8')
    spawnSync(
      process.execPath,
      [CLI, 'preflight', 'src/login.py', '--claim', '--intent', 'add rate limiting to the login endpoint', '--workspace', workspace],
      { encoding: 'utf8', env: { ...process.env, AGENTGIT_SESSION: 'other-session', AGENTGIT_TASK: 'other-task' } },
    )

    cli('config', 'arm', 'A3-advisory')
    const advised = JSON.parse(cli('preflight', 'src/login.py', '--json').out) as { nextActions: string[]; verdict: string }
    assert.ok(advised.nextActions.length > 0, 'the default tells the caller what to do next')

    cli('config', 'arm', 'A1-instrument')
    const measured = JSON.parse(cli('preflight', 'src/login.py', '--json').out) as { nextActions: string[]; verdict: string }
    assert.deepEqual(measured.nextActions, [], 'the instrument arm offers nothing')
    assert.equal(measured.verdict, advised.verdict, 'and does not change the decision itself')
  })

  test('the baseline arm records nothing, so it cannot contaminate a later arm', () => {
    const entity = join(workspace, 'src', 'login.py')
    mkdirSync(join(entity, '..'), { recursive: true })
    writeFileSync(entity, 'x\n', 'utf8')
    cli('config', 'arm', 'A0-baseline')
    cli('preflight', 'src/login.py', '--claim', '--intent', 'anything at all')
    const events = join(workspace, '.agentgit', 'events')
    const written = spawnSync(process.execPath, ['-e', `import('node:fs').then(f=>{try{console.log(f.readdirSync(${JSON.stringify(events)}).length)}catch{console.log(0)}})`], { encoding: 'utf8' })
    assert.equal((written.stdout ?? '').trim(), '0', 'the control leaves no events behind')
  })
})
