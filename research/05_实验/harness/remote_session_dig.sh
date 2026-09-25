#!/usr/bin/env bash
# Learn what the DSH session log records, and which tools each bisect2 arm actually used.
#
# The question this answers: when the plugin's `fs/write-intent` listener stayed silent, was
# that because the listener was skipped, or because the file was written by a path that never
# emits the event? `fs/write-intent` sits on the fs *service*, so only writes routed through it
# (the `write`/`edit` tools) emit it; a shell redirect does not.
#
# Note on the previous attempt: piping `zstdcat | python3 - <<'PY'` silently discards the pipe,
# because the heredoc becomes the script's stdin. Data is staged in a file and passed by path.
set -uo pipefail

EXP_ROOT=/root/autodl-tmp/coord-exp
export PATH=/opt/node24/bin:$PATH
SESS=/root/.dsh/sessions
D=/tmp/sessdig; rm -rf "$D"; mkdir -p "$D"

cat > "$D/analyze.py" <<'PY'
import json, sys, collections

path, label = sys.argv[1], sys.argv[2]
types = collections.Counter()
tools = collections.Counter()
samples = {}

for line in open(path, encoding="utf-8", errors="replace"):
    line = line.strip()
    if not line:
        continue
    try:
        e = json.loads(line)
    except Exception:
        continue
    t = e.get("type") or e.get("kind") or "?"
    types[t] += 1

    # Collect any string that looks like a tool name, from the record's own fields.
    for key in ("toolName", "name", "tool"):
        v = e.get(key)
        if isinstance(v, str) and v:
            tools[f"{t}.{key}={v}"] += 1
    # DSH nests tool metadata; walk one level of dicts for a `name`.
    for key, v in e.items():
        if isinstance(v, dict):
            n = v.get("toolName") or v.get("name")
            if isinstance(n, str) and n:
                tools[f"{t}.{key}.name={n}"] += 1
            for sub in ("call", "request", "toolCall"):
                sv = v.get(sub)
                if isinstance(sv, dict):
                    n2 = sv.get("name") or sv.get("toolName")
                    if isinstance(n2, str) and n2:
                        tools[f"{t}.{key}.{sub}.name={n2}"] += 1
    if t not in samples:
        samples[t] = json.dumps(e)[:300]

print(f"  --- {label} ---")
print(f"    record types: {dict(types.most_common(12))}")
if tools:
    print(f"    tool-ish fields: {dict(tools.most_common(12))}")
print("    one sample per type:")
for t, s in list(samples.items())[:10]:
    print(f"      [{t}] {s}")
PY

for spec in "p0-control:bisect2-p0-control:FS FIRED" \
            "p1-imports:bisect2-p1-imports:FS SILENT" \
            "p2-full:bisect2-p2-full:FS SILENT" \
            "real-a1:keyed-real-a1-fixed:real plugin run"; do
  label="${spec%%:*}"; rest="${spec#*:}"; pattern="${rest%%:*}"; note="${rest#*:}"
  dir=$(ls -1dt "$SESS"/*"$pattern"* 2>/dev/null | head -1)
  if [ -z "${dir:-}" ]; then echo "  --- $label: no session dir ---"; continue; fi
  log=$(find "$dir" -name 'session*.jsonl.zstd' 2>/dev/null | head -1)
  if [ -z "${log:-}" ]; then echo "  --- $label: no log ---"; continue; fi
  zstdcat "$log" > "$D/$label.jsonl" 2>/dev/null
  echo "  [$note]  records=$(wc -l <"$D/$label.jsonl")"
  python3 "$D/analyze.py" "$D/$label.jsonl" "$label"
  echo
done

echo "=== finished ==="
