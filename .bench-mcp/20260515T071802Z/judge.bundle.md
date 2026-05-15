# Bench-MCP judge bundle: 20260515T071802Z

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
- elapsed: 53s
- usage: {"input_tokens":282517,"cached_input_tokens":256640,"output_tokens":986,"reasoning_output_tokens":759}

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
  "session_id": "c632f1b8-47f0-40e6-b656-1b921db0dd2e",
  "url": "https://news.ycombinator.com/",
  "tab_id": "BBE001FFB52D663A12555175BE35216F",
  "auth_profile": "news.ycombinator.com",
  "auth_required": true,
  "auth_hint": "Page requires authentication. Visible Chrome opening for sign-in; cookies will save automatically. Retry unbrowse_go once you've logged in.",
  "login_window_opened": true,
  "autonomy": {
    "har_active": true,
    "streaming_publish_active": true,
    "attached_existing_chrome": false,
    "chrome_debug_url": "http://127.0.0.1:9222",
    "inspect_command": "unbrowse inspect --session c632f1b8-47f0-40e6-b656-1b921db0dd2e --pretty",
    "inspect_buffer": "GET http://127.0.0.1:6969/v1/browse/sessions/c632f1b8-47f0-40e6-b656-1b921db0dd2e/buffer",
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
- elapsed: 23s
- usage: {"input_tokens":88011,"cached_input_tokens":64128,"output_tokens":519,"reasoning_output_tokens":394}

### Tool calls

_no MCP tool calls_
### Final agent message

```
INTENT_NOT_SATISFIED: unbrowse_tools_unavailable
```

## 003_semantic_rank_https___www_reddit_com_r_singularity_

- lane: `semantic-rank`
- auth: `none`
- difficulty: `medium`
- strategy: `semantic-rank`
- intent: get singularity subreddit posts
- url: https://www.reddit.com/r/singularity/
- elapsed: 115s
- usage: {"input_tokens":636919,"cached_input_tokens":563072,"output_tokens":1787,"reasoning_output_tokens":1131}

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
  "session_id": "84f565d0-6e60-4f74-aa39-07ec73303391",
  "url": "https://www.reddit.com/r/singularity/",
  "tab_id": "D6756FB6B9A51F8848DA06B75C38B40B",
  "auth_profile": "reddit.com",
  "cookies_injected": 8,
  "autonomy": {
    "har_active": true,
    "streaming_publish_active": true,
    "attached_existing_chrome": false,
    "chrome_debug_url": "http://127.0.0.1:9222",
    "inspect_command": "unbrowse inspect --session 84f565d0-6e60-4f74-aa39-07ec73303391 --pretty",
    "inspect_buffer": "GET http://127.0.0.1:6969/v1/browse/sessions/84f565d0-6e60-4f74-aa39-07ec73303391/buffer",
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
  "session_id": "84f565d0-6e60-4f74-aa39-07ec73303391",
  "context": "confirm reddit singularity page loaded before close"
}
```

Result excerpt:
```
Diagnosis capture complete. Screenshot + context returned.

{
  "screenshot": "",
  "tab_id": "D6756FB6B9A51F8848DA06B75C38B40B",
  "diagnosis_context": "confirm reddit singularity page loaded before close",
  "status": {
    "error": "404 Not Found"
  }
}
```

#### 3. unbrowse_resolve (completed)

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
Resolve result. Impact: 22s saved (100% faster) • 29,999 tokens saved (100% less context) • $0.090 saved • browser avoided

{
  "trace": {
    "trace_id": "pwOH8repPEVrZ2brLuKNx",
    "skill_id": "4UEKwl84lHtgjBhV7BtXg",
    "endpoint_id": "",
    "started_at": "2026-05-15T07:19:42.190Z",
    "completed_at": "2026-05-15T07:19:42.190Z",
    "success": true,
    "session_id": "s9tmvp9fLZpGG9WUFwWpy",
    "step_index": 1,
    "state_hash": "291f45a739bbcf88714e7149",
    "candidate_count": 7,
    "api_call_count": 0,
    "tokens_used": 1,
    "tokens_saved": 29999,
    "tokens_saved_pct": 100
  },
  "result": {
    "message": "Found 7 endpoint(s). Pick one and call POST /v1/skills/4UEKwl84lHtgjBhV7BtXg/execute with params.endpoint_id.",
    "skill_id": "4UEKwl84lHtgjBhV7BtXg",
    "available_operations": [
      {
        "operation_id": "c8UquxzSOU_xMrbd62Mj4",
        "endpoint_id": "c8UquxzSOU_xMrbd62Mj4",
        "method": "GET",
        "action_kind": "detail",
        "resource_kind": "resource",
        "title": "detail resource",
        "url_template": "https://www.reddit.com/r/singularity/",
        "description_out": "Page content from www.reddit.com",
        "requires": [],
        "yields": [
          "resource_url",
          "resource_name"
        ],
        "proof_status": "no_proof",
        "runnable": true,
        "prefetch_get_operations": []
      },
      {
        "operation_id": "DuHOQGvIFj7NjYV598dot",
        "endpoint_id": "DuHOQGvIFj7NjYV598dot",
        "method": "GET",
        "action_kind": "list",
        "resource_kind": "post",
        "title": "list post",
        "url_template": "https://www.reddit.com/r/singularity/",
        "description_out": "Returns posts with link, url, and titles",
        "requires": [],
        "yields": [
          "post_url",
          "status_url",
          "tweet_url",
          "post_name",
          "status_name",
          "tweet_name"
        ],
        "proof_status": "no_proof",
        "runnable": true,
        "prefetch_get_operations": []
      }
    ],
    "workflow_dag": {
      "skill_id": "4UEKwl84lHtgjBhV7BtXg",
      "intent": "singularity subreddit posts",
      "missing_bindings": [],
      "suggested_next_operation_id": "c8UquxzSOU_xMrbd62Mj4",
      "operations": [
        {
          "operation_id": "c8UquxzSOU_xMrbd62Mj4",
          "endpoint_id": "c8UquxzSOU_xMrbd62Mj4",
          "method": "GET",
          "action_kind": "detail",
          "resource_kind": "resource",
          "title": "detail resource",
          "url_template": "https://www.reddit.com/r/singularity/",
          "description_out": "Page content from www.reddit.com",
          "requires": [],
          "yields": [
            "resource_url",
            "resource_name"
          ],
          "proof_status": "no_proof",
          "runnable": true,
          "prefetch_get_operations": []
        },
        {
          "operation_id": "DuHOQGvIFj7NjYV598dot",
          "endpoint_id": "DuHOQGvIFj7NjYV598dot",
          "method": "GET",
          "action_kind": "list",
          "resource_kind": "post",
          "title": "list post",
          "url_template": "https://www.reddit.com/r/singularity/",
          "description_out": "Returns posts with link, url, and titles",
          "requires": [],
          "yields": [
            "post_url",
            "status_url",
            "tweet_url",
            "post_name",
            "status_name",
            "tweet_name"
          ],
          "proof_status": "no_proof",
          "runnable": true,
          "prefetch_get_operations": []
        }
      ],
      "edges": []
    },
    "missing_bindings": [],
    "available_endpoints": [
      {
        "endpoint_id": "c8UquxzSOU_xMrbd62Mj4",
        "method": "GET",
        "description": "Page content from www.reddit.com",
        "description_source": "agent",
        "description_needs_review": false,
        "url": "https://www.reddit.com/r/singularity/",
        "score": 
…[truncated 8150 chars]
```

#### 4. unbrowse_execute (failed)

Arguments:
```json
{
  "skill": "4UEKwl84lHtgjBhV7BtXg",
  "endpoint": "c8UquxzSOU_xMrbd62Mj4",
  "url": "https://www.reddit.com/r/singularity/",
  "intent": "get singularity subreddit posts",
  "limit": 5
}
```

Result excerpt:
```
stale_endpoint

{
  "trace": {
    "trace_id": "IqY-ZAbbm2linlim_IwTf",
    "skill_id": "4UEKwl84lHtgjBhV7BtXg",
    "endpoint_id": "c8UquxzSOU_xMrbd62Mj4",
    "started_at": "2026-05-15T07:19:49.753Z",
    "completed_at": "2026-05-15T07:19:51.007Z",
    "success": false,
    "status_code": 403,
    "trace_version": "5d9ebf619c61@913209cf23bc",
    "decision_trace": [
      {
        "step": "probe",
        "method": "HEAD",
        "status": 200,
        "content_type": "text/html; charset=utf-8",
        "ms": 537
      },
      {
        "step": "decision",
        "strategy": "server",
        "reason": "probe 200 + html + dom_extraction recipe — server fetch + extract"
      },
      {
        "step": "server_fetch",
        "status": 403
      },
      {
        "step": "auth_recovery_retry",
        "status": 403
      }
    ],
    "error": "HTTP 403",
    "result": {
      "error": "stale_endpoint",
      "status_code": 403,
      "skill_id": "4UEKwl84lHtgjBhV7BtXg",
      "endpoint_id": "c8UquxzSOU_xMrbd62Mj4",
      "message": "Credentials were refreshed, but endpoint c8UquxzSOU_xMrbd62Mj4 still returned HTTP 403. Treat this marketplace route as stale and use browser capture for this task.",
      "next_step": "Use browser fallback: unbrowse go \"https://www.reddit.com/r/singularity/\", inspect with snap/text, then close to checkpoint and publish a fresh route.",
      "commands": [
        "unbrowse go \"https://www.reddit.com/r/singularity/\"",
        "unbrowse snap --filter interactive",
        "unbrowse text",
        "unbrowse close"
      ]
    }
  },
  "result": {
    "error": "stale_endpoint",
    "status_code": 403,
    "skill_id": "4UEKwl84lHtgjBhV7BtXg",
    "endpoint_id": "c8UquxzSOU_xMrbd62Mj4",
    "message": "Credentials were refreshed, but endpoint c8UquxzSOU_xMrbd62Mj4 still returned HTTP 403. Treat this marketplace route as stale and use browser capture for this task.",
    "next_step": "Use browser fallback: unbrowse go \"https://www.reddit.com/r/singularity/\", inspect with snap/text, then close to checkpoint and publish a fresh route.",
    "commands": [
      "unbrowse go \"https://www.reddit.com/r/singularity/\"",
      "unbrowse snap --filter interactive",
      "unbrowse text",
      "unbrowse close"
    ]
  },
  "decision_trace": [
    {
      "step": "probe",
      "method": "HEAD",
      "status": 200,
      "content_type": "text/html; charset=utf-8",
      "ms": 537
    },
    {
      "step": "decision",
      "strategy": "server",
      "reason": "probe 200 + html + dom_extraction recipe — server fetch + extract"
    },
    {
      "step": "server_fetch",
      "status": 403
    },
    {
      "step": "auth_recovery_retry",
      "status": 403
    }
  ]
}
```

#### 5. unbrowse_execute (failed)

Arguments:
```json
{
  "skill": "4UEKwl84lHtgjBhV7BtXg",
  "endpoint": "DuHOQGvIFj7NjYV598dot",
  "url": "https://www.reddit.com/r/singularity/",
  "intent": "get singularity subreddit posts",
  "limit": 5
}
```

Result excerpt:
```
stale_endpoint

{
  "trace": {
    "trace_id": "xFducLLBo9gPT_U1ST8o_",
    "skill_id": "4UEKwl84lHtgjBhV7BtXg",
    "endpoint_id": "DuHOQGvIFj7NjYV598dot",
    "started_at": "2026-05-15T07:20:00.951Z",
    "completed_at": "2026-05-15T07:20:02.160Z",
    "success": false,
    "status_code": 403,
    "trace_version": "5d9ebf619c61@913209cf23bc",
    "decision_trace": [
      {
        "step": "probe",
        "method": "HEAD",
        "status": 200,
        "content_type": "text/html; charset=utf-8",
        "ms": 387
      },
      {
        "step": "decision",
        "strategy": "server",
        "reason": "probe 200 + html + dom_extraction recipe — server fetch + extract"
      },
      {
        "step": "server_fetch",
        "status": 403
      },
      {
        "step": "auth_recovery_retry",
        "status": 403
      }
    ],
    "error": "HTTP 403",
    "result": {
      "error": "stale_endpoint",
      "status_code": 403,
      "skill_id": "4UEKwl84lHtgjBhV7BtXg",
      "endpoint_id": "DuHOQGvIFj7NjYV598dot",
      "message": "Credentials were refreshed, but endpoint DuHOQGvIFj7NjYV598dot still returned HTTP 403. Treat this marketplace route as stale and use browser capture for this task.",
      "next_step": "Use browser fallback: unbrowse go \"https://www.reddit.com/r/singularity/\", inspect with snap/text, then close to checkpoint and publish a fresh route.",
      "commands": [
        "unbrowse go \"https://www.reddit.com/r/singularity/\"",
        "unbrowse snap --filter interactive",
        "unbrowse text",
        "unbrowse close"
      ]
    }
  },
  "result": {
    "error": "stale_endpoint",
    "status_code": 403,
    "skill_id": "4UEKwl84lHtgjBhV7BtXg",
    "endpoint_id": "DuHOQGvIFj7NjYV598dot",
    "message": "Credentials were refreshed, but endpoint DuHOQGvIFj7NjYV598dot still returned HTTP 403. Treat this marketplace route as stale and use browser capture for this task.",
    "next_step": "Use browser fallback: unbrowse go \"https://www.reddit.com/r/singularity/\", inspect with snap/text, then close to checkpoint and publish a fresh route.",
    "commands": [
      "unbrowse go \"https://www.reddit.com/r/singularity/\"",
      "unbrowse snap --filter interactive",
      "unbrowse text",
      "unbrowse close"
    ]
  },
  "decision_trace": [
    {
      "step": "probe",
      "method": "HEAD",
      "status": 200,
      "content_type": "text/html; charset=utf-8",
      "ms": 387
    },
    {
      "step": "decision",
      "strategy": "server",
      "reason": "probe 200 + html + dom_extraction recipe — server fetch + extract"
    },
    {
      "step": "server_fetch",
      "status": 403
    },
    {
      "step": "auth_recovery_retry",
      "status": 403
    }
  ]
}
```

#### 6. unbrowse_feedback (completed)

Arguments:
```json
{
  "skill": "4UEKwl84lHtgjBhV7BtXg",
  "endpoint": "c8UquxzSOU_xMrbd62Mj4",
  "rating": 1,
  "outcome": "stale_endpoint",
  "diagnostics": {
    "status_code": 403,
    "intent": "get singularity subreddit posts"
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
  "skill": "4UEKwl84lHtgjBhV7BtXg",
  "endpoint": "DuHOQGvIFj7NjYV598dot",
  "rating": 1,
  "outcome": "stale_endpoint",
  "diagnostics": {
    "status_code": 403,
    "intent": "get singularity subreddit posts"
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
INTENT_NOT_SATISFIED: stale_endpoint
```

## 004_graphql_https___x_com_search_q_AI_agents_src_typed_query

- lane: `graphql`
- auth: `optional`
- difficulty: `hard`
- strategy: `graphql`
- intent: search tweets about AI agents
- url: https://x.com/search?q=AI+agents&src=typed_query
- elapsed: 116s
- usage: {"input_tokens":607182,"cached_input_tokens":549504,"output_tokens":1732,"reasoning_output_tokens":1231}

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
  "session_id": "490e27ea-8da7-4637-99fd-ff270456f47b",
  "url": "https://x.com/search?q=AI+agents&src=typed_query",
  "tab_id": "B081C4187D27C486359A0076B38FC7B6",
  "auth_profile": "x.com",
  "cookies_injected": 29,
  "autonomy": {
    "har_active": true,
    "streaming_publish_active": true,
    "attached_existing_chrome": false,
    "chrome_debug_url": "http://127.0.0.1:9222",
    "inspect_command": "unbrowse inspect --session 490e27ea-8da7-4637-99fd-ff270456f47b --pretty",
    "inspect_buffer": "GET http://127.0.0.1:6969/v1/browse/sessions/490e27ea-8da7-4637-99fd-ff270456f47b/buffer",
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
  "truncated": true,
  "reason": "payload_exceeded_wire_budget_after_diet",
  "budget_chars": 23976,
  "original_chars": 24417,
  "body_excerpt": "{\"trace\":{\"trace_id\":\"Qo8q4R82IAPQKzvjzPBV2\",\"skill_id\":\"jERQ-T3VPZ6YlAzWtedOx\",\"endpoint_id\":\"\",\"started_at\":\"2026-05-15T07:19:53.877Z\",\"completed_at\":\"2026-05-15T07:19:53.877Z\",\"success\":true,\"session_id\":\"JGk3JKWPF_YfenMvVytDg\",\"step_ind...[truncated 21847 chars]"
}
```

#### 3. unbrowse_execute (failed)

Arguments:
```json
{
  "skill": "jERQ-T3VPZ6YlAzWtedOx",
  "endpoint": "cCYqmmCK4hG3NmvQRZzNk",
  "url": "https://x.com/search?q=AI+agents&src=typed_query",
  "intent": "search tweets about AI agents",
  "limit": 3,
  "raw": true
}
```

Result excerpt:
```
endpoint_not_found

{
  "result": {
    "error": "endpoint_not_found",
    "message": "Endpoint cCYqmmCK4hG3NmvQRZzNk not found in skill jERQ-T3VPZ6YlAzWtedOx. Available: dkvaJdQMKD12odId3AHT5 ([GraphQL: HomeTimeline] Returns posts timeline wit), nIVMwNHkB9fatBjNfEdiQ ([GraphQL: useStoryTopicQuery] Returns topic detail), kATq0ZZs4jg24JOKa0tE- ([GraphQL: ExploreSidebar] Returns posts timeline w), 2M38AzABWEgJ6Rl58XpkT ([GraphQL: SidebarUserRecommendations] Returns user), JMORG6IkRkau1mZKQr6H4 ([GraphQL: PinnedTimelines] Returns message details), dK3jhrDz9FZUhVLeRDm7r ([GraphQL: ScheduledPromotionsQuery] Returns status), MRBiyh9jbwPxcFfGDgvI2 ([GraphQL: useVerifiedOrgFeatureHelperQuery] Return), gFswC8bDSTAwYMazXVAG7 ([GraphQL: useFetchProductSubscriptionsQuery] Retur), 1p6KmLS3lQl_4mOE48KlU ([GraphQL: UsersVerifiedAvatars] Returns user detai), 11QVAAUT0c-COkLjX2gAu ([GraphQL: DataSaverMode] Returns resource details ), TZEspfRqHfZHQfEq7kdZr ([GraphQL: CreatorStudioTabBarItemQuery] Returns re), 7auNct4383mghyDAt6_jj ([GraphQL: useVerifiedOrgIdentityVerificationConfig), GK4RgSEVKk1Tf-4-vviyx ([GraphQL: useSubscriptionsPaymentFailureQuery] Ret), _ty8XlOUOcsm3SawgW3HY ([GraphQL: IntercomStarterQuery] Returns resource d), uPGXM1MbOKyqCGeQTisrN ([GraphQL: xChatDmSettingsQuery] Returns setting de), cV2VFqyhN8CRKFL3YJux9 ([GraphQL: useDirectCallSetupQuery] Returns resourc), sfyL23f2jW1oeA8rGVrKP (Returns setting details), BTRm7olj1HlQreqyphq2d (Creates user), pz-g8SOqLTeFDG9LustK8 (Returns event details), b2kkJPBJUG-HH-Xz59GG- (Returns rendered page for \"search tweets about AI ), JjG4BHjS2wh7QB5TRX_vJ (Returns rendered page for \"search tweets about AI )",
    "available_endpoints": [
      {
        "endpoint_id": "dkvaJdQMKD12odId3AHT5",
        "description": "[GraphQL: HomeTimeline] Returns posts timeline with home, cursortype, and entrytype"
      },
      {
        "endpoint_id": "nIVMwNHkB9fatBjNfEdiQ",
        "description": "[GraphQL: useStoryTopicQuery] Returns topic details with story topic, ids, and category"
      },
      {
        "endpoint_id": "kATq0ZZs4jg24JOKa0tE-",
        "description": "[GraphQL: ExploreSidebar] Returns posts timeline with explore sidebar, key, and confirmation"
      },
      {
        "endpoint_id": "2M38AzABWEgJ6Rl58XpkT",
        "description": "[GraphQL: SidebarUserRecommendations] Returns user details with sidebar user recommendations, token, and url"
      },
      {
        "endpoint_id": "JMORG6IkRkau1mZKQr6H4",
        "description": "[GraphQL: PinnedTimelines] Returns message details with pinned timelines, reason, and content"
      },
      {
        "endpoint_id": "dK3jhrDz9FZUhVLeRDm7r",
        "description": "[GraphQL: ScheduledPromotionsQuery] Returns status with viewer, ids, and expires at msec"
      },
      {
        "endpoint_id": "MRBiyh9jbwPxcFfGDgvI2",
        "description": "[GraphQL: useVerifiedOrgFeatureHelperQuery] Returns resource details with verified organization processing status, viewer, and ids"
      },
      {
        "endpoint_id": "gFswC8bDSTAwYMazXVAG7",
        "description": "[GraphQL: useFetchProductSubscriptionsQuery] Returns product details with viewer v 2, charge interval, and timestamps"
      },
      {
        "endpoint_id": "1p6KmLS3lQl_4mOE48KlU",
        "description": "[GraphQL: UsersVerifiedAvatars] Returns user details with usersresults, is blue verified, and profile image shape"
      },
      {
        "endpoint_id": "11QVAAUT0c-COkLjX2gAu",
        "description": "[GraphQL: DataSaverMode] Returns resource details with viewer"
      },
      {
        "endpoint_id": "TZEspfRqHfZHQfEq7kdZr",
        "description": "[GraphQL: CreatorStudioTabBarItemQuery] Returns resource details with xpayments audience rewards tasks"
      },
      {
        "endpoint_id": "7auNct4383mghyDAt6_jj",
        "description": "[GraphQL: useVerifiedOrgIdentityVerificationConfigQuery] Returns config details with viewer v 2 and ids"
      },
      {
        "endpoint_
…[truncated 8049 chars]
```

#### 4. unbrowse_execute (failed)

Arguments:
```json
{
  "skill": "jERQ-T3VPZ6YlAzWtedOx",
  "endpoint": "b2kkJPBJUG-HH-Xz59GG-",
  "url": "https://x.com/search?q=AI+agents&src=typed_query",
  "intent": "search tweets about AI agents",
  "limit": 3,
  "raw": true
}
```

Result excerpt:
```
stale_endpoint

{
  "trace": {
    "trace_id": "aOBRXqQP_Focx5S3e2qOD",
    "skill_id": "jERQ-T3VPZ6YlAzWtedOx",
    "endpoint_id": "b2kkJPBJUG-HH-Xz59GG-",
    "started_at": "2026-05-15T07:20:43.231Z",
    "completed_at": "2026-05-15T07:20:44.806Z",
    "success": false,
    "status_code": 401,
    "trace_version": "5d9ebf619c61@913209cf23bc",
    "decision_trace": [
      {
        "step": "probe",
        "method": "HEAD",
        "status": 403,
        "ms": 500
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
      "ms": 500
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

#### 5. unbrowse_reflect (completed)

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
INTENT_NOT_SATISFIED: stale_endpoint
```

## 005_ssr_list_https___www_amazon_com_s_k_usb_c_cable

- lane: `ssr-list`
- auth: `none`
- difficulty: `hard`
- strategy: `ssr-list`
- intent: search amazon for usb-c cables
- url: https://www.amazon.com/s?k=usb-c+cable
- elapsed: 118s
- usage: {"input_tokens":992439,"cached_input_tokens":940416,"output_tokens":2162,"reasoning_output_tokens":1240}

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
  "session_id": "3fffc006-2067-4a19-b95f-2bb57284cfad",
  "url": "https://www.amazon.com/s?k=usb-c+cable",
  "tab_id": "C7AE38F330CA0AAF8E0AEEF5339E3F2D",
  "auth_profile": "amazon.com",
  "cookies_injected": 45,
  "autonomy": {
    "har_active": true,
    "streaming_publish_active": true,
    "attached_existing_chrome": false,
    "chrome_debug_url": "http://127.0.0.1:9222",
    "inspect_command": "unbrowse inspect --session 3fffc006-2067-4a19-b95f-2bb57284cfad --pretty",
    "inspect_buffer": "GET http://127.0.0.1:6969/v1/browse/sessions/3fffc006-2067-4a19-b95f-2bb57284cfad/buffer",
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
  "session_id": "3fffc006-2067-4a19-b95f-2bb57284cfad",
  "context": "confirm amazon search page loaded and not blocked before indexing"
}
```

Result excerpt:
```
Diagnosis capture complete. Screenshot + context returned.

{
  "screenshot": "",
  "tab_id": "C7AE38F330CA0AAF8E0AEEF5339E3F2D",
  "diagnosis_context": "confirm amazon search page loaded and not blocked before indexing",
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
  "limit": 5
}
```

Result excerpt:
```
Resolve result. Impact: browser avoided

{
  "trace": {
    "trace_id": "piyXnN6EvMQGl2qXHhXgh",
    "skill_id": "rdJt13g3B6fmAHnLrdUth",
    "endpoint_id": "",
    "started_at": "2026-05-15T07:21:42.868Z",
    "completed_at": "2026-05-15T07:21:42.868Z",
    "success": true,
    "session_id": "LVWjds04mEaUEe5CehCRW",
    "step_index": 1,
    "state_hash": "8a9fc3828785fb61dbbecfff",
    "candidate_count": 20,
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
        "All 23 cached endpoints failed intent relevance check"
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
        "score": -312.57242405082195,
        "agent_warning": "ranker scored ≤0; agent must judge whether this satisfies the intent"
      },
      {
        "endpoint_id": "jDyuVLraSP_mUvESsHdo8",
        "method": "GET",
        "url_template": "https://www.amazon.com/rd/uedata?rid={rid}&sid={sid}&rx={rx}",
        "description": "Returns resource details",
        "score": -324.46291398984863,
        "agent_warning": "ranker scored ≤0; agent must judge whether this satisfies the intent"
      },
      {
        "endpoint_id": "LjXtKYvKYLtXiTp-kW9NR",
        "method": "GET",
        "url_template": "https://aax-us-east-retail-direct.amazon.com/e/is/{is}/impb?b={b}&w={w}&bi={bi}",
        "description": "Returns resource details",
        "score": -484.48064935617174,
        "agent_warning": "ranker scored ≤0; agent must judge whether this satisfies the intent"
      },
      {
        "endpoint_id": "vwDSC1QguA7rJTTZTPA1b",
        "method": "GET",
        "url_template": "https://www.amazon.com/puff/content?data={data}",
        "description": "Returns resource details",
        "score": -524.4235429933806,
        "agent_warning": "ranker scored ≤0; agent must judge whether this satisfies the intent"
      },
      {
        "endpoint_id": "UG1nNCqSnAPlPyE73gm_F",
        "method": "GET",
        "url_template": "https://www.amazon.com/rufus/cl/render?ref={ref}",
        "description": "Returns resource details with <link rel, return to, and identity",
        "score": -526.5202541332811,
        "agent_warning": "ranker scored ≤0; agent must judge whether this satisfies the intent"
      }
    ],
    "available_operations": [
      {
        "endpoint_id": "9sqadk0zf9ej-1x421syy",
        "method": "GET",
        "url_template": "https://www.amazon.com/hz/rhf?currentPageType={currentPageType}&currentSubPageType={currentSubPageType}&excludeAsin=
…[truncated 6593 chars]
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
    "excludeAsin": "",
    "auditEnabled": "false",
    "previewCampaigns": "",
    "forceWidgets": "",
    "cardJSPresent": "false"
  },
  "limit": 3
}
```

Result excerpt:
```
Execution result. See _workflow_hints for required next steps.

{
  "trace": {
    "trace_id": "G82JaLFxAEsbfEb0l475Y",
    "skill_id": "rdJt13g3B6fmAHnLrdUth",
    "endpoint_id": "9sqadk0zf9ej-1x421syy",
    "started_at": "2026-05-15T07:21:49.176Z",
    "completed_at": "2026-05-15T07:21:50.143Z",
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
        "next_step": "Recipe replay returned a different HTTP status than the captured proven_recipe expected (status_changed: 200 → 400). The endpoint contract has shifted upstream; re-resolve with `--force-capture` to refresh the recipe against the current contract. (endpoint=9sqadk0zf9ej-1x421syy, url=https://www.amazon.com/s?k=usb-c+cable&currentPageType=Search&currentSubPageType=Search&excludeAsin=&fieldKeywords=usb-c+cable&keywords=usb-c+cable&search=usb-c+cable&auditEnabled=false&previewCampaigns=&forceWidgets=&searchAlias=aps&cardJSPresent=false)",
        "ms": 222
      },
      {
        "step": "probe",
        "method": "GET-1byte",
        "status": 400,
        "content_type": "text/html",
        "ms": 727
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

#### 5. unbrowse_execute (completed)

Arguments:
```json
{
  "skill": "rdJt13g3B6fmAHnLrdUth",
  "endpoint": "vwDSC1QguA7rJTTZTPA1b",
  "intent": "search amazon for usb-c cables",
  "url": "https://www.amazon.com/s?k=usb-c+cable",
  "params": {
    "data": "usb-c cable"
  },
  "limit": 3
}
```

Result excerpt:
```
Execution result. See _workflow_hints for required next steps.

{
  "trace": {
    "trace_id": "ixxouNUYkV_b2OQA_H8In",
    "skill_id": "rdJt13g3B6fmAHnLrdUth",
    "endpoint_id": "vwDSC1QguA7rJTTZTPA1b",
    "started_at": "2026-05-15T07:22:02.933Z",
    "completed_at": "2026-05-15T07:22:04.001Z",
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
        "next_step": "Recipe replay returned a different HTTP status than the captured proven_recipe expected (status_changed: 200 → 400). The endpoint contract has shifted upstream; re-resolve with `--force-capture` to refresh the recipe against the current contract. (endpoint=vwDSC1QguA7rJTTZTPA1b, url=https://www.amazon.com/s?k=usb-c+cable&data=usb-c+cable)",
        "ms": 297
      },
      {
        "step": "probe",
        "method": "GET-1byte",
        "status": 400,
        "content_type": "text/html",
        "ms": 821
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
    "error": "HTTP 400",
    "workflow_selected_bindings": [],
    "workflow_strategy": "server"
  },
  "result": "<html>\r\n<head><title>400 Request Header Or Cookie Too Large</title></head>\r\n<body>\r\n<center><h1>400 Bad Request</h1></center>\r\n<center>Request Header Or Cookie Too Large</center>\r\n<hr><center>Server</center>\r\n</body>\r\n</html>\r\n",
  "next_action": {
    "title": "Record feedback for this execution",
    "command": "unbrowse_feedback",
    "command_args": {
      "skill": "rdJt13g3B6fmAHnLrdUth",
      "endpoint": "vwDSC1QguA7rJTTZTPA1b"
    },
    "why": "Closes the trust loop and weights this endpoint in future resolves."
  },
  "_workflow_hints": {
    "next_step": "MANDATORY: call unbrowse_feedback with the skill and endpoint ids and a rating (5=right+fast, 4=right+slow, 3=incomplete, 2=wrong endpoint, 1=useless).",
    "reflect_when_done": "When the user-facing goal is complete (achieved, failed, partial), call unbrowse_reflect once with intent_status. Helps surface slow/broken paths to maintainers. Anonymous.",
    "feedback_skill": "rdJt13g3B6fmAHnLrdUth",
    "feedback_endpoint": "vwDSC1QguA7rJTTZTPA1b",
    "first_use_review_needed": true,
    "review_step": "After feedback, call unbrowse_review to write proper endpoint descriptions, then unbrowse_publish to share to marketplace.",
    "contribute": "If you learned something about this endpoint (required params, gotchas, best practices), call unbrowse_annotate to share it with other agents."
  }
}
```

#### 6. unbrowse_feedback (completed)

Arguments:
```json
{
  "skill": "rdJt13g3B6fmAHnLrdUth",
  "endpoint": "9sqadk0zf9ej-1x421syy",
  "rating": 1,
  "outcome": "execute_failed",
  "diagnostics": {
    "status_code": 400,
    "error": "HTTP 400",
    "reason": "Request Header Or Cookie Too Large; did not return amazon product listings"
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
  "endpoint": "vwDSC1QguA7rJTTZTPA1b",
  "rating": 1,
  "outcome": "execute_failed",
  "diagnostics": {
    "status_code": 400,
    "error": "HTTP 400",
    "reason": "Request Header Or Cookie Too Large; did not return amazon product listings"
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
