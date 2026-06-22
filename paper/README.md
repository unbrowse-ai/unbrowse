# The Unbrowse Paper Corpus — unified index

One map over every paper in this directory: what each is, how they relate, the
reading order, and the gate that keeps them honest. The corpus is a **trilogy with
two supporting notes** — deliberately separate documents (separation of concerns),
unified here by a single index and one shared set of gates, *not* merged into one
file (merging would collapse the security/economics boundary the trilogy is built on).

## Reading order (the spine)

1. **Internal APIs Are All You Need** — *the wedge.* Shared route graph, ~3.6× latency
   win, three-tier x402 split, delta attribution, 94 domains. Stands alone, needs no
   token. Published: arXiv:2604.00694v1. → `internal-apis-are-all-you-need.tex`
2. **Crypto Was All You Needed** — *the descent.* Security / auth / privacy only: one
   Ed25519/Solana key signs every layer (screen→browser→CLI→OS→kernel→packet); ZK
   credential binding; content-addressed cache sealed-unless-revealed; value-off-chain
   / root-on-chain hash-chained ledger; threat model. **No token economics here** —
   forward-pointed to Paper 3. → `crypto-was-all-you-needed.tex` (+ `.pdf`)
3. **Unbrowse Maintenance Network** *(filename: internal-apis-were-not-all-you-needed)* —
   *the network.* The maintenance economy: proof-of-indexing as the verifiable freshness
   primitive the bond secures (cited to The Graph POI + Filecoin PoRep/PoSt),
   bonded/challenge/slash accountability, trust tiers, delta attribution, and the
   Grain-of-Wheat token doctrine in full. → `internal-apis-were-not-all-you-needed.tex` (+ `.pdf`)

## Supporting notes

- **Energy Route Ranking** — the energy-based route/attention ranking primitive that
  orders candidate routes. → `energy-route-ranking.tex`
- **Execute, Don't Guess** — the execution-over-fabrication benchmark argument (resolve→execute→read,
  no hallucinated coverage). → `execute-dont-guess.tex` (+ `execute-dont-guess-benchmarks.md`)

## The unifying thread

The three papers are one argument in three movements: **route** (Paper 1) →
**secure the route** (Paper 2) → **sustain the route** (Paper 3). The token (FDRY)
appears only in Paper 3 and only as *collateral for trust*, never as a currency —
the Grain-of-Wheat doctrine (stated once, coherently, in `CLAUDE.md`). Papers 1–2
forward-reference Paper 3 as ref [3]; none of them depends on holding an asset.

## What keeps the corpus honest (the shared gate)

Run from the repo root — all must exit 0:

| Gate | Guarantees |
|---|---|
| `scripts/papers-done-gate.sh` | every paper claim is backed by running, tested code; no `\prop{}` survives in a sealed body; PDFs compile clean (0 undefined refs) |
| `scripts/papers-reflection-gate.sh` | the papers reflect the code; leak-guard clean |
| `scripts/paper-gate.sh` | every `[shipped]`/`\impl{}` claim maps to a real repo anchor in `anchors.tsv`; no moat term leaks |

`anchors.tsv` is the claim→code map; `SIGNOFF.md` is the human editorial gate on the
public push (the machine pre-conditions are green; the rollout waits on a named approver).

## Status

All three gates green; the trilogy bodies are rewritten and honest about `[shipped]`
vs `[proposed]`; the public push is held pending the `SIGNOFF.md` editorial sign-off
(a person's call, not a script's).
