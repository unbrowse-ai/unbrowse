---
plan: fix-the-kuri-cross-compile-so-the-release-pipeli
plan_text: "Fix the kuri cross-compile so the release pipeline publishes properly (the P0 blocking every session PR from reaching npm; deployed-is-not-shipped principle 20260522T052552Z-9d0e226a; CI-CD-only-publish contract 20260522T053846Z-ebc3deca). The Upload CLI Release Assets job runs scripts/build-binaries.sh --all which cross-compiles kuri (Zig) for 4 targets; darwin-x64 fails on iconv+icucore (macOS system libs absent when cross-compiling from a Linux runner) and aarch64-linux fails on z+idn2. darwin-x64 already writes a placeholder stub and continues, but the job still exits non-zero. Wave 1 ship-now: make build-binaries.sh treat a minority cross-target failure the same graceful way for ALL targets -- stub the failed target, exit 0 as long as the primary targets darwin-arm64 and linux-x64 produced real binaries, so the release job goes green and the npm publish + SDK publish run; stubbed targets fall back to the postinstall binary fetch. Wave 2 proper fix: cross-compile darwin-x64 and aarch64-linux correctly -- either a GitHub Actions native-runner matrix (macos runner for darwin targets, arm runner for aarch64-linux) or vendored per-target iconv/icucore/z/idn2 alongside the already-vendored curl-impersonate. Verify: build-binaries.sh exits 0 locally with the primary targets real and minority targets stubbed; then a fresh release tag publishes preview.8 (or higher) and npm view unbrowse shows the new preview. Per the CI-CD-only contract the publish happens ONLY via the release pipeline, never a local npm publish."
project: /Users/lekt9/Projects/unbrowse-ecosystem/unbrowse
template: content
scope: project
shipping_surface: "cloudflare (wrangler deploy / pages)"
ship_command: |
    echo 'TODO: invoke the publishing skill for this artifact'; false
verify_gate: "agent-browser published-artifact check (length preflight)"
verify_command: |
    wc -w .claude/$PLAN.draft.md | awk '$1 >= 30 && $1 <= 4000 {exit 0} {exit 1}' && { echo '[validation_channel=agent-browser] length preflight ok. Declare the real outcome check as verify_command in the state file: agent-browser open <published/preview url> && agent-browser snapshot -i to confirm the artifact renders and reads as intended. A word-count is a proxy, not proof it published correctly.'; false; }
validation_channel: "agent-browser"
loop_primitive: linear-iterate
bound_contracts:
  # bind candidates surfaced by build (token-overlap = raw evidence,
  # NOT a verdict). Judge per references/biology-architecture.md:
  # do this contract and the candidate, TOGETHER, perform ONE
  # coherent function (an organ)? If yes, uncomment to bind. Same
  # archetype alone (same tissue) is not a reason to bind.
  # - minimize-the-unbrowse-cli-and-mcp-flag-surface-p   # organ-mate candidate, overlap 0.245
  # - build-kuri-for-windows-x86-64-windows-so-unbrows   # organ-mate candidate, overlap 0.227
  # - build-end-to-end-funnel-tracking-for-unbrowse-ev   # organ-mate candidate, overlap 0.173
  # - drive-every-bug-class-surfaced-by-the-mcp-gate-r   # organ-mate candidate, overlap 0.155
  # - drive-the-harness-queue-to-completion-without-th   # organ-mate candidate, overlap 0.136
parallel_budget: 1
iteration_cap: 8
inferred_from:
  template: content
  scope: project
  shipping: meta-harness.local.md
created: 2026-05-22
last_iterated: ""
status: BUILD-P0-FIXED-PR725-734 PUBLISH-blocked-3-structural-pack-bugs:(1)dist-not-in-skill-files (2)packages-sdk-version-unsynced-stuck-preview.7 (3)smoke-npm-pack-vs-publish-leave-workspace-literal
---

# Fix the kuri cross-compile so the release pipeline publishes properly (the P0 blocking every session PR from reaching npm; deployed-is-not-shipped principle 20260522T052552Z-9d0e226a; CI-CD-only-publish contract 20260522T053846Z-ebc3deca). The Upload CLI Release Assets job runs scripts/build-binaries.sh --all which cross-compiles kuri (Zig) for 4 targets; darwin-x64 fails on iconv+icucore (macOS system libs absent when cross-compiling from a Linux runner) and aarch64-linux fails on z+idn2. darwin-x64 already writes a placeholder stub and continues, but the job still exits non-zero. Wave 1 ship-now: make build-binaries.sh treat a minority cross-target failure the same graceful way for ALL targets -- stub the failed target, exit 0 as long as the primary targets darwin-arm64 and linux-x64 produced real binaries, so the release job goes green and the npm publish + SDK publish run; stubbed targets fall back to the postinstall binary fetch. Wave 2 proper fix: cross-compile darwin-x64 and aarch64-linux correctly -- either a GitHub Actions native-runner matrix (macos runner for darwin targets, arm runner for aarch64-linux) or vendored per-target iconv/icucore/z/idn2 alongside the already-vendored curl-impersonate. Verify: build-binaries.sh exits 0 locally with the primary targets real and minority targets stubbed; then a fresh release tag publishes preview.8 (or higher) and npm view unbrowse shows the new preview. Per the CI-CD-only contract the publish happens ONLY via the release pipeline, never a local npm publish.

Generated by meta-harness/scripts/builder/build.py on 2026-05-22.

## Substrate principle (inherited, non-negotiable)

This harness surfaces what is DECLARED and tells the truth about what
EXISTS. It never substitutes a baked guess for a declaration.

When the system must choose, judge, rank, or disambiguate: it emits the
raw EVIDENCE (samples, scores, candidates, schema, signals) and lets the
consuming agent's LLM judge in-thread. It does NOT bake the verdict into a
script, regex, hardcoded threshold/confidence constant, alias table,
per-case or per-domain registry, banned/pattern/refusal list, numbered
"the correct sequence is exactly N calls" procedure, or a prose template
that speaks for another agent.

Keep deterministic ONLY evidence-derived GENERIC primitives (signals
computed from the artifact itself, structural decomposition, generic
filters). Convert to surfaced evidence ANY PRESCRIPTIVE determinism.

Harness collects raw artifacts; the agent judges. No second LLM and no
heuristic verdict in the substrate. The diagnostic question at every
layer is "what is the agent actually seeing, and is it true?", never
"what rule could I add to force the right outcome?"

Enforcement: the substrate-audit gate runs on EVERY iterate and surfaces
suspected violations (host-branch lines, prose-template lines,
banned-list lines, hardcoded literals, em-dashes) as raw rows in
ledgers/gates.jsonl for the agent to judge. `--gates` additionally
machine-blocks ship on them. The gate itself emits evidence only; it
never claims PASS/FAIL (it obeys this principle too).

## Context gathering (inherited, non-negotiable)

When this harness or its agent must GATHER CONTEXT to plan, justify, or
verify a wave (prior art, an API contract, a spec, a paper, how a tool or
repo actually behaves): it pulls from a real external source and cites it.
The sanctioned sources are the arxiv skill (papers, formal results) and
the deepwiki MCP (how a real repository actually behaves). A fetched page
or repo answer is a source; the model's own memory is not a source.

Every context-derived claim that feeds a criterion, a plan decision, or a
verdict carries its source_id (arxiv id, deepwiki repo, or fetched url) in
references/criteria.md or the ledger row, so a later wave can re-pull and
check it. If no external source is reachable, the harness says so plainly
and the claim stays tagged unverified. It never substitutes a remembered
guess presented as fact.

Same diagnostic as the substrate principle, aimed at inputs: "where did
this context actually come from, and is it true?", never "what do I recall
that would justify the outcome I want?". It prescribes no fixed sequence
of calls; it requires only that context be sourced and cited, and the
agent judges sufficiency in-thread.

## Test what you build (inherited, non-negotiable)

A harness that BUILDS X must TEST X against the live served surface, not
against the source code that was edited. Preflight gates (typecheck,
build, lint, py_compile, format) are necessary but NEVER sufficient. A
green verify with only preflight is a fake-green; the artifact may still
be a regression to a real user.

For every artifact the build introduces or modifies, verify.sh authors a
real-channel assertion that exercises the deployed surface end to end:

- API endpoint built or changed: POST/GET the deployed URL with a real
  payload, assert response status AND response shape AND that the
  response body reflects work the backend actually did (not the request
  echoed back).
- Streaming surface built or changed: consume the stream to completion,
  assert chunks arrive in order, assert at least one non-empty body
  frame, assert the terminator/close. A 200 status with zero body is the
  failure mode this lane exists to catch.
- Database write built or changed: after the action, read the row back
  from the live DB by id and assert the persisted fields, not the fields
  the caller sent. Echo-from-request is not persistence.
- Frontend render built or changed: drive the deployed URL with
  agent-browser or an equivalent real-DOM channel, perform the user
  action, observe the rendered DOM or a screenshot for the expected
  state. A build that compiles is not a UI that renders.
- Job, queue, or async pipeline built or changed: enqueue a real
  payload, wait for the terminal event on the real channel, assert the
  side effect landed in its actual destination.

Operating rule: if the artifact, when broken, would be a regression to a
real user, verify must exercise the user path. If no real channel is
reachable in this environment, verify fails closed with TODO declare
validation_channel, surfacing the missing capability by name. It never
papers over with a preflight-only green.

Enforcement (substrate-faithful, evidence only): substrate-audit.sh
emits real_channel_lines, proxy_gate_lines, and proxy_only_gate_lines
as raw rows in ledgers/gates.jsonl every iterate, and the agent judges
whether the artifact served surface was exercised. The gate does not
auto-decide PROMOTE or HOLD; it surfaces evidence and the agent reads
it. The diagnostic question at every wave is "did this verify touch
the artifact user-facing surface, or only the source?", never "did
the build compile?".

## Layout (skill-creator canon)

```
.claude/fix-the-kuri-cross-compile-so-the-release-pipeli/
├── scripts/
│   ├── verify.sh    runs verify_command + lane bench_commands
│   ├── ship.sh      runs ship_command
│   └── iterate.sh   symlink to shared L0 driver
├── references/
│   └── criteria.md  optional lane declarations
├── ledgers/
│   ├── iterations.jsonl  one row per iterate.sh run (carries log_path + error_excerpt)
│   ├── lanes.jsonl       per-lane bench raw evidence
│   └── gates.jsonl       per-gate evidence (when --gates)
└── logs/
    └── iter<N>-<phase>.log  full stdout+stderr per wave; row.error_excerpt is its stack-trace tail
```

## How to run

```bash
bash .claude/fix-the-kuri-cross-compile-so-the-release-pipeli/scripts/iterate.sh
```

The iterate driver reads this state file, runs scripts/verify.sh, on pass runs
scripts/ship.sh, appends a row to ledgers/iterations.jsonl. The driver re-reads
the frontmatter live each run for loop_primitive and bound_contracts. But
verify_command and ship_command are BAKED into scripts/verify.sh / scripts/ship.sh
at build time: to change them, edit those scripts directly (the frontmatter
copy is the record, not the live source).

## Loop primitive

linear-iterate - meaning:

- linear-iterate: one verify -> ship cycle per invocation
- self-build: spawn N parallel probes, delegate to /self-build, write conductor row referencing its run_id
- jesus-loop: delegate to /jesus-loop:take-the-wheel, poll its state via adapter
- evidence-build: delegate to /evidence-build, poll its convergence ledger via adapter

## Bound sub-contracts

`bound_contracts:` in the frontmatter is a YAML list of sibling harness
slugs whose plan IS a phase of this plan. Reference is not bind: citing a
harness in prose does not bind it. Listing its slug here does. Every
iterate runs the bound-contracts phase, which resolves each slug (project
scope, then global), writes a conductor row into this ledger referencing
the bound contract's latest run_id, and stitches the composed work so the
umbrella ledger tells the truth about what each phase did.

To populate it, declare the slugs the agent judged bind this plan:

```yaml
bound_contracts:
  - integrate-anything
  - make-any-website-a-banger-agent-end-to-end-same-
```

Set `MH_RUN_BOUND=1` to also run each bound contract's own iterate during
the phase (default polls the latest ledger row only, no side effects).
The agent declares WHICH contracts bind by editing the list; the
substrate runs the declared list and surfaces verdicts, never auto-picks
a contract and never folds a bound verdict into this contract's pass or
fail. Cycles are skipped via a binding-chain guard.

## Optional gate phase

Pass `--gates` to iterate.sh to run the falsifier-borrowed gates between verify and ship:
`bash scripts/iterate.sh --gates --gates-baseline HEAD~5`

## Notes from template

Content plans. Replace ship_command with the right publishing skill (x-max for X, typefully for scheduling, blog-publisher for long-form). validation_channel=agent-browser: the default verify_command checks draft length as a PREFLIGHT then fails closed until the declarant wires an agent-browser check that the published/previewed artifact actually renders. The substrate-audit proxy_only_gate_lines row surfaces a length-only gate.
