# bench-converge — codex-driven MCP-gate convergence loop

The release/push gate for the unbrowse MCP surface.

This loop walks the 58-probe corpus at `harness/probes/corpus-gate.txt`,
spawns one `codex exec --yolo` worker per probe to drive the full
`unbrowse_resolve → go → snap → close → resolve → execute` sequence
against the **dev** src tree (not the global binary), and on any
non-PASS spawns a second codex-yolo *fix-agent* that ships a single
scoped commit. After every fix, four anchor probes are re-smoked; if
any goes red the fix is reverted. When the ledger satisfies
`index ≥ 80%` and `retrieve ≥ 65%`, the orchestrator writes
`.bench-gate/stamp.mcp.json` — which both `.husky/pre-push` and
`scripts/bench-gate-prerelease.sh` consume.

## Wiring

```
scripts/bench-converge/
├── orchestrate.sh                # loop driver
├── prompts/
│   ├── probe-worker.md           # per-probe codex prompt (read-only)
│   └── probe-fix.md              # per-failure codex prompt (write + commit)
└── README.md                     # this file
.codex/config.toml                # binds `unbrowse` MCP -> `bun src/mcp.ts`
.bench-converge/runs/<run-id>/    # ledger, per-probe results, diagnoses
.bench-gate/stamp.mcp.json        # output; consumed by push + release gates
```

## Run

```bash
# Full corpus (58 probes)
bash scripts/bench-converge/orchestrate.sh

# Smoke first 5
bash scripts/bench-converge/orchestrate.sh --limit 5

# Worker only (do not let codex commit fixes)
bash scripts/bench-converge/orchestrate.sh --no-fix

# Dry-run (no codex spawn; synthetic PASS for every probe; validates plumbing)
bash scripts/bench-converge/orchestrate.sh --dry-run --limit 2

# Resume a previous run
bash scripts/bench-converge/orchestrate.sh --resume 20260518T111400Z
```

### Env

| Var | Default | Meaning |
|---|---|---|
| `BENCH_CONVERGE_THRESHOLD_INDEX` | `0.80` | Min index-rate to PROMOTE |
| `BENCH_CONVERGE_THRESHOLD_RETRIEVE` | `0.65` | Min retrieve-rate to PROMOTE |
| `BENCH_CONVERGE_BUDGET_SECONDS` | `7200` | Total wall budget (2h) |
| `BENCH_CONVERGE_MAX_ATTEMPTS_PROBE` | `2` | Worker → fix → worker cycles per probe |
| `CODEX_BIN` | `which codex` | Override codex binary path |

## How it gates push + release

- `.husky/pre-push` → `scripts/mcp-gate-prepush.sh` reads
  `.bench-gate/stamp.mcp.json`. If gate-affecting code is being pushed
  to `main` and no fresh PASS stamp exists for HEAD, the push is
  blocked. Bypass: `MCP_GATE_BYPASS=1` (loud; document in CHANGELOG).
- `scripts/bench-gate-prerelease.sh` (release-it `before:init` hook)
  prefers `stamp.mcp.json` over the legacy `stamp.json`. Same staleness
  rules: stamp_sha == HEAD, or no gate-affecting changes since the
  stamp commit.

The orchestrator writes the stamp with this shape:

```json
{
  "gate_passed": true,
  "run_id": "20260518T111400Z",
  "commit_sha": "<HEAD at PROMOTE time>",
  "corpus": "harness/probes/corpus-gate.txt",
  "stamped_at": "2026-05-18T11:14:00Z",
  "coverage": {
    "index_pass": 47, "retrieve_pass": 51,
    "denom": 56, "index_rate": 0.839, "retrieve_rate": 0.911
  },
  "thresholds": { "index": 0.80, "retrieve": 0.65 },
  "transport": "codex-exec-yolo",
  "driver": "bench-converge/orchestrate.sh"
}
```

## Ledger schema

`.bench-converge/runs/<run-id>/ledger.jsonl` — one JSONL row per
probe attempted. Resumable: rows with `verdict == "PASS"` are skipped
on `--resume`.

```json
{
  "run_id": "20260518T111400Z",
  "probe_id": "013_semantic-rank",
  "lane": "semantic-rank",
  "intent": "get programming subreddit posts",
  "url": "https://www.reddit.com/r/programming/",
  "verdict": "PASS|EXCLUDED_AUTH|EXCLUDED_BLOCKED|FAIL_*|UNRESOLVED_*|WORKER_CRASH",
  "indexed": true,
  "reason": "...",
  "head_sha": "<sha at the moment this row was written>",
  "ts": "2026-05-18T11:18:42Z"
}
```

## Anchors

Hardcoded in `orchestrate.sh::ANCHOR_IDS`. Currently:
`001_anchor` (Hacker News), `004_anchor` (lobste.rs),
`006_anchor` (Wikipedia), `007_anchor` (MDN).

Pick anchors that are stable, no-auth, no anti-bot, and known to PASS
on `main`. Re-smoked after every fix; any anchor going red reverts the
fix and marks the probe `UNRESOLVED_REGRESSED_ANCHOR`.

## Substrate rules the fix-agent must follow

Both prompts cite CLAUDE.md verbatim:

- **Substrate enables; does not prescribe.** No per-domain hardcoding,
  no synthetic verb/tool names, no prose templates in another agent's
  mouth, no pattern-match lists. Fix at the data layer, not via rules.
- **Harness collects, agent judges.** Workers judge their own probe
  from evidence (response excerpt, capture_diagnostic, status codes) —
  this orchestrator never decides PASS/FAIL from heuristics.
- **One scoped commit. No `--no-verify`. Falsifier test required.**

## Failure modes you'll see in the ledger

- `FAIL_INDEX_NO_ENDPOINTS` — close emitted `indexed: false`. The
  worker quotes `capture_diagnostic.dom_decision_reason` so the
  fix-agent knows which gate fired.
- `FAIL_RESOLVE_AFTER_PUBLISH` — close indexed=true but post-resolve
  returns wrong skill (cross-skill leak) or empty.
- `FAIL_EXECUTE_EMPTY` — execute 2xx but body irrelevant to intent.
- `UNRESOLVED_NO_FIX` — fix-agent diagnosed but did not commit (saved
  diagnosis under `.bench-converge/runs/<run>/diagnoses/<probe>.md`).
- `UNRESOLVED_REGRESSED_ANCHOR` — fix shipped but broke an anchor;
  reverted automatically.
- `EXCLUDED_BLOCKED` / `EXCLUDED_AUTH` — site refused automation;
  excluded from the coverage denominator.

## After PROMOTE

```bash
git add .bench-gate/stamp.mcp.json
git commit -m "chore: mcp-gate stamp $(jq -r .run_id .bench-gate/stamp.mcp.json)"
git push
```
