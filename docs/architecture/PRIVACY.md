# Unbrowse Architecture — Privacy & Data Handling

> **At a glance** — "Credentials never leave the machine" is a *construction*,
> not a promise. The client strips every secret value locally before anything
> crosses the network, replaces it with a one-way commitment, and a separate
> audit pass refuses to send if any known secret survived. The server sees
> request *structure* (method, URL shape, param keys, schema), never values.

> Reviewed 2026-06-17 against build v9.4.12. Companion to [SECURITY.md](./SECURITY.md)
> and the public primitive [../public/primitives/05-user-response-never-contains.md](../public/primitives/05-user-response-never-contains.md).

## The boundary, stated precisely

There are three boundaries a secret could cross, and the design closes each:

1. **The network boundary** (client → unbrowse server). Closed by obfuscation +
   an audit gate (§1, §2).
2. **The persistence/publish boundary** (local disk, shared marketplace). Closed
   by input-censoring to commitments (§4).
3. **The at-rest boundary** (local vault on disk). Closed by encryption, with an
   optional wallet-seal so even a stolen vault file is unreadable (§5).

## 1. Thin client: only structure crosses the wire

The reverse-engineering / route-inference engine runs **server-side only**. The
client does not carry it. What the client sends to `POST /v1/reveng` is
*structure*, obfuscated first:

- `src/capture/reveng-server-first.ts` — `revengServerFirst()` obfuscates the
  capture (`obfuscateCaptureForReveng`) **before** the POST. If the server is
  unreachable (offline, no key, non-2xx) it returns an empty endpoint list —
  there is deliberately **no local inference fallback**, so raw traffic can never
  be a fallback's input. `revengEgressPayload()` exposes the exact bytes on the
  wire for audit testing.
- `src/capture/backend-reveng-endpoint.ts` — the client-side wiring to the
  server engine.

The result: the server sees method / URL shape / param keys / response schema —
the inference IP stays server-side, the secrets stay client-side.

## 2. Secret/PII obfuscation + the audit gate

`src/capture/obfuscate.ts` redacts in two layers, then `obfuscate-audit.ts`
verifies the redaction worked:

- **Heuristic redaction** — sensitive field names (token, secret, credential,
  auth, cookie, sid, …) and sensitive headers (Authorization, Cookie,
  X-CSRF-Token, X-API-Key, …) are always redacted; values that *look* like
  secrets are caught by shape.
- **Known-secret scrub** — the caller passes the local vault secrets
  (`opts.secrets`); `scrubKnownSecrets` does an exact-match sweep (longest-first)
  so no vault value slips through a heuristic gap.
- **Audit gate** (`obfuscateAuditedCapture` in `obfuscate-audit.ts`) — scans the
  *outgoing* payload against the vault. If even one secret survives, it throws
  `ObfuscationLeakError` and the send is refused. This is the open-source
  belt-and-suspenders: the engine redacts; the audit verifies it against the
  known vault secrets (it cannot detect a secret the vault has never seen — the
  heuristic layer is the only guard there).

## 3. Wallet-bound commitments

When a wallet public key is available, a redacted secret is replaced with a
deterministic, one-way commitment instead of a bare `[REDACTED]`
(`src/capture/wallet-bind.ts`): `bindSecretToWallet` returns
`sha256(walletPubkey ‖ domain-separator ‖ secret)`, embedded as a short
`bound:<hex>` tag. Properties:

- **One-way** — the tag is a digest; the value is not recoverable from it.
- **Wallet-scoped** — the same secret under a different wallet yields a different
  tag, so commitments are not correlatable across owners.
- **Holder-verifiable** — only the holder, who has the local secret, can
  re-derive and verify the tag.

Stated honestly: a simple commitment is computationally hiding for high-entropy
secrets (tokens, session IDs, keys). A *low-entropy* secret (e.g. a 4-digit PIN)
is brute-forceable from its commitment — a documented limitation of the
shipped commitment scheme (`src/capture/wallet-bind.ts`).

## 4. Censoring at the persistence/publish boundary

The live request still sends the real value to the target, but any **persisted
or published** copy (local skill cache, shared marketplace manifest) carries a
commitment, never the cleartext:

- `src/proof/input-censor.ts` — `censorInputBody` deep-walks a request body,
  detects sensitive leaves by field name and by vault-pointer form
  (`op://`, `keychain://`, …), and replaces each with `sha256:<hex>`.
  `censorSkillForPersistence` applies this to skill manifests, censoring only
  WRITE-endpoint bodies (GET/HEAD carry no sensitive input).
- `src/capture/bundle-scanner.ts` — when mining routes out of JS bundles, the
  scanner extracts endpoint shapes but **skips sensitive query params**
  (api_key, access_token, secret, password, session_id, …), so the harvested
  skeleton has no secret params.

## 5. Local storage & at-rest protection

| Store | Path | Protection |
|---|---|---|
| Credential vault | `~/.unbrowse/vault/credentials.enc` | AES-256 encrypted under a local key (`.key`, mode 0o600). With `UNBROWSE_WALLET_SECRET` set, each value is further sealed (AES-256-GCM under a wallet-derived key) and the plaintext is removed — only the wallet holder can open it. macOS keychain is tried first with a safe fallback to the file vault. (`src/vault/index.ts`, `src/vault/wallet-vault.ts`) |
| Sealed fills | in-memory / sealed blob | `src/capture/sealed-fill.ts` seals fill values to the wallet and reveals them **locally** at execute time; the filled concrete request is built locally and never sent plaintext to the server. |
| Config | `~/.unbrowse/config.json` | mode 0o600; settings only, no secrets expected. (`src/client/index.ts`) |
| Session logs / traces | `~/.unbrowse/traces/` | Metadata only — `src/telemetry.ts` never stores raw cookies, tokens, or bodies; URLs are stripped of query/fragment (`anonymizeUrl`), bodies are hashed (`hashResponseBody`), binding *names* are kept but sensitive keys excluded (`safeBindingNames`). Opt-out: `UNBROWSE_DISABLE_TRACES=1`. |

## Does the guarantee hold? — honest verdict

**At the network boundary: yes, by construction.** Plaintext secrets are
stripped before the POST; the audit gate refuses any send where a known secret
survived; the server has no path to a raw value.

**Caveats, stated plainly:**
- Low-entropy secrets are brute-forceable from a simple commitment (§3).
- The route-inference engine runs server-side; the *client inputs* remain
  obfuscated, but a compromised server could mis-handle inferred structure.
- A compromised local machine can read the vault key unless `UNBROWSE_WALLET_SECRET`
  is set (then a stolen vault file is unopenable without the wallet).

## See also
- Threat model & anti-tamper → [SECURITY.md](./SECURITY.md)
- What a user response may never contain → [../public/primitives/05-user-response-never-contains.md](../public/primitives/05-user-response-never-contains.md)
- Verification & proofs (concept) → [../concepts/verification-and-proofs.md](../concepts/verification-and-proofs.md)
