# Bench-MCP judge bundle: 20260515T070622Z

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
- elapsed: 31s
- usage: {"input_tokens":119363,"cached_input_tokens":90624,"output_tokens":506,"reasoning_output_tokens":354}

### Tool calls

#### 1. unbrowse_resolve (completed)

Arguments:
```json
{
  "intent": "get top hacker news stories",
  "url": "https://news.ycombinator.com/",
  "limit": 5,
  "raw": true
}
```

Result excerpt:
```
Resolve result.

{
  "trace": {
    "trace_id": "qazVZxz0Nl1HYb90giXwJ",
    "skill_id": "",
    "endpoint_id": "",
    "started_at": "2026-05-15T07:06:38.615Z",
    "completed_at": "2026-05-15T07:06:45.048Z",
    "success": false,
    "tokens_used": 177,
    "tokens_saved": 0,
    "tokens_saved_pct": 0
  },
  "result": {
    "status": "no_match",
    "tried": [
      "marketplace",
      "probe"
    ],
    "ms": 900,
    "probe_evidence": {
      "status": 200,
      "content_type": "text/html; charset=utf-8"
    },
    "next_step": {
      "command": "unbrowse capture --url \"https://news.ycombinator.com/\" --intent \"get top hacker news stories\"",
      "est_ms": 8000,
      "creates_skill": true
    },
    "decision_trace": {
      "intent": "get top hacker news stories",
      "params": {
        "url": "https://news.ycombinator.com/"
      },
      "context": {
        "url": "https://news.ycombinator.com/"
      },
      "search_candidates": [],
      "autoexec_attempts": [],
      "query_intent": "top hacker news stories",
      "budget_race": {
        "budget_ms": 8000,
        "total_ms": 900,
        "tried": [
          {
            "name": "marketplace",
            "status": "deadline",
            "ms": 900
          },
          {
            "name": "probe",
            "status": "won",
            "ms": 900
          }
        ],
        "winner": "probe"
      }
    }
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
INTENT_NOT_SATISFIED: no_cached_match
```

## 002_anchor_https___github_com_search_q_anthropic_type_repositories

- lane: `anchor`
- auth: `none`
- difficulty: `medium`
- strategy: `dom-artifact`
- intent: search github repos
- url: https://github.com/search?q=anthropic&type=repositories
- elapsed: 20s
- usage: {"input_tokens":80117,"cached_input_tokens":59008,"output_tokens":510,"reasoning_output_tokens":424}

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
- elapsed: 23s
- usage: {"input_tokens":119155,"cached_input_tokens":88576,"output_tokens":657,"reasoning_output_tokens":509}

### Tool calls

#### 1. unbrowse_resolve (completed)

Arguments:
```json
{
  "intent": "get singularity subreddit posts",
  "url": "https://www.reddit.com/r/singularity/",
  "limit": 5,
  "raw": true
}
```

Result excerpt:
```
Resolve result.

{
  "trace": {
    "trace_id": "lvevEDIoUXbtIM5AyzY1o",
    "skill_id": "",
    "endpoint_id": "",
    "started_at": "2026-05-15T07:06:58.331Z",
    "completed_at": "2026-05-15T07:06:58.931Z",
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
    "ms": 77,
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
        "total_ms": 77,
        "tried": [
          {
            "name": "marketplace",
            "status": "deadline",
            "ms": 77
          },
          {
            "name": "probe",
            "status": "won",
            "ms": 77
          }
        ],
        "winner": "probe"
      }
    }
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
INTENT_NOT_SATISFIED: no_cached_match
```

## 004_graphql_https___x_com_search_q_AI_agents_src_typed_query

- lane: `graphql`
- auth: `optional`
- difficulty: `hard`
- strategy: `graphql`
- intent: search tweets about AI agents
- url: https://x.com/search?q=AI+agents&src=typed_query

### Tool calls

_no MCP tool calls_
### Final agent message

```
(empty)
```

## 005_ssr_list_https___www_amazon_com_s_k_usb_c_cable

- lane: `ssr-list`
- auth: `none`
- difficulty: `hard`
- strategy: `ssr-list`
- intent: search amazon for usb-c cables
- url: https://www.amazon.com/s?k=usb-c+cable

### Tool calls

_no MCP tool calls_
### Final agent message

```
(empty)
```
