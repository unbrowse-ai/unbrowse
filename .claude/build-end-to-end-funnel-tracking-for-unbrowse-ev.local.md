---
plan: build-end-to-end-funnel-tracking-for-unbrowse-ev
plan_text: "Build end-to-end funnel tracking for Unbrowse: every dropoff between X-mention impression -> landing-page visit -> npm-install -> CLI setup -> first sign-in -> first capture -> first execute -> first MCP tool-call -> repeat usage -> first earnings. Plus an autonomous error-and-failed-indexing telemetry pipeline that feeds the bench-gate corpus so failing real user intents become benchmark probes automatically. SCOPE: project (ships into backend/, frontend/, src/, harness/probes/). LAYERS to instrument: (1) X impressions + click-through (Typefully + X Analytics API + landing UTM), (2) landing visit -> install CTA click (Umami at cloud.umami.is/script.js already present in layout.tsx -> emit landing_visit, install_cta_click events), (3) npm install (track via npm registry stats endpoint + an opt-in install ping from packages/skill postinstall script), (4) CLI setup completion (unbrowse setup writes a setup_completed event to backend), (5) sign-in (existing magic-link flow in backend/src/routes/auth.ts -> add registration event), (6) first capture (backend already counts via incrementAgentExecutions; add capture_first event), (7) first execute (existing executions counter), (8) first MCP tool-call (mcp.ts emits one event per tool), (9) error/failed-indexing pipe -> a new backend route POST /v1/telemetry/intent_failure that accepts {intent, url, error_class, evidence_excerpt} from CLI/MCP failures; the route writes to a KV/D1 table; a separate cron worker reads the table, agent-judges in-thread which failed intents are good benchmark probes, and appends them to harness/probes/corpus-gate.txt with a PR. CORRECT existing surfaces: leverage the unbrowse-funnel-metrics skill canonical funnel (registered/activated/aha/repeat/retained_d7/retained_d30) at the BOTTOM of the new top-of-funnel layers; do not duplicate. SHIPPING SURFACE: backend/src/routes/telemetry.ts + frontend instrumentation in layout.tsx + packages/skill postinstall + harness/probes/auto-corpus-feeder.py. VERIFY GATE: real http-curl probe of POST /v1/telemetry/intent_failure returns 200 + the failure row is readable via GET /v1/telemetry/recent-failures (admin-only) + the cron worker dry-run produces a non-empty proposed-probe diff against corpus-gate.txt. Agent JUDGES the proposed probes; cron never auto-merges to corpus. CONSTRAINTS: never include PII (mask emails+IPs+api_keys); per-event payload <= 4KB; opt-in for the npm postinstall ping (default off, env UNBROWSE_TELEMETRY=1 enables); admin-gated /v1/telemetry/recent-failures mirrors the /v1/ops admin gate just shipped in PR #557."
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
parallel_budget: 1
iteration_cap: 8
inferred_from:
  template: content
  scope: project
  shipping: meta-harness.local.md
created: 2026-05-20
last_iterated: "2026-05-20T09:10:14Z"
status: shipped-wave-1
last_verdict: "WAVE-1-SHIPPED (status corrected from incorrect 'converged' by verify loop 2026-05-20T11:58Z) — admin-gated GET /v1/telemetry/recent-failures + harness/probes/auto-corpus-feeder.py shipped via PR #558. Layer 9 of 9 ONLY. Wave-2 still queued: (2) Umami landing_visit + install_cta_click events, (3) npm postinstall ping, (4) unbrowse setup setup_completed event, (5) auth.ts registration event, plus the Worker cron that reads telemetry_sessions and proposes corpus probes. Premature 'converged' promotion caught by .claude/wave-3-verification-catalogue.md."
---

# Build end-to-end funnel tracking for Unbrowse: every dropoff between X-mention impression -> landing-page visit -> npm-install -> CLI setup -> first sign-in -> first capture -> first execute -> first MCP tool-call -> repeat usage -> first earnings. Plus an autonomous error-and-failed-indexing telemetry pipeline that feeds the bench-gate corpus so failing real user intents become benchmark probes automatically. SCOPE: project (ships into backend/, frontend/, src/, harness/probes/). LAYERS to instrument: (1) X impressions + click-through (Typefully + X Analytics API + landing UTM), (2) landing visit -> install CTA click (Umami at cloud.umami.is/script.js already present in layout.tsx -> emit landing_visit, install_cta_click events), (3) npm install (track via npm registry stats endpoint + an opt-in install ping from packages/skill postinstall script), (4) CLI setup completion (unbrowse setup writes a setup_completed event to backend), (5) sign-in (existing magic-link flow in backend/src/routes/auth.ts -> add registration event), (6) first capture (backend already counts via incrementAgentExecutions; add capture_first event), (7) first execute (existing executions counter), (8) first MCP tool-call (mcp.ts emits one event per tool), (9) error/failed-indexing pipe -> a new backend route POST /v1/telemetry/intent_failure that accepts {intent, url, error_class, evidence_excerpt} from CLI/MCP failures; the route writes to a KV/D1 table; a separate cron worker reads the table, agent-judges in-thread which failed intents are good benchmark probes, and appends them to harness/probes/corpus-gate.txt with a PR. CORRECT existing surfaces: leverage the unbrowse-funnel-metrics skill canonical funnel (registered/activated/aha/repeat/retained_d7/retained_d30) at the BOTTOM of the new top-of-funnel layers; do not duplicate. SHIPPING SURFACE: backend/src/routes/telemetry.ts + frontend instrumentation in layout.tsx + packages/skill postinstall + harness/probes/auto-corpus-feeder.py. VERIFY GATE: real http-curl probe of POST /v1/telemetry/intent_failure returns 200 + the failure row is readable via GET /v1/telemetry/recent-failures (admin-only) + the cron worker dry-run produces a non-empty proposed-probe diff against corpus-gate.txt. Agent JUDGES the proposed probes; cron never auto-merges to corpus. CONSTRAINTS: never include PII (mask emails+IPs+api_keys); per-event payload <= 4KB; opt-in for the npm postinstall ping (default off, env UNBROWSE_TELEMETRY=1 enables); admin-gated /v1/telemetry/recent-failures mirrors the /v1/ops admin gate just shipped in PR #557.

Generated by meta-harness/scripts/builder/build.py on 2026-05-20.

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

## Layout (skill-creator canon)

```
.claude/build-end-to-end-funnel-tracking-for-unbrowse-ev/
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
bash .claude/build-end-to-end-funnel-tracking-for-unbrowse-ev/scripts/iterate.sh
```

The iterate driver reads this state file, runs scripts/verify.sh, on pass runs
scripts/ship.sh, appends a row to ledgers/iterations.jsonl. Edit the frontmatter
above to change shipping_surface / verify_gate / commands; the scaffold re-reads
on every run.

## Loop primitive

linear-iterate - meaning:

- linear-iterate: one verify -> ship cycle per invocation
- self-build: spawn N parallel probes, delegate to /self-build, write conductor row referencing its run_id
- jesus-loop: delegate to /jesus-loop:take-the-wheel, poll its state via adapter
- evidence-build: delegate to /evidence-build, poll its convergence ledger via adapter

## Optional gate phase

Pass `--gates` to iterate.sh to run the falsifier-borrowed gates between verify and ship:
`bash scripts/iterate.sh --gates --gates-baseline HEAD~5`

## Notes from template

Content plans. Replace ship_command with the right publishing skill (x-max for X, typefully for scheduling, blog-publisher for long-form). validation_channel=agent-browser: the default verify_command checks draft length as a PREFLIGHT then fails closed until the declarant wires an agent-browser check that the published/previewed artifact actually renders. The substrate-audit proxy_only_gate_lines row surfaces a length-only gate.
