---
sut_path: <checkout>/antithesis
commit: 9111520494c5399d61a6b044050a293219f19ff1
updated: 2026-10-30
focus: 11 (wildcard)
confidence: medium
---

# `checked` ("2 distinct identities answered") buys nothing where an identity is free to mint

## What led here

AGENTS.md: "One owner is one source. Several nodes of one identity answering a
lookup count once, so one owner can't supply both copies being compared." R7.21
builds the whole anti-omission guarantee on fetching "from at least 2 of them
that belong to distinct identities."

The code implements the *counting* faithfully: `Net::find` /
`counted(providers, identities)` dedup by identity string, and
`found.checked = found.sources.len() >= self.sources` (sources = 2)
(`node.rs:371-389`). `admit` requires each counted peer to be **registered under
its identity** and **positioned** by a CPU grind (`admission.rs:62-74`,
`position::placed`).

## The gap the counting rests on

"Distinct identities" is only Sybil-resistant if minting a *new* identity is
costly. The identity comes from one of two registries (`peers.rs::registry`):

- `Erc8004Registry` (live): an identity is an ERC-8004 `agentId`. Its cost is
  the registry's business, and the repo contains **no implementation of it**
  (sut §8) — so the cost is unknown and untested here.
- `DevnetRegistry` (`network.rs:27-91`): identities are read as JSON ad files
  from a shared folder. On a devnet with no registry, `identity_key` makes the
  identity **the wallet address itself** (`listing.rs:159-166`). Minting a new
  identity is minting a new keypair — free and unbounded.

So on every devnet / no-registry deployment, `checked == true` can be produced
by **one owner** spinning up two wallets, two node ads, two placed peer keys.
The grind cost (`position_bits` = 16) is the only friction, and it is per-node
CPU, not per-identity economic cost. The "one owner is one source" invariant is
not enforced by the node at all; it is delegated to a registry that may or may
not charge, and is bypassed entirely when identity == wallet.

## Why it matters

`checked` is surfaced to the agent (`api.rs:122-123`, tool description
`api.rs:1055`: "checked: true means more than one owner answered") as a trust
signal that an entry's listing wasn't quietly omitted or poisoned. If one owner
can manufacture `checked`, an agent that leans on it accepts a single owner's
curated view as consensus-verified.

## Instrumentation (vs existing-assertions.md: none)

- `AlwaysOrUnreachable`: when `found.checked` is set, the counted sources map to
  identities that are distinct **and** each cost something to register
  (registry-dependent; on devnet this is `Unreachable`/vacuous — which is itself
  the finding to surface).
- The net-crate test `registered_nodes_find_a_site_and_an_unlisted_node_never_counts`
  (`tests/network.rs:81-127`) already asserts two nodes of one identity count as
  one and an unregistered node never counts — but it does not test one owner
  registering two cheap identities. That is the missing adversarial case.

## Open Questions

- What does registering an ERC-8004 identity cost on the live network, and is it
  Sybil-resistant? The registry is external and absent from the repo. `(needs
  human input)`
- Is `checked` ever meant to carry weight on a no-registry devnet, or is devnet
  explicitly out of the trust model? The tool description shows `checked` to
  agents unconditionally. `(needs human input)`
