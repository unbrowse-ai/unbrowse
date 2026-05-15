# unbrowse-mcp criteria: three step-chain axes

Built from the in-house bench corpus (`harness/probes/corpus-gate.txt`, 58 probes), the wave-1 convergence ledger (`~/.claude/skills/unbrowse-self-build/convergence.jsonl`), and the 18-row coverage ledger of shipped fixes (`~/.claude/skills/unbrowse-improvement-loop/coverage.jsonl`). Distilled 2026-05-16 by agent in-thread. No Reddit citations: each criterion cites the probe URL that surfaced it plus the commit SHA of any shipped fix.

The signal is convergent across waves: indexing has tab-isolation and capture-shape failures; retrieval has wrong-top-1, cross-host contamination, and auth-handoff misses; execution has url-template flattening, graphql-operation-name dropping, and (as of today) a workbench daemon-port collision that was silently making every probe measure baseline.

## Pass criteria

Each bullet is a falsifiable acceptance criterion. The bench harness emits raw evidence (per-probe per-axis intent_status, response shapes, decision_trace step names). The agent judges PASS/FAIL by reading the artifacts. No script grep-asserts a verdict.

### Indexing axis (unbrowse_go + snap + close)

- **lane-i01-tab-isolation-under-concurrency**: When N parallel `unbrowse_go` calls hit distinct URLs (N up to 16), each session's tab stays on its requested URL. `unbrowse_snap.current_url` matches the requested url for every concurrent session. No probe sees its tab navigated to a sibling session's URL. Falsifier: re-run the 16-probe wave through `/unbrowse-self-build` and assert zero `cross-session-tab-contamination` entries in the named_regression frequency table. Sources: probe `https://www.amazon.com/s?k=usb-c+cable` (wave-1 wave_id=wave-1-20260515), probe `https://openlibrary.org/search?q=dune` (wave-1), wave-1 ledger row `named_regression_frequency[4]`.

- **lane-i02-capture-pipeline-produces-callable-ops**: After `unbrowse_close`, the published skill's `available_operations` list contains only ops whose `endpoint_id` resolves in the registry. No phantom ops surfaced by resolve that execute then rejects as `endpoint_not_found`. Falsifier: drive a wave through corpus rows that previously surfaced `phantom-op-in-resolve-dag`; assert the resolve shortlist's `endpoint_id` values all return non-empty when passed to `unbrowse_execute`. Sources: probe `https://stackoverflow.com/questions/77531837` (wave-1, deleted upstream, replaced with /231767), probe `https://beatsaver.com/?q=camellia` (wave-1), commit `458220b0` (workflowDag/epRanked parity, partial fix).

- **lane-i03-capture-template-keeps-intent-querystring**: When `unbrowse_go` is called with a URL carrying a query/path-bearing intent (`?q=camellia`, `/r/{sub}`, `?term=machine+learning`), `unbrowse_close` publishes an endpoint whose `url_template` retains the intent-bearing structure, not a bare-root collapse. Falsifier: probe `beatsaver/?q=camellia`, `openlibrary/search?q=dune`, `crates.io/search?q=tokio`; assert published `url_template` contains either a `{q}` placeholder or the literal querystring. Sources: probe `https://beatsaver.com/?q=camellia` (wave-1, FIXED), probe `https://openlibrary.org/search?q=dune`, commit `ebfd70dd` (resolveExecutionUrlTemplate no longer flattens, shipped 2026-05-16).

- **lane-i04-workbench-isolates-candidate-vs-baseline**: When the workbench proxy is in use, candidate and baseline children each spawn their own Fastify daemon on distinct ports (defaults `:6970` / `:6971`). Health-check each port; the candidate daemon reports its source version and the baseline daemon reports the v6.16.0 tag. `_workbench_delta.structural_diff_summary` is NOT `"identical"` for probes where the substrate change matters. Falsifier: after `/mcp` reconnect, `curl :6970/health` and `curl :6971/health` return different `package_version` values. Sources: wave-2-20260516 aborted row in convergence.jsonl, commit `01f2f5b9` (per-side UNBROWSE_URL, shipped 2026-05-16, this skill's prereq).

### Retrieval axis (unbrowse_resolve)

- **lane-r01-top-1-matches-intent-not-telemetry**: For list-shaped intents (`search amazon for X`, `tweets from Y`, `feed posts`), `unbrowse_resolve.available_operations[0]` is a results-list endpoint, not a count endpoint, telemetry write, or auth bouncer. Page-artifact promotion fires for data-rich SSR pages. Falsifier: probe `github.com/search?q=anthropic&type=repositories`, `linkedin.com/feed/`, `amazon.com/s?k=usb-c+cable`; assert top-1 returns array/list-shaped data, not a `{count: N}` blob or `InGraphs telemetry gauge`. Sources: probe `https://github.com/search?q=anthropic&type=repositories` (wave-1 partial, `ranker-wrong-pick`), probe `https://www.linkedin.com/feed/` (wave-1 failed, `auth-handoff-missing-next-step`), commit `458220b0` (workflowDag parity partial fix).

- **lane-r02-sample-values-stay-on-domain**: When resolve returns an endpoint with `url_template` for host A, the endpoint's `sample_values` come from host A's capture, not a cross-host leak from another wave-1 session. Falsifier: probe `openlibrary.org/search?q=dune` after several other sessions on different domains have closed; assert resolved endpoint's `sample_values` parse as openlibrary search results, not stackoverflow JSON-LD or any other host. Sources: probe `https://openlibrary.org/search?q=dune` (wave-1 failed, `sample_values-cross-host-contamination`).

- **lane-r03-auth-handoff-emits-next-action**: When resolve lands on a URL that requires authentication (linkedin/feed redirects to `/`, gmail/inbox shows login, etc.), the resolve response carries `status: auth_required` AND a structured `next_action.command: "unbrowse_auth_capture"` with the right url. No silent fallback to a write-on-read telemetry endpoint. Falsifier: probe the 8 auth-gated corpus rows; assert each returns `auth_required` with a callable `next_action`, not `status: ok` with telemetry. Sources: probe `https://www.linkedin.com/feed/` (wave-1 failed), auth-gated corpus rows 53-60.

- **lane-r04-graphql-op-name-surfaces-in-shortlist**: For sites whose data is behind a GraphQL POST endpoint (x.com, threads.net, instagram), the capture+resolve pipeline extracts and ranks operations by `operationName`, not by raw POST-body match. The top-1 for "search tweets" is the GraphQL `SearchTimeline` op, not a telemetry post. Falsifier: probe `x.com/search?q=AI+agents`, `x.com/elonmusk`, `threads.net/`; assert resolve returns operations whose `endpoint_id` references a GraphQL operationName surfaced from captured request bodies. Sources: probe `https://x.com/search?q=AI+agents` (wave-1 failed, `graphql-operation-name-extraction`), probe `https://x.com/elonmusk` (wave-1 failed), CLAUDE.md Known Issues section.

- **lane-r05-resolve-miss-emits-mcp-shaped-next-step**: When resolve returns `status: no_match` or `not_found`, the response carries `next_step` shaped for MCP tools/call (not CLI verbs), `relevant_options[]`, and `suggested_tool_sequence[]`. Falsifier: probe a fresh cold URL not in the marketplace; assert `next_step.command` references an `unbrowse_*` MCP tool, not a CLI verb like `unbrowse capture --url ...`. Sources: probe `https://github.com/notifications` (coverage row 11), probe `https://stackoverflow.com/questions/tagged/typescript` (coverage row 12), commits `84f2c9cc` + `c6386199` (shipped 2026-05-15).

### Execution axis (unbrowse_execute)

- **lane-e01-execute-replays-with-query-params**: When the agent passes `params: {q: "camellia"}` to `unbrowse_execute` on a templated endpoint, the executed URL substitutes the param into the template AND the response is search results for the substituted value, not a homepage. Falsifier: probe `beatsaver/?q=camellia` + `crates.io/search?q=tokio` + `openlibrary/search?q=dune` + `pubmed/?term=machine+learning`; assert each `execute` response is a non-empty list containing entities matching the query value. Sources: probe `https://beatsaver.com/?q=camellia` (wave-1 failed, FIXED in `ebfd70dd`), probe `https://crates.io/search?q=tokio`, probe `https://openlibrary.org/search?q=dune`, probe `https://pubmed.ncbi.nlm.nih.gov/?term=machine+learning`.

- **lane-e02-execute-raw-returns-real-body**: `unbrowse_execute --raw` returns the response body verbatim (with auto-extract firing only above 64KB). Not extraction_hints, not schema, not a truncated preview. Falsifier: probe any anchor row; assert `raw:true` response carries `content[0].text` containing actual page content (post titles, package versions, repo descriptions, etc.). Sources: probe `https://news.ycombinator.com/`, probe `https://www.npmjs.com/package/openai`, probe `https://crates.io/search?q=tokio` (all anchors wave-1 achieved), CLAUDE.md Agent UX North Star invariant 4.

- **lane-e03-execute-honors-improvement-suggestion**: When `unbrowse_execute` detects a regression mid-flight (drift, write-on-read pick, empty response), the response carries `improvement_suggestion.named_regression` and `improvement_suggestion.candidate_fix_surface[]` so the calling agent (or fleet) knows which file/line to fix. Falsifier: probe a known-degraded URL where wave-1 surfaced a named_regression; assert `improvement_suggestion` is populated AND its `candidate_fix_surface[0]` references a real `src/...` path. Sources: wave-1 AC5 (improvement_suggestion landed in `enrichWithImprovementSuggestion`), AC3 (re_capture_signal for drift).

- **lane-e04-execute-graphql-sends-right-op**: For GraphQL operations resolved in retrieval lane-r04, execute reshapes the agent's `params` into the operation's `variables` shape (json-encoded) and POSTs with the right `operationName`. Response contains real entities for the requested operation. Falsifier: probe `x.com/search?q=AI+agents`; assert execute returns tweets containing "AI agents", not an error / empty / wrong-op. Sources: probe `https://x.com/search?q=AI+agents` (wave-1 failed), CLAUDE.md Known Issues.

## Out of scope

The fleet does NOT dispatch against these even when they appear in failure traces:

- **anti-bot-bypass-cloudflare-datadome-perimeterx-captcha**: ADVERSARIAL HELD per `/unbrowse-self-build` skill rule. Sources: corpus-gate.txt rows 63-77 (hostile lane).
- **kuri-zig-binary-changes**: never edit `src/kuri/client.ts` or the submodule per CLAUDE.md.
- **novel-dom-extractor-families**: per CLAUDE.md substrate principle, separate workload.
- **ranking-confidence-calibration**: separate workload per `unbrowse-mcp-evolve` spec.
- **proxy-rotation-residential-ips**: out of scope for this wave; IProyal credential exists for ops use only.

## Rubric (machine-readable)

```yaml
axes:
  - id: indexing
    lanes:
      - id: lane-i01-tab-isolation-under-concurrency
        description: parallel unbrowse_go calls keep tabs isolated; snap.current_url matches requested url
        source_ids:
          - probe:https://www.amazon.com/s?k=usb-c+cable
          - probe:https://openlibrary.org/search?q=dune
          - ledger:wave-1-20260515.named_regression_frequency[cross-session-tab-contamination]
        bench_signal: |
          echo "=== concurrent-go tab isolation symbols ==="
          grep -nE "currentTabId|tabPool|sessionId" src/api/browse-session.ts src/runtime/browser-host.ts 2>/dev/null | head -20
          echo "=== snap current_url field ==="
          grep -nE "current_url|getCurrentUrl" src/api/browse-session.ts src/api/routes.ts 2>/dev/null | head -10
          echo "=== existing tab-isolation tests ==="
          ls tests/ 2>/dev/null | grep -iE "browse-snap|tab|concurrent|session" | head -10
        pass_when: zero cross-session-tab-contamination in wave-2 named_regression_frequency
      - id: lane-i02-capture-pipeline-produces-callable-ops
        description: published available_operations only contains endpoint_ids that execute will accept
        source_ids:
          - probe:https://beatsaver.com/?q=camellia
          - ledger:coverage.jsonl[15-458220b0]
        bench_signal: |
          echo "=== filterDagOperationsByRankedEndpoints helper ==="
          grep -nE "filterDagOperationsByRankedEndpoints|available_operations" src/graph/index.ts src/orchestrator/index.ts 2>/dev/null | head -20
          echo "=== endpoint_not_found path ==="
          grep -rnE "endpoint_not_found|unknown_endpoint_id" src/execution/ src/mcp.ts 2>/dev/null | head -10
        pass_when: every endpoint_id surfaced by resolve resolves on execute
      - id: lane-i03-capture-template-keeps-intent-querystring
        description: published url_template retains querystring/path that carries the intent
        source_ids:
          - probe:https://beatsaver.com/?q=camellia
          - probe:https://openlibrary.org/search?q=dune
          - ledger:coverage.jsonl[18-ebfd70dd]
        bench_signal: |
          echo "=== templateCarriesIntentSignal helper ==="
          grep -nE "templateCarriesIntentSignal|resolveExecutionUrlTemplate" src/execution/index.ts 2>/dev/null | head -10
          echo "=== execution-replay-context tests ==="
          ls tests/execution-replay-context.test.ts 2>/dev/null && head -1 tests/execution-replay-context.test.ts
        pass_when: top-1 url_template retains the agent-intended query/path
      - id: lane-i04-workbench-isolates-candidate-vs-baseline
        description: candidate and baseline daemons bind distinct ports; _workbench_delta non-identical when source diverges
        source_ids:
          - ledger:convergence.jsonl[wave-2-20260516.cause=workbench-daemon-port-collision]
          - commit:01f2f5b9
        bench_signal: |
          echo "=== per-side UNBROWSE_URL in proxy ==="
          grep -nE "UNBROWSE_URL_CANDIDATE|UNBROWSE_URL_BASELINE" .claude/mcps/unbrowse-workbench/bin/proxy.ts 2>/dev/null | head -10
          echo "=== per-side tests ==="
          ls .claude/mcps/unbrowse-workbench/tests/per-side-url.test.ts 2>/dev/null
          echo "=== daemon ports up ==="
          curl -sS --max-time 1 http://127.0.0.1:6970/health 2>&1 | head -c 200
          echo
          curl -sS --max-time 1 http://127.0.0.1:6971/health 2>&1 | head -c 200
        pass_when: curl :6970/health reports candidate version, curl :6971/health reports baseline version
  - id: retrieval
    lanes:
      - id: lane-r01-top-1-matches-intent-not-telemetry
        description: resolve.available_operations[0] is real data for list intents, not count/telemetry/auth
        source_ids:
          - probe:https://github.com/search?q=anthropic&type=repositories
          - probe:https://www.linkedin.com/feed/
          - probe:https://www.amazon.com/s?k=usb-c+cable
        bench_signal: |
          echo "=== LIST_INTENT promotion ==="
          grep -nE "LIST_INTENT|PAGE_ARTIFACT_DEMOTION|isWriteOnReadHeuristic" src/execution/index.ts 2>/dev/null | head -20
          echo "=== rankEndpoints tests ==="
          ls tests/ 2>/dev/null | grep -iE "rank|page-artifact|write-on-read" | head -10
        pass_when: agent reads execute response, judges shape matches intent
      - id: lane-r02-sample-values-stay-on-domain
        description: resolved endpoint sample_values come from the host of its url_template
        source_ids:
          - probe:https://openlibrary.org/search?q=dune
        bench_signal: |
          echo "=== sample-values cross-host guards ==="
          grep -rnE "sample_values|cross_host|hostMatches" src/orchestrator/ src/capture/ 2>/dev/null | head -20
          echo "=== existing host-match tests ==="
          ls tests/ 2>/dev/null | grep -iE "cross-host|sample.*value|host.*match" | head -10
        pass_when: openlibrary endpoint's sample_values parse as openlibrary entities
      - id: lane-r03-auth-handoff-emits-next-action
        description: auth_required resolve returns mcp-shaped next_action.command for unbrowse_auth_capture
        source_ids:
          - probe:https://www.linkedin.com/feed/
          - corpus:auth-gated.rows-53-60
        bench_signal: |
          echo "=== auth_required handling ==="
          grep -rnE "auth_required|unbrowse_auth_capture|next_action" src/orchestrator/ src/mcp.ts 2>/dev/null | head -20
          echo "=== auth-handoff tests ==="
          ls tests/ 2>/dev/null | grep -iE "auth.*handoff|auth.*next|auth.*capture" | head -10
        pass_when: linkedin/feed and 7 other auth-gated probes return auth_required with callable next_action
      - id: lane-r04-graphql-op-name-surfaces-in-shortlist
        description: GraphQL POST endpoints are decomposed and surfaced by operationName in resolve shortlist
        source_ids:
          - probe:https://x.com/search?q=AI+agents
          - probe:https://x.com/elonmusk
        bench_signal: |
          echo "=== decomposeGraphqlEndpoint helper ==="
          grep -nE "decomposeGraphqlEndpoint|operationName|graphql" src/capture/extractEndpoints.ts src/orchestrator/index.ts 2>/dev/null | head -20
          echo "=== graphql tests ==="
          ls tests/ 2>/dev/null | grep -iE "graphql|operation.*name" | head -10
        pass_when: x.com probes surface GraphQL ops keyed by operationName
      - id: lane-r05-resolve-miss-emits-mcp-shaped-next-step
        description: no_match resolve emits MCP-shaped next_step.command not CLI verbs
        source_ids:
          - ledger:coverage.jsonl[11-84f2c9cc]
          - ledger:coverage.jsonl[12-c6386199]
        bench_signal: |
          echo "=== addResolveMissGuidance ==="
          grep -nE "addResolveMissGuidance|MISS_STATUSES" src/mcp.ts 2>/dev/null | head -10
          echo "=== mcp-resolve-no-match-guidance test ==="
          ls tests/mcp-resolve-no-match-guidance.test.ts 2>/dev/null
        pass_when: no_match resolve responses contain unbrowse_* tool name in next_action
  - id: execution
    lanes:
      - id: lane-e01-execute-replays-with-query-params
        description: execute interpolates params into url_template; response is real search results
        source_ids:
          - probe:https://beatsaver.com/?q=camellia
          - probe:https://crates.io/search?q=tokio
          - probe:https://openlibrary.org/search?q=dune
          - probe:https://pubmed.ncbi.nlm.nih.gov/?term=machine+learning
        bench_signal: |
          echo "=== interpolate / url-template ==="
          grep -nE "interpolate|url_template|substituteParams" src/execution/index.ts src/execution/url-template.ts 2>/dev/null | head -20
          echo "=== template tests ==="
          ls tests/ 2>/dev/null | grep -iE "url-template|execution-replay|interpolat" | head -10
        pass_when: 4 templated probes each return matching search results on raw:true execute
      - id: lane-e02-execute-raw-returns-real-body
        description: execute raw=true returns actual body (auto-extract only > 64KB)
        source_ids:
          - probe:https://news.ycombinator.com/
          - probe:https://www.npmjs.com/package/openai
          - probe:https://crates.io/search?q=tokio
        bench_signal: |
          echo "=== raw / auto-extract threshold ==="
          grep -rnE "raw[\"']?\\s*[:=]|autoExtract|64.*KB|extraction_hints" src/execution/ src/mcp.ts 2>/dev/null | head -20
          echo "=== raw tests ==="
          ls tests/ 2>/dev/null | grep -iE "raw|auto.*extract|truncation" | head -10
        pass_when: anchor probes return content[0].text containing page-real strings on raw:true
      - id: lane-e03-execute-honors-improvement-suggestion
        description: execute response carries improvement_suggestion when a regression is detected mid-flight
        source_ids:
          - ledger:wave-1-20260515.AC5
        bench_signal: |
          echo "=== improvement_suggestion field ==="
          grep -rnE "improvement_suggestion|enrichWithImprovementSuggestion|named_regression" src/mcp.ts src/mcp-improvement-suggestion.ts 2>/dev/null | head -20
          echo "=== improvement-suggestion tests ==="
          ls tests/ 2>/dev/null | grep -iE "improvement|suggestion" | head -10
        pass_when: known-degraded probe returns improvement_suggestion with valid candidate_fix_surface
      - id: lane-e04-execute-graphql-sends-right-op
        description: execute reshapes params into GraphQL variables and posts with the right operationName
        source_ids:
          - probe:https://x.com/search?q=AI+agents
        bench_signal: |
          echo "=== graphql execute path ==="
          grep -rnE "operationName|graphql.*variables|postGraphql" src/execution/ 2>/dev/null | head -20
        pass_when: x.com search execute returns tweets matching AI agents query
out_of_scope:
  - id: out-anti-bot
    description: anti-bot bypass (cloudflare/datadome/perimeterx/captcha) is ADVERSARIAL_HELD
    source_ids: [corpus:hostile.rows-63-77]
  - id: out-kuri
    description: kuri zig binary changes (src/kuri/client.ts + submodule) per CLAUDE.md
  - id: out-extractor-families
    description: novel DOM extractor families - separate workload per substrate principle
  - id: out-rank-calibration
    description: ranker-confidence calibration - separate workload
  - id: out-proxy-rotation
    description: residential proxy rotation - ops only, not a wave fix
```
