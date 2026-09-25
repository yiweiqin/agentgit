#!/usr/bin/env bash
# Isolate whether the plugin caused REQUEST_EXTENSION, or whether it is unrelated.
#
# The plugin-free run on this machine succeeded in 33s. The plugin-mounted run failed after
# ~500s with `dsh: REQUEST_EXTENSION`. Those two facts admit three explanations that need
# different fixes:
#   (a) the plugin breaks request preparation -- then the plugin, not the machine, is at fault
#   (b) the API is flaky/rate-limited -- then the plugin-free run should fail too
#   (c) something about --patch / the mount path leaks into the request
# The ~500s runtime is itself evidence: llm-retry retrying before giving up points at the
# transport, not at a deterministic composition bug (which would fail fast).
#
# So: run A0 (no plugin) and A1 (observed) back to back under identical conditions except
# for the mount. A0 succeeding again would exonerate the API and implicate the mount.
set -uo pipefail

EXP_ROOT=/root/autodl-tmp/coord-exp
HOST="$EXP_ROOT/dsh-host"
PLUGIN="$EXP_ROOT/dsh-coord-governor"
export PATH=/opt/node24/bin:$PATH
export DEEPSEEK_API_KEY="$(cat /root/.coord-deepseek-key)"
DSH="$HOST/node_modules/.bin/dsh"

echo "=== where does REQUEST_EXTENSION come from? ==="
grep -rl 'REQUEST_EXTENSION' "$HOST/node_modules/@deepseek-ai/" 2>/dev/null | head -5 | sed 's/^/  /'
echo "  --- the throwing context ---"
for f in $(grep -rl 'REQUEST_EXTENSION' "$HOST/node_modules/@deepseek-ai/" 2>/dev/null | head -2); do
  echo "  in $(echo "$f" | sed "s|$HOST/node_modules/@deepseek-ai/||"):"
  grep -oE '.{140}REQUEST_EXTENSION.{120}' "$f" 2>/dev/null | head -2 | sed 's/^/    /'
done

run_arm() {
  local label="$1"; shift
  local work="$EXP_ROOT/runs/$label"
  mkdir -p "$work"
  rm -f "$work/probe.txt" "$work/stdout.txt" "$work/stderr.txt"
  echo
  echo "=== RUN [$label] ==="
  local start=$(date +%s)
  ( cd "$work" && timeout 240 "$DSH" --profile headless "$@" \
      "Create a file named probe.txt containing the word hello." \
      >"$work/stdout.txt" 2>"$work/stderr.txt" )
  local rc=$?
  local elapsed=$(( $(date +%s) - start ))
  echo "  exit=$rc  elapsed=${elapsed}s"
  echo "  stdout: $(head -3 "$work/stdout.txt" 2>/dev/null | tr '\n' ' ')"
  echo "  stderr (last 6):"
  tail -6 "$work/stderr.txt" 2>/dev/null | sed 's/^/    /'
  echo "  probe.txt: $(cat "$work/probe.txt" 2>/dev/null || echo NOT-CREATED)"
}

mkdir -p "$EXP_ROOT/ledgers"
cat > /tmp/overlay-a1.yml <<YML
- insert:
    - id: coord-governor
      name: $PLUGIN/src/index.ts
      config:
        arm: A1-instrument
        ledgerPath: $EXP_ROOT/ledgers/A1-instrument.jsonl
YML

rm -f "$EXP_ROOT/ledgers/A1-instrument.jsonl"
run_arm a0-baseline
run_arm a1-instrument --patch /tmp/overlay-a1.yml

echo
echo "=== ledger after A1 ==="
if [ -f "$EXP_ROOT/ledgers/A1-instrument.jsonl" ]; then
  echo "  $(wc -l <"$EXP_ROOT/ledgers/A1-instrument.jsonl") events"
  cut -c1-200 "$EXP_ROOT/ledgers/A1-instrument.jsonl" | sed 's/^/    /'
else
  echo "  none written"
fi

echo
echo "=== session logs from both runs ==="
find /root/.dsh/sessions -name 'session*.jsonl.zstd' -newermt '-15 minutes' 2>/dev/null | head -5 | sed 's/^/  /'

echo
echo "=== isolation test finished ==="
