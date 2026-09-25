#!/usr/bin/env bash
# Is the 2 GiB memory cap a soft limit we can live with, or a hard wall that kills
# builds? That distinction decides whether this machine is "slow" or "unusable".
#
# A TypeScript monorepo install plus build routinely peaks above 2 GiB, and Node's own
# default heap target is around 2 GiB, so this is not a hypothetical concern.
set -u

echo "=== has this container been OOM-killed before? ==="
cat /sys/fs/cgroup/memory.events 2>/dev/null | sed 's/^/  /'
echo "  memory.peak: $(cat /sys/fs/cgroup/memory.peak 2>/dev/null || echo n/a)"
echo "  swap.max:    $(cat /sys/fs/cgroup/swap.max 2>/dev/null || echo n/a)"

echo
echo "=== allocation test: can we hold ~1.4 GiB in one process? ==="
set +e
python3 - <<'PY'
import sys
try:
    chunk = 128 * 1024 * 1024  # 128 MiB
    blocks = []
    for i in range(11):        # ~1.4 GiB
        blocks.append(bytearray(chunk))
        for b in blocks:
            b[0] = 1          # touch it, so it is real resident memory
        print(f"  allocated {(i + 1) * 128} MiB: ok")
    print("  RESULT: 1.4 GiB in one process is FINE")
except MemoryError:
    print("  RESULT: MemoryError -- hit the cap")
sys.exit(0)
PY
alloc_status=$?
echo "  alloc_exit=$alloc_status"
set -e

echo
echo "=== what actually happened to memory during that test ==="
cat /sys/fs/cgroup/memory.events 2>/dev/null | sed 's/^/  /'

echo
echo "=== is the toolchain even present? ==="
for tool in node pnpm npm git python3 zstd curl; do
  loc=$(command -v "$tool" 2>/dev/null || echo missing)
  if [ "$loc" != "missing" ]; then
    printf '  %-8s %s  (%s)\n' "$tool" "$loc" "$("$tool" --version 2>&1 | head -1)"
  else
    printf '  %-8s %s\n' "$tool" "$loc"
  fi
done

echo
echo "=== kernel and libc ==="
echo "  $(uname -r)"
echo "  $(ldd --version 2>&1 | head -1)"
echo "  /etc/os-release: $(. /etc/os-release 2>/dev/null && echo "$PRETTY_NAME")"

echo
echo "=== resource probe finished ==="
