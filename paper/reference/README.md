# Reference implementation — the cache + ledger from the whitepaper

This is the runnable core of *Internal APIs Were Not All You Needed*: the two
halves that a signed entry needs, kept separate on purpose.

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
