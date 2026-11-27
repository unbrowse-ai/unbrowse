# Decentralised from launch

Unbrowse is built so no company sits in the middle of your agent calls. Nodes discover each other directly over a peer network, settle payments through ownerless contracts on Arc, and run open-source, forkable software.

## Peer discovery with no central server

Nodes form a **Kademlia distributed hash table (DHT) keyed by site** (`/unbrowse/site/<registrable domain>`):
- Nodes announce the sites they hold listings for and refresh records every 20 minutes (expiring after 1 hour if a node disappears, or immediately on a clean shutdown goodbye).
- A node reconnects using peers saved from its previous run, falling back to identities registered on chain — no central bootstrap list required (spec R7.24).
- When looking up routes for a site, a node fetches signed listings from at least two independent identities (spec R7.21).

## Admission by identity, not IP

Open DHTs are vulnerable to Sybil floods where an attacker spins up thousands of nodes near a target key. Unbrowse prevents this using **ERC-8004 on-chain identities**:
- A peer enters a node's routing table only if its Noise handshake proves ownership of its peer ID, the on-chain registry lists that peer ID under its claimed identity, and its DHT position matches leading bits fixed by its registration block (spec R7.25–R7.26).
- Unadmitted peers may still send rate-limited queries, but never enter routing tables and cannot store provider records.

## Where each rule lives

- **On chain (Arc):** Rules that move money or hold stake — USDC deposits, agent spending caps, the 65 / 30 / 5 fee split, route staking, bounties, and DNSSEC domain escrow. Contracts have **no owner and no admin key** (spec R10.3).
- **In the client (your node):** Route learning, recipe verification, credential scanning, and ranking (`S = √(Q · M)`). A modified client only affects its own owner's picks.

## Evolving a network nobody controls

- **Versioned protocols & minimum version:** Wire protocols carry explicit version tags. Nodes below `MIN_VERSION` stay off the peer network until updated.
- **Signature-verified updates:** Release builds verify updates against Unbrowse's signing key before restarting — trusting a cryptographic signature rather than a server.
- **Opt-in contract upgrades:** There is no governance token or admin upgrade proxy. Protocol changes ship as a new contract deployment that users choose to move to (spec R10.14).

## If the chain halts or is compromised

- **Existing routes keep working:** Calls to routes your node already holds go straight to the website and never touch the blockchain.
- **New paid fetches pause:** Discovering new listings' on-chain status and settling new fees require the chain; the contracts can be redeployed to another chain if needed.

## In the code today

**Built:**
- Kademlia DHT, identity admission, fixed table positions, NAT traversal (AutoNAT, Circuit Relay v2, DCUtR), and clean departure (`unbrowse-node/crates/net`, `app/src/peers.rs`, `erc8004.rs`).
- Signed self-updates and minimum-version gating (`app/src/update.rs`, `unbrowse-node/MIN_VERSION`).
- Ownerless settlement and route-staking client integration, DNSSEC domain proofs, and Arc network definitions (`app/src/arc.rs`, `app/networks/*.json`, `app/contracts/`).

**Differences & not live yet:**
- Per-peer rate limits cover body fetches and listing slots; Kademlia `GET_PROVIDERS` queries are not individually rate-limited yet.
- Source builds default to a local Anvil devnet; live Arc mainnet and testnet deployments are pending audit, legal review, and the closed pilot (`"deployment": null`).

Related: [Identity and the vault](identity-and-vault.md) · [NETWORK.md](../NETWORK.md).
