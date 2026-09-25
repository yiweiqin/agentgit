#!/usr/bin/env bash
# Install the replay model into the headless profile and learn its configuration surface.
#
# A headless run needs a model. The plan wants `llm-replay` for deterministic arms anyway,
# so using it here means the integration check needs no API key, costs nothing, and is
# reproducible -- three properties a live-model smoke test would not have.
set -u

EXP_ROOT=/root/autodl-tmp/coord-exp
export PATH=/opt/node24/bin:$PATH
export DSH_HOME="$EXP_ROOT/dsh-home"
MIRROR=https://registry.npmmirror.com
PROFILE="$DSH_HOME/profiles/headless"
cd "$EXP_ROOT/dsh-host"

echo "=== the profile directory dsh created ==="
ls -la "$PROFILE" 2>/dev/null | sed 's/^/  /'
echo "  --- cordis.yml (bundle composition) ---"
head -30 "$PROFILE/cordis.yml" 2>/dev/null | sed 's/^/    /'

echo
echo "=== install llm-replay into the profile ==="
cd "$PROFILE"
[ -f .npmrc ] || printf 'registry=%s\n' "$MIRROR" >.npmrc
set +e
pnpm add "@deepseek-ai/dsh-llm-replay" 2>&1 | tail -15
echo "  add_exit=$?"
set -e

echo
echo "=== what does the replay package offer? ==="
REPLAY="$PROFILE/node_modules/@deepseek-ai/dsh-llm-replay"
if [ -d "$REPLAY" ]; then
  python3 -c "
import json
d = json.load(open('$REPLAY/package.json'))
print('  name:', d.get('name'), d.get('version'))
print('  dsh block:', json.dumps(d.get('dsh'), indent=2)[:400])
print('  peerDeps:', list((d.get('peerDependencies') or {}).keys()))
" 2>&1 | sed 's/^/  /'
  echo "  --- files ---"
  find "$REPLAY" -maxdepth 2 -type f | head -20 | sed 's/^/    /'
  if [ -f "$REPLAY/cordis.patch.yml" ]; then
    echo "  --- its cordis.patch.yml (shows the row id and config schema) ---"
    cat "$REPLAY/cordis.patch.yml" | sed 's/^/    /'
  fi
  if [ -f "$REPLAY/README.md" ]; then
    echo "  --- README (first 60 lines) ---"
    head -60 "$REPLAY/README.md" | sed 's/^/    /'
  fi
else
  echo "  replay package not present at $REPLAY"
fi

echo
echo "=== how does the llm row look now, and what config does replay take? ==="
if [ -f "$REPLAY/lib/types/index.d.ts" ]; then
  sed -n '1,80p' "$REPLAY/lib/types/index.d.ts" | sed 's/^/  /'
fi

echo
echo "=== probe finished ==="
