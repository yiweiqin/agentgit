"""Fetch public PR context for Gate A annotation packets, with local caching.

This script is *best effort* and must never be required for the annotation pipeline to
run. `build_annotation_packets.py` works fully offline; this script only enriches the
prediction view with task descriptions, declared acceptance criteria and review
discussion, which Gate A needs but which are not recoverable from Git objects.

Properties that matter for the research protocol:

* every fetched payload is cached on disk together with the retrieval timestamp,
  the request URL and the SHA-256 of the raw response body;
* a cached payload is reused unless `--refresh` is passed, so packet builds are
  reproducible and do not silently change when upstream text is edited;
* failures are recorded as explicit `unavailable` markers instead of being dropped,
  because Gate A forbids silently discarding missing evidence.

Usage (from the repository root of the research folder):

    python 03_基准与标注/benchmark/real-history/flask/git-history/fetch_pr_context.py
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent
CACHE = ROOT / "annotation" / "context_cache"
PRS = (5514, 5516, 5723, 5754, 5757, 5797, 5808, 5812, 5818, 5898)
REPO = "pallets/flask"
USER_AGENT = "accd-gate-a-pilot/1.0 (research annotation packet builder)"
FETCHER_VERSION = "1.0"


def _request(url: str, timeout: float) -> tuple[bool, int, str]:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "application/vnd.github+json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return True, resp.status, resp.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as exc:
        body = ""
        try:
            body = exc.read().decode("utf-8", errors="replace")
        except Exception:  # noqa: BLE001 - diagnostics only
            pass
        return False, exc.code, body
    except Exception as exc:  # noqa: BLE001 - network layer is unreliable by nature
        return False, 0, f"{type(exc).__name__}: {exc}"


def fetch_one(url: str, timeout: float, retries: int) -> dict:
    last = {"ok": False, "status": 0, "body": ""}
    for attempt in range(retries + 1):
        ok, status, body = _request(url, timeout)
        last = {"ok": ok, "status": status, "body": body}
        if ok:
            return last
        # 404 is deterministic: retrying cannot help.
        if status == 404:
            return last
        if attempt < retries:
            time.sleep(1.5 * (attempt + 1))
    return last


def endpoint_specs(pr: int) -> list[tuple[str, str]]:
    base = f"https://api.github.com/repos/{REPO}"
    return [
        ("pull", f"{base}/pulls/{pr}"),
        ("review_comments", f"{base}/pulls/{pr}/comments?per_page=100"),
        ("issue_comments", f"{base}/issues/{pr}/comments?per_page=100"),
    ]


def load_cache(pr: int) -> dict | None:
    path = CACHE / f"pr-{pr}.json"
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return None


def summarize_pull(payload: dict) -> dict:
    if not isinstance(payload, dict):
        return {}
    return {
        "title": payload.get("title"),
        "body": payload.get("body"),
        "state": payload.get("state"),
        "merged_at": payload.get("merged_at"),
        "created_at": payload.get("created_at"),
        "base_sha": (payload.get("base") or {}).get("sha"),
        "head_sha": (payload.get("head") or {}).get("sha"),
        "merge_commit_sha": payload.get("merge_commit_sha"),
        "changed_files": payload.get("changed_files"),
        "additions": payload.get("additions"),
        "deletions": payload.get("deletions"),
        "labels": [lab.get("name") for lab in payload.get("labels") or [] if isinstance(lab, dict)],
        "author": (payload.get("user") or {}).get("login"),
    }


def summarize_comments(payload: object) -> list[dict]:
    if not isinstance(payload, list):
        return []
    out = []
    for item in payload:
        if not isinstance(item, dict):
            continue
        out.append(
            {
                "author": (item.get("user") or {}).get("login"),
                "created_at": item.get("created_at"),
                "path": item.get("path"),
                "body": item.get("body"),
            }
        )
    return out


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--refresh", action="store_true", help="re-fetch even when a cached payload exists")
    parser.add_argument("--timeout", type=float, default=20.0, help="per-request timeout in seconds")
    parser.add_argument("--retries", type=int, default=2, help="retries per endpoint on network failure")
    parser.add_argument("--sleep", type=float, default=0.6, help="delay between API calls to be polite")
    args = parser.parse_args()

    CACHE.mkdir(parents=True, exist_ok=True)
    summary = []

    for pr in PRS:
        cache_path = CACHE / f"pr-{pr}.json"
        existing = None if args.refresh else load_cache(pr)

        if existing and all(
            existing.get("fetched", {}).get(key, {}).get("ok") for key in ("pull", "review_comments", "issue_comments")
        ):
            summary.append({"pr": pr, "source": "cache", "pull_status": existing["fetched"]["pull"].get("status")})
            print(f"[cache] pr-{pr}", file=sys.stderr)
            continue

        record = {
            "fetcher_version": FETCHER_VERSION,
            "repository": REPO,
            "pr_number": pr,
            "retrieved_at_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "fetched": {},
            "request_urls": {},
            "response_sha256": {},
            "data": {},
        }

        degraded = False
        for key, url in endpoint_specs(pr):
            result = fetch_one(url, args.timeout, args.retries)
            record["request_urls"][key] = url
            record["fetched"][key] = {
                "ok": bool(result["ok"]),
                "status": result["status"],
                "bytes": len(result["body"]),
            }
            if result["ok"]:
                record["response_sha256"][key] = hashlib.sha256(result["body"].encode("utf-8")).hexdigest()
                try:
                    payload = json.loads(result["body"])
                except json.JSONDecodeError:
                    payload = None
                    record["fetched"][key]["ok"] = False
                    record["fetched"][key]["error"] = "invalid_json"
                    degraded = True
            else:
                payload = None
                degraded = True
                if result["status"]:
                    record["fetched"][key]["error"] = f"http_{result['status']}"
                else:
                    record["fetched"][key]["error"] = "network_error"

            if key == "pull":
                record["data"]["pull"] = summarize_pull(payload) if isinstance(payload, dict) else {}
            else:
                record["data"][key] = summarize_comments(payload)

            time.sleep(args.sleep)

        record["degraded"] = degraded
        record["availability_note"] = (
            "Enriched from the public GitHub API; task text is upstream-authored, not researcher-authored."
            if not degraded
            else "Partially or fully unavailable at retrieval time; annotators must treat missing evidence as missing."
        )
        cache_path.write_text(json.dumps(record, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        summary.append({"pr": pr, "source": "network", "degraded": degraded})
        print(f"[fetch] pr-{pr} degraded={degraded}", file=sys.stderr)

    ok = sum(1 for row in summary if not row.get("degraded", True))
    print(
        json.dumps(
            {
                "cache_dir": str(CACHE),
                "prs": len(PRS),
                "fully_available": ok,
                "degraded": len(PRS) - ok,
                "records": summary,
            },
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
