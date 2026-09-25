#!/usr/bin/env bash
# Test the duplicate-module hypothesis for REQUEST_EXTENSION.
#
# Every handler passes in isolation, so the fault is not what the plugin *does*. What it
# does that a no-op does not is import `@deepseek-ai/dsh-llm`. The error text names a
# "field collision", which is what a duplicated module instance looks like from the inside:
# two copies of the same registry, each contributing the same extension.
#
# The duplication is plausible because the plugin resolves `@deepseek-ai/*` through a
# symlink into `dsh-host/node_modules`, while the host that actually boots resolves its
# plugins from `~/.dsh/profiles/node_modules`. If those are different physical copies, the
# plugin and the host each get their own instance of every shared module.
#
# Two checks: (1) are they actually different files, and (2) does a plugin that merely
# imports dsh-llm reproduce the failure? A no-op that imports nothing already passed, so if
# the import alone reproduces it, the fix is to point the symlink at the profile's tree.
set -uo pipefail

EXP_ROOT=/root/autodl-tmp/coord-exp
HOST="$EXP_ROOT/dsh-host"
PLUGIN="$EXP_ROOT/dsh-coord-governor"
PROFILE_MODULES=/root/.dsh/profiles/node_modules
VARIANTS="$EXP_ROOT/handler-probes"
export PATH=/opt/node24/bin:$PATH
export DEEPSEEK_API_KEY="$(cat /root/.coord-deepseek-key)"
DSH="$HOST/node_modules/.bin/dsh"

echo "=== 1. are the two @deepseek-ai trees the same files? ==="
echo "  host:    $(readlink -f "$HOST/node_modules/@deepseek-ai/dsh-llm" 2>/dev/null)"
echo "  profile: $(readlink -f "$PROFILE_MODULES/@deepseek-ai/dsh-llm" 2>/dev/null)"
echo "  plugin resolves dsh-llm to: $(readlink -f "$PLUGIN/node_modules/@deepseek-ai/dsh-llm" 2>/dev/null)"
h=$(readlink -f "$HOST/node_modules/@deepseek-ai/dsh-llm" 2>/dev/null)
p=$(readlink -f "$PROFILE_MODULES/@deepseek-ai/dsh-llm" 2>/dev/null)
if [ "$h" = "$p" ]; then echo "  VERDICT: identical"; else echo "  VERDICT: DIFFERENT COPIES (this is the suspected cause)"; fi
ls -d /root/.dsh/profiles/node_modules/@deepseek-ai/dsh-headless 2>/dev/null | sed 's/^/  profile has: /'

run_one() {
  local label="$1" overlay="$2"
  local work="$EXP_ROOT/runs/$label"
  mkdir -p "$work"; rm -f "$work/probe.txt" "$work/stdout.txt" "$work/stderr.txt"
  ( cd "$work" && timeout 150 "$DSH" --profile headless --patch "$overlay" \
      "Create a file named probe.txt containing the word hello." \
      >"$work/stdout.txt" 2>"$work/stderr.txt" )
  local rc=$?
  local sig=$(grep -ohE 'REQUEST_EXTENSION|MODULE_NOT_FOUND|Cannot find package [^ ]*' "$work/stderr.txt" 2>/dev/null | head -1)
  printf '  %-26s exit=%-3s probe=%-10s %s\n' "$label" "$rc" \
    "$( [ -f "$work/probe.txt" ] && echo created || echo MISSING )" "${sig:-ok}"
}

echo
echo "=== 2. does merely IMPORTING dsh-llm reproduce it? ==="
cat > "$VARIANTS/llmimport.ts" <<'TS'
// No handlers at all. The only difference from the passing no-op is this import.
import { createUserMessage } from '@deepseek-ai/dsh-llm'
export const name = 'probe-llmimport'
export const inject: string[] = []
export function apply(_ctx: any): void {
  void createUserMessage
}
TS
printf -- '- insert:\n    - id: probe-llmimport\n      name: %s/llmimport.ts\n' "$VARIANTS" > /tmp/overlay-llmimport.yml

cat > "$VARIANTS/noop2.ts" <<'TS'
export const name = 'probe-noop2'
export const inject: string[] = []
export function apply(_ctx: any): void {}
TS
printf -- '- insert:\n    - id: probe-noop2\n      name: %s/noop2.ts\n' "$VARIANTS" > /tmp/overlay-noop2.yml

run_one control-noop       /tmp/overlay-noop2.yml
run_one imports-dsh-llm    /tmp/overlay-llmimport.yml

echo
echo "=== 3. repoint the symlink at the tree the host actually boots from ==="
if [ -d "$PROFILE_MODULES/@deepseek-ai" ]; then
  ln -sfn "$PROFILE_MODULES/@deepseek-ai" "$PLUGIN/node_modules/@deepseek-ai"
  echo "  now -> $(readlink -f "$PLUGIN/node_modules/@deepseek-ai")"
  echo "  schemastery: $([ -d "$PLUGIN/node_modules/@deepseek-ai/schemastery" ] && echo visible || echo MISSING)"
  echo "  dsh-llm:     $([ -d "$PLUGIN/node_modules/@deepseek-ai/dsh-llm" ] && echo visible || echo MISSING)"
  echo
  echo "  --- real governor, A1-instrument, with the corrected link ---"
  run_one gov-a1-repointed /tmp/overlay-a1.yml
else
  echo "  profile @deepseek-ai tree absent; nothing to repoint to"
fi

echo
echo "=== 4. ledger from the repointed run ==="
if [ -f "$EXP_ROOT/ledgers/A1-instrument.jsonl" ]; then
  echo "  $(wc -l <"$EXP_ROOT/ledgers/A1-instrument.jsonl") events"
  cut -c1-150 "$EXP_ROOT/ledgers/A1-instrument.jsonl" | sed 's/^/    /'
else
  echo "  none"
fi

echo
echo "=== duplicate-module test finished ==="
