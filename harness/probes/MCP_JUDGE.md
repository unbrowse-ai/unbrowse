# MCP_JUDGE — agentic bench rubric

You are judging an agentic bench run where a fresh codex session invoked the LOCAL unbrowse MCP server for each probe. The agent could call any unbrowse_* tool. The bench captures the full event stream.

You render the verdict. No regex, no heuristics.

## What you receive (per probe)

- `lane` — `anchor` | `semantic-rank` | `graphql` | `ssr-list` | `auth-gated` | `hostile`
- `intent` — the natural-language intent the agent was given
- `url` — the contextUrl the agent was anchored to
- optional `auth`, `difficulty`, `strategy` — triage metadata only. They never imply a verdict.
- `prompt.txt` — the exact prompt the agent saw
- `events.jsonl` — full codex event stream (tool calls, agent messages, usage)
- `last-message.txt` — the agent's final message
- `timing.json` — elapsed seconds
- `judge.bundle.md` — distilled view: tool calls + arguments + result excerpts + final answer

## What you emit

A `verdict.json` row per probe:

```json
{
  "probe_id": "<from manifest>",
  "mcp_call_verdict": "MCP_PASS | MCP_FAIL_NO_RESOLVE | MCP_FAIL_NO_EXECUTE | MCP_FAIL_WRONG_TOOL | MCP_EXCLUDED_AUTH | MCP_EXCLUDED_BLOCKED",
  "mcp_call_reasoning": "Quote the tools called in order. If the agent skipped resolve or execute, name what they did instead.",
  "retrieve_verdict": "RETRIEVE_PASS | RETRIEVE_FAIL_WRONG_ENTITY | RETRIEVE_FAIL_EMPTY | RETRIEVE_FAIL_WRONG_SHAPE | RETRIEVE_FAIL_ERROR_BODY | RETRIEVE_EXCLUDED_AUTH | RETRIEVE_EXCLUDED_BLOCKED",
  "retrieve_reasoning": "Quote a concrete data field from the execute result, or quote the offending content for a fail.",
  "final_answer_verdict": "FINAL_PASS | FINAL_FAIL_FABRICATED | FINAL_FAIL_GENERIC | FINAL_FAIL_NO_DATA | FINAL_EXCLUDED",
  "final_answer_reasoning": "Did the final agent message quote real data from execute (PASS), make something up (FABRICATED), refuse, or stay generic?",
  "evidence_quote": "single line from the response or final message that most supports the verdict",
  "suspicious": false
}
```

`suspicious` is `true` only when lane is `hostile` and any verdict is PASS.

## Three orthogonal verdicts

| Verdict axis | Question |
|---|---|
| `mcp_call_verdict` | Did the agent use the MCP server correctly? Resolve → pick → execute. |
| `retrieve_verdict` | Did the execute call return the intent's data for the right entity? |
| `final_answer_verdict` | Did the agent's final message accurately reflect what was retrieved? |

A probe can fail any one axis independently. Example:
- `MCP_PASS` + `RETRIEVE_FAIL_EMPTY` + `FINAL_FAIL_NO_DATA`: agent followed protocol, execute returned empty, agent reported the empty result honestly.
- `MCP_PASS` + `RETRIEVE_FAIL_EMPTY` + `FINAL_FAIL_FABRICATED`: agent followed protocol, execute returned empty, but the final message claimed fake data.

## MCP call rubric

| Verdict | When |
|---|------|
| `MCP_PASS` | Agent called `unbrowse_resolve` first, then `unbrowse_execute` with a skill+endpoint from the shortlist. At most 2 execute attempts. |
| `MCP_FAIL_NO_RESOLVE` | Agent skipped `unbrowse_resolve` entirely. |
| `MCP_FAIL_NO_EXECUTE` | Agent called resolve but never called execute (and the lane is not auth-gated or hostile-blocked). |
| `MCP_FAIL_WRONG_TOOL` | Agent called shell, file, or non-unbrowse tools to satisfy the intent. |
| `MCP_EXCLUDED_AUTH` | Lane is `auth-gated` and resolve returned a usable handoff next_step. Excluded from denominator. |
| `MCP_EXCLUDED_BLOCKED` | Resolve returned a vendor-block diagnostic (`browser_block_signals` with a vendor tag, or a 403/challenge in the response). Excluded from denominator. |

## Retrieve rubric

Read the `unbrowse_execute` result excerpt in the bundle.

| Verdict | When |
|---|------|
| `RETRIEVE_PASS` | Response contains intent-relevant data for the right entity from contextUrl. Quote ≥1 concrete field. |
| `RETRIEVE_FAIL_WRONG_ENTITY` | Well-shaped but for the wrong entity (e.g. intent says r/singularity, response is r/programming). |
| `RETRIEVE_FAIL_EMPTY` | Structurally valid but empty (`{items:[]}`) when the page had content. |
| `RETRIEVE_FAIL_WRONG_SHAPE` | Response is config / telemetry / metaTags / breadcrumbs, not the intent's data. |
| `RETRIEVE_FAIL_ERROR_BODY` | captcha page, error JSON, auth wall, stale_endpoint body, format_mismatch with no usable extraction. |
| `RETRIEVE_EXCLUDED_AUTH` | Same as `MCP_EXCLUDED_AUTH`. |
| `RETRIEVE_EXCLUDED_BLOCKED` | Same as `MCP_EXCLUDED_BLOCKED`. |

## Final-answer rubric

Read `last-message.txt`.

| Verdict | When |
|---|------|
| `FINAL_PASS` | Agent's final message quotes a real data field from the execute result. The quoted value appears in the result excerpt. |
| `FINAL_FAIL_FABRICATED` | Final message names a field that does NOT appear in any tool call result. |
| `FINAL_FAIL_GENERIC` | Final message paraphrases or summarizes without quoting (e.g. "the page contains stories about tech"). |
| `FINAL_FAIL_NO_DATA` | Final message admits no data was found (e.g. "INTENT_NOT_SATISFIED" or similar refusal). |
| `FINAL_EXCLUDED` | Lane is auth-gated or blocked and agent honestly reported the handoff. |

## Quote requirement

A `*_PASS` without a concrete quote is rejected. A `*_FAIL_*` without a quote of the offending content is rejected. The `evidence_quote` is the single most-informative line; the prose may quote others.

## Coverage denominator

```
mcp_indexable    = total - count(MCP_EXCLUDED_*)
mcp_coverage     = count(MCP_PASS)      / mcp_indexable
retrieve_total   = total - count(RETRIEVE_EXCLUDED_*)
retrieve_coverage = count(RETRIEVE_PASS) / retrieve_total
final_total      = total - count(FINAL_EXCLUDED)
final_coverage   = count(FINAL_PASS)    / final_total
```

The CI workflow computes ratios. You emit per-probe verdicts only.
