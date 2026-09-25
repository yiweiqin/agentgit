#!/usr/bin/env bash
# Which namespace is actually blocked? The answer decides whether a sandbox is possible.
#
# Reports so far: this is a Docker container (not the required full VM), bubblewrap
# cannot create namespaces, and the cgroup allows 0.5 CPU and 2 GiB -- against a stated
# minimum of 8 CPU and 32 GiB.
#
# But the failures above all came from `--unshare-all`, which includes a *user*
# namespace. We are uid 0, and root does not need a user namespace to create mount or
# PID namespaces. Landlock, which DSH also uses, is a syscall-level LSM needing no
# namespace at all. So "bwrap --unshare-all failed" does not yet prove the sandbox path
# is unusable, and concluding that from one error message would be sloppy.
set -u

echo "=== am I root? ==="
echo "uid=$(id -u) euid=$(id -u)"

echo
echo "=== namespace-by-namespace ==="
for ns in user mount pid uts ipc net cgroup; do
  case "$ns" in
    pid) args="--pid --fork" ;;
    net) args="--net" ;;
    *)   args="--$ns" ;;
  esac
  if unshare $args /bin/sh -c 'exit 0' 2>/dev/null; then
    echo "$ns: OK"
  else
    echo "$ns: BLOCKED"
  fi
done

echo
echo "=== landlock (syscall-level, no namespace needed) ==="
if command -v python3 >/dev/null 2>&1; then
  python3 - <<'PY'
import ctypes, errno, platform
libc = ctypes.CDLL("libc.so.6", use_errno=True)
# landlock_create_ruleset(NULL, 0, LANDLOCK_CREATE_RULESET_VERSION=1) returns the ABI version.
syscall_nr = 444 if platform.machine() == "x86_64" else None
if syscall_nr is None:
    print("landlock: cannot probe on this arch")
else:
    res = libc.syscall(syscall_nr, None, 0, 1)
    if res >= 0:
        print(f"landlock: SUPPORTED (ABI {res})")
    else:
        err = ctypes.get_errno()
        if err == errno.EOPNOTSUPP:
            print("landlock: not supported by kernel")
        else:
            print(f"landlock: probe failed errno={err} ({errno.errorcode.get(err, '?')})")
PY
else
  echo "landlock: cannot probe (no python3)"
fi

echo
echo "=== bwrap WITHOUT a user namespace (valid as root) ==="
set +e
bwrap \
  --ro-bind /usr /usr \
  --ro-bind /lib /lib \
  --ro-bind /lib64 /lib64 \
  --ro-bind /bin /bin \
  --dev /dev \
  --proc /proc \
  --unshare-pid \
  /bin/sh -c 'echo "bwrap_no_userns: WORKS uid=$(id -u)"'
echo "bwrap_no_userns_exit=$?"

echo
echo "=== minimal bwrap, no namespace flags at all ==="
bwrap --ro-bind /usr /usr --ro-bind /lib /lib --ro-bind /lib64 /lib64 --ro-bind /bin /bin --dev /dev --proc /proc /bin/sh -c 'echo "bwrap_minimal: WORKS"'
echo "bwrap_minimal_exit=$?"

echo
echo "=== writable bind without user namespace ==="
SANDBOX_BASE=/root/autodl-tmp/coord-exp
mkdir -p "$SANDBOX_BASE/bindtest"
echo hello >"$SANDBOX_BASE/bindtest/probe.txt"
bwrap \
  --ro-bind /usr /usr \
  --ro-bind /lib /lib \
  --ro-bind /lib64 /lib64 \
  --ro-bind /bin /bin \
  --dev /dev \
  --proc /proc \
  --bind "$SANDBOX_BASE/bindtest" /work \
  --chdir /work \
  /bin/sh -c 'cat /work/probe.txt; echo more >>/work/probe.txt && echo "writable_bind: WORKS"'
echo "writable_bind_exit=$?"
set -e

echo
echo "=== probe finished ==="
