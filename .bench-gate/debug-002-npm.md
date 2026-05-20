# MCP-gate #002 npm probe — live trace

Run: 2026-05-18 / branch `jl/unbrowse-flex-settlement-w1`
Probe: `intent="get package info" url=https://www.npmjs.com/package/openai`
MCP server: local in-process (Phase 0d).

The interesting finding is up front: the **session is bound to a different
host's tab between go and snap**. `eval` returns live npmjs HTML at the
right size; `snap` on the same `session_id` reports
`current_url: https://arxiv.org/abs/2604.00694`. The close therefore
indexes against the wrong host (`auth_saved: "arxiv.org"`), and the
npmjs marketplace skill that does already exist is contaminated with
arxiv/alphaxiv DOM extractions. That is the root failure mode behind
`FAIL_INDEX_NO_ENDPOINTS` on this probe.

## Go response — exact JSON

```json
{
  "ok": true,
  "session_id": "d25be9fc-8873-4629-bc64-2d973a92bf0e",
  "url": "https://www.npmjs.com/package/openai",
  "tab_id": "22DA3F666A9CAF85742480A5F63E77B6",
  "auth_profile": "npmjs.com",
  "cookies_injected": 5,
  "page": {
    "text": "skip to:contentpackage searchsign in\nPro\nTeams\nPricing\nDocumentation\nnpm\nSearch\nSign Up\nSign In\nopenai\n6.38.0 • Public • Published 2 days ago\n Readme\nCode Beta\n0 Dependencies\n10721 Dependents\n358 Versions\nOpenAI TypeScript and JavaScript API Library\n\n  \n\nThis library provides convenient access to the OpenAI REST API from TypeScript or JavaScript.\n\nIt is generated from our OpenAPI specification with Stainless.\n\nTo learn how to use the OpenAI API, check out our API Reference and Documentation.\n\nIn...[truncated 22659 chars]",
    "structured_data": null
  },
  "autonomy": {
    "har_active": true,
    "streaming_publish_active": true,
    "attached_existing_chrome": false,
    "chrome_debug_url": "http://127.0.0.1:9222",
    "inspect_command": "unbrowse inspect --session d25be9fc-8873-4629-bc64-2d973a92bf0e --pretty",
    "inspect_buffer": "GET http://127.0.0.1:6969/v1/browse/sessions/d25be9fc-8873-4629-bc64-2d973a92bf0e/buffer",
    "marketplace_publish_enabled": true,
    "marketplace_publish_mode": "auto",
    "marketplace_publish_reason": "Background publish is allowed for this checkpoint."
  }
}
```

Observations:

- `auth_profile: "npmjs.com"`, 5 cookies injected — go DID bind to the
  intended host at open time.
- `page.text` is the **real npmjs.com/package/openai** content
  (`"openai\n6.38.0 • Public • Published 2 days ago"`, "10721 Dependents",
  "OpenAI TypeScript and JavaScript API Library"). So the
  go-returns-content path is working at this step.
- `tab_id: 22DA3F66...` is the npm tab.

## Live outerHTML (first 500 chars + total length)

`unbrowse_eval { script: "document.documentElement.outerHTML.slice(0,500)" }`
against `session_id=d25be9fc-...`:

```
<html lang="en" data-theme-setting="light" data-color-mode="light"><head>
    <meta charset="utf-8">
    <script>
      (function(){try{var d=document.documentElement,s=localStorage.getItem('npm-color-mode')||'light';d.setAttribute('data-theme-setting',s);if(s==='dark'){d.setAttribute('data-color-mode','dark')}else if(s==='system'){var q=window.matchMedia('(prefers-color-scheme: dark)');d.setAttribute('data-color-mode',q.matches?'dark':'light');q.addEventListener('change',function(e){if((localSt
```

- `data-theme-setting="light"` + `data-color-mode="light"` + the
  `localStorage.getItem('npm-color-mode')` bootstrap inline script
  is npmjs.com's exact theme-init script. Confirms eval is hitting
  the npm tab.
- `tab_id` echoed in the eval response: `22DA3F666A9CAF85742480A5F63E77B6`
  (matches the go tab).
- Length: **247,790 bytes** of live HTML. Plenty for `extractFromDOM`
  to find an ItemList / heading tree.

So the assumption stated in the task is verified: server-fetched (or in
this case, eval-fetched) HTML is real, large, and the npmjs.com page.
`extractFromDOM` on this body would extract at high confidence.

## Snap result

`unbrowse_snap { session_id: d25be9fc-..., detail_level: "summary" }`:

```json
{
  "detail_level": "summary",
  "root_aria": "",
  "current_url": "https://arxiv.org/abs/2604.00694",
  "page_title": "",
  "interactive_count": 0,
  "landmark_count": 0,
  "landmarks": [],
  "session_id": "d25be9fc-8873-4629-bc64-2d973a92bf0e",
  "tab_id": "22DA3F666A9CAF85742480A5F63E77B6",
  "warning": "empty_snapshot",
  "next_step": "Snapshot was empty for https://arxiv.org/abs/2604.00694. ..."
}
```

This is the smoking gun:

- Same `session_id` as go (`d25be9fc-...`).
- Same `tab_id` as go (`22DA3F666A...`).
- But `current_url: https://arxiv.org/abs/2604.00694` — **not** the npm
  URL the same session/tab just rendered, and not where `eval` is
  finding npm DOM.
- `page_title: ""`, `landmark_count: 0`, `interactive_count: 0` —
  empty_snapshot.

So `eval` and `snap` disagree about which page the tab is on, while
agreeing on `tab_id`. `snap` is reading from a stale or wrong source of
truth for the session's current URL. Two plausible mechanisms (one is
enough to cause #002):

1. The snap path resolves `current_url` from cached
   session/broker state that was last-written by a previous probe (#001
   arxiv) and is not refreshed after a subsequent `go`. Tab-id is fresh
   but the URL field is shared/lagging.
2. Snap is being routed to a different broker/CDP target than `eval` —
   the broker for this session resolved to the previous tab that loaded
   arxiv. (`page` arrived in go because go does its own
   in-process render and returns inline, bypassing the broker that snap
   uses.)

Either way: snap collapses to empty, the indexer downstream of close
has no live a11y/structure to capture, and the only thing the pipeline
sees is "we're on arxiv".

## Close response — exact JSON

```json
{
  "ok": true,
  "checkpointed": true,
  "session_id": "d25be9fc-8873-4629-bc64-2d973a92bf0e",
  "indexed": true,
  "mode": "dom",
  "endpoint_count": 1,
  "request_count": 0,
  "pipeline": { "index_queued": true, "publish_queued": true },
  "publish_policy": {
    "mode": "auto",
    "reason": "Background publish is allowed for this checkpoint."
  },
  "background_publish_queued": true,
  "auth_saved": "arxiv.org"
}
```

The damning fields:

- `indexed: true`, `mode: "dom"`, `endpoint_count: 1` — exactly **one**
  DOM-only synthetic endpoint was produced. Not zero (so technically
  not `FAIL_INDEX_NO_ENDPOINTS` for *this* session locally), but the
  endpoint is being merged into the wrong domain skill — see resolve
  below.
- `request_count: 0` — HAR/XHR capture saw zero requests for this
  session. A real npmjs page load fires 100+ requests (chunks,
  sponsored-package XHRs, telemetry). Zero means the session's broker
  was not the one rendering npmjs; the npmjs render that produced
  `page.text` and the eval HTML happened on a different code path
  (the in-process go-returns-content render) and its requests were
  not attributed back to this session for indexing.
- **`auth_saved: "arxiv.org"`** — the close pipeline asked the session
  what host it was on, got `arxiv.org` (matches snap's `current_url`),
  and saved the auth profile under arxiv. So the host-derivation inside
  close uses the same wrong source of truth that snap reports, NOT the
  URL the go call was given.

## Post-close resolve

`unbrowse_resolve { intent: "get package info", url: "https://www.npmjs.com/package/openai" }`:

```json
{
  "skill_id": "Jwu0EMSbTbt50lCazs9a0",
  "available_endpoints": [
    {
      "endpoint_id": "dXwhXeZbrXHMvpvWWDxMX",
      "url": "https://www.npmjs.com/package/openai",
      "score": 717.4,
      "dom_extraction": true,
      "trigger_url": "https://www.npmjs.com/package/openai",
      "description": "Page content from www.npmjs.com",
      "sample_values": {
        "[].type": "repeated-elements",
        "[].data[].title": "Code, Data and Media Associated with this Article",
        "[].data[].link": "https://alphaxiv.org/",
        "[].data[].url": "https://alphaxiv.org/",
        "[].relevance_score": 25.4
      },
      "confidence": 1
    },
    { "url": "https://www.npmjs.com/package/typescript", "score": 92.2, "confidence": 0, "...": "..." },
    { "url": "https://www.npmjs.com/{id}/{slug}/v/6.37.0/provenance", "score": -752.2, "confidence": 0 },
    { "url": "https://www.npmjs.com/{id}/{slug}/v/6.38.0/provenance", "score": -752.2, "confidence": 0 }
  ],
  "source": "marketplace",
  "diagnostic": {
    "confidence": 0,
    "top_reasoning": "Best match: Page content from www.npmjs.com (score: 717.4458443496043)",
    "endpoint_count": 4,
    "cache_source": "marketplace"
  }
}
```

So a skill exists for `npmjs.com`, four endpoints, and the top one
even has the right `url_template`. But the **sample_values** for that
top endpoint are arxiv/alphaxiv content:

- `"[].data[].title": "Code, Data and Media Associated with this Article"`
- `"[].data[].link": "https://alphaxiv.org/"`
- `"[].data[].url": "https://alphaxiv.org/"`

That string is arxiv's "Code, Data and Media" sidebar. So the
`dXwhXeZbrXHMvpvWWDxMX` endpoint under the npmjs.com skill was last
written by an arxiv close — exactly what `auth_saved: "arxiv.org"`
above implies. The npmjs skill is poisoned with arxiv DOM.

Decision_trace shows resolve picked marketplace and didn't probe live
(`budget_race.winner = "marketplace"`, `tried[marketplace].status = "won"`).
So in the gate path that calls `resolve` AFTER `close`, the gate sees a
top endpoint whose sample_values match arxiv content, not openai-package
content, and the agent judge correctly fails the probe.

## Diagnosis

The MCP-gate #002 failure is **session-to-tab binding corruption
between go and snap/close, NOT an extractor regression**.

Evidence chain:

1. `go` opens npmjs.com/package/openai. The in-process render path
   returns real `page.text` (npmjs content) and a valid `session_id` +
   `tab_id`. (`Go response` section.)
2. `eval` against that `session_id` returns real npmjs HTML
   (247KB, npm's theme-init script). (`Live outerHTML`.)
3. `snap` against the SAME `session_id` + SAME `tab_id` reports
   `current_url: https://arxiv.org/abs/2604.00694` and empty everything.
   (`Snap result`.) eval and snap can't both be right; they're reading
   the session's URL from different sources, and snap's source is
   stale/wrong.
4. `close` reads the same wrong source: `auth_saved: "arxiv.org"`,
   `endpoint_count: 1` (a synthetic DOM endpoint), `request_count: 0`
   (no HAR attribution to this session). (`Close response`.)
5. Because the close pipeline thinks the host is arxiv, the DOM
   extraction it ran goes against arxiv DOM (or against whatever the
   broker's stale tab still had loaded), and the produced endpoint gets
   merged into … the npmjs.com skill (because go's intent-host was
   npmjs.com? or because the merge keys off `url_template` derived from
   the original `go` URL while body content comes from the wrong tab —
   either way, the host-of-record and the body-of-record disagree).
6. Resolve then ranks that contaminated endpoint top
   (score 717.4, confidence 1) and the gate judges
   `FAIL_INDEX_NO_ENDPOINTS` (or equivalent "no real npm endpoints")
   because the only "npm" endpoint has arxiv sample_values.

Where to look in code (ordered by likelihood):

- **Tab/session URL resolution in the snap path** — probably
  `src/browser/snap.ts` or wherever `getCurrentUrl` is called when
  building the snap response. If it reads from a cached
  `session.currentUrl` that's only updated on cross-broker navigation,
  it will lag behind in-process `go` renders. Compare with how
  `eval` resolves its target tab (which is correct).
- **Close pipeline's host derivation** — wherever
  `auth_saved`/`publish_host` is derived. It should match the URL the
  `go` call was given for this session, not whatever the broker thinks
  `current_url` is. `kuri.getCurrentUrl` per the project notes can
  return `[object Object]` when CDP shape shifts; if the validator
  silently falls back to a previous tab's URL when the response is
  unparseable, that explains the lag.
- **Cross-session contamination in the local broker** — concurrent
  `go` calls on the same broker can rebind tabs (the parallel
  isolation rule in CLAUDE.md). #001 was arxiv, #002 is npm. If the
  gate ran them serially against a single broker and the per-broker
  tab pool reused the arxiv tab for npm, the URL field would lag until
  the tab actually navigated. Note `attached_existing_chrome: false`
  and a 9222 debug URL — single broker is in play.
- **HAR/request attribution** — `request_count: 0` says zero requests
  were attributed to this session even though eval saw a fully-rendered
  page. The HAR collector is tied to the wrong target.

Quick falsifiable next checks (for whoever picks this up):

- Re-run #002 in isolation (no prior #001) and see whether
  `auth_saved: "npmjs.com"`, `request_count > 0`, and snap's
  `current_url` matches go's URL. If yes, this is per-broker
  cross-session leak and matches the known `createBrowseSession` race
  pattern (commit `41fab174` in CLAUDE.md, parallel isolation note).
- Re-run #002 with snap *before* eval. If snap's `current_url` is still
  arxiv, the lag is in the URL cache itself, not in any later step.
- Confirm `kuri.getCurrentUrl` for this session returns a parseable
  http URL. The guard at `src/kuri/client.ts` (per CLAUDE.md) is
  supposed to reject `[object Object]` — if it's accepting a stale
  string instead, that's the bug.

The directly-extracts-at-0.8 fact stated in the prompt is consistent
with this diagnosis: when extractFromDOM gets real npm HTML, it works.
The MCP loop never gives the extractor the real npm HTML at the
indexing step because the session's URL/tab handoff has already been
corrupted by step 3 of the workflow.
