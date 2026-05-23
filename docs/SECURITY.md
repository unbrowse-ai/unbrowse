# Unbrowse security model: official-package binding + anti-reverse-engineering

This document is the honest threat model. It says what the substrate
enforces, what it cannot, and why the design still holds.

## The honest premise

The unbrowse CLI is JavaScript. It ships, unminified-enough-to-read, in
an npm tarball. **Anyone who installs it can read the source.** No amount
of obfuscation changes that: obfuscation is a tax on the reader, not a
wall, and JS obfuscation in particular is routinely undone by automated
deobfuscators. We do not pretend otherwise, and we do not ship a fake
wall.

The design goal is therefore NOT "the code is unreadable." It is:

> A modified or reverse-engineered build is **useless** -- it cannot
> authenticate to the unbrowse index, so it loses the marketplace, the
> graph, the ranking, and the x402 economics. The value lives on the
> servers; the client is a transport.

## What IS enforced (and cannot be bypassed)

### 1. Release-manifest HMAC -- a modified binary is rejected

Every official CLI build bakes a signed release manifest at CI time
(`BUILD_RELEASE_MANIFEST_BASE64` + `BUILD_RELEASE_MANIFEST_SIGNATURE` in
`src/build-info.generated.ts`). The signature is an HMAC-SHA256 over the
manifest, signed with `UNBROWSE_RELEASE_MANIFEST_SIGNING_SECRET` -- a
secret that exists only inside the CI runner and the backend.

The backend `requireSignedClient` middleware (`backend/src/middleware/
auth.ts`) runs on every marketplace route (`/v1/search/domain`,
`/v1/search/resolve`, `/v1/search/rank`, `/v1/skills`, and
`/v1/search` + `/v1/search/endpoints` when authenticated). It
HMAC-verifies the manifest. A hand-built clone or a binary with no
manifest gets `426 client_verification_failed`.

An attacker cannot forge a manifest signature: they do not have the
secret. They can only REPLAY the manifest extracted from a real npm
tarball -- which brings us to the residual gap below.

### 2. npm provenance -- a modified REDISTRIBUTION is impossible

`.github/workflows/release.yml` publishes with `npm publish
--provenance`. This produces a Sigstore-backed attestation
cryptographically binding the published tarball to the exact GitHub
Actions workflow run + commit that built it.

- A modified clone republished under the name `unbrowse` is impossible
  -- the attacker does not own the npm name.
- A modified clone under a different name has no provenance for
  `unbrowse` and `npm audit signatures` flags it.

Verify your own install at any time:

```bash
bash scripts/verify-official-package.sh
# or, for an installed CLI: npm audit signatures
```

This is the one client-side check that is genuinely unforgeable.

### 3. Server-bound exec-token -- the marketplace requires a live handshake

`backend/src/services/exec-token.ts` + `middleware/exec-token.ts` (the
`bind-unbrowse-execution-logic-to-server-signed-p` harness, Waves 1-2).
Authenticated marketplace calls carry a per-session HMAC token minted at
`POST /v1/session/exec-token`, bound to `{agent_id, build_sha,
deployed_at, exp}`. Currently in observe mode; `EXEC_TOKEN_ENFORCE=1`
flips it to hard 401.

### 4. Server-side metering -- payment cannot be patched out

x402 settlement, the sponsor caps, the per-skill markup, and the Flex
splits all execute on the server (`backend/src/services/flex.ts`,
`middleware/sponsor.ts`). A patched client that strips its own payment
UI still hits a server that returns `402 Payment Required`. You cannot
patch a number that lives on someone else's computer.

## The residual gap (and why it does not matter)

A determined attacker can:

1. Install the official `unbrowse` tarball.
2. Extract the baked manifest + signature.
3. Modify the local JS.
4. Replay the extracted (still-valid) manifest signature from their
   modified binary.

The manifest signature validates because it signs the manifest, not the
running code -- and a fully attacker-controlled client cannot honestly
attest its own integrity. This is the **DRM impossibility**: it is the
same reason every client-side copy protection scheme eventually loses.
We do not waste effort fighting it.

Why it does not matter:

- The attacker can only modify **their own** copy (provenance blocks
  redistribution -- gap #2).
- Their modified copy still needs a real, paid `agent_id`.
- The marketplace index, graph search, ranking, and capture-replay
  recipes are all server-side. Reverse-engineering the client yields
  the commodity transport layer, not the moat.
- Every paid action settles server-side. There is nothing local to
  "crack" for free usage.

The honest summary: **you cannot stop someone reading client code, and
you should not try. You make the client worthless to fork by keeping
the value on the servers and binding marketplace access to a signature
the fork cannot produce.**

## Operator checklist

- `RELEASE_MANIFEST_SIGNING_SECRET` MUST be set on the production
  worker. If it is unset, `requireSignedClient` logs
  `[SECURITY] ... manifest verification is DISABLED` and fails OPEN
  (it cannot tell official from modified). Grep the worker tail for
  `[SECURITY]` after every deploy.
- CI's release workflow registers each published CLI build with the
  exec-token registry (`POST /v1/internal/register-build`). Confirm
  the step ran green in the release run.
- Run `bash scripts/verify-official-package.sh` on any machine where
  you want to confirm the installed CLI is the official artifact.

## Reporting

Security issues: open a private advisory on the dev repo, or contact
the maintainer directly. Do not file a public issue for an exploitable
finding.
