# How it works

Unbrowse turns a website you browse into a direct API call any agent can replay without a browser. One engine runs the whole flow in five steps:

```
mint    ->  walk      ->  trace       ->  route          ->  call
browse      record        build the       save a plain,      replay over
once, in    requests +    dependency      reusable JSON      browser-shaped
process     responses     graph           recipe             HTTP
```

1. **Mint.** The node launches Chromium in-process via `agent-browser-core`, attaches over Chrome DevTools Protocol (CDP), opens the page, lets it settle, and captures the session cookies and tokens the site issued. Per-site browser profiles make subsequent visits cheaper.
2. **Walk.** Because capture subscribes *before* navigation begins, every single request and response — starting with the document itself — is recorded with its method, URL, status, headers, and body.
3. **Trace.** The capture log is paired into a structured `Trace`. The learner identifies which exchange answered the goal, traces where every header, cookie, and body parameter came from (a constant, an earlier setup call, your session, or your input), and drops front-door probes and tracking pings.
4. **Route.** The winning dependency graph is saved as a **route**: an HTTP method, a URL template with caller inputs as named holes (for example `/search?q={q}`), required setup steps, headers, and the expected response shape. A route is pure data — never code and never a cached response.
5. **Call.** On every future call, the node fills the caller's inputs, injects any required session cookies from the local jar, and replays the request over a Chrome-shaped TLS (BoringSSL) and HTTP/2 transport. The website returns clean JSON directly. No browser launches.

Learning costs one browser walk (a few seconds). Every call after that costs one HTTP request (tens to hundreds of milliseconds).

## Why the browser engine is linked, not a daemon

The node links `agent-browser-core` directly as a Rust library (`unbrowse-node/crates/browser`) rather than talking to an external browser daemon over a socket. Driving a separate daemon created a whole class of bugs — stale processes, stale environment variables, leaked sessions across restarts, and missed early frame setup. Linking the engine eliminates the entire bug class at the boundary ([AGENTS.md](../../AGENTS.md)).

## Two ways an agent uses Unbrowse

- **`unbrowse do "<goal>" --url <page>`** — The primary path. The node checks its own routes first, then checks the peer index for a proven route on that site, and otherwise walks the page once to learn a new route. You get structured JSON back. Running your own or cached routes is free; fetching another contributor's route from the index pays its fee once in USDC (and automatically buys and locks a stake in that route for you).
- **`unbrowse browse <command…>`** — When a task requires multi-step clicks, forms, or signing in, the agent drives the node's browser step by step. Every action is captured so that what needed a browser today becomes a direct route tomorrow.

Always go **through the node** rather than an outside browser: only traffic observed by the node becomes a reusable route.

## When a website changes

Websites drift. When a saved route stops returning valid data, the node re-walks the starting page, rebuilds the route from fresh traffic, and retries. If no shared copy on the network works either, the agent falls back to the browser and learns the updated call — making relearning the network's natural redundancy (spec R7.17).

## Passing bot walls honestly

Sites inspect three layers before answering:
1. **Request shape** (`accept`, `accept-language`, `sec-fetch-*`, `referer`).
2. **Session** (clearance cookies and tokens minted during the walk).
3. **TLS & HTTP/2 handshake** (Chrome-matched JA4 ClientHello via patched BoringSSL, HTTP/2 settings, and matching User-Agent).

Gates are detected dynamically from each walk's own traffic (`Trace::door`) — never hardcoded by site or vendor name. Challenges an agent can solve visually use `unbrowse_challenge`; logins or 2FA checks that require a person hand off cleanly to the app's **Browser** screen (`ask_owner`). A wall that still holds is reported honestly as `blocked`.

## In the code today

**Built:**
- The five-step pipeline: `mint()` and `walk_har()` in `unbrowse-node/crates/browser/src/session.rs`; `build()` (`graph.rs`) and `RouteClient` (`client.rs`) in `unbrowse-node/crates/learn`; orchestration in `unbrowse-node/app/src/learn.rs` and `run.rs`.
- Interactive browser capture: `unbrowse-node/app/src/browse.rs`.
- Route-staking settlement and ranking integration: `unbrowse-node/app/src/chain/coins.rs` and `rank/coin.rs`.

**Differences & gaps:**
- Values computed dynamically by page JavaScript are tagged `browser` and computed in the caller's browser at call time (`recipe::Source`) rather than via a standalone script sandbox.
- A `robots.txt` parser exists (`crates/learn/src/robots.rs`) but is not yet wired into the learning path (spec R2.12, R4.32).

Next: [Three parties, one node](the-node.md) · Full system map: [ARCHITECTURE.md](../ARCHITECTURE.md).
