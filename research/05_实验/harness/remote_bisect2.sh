#!/usr/bin/env bash
# Bisect why the real plugin's fs/write-intent listener is never invoked.
#
# Established:
#   * a listener with the exact shape the real plugin uses IS invoked when the plugin imports
#     nothing from the plugin's own source (v1/v2/v3 all fired);
#   * the probe plugin, which imports adapter/governor/config/store and constructs a
#     GovernorRuntime, had its fs/write-intent listener never invoked -- while its
#     tools/pre-execute listener on the same plugin was invoked normally;
#   * the real plugin behaves like the probe.
#
# So the variable is the plugin's own module graph, not the listener shape and not chain order.
# Three arms isolate it: control, imports-only, imports plus the full handler.
set -uo pipefail

EXP_ROOT=/root/autodl-tmp/coord-exp
HOST="$EXP_ROOT/dsh-host"
PLUGIN="$EXP_ROOT/dsh-coord-governor"
export PATH=/opt/node24/bin:$PATH
export DEEPSEEK_API_KEY="$(cat /root/.coord-deepseek-key)"
DSH="$HOST/node_modules/.bin/dsh"
VAR="$EXP_ROOT/variants"; mkdir -p "$VAR"
D=/tmp/bisect2; rm -rf "$D"; mkdir -p "$D"

# P0: control. No plugin-module imports. Known to fire.
cat > "$VAR/p0-control.ts" <<TS
import { appendFileSync } from 'node:fs'
export const name = 'p0-control'
export const inject: string[] = []
const LOG = '$D/p0.jsonl'
export function apply(ctx: { on: (e: string, h: unknown) => void }): void {
  const log = (e: Record<string, unknown>) => { try { appendFileSync(LOG, JSON.stringify(e) + '\n') } catch {} }
  log({ phase: 'apply' })
  ctx.on('fs/write-intent', (async (target: unknown, actor: unknown, next: unknown) => {
    log({ phase: 'FS-FIRED' })
    return typeof next === 'function' ? await (next as () => unknown)() : undefined
  }) as unknown)
}
TS

# P1: import the plugin's modules and construct the runtime, but keep the handler trivial.
cat > "$VAR/p1-imports.ts" <<TS
import { appendFileSync } from 'node:fs'
import { resolveArm } from '$PLUGIN/src/config.ts'
import { GovernorRuntime } from '$PLUGIN/src/governor.ts'
import { appendLedgerLine, ledgerFilePath } from '$PLUGIN/src/store.ts'
export const name = 'p1-imports'
export const inject: string[] = []
const LOG = '$D/p1.jsonl'
export function apply(ctx: { on: (e: string, h: unknown) => void }): void {
  const log = (e: Record<string, unknown>) => { try { appendFileSync(LOG, JSON.stringify(e) + '\n') } catch {} }
  const cfg = { ...resolveArm('A1-instrument'), ledgerPath: '$D/p1-ledger.jsonl' }
  log({ phase: 'apply', cfgBuilt: true })
  const runtime = new GovernorRuntime(cfg, {
    sink: (line) => appendLedgerLine(ledgerFilePath(cfg.ledgerPath), line),
  })
  log({ phase: 'runtime-constructed', hasRuntime: !!runtime })
  ctx.on('fs/write-intent', (async (target: unknown, actor: unknown, next: unknown) => {
    log({ phase: 'FS-FIRED' })
    return typeof next === 'function' ? await (next as () => unknown)() : undefined
  }) as unknown)
}
TS

# P2: as P1, plus the real handler body (observe a file_write).
cat > "$VAR/p2-full.ts" <<TS
import { appendFileSync } from 'node:fs'
import { sessionIdOf, toEntities } from '$PLUGIN/src/adapter.ts'
import { resolveArm } from '$PLUGIN/src/config.ts'
import { GovernorRuntime } from '$PLUGIN/src/governor.ts'
import { appendLedgerLine, ledgerFilePath } from '$PLUGIN/src/store.ts'
export const name = 'p2-full'
export const inject: string[] = []
const LOG = '$D/p2.jsonl'
export function apply(ctx: { on: (e: string, h: unknown) => void }): void {
  const log = (e: Record<string, unknown>) => { try { appendFileSync(LOG, JSON.stringify(e) + '\n') } catch {} }
  const cfg = { ...resolveArm('A1-instrument'), ledgerPath: '$D/p2-ledger.jsonl' }
  const runtime = new GovernorRuntime(cfg, {
    sink: (line) => appendLedgerLine(ledgerFilePath(cfg.ledgerPath), line),
  })
  ctx.on('fs/write-intent', (async (target: { displayPath?: string }, actor: unknown, next: unknown) => {
    log({ phase: 'FS-FIRED-BODY-ENTERED' })
    const intent = typeof next === 'function' ? await (next as () => unknown)() : undefined
    try {
      const sessionId = sessionIdOf(actor)
      const recorded = runtime.observe({
        kind: 'file_write',
        sessionId: sessionId ?? 'unknown',
        entities: toEntities([target?.displayPath ?? '']),
        hostEvent: 'fs/write-intent',
      })
      log({ phase: 'observed', sessionId, recordedKind: recorded?.kind ?? null, errors: runtime.errors })
    } catch (error) {
      log({ phase: 'body-threw', error: String(error) })
    }
    return intent
  }) as unknown)
}
TS

for n in p0-control p1-imports p2-full; do
  cat > "/tmp/ov-$n.yml" <<YML
- insert:
    - id: $n
      name: $VAR/$n.ts
YML
done

for n in p0-control p1-imports p2-full; do
  work="$EXP_ROOT/runs/bisect2-$n"; mkdir -p "$work"; rm -f "$work"/*.txt "$work"/a.txt
  ( cd "$work" && timeout 300 "$DSH" --profile headless --patch "/tmp/ov-$n.yml" \
      "Create a file named a.txt containing alpha." >"$work/out.txt" 2>"$work/err.txt" )
  rc=$?
  fired="no"
  [ -f "$D/$n.jsonl" ] && grep -q FS-FIRED "$D/$n.jsonl" && fired="YES"
  printf '  %-12s exit=%-3s a.txt=%-4s fs fired=%s\n' "$n" "$rc" "$([ -f "$work/a.txt" ] && echo yes || echo NO)" "$fired"
done

echo
echo "=== raw logs ==="
for n in p0-control p1-imports p2-full; do
  echo "  --- $n ---"
  if [ -f "$D/$n.jsonl" ]; then cat "$D/$n.jsonl" | sed 's/^/    /'; else echo "    (apply() never ran)"; fi
done

echo
echo "=== ledgers written by p2 ==="
for f in "$D/p2-ledger.jsonl"; do
  if [ -f "$f" ]; then echo "  $f: $(wc -l <"$f") events"; cat "$f" | python3 -c "
import json,sys,collections
c=collections.Counter(json.loads(l)['kind'] for l in sys.stdin if l.strip())
for k,n in c.most_common(): print(f'    {n:>3}  {k}')
"; else echo "  $f NOT WRITTEN"; fi
done

echo
echo "=== errors seen in any arm ==="
for n in p0-control p1-imports p2-full; do
  f="$EXP_ROOT/runs/bisect2-$n/err.txt"
  if [ -s "$f" ]; then echo "  --- $n ---"; tail -6 "$f" | sed 's/^/    /'; fi
done

echo
echo "=== bisect2 finished ==="
