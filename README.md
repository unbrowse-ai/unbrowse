# Unbrowse

**Browse once. Call directly forever. Earn when you share.**

Unbrowse turns websites into fast, direct API calls for your AI agents. The local node on your machine watches a page once in its browser, learns the website's own internal API call as a reusable **route**, and replays it over plain HTTP after that — no browser, milliseconds instead of seconds, and a fraction of the token cost.

[Download](#install) ·
[Docs](docs/README.md) ·
[Architecture](docs/ARCHITECTURE.md) ·
[Economy & Staking](docs/concepts/payments-and-unb.md) ·
[Releases](https://github.com/unbrowse-ai/unbrowse/releases) ·
[Contributing](CONTRIBUTING.md) ·
[Security](SECURITY.md)

---

## Why Unbrowse

Every website your browser opens already has an internal API that returns structured JSON. Browser agents waste seconds and burn context windows rendering HTML, ads, and popups on every single run.

Unbrowse learns the direct call once and reuses it:

```
agent ── HTTP / MCP ──▶ unbrowse-node ──▶ website's own API     (plain HTTP, no browser)
                            │
                            ├── links browser engine ──▶ Chrome  (once, to learn the route)
                            └── peer index ◀──▶ other nodes      (share & discover routes)
```

- **Fast & cheap:** A learned route is a single direct HTTP request — tens to hundreds of milliseconds instead of seconds of browser automation, with clean JSON instead of full-page HTML.
- **Local & private:** Your logins, cookies, passkeys, and wallet keys stay on your machine (in your OS keychain and local per-site cookie jars). Requests go directly from your machine to the site under your own session.
- **Earn while you browse and share to the index:** As you and your agents browse, your node automatically learns routes that work. Listing proven routes to the open peer-to-peer index is free — credentials and personal data are stripped before anything is shared. When other agents use a route you mapped, you earn in dollars (**USDC**).

> **How the economy works (short version):** Search is free, and running your own or cached routes is free. When another agent fetches a route from the index for the first time, it pays the route's fee once in dollars (USDC). Each passed fee splits **65% to the route** (its stakeholders, or the contributor directly before route staking opens), **30% to the website's domain escrow**, and **5% to buy and burn UNB**. Failed calls always cost $0.
>
> For the full breakdown of staking your routes, verification checks, ranking, and bounties, see [Payments, Staking & UNB](docs/concepts/payments-and-unb.md) and [Money](docs/MONEY.md). *(Note: local learning and calling are live today; paid settlement on Arc mainnet opens after audit, legal review, and the closed pilot.)*

---

## Install

Download the desktop app for your computer (always points to the latest release):

| Platform | Download |
|---|---|
| macOS (Apple silicon) | [Unbrowse-macos-arm64.dmg](https://github.com/unbrowse-ai/unbrowse/releases/latest/download/Unbrowse-macos-arm64.dmg) |
| Windows (x64) | [Unbrowse-windows-x64-setup.exe](https://github.com/unbrowse-ai/unbrowse/releases/latest/download/Unbrowse-windows-x64-setup.exe) |
| Linux, Debian / Ubuntu (x64) | [unbrowse_amd64.deb](https://github.com/unbrowse-ai/unbrowse/releases/latest/download/unbrowse_amd64.deb) |
| Linux, Debian / Ubuntu (ARM) | [unbrowse_arm64.deb](https://github.com/unbrowse-ai/unbrowse/releases/latest/download/unbrowse_arm64.deb) |

Checksums (`SHA256SUMS`) and standalone archives are on [the latest release](https://github.com/unbrowse-ai/unbrowse/releases/latest).

Open the app to start the local node (`http://127.0.0.1:7788/mcp`). Its **Agents** screen automatically connects installed clients (Claude Code, Claude Desktop, Cursor, Codex, VS Code, Gemini CLI, OpenCode, Hermes, OpenClaw, and more — [full list](docs/guides/connect-your-agent.md#agents-the-app-connects)) and gives ChatGPT and Claude on the web a remote address for your node.

- **macOS:** Open the `.dmg`, drag Unbrowse to Applications, and open it (signed and notarized).
- **Windows:** Run the installer (installs per-user with no admin prompt; if SmartScreen prompts, choose *More info → Run anyway*).
- **Linux:** `sudo apt install ./unbrowse_amd64.deb`, then launch Unbrowse (requires GTK 4).

### Or install via CLI (npm / Python)

Requires Node 20.3+:

```bash
npm install -g unbrowse
unbrowse app          # start the desktop app and local node
unbrowse start        # or run the node headless
unbrowse connect      # register the local MCP server with Claude Code (--client all for Cursor, Codex, Claude Desktop)
```

The install brings the node, desktop app, `unb` CLI, SDK, and agent skill — with no bundled browser. The node fetches its browser add-on automatically the first time a task needs one (or run `unbrowse browser install`; see [The browser add-on](docs/guides/the-browser.md)). Python wheels are attached to each [release](https://github.com/unbrowse-ai/unbrowse/releases).

### Your first call

```bash
unbrowse do "search Rust crates" --url "https://crates.io/search?q=tokio"
```

The first call walks the page, learns the underlying API route, and returns JSON. Every call after that — including with new inputs (`?q=serde`) — runs as plain HTTP with no browser.

---

## Connect an agent

The app's **Agents** screen or `unbrowse connect` handles setup automatically. To connect manually or create a dedicated key for another agent:

```bash
unbrowse agent new my-agent        # creates a capped agent key and prints its setup once

# Claude Code (MCP over stdio; signs each request locally so the token never crosses the wire)
claude mcp add --scope user unbrowse --env UNBROWSE_NODE=http://127.0.0.1:7788 -- unb mcp --agent first

# CLI or SDK
export UNBROWSE_NODE=http://127.0.0.1:7788
export UNBROWSE_AGENT_TOKEN="$(unbrowse agent token)"
```

Native plugins with built-in agent skills are also available for Claude Code, Codex, OpenClaw, Hermes Agent, and ElizaOS — see [integrations/](integrations/README.md).

### Useful local commands

```bash
unbrowse vault import export.csv     # import logins from a browser or password manager CSV/JSON
unbrowse session import github.com   # import your browser's cookies for one site
unbrowse passkey import keys.json    # import exportable passkeys (Bitwarden, CXF, KeePassXC)
unbrowse money                       # check balance, agent daily limits, and earnings
unbrowse share                       # view or change automatic sharing to the index
```

---

## Where to read next

| Goal | Start here |
|---|---|
| Understand the concept | [Why Unbrowse](docs/concepts/why-unbrowse.md) → [How it works](docs/concepts/how-it-works.md) |
| Earn while browsing & sharing | [From install to first earnings](docs/ONBOARDING.md) · [Sharing routes](docs/SHARING.md) |
| Stake your routes & economy details | [Payments, Staking & UNB](docs/concepts/payments-and-unb.md) · [Search & Ranking](docs/concepts/search-and-ranking.md) · [Money](docs/MONEY.md) |
| Deep architecture & peer network | [Architecture](docs/ARCHITECTURE.md) · [The peer network](docs/NETWORK.md) |
| Connect an agent or SDK | [Connect your agent](docs/guides/connect-your-agent.md) · [CLI & API reference](docs/CLI.md) · [SDKs](unbrowse-sdk/README.md) |
| Research papers & protocol spec | [papers/](papers/README.md) |
| Something broke | [Troubleshooting](docs/TROUBLESHOOTING.md) |
| Contribute to the codebase | [Contributing](CONTRIBUTING.md) · [AGENTS.md](AGENTS.md) |

All documentation in reading order is indexed in [docs/README.md](docs/README.md).

---

## Repository map

Unbrowse is a polyglot repository where each top-level directory has its own build, tests, and `README.md`:

| Directory | What it is | Language | Guide |
|---|---|---|---|
| [`unbrowse-node/`](unbrowse-node) | The local node: HTTP & MCP API (`127.0.0.1:7788`), route learner, vault, peer network, wallet, and native desktop window | Rust, Zig | [README](unbrowse-node/README.md) |
| [`unbrowse-browser/`](unbrowse-browser) | Browser automation engine (`agent-browser-core`) linked directly into the node to record walks | Rust | [README](unbrowse-browser/README.md) · [FORK](unbrowse-browser/FORK.md) |
| [`unbrowse-sdk/`](unbrowse-sdk) | TypeScript (`unbrowse`) and Python SDKs, CLI wrapper, and agent framework adapters | TypeScript, Python | [README](unbrowse-sdk/README.md) |
| [`integrations/`](integrations) | Native plugins for Claude Code, Codex, OpenClaw, Hermes Agent, and ElizaOS | TypeScript, Python | [README](integrations/README.md) |
| [`skills/`](skills) | Agent skills teaching models how to use Unbrowse effectively | Markdown | [README](skills/README.md) |
| [`unbrowse-telemetry/`](unbrowse-telemetry) | Privacy-preserving telemetry worker and scrubbed bug-report relay | JavaScript | [README](unbrowse-telemetry/README.md) |
| [`unbrowse-rpc/`](unbrowse-rpc) | Chain RPC and solver relay for signed-in nodes | JavaScript | [README](unbrowse-rpc/README.md) |
| [`papers/`](papers) | Whitepaper, economy paper, selection paper, protocol specification, and benchmark paper | Markdown, PDF | [README](papers/README.md) |
| [`docs/`](docs) | Concepts, guides, reference, and system documentation | Markdown | [README](docs/README.md) |

---

## Build from source

Requires Rust (stable), [Foundry](https://getfoundry.sh) (`anvil`, for local test mode), Zig 0.17.0 (for the desktop window), Node 22 (for the TypeScript SDK), CMake (and NASM on Windows, for BoringSSL), and Python 3.8+.

```bash
# 1. Build the browser CLI
cargo build --release --manifest-path unbrowse-browser/cli/Cargo.toml

# 2. Vendor Chrome-shaped BoringSSL TLS patches once, then run the node
cd unbrowse-node
sh scripts/apply-tls-patch.sh
cargo run --bin unbrowse-node

# 3. Optional: launch the native desktop window in another terminal
cd unbrowse-node/window && zig build run
```

Source builds run in **test mode** on a local Anvil devnet by default and store state under `~/.unbrowse` (override with `UNBROWSE_HOME`). On headless Linux or Windows servers without a desktop keystore, set `UNBROWSE_ROOT_KEY_FILE=1` (keep the folder readable by your user only). See [unbrowse-node/README.md](unbrowse-node/README.md) for full build details.

---

## Security, privacy & human handoff

- **Human-in-the-loop when needed:** The node handles bot checks and challenges openly when it can (`unbrowse_challenge`). When a page truly requires a human (a new login, 2FA code, or checkout), an agent calls `unbrowse_browse ["ask_owner", "..."]` and the page appears live in the app's **Browser** screen. Agents never see what you type; the resulting session stays locally in the site's profile. A wall that cannot be cleared is reported honestly as `blocked`, never faked.
- **Website passkeys (on by default):** When *you* sign in to a site by hand and the site offers to register a passkey, the node seals it in your local vault so agents aren't blocked by passkey prompts later. Agent-filled logins never arm passkey enrollment. Because a stored passkey lets any agent with a key on your node sign in to that site without a second factor, run the node only on a machine you control and opt out where needed: `unbrowse-node passkey off`, `UNBROWSE_PASSKEYS=0`, or `unbrowse-node passkey never google.com`. Full risk disclosure and management commands: [unbrowse-node/README.md](unbrowse-node/README.md#website-passkeys-on-by-default).
- **Vulnerability disclosure:** Never report security vulnerabilities in a public issue — follow [SECURITY.md](SECURITY.md).

## Usage telemetry

Release builds on the network send anonymous usage counts so we can measure adoption and fix what breaks (a node kept off the network sends nothing; source builds send nothing unless `UNBROWSE_TELEMETRY=1`). Turn it off anytime:

```bash
unbrowse-node telemetry off      # saved in ~/.unbrowse/telemetry.json (`unbrowse-node telemetry` shows status)
UNBROWSE_TELEMETRY=0             # environment override: off regardless of the file
```

**What is sent**, in batches to `telemetry.unbrowse.ai` ([`unbrowse-telemetry/`](unbrowse-telemetry)), and nothing else:

| Field | What it is |
|---|---|
| `event` | `node_start` (the node started), `tool_call` (an agent called a tool), `route_failed` (a route the node keeps ran and failed), or `fetch_failed` (a paid fetch of another node's route failed) |
| `version`, `os` | the node's version, and `macos`, `linux`, or `windows` |
| `install_id` | a random id drawn once per install. By itself it names no person, account, or machine; if you link a wallet, the node's signed events to the site carry it too. |
| `tool` | which agent tool or API route: `unbrowse_do`, `unbrowse_call`, `/v1/routes/{id}/call`, … (never which route) |
| `outcome`, `error_class` | `ok`, `failed`, or `error`, and a coarse failure class from a fixed list (`http`, `door`, `shape_mismatch`, `no_body`, …) |
| `duration_ms` | how long the call took |
| `from` | on `node_start` only: the source tag the node was first started with (`unbrowse start --from <tag>` or `UNBROWSE_FROM`), kept once in `~/.unbrowse/from.json` |

**Never sent:** URLs, sites or host names, page content, requests or answers, route ids, goals or inputs, cookies, passwords, passkeys, vault entries, keys, wallet addresses, user or machine names, or your IP address.

**Your linked wallet:** If you link an optional wallet, the node sends `unbrowse.ai` three signed events while telemetry is on: `node_started`, `owner_linked`, and `owner_unlinked`. Each carries the node's address, your wallet, `install_id`, and — for `unbrowse.ai` sign-ins — your browser's visitor id (`ub_vid`, kept in `~/.unbrowse/owner.json`). `ub_vid` requires consent in the EU, EEA, UK, and Switzerland, has one-click opt-out elsewhere, and skips Global Privacy Control browsers. Turning telemetry off stops these events, and opting out at `unbrowse.ai/privacy` deletes joined data.

**Source tag:** Starting with `unbrowse start --from <tag>` or `UNBROWSE_FROM=<tag>` sends `from` on `node_start` while telemetry is on. Valid tags are 1 to 40 lowercase letters, digits and dashes starting with a letter or digit; invalid tags are ignored with a warning. The first tag is saved in `~/.unbrowse/from.json` and never replaced. Full details: [PRIVACY.md](PRIVACY.md) and [unbrowse-telemetry/README.md](unbrowse-telemetry/README.md).

## Bug reports

Agents can report broken or wrong responses with `unbrowse_report` (MCP), `POST /v1/report`, `unb report`, or `report()` in the SDKs. Reports are scrubbed locally (stripping inputs, cookies, headers, bodies, and internal hosts), wait for your approval in the app, and open public issues on `unbrowse-ai/unbrowse`. Disable anytime with `unbrowse-node reports off` or `UNBROWSE_REPORTS=0`.

---

## Licence

[Apache-2.0](LICENSE). Copies and forks keep the [NOTICE](NOTICE) file. The licence covers the code, not the name: a fork ships under its own name ([TRADEMARKS.md](TRADEMARKS.md)). Third-party code keeps its own licence (`agent-browser`, Apache-2.0, in `unbrowse-browser/`).
