# Architecture — Agentic Browdie 🧁

> A single-process Zig HTTP server that brokers browser automation through the Chrome DevTools Protocol (CDP).

---

## Table of Contents

- [Boot Sequence](#boot-sequence)
- [High-Level Data Flow](#high-level-data-flow)
- [Module Map](#module-map)
  - [src/main.zig](#srcmainzig)
  - [src/server/](#srcserver)
  - [src/bridge/](#srcbridge)
  - [src/cdp/](#srccdp)
  - [src/snapshot/](#srcsnapshot)
  - [src/crawler/](#srccrawler)
  - [src/storage/](#srcstorage)
  - [src/test/](#srctest)
  - [js/](#js)
  - [build.zig](#buildzig)
- [HTTP API Endpoints](#http-api-endpoints)
- [Threading & Concurrency Model](#threading--concurrency-model)
- [Memory & Lifetime Model](#memory--lifetime-model)
- [Known Risks & Gaps](#known-risks--gaps)

---

## Boot Sequence

```
main() (main.zig:7)
  │
  ├─ 1. GeneralPurposeAllocator init         (main.zig:8)
  ├─ 2. config.load() — env-based config     (main.zig:12)
  ├─ 3. ChromeLauncher.init() + start()       (main.zig:18, :27)
  │     └─ fallback: if launch fails, use port 9222
  ├─ 4. Bridge.init() — shared state          (main.zig:34)
  └─ 5. router.run() — bind, listen, serve    (main.zig:38, router.zig:21)

  deferred shutdown (LIFO):
    bridge.deinit → chrome.deinit → allocator.deinit
```

The server can operate in two Chrome modes:
- **Managed**: launches Chrome itself via `ChromeLauncher`
- **External**: connects to an existing Chrome instance via `CDP_URL` env var

---

## High-Level Data Flow

```
HTTP Client
    │
    ▼
┌──────────────────┐
│  router.zig      │  thread-per-connection, keep-alive loop
│  (path dispatch) │
│  + auth middleware│
└────────┬─────────┘
         │
         ▼
┌──────────────────┐
│  bridge.zig      │  shared state (RwLock-guarded maps)
│  tabs, snapshots, │  tabs · cdp_clients · har_recorders
│  ref_caches      │  snapshots · prev_snapshots
└────────┬─────────┘
         │
         ▼
┌──────────────────┐
│  cdp/client.zig  │  sync request/response over WebSocket
│  cdp/websocket   │  frame-level transport (RFC 6455)
│  cdp/protocol    │  CDP method constants & types
└────────┬─────────┘
         │
         ▼
    Chrome (CDP)
```

---

## Module Map

### `src/main.zig`

**Role**: Entry point — boots config, launcher, bridge, router.

| Symbol | Line | Purpose |
|--------|------|---------|
| `main` | 7 | Entry; orchestrates init/deinit sequence |

Error handling: launcher failure is non-fatal (falls back to port 9222). Server can start in a degraded state without Chrome.

---

### `src/server/`

#### `router.zig` (1230 lines, 272 symbols)

The **largest and most critical file** — HTTP server, request dispatcher, and handler implementations all live here.

- **Threading**: `std.Thread.spawn` per accepted connection, detached (router.zig:29)
- **Keep-alive**: per-connection loop processes multiple requests (router.zig:52)
- **Auth**: global middleware gate before routing — constant-time `Authorization` header compare (middleware.zig:6)
- **Routing**: path-only dispatch; HTTP method is **not checked** (any method hits any endpoint) (router.zig:70)
- **Per-request arena**: each request gets its own `ArenaAllocator` for zero-leak handler memory

#### `middleware.zig` (34 lines)

Constant-time auth token comparison. Called by router before dispatch.

#### `response.zig` (28 lines)

HTTP response helpers — `sendJson`, `sendError`, status codes.

---

### `src/bridge/`

#### `bridge.zig` (231 lines, 27 symbols)

**Central shared state** — the glue between router and CDP.

```zig
Bridge {
    allocator,
    config,
    mutex: RwLock,

    // All guarded by mutex:
    tabs:            StringHashMap(TabInfo),
    cdp_clients:     StringHashMap(*CdpClient),
    har_recorders:   StringHashMap(*HarRecorder),
    snapshots:       StringHashMap(RefCache),
    prev_snapshots:  StringHashMap([]const u8),
}
```

Key operations:
- `putTab` / `removeTab` — tab lifecycle management
- `getCdpClient` — returns pointer to existing or newly-created CDP client for a tab
- `getHarRecorder` — same pattern for HAR recording

#### `config.zig` (44 lines, 9 symbols)

Environment-based configuration: `CHROME_PATH`, `CDP_URL`, `PORT`, `AUTH_TOKEN`, timeouts.

---

### `src/cdp/`

The CDP stack is layered:

```
actions.zig   ─── high-level CDP actions (click, type, etc.)
    │
client.zig    ─── sync request/response, id correlation
    │
websocket.zig ─── RFC 6455 framing, masking, ping/pong
    │
protocol.zig  ─── method constants, message types
```

#### `websocket.zig` (350 lines, 53 symbols)

Full WebSocket client implementation:
- Frame parsing with opcode handling (text, binary, ping, pong, close)
- Client-side masking per RFC 6455
- 10-second socket receive timeout
- No reconnect/backoff strategy

#### `client.zig` (152 lines, 25 symbols)

- `CdpClient.send()` (client.zig:49) — synchronous send + receive loop
- Correlates responses by `"id"` field string scan (client.zig:81)
- Drops non-matching messages/events silently
- Atomic request ID counter, but no send/receive mutex

#### `protocol.zig` (73 lines, 25 symbols)

CDP method string constants (`Methods.Page.navigate`, `Methods.DOM.getDocument`, etc.) and basic response types.

#### `har.zig` (221 lines, 22 symbols)

HAR (HTTP Archive) recording:
- Struct-based HAR 1.2 format builder
- `startRecording` / `stopRecording` / `getHar` lifecycle
- Event capture pipeline is **incomplete** — `capture` exists but is not fed by CDP network events at runtime

#### `stealth.zig` (30 lines, 8 symbols)

Embeds `js/stealth.js` via `@embedFile`. Provides anti-detection script injection. **Not wired into runtime command flow.**

#### `actions.zig` (36 lines, 7 symbols)

High-level CDP action helpers (click, type, focus). Thin wrappers over `client.send()`.

---

### `src/snapshot/`

#### `a11y.zig` (149 lines, 19 symbols)

Builds accessibility tree snapshots from CDP's `Accessibility.getFullAXTree`:
- Flattens AX tree into a list of `{ref, role, name, value, ...}` nodes
- Assigns short refs (`e0`, `e1`, ...) for LLM-friendly token economy
- Maps `ref → backend_node_id` into bridge's `RefCache`

#### `diff.zig` (108 lines, 17 symbols)

Snapshot change detection:
- Identity key: `backend_node_id` (stable across snapshots)
- Compares `role`, `name`, `value` fields
- `ref` and `depth` do **not** affect change detection
- Produces `added` / `removed` / `changed` diff output

#### `ref_cache.zig` (52 lines, 9 symbols)

Reference cache mapping `ref string → backend_node_id`. Mostly used in test utilities; runtime uses `Bridge.RefCache` (bridge.zig:15).

---

### `src/crawler/`

> ⚠️ **Status: Scaffolded, not wired into runtime.**

| File | Lines | Purpose |
|------|-------|---------|
| `pipeline.zig` | 22 | Crawl pipeline orchestrator (stub) |
| `fetcher.zig` | 72 | HTTP fetcher with retry/rate-limit config |
| `extractor.zig` | 18 | Content extraction; embeds `readability.js` |
| `markdown.zig` | 170 | HTML-to-markdown converter |
| `validator.zig` | 106 | URL/content validation utilities |

No module in `crawler/` is imported or called from `main.zig` or `router.zig`.

---

### `src/storage/`

> ⚠️ **Status: Config/utility stubs, unwired in runtime.**

| File | Lines | Purpose |
|------|-------|---------|
| `kafka.zig` | 47 | Kafka producer config struct |
| `local.zig` | 45 | Local filesystem storage |
| `r2.zig` | 28 | Cloudflare R2 object storage config |

Note: The `/storage/*` HTTP endpoints in `router.zig` operate on **browser localStorage/sessionStorage** via CDP `Runtime.evaluate`, not these backend storage modules.

---

### `src/test/`

#### `harness.zig` (174 lines, 34 symbols)

Test utilities: mock allocators, fake CDP responses, test bridge setup.

#### `integration.zig` (458 lines, 107 symbols)

Integration tests covering:
- ✅ Bridge map semantics (put/get/remove tabs)
- ✅ Snapshot diff/cache logic
- ✅ Crawler markdown/validator utilities
- ✅ Helper/utility code

**Gaps**:
- ❌ No `main()` boot lifecycle tests
- ❌ No end-to-end router → CDP flow tests
- ❌ No real WebSocket transport tests
- ❌ No concurrency/race condition tests

---

### `js/`

#### `readability.js` (73 lines)

Mozilla Readability-based content extraction. Injected into Chrome pages via `Runtime.evaluate` for article/content parsing.

#### `stealth.js` (66 lines)

Anti-bot-detection patches:
- Overrides `navigator.webdriver`
- Patches `navigator.plugins`, `navigator.languages`
- Modifies Chrome runtime fingerprint

Both files are embedded into the Zig binary at compile time via `@embedFile`.

---

### `build.zig`

```zig
// build.zig:8 — single executable target
// build.zig:29 — test step
```

- Single executable target (`agentic-browdie`)
- JS files embedded via `@embedFile` (no separate JS build step)
- Test step runs all `src/test/*.zig` files
- Dependencies declared in `build.zig.zon`

---

## HTTP API Endpoints

All endpoints are **method-agnostic** (GET/POST/PUT/DELETE all work).

| Path | Handler | Description |
|------|---------|-------------|
| `/health` | healthCheck | Server health status |
| `/tabs` | listTabs | List connected browser tabs |
| `/discover` | discoverTabs | Discover available Chrome tabs |
| `/navigate` | navigate | Navigate a tab to a URL |
| `/snapshot` | getSnapshot | Get accessibility tree snapshot |
| `/diff/snapshot` | diffSnapshot | Diff two snapshots for changes |
| `/action` | performAction | Execute action on a snapshot ref (click, type, etc.) |
| `/evaluate` | evaluate | Execute arbitrary JS in tab |
| `/har/start` | startHar | Begin HAR recording |
| `/har/stop` | stopHar | Stop HAR recording |
| `/har/get` | getHar | Retrieve recorded HAR data |
| `/cookies` | getCookies | Get browser cookies |
| `/cookies/set` | setCookies | Set browser cookies |
| `/storage/local` | getLocalStorage | Get tab's localStorage |
| `/storage/session` | getSessionStorage | Get tab's sessionStorage |

---

## Threading & Concurrency Model

```
Main Thread
  └─ accept() loop
       └─ spawn detached thread per connection
            └─ keep-alive request loop
                 ├─ auth check (middleware)
                 ├─ path dispatch (router)
                 ├─ handler: acquires Bridge RwLock
                 │    └─ sends CDP command (synchronous)
                 └─ response written
```

- **One RwLock** guards all shared state in Bridge
- No connection pooling or work-stealing
- CDP client `send()` is synchronous and blocking per-request
- No timeout enforcement on CDP responses beyond socket-level 10s

---

## Memory & Lifetime Model

- **Per-request arena**: each HTTP request handler gets an `ArenaAllocator`, freed after response
- **Bridge-owned state**: tabs, CDP clients, HAR recorders persist across requests
- **RefCache**: snapshot refs are duped into bridge allocator; cleared on next snapshot
- **@embedFile**: JS scripts are compile-time constants, zero runtime allocation

---

## Known Risks & Gaps

### Concurrency Hazards

1. **Pointer-after-unlock**: `getCdpClient()` / `getHarRecorder()` return pointers used after RwLock release. Concurrent `removeTab()` can invalidate them.
2. **CDP client races**: atomic request IDs but no send/receive mutex — concurrent use of the same `CdpClient` can interleave messages.
3. **Method-agnostic routing**: any HTTP method matches any endpoint, which can produce unintended behavior.

### Memory Safety

4. **Snapshot diff lifetime**: `prev_snapshots` can receive arena-backed data from request scope (router.zig:1153). If arena frees before next diff, use-after-free.
5. **RefCache key duplication**: repeated duped keys across bridge-router lifecycle can leak if not properly freed.

### Feature Completeness

6. **HAR recording**: endpoints exist but CDP network event capture is not implemented — HAR data will be empty.
7. **Stealth injection**: embedded but not called in any runtime path.
8. **Crawler pipeline**: fully scaffolded, zero runtime integration.
9. **Storage backends**: kafka/r2/local exist as types only.

### Testing

10. **No end-to-end tests**: router → CDP → Chrome flow is untested.
11. **No concurrency tests**: race conditions in bridge/snapshot path are not validated.
12. **Degraded startup**: server can start and serve requests even if Chrome failed to launch.
