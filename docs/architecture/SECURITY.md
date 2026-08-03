# Unbrowse Architecture — Security

> **At a glance** — Unbrowse's client is a thin, readable transport; the value
> lives on the server. Security therefore rests on four pillars: (1) a tampered
> or republished build cannot authenticate as official (a replayed signature
> only works on the attacker's own copy, which gains nothing — §1), (2) anti-bot
> challenges are handled
> through detect-then-replay handlers, (3) the shared route graph is
> tamper-evident and economically accountable, and (4) paid execution is gated
> and settled server-side. Every claim below cites a real file path.

> Reviewed 2026-06-17 against build v9.4.12 (`src/build-info.generated.ts`).
> This document is the code-grounded companion to the honest threat model in
> [../SECURITY.md](../SECURITY.md). Start at [OVERVIEW.md](./OVERVIEW.md) for the
> whole-system map.

## The honest premise

The CLI is JavaScript and ships readable in an npm tarball. Anyone who installs
it can read the source — obfuscation is a tax on the reader, not a wall. The
design goal is **not** "the code is unreadable." It is: *a modified build is
useless because it cannot authenticate to the unbrowse index*, so it loses the
marketplace, the route graph, ranking, recipes, and the x402 economics. The
value lives on the servers; the client is transport. See [../SECURITY.md](../SECURITY.md)
for the full threat model.

## 1. Anti-tamper / official-package binding

Three independent layers make a tampered or republished client worthless:

| Layer | Where | What it enforces |
|---|---|---|
| **Release-manifest HMAC** | `scripts/build-release-manifest.ts`, `src/build-info.generated.ts`, `src/version.ts` | At CI build time a manifest `{release_version, git_sha, code_hash, issued_at}` is signed with HMAC-SHA256 (`UNBROWSE_RELEASE_MANIFEST_SIGNING_SECRET`, CI-only) and baked into every binary. The backend HMAC-verifies it on marketplace calls; the secret never ships, so the signature cannot be forged. |
| **npm provenance** | `.github/workflows/release.yml` | Publishes with `npm publish --provenance` (Sigstore attestation), binding the tarball to the exact GitHub Actions run that built it. Republishing a modified clone under the official `unbrowse` name is cryptographically blocked. |
| **Server-bound exec-token** | minted at `POST /v1/session/exec-token` (backend), client carries it | Per-session HMAC bound to `{agent_id, build_sha, deployed_at, exp}`. Currently observe-mode; `EXEC_TOKEN_ENFORCE=1` flips it to hard 401 rejection. |

The thin-client boundary itself is a runnable gate:
`scripts/thin-client-gate.sh` must exit 0 — it proves no server-side "moat"
module is reachable from the public client closure.

**Residual gap (stated honestly).** An attacker can extract the manifest +
signature from an official tarball and replay it against their own locally
modified copy — the signature signs the manifest, not the running code. This is
the DRM impossibility. It only affects *their own* copy (provenance blocks
redistribution) and every paid action settles server-side, so the modified
client gains nothing.

## 2. Anti-bot / challenge handling

When a replayed route or a fetch hits a bot-management wall, Unbrowse detects
the specific system and runs a matched handler rather than failing blindly. Each
handler follows the same shape: *extract the challenge bundle → replay it in the
Kuri sandbox → harvest the clearance cookie → retry the original request.*
Handlers degrade honestly (return null / a typed sub-state) rather than
fabricating a fake clearance.

| Anti-bot system | Handler | Clearance signal | Status |
|---|---|---|---|
| Cloudflare (JS challenge) | `src/execution/cf-challenge.ts`, `capzy-cf-solve.ts` | `cf_clearance` | Capzy solver wired (`AntiCloudflareTask`, **proxy-required**, IP+UA-bound) + in-house bundle-replay fallback. API contract live-witnessed; a successful clearance depends on the target's solvability (challenges can return `ERROR_CAPTCHA_UNSOLVABLE`). |
| PerimeterX | `src/execution/px-challenge.ts` | `_pxhd` + `_px3` | bundle extract + replay |
| Akamai Bot Manager | `src/execution/akamai-challenge.ts` | `_abck` | detection live; solver pending |
| Kasada | `src/execution/kasada-challenge.ts` | `x-kpsdk-cd` + `x-kpsdk-ct` | detection only (needs live DOM/crypto, slated for browser-eval path) |
| Tencent Cloud WAF (TCaptcha) | `src/execution/tencent-waf-solve.ts` | `/WafCaptcha` clearance cookie | solved via Capzy (`UNBROWSE_CAPZY_KEY`) |
| Generic captcha (reCAPTCHA, hCaptcha, Turnstile, FunCaptcha, GeeTest) | `src/execution/captcha-solve.ts`, `captcha-clear.ts` | injected token | Capzy first, x402-paid solver fallback |

> **Status legend.** *live* = shipping; *wired* = a real solve path exists
> (managed solver or replay) but live verification needs a key + a gated target;
> *detection only* = the blocker is detected but not yet solved. Cloudflare is
> *wired* via Capzy (`src/execution/capzy-cf-solve.ts`, proxy-required). Akamai and
> Kasada remain *detection only*: Capzy offers **no** task type for them
> (live-witnessed `ERROR_TASK_NOT_SUPPORTED`), so they await a different solver —
> their `solve*AndRetry` bodies stay stubs rather than fake a path that cannot exist.

Cost guardrails live in `src/execution/captcha-solve.ts`: a per-probe budget
(default $0.01, prevents double-solve) and a per-day budget (default $1.00,
env-configurable). The backend holds the solver key — the client never does
(`captcha-clear.ts`). Honest degrade emits a typed sub-state
(`no_sitekey`, `no_payment`, `solver_error`) instead of a fake token.

## 3. Trust layer — a tamper-evident, accountable route graph

The shared graph only stays useful if freshness is maintained and contributions
are accountable. The trust layer (`src/trust/`) provides this:

- **Proof-of-indexing** (`src/trust/proof-of-indexing.ts`) — a maintainer
  re-fetches a route's live source, computes an order-independent,
  value-independent **schema fingerprint** (`schemaDescriptor` → `schemaHash`
  = `sha256:<hex>`), and emits a signed, content-addressed attestation
  hash-chained to the prior proof. `proofDiverged` makes it falsifiable: if the
  live schema no longer matches the committed hash, the proof is provably stale.
- **Bond-challenge** (`src/trust/bond-challenge.ts`) — a maintainer bonds
  collateral to become *eligible* to publish proofs (eligibility is boolean,
  never a score). `resolveChallenge` re-indexes on challenge; if the proof
  diverged, the bond is slashed. The economic policy constants are **injected**,
  never hard-coded in the module.
- **Ledger-checkpoint** (`src/trust/ledger-checkpoint.ts`) — batches signed
  ledger records into Merkle roots (`merkleRoot` / `merkleProof`); checkpoints
  hash-chain so history cannot be silently rewritten, and any record's
  membership is provable with a log-sized proof.
- **Refresh-job + scheduler** (`src/trust/refresh-job.ts`, `scheduler.ts`,
  `mount.ts`) — a 6-hour, **read-only** freshness pass. By law it re-issues only
  `idempotency === "safe"` endpoints over GET/HEAD, never a mutation. Opt-in via
  `UNBROWSE_TRUST_REFRESH=1`.

## 4. Proof layer — commitments without disclosure

`src/proof/` lets Unbrowse prove *what happened* without persisting secrets:

- **Commitment** (`src/proof/commitment.ts`) — `createCommitment` binds a
  captured request to `sha256` of its response body plus non-sensitive metadata
  (domain, url_template, method, status, captured_at). It never includes auth
  headers, cookies, or PII. `verifyCommitmentAgainstResponse` re-checks later.
- **Input-censor** (`src/proof/input-censor.ts`) — before any request shape is
  persisted or published, sensitive leaf values are replaced with `sha256:<hex>`
  commitments (`censorInputBody`). The reusable route shape survives; the secret
  never crosses the persistence/publish boundary. See [PRIVACY.md](./PRIVACY.md).
- **Notary** (`src/proof/notary.ts`) — a TLS-transcript notarization client.
  The shipped path is the commitment-only proof above; richer transcript
  notarization is gated behind `UNBROWSE_NOTARY_URL` and is forthcoming.

## 5. Payment-security gate (client side)

`src/payments/x402-fetch.ts` is a drop-in `fetch` wrapper that intercepts HTTP
402 (and proxy 407), parses the signed payment terms, **enforces a cost ceiling**
(`UNBROWSE_X402_MAX_COST_USD`, default $1.00), signs via the resolved wallet
adapter, and retries once. EVM (Base) signing via EIP-3009 lives in
`src/payments/base-x402-signer.ts`. Failure is honest: with no wallet it surfaces
the 402 unchanged with sub-state `x402_no_wallet` — never a fake success. The
server-side gate and settlement are in `backend/src/middleware/x402-gate.ts` and
`backend/src/services/flex.ts`. See [AUTH.md](./AUTH.md) for wallet resolution
and [../HOW_UNBROWSE_PAYS.md](../HOW_UNBROWSE_PAYS.md) for the money model.

## 6. Site policy & rate limiting

- **Site policy** (`src/site-policy.ts`) — detects session-bound parameters that
  cannot be safely replayed (`detectSessionBoundParams`) and flags mutating
  endpoints that require third-party-terms confirmation
  (`getEndpointPolicy`). Policies apply only to non-safe (mutating) methods.
- **Rate limiting** (`src/ratelimit/index.ts`) — `ROUTE_LIMITS` defines
  per-route ceilings (resolve, execute, publish, login, feedback). Disabled in
  the single-user local runtime; the config is the source of truth for the
  server tier.

## What "secure" means here, in one line

A tampered client can't authenticate, so it can't reach the value; secrets are
committed not stored; the graph is hash-chained and slashable; and every paid
action is ceiling-checked client-side and settled server-side.

## See also
- Honest threat model → [../SECURITY.md](../SECURITY.md)
- Data handling & secrets → [PRIVACY.md](./PRIVACY.md)
- Identity, keys, wallets → [AUTH.md](./AUTH.md)
- Public transparency primitives → [../public/primitives/README.md](../public/primitives/README.md)
