# How Unbrowse benchmarks work

## Headline results (reproducible, gated)

- **Anti-bot retrieval — 9/9 vs naive 0/9.** On a reproducible nine-post corpus across three communities of a major JavaScript-challenge-gated social platform (ground-truthed against the platform's own data), Unbrowse retrieves the real content on **9/9** posts where a naive HTTP client is blocked on **100%** of requests (HTTP 403).
- **Latency & cost — 3.6× / 5.4× / 40×.** Peer-reviewed across 94 live domains: **3.6× mean / 5.4× median speedup, 40× fewer tokens**; ~30× faster and ~90× cheaper than driving a browser ([arXiv:2604.00694](https://arxiv.org/abs/2604.00694)).
- **Execute, don't guess — at model scale.** The same small on-device model (Qwen2.5-1.5B), tools vs no tools, turns tasks it fails from weights alone into tasks it solves: code-correctness **25% → 100%**, knowledge-not-in-weights **0% → 95%**, hard reasoning families **50% → 92%**, and applying a retrieved skill vs reasoning from scratch **63% → 93%**.
- **Self-improving by reuse — 80.7% faster, cold → warm.** Run against itself, a fixed probe set resolves in **21.1s cold → 4.1s warm** as the route cache fills, then plateaus (tail spread 4.9%). The plateau is the physical limit: once every route is cached, further passes cannot reduce latency. Recorded over 20 iterations.

---

This document explains how Unbrowse benchmarks are derived, how to read
the evidence rows they produce, and why the executor never renders its
own pass/fail verdict.

If you only need the summary numbers from the most recent run, see the
**Latest run** section at the bottom — the agent's verdict is recorded
there in-thread, not inferred by a script.

---

## The shape of an Unbrowse benchmark

A run consists of three layers:

| Layer | What it is | Where it lives |
|---|---|---|
| **Corpus** | A list of `intent | url` probes. Each row is a real agent task: a goal a user might give a calling agent, plus a starting URL where the data lives. | `harness/probes/corpus.txt` (default), `harness/probes/corpus-dimensional.txt` (per-axis), `scripts/corpus/benchmark-baseline.txt` (323-probe full) |
| **Executor** | Drives `unbrowse resolve` against each probe and dumps raw per-probe artifacts. Emits NO heuristic verdict. | `scripts/bench-run.ts` |
| **Judgment** | The calling LLM agent reads the evidence rows + raw artifacts in-thread and renders a verdict per the rubric below. | the agent reading `results.jsonl`, never a script |

The split is load-bearing. A 200 response can be a captcha page; an
empty array can be a real "no results"; a structured shortlist can be
the wrong template firing. None of those distinctions survive a regex.
The truth-claim ("is the agent's intent satisfied?") stays with the
party that has the context — the calling LLM.

This is the same principle the rest of the codebase follows: the
executor's job is to collect evidence; rendering a verdict is the
agent's job.

## Why we don't bake verdicts into the executor

Earlier benches tried to short-circuit judgment with classifier scripts.
Two failure modes recurred so consistently that the principle is now
binding:

1. **HTTP-shape lies.** `status_code == 200 → PASS` looked clean and was
   wrong all the time. Cloudflare-Turnstile interstitials return 200.
   Captcha pages return 200. Empty SSR pages return 200. The product
   reported success and the agent got nothing useful — a category
   error that classifier rules silently propagated to every downstream
   bench report.
2. **Per-site heuristic creep.** `if domain == "some-site.com" then op
   SearchTimeline +220` shaped early rankers. It generalised to nothing,
   the 11th site shipped wrong, no one noticed, and the bench reported
   green because the heuristic that scored the call was the same
   heuristic that scored the verdict.

The deletion of `scripts/bench-*.sh` on 2026-05-26 (commit message:
"benches should never be scripts") was the formal closing of this
loop. The executor that replaced them — `scripts/bench-run.ts` — is
deliberately incapable of writing a verdict column. It only collects
evidence.

## Evidence the executor records

For every probe, `results.jsonl` carries one row with these fields. None
of them are verdicts; each is a structural signal the agent reads:

| Field | What it tells you |
|---|---|
| `goal`, `url` | The probe |
| `source` | `marketplace`, `cache`, `live-capture`, `dom-fallback`, `direct-fetch`, or empty |
| `trace_success` | The top-level trace verdict from the CLI; `null` means no trace was emitted |
| `has_available_operations`, `n_operations` | The shortlist size the agent would see (two-tool-call contract) |
| `error_code`, `error_message` | What the CLI said when it failed |
| `captured_html_bytes`, `captured_text_bytes`, `captured_title` | Did the browser actually render something, or are we looking at a captcha shell? |
| `captured_api_calls` | How many XHR/fetch calls fired during capture |
| `filter_rejections` | `{reason: count}` — why the ranker dropped candidate endpoints; tells you where the ranker is being conservative |
| `browser_block_signals` | `[vendor:cloudflare, challenge_title, no_html_many_apis, sparse_capture_mostly_noise, ...]` — the upstream block fingerprint |
| `capture_diagnostic` | `no_endpoints_extracted` / `all_endpoints_filtered_by_noise_rules` / `endpoints_scored_below_relevance_threshold` |
| `total_endpoints_captured` | Raw endpoint count before ranking |
| `auth_recommended` | True if the resolve thinks the user needs to authenticate |
| `cli_exit`, `cli_timeout` | Process exit details — distinguishes "browser hung" from "extraction empty" |
| `response_text_excerpt` | First 400 chars of the response — for the agent to confirm on-topic content |
| `raw_bytes` | Total stdout/stderr captured per probe |

The raw `.out` file alongside each row contains the full CLI stdout +
stderr, so the agent can drill in when a row is ambiguous.

## The classification rubric (applied in-thread by the agent)

When the agent reads `results.jsonl`, it applies these rules in order
(first match wins). This is the same rubric documented in `CLAUDE.md`'s
"bench-local" section:

| Bucket | Trigger | Counted? |
|---|---|---|
| `ANTIBOT_BLOCK` | `browser_block_signals` contains `vendor:*`, `challenge_title`, `no_html_many_apis`; OR `capture_diagnostic` ∈ {`no_endpoints_extracted`, `all_endpoints_filtered_by_noise_rules`} | ✗ Fail (PRODUCT capability gap — the bypass is exactly the wedge we should differentiate on) |
| `AUTH_GATED` | `error_code == "auth_required"` or `auth_recommended == true` | Excluded from coverage (user credential gap, not product) |
| `SKIPPED_NO_FRESH_COOKIES` | Probe needs auth AND the local Chrome/Firefox cookie SQLite has no fresh cookie for the domain | Excluded from coverage (skipping is honest; running and 401-ing is noise) |
| `PASS` | `has_available_operations == true && n_operations > 0`, OR `trace_success == true && source ∈ {dom-fallback, direct-fetch, browse-session, live-capture}` | ✓ Pass |
| `SPARSE_REVIEW` | `browser_block_signals` contains ONLY `sparse_capture_mostly_noise` (no vendor) | Agent reads the .out file and judges in-thread |
| `PRODUCT_FAIL` | Everything else | ✗ Fail |

**Coverage metric** = `PASS / (PASS + PRODUCT_FAIL + SPARSE_REVIEW + ANTIBOT_BLOCK)`.
`AUTH_GATED` and `SKIPPED_NO_FRESH_COOKIES` are excluded because the
agent cannot proceed without user-supplied credentials — that's a SETUP
gap, not a runtime product gap.

`ANTIBOT_BLOCK` counts toward the denominator deliberately. "We have
100% coverage except for the blocked sites" is dishonest when the
blocked sites are exactly where Unbrowse needs to differentiate
(libcurl-impersonate, residential proxy fallback, JA4 spoof, real-Chrome
session reuse, headful fallback). Counting them as a failure mode
makes the bench tell the truth.

### Action-verification override

For probes with a `perform`-class intent (post, submit, comment,
purchase), structural PASS is not enough — the agent must verify the
side effect actually occurred by re-fetching state. Until per-probe
verifiers ship, those rows default to `MANUAL_REVIEW`. For `get_data`
and `list_or_search` intents, the agent checks `response_token_hit_rate`
(intent tokens found in the response excerpt) and reads the excerpt
in-thread when the hit rate is low — guards against gzip-magic and
captcha-200 false positives.

## Running a benchmark

```bash
# Default corpus, 3 workers, 45s per probe
bun scripts/bench-run.ts

# Pick a specific corpus + larger budget for cold-cache sites
bun scripts/bench-run.ts --corpus harness/probes/corpus.txt --timeout 90 --parallel 4

# Re-extract evidence from an existing run (after extractor fixes)
# without paying the CLI wall-clock again
bun scripts/bench-reextract.ts .bench-local/run-<timestamp>
```

Output:
- `.bench-local/run-<ts>/results.jsonl` — one evidence row per probe
- `.bench-local/run-<ts>/<idx>_<slug>.out` — full raw CLI stdout+stderr
- `.bench-local/run-<ts>/index.txt` — probe id → URL → exit code
- `.bench-local/run-<ts>/manifest.json` — run metadata (corpus, parallel, timing)

The executor is the substrate-side adapter the contract substrate spawns
on `bench-local` (CLAUDE.md "benches are contracts" — the entry is
declarative, the shape is TS so it can be imported by re-extractor and
triage tooling).

## Reading a single probe

```bash
# What did the CLI say?
less .bench-local/run-<ts>/3_https___example_com.out

# What did the executor extract from it?
grep -A0 example.com .bench-local/run-<ts>/results.jsonl | python3 -m json.tool

# Bulk view (compact)
python3 -c "
import json
for l in open('.bench-local/run-<ts>/results.jsonl'):
    r = json.loads(l)
    print(f\"  ops={r['n_operations']:2d} src={r['source']:14s} cli={r['cli_exit']:3d}  {r['url']}\")"
```

## Why the executor never auto-retries on a clean 124

The executor's only retry is on empty output (process died silently,
zombie from prior run). A clean `cli_exit == 124` (timeout) is NOT
retried — the site was stuck at the browser level and a retry will time
out the same way, wasting another 45s/probe. The post-2026-05 in-process
app has a known background-drain hang where the JSON result lands fast
but the process exits late; the brace-counter in `extractTopLevelJson`
recovers the result regardless of exit code.

## Adding new probes

Edit `harness/probes/corpus.txt`. Lines starting with `#` are comments.
Two-field format `intent|url` is the canonical shape. Use the
agent-experience harness conventions: the intent is a real user goal
(`search rust crates`, `get top stories`), not a synthetic test
assertion (`assert search returns 10 items`).

For dimensional axis coverage (INDEX / AUTH / CSRF / SEARCH / RETR /
EXEC / META), use `harness/probes/corpus-dimensional.txt` which
prefixes each row with the axis it exercises.

Each new probe is a contract: it asserts what an agent should be able
to do, and the bench's coverage number is the percentage of those
contracts the product currently honours.

## Latest run

The most recent run sits at **50% coverage** (9 PASS / 4 ANTIBOT_BLOCK
/ 5 PRODUCT_FAIL / 1 AUTH_GATED excluded), on the 19-probe
`harness/probes/corpus.txt` set as of commit `1c59517fd`. Full
per-probe breakdown + the agent's in-thread judgment for each row are
in [`docs/benchmarks-history.md`](./benchmarks-history.md).

Run artifacts (date, commit, coverage, per-bucket counts) are appended
to that file after each post-release verification. The methodology
above stays stable across runs; the numbers move there.

---

**Cross-references:**
- `CLAUDE.md` "bench-local" section — same rubric, project-local detail
- `harness/probes/JUDGE.md` — judge prompt for the agent-experience harness
- `harness/probes/GATE_JUDGE.md` — judge prompt for the MCP release gate
