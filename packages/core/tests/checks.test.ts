import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beginSetup, endSetup, configureChecks, editChecks, isCheckMessage, needsWake, readChecks, recordWake, reserveCheck, syncChecks, updateCheck } from '../src/checks.ts'
import { writeDesktopState } from '../src/desktop.ts'
import { ensureWorkspace, type WorkspacePaths } from '../src/workspace.ts'
import type { HubVerdict } from '../src/hub.ts'
import { acknowledgeImpact, publishImpactProjection, recordImpactChange, recordImpactSession } from '../src/impact-state.ts'
import { replaceChecksFile } from '../src/checks.ts'

test('transient Windows destination locks retry without deleting evidence; permanent errors surface', () => {
  let attempts = 0
  replaceChecksFile('source', 'target', () => {
    if (++attempts < 3) throw Object.assign(new Error('scanner lock'), { code: 'EPERM' })
  }, () => {})
  assert.equal(attempts, 3)
  assert.throws(() => replaceChecksFile('source', 'target', () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }) }, () => {}), /missing/)
  attempts = 0
  assert.throws(() => replaceChecksFile('source', 'target', () => { attempts++; throw Object.assign(new Error('locked'), { code: 'EBUSY' }) }, () => {}), /locked/)
  assert.equal(attempts, 6)
})

const coordinator = '11111111-1111-4111-8111-111111111111'
const target = '22222222-2222-4222-8222-222222222222'
let root: string
let paths: WorkspacePaths
let hub: HubVerdict
const now = new Date('2026-09-27T10:00:00Z')
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'agentgit-checks-'))
  paths = ensureWorkspace(root)
  configureChecks(paths, coordinator, process.execPath, now)
  hub = { workspace: root, id: 'hub-one', rulings: [{ entityKey: 'file::a.ts', word: 'reuse', sessions: [target, coordinator], path: 'a.ts', intents: ['same work'], owner: { taskId: coordinator } }], stale: [] } as unknown as HubVerdict
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

test('simultaneous acceptances reserve one setup; another chat cannot release it', () => {
  editChecks(paths, state => { state.config = null })
  assert.deepEqual(beginSetup(paths, coordinator, now), { coordinator: null, reserved: true })
  assert.throws(() => beginSetup(paths, target, now), /Another chat/)
  endSetup(paths, target)
  assert.throws(() => beginSetup(paths, target, now), /Another chat/)
  endSetup(paths, coordinator)
  assert.equal(beginSetup(paths, target, now).reserved, true)
})

test('a crashed setup can expire, but a created chat is reused before and after enabling', () => {
  editChecks(paths, state => { state.config = null })
  beginSetup(paths, coordinator, now)
  assert.equal(beginSetup(paths, target, new Date(now.getTime() + 16 * 60_000)).reserved, true)
  writeDesktopState(paths, { threadId: coordinator })
  assert.deepEqual(beginSetup(paths, target, now), { coordinator, reserved: false })
  configureChecks(paths, coordinator, process.execPath, now)
  assert.equal(readChecks(paths).setup, null)
  assert.deepEqual(beginSetup(paths, target, now), { coordinator, reserved: false })
})

test('only opt-in workspaces enqueue checks, and the coordinator is not messaged as a participant', () => {
  assert.equal(syncChecks(paths, hub, now).jobs.length, 1)
  editChecks(paths, state => { state.config!.enabled = false })
  assert.equal(needsWake(syncChecks(paths, hub, now)), null)
})

test('a cross-file duplicate is queued to the other window, not only shown in-session', () => {
  // The pair shares no entity, so no ruling can carry it. It is still a real duplication, and the
  // two windows doing the work are the ones that have to hear about it.
  const other = '33333333-3333-4333-8333-333333333333'
  const withDuplicate = {
    ...hub,
    id: 'hub-dup',
    rulings: [],
    duplicateWork: [{
      tasks: [coordinator, other],
      similarity: 0.71,
      intents: ['add rate limiting to login', 'throttle repeated login failures'],
      sessions: [[coordinator], [other]],
    }],
  } as unknown as HubVerdict
  const state = syncChecks(paths, withDuplicate, now)
  const jobs = state.jobs.filter(job => job.verdict === 'duplicate-work')
  assert.equal(jobs.length, 1, 'the coordinator is not messaged as a participant')
  assert.equal(jobs[0].target, other)
  assert.equal(jobs[0].entity, `duplicate::${coordinator}|${other}`)
  assert.ok(needsWake(state, now))
})

test('a duplicate from a projection written before sessions existed is ignored, not guessed', () => {
  const legacy = {
    ...hub,
    rulings: [],
    duplicateWork: [{ tasks: ['t1', 't2'], similarity: 0.5, intents: ['a', 'b'] }],
  } as unknown as HubVerdict
  assert.equal(syncChecks(paths, legacy, now).jobs.filter(job => job.verdict === 'duplicate-work').length, 0)
})

test('directional checks select only the affected recipient and cancel after acknowledgement', () => {
  recordImpactSession(paths, { contracts: [{ name: 'api', version: 1 }] }, { sessionId: target, taskId: 'consumer-task' }, now)
  recordImpactChange(paths, { stream: 'api', revision: 1, summary: 'new return type', contracts: [{ name: 'api', version: 2, breaking: true }] },
    { sessionId: coordinator, taskId: 'producer-task' }, now)
  const report = publishImpactProjection(paths, { now })
  const jobs = syncChecks(paths, hub, now).jobs
  assert.equal(jobs.length, 1)
  assert.equal(jobs[0].target, target)
  assert.equal(jobs[0].verdict, 'breaking_dependency')
  acknowledgeImpact(paths, target, report.notifications[0].id, now)
  assert.equal(syncChecks(paths, hub, now).jobs[0].status, 'cancelled')
})

test('deferred relevance and lexical overlap do not wake the cross-chat coordinator', () => {
  recordImpactSession(paths, { goal: 'shared goal', contracts: [{ name: 'api', version: 1 }] }, { sessionId: target, taskId: 'consumer' }, now)
  recordImpactChange(paths, { goal: 'shared goal', stream: 'api', revision: 1, summary: 'additive feature',
    contracts: [{ name: 'api', version: 2, breaking: false }] }, { sessionId: coordinator, taskId: 'producer' }, now)
  publishImpactProjection(paths, { now })
  assert.equal(syncChecks(paths, hub, now).jobs.length, 0)
})
test('unrelated global ruling changes, session order and restarts do not duplicate a check', () => {
  const first = syncChecks(paths, hub, now).jobs[0]
  hub = { ...hub, id: 'hub-two', rulings: [{ ...hub.rulings[0], sessions: [coordinator, target] }] }
  assert.equal(syncChecks(paths, hub, now).jobs[0].id, first.id)
  assert.equal(readChecks(paths).jobs.length, 1)
})
test('reservation prevents duplicate dispatch and receipts bind both token and target', () => {
  const id = syncChecks(paths, hub, now).jobs[0].id
  const reserved = reserveCheck(paths, id, target, now)
  assert.throws(() => reserveCheck(paths, id, target, now), /do not send/)
  assert.throws(() => updateCheck(paths, id, reserved.token!, coordinator, 'replied', 'wrong', now), /does not match/)
  assert.throws(() => updateCheck(paths, id, 'wrong', target, 'sent', undefined, now), /does not match/)
  updateCheck(paths, id, reserved.token!, target, 'sent', undefined, now)
  updateCheck(paths, id, reserved.token!, target, 'replied', 'I disagree; this interface is unrelated', now)
  assert.equal(readChecks(paths).jobs[0].status, 'replied')
  assert.equal(needsWake(readChecks(paths), now), null)
})
test('missing replies expire and verified late replies are accepted without re-sending', () => {
  const id = syncChecks(paths, hub, now).jobs[0].id
  const job = reserveCheck(paths, id, target, now)
  const later = new Date(now.getTime() + 11 * 60_000)
  assert.equal(syncChecks(paths, hub, later).jobs[0].status, 'timed_out')
  assert.throws(() => reserveCheck(paths, id, target, later), /do not send/)
  assert.ok(needsWake(readChecks(paths), later))
  assert.equal(updateCheck(paths, id, job.token!, target, 'replied', 'Late verified response', later).status, 'replied')
})
test('resolved issues cancel unsent jobs; a later recurrence receives a new check ID', () => {
  const first = syncChecks(paths, hub, now).jobs[0].id
  syncChecks(paths, { ...hub, rulings: [] }, now)
  assert.equal(readChecks(paths).jobs[0].status, 'cancelled')
  const again = syncChecks(paths, hub, now)
  assert.equal(again.jobs.length, 2)
  assert.notEqual(again.jobs[1].id, first)
  assert.equal(again.jobs[1].status, 'pending')
})
test('unknown session IDs are surfaced rather than guessed into another chat', () => {
  const state = syncChecks(paths, { ...hub, rulings: [{ ...hub.rulings[0], sessions: ['mcp-guessed-42'] }] }, now)
  assert.equal(state.jobs.length, 0)
  assert.match(state.unresolved[0], /cannot map/)
  assert.ok(needsWake(state, now))
})
test('interface version changes enqueue refresh/review checks', () => {
  const state = syncChecks(paths, { ...hub, rulings: [], stale: [{ taskId: target, contract: 'api', assumedVersion: 1, currentVersion: 2, breaking: true }] }, now)
  assert.equal(state.jobs[0].verdict, 'review')
  assert.equal(state.jobs[0].entity, 'contract::api')
})
test('queue acceptance is remembered, failures have bounded delayed retries', () => {
  const state = syncChecks(paths, hub, now)
  const key = needsWake(state, now)!
  recordWake(paths, key, 'offline', now)
  assert.equal(needsWake(readChecks(paths), now), null)
  const later = new Date(now.getTime() + 61_000)
  assert.equal(needsWake(readChecks(paths), later), key)
  recordWake(paths, key, 'offline', later)
  recordWake(paths, key, 'offline', later)
  assert.equal(needsWake(readChecks(paths), new Date(now.getTime() + 3600_000)), null)
  recordWake(paths, key, null, later)
  assert.equal(needsWake(readChecks(paths), later), null)
})
test('corrupt state and cross-workspace projections fail closed without overwriting evidence', () => {
  assert.throws(() => syncChecks(paths, { ...hub, workspace: join(root, 'other') }, now), /another workspace/)
  writeFileSync(join(paths.state, 'checks.json'), '{broken')
  assert.throws(() => syncChecks(paths, hub, now))
})
test('a queued wake with no progress can be retried after fifteen minutes, at most three times', () => {
  const key = needsWake(syncChecks(paths, hub, now), now)!
  recordWake(paths, key, null, now)
  const later = new Date(now.getTime() + 16 * 60_000)
  assert.equal(needsWake(readChecks(paths), later), key)
  recordWake(paths, key, null, later)
  recordWake(paths, key, null, later)
  assert.equal(needsWake(readChecks(paths), new Date(now.getTime() + 60 * 60_000)), null)
})
test('protocol messages do not become task intent and normal user requests remain visible', () => {
  assert.ok(isCheckMessage('AgenticGit 协调检查 check-abcdef。请核验'))
  assert.ok(isCheckMessage('AgenticGit 自动协调唤醒 12abcd。'))
  assert.equal(isCheckMessage('AgenticGit 请实现自动检查'), false)
})
