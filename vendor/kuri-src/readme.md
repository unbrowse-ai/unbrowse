<p align="center">
  <img src="kuri.png" alt="Kuri" width="200" />
</p>

<h1 align="center">Kuri 🌰</h1>

<p align="center">
  <a href="https://github.com/justrach/kuri/releases/latest"><img src="https://img.shields.io/github/v/release/justrach/kuri?style=flat-square" alt="Release"></a>
  <a href="https://github.com/justrach/kuri/blob/main/LICENSE"><img src="https://img.shields.io/github/license/justrach/kuri?style=flat-square" alt="License"></a>
  <img src="https://img.shields.io/badge/zig-0.15.2-f7a41d?style=flat-square" alt="Zig">
  <img src="https://img.shields.io/badge/node__modules-0_files-brightgreen?style=flat-square" alt="node_modules">
  <img src="https://img.shields.io/badge/status-experimental-orange?style=flat-square" alt="status">
</p>

**Browser automation & web crawling for AI agents. Written in Zig. Zero Node.js.**

CDP automation · A11y snapshots · HAR recording · Standalone fetcher · Interactive terminal browser · QuickJS scripting

[Quick Start](#-quick-start) · [API](#-http-api) · [kuri-fetch](#-kuri-fetch) · [kuri-browse](#-kuri-browse) · [Architecture](#-architecture) · [Configuration](#-configuration)

---

## The Problem

Every browser automation tool drags in Playwright (~300 MB), a Node.js runtime, and a cascade of npm dependencies. Your AI agent just wants to read a page, click a button, and move on.

**Kuri is a single Zig binary.** Three modes, zero runtime:

```
kuri           →  CDP server (Chrome automation, a11y snapshots, HAR)
kuri-fetch     →  standalone fetcher (no Chrome, QuickJS for JS, ~2 MB)
kuri-browse    →  interactive terminal browser (navigate, follow links, search)
```

---

## 📦 Installation

### Pre-built binaries

Download the latest release for your platform from [GitHub Releases](https://github.com/justrach/kuri/releases/latest).

```bash
# macOS Apple Silicon
curl -L https://github.com/justrach/kuri/releases/latest/download/kuri-$(curl -s https://api.github.com/repos/justrach/kuri/releases/latest | grep tag_name | cut -d '"' -f4)-aarch64-macos.tar.gz | tar xz

# macOS Intel
curl -L https://github.com/justrach/kuri/releases/latest/download/kuri-$(curl -s https://api.github.com/repos/justrach/kuri/releases/latest | grep tag_name | cut -d '"' -f4)-x86_64-macos.tar.gz | tar xz

# Linux amd64
curl -L https://github.com/justrach/kuri/releases/latest/download/kuri-$(curl -s https://api.github.com/repos/justrach/kuri/releases/latest | grep tag_name | cut -d '"' -f4)-x86_64-linux.tar.gz | tar xz

# Linux arm64
curl -L https://github.com/justrach/kuri/releases/latest/download/kuri-$(curl -s https://api.github.com/repos/justrach/kuri/releases/latest | grep tag_name | cut -d '"' -f4)-aarch64-linux.tar.gz | tar xz
```

### Build from source

Requires [Zig ≥ 0.15.0](https://ziglang.org/download/).

```bash
git clone https://github.com/justrach/kuri.git
cd kuri
zig build -Doptimize=ReleaseFast
# Binaries in zig-out/bin/: kuri, kuri-fetch, kuri-browse
```

---

## ⚡ Quick Start

**Requirements:** [Zig ≥ 0.15.1](https://ziglang.org/download/) · Chrome/Chromium (for CDP mode)

```bash
git clone https://github.com/justrach/agentic-browdie.git
cd agentic-browdie

zig build              # build everything
zig build test         # run 230+ tests

# CDP mode — launches Chrome automatically
./zig-out/bin/kuri

# Standalone mode — no Chrome needed
./zig-out/bin/kuri-fetch https://example.com

# Interactive browser — browse from your terminal
./zig-out/bin/kuri-browse https://example.com
```

### Browse vercel.com in 4 commands

```bash
# 1. Discover Chrome tabs
curl -s http://localhost:8080/discover
# → {"discovered":1,"total_tabs":1}

# 2. Get tab ID
curl -s http://localhost:8080/tabs
# → [{"id":"ABC123","url":"chrome://newtab/","title":"New Tab"}]

# 3. Navigate
curl -s "http://localhost:8080/navigate?tab_id=ABC123&url=https://vercel.com"

# 4. Get accessibility snapshot (token-optimized for LLMs)
curl -s "http://localhost:8080/snapshot?tab_id=ABC123&filter=interactive"
# → [{"ref":"e0","role":"link","name":"VercelLogotype"},
#    {"ref":"e1","role":"button","name":"Ask AI"}, ...]
```

---

## 📊 Benchmarks

Measured on Apple M3 Pro, macOS 15.3. `kuri` built with `-Doptimize=ReleaseFast`. `agent-browser` v0.20.0 (Rust native binary).

### vs agent-browser (Rust)

Both are native binaries — agent-browser is Rust, kuri is Zig. Measured with agent-browser v0.20.0.

```
                        agent-browser        kuri             delta
                        (Rust, v0.20)        (Zig, v0.2)
─────────────────────────────────────────────────────────────────────
CLI binary              6.0 MB               464 KB           13× smaller
Cold start (--version)  3.4 ms               3.0 ms           ~same
Install (npm)           33 MB                3.3 MB (3 bins)  10× smaller
Commands                140+                 40+ endpoints    different focus
Standalone fetcher      ❌                    ✅ kuri-fetch     no Chrome needed
Terminal browser        ❌                    ✅ kuri-browse    interactive REPL
JS engine (no Chrome)   ❌                    ✅ QuickJS        SSR-style DOM
HTTP API server         ❌ (CLI only)         ✅ kuri           thread-per-conn
```

> **Note:** agent-browser has significantly more browser automation commands (140+) including
> drag-and-drop, file upload/download, iOS simulator support, auth vault, and video recording.
> Kuri focuses on being a lightweight HTTP API server for AI agent integration.

### vs Playwright / Lightpanda

|  | **Kuri** | **Playwright** | **Lightpanda** |
|---|---|---|---|
| Runtime | None (native binary) | Node.js ≥ 18 | None (Zig) |
| `node_modules` | **0 files** | ~300 MB | **0 files** |
| Binary size | **464 KB** server | N/A (interpreted) | ~15 MB |
| Cold start | **~3 ms** | ~1–3 s | < 5 ms |
| Standalone fetcher | ✅ `kuri-fetch` | ❌ | ❌ |
| Terminal browser | ✅ `kuri-browse` | ❌ | ❌ |
| JS execution (no Chrome) | ✅ QuickJS | ❌ | ❌ |
| A11y snapshots | ✅ `@eN` refs | Via CDP | ✅ |
| HAR recording | ✅ CDP Network | ✅ | ✅ |
| Token cost reduction | **97%** (interactive filter) | Manual | Varies |

---

## 🌐 HTTP API

All endpoints return JSON. Optional auth via `KURI_SECRET` env var.

### Core

| Path | Description |
|------|-------------|
| `GET /health` | Server status, tab count, version |
| `GET /tabs` | List all registered tabs |
| `GET /discover` | Auto-discover Chrome tabs via CDP |
| `GET /browdie` | 🌰 (easter egg) |

### Browser Control

| Path | Params | Description |
|------|--------|-------------|
| `GET /navigate` | `tab_id`, `url` | Navigate tab to URL |
| `GET /snapshot` | `tab_id`, `filter`, `format` | A11y tree snapshot with `@eN` refs |
| `GET /text` | `tab_id` | Extract page text |
| `GET /screenshot` | `tab_id`, `format`, `quality` | Capture screenshot (base64) |
| `POST /action` | `tab_id`, `ref`, `kind` | Click/type/scroll by ref |
| `GET /evaluate` | `tab_id`, `expression` | Execute JavaScript |
| `GET /close` | `tab_id` | Close tab + cleanup |

### Content Extraction

| Path | Description |
|------|-------------|
| `GET /markdown` | Convert page to Markdown |
| `GET /links` | Extract all links |
| `GET /dom/query` | CSS selector query |
| `GET /dom/html` | Get element HTML |
| `GET /pdf` | Print page to PDF |

### HAR Recording

| Path | Description |
|------|-------------|
| `GET /har/start?tab_id=` | Start recording network traffic |
| `GET /har/stop?tab_id=` | Stop + return HAR 1.2 JSON |
| `GET /har/status?tab_id=` | Recording state + entry count |

### Navigation & State

| Path | Description |
|------|-------------|
| `GET /back` | Browser back |
| `GET /forward` | Browser forward |
| `GET /reload` | Reload page |
| `GET /cookies` | Get cookies |
| `GET /cookies/delete` | Delete cookies |
| `GET /cookies/clear` | Clear all cookies |
| `GET /storage/local` | Get localStorage |
| `GET /storage/session` | Get sessionStorage |
| `GET /session/save` | Save browser session |
| `GET /session/load` | Restore browser session |
| `GET /headers` | Set custom request headers |

### Advanced

| Path | Description |
|------|-------------|
| `GET /diff/snapshot` | Delta diff between snapshots |
| `GET /emulate` | Device emulation |
| `GET /geolocation` | Set geolocation |
| `POST /upload` | File upload |
| `GET /script/inject` | Inject JavaScript |
| `GET /intercept/start` | Start request interception |
| `GET /intercept/stop` | Stop interception |
| `GET /screenshot/annotated` | Screenshot with element annotations |
| `GET /screenshot/diff` | Visual diff between screenshots |
| `GET /screencast/start` | Start screencast |
| `GET /screencast/stop` | Stop screencast |
| `GET /video/start` | Start video recording |
| `GET /video/stop` | Stop video recording |
| `GET /console` | Get console messages |
| `GET /stop` | Stop page loading |
| `GET /get` | Direct HTTP fetch (server-side) |

---

## 🔧 kuri-fetch

Standalone HTTP fetcher — no Chrome, no Playwright, no npm. Ships as a ~2 MB binary with built-in QuickJS for JS execution.

```bash
zig build fetch    # build + run

# Default: convert to Markdown
kuri-fetch https://example.com

# Extract links
kuri-fetch -d links https://news.ycombinator.com

# Structured JSON output
kuri-fetch --json https://example.com

# Execute inline scripts via QuickJS
kuri-fetch --js https://example.com

# Write to file, quiet mode
kuri-fetch -o page.md -q https://example.com

# Pipe-friendly: content → stdout, status → stderr
kuri-fetch -d text https://example.com | wc -w
```

### Features

- **5 output modes** — `markdown`, `html`, `links`, `text`, `json`
- **QuickJS JS engine** — `--js` executes inline `<script>` tags
- **DOM stubs** — `document.querySelector`, `getElementById`, `window.location`, `document.title`, `console.log`, `setTimeout` (SSR-style)
- **SSRF defense** — blocks private IPs, metadata endpoints, non-HTTP schemes
- **Colored output** — respects `NO_COLOR`, `TERM=dumb`, `--no-color`, TTY detection
- **File output** — `-o` / `--output` with byte count + timing summary
- **Custom UA** — `--user-agent` flag
- **Quiet mode** — `-q` suppresses stderr status

---

## 🌐 kuri-browse

Interactive terminal browser — browse the web from your terminal. No Chrome needed.

```bash
zig build browse   # build + run

kuri-browse https://example.com
```

```
🌰 kuri-browse — terminal browser
→ loading https://example.com

# Example Domain
This domain is for use in documentation examples...
Learn more [1]

───── Links ─────
  [1] https://iana.org/domains/example

✓ 528 bytes, 1 links (133ms)
[nav] https://example.com> 1     ← type 1 to follow the link
```

### Commands

| Command | Action |
|---------|--------|
| `<number>` | Follow link [N] |
| `<url>` | Navigate (if contains `.`) |
| `:go <url>` | Navigate to URL |
| `:back`, `:b` | Go back in history |
| `:forward`, `:f` | Go forward |
| `:reload`, `:r` | Re-fetch current page |
| `:links`, `:l` | Show link index |
| `/<term>` | Search in page (highlights matches) |
| `:search <t>` | Search in page |
| `:n`, `:next` | Re-highlight search |
| `:history` | Show navigation history |
| `:help`, `:h` | Show all commands |
| `:quit`, `:q` | Exit |

### Features

- **Colored markdown rendering** — headings, links, code blocks, bold, blockquotes
- **Numbered links** — every link gets `[N]`, type the number to follow it
- **Navigation history** — back/forward like a real browser
- **In-page search** — `/term` highlights all matches
- **Relative URL resolution** — follows links naturally across pages
- **Smart filtering** — skips `javascript:` and `mailto:` hrefs

---

## 🏗 Architecture

```
┌──────────────────────────────────────────────────────────┐
│                     HTTP API Layer                        │
│         (std.http.Server, thread-per-connection)          │
├──────────────┬──────────────────┬────────────────────────┤
│   Browser    │  Crawler Engine  │   kuri-fetch / browse   │
│   Bridge     │                  │   (standalone CLIs)     │
├──────────────┼──────────────────┼────────────────────────┤
│ CDP Client   │ URL Validator    │ std.http.Client         │
│ Tab Registry │ HTML→Markdown    │ QuickJS JS Engine       │
│ A11y Snapshot│ Link Extractor   │ DOM Stubs (Layer 3)     │
│ Ref Cache    │ Text Extractor   │ SSRF Validator          │
│ HAR Recorder │                  │ Colored Renderer        │
│ Stealth JS   │                  │ History + REPL          │
├──────────────┴──────────────────┴────────────────────────┤
│  Chrome Lifecycle Manager                                 │
│  (launch, health-check, auto-restart, port detection)     │
└──────────────────────────────────────────────────────────┘
```

### Memory Model

- **Arena-per-request** — all per-request memory freed in one `deinit()` call
- **No GC** — `GeneralPurposeAllocator` in debug mode catches every leak
- **Proper cleanup chains** — `Launcher → Bridge → CdpClients → HarRecorders → Snapshots → Tabs`
- **`errdefer` guards** — partial failures roll back cleanly

### Chrome Lifecycle

| Mode | Behavior |
|------|----------|
| **Managed** (no `CDP_URL`) | Launches Chrome headless, finds free CDP port, supervises, auto-restarts on crash (max 3 retries), kills on shutdown |
| **External** (`CDP_URL` set) | Connects to existing Chrome, health-checks via `/json/version`, does NOT kill on shutdown |

---

## 📁 Structure

```
kuri/
├── build.zig                  # Build system (Zig 0.15.2)
├── build.zig.zon              # Package manifest + QuickJS dep
├── src/
│   ├── main.zig               # CDP server entry point
│   ├── fetch_main.zig         # kuri-fetch CLI entry point
│   ├── browse_main.zig        # kuri-browse CLI entry point
│   ├── js_engine.zig          # QuickJS wrapper + DOM stubs
│   ├── bench.zig              # Benchmark harness
│   ├── chrome/
│   │   └── launcher.zig       # Chrome lifecycle manager
│   ├── server/
│   │   ├── router.zig         # HTTP route dispatch (40+ endpoints)
│   │   ├── middleware.zig     # Auth (constant-time comparison)
│   │   └── response.zig      # JSON response helpers
│   ├── bridge/
│   │   ├── bridge.zig         # Central state (tabs, CDP, HAR, snapshots)
│   │   └── config.zig         # Env var configuration
│   ├── cdp/
│   │   ├── client.zig         # CDP WebSocket client
│   │   ├── websocket.zig      # WebSocket frame codec
│   │   ├── protocol.zig       # CDP method constants
│   │   ├── actions.zig        # High-level CDP actions
│   │   ├── stealth.zig        # Bot detection bypass
│   │   └── har.zig            # HAR 1.2 recorder
│   ├── snapshot/
│   │   ├── a11y.zig           # A11y tree with interactive filter
│   │   ├── diff.zig           # Snapshot delta diffing
│   │   └── ref_cache.zig      # @eN ref → node ID cache
│   ├── crawler/
│   │   ├── validator.zig      # SSRF defense, URL validation
│   │   ├── markdown.zig       # HTML → Markdown (SIMD tag counting)
│   │   ├── fetcher.zig        # Page fetching
│   │   ├── extractor.zig      # Readability extraction
│   │   └── pipeline.zig       # Parallel crawl pipeline
│   ├── storage/
│   │   ├── local.zig          # Local file writer
│   │   └── r2.zig             # R2/S3 uploader
│   ├── util/
│   │   └── json.zig           # JSON helpers
│   └── test/
│       ├── harness.zig        # Test HTTP client
│       ├── integration.zig    # Integration tests
│       └── merjs_e2e.zig      # E2E tests
└── js/
    ├── stealth.js             # Bot detection bypass
    └── readability.js         # Content extraction
```

---

## ⚙️ Configuration

| Env Var | Default | Description |
|---------|---------|-------------|
| `HOST` | `127.0.0.1` | Server bind address |
| `PORT` | `8080` | Server port |
| `CDP_URL` | *(none)* | Connect to existing Chrome (`ws://127.0.0.1:9222`) |
| `KURI_SECRET` | *(none)* | Auth secret for API requests |
| `STATE_DIR` | `.kuri` | Session state directory |
| `REQUEST_TIMEOUT_MS` | `30000` | HTTP request timeout |
| `NAVIGATE_TIMEOUT_MS` | `30000` | Navigation timeout |
| `STALE_TAB_INTERVAL_S` | `30` | Stale tab cleanup interval |
| `NO_COLOR` | *(none)* | Disable colored CLI output |

---

## 💰 Token Cost

For a 50-page monitoring task (from Pinchtab benchmarks):

| Method | Tokens | Cost ($) | Best For |
|--------|--------|----------|----------|
| `/text` | ~40,000 | $0.20 | Read-heavy (13× cheaper than screenshots) |
| `/snapshot?filter=interactive` | ~180,000 | $0.90 | Element interaction |
| `/snapshot` (full) | ~525,000 | $2.63 | Full page understanding |
| `/screenshot` | ~100,000 | $1.00 | Visual verification |

---

## 🤝 Contributing

Open an issue before submitting a large PR so we can align on the approach.

```bash
git clone https://github.com/justrach/agentic-browdie.git
cd agentic-browdie
zig build test         # 230+ tests must pass
zig build test-fetch   # kuri-fetch tests (66 tests)
zig build test-browse  # kuri-browse tests
```

See [CONTRIBUTORS.md](CONTRIBUTORS.md) for guidelines.

---

## Credits

| Project | What we borrowed |
|---------|-----------------|
| [agent-browser](https://github.com/vercel-labs/agent-browser) | `@eN` ref system, snapshot diffing, HAR recording patterns |
| [Pinchtab](https://github.com/pinchtab/pinchtab) | Browser control architecture for AI agents |
| [Pathik](https://github.com/justrach/pathik) | High-performance crawling patterns |
| [QuickJS-ng](https://github.com/nicklausw/quickjs-ng) via [mitchellh/zig-quickjs-ng](https://github.com/mitchellh/zig-quickjs-ng) | JS engine for `kuri-fetch` |
| [Lightpanda](https://github.com/lightpanda-io/browser) | Zig-native headless browser pioneer, CDP compatibility patterns |
| [Zig 0.15.2](https://ziglang.org) | The whole stack |

## License

Apache-2.0
