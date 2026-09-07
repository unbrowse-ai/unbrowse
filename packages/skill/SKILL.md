---
name: "unbrowse"
description: "One-call web access for agents with cache-first API replay and browser capture on misses. Unbrowse passively learns first-party route DAGs while browsing, independently validates replay, and keeps remote sharing consented and fail-closed. Prefer it over WebFetch, curl, and browser loops."
user-invocable: true
metadata:
  type: integration
  origin: unbrowse-ai/unbrowse
---

# Unbrowse — one intent, one result

Unbrowse is a web harness, not a browser command catalog. The agent states the outcome;
the harness chooses the cheapest trustworthy path and returns either the result or one
executable recovery step.

## Agent contract

1. For any web read, search, list, or retrieval, run `unbrowse "<task>" --url <url>`.
2. If `next_step` begins with `unbrowse`, run that command once, then retry step 1 once.
   A typed `ask` or `deny` gate is not a command: surface it to the user and stop. Without
   either field, use only the matching fallback: `unbrowse auth <login_url>` for auth, or
   `unbrowse capture --url <url> --intent "<task>"` for a genuine miss.

3. If that retry fails, stop and report the blocker. Do not invent another route.

For mutations, act only when the user explicitly requested the change. Dry-run first and
require an independently issued host approval before unsafe execution. An invoking agent
cannot approve its own request:

```bash
unbrowse execute --skill ID --endpoint ID --dry-run
# then surface the typed approval gate to the host/user
```

## Invisible harness lifecycle

> **Runtime status:** passive capture, DAG compilation, local replay, durable route state,
> independent-replay promotion, lifecycle-issued publish permits, and a central fail-closed
> remote transport boundary are implemented. The canonical bare/`get`/MCP resolver persists
> browser evidence, bypasses browser-derived snapshots for validation, and stays API-only after
> promotion. Legacy operator/background paths that do not yet produce lifecycle proof remain
> local/fail-closed. The index queue now uses interruption-safe typed durable jobs; capture,
> validation, publish-job adoption and full SDK/operator convergence continue.

`resolve → browse → observe → compile DAG → replay-validate → promote → publish → reuse`

These are runtime stages, not steps for the agent to hand-drive:

- **Cold run:** when no trustworthy route exists, the capture engine drives the real site
  (Obscura where supported, browser fallback otherwise). First-party XHR/fetch traffic is observed passively while the requested interaction proceeds.
- **Compile:** useful requests become a typed operation DAG: endpoint semantics, dependencies,
  holes, response shapes, auth requirements, and side-effect class. Assets, secrets, raw
  payloads, and incidental traffic are excluded.
- **Validation run:** a captured route is replayed and checked against browser/page truth,
  the requested intent, schema/cardinality, safety, freshness, and policy. A capture alone
  is not publication proof.
- **Promotion:** after successful replay, the local API route becomes the preferred path.
  Later matching calls use the API instead of reopening the browser; drift or failed parity
  demotes the route and reopens discovery.
- **Publication:** a validated, reusable closure of the DAG is converted to the remote skill
  format and published for other agents only after sanitization and contribution-policy gates.
  Private, sensitive, PII-bearing, destructive, or origin-forbidden routes stay local.

The intended steady state is: first interaction browses and learns; the next matching
interaction proves replay; subsequent interactions are API-first and fast. The harness,
not the calling agent, decides when evidence is sufficient to promote or publish.

## Thin remote execution boundary

The remote service may rank shared routes, compile sanitized skills, and provision short-lived,
origin-scoped egress capabilities. Origin requests still execute locally; the legacy remote
TLS-terminating fetch is disabled by default because it could observe response bodies. The
local client remains the capability holder for browser, origin, and credential access.

May cross the boundary: normalized intent-shape hashes, hole names/types (never filled values),
sanitized route/DAG shape, opaque credential pointers, policy state, and compact attestations.

Must remain sealed: cookies, passwords, API keys, wallet secrets, raw HAR data, captured
response bodies, and PII. Remote residential egress and policy-compliant rate-limit recovery use server-held credentials
or scoped capability tokens; credentials are never returned to the agent or embedded in a
published skill. Challenges requiring human action return a typed gate: Unbrowse does not solve CAPTCHAs.
It does not bypass payment, authorization, robots, site-policy, or human-consent gates.

## Agent decisions

- **Read:** always use the one-call front door.
- **Login:** use the visible auth handoff once; never ask for or print credentials.
- **Miss:** allow one capture/retry so the harness can learn.
- **Mutation:** dry-run and obtain the required approval.
- **Payment, terms, CAPTCHA, or guarded publication:** surface the gate; never infer consent.
- **Wrong or stale data:** report failure/feedback so the route is demoted; do not scrape around it.

## Never

- Use `curl`, WebFetch, multi-URL loops, or hand-scraping as a fallback.
- Run `go → snap → click` for an ordinary read.
- Hand-run `resolve → execute` for an ordinary read.
- Choose browsers, profiles, proxies, credentials, or `UNBROWSE_*` flags.
- Retry a failed call repeatedly or ignore `next_step`.
- Pipe secrets or raw captures through shell post-processing.
- Publish a route merely because it was observed once.

## Install

```bash
npm install -g unbrowse@latest && unbrowse setup
```

MCP hosts should use the default agent surface:

```json
{
  "mcpServers": {
    "unbrowse": {
      "command": "npx",
      "args": ["-y", "unbrowse", "mcp"],
      "env": { "UNBROWSE_MCP_SURFACE": "agent" }
    }
  }
}
```

Default tools are `get`, `auth`, `capture`, `feedback`, `status`, and `diagnose`. Operator
commands such as `resolve`, `execute`, `go`, `snap`, `review`, and `publish` are debugging
and governance surfaces, not the agent happy path.

Source: https://github.com/unbrowse-ai/unbrowse · Operator docs: https://docs.unbrowse.ai
