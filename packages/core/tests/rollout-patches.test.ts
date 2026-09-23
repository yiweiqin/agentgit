/**
 * The patch reader, tested against the shapes a real rollout writes.
 *
 * This module is the evidence source for the real-data study, so the failure that matters
 * most is the quiet one: a parser that returns fewer ops than the transcript contains would
 * shrink the study's denominator without any error, and every rate computed from it would
 * be wrong in the flattering direction. So the tests aim at silent under-parsing as much as
 * at correctness, and the applier is tested for *refusing* as hard as for applying.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import {
  applyFileOps,
  parsePatchBody,
  parsePatchRecords,
  reverseFileOps,
  reverseOp,
  signatureOf,
  unescapeStringLiteral,
} from '../src/rollout-patches.ts'

const UPDATE_BODY = [
  '*** Begin Patch',
  '*** Update File: src/login.py',
  '@@',
  ' def login(user, password):',
  '-    return authenticate(user, password)',
  '+    return authenticate(user, password, max_attempts=5)',
  ' ',
  ' def logout(user):',
  '     return True',
  '*** End Patch',
].join('\n')

describe('parsing a patch body', () => {
  test('splits a body into one op per file', () => {
    const ops = parsePatchBody(UPDATE_BODY)
    assert.equal(ops.length, 1)
    assert.equal(ops[0].kind, 'update')
    assert.equal(ops[0].path, 'src/login.py')
    assert.equal(ops[0].addedLines, 1)
    assert.equal(ops[0].removedLines, 1)
  })

  test('keeps each hunk side in file order, not grouped by kind', () => {
    // The regression this pins: collecting all context and then all removed lines makes
    // the quoted region appear in the wrong order, and every subsequent locate fails.
    const ops = parsePatchBody(UPDATE_BODY)
    const hunk = ops[0].hunks[0]
    assert.deepEqual(hunk.old, [
      'def login(user, password):',
      '    return authenticate(user, password)',
      '',
      'def logout(user):',
      '    return True',
    ])
    assert.deepEqual(hunk.next, [
      'def login(user, password):',
      '    return authenticate(user, password, max_attempts=5)',
      '',
      'def logout(user):',
      '    return True',
    ])
  })

  test('reads an Add File whose lines never carry a hunk marker', () => {
    const ops = parsePatchBody('*** Begin Patch\n*** Add File: src/new.py\n+print(1)\n+print(2)\n*** End Patch')
    assert.equal(ops.length, 1)
    assert.equal(ops[0].kind, 'add')
    assert.equal(ops[0].addedLines, 2)
    assert.deepEqual(ops[0].hunks[0].next, ['print(1)', 'print(2)'])
  })

  test('records both sides of a signature change, which is the hidden-dependency evidence', () => {
    // The signature itself has to be a changed line. A patch that only changes the body of
    // a function changes nothing another session could have coded against, and reporting it
    // as a signature change would manufacture a hidden dependency that is not there.
    const moved = parsePatchBody([
      '*** Begin Patch',
      '*** Update File: src/login.py',
      '@@',
      '-def login(user, password):',
      '+def login(user, password, max_attempts=5):',
      '     return authenticate(user, password)',
      '*** End Patch',
    ].join('\n'))
    assert.deepEqual(moved[0].removedSignatures, ['def login'])
    assert.deepEqual(moved[0].addedSignatures, ['def login'])
  })

  test('does not call an unchanged signature a signature change', () => {
    // UPDATE_BODY edits only a function body, so its `def login` line is context on both
    // sides and must not appear as a change.
    const ops = parsePatchBody(UPDATE_BODY)
    assert.deepEqual(ops[0].removedSignatures, [])
    assert.deepEqual(ops[0].addedSignatures, [])
  })

  test('returns nothing for text that is not a patch, so a non-patch call is not invented', () => {
    assert.deepEqual(parsePatchBody('just some prose\nwith + looking lines'), [])
  })

  test('tolerates CRLF, which a Windows checkout writes into the body', () => {
    const ops = parsePatchBody(UPDATE_BODY.replace(/\n/g, '\r\n'))
    assert.equal(ops[0].addedLines, 1)
    assert.equal(ops[0].hunks[0].old[1], '    return authenticate(user, password)')
  })
})

describe('reading patches out of a rollout', () => {
  const rollout = [
    JSON.stringify({ type: 'session_meta', payload: { session_id: 'sess-1' } }),
    JSON.stringify({
      timestamp: '2026-07-14T10:00:00.000Z',
      type: 'response_item',
      payload: { type: 'custom_tool_call', call_id: 'c1', name: 'apply_patch', input: UPDATE_BODY },
    }),
    JSON.stringify({
      timestamp: '2026-07-14T10:05:00.000Z',
      type: 'response_item',
      payload: { type: 'custom_tool_call', call_id: 'c2', name: 'apply_patch', input: 'not a patch' },
    }),
  ].join('\n')

  test('collects the calls and their file ops', () => {
    const parsed = parsePatchRecords(rollout)
    assert.equal(parsed.sessionId, 'sess-1')
    assert.equal(parsed.calls.length, 1)
    assert.equal(parsed.calls[0].at, '2026-07-14T10:00:00.000Z')
    assert.equal(parsed.files.length, 1)
    assert.equal(parsed.files[0].path, 'src/login.py')
  })

  test('does not count a non-patch tool call as an unparsed patch', () => {
    // `unparsedCalls` is a real signal only if it means "looked like a patch and was not
    // understood". Counting every other tool call would make the signal useless.
    assert.equal(parsePatchRecords(rollout).unparsedCalls, 0)
  })

  test('reports a body with markers but no ops as unparsed rather than as a silent zero', () => {
    const broken = JSON.stringify({
      timestamp: '2026-07-14T10:00:00.000Z',
      type: 'response_item',
      payload: { type: 'custom_tool_call', input: '*** Begin Patch\n*** End Patch' },
    })
    assert.equal(parsePatchRecords(broken).unparsedCalls, 1)
  })

  test('survives a truncated line, because a live session is the normal case', () => {
    const truncated = `${rollout}\n{"type":"response_item","payload":{"typ`
    assert.equal(parsePatchRecords(truncated).calls.length, 1)
  })
})

describe('a patch built by a script, not passed as the call body', () => {
  const scripted = JSON.stringify({
    timestamp: '2026-07-20T08:42:13.301Z',
    type: 'response_item',
    payload: {
      type: 'custom_tool_call',
      call_id: 'call_1',
      name: 'exec',
      input: 'const patch = "*** Begin Patch\\n*** Update File: D:\\\\rfs\\\\cli.py\\n@@\\n-old\\n+new\\n*** End Patch";\ntext(await tools.apply_patch(patch));\n',
    },
  })

  test('finds the literal, unescapes it, and marks the provenance', () => {
    // One of the two real sessions writes patches this way. Reading only the call-body
    // shape would discard every edit it made and leave the case half-measured.
    const parsed = parsePatchRecords(scripted)
    assert.equal(parsed.calls.length, 1)
    assert.equal(parsed.calls[0].source, 'embedded')
    assert.equal(parsed.files[0].path, 'D:\\rfs\\cli.py')
    assert.deepEqual(parsed.files[0].hunks[0].added, ['new'])
  })

  test('declines a marker that is not inside a string literal', () => {
    const prose = JSON.stringify({
      timestamp: '2026-07-20T08:42:13.301Z',
      type: 'response_item',
      payload: { type: 'custom_tool_call', name: 'exec', input: '// see *** Begin Patch in the docs' },
    })
    assert.equal(parsePatchRecords(prose).calls.length, 0)
  })

  test('does not treat an unterminated literal as a patch', () => {
    const broken = JSON.stringify({
      timestamp: '2026-07-20T08:42:13.301Z',
      type: 'response_item',
      payload: { type: 'custom_tool_call', name: 'exec', input: 'const patch = "*** Begin Patch\\n*** Add File: x' },
    })
    assert.equal(parsePatchRecords(broken).calls.length, 0)
  })

  test('unescapes only the escapes a string literal actually defines', () => {
    assert.equal(unescapeStringLiteral('a\\nb'), 'a\nb')
    assert.equal(unescapeStringLiteral('D:\\\\rfs'), 'D:\\rfs')
    assert.equal(unescapeStringLiteral('say \\"hi\\"'), 'say "hi"')
    assert.equal(unescapeStringLiteral('\\u0041\\x42'), 'AB')
  })

  test('counts embedded and direct calls together, so neither session is invisible', () => {
    const direct = JSON.stringify({
      timestamp: '2026-07-20T07:20:00.000Z',
      type: 'response_item',
      payload: { type: 'custom_tool_call', name: 'apply_patch', input: UPDATE_BODY },
    })
    const parsed = parsePatchRecords(`${direct}\n${scripted}`)
    assert.equal(parsed.calls.length, 2)
    assert.deepEqual(parsed.calls.map((call) => call.source), ['body', 'embedded'])
    assert.equal(parsed.files.length, 2)
  })
})

describe('applying a patch to a base revision', () => {
  const base = ['def login(user, password):', '    return authenticate(user, password)', '', 'def logout(user):', '    return True', ''].join('\n')

  test('applies an update and yields the patch bytes exactly', () => {
    const result = applyFileOps(base, parsePatchBody(UPDATE_BODY))
    assert.equal(result.ok, true, result.reason)
    assert.equal(
      result.lines.join('\n'),
      ['def login(user, password):', '    return authenticate(user, password, max_attempts=5)', '', 'def logout(user):', '    return True'].join('\n'),
    )
  })

  test('refuses, with a reason, when the base revision does not match', () => {
    // The honesty gate depends on this: a candidate whose patch cannot be anchored is
    // dropped, never approximated into a clean merge.
    const result = applyFileOps('completely different content\n', parsePatchBody(UPDATE_BODY))
    assert.equal(result.ok, false)
    assert.match(result.reason, /does not match the base revision/)
    assert.equal(result.failedHunk, 0)
  })

  test('matches through trailing whitespace and CRLF, which differ between checkouts', () => {
    const messier = base.replace('def logout(user):', 'def logout(user):   ').replace(/\n/g, '\r\n')
    const result = applyFileOps(messier, parsePatchBody(UPDATE_BODY))
    assert.equal(result.ok, true, result.reason)
    assert.ok(result.lines.join('\n').includes('max_attempts=5'))
  })

  test('applies an Add File only to empty content', () => {
    const add = parsePatchBody('*** Begin Patch\n*** Add File: src/new.py\n+print(1)\n*** End Patch')
    assert.deepEqual(applyFileOps('', add).lines, ['print(1)'])
    assert.equal(applyFileOps('already here\n', add).ok, false)
  })

  test('applies two hunks in one file without letting the first move the second', () => {
    const body = [
      '*** Begin Patch',
      '*** Update File: a.py',
      '@@',
      ' x = 1',
      '-y = 2',
      '+y = 20',
      '@@',
      ' z = 3',
      '-w = 4',
      '+w = 40',
      '*** End Patch',
    ].join('\n')
    const result = applyFileOps('x = 1\ny = 2\n\nz = 3\nw = 4\n', parsePatchBody(body))
    assert.equal(result.ok, true, result.reason)
    assert.equal(result.lines.join('\n'), 'x = 1\ny = 20\n\nz = 3\nw = 40')
  })
})

describe('removing a patch from a revision that already has it', () => {
  const landed = ['def login(user, password):', '    return authenticate(user, password, max_attempts=5)', '', 'def logout(user):', '    return True', ''].join('\n')

  test('undoes exactly what applying did', () => {
    const base = ['def login(user, password):', '    return authenticate(user, password)', '', 'def logout(user):', '    return True', ''].join('\n')
    const ops = parsePatchBody(UPDATE_BODY)
    const applied = applyFileOps(base, ops)
    const removed = reverseFileOps(applied.lines.join('\n'), ops)
    assert.equal(removed.ok, true, removed.reason)
    assert.equal(removed.lines.join('\n'), base.trimEnd())
  })

  test('leaves a second session’s change in place, which is the whole point', () => {
    // The demo's two branches are built by removing the *other* session's edit from the
    // landed file. Removing one edit has to leave the other byte-identical, or the merge
    // result would be about the reconstruction and not about the two sessions.
    const both = `${landed.trimEnd()}\n\ndef audit_log(user):\n    return True\n`
    const removed = reverseFileOps(both, parsePatchBody(UPDATE_BODY))
    assert.equal(removed.ok, true, removed.reason)
    assert.equal(
      removed.lines.join('\n'),
      ['def login(user, password):', '    return authenticate(user, password)', '', 'def logout(user):', '    return True', '', 'def audit_log(user):', '    return True'].join('\n'),
    )
  })

  test('refuses when the other session’s change sits inside the region being removed', () => {
    // An interleaved edit moves the lines the removal has to locate, and the applier must
    // say so rather than cut around the intrusion. Silently succeeding here would produce a
    // branch whose content neither session ever wrote.
    const interleaved = landed.replace('def logout(user):', 'def logout(user):\n    audit(user)')
    const result = reverseFileOps(interleaved, parsePatchBody(UPDATE_BODY))
    assert.equal(result.ok, false)
    assert.match(result.reason, /does not match the base revision/)
  })

  test('refuses a revision that never held the change', () => {
    const base = ['def login(user, password):', '    return authenticate(user, password)', ''].join('\n')
    const result = reverseFileOps(base, parsePatchBody(UPDATE_BODY))
    assert.equal(result.ok, false)
    assert.match(result.reason, /does not match the base revision/)
  })

  test('turns an added file into a deletion and a deleted file into an addition', () => {
    const add = parsePatchBody('*** Begin Patch\n*** Add File: src/new.py\n+print(1)\n+print(2)\n*** End Patch')
    assert.deepEqual(reverseOp(add[0]).kind, 'delete')
    assert.equal(reverseFileOps('print(1)\nprint(2)\n', add).ok, true)
    assert.deepEqual(reverseOp(reverseOp(add[0])).kind, 'add')
  })

  test('swaps every count, so a reversed op cannot be read as a forward one', () => {
    const op = parsePatchBody(UPDATE_BODY)[0]
    const reversed = reverseOp(op)
    assert.equal(reversed.addedLines, op.removedLines)
    assert.equal(reversed.removedLines, op.addedLines)
    assert.deepEqual(reversed.hunks[0].old, op.hunks[0].next)
    assert.deepEqual(reversed.hunks[0].next, op.hunks[0].old)
  })
})

describe('signature recognition', () => {
  test('recognises the callable forms the pool actually contains', () => {
    assert.equal(signatureOf('def handler(event):'), 'def handler')
    assert.equal(signatureOf('async def fetch(url):'), 'def fetch')
    assert.equal(signatureOf('export async function run(ctx) {'), 'function run')
    assert.equal(signatureOf('class RateLimiter:'), 'class RateLimiter')
    assert.equal(signatureOf('func (s *Store) Put(k string) error {'), 'func Put')
    assert.equal(signatureOf('pub async fn build(cfg: &Config) -> Result<()> {'), 'fn build')
    assert.equal(signatureOf('export interface Session {'), 'interface Session')
  })

  test('declines an ordinary statement rather than inventing a declaration', () => {
    assert.equal(signatureOf('    return authenticate(user, password)'), null)
    assert.equal(signatureOf('# a comment'), null)
    assert.equal(signatureOf(''), null)
  })
})
