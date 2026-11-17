# The 59-case search bank, learned once and replayed browserlessly

The bank's `search-cases.json` run by hand against a scratch node (127.0.0.1:7796, `~/.unbrowse` of its own), on
2026-11-10. Each case was asked twice: first with the case's first value (the node walks the page in its browser and
keeps a route), then with a second value. The second ask is the test: `how: called` and `browser: false` mean the
route answered over plain HTTP, with no browser.

**37 of the 59 cases answered browserlessly.** The second ask is listed with its milliseconds and whether the second
value is in the answer (the value is searched in the whole reply, so a site that echoes it back counts).

| Site | 1st ask | 2nd ask | ms | browser | 2nd value in answer |
|---|---|---|---|---|---|
| pypi.org | learned | called | 567 | false | yes |
| carousell.sg | learned (page route, picked) | called | 2406 | false | yes |
| postgresql.org | learned | called | 702 | false | yes |
| kubernetes.io | learned | called | 336 | false | yes |
| archive.org | learned | called | 1061 | false | yes |
| britannica.com | learned | called | 384 | false | yes |
| nasa.gov | learned | called | 2424 | false | yes |
| itch.io | learned | called | 237 | false | yes |
| mayoclinic.org | learned | called | 665 | false | yes |
| mastodon.social | learned | called | 601 | false | yes |
| asos.com | learned | called | 522 | false | no |
| mi.com | learned | called | 754 | false | yes |
| vanguard.com | learned | called | 101 | false | yes |
| marriott.com | learned | called | 1242 | false | no |
| accuweather.com | learned | called | 535 | false | yes |
| allrecipes.com | learned | called | 873 | false | yes |
| substack.com | learned | called | 1582 | false | yes |
| wordpress.com | learned | called | 447 | false | yes |
| pexels.com | learned | called | 2499 | false | yes |
| wp.pl | learned | called | 586 | false | no |
| usatoday.com | learned | called | 3151 | false | yes |
| canva.com | learned | called | 591 | false | yes |
| roblox.com | learned | called | 247 | false | yes |
| minecraft.net | learned | called | 684 | false | yes |
| discord.com | learned | called | 878 | false | yes |
| booking.com | learned | called | 1411 | false | no |
| airbnb.com | learned | called | 1271 | false | yes |
| amazon.com | learned | called | 1177 | false | yes |
| google.co.jp | learned | called | 905 | false | no |
| target.com | learned | called | 2210 | false | yes |
| amazon.co.jp | learned | called | 1471 | false | no |
| makemytrip.com | learned | called | 241 | false | no |
| google.com | learned | called | 471 | false | yes |
| www.google.com (flights) | learned | called | 1217 | false | yes (Tokyo fares) |
| huawei.com | learned | called | 322 | false | yes (`router`) |
| ieee.org | learned | called | 1746 | false | yes (`photonics`) |
| foodnetwork.com | learned | called | 1805 | false | yes (`pasta`) |

## Re-checked after the run (2026-11-11)

The table is the run as it happened. Calling the stored routes again, four of the thirty-seven had drifted; three were
re-learned from the page's own calls and answer again, so the reproducible count is **36**:

| Site | Today |
|---|---|
| asos.com | **restored**: re-walked and picked its product search (`e14a8e3d0bc2755c`), `ok: true`, `browser: false`, 1255 ms, `waterproof walking boots` in the answer |
| marriott.com | **restored**: picked `POST /mi/query/phoenixShopSearchPropertiesByDestination` (`06405ed81ef91d37`), `ok: true`, `browser: false`, 2876 ms, `maldives` in the answer |
| wp.pl | **restored**: its page's own search call (`14d68301c996dba7`, `cse/element/v1?…&q=`), `ok: true`, `browser: false`, 507 ms, `krakowie` in the answer |
| makemytrip.com | still out: a plain client cannot reach the site (`curl`: `000`, its home page `403`), so nothing can be learned or replayed |

Six sampled passes still answer: `booking.com` (1048 ms), `google.co.jp` (483 ms), `amazon.co.jp` (1599 ms), `ieee.org`
(2636 ms), `pypi.org` (482 ms), `huawei.com` (379 ms).

## The rest, and what stopped each

A second pass took the eight `browse` cases and the two unrun ones through `unbrowse_walk`: the walk's candidate list
was read, the call that answers the search was picked, kept as a route, and called again with a new value.
`huawei.com` (keyword `router`, then `solar inverter maintenance`) and `foodnetwork.com` (`pasta`, then `gluten free
pancakes`) answered both times with `how: called` and `browser: false`, so they moved to the table's 36.

| Sites | Outcome | Why |
|---|---|---|
| www.google.com (flights) | **passed** (`learned` -> `called`, 1217 ms, `browser: false`, Tokyo fares for the second sentence) | moved up to the table |
| huawei.com, foodnetwork.com | **passed** (`called`, `browser: false`, 322 ms / 1805 ms, value present) | moved up to the table |
| ebay.de | route kept (`GET /sch/i.html?_nkw={_nkw}`): `kaffeemaschine` answered `called`, `browser: false`, 2188 ms, value present **earlier in the run**; every query now fails (`antike wanduhr`, `kaffeemaschine` both `browser: true`, ~1 s) | `curl` with a full navigation-shaped header set answers **403 Error Page** too: the site refuses this network, and it flags this one more as the run goes on |
| ebay.com | route kept (`63ec23462a7652db`): `camera` answered `called` but `browser: true`; `binoculars` fell to `browse`; now `browser: true` in ~1 s | same 403 to `curl` |
| ieee.org | **passed** (`learned` -> `called`, 1746 ms, `browser: false`, `photonics` in the answer) | moved up to the table: the route had sent `accept`, `referer` and `content-type` **twice each** and no page referer at all — see the two fixes below |
| aljazeera.com | its `/search/<word>` page answers **403** to this machine (its front page answers 200), so no walk lands (`mint unresolved (loading)`, six attempts); the stored route came from a walk whose picked call carried `variables={}` | the `SearchQuery` call is **page-signed**: its capture (`learn_ajw.jsonl`) shows `recaptcha-token: 0cAFcWeA…`, `wp-site: aje` and `original-domain` headers, and the graphql answers `Access Denied` to that token now. The binder is not the fault: `learn::tests::a_picked_call_that_carries_the_callers_word_is_a_route_of_its_own` pins that a page reached at `/search/gaza` whose own call puts the word in a `variables` JSON yields a step that keeps the JSON as an input with the word `Held`, and an id the endpoint asked with `variables={}` does not have. Re-picking needs the page, and it answers 403 |
| dailymotion.com | route kept (`POST /v1`, **input `search`, the query in the body**): the plain call answered **500** | the site's own API answers a plain client with its Cloudflare wall |
| loc.gov | **the ClientHello now is Chrome 155's — and the wall stands.** The three RSA-PSS-PSS signature algorithms are in the vendored BoringSSL as advertising-only code points and the transport asks for the browser's exact list; measured on `tls.peet.ws`, JA4 is `t13d1518h2_8daaf6152771_4980c97edce0` for both the minting Chrome and the node, with `ja4_r …_0904,0905,0906,0403,…`. A call carrying the browser's own, freshly harvested `cf_clearance` and that ClientHello still answers **403** ("Just a moment…"), so the clearance is not bound to the signature algorithms | **Cloudflare Turnstile passed in the browser**: `look` showed "Verify you are human", one click on the checkbox let the page through to loc.gov (503 that minute); a later search learned a route | the clearance cannot be spent by the transport. Measured today: the page answers **403** ("Just a moment…") to *both* node transports (`HttpFetch` 5494 b, `ChromeFetch` 5964 b) and to `curl`, while the browser loads it; `cf_clearance` sits in `home/jars/www.loc.gov.json` unused. The one measured difference between our ClientHello and the minting Chrome's is its three RSA-PSS-PSS signature algorithms (`0x0904–0x0906`), which this TLS library has no value for (`SSL_SIGN_*` stops at `RSA_PSS_RSAE`, `0x0806`) and whose name it rejects. The documented fallback is the browser visit the call already makes (`browser: true`) |
| hilton.com | the walk's page says "SOMETHING WENT WRONG" | the site's own error page for this network |
| opentable.sg | the walk's page says "Access Denied" (Akamai, with a reference number) | the site's edge refuses this network |
| sogou.com | `how: browse` | its search page is interactive-only even after the captcha was passed; the clearance does not carry to a new tab |
| bild.de | `learned` once | the case URL has no query placeholder (its search hands the query to an AI chat on hey.bild.de), so there is no second value to replay |
| vivo.com.cn, chase.com | the walk fails, and the bank's own `url_note` says the URL is a 404 page | no search URL was ever observed for these sites |
| service.gov.uk | the name does not resolve (`curl`: 000) | the case's URL is not a site |
| lazada.com | the case's URL answers 404 to a plain client too | the case's URL |
| hbo.com | 403 to a plain client too | the site refuses this network |
| youku.com | gate | the search answers "请验证后继续" with a QR to complete in the Youku app |
| reddit.com | gate | "You've been blocked by network security" |
| bestbuy.com | gate | a country chooser |
| pinterest.com | login wall | "Welcome to Pinterest — log in" |
| mysql.com | the case URL redirects away and loses the query (`curl -L`: `https://www.mysql.com/search/?q=innodb` -> **403** at `https://www.oracle.com/search/results?cat=mysql`); the learned call `POST /api/latest/qsearch` carries `"q":""` and no inputs | the caller's word never reached the site's search, so there was nothing to bind |
| etsy.com, trip.com | learned, called | `browser: true` on the second ask. The page bridge is what answers: it runs the page's scripts in the sandbox first, and for etsy that run makes **4 calls** (a stylesheet, `tags.js`) where the page makes **271** — the app shell never reaches its API in the sandbox — so the bridge visits the page in the node's browser and takes the call from there (`[sign] the page made 271 calls; including one for POST …/listingCards`). `browser: true` is that visit, honestly reported. The harness now **names every descriptor read a page makes of a prototype in one run** (`Object.getOwnPropertyDescriptor` wrapped inside the page's realm, answering from the prototype that holds it) and the set it printed is installed: `Document.defaultView/currentScript/readyState/documentElement/doctype/body/head`, `Range.commonAncestorContainer`, `Request.url`, `Navigator.plugins`, plus `XMLHttpRequest.prototype`'s `readyState/status/statusText/responseText/response/responseURL/responseType/timeout/withCredentials/upload` as accessors over the same fields. The consent script advances from `airgap.js:5:8027` to `s is not a function` at `airgap.js:5:14282`, and the shell still stops at 4 calls. That last one is not a missing intrinsic: airgap captures 51 of them from the global (`Symbol, navigator, fetch, Request, XMLHttpRequest, Blob, CookieStore, cookieStore, …`) and only `SecurityPolicyViolationEvent` and `requestIdleCallback` are undefined in the sandbox's window; `s` is `Function.prototype.call.bind(Function.prototype.call)` at the bundle's top, so the throw names a shadowed binding further in, which needs the bundle's own symbol graph to resolve |

## What the second pass found

- **A real captcha was met and passed in the browser, on a bank site.** `loc.gov` answered Cloudflare's
  "Performing security verification"; `look` showed the spinner, then "Verify you are human" in the Turnstile frame;
  one `click` on the checkbox let the page through to `www.loc.gov` (which answered 503 that minute). A later search
  in that browser learned a route. The plain replay was still refused, which is the clearance not carrying to the
  transport, not the agent failing to solve it.
- **Four cases moved to browserless:** `www.google.com` (flights), `huawei.com`, `foodnetwork.com`, `ieee.org`.
- **IEEE Xplore's 418 was two shape bugs, not its edge.** The walk's capture carries every request twice over — once
  as `requestWillBeSent` and once as its `requestExtra` — and the HAR merged them **case-sensitively**, so a header
  Chrome sent once (`Accept`, `Referer`, `Content-Type`) became two (`Accept` + `accept`), and the route sent each
  twice. Fixed in `walk_har` (one entry per name, as a browser sends) with a test. The route also dropped the page it
  was made from: `referer` and `origin` were treated as the transport's own and replaced with a generic
  `https://host/`; both are now carried as the walk's own words, and a caller's word inside the referer
  (`…/searchresult.jsp?queryText=antenna`) is swapped like any other (`Step::held`). With both fixed the same route
  answers `called`, `browser: false`, 1746 ms, `photonics` in the payload.
- **The transport's shape, measured jaw to jaw.** The minting Chrome (a walk of `https://tls.peet.ws/api/all`):
  `ja4=t13d1518h2_8daaf6152771_4980c97edce0`, 20 extensions, h2 `1:65536;2:0;4:6291456;6:262144|15663105|0|m,a,s,p`.
  `ChromeFetch`: `ja4=t13d1518h2_8daaf6152771_f9a770a73cc2`, same ciphers, same extension ids in the same order, same
  h2 settings and frame order. The one difference is three signature algorithms at the front of Chrome 155's list
  (`0904,0905,0906`, RSA-PSS-PSS): this TLS library has no value for them (`SSL_SIGN_*` stops at `RSA_PSS_RSAE`,
  `0x0806`) and rejects the name, so the ClientHello cannot be made identical here.
- **`aljazeera.com` is not a wall, and not a learner gap either.** Its `/search/<word>` page answered 200 to the
  node's own transport, a shell whose results come from its own `SearchQuery` call. The engine already binds a
  caller's word that sits *inside* a longer value — a `variables` JSON in a query, a JSON body — and a unit test now
  says so (`graph::tests::a_value_in_a_json_body_is_the_callers_input`). The stored route was learned from a walk
  whose picked call carried `variables={}`, and by the last attempt the page itself answered **403** to `curl`: the
  site is refusing this machine after this many walks.
- **The three "body query" cases are not one engine gap.** `dailymotion.com`'s route already carries its query as the
  input `search` (the body binding works) and its plain call is answered 500 by the site's own wall; `mysql.com`'s case
  URL never hands its query to the search at all (the redirect above); `aljazeera.com`'s gap was the pick, not the
  binder.
- **The page-signed path already exists; what it lacks is a sandbox that can drive the page.** `etsy.com`'s route
  carries `page_signed: true` and two recorded producers (`x-detected-locale` from `index.sIPsvrMg.js:2864`,
  `x-recs-primary-location` from `chunk-b-etsylibs.BxUXH9Tl.js:33802`), so the producer was discovered and stored. At
  call time the bridge boots the page's scripts in the sandbox — which makes **4** calls where the page makes **273**,
  the app shell never reaching its API — and then visits the page in the node's browser, where the call is made
  (29128 ms, `browser: true`). Two harness gaps are closed: the DOM library answers `document.implementation` but has
  no `DOMImplementation` constructor (etsy's consent script threw `DOMImplementation is not defined` before the
  page's modules ran), and it holds the getters a vendor reads *through the prototype* on an ancestor prototype
  (`Document.prototype`) where the document's own prototype (`HTMLDocument.prototype`) has no descriptor at all. Every
  prototype in the document's and an element's chain now carries its ancestors' accessors, get and set. The consent
  script still stops on the next descriptor read (`airgap.js:5:8089`) and the shell still makes 4 calls of the page's
  273, so the visit — and `browser: true` — stands. Making that browserless is sandbox fidelity (module/DOM/fetch
  coverage for the site's app shell), not a missing producer. `trip.com` is the same shape.
- **Four cases cannot pass as written.** `vivo.com.cn` and `chase.com` carry the bank's own note that the URL is a
  404 page; `service.gov.uk` does not resolve; `lazada.com`'s URL 404s.
- **Two cases are network refusals.** `ebay.de`, `ebay.com`, `hbo.com`, `opentable.sg`, `reddit.com` refuse a plain
  `curl` from this machine too, and `hilton.com` answers "SOMETHING WENT WRONG".

## What the bank's gates actually were

Probed with the node's challenge primitive before the run: `youku.com` answers a QR/app verification page
(`为确认您是真人，请按照页面提示完成验证`), `reddit.com` a network-security block, `bestbuy.com` a country chooser,
`pinterest.com` a login wall. None of these is a puzzle: there is nothing to look at and answer.

`sogou.com` is the one solvable gate met in the bank: after repeated searches its results page becomes a click-in-order
captcha (`请依次点击【任,应,姜,汤】`, a character image and 提交). The agent read the characters from the screenshot,
clicked them in the requested order, and the page answered `验证成功` (verification successful); the next search in
that browser returned results. Sogou re-gates a new tab, so the clearance did not become a route: its learner answers
`how: browse` for the search page, and the run records it there.

The captcha types the stack does meet (reCAPTCHA v2, hCaptcha, Turnstile, a text challenge) were passed separately and
server-verified on the providers' own demo pages, not in this bank.

`asks` was true on `google.co.jp`, `pinterest.com` and `nowsecure.nl` for widgets that are not challenges (a Google
sign-in frame, a Pinterest sign-in frame, and a page that draws a picture of a Turnstile): the detector errs toward
"look", and the agent's look settles it. After this run the page's own words count too (`captcha`, `验证码`, "verify
you are human", "slide to verify", "human verification"), which is what makes the Sogou page read `asks: true`.

## Where the next session picks this up (2026-11-11)

**Numbers.** 37 answered browserlessly in the run; **36 reproduce today** (`makemytrip.com` cannot be reached from
this network at all: `curl` 000, its front page 403). The other 22 and their causes are in the two tables above.

**Engine work done and pinned by tests** (all on `feat/doors-sharing-2026-11-08`):

| Fix | Test |
|---|---|
| a request's headers are one entry per name (the walk's `requestWillBeSent` + `requestExtra` were merged case-sensitively, so `accept`/`referer`/`content-type` went out twice) | `a_requests_cookies_are_kept_as_sent` |
| the page a call was made from rides with it (`referer`, `origin`), and a caller's word inside it is swapped | `the_page_a_call_was_made_from_rides_with_it` |
| a page is asked for as a page, not as the script fetch its shape came from | `a_page_is_asked_for_as_a_page` |
| a caller's word in a POST JSON body, and inside a JSON in a query (`Held`) | `a_value_in_a_json_body_is_the_callers_input`, `a_word_inside_a_json_in_a_query_is_the_callers_word` |
| a picked call that carries the caller's word is a route of its own | `a_picked_call_that_carries_the_callers_word_is_a_route_of_its_own` |
| `DOMImplementation` on the page's window | `a_page_that_asks_for_a_dom_implementation_gets_one` |
| DOM descriptors read through a prototype (get **and** set) | (covered by the etsy runs; see below) |
| the XHR answer's properties as prototype accessors | `a_page_that_wraps_the_xhr_answer_finds_its_accessors` |
| a stylesheet the page inserts answers its `load` | `a_stylesheet_the_page_inserts_answers_its_load` |
| the transport's ClientHello is Chrome 155's, RSA-PSS-PSS sigalgs included (`JA4 t13d1518h2_8daaf6152771_4980c97edce0` for both) | `examples/tls_probe.rs` |

**Open threads, most promising first.**

1. **trip.com** — the sandbox now runs the page far enough to make the flight search itself: `17 → 34` calls, reaching
   `POST /restapi/soa2/27015/FlightListSearch` and `FlightListSearchSSE`. The stored route `e5352e8b435279ff` targets
   `CityDataSearch` (a city-name call), so it heals. Next: walk `https://www.trip.com/flights/showfarefirst?dcity=bjs&acity=sin&ddate=2027-06-01`,
   pick the `FlightListSearch` candidate, call with `dcity=sha`, and require `ok: true`, `browser: false`. The walk
   returned 0 candidates on three attempts (`/v1/walk` 200, empty list) — try again later or with a warm profile.
2. **etsy.com** — sandbox 4 of the page's 271 calls; the consent SDK stops at `s is not a function @ airgap.js:5:14282`
   (a *shadowed local binding*: the module's own `s` is `Function.prototype.call.bind(Function.prototype.call)`, so
   there is no global to install). The descriptor/XHR/DOMImplementation classes are closed. Behind it: a 101-script app
   shell to hydrate. This is a compatibility programme, not a patch.
3. **aljazeera.com** — `/search/<word>` answers 403 to this machine (front page 200), and the `SearchQuery` call is
   page-signed (`recaptcha-token` per load). The binder is fine (test above).
4. **loc.gov** — closed by measurement: JA4 identical to the minting Chrome, the jar holds the browser's live
   `cf_clearance`, and Cloudflare still answers 403 "Just a moment…". Only a different network (or Cloudflare's own
   trust) changes it.
5. **sogou.com** — the walk yields a 2 143-byte verification page plus hot-word/ad calls; nothing to bind.
6. **makemytrip.com** — retry when the host answers (`curl` 000 / 403 today), then re-walk and pick its hotel listing.
7. **External, needs the owner:** network refusals (ebay.de/com, hbo.com, opentable.sg, reddit.com, hilton.com,
   makemytrip.com), unusable case URLs (vivo.com.cn, chase.com, service.gov.uk, lazada.com, mysql.com, bild.de), and
   login/app walls (pinterest.com, bestbuy.com, youku.com).

**Running it.** The scratch node used for all of this is at `/tmp/unbbank` (port 7796,
`UNBROWSE_HOME=/tmp/unbbank/home`, binary `/tmp/unbmore-node`, browser `/tmp/unbmore-browser`, agent key in
`/tmp/unbbank/token`). Calls are hand-driven: `POST /v1/do`, `POST /v1/walk` (+`pick`), `POST /v1/routes/{id}/call`,
`POST /v1/challenge` for a door. Route ids and their second-value timings are in the table at the top.

**Two cautions.** `vendor/btls-sys` is gitignored and locally patched for the RSA-PSS-PSS code points (a fresh checkout
does not have it; `http.rs` falls back to the unpatched shape once per process, via `SIGALGS_HELD`). And the sandbox
tests boot a Node child each: in parallel on a loaded machine three or four of them time out — run them one at a time
before believing a failure.
