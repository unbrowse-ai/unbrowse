# Types Reference

All types are defined in `src/types/skill.ts` and re-exported from `src/types/index.ts`.

## SkillManifest

The core data structure. A skill represents a discovered set of API endpoints for a domain.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `skill_id` | string | Yes | Unique identifier |
| `version` | string | Yes | Semver version (auto-incremented on updates) |
| `schema_version` | string | Yes | Manifest schema version |
| `name` | string | Yes | Human-readable name (usually the domain) |
| `intent_signature` | string | Yes | Primary intent pattern |
| `domain` | string | Yes | Target domain |
| `subdomain` | string | No | Subdomain if applicable |
| `description` | string | Yes | Auto-generated description |
| `owner_type` | `"agent"` \| `"marketplace"` \| `"user"` | Yes | Who created the skill |
| `execution_type` | `"http"` \| `"browser-capture"` | Yes | How endpoints are executed |
| `auth_profile_ref` | string | No | Reference to stored auth credentials |
| `endpoints` | EndpointDescriptor[] | Yes | Discovered API endpoints |
| `lifecycle` | `"active"` \| `"deprecated"` \| `"disabled"` | Yes | Current lifecycle state |
| `created_at` | string | Yes | ISO timestamp |
| `updated_at` | string | Yes | ISO timestamp |
| `prev_version` | string | No | Previous version for changelog tracking |
| `intents` | string[] | No | Intent strings that contributed endpoints |
| `operation_graph` | SkillOperationGraph | No | Dependency graph over endpoints |
| `discovery_cost` | DiscoveryCost | No | Time/tokens spent discovering this skill |
| `indexer_id` | string | No | Agent ID of the original discoverer (Tier 1 attribution) |
| `contributors` | Contributor[] | No | Multi-contributor attribution for delta-based payments |
| `base_price_usd` | number | No | Per-execution price for paid skills |

### Example (Hacker News)

```json
{
  "skill_id": "tVNUVGxNNHDeiSaGAuG2-",
  "version": "1.14.0",
  "schema_version": "1",
  "name": "ycombinator.com",
  "domain": "ycombinator.com",
  "description": "API skill for ycombinator.com",
  "owner_type": "agent",
  "execution_type": "http",
  "lifecycle": "active",
  "created_at": "2026-04-01T06:34:07.703Z",
  "updated_at": "2026-04-01T18:24:09.829Z",
  "endpoints": [
    {
      "endpoint_id": "zEMaw43w_hM0lmm-hGjjE",
      "method": "GET",
      "url_template": "https://news.ycombinator.com/",
      "idempotency": "safe",
      "verification_status": "verified",
      "reliability_score": 1,
      "description": "Captured page artifact for search for javascript",
      "dom_extraction": true,
      "trigger_url": "https://news.ycombinator.com/"
    },
    {
      "endpoint_id": "1_dqv22t2InBzlHsGlpQW",
      "method": "GET",
      "url_template": "https://news.ycombinator.com/newest",
      "idempotency": "safe",
      "verification_status": "verified",
      "reliability_score": 1,
      "description": "Captured page artifact for get latest stories and comments",
      "dom_extraction": true,
      "trigger_url": "https://news.ycombinator.com/newest"
    }
  ],
  "operation_graph": {
    "generated_at": "2026-04-01T18:24:09.740Z",
    "entry_operation_ids": ["zEMaw43w_hM0lmm-hGjjE", "1_dqv22t2InBzlHsGlpQW"],
    "operations": [{ "..." : "see SkillOperationNode" }],
    "edges": []
  }
}
```

---

## EndpointDescriptor

Describes a single API endpoint within a skill.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `endpoint_id` | string | Yes | Unique identifier within the skill |
| `method` | `"GET"` \| `"POST"` \| `"PUT"` \| `"PATCH"` \| `"DELETE"` \| `"WS"` | Yes | HTTP method |
| `url_template` | string | Yes | URL with `{param}` placeholders |
| `description` | string | No | LLM-generated semantic description |
| `headers_template` | Record\<string, string\> | No | Default request headers |
| `query` | Record\<string, unknown\> | No | Default query parameters |
| `path_params` | Record\<string, string\> | No | Default values for path placeholders |
| `body_params` | Record\<string, unknown\> | No | Default body field placeholders |
| `body` | Record\<string, unknown\> | No | Full request body template |
| `csrf_plan` | CsrfPlan | No | CSRF token extraction strategy |
| `oauth_plan` | OAuthPlan | No | OAuth flow configuration |
| `idempotency` | `"safe"` \| `"unsafe"` | Yes | Whether the endpoint mutates state |
| `verification_status` | `"verified"` \| `"unverified"` \| `"failed"` \| `"pending"` \| `"disabled"` | Yes | Last verification result |
| `reliability_score` | number | Yes | 0-1 historical success rate |
| `last_verified_at` | string | No | ISO timestamp of last verification |
| `response_schema` | ResponseSchema | No | Inferred JSON schema of the response |
| `dom_extraction` | DomExtraction | No | DOM-based extraction config (selector, method, confidence) |
| `trigger_url` | string | No | Page URL to navigate to before intercepting this endpoint |
| `exec_strategy` | `"server"` \| `"trigger-intercept"` \| `"browser"` | No | Learned execution strategy |
| `semantic` | EndpointSemanticDescriptor | No | Rich semantic metadata |
| `search_form` | SearchFormSpec | No | Structured search form specification |

---

## EndpointSemanticDescriptor

LLM-augmented metadata describing what an endpoint does semantically.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `action_kind` | string | Yes | Action type: `"search"`, `"fetch"`, `"create"`, `"update"`, `"delete"`, `"timeline"`, `"trending"`, `"detail"` |
| `resource_kind` | string | Yes | Resource type: `"product"`, `"user"`, `"post"`, `"comment"`, `"event"`, `"listing"` |
| `description_in` | string | No | What inputs the endpoint requires |
| `description_out` | string | No | What the endpoint returns |
| `response_summary` | string | No | Compact field path summary (e.g., `"[].title, [].link, [].score"`) |
| `example_request` | unknown | No | Synthetic example request |
| `example_response_compact` | unknown | No | Synthetic compact example response |
| `example_fields` | string[] | No | Key field paths in the response |
| `requires` | OperationBinding[] | No | Input bindings (parameters this endpoint needs) |
| `provides` | OperationBinding[] | No | Output bindings (data this endpoint produces) |
| `negative_tags` | string[] | No | Tags indicating what this endpoint is NOT (e.g., `["ads"]`) |
| `confidence` | number | No | 0-1 confidence in semantic classification |
| `observed_at` | string | No | When this semantic was last observed |
| `sample_request_url` | string | No | Real URL from the capture that produced this endpoint |
| `auth_required` | boolean | No | Whether authentication is needed |

---

## SkillOperationGraph

A directed acyclic graph (DAG) modeling dependencies between endpoints. Used by the orchestrator to determine execution order when multiple endpoints need to be chained.

| Field | Type | Description |
|-------|------|-------------|
| `generated_at` | string | ISO timestamp |
| `entry_operation_ids` | string[] | Root operations with no unmet dependencies |
| `operations` | SkillOperationNode[] | All operations in the graph |
| `edges` | SkillOperationEdge[] | Data flow dependencies between operations |

### SkillOperationNode

| Field | Type | Description |
|-------|------|-------------|
| `operation_id` | string | Unique ID (usually same as endpoint_id) |
| `endpoint_id` | string | The endpoint this operation wraps |
| `method` | string | HTTP method |
| `url_template` | string | URL with placeholders |
| `trigger_url` | string? | Page URL for trigger-and-intercept |
| `action_kind` | string | Semantic action type |
| `resource_kind` | string | Semantic resource type |
| `description_in` | string? | Input description |
| `description_out` | string? | Output description |
| `response_summary` | string? | Compact field summary |
| `requires` | OperationBinding[] | What this operation needs as input |
| `provides` | OperationBinding[] | What this operation outputs |
| `confidence` | number | Semantic confidence score |
| `auth_required` | boolean? | Whether auth is needed |

### SkillOperationEdge

| Field | Type | Description |
|-------|------|-------------|
| `edge_id` | string | Unique edge ID |
| `from_operation_id` | string | Source operation (provides data) |
| `to_operation_id` | string | Target operation (requires data) |
| `binding_key` | string | The data key being passed |
| `kind` | `"dependency"` \| `"hint"` \| `"parent_child"` \| `"pagination"` \| `"auth"` | Edge type |
| `confidence` | number | Match confidence |

### OperationBinding

| Field | Type | Description |
|-------|------|-------------|
| `key` | string | Field name (e.g., `"user_id"`, `"query"`) |
| `semantic_type` | string | Semantic category (e.g., `"post_name"`, `"user_id"`) |
| `source` | `"url_template"` \| `"response"` \| `"body"` | Where the binding comes from/goes |
| `required` | boolean? | Whether the binding is mandatory |

---

## ExecutionTrace

Returned with every execution result. Contains timing, status, and diagnostic metadata.

| Field | Type | Description |
|-------|------|-------------|
| `trace_id` | string | Unique execution ID |
| `skill_id` | string | Which skill was used |
| `endpoint_id` | string | Which endpoint was executed |
| `started_at` | string | ISO timestamp |
| `completed_at` | string | ISO timestamp |
| `success` | boolean | Whether execution succeeded |
| `status_code` | number? | HTTP response status |
| `error` | string? | Error message if failed |
| `drift` | DriftResult? | Schema drift detection result |
| `schema_backfilled` | boolean? | Set when schema was inferred from response |
| `tokens_used` | number? | LLM tokens consumed |
| `tokens_saved` | number? | Tokens saved vs browser approach |
| `tokens_saved_pct` | number? | Percentage of tokens saved |
| `trace_version` | string? | Code hash + git SHA |

### DriftResult

Detects when an endpoint's response shape has changed from the recorded schema.

| Field | Type | Description |
|-------|------|-------------|
| `drifted` | boolean | Whether drift was detected |
| `added_fields` | string[] | New fields not in the original schema |
| `removed_fields` | string[] | Fields that disappeared |
| `type_changes` | Array\<{path, was, now}\> | Fields whose types changed |

---

## ResponseSchema

Inferred JSON schema of an endpoint's response. Built by sampling multiple responses.

| Field | Type | Description |
|-------|------|-------------|
| `type` | string | JSON type: `"object"`, `"array"`, `"string"`, `"number"`, `"boolean"` |
| `properties` | Record\<string, ResponseSchema\>? | Object properties (recursive) |
| `items` | ResponseSchema? | Array item schema |
| `required` | string[]? | Required property names |
| `anyOf` | ResponseSchema[]? | Union types |
| `inferred_from_samples` | number | How many response samples were used to build this schema |

---

## Lifecycle States

| State | Meaning | Scoring Impact |
|-------|---------|---------------|
| `active` | Verified within the last 6 hours | Full score |
| `deprecated` | Verification failures detected | Ranked lower, still usable |
| `disabled` | 3+ consecutive failures | Excluded from results |

Freshness decays as `1/(1+d/30)` where `d` is days since last verification.

---

## OrchestrationTiming

Performance breakdown returned with every resolve call.

| Field | Type | Description |
|-------|------|-------------|
| `search_ms` | number | Time spent searching marketplace |
| `get_skill_ms` | number | Time to fetch skill manifest |
| `execute_ms` | number | Time to execute the endpoint |
| `total_ms` | number | Total wall time |
| `source` | string | Which path was used: `"marketplace"`, `"live-capture"`, `"route-cache"`, etc. |
| `cache_hit` | boolean | Whether a cache was used |
| `candidates_found` | number | How many skills matched |
| `candidates_tried` | number | How many were attempted |
| `tokens_saved` | number | Tokens saved vs browser |
| `tokens_saved_pct` | number | Percentage saved |
| `response_bytes` | number | Response payload size |
