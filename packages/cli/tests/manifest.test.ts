/**
 * The plugin manifest, read the way the host reads it.
 *
 * Everything here guards a failure that is silent. A manifest is not code: nothing throws when it
 * is wrong, the plugin still loads, and the symptom is either a missing detail in a UI or a feature
 * that never appears. Three of these have already happened once in this repository:
 *
 * - `defaultPrompt` had four entries. The host uses the first three and ignores the rest without
 *   saying so, so the fourth prompt - the only one that mentioned publishing a contract - simply
 *   never existed. The count is asserted rather than trusted.
 * - Every prompt was a question about the user's code, so none of them was an entry point into the
 *   plugin itself. The plugin was installed and had nothing in the composer to click.
 * - `assets/` was an empty directory and `interface` named no icon at all, so the plugin card
 *   rendered with no mark on it. From the outside that is indistinguishable from a plugin that was
 *   never finished.
 *
 * The field list matches the plugin schema this machine's own `plugin-creator` skill documents, so
 * these tests fail if the manifest drifts from the shape the host expects rather than from this
 * package's idea of it.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'

/** The plugin directory, found from this file rather than from the working directory. */
const PLUGIN = join(import.meta.dirname, '..', '..', '..', 'plugins', 'agentgit')

interface Manifest {
  readonly name?: string
  readonly version?: string
  readonly description?: string
  readonly license?: string
  readonly keywords?: string[]
  readonly skills?: string
  readonly interface?: {
    readonly displayName?: string
    readonly shortDescription?: string
    readonly longDescription?: string
    readonly developerName?: string
    readonly category?: string
    readonly capabilities?: string[]
    readonly websiteURL?: string
    readonly defaultPrompt?: string[]
    readonly brandColor?: string
    readonly composerIcon?: string
    readonly logo?: string
    readonly logoDark?: string
    readonly screenshots?: string[]
  }
}

function readManifest(): Manifest {
  const raw = readFileSync(join(PLUGIN, '.codex-plugin', 'plugin.json'), 'utf8')
  // A byte-order mark makes `JSON.parse` reject a file that looks perfectly correct in an editor,
  // and the error names a character that cannot be seen. The install path strips one; this asserts
  // the source never acquires one.
  assert.notEqual(raw.charCodeAt(0), 0xfeff, 'a BOM makes this file unparseable to a strict reader')
  return JSON.parse(raw) as Manifest
}

/** Resolve a manifest path, which is plugin-relative and conventionally begins with `./`. */
function resolveAsset(entry: string): string {
  return join(PLUGIN, entry.replace(/^\.\//, ''))
}

describe('identity', () => {
  test('the manifest name matches the directory the host loads it from', () => {
    // The marketplace entry, the plugin folder and this field all have to agree; a mismatch is
    // reported as "plugin not found" with the name the user typed, which is the matching one.
    const manifest = readManifest()
    assert.equal(manifest.name, basename(PLUGIN))
    assert.match(manifest.name ?? '', /^[a-z0-9]+(-[a-z0-9]+)*$/, 'the name is lower-case and hyphenated')
  })

  test('it declares a version the host can parse, and a licence', () => {
    const manifest = readManifest()
    // `install` appends a `+codex.<stamp>` build suffix, which is valid semver, so only the base is
    // asserted here.
    assert.match(manifest.version ?? '', /^\d+\.\d+\.\d+([-+].*)?$/)
    assert.equal(manifest.license, 'MIT')
  })

  test('it describes itself in the two places a user reads', () => {
    const manifest = readManifest()
    assert.ok((manifest.description ?? '').length > 40, 'the top-level description is what search shows')
    const iface = manifest.interface ?? {}
    for (const key of ['displayName', 'shortDescription', 'longDescription', 'developerName', 'category'] as const) {
      assert.ok((iface[key] ?? '').length > 0, `interface.${key} is required for the plugin card`)
    }
    assert.ok((iface.longDescription ?? '').length > (iface.shortDescription ?? '').length)
  })

  test('the brand colour is a hex literal', () => {
    assert.match(readManifest().interface?.brandColor ?? '', /^#[0-9A-Fa-f]{6}$/)
  })

  test('it points at its skills directory, which exists', () => {
    const manifest = readManifest()
    assert.equal(manifest.skills, './skills/')
    assert.ok(existsSync(resolveAsset(manifest.skills)))
  })
})

describe('the composer prompts, which the host truncates without saying so', () => {
  test('there are at most three, because the rest are ignored', () => {
    const prompts = readManifest().interface?.defaultPrompt ?? []
    assert.ok(prompts.length > 0, 'a plugin with no starter prompt has no entry point in the composer')
    assert.ok(
      prompts.length <= 3,
      `${prompts.length} prompts are declared and the host renders only the first 3, so the rest would be dead text`,
    )
  })

  test('each one is short enough to be rendered whole', () => {
    const prompts = readManifest().interface?.defaultPrompt ?? []
    // 128 is the host's limit; the schema asks for about 50 so the entries scan in a list.
    for (const prompt of prompts) {
      assert.ok(prompt.length <= 128, `${prompt.length} chars is over the host limit: ${prompt}`)
      assert.ok(prompt.length >= 20, `too terse to be a useful starter: ${prompt}`)
      assert.ok(!prompt.endsWith('.'), 'the schema asks for prompts without trailing full stops')
    }
  })

  test('the first one is an entry point into this plugin', () => {
    // The failure this prevents: four prompts that all asked about the user's code, none of which
    // opened the plugin, so the enabled plugin was invisible at the moment a user would look for it.
    //
    // It has to accept both spellings, because they are genuinely different strings: the plugin id
    // is `agentgit` and the display name is `AgenticGit` - "Agentic" plus "Git" - so a prompt naming
    // the product does not contain the id as a substring.
    const first = (readManifest().interface?.defaultPrompt ?? [])[0] ?? ''
    assert.match(first, /agentic\s*git/i, 'the first starter prompt must name the plugin')
  })
})

describe('the artwork, which is how the plugin card is recognised', () => {
  test('the icons the card uses are declared and present', () => {
    const iface = readManifest().interface ?? {}
    for (const key of ['composerIcon', 'logo'] as const) {
      const entry = iface[key]
      assert.ok(entry, `interface.${key} is unset, so the card would render with no mark`)
      assert.ok(
        existsSync(resolveAsset(entry as string)),
        `interface.${key} names ${entry}, which does not exist`,
      )
    }
  })

  test('a dark-mode logo is provided, so the mark survives a dark theme', () => {
    const iface = readManifest().interface ?? {}
    const entry = iface.logoDark
    assert.ok(entry, 'interface.logoDark is unset')
    assert.ok(existsSync(resolveAsset(entry as string)))
  })

  test('every declared asset sits under ./assets/ and is a file that exists', () => {
    const iface = readManifest().interface ?? {}
    const screenshots = iface.screenshots ?? []
    for (const entry of [iface.composerIcon, iface.logo, iface.logoDark, ...screenshots]) {
      if (!entry) continue
      assert.ok(entry.startsWith('./assets/'), `${entry} must live under ./assets/`)
      assert.ok(existsSync(resolveAsset(entry)), `${entry} does not exist`)
    }
    // Screenshots must be PNG, per the schema, which is why none is declared yet: an SVG named here
    // would fail a review rather than fail a render, and that is the harder kind to notice.
    for (const shot of screenshots) assert.match(shot, /\.png$/)
  })
})

describe('the capability list', () => {
  test('is a non-empty list of short labels', () => {
    const capabilities = readManifest().interface?.capabilities ?? []
    assert.ok(capabilities.length > 0)
    for (const capability of capabilities) {
      assert.ok(capability.length > 0 && capability.length <= 40, `unusable label: ${capability}`)
    }
  })

  test('does not call a task a conversation, which is the one word the host reserves', () => {
    // The host's own guidance is explicit: tool names say thread, the UI says task, and a plugin
    // that says "conversation" in user-facing copy is using a third word for the same object.
    const iface = readManifest().interface ?? {}
    const text = [iface.shortDescription, iface.longDescription, ...(iface.capabilities ?? [])].join(' ')
    assert.equal(/conversation/i.test(text), false, `user-facing copy says "conversation": ${text}`)
  })
})
