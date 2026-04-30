# Agent Experience Harness — Judging Protocol

The harness collects; the agent judges. No unit-test assertions. After running
`bash harness/probes/agent-experience.sh`, hand the resulting manifest to a
sub-agent (or judge in-thread) using the prompt below.

## Inputs the agent reads

`harness/runs/<run-id>/manifest.json` — array of probes, each with:
- `intent`, `url`, `exit_code`, `duration_ms`, `timed_out`
- `source` (marketplace | live-capture | dom-fallback | route-cache | direct-fetch | …)
- `browser_avoided`, `kuri_pids_alive_after_run`, `visible_chrome_present`
- `available_operations` (top 5 — what the agent sees first)
- `available_endpoints` (top 5 — full ranked list with scores)
- `suggested_next_operation_id`
- `diagnostic` (top_reasoning, confidence, known_issues)
- `log_path` (full CLI output if deeper inspection needed)

## What the agent decides per probe

For each probe, judge by reading the artifact (and only opening `log_path`
if the artifact is ambiguous):

1. **Did unbrowse return data the agent can actually use to satisfy the
   intent?** Not "did it return ops" — "is the top operation the one a smart
   human would pick to fulfill this intent?" Intent + url + top op + description
   is the load-bearing tuple.
2. **Did it open a browser?** `kuri_pids_alive_after_run` non-empty OR
   `visible_chrome_present == true` OR `source == "live-capture"` with
   `browser_avoided != true` → browser was used. Headless is fine; visible
   is a north-star violation.
3. **Was the shortlist coherent with execute?** If `available_operations[0]`
   and `available_endpoints[0]` disagree on what's best, the agent will be
   misled. Note divergence.
4. **What's the failure mode if it failed?** Pick from: wrong-template,
   stale-skill, ssr-payload-missing, auth-gated, timeout-no-progress,
   live-capture-no-data, ranker-tie, browser-block, server-crash, parse-error.

## Per-probe verdict

```json
{
  "intent": "...",
  "url": "...",
  "verdict": "WORKS | WORKS-WITH-NOTE | WRONG-ENDPOINT | TIMEOUT | BROWSER-OPENED | NO-DATA | OTHER",
  "browser_opened": true | false,
  "shortlist_matches_execute": true | false,
  "failure_mode": "<from list above, or empty if WORKS>",
  "evidence_quote": "the one line from the artifact that supports the verdict",
  "fix_hypothesis": "what would have to change for this to become WORKS"
}
```

## Run-level summary

After judging all probes, produce:

```json
{
  "run_id": "...",
  "coverage": "WORKS+WORKS-WITH-NOTE / total non-AUTH-GATED",
  "browser_open_rate": "browsers / total",
  "vs_baseline_41pct": "<delta>",
  "lost_sheep": [{"pattern": "...", "domains_affected": [...], "fix_hypothesis": "..."}],
  "wins": ["short list of what genuinely works"],
  "next_loop_targets": ["the 3 highest-leverage fixes in priority order"]
}
```

The agent's verdict is the source of truth. No grep, no regex, no assertion
gates the run. The harness's only contract: collect comprehensive evidence,
present it readable, get out of the way.
