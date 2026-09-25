#!/usr/bin/env bash
# Try to mount the governor as a --patch overlay instead of mutating the profile.
#
# The previous machine installed the plugin by mutating the profile's node_modules, which
# needed a symlink hack to make the plugin's peer deps resolve. `--patch` is a documented,
# repeatable overlay applied after the profile layer, so if the loader accepts a filesystem
# path as a plugin `name`, mounting becomes a per-run argument: no shared state between
# arms, and no way for one arm's install to leak into another's.
#
# `--dump-config` is used as the test because it composes the full tree without booting.
# Booting inside a pipeline is what hung the last attempt.
set -uo pipefail

EXP_ROOT=/root/autodl-tmp/coord-exp
HOST="$EXP_ROOT/dsh-host"
PLUGIN="$EXP_ROOT/dsh-coord-governor"
export PATH=/opt/node24/bin:$PATH
cd "$HOST"
DSH="$HOST/node_modules/.bin/dsh"
PROFILE_DIR=/root/.dsh/profiles/headless

echo "=== 1. what the auto-provisioned profile contains ==="
echo "  --- cordis.patch.yml ---"
cat "$PROFILE_DIR/cordis.patch.yml" 2>/dev/null | sed 's/^/    /'
echo "  --- cordis.yml (head) ---"
head -25 "$PROFILE_DIR/cordis.yml" 2>/dev/null | sed 's/^/    /'
echo "  --- package.json ---"
cat "$PROFILE_DIR/package.json" 2>/dev/null | sed 's/^/    /'
echo "  --- .dsh-module-fallback ---"
ls -la "$PROFILE_DIR/.dsh-module-fallback" 2>/dev/null | head -8 | sed 's/^/    /'

echo
echo "=== 2. which env var names DSH's home paths react to ==="
# Needed for the plan's per-arm isolation requirement, so it is worth pinning down now
# rather than discovering that every arm shared one home.
grep -rhoE "'DSH_[A-Z_]+'|\"DSH_[A-Z_]+\"|DSH_[A-Z_]{3,}" \
  "$HOST/node_modules/@deepseek-ai/dsh-home-paths/lib/" 2>/dev/null | sort -u | head -12 | sed 's/^/    /'

echo
echo "=== 3. does --patch accept an absolute path as a plugin name? ==="
mkdir -p "$EXP_ROOT/ledgers"
cat > /tmp/coord-overlay.yml <<YML
- insert:
    - id: coord-governor
      name: $PLUGIN/src/index.ts
      config:
        arm: A1-instrument
        ledgerPath: $EXP_ROOT/ledgers/A1-instrument.jsonl
YML
echo "  --- overlay ---"
sed 's/^/    /' /tmp/coord-overlay.yml
echo "  --- dump-config with overlay (bounded, no boot) ---"
timeout 150 "$DSH" --profile headless --patch /tmp/coord-overlay.yml --dump-config \
  >/tmp/dump1.txt 2>/tmp/dump1.err
echo "    exit=$?"
echo "    --- rows mentioning coord ---"
grep -nE 'coord|governor' /tmp/dump1.txt 2>/dev/null | head -10 | sed 's/^/      /' \
  || echo "      (none)"
echo "    --- first 25 lines of stderr ---"
head -25 /tmp/dump1.err 2>/dev/null | sed 's/^/      /'
echo "    --- output size: $(wc -l </tmp/dump1.txt 2>/dev/null) lines ---"

echo
echo "=== 4. if that failed: is the overlay file even parsed? ==="
if ! grep -qE 'coord' /tmp/dump1.txt 2>/dev/null; then
  echo "  overlay row did not appear. Sanity check: does --dump-config respect --patch at all?"
  cat > /tmp/marker-overlay.yml <<'YML'
- insert:
    - id: coord-governor
      name: '@deepseek-ai/dsh-tool-todo'
YML
  timeout 150 "$DSH" --profile headless --patch /tmp/marker-overlay.yml --dump-config \
    >/tmp/dump2.txt 2>/tmp/dump2.err
  echo "    exit=$?"
  echo "    coord rows: $(grep -cE 'coord' /tmp/dump2.txt 2>/dev/null || echo 0)"
  grep -nE 'coord' /tmp/dump2.txt 2>/dev/null | head -5 | sed 's/^/      /'
  echo "    --- comparing row counts ---"
  echo "      without overlay: $(timeout 150 "$DSH" --profile headless --dump-config 2>/dev/null | wc -l)"
  echo "      with overlay:    $(wc -l </tmp/dump2.txt)"
fi

echo
echo "=== patch probe finished ==="
