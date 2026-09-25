#!/usr/bin/env bash
# Read what actually raises REQUEST_EXTENSION, instead of guessing at it.
#
# Three hypotheses have now been eliminated: it is not the handlers (all pass alone), not
# the --patch mount (a no-op mounts fine), and not duplicate module instances (the two
# @deepseek-ai trees are the same files). What remains is to read the code path that
# produces the error. "Request extension preparation" is a specific mechanism, and the
# plugin's only unusual property is that it imports from @deepseek-ai/dsh-llm.
#
# Note the previous import probe was invalid: it was placed in a directory with no
# node_modules, so its MODULE_NOT_FOUND said nothing about the hypothesis. That is redone
# here inside the plugin directory, which does have the link.
set -uo pipefail

EXP_ROOT=/root/autodl-tmp/coord-exp
HOST="$EXP_ROOT/dsh-host"
PLUGIN="$EXP_ROOT/dsh-coord-governor"
export PATH=/opt/node24/bin:$PATH
export DEEPSEEK_API_KEY="$(cat /root/.coord-deepseek-key)"
DSH="$HOST/node_modules/.bin/dsh"

echo "=== 1. context around REQUEST_EXTENSION in dsh-llm-deepseek ==="
python3 - <<'PY'
import pathlib
for path in pathlib.Path("/root/autodl-tmp/coord-exp/dsh-host/node_modules/@deepseek-ai/dsh-llm-deepseek").rglob("*.js"):
    text = path.read_text(errors="replace")
    idx = 0
    hits = 0
    while True:
        i = text.find("REQUEST_EXTENSION", idx)
        if i < 0 or hits >= 3:
            break
        start = max(0, i - 900)
        print(f"--- {path.name} @ {i} ---")
        print(text[start : i + 400].replace("\n", "\n  "))
        print()
        idx = i + 1
        hits += 1
    if hits:
        print(f"(file size {len(text)} chars)")
PY

echo
echo "=== 2. what is a 'request extension'? ==="
grep -rl 'requestExtension\|request-extension\|request_extensions' "$HOST/node_modules/@deepseek-ai/" 2>/dev/null | head -8 | sed 's/^/  /'
echo "  --- the extensions package's full source is small; read it ---"
python3 - <<'PY'
import pathlib
p = pathlib.Path("/root/autodl-tmp/coord-exp/dsh-host/node_modules/@deepseek-ai/dsh-deepseek-llm-api-extensions/lib/index.js")
if p.exists():
    print(p.read_text(errors="replace")[:3200])
else:
    print("  (missing)")
PY

echo
echo "=== 3. valid import probe: inside the plugin dir (has node_modules) ==="
cat > "$PLUGIN/llmimport-probe.ts" <<'TS'
// Only an import, no handlers. If this reproduces REQUEST_EXTENSION, the import itself is
// the trigger and the no-op's innocence was just "it imports nothing".
import { createUserMessage } from '@deepseek-ai/dsh-llm'
export const name = 'probe-llmimport'
export const inject: string[] = []
export function apply(_ctx: any): void {
  void createUserMessage
}
TS
printf -- '- insert:\n    - id: probe-llmimport\n      name: %s/llmimport-probe.ts\n' "$PLUGIN" > /tmp/overlay-llmimport2.yml
work="$EXP_ROOT/runs/probe-llmimport2"; mkdir -p "$work"
( cd "$work" && timeout 150 "$DSH" --profile headless --patch /tmp/overlay-llmimport2.yml \
    "Create a file named probe.txt containing the word hello." \
    >"$work/stdout.txt" 2>"$work/stderr.txt" )
echo "  exit=$?  probe=$([ -f "$work/probe.txt" ] && echo created || echo MISSING)"
echo "  stderr:"; tail -6 "$work/stderr.txt" | sed 's/^/    /'

echo
echo "=== 4. FULL stderr from a governor run (nothing truncated) ==="
work="$EXP_ROOT/runs/gov-full-stderr"; mkdir -p "$work"
rm -f "$EXP_ROOT/ledgers/A1-instrument.jsonl"
( cd "$work" && timeout 150 "$DSH" --profile headless --patch /tmp/overlay-a1.yml \
    "Create a file named probe.txt containing the word hello." \
    >"$work/stdout.txt" 2>"$work/stderr.txt" )
echo "  exit=$?"
echo "  stdout ($(wc -c <"$work/stdout.txt") bytes):"; sed 's/^/    /' "$work/stdout.txt" | head -20
echo "  stderr ($(wc -c <"$work/stderr.txt") bytes):"; sed 's/^/    /' "$work/stderr.txt" | head -40

echo
echo "=== 5. is there a debug/verbose switch? ==="
grep -rhoE 'DSH_[A-Z_]*(DEBUG|VERBOSE|TRACE|LOG)[A-Z_]*' "$HOST/node_modules/@deepseek-ai/" 2>/dev/null | sort -u | head -10 | sed 's/^/  /'
grep -rhoE '\b(DEBUG|VERBOSE)\b' "$HOST/node_modules/@deepseek-ai/dsh-cmdline/lib/"*.js 2>/dev/null | sort -u | head -5 | sed 's/^/  /'

echo
echo "=== investigation finished ==="
