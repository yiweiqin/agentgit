#!/usr/bin/env bash
# Distinguish "importing the module graph" from "registering later" as the cause.
#
# The correlation is exact: every arm that imports the plugin's own modules (5 runs) never
# received `fs/write-intent`; every arm that does not (10 runs) did. The modules involved have
# no host imports at all, so no duplicate instance can explain it.
#
# The plausible mechanism left is ordering: `fs/write-intent` may be delivered only to listeners
# present when the fs service composes its chain, and importing five modules delays registration
# past that point. Two arms separate the possibilities without importing anything:
#
#   q4  synchronous, but registers only after a long busy-wait (delay, no import)
#   q5  asynchronous apply that awaits a dynamic import (delay, and async registration)
#
# If q4 stops receiving the event, the trigger is timing, and the fix is to register the fs
# listener as early as possible -- ideally before any other module work in `apply`.
set -uo pipefail

EXP_ROOT=/root/autodl-tmp/coord-exp
HOST="$EXP_ROOT/dsh-host"
export PATH=/opt/node24/bin:$PATH
export DEEPSEEK_API_KEY="$(cat /root/.coord-deepseek-key)"
DSH="$HOST/node_modules/.bin/dsh"
VAR="$EXP_ROOT/variants"; mkdir -p "$VAR"
D=/tmp/bisect4; rm -rf "$D"; mkdir -p "$D"

# q4: no imports, synchronous apply, but a long busy-wait before registering.
cat > "$VAR/q4.ts" <<'TS'
import { appendFileSync } from 'node:fs'
export const name = 'q4'
export const inject: string[] = []
const LOG = '/tmp/bisect4/q4.log'
function log(e: Record<string, unknown>): void {
  try { appendFileSync(LOG, JSON.stringify(e) + '\n') } catch {}
}
export function apply(ctx: { on: (e: string, h: unknown) => void }): void {
  log({ phase: 'apply-start' })
  const until = Date.now() + 500
  while (Date.now() < until) { /* simulate slow module initialisation */ }
  log({ phase: 'busy-wait-done' })
  ctx.on('fs/write-intent', (async (t: unknown, a: unknown, n: unknown) => {
    log({ phase: 'FS-FIRED' })
    return typeof n === 'function' ? await (n as () => unknown)() : undefined
  }) as unknown)
  ctx.on('tools/pre-execute', (async (e: unknown, n: unknown) => {
    log({ phase: 'PRE-FIRED', tool: (e as { name?: string })?.name ?? null })
    return typeof n === 'function' ? await (n as () => unknown)() : undefined
  }) as unknown)
  log({ phase: 'registered' })
}
TS

# q5: asynchronous apply that awaits a real dynamic import of the plugin's modules.
cat > "$VAR/q5.ts" <<'TS'
import { appendFileSync } from 'node:fs'
export const name = 'q5'
export const inject: string[] = []
const LOG = '/tmp/bisect4/q5.log'
function log(e: Record<string, unknown>): void {
  try { appendFileSync(LOG, JSON.stringify(e) + '\n') } catch {}
}
export async function apply(ctx: { on: (e: string, h: unknown) => void }): Promise<void> {
  log({ phase: 'apply-start' })
  await import('/root/autodl-tmp/coord-exp/dsh-coord-governor/src/adapter.ts')
  await import('/root/autodl-tmp/coord-exp/dsh-coord-governor/src/config.ts')
  await import('/root/autodl-tmp/coord-exp/dsh-coord-governor/src/ledger.ts')
  log({ phase: 'dynamic-imports-done' })
  ctx.on('fs/write-intent', (async (t: unknown, a: unknown, n: unknown) => {
    log({ phase: 'FS-FIRED' })
    return typeof n === 'function' ? await (n as () => unknown)() : undefined
  }) as unknown)
  ctx.on('tools/pre-execute', (async (e: unknown, n: unknown) => {
    log({ phase: 'PRE-FIRED', tool: (e as { name?: string })?.name ?? null })
    return typeof n === 'function' ? await (n as () => unknown)() : undefined
  }) as unknown)
  log({ phase: 'registered' })
}
TS

# q6: register the fs listener FIRST, then do the module work. Candidate fix.
cat > "$VAR/q6.ts" <<'TS'
import { appendFileSync } from 'node:fs'
export const name = 'q6'
export const inject: string[] = []
const LOG = '/tmp/bisect4/q6.log'
function log(e: Record<string, unknown>): void {
  try { appendFileSync(LOG, JSON.stringify(e) + '\n') } catch {}
}
export async function apply(ctx: { on: (e: string, h: unknown) => void }): Promise<void> {
  // Register before touching any other module, then do the heavy work.
  ctx.on('fs/write-intent', (async (t: unknown, a: unknown, n: unknown) => {
    log({ phase: 'FS-FIRED' })
    return typeof n === 'function' ? await (n as () => unknown)() : undefined
  }) as unknown)
  ctx.on('tools/pre-execute', (async (e: unknown, n: unknown) => {
    log({ phase: 'PRE-FIRED', tool: (e as { name?: string })?.name ?? null })
    return typeof n === 'function' ? await (n as () => unknown)() : undefined
  }) as unknown)
  log({ phase: 'registered-early' })
  await import('/root/autodl-tmp/coord-exp/dsh-coord-governor/src/adapter.ts')
  await import('/root/autodl-tmp/coord-exp/dsh-coord-governor/src/config.ts')
  await import('/root/autodl-tmp/coord-exp/dsh-coord-governor/src/ledger.ts')
  log({ phase: 'modules-loaded-after-registration' })
}
TS

for n in q4 q5 q6; do
  cat > "/tmp/ov-$n.yml" <<YML
- insert:
    - id: $n
      name: $VAR/$n.ts
YML
done

for n in q4 q5 q6; do
  work="$EXP_ROOT/runs/bisect4-$n"; mkdir -p "$work"; rm -f "$work"/*.txt "$work"/a.txt
  ( cd "$work" && timeout 300 "$DSH" --profile headless --patch "/tmp/ov-$n.yml" \
      "Create a file named a.txt containing alpha." >"$work/out.txt" 2>"$work/err.txt" )
  rc=$?
  f="$D/$n.log"
  if [ -f "$f" ]; then fs_n=$(grep -c FS-FIRED "$f"); pre_n=$(grep -c PRE-FIRED "$f")
  else fs_n="nofile"; pre_n="nofile"; fi
  printf '  %-3s exit=%-3s a.txt=%-4s FS=%s PRE=%s\n' "$n" "$rc" \
    "$([ -f "$work/a.txt" ] && echo yes || echo NO)" "$fs_n" "$pre_n"
done

echo
echo "=== logs ==="
for n in q4 q5 q6; do
  echo "  --- $n ---"
  [ -f "$D/$n.log" ] && cat "$D/$n.log" | sed 's/^/    /' || echo "    (no log)"
done

echo
echo "=== verdict ==="
for n in q4 q5 q6; do
  if [ -f "$D/$n.log" ] && grep -q FS-FIRED "$D/$n.log"; then echo "  $n: fs/write-intent DELIVERED"
  else echo "  $n: fs/write-intent NOT delivered"; fi
done

echo
echo "=== bisect4 finished ==="
