#!/usr/bin/env bash
# Census which Cordis events actually fire in a real headless session, and with what arguments.
#
# Why this is worth a dedicated run: the ledger from the first successful live session contained
# no `file_write` event, even though the `fs/write-intent` handler is written to emit one. Every
# downstream quantity in the experiment -- lambda_produced, B(t), contention -- is derived from
# `file_write`, so an observation point that silently never fires would make the whole
# instrument read zero while looking perfectly healthy.
#
# The suspect is stated in the plugin's own source: `fs/write-intent` is described as a
# *single-slot* waterfall, where "the first listener that returns an intent owns the decision
# rather than composing with peers". The fs provider registers first and returns without
# delegating, so a later listener never runs. This run tests that directly, and also checks
# whether registering ahead of the provider (`prepend`) changes the outcome.
#
# Rather than guess, register a listener on every candidate event and record what arrives.
set -uo pipefail

EXP_ROOT=/root/autodl-tmp/coord-exp
HOST="$EXP_ROOT/dsh-host"
export PATH=/opt/node24/bin:$PATH
export DEEPSEEK_API_KEY="$(cat /root/.coord-deepseek-key)"
DSH="$HOST/node_modules/.bin/dsh"
VAR="$EXP_ROOT/variants"; mkdir -p "$VAR"
CENSUS=/tmp/census-out

make_census_plugin() { # make_census_plugin <file> <mode: normal|prepend|all-prepend>
  local file="$1" mode="$2"
  local fsopts="" toolopts="" agentopts=""
  case "$mode" in
    prepend)       fsopts=", { prepend: true }" ;;
    all-prepend)   fsopts=", { prepend: true }"; toolopts=", { prepend: true }"; agentopts=", { prepend: true }" ;;
  esac
  cat > "$file" <<TS
import { appendFileSync } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'

export const name = 'census-$mode'
export const inject: string[] = []

const OUT = '$CENSUS'

function describe(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value
  const t = typeof value
  if (t === 'string') return value.length > 120 ? value.slice(0, 120) + '...' : value
  if (t === 'number' || t === 'boolean') return value
  if (t === 'function') return '<function>'
  if (Array.isArray(value)) return depth > 1 ? '<array>' : value.slice(0, 3).map((v) => describe(v, depth + 1))
  if (t === 'object') {
    const o = value as Record<string, unknown>
    if (depth > 1) return '<object>'
    const keys = Object.keys(o).slice(0, 14)
    const out: Record<string, unknown> = {}
    for (const k of keys) out[k] = describe(o[k], depth + 1)
    return out
  }
  return String(value)
}

function record(event: string, args: unknown[]): void {
  const next = args[args.length - 1]
  const payload = args.slice(0, -1)
  try {
    appendFileSync(OUT, JSON.stringify({
      event,
      nArgs: args.length,
      lastIsFunction: typeof next === 'function',
      args: payload.map((a) => describe(a)),
    }) + '\n')
  } catch {}
}

export function apply(ctx: Context): void {
  // Waterfall-shaped events: must delegate, and must return whatever the host produced.
  const waterfall = (event: string, opts?: object) => {
    ctx.on(event as never, (async (...args: unknown[]) => {
      record(event, args)
      const next = args[args.length - 1]
      return typeof next === 'function' ? await (next as () => unknown)() : undefined
    }) as never, opts as never)
  }
  // Emit-shaped events: return value ignored.
  const emit = (event: string, opts?: object) => {
    ctx.on(event as never, ((...args: unknown[]) => { record(event, args) }) as never, opts as never)
  }

  waterfall('fs/write-intent'$fsopts)
  waterfall('fs/edit-intent'$fsopts)
  waterfall('tools/pre-execute'$toolopts)
  waterfall('tools/post-execute'$toolopts)
  waterfall('agent/pre-step'$agentopts)
  emit('agent/turn-stopping')
  emit('session/created')
  emit('session/event')
  emit('session/disposed')
  emit('tools/result')
  emit('agent/session-start')
}
TS
}

cat > /tmp/ov-census-normal.yml <<YML
- insert:
    - id: census-normal
      name: $VAR/census-normal.ts
YML
cat > /tmp/ov-census-prepend.yml <<YML
- insert:
    - id: census-prepend
      name: $VAR/census-prepend.ts
YML
cat > /tmp/ov-census-allprepend.yml <<YML
- insert:
    - id: census-allprepend
      name: $VAR/census-allprepend.ts
YML
make_census_plugin "$VAR/census-normal.ts" normal
make_census_plugin "$VAR/census-prepend.ts" prepend
make_census_plugin "$VAR/census-allprepend.ts" all-prepend

TASK="Create three files in the current directory: a.txt containing alpha, b.txt containing beta, and c.txt containing gamma."

run_census() { # run_census <label> <overlay>
  local label="$1" overlay="$2"
  local work="$EXP_ROOT/runs/census-$label"; mkdir -p "$work"
  rm -f "$work"/*.txt "$work"/a.txt "$work"/b.txt "$work"/c.txt "$CENSUS"
  ( cd "$work" && timeout 300 "$DSH" --profile headless --patch "$overlay" "$TASK" \
      >"$work/out.txt" 2>"$work/err.txt" )
  local rc=$?
  echo "  --- $label (exit=$rc, files: $(ls "$work" 2>/dev/null | grep -E '^[abc]\.txt$' | tr '\n' ' ')) ---"
  if [ -f "$CENSUS" ]; then
    python3 - "$CENSUS" <<'PY'
import json, sys, collections
rows = [json.loads(l) for l in open(sys.argv[1]) if l.strip()]
counts = collections.Counter(r["event"] for r in rows)
for ev, n in sorted(counts.items()):
    print(f"    FIRED  {n:>3}x  {ev}")
fired = set(counts)
candidates = {
    'fs/write-intent', 'fs/edit-intent', 'tools/pre-execute', 'tools/post-execute',
    'agent/pre-step', 'agent/turn-stopping', 'session/created', 'session/event',
    'session/disposed', 'tools/result', 'agent/session-start',
}
for ev in sorted(candidates - fired):
    print(f"    SILENT      {ev}")
sample = next((r for r in rows if r["event"] == "fs/write-intent"), None)
if sample:
    print("    sample fs/write-intent args:", json.dumps(sample["args"])[:400])
sample = next((r for r in rows if r["event"] == "tools/pre-execute"), None)
if sample:
    print("    sample tools/pre-execute args:", json.dumps(sample["args"])[:400])
PY
  else
    echo "    census file NOT written (no handler ever ran)"
  fi
}

echo "=== census: were listeners registered after the provider? (normal) ==="
run_census "normal" /tmp/ov-census-normal.yml

echo
echo "=== census: fs listeners registered ahead of the provider (prepend) ==="
run_census "prepend" /tmp/ov-census-prepend.yml

echo
echo "=== census: every listener registered ahead (all-prepend) ==="
run_census "allprepend" /tmp/ov-census-allprepend.yml

echo
echo "=== but wait: does the write tool even go through the fs service? ==="
echo "  --- tools invoked in the normal arm, from the session log ---"
work="$EXP_ROOT/runs/census-normal"
latest=$(find /root/.dsh -name 'session*.jsonl.zstd' -newermt '-30 minutes' 2>/dev/null | head -1)
echo "  session log: ${latest:-none}"
if [ -n "${latest:-}" ]; then
  zstdcat "$latest" 2>/dev/null | python3 -c "
import json, sys, collections
tools = collections.Counter()
for line in sys.stdin:
    line = line.strip()
    if not line: continue
    try: e = json.loads(line)
    except Exception: continue
    s = json.dumps(e)
    for name in ['write_file','write','edit_file','edit','str_replace','apply_patch','read_file','bash','shell','run_command']:
        if '\"name\":\"' + name + '\"' in s or '\"toolName\":\"' + name + '\"' in s: tools[name] += 1
print('  tool name sightings:', dict(tools))
" 2>/dev/null || echo "  (could not parse session log)"
fi

echo
echo "=== census finished ==="
