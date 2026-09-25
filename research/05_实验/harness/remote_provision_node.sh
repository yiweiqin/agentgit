#!/usr/bin/env bash
# Install the Node v24 toolchain and DSH.
#
# The distro ships Node v12.22.9 and DSH requires ^22.19 or >=24, so the stock Node is
# unusable. The tarball from nodejs.org is used rather than the NodeSource apt repo:
# it is one download instead of an apt transaction, which matters on a machine with
# roughly one usable core.
#
# DSH is installed from npm rather than built from the deepseek-harness monorepo.
# Compiling that monorepo under a 2 GiB cap risks the OOM killer, and the published
# packages exist (checked) so there is no reason to pay that cost.
set -euo pipefail

NODE_PREFIX=/opt/node24
EXP_ROOT=/root/autodl-tmp/coord-exp

echo "=== disk before ==="
df -h / | tail -1

if [ -x "$NODE_PREFIX/bin/node" ]; then
  echo "node already installed: $($NODE_PREFIX/bin/node --version)"
else
  echo
  echo "=== resolving newest v24 ==="
  version=$(curl -s --max-time 30 https://nodejs.org/dist/index.json |
    python3 -c '
import json, sys
data = json.load(sys.stdin)
v24 = [d["version"] for d in data if d["version"].startswith("v24.")]
print(v24[0] if v24 else "")
')
  if [ -z "$version" ]; then
    echo "could not resolve a v24 release; aborting"
    exit 1
  fi
  echo "  selected $version"

  echo
  echo "=== downloading ==="
  tarball="node-$version-linux-x64.tar.xz"
  curl -# -L --max-time 600 -o "/tmp/$tarball" "https://nodejs.org/dist/$version/$tarball"
  ls -lh "/tmp/$tarball"

  echo
  echo "=== extracting to $NODE_PREFIX ==="
  mkdir -p "$NODE_PREFIX"
  tar -xJf "/tmp/$tarball" -C "$NODE_PREFIX" --strip-components=1
  rm -f "/tmp/$tarball"

  echo
  echo "=== linking into /usr/local/bin ==="
  for bin in node npm npx corepack; do
    if [ -e "$NODE_PREFIX/bin/$bin" ]; then
      ln -sf "$NODE_PREFIX/bin/$bin" "/usr/local/bin/$bin"
    fi
  done
fi

echo
echo "=== verify node ==="
hash -r
echo "  node: $(command -v node) $(node --version)"
echo "  npm:  $(npm --version)"

echo
echo "=== pnpm via corepack ==="
# corepack ships with Node and pins pnpm per project, but a global activation is simpler
# for a disposable experiment box.
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
if corepack enable >/dev/null 2>&1 && corepack prepare pnpm@latest --activate >/dev/null 2>&1; then
  echo "  pnpm (corepack): $(pnpm --version 2>/dev/null || echo failed)"
else
  echo "  corepack path failed, falling back to npm -g pnpm"
  npm install -g pnpm >/dev/null 2>&1 && echo "  pnpm (npm): $(pnpm --version)"
fi
hash -r
echo "  pnpm: $(command -v pnpm || echo missing) $(pnpm --version 2>/dev/null || true)"

echo
echo "=== experiment root ==="
mkdir -p "$EXP_ROOT"
echo "  $EXP_ROOT ($(df -h "$EXP_ROOT" | tail -1 | awk '{print $4}') free)"

echo
echo "=== install DSH from npm ==="
# Pinned, because a v0.1 preview that reserves the right to break means an unpinned
# install silently changes the host between rounds and invalidates the comparison.
DSH_VERSION=0.1.5-rc.1
cd "$EXP_ROOT"
if [ ! -d dsh-host ]; then
  mkdir -p dsh-host
fi
cd dsh-host
if [ ! -f package.json ]; then
  npm init -y >/dev/null 2>&1
fi
set +e
npm install --no-audit --no-fund "@deepseek-ai/dsh@$DSH_VERSION" 2>&1 | tail -25
install_status=${PIPESTATUS[0]}
set -e
echo "npm_install_exit=$install_status"

echo
echo "=== what did we get? ==="
if [ -d node_modules/@deepseek-ai ]; then
  ls node_modules/@deepseek-ai | sed 's/^/  /'
else
  echo "  no @deepseek-ai packages present"
fi

echo
echo "=== memory after install ==="
echo "  memory.current: $(cat /sys/fs/cgroup/memory.current 2>/dev/null)"
echo "  memory.events:  $(tr '\n' ' ' </sys/fs/cgroup/memory.events 2>/dev/null)"

echo
echo "=== disk after ==="
df -h "$EXP_ROOT" | tail -1

echo
echo "=== provision-node finished ==="
