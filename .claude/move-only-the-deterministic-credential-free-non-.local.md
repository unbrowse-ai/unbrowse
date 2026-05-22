---
plan: move-only-the-deterministic-credential-free-non-
plan_text: "Move ONLY the deterministic, credential-free, non-LLM intelligence server-side behind the extractAuthHeaders sanitization seam. IN SCOPE: (1) extraction filters - extractEndpoints noise rules, GraphQL decomposition, antibot-signal detection, per-domain bypass patterns - the real reverse-engineerable unbrowse IP, deterministic, zero LLM cost, movable once the client strips credentials and uploads only the credential-free endpoint skeleton plus a raw response sample; (2) ranking heuristics - rankEndpoints BM25 + URL-overlap + schema-richness - finish the half-done server move so rankEndpointsServerFirst is primary and local rankEndpoints is a pure offline fallback; (3) graph construction - buildSkillOperationGraph requires/yields DAG edges, pure structural. EXPLICITLY OUT OF SCOPE and MUST stay local: the LLM augmentation augmentEndpointsWithAgent and generateLocalDescription - those run on the caller's LLM and the caller's budget, moving them server-side would make unbrowse pay per enrichment; the reasoning is the calling agent's LLM which is not unbrowse code and has nothing to reverse-engineer. ALSO MUST stay local: all credential-touching IO - cookie SQLite reads in src/auth/browser-cookies.ts and src/cli-cookies.ts, Kuri browser control, wallet signing, the authenticated fetch against the target. The sanitization seam is extractAuthHeaders which already separates credentials from endpoint shape. The win is dual: reverse-engineering the client yields only a credential-handling shell, and zero credentials leak because the server only ever sees credential-stripped skeletons."
project: /Users/lekt9/Projects/unbrowse-ecosystem/unbrowse
template: agent-system
scope: project
shipping_surface: "cloudflare (wrangler deploy / pages)"
ship_command: |
    git add -A && git diff --cached --quiet || git commit -m 'iterate: $(date +%s)'
verify_gate: "os-control e2e outcome (bench preflight)"
verify_command: |
    { test -f .bench-gate/run.sh && bash .bench-gate/run.sh || echo 'no bench-gate yet'; }; { echo '[validation_channel=os-control] bench preflight done. Declare the real e2e outcome check as verify_command in the state file: screencapture -x -R<x,y,w,h> /tmp/$PLAN-v.png + an image/vision diff, OR an osascript UI assertion, OR for an API surface set validation_channel: http-curl and a curl matrix against the deployed endpoint. Bench alone is not an e2e gate.'; false; }
validation_channel: "os-control"
loop_primitive: self-build
parallel_budget: 8
iteration_cap: 30
inferred_from:
  template: agent-system
  scope: project
  shipping: meta-harness.local.md
created: 2026-05-22
last_iterated: ""
status: backend-LIVE-prod-PR717-726 BUT-client-NOT-shipped npm-stuck-preview.6 blocked-on-kuri-crosscompile-in-Upload-CLI-Release-Assets

<!--
WAVE PLAN (diagnosed 2026-05-22, scope corrected per Lewis: the LLM
augmentation stays LOCAL because it runs on the caller's LLM + budget;
moving it server-side would make unbrowse pay per enrichment, and the
caller's LLM is not unbrowse code so there is nothing to reverse-
engineer there).

IN SCOPE — deterministic, credential-free, zero-LLM-cost:

  Wave 1 — ranking server-move (LOWEST RISK, generic IP).
    rankEndpointsServerFirst already exists + is correct (tries
    /v1/search/rank, falls back to local rankEndpoints). But only
    1 of 9 orchestrator call sites uses it; 8 still call the local
    sync rankEndpoints directly (src/orchestrator/index.ts lines
    413, 791, 1095, 1126, 2324, 2998, 3959, 4789). Subtlety: server-
    first is async, local is sync; some call sites are sync predicate
    contexts (e.g. line 1095 inside .some(...)) that need an async
    refactor or stay local. Convert the safe ones; document the
    sync-bound holdouts. Bench-verify after.

  Wave 2 — extraction filters server-move (HIGHEST VALUE IP).
    extractEndpoints (src/reverse-engineer/index.ts:924 — noise rules,
    GraphQL decomposition, antibot-signal detection) + extractFromDOM
    (src/extraction/index.ts:3006 — cheerio DOM extraction).

    INVESTIGATED 2026-05-22 — findings that de-risk the drill:
    * extractFromDOM IS Worker-portable: its only deps are `cheerio`
      (pure-JS, runs in Workers) + `assessIntentResult` from
      src/intent-match.ts (which has ZERO imports). Grep of
      src/extraction/index.ts for node-only signals = 11 hits, all
      false positives (the word "node" as a variable name). No
      require/fs/process.env/child_process. The module bundles for a
      Worker as-is.
    * Verification channel ALREADY EXISTS: 25+ tests/extraction-*.ts
      fixture tests characterize the logic. No parity gate to build
      from scratch.
    * THE BLOCKER (precise): backend/tsconfig.json has rootDir=src +
      include=[src/**/*]. A cross-import of ../../src/extraction into
      backend/src/ pulls a file outside backend's rootDir -> TS6059 ->
      backend tsc stops being clean -> regression. No precedent of
      backend importing CLI src/.

    STEP 1 (the real next move): create a packages/extraction-core/
    workspace package holding the Worker-clean extraction logic,
    imported by BOTH src/ (CLI) and backend/src/ (Worker). Because the
    code is confirmed Worker-clean, this is workspace wiring + import
    repointing, not a porting effort. Verify gate: CLI tsc clean +
    backend tsc clean + all 25 extraction-* tests green.
    STEP 2: backend POST /v1/extract/refine imports extraction-core,
    additive (nothing calls it), behind exec-token gate.
    STEP 3 (bench-gated): client captures -> extractAuthHeaders strips
    creds -> uploads credential-free skeleton -> consumes refined
    result; local extraction becomes the offline fallback.
    The capture pipeline is the most fragile part of the product
    The capture pipeline is the most fragile part of the product
    (tencent bench degrades when Kuri missing); bench-gate STEP 3.

  FINDING 2026-05-22 (PR #723 shipped + post-723 cascade attempt):
    STEP 3 converted 7 of 9 extractFromDOM call sites to server-first.
    The 2 remaining (execution/index.ts buildPageArtifactCapture, the
    browse-index.ts `evaluate` arrow) MUST STAY LOCAL -- not a sync-
    context limitation, an ARCHITECTURE boundary. Both run on the
    CAPTURE hot path. An async-cascade conversion was attempted and
    REVERTED: making `evaluate` server-first added a blocking network
    round-trip to capture; tests/capture-noise-aware-early-exit.test.ts
    went 117ms (11/0) -> 5001ms timeout. Server-first belongs on the
    EXECUTION/resolve path (a round-trip is already happening there);
    capture must stay local-fast. Do NOT re-attempt converting the
    capture-path extraction sites -- the no-regression gate rejects it.

  WAVE 3 CONTRACT (declared 2026-05-22, principle 20260522T043828Z-
  b7467eb6 latency-tiered server-move). The capture-path sites stay
  local-provisional; the AUTHORITATIVE extraction moves server-side in
  the DEFERRED enrichment path where latency is free.
    Where: the post-close enrichment pipeline
      extractEndpoints -> extractAuthHeaders -> storeCredential ->
      mergeEndpoints -> generateLocalDescription ->
      augmentEndpointsWithAgent -> buildSkillOperationGraph ->
      cachePublishedSkill -> queueBackgroundIndex.
    The DOM-extraction that determines the PUBLISHED page-artifact's
    dom_extraction.data is the alpha. After extractAuthHeaders has
    stripped credentials, route that extraction through
    extractFromDOMServerFirst (or refineExtractionRemote directly) so
    the published artifact's data is server-sourced. Capture-time
    buildPageArtifactCapture + evaluate stay local (provisional only).
    Verify gate (encodes the two-tier lesson, do not weaken):
      (a) tests/capture-noise-aware-early-exit.test.ts stays ~117ms --
          capture latency flat (the regression sentinel);
      (b) the published page-artifact's dom_extraction.data is sourced
          from the server call when /v1/extract/refine is reachable;
      (c) extraction-* + extract-* tests stay green.
    Recon needed before drilling: locate the exact enrichment-pipeline
    call site that produces the published page-artifact's extracted
    data (grep the cachePublishedSkill / page-artifact build path).
  Wave 3 — graph construction server-move (MEDIUM). buildSkillOperation
    Graph requires/yields DAG edges, pure structural, no credentials.

OUT OF SCOPE — stays local forever:
  - augmentEndpointsWithAgent, generateLocalDescription (caller's LLM)
  - all credential IO: src/auth/browser-cookies.ts, src/cli-cookies.ts,
    src/kuri/client.ts, wallet signing, the authenticated target fetch.
  - THE BROWSER ITSELF (Lewis 2026-05-22: "the browser is to be on the
    client side - pointed to the client's browser"). Capture runs in
    the client's browser, on the client's machine, from the client's
    IP — Kuri / the user's Chrome/Firefox, the HAR recorder, the
    fetch/XHR interceptor. The server NEVER drives a browser and never
    sees raw captured traffic. Wave 2 moves only the deterministic
    POST-capture processing of an already-credential-stripped skeleton;
    it does NOT move the capture surface. Mis-scoping Wave 2 as "move
    the browser" is the forbidden reading — the browser is the
    client's IP + credential surface and is exactly why users still
    call APIs as themselves.
The sanitization seam is extractAuthHeaders (already separates creds
from endpoint shape). Everything downstream of it is movable; upstream
stays. Dual win: a reverse-engineered client is a credential-handling
shell with no moat, and the server only ever sees credential-stripped
skeletons so zero credentials leak.
-->
---

# Move ONLY the deterministic, credential-free, non-LLM intelligence server-side behind the extractAuthHeaders sanitization seam. IN SCOPE: (1) extraction filters - extractEndpoints noise rules, GraphQL decomposition, antibot-signal detection, per-domain bypass patterns - the real reverse-engineerable unbrowse IP, deterministic, zero LLM cost, movable once the client strips credentials and uploads only the credential-free endpoint skeleton plus a raw response sample; (2) ranking heuristics - rankEndpoints BM25 + URL-overlap + schema-richness - finish the half-done server move so rankEndpointsServerFirst is primary and local rankEndpoints is a pure offline fallback; (3) graph construction - buildSkillOperationGraph requires/yields DAG edges, pure structural. EXPLICITLY OUT OF SCOPE and MUST stay local: the LLM augmentation augmentEndpointsWithAgent and generateLocalDescription - those run on the caller's LLM and the caller's budget, moving them server-side would make unbrowse pay per enrichment; the reasoning is the calling agent's LLM which is not unbrowse code and has nothing to reverse-engineer. ALSO MUST stay local: all credential-touching IO - cookie SQLite reads in src/auth/browser-cookies.ts and src/cli-cookies.ts, Kuri browser control, wallet signing, the authenticated fetch against the target. The sanitization seam is extractAuthHeaders which already separates credentials from endpoint shape. The win is dual: reverse-engineering the client yields only a credential-handling shell, and zero credentials leak because the server only ever sees credential-stripped skeletons.

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
.claude/move-only-the-deterministic-credential-free-non-/
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
bash .claude/move-only-the-deterministic-credential-free-non-/scripts/iterate.sh
```

The iterate driver reads this state file, runs scripts/verify.sh, on pass runs
scripts/ship.sh, appends a row to ledgers/iterations.jsonl. Edit the frontmatter
above to change shipping_surface / verify_gate / commands; the scaffold re-reads
on every run.

## Loop primitive

self-build - meaning:

- linear-iterate: one verify -> ship cycle per invocation
- self-build: spawn N parallel probes, delegate to /self-build, write conductor row referencing its run_id
- jesus-loop: delegate to /jesus-loop:take-the-wheel, poll its state via adapter
- evidence-build: delegate to /evidence-build, poll its convergence ledger via adapter

## Optional gate phase

Pass `--gates` to iterate.sh to run the falsifier-borrowed gates between verify and ship:
`bash scripts/iterate.sh --gates --gates-baseline HEAD~5`

## Notes from template

For Claude Code skill/agent/loop builds. Loop primitive 'self-build' fans out N parallel probes per wave, judges in-thread, writes wave row. validation_channel=os-control: the default verify_command runs the bench-gate as a PREFLIGHT then fails closed until the declarant wires a real OS-level outcome assertion (screencapture+diff / osascript) or switches validation_channel to http-curl for an API surface. The substrate-audit proxy_only_gate_lines row surfaces a bench-only gate so the agent judges whether it is a real e2e check.
