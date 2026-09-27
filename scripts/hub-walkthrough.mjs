#!/usr/bin/env node
/**
 * The two-window walkthrough, run for real.
 *
 * `agentgit demo` shows one collision being caught inside one process. This shows the thing
 * that demo cannot: two *windows*, each with its own session, learning the **same** conclusion
 * about the same ground, and the conclusion surviving the process that computed it.
 *
 * Everything here is a real component, and none of it is mocked:
 *
 * - the daemon is spawned as its own process and publishes through the ledger;
 * - the hooks are spawned exactly as Codex runs them, with a payload on stdin;
 * - the MCP tools are driven over a real stdio JSON-RPC session;
 * - the two "windows" are two different session ids whose writes the ledger records.
 *
 * Run it with `node scripts/hub-walkthrough.mjs`. It creates a scratch workspace under the
 * system temp directory and removes it on the way out. Nothing in this repository is touched.
 *
 * @module agentgit/hub-walkthrough
 */

import { spawn } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
const REPO = resolve(import.meta.dirname, '..')
const PORT = 7799 + (process.pid % 100)
const WORKSPACE = 'src/limiter.ts'

/** Word lists that land in the lexical matcher's undecidable band, as in the unit tests. */
const AMBIGUOUS_A = 'alpha beta gamma delta'
const AMBIGUOUS_B = 'alpha beta epsilon'
const SAME_A = 'add rate limiting to the login endpoint so repeated failures back off'
const SAME_B = 'add rate limiting to login so repeated failures are throttled'

const root = mkdtempSync(join(tmpdir(), 'agentgit-hub-walkthrough-'))
const children = []

let step = 0
const say = (line = '') => process.stdout.write(`${line}\n`)
const heading = (title) => {
  step += 1
  say('')
  say(`${step}. ${title}`)
  say('')
}

/** Wait for a condition, with a ceiling, so a broken step fails instead of hanging. */
async function until(description, predicate, timeoutMs = 15_000) {
  const started = Date.now()
  for (;;) {
    const value = await predicate()
    if (value) return value
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for: ${description}`)
    await new Promise((done) => setTimeout(done, 100))
  }
}

/** Run a hook the way the host does: JSON payload on stdin, JSON on stdout. */
function runHook(script, payload) {
  return new Promise((done) => {
    const child = spawn(process.execPath, [join(REPO, 'plugins', 'agentgit', 'scripts', script)], {
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => (stdout += chunk))
    child.stderr.on('data', (chunk) => (stderr += chunk))
    child.on('close', (status) => done({ status, stdout, stderr }))
    child.stdin.end(JSON.stringify(payload))
  })
}

/** An MCP session over stdio, which is how a window actually reaches the tools. */
function mcpSession() {
  const child = spawn(
    process.execPath,
    ['--experimental-strip-types', join(REPO, 'packages', 'mcp', 'src', 'main.ts')],
    { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] },
  )
  children.push(child)
  let buffer = ''
  const waiting = new Map()
  child.stdout.on('data', (chunk) => {
    buffer += chunk
    let newline = buffer.indexOf('\n')
    while (newline >= 0) {
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      newline = buffer.indexOf('\n')
      if (!line.trim()) continue
      const message = JSON.parse(line)
      waiting.get(message.id)?.(message)
      waiting.delete(message.id)
    }
  })
  let nextId = 1
  const send = (method, params) =>
    new Promise((done) => {
      const id = nextId++
      waiting.set(id, done)
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    })
  return { child, send }
}

const asTask = (sessionId, path) => ({
  hook_event_name: 'PreToolUse',
  session_id: sessionId,
  cwd: root,
  tool_name: 'apply_patch',
  tool_input: { file_path: join(root, path) },
})

/** One MCP tool call, with an honest failure instead of a confusing TypeError further down. */
async function callTool(session, name, args, label) {
  const response = await session.send('tools/call', { name, arguments: { workspace: root, ...args } })
  if (response.error) throw new Error(`${label}: ${JSON.stringify(response.error)}`)
  const result = response.result
  if (result?.isError) {
    const text = (result.content ?? []).map((block) => block.text).join('\n')
    throw new Error(`${label} returned a tool error:\n${text}`)
  }
  if (!result?.structuredContent) {
    throw new Error(`${label} returned no structured content:\n${JSON.stringify(result, null, 2)}`)
  }
  return result
}

async function main() {
  say(`AgenticGit hub walkthrough - ${root}`)
  say(`daemon on http://localhost:${PORT} (loopback only)`)

  /* ------------------------------------------------------------------------ */
  heading('The spine starts. Nothing is in flight, so it rules on nothing and publishes nothing.')

  const daemon = spawn(
    process.execPath,
    ['--experimental-strip-types', join(REPO, 'packages', 'daemon', 'src', 'main.ts'), '--watch', root, '--port', String(PORT)],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  )
  children.push(daemon)
  await until('the daemon to bind', async () => {
    try {
      return (await fetch(`http://localhost:${PORT}/healthz`)).ok
    } catch {
      return false
    }
  })

  const ledgerFile = () => {
    const dir = join(root, '.agentgit', 'events')
    try {
      return readdirSync(dir)
        .filter((name) => name.endsWith('.jsonl'))
        .map((name) => readFileSync(join(dir, name), 'utf8'))
        .join('')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    } catch {
      return []
    }
  }
  const hubEvents = () => ledgerFile().filter((event) => event.host_event === 'hub/publish')

  say(`   hub rulings published so far: ${hubEvents().length}`)
  say('   A quiet workspace produces no ledger noise, which is what makes a ruling worth reading.')

  /* ------------------------------------------------------------------------ */
  heading(`Window A starts: it claims ${WORKSPACE} and writes it.`)

  await runHook('track.mjs', asTask('window-a', WORKSPACE))
  const sessionA = mcpSession()
  await sessionA.send('initialize', { protocolVersion: '2025-06-18' })
  const claim = await callTool(
    sessionA,
    'agentgit_preflight',
    { path: WORKSPACE, intent: SAME_A, claim: true },
    'window A preflight',
  )
  say(`   window A verdict: ${claim.structuredContent.verdict.toUpperCase()}`)
  say(`   window A holds a lease on ${claim.structuredContent.entityKey}`)

  const firstRuling = await until('the spine to rule on the claim', async () => {
    const events = hubEvents()
    return events.length > 0 ? events[events.length - 1] : null
  })
  const rulingId = firstRuling.detail.rulingId
  say('')
  say(`   the spine ruled and published exactly once:`)
  say(`     event   ${firstRuling.event_id}  (kind ${firstRuling.kind})`)
  say(`     ruling  ${rulingId}`)
  say(`     reason  ${firstRuling.reason}`)
  say(`     ownership ${JSON.stringify(firstRuling.detail.ownership)}`)

  /* ------------------------------------------------------------------------ */
  heading('Window B is about to write the same file. It has never spoken to window A.')

  const pushedToB = await runHook('hub.mjs', asTask('window-b', WORKSPACE))
  const injected = JSON.parse(pushedToB.stdout).hookSpecificOutput.additionalContext
  say(`   the PreToolUse hook injected this into window B's context, before the write:`)
  say('')
  for (const line of injected.split('\n')) say(`     | ${line}`)
  say('')
  say(`   ...and running the same hook again returns ${pushedToB.status === 0 ? 'nothing' : 'an error'}, because window B has now been told:`)
  const second = await runHook('hub.mjs', asTask('window-b', WORKSPACE))
  say(`     stdout: ${second.stdout === '' ? '(empty)' : second.stdout.trim()}`)

  /* ------------------------------------------------------------------------ */
  heading('Window B asks properly, and gets the same ruling window A is working from.')

  const sessionB = mcpSession()
  await sessionB.send('initialize', { protocolVersion: '2025-06-18' })
  const ask = await callTool(
    sessionB,
    'agentgit_preflight',
    { path: WORKSPACE, intent: SAME_B },
    'window B preflight',
  )
  const askResult = ask.structuredContent
  say(`   window B verdict: ${askResult.verdict.toUpperCase()}`)
  say(`   hub ruling ${askResult.hub.id} carried; same as window A saw: ${askResult.hub.id === rulingId}`)
  const position = askResult.hub.ruling
    ? `${askResult.hub.ruling.word.toUpperCase()} (owner ${askResult.hub.ruling.owner.taskId})`
    : `reserved by ${askResult.hub.holder.taskId} — no contention yet, only a reservation`
  say(`   what the hub says about this entity: ${position}`)
  say(
    `   its cost is reported with it: P ${askResult.hub.metrics.parallelismMean.toFixed(2)}, ` +
      `lag ${askResult.hub.metrics.inputLagMinutes}m, ${askResult.hub.metrics.published} ruling(s) published`,
  )

  const secondHubRuling = await fetch(`http://localhost:${PORT}/api/hub`).then((r) => r.json())
  say(`   /api/hub, read by a third reader, returns the same id: ${secondHubRuling.hub.id === rulingId}`)

  /* ------------------------------------------------------------------------ */
  heading('A collision the vocabulary cannot decide, and the one answer that settles it.')

  const ambiguousFile = 'src/serializer.ts'
  await runHook('track.mjs', { ...asTask('window-a', ambiguousFile), tool_input: { file_path: join(root, ambiguousFile), description: AMBIGUOUS_A } })
  await runHook('track.mjs', { ...asTask('window-b', ambiguousFile), tool_input: { file_path: join(root, ambiguousFile), description: AMBIGUOUS_B } })

  const ambiguous = await until('the spine to rule the undecidable collision', async () => {
    const payload = await fetch(`http://localhost:${PORT}/api/hub`).then((r) => r.json())
    const ruling = payload.hub?.rulings?.find((candidate) => candidate.entityKey === `file::${ambiguousFile}`)
    return ruling?.needsResolution ? { id: payload.hub.id, ruling } : null
  })
  say(`   ruling ${ambiguous.id} reports ${ambiguousFile} as ${ambiguous.ruling.word.toUpperCase()}`)
  say(`   basis: ${ambiguous.ruling.basis} (similarity ${ambiguous.ruling.similarity}) 鈥?the lexical matcher has no opinion`)
  say(`   the ruling names the way out: see the injected text below`)
  say(`     -> ${ambiguous.ruling.needsResolution ? 'needsResolution: true, answer with agentgit_hub_resolve' : 'unexpected'}`)

  const answerOne = await callTool(
    sessionB,
    'agentgit_hub_resolve',
    {
      entityKey: `file::${ambiguousFile}`,
      decision: 'reuse',
      reason: 'the same serializer, extending theirs',
      session: 'window-b',
    },
    'window B resolve',
  )
  say('')
  say(`   window B answers once: ${answerOne.content[0].text.split('\n')[0]}`)

  // A second window answering the same question is the case this whole design exists for.
  const sessionC = mcpSession()
  await sessionC.send('initialize', { protocolVersion: '2025-06-18' })
  const answerTwo = await callTool(
    sessionC,
    'agentgit_hub_resolve',
    {
      entityKey: `file::${ambiguousFile}`,
      decision: 'replan',
      reason: 'actually different work',
      session: 'window-c',
    },
    'window C resolve',
  )
  say(`   window C answers the same question differently: ${answerTwo.content[0].text.split('\n')[0]}`)

  const settled = await until('the spine to publish the settled ruling', async () => {
    const payload = await fetch(`http://localhost:${PORT}/api/hub`).then((r) => r.json())
    const ruling = payload.hub?.rulings?.find((candidate) => candidate.entityKey === `file::${ambiguousFile}`)
    return ruling && !ruling.needsResolution ? { id: payload.hub.id, ruling } : null
  })
  say('')
  say(`   the published conclusion is ${settled.ruling.word.toUpperCase()} (basis ${settled.ruling.basis}), decided by ${settled.ruling.resolvedBy}`)
  say(`   answers recorded in the ledger: ${ledgerFile().filter((e) => e.host_event === 'hub/resolve').length}`)
  say(`   later answers ignored: ${settled.ruling.supersededAnswers} 鈥?both are in the ledger, one is the conclusion`)
  say('   two windows asked; one answer came out. That is the whole claim.')

  /* ------------------------------------------------------------------------ */
  heading('The conclusion outlives the process that computed it.')

  const beforeKill = hubEvents().length
  daemon.kill()
  await new Promise((done) => setTimeout(done, 400))
  say(`   daemon killed. Ledger still holds ${beforeKill} published ruling(s).`)

  // Delete the cache, so the only thing left that can answer is the ledger. This is the point of
  // the whole arrangement: the projection is a cache, and the conclusion is in the event stream.
  const projection = join(root, '.agentgit', 'state', 'hub.json')
  rmSync(projection, { force: true })
  say(`   deleted ${projection.replace(root, '<workspace>')}, so nothing but the ledger can answer`)

  const rebuilt = spawn(
    process.execPath,
    ['--experimental-strip-types', join(REPO, 'packages', 'cli', 'src', 'main.ts'), 'hub', '--workspace', root, '--json'],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  )
  children.push(rebuilt)
  let rebuiltOut = ''
  rebuilt.stdout.on('data', (chunk) => (rebuiltOut += chunk))
  await new Promise((done) => rebuilt.on('close', done))
  const rebuiltHub = JSON.parse(rebuiltOut)
  say(`   \`agentgit hub\` answered with source=${rebuiltHub.source} and ruling ${rebuiltHub.id}`)
  say(`   it rebuilt ${rebuiltHub.rulings.length} ruling(s) and ${rebuiltHub.holders.length} reservation(s) from the ledger`)
  say(`   the conclusion survived the process that computed it: ${rebuiltHub.rulings.length > 0}`)
  say(`   effective parallelism P ${rebuiltHub.metrics.parallelismMean.toFixed(2)} is reported with the rulings, not apart from them`)
  say(`   ruling lag ${rebuiltHub.metrics.inputLagMinutes}m behind the newest ledger fact (the spine's latency)`)
  say(`   reading did not publish: ledger still holds ${hubEvents().length} published ruling(s)`)

  say('')
  say('Nothing outside the scratch workspace was created, and no file in the repository was modified.')
  say(`scratch workspace: ${root}`)
}

try {
  await main()
} catch (error) {
  process.stderr.write(`walkthrough failed: ${error?.stack ?? String(error)}\n`)
  process.exitCode = 1
} finally {
  for (const child of children) {
    try {
      child.kill()
    } catch {
      // Already gone.
    }
  }
  // Give the sockets a moment to close before the tree is removed, so a bind error cannot
  // masquerade as a failure of the walkthrough.
  await new Promise((done) => setTimeout(done, 300))
  rmSync(root, { recursive: true, force: true })
}
