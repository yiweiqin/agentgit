#!/usr/bin/env bash
# Is DSH installable as published packages, or must the monorepo be built?
#
# This matters more than usual here: the machine has roughly one usable core and 2 GiB,
# so compiling a large TypeScript monorepo is a real risk of OOM. If the @deepseek-ai
# packages are published, the plugin's peer dependencies resolve by download and no
# build is needed at all.
set -u

echo "=== npm registry: are the DSH packages published? ==="
for pkg in dsh "@deepseek-ai/dsh" "@deepseek-ai/dsh-tools" "@deepseek-ai/dsh-agent" \
           "@deepseek-ai/dsh-fs" "@deepseek-ai/dsh-llm" "@deepseek-ai/dsh-session" \
           "@deepseek-ai/cordis" "@deepseek-ai/schemastery"; do
  encoded=$(python3 -c "import sys,urllib.parse;print(urllib.parse.quote(sys.argv[1], safe=''))" "$pkg")
  code=$(curl -s -o /tmp/pkg.json -w '%{http_code}' --max-time 20 "https://registry.npmjs.org/$encoded")
  if [ "$code" = "200" ]; then
    summary=$(python3 - <<'PY' 2>/dev/null
import json
d = json.load(open("/tmp/pkg.json"))
latest = d.get("dist-tags", {}).get("latest", "?")
print(f"latest={latest} versions={len(d.get('versions', {}))}")
PY
)
    echo "  $pkg -> 200  $summary"
  else
    echo "  $pkg -> HTTP $code (not published / not reachable)"
  fi
done

echo
echo "=== github repo reachable? ==="
curl -s -o /dev/null -w '  github.com/deepseek-ai/deepseek-harness: %{http_code}\n' --max-time 20 \
  https://github.com/deepseek-ai/deepseek-harness 2>/dev/null || echo "  github: unreachable"

echo
echo "=== outbound HTTPS the plan requires ==="
curl -s -o /dev/null -w '  api.deepseek.com:    %{http_code}\n' --max-time 15 https://api.deepseek.com/
curl -s -o /dev/null -w '  registry.npmjs.org:  %{http_code}\n' --max-time 15 https://registry.npmjs.org/
curl -s -o /dev/null -w '  nodejs.org:          %{http_code}\n' --max-time 15 https://nodejs.org/

echo
echo "=== can we install Node v24? (distro ships v12, far too old) ==="
curl -s -o /dev/null -w '  nodejs.org/dist/index.json: %{http_code}\n' --max-time 20 https://nodejs.org/dist/index.json
latest_v24=$(curl -s --max-time 20 https://nodejs.org/dist/index.json 2>/dev/null | python3 - <<'PY' 2>/dev/null
import json, sys
try:
    data = json.load(sys.stdin)
    v24 = [d["version"] for d in data if d["version"].startswith("v24.")]
    print(v24[0] if v24 else "none found")
except Exception:
    print("could not parse")
PY
)
echo "  newest v24 on nodejs.org: $latest_v24"

echo
echo "=== probe finished ==="
