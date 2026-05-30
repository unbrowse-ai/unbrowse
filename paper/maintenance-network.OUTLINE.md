# Paper 3 — outline skeleton (the mustard seed)

**Title:** Unbrowse Maintenance Network — Trust, Accountability, and Optional
Bonding in a Shared Route Graph
**Author:** Lewis Tham, Unbrowse AI · **Cite key:** `fdry` (self-ref in Papers 1-2)
**Self-id:** arXiv:2604.00694 — this paper IS ref [3] of Papers 1 & 2.

> Status of this file: a *seed*, not the tree (Matt 13:31-32). Each `§` is a slot a
> later walk grows into prose. No prose is fabricated; every primitive below is a
> web-verified citation (Step 3 research, 2 witnesses). The token doctrine section
> inherits `paper/CLAUDE.md` (Grain-of-Wheat) verbatim in spirit.

## Reuse from Paper 2 (do not re-derive)

- **Preamble:** copy `paper/internal-apis.tex` lines 1-28 (`\documentclass[11pt]`,
  geometry/hyperref/amsmath/amssymb/enumitem/xcolor; `\impl`→[shipped],
  `\prop`→[proposed], `\CA`→the Solana CA).
- **Shared bibitems already established:** `x402`, `frost`, `erc8004`, `rfc6962`
  (Certificate Transparency), `solana` (proof-of-history), `e2e`, `bitcoin`,
  `merkle`. Reuse keys identically.
- **Flip the self-citation:** in this paper `fdry` is *self*, not an external
  cite; add a NEW bibitem `internalapis` back-pointing to Paper 2.

## New citations needed (ALL web-verified in Step 3 — no fabrication)

| key | citation | maps to |
|---|---|---|
| `ostrom` | E. Ostrom. *Governing the Commons.* Cambridge Univ. Press, 1990. ISBN 0-521-40599-8. | 8 design principles → maintainer boundaries, graduated slashing, nested trust tiers |
| `pigou` | A. C. Pigou. *The Economics of Welfare.* Macmillan, 1920. | route staleness = negative externality priced into the micropayment |
| `samuelson` | P. A. Samuelson. *The Pure Theory of Public Expenditure.* Rev. Econ. Stat. 36(4):387–389, 1954. DOI: 10.2307/1925895. | fresh graph = non-rival public good; free-rider ⇒ pure usage under-provides maintenance |
| `sybil` | J. R. Douceur. *The Sybil Attack.* IPTPS 2002, LNCS 2429:251–260. DOI: 10.1007/3-540-45748-8_24. | the open problem the attribution layer only partially mitigates (cite honestly) |
| `casper` | V. Buterin, V. Griffith. *Casper the Friendly Finality Gadget.* arXiv:1710.09437, 2017. | accountable-safety slashing model → bonded maintainer, slashable false freshness claim |

## §-tree (the spine — Dijkstra order, each settles Plan→Build→Test→Judge)

- **§1 Introduction — the maintenance problem, not the discovery problem.**
  Discovery is settled by `f_shared < c_rediscovery` (Paper 1). A graph with
  traffic has a *second* problem: routes decay. This paper is about who keeps them
  fresh and how that is made trustworthy. `\impl` for the live graph; `\prop` for
  the bonding layer.
- **§2 The route as a common-pool resource.** [`ostrom`] The graph is a CPR that
  degrades under uncoordinated use; Ostrom's principles are the governance
  template. Boundaries (who may claim a route), graduated sanctions (slashing
  tiers), nested enterprises (trust tiers).
- **§3 Why pure usage under-provides freshness.** [`samuelson`, `pigou`] The fresh
  graph is a non-rival public good → free-rider problem → maintenance is
  under-supplied by usage fees alone. Staleness is a negative externality
  (`pigou`); the bond + slashing is the corrective.
- **§4 Trust tiers.** Open routes for low-risk traffic; higher-trust routes for
  authenticated/high-value paths. Ranking grounded in route quality, NOT capital
  (echo Paper 2: "bonding buys eligibility, not ranking"). [`erc8004`] for portable
  identity + reputation + validation registries.
- **§5 Bonded, slashable maintenance.** [`casper`, `frost`] A maintainer bonds
  FDRY to claim a route is fresh+safe; a false/conflicting claim is slashable
  (accountable-safety analogy). FROST t-of-n quorum finalises a trust-tier claim,
  not one confident wallet. `\prop`.
- **§6 Challenge & dispute.** A challenger stakes to dispute a freshness claim;
  resolution by independent re-execution (witness atom; Deut 19:15 / Matt 18:19
  two-witness). [`rfc6962`] CT-style append-only log of claims; [`erc8004`]
  validation registry.
- **§7 Attribution & the Sybil limit (honest).** Delta-based attribution rewards
  marginal contribution. [`sybil`] State plainly: bonding raises Sybil cost but
  does NOT formally close the gap; this is acknowledged open work, not a solved
  guarantee. `\prop`.
- **§8 The token: why FDRY, why fair-launched (the Grain-of-Wheat doctrine).**
  Inherit `paper/CLAUDE.md` + Paper 2 §"Why FDRY" / §"Why money could not be the
  point" verbatim-grounded: USDC settles usage, FDRY only bonds (one master);
  fair launch is a *security property* not branding — money-first root inverts
  trust. The token had to be hidden from money-motive and distributed to the
  good-rooted FIRST. [`bitcoin`/`solana` for the chain primitives.]
- **§9 What is built vs proposed (no fabricated green).** `\impl`: live three-way
  split, fair launch, platform-fee collection, signed JSONL route ledger.
  `\prop`: bonding/challenge/slashing, on-chain Merkle-root checkpoints,
  formal Sybil resistance. Mirror Paper 2's honesty section.
- **§10 Conclusion.** The graph is the asset; any single route is copyable, the
  maintained graph is not. Maintenance is the moat's economic engine, told as the
  WHAT (never the capture HOW — `docs/OPEN-SOURCE-NOTICE.md` boundary).

## Gate contract (inherited, MECHANICAL)

- Every `\impl{}` claim → a `paper/anchors.tsv` row → real repo anchor.
- `scripts/paper-gate.sh paper/maintenance-network.tex` must exit 0.
- `scripts/leak-guard.sh` must exit 0 — no economic constant / capture internal.
- No quote written that does not `grep`-verify against its source (the lesson of
  this session's two repented fake-greens).
