# Gate-bug fix waves (cited from .bench-gate/20260519T203955Z)

## Source of truth (do not paraphrase from memory)

- `.bench-gate/20260519T203955Z/verdict.json` — 66 schema-validated per-probe verdicts (in-thread agent judgment, no heuristic).
- `.bench-gate/20260519T203955Z/gate.json` — reused comparator output: passed=false, index_coverage 66.7% (30/45), retrieve_coverage 38.6% (17/44), 3 anchor failures.
- Per-probe artifact dirs `<probe_id>/{capture.meta.json, capture.html.excerpt, index.store.json, resolve.shortlist.json, resolve.pick.json, execute.input.json, execute.response.raw, execute.meta.json}`.

Read the artifact before writing the fix; the rubric is `harness/probes/GATE_JUDGE.md`.

## Floors to clear

| Check | Floor | Current | Gap |
|---|---|---|---|
| index_coverage | 80% | 66.7% (30/45) | +13.3pp = need +6 INDEX_PASS flips OR -7 from indexable denom |
| retrieve_coverage | 65% | 38.6% (17/44) | +26.4pp = need +12 RETRIEVE_PASS flips OR -19 from retrievable denom |
| anchor lane | must pass | 002, 010, 011 failing | all 3 must flip |

## Waves (impact-ranked; one scoped `/unbrowse-improvement-loop` PR per wave)

### W1 — schema_drift refusal of real bodies (HIGHEST impact)
**Hypothesis:** the drift detector emits a 200-wrapped `schema_drift_recapture_required` envelope INSTEAD of returning the body even when the body is real data — masking working capture as a retrieve failure.

**Affected probes (RETRIEVE_FAIL_ERROR_BODY where execute.response.raw shows real fields removed):**
- `016_semantic-rank_stackoverflow_q_231767` — removed=[items[].question_id, title, body, link, tags, answer_count]; real SO API returned a quota-only shape.
- `020_graphql_x.com_search` — execute body is stale_endpoint 401 (different sub-class; see W6 overlap).
- `021_graphql_x.com_elonmusk` — same stale_endpoint 401.
- `043_auth-gated_x.com_home` — schema_drift removed=620 fields; drift summary lists real `home_timeline_urt` tweet fields (cookies reached).
- `047_auth-cookies_youtube_subscriptions` — schema_drift removed=[link,url,title]; cookies present (3 injected), real-bug pattern.
- `049_auth-cookies_x.com_home` — schema_drift removed=620; same as 043.
- `057_hostile_southwest` — schema_drift removed=4 fields.
- `039_auth-gated_notion` — schema_drift with re_capture_signal handoff (different sub-class; correctly EXCLUDED_AUTH).

**Fix surface:** wherever the drift classifier short-circuits (likely `src/transform/drift-classifier.ts` + the executor's drift gate in `src/execution/index.ts`). The fix is to RETURN THE BODY when drift is detected but the body still carries usable data fields, and surface drift as a side-channel signal (`re_capture_signal`) rather than a 200-with-error-envelope.

**Expected coverage delta:** +5 to +6 RETRIEVE_PASS (016, 047, 057, maybe 020/021 if those are drift-not-401), +0 to +2 INDEX (some currently INDEX_PASS already). Should clear retrieve floor toward 65%.

### W2 — capture_did_not_emit_skill_id on cold-fetch / go_failed (anchor-lane critical)
**Hypothesis:** the cold browse/fetch path errors do not produce a usable skill artifact even when partial signal exists; the resolver then falls back to stale or null endpoints.

**Affected probes (INDEX_FAIL_NO_ENDPOINTS where lane is not hostile/auth-gated):**
- `002_anchor_npm_openai` — `go_failed`; capture.meta total_endpoints_captured=0 mode=none (release-blocker).
- `013_semantic-rank_reddit_r_programming` — no skill emitted.
- `014_semantic-rank_github_anthropic-sdk-python` — no skill emitted.
- `015_semantic-rank_github_vercel_next.js` — no skill emitted.
- `026_ssr-list_amazon_s_usb-c` — no skill, html_excerpt {} (navigation never landed).
- `029_ssr-list_beatsaver_q_camellia` — no skill.
- `033_ssr-list_openlibrary_search_dune` — no skill (resolve only worked from stale prior runs).
- `064_hostile_google_maps_search` — no skill (redirected to accounts.google.com).

**Fix surface:** `src/capture/index.ts` (capture pipeline emitSkillFromCapture) + `src/api/browse-session.ts` (go failure paths). When capture has ANY signal (html, even partial; cookies; a URL we landed on), emit a minimal page-artifact skill rather than nothing.

**Expected coverage delta:** +5 to +7 INDEX_PASS (002, 013-015, 026, 029, 033, 064 candidates). Likely clears anchor lane (002) and most of the index floor gap.

### W3 — wrong-shape page-shell extraction (DOM extractor priority)
**Hypothesis:** the DOM extractor scores nav/breadcrumb/translations/SPA-bootstrap nodes above real data nodes, so retrieve returns page chrome instead of the data.

**Affected probes (RETRIEVE_FAIL_WRONG_SHAPE):**
- `011_anchor_dev_to_anthropic` — signup CTA + profile chrome instead of posts.
- `018_semantic-rank_openlibrary_works_OL45804W` — sidebar publisher/language chips, no work content.
- `019_semantic-rank_openlibrary_works_OL27448W` — same as 018.
- `031_ssr-list_priceline_relax_at_tokyo` — schema.org Organization/TravelAgency JSON-LD (Priceline itself), no Tokyo hotels.
- `052_hostile_ticketmaster_concert` — `globalTranslations.global.a11y.*` and `theme.gradients.mrBlueSky`, no events.
- `057_hostile_southwest_flight-schedules` — homepage marketing tiles ('Manage my flight'), no flight data (overlaps W1).
- `059_hostile_target_searchTerm_coffee` — `spa-nextjs` preload struct + schema.org BreadcrumbList only, no products.
- `066_hostile_vinted_jeans` — Next.js RSC bootstrap stub (stylesheet/script chunks only), no listings.

**Fix surface:** `src/capture/index.ts` extractor scoring + the page-artifact dom_extraction ranker. Demote nodes whose values are i18n/breadcrumb/theme/spa-bootstrap shapes; require a minimum data-content fingerprint (e.g. ≥3 entries with non-config keys for list intents).

**Expected coverage delta:** +5 to +8 RETRIEVE_PASS.

### W4 — wrong endpoint pick (ranker)
**Hypothesis:** ranker put a user-details endpoint above the captured tags-DOM endpoint on hub.docker.com (intent: get nginx tags).

**Affected probes:**
- `010_anchor_hub_docker_com_library_nginx_tags` — resolve.pick = `Returns user details` (401) instead of the tags DOM endpoint.

**Fix surface:** `src/ranking/index.ts` + the server route `backend/src/routes/search.ts`. Intent-vs-endpoint keyword overlap should heavily prefer endpoints whose URL matches `tags` over `user`.

**Expected delta:** +1 RETRIEVE_PASS (010), unblocks one of the 3 anchor lane failures.

### W5 — auth-gated crash-not-handoff
**Hypothesis:** on x.com/home (auth-gated, no cookies, capture 0 endpoints), resolve returns 29 marketplace ops + executes a stale endpoint → schema_drift error envelope, instead of returning `resolve_hard_handoff` like 036/037/039/040 do.

**Affected probes:**
- `043_auth-gated_x.com_home` — should mirror 036/037/039/040 path (resolve_hard_handoff with concrete commands).

**Fix surface:** `src/orchestrator/index.ts` (the resolve_hard_handoff decision when capture stored=false AND lane=auth-gated AND only marketplace ops are available).

**Expected delta:** +1 INDEX_EXCLUDED_AUTH + +1 RETRIEVE_EXCLUDED_AUTH (043 moves OUT of failing into excluded) → improves both coverages.

### W6 — cold-fetch hits Akamai despite good capture
**Hypothesis:** for hosts known to bot-wall server_fetch (Akamai/Cloudflare/DataDome detected once), execute should prefer the captured DOM page-artifact over re-trying server_fetch.

**Affected probes:**
- `032_ssr-list_ebay_keyboard` — capture indexed real listings via Kuri (sample 'Keyboards & Keypads') but execute server_fetch returned 'Pardon Our Interruption…' Akamai wall.

**Fix surface:** `src/execution/index.ts` — when host had a `browser_block_signals: vendor:*` at capture, route execute through the DOM page-artifact replay instead of server_fetch.

**Expected delta:** +1 RETRIEVE_PASS (032).

### W7 — auth-cookies real-bug (overlaps W1)
**Already covered by W1 fix:** 047 youtube subs has cookies but drift envelope. Verify W1 fix unblocks 047.

## Loop driver

1. Pick the next un-fixed wave with the highest expected delta (start W1).
2. Invoke `/unbrowse-improvement-loop` to produce ONE scoped commit + PR on a `fix/<wave>` branch (NEVER direct main; bug-fix protocol = write failing test first).
3. Merge the PR (user's review call).
4. Re-run `/unbrowse-mcp-gate` end-to-end; the new run dir's `gate.json` + `verdict.json` get diffed against the prior in `scripts/verify.sh` → `logs/wave-delta.txt`.
5. Agent judges the delta in-thread; if `gate.json.passed=true`, `.bench-gate/stamp.mcp.json` writes and the loop EXITS.
6. Otherwise the agent picks the next-highest-delta remaining wave and goes again.

No script declares convergence; the comparator's `gate.json.passed` is the only exit signal.
