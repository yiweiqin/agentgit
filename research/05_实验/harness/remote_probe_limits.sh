#!/usr/bin/env bash
# Measure what this machine actually hands us, as opposed to what it advertises.
#
# Both machines so far are AutoDL containers that report the *host's* nproc and
# MemTotal, so those numbers say nothing about our quota. The plan's requirements
# (kernel >= 5.13 for Landlock, enough real CPU for concurrency) are the two things
# that decide whether E1/E3 are even meaningful here, so they get measured directly.
set -u

echo "=== identity ==="
echo "user: $(id -un)  uid: $(id -u)"
echo "kernel: $(uname -r)"
echo "cpu_affinity: $(grep Cpus_allowed_list /proc/self/status)"
echo "nproc: $(nproc)"

echo
echo "=== cgroup cpu/memory quota (the real allocation) ==="
if [ -f /sys/fs/cgroup/cgroup.controllers ]; then
  echo "cgroup: v2"
  for f in cpu.max cpu.weight memory.max memory.high pids.max; do
    [ -f "/sys/fs/cgroup/$f" ] && echo "  $f: $(cat /sys/fs/cgroup/$f)"
  done
else
  echo "cgroup: v1 or hybrid (controller dirs)"
  for ctrl in cpu cpuacct memory pids; do
    c="/sys/fs/cgroup/$ctrl"
    [ -d "$c" ] || continue
    [ -f "$c/cpu.cfs_quota_us" ] && echo "  cpu: quota=$(cat $c/cpu.cfs_quota_us) period=$(cat $c/cpu.cfs_period_us)"
    [ -f "$c/memory.limit_in_bytes" ] && echo "  memory.limit_in_bytes: $(cat $c/memory.limit_in_bytes)"
    [ -f "$c/memory.soft_limit_in_bytes" ] && echo "  memory.soft_limit: $(cat $c/memory.soft_limit_in_bytes)"
    [ -f "$c/pids.max" ] && echo "  pids.max: $(cat $c/pids.max)"
  done
  # The container's own cgroup path usually carries the quota even when the root does not.
  sub="/sys/fs/cgroup/$(awk -F: '/:cpu/ {print $3}' /proc/self/cgroup 2>/dev/null | sed 's|^/||')"
  [ -d "$sub" ] && echo "  (our cgroup: $sub)" && for f in cpu.cfs_quota_us cpu.cfs_period_us memory.limit_in_bytes; do
    [ -f "$sub/$f" ] && echo "    $f: $(cat $sub/$f)"
  done
fi

echo
echo "=== memory reality check ==="
awk '/MemTotal|MemAvailable|SwapTotal/ {printf "  %s %.1f GB\n", $1, $2/1048576}' /proc/meminfo

echo
echo "=== disk ==="
df -h / /root /tmp 2>/dev/null | sort -u
echo "  workdir candidates:"
for d in /root/autodl-tmp /root/autodl-fs /root/autodl-pub; do
  [ -d "$d" ] && echo "    $d -> $(df -BG --output=avail "$d" 2>/dev/null | tail -1 | tr -dc '0-9')GB avail"
done

echo
echo "=== Landlock (DSH's sandbox backend; needs kernel >= 5.13, ABI >= 1) ==="
echo "  kernel_supports_landlock_by_version: $(awk -v k="$(uname -r)" 'BEGIN {
  split(k, v, "."); maj=v[1]+0; min=v[2]+0;
  if (maj > 5 || (maj == 5 && min >= 13)) print "yes"; else print "NO (needs >= 5.13)"
}')"
echo "  securityfs_landlock: $([ -e /sys/kernel/security/landlock ] && echo present || echo absent)"
echo "  kallsyms_landlock_hits: $(grep -c 'landlock' /proc/kallsyms 2>/dev/null || echo unreadable)"
echo "  syscall_table(444): $(grep -c ' sys_landlock_create_ruleset' /proc/kallsyms 2>/dev/null || echo unreadable)"

echo
echo "=== user namespaces + bubblewrap ==="
echo "  max_user_namespaces: $(cat /proc/sys/user/max_user_namespaces 2>/dev/null || echo unreadable)"
echo "  unprivileged_userns_clone: $(cat /proc/sys/kernel/unprivileged_userns_clone 2>/dev/null || echo 'not applicable')"
# The sysctl reading can lie in containers; the only honest test is to actually create one.
if unshare --user --map-root-user /bin/sh -c 'exit 0' 2>/dev/null; then
  echo "  unshare_user_ns: WORKS"
else
  echo "  unshare_user_ns: FAILS"
fi
for ns in mount pid uts ipc net cgroup; do
  if unshare --$ns /bin/sh -c 'exit 0' 2>/dev/null; then
    echo "  unshare_$ns: WORKS"
  else
    echo "  unshare_$ns: FAILS"
  fi
done

echo
echo "=== done ==="
