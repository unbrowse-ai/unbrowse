# PR Validation Matrix

Use this to validate the merged `main` stack end-to-end.

Focus order:

1. packaged runtime + repo CLI path
2. orchestrator/marketplace routing
3. auth + LinkedIn/browser flows
4. backend scoring/deprecation/analytics
5. host integrations + docs paths

## Fast Gate

Run these first on every serious validation pass:

```bash
bash scripts/check-packaged-kuri.sh
PORT=$(node -e 'const net=require("net"); const s=net.createServer(); s.listen(0,"127.0.0.1",()=>{console.log(s.address().port); s.close();});')
HOST=127.0.0.1 PORT=$PORT UNBROWSE_URL=http://127.0.0.1:$PORT UNBROWSE_DISABLE_AUTO_UPDATE=1 UNBROWSE_NON_INTERACTIVE=1 UNBROWSE_TOS_ACCEPTED=1 bun test tests/cli-e2e.test.ts --timeout 120000
bun test backend/tests/composite-scoring.test.ts backend/tests/scoring-deprecation.test.ts backend/tests/domain-affinity-scoring.test.ts backend/tests/domain-prioritization.test.ts
bun test tests/orchestrator-browser-action-fallback.test.ts tests/orchestrator-cache-promotion.test.ts tests/unsafe-action-gate.test.ts tests/query-hook-bridge.test.ts
```

## Truth Gate

Run this when the question is product-truth, not just unit correctness:

```bash
bun run test:e2e:truth
```

Coverage in this lane:

- real CLI resolve/execute path
- CLI payload ingestion path
- live Kuri/browser action path
- real P0/P1 regression cases
- live graph edge upsert / graph API path

For user-facing claims, pair it with:

```bash
bun run test:claims
```

## Manual Product Cases

Run these against a fresh port so you know which code is serving:

```bash
PORT=$(node -e 'const net=require("net"); const s=net.createServer(); s.listen(0,"127.0.0.1",()=>{console.log(s.address().port); s.close();});')
export HOST=127.0.0.1 PORT UNBROWSE_URL=http://127.0.0.1:$PORT UNBROWSE_DISABLE_AUTO_UPDATE=1
timeout 45 bun run cli -- health --pretty
```

### M1. LinkedIn People Search

```bash
timeout 150 bun run cli -- resolve --intent "search people" --url "https://www.linkedin.com/search/results/people/?keywords=openai" --pretty
timeout 120 bun run cli -- execute --skill <skill_id> --endpoint <endpoint_id> --url "https://www.linkedin.com/search/results/people/?keywords=openai" --intent "search people" --pretty
```

Expected:
- current `git_sha`
- structured people rows with `name`, `url`, `public_identifier`, `headline`
- no `auth_required`
- no missing `params.url` error

### M2. LinkedIn Feed Resolve

```bash
timeout 150 bun run cli -- resolve --intent "get feed posts" --url "https://www.linkedin.com/feed/" --pretty
```

Expected:
- either direct structured feed post rows or a high-signal deferred shortlist
- no stale login artifact chosen first
- no 120s hang

### M3. Browser-Action No-Route Fallback

Use a page with an obvious action-driven search/input flow and no cached route.

```bash
timeout 150 bun run cli -- resolve --intent "search repositories" --url "https://github.com/search?q=openai&type=repositories" --force-capture --pretty
```

Expected:
- does not die at `no_route`
- first-pass browser action path can trigger capture/resolve

### M4. Auth Login Window

```bash
timeout 120 bun run cli -- login --url "https://www.linkedin.com/feed/" --pretty
```

Expected:
- visible browser window
- no silent headless failure
- successful profile reuse on next resolve

### M5. Package Runtime

```bash
cd packages/skill
npm pack --dry-run
```

Expected:
- tarball includes `vendor/kuri/*/kuri`
- no Zig requirement for packaged runtime

## PR-by-PR Cases

### Runtime / Packaging

#### `c165046` fix: bundle vendored kuri and enforce package checks
- Auto:
  - `bash scripts/check-packaged-kuri.sh`
  - `bun test tests/runtime-paths.test.ts tests/runtime-setup.test.ts`
- Manual:
  - `bun run cli -- setup --no-start`
- Expect:
  - bundled Kuri found from repo/package path
  - no Zig or separate `kuri` install needed for normal users

#### PR `#147` fix(#48): pathToFileURL for tsx loader
#### PR `#148` fix(#51): export DEPRECATION_THRESHOLD, add auto_deprecated_at
#### PR `#149` fix(#104): call recordExecution after skill execute
- Auto:
  - `bun test tests/kuri-client.test.ts tests/runtime-paths.test.ts backend/tests/scoring-deprecation.test.ts`
- Manual:
  - execute a cached skill through `/execute`
- Expect:
  - tsx loader path works
  - execute records telemetry
  - deprecation fields present in backend model

### Auth / Browser / LinkedIn

#### PR `#128` fix(#109): open visible browser for interactive login
#### PR `#142` fix(#109): retry logic for Kuri start / LinkedIn spawn failures
- Auto:
  - `bun test tests/auth-dependency-runtime.test.ts tests/capture-nav-timeout.test.ts tests/route-cache-liveness.test.ts`
- Manual:
  - `bun run cli -- login --url "https://www.linkedin.com/feed/"`
  - then rerun LinkedIn resolve
- Expect:
  - visible browser
  - retry survives transient Kuri spawn failure
  - no long hang before failure/success

#### PR `#186` feat(#115,#102): DAG advisory planner
- Auto:
  - `bun test tests/dag-advisor.test.ts tests/dag-feedback.test.ts tests/graph-client.test.ts tests/first-pass-action.test.ts`
- Manual:
  - use a multi-step target where detail depends on prior search result
- Expect:
  - planner narrows to relevant operations
  - dependency walk evidence present in artifact/logs

#### PR `#179` fix(#108): browser-action fallback on no-route resolve path
- Auto:
  - `bun test tests/orchestrator-browser-action-fallback.test.ts`
- Manual:
  - M3
- Expect:
  - no-route path still yields action-based progress instead of hard failure

#### PR `#200` fix(#114): query hook bridge for UI event → network provenance
- Auto:
  - `bun test tests/query-hook-bridge.test.ts`
- Manual:
  - run a capture where clicking/typing is required before network calls
- Expect:
  - requests include provenance to the triggering UI action

#### PR `#197` fix(#125): fill/press focus target before dispatch
- Auto:
  - `bun test tests/action-press-dom-state.test.ts`
- Manual:
  - action flow that previously reported success without changing DOM state
- Expect:
  - DOM actually mutates after fill/press

#### PR `#193` feat(#32,#34,#70): wallet, browser access, verification matrix
#### PR `#198` feat(#123): analytics bottleneck metrics
- Auto:
  - `bun test tests/integration-foundations.test.ts tests/analytics-bottleneck.test.ts tests/action-press-dom-state.test.ts`
- Manual:
  - inspect verification/browser access surfaces
- Expect:
  - matrix/browser-access modules are wired and stats emit sane values

### Orchestrator / Routing / Auto-Exec

#### PR `#182` fix(#145): normalizeUrl duplicate-endpoint bugs
- Auto:
  - `bun test tests/root-runtime-regressions.test.ts tests/real-world-cases.test.ts`
- Manual:
  - same endpoint with trailing slash / repeated slash / case variants
- Expect:
  - same logical endpoint; no duplicate route spam

#### PR `#199` feat(#87): unsafe action score gate
- Auto:
  - `bun test tests/unsafe-action-gate.test.ts`
- Manual:
  - resolve an unsafe write-like endpoint without `--confirm-unsafe`
- Expect:
  - auto-exec blocked when score is high

#### PR `#201` fix(#89): cache promotion, mutable DOM guard, resolvedParams fix
- Auto:
  - `bun test tests/orchestrator-cache-promotion.test.ts`
- Manual:
  - resolve a live-capture/deferred case twice
- Expect:
  - second run hits cache/marketplace path
  - mutable DOM endpoints are not silently auto-executed
  - explicit execute still works

### Backend Scoring / Search / Deprecation / Telemetry

#### PR `#177` fix(#118): passive reverse-engineered artifacts into graph growth
- Auto:
  - `bun test tests/capture-dependency-prefetch.test.ts`
- Manual:
  - inspect capture output for passive artifact carry-forward
- Expect:
  - passive artifacts contribute to graph/publish path

#### PR `#187` feat(#117): telemetry-driven issue filing
- Auto:
  - `bun test tests/telemetry-issue-filing.test.ts`
- Manual:
  - force a failed execute and inspect repro bundle/issue payload
- Expect:
  - backend issue filing includes intent + diagnostics + repro bundle

#### PR `#188` feat(#175): RSC wire format support
#### PR `#189` feat(#165): grounded LLM descriptions
#### PR `#196` feat(#103): composite search scoring
- Auto:
  - `bun test tests/rsc-wire-format.test.ts tests/grounded-description.test.ts backend/tests/composite-scoring.test.ts`
- Manual:
  - capture an RSC-heavy page
  - inspect generated descriptions for params/response grounding
- Expect:
  - RSC not discarded as noise
  - descriptions mention required params and actual output fields
  - search ranking favors better semantic/reliability fit

#### PR `#192` feat(#99,#101): consecutive failures and schema drift deprecation
- Auto:
  - `bun test tests/deprecation-auto.test.ts backend/tests/scoring-deprecation.test.ts backend/tests/composite-scoring.test.ts`
- Manual:
  - repeatedly fail an endpoint or feed a critical drift case
- Expect:
  - status degrades
  - endpoint can auto-deprecate / mark failed
  - `auto_deprecated_at` present

### Host / Runtime / Docs / Eval

#### PR `#180` fix(#54): OpenClaw install warning smoke tests
#### PR `#190` docs(#178): OpenClaw plugin configuration
- Auto:
  - `bun test tests/openclaw-install-warnings.test.ts`
- Manual:
  - follow plugin install docs from scratch
- Expect:
  - warnings/docs match actual setup path

#### PR `#191` feat(#121): browser host path for OpenAI/native
#### PR `#195` feat(#91,#112,#90): host integrations, login UX, runtime supervisor
#### PR `#194` feat(#92,#93,#95,#96): search forms, eval stack, lifecycle attribution, docs
- Auto:
  - `bun test tests/browser-host-path.test.ts tests/host-integrations.test.ts tests/misc-p1-foundations.test.ts`
- Manual:
  - validate host path config surfaces and lifecycle/supervisor behavior
- Expect:
  - host integrations discoverable
  - runtime supervisor path works
  - search-form + lifecycle attribution regressions absent

#### PR `#184` feat(#33): x402 payment lane stub
- Auto:
  - `bun test tests/x402-payment-lane.test.ts`
- Manual:
  - inspect payment gate interface behavior only
- Expect:
  - stub path stable
  - no product claim beyond stub/minimal lane

## Suggested Run Order

1. `bash scripts/check-packaged-kuri.sh`
2. `bun test tests/cli-e2e.test.ts --timeout 120000` on fresh port
3. backend scoring/deprecation suite
4. orchestrator/browser-action/DAG suite
5. manual LinkedIn/auth/browser cases
6. host/docs/plugin/manual setup checks

## Explicit Gaps

- Open issues `#144`, `#152`, `#155` are not in this matrix; they are not merged.
- Some DAG behaviors need a purpose-built multi-step product case, not just unit tests.
- Payment path is still a stub; validate interface behavior, not real settlement.
