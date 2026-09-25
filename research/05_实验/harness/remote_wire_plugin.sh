#!/usr/bin/env bash
# Install the plugin into the profile and find out whether DSH can load it as raw .ts.
#
# The risk being tested: this plugin ships TypeScript source (`exports: "./src/index.ts"`)
# and deliberately has no build step, relying on Node's type stripping. Node refuses to
# strip types for files inside `node_modules`, and a profile installs its plugins there --
# so the packaging choice and the host's loader may simply not fit together. That is worth
# one experiment now rather than a surprise during the first treatment run.
set -u

EXP_ROOT=/root/autodl-tmp/coord-exp
export PATH=/opt/node24/bin:$PATH
export DSH_HOME="$EXP_ROOT/dsh-home"
MIRROR=https://registry.npmmirror.com
PROFILE="$DSH_HOME/profiles/headless"
PLUGIN_SRC="$EXP_ROOT/dsh-coord-governor"

echo "=== what arrived ==="
find "$PLUGIN_SRC" -type f | head -25 | sed 's/^/  /'

echo
echo "=== baseline: can plain node import a .ts file OUTSIDE node_modules? ==="
mkdir -p "$EXP_ROOT/ts-probe"
cat >"$EXP_ROOT/ts-probe/dep.ts" <<'TS'
export const value: number = 41
TS
cat >"$EXP_ROOT/ts-probe/main.mjs" <<'JS'
const mod = await import('./dep.ts')
console.log('  outside node_modules:', mod.value + 1)
JS
cd "$EXP_ROOT/ts-probe"
set +e
node main.mjs 2>&1 | head -10 | sed 's/^/  /'
echo "  exit=$?"
set -e

echo
echo "=== the decisive one: same import from INSIDE node_modules ==="
mkdir -p "$EXP_ROOT/ts-probe/fakepkg/node_modules/faketsdep"
cat >"$EXP_ROOT/ts-probe/fakepkg/node_modules/faketsdep/package.json" <<'JSON'
{ "name": "faketsdep", "version": "1.0.0", "type": "module", "exports": { ".": "./index.ts" } }
JSON
cat >"$EXP_ROOT/ts-probe/fakepkg/node_modules/faketsdep/index.ts" <<'TS'
export const value: number = 41
TS
cat >"$EXP_ROOT/ts-probe/fakepkg/main.mjs" <<'JS'
try {
  const mod = await import('faketsdep')
  console.log('  inside node_modules: OK ->', mod.value + 1)
} catch (error) {
  console.log('  inside node_modules: FAILED ->', error.code || '', error.message.split('\n')[0])
}
JS
cd "$EXP_ROOT/ts-probe/fakepkg"
node main.mjs 2>&1 | head -15 | sed 's/^/  /'

echo
echo "=== install the plugin into the profile ==="
cd "$PROFILE"
[ -f .npmrc ] || printf 'registry=%s\n' "$MIRROR" >.npmrc
set +e
pnpm add "$PLUGIN_SRC" 2>&1 | tail -12
echo "  add_exit=$?"
set -e

echo
echo "=== is it linked, or copied into the virtual store? ==="
ls -la "$PROFILE/node_modules" | grep -i coord | sed 's/^/  /'
if [ -L "$PROFILE/node_modules/dsh-coord-governor" ]; then
  echo "  resolved real path: $(readlink -f "$PROFILE/node_modules/dsh-coord-governor")"
fi

echo
echo "=== can node import the plugin by name from the profile? ==="
cd "$PROFILE"
cat >/tmp/import-probe.mjs <<'JS'
try {
  const mod = await import('dsh-coord-governor')
  console.log('  import OK; exports:', Object.keys(mod).slice(0, 12).join(', '))
} catch (error) {
  console.log('  import FAILED')
  console.log('  code:', error.code)
  console.log('  message:', String(error.message).split('\n').slice(0, 6).join('\n    '))
}
JS
node /tmp/import-probe.mjs 2>&1 | head -30 | sed 's/^/  /'

echo
echo "=== wire the plugin into the profile patch layer ==="
python3 - "$PROFILE/cordis.patch.yml" <<'PY'
import sys

path = sys.argv[1]
patch = """# Experiment patch layer: mounts the coordination governor.
#
# The arm is chosen per run by the harness rewriting this file (or by an overlay), because
# `arm` is what distinguishes A0/A1/A2/A3/A4 and a run's ledger must be attributable to
# exactly one arm without trusting a label passed alongside it.
#
# `ledgerPath` is likewise per-arm so two arms can never append to the same file.
- insert:
    - id: coord-governor
      name: dsh-coord-governor
      config:
        arm: A1-instrument
        ledgerPath: /root/autodl-tmp/coord-exp/ledgers/A1-instrument.jsonl
"""
open(path, "w").write(patch)
print("  wrote", path)
PY
cat "$PROFILE/cordis.patch.yml" | sed 's/^/  /'

echo
echo "=== does the composed tree now contain the row? ==="
cd "$EXP_ROOT/dsh-host"
set +e
timeout 120 ./node_modules/.bin/dsh --profile headless --dump-config 2>&1 | grep -nE "coord|governor" | sed 's/^/  /'
echo "  grep_exit=$?"
set -e

echo
echo "=== boot attempt: does the plugin actually load and register? ==="
cd "$EXP_ROOT/worktree-probe"
set +e
timeout 180 "$EXP_ROOT/dsh-host/node_modules/.bin/dsh" --profile headless "Create a file named probe.txt containing the word hello." 2>&1 | head -40 | sed 's/^/  /'
echo "  boot_exit=$?"
set -e

echo
echo "=== did the plugin's listeners register? (look for our arm log line) ==="
latest=$(find "$DSH_HOME/sessions" -name "session*.zstd" -o -name "session*.jsonl" 2>/dev/null | sort | tail -1)
echo "  newest log: ${latest:-none}"
if [ -n "${latest:-}" ]; then
  case "$latest" in
    *.zstd) zstd -dc "$latest" 2>/dev/null | grep -icE "coord-governor|coordinator" | sed 's/^/  mentions: /' ;;
    *) grep -icE "coord-governor" "$latest" | sed 's/^/  mentions: /' ;;
  esac
fi

echo
echo "=== did the ledger get created? ==="
ls -la "$EXP_ROOT/ledgers" 2>/dev/null | sed 's/^/  /' || echo "  no ledger directory"

echo
echo "=== wiring finished ==="
