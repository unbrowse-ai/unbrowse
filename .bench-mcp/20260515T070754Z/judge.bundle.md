# Bench-MCP judge bundle: 20260515T070754Z

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
- elapsed: 34s
- usage: {"input_tokens":117380,"cached_input_tokens":112640,"output_tokens":621,"reasoning_output_tokens":479}

### Tool calls

#### 1. unbrowse_resolve (completed)

Arguments:
```json
{
  "intent": "get top hacker news stories",
  "url": "https://news.ycombinator.com/",
  "limit": 5
}
```

Result excerpt:
```
Resolve result.

{
  "trace": {
    "trace_id": "BilFz8g0WRhh7CxqXIGe8",
    "skill_id": "",
    "endpoint_id": "",
    "started_at": "2026-05-15T07:08:17.654Z",
    "completed_at": "2026-05-15T07:08:19.074Z",
    "success": false,
    "tokens_used": 181,
    "tokens_saved": 0,
    "tokens_saved_pct": 0
  },
  "result": {
    "status": "no_match",
    "tried": [
      "marketplace",
      "probe"
    ],
    "ms": 908,
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
        "total_ms": 908,
        "tried": [
          {
            "name": "marketplace",
            "status": "lost",
            "ms": 522,
            "reason": "not_found"
          },
          {
            "name": "probe",
            "status": "won",
            "ms": 908
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
- elapsed: 30s
- usage: {"input_tokens":117137,"cached_input_tokens":73728,"output_tokens":420,"reasoning_output_tokens":275}

### Tool calls

#### 1. unbrowse_resolve (completed)

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
Resolve result.

{
  "trace": {
    "trace_id": "gMl0GycFKOVJc38c8IlGK",
    "skill_id": "",
    "endpoint_id": "",
    "started_at": "2026-05-15T07:08:17.120Z",
    "completed_at": "2026-05-15T07:08:20.535Z",
    "success": false,
    "tokens_used": 194,
    "tokens_saved": 0,
    "tokens_saved_pct": 0
  },
  "result": {
    "status": "no_match",
    "tried": [
      "marketplace",
      "probe"
    ],
    "ms": 606,
    "probe_evidence": {
      "status": 200,
      "content_type": "text/html; charset=utf-8"
    },
    "next_step": {
      "command": "unbrowse capture --url \"https://github.com/search?q=anthropic&type=repositories\" --intent \"search github repos\"",
      "est_ms": 8000,
      "creates_skill": true
    },
    "decision_trace": {
      "intent": "search github repos",
      "params": {
        "url": "https://github.com/search?q=anthropic&type=repositories"
      },
      "context": {
        "url": "https://github.com/search?q=anthropic&type=repositories"
      },
      "search_candidates": [],
      "autoexec_attempts": [],
      "query_intent": "github repos",
      "budget_race": {
        "budget_ms": 8000,
        "total_ms": 606,
        "tried": [
          {
            "name": "marketplace",
            "status": "lost",
            "ms": 524,
            "reason": "not_found"
          },
          {
            "name": "probe",
            "status": "won",
            "ms": 606
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

## 003_semantic_rank_https___www_reddit_com_r_singularity_

- lane: `semantic-rank`
- auth: `none`
- difficulty: `medium`
- strategy: `semantic-rank`
- intent: get singularity subreddit posts
- url: https://www.reddit.com/r/singularity/
- elapsed: 22s
- usage: {"input_tokens":118859,"cached_input_tokens":94720,"output_tokens":624,"reasoning_output_tokens":478}

### Tool calls

#### 1. unbrowse_resolve (completed)

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
    "trace_id": "-whcrWhMLBIXBrz-5Zbu0",
    "skill_id": "",
    "endpoint_id": "",
    "started_at": "2026-05-15T07:08:38.482Z",
    "completed_at": "2026-05-15T07:08:39.050Z",
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
    "ms": 49,
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
        "total_ms": 49,
        "tried": [
          {
            "name": "marketplace",
            "status": "deadline",
            "ms": 49
          },
          {
            "name": "probe",
            "status": "won",
            "ms": 49
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
INTENT_NOT_SATISFIED: no_match
```

## 004_graphql_https___x_com_search_q_AI_agents_src_typed_query

- lane: `graphql`
- auth: `optional`
- difficulty: `hard`
- strategy: `graphql`
- intent: search tweets about AI agents
- url: https://x.com/search?q=AI+agents&src=typed_query
- elapsed: 31s
- usage: {"input_tokens":117365,"cached_input_tokens":66048,"output_tokens":593,"reasoning_output_tokens":455}

### Tool calls

#### 1. unbrowse_resolve (completed)

Arguments:
```json
{
  "intent": "search tweets about AI agents",
  "url": "https://x.com/search?q=AI+agents&src=typed_query",
  "limit": 5,
  "raw": true
}
```

Result excerpt:
```
Resolve result.

{
  "trace": {
    "trace_id": "0pZsjtVzXxwzkkNepyEBq",
    "skill_id": "",
    "endpoint_id": "",
    "started_at": "2026-05-15T07:08:52.140Z",
    "completed_at": "2026-05-15T07:08:52.661Z",
    "success": false,
    "tokens_used": 184,
    "tokens_saved": 0,
    "tokens_saved_pct": 0
  },
  "result": {
    "status": "no_match",
    "tried": [
      "marketplace",
      "probe"
    ],
    "ms": 520,
    "next_step": {
      "command": "unbrowse capture --url \"https://x.com/search?q=AI+agents&src=typed_query\" --intent \"search tweets about AI agents\"",
      "est_ms": 8000,
      "creates_skill": true
    },
    "decision_trace": {
      "intent": "search tweets about AI agents",
      "params": {
        "url": "https://x.com/search?q=AI+agents&src=typed_query"
      },
      "context": {
        "url": "https://x.com/search?q=AI+agents&src=typed_query"
      },
      "search_candidates": [],
      "autoexec_attempts": [],
      "query_intent": "tweets about AI agents",
      "budget_race": {
        "budget_ms": 8000,
        "total_ms": 520,
        "tried": [
          {
            "name": "marketplace",
            "status": "lost",
            "ms": 520,
            "reason": "not_found"
          },
          {
            "name": "probe",
            "status": "lost",
            "ms": 234,
            "reason": "invalid_result"
          }
        ],
        "winner": null
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

## 005_ssr_list_https___www_amazon_com_s_k_usb_c_cable

- lane: `ssr-list`
- auth: `none`
- difficulty: `hard`
- strategy: `ssr-list`
- intent: search amazon for usb-c cables
- url: https://www.amazon.com/s?k=usb-c+cable
- elapsed: 26s
- usage: {"input_tokens":119029,"cached_input_tokens":94720,"output_tokens":633,"reasoning_output_tokens":497}

### Tool calls

#### 1. unbrowse_resolve (completed)

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
Resolve result.

{
  "trace": {
    "trace_id": "5DmIxsiMjb0tAjOYZRjPn",
    "skill_id": "",
    "endpoint_id": "",
    "started_at": "2026-05-15T07:09:03.224Z",
    "completed_at": "2026-05-15T07:09:07.823Z",
    "success": false,
    "tokens_used": 190,
    "tokens_saved": 0,
    "tokens_saved_pct": 0
  },
  "result": {
    "status": "no_match",
    "tried": [
      "marketplace",
      "probe"
    ],
    "ms": 1705,
    "probe_evidence": {
      "status": 200,
      "content_type": "text/html;charset=utf-8"
    },
    "next_step": {
      "command": "unbrowse capture --url \"https://www.amazon.com/s?k=usb-c+cable\" --intent \"search amazon for usb-c cables\"",
      "est_ms": 8000,
      "creates_skill": true
    },
    "decision_trace": {
      "intent": "search amazon for usb-c cables",
      "params": {
        "url": "https://www.amazon.com/s?k=usb-c+cable"
      },
      "context": {
        "url": "https://www.amazon.com/s?k=usb-c+cable"
      },
      "search_candidates": [],
      "autoexec_attempts": [],
      "query_intent": "amazon for usb-c cables",
      "budget_race": {
        "budget_ms": 8000,
        "total_ms": 1705,
        "tried": [
          {
            "name": "marketplace",
            "status": "lost",
            "ms": 527,
            "reason": "not_found"
          },
          {
            "name": "probe",
            "status": "won",
            "ms": 1705
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
