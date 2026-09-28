# REST API

Base: `https://unbrowse.ai/api/v1`. Auth: `Authorization: Bearer <API key or OAuth token>`.
The authenticated principal decides the workspace; a caller-supplied workspace id is never
authority. MCP (`/mcp`) is an adapter over the same runs and authorization.

```
POST /runs                          { task | capability, targetUrl?, input?, interactionMode?, idempotency_key?, egress? }
GET  /runs/:id
POST /runs/:id/responses            { expected_state_revision, responses: [{ requirement_id, expected_revision, action, values }] }
POST /runs/:id/cancel
GET  /runs/:id/events
GET  /egress/:egressId               what a client-egress run waits for
POST /egress/:egressId               { requestId, response: { status, headers, body, bodyEncoding? } } | { requestId, error }
DELETE /egress/:egressId             abandon a client-egress run
POST /capabilities/search           { query }
GET  /capabilities/:id
GET  /skills
POST /learn                         { har | traces, goal?, title? } → learned.* capability
GET  /learned
GET  /learned/:id
GET  /learned/:id/harness.yaml
GET  /learned/:id/skill.md
POST /accounts/connections          { origin, username, password } → vault:// ref
POST /accounts/register             { origin, username } → generated password, vaulted
GET  /vault                         refs and audit, never secrets
GET  /logins                        saved logins as masked hints
POST /logins                        save or update one login per origin
POST /logins/remove                 { origin } | { ref }
POST /cookies                       { cookies: [{ domain, name, value, path?, secure?, expires? }] } → kept sessions
GET  /usage
GET  /me

Public (no auth):
GET  /sites?q=                      compiled sites in the public registry, with tool counts
GET  /sites/:host                   that site's tools and schemas
GET  /sites/:host/openapi.json      OpenAPI 3.1, one operation per tool
     /sites/:host/mcp               the site as its own MCP server
POST /sites/:host/call/:tool        run one tool (auth or x402)
```

The idempotency key goes in the body as `idempotency_key` or in an `Idempotency-Key` header; without
one the server makes its own, so a retried request starts a new run. Answers to `/responses` use
snake_case too (`requirement_id`, `expected_revision`).

## Client egress: run from your own IP

`POST /runs` with `"egress": "client"` sends the run's site requests through you, from your own IP.
Unbrowse still decides every request and reads every response; it never contacts the site itself
(no cloud browser, no proxy). Instead of calling the site it answers `202`:

```json
{ "status": "egress_required", "egressId": "eg_…",
  "requests": [{ "id": "rq_1", "method": "GET", "url": "https://…", "headers": { … },
                 "redirect": "manual", "curl": "curl -sS -i -X GET 'https://…' -H …" }] }
```

Send each request (the `curl` is ready to paste) and post the raw response to `/egress/:egressId`:
`{ "requestId": "rq_1", "response": { "status": 200, "headers": [["content-type","application/json"]], "body": "…" } }`.
Headers as `[name, value]` pairs keep repeated ones (`set-cookie`); the body is decoded (after
gzip/brotli), as text or base64 with `"bodyEncoding": "base64"`, up to 10 MB. With `redirect: "manual"`
return a 3xx as it came. If the request could not be sent (DNS, TLS, refused) post `{ requestId, error }`.
Each answer returns the next request (`egress_required` again) or the finished run, exactly as a
server-side run returns it. 120 s per request; billing is unchanged.

Errors: `{ "error": { "code": "…", "message": "…" } }` with an HTTP status. `402 quota_exceeded`
is returned before any upstream request once a workspace's monthly quota is used.

## x402

`POST /runs` and `POST /sites/:host/call/:tool` without credentials answer `402` with x402 v2
payment requirements (exact scheme, USDC with the current quoted price, and a Bazaar discovery extension with
the input and output schema). Retry with a `payment-signature` header; the payment settles only if
the run succeeds, and `payment-response` carries the receipt.

Neither the CLI nor `@unbrowse/sdk` signs x402 payments; use an x402-capable HTTP client.

Supported `@unbrowse/sdk` methods: see [sdk.md](sdk.md).
