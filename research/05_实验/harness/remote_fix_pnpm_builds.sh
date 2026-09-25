#!/usr/bin/env bash
# Complete the DSH install after pnpm's build-script gate blocked it.
#
# Two distinct failures were stacked here, and only the first is visible:
#   1. pnpm 12 stopped reading the `pnpm` field in package.json, so the allowlist written
#      there was silently ignored -- the warning is easy to read as a cosmetic deprecation
#      notice when it is actually the reason the install keeps failing.
#   2. Because the install aborts, node_modules/@deepseek-ai is left with only `dsh`. The
#      CLI binary exists, so the tree *looks* installed until something imports a plugin
#      package that was never linked.
#
# pnpm >= 10 keeps these settings in pnpm-workspace.yaml, which is also the file
# `pnpm approve-builds` would write. Writing it directly keeps this non-interactive.
set -uo pipefail

EXP_ROOT=/root/autodl-tmp/coord-exp
HOST="$EXP_ROOT/dsh-host"
cd "$HOST"

echo "=== 1. move the allowlist to where pnpm 12 actually reads it ==="
python3 - <<'PY'
import json
with open("package.json") as fh:
    pkg = json.load(fh)
# Drop the field pnpm now ignores, so it cannot mask the real config.
if "pnpm" in pkg:
    del pkg["pnpm"]
    print("  removed the ignored package.json 'pnpm' field")
with open("package.json", "w") as fh:
    json.dump(pkg, fh, indent=2)
    fh.write("\n")
PY
cat > pnpm-workspace.yaml <<'EOF'
onlyBuiltDependencies:
  - '@deepseek-ai/dsh-subprocess-local'
  - '@google/genai'
  - koffi
  - node-pty
  - protobufjs
EOF
echo "  wrote pnpm-workspace.yaml:"
sed 's/^/    /' pnpm-workspace.yaml

echo
echo "=== 2. reinstall ==="
pnpm install 2>&1 | tail -20
echo "  pnpm_exit=$?"

echo
echo "=== 3. is the @deepseek-ai tree complete now? ==="
if [ -d node_modules/@deepseek-ai ]; then
  count=$(ls node_modules/@deepseek-ai | wc -l)
  echo "  packages: $count"
  ls node_modules/@deepseek-ai | sed 's/^/    /'
else
  echo "  MISSING"
fi

echo
echo "=== 4. native modules ==="
for mod in node-pty koffi; do
  d=$(find node_modules/.pnpm -maxdepth 3 -type d -name "$mod" 2>/dev/null | head -1)
  if [ -n "$d" ]; then
    n=$(find "$d" -name '*.node' 2>/dev/null | head -1)
    echo "  $mod: $([ -n "$n" ] && echo "built -> $(basename "$n")" || echo 'no .node binary')"
  else
    echo "  $mod: not found"
  fi
done

echo
echo "=== 5. locate the credential path ==="
echo "  --- dsh plugins mentioning llm/auth/credential ---"
find node_modules -maxdepth 4 -type d \( -name '*llm*' -o -name '*credential*' -o -name '*auth*' \) 2>/dev/null | grep -i deepseek | head -10 | sed 's/^/    /'

echo
echo "  --- default profile composition (base plugins) ---"
"$HOST/node_modules/.bin/dsh" --dump-default-config 2>&1 | head -60 | sed 's/^/    /'

echo
echo "=== fix finished ==="
