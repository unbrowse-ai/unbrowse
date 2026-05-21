---
plan: drive-every-bug-class-surfaced-by-the-mcp-gate-r
plan_text: "Drive every bug class surfaced by the MCP-gate run .bench-gate/20260519T203955Z (gate.passed=false; index 30/45=66.7% < 80% floor; retrieve 17/44=38.6% < 65% floor; 3 anchor failures: 002 npm go_failed, 010 hub.docker wrong-endpoint, 011 dev.to wrong-shape) to GREEN in a convergence loop. CITED EVIDENCE on disk: .bench-gate/20260519T203955Z/{verdict.json (66 schema-validated per-probe verdicts), gate.json (comparator output), gate.md, per-probe artifacts capture.meta/html.excerpt/index.store/resolve.shortlist/resolve.pick/execute.input/execute.response.raw/execute.meta}. PRIORITIZED BUG CLASSES (impact-ranked from verdict.json): (W1) schema_drift refusal of real bodies — affects 8+ probes (016 stackoverflow, 020/021/043/049 x.com, 047 youtube subs, 057 southwest); substrate emits 200-wrapped schema_drift_recapture_required envelope INSTEAD of the real body when fields drift, even on auth-walled real data, masking working capture; single fix multiplies coverage. (W2) capture_did_not_emit_skill_id on cold-fetch failures — affects 002 npm (go_failed), 013/014/015 reddit/github, 026 amazon, 029 beatsaver, 033 openlibrary search, 064 google maps; the cold browse/fetch path errors do not produce a skill artifact even when partial signal exists. (W3) wrong-shape page-shell extraction — DOM extractor latches on nav/breadcrumb/translations/SPA-config instead of data nodes; 011 dev.to (signup CTA), 018/019 openlibrary (sidebar chips), 031 priceline (Org boilerplate), 052 ticketmaster (i18n), 057 southwest (marketing tiles), 059 target (breadcrumbs), 066 vinted (Next.js RSC stub). (W4) wrong endpoint pick — 010 hub.docker picked 'Returns user details' over tags-DOM (ranker). (W5) auth-gated crash-not-handoff — 043 x.com/home returns marketplace-op error envelope instead of resolve_hard_handoff. (W6) cold-fetch Akamai despite good capture — 032 ebay; substrate should prefer captured DOM artifact over re-trying server_fetch when it knows the host is bot-walled. (W7) auth-cookies real-bug — 047 youtube subs has cookies but schema_drift envelope instead of returning subscriptions (overlaps with W1). CONSTRAINTS: each wave is ONE scoped commit on a dev-repo branch via /unbrowse-improvement-loop (NEVER direct main); the substrate principle binds (no heuristic verdicts; harness collects; agent judges); re-run THIS skill /unbrowse-mcp-gate after every wave's PR merges to measure delta; STAMP only fires when gate.json.passed=true. EXIT condition for the loop: gate.json.passed=true (a real .bench-gate/stamp.mcp.json gets written), at which point convergence is declared."
project: /Users/lekt9/Projects/unbrowse-ecosystem/unbrowse
template: agent-system
scope: project
shipping_surface: "unbrowse-dev src/ (and backend/ where indicated by gate evidence) via scoped /unbrowse-improvement-loop PR per wave. NEVER direct main. Public unbrowse-ai/unbrowse repo frozen-by-design. Each wave fixes ONE bug class from references/GATE-BUGS-PRIORITIZED.md, branch+PR+verify, then re-run /unbrowse-mcp-gate to measure delta."
ship_command: |
    bash .claude/drive-every-bug-class-surfaced-by-the-mcp-gate-r/scripts/ship.sh
verify_gate: "Re-run the /unbrowse-mcp-gate skill end-to-end (preflight + parallel non-LLM collection + agent-judged verdict.json + reused bench-gate-compare). Convergence = .bench-gate/stamp.mcp.json gets written (gate.json.passed=true). Until then each wave's verify reports the per-bug-class fix delta (which previously-failing probes flipped to PASS, which regressed) by diffing the new gate.json vs the prior. Harness COLLECTS the delta; the agent judges whether the wave moved the gate; NO script emits PASS/FAIL."
verify_command: |
    bash .claude/drive-every-bug-class-surfaced-by-the-mcp-gate-r/scripts/verify.sh
validation_channel: "http-curl"
loop_primitive: linear-iterate
parallel_budget: 8
iteration_cap: 30
inferred_from:
  template: agent-system
  scope: project
  shipping: meta-harness.local.md
created: 2026-05-20
last_iterated: ""
depends_on:
  # This harness MEASURES the integrated state of the substrate via the MCP gate.
  # Other infra-fix harnesses each close some bug class; running this after them
  # gives a coherent gate.json delta and avoids redundant re-runs while they ship.
  - audit-the-unbrowse-capture-enrichment-resolve-ra
  - replace-proven-recipe-replay-with-full-dag-recom
  - add-an-opt-in-paid-residential-proxy-fallback-fo
  - port-scrapling-s-interactive-cloudflare-turnstil
  - move-the-unbrowse-intelligence-validation-plane-
status: shipped-wave-1-collector-direct-document-fastpath-fix
---

# Drive every bug class surfaced by the MCP-gate run .bench-gate/20260519T203955Z (gate.passed=false; index 30/45=66.7% < 80% floor; retrieve 17/44=38.6% < 65% floor; 3 anchor failures: 002 npm go_failed, 010 hub.docker wrong-endpoint, 011 dev.to wrong-shape) to GREEN in a convergence loop. CITED EVIDENCE on disk: .bench-gate/20260519T203955Z/{verdict.json (66 schema-validated per-probe verdicts), gate.json (comparator output), gate.md, per-probe artifacts capture.meta/html.excerpt/index.store/resolve.shortlist/resolve.pick/execute.input/execute.response.raw/execute.meta}. PRIORITIZED BUG CLASSES (impact-ranked from verdict.json): (W1) schema_drift refusal of real bodies — affects 8+ probes (016 stackoverflow, 020/021/043/049 x.com, 047 youtube subs, 057 southwest); substrate emits 200-wrapped schema_drift_recapture_required envelope INSTEAD of the real body when fields drift, even on auth-walled real data, masking working capture; single fix multiplies coverage. (W2) capture_did_not_emit_skill_id on cold-fetch failures — affects 002 npm (go_failed), 013/014/015 reddit/github, 026 amazon, 029 beatsaver, 033 openlibrary search, 064 google maps; the cold browse/fetch path errors do not produce a skill artifact even when partial signal exists. (W3) wrong-shape page-shell extraction — DOM extractor latches on nav/breadcrumb/translations/SPA-config instead of data nodes; 011 dev.to (signup CTA), 018/019 openlibrary (sidebar chips), 031 priceline (Org boilerplate), 052 ticketmaster (i18n), 057 southwest (marketing tiles), 059 target (breadcrumbs), 066 vinted (Next.js RSC stub). (W4) wrong endpoint pick — 010 hub.docker picked 'Returns user details' over tags-DOM (ranker). (W5) auth-gated crash-not-handoff — 043 x.com/home returns marketplace-op error envelope instead of resolve_hard_handoff. (W6) cold-fetch Akamai despite good capture — 032 ebay; substrate should prefer captured DOM artifact over re-trying server_fetch when it knows the host is bot-walled. (W7) auth-cookies real-bug — 047 youtube subs has cookies but schema_drift envelope instead of returning subscriptions (overlaps with W1). CONSTRAINTS: each wave is ONE scoped commit on a dev-repo branch via /unbrowse-improvement-loop (NEVER direct main); the substrate principle binds (no heuristic verdicts; harness collects; agent judges); re-run THIS skill /unbrowse-mcp-gate after every wave's PR merges to measure delta; STAMP only fires when gate.json.passed=true. EXIT condition for the loop: gate.json.passed=true (a real .bench-gate/stamp.mcp.json gets written), at which point convergence is declared.

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
.claude/drive-every-bug-class-surfaced-by-the-mcp-gate-r/
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
bash .claude/drive-every-bug-class-surfaced-by-the-mcp-gate-r/scripts/iterate.sh
```

The iterate driver reads this state file, runs scripts/verify.sh, on pass runs
scripts/ship.sh, appends a row to ledgers/iterations.jsonl. Edit the frontmatter
above to change shipping_surface / verify_gate / commands; the scaffold re-reads
on every run.

## Loop primitive

linear-iterate - meaning:

- one verify -> ship cycle per invocation
- this scaffold does not delegate to `/self-build`
- MCP probe convergence for this product is `/unbrowse-self-build` (sub-agents run
  `mcp__unbrowse__unbrowse_resolve -> unbrowse_go -> unbrowse_snap -> unbrowse_close -> unbrowse_resolve -> unbrowse_execute -> unbrowse_reflect` and write into the harness artifact evidence)

## Optional gate phase

Pass `--gates` to iterate.sh to run the falsifier-borrowed gates between verify and ship:
`bash scripts/iterate.sh --gates --gates-baseline HEAD~5`

## Notes from template

For Claude Code skill/agent/loop builds. Loop primitive 'self-build' fans out N parallel probes per wave, judges in-thread, writes wave row. validation_channel=os-control: the default verify_command runs the bench-gate as a PREFLIGHT then fails closed until the declarant wires a real OS-level outcome assertion (screencapture+diff / osascript) or switches validation_channel to http-curl for an API surface. The substrate-audit proxy_only_gate_lines row surfaces a bench-only gate so the agent judges whether it is a real e2e check.
