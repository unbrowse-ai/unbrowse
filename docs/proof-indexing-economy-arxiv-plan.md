# Proof-of-Indexing Economy: Paper Plan and Native Mechanism

Date: 2026-06-21

This note keeps the papers separate while adding the game-theory layer behind proof
of indexing and staking. It is a planning and evidence document, not a replacement
for the paper bodies.

## Paper Boundaries

The paper set should stay as four distinct concerns:

1. **Internal APIs Are All You Need**: the wedge. It owns route discovery,
   shared route reuse, route-fee adoption, x402 execution, and the measured
   browser-tax reduction.
2. **Execute, Don't Guess**: the execution discipline. It owns the claim that an
   agent should call verified tools/routes instead of guessing from prose.
3. **Crypto Was All You Needed**: the security and privacy stack. It owns wallet
   identity, signed layers, sealed values, and render-without-seeing.
4. **Unbrowse Maintenance Network**: the economy. It owns proof of indexing,
   bonded maintenance, challenge/slash adjudication, Sybil limits, trust tiers,
   and staking-by-abiding.

The economy paper should reference the routing and crypto papers, but not absorb
them. Its load-bearing question is narrower: "Which mechanism makes honest route
maintenance the rational strategy?"

## ArXiv-Grade Structure for the Economy Paper

The economy paper should read like a mechanism-design paper, not a token pitch:

1. **Abstract**: one-paragraph problem, mechanism, evidence, and honesty boundary.
2. **Introduction**: discovery is solved once; freshness is a repeated liability.
3. **Model**: agents, route set, indexers, challengers, canonical route state,
   stake, reward pool, freshness TTL, and challenge bond.
4. **Mechanism**: proof-of-indexing attestation, quality score, reward split,
   challenge, slash, false-challenge penalty, and conservation.
5. **Incentive Claims**:
   - verified proof quality ranks above stake size;
   - honest indexing earns; stale/false indexing is slashable;
   - false challenges lose their bond;
   - splitting one stake across many identities gives no extra reward;
   - stake plus free balance plus reward pool is conserved.
6. **Reference and Native Implementations**: Python reference under
   `paper/reference/network/`; native TypeScript runtime model under
   `src/values/proof-indexing-economy.ts`.
7. **Evaluation**: deterministic mechanism tests plus the JESPA ledger row.
8. **Limits**: stake raises Sybil cost but does not prove one-person-one-identity;
   production on-chain settlement is separate from the native model.
9. **Related Work**: The Graph POI, Filecoin PoRep/PoSt, Douceur Sybil, PoS
   slashing and staking economics.
10. **Conclusion**: the maintained graph is the asset; staking is collateral for
    route truth, not payment for rank.

## Mechanism Native to Unbrowse

The native mechanism now lives in:

- `src/values/proof-indexing-economy.ts`
- `tests/proof-indexing-economy.test.ts`
- `bench/jespa/proof-indexing-economy-gate.sh`
- `bench/jespa/benchmarks-ledger.jsonl`

The runtime model deliberately separates four roles:

| Role | Meaning |
|---|---|
| canonical route state | the content hash and current time a proof is checked against |
| indexer | posts stake and proof-of-indexing attestations |
| challenger | posts a challenge bond and re-derives a disputed proof |
| mechanism | pays rewards by verified quality, slashes false/stale proofs, penalizes false challenges |

The central rule is: **stake is collateral and reward weight, not ranking power**.
Ranking is by verified proof quality. This keeps the economy from becoming
pay-to-rank.

## Current Witness

Run:

```bash
bash bench/jespa/proof-indexing-economy-gate.sh
JESPA_WIN_TARGET=3 bash bench/jespa/jespa-benchmarks-gate.sh
```

The first command proves the mechanism invariants directly. The second command
counts the new mechanism as a reproduced JESPA win beside the previously
reproduced local wins.

Current deterministic tests:

- verified proof quality ranks above stake size;
- honest indexing earns more than lazy/stale indexing;
- Sybil splitting one stake across identities gives no additional reward;
- stale or false proofs are slashable by re-derivation;
- spurious challenges forfeit their bond;
- stake plus free balance plus rewards is conserved.

## Sources to Cite in the Paper

- The Graph, "Proof of Indexing (POI)": https://thegraph.com/docs/en/indexing/overview/
- Filecoin proofs: https://docs.filecoin.io/core-concepts/filecoin-virtual-machine/proofs
- John R. Douceur, "The Sybil Attack": https://www.microsoft.com/en-us/research/publication/the-sybil-attack/
- "A Game Theoretic Analysis of Validator Strategies in Ethereum 2.0": https://arxiv.org/html/2405.03357v2
- "Balancing Security, User Growth, and Token Appreciation": https://arxiv.org/html/2405.14617v1

## Rewrite Rule

When rewriting the papers, use this concern boundary:

- if a sentence is about **finding or executing routes**, it belongs in Paper 1
  or Execute-Don't-Guess;
- if a sentence is about **wallets, signatures, sealed values, or local reveal**,
  it belongs in the crypto paper;
- if a sentence is about **freshness, maintenance, stake, challenge, slash, or
  indexer attribution**, it belongs in the maintenance-network paper;
- if a sentence is about **JESPA measurement or energy ranking**, it belongs in
  the energy-ranking paper and only references the economy paper as a downstream
  use case.
