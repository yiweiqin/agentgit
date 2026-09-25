#!/usr/bin/env bash
# Is `fs/write-intent` reachable only by registering ahead of the provider?
#
# Reality check on what is established:
#   * a rest-parameter listener on `fs/write-intent` IS invoked by the host (census run);
#   * an arity-3 listener on `fs/write-intent` is NOT invoked when it is the only listener
#     registered (probe run), but IS invoked when an earlier listener chains into it (arity run);
#   * `tools/pre-execute` invokes an arity-2 listener directly, so shape alone is not fatal.
#
# The consistent reading is that `fs/write-intent` is a single-slot waterfall whose head is
# already occupied by the fs provider, which returns without delegating -- exactly what the
# plugin's own comment describes. A listener appended behind that head never runs. If so, the
# fix is the same mechanism `plugin.ts` already uses for `agent/pre-step`: `{ prepend: true }`.
#
# Three arms, one variable each.
set -uo pipefail

EXP_ROOT=/root/autodl-tmp/coord-exp
HOST="$EXP_ROOT/dsh-host"
export PATH=/opt/node24/bin:$PATH
export DEEPSEEK_API_KEY="$(cat /root/.coord-deepseek-key)"
DSH="$HOST/node_modules/.bin/dsh"
VAR="$EXP_ROOT/variants"; mkdir -p "$VAR"

mk_plugin() { # mk_plugin <name> <registration-expr>
  local name="$1" expr="$2"
  cat > "$VAR/$name.ts" <<TS
import { appendFileSync } from 'node:fs'

export const name = '$name'
export const inject: string[] = []

export function apply(ctx: { on: (e: string, h: unknown, o?: unknown) => void }): void {
  const LOG = '/tmp/prepend/$name.jsonl'
  const log = (entry: Record<string, unknown>) => {
    try { appendFileSync(LOG, JSON.stringify(entry) + '\n') } catch {}
  }
  log({ phase: 'apply' })
  $expr
  ctx.on('tools/pre-execute', (async (exec: unknown, next: unknown) => {
    log({ phase: 'pre-execute-control-fired' })
    return typeof next === 'function' ? await (next as () => unknown)() : undefined
  }) as unknown)
}
TS
  cat > "/tmp/ov-$name.yml" <<YML
- insert:
    - id: $name
      name: $VAR/$name.ts
YML
}

# V1: the real plugin's shape, appended (the configuration that produced no records).
mk_plugin v1-appended 'ctx.on("fs/write-intent", (async (target: unknown, actor: unknown, next: unknown) => {
    log({ phase: "FS-FIRED", variant: "v1-appended" })
    return typeof next === "function" ? await (next as () => unknown)() : undefined
  }) as unknown)'

# V2: identical handler, registered ahead of the provider.
mk_plugin v2-prepended 'ctx.on("fs/write-intent", (async (target: unknown, actor: unknown, next: unknown) => {
    log({ phase: "FS-FIRED", variant: "v2-prepended" })
    return typeof next === "function" ? await (next as () => unknown)() : undefined
  }) as unknown, { prepend: true })'

# V3: appended, but rest parameters -- the shape that worked in the census.
mk_plugin v3-rest 'ctx.on("fs/write-intent", (async (...args: unknown[]) => {
    log({ phase: "FS-FIRED", variant: "v3-rest", nArgs: args.length })
    const next = args[args.length - 1]
    return typeof next === "function" ? await (next as () => unknown)() : undefined
  }) as unknown)'

rm -rf /tmp/prepend; mkdir -p /tmp/prepend
TASK="Create a file named a.txt containing alpha."

for v in v1-appended v2-prepended v3-rest; do
  work="$EXP_ROOT/runs/prepend-$v"; mkdir -p "$work"; rm -f "$work"/*.txt "$work"/a.txt
  ( cd "$work" && timeout 300 "$DSH" --profile headless --patch "/tmp/ov-$v.yml" "$TASK" \
      >"$work/out.txt" 2>"$work/err.txt" )
  rc=$?
  fired="no"
  [ -f "/tmp/prepend/$v.jsonl" ] && grep -q FS-FIRED "/tmp/prepend/$v.jsonl" && fired="YES"
  printf '  %-14s exit=%-3s a.txt=%-4s fs/write-intent %s\n' "$v" "$rc" \
    "$([ -f "$work/a.txt" ] && echo yes || echo NO)" "$fired"
done

echo
echo "=== raw logs ==="
for v in v1-appended v2-prepended v3-rest; do
  echo "  --- $v ---"
  if [ -f "/tmp/prepend/$v.jsonl" ]; then cat "/tmp/prepend/$v.jsonl" | sed 's/^/    /'
  else echo "    (no log file: apply() never ran)"; fi
done

echo
echo "=== verdict ==="
if grep -q FS-FIRED /tmp/prepend/v2-prepended.jsonl 2>/dev/null && ! grep -q FS-FIRED /tmp/prepend/v1-appended.jsonl 2>/dev/null; then
  echo "  CONFIRMED: appended fs/write-intent listener is skipped; { prepend: true } fixes it."
  echo "  -> plugin.ts must register fs/write-intent with { prepend: true }."
else
  echo "  not confirmed -- inspect raw logs above."
fi

echo
echo "=== prepend test finished ==="
