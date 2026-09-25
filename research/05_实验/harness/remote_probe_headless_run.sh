#!/usr/bin/env bash
# Attempt a real headless session and record exactly what blocks it.
#
# This is the definition of done for the `provision` todo ("run one headless session"),
# so the useful outcome is not "it worked" but a precise statement of what is missing.
# Guessing at the blocker would be worse than observing it.
set -u

EXP_ROOT=/root/autodl-tmp/coord-exp
export PATH=/opt/node24/bin:$PATH
export DSH_HOME="$EXP_ROOT/dsh-home"
WORK="$EXP_ROOT/worktree-probe"
mkdir -p "$WORK"
cd "$EXP_ROOT/dsh-host"

echo "=== environment being used ==="
echo "  DSH_HOME=$DSH_HOME"
echo "  cwd=$WORK"
echo "  credentials file: $([ -f "$DSH_HOME/.credentials.yaml" ] && echo present || echo absent)"
echo "  settings file:    $([ -f "$DSH_HOME/settings.yaml" ] && echo present || echo absent)"
env | grep -iE "DEEPSEEK|DSH_|OPENAI|ANTHROPIC" | sed 's/=.*/=<redacted>/' | sed 's/^/  env: /' || echo "  no model-related env vars"

echo
echo "=== what does the headless profile say about auth/model? ==="
timeout 60 ./node_modules/.bin/dsh --profile headless --help 2>&1 | head -50 | sed 's/^/  /'

echo
echo "=== does dsh have an auth or login command? ==="
timeout 60 ./node_modules/.bin/dsh --help 2>&1 | grep -iE "auth|login|key|model" | sed 's/^/  /' || echo "  none in the top-level help"

echo
echo "=== run it: one headless task, sandbox left at its default ==="
cd "$WORK"
set +e
timeout 180 "$EXP_ROOT/dsh-host/node_modules/.bin/dsh" --profile headless "Create a file named probe.txt containing the word hello." 2>&1 | head -80 | sed 's/^/  /'
run_status=$?
set -e
# 124 is timeout(1)'s code; anything else is the harness's own exit.
echo "  headless_exit=$run_status"

echo
echo "=== did it leave a session log behind? ==="
find "$DSH_HOME" -name "session*.jsonl*" 2>/dev/null | head -10 | sed 's/^/  /' || echo "  no session logs"
find "$WORK" -type f 2>/dev/null | head -10 | sed 's/^/  worktree: /'

echo
echo "=== tail of any log, which usually names the exact blocker ==="
latest=$(find "$DSH_HOME" -name "session*.jsonl" -o -name "session*.jsonl.zstd" 2>/dev/null | head -1)
if [ -n "${latest:-}" ]; then
  echo "  reading $latest"
  case "$latest" in
    *.zstd) zstd -dc "$latest" 2>/dev/null | tail -5 | sed 's/^/    /' ;;
    *) tail -5 "$latest" | sed 's/^/    /' ;;
  esac
else
  echo "  none produced"
fi

echo
echo "=== probe finished ==="
