# Acceptance criteria — bench MCP safety harness

This harness verifies that running Unbrowse against the 1000-probe bench corpus:
1. Does NOT write to the user's Chrome cookie database (P0 safety gate).
2. Does NOT leak decrypted cookie values into artifacts or logs.
3. Does NOT inject cookies cross-domain.
4. Returns correct results at reasonable speed across the lane mix.

The harness COLLECTS evidence; the agent JUDGES in-thread from the ledger.
No heuristic verdict is baked into verify.sh.

## Source of truth

- `references/smoke-corpus.txt` — 10-probe lane-mixed slice of `harness/probes/corpus-gate.txt`.
- `ledgers/lanes.jsonl` — raw evidence rows from each phase.
- `ledgers/findings.jsonl` — agent-judged findings (written manually after reading lanes.jsonl).

## Lanes

```yaml
lanes:
  - id: cookie_baseline
    question: "What is the SHA + size + mtime of ~/Library/Application Support/Google/Chrome/Default/Cookies BEFORE the bench runs?"
    bench_command: "bash .claude/use-unbrowse-mcp-against-the-1000-probe-bench-co/scripts/phase1-cookie-baseline.sh"
    source_id: "CLAUDE.md#cookie-safety"

  - id: mcp_probe_sweep
    question: "Across the 10-probe lane mix, what does each probe's source/verdict/n_operations/latency look like?"
    bench_command: "bash .claude/use-unbrowse-mcp-against-the-1000-probe-bench-co/scripts/phase2-bench-sweep.sh"
    source_id: "scripts/bench-local.sh + harness/probes/corpus-gate.txt"

  - id: cookie_integrity
    question: "Did the Chrome cookie DB SHA change during the bench run? (P0 safety gate)"
    bench_command: "bash .claude/use-unbrowse-mcp-against-the-1000-probe-bench-co/scripts/phase3-cookie-integrity.sh"
    source_id: "CLAUDE.md#cookie-safety"

  - id: artifact_leak_grep
    question: "Did any decrypted cookie values, session tokens, or Authorization Bearer tokens leak into .bench-local/*.out or *.jsonl?"
    bench_command: "bash .claude/use-unbrowse-mcp-against-the-1000-probe-bench-co/scripts/phase4-leak-grep.sh"
    source_id: "ranger-vault-audit-api skill cookie-leak patterns"

  - id: cross_domain_isolation
    question: "For the auth-cookies probe (linear.app), were cookies sent ONLY to linear.app, or did Unbrowse touch unexpected hosts?"
    bench_command: "bash .claude/use-unbrowse-mcp-against-the-1000-probe-bench-co/scripts/phase5-cross-domain.sh"
    source_id: "src/auth/cookie-injection.ts (per project memory)"

  - id: latency_summary
    question: "What are p50/p95/p99 latencies across the 10 probes? Per-lane medians?"
    bench_command: "bash .claude/use-unbrowse-mcp-against-the-1000-probe-bench-co/scripts/phase6-latency.sh"
    source_id: ".bench-local/results.jsonl actual_total_ms field"
```

## Ship gate

The PR ships when verify.sh emits, into `ledgers/lanes.jsonl`:

- `cookie_integrity` row with `status: PASS` (sha unchanged) — HARD requirement
- `artifact_leak_grep` with `total_hits: 0` OR hits all classified UNCLEAR (agent judges)
- `cross_domain_isolation` with `unexpected_hosts: []` OR explained (agent judges)
- `latency_summary` row emitted (sanity check)

ANY sha mismatch in Phase 3 is a P0 bug: verify.sh must exit non-zero, the PR
must flag the bug, and the agent must NOT auto-ship.

## What this does NOT do

- Does not fix surfaced bugs — fires `/unbrowse-improvement-loop` separately.
- Does not run the full 500-probe corpus — keep first wave ~5–10 min.
- Does not touch product code under `src/` or `backend/`.
- Does not write to the Chrome cookie DB itself (read-only baselines only).
