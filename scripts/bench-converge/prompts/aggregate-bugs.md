# Bench-converge aggregator

You are reading the artifacts from a wave of bench-converge workers. Your
only job: group their failures by ROOT CAUSE, dedupe across probes, and
write a ranked bugs list to `{{BUGS_PATH}}`. You do NOT fix code; you do
NOT commit; you do NOT run probes. A separate fix-agent will consume
your output one bug at a time.

## Run

- run_id: {{RUN_ID}}
- run_dir: {{RUN_DIR}}
- bugs_output_path: {{BUGS_PATH}}
- n_probes_in_wave: {{N_PROBES}}

## What to read

For every probe directory under `{{RUN_DIR}}/probes/`:

1. `result.json` — the worker's verdict + per-phase evidence.
   Especially: `outcome`, `outcome_reason`,
   `phases.browse_close.capture_diagnostic` (eight raw fields
   surfaced from the close pipeline), `phases.post_resolve`,
   `phases.execute.evidence_quote`.
2. `codex-trace.jsonl` — the full codex `--json` event stream
   for that worker (every tool call, every response). Read this when
   `result.json` is sparse or you need to see the actual tool input/
   output that drove the verdict.
3. `last-message.txt` — the worker's final reasoning paragraph
   (a short summary the agent wrote).

Read the trace files yourself (`cat`, `jq`, `grep` — you have shell).
Do NOT summarize from `result.json` alone; the trace shows which MCP
tool call returned what, which is often where the bug lives.

## How to group

Group failures by ROOT CAUSE, not by site. If 17 probes all fail at
`close → capture_diagnostic.dom_decision_reason == "no_extracted_data"`,
that is ONE bug, not 17. If 4 probes all fail at
`post_resolve → returns wrong skill_id`, that is ONE bug, even if the
sites are unrelated.

Rules:

- IGNORE `EXCLUDED_AUTH` and `EXCLUDED_BLOCKED` outcomes; those are
  site refusals, not unbrowse bugs.
- IGNORE `WORKER_CRASH` unless ≥3 probes show the same crash shape
  (then it's a real worker-level bug).
- A bug is *substrate-level* (the unbrowse codebase has a gap) — never
  per-domain. Per CLAUDE.md: NO `if host === "amazon.com"`, NO synthetic
  verb names, NO prose templates. If you can only describe a fix as
  "special-case site X", you have not found the bug — keep digging.
- Rank bugs by `affected_probe_count DESC`, then by lane priority
  (anchor > semantic-rank > graphql > ssr-list > auth-gated > hostile).

## Output

Write exactly this file: `{{BUGS_PATH}}` (Markdown). Schema:

```markdown
# Bench-converge bugs — run {{RUN_ID}}

Wave summary: <X> PASS / <Y> FAIL / <Z> EXCLUDED across {{N_PROBES}} probes.

## Bug 1 — <one-line title>

- **Affected probes**: probe_id_a, probe_id_b, ... (N total)
- **Failure signature**: the exact evidence pattern shared by all
  affected probes. Quote the specific `capture_diagnostic` field,
  decision_trace step name, or tool-call response shape from the
  trace files. ≤ 5 lines.
- **Suspected location**: file_path:line or function name where the
  gap likely lives. Read the source if needed to confirm. ≤ 3 lines.
- **Proposed substrate fix**: one paragraph describing the
  smallest scoped change that addresses the root cause. Must satisfy
  the CLAUDE.md "substrate enables; never hardcode" rule. ≤ 5 lines.
- **Falsifier idea**: what test in `tests/` would catch this bug
  (real-runtime, no mocks)? ≤ 2 lines.

## Bug 2 — ...

(repeat for each distinct bug, ranked by affected_probe_count DESC)

## Long tail

If you found single-probe failures that do NOT cluster with others,
list them under this header as a flat bullet list (one line each:
`probe_id — short failure_signature`). The fix-agent will skip these
unless explicitly asked.

## Excluded

List EXCLUDED_AUTH + EXCLUDED_BLOCKED counts by lane. One line each.
```

## Rules

- Output ONLY the markdown file at `{{BUGS_PATH}}`. No other writes.
- Do NOT edit source. Do NOT commit. Do NOT run probes.
- Cite real evidence from real trace files. If you cannot find a
  shared signature for what looks like a cluster, do not invent one;
  put those probes in the "Long tail".
- Keep the whole file under 200 lines. The fix-agent reads this top-
  to-bottom; brevity is load-bearing.
- Exit as soon as the file is written.
