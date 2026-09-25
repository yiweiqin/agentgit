#!/usr/bin/env bash
# Finish DSH setup: allow its native build scripts, then find how it expects credentials.
#
# pnpm 12 refuses to run install scripts unless they are allowlisted, and DSH ships two
# native modules (node-pty, koffi) that need compiling. Without this the CLI exists but
# the subprocess/terminal layer is broken, which shows up later as a tool failure rather
# than as an install failure -- an expensive way to learn about it.
#
# The second half prints *where* DSH looks for the API key. Reading that off the code is
# deliberate: guessing an env var name wastes a real API call on a 401.
set -uo pipefail

EXP_ROOT=/root/autodl-tmp/coord-exp
HOST="$EXP_ROOT/dsh-host"
cd "$HOST"

echo "=== 1. allowlist the native build scripts ==="
python3 - <<'PY'
import json
path = "package.json"
with open(path) as fh:
    pkg = json.load(fh)
allow = [
    "@deepseek-ai/dsh-subprocess-local",
    "@google/genai",
    "koffi",
    "node-pty",
    "protobufjs",
]
pkg.setdefault("pnpm", {})["onlyBuiltDependencies"] = allow
with open(path, "w") as fh:
    json.dump(pkg, fh, indent=2)
    fh.write("\n")
print("  allowlisted:", ", ".join(allow))
PY

echo
echo "=== 2. rebuild ==="
pnpm install 2>&1 | tail -15
echo "  pnpm_exit=$?"

echo
echo "=== 3. did the native modules actually build? ==="
for mod in node-pty koffi; do
  found=$(find node_modules/.pnpm -maxdepth 4 -type d -name "$mod" 2>/dev/null | head -1)
  if [ -n "$found" ]; then
    # A built native module has a .node binary; a skipped one does not.
    node_bin=$(find "$found" -name '*.node' 2>/dev/null | head -1)
    echo "  $mod: $([ -n "$node_bin" ] && echo "built ($(basename "$node_bin"))" || echo 'NO .node BINARY')"
  else
    echo "  $mod: not found"
  fi
done

echo
echo "=== 4. how does DSH expect credentials? ==="
echo "--- llm-related packages ---"
ls node_modules/@deepseek-ai | grep -iE 'llm|auth|credential|provider' | sed 's/^/  /'

echo
echo "--- env vars the deepseek llm plugin reads ---"
LLM_DIR=$(find node_modules/@deepseek-ai -maxdepth 1 -type d -name '*llm-deepseek*' | head -1)
echo "  package: ${LLM_DIR:-NOT FOUND}"
if [ -n "$LLM_DIR" ]; then
  grep -rhoE '\b[A-Z][A-Z0-9_]*API_KEY\b|\bDEEPSEEK[A-Z0-9_]*\b' "$LLM_DIR" 2>/dev/null | sort -u | head -20 | sed 's/^/    /'
  echo "  --- provider route ids ---"
  grep -rhoE 'deepseek-[a-z-]+' "$LLM_DIR" 2>/dev/null | sort -u | head -10 | sed 's/^/    /'
fi

echo
echo "--- dsh config surface ---"
"$HOST/node_modules/.bin/dsh" --help 2>&1 | grep -iE 'key|auth|login|config|provider' | head -15 | sed 's/^/    /'

echo
echo "--- existing ~/.dsh ---"
ls -la /root/.dsh 2>/dev/null | head -20 | sed 's/^/  /' || echo "  (no ~/.dsh yet)"
for f in /root/.dsh/config.json /root/.dsh/config.yml /root/.dsh/auth.json; do
  [ -f "$f" ] && echo "  --- $f ---" && head -c 1200 "$f" && echo
done

echo
echo "=== probe finished ==="
