# The user response never contains these

## The rule

Specific classes of data never appear in any response that reaches the calling agent or end user, regardless of verbosity, debug flags, or error path.

This document lists those classes, names where the enforcement lives, and is tested on every PR.

## The list

| Class | Examples | Where the boundary is |
|---|---|---|
| Browser cookies | `Cookie:` header value, any cookie name=value pair from real Chrome or Firefox profiles | Captured at the redaction step in capture pipeline; never copied into trace responses; never logged at any verbosity |
| Authorization headers | `Authorization: Bearer <token>`, `X-Api-Key:`, `X-Auth-Token:` | Stripped at capture time before merge into endpoint manifest; replaced with provenance pointer |
| Vault keys | API keys stored in the local vault; the private wallet keys in `.env` files | Loaded only on demand from the named env or file; never serialized into any response payload |
| Residential proxy credentials | `IPROYAL_USER`, `IPROYAL_PASS`, `UNBROWSE_PROXY_URL` (when it contains user:pass) | Redacted at log line generation; replaced with `***@host:port` form before stderr write |
| Personal browser history | URLs visited that are not the one resolved in this session | Read-only access to Chrome/Firefox profile for cookie injection on the requested domain only; no enumeration |
| Personal disk paths | Any path under the user's home that is not the explicit working directory | Only the working directory is written to in trace responses |
| Platform identifiers | Internal contract row ids, organ ids, ledger event ids that govern Unbrowse's own self-organization | Filtered out of any response with `--audience public` semantic; documented at the contract leak gate |

## Where the enforcement lives

The capture pipeline (`src/capture/index.ts` and `src/reverse-engineer/index.ts`) strips sensitive headers at extraction time:

- `STRIP_HEADERS` (set of exact header names)
- `STRIP_HEADER_PREFIXES` (prefixes for vendor-specific auth headers)
- `SENSITIVE_HEADER_PATTERN` (regex catch-all for `*token*`, `*secret*`, `*key*`, `*auth*` names not on the safe-list)
- `isSensitiveHeader(name)` (called at every header serialization point)
- `isReplayCriticalHeader(name, value)` (the inverse: keep only the headers needed for replay)

The kuri-proxy bridge (`src/env/kuri-proxy-bridge.ts`) redacts the proxy URL before writing to stderr.

The contract-leak gate (`scripts/check-contract-leak.sh`) runs on every commit and blocks the merge when any public surface (README, CHANGELOG, frontend, docs) mentions an internal platform id or vocabulary.

## The test (the gate that keeps us honest)

`tests/no-user-response-leak.test.ts` runs a fixture set of:

1. A canonical resolve response with cookies present in the working profile.
2. A canonical execute response that hits a 401 and falls through to auth recovery.
3. A canonical capture trace with auth headers present in the original request.
4. A `[kuri-proxy] wired` log line with `IPROYAL_*` env set.
5. An MCP tool response from the most-visited handlers.

The test asserts none of the five outputs contains any string matching: a Cookie header value, an `Authorization:` value, an `IPROYAL_USER` value, an `IPROYAL_PASS` value, a known vault key pattern, or an 8-character hex contract id.

When the test fails on a PR, the merge blocks until the leak source is fixed.

## What this lets the user trust

The Unbrowse client source is public. Anyone can read what the binary does. The classes above are the things they need to know never travel from their machine to anyone else's, regardless of which command they ran.
