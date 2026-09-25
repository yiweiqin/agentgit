/**
 * E2 evaluator tests.
 *
 * The evaluator is the instrument that decides whether the *detector* works, so its
 * own correctness is prior to any claim about detection. Two failure modes are pinned
 * here specifically because they were both live defects:
 *
 * 1. scoring against the filtered contention list, which hid every collision whose
 *    entity had a single prior toucher — producing recall 0 with no error;
 * 2. trusting declared pack structure, which let a "hidden dependency" sit on an
 *    entity another task had already written.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { DEFAULT_POLICY } from '../src/policy.ts'
import { TASKPACK_SCHEMA_VERSION, evaluatePack, parsePack, priorContention } from '../src/e2.ts'
import type { TaskPack } from '../src/e2.ts'

function pack(overrides: Partial<TaskPack> = {}): TaskPack {
  return {
    pack: 'test-pack',
    schemaVersion: TASKPACK_SCHEMA_VERSION,
    description: 'test',
    priorEvents: [
      { minute: 0, kind: 'task_registered', sessionId: 's1', taskId: 'T1' },
      {
        minute: 1,
        kind: 'file_write',
        sessionId: 's1',
        taskId: 'T1',
        entityPath: 'a.py',
        intentText: 'add jsonify helper to the view',
      },
    ],
    proposals: [],
    ...overrides,
  }
}

const ADVISE = { ...DEFAULT_POLICY, action: 'advise' as const }
const GATED = { ...DEFAULT_POLICY, action: 'deny' as const }

describe('pack validation', () => {
  test('rejects a pack from another schema, because its truth cannot be trusted', () => {
    assert.throws(() => parsePack({ ...pack(), schemaVersion: 'coord-taskpack-9.9' }), /schema/)
  })

  test('rejects duplicate proposal ids, which would silently double-count', () => {
    const proposal = {
      id: 'p1',
      sessionId: 's2',
      taskId: 'T2',
      entityPath: 'a.py',
      intentText: null,
      truth: 'collision' as const,
      truthKind: 'true-collision' as const,
      why: '',
    }
    assert.throws(() => parsePack({ ...pack(), proposals: [proposal, { ...proposal }] }), /duplicate proposal id/)
  })

  test('refuses to score a "hidden dependency" that another task already touched', () => {
    // The exact authoring error the first version of the real pack contained: the case
    // was labelled unreachable while sitting on a plainly shared entity.
    const bad = pack({
      proposals: [
        {
          id: 'p-hidden',
          sessionId: 's2',
          taskId: 'T2',
          entityPath: 'a.py',
          intentText: 'anything',
          truth: 'collision',
          truthKind: 'hidden-dependency',
          why: '',
        },
      ],
    })
    assert.throws(() => evaluatePack(bad, ADVISE), /plainly entity-visible/)
  })

  test('refuses to score a collision on an entity nothing else touched', () => {
    const bad = pack({
      proposals: [
        {
          id: 'p-ghost',
          sessionId: 's2',
          taskId: 'T2',
          entityPath: 'nowhere.py',
          intentText: 'anything',
          truth: 'collision',
          truthKind: 'true-collision',
          why: '',
        },
      ],
    })
    assert.throws(() => evaluatePack(bad, ADVISE), /no entity-key detector could see it/)
  })
})

describe('scoring', () => {
  const twoCases = pack({
    proposals: [
      {
        id: 'p-hit',
        sessionId: 's2',
        taskId: 'T2',
        entityPath: 'a.py',
        intentText: 'add jsonify helper to the view',
        truth: 'collision',
        truthKind: 'true-collision',
        why: '',
      },
      {
        id: 'p-clean',
        sessionId: 's2',
        taskId: 'T2',
        entityPath: 'b.py',
        intentText: 'unrelated work',
        truth: 'independent',
        truthKind: 'independent-control',
        why: '',
      },
    ],
  })

  test('counts a single prior toucher as a collision, which the filtered list cannot', () => {
    // The regression that motivated `entityTouches`: with one prior toucher, the
    // filtered contention list is empty and this scored as a miss.
    const metrics = evaluatePack(twoCases, ADVISE)
    assert.equal(metrics.tp, 1)
    assert.equal(metrics.fn, 0)
    assert.equal(metrics.fp, 0)
    assert.equal(metrics.tn, 1)
  })

  test('reports the reachable-collision ceiling separately from achieved recall', () => {
    const withHidden = pack({
      priorEvents: [
        ...twoCases.priorEvents,
        { minute: 2, kind: 'file_write', sessionId: 's1', taskId: 'T1', entityPath: 'c.py', intentText: 'upstream' },
      ],
      proposals: [
        ...twoCases.proposals,
        {
          id: 'p-hidden',
          sessionId: 's2',
          taskId: 'T2',
          entityPath: 'remote.py',
          intentText: 'depends on upstream',
          truth: 'collision',
          truthKind: 'hidden-dependency',
          why: '',
        },
      ],
    })
    const metrics = evaluatePack(withHidden, ADVISE)
    assert.equal(metrics.entityVisibleCeiling, 0.5, 'one of two collisions is unreachable')
    assert.equal(metrics.recallWithinCeiling, 1, 'every reachable collision was found')
    assert.equal(metrics.recall, 0.5, 'raw recall reflects the structural miss')
  })

  test('an advisory arm flags but does not refuse; a gated arm refuses', () => {
    const control = pack({
      proposals: [
        {
          id: 'p-overlap-control',
          sessionId: 's2',
          taskId: 'T2',
          entityPath: 'a.py',
          intentText: 'completely unrelated purpose',
          truth: 'independent',
          truthKind: 'independent-control',
          why: '',
        },
      ],
    })
    const advisory = evaluatePack(control, ADVISE)
    const gated = evaluatePack(control, GATED)

    assert.equal(advisory.controlFlagRate, 1, 'the overlap is raised either way')
    assert.equal(advisory.falseRejectionRate, 0, 'an advisory cannot refuse anything')
    assert.equal(gated.falseRejectionRate, 1, 'a denial refuses legitimate work, which is H9 territory')
  })

  test('every outcome carries the basis it was decided on, so a metric is traceable', () => {
    const metrics = evaluatePack(twoCases, ADVISE)
    const hit = metrics.outcomes.find((o) => o.id === 'p-hit')!
    assert.equal(hit.detection, 'duplicate-intent')
    assert.equal(hit.overlapsPriorWork, true)
    const clean = metrics.outcomes.find((o) => o.id === 'p-clean')!
    assert.equal(clean.detection, 'no-contention')
    assert.equal(clean.overlapsPriorWork, false)
  })

  test('proposals cannot see each other, so pack order cannot become an effect', () => {
    const forward = evaluatePack(twoCases, ADVISE)
    const reversed = evaluatePack({ ...twoCases, proposals: [...twoCases.proposals].reverse() }, ADVISE)
    assert.equal(reversed.tp, forward.tp)
    assert.equal(reversed.fp, forward.fp)
    assert.equal(reversed.recall, forward.recall)
  })
})

describe('prior contention replay', () => {
  test('derives from prior events only, never from the proposals', () => {
    const contention = priorContention(pack(), '2026-04-01T00:00:00Z')
    assert.equal(contention.length, 1)
    assert.equal(contention[0].entityKey, 'file::a.py')
    assert.deepEqual(contention[0].tasks, ['T1'])
  })
})
