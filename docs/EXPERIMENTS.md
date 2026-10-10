# Experiments and validation

[简体中文](EXPERIMENTS.zh-cn.md) · [Documentation index](INDEX.md) · [Architecture](ARCHITECTURE.md)

This document separates regression tests, walkthroughs and measurements. Commands and behaviors are checked against the source as of 2026-10-10. Historical machine-specific pool counts are not presented as current results; rerun the relevant commands to obtain numbers for your data.

## Regression and examples

Run from the source checkout:

```sh
npm test
npm run test:py
npm run typecheck
node examples/collision/run.mjs
node examples/impact/run.mjs
```

`npm test` checks encoding and workspace tests. Python tests exercise the ledger analyzer. Typechecking covers all six packages. The collision example verifies coordination verdicts against a real scratch ledger and repository; the impact example verifies a changed return type, a recipient alert, adaptation and the removal of stale advice. These fixtures validate specific behaviors, not real-world accuracy.

Current tests cover source fingerprints and limits, shared-file/symbol routing, opt-in authorization, reservations, verified replies, late replies, timeouts, Windows state replacement, selective impacts and protected Git behavior. Test counts depend on the checked-out code and must be reported from a run rather than copied as a permanent badge.

## Real Codex walkthrough

The 2026-10-10 walkthrough used one configured coordinator and two real participant chats. Two scenarios produced four verified replies in total:

| Scenario | Evidence required |
| --- | --- |
| Both chats declare work on one file | A separate queued check reaches each chat, and its matching final reply is saved |
| Different files contain the same normalized JS/TS structure with renamed functions and variables | Source evidence accompanies separate checks, and both chats inspect and reply |

This verifies the message-and-reply path for those samples. It does not measure detection accuracy or prove a conflict was fixed. The initial enablement choice still needs a trusted-hook host UI walkthrough; opening a file alone is not a valid trigger test. Unit tests of offer output do not prove a popup appeared.

To reproduce, use an isolated test workspace, explicitly authorize a coordinator, register the participants' tasks and paths, create the two scenarios, inspect `checks status`, and verify actual target replies with the exact check IDs. Do not count preflight output, queue acceptance or an old final response as an automatic message or a new reply. Restore test files after the walkthrough. The operational protocol is in [usage](USAGE.md) and [coordinate.md](../plugins/agentgit/skills/agentgit/references/coordinate.md).

## Measurements

| Question | Existing entry point | Required control or limit |
| --- | --- | --- |
| Can it recover coordination evidence from session history? | `examples/real/cases.mjs`, `examples/real/measure.mjs` | Distinguish concurrent work from sequential edits; report `entityVisibleCeiling` and trace each case |
| Do scripted agents reduce duplicate work when following advice? | `examples/ab/run.mjs` | Report independent work stopped alongside duplication; obedience is a configured dial, not measured real-agent behavior |
| How noisy are alerts? | `examples/real/measure.mjs` | Report workload/session-hours and false alerts; product advice must not become enforced refusal |
| How does it complement a Git merge check? | `examples/real/run.mjs` | Compare the same case and moment; disclose reconstruction method and distinguish clean text from correct behavior |

```sh
node examples/real/cases.mjs
node examples/real/measure.mjs
node examples/real/run.mjs
node examples/ab/run.mjs --compliance 0,0.25,0.5,0.75,1
```

The real-history scripts read the local Codex rollout pool. `cases.mjs` and `run.mjs` support `--workspaces a,b`; `run.mjs` also supports optional `--refs A,B`. Inputs, qualifying-case counts and output location must accompany any reported result. If no suitable real case exists, report that outcome; never replace it with a staged case labelled real.

The `anchored` reconstruction applies both patches to a common base. The `reversed` fallback reconstructs changes from the final text; non-overlapping changes on that route are expected to merge cleanly, so this is not independent evidence of Git's limitations. Preserve the route and patch checks in the report.

Module-routing experiments must report recall, comparisons and false rejections with an unrouted baseline. A pool with no cross-module cases cannot establish improved cross-module recall. These existing experiments do not measure the accuracy of the newer renamed-code fingerprint scanner; that requires a separately labelled source corpus, including near-misses and skipped syntax.

## Reporting rules

- Separate executed observations from static reasoning, fixture expectations and proposed experiments.
- Keep benefit and cost together: detection recall with its visibility ceiling, duplicate work avoided with independent work deferred.
- Do not claim a real-agent effect size from a scripted obedience setting, or overall superiority over Git from one clean merge.
- Redact private chat identifiers, prompts and paths before publishing; retain a local mapping to source evidence.
- Share results with the commit, command, data scope and date. Old measurements are historical snapshots, not current product guarantees.
