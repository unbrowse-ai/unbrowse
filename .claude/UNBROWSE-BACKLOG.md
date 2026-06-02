# Unbrowse backlog — ranked by dependency + leverage

Source of truth: `.claude/backlog.tsv` (machine-readable; the witness
`scripts/backlog-gate.sh` parses it). This file is the human view. Mined from
every `.claude` session transcript + cross-checked against git. Fully-done items
(one-SDK, search-on-top, OWS+lobster wallet bridge, `npx skills add`, MCP
registry, main branch, Windows kuri build, x402-hidden, Paper 1 as-code, adapter
family) are omitted.

**Witness:** `bash scripts/backlog-gate.sh` — green when the plan exists, nothing
is fake-done, and every *autonomous* item is done. Human-gated + unbounded items
are PARKED (never counted — folding them in would make the gate eternal).

## The spine (do in this order — dependency-first, leverage-weighted)

```
dag-recompute ─┬─> mcp-as-bench ─> selfimprove-loop ──────────────┐
               │                                                  ├─> (self-improving bench loop)
browsecomp-win ─> exa-bench-win ──────────────────────────────────┘
wallet-sign-backend ─> account-gate
funnel-tracking ─> frontend-dashboard
(paper2-push HUMAN) ─> push-public ─> history-scrub / release-announce   [PARKED: human sign-off]
```

The whole public-rollout subtree is blocked on **one human step**: Paper 2
sign-off by Kevin or Rach Pradhan (`paper2-push`). Everything downstream of it
(`push-public`, `history-scrub`, `release-announce`, `paper3-push`) is parked.

## Waves

**Wave 1 — quick, no deps (this campaign):**
`plan-file`, `stray-doc-cleanup`, `journal-vault`, `live-verify`.

**Wave 2 — high-leverage fixes + the north-star primitive:**
`dag-recompute` (the load-bearing goal: runtime DAG recompute, not static
fallback), `close-stuck-bug`, `login-purge-bug`, `headless-default`,
`wallet-sign-backend`.

**Wave 3 — the benchmark/self-improvement spine + backend value:**
`mcp-as-bench`, `selfimprove-loop`, `browsecomp-win`, `exa-bench-win`,
`parallel-bench`, `kuri-parallel`, `corpus-from-reddit`, `scrapling-turnstile`,
`windows-runtime`, `meta-mcp-hotswap`, `exa-search-backend`, `funnel-tracking`,
`earnings-tracking`, `proxy-fallback`.

**Wave 4 — cleanups + outward:**
`binary-slim`, `skills-prune`, `agnostic-skill`, `stripe-sub-wrapper`,
`account-gate`, `npm-deprecate`, `frontend-dashboard`, `kuri-upstream-pr`.

**Parked (not autonomously closeable):**
- HUMAN: `paper2-push` (Kevin/Rach sign-off) → `paper3-push`.
- HUMAN-blocked outward: `push-public`, `history-scrub`, `release-announce`.
- UNBOUNDED (standing direction, no clean gate): `metalearn-loop`,
  `index-of-internet`.

## Execution rule

Each item's witness lives in `.claude/backlog.tsv`. As an item is built, create
its witness (often `scripts/backlog/<id>-gate.sh` or a `tests/*.test.ts`), drive
it green, flip `status` to `done`. The master gate re-checks every `done` row's
witness on every run, so nothing stays green by assertion. Non-blocking
independent items are fanned out to subagents; items that touch the same files or
the payment seam are walked serially to avoid collisions.
