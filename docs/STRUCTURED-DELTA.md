# Structured program-state delta prototype

The standalone implementation is in
[prototypes/structured-delta](../prototypes/structured-delta/README.md).
It extracts changes from common-base Python snapshots and uses deterministic
dependency, contract and effect rules to classify concurrent interactions.
It is not integrated into the product's CLI, hooks, routing or acceptance flow.

The published code includes regression tests and an isolated pilot reproduction
runner. Source has consistent formatting and unused imports removed; AST
provenance is recorded. Original frozen source and experimental evidence remain
unaltered in local research storage. Generated fixtures, results and real-repository
reviewer materials are not tracked in Git.

The 48-case authored pilot achieved conflict F1 74.3%, with 13 true detections,
6 false positives and 3 missed conflicts. It detected 8/11 cross-file conflicts.
The online pilot showed no positive warning lead. Embedding and LLM baselines
were not run. These findings support further independent evaluation, not a
real-world superiority claim.

Real-repository blind-transfer preparation selected 70 eligible pairs, below its
100-pair target. Packaging and independent labeling are incomplete; no blind-test
scores exist. The next step is independent annotation and adjudication with
executable branch requirements before detector scoring.

To validate the published implementation, run from its directory:

```bash
python3 tools/verify_source.py
python3 -m unittest discover -s experiments/tests -v
python3 tools/run_pilot.py --out artifacts/pilot-001
```
