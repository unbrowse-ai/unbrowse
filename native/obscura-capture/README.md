# obscura backend — Chrome-free browsing for unbrowse

Replaces unbrowse's dependency on **Chrome + CDP** with [obscura](https://github.com/h4ckf0r0day/obscura),
a from-scratch Rust browser engine (its own DOM, its own V8 embed via `deno_core`,
its own TLS stack). unbrowse uses obscura's **native primitives** — not its
CDP-compatibility server — so no Chrome binary is downloaded, launched, or driven,
and no CDP WebSocket is opened.

## Why obscura fits

unbrowse's capture engine (`src/capture/index.ts`) learns a site's internal API
routes from real browsing using exactly four CDP primitives. Each maps 1:1 onto
an obscura native primitive:

| unbrowse capture need | CDP primitive (today) | obscura primitive |
|---|---|---|
| install a fetch/XHR recorder before page scripts | `Page.addScriptToEvaluateOnNewDocument` | `page.add_preload_script` |
| observe every request | `Network.requestWillBeSent` | `page.on_request` |
| observe every response | `Network.responseReceived` | `page.on_response` |
| read response bodies | `Network.getResponseBody` | `on_response` carries `resp.body` |
| inject auth from another browser | `Network.setCookie` into a live tab | obscura `cookies.json` jar (`CookieStore::load_from_file` / `--storage-dir`) |
| anti-bot TLS fingerprint | vendored Go `utls-proxy` sidecar | obscura `--stealth` (wreq/BoringSSL, built in) |

Note obscura's passive callbacks expose the **response** body but not the request
body; `request_body` is therefore absent on captured rows. That only affects
POST-with-payload endpoints — the GET/collection routes the admission gate
(`admitCandidate`: GET, 2xx, collection) actually indexes are fully captured.
Request-body capture is available via obscura's `enable_interception()` channel
and can be layered in later.

## What ships here

- **`obscura-capture`** (this crate) — the route-learning sidecar. Embeds the
  `obscura` crate, registers `on_request`/`on_response`, navigates, and streams
  captured request/response pairs (with bodies) as NDJSON. Loads a cookies.json
  for auth injection. Never launches Chrome; never opens a CDP socket.
- **`src/capture/obscura-capture.ts`** — parses the sidecar NDJSON into unbrowse's
  exact `RawRequest[]` shape and spawns the sidecar (`runObscuraCapture`). Output
  flows into the existing `revengLocal` / `revengServerFirst` / `cacheBrowseRequests`
  pipeline unchanged.
- **`src/auth/obscura-jar.ts`** — converts the cookies unbrowse already rips from
  the user's *other* real browsers (`src/auth/browser-cookies.ts`) into obscura's
  on-disk jar. The one subtlety it owns: obscura's format is **camelCase**
  (`httpOnly`, `sameSite`) with SameSite title-cased to `{Strict,None,Lax}`; a
  snake_case key is silently dropped by obscura's loader.
- **`src/obscura/resolve-bin.ts`** — locates the `obscura` and `obscura-capture`
  binaries (env override → next-to-exe → vendored tree → PATH), mirroring
  `src/kuri/resolve-paths.ts`.
- **`gate.sh`** — the two-witness gate (below).

## Build

Non-stealth (default) needs only a C compiler; obscura's V8 comes prebuilt via
`rusty_v8` (no ninja/gn). Stealth additionally needs CMake + libclang for BoringSSL.

```bash
cd native/obscura-capture
cargo build --release          # -> target/release/obscura-capture  (~2.5 min first build)
```

The `obscura` CLI/MCP engine (for render / interaction / stealth TLS) is the
prebuilt release binary: https://github.com/h4ckf0r0day/obscura/releases

## Gate (two witnesses, fail-closed)

```bash
OBSCURA_CAPTURE_BIN=native/obscura-capture/target/release/obscura-capture \
OBSCURA_BIN=/path/to/obscura \
bash native/obscura-capture/gate.sh
```

- **W1 route capture** — captures `quotes.toscrape.com`'s internal `/api/quotes`
  JSON API (fired as an in-page XHR) with a collection-shaped body.
- **W2 auth injection** — a cookie "ripped from another browser", written in
  obscura's jar shape, reaches the origin through obscura.

Exit 0 only if both pass. Unit + pipeline tests:
`bun test tests/obscura-jar.test.ts tests/obscura-resolve-bin.test.ts tests/obscura-capture-integration.test.ts`.

## Migration status — the rest of the CDP surface

unbrowse drives a page four ways today (see the inventory in the oneshot report).
This backend replaces the **capture** path end to end. The remaining live-page
interaction handlers still call `src/cdp/` / `src/kuri/` and are the follow-on:

- **Capture** (`captureSession` → `revengLocal`): **replaced** by `runObscuraCapture`. ✅
- **Auth injection** (`importBrowserCookiesIntoTab`): **replaced** by `writeObscuraJar`. ✅
- **Interaction** — 18 `breath` handlers (`click/fill/type/press/select/scroll/submit/go`)
  and 5 `eval` readers (`snap/text/markdown/screenshot/cookies`): map onto obscura's
  MCP tools (`browser_click/fill/type/press/select/scroll/snapshot/markdown/…`) or
  the sidecar's element API. Not yet rewired.

Only when all four page-driving paths are migrated can the two hard deps —
`chrome-remote-interface` (`src/cdp/connection.ts`) and `@puppeteer/browsers`
(`src/cdp/chrome.ts`) — be dropped from the bundle.
