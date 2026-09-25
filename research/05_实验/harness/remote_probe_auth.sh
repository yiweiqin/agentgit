#!/usr/bin/env bash
# Work out which endpoint and model id this key is actually good for.
#
# The key came from a config block that specified `wire_api = "responses"`, which is not
# the shape of DeepSeek's public OpenAI-compatible API. A bare 401 against /models cannot
# distinguish "bad key" from "right key, wrong door", and those have completely different
# fixes, so this tries the plausible doors and reports the body of each rejection.
#
# The key is read from a remote file rather than embedded, so it never lands in a tracked
# script in the repository.
set -uo pipefail

KEYFILE=/root/.coord-deepseek-key
if [ ! -f "$KEYFILE" ]; then
  echo "no key at $KEYFILE; nothing to test"
  exit 1
fi
KEY=$(cat "$KEYFILE")
echo "key: ${#KEY} chars, prefix ${KEY:0:6}..., suffix ...${KEY: -4}"
echo

probe() {
  local label="$1" method="$2" url="$3" body="${4:-}"
  local out status
  if [ "$method" = GET ]; then
    out=$(curl -s -m 30 -w $'\n[status=%{http_code}]' -H "Authorization: Bearer $KEY" "$url" 2>&1)
  else
    out=$(curl -s -m 30 -w $'\n[status=%{http_code}]' -X POST "$url" \
      -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' -d "$body" 2>&1)
  fi
  status=$(printf '%s' "$out" | grep -oE '\[status=[0-9]+\]' | tail -1)
  echo "--- $label"
  echo "    $status"
  printf '%s' "$out" | grep -v '\[status=' | head -c 260 | sed 's/^/    /'
  echo
}

echo "=== GET endpoints ==="
probe "api.deepseek.com/models"        GET "https://api.deepseek.com/models"
probe "api.deepseek.com/v1/models"     GET "https://api.deepseek.com/v1/models"
probe "api.deepseek.com/user/balance"  GET "https://api.deepseek.com/user/balance"

echo "=== POST chat/completions (public shape) ==="
probe "model=deepseek-chat"  POST "https://api.deepseek.com/chat/completions" \
  '{"model":"deepseek-chat","messages":[{"role":"user","content":"hi"}],"max_tokens":1}'
probe "model=deepseek-flash" POST "https://api.deepseek.com/chat/completions" \
  '{"model":"deepseek-flash","messages":[{"role":"user","content":"hi"}],"max_tokens":1}'
probe "model=deepseek-v4-flash" POST "https://api.deepseek.com/chat/completions" \
  '{"model":"deepseek-v4-flash","messages":[{"role":"user","content":"hi"}],"max_tokens":1}'

echo "=== POST /responses (what the config specified) ==="
probe "responses model=deepseek-flash" POST "https://api.deepseek.com/responses" \
  '{"model":"deepseek-flash","input":"hi"}'

echo "=== what DSH itself targets ==="
HOST=/root/autodl-tmp/coord-exp/dsh-host
echo "  default base URL / route constants in llm-deepseek:"
grep -oE 'https://[a-zA-Z0-9./_-]*deepseek[a-zA-Z0-9./_-]*' \
  "$HOST/node_modules/@deepseek-ai/dsh-llm-deepseek/lib/index.js" 2>/dev/null | sort -u | head | sed 's/^/    /'
grep -oE 'api\.deepseek\.com[a-zA-Z0-9./_-]*|DEEPSEEK_BASE[A-Z_]*|baseURL[^,;]{0,40}' \
  "$HOST/node_modules/@deepseek-ai/dsh-llm-deepseek/lib/index.js" 2>/dev/null | sort -u | head | sed 's/^/    /'

echo
echo "=== probe finished ==="
