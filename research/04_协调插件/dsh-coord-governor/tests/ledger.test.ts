/**
 * Ledger tests. These pin the framework's derived quantities to hand-computed
 * ground truth, because a wrong instrument makes every later experiment
 * uninterpretable — the failure mode E0 exists to prevent.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import {
  backlogSeries,
  buildCapsules,
  buildContention,
  buildReport,
  compareCodepoint,
  computeParallelism,
  computeRates,
  entityKey,
  normalizeEntity,
  normalizePath,
  parseWireLine,
  serializeEvent,
  sortEvents,
  toWire,
  Ledger,
  MIN_RATE_WINDOW_HOURS,
} from '../src/ledger.ts'
import { at, ev, write } from './helpers.ts'

describe('effective parallelism (the K4 denominator)', () => {
  test('mean is the time-weighted average number of in-flight capsules', () => {
    // Two capsules open for the first hour, one for the next: area = 2 + 1 = 3
    // capsule-hours over 2 hours.
    const capsules = buildCapsules([
      write({ minutes: 0, taskId: 'T1', path: 'a.py' }),
      write({ minutes: 0, sessionId: 's2', taskId: 'T2', path: 'b.py' }),
      ev({ kind: 'lifecycle_integrated', minutes: 60, taskId: 'T2' }),
      ev({ kind: 'lifecycle_integrated', minutes: 120, taskId: 'T1' }),
    ])
    const parallelism = computeParallelism(backlogSeries(capsules))
    assert.equal(parallelism.mean, 1.5)
    assert.equal(parallelism.peak, 2)
    assert.equal(parallelism.openAtEnd, 0)
    assert.equal(parallelism.observedHours, 2)
  })

  test('parallelFraction is the share of the window with at least two capsules open', () => {
    const capsules = buildCapsules([
      write({ minutes: 0, taskId: 'T1', path: 'a.py' }),
      write({ minutes: 0, sessionId: 's2', taskId: 'T2', path: 'b.py' }),
      ev({ kind: 'lifecycle_integrated', minutes: 60, taskId: 'T2' }),
      ev({ kind: 'lifecycle_integrated', minutes: 120, taskId: 'T1' }),
    ])
    const parallelism = computeParallelism(backlogSeries(capsules))
    assert.equal(parallelism.parallelHours, 1)
    assert.equal(parallelism.parallelFraction, 0.5)
  })

  test('serialising work leaves the mean intact only if it never overlaps', () => {
    // The K4 scenario: same average work in flight, no overlap at all. Reported
    // together, the mean alone would make throttling look neutral.
    const capsules = buildCapsules([
      write({ minutes: 0, taskId: 'T1', path: 'a.py' }),
      ev({ kind: 'lifecycle_integrated', minutes: 30, taskId: 'T1' }),
      write({ minutes: 30, sessionId: 's2', taskId: 'T2', path: 'b.py' }),
      ev({ kind: 'lifecycle_integrated', minutes: 60, taskId: 'T2' }),
    ])
    const parallelism = computeParallelism(backlogSeries(capsules))
    assert.equal(parallelism.parallelFraction, 0, 'never two in flight')
    assert.equal(parallelism.peak, 1)
  })

  test('an empty series reports zeros rather than dividing by zero', () => {
    assert.deepEqual(computeParallelism([]), {
      mean: 0,
      peak: 0,
      openAtEnd: 0,
      observedHours: 0,
      parallelHours: 0,
      parallelFraction: 0,
    })
  })
})

describe('canonical ordering', () => {
  test('deriving is invariant to arrival order, so a report is a function of the event set', () => {
    const events = [
      write({ minutes: 0, taskId: 'T1', path: 'a.py' }),
      ev({ kind: 'context_compacted', minutes: 10, sessionId: 's1', taskId: 'T1' }),
      write({ minutes: 20, taskId: 'T1', path: 'a.py' }),
    ]
    const forward = buildReport(events)
    const reversed = buildReport([...events].reverse())

    assert.deepEqual(reversed.counts, forward.counts)
    assert.deepEqual(reversed.backlogSeries, forward.backlogSeries)
    assert.equal(forward.writesAfterContextLoss, 1)
    assert.equal(reversed.writesAfterContextLoss, forward.writesAfterContextLoss)
  })

  test('a compaction and a write sharing one timestamp resolve identically either way', () => {
    // Python sorts by (timestamp_utc, event_id), so the hash decides the tie. A
    // concurrent run must not decide it by whichever session was serviced first.
    const compacted = ev({ kind: 'context_compacted', minutes: 5, sessionId: 's1', taskId: 'T1' })
    const written = write({ minutes: 5, taskId: 'T1', path: 'a.py' })
    assert.equal(
      buildReport([compacted, written]).writesAfterContextLoss,
      buildReport([written, compacted]).writesAfterContextLoss,
    )
  })

  test('sortEvents orders by timestamp, then by event id', () => {
    const early = write({ minutes: 0, taskId: 'T1', path: 'a.py' })
    const late = write({ minutes: 1, taskId: 'T1', path: 'b.py' })
    assert.deepEqual(
      sortEvents([late, early]).map((e) => e.timestampUtc),
      [early.timestampUtc, late.timestampUtc],
    )
  })

  test('codepoint ordering matches Python, so CJK paths do not reshuffle', () => {
    // ICU collation places CJK before Latin; Python's `<` places ASCII first.
    assert.ok(compareCodepoint('a.py', '\u6587\u4ef6.py') < 0, 'ASCII sorts before CJK by code point')
    assert.equal(compareCodepoint('a.py', 'a.py'), 0)
    assert.ok(compareCodepoint('b.py', 'a.py') > 0)
  })

  test('contested entities sort by code point, not by collation', () => {
    const capsules = buildCapsules([
      write({ minutes: 0, sessionId: 's1', taskId: 'T1', path: '\u6587\u4ef6.py' }),
      write({ minutes: 1, sessionId: 's2', taskId: 'T2', path: '\u6587\u4ef6.py' }),
      write({ minutes: 2, sessionId: 's1', taskId: 'T1', path: 'a.py' }),
      write({ minutes: 3, sessionId: 's2', taskId: 'T2', path: 'a.py' }),
    ])
    assert.deepEqual(
      buildContention(capsules).map((c) => c.path),
      ['a.py', '\u6587\u4ef6.py'],
    )
  })
})

describe('normalisation', () => {
  test('collapses equivalent path spellings without resolving ..', () => {
    assert.equal(normalizePath('./src/a.py'), 'src/a.py')
    assert.equal(normalizePath('./././src/a.py'), 'src/a.py')
    assert.equal(normalizePath('a\\b\\c.py'), 'a/b/c.py')
    assert.equal(normalizePath('  a/b.py  '), 'a/b.py')
    // Documented limitation: '..' is deliberately not resolved, because doing so
    // requires a real cwd and would make the ledger depend on the working
    // directory that happened to be current when the event was written.
    assert.equal(normalizePath('src/../a.py'), 'src/../a.py')
  })

  test('accepts both string and ISCC-style entity objects', () => {
    assert.deepEqual(normalizeEntity('src/a.py'), { kind: 'file', identifier: 'src/a.py', path: 'src/a.py' })
    assert.deepEqual(
      normalizeEntity({ kind: 'function', identifier: 'app.view', path: 'src/a.py' }),
      { kind: 'function', identifier: 'app.view', path: 'src/a.py' },
    )
    assert.equal(normalizeEntity(''), null)
    assert.equal(normalizeEntity(null), null)
    assert.equal(normalizeEntity({ kind: 'file' }), null)
  })

  test('separates symbol-level from path-level entity keys', () => {
    assert.equal(entityKey({ kind: 'file', identifier: 'src/a.py', path: 'src/a.py' }), 'file::src/a.py')
    assert.equal(entityKey({ kind: 'symbol', identifier: 'app.view', path: 'src/a.py' }), 'symbol::app.view')
  })

  test('preserves case so case-sensitive filesystems are not merged', () => {
    assert.notEqual(entityKey(normalizeEntity('Src/A.py')!), entityKey(normalizeEntity('src/a.py')!))
  })
})

describe('capsule derivation', () => {
  test('folds writes into one capsule per task and counts touches', () => {
    const capsules = buildCapsules([
      write({ minutes: 0, taskId: 'T1', path: 'a.py' }),
      write({ minutes: 1, taskId: 'T1', path: 'a.py' }),
      write({ minutes: 2, taskId: 'T1', path: 'b.py' }),
    ])
    const capsule = capsules.get('T1')!
    assert.equal(capsule.nEvents, 3)
    assert.equal(capsule.entities.get('file::a.py')!.touches, 2)
    assert.equal(capsule.entities.get('file::b.py')!.touches, 1)
  })

  test('events without a task id are excluded, since they cannot be reconciled', () => {
    const capsules = buildCapsules([
      ev({ kind: 'file_write', minutes: 0, entities: [{ kind: 'file', identifier: 'a.py', path: 'a.py' }] }),
    ])
    assert.equal(capsules.size, 0)
  })

  test('validated still counts as backlog: passing checks is not reconciliation', () => {
    const capsules = buildCapsules([
      write({ minutes: 0, taskId: 'T1', path: 'a.py' }),
      ev({ kind: 'lifecycle_validated', minutes: 5, taskId: 'T1' }),
    ])
    assert.equal(capsules.get('T1')!.state, 'validated')
    assert.equal(backlogSeries(capsules).at(-1)!.openCapsules, 1)
  })

  test('integration closes a capsule and records its close time', () => {
    const capsules = buildCapsules([
      write({ minutes: 0, taskId: 'T1', path: 'a.py' }),
      ev({ kind: 'lifecycle_integrated', minutes: 30, taskId: 'T1' }),
    ])
    assert.equal(capsules.get('T1')!.state, 'integrated')
    assert.equal(capsules.get('T1')!.closedAtUtc, at(30))
  })

  test('the first terminal transition wins, so a late event cannot resurrect a capsule', () => {
    const capsules = buildCapsules([
      write({ minutes: 0, taskId: 'T1', path: 'a.py' }),
      ev({ kind: 'lifecycle_integrated', minutes: 10, taskId: 'T1' }),
      ev({ kind: 'lifecycle_validated', minutes: 20, taskId: 'T1' }),
    ])
    assert.equal(capsules.get('T1')!.closedAtUtc, at(10))
  })

  test('writes after context loss are counted only when compaction precedes them', () => {
    const before = buildCapsules([
      write({ minutes: 0, taskId: 'T1', path: 'a.py' }),
      ev({ kind: 'context_compacted', minutes: 1, taskId: 'T1' }),
    ])
    assert.equal(before.get('T1')!.writesAfterCompact, 0)

    const after = buildCapsules([
      ev({ kind: 'context_compacted', minutes: 0, taskId: 'T1' }),
      write({ minutes: 1, taskId: 'T1', path: 'a.py' }),
      write({ minutes: 2, taskId: 'T1', path: 'b.py' }),
    ])
    assert.equal(after.get('T1')!.writesAfterCompact, 2)
  })
})

describe('contention', () => {
  test('reports entities touched by more than one task', () => {
    const contention = buildContention(
      buildCapsules([
        write({ minutes: 0, taskId: 'T1', sessionId: 's1', path: 'a.py' }),
        write({ minutes: 1, taskId: 'T2', sessionId: 's2', path: 'a.py' }),
      ]),
    )
    assert.equal(contention.length, 1)
    assert.deepEqual(contention[0].tasks.sort(), ['T1', 'T2'])
    assert.deepEqual(contention[0].sessions.sort(), ['s1', 's2'])
  })

  test('reports entities touched by one task across two sessions', () => {
    const contention = buildContention(
      buildCapsules([
        write({ minutes: 0, taskId: 'T1', sessionId: 's1', path: 'a.py' }),
        write({ minutes: 1, taskId: 'T1', sessionId: 's2', path: 'a.py' }),
      ]),
    )
    assert.equal(contention.length, 1)
    assert.deepEqual(contention[0].sessions.sort(), ['s1', 's2'])
  })

  test('does not report an entity touched by one task in one session', () => {
    const contention = buildContention(
      buildCapsules([write({ minutes: 0, taskId: 'T1', sessionId: 's1', path: 'a.py' })]),
    )
    assert.equal(contention.length, 0)
  })

  test('collects distinct intents per entity for later similarity scoring', () => {
    const contention = buildContention(
      buildCapsules([
        write({ minutes: 0, taskId: 'T1', sessionId: 's1', path: 'a.py', intentText: 'return json from the view' }),
        write({ minutes: 1, taskId: 'T2', sessionId: 's2', path: 'a.py', intentText: 'add caching to the view' }),
      ]),
    )
    assert.deepEqual(contention[0].intents.sort(), ['add caching to the view', 'return json from the view'])
  })
})

describe('backlog series', () => {
  test('replays open and close transitions in time order', () => {
    const capsules = buildCapsules([
      write({ minutes: 0, taskId: 'T1', path: 'a.py' }),
      write({ minutes: 10, taskId: 'T2', path: 'b.py' }),
      ev({ kind: 'lifecycle_integrated', minutes: 20, taskId: 'T1' }),
      ev({ kind: 'lifecycle_integrated', minutes: 30, taskId: 'T2' }),
    ])
    assert.deepEqual(
      backlogSeries(capsules).map((p) => [p.timestampUtc, p.openCapsules]),
      [
        [at(0), 1],
        [at(10), 2],
        [at(20), 1],
        [at(30), 0],
      ],
    )
  })

  test('never goes negative even if a close is seen before an open', () => {
    const capsules = buildCapsules([
      ev({ kind: 'lifecycle_integrated', minutes: 0, taskId: 'T1' }),
      write({ minutes: 5, taskId: 'T1', path: 'a.py' }),
    ])
    for (const point of backlogSeries(capsules)) assert.ok(point.openCapsules >= 0)
  })
})

describe('effective parallelism', () => {
  test('is the time-weighted mean of open capsules, matching hand computation', () => {
    // T1 open over [0,2)h, T2 open over [1,3)h  =>  area = 1*1 + 2*1 + 1*1 = 4 capsule-hours
    const capsules = buildCapsules([
      write({ minutes: 0, taskId: 'T1', path: 'a.py' }),
      write({ minutes: 60, taskId: 'T2', path: 'b.py' }),
      ev({ kind: 'lifecycle_integrated', minutes: 120, taskId: 'T1' }),
      ev({ kind: 'lifecycle_integrated', minutes: 180, taskId: 'T2' }),
    ])
    const parallelism = computeParallelism(backlogSeries(capsules))
    assert.equal(parallelism.observedHours, 3)
    assert.equal(Math.round(parallelism.mean * 1000) / 1000, 1.333)
    assert.equal(parallelism.peak, 2)
    assert.equal(parallelism.openAtEnd, 0)
  })

  test('is not simply the peak or the count', () => {
    // A single capsule open for the whole window must average 1, not 0 and not peak.
    const capsules = buildCapsules([
      write({ minutes: 0, taskId: 'T1', path: 'a.py' }),
      write({ minutes: 60, taskId: 'T1', path: 'a.py' }),
    ])
    assert.equal(computeParallelism(backlogSeries(capsules)).mean, 1)
  })

  test('falls back to the instantaneous value on a zero-width window', () => {
    const capsules = buildCapsules([write({ minutes: 0, taskId: 'T1', path: 'a.py' })])
    const parallelism = computeParallelism(backlogSeries(capsules))
    assert.equal(parallelism.observedHours, 0)
    assert.equal(parallelism.mean, 1)
  })

  test('is zero for an empty ledger', () => {
    assert.deepEqual(computeParallelism([]), {
      mean: 0,
      peak: 0,
      openAtEnd: 0,
      observedHours: 0,
      parallelHours: 0,
      parallelFraction: 0,
    })
  })
})

describe('rates', () => {
  test('withholds rates when the observed span is below the floor', () => {
    const events = [
      write({ minutes: 0, taskId: 'T1', path: 'a.py' }),
      write({ minutes: 0.01, taskId: 'T2', path: 'b.py' }),
    ]
    const rates = computeRates(buildCapsules(events), events)
    assert.equal(rates.rateIsMeaningful, false)
    assert.equal(rates.lambdaProducedPerHour, null)
    assert.match(rates.withheldReason!, /below/)
    assert.ok(rates.observedHours < MIN_RATE_WINDOW_HOURS)
  })

  test('reports a meaningful lambda once the window is wide enough', () => {
    const events = [
      write({ minutes: 0, taskId: 'T1', path: 'a.py' }),
      write({ minutes: 60, taskId: 'T2', path: 'b.py' }),
    ]
    const rates = computeRates(buildCapsules(events), events)
    assert.equal(rates.rateIsMeaningful, true)
    assert.equal(rates.observedHours, 1)
    assert.equal(rates.lambdaProducedPerHour, 2)
    assert.equal(rates.integrationRatePerHour, 0)
  })

  test('counts only integrated capsules toward the reconciliation rate', () => {
    // Window is exactly 60 minutes. T1 reaches `validated` only, so it must count
    // toward lambda but not toward the reconciliation rate: checks passing is not
    // the same as being reconciled.
    const events = [
      write({ minutes: 0, taskId: 'T1', path: 'a.py' }),
      ev({ kind: 'lifecycle_validated', minutes: 10, taskId: 'T1' }),
      write({ minutes: 30, taskId: 'T2', path: 'b.py' }),
      ev({ kind: 'lifecycle_integrated', minutes: 60, taskId: 'T2' }),
    ]
    const rates = computeRates(buildCapsules(events), events)
    assert.equal(rates.observedHours, 1)
    assert.equal(rates.lambdaProducedPerHour, 2)
    assert.equal(rates.integrationRatePerHour, 1)
  })
})

describe('report', () => {
  test('separates decayed capsules from backlog', () => {
    const report = buildReport([
      write({ minutes: 0, taskId: 'T1', path: 'a.py' }),
      ev({ kind: 'lifecycle_abandoned', minutes: 10, taskId: 'T1' }),
      write({ minutes: 5, taskId: 'T2', path: 'b.py' }),
    ])
    assert.equal(report.counts.openCapsules, 1)
    assert.equal(report.counts.decayedCapsules, 1)
    assert.equal(report.counts.unreconciledCapsules, report.counts.openCapsules)
    assert.deepEqual(report.stateHistogram, { abandoned: 1, proposed: 1 })
  })

  test('counts distinct sessions that lost context, not compaction events', () => {
    const report = buildReport([
      ev({ kind: 'context_compacted', minutes: 0, sessionId: 's1', taskId: 'T1' }),
      ev({ kind: 'context_compacted', minutes: 1, sessionId: 's1', taskId: 'T1' }),
      ev({ kind: 'context_compacted', minutes: 2, sessionId: 's2', taskId: 'T2' }),
    ])
    assert.equal(report.counts.sessionsWithContextLoss, 2)
  })

  test('aggregates writes issued after context loss across capsules', () => {
    const report = buildReport([
      ev({ kind: 'context_compacted', minutes: 0, taskId: 'T1' }),
      write({ minutes: 1, taskId: 'T1', path: 'a.py' }),
      ev({ kind: 'context_compacted', minutes: 2, taskId: 'T2' }),
      write({ minutes: 3, taskId: 'T2', path: 'b.py' }),
      write({ minutes: 4, taskId: 'T2', path: 'c.py' }),
    ])
    assert.equal(report.writesAfterContextLoss, 3)
  })

  test('is empty but well-formed for no events', () => {
    const report = buildReport([])
    assert.equal(report.counts.events, 0)
    assert.equal(report.parallelism.mean, 0)
    assert.equal(report.rates.rateIsMeaningful, false)
    assert.deepEqual(report.backlogSeries, [])
  })
})

describe('wire format interop', () => {
  test('serializes to the snake_case shape the Python analyser reads', () => {
    const wire = toWire(write({ minutes: 0, taskId: 'T1', path: 'a.py', intentText: 'do a thing' }))
    assert.deepEqual(Object.keys(wire).sort(), [
      'detail', 'developer', 'entities', 'event_id', 'host_event', 'intent_text',
      'kind', 'reason', 'schema_version', 'session_id', 'task_id', 'timestamp_utc',
    ])
    assert.equal(wire.schema_version, 'coord-ledger-0.1')
    assert.equal(wire.task_id, 'T1')
  })

  test('produces a stable content-addressed event id', () => {
    const event = write({ minutes: 0, taskId: 'T1', path: 'a.py' })
    assert.equal(toWire(event).event_id, toWire(event).event_id)
  })

  test('emits one LF-terminated line per event', () => {
    const line = serializeEvent(write({ minutes: 0, taskId: 'T1', path: 'a.py' }))
    assert.ok(line.endsWith('\n'))
    assert.equal(line.trimEnd().includes('\n'), false)
    assert.equal(parseWireLine(line, 1).task_id, 'T1')
  })

  test('reports the line number for a malformed record', () => {
    assert.throws(() => parseWireLine('{not json', 7), /line 7/)
  })

  test('refuses to build an unattributable event', () => {
    assert.throws(() => ev({ kind: 'file_write', minutes: 0, sessionId: '' }), /sessionId is required/)
  })
})

describe('Ledger', () => {
  test('forwards every record to the sink for append-only persistence', () => {
    const lines: string[] = []
    const ledger = new Ledger((line) => lines.push(line))
    ledger.record(write({ minutes: 0, taskId: 'T1', path: 'a.py' }))
    ledger.record(write({ minutes: 1, taskId: 'T2', path: 'b.py' }))
    assert.equal(lines.length, 2)
    assert.equal(lines.map((l) => JSON.parse(l).task_id).join(','), 'T1,T2')
  })

  test('works without a sink, so recording can be disabled without branching', () => {
    const ledger = new Ledger()
    ledger.record(write({ minutes: 0, taskId: 'T1', path: 'a.py' }))
    assert.equal(ledger.report().counts.capsules, 1)
  })

  test('load replaces the stream, supporting replay', () => {
    const ledger = new Ledger()
    ledger.record(write({ minutes: 0, taskId: 'T1', path: 'a.py' }))
    ledger.load([write({ minutes: 0, taskId: 'X', path: 'z.py' })])
    assert.equal(ledger.report().counts.capsules, 1)
    assert.ok(ledger.capsules().has('X'))
  })
})
