#!/usr/bin/env bash
# Survey the installed DSH for the pieces the experiment needs: a headless profile, a
# replay model (so validation needs no API key and is deterministic), and the plugin
# loading mechanism.
set -u

EXP_ROOT=/root/autodl-tmp/coord-exp
export PATH=/opt/node24/bin:$PATH
export DSH_HOME="$EXP_ROOT/dsh-home"
cd "$EXP_ROOT/dsh-host"

echo "=== replay / headless / profile-related packages ==="
ls node_modules/@deepseek-ai | grep -iE "replay|headless|profile|mock|stub|test" | sed 's/^/  /'

echo
echo "=== anything mentioning replay anywhere in the tree ==="
grep -rl "llm-replay" node_modules/@deepseek-ai --include=package.json 2>/dev/null | head -10 | sed 's/^/  /'
find node_modules/@deepseek-ai -maxdepth 1 -name "*replay*" 2>/dev/null | sed 's/^/  /'

echo
echo "=== where does DSH_HOME default to, and what profiles ship? ==="
echo "  DSH_HOME env now: ${DSH_HOME:-<unset>}"
ls -la "$DSH_HOME" 2>/dev/null | sed 's/^/  /' || echo "  (not created yet)"

echo
echo "=== default profile list (from the shipped bundles) ==="
./node_modules/.bin/dsh --help 2>&1 | grep -iE "profile" | head -5 | sed 's/^/  /'

echo
echo "=== dump the shipped profile tree (headless) ==="
export DSH_HOME="$EXP_ROOT/dsh-home"
mkdir -p "$DSH_HOME"
set +e
./node_modules/.bin/dsh --dump-default-config 2>&1 | head -80 | sed 's/^/  /'
echo "  dump_exit=$?"
set -e

echo
echo "=== search the package tree for the profile templates ==="
find node_modules/@deepseek-ai -type d -name "profiles" 2>/dev/null | head -5 | sed 's/^/  /'
find node_modules/@deepseek-ai -name "*.yml" -path "*profile*" 2>/dev/null | head -20 | sed 's/^/  /'
find node_modules/@deepseek-ai/dsh-base -maxdepth 2 -type d 2>/dev/null | head -20 | sed 's/^/  /'

echo
echo "=== how does a profile declare plugins? (find a shipped patch/overlay) ==="
find node_modules/@deepseek-ai -name "*.yml" 2>/dev/null | head -30 | sed 's/^/  /'

echo
echo "=== probe finished ==="
