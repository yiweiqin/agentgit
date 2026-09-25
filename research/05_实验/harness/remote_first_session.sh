#!/usr/bin/env bash
# Decisive test: does a real headless DSH session complete on this machine?
#
# Everything up to here has been installation. This is the first time the host is asked
# to do its actual job, and it is the single fact that gates E1/E3 -- a machine that
# cannot finish one session cannot run a concurrency sweep.
#
# The sandbox is the known risk. DSH's sandbox needs Landlock plus bubblewrap; this box
# has kernel 5.4 (no Landlock) and every namespace syscall blocked, so the shipped
# sandbox cannot possibly initialise. The run is therefore attempted twice -- once as
# shipped, once with access widened -- because "the sandbox is what's broken" and "DSH
# is what's broken" need to be told apart before anything downstream can be trusted.
set -uo pipefail

EXP_ROOT=/root/autodl-tmp/coord-exp
HOST="$EXP_ROOT/dsh-host"
DSH="$HOST/node_modules/.bin/dsh"
export DEEPSEEK_API_KEY="$(cat /root/.coord-deepseek-key)"

echo "=== 0. how is the sandbox mode selected? ==="
grep -rhoE 'danger-full-access|dangerously-[a-z-]+|sandbox[A-Z][a-zA-Z]*|DSH_[A-Z_]*SANDBOX[A-Z_]*' \
  "$HOST/node_modules/@deepseek-ai/dsh-sandbox-local/lib/" 2>/dev/null | sort -u | head -15 | sed 's/^/  /'
echo "  --- permission presets ---"
ls "$HOST/node_modules/@deepseek-ai/dsh-permission-presets/" 2>/dev/null | head | sed 's/^/    /'
grep -rhoE '"(danger-full-access|full-access|read-only|workspace-write)"' \
  "$HOST/node_modules/@deepseek-ai/dsh-permission-presets/" 2>/dev/null | sort -u | head | sed 's/^/    /'
echo "  --- headless app flags ---"
"$DSH" --profile headless --help 2>&1 | head -30 | sed 's/^/    /'

run_arm() {
  local label="$1"; shift
  local work="$EXP_ROOT/runs/$label"
  rm -rf "$work"; mkdir -p "$work"
  echo
  echo "=== RUN [$label] $* ==="
  ( cd "$work" && timeout 420 "$DSH" "$@" ) 2>&1 | tail -35
  local rc=${PIPESTATUS[0]}
  echo "  --- exit=$rc ---"
  echo "  probe.txt: $(cat "$work/probe.txt" 2>/dev/null || echo 'NOT CREATED')"
  echo "  files: $(ls -A "$work" 2>/dev/null | tr '\n' ' ')"
}

run_arm probe-shipped --profile headless "Create a file named probe.txt containing the word hello."

echo
echo "=== session logs produced so far ==="
find /root/.dsh "$EXP_ROOT" -name 'session*.jsonl*' 2>/dev/null | head -10 | sed 's/^/  /'

echo
echo "=== run finished ==="
