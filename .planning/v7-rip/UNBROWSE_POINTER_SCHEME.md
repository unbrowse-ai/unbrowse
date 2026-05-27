# `unbrowse://` — remote-DB value-store adapter (v7.1+ scope)

> Luke 14:28 — *"Which of you, intending to build a tower, doesn't first sit down and count the cost?"*

**Status:** scoping doc only. No code in v7.0. The CLI adapter ships in v7.1 at earliest.
**Owner:** Lewis assigns one engineer for v7.1 wave (client adapter + server stub).
**Directive (2026-05-28):** *"local pointers point to remote db via runpod through unbrowse infrastructure /covenant that"*.
**Always-wrap rule (Lewis reaffirmed 2026-05-28):** scoping IS a covenant — sit down first and count the cost before the build wave opens.
**Sibling work in flight:** W17 wires the KV cache backend for the same remote substrate in parallel; this doc owns the client-side adapter contract + server-side access protocol only.

The pointer trait (`src/values/types.ts:ValueAdapter`) is unchanged. This adapter dereferences against a hosted DB on Runpod (the existing unbrowse compute substrate) instead of a local CLI. Mental model for the user: same shape as `op://Vault/Item/Field`, different oracle behind the URI.

---

## 1. The pointer URI

```
unbrowse-uri   ::= "unbrowse://" vault slash item slash field
vault          ::= seg                 ; per-user, per-team, or per-org namespace
item           ::= seg                 ; logical credential grouping
field          ::= seg                 ; leaf: "password" | "username" | "api-key" | custom
seg            ::= 1*( ALPHA / DIGIT / "-" / "_" / "." / "+" )
slash          ::= "/"
```

Worked examples:

- `unbrowse://personal/twitter/username`
- `unbrowse://team-eng/stripe-prod/api-token`
- `unbrowse://org-acme/datadog/dd-api-key`

Why this exact shape:

1. **Three segments, like `op://`.** The user's mental model for "I have a vault with items that have fields" transfers byte-for-byte from 1Password. No section path (`op://`'s optional fourth segment) in v7.1; defer if a real need surfaces.
2. **Vault scope = ownership namespace.** v7.1 ships `owner_only` (the creating wallet). v7.2+ shared vaults are HKDF-key-wrapped to additional wallet pubkeys via X25519 key agreement. v7.3+ ZK-membership.
3. **Field IS the leaf.** No nested JSON path on the wire. If a credential needs nested structure, the client encodes/decodes it. Server stores opaque bytes per `(vault, item, field)` row.
4. **Case-sensitivity:** server treats segments as exact bytes after NFC-normalization. We do NOT lowercase; users picking `Personal` vs `personal` are two different vaults. Documented next to `keychain://` (which is also case-sensitive).

---

## 2. Threat model (load-bearing — longest section by design)

Defense engineering before code. Each adversary gets one named defense; gaps documented.

### A1. Network observer between CLI and Runpod server (TLS termination at the unbrowse edge)

A user behind a hostile WiFi, or an unbrowse edge node that decrypts TLS. Goal: read pointer URIs or value plaintext in flight.

**Defense:** TLS 1.3 with cert-pinning to the unbrowse cloud cert chain. CLI bundles a sha256 of the leaf cert public key and refuses to negotiate against a chain that doesn't match. Rotation: CLI ships a small allow-list of recent pins (current + previous), updated on every CLI release. **Crucially, even on TLS break, server only returns ciphertext** (see A2/A4 — encryption at rest defeats edge MITM too).

**Gap:** an attacker who breaks TLS AND learns the wallet HKDF secret can read plaintext. The wallet secret never leaves the user's keychain, so this requires a separate local compromise (A5, out of scope).

### A2. Compromised Runpod pod (the server reads its own storage)

Runpod is a shared compute substrate. A pod-level compromise (e.g., escape from a sibling tenant, or a malicious image we pull) gives the attacker read access to the storage backend.

**Defense: server-side blind storage.** The server stores `ciphertext_blob` only. The blob is AES-256-GCM-encrypted under a key the server NEVER sees: `K = HKDF(wallet_secret, info = "unbrowse-value-encrypt-v1" || vault || item || field)`. The wallet secret lives in the user's OS keychain (via `src/vault/index.ts` keytar wrapper); it never crosses the wire, encrypted or otherwise.

**Property:** a compromised Runpod pod can enumerate which wallet has which `(vault, item, field)` rows but CANNOT read any value. The blob is indistinguishable from random bytes without `K`.

### A3. Another unbrowse user on the same multi-tenant pod

User B issues a resolve request for User A's `unbrowse://personal/twitter/password`.

**Defense:** per-row owner_wallet_pubkey check. The server stores `owner_wallet_pubkey` next to every ciphertext row. On resolve, the server verifies the request signature is by that wallet (see §4 step 6). A request signed by User B over a row owned by User A is rejected with HTTP 403 + `error_code: "not_authorized"`. **Independent of A2:** even if User B steals the ciphertext (via A2), they can't decrypt without User A's wallet secret.

### A4. Compromised unbrowse staff (insider with prod Postgres + KV access)

An employee with backend read credentials.

**Defense:** identical to A2. The insider sees ciphertext_blob + owner_wallet_pubkey + access timestamps. They CANNOT recover plaintext without compromising the user's local keychain. Combined with audit log (§8), insiders are observable: every plaintext-leakage attempt would require offline brute-force against a Poseidon-style PRF, infeasible at AES-256-GCM strength.

### A5. Compromised user wallet (local keychain extraction)

Attacker has root on the user's laptop and reads the OS keychain.

**Defense scope: out of scope at the protocol layer.** Defense-in-depth via the OS keychain itself (Touch ID / Apple Watch / Secure Enclave on macOS, libsecret on Linux, DPAPI on Windows). The `keychain-secure://` ACL pattern in `VALUE_STORE_ADAPTERS.md` already documents the user-presence escalation.

**Documented gap:** if A5 fires, the attacker can decrypt every value in every vault the wallet owns. This is identical to compromising any password manager's master password. We do NOT pretend the protocol defends against root.

### A6. Replay / MITM on the resolve request

Attacker captures a signed resolve request and replays it later, or against a different pointer.

**Defense:** per-request challenge with timestamp + random nonce + pointer-binding.

```
challenge = { pointer, request_nonce, timestamp_unix_ms, wallet_pubkey }
sig = Ed25519_sign(wallet_secret, canonical_serialize(challenge))
```

Server enforces:
1. `timestamp` within ±60s of server clock (replay window cap).
2. `request_nonce` (16 random bytes) not in the seen-nonce KV (24h TTL), keyed by `(wallet_pubkey, request_nonce)`. Reject if seen.
3. The signature covers the FULL challenge — modifying `pointer` invalidates the sig.

**Note distinct from the envelope nonce:** §3's AES-GCM nonce binds encryption; §4's `request_nonce` binds the request itself. Two different nonces, two different scopes.

### A7. Sibling-wallet enumeration (subtle, easy to miss)

An attacker with no wallet but harvested URIs from logs/screenshots wants to know which wallet owns `unbrowse://x/y/z`.

**Defense:** the server does NOT expose a `whoOwns(pointer)` route. The resolve route requires a sig from the OWNER; non-owners get a 403 with NO leak of "this row exists but you can't read it" vs "this row does not exist." Both cases return the same error body. Constant-time row lookup is best-effort (Postgres timing not guaranteed) but the response envelope is uniform.

### Defense summary table

| Adversary | Primary defense | Gap if defense breaks |
|---|---|---|
| A1 network observer | TLS 1.3 + cert pin + server-blind ciphertext | A2/A4 defense survives even on TLS break |
| A2 compromised pod | client-side envelope encryption (wallet HKDF key) | A5 needed to extract plaintext |
| A3 sibling tenant | per-row owner check + sig verify | Same as A2 (blind storage backstops) |
| A4 insider | identical to A2 + audit log surfaces patterns | Same as A2 |
| A5 local root | OS keychain hardening (out of protocol scope) | Documented; same threat as any password manager |
| A6 replay/MITM | timestamped nonce + sig over full challenge | None within the ±60s window if seen-nonce cache holds |
| A7 enumeration | uniform 403 envelope, no existence leak | Timing oracle TBD — document risk |

---

## 3. The crypto envelope

### Encryption key derivation

```
K_field = HKDF-SHA256(
  ikm  = wallet_ed25519_secret_seed,         // 32 bytes, from local keychain
  salt = sha256("unbrowse-value-encrypt-v1"),// constant; binds to protocol version
  info = vault_utf8 || 0x00 || item_utf8 || 0x00 || field_utf8,
  L    = 32                                   // 32-byte AES-256 key
)
```

**Why HKDF per-field:** rotating one field's plaintext does NOT require re-deriving siblings. New field, new salt input, fresh key — even though `wallet_secret` is unchanged. This matters for `unbrowse://personal/twitter/password` rotation without disturbing `unbrowse://personal/twitter/username`.

**Why a distinct label (`unbrowse-value-encrypt-v1`) from the wallet's signing key:** the same Ed25519 secret seed signs covenant receipts AND derives encryption keys. Domain separation via the HKDF info+salt ensures encryption-side compromise cannot leak signing-side material and vice versa. Mirrors the standard NIST SP 800-108 KDF-domain pattern.

### Symmetric primitive: AES-256-GCM with random nonce

```
envelope_nonce = crypto.randomBytes(12)             // 96-bit random per-encryption
ciphertext     = AES-256-GCM_encrypt(K_field, envelope_nonce, plaintext, aad)
aad            = canonical("v1" || vault || item || field || owner_wallet_pubkey)
tag            = GCM auth tag (16 bytes)
blob_layout    = envelope_nonce(12) || ciphertext(N) || tag(16)
```

### Caught footgun: nonce = sha256(value) leaks plaintext equivalence

The draft scope passed to W18 specified `nonce = first 12 bytes of sha256(value)`. **This is wrong and I'm flagging it explicitly.** AES-GCM requires nonces UNIQUE per (key, nonce) pair; deriving the nonce from the plaintext means:

1. **Plaintext-equality leak:** two encryptions of the same value under the same key produce the same nonce + same ciphertext. An attacker comparing two stored blobs immediately learns "these two fields encrypt the same value" — equivalent to deterministic encryption, which leaks more than IND-CPA permits.
2. **Forgery surface:** GCM is catastrophically broken when nonces repeat under a fixed key — auth-key recovery is feasible (Joux attack). With deterministic nonce-from-value, ANY same-value re-encryption gives the attacker two ciphertexts with the same nonce + same key = full forgery capability over that key.

**Correct spec (replaces the draft):** `envelope_nonce = crypto.randomBytes(12)`, prepended to the ciphertext at rest. Caller never picks the nonce; the adapter generates it at encrypt-time. The nonce is public (it's in the blob layout); only the key is secret.

### Authenticated additional data (AAD)

We bind `(vault, item, field, owner_wallet_pubkey)` into the GCM AAD. This means a ciphertext copied across rows (an insider trying to swap blobs between wallets or move blob from `unbrowse://a/b/c` to `unbrowse://a/b/d`) fails authentication at decrypt-time. The blob is cryptographically pinned to its slot.

### What the server stores (one row per pointer)

```
{
  vault:                  TEXT NOT NULL,
  item:                   TEXT NOT NULL,
  field:                  TEXT NOT NULL,
  owner_wallet_pubkey:    BYTEA NOT NULL,  // 32 bytes ed25519
  blob:                   BYTEA NOT NULL,  // nonce(12) || ct(N) || tag(16)
  schema_version:         SMALLINT NOT NULL DEFAULT 1,
  created_at:             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at:             TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_accessed_at:       TIMESTAMPTZ,
  PRIMARY KEY (owner_wallet_pubkey, vault, item, field)
}
```

The primary key fan-out by wallet first means a single wallet's vault scan is one index range — Postgres-friendly. It also makes the per-wallet quota check (§7) a fast aggregate.

### What the client returns (post-decrypt) — same `ResolvedValue` shape

The `unbrowse://` adapter populates `ResolvedValue` (`src/values/types.ts`) identically to `op://`, `keychain://`, `bw://`, `arg://`:

- `value`: `Uint8Array` of decrypted plaintext.
- `signature`: Ed25519 over `(pointer || nonce || contextHash)` — the wallet's signature on the fill, computed CLIENT-side post-decrypt.
- `walletPubkey`: 32-byte wallet pubkey.
- `contextHash`: from `AdapterContext`.
- `commitment`: `sha256(value || nonce)` — `nonce` here is the `AdapterContext` 32-byte caller-supplied nonce, NOT the envelope nonce. Two distinct nonces, one binds encryption, the other binds the fill receipt.
- `adapter`: `"unbrowse"` (extends the `Scheme` union).
- `pointer`: the original `unbrowse://...` URI.
- `Symbol.asyncDispose`: zeroes `value` on scope exit via `sodium.memzero`.

---

## 4. Resolve flow (sequence diagram in plain text)

Client = unbrowse CLI on user laptop. Server = Runpod-hosted Hono app.

```
 1. CLI: build challenge
        challenge = {
          pointer: "unbrowse://personal/twitter/password",
          request_nonce: crypto.randomBytes(16),
          timestamp_unix_ms: Date.now(),
          wallet_pubkey: <32 bytes>
        }
 2. CLI: canonical-serialize challenge (sorted-key JSON, UTF-8)
 3. CLI: sig = Ed25519_sign(wallet_secret, serialized_challenge)
 4. CLI: POST https://values.unbrowse.ai/v1/values/resolve
         { challenge, sig }
         Headers: Content-Type: application/json, cert-pinned TLS
 5. Server: verify sig over canonical_serialize(challenge) using wallet_pubkey
            → reject 401 on fail
 6. Server: check |now() - timestamp_unix_ms| <= 60_000
            → reject 401 on fail
 7. Server: check (wallet_pubkey, request_nonce) NOT in seen-nonces KV
            → reject 401 on fail; else atomically INSERT with 24h TTL
 8. Server: parse pointer → (vault, item, field)
 9. Server: SELECT blob, owner_wallet_pubkey FROM values
            WHERE owner_wallet_pubkey = $wallet AND vault=$v AND item=$i AND field=$f
           → reject 403 (uniform envelope) on miss OR owner mismatch
10. Server: rate-limit check (per wallet, last 60s) — see §7
            → reject 429 on exhaust
11. Server: UPDATE last_accessed_at = now()
12. Server: append audit log row { wallet_pubkey, pointer_hash, ts, granted=true }
13. Server: return 200 { blob, schema_version }
14. CLI: parse blob → { envelope_nonce, ciphertext, tag }
15. CLI: K_field = HKDF(wallet_secret, "unbrowse-value-encrypt-v1", vault||item||field)
16. CLI: plaintext = AES-256-GCM_decrypt(K_field, envelope_nonce, ciphertext, tag, aad)
            → AAD mismatch ⇒ throw AdapterError("ciphertext_tampered")
17. CLI: commitment = sha256(plaintext || ctx.contextHash_nonce)
           // distinct from envelope_nonce — this is the fill-receipt commitment
18. CLI: signature = Ed25519_sign(wallet_secret,
                                  pointer || ctx_nonce || ctx.contextHash)
19. CLI: return ResolvedValue { value=plaintext, signature, walletPubkey,
                                contextHash, commitment, adapter:"unbrowse",
                                pointer, [Symbol.asyncDispose]: zero(value) }
20. CLI: caller consumes value inside `await using` scope, AsyncDispose zeroes.
21. (Out-of-band, parallel) CLI POSTs covenant receipt to local ledger per W4/W8.
```

**Step 17 vs step 14 nonces:**
- `envelope_nonce` (12 bytes): public, in the blob, binds AES-GCM encryption uniqueness. Server-visible.
- `ctx.contextHash`-derived caller nonce (32 bytes): binds the FILL receipt to a (session, selector, url, ts) tuple. Client-only, lands in covenant receipt.

---

## 5. Server topology (Runpod)

### Compute

- **Runpod CPU pod.** No GPU needed for KV; saves cost vs GPU node. One pod sized for ~10k req/sec resolve baseline; horizontal scale via additional pods behind the unbrowse edge LB.
- **Framework:** Hono (matches the existing Cloudflare Worker backend at `backend/`; share code where viable). Bun runtime on Runpod.
- **TLS:** terminated at the unbrowse edge (Cloudflare). Cert-pinning client-side targets the unbrowse leaf cert; rotation handled via CLI release pin list.

### Storage — two-store layout

**Recommendation: Tigris (S3-compatible) for blob + Neon Postgres for metadata.**

| Concern | Tigris (S3) | Neon Postgres |
|---|---|---|
| `blob` (ciphertext) | yes — content-addressed key `sha256(wallet_pubkey \|\| vault \|\| item \|\| field)` | could store as BYTEA, but rows grow large |
| `(vault, item, field, owner_wallet_pubkey, schema_version, created_at, …)` | no — S3 is not a query store | yes — primary key + indexes |
| `audit_log` rows | append-only Tigris OR Neon table | preferred — Neon, for SQL queries from admin |
| `seen-nonces` (24h TTL) | no | a redis/keyDB sidecar, OR Tigris with TTL header, OR Neon table with cron sweep |

**Why not Cloudflare Workers + D1 (skip Runpod):** Lewis explicitly named Runpod = the existing unbrowse compute substrate. Re-using established infra > spawning a new edge-compute account with separate billing, separate secrets, separate observability. Documented trade: D1 has stronger global edge replication (write-everywhere reads), Postgres has stronger query power + transactions. We pick Postgres because the access policy (per-row owner check, per-wallet quota aggregation) is naturally relational.

**Why Tigris vs R2:** Tigris is S3-compat with multi-region replication and explicit blob TTLs. R2 is fine and may be cheaper inside the Cloudflare ecosystem; deferred to v7.1 implementation wave once the access patterns are benched.

### Sibling W17 KV cache backend

W17 is wiring a KV cache for hot-resolve patterns in parallel. This adapter's resolve path SHOULD consult W17's cache on `last_accessed_at < 5min` rows before hitting Postgres — the row is the same blob bytes, so the cache key is `(wallet_pubkey, vault, item, field)` and the cached value is the encrypted blob (NOT the plaintext; the server never sees plaintext). Cache invalidation on PUT/DELETE in v7.2 — flag for W17 coordination.

### Identity for the server itself

The Runpod pod needs its own Ed25519 identity to sign **response envelopes** (defense against a Cloudflare-edge MITM that swaps the response after TLS termination). The pod identity is provisioned at deploy-time and rotated per the `backend/src/lib/attestation.ts:LEWIS_DEPLOYER_PUBKEY_v1` substrate. CLI bundles a recent allow-list of pod pubkeys; mismatch = reject the response.

**Open question:** does v7.1 ship the response-envelope sig, or defer to v7.2? Defer recommended — TLS-pin + AAD-bound ciphertext already defeats the edge-MITM threat at the value layer; the response sig is defense-in-depth.

---

## 6. Per-vault access policy

### v7.1 — `owner_only`

The wallet that wrote the row is the only reader. Enforced by §4 step 9 (PK includes `owner_wallet_pubkey`). No sharing primitives.

### v7.2 — shared vaults (X25519 key wrap)

When User A wants to share `unbrowse://team-eng/stripe-prod/api-token` with User B:

1. A derives `K_field` per §3.
2. A computes `K_wrap_for_B = X25519_DH(A_x25519_sk, B_x25519_pk)`.
3. A encrypts `K_field` under `K_wrap_for_B`, stores the wrapped key as a SHARE row keyed by `(vault, item, field, recipient_wallet)`.
4. On B's resolve, server returns the SHARE row alongside the main blob. B decrypts `K_field` with their own X25519 sk, then decrypts the blob.

This bolts on top of the v7.1 schema (new SHARES table) without disturbing the owner_only path. Documented now so v7.1 doesn't paint itself into a corner.

### v7.3+ — ZK membership

A wallet proves it's an authorized member of a shared vault WITHOUT revealing identity to other members. Same Groth16 toolchain as `ZK_SCOPE.md` v7.3 (3 months after v7.0). The vault's authorized-pubkeys Merkle root is the public input; the wallet's membership proof is the witness.

**v7.0 / v7.1 access-proof choice:** v7.1 ships plain Ed25519 sig over the challenge (matches `ZK_SCOPE.md` v7.0 sig-shape). The same SNARK upgrade path applies — when ZK_SCOPE v7.3 lands, the resolve endpoint accepts a ZK proof in place of the plain sig, behind a feature flag. Schema-stable.

---

## 7. Rate limit + quotas

### Per-wallet, per-minute resolve

- **100 resolves / wallet / minute.** Sliding window via Postgres `audit_log` aggregate OR a Redis-style counter on the W17 KV. Reject 429 with `Retry-After` header on exhaust.
- Rationale: a real agent does 1-10 fills per browse session; 100/min covers heavy multi-agent setups. Higher rates probably indicate scripted exfil.

### Per-wallet, total stored bytes

- **10 MB ciphertext per wallet** in v7.1. Hard cap; PUT (v7.2) returns 413 on exhaust. Generous: at ~200 bytes/credential, that's 50k credentials per wallet.

### Free tier vs paid

**TBD — flag for product decision, not a tech decision.** Tech-side:

- Quotas are per-wallet, enforceable atomically server-side.
- A paid tier could lift to 1000/min and 1 GB.
- Integration with x402 billing (§11 open question) is the natural fit — pay USDC per stored MB per month, sponsored from the existing `PLATFORM_SPONSOR_WALLET` for the first $1/wallet/day.

---

## 8. Server-side audit log

**Separate from W4/W8 fill-audit.** W4/W8 audits the CLIENT-side fill action (selector, url, session_id) and the receipt is held in the local covenant ledger. THIS audit logs the SERVER-side resolve grant — independent record, different threat model.

### Row shape

```
{
  wallet_pubkey:    BYTEA NOT NULL,
  pointer_hash:     BYTEA NOT NULL,   // sha256(vault || 0x00 || item || 0x00 || field)
  timestamp:        TIMESTAMPTZ NOT NULL DEFAULT now(),
  access_granted:   BOOLEAN NOT NULL, // true on 200, false on 401/403/429
  reason:           TEXT,             // "ok" | "sig_invalid" | "not_owner" | …
  client_ip_hash:   BYTEA              // sha256(ip || daily_salt), per-day k-anon
}
```

### Privacy rules

1. **Pointer plaintext NEVER logged.** Only `pointer_hash`. The wallet that owns the row can verify (they know the plaintext); third-party log readers see opaque hashes.
2. **IP is k-anonymized.** Hashed under a daily-rotating server salt so analysts can detect "many wallets from one IP" patterns without exposing static IPs.
3. **Read surface:** `GET /v1/values/audit` returns rows for the requesting wallet only (sig-gated, same shape as resolve). Admins get an aggregate via `backend/src/routes/admin/sponsor-ledger`-style endpoint (ADMIN_KEY-gated, mirrors §sponsor.ts).

### Retention

90 days default. User can request earlier purge via `DELETE /v1/values/audit` (sig-gated, only their own rows).

---

## 9. Versioning + migration

### Schema version field on each row

`schema_version: SMALLINT NOT NULL DEFAULT 1` on the values table AND on the blob layout's first byte (`schema_version || envelope_nonce || ciphertext || tag` — note: this shifts the blob layout, decide at v7.1 implementation whether the byte goes inline-prefixed or in the row column. Recommend: row column only, so the blob is exactly `nonce || ct || tag`).

### Re-encryption for vault-level key rotation

**Out of scope for v7.1.** Flagged as v7.2. Protocol sketch:

1. User rotates wallet (e.g., key compromise recovery via the v6 wallet-rotation flow).
2. CLI subcommand `unbrowse breath vault-rotate` (a new `breath` verb in v7.2):
   - For each row in the wallet's vault: pull blob, decrypt with old key, re-derive new key from new wallet secret, re-encrypt, PUT back atomically.
   - Server-side support: optional bulk-update endpoint OR loop client-side.
3. Append `superseded_by` attestation linking old wallet → new wallet, per the `ZK_SCOPE.md` rotation pattern.

### Protocol versioning

v1 = this doc. Future v2 changes (e.g., switch from AES-GCM to ChaCha20-Poly1305) bump the schema_version. Client checks the row's `schema_version` and dispatches to the correct decrypt routine. Backward-compat: clients keep the v1 decrypt path indefinitely.

---

## 10. v7.0 vs v7.1 vs v7.2+ split

### v7.0 (ships within the v7 cut)

- **This SCOPE.md only.** No code lands in the v7.0 tree.
- The `Scheme` union in `src/values/types.ts` stays `"op" | "keychain" | "bw" | "arg"`. No `unbrowse` scheme yet.
- Bench gate / agent-experience harness do not exercise `unbrowse://`.

### v7.1 — minimal client adapter + server stub (1-2 months after v7.0)

- **Scheme:** `Scheme` union extends to `"op" | "keychain" | "bw" | "arg" | "unbrowse"`.
- **Client adapter:** `src/values/adapters/unbrowse.ts` implements `ValueAdapter`. Read-only — `resolve()` works; no put/delete.
- **Bootstrap:** `unbrowse setup` adds an optional Runpod-DB enrollment step (generates per-install enrollment attestation, registers wallet pubkey with server).
- **Server:** Runpod pod with Hono + Postgres + Tigris. Routes: `POST /v1/values/resolve`, `GET /v1/values/audit`.
- **Policy:** `owner_only` access. No sharing.
- **Quotas:** 100 res/min, 10 MB store.
- **Audit:** server-side log per §8.
- **No put/delete on the wire yet** — initial seeding via a separate admin tool (e.g., a CLI flag on a private branch, OR a one-time enroll script). Lewis explicitly: "resolve only" for v7.1.

### v7.2 — read/write + shared vaults (3-4 months after v7.0)

- **Client:** `unbrowse build value-source unbrowse://…` (PUT) and a `breath vault-rotate` for re-encryption.
- **Server:** `PUT`, `DELETE`, `LIST` routes. Shared-vault SHARES table.
- **CLI verbs:** new `breath` family for value-store mutations (`vault-put`, `vault-delete`, `vault-share`).

### v7.3+ — ZK access proof, audit dashboard, browser-prover

- **ZK upgrade per ZK_SCOPE v7.3.** Resolve accepts SNARK proof in place of plain sig (feature-flagged); shared-vault membership becomes a ZK proof against the vault Merkle root.
- **Admin audit dashboard** at `dashboard.unbrowse.ai/audit` — wallet-scoped per-pointer access timeline.
- **Browser prover** (for OpenClaw / @unbrowse/sdk) — sig-shape only, no SNARK in browser per ZK_SCOPE §browser-prover.

---

## 11. Open questions

1. **Wallet secret reuse for encryption (DECIDED — keep separate).** The wallet's Ed25519 seed serves BOTH the signing path (covenant sigs) AND the encryption-key derivation (HKDF root). Per §3 we use distinct HKDF labels — `unbrowse-value-encrypt-v1` for AES keys, no label needed for signing (raw Ed25519). Domain separation via HKDF info+salt is cryptographically sufficient; we do NOT need two independent seeds. Documented; lock at v7.1 implementation.

2. **Runpod pod identity story.** The pod needs its own Ed25519 identity for response-envelope signing (defense against post-TLS-termination MITM). Provisioning + rotation reuses `backend/src/lib/attestation.ts:LEWIS_DEPLOYER_PUBKEY_v1` hierarchy. **Decision needed:** does v7.1 ship response sigs (extra mile, defense-in-depth) or defer to v7.2 (TLS-pin + AAD-bound ciphertext already defeats the threat)? Recommend: defer to v7.2. **Flag for Lewis call before W18-impl-wave.**

3. **Blob storage backend.** Tigris vs R2 vs Postgres-BYTEA. Recommend Tigris for S3-compat + multi-region; defer final pick to v7.1 implementation wave once latency-from-Runpod is benched. **Not blocking the SCOPE.md.**

4. **x402 billing model.** Per-resolve micropayment ($0.0001 each, sponsored from `PLATFORM_SPONSOR_WALLET`) OR flat $1/mo subscription per wallet for unlimited within quotas? **Pure product question.** The protocol supports either — billing rides on the existing `backend/src/middleware/sponsor.ts` substrate.

5. **Multi-row resolve batching.** Should `/v1/values/resolve` accept an array of pointers in one call? Lewis's v6→v7 adapter trait has one-pointer-per-call. Defer to v7.2 — adapter trait stays one-shot; a batch endpoint can be a separate convenience route.

6. **Cert pin rotation cadence.** CLI bundles a sha256 of the unbrowse leaf cert pubkey. Cert rotates per Cloudflare cadence (~quarterly). CLI release cadence is ~monthly. Rotation strategy: CLI bundles a sliding allow-list of (current + 2 previous) pins; expired pins fail closed with `next_step: "upgrade unbrowse CLI"`.

---

## 12. The load-bearing v7.1-shippability concern (one line for the report)

**Cert-pin rotation cadence is the single concern that gates v7.1 ship.** Get it wrong and either (a) every cert rotation soft-bricks every deployed CLI, or (b) we lose the pin's defense and trust the CA chain alone (which is then vulnerable to any rogue CA — exactly the threat the pin defends against). Resolution per §11.6 is shipping a sliding allow-list, but the rotation playbook needs to be runbook-documented BEFORE the first cert turnover lands while users are in the field.
