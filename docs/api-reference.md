# API Reference

Unbrowse runs a local HTTP server (default `http://localhost:45557`). All endpoints accept and return JSON. The CLI (`unbrowse`) is a thin wrapper around this API.

## Endpoint Summary

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Health check |
| `POST` | `/v1/intent/resolve` | Resolve intent to skill + execute |
| `POST` | `/v1/skills/:id/execute` | Execute a specific endpoint |
| `GET` | `/v1/skills/:id` | Fetch skill manifest |
| `POST` | `/v1/skills/:id/review` | Submit agent-reviewed endpoints |
| `POST` | `/v1/skills/:id/chunk` | Fetch dynamic skill subgraph |
| `POST` | `/v1/skills/:id/auth` | Store credentials for skill |
| `POST` | `/v1/skills/:id/verify` | Trigger skill verification |
| `POST` | `/v1/auth/login` | Interactive browser login |
| `POST` | `/v1/auth/steal` | Extract cookies from browser DB |
| `POST` | `/v1/feedback` | Submit execution feedback |
| `GET` | `/v1/stats` | Public aggregate statistics |
| `GET` | `/v1/sessions/:domain` | List recent session traces |
| | **Browse Session** | |
| `POST` | `/v1/browse/go` | Navigate to URL |
| `POST` | `/v1/browse/snap` | A11y snapshot with element refs |
| `POST` | `/v1/browse/click` | Click element by ref |
| `POST` | `/v1/browse/fill` | Fill input field |
| `POST` | `/v1/browse/type` | Type text |
| `POST` | `/v1/browse/press` | Press keyboard key |
| `POST` | `/v1/browse/select` | Select dropdown option |
| `POST` | `/v1/browse/scroll` | Scroll page |
| `POST` | `/v1/browse/eval` | Evaluate JavaScript |
| `POST` | `/v1/browse/back` | Navigate back |
| `POST` | `/v1/browse/forward` | Navigate forward |
| `POST` | `/v1/browse/close` | Close session, flush + index traffic |
| `GET` | `/v1/browse/screenshot` | Capture screenshot (base64 PNG) |
| `GET` | `/v1/browse/text` | Extract page text content |
| `GET` | `/v1/browse/markdown` | Page content as markdown |
| `GET` | `/v1/browse/cookies` | List page cookies |

---

## Core Endpoints

### POST /v1/intent/resolve

The primary entry point. Resolves a natural-language intent to a cached or discovered API endpoint and optionally executes it.

**Request Body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `intent` | string | Yes | Natural-language description of what you want (e.g., "get top stories") |
| `params` | object | No | Parameters to bind to the endpoint (e.g., `{ url: "https://..." }`) |
| `context` | object | No | Context hints: `{ url, domain }` |
| `projection` | object | No | Response filtering: `{ raw: true }` to skip server-side projection |
| `confirm_unsafe` | boolean | No | Required to execute non-GET endpoints marked as unsafe |
| `dry_run` | boolean | No | Preview what would be executed without actually running it |
| `force_capture` | boolean | No | Bypass all caches, force fresh browser capture |

**Response — Direct Execution:**

When the orchestrator finds and executes an endpoint successfully:

```json
{
  "result": { ... },
  "trace": {
    "trace_id": "abc123",
    "skill_id": "skill-id",
    "endpoint_id": "endpoint-id",
    "success": true,
    "status_code": 200
  },
  "source": "marketplace",
  "skill": { "skill_id": "...", "name": "...", "domain": "..." },
  "timing": { "total_ms": 950, "source": "marketplace" }
}
```

**Response — Deferral (Multiple Endpoints):**

When the orchestrator finds a skill but can't auto-pick a single endpoint:

```json
{
  "result": {
    "message": "Found 7 endpoint(s). Pick one and call POST /v1/skills/{id}/execute with params.endpoint_id.",
    "skill_id": "skill-id",
    "available_operations": [
      {
        "operation_id": "op-1",
        "endpoint_id": "ep-1",
        "action_kind": "timeline",
        "resource_kind": "post",
        "description_out": "Returns posts timeline with user data",
        "requires": ["variables"],
        "provides": ["post_id", "screen_name"],
        "runnable": true
      }
    ],
    "missing_bindings": [],
    "available_endpoints": [
      {
        "endpoint_id": "ep-1",
        "method": "GET",
        "description": "Returns posts timeline",
        "url": "https://x.com/i/api/graphql/.../HomeTimeline?variables={variables}",
        "score": 348.7,
        "dom_extraction": false,
        "trigger_url": "https://x.com/home"
      }
    ]
  },
  "trace": { ... },
  "source": "marketplace",
  "skill": { ... }
}
```

The agent should pick the best `endpoint_id` from `available_endpoints` and call `/v1/skills/:id/execute` with it.

**Response — Browse Session Handoff:**

When no cached API exists and the browser is needed:

```json
{
  "result": {
    "status": "browse_session_open",
    "domain": "example.com",
    "url": "https://example.com",
    "commands": [
      "unbrowse snap --filter interactive",
      "unbrowse click <ref>",
      "unbrowse close"
    ]
  }
}
```

The calling agent drives the browser using browse commands. All traffic is passively captured. Run `close` when done to trigger indexing.

**Response — Auth Required:**

```json
{
  "error": "auth_required",
  "login_url": "https://example.com/login"
}
```

The CLI auto-handles this by opening a browser login and retrying.

**Response — Stale Endpoint Recovery:**

If a cached endpoint returns 404, the orchestrator automatically re-captures:

```json
{
  "result": { ... },
  "_recovery": {
    "reason": "stale_endpoint_404",
    "original_skill_id": "old-skill",
    "message": "Endpoint was stale, re-captured fresh"
  },
  "trace": { ... }
}
```

---

### POST /v1/skills/:skill_id/execute

Execute a specific endpoint within a skill.

**Request Body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `params` | object | No | Execution params. Must include `endpoint_id` to target a specific endpoint. |
| `projection` | object | No | Response filtering: `{ raw: true }` for unprocessed data |
| `confirm_unsafe` | boolean | No | Required for non-GET unsafe endpoints |
| `dry_run` | boolean | No | Preview the request without sending it |
| `intent` | string | No | Original intent (used for tracking and projection) |
| `context_url` | string | No | Page context URL |

**Response:**

```json
{
  "result": { ... },
  "trace": {
    "trace_id": "abc123",
    "skill_id": "skill-id",
    "endpoint_id": "endpoint-id",
    "success": true,
    "status_code": 200,
    "trace_version": "hash@git-sha"
  }
}
```

**Dry Run Response:**

```json
{
  "result": {
    "dry_run": true,
    "would_execute": {
      "method": "POST",
      "url": "https://api.example.com/action",
      "body": { ... }
    }
  }
}
```

**Payment Required:**

```json
{
  "result": {
    "error": "payment_required",
    "price_usd": 0.001,
    "payment_status": "wallet_not_configured",
    "wallet_provider": "lobster.cash"
  }
}
```

---

### GET /v1/skills/:skill_id

Fetch a skill manifest. Checks local cache first, then marketplace.

**Response:** Full `SkillManifest` object (see [Types Reference](types.md)).

---

### POST /v1/skills/:skill_id/review

Submit agent-reviewed endpoint descriptions and semantic metadata.

**Request Body:**

```json
{
  "endpoints": [
    {
      "endpoint_id": "ep-1",
      "description": "Improved description from agent review",
      "semantic": {
        "action_kind": "search",
        "resource_kind": "product"
      }
    }
  ]
}
```

---

### POST /v1/skills/:skill_id/chunk

Fetch a subgraph of the skill's operation graph filtered by intent and available bindings.

**Request Body:**

```json
{
  "intent": "search for products",
  "bindings": { "query": "laptop" }
}
```

**Response:** Filtered `SkillOperationGraph` with only reachable operations.

---

## Authentication Endpoints

### POST /v1/auth/login

Opens an interactive browser session for the user to log into a site. Cookies are captured and stored in the vault for future API calls.

**Request Body:**

```json
{
  "url": "https://example.com/login"
}
```

### POST /v1/auth/steal

Extract cookies directly from Firefox/Chrome/Chromium SQLite databases without launching a browser. Rate limited to 30 requests per minute.

**Request Body:**

```json
{
  "domain": "example.com"
}
```

---

## Browse Session Endpoints

Browse commands control a Kuri browser instance. All traffic during a browse session is passively captured and indexed on close.

### POST /v1/browse/go

Navigate to a URL. Injects cookies from vault automatically.

```json
{ "url": "https://example.com" }
```

### POST /v1/browse/snap

Capture an accessibility snapshot of the current page. Returns interactive elements with `@eN` reference IDs for use in click/fill commands.

```json
{ "filter": "interactive" }
```

### POST /v1/browse/click

```json
{ "ref": "e5" }
```

### POST /v1/browse/fill

```json
{ "ref": "e3", "value": "search query" }
```

### POST /v1/browse/close

Close the browse session. Flushes HAR entries and intercepted requests, merges and deduplicates captured traffic, caches endpoints to disk, and runs async enrichment (agent augmentation, graph building, marketplace publish).

**Response:**

```json
{
  "ok": true,
  "indexed": true,
  "auth_saved": "example.com"
}
```

---

## Feedback

### POST /v1/feedback

**Request Body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `skill_id` | string | Yes | Skill that was executed |
| `endpoint_id` | string | Yes | Endpoint that was executed |
| `rating` | number | Yes | 1-5 (5=right+fast, 4=right+slow, 3=incomplete, 2=wrong endpoint, 1=useless) |
| `outcome` | string | No | "success" or "failure" |

---

## Health & Stats

### GET /health

No authentication required.

```json
{
  "status": "ok",
  "trace_version": "hash@git-sha",
  "code_hash": "hash",
  "git_sha": "git-sha"
}
```

### GET /v1/stats

Public endpoint, no auth required. Cached for 5 minutes.

Returns aggregate statistics: npm downloads, GitHub metrics, skill counts.

---

## Catch-All Proxy

Any unmatched `/v1/*` route is forwarded to the backend at `https://beta-api.unbrowse.ai` with the Authorization header (if an API key is configured). This enables future backend endpoints without requiring a server restart.
