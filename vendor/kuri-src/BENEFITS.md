# Agentic Browdie — Benefits & Trade-offs

> An honest assessment of what this project delivers and where it still has gaps.

---

## What Problem Does It Solve?

LLM agents need to interact with the web: navigate pages, click buttons, extract content, and verify state. Most existing tools were built for human QA workflows — they're heavy, verbose, and not optimized for AI consumption. Agentic Browdie is a **browser automation server purpose-built for AI agents**, exposing Chrome via a simple HTTP API that any language, any agent framework, and any LLM can call.

---

## Concrete Benefits

### 1. Language-Agnostic HTTP API

Every endpoint returns JSON over plain HTTP. No SDK, no library, no runtime to install on the agent side — just `curl` or an HTTP client:

```bash
curl http://localhost:8080/snapshot?tab_id=ABC&filter=interactive
```

This means:
- **Python agents** (LangChain, CrewAI, AutoGen) work immediately
- **TypeScript agents** (Vercel AI SDK, LlamaIndex.TS) work immediately
- **Any MCP client** can call it via a thin tool wrapper
- No Playwright bindings, no Puppeteer version pinning, no Selenium WebDriver protocol quirks

Compare against **Playwright MCP**: requires a Node.js runtime, MCP transport, and Playwright-specific client. Browdie works with any HTTP call.

### 2. Token Efficiency — Accessibility Snapshots vs Full DOM

The `GET /snapshot?filter=interactive` endpoint returns only interactive elements with short `@eN` refs:

```json
[{"ref":"e0","role":"link","name":"Start Deploying"},
 {"ref":"e1","role":"button","name":"Sign In"}]
```

From the Pinchtab benchmarks (50-page monitoring task):

| Method | Tokens | Cost ($) |
|--------|--------|-----------|
| `/text` | ~40,000 | $0.20 |
| `/snapshot?filter=interactive` | ~180,000 | $0.90 |
| `/snapshot` (full tree) | ~525,000 | $2.63 |
| `/screenshot` | ~100,000 | $1.00 |

**Interactive-filtered snapshots are 66% cheaper than full snapshots and avoid the layout sensitivity of screenshots.** The `@eN` ref system lets the LLM say `{"ref": "e1", "kind": "click"}` without ever touching XPath or CSS selectors.

### 3. Performance — Zig vs Go vs Node/Python

| Dimension | Go (Pinchtab, Pathik) | Node/Python | Zig (Agentic Browdie) |
|-----------|----------------------|-------------|------------------------|
| Memory baseline | ~50–100 MB (GC heap) | ~80–150 MB | ~5–15 MB (no GC) |
| Binary size | ~15–30 MB | N/A (runtime) | ~2–5 MB (static) |
| Startup time | ~50–100ms | ~200–500ms | ~1–5ms |
| GC pauses | Yes (stop-the-world) | Yes (V8, CPython) | None |

For long-running agent tasks (dozens of page navigations, continuous screenshots), GC pauses in Go/Node accumulate. Zig uses **arena-per-request allocation** — all memory for a request is freed in a single `deinit()` with zero fragmentation.

### 4. Memory Safety Without GC Overhead

Zig provides memory safety through:
- **Arena allocators per HTTP request** — no per-allocation free, bulk release at request end
- **`errdefer` guards** — tab registration rolls back automatically on partial failure
- **`GeneralPurposeAllocator` in debug builds** — detects leaks and double-frees at test time
- **Explicit ownership** — `removeTab` cleans CDP connections, HAR recorders, snapshots, and owned strings in one call

This eliminates GC pause jitter without requiring unsafe manual memory management.

### 5. Single Binary Deployment

```bash
zig build  # produces ./zig-out/bin/agentic-browdie (~2–5 MB)
```

- **No runtime dependencies** — no Node, no Python, no JVM
- **No package manager required at runtime** — no `npm install`, no `pip install`
- **Cross-compilation from any host** — one build command targets Linux/macOS/ARM
- **JS files embedded at compile time** — `stealth.js` and `readability.js` are `@embedFile`'d into the binary; no file system dependency

Compare against **Puppeteer**: requires Node.js runtime + npm + Chromium download (~300 MB). Compare against **Selenium**: requires language runtime + WebDriver binary + browser binary.

### 6. Chrome Lifecycle Management

Browdie either launches and supervises Chrome itself or connects to an existing instance:

- **Managed mode**: launches headless Chrome, auto-detects free CDP port, health-checks, auto-restarts on crash (up to 3 retries), kills Chrome cleanly on shutdown
- **External mode**: `CDP_URL=ws://127.0.0.1:9222` — attaches to existing Chrome, does not kill on exit

This is more robust than most agent-browser setups, which leave zombie Chrome processes behind.

### 7. HAR Recording for Debugging

Endpoints for capturing network traffic in HAR 1.2 format:

```bash
curl http://localhost:8080/har/start?tab_id=ABC
# ... do stuff ...
curl http://localhost:8080/har/stop?tab_id=ABC  # returns HAR JSON
```

HAR files can be loaded into Chrome DevTools or tools like Fiddler for post-hoc debugging of what network requests an agent triggered. Useful for debugging authentication flows, tracking API calls made by SPAs, and diagnosing failures.

### 8. Snapshot Diffing

The `/diff/snapshot` endpoint compares two accessibility snapshots and returns only `added`, `removed`, and `changed` nodes. This lets agents:
- Confirm a click had an effect without re-reading the full page
- Detect navigation completion by watching for content changes
- Efficiently track form state changes

Diff identity is based on `backend_node_id` (stable across re-renders), not position or ref string.

### 9. Anti-Detection (Stealth)

Embeds a bot-detection bypass script that patches:
- `navigator.webdriver` (primary Selenium/CDP fingerprint)
- `navigator.plugins` and `navigator.languages`
- Chrome runtime fingerprint properties

This helps agents browse sites that block automated browsers.

### 10. SSRF Defense

`src/crawler/validator.zig` includes URL validation to block Server-Side Request Forgery when agents pass arbitrary URLs. Internal IP ranges (localhost, 10.x, 172.16.x, 192.168.x, link-local) are rejected.

---

## Comparison Against Alternatives

| Feature | Playwright MCP | Puppeteer | Selenium | Agentic Browdie |
|---------|---------------|-----------|----------|-----------------|
| Language-agnostic | ❌ (Node MCP) | ❌ (Node) | Partial (WebDriver) | ✅ (HTTP) |
| Accessibility snapshots | ✅ | ❌ | ❌ | ✅ |
| Token-optimized output | ✅ | ❌ | ❌ | ✅ |
| No GC pauses | ❌ | ❌ | Varies | ✅ |
| Single binary | ❌ | ❌ | ❌ | ✅ |
| HAR recording | ❌ | ✅ | ✅ | ✅ (partial) |
| Stealth mode | ❌ | Via plugin | ❌ | ✅ (embedded) |
| Chrome lifecycle mgmt | ✅ | Partial | Via driver | ✅ |
| <15 MB memory baseline | ❌ | ❌ | ❌ | ✅ |
| Snapshot diffing | ❌ | ❌ | ❌ | ✅ |

---

## What's Still In Progress

Being honest about gaps is important for production planning:

| Feature | Status | Notes |
|---------|--------|-------|
| **HAR event capture** | Incomplete | Endpoints and data structures exist; CDP network event subscription is not wired at runtime. HAR output will be empty. |
| **Stealth injection** | Embedded, not called | `stealth.js` is compiled into the binary but `stealth.zig` is not invoked from any runtime path. |
| **Crawler pipeline** | Scaffolded only | `src/crawler/pipeline.zig`, `fetcher.zig`, `extractor.zig` are stubs — zero runtime integration. |
| **Storage backends** | Config structs only | Kafka, R2, local file storage exist as types; no write paths are connected. |
| **End-to-end tests** | Missing | Integration tests cover bridge logic and utilities, but not the full router → CDP → Chrome flow. |
| **Concurrency hardening** | Partial | Pointer-after-unlock risk in `getCdpClient()`/`getHarRecorder()`; CDP client has no send/receive mutex. |
| **HTTP method enforcement** | Not implemented | All endpoints accept any HTTP method (GET, POST, DELETE all hit the same handler). |

---

## Summary

Agentic Browdie's core value proposition is a **fast, small, zero-dependency browser automation server** that speaks HTTP. It is already useful for:

1. Connecting any LLM agent to a real Chrome browser via HTTP
2. Extracting token-efficient accessibility snapshots for element interaction
3. Running in memory-constrained environments where Go or Node runtimes are too heavy
4. Single-binary deployment in containers or CI without package managers

The main gaps are HAR event capture, stealth injection wiring, the crawler pipeline, and storage backends — all of which have scaffolding in place and clear paths to completion.
