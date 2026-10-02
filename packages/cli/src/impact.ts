import { readFileSync } from 'node:fs'
import { acknowledgeImpact, computeImpactReport, publishImpactProjection, recordImpactChange, recordImpactSession, renderImpact,
  type ImpactIdentity, type WorkspacePaths } from '@agentgit/core'
import type { ParsedArgs } from './args.ts'

/** JSON files keep structured declarations intact across shells and platforms. */
export function cmdImpact(args: ParsedArgs, paths: WorkspacePaths, identity: ImpactIdentity): number {
  const verb = args.subcommand ?? 'analyze'
  let result: unknown
  if (verb === 'state' || verb === 'publish') {
    const file = args.value('file')
    if (!file || file === 'true') throw new Error('impact state/publish requires --file <JSON file> (use - for stdin)')
    const value: unknown = JSON.parse(readFileSync(file === '-' ? 0 : file, 'utf8'))
    result = verb === 'state' ? recordImpactSession(paths, value, identity) : recordImpactChange(paths, value, identity)
    publishImpactProjection(paths)
  } else if (verb === 'ack') {
    const id = args.positionals[0]
    if (!id) throw new Error('impact ack requires a notification ID and the receiving --session')
    acknowledgeImpact(paths, identity.sessionId, id)
    publishImpactProjection(paths)
    result = { id, status: 'acknowledged' }
  } else if (verb === 'analyze' || verb === 'inbox') {
    const report = args.boolean('refresh') ? publishImpactProjection(paths) : computeImpactReport(paths)
    const notifications = verb === 'inbox' ? report.notifications.filter(n => n.targetSessionId === identity.sessionId) : report.notifications
    result = verb === 'inbox' ? { workspace: report.workspace, generatedAt: report.generatedAt, malformed: report.malformed, notifications }
      : { ...report, notifications }
    if (!args.boolean('json')) {
      process.stdout.write(notifications.length ? `${notifications.map(n => `${n.id} (${n.status})\n${renderImpact(n)}`).join('\n\n')}\n`
        : 'No current cross-session impacts.\n')
      if (report.malformed) process.stdout.write(`Skipped ${report.malformed} malformed observation(s).\n`)
      return 0
    }
  } else throw new Error(`Unknown impact command: ${verb}`)
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  return 0
}
