# Unbrowse browser

The browser the Unbrowse node learns from. It records everything a site does while an agent uses it, so the node can do the same thing again later without a browser.

It's a fork of [agent-browser](https://github.com/vercel-labs/agent-browser) (Apache-2.0), kept as a thin patch so upstream updates rebase cleanly. [FORK.md](FORK.md) lists every change. Upstream's full command reference is in [README.upstream.md](README.upstream.md).

## Where it sits

```
agent-browser-core (core/)    the engine, as a library: CDP transport, Chrome launch, capture, mint
├── cli/                      the agent-browser CLI, a thin front end over the engine
└── unbrowse-node             links the engine for walks; runs the CLI for browsing by hand
```

Two ways the node uses it:

- **Walks.** To learn a route from a page, the node calls `agent_browser_core::session::mint()` in process: launch Chrome, open the page, let it settle, keep every request and response. No daemon, no socket.
- **Browsing by hand.** When an agent drives a page through the node (`unbrowse_browse` over MCP, `POST /v1/browse`, or `browser()` in the [node SDKs](../unbrowse-sdk)), the node runs this CLI with capture on, one session and one profile per site. The node learns routes from that log as the agent goes.

Agents use it through the node. A browser run directly, outside the node, records nothing the node can learn from.

## Build

Requires Rust and Chrome (or `agent-browser install` for Chrome for Testing).

```bash
cargo build --release --manifest-path cli/Cargo.toml   # cli/target/release/agent-browser
cargo test --manifest-path core/Cargo.toml             # the engine
cargo test --manifest-path cli/Cargo.toml              # the CLI (see "Tests" below)
```

The node finds the binary in this order, and never uses one on `PATH` (a build without capture would teach it nothing):

1. `UNBROWSE_BROWSER`
2. `agent-browser` beside the node's own executable
3. `cli/target/release/agent-browser`, then `cli/target/debug/agent-browser`

The node links `core/` directly (`unbrowse-node/crates/learn` depends on it by path), so building the node builds the engine.

## Capture

Set `UNBROWSE_CAPTURE_DIR` and every session appends to `<dir>/<session>.jsonl`, one JSON object per line. The node sets it for every browse; nothing needs a recording command.

```jsonc
// A finished request: a HAR 1.2 entry with the headers actually sent and received, cookies included, and text bodies.
{ "type": "exchange", "t": 1730000000.12, "resourceType": "XHR", "entry": { "request": { … }, "response": { … } } }

// A page-driving action, with what was typed and the field's own name for it.
{ "type": "action", "t": 1730000001.40, "action": "fill", "selector": "@e4", "field": "email", "value": "me@example.com", "secret": false }

// A WebSocket: open, handshake, accepted, each frame sent or received, closed.
{ "type": "socket", "t": 1730000002.03, "id": "1234.5", "event": "open", "url": "wss://chat.example.com/socket" }
```

What the fork adds to make the log enough to learn from:

- **Cookies.** Headers come from Chrome's `Network.*ExtraInfo` events, so `Cookie` and `Set-Cookie` are in the entry. The main network events leave them out.
- **POST bodies.** Bodies Chrome holds back are fetched with `Network.getRequestPostData`, so a POST-heavy flow (a checkout) keeps them.
- **Field names.** A typed field records its `name`, `id`, `aria-label`, label text or placeholder (first non-empty), so routes name inputs the way the page does, not by CSS selector.
- **Secrets marked.** A value typed into a password, one-time-code or card field carries `"secret": true`.
- **One clock.** Each request is stamped with the daemon's own clock when first seen, the same clock actions use. A request is written about 0.75 s after it finishes, because Chrome can report the cookies it sent after the response.

The log holds live cookies and tokens. Keep it on the machine; the repo ignores `*.jsonl` and `*.har`.

## The engine as a library

```rust
use agent_browser_core::session::{mint, walk_har, MintOptions};

let dir = std::path::PathBuf::from("/tmp/walks");
let session = mint(MintOptions {
    url: "https://example.com/search?q=rust".into(),
    session: "example".into(),
    capture_dir: Some(dir.clone()),
    profile: Some("/path/to/profiles/example.com".into()), // later walks open easier
    settle_ms: 3000,
    browse: true, // scroll and press "more" so a server-rendered page calls its data API
    ..Default::default()
})
.await?;

session.cookies; // what the walk earned, for plain HTTP to carry
let har = walk_har(&dir, "example"); // the walk as HAR 1.2
```

`mint()` returns an error, never a partial jar, when the walk didn't get past a check. Set `cdp_endpoint` to attach to a browser that's already open instead of launching one.

| Module | What it holds |
|---|---|
| `session` | `mint()`, `MintOptions`, `MintedSession`, `walk_har()`, `walk_page()`, `read_capture()` |
| `capture` | `CaptureLog`, the JSON-lines writer |
| `fingerprint` | the browser's identity: user agent and client hints, read from Chrome itself |
| `cdp` | transport, Chrome launch and discovery, protocol types |
| `intercept` | optional request interception that pins public addresses (off by default) |
| `screencast` | pictures of a walk while it runs, for the node's window |
| `connection`, `paths`, `ca_bundle` | timeouts, browser cache, TLS roots |

## Identity

The browser says what it is: Chrome, at the version it is.

- **Headless by default.** Chrome's headless build calls itself `HeadlessChrome`. The fork reports the same product and version without the launch mode, with client hints that agree, so a headless walk and a headed one present as the same browser. Nothing names a site, and nothing claims to be a different browser.
- **A window when a person is needed.** When a walk meets a check it can't pass, the headless browser closes and a headed one opens in the same profile. The person sees the check, and whatever the headless walk earned carries over. Sites the headless browser gets through never open a window.
- **One identity end to end.** The browser mints under the same user agent the node's plain-HTTP client presents.

## What it refuses

The fork leaves upstream's code in place and refuses these where they would take effect (`cli/src/unbrowse_policy.rs`):

| Feature | Why |
|---|---|
| The Obscura engine | Disguises itself as Chrome on Windows and fakes its fingerprint |
| Remote browser providers (Browserbase, Browserless, Browser Use, Kernel, AgentCore, plugin providers) | The user's sessions and traffic would leave their machine |
| `launch.mutate` plugins | How stealth and captcha plugins attach |
| `human` input mode | Moves the pointer along eased curves to look like a person |

Engines allowed: Chrome (default) and Lightpanda, which always launches with telemetry off.

## Runtime dir and reattach

A launch without `--profile` uses a fixed runtime dir, `~/.agent-browser/chrome-runtime-{headless,headed}`, not a random temp dir. Another daemon finds the browser a live one launched through the `DevToolsActivePort` file there (owner-only: it carries the debugger's secret).

- The browser's debugger is on a pipe only its launcher holds, served to other clients only at a secret address (FORK.md), so the runtime Chrome lives as long as the daemon that launched it. That daemon, leaving while another daemon uses the browser, stays to serve it and closes it once the last of them has gone; a crashed launcher takes it with it. `agent-browser close --all` shuts it down.
- Launch flags apply when the runtime Chrome first starts; a later daemon inherits them.
- Profile launches (`--profile`) copy the profile to a temp dir, as upstream does.

## Environment

| Variable | Read by | Effect |
|---|---|---|
| `UNBROWSE_CAPTURE_DIR` | CLI | Where each session's capture log goes. Unset: no capture. |
| `AGENT_BROWSER_RUNTIME_DIR` | CLI | Overrides the fixed runtime dir, to isolate a Chrome. |
| `UNBROWSE_BROWSER` | node | The `agent-browser` binary the node runs. |

Upstream's own variables are in [README.upstream.md](README.upstream.md).

## Commands

Through the node, an agent gets the page-driving commands: `open`, `snapshot`, `click`, `dblclick`, `fill`, `type`, `press`, `select`, `check`, `uncheck`, `hover`, `focus`, `scroll`, `scrollintoview`, `upload`, `get`, `is`, `find`, `wait`, `back`, `forward`, `reload`, `eval`, `screenshot`, `close`. The node refuses flags that would pick another browser, profile or session.

```bash
agent-browser open https://example.com
agent-browser snapshot -i            # interactive elements, each with a ref
agent-browser fill @e3 "me@example.com"
agent-browser click @e4
agent-browser get text @e1
agent-browser close
```

Every command, flag and option is in [README.upstream.md](README.upstream.md#commands).

## Tests

16 upstream tests fail by design: they exercise features the fork refuses, and the policy refuses them first. [FORK.md](FORK.md#upstream-tests-that-fail-by-design) lists them. Everything else passes; most ignored tests need a live browser.

## Updating from upstream

Upstream is the `upstream` remote, forked at `dac13bb` (0.39.1). Rebase onto it; when upstream changes its README, carry the change into `README.upstream.md`.

## Licence

Apache-2.0, as upstream. Lightpanda is AGPL-3.0: ship its unmodified binary as a separate process with its licence and source offer, and never link it into the node.
