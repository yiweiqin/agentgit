"""Optional external embedding baseline; never replaced with a fake embedding.

Provider command receives JSON on stdin: {task: 'embed', texts:[diffA,diffB]}.
Return {vectors:[[...],[...]], model: str, usage: object|null} on stdout.
The provider owns auth/network. No automatic model discovery or invocation.
"""

import json
import math
import shlex
import subprocess
from ..delta.model import Prediction


def invoke(command, payload):
    process = subprocess.run(
        shlex.split(command),
        input=json.dumps(payload),
        text=True,
        capture_output=True,
        timeout=180,
        check=True,
    )
    return json.loads(process.stdout)


def predict(command, diff_a, diff_b, a, b, threshold=0.80):
    raw = invoke(command, {"task": "embed", "texts": [diff_a, diff_b]})
    x, y = raw["vectors"]
    if (
        not x
        or len(x) != len(y)
        or not all(isinstance(v, (float, int)) and math.isfinite(v) for v in x + y)
    ):
        raise ValueError("Invalid embedding vectors")
    norm = math.sqrt(sum(v * v for v in x) * sum(v * v for v in y))
    if not norm:
        raise ValueError("Zero embedding norm")
    sim = sum(u * v for u, v in zip(x, y)) / norm
    # This is intentionally a similarity baseline, not our definition of conflict.
    candidates = sorted(set(a.symbols) & set(b.symbols)) + [
        "file:" + p for p in sorted(set(a.files) & set(b.files))
    ]
    return Prediction(
        "conflicting" if sim >= threshold else "independent",
        candidates[:3],
        sim,
        ["Fixed embedding cosine threshold"],
        {"model": raw.get("model"), "usage": raw.get("usage"), "threshold": threshold},
    )
