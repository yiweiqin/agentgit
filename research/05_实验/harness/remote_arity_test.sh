#!/usr/bin/env bash
# Determine why an arity-3 `fs/write-intent` listener is never invoked while a rest-parameter
# listener on the same event is.
#
# Established so far:
#   * the census plugin registers `ctx.on('fs/write-intent', async (...args) => ...)` and IS
#     called, 3 times for 3 writes;
#   * the probe plugin registers `ctx.on('fs/write-intent', async (target, actor, next) => ...)`
#     and is NOT called, while its `tools/pre-execute` listener (arity 2) IS called.
#
# If listener arity is the discriminator, that is a silent, invisible failure mode for this
# plugin: `fs/write-intent` is the declared authoritative write-intent point, and everything
# downstream (lambda_produced, B(t), contention) is derived from the records it should emit.
# A never-invoked listener produces a perfectly healthy-looking run with an empty instrument.
#
# The test registers both shapes on the same event in the same process, so ordering, event
# dispatch and environment are all held constant and only the shape varies.
set -uo pipefail

EXP_ROOT=/root/autodl-tmp/coord-exp
HOST="$EXP_ROOT/dsh-host"
export PATH=/opt/node24/bin:$PATH
export DEEPSEEK_API_KEY="$(cat /root/.coord-deepseek-key)"
DSH="$HOST/node_modules/.bin/dsh"
VAR="$EXP_ROOT/variants"; mkdir -p "$VAR"
D=/tmp/arity; rm -rf "$D"; mkdir -p "$D"

cat > "$VAR/arity.ts" <<TS
import { appendFileSync } from 'node:fs'

export const name = 'arity-probe'
export const inject: string[] = []

const LOG = '$D/log.jsonl'
function log(entry: Record<string, unknown>): void {
  try { appendFileSync(LOG, JSON.stringify(entry) + '\n') } catch {}
}

export function apply(ctx: { on: (e: string, h: unknown) => void }): void {
  // Shape A: rest parameters. This is the shape the census used successfully.
  ctx.on('fs/write-intent', (async (...args: unknown[]) => {
    log({ shape: 'A-rest', event: 'fs/write-intent', arity: 0, nArgs: args.length })
    const next = args[args.length - 1]
    return typeof next === 'function' ? await (next as () => unknown)() : undefined
  }) as unknown)

  // Shape B: three named parameters. This is the shape the real plugin uses.
  ctx.on('fs/write-intent', (async (target: unknown, actor: unknown, next: unknown) => {
    log({ shape: 'B-arity3', event: 'fs/write-intent', arity: 3,
          targetIsUndefined: target === undefined, actorIsUndefined: actor === undefined,
          nextIsFunction: typeof next === 'function' })
    return typeof next === 'function' ? await (next as () => unknown)() : undefined
  }) as unknown)

  // Shape C: four parameters, to see whether an over-declared arity also fails.
  ctx.on('fs/write-intent', (async (a: unknown, b: unknown, c: unknown, d: unknown) => {
    log({ shape: 'C-arity4', event: 'fs/write-intent', arity: 4,
          cIsFunction: typeof c === 'function', dIsFunction: typeof d === 'function' })
    const next = typeof d === 'function' ? d : c
    return typeof next === 'function' ? await (next as () => unknown)() : undefined
  }) as unknown)

  // Control: the same three shapes on an event whose arity-2 listener is known to be invoked.
  ctx.on('tools/pre-execute', (async (...args: unknown[]) => {
    log({ shape: 'A-rest', event: 'tools/pre-execute', arity: 0, nArgs: args.length })
    const next = args[args.length - 1]
    return typeof next === 'function' ? await (next as () => unknown)() : undefined
  }) as unknown)

  ctx.on('tools/pre-execute', (async (exec: unknown, next: unknown) => {
    log({ shape: 'B-arity2', event: 'tools/pre-execute', arity: 2,
          execIsUndefined: exec === undefined, nextIsFunction: typeof next === 'function' })
    return typeof next === 'function' ? await (next as () => unknown)() : undefined
  }) as unknown)

  log({ phase: 'apply-done' })
}
TS

cat > /tmp/ov-arity.yml <<YML
- insert:
    - id: arity-probe
      name: $VAR/arity.ts
YML

work="$EXP_ROOT/runs/arity"; mkdir -p "$work"; rm -f "$work"/*.txt "$work"/a.txt
echo "=== run ==="
( cd "$work" && timeout 300 "$DSH" --profile headless --patch /tmp/ov-arity.yml \
    "Create a file named a.txt containing alpha." >"$work/out.txt" 2>"$work/err.txt" )
rc=$?
echo "  exit=$rc  a.txt=$([ -f "$work/a.txt" ] && echo yes || echo NO)"
echo "  stderr: $(tail -3 "$work/err.txt" | tr '\n' ' ' | cut -c1-200)"

echo
echo "=== which listener shapes were invoked? ==="
if [ -f "$D/log.jsonl" ]; then
  python3 - "$D/log.jsonl" <<'PY'
import json, sys, collections
rows = [json.loads(l) for l in open(sys.argv[1]) if l.strip()]
tally = collections.Counter((r.get("event"), r.get("shape", r.get("phase"))) for r in rows)
for (ev, shape), n in sorted(tally.items()):
    mark = "INVOKED" if shape and shape != "apply-done" else "        "
    print(f"  {mark}  {n:>3}x  {ev:<20} {shape}")
print()
print("  raw:")
for r in rows:
    print("   ", json.dumps(r, ensure_ascii=False))
PY
else
  echo "  NOT WRITTEN"
fi

echo
echo "=== arity test finished ==="
