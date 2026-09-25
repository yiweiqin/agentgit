#!/usr/bin/env bash
# Reinstall DSH with npm instead of pnpm, then locate the credential surface.
#
# Why abandon pnpm here: pnpm 12 gates every install script behind an allowlist whose
# config location has moved twice (package.json `pnpm` field -> pnpm-workspace.yaml), and
# neither was honoured on this version. The failure mode is nasty because it is *partial*:
# the full dependency tree lands in node_modules/.pnpm and the `dsh` binary appears, so the
# tree looks installed, while node_modules/@deepseek-ai contains only `dsh` and every
# plugin import fails later at runtime. npm runs lifecycle scripts by default and produced
# a working tree, so the remaining question -- "does this host run a session?" -- stops
# being entangled with a package-manager config goose chase.
set -uo pipefail

EXP_ROOT=/root/autodl-tmp/coord-exp
HOST="$EXP_ROOT/dsh-host"
cd "$HOST"

echo "=== 0. what pnpm 12 actually wanted (recorded, not acted on) ==="
pnpm install --help 2>&1 | grep -iE 'allow-build|only-built|ignore-scripts' | head -10 | sed 's/^/  /'

echo
echo "=== 1. clean pnpm state and install with npm ==="
rm -rf node_modules pnpm-lock.yaml pnpm-workspace.yaml
cat > .npmrc <<'EOF'
registry=https://registry.npmmirror.com
EOF
npm install --no-audit --no-fund "@deepseek-ai/dsh@0.1.5-rc.1" 2>&1 | tail -14
echo "  npm_exit=$?"

echo
echo "=== 2. @deepseek-ai tree ==="
if [ -d node_modules/@deepseek-ai ]; then
  echo "  count: $(ls node_modules/@deepseek-ai | wc -l)"
  ls node_modules/@deepseek-ai | sed 's/^/    /'
else
  echo "  MISSING"
fi

echo
echo "=== 3. native modules ==="
for mod in node-pty koffi; do
  n=$(find "node_modules/$mod" -name '*.node' 2>/dev/null | head -1)
  echo "  $mod: $([ -n "$n" ] && echo "built -> $(basename "$n")" || echo 'no .node binary')"
done

echo
echo "=== 4. credential surface of dsh-llm-deepseek ==="
LLM=$(find node_modules/@deepseek-ai -maxdepth 1 -type d -name 'dsh-llm-deepseek' | head -1)
echo "  package: ${LLM:-NOT FOUND}"
if [ -n "$LLM" ]; then
  echo "  --- files ---"
  find "$LLM" -maxdepth 2 -type f | head -20 | sed 's/^/    /'
  echo "  --- KEY/TOKEN/SECRET identifiers ---"
  grep -rhoE '[A-Z][A-Z0-9_]{2,}' "$LLM" 2>/dev/null | sort -u |
    grep -E 'KEY|TOKEN|SECRET|CREDENTIAL|AUTH' | head -25 | sed 's/^/    /'
  echo "  --- provider route ids ---"
  grep -rhoE '[a-z0-9-]*deepseek[a-z0-9-]*' "$LLM" 2>/dev/null | sort -u | head -15 | sed 's/^/    /'
fi

echo
echo "=== 5. does the CLI run at all? ==="
node_modules/.bin/dsh --version 2>&1 | head -5 | sed 's/^/  /'

echo
echo "=== install finished ==="
