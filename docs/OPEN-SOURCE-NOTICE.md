# Open Source Notice

**The Unbrowse client boundary is open source and auditable** at [github.com/unbrowse-ai/unbrowse](https://github.com/unbrowse-ai/unbrowse). The local runtime, CLI bridge, SDK and drop-in adapters, and wallet/auth/signing layer are MIT and readable. The CLI ships **unsigned and readable by design**: an agent runs code on your machine and touches your credentials, so you should be able to read exactly what it does rather than trust an opaque binary. Trust comes from auditability, not from a signature.

The private product surface is the **backend** plus the **web app**. The backend owns the route graph, ranking, settlement, and recursive contract compilation. The public client boundary sees only typed holes, approvals, pointer-only receipts, wallet-sealed fills, and local capability dispatch. `unbrowse contract surface` is the machine-readable bridge contract for this split; its client-fillable holes are `intent`, `wallet_proof`, `approval`, `local_capability_result`, and `typed_pointer`, none of which carries a secret value.

The split:

| Surface | Where it lives | License / visibility |
|---|---|---|
| **Client boundary runtime** — local execution bridge, typed holes, approvals, wallet/auth/signing | npm + public repo | **MIT, fully open & auditable** |
| **Client SDK + drop-in adapters** (`unbrowse/sdk`, every `@unbrowse/*` shim + agent-SDK adapter) | npm + public repo | **MIT, fully open** |
| `unbrowse` CLI runtime | npm `unbrowse` | readable, unsigned bridge bundle of this source |
| **Backend** (route graph, ranking, recursive contract compilation, marketplace, payouts, settlement) | **private repo**, Cloudflare Workers | proprietary (server-side) |
| **Web app** (unbrowse.ai) | **private repo** | proprietary (product surface) |

The client carries no server secret: credentials stay local, the secret bytes never
cross the wire, and integrity between client and the private backend is established
by a hash-chained, auditable ledger (reference implementation under `paper/reference/`).
You can read every line the client runs; the server you settle against is the only
part you take on trust, and the ledger is how that trust is kept honest.

## What this means for you

- **Building on the SDK?** New code should use `unbrowse/sdk`. Existing local-runtime integrations can keep using `unbrowse/sdk` plus a running `unbrowse` runtime (`npx unbrowse setup`). Both SDKs are MIT.
- **Reading the repo for architecture?** It reflects the current client boundary — `src/` is the runtime and bridge the `unbrowse` npm bundle is built from. The `docs/` and the public [whitepaper](./whitepaper/) describe the same behavior.
- **Filing a bug?** Use [github.com/unbrowse-ai/unbrowse/issues](https://github.com/unbrowse-ai/unbrowse/issues) for SDK/CLI issues. The published runtime tracks this source.
- **Want source access for security review?** Email security@unbrowse.ai. Code review under NDA is available for serious enterprise integrators.

## Why it's open

An agent that drives your browser, reads your sessions, and signs actions with a
wallet is exactly the kind of software that should be readable. We publish the full
client so you can verify those claims line by line — that credentials stay local,
that secret bytes never cross the wire, that every action is signed — instead of
trusting a binary. Auditability is the security model.

Two things we ask of anyone who builds on or forks this:

1. **Attribution and integrity.** The client interoperates with marketplace-publish,
   paid-routes, and ToS gates by design. Stripping those to turn a discovery tool into
   an unattributed scraping fleet is a misuse, not a fork we endorse — keep attribution
   and the integrity gates intact.
2. **Responsible disclosure.** If you find a way the client could be aimed at services
   that disallow automated access, or at accounts an operator does not own, email
   security@unbrowse.ai rather than weaponising it.

## Open standards we build on — and credit

We fault forks for *unattributed* rebranding; we will not do the same to the layers
below us. Unbrowse's agent-interop surface (`src/interop/`) is a **drop-in for, and
builds on, open standards authored by others**. We interoperate with them and credit
them; we do not fork-and-rebrand them:

| Standard | Author / owner | What we do with it |
|---|---|---|
| **Agent Skills** (`SKILL.md` format) | Anthropic — released as an open standard (agentskills.io) | ingest + serve our routes as skills, to the published spec |
| **Model Context Protocol (MCP)** | Anthropic — open spec (modelcontextprotocol.io) | expose our surface as MCP tools; map every tool to the uniform route shape |
| **x402** + **x402 Bazaar** | Coinbase — open payment protocol + public discovery catalog | settle usage over x402; rank a site's already-listed Bazaar resources above any re-wrap |

A route is a drop-in *replacement* only in the sense of *interoperating with*
these formats — never of replacing their authorship. Where we build on a cited source,
we keep its `source_id` in the code and build **on top** of it, not over it.

## What we give first

The open part is given before anything is asked back. Freely available today, MIT:
the `unbrowse/sdk` + `unbrowse/sdk` SDKs, and the standards-interop above — so any
agent can use Unbrowse through the formats it already speaks, at no cost and with no
lock-in (the browser fallback is always the exit).

The deeper layers open **as gifts over time, as they mature safely** — not hoarded, not
sold as the point. The maintenance/trust economy (proof-of-indexing, bonded
accountability) is staged for reveal, not extraction (see `RELEASE_STRATEGY.md`); USDC
settles usage while the bond only secures trust (one master, never a money-first root).
Give first, hidden from money-motive, planted in good soil — then it grows on its own.
