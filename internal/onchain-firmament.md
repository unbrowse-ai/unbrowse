# On-chain firmament — the separations for website-as-wrapper (Step 2 shape, not contents)

> Genesis 1:6-7 — divide the waters. Matt 9:17 — new wine, new skin, both preserved.
> Architecture (a) assumed (pointers on-chain, moat closed); (b)-divergence flagged where it occurs.

## The five firmaments (boundaries fixed before any stone is laid)

1. **The chain/off-chain line — the load-bearing boundary.**
   - **ON-CHAIN (public, Solana, server-free reads):** contract ledger (IDs · signatures ·
     lineage · terminal verdicts) — `iq-ledger.ts` already; settlement (Flex) — `flex-*.ts`;
     identity root (signed-descent wallet); the **public route-registry** (which routes exist +
     content-address + price); **sealed payloads** (encrypted via `payload_crypto`, on-chain but
     unreadable without the key).
   - **OFF-CHAIN + CLOSED (the moat compute):** capture engine, RE resolve, route-VALUE
     decryption, the resolver. One minimal trusted endpoint. **(b) would force this on-chain →
     forbidden under "nothing open-sourced" unless the rule changes.**

2. **The value/pointer line (the moat-no-leak invariant).** On-chain rows carry **pointers +
   encrypted payloads ONLY**; plaintext route VALUES never touch the chain. This is what keeps
   (a) doctrine-consistent — the chain is public, so only sealed/pointer data may live there.

3. **The read/write line.** **READS → chain** (RPC, pointer-keyed-cacheable, server-free):
   registry, a contract's status, settlement, identity. **WRITES → substrate** (declare via aiko,
   capture/RE via the closed endpoint, pay via pay.sh). The website only ever READS chain + issues
   WRITES through the substrate; it owns no business logic.

4. **The website skin (new wine, new bottle).** A new `frontend/src/lib/chain/` reader
   (`reader.ts` RPC client · `registry.ts` public-route reads · `ledger.ts` contract-status reads)
   replaces the **21 backend `/v1` calls** incrementally — one surface at a time, old backend
   preserved until each surface is proven chain-served (Matt 9:17, both preserved).

5. **The irreducible-server line (honest, not zero).** What CANNOT be deleted: the closed
   moat-compute endpoint (capture/RE) + x402/pay.sh settlement facilitation. What CAN be deleted
   once the chain serves it: the public-state read-API + dashboard backend. Target = **near-
   serverless static site + chain reads + one closed endpoint**, never "zero infra".

## Module shape (directories/interfaces — not contents)

```
frontend/src/lib/chain/        ← NEW skin: pure on-chain readers (RPC), zero backend
  reader.ts    (Connection + getAccountInfo + the pointer-cache)
  registry.ts  (public route-registry reads)
  ledger.ts    (contract status/lineage/settlement reads)
on-chain (Solana)              ← public state: ledger + registry + settlement + sealed payloads
closed moat endpoint           ← capture / RE resolve / value-decrypt (irreducible, off-chain)
substrate writes               ← aiko declare · pay.sh settle (the only write API)
```

## What this step does NOT do (Matt 6:34)

No code, no migration. Only the boundaries are drawn. The first stone (Step 3 / Land) — gated on
the user's (a)/(b) decision — is ONE website surface reading on-chain public state with zero backend call.
