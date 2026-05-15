# unbrowse-mcp-evolve criteria

Built from 78 Reddit threads on r/MCP, r/webscraping, r/reverseengineering, r/learnjavascript, r/devops. Distilled 2026-05-15 by agent in-thread. Source dump: `.evidence-build/unbrowse-mcp-evolve/reddit-20260515T184112Z.jsonl`.

The signal is convergent: experienced scrapers and MCP authors say "stop defaulting to a heavy browser, find the network-tab XHR, replay it, walk the JS dependency chain, fall back to a browser only to LEARN, ship a token-efficient MCP surface, hot-reload between builds." This wave's product gap is making unbrowse do that as the default, not the exception.

## Pass criteria

Each bullet is a falsifiable acceptance criterion. The bench harness emits raw evidence; the agent judges PASS/FAIL by reading the artifacts.

- **lane-01-network-tab-first-replay**: For a content-read intent on a site with a JSON XHR/fetch endpoint, `unbrowse_resolve` returns that endpoint in `available_operations` and `unbrowse_execute` replays it via `server_fetch` (libcurl, no browser) within 1500ms p50 and 4000ms p95. Browser opens ONLY if the network-tab replay fails. Falsifier: pick 5 anchor-lane URLs from the existing corpus, count how many resolve to a captured XHR vs a `dom_extraction` page-artifact. Sources: [t3_1sjd609, t3_1ogl57n, t3_1rrcr4m, t3_1swj555]

- **lane-02-js-dependency-chain-walk**: When the picked endpoint requires a prior call (CSRF token, auth header from cookie, list-then-detail pattern), `executeEndpointWithChain` walks `requires[]` and refetches stale yields rather than reopening a browser. This is the DAG north-star (commit `b936ae46`); the falsifier is that on a CSRF-rotated endpoint, `decision_trace` shows `chain_walk_*` steps and no `4xx_live_session_fallback` event. Sources: [t3_1sjd609, t3_1ogl57n, t3_1n5br45]

- **lane-03-minimal-runtime-headless-default**: Every browser-bearing path in unbrowse (capture, recipe-replay-fallback, SSR-fast-path) uses `--headless=new` by default. No production code path opens a visible window unless `HEADLESS=false` (or `KURI_HEADLESS=false`) is explicitly set. Falsifier: grep `src/` for `headless: false`, `--no-headless`, or `chrome.launch(` with default args; assert only `src/auth/index.ts` (interactive auth) opts in. Sources: [t3_1sjd609, t3_1rrcr4m, t3_1rhjxet, t3_1ogl57n]

- **lane-04-headful-learn-fallback**: When headless replay fails (HTTP 4xx/5xx, JS-derived param drift, sig rotation), unbrowse opens a HEADFUL browser session, captures the new request shape, re-publishes the skill, and returns to headless replay on the next call. The headful path is a LEARNING path, never a serving path. Falsifier: trigger a CSRF rotation on a synthetic local server, observe a single headful-open → re-capture → subsequent headless replay succeeds. Sources: [t3_1swj555, t3_1mw3vsp, t3_1rrcr4m]

- **lane-05-token-efficient-mcp-surface**: `unbrowse_snap` and `unbrowse_resolve` responses expose THREE detail levels (default minimal, opt-in summary, opt-in full) modeled on the Charlotte MCP design. Default `unbrowse_resolve` on Wikipedia must return under 8KB; `unbrowse_snap` minimal must return under 1KB. Falsifier: probe HN + Wikipedia + a GitHub repo with default args; assert wire bytes against the 3 thresholds (8KB/1KB/full ≤ wire-budget cap). Sources: [t3_1rhjxet]

- **lane-06-hot-reload-mcp-proxy-workbench**: A dev-time proxy MCP at `.claude/mcps/unbrowse-workbench/` sits between Claude Code and the real unbrowse daemon, routes every tool call through both a CANDIDATE (today's build) and a BASELINE (previous tag) build, attaches a side-by-side delta to the response in `_workbench_delta`, and accepts a `SIGHUP`-style signal that hot-swaps which build is "live" without restarting the Claude Code session. Falsifier: `.claude/mcps/unbrowse-workbench/` exists, has a `mcp.json`, has a `bin/proxy.ts`, and a smoke test posts to both backends and returns a merged payload. Sources: [t3_1qiecmt, t3_1r8jv7r]

- **lane-07-self-improvement-loop-driven-by-agent**: When the agent calling unbrowse hits a regression mid-conversation (intent_status:failed in `unbrowse_reflect`), the response includes a structured `next_action` pointing at `unbrowse_diagnose` (already exists) AND a top-level `improvement_suggestion` field listing the named_regression + suggested fix-surface. This drives the agent to invoke the improvement loop on its own. Falsifier: drive a probe against a known-broken lane, assert `improvement_suggestion` is populated on the `unbrowse_reflect` response. Sources: [t3_1qiecmt, t3_1r8jv7r, t3_1rhjxet]

- **lane-08-mobile-android-fallback**: When desktop API replay fails (e.g. desktop endpoint is bot-shielded but mobile is not), the capture pipeline tries the mobile origin (m.example.com or User-Agent-Mobile fetch of the same path) before opening a browser. Falsifier: on a site where the mobile endpoint returns a richer JSON than the desktop SSR (gov-site pattern from t3_1rrcr4m), assert the captured skill includes the mobile endpoint variant. Sources: [t3_1rrcr4m, t3_1ogl57n]

## Out of scope

Marked here so the fleet does NOT dispatch against these even when they appear in failure traces:

- **anti-bot-bypass-cloudflare-datadome-perimeterx-captcha**: ADVERSARIAL HELD per `/unbrowse-self-build` skill rule. Sources: [t3_1mw3vsp, t3_1t6g5b4, t3_1qxb7cr, t3_1rqsvgp]
- **novel-dom-extractor-families**: per CLAUDE.md substrate principle, new extractor families are separate workloads, not improvement-loop fodder. Sources: [t3_1rhjxet]
- **ranking-confidence-calibration**: separate workload. Sources: [t3_1rhjxet]
- **kuri-zig-binary-changes**: never edit `src/kuri/client.ts` or the submodule per CLAUDE.md. Sources: [t3_1rhjxet]
- **proxy-rotation-residential-ips**: out of scope for this wave; the IProyal credential exists for ops use only. Sources: [t3_1rqsvgp, t3_1qxb7cr]

## Rubric (machine-readable)

```yaml
lanes:
  - id: lane-01-network-tab-first-replay
    description: resolve picks a captured XHR over a page-artifact when one exists; execute replays via server_fetch under 1500ms p50
    source_ids: [t3_1sjd609, t3_1ogl57n, t3_1rrcr4m, t3_1swj555]
    bench_signal: |
      echo "=== rankEndpoints LIST_INTENT promotion presence ==="
      grep -nE "LIST_INTENT|PAGE_ARTIFACT_DEMOTION" src/execution/index.ts | head -20
      echo "=== server_fetch vs browser strategy code path ==="
      grep -rnE "server_fetch|decideFromProbe|trigger_intercept" src/execution/ | head -10
      echo "=== existing test coverage ==="
      ls tests/ 2>/dev/null | grep -iE "page-artifact|rank|server-fetch|replay-context" | head -10
    pass_when: agent-judged-from-resolve-shortlist-and-execute-trace
  - id: lane-02-js-dependency-chain-walk
    description: executeEndpointWithChain walks requires[] and refetches stale yields without browser hop
    source_ids: [t3_1sjd609, t3_1ogl57n, t3_1n5br45]
    bench_signal: |
      echo "=== executeEndpointWithChain symbol ==="
      grep -nE "executeEndpointWithChain|chain_walk_" src/execution/index.ts src/orchestrator/*.ts 2>/dev/null | head -20
      echo "=== OperationBinding freshness fields ==="
      grep -nE "ttl_ms|single_use|observed_at|isBindingStale" src/types/skill.ts src/orchestrator/*.ts 2>/dev/null | head -20
      echo "=== chain-walk tests ==="
      ls tests/ 2>/dev/null | grep -iE "chain-walk|binding|csrf" | head -10
    pass_when: decision_trace contains chain_walk_* and no 4xx_live_session_fallback
  - id: lane-03-minimal-runtime-headless-default
    description: every production browser path uses headless=new by default
    source_ids: [t3_1sjd609, t3_1rrcr4m, t3_1rhjxet, t3_1ogl57n]
    bench_signal: |
      echo "=== headless: false / KURI_HEADLESS=false opt-ins (should be only auth/) ==="
      grep -rnE "headless[: ]+false|--no-headless|KURI_HEADLESS=false|HEADLESS=false" src/ 2>/dev/null | grep -vE "(test|spec)\." | head -30
      echo "=== resolveKuriLaunchConfig ==="
      grep -nE "resolveKuriLaunchConfig|--headless" src/kuri/client.ts 2>/dev/null | head -10
    pass_when: only src/auth/index.ts opts into headless=false
  - id: lane-04-headful-learn-fallback
    description: when headless replay fails, open headful ONLY to learn, re-capture, return to headless
    source_ids: [t3_1swj555, t3_1mw3vsp, t3_1rrcr4m]
    bench_signal: |
      echo "=== recipe_replay / drift / re-capture path ==="
      grep -rnE "recipe_replay|drift\\.|reCapture|reindex" src/execution/ src/api/ 2>/dev/null | head -20
      echo "=== headful-as-learning markers ==="
      grep -rnE "learning_only|headful_learn|capture_then_replay" src/ 2>/dev/null | head -10
    pass_when: CSRF rotation probe shows single headful-open then headless replay succeeds
  - id: lane-05-token-efficient-mcp-surface
    description: three detail levels on snap and resolve; defaults under 8KB resolve and 1KB snap
    source_ids: [t3_1rhjxet]
    bench_signal: |
      echo "=== existing detail_level / projection / diet surfaces ==="
      grep -rnE "detail_level|projection|dietIfOversize|wire_budget|MCP_WIRE_BUDGET" src/mcp.ts 2>/dev/null | head -25
      echo "=== snap response shape ==="
      grep -nE "unbrowse_snap|buildSnapResponse|diagnoseSnapshot" src/api/browse-snap-diagnostics.ts src/mcp.ts 2>/dev/null | head -10
    pass_when: wire bytes under thresholds on HN + Wikipedia + a GitHub repo
  - id: lane-06-hot-reload-mcp-proxy-workbench
    description: .claude/mcps/unbrowse-workbench proxies candidate vs baseline, hot-swaps which is live, no session restart
    source_ids: [t3_1qiecmt, t3_1r8jv7r]
    bench_signal: |
      echo "=== proxy workbench dir presence ==="
      ls -la .claude/mcps/unbrowse-workbench/ 2>&1 | head -10
      echo "=== mcp.json + proxy.ts ==="
      ls .claude/mcps/unbrowse-workbench/mcp.json .claude/mcps/unbrowse-workbench/bin/proxy.ts 2>&1
      echo "=== SIGHUP hot-swap handler ==="
      grep -rnE "SIGHUP|hot_swap|_workbench_delta" .claude/mcps/unbrowse-workbench/ 2>/dev/null | head -10
    pass_when: proxy emits _workbench_delta and SIGHUP swaps live build with no client reconnect
  - id: lane-07-self-improvement-loop-driven-by-agent
    description: unbrowse_reflect surfaces improvement_suggestion on failed intents to drive the agent to invoke the loop
    source_ids: [t3_1qiecmt, t3_1r8jv7r, t3_1rhjxet]
    bench_signal: |
      echo "=== unbrowse_reflect handler ==="
      grep -nE "unbrowse_reflect|reflect.*intent_status|improvement_suggestion" src/mcp.ts src/api/routes.ts 2>/dev/null | head -20
      echo "=== diagnose surface ==="
      grep -nE "unbrowse_diagnose|named_regression" src/mcp.ts 2>/dev/null | head -10
    pass_when: failed-lane probe returns improvement_suggestion with named_regression and fix-surface
  - id: lane-08-mobile-android-fallback
    description: capture tries mobile origin before opening a browser when desktop replay fails
    source_ids: [t3_1rrcr4m, t3_1ogl57n]
    bench_signal: |
      echo "=== mobile UA / m. subdomain logic ==="
      grep -rnE "mobile_user_agent|m\\.[a-z]+\\.com|MOBILE_UA|user_agent_mobile|tryMobileOrigin" src/ 2>/dev/null | head -15
      echo "=== User-Agent overrides in probe ==="
      grep -nE "user-agent|User-Agent" src/execution/probe.ts 2>/dev/null | head -10
    pass_when: captured skill includes mobile endpoint variant on at least one gov-pattern URL
out_of_scope:
  - anti-bot-bypass-cloudflare-datadome-perimeterx-captcha
  - novel-dom-extractor-families
  - ranking-confidence-calibration
  - kuri-zig-binary-changes
  - proxy-rotation-residential-ips
adversarial:
  - anti-bot-bypass-cloudflare-datadome-perimeterx-captcha
```
