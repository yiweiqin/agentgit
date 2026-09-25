#!/usr/bin/env bash
# Map out the CLI, the headless profile, and where credentials are expected to persist.
#
# Read-only on purpose. The previous round established that the plugin loads in a real
# DSH session, so the remaining unknowns are all configuration-shaped: which model id to
# ask for, whether the key must be an env var or a stored credential, and what the
# headless profile actually composes. Discovering those by trial and error costs API
# calls; discovering them by reading costs nothing.
set -uo pipefail

EXP_ROOT=/root/autodl-tmp/coord-exp
HOST="$EXP_ROOT/dsh-host"
cd "$HOST"

echo "=== 1. dsh CLI surface ==="
node_modules/.bin/dsh --help 2>&1 | head -45 | sed 's/^/  /'

echo
echo "=== 2. headless profile ==="
cat node_modules/@deepseek-ai/dsh-headless/cordis.patch.yml 2>/dev/null | sed 's/^/  /'

echo
echo "=== 3. how the deepseek plugin resolves its key ==="
grep -oE 'DEFAULT_API_KEY_ENV *= *[^;]{0,60}' node_modules/@deepseek-ai/dsh-llm-deepseek/lib/index.js | head -3 | sed 's/^/  /'
grep -oE '(env|process\.env)\.DEEPSEEK[A-Z_]*' node_modules/@deepseek-ai/dsh-llm-deepseek/lib/index.js | sort -u | head | sed 's/^/  /'
echo "  --- config knobs the plugin accepts ---"
grep -oE 'apiKey|apiKeyEnv|baseURL|baseUrl|model|models|route' node_modules/@deepseek-ai/dsh-llm-deepseek/lib/index.js |
  sort | uniq -c | sort -rn | head -12 | sed 's/^/    /'

echo
echo "=== 4. credential storage plugin ==="
ls node_modules/@deepseek-ai/ | grep -i credential | sed 's/^/  /'
for f in node_modules/@deepseek-ai/dsh-credentials-local/lib/index.js; do
  [ -f "$f" ] && echo "  --- paths referenced in $(dirname $(dirname $f)) ---" &&
    grep -oE '"[a-zA-Z0-9_./-]*\.json"|credentials[a-zA-Z0-9_.-]*' "$f" | sort -u | head -12 | sed 's/^/    /'
done

echo
echo "=== 5. default config, resolved for the headless profile ==="
node_modules/.bin/dsh --profile headless --dump-default-config 2>&1 | grep -iE 'llm|model|deepseek|sandbox' | head -30 | sed 's/^/  /'

echo
echo "=== 6. sandbox plugins present (none of them can work here) ==="
ls node_modules/@deepseek-ai/ | grep -i sandbox | sed 's/^/  /'

echo
echo "=== 7. danger-full-access escape hatch ==="
grep -rhoE 'danger[-_]full[-_]access|dangerously[a-zA-Z-]*' node_modules/@deepseek-ai/dsh-sandbox*/lib/*.js 2>/dev/null | sort -u | head -8 | sed 's/^/  /'

echo
echo "=== discovery finished ==="
