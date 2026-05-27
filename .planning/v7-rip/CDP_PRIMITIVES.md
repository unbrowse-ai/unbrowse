# CDP primitives spec (v7)

Atomic rip of `src/kuri/client.ts` (2182 LOC, ~60 methods over an HTTP broker)
in favor of raw Chrome DevTools Protocol primitives organized in the covenant
three-verb shape: **build** (declare pattern), **breath** (animate runtime),
**eval** (observe / witness). Each primitive maps 1:1 to a CDP domain method
— no Page-class abstraction, no broker layer, no Zig binary.

> *"walk through the fractal DAG of the website on different layers of tree
> ASTs, whether its the network request chain, the DOM, or the UI clicking
> via browser via CDP — always point to the root of the problem to solve it"*

The three planes ARE the three ASTs. Every plane has the same three verbs.

---

## Three planes (the fractal-DAG layers)

### L-network primitives — the request-chain AST

Cookies, headers, intercept patterns, request lifecycle events. The wire.

| Kind name | Verb | CDP method | Required params | Receipt body | Used in real flow |
|---|---|---|---|---|---|
| `net_domain_enable` | build | `Network.enable` | `cdp, sessionId, maxResourceBufferSize?` | `{enabled:true, sessionId}` | First call after target attach; arms request lifecycle events for HAR. |
| `net_set_extra_headers` | build | `Network.setExtraHTTPHeaders` | `cdp, sessionId, headers{}` | `{header_keys[], sha_of_values}` | Spoof + auth header replay declared once per session. |
| `net_set_user_agent` | build | `Network.setUserAgentOverride` | `cdp, sessionId, userAgent, acceptLanguage?, platform?, userAgentMetadata?` | `{ua, sec_ch_ua_hint_count}` | Spoof UA + sec-ch-ua-* client hints in one shot. |
| `net_set_cookies` | build | `Network.setCookies` | `cdp, cookies[{name,value,domain,path,secure,httpOnly,sameSite,expires}]` | `{count, domains[]}` | Cookie injection from Chrome/Firefox SQLite — replaces `setCookie`/`setCookies`. |
| `net_get_cookies` | eval | `Network.getCookies` | `cdp, urls?[]` | `{cookies[]}` (values redacted) | HAR enrichment + auth profile save. |
| `net_clear_cookies` | build | `Network.clearBrowserCookies` | `cdp` | `{cleared:true}` | Fresh-session isolation between parallel probes. |
| `net_set_cache_disabled` | build | `Network.setCacheDisabled` | `cdp, cacheDisabled:bool` | `{cacheDisabled}` | Force-fresh capture for HAR completeness. |
| `net_set_block_urls` | build | `Network.setBlockedURLs` | `cdp, patterns[]` | `{count}` | Drop telemetry/ads before they pollute HAR. |
| `net_get_response_body` | eval | `Network.getResponseBody` | `cdp, requestId` | `{body_sha256, base64Encoded, size}` (body to value-store, pointer in receipt) | HAR body extraction post-load. |
| `net_request_will_be_sent` | eval | event `Network.requestWillBeSent` | `(subscribe)` | `{requestId, url, method, headers, postData?, ts}` | HAR + extractEndpoints input — observation only. |
| `net_response_received` | eval | event `Network.responseReceived` | `(subscribe)` | `{requestId, url, status, mimeType, headers, ts}` | HAR enrichment; pairs with `net_get_response_body`. |
| `net_loading_finished` | eval | event `Network.loadingFinished` | `(subscribe)` | `{requestId, encodedDataLength}` | HAR completion gate per request. |
| `fetch_enable` | build | `Fetch.enable` | `cdp, sessionId, patterns[], handleAuthRequests?` | `{pattern_count}` | Arms interceptor (replaces `interceptStart`). |
| `fetch_request_paused` | eval | event `Fetch.requestPaused` | `(subscribe)` | `{requestId, request, resourceType, frameId, networkId?}` | Per-request decision point; agent or DAG decides continue/fulfill/fail. |
| `fetch_continue_request` | breath | `Fetch.continueRequest` | `cdp, requestId, url?, method?, postData?, headers?` | `{requestId, mutated:bool}` | Default pass-through; optionally rewrite the in-flight request. |
| `fetch_fulfill_request` | breath | `Fetch.fulfillRequest` | `cdp, requestId, responseCode, responseHeaders, body?` | `{requestId, served_from:'cache'\|'mock'}` | Replay-from-skill / mock cached responses inline. |
| `fetch_fail_request` | breath | `Fetch.failRequest` | `cdp, requestId, errorReason` | `{requestId, reason}` | Block telemetry surgically when `setBlockedURLs` patterns are too coarse. |
| `fetch_continue_with_auth` | breath | `Fetch.continueWithAuth` | `cdp, requestId, authChallengeResponse` | `{requestId, auth_provided:bool}` | Replaces `setCredentials`; satisfies 401 challenges with vault creds. |

### L-DOM primitives — the document AST

DOM tree, accessibility tree, evaluation, the rendered model.

| Kind name | Verb | CDP method | Required params | Receipt body | Used in real flow |
|---|---|---|---|---|---|
| `dom_get_document` | eval | `DOM.getDocument` | `cdp, depth?, pierce?` | `{rootNodeId, child_count, depth_explored}` | First DOM read per session; hands out nodeIds for subsequent queries. |
| `dom_query_selector` | eval | `DOM.querySelector` | `cdp, nodeId, selector` | `{nodeId?, found:bool}` | `getElementByRef` style single-element lookup. |
| `dom_query_selector_all` | eval | `DOM.querySelectorAll` | `cdp, nodeId, selector` | `{nodeIds[], count}` | Multi-element selection (replaces `domQuery(all:true)`). |
| `dom_get_outer_html` | eval | `DOM.getOuterHTML` | `cdp, nodeId\|backendNodeId\|objectId` | `{html_sha256, size_bytes}` (html → value-store) | Replaces `domHtml` + `getPageHtml`. |
| `dom_get_attributes` | eval | `DOM.getAttributes` | `cdp, nodeId` | `{attrs{}}` | `domAttributes` replacement. |
| `dom_describe_node` | eval | `DOM.describeNode` | `cdp, nodeId, depth?, pierce?` | `{node{}, frameId?, shadowRootType?}` | Iframe-piercing / shadow-DOM bridging. |
| `dom_get_box_model` | eval | `DOM.getBoxModel` | `cdp, nodeId` | `{content[], padding[], border[], margin[], width, height}` | Compute coords for `Input.dispatchMouseEvent` (click-by-ref pipeline). |
| `dom_scroll_into_view` | breath | `DOM.scrollIntoViewIfNeeded` | `cdp, nodeId` | `{nodeId}` | Replaces `scrollIntoView`. |
| `dom_focus` | breath | `DOM.focus` | `cdp, nodeId` | `{nodeId}` | Pre-input focus; deterministic versus relying on click coords. |
| `dom_set_attribute_value` | breath | `DOM.setAttributeValue` | `cdp, nodeId, name, value` | `{nodeId, name}` | Programmatic form-fill bypassing React controlled-input traps. |
| `a11y_get_full_tree` | eval | `Accessibility.getFullAXTree` | `cdp, max_depth?, frameId?` | `{tree_sha256, node_count, role_histogram}` (tree → value-store) | Replaces `snapshot(filter)` — the `[e0]` accessibility frame for click-by-ref. |
| `a11y_get_partial_tree` | eval | `Accessibility.getPartialAXTree` | `cdp, nodeId\|backendNodeId\|objectId` | `{tree_sha256, node_count}` | Scoped AX read after a UI mutation. |
| `runtime_enable` | build | `Runtime.enable` | `cdp, sessionId` | `{enabled:true}` | Arms `Runtime.consoleAPICalled` + `Runtime.exceptionThrown` for `getConsole`/`getErrors`. |
| `runtime_evaluate` | eval | `Runtime.evaluate` | `cdp, expression, awaitPromise?, returnByValue?, contextId?` | `{result, exceptionDetails?, type, value_sha256?}` | Replaces `evaluate`; `getMarkdown`/`getText`/`getLinks`/`findText`/`getCurrentUrl`/`getPerfLcp` all collapse to `runtime_evaluate` + a fixed JS expression. |
| `runtime_call_function_on` | eval | `Runtime.callFunctionOn` | `cdp, functionDeclaration, objectId?, arguments?` | `{result, type}` | Typed re-evaluation on a specific node objectId — safer than string-interpolated `runtime_evaluate`. |
| `page_navigate` | breath | `Page.navigate` | `cdp, url, referrer?, transitionType?, frameId?` | `{frameId, loaderId, errorText?}` | Replaces `navigate`. |
| `page_reload` | breath | `Page.reload` | `cdp, ignoreCache?, scriptToEvaluateOnLoad?` | `{frameId}` | Replaces `reload`. |
| `page_go_back` / `page_go_forward` | breath | `Page.navigateToHistoryEntry` | `cdp, entryId` | `{entryId}` | Replaces `goBack`/`goForward` (history walked via `Page.getNavigationHistory`). |
| `page_capture_screenshot` | eval | `Page.captureScreenshot` | `cdp, format?, quality?, clip?, captureBeyondViewport?` | `{image_sha256, format, bytes}` (image → value-store) | Replaces `screenshot`. |
| `page_print_to_pdf` | eval | `Page.printToPDF` | `cdp` | `{pdf_sha256}` | Future doc-extraction primitive (not in Kuri today, free upgrade). |
| `page_add_script_to_eval_on_new_doc` | build | `Page.addScriptToEvaluateOnNewDocument` | `cdp, source, worldName?, includeCommandLineAPI?` | `{identifier}` | Replaces `addInitScript` + `injectStealthScript` + `INTERCEPTOR_SCRIPT`. Runs before any page script — load-bearing for spoof. |
| `page_remove_script_to_eval_on_new_doc` | build | `Page.removeScriptToEvaluateOnNewDocument` | `cdp, identifier` | `{identifier}` | Per-session cleanup. |
| `page_set_lifecycle_events_enabled` | build | `Page.setLifecycleEventsEnabled` | `cdp, enabled` | `{enabled}` | Arms `Page.lifecycleEvent` for `waitForLoad`. |
| `page_lifecycle_event` | eval | event `Page.lifecycleEvent` | `(subscribe)` | `{name, frameId, ts}` | `waitForLoad` becomes "subscribe + filter for name='networkIdle'". |
| `emulation_set_user_agent_override` | build | `Emulation.setUserAgentOverride` | `cdp, userAgent, acceptLanguage?, platform?, userAgentMetadata?` | `{ua, hints}` | Spoof UA + sec-ch-ua. Use this OR `Network.setUserAgentOverride` — Emulation is the modern one. |
| `emulation_set_device_metrics_override` | build | `Emulation.setDeviceMetricsOverride` | `cdp, width, height, deviceScaleFactor, mobile` | `{w,h,dpr,mobile}` | Replaces `setViewport`; also flips mobile bit for sec-ch-ua-mobile. |
| `emulation_set_timezone_override` | build | `Emulation.setTimezoneOverride` | `cdp, timezoneId` | `{tz}` | Spoof timezone to match proxy geo. |
| `emulation_set_locale_override` | build | `Emulation.setLocaleOverride` | `cdp, locale` | `{locale}` | Match Accept-Language + navigator.language. |
| `emulation_set_geolocation_override` | build | `Emulation.setGeolocationOverride` | `cdp, latitude, longitude, accuracy` | `{lat,lng,acc}` | Match proxy geo. |

### L-input primitives — the interaction AST

Mouse, keyboard, touch. Coordinates come from `dom_get_box_model`.

| Kind name | Verb | CDP method | Required params | Receipt body | Used in real flow |
|---|---|---|---|---|---|
| `input_dispatch_mouse_event` | breath | `Input.dispatchMouseEvent` | `cdp, type:'mousePressed'\|'mouseReleased'\|'mouseMoved'\|'mouseWheel', x, y, button?, clickCount?, modifiers?` | `{type, x, y, button}` | Atomic mouse primitive; `click(ref)` = describe + box-model + press + release. |
| `input_dispatch_key_event` | breath | `Input.dispatchKeyEvent` | `cdp, type:'keyDown'\|'keyUp'\|'rawKeyDown'\|'char', key, code?, text?, modifiers?` | `{type, key, code}` | Replaces `keyDown`/`keyUp`/`press`; modifier-key handling honest. |
| `input_insert_text` | breath | `Input.insertText` | `cdp, text` | `{len}` | Paste-equivalent input; bypasses per-key React handlers (replaces `keyboardInsertText`). |
| `input_dispatch_touch_event` | breath | `Input.dispatchTouchEvent` | `cdp, type, touchPoints[]` | `{type, pt_count}` | Mobile-emulation taps when `deviceMetrics.mobile=true`. |
| `input_dispatch_drag_event` | breath | `Input.dispatchDragEvent` | `cdp, type, x, y, data` | `{type, x, y}` | Replaces `drag(source,target)` — DnD when needed. |
| `input_set_intercept_drags` | build | `Input.setInterceptDrags` | `cdp, enabled` | `{enabled}` | Arms `Input.dragIntercepted` for drag-with-payload flows. |

Composite flows (click-by-ref, fill, scroll, hover, check/uncheck) are NOT
primitives — they are recipes that compose `dom_query_selector` →
`dom_get_box_model` → `input_dispatch_mouse_event` (×2 for click) →
`input_dispatch_key_event` / `input_insert_text`. The 12 Kuri action types
collapse to a recipe layer above primitives.

---

## Chromium binary acquisition

**Recommendation: `@puppeteer/browsers install chrome` at postinstall.**

| Option | Tarball impact | Version pin | Anti-bot stability | Verdict |
|---|---|---|---|---|
| Bundle Chromium in npm | +150 MB tarball, painful per-platform builds | exact | best | rejected — npm publish size + Mac/Linux/Win matrix |
| `playwright install chromium` | postinstall pulls ~150 MB to `~/.cache/ms-playwright` | exact | drifts with Playwright releases | rejected — leans on Playwright we are ripping |
| `@puppeteer/browsers install chrome` | postinstall pulls Chrome to `~/.cache/puppeteer`; no Puppeteer runtime needed | exact, pin `Browser.CHROME` + a known revision | matches real Chrome (sec-ch-ua, GREASE) better than Chromium | **chosen** |

Rationale: real-Chrome user-agent + client-hint distribution is the
realistic fingerprint surface; Chromium leaks the `HeadlessChrome` UA
token unless explicitly overridden. `@puppeteer/browsers` is a ~50 KB
dependency that installs the binary and exits — no Page-class baggage.
Pin a revision in `package.json` and re-pin on each release; `version.json`
already exists for sync.

---

## CDP client choice

**Recommendation: `chrome-remote-interface` (raw WS, ~10 KB).**

| Option | Bundle | API surface | Verdict |
|---|---|---|---|
| Custom WS client | 0 deps, ~400 LOC of WS framing + message-id correlation | full control | rejected — re-implementing solved infra |
| `puppeteer-core` | ~3 MB | Page class re-introduces the abstraction layer we are ripping | rejected — Lewis explicit: no Playwright/Puppeteer wrapper |
| `chrome-remote-interface` | ~10 KB | thin: `Network.enable()`, `Network.requestWillBeSent(cb)`, `client.send(method, params)` | **chosen** — verb names ARE the CDP method names |

It exposes flat-session and target-attached forms; we use both
(`Target.attachToTarget` + flat `sessionId` for parallelism — see process
model).

---

## Process model (stateless + parallel)

**Single Chrome process per host; one CDP target (= tab) per session; flat
sessionId multiplexing.**

```
        chrome --headless=new --remote-debugging-port=0
        (one binary, one process, N targets)
                       │
       Target.createTarget()  ──►  targetId_A    (session A)
       Target.createTarget()  ──►  targetId_B    (session B)
       ...
       Target.attachToTarget({flatten:true}) ──► sessionId_*
```

- **Why one Chrome:** spawning N chromes (Kuri's current model — 1 Chrome
  per session, `KURI_SPAWN_CONCURRENCY=4`) was the failure mode behind
  the parallel-isolation falsifier. Chrome multi-target is the natively
  parallel surface.
- **Why flat sessionId multiplexing:** every CDP method call carries a
  `sessionId`. Sessions are isolated cookie jars (via `Target.createBrowserContext`
  if full isolation needed, or shared context if cookie-state is meant to
  be persistent across the host).
- **Stateless:** the CDP client handle (the WS connection) is passed as a
  param to every primitive. There is no module-level singleton holding
  "the current tab" — kindspecs take `{cdp, sessionId}` explicitly.
- **Lifecycle:**
  - `chromium_launch` (build, `child_process.spawn('chrome', flags)`) → returns `cdp` handle.
  - `chromium_new_context` (build, `Target.createBrowserContext`) → returns `browserContextId`.
  - `chromium_new_target` (build, `Target.createTarget(url, browserContextId)`) → returns `targetId` + `sessionId`.
  - `chromium_close_target` (breath, `Target.closeTarget`) → frees the tab.
  - `chromium_shutdown` (breath, `Browser.close` + SIGTERM) → tear down.
- **Parallel safety:** each primitive call is one CDP message with a
  message-id; `chrome-remote-interface` already correlates replies. No
  shared mutable state in the primitive layer.
- **Warm pool:** optional, opt-in. v7 ships with subprocess-per-session
  Chrome contexts (`Target.createBrowserContext` is ~10 ms, way under
  Kuri's 3 ms cold-start advantage but with no Zig dependency). If the
  parallel-isolation falsifier shows residual crosstalk under a shared
  browser, we fall back to one Chrome per session at a perf cost.

---

## Spoof surface (per-layer)

| Layer | What's spoofed | CDP method (or honest gap) |
|---|---|---|
| HTTP User-Agent | UA string | `Emulation.setUserAgentOverride` (preferred) or `Network.setUserAgentOverride` |
| HTTP sec-ch-ua-* client hints | UA-CH brand list, mobile bit, platform, architecture, model, full-version-list | `Emulation.setUserAgentOverride` with full `userAgentMetadata` object |
| HTTP arbitrary headers (Accept-Language, custom) | request headers | `Network.setExtraHTTPHeaders` |
| HTTP cookies | per-domain cookies | `Network.setCookies` |
| JS `navigator.userAgent` / `navigator.platform` / `navigator.language(s)` | window globals | `Emulation.setUserAgentOverride` (CDP syncs JS-side automatically) |
| JS `navigator.webdriver` | bot flag | `Page.addScriptToEvaluateOnNewDocument` with the standard delete-on-prototype shim |
| JS `navigator.plugins` / `navigator.mimeTypes` | bot flag | `Page.addScriptToEvaluateOnNewDocument` proxy shim |
| JS `chrome.runtime` presence | bot flag | `Page.addScriptToEvaluateOnNewDocument` (define `window.chrome`) |
| JS Permissions API quirks | bot flag | `Page.addScriptToEvaluateOnNewDocument` patch `Notification.permission` |
| WebGL renderer/vendor strings | GPU fingerprint | `Page.addScriptToEvaluateOnNewDocument` patch `WebGLRenderingContext.getParameter` (UNMASKED_VENDOR_WEBGL, UNMASKED_RENDERER_WEBGL) |
| Canvas fingerprint | per-pixel hash | `Page.addScriptToEvaluateOnNewDocument` patch `HTMLCanvasElement.toDataURL` + `getImageData` with deterministic noise |
| AudioContext fingerprint | OfflineAudioContext output | `Page.addScriptToEvaluateOnNewDocument` patch `getChannelData` with deterministic noise |
| Screen dims / DPR / mobile bit | viewport + sec-ch-ua-mobile | `Emulation.setDeviceMetricsOverride` |
| Timezone | `Date`, `Intl.DateTimeFormat` | `Emulation.setTimezoneOverride` |
| Locale | `Intl`, `navigator.language` | `Emulation.setLocaleOverride` |
| Geolocation | `navigator.geolocation` | `Emulation.setGeolocationOverride` |
| Font enumeration | font fingerprint | `Page.addScriptToEvaluateOnNewDocument` patch document.fonts iteration |
| **TLS JA3 / JA4** | TLS ClientHello fingerprint | **honest gap — CDP cannot spoof TLS.** Must run traffic through an outbound proxy that emits a Chrome-shaped JA3/JA4 (libcurl-impersonate, curl-impersonate-fork, or a Go/Rust JA3 proxy fronting iproyal). Flagged below. |
| **HTTP/2 SETTINGS / pseudo-header order** | H2 fingerprint | **honest gap — same proxy layer.** Chromium's own H2 stack is correct, but only if the connection is direct; routing through a generic HTTP-CONNECT proxy can re-shuffle. |

Spoof discipline: all `Page.addScriptToEvaluateOnNewDocument` shims live
in one declarative file (`src/spoof/init-script.ts`); a `build` covenant
declares the shim hash; every `chromium_new_target` re-installs it.
Drift is detected by hashing the init-script source on every release.

---

## iproyal proxy as breath effect

The proxy is a per-session runtime parameter, not a global build flag.
Each `chromium_new_target` accepts an optional `proxy` field; under the
hood:

1. `chromium_launch` runs once with `--proxy-server=per-context` so each
   browser context can specify its own proxy.
2. `chromium_new_context` takes `{proxyServer, proxyBypassList}` and
   passes them via `Target.createBrowserContext({proxyServer, proxyBypassList})`.
3. Proxy auth (iproyal user/pass) is satisfied by `fetch_continue_with_auth`
   on the first `Fetch.requestPaused` (proxy auth) event, OR by encoding
   credentials in the URL: `geo.iproyal.com:12321` with creds from the
   `reference_iproyal_proxy` memory.

Kind: `chromium_attach_proxy` (breath), CDP method
`Target.createBrowserContext` + `Fetch.continueWithAuth`.

The proxy is also where the **TLS JA3/JA4 spoof actually happens** — by
routing through a libcurl-impersonate-shaped upstream (or a Rust JA3
proxy fronting iproyal). The CDP layer is honest about not solving this;
the proxy layer covers it.

---

## Statelessness invariants

1. **No module-level state in primitives.** Every kind takes `{cdp, sessionId}`
   (or `{cdp, browserContextId}` for context-scoped builds). No
   `currentTab` global, no `defaultSession` singleton.
2. **The handle is a parameter, not an import.** Agents/CLI thread the
   handle through. A bench probe receives its own handle and never
   touches a sibling probe's.
3. **Receipts are pointers, not payloads.** HAR bodies, screenshots, AX
   trees, page HTML — all go to the value-store under a sha256, and the
   covenant receipt carries only the pointer. (Substrate-bind happens
   later; this spec just names the discipline.)
4. **Idempotence on builds.** Re-issuing `net_domain_enable` on the same
   sessionId is a no-op. Re-issuing `page_add_script_to_eval_on_new_doc`
   with the same source returns the same identifier.
5. **Eval kinds are pure observations.** They never mutate browser state.
   `runtime_evaluate` is the one fuzzy edge — when callers pass an
   expression with side effects, that's the caller's problem; the kind
   itself is observation-shaped.
6. **Breath kinds are the only mutators.** Navigation, click, fill,
   intercept-decision, target lifecycle.
7. **Subprocess Chrome is not "global state."** It's a resource handle
   owned by whoever called `chromium_launch`; pass-or-share is the
   caller's discipline. The covenant kind for launch is `build`
   (declares "a chrome shall exist"), and the receipt body is
   `{cdp_endpoint, pid, version, revision}`.

---

## What this spec does NOT cover

- **Value-store schema.** How HAR bodies / screenshots / AX trees are
  addressed (sha256 → blob) and garbage-collected. Sibling-subagent.
- **ZK signing / receipt sealing.** Covenant-substrate wiring — how
  the receipts above bind into `kinds.ts`. Sibling-subagent.
- **CLI surface shape.** Whether each kind has a 1:1 `unbrowse cdp ...`
  command, or only the composite recipes are user-facing.
- **MCP tool boundary.** Which kinds are exposed as MCP tools versus
  internal-only — `unbrowse_go` / `unbrowse_snap` / `unbrowse_click`
  stay as composite tools, but the underlying recipe is now a sequence
  of primitives.
- **Recipe layer.** The Kuri composite ops (`click(ref)`, `fill(ref,v)`,
  `scroll(dir,amount)`, `waitForSelector`, `waitForLoad`, `auth profile
  save/load/list/delete`, `sessionSave/Load/List`) are recipes built on
  primitives. The recipe spec is a sibling doc.
- **HAR enrichment pipeline.** Existing extractEndpoints / extractAuthHeaders
  / mergeEndpoints chain reads HAR; the v7 HAR-equivalent is "subscribe
  to Network.* events + value-store the bodies." Spec the adapter
  separately.
- **Mac/Linux/Windows postinstall matrix.** `@puppeteer/browsers` handles
  it but exit-code + cache-dir behavior needs verification per platform.

---

## Open questions

1. **Browser context vs target for session isolation?** `createBrowserContext`
   gives separate cookie jars (incognito-equivalent); `createTarget` in
   the default context shares cookies. For parallel bench probes we want
   contexts; for cookie-injection-then-go (the existing flow) we want
   the default context. Decide per-session at the kind level.
2. **`Fetch.enable` performance impact under N parallel sessions.** Kuri
   already showed Chrome's renderer background-throttling kills parallel
   sessions at `--headless=new`. Confirm `Fetch.requestPaused` callbacks
   don't serialize across sessions on a shared browser process.
3. **Chrome version pin cadence.** Re-pin every unbrowse release, every
   month, or only on observed anti-bot drift? Tradeoff: fresh = better
   UA-CH match; pinned = reproducible bench gates.
4. **WS reconnect on Chrome crash.** Kuri restarts Chrome on crash; raw
   CDP does not. Decide whether `chromium_launch` returns a self-healing
   handle or whether the agent re-launches.
5. **Init-script registry.** Should the spoof shims be a single
   monolithic `Page.addScriptToEvaluateOnNewDocument` call, or N
   composable kinds (`spoof_webdriver`, `spoof_webgl`, `spoof_canvas`)?
   Composable lets the agent toggle per probe (e.g. skip canvas-spoof
   when the site doesn't fingerprint canvas) at the cost of more
   receipts per session.
6. **HAR-equivalent persistence.** Where do `Network.responseReceived` +
   `Network.getResponseBody` payloads land? In-memory ring buffer per
   sessionId, flushed to the value-store on `chromium_close_target`?
   Or streamed?
7. **Cookie SQLite reader.** Stays in unbrowse (`src/auth/`), feeds
   `net_set_cookies`. Confirmed not in scope of the rip.
