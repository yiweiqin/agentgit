#!/usr/bin/env bash
# Read the pieces that determine how a profile is assembled and whether a replay model
# is actually available. The plan leans on llm-replay for determinism, so if it is not
# in the published packages that is a finding, not a detail.
set -u

EXP_ROOT=/root/autodl-tmp/coord-exp
export PATH=/opt/node24/bin:$PATH
cd "$EXP_ROOT/dsh-host"

echo "=== who mentions llm-replay? ==="
grep -rn "llm-replay" node_modules/@deepseek-ai/.ignored_dsh/package.json 2>/dev/null | head -20 | sed 's/^/  /'
echo
echo "--- that package.json in full ---"
head -60 node_modules/@deepseek-ai/.ignored_dsh/package.json 2>/dev/null | sed 's/^/  /'

echo
echo "=== what else is in .ignored_dsh? ==="
ls -la node_modules/@deepseek-ai/.ignored_dsh/ 2>/dev/null | head -30 | sed 's/^/  /'

echo
echo "=== search the whole tree for any replay module ==="
grep -rln "llm-replay" node_modules --include="*.js" --include="*.json" --include="*.yml" 2>/dev/null | head -20 | sed 's/^/  /'

echo
echo "=== dsh-headless: how it patches the tree ==="
cat node_modules/@deepseek-ai/dsh-headless/cordis.patch.yml 2>/dev/null | sed 's/^/  /'

echo
echo "=== dsh-base: the base patch ==="
cat node_modules/@deepseek-ai/dsh-base/cordis.patch.yml 2>/dev/null | head -100 | sed 's/^/  /'

echo
echo "=== dsh-headless package.json ==="
python3 -c "
import json
d = json.load(open('node_modules/@deepseek-ai/dsh-headless/package.json'))
print('  name:', d.get('name'), d.get('version'))
print('  bin:', d.get('bin'))
print('  deps:', len(d.get('dependencies', {})))
for k in sorted(d.get('dependencies', {})):
    print('    ', k)
" 2>&1 | head -60 | sed 's/^/  /'

echo
echo "=== probe finished ==="
