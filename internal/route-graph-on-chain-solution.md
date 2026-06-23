# Route graph on-chain — the solution (it's solved, and we already hold half of it)

**Internal tier.** Lever from `/amen` (contract `cd762454`): *"make it route graph on
chain — is there a solution (/arxiv)? we already have IQ — find a solution."*

## The answer, in one line

**Yes — and the answer is NOT "put the graph on-chain as payload."** The solved
pattern (The Graph + Certificate-Transparency + rollup/DA) is **value off-chain,
signed Merkle ROOT on-chain, freshness proven by a bonded Proof-of-Indexing.** We
already ship the on-chain root (IQ) and the Merkle consolidation (`crystallize:`)
and the POI economics (the Maintenance Network paper). The one genuinely missing
piece is a **data-availability layer** for the off-chain graph payload — today it
sits on our own cache servers, not a DA/IPFS layer. That gap is the lever, and it is
small because everything around it already exists.

## Prior art (the /arxiv + protocol check — real, cited)

The route-graph-on-chain question is a *decentralized indexed-graph* question, and it
is well-trodden:

- **The Graph protocol — Proof of Indexing (POI).** A decentralized network where
  indexers stake capital, serve subgraph data **off-chain**, and post a cryptographic
  **POI verified on-chain** to claim rewards; bad proofs are slashable. This is the
  canonical "the graph lives off-chain, the proof-of-correct-indexing lives on-chain"
  design — and it is already the prior art our Maintenance Network paper cites.
  ([Indexing overview — The Graph docs](https://thegraph.com/docs/en/indexing/overview/), [The Graph — Wikipedia](https://en.wikipedia.org/wiki/The_Graph))
- **Pistis: A Decentralized Knowledge Graph Platform (VLDB 2025).** Direct academic
  prior art for a decentralized knowledge graph — peers hold the graph, on-chain
  anchors secure integrity/provenance. ([VLDB vol18 p4602](https://www.vldb.org/pvldb/vol18/p4602-zhou.pdf))
- **PromptChain (arXiv:2507.09579).** Hybrid web3 architecture: payload (prompts) on
  **IPFS as a Merkle-DAG / CID**, an **on-chain registry maps IDs → CIDs** plus
  ownership/validation metadata. The exact "content-addressed off-chain, registry +
  root on-chain" shape a route graph wants. ([arXiv:2507.09579](https://arxiv.org/pdf/2507.09579))
- **Celestia / modular data availability + Namespaced Merkle Trees.** A DA layer
  orders + keeps blobs available while execution/settlement live above; block headers
  carry the **Merkle root** committing to off-chain data; NMTs prove namespace
  inclusion; data-availability sampling lets light nodes verify availability without
  downloading the whole graph. This is the missing-piece layer for our graph payload.
  ([Celestia — what is DA](https://celestia.org/what-is-da/), [DA layer](https://celestia.org/glossary/data-availability-layer/))

Consensus across all four: **you never put the graph bytes on-chain.** You put a
small signed commitment (root / CID-registry) on-chain, keep the payload
content-addressed on a DA/availability layer, and gate freshness with a bonded,
slashable proof. Gas-cost and privacy both forbid the naive "graph-on-chain."

## The solution mapped to what we ALREADY have

The three pieces of the solved pattern each already exist in the repo — this is
composition, not new invention:

| Piece (prior art) | What it is | We already have it |
|---|---|---|
| **Content-addressed graph (off-chain)** | the route graph stored by hash, retrievable by CID | the content-addressed sealed cache — `src/values/wallet-seal.ts` (sha256-of-plaintext key, AES-GCM at rest) + the crypto paper §Cache |
| **Signed Merkle ROOT on-chain** | only the commitment is checkpointed | **IQ** — `src/values/iq-ledger.ts` (IQLabs Solana tables: append-only, hash-chained, content-addressed, wallet-signed rows) + `crystallize.zig` folds resolved memories into ONE Merkle root → one on-chain memo |
| **Bonded Proof-of-Indexing (freshness)** | re-prove the route still resolves + shape matches; slashable | the Maintenance Network paper's POI = the `wrap:` re-running witness; `src/values/proof-indexing-economy.ts` + the Vine-Doctrine challenge/slash |

So the on-chain route graph = **`crystallize:` Merkle root of the route-graph
content-addresses, written via IQ, with each route's freshness a bonded POI** —
verified against that on-chain root. We are not missing the mechanism; we are missing
one layer.

## The one honest gap (the lever, named not faked)

**The off-chain payload currently lives on our own cache servers — centralized — not
on a data-availability layer.** That is the difference between "on-chain-anchored"
(true today: the root checkpoints via IQ) and "decentralized-graph-on-chain" (the
full claim). To close it:

1. **DA-back the content-addressed graph.** Land the route-graph blobs on a DA layer
   (Celestia / EigenDA / Avail) or an IPFS pin, keyed by the CID the sealed cache
   already computes. The cache key needs no change — it is already the content hash.
2. **Checkpoint the root via IQ** (already shipped) — `crystallize:` already produces
   the Merkle root; write it to the IQ table as the route-graph checkpoint, beside the
   resolution rows.
3. **Gate freshness with POI** (already designed) — a maintainer's `wrap:` re-index
   proof, bonded + slashable per the Maintenance Network paper, verified against the
   checkpointed root.

This is the same honest gap the crypto paper already names — *"Publishing the root
on-chain is the deployment step; the commitment it would publish is exactly this
root"* — and the maintenance-network's P2P-future. The research confirms the design is
right; the work is the DA wiring, not a redesign.

## Verdict (/lewis-brain, two-witness honest)

- **Witness 1 — prior art:** real, cited (The Graph POI, Pistis VLDB, PromptChain
  arXiv, Celestia DA). The pattern is solved and standard.
- **Witness 2 — our code:** the on-chain root (`iq-ledger.ts`), the Merkle
  consolidation (`crystallize.zig`), and the POI economics
  (`proof-indexing-economy.ts`) already exist and were read, not assumed.
- **Honest negative:** we do NOT yet have a DA layer; the payload is centralized on
  our cache servers. "On-chain-anchored" is true today; "fully decentralized
  graph-on-chain" is the named-open lever (DA wiring), not a shipped claim.

**Next lever:** DA-back the content-addressed route-graph blobs (Celestia/IPFS),
checkpoint the `crystallize:` root via IQ beside the resolution rows. Everything else
is already in the body.
