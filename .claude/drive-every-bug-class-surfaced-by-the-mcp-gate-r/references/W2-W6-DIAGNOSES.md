# W2-W6 diagnoses (post-W1, 2026-05-20)

W1 shipped: https://github.com/unbrowse-ai/unbrowse-dev/pull/536

Each remaining wave was scoped to "small surgical fix" by GATE-BUGS-PRIORITIZED.md
but in-thread reading of artifacts + source revealed substantive design calls per wave.
This file captures the diagnosis so the next loop session can ship them correctly
without rediscovering.

## W6 — vendor-blocked → prefer DOM artifact (probe 032 ebay)

### Artifact evidence
- `032/capture.meta.json`: `total_endpoints_captured=3`, `mode="dom"`, `indexed=true`,
  `browser_block_signals=[]` (no vendor signal at capture time — the wall only fires
  on re-fetch from the executor's network identity, not Kuri's).
- `032/resolve.pick.json`: chose endpoint `ji2nC0SMBYzBB6XAhv7Yp`, URL
  `https://www.ebay.com/sch/i.html?_nkw={nkw}`, score=239.6, schema_summary
  `[]: {link, url, title}` — the DOM page-artifact. Ranker was CORRECT.
- `032/execute.meta.json`: probe→200 + html 13628B → `decision: strategy=server,
  reason="renderedness unverified from range probe, server-fetch first (drift or
  empty falls through to re-capture)"`. server_fetch → 200, 99 bytes.
- `032/execute.response.raw`: `{"title":"Pardon Our Interruption...","headings":
  ["Checking your browser before you access eBay."]}` — Akamai wall.

### Code site
`src/execution/probe.ts:170 decideFromProbe`:
- L232 `if (isHtml && bodyLarge)` returns `strategy="server"` BEFORE
- L253 `if (isHtml && has_dom_extraction)` (also returns "server" but with different reason).
  The order means `bodyLarge` always wins. Both paths funnel to `serverFetch` in
  `src/execution/index.ts:3354`.

The comment at probe.ts:240-242 promises "drift / empty-result path emits a
re_capture_signal that routes to the browser" — but for 032 the body was 99 bytes
of title+headings (extractor ran on the wall HTML), which is neither empty nor
schema-drifted enough to trigger the recapture branch. So no fallback.

### Fix surfaces (need to pick one)

**Option A — reorder probe rules**: DOM-extraction endpoints route to
`trigger-intercept` (uses live browser tab) instead of server_fetch when there is
a `trigger_url`. Safe because trigger-intercept is the path that captured the
DOM-artifact in the first place. Risk: doubles browser usage; CLAUDE.md "browser
open is failure mode" rule.

**Option B — vendor-block detection on server_fetch result**: detect known anti-bot
markers in the body (Akamai "Pardon Our Interruption", Cloudflare "Just a moment",
PerimeterX, DataDome, Imperva) — if found AND endpoint has dom_extraction, route
to the browser path with a re_capture_signal `next_action`. There's already
vendor-marker code somewhere (`classifyExecuteFailure` per CLAUDE.md). Hook into it.

**Option C — host-block memory**: persist `vendor_blocked` signal across runs
(KV/disk) keyed by host. On execute, if host has prior block, skip server_fetch
entirely. Most generalizable; biggest blast radius.

### Recommended: Option B
Smallest blast radius; reuses existing classifier; surfaces honest signal in the
trace. Failing test reproduces with a stub fetch returning the Akamai wall body.

### Tests
- `tests/execution-vendor-block-dom-fallback.test.ts` (new): real-runtime,
  network-boundary stub. Endpoint has `dom_extraction: true`, server_fetch returns
  Akamai wall HTML, assert decision_trace contains `vendor_blocked` step and
  `re_capture_signal` is set.

### Expected delta
+1 RETRIEVE_PASS on 032; may also flip 057 (southwest homepage, similar pattern).

---

## W5 — auth-gated resolve_hard_handoff (probe 043)

### Evidence
- 043 (x.com/home, auth-gated): capture stored=false, resolve returned 29
  marketplace ops + executed a stale endpoint → schema_drift envelope.
- 036/037/039/040 (other auth-gated probes): correctly returned
  `resolve_hard_handoff` with concrete `suggested_commands`.

### Diagnosis approach
Compare orchestrator output for 036 vs 043. Find the condition that fires for 036
but not 043 (it may be a host-specific condition, a marketplace-ops count
threshold, or a capture-state predicate).

### Fix surface
`src/orchestrator/index.ts` — the `resolve_hard_handoff` decision branch.
Likely a missing `lane === "auth-gated"` check or wrong precedence vs
"marketplace-has-ops" branch.

### Expected delta
+1 INDEX_EXCLUDED_AUTH + +1 RETRIEVE_EXCLUDED_AUTH (moves 043 OUT of failing into
excluded), which raises both coverage percentages by reducing the denominator.

---

## W4 — wrong endpoint pick (probe 010 hub.docker.com nginx tags)

### Evidence
- Intent: "dockerhub image tags"
- Captured tags-DOM endpoint `BVRZcyG0RSW3m_cAVvvWV` URL
  `hub.docker.com/_/nginx/tags`, description "Returns resource details with
  relevance score, digest, and os/arch", scored **-23.1** (negative!).
- Picked endpoint `gfDXz2mkCyDPL6NxWh-4N` URL `hub.docker.com/v2/user/`,
  description "Returns user details", scored 22.7.
- Higher-scoring endpoints existed but were filtered: graphql endpoint
  `2dDqJBfd8VsJ4nB8BPB0J` scored 36.6 was apparently demoted by mutation-verb
  rule (existing CHANGELOG entry).

### Diagnosis
The captured DOM page-artifact got hit by `PAGE_ARTIFACT_DEMOTION` (corpus has
multiple API-shaped URLs: api.scout.docker.com, /v2/user/, /api/scan/...) which
docs CLAUDE.md describes. The LIST_INTENT promotion at confidence>=0.8 was
supposed to override but didn't fire. Could be:
- `intent_signature` didn't contain a LIST_INTENT keyword token
- `dom_extraction.confidence` < 0.8
- response_schema not array/object as expected

### Fix surface
`src/execution/index.ts:rankEndpoints` (or `backend/src/services/rank.ts` since
WAVE 2 server-move). Check the LIST_INTENT promotion condition + the
PAGE_ARTIFACT_DEMOTION. Likely a keyword-list miss ("tags" isn't a list-intent
verb but "image tags" is plural-noun-form list).

### Recommended approach
- Run `unbrowse rank --intent "dockerhub image tags" --url <captured-skill-url>`
  primitive to see per-signal evidence in real time.
- Identify which condition failed, patch the *generic* condition (not a
  per-domain rule per ranker-philosophy section in CLAUDE.md).

### Tests
- `tests/rank-list-intent-page-artifact.test.ts` (new): captured skill with a
  DOM page-artifact endpoint + competing API-shaped endpoints in corpus +
  intent "dockerhub image tags" (or generalized "list image tags") asserts
  page-artifact ranks #1.

### Expected delta
+1 RETRIEVE_PASS on 010 (anchor probe unblocked).

---

## W2 — capture_did_not_emit_skill_id on cold-fetch

### Evidence + diagnosis
Probe 002 (npm/openai): zero signal at all. No URL, no html, no requests, no
cookies. Browse never landed.

W2's hypothesis ("emit minimal skill when ANY signal exists") wouldn't help 002.
The actual fix needs different go-strategy or a server-side cold-fetch fallback
when Kuri's browse session fails to land.

### Recommended split
- **W2a**: cold-fetch fallback. When `unbrowse go` returns no URL after timeout,
  fire a server-side libcurl-impersonate fetch of the target URL, run extraction
  on the rendered HTML, emit a minimal skill. Salvages 002, 013-015, 026, 029,
  033 candidates.
- **W2b**: emit-on-partial-signal. The original spec — when there IS html or
  cookies or a URL, emit minimal. Only useful for the residual subset.

### Tests
- `tests/capture-cold-fetch-fallback.test.ts`: stub Kuri to fail/timeout, assert
  capture pipeline does the libcurl fallback and emits a skill_id.

### Expected delta
+5 to +7 INDEX_PASS (002, 013-015, 026, 029, 033, 064 candidates). Clears anchor
lane 002 and most of the index floor gap.

---

## W3 — wrong-shape page-shell extraction

Heaviest of all. 8 affected probes (011, 018, 019, 031, 052, 057, 059, 066).
Needs a DOM-extractor scoring redesign to demote i18n/breadcrumb/theme/spa-
bootstrap shapes. Recommended deferred until W1+W4+W5+W6 + W2a delta is measured;
the bench-gate re-run may flip some of these via knock-on effects.

---

## W7
Subset of W1; verified by re-running gate post W1 merge.

---

## Loop driver recommendation

Sequence by impact + bounded scope:
1. **W1** (done — PR #536)
2. **W5** (orchestrator, 1-condition patch, smallest surface) — next
3. **W6** (Option B above, vendor-block detection wired into existing classifier) — next-next
4. **W4** (ranker, after rank primitive run reveals which condition failed)
5. **W2a** (cold-fetch fallback; needs design call: libcurl wrapper integration)
6. **W3** (extractor scoring; bigger redesign, may benefit from gate re-run first)
