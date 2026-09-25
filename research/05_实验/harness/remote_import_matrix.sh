#!/usr/bin/env bash
# Find which import triggers it, and whether a plugin with no host imports works.
#
# Established so far:
#   - no plugin                 -> works
#   - no-op plugin via --patch   -> works
#   - plugin that only does `import {createUserMessage} from '@deepseek-ai/dsh-llm'` -> REQUEST_EXTENSION
# So the trigger is a value import of a host package, not any handler and not the mount.
#
# The suspected mechanism is ESM module identity. Node's ESM resolver keys modules by URL and
# historically does not collapse symlinks the way CJS does, so a plugin reached through a
# symlinked node_modules can end up with its own instance of a host module -- which for a
# registry that asserts single ownership of a field means a duplicate registration.
#
# The fix that follows from this is architectural and cheap to test: a plugin mounted by
# path must not import host packages at runtime. Type-only imports are erased by type
# stripping and should be harmless; `schemastery` (the config schema) is a value import and
# must be checked separately, because if it also trips this then the Config export has to go.
set -uo pipefail

EXP_ROOT=/root/autodl-tmp/coord-exp
HOST="$EXP_ROOT/dsh-host"
PLUGIN="$EXP_ROOT/dsh-coord-governor"
export PATH=/opt/node24/bin:$PATH
export DEEPSEEK_API_KEY="$(cat /root/.coord-deepseek-key)"
DSH="$HOST/node_modules/.bin/dsh"
PROBES="$PLUGIN/import-probes"
mkdir -p "$PROBES"

echo "=== 1. the rest of prepare(), to see what can throw ==="
python3 - <<'PY'
import pathlib
p = pathlib.Path("/root/autodl-tmp/coord-exp/dsh-host/node_modules/@deepseek-ai/dsh-deepseek-llm-api-extensions/lib/index.js")
text = p.read_text(errors="replace")
i = text.find("async prepare(request)")
print(text[i : i + 1400] if i >= 0 else "(prepare not found)")
PY

echo
echo "=== 2. who registers which field? ==="
grep -rhoE '\.register\([^)]{0,60}' "$HOST/node_modules/@deepseek-ai/"*/lib/*.js 2>/dev/null \
  | sort -u | head -20 | sed 's/^/  /'
echo "  --- packages calling register ---"
grep -rl 'deepseekLlmApiExtensions' "$HOST/node_modules/@deepseek-ai/"*/lib/*.js 2>/dev/null \
  | sed "s|$HOST/node_modules/@deepseek-ai/||" | sort -u | head -10 | sed 's/^/  /'

echo
echo "=== 3. import matrix: which import alone reproduces it? ==="
probe_import() {
  local id="$1" code="$2"
  cat > "$PROBES/$id.ts" <<TS
$code
export const name = 'probe-$id'
export const inject: string[] = []
export function apply(_ctx: any): void {}
TS
  printf -- '- insert:\n    - id: probe-%s\n      name: %s/%s.ts\n' "$id" "$PROBES" "$id" > "/tmp/ov-$id.yml"
  local work="$EXP_ROOT/runs/imp-$id"; mkdir -p "$work"
  rm -f "$work/probe.txt"
  ( cd "$work" && timeout 120 "$DSH" --profile headless --patch "/tmp/ov-$id.yml" \
      "Create a file named probe.txt containing the word hello." \
      >"$work/stdout.txt" 2>"$work/stderr.txt" )
  local rc=$?
  printf '  %-22s exit=%-3s %-10s %s\n' "$id" "$rc" \
    "$( [ -f "$work/probe.txt" ] && echo created || echo MISSING )" \
    "$(grep -ohE 'REQUEST_EXTENSION' "$work/stderr.txt" | head -1)"
}

probe_import "none"          "// no imports at all"
probe_import "schemastery"   "import z from '@deepseek-ai/schemastery'
void z"
probe_import "cordis"        "import { Service } from '@deepseek-ai/cordis'
void Service"
probe_import "dshllm"        "import { createUserMessage } from '@deepseek-ai/dsh-llm'
void createUserMessage"
probe_import "dshllm-type"   "import type { UserMessage } from '@deepseek-ai/dsh-llm'
export type T = UserMessage"

echo
echo "=== 4. the proposed shape: full handler set, zero host value imports ==="
cat > "$PROBES/noimport-governor.ts" <<'TS'
/**
 * The governor's handler surface with every runtime import removed.
 *
 * Exists to test the hypothesis directly: if this mounts cleanly where the real plugin does
 * not, then a path-mounted plugin must treat host packages as type-only, and the fix is
 * mechanical rather than a redesign.
 */
export const name = 'noimport-governor'
export const inject: string[] = []

export function apply(ctx: any): void {
  ctx.on('session/created', (session: any) => {
    ctx.logger?.info?.(`noimport-governor saw session ${session?.id ?? '?'}`)
  })
  ctx.on('session/event', (_session: any, event: any) => {
    if (event?.type === 'compaction/end') ctx.logger?.info?.('compaction/end')
  })
  ctx.on('fs/write-intent', async (_t: any, _a: any, next: any) => {
    const intent = await next()
    return intent
  })
  ctx.on('tools/pre-execute', async (_e: any, next: any) => {
    const decision = await next()
    return decision
  })
  ctx.on('tools/post-execute', async (_e: any, _r: any, next: any) => {
    const decision = await next()
    return decision
  })
  ctx.on('agent/pre-step', async (_p: any, next: any) => {
    const decision = await next()
    return decision
  }, { prepend: true })
  ctx.on('session/disposed', () => {})
}
TS
printf -- '- insert:\n    - id: noimport-governor\n      name: %s/noimport-governor.ts\n' "$PROBES" > /tmp/ov-noimport.yml

work="$EXP_ROOT/runs/imp-noimport-full"; mkdir -p "$work"; rm -f "$work/probe.txt"
( cd "$work" && timeout 150 "$DSH" --profile headless --patch /tmp/ov-noimport.yml \
    "Create a file named probe.txt containing the word hello." \
    >"$work/stdout.txt" 2>"$work/stderr.txt" )
echo "  exit=$?  probe=$([ -f "$work/probe.txt" ] && echo created || echo MISSING)"
echo "  stderr:"; tail -5 "$work/stderr.txt" | sed 's/^/    /'

echo
echo "=== import-matrix test finished ==="
