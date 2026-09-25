#!/usr/bin/env bash
# Test whether simply removing the plugin's private node_modules fixes it.
#
# Established: a plugin fails iff it has an ancestor node_modules that can satisfy
# @deepseek-ai/*, because that gives host modules a second URL and the extension registry
# asserts single ownership of a field. Relocating under the profile did not help, because
# the profile's node_modules is itself a symlink to a different path than the one the host
# boots from.
#
# The profile ships a `.dsh-module-fallback/node_modules` directory, which is evidence that
# the loader already has a canonical resolution path for plugin dependencies. If so, the
# correct configuration is to give the plugin *no* local node_modules at all and let that
# fallback resolve its imports -- which would mean no code change is needed, only deleting
# the symlink that machine #1's workaround introduced.
set -uo pipefail

EXP_ROOT=/root/autodl-tmp/coord-exp
HOST="$EXP_ROOT/dsh-host"
PLUGIN="$EXP_ROOT/dsh-coord-governor"
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
  printf '  %-28s exit=%-3s probe=%-9s %s\n' "$label" "$rc" \
    "$( [ -f "$work/probe.txt" ] && echo created || echo MISSING )" \
    "$(grep -ohE 'REQUEST_EXTENSION|Cannot find package [^ ]*|failed to import' "$work/stderr.txt" | head -1)"
  [ -n "$ledger" ] && [ -f "$ledger" ] && echo "      ledger: $(wc -l <"$ledger") events"
}

echo "=== what the module fallback dir holds ==="
find /root/.dsh/profiles/headless/.dsh-module-fallback -maxdepth 3 2>/dev/null | head -8 | sed 's/^/  /'
find /root/.dsh/profiles/node_modules -maxdepth 1 -type l 2>/dev/null | head -5 | sed 's/^/  symlink: /'

echo
echo "=== 1. before: with the symlink (the workaround) ==="
echo "  plugin node_modules: $(ls -ld "$PLUGIN/node_modules" 2>/dev/null | awk '{print $NF}')"
run "01-with-symlink" /tmp/overlay-a1.yml "$EXP_ROOT/ledgers/A1-instrument.jsonl"

echo
echo "=== 2. remove the symlink and retry the SAME source, unchanged ==="
rm -f "$PLUGIN/node_modules/@deepseek-ai"
rmdir "$PLUGIN/node_modules" 2>/dev/null || true
echo "  plugin node_modules now: $([ -d "$PLUGIN/node_modules" ] && echo present || echo gone)"

echo
echo "  --- can node still resolve the plugin's imports without it? ---"
( cd "$PLUGIN" && node --input-type=module -e "
for (const spec of ['@deepseek-ai/schemastery','@deepseek-ai/dsh-llm']) {
  try { await import(spec); console.log('   ', spec, '-> ok') }
  catch (e) { console.log('   ', spec, '-> FAILED', e.code) }
}
" ) 2>&1 | head -5

echo
echo "  --- does DSH itself still load the plugin? ---"
run "02-no-symlink" /tmp/overlay-a1.yml "$EXP_ROOT/ledgers/A1-instrument.jsonl"

echo
echo "=== 3. if it failed for MODULE_NOT_FOUND, retry via a clean sibling dir ==="
run "03-clean-sibling" /tmp/overlay-noimport.yml "$EXP_ROOT/ledgers/A1-instrument.jsonl"

echo
echo "=== 4. ledger contents ==="
for f in "$EXP_ROOT/ledgers/A1-instrument.jsonl"; do
  if [ -f "$f" ]; then echo "  $f ($(wc -l <"$f") events)"; cut -c1-160 "$f" | sed 's/^/    /'; fi
done

echo
echo "=== fallback test finished ==="
