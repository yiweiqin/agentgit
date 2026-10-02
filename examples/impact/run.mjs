#!/usr/bin/env node
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { computeImpactReport, ensureWorkspace, recordImpactChange, recordImpactSession } from '../../packages/core/src/index.ts'

const root = mkdtempSync(join(tmpdir(), 'agentgit-impact-demo-'))
try {
  const paths = ensureWorkspace(root)
  const consumer = { sessionId: 'caller-window', taskId: 'login-client' }
  recordImpactSession(paths, { goal: 'Implement login client', contracts: [{ name: 'auth.login', version: 1 }] }, consumer)
  recordImpactSession(paths, { goal: 'Change unrelated styles' }, { sessionId: 'style-window', taskId: 'styles' })
  recordImpactChange(paths, { stream: 'auth.login', revision: 1, summary: 'Auth.login now returns an object',
    before: 'Token', after: '{token, expires_at}', contracts: [{ name: 'auth.login', version: 2, breaking: true }],
    evidence: ['src/auth.ts:42'] }, { sessionId: 'auth-window', taskId: 'login-api' })
  const before = computeImpactReport(paths).notifications
  assert.equal(before.length, 1)
  assert.equal(before[0].targetSessionId, consumer.sessionId)
  assert.equal(before[0].category, 'breaking_dependency')
  assert.equal(before[0].policy, 'interrupt')
  console.log('PASS: only the caller receives a breaking-dependency advisory at its next safe point.')
  recordImpactSession(paths, { goal: 'Implement login client', contracts: [{ name: 'auth.login', version: 2 }] }, consumer)
  assert.equal(computeImpactReport(paths).notifications.filter(n => n.policy !== 'store-only').length, 0)
  console.log('PASS: after the caller records v2, the pending advisory disappears.')
} finally { rmSync(root, { recursive: true, force: true }) }
