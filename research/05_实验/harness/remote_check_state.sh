#!/usr/bin/env bash
# Find out what state the machine is in after the hung mount attempt.
#
# The previous attempt hung because a booting DSH process was piped into `head`: `timeout`
# killed the parent, but its worker threads kept the stdout pipe open, so the pipeline
# never closed. Nothing here pipes a DSH boot into another command -- everything goes to a
# file first, and every write is bounded.
set -uo pipefail

EXP_ROOT=/root/autodl-tmp/coord-exp
HOST="$EXP_ROOT/dsh-host"

echo "=== 1. stray dsh processes from the hung attempt ==="
ps -eo pid,etime,cmd | grep -E '[d]sh|[c]ordis' | head -20 | sed 's/^/  /' || echo "  none"
for pid in $(pgrep -f 'dsh.*headless' 2>/dev/null); do
  echo "  killing $pid"
  kill -9 "$pid" 2>/dev/null || true
done
sleep 1
echo "  remaining: $(pgrep -fc 'dsh.*headless' 2>/dev/null || echo 0)"

echo
echo "=== 2. where do profile artifacts actually live? ==="
echo "  ~/.dsh:"
find /root/.dsh -maxdepth 3 2>/dev/null | sort | head -30 | sed 's/^/    /'
echo "  profiles dir: $(ls /root/.dsh/profiles 2>/dev/null | tr '\n' ' ' || echo NONE)"
echo "  experiment DSH_HOME ($EXP_ROOT/dsh-home):"
find "$EXP_ROOT/dsh-home" -maxdepth 3 2>/dev/null | sort | head -30 | sed 's/^/    /' || echo "    (absent)"

echo
echo "=== 3. the successful run's session log ==="
LOG=$(find /root/.dsh/sessions -name 'session*.jsonl.zstd' 2>/dev/null | sort | tail -1)
echo "  newest: ${LOG:-NONE}"
if [ -n "$LOG" ]; then
  echo "  size: $(stat -c %s "$LOG") bytes"
  echo "  --- first turns (this is the E0 cross-validation source) ---"
  zstd -dc "$LOG" 2>/dev/null | head -c 2000 | sed 's/^/    /'
  echo
fi

echo
echo "=== 4. plugin link state ==="
PLUGIN="$EXP_ROOT/dsh-coord-governor"
echo "  plugin dir: $([ -d "$PLUGIN" ] && echo present || echo MISSING)"
echo "  node_modules/@deepseek-ai -> $(readlink -f "$PLUGIN/node_modules/@deepseek-ai" 2>/dev/null || echo 'not linked')"
echo "  schemastery visible: $([ -d "$PLUGIN/node_modules/@deepseek-ai/schemastery" ] && echo yes || echo NO)"

echo
echo "=== 5. does the host resolve the plugin by absolute path? ==="
# If the loader accepts a filesystem path as a plugin `name`, the whole profile-mutation
# dance is unnecessary: --patch can point straight at it. Worth knowing before building
# an install step that exists only because a package name was assumed to be required.
cd "$HOST"
cat > /tmp/pathprobe.mjs <<'JS'
const spec = process.argv[2]
try {
  const mod = await import(spec)
  console.log('  import OK; exports:', Object.keys(mod).slice(0, 10).join(', '))
} catch (error) {
  console.log('  import FAILED:', error.code || '', String(error.message).split('\n')[0])
}
JS
echo "  by bare name:"
node /tmp/pathprobe.mjs "dsh-coord-governor" 2>&1 | head -5 | sed 's/^/    /'
echo "  by absolute path:"
node /tmp/pathprobe.mjs "$PLUGIN/src/index.ts" 2>&1 | head -5 | sed 's/^/    /'

echo
echo "=== 6. does the CLI accept --patch, and what does a patch row look like? ==="
cd "$HOST"
./node_modules/.bin/dsh --help 2>&1 | grep -A3 -- '--patch' | sed 's/^/  /'

echo
echo "=== state check finished ==="
