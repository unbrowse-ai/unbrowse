# Reference implementation — every claim of the trilogy, as runnable code

This is the runnable core of *Internal APIs Were Not All You Needed* and *Unbrowse
Maintenance Network*. Every `[reference]` (`\refimpl{}`) claim in the papers maps to
a module here, and every module is exercised by a test that proves one whitepaper
sentence. `MANIFEST.tsv` is the claim↔code↔test ledger; `scripts/papers-done-gate.sh`
fails if any claim lacks a passing test, any impl is missing, or any paper still
carries a design-only claim.

Run all:  `python3 tests/run_all.py`  (45 tests, 11 modules; needs `cryptography`
for real ed25519 / AES-GCM, degrades to an honest `__UNSIGNED__` marker if absent —
never a faked signature).

## Modules

- `ed.py` — shared ed25519 (RFC 8032) wallet + HKDF seal-key. One key type, every layer.
- `layers/descent.py` — **signed descent**: one wallet root signs every layer
  (screen→browser→CLI→OS→kernel→packet), hash-chained; tamper or reorder breaks it.
- `layers/gate.py` — **signed-action gate**: no unsigned/foreign/tampered action crosses.
- `zk/binding.py` — **ZK credential binding**: a Schnorr NIZK (Fiat–Shamir, 2048-bit
  MODP) proving a credential is bound to the wallet without revealing it.
- `ledger/cache.py` / `ledger/sealed_cache.py` — content-addressed cache; the sealed
  variant stores AES-256-GCM ciphertext, revealable only by the binding wallet.
- `ledger/ledger.py` / `ledger/checkpoint.py` — hash-chained signed ledger; Merkle-root
  checkpoints (RFC 6962) with per-entry inclusion proofs.
- `network/proof_of_indexing.py` — content-addressed freshness attestation, re-derivable.
- `network/bonding.py` — bond / challenge / slash with conservative stake arithmetic.
- `network/sybil.py` — stake-weighted, split-invariant attribution (the Sybil mitigation).
- `network/erc8004.py` — ERC-8004 Identity / Reputation / Validation records, wallet-signed.
- `network/vault_cycle.py` — the fee-return cycle: staking by abiding, pro rata to balance×duration.
- `walk/route_graph.py` — **the index of the internet, walked all the way up**
  (arXiv:2604.00694, sp-unbrowse tree+walk+verb+settle atoms): the shared route
  graph as an index of pointers merged at the domain level, the paper's composite
  score (0.40 embedding + 0.30 reliability + 0.15 freshness + 0.15 verification),
  the freshness law `1/(1+d/30)`, the continuous-trust settle, and the verb ladder
  `cache → graph → browser` that escalates only on a miss. The **seal** is
  conditional — the public internet is the default: a public route carries no auth
  and `seal()` attaches nothing; only a genuinely `permissioned` route (opted in AND
  naming a non-public auth descriptor) seals, and then only with a real credential
  (else it fails honestly). Auth is removed unless permissioned.

## The cache + ledger core (original two halves, kept separate on purpose)

- `ledger/cache.py` — **content-addressed cache** (the value half). Fetch by
  `sha256(content)`; order-independent; the same content resolves to the same key
  on any host. The ledger references these hashes, never the payload.
- `ledger/ledger.py` — **append-only, hash-chained, ed25519-signed ledger** (the
  commitment half). Each entry `{seq, signer, value_hash, ts, prev, sig}` chains to
  the prior; a Merkle root over all entries is the single commitment an on-chain
  checkpoint would publish. Value off-chain, root on-chain.
- `tests/test_ledger.py` — each test proves one whitepaper sentence:
  content-addressing, value-off-chain/root-on-chain, tamper-evidence, real
  ed25519 signatures, deterministic Merkle root + inclusion.

Run:  `python3 tests/test_ledger.py`   (needs `cryptography` for real signing;
degrades to an honest `__UNSIGNED__` marker if absent — never a faked signature).

Maturity ladder (one shape, swap the host): local JSONL ledger → signed-root
server → on-chain Merkle-root checkpoints. The signatures and hash-chain never
change. Maps to the `sp-ledger` superpattern domain.
