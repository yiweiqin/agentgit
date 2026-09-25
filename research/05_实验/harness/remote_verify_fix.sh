#!/usr/bin/env bash
# Verify the fix: the governor must now mount, run a real task, and fill its ledger.
#
# The change under test is that the plugin ships no runtime import of any `@deepseek-ai/*`
# package, which is what lets it live in a directory tree with no ancestor node_modules and
# therefore stop duplicating the host's request-extension registry.
#
# The task is chosen to exercise the observer half rather than just the boot path: it forces
# several file writes, so `fs/write-intent` has to fire repeatedly. A run that merely exits 0
# would not distinguish "the plugin is mounted" from "the plugin is mounted and blind".
set -uo pipefail

EXP_ROOT=/root/autodl-tmp/coord-exp
HOST="$EXP_ROOT/dsh-host"
PLUGIN="$EXP_ROOT/dsh-coord-governor"
export PATH=/opt/node24/bin:$PATH
export DEEPSEEK_API_KEY="$(cat /root/.coord-deepseek-key)"
DSH="$HOST/node_modules/.bin/dsh"
LEDGER="$EXP_ROOT/ledgers/A1-instrument.jsonl"

echo "=== 1. confirm no ancestor node_modules can satisfy @deepseek-ai ==="
d="$PLUGIN"
while [ "$d" != "/" ]; do
  if [ -d "$d/node_modules/@deepseek-ai" ]; then
    echo "  !! $d/node_modules/@deepseek-ai EXISTS (would break the run)"
  fi
  d=$(dirname "$d")
done
echo "  checked $PLUGIN and all ancestors: $([ -d "$PLUGIN/node_modules" ] && echo 'node_modules PRESENT' || echo 'no node_modules')"

echo
echo "=== 2. confirm the plugin has no runtime host imports ==="
echo "  --- every import line in src/ ---"
grep -hn "^import" "$PLUGIN"/src/*.ts | sed 's/^/    /'
echo "  --- value imports from @deepseek-ai (should be none) ---"
grep -hn "^import [^{t].*'@deepseek-ai/\|^import {[^}]*} from '@deepseek-ai/" "$PLUGIN"/src/*.ts \
  | sed 's/^/    /' || echo "    (none)"

echo
echo "=== 3. can node import the plugin from that location? ==="
( cd "$PLUGIN" && node --input-type=module -e "
try { const m = await import('$PLUGIN/src/index.ts'); console.log('    ok; has apply:', typeof m.apply === 'function', '| has Config:', 'Config' in m) }
catch (e) { console.log('    FAILED:', e.code, String(e.message).split('\n')[0]) }
" )

run_arm() {
  local label="$1" overlay="$2" task="$3"
  local work="$EXP_ROOT/runs/$label"; mkdir -p "$work"; rm -f "$work"/*.txt
  local start=$(date +%s)
  ( cd "$work" && timeout 300 "$DSH" --profile headless ${overlay:+--patch "$overlay"} "$task" \
      >"$work/stdout.txt" 2>"$work/stderr.txt" )
  local rc=$?
  printf '  %-16s exit=%-3s %3ss  %s\n' "$label" "$rc" "$(( $(date +%s) - start ))" \
    "$(grep -ohE 'REQUEST_EXTENSION' "$work/stderr.txt" | head -1)"
  echo "    files: $(ls -A "$work" 2>/dev/null | grep -v 'txt$' | tr '\n' ' ')"
}

TASK="Create three files in the current directory: a.txt containing alpha, b.txt containing beta, and c.txt containing gamma."

echo
echo "=== 4. A0 baseline (no plugin) ==="
run_arm a0-baseline "" "$TASK"

echo
echo "=== 5. A1 instrument (governor mounted) ==="
rm -f "$LEDGER"
cat > /tmp/ov-fixed-a1.yml <<YML
- insert:
    - id: coord-governor
      name: $PLUGIN/src/index.ts
      config:
        arm: A1-instrument
        ledgerPath: $LEDGER
YML
run_arm a1-fixed /tmp/ov-fixed-a1.yml "$TASK"

echo
echo "=== 6. ledger ==="
if [ -f "$LEDGER" ]; then
  echo "  $LEDGER: $(wc -l <"$LEDGER") events"
  echo "  --- event kinds and entities ---"
  python3 - "$LEDGER" <<'PY'
import json, sys, collections
kinds = collections.Counter()
for line in open(sys.argv[1]):
    line = line.strip()
    if not line:
        continue
    e = json.loads(line)
    kinds[e["kind"]] += 1
    if e["kind"] == "file_write":
        print(f"    file_write  entities={e['entities']}  host={e['host_event']}  task={e['task_id']}")
for k, n in kinds.most_common():
    print(f"    {n:>3}  {k}")
PY
else
  echo "  NOT WRITTEN"
fi

echo
echo "=== verification finished ==="
