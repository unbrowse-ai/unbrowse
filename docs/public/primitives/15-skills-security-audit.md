# Skills security audit

## The rule

Every client surface that talks to the Unbrowse server (the CLI binary, the MCP server, the published skill manifest) passes `bash scripts/skills.sh` before any release ships. The audit checks two truths in one harness:

1. **PII is filtered at the client.** Cookies, auth headers, captcha tokens, raw response bodies, request-scoped session state are stripped client-side before any skill or telemetry row leaves the process.
2. **Only what's required reaches the server.** The outbound payload shape is the documented field set from `src/types/skill.ts`. Type drift between client and backend is itself a leak path; the audit catches it.

This is the PII discipline applied to the client/server boundary. Sanitize at the source, enforce parity at the destination, drift-check the contract between them.

## What it checks

| Layer | Check | Failure mode it catches |
|---|---|---|
| Client-side publish | `tests/sanitize-for-publish.test.ts` | `sanitizeForPublish` skipped or weakened — raw `headers_template` / `cookies_template` / response bodies in a published skill |
| Client-side extraction | `tests/extraction-sanitize-to-json.test.ts` | DOM-extracted JSON carrying PII (email, phone, address) into the marketplace |
| Client-side query strings | `tests/page-artifact-query-sanitize.test.ts` | self-referential URL params in page-artifact endpoints (own session id leaking into the template) |
| Client-side domain edges | `tests/sanitize-domain-edges.test.ts` | cross-domain leaks (subdomain-scoped data published under the wrong parent) |
| MCP telemetry | `tests/telemetry-sanitize.test.ts` | `sanitizeArgs` skipped on a tool call — raw arg values (which may carry credentials) written to the local session log |
| Server-side parity | `backend/tests/sanitize-parity.test.ts` | client and backend strip rules diverge — what one allows the other rejects |
| Server-side enforcement | `backend/tests/skills-publish-sanitization.test.ts` | backend accepts an unsanitized payload that bypassed the client check |
| Server-side mirror | `backend/tests/contract-mirror-strip-pii.test.ts` | contract mirror sync leaks PII to a cross-project sharing surface |
| Static publish-path | `grep` over `src/publish/`, `src/api/routes.ts`, `src/workflow/publish.ts` | a future code change introduces a raw-cookie / raw-header field that bypasses `sanitizeForPublish` |
| Type parity | `EndpointDescriptor` diff between `src/types/skill.ts` and `backend/src/types.ts` | drift between client outbound shape and backend acceptance shape — silent data leak path |

The script is `scripts/skills.sh`. Exit 0 means every check passed and the agent can ship. Exit 1 surfaces the failed checks; the agent reads the report and judges.

## What the audit never does

- Decide whether a specific field is PII. The strip rules live in `sanitizeForPublish` (`src/publish/sanitize.ts`) and `sanitizeArgs` (`src/telemetry/sanitize.ts`); the audit runs them. New fields require updating the strip rule, not the audit.
- Phone home. The audit is local-only; no network calls. The publish-sanitization test uses fixtures, not the live backend.
- Validate buyer privacy. The audit covers seller→server PII (what the seller's client sends about the user's browsing); buyer-side card/token privacy lives in the [Stripe x402 bridge](./14-stripe-x402-bridge.md) primitive.
- Block on cosmetic drift. The static `grep` matches concrete bad shapes (`headers_template: request.headers`, `cookies_template: document.cookie`); refactors that preserve the strip semantics pass.

## Composition

| Layer | Surface that benefits |
|---|---|
| Sanitization at source | seller's client never persists or transmits the user's session bytes |
| Server enforcement | even if a future client regresses, the backend re-strips |
| Type parity | client and backend agree on the field set; drift detected at commit time |
| Static grep | future code changes can't reintroduce a raw passthrough without the audit catching it |

The four layers compose: the same forbidden bytes are blocked four times. A failure of one layer is caught by the next. The audit makes all four observable in one command.

## Where it fits

`scripts/skills.sh` is the standing per-PR check. Run it locally before pushing; run it in CI on every PR; run it in `release-it` `before:init` once the standing-gate contract is bound. The release flow refuses to publish a client that fails the audit.

## What lives outside this primitive

- Buyer-side wallet privacy → [14-stripe-x402-bridge](./14-stripe-x402-bridge.md).
- The published-marketplace "no user-response data" rule → [05-user-response-never-contains](./05-user-response-never-contains.md).
- The cookie/credential vault never leaving the client → the vault itself lives at `~/.unbrowse/vault/`; the audit checks the publish path can't reference vault contents, not the vault's own integrity.
