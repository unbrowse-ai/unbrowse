# The papers

The thinking behind Unbrowse is written down in full in the unbrowse-papers repository, and copied into this
repository's [`papers/`](../../papers/README.md). The design changed on 10 November 2026 to **route coins**: each listed
route body has its own coin, traded against UNB, and every passed fetch buys that coin for its payer and stakes it. A CI check
keeps the copies in `papers/` byte copies of the papers repository. The links below open those copies.

| Paper | Read it for, in the current design |
| --- | --- |
| [*Internal APIs Are All You Need*](../../papers/internal-apis-are-all-you-need.pdf) ([arXiv:2604.00694](https://arxiv.org/abs/2604.00694)) | The case, measured: a site's own internal API answers an agent faster and more reliably than a browser driving the page, and one agent's discovery can serve every other |
| [*Unbrowse in one page*](../../papers/abstract.md) ([PDF](../../papers/abstract.pdf)) | The whole design on a page |
| [*On Indexing the Entire Internet's APIs for Agents*](../../papers/whitepaper.md) ([PDF](../../papers/whitepaper.pdf)) | The whitepaper: the map of the web's internal APIs is a commons that rots as sites change; giving each route body its own coin, bought and staked by every paid fetch, makes a route's users its checkers |
| [*Paying for the Map: The UNB Economy*](../../papers/economy.md) ([PDF](../../papers/economy.pdf)) | The money: USDC fees and their split, route coins and their curve, how a fetch pays stake and then buys, staking and checks, bounties as limit orders, supply and allocation, risks. No bond. The copy here is the earlier draft, *Two Currencies for a Commons* |
| [*Keeping the Map True: Rank, Checks and Serving*](../../papers/selection.md) ([PDF](../../papers/selection.pdf)) | Checks, counted stake, the rank `√(Q·M)` and the pick, breaks and fixes, serving and liveness. The copy here is the earlier draft, subtitled *Selection, Checks and Serving* |
| [*Unbrowse Protocol Specification*](../../papers/protocol.md) ([PDF](../../papers/protocol.pdf)) | Every rule and number. Normative: where a paper and the protocol differ, the protocol wins. In unbrowse-papers it is now `protocol/spec/` with its numbers in `protocol/params.toml`; the copy here is the earlier single file, with requirements R1.x to R11.x and Annex A's parameters |
| [*Mining the Machine Web*](../../papers/mining-the-machine-web.pdf) | The academic version of the route-coin design, with the model as its evidence |
| [*Internal APIs Drift*](../../papers/internal-apis-drift.pdf) | Keeping a shared map of first-party routes true as sites change. A draft |

The concept pages cite rules by the names the specification gives them (R4.1, `coin.split`). The copies in
[`papers/`](../../papers/README.md) are the papers as they stand, and `papers/params_check.py` holds the code to every
number in `papers/params.toml`.

## How to read them against the code

The papers are the design. Apart from *Internal APIs Are All You Need*, they describe what is proposed, modelled or
measured, and say which.

The code is what runs. The contracts and the node implement the route-coin economy the papers describe: the 65 / 30 / 5
split, a coin per entry on a permanent curve, staking with a chosen exit delay, the fetch that pays earlier stake and
buys for the payer, limit-order bounties, and domains bound by DNSSEC. Nothing is deployed on a live network yet. Where
the design and the code still differ, the concept pages say so, each in its closing section, "In the code today":

| Concept | Where the code differs most |
| --- | --- |
| [How it works](how-it-works.md) | no script sandbox for page-computed values; robots rules not honoured while learning |
| [Three parties, one node](the-node.md) | settlement keyed by the node's address, not the identity; one identity per node |
| [Routes and the registry](routes-and-registry.md) | listing writes an entry on chain; credit goes to the first `listEntry`, with no `correctCredit` |
| [Search and ranking](search-and-ranking.md) | matching by words, not meaning; one price per contributor |
| [Payments and UNB](payments-and-unb.md) | the curve's trade fee goes to one address fixed at deployment; a fetch's buy is held when the price has moved; no capacity |
| [Identity and the vault](identity-and-vault.md) | the node's key is the wallet; no proof of personhood |
| [Decentralised from launch](decentralised.md) | nothing deployed on Arc mainnet yet |

What is built, contract by contract, is in the contracts reference (private repository) and
`src/coins/README.md` (private repository); [SPEC-STATUS.md](../SPEC-STATUS.md) says where
the rule-by-rule tables stand.
