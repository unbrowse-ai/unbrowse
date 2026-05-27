# Benchmark history

Append-only log of bench runs. Each entry records: run id, commit, corpus
shape, per-bucket counts, agent verdict, and surfaced product
regressions. The agent (in-thread) judges each row; this file is the
durable record of those judgments.

Methodology + rubric: [`docs/benchmarks.md`](./benchmarks.md).

---

## 2026-05-27 — run `.bench-local/run-20260527T162820`

| Field | Value |
|---|---|
| Commit | `1c59517fd` (branch `trigger-deploy`) |
| Corpus | `harness/probes/corpus.txt` (19 probes) |
| Executor | `scripts/bench-run.ts` (parallel=3, timeout=45s) |
| Wall clock | ~7 min |
| Released to prod | No — staged behind CI repair (deploy.yml runs-on fix) |

### Per-bucket counts (agent verdict)

| Bucket | Count | Probes |
|---|---|---|
| **PASS** | 9 | HN, hn.algolia, crates.io, npm/openai, github.com/search, x.com/home, priceline.com, openlibrary.org, beatsaver (via Exa fallback) |
| **ANTIBOT_BLOCK** | 4 | reddit.com/r/singularity (recaptcha), reddit.com/r/programming (recaptcha), x.com/search (auth-wall jfapi), nowsecure.nl (CF Turnstile) |
| **PRODUCT_FAIL** | 5 | x.com/elonmusk, jup.ag, nusmods.com, pubmed, glassdoor.com |
| **AUTH_GATED** (excluded) | 1 | linkedin.com/feed |

**Coverage = 9 / 18 = 50%.**

### What changed since the previous run

This is the first run under the new executor (`scripts/bench-run.ts`),
which replaced the working-tree-deleted `scripts/bench-local.sh` per
CLAUDE.md's "benches are contracts not scripts" doctrine
(2026-05-26). The executor is import-shaped so the re-extractor can
re-judge old runs without paying CLI wall-clock.

The previous comparable run is `.bench-runs/post-fix/` (2026-05-26,
21 probes, timeout=90s, parallel=4) which is on a different corpus
(corpus-dimensional.txt) so coverage is not directly comparable.

### Product regressions surfaced

The five `PRODUCT_FAIL` rows all share a signature: the CLI hangs at
`[unbrowse] Still working. Searching cached routes...` and never
emits the top-level JSON before the 45s budget elapses. Affected
probes: x.com/elonmusk, jup.ag, nusmods.com, pubmed, glassdoor.com.

Two failure modes inside the bucket:
- **jup.ag**: `capture_failed detected — restarting Kuri and retrying once`
  is logged but the retry never lands. This is a Kuri recovery bug,
  not a site issue.
- **nusmods / pubmed / glassdoor / x.com/elonmusk**: no failure log;
  the in-process app just blocks. Could be browser-cache resolution,
  could be marketplace index walk, could be the post-capture publish.
  Needs `[trace] sid=... scope=...` profiling to pinpoint.

The `[exit] index-jobs drain exceeded 1500ms budget — exiting anyway`
followed by `[exit] passive-publishes drain exceeded 1500ms budget`
appears on EVERY successful probe too. The drain hang is visible but
benign on PASS rows; on hang rows the JSON never lands at all.

File a focused investigation issue for the "Still working..." silent
hang before next release.

### Action-verification rubric coverage

All 19 probes in this corpus are `get_data` or `list_or_search`
intents. No `perform`-class probes (no posts, no purchases, no
follows). Action-verification override therefore reduces to the
token-hit excerpt check, which the agent ran in-thread by reading the
`.out` files. No PASS row was demoted via the excerpt check.

### Notes on the executor

The brace-counter in `extractTopLevelJson` correctly recovered JSON
from probes whose CLI process was SIGKILLed at 45s — the JSON had
already been emitted (~3-8s in) but the process hung on drain. This
is why `cli_timeout: true` in the row does NOT imply "no data". The
agent must read the row's `source` + `trace_success` fields, not the
exit code, to know whether useful data was returned.
