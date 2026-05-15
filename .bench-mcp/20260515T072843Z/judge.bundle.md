# Bench-MCP judge bundle: 20260515T072843Z

This bundle distills an agentic bench run where each probe invokes a fresh codex session with the LOCAL unbrowse MCP server. Each probe is one full agent trajectory.

## How to judge

For each probe section:

1. Read the tool calls to see which endpoints the agent picked and what each returned.
2. Read the final agent message and compare it to the intent.
3. Render a verdict (per the schema in `harness/probes/MCP_JUDGE.md`) covering:
   - did the agent call resolve and execute via MCP?
   - did the picked endpoint match the intent and contextUrl entity?
   - did the response body contain the requested concrete data?
   - did the agent's final message quote real data or fabricate?

## 001_anchor_https___news_ycombinator_com_

- lane: `anchor`
- auth: `none`
- difficulty: `easy`
- strategy: `dom-artifact`
- intent: get top hacker news stories
- url: https://news.ycombinator.com/
- elapsed: 59s
- usage: {"input_tokens":453478,"cached_input_tokens":378368,"output_tokens":1311,"reasoning_output_tokens":996}

### Tool calls

#### 1. unbrowse_go (completed)

Arguments:
```json
{
  "url": "https://news.ycombinator.com/"
}
```

Result excerpt:
```
Live browse session opened.

{
  "ok": true,
  "session_id": "07666b81-daa5-4cce-b072-cd03b8770adc",
  "url": "https://news.ycombinator.com/",
  "tab_id": "6717E8123FDF867FF5D1860E898EAE54",
  "auth_profile": "news.ycombinator.com",
  "auth_required": true,
  "auth_hint": "Page requires authentication. Visible Chrome opening for sign-in; cookies will save automatically. Retry unbrowse_go once you've logged in.",
  "login_window_opened": true,
  "autonomy": {
    "har_active": true,
    "streaming_publish_active": true,
    "attached_existing_chrome": false,
    "chrome_debug_url": "http://127.0.0.1:9222",
    "inspect_command": "unbrowse inspect --session 07666b81-daa5-4cce-b072-cd03b8770adc --pretty",
    "inspect_buffer": "GET http://127.0.0.1:6969/v1/browse/sessions/07666b81-daa5-4cce-b072-cd03b8770adc/buffer",
    "marketplace_publish_enabled": true,
    "marketplace_publish_mode": "auto",
    "marketplace_publish_reason": "Background publish is allowed for this checkpoint."
  }
}
```

#### 2. unbrowse_reflect (completed)

Arguments:
```json
{
  "intent_status": "failed"
}
```

Result excerpt:
```
Reflection recorded.

{
  "ok": true,
  "recorded": true,
  "intent_status": "failed",
  "telemetry_enabled": true
}
```

### Final agent message

```
INTENT_NOT_SATISFIED: auth_required
```

## 002_anchor_https___github_com_search_q_anthropic_type_repositories

- lane: `anchor`
- auth: `none`
- difficulty: `medium`
- strategy: `dom-artifact`
- intent: search github repos
- url: https://github.com/search?q=anthropic&type=repositories
- elapsed: 139s
- usage: {"input_tokens":700327,"cached_input_tokens":629504,"output_tokens":1990,"reasoning_output_tokens":1265}

### Tool calls

#### 1. unbrowse_go (completed)

Arguments:
```json
{
  "url": "https://github.com/search?q=anthropic&type=repositories"
}
```

Result excerpt:
```
Live browse session opened.

{
  "ok": true,
  "session_id": "82cf231c-c96f-4e3f-9e79-97f34716fef7",
  "url": "https://github.com/search?q=anthropic&type=repositories",
  "tab_id": "6113BD3DCD46A3E7BE799EEFC725C7A5",
  "auth_profile": "github.com",
  "cookies_injected": 17,
  "autonomy": {
    "har_active": true,
    "streaming_publish_active": true,
    "attached_existing_chrome": false,
    "chrome_debug_url": "http://127.0.0.1:9222",
    "inspect_command": "unbrowse inspect --session 82cf231c-c96f-4e3f-9e79-97f34716fef7 --pretty",
    "inspect_buffer": "GET http://127.0.0.1:6969/v1/browse/sessions/82cf231c-c96f-4e3f-9e79-97f34716fef7/buffer",
    "marketplace_publish_enabled": true,
    "marketplace_publish_mode": "auto",
    "marketplace_publish_reason": "Background publish is allowed for this checkpoint."
  }
}
```

#### 2. unbrowse_go (completed)

Arguments:
```json
{
  "session_id": "82cf231c-c96f-4e3f-9e79-97f34716fef7",
  "url": "https://github.com/search?q=anthropic&type=repositories"
}
```

Result excerpt:
```
Live browse session opened.

{
  "ok": true,
  "session_id": "82cf231c-c96f-4e3f-9e79-97f34716fef7",
  "url": "https://github.com/search?q=anthropic&type=repositories",
  "tab_id": "6113BD3DCD46A3E7BE799EEFC725C7A5",
  "auth_profile": "github.com",
  "autonomy": {
    "har_active": true,
    "streaming_publish_active": true,
    "attached_existing_chrome": false,
    "chrome_debug_url": "http://127.0.0.1:9222",
    "inspect_command": "unbrowse inspect --session 82cf231c-c96f-4e3f-9e79-97f34716fef7 --pretty",
    "inspect_buffer": "GET http://127.0.0.1:6969/v1/browse/sessions/82cf231c-c96f-4e3f-9e79-97f34716fef7/buffer",
    "marketplace_publish_enabled": true,
    "marketplace_publish_mode": "auto",
    "marketplace_publish_reason": "Background publish is allowed for this checkpoint."
  }
}
```

#### 3. unbrowse_go (completed)

Arguments:
```json
{
  "session_id": "82cf231c-c96f-4e3f-9e79-97f34716fef7",
  "url": "https://github.com/search?q=anthropic&type=repositories"
}
```

Result excerpt:
```
Live browse session opened.

{
  "ok": true,
  "session_id": "82cf231c-c96f-4e3f-9e79-97f34716fef7",
  "url": "https://github.com/search?q=anthropic&type=repositories",
  "tab_id": "6113BD3DCD46A3E7BE799EEFC725C7A5",
  "auth_profile": "github.com",
  "autonomy": {
    "har_active": true,
    "streaming_publish_active": true,
    "attached_existing_chrome": false,
    "chrome_debug_url": "http://127.0.0.1:9222",
    "inspect_command": "unbrowse inspect --session 82cf231c-c96f-4e3f-9e79-97f34716fef7 --pretty",
    "inspect_buffer": "GET http://127.0.0.1:6969/v1/browse/sessions/82cf231c-c96f-4e3f-9e79-97f34716fef7/buffer",
    "marketplace_publish_enabled": true,
    "marketplace_publish_mode": "auto",
    "marketplace_publish_reason": "Background publish is allowed for this checkpoint."
  }
}
```

#### 4. unbrowse_resolve (completed)

Arguments:
```json
{
  "intent": "search github repos",
  "url": "https://github.com/search?q=anthropic&type=repositories",
  "limit": 5
}
```

Result excerpt:
```
Resolve result. Impact: 22s saved (100% faster) • 29,999 tokens saved (100% less context) • $0.090 saved • browser avoided

{
  "trace": {
    "trace_id": "dq_DNmSBKyK4JDO-Aa16R",
    "skill_id": "VcgCjZpSiWnEEiAKeh8pt",
    "endpoint_id": "",
    "started_at": "2026-05-15T07:31:22.366Z",
    "completed_at": "2026-05-15T07:31:22.366Z",
    "success": true,
    "session_id": "ZsbFkSyrXYSLohZ81RnSP",
    "step_index": 1,
    "state_hash": "371a2ef8af98454cdd8558bc",
    "candidate_count": 3,
    "api_call_count": 0,
    "tokens_used": 1,
    "tokens_saved": 29999,
    "tokens_saved_pct": 100
  },
  "result": {
    "message": "Found 3 endpoint(s). Pick one and call POST /v1/skills/VcgCjZpSiWnEEiAKeh8pt/execute with params.endpoint_id.",
    "skill_id": "VcgCjZpSiWnEEiAKeh8pt",
    "available_operations": [
      {
        "operation_id": "auycdnm2T4pV67srEul76",
        "endpoint_id": "auycdnm2T4pV67srEul76",
        "method": "GET",
        "action_kind": "search",
        "resource_kind": "resource",
        "title": "search resource",
        "url_template": "https://github.com/search/suggestions?query={query}&saved_searches={saved_searches}",
        "description_out": "Searches resources",
        "requires": [
          "query",
          "saved_searches"
        ],
        "yields": [
          "__typename"
        ],
        "proof_status": "no_proof",
        "runnable": true,
        "prefetch_get_operations": []
      },
      {
        "operation_id": "QvQYZWZp42C5v7VEMwczb",
        "endpoint_id": "QvQYZWZp42C5v7VEMwczb",
        "method": "GET",
        "action_kind": "search",
        "resource_kind": "form",
        "title": "search form",
        "url_template": "https://github.com/anthropics/anthropic-sdk-python",
        "description_out": "Searches forms with names, descriptions, and url",
        "requires": [],
        "yields": [
          "form_name",
          "form_url"
        ],
        "proof_status": "no_proof",
        "runnable": true,
        "prefetch_get_operations": []
      },
      {
        "operation_id": "awU2yZIWLAL9XWTDnkqKY",
        "endpoint_id": "awU2yZIWLAL9XWTDnkqKY",
        "method": "GET",
        "action_kind": "detail",
        "resource_kind": "resource",
        "title": "detail resource",
        "url_template": "https://avatars.githubusercontent.com/u/{u}?s={s}&v={v}",
        "description_out": "Returns resource details",
        "requires": [
          "u",
          "s",
          "v"
        ],
        "yields": [
          "__typename"
        ],
        "proof_status": "no_proof",
        "runnable": true,
        "prefetch_get_operations": []
      }
    ],
    "workflow_dag": {
      "skill_id": "VcgCjZpSiWnEEiAKeh8pt",
      "intent": "github repos",
      "missing_bindings": [],
      "suggested_next_operation_id": "auycdnm2T4pV67srEul76",
      "operations": [
        {
          "operation_id": "auycdnm2T4pV67srEul76",
          "endpoint_id": "auycdnm2T4pV67srEul76",
          "method": "GET",
          "action_kind": "search",
          "resource_kind": "resource",
          "title": "search resource",
          "url_template": "https://github.com/search/suggestions?query={query}&saved_searches={saved_searches}",
          "description_out": "Searches resources",
          "requires": [
            "query",
            "saved_searches"
          ],
          "yields": [
            "__typename"
          ],
          "proof_status": "no_proof",
          "runnable": true,
          "prefetch_get_operations": []
        },
        {
          "operation_id": "QvQYZWZp42C5v7VEMwczb",
          "endpoint_id": "QvQYZWZp42C5v7VEMwczb",
          "method": "GET",
          "action_kind": "search",
          "resource_kind": "form",
          "title": "search form",
          "url_template": "https://github.com/anthropics/anthropic-sdk-python",
          "description_out": "Searches forms with names, descriptions, and url",
          "requires": [],
          "yield
…[truncated 5711 chars]
```

#### 5. unbrowse_execute (failed)

Arguments:
```json
{
  "skill": "VcgCjZpSiWnEEiAKeh8pt",
  "endpoint": "auycdnm2T4pV67srEul76",
  "params": {
    "query": "anthropic",
    "saved_searches": "false"
  },
  "intent": "search github repos",
  "url": "https://github.com/search?q=anthropic&type=repositories",
  "limit": 5
}
```

Result excerpt:
```
Unable to connect. Is the computer able to access the url?

{
  "error": "Unable to connect. Is the computer able to access the url?"
}
```

#### 6. unbrowse_execute (completed)

Arguments:
```json
{
  "skill": "VcgCjZpSiWnEEiAKeh8pt",
  "endpoint": "QvQYZWZp42C5v7VEMwczb",
  "intent": "search github repos",
  "url": "https://github.com/search?q=anthropic&type=repositories",
  "limit": 5
}
```

Result excerpt:
```
Execution result. See _workflow_hints for required next steps.

{
  "trace": {
    "trace_id": "paHnpRO-f6AEgsDdKgnhI",
    "skill_id": "VcgCjZpSiWnEEiAKeh8pt",
    "endpoint_id": "QvQYZWZp42C5v7VEMwczb",
    "started_at": "2026-05-15T07:31:45.034Z",
    "completed_at": "2026-05-15T07:31:46.697Z",
    "success": true,
    "status_code": 200,
    "trace_version": "5d9ebf619c61@913209cf23bc",
    "decision_trace": [
      {
        "step": "probe",
        "method": "HEAD",
        "status": 200,
        "content_type": "text/html; charset=utf-8",
        "byte_length": 0,
        "ms": 777
      },
      {
        "step": "decision",
        "strategy": "server",
        "reason": "probe 200 + html + dom_extraction recipe — server fetch + extract"
      },
      {
        "step": "server_fetch",
        "status": 200
      }
    ],
    "result": [
      {
        "title": "repositories Search Results · anthropic",
        "heading_1": "Filter by",
        "heading_2": "Languages",
        "heading_3": "Advanced",
        "heading_4": "23.4k results",
        "heading_5": "mukul975/Anthropic-Cybersecurity-Skills",
        "heading_6": "mukul975/Anthropic-Cybersecurity-Skills",
        "heading_7": "anthropics/anthropic-sdk-python",
        "heading_8": "anthropics/anthropic-sdk-python",
        "heading_9": "anthropics/courses",
        "heading_10": "anthropics/courses",
        "heading_11": "anthropics/prompt-eng-interactive-tutorial",
        "heading_12": "anthropics/prompt-eng-interactive-tutorial",
        "heading_13": "anthropics/anthropic-sdk-typescript",
        "heading_14": "anthropics/anthropic-sdk-typescript",
        "heading_15": "Austin1serb/Anthropic-Leaked-Source-Code",
        "heading_16": "Austin1serb/Anthropic-Leaked-Source-Code",
        "heading_17": "anthropics/anthropic-sdk-go",
        "heading_18": "anthropics/anthropic-sdk-go",
        "heading_19": "datawhalechina/agent-skills-with-anthropic",
        "heading_20": "datawhalechina/agent-skills-with-anthropic",
        "heading_21": "anthropics/claude-plugins-official",
        "heading_22": "anthropics/claude-plugins-official",
        "heading_23": "stackblitz/bolt.new",
        "heading_24": "stackblitz/bolt.new",
        "heading_25": "Sponsor open source projects you depend on",
        "heading_26": "How can we improve search?",
        "heading_27": "Sponsor open source projects you depend on",
        "heading_28": "How can we improve search?",
        "link": "https://github.com/search?q=anthropic&type=code",
        "url": "https://github.com/search?q=anthropic&type=code",
        "image": "https://github.com/mukul975.png?size=40",
        "description": "Contributors are working behind the scenes to make open source better for everyone—give them the help and recognition they deserve.",
        "rating": "296"
      },
      {
        "title": "mukul975/Anthropic-Cybersecurity-Skills",
        "heading_1": "mukul975/Anthropic-Cybersecurity-Skills",
        "message": "mukul975/Anthropic-Cybersecurity-Skills",
        "link": "/mukul975/Anthropic-Cybersecurity-Skills",
        "url": "/mukul975/Anthropic-Cybersecurity-Skills",
        "image": "https://github.com/mukul975.png?size=40"
      },
      {
        "title": "mukul975/Anthropic-Cybersecurity-Skills",
        "heading_1": "mukul975/Anthropic-Cybersecurity-Skills",
        "message": "mukul975/Anthropic-Cybersecurity-Skills",
        "link": "/mukul975/Anthropic-Cybersecurity-Skills",
        "url": "/mukul975/Anthropic-Cybersecurity-Skills",
        "image": "https://github.com/mukul975.png?size=40"
      },
      {
        "title": "anthropics/anthropic-sdk-python",
        "heading_1": "anthropics/anthropic-sdk-python",
        "message": "anthropics/anthropic-sdk-python",
        "link": "/anthropics/anthropic-sdk-python",
        "url": "/anthropics/anthropic-sdk-python",
        "image": "https://github.com/anthropics.png?size=40"
      },
      {
        "title": "anthropics
…[truncated 8090 chars]
```

#### 7. unbrowse_feedback (completed)

Arguments:
```json
{
  "skill": "VcgCjZpSiWnEEiAKeh8pt",
  "endpoint": "QvQYZWZp42C5v7VEMwczb",
  "rating": 5,
  "outcome": "success",
  "diagnostics": {
    "intent": "search github repos",
    "contextUrl": "https://github.com/search?q=anthropic&type=repositories",
    "returned_repo": "mukul975/Anthropic-Cybersecurity-Skills"
  }
}
```

Result excerpt:
```
Feedback submitted.

{
  "ok": true,
  "avg_rating": 5
}
```

#### 8. unbrowse_reflect (completed)

Arguments:
```json
{
  "intent_status": "achieved"
}
```

Result excerpt:
```
Reflection recorded.

{
  "ok": true,
  "recorded": true,
  "intent_status": "achieved",
  "telemetry_enabled": true
}
```

### Final agent message

```
mukul975/Anthropic-Cybersecurity-Skills
```

## 003_semantic_rank_https___www_reddit_com_r_singularity_

- lane: `semantic-rank`
- auth: `none`
- difficulty: `medium`
- strategy: `semantic-rank`
- intent: get singularity subreddit posts
- url: https://www.reddit.com/r/singularity/
- elapsed: 72s
- usage: {"input_tokens":283006,"cached_input_tokens":241280,"output_tokens":971,"reasoning_output_tokens":701}

### Tool calls

#### 1. unbrowse_go (completed)

Arguments:
```json
{
  "url": "https://www.reddit.com/r/singularity/"
}
```

Result excerpt:
```
Live browse session opened.

{
  "ok": true,
  "session_id": "6ecb9540-c758-4db6-bf5f-335d0a663200",
  "url": "https://www.reddit.com/r/singularity/",
  "tab_id": "43F0DAE6B815F5930E8D942D8B62D1E7",
  "auth_profile": "reddit.com",
  "cookies_injected": 4,
  "autonomy": {
    "har_active": true,
    "streaming_publish_active": true,
    "attached_existing_chrome": false,
    "chrome_debug_url": "http://127.0.0.1:9222",
    "inspect_command": "unbrowse inspect --session 6ecb9540-c758-4db6-bf5f-335d0a663200 --pretty",
    "inspect_buffer": "GET http://127.0.0.1:6969/v1/browse/sessions/6ecb9540-c758-4db6-bf5f-335d0a663200/buffer",
    "marketplace_publish_enabled": true,
    "marketplace_publish_mode": "auto",
    "marketplace_publish_reason": "Background publish is allowed for this checkpoint."
  }
}
```

#### 2. unbrowse_resolve (completed)

Arguments:
```json
{
  "intent": "get singularity subreddit posts",
  "url": "https://www.reddit.com/r/singularity/",
  "limit": 5
}
```

Result excerpt:
```
Resolve result.

{
  "trace": {
    "trace_id": "dCto2I_ObSgb4-VdgC_85",
    "skill_id": "",
    "endpoint_id": "",
    "started_at": "2026-05-15T07:32:59.590Z",
    "completed_at": "2026-05-15T07:33:04.907Z",
    "success": false,
    "tokens_used": 186,
    "tokens_saved": 0,
    "tokens_saved_pct": 0
  },
  "result": {
    "status": "no_match",
    "tried": [
      "marketplace",
      "probe"
    ],
    "ms": 96,
    "probe_evidence": {
      "status": 200,
      "content_type": "text/html",
      "byte_length": 8438
    },
    "next_step": {
      "command": "unbrowse capture --url \"https://www.reddit.com/r/singularity/\" --intent \"get singularity subreddit posts\"",
      "est_ms": 8000,
      "creates_skill": true
    },
    "decision_trace": {
      "intent": "get singularity subreddit posts",
      "params": {
        "url": "https://www.reddit.com/r/singularity/"
      },
      "context": {
        "url": "https://www.reddit.com/r/singularity/"
      },
      "search_candidates": [],
      "autoexec_attempts": [],
      "query_intent": "singularity subreddit posts",
      "budget_race": {
        "budget_ms": 8000,
        "total_ms": 96,
        "tried": [
          {
            "name": "marketplace",
            "status": "deadline",
            "ms": 96
          },
          {
            "name": "probe",
            "status": "won",
            "ms": 96
          }
        ],
        "winner": "probe"
      }
    }
  }
}
```

#### 3. unbrowse_reflect (completed)

Arguments:
```json
{
  "intent_status": "failed"
}
```

Result excerpt:
```
Reflection recorded.

{
  "ok": true,
  "recorded": true,
  "intent_status": "failed",
  "telemetry_enabled": true
}
```

### Final agent message

```
INTENT_NOT_SATISFIED: publish_did_not_index
```

## 004_graphql_https___x_com_search_q_AI_agents_src_typed_query

- lane: `graphql`
- auth: `optional`
- difficulty: `hard`
- strategy: `graphql`
- intent: search tweets about AI agents
- url: https://x.com/search?q=AI+agents&src=typed_query
- elapsed: 65s
- usage: {"input_tokens":287505,"cached_input_tokens":238080,"output_tokens":1892,"reasoning_output_tokens":1418}

### Tool calls

#### 1. unbrowse_go (completed)

Arguments:
```json
{
  "url": "https://x.com/search?q=AI+agents&src=typed_query"
}
```

Result excerpt:
```
Live browse session opened.

{
  "ok": true,
  "session_id": "16fe02ef-c064-46e8-bc60-896a7edd6153",
  "url": "https://x.com/search?q=AI+agents&src=typed_query",
  "tab_id": "F5CDD24566E65BD036AAA1123817E39E",
  "auth_profile": "x.com",
  "cookies_injected": 17,
  "autonomy": {
    "har_active": true,
    "streaming_publish_active": true,
    "attached_existing_chrome": false,
    "chrome_debug_url": "http://127.0.0.1:9222",
    "inspect_command": "unbrowse inspect --session 16fe02ef-c064-46e8-bc60-896a7edd6153 --pretty",
    "inspect_buffer": "GET http://127.0.0.1:6969/v1/browse/sessions/16fe02ef-c064-46e8-bc60-896a7edd6153/buffer",
    "marketplace_publish_enabled": true,
    "marketplace_publish_mode": "auto",
    "marketplace_publish_reason": "Background publish is allowed for this checkpoint."
  }
}
```

#### 2. unbrowse_resolve (completed)

Arguments:
```json
{
  "intent": "search tweets about AI agents",
  "url": "https://x.com/search?q=AI+agents&src=typed_query",
  "limit": 5
}
```

Result excerpt:
```
Resolve result. Impact: 22s saved (100% faster) • 29,999 tokens saved (100% less context) • $0.090 saved • browser avoided

{
  "trace": {
    "trace_id": "-BlIjEyBE40ClUykTazbe",
    "skill_id": "jERQ-T3VPZ6YlAzWtedOx",
    "endpoint_id": "",
    "started_at": "2026-05-15T07:33:50.569Z",
    "completed_at": "2026-05-15T07:33:50.569Z",
    "success": true,
    "session_id": "YIq6zmnUpEACyjqqK7vPh",
    "step_index": 1,
    "state_hash": "1b3386253653720d93dbd57b",
    "candidate_count": 10,
    "api_call_count": 0,
    "tokens_used": 1,
    "tokens_saved": 29999,
    "tokens_saved_pct": 100
  },
  "result": {
    "message": "Found 10 endpoint(s). Pick one and call POST /v1/skills/jERQ-T3VPZ6YlAzWtedOx/execute with params.endpoint_id.",
    "skill_id": "jERQ-T3VPZ6YlAzWtedOx",
    "available_operations": [
      {
        "operation_id": "b2kkJPBJUG-HH-Xz59GG-",
        "endpoint_id": "b2kkJPBJUG-HH-Xz59GG-",
        "method": "GET",
        "action_kind": "search",
        "resource_kind": "page",
        "title": "search page",
        "url_template": "https://x.com/search?q={q}&src={src}",
        "description_out": "Returns rendered page for \"search tweets about AI agents\" on https://x.com/search?q=AI+agents&src=typed_query",
        "requires": [
          "q",
          "src"
        ],
        "yields": [],
        "proof_status": "no_proof",
        "runnable": true,
        "prefetch_get_operations": []
      },
      {
        "operation_id": "nIVMwNHkB9fatBjNfEdiQ",
        "endpoint_id": "nIVMwNHkB9fatBjNfEdiQ",
        "method": "GET",
        "action_kind": "detail",
        "resource_kind": "topic",
        "title": "detail topic",
        "url_template": "https://x.com/i/api/graphql/I3V_Tt32aTZdw7cBdKUJbg/useStoryTopicQuery?variables={variables}",
        "description_out": "[GraphQL: useStoryTopicQuery] Returns topic details with story topic, ids, and category",
        "requires": [
          "variables"
        ],
        "yields": [
          "id",
          "__typename",
          "topic_name",
          "trend_name",
          "rest_id",
          "img_url",
          "topic_id",
          "trend_id"
        ],
        "proof_status": "no_proof",
        "runnable": true,
        "prefetch_get_operations": []
      }
    ],
    "workflow_dag": {
      "skill_id": "jERQ-T3VPZ6YlAzWtedOx",
      "intent": "tweets about AI agents",
      "missing_bindings": [],
      "suggested_next_operation_id": "b2kkJPBJUG-HH-Xz59GG-",
      "operations": [
        {
          "operation_id": "b2kkJPBJUG-HH-Xz59GG-",
          "endpoint_id": "b2kkJPBJUG-HH-Xz59GG-",
          "method": "GET",
          "action_kind": "search",
          "resource_kind": "page",
          "title": "search page",
          "url_template": "https://x.com/search?q={q}&src={src}",
          "description_out": "Returns rendered page for \"search tweets about AI agents\" on https://x.com/search?q=AI+agents&src=typed_query",
          "requires": [
            "q",
            "src"
          ],
          "yields": [],
          "proof_status": "no_proof",
          "runnable": true,
          "prefetch_get_operations": []
        },
        {
          "operation_id": "nIVMwNHkB9fatBjNfEdiQ",
          "endpoint_id": "nIVMwNHkB9fatBjNfEdiQ",
          "method": "GET",
          "action_kind": "detail",
          "resource_kind": "topic",
          "title": "detail topic",
          "url_template": "https://x.com/i/api/graphql/I3V_Tt32aTZdw7cBdKUJbg/useStoryTopicQuery?variables={variables}",
          "description_out": "[GraphQL: useStoryTopicQuery] Returns topic details with story topic, ids, and category",
          "requires": [
            "variables"
          ],
          "yields": [
            "id",
            "__typename",
            "topic_name",
            "trend_name",
            "rest_id",
            "img_url",
            "topic_id",
            "trend_id"
          ],
          "proof_status": "no_proof",
          "runnable
…[truncated 8151 chars]
```

#### 3. unbrowse_execute (failed)

Arguments:
```json
{
  "skill": "jERQ-T3VPZ6YlAzWtedOx",
  "endpoint": "b2kkJPBJUG-HH-Xz59GG-",
  "intent": "search tweets about AI agents",
  "url": "https://x.com/search?q=AI+agents&src=typed_query",
  "params": {
    "q": "AI agents",
    "src": "typed_query"
  },
  "limit": 5
}
```

Result excerpt:
```
stale_endpoint

{
  "trace": {
    "trace_id": "jCY4C3XCddFcTlBsUYjdH",
    "skill_id": "jERQ-T3VPZ6YlAzWtedOx",
    "endpoint_id": "b2kkJPBJUG-HH-Xz59GG-",
    "started_at": "2026-05-15T07:33:56.366Z",
    "completed_at": "2026-05-15T07:33:57.927Z",
    "success": false,
    "status_code": 401,
    "trace_version": "5d9ebf619c61@913209cf23bc",
    "decision_trace": [
      {
        "step": "probe",
        "method": "HEAD",
        "status": 403,
        "ms": 470
      },
      {
        "step": "decision",
        "strategy": "server",
        "reason": "probe status 403 — fetch body for vendor-block classification"
      },
      {
        "step": "server_fetch",
        "status": 401
      },
      {
        "step": "auth_recovery_retry",
        "status": 401
      }
    ],
    "error": "HTTP 401",
    "result": {
      "error": "stale_endpoint",
      "status_code": 401,
      "skill_id": "jERQ-T3VPZ6YlAzWtedOx",
      "endpoint_id": "b2kkJPBJUG-HH-Xz59GG-",
      "message": "Credentials were refreshed, but endpoint b2kkJPBJUG-HH-Xz59GG- still returned HTTP 401. Treat this marketplace route as stale and use browser capture for this task.",
      "next_step": "Use browser fallback: unbrowse go \"https://x.com/search?q=AI+agents&src=typed_query\", inspect with snap/text, then close to checkpoint and publish a fresh route.",
      "commands": [
        "unbrowse go \"https://x.com/search?q=AI+agents&src=typed_query\"",
        "unbrowse snap --filter interactive",
        "unbrowse text",
        "unbrowse close"
      ]
    },
    "workflow_selected_bindings": [],
    "workflow_strategy": "server"
  },
  "result": {
    "error": "stale_endpoint",
    "status_code": 401,
    "skill_id": "jERQ-T3VPZ6YlAzWtedOx",
    "endpoint_id": "b2kkJPBJUG-HH-Xz59GG-",
    "message": "Credentials were refreshed, but endpoint b2kkJPBJUG-HH-Xz59GG- still returned HTTP 401. Treat this marketplace route as stale and use browser capture for this task.",
    "next_step": "Use browser fallback: unbrowse go \"https://x.com/search?q=AI+agents&src=typed_query\", inspect with snap/text, then close to checkpoint and publish a fresh route.",
    "commands": [
      "unbrowse go \"https://x.com/search?q=AI+agents&src=typed_query\"",
      "unbrowse snap --filter interactive",
      "unbrowse text",
      "unbrowse close"
    ]
  },
  "decision_trace": [
    {
      "step": "probe",
      "method": "HEAD",
      "status": 403,
      "ms": 470
    },
    {
      "step": "decision",
      "strategy": "server",
      "reason": "probe status 403 — fetch body for vendor-block classification"
    },
    {
      "step": "server_fetch",
      "status": 401
    },
    {
      "step": "auth_recovery_retry",
      "status": 401
    }
  ]
}
```

#### 4. unbrowse_execute (completed)

Arguments:
```json
{
  "skill": "jERQ-T3VPZ6YlAzWtedOx",
  "endpoint": "nIVMwNHkB9fatBjNfEdiQ",
  "intent": "search tweets about AI agents",
  "url": "https://x.com/search?q=AI+agents&src=typed_query",
  "params": {
    "rest_id": "AI agents",
    "limit": 5
  },
  "limit": 5
}
```

Result excerpt:
```
Execution result. See _workflow_hints for required next steps.

{
  "trace": {
    "trace_id": "FJUTKFzD_6MYazIL-E7fH",
    "skill_id": "jERQ-T3VPZ6YlAzWtedOx",
    "endpoint_id": "nIVMwNHkB9fatBjNfEdiQ",
    "started_at": "2026-05-15T07:34:07.112Z",
    "completed_at": "2026-05-15T07:34:08.462Z",
    "success": true,
    "status_code": 200,
    "trace_version": "5d9ebf619c61@913209cf23bc",
    "decision_trace": [
      {
        "step": "recipe_replay",
        "method": "GET",
        "status": 403,
        "match": false,
        "reason": "status_changed: 200 → 403",
        "next_step": "Recipe replay returned a different HTTP status than the captured proven_recipe expected (status_changed: 200 → 403). The endpoint contract has shifted upstream; re-resolve with `--force-capture` to refresh the recipe against the current contract. (endpoint=nIVMwNHkB9fatBjNfEdiQ, url=https://x.com/i/api/graphql/I3V_Tt32aTZdw7cBdKUJbg/useStoryTopicQuery?variables=%7B%22rest_id%22%3A%22For+You%22%2C%22limit%22%3A3%7D&rest_id=AI+agents&limit=5)",
        "ms": 209
      },
      {
        "step": "probe",
        "method": "GET-1byte",
        "status": 403,
        "content_type": "application/json",
        "byte_length": 109,
        "ms": 722
      },
      {
        "step": "decision",
        "strategy": "server",
        "reason": "probe status 403 — fetch body for vendor-block classification"
      },
      {
        "step": "server_fetch",
        "status": 200
      }
    ],
    "result": {
      "data": {
        "story_topic": {
          "id": "U3RvcnlUb3BpYzpGb3IgWW91",
          "stories": {
            "items": [
              {
                "trend_results": {
                  "id": "QWlUcmVuZFJlc3VsdHM6MjA1NTA1ODg5MjkxMzM2MTMwNw==",
                  "result": {
                    "__typename": "AiTrend",
                    "core": {
                      "category": "News",
                      "created_at_ms": 1778799195875,
                      "name": "MoonPay acquires Dawn Labs"
                    },
                    "id": "QWlUcmVuZDoyMDU1MDU4ODkyOTEzMzYxMzA3",
                    "post_count": "311",
                    "rest_id": "2055058892913361307",
                    "social_proof": [
                      {
                        "img_url": "https://pbs.twimg.com/profile_images/1960160835558338560/sEERrLNv_normal.jpg"
                      },
                      {
                        "img_url": "https://pbs.twimg.com/profile_images/1947473138880491520/Pl0YclUP_normal.jpg"
                      },
                      {
                        "img_url": "https://pbs.twimg.com/profile_images/1973036509449121792/ePaMAzyA_normal.jpg"
                      }
                    ]
                  }
                }
              },
              {
                "trend_results": {
                  "id": "QWlUcmVuZFJlc3VsdHM6MjA1NTA3NzI5MzQzNzkwNzI0NA==",
                  "result": {
                    "__typename": "AiTrend",
                    "core": {
                      "category": "Other",
                      "created_at_ms": 1778803582902,
                      "name": "MoonPay's Frequent Announcements Including DeFi Acquisitions and Expansions Generate Buzz on X"
                    },
                    "id": "QWlUcmVuZDoyMDU1MDc3MjkzNDM3OTA3MjQ0",
                    "post_count": "227",
                    "rest_id": "2055077293437907244",
                    "social_proof": [
                      {
                        "img_url": "https://pbs.twimg.com/profile_images/1960160835558338560/sEERrLNv_normal.jpg"
                      },
                      {
                        "img_url": "https://pbs.twimg.com/profile_images/1971304473529049088/xEh_AwCY_normal.jpg"
                      },
                      {
                        "img_url": "https://pbs.twimg.com/profile_images/1484521368154783751/zSVmRCgP_normal.jpg"
                      }
                   
…[truncated 6501 chars]
```

#### 5. unbrowse_feedback (completed)

Arguments:
```json
{
  "skill": "jERQ-T3VPZ6YlAzWtedOx",
  "endpoint": "nIVMwNHkB9fatBjNfEdiQ",
  "rating": 2,
  "outcome": "wrong_endpoint",
  "diagnostics": {
    "intent": "search tweets about AI agents",
    "reason": "Endpoint returned unrelated story topic trends instead of tweets/search results for AI agents."
  }
}
```

Result excerpt:
```
Feedback submitted.

{
  "ok": true,
  "avg_rating": 2
}
```

#### 6. unbrowse_reflect (completed)

Arguments:
```json
{
  "intent_status": "failed"
}
```

Result excerpt:
```
Reflection recorded.

{
  "ok": true,
  "recorded": true,
  "intent_status": "failed",
  "telemetry_enabled": true
}
```

### Final agent message

```
INTENT_NOT_SATISFIED: wrong_endpoint
```

## 005_ssr_list_https___www_amazon_com_s_k_usb_c_cable

- lane: `ssr-list`
- auth: `none`
- difficulty: `hard`
- strategy: `ssr-list`
- intent: search amazon for usb-c cables
- url: https://www.amazon.com/s?k=usb-c+cable
- elapsed: 102s
- usage: {"input_tokens":725663,"cached_input_tokens":685824,"output_tokens":2510,"reasoning_output_tokens":1682}

### Tool calls

#### 1. unbrowse_go (completed)

Arguments:
```json
{
  "url": "https://www.amazon.com/s?k=usb-c+cable"
}
```

Result excerpt:
```
Live browse session opened.

{
  "ok": true,
  "session_id": "2b02a02d-a719-47df-8271-37ed49198e14",
  "url": "https://www.amazon.com/s?k=usb-c+cable",
  "tab_id": "9B8542EA8EF45DE90806A22D107AE022",
  "auth_profile": "amazon.com",
  "cookies_injected": 45,
  "autonomy": {
    "har_active": true,
    "streaming_publish_active": true,
    "attached_existing_chrome": false,
    "chrome_debug_url": "http://127.0.0.1:9222",
    "inspect_command": "unbrowse inspect --session 2b02a02d-a719-47df-8271-37ed49198e14 --pretty",
    "inspect_buffer": "GET http://127.0.0.1:6969/v1/browse/sessions/2b02a02d-a719-47df-8271-37ed49198e14/buffer",
    "marketplace_publish_enabled": true,
    "marketplace_publish_mode": "auto",
    "marketplace_publish_reason": "Background publish is allowed for this checkpoint."
  }
}
```

#### 2. unbrowse_diagnose (completed)

Arguments:
```json
{
  "session_id": "2b02a02d-a719-47df-8271-37ed49198e14",
  "context": "confirm amazon search page loaded for usb-c cable probe before marketplace resolve"
}
```

Result excerpt:
```
Diagnosis capture complete. Screenshot + context returned.

{
  "screenshot": "",
  "tab_id": "9B8542EA8EF45DE90806A22D107AE022",
  "diagnosis_context": "confirm amazon search page loaded for usb-c cable probe before marketplace resolve",
  "status": {
    "error": "404 Not Found"
  }
}
```

#### 3. unbrowse_resolve (completed)

Arguments:
```json
{
  "intent": "search amazon for usb-c cables",
  "url": "https://www.amazon.com/s?k=usb-c+cable",
  "limit": 5,
  "raw": true
}
```

Result excerpt:
```
Resolve result. Impact: browser avoided

{
  "trace": {
    "trace_id": "vQlNIjcn8qDYMcqqnrLzn",
    "skill_id": "rdJt13g3B6fmAHnLrdUth",
    "endpoint_id": "",
    "started_at": "2026-05-15T07:35:20.060Z",
    "completed_at": "2026-05-15T07:35:20.060Z",
    "success": true,
    "session_id": "xio1kQYXUmeAYhqJu-pSz",
    "step_index": 1,
    "state_hash": "8a9fc3828785fb61dbbecfff",
    "candidate_count": 21,
    "api_call_count": 0,
    "tokens_used": 1,
    "tokens_saved": 0,
    "tokens_saved_pct": 0
  },
  "result": {
    "status": "resolve_hard_handoff",
    "message": "No cached API available for this intent on www.amazon.com. For SSR-rendered pages (search results in HTML, e.g. Amazon, Bing), try `unbrowse fetch https://www.amazon.com/s?k=usb-c+cable` to get the page HTML and extract client-side. Otherwise drive a browser session interactively (snap/click/fill).",
    "domain": "www.amazon.com",
    "suggested_next_action": "unbrowse fetch https://www.amazon.com/s?k=usb-c+cable",
    "commands": [
      "unbrowse fetch https://www.amazon.com/s?k=usb-c+cable",
      "unbrowse snap --filter interactive",
      "unbrowse click <ref>",
      "unbrowse fill <ref> <value>",
      "unbrowse press Enter",
      "unbrowse text",
      "unbrowse close"
    ],
    "diagnostic": {
      "confidence": 0,
      "top_reasoning": "No endpoints on www.amazon.com matched intent \"amazon for usb-c cables\"",
      "known_issues": [
        "All 24 cached endpoints failed intent relevance check"
      ],
      "endpoint_count": 0,
      "cache_source": "marketplace"
    },
    "available_endpoints": [
      {
        "endpoint_id": "9sqadk0zf9ej-1x421syy",
        "method": "GET",
        "url_template": "https://www.amazon.com/hz/rhf?currentPageType={currentPageType}&currentSubPageType={currentSubPageType}&excludeAsin={excludeAsin}&fieldKeywords={fieldKeywords}&k={k}&keywords={keywords}&search={search}&auditEnabled={auditEnabled}&previewCampaigns={previewCampaigns}&forceWidgets={forceWidgets}&searchAlias={searchAlias}&cardJSPresent={cardJSPresent}",
        "description": "Searches forms",
        "score": -312.59476893839224,
        "agent_warning": "ranker scored ≤0; agent must judge whether this satisfies the intent"
      },
      {
        "endpoint_id": "jDyuVLraSP_mUvESsHdo8",
        "method": "GET",
        "url_template": "https://www.amazon.com/rd/uedata?rid={rid}&sid={sid}&rx={rx}",
        "description": "Returns resource details",
        "score": -324.4900346818822,
        "agent_warning": "ranker scored ≤0; agent must judge whether this satisfies the intent"
      },
      {
        "endpoint_id": "LjXtKYvKYLtXiTp-kW9NR",
        "method": "GET",
        "url_template": "https://aax-us-east-retail-direct.amazon.com/e/is/{is}/impb?b={b}&w={w}&bi={bi}",
        "description": "Returns resource details",
        "score": -484.5070230391792,
        "agent_warning": "ranker scored ≤0; agent must judge whether this satisfies the intent"
      },
      {
        "endpoint_id": "vwDSC1QguA7rJTTZTPA1b",
        "method": "GET",
        "url_template": "https://www.amazon.com/puff/content?data={data}",
        "description": "Returns resource details",
        "score": -524.452285364297,
        "agent_warning": "ranker scored ≤0; agent must judge whether this satisfies the intent"
      },
      {
        "endpoint_id": "UG1nNCqSnAPlPyE73gm_F",
        "method": "GET",
        "url_template": "https://www.amazon.com/rufus/cl/render?ref={ref}",
        "description": "Returns resource details with <link rel, return to, and identity",
        "score": -526.5449227485817,
        "agent_warning": "ranker scored ≤0; agent must judge whether this satisfies the intent"
      }
    ],
    "available_operations": [
      {
        "endpoint_id": "9sqadk0zf9ej-1x421syy",
        "method": "GET",
        "url_template": "https://www.amazon.com/hz/rhf?currentPageType={currentPageType}&currentSubPageType={currentSubPageType}&excludeAsin={ex
…[truncated 6581 chars]
```

#### 4. unbrowse_execute (completed)

Arguments:
```json
{
  "skill": "rdJt13g3B6fmAHnLrdUth",
  "endpoint": "9sqadk0zf9ej-1x421syy",
  "intent": "search amazon for usb-c cables",
  "url": "https://www.amazon.com/s?k=usb-c+cable",
  "params": {
    "currentPageType": "Search",
    "currentSubPageType": "Search",
    "fieldKeywords": "usb-c cable",
    "k": "usb-c cable",
    "keywords": "usb-c cable",
    "search": "usb-c cable",
    "searchAlias": "aps",
    "auditEnabled": "true",
    "previewCampaigns": "false",
    "forceWidgets": "false",
    "cardJSPresent": "true",
    "excludeAsin": ""
  },
  "limit": 5,
  "raw": true
}
```

Result excerpt:
```
Execution result. See _workflow_hints for required next steps.

{
  "trace": {
    "trace_id": "ndDMOaoUuaAMC4V3hhT1U",
    "skill_id": "rdJt13g3B6fmAHnLrdUth",
    "endpoint_id": "9sqadk0zf9ej-1x421syy",
    "started_at": "2026-05-15T07:35:26.724Z",
    "completed_at": "2026-05-15T07:35:27.754Z",
    "success": false,
    "status_code": 400,
    "trace_version": "5d9ebf619c61@913209cf23bc",
    "decision_trace": [
      {
        "step": "recipe_replay",
        "method": "GET",
        "status": 400,
        "match": false,
        "reason": "status_changed: 200 → 400",
        "next_step": "Recipe replay returned a different HTTP status than the captured proven_recipe expected (status_changed: 200 → 400). The endpoint contract has shifted upstream; re-resolve with `--force-capture` to refresh the recipe against the current contract. (endpoint=9sqadk0zf9ej-1x421syy, url=https://www.amazon.com/s?k=usb-c+cable&currentPageType=Search&currentSubPageType=Search&excludeAsin=&fieldKeywords=usb-c+cable&keywords=usb-c+cable&search=usb-c+cable&auditEnabled=true&previewCampaigns=false&forceWidgets=false&searchAlias=aps&cardJSPresent=true)",
        "ms": 254
      },
      {
        "step": "probe",
        "method": "GET-1byte",
        "status": 400,
        "content_type": "text/html",
        "ms": 827
      },
      {
        "step": "decision",
        "strategy": "server",
        "reason": "probe status 400 + text/html — HEAD often rejected for non-browser UA, GET often succeeds"
      },
      {
        "step": "server_fetch",
        "status": 400
      }
    ],
    "error": "HTTP 400"
  },
  "result": "<html>\r\n<head><title>400 Request Header Or Cookie Too Large</title></head>\r\n<body>\r\n<center><h1>400 Bad Request</h1></center>\r\n<center>Request Header Or Cookie Too Large</center>\r\n<hr><center>Server</center>\r\n</body>\r\n</html>\r\n",
  "next_action": {
    "title": "Record feedback for this execution",
    "command": "unbrowse_feedback",
    "command_args": {
      "skill": "rdJt13g3B6fmAHnLrdUth",
      "endpoint": "9sqadk0zf9ej-1x421syy"
    },
    "why": "Closes the trust loop and weights this endpoint in future resolves."
  },
  "_workflow_hints": {
    "next_step": "MANDATORY: call unbrowse_feedback with the skill and endpoint ids and a rating (5=right+fast, 4=right+slow, 3=incomplete, 2=wrong endpoint, 1=useless).",
    "reflect_when_done": "When the user-facing goal is complete (achieved, failed, partial), call unbrowse_reflect once with intent_status. Helps surface slow/broken paths to maintainers. Anonymous.",
    "feedback_skill": "rdJt13g3B6fmAHnLrdUth",
    "feedback_endpoint": "9sqadk0zf9ej-1x421syy",
    "first_use_review_needed": true,
    "review_step": "After feedback, call unbrowse_review to write proper endpoint descriptions, then unbrowse_publish to share to marketplace.",
    "contribute": "If you learned something about this endpoint (required params, gotchas, best practices), call unbrowse_annotate to share it with other agents."
  }
}
```

#### 5. unbrowse_execute (failed)

Arguments:
```json
{
  "skill": "rdJt13g3B6fmAHnLrdUth",
  "endpoint": "jDyuVLraSP_mUvESsHdo8",
  "intent": "search amazon for usb-c cables",
  "url": "https://www.amazon.com/s?k=usb-c+cable",
  "params": {
    "rid": "",
    "sid": "",
    "rx": ""
  },
  "limit": 5,
  "raw": true
}
```

Result excerpt:
```
invalid_replay_params

{
  "trace": {
    "trace_id": "H54P4TQ69UavgBIxJaF4T",
    "skill_id": "rdJt13g3B6fmAHnLrdUth",
    "endpoint_id": "jDyuVLraSP_mUvESsHdo8",
    "started_at": "2026-05-15T07:35:42.837Z",
    "completed_at": "2026-05-15T07:35:42.857Z",
    "success": false,
    "error": "invalid_replay_params",
    "trace_version": "5d9ebf619c61@913209cf23bc"
  },
  "result": {
    "error": "invalid_replay_params",
    "message": "Replay parameters did not satisfy the published workflow contract.",
    "validation_errors": [
      {
        "name": "rid",
        "reason": "required"
      },
      {
        "name": "rx",
        "reason": "required"
      },
      {
        "name": "sid",
        "reason": "required"
      }
    ],
    "replay_contract": {
      "explicit_replay_only": true,
      "exposure_stage": "publish",
      "dependency_bindings": [
        "__typename",
        "rid",
        "rx",
        "sid"
      ],
      "search_terms": [
        "get",
        "https",
        "www.amazon.com",
        "rd",
        "uedata",
        "rid",
        "{rid}",
        "sid",
        "{sid}",
        "rx",
        "{rx}",
        "__typename",
        "data",
        "data.__typename"
      ],
      "parameter_specs": [
        {
          "name": "rid",
          "location": "path",
          "description": "Observed path parameter for GET https://www.amazon.com/rd/uedata?rid={rid}&sid={sid}&rx={rx}.",
          "type": "string",
          "required": true,
          "user_supplied": true,
          "source_hints": [
            {
              "source_kind": "path_template",
              "source_name": "rid",
              "confidence": 0.99
            },
            {
              "source_kind": "semantic_requires",
              "source_name": "rid",
              "confidence": 0.7
            }
          ]
        },
        {
          "name": "rx",
          "location": "path",
          "description": "Observed path parameter for GET https://www.amazon.com/rd/uedata?rid={rid}&sid={sid}&rx={rx}.",
          "type": "string",
          "required": true,
          "user_supplied": true,
          "source_hints": [
            {
              "source_kind": "path_template",
              "source_name": "rx",
              "confidence": 0.99
            },
            {
              "source_kind": "semantic_requires",
              "source_name": "rx",
              "confidence": 0.7
            }
          ]
        },
        {
          "name": "sid",
          "location": "path",
          "description": "Observed path parameter for GET https://www.amazon.com/rd/uedata?rid={rid}&sid={sid}&rx={rx}.",
          "type": "string",
          "required": true,
          "user_supplied": true,
          "source_hints": [
            {
              "source_kind": "path_template",
              "source_name": "sid",
              "confidence": 0.99
            },
            {
              "source_kind": "semantic_requires",
              "source_name": "sid",
              "confidence": 0.7
            }
          ]
        },
        {
          "name": "rid",
          "location": "query",
          "description": "Observed query parameter for GET https://www.amazon.com/rd/uedata?rid={rid}&sid={sid}&rx={rx}.",
          "type": "string",
          "required": false,
          "user_supplied": true,
          "default_value": "3G8ZKY242BV74CZ9MDYG",
          "example_value": "3G8ZKY242BV74CZ9MDYG",
          "source_hints": [
            {
              "source_kind": "query_default",
              "source_name": "rid",
              "confidence": 0.9
            },
            {
              "source_kind": "observed_query",
              "source_name": "rid",
              "confidence": 0.99
            }
          ]
        },
        {
          "name": "rx",
          "location": "query",
          "description": "Observed query parameter for GET https://www.amazon.com/rd/uedata?rid={rid}&sid={sid}
…[truncated 2672 chars]
```

#### 6. unbrowse_feedback (completed)

Arguments:
```json
{
  "skill": "rdJt13g3B6fmAHnLrdUth",
  "endpoint": "9sqadk0zf9ej-1x421syy",
  "rating": 1,
  "outcome": "http_400_wrong_endpoint",
  "diagnostics": {
    "intent": "search amazon for usb-c cables",
    "status_code": 400,
    "error": "HTTP 400"
  }
}
```

Result excerpt:
```
Feedback submitted.

{
  "ok": true,
  "avg_rating": 1
}
```

#### 7. unbrowse_feedback (completed)

Arguments:
```json
{
  "skill": "rdJt13g3B6fmAHnLrdUth",
  "endpoint": "jDyuVLraSP_mUvESsHdo8",
  "rating": 1,
  "outcome": "invalid_replay_params_wrong_endpoint",
  "diagnostics": {
    "intent": "search amazon for usb-c cables",
    "error": "invalid_replay_params"
  }
}
```

Result excerpt:
```
Feedback submitted.

{
  "ok": true,
  "avg_rating": 1
}
```

#### 8. unbrowse_reflect (completed)

Arguments:
```json
{
  "intent_status": "failed"
}
```

Result excerpt:
```
Reflection recorded.

{
  "ok": true,
  "recorded": true,
  "intent_status": "failed",
  "telemetry_enabled": true
}
```

### Final agent message

```
INTENT_NOT_SATISFIED: execute_failed
```
