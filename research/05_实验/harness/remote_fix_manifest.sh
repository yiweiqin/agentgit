#!/usr/bin/env bash
# Confirm the REQUEST_EXTENSION root cause and fix it.
#
# From the inventory source: for each *active* Loader entry it walks up from the entry's module
# file to find an owning package.json (`nearestManifest`), then calls
# `identityFromManifest(manifest, allowAnonymous = true)`. With `allowAnonymous` the absent-name
# case is tolerated, but any manifest that *does* declare a name must also declare a non-empty
# version -- otherwise the resolver throws, `prepareExtensions` rejects, and the adapter
# surfaces it as REQUEST_EXTENSION.
#
# `pure-noop.ts` lives in a directory with no ancestor manifest, so it resolves to `undefined`
# and is skipped. Our plugin lives in `dsh-coord-governor/`, which owns a package.json, so it
# gets resolved -- and is the only arm that fails. That asymmetry is the whole bug.
set -uo pipefail

EXP_ROOT=/root/autodl-tmp/coord-exp
HOST="$EXP_ROOT/dsh-host"
PLUGIN="$EXP_ROOT/dsh-coord-governor"
export PATH=/opt/node24/bin:$PATH
export DEEPSEEK_API_KEY="$(cat /root/.coord-deepseek-key)"
DSH="$HOST/node_modules/.bin/dsh"

echo "=== 1. our plugin's owning manifest ==="
echo "  --- $PLUGIN/package.json ---"
cat "$PLUGIN/package.json" 2>/dev/null | sed 's/^/    /' || echo "    (missing)"

echo
echo "=== 2. replicate the resolver's decision for both entry kinds ==="
node --input-type=module -e "
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, parse, isAbsolute } from 'node:path'

function nearestManifest(modulePath) {
  let current = dirname(modulePath)
  const root = parse(current).root
  for (;;) {
    const m = join(current, 'package.json')
    if (existsSync(m)) return m
    if (current === root) return
    current = dirname(current)
  }
}

const entries = {
  'pure-noop (works)':  '$EXP_ROOT/variants/pure-noop.ts',
  'noop-pkg (works)':   '$EXP_ROOT/variants/noop-pkg/index.ts',
  'our plugin (FAILS)': '$PLUGIN/src/index.ts',
}
for (const [label, p] of Object.entries(entries)) {
  console.log('  ' + label)
  console.log('    absolute?', isAbsolute(p))
  const m = nearestManifest(p)
  if (m === undefined) { console.log('    nearestManifest: none -> identity undefined -> skipped'); continue }
  console.log('    nearestManifest:', m)
  let manifest
  try { manifest = JSON.parse(readFileSync(m, 'utf8')) } catch (e) { console.log('    JSON.parse THROWS:', e.message); continue }
  const allowAnonymous = true
  if (allowAnonymous && manifest.name === undefined) { console.log('    anonymous -> skipped'); continue }
  const okName = typeof manifest.name === 'string' && manifest.name.length > 0
  const okVer  = typeof manifest.version === 'string' && manifest.version.length > 0
  if (!okName || !okVer) {
    console.log('    >>> RESOLVER THROWS: must declare non-empty name and version')
    console.log('        name=' + JSON.stringify(manifest.name) + '  version=' + JSON.stringify(manifest.version))
  } else {
    console.log('    identity ok:', manifest.name + '@' + manifest.version)
  }
}
"

echo
echo "=== 3. apply the fix: declare a non-empty version ==="
python3 - "$PLUGIN/package.json" <<'PY'
import json, sys
path = sys.argv[1]
raw = open(path, encoding="utf-8").read()
manifest = json.loads(raw)
print("  before: name=%r version=%r" % (manifest.get("name"), manifest.get("version")))
manifest.setdefault("name", "dsh-coord-governor")
if not isinstance(manifest.get("version"), str) or not manifest["version"]:
    manifest["version"] = "0.1.0"
# A plugin loaded straight from source by the Loader must be importable as ESM.
manifest.setdefault("type", "module")
open(path, "w", encoding="utf-8").write(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n")
print("  after:  name=%r version=%r" % (manifest.get("name"), manifest.get("version")))
PY

echo
echo "=== 4. re-run the arm that was failing ==="
mkdir -p /tmp/ov-real-a1.yml.dir
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
work="$EXP_ROOT/runs/keyed-real-a1-fixed"; mkdir -p "$work"; rm -f "$work"/*.txt "$work"/probe.txt
( cd "$work" && timeout 240 "$DSH" --profile headless --patch /tmp/ov-real-a1.yml \
    "Create three files in the current directory: a.txt containing alpha, b.txt containing beta, and c.txt containing gamma." \
    >"$work/out.txt" 2>"$work/err.txt" )
rc=$?
echo "  real-a1-fixed  exit=$rc"
echo "  files: $(ls "$work" 2>/dev/null | tr '\n' ' ')"
echo "  stderr tail:"; tail -5 "$work/err.txt" | sed 's/^/    /'

echo
echo "=== 5. ledger from that session ==="
if [ -f "$LEDGER" ]; then
  echo "  $LEDGER: $(wc -l <"$LEDGER") events"
  python3 - "$LEDGER" <<'PY'
import json, sys, collections
kinds = collections.Counter(); ents = collections.Counter()
for line in open(sys.argv[1]):
    line = line.strip()
    if not line: continue
    e = json.loads(line); kinds[e["kind"]] += 1
    for ent in e.get("entities", []): ents[ent] += 1
for k, n in kinds.most_common(): print(f"    {n:>3}  {k}")
print("    --- entities touched ---")
for k, n in ents.most_common(): print(f"    {n:>3}  {k}")
PY
else
  echo "  NOT WRITTEN"
fi

echo
echo "=== fix verification finished ==="
