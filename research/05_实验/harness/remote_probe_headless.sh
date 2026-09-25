#!/usr/bin/env bash
# Get a bootable profile and find out whether a replay model can stand in for the API.
#
# The plugin cannot be validated without a session, and a session needs a model. The plan
# wants llm-replay for determinism regardless, so if it is installable it solves both
# problems at once and no API key is needed for integration checks.
set -u

EXP_ROOT=/root/autodl-tmp/coord-exp
export PATH=/opt/node24/bin:$PATH
export DSH_HOME="$EXP_ROOT/dsh-home"
MIRROR=https://registry.npmmirror.com
cd "$EXP_ROOT/dsh-host"

echo "=== is dsh-llm-replay published? ==="
for pkg in "@deepseek-ai%2Fdsh-llm-replay" "@deepseek-ai%2Fdsh-compaction-basic"; do
  code=$(curl -s -o /tmp/r.json -w '%{http_code}' --max-time 20 "$MIRROR/$pkg")
  if [ "$code" = "200" ]; then
    latest=$(python3 -c "
import json
d = json.load(open('/tmp/r.json'))
print(d.get('dist-tags', {}).get('latest', '?'))
" 2>/dev/null)
    echo "  $pkg -> 200 latest=$latest"
  else
    echo "  $pkg -> HTTP $code"
  fi
done

echo
echo "=== why is it missing from node_modules? ==="
# It is declared as a dependency of @deepseek-ai/dsh, so its absence is either an
# optional-dependency rule or a failed fetch. The lockfile answers this directly.
grep -n "dsh-llm-replay" pnpm-lock.yaml 2>/dev/null | head -10 | sed 's/^/  /' || echo "  not in lockfile"
ls node_modules/@deepseek-ai/ | grep -i replay | sed 's/^/  installed: /' || echo "  not installed"

echo
echo "=== create a headless profile ==="
mkdir -p "$DSH_HOME"
ls "$DSH_HOME/profiles" 2>/dev/null | sed 's/^/  existing profile: /' || echo "  no profiles yet"

if [ ! -d "$DSH_HOME/profiles/headless" ]; then
  set +e
  # Booting is not wanted here: --dump-config composes the tree and exits, which shows
  # whether the profile machinery works without needing a model or credentials.
  ./node_modules/.bin/dsh --profile headless --from-default-profile headless --dump-config 2>&1 | head -40 | sed 's/^/  /'
  echo "  create_exit=$?"
  set -e
fi

echo
echo "=== does the profile now compose? ==="
set +e
./node_modules/.bin/dsh --profile headless --dump-config 2>&1 | head -60 | sed 's/^/  /'
echo "  dump_exit=$?"
set -e

echo
echo "=== profile layout on disk ==="
find "$DSH_HOME" -maxdepth 3 2>/dev/null | head -30 | sed 's/^/  /'

echo
echo "=== what does the profile's own patch look like? ==="
for f in "$DSH_HOME/profiles/headless/cordis.patch.yml" "$DSH_HOME/profiles/headless/package.json"; do
  if [ -f "$f" ]; then
    echo "  --- $f ---"
    head -40 "$f" | sed 's/^/    /'
  fi
done

echo
echo "=== probe finished ==="
