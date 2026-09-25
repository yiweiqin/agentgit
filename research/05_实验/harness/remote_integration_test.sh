#!/usr/bin/env bash
# Boot a real session with the governor mounted, and check the observer half end to end.
#
# This is the integration test the whole experiment rests on: if the ledger is not written
# by a real session, then E0 has nothing to cross-validate, E1 has nothing to measure, and
# E3 has no dependent variable. Everything so far has been setup that only makes sense if
# this step works.
#
# The plugin is mounted with --patch rather than installed, so this run shares no mutable
# state with any other arm: the mount, the arm label, and the ledger path are all injected
# per invocation. That matters because a run's ledger has to be attributable to exactly one
# arm without trusting a label passed beside it, and two arms must never append to one file.
#
# No output is piped into another command: a booting DSH process whose parent is killed can
# leave worker threads holding the pipe open, which hangs the pipeline (as happened during
# the earlier mount attempt). Output goes to files, and the boot is bounded by `timeout`.
set -uo pipefail

EXP_ROOT=/root/autodl-tmp/coord-exp
HOST="$EXP_ROOT/dsh-host"
PLUGIN="$EXP_ROOT/dsh-coord-governor"
export PATH=/opt/node24/bin:$PATH
export DEEPSEEK_API_KEY="$(cat /root/.coord-deepseek-key)"
DSH="$HOST/node_modules/.bin/dsh"

ARM=A1-instrument
WORK="$EXP_ROOT/runs/$ARM-r1"
LEDGER_DIR="$EXP_ROOT/ledgers"
LEDGER="$LEDGER_DIR/$ARM.jsonl"

mkdir -p "$WORK" "$LEDGER_DIR"
rm -f "$WORK/probe.txt" "$WORK/stdout.txt" "$WORK/stderr.txt"
rm -f "$LEDGER"

cat > "$WORK/overlay.yml" <<YML
- insert:
    - id: coord-governor
      name: $PLUGIN/src/index.ts
      config:
        arm: $ARM
        ledgerPath: $LEDGER
YML

echo "=== overlay for this run ==="
sed 's/^/  /' "$WORK/overlay.yml"

echo
echo "=== boot: $ARM ==="
cd "$WORK"
timeout 420 "$DSH" --profile headless --patch "$WORK/overlay.yml" \
  "Create a file named probe.txt containing the word hello." \
  >"$WORK/stdout.txt" 2>"$WORK/stderr.txt"
rc=$?
echo "  exit=$rc"
echo "  --- stdout ---"
head -20 "$WORK/stdout.txt" 2>/dev/null | sed 's/^/    /'
echo "  --- stderr (last 25 lines) ---"
tail -25 "$WORK/stderr.txt" 2>/dev/null | sed 's/^/    /'
echo "  probe.txt: $(cat "$WORK/probe.txt" 2>/dev/null || echo NOT-CREATED)"

echo
echo "=== ledger: did the observer half write anything? ==="
if [ -f "$LEDGER" ]; then
  echo "  path: $LEDGER"
  echo "  size: $(stat -c %s "$LEDGER") bytes, $(wc -l <"$LEDGER") lines"
  echo "  --- contents ---"
  sed 's/^/    /' "$LEDGER"
else
  echo "  NOT CREATED at $LEDGER"
  echo "  --- any jsonl written in the last 10 minutes? ---"
  find "$EXP_ROOT" /tmp -name '*.jsonl' -newermt '-10 minutes' 2>/dev/null | head -10 | sed 's/^/    /'
  echo "  --- did the plugin even load? (grep the error paths) ---"
  grep -inE 'coord|governor|plugin tree|failed to import' "$WORK/stderr.txt" 2>/dev/null | head -10 | sed 's/^/    /'
fi

echo
echo "=== session log for this run ==="
find /root/.dsh/sessions -name 'session*.jsonl.zstd' -newermt '-10 minutes' 2>/dev/null | head -5 | sed 's/^/  /'

echo
echo "=== integration test finished ==="
