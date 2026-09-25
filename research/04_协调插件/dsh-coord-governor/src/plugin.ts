/**
 * Cordis host adapter for DeepSeek Harness.
 *
 * Intentionally thin. Every judgement lives in `ledger.ts` / `policy.ts` /
 * `governor.ts`, which import no host package and are covered by tests. That
 * split is what makes this plugin defensible against a v0.1 preview whose API
 * reserves the right to break: the part that can break is small, and the part
 * that matters is verified independently of it.
 *
 * Verified against the shipped `time-context` plugin for the `agent/pre-step`
 * injection pattern, and against the repository's generated
 * `docs/event-producer-consumer.md` for every event name and mode.
 *
 * @module dsh-coord-governor/plugin
 */

// Every host import below is `import type` on purpose, and there is deliberately no value
// import of any `@deepseek-ai/*` package anywhere in this plugin. A plugin mounted by
// filesystem path resolves host packages through a second location, which gives the process
// two instances of the DeepSeek request-extension registry; that registry asserts single
// ownership of each top-level request field, so the duplicate turns every model call into
// `REQUEST_EXTENSION: DeepSeek request extension preparation failed`. Type-only imports are
// erased by Node's type stripping and so are safe. See `message.ts` for the measurement.
import type { Context } from '@deepseek-ai/cordis'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { FsTarget, FsWriteIntent } from '@deepseek-ai/dsh-fs'
// Imported for its `Events` augmentation as much as for these types: `tools/pre-execute`
// and `tools/post-execute` are declared in this package, so without it in the program the
// event names fail to type-check — which is how a gate that silently never fires would
// have been discovered only in a live run, after the experiments were already designed
// around it.
import type {
  PostToolDecision,
  PreToolDecision,
  ToolExecution,
  ToolExecutionResult,
} from '@deepseek-ai/dsh-tools'

import {
  classifyTool,
  extractIntent,
  extractPaths,
  guardDecision,
  safeHandler,
  sessionIdOf,
  toEntities,
} from './adapter.ts'
import { resolveArm, type ArmName, type CoordConfig } from './config.ts'
import { GovernorRuntime } from './governor.ts'
import { createUserMessage } from './message.ts'
import { appendLedgerLine, ledgerFilePath } from './store.ts'

export const name = 'coord-governor'

/**
 * No service dependency. This plugin only registers listeners, so declaring one
 * would make it unloadable in a host that lacks that service for no benefit.
 */
export const inject: string[] = []

/**
 * Configuration schema.
 *
 * There is no schemastery `Config` export, and that is a deliberate trade rather than an
 * omission. `Config` would require importing `@deepseek-ai/schemastery` at runtime, which is
 * the one thing a path-mounted plugin cannot do — see `message.ts` for the measurement.
 * What is lost is host-side validation of the config block; what replaces it is
 * {@link resolveConfig}, which validates and defaults every field in code. For an experiment
 * that is the better half of the trade: a host that does not apply schema defaults still
 * produces a working plugin, rather than an arm silently running with `undefined` thresholds.
 *
 * The declared shape of the config block is {@link PluginConfig}.
 */
export interface PluginConfig {
  readonly arm?: string
  readonly ledgerPath?: string
  readonly advisoryMaxChars?: number
  readonly minOtherTasks?: number
  readonly duplicateIntentThreshold?: number
}

/**
 * Turn host config into a validated arm plus its tuning overrides.
 *
 * Returns the arm name alongside the config, because the arm name is itself
 * evidence: a run's ledger must be attributable to an arm without relying on the
 * harness to have labelled it correctly.
 *
 * Tuning is applied directly rather than through `overrideArm`, because
 * `overrideArm` guards arm *identity* — and tunables are exactly the fields it
 * permits.
 */
export function resolveConfig(config: PluginConfig | undefined): { armName: ArmName; config: CoordConfig } {
  const armName = (config?.arm ?? 'A1-instrument') as ArmName
  const arm = resolveArm(armName)
  return {
    armName,
    config: {
      ...arm,
      ledgerPath: config?.ledgerPath ?? arm.ledgerPath,
      advisoryMaxChars: config?.advisoryMaxChars ?? arm.advisoryMaxChars,
      policy: {
        ...arm.policy,
        minOtherTasks: config?.minOtherTasks ?? arm.policy.minOtherTasks,
        duplicateIntentThreshold:
          config?.duplicateIntentThreshold ?? arm.policy.duplicateIntentThreshold,
      },
    },
  }
}

/**
 * Register the plugin's listeners for the lifetime of `ctx`.
 *
 * Waterfall discipline, stated once because it is the easiest thing to get wrong:
 * every listener that wraps a `next()` callback **must** call it. A listener that returns
 * without delegating does not merely miss the write; it silently replaces the provider's
 * own staleness guard for every writer in the process.
 *
 * `fs/write-intent` is deliberately **not** registered here. It is the one hook that must be
 * registered synchronously from the host entry (see `host.ts`), because on this host a
 * listener added after `apply` has yielded to the event loop is never delivered. Everything
 * else is order-insensitive, so it stays here with the runtime it depends on.
 */
export interface Governor {
  readonly armName: ArmName
  readonly config: CoordConfig
  /** Register the order-insensitive listeners. */
  apply(ctx: Context): void
  /** Record one observed write intent. Called by the host entry, not by `apply`. */
  observeWriteIntent(target: FsTarget, actor: object | undefined, intent: FsWriteIntent | undefined): void
}

export function createGovernor(config?: PluginConfig): Governor {
  const { armName, config: resolved } = resolveConfig(config)
  const runtime = new GovernorRuntime(resolved, {
    sink: (line) => appendLedgerLine(ledgerFilePath(resolved.ledgerPath), line),
  })

  const report = (failed: string, error: unknown) => runtime.noteError(failed, error)

  /**
   * For `@mode emit` listeners only, whose return value nobody reads.
   *
   * Waterfall listeners deliberately do **not** go through this. It answers a failure
   * with `undefined`, and in a waterfall that is not "no opinion" — it discards the
   * decision the host was about to act on. They wrap their own contribution in
   * `guardDecision` instead, falling back to the decision `next()` already produced.
   */
  const guarded = <A extends unknown[], R>(handler: string, fn: (...args: A) => R) =>
    safeHandler(handler, fn, report)

  return {
    armName,
    config: resolved,

    /**
     * The authoritative write-intent observation point.
     *
     * `target.targetKey` is the backend's stable identity — a strictly better key than any
     * path parsed out of tool arguments. The `actor` is the tool execution, so the session
     * is reached through `actor.agent`; {@link sessionIdOf} performs that hop.
     */
    observeWriteIntent(target, actor, intent) {
      try {
        const sessionId = sessionIdOf(actor)
        if (sessionId && target?.displayPath) {
          // Recorded as the ISCC kind `file_write`, not a private `write_intent`:
          // `coord_ledger.py` counts entity touches only for `file_write`, so any
          // other name would make contention invisible to the shared analyser.
          runtime.observe({
            kind: 'file_write',
            sessionId,
            entities: toEntities([target.displayPath]),
            hostEvent: 'fs/write-intent',
            detail: { targetKey: String(target.targetKey), phase: 'intent' },
          })
        }
      } catch (error) {
        report('fs/write-intent', error)
      }
      void intent
    },

    apply(ctx: Context): void {
      // Declare the arm in the host log, so a run cannot be mislabelled afterwards.
      ctx.logger?.info?.(`coord-governor arm=${armName} scope=${resolved.ledgerScope} gate=${resolved.gate}`)

      // --- session lifecycle -------------------------------------------------

      ctx.on('session/created', guarded('session/created', (session: unknown) => {
        const sessionId = sessionIdOf(session)
        if (!sessionId) return
        runtime.observe({ kind: 'session_started', sessionId, hostEvent: 'session/created' })
      }))

      /**
       * The durable append feed, and the **only** place context loss is visible.
       *
       * `compaction/start|summary|end` are session *events*, not Cordis events. A
       * listener on `ctx.on('compaction/end', ...)` would never fire — the event matrix
       * lists them under the `session/event` feed, not as standalone events. Getting
       * this wrong would leave the H3 probe silently reading zero for every run.
       */
      ctx.on('session/event', guarded('session/event', (session: unknown, event: unknown) => {
        const sessionId = sessionIdOf(session)
        if (!sessionId) return
        const type = (event as { type?: unknown } | null)?.type
        if (type === 'compaction/end') {
          runtime.noteCompaction(sessionId)
        } else if (type === 'turn/end') {
          runtime.observe({ kind: 'turn_ended', sessionId, hostEvent: 'turn/end' })
        }
      }))

      // --- governance: the admission gate ------------------------------------

      ctx.on('tools/pre-execute', async (
        exec: ToolExecution,
        next: () => Promise<PreToolDecision>,
      ) => {
        const decision = await next()
        return guardDecision('tools/pre-execute', decision, () => {
          // Respect an earlier refusal. This gate narrows; it never widens.
          if (decision.kind !== 'allow') return decision

          const sessionId = sessionIdOf(exec.agent)
          if (!sessionId) return decision

          const toolClass = classifyTool(exec.name)

          // Shell tools write files whose paths are not statically visible. Record the
          // gap instead of pretending coverage is total; E0 measures how large it is.
          if (toolClass === 'shell') {
            runtime.observe({
              kind: 'command',
              sessionId,
              hostEvent: 'tools/pre-execute',
              detail: { toolName: exec.name, coverageGap: 'shell-file-effects-not-statically-visible' },
            })
            return decision
          }
          if (toolClass !== 'write') return decision

          const intentText = extractIntent(exec.arguments)
          for (const path of extractPaths(exec.arguments)) {
            const proposal = { entityKey: `file::${path}`, entityPath: path, sessionId, intentText, toolName: exec.name }
            const govDecision = runtime.decide(proposal)
            runtime.noteGate(govDecision, proposal)

            if (govDecision.action === 'deny') return { kind: 'deny', reason: govDecision.reason }
            // `ask` needs an approval answerer. In an unattended experiment one must be
            // configured or the turn stalls — see the preregistration's stopping rules.
            if (govDecision.action === 'ask') return { kind: 'ask', reason: govDecision.reason }
          }
          return decision
        }, report)
      })

      // --- governance: the post-write advisory --------------------------------

      /**
       * After a write, the entity is finally known, so this is where a per-entity
       * advisory can land. It cannot prevent the write that just happened; it informs
       * the next step, which is exactly how coordination is supposed to work — the
       * agent learns what it could not have known.
       */
      ctx.on('tools/post-execute', async (
        exec: ToolExecution,
        result: Readonly<ToolExecutionResult>,
        next: () => Promise<PostToolDecision>,
      ) => {
        const decision = await next()
        return guardDecision('tools/post-execute', decision, () => {
          const settleSession = sessionIdOf(exec.agent)
          if (settleSession) {
            // Deliberately carries no entities and uses a non-ISCC kind: an entity-bearing
            // `file_write` here would double-count every write and inflate contention on
            // the Python side, which counts entity touches per event.
            runtime.observe({
              kind: 'write_settled',
              sessionId: settleSession,
              hostEvent: 'tools/post-execute',
              reason: result.isError ? 'error' : 'ok',
            })
          }
          if (!resolved.advisory) return decision
          if (decision.kind !== 'accept') return decision

          const sessionId = sessionIdOf(exec.agent)
          if (!sessionId) return decision

          const intentText = extractIntent(exec.arguments)
          const texts: string[] = []
          for (const path of extractPaths(exec.arguments)) {
            const proposal = { entityKey: `file::${path}`, entityPath: path, sessionId, intentText }
            const text = runtime.advisory(proposal, runtime.decide(proposal))
            if (text) texts.push(text)
          }
          if (texts.length === 0) return decision

          const joined = texts.join('\n\n')
          const capped =
            joined.length <= resolved.advisoryMaxChars
              ? joined
              : `${joined.slice(0, Math.max(0, resolved.advisoryMaxChars - 3))}...`

          // Spread first, so a `value`-carrying `accept` keeps its shape and only the
          // context array is added.
          return {
            ...decision,
            additionalContexts: [
              ...(decision.additionalContexts ?? []),
              createUserMessage({
                content: [{ type: 'text', text: capped }],
                source: { kind: 'plugin', plugin: name, form: 'snapshot', sections: [{ name, text: capped }] },
              }),
            ],
          }
        }, report)
      })

      // --- governance: the pre-step overview ---------------------------------

      /**
       * Cross-session overview injection, following the shipped `time-context`
       * plugin's shape: await the host's decision, then append one plugin-sourced
       * message to it. `next()` is always called, so messages the host admitted are
       * preserved.
       */
      ctx.on('agent/pre-step', async (
        payload: { agent?: unknown; signal?: AbortSignal },
        next: () => Promise<PreStepDecision>,
      ) => {
        const decision = await next()
        return guardDecision('agent/pre-step', decision, () => {
          if (decision.kind === 'reject' || payload.signal?.aborted) return decision
          if (!resolved.advisory) return decision

          const sessionId = sessionIdOf(payload.agent)
          if (!sessionId) return decision

          const text = runtime.advisoryOverview(sessionId)
          if (!text) return decision

          return {
            ...decision,
            messages: [
              ...decision.messages,
              createUserMessage({
                content: [{ type: 'text', text }],
                source: { kind: 'plugin', plugin: name, form: 'snapshot', sections: [{ name, text }] },
              }),
            ],
          }
        }, report)
      }, { prepend: true })

      // A silently broken instrument produces reassuring data, so faults are counted
      // and surfaced rather than swallowed. `safeHandler` keeps them from reaching the
      // host; this keeps them from vanishing.
      ctx.on('session/disposed', guarded('session/disposed', () => {
        if (runtime.errors.length > 0) {
          const first = runtime.errors[0]
          ctx.logger?.warn?.(
            `coord-governor: ${runtime.errors.length} contained fault(s); first: ${first.handler}: ${first.message}`,
          )
        }
      }))
    },
  }
}
