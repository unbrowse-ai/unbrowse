# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

The value is the closest the schema has: the window is a native desktop program (`unbrowse-node/window`, Zig on
nanoui) on macOS, Linux (GTK 4) and Windows, drawing one look of its own on all three rather than any OS's design
language. It is not a web page and has no browser to run in.

## Users

Owners of an Unbrowse node, developers first. Today most run AI agents (Claude Code, Cursor and the like) against
the node on their own machine and know what a route, a port or MCP is. The money and approval flows (adding funds,
approving a card payment, signing in on a page for an agent) must stay clear to an owner who isn't a developer.

## Product Purpose

The window is the owner's view of, and hands on, the node running on their machine. The node turns websites into
calls agents can make without a browser: it learns a site's own API call once, from a page its browser walks, and
calls it directly after that. The window shows what the node is doing and lets the owner act on it. It talks to the
node over 127.0.0.1 with the owner's token, starts the node when nothing answers, and leaves it running when it
closes: agents keep working without it.

Three jobs carry equal weight:

- **Check it is working:** is the node up, are agents' calls passing, does anything need a look.
- **Answer what agents ask:** a card payment to approve, a page only a person can pass (a sign-in, a two-step code,
  a check). The window brings itself forward only for these, and each waits 5 minutes by default.
- **Manage routes and money:** try, list, share and delete routes; see the balance, earnings and each agent's spend;
  keep logins in the vault.

## Positioning

Agents call the site the way the site's own app does, with no browser in the loop after the first walk. The node is
the owner's own, on their machine: its wallet, its routes, its vault. The enemy is the browser as the agent's
interface, never the website.

## Operating Context

- One owner per node, on their own computer, usually with agents working at the same time; the window may stay closed
  for long stretches and is opened to check, to answer an ask, or to manage.
- Screens (sidebar order, `window/src/app.zig` `screen_labels`): Node, Live, Browser, My routes, Money, Vault, Agent
  access, Activity, Leaderboard, Settings; a first-run screen (the terms, keeping the node off the network) stands
  before all of them until the owner answers.
- Real nodes hold hundreds of routes and sites; what the node sends can be large (a route's last error can hold a whole
  page), so every screen must stay fast with real data.
- Test mode (a local devnet) and a live network (Arc) look alike apart from a "Test mode" mark.

## Capabilities and Constraints

- Everything the window does is an owner command (`POST /owner/<command>`, `unbrowse-node/app/src/commands.rs`); the
  window holds no logic the node doesn't.
- The node itself asks the owner, in its own dialog, before commands that hand out a secret, replace its key or let an
  agent spend more (`commands::asks_the_owner`); the window never answers for the owner.
- What the owner types on a page they take is never shown to an agent.
- Agents never wait on the owner over a fee: only card payments and pages that need a person wait.
- Terms: route, node, site, agent key, vault, listing, route coins, Balance in dollars.

## Brand Commitments

- Name: Unbrowse (capital U, one word); UNB for the token.
- Voice in product UI and errors is the brand's volume 1: says what happens and what to do next, plain words,
  sentence case, active voice, no hype words, no exclamation marks. Money, token and legal text is volume 0: literal,
  no swagger. Every figure needs its source. (`unbrowse-brand` skill; full visual guide:
  https://claude.ai/artifact/GTW3yQZjPsCHhAxc28r3p5)
- Assets: the U-magnet mark (`unbrowse-node/app/icons/icon.svg`), the U mark and Uni, the robot from the film, in nine
  moods (`unbrowse-node/window/src/art/`). Uni is the face of what the node is doing; the words beside it carry the
  meaning. The Node screen draws the node as the film's city: each site a building, each route a door.

## Evidence on Hand

- No user research, testimonials or usage numbers are recorded here; none may be invented.
- Real nodes are the evidence: one owner's node held 257 routes over 113 sites, 192 walked sites and 500 activity
  entries (2026-11-08).

## Product Principles

1. The node acts; the window shows and asks. Nothing in the window works around the node's own rules or dialogs.
2. Asks come first. When an agent needs the owner, that is the one thing on screen until it is answered or declined.
3. Truthful at a glance. Every number and status is the node's own answer; a value not yet read says so rather than
   showing zero.
4. Fast with real data. A screen stays responsive with hundreds of routes and whatever a site sent back.
5. Developers first, nobody lost. Technical terms are fine; money and approval flows read clearly to anyone.
