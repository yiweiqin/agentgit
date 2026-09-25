#!/usr/bin/env bash
# Final bisection: what exactly makes the fs/write-intent listener stop being invoked?
#
# Ruled out so far: listener arity, registration order, chain position (prepend), and tool
# choice (p0/p1/p2 all used the `write` tool; only p0's fs listener fired).
#
# Remaining variable: the plugin's import graph and the runtime construction. Each arm below
# registers BOTH an fs/write-intent listener and a tools/pre-execute listener, so any arm where
# pre-execute fires but fs does not proves the failure is event-specific rather than a dead
# plugin. Log filenames are literal per arm (an earlier run checked the wrong names and reported
# false negatives).
set -uo pipefail

EXP_ROOT=/root/autodl-tmp/coord-exp
HOST="$EXP_ROOT/dsh-host"
PLUGIN="$EXP_ROOT/dsh-coord-governor"
export PATH=/opt/node24/bin:$PATH
export DEEPSEEK_API_KEY="$(cat /root/.coord-deepseek-key)"
DSH="$HOST/node_modules/.bin/dsh"
VAR="$EXP_ROOT/variants"; mkdir -p "$VAR"
D=/tmp/bisect3; rm -rf "$D"; mkdir -p "$D"

# q0: no plugin imports. Control.
cat > "$VAR/q0.ts" <<'TS'
import { appendFileSync } from 'node:fs'
export const name = 'q0'
export const inject: string[] = []
const LOG = '/tmp/bisect3/q0.log'
function log(e: Record<string, unknown>): void {
  try { appendFileSync(LOG, JSON.stringify(e) + '\n') } catch {}
}
export function apply(ctx: { on: (e: string, h: unknown) => void }): void {
  log({ phase: 'apply' })
  ctx.on('fs/write-intent', (async (t: unknown, a: unknown, n: unknown) => {
    log({ phase: 'FS-FIRED' })
    return typeof n === 'function' ? await (n as () => unknown)() : undefined
  }) as unknown)
  ctx.on('tools/pre-execute', (async (e: unknown, n: unknown) => {
    log({ phase: 'PRE-FIRED', tool: (e as { name?: string })?.name ?? null })
    return typeof n === 'function' ? await (n as () => unknown)() : undefined
  }) as unknown)
}
TS

# q1: import the plugin's modules, but never construct the runtime.
cat > "$VAR/q1.ts" <<'TS'
import { appendFileSync } from 'node:fs'
import { classifyTool, extractPaths, sessionIdOf, toEntities } from '/root/autodl-tmp/coord-exp/dsh-coord-governor/src/adapter.ts'
import { resolveArm } from '/root/autodl-tmp/coord-exp/dsh-coord-governor/src/config.ts'
import { buildReport } from '/root/autodl-tmp/coord-exp/dsh-coord-governor/src/ledger.ts'
export const name = 'q1'
export const inject: string[] = []
const LOG = '/tmp/bisect3/q1.log'
function log(e: Record<string, unknown>): void {
  try { appendFileSync(LOG, JSON.stringify(e) + '\n') } catch {}
}
export function apply(ctx: { on: (e: string, h: unknown) => void }): void {
  log({ phase: 'apply', classifyTool: typeof classifyTool, extractPaths: typeof extractPaths,
        sessionIdOf: typeof sessionIdOf, toEntities: typeof toEntities,
        resolveArm: typeof resolveArm, buildReport: typeof buildReport })
  ctx.on('fs/write-intent', (async (t: unknown, a: unknown, n: unknown) => {
    log({ phase: 'FS-FIRED' })
    return typeof n === 'function' ? await (n as () => unknown)() : undefined
  }) as unknown)
  ctx.on('tools/pre-execute', (async (e: unknown, n: unknown) => {
    log({ phase: 'PRE-FIRED', tool: (e as { name?: string })?.name ?? null })
    return typeof n === 'function' ? await (n as () => unknown)() : undefined
  }) as unknown)
}
TS

# q2: imports plus runtime construction, with registration wrapped so a throw is visible.
cat > "$VAR/q2.ts" <<'TS'
import { appendFileSync } from 'node:fs'
import { sessionIdOf, toEntities } from '/root/autodl-tmp/coord-exp/dsh-coord-governor/src/adapter.ts'
import { resolveArm } from '/root/autodl-tmp/coord-exp/dsh-coord-governor/src/config.ts'
import { GovernorRuntime } from '/root/autodl-tmp/coord-exp/dsh-coord-governor/src/governor.ts'
import { appendLedgerLine, ledgerFilePath } from '/root/autodl-tmp/coord-exp/dsh-coord-governor/src/store.ts'
export const name = 'q2'
export const inject: string[] = []
const LOG = '/tmp/bisect3/q2.log'
function log(e: Record<string, unknown>): void {
  try { appendFileSync(LOG, JSON.stringify(e) + '\n') } catch {}
}
export function apply(ctx: { on: (e: string, h: unknown) => void }): void {
  log({ phase: 'apply' })
  const cfg = { ...resolveArm('A1-instrument'), ledgerPath: '/tmp/bisect3/q2-ledger.jsonl' }
  const runtime = new GovernorRuntime(cfg, { sink: (l) => appendLedgerLine(ledgerFilePath(cfg.ledgerPath), l) })
  log({ phase: 'runtime-constructed', ctxKeys: Object.keys(ctx as object) })
  try {
    ctx.on('fs/write-intent', (async (t: { displayPath?: string }, a: unknown, n: unknown) => {
      log({ phase: 'FS-FIRED' })
      const intent = typeof n === 'function' ? await (n as () => unknown)() : undefined
      log({ phase: 'FS-BODY', sid: sessionIdOf(a), displayPath: t?.displayPath ?? null,
            entities: toEntities([t?.displayPath ?? '']).length,
            recorded: runtime.observe({ kind: 'file_write', sessionId: sessionIdOf(a) ?? 'x',
              entities: toEntities([t?.displayPath ?? '']), hostEvent: 'fs/write-intent' })?.kind ?? null,
            errors: runtime.errors })
      return intent
    }) as unknown)
    log({ phase: 'fs-registered' })
  } catch (error) {
    log({ phase: 'fs-registration-threw', error: String(error) })
  }
  ctx.on('tools/pre-execute', (async (e: unknown, n: unknown) => {
    log({ phase: 'PRE-FIRED', tool: (e as { name?: string })?.name ?? null })
    return typeof n === 'function' ? await (n as () => unknown)() : undefined
  }) as unknown)
  log({ phase: 'pre-registered' })
}
TS

for n in q0 q1 q2; do
  cat > "/tmp/ov-$n.yml" <<YML
- insert:
    - id: $n
      name: $VAR/$n.ts
YML
done

for n in q0 q1 q2; do
  work="$EXP_ROOT/runs/bisect3-$n"; mkdir -p "$work"; rm -f "$work"/*.txt "$work"/a.txt
  ( cd "$work" && timeout 300 "$DSH" --profile headless --patch "/tmp/ov-$n.yml" \
      "Create a file named a.txt containing alpha." >"$work/out.txt" 2>"$work/err.txt" )
  rc=$?
  f="$D/$n.log"
  fs_fired=$([ -f "$f" ] && grep -c FS-FIRED "$f" || echo 0)
  pre_fired=$([ -f "$f" ] && grep -c PRE-FIRED "$f" || echo 0)
  printf '  %-3s exit=%-3s a.txt=%-4s FS-FIRED=%s  PRE-FIRED=%s\n' "$n" "$rc" \
    "$([ -f "$work/a.txt" ] && echo yes || echo NO)" "$fs_fired" "$pre_fired"
done

echo
echo "=== logs ==="
for n in q0 q1 q2; do
  echo "  --- $n ---"
  if [ -f "$D/$n.log" ]; then cat "$D/$n.log" | sed 's/^/    /'; else echo "    (no log)"; fi
done

echo
echo "=== q2 ledger ==="
[ -f "$D/q2-ledger.jsonl" ] && python3 -c "
import json,collections
c=collections.Counter(json.loads(l)['kind'] for l in open('$D/q2-ledger.jsonl') if l.strip())
print('   ', dict(c))
" || echo "    NOT WRITTEN"

echo
echo "=== any plugin errors in stderr ==="
for n in q0 q1 q2; do
  f="$EXP_ROOT/runs/bisect3-$n/err.txt"
  if grep -qiE 'plugin|fiber|load' "$f" 2>/dev/null; then echo "  --- $n ---"; grep -iE 'plugin|fiber|load' "$f" | head -5 | sed 's/^/    /'; fi
done

echo
echo "=== bisect3 finished ==="
