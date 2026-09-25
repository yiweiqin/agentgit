"""Run commands on the experimental machine, and check it can actually host the experiment.

Credentials come from the environment and are never written to disk:

    DSH_SSH_HOST, DSH_SSH_PORT (default 22), DSH_SSH_USER (default root), DSH_SSH_PASSWORD

Why this exists as a file rather than a shell one-liner: the probe below encodes a hard
requirement that is easy to skip and expensive to discover late. The plan requires a
*full VM*, because DSH's sandbox uses Linux Landlock plus bubblewrap, and bubblewrap
cannot create the user namespaces it needs inside most shared containers. A harness that
starts installing toolchains before checking this burns an hour and then reports a
sandbox failure that looks like a DSH bug.

Usage
-----
    python harness/remote.py probe
    python harness/remote.py run -- "uname -a"
    python harness/remote.py run --sudo -- "apt-get install -y git"
"""

from __future__ import annotations

import argparse
import io
import os
import shlex
import stat
import sys
from pathlib import Path, PurePosixPath
from typing import Sequence

import paramiko

# A UTF-8 BOM at the start of a file is invisible in most editors and fatal in specific,
# hard-to-diagnose places. Two that have already cost real time on this project:
#
#   * shell scripts: the remote shell reads the BOM as part of the interpreter path and
#     reports "/usr/bin/env: No such file or directory".
#   * `package.json`: `JSON.parse` throws. DSH's plugin-package-inventory walks up from every
#     active plugin entry to its owning manifest and parses it, so a BOM in a *mounted
#     plugin's* manifest surfaces as `REQUEST_EXTENSION: DeepSeek request extension
#     preparation failed` -- an error that names neither the file nor the BOM, and which we
#     spent a long detour misattributing to module duplication.
#
# Windows tooling adds BOMs readily, so the harness strips them on the way out rather than
# trusting that each file was saved correctly.
BOM = b"\xef\xbb\xbf"

TEXT_SUFFIXES = frozenset(
    {
        "", ".ts", ".tsx", ".js", ".mjs", ".cjs", ".json", ".jsonl", ".py", ".sh",
        ".ps1", ".md", ".yml", ".yaml", ".toml", ".cfg", ".ini", ".txt", ".csv",
    }
)


def strip_bom(raw: bytes) -> bytes:
    """Drop a leading UTF-8 BOM. Returns the input unchanged when there is none."""
    return raw[len(BOM):] if raw.startswith(BOM) else raw

PROBE = r"""
set -u
echo "=== identity ==="
echo "uname: $(uname -a)"
[ -f /etc/os-release ] && . /etc/os-release && echo "distro: ${PRETTY_NAME:-unknown}"
echo "kernel: $(uname -r)"
echo "arch: $(uname -m)"
echo "cpu: $(nproc)"
echo "mem_gb: $(awk '/MemTotal/ {printf "%.1f", $2/1048576}' /proc/meminfo)"
echo "disk_gb: $(df -BG --output=size / 2>/dev/null | tail -1 | tr -dc '0-9')"

echo "=== virtualisation (the hard requirement) ==="
echo "systemd-detect-virt: $(systemd-detect-virt 2>/dev/null || echo 'not available')"
if [ -f /.dockerenv ]; then echo "dockerenv: PRESENT (container)"; else echo "dockerenv: absent"; fi
if [ -f /run/.containerenv ]; then echo "containerenv: PRESENT (container)"; else echo "containerenv: absent"; fi
echo "cgroup: $(awk -F: '/0::/ {print $3}' /proc/self/cgroup 2>/dev/null || echo unknown)"
grep -q 'docker\|containerd\|lxc\|kubepods' /proc/1/cgroup 2>/dev/null && echo "cgroup_hint: container" || echo "cgroup_hint: none"
echo "kvm_device: $([ -e /dev/kvm ] && echo present || echo absent)"

echo "=== user namespaces (bubblewrap depends on this) ==="
echo "max_user_namespaces: $(cat /proc/sys/user/max_user_namespaces 2>/dev/null || echo 'unreadable')"
echo "unprivileged_userns_clone: $(cat /proc/sys/kernel/unprivileged_userns_clone 2>/dev/null || echo 'not applicable')"
echo "apparmor_userns: $(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null || echo 'not present')"

echo "=== sandbox tooling ==="
for b in bwrap unshare newuidmap zstd curl git python3 node pnpm npm; do
  printf '%s: %s\n' "$b" "$(command -v $b 2>/dev/null || echo missing)"
done
echo "node_version: $(node --version 2>/dev/null || echo none)"
echo "python_version: $(python3 --version 2>/dev/null || echo none)"
echo "landlock: $(grep -c landlock /proc/kallsyms 2>/dev/null || echo unknown)"
echo "sudo: $(sudo -n true 2>/dev/null && echo passwordless || echo 'needs-password-or-absent')"
echo "=== probe done ==="
"""


def connect() -> paramiko.SSHClient:
    host = os.environ.get("DSH_SSH_HOST")
    user = os.environ.get("DSH_SSH_USER", "root")
    password = os.environ.get("DSH_SSH_PASSWORD")
    port = int(os.environ.get("DSH_SSH_PORT", "22"))
    if not host or not password:
        raise SystemExit("set DSH_SSH_HOST and DSH_SSH_PASSWORD in the environment")

    client = paramiko.SSHClient()
    # The host key is not known ahead of time, and refusing to connect would only
    # protect against an attacker who already controls DNS for the provider. Recorded
    # rather than silently ignored: the probe prints the fingerprint.
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(
        hostname=host,
        port=port,
        username=user,
        password=password,
        timeout=30,
        allow_agent=False,
        look_for_keys=False,
    )
    return client


def run(client: paramiko.SSHClient, command: str, timeout: int = 900) -> tuple[int, str, str]:
    stdin, stdout, stderr = client.exec_command(command, timeout=timeout, get_pty=False)
    stdin.close()
    out = stdout.read().decode("utf-8", "replace")
    err = stderr.read().decode("utf-8", "replace")
    return stdout.channel.recv_exit_status(), out, err


def run_script(client: paramiko.SSHClient, script: str, timeout: int = 3600) -> tuple[int, str, str]:
    """Run a multi-line script on the machine by piping it to `bash -s`.

    Piping beats building a quoted one-liner: nesting shell quotes through SSH through
    PowerShell mangles the script in ways that produce confusing *remote* syntax errors,
    and a partial install can leave the machine in a state that makes the next failure
    even harder to read.
    """
    stdin, stdout, stderr = client.exec_command("bash -s", timeout=timeout, get_pty=False)
    stdin.write(script)
    stdin.channel.shutdown_write()
    out = stdout.read().decode("utf-8", "replace")
    err = stderr.read().decode("utf-8", "replace")
    return stdout.channel.recv_exit_status(), out, err


def sftp_download(client: paramiko.SSHClient, remote: str, local: str) -> int:
    """Copy a file or directory tree from the machine.

    Directory support matters here: the type definitions that the plugin must be checked
    against are spread across hundreds of `@deepseek-ai/*` packages, and fetching them
    one file at a time is not practical.
    """
    sftp = client.open_sftp()
    count = 0
    try:
        try:
            attrs = sftp.stat(remote)
        except OSError as exc:
            print(f"remote path not found: {remote} ({exc})", file=sys.stderr)
            return 2

        if not stat.S_ISDIR(attrs.st_mode):
            Path(local).parent.mkdir(parents=True, exist_ok=True)
            sftp.get(remote, local)
            return 1

        local_root = Path(local)
        local_root.mkdir(parents=True, exist_ok=True)
        stack: list[tuple[str, Path]] = [(remote.rstrip("/"), local_root)]
        while stack:
            remote_dir, local_dir = stack.pop()
            local_dir.mkdir(parents=True, exist_ok=True)
            for entry in sftp.listdir_attr(remote_dir):
                remote_path = f"{remote_dir}/{entry.filename}"
                local_path = local_dir / entry.filename
                if stat.S_ISDIR(entry.st_mode):
                    stack.append((remote_path, local_path))
                elif stat.S_ISREG(entry.st_mode):
                    try:
                        sftp.get(remote_path, str(local_path))
                        count += 1
                    except OSError as exc:
                        print(f"  skipped {remote_path}: {exc}", file=sys.stderr)
        return count
    finally:
        sftp.close()


def sftp_upload(client: paramiko.SSHClient, local: str, remote: str) -> int:
    """Copy a file or directory tree to the machine, creating parent directories.

    Text files are uploaded with any leading UTF-8 BOM removed; see the note on `BOM` above
    for why a single stray BOM can otherwise break a whole experimental run.
    """
    sftp = client.open_sftp()
    count = 0

    def ensure_remote_dir(path: str) -> None:
        parts = path.strip("/").split("/")
        current = ""
        for part in parts:
            current = f"{current}/{part}" if current else f"/{part}"
            try:
                sftp.stat(current)
            except OSError:
                sftp.mkdir(current)

    def put_one(source: Path, target: str) -> None:
        if source.suffix.lower() in TEXT_SUFFIXES:
            sftp.putfo(io.BytesIO(strip_bom(source.read_bytes())), target)
        else:
            sftp.put(str(source), target)

    local_path = Path(local)
    try:
        if local_path.is_file():
            ensure_remote_dir(str(PurePosixPath(remote).parent))
            put_one(local_path, remote)
            return 1
        if not local_path.is_dir():
            print(f"local path not found: {local}", file=sys.stderr)
            return 2

        base = str(PurePosixPath(remote).parent)
        ensure_remote_dir(base)
        for path in sorted(local_path.rglob("*")):
            relative = path.relative_to(local_path).as_posix()
            target = f"{remote.rstrip('/')}/{relative}"
            if path.is_dir():
                ensure_remote_dir(target)
            else:
                # `node_modules` and `.git` are never worth transferring, and on this
                # connection they dominate the time.
                if any(part in {".git", "node_modules", "__pycache__"} for part in path.parts):
                    continue
                ensure_remote_dir(str(PurePosixPath(target).parent))
                put_one(path, target)
                count += 1
        return count
    finally:
        sftp.close()


def debom(root: Path) -> int:
    """Strip UTF-8 BOMs from text files under `root`, in place.

    Run this before a session that will execute or parse the tree remotely. Kept as a
    command rather than a one-off cleanup because the failure it prevents is silent and
    the cause is easy to reintroduce with a different editor or tool.
    """
    stripped: list[str] = []
    for path in sorted(root.rglob("*")):
        if not path.is_file() or path.suffix.lower() not in TEXT_SUFFIXES:
            continue
        if {".git", "node_modules", "__pycache__", "vendor"} & set(path.parts):
            continue
        raw = path.read_bytes()
        if raw.startswith(BOM):
            path.write_bytes(strip_bom(raw))
            stripped.append(str(path.relative_to(root)))
    print(f"stripped {len(stripped)} BOM(s)")
    for name in stripped:
        print(f"  {name}")
    return 0 if not stripped else 1


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("probe", help="report machine identity and sandbox capability")

    run_parser = sub.add_parser("run", help="run one command on the machine")
    run_parser.add_argument("--sudo", action="store_true", help="wrap the command in sudo -n")
    run_parser.add_argument("--timeout", type=int, default=900)
    run_parser.add_argument("remote_command", nargs=argparse.REMAINDER)

    script_parser = sub.add_parser("script", help="run a local shell script on the machine via bash -s")
    script_parser.add_argument("path", help="local .sh file")
    script_parser.add_argument("--timeout", type=int, default=3600)

    get_parser = sub.add_parser("get", help="copy a file or directory from the machine")
    get_parser.add_argument("remote", help="remote path")
    get_parser.add_argument("local", help="local path")

    put_parser = sub.add_parser("put", help="copy a file or directory to the machine")
    put_parser.add_argument("local", help="local path")
    put_parser.add_argument("remote", help="remote path")

    debom_parser = sub.add_parser(
        "debom", help="strip UTF-8 BOMs from local text files (no SSH needed)"
    )
    debom_parser.add_argument("root", nargs="?", default=".", help="local directory to clean")

    args = parser.parse_args(argv)

    # `debom` is purely local, so it must not require credentials. Being able to clean a
    # tree without a live machine is the point: a BOM is a property of the checkout.
    if args.command == "debom":
        return debom(Path(args.root))

    client = connect()
    try:
        if args.command == "probe":
            code, out, err = run(client, PROBE)
            print(out)
            if err.strip():
                print("--- stderr ---", file=sys.stderr)
                print(err, file=sys.stderr)
            return code

        if args.command == "script":
            # Editors and file tools on Windows like to prepend a UTF-8 BOM, which the
            # remote shell then reads as part of the shebang, producing the thoroughly
            # misleading "/usr/bin/env: No such file or directory". Strip it here so
            # every script gets the same treatment instead of depending on how it was saved.
            script = strip_bom(Path(args.path).read_bytes()).decode("utf-8")
            code, out, err = run_script(client, script, timeout=args.timeout)
            print(out)
            if err.strip():
                print("--- stderr ---", file=sys.stderr)
                print(err, file=sys.stderr)
            return code

        if args.command == "get":
            count = sftp_download(client, args.remote, args.local)
            print(f"downloaded {count} file(s) -> {args.local}")
            return 0 if count else 1

        if args.command == "put":
            count = sftp_upload(client, args.local, args.remote)
            print(f"uploaded {count} file(s) -> {args.remote}")
            return 0 if count else 1

        command = " ".join(args.remote_command).lstrip("- ").strip()
        if not command:
            print("no command given", file=sys.stderr)
            return 2
        if args.sudo:
            command = f"sudo -n bash -lc {shlex.quote(command)}"
        code, out, err = run(client, command, timeout=args.timeout)
        print(out)
        if err.strip():
            print("--- stderr ---", file=sys.stderr)
            print(err, file=sys.stderr)
        return code
    finally:
        client.close()


if __name__ == "__main__":
    raise SystemExit(main())
