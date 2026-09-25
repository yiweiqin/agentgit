#!/usr/bin/env bash
# The decisive capability check: can bubblewrap build a sandbox on this machine?
#
# The plan requires a full VM because DSH's sandbox uses Landlock + bubblewrap, and
# bubblewrap needs to create user and mount namespaces. A shared Docker container
# usually refuses, which is why this is checked before anything is installed: an hour
# spent on a toolchain that cannot be tested is worse than a minute spent here.
#
# It also checks the *actual* resource allocation rather than the host's, which on a
# shared container are wildly different numbers (host reported 208 CPUs and 754 GB;
# the cgroup allows 5 CPUs and 2 GiB).
set -u

echo "=== install sandbox tooling ==="
export DEBIAN_FRONTEND=noninteractive
apt-get -qq install -y bubblewrap zstd >/tmp/apt.log 2>&1 && echo "apt install: ok" || {
  echo "apt install: FAILED"
  tail -20 /tmp/apt.log
}
echo "bwrap: $(command -v bwrap || echo missing)"
echo "zstd:  $(command -v zstd || echo missing)"

echo
echo "=== real allocation (cgroup, not host) ==="
cpu_max=$(cat /sys/fs/cgroup/cpu.max 2>/dev/null || echo "n/a")
mem_max=$(cat /sys/fs/cgroup/memory.max 2>/dev/null || echo "n/a")
echo "cpu.max:    $cpu_max   (quota/period in microseconds)"
echo "memory.max: $mem_max bytes"
if [ "$cpu_max" != "n/a" ]; then
  echo "cpus_allowed: $(awk '{if ($1=="max") print "unlimited"; else printf "%.1f", $1/$2}' <<<"$cpu_max")"
fi
if [ "$mem_max" != "n/a" ] && [ "$mem_max" != "max" ]; then
  echo "memory_allowed_gb: $(awk -v m="$mem_max" 'BEGIN{printf "%.2f", m/1073741824}')"
fi

echo
echo "=== DECISIVE TEST: can bwrap build a sandbox? ==="
if command -v bwrap >/dev/null 2>&1; then
  set +e
  bwrap \
    --ro-bind /usr /usr \
    --ro-bind /lib /lib \
    --ro-bind /lib64 /lib64 \
    --ro-bind /bin /bin \
    --dev /dev \
    --proc /proc \
    --unshare-all \
    --die-with-parent \
    /bin/sh -c 'echo "bwrap_sandbox_WORKS uid=$(id -u)"; ls /usr/bin/head >/dev/null && echo "reads_usr: yes"'
  bwrap_status=$?
  set -e
  echo "bwrap_exit=$bwrap_status"
else
  echo "bwrap_exit=127 (not installed, cannot test)"
fi

echo
echo "=== is a writable repo sandbox possible? ==="
# The experiment needs each arm and round isolated in its own worktree, so the sandbox
# must be able to bind a writable directory, not just read-only system paths.
SANDBOX_BASE=/root/autodl-tmp/coord-exp
mkdir -p "$SANDBOX_BASE/bindtest"
echo "hello" >"$SANDBOX_BASE/bindtest/probe.txt"
set +e
bwrap \
  --ro-bind /usr /usr \
  --ro-bind /lib /lib \
  --ro-bind /lib64 /lib64 \
  --ro-bind /bin /bin \
  --dev /dev \
  --proc /proc \
  --bind "$SANDBOX_BASE/bindtest" /work \
  --chdir /work \
  --unshare-all \
  --die-with-parent \
  /bin/sh -c 'cat /work/probe.txt && echo "writable_bind_read: ok" && echo more >>/work/probe.txt && echo "writable_bind_write: ok"'
echo "writable_bind_exit=$?"
set -e

echo
echo "=== probe finished ==="
