#!/usr/bin/env bash
# Find which part of the mounted plugin breaks the model call.
#
# Previous attempts blamed runtime value imports of `@deepseek-ai/*`, but the plugin now has
# zero of them (verified: `grep` finds none, and node imports it standalone) and the session
# *still* dies with REQUEST_EXTENSION. What we do know from the last run is that the plugin
# loaded and its hooks fired (the ledger got `session_started` + `turn_ended`), so the failure
# is downstream of plugin boot, inside request preparation.
#
# So: read the actual error site, then bisect the plugin down to one handler at a time.
set -uo pipefail

EXP_ROOT=/root/autodl-tmp/coord-exp
HOST="$EXP_ROOT/dsh-host"
PLUGIN="$EXP_ROOT/dsh-coord-governor"
export PATH=/opt/node24/bin:$PATH
DSH="$HOST/node_modules/.bin/dsh"
VAR="$EXP_ROOT/variants"
mkdir -p "$VAR"

echo "=== 1. the REQUEST_EXTENSION error site ==="
grep -rl "REQUEST_EXTENSION" "$HOST/node_modules/@deepseek-ai" 2>/dev/null | while read -r f; do
  echo "  --- $f ---"
  python3 - "$f" <<'PY'
import sys, re
src = open(sys.argv[1], encoding="utf-8", errors="replace").read()
for m in re.finditer(r"REQUEST_EXTENSION", src):
    line = src.count("\n", 0, m.start()) + 1
    lines = src.splitlines()
    lo, hi = max(0, line - 45), min(len(lines), line + 12)
    print(f"  ... line {line} ...")
    for i in range(lo, hi):
        print(f"    {i+1:>5}| {lines[i]}")
    print()
PY
done

echo
echo "=== 2. who registers request extensions? ==="
grep -rn "requestExtension\|request-extension\|registerExtension" "$HOST/node_modules/@deepseek-ai" 2>/dev/null \
  | grep -v "\.map:" | head -40 | sed 's/^/  /'

echo
echo "=== 3. bisect: one handler at a time ==="

mk() { # mk <name> <body>
  cat > "$VAR/$1.ts" <<TS
import type { Context } from '@deepseek-ai/cordis'
export const name = '$1'
export const inject = []
export function apply(ctx: Context) {
$2
}
TS
  cat > "$VAR/ov-$1.yml" <<YML
- insert:
    - id: $1
      name: $VAR/$1.ts
      config:
        arm: A1-instrument
        ledgerPath: /tmp/ledger-$1.jsonl
YML
}

mk noop            '  void ctx'
mk session-created '  ctx.on("session/created", () => {})'
mk session-event   '  ctx.on("session/event", () => {})'
mk fs-write-intent '  ctx.on("fs/write-intent", () => {})'
mk tools-pre       '  ctx.on("tools/pre-execute", () => {})'
mk tools-post      '  ctx.on("tools/post-execute", () => {})'
mk agent-prestep   '  ctx.on("agent/pre-step", () => {})'

run_one() { # run_one <label> <overlay>
  local label="$1" overlay="$2"
  local work="$EXP_ROOT/runs/bisect-$label"; mkdir -p "$work"; rm -f "$work"/*.txt
  ( cd "$work" && timeout 180 "$DSH" --profile headless ${overlay:+--patch "$overlay"} \
      "Create a file named probe.txt containing the word hello." >"$work/out.txt" 2>"$work/err.txt" )
  local rc=$?
  local verdict="ok"
  grep -q REQUEST_EXTENSION "$work/err.txt" && verdict="REQUEST_EXTENSION"
  printf '  %-18s exit=%-3s probe.txt=%-5s %s\n' "$label" "$rc" \
    "$([ -f "$work/probe.txt" ] && echo yes || echo NO)" "$verdict"
}

export -f mk 2>/dev/null || true
run_one "a0-no-plugin" ""
for v in noop session-created session-event fs-write-intent tools-pre tools-post agent-prestep; do
  run_one "$v" "$VAR/ov-$v.yml"
done

echo
echo "=== 4. if anything failed, its stderr ==="
for v in noop session-created session-event fs-write-intent tools-pre tools-post agent-prestep; do
  f="$EXP_ROOT/runs/bisect-$v/err.txt"
  if [ -s "$f" ]; then
    echo "  --- $v ---"
    tail -12 "$f" | sed 's/^/    /'
  fi
done

echo
echo "=== bisect finished ==="
