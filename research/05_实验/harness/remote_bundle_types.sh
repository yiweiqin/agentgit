#!/usr/bin/env bash
# Bundle the real DSH type declarations for off-machine type checking.
#
# Why the types matter more than anything else here: plugin.ts was written from
# documentation, and every event signature, decision shape, and import path in it is an
# assumption about a v0.1 preview. Unit tests cannot catch a wrong assumption, because
# the tests mock the same assumptions. Checking against the shipped .d.ts is the one
# check that can falsify them.
#
# The bundle is a single tarball rather than a file-by-file copy: the @deepseek-ai tree
# is 241 packages, and SFTP round-trips per file would dominate.
set -u

EXP_ROOT=/root/autodl-tmp/coord-exp
export PATH=/opt/node24/bin:$PATH
cd "$EXP_ROOT/dsh-host"

OUT="$EXP_ROOT/dsh-types.tgz"

echo "=== count what we are bundling ==="
echo "  @deepseek-ai packages: $(ls node_modules/@deepseek-ai | wc -l)"
echo "  .d.ts files:           $(find node_modules/@deepseek-ai -name '*.d.ts' 2>/dev/null | wc -l)"

echo
echo "=== build the manifest of every @deepseek-ai package and version ==="
python3 - <<'PY'
import json, os
root = "node_modules/@deepseek-ai"
rows = []
for entry in sorted(os.listdir(root)):
    pkg = os.path.join(root, entry, "package.json")
    if os.path.isfile(pkg):
        try:
            d = json.load(open(pkg))
            rows.append((d.get("name", entry), d.get("version", "?"), d.get("types") or d.get("typings") or ""))
        except Exception:
            rows.append((entry, "?", "unreadable"))
with open("/root/autodl-tmp/coord-exp/dsh-types-manifest.txt", "w") as fh:
    for name, version, types in rows:
        fh.write(f"{name}\t{version}\t{types}\n")
print(f"  wrote manifest with {len(rows)} packages")
PY

echo
echo "=== include the plugin's real peer dependencies (cordis, schemastery) ==="
for extra in cordis schemastery cosmokit cordis-plugin-loader; do
  [ -d "node_modules/@deepseek-ai/$extra" ] && echo "  present: @deepseek-ai/$extra"
done

echo
echo "=== tar the declarations ==="
# Only package.json, .d.ts, and the patch/cordis yml files are needed. Shipping whole
# packages would move hundreds of megabytes of JavaScript the type checker never reads.
rm -f "$OUT"
tar czf "$OUT" \
  --transform 's,^node_modules/,,' \
  $(find node_modules/@deepseek-ai -maxdepth 2 -name 'package.json' -o -maxdepth 2 -name 'cordis.patch.yml' 2>/dev/null | head -600) \
  $(find node_modules/@deepseek-ai -name '*.d.ts' 2>/dev/null | head -20000) \
  2>/dev/null

if [ -s "$OUT" ]; then
  echo "  wrote $OUT ($(du -h "$OUT" | cut -f1))"
else
  echo "  tar produced nothing, retrying with a file list"
  find node_modules/@deepseek-ai \( -name '*.d.ts' -o -name 'package.json' \) >/tmp/dsh-type-files.txt
  wc -l /tmp/dsh-type-files.txt | sed 's/^/  files: /'
  tar czf "$OUT" -T /tmp/dsh-type-files.txt --transform 's,^node_modules/,,' 2>/dev/null
  echo "  wrote $OUT ($(du -h "$OUT" | cut -f1))"
fi

echo
echo "=== sanity: does the tarball contain the files we care about? ==="
tar tzf "$OUT" 2>/dev/null | grep -E "dsh-fs/lib/index.d.ts|dsh-agent/lib/index.d.ts|dsh-llm/lib/index.d.ts|cordis/lib/index.d.ts" | head -10 | sed 's/^/  /'
echo "  total entries: $(tar tzf "$OUT" 2>/dev/null | wc -l)"

echo
echo "=== where the plugin's imports must resolve ==="
for mod in dsh-fs dsh-agent dsh-llm dsh-tools dsh-session; do
  pj="node_modules/@deepseek-ai/$mod/package.json"
  if [ -f "$pj" ]; then
    python3 -c "
import json
d = json.load(open('$pj'))
exports = d.get('exports')
print('  $mod', d.get('version'), 'types=', d.get('types'), 'exports=', list(exports.keys()) if isinstance(exports, dict) else exports)
" 2>/dev/null
  fi
done

echo
echo "=== bundle finished ==="
