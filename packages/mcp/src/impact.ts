import { acknowledgeImpact, computeImpactReport, publishImpactProjection, recordImpactChange, recordImpactSession, renderImpact } from '@agentgit/core'
import type { ToolDefinition } from './tools.ts'

const identityProperties = {
  workspace: { type: 'string', description: 'Workspace directory override.' },
  session: { type: 'string', description: 'Current session ID.' },
  task: { type: 'string', description: 'Current task ID.' },
}
const declaration = (kind: 'state' | 'change'): ToolDefinition => ({
  name: kind === 'state' ? 'agentgit_impact_state' : 'agentgit_impact_publish',
  title: kind === 'state' ? 'Declare session dependencies' : 'Publish a structured change',
  description: kind === 'state'
    ? 'Replace this session\'s current goal, phase, entities, dependencies, contract assumptions and artifacts. Declare fully qualified entity keys; explicit state makes directional impact analysis possible.'
    : 'Publish a versioned change with before/after, compatibility and evidence. Reusing the same event is idempotent; increment revision in the same stream to supersede it. No messages are sent to other chats.',
  inputSchema: {
    type: 'object', properties: { ...identityProperties, [kind]: {
      type: 'object', description: kind === 'state'
        ? 'Fields: goal, phase (planned|working|writing|idle), active, worktree, branch, entities [{key,path?,access}], dependencies [{entity,relation,parts?}], contracts [{name,version,parts?}], artifacts [{id,version?,access}]. This replaces previous state.'
        : 'Required: stream, revision (positive integer), summary, and entities/contracts/artifacts. Optional: eventId, goal, before, after, status (planned|in_progress|completed|cancelled), compatibility (unknown|compatible|breaking), worktree, branch, expiresAt, evidence (references). Changed entities/artifacts need access: write; contracts use {name,version,breaking,parts?}.',
    } }, required: [kind], additionalProperties: false,
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: kind === 'change', openWorldHint: false },
  handler(args, context) {
    const { paths, sessionId, taskId } = context.identity
    const identity = { sessionId, taskId }
    const result = kind === 'state' ? recordImpactSession(paths, args.state, identity, context.now)
      : recordImpactChange(paths, args.change, identity, context.now)
    publishImpactProjection(paths, { now: context.now })
    return { text: kind === 'state' ? 'Session state recorded.' : 'Change recorded; affected sessions can receive it at a safe point.', structured: result }
  },
})

export const IMPACT_TOOLS: readonly ToolDefinition[] = [
  {
    name: 'agentgit_impacts', title: 'Read this session\'s current impacts',
    description: 'Recheck live evidence and return only changes affecting this session. Reports heuristic confidence, severity, urgency, delivery policy and receipt status separately. Reading does not acknowledge or deliver a notification.',
    inputSchema: { type: 'object', properties: identityProperties, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    handler(_args, context) {
      const report = computeImpactReport(context.identity.paths, { now: context.now })
      const notifications = report.notifications.filter(n => n.targetSessionId === context.identity.sessionId)
      return { text: notifications.length ? notifications.map(renderImpact).join('\n\n') : 'No current impacts for this session.',
        structured: { notifications, generatedAt: report.generatedAt, malformed: report.malformed } }
    },
  },
  declaration('state'), declaration('change'),
  {
    name: 'agentgit_impact_ack', title: 'Acknowledge an impact',
    description: 'Record that this receiving session has handled a current impact. Acknowledgement suppresses repeats; update contract assumptions or session state to record the actual adaptation.',
    inputSchema: { type: 'object', properties: { ...identityProperties, id: { type: 'string' } }, required: ['id'], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    handler(args, context) {
      if (typeof args.id !== 'string') throw new Error('id must be a notification ID')
      acknowledgeImpact(context.identity.paths, context.identity.sessionId, args.id, context.now)
      publishImpactProjection(context.identity.paths, { now: context.now })
      return { text: `Acknowledged ${args.id}.`, structured: { id: args.id, status: 'acknowledged' } }
    },
  },
]
