#!/usr/bin/env bash
# Make the plugin's host dependencies resolvable, then boot it for real.
#
# The failure just observed: `Cannot find package '@deepseek-ai/schemastery' imported from
# .../dsh-coord-governor/src/plugin.ts`. Two packaging facts combine to cause it, and both
# are worth stating because they constrain how this plugin can be deployed at all:
#
#  1. The profile installs the plugin as a pnpm `link:`, so the file the loader imports is
#     a symlink and Node resolves modules relative to its REALPATH -- a directory outside
#     any node_modules tree.
#  2. The symlink is also what makes the plugin work. Node refuses to strip types for
#     files under node_modules (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING, reproduced
#     above), so a plugin that ships raw .ts must be resolved from outside node_modules.
#     The two requirements together mean the plugin needs its own node_modules, linked
#     from outside, rather than inheriting the profile's.
set -u

EXP_ROOT=/root/autodl-tmp/coord-exp
export PATH=/opt/node24/bin:$PATH
export DSH_HOME="$EXP_ROOT/dsh-home"
PLUGIN="$EXP_ROOT/dsh-coord-governor"
HOST_MODULES="$EXP_ROOT/dsh-host/node_modules"

echo "=== give the plugin its own view of the host packages ==="
mkdir -p "$PLUGIN/node_modules"
if [ -e "$PLUGIN/node_modules/@deepseek-ai" ] || [ -L "$PLUGIN/node_modules/@deepseek-ai" ]; then
  rm -rf "$PLUGIN/node_modules/@deepseek-ai"
fi
# One scope-level symlink rather than 241 package symlinks: the plugin's peer deps are the
# host's own packages, so pointing at the host's scope directory keeps them at exactly the
# versions the profile boots and avoids a second resolution outcome.
ln -sfn "$HOST_MODULES/@deepseek-ai" "$PLUGIN/node_modules/@deepseek-ai"
ls -la "$PLUGIN/node_modules" | sed 's/^/  /'
echo "  resolves to: $(readlink -f "$PLUGIN/node_modules/@deepseek-ai")"
echo "  package count: $(ls "$PLUGIN/node_modules/@deepseek-ai" 2>/dev/null | wc -l)"

echo
echo "=== can node now import the plugin's entry point directly? ==="
cd "$PLUGIN"
set +e
node -e "
import('$PLUGIN/src/plugin.ts').then(
  (m) => console.log('  import OK; plugin name =', m.name, '| inject =', JSON.stringify(m.inject)),
  (e) => { console.log('  import FAILED:', e.code || '', String(e.message).split('\n')[0]) },
)
" 2>&1 | head -20 | sed 's/^/  /'
set -e

echo
echo "=== can the loader resolve it by name from the profile? ==="
cd "$DSH_HOME/profiles/headless"
node -e "
import('dsh-coord-governor').then(
  (m) => console.log('  profile import OK; name =', m.name),
  (e) => console.log('  profile import FAILED:', e.code || '', String(e.message).split('\n')[0]),
)
" 2>&1 | head -20 | sed 's/^/  /'

echo
echo "=== boot: does the plugin tree load now? ==="
cd "$EXP_ROOT/worktree-probe"
set +e
timeout 240 "$EXP_ROOT/dsh-host/node_modules/.bin/dsh" --profile headless "Create a file named probe.txt containing the word hello." 2>&1 | head -30 | sed 's/^/  /'
echo "  boot_exit=$?"
set -e

echo
echo "=== evidence the plugin initialised: its arm log line, and any ledger ==="
echo "  --- ledger directory ---"
ls -la "$EXP_ROOT/ledgers" 2>/dev/null | sed 's/^/    /' || echo "    (none)"
if [ -f "$EXP_ROOT/ledgers/A1-instrument.jsonl" ]; then
  echo "  --- ledger contents ---"
  wc -l <"$EXP_ROOT/ledgers/A1-instrument.jsonl" | sed 's/^/    lines: /'
  head -5 "$EXP_ROOT/ledgers/A1-instrument.jsonl" | sed 's/^/    /'
fi

echo
echo "  --- newest session log: did the governor announce its arm? ---"
latest=$(find "$DSH_HOME/sessions" -name "session*.zstd" -o -name "session*.jsonl" 2>/dev/null | sort | tail -1)
if [ -n "${latest:-}" ]; then
  echo "    $latest"
  case "$latest" in
    *.zstd) zstd -dc "$latest" 2>/dev/null | grep -c "coord-governor" | sed 's/^/    coord-governor mentions: /' ;;
    *) grep -c "coord-governor" "$latest" 2>/dev/null | sed 's/^/    coord-governor mentions: /' ;;
  esac
fi

echo
echo "=== fix finished ==="
