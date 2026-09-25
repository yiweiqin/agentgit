#!/usr/bin/env bash
# Measure what this machine will actually do, as opposed to what it advertises.
#
# Why this exists: the host reports 208 vCPU / 754 GB, the cgroup reports 0.5 CPU /
# 2 GiB, and those cannot both be the number that matters. The experiment runs 4-8
# concurrent Node sessions plus builds, so the only figures worth trusting are ones
# measured from inside the container.
set -u

echo "=== advertised ==="
echo "nproc:          $(nproc)"
echo "cpuinfo cpus:   $(grep -c ^processor /proc/cpuinfo)"
echo "meminfo total:  $(awk '/MemTotal/ {printf "%.2f GiB", $2/1048576}' /proc/meminfo)"
echo "cpu.max:        $(cat /sys/fs/cgroup/cpu.max 2>/dev/null)"
echo "memory.max:     $(cat /sys/fs/cgroup/memory.max 2>/dev/null)"

echo
echo "=== cgroup v2 detail ==="
echo "cpu.stat (throttling):"
cat /sys/fs/cgroup/cpu.stat 2>/dev/null | sed 's/^/  /'
echo "memory.current: $(cat /sys/fs/cgroup/memory.current 2>/dev/null)"

echo
echo "=== measured single-core throughput ==="
# A fixed integer workload; the wall time is comparable across machines even though the
# absolute score is meaningless. /usr/bin/time is not guaranteed present, so use bash's
# own SECONDS-free timing via date.
start=$(date +%s.%N)
python3 - <<'PY'
total = 0
for i in range(0, 6_000_000):
    total += i * i % 7
print("  checksum:", total)
PY
end=$(date +%s.%N)
echo "  python_6M_iter_seconds: $(awk -v a="$start" -v b="$end" 'BEGIN{printf "%.2f", b-a}')"

echo
echo "=== measured parallel scaling (8 busy processes) ==="
start=$(date +%s.%N)
for _ in 1 2 3 4 5 6 7 8; do
  ( python3 -c "
total = 0
for i in range(0, 2_000_000):
    total += i * i % 7
" ) &
done
wait
end=$(date +%s.%N)
echo "  8x_parallel_seconds: $(awk -v a="$start" -v b="$end" 'BEGIN{printf "%.2f", b-a}')"
echo "  (a real 8-core box does this in roughly the same time as one job;"
echo "   a 0.5-core box takes about 16x longer)"

echo
echo "=== disk ==="
df -h / /root 2>/dev/null | sed 's/^/  /'
echo "  autodl-tmp:"
df -h /root/autodl-tmp 2>/dev/null | tail -1 | sed 's/^/    /'

echo
echo "=== can we actually spawn node-scale workloads? ==="
echo "free -m:"
free -m 2>/dev/null | sed 's/^/  /'

echo
echo "=== resource probe finished ==="
