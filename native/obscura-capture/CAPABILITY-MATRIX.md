# Can obscura replace Chrome + kuri entirely?

Evidence-based answer, from live probes against obscura v0.1.11 and from obscura's own source.
Short version: **yes for everything unbrowse's route-learning moat needs, with exactly two
permanent exceptions — pixels and a focus model.** Those cannot be "ripped out of Chrome and
integrated"; one of them *is* a browser.

## The two hard limits (not gaps we can close)

### 1. Pixels — screenshot / PDF. Impossible, by obscura's design.

`crates/obscura-cdp/src/domains/page.rs:527-535` refuses `Page.captureScreenshot` /
`captureSnapshot` / `printToPDF` in its own words:

> rasterising a page needs a layout and paint pipeline that Obscura intentionally does not have.
> […] keep a real browser for the screenshot leg of your pipeline and use Obscura for the
> scraping leg.

obscura parses HTML into a DOM and runs JS in V8. It never lays out boxes and never paints. So
there is no image to capture — not a missing API, an absent subsystem. "Ripping out" Chrome's
paint pipeline is not a port; a layout+raster engine is the expensive half of a browser.

**Consequence:** `eval screenshot` and any visual-verification path require a real browser.
That is the one place unbrowse must keep a Chrome (or drop the capability).

### 2. Focus — `breath type`. No focused-element model.

Probed live: obscura rejects a `:focus` selector (`Error: Element not found: :focus`), and
`el.focus()` followed by `document.activeElement` yields nothing. `breath type` means "type into
whatever holds focus", so it has no faithful mapping. `src/cli-v7/breath/type.ts` therefore
**refuses** on this backend with `unsupported_on_obscura:breath_type`, naming the alternative that
does work (`breath fill <selector|eN>`), and `cli-e2e-gate.sh` asserts that refusal so it cannot
rot into a silent no-op.

This one is closeable upstream (obscura could implement `activeElement`), unlike pixels.

## What obscura DOES cover — verified, not assumed

| Need | Chrome/CDP today | obscura | Verified by |
|---|---|---|---|
| navigate | `Page.navigate` | `browser_navigate` | cli-e2e-gate |
| page text | `Runtime.evaluate` | `browser_evaluate` | cli-e2e-gate (621 bytes) |
| markdown | evaluate + turndown | same expression via obscura V8 | cli-e2e-gate |
| element refs | `Accessibility.getFullAXTree` | `browser_interactive_elements` (`ref=eN`) | cli-e2e-gate (7 refs) |
| click | `DOM.getBoxModel` + `Input.dispatchMouseEvent` | `browser_click` (by selector **or** ref) | cli-e2e-gate |
| fill | `DOM.focus` + `Input.insertText` | `browser_fill` (selector **or** ref) | cli-e2e-gate (read back from the page) |
| select | `Runtime.callFunctionOn` | `browser_select_option` | live probe (`value: b`) |
| press key | `Input.dispatchKeyEvent` | `browser_press_key` | cli-e2e-gate |
| scroll | `Input.dispatchMouseEvent` wheel | `browser_scroll` | cli-e2e-gate |
| submit | `Runtime.evaluate` | same expression via obscura V8 | cli-e2e-gate |
| history | `/v1/browse/{back,forward}` (kuri) | `browser_back` / `browser_forward` | cli-e2e-gate (returned to /login) |
| cookies (read) | `Network.getCookies` | `browser_get_cookies` / `--dump cookies` | cli-e2e-gate |
| cookies (inject) | `Network.setCookie` into a tab | `cookies.json` jar (`--storage-dir`) | gate.sh W2 |
| route capture | `Network.requestWillBeSent/responseReceived/getResponseBody` | `on_request`/`on_response` **with bodies** | gate.sh W1 |
| preload script | `Page.addScriptToEvaluateOnNewDocument` | `add_preload_script` | obscura crate API |
| interception | `Fetch.*` | `enable_interception()` | obscura crate API |
| anti-bot TLS | vendored Go `utls-proxy` | `--stealth` (wreq/BoringSSL), built in | obscura release |
| session across CLI calls | persisted `chromeWsUrl` + Chrome pid | `obscura mcp --http` broker + pid | broker-gate |
| **screenshot / PDF** | `Page.captureScreenshot` | **impossible** (no paint engine) | obscura source |
| **type into focus** | `Input.insertText` | **absent** (no focus model) | live probe |
| scroll-triggered lazy load | wheel events | `browser_scroll` — **site-dependent** | live probe: drove `offset=0→10→20→30` on scrapingcourse; silent on quotes.toscrape |

## What still imports Chrome, and why it isn't "just delete it"

The two npm deps are confined to **two files**: `chrome-remote-interface` in
`src/cdp/connection.ts`, `@puppeteer/browsers` in `src/cdp/chrome.ts`. Everything else reaches
Chrome *through* them. They can only be dropped when no path needs a real browser.

Still Chrome-bound on the NON-obscura path (the CLI itself no longer needs CDP — see below):

- **`eval screenshot`** — permanently, per limit 1.
- **`src/capture/index.ts`** (3,020 LOC) — the kuri+raw-CDP capture engine. Its *replacement*
  exists and is wired (`captureAndIndexViaObscura`, selected by `UNBROWSE_BROWSER_BACKEND=obscura`
  at `executeBrowserCapture`), but the legacy engine still backs the non-obscura path.
- **`src/kuri/client.ts`** (2,543 LOC, ~70 ops) + `src/api/browse-session.ts` (792) — the server
  `/v1/browse/*` surface. The obscura broker is the like-for-like replacement, but rehosting the
  server session registry on it is its own migration.
(`auth-capture` / `proxy-rotate` / `session-park` / `session-restore` / `fill-form` were listed
here as unwired; they are now wired or refusing — see the status section below.)

## Status: the CLI no longer *needs* CDP

`native/obscura-capture/no-cdp-gate.sh` is the witness. Of the **19** CLI handlers that import
`src/cdp`, every one now has an obscura path:

- **16 wired** — go, click, fill, fill-form, press, select, scroll, submit, close, back, forward,
  session-park, session-restore, proxy-rotate, plus eval text/markdown/cookies/snap.
- **3 documented refusals** — `eval screenshot` (no paint engine), `breath type` (no focus model),
  `breath auth-capture` (no UI for an interactive login). Each fails loudly with
  `unsupported_on_obscura:*` and names the alternative; none fails silently.
- **0 unhandled.**

The gate is proven capable of failing: stripping the obscura branch from one handler flips it to
exit 1 naming that file. It is wired into `rest-gate.sh`, so a future handler that reaches for CDP
without an obscura path turns the release gate red.

Two notes on the newly-wired ones:

- **`breath fill-form` uses per-slot `browser_fill`, not obscura's batch `browser_fill_form`.** The
  batch call would need every slot's plaintext in memory simultaneously, breaking that file's
  contract of one value in scope at a time, zeroed immediately. Correctness beat convenience.
- **`breath proxy-rotate` is actually *better* on obscura.** Chrome rejects embedded credentials in
  `--proxy-server` and needs a `Fetch.continueWithAuth` wiring that was never landed; obscura's
  `--proxy` takes a full URL, so the country-locked credentials ride in it and the rotated egress
  genuinely authenticates. Creds stay in-process and never reach the envelope.

## Honest verdict

"Replace kuri and all browsers entirely with obscura" is achievable for the **scraping and action
layer** — that is now wired and witnessed. It is *not* achievable for the **pixel layer**, and no
amount of primitive-porting changes that: keeping a real browser for screenshots is obscura's own
recommendation. The remaining work is a sizeable but ordinary migration (≈6,400 LOC across the
capture engine, the kuri client, and the server browse session), not a research problem.
