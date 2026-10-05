#!/usr/bin/env node
/**
 * Hook dispatcher: one Node startup for a whole lifecycle event.
 *
 * Why this file exists
 * --------------------
 * Each hook script used to be its own handler, so a session start spawned four `node` processes
 * and every file edit spawned two. Process startup, not the script, is the cost: the scripts
 * themselves are milliseconds, and a session that makes two hundred tool calls paid that startup
 * a hundred times over. Measured on Windows, a 200-step session spent about forty seconds
 * waiting for Node to boot and immediately exit.
 *
 * This file reads stdin once and runs the same steps in the same order in a single process. The
 * scripts it calls are unchanged in behaviour — each still exports the same `run(payloadText)`
 * and still works standalone for its own tests.
 *
 * The order, and why it is the order
 * ----------------------------------
 * - `SessionStart` / `UserPromptSubmit`: record, then ensure a daemon, then read the ruling, then
 *   consider asking the user something. Recording must never be delayed by anything downstream.
 * - `PreToolUse`: record, and run the hub only for a call that can change a file. A ruling is
 *   only worth interrupting a write with when the write is about the ground it rules on.
 * - `PostToolUse`: record, then deliver deferred impact updates. `Stop`: record only.
 *
 * It cannot fail loudly
 * ---------------------
 * Each step is wrapped on its own, so one dead script cannot stop the rest, and the whole thing
 * still ends in `exit 0`. The only stdout it ever produces is one valid hook-output object.
 *
 * @module agentgit/hook
 */

import { isDirectRun, noteFailure } from './hook-errors.mjs'
import { normalizePayload, readStdin } from './hook-runtime.mjs'
import { run as runDesktop } from './desktop.mjs'
import { run as runHub } from './hub.mjs'
import { run as runSpine } from './spine.mjs'
import { run as runTrack } from './track.mjs'

/**
 * Tools whose pending write can touch ruled ground.
 *
 * Mirrors the matcher the generated `hooks.json` used to carry (`apply_patch|Edit|Write`), kept
 * here now that there is one handler: a shell command carries no statically visible path, so the
 * hub has nothing to match it against and running it would only cost a file read.
 */
const WRITE_LIKE = /apply_patch|edit|write|patch/i

/**
 * Run one step and return its hook-output object, or `null`.
 *
 * The step's own `run` already returns the exact stdout it would print standalone, so the merge
 * is done on the parsed object rather than re-rendering. A step that throws is recorded and
 * skipped, never allowed to stop the others or the process. `label` names the step in that
 * record: "one of the four failed" is not enough to act on.
 */
function step(label, name, payloadText) {
  try {
    const output = name(payloadText)
    if (typeof output !== 'string' || output === '') return null
    const parsed = JSON.parse(output)
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch (error) {
    noteFailure('hook', error, { cwd: process.cwd(), event: label })
    return null
  }
}

function contextOf(output) {
  const text = output?.hookSpecificOutput?.additionalContext
  return typeof text === 'string' && text !== '' ? text : null
}

/**
 * The dispatcher's whole job: choose the steps, run them, merge their context.
 *
 * Returns the single hook-output object to print, or `null` when no step had anything to say.
 */
export function run(payloadText) {
  const route = normalizePayload(payloadText)
  if (!route) return null
  const { eventName, toolName } = route

  const steps = []
  if (eventName === 'SessionStart' || eventName === 'UserPromptSubmit') {
    steps.push(['track', runTrack], ['spine', runSpine], ['hub', runHub], ['desktop', runDesktop])
  } else if (eventName === 'PreToolUse') {
    steps.push(['track', runTrack])
    // Only a pending *write* is worth a ruling about the ground it is about to touch.
    if (WRITE_LIKE.test(toolName ?? '')) steps.push(['hub', runHub])
  } else if (eventName === 'PostToolUse') {
    // Record first, then let the hub speak. A global ruling has nothing to say here - by now
    // there is no write left to interrupt - but the impact protocol's deferred class is
    // explicitly held back until a tool has completed, and this is that moment. The desktop
    // hook goes last and only ever *offers*: a completed write is the one moment a session that
    // began before the plugin was enabled can still be asked, and asking changes no state but
    // the record of the question.
    steps.push(['track', runTrack], ['hub', runHub], ['desktop', runDesktop])
  } else if (eventName === 'Stop') {
    steps.push(['track', runTrack])
  } else {
    return null
  }

  const parts = []
  for (const [label, name] of steps) {
    const context = contextOf(step(label, name, payloadText))
    if (context) parts.push(context)
  }
  if (parts.length === 0) return null
  return `${JSON.stringify({
    hookSpecificOutput: { hookEventName: eventName, additionalContext: parts.join('\n\n') },
  })}\n`
}

if (isDirectRun(import.meta.url)) {
  let output = null
  try {
    output = run(readStdin())
  } catch (error) {
    // A hook that throws can break a tool call, which is never worth it for coordination.
    noteFailure('hook', error, { cwd: process.cwd() })
  }
  if (output) process.stdout.write(output)
  process.exit(0)
}
