# Structured program-state delta pilot, protocol v1

Date: 2026-10-07. This protocol and all code/case bytes are SHA-256 frozen in
FREEZE.json before the first scored run. Development unit tests and fixture
validation precede freezing; no scored results have been used to choose rules.
Do not edit frozen inputs to improve run-001. Retain failed runs and executor
issues; subsequent changes require a separately versioned protocol/directory.

## Question and scope

Can deterministic structured deltas improve detection and localization of
concurrent semantic interactions relative to scope/text heuristics? Only a
Python research prototype: no AgentGit runtime, routing, repair, persistent
memory, hooks, MCP, or live-agent orchestration. Dependencies are standard
Python >=3.11 and Git >=2.38 (merge-tree --write-tree).

This is a jointly authored, transparent DEVELOPMENT benchmark. Case author and
rule implementer are the same; it is not blind or held-out. 48 microrepositories,
10 independent / 14 compatible / 8 redundant / 16 conflicting, with 36 named
families (names organize analysis, not proof of independent sampling). The
initial sample covers the requested ten situations and includes unsupported
features. Scaling the same templates does not create independent evidence.

## Inputs, labels and ground truth

Each directory holds base/, patch_A.diff, patch_B.diff, materialized a/ and b/,
gold.json with interaction label/entity/explanation, and checks/{base,a,b}.py.
Nonconflicting cases include witness/ showing a state that satisfies both sets
of branch requirements. Redundant witnesses use A's state. Gold denotes:

- independent: no shared behavioral requirement or resolved interaction entity;
- compatible: related scopes/effects can preserve both branch requirements;
- redundant: equivalent change over the case's declared input domain;
- conflicting: the unchanged concurrent transformations break at least one
  requirement, or require contradictory contracts for the same entity.

Textual overlap alone does not decide the label. Checks are finite witnesses,
not proofs of universal equivalence. Base validation checks syntax; branch
checks establish local required behavior. All A and B states must pass their
own checks; every provided joint witness must pass both. Patch application
must reproduce the supplied branch snapshots exactly. No benchmark execution
failure is silently dropped. All 48 cases remain in scoring.

Detector API accepts only base and changed source snapshots. It has no gold,
requirements, test results, witness, case ID, family, or edit description input.
Gold and checks are accessed after static predictions; Git baseline receives
only Git clean/conflict status, never test outcomes. Tests are isolated Python
subprocesses. This is not a repair experiment. There are no hidden tests and no
claim of hidden-quality generalization.

## Methods and frozen choices

B1 file overlap; B2 line overlap and qualified AST symbol overlap (reported
separately); B3 Git merge-tree conflict. These binary heuristics emit conflicting
on overlap/conflict and independent otherwise. They cannot emit compatible or
redundant. Report four-class macro F1 as requested, but do not infer superiority
from macro F1 alone: binary precision/recall and compatible false positives are
necessary comparisons. B2 AST means enclosing changed AST definitions, not a
full tree-edit-distance algorithm. Line positions use common-base lines and
half-integer insertion anchors.

B4: opt-in external diff embedding via JSON command, cosine >=0.80 predicts
conflicting; no threshold selection on this benchmark, no fake local embedding.
No configured command means NOT RUN, not a score of zero. B5: opt-in command
first describes each actual diff, then judges only the descriptions, returning
one of four labels and up to three entities. This is a description bottleneck,
not a full-source LLM baseline. It is not actual live agents' self-reported
intent. Raw descriptions, judgments, reported usage, model ID and errors are
retained. Missing usage is unknown. Partial runs report coverage and are not
ranked against full-coverage methods. No external command is configured in v1.

Structured delta: Python AST definitions, create/delete/body-equal rename,
statement edit operations, resolved local/relative imports and aliases, calls,
function signatures/annotations, literal return types/dict keys, module globals
and constant-key read/write effects, requirements.txt entries and flat JSON.
Identity-test normalization proves only a very narrow form of redundancy; it
does not equate == with is or perform arbitrary algebraic equivalence.

Rule priority: canonical transformation equality => redundant; deletion/rename
against changed implementations or consumers => conflict; incompatible observed
call signature or changed return/value contract consumed by another patch =>
conflict; (Full only) changed read/write interference, divergent return behavior
or signature replacements and duplicate definitions => conflict; resolved shared
scope/dependency otherwise => compatible; otherwise independent. Scores are
ordinal rule strengths, not probabilities or cosine values.

Conservative contract rules may reject safe schema/config changes. Calls/reads
include before and after observations; obsolete assumptions can therefore
remain. No alias heap analysis, CFG/path sensitivity, general type inference,
transitive effect analysis, dynamic lookup/JSON consumer resolution or version
solver. Unresolved observations are retained; forced four-class output is not
a safety guarantee. Constant-key analysis is shallow. Source annotations are
observations, not enforced runtime types. Package manifest extraction does not
resolve installed distributions to module imports.

Ablation ladder: File; File+Symbol; File+Symbol+Dependency;
File+Symbol+Dependency+Contract; Full Structured Delta. First three use binary
intersection rules; Contract uses incompatibility and compatible fallback; Full
adds actual write effects, divergent returns and canonical redundancy. These
are rule/feature bundle ablations, not a trained model with one fixed decoder.
Effects cannot be interpreted as isolated causal contributions of features.

## Metrics and falsification criterion

Four-class macro F1 (all four classes, undefined class F1=0), conflict precision
and recall, compatible->conflicting rate, cross-file conflict recall (changed
file sets are disjoint), entity Top-1 and Recall@3. Localization is exact entity
identity, independent of class correctness, denominator all non-independent
cases with gold entities. File-only predictions do not earn symbol localization
credit. A file-level localization score is not substituted for the entity metric.
One gold entity per case in v1, so Recall@3 is a hit rate. Undefined denominators
are null. Report counts, per-class confusion, every family, all FP/FN, not only
aggregate. Report binary conflict F1 alongside mandatory metrics.

Bounded positive support requires Full conflict F1 to exceed the strongest
available B1/B2/B3 conflict F1, reduce compatible false positives, and improve
cross-file conflict recall. Failure of those criteria does not support even the
bounded claim. Meeting them supports only these authored cases, not general
semantic correctness, comparison to unavailable B4/B5, or real-world superiority.
No p-value based generalization claim is planned for this constructed sample.

## Commutativity

Strict attempt: git apply A then B and B then A, with atomic patch application,
recording both apply statuses, both branch requirement results if applicable,
and exact full-source SHA-256 state equality when both orders apply. A failed
order has tests=null and resulting-state comparison=null, never a pass.

Separately record true Git three-way merge-tree in both parent orders and the
same checks and state hashes. This is a base-aware textual reconciliation,
not function composition or automatic repair. Preserve conflict-marked trees
for inspection. Text application or three-way noncommutativity is an interaction
signal only: compatible edits may overlap, and commuting cross-file edits may
break runtime tests. Never derive gold or structured predictions from it.

## Online protocol

12 preregistered cases, 6 interleaved events each: A1 B1 A2 B2 A3 B3. A1/B1 add
an unused helper; A2/B2 apply the first changed file; A3/B3 complete the remaining
files and remove helper. These are synthetic progress scaffolds, not natural
agent trajectories. All incremental diffs are stored and checked against their
snapshots. Active delta is always base->current branch, not only latest diff.
After every event recompute prediction and trial merge both active branches.
Requirements activate as soon as a branch is functionally complete (ignoring
progress helper), not merely at A3/B3, preventing artificial positive lead.
Always check syntax. Unfinished branches have no extra behavior assertions.

Record first predicted conflict, first merge failure, first clean-merge test
failure, failure minus detection in event ticks (positive=earlier detection,
negative=late); null if unavailable. Report semantic-test lead separately and
real detector wall time in ms. False intervention = ever warning on final
nonconflicting gold; false early intervention additionally precedes first failure
or occurs when no failure is observed. Both definitions are reported so textual
failures do not legitimize warnings on compatible edits. Final labels are a
limited proxy for transient ground truth. Online run starts only after static
pairwise experiment succeeds. No repair or context-routing decisions occur.

## Most important next experiment

Freeze the detector, then independently collect and annotate >=100 real
concurrent edit pairs from repositories excluded from development, with executable
branch/joint requirements and independent adjudication. Include compatible
contract changes and dynamic cross-file dependencies; lock model providers and
thresholds on a separate calibration set for B4/B5. This one blinded transfer
test is more informative than expanding authored templates or adding routing.
