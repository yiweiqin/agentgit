#!/usr/bin/env bash
# Test the revised hypothesis for REQUEST_EXTENSION.
#
# The error site is `this.config.prepareExtensions(...)` inside the DeepSeek adapter. Two
# shipped plugins contribute to that registry: `dsh-session-log-deepseek` and
# `dsh-plugin-package-inventory-deepseek`. The latter builds a manifest of *active plugin
# packages* (`dsh_plugin_packages`). Our plugin is mounted as a bare absolute path to a .ts
# file, which is not a resolvable package with a name/version, so the inventory contributor is
# the prime suspect -- and it would fail for *any* path-mounted plugin, not just ours.
#
# This run therefore keys the environment properly (the previous bisect was invalid: it never
# exported the API key, so every arm died at MISSING_CREDENTIAL) and includes a trivial no-op
# plugin. If the no-op fails identically, the bug is the mounting mechanism, not our code.
set -uo pipefail

EXP_ROOT=/root/autodl-tmp/coord-exp
HOST="$EXP_ROOT/dsh-host"
PLUGIN="$EXP_ROOT/dsh-coord-governor"
export PATH=/opt/node24/bin:$PATH
export DEEPSEEK_API_KEY="$(cat /root/.coord-deepseek-key)"
DSH="$HOST/node_modules/.bin/dsh"
VAR="$EXP_ROOT/variants"
mkdir -p "$VAR"

echo "=== 0. credential sanity (must NOT be MISSING_CREDENTIAL below) ==="
echo "  key length: ${#DEEPSEEK_API_KEY}"

echo
echo "=== 1. the package-inventory contributor source ==="
INV="$HOST/node_modules/@deepseek-ai/dsh-plugin-package-inventory-deepseek/lib/index.js"
wc -l "$INV" | sed 's/^/  /'
sed -n '1,200p' "$INV" | sed 's/^/  /'

echo
echo "=== 2. how the headless profile declares these plugins ==="
grep -rn "package-inventory\|session-log-deepseek" "$HOST"/node_modules/@deepseek-ai/dsh-headless/ 2>/dev/null | head -20 | sed 's/^/  /'
echo "  --- full profile tree ids ---"
"$DSH" --profile headless --dump-config 2>&1 | grep -nE "^\s*-?\s*(id|name):" | head -60 | sed 's/^/  /'

echo
echo "=== 3. keyed arms: does a no-op path-mounted plugin also fail? ==="
mkdir -p "$VAR"
cat > "$VAR/pure-noop.ts" <<'TS'
export const name = 'pure-noop'
export const inject = []
export function apply() {}
TS
cat > "$VAR/ov-pure-noop.yml" <<YML
- insert:
    - id: pure-noop
      name: $VAR/pure-noop.ts
YML
# same file, but expressed as a real package with a package.json next to it
NOOPPKG="$VAR/noop-pkg"
mkdir -p "$NOOPPKG"
cat > "$NOOPPKG/package.json" <<'JSON'
{ "name": "coord-noop-probe", "version": "0.0.0", "type": "module", "main": "index.ts" }
JSON
cat > "$NOOPPKG/index.ts" <<'TS'
export const name = 'coord-noop-probe'
export const inject = []
export function apply() {}
TS
cat > "$VAR/ov-noop-pkg.yml" <<YML
- insert:
    - id: coord-noop-probe
      name: $NOOPPKG/index.ts
YML

cat > /tmp/ov-real-a1.yml <<YML
- insert:
    - id: coord-governor
      name: $PLUGIN/src/index.ts
      config:
        arm: A1-instrument
        ledgerPath: $EXP_ROOT/ledgers/A1-instrument.jsonl
YML

run_one() {
  local label="$1" overlay="${2:-}"
  local work="$EXP_ROOT/runs/keyed-$label"; mkdir -p "$work"
  rm -f "$work"/*.txt "$work"/probe.txt
  ( cd "$work" && timeout 240 "$DSH" --profile headless ${overlay:+--patch "$overlay"} \
      "Create a file named probe.txt containing the word hello." >"$work/out.txt" 2>"$work/err.txt" )
  local rc=$?
  local code="(none)"
  grep -qE 'REQUEST_EXTENSION' "$work/err.txt" && code="REQUEST_EXTENSION"
  grep -qE 'MISSING_CREDENTIAL' "$work/err.txt" && code="MISSING_CREDENTIAL"
  grep -qE 'INVALID_CREDENTIAL' "$work/err.txt" && code="INVALID_CREDENTIAL"
  printf '  %-14s exit=%-3s probe.txt=%-4s failure=%s\n' "$label" "$rc" \
    "$([ -f "$work/probe.txt" ] && echo yes || echo NO)" "$code"
}

run_one "a0-no-plugin" ""
run_one "pure-noop"    "$VAR/ov-pure-noop.yml"
run_one "noop-pkg"     "$VAR/ov-noop-pkg.yml"
run_one "real-a1"      "/tmp/ov-real-a1.yml"

echo
echo "=== 4. any non-credential stderr tails ==="
for v in a0-no-plugin pure-noop noop-pkg real-a1; do
  f="$EXP_ROOT/runs/keyed-$v/err.txt"
  if [ -s "$f" ]; then echo "  --- $v ---"; tail -8 "$f" | sed 's/^/    /'; fi
done

echo
echo "=== hunt finished ==="
