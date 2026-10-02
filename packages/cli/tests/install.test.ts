/**
 * The install path, which is the part of this product a user cannot debug.
 *
 * Every regression here has already happened once. A BOM made `hooks.json` unparseable;
 * a raw Windows path substituted into a JSON string turned `\U` into an invalid escape;
 * a sliced ISO timestamp left a trailing dot in a semver; a version bump appended
 * instead of replacing and pushed the cachebuster further from the base. None of those
 * produced an error message pointing at the cause — the plugin simply recorded nothing.
 *
 * `copy: true` is used throughout rather than a junction, so no test can ever be one
 * recursive delete away from the checkout it is running from.
 */

import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, isAbsolute, resolve } from 'node:path'

import {
  bumpCachebuster,
  install,
  installPaths,
  manifestVersion,
  runDoctor,
  setPluginEnabled,
  uninstall,
  writeGeneratedFiles,
  writePluginEnabled,
} from '../src/install.ts'

let home: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'agentgit-install-'))
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

/** Install into the temporary home, with a copy so nothing links back to the checkout. */
function installHere(stamp = 'local-20260101000000') {
  return install({ home, copy: true, stamp })
}

const EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop'] as const

describe('generated hooks.json', () => {
  test('also writes the host-discovered hooks/hooks.json with identical handlers', () => {
    const report = installHere()
    const discovered = JSON.parse(readFileSync(join(report.paths.target, 'hooks', 'hooks.json'), 'utf8'))
    const legacy = JSON.parse(readFileSync(report.files.hooks, 'utf8'))
    assert.deepEqual(discovered.hooks, legacy.hooks)
    assert.deepEqual(Object.keys(discovered).sort(), ['description', 'hooks'])
  })
  test('names an absolute node and absolute scripts, and every one of them exists', () => {
    const report = installHere()
    const hooks = JSON.parse(readFileSync(report.files.hooks, 'utf8')) as {
      hooks: Record<string, { matcher?: string; hooks: { type: string; command: string }[] }[]>
    }

    for (const event of EVENTS) {
      const entry = hooks.hooks[event]
      assert.ok(entry && entry.length >= 1, `${event} must be wired, or the ledger never sees it`)
      // Recording is always the first handler. If the hub ever ran first, a slow read here
      // would delay the one piece of the plugin that has to happen on every tool call.
      assert.equal(entry[0].hooks[0].type, 'command')
      assert.ok(
        /track\.mjs"/.test(entry[0].hooks[0].command),
        `${event}'s first handler must be the recorder`,
      )
    }

    // Every script path in the whole file, not just the first one: there are two handlers now,
    // and a path that does not exist fails silently at runtime rather than loudly at install.
    for (const groups of Object.values(hooks.hooks)) {
      for (const group of groups) {
        for (const handler of group.hooks) {
          const found = [...handler.command.matchAll(/"([^"]+)"/g)].map((match) => match[1])
          assert.equal(found.length, 2, `expected a node and a script in ${handler.command}`)
          for (const path of found) {
            assert.ok(isAbsolute(path), `${path} must be absolute`)
            assert.ok(existsSync(path), `${path} must exist, or the hook fails silently at runtime`)
          }
          assert.ok(found[1].endsWith('.mjs'))
        }
      }
    }
  })

  test('wires the hub at safe boundaries, with pre-tool delivery limited to file edits', () => {
    const report = installHere()
    const hooks = JSON.parse(readFileSync(report.files.hooks, 'utf8')) as {
      hooks: Record<string, { matcher?: string; hooks: { command: string }[] }[]>
    }

    const hubEvents = Object.entries(hooks.hooks)
      .filter(([, groups]) => groups.some((group) => group.hooks.some((h) => /hub\.mjs"/.test(h.command))))
      .map(([event]) => event)
      .sort()
    assert.deepEqual(hubEvents, ['PostToolUse', 'PreToolUse', 'SessionStart', 'UserPromptSubmit'])

    // The write-time nudge is narrowed to file edits. A ruling is only worth interrupting a
    // write with when the write is about the ground it rules on.
    const editGroup = hooks.hooks.PreToolUse.find((group) =>
      group.hooks.some((handler) => /hub\.mjs"/.test(handler.command)),
    )
    assert.equal(editGroup?.matcher, 'apply_patch|Edit|Write')

    // And the recorder still sees everything, so narrowing the hub cannot narrow the ledger.
    assert.equal(hooks.hooks.PreToolUse[0].matcher, '.*')
  })

  test('wires the spine and the offer where a session can act on them, and never before an edit', () => {
    const report = installHere()
    const hooks = JSON.parse(readFileSync(report.files.hooks, 'utf8')) as {
      hooks: Record<string, { matcher?: string; hooks: { command: string }[] }[]>
    }

    // A daemon is started, and a question is asked, when a session begins or a prompt arrives.
    // Putting either on PreToolUse would put process spawning and a user-facing question between an
    // agent and its next edit, which is the one place the plugin has promised to be cheap and quiet.
    const spineEvents = Object.entries(hooks.hooks)
      .filter(([, groups]) => groups.some((group) => group.hooks.some((h) => /spine\.mjs"/.test(h.command))))
      .map(([event]) => event)
      .sort()
    assert.deepEqual(spineEvents, ['SessionStart', 'UserPromptSubmit'])

    const desktopEvents = Object.entries(hooks.hooks)
      .filter(([, groups]) => groups.some((group) => group.hooks.some((h) => /desktop\.mjs"/.test(h.command))))
      .map(([event]) => event)
      .sort()
    assert.deepEqual(desktopEvents, ['SessionStart', 'UserPromptSubmit'])

    // Record first, then make sure there is something to rule, then read the ruling, and only then
    // consider asking the user a question. The order is load-bearing: a hub read before the recorder
    // would describe a workspace one line out of date, and the offer must never delay the three
    // above it - it can inject context, but it changes no coordination state.
    for (const event of ['SessionStart', 'UserPromptSubmit'] as const) {
      const commands = hooks.hooks[event].flatMap((group) => group.hooks.map((handler) => handler.command))
      const scripts = commands.map((command) => /([^"\\/]+\.mjs)"/.exec(command)?.[1] ?? '')
      assert.deepEqual(
        scripts,
        ['track.mjs', 'spine.mjs', 'hub.mjs', 'desktop.mjs'],
        `${event} has the wrong handler order`,
      )
    }
  })

  test('gives every event a command, so no lifecycle moment is unrecorded', () => {
    const report = installHere()
    const hooks = JSON.parse(readFileSync(report.files.hooks, 'utf8')) as {
      hooks: Record<string, { hooks: { command: string }[] }[]>
    }

    const commands = new Set(EVENTS.map((event) => hooks.hooks[event][0].hooks[0].command))
    assert.equal(commands.size, 1, 'one script answers every event; it branches on the event name internally')
    assert.ok(!readFileSync(report.files.hooks, 'utf8').includes('{{'), 'no placeholder may survive an install')
  })

  test('is parseable with no byte-order mark, which is what broke the first install', () => {
    const report = installHere()
    const raw = readFileSync(report.files.hooks, 'utf8')
    assert.notEqual(raw.charCodeAt(0), 0xfeff, 'a BOM makes JSON.parse reject the whole file')
    assert.doesNotThrow(() => JSON.parse(raw))
    assert.ok(!raw.includes('\r\n'), 'line endings are normalised, so a diff shows only what changed')
  })
})

describe('generated .mcp.json', () => {
  test('splices the node flags into the args array as separate strings', () => {
    const report = installHere()
    const raw = readFileSync(report.files.mcp, 'utf8')
    const parsed = JSON.parse(raw) as { mcpServers: Record<string, { command: string; args: string[] }> }
    const server = parsed.mcpServers.agentgit

    assert.ok(isAbsolute(server.command) && existsSync(server.command))
    for (const arg of server.args) {
      assert.ok(!arg.startsWith('[') && !arg.includes('","'), `${arg} looks like a quoted array, not an argument`)
    }
    assert.deepEqual(server.args.slice(0, report.files.flags.length), [...report.files.flags])
    const entry = server.args[report.files.flags.length]
    assert.ok(isAbsolute(entry) && existsSync(entry), `expected the server entry point, got ${entry}`)
  })

  test('pins no working directory, so the server answers about the session it was opened in', () => {
    const report = installHere()
    const parsed = JSON.parse(readFileSync(report.files.mcp, 'utf8')) as {
      mcpServers: Record<string, { cwd?: string }>
    }
    assert.equal(parsed.mcpServers.agentgit.cwd, undefined)
  })

  test('survives a Windows path, which is where the invalid-escape bug lived', () => {
    // The substituted value used to be inserted raw into a quoted string, turning
    // `C:\Users\...` into the escape `\U` and making the file unreadable.
    const report = installHere()
    const homeDir = installPaths({ home })
    writeFileSync(join(report.paths.target, 'mcp.json.template'), '{"x":"{{REPO}}"}', 'utf8')
    writeFileSync(join(report.paths.target, 'hooks.json.template'), '{"x":"{{NODE}}","t":"{{TRACK}}"}', 'utf8')

    const generated = writeGeneratedFiles({ ...homeDir, repo: homeDir.repo, target: report.paths.target }, report.paths.target)
    const mcp = JSON.parse(readFileSync(generated.mcp, 'utf8')) as { x: string }
    assert.equal(mcp.x, homeDir.repo.replace(/\\/g, '\\'), 'the backslashes survive the round trip')

    const hooks = JSON.parse(readFileSync(join(report.paths.target, 'hooks.json'), 'utf8')) as { x: string; t: string }
    assert.equal(hooks.x, generated.node)
    assert.ok(hooks.t.endsWith('track.mjs'))
  })

  test('re-run install regenerates every file rather than trusting what is there', () => {
    const first = installHere()
    writeFileSync(first.files.hooks, '{"hooks":{}}', 'utf8')
    writeFileSync(first.files.spine, '{"daemon":"/gone"}', 'utf8')
    const second = installHere('local-20260101000001')

    const hooks = JSON.parse(readFileSync(second.files.hooks, 'utf8')) as { hooks: Record<string, unknown> }
    assert.ok(hooks.hooks.SessionStart, 'the second install must overwrite a damaged file')
    const spine = JSON.parse(readFileSync(second.files.spine, 'utf8')) as { daemon: string }
    assert.notEqual(spine.daemon, '/gone', 'and the same goes for the spine config')
  })
})

describe('generated spine.json', () => {
  test('names an absolute daemon that exists, and leaves no placeholder behind', () => {
    const report = installHere()
    const raw = readFileSync(report.files.spine, 'utf8')
    assert.ok(!raw.includes('{{'), 'no placeholder may survive an install')

    const parsed = JSON.parse(raw) as { node: string; daemon: string; flags: string[] }
    assert.ok(isAbsolute(parsed.node) && existsSync(parsed.node))
    assert.ok(isAbsolute(parsed.daemon), `expected an absolute daemon entry, got ${parsed.daemon}`)
    assert.ok(existsSync(parsed.daemon), `${parsed.daemon} must exist, or the spine starts nothing`)
    assert.ok(parsed.daemon.endsWith(join('packages', 'daemon', 'src', 'main.ts')))
    // The daemon entry is TypeScript too, so it needs exactly the flags the MCP server needs.
    assert.deepEqual(parsed.flags, [...report.files.flags])
  })

  test('splices the flags into the array as separate strings, not as one quoted literal', () => {
    const report = installHere()
    const parsed = JSON.parse(readFileSync(report.files.spine, 'utf8')) as { flags: unknown }
    assert.ok(Array.isArray(parsed.flags), 'flags must be a JSON array, not a string')
    for (const flag of parsed.flags as unknown[]) {
      assert.equal(typeof flag, 'string')
      assert.ok(!String(flag).startsWith('['), `${String(flag)} looks like a quoted array`)
    }
  })

  test('keeps the daemon path out of hooks.json, where a handler must name one script', () => {
    // This file exists for exactly this reason: the handler assertion above requires "node plus
    // one script", so the daemon cannot be a third argument on the hook's command line.
    const report = installHere()
    const daemon = (JSON.parse(readFileSync(report.files.spine, 'utf8')) as { daemon: string }).daemon
    assert.ok(!readFileSync(report.files.hooks, 'utf8').includes(daemon))
  })
})

describe('marketplace entry', () => {
  test('creates the personal marketplace when there is none', () => {
    const report = installHere()
    const payload = JSON.parse(readFileSync(report.marketplace.file, 'utf8')) as {
      name: string
      plugins: { name: string; source: { path: string } }[]
    }
    assert.equal(payload.name, 'personal')
    assert.equal(payload.plugins[0].source.path, './plugins/agentgit')
    assert.equal(report.marketplace.created, true)
  })

  test('preserves other plugins and the marketplace name the user already had', () => {
    const paths = installPaths({ home })
    mkdirSync(join(home, '.agents', 'plugins'), { recursive: true })
    writeFileSync(
      paths.marketplace,
      JSON.stringify({
        name: 'work',
        interface: { displayName: 'Work' },
        plugins: [{ name: 'other', source: { source: 'local', path: './plugins/other' }, policy: {}, category: 'x' }],
      }),
      'utf8',
    )

    const report = installHere()
    const payload = JSON.parse(readFileSync(paths.marketplace, 'utf8')) as {
      name: string
      plugins: { name: string }[]
    }

    assert.equal(payload.name, 'work', 'renaming would orphan any config.toml reference to it')
    assert.deepEqual(payload.plugins.map((entry) => entry.name).sort(), ['agentgit', 'other'])
    assert.equal(report.enableLine.includes('agentgit@work'), true, 'the enable line must name the real marketplace')
  })

  test('is idempotent, so re-installing does not stack entries', () => {
    installHere()
    installHere('local-20260101000002')
    const payload = JSON.parse(readFileSync(installPaths({ home }).marketplace, 'utf8')) as { plugins: { name: string }[] }
    assert.equal(payload.plugins.filter((entry) => entry.name === 'agentgit').length, 1)
  })

  test('refuses to write into a marketplace file it cannot understand', () => {
    const paths = installPaths({ home })
    mkdirSync(join(home, '.agents', 'plugins'), { recursive: true })
    writeFileSync(paths.marketplace, '{"plugins":[]}', 'utf8')
    assert.throws(() => installHere(), /no marketplace name/)
  })
})

describe('cachebuster', () => {
  test('replaces the suffix instead of appending one', () => {
    const report = installHere('local-20260101000000')
    assert.equal(report.version.to, '0.1.0+codex.local-20260101000000')

    const again = bumpCachebuster(report.paths.target, 'local-20260101000001')
    assert.equal(again.from, '0.1.0+codex.local-20260101000000')
    assert.equal(again.to, '0.1.0+codex.local-20260101000001')
    assert.equal(manifestVersion(report.paths.target), '0.1.0+codex.local-20260101000001')
  })

  test('produces a version string a semver parser accepts', () => {
    const report = installHere()
    // The first implementation sliced an ISO instant at a fixed width and left a
    // trailing dot behind, which is not valid semver and reads as a typo.
    assert.match(report.version.to, /^\d+\.\d+\.\d+\+codex\.[A-Za-z0-9.-]+$/)
    assert.ok(!report.version.to.includes('..'))
    assert.ok(!report.version.to.endsWith('.'))
    assert.ok(!report.version.to.endsWith('+'))
  })

  test('keeps a version the author set, and only replaces the cachebuster part', () => {
    const report = installHere()
    const manifestPath = join(report.paths.target, '.codex-plugin', 'plugin.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>
    manifest.version = '2.3.4'
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8')

    const bumped = bumpCachebuster(report.paths.target, 'local-20260101000003')
    assert.equal(bumped.to, '2.3.4+codex.local-20260101000003')
  })
})

describe('config.toml editing', () => {
  const QUALIFIED = 'agentgit@personal'

  test('appends the section when the file has none', () => {
    const result = setPluginEnabled('model = "gpt-5"\n', QUALIFIED, true)
    assert.equal(result.changed, true)
    assert.equal(result.found, false)
    assert.match(result.text, /\[plugins\."agentgit@personal"\]\nenabled = true/)
    assert.ok(result.text.startsWith('model = "gpt-5"'), 'existing content stays where it was')
  })

  test('starts a new file without a leading blank line', () => {
    const result = setPluginEnabled('', QUALIFIED, true)
    assert.equal(result.text, '[plugins."agentgit@personal"]\nenabled = true\n')
  })

  test('flips an existing switch in place, without touching the rest of the file', () => {
    const before = [
      '# my settings',
      'model = "gpt-5"            # keep this comment',
      '',
      '[plugins."agentgit@personal"]',
      'enabled = true',
      '',
      '[plugins."other@personal"]',
      'enabled = true',
      '',
    ].join('\n')

    const off = setPluginEnabled(before, QUALIFIED, false)
    assert.equal(off.changed, true)
    assert.equal(off.found, true)
    assert.match(off.text, /\[plugins\."agentgit@personal"\]\nenabled = false/)
    assert.equal(
      off.text.match(/enabled = true/g)?.length,
      1,
      'the other plugin must not be switched off as collateral',
    )
    assert.ok(off.text.includes('# my settings') && off.text.includes('# keep this comment'))

    // Nothing to do the second time is reported as no change, so an install can be
    // re-run without rewriting the user's file on every run.
    assert.equal(setPluginEnabled(off.text, QUALIFIED, false).changed, false)
  })

  test('adds the switch to a section that exists without one', () => {
    const result = setPluginEnabled('[plugins."agentgit@personal"]\n', QUALIFIED, true)
    assert.equal(result.found, true)
    assert.equal(result.text, '[plugins."agentgit@personal"]\nenabled = true\n')
  })

  test('does not mistake another plugin section for this one', () => {
    const before = '[plugins."agentgit@work"]\nenabled = true\n'
    const result = setPluginEnabled(before, QUALIFIED, true)
    assert.equal(result.found, false)
    assert.equal(result.text.match(/enabled = true/g)?.length, 2, 'a section is added, not reused')
    assert.ok(result.text.startsWith(before.trimEnd()))
  })

  test('refuses an inline plugins table rather than writing TOML that will not parse', () => {
    assert.throws(
      () => setPluginEnabled('plugins = { "agentgit@personal" = { enabled = true } }\n', QUALIFIED, false),
      /inline table/,
    )
  })

  test('writes to the home it was given, and reports whether it changed anything', () => {
    const first = writePluginEnabled({ home, enabled: true })
    assert.equal(first.file, join(home, '.codex', 'config.toml'))
    assert.equal(first.changed, true)
    assert.match(readFileSync(first.file, 'utf8'), /enabled = true/)

    const second = writePluginEnabled({ home, enabled: true })
    assert.equal(second.changed, false)
    assert.equal(second.detail.includes('already set'), true)
  })
})

describe('uninstall', () => {
  test('removes the generated files and the marketplace entry, and leaves the checkout alone', () => {
    const report = installHere()
    assert.ok(existsSync(report.files.hooks))

    const removed = uninstall({ home })
    assert.ok(!existsSync(join(report.paths.target, 'hooks.json')))
    assert.ok(!existsSync(join(report.paths.target, '.mcp.json')))
    assert.ok(!existsSync(report.files.spine), 'the spine config is generated state and goes with the others')
    assert.ok(existsSync(join(report.paths.target, 'scripts', 'track.mjs')), 'the source files are not generated state')
    assert.ok(existsSync(join(report.paths.target, '.codex-plugin', 'plugin.json')))

    const payload = JSON.parse(readFileSync(installPaths({ home }).marketplace, 'utf8')) as { plugins: unknown[] }
    assert.deepEqual(payload.plugins, [])
    assert.ok(removed.removed.some((entry) => entry.includes('marketplace')))
  })

  test('declines to remove a real directory, and says so instead of pretending', () => {
    // `uninstall` must never recursive-delete something it did not create: an
    // unstubbed `~/plugins/agentgit` here could be a checkout of the repository.
    const target = join(home, 'plugins', 'agentgit')
    mkdirSync(target, { recursive: true })
    writeFileSync(join(target, 'notes.txt'), 'mine', 'utf8')

    const report = uninstall({ home })
    assert.ok(existsSync(join(target, 'notes.txt')))
    assert.ok(report.kept.some((entry) => entry.includes('real directory')))
  })

  test('unlinks a junction without following it into the target', () => {
    // The link is built by hand against a throwaway source directory rather than by
    // calling `install`, because a real install here would point at this checkout and
    // then mutate it — writing generated files and bumping the version in the manifest.
    const source = mkdtempSync(join(tmpdir(), 'agentgit-fake-source-'))
    try {
      writeFileSync(join(source, 'plugin.json'), '{"name":"agentgit"}', 'utf8')
      mkdirSync(join(home, 'plugins'), { recursive: true })
      symlinkSync(source, join(home, 'plugins', 'agentgit'), process.platform === 'win32' ? 'junction' : 'dir')

      const report = uninstall({ home })
      assert.ok(!existsSync(join(home, 'plugins', 'agentgit')), 'the link itself goes')
      assert.ok(existsSync(join(source, 'plugin.json')), 'and the linked directory is untouched')
      assert.ok(report.removed.includes(join(home, 'plugins', 'agentgit')))
    } finally {
      rmSync(source, { recursive: true, force: true })
    }
  })

  test('leaves the checkout untouched: no test may write into the repository it runs from', () => {
    const paths = installPaths({ home })
    const watch = [
      join(paths.source, '.codex-plugin', 'plugin.json'),
      join(paths.source, 'hooks.json'),
      join(paths.source, '.mcp.json'),
    ]
    const before = watch.map((file) => (existsSync(file) ? readFileSync(file, 'utf8') : null))

    installHere()
    uninstall({ home })

    for (const [index, file] of watch.entries()) {
      const after = existsSync(file) ? readFileSync(file, 'utf8') : null
      assert.equal(after, before[index], `${file} was modified by a test that installed into a temporary home`)
    }
  })
})

describe('doctor', () => {
  test('passes every check on a healthy install', () => {
    installHere()
    const report = runDoctor({ home })
    const failed = report.checks.filter((check) => !check.ok)
    assert.deepEqual(
      failed.map((check) => `${check.name}: ${check.detail}`),
      [],
      'doctor is the one command a user runs when nothing works, so a false alarm is expensive',
    )
  })

  test('catches a damaged hooks.json and names the file', () => {
    const report = installHere()
    writeFileSync(report.files.hooks, '{ this is not json', 'utf8')
    const check = runDoctor({ home }).checks.find((entry) => entry.name === 'hooks.json')
    assert.equal(check?.ok, false)
    assert.match(check?.detail ?? '', /not valid JSON/)
  })

  test('catches a hooks.json whose command points at a script that is gone', () => {
    const report = installHere()
    const hooks = JSON.parse(readFileSync(report.files.hooks, 'utf8')) as {
      hooks: Record<string, { hooks: { command: string }[] }[]>
    }
    hooks.hooks.PreToolUse[0].hooks[0].command = `"${process.execPath}" "C:/definitely/not/here/track.mjs"`
    writeFileSync(report.files.hooks, JSON.stringify(hooks, null, 2), 'utf8')

    const check = runDoctor({ home }).checks.find((entry) => entry.name === 'hook path resolves')
    assert.equal(check?.ok, false, 'the hook would fire and fail, and nothing would say why')
  })

  test('catches a missing hub script, which would look like a workspace with nothing to say', () => {
    const report = installHere()
    const hooks = JSON.parse(readFileSync(report.files.hooks, 'utf8')) as {
      hooks: Record<string, { matcher?: string; hooks: { command: string }[] }[]>
    }
    const group = hooks.hooks.PreToolUse.find((candidate) =>
      candidate.hooks.some((handler) => /hub\.mjs"/.test(handler.command)),
    )!
    group.hooks[0].command = `"${process.execPath}" "C:/definitely/not/here/hub.mjs"`
    writeFileSync(report.files.hooks, JSON.stringify(hooks, null, 2), 'utf8')

    const check = runDoctor({ home }).checks.find((entry) => entry.name === 'hub hook path resolves')
    assert.equal(check?.ok, false, 'the hub could rule and never reach a session, with nothing to say why')
  })

  test('still passes the recorder check when only the hub path is broken, and the reverse', () => {
    // The two checks must be independent, or a broken recorder would be reported as a broken
    // hub and send the user looking in the wrong place.
    const report = installHere()
    const hooks = JSON.parse(readFileSync(report.files.hooks, 'utf8')) as {
      hooks: Record<string, { matcher?: string; hooks: { command: string }[] }[]>
    }
    const group = hooks.hooks.PreToolUse.find((candidate) =>
      candidate.hooks.some((handler) => /hub\.mjs"/.test(handler.command)),
    )!
    group.hooks[0].command = `"${process.execPath}" "C:/definitely/not/here/hub.mjs"`
    writeFileSync(report.files.hooks, JSON.stringify(hooks, null, 2), 'utf8')

    const checks = runDoctor({ home }).checks
    assert.equal(checks.find((entry) => entry.name === 'hook path resolves')?.ok, true)
    assert.equal(checks.find((entry) => entry.name === 'hub hook path resolves')?.ok, false)
  })

  test('catches a missing spine script, which would leave the push channel permanently empty', () => {
    const report = installHere()
    const hooks = JSON.parse(readFileSync(report.files.hooks, 'utf8')) as {
      hooks: Record<string, { hooks: { command: string }[] }[]>
    }
    const group = hooks.hooks.SessionStart.find((candidate) =>
      candidate.hooks.some((handler) => /spine\.mjs"/.test(handler.command)),
    )!
    group.hooks[0].command = `"${process.execPath}" "C:/definitely/not/here/spine.mjs"`
    writeFileSync(report.files.hooks, JSON.stringify(hooks, null, 2), 'utf8')

    const check = runDoctor({ home }).checks.find((entry) => entry.name === 'spine hook path resolves')
    assert.equal(check?.ok, false, 'no daemon would start, and the hub would have nothing to publish')
  })

  test('catches a spine.json pointing at a daemon that is gone, which a session cannot warn about', () => {
    // The hook cannot report this itself: it runs on the session-start path and must stay silent,
    // so a moved daemon looks exactly like a workspace with nothing to coordinate. The check has
    // to live here, in the command a user runs once they notice the silence.
    const report = installHere()
    const spine = JSON.parse(readFileSync(report.files.spine, 'utf8')) as { daemon: string }
    spine.daemon = 'C:/definitely/not/here/packages/daemon/src/main.ts'
    writeFileSync(report.files.spine, JSON.stringify(spine, null, 2), 'utf8')

    const check = runDoctor({ home }).checks.find((entry) => entry.name === 'spine daemon target')
    assert.equal(check?.ok, false)
    assert.match(check?.detail ?? '', /does not exist/)
  })

  test('catches a missing spine.json, which is a plugin that cannot start its own daemon', () => {
    const report = installHere()
    rmSync(report.files.spine, { force: true })
    const check = runDoctor({ home }).checks.find((entry) => entry.name === 'spine daemon target')
    assert.equal(check?.ok, false)
    assert.match(check?.detail ?? '', /missing/)
  })

  test('catches a missing desktop script, which would leave the offer permanently unspoken', () => {
    const report = installHere()
    const hooks = JSON.parse(readFileSync(report.files.hooks, 'utf8')) as {
      hooks: Record<string, { hooks: { command: string }[] }[]>
    }
    const group = hooks.hooks.SessionStart.find((candidate) =>
      candidate.hooks.some((handler) => /desktop\.mjs"/.test(handler.command)),
    )!
    group.hooks[0].command = `"${process.execPath}" "C:/definitely/not/here/desktop.mjs"`
    writeFileSync(report.files.hooks, JSON.stringify(hooks, null, 2), 'utf8')

    const check = runDoctor({ home }).checks.find((entry) => entry.name === 'desktop hook path resolves')
    assert.equal(check?.ok, false, 'the workspace would never be offered its task, and nothing would say why')
  })

  test('catches a manifest whose icons are missing, which is how the plugin lost its face', () => {
    // AgenticGit shipped once with an empty `assets/` and no icon keys at all. Nothing reported it:
    // the card simply rendered with no mark, which is indistinguishable from a plugin that never had
    // one. `doctor` is the only place that can notice.
    const report = installHere()
    const manifestPath = join(report.paths.target, '.codex-plugin', 'plugin.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { interface: Record<string, unknown> }

    manifest.interface.composerIcon = './assets/not-there.svg'
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8')
    const broken = runDoctor({ home }).checks.find((entry) => entry.name === 'plugin assets')
    assert.equal(broken?.ok, false)
    assert.match(broken?.detail ?? '', /composerIcon/)

    // And absent entirely, rather than pointing somewhere wrong.
    delete manifest.interface.composerIcon
    delete manifest.interface.logo
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8')
    const absent = runDoctor({ home }).checks.find((entry) => entry.name === 'plugin assets')
    assert.equal(absent?.ok, false)
    assert.match(absent?.detail ?? '', /no composerIcon/)
  })

  test('reports a missing install rather than throwing', () => {
    const report = runDoctor({ home })
    assert.equal(report.version, '(unreadable)')
    assert.equal(report.checks.find((entry) => entry.name === 'plugin installed')?.ok, false)
  })
})

describe('the resolved plugin source', () => {
  test('is found from this file, not from the current directory', () => {
    // `install` is run from wherever the user happens to be standing, so the source cannot
    // come from `process.cwd()`: run from an unrelated directory it would resolve to a
    // `plugins/agentgit` that does not exist, and install an empty plugin.
    //
    // The assertion here used to be `resolve(process.cwd(), 'plugins', 'agentgit')`, which
    // is precisely the cwd-derived path this test claims to rule out. It passed for as long
    // as the suite was only ever launched from the repository root, where the two answers
    // coincide, and failed the first time `npm test` ran it from `packages/cli` — the guess
    // and the fact were only ever distinguished by luck.
    const expected = join(resolve(import.meta.dirname, '..', '..', '..'), 'plugins', 'agentgit')

    const before = process.cwd()
    const elsewhere = mkdtempSync(join(tmpdir(), 'agentgit-cwd-'))
    try {
      process.chdir(elsewhere)
      assert.equal(resolve(installPaths({ home }).source), expected, 'the source must not follow the cwd')
    } finally {
      // Restored synchronously, so no other test in this file can observe the change.
      process.chdir(before)
      rmSync(elsewhere, { recursive: true, force: true })
    }

    assert.equal(resolve(installPaths({ home }).source), expected)
    assert.ok(existsSync(join(expected, '.codex-plugin', 'plugin.json')))
  })
})
