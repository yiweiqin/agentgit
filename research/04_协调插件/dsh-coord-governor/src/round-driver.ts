/**
 * In-process round driver: N agent sessions inside ONE host process.
 *
 * Why this file has to exist
 * --------------------------
 * `preregistration.md` §5.1 makes `A3-advisory` and `A4-gated` the treatment arms, and their
 * entire mechanism is `ledgerScope: 'cross-session'`. That scope is implemented by
 * `governor.ts#visibleContention` reading an instance's **in-memory** event list
 * (`#scopedEvents`). The ledger file is append-only and never read back, so N separate `dsh`
 * *processes* sharing a ledger directory cannot see each other: the treatment never fires and
 * a null result is indistinguishable from a broken wiring. That is rejection R4.3
 * (`顶会审稿意见_2026-09-23.md`), and it is why `arm_runner.py` refuses to run A3/A4 under a
 * multi-process topology instead of reporting a plausible zero.
 *
 * The fix is not a new mechanism. `dsh-agent-loop`'s `Config.agents` is documented as
 * "agents created or resumed at plugin startup", and `dsh-base`'s bundle patch leaves it empty
 * with the note that "raw overlays may create agents". The supported path is therefore to
 * create every session of a round through the **same** `ctx.agents` registry, so one
 * `GovernorRuntime` serves all of them and cross-session visibility is real.
 *
 * Two constraints shape the code below
 * ------------------------------------
 * 1. **No runtime import of any `@deepseek-ai/*` package**, for the reason measured in
 *    `message.ts`: a filesystem-mounted plugin that resolves host packages through a second
 *    location gives the process two request-extension registries, and every model call dies
 *    with `REQUEST_EXTENSION`. All host imports here are `import type` (erased by Node's type
 *    stripping) and the user-message constructor comes from `./message.ts`.
 *
 * 2. **Driving, not composing.** `AgentRegistry.create` awaits setup and only then starts the
 *    loop, so `agent.send(..., wakeup: true)` is legal as soon as `create` resolves. Sending
 *    from a creation *listener* would be illegal by contract.
 *
 * Completion signals a file, never `process.exit`. The session log is compressed on flush, so
 * exiting from inside the process can truncate the very evidence the round exists to produce.
 * The round script polls for the done marker and then sends SIGTERM, which the launcher's
 * documented exit path drains by disposing the root.
 *
 * @module dsh-coord-governor/round-driver
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

import { createUserMessage } from './message.ts'

export const name = 'coord-round-driver'

/**
 * `agents` is the registry the round is created through; that injection is the whole point.
 * `timer` is not required and deliberately not declared: this plugin registers nothing that
 * needs a clock, and a service dependency that is not used only makes the plugin unloadable
 * in a host that lacks it.
 */
export const inject: string[] = ['agents']

/** One session of a round, as the harness writes it. */
export interface RoundSessionSpec {
  /** Run label; also the name of the outcome file this driver writes. */
  readonly label: string
  /**
   * Session id to create the agent under.
   *
   * Supplied by the harness rather than minted here, because the harness must be able to map
   * a run label back to the host's session id to close that session's capsule. The plugin has
   * no other way to recover the join (it never records the working directory).
   */
  readonly sessionId: string
  /** Workspace for the fresh session. One directory per run, so two sessions cannot collide. */
  readonly cwd: string
  /** The task text, exactly as the plan declares it. */
  readonly prompt: string
  /** Provider route; the host's default model entry applies when omitted. */
  readonly provider?: string
  readonly model?: string
}

export interface RoundSpec {
  readonly experiment: string
  readonly arm: string
  readonly roundIndex: number
  /** Directory the per-run outcome files are written into. */
  readonly outcomeRoot: string
  /** Directory the done marker is written into; its parent may not exist yet. */
  readonly doneMarker: string
  readonly sessions: readonly RoundSessionSpec[]
}

/** Plugin config: where to read the round from. */
export interface PluginConfig {
  readonly specPath: string
}

/**
 * Read and shape-check the spec.
 *
 * Validated here rather than trusted, because a spec that lost a field produces a round that
 * runs, exits cleanly, and measures something other than the plan — the failure mode this
 * whole harness is built to make impossible.
 */
export function parseSpec(text: string): RoundSpec {
  const parsed = JSON.parse(text) as Partial<RoundSpec>
  if (!parsed || typeof parsed !== 'object') throw new Error('round spec must be a JSON object')
  if (typeof parsed.experiment !== 'string' || !parsed.experiment) throw new Error('spec.experiment is required')
  if (typeof parsed.arm !== 'string' || !parsed.arm) throw new Error('spec.arm is required')
  if (typeof parsed.roundIndex !== 'number') throw new Error('spec.roundIndex must be a number')
  if (typeof parsed.outcomeRoot !== 'string' || !parsed.outcomeRoot) throw new Error('spec.outcomeRoot is required')
  if (typeof parsed.doneMarker !== 'string' || !parsed.doneMarker) throw new Error('spec.doneMarker is required')
  if (!Array.isArray(parsed.sessions) || parsed.sessions.length === 0) {
    throw new Error('spec.sessions must be a non-empty array')
  }
  const seen = new Set<string>()
  for (const [index, session] of parsed.sessions.entries()) {
    const where = `spec.sessions[${index}]`
    if (!session || typeof session !== 'object') throw new Error(`${where} must be an object`)
    for (const field of ['label', 'sessionId', 'cwd', 'prompt'] as const) {
      if (typeof session[field] !== 'string' || !session[field]) {
        throw new Error(`${where}.${field} is required`)
      }
    }
    if (seen.has(session.sessionId)) {
      // Two agents under one session id is the registry's own hard error, and letting it throw
      // from deep inside `create` would make the round look like a host bug.
      throw new Error(`${where}.sessionId ${session.sessionId} is duplicated`)
    }
    seen.add(session.sessionId)
  }
  return parsed as RoundSpec
}

/**
 * One run's mechanical outcome, in the same `KEY=value` dialect the multi-process round
 * script writes, so `arm_runner.py` parses both backends with one function.
 *
 * `LANDED` and `CHANGED` are deliberately absent. This driver owns no git worktree (the
 * sessions share the host's sandboxed `cwd`), so it cannot see a diff, and guessing one would
 * let the driver decide the outcome it exists to observe. The round script appends both keys
 * after the round, from the per-run worktrees -- and `arm_runner.parse_outcome` is last-wins,
 * so an appended key is authoritative. A missing `LANDED` is a loud error there, never a
 * default of "did not land".
 */
function renderOutcome(input: {
  label: string
  sessionId: string
  exit: number
  seconds: number
  reason: string
}): string {
  return [
    `LABEL=${input.label}`,
    `SESSION=${input.sessionId}`,
    `EXIT=${input.exit}`,
    `SECONDS=${Math.round(input.seconds)}`,
    `REASON=${input.reason}`,
    '',
  ].join('\n')
}

/** Mount the driver: create every session of one round, run it to quiescence, then mark done. */
export async function apply(ctx: Context, config: PluginConfig): Promise<void> {
  const specPath = config?.specPath
  if (!specPath) throw new Error('coord-round-driver requires config.specPath')

  const spec = parseSpec(readFileSync(resolve(specPath), 'utf8'))
  mkdirSync(spec.outcomeRoot, { recursive: true })
  mkdirSync(dirname(resolve(spec.doneMarker)), { recursive: true })

  const runOne = async (session: RoundSessionSpec): Promise<void> => {
    const started = Date.now()
    let exit = 1
    let reason = 'ok'
    try {
      // `meta.cwd` is the fresh session's workspace. One per run, so two sessions of a round
      // cannot write over each other's files -- the multi-process backend isolates with a git
      // worktree for the same reason.
      const handle = await ctx.agents.create({
        sessionId: session.sessionId as SessionId,
        meta: { cwd: session.cwd },
        agentOptions: {
          ...(session.provider ? { provider: session.provider } : {}),
          ...(session.model ? { model: session.model } : {}),
        },
      })
      try {
        handle.agent.send(
          createUserMessage({
            content: [{ type: 'text', text: session.prompt }],
            source: { kind: 'user' },
          }),
          'next-turn',
          true,
        )
        await handle.agent.whenIdle()
        exit = 0
      } finally {
        // Disposal stops the loop, awaits its exit, unregisters the agent, removes the session
        // from the store, and unwinds the scope. Doing it before the done marker is what makes
        // the marker mean "this round's sessions are closed", not merely "they stopped asking
        // for tokens".
        await handle.dispose()
      }
    } catch (error) {
      reason = `driver-error:${error instanceof Error ? error.message : String(error)}`
      ctx.logger?.error?.(`coord-round-driver: ${session.label}: ${reason}`)
    }
    const path = `${spec.outcomeRoot}/${session.label}/outcome.env`
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(
      path,
      renderOutcome({
        label: session.label,
        sessionId: session.sessionId,
        exit,
        seconds: (Date.now() - started) / 1000,
        reason,
      }),
      'utf8',
    )
  }

  // `Promise.allSettled`, not `Promise.all`: one session's failure must not cancel its siblings
  // mid-turn, because the round's statistic is a *joint* outcome and a cancelled sibling would
  // silently shrink the denominator.
  await Promise.allSettled(spec.sessions.map((session) => runOne(session)))

  // The marker is last and contains no data: the round script polls for its existence, and a
  // marker written before the outcomes existed would let the harness collect a half-written
  // round.
  writeFileSync(resolve(spec.doneMarker), `${spec.arm}:${spec.roundIndex}\n`, 'utf8')
}

export default apply
