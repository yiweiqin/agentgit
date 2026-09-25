"""Download public PR patch mailboxes for the strict candidate queue.

This uses public pull/<number>.patch URLs rather than the GitHub REST API. It
stores hashes and never interprets a patch as a conflict or duplicate label.
"""

from __future__ import annotations

import hashlib
import json
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.request import Request, urlopen


ROOT = Path(__file__).resolve().parent
QUEUE = ROOT / "annotation_queue.jsonl"
OUT = ROOT / "candidate_patches"
MANIFEST = ROOT / "candidate_patch_manifest.json"
HEADERS = {"User-Agent": "ai-change-coordination-research/0.1"}


def download(number: int) -> bytes:
    request = Request(f"https://github.com/pallets/flask/pull/{number}.patch", headers=HEADERS)
    with urlopen(request, timeout=60) as response:  # noqa: S310 - fixed public GitHub host
        return response.read()


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    queue = [json.loads(line) for line in QUEUE.read_text(encoding="utf-8").splitlines() if line.strip()]
    numbers = sorted({int(row["evidence"][key]) for row in queue for key in ("left_pr", "right_pr")})
    records = []
    for number in numbers:
        target = OUT / f"pr-{number}.patch"
        status = "downloaded"
        error = None
        try:
            payload = download(number)
            target.write_bytes(payload)
        except Exception as exc:  # pragma: no cover - network-dependent branch
            status = "failed"
            error = f"{type(exc).__name__}: {exc}"
            payload = b""
        records.append(
            {
                "pr_number": number,
                "url": f"https://github.com/pallets/flask/pull/{number}.patch",
                "status": status,
                "bytes": len(payload),
                "sha256": hashlib.sha256(payload).hexdigest() if payload else None,
                "error": error,
            }
        )
        time.sleep(0.2)

    manifest = {
        "repository": "pallets/flask",
        "retrieved_at_utc": datetime.now(timezone.utc).isoformat(),
        "source": "public pull/<number>.patch URLs",
        "records": records,
        "ground_truth": "not_available; patches are evidence for independent annotation",
    }
    MANIFEST.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"records": len(records), "downloaded": sum(r["status"] == "downloaded" for r in records), "failed": sum(r["status"] == "failed" for r in records)}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
