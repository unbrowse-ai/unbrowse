# Unbrowse Agent Experience — Issue Inventory

North star: **minimize browser opens.** Every issue below is graded by how often it forces an agent to open a browser when resolve+execute should have sufficed.

## Headline metrics (analysis of latest 447 sessions, Apr 2026)

- **125** sessions with unbrowse activity · **1467** unbrowse calls · **253** distinct task units
- **41.1%** browser-open rate per task — this is the number to drive down
- **25** tasks where the agent gave up entirely after resolve failed (no browser, no fallback) — pure user-facing failures
- **27** redundant resolve loops (same host, repeated empty result before fallback)
- Top 5 domains = **61% of all browser opens** (138/227): `ads.x.com` (62), `linkedin.com` (34), `127.0.0.1` (16), `priceline.com` (15), `cheongdam.myneon.me` (11)

Top failure patterns (with session evidence in `/tmp/unbrowse-session-analysis.md`):
| Pattern | Count | Notable domains |
|---|---|---|
| `generic_error` on resolve | 47 | skyscanner, libgen, nusmods |
| `execute_fail:generic_error` | 33 | reddit (wrong-template) |
| `execute_fail:timeout` | 14 | — |
| `stale_skill` | 14 | tiktok, promptrefs |
| `execute_fail:empty_data` | 9 | linkedin |
| `graphql_post` | 6 | ads.x.com |
| `auth_gated` | 4 | x.com home, github trending |

Direct-quote triggers from sessions:
- "The cached routes are all from ads.x.com, not the main feed. I'll browse x.com/home directly." → A2/A4
- "The cached endpoint is just for recent searches, not the actual hotel search." → A1
- "Let me browse that site and find you some good food options." → DIRECT_BROWSER, no resolve attempt → F1
- "Unbrowse server crashed. Let me restart it and try again." → Kuri stability bleeding into resolve UX

Sources: 447-session analysis (`/tmp/unbrowse-session-analysis.md`, analyzer at `/tmp/analyze_unbrowse.py`), CLAUDE.md "Known Issues to Fix", live jup.ag incident (Apr 29), bench-local rubric.

Severity: **P0** = directly causes browser-opens at scale · **P1** = degrades resolve quality · **P2** = polish/UX.

---
## A. Resolve correctness (top cause of browser fallbacks)

### A1. Wrong endpoint template match — semantic params ignored [P0]
- Symptom: resolving `reddit.com/r/singularity` executes the `r/programming` endpoint because URL template `/r/{subreddit}` matched both.
- Root cause: ranker matches on URL shape, not on the meaning of params. Endpoint descriptions are shallow ("Reddit subreddit page") instead of "Get posts from subreddit `{subreddit}`; subreddit identifies the community."
- Fix: LLM reverse-engineers per-endpoint descriptions that name each param's semantic role; resolver matches intent → endpoint → param fill.
- Evidence: CLAUDE.md "Known Issues to Fix".

### A2. Cached skill returned without freshness check [P0]
- Symptom: jup.ag (Apr 29) — resolve kept returning the same stale skill; the actual page is SSR-rendered, so the cached "endpoint" no longer corresponds to where the data lives. Agent had no signal to distrust it and fell into browser.
- Root cause: published skills have no last-success timestamp, no error-rate, no schema-drift detection. Stale skills rank high forever.
- Fix: every execute updates `last_success_at` + `last_status_code` + response-schema hash on the skill; ranker penalizes stale/erroring skills; auto-deprecate after N consecutive failures.

### A3. SSR-heavy SPAs don't have a "real" API to capture [P0]
- Symptom: Next.js / Nuxt / Remix sites embed data in `__NEXT_DATA__` / `<script id="__NUXT__">`; the page renders from that, no XHR fires. extractEndpoints captures nothing useful → resolve miss → browser.
- Fix: first-class SSR-payload extractor as a "virtual endpoint" — `extract:next-data:<url-pattern>` returns the embedded JSON. Same execute interface as a real HTTP endpoint.
- Related: feedback_extraction_silent_truncation (MAX_HTML_SIZE truncation already eats Next.js payloads silently).

### A4. GraphQL POST endpoints filtered out [P0]
- Symptom: X.com `HomeTimeline`, many modern apps. extractEndpoints rejects POST-with-large-JSON-body (`body_not_json_or_html` or `score_non_positive`).
- Fix: GraphQL detection — if body has `operationName` / `query` keys, treat `operationName` as the route key, not the URL. Score positively. Already partially done per commit 688c79ad; extend.
- Evidence: CLAUDE.md known issues.

### A5. Public APIs we already know about aren't shortcircuited [P1]
- Symptom: Apr 29 jup.ag — Jupiter has a fully documented public API (`api.jup.ag/price/v2`, `tokens.jup.ag`, `api.jup.ag/swap/v1/quote`). Agent had no way to know that without a manual nudge.
- Fix: well-known-API registry seeded with documented public APIs (Jupiter, Solana RPC, GitHub, Stripe, OpenAI, etc.). Resolve checks registry before falling back to capture/browser. Free wins, zero browser opens.

### A6. Resolve doesn't expose a confidence score [P1]
- Symptom: agent can't distinguish "very likely the right endpoint" from "best of a bad lot." Without confidence, the agent either trusts wrong matches (A1) or distrusts good ones and opens a browser anyway.
- Fix: return `confidence` per available_operation (template specificity, recency, success rate, semantic-match score). Agent thresholds before browser.

---

## B. Capture pipeline gaps

### B1. Kuri HAR misses async fetch/XHR [P0]
- Symptom: HAR via CDP doesn't capture all SPA requests. The JS interceptor catches the rest, but merge logic on close drops some.
- Fix: ensure HAR ∪ interceptor merge is total; add a probe that diffs counts and logs when interceptor saved a request HAR missed.
- Evidence: CLAUDE.md known issues.

### B2. `getCurrentUrl` / `getPageHtml` can return `"[object Object]"` [P1]
- Symptom: Kuri CDP shape changes silently break extraction. Already documented in CLAUDE.md.
- Fix: assert `url.startsWith("http")` and `html.startsWith("<")`; raise a typed error + fallback path instead of feeding garbage downstream.

### B3. HAR header iteration crashes on undefined [P1]
- Symptom: bare `entry.request.headers` blows up; CLAUDE.md mandates `?? []`. Still easy to regress.
- Fix: a single `iterHarEntry()` helper everywhere; lint rule banning bare `entry.request.headers`.

### B4. Silent extraction truncation on SPAs [P0]
- Symptom: `MAX_HTML_SIZE` + non-greedy regex erase Next.js/Apollo/Nuxt SSR payloads with no warning.
- Fix: when truncation triggers, emit a `truncated_bytes` field in evidence; stream-extract instead of substring-then-regex for known SSR shapes.
- Evidence: feedback_extraction_silent_truncation.

### B5. Browser-block detection is ad-hoc [P1]
- Symptom: bench-local has good vendor signals (perimeterx, datadome, cloudflare) but the live resolve path doesn't surface them to the agent. Agent sees "no endpoints" and opens browser, which gets blocked too.
- Fix: bubble `browser_block_signals` up into resolve's response; agent skips browser when block is detected and reports back.

---

## C. Execute reliability

### C1. Auth token DAG can return expired credentials [P1]
- Symptom: execute returns 401 even when a valid cookie exists in browser DB; agent reopens browser to "re-auth" when it didn't need to.
- Fix: token freshness check pre-execute; on 401, attempt cookie re-extract before declaring auth failure.

### C2. Param fill silently sends wrong values [P0]
- Coupled with A1 — when template matches wrong endpoint, params get filled with the right name but wrong target ("singularity" → r/programming endpoint).
- Fix: covered by A1; add post-execute response sanity check (does the response contain the param value the agent asked for?).

### C3. `--extract` returns `[]` even when raw body has data [P1]
- Symptom: extraction path mismatch in execute. Per CLAUDE.md release-review, retry with `--raw` works.
- Fix: on extract returning empty + non-empty raw, auto-fall-back to raw with a flag in the response, instead of forcing the agent to retry.

### C4. Execute doesn't tell agent why it failed [P1]
- Symptom: `data: []` is ambiguous (extraction bug? endpoint dead? wrong param?). Agent's only recourse is browser.
- Fix: structured `failure_reason` enum: `extraction_empty`, `endpoint_dead`, `auth_required`, `wrong_param`, `rate_limited`. Each has a non-browser remediation.

---

## D. Browse-session handoff (when browser IS opened)

### D1. Browser session opens but agent doesn't know what to do next [P1]
- Symptom: resolve miss returns `{ status: "browse_session_open", next_step: "unbrowse snap" }` but agent often closes immediately or doesn't drive long enough to capture the real endpoint.
- Fix: on browse_session_open, return a tighter playbook tailored to the intent ("scroll to load timeline", "click first result"). Make the next-step machine-actionable.

### D2. Passive capture not aggressive enough during handoff [P1]
- Symptom: agent does one snap + one eval, closes; the long-tail XHRs that fire on user interaction never get captured.
- Fix: keep capture session alive for N seconds after close; flush all interceptor data even if HAR ends early.

### D3. Cold Kuri start times out resolve [P1]
- Symptom: per CLAUDE.md release review, browse can skip on remote due to cold start.
- Fix: warm Kuri on `unbrowse` daemon spawn so the first browse_go isn't paying cold-start cost.

---

## E. Marketplace / supply side

### E1. Stale skills rank high forever [P0]
- See A2. Add staleness penalty + auto-deprecate.

### E2. Skill descriptions too generic to be matched semantically [P1]
- See A1. LLM-augmented descriptions during publish, not at resolve time.

### E3. No "this skill works for intent X" feedback loop [P2]
- Every successful execute should tag the skill with the intent that resolved to it. Future intent matches use this.

---

## F. Agent UX / DX

### F1. No "should I even use unbrowse here?" signal [P1]
- jup.ag-style: agent doesn't realize a public documented API exists. Covered by A5.
- Generalize: pre-resolve hint API — "this domain has documented APIs at X, prefer those."

### F2. Error messages don't tell the agent what to do [P1]
- Many errors (`auth_required`, `no_endpoints`) don't include actionable next steps. Agent defaults to browser.
- Fix: every error returns `{ code, message, next_action }`.

### F3. Repeated identical resolves across a session [P2]
- Sessions show agents re-resolving the same intent multiple times. Cache resolve results within a session.

### F4. No telemetry into "browser-open rate" per release [P0]
- We can't tell if a release made things better or worse without per-release agent-experience metrics.
- Fix: emit `browser_opened: bool` on every unbrowse task; aggregate into release dashboard. Tie to north-star metric.

---

## G. Data we don't yet have

### G1. Session-level "did this require a browser?" signal [P0]
- The latest 774-session analysis stalled because tool names vary (`mcp__unbrowse__*`, bare `unbrowse <verb>` Bash, `browse_*`). No canonical event marker.
- Fix: emit a structured event from the unbrowse server tagged `task_id` covering full lifecycle (resolve_start → execute_end OR browser_opened). Pipe into a dashboard.

### G2. No regression test for SSR-payload sites [P0]
- jup.ag, vercel.com, linear.app, notion.so all SSR-heavy. None in bench-local corpus today (or covered too thinly).
- Fix: dedicated SSR corpus + matching extractor tests.

---

## Recommended fix order (by browser-opens eliminated)

1. **A2 (skill freshness)** + **A5 (public-API registry)** — fastest path to killing the jup.ag-class regression.
2. **A1 + C2 (semantic param matching)** — unblocks the wrong-endpoint family (Reddit, etc.).
3. **A3 (SSR-payload virtual endpoints)** + **B4 (truncation visibility)** — recovers the entire Next.js/Nuxt SPA class.
4. **A4 (GraphQL POST)** — recovers X.com timeline class.
5. **F4 + G1 (browser-open telemetry)** — without this, we can't measure any of the above.
6. **A6 (confidence scores)** + **F2 (actionable errors)** — agent makes better decisions on borderline cases.
7. Everything else.

## Open instrumentation ask

We need session-analysis to actually work. Today, parsing 447 sessions only surfaced 18 with structured unbrowse calls because the tool naming is inconsistent. Land G1 (canonical task event) before the next round of agent-experience analysis or we'll keep flying blind.

---

## H. New issues surfaced by 447-session analysis

### H1. LinkedIn chronic blind spot — execute returns empty data [P0]
- 11 distinct sessions, 80 resolve attempts, 69% resolve hit rate, but execute returns `data:[]` repeatedly. Recurring intent: "get my LinkedIn feed posts."
- Single biggest UX wound in the dataset.
- Likely cause: cached endpoint is auth-gated GraphQL or returns user-specific Voyager API shape that extraction can't unwrap.
- Fix: dedicated LinkedIn extractor + auth-cookie validation pre-execute (overlaps C1, C3, C4).

### H2. `ads.x.com` resolves 100% but opens 62 browsers anyway [P1]
- Agent intentionally drives the X Ads dashboard with `unbrowse go` for *capturing* GraphQL POST flows. This is the agent compensating for A4.
- Symptom of the GraphQL POST blindspot — the only way to capture is to drive the UI.
- Fix: A4 (GraphQL POST extractor) + first-class "interactive capture session" verb so this isn't accounted as a resolve failure.

### H3. `unbrowse start-session` verb missing for legitimate interactive flows [P1]
- 45 DIRECT_BROWSER tasks bypass resolve entirely — logins, multi-step wizards, "let me just browse and pick." Today these masquerade as resolve failures in metrics.
- Fix: add a verb that signals "I know I need a browser, this isn't a resolve miss." Cleans up telemetry (F4) and stops penalizing the resolve hit-rate denominator.

### H4. Unbrowse server crashes leak into resolve UX [P0]
- Multiple sessions (`e718bcc4…`L263 cited) literally say "Unbrowse server crashed. Let me restart it and try again."
- Each crash = browser fallback + agent confusion + retry tax.
- Fix: server stability sweep (Kuri lifecycle, HAR teardown races, port reuse). Stability is upstream of every other fix.

### H5. Per-domain blind spots never escalate [P1]
- `facebook.com` — 4 resolve attempts at 25% hit rate, agent silently gave up, no browser, no telemetry.
- Fix: per-domain hit-rate metric with auto-flag when <50% over N attempts. Drives index-coverage work.

### H6. Same-host resolve loop wastes round-trips [P1]
- 27 instances of agent re-resolving same host after first miss before falling back.
- Fix: after first same-host miss in a session, return a hard handoff stub instead of empty `available_operations` so the agent doesn't burn another resolve round-trip.

### H7. Priceline-style param confusion [P1]
- "Recent searches" endpoint cached as the canonical match for "search hotels" intent. Same family as A1 but specifically: endpoint name vs. intent name overlap.
- Fix: covered by A1 + A6 confidence scores.

---

## Recommended fix order — by real browser-opens eliminated (data-backed)

Counts are conservative; many issues overlap.

| Rank | Fix | Eliminates | Touches |
|---|---|---|---|
| 1 | **A2 + A3 (skill freshness + SSR-payload virtual endpoints)** | jup.ag class, priceline class, ~14 stale_skill + most resolve_miss tasks | A2, A3, B4 |
| 2 | **H1 (LinkedIn dedicated path)** | ~34 browser opens across 11 sessions — single biggest concentrated wound | C1, C3, H1 |
| 3 | **A4 (GraphQL POST)** | ~62 ads.x.com opens + 6 graphql_post failures + x.com home | A4, H2 |
| 4 | **H4 (Kuri / server stability)** | unknown but cited in multiple sessions; multiplier on every other fix | infra |
| 5 | **A1 + C2 (semantic param matching)** | reddit class, priceline class, "wrong endpoint" family | A1, C2, H7 |
| 6 | **H3 (start-session verb) + F4/G1 (telemetry)** | reframes 45 DIRECT_BROWSER tasks; unblocks measuring everything else | H3, F4, G1 |
| 7 | **H6 (resolve-loop short-circuit)** | 27 redundant resolves; cheap | F3, H6 |
| 8 | **A6 (confidence) + F2 (actionable errors)** | borderline cases; agent decision quality | A6, F2 |
| 9 | **C4 (failure-reason enum)** | reduces "give up" cases (25 today) | C4 |
| 10 | Rest of B/C/D/E/F | long tail | — |

## Open instrumentation ask

The 447-session pass worked — but only because the analyzer agent regex'd across multiple tool-name shapes. For ongoing measurement we need **G1 (canonical task event)** + **H3 (start-session verb)** so:
- "browser open per task" is a single boolean field
- intentional interactive sessions don't pollute resolve-miss numbers
- per-release dashboards become trivial

Without that, every future analysis will keep being a one-off forensic exercise.

## Reference artifacts

- Full session report: `/tmp/unbrowse-session-analysis.md`
- Analyzer script: `/tmp/analyze_unbrowse.py`
