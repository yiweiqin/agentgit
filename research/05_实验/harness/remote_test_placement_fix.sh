#!/usr/bin/env bash
# Confirm the node_modules symlink is the cause, and test the placement that fixes it.
#
# The evidence reversed the conclusion:
#   no-op at $EXP_ROOT/noop-plugin/           (no ancestor node_modules) -> works
#   no-op at $EXP_ROOT/dsh-coord-governor/... (ancestor node_modules)    -> REQUEST_EXTENSION
# The plugin's own logic is irrelevant; even a plugin with zero imports fails when it sits
# under a directory that has its own @deepseek-ai tree. The symlink I created as machine
# #1's workaround gives every host package a second URL, and Node's ESM loader keys modules
# by URL -- so the host runs two copies of the extension registry, and the registry asserts
# single ownership of a field.
#
# The fix that follows is about *placement*, not about the plugin: put the plugin where the
# profile's own node_modules is its nearest ancestor, so both the host and the plugin resolve
# @deepseek-ai/* through the identical path and share one module instance.
#
# Tested here as three clean comparisons, with the symlink present and absent.
set -uo pipefail

EXP_ROOT=/root/autodl-tmp/coord-exp
HOST="$EXP_ROOT/dsh-host"
PLUGIN="$EXP_ROOT/dsh-coord-governor"
PROFILES=/root/.dsh/profiles
export PATH=/opt/node24/bin:$PATH
export DEEPSEEK_API_KEY="$(cat /root/.coord-deepseek-key)"
DSH="$HOST/node_modules/.bin/dsh"

run() {
  local label="$1" overlay="$2" ledger="${3:-}"
  local work="$EXP_ROOT/runs/$label"; mkdir -p "$work"; rm -f "$work/probe.txt"
  [ -n "$ledger" ] && rm -f "$ledger"
  ( cd "$work" && timeout 150 "$DSH" --profile headless --patch "$overlay" \
      "Create a file named probe.txt containing the word hello." \
      >"$work/stdout.txt" 2>"$work/stderr.txt" )
  local rc=$?
  printf '  %-30s exit=%-3s probe=%-9s %s\n' "$label" "$rc" \
    "$( [ -f "$work/probe.txt" ] && echo created || echo MISSING )" \
    "$(grep -ohE 'REQUEST_EXTENSION|Cannot find package [^ ]*' "$work/stderr.txt" | head -1)"
  if [ -n "$ledger" ] && [ -f "$ledger" ]; then
    echo "      ledger: $(wc -l <"$ledger") events"
  fi
}

echo "=== 1. is an ancestor node_modules really the trigger? ==="
mkdir -p "$EXP_ROOT/clean-probes"
cat > "$EXP_ROOT/clean-probes/noop.ts" <<'TS'
export const name = 'probe-clean-noop'
export const inject: string[] = []
export function apply(_ctx: any): void {}
TS
printf -- '- insert:\n    - id: probe-clean-noop\n      name: %s/noop.ts\n' "$EXP_ROOT/clean-probes" > /tmp/ov-clean.yml

# Same file, copied under the plugin dir so it inherits the symlinked node_modules.
mkdir -p "$PLUGIN/nested-probes"
cp "$EXP_ROOT/clean-probes/noop.ts" "$PLUGIN/nested-probes/noop.ts"
printf -- '- insert:\n    - id: probe-clean-noop\n      name: %s/nested-probes/noop.ts\n' "$PLUGIN" > /tmp/ov-nested.yml

echo "  A: same plugin, NO ancestor node_modules:"
run "triggerA-clean" /tmp/ov-clean.yml
echo "  B: same plugin, ancestor node_modules present:"
run "triggerB-nested" /tmp/ov-nested.yml

echo
echo "=== 2. the fix: place the real plugin under the profile ==="
# Copy the source so the profile's node_modules is the nearest ancestor. No private
# node_modules is created -- that is the whole point.
TARGET="$PROFILES/coord-governor"
rm -rf "$TARGET"
mkdir -p "$TARGET"
cp -r "$PLUGIN/src" "$TARGET/src"
cp "$PLUGIN/package.json" "$TARGET/package.json"
rm -rf "$TARGET/node_modules"
echo "  placed at: $TARGET"
echo "  private node_modules present: $([ -d "$TARGET/node_modules" ] && echo YES || echo no)"
echo "  nearest ancestor node_modules: $(cd "$TARGET" && node -e "console.log(require.resolve? '' : '')" 2>/dev/null; ls -d "$PROFILES/node_modules" 2>/dev/null)"
echo "  can node resolve @deepseek-ai/dsh-llm from there?"
( cd "$TARGET" && node --input-type=module -e "
try { await import('@deepseek-ai/dsh-llm'); console.log('    yes') }
catch (e) { console.log('    NO:', e.code, String(e.message).split('\n')[0]) }
" ) 2>&1 | head -3

LEDGER="$EXP_ROOT/ledgers/A1-instrument.jsonl"
rm -f "$LEDGER"
cat > /tmp/ov-fixed.yml <<YML
- insert:
    - id: coord-governor
      name: $TARGET/src/index.ts
      config:
        arm: A1-instrument
        ledgerPath: $LEDGER
YML
echo "  --- overlay ---"; sed 's/^/    /' /tmp/ov-fixed.yml
echo "  C: real governor, relocated under the profile:"
run "fixC-relocated" /tmp/ov-fixed.yml "$LEDGER"

echo
echo "=== 3. ledger written by the relocated run ==="
if [ -f "$LEDGER" ]; then
  echo "  $(wc -l <"$LEDGER") events"
  cut -c1-170 "$LEDGER" | sed 's/^/    /'
else
  echo "  none"
fi

echo
echo "=== 4. control: the original layout, for the record ==="
run "origD-symlinked" /tmp/overlay-a1.yml

echo
echo "=== placement test finished ==="
