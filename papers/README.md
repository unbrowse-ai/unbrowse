# Papers

The design behind Unbrowse, as PDF and, for the papers written here, Markdown.

| Paper | What it covers |
|---|---|
| [*Internal APIs Are All You Need*](internal-apis-are-all-you-need.pdf) ([arXiv:2604.00694](https://arxiv.org/abs/2604.00694)) | The case: a site's own internal API answers an agent faster and more reliably than a browser driving the page, and one agent's discovery can serve every other |
| [*Unbrowse in one page*](abstract.pdf) ([Markdown](abstract.md)) | The whole design on one page |
| [*On Indexing the Entire Internet's APIs for Agents*](whitepaper.pdf) ([Markdown](whitepaper.md)) | The whitepaper: the map of the web's internal APIs as a commons, and the rules that keep it |
| [*Paying for the Map: The UNB Economy*](economy.pdf) ([Markdown](economy.md)) | The money: USDC fees and their split, route coins and their curve, how a fetch pays stake and then buys, staking and checks, bounties as limit orders, supply. No bond |
| [*Keeping the Map True: Rank, Checks and Serving*](selection.pdf) ([Markdown](selection.md)) | Selection: ranking a route's entries by staked collateral and market value, serving them, and checking them without raters |
| [*Unbrowse Protocol Specification*](protocol.pdf) ([Markdown](protocol.md)) | Every rule and number. Normative: where a paper and the protocol differ, the protocol wins |
| [*Mining the Machine Web*](mining-the-machine-web.pdf) | The academic version of the design |
| [*Internal APIs Drift*](internal-apis-drift.pdf) | Keeping a shared map of first-party routes true as sites change (draft) |

Every file here except *Internal APIs Are All You Need* is a byte copy of unbrowse-papers' built output, with the
numbers filled in from its `protocol/params.toml` (copied here as [`params.toml`](params.toml)). [`SOURCE.json`](SOURCE.json)
names the papers commit and each file's hash. Never edit a copy: change the papers, then run
`python3 -I papers/sync.py sync <unbrowse-papers checkout>`. CI runs `python3 -I papers/sync.py check`, which fails on a
hand edit; `check --upstream <checkout>` also fails when the copies are behind `staging`.
`python3 -I papers/params_check.py` checks that every number the code hard-codes equals `params.toml`
([`params-map.json`](params-map.json) says where each lives, and lists the keys code has no value for and why).

The copies come from the papers commit in `SOURCE.json`, and they are the route-coin design: fees split 65% to the
route, 30% to the website and 5% burned; one coin per route on a permanent curve against UNB; a fetch that pays the
coin's earlier stakers and then buys the coin for its payer; staking in lots by exit delay; bounties as limit orders;
domains proven by DNSSEC only; no bond, no slashing and no fraud court. This repository's contracts and node build
that design.

*Mining the Machine Web* and *Internal APIs Drift* are earlier PDFs, from before route coins, and still give earlier
fee splits. They change in unbrowse-papers, as every copy here does.

The papers are the design and the protocol is normative.

## Licence

The papers are © Lewis Tham and their co-authors. *Internal APIs Are All You Need* is also on arXiv under the licence
shown there.
