#!/usr/bin/env bash
# Narrow REQUEST_EXTENSION down to a cause.
#
# A0 (no plugin) succeeds in 5s; A1 (governor mounted) fails in 1s. Two hypotheses remain
# and they need opposite fixes:
#   (a) the governor is doing something to the request, or
#   (b) mounting *any* plugin through --patch disturbs the deepseek request-extension
#       preparation, in which case the governor is innocent and the mount mechanism is wrong.
#
# A no-op Cordis plugin settles it: identical mount, identical everything, no logic at all.
# If A0-noop fails too, the finding is about the harness/mount, not about coordination --
# and that distinction has to be established before a single experiment run, because
# otherwise every treatment arm would show "0 improvement" for a reason that has nothing to
# do with the treatment.
set -uo pipefail

EXP_ROOT=/root/autodl-tmp/coord-exp
HOST="$EXP_ROOT/dsh-host"
PLUGIN="$EXP_ROOT/dsh-coord-governor"
export PATH=/opt/node24/bin:$PATH
export DEEPSEEK_API_KEY="$(cat /root/.coord-deepseek-key)"
DSH="$HOST/node_modules/.bin/dsh"

echo "=== 1. what the failing run recorded ==="
LOG=/root/.dsh/sessions/--root-autodl-tmp-coord-exp-runs-a1-instrument--/session-f14100d6-5673-4d8e-82a8-756cc05533cb/session.v3.jsonl.zstd
if [ -f "$LOG" ]; then
  echo "  size: $(stat -c %s "$LOG")"
  echo "  --- all events (decompressed) ---"
  zstd -dc "$LOG" 2>/dev/null | head -c 4000 | sed 's/^/    /'
else
  echo "  log not found at $LOG; newest logs:"
  find /root/.dsh/sessions -name 'session*.zstd' -newermt '-30 minutes' 2>/dev/null | head -5 | sed 's/^/    /'
fi

echo
echo "=== 2. what the extension plugin prepares ==="
EXT="$HOST/node_modules/@deepseek-ai/dsh-deepseek-llm-api-extensions"
ls "$EXT/lib" 2>/dev/null | sed 's/^/  /'
echo "  --- registered extension names ---"
grep -rhoE "'[a-z][a-z0-9-]{2,30}'" "$EXT/lib/"*.js 2>/dev/null | sort -u | head -20 | sed 's/^/    /'
echo "  --- does it inspect messages/plugins? ---"
grep -rhoE 'plugin|context|section|form|source' "$EXT/lib/"*.js 2>/dev/null | sort | uniq -c | sort -rn | head -10 | sed 's/^/    /'

echo
echo "=== 3. the decisive control: mount a NO-OP plugin ==="
NOOP="$EXP_ROOT/noop-plugin"
mkdir -p "$NOOP"
cat > "$NOOP/index.ts" <<'TS'
/**
 * Intentionally empty. Exists only to answer "does mounting any plugin via --patch break
 * the deepseek request extension?" without any coordination logic in the way.
 */
export const name = 'noop-probe'
export const inject: string[] = []
export function apply(): void {}
TS
cat > /tmp/overlay-noop.yml <<YML
- insert:
    - id: noop-probe
      name: $NOOP/index.ts
YML
echo "  --- overlay ---"
sed 's/^/    /' /tmp/overlay-noop.yml

run_arm() {
  local label="$1"; shift
  local work="$EXP_ROOT/runs/$label"
  mkdir -p "$work"
  rm -f "$work/probe.txt" "$work/stdout.txt" "$work/stderr.txt"
  echo
  echo "=== RUN [$label] ==="
  local start=$(date +%s)
  ( cd "$work" && timeout 240 "$DSH" --profile headless "$@" \
      "Create a file named probe.txt containing the word hello." \
      >"$work/stdout.txt" 2>"$work/stderr.txt" )
  local rc=$?
  echo "  exit=$rc  elapsed=$(( $(date +%s) - start ))s"
  echo "  stdout: $(head -3 "$work/stdout.txt" 2>/dev/null | tr '\n' ' ')"
  echo "  stderr (last 4):"
  tail -4 "$work/stderr.txt" 2>/dev/null | sed 's/^/    /'
  echo "  probe.txt: $(cat "$work/probe.txt" 2>/dev/null || echo NOT-CREATED)"
}

run_arm a0-noop --patch /tmp/overlay-noop.yml

echo
echo "=== 4. and the governor again, for a stable three-way comparison ==="
run_arm a1-instrument --patch /tmp/overlay-a1.yml

echo
echo "=== diagnosis test finished ==="
