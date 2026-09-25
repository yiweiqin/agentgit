#!/usr/bin/env bash
# Is the npm install network-bound or CPU-bound?
#
# Ten minutes with an empty node_modules is not normal, and the two causes call for
# opposite responses: a slow registry means switch to a mirror, whereas CPU starvation
# means switch tooling entirely. Guessing wrong wastes another ten minutes.
set -u

echo "=== npm cache growth over 20s ==="
before=$(du -sm /root/.npm/_cacache 2>/dev/null | cut -f1)
echo "  cache: ${before:-0} MB"
sleep 20
after=$(du -sm /root/.npm/_cacache 2>/dev/null | cut -f1)
echo "  cache: ${after:-0} MB after 20s  (delta $(( ${after:-0} - ${before:-0} )) MB)"

echo
echo "=== npm process state ==="
ps -eo pid,etime,pcpu,rss,stat,wchan:20,comm 2>/dev/null | grep -E '[n]pm|[n]ode' || echo "  no npm/node process"

echo
echo "=== registry throughput (single tarball) ==="
# A small, stable package: measures raw latency and bandwidth to the registry.
for url in \
  "https://registry.npmjs.org/cordis/-/cordis-4.0.2.tgz" \
  "https://registry.npmmirror.com/cordis/-/cordis-4.0.2.tgz"; do
  result=$(curl -s -o /dev/null -w '%{http_code} %{size_download}B in %{time_total}s (%{speed_download} B/s)' \
    --max-time 40 "$url" 2>/dev/null)
  echo "  $url"
  echo "    -> $result"
done

echo
echo "=== metadata latency (the resolution phase's bottleneck) ==="
for host in registry.npmjs.org registry.npmmirror.com; do
  t=$(curl -s -o /dev/null -w '%{time_total}s' --max-time 30 "https://$host/@deepseek-ai%2Fdsh" 2>/dev/null)
  echo "  $host @deepseek-ai/dsh metadata: $t"
done

echo
echo "=== how big is the tree npm is trying to resolve? ==="
meta=$(curl -s --max-time 30 https://registry.npmjs.org/@deepseek-ai%2Fdsh/0.1.5-rc.1 2>/dev/null)
if [ -n "$meta" ]; then
  python3 - <<'PY' 2>/dev/null
import json
try:
    d = json.loads(open("/tmp/dsh-meta.json").read()) if False else None
except Exception:
    d = None
PY
  echo "$meta" >/tmp/dsh-meta.json
  python3 - <<'PY'
import json
try:
    d = json.load(open("/tmp/dsh-meta.json"))
    deps = d.get("dependencies", {})
    print(f"  direct dependencies: {len(deps)}")
    for k, v in list(deps.items())[:25]:
        print(f"    {k}@{v}")
    if len(deps) > 25:
        print(f"    ... and {len(deps) - 25} more")
except Exception as e:
    print(f"  could not parse: {e}")
PY
else
  echo "  could not fetch metadata"
fi

echo
echo "=== node_modules right now ==="
ls /root/autodl-tmp/coord-exp/dsh-host/node_modules 2>/dev/null | wc -l
echo "  total size: $(du -sm /root/autodl-tmp/coord-exp/dsh-host 2>/dev/null | cut -f1) MB"

echo
echo "=== probe finished ==="
