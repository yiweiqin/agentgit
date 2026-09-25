#!/usr/bin/env bash
# Approve and run the native build scripts pnpm skipped.
#
# pnpm refuses to run install scripts for dependencies it has not been told to trust,
# and reported this as ERR_PNPM_IGNORED_BUILDS while still exiting non-zero. The skipped
# set includes @deepseek-ai/dsh-subprocess-local (the provider that spawns processes),
# node-pty (terminal), and koffi (FFI) -- without these, a session can start and then
# fail the moment it tries to run a command, which would look like a plugin bug.
#
# Approving by name in package.json rather than via the interactive `pnpm approve-builds`
# keeps this reproducible and reviewable, which matters because the allowlist is a
# supply-chain decision: each name here is a package permitted to execute code at install.
set -u

EXP_ROOT=/root/autodl-tmp/coord-exp
MIRROR=https://registry.npmmirror.com
export PATH=/opt/node24/bin:$PATH
cd "$EXP_ROOT/dsh-host"
hash -r

echo "=== build toolchain present? ==="
missing=""
for tool in make g++ cc python3; do
  if command -v "$tool" >/dev/null 2>&1; then
    printf '  %-8s %s\n' "$tool" "ok ($(command -v "$tool"))"
  else
    printf '  %-8s %s\n' "$tool" "MISSING"
    missing="$missing $tool"
  fi
done

if [ -n "$missing" ]; then
  echo
  echo "=== installing build-essential (missing:$missing) ==="
  export DEBIAN_FRONTEND=noninteractive
  apt-get -qq update >/tmp/apt-update.log 2>&1 && echo "  apt update: ok" || echo "  apt update: FAILED"
  apt-get -qq install -y build-essential >/tmp/apt-build.log 2>&1 && echo "  install: ok" || {
    echo "  install: FAILED"
    tail -20 /tmp/apt-build.log
  }
fi

echo
echo "=== what the packages are (so the allowlist is justified, not copy-pasted) ==="
for pkg in @deepseek-ai/dsh-subprocess-local @google/genai koffi node-pty protobufjs; do
  pkgjson="node_modules/$pkg/package.json"
  if [ -f "$pkgjson" ]; then
    python3 - "$pkg" "$pkgjson" <<'PY'
import json, sys
pkg, path = sys.argv[1], sys.argv[2]
try:
    d = json.load(open(path))
    scripts = d.get("scripts", {})
    interesting = {k: v for k, v in scripts.items() if k in ("install", "postinstall", "preinstall")}
    print(f"  {pkg}@{d.get('version')}")
    if interesting:
        for k, v in interesting.items():
            print(f"      {k}: {v}")
    else:
        print("      (no install-time scripts)")
except Exception as e:
    print(f"  {pkg}: could not read ({e})")
PY
  else
    echo "  $pkg: not installed"
  fi
done

echo
echo "=== approve builds by name ==="
python3 - <<'PY'
import json

allowed = [
    "@deepseek-ai/dsh-subprocess-local",  # spawns local subprocesses for tool execution
    "@google/genai",                       # ships a postinstall that fetches/generates assets
    "koffi",                               # FFI native binary
    "node-pty",                            # terminal pseudo-console
    "protobufjs",                          # regenerates protobuf runtime
]

path = "package.json"
d = json.load(open(path))
d.setdefault("pnpm", {})["onlyBuiltDependencies"] = allowed
json.dump(d, open(path, "w"), indent=2)
print(f"  wrote pnpm.onlyBuiltDependencies with {len(allowed)} entries")
PY

echo
echo "=== reinstall so the approved scripts run ==="
start=$(date +%s)
set +e
pnpm install 2>&1 | tail -30
install_status=${PIPESTATUS[0]}
set -e
end=$(date +%s)
echo "pnpm_install_exit=$install_status"
echo "pnpm_install_seconds=$((end - start))"

echo
echo "=== did the native modules actually materialise? ==="
find node_modules -name "*.node" 2>/dev/null | grep -E "node-pty|koffi|subprocess" | head -10 | sed 's/^/  /'
echo "  total .node files: $(find node_modules -name '*.node' 2>/dev/null | wc -l)"

echo
echo "=== can node load the risky ones? ==="
for mod in node-pty koffi; do
  out=$(node -e "const m=require('$mod'); console.log('loaded ok')" 2>&1 | head -3)
  echo "  $mod: $out"
done

echo
echo "=== does the dsh binary respond? ==="
./node_modules/.bin/dsh --version 2>&1 | head -5 | sed 's/^/  /'
echo "  --- help ---"
./node_modules/.bin/dsh --help 2>&1 | head -40 | sed 's/^/  /'

echo
echo "=== resources after ==="
echo "  memory.current: $(cat /sys/fs/cgroup/memory.current 2>/dev/null) bytes"
echo "  memory.events:  $(tr '\n' ' ' </sys/fs/cgroup/memory.events 2>/dev/null)"
echo "  host size: $(du -sm "$EXP_ROOT/dsh-host" 2>/dev/null | cut -f1) MB"

echo
echo "=== provision-builds finished ==="
