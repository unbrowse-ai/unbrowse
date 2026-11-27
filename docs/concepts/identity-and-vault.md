# Identity and the vault

## Identity: your node is its own wallet

Unbrowse has no accounts, no sign-up wall, and no central user database. On first launch, your node generates a 32-byte **root key** from 12 standard BIP-39 seed words (`m/44'/60'/0'/0/0`, compatible with MetaMask, Rabby, and any EVM wallet).

- **One root key derives everything:** Your Arc wallet address, per-agent spending keys, the vault encryption key, and derived site passwords are all deterministically derived from the root key (`unbrowse-node/crates/core`).
- **Stored in your OS keystore:** The root key lives in macOS Keychain, Windows Credential Manager, or Linux Secret Service (falling back to `~/.unbrowse/root.key` with mode `0600` on headless servers without a working keyring).
- **On-chain identity (ERC-8004):** When joining the peer network, the node registers an ERC-8004 identity on Arc for a few cents of USDC once, publishing its peer ID and reachable addresses so other peers can verify it.
- **Optional linked wallet:** You never need to sign in to run or join the network. Optionally linking an email-backed or external wallet (`unbrowse sign-in`) lets you direct withdrawals to that address or share one USDC deposit across multiple nodes.

### Capped agent keys

Agents never touch your root key. Each agent gets its own delegated **agent key** with:
- A **daily spending cap** ($5 USDC per epoch by default)
- An **expiry** (30 days by default)
- **One-click revocation** in the app or CLI

Every request between an agent and the local node is HMAC-signed with the agent's token so the token never crosses the wire, and Settlement refuses any voucher line past a key's cap, expiry, or revocation (spec R1.20–R1.22).

## The vault: secrets stay on your machine

Many useful websites require you to be signed in. Unbrowse's local vault lets agents work with signed-in sites **without ever seeing your passwords, 2FA codes, cookies, or cards**:

- **Logins & TOTP codes:** Agents only see symbolic handles like `vault:example.com:me` and `vault:code:example.com:me`. The node fills the real secret directly into fields on that exact site; responses and route recipes keep only the reference.
- **Per-host cookie jars:** Sessions live in `~/.unbrowse/jars/<host>.json`. You bring a session in one site at a time — either by signing in live through the app's **Browser** screen (`ask_owner`) or by importing cookies for a single named domain (`unbrowse session import <host>`). The node never sweeps your entire browser profile.
- **Website passkeys:** When *you* sign in to a site by hand and the site offers a passkey, the node can seal it in the local vault so agents aren't blocked by passkey prompts later (on by default; opt out globally with `unbrowse-node passkey off` or per site with `passkey never <site>`). Agent-filled logins never arm passkey enrollment.
- **Payment cards:** Stored locally by label; every checkout or card-paying route requires your explicit approval in the desktop window, and agents are locked out of the checkout domain until you finish or dismiss it.

## In the code today

**Built:**
- Root key derivation, OS keystore integration, 12-word seed generation, and encrypted Web3 keystore backups (`unbrowse-node/crates/core/src/derive.rs`, `keystore.rs`, `seed.rs`, `backup.rs`).
- ERC-8004 identity registration and metadata publishing (`app/src/erc8004.rs`).
- Capped agent keys (`app/src/agents.rs`), multi-node shared deposits (`app/src/owner_nodes.rs`), and optional wallet linking (`app/src/link.rs`).
- Local vault, CSV/JSON password import, single-domain session import, passkeys, and card checkout guards (`app/src/vault.rs`, `import.rs`, `passkey.rs`).

**Differs from the design / not built yet:**
- Settlement currently keys balances, route stakes, and listings by the node's own wallet address rather than by ERC-8004 `agentId`.
- Each node registers its own identity at index `0` (`peers::INDEX`) rather than sharing one identity across up to 16 nodes (admission already permits 16 per identity).
- Optional proof of personhood (spec R1.33–R1.34) and per-site scoped agent permissions (spec R1.24) are not implemented yet.

Related: [Decentralised from launch](decentralised.md) · [SECURITY.md](../../SECURITY.md).
