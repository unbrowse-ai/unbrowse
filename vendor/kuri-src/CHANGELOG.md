# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] — 2026-03-04

### Added

#### Core Infrastructure
- **Project scaffolding** — `build.zig`, `build.zig.zon`, directory structure, Zig 0.15.1 support
- **HTTP server** — `std.http.Server` with per-connection thread spawning, arena-per-request memory model
- **Bridge & Tab Registry** — thread-safe (`RwLock`) tab lifecycle with CDP client pooling
- **Configuration** — env var loading (`HOST`, `PORT`, `CDP_URL`, `BROWDIE_SECRET`, timeouts)

#### Browser Automation (CDP)
- **CDP WebSocket client** — pure Zig Chrome DevTools Protocol client with JSON-RPC correlation
- **Chrome Lifecycle Manager** (`src/chrome/launcher.zig`) — launch headless Chrome, health-check via `/json/version`, auto-restart on crash (max 3 retries), port conflict detection, platform-aware binary discovery (macOS + Linux)
- **Stealth mode** — JS injection to bypass bot detection (`navigator.webdriver`, user-agent spoofing)
- **Accessibility tree snapshots** — structured page representation with `filter=interactive` (97% reduction), `@eN` ref system for deterministic element targeting (inspired by [agent-browser](https://github.com/vercel-labs/agent-browser))
- **Snapshot diffing** — delta computation between a11y trees (added/removed/changed nodes)
- **Element actions** — click, type, scroll via cached ref IDs
- **Screenshot capture** — base64 PNG via CDP `Page.captureScreenshot`
- **Page text extraction** — full text via `Runtime.evaluate`
- **JavaScript evaluation** — arbitrary JS execution via `/evaluate`

#### HAR Recording
- **HAR recorder** (`src/cdp/har.zig`) — HTTP Archive 1.2 format, CDP Network domain integration
- **`/har/start`** — begin recording network traffic for a tab
- **`/har/stop`** — stop recording, return HAR JSON with entries
- **`/har/status`** — check recording state and entry count

#### Crawler Engine
- **URL validator** — SSRF defense (private IP blocking, metadata IP blocking, scheme enforcement, IPv6 loopback)
- **HTML → Markdown converter** — handles headings, links, lists, code blocks, emphasis, entities, script/style stripping
- **Readability extractor** — clean article extraction stub
- **Parallel crawl pipeline** — bounded concurrency stub

#### Storage
- **Local file writer** — domain-based naming stub
- **Kafka producer** — compression support stub
- **R2/S3 uploader** — SigV4 signing stub

#### Tab & Session Management
- **Tab discovery** (`/discover`) — auto-detect Chrome tabs via CDP `/json/list`, register in bridge
- **Tab cleanup** (`/close`) — disconnect CDP, free HAR recorders, remove from registry
- **Ref cache** — `@eN` → backend DOM node ID mapping with clear/invalidate

#### Testing
- **99+ unit & integration tests** across all modules
- **Test harness** (`src/test/harness.zig`) — HTTP client helpers, snapshot assertions, action-verify patterns
- **Integration test suite** (`src/test/integration.zig`) — config, bridge stress, diff edge cases, ref cache, markdown, URL validation, JSON utils, launcher, a11y

#### Memory Safety
- Arena-per-request allocator — all per-request memory freed in bulk
- Proper `deinit` chains: Launcher → Bridge → CdpClients → HarRecorders → Snapshots → Tabs
- `removeTab` cleans up all associated resources (CDP, HAR, snapshots, owned strings)
- Chrome process killed and waited on server shutdown
- `errdefer` guards on tab registration to prevent leaks on partial failure

### API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Server status + tab count |
| `GET` | `/tabs` | List registered tabs |
| `GET` | `/discover` | Auto-discover Chrome tabs via CDP |
| `GET` | `/navigate?tab_id=&url=` | Navigate tab to URL |
| `GET` | `/snapshot?tab_id=&filter=interactive` | A11y tree snapshot |
| `GET` | `/text?tab_id=` | Extract page text |
| `GET` | `/screenshot?tab_id=` | Capture screenshot |
| `GET` | `/action?tab_id=&ref=&kind=` | Interact with elements |
| `GET` | `/evaluate?tab_id=&expr=` | Execute JavaScript |
| `GET` | `/har/start?tab_id=` | Start HAR recording |
| `GET` | `/har/stop?tab_id=` | Stop + return HAR |
| `GET` | `/har/status?tab_id=` | Recording status |
| `GET` | `/close?tab_id=` | Close tab + cleanup |
| `GET` | `/browdie` | ASCII art 🧁 |

[0.1.0]: https://github.com/justrach/agentic-browdie/releases/tag/v0.1.0
