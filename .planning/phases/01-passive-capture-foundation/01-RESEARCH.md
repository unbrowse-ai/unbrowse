# Phase 1: Passive Capture Foundation - Research

**Researched:** 2026-04-01
**Domain:** Browser network interception — kuri CDP bridge, Chrome extension webRequest API, passive traffic observation
**Confidence:** HIGH

---

## Summary

Phase 1 replaces unbrowse's active (navigate-to-capture) model with a passive one: every network API call made by the real browser is automatically observed and recorded with response bodies, with no explicit capture step. The core integration point is kuri's builtin extension (`submodules/kuri/js/extensions/kuri-builtin/`), which already uses `chrome.webRequest` to observe all traffic in a background service worker. The problem is twofold: (1) `chrome.webRequest` gives URLs, headers, and status — but not response bodies (a fundamental MV3 API limitation); and (2) the current `captureSession` flow in `src/capture/index.ts` injects the JS interceptor after navigation, missing early SPA hydration calls.

The solution for response bodies is the existing JS interceptor, injected early via `kuri.scriptInject` — which maps to `Page.addScriptToEvaluateOnNewDocument`. The `kuri.scriptInject` function already exists in `src/kuri/client.ts` at line 788 and is simply not called in `captureSession`. Wiring it in before the first navigate resolves the timing race entirely.

The extension-to-unbrowse data flow: `background.js` stores webRequest data in-memory and exposes it via `chrome.runtime.onMessage` responding to `kuri:getRequests`. However, `content.js` installs a stub `window.chrome.runtime` that is a no-op — it does NOT relay messages to the service worker. The extension data is therefore not directly accessible from page context via `kuri.evaluate`. This is an open architecture gap for Phase 1; scriptInject + existing interceptor is the primary fix.

**Primary recommendation:** Call `kuri.scriptInject(tabId, INTERCEPTOR_SCRIPT)` once per tab after tab creation (before any navigation). Remove the 50ms re-injection polling loop. This is a single-function-call change that fixes the timing race (PASSIVE-01). For PASSIVE-02 (extension integration), the webRequest data provides URL+headers supplement; body capture continues via the JS interceptor. Coordinate with Rach on exposing webRequest data through `window.__kuri._networkLog` in `content.js` to close the loop.

---

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| PASSIVE-01 | Passive network capture — index all API traffic while the browser operates normally, no explicit capture step required | Supported by: scriptInject timing fix eliminates injection race; kuri builtin extension observes all traffic via chrome.webRequest; captureSession can be called transparently from orchestrator with no agent action |
| PASSIVE-02 | Kuri builtin extension integration — wire chrome.webRequest network observer data into unbrowse's capture pipeline, supplement with CDP for response bodies | Supported by: background.js `kuri:getRequests` message bus (verified); content.js stub gap identified; bodies via JS interceptor (existing); architecture for content.js `window.__kuri._networkLog` bridge identified |
</phase_requirements>

---

## Standard Stack

### Core (verified against source files — all HIGH confidence)

| Library / API | Version / Location | Purpose | Why Standard |
|---|---|---|---|
| `kuri.scriptInject` | `src/kuri/client.ts:788` — `POST /script/inject` | Inject INTERCEPTOR_SCRIPT before first navigation via `Page.addScriptToEvaluateOnNewDocument` | Already implemented in kuri router (`router.zig:2638-2675`); maps to `protocol.Methods.page_add_script` |
| `kuri.evaluate` | `src/kuri/client.ts:416` | Evaluate JS in tab context to collect `window.__unbrowse_intercepted` | Existing, load-bearing, only JS evaluation path |
| INTERCEPTOR_SCRIPT + `window.__unbrowse_intercepted` | `src/capture/index.ts:336-436` | Intercepts fetch/XHR in MAIN world, records full request+response bodies | Existing, battle-tested; fixes body gap when injected early enough |
| `chrome.webRequest` (kuri builtin extension) | `submodules/kuri/js/extensions/kuri-builtin/background.js` | Observes all browser traffic including httpOnly requests, service worker fetches | Operates in extension background context — sees traffic the page JS interceptor cannot |
| `kuri:getRequests` message protocol | `background.js:64-76` | Retrieves webRequest log keyed by tabId | Returns `{ entries: [{ requestId, url, method, requestHeaders, statusCode, responseHeaders, completed }] }` |
| `window.__kuri` agent bridge | `content.js:59-83` | Exposes `getPageMeta()`, `on/emit` event bus | Injected at `document_start` before any page JS |
| HAR start/stop | `src/kuri/client.ts:482-496` | CDP Network domain recording — URLs + headers + status | Used as baseline; bodies will always be empty (har.zig design) |

### Supporting

| Library / API | Version / Location | Purpose | When to Use |
|---|---|---|---|
| `kuri.networkEnable` | `src/kuri/client.ts:499` | Enables CDP Network domain | Required before Network.* events fire |
| `extractEndpoints` | `src/reverse-engineer/index.ts` | Converts `RawRequest[]` to `EndpointDescriptor[]` | Downstream of capture — unchanged in Phase 1 |
| Triple-layer body replay | `src/capture/index.ts:776-907` | Performance API + HAR replay fallback | Keep as fallback; scriptInject reduces reliance |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|---|---|---|
| `kuri.scriptInject` | New kuri Zig endpoint | New kuri Zig route requires recompiling binary (Rach's domain). scriptInject already exists. |
| JS interceptor for bodies | CDP `Fetch.enable` interception | CDP Fetch requires `continueRequest`/`fulfillRequest` round-trip per request — adds latency. JS interceptor is zero-latency. |
| URL+headers from chrome.webRequest | Full CDP Network stream | chrome.webRequest sees more traffic (service workers, extension requests); CDP Network misses some. Use both. |

**Installation:** No new packages required. All dependencies are existing kuri APIs and the builtin extension.

---

## Architecture Patterns

### Current Active Capture Flow (what exists, read from source)

```
captureSession(url)
  kuri.evaluate(tabId, INTERCEPTOR_SCRIPT)  // inject AFTER tab open, BEFORE nav (race gap exists)
  kuri.harStart(tabId)
  kuri.navigate(tabId, url)
  // re-injection polling loop: 50ms x 60 iterations (src/capture/index.ts:739-749)
  waitForContentReady(...)
  collectInterceptedRequests(tabId)         // reads window.__unbrowse_intercepted
  Performance API replay (sync XHR)         // GET bodies for urls interceptor missed
  HAR replay (GET + POST)                   // fallback for remaining entries
  harStop(tabId)
  merge into RawRequest[]
  extractEndpoints(requests, html)
```

**Problems:** Injection race misses early SPA hydration calls. Triple fallback layer is brittle. Extension not wired.

### Target Passive Capture Flow (Phase 1)

```
captureSession(url)
  // ONE-TIME per tab lifetime:
  kuri.scriptInject(tabId, INTERCEPTOR_SCRIPT)  // Page.addScriptToEvaluateOnNewDocument
  // -- interceptor now live for ALL subsequent navigations in this tab --

  kuri.harStart(tabId)
  kuri.navigate(tabId, url)                 // interceptor already registered, no polling needed
  waitForContentReady(...)                  // existing adaptive wait, unchanged
  collectInterceptedRequests(tabId)         // reads window.__unbrowse_intercepted (now complete)
  collectExtensionRequests(tabId)           // NEW: reads chrome.webRequest log (URL+headers, no bodies)
  mergeCaptureData(har, intercepted, extension, responseBodies)
  extractEndpoints(merged, html)
```

**Key change:** Remove the 50ms re-injection polling loop. Add `collectExtensionRequests`. Keep fallback replay chain.

### Recommended Project Structure

All changes are within existing files. No new directories.

```
src/capture/index.ts     primary change surface:
                         - scriptInject before navigate
                         - remove 50ms polling loop
                         - add collectExtensionRequests()
                         - update mergeCaptureData()

src/kuri/client.ts       READ ONLY (CLAUDE.md constraint)
submodules/kuri/         READ ONLY — Rach's domain
  js/extensions/kuri-builtin/content.js    COORDINATE with Rach for window.__kuri._networkLog
```

### Pattern 1: scriptInject Before Navigation (fixes PASSIVE-01 timing race)

**What:** Call `kuri.scriptInject(tabId, INTERCEPTOR_SCRIPT)` once per tab, before first navigation.

**Source:** `src/kuri/client.ts:788`, `submodules/kuri/src/server/router.zig:2638-2675`

```typescript
// BEFORE — injection race:
await phase("evaluate:interceptor", () => kuri.evaluate(tabId, INTERCEPTOR_SCRIPT).catch(() => {}));
await phase("harStart", () => kuri.harStart(tabId));
await phase("navigate", () => kuri.navigate(tabId, url));
// ... then 50ms polling loop to re-inject (lines 739-749)

// AFTER — no race:
await phase("scriptInject", () =>
  kuri.scriptInject(tabId, INTERCEPTOR_SCRIPT).catch(() =>
    kuri.evaluate(tabId, INTERCEPTOR_SCRIPT).catch(() => {})
  )
);
await phase("harStart", () => kuri.harStart(tabId));
await phase("navigate", () => kuri.navigate(tabId, url));
// Remove the 50ms re-injection polling loop entirely
```

**Important:** Track per-tabId whether scriptInject has been called (using a `Set<string>`) to avoid double-registration on tab reuse.

### Pattern 2: Extension Request Collection (PASSIVE-02 supplement)

**What:** After `waitForContentReady`, attempt to collect the webRequest log from the builtin extension.

**Source:** `background.js:64-76`, `content.js:29-36`

**Architecture gap:** `window.chrome.runtime` in `content.js` is a stub (confirmed at line 31-36). `sendMessage` is `() => {}` — it does NOT relay to the background service worker. Direct `kuri.evaluate` calling `chrome.runtime.sendMessage` will hit the stub and return nothing.

**Viable Phase 1 path:** Request Rach add one message listener in `content.js` that forwards webRequest data from `background.js` into `window.__kuri._networkLog`. Content scripts have access to real `chrome.runtime.sendMessage` (not the stub). Then `kuri.evaluate` can read `window.__kuri._networkLog`.

**Fallback if Rach change unavailable:** Skip extension data collection in Phase 1. scriptInject alone satisfies PASSIVE-01 and substantially satisfies PASSIVE-02 for non-service-worker traffic.

```typescript
// New function — add to src/capture/index.ts
// Called after waitForContentReady; returns [] gracefully if extension not wired
async function collectExtensionRequests(tabId: string): Promise<ExtensionEntry[]> {
  try {
    const result = await kuri.evaluate(
      tabId,
      "JSON.stringify(window.__kuri && window.__kuri._networkLog ? window.__kuri._networkLog : [])"
    );
    if (typeof result === "string" && result.startsWith("[")) {
      return JSON.parse(result);
    }
  } catch { /* non-fatal */ }
  return [];
}

interface ExtensionEntry {
  url: string;
  method: string;
  requestHeaders?: Array<{ name: string; value: string }>;
  statusCode?: number;
  responseHeaders?: Array<{ name: string; value: string }>;
  tabId?: number;
}
```

### Pattern 3: Data Merge With Priority Order

**What:** Merge HAR entries, JS-intercepted entries, and extension entries into `RawRequest[]`, deduplicating by URL, with body-bearing sources taking priority.

```typescript
// Add to src/capture/index.ts — replaces the existing merge at lines 922-960
function mergePassiveCaptureData(
  harEntries: kuri.KuriHarEntry[],
  intercepted: InterceptedEntry[],
  extensionEntries: ExtensionEntry[],
  responseBodies: Map<string, string>,
): RawRequest[] {
  const seen = new Set<string>();
  const requests: RawRequest[] = [];

  // 1. JS-intercepted entries: have bodies — highest priority
  for (const entry of intercepted) {
    if (entry.is_js) continue;
    if (!seen.has(entry.url)) {
      seen.add(entry.url);
      requests.push({ /* map from InterceptedEntry */ });
    }
  }

  // 2. HAR entries: may have bodies via responseBodies map
  for (const entry of harEntries) {
    const url = entry.request?.url;
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const body = responseBodies.get(url) ?? entry.response?.content?.text;
    requests.push({ /* map from HarEntry + body */ });
  }

  // 3. Extension entries: URL+headers only, no bodies — lowest priority supplement
  for (const ext of extensionEntries) {
    if (!ext.url || seen.has(ext.url)) continue;
    seen.add(ext.url);
    requests.push({
      url: ext.url,
      method: ext.method || "GET",
      request_headers: Object.fromEntries(
        (ext.requestHeaders ?? []).map(h => [h.name, h.value])
      ),
      response_status: ext.statusCode ?? 0,
      response_headers: Object.fromEntries(
        (ext.responseHeaders ?? []).map(h => [h.name, h.value])
      ),
      response_body: undefined, // extension cannot provide bodies
      timestamp: new Date().toISOString(),
    });
  }

  return requests;
}
```

### Anti-Patterns to Avoid

- **Editing `src/kuri/client.ts`**: CLAUDE.md explicit constraint. All changes in `src/capture/index.ts`.
- **Assuming `window.chrome.runtime.sendMessage` relays to service worker**: The stub in `content.js:31` is `sendMessage: () => {}` — no-op. Confirmed in source.
- **Removing the HAR replay chain in Phase 1**: Keep fallbacks; reduction happens in Phase 2+ after passive coverage is proven.
- **Blocking the capture pipeline on extension data**: `collectExtensionRequests` must be non-blocking. If it fails or returns empty, proceed normally.
- **Calling `scriptInject` on every `captureSession` call**: Only call once per tab lifetime to avoid script accumulation. Track with a Set.

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---|---|---|---|
| Pre-navigation script injection | Custom CDP message construction | `kuri.scriptInject(tabId, source)` | Already at `src/kuri/client.ts:788`; one function call |
| Request deduplication | Custom data structure | `Set<string>` on URL key | URL is natural primary key; standard JS Set is sufficient |
| Intercepted request collection | New evaluate call pattern | Extend existing `collectInterceptedRequests` | Already tested pattern at `src/capture/index.ts:441-460` |
| Tab slot management | New semaphore | Existing `acquireTabSlot`/`releaseTabSlot` | Already at `src/capture/index.ts:76-91` |

---

## Common Pitfalls

### Pitfall 1: scriptInject Accumulation on Tab Reuse

**What goes wrong:** `Page.addScriptToEvaluateOnNewDocument` accumulates scripts in the tab; calling `scriptInject` twice registers the INTERCEPTOR_SCRIPT twice, resulting in double entries in `window.__unbrowse_intercepted`.

**Why it happens:** The kuri router (`router.zig:2638`) calls `page_add_script` without removing previous registrations. Kuri returns a `script_id` per injection but there is no automatic cleanup on tab reuse.

**How to avoid:** Maintain a `Set<string>` (`injectedTabs`) in `captureSession` scope (module-level). Only call `scriptInject` if `tabId` is not in the set. Add tabId on success; remove on tab close.

**Warning signs:** `window.__unbrowse_intercepted.length` exceeds expected count; duplicate URL entries.

### Pitfall 2: HAR Response Bodies Are Always Empty

**What goes wrong:** Code reading `entry.response?.content?.text` from `harStop` entries gets empty strings or undefined for all entries, even for successful API calls.

**Why it happens:** Confirmed from source: `har.zig:130-144` — `toJson()` serializes `"content":{"mimeType":"...","size":0}` with no `text` field. The `HarEntry` struct has no body field. CDP `Network.responseReceived` does not include the body; getting bodies requires a separate `Network.getResponseBody` call with the requestId.

**How to avoid:** Never expect HAR entries to have response bodies. All body capture goes through `window.__unbrowse_intercepted`. The existing code already handles this correctly at `src/capture/index.ts:935`: `response_body: responseBodies.get(entry.request.url) ?? entry.response.content?.text` — the `??` fallback to `content.text` will always resolve to `undefined`, which is correct behavior.

**Warning signs:** Upstream callers of `captureSession` show 0 response bodies despite successful navigation.

### Pitfall 3: content.js `chrome.runtime.sendMessage` Is a No-Op Stub

**What goes wrong:** `kuri.evaluate(tabId, "chrome.runtime.sendMessage({type:'kuri:getRequests'}, cb)")` returns nothing or calls `cb` with undefined.

**Why it happens:** `content.js:31-36` explicitly stubs `window.chrome.runtime` with no-op functions: `sendMessage: () => {}`. This is a stealth patch to prevent sites from detecting the extension. It does not relay to the service worker.

**How to avoid:** Do not attempt to call `chrome.runtime.sendMessage` from page context via `kuri.evaluate` in Phase 1. The extension webRequest data is accessible only from extension content script context, not from the MAIN world. Coordinate with Rach to add a `window.__kuri._networkLog` relay in `content.js`.

**Warning signs:** `chrome.runtime.sendMessage` call returns undefined immediately; no `entries` array.

### Pitfall 4: Service Worker Fetches Not Captured by JS Interceptor

**What goes wrong:** Modern Next.js (App Router), Remix, or Workbox sites make API calls via service workers. These do not go through `window.fetch` or `XMLHttpRequest` in the page context. The INTERCEPTOR_SCRIPT patches the MAIN world only.

**Why it happens:** Service workers run in an isolated context; `window.fetch` patches do not affect them.

**How to avoid:** This is a known gap. For Phase 1, document it. The `chrome.webRequest` extension observer does see service worker requests, making the extension integration in PASSIVE-02 important for completeness. Coverage: HTTP calls from page JS = covered by INTERCEPTOR_SCRIPT; service worker HTTP calls = covered by extension (when wired).

**Warning signs:** App Router pages show no API calls in `window.__unbrowse_intercepted` despite clearly making API calls.

### Pitfall 5: kuri.evaluate Returns "[object Object]"

**What goes wrong:** `kuri.evaluate` returns the string `"[object Object]"` instead of expected JSON.

**Why it happens:** Documented in CLAUDE.md and CONCERNS.md. CDP response shape can change between kuri versions.

**How to avoid:** Always validate `result.startsWith("[")` or `result.startsWith("{")` before `JSON.parse`. The existing `collectInterceptedRequests` already does this correctly.

**Warning signs:** `JSON.parse` throws `SyntaxError` or parses an empty object.

### Pitfall 6: guard `entry.request.headers ?? []` — Never Bare Access

**What goes wrong:** `TypeError: Cannot read properties of undefined (reading 'map')` on HAR entry iteration.

**Why it happens:** Kuri HAR entries may have undefined `headers` or `response` fields. Documented in CLAUDE.md as an explicit footgun.

**How to avoid:** Always use `entry.request.headers ?? []`. The existing code at `src/capture/index.ts:925` already does this correctly. New code touching HAR entries must follow the same pattern.

---

## Code Examples

### scriptInject — the core Phase 1 fix

```typescript
// Source: src/kuri/client.ts:788 (scriptInject definition)
// Usage: add to captureSession in src/capture/index.ts

// Track which tabs have the interceptor registered
const interceptorInjectedTabs = new Set<string>();

// Inside captureSession, after tab is acquired and BEFORE harStart/navigate:
if (!interceptorInjectedTabs.has(tabId)) {
  try {
    await phase("scriptInject:interceptor", () =>
      kuri.scriptInject(tabId, INTERCEPTOR_SCRIPT)
    );
    interceptorInjectedTabs.add(tabId);
    log("capture", `interceptor registered via scriptInject for tab ${tabId}`);
  } catch {
    // scriptInject failed — fall back to evaluate (still better than nothing)
    await kuri.evaluate(tabId, INTERCEPTOR_SCRIPT).catch(() => {});
    log("capture", `scriptInject failed, fell back to evaluate for tab ${tabId}`);
  }
}
// Remove: entire 50ms polling loop (lines 739-749)
```

### collectExtensionRequests — PASSIVE-02 supplement

```typescript
// Add to src/capture/index.ts after collectInterceptedRequests

interface ExtensionEntry {
  url: string;
  method: string;
  requestHeaders?: Array<{ name: string; value: string }>;
  statusCode?: number;
  responseHeaders?: Array<{ name: string; value: string }>;
}

async function collectExtensionRequests(tabId: string): Promise<ExtensionEntry[]> {
  try {
    // Reads window.__kuri._networkLog populated by content.js relay
    // Returns [] if content.js has not been updated to populate this field
    const result = await kuri.evaluate(
      tabId,
      "JSON.stringify(window.__kuri && Array.isArray(window.__kuri._networkLog) ? window.__kuri._networkLog : [])"
    );
    if (typeof result === "string" && result.startsWith("[")) {
      return JSON.parse(result) as ExtensionEntry[];
    }
  } catch { /* non-fatal — extension relay may not be available */ }
  return [];
}
```

### Updated captureSession call sequence (high-level pseudocode)

```typescript
// Replacing lines ~724-960 of src/capture/index.ts:

// 1. Register interceptor ONCE per tab
if (!interceptorInjectedTabs.has(tabId)) {
  await phase("scriptInject", () => kuri.scriptInject(tabId, INTERCEPTOR_SCRIPT).catch(() =>
    kuri.evaluate(tabId, INTERCEPTOR_SCRIPT).catch(() => {})
  ));
  interceptorInjectedTabs.add(tabId);
}

// 2. Start HAR
await phase("harStart", () => kuri.harStart(tabId));

// 3. Navigate (interceptor already live — no polling loop needed)
await phase("navigate", () => kuri.navigate(tabId, url));

// 4. Wait for content
await phase("waitForContentReady", () => waitForContentReady(tabId, url, intent, responseBodies));

// 5. Collect from all sources
const intercepted = await phase("collectIntercepted", () => collectInterceptedRequests(tabId));
const extensionEntries = await phase("collectExtension", () => collectExtensionRequests(tabId));

// 6. Populate responseBodies from intercepted (existing logic)
// ... existing body population from intercepted entries ...

// 7. Performance API fallback (keep existing, reduces reliance with scriptInject)
// ... existing Performance API replay ...

// 8. Stop HAR
const harResult = await phase("harStop", () => kuri.harStop(tabId));

// 9. HAR replay fallback (keep existing)
// ... existing HAR replay ...

// 10. Build final RawRequest[] — merge all sources
const requests = mergePassiveCaptureData(
  harResult.entries,
  intercepted,
  extensionEntries,
  responseBodies
);
```

---

## State of the Art

| Old Approach | Current Approach | Notes | Impact |
|---|---|---|---|
| evaluate+poll for injection | scriptInject (Page.addScriptToEvaluateOnNewDocument) | scriptInject exists but unused in captureSession | Eliminates timing race; early SPA hydration calls captured |
| No extension wiring | chrome.webRequest observer in builtin extension | Extension observes all traffic; not yet surfaced to capture pipeline | Provides URL+headers for service worker + httpOnly flows |
| Triple fallback body chain | Same + scriptInject reduces dependence | Fallbacks remain for edge cases | Fewer silent misses once scriptInject is in place |
| HAR with body text | HAR never has body text (har.zig design) | `toJson()` always produces size=0, no text | Already handled correctly in existing code |

**Deprecated/outdated after Phase 1:**
- 50ms re-injection polling loop (`src/capture/index.ts:739-749`): replaced by `scriptInject`
- Comment "Re-inject interceptor ASAP after navigation": no longer needed once scriptInject is wired

---

## Open Questions

1. **How to get Chrome-integer tabId for extension webRequest filtering**
   - What we know: `chrome.webRequest` entries store `tabId` as Chrome integer; kuri tab IDs are string UUIDs; no current kuri API maps between them.
   - What's unclear: Whether CDP `Target.getTargetInfo` or another CDP call can retrieve the integer Chrome tabId for a given kuri tab UUID.
   - Recommendation: For Phase 1, skip tabId filtering — collect all webRequest entries from background.js and post-filter by registrable domain. Ask Rach in a GitHub issue.

2. **content.js chrome.runtime stub vs real relay**
   - What we know: `content.js:31-36` installs no-op stub. Real `chrome.runtime.sendMessage` only works in extension content script context.
   - What's unclear: Whether Rach can add a `window.__kuri._networkLog` array populated by a content script that relays webRequest data from background.js via `chrome.runtime.onMessage`.
   - Recommendation: File as a kuri issue with the exact proposed change (content.js: listen for background messages, push into `window.__kuri._networkLog`). Phase 1 can ship without this; PASSIVE-02 is partially satisfied by scriptInject alone.

3. **scriptInject script accumulation and cleanup**
   - What we know: `Page.addScriptToEvaluateOnNewDocument` accumulates scripts; kuri returns `script_id` per registration but there is no kuri HTTP endpoint to remove scripts (confirmed no `/script/remove` route in router.zig route table).
   - Recommendation: Use a module-level `Set<string>` to track injected tabs and skip re-injection. Long-term: request Rach expose `/script/remove` endpoint in kuri.

---

## Sources

### Primary (HIGH confidence — verified against source files)

- `submodules/kuri/src/cdp/har.zig:26-145` — HAR struct has no body field; `toJson` always produces `size:0, no text`
- `submodules/kuri/src/server/router.zig:2638-2675` — `/script/inject` endpoint confirmed, calls `page_add_script`
- `submodules/kuri/src/server/router.zig:82-250` — full route table; confirmed no `/script/remove` route
- `submodules/kuri/js/extensions/kuri-builtin/background.js` — webRequest listener + `kuri:getRequests` message protocol verified
- `submodules/kuri/js/extensions/kuri-builtin/content.js:29-36` — `chrome.runtime.sendMessage: () => {}` stub confirmed
- `submodules/kuri/docs/extensions.md:56-64` — builtin extension always loaded, embedded in binary
- `src/kuri/client.ts:788` — `scriptInject` function exists, single line, maps to `/script/inject`
- `src/kuri/client.ts:416-447` — `evaluate` function; 4x duplicate JSDoc (known fragility)
- `src/capture/index.ts:336-436` — INTERCEPTOR_SCRIPT full source
- `src/capture/index.ts:731-749` — injection race: 50ms polling loop
- `src/capture/index.ts:776-907` — triple-layer body replay chain
- `src/capture/index.ts:922-960` — HAR-to-RawRequest mapping; `responseBodies.get()` fallback pattern

### Secondary (MEDIUM confidence)

- CONCERNS.md — cross-referenced injection race and HAR body gap descriptions with source; all accurate
- ARCHITECTURE.md — orchestrator and capture layer descriptions verified against source

### Tertiary (LOW confidence — not verified against live docs this session)

- Chrome webRequest API limitation (no response bodies in MV3): widely established, training knowledge, HIGH confidence despite no live doc fetch
- CDP `Network.getResponseBody` availability: confirmed protocol exists in kuri's `protocol.zig` scan showed no `getResponseBody` constant defined — meaning kuri does NOT expose it via its standard route; bodies must come from JS interceptor

---

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — all verified against source files
- Architecture patterns: HIGH — derived from reading actual code paths
- Pitfalls: HIGH — most derived from reading actual source code
- Extension messaging (content.js stub): HIGH — confirmed stub is no-op from source

**Research date:** 2026-04-01
**Valid until:** 2026-05-01 (kuri builtin extension and capture pipeline are stable)
