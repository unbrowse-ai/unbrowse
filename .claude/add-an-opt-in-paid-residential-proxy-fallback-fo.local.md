---
plan: add-an-opt-in-paid-residential-proxy-fallback-fo
plan_text: "Add an opt-in paid residential-proxy fallback for 429-rate-limited target requests, billed per call via x402 (~$0.01). LOCKED ARCH (agent-decided, do not re-litigate): SPLIT egress/billing because Cloudflare Workers fetch() cannot CONNECT-tunnel through an arbitrary residential proxy. (1) EGRESS: the local unbrowse Node execute path in src/ (executeEndpoint / executeBrowserCapture in src/execution) detects an HTTP 429 from the target and, ONLY when the agent has pre-consented, retries the SAME outbound request through the IProyal residential proxy (geo.iproyal.com:12321, creds + country-lock format in memory reference_iproyal_proxy.md) using an undici ProxyAgent / https-proxy-agent dispatcher — never edit src/kuri/client.ts. (2) BILLING: the Cloudflare Worker backend meters the premium proxied call and settles the EXTRA x402 charge (~$0.01/call, configurable) by EXTENDING the existing per-agent/per-platform sponsor surface backend/src/middleware/sponsor.ts + its KV ledger keys (sponsor:agent:<id>:<UTC-date> etc) and the GET /v1/account/sponsor-status / admin ledger endpoints — never invent a parallel billing path. (3) TRIGGER: OPT-IN / pre-consented only — no 429 silently costs the user; when not consented, resolve/execute returns an actionable next_step offering the paid proxied retry with a concrete suggested_command, consistent with the CLAUDE.md 'never a one-word error' rule. Substrate principle binds: the proxy fallback is a declared affordance the agent chooses, never an auto-prescribed reroll; no per-domain proxy registry; surface evidence (429 seen, consent state, proxy attempted, post-proxy status, charge recorded) and let the agent judge. VERIFY: a real round-trip — a genuinely 429-ing target, agent pre-consented, src/ retries via IProyal, returns 200 with real target data, and the extra ~$0.01 x402 charge is recorded in the sponsor KV ledger; harness COLLECTS the full {429, consent, proxy_dispatch, post_proxy_status, response_excerpt, charge_ledger_row} trace, agent judges in-thread whether the paid retry actually unblocked the request and the charge economy held. No heuristic PASS/FAIL in any script. Public unbrowse-ai/unbrowse repo is frozen-by-design: ship via the maintained dev-repo flow, never the public repo, never directly to main."
project: /Users/lekt9/Projects/unbrowse-ecosystem/unbrowse
template: agent-system
scope: project
shipping_surface: "SPLIT: src/execution (executeEndpoint/executeBrowserCapture does the IProyal residential-proxy retry on target HTTP 429, opt-in only) plus backend/src/middleware/sponsor.ts (x402 metering of the premium call, KV ledger sponsor:agent:<id>:<UTC-date>, GET /v1/account/sponsor-status). Ship via the maintained dev-repo PR flow; NEVER the frozen public unbrowse-ai/unbrowse repo; never directly to main."
ship_command: |
    set -euo pipefail; echo 'SCOPED SHIP: commit ONLY src/execution + backend/src/middleware/sponsor.ts + their targeted tests on a feature branch, open a dev-repo PR. Never public repo, never main. Fail-closed until a real diff exists.'; git diff --quiet -- src/execution backend/src/middleware/sponsor.ts && { echo 'no proxy-fallback diff staged yet'; false; } || git status --porcelain -- src/execution backend/src/middleware/sponsor.ts
verify_gate: "Real 429 to IProyal to 200 round-trip plus the extra x402 charge recorded in the sponsor KV ledger. Harness COLLECTS {429, consent_state, proxy_dispatch, post_proxy_status, response_excerpt, charge_ledger_row}; the agent judges in-thread. Plus targeted bun tests for the sponsor.ts extension and the proxy-fallback unit. No heuristic PASS/FAIL in any script."
verify_command: |
    set -euo pipefail; T="backend/tests/sponsor-proxy-fallback.test.ts tests/proxy-fallback-429.test.ts"; for f in $T; do [ -f "$f" ] || { echo "[fail-closed] missing real gate test: $f. Implement the feature and its real-endpoint test before this gate can pass; no proxy or wc green."; exit 2; }; done; bun test backend/tests/sponsor-proxy-fallback.test.ts backend/tests/x402-skill-route.test.ts tests/proxy-fallback-429.test.ts 2>&1 | tee ".claude/$PLAN/ledgers/verify-tests.log"; echo "[collect] run the LIVE round-trip collector and let the agent judge: bash .claude/$PLAN/scripts/collect-roundtrip.sh > .claude/$PLAN/ledgers/roundtrip.trace.json"
validation_channel: "http-curl"
loop_primitive: linear-iterate
parallel_budget: 1
iteration_cap: 8
inferred_from:
  template: content
  scope: project
  shipping: meta-harness.local.md
created: 2026-05-20
last_iterated: ""
status: pending
---

# Add an opt-in paid residential-proxy fallback for 429-rate-limited target requests, billed per call via x402 (~$0.01). LOCKED ARCH (agent-decided, do not re-litigate): SPLIT egress/billing because Cloudflare Workers fetch() cannot CONNECT-tunnel through an arbitrary residential proxy. (1) EGRESS: the local unbrowse Node execute path in src/ (executeEndpoint / executeBrowserCapture in src/execution) detects an HTTP 429 from the target and, ONLY when the agent has pre-consented, retries the SAME outbound request through the IProyal residential proxy (geo.iproyal.com:12321, creds + country-lock format in memory reference_iproyal_proxy.md) using an undici ProxyAgent / https-proxy-agent dispatcher — never edit src/kuri/client.ts. (2) BILLING: the Cloudflare Worker backend meters the premium proxied call and settles the EXTRA x402 charge (~$0.01/call, configurable) by EXTENDING the existing per-agent/per-platform sponsor surface backend/src/middleware/sponsor.ts + its KV ledger keys (sponsor:agent:<id>:<UTC-date> etc) and the GET /v1/account/sponsor-status / admin ledger endpoints — never invent a parallel billing path. (3) TRIGGER: OPT-IN / pre-consented only — no 429 silently costs the user; when not consented, resolve/execute returns an actionable next_step offering the paid proxied retry with a concrete suggested_command, consistent with the CLAUDE.md 'never a one-word error' rule. Substrate principle binds: the proxy fallback is a declared affordance the agent chooses, never an auto-prescribed reroll; no per-domain proxy registry; surface evidence (429 seen, consent state, proxy attempted, post-proxy status, charge recorded) and let the agent judge. VERIFY: a real round-trip — a genuinely 429-ing target, agent pre-consented, src/ retries via IProyal, returns 200 with real target data, and the extra ~$0.01 x402 charge is recorded in the sponsor KV ledger; harness COLLECTS the full {429, consent, proxy_dispatch, post_proxy_status, response_excerpt, charge_ledger_row} trace, agent judges in-thread whether the paid retry actually unblocked the request and the charge economy held. No heuristic PASS/FAIL in any script. Public unbrowse-ai/unbrowse repo is frozen-by-design: ship via the maintained dev-repo flow, never the public repo, never directly to main.

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
.claude/add-an-opt-in-paid-residential-proxy-fallback-fo/
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
bash .claude/add-an-opt-in-paid-residential-proxy-fallback-fo/scripts/iterate.sh
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
