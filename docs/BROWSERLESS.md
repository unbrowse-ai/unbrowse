# Browserless: the plan

The goal is one sentence: **after a page has been learned once, every call to its route is plain HTTP, and the
browser is spent only where the site's own door makes it unavoidable — once per credential, not once per call.**

This is the plan the work of 2026-11-07/08 points at. It records what is already true, what the browser still does
on the call path, and the order to remove it, with a measurable exit for each phase.

---

## 1. What "browserless" means here

| Measure | Today | Target |
|---|---|---|
| browser launches per call, across the test bank | not measured; some sites open one per call (Trip.com's signing bridge) | **≤ 0.02**, and 0 for a warm route whose credential is alive |
| warm call latency, median | 0.1–4 s on routes with no browser step; ~11 s on Trip.com (one sandbox boot, no browser) | **< 3 s** median, no browser on the path |
| calls one browser visit buys on a walled site | 1 credential until its `Max-Age` | **hundreds**, bounded only by the credential's life |
| sites that never answer without a browser | none measured so far: eBay's and OpenTable's refusals were address shapes (`/` vs `/sch/…`, `/s?` vs `/s/?`), not clients. A site that refuses every shape is still the wall | the wall costs one headed visit, or nothing |

"Browserless" means the node is the client: a Chrome-shaped transport, the
session a real browser earned, and the page's own producers re-run with the page's own state.

## 2. The three kinds of consistency

Everything a site checks about "is this the same client" is one of three things, and each is solved differently:

| Kind | Examples | How it is kept |
|---|---|---|
| **State** | cookies, clearance, csrf/meta tokens, `localStorage`/`sessionStorage` | stored in the jar (`.json`, `.scope`, `.meta`, `.storage`) and re-derived on staleness (`refresh_session`) |
| **Profile** | UA, client hints, header order, TLS/JA4, H2 settings | reproduced deterministically by `ChromeFetch`, measured against the minting browser; the hints are the ones the mint recorded (`navigator.userAgentData`) |
| **Address** | source IP | per-site egress pin: the browser and the calls leave through one SOCKS5 upstream |
| **Sample** | canvas, WebGL, audio, screen, navigator, timezone | *missing*: capture at mint into `jars/<host>.json.fp`, feed the signing sandbox |

The fourth row is the gap that keeps the page bridge on the call path.

## 3. Where the browser is still used (measured)

| Site | What happens | Why |
|---|---|---|
| Trip.com | **the results page's URL was retired, the search form was not.** The old deep link (`dcity=sg`) redirects to `/flights/`; the site's own form submits `dcity=sin&acity=tyo&dcityid=73&acityid=228&ddate=…`. Vanilla `agent-browser` typed the cities, clicked the suggestion, submitted, and landed on the results page — the control that settled fork-vs-site. With that URL the walk learns `POST …/FlightListSearchSSE` and a warm call answers `how: called` with **66 KB of itineraries** (policies, prices, segments) in **24 s** | the signing sandbox misses the first signed call (`x-ctx-wclient-req`), turns itself off, and the **page bridge opens one browser page per run** (299 calls the page made, including the SSE's own signature). The owner's Chrome profile gets the page through; a fresh one is challenged |
| eBay | **the wall was a URL shape, not the client**: `https://ebay.com/` and the homepage redirect answer Radware's 403 to anyone, while the search path (`/sch/i.html?_nkw=…`) served a fresh headless browser. Learned and called browserless: the second query (`rtx 5090`) came back `how: called` with real listings. After a dozen walks in a row the address itself was flagged — every client, including the owner's profile, now gets the 403 from this IP — so the route is right and the refusal is the site's rate limit, lifted by time or a pinned egress | `Trace::door` would have called this a door and it isn't one: a URL the site refuses is not the same as a client it refuses |
| OpenTable | **the wall was `/s` vs `/s/`**: Akamai denies `/s?covers=…` at the edge (a bare `Access Denied`, no challenge) and serves `/s/?covers=…`. With the owner's own Chrome profile attached (`UNBROWSE_CDP`, a real visit) the walk learned the page route `/s/?covers={covers}&term={term}&dateTime={dateTime}` — the results are the page's `__INITIAL_STATE__` — and the next call (`term=Manchester`) answered `how: called` with **50 restaurants** and their names. The GraphQL `RestaurantsAvailability` call is picked over `Autocomplete` when the walk makes it; its replay answered 400 because a value the walk had at an array index could not be produced and the body went out with a `null` in the list — the engine now refuses that request (`SourceMissing`) instead of sending it (the hole-in-a-list rule, below). The page is the answer the site actually gives for this goal | the suggestions echo the term and hold more records; counting them picked the wrong call |
| Carousell | 49 listings, cold 1.9 s / warm 2.2 s, no browser | values are derived from the page; no script producer |
| Lazada | warm 0.6 s; before `refresh_session` a stale cookie opened a browser (12.6 s) | fixed: stale sessions are re-minted over HTTP from the root page |
| HN (control) | 131 ms | plain route |

Two of the browser uses are legitimate and stay: a **wall** is met with a real browser (a headed one, or the
owner's hand), and a **device-bound credential** is earned by one. The removable one is the page bridge on every
call — that is Phase 1 and 2.

## 4. Phases

### Phase 0 — Instrument the baseline

Before changing anything, make the number visible so every phase can be judged.

- Count browser launches per call in the node (the scratch harness's guard already logs them; add a counter to
  `run::CallResult` and the activity line: `browser: true|false`).
- A test bank (`test-banks/popular-sites/`) run that records, per site: `how`, ms, success, browser launches, and the
  door record if any. This is the scoreboard for the rest.
- **Exit:** a table of the report's 10 sites with launches/call and warm latency, on a clean scratch node.

### Phase 1 — Make the signing sandbox sufficient (remove the page bridge from the path)

The page bridge exists because the sandbox cannot yet be the page. Five gaps, in order of value:

1. **Fingerprint sample at mint** (`MintedSession.fingerprint`, `jars/<host>.json.fp`). Capture canvas/WebGL/audio
   hashes, screen, `hardwareConcurrency`, languages, timezone, plugins, `navigator` fields at mint (one
   `Runtime.evaluate`), and feed them to the sandbox so a producer that samples the environment computes the same
   values the browser did. A sample is not a secret; it lives in the jar (0600), never in a route.
2. **Worker and iframe capture.** *Built* (`Target.setAutoAttach`, flattened, workers run without waiting): the mint
   logs a worker's calls under its own session and reads each body on the session that made the request, so a worker
   call is in the walk and a same-numbered request on another session never pairs with the wrong answer. Live proof
   waits on a page whose *API* is worker-driven; the test bank's pages made no worker calls, and none regressed.
3. **WASM producers.** *Partly built*: the sandbox is the real `WebAssembly` (a module compiles and runs), and a page
   that fetches its `.wasm` over the runner bridge can instantiate it. What is missing is carrying a wasm module the
   page loaded **from the route** when the page's JS would otherwise fetch it with a stale URL, and reading a producer
   that is *only* in wasm (no JS glue that names it).
4. **A network in the sandbox.** *Built*: the sandbox's `fetch` records the call (for the signature read-back) and
   asks a loopback bridge the runner serves for the signing call; the runner applies `with_session_cookies`, the
   route's site check and its transport, so the fetch leaves from the pinned address with the session. A per-run token
   guards the line; a host off the route's site is refused. `Fetch::sign_request` now takes `&mut self`. Gate:
   `sandbox.rs::a_script_that_fetches_while_it_signs_gets_the_nodes_answer`.
   What it does not yet cover: an `import()` of a lazily loaded chunk (the sandbox has no module loader), which is
   why Trip.com's producer still falls to the page bridge.
5. **Taint-based producer discovery.** `signing::discover` finds a producer by a quoted header name. Generalise:
   from each request field, walk backwards through bodies, headers, storage, DOM and the captured scripts/wasm to
   the code that wrote it (`Class::Script`), including values assembled across several scripts.

- **Exit:** Trip.com's warm call signs in the sandbox (no page bridge, no browser launch) and still returns
  itineraries; a synthetic gate for each of the five gaps; browser launches/call on Trip.com = 0.

### Phase 2 — A warm page bridge, for what the sandbox still cannot sign

Some producers genuinely need a DOM, a canvas or a worker the sandbox will not have. For those, stop paying a page
load per call:

- Keep **one browser and one page per site warm** (per profile, TTL-bounded, evicted with the door's credential),
  and let `signed_page` read the calls from that page instead of opening a new one. Cache the `METHOD path → Signed`
  map per run already exists; extend it across calls with a TTL.
- On staleness, reload the warm page rather than relaunch the browser.
- **Exit:** Trip.com (if any step still needs the bridge) and one other page-bridge site: warm latency < 5 s,
  launches/call ≤ 0.02.

**Phase 2, attempted and reverted.** A stable page session per site and a read of the page's already-recorded calls
(no clear, no open) was built and measured: it changed which call Trip.com's route answered with and the route
stopped carrying flights. The page bridge's page is not safely reusable without the state the walk had — the call may
be made only after the page does something, and a page left open is not a page that just walked. Reverted; the entry
stands until there is a way to tell a warm page's calls from the walk's.

### Phase 3 — Request-shape fidelity (stop drawing walls at all)

A wall is often the transport and headers, not a token.

- Client hints (`sec-ch-ua`, `sec-ch-ua-mobile`, `sec-ch-ua-platform`), `priority`, and the `Accept`/`sec-fetch-*`
  shape for script calls — read from the minting browser, not guessed.
  *Built for the low-entropy hints*: the mint's probe records `navigator.userAgentData` (brand list in the browser's
  own order, mobile flag, platform) in the fingerprint sample, the sandbox presents it to the page's own code
  (including `getHighEntropyValues`), and `ChromeFetch` sends the three headers on every request it makes — a
  Chrome-shaped ClientHello with no `sec-ch-ua` was a Chrome that never existed. A route's own headers win; a sample
  from a mint that recorded none sends nothing. Gates `http.rs::the_client_hints_are_the_browsers_own`,
  `http.rs::a_routes_own_hint_shape_wins_over_the_browsers_default`,
  `sandbox.rs::the_client_hints_a_browser_reports_are_the_walks`.
  *Also built*: the walk's own browser-shape headers ride the route as constants — `accept`, `accept-language`,
  `priority`, `sec-fetch-*`, `sec-ch-ua*` including the high-entropy values a site asked for with `Accept-CH`, and
  `dnt`/`cache-control`/`pragma`. `slots` keeps them out of the session's reach (not the jar's) and `classify` holds
  them constant, so a replay presents what the site was shown instead of guessing; the transport's `user-agent`, the
  jar's `cookie` and the framing headers (`host`, `content-length`, `connection`, `accept-encoding`) stay theirs.
  Gate: `graph.rs::the_browsers_own_shape_rides_with_the_call`.
  *Still open*: the measured header order/casing against a TLS echo page.
- Verify header order and casing against the browser with a TLS/HTTP echo page (`UNBROWSE_TLS_DEBUG`), the same way
  the JA4 is measured.
- Cookies already go out longest-path-first, oldest-first, with expiry, and only to a path their recorded `Path` covers; the jar keeps each cookie's path and HttpOnly beside it (`.json.meta`), from the walk's browser and the lines that set them.
- **Exit:** every plain `403` in the test bank either disappears or is a recorded door; no `403` caused by a shape
  difference from the minting browser.

### Phase 4 — Doors: one visit per credential, never per call

Already built: `Door` on the route (class, statuses, credential, TTL, earner), the `Door` replay error, the
browserless `refresh_session` before any browser, and `shared_mint` (opt-in, same-site, logged).

- Persist the door with the route across restarts. *Built*: a learned route records the door it met on its graph
  (`Graph::door`, written with the route), and `doors.json` caches the last one per site for a walk that meets it again.
- Credential reuse. *Built*: a call that meets a door whose credential the jar holds, still inside the `Max-Age` its
  line gave (a session cookie is alive while the jar is), opens no browser — the refusal is not the credential's
  absence, and a visit would earn the same cookie again. A lapsed or absent one is the visit's. Gate:
  `client.rs::a_live_credential_costs_no_browser`.
- *Still open*: the measurement itself — N calls per browser visit on a walled site (target ≥ 100), which needs a warm
  walled route and its credential to live long enough to count.
- **Exit:** on a walled site that a warm profile passes, N calls per browser visit (measure N; target ≥ 100).

### Phase 5 — Sharing without a client (done, kept honest)

- Account keys are the caller's inputs and are removed from the URL/body templates.
- A shared route goes only to the site its listing names.
- A shared route mints only with `shared_mint`, only on its own site, in an empty profile of its own, logged.
- A shared route reads the owner's session and never writes it; an answer that replaces that session ends the call.

- **Exit (already):** the gates in `docs/GENERALITY.md`; no route body carries a session, storage or sample.


## 6. Replicating a browser engine, without one

A page's producer reads a fixed set of surfaces. "1:1 without a browser" means reproducing every one of them exactly;
anything approximated shows up as a different token. The surfaces, what a browser provides, and what can stand in:

| Surface | What the browser gives | Substitute without a browser | 1:1? |
|---|---|---|---|
| JavaScript semantics | V8 / JavaScriptCore | the same engine, embedded (Node's V8, or JSC) | **yes** |
| DOM, events, modules | DOM + CSSOM + module loader | `jsdom`/`linkedom` + a module loader over the bridge | close; layout missing |
| Layout (`getBoundingClientRect`, computed style) | a layout engine | nothing faithful standalone (Yoga approximates flexbox) | **no** |
| Canvas 2D | Skia, the system's fonts, antialiasing | `node-canvas` (Skia/Cairo) with the mint's font set | close; pixels only if fonts and rasterizer match |
| WebGL | a GPU driver (vendor/renderer strings, shader results) | `headless-gl`/ANGLE/SwiftShader | partial; software rasterisation differs from the real GPU |
| Audio | WebAudio graph, hardware | `web-audio-engine` | approximate; a hash differs |
| Workers, service workers | dedicated/shared/SW lifecycles | `worker_threads` for dedicated workers; SW lifecycle missing | partial |
| Wasm | V8's engine | Node's `WebAssembly` | **yes** |
| Network, cache, cookies, TLS/H2 | the browser's stack | the node's Chrome-shaped transport, the jar, the runner bridge | **yes** (and pinned) |
| Timing, event loop, `performance.now` | the browser's scheduler | Node's loop | approximate; a producer that hashes timing differs |
| Fingerprint surfaces (screen, navigator, fonts, plugins, Intl, timezone, canvas sample) | the real environment | the sample recorded at mint | **yes for the recorded probes**; new drawings need the rasterizer |
| Behaviour (mouse, keys, navigation order) | a person or a script | synthetic events | **no**; the scoring model sees it |

**What this means.** The layers that are 1:1 without an engine are exactly the ones this plan has been building: the
transport, the request shape, the session state, the environment *sample*, and the page's own JavaScript. The layers
that are not are the rendering pipeline (layout, GPU, audio, timing) and behaviour. So:

- A producer that signs from state, headers, storage, a recorded environment sample and its own JS: **browserless,
  1:1** — that is the sandbox, and 1.1/1.4/1.3 are what make it whole.
- A producer that reads layout, draws new content into a canvas, needs a real GPU string, or is attested by
  behaviour: **one real visit per credential** is the floor. Embedding an engine (Servo, WebKitGTK/JSC as a library)
  is the 1:1 option — it is still an engine, but not a browser application; the cost is fonts, GPU and size.

**What we are missing in this repo, in order:**

1. **Dynamic module loading in the sandbox.** *Built*: `import()` is rewritten to `__ubImport`, which fetches the chunk
   over the runner bridge and runs it in the same context, handing back the globals it declared as the module's
   namespace; `import.meta` is `__ubMeta` (the page's URL). An **ES module** chunk is detected (the classic run's
   `export`/`import` syntax error) and evaluated as a module with `vm.SourceTextModule`, its dependencies linked
   through the same line. A script the page's code creates is a **harness node**, not a DOM node: `append` runs it
   over the same line in the page's context, so a bundle's own loader (`createElement('script')`, `src`, `onload`)
   works and the runtime registers the chunk in its own realm. There is no real-DOM mode (`UNBROWSE_DOM_MODULE` is
   gone): a DOM module such as happy-dom is the runtime's own code, its every object leads back to the process, and
   the page's realm must hold none (`sandbox.rs::a_page_cannot_reach_the_host_process_through_a_constructor_chain`).
   A framework page that needs a real DOM goes to the browser. Gate: `a_chunk_loaded_lazily_is_fetched_and_run`,
   `an_es_module_chunk_is_evaluated_as_a_module`.
2. **A worker in the sandbox.** *Built*: `new Worker(url)` fetches the worker script over the same line, runs it in
   its own context (no DOM, its own messages, the page's `fetch`), and the calls it makes join the page's signed map;
   messages posted before it loads are queued. Gate: `a_workers_message_signs_the_call`.
   `importScripts` is *built* for the shape workers are written in: the literal URLs a worker names are fetched over
   the same line before its body runs — including what those scripts name — and the calls execute at the moment the
   worker makes them, once each, in its order. A URL the worker computes rather than writes is refused by name (the
   line is asynchronous; a synchronous call can only read what was already fetched). Gate:
   `a_workers_import_scripts_ride_the_line_and_run_in_order`.
3. **A canvas rasterizer with the mint's fonts.** `node-canvas` seeded by the recorded sample: same fonts, same size,
   same antialiasing. Without it, a producer that draws new content gets a different hash than the browser.
4. **WebGL strings and pixels.** `headless-gl` with the recorded `UNMASKED_VENDOR/RENDERER`, and a measurement of the
   shader outputs against the mint; if they differ, keep the recorded sample for the probes that matter.
5. **A per-visit marker for the page bridge (Phase 2).** A navigation nonce the page carries, so a warm page's calls
   are known to be this call's. Without it, a page left open is not the page that walked (the reverted attempt).
6. **Request-shape details the walk's own headers already carry** (client hints, `priority`): keep them as constants,
   never invent them — a hint that disagrees with the transport's TLS/UA is worse than none.

**A route keeps the scripts its call needs, measured, not the whole boot set.** `signing::compact` boots the page's own
code with the full set, then drops one script at a time and keeps the drop only while the page still makes the call the
route asks for. The set that remains is verified by execution; a page that makes no such call in the sandbox keeps the
full set and the bridge runs it as before. It is off by default (`UNBROWSE_COMPACT=1` at learn time) because each drop
costs a boot; the gate itself is one boot. Measured on Trip.com's route: the page stops in React's event system, so
the gate refuses and the 20 scripts (7.8 MB) stand — the reduction is ready for the day the page's call is reached.
Gates: `signing.rs::a_route_keeps_only_the_scripts_its_page_needs_to_make_the_call`.

**The boot set is the document's own scripts, all of them.** Trip.com's results page names 22 scripts (7.8 MB): under
a 4 MB cap the route kept 15 and dropped `vendor`, `biz-common`, `list-ssr-gateway` and `list-main` — its entry
bundles. The sandbox then booted the page's start-up only (three calls, no errors) and never reached the flight list.
The cap is now 8 MB, the measured size of that page's own code; a smaller page carries less.

**Script selection is built, and it changed what the sandbox does.** The lever above was taken: `discover` now keeps
the scripts the page's own **document** names, in the order the page loaded them, up to the 4 MB cap — a content host's
bundle is the site's own code, so a CDN is not a third party, and the document is what says so. Gates:
`signing.rs::the_pages_own_boot_scripts_ride_in_load_order_and_a_third_partys_do_not`,
`a_document_that_names_no_script_carries_only_the_producer`, `the_boot_scripts_stop_at_the_routes_cap`.

Measured, on the Trip.com flight page: its document names **22 scripts, 7.8 MB**. A 4 MB cap kept 15 of them and dropped
`vendor`, `biz-common`, `list-ssr-gateway` and `list-main` — the entry bundles — so the sandbox booted the start-up only.
With the cap at 8 MB the route carries the page's own code, and the sandbox **runs it**:

| 4 MB cap | 8 MB cap |
|---|---|
| 0 errors, **3 calls** (`getAppConfig`, `uploadDeviceData`, `userRecognize`), no flight list | the app's bundles run (`list-main` included); the remaining error is inside the app, not the harness |

The boot set is downloaded **once**, at learn time (the walk fetched it anyway) and carried on the route; a call runs
it from there. A chunk the page loads later that the route already carries runs from the route too — only a chunk it
doesn't carry goes over the loopback bridge. The page's own data calls are answered from `graph.api` first and go to
the site only when the route has no answer. A shared `Recipe` carries no scripts (`browser_assisted: true`), so a
listing never ships a page's code.

Two platform pieces the bundles needed are now there: `Storage` (the web storage interface a bundle feature-detects;
its stores were already the page's) and `UNBROWSE_SIGN_SETTLE_MS` (a page whose boot is slow to reach its call gets
longer than the 2 s constant — Trip.com's route needs ≥ 10 s). The debug line (`[sign] sandbox: N errors [...]`) names
each stop.

So the sandbox is now executing the page's own application, not a fragment of it. **Trip.com's calendar route is now
browserless**: **one** boot of the page signs both of its calls (`getCityImageById` and `GetLowPriceInCalender`), and
the route answers `ok true, browser false` with the calendar's prices in **~11 s** (a 6.5 s boot).

Getting there needed one more platform piece, and it is general: **a page's first render assumes its declared
initial chunks are already evaluated.** A browser reaches that through its own entry's module order; a harness that
registered the chunks but has not evaluated them meets a module mid-cycle, and a circular import reads a binding
before initialization — on Trip.com, `loadSync` → `defaultResolveComponent` → `Cannot access 'qd' before
initialization`, which leaves the component unrecoverable and the page's data layer unstarted. The harness now:

- watches every global array whose `push` a webpack runtime replaced (`__LOADABLE_LOADED_CHUNKS__` or any other
  name), records each chunk's module ids and factories, and captures that runtime's own `require` through a probe
  payload with an executor — no module id or array name is hard-coded;
- before the page's events, evaluates the chunks the page itself declares as initial
  (`__LOADABLE_REQUIRED_CHUNKS__`, loadable's contract) in **dependency order** (the factories' literal `require`
  calls), skipping cycles, and ignores a module that throws (the runtime re-evaluates it on demand). Measured:
  335 evaluated, 1 harmless failure (`13004`: it expects a DOM node).

Two facts stay as they are, and are the next work rather than mysteries:

- **A page error must not cost the answer.** The sandbox survives `uncaughtException` and `unhandledRejection`,
  counting the error and sliding the settle window: a page's own throw does not end the run with no output. The
  settle window also slides with each call the page makes, so a slow chunk is not a page that said nothing.
- **What the boot spends its time on, measured.** 47 scripts execute in **0.39 s**; the declared-initial-chunk warm-up
  is **0.10 s**. The rest is the page's own live work, and it is network: 19 bridge calls, dominated by
  `FlightListSearchSSE` (~5 s, the flight list for the requested date — input-dependent, so the walk's answer cannot
  stand in) and Google Tag Manager (~1.5 s, an analytics tag the page loads). The < 3 s target needs that work
  reduced, not the scripts compacted.

Two call-path levers landed with this, and both are general:

- **Stop when the route's signed calls are in.** The runner tells the harness the `METHOD path` of every step whose
  value the page's code makes; once all of them are recorded, a 400 ms grace ends the run instead of the whole quiet
  window. A route at a 12 s settle used to pay 10 s of idle per boot.
- **One boot per page address.** The runner keys every call one boot made by `METHOD path` and answers each later
  step from that run; a page that makes both signed calls is loaded once. Before, each step booted the page again.
  Measured: the calendar route went from 35 s (two boots, 12 s settle) to ~11 s (one boot, 6.5 s).

Compaction is batched now (a group of scripts is proved unnecessary in one boot instead of one boot per script) and
still opt-in: with script execution at 0.39 s, it cannot pay for itself on this page.

**The single path is one verified producer per value, and the route carries the producer's code — not the app.** Two
steps toward it are in:

- **A primitives alias in the slicer.** A bundler hands the hashes out as module exports (`(0, n.md5)(body)`); the
  lifted program now calls the runtime's `md5` instead, and the verifier still decides. Trip.com's
  `w-payload-source` (`c_sign.toString(md5(body))`) now lifts to a **self-contained** program — the whole `c-sign.js`
  rides inline — and runs; its value differs from the walk's (`Differs`) because the encoder is seeded per call, so a
  call decides.
- **A program that answers with no page scripts keeps none.** `Evidence` carries the scripts a program names and did
  not inline; a self-contained program keeps no scripts, and the route does not boot the page for it.

The measured floor on this route is `x-ctx-fvpc`: the producer reads `window.FVPC`, set by `overlock.js`, an anti-bot
SDK whose value arrives from DOM/iframe/canvas work. It is not produced even with **all 33 scripts and a 12 s settle**
(`read_global` answers nothing), so it is not a value a synchronous program can carry.

But the page's own signed call **omits both headers** and the site answers (`browser: false`, prices returned). So
those two fields are not values of that call at all.

**That is now the model, not a pruning pass.** A page-made value is a property of the **step**, never a field the route
sends: `Step.page_signed` says the page's own request is this step's request, and `Step.page_producers` keeps where
the page's code wrote each value as evidence. `discover` emits the marker instead of per-header `Class::Script` fields;
`replay` asks the transport for the page's request on the marker. There is nothing to reconcile and no pass: a header
the page's call omits is simply not sent, and a header it carries is the page's own. Routes learned before the marker
keep working (`is_page_signed` reads their `Script`/`Computed` fields the same way).

Measured on a copy of the Trip route with **no Script fields** — only `page_signed` and two producers per step: both
calls sign from one boot, `browser: false`, prices returned. The graph now describes what the route sends, not what
the page did.

**The call then decides whether the step can be plain.** At learn time the trial asks twice, in order:

1. the route's own fields, with **none** of the page's values. An answer means the page wrote nothing this call
   needs: the producers are dropped, the step is plain, and no script or page rides on it;
2. the walk's values as they were. An answer on a moved input means the values are the session's: kept by name
   (`Minted`), and the step needs no page.

A refusal leaves the step page-signed. The trial's client has no browser, so a route whose *page step* is walled
keeps its page — a false negative, never a wrong drop. Gate:
`learn::tests::a_page_signed_step_the_site_answers_without_is_made_plain` (the site's answer is a parameter, so the
test needs no site).

Two more reasons a call healed when it did not need to, fixed:

- **The page step is answered from the carried markup.** The first step was fetched again on every call, though the
  route carries `page_html` and only its text-derived values read it. It is now served from that markup when it is
  not the target, set no cookie, and every later read is text; the route fetches the page only when it needs the
  live response. A page behind a wall can no longer open a browser on the call.
- **A wall, a failed browser or a failed transport is reported, not re-learned.** A walk meets the same browser and
  the same wall; only drift (a moved value, a changed shape) is a walk's to mend.

Measured: the learned Trip route calls in **8.8 s, `browser: false`**, no page fetch and no heal; a plain copy without
the page's signed request fails at `getCityImageById` with a 403 and returns the error instead of healing. Gates:
`replay::signing_tests::the_page_the_route_carries_is_not_fetched_again`,
`client::heal_tests::a_wall_or_a_failed_browser_is_not_a_walk_away`.

**A server-sent stream is a stream in the sandbox.** Trip's `FlightListSearchSSE` is read with
`response.body.getReader()`; the bridge's response had no body and, when the header was missing, no content-type, so the
page stopped at the stream and never made the middle search built from it — that route fell to the browser. The
sandbox response now carries a `ReadableStream` of the body, and a missing content-type is named from the body (an
event stream, JSON, text). The page reads the stream and makes the call; the sandbox signs it. Also fixed with it: a
page-load call whose answer nothing reads is skipped before it is sent (its 403 no longer opens a browser), and a
walked cookie a later step already carried is minted (`Minted`) so a one-time bootstrap is skipped.

Measured on the re-learned bank: **4/4 answered, 4/4 browserless** — FlightListSearchSSE 12.9 s,
FlightMiddleSearch 31.9 s, calendar 9.7 s, Algolia 0.16 s. Gate:
`sandbox::tests::a_page_can_read_a_server_sent_stream_and_make_the_call_after_it`.

Also fixed and gated: **a heal carries the page it boots the scripts on** (`a_heal_keeps_the_page_it_boots_the_scripts_on`).
A rebuilt chain used to lose `page`/`page_origin`, so a route that drifted fell to the browser even with the producer in
its scripts — the runner printed "no page on the route".

**The data layer runs first, the markup is the fallback.** A route with scripts now also carries the answers the
walk's page read — its own calls, JSON, on its own site, bounded to 40 answers and 512 KB (`graph.api`, filled by
`signing::record`). The sandbox answers its `fetch`/`XMLHttpRequest` from those first, over the bridge second, and the
page's markup only for a script that paints. Measured on Trip.com: a route carries **28 answers, 245 KB** (its
`getAppConfig.json`, `getConfiguration`, header and locale data) — so the bundle's start-up boots from what the site
said, with no network and no page.

Gate: `sandbox.rs::a_recorded_answer_boots_the_bundle_without_a_line` (a bundle reads `getAppConfig.json`, signs with
what it said, and the runner's line refuses every request), `signing.rs::the_pages_own_data_answers_ride_on_the_route`
(the page's own data is kept; markup and a third party's answers are not).

The shared-route body is a fresh graph, so a route fetched from the network carries no answers: it is the
contributor's session data, and a shared route generalizes the route, never the session.

**The page's own scripts, in the page's own order.** The sandbox now runs what a browser would run, and only that:

- the page's **inline** scripts run first, in document order, before the bundles its tags name — the config a bundle
  reads (`window._white_config`, `__NEXT_DATA__`) is written by a `<script>` in the page, not by a bundle
  (`an_inline_script_the_page_carries_runs_before_the_bundles`);
- a block the page carries as **data** (`application/json`, `application/ld+json`, a template) is not executed: its
  text is what the page's code reads from the element (`a_pages_state_block_past_the_cut_rides_with_its_head`);
- a bundle's **own loader** works: it builds a `<script>`, sets `src`, appends it, and the chunk is fetched over the
  line and run in the page's context;
- the platform's data types are the runtime's (`Blob`, `FormData`, `Headers`, `Request`, `Response`, `AbortController`),
  and `Image`/`Audio` answer as a browser does.

**The page's state survives the cap.** `page_html` is cut at 128 KB, and the cut now backs off to the last complete
element (half a script is not a script), then carries the page's `<script type="application/json">` blocks even when
they sit past the cut — the state a bundle boots from. Markup past the cut stays in the walk.

**A producer is a recipe, measured, and Trip.com's is proven.** A live page was probed by wrapping `String.prototype.concat`
and `setRequestHeader` for one call, which captured the signature and the exact string it was hashed from:

```
input : /restapi/soa2/27015/FlightListSearchSSE;POST;-1794198118858-6909512;09034102311421493297;1794198116912.eb47A68Ul2Z6;;
header: x-ctx-wclient-req = 14606ea9e6854bf2b97485de48d54245
md5   : 14606ea9e6854bf2b97485de48d54245
```

**The jar keeps only what held.** A header is moved to the session jar (`Class::Minted`) only when the walk shows one
value for it — or a value some request repeated; a header whose value is different on every request is the page's to
compute, and stays in the graph for a producer or a recipe. Without that, a per-call signature was frozen into the jar
and the recipe never saw it (Trip.com's `x-ctx-wclient-req`, 25 values over 25 requests). Gate:
`graph.rs::a_header_that_changed_per_call_is_not_the_sessions`. Measured live after it: the signature is a recipe.

Measured on a probed walk, fitted offline from the capture and then printed by the node: the flight search's header
becomes `Recipe { Md5, ";", [Path, Method, Fresh("-{d13}-{d7}"), Cookie GUID, Cookie UBT_VID, "", Cookie _RF1] }`
(`UNBROWSE_SIGN_DEBUG=1` prints each fit and why a field was not one). The probe also records what a header's payload was before encoding, for a header built with `btoa` (the encoded string
is matched inside the header). Measured on the flight page: neither `w-payload-source` nor `token` is `btoa`'s — both
use the app's own encoder (`1001-common-…`, `1.0.9@102!…` over a custom alphabet), so nothing was decoded. Their inputs
need the encoder itself hooked, where the page defines it — not a library call.

Two other computed headers on the same step —
`w-payload-source` (an SDK payload) and `token` (a session value that should be `Minted`) — still have no recipe, so
the route still carries the page's scripts for them. One of three producers moved off the page; the other two are the
next fits.

**Carried, not described.** The recipe is a value in the graph (`Class::Recipe { algo, separator, parts }`), fitted at
learn from the walk's signing probe and rebuilt at replay from the request as it stands and the session it carries —
no page, no scripts, no bridge. A part is the call's path, method or body, a cookie by name, a clock reading rendered
anew (`{ms}`, `{s}`, `{dN}`), or the empty string; a piece that is none of those is not fitted, because it could be a
per-call value frozen into the route. Gates: `signing.rs::a_signature_is_fitted_to_a_recipe_and_rebuilt`.

So `x-ctx-wclient-req = md5(path+search; method; requestId; GUID; UBT_VID; DUID; _RF1)`: the call's own address and
method, a per-request id the page makes up (`-<millis>-<random>`), and four session values (cookies). None of it is
page code — the sandbox exists here only because that was not known. The engine can fit this shape from a probe at walk
time and carry a recipe (hash, separator, parts) of a few dozen bytes; `Class::Script` then covers only what no probe
fits. The walk now records the cookies the browser actually sent (`requestWillBeSentExtraInfo`), which is what made the
formula checkable at all.

**A producer the recipe can't express is a program, verified.** A fitted recipe covers one shape: a hash over a tuple
of the call and the session. For the rest — a custom base64 alphabet, a second hashing stage, a value only the page's
own module knows — the engine carries a tiny program instead, behind a gate that keeps the generator honest:

- **learn time only.** `UNBROWSE_GENERATE_PROGRAM` (a command) is given the walk's own sightings: each call's context
  (method, URL, body, cookies, other headers) and the value the page's code wrote, plus the page's code around the
  write site. It answers one `function sign(ctx)`. A call never asks a model for anything.
- **the verifier decides.** `generated::verify` runs the program in `sandbox::run_program` — a standalone script with
  no page, no network, no filesystem, no timers, no `require` beyond `crypto`/`buffer` — and ships it only if it
  reproduces **every** sighting, carries none of the values it was shown (a hardcode is discarded), and still answers
  an input it never saw (a lookup keyed by the exact sightings is discarded). Two sightings minimum.
- **the route keeps the program, not its samples.** `Class::Generated { program, evidence }`; the evidence is
  metadata (sightings reproduced, write site, who proposed it, a hash of the evidence), never a cookie or a value. A
  program that fails at call time returns `NeedsBrowser`, never a guessed header.
- **sharing follows the recipe's rule.** A shared route carries a generated producer as the browser's until the
  shared format names it.

Gates: `generated.rs::a_correct_program_passes_and_a_hardcoded_one_fails`,
`generated.rs::a_program_that_only_answers_its_sightings_fails_on_a_new_input`,
`replay.rs::a_generated_producer_is_run_without_a_page`,
`replay.rs::a_generated_producer_that_fails_falls_back_to_the_browser`,
`signing.rs::a_sighting_is_read_with_its_own_cookies_and_body`. The generator is a proposal source; the sandbox run
is the proof.

**A page's traffic is not the route.** A route's steps are its target's dependency closure, and a value the page made
up is told to the site **once** — by the first call of its own that carried it — not by every call that happened to
carry it afterwards. A visitor id rides on every request, so keeping every sender kept the page's whole load: Trip.com's
flight search was **22 steps for one call** (its config, ads, tracking, comfort flags, neighbouring days' prices), of
which the target read only the page. It is **3 steps** now — the page it reads, the first call that told the site the
visitor id, the search — out of 313 captured exchanges, and the call still answers (`how: called`, 68 KB of
itineraries). An upload that carries such an id still goes with it whole, so a post's video and cover both ride.
Gate: `graph.rs::an_id_the_page_made_up_is_told_to_the_site_once`.

**The ask is not evidence.** Four rules keep a page and its settings from beating the call that answers:
the goal page's own query values earn nothing for being sent (it carries them by being asked), and its path naming a
goal word is not it naming the answer; a call that carries the page's address along (`"url":"…?dcity=sin&acity=tyo"`,
what a site's header asks its settings by) sends none of those values, only its own; a plural head word (`flights from
Singapore to Tokyo`) makes the goal a list, not one thing; and a call answering markup (a "more results" fragment)
earns nothing over the page it belongs to. With them the Trip.com walk picks `FlightListSearchSSE` (153 records, the
route and the day said back) over the `showfarefirst` page, the site header, and the neighbouring-days calendar.
Gates: `learn.rs::the_pages_own_query_is_the_ask_not_evidence_it_answers`,
`learn.rs::a_page_carried_along_sends_none_of_its_values`, `learn.rs::a_plural_goal_wants_a_list`.

**HTML is the fallback, in the pick too.** When a walk holds both the page and the call that fills it, the call is the
route: `rule_pick` ranks a data call above the page that renders it, and the page answers only when no call does
(`learn.rs::a_data_call_beats_the_page_that_renders_it` — the fixture picks `/search` without the preference and
`/api/search` with it).

**The runtime is the node's environment.** A node whose `PATH` has no `node` has no signing bridge at all; every "sandbox
made no matching call" in a harness run without node on `PATH` was "no runtime", not a bad bundle. Set `SIGNING_PROGRAM`
(or put node on the node's `PATH`) to judge the sandbox at all.

**The honest ceiling.** "1:1 with the engine, without an engine" is possible for everything a page computes from state,
samples and its own code; it is not possible for what the engine *paints*, *times* and *scores*. That is why the plan's
floor is one real visit per credential and not a browser on every call, and why the sandbox is judged by the
`browser` counter: the goal is not to imitate the engine, it is to need it less.


## 5. The line

The engine will not synthesise a vendor's token, extract a per-customer key from an obfuscated bundle, or replay a
sensor payload that belongs to another client. Those are the vendors' checks and the vendors' product; the work that
survives is *being the client*: state in the jar, profile in the transport, address in the pin, producers run again
with the page's own code. For a device-bound attestation the honest cost is one real visit per credential — the plan
makes that once per TTL, not once per call.

## 6. Risks and unknowns

- **Environment fidelity.** The sandbox's canvas/WebGL/audio are stubs fed by a sample; a producer that reads pixels
  or measures real timing may still diverge. The sample is the mitigation; a warm page (Phase 2) is the fallback.
- **WASM + workers.** Capturing every target and carrying wasm grows the route; both need size bounds (the script cap
  is 4 MB today).
- **Sandbox network.** A real fetch from the sandbox widens what a route's scripts can reach; it must be held to the
  route's site and the egress rule, and it must never be able to name another host.
- **Measurement honesty.** The Trip.com call is a page bridge plus an SSE stream; the Phase 0 counters tell the two
  apart, and the plan's targets are stated per cause.
- **The right tie-break was the record list's length, not its words.** A call that lists 78 itineraries beside a call
  answering three fare policies: the rule now scores the longest list in an answer (`(n).ln_1p() × 1.5`) and reads an
  event stream's keys from its last event. That picks Trip.com's SSE (83 itineraries) and Carousell's `/ds/` search
  (49 titles) in fresh walks; the earlier name/price ratio promoted policies and had to go.
- **Tie-breaks that cost more than they buy.** A records-shaped score (names/prices beat identifiers) was added to the
  rule and removed: on Trip.com it promoted a list of fare policies over the itinerary stream, and the route stopped
  answering flights. The learner's own bytes-and-words rule picked the right call on both Trip.com (83 itineraries)
  and Carousell (49 titles) once the paging fix was in; the score was not needed.
- **A stream's completeness beats its latency.** The event-stream read stops on `[DONE]`, the stream's end, 120 s, or
  60 s of silence — not on a short quiet mark. Trip.com computes the flight list for tens of seconds after its first
  event; a 2 s quiet cut the answer to the policy list alone.
- **The call that names its own ask beats the one that echoes the words.** A GraphQL call names what it answers in its  address (`opname=RestaurantsAvailability`) and in its answer's keys (`data.availability`), not in its path
  (`/dapi/fe/gql`); a search box's `Autocomplete` echoes the term and holds fifty suggestions against the answer's
  three records. Counting records picked the suggestions. The rule now reads the answer's key names at any depth (a
  stream's events too), and ranks a data call whose own address names the goal's subject ahead of one that only says
  the words back. The subject excludes the words every goal and half the addresses carry (`search`, `find`, `list`),
  so `/api/certified-search` names nothing. Gates:
  `learn.rs::a_calls_own_answer_beats_a_suggestion_list_that_echoes_the_term`,
  `learn.rs::a_list_that_says_no_word_of_the_search_is_not_its_answer` (kept: a widget that sends the term and answers a
  list that names none of it is still no route),
  `learn.rs::the_call_whose_records_say_back_the_search_wins`.
- **A date and a time are pieces of the caller's ask.** A call carries `date: 2026-11-12` and `time: 19:00` beside
  the page's `?dateTime=2026-11-12T19:00:00`; as constants, a call for another day asked for the walked one. A value
  that is a piece of what the caller sent is now written again from their new value, at the same offset and length
  (`Class::Piece`), when it sits in the caller's value once and is at least four characters. One-character values and
  pieces that repeat (`2`, a year that appears twice) name no occurrence and stay as they were. Gates:
  `graph.rs::a_date_and_a_time_are_pieces_of_what_the_caller_asked`,
  `graph.rs::a_piece_of_a_caller_value_must_sit_there_once`,
  `replay.rs::a_piece_of_the_callers_value_is_written_from_what_they_send_now`.
- **A hole in a list is not a narrower call.** A value the walk put at an array's index and a call could not produce
  (its source moved, or the site's state no longer holds it) used to go out as `null` in the list: OpenTable reads a
  `restaurantIds` list with a hole as a malformed call and answers **400**, and the edge's refusal looked like the
  client's. The body builder now refuses the step and names the value and the response that should have held it
  (`SourceMissing`), so the route heals or goes to the browser instead of sending a request the walk never made. An
  object key left null still goes as the template had it (a site may read it as absent). Gate:
  `replay.rs::a_hole_in_a_list_is_not_the_request_the_walk_sent`.
