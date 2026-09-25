#!/usr/bin/env bash
# Mount the coordination governor into the headless profile on this machine.
#
# Three things from the previous machine shape this:
#   1. The plugin ships raw .ts and relies on Node's type stripping, which Node refuses
#      inside node_modules. So it must be reached by a path outside node_modules, which
#      is how a local-path install resolves -- and that in turn breaks resolution of its
#      @deepseek-ai peer deps, which is why it needs its own node_modules link.
#   2. `arm` and `ledgerPath` live in the profile patch layer, not in the run command.
#      A run's ledger has to be attributable to exactly one arm without trusting a label
#      passed alongside it, and two arms must never append to the same file.
#   3. Whether the profile directory pre-exists decides whether this can be set up before
#      the first boot, so it is checked rather than assumed.
set -uo pipefail

EXP_ROOT=/root/autodl-tmp/coord-exp
HOST="$EXP_ROOT/dsh-host"
export PATH=/opt/node24/bin:$PATH
MIRROR=https://registry.npmmirror.com

echo "=== A. what the successful run left in ~/.dsh ==="
find /root/.dsh -maxdepth 4 2>/dev/null | sort | head -50 | sed 's/^/  /'
echo "  profiles: $(ls /root/.dsh/profiles 2>/dev/null | tr '\n' ' ' || echo NONE)"

echo
echo "=== B. plugin source present on the machine ==="
find "$EXP_ROOT/dsh-coord-governor" -type f | sort | sed 's/^/  /'
echo "  --- declared entry points ---"
python3 - <<'PY'
import json
with open("/root/autodl-tmp/coord-exp/dsh-coord-governor/package.json") as fh:
    p = json.load(fh)
for k in ("name", "version", "type", "main", "exports"):
    if k in p:
        print(f"    {k}: {p[k]}")
print("    peerDependencies:", p.get("peerDependencies"))
print("    dependencies:", p.get("dependencies"))
PY

echo
echo "=== C. give the plugin a view of the host's @deepseek-ai packages ==="
# Without this, importing '@deepseek-ai/schemastery' from the plugin's real path fails,
# because that path is outside the host's node_modules tree.
PLUGIN="$EXP_ROOT/dsh-coord-governor"
mkdir -p "$PLUGIN/node_modules"
ln -sfn "$HOST/node_modules/@deepseek-ai" "$PLUGIN/node_modules/@deepseek-ai"
echo "  $(ls -ld "$PLUGIN/node_modules/@deepseek-ai" | sed 's/^/  /')"
echo "  resolves to: $(readlink -f "$PLUGIN/node_modules/@deepseek-ai")"
echo "  schemastery visible: $([ -d "$PLUGIN/node_modules/@deepseek-ai/schemastery" ] && echo yes || echo NO)"

echo
echo "=== D. experiment DSH_HOME and profile ==="
export DSH_HOME="$EXP_ROOT/dsh-home"
mkdir -p "$DSH_HOME"
PROFILE="$DSH_HOME/profiles/headless"
echo "  DSH_HOME=$DSH_HOME"
if [ -d "$PROFILE" ]; then
  echo "  profile exists: $(ls -A "$PROFILE" | tr '\n' ' ')"
else
  echo "  profile does NOT exist yet; seeding from the shipped template"
  # `--from-default-profile` both creates the profile and boots it. Booting is
  # unwanted here, so the create is done and its output captured, then discarded.
  cd "$HOST"
  timeout 180 ./node_modules/.bin/dsh --profile headless --from-default-profile headless </dev/null 2>&1 \
    | head -15 | sed 's/^/    /'
  echo "    after seeding: $(ls -A "$PROFILE" 2>/dev/null | tr '\n' ' ' || echo STILL-MISSING)"
fi

echo
echo "=== E. install the plugin into the profile ==="
if [ -d "$PROFILE" ]; then
  cd "$PROFILE"
  [ -f .npmrc ] || printf 'registry=%s\n' "$MIRROR" >.npmrc
  if [ -f package.json ]; then
    echo "  profile package.json exists"
  else
    echo '  {"name":"dsh-profile-headless","version":"1.0.0","private":true}' >package.json
  fi
  set +e
  pnpm add "$PLUGIN" 2>&1 | tail -10 | sed 's/^/  /'
  echo "  add_exit=$?"
  set -e
  echo "  --- linked? ---"
  ls -la node_modules 2>/dev/null | grep -i coord | sed 's/^/  /' || echo "    no coord entry in node_modules"
else
  echo "  SKIPPED: no profile directory"
fi

echo
echo "=== finish ==="
