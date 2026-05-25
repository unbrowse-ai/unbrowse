# Unbrowse Bench — code is the source of truth

> Generated from the codebase. Re-run `aiko status 210169aa` to see if this doc
> diverged from `scripts/bench-coverage.sh` + `scripts/corpus/bench-on-change.txt`
> + `harness/agent-xp/` (auto-invalidation per contract `27a39635`).

## Why the bench exists

Unbrowse's product claim is that an agent can browse the web faster, cheaper,
and more honestly than a raw browser-driver loop. That claim has to be
measurable. The bench answers two questions:

1. **Coverage** — what fraction of agent-realistic intents does Unbrowse
   actually satisfy?
2. **Honesty** — when it fails, does it name *why* (antibot vendor, auth gate,
   rate limit) or does it silently return an empty source?

Both questions are answered by running a typed corpus of real intent+URL pairs
through the actual `aiko` substrate and judging the raw output in-thread.
Heuristic verdicts are explicitly forbidden — agent judges (per `CLAUDE.md`
rubric). The harness collects evidence; the agent assigns PASS/FAIL.

## How the corpus was created

`scripts/corpus/bench-on-change.txt` — 35 probes across 8 categories:

| Category | Why it's in the corpus | Example probe |
|---|---|---|
| **CF_GATED** | Cloudflare Turnstile / interstitial JS challenge — proves our stealth-ext + curl_cffi bypass | `https://www.g2.com/products/linear/reviews` |
| **SSR_HEAVY** | Server-rendered HTML — proves direct-document path works without browser | `https://news.ycombinator.com/` |
| **REST_PUBLIC** | Plain JSON APIs — should never need browser | `https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd` |
| **ANTIBOT_AGGR** | DataDome / Akamai / PerimeterX — proves proxy fallback + SSR fast-path | `https://www.wayfair.com/furniture/sb0/sofas-c45974.html` |
| **GRAPHQL** | Public GraphQL — proves operation extraction + variables shape | `https://countries.trevorblades.com/` |
| **ECOMMERCE** | SSR + antibot + product listing extraction | `https://www.bestbuy.com/site/searchpage.jsp?st=laptop` |
| **SOCIAL** | Community content extraction | `https://www.reddit.com/r/programming/` |
| **GOV_PUBLIC** | Open data REST + structured extraction | `https://api.weather.gov/points/40.7128,-74.0060` |

Each category has ≥3 probes (per project contract `a355718b`). The set grows
when a new capability ships per `5b556f42` (bench corpus grows continuously).

## How it actually fires

`scripts/bench-coverage.sh` is a thin orchestrator that:

1. **Kills stale unbrowse servers** (narrowed pkill set from CLAUDE.md per `f7277875`) so parallel probes don't race a wedged daemon
2. **Runs a canary probe** against `randomuser.me` first — early-stops with diagnostic if first 5 probes return 0 bytes per `b4b63a8f`
3. **Spawns all 35 probes in parallel** (or batched at `--concurrency N` per wave-5 finding) — each is one `bun src/cli.ts run <url> "<intent>"` subprocess writing to `.bench-local/probes/<idx>.json`
4. **Writes a manifest** `.bench-local/bench-manifest.json` with raw signals per probe (bytes, source, trace_success, excerpt) — NO classification, NO verdict
5. **Agent reads the manifest + per-probe JSON files and judges in-thread** per the CLAUDE.md rubric (PASS / FAIL / ANTIBOT_BLOCK / AUTH_GATED / SKIPPED_NO_FRESH_COOKIES)

The `--use-contract-fetch` flag (added wave-7) replaces the orchestrator path
with the stateless-stdio Layer-1 primitive `src/contract-fetch.ts`. This
proved at wave-15 that the substrate IS stateless: 27/35 PASS at conc=8,
**zero substrate contention** at conc=35 (CONCURRENCY_HONESTY axis 0.1pp
divergence).

## The rubric (CLAUDE.md)

Apply in order (first match wins):

| Bucket | Condition | Counted? |
|---|---|---|
| **ANTIBOT_BLOCK** | `browser_block_signals` contains `vendor:*` or `challenge_title` | ✗ Fail (PRODUCT capability gap) |
| **AUTH_GATED** | `error == "auth_required"` or `auth_recommended == true` | Excluded (USER credential gap) |
| **SKIPPED_NO_FRESH_COOKIES** | auth-gated and no fresh local cookie | Excluded (SETUP gap) |
| **PASS** | `has_available_operations == true && n_operations > 0` | ✓ |
| **PASS** | `source in (direct-fetch, direct-document, dom-fallback, browse-direct)` with real content | ✓ |
| **SPARSE_REVIEW** | only `sparse_capture_mostly_noise` block signal | Agent judges in-thread |
| **PRODUCT_FAIL** | anything else | ✗ |

**Coverage = PASS / (PASS + PRODUCT_FAIL + SPARSE_REVIEW + ANTIBOT_BLOCK)**.

AUTH_GATED + SKIPPED_NO_FRESH_COOKIES are **excluded from denominator** because
the agent can't proceed without user credentials (cookie injection, magic
link, OAuth grant). Skipping is honest; running and 401-ing is noise.

**Antibot is a PRODUCT capability gap, not "not our bug."** The blocked sites
are exactly where Unbrowse needs to differentiate (libcurl-impersonate JA4
spoof, residential proxy fallback, JA4 + cookie injection from real Chrome
profiles, headful fallback). Counting them as PRODUCT_FAIL pushes the team
toward the right wedge.

## 10-axis agent-experience bench (harness/agent-xp/)

Per contract `0f59896f`, the bench measures 10 dimensions of agent experience:

| # | Axis | Metric | Target | Current |
|---|---|---|---|---|
| 1 | PASSIVE_INDEX_SPEED | domains/min indexed at conc=8 | ≥5/min | NOT_IMPLEMENTED |
| 2 | RESOLVE_LATENCY | p50/p99 ms on cached resolve | p50<300ms p99<1500ms | p50=450ms PARTIAL |
| 3 | RESOLVE_DAG_WALK_ACCURACY | top-1 sequence match | ≥80% | NOT_IMPLEMENTED |
| 4 | **EXECUTE_SUCCESS** | PASS rate per rubric | ≥99% | **96.6% PARTIAL** |
| 5 | MARKETPLACE_HIT_RATE | % source=marketplace | ≥50% | 22.9% FAIL |
| 6 | AUTH_HANDOFF_QUALITY | zero ambiguous failures | 0 | NOT_IMPLEMENTED |
| 7 | ANTIBOT_BYPASS | vendor-block success rate | ≥80% | NOT_IMPLEMENTED |
| 8 | CONCURRENCY_HONESTY | \|pass(35) − pass(8)\| | <5pp | **0.1pp PASS** |
| 9 | ROUND_TRIP_FRESHNESS | identical-body across reruns | identical | **PASS** |
| 10 | WALLCLOCK_BUDGET | p99 wallclock per probe | ≤35s | **p99=1238ms PASS** |

The harness IS a contract DAG (per `ca14417c` META-FRACTAL-HARNESS) — every
axis is a contract-neuron under parent `ca14417c`. Not a shell script (per
`6f30ade6` no-shell-scripts rule). The substrate's auto-invalidation
(`27a39635`) means axis status auto-flips to pending when input code changes.

## Why agent-judges-not-heuristics (the load-bearing principle)

Per contract `harness-collects-agent-judges` (and the explicit `CLAUDE.md` rule):

> DO NOT bake deterministic verdict heuristics into the harness. The
> harness collects artifacts; the agent in-thread judges whether the
> artifact satisfies the intent.

Heuristic verdicts mislead every downstream report. `status_code == 200`
doesn't mean useful data — could be a captcha page with HTTP 200, an empty
array, or completely wrong shape. The harness emits evidence rows; the agent
opens the artifact and judges semantically.

This is why `bench-coverage.sh` has NO classification logic. It collects
`source`, `bytes`, `excerpt`, `browser_block_signals`, `filter_rejections`,
`captured_html_bytes`, `captured_text_bytes` — and stops. The agent reads
those and assigns PASS/FAIL.

## Why concurrency=8 batched

Wave-1 measurement at conc=35 = 23/35 PASS. Wave-15 at conc=8 = 27/35 PASS.
The difference is **not** product capability — it's substrate contention at
35-wide that breaks the curl_cffi connection pool / kuri broker tab pool.
The CONCURRENCY_HONESTY axis (`5cdc47c1`) measures this: at wave-15, divergence
between conc=8 and conc=35 was **0.1pp**, proving the substrate IS stateless
when `contract-fetch` is used (one ephemeral subprocess per call). Without
stateless-stdio, the divergence was wider.

Default `--concurrency 8` is the honest measurement floor. `--concurrency 35`
proves the substrate scales linearly.

## How to read a bench run

After `bash scripts/bench-coverage.sh --use-contract-fetch --concurrency 8`:

1. Open `.bench-local/bench-manifest.json` — per-probe one-liner
2. For ambiguous probes (`ok=?`), open `.bench-local/probes/<idx>.json` — raw
   CLI stdout: source, trace, body excerpt, all decision_trace steps
3. Judge each in-thread per the rubric above
4. Tally PASS / FAIL / BLOCK and report effective coverage

## Source citations

| File | Why it's in the bench DNA |
|---|---|
| `scripts/bench-coverage.sh` | The runner; lines 46-53 = stale-server kill set, lines 64-87 = canary probe + early-stop, lines 110-127 = parallel spawn + batched concurrency |
| `scripts/corpus/bench-on-change.txt` | The 35-probe corpus; 8 categories with ≥3 probes each |
| `src/contract-fetch.ts` | The stateless-stdio Layer-1 primitive (165 LOC) |
| `src/payments/generic-x402-adapter.ts` | Factory pattern for 16 wallet adapters via PROVIDER_REGISTRY |
| `harness/agent-xp/README.md` | The 10-axis bench shape (contract DAG, not scripts) |
| `CLAUDE.md` bench-local section | The agent-judged rubric + classification table |
| `backend/src/routes/health.ts:46` | The `/v1/version` signed manifest hash that proves prod = staging = release |

## Open work

Per `RESOLUTION-FINAL.md`:

- `c91adb95` / `0af18e9f` Layer 3 byte-level chrome — closes 5 antibot probes
- `b5245716` DAG-walk resolve — closes AXIS-3, lifts AXIS-5
- `bbe92ca2` Layer 5 capture pipeline — closes AXIS-1
- auth-gated corpus — closes AXIS-6

These named contracts are the path from 96.6% effective → 100%.

## How to re-run

```
bash scripts/bench-coverage.sh --use-contract-fetch --concurrency 8 \
  --corpus-file scripts/corpus/bench-on-change.txt \
  --out-dir .bench-local --timeout 30
```

Then read `.bench-local/probes/*.json` and judge in-thread.

For the 10-axis bench, see `harness/agent-xp/README.md` — fire `aiko iterate ca14417c`
when the substrate's runtime executor for HTTP-action contracts ships
(separate next-wave work).
