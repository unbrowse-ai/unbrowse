# The papers

The research, economic modeling, and protocol specification behind Unbrowse live in [`papers/`](../../papers/README.md) as both Markdown and PDF.

| Paper | What it covers |
|---|---|
| [*Internal APIs Are All You Need*](../../papers/internal-apis-are-all-you-need.pdf) ([arXiv:2604.00694](https://arxiv.org/abs/2604.00694)) | Empirical benchmark across 94 sites showing direct internal API replay is 3.6× faster (and cached calls 100× faster) and dramatically cheaper than browser automation |
| [*Unbrowse in one page*](../../papers/abstract.md) ([PDF](../../papers/abstract.pdf)) | The complete architecture and economic design on a single page |
| [*On Indexing the Entire Internet's APIs for Agents*](../../papers/whitepaper.md) ([PDF](../../papers/whitepaper.pdf)) | Whitepaper: why a shared map of website APIs is a commons problem, and how route staking turns callers into verifiers |
| [*Paying for the Map: The UNB Economy*](../../papers/economy.md) ([PDF](../../papers/economy.pdf)) | Economic design: USDC fees, the 65 / 30 / 5 split, route staking and price curves, checks, bounties, UNB supply, and risks |
| [*Keeping the Map True: Rank, Checks and Serving*](../../papers/selection.md) ([PDF](../../papers/selection.pdf)) | Verified-collateral ranking (`S = √(Q · M)`), failure handling, seeding, and dark-set backoff |
| [*Unbrowse Protocol Specification*](../../papers/protocol.md) ([PDF](../../papers/protocol.pdf)) | Normative protocol rules (`R1.x`–`R11.x`) and parameter definitions (`papers/params.toml`) |
| [*Mining the Machine Web*](../../papers/mining-the-machine-web.pdf) | Academic treatment of the route-staking incentive model and simulations |
| [*Internal APIs Drift*](../../papers/internal-apis-drift.pdf) | Draft study on keeping a shared map of first-party routes accurate as websites evolve |

## Reading the papers alongside the code

The papers define the protocol design (with `papers/params_check.py` verifying code constants against `papers/params.toml`). Where the running code still differs from the specification, each concept page documents the gap in its **In the code today** section:

| Concept | Main difference in the code today |
|---|---|
| [How it works](how-it-works.md) | Page-computed values run in the local browser rather than a script sandbox; `robots.txt` opt-out is parsed but not yet wired in |
| [Three parties, one node](the-node.md) | Settlement keys balances by node address rather than ERC-8004 `agentId`; each node registers its own identity |
| [Routes and the registry](routes-and-registry.md) | Entry IDs derive from the contributor's route ID; no network-wide index nodes yet |
| [Search and ranking](search-and-ranking.md) | Word/BM25 matching without semantic embeddings yet; one fee per contributor |
| [Payments, Staking & UNB](payments-and-unb.md) | Daily wallet fee capacity not implemented yet; live Arc mainnet/testnet deployments await audit, legal review, and pilot |
| [Identity and the vault](identity-and-vault.md) | Node key acts as the wallet; no proof of personhood or per-site agent scopes yet |
| [Decentralised from launch](decentralised.md) | Live Arc deployments pending; local Anvil devnet active in test mode |

The table above is where the code stands against each concept today.
