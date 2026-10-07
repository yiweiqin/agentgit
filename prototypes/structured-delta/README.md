# Structured program-state delta prototype

This standalone Python prototype detects interactions between two changes from a
common source snapshot. It uses AST symbols, import/call dependencies, signatures,
limited return contracts and state read/write observations to classify changes as
`independent`, `compatible`, `redundant` or `conflicting` and locate affected entities.
It is separate from AgentGit's product runtime and has no automatic repair or
live-agent integration.

Requirements: Python **>=3.11** and Git **>=2.38**. Runtime dependencies are entirely
in the Python standard library; no API keys or external services are needed.

## Use the detector

Run from this directory:

```python
from experiments.delta.extractor import extract
from experiments.delta.interaction import detect

base = {"api.py": "def fetch(): return 1\n", "client.py": "VALUE = 1\n"}
a = {**base, "api.py": "def load(): return 1\n"}
b = {**base, "client.py": "from api import fetch\ndef run(): return fetch() + 1\n"}

prediction = detect(extract(base, a), extract(base, b))
print(prediction.to_dict())
# label: conflicting; entity: api.py::fetch
```

Inputs are dictionaries of repository-relative paths to source text. Detection
accepts source snapshots only, not ground truth, tests or edit descriptions.
Rule scores are ordinal strengths, not probabilities. Unsupported dynamic
lookups and runtime configuration relationships may remain unresolved.

## Validate and reproduce the development pilot

```bash
cd prototypes/structured-delta
python3 tools/verify_source.py
python3 -m unittest discover -s experiments/tests -v
python3 tools/run_pilot.py --out artifacts/pilot-001
```

The runner creates a fresh, ignored directory, copies the published source and
original protocol, generates 48 fixtures, validates branch requirements and
joint witnesses, freezes inputs, runs static and online evaluations, then writes
`REPORT.md`. Existing output directories are rejected. Full case files, patches,
checks, logs, freezes and results stay in that directory; they are not tracked.
This is a reproduction using the cleaned source, not a rewrite of the historical
frozen run. The original protocol's "36 named families" is a narrative counting
error: the generator produces **35** families.

The historical development pilot had conflict F1 **74.3%**, conflict precision
**68.4%**, recall **81.2%**, compatible false positives **3/14**, cross-file conflict
recall **8/11**, and entity Top-1 **34/38**. Its authored cases and rules shared an
author and were not a blind holdout. The online pilot detected 5/6 conflicts with
zero positive lead and 2/6 false interventions. These are limited development
results, not evidence of real-repository generalization or superiority to an LLM.

`SOURCE_PROVENANCE.json` records original and published source hashes and AST
digests. Formatting and removal of seven unused imports are the only changes to
the published implementation. Historical source, frozen inputs and results are
preserved locally. [PROTOCOL.md](PROTOCOL.md) is the unmodified original protocol.
Verification checks exact source bytes and parses syntax on each supported Python
version. The historical AST digests were generated with Python 3.14 and document
the same-interpreter comparison; `ast.dump()` is not a cross-version format.

## Optional model baselines

The embedding and LLM description adapters in `experiments/baselines/` only invoke
an explicitly supplied JSON provider command. They do not discover credentials or
call a service automatically. Without a provider they report `not_configured`.
Provider commands receive JSON on stdin and return JSON on stdout; their module
docstrings describe the formats. Model IDs, available usage, errors and coverage
are retained. The pilot runner does not enable model providers.

## Layout and blind-transfer status

| Path | Purpose |
| --- | --- |
| `experiments/delta/` | Structured observations and deterministic interaction rules |
| `experiments/baselines/` | File, line, symbol, Git and optional model comparisons |
| `experiments/benchmark/` | Development fixture generator |
| `experiments/evaluation/` | Validation, freezing, metrics and reporting |
| `experiments/online/` | Synthetic incremental simulation |
| `experiments/tests/` | Detector, metric and Git regression tests |
| `tools/` | Source provenance verification and isolated reproduction |
| `artifacts/` | Locally generated data and results; ignored by Git |

A separate real-repository annotation preparation selected **70** eligible pairs
under its preregistered sampling limits, below the target of 100. Packaging was
interrupted and independent annotation has not started. There are no blind-test
scores. Repository caches, source archives, provenance mappings and reviewer
materials are local research artifacts and are excluded from this publication.

For style checks, use Ruff 0.16.10:

```bash
ruff check .
ruff format --check .
```
