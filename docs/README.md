# The docs

Every document in this repository that explains Unbrowse, what each is for, who it is for, and the order to read
them in. The same set, in the same order, is the GitBook table of contents in [SUMMARY.md](SUMMARY.md). Each
directory's own `README.md` is the detail for that code; the docs here cut across directories.

The design is in [`papers/`](../papers/README.md), and its protocol specification is normative for the design. The
concept pages explain it in plain words and end with what the code does today. Where a paper and the code differ, the
code is what runs, and these docs describe the code.

## Where to start

| You want to | Read, in order |
|---|---|
| Understand the idea | [Why Unbrowse](concepts/why-unbrowse.md), [How it works](concepts/how-it-works.md), then the rest of the concepts, and [the papers](concepts/papers.md) |
| Run a node and start earning | [Install and run](start/install.md), [Your first call](start/your-first-call.md), [ONBOARDING.md](ONBOARDING.md), then [CLI.md](CLI.md) when you need a command, and [TROUBLESHOOTING.md](TROUBLESHOOTING.md) when something breaks |
| Connect an agent | [Connect your agent](guides/connect-your-agent.md), [CLI.md §5](CLI.md#5-the-agent-api-and-mcp-tools), and [the agent skill](reference/the-skill.md) |
| Understand how it is built | [ARCHITECTURE.md](ARCHITECTURE.md), then [AGENTS.md](../AGENTS.md), then [NETWORK.md](NETWORK.md), [SHARING.md](SHARING.md) and [MONEY.md](MONEY.md) |
| Change the code | [CLAUDE.md](../CLAUDE.md) and [AGENTS.md](../AGENTS.md) (the rules), [ARCHITECTURE.md](ARCHITECTURE.md), [TESTING.md](TESTING.md), then the `README.md` of the directory you are changing |
| Run a network or cut a release | [OPERATIONS.md](OPERATIONS.md), then [MONEY.md](MONEY.md) |

## The docs, in reading order

| | Doc | What it is |
|---|---|---|
| **Why** | [Why Unbrowse](concepts/why-unbrowse.md) | The problem, what Unbrowse does about it, and what it is not |
| | [How it works](concepts/how-it-works.md) | Mint, walk, trace, route, call: browse once, call forever |
| | [Three parties, one node](concepts/the-node.md) | Agents, contributors and websites; what a node does; the fee split |
| | [Routes and the registry](concepts/routes-and-registry.md) | What a route and its body are, signed listings and roots, and the map kept peer to peer |
| | [Search and ranking](concepts/search-and-ranking.md) | How an entry is picked, what happens when it fails, and gaming |
| | [Payments, Staking & UNB](concepts/payments-and-unb.md) | USDC for use, staking your routes and UNB, failed uses, bounties, the burn, supply |
| | [Identity and the vault](concepts/identity-and-vault.md) | The wallet, the root key, agent keys, and sign-ins held by reference |
| | [Decentralised from launch](concepts/decentralised.md) | Admission by identity, changing a network nobody runs, and the chain |
| | [The papers](concepts/papers.md) | The papers, and where the code differs from each concept |
| **Start** | [Install and run](start/install.md) | Installing on each platform, what the node needs, running and pausing it |
| | [Your first call](start/your-first-call.md) | An agent key, then `unbrowse do`, from a shell, an agent or code |
| | [The app](start/the-app.md) | The window's screens, and what the node asks the owner |
| | [ONBOARDING.md](ONBOARDING.md) | From install to first earnings: the node's address, the Privy or own-wallet sign-in, paying its own way, and when an owner needs USDC of their own |
| **Guides** | [Connect your agent](guides/connect-your-agent.md) | Claude Code and any MCP client, the tools, and the key's limits |
| | [Unbrowse a site](guides/unbrowse-a-site.md) | Turning a site into a route, by asking or by driving the browser |
| | [Learn a route while browsing](guides/learn-a-route.md) | Watching a walk, what makes a good route, healing, and sharing |
| | [Sessions and passwords](guides/sessions-and-passwords.md) | Every import: passwords, a site's session, passkeys, cards |
| | [Updates and versions](guides/updates.md) | How a release node updates, and the network's minimum version |
| | [TROUBLESHOOTING.md](TROUBLESHOOTING.md) | Symptom, cause, fix |
| **Reference** | [CLI.md](CLI.md) | Every `unbrowse-node` command, the owner commands, the agent API and MCP tools, `unb`, environment variables and build flags |
| | [Node settings](reference/node-settings.md) | Every field of `settings.json`, its default and what sets it |
| | [The agent skill](reference/the-skill.md) | Where the skill is installed and what it teaches an agent |
| **System** | [ARCHITECTURE.md](ARCHITECTURE.md) | The map: the pieces, the pipeline from a walked page to a route, the door, keys and the vault, the peer network, the chain, end to end, with diagrams |
| | [NETWORK.md](NETWORK.md) | The peer network: libp2p and its protocols, admission, joining, site keys, listings and bodies, NAT, light mode, what a node publishes, failure behaviour |
| | [SHARING.md](SHARING.md) | What a route's body is and may never carry, signed listings, automatic sharing and its opt-outs, how a caller pays for and runs another's route, delisting |
| | [LISTINGS.md](LISTINGS.md) | Listing peer to peer: signed listings credited at first claim from posted roots, earliest root wins, `correctCredit`; what Settlement has, what the node still needs, gas, migration |
| | [MONEY.md](MONEY.md) | Every action that needs gas or tokens, measured; where a fee goes; paying its own way; decimals; known gaps |
| **Operating** | [OPERATIONS.md](OPERATIONS.md) | The operator's runbook: build flags, releases, deploying a network, the landing site, CI, running a node as a service, go-live checklists |
| | [TESTING.md](TESTING.md) | Every test suite and how to run it: cargo, the Anvil tests, forge and gas scripts, the SDKs, the UI, zig, the landing worker, the Antithesis harness |

## Elsewhere in the repository

| Doc | What it is |
|---|---|
| [papers/](../papers/README.md) | The design: the whitepaper, the economy, selection, the protocol specification, and the measured paper, as Markdown and PDF |
| [README.md](../README.md) | What Unbrowse is, installing, running from source, connecting an agent, the repository map |
| [AGENTS.md](../AGENTS.md) | The strategy and the pattern: how a walk becomes a route, the door, the network's rules, fixes that are general, pushing and watching CI, the anti-patterns |
| [CLAUDE.md](../CLAUDE.md) | The same file as AGENTS.md, byte for byte (CI runs `cmp`) |
| [CONTRIBUTING.md](../CONTRIBUTING.md) | How to contribute, to the code, the papers and the docs |
| [SECURITY.md](../SECURITY.md) | How the node keeps secrets, the threat model, updates, what isn't defended, and reporting a vulnerability |
| [PRIVACY.md](../PRIVACY.md), [TERMS.md](../TERMS.md), [TRADEMARKS.md](../TRADEMARKS.md) | What leaves the machine and who sees it; the terms; the marks |
| [unbrowse-node/README.md](../unbrowse-node/README.md) | The node: building it, imports, the owner's hands on a page, what never leaves the node, website passkeys |
| [unbrowse-node/crates/net/README.md](../unbrowse-node/crates/net/README.md) | The network crate, in short |
| [unbrowse-node/crates/learn/README.md](../unbrowse-node/crates/learn/README.md), [crates/core/README.md](../unbrowse-node/crates/core/README.md) | The learner; keys |
| [unbrowse-node/window/README.md](../unbrowse-node/window/README.md) | The native desktop window |
| [unbrowse-browser/README.md](../unbrowse-browser/README.md), [FORK.md](../unbrowse-browser/FORK.md) | The browser engine the node links, and what the fork changes |
| [unbrowse-sdk/README.md](../unbrowse-sdk/README.md) | The TypeScript and Python clients and the `unbrowse` command |
| [unbrowse-telemetry/README.md](../unbrowse-telemetry/README.md) | The worker that takes nodes' anonymous usage events, and files their scrubbed bug reports as public GitHub issues |
| [skills/README.md](../skills/README.md) | The agent skills |
| [antithesis/](../antithesis) | The Antithesis harness: [antithesis/AGENTS.md](../antithesis/AGENTS.md) for its layout, `antithesis/scratchbook/` for the system analysis and the property catalog |

The landing site (`/link`, the relay, the node log) is the separate `unbrowse-landing` repository, with its
own `README.md`.
