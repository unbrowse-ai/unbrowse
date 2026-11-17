# Unbrowse protocol specification

Normative specification of the Unbrowse network, derived from the Unbrowse design graph (`unbrowse-ai/unbrowse-graph`). This document states every rule and parameter whose graph status is *adopted* or *chosen*, adding no rule outside the graph.

## 0. Conventions

*Informative:* Unbrowse separates peer-to-peer execution from on-chain settlement. Agents discover, serve, validate and call HTTP routes directly peer to peer; smart contracts on Arc hold USDC deposits, settle payment vouchers, manage route coins and stakes, and escrow website revenue. This chapter defines how rules, enforcement boundaries and parameters are written throughout the specification.

### 0.1 Normative authority

**R0.1** This document is normative. Where any paper, guide, article or website page disagrees with this specification, this specification governs. Where this specification disagrees with the Unbrowse design graph, the design graph governs and this document has drifted. The companion papers in `papers/` explain the rationale behind these rules; retired drafts in `archive/` are frozen historical records.

**R0.2** The key words MUST, MUST NOT, SHOULD and MAY are to be interpreted as described in RFC 2119.

**R0.5** Paragraphs or sections marked *Informative* or *Note* provide context and rationale; they add no normative requirement.

### 0.2 Rule identifiers and deployment status

**R0.4** Every rule begins with its bold identifier from the design graph. Adopted rules retain their stable numbered identifiers (`R2.3`); chosen route-coin and ranking rules carry descriptive identifiers (`coin.fetch-pays`, `rank.score`). Retired rules remain archived as *superseded* nodes in the design graph and are omitted here.

Rules whose graph status is *adopted* are in force on the live mainnet contracts today. Rules whose status is *chosen* have been decided by the founder and ship together in a new immutable contract deployment (`deploy.new`, chapter ten) once constitutional review, contract audit and pilot gates conclude. Where an adopted rule previously referenced a superseded mechanism, the rule is stated as updated by the chosen design and accompanied by a *Note* naming the superseded dependency.

### 0.3 Enforcement boundaries in a mixed-version peer network

Because peers upgrade software voluntarily, old and modified clients coexist alongside current releases. Every rule states where it holds:

- *(contract)*: Enforced on chain by immutable smart contracts; no modified client can bypass it.
- *(client)*: Executed off chain by nodes and indexers following this specification. Each client rule is designed to be incentive-compatible for the node running it, and states *Why a peer follows it* from the graph's `why_follow` field. Adopted client rules whose graph node does not yet record `why_follow` are marked *(client†)* and listed in Annex E.
- *(both)*: Enforced partly on chain (for fund movement or state commitments) and partly in the client.
- Unmarked rules state structural definitions or governance commitments rather than runtime checks.

### 0.4 Parameters, currency units and time

**R0.3** Every protocol number is referenced symbolically by parameter key (for example `route_coin.supply`) and resolved from `protocol/params.toml`. Annex A tabulates every parameter with its value, status, date and source. Parameter status is one of: *constant* (compiled into immutable contracts; changeable only via a new deployment), *launch* (set for launch and tunable during the pilot), *proposed* (candidate value to be finalised before deployment), *open* (unset pending founder decision), or *client* (off-chain client default). Token supply, allocation, fee-split and tax numbers change only on explicit written decision recorded in the design graph first.

**R0.6** Monetary amounts (route prices, deposits, voucher caps, claims and Arc gas) are denominated in USDC and counted in its smallest integer unit ($0.000001). Bounties, burns and route-coin bonding curves are denominated in UNB. No contract rule reads an external price oracle.

**R0.7** Protocol time is measured in epochs of 24 hours, counted strictly in Arc block numbers rather than block timestamps.


## 1. Accounts, wallets and identity

*Informative:* Unbrowse avoids separate node classes, central user accounts and upfront token barriers. Every participant runs the same open-source node software under a single wallet and on-chain identity, starting locally at zero cost and using capped spending keys so an agent can pay for routes automatically without risking its owner's wallet.

### 1.1 Roles

**R1.1** Contributor (lister), server (seeder), caller (payer) and index node are roles a single node plays rather than separate classes of participants. One node can learn, list, fetch, serve and stake routes under one wallet and one ERC-8004 identity, both paying and earning through the same account.

*Note:* The separate skill-author role was retired alongside skills (`skills.none`).

**R1.3** Listing an entry is free (R2.15). A contributor earns from fetches of its entry by holding staked coins of that entry like any other staker, receiving the route share directly in USDC only before the entry's coin has launched and attracted verified stake (`coin.split`).

*Note:* Upfront and withheld entry bonds (formerly R6.8) were retired (`bond.none`).

**R1.4** *(client†)* A contributor serves its own entries or designates hosts to serve them (R7.1, R7.3); routes are never centrally assigned, and nobody buys a serving slot. The protocol serving fee share is 0% (R4.3): peers that serve routes they care about earn through their own staked coins on those routes (`decide.one-part-to-stake`).

**R1.5** *(contract)* A website is the relying party: the controller of the domain whose backend API a route calls. A website posts no bond, needs no integration for its routes to function, and accrues its escrow share automatically whether or not its operator has heard of Unbrowse (R4.13).

**R1.6** *(client†)* Index nodes are optional discovery helpers for broad natural-language queries that name no domain; the protocol sets no fee for running one. An index node builds its search index strictly from signed listings verified against on-chain Merkle roots, computes embeddings with the pinned open model, and SHOULD NOT retain query intents after responding. Clients MUST treat index nodes as untrusted (R3.7). Ordinary domain-scoped lookups use the peer-to-peer hash table directly (R7.21) without requiring an index node.

**R1.11** A node in light mode searches, pays for, executes and learns routes locally while serving nothing to peers. It uses the same wallet, identity and voucher mechanics as a full node.

### 1.2 Unbrowse's own wallets and roles

**R1.8** The founder's wallet belongs to Unbrowse. Unbrowse holds the team allocation (8% of supply) and treasury tranches (5% and 10%), moving at most what has passed its time cliff (R9.12), together with any disclosed open-market launch purchases (R9.4a). Unbrowse posts bounties strictly as an ordinary sponsor from its own UNB on standard contract terms (R8.12), with no privileged contract path and no role in judging completions. On the peer network it lists, serves and pays under the exact same rules as every other wallet.

**R1.9** The rewards reserve holds 10% of total supply in the utility contract. Its sole active outflow is posting one listing Merkle root every 1 hour (R2.20). It pays no bounties, never matches contributor or website earnings, and never stakes or funds another wallet's stake (R9.14). Its remaining long-term role, or eventual retirement, is open (R9.14).

**R1.10** *(contract)* The platform maintains the open-source client, node and smart contracts. It receives its disclosed share of route detail fees (0%, R4.1) and route-coin curve trade fees (`coin.curve`). It holds zero privileged settlement powers: no contract function is restricted to the platform, and claims settle normally even if every platform-operated node goes offline. At launch the platform operates disclosed canary checks and off-path release and telemetry services, none of which sit on the API call path or can move funds or alter routes (R11.13).

*Note:* R1.10 previously referenced skill and execute fee splits (R4.9, superseded by `skills.none` and `execute.none`). Dedicated canary funding (R5.9) retired with `fraud.none`, leaving the ongoing canary mechanism an open item in Annex B.

### 1.3 Wallets and onboarding

**R1.12** One wallet owns a participant's nodes, spending keys, route coins and USDC claims. The protocol maintains no user accounts, passwords or central database.

**R1.13** *(client†)* The protocol treats every standard EVM wallet identically: the local wallet derived automatically from the node's own root key, an external wallet the user connects, or an embedded wallet behind an email or Google login (such as Privy). A new node derives its root key locally from a standard twelve-word mnemonic (`BIP-39`, path `m/44'/60'/0'/0/0`), portable to any Ethereum wallet app. No contract, node or route depends on any third-party wallet provider, and linked wallets can be exported or replaced at any time.

**R1.35** *(client†)* Onboarding requires no sign-up and progresses at the owner's choice:

- **Default peer mode with the node's own wallet.** When started with peer networking enabled (the default), the node uses its locally generated Arc wallet with no sign-in prompt. Once that wallet holds a few cents of USDC on Arc (which also serves as native gas), the app registers its ERC-8004 identity (R1.14) and authorises a capped spending key (R1.20). Every transaction writer pays its own gas in USDC, and proven routes learned afterward share by default (R2.14a).
- **Local-only mode.** When the owner switches peer networking off, the node learns routes from local browsing (R2.8) and serves the owner's local CLI, SDK and MCP clients over `127.0.0.1`. Zero data leaves the machine, and routes learned while offline remain private (R2.8).
- **Optional linked wallet.** An owner MAY bind an external or embedded wallet via a single signed message to receive withdrawals or fund multiple nodes from one deposit, without changing how nodes join or share.

*Note:* Earlier onboarding steps for compulsory bond withholding (R6.8, R6.9, R6.24) and manual verifier switches (R6.35) are superseded by `bond.none` and `coin.stake`. Under route coins, passed fetches automatically buy and stake coins for the caller (`coin.fetch-buys`, `coin.fetch-stakes`).

### 1.4 On-chain identity

**R1.14** Each wallet registers at most one ERC-8004 identity (an ERC-721 token identified by `agentId`) in Arc's native Identity Registry when first joining the network (R1.35). Individual software agents do not register separate on-chain identities; every action traces from spending key to wallet to `agentId`.

*Note:* R1.14's historical reputation-reset rule on identity transfer (R6.21) is superseded because `rank.score` applies no per-identity weight.

**arc.erc8004** *(contract)* Identity management uses Arc's native ERC-8004 IdentityRegistry rather than a custom contract: each wallet registers one `agentId` (R1.14), against which route-coin verification checks and counted stakes are recorded.

**R1.15** *(client†)* A wallet publishes its nodes' libp2p peer IDs, network multiaddresses and protocol versions in its ERC-8004 on-chain metadata (`setMetadata` keys `unbrowse.peerId`, `unbrowse.addrs`, `unbrowse.version`), with service endpoints and `supportedTrust: ["reputation", "crypto-economic"]` in its registration document. Peers discover contributors' nodes directly from this on-chain registry without relying on hardcoded bootstrap servers (R7.24, R7.26).

**R1.16** *(contract)* Payer USDC deposits live in the Settlement contract indexed by `agentId`, and payouts resolve to `getAgentWallet(agentId)`. The Identity Registry itself holds no funds, and ERC-8004's Validation Registry is unused.

**R1.18** *(client†)* A wallet signs a cryptographic certificate binding each of its nodes' libp2p peer keys to its `agentId`. Nodes belonging to the same owner trust one another for encrypted vault or session sync solely on presentation of a valid sibling certificate; vault data is never published.

**R1.19** *(client†)* Web dashboard sign-in uses standard Sign-In with Ethereum (`EIP-4361`) signed by the wallet.

**R1.33** *(client†)* Proof of personhood is entirely optional. Only one rule consults it: shared-reputation failure complaints count solely from verified human wallets, capped at 1 complaint per route per day (R5.4).

**R1.34** Which proof-of-personhood providers qualify (such as Gitcoin Passport or World ID) and how attestations bind to wallets remain open (`open`).

### 1.5 Delegated spending keys and session authorisation

**R1.20** *(both)* Upon joining, the app generates a delegated spending key for its node and authorises it on chain via `authorizeAgent(agent, cap, expiryBlock)`, granting `g = (pk_agent, cap, expiry)`. This lets the node sign micropayment vouchers silently while bounding worst-case loss from a compromised machine to `cap` ($5.00 per epoch by default, adjustable by the owner) until `expiryBlock` or `revokeAgent`. Spending keys are internal plumbing hidden from the user; wallets capable of signing vouchers directly need no separate spending key.

**R1.21** *(contract)* Both wallet keys and delegated spending keys use standard ECDSA signatures, allowing contracts and serving peers to validate any voucher with a single `ecrecover`.

**R1.22** *(both)* The Settlement contract rejects voucher lines signed by an unauthorised, expired or revoked key, or exceeding the key's epoch cap. Serving nodes MUST verify these bounds before releasing a recipe body.

**R1.23** *(client†)* Delegated spending keys and local vault encryption keys are derived deterministically on device from the node's root secret and are domain-separated from the wallet's signing key.

**R1.24** *(client†)* Executing a route that uses a logged-in session requires a local owner authorisation scoping which agent may call which site, permitted actions, spending limits and expiry. The node holding the session verifies the grant, performs the HTTP request locally, and returns only the structured result; raw cookies, tokens and passwords never cross into agent prompts or leave the owner's machines.

**R1.25** *(client†)* Any request that mutates remote state is classified as a write regardless of HTTP verb and held strictly to write authorisations and caps.

**R1.37** *(client†)* When walking a site in its browser on behalf of its owner's agent, the node attaches the stored local session for that domain unless signed-in walks are disabled; exploratory probes of page controls run without a session. Any route compiled from a signed-in walk records only the required session type, never the session secret itself (R2.2).

### 1.6 Deposits, native USDC and payment UX

**R1.2** Callers pay route fetch fees from their Settlement USDC deposits via off-chain vouchers (R3.13), with zero bond required (`bond.none`).

**R1.26** *(contract)* Settlement holds deposits exclusively in Arc's native six-decimal USDC ERC-20 token and rejects native value transfers.

**arc.usdc** *(contract)* All dollar accounting uses Arc's native USDC interface (R1.26), supporting gasless single-step deposits via `ERC-3009` transfer authorisations.

**arc.permit2** *(contract)* Token approvals route through Arc's canonical `Permit2` contract so wallets grant a single approval rather than per-contract allowances.

**arc.multicall3from** *(contract)* Multi-step user actions (such as staking coins and claiming USDC yield in one click) batch atomically via Arc's `Multicall3From` while preserving sender identity.

**R1.27** *(contract)* Deposit withdrawals unlock 2 epochs (constant) after request, once all valid vouchers signed prior to withdrawal have had time to settle against the balance. The same delay governs funds remaining after a spending key is revoked.

**R1.28** *(contract)* Each epoch spans 24 hours measured in blocks. Epochs govern withdrawal delays, epoch Merkle roots for staker USDC claims (`coin.claims`), and dark-entry backoff schedules (R7.12).

*Note:* Fixed bond unbonding (`param.stake.unbond`) is superseded; route-coin unstaking follows each staker's chosen exit delay (`rank.exit-delay`).

**R1.29** *(client†)* Nodes fund deposits from earned USDC or owner top-ups via card or Arc USDC (cross-chain USDC MAY arrive via `arc.cctp-gateway`, with zero protocol lock-in). Outside the automatic coin purchase embedded in each passed fetch (`coin.fetch-buys`), a node never buys, stakes or sells route coins unless explicitly instructed by its owner (`coin.stake`).

*Note:* R1.29 previously referenced bond top-ups (R6.23, superseded by `bond.none`); its old clause stating call payments never touch the UNB pool is superseded by `coin.fetch-buys`.

**arc.cctp-gateway** *(client)* Cross-chain USDC funding uses Arc's native CCTP v2 or Gateway bridges rather than a custom Unbrowse bridge (R1.29).
*Why a peer follows it:* Using canonical chain bridges avoids taking smart-contract risk on an application-specific bridge.

**R1.30** *(client†)* The app displays route prices, deposits, budgets and caps in exact US dollars, and displays route-coin balances in UNB alongside an estimated dollar value.

*Note:* R1.30 previously referenced R10.17 (no protocol rule reads pool prices), superseded by `rank.collateral`'s time-weighted valuation.

**R1.31** *(client†)* The node pays route fetch fees in USDC silently without confirmation prompts whenever the price falls within the spending key's epoch budget (R1.22) and per-fetch ceiling ($0.05 default, configurable in CLI, SDK or app). User prompts for high-stakes actions belong to the calling agent layer.

**R1.36** *(client†)* Saved payment cards are the sole payment method that triggers an owner confirmation prompt, and prompt only when a charge exceeds the owner's preset limit for that card and site (or on every charge if no limit is set).


## 2. Routes, credentials and listings

*Informative:* A route turns a brittle browser session into a deterministic, content-addressed HTTP recipe. Because routes are learned from real browsing that often involves logged-in accounts, credential isolation and host boundaries are enforced inside the node before any bytes can be listed or executed.

### 2.1 Route entries and content addressing

**R2.1** A route entry is the tuple `e = (d, m, u, θ, a, v, h, j)`: target domain `d`, HTTP method `m`, endpoint template `u`, input schema `θ`, required session type `a`, version `v`, canonical body hash `h`, and lister `j`. The body committed by `h` specifies header templates, strict response schemas, extraction paths and script derivations (R2.9). A route encodes *how* to perform a request, never a cached response payload.

**R2.2** *(client†)* Session field `a` declares only the *kind* of authentication a call needs (none, cookie session, bearer header). An entry MUST NOT contain any secret value: cookies, tokens, passwords and account secrets become typed vault placeholders filled locally from the caller's own OS Keychain at execution time.

**R2.3** Abstract route identity is `id(e) = H(d ∥ m ∥ u ∥ σ)`, where `σ` is the output shape. Requests hitting the same endpoint and returning the same structure share one route identity regardless of query values. Nobody owns a route identity; any number of entries from any contributors compete freely to serve it.

**R2.4** Each entry is uniquely addressed by its content identifier: the cryptographic hash of its canonical body bytes prefixed with the hash algorithm identifier. Identical bodies produce the exact same entry identifier and credit the earliest listing (R2.18), while any modification produces a new entry that competes on its own coin (`coin.per-entry`).

**R2.5** *(both)* The content identifier hashes the exact canonical byte sequence published and served, ensuring formatting or key-order differences cannot create duplicate hashes for identical logic. Clients verify every served body against this digest before payment or execution (R7.19).

*Note:* Zero-knowledge on-chain leak takedowns (formerly R6.15) retired alongside `fraud.none` in favour of R2.11 and `credential.never`.

**R2.6** Published entries are immutable. Updating a broken route produces a new entry with a fresh content identifier (optionally noting the prior version it supersedes), allowing callers' local caches to retain working versions indefinitely.

**R2.7** *(client†)* Route bodies are declarative data, never executable code. Clients reject bodies containing arbitrary code and restrict outgoing requests and session cookies strictly to hosts bound to the site named in the caller's intent (R2.27, R2.28, R3.2).

**R2.9** *(client†)* A route body represents a request dependency graph. During capture, the node traces every outgoing parameter or token back to its source: a prior HTTP response, a cookie, a caller input, a fresh timestamp/nonce, or a pure JavaScript/WebAssembly derivation referencing the site's script URL, content hash and entry function for local sandboxed replay. Only steps requiring genuine browser interaction fall back to the user's local browser.

### 2.2 Passive learning

**R2.8** *(client†)* Nodes learn routes exclusively from their owner's normal browsing and local agent walks under the owner's own sessions; there is no remote scraping fleet or shared credential pool. Owners MAY pause capture or exclude domains at any time. Routes captured while peer networking is switched off (R1.35) stay permanently local. Once peer networking is active, proven routes list by default (R2.14a) after an initial disclosure showing the owner which routes will share and how to mark any route private.

**R2.10** *(client†)* Prior to compilation, the node strips cookies, bearer tokens and authorisation headers, replaces concrete literals with schema types, parameterises account-specific identifiers, and discards raw response bodies.

**R2.11** *(client†)* An open-source deterministic compiler builds the canonical route body from the raw trace so any party can reproduce and audit compilation, rejecting any trace containing unsourced credentials (`credential.never`).

**R2.12** *(client†)* Before listing a public route, the node replays and verifies it in a clean cookieless context over public HTTPS hosts only, blocking loopback and private IP ranges, honouring `robots.txt` rules, and enforcing per-site rate limits.

**R2.13** *(client†)* Signed-in and state-changing routes list on the peer network under the same rules as public routes once scrubbed of secrets (R2.8); every caller executes them using its own local session.

### 2.3 Preventing credential leaks by construction

**credential.never** *(client)* A credential never reaches a published recipe. Secret inputs MUST map to local vault placeholders, and the node refuses to compile any recipe supplying a literal value for a secret field. Before signing a listing, the node scans the exact canonical bytes with the pinned credential detector (not set) and blocks publication if any header token or unsourced credential-like string appears. Session cookies come exclusively from each caller's local jar. Every fetching peer runs the identical detector scan upon receipt and refuses to execute, cache, seed or pay for a flagged body.
*Why a peer follows it:* Both checks directly protect the peer running them: a publishing node prevents leaking its own owner's live credentials, and a fetching node protects its owner's sessions and machine from tainted inputs.

### 2.4 Signed listings and zero-gas publication

**R2.14** *(contract)* A listing is an off-chain record signed directly by the contributor's wallet key (never by a delegated spending key, R1.20), committing to `Listing { routeId, contentId, agentId, version, terms, sig }`, where `terms` binds the description, output shape and USDC price schedule. Keeping listing signatures on the root wallet key ensures a compromised spending key can at most spend up to its USDC cap and cannot publish rogue routes.

*Note:* Fraud-evidence attachments (R6.15) and skill listings retired under `fraud.none` and `skills.none`.

**R2.14a** *(client†)* Active network nodes share proven routes by default unless the owner opts out globally, per domain, or per route. In default `used` mode, a route lists once it passes across 3 distinct days or 5 total runs, paced to at most 5 automatic listings per day (or after one pass up to 20 per day in opt-in `all` mode). Disabling future sharing leaves existing listings untouched; removing a live listing requires a signed withdrawal (R2.16).

**R2.15** *(client†)* Publishing a listing costs zero gas, locks zero bond, and deploys no coin (`coin.launch`). Signed listings propagate peer to peer across the domain-keyed hash table (R7.9, R7.21); the blockchain records only batched Merkle roots (R2.17) and learns of an individual listing lazily upon its first payment claim (R2.18). Clients verify every listing signature against its ERC-8004 identity and discard unrooted or invalidly signed records.

**R2.16** *(both)* Registry history is append-only; nobody overwrites another contributor's entry or claims exclusive ownership of a route. A listing remains live until its signer publishes a withdrawal or the target website delists its domain (R4.17). Withdrawing a listing removes only that signer's offer: peers that already hold the bytes continue seeding them, and the entry's coin and stakers remain unaffected (`decide.delist-not-a-power`).

**R2.21** *(client†)* Because identical recipe bytes share one content identifier, re-listing an exact copy points to the existing entry whose credited first publisher set its listing terms.

### 2.5 Merkle roots and first-publisher credit

**R2.17** *(contract)* Any wallet MAY call `postRoot` at any time with zero bond to anchor the Merkle root `R_t` of a batch of listing hashes at block `t`, publishing the corresponding leaf list to peers.

**R2.18** *(contract)* For any content identifier `c`, the **credited listing** is whichever valid listing of `c` appears in the earliest-block root `R_t` (ties broken by leaf index). The contract records credit lazily when the first claim for `c` presents the signed listing and Merkle proof. Within 14 epochs (open) of initial credit, anyone MAY call `correctCredit` with a proof from an earlier root to reassign future credit; after that window, credit is permanent. The credited contributor holds the right to execute a lister coin launch (`coin.launch`), receives the lister half of a confirming bounty (`coin.bounty-launch`), and collects USDC route shares prior to verified coin staking (`coin.split`).

**R2.19** *(client†)* To prevent copycats from front-running credit before a listing spreads, a contributor's node anchors its listing hash in an on-chain root before gossiping the recipe body, either by paying gas for an immediate `postRoot` or by submitting its leaf hash for free to the reserve's batch poster (R2.20).

**R2.20** *(client†)* The rewards reserve posts one batched listing root every 1 hour (operated at launch by the platform for registered ERC-8004 senders), bounding zero-gas listing latency to at most 1 hour.

### 2.6 Descriptions, embeddings and prompt-injection safety

**R2.22** *(client†)* Route descriptions and sample inputs are generated by the contributor's local agent and treated strictly as untrusted search hints for candidate recall; selection relies solely on on-chain stake and verified calls (R3.17, `rank.score`).

**R2.23** Descriptions are bounded by a maximum length (not set, published alongside the ranking specification; exact limit open).

**R2.24** *(client†)* Contributors never upload raw embedding vectors, preventing adversarial vector poisoning. Indexers and nodes compute embeddings locally from canonical descriptions and response field names using a pinned open weights model.

**R2.25** *(client†)* Whenever a client passes untrusted listing text to a language model, it MUST wrap the text strictly as quoted data to prevent indirect prompt injection.

**R2.26** *(client†)* Indexers or archival nodes wanting the full global registry MAY bootstrap from a snapshot published by any peer, provided every entry is verified against on-chain roots and leaf lists; ordinary nodes look up sites on demand (R7.21) without snapshots.

### 2.7 Host binding and session isolation

**R2.27** *(client†)* To prevent a route listed under one site from exfiltrating cookies or inputs to an unrelated server, a target host is **bound** to a site only when at least one of the following holds:

- (a) **Same registrable domain:** The host shares the site's registrable domain under the pinned Public Suffix List (including private suffixes, isolating multi-tenant hosts such as `app.herokuapp.com`).
- (b) **Site-declared API host:** The verified domain owner lists the exact host in its on-chain site policy (R4.17), in `/.well-known/related-website-set.json`, or in an exact HTTPS `Content-Security-Policy` `connect-src` entry (wildcards and bare schemes never bind).
- (c) **Observed first-party browser provenance:** The client's own browser loads a top-level page of the site and observes a successful request from the main frame to the host. Public calls accept any main-frame request; **signed-in calls** bind only if the site's own first-party script initiated the call (requests triggered by third-party ad, analytics, bot-check or widget scripts bind for public calls only). Browser-observed bindings cache for 30 epochs and re-verify upon expiry, call failure, or script hash change, scoping multi-tenant hosts to the exact observed path prefix.

Target CORS headers (`Access-Control-Allow-Origin`) and third-party peers' claims never bind a host, as the target server cannot vouch for its own authority over the site's session.

**R2.28** *(client†)* Clients MUST block any signed-in call targeting a host not bound for signed-in use, and forward only the specific cookies observed for kind-(c) hosts. Unbound public hosts may be called only if explicitly named by the agent, stripped of sessions and sensitive inputs, and flagged `"host not verified"`. Refused calls abort locally without creating a voucher line. Every hop, including redirects and script-derivation fetches (R2.9), enforces HTTPS, re-checks R2.27, and blocks private, loopback, link-local and cloud-metadata IP resolutions.

**R2.29** *(client†)* Headless environments running without a local browser validate host bindings using rules (a) and (b), plus signed sibling-node certificates from the same owner (R1.18), never trusting bindings asserted by strangers.

### 2.8 Natural replacement instead of in-place repair

**route.replace** *(both)* Broken routes are never patched or repaired in place. When a site changes and an entry stops passing, failing paid calls withdraw callers' stake from its counted collateral (`rank.counted-stake`) and zero fee yield prompts holders to sell. Any node that learns a working updated recipe publishes it as a new content-addressed entry with its own coin (`coin.launch`), overtaking the stale entry as callers fetch it.
*Why a peer follows it:* Callers naturally route traffic to whichever entry returns valid data, and stakers naturally move capital from non-earning broken coins to working ones.


## 3. Discovery, calling and settlement claims

*Informative:* Calling a route happens entirely off the blockchain in milliseconds. Payment vouchers sign cumulative off-chain receipts in USDC, mechanical code checks verify whether the website returned real data before a fee becomes payable, and batch claims settle balances asynchronously on Arc.

### 3.1 Candidate discovery and selection

**R3.1** *(client†)* Given a task intent, an agent's node resolves candidates in order of lowest cost and latency: first its local cache of already-fetched routes; second, peer listings for the target domain via the hash table (R7.21) or an untrusted index node when no domain is known (R3.2); and finally, a live local browser walk if no network entry succeeds, publishing any newly learned route afterward (R2.15).

**R3.2** *(client†)* Candidate resolution proceeds through four deterministic stages: domain/URL scoping, hybrid lexical and embedding recall merged via reciprocal rank fusion, collateral-and-market ranking (`rank.score`), and local LLM tie-breaking only when top candidates score nearly identically. Because the ranking formula is versioned in this specification, any two clients viewing the same registry state compute identical rankings.

*Note:* R3.2 previously referenced an earlier energy score and skill recall, superseded by `rank.pick` and `skills.none`.

**R3.3** *(client†)* Clients filter out any listing priced above the agent's task budget `p̄` or above the owner's automatic per-fetch cap ($0.05 by default).

*Note:* Deterministic `argmin` selection in R3.3 was replaced by proportional `rank.pick`.

**R3.4** *(client†)* To overcome cold-start bias so superior new routes can prove themselves, 5% of picks (`ε`) on every public, read-only intent are allocated to unverified entries (R3.36) weighted by contributor reputation. A failed exploration pick costs the caller nothing (`decide.failed-fetch-always-free`). Exploration picks NEVER fire on state-changing (R1.25) or signed-in calls. When no unverified candidate exists, every pick follows `rank.pick`.

**R3.6** *(client†)* Entries whose credited wallet has exhausted its daily fee capacity (R6.12) are skipped for paid picks until the next epoch.

**R3.7** *(client†)* Clients treat both index nodes and domain DHT providers (R7.21) as untrusted transport: every returned candidate MUST carry its contributor signature and Merkle root inclusion proof, and the client recomputes rankings locally. Querying multiple providers or inspecting root leaf lists exposes censorship omissions.

**R3.36** *(client†)* Clients expose all live entries for a route rather than hiding alternatives. Entries with fewer than 30 counted uses (R5.18) carry an *unverified* tag; dark entries in backoff (R7.12) appear as unavailable; and domain-delisted routes (R4.17) are excluded completely.

**R3.37** *(client†)* An agent MAY explicitly request a specific unverified entry by ID or fall back to one after ranked entries fail, subject to the same host-binding guards (R2.27, R2.28) and write restrictions (R1.25).

### 3.2 Fetching and caching recipe bodies

**R3.9** *(client†)* A client always takes the expected content hash from the contributor-signed, root-verified listing, never from the serving peer. Upon downloading the body (R7.1), it hashes the bytes locally and drops any mismatch without paying; an unanswered request records a failed attempt and moves to the next candidate (R3.19, R7.9).

**R3.10** *(client†)* To fetch a missing recipe body, the client signs a USDC payment voucher covering the listed detail fee and sends it to a provider, which releases the bytes upon verifying voucher solvency (R7.5). When all listed entries fail to serve or pass, the node falls back to its browser and learns a fresh route (R7.17).

**R3.11** *(client†)* Before releasing a recipe body, a serving peer checks via any Arc RPC that the voucher covers the applicable price schedule, the payer's deposit is funded without a draining withdrawal pending, the spending key is valid and within cap. The chain keeps no failure count; a peer MAY apply its own policy from what it saw itself (R4.26, R4.27).

**R3.12** *(client†)* Once fetched, a working recipe body is cached locally and reused across unlimited future tasks with zero additional protocol fees for as long as that version continues working.

### 3.3 Off-chain EIP-712 vouchers and receipt lines

**R3.13** *(contract)* Payment vouchers are `EIP-712` typed messages signed by an authorised spending key or wallet key (R1.20): `Voucher { payer, agent, epoch, cumulative, lines, passedLines, receiptRoot, sig }`, where `receiptRoot` commits to a Merkle tree of individual receipt lines and `lines`/`passedLines` expose the payer's aggregate pass rate publicly without writing per-call transactions on chain.

**R3.14** *(contract)* Each voucher leaf is `Line { entry, kind, amount, passed, author, domainHash, server, unanswered, bounty }`, where `kind` is always `detail` (`execute.none`, `skills.none`), `server` identifies the serving peer, and `unanswered` flags timeouts (R7.11). One fetch produces one receipt line.

*Note:* Under `coin.bounty-launch`, how the `bounty` struct field encodes site-level `coin.bounty-by-use` matching is an open implementation item (Annex B).

**R3.15** *(contract)* Fetching bytes appends a pending line to the voucher tree, and the immediately following voucher signs whether the resulting HTTP call passed or failed. Once signed as passed, a line remains permanently claimable regardless of later vouchers.

**R3.16** Reconciling immediate payee claims (which reveal `passed` on chain) with epoch commit-reveal reporting (R5.7) remains open (`open`).

### 3.4 Mechanical call verification

**R3.17** *(client†)* Payment depends on deterministic verification in the caller's client rather than human ratings. A call is signed `passed` if and only if: (a) HTTP status matches the route's declared success codes (`2xx` default); (b) the final URL after redirects stays on a bound host (R2.27) rather than a login or challenge page; (c) the payload validates strictly against the response schema with all required fields present; (d) at least one declared result field is non-null (unless emptiness is explicitly permitted); and (e) on signed-in or state-changing calls, the sorted path-and-type structural hash matches. Any violation marks the line `failed`.

**R3.18** *(client†)* A node MAY additionally ask its local model whether a mechanically valid response genuinely answers the user's intent; the model can only downgrade a pass to a failure, never override a failed code check, and private signed-in payloads never leave the machine for checking.

**R3.19** *(client†)* When a candidate fails to serve bytes or fails R3.17, the client marks the line failed (free to the caller, `decide.failed-fetch-always-free`), steps to the next-ranked candidate, and launches its local browser only after candidates are exhausted.

**R3.21** *(client†)* The mechanical check of R3.17 governs settlement with zero subjective ratings. State-changing routes run an asynchronous read-back check (R5.6) for local verification without reversing settled claims.

### 3.5 Batch claims and gasless earner backstop

**R3.22** *(both)* Payees settle directly against payer deposits via `claim` or `claimBatch`, submitting receipt lines, Merkle proofs, the payer's voucher signature, and (on an entry's first ever claim, R2.18) its signed listing and root proof. If a payee has not claimed a line halfway through the claim window, the **payer's own node** submits the claim as a backstop (`showAndClaim`), guaranteeing that contributors with zero gas still get paid; servers refuse new vouchers from payers with overdue backstop claims.

**R3.23** *(contract)* Each claimable line settles at most once from the payer's USDC deposit under chapter four and `coin.fetch-pays`, reverting on replay. Total payouts across any sequence or ordering of claims never exceed signed obligations or available deposit balances, and fully funded passed lines always pay in full.

**R3.24** *(contract)* Settled claims are final and non-reversible.

**R3.25** *(contract)* Every settled claim increments on-chain counters for the payer's total lines, failed lines, distinct domains and first active epoch, alongside the entry's served and unanswered tallies (R7.11).

**R3.28** *(client†)* Payees SHOULD submit claims within 2 epochs of voucher signing so lines settle ahead of any pending payer deposit withdrawal (R1.27).

### 3.6 Open dollar pricing

**R3.29** *(contract)* All fetch prices, deposits, caps, vouchers and claims are denominated and settled strictly in USDC with no price oracle on the payment path.

**R3.30** Each contributor sets the USDC price of its own entry freely, bounded below only by USDC's smallest unit ($0.000001).

**R3.31** *(client†)* A listing's price schedule MAY vary transparently based on a caller's public on-chain age and failure rate; clients evaluate candidates using the price applicable to themselves.

**R3.32** *(both)* Verified domain owners MAY publish a minimum detail-fee floor for routes calling their domain via `setSitePolicy`, honoured by default clients.

**R3.33** *(client†)* The protocol and client software suggest no default route price, allowing equivalent routes to compete prices down freely. Public documentation states who sets prices and the $0.000001 technical minimum rather than quoting fixed call prices (what fallback price a node uses if an owner specifies none, not set, is open).

**R3.34** *(client†)* Searching for listings and executing cached routes against websites are both free (`execute.none`).


## 4. Fee splits, website escrow and free failures

*Informative:* Every passed route fetch divides cleanly into three flows: rewarding the staked verifiers behind the route, compensating the website whose backend answered the call, and burning UNB. Failed calls are always free, so callers can try unfamiliar routes without risk; the cost is that a payer that marks working fetches failed is not stopped on chain (§4.4).

### 4.1 Three-way split of a passed fetch fee

**R4.1** *(contract)* A passed detail line of price `p` (in integer units of $0.000001) splits into `c(p) = ⌊φ_c · p⌋` for the route, `s(p) = ⌊φ_s · p⌋` for the website's domain escrow, `h(p) = ⌊φ_h · p⌋` for the server, `q(p) = ⌊φ_q · p⌋` for the platform, and `b(p) = p − c(p) − s(p) − h(p) − q(p)` for the UNB burn. The shares are `φ_c` = 65%, `φ_s` = 30%, `φ_h` = 0%, `φ_q` = 0%, and `φ_b` = 5%. The route's share `c(p)` distributes according to `coin.fetch-pays` and `coin.split`.

*Informative:* Under `decide.one-part-to-stake` (10 November 2026), both the server share and the platform share of detail fees were set to zero and folded into the route share, leaving the route's staked holders as the sole earning counterparty alongside the website and the burn.

**R4.2** *(contract)* The integer shares sum to `p` with zero remainder lost, `b(p) ≥ φ_b · p`, and `b(p)` is at least one unit whenever `p > 0`, costing the route less than one smallest unit in floor rounding.

**R4.3** *(contract)* The serving share `h(p)` (0%) applies only to passed lines; a failed line pays zero to every party.

**R4.4** *(contract)* Fee shares are constant constants of the immutable contracts, changeable only by deploying a new contract suite that peers adopt voluntarily. Reserving a fee share for the target website is a permanent constitutional commitment (R10.5).

**execute.none** *(contract)* Websites set no per-call execute toll, no receipt line carries kind `execute`, and running a cached route is free; sites earn from route adoption via their 30% escrow share (R4.1) while retaining full domain-policy controls (R4.17). Should execute tolls ever be introduced in a future deployment, the entire toll would go to the website (`decide.execute-to-site`).

**skills.none** *(contract)* Multi-site skill listings are omitted from the protocol: every listing names a concrete target domain, and no fee split exists for site-free calls.

**R4.31** The protocol places no `x402` payment handshake on HTTP calls to websites; agents call websites directly from their own machines, and any site returning HTTP `402` with its own payment terms operates outside this settlement layer.

### 4.2 Epoch-batched buy-and-burn

**R4.6** *(contract)* At claim time, each line's burn share `b(p)` accrues in USDC inside Settlement's burn buffer. Once per epoch, any caller MAY invoke `burnBatch`, swapping the buffered USDC for UNB through UNB's public pool (capped per batch at 0.5% of the pool's USDC reserve, carrying any excess into the next epoch) and permanently burning the acquired UNB. The caller is reimbursed from the buffer for gas plus a 10% incentive margin, and the swap pays the pool's standard 4% fee. Burned UNB goes to nobody; passive UNB holders receive no fee distribution.

**R4.7** The burn is a deterministic fee-funded buyback and MUST be disclosed plainly as one rather than as a price floor.

**R4.8** Batching swaps once per epoch and sizing them against pool reserves (R4.6) avoids reading external price feeds and avoids charging swap gas on sub-cent claims (whether `burnBatch` also enforces a minimum slippage parameter remains open).

### 4.3 Permissionless website escrow and domain verification

**R4.12** *(contract)* Websites post zero bond to accrue or claim their fee share.

**R4.13** *(contract)* Every settled passed line on domain `d` credits `s(p)` USDC to `E_d`, that domain's on-chain escrow balance, whether or not the website operator has registered or heard of Unbrowse.

**R4.14** *(contract)* Domains with DNSSEC claim escrow trustlessly via `claimEscrow`, submitting an on-chain cryptographic proof of a signed `_unbrowse.<domain>` TXT record naming their payout wallet. After a fixed security wait of 14 epochs (`escrow.wait`), `releaseEscrow` transfers the accrued balance and routes subsequent shares directly to that wallet. Newer DNSSEC signatures can rotate the payout wallet (restarting the wait).

**decide.dnssec-only** *(contract)* A domain is bound to a payout wallet only by the DNSSEC proof of R4.14. There are no HTTP witnesses: no drawn committee of nodes fetches a file and votes, and there is no witness pledge, answer deposit, witness fee, re-check or seasoning. A domain without DNSSEC cannot be bound until its owner enables DNSSEC with its DNS provider; its share keeps accruing in escrow meanwhile, and nothing is lost by waiting. The witness path was the last place a committee of nodes decided something about money, and it carried weaknesses the contract could not close (a block proposer could grind the draw, and a pledge split across unlinked wallets bought extra seats). DNSSEC needs no third party: the contract verifies the DNS signature chain itself.

**R4.16** Disposition of long-unclaimed domain escrow (not set) is open (`open`).

**R4.17** *(both)* Verified domain owners (via R4.14 or R4.15) MAY call `setSitePolicy` on `Domains` to set a minimum USDC fee floor for their routes, delist all routes on their domain, or declare up to 64 exact lowercase ASCII API hosts/path prefixes (no wildcards) for R2.27(b). Default clients refresh site policies for active domains once per epoch and enforce floors, delistings and host bindings automatically.

**R4.18** *(contract)* Website operators MAY publish routes for their own domains like any contributor, collecting their 30% domain share alongside whatever their staked route coins earn (`coin.split`).

*Note:* Under `decide.split-by-stake`, listing confers no automatic contributor cut without staked coins.

**R4.19** *(client†)* Cross-site contributor reputation counts uses only on domains whose escrow was claimed by an independent wallet; unclaimed domains confer zero cross-site reputation, and self-owned domains boost only entries on that same domain.

**R4.32** *(client†)* Any website MAY opt out of Unbrowse calls immediately without a wallet or domain proof by disallowing user-agent token `Unbrowse` in standard `robots.txt` (RFC 9309). Compliant clients re-check `robots.txt` at least every 1 epoch and stop calling disallowed paths, leaving any accrued escrow untouched.

### 4.4 Failed fetches are free

**decide.failed-fetch-always-free** *(contract)* A failed fetch never costs its payer anything, whatever share of its fetches fail. Settlement charges no failed line and pays nobody for one, and it keeps no count of a payer's failures. There is no free-failure cap: its rate (`refund.max_fail_rate`, removed; was 25%), floor (`refund.min_lines`, removed; was 20), window (`refund.window`, removed; was 30 epochs) and value limit (`refund.fail_value`, removed; was 5%) are removed, along with R4.20 to R4.25 and `decide.fail-value-five`. This replaces the cap adopted in §70.1 item 2 and changes R10.4 and R10.11. Proved: a failed line is charged nothing whatever the history (`UnbLaunch.free_failure_costs_nothing`), a payer is charged exactly its passed lines (`UnbLaunch.charge_is_passed_lines`), and a payer that always signs fail pays nothing (`UnbLaunch.always_fail_pays_nothing`).

*Why:* a payer that hits a broken route many times did nothing wrong, yet the cap charged it in full for failures past a quarter of its paid lines. The owner decided on 12 November 2026 that failed fetches stay free regardless of the failure rate.

*What it costs:* the payer's own client signs pass or fail, so a payer that signs every fetch failed gets every answer unpaid and keeps the body, and nothing on chain bounds it (`attack.fail-keep-body`). The owner accepted this cost over three alternatives: servers reading an on-chain failure record, a dispute raised by the server, and a higher cap.

*What it costs the payer:* a failed line pays no fee, so it buys the payer none of the entry's coin (`coin.fetch-buys`), and a wallet with no passed counting line has not checked the entry, so coin it buys on the curve earns nothing (`coin.check`) and stays out of counted stake (`rank.counted-stake`). A payer that wants to hold the entry's coin therefore pays for its fetch; the attack pays only a payer that wants the answer and no stake, by one fee per body.

*Kind and why a peer follows it:* the money part is in the contract, which never charges a failed line, so no client version can make a failed line cost its payer anything or pay anyone. Declining a payer (R4.27) is a client choice: a server earns nothing from a payer that always signs fail, so each server gains by refusing such a payer, and a server that keeps serving it only loses its own bandwidth. While some peers still run a client that counts failures against the old cap, they can only refuse a payer earlier; no peer can charge for a failure, because the contract has no path that does. The rule binds only a deployment built with it: a Settlement already deployed with the cap keeps charging over-cap failures, so peers get the rule by moving to the new deployment, as with every contract change (`deploy.new`).

**R4.26** *(client†)* A serving peer MAY estimate a payer's false-failure rate from the lines it served that payer and the receipts it holds itself. The chain records no failures for it to read.

**R4.27** *(client†)* Serving peers MAY decline requests from payers whose estimated false-failure rate exceeds `τ` = 10% (client) or who misreported a canary within `rating.canary_penalty` (not set, open). Each server sets its own policy; declining is not a network rule.

**R4.29** *(contract)* Settlement enforces nothing about failures: it charges no failed line and keeps no failure count. The false-failure gate of R4.27 is only a client filter: whatever a server estimates, it can decline a payer but never charge it for a failed line (`UnbLaunch.fail_gate_never_charges`).

### 4.5 Counting lines

**R4.33** *(contract)* A settled passed line **counts** for protocol state transitions only if it paid at least the entry's listed price for that caller (R2.14, R3.11) and at least $0.000001, preventing zero-price or discounted dust lines from gaming state. Sub-price lines still transfer their stated USDC and do nothing else: they record no verification check (`coin.check`), unlock no bounty (`coin.bounty-confirm`, `coin.bounty-by-use`), and maintain no counted stake (`rank.counted-stake`).

*Note:* R4.33's references to retired bounty stakes (R8.26), jurors (R6.34) and route pools (R6.27) are replaced by the route-coin rules above.


## 5. Ranking, selection and diagnostic reports

*Informative:* Because local caching hides repeat calls and cheap wallets make Sybil identities trivial, Unbrowse ranks competing entries using signals an attacker must commit real capital to move and that real users automatically withdraw when a route breaks: verified staked collateral (`Q`) and time-weighted market cap (`M`).

### 5.1 Collateral-and-market rank

**rank.score** *(client)* Each entry's selection score is the geometric mean `S = √(Q · M)`. Here `Q` is the conservative UNB collateral value of the entry's counted stake (`rank.counted-stake`, `rank.collateral`), valued last-out (`rank.last-out`) and scaled by each holder's chosen unstaking delay (`rank.exit-delay`). `M` is the entry coin's time-weighted market cap: its fixed 1,000,000,000 total supply multiplied by its time-weighted price in UNB over 24 hours (pending `open.rank-window`). No per-identity reputation weight, historical payout multiplier or decay clock enters `S`.
*Why a peer follows it:* Ranking by `√(Q · M)` steers the client toward entries backed by both live market preference and verified users whose calls currently succeed, minimising failed calls for its own owner; a peer using a different local rank affects only its own choices.

**rank.counted-stake** *(client)* Staked coins enter an entry's counted stake `Q` if and only if they are actively locked (`coin.stake`) by a wallet that has verified the entry (`coin.check`), weighted by exit delay (`rank.exit-delay`), and **that wallet's own latest paid call on the entry passed**. As soon as a wallet's paid call fails, its entire stake drops out of `Q` until a subsequent paid call passes (retaining the latest-call clause is tracked under `open.latest-call-rule`).
*Why a peer follows it:* Counting stake from callers whose own requests just failed would route the client's owner toward broken endpoints.

**rank.exit-delay** *(both)* When staking, a holder commits to an unstaking cooldown (`24 hours` by default); the staking contract holds coins earning zero yield for that duration after unstake is requested, and `Q` weights the stake in proportion to that chosen delay immediately from block one without a blind warm-up age (exact scaling curve tracked under `open.exit-delay-scale`).
*Why a peer follows it:* Weighting slower-exiting capital higher favours backing that cannot flee instantaneously before callers test the route.

**rank.collateral** *(client)* Counted stake is measured in UNB collateral value rather than raw coin counts: each stake is priced at the lower of its 24 hours time-weighted average price and its immediate last-out liquidation value (`rank.twap-cap`, `rank.last-out`). When a route breaks, failing fetches pull callers out of `Q` and holder sales depress the curve price valuing all remaining stake, dropping rank without needing an on-chain pass-rate counter.
*Why a peer follows it:* Valuing stake by realisable UNB collateral measures genuine economic skin in the game.

**rank.twap-cap** *(client)* Every counted stake is valued at `min(TWAP, spot last-out sale value)` over 24 hours.
*Why a peer follows it:* Taking the minimum prevents single-block flash buys from inflating `Q` while ensuring falling spot reserves lower `Q` immediately without waiting for the moving average to catch up.

**rank.last-out** *(client)* Spot liquidation value for staked coins is computed as if every unstaked circulating coin were sold back into the curve ahead of them, so unstaked speculative holdings contribute zero collateral to `Q` (affecting `M` only while held across the time-weighted window).
*Why a peer follows it:* Ignoring unstaked float prevents hit-and-run traders who refuse to lock coins from inflating verified collateral.

*Informative:* Because any modified recipe hashes to a new entry with a fresh curve (`coin.per-entry`), a challenger deploying far more capital than an incumbent lister can launch a working copy and out-earn backing the original; this is accepted as open competition (`decide.capital-copy-accepted`), since a copy and a legitimate post-break replacement are indistinguishable on chain.

### 5.2 Proportional pick and per-wallet capacity

**rank.pick** *(client)* Outside the newcomer exploration share (R3.4), clients select among budget-eligible entries for an intent in proportion to `S` (`rank.score`), subject to daily wallet capacity (R5.22). Diagnostic pass rates (R5.16) remain visible to users and agents without driving selection.
*Why a peer follows it:* Proportional selection concentrates calls on the strongest verified entries while letting a rising replacement gain traffic smoothly as its rank climbs; older clients still picking by pass rate remain safe and affect only their own owner.

**R5.22** *(client†)* Entries belonging to a wallet that has reached its daily fee cap (R6.12) are skipped for paid picks until the next epoch.

**R6.12** *(client†)* Across all its listed entries, a wallet accepts paid detail fees up to `K_a = K_0 + γ · V_a` per epoch, with base allowance `K_0` = $2.00 and growth factor `γ` = 0.2, where `V_a` sums cumulative route shares `c(p)` claimed from unlinked callers on passed lines. Exceeding `K_a` pauses paid picks until the next epoch without delisting the wallet's entries.

*Note:* R6.12's historical references to claim vesting (R6.14), fraud forfeits (R6.16) and route pools (R6.25) are superseded.

**R6.13** Daily capacity `K_a` depends strictly on clean earned fees, never on token price or staked UNB, so neither whale capital nor Sybil wallet splitting expands initial capacity. Link-audit criteria, on-chain enforcement, and whether `K_a` remains necessary alongside route coins are open (`open`).

### 5.3 Diagnostic pass rate and legacy default switch

*Informative:* Under `rank.pick`, the Bayesian pass rate and sequential switch test below no longer govern automatic traffic selection; their ongoing diagnostic or UI role is tracked under `open.coin-switch-test`.

**R5.16** *(client†)* Each entry's diagnostic weighted pass rate is `θ̂_r = (a₀ + P_r) / (a₀ + b₀ + P_r + F_r)` under a `Beta(a₀, b₀)` prior (`a₀` = 2, `b₀` = 2) over decayed, payer-weighted passes `P_r` and failures `F_r` (whether total evidence is capped at not set is open).

**R5.17** *(client†)* For diagnostic default labelling, an incumbent `i` retains default status until a challenger `c` satisfies a one-sided sequential test `P(θ_c − θ_i > δ) ≥` 95% with margin `δ` = 0.02 (ties preserve the earlier-rooted entry).

**R5.18** *(client†)* Switch evidence (`P_c`, `F_c`) counts only from callers more than 2 hops away from the challenger's lister in the payment graph (falling back to exploration picks alone if pilot self-payer link recall measures below 50%).

**R5.19** *(client†)* No artificial hysteresis is added to `θ̂_r` or R5.17.

**R5.20** *(client†)* Both `rank.score` and R5.16–R5.19 are versioned together so compliant nodes rank deterministically.

### 5.4 Shared reputation reports

**R5.2** *(client†)* Entry reputation across revealed epoch reports `K_r` (each bound to a settled receipt line) is `ρ_r = Σ_k w(j_k) · δ^(t−t_k) · o_k / Σ_k w(j_k) · δ^(t−t_k)`, with `o_k ∈ {0, 1}`, caller weight `w(j) = g(age_j, spend_j, spread_j)` (not set, open), and per-epoch decay `δ` (not set, open). Entries with empty `K_r` qualify as unverified for exploration (R3.4, R3.36).

**R5.3** *(client†)* Passed lines contribute to shared reputation from any caller weighted by `w(j)`.

**R5.4** *(client†)* Failed lines enter shared reputation (`F_r`) only from callers holding optional proof of personhood (R1.33), capped at 1 complaint per person per route per day; unverified failures demote the entry locally in that caller's own client for 2 hours.

*Note:* Voiding reports via fraud rulings (R5.12) retired with `fraud.none`.

**R5.5** *(client†)* Contributor reputation carrying across domains counts only uses by established callers on domains claimed by independent website owners (R4.19).

**R5.6** *(client†)* State-changing routes trigger a delayed read-back check in the caller's client without altering settled line payouts (how read-back routes are linked now that `skills.none` retired skills, and whether read-back gates `passed`, are open in Annex B).

**R5.7** *(client†)* Shared reputation reports commit by hash during their active epoch and reveal after epoch close so servers cannot retaliate mid-epoch (storage of commitments and interaction with mid-epoch claims under R3.16 remain open).


## 6. Route coins, curves and pay-then-buy settlement

*Informative:* Giving every byte-exact entry its own fixed-supply coin traded against UNB solves two problems with one primitive: early builders and bounty sponsors get upside for discovering routes first by sitting at the bottom of the bonding curve, while paying callers automatically become staked verifiers whose working calls sustain the route's rank and whose failing calls let better replacements overtake it (`decide.route-coins-only`).

### 6.1 One deterministic coin per entry

**coin.per-entry** *(contract)* Each content-addressed entry `c` has at most one route coin, deployed as a minimal proxy clone of a shared ERC-20 implementation (`build.oz-erc20`) at `CREATE2(factory, salt = c)` with a fixed supply of 1,000,000,000 coins. Because address derivation is deterministic on `c`, an exact copy of an existing recipe maps to the same entry and can never deploy a rival coin, and zero on-chain state exists for an entry until its coin launches.

**build.oz-erc20** *(contract)* Every route coin clones OpenZeppelin's standard `ERC20` implementation: the entire 1,000,000,000 supply mints once into the bonding curve at launch, with zero owner, admin, mint, burn, pause or transfer-hook functions.

**build.clank** *(contract)* Bonding-curve math and launch snipe taxes adapt Clank's open EVM launch contracts with both audit findings resolved (`CL-02` removing owner fee fallback on failed launches, and `CL-03` enforcing explicit trade deadlines and slippage minimums) and all owner roles stripped, preserving upstream SPDX licences (`open.licences`).

**arc.unb** *(contract)* UNB is the live base token on Arc mainnet, reached by Settlement and route-coin contracts via the `V4UnbPool` adapter connected to UNB's existing public liquidity pool. Every route coin prices against UNB, and epoch fee burns swap through that pool.

### 6.2 Atomic first-buy launch and anti-snipe protection

**coin.launch** *(contract)* Publishing a route listing deploys no contract and grants zero free coins. An entry's coin launches in a single atomic transaction (gas paid by the launcher) that deploys the ERC-20 clone, initialises its curve (`coin.curve`), and executes an opening purchase funded either by a releasing bounty (`coin.bounty-launch`) or by the entry's credited contributor (R2.18).

**decide.dev-buy-default-on** *(client)* A lister's node launches its entry's coin with a first buy by default, sized at 1% of the wallet's UNB at listing; a wallet holding no UNB lists without launching. The owner can change the share or turn the buy off. A peer follows it because a lister that buys first sits at the bottom of its own curve and has stake behind its route from the first fetch; a client that skips it harms nobody but its owner.

**coin.snipe-tax** *(contract)* To prevent automated bots from capturing the bottom of a freshly opened curve in its opening blocks, buys executed within 5 minutes of launch pay an extra surcharge on top of the curve fee, decaying linearly from 50% at launch block to zero at window end and routed entirely to the UNB burn buffer (R4.6). The atomic opening purchase inside `coin.launch` is exempt.

### 6.3 Constant-product curve and non-expiry

**coin.curve** *(contract)* Each launched coin trades against UNB on an ownerless constant-product bonding curve with virtual reserves (`build.clank`): 100% of the fixed supply is offered on the curve, with nothing held back, anchored by a virtual reserve of 30,000,000 UNB. Every buy and sell specifies an execution deadline and minimum output, and pays 1% of its UNB notional to the platform. Price rises monotonically with cumulative net purchases, rewarding earliest backers, while redemptions never exceed actual UNB reserves held by the curve.

**decide.no-graduation** *(contract)* A route coin does not graduate: its curve is the permanent market. No supply is held back, there is no coin pool and no pool fee, and a buy can never exhaust the curve, since the price rises without bound toward the last coin. Graduation came with the launcher design the coins were modelled on; its reason was to settle money stuck in a curve that never filled, which no longer applies with no expiry and no refunds (`coin.no-expiry`). The model holds without it: every invariant and scenario passes, and a replacement still overtakes a broken route on its sixth fetch.

**arc.v4-poolmanager** *(contract)* UNB's own public pool lives in Arc's Uniswap v4 `PoolManager`, reached through an adapter whose addresses come from deployment environment variables, never hardcoded repo constants. Route coins use no pool.

**coin.no-expiry** *(contract)* Route coins have no expiration date or forced-redemption deadline: curves remain open indefinitely, holders exit whenever they wish by selling into the curve, and no party can drain curve reserves.

### 6.4 Staking, counterparty verification and zero forfeiture

**coin.stake** *(contract)* Unstaked coins earn zero fees. Holders lock coins in the entry's staking contract to earn USDC starting from the next epoch close, specifying their chosen unstaking cooldown (`rank.exit-delay`, 24 hours client default), during which unstaked coins earn nothing before returning. Outside automatic stakes created by passed fetches (`coin.fetch-buys`, `coin.fetch-stakes`), nodes buy, stake or sell coins only on explicit owner instruction.

**coin.check** *(contract)* Staked coins earn USDC yield only after their wallet has **checked** (verified) the entry via a counting line (R4.33): either paying at least the listed price for a passed fetch served by a distinct identity, or serving a claimed passed fetch paid by a distinct identity through its own live listing. Verification is recorded once per `(wallet, entry)` pair and never expires (`decide.coins-keep-91`).

**bond.none** *(contract)* There is no upfront listing bond and no payout withholding: USDC claims pay out whole, listing is free, and staked route coins (`coin.stake`) are the protocol's sole form of stake.

**fraud.none** *(contract)* There are no on-chain fraud proofs, dispute courts, juror votes, backer slashes or stake forfeitures; a holder's sole financial exposure is market price and call volume on the entry's coin (`open.coin-fraud` tracks whether cryptographic equivocation should delist an entry without slashing).

*Note (`decide.no-bond-no-slash-11nov`):* The absence of a bond and of slashing was tested against the model before the contracts were built. The only fault the chain can prove is a lister signing two bodies under one version, and that lister already earns nothing. A lister bond does not reach the harm users suffer (a lister that sells before a break commits no provable act) and rations listing by wealth; slashing on failure reports lets a rival take an honest route's bond or its stakers' coins for free; slashing staked coins takes from users whose fetch bought and staked the coin for them. So no function takes coins, UNB or USDC from a wallet except at that wallet's own call, a failure report changes only the reporter's own counted-stake flag, and no report or proof pays a reward. Each stake lot unlocks after its own exit delay, and coins staked for a wallet by someone else go in their own lot, so nobody can lengthen another wallet's exit.

### 6.5 Pay-then-buy settlement on every passed fetch

**coin.fetch-pays** *(contract)* One symmetric rule governs how a passed detail line's 65% route share divides between cash yield and curve purchases, eliminating any special lister royalty: every coin in the entry's fixed 1,000,000,000 supply holds an equal `1 / supply` claim on the route share. Coins staked *prior to the current epoch* by verified wallets (`coin.check`) receive their proportional share directly in USDC; the share attributable to every remaining coin (unsold on the curve, held unstaked, or staked during the current epoch) buys the entry's coin for the caller (`coin.fetch-buys`) and stakes it (`coin.fetch-stakes`). Because newly staked coins earn starting next epoch, a caller never pays itself on its own fetch, and the lister earns purely through its own staked coins.

**coin.fetch-buys** *(contract)* Inside the claim transaction for a passed counting line, the portion of the route share not paid out in USDC to prior verified stakers (`coin.fetch-pays`) swaps atomically from USDC to UNB through UNB's public pool and buys the entry's coin on its curve on the caller's behalf, without the caller ever holding UNB. Entries without a launched coin (or sub-unit dust remainders) credit directly to the credited contributor under `coin.split`.

**coin.fetch-stakes** *(both)* Coins purchased by `coin.fetch-buys` lock immediately in the entry's staking contract for the caller under its client-specified exit delay (24 hours default). Because the caller just passed a counterparty fetch (`coin.check`), those coins enter counted collateral `Q` immediately and drop out of `Q` if a later paid call by that caller fails (`rank.counted-stake`).
*Why a peer follows it:* Auto-staking fetched coins boosts the ranking stability of a route the caller's own agent uses and earns future USDC fees, while remaining withdrawable after the caller's chosen cooldown.

**coin.split** *(contract)* The entire 65% route share of a settled detail line belongs to the entry's coin economy (`the holders' part`), with zero deduction for listing credit (R2.18) and zero platform cut (0%). Prior verified stakers accrue USDC via `coin.holders-share` and the complement buys staked coins for the caller via `coin.fetch-buys` (falling back to paying the credited lister in USDC only when no coin exists yet or the buy slice rounds to zero, preventing stranded funds). Website (30%) and burn (5%) shares settle per R4.1.

**coin.holders-share** *(contract)* Each coin staked before the current epoch by a verified wallet accrues `1 / supply` of the route share in USDC via a single `O(1)` global accumulator (`coin.fetch-pays`), ensuring a tiny dust stake earns strictly its tiny fraction of total supply rather than capturing the whole pot when few coins are staked.

**coin.claims** *(contract)* Accrued staker USDC balances settle via wallet-initiated claims against a running sum kept per coin, whenever the holder chooses, so the contract never loops over holders. Nothing vests: a claim pays what is owed at once (`decide.no-claims-vest`), since the hold existed so a fraud forfeit could reach claims and there is no forfeit and no bond.


## 7. Peer-to-peer serving, liveness and the hash table

*Informative:* Nobody hosts a central directory of Unbrowse routes. Nodes find domain listings and fetch content-addressed recipe bodies directly from one another over a Kademlia distributed hash table, seeding cached routes the way BitTorrent peers share files. Because every byte is verified against the listing's cryptographic hash, seeders cannot tamper with recipes and require neither bonds nor serving fees.

### 7.1 Who serves recipes

**R7.1** *(client†)* Any node holding an entry's canonical bytes MAY serve them: the contributor's own nodes discovered via ERC-8004 metadata (R1.15), contributor-designated hosts, or any peer seeder (R7.18). Routes are never centrally assigned, sharded or key-split across operators.

**R7.3** *(client†)* Seeders and designated hosts require zero bond and zero prior reputation to serve because hash verification makes tampering impossible (R7.19). Unresponsive providers are dropped locally by clients (R7.20).

**R7.6** The protocol serving share of a passed detail fee is 0% (R4.3), with zero payment on every failed line (`decide.failed-fetch-always-free`) and no protocol subsidy or cost floor. Peers seed routes they use and earn through any staked coins they hold on those routes; an entry with zero online providers simply goes dark, steps off client rankings (R7.12), and yields traffic to competing entries or browser relearning.

**R7.18** *(client†)* Any full node that has paid for and cached an entry's body MAY seed it by publishing a signed provider record (`contentId`, `agentId`, signature) in the distributed hash table, valid for 1 hour and refreshed every 20 minutes (publishing a signed withdrawal on clean shutdown). Lookups return at most 20 providers, rate-limited per peer, ignoring unregistered senders. Nodes seed cached entries naturally regardless of whether they hold the entry's coin (`decide.seeding-natural`); light-mode nodes do not seed.

**R7.22** *(client†)* Network peers are individual node processes rather than wallets. A single on-chain identity MAY register up to 16 distinct nodes in its metadata (R1.15), each with its own peer ID, routing position and connections, sharing the identity's payouts and coin holdings.

**R7.34** Full nodes that fetched and retain a working route SHOULD serve its signed listing and advertise a domain provider record by default while the listing remains live and cached on disk, keeping popular routes discoverable even when their original lister goes offline. Light nodes advertise nothing (R1.11).

### 7.2 Releasing and verifying bytes

**R7.5** *(client†)* Serving peers release recipe bytes strictly against a valid voucher covering the applicable fee, after verifying on chain that the caller holds a funded deposit without a draining withdrawal, and an active spending key within cap. No free-failure headroom is checked: a failed line is always free (`decide.failed-fetch-always-free`).

**R7.19** *(client†)* Clients MUST hash every received body and verify that it matches the content identifier inside the contributor-signed listing (R2.4, R2.14). Any mismatch counts as a failed attempt against that provider, is never paid, and is discarded unexecuted.

**R7.20** *(client†)* Providers that time out or return hash mismatches are locally demoted on R7.12's doubling backoff schedule up to 32 epochs; an entry counts as dark (R7.11) only when every known provider fails to serve it. Fetching clients also scan verified bytes for unsourced credentials and refuse to run, cache, seed or pay for flagged recipes (`credential.never`).

*Note:* On-chain leak takedowns (R6.15, R6.36) retired alongside `fraud.none`.

**R7.4** *(client†)* Direct peer fetches reveal to the serving node which content identifier a caller requested; optional relay or indexer-proxied fetches (`privacy.relay`: not set) remain open.

**R7.15** Recipe bytes are public commercial goods rather than DRM-encrypted secrets: once paid for, bytes are readable by the buyer. Exact copies map to the same entry and credit (R2.4), while modified copies launch separate curves and compete openly on rank (`decide.capital-copy-accepted`).

### 7.3 Dark entries and availability fallback

**R7.11** *(client†)* A fetch attempt that receives no matching bytes from any provider records an `unanswered` failed receipt line. An entry tried during an epoch with zero successful deliveries is marked dark for that epoch, stepping off client rankings 1 epoch later (exact multi-payer reporting thresholds, not set, are open and measured in the pilot under R11.10).

**R7.12** *(client†)* On its `k`-th dark epoch, an entry steps off client rankings for `min(2^(k−1), P)` epochs up to `P` = 32 epochs, returning automatically afterward while callers route to the next-ranked candidate (whether dark counters track per entry or per contributor, and when they reset, are open).

**R7.13** *(client†)* Because network unreachability cannot be cryptographically distinguished from caller censorship, going dark never forfeits stake; it costs only lost picks, missed fees, and declining rank as callers fail or migrate (`rank.counted-stake`).

**R7.16** *(client†)* Under diagnostic default tracking (R5.16, R5.17), unanswered tries count as non-passes and eventually hand default status to working challengers.

**R7.17** *(client†)* Availability relies on competing entries, peer seeding, and automatic browser relearning: whenever all network entries for an intent fail or go dark, the caller's node walks the site in its own browser, completes the task, and lists the newly learned entry (R2.15).

**R7.9** *(client†)* Clients resolve domain listings via the hash table (R7.21), resolve body providers via contributor metadata and hash-table provider records (R7.18), query the lowest-latency peers first, step through ranked fallbacks on failure (R3.19), and fall back to browser relearning when none answers (R7.17).

### 7.4 Domain-keyed Kademlia hash table and eclipse defence

**R7.21** *(client†)* Listings are indexed by registrable domain under `/unbrowse/site/<registrable domain>` (using the pinned Public Suffix List), following R7.18's TTL, refresh and rate limits. A searching client fetches signed listings from providers controlled by at least 2 distinct ERC-8004 identities, verifies signatures and Merkle roots (R2.15), merges the union, and computes `rank.score` locally.

**R7.23** *(client†)* Peer routing uses Kademlia (`/unbrowse/kad/1.0.0`) with bucket size and replication factor 20, 3 concurrent queries per lookup across disjoint paths, client-only mode for light or NAT-unreachable nodes, and libp2p circuit relays plus hole punching for home networks.

**R7.24** *(client†)* Returning nodes bootstrap from previously cached peers, falling back to dialling registered multiaddresses read directly from on-chain ERC-8004 metadata (R1.15) with zero reliance on central bootstrap servers.

**R7.25** *(client†)* Each node's Kademlia coordinate is `SHA-256(peer ID)`, constrained so its leading 16 bits equal `H(agentId ‖ registrationBlockHash ‖ i)` for node index `i <` 16. Nodes mine a compliant peer key once at setup; targeting a specific domain's neighbourhood to eclipse its listings therefore requires roughly `2^16` paid on-chain identity registrations.

**R7.26** *(client†)* Routing tables admit a peer and store its provider records only after its handshake proves possession of its peer key, cites an `agentId` whose on-chain metadata lists that peer ID (R1.15), and satisfies R7.25's coordinate prefix (cached for one epoch). Unadmitted peers may still issue rate-limited lookups without entering routing buckets.

**R7.27** *(client†)* Hash-table lookups are untrusted hints: if no verified listing is returned, the client falls back to an optional index node (R3.7) and then to local browser relearning (R7.17).

**R7.28** *(client†)* Contributors delisting or repricing an entry SHOULD broadcast a signed advisory notice on gossipsub topic `/unbrowse/site/<registrable domain>/changes`; subscribed peers treat gossip strictly as a wakeup to re-verify on-chain state or check a signed withdrawal against the listing's wallet key, scoring peers via gossipsub rules.

**R7.29** *(client†)* Every node enforces strict per-peer resource bounds: token buckets cap listing queries (burst 32, then 1 a second, `serving.listings_rate`), body fetches (burst 20, then 1 a second, `serving.body_rate`), and DHT streams (burst 512, then 32 a second, `dht.query_rate`), with unadmitted strangers sharing an aggregate pool (listings and bodies: burst 64, then 4 a second; hash table: burst 1,024, then 64 a second, `serving.strangers_rate`) and excess requests rejected immediately rather than left hanging. Concurrent serving uses fixed worker slots (16, one kept for a newcomer; 4 per peer, `serving.slots`) with a maximum queue wait of 2 seconds (`serving.slot_wait`), prioritising peers that paid for the most bodies in the past hour while reserving a dedicated slot for newcomers.

### 7.5 Contract deployment verification and `unbrowse://` links

**R7.30** On startup, a node MUST verify its configured Settlement deployment directly against Arc bytecode, walking every linked contract address on chain and refusing settlement operations if runtime code (excluding immutables and compiler metadata) differs from the node's own audited build, while continuing local non-settlement operation.

**R7.31** Every contract in the deployment graph MUST cross-reference its sibling contracts reciprocally; matching bytecode behind mismatched cross-references MUST be rejected.

*Note:* Earlier bytecode checks for zero-knowledge leak verifiers (`fraud.proof_system`) and fixed bond timers retired with `fraud.none` and `bond.none`.

**R7.32** Deep links follow `unbrowse://<site>` (all listings for an ASCII domain) and `unbrowse://<site>/<entry>` (one credited entry ID, R2.18); links carrying ports, credentials, query strings or fragments MUST be rejected.

**R7.33** Opening an `unbrowse://` link MUST be strictly read-only: it inspects and displays verified metadata (R2.15) and MUST NEVER trigger an HTTP call, spend USDC or touch stored sessions.


## 8. Bounties as judge-free limit orders

*Informative:* Per-fetch fees reward routes once traffic arrives, whereas bounties fund discovery on sites nobody has mapped yet (`decide.miss-pledges`). Structuring bounties as price-capped limit orders in UNB eliminates subjective grant committees, protects sponsors from launch front-running, and gives independent builders initial route stake with zero upfront capital.

### 8.1 Posting, limit pricing and dual release

**coin.bounty-launch** *(contract)* Any wallet MAY lock UNB in the bounty contract for an unmapped site or intent (`open.coin-bounty-site` tracks exact domain-matching rules). Once a candidate entry is listed and the sponsor's own paid fetch on that entry passes and settles (`coin.bounty-confirm`), confirming the bounty either launches the entry's coin with the bounty as its opening purchase or buys on its existing curve up to the sponsor's limit price (`coin.bounty-limit`). Purchased coins split 50% to the entry's credited contributor (R2.18) and the remainder to the sponsor, both locked in the staking contract and marked verified (`coin.check`). Unreleased bounties return to the sponsor after their deadline.

**coin.bounty-confirm** *(contract)* Bounties unlock without third-party judges through two complementary paths: explicit sponsor confirmation after the sponsor's own counting passed call (R4.33, `coin.bounty-launch`), and automatic proportional release driven by organic site usage (`coin.bounty-by-use`), ensuring sponsors reclaim only what went unused.

**coin.bounty-by-use** *(contract)* Every counting paid line (R4.33) settled on an entry for the bounty's site after the bounty was posted (from any caller wallet prior to the deadline) automatically releases a slice of the bounty to buy and stake that entry's coin, capped at 5% of the USDC paid on that line (`decide.bounty-cap-five`). Matching that ceiling to the irreversible 5% burn share guarantees that even a wash caller controlling both the website and all staked coins cannot extract more value from a stranger's bounty than it permanently burns in fees. Unspent balances return to the sponsor.

**coin.bounty-limit** *(contract)* When posting a bounty, the sponsor specifies the maximum UNB price per coin (inclusive of curve fees and any snipe tax) it will accept. Releases fill only up to that ceiling and leave any unfilled UNB with the sponsor, defeating attackers who pre-launch and pump a curve ahead of a public bounty (omitting a limit executes at market).

**coin.bounty-no-slicing** *(contract)* When releasing into an entry whose coin already trades, the bounty executes a single immediate market buy up to its limit price rather than twap-slicing across epochs.

### 8.2 Parity for founder bounties

**R8.12** Unbrowse's founder posts bounties strictly as an ordinary token holder from its own UNB under these exact contract rules, with zero reserve bounty pool and zero privileged contract path. Any route coins acquired by the founder's wallet as the sponsor half of released bounties are publicly disclosed (R11.13; whether founder bounties may draw from unlocked team tokens is tracked under `open.team-line-bounties`).


## 9. Token supply, genesis allocation and burns

*Informative:* UNB has a permanently fixed supply minted once at genesis with zero post-launch inflation. Callers never need UNB to use routes; instead, UNB serves as the reserve numeraire for route-coin curves, the asset locked in bounties, and the supply permanently reduced by fee burns.

### 9.1 Fixed genesis supply

**R9.1** *(contract)* Total UNB supply is 1,000,000,000 UNB, minted once at genesis on Arc mainnet into an immutable token contract with zero mint capability. Post-genesis issuance is 0 UNB (the mainnet contract address is published separately at opening).

**R9.2** UNB uses 18 decimals on Arc mainnet. Because route prices settle in six-decimal USDC, UNB decimals apply solely to route-coin curves, bounties, pool swaps and burns.

### 9.2 Allocation and cliff locks

**R9.3** *(contract)* Genesis allocated the entire supply once, with zero subsequent allocations:

| Holder | Share of supply | Unlock terms |
|---|---|---|
| Public launch pool | 67% | Open market liquidity (R9.4); share status: proposed |
| Rewards reserve | 10% | Locked in utility contract; hourly listing roots only (R9.14–R9.16) |
| Treasury (first tranche) | 5% | Cliff-locked 3 months from genesis (R9.12) |
| Treasury (second tranche) | 10% | Cliff-locked 6 months from genesis (R9.12) |
| Team (including any investors) | 8% | Cliff-locked 3 months from genesis (R9.12) |
| Airdrop | 0% | None |

**R9.4** The public launch pool entered open-market trading at genesis inside UNB's existing public pool (R9.27), with no Unbrowse treasury sales drawn from it and no discretionary airdrop. Launchpad LP lock duration (not set) and timing/sizing of any supplemental company-seeded LP (not set) remain open.

**R9.4a** The team intends to purchase up to 7% of supply on the open market at launch from publicly disclosed wallets (R11.6); those tokens are classified strictly as insider holdings, never reported as external market demand.

**R9.12** *(contract)* Team and treasury allocations unlock strictly by elapsed time cliffs (`L` months from genesis, releasing zero prior to month `L` and unlocking in full at month `L`): 3 months for team (8%) and first treasury tranche (5%), and 6 months for second treasury tranche (10%). Paid call volume, token price and network usage never accelerate unlocks, and any investor tokens come out of the team line on identical locks.

### 9.3 Rewards reserve constraints

**R9.14** *(contract)* The rewards reserve disburses UNB exclusively to fund the hourly listing roots it posts on chain (R2.20). It MUST NOT fund bounties (`coin.bounty-launch`), match contributor or website fees, stake on routes, subsidise third-party stakes, or distribute liquid airdrops; its remaining scope or eventual burn is open.

**R9.15** *(contract)* Cumulative reserve outflows across all operations can never exceed its 10% genesis allocation (`UnbLaunch.reserve_outflow_le_allocation`).

**R9.16** The reserve carries no expiration schedule, pays zero onboarding grants, and never distributes free UNB during or after the pilot (R11.4).

### 9.4 Public UNB pool and swap fee

**R9.27** *(contract)* Settlement references UNB's live public UNB-USDC liquidity pool on Arc at deployment without seeding a competing pool. Both epoch fee burns (R4.6) and caller coin purchases inside `coin.fetch-buys` route their USDC-to-UNB swaps through this pool.

*Note:* R9.27's earlier references to bond top-ups and payout withholding are superseded (`bond.none`, `coin.fetch-buys`).

**R9.28** UNB's public pool charges a 4% swap fee as part of the pool's own parameters rather than an extra Settlement surcharge; this pool fee constitutes the R9.28a trade tax.

**R9.28a** Every UNB swap in the public pool pays that 4% trade tax once to Unbrowse to fund ongoing company engineering and operations (`pool.own_lp` and `pool.seed_lock` remain open).

### 9.5 Permanent burn sinks

**R9.29** *(contract)* UNB is permanently destroyed from two sources: the 5% burn share of every settled detail fee swapped via `burnBatch` (R4.6) and early-launch route-coin snipe taxes (`coin.snipe-tax`).

*Note:* Earlier burn sources from skills, execute tolls, bounty silence burns and slashed bonds retired under `skills.none`, `execute.none`, `coin.bounty-launch`, `bond.none` and `fraud.none`.

**R9.30** With zero post-genesis minting and strictly non-negative burns, unburned UNB supply can only decrease over time (`Unb.circulating_never_grows`). Fee-funded burns MUST be disclosed transparently as automated buybacks rather than promised price floors.


## 10. Constitutional commitments and voluntary upgrades

*Informative:* To prevent governance capture once developers and websites rely on the map, Unbrowse contracts have zero admin keys, zero upgrade proxies and zero token voting. Core economic promises are immutable in code, and protocol evolution happens exclusively by deploying new contracts that participants choose to adopt on merit.

### 10.1 Non-negotiable invariants

**R10.1** *(client†)* Any contract deployment that violates R10.2, R10.3, R10.4, R10.5, R10.7 or R10.9 ceases to be Unbrowse and constitutes an independent fork under another name; the reference client MUST NOT migrate to it.

*Note:* R10.1 previously included R10.6 (forbidding stake or token prices from entering route selection, superseded by `rank.collateral`) and R10.10 (superseded by `fraud.none`). Adopting that constitutional update awaits co-founder sign-off (`open.steefpls-review`).

**R10.2** *(contract)* Zero UNB is ever minted after genesis (0 UNB).

**R10.3** *(contract)* Protocol contracts hold zero owner roles, zero admin keys and zero pause or upgrade hooks; no party, Unbrowse included, can alter fee shares, escrow rules or user balances after deployment.

**R10.4** *(contract)* A failed call charges the caller nothing and pays nobody, whatever share of its calls fail; there is no free-failure cap (`decide.failed-fetch-always-free`, `UnbLaunch.free_failure_costs_nothing`).

**R10.5** *(contract)* Every passed detail fee reserves 30% in on-chain escrow for the domain owner whose backend API the route calls.

**R10.7** *(contract)* Team and treasury allocations unlock strictly by elapsed time cliffs (3 months and 6 months), never by call volume or market price.

**R10.9** *(contract)* The rewards reserve never matches earnings and pays zero bounties.

### 10.2 Immutable parameters and exit-based governance

**R10.11** *(contract)* The following parameters are compiled as immutable constants of each deployment and can change only in a new deployment adopted voluntarily by users: detail fee shares (`fees.contributor`, `fees.website`, `fees.server`, `fees.platform`, `fees.burn`), deposit withdrawal delay (`time.withdrawal_delay`), website escrow wait (`escrow.wait`), and the `burnBatch` caller margin (`fees.batch_margin`).

*Note:* Earlier immutable constants for entry bonds, withholding, route-pool splits, fraud courts and stake-bounty timers are superseded; whether `route_coin.*` curve parameters are likewise compiled as immutable factory constants is noted in Annex B.

**R10.12** Parameters marked *launch* or *proposed* MAY be calibrated from empirical pilot data prior to mainnet contract deployment, and all *open* parameters MUST be resolved before opening.

**R10.13** Every remaining quantity, including individual route prices and staker exit delays, is chosen freely by market participants or local client settings.

**R10.14** Rules change solely through deploying new immutable contracts that peers migrate to voluntarily; there is no governance council, no dispute board, and UNB carries zero voting power.

**R10.15** Both node software and smart contracts are open source and freely forkable; Unbrowse authors reference code without holding a privileged protocol role.

### 10.3 Voluntary migration to the route-coin deployment

**deploy.new** *(both)* Because the existing Settlement contract on Arc is immutable, route coins ship as a fresh contract deployment that node operators opt into by configuration. Nodes remaining on the earlier deployment continue settling lister payouts and route pools under its rules, while upgraded nodes list, fetch, stake and settle on the route-coin suite.
*Why a peer follows it:* Migrating gives callers routes ranked by live user-verified collateral and lets builders and callers accrue stake and USDC yield on routes they discover and use, without breaking backward safety for un-upgraded peers.


## 11. Staged launch, safety gates and handover

*Informative:* Opening an unproved financial network to the public invites avoidable losses, while keeping a founder in control forever defeats decentralisation. Unbrowse sequences launch across four explicit stages gated by empirical pilot measurements, formal audit and legal review, tracking decentralisation transparently as community listings overtake initial seed routes.

### 11.1 Four launch stages and pilot measurements

**R11.1** Network rollout proceeds sequentially across four phases: (a) genesis token mint (completed), (b) closed pilot, (c) public opening, and (d) operational handover. Each post-token phase begins only after the preceding phase has operated under real workloads.

**R11.3** The closed pilot exercises the complete protocol end to end: deposits, vouchers, batch claims, free failed lines, peer serving and dark-entry backoff, listing roots, route coins, limit-order bounties (`coin.bounty-confirm`), domain escrow, and collateral ranking with browser fallback. It MAY run on Arc mainnet using real USDC and UNB restricted to named pilot operators (`open.pilot-coins` tracks pilot configuration for route coins), following testnet integration runs.

*Note:* R11.3's references to entry bonds and legacy stake-bounties are superseded (`bond.none`, `coin.bounty-launch`).

**R11.4** The pilot is private and unannounced, involving named full-node operators and roughly 1,000 participating agents (predominantly in light mode) over a duration to be set (not set, open), with zero free UNB distributions.

**R11.5** Although UNB minted at genesis prior to the pilot (R9.1), public opening is gated strictly on satisfying all three conditions of R11.8 rather than a calendar date. Once deployed, Settlement enforces no minimum operator count or per-operator market-share cap.

**R11.10** *(client†)* The closed pilot measures and publishes empirical benchmarks for:

- serving cost per route-month;
- detection latency and backoff accuracy for dark entries serving zero bytes (R7.11);
- payment-graph link-analysis recall on self-paying wallets;
- cost and true-positive catch rate of local LLM semantic checks;
- whether contributors learn to fingerprint canary probes;
- false-failure reporting rates across callers; and
- median time for peers to relearn and replace broken routes after site changes.

**R11.11** Empirical pilot findings calibrate the proposed parameters in Annex A, with any updated values and data sources published prior to public mainnet contract deployment (R10.12).

### 11.2 Pre-opening audit and legal gates

**R11.8** Public network opening is blocked until all three gates pass:

- (a) independent smart-contract security audits covering token distribution, cliff locks, settlement and route-coin contracts, with all findings published, resolved and cross-checked against machine-verified specifications (`formal/launch_defs.json`);
- (b) written legal counsel opinion covering team, treasury and reserve token lines alongside the automated buy-and-burn; and
- (c) publication of R11.10's core pilot measurements (at minimum the first four metrics).

Because UNB minted at genesis before gates (a) and (b) completed, that sequencing risk MUST be disclosed prominently in all public papers and documentation until both gates clear.

**R11.9** Legal review under R11.8(b) SHOULD additionally evaluate public pool terms, card on-ramps, market-making agreements, limit-order bounties, the 4% swap fee, disclosed team launch purchases, securities classification of staked route-coin USDC payouts (`open.counsel`), public token communications, pre-audit genesis risk, and automated bot-challenge handling during browser walks.

### 11.3 Public disclosures and founder handover

**R11.6** Prior to public opening, Unbrowse MUST publish verifiable disclosures covering: wallet addresses holding every R9.3 genesis line, team and treasury lock contracts, the utility-contract reserve address, public pool terms and LP lock (not set), swap-fee recipient, team launch purchases and wallet addresses (R9.4a), any market-maker arrangements, routes listed and served by founder nodes, off-path company infrastructure (R11.13), and any treasury UNB acquisitions.

**R11.12** During early network growth, a single operator (including the founder) may account for most listed routes while early callers have brief track records; both concentration facts MUST be disclosed plainly.

**R11.13** Until community listings overtake initial coverage, the founder remains the network's primary operational trust point, which MUST be disclosed across three dimensions:

- holder of staked route coins acquired on standard terms as the sponsor half of early bounties (R8.12, disclosure format tracked under `open.treasury-staker`), with zero privileged bounty path;
- custodian of cliff-locked team (8%) and treasury (5%, 10%) allocations (R9.12) plus up to 7% in disclosed open-market launch buys (R9.4a); and
- operator of off-path release signing and opt-out usage telemetry, neither of which sits on the API execution path or can move balances or alter routes.

**R11.14** Handover progress is tracked publicly by the founder's share of live listed routes (alongside pilot-measured share of paid picks); slower third-party listing slows handover and MUST be reported transparently.

**R11.7** Handover proceeds organically from opening without contract changes: independent contributors' routes compete alongside and replace early founder listings on rank, and bounties require zero administrative handover because every sponsor confirms or releases by verified use (`coin.bounty-confirm`) with no central judge.


## Annex A. Protocol parameters

Complete table of normative parameters generated from `protocol/params.toml` (mirroring `param.*` nodes in `unbrowse-graph`).

| Parameter | Value | Status | Since | Decided in | What it is |
|---|---|---|---|---|---|
| `time.epoch` | 24 hours | launch | 2026-10-19 | spec §26; graph param.time.epoch | one epoch; timing only |
| `time.withdrawal_delay` | 2 epochs | constant | 2026-10-19 | spec Annex B; graph param.time.withdrawal_delay | delay on deposit withdrawals |
| `agent.key_cap` | $5.00 | client | 2026-11-01 | spec §76.1 item 2; graph param.agent.key_cap | cap per epoch on the agent key the app creates for its node as it joins (R1.20): 100 fetches at agent.max_fetch; the owner can raise it |
| `agent.max_fetch` | $0.05 | client | 2026-10-30 | spec §72 item 2; graph param.agent.max_fetch | the owner's maximum for one route fee, skill call or execute price, paid without asking |
| `listing.credit_final` | 14 epochs | open | 2026-11-03 | spec §84; graph param.listing.credit_final | epochs after an entry is first credited during which anyone may move its credit with correctCredit to an earlier root (R2.18); after them the credit is final. Candidate: the claim vesting period (claims.vest), so a correction can still reach every unvested claim. Audit D-3, 2 Nov 2026; the value waits for the owner and the contracts |
| `listing.reserve_root_interval` | 1 hour | launch | 2026-10-26 | spec §38.2; graph param.listing.reserve_root_interval | the rewards reserve posts one listing root this often |
| `routes.binding_window` | 30 epochs | proposed | 2026-10-29 | spec §62; graph param.routes.binding_window | how long a host binding seen by the client's own browser holds before it is re-checked (R2.27) |
| `routes.description_max` | not set | open | 2026-10-19 | spec §25.3; graph param.routes.description_max | description length limit, published with the ranking function |
| `routes.optout_recheck` | 1 epoch | proposed | 2026-10-29 | spec §63; graph param.routes.optout_recheck | most time between a client's reads of a host's robots rules for the Unbrowse token (R4.32) |
| `routes.site_hosts_max` | 64 | proposed | 2026-10-29 | spec §62; graph param.routes.site_hosts_max | most hosts a site's policy may list (R4.17) |
| `sharing.days` | 3 | client | 2026-10-31 | spec §70.1 item 3; graph param.sharing.days | different days a learned route must pass on before the node lists it by default (used mode) |
| `sharing.list_per_day` | 5 | client | 2026-10-31 | spec §70.1 item 3; graph param.sharing.list_per_day | listings a node makes by itself a day in used mode (pacing) |
| `sharing.list_per_day_all` | 20 | client | 2026-10-31 | spec §70.1 item 3; graph param.sharing.list_per_day_all | listings a day in the opt-in all mode (pacing) |
| `sharing.runs` | 5 | client | 2026-10-31 | spec §70.1 item 3; graph param.sharing.runs | or passed runs, whichever comes first (used mode) |
| `fees.batch_margin` | 10% | proposed | 2026-10-29 | spec §79, §63; graph param.fees.batch_margin | margin over the USDC gas a burnBatch caller is repaid, on the contract's fixed BATCH_GAS at the base fee (R4.6); was relay.margin until the relayer was removed (§79) |
| `fees.burn` | 5% | constant | 2026-10-24 | spec §47.2; graph param.fees.burn | detail fee: swapped for UNB and burned; takes the rounding remainder |
| `fees.burn_batch_max_share` | 0.5% | proposed | 2026-10-29 | spec §63; graph param.fees.burn_batch_max_share | most of the pool's USDC reserve one burnBatch swaps (R4.6); the rest waits for the next epoch |
| `fees.contributor` | 65% | constant | 2026-11-10 | spec §47.2; decide.one-part-to-stake; graph param.fees.contributor | detail fee: the route's contributor |
| `fees.platform` | 0% | constant | 2026-11-10 | spec §47.2; decide.one-part-to-stake; graph param.fees.platform | detail fee: platform |
| `fees.server` | 0% | constant | 2026-11-10 | spec §47.2, §51.1 item 2; decide.one-part-to-stake; graph param.fees.server | detail fee: the node that served a passed line (often the contributor); nobody is paid on a failed line |
| `fees.smallest_unit` | $0.000001 | constant | 2026-10-27 | spec §41, §84; graph param.fees.smallest_unit | uSDC's smallest unit; the only price floor |
| `fees.suggested_detail` | not set | open | 2026-11-01 | spec §41, §77; graph param.fees.suggested_detail | the price a node lists an entry at when its owner has set none; the client suggests no price (R3.33); old value 0.01 USDC (§41), which core uses until the owner decides |
| `fees.website` | 30% | constant | 2026-10-27 | spec §47.2; graph param.fees.website | detail fee: the website's escrow |
| `refund.false_fail_gate` | 10% | client | 2026-10-27 | spec §47.1 item 3; graph param.refund.false_fail_gate | τ: estimated false-fail rate above which a server may decline to serve a payer, from what it saw itself; each server's own choice, not a network rule (client) |
| `refund.fail_value` | removed; was 5% | constant | 2026-11-12 | spec decide.failed-fetch-always-free (Lewis, 12 Nov 2026: "on failures, i'd want failed fetches to stay free regardless of the failure rate"); retires decide.fail-value-five; graph param.refund.fail_value | retired: the value limit on free failed lines; the contract has no free-failure cap and charges no failed line, whatever share of a payer's lines fail (contract) |
| `refund.max_fail_rate` | removed; was 25% | constant | 2026-11-12 | spec decide.failed-fetch-always-free (Lewis, 12 Nov 2026: "on failures, i'd want failed fetches to stay free regardless of the failure rate"); retires §70.1 item 2; graph param.refund.max_fail_rate | retired: ρ, the share of paid lines past which failed lines paid in full; the contract has no free-failure cap and charges no failed line (contract) |
| `refund.min_lines` | removed; was 20 | constant | 2026-11-12 | spec decide.failed-fetch-always-free (Lewis, 12 Nov 2026: "on failures, i'd want failed fetches to stay free regardless of the failure rate"); retires §70.1 item 2; graph param.refund.min_lines | retired: N, the floor of the free-failure cap ρ·max(n, N); with no cap there is no floor |
| `refund.window` | removed; was 30 epochs | constant | 2026-11-12 | spec decide.failed-fetch-always-free (Lewis, 12 Nov 2026: "on failures, i'd want failed fetches to stay free regardless of the failure rate"); retires §70.1 item 2; graph param.refund.window | retired: the window over which paid and failed lines were counted for the free-failure cap; the contract keeps no count of failures |
| `escrow.unclaimed` | not set | open | 2026-10-20 | spec Annex B; graph param.escrow.unclaimed | what happens to site escrow that is never claimed |
| `escrow.wait` | 14 epochs | constant | 2026-11-03 | spec §27.8, §76.2 item 11, §81, §83; graph param.escrow.wait | waiting period before a proven domain's escrow is released to its wallet, and how long an HTTP binding's shares are held before they are paid (R4.14, R4.15); fixed when the contracts deploy, as Settlement and Domains already do on the devnet and testnet |
| `route_coin.bounty_lister_share` | 50% | proposed | 2026-11-05 | spec fork §101, fork §101 item 2; graph param.route_coin.bounty_lister_share | share of the coins a launching bounty buys that go to the entry's credited contributor; the rest to the poster (R6.3) |
| `route_coin.bounty_use_cap` | 5% | constant | 2026-11-10 | spec decide.bounty-cap-five; graph param.route_coin.bounty_use_cap | most of a counting paid line's USDC that the line releases from a bounty by use (`coin.bounty-by-use`) |
| `route_coin.curve_share` | 100% | proposed | 2026-11-11 | spec decide.no-graduation (Lewis, 11 Nov 2026); was 0.78 (fork §101 item 3); graph param.route_coin.curve_share | share of supply sold on the curve: all of it, since a coin does not graduate and nothing is held back |
| `route_coin.snipe_start` | 50% | proposed | 2026-11-05 | spec fork §101, fork §101 item 3; graph param.route_coin.snipe_start | snipe tax on a buy at the moment of launch, sent to the burn (R6.6) |
| `route_coin.snipe_window` | 5 minutes | proposed | 2026-11-05 | spec fork §101, fork §101 item 3; graph param.route_coin.snipe_window | after launch, buys pay a snipe tax that falls to zero over this window (R6.6) |
| `route_coin.supply` | 1,000,000,000 | proposed | 2026-11-05 | spec fork §101, fork §101 item 1; graph param.route_coin.supply | coins in each entry's coin, fixed at launch (R6.1) |
| `route_coin.trade_fee` | 1% | proposed | 2026-11-05 | spec fork §101, fork §101 item 3; graph param.route_coin.trade_fee | share of each curve trade's UNB paid to the platform (R6.4) |
| `route_coin.dev_buy_share` | 1% | client | 2026-11-11 | spec decide.dev-buy-default-on (Lewis, 11 Nov 2026; the size he named on 5 and 7 Nov); graph param.route_coin.dev_buy_share | the share of its wallet's UNB a lister's node spends on the first buy when it launches an entry's coin, by default; the owner can change it or turn it off (client) |
| `route_coin.unstake_delay` | 24 hours | proposed | 2026-11-05 | spec fork §101, fork §101 item 4; graph param.route_coin.unstake_delay | unstaking takes this long, earning nothing (R6.7) |
| `route_coin.virtual_unb` | 30,000,000 UNB | proposed | 2026-11-05 | spec fork §101, fork §101 item 3; graph param.route_coin.virtual_unb | virtual UNB reserve of each coin's curve: its depth (R6.4) |
| `rank.identity_window` | 720 hours | proposed | 2026-11-05 | spec fork §101, fork §101 item 6; graph param.rank.identity_window | window over which an identity's record of paid checks is counted (R8.3) |
| `rank.price_window` | 24 hours | proposed | 2026-11-11 | spec Lewis, 10 Nov 2026 (a shorter average; one day is the Quint model's length); was 72 (fork §101 item 6); graph param.rank.price_window | window of the time-weighted price that values stake in security (R8.1) |
| `ranking.evidence_cap` | not set | open | 2026-10-27 | spec A8; graph param.ranking.evidence_cap | cap on an entry's weighted uses in its pass rate (the simulation used 10) |
| `ranking.exploration_share` | 5% | proposed | 2026-10-26 | spec §61, §38.5; graph param.ranking.exploration_share | ε: share of picks given to unverified entries on every intent, only for payers within the free-failure cap (R3.4, §61); the pilot fits it |
| `ranking.link_hops` | 2 | proposed | 2026-10-27 | spec §47.1; graph param.ranking.link_hops | switch evidence counts only from payers not linked to the challenger's contributor within this many hops of the payment graph |
| `ranking.link_recall_min` | 50% | proposed | 2026-10-27 | spec §47.1; graph param.ranking.link_recall_min | if the pilot measures self-payer link recall below this, switch evidence counts only from exploration picks |
| `ranking.prior_a` | 2 | proposed | 2026-10-27 | spec A8; graph param.ranking.prior_a | beta prior a₀ for the weighted pass rate |
| `ranking.prior_b` | 2 | proposed | 2026-10-27 | spec A8; graph param.ranking.prior_b | beta prior b₀ |
| `ranking.switch_confidence` | 95% | proposed | 2026-10-27 | spec §47.1 item 7; graph param.ranking.switch_confidence | confidence of the one-sided sequential test |
| `ranking.switch_margin` | 0.02 | proposed | 2026-10-27 | spec §47.1 item 7; graph param.ranking.switch_margin | δ: pass-rate margin a challenger must show over the default entry |
| `ranking.unverified_uses` | 30 | proposed | 2026-10-29 | spec §61; graph param.ranking.unverified_uses | counted uses (R5.18) below which an entry is tagged unverified and can get exploration picks; the pilot fits it |
| `rating.canary_penalty` | not set | open | 2026-10-27 | spec §47.1; graph param.rating.canary_penalty | how long a payer that misreports a canary has its payer weight cut and MAY be declined by servers applying the gate |
| `rating.canary_share` | 5% | launch | 2026-10-27 | spec §47.1 item 2; graph param.rating.canary_share | share of public-route fetches that are canaries |
| `rating.complaints_per_day` | 1 | launch | 2026-10-27 | spec §47.1 item 8; graph param.rating.complaints_per_day | complaints per verified person per route per day |
| `rating.decay` | not set | open | 2026-10-20 | spec A5, Annex B; graph param.rating.decay | δ: decay of a report's weight per epoch; the pilot fits it |
| `rating.declared_fault` | not set | open | 2026-10-27 | spec §47.1; graph param.rating.declared_fault | how soon after the first failure a declared fault counts, and how much less reputation it loses |
| `rating.escalation_start` | not set | open | 2026-10-27 | spec §47.1 item 6; graph param.rating.escalation_start | starting escalation bond for a re-run |
| `rating.local_demotion` | 2 hours | client | 2026-10-20 | spec §29.1; graph param.rating.local_demotion | a failure that does not count in shared reputation demotes the entry in the payer's own client this long |
| `rating.payer_weight` | not set | open | 2026-10-20 | spec §78, §27.1; graph param.rating.payer_weight | g: a payer's weight on its reports, from its age, spend and spread; the pilot fits it (no ratings since §78; the key keeps its name) |
| `rating.rebuttal_window` | not set | open | 2026-10-27 | spec §47.1 item 4; graph param.rating.rebuttal_window | window for the shape-hash rebuttal (the simulation used 6 hours) |
| `liveness.detection_lag` | 1 epoch | client | 2026-10-28 | spec §51.1 item 3, §51.3; graph param.liveness.detection_lag | epochs before an entry that served nothing is off the ranking; the model assumes the next epoch, the pilot measures it |
| `liveness.penalty_cap` | 32 epochs | launch | 2026-10-28 | spec §51.1 item 3, §38.4, §50.2; graph param.liveness.penalty_cap | longest time an entry that served nothing stays off the ranking (1, 2, 4 … doubling to this) |
| `liveness.reports` | not set | open | 2026-10-28 | spec §51.3; graph param.liveness.reports | who reports that an entry served nothing, and how many payers' reports it takes |
| `dht.alpha` | 3 | client | 2026-10-28 | spec §53.1 item 8; graph param.dht.alpha | queries a lookup keeps in flight |
| `dht.k` | 20 | proposed | 2026-10-28 | spec §53.1 item 8; graph param.dht.k | kademlia bucket size, and the number of closest peers that keep each provider record |
| `dht.listing_sources` | 2 | client | 2026-10-28 | spec §53.1 item 2; graph param.dht.listing_sources | providers of distinct identities a seeker fetches a site's listings from |
| `dht.nodes_per_identity` | 16 | proposed | 2026-10-28 | spec §53.1; graph param.dht.nodes_per_identity | nodes, each with its own peer ID and position, one identity may run |
| `dht.position_bits` | 16 | proposed | 2026-10-28 | spec §53.1 item 5; graph param.dht.position_bits | leading bits of a node's table position that its identity's registration fixes |
| `dht.query_rate` | burst 512, then 32 a second | client | 2026-10-31 | spec §82; graph param.dht.query_rate | hash-table streams one peer may open to a node; one past it is closed unread (R7.29) |
| `serving.body_rate` | burst 20, then 1 a second | client | 2026-10-31 | spec §82; graph param.serving.body_rate | body asks one peer may make of a node (R7.29) |
| `serving.listings_rate` | burst 32, then 1 a second | client | 2026-10-31 | spec §82; graph param.serving.listings_rate | listings asks one peer may make of a node; past it, a refusal at once (R7.29) |
| `serving.max_providers` | 20 | launch | 2026-10-28 | spec §26, §52.1 item 1; graph param.serving.max_providers | providers a hash-table lookup returns, at most |
| `serving.provider_record` | 1 hour | launch | 2026-10-30 | spec §72 item 3; graph param.serving.provider_record | a seeder's signed provider record stays valid this long |
| `serving.provider_refresh` | 20 minutes | client | 2026-10-30 | spec §72 item 3; graph param.serving.provider_refresh | how often a seeder re-announces its provider records |
| `serving.slot_wait` | 2 seconds | client | 2026-10-31 | spec §82; graph param.serving.slot_wait | how long an ask waits for a slot before it is refused (R7.29) |
| `serving.slots` | 16, one kept for a newcomer; 4 per peer | client | 2026-10-31 | spec §82; graph param.serving.slots | listings answers, and body answers, a node makes at once; a free one goes to the peer that paid it for the most bodies within the hour, the newcomer's to a peer that hasn't paid (R7.29) |
| `serving.strangers_rate` | listings and bodies: burst 64, then 4 a second; hash table: burst 1,024, then 64 a second | client | 2026-10-31 | spec §82; graph param.serving.strangers_rate | what every peer that failed admission shares, per protocol, on top of its own budget (R7.29) |
| `privacy.relay` | not set | open | 2026-10-28 | spec §51.3; graph param.privacy.relay | how a payer fetches a body without the server seeing what it fetches (relays or index nodes standing in between) |
| `capacity.base` | $2.00 | proposed | 2026-10-24 | spec §33.2; graph param.capacity.base | fees a day any listing wallet may earn |
| `capacity.clean_share` | 0.2 | proposed | 2026-10-24 | spec §33.2; graph param.capacity.clean_share | γ: added capacity per dollar of clean fees |
| `fraud.detector` | not set | open | 2026-10-31 | spec §73.7 item 3; graph param.fraud.detector | the pinned credential detector version: open patterns for known key formats plus a randomness threshold, each with a measured false-positive rate; a new version applies to listings after it (R6.15(b), R6.36) |
| `supply.decimals` | 18 | constant | 2026-10-31 | spec §70.1 item 1; graph param.supply.decimals | uNB decimals (the live token on Arc mainnet) |
| `supply.minted_after_launch` | 0 UNB | constant | 2026-10-14 | spec §7; graph param.supply.minted_after_launch | uNB minted after launch |
| `supply.total` | 1,000,000,000 UNB | constant | 2026-10-14 | spec §70.1 item 1, §7, §12; graph param.supply.total | fixed supply, minted once at genesis (done, Arc mainnet, §70.1 item 1) |
| `allocation.airdrop` | 0% | launch | 2026-10-29 | spec §68.2 item 4; graph param.allocation.airdrop | no airdrop: a discretionary one was rejected because without a standard rule it would read as the team airdropping to itself |
| `allocation.public_pool` | 67% | proposed | 2026-10-29 | spec §68.2 item 5; graph param.allocation.public_pool | public launch pool / open market: the rest of supply; in UNB's existing public UNB–USDC pool (pool.seeding) |
| `allocation.reserve` | 10% | launch | 2026-10-29 | spec §73, §89, §80, §68.2 item 1; graph param.allocation.reserve | rewards reserve: locked in the utility contract; posts listing roots (R2.20); it never stakes or funds another wallet's stake (R9.14, §73, §89). Since §80 (owner, 2 Nov 2026) it pays no bounty: bounties are stakes any holder posts. Indexer seeding from it is OPEN (owner said bounties replace upfront sponsorship); its remaining job, or its removal, is OPEN (owner) |
| `allocation.team` | 8% | launch | 2026-10-29 | spec §68.2 item 3; graph param.allocation.team | team (any investors inside it): locked 3 months from genesis, then unlocked in full |
| `allocation.team_launch_buy_max` | 7% | launch | 2026-10-29 | spec §68.2 item 7; graph param.allocation.team_launch_buy_max | most of supply the team intends to buy on the open market at launch; not an allocation; team-held, wallets disclosed, never counted as outside demand |
| `allocation.treasury_1` | 5% | launch | 2026-10-29 | spec §68.2 item 2; graph param.allocation.treasury_1 | treasury, tranche 1: locked 3 months from genesis, then unlocked in full |
| `allocation.treasury_2` | 10% | launch | 2026-10-29 | spec §68.2 item 2; graph param.allocation.treasury_2 | treasury, tranche 2: locked 6 months from genesis, then unlocked in full |
| `vesting.lock_long` | 6 months | launch | 2026-10-29 | spec §68.2 item 2; graph param.vesting.lock_long | lock on treasury tranche 2 |
| `vesting.lock_short` | 3 months | launch | 2026-10-29 | spec §68.2; graph param.vesting.lock_short | lock on the team line and treasury tranche 1: nothing moves before this month, all of it may after |
| `pool.fee` | 4% | launch | 2026-10-24 | spec §72.2, §97, §33; graph param.pool.fee | the public UNB–USDC pool's own fee per trade, not set by the protocol; it is the trade tax (trade_tax), so a swap pays it once (R9.28, §72.2, §97) |
| `pool.own_lp` | not set | open | 2026-10-29 | spec §68.2 item 5, §68.4; graph param.pool.own_lp | unbrowse adds its own liquidity pool after launch; when, and how large |
| `pool.seed_lock` | not set | open | 2026-10-28 | spec §49.1, §65.5, §68.4; graph param.pool.seed_lock | how long the public launch pool's LP position stays locked; the launchpad's term, not yet written down |
| `pool.seeding` | existing public pool | launch | 2026-10-31 | spec §68.2 item 5, §70.1; graph param.pool.seeding | where the public launch pool (allocation.public_pool) trades: UNB's existing public UNB–USDC pool on Arc, named in Settlement by setPool; a deploy seeds none of its own |
| `pool.trade_tax` | 4% | launch | 2026-11-05 | spec §97, §68.2 item 6; graph param.pool.trade_tax | trade tax on every UNB trade; goes to Unbrowse (trade_tax_to); it is the pool's own fee (pool.fee above), not a charge on top (§97) |
| `pool.trade_tax_to` | Unbrowse | launch | 2026-10-29 | spec §68.2 item 6; graph param.pool.trade_tax_to | where the trade tax goes: to Unbrowse, to fund the company (owner, 29 Oct 2026 21:33 SGT) |
| `launch.pilot_agents` | 1,000 | proposed | 2026-10-19 | spec Annex E; graph param.launch.pilot_agents | agents in the closed pilot, most in light mode (about) |
| `launch.pilot_length` | not set | open | 2026-10-26 | spec Annex E; graph param.launch.pilot_length | length of the closed pilot (whitepaper Annex E sketches eight weeks and lists the length as open) |

## Annex B. Open questions and pending cleanups

*Informative.* Items below track unset parameters, open design choices and cross-repo alignment tasks; none states an active rule.

### B.1 Unset (`open`) parameters

| Parameter | What it is | Decided in |
|---|---|---|
| `listing.credit_final` | epochs after an entry is first credited during which anyone may move its credit with correctCredit to an earlier root (R2.18); after them the credit is final. Candidate: the claim vesting period (claims.vest), so a correction can still reach every unvested claim. Audit D-3, 2 Nov 2026; the value waits for the owner and the contracts (candidate: 14 epochs) | spec §84; graph param.listing.credit_final |
| `routes.description_max` | description length limit, published with the ranking function | spec §25.3; graph param.routes.description_max |
| `fees.suggested_detail` | the price a node lists an entry at when its owner has set none; the client suggests no price (R3.33); old value 0.01 USDC (§41), which core uses until the owner decides | spec §41, §77; graph param.fees.suggested_detail |
| `escrow.unclaimed` | what happens to site escrow that is never claimed | spec Annex B; graph param.escrow.unclaimed |
| `ranking.evidence_cap` | cap on an entry's weighted uses in its pass rate (the simulation used 10) | spec A8; graph param.ranking.evidence_cap |
| `rating.canary_penalty` | how long a payer that misreports a canary has its payer weight cut and MAY be declined by servers applying the gate | spec §47.1; graph param.rating.canary_penalty |
| `rating.decay` | δ: decay of a report's weight per epoch; the pilot fits it | spec A5, Annex B; graph param.rating.decay |
| `rating.declared_fault` | how soon after the first failure a declared fault counts, and how much less reputation it loses | spec §47.1; graph param.rating.declared_fault |
| `rating.escalation_start` | starting escalation bond for a re-run | spec §47.1 item 6; graph param.rating.escalation_start |
| `rating.payer_weight` | g: a payer's weight on its reports, from its age, spend and spread; the pilot fits it (no ratings since §78; the key keeps its name) | spec §78, §27.1; graph param.rating.payer_weight |
| `rating.rebuttal_window` | window for the shape-hash rebuttal (the simulation used 6 hours) | spec §47.1 item 4; graph param.rating.rebuttal_window |
| `liveness.reports` | who reports that an entry served nothing, and how many payers' reports it takes | spec §51.3; graph param.liveness.reports |
| `privacy.relay` | how a payer fetches a body without the server seeing what it fetches (relays or index nodes standing in between) | spec §51.3; graph param.privacy.relay |
| `fraud.detector` | the pinned credential detector version: open patterns for known key formats plus a randomness threshold, each with a measured false-positive rate; a new version applies to listings after it (R6.15(b), R6.36) | spec §73.7 item 3; graph param.fraud.detector |
| `pool.own_lp` | unbrowse adds its own liquidity pool after launch; when, and how large | spec §68.2 item 5, §68.4; graph param.pool.own_lp |
| `pool.seed_lock` | how long the public launch pool's LP position stays locked; the launchpad's term, not yet written down | spec §49.1, §65.5, §68.4; graph param.pool.seed_lock |
| `launch.pilot_length` | length of the closed pilot (whitepaper Annex E sketches eight weeks and lists the length as open) | spec Annex E; graph param.launch.pilot_length |

### B.2 Open design questions in `unbrowse-graph`

Each entry corresponds to an `open.*` graph node and names its decision owner.

| Node | Owner | Open question |
|---|---|---|
| `open.coin-bounty-site` | Lewis | How strictly does a posted bounty match a target site (for example `www.` vs apex domain, and timing relative to first fetch)? |
| `open.coin-fraud` | Lewis | Should cryptographic proof of equivocation or a leaked secret delist an entry without slashing stake, or stay purely off chain (`fraud.none`)? |
| `open.coin-miss-bounty` | Lewis | Should a node offer or post a bounty automatically when its agent misses on an unmapped site? |
| `open.coin-switch-test` | Lewis | What diagnostic or UI role do R5.16–R5.19 retain now that `rank.pick` drives traffic selection? |
| `open.coin-unb-capture` | Lewis | Should an additional fraction of route fees accrue to UNB beyond the 5% burn? (Token parameter.) |
| `open.coin-wash-calls` | Lewis | Should self-paid calls by an existing coin holder on its own entry be excluded from paying stakers? |
| `open.coins-evidence` | Lewis | Earlier whole-web Monte Carlo runs predating the 10 November 2026 rules showed slightly lower tail coverage under route coins; what simulation or pilot benchmark settles whole-web comparison? |
| `open.concentration-fork` | Lewis | Retain linear `Q` (`rank.score`), or revisit a concave per-identity term? |
| `open.core-expiry` | Core | Remove legacy coin-expiry functions (`GRADUATION_DEADLINE`, `expire`, `redeem`) from core contracts per `coin.no-expiry`. |
| `open.core-handrolled-erc20` | Core | Replace core's custom `RouteCoin.sol` with OpenZeppelin ERC-20 clones per `build.oz-erc20`. |
| `open.core-lean-imports` | Core | Decouple `CoinSettlement` from retired `Bond` and `RouteStakes` imports per `bond.none`. |
| `open.core-vendored-v4` | Core | Restrict vendored Uniswap v4 contracts strictly to local tests and read Arc's live `PoolManager` from environment per `arc.v4-poolmanager`. |
| `open.counsel` | Counsel | How are USDC fee claims earned by staking traded route coins classified under applicable securities laws (R11.9)? |
| `open.curve-depth` | Lewis | Keep virtual curve depth at 30,000,000 UNB, or use a shallower reserve so early discovery moves price faster? |
| `open.exit-delay-scale` | Lewis | What exact curve maps a holder's chosen unstaking delay to its collateral weight in `Q` (`rank.exit-delay`; Quint models `d / (d + median)`)? |
| `open.exposure-gate` | Lewis | Keep route metadata and pricing visible to all peers rather than gating visibility behind coin ownership (Quint `expose` found gating adds no revenue)? |
| `open.latest-call-rule` | Lewis | Retain the `rank.counted-stake` rule disqualifying a caller's stake on a failed paid call, given that cached calls happen off chain? |
| `open.leftovers` | Lewis | Clean up residual references to bonds, skills and pools across adopted rules and contract interfaces. |
| `open.licences` | Core | Verify per-file SPDX licence headers across all adapted Clank contract sources before mainnet deployment. |
| `open.pilot-coins` | Lewis | How is the closed pilot (R11.3) structured and parameterised for route coins? |
| `open.rank-window` | Lewis | Keep the market-cap and TWAP averaging window at 24 hours, shorten it further, or read spot on `M`? |
| `open.signed-in-route` | Lewis | What client or reputation mechanism catches degraded signed-in routes that third parties cannot replay without an account? |
| `open.steefpls-review` | Co-founder | Constitutional sign-off on replacing R10.6's stake-free selection rule with collateral-backed `rank.pick` and adopting the updated fee split. |
| `open.team-line-bounties` | Lewis | May Unbrowse post standard bounties from unlocked team tokens? |
| `open.treasury-staker` | Lewis | How should Unbrowse disclose staked route-coin positions earned as the sponsor half of early bounties (R11.13)? |
| `open.use-to-own` | Lewis | Should a node optionally buy and stake additional coins after a route proves useful to its agent, or act strictly on manual owner instruction? |

### B.3 Proposed candidates not yet adopted as rules

- `reputation.scoped-endorsement`: Experimental candidate in which stake vouches for a specific route version during an ownership era after personal use (`decide.scoped-endorsement-trial`).
- `rank.identity_window` (720 hours, proposed): Legacy window parameter for per-identity spending records, unused once `rank.score` dropped identity weights.

### B.4 Live parameters whose referencing rules were superseded

The following parameters remain in `params.toml` pending graph cleanup after their governing fraud-court rules retired (`fraud.none`): `rating.canary_share` (5%), `rating.declared_fault` (not set), `rating.escalation_start` (not set), and `rating.rebuttal_window` (not set).

### B.5 Implementation details not yet specified in the graph

- Encoding of site-level `coin.bounty-by-use` matching inside `Line.bounty` (R3.14).
- Declaration of state-changing read-back routes and delays following `skills.none` (R5.6).
- Ongoing canary funding and scope after `fraud.none` (R1.10).
- Exact challenger reward fraction in overturned HTTP domain bindings (R4.15).
- Inclusion of `route_coin.*` parameters in R10.11's immutable constant list.

## Annex C. Machine-verified Lean declarations

| Parameter | Lean |
|---|---|
| `listing.credit_final` | `Unb.credit_final_after_window` |
| `fees.contributor` | `Unb.split_conserves` |
| `fees.server` | `UnbLaunch.free_failure_costs_nothing` |
| `fees.smallest_unit` | `Unb.bounty_dust_line_never_counts` |
| `ranking.prior_a` | `UnbLaunch.shrunkRate_mono` |
| `ranking.switch_margin` | `UnbLaunch.passes_never_lose_switch` |
| `liveness.detection_lag` | `UnbLaunch.downEpochs`, `UnbLaunch.down_month` |
| `liveness.penalty_cap` | `UnbLaunch.penalty`, `UnbLaunch.penalty_le`, `UnbLaunch.downEpochs`, `UnbLaunch.down_month` |
| `allocation.public_pool` | `UnbLaunch.allocation_sums` |
| `allocation.reserve` | `UnbLaunch.allocation_sums`, `UnbLaunch.reserve_outflow_le_allocation` |
| `allocation.team` | `UnbLaunch.team_release_bounds`, `UnbLaunch.launch_schedule_values` |
| `allocation.treasury_1` | `UnbLaunch.treasury1_release_bounds` |
| `allocation.treasury_2` | `UnbLaunch.treasury2_release_bounds` |
| `vesting.lock_long` | `UnbLaunch.treasury2_release_bounds`, `UnbLaunch.locked_releases_nothing` |
| `vesting.lock_short` | `UnbLaunch.team_release_bounds`, `UnbLaunch.treasury1_release_bounds`, `UnbLaunch.locked_releases_nothing` |

## Annex D. Decision provenance for chosen rules

*Informative.* Chosen route-coin, ranking and simplification rules trace to the following decision nodes in `unbrowse-graph`: `decide.route-coins`, `decide.route-coins-only`, `decide.route-coins-direction`, `decide.build-on-arc-native`, `decide.fetch-buys`, `decide.users-stake-no-weight`, `decide.one-part-to-stake`, `decide.split-by-stake`, `decide.rank-cap-no-clock`, `decide.rank-collateral`, `decide.capital-copy-accepted`, `decide.quint-round-2`, `decide.quint-round-3`, `decide.quint-fixes-10nov`, `decide.bounty-cap-five`, `decide.bounty-confirm`, `decide.miss-pledges`, `decide.coins-keep-91`, `decide.coins-never-expire`, `decide.early-cheaper`, `decide.stake-earns`, `decide.no-bond`, `decide.no-fraud`, `decide.no-execute`, `decide.execute-to-site`, `decide.no-repairs`, `decide.no-server-bond`, `decide.no-credential-leak`, `decide.seeding-natural`, `decide.delist-not-a-power`.

## Annex E. Adopted nodes awaiting graph metadata fields

*Informative.* Adopted client/both rules whose graph node does not yet populate `why_follow` (marked *(client†)* in text): R1.4, R1.6, R1.13, R1.15, R1.18, R1.19, R1.20, R1.22, R1.23, R1.24, R1.25, R1.29, R1.30, R1.31, R1.33, R1.35, R1.36, R1.37, R2.2, R2.5, R2.7, R2.8, R2.9, R2.10, R2.11, R2.12, R2.13, R2.14a, R2.15, R2.16, R2.19, R2.20, R2.21, R2.22, R2.24, R2.25, R2.26, R2.27, R2.28, R2.29, R3.1, R3.2, R3.3, R3.4, R3.6, R3.7, R3.9, R3.10, R3.11, R3.12, R3.17, R3.18, R3.19, R3.21, R3.22, R3.28, R3.31, R3.32, R3.33, R3.34, R3.36, R3.37, R4.15, R4.17, R4.19, R4.21, R4.26, R4.27, R4.32, R5.2, R5.3, R5.4, R5.5, R5.6, R5.7, R5.16, R5.17, R5.18, R5.19, R5.20, R5.22, R6.12, R7.1, R7.3, R7.4, R7.5, R7.9, R7.11, R7.12, R7.13, R7.16, R7.17, R7.18, R7.19, R7.20, R7.21, R7.22, R7.23, R7.24, R7.25, R7.26, R7.27, R7.28, R7.29, R10.1, R11.10.

Adopted rules whose graph node does not populate `where` (definitions and launch/governance commitments): R0.1, R0.2, R0.3, R0.4, R0.5, R0.6, R0.7, R1.1, R1.2, R1.3, R1.8, R1.9, R1.11, R1.12, R1.14, R1.34, R2.1, R2.3, R2.4, R2.6, R2.23, R3.16, R3.30, R4.7, R4.8, R4.16, R4.31, R6.13, R7.6, R7.15, R7.30, R7.31, R7.32, R7.33, R7.34, R8.12, R9.2, R9.4, R9.4a, R9.16, R9.28, R9.28a, R9.30, R10.12, R10.13, R10.14, R10.15, R11.1, R11.3, R11.4, R11.5, R11.6, R11.7, R11.8, R11.9, R11.11, R11.12, R11.13, R11.14.
