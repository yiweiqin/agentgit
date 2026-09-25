#!/usr/bin/env bash
# Reinstall DSH through a nearby registry.
#
# The first attempt was not CPU-bound: the npm process sat in ep_poll and its cache grew
# 1 MB in 20 seconds while it resolved metadata. Measured latency to registry.npmjs.org
# is ~2.5s per request against ~0.48s for registry.npmmirror.com, and @deepseek-ai/dsh
# pulls 72 direct dependencies plus their transitive trees. Thousands of metadata
# requests at 2.5s each is hours of wall clock, which is why it looked hung.
#
# pnpm is used rather than npm because its resolver is parallel and its store dedupes,
# which matters on a machine with 2 GiB of RAM and one usable core.
set -u

EXP_ROOT=/root/autodl-tmp/coord-exp
MIRROR=https://registry.npmmirror.com
DSH_VERSION=0.1.5-rc.1

export PATH=/opt/node24/bin:$PATH
hash -r

echo "=== stop the stalled npm install ==="
pkill -f "npm install" 2>/dev/null && echo "  signalled" || echo "  nothing to kill"
sleep 3
pkill -9 -f "npm install" 2>/dev/null || true
ps -eo pid,comm 2>/dev/null | grep -E '[n]pm' || echo "  no npm process remains"

echo
echo "=== does the mirror carry the scoped packages? ==="
for pkg in "@deepseek-ai%2Fdsh" "@deepseek-ai%2Fdsh-headless" "@deepseek-ai%2Fdsh-tools"; do
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "$MIRROR/$pkg")
  latency=$(curl -s -o /dev/null -w '%{time_total}s' --max-time 20 "$MIRROR/$pkg")
  echo "  $pkg -> $code ($latency)"
done

echo
echo "=== configure registries ==="
/opt/node24/bin/npm config set registry "$MIRROR" --global 2>/dev/null && echo "  npm registry -> $MIRROR"
cat >/root/.npmrc <<EOF
registry=$MIRROR
EOF
echo "  wrote /root/.npmrc"

echo
echo "=== install pnpm ==="
if command -v pnpm >/dev/null 2>&1; then
  echo "  already present: $(pnpm --version)"
else
  export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
  if corepack enable >/dev/null 2>&1; then
    corepack prepare pnpm@latest --activate >/dev/null 2>&1
  fi
  hash -r
  if ! command -v pnpm >/dev/null 2>&1; then
    /opt/node24/bin/npm install -g pnpm --registry "$MIRROR" 2>&1 | tail -5
  fi
  hash -r
fi
echo "  pnpm: $(command -v pnpm || echo missing) $(pnpm --version 2>/dev/null || true)"

echo
echo "=== install DSH via pnpm (pinned) ==="
mkdir -p "$EXP_ROOT/dsh-host"
cd "$EXP_ROOT/dsh-host"
cat >.npmrc <<EOF
registry=$MIRROR
node-linker=hoisted
EOF
# A hoisted node-linker keeps a conventional node_modules layout: the experiment loads
# plugins by path from outside this tree, and strict symlinked layouts make that fragile.

cat >package.json <<EOF
{
  "name": "coord-exp-host",
  "private": true,
  "version": "0.0.0",
  "description": "Pinned DSH host for the coordination-governor experiments."
}
EOF

start=$(date +%s)
set +e
pnpm add "@deepseek-ai/dsh@$DSH_VERSION" 2>&1 | tail -30
add_status=${PIPESTATUS[0]}
set -e
end=$(date +%s)
echo "pnpm_add_exit=$add_status"
echo "pnpm_add_seconds=$((end - start))"

echo
echo "=== what did we get? ==="
if [ -d node_modules/@deepseek-ai ]; then
  echo "  @deepseek-ai packages: $(ls node_modules/@deepseek-ai | wc -l)"
  ls node_modules/@deepseek-ai | head -40 | sed 's/^/    /'
else
  echo "  no @deepseek-ai packages present"
fi
echo "  total size: $(du -sm "$EXP_ROOT/dsh-host" 2>/dev/null | cut -f1) MB"

echo
echo "=== is there a runnable dsh entry point? ==="
ls -la node_modules/.bin/ 2>/dev/null | head -20 | sed 's/^/  /'
cat node_modules/@deepseek-ai/dsh/package.json 2>/dev/null | python3 -c '
import json, sys
try:
    d = json.load(sys.stdin)
    print("  name:", d.get("name"), d.get("version"))
    print("  bin:", d.get("bin"))
    print("  main:", d.get("main"))
except Exception as e:
    print("  could not read:", e)
'

echo
echo "=== memory / disk after ==="
echo "  memory.current: $(cat /sys/fs/cgroup/memory.current 2>/dev/null) bytes"
echo "  memory.events:  $(tr '\n' ' ' </sys/fs/cgroup/memory.events 2>/dev/null)"
df -h "$EXP_ROOT" | tail -1 | sed 's/^/  /'

echo
echo "=== provision-dsh finished ==="
