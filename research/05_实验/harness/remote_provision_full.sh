#!/usr/bin/env bash
# Provision the experimental machine end to end.
#
# Runs on: Ubuntu 22.04 container, 16-CPU cgroup quota, 62 GiB memory cap, no python3.
#
# Ordering is forced by the image: the Node version is resolved from a JSON index, so
# python3 has to exist before the Node step. Doing it the other way round leaves a
# half-provisioned box and an error that points at the wrong subsystem.
set -uo pipefail

EXP_ROOT=/root/autodl-tmp/coord-exp
NODE_PREFIX=/opt/node24
DSH_VERSION=0.1.5-rc.1

echo "=== 1. apt packages ==="
export DEBIAN_FRONTEND=noninteractive
# python3 is absent from this image, which is unusual enough that it is worth stating:
# several later steps assume it, and its absence otherwise surfaces as a confusing
# "command not found" deep inside the Node version resolution.
apt-get update -qq 2>&1 | tail -3
apt-get install -y -qq --no-install-recommends \
  python3 curl ca-certificates tar xz-utils zstd git build-essential procps 2>&1 | tail -5
echo "  python3: $(python3 --version 2>&1 || echo STILL-MISSING)"
echo "  git:     $(git --version 2>&1)"
echo "  zstd:    $(zstd --version 2>&1 | head -1)"

echo
echo "=== 2. node v24 ==="
if [ -x "$NODE_PREFIX/bin/node" ]; then
  echo "  already present: $($NODE_PREFIX/bin/node --version)"
else
  version=$(curl -s --max-time 30 https://nodejs.org/dist/index.json | python3 -c '
import json, sys
data = json.load(sys.stdin)
v24 = [d["version"] for d in data if d["version"].startswith("v24.")]
print(v24[0] if v24 else "")
')
  if [ -z "$version" ]; then
    echo "  could not resolve a v24 release; falling back to a known-good pin"
    version=v24.21.0
  fi
  echo "  selected $version"
  tarball="node-$version-linux-x64.tar.xz"
  curl -# -L --max-time 900 -o "/tmp/$tarball" "https://nodejs.org/dist/$version/$tarball" 2>&1 | tail -2
  mkdir -p "$NODE_PREFIX"
  tar -xJf "/tmp/$tarball" -C "$NODE_PREFIX" --strip-components=1
  rm -f "/tmp/$tarball"
  for bin in node npm npx corepack; do
    [ -e "$NODE_PREFIX/bin/$bin" ] && ln -sf "$NODE_PREFIX/bin/$bin" "/usr/local/bin/$bin"
  done
fi
hash -r
echo "  node: $(node --version)"

echo
echo "=== 3. pnpm ==="
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
if corepack enable >/dev/null 2>&1 && corepack prepare pnpm@latest --activate >/dev/null 2>&1; then
  echo "  pnpm (corepack): $(pnpm --version 2>/dev/null || echo failed)"
else
  echo "  corepack failed, using npm -g"
  npm install -g pnpm >/dev/null 2>&1 && echo "  pnpm: $(pnpm --version)"
fi
hash -r
echo "  pnpm: $(command -v pnpm || echo missing)"

echo
echo "=== 4. experiment root ==="
mkdir -p "$EXP_ROOT"
echo "  $EXP_ROOT  free=$(df -h "$EXP_ROOT" | tail -1 | awk '{print $4}')"
# A registry that is reachable from here. The default npmjs endpoint was the single
# biggest source of wall-clock time on the previous machine, and this is a mirror, not a
# different artifact store: same tarballs, same integrity hashes.
cd "$EXP_ROOT"
cat > .npmrc <<'EOF'
registry=https://registry.npmmirror.com
EOF
echo "  registry: $(grep registry .npmrc | cut -d= -f2)"

echo
echo "=== 5. dsh ==="
mkdir -p dsh-host
cd dsh-host
[ -f package.json ] || npm init -y >/dev/null 2>&1
echo "  installing @deepseek-ai/dsh@$DSH_VERSION ..."
pnpm add --silent "@deepseek-ai/dsh@$DSH_VERSION" 2>&1 | tail -12
echo "  pnpm_exit=$?"

echo
echo "=== 6. result ==="
if [ -d node_modules/@deepseek-ai ]; then
  ls node_modules/@deepseek-ai | sed 's/^/  /'
else
  echo "  NO @deepseek-ai packages present"
fi
echo "  dsh binary: $([ -x node_modules/.bin/dsh ] && echo present || echo missing)"
echo "  disk: $(df -h "$EXP_ROOT" | tail -1 | awk '{print $4}') free"
echo
echo "=== provision-full finished ==="
