# Security Policy

## Reporting Vulnerabilities

If you think you've found a security issue in Unbrowse — the marketplace backend, the local CLI, the MCP server, the SKILL.md renderer, anything in this repo — please **do not file a public GitHub issue**.

Email **security@unbrowse.ai** (or DM @lekt8 on X) with:

- A short description of what's wrong and what an attacker can do with it.
- A reproducer if you have one (file paths, line numbers, a curl invocation, a published skill manifest, etc.).
- Whether you've already disclosed this anywhere else.

We'll acknowledge within 72 hours and aim to ship a fix within 14 days for HIGH/CRITICAL issues. We're a small team — if it's stuck, we'll tell you why. We don't pay bug bounties yet, but we credit reporters in the changelog unless you'd prefer to stay anonymous.

In-scope:

- The Cloudflare Worker backend (`backend/`) at `beta-api.unbrowse.ai` and `unbrowse-backend-staging.lewis-6d8.workers.dev`.
- The published `unbrowse` npm package and CLI.
- The MCP server.
- The SKILL.md renderer and anything served from `unbrowse.ai/<domain>`.
- Skill marketplace publish/resolve/execute flow, including credential handling, x402 settlement, and the sponsor-pay flow.

Out-of-scope:

- Issues in third-party dependencies that don't reach a sensitive code path here (please report upstream).
- Self-XSS / clickjacking on the marketing site without a credible privilege escalation.
- Captured browser traffic that the user themselves chose to publish.
- Anti-bot bypass discoveries (those are a feature, not a vulnerability).

## Trust Model — What Unbrowse Defends Against

A skill manifest published to the marketplace is **untrusted input** for every other agent that resolves it. The publisher controls every field. The validator and renderer enforce these invariants:

- **Endpoint URLs must use https or wss in production**, and the host must equal `skill.domain` or be a subdomain of it. RFC1918, loopback, link-local, numeric-encoded, and hex-encoded hosts are blocked.
- **Trust signals are server-owned.** `verification_status: "verified"` and `zk_proof.verified: true` (for non-commitment proofs) cannot be self-attested by an agent — they're downgraded to `pending` / `false` at admission. Only admins and the proof verifier may stamp them. See `docs/zk-proofs.md`.
- **Credential headers can't be published.** `Authorization`, `Cookie`, `Set-Cookie`, `X-CSRF-*`, `X-XSRF-*`, `X-API-Key`, `Proxy-Authorization`, and any value that looks like a `Bearer …` token are stripped from `headers_template` at admission.
- **Skills are owned by their first non-admin publisher.** Subsequent publishes from anyone else are rejected with HTTP 403.
- **The unbrowse client refuses to send cookies cross-host.** After path-param interpolation, if the resolved request host doesn't share a registrable domain with the pre-interpolation `epDomain`, cookies and auth headers are dropped before the fetch fires. WebSocket endpoints go through the same SSRF guard.
- **The SKILL.md renderer strips control chars, ANSI escapes, backticks, and CR/LF** from every interpolated publisher-controlled field, and drops `zk_proof` / `proof_summary` / `proof_status` from the public output.

If you find a way around any of these invariants, please report it.

## Out-of-Repo Trust Boundaries

Unbrowse intentionally does NOT yet protect against:

- A user setting `UNBROWSE_BACKEND_URL` to a malicious server. The CLI does not pin the backend hostname or verify a signed manifest on inbound responses; if you point it at attacker-controlled infrastructure, you've handed over the trust boundary.
- A compromised `unbrowse.ai` CDN. The suggested upgrade path is `curl -fsSL https://unbrowse.ai/install.sh | sh`. The npm tarball is not yet signed end-to-end.
- A leaked operator-side secret (`BLOG_PUBLISH_KEY`, `CASCADE_SIGNER_SECRET_KEY`, `RELEASE_MANIFEST_SIGNING_SECRET`). These are protected by `wrangler secret put`, not by the application; rotation is a manual operator task.

These are tracked as deferred work; if you have a credible attack against any of them, we still want to hear about it.

## Supported Versions

| Version            | Supported               |
| ------------------ | ----------------------- |
| Latest minor       | ✅                       |
| Previous minor     | ✅ (security fixes only) |
| Older              | ❌                       |

We ship rapidly. The "previous minor" window is roughly 30 days from the current release. If you're stuck on an older version because of a downstream pin, email us and we'll figure something out.

## See Also

- Latest comprehensive audit: `.superstack/security-reports/unbrowse-dev-2026-05-09.md`
- Trust signal scoping: `docs/zk-proofs.md`
- Marketplace publish admission: `backend/src/services/validator.ts`
- Cross-host credential binding: `src/execution/index.ts` (look for `assertSafeRequestUrl` and the post-interpolation host check)
