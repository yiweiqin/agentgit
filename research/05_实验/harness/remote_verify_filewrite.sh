#!/usr/bin/env bash
# Verify the fix: the plugin now records `file_write`, the quantity everything else derives from.
#
# Before the fix the ledger held `gate_allowed` + `write_settled` records but no `file_write`,
# because the `fs/write-intent` listener was registered after the host had already composed the
# dispatch chain (see host.ts for the measurements). `lambda_produced` and `B(t)` are counted
# from `file_write` alone, so the instrument was reading zero while looking healthy.
#
# The checks below are chosen to fail loudly rather than plausibly:
#   * `file_write` must be present, once per written file;
#   * its `session_id` must be a real session id, not a generated `anonymous-session-*` key,
#     which is what would happen if the session were reached without the `actor.agent` hop;
#   * its entities must be the absolute paths actually written, so contention is computable.
set -uo pipefail

EXP_ROOT=/root/autodl-tmp/coord-exp
HOST="$EXP_ROOT/dsh-host"
PLUGIN="$EXP_ROOT/dsh-coord-governor"
export PATH=/opt/node24/bin:$PATH
export DEEPSEEK_API_KEY="$(cat /root/.coord-deepseek-key)"
DSH="$HOST/node_modules/.bin/dsh"
LEDGER="$EXP_ROOT/ledgers/A1-instrument.jsonl"
ENTRY="$PLUGIN/src/host.ts"

echo "=== 0. entry file ==="
echo "  mounting: $ENTRY"
ls -l "$ENTRY" | sed 's/^/    /'

echo
echo "=== 1. arm: A0-baseline (no plugin), then A1-instrument (fixed) ==="
cat > /tmp/ov-fixed-a1.yml <<YML
- insert:
    - id: coord-governor
      name: $ENTRY
      config:
        arm: A1-instrument
        ledgerPath: $LEDGER
YML

TASK="Create three files in the current directory: one.txt containing alpha, two.txt containing beta, and three.txt containing gamma."

run_one() {
  local label="$1" overlay="${2:-}"
  local work="$EXP_ROOT/runs/fw-$label"; mkdir -p "$work"
  rm -f "$work"/*.txt
  ( cd "$work" && timeout 300 "$DSH" --profile headless ${overlay:+--patch "$overlay"} "$TASK" \
      >"$work/out.txt" 2>"$work/err.txt" )
  local rc=$?
  printf '  %-14s exit=%-3s files=[%s]\n' "$label" "$rc" \
    "$(ls "$work" 2>/dev/null | grep -E '^(one|two|three)\.txt$' | tr '\n' ' ')"
  local code
  code=$(grep -ohE 'REQUEST_EXTENSION|MISSING_CREDENTIAL|INVALID_CREDENTIAL' "$work/err.txt" | head -1)
  [ -n "$code" ] && echo "                 failure: $code"
  return 0
}

rm -f "$LEDGER"
run_one "a0-baseline" ""
run_one "a1-fixed" /tmp/ov-fixed-a1.yml

echo
echo "=== 2. ledger contents ==="
if [ ! -f "$LEDGER" ]; then
  echo "  NOT WRITTEN -- the plugin did not record anything"
  exit 1
fi
echo "  $LEDGER: $(wc -l <"$LEDGER") events"
python3 - "$LEDGER" <<'PY'
import json, sys, collections

kinds = collections.Counter()
writes = []
sessions = set()

for line in open(sys.argv[1], encoding="utf-8"):
    line = line.strip()
    if not line:
        continue
    e = json.loads(line)
    kinds[e["kind"]] += 1
    sessions.add(e["session_id"])
    if e["kind"] == "file_write":
        writes.append(e)

print("  --- kinds ---")
for kind, n in kinds.most_common():
    print(f"    {n:>3}  {kind}")

print("  --- file_write records ---")
for e in writes:
    ents = [x["path"] for x in e.get("entities", [])]
    print(f"    {e['timestamp_utc']}  task={e['task_id']}  session={e['session_id']}")
    for path in ents:
        print(f"        entity: {path}")

anonymous = [s for s in sessions if s.startswith("anonymous-session-")]
print("  --- verdict ---")
print(f"    file_write count: {len(writes)} (expected 3)")
print(f"    sessions: {sorted(sessions)}")
print(f"    anonymous session ids: {anonymous or 'none'}")

ok = True
if len(writes) != 3:
    print("    FAIL: expected exactly 3 file_write records")
    ok = False
if anonymous:
    print("    FAIL: session attribution fell through to generated anonymous ids")
    ok = False
if not all(x.get("entities") for x in writes):
    print("    FAIL: a file_write record carries no entity, so contention is incomputable")
    ok = False
if ok:
    print("    PASS: file_write is recorded, once per file, attributed to a real session")
PY

echo
echo "=== verification finished ==="
