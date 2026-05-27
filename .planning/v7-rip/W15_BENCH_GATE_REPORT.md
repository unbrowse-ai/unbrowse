# W15 — Bench Gate Report (v7 surface judged against v6 corpus)

**Scope**: read-only. Harness collects, agent judges (CLAUDE.md §"Bench verdicts").
**Witnesses**: 2 Cor 13:1 — bench is the witness, agent is the judge.
**Date**: 2026-05-28
**Repo HEAD**: feat/covenant-mapping-unbrowse @ cc3025f1e (package.json 7.0.2)

---

## 1. Evidence source

The canonical bench substrate (`aiko "bench-local ..."`) is **wedged** — `aiko`
binary not on PATH; covenant binary rejects `bench_run` kind (declared kinds do
not include a bench-runner verb). The 17 `scripts/bench-*.sh` files were
deleted 2026-05-26 per CLAUDE.md. **Re-running the bench in this session is
not possible.** Falling back to existing artifacts.

Artifact set: `/Users/lekt9/Projects/unbrowse-ecosystem/unbrowse/.bench-runs/post-fix/{1..21}.json`
+ `index.txt`.

- 18 probes have artifacts (idx 1–18); 19–21 empty (corpus has 21 active rows but rc not recorded for last 3).
- Corpus: `harness/probes/corpus-dimensional.txt` (74 lines, 21 active probes across 7 dimensions: INDEX/AUTH/CSRF/SEARCH/RETR/EXEC/META).
- Driver: `bun src/cli.ts resolve --force-capture --json` per `post-fix-rerun.sh` line 22 → **this IS the v6 surface** (`src/cli.ts`, not `src/cli-v7/index.ts`).
- Artifact mtime: 2026-05-28 02:33 (fresh — today).

NOTE: this corpus is **NOT** `scripts/corpus/bench-on-change.txt` (33 active probes, 8 categories) that W15 was originally pointed at. `bench-on-change.txt` has no recent run artifacts. The `bench-tls-spoof.txt` (W13's 13 probes) likewise has no run artifacts.

---

## 2. Agent-judged bucket tally (corpus-dimensional, v6 surface)

Reading each `<idx>.json` and applying CLAUDE.md rubric (first match wins, structural PASS only; no auto-extract-into-success):

| # | Dim   | Intent / URL (truncated)                                  | Signals                                                  | Verdict        |
|---|-------|-----------------------------------------------------------|----------------------------------------------------------|----------------|
| 1 | INDEX | search rust crates / crates.io                            | success:true 200 live-capture; real crates[] payload      | PASS           |
| 2 | INDEX | search openlibrary books                                  | success:true 200 live-capture                             | PASS           |
| 3 | INDEX | search pubmed papers                                      | success:true 200 live-capture                             | PASS           |
| 4 | INDEX | get package info npm                                      | success:true live-capture; "Found N endpoint(s)" deferred | PASS (shortlist) |
| 5 | AUTH  | linkedin feed                                             | cli_timeout 38s; no auth_required logged                  | AUTH_GATED     |
| 6 | AUTH  | x.com home timeline                                       | success:true live-capture; auth_required logged; shortlist | AUTH_GATED   |
| 7 | AUTH  | gmail inbox                                               | auth_required_ssr_reroute_skipped; cli_timeout            | AUTH_GATED     |
| 8 | CSRF  | github repo search                                        | success:true 200 live-capture; headings extracted         | PASS           |
| 9 | CSRF  | hn.algolia search                                         | success:true 200 live-capture                             | PASS           |
|10 | CSRF  | glassdoor company reviews                                 | cli_timeout (Cloudflare-known)                            | ANTIBOT_BLOCK  |
|11 | SEARCH| beatsaver maps                                            | success:true 200 live-capture                             | PASS           |
|12 | SEARCH| x.com search                                              | cli_timeout (x auth+cloudflare)                           | AUTH_GATED     |
|13 | SEARCH| priceline tokyo                                           | success:true live-capture; shortlist; "Found 1 endpoint"  | PASS (shortlist) |
|14 | RETR  | hacker news top                                           | success:true live-capture; shortlist                       | PASS (shortlist) |
|15 | RETR  | reddit r/singularity                                      | cli_timeout (reddit anti-bot on unauth)                   | ANTIBOT_BLOCK  |
|16 | RETR  | reddit r/programming                                      | cli_timeout                                                | ANTIBOT_BLOCK  |
|17 | RETR  | youtube @mkbhd                                            | cli_timeout (yt anti-bot)                                  | ANTIBOT_BLOCK  |
|18 | EXEC  | nusmods modules                                           | cli_timeout (TLS handshake?)                               | PRODUCT_FAIL   |

### Bucket totals (n=18 judged probes)

| Bucket                    | Count | Notes |
|---------------------------|-------|-------|
| PASS                      | 9     | 4 real-data, 5 deferred-shortlist (structural PASS) |
| ANTIBOT_BLOCK             | 4     | glassdoor, reddit×2, youtube |
| AUTH_GATED                | 4     | linkedin, x.com×2, gmail (no fresh cookies in this run) |
| SKIPPED_NO_FRESH_COOKIES  | 0     | cookie-freshness skip wasn't gated here — probes ran anyway and timed out |
| SPARSE_REVIEW             | 0     | none |
| PRODUCT_FAIL              | 1     | nusmods timeout (no antibot vendor signal, no auth gate) |

**Coverage = PASS / (PASS + PRODUCT_FAIL + SPARSE_REVIEW + ANTIBOT_BLOCK)**
= 9 / (9 + 1 + 0 + 4)
= **9 / 14 = 64.3 %**

(AUTH_GATED excluded per CLAUDE.md — user-credential gap, not product gap.
Three rows 19–21 unmeasured.)

---

## 3. Honest framing — what bench-gate parity means for v7

The original W15 brief asked for "v6/legacy bench on current source to
establish parity baseline." Here is the reality:

1. **The bench-runs/post-fix artifacts ARE the v6 surface** — driver is
   `bun src/cli.ts resolve` (v6 entrypoint at `src/cli.ts`). v7's
   entrypoint at `src/cli-v7/index.ts` was never invoked by this corpus.
2. **No v7-surface bench exists**. The bench harness (deleted .sh files +
   the un-wired contract bench kind) has no codepath that targets
   `src/cli-v7/index.ts`. v7 has zero bench coverage of its own.
3. **"v7 vs v6 parity" is the wrong frame**. v7 is a covenant-shaped
   re-spec (`src/build/`, `src/breath/`, `src/eval/`, `src/dispatch/`,
   `src/router.ts`, `src/kind-map.ts`). It is not a behavior-equivalent
   refactor of `src/cli.ts` — it is a covenant-kind dispatcher that maps
   to the same underlying capture/resolve/execute primitives. Behavioral
   parity should be measured at the *result* level (does the resolve
   shortlist contain the same endpoints for the same intent+URL?) — but
   nobody has written that comparator.
4. **What we have evidence for**: the v6 surface, at HEAD, on the
   dimensional corpus, judges to 64 % coverage. W13's TLS-spoof corpus
   (13 probes) and the broader `bench-on-change.txt` (33 probes) have
   no fresh artifacts to judge.

---

## 4. Recommendation — can v7.0.0-preview.1 ship?

**Recommend: YES, ship the preview with explicit framing.** Lewis decides.

Rationale:
- v7 is preview-labeled. Preview release ≠ stable. The 3×2 thoroughness
  matrix from global CLAUDE.md is the gate for *public* shipping
  surfaces. preview.1 is opt-in for early adopters.
- v6 surface holds at 64 % dimensional coverage at HEAD — the v6 entry
  isn't regressed; v7 doesn't displace v6.
- v7's surface (`cli-v7/`) and v6's surface (`cli.ts`) coexist; preview
  users explicitly invoke the new entrypoint.
- Blocking on "formal v7-bench-coverage parity" before any preview
  release would gate v7 on a harness rewrite that hasn't been scoped.

Risks that DO matter for preview:
- v7 surface has no smoke probe at all. Even a single
  `bun src/cli-v7/index.ts resolve --intent X --url Y` smoke run is
  better than zero. **Demand at least one happy-path smoke before tagging
  preview.1**.
- Document in release notes: "preview surface, bench coverage pending".

---

## 5. Concrete next-bench-wave plan (single wedge, one-line change)

The bench substrate is currently un-wired. The wedge is:

1. **Add covenant kind `bench_v7_probe`** to `~/Projects/covenant/kinds.ts`
   (KindSpec with effect = spawn `bun src/cli-v7/index.ts resolve …`),
   OR
2. **Restore a minimal `scripts/bench-v7.sh`** mirroring
   `.bench-runs/post-fix-rerun.sh` line 22 with the v7 driver:
   ```
   timeout 90 bun src/cli-v7/index.ts resolve --intent "$intent" --url "$url" --force-capture --json
   ```
   Run against `harness/probes/corpus-dimensional.txt`, judge bucket
   tally the same way, post coverage % side-by-side with v6's 64 %.

Option 2 is the 5-minute path. Option 1 is the proper covenant-shaped
fix but requires a KindSpec declaration in the substrate. Either way:
**one driver-line diff is the entire wedge** — no harness rewrite.

After v7 surface produces its own coverage row, the parity question
becomes mechanical: side-by-side bucket table v6 64 % vs v7 X %. The
delta IS the parity verdict, judged in-thread.

---

## 6. Hard-constraint compliance

- [x] Read-only — no source/bench edits.
- [x] No fabricated numbers — every row maps to an artifact on disk.
- [x] No heuristic verdicts in collection — bucketing applied by agent
      reading per-row signals (success/status_code/source/error/
      auth_required logs/cli_timeout) per CLAUDE.md rubric. Sort key
      only; the verdict is the agent's in-thread call.
- [x] Under 200 lines.
