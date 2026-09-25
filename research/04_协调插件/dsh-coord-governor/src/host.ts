/**
 * Cordis host entry point for the coordination governor.
 *
 * This file exists for one measured reason, and it is worth stating precisely because the
 * failure it prevents is invisible.
 *
 * On DeepSeek Harness, `ctx.on('fs/write-intent', ...)` is only delivered to a listener that
 * is registered *synchronously*, before `apply` surrenders a turn to the event loop. Measured
 * on the experiment machine with three arms differing in one thing each (`remote_bisect4.sh`,
 * same task, same build, same machine):
 *
 * | arm | shape                                                    | delivered |
 * |-----|----------------------------------------------------------|-----------|
 * | q4  | synchronous `apply`, 500 ms busy-wait, then register     | yes       |
 * | q5  | `await import(...)` before registering                   | **no**    |
 * | q6  | register first, then `await import(...)`                 | yes       |
 *
 * So it is not elapsed time and not an asynchronous `apply`: it is whether registration
 * happens before the first await. With ten successful and five failing runs, the split was
 * exactly "entry module imports something other than a builtin" versus "does not".
 *
 * The consequence of getting this wrong is the worst kind for an experiment. `file_write` is
 * what `lambda_produced`, `B(t)` and the contention detector are all derived from, so a
 * late-registered listener yields a run that starts, writes files, exits zero and produces a
 * *healthy-looking but empty* instrument.
 *
 * Hence the shape below: static imports are restricted to node builtins and type-only host
 * types (which Node's type stripping erases), the write-intent listener is registered as the
 * first statement of `apply`, and everything heavy is loaded afterwards with a dynamic
 * import. The core is started immediately rather than lazily so that a read-only session
 * still produces its `session_started` and `turn_ended` records.
 *
 * @module dsh-coord-governor/host
 */

import type { Context } from '@deepseek-ai/cordis'
import type { FsTarget, FsWriteIntent } from '@deepseek-ai/dsh-fs'

import type { Governor, PluginConfig } from './plugin.ts'

export const name = 'coord-governor'

/**
 * No service dependency. This plugin only registers listeners, so declaring one would make it
 * unloadable in a host that lacks that service for no benefit.
 */
export const inject: string[] = []

/** Load the core and let it register its order-insensitive listeners. */
function loadGovernor(ctx: Context, config?: PluginConfig): Promise<Governor> {
  return import('./plugin.ts').then((module) => {
    const governor = module.createGovernor(config)
    governor.apply(ctx)
    return governor
  })
}

export function apply(ctx: Context, config?: PluginConfig): void {
  // Assigned immediately after the synchronous registration below, so it is always set by the
  // time a listener can run. Declared before the listener so the listener closes over it.
  let governor: Promise<Governor> | undefined

  // Must stay the first statement in `apply`. See the table at the top of this file.
  ctx.on('fs/write-intent', async (
    target: FsTarget,
    actor: object | undefined,
    next: () => FsWriteIntent | undefined | Promise<FsWriteIntent | undefined>,
  ) => {
    const intent = await next()
    // A waterfall, so the returned value is a contract. Returning `intent` unchanged means a
    // recording fault costs this plugin's contribution and nothing else — the provider's own
    // decision still reaches the caller.
    try {
      const core = await governor
      core?.observeWriteIntent(target, actor, intent)
    } catch {
      // Contained on purpose: a recording fault must not deny the host its write. The core
      // counts its own faults once it is loaded; before that there is nowhere to count them.
    }
    return intent
  })

  governor = loadGovernor(ctx, config)

  // Never leave the rejection unhandled: a core that fails to load would otherwise surface as
  // an unhandled rejection long after the run it silently emptied.
  governor.catch((error: unknown) => {
    ctx.logger?.error?.(`coord-governor: core failed to load: ${String(error)}`)
  })
}

export default apply
