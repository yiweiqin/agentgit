/**
 * Report a ledger from the command line.
 *
 * Why this exists
 * ---------------
 * `coord_ledger.py` is the analysis-side instrument and the plugin is the
 * collection-side one. If they disagree, every number in the experiments is
 * suspect, and the disagreement is invisible because both just print plausible
 * figures. E0 requires them to be diffed **on the same file**, which needs a
 * TypeScript entry point that reads a ledger and prints comparable quantities.
 * That is this file.
 *
 * The JSON printed with `--json` is deliberately shaped like
 * `coord_ledger.py report --json` (snake_case keys, same field meanings) so the
 * cross-check is a field-by-field comparison rather than a translation exercise.
 * Where this plugin computes something Python does not, it is put under
 * `ts_only` so it can never be mistaken for an agreed quantity.
 *
 * Usage:
 *
 *     node src/cli.ts report --ledger <dir-or-file> [--json]
 */

import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { resolveArm, type ArmName } from './config.ts'
import { evaluatePack, parsePack, type TaskPack } from './e2.ts'
import { buildReport, fromWire, parseWireLine } from './ledger.ts'
import { ledgerFilePath } from './store.ts'
import type { CoordEvent, LedgerReport, WireEvent } from './types.ts'

/**
 * Read and decode a ledger file into events.
 *
 * A missing file is an error, not an empty ledger.
 *
 * The first version of this function returned `[]` for a missing file, on the
 * reasoning that "no events" is a legitimate state. The first E0 run showed why that
 * is wrong: the cross-check passed a relative path that resolved differently under
 * `cwd`, so the analyzer reported zero capsules, zero contention and no context loss —
 * sixty confident, meaningless failures. A wrong path must not be representable as a
 * measurement. `compute_report` below therefore refuses to produce numbers for a
 * ledger that does not exist.
 */
export function readLedger(ledger: string, cwd?: string): CoordEvent[] {
  const path = ledgerFilePath(ledger, cwd)
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    throw new Error(
      `cannot read ledger at ${path}: ${(error as Error).message}. ` +
        'A missing ledger is reported as an error because an empty report is ' +
        'indistinguishable from a missing file, and the difference decides whether a ' +
        'run measured nothing or measured the wrong thing.',
    )
  }
  const events: CoordEvent[] = []
  let lineNumber = 0
  for (const line of text.split('\n')) {
    lineNumber += 1
    if (!line.trim()) continue
    events.push(fromWire(parseWireLine(line, lineNumber) as WireEvent))
  }
  return events
}

/**
 * The Python-comparable view of a report.
 *
 * Every key here has a counterpart in `coord_ledger.py`'s `compute_report`, with the
 * same meaning. Anything without a counterpart belongs under `ts_only`, because a
 * field that only one side computes cannot be cross-checked and must not look like it
 * was.
 */
export function comparisonView(report: LedgerReport): Record<string, unknown> {
  return {
    counts: {
      events: report.counts.events,
      capsules: report.counts.capsules,
      open_capsules: report.counts.openCapsules,
      unreconciled_capsules: report.counts.unreconciledCapsules,
      integrated_capsules: report.counts.integratedCapsules,
      decayed_capsules: report.counts.decayedCapsules,
      contested_entities: report.counts.contestedEntities,
      sessions_with_context_loss: report.counts.sessionsWithContextLoss,
    },
    rates: {
      observed_hours: report.rates.observedHours,
      lambda_produced_per_hour: report.rates.lambdaProducedPerHour,
      integration_rate_per_hour: report.rates.integrationRatePerHour,
      rate_is_meaningful: report.rates.rateIsMeaningful,
    },
    backlog_now: { open_capsules: report.counts.openCapsules },
    backlog_series: report.backlogSeries.map((point) => ({
      timestamp_utc: point.timestampUtc,
      open_capsules: point.openCapsules,
    })),
    state_histogram: report.stateHistogram,
    top_contested_entities: report.topContestedEntities.map((entry) => ({
      entity_key: entry.entityKey,
      kind: entry.kind,
      identifier: entry.identifier,
      path: entry.path,
      tasks: entry.tasks,
      sessions: entry.sessions,
      touches: entry.touches,
    })),
    writes_after_context_loss: report.writesAfterContextLoss,
    ts_only: {
      // Not in `coord_ledger.py`. Effective parallelism is the quantity H5 forces to be
      // reported next to any claimed improvement, so it is surfaced here rather than
      // left to a caller to recompute.
      parallelism: report.parallelism,
    },
  }
}

function parseArgs(argv: readonly string[]): { command: string; ledger: string | null; pack: string | null; json: boolean } {
  const command = argv[0] ?? ''
  let ledger: string | null = null
  let pack: string | null = null
  let json = false
  for (let i = 1; i < argv.length; i += 1) {
    if (argv[i] === '--ledger') ledger = argv[i + 1] ?? null
    else if (argv[i] === '--pack') pack = argv[i + 1] ?? null
    else if (argv[i] === '--json') json = true
  }
  return { command, ledger, pack, json }
}

/**
 * Decode task-pack JSON, tolerating a UTF-8 BOM.
 *
 * Packs are hand-authored, and on Windows virtually every editor adds a BOM. A BOM
 * makes `JSON.parse` fail with "Unexpected token", which reads like a syntax error in
 * the pack rather than an encoding artefact — a confusing dead end for whoever edits
 * the ground truth next. Stripped here instead of documented as a rule to remember.
 */
function parsePackJson(text: string, path: string): unknown {
  const withoutBom = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  try {
    return JSON.parse(withoutBom)
  } catch (error) {
    throw new Error(`invalid JSON in ${path}: ${(error as Error).message}`)
  }
}

/**
 * Score an E2 task pack under a named arm's policy.
 *
 * The arm selects the policy config, so the same pack can be scored under the
 * passive and the gated policy without the evaluator knowing anything about arms.
 */
function evalDetection(packPath: string, armName: string | null): number {
  let pack: TaskPack
  try {
    pack = parsePack(parsePackJson(readFileSync(packPath, 'utf8'), packPath))
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`)
    return 2
  }

  const arm: ArmName = (armName ?? 'A1-instrument') as ArmName
  const config = resolveArm(arm)
  const metrics = evaluatePack(pack, config.policy, { baseIso: '2026-04-01T00:00:00Z' })
  process.stdout.write(`${JSON.stringify({ arm, ...metrics }, null, 2)}\n`)
  return 0
}

function main(argv: readonly string[]): number {
  const { command, ledger, pack, json } = parseArgs(argv)

  if (command === 'eval-detection') {
    if (!pack) {
      process.stderr.write('usage: node src/cli.ts eval-detection --pack <pack.json> [--arm A0-baseline]\n')
      return 2
    }
    const armIndex = argv.indexOf('--arm')
    return evalDetection(pack, armIndex >= 0 ? (argv[armIndex + 1] ?? null) : null)
  }

  if (command !== 'report' || !ledger) {
    process.stderr.write(
      'usage: node src/cli.ts report --ledger <dir-or-file> [--json]\n' +
        '       node src/cli.ts eval-detection --pack <pack.json> [--arm A0-baseline]\n',
    )
    return 2
  }

  let events: CoordEvent[]
  try {
    events = readLedger(ledger)
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`)
    return 2
  }
  const view = comparisonView(buildReport(events))

  if (json) {
    process.stdout.write(`${JSON.stringify(view, null, 2)}\n`)
    return 0
  }

  const counts = view.counts as Record<string, number>
  const rates = view.rates as Record<string, unknown>
  process.stdout.write(`ledger            : ${ledgerFilePath(ledger)}\n`)
  process.stdout.write(`capsules (tasks)  : ${counts.capsules}\n`)
  process.stdout.write(`open (= backlog)  : ${counts.open_capsules}\n`)
  process.stdout.write(`integrated        : ${counts.integrated_capsules}\n`)
  process.stdout.write(`decayed           : ${counts.decayed_capsules}\n`)
  if (rates.rate_is_meaningful) {
    process.stdout.write(`lambda_produced/h : ${Number(rates.lambda_produced_per_hour).toFixed(3)}\n`)
    process.stdout.write(`integration_rate/h: ${Number(rates.integration_rate_per_hour).toFixed(3)}\n`)
  } else {
    process.stdout.write('rates             : withheld (observation window below the floor)\n')
  }
  process.stdout.write(`contested entities: ${counts.contested_entities}\n`)
  process.stdout.write(`writes after context loss: ${view.writes_after_context_loss}\n`)
  process.stdout.write(`state histogram   : ${JSON.stringify(view.state_histogram)}\n`)
  return 0
}

// Only run when invoked directly, so tests can import the helpers above.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2))
}
