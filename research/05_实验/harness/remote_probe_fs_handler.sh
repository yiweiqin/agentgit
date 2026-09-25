#!/usr/bin/env bash
# Instrument the real GovernorRuntime at the fs/write-intent point.
#
# The live session produced `gate_allowed` records (from tools/pre-execute) but no `file_write`
# records (from fs/write-intent), even though a census run proves the event fires. Both paths
# go through the same `observe` -> `#ledger.record` code, and the A1 arm has
# `recordObservations: true`, so something specific to this handler is swallowing the record.
#
# Rather than keep reading code, this replicates the handler against the plugin's own modules
# and logs every intermediate value: whether the handler was entered, what `sessionIdOf(actor)`
# returned, whether `observe` returned an event or null, and any fault it contained.
set -uo pipefail

EXP_ROOT=/root/autodl-tmp/coord-exp
HOST="$EXP_ROOT/dsh-host"
PLUGIN="$EXP_ROOT/dsh-coord-governor"
export PATH=/opt/node24/bin:$PATH
export DEEPSEEK_API_KEY="$(cat /root/.coord-deepseek-key)"
DSH="$HOST/node_modules/.bin/dsh"
VAR="$EXP_ROOT/variants"; mkdir -p "$VAR"
PROBE_DIR=/tmp/probe-fs; rm -rf "$PROBE_DIR"; mkdir -p "$PROBE_DIR"

cat > "$VAR/probe-fs.ts" <<TS
import { appendFileSync } from 'node:fs'
import { classifyTool, extractPaths, sessionIdOf, toEntities } from '$PLUGIN/src/adapter.ts'
import { resolveArm } from '$PLUGIN/src/config.ts'
import { GovernorRuntime } from '$PLUGIN/src/governor.ts'
import { appendLedgerLine, ledgerFilePath } from '$PLUGIN/src/store.ts'

export const name = 'probe-fs'
export const inject: string[] = []

const LOG = '$PROBE_DIR/log.jsonl'

function log(entry: Record<string, unknown>): void {
  appendFileSync(LOG, JSON.stringify(entry) + '\n')
}

export function apply(ctx: unknown): void {
  const cfg = { ...resolveArm('A1-instrument'), ledgerPath: '$PROBE_DIR/ledger.jsonl' }
  log({ phase: 'apply', recordObservations: (cfg as { recordObservations: boolean }).recordObservations })

  const runtime = new GovernorRuntime(cfg, {
    sink: (line) => appendLedgerLine(ledgerFilePath(cfg.ledgerPath), line),
  })

  ;(ctx as { on: (e: string, h: unknown) => void }).on('fs/write-intent', async (
    target: { displayPath?: string; targetKey?: string },
    actor: unknown,
    next: () => unknown,
  ) => {
    log({ phase: 'entered', hasTarget: !!target, displayPath: target?.displayPath ?? null,
          targetKeys: target ? Object.keys(target) : [],
          actorIsUndefined: actor === undefined,
          actorKeys: actor && typeof actor === 'object' ? Object.keys(actor as object) : [],
          actorId: (actor as { id?: unknown })?.id ?? null,
          actorAgentId: (actor as { agent?: { id?: unknown } })?.agent?.id ?? null })

    const intent = await next()
    log({ phase: 'after-next', intentType: typeof intent, intentIsUndefined: intent === undefined })

    try {
      const sessionId = sessionIdOf(actor)
      log({ phase: 'resolve', sessionId, sessionIdIsNull: sessionId === null })

      const entities = toEntities([target?.displayPath ?? ''])
      log({ phase: 'entities', count: entities.length, entities })

      const recorded = runtime.observe({
        kind: 'file_write',
        sessionId: sessionId ?? 'unknown',
        entities,
        hostEvent: 'fs/write-intent',
        detail: { targetKey: String(target?.targetKey ?? ''), phase: 'intent' },
      })
      log({ phase: 'observed', recordedIsNull: recorded === null,
            recordedKind: recorded?.kind ?? null, taskId: recorded?.taskId ?? null,
            errors: runtime.errors })
    } catch (error) {
      log({ phase: 'handler-threw', error: String(error) })
    }

    return intent
  })

  // Also probe the pre-execute path, which *did* produce records, for comparison.
  ;(ctx as { on: (e: string, h: unknown) => void }).on('tools/pre-execute', async (
    exec: { name?: string; arguments?: unknown; agent?: unknown },
    next: () => Promise<unknown>,
  ) => {
    const decision = await next()
    try {
      const toolClass = classifyTool(String(exec?.name ?? ''))
      const paths = extractPaths(exec?.arguments)
      log({ phase: 'pre-execute', toolName: exec?.name ?? null, toolClass, paths,
            sessionId: sessionIdOf(exec?.agent) })
    } catch (error) {
      log({ phase: 'pre-execute-threw', error: String(error) })
    }
    return decision
  })
}
TS

cat > /tmp/ov-probe-fs.yml <<YML
- insert:
    - id: probe-fs
      name: $VAR/probe-fs.ts
YML

work="$EXP_ROOT/runs/probe-fs"; mkdir -p "$work"; rm -f "$work"/*.txt "$work"/a.txt
echo "=== run ==="
( cd "$work" && timeout 300 "$DSH" --profile headless --patch /tmp/ov-probe-fs.yml \
    "Create a file named a.txt containing alpha." >"$work/out.txt" 2>"$work/err.txt" )
echo "  exit=$?  err=$(grep -ohE 'REQUEST_EXTENSION|[A-Z_]{6,}:' "$work/err.txt" | head -1 || echo none)"

echo
echo "=== probe log ==="
if [ -f "$PROBE_DIR/log.jsonl" ]; then
  python3 - "$PROBE_DIR/log.jsonl" <<'PY'
import json, sys
for line in open(sys.argv[1]):
    line = line.strip()
    if not line: continue
    e = json.loads(line)
    phase = e.pop("phase")
    print(f"  [{phase}] {json.dumps(e, ensure_ascii=False)}")
PY
else
  echo "  NOT WRITTEN (handlers never ran)"
fi

echo
echo "=== ledger the probe wrote ==="
if [ -f "$PROBE_DIR/ledger.jsonl" ]; then
  echo "  $(wc -l <"$PROBE_DIR/ledger.jsonl") events"
  python3 -c "
import json,sys,collections
c=collections.Counter()
for l in open('$PROBE_DIR/ledger.jsonl'):
    l=l.strip()
    if l: c[json.loads(l)['kind']]+=1
for k,n in c.most_common(): print(f'    {n:>3}  {k}')
"
else
  echo "  NOT WRITTEN"
fi

echo
echo "=== probe finished ==="
