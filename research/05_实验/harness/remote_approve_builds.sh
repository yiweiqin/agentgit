#!/usr/bin/env bash
# Run the install scripts npm gated, then report the model surface.
#
# npm 11+ has its own allowScripts gate, so switching away from pnpm did not remove this
# obstacle -- it just changed the error into a warning. Two of these scripts build things
# DSH genuinely needs:
#   koffi                        -> native FFI, no .node binary means the module cannot load
#   dsh-subprocess-local         -> installs a spawn helper the subprocess layer execs
# The others are lower risk, but leaving a half-built node_modules behind invites a
# "works until it doesn't" debugging session later, so all five get built.
set -uo pipefail

EXP_ROOT=/root/autodl-tmp/coord-exp
HOST="$EXP_ROOT/dsh-host"
cd "$HOST"

echo "=== 1. what does npm offer? ==="
npm install-scripts --help 2>&1 | head -25 | sed 's/^/  /'
echo "  --- current state ---"
npm install-scripts ls 2>&1 | head -30 | sed 's/^/  /'

echo
echo "=== 2. approve and build ==="
# `approve` records the package in package.json; build scripts then run. If the
# subcommand shape differs across npm versions, fall back to running them directly.
for pkg in koffi node-pty protobufjs "@deepseek-ai/dsh-subprocess-local" "@google/genai"; do
  out=$(npm install-scripts approve "$pkg" 2>&1 | tail -3)
  echo "  approve $pkg -> $(echo "$out" | head -1)"
done

echo
echo "=== 3. rebuild the native ones ==="
npm rebuild koffi node-pty 2>&1 | tail -8 | sed 's/^/  /'

echo
echo "=== 4. verify the binaries exist ==="
for mod in node-pty koffi protobufjs; do
  n=$(find "node_modules/$mod" -name '*.node' 2>/dev/null | head -1)
  echo "  $mod: $([ -n "$n" ] && echo "built -> $n" || echo 'still missing')"
done
echo "  spawn helper (dsh-subprocess-local):"
find node_modules/@deepseek-ai/dsh-subprocess-local -name '*spawn*' -o -name '*.node' 2>/dev/null | head -5 | sed 's/^/    /'

echo
echo "=== 5. model surface (so the run uses a real id) ==="
grep -rhoE '"deepseek-[a-z0-9.-]+"' node_modules/@deepseek-ai/dsh-llm-deepseek/lib/index.js 2>/dev/null | sort -u | head -20 | sed 's/^/  /'
echo "  --- route ids ---"
grep -rhoE "'deepseek-official'|deepseek-official" node_modules/@deepseek-ai/dsh-llm-deepseek/lib/index.js 2>/dev/null | sort -u | head -3 | sed 's/^/  /'

echo
echo "=== 6. headless profile exists? ==="
ls node_modules/@deepseek-ai/dsh-headless/ 2>/dev/null | head -20 | sed 's/^/  /'

echo
echo "=== builds finished ==="
