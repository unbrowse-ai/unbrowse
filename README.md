# Unbrowse

**Your agent uses websites without a browser.**

Unbrowse runs on your own computer. The first time your agent needs something from a site, Unbrowse opens the page
once, finds the request the site's own app makes, and keeps it. After that, your agent makes that request directly:
plain HTTP, no browser, no page to read.

On a site it has learned, Unbrowse is up to 100× faster than driving a browser. Across 94 sites, an uncached answer took
950 ms on average, against 3,404 ms for a browser agent ([research paper](https://arxiv.org/abs/2604.00694)). A cached
answer comes back in about 67 ms.

[Download](#install) ·
[Releases](https://github.com/unbrowse-ai/unbrowse/releases) ·
[Install the MCP](docs/install-mcp.md) ·
[Moving from the hosted version](docs/upgrade.md) ·
[Architecture (AGENTS.md)](AGENTS.md) ·
[Contributing](CONTRIBUTING.md) ·
[Security](SECURITY.md)

## Install

Download the app for your computer:

| Your computer | Download |
|---|---|
| Mac with Apple silicon | [Unbrowse-13.21.0-installers.3-macos-arm64.dmg](https://github.com/unbrowse-ai/unbrowse/releases/download/v13.21.0-installers.3/Unbrowse-13.21.0-installers.3-macos-arm64.dmg) |
| Mac with Intel | [Unbrowse-13.21.0-installers.3-macos-x64.dmg](https://github.com/unbrowse-ai/unbrowse/releases/download/v13.21.0-installers.3/Unbrowse-13.21.0-installers.3-macos-x64.dmg) |
| Windows (x64) | [Unbrowse-13.21.0-installers.3-windows-x64-setup.exe](https://github.com/unbrowse-ai/unbrowse/releases/download/v13.21.0-installers.3/Unbrowse-13.21.0-installers.3-windows-x64-setup.exe) |
| Linux, Debian or Ubuntu (x64) | [unbrowse_13.21.0-installers.3_amd64.deb](https://github.com/unbrowse-ai/unbrowse/releases/download/v13.21.0-installers.3/unbrowse_13.21.0-installers.3_amd64.deb) |
| Linux, Debian or Ubuntu (ARM) | [unbrowse_13.21.0-installers.3_arm64.deb](https://github.com/unbrowse-ai/unbrowse/releases/download/v13.21.0-installers.3/unbrowse_13.21.0-installers.3_arm64.deb) |

Every file with its SHA-256 is on [the release](https://github.com/unbrowse-ai/unbrowse/releases/tag/v13.21.0-installers.3); the step-by-step guide is at [unbrowse.ai/#install](https://unbrowse.ai/#install).

Open the app. The Unbrowse window starts the node on your computer (its MCP server is `http://127.0.0.1:7788/mcp`),
then its Connect screen adds Unbrowse to the agents it finds (Claude Code, Claude Desktop, Cursor, Codex) and gives you
a remote MCP address for an agent on another machine. No terminal, Node or npm.

- **Mac:** open the disk image and drag Unbrowse onto Applications. It is signed ad hoc, not notarized, so open it the
  first time by hand: right-click it and choose Open, or on macOS 15 and later, after the warning, System Settings >
  Privacy & Security > Open Anyway.
- **Windows:** run the setup. It installs for your user alone, with no administrator prompt, and opens Unbrowse when it
  finishes. It is not code-signed, so SmartScreen asks once: More info, then Run anyway.
- **Linux:** `sudo apt install ./unbrowse_13.21.0-installers.3_amd64.deb`, then open Unbrowse from your apps menu. The window needs GTK 4.

These installers do not update themselves yet: download the newer one when it ships.

### Or with npm

You need Node 20.3 or newer, on macOS, Linux or Windows.

```bash
npm i -g unbrowse
unbrowse connect
```

`unbrowse connect` starts Unbrowse on your machine and adds it to Claude Code. Restart Claude Code and ask it to get
something from a website. `unbrowse app` opens the window; `unbrowse start` runs the node without it. For Codex,
Cursor, VS Code, Gemini, Zed and other agents, see [Install the Unbrowse MCP](docs/install-mcp.md).

npm fetches the programs for the machine it installs on: macOS (Apple silicon and Intel), Linux (x64 and arm64, glibc
2.35 or later) and Windows (x64). That brings the app, the node, `unb`, the agent skill and the client, and no browser:
the node fetches its browser the first time a goal needs one (or `unbrowse browser install` fetches it now;
[docs/guides/the-browser.md](docs/guides/the-browser.md)). A full release, from npm or the
`unbrowse-<version>-linux-<arch>.tar.gz` and `unbrowse-<version>-windows-x64.zip` archives on
[Releases](https://github.com/unbrowse-ai/unbrowse/releases), keeps itself up to date and runs on Arc testnet. Foundry's Anvil (`foundryup`) is needed only for
test mode, the local devnet: the default of a build from source, or a node whose `chain` setting is `devnet`.

## Used the hosted version?

Unbrowse used to run on our servers. That service closed in November 2026. An old agent setup that still points at it hears the two
commands above in reply. If you set Unbrowse up with version 12 or earlier, run them. `unbrowse connect` finds your old
setup, asks before changing it, keeps a copy, and can undo the move. Logins you saved on the hosted service did not move
to your machine; [Moving to the new Unbrowse](docs/upgrade.md) says how to add the ones you need.

## How it works

A **route** is one learned call: the request, every value it needs traced to where it comes from, and the caller's
values as inputs. An agent says what it wants; the node calls the route that does it, or learns one and calls that.

```
agent ── HTTP / MCP ──▶ unbrowse-node ──▶ the site's own API      (a route, plain HTTP)
                            │
                            └── links unbrowse-browser/core ──▶ Chrome   (once, to learn the route)
```

Your sign-ins stay on your computer, in your system's own keystore.

## Choose a starting point

| Goal | Start here |
|---|---|
| Use it | [Install](#install) |
| Connect an agent (Claude Code, Cursor, …) | [Install the Unbrowse MCP](docs/install-mcp.md), or [Connect an agent](#connect-an-agent) |
| Move from the hosted version | [docs/upgrade.md](docs/upgrade.md) |
| Build from this repo | [Run from source](#run-from-source) |
| Change the code | The [repository map](#whats-here), then the `README.md` in the directory you are touching |
| Understand the idea | [docs/concepts/](docs/concepts/why-unbrowse.md): the concepts in plain words, from the papers, each ending with what the code does today and where it differs |
| Read the design | [papers/](papers/README.md): the whitepaper, the economy, selection and the protocol specification, which is normative for the design |
| Understand how it works | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): the whole system with diagrams — pipeline, keys, peer network, payments; [AGENTS.md](AGENTS.md) for the pattern and rules |
| Know what it costs, and where fees go | [docs/MONEY.md](docs/MONEY.md): what each action costs, measured; the fee split; paying your own way |
| Start as a new owner, from install to first earnings | [docs/ONBOARDING.md](docs/ONBOARDING.md); every command in [docs/CLI.md](docs/CLI.md); all the docs, and the order to read them, in [docs/README.md](docs/README.md) |
| Fix something that broke | [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md): symptom, cause, fix |
| Contribute | [CONTRIBUTING.md](CONTRIBUTING.md); report vulnerabilities privately per [SECURITY.md](SECURITY.md) |

## Run from source

The node runs on macOS, Linux and Windows. Its root key lives in the system's keystore (the Keychain, Windows'
Credential Manager, or the Secret Service on Linux; on a Linux machine with no desktop session,
`~/.unbrowse/root.key`, readable by its user alone). The node browses in Chrome or any other Chromium browser on the
machine, and downloads Chrome for Testing the first time a goal needs a browser and there's none.

Toolchain, the versions CI pins ([.github/workflows/ci.yml](.github/workflows/ci.yml)):

| Tool | Version | For |
|---|---|---|
| Rust | stable | the node, `unb`, the browser |
| [Foundry](https://getfoundry.sh) (`anvil`) | latest (`foundryup`) | test mode, the node's local payment chain |
| Zig | 0.17.0 | the window |
| Bun | 1.4.3 | the browser dashboard's tests |
| Node | 22 | the TypeScript SDK and skill |

```bash
# The browser the node drives (its own build and tests: unbrowse-browser/)
cargo build --release --manifest-path unbrowse-browser/cli/Cargo.toml

# The node. Its TLS stack is BoringSSL patched to match Chrome's handshake, vendored once by a script
cd unbrowse-node
sh scripts/apply-tls-patch.sh
cargo run --bin unbrowse-node

# The window, in another terminal (it starts the node itself if nothing answers)
cd unbrowse-node/window && zig build run
```

The node listens on `127.0.0.1:7788` and keeps everything under `~/.unbrowse` (`UNBROWSE_HOME` moves it).

A release install puts **one command, `unbrowse`**, on `PATH`: it runs the node and forwards the node's own commands to
it (`unbrowse vault …`, `unbrowse agent …`, `unbrowse passkey …`, `unbrowse session …`, `unbrowse telemetry …`), and an
agent's `do`/`browse`/`search`/`connect` to `unb`.

```bash
unbrowse agent new my-agent        # an agent key; prints its setup once
unbrowse vault import export.csv   # a browser's or password manager's login export
unbrowse session import github.com # a site's signed-in session (add --from cookies.txt for an exported file)
unbrowse passkey import keys.json  # passkeys a password manager exported
```

From this source build there is no `unbrowse` wrapper (it ships in the `unbrowse` npm package): run the binaries the build
left at `target/release/` — `unbrowse-node <command>` and `unb <command>`. Each directory has its own build and tests;
[unbrowse-node/README.md](unbrowse-node/README.md) is the one to read next, and lists every node command.

## Connect an agent

On a fresh machine, `npm i -g unbrowse && unbrowse connect` is enough for Claude Code: `connect` starts the node if
it isn't running and registers the agent the node made on its first run. For another agent, make a key (in the
window: Money, Add agent; or `unbrowse agent new <name>`), then point an MCP client at the node with the key's
token:

```bash
# Claude Code
claude mcp add --scope user unbrowse --env UNBROWSE_NODE=http://127.0.0.1:7788 -- unb mcp --agent first   # unb mcp signs each request with the token, which never goes over the wire

# Any other MCP client, or the CLI
export UNBROWSE_NODE=http://127.0.0.1:7788
export UNBROWSE_AGENT_TOKEN="$(unbrowse agent token)"
unbrowse connect                        # starts the node if needed, registers your first agent with Claude Code
```

Claude Code, Codex, OpenClaw, Hermes Agent and ElizaOS also take the node as a plugin, with the skill:
[integrations/](integrations/README.md).

The node serves MCP at `POST /mcp` and the same actions over HTTP on `127.0.0.1:7788`
([unbrowse-node/README.md](unbrowse-node/README.md#the-agent-api)). A global `npm install` also puts the agent skill in
`~/.claude/skills/unbrowse`.

Some routes belong to other people's nodes and carry a fee, paid from the node's balance in dollars; what each action costs, and where the money goes, is in [docs/MONEY.md](docs/MONEY.md). `unbrowse money` prints the balance, each agent's daily limit and earnings.

## What's here

A polyglot repository, not a single-language monorepo. Each directory is its own build with its own `README.md` —
**read the nearest one before changing the code there.**

| Directory | What it is | Language | Guide |
|---|---|---|---|
| [`unbrowse-node/`](unbrowse-node) | The node: the agent API (HTTP and MCP on 127.0.0.1), the route learner, the vault, payments, and the window | Rust, Zig, TypeScript | [README](unbrowse-node/README.md) |
| [`unbrowse-browser/`](unbrowse-browser) | The browser the node learns from: a fork of agent-browser that records every request and typed value | Rust | [AGENTS](unbrowse-browser/AGENTS.md) |
| [`unbrowse-sdk/`](unbrowse-sdk) | `unbrowse` for npm and PyPI: the node, its browser, the agent skill and the client in one package | TypeScript, Python | [README](unbrowse-sdk/README.md) |
| `unbrowse-settlement/` (private repository) | The settlement contracts that pay contributors, sites and the network for each call | Solidity | private |
| [`unbrowse-telemetry/`](unbrowse-telemetry) | The worker that takes nodes' anonymous usage events ([what is sent](#usage-telemetry)) | JavaScript | [README](unbrowse-telemetry/README.md) |
| [`skills/`](skills) | Agent skills that teach an agent to use the node | Markdown | [README](skills/README.md) |
| [`integrations/`](integrations) | The node as a plugin for Claude Code, Codex, OpenClaw, Hermes Agent and ElizaOS | TypeScript, Python | [README](integrations/README.md) |
| [`papers/`](papers) | The design: the whitepaper, the economy, selection and the protocol specification, as Markdown and PDF | Markdown, PDF | [README](papers/README.md) |
| [`docs/`](docs) | The docs: concepts, getting started, guides, reference, and the system docs | Markdown | [README](docs/README.md) |

The architecture, with diagrams of the pipeline, keys, peer network and payments, is in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md); what each action costs and where the money goes is in
[docs/MONEY.md](docs/MONEY.md). The two repository-wide guides sit at the root: [AGENTS.md](AGENTS.md) explains the pipeline and the rules learned
building it; [CLAUDE.md](CLAUDE.md) adds the one rule every change follows — fixes are general, never written for one
site. CI runs every directory's tests ([.github/workflows/ci.yml](.github/workflows/ci.yml)); work lands on `staging`,
is cut into `release/X.Y` branches and ships to `main` as tagged semantic versions
([CONTRIBUTING.md](CONTRIBUTING.md#branches-and-releases)).

## Usage telemetry

The node tells Unbrowse how it is used, so we can show the network is used and fix what breaks. It is on by default
in a release while the node is on the network (a node you keep off the network sends nothing; a build from source sends nothing
unless `UNBROWSE_TELEMETRY=1`), it says so when it starts, and one command turns it off:

```bash
unbrowse-node telemetry off      # kept in ~/.unbrowse/telemetry.json; `unbrowse-node telemetry` shows the state
UNBROWSE_TELEMETRY=0             # in the environment: off, whatever the file says
```

**What is sent**, in batches to `telemetry.unbrowse.ai` ([`unbrowse-telemetry/`](unbrowse-telemetry)), and nothing else:

| Field | What it is |
|---|---|
| `event` | `node_start` (the node started), `tool_call` (an agent called a tool), `route_failed` (a route the node keeps ran and failed) or `fetch_failed` (a paid fetch of another node's route failed) |
| `version`, `os` | the node's version, and `macos`, `linux` or `windows` |
| `install_id` | a random id drawn once for this install, tied to nothing else: not your identity, account, machine or name |
| `tool` | which agent tool or API route: `unbrowse_do`, `unbrowse_call`, `/v1/routes/{id}/call`, … (never which route) |
| `outcome`, `error_class` | `ok`, `failed` (the site's call failed) or `error` (the node refused it), and a coarse class: `not_found`, `forbidden`, `site`, …; for a failed route or fetch, the kind of failure from a fixed list (`http`, `door`, `shape_mismatch`, `no_body`, …) |
| `duration_ms` | how long the call took |

**Never sent:** URLs, sites or host names, page content, requests or answers, route ids, goals or inputs, cookies,
passwords, passkeys, vault entries, keys, wallet addresses, user or machine names, or your IP address. Every field and
value is checked against a fixed list before it is queued, and again by the worker, which refuses a batch with any
other field or anything that looks like an address. The worker keeps each event and the hour it arrived; it never
reads or keeps the caller's IP address.

**Your linked wallet.** Unbrowse uses no API keys, and needs no account: the node has its own wallet. If you link a
wallet of yours to the node (with email or Google, or your own), the node also sends the site three events while telemetry is on: `node_started`, `owner_linked` and
`owner_unlinked`. Each is signed by the node's key and names the node's address and your account's address, so a
count belongs to a node that really sent it and the account that owns it (`unbrowse-node/app/src/link.rs`,
`link::tell`). They never name a site, route or input. A node you haven't linked sends none, and `telemetry off`
stops them too. The usage counts above stay as they are: no account, only the random install id.

Telemetry never slows the node: an event is queued without waiting, a full queue drops it, and a batch the worker
doesn't take within a few seconds is dropped, never retried. With the worker down, everything works the same.

## Bug reports

Agents notice what the node can't: a result for another repository than the one asked for, a block page answered as
`ok: true`, a call that only worked with a workaround. So an agent reports it, with `unbrowse_report` (MCP),
`POST /v1/report`, `unb report` or `report()` in the SDKs, and carries on. The node scrubs the report, adds what it
knows, and sends it to the relay at `telemetry.unbrowse.ai` ([`unbrowse-telemetry/`](unbrowse-telemetry)), which files
it as a **public issue** on [unbrowse-ai/unbrowse](https://github.com/unbrowse-ai/unbrowse/issues) labelled
`agent-report`. Reports of the same problem share one issue, which counts them: the same kind, tool, route shape,
page host and last failed call, as the node says them (an agent's own words never split or join problems). A problem
whose issue was closed opens a new one. The node also reports a few problems it notices itself: a crash, an internal error, a route that still failed
after its page was walked again.

Reports are off until you turn them on (`unbrowse-node reports on`), since each becomes a public issue. Once on, they
follow telemetry: off in a build from source unless `UNBROWSE_REPORTS=1`, and off whenever telemetry is.

**An agent's report waits for you.** An agent writes its own words into a report, and a page it read can steer what it
writes, so nothing an agent reports leaves until you have read it, scrubbed, in your window and sent it
(`reports_waiting`, then `report_send`, which the node asks you about in its own dialog with the report's text shown,
or `report_discard`). The agent is told its report waits (`waiting_for_owner`). Reports the node makes itself carry no
words from a site, and are sent as before.

```bash
unbrowse-node reports on         # opt in; `reports off` turns them off again
unbrowse-node reports off        # kept in ~/.unbrowse/reports.json, and a running node stops at once; `unbrowse-node reports` shows the state
UNBROWSE_REPORTS=0               # in the environment: off, whatever the file says
```

**What a report holds**, and nothing else (the relay refuses any other field):

| Field | What it is |
|---|---|
| `kind` | `wrong_data`, `false_success`, `failed`, `slow`, `confusing` or `other` |
| `summary`, `expected`, `got`, `goal`, `error` | the agent's words, scrubbed and cut to 140 to 1,500 characters |
| `url` | the page's scheme, site and path template (below); never its query or fragment |
| `tool` | which agent tool gave the wrong answer |
| `route` | the route's shape: method, site, path template, input names, whether it writes, its step count |
| `last_error` | the agent's last failed call in the past ten minutes: its tool, class, and the status or kind of error the node saw (`Failed: step 2 of 2 answered 403`); never what the site said |
| `version`, `os`, `source` | the node's version and OS, and whether an agent or the node filed it |
| `install_id` | for the relay's limit of 20 reports an install a day; never published, kept only hashed with the day |

**Scrubbed before it leaves**, then again by the relay, after decoding what is encoded (`%40`, `\/`, `&#64;`) and
dropping hidden characters (zero-width, bidi): query strings and fragments, logins in URLs, emails, IP addresses,
numbers of nine digits or more however they are spaced (cards, phone numbers, national ids; four or more in a path),
hex, tokens and keys, the value of any field whose name says it's a secret (`password=`, `"api_key": …`, `code:`),
vault references, your home folder, user name, machine name and vault account names. A host keeps only the site's
own name: the names in front of it are `*` (`*.atlassian.net`), a machine on your network is `[internal]`, an
address `[ip]`. A route's or page's path keeps only plain lowercase words, templates and versions; anything else (a
handle, an id, a file name) is `{id}`. A route's input values and defaults, cookies, headers and bodies are never
read into a report, and nor is anything a site said: the node's own reports and `last_error` carry only the error's
kind and status. A report says which site the agent was using, never whose account.

The reply tells the agent what happened (`sent` with the issue's URL, `queued` while the relay can't be reached,
`already_sent` for a problem this node reported today, or `off`), what was scrubbed, and the report exactly as filed.
A queued report is sent within the next quarter hour, for up to a week.

## When a page needs you

The node gets past a site's defenses itself wherever it can, and says so plainly: a challenge, a bot check or a
clearance cookie is a step to satisfy, not a stop sign. A check an agent can see — an image grid, a slider, a queued
page — is met with `unbrowse_challenge`: the node shows the agent a picture of the page and takes its clicks one step
at a time, so the agent's own model reads the check and the page's own answer says whether it passed. Some pages only a
person can get past: a sign-in your vault has no login for, a two-step code, a check that renders only for a human.
An agent asks with `unbrowse_browse ["ask_owner", "sign in to LinkedIn"]`, and the app's **Browser** screen shows you
that page live: click and type on the picture as if it were the page, then press **Done, give it back**. You can open Browser any time without
being asked. Agents never see what you type, and the session stays in the site's profile, so the agent carries on signed
in ([unbrowse-node/README.md](unbrowse-node/README.md#the-owners-hands-on-a-page)).

A wall the node cannot clear is reported as `blocked`, never as data. Bypassing anti-bot is part of the product, done
openly; faking a success the site did not give is not.

## Website passkeys (on by default)

A headless browser has no authenticator, so a site that asks for a passkey ("verify it's you") stops an agent until a
person acts. The node keeps a site's passkey in its vault and answers that prompt itself. **This is on by default.**
When **you** sign in on a page by hand (you take it over when the agent asks, and give it back done) and the site then
offers to make a passkey (its "add a passkey?" prompt after sign-in, or one it makes on its own), the node accepts it
and keeps it, with no further step from you. A vault login an *agent* fills arms nothing: a passkey signs in as you
with no password and no second factor, so one an agent could make would be a credential stronger than its own key —
and every key on the node as strong as the weakest of them. A site
that never offers one gets none: the node doesn't go into a site's settings to make one. The passkey is sealed in the
vault under a key derived from the root key, and it never goes to the network, a peer or a log. The node says so the
first time it starts, and `unbrowse-node passkey list` shows every passkey it holds and whether it was enrolled
automatically (`auto`) or by you (`manual`). A passkey a password manager exported (Bitwarden, CXF, KeePassXC) can
be imported too (`unbrowse passkey import <file>`); iCloud Keychain, Google Password Manager, Windows Hello and security
keys don't let one out.

**The risk, plainly: any site the node signs in to may get a passkey registered on your account, and whoever
controls your node can then sign in as you there.** That includes any agent holding one of its keys, since agents
drive the node's browser and the node answers the passkey prompt for them, with no prompt to you and no second
factor: the passkey is the second factor. A Google (Gmail) account is the highest-value target there is: it resets
the passwords of most of your other accounts, so a node holding its passkey can reach them too. Keep the node on a
machine you alone control, and check the activity log (every enrolment and every sign-in with a stored passkey is a
line there).

**To opt out:** `unbrowse-node passkey off` (or `UNBROWSE_PASSKEYS=0`) for every site, or `unbrowse-node passkey never
<site>` for one (`passkey allow <site>` undoes it); `passkey never google.com` is the one to consider first. To delete
a passkey: `unbrowse-node passkey remove <id>`, then on the site's account page (security, passkeys) delete it there
too, or the site keeps accepting it; on Google that is `https://myaccount.google.com/signinoptions/passkeys`. More:
[unbrowse-node/README.md](unbrowse-node/README.md#website-passkeys-on-by-default).

## Contributing and security

See [CONTRIBUTING.md](CONTRIBUTING.md). Report vulnerabilities privately, as [SECURITY.md](SECURITY.md) describes,
never in a public issue.

## Licence

[Apache-2.0](LICENSE). Copies and forks keep the [NOTICE](NOTICE) file. The licence covers the code, not the name:
a fork ships under its own name ([TRADEMARKS.md](TRADEMARKS.md)).

Third-party code keeps its own licence: agent-browser (Apache-2.0) in `unbrowse-browser/`; forge-std (MIT or
Apache-2.0) and OpenZeppelin (MIT) in `unbrowse-settlement/lib/`.
