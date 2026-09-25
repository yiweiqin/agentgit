#!/usr/bin/env bash
# Determine whether the fs/write-intent misses are caused by our plugin at all.
#
# bisect2 left two competing explanations:
#   (a) importing the plugin's module graph suppresses fs/write-intent dispatch;
#   (b) the runs differ in *how* the file got written -- the `write` tool goes through the fs
#       service and emits fs/write-intent, whereas a shell redirect (or a sandbox fallback)
#       does not.
#
# (b) is strongly suggested by p0's stderr, where the agent reports the sandbox refusing to run
# commands, while p2's stderr just says "Done. Verify." That is a difference in tool *choice*,
# which is also a live possibility for every A/B run in this experiment.
#
# The DSH session logs are the ground truth here: they record the tools actually invoked. This
# reads them per run instead of inferring from plugin output.
set -uo pipefail

EXP_ROOT=/root/autodl-tmp/coord-exp
export PATH=/opt/node24/bin:$PATH
SESS=/root/.dsh/sessions

echo "=== session directories for the bisect2 and prepend runs ==="
ls -1 "$SESS" 2>/dev/null | grep -E 'bisect2|prepend|census|arity' | sed 's/^/  /'

analyze() { # analyze <label> <session-dir-pattern>
  local label="$1" pattern="$2"
  local dir
  dir=$(ls -1dt "$SESS"/*"$pattern"* 2>/dev/null | head -1)
  if [ -z "${dir:-}" ]; then echo "  --- $label: no session dir matching $pattern ---"; return; fi
  local log
  log=$(find "$dir" -name 'session*.jsonl.zstd' 2>/dev/null | head -1)
  echo "  --- $label ---"
  echo "    dir: $(basename "$dir")"
  if [ -z "${log:-}" ]; then echo "    no session log"; return; fi
  zstdcat "$log" 2>/dev/null | python3 - "$label" <<'PY'
import json, sys, collections

label = sys.argv[1]
types = collections.Counter()
tools = collections.Counter()
fs_events = collections.Counter()
saw_shell = False

for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    try:
        e = json.loads(line)
    except Exception:
        continue
    t = e.get("type") or e.get("kind") or "?"
    types[t] += 1
    blob = json.dumps(e)
    # Tool invocations. The name field may sit at various depths, so look for the shapes DSH uses.
    for key in ("toolName", "name"):
        v = e.get(key)
        if isinstance(v, str) and v and t in {"tool/call", "tool_call", "tool-execution"}:
            tools[v] += 1
    if t in {"tool/call", "tool_call"}:
        v = e.get("toolName") or e.get("name")
        if isinstance(v, str):
            tools[v] += 1
    for probe in ("write", "edit", "bash", "shell", "exec", "glob", "read"):
        if f'"{probe}"' in blob and t in {"tool/call", "tool_call", "tool-execution"}:
            tools[probe] += 1
    for fsname in ("fs/write-intent", "dsh.file.write", "write-intent"):
        if fsname in blob:
            fs_events[fsname] += 1
    if "sandbox" in blob.lower():
        saw_shell = True

print(f"    record types: {dict(types.most_common(8))}")
print(f"    tool names seen: {dict(tools.most_common(10))}")
print(f"    fs-intent strings: {dict(fs_events)}")
PY
  echo "    --- first raw record (schema) ---"
  zstdcat "$log" 2>/dev/null | head -1 | cut -c1-600 | sed 's/^/      /'
}

analyze "p0-control (fs fired)"   "bisect2-p0-control"
analyze "p1-imports (fs silent)"  "bisect2-p1-imports"
analyze "p2-full (fs silent)"     "bisect2-p2-full"

echo
echo "=== finished ==="
