# OpenClaw Eval Research

## How OpenClaw's Default Browser Tool Works (without unbrowse)

OpenClaw ships two default web-access tools that agents use when the unbrowse plugin is not installed:

### 1. `web_fetch` (HTTP fetch + readable extraction)
- Plain HTTP GET, no JavaScript execution
- Extracts main content using Readability (HTML → markdown/text)
- Optional Firecrawl fallback if configured
- Enabled by default (`tools.web.fetch.enabled` must not be false)
- Returns unstructured text; no schema, no structured data

### 2. `browser` (CDP-controlled Chromium)
- Runs a dedicated Chromium instance managed by the OpenClaw Gateway (loopback only)
- Underlying engine: Playwright via Chrome DevTools Protocol (CDP)
- Persistent WebSocket connection for real-time event streaming
- Available commands:
  - `tabs` — list open tabs
  - `open` — navigate to URL
  - `tab` / `newtab` / `close` — tab management
  - `elements` — list interactive elements with reference numbers
  - `click` / `type` / `upload` — UI interaction
  - `text` — extract visible page text
  - `html` — get element HTML
  - `eval` — run JavaScript in page
  - `screenshot`
  - `scroll`
- Data returned as raw text or HTML; agent must parse structure itself
- Runs on port 18792 via Browser Relay
- Three sub-modes: Extension Relay (controlling existing Chrome tabs), OpenClaw-managed (isolated profile), Remote CDP (cloud)

### Key weaknesses of the default path for data extraction tasks
- `web_fetch` skips JS, so SPAs and API-backed pages return little usable data
- `browser` returns raw DOM or page text; no automatic API discovery or schema inference
- Every run is first-run cost (no skill caching, no endpoint reuse)
- No structured output — agent must parse HTML/markdown and is prone to hallucination on tabular/nested data
- Auth sessions are isolated per browser profile; no vault-backed cookie sharing

---

## How the Unbrowse Plugin Replaces the Default Path

The plugin (`unbrowse-openclaw`, located at `integrations/openclaw/`) integrates via the OpenClaw Plugin SDK and does three things:

### 1. Registers the `unbrowse` tool
Wraps the local Unbrowse CLI binary (`bin/unbrowse.js`) as a first-class OpenClaw tool. Actions exposed:

| Action | CLI equivalent | Purpose |
|--------|---------------|---------|
| `resolve` | `unbrowse resolve --intent ... --url ...` | Discover + run best API-backed path for a task |
| `search` | `unbrowse search --intent ...` | Search skill marketplace |
| `execute` | `unbrowse execute --skill ... --endpoint ...` | Run a known cached endpoint |
| `login` | `unbrowse login --url ...` | Bootstrap auth for a site |
| `skills` | `unbrowse skills` | List available marketplace skills |
| `skill` | `unbrowse skill <id>` | Inspect one skill |
| `health` | `unbrowse health` | Verify local Unbrowse runtime |

The CLI is spawned as a child process with `UNBROWSE_URL` injected if a `baseUrl` config is set. Default timeout is 120 s (configurable up to 300 s).

### 2. Steers the agent away from `browser` (prompt hooks)
- `before_prompt_build` hook injects a system-prompt line each run: "Use `unbrowse` first for website retrieval, search, extraction..."
- `agent:bootstrap` hook injects a virtual file `UNBROWSE_BROWSER.md` into the session context with full decision rules
- In `strict` mode: `before_tool_call` hook intercepts any `browser` call and returns `block: true` with a redirect message pointing back to `unbrowse`

### 3. Routing modes
- **strict** (default): `browser` is blocked. Unbrowse handles all normal web tasks.
- **fallback**: `browser` remains available; agent is coached to prefer `unbrowse` first.

### Plugin config knobs relevant to benchmarking
| Key | Default | Eval relevance |
|-----|---------|---------------|
| `routingMode` | `strict` | Controls whether browser is available as fallback |
| `timeoutMs` | 120000 | Cap on per-call latency |
| `healthcheckOnStart` | true | Fires `unbrowse health` on service start |
| `allowBrowserFallback` | false in strict | Whether browser is permitted at all |
| `logStderr` | false | Enable for debugging failed calls |

---

## Existing Test Fixtures

Only one test file exists: `test/plugin.test.ts` (97 lines, Node test runner).

### What it covers (unit/structural only — no integration)
- Plugin metadata: `id`, `name`, `register` shape
- `buildBootstrapGuide`: strict mode forbids browser fallback; contains expected copy
- `buildSuggestedConfig`: fallback mode snippet does not include deny list
- `resolveUnbrowseBin`: resolves to `dist/cli.js` and the file exists
- `buildArgs`: arg construction for `resolve` action (intent, url, path, extract, limit, dry-run)
- `buildPromptGuidance`: strict mode includes "Strict mode is on"
- `buildBrowserFallbackBlockReason`: block message content
- Plugin manifest: `skills` array points to `./skills`; `SKILL.md` contains expected copy

### What is missing for benchmarking
No live integration tests, no fixture for:
- Actual `unbrowse resolve` end-to-end call
- Timing measurement (first-run vs. cached-run)
- Data quality comparison (unbrowse structured output vs. browser raw text)
- Success/failure classification per URL
- Side-by-side comparison of `web_fetch` vs. `browser` vs. `unbrowse` on the same task

---

## Proposed Eval Scenarios

Each scenario should be run against three paths:
1. **baseline-fetch**: OpenClaw `web_fetch` (no browser, no unbrowse)
2. **baseline-browser**: OpenClaw `browser` tool (CDP Chromium, no unbrowse)
3. **unbrowse**: Plugin in strict mode, `action=resolve` then optional `action=execute`

### Scenario set A — Public data extraction (task pages)
| # | URL | Intent |
|---|-----|--------|
| A1 | `https://news.ycombinator.com` | Extract top 10 story titles and scores |
| A2 | `https://github.com/trending` | List today's trending repos with star counts |
| A3 | `https://quotes.toscrape.com` | Extract all quotes and authors on page 1 |
| A4 | `https://books.toscrape.com/catalogue/page-1.html` | Extract book titles and prices |

### Scenario set B — Param-seeded search tasks
| # | URL | Intent | Params |
|---|-----|--------|--------|
| B1 | `https://pypi.org/search/` | Search for packages matching a keyword | `?q=pdf` |
| B2 | `https://www.npmjs.com/search` | Find npm packages for a topic | `?q=csv+parser` |
| B3 | `https://github.com/search` | Search GitHub repos | `?q=markdown+parser&type=repositories` |

### Scenario set C — API-backed / SPA surfaces (where web_fetch fails)
| # | URL | Intent |
|---|-----|--------|
| C1 | `https://api.github.com/repos/anthropics/claude-code` | Get repo metadata |
| C2 | `https://registry.npmjs.org/unbrowse` | Fetch package metadata |
| C3 | `https://hacker-news.firebaseio.com/v0/topstories.json` | Fetch top story IDs |

### Scenario set D — Authenticated reads (unbrowse advantage)
These require a pre-bootstrapped login via `unbrowse login`:
| # | Site | Intent |
|---|------|--------|
| D1 | `https://github.com` | Read notifications |
| D2 | `https://news.ycombinator.com` | Read saved stories |

---

## Metrics to Capture

### Latency
| Metric | Definition |
|--------|-----------|
| `first_run_ms` | Wall time from tool call start to structured result on a cold (no cache) run |
| `cached_run_ms` | Wall time on a second identical call (unbrowse can reuse discovered endpoint) |
| `cache_speedup_ratio` | `first_run_ms / cached_run_ms` — should be >3x for unbrowse to claim value |

### Data extraction quality
Scored 0–3 per scenario by agent review:
| Score | Meaning |
|-------|---------|
| 3 | Structured data returned, all required fields present, machine-readable |
| 2 | Partial structure or requires agent parsing of markdown/text |
| 1 | Raw text only; data is present but unstructured |
| 0 | No usable data returned (error, timeout, empty) |

### Success rate
`success` = score >= 2 AND no error/timeout.

| Metric | Definition |
|--------|-----------|
| `success_rate` | `n_success / n_total` per path per scenario set |
| `error_rate` | Tool returned error or timed out |
| `timeout_rate` | Exceeded `timeoutMs` (120 s default for unbrowse; browser has no cap) |

### Additional signals (unbrowse-specific)
- `skill_cache_hit`: whether `resolve` found an existing cached endpoint (`ready_for_review` with existing skill ID)
- `endpoint_selected`: whether a deferred endpoint was selected for execute
- `direct_result`: whether `resolve` returned structured data inline (no execute needed)
- `page_artifact_risk`: low/medium/high — proxy for reliability of the discovered path

---

## Implementation Notes for Harness (Task #7)

- Extend `evals/codex-harness.ts`; do not create a parallel harness
- Add a `--path baseline-fetch|baseline-browser|unbrowse` flag to select the path under test
- For `baseline-browser`, mock or wrap the OpenClaw `browser` tool call; capture raw text output and score it
- For `baseline-fetch`, issue a plain `fetch()` + Readability pass and capture result
- For `unbrowse`, use existing `resolve` + optional `execute` flow
- Record all three results for the same scenario in the same artifact so comparison is side-by-side
- Artifact key: `paths.baseline_fetch`, `paths.baseline_browser`, `paths.unbrowse`
- Agent review prompt should score all three paths in one pass to reduce judge variance
