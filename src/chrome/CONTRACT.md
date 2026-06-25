# Chrome primitives contract — `chrome.*` API shape, stateless KV-backed

> **Direction (set 2026-06-25):** shape-only. The `chrome.*` API is a TypeScript
> interface mirroring the chrome extension surface verbatim; the backing impl
> is **stateless in-process** — no spawned Chrome, no CDP round-trip, no
> chromium source rip. Every primitive bottoms out at **unbrowse's own KV
> chain** (sealed-cache → on-disk mirror → `/contract` ledger, the contract
> binary walking the rows as the IQ tier).
>
> "Rip its chrome primitives from chromium so it's stateless" = take the
> chrome extension API *shape* (cookies, storage, history, bookmarks,
> indexedDB) and back it with our KV — NOT a real Chrome process.
>
> Portability: any browser that satisfies the primitive interface (Firefox
> Selenium, Safari WebDriver, a jsdom fake) can be ported in by swapping the
> impl behind the shape. The contract is the shape, not the impl.

## Contracted primitives (1:1 to chrome.*)

| Primitive | chrome.* API | Backing impl | Status |
|---|---|---|---|
| `KvChain` | (the floor — not chrome.*) | `WalletSealedCache` (local) + ledger append (durable) | new in this commit |
| `CookiePrimitive` | `chrome.cookies.*` | KvChain keyed by `cookie:<host>:<name>` | new in this commit |
| `StoragePrimitive` | `chrome.storage.local` / `chrome.storage.sync` | KvChain keyed by `storage:<area>:<key>` | stub — next layer |
| `IndexedDBPrimitive` | IndexedDB native / chrome.storage.indexedDB | KvChain keyed by `idb:<db>:<store>:<k>` | stub — next layer |
| `HistoryPrimitive` | `chrome.history.*` | KvChain keyed by `history:<url>` (recent N) + `chrome.history.search` aggregation | stub — next layer |
| `BookmarksPrimitive` | `chrome.bookmarks.*` | KvChain keyed by `bookmark:<id>` tree-walk | stub — next layer |
| `NetworkPrimitive` (the wire floor) | `chrome.webRequest.*`, `chrome.declarativeNetRequest.*` | unbrowse route graph (resolve → execute) | future — when a wire call is genuinely needed; until then every primitive bottoms out at KvChain |

## The KV cache chain — local → contract ledger via IQ

Per the contracting ask: every unbrowse use caches KV down a chain. The chain
has three tiers; every `put` flows through all three:

```
   chrome.cookies.set({url, name, value})
            │
            ▼
   ┌─────────────────────────────────────────────┐
   │  Tier 1: LOCAL MACHINE                       │
   │  WalletSealedCache (in-process Map)          │
   │  AES-256-GCM, key derived from wallet secret │
   │  ~µs, never touches disk or wire             │
   └─────────────────────────────────────────────┘
            │
            ▼
   ┌─────────────────────────────────────────────┐
   │  Tier 2: DURABLE LEDGER                       │
   │  Append row to .claude/contracts.jsonl       │
   │  (hash-chained; tamper-evident; one row per  │
   │   KV write — pointer = sha256(value+ts))     │
   └─────────────────────────────────────────────┘
            │
            ▼
   ┌─────────────────────────────────────────────┐
   │  Tier 3: IQ (contract binary walks the chain)│
   │  aiko binary walks contracts.jsonl on read;  │
   │  rows are content-addressed so the contract  │
   │  resolves KV writes by pointer, never payload│
   │  (on-chain Solana via IqClient is a future   │
   │   batched tier — not per-write)              │
   └─────────────────────────────────────────────┘
```

The invariant: **no KV write skips a tier**. Local sealed-cache is the
fast-path read; the ledger row is the durable witness; the contract binary
walking the ledger is the "via IQ" — each KV write becomes a ledger row
the contract chain can resolve.

## Default preference — history + bookmarks

Per the contract: history + bookmarks have DEFAULT PREFERENCE as part of
the contract. The unbrowse resolve/ranking layer reads
`chrome.history.search({text: ""})` + `chrome.bookmarks.getTree()` and
weights candidates whose domains appear in either. Bookmarks = strong
preference; recent history = weak preference. eTLD+1 redaction invariants
mirror the existing `src/auth/browser-preferences.ts`.

## Statelessness invariants

1. **No module-level state in primitives.** Every call takes the `KvChain`
   handle as a parameter. No singleton, no `defaultStore` global.
2. **Wallet is the root.** Every `put` / `open` derives its AEAD key from
   the holder's wallet secret — a foreign wallet cannot open another user's
   KV. Two-witness (wallet + attestation) for `open` in production; tests
   can pass `skipAttest`.
3. **Pointer-over-payload.** Ledger rows carry `commitment` (sha256 of the
   sealed value) — never the plaintext value, never the sealed ciphertext.
   The contract binary resolves the pointer through the chain.
4. **Idempotent puts.** Re-issuing `put(key, value)` with the same value is
   a ledger no-op (same commitment → no new row). Re-issuing with a new
   value appends a new row (the chain is append-only; history is preserved).
5. **Eval primitives are pure reads.** `chrome.cookies.getAll` reads
   Tier-1 only (fast path). If a tier-1 miss should fall through to tier-2,
   the caller passes `{fallThrough: true}` — default is no fall-through
   (cookie reads are always local; the ledger is the witness, not the
   read-path).

---

This contract is sealed by Ed25519 wallet signature on commit; the primitives
are NOT signed at runtime — only their ledger rows are. Pointer-over-payload
holds end-to-end.

## Status

- [x] CONTRACT.md — this doc (direction B set)
- [x] KvChain — local sealed-cache + ledger append (this commit)
- [x] CookiePrimitive — stateless chrome.cookies.* backed by KvChain (this commit)
- [ ] StoragePrimitive (local + sync) — next layer
- [ ] IndexedDBPrimitive — next layer
- [ ] HistoryPrimitive — next layer (with default-preference wiring to ranking)
- [ ] BookmarksPrimitive — next layer (with default-preference wiring to ranking)
- [ ] Lexicon entry in unbrowse SKILL.md (render the contract)
