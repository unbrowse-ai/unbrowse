# The Contract platform

Unbrowse's client boundary is a **contract** — a typed truth-claim the runtime
can resolve, sign, cache, and account for. This page describes the platform
that backs that boundary: what a contract is, how contracts compose, and what
ships today versus what is forward-looking. It is the design behind the live
bridge at `GET /v1/contract/surface` and the in-process contract runtime that
the CLI and SDK execute against.

The shape is deliberately uniform: every unit of work — resolving an intent,
executing a route, sealing a value, settling a payment — is the **same kind of
object**, so the same rules for identity, caching, and accountability apply
everywhere instead of one mechanism per feature. (The whole design exists to
avoid the usual fate of systems that grow a fresh mechanism for every fresh
feature and then spend the rest of their lives reconciling them.)

For how this spine shows up across the five papers, see
[The Unbrowse Papers](../the-unbrowse-papers.md). For the first-principles reading
of the platform as a living architecture — the scorer selector + LLM generator, how
it deploys itself, and how it benchmarks itself honestly — see
[The Contract platform as a Biological Architecture](./contract-biological-architecture.md).

## A contract is a declared truth-claim

You declare what you want as a goal; the runtime compiles it into a contract
and resolves it. The caller never reaches for verbs or flags — the goal is the
whole write surface. In the CLI and SDK this is one call:

```bash
unbrowse "the top Hacker News stories with points" --url https://news.ycombinator.com
```

Each declaration becomes a contract row. A row carries the goal, a
parent edge (the contract it runs inside), and pointer edges to the other
contracts it depends on. Resolution walks that graph: a contract fires when its
evaluator resolves true against real metrics — an action's exit code, a ledger
query, a returned value — and firing propagates to the contracts that contained
or depended on it, until the graph settles or evidence is missing.

The in-process runtime that compiles and resolves declarations is shipped:
`src/values/contract-native.ts`. The same goal-only shape is what the public
bridge exposes as five client-fillable holes — `intent`, `wallet_proof`,
`approval`, `local_capability_result`, `typed_pointer`.

## Identity is a wallet; authority is a signature

Every contract is signed. The runtime derives a per-contract keypair from a
single root identity, so each row's terminal verdict carries an Ed25519
signature that traces back to the holder. There is no separate "set up a
wallet" step — binding the runtime to an environment brings the identity with
it, and the user never sees a seed phrase, a payment header, or a wallet UI.

Signing is the shipped admission control on the boundary (`src/values/signer.ts`):
the next layer reads a contract's signed verdict as evidence, not the raw work
that produced it. Credentials never cross the wire — the client surfaces
pointer-only receipts and wallet-sealed values, never the secret itself.

## The ledger is append-only and content-addressed

Contracts are never edited in place; the platform appends events. Declaring a
contract, iterating it, satisfying it, retiring it — each is a new row. That
append-only trace is the platform's memory: any value is reconstructible from
the ledger alone, reproducibly, from any session.

An on-chain, hash-chained ledger backs the durable history
(`src/values/iq-ledger.ts`); the local ledger is a recency-weighted hot window
over it, so a working set stays fast while the full history stays durable and
auditable. The ledger is the single work-tracker — there is no sidecar index to
drift out of sync.

## The cache resolves to the pointer, not the value

Re-resolving an unchanged contract should be free. the platform keys its cache
on a **signature chain** — the contract's own signature folded with the terminal
signatures of everything it depends on — not on copied output bytes. When any
dependency acquires a new terminal verdict, the chain changes, the cache misses,
and only the affected sub-graph re-resolves. Unchanged work short-circuits at
O(1) per node instead of re-firing the whole graph.

This is what makes the boundary context-efficient: an agent pays to resolve only
what is genuinely unresolved. The cache layer is the sibling of the resolution
boundary (`src/values/cached-resolution.ts`), and it is deterministic — a
hit/miss verdict is a byte-equality check on pointer state, never a model
judgment.

## One source of truth, bound across surfaces

The CLI, the SDK, the server, and the published papers describe one contract,
not four. the platform binds them into a single source of truth with a
declared precedence, so a claim made in one surface cannot silently diverge from
the code that implements it (`src/values/contract-chain.ts`). The public
artifacts in this repo are gated against that binding: every shipped claim in a
paper maps to a real code anchor (`paper/anchors.tsv`), and release gates refuse
to publish an artifact whose claims drift from the code or whose text crosses the
open/private boundary.

## The economy rides the same platform

Discovery is free; an agent only pays when it executes a paid route, settled
over x402. Maintained routes are compensable assets: indexers can be paid when
their routes are reused, and site-owner splits are supported where claimed. The
stake/security layer and the usage/settlement layer are kept distinct —
settlement is in stable units (USDC via Faremeter Flex), and the native token is
reserved for staking and accountability, never for paying usage. See
[How Unbrowse Pays](../HOW_UNBROWSE_PAYS.md) and
[Trust and Accountability](./trust-and-accountability.md) for the shipped model
and the forward-looking accountability layer.

## What ships vs what is forward-looking

Shipped today: the goal-only declare surface, the in-process contract runtime,
wallet-bound signing and admission, the append-only + on-chain ledger, the
pointer-keyed cache, the single-source-of-truth binding across CLI/SDK/server,
and x402 settlement.

Forward-looking (research direction, not current behaviour): a full
peer-to-peer ledger (the platform is server-canonical today), a validator
market with cryptographic attestation, and the bonded proof-of-indexing
accountability layer described in the maintenance-network paper. These are
named here as direction, not claimed as shipped.

The internal grounding that motivates the platform's invariants (why the cache
keys on pointers, why two-or-three witnesses gate a slash, why the ledger is
append-only) is documented separately and is not required to use the contract
boundary — the boundary is fully described by the surface above. There are
reasons all the way down; you just don't have to read them to call `unbrowse`.
