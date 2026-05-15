# Bench-MCP judge bundle: 20260515T075125Z

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
- elapsed: 47s
- usage: {"input_tokens":311515,"cached_input_tokens":270336,"output_tokens":893,"reasoning_output_tokens":598}

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
  "error": "recoverable_browse_failure",
  "message": "Unable to connect. Is the computer able to access the url?",
  "recoverable": true
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
INTENT_NOT_SATISFIED: recoverable_browse_failure
```

## 002_anchor_https___github_com_search_q_anthropic_type_repositories

- lane: `anchor`
- auth: `none`
- difficulty: `medium`
- strategy: `dom-artifact`
- intent: search github repos
- url: https://github.com/search?q=anthropic&type=repositories
- elapsed: 74s
- usage: {"input_tokens":584095,"cached_input_tokens":522880,"output_tokens":1439,"reasoning_output_tokens":897}

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
  "session_id": "8e2d9839-7348-4fb1-ab45-2e3101a4b652",
  "url": "https://github.com/search?q=anthropic&type=repositories",
  "tab_id": "E0CDA2CAC4771B2355F4D03D926F07EA",
  "auth_profile": "github.com",
  "cookies_injected": 17,
  "autonomy": {
    "har_active": true,
    "streaming_publish_active": true,
    "attached_existing_chrome": false,
    "chrome_debug_url": "http://127.0.0.1:9222",
    "inspect_command": "unbrowse inspect --session 8e2d9839-7348-4fb1-ab45-2e3101a4b652 --pretty",
    "inspect_buffer": "GET http://127.0.0.1:6969/v1/browse/sessions/8e2d9839-7348-4fb1-ab45-2e3101a4b652/buffer",
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
    "trace_id": "k1ccngklDBIx1dz6yScRK",
    "skill_id": "VcgCjZpSiWnEEiAKeh8pt",
    "endpoint_id": "",
    "started_at": "2026-05-15T07:52:55.608Z",
    "completed_at": "2026-05-15T07:52:55.608Z",
    "success": true,
    "session_id": "H7MK2ZJT96Ghl50BS83Rr",
    "step_index": 1,
    "state_hash": "371a2ef8af98454cdd8558bc",
    "candidate_count": 9,
    "api_call_count": 0,
    "tokens_used": 1,
    "tokens_saved": 29999,
    "tokens_saved_pct": 100
  },
  "result": {
    "message": "Found 9 endpoint(s). Pick one and call POST /v1/skills/VcgCjZpSiWnEEiAKeh8pt/execute with params.endpoint_id.",
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
        "operation_id": "MXPENgpbc9TB7cU_K4jjQ",
        "endpoint_id": "MXPENgpbc9TB7cU_K4jjQ",
        "method": "GET",
        "action_kind": "detail",
        "resource_kind": "resource",
        "title": "detail resource",
        "url_template": "https://github.com/github-copilot/chat?skip_anchor={skip_anchor}",
        "description_out": "Returns resource details",
        "requires": [
          "skip_anchor"
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
          "operation_id": "MXPENgpbc9TB7cU_K4jjQ",
          "endpoint_id": "MXPENgpbc9TB7cU_K4jjQ",
          "method": "GET",
          "action_kind": "detail",
          "resource_kind": "resource",
          "title": "detail resource",
          "url_template": "https://github.com/github-copilot/chat?skip_anchor={skip_anchor}",
          "description_out": "Returns resource details",
          "requires": [
            "skip_anchor"
     
…[truncated 8150 chars]
```

#### 3. unbrowse_execute (failed)

Arguments:
```json
{
  "skill": "VcgCjZpSiWnEEiAKeh8pt",
  "endpoint": "auycdnm2T4pV67srEul76",
  "intent": "search github repos",
  "url": "https://github.com/search?q=anthropic&type=repositories",
  "params": {
    "query": "anthropic",
    "saved_searches": ""
  },
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

#### 4. unbrowse_execute (completed)

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
    "trace_id": "PRWUhlUcJzQnxKd4YMUPi",
    "skill_id": "VcgCjZpSiWnEEiAKeh8pt",
    "endpoint_id": "QvQYZWZp42C5v7VEMwczb",
    "started_at": "2026-05-15T07:53:11.202Z",
    "completed_at": "2026-05-15T07:53:13.134Z",
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
        "ms": 835
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

#### 5. unbrowse_feedback (completed)

Arguments:
```json
{
  "skill": "VcgCjZpSiWnEEiAKeh8pt",
  "endpoint": "QvQYZWZp42C5v7VEMwczb",
  "rating": 5,
  "outcome": "success"
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

#### 6. unbrowse_reflect (completed)

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
anthropics/anthropic-sdk-python
```

## 003_semantic_rank_https___www_reddit_com_r_singularity_

- lane: `semantic-rank`
- auth: `none`
- difficulty: `medium`
- strategy: `semantic-rank`
- intent: get singularity subreddit posts
- url: https://www.reddit.com/r/singularity/
- elapsed: 55s
- usage: {"input_tokens":246388,"cached_input_tokens":201984,"output_tokens":1107,"reasoning_output_tokens":891}

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
  "error": "recoverable_browse_failure",
  "message": "Unable to connect. Is the computer able to access the url?",
  "recoverable": true
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
INTENT_NOT_SATISFIED: browse_failure
```

## 004_graphql_https___x_com_search_q_AI_agents_src_typed_query

- lane: `graphql`
- auth: `optional`
- difficulty: `hard`
- strategy: `graphql`
- intent: search tweets about AI agents
- url: https://x.com/search?q=AI+agents&src=typed_query
- elapsed: 101s
- usage: {"input_tokens":770666,"cached_input_tokens":713088,"output_tokens":2041,"reasoning_output_tokens":1335}

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
  "session_id": "a677f1aa-b60d-4597-88d7-01653a5b614d",
  "url": "https://x.com/search?q=AI+agents&src=typed_query",
  "tab_id": "82DDD2D791B62699B08CD09E3D7733E8",
  "auth_profile": "x.com",
  "cookies_injected": 17,
  "autonomy": {
    "har_active": true,
    "streaming_publish_active": true,
    "attached_existing_chrome": false,
    "chrome_debug_url": "http://127.0.0.1:9222",
    "inspect_command": "unbrowse inspect --session a677f1aa-b60d-4597-88d7-01653a5b614d --pretty",
    "inspect_buffer": "GET http://127.0.0.1:6969/v1/browse/sessions/a677f1aa-b60d-4597-88d7-01653a5b614d/buffer",
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
  "session_id": "a677f1aa-b60d-4597-88d7-01653a5b614d",
  "context": "Confirm x.com search page loaded after cold capture for search tweets about AI agents"
}
```

Result excerpt:
```
Diagnosis capture complete. Screenshot + context returned.

{
  "screenshot": "",
  "tab_id": "82DDD2D791B62699B08CD09E3D7733E8",
  "diagnosis_context": "Confirm x.com search page loaded after cold capture for search tweets about AI agents",
  "status": {
    "error": "404 Not Found"
  }
}
```

#### 3. unbrowse_resolve (completed)

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
    "trace_id": "z4EGGPsWG7sjJ8MhEU-yp",
    "skill_id": "jERQ-T3VPZ6YlAzWtedOx",
    "endpoint_id": "",
    "started_at": "2026-05-15T07:55:30.866Z",
    "completed_at": "2026-05-15T07:55:30.866Z",
    "success": true,
    "session_id": "qoDfuoULEJ1rs2bg_BYDd",
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

#### 4. unbrowse_execute (failed)

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
    "trace_id": "dJj_IMcQQ2RQvEArF2aIe",
    "skill_id": "jERQ-T3VPZ6YlAzWtedOx",
    "endpoint_id": "b2kkJPBJUG-HH-Xz59GG-",
    "started_at": "2026-05-15T07:55:37.058Z",
    "completed_at": "2026-05-15T07:55:38.146Z",
    "success": false,
    "status_code": 401,
    "trace_version": "5d9ebf619c61@913209cf23bc",
    "decision_trace": [
      {
        "step": "probe",
        "method": "HEAD",
        "status": 403,
        "ms": 229
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
        "step": "4xx_live_session_fallback_no_session",
        "reason": "no_session_for_domain",
        "target_domain": "x.com",
        "active_domains": [
          "",
          "",
          "",
          "",
          "",
          "",
          "",
          ""
        ]
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
      "ms": 229
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
      "step": "4xx_live_session_fallback_no_session",
      "reason": "no_session_for_domain",
      "target_domain": "x.com",
      "active_domains": [
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        ""
      ]
    },
    {
      "step": "auth_recovery_retry",
      "status": 401
    }
  ]
}
```

#### 5. unbrowse_execute (completed)

Arguments:
```json
{
  "skill": "jERQ-T3VPZ6YlAzWtedOx",
  "endpoint": "nIVMwNHkB9fatBjNfEdiQ",
  "intent": "search tweets about AI agents",
  "url": "https://x.com/search?q=AI+agents&src=typed_query",
  "params": {
    "rest_id": "For You",
    "limit": 3
  },
  "limit": 3
}
```

Result excerpt:
```
Execution result. See _workflow_hints for required next steps.

{
  "trace": {
    "trace_id": "b0NiPRlJsAfR1eXbCyAGL",
    "skill_id": "jERQ-T3VPZ6YlAzWtedOx",
    "endpoint_id": "nIVMwNHkB9fatBjNfEdiQ",
    "started_at": "2026-05-15T07:55:51.432Z",
    "completed_at": "2026-05-15T07:55:52.473Z",
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
        "next_step": "Recipe replay returned a different HTTP status than the captured proven_recipe expected (status_changed: 200 → 403). The endpoint contract has shifted upstream; re-resolve with `--force-capture` to refresh the recipe against the current contract. (endpoint=nIVMwNHkB9fatBjNfEdiQ, url=https://x.com/i/api/graphql/I3V_Tt32aTZdw7cBdKUJbg/useStoryTopicQuery?variables=%7B%22rest_id%22%3A%22For+You%22%2C%22limit%22%3A3%7D&rest_id=For+You&limit=3)",
        "ms": 204
      },
      {
        "step": "probe",
        "method": "GET-1byte",
        "status": 403,
        "content_type": "application/json",
        "byte_length": 109,
        "ms": 674
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
                  "id": "QWlUcmVuZFJlc3VsdHM6MjA1NTE4OTkxMDYwMTIxNjE3MA==",
                  "result": {
                    "__typename": "AiTrend",
                    "core": {
                      "category": "Other",
                      "created_at_ms": 1778830432926,
                      "hook": "Imagine depositing dollars for a stablecoin, then watching issuers turn those reserves into billions from safe U.S. Treasury interest. It's the simple model fueling crypto's hottest business right now.",
                      "name": "Stablecoins Surge as Crypto's Top Money-Maker with Treasury Yields"
                    },
                    "id": "QWlUcmVuZDoyMDU1MTg5OTEwNjAxMjE2MTcw",
                    "post_count": "19",
                    "rest_id": "2055189910601216170",
                    "social_proof": [
                      {
                        "img_url": "https://pbs.twimg.com/profile_images/2043572395433414656/bmp0Mfpa_normal.jpg"
                      },
                      {
                        "img_url": "https://pbs.twimg.com/profile_images/2033292877682634752/lATldaUA_normal.jpg"
                      },
                      {
                        "img_url": "https://pbs.twimg.com/profile_images/2021368856485535744/HtNo5Kp9_normal.jpg"
                      }
                    ]
                  }
                }
              },
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
  
…[truncated 6655 chars]
```

#### 6. unbrowse_feedback (completed)

Arguments:
```json
{
  "skill": "jERQ-T3VPZ6YlAzWtedOx",
  "endpoint": "nIVMwNHkB9fatBjNfEdiQ",
  "rating": 2,
  "outcome": "wrong_endpoint",
  "diagnostics": {
    "intent": "search tweets about AI agents",
    "reason": "Endpoint returned For You trend topics, not search tweets for AI agents."
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

#### 7. unbrowse_reflect (completed)

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
- elapsed: 81s
- usage: {"input_tokens":244570,"cached_input_tokens":200960,"output_tokens":1069,"reasoning_output_tokens":829}

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
  "error": "recoverable_browse_failure",
  "message": "Unable to connect. Is the computer able to access the url?",
  "recoverable": true
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
INTENT_NOT_SATISFIED: browse_failure
```
