#!/usr/bin/env bash
# Re-run the previously failing arm after removing the BOM from the plugin's manifest.
#
# The whole failure was: DSH's plugin-package-inventory resolves each active Loader entry to
# its owning package.json and `JSON.parse`s it. A leading UTF-8 BOM makes that throw, the
# request-extension registry rejects, and the model call dies as REQUEST_EXTENSION. The
# manifest itself was always correct; only the three bytes in front of it were wrong.
#
# This script proves the fix at the manifest level *and* then runs a real session with several
# file writes, so the observer half is exercised rather than merely loaded.
set -uo pipefail

EXP_ROOT=/root/autodl-tmp/coord-exp
HOST="$EXP_ROOT/dsh-host"
PLUGIN="$EXP_ROOT/dsh-coord-governor"
export PATH=/opt/node24/bin:$PATH
export DEEPSEEK_API_KEY="$(cat /root/.coord-deepseek-key)"
DSH="$HOST/node_modules/.bin/dsh"

echo "=== 1. manifest is now BOM-free and parseable ==="
python3 - "$PLUGIN/package.json" <<'PY'
import json, sys
raw = open(sys.argv[1], "rb").read()
print("  leading bytes:", raw[:4])
print("  has BOM:", raw.startswith(b"\xef\xbb\xbf"))
m = json.loads(raw.decode("utf-8"))
print("  parsed ok: name=%r version=%r type=%r" % (m.get("name"), m.get("version"), m.get("type")))
PY

echo
echo "=== 2. resolver simulation for our entry ==="
node --input-type=module -e "
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, parse } from 'node:path'
function nearestManifest(modulePath) {
  let current = dirname(modulePath); const root = parse(current).root
  for (;;) { const m = join(current, 'package.json'); if (existsSync(m)) return m
    if (current === root) return; current = dirname(current) }
}
const m = nearestManifest('$PLUGIN/src/index.ts')
console.log('  manifest:', m)
const manifest = JSON.parse(readFileSync(m, 'utf8'))
console.log('  identity:', manifest.name + '@' + manifest.version, '-> resolvable, no throw')
"

echo
echo "=== 3. real session with the plugin mounted, on a multi-write task ==="
cat > /tmp/ov-real-a1.yml <<YML
- insert:
    - id: coord-governor
      name: $PLUGIN/src/index.ts
      config:
        arm: A1-instrument
        ledgerPath: $EXP_ROOT/ledgers/A1-instrument.jsonl
YML
LEDGER="$EXP_ROOT/ledgers/A1-instrument.jsonl"
rm -f "$LEDGER"
work="$EXP_ROOT/runs/a1-manifest-fix"; mkdir -p "$work"; rm -f "$work"/*.txt "$work"/a.txt "$work"/b.txt "$work"/c.txt
TASK="Create three files in the current directory: a.txt containing alpha, b.txt containing beta, and c.txt containing gamma."
start=$(date +%s)
( cd "$work" && timeout 300 "$DSH" --profile headless --patch /tmp/ov-real-a1.yml "$TASK" \
    >"$work/out.txt" 2>"$work/err.txt" )
rc=$?
echo "  exit=$rc  elapsed=$(( $(date +%s) - start ))s"
echo "  produced files:"
for f in a.txt b.txt c.txt; do
  printf '    %-8s %s\n' "$f" "$([ -f "$work/$f" ] && echo "yes: $(cat "$work/$f" 2>/dev/null | tr -d '\n')" || echo NO)"
done
echo "  failure code: $(grep -ohE 'REQUEST_EXTENSION|MISSING_CREDENTIAL|INVALID_CREDENTIAL' "$work/err.txt" | head -1 || echo none)"

echo
echo "=== 4. ledger written by that session ==="
if [ -f "$LEDGER" ]; then
  echo "  $LEDGER: $(wc -l <"$LEDGER") events"
  python3 - "$LEDGER" <<'PY'
import json, sys, collections
kinds = collections.Counter(); ents = collections.Counter(); hosts = collections.Counter()
for line in open(sys.argv[1]):
    line = line.strip()
    if not line: continue
    e = json.loads(line); kinds[e["kind"]] += 1
    hosts[e.get("host_event") or "-"] += 1
    for ent in e.get("entities", []): ents[ent] += 1
print("  --- kinds ---")
for k, n in kinds.most_common(): print(f"    {n:>3}  {k}")
print("  --- host events observed ---")
for k, n in hosts.most_common(): print(f"    {n:>3}  {k}")
print("  --- entities touched ---")
for k, n in ents.most_common(): print(f"    {n:>3}  {k}")
PY
else
  echo "  NOT WRITTEN"
fi

echo
echo "=== observer verification finished ==="
