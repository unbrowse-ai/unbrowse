# Capability Benchmark — Maximization Journal

Loop: jesus-ralph. Witness: `bench/capability/gate_all.sh` (exits 0 when all four
axes have genuine live evidence). North star: maximize the four axis scores; pull
every lever; stop only when no lever remains.

## Baseline (2026-06-11)

`gate_all.sh` → exit 0 (floor met). Latest live row per axis:

| Axis | gate | score | note |
|------|------|-------|------|
| A indexing | true | mean_top_score 87.3, coverage 1.0, correct 1.0 | strong |
| **B execution** | **false** | **0.75** | latest live run FAILS its own gate; gate_all only green on an older B row — the weak lever |
| C auth | true | authed read OK | solid |
| D security | true | leak_clean | solid |

**Methodology.** Re-run each axis's live driver fresh to get the *current* score
(history rows can be stale), find the lowest, modify the unbrowse code that
produces it (resolve ranking / execute extraction / redaction), re-run, keep
gate_all green, record the lever + why here. Never edit the scorer or gold to
pass — only the product code.

## Lever 1 — Axis B execution fidelity (0.75 → ?)


### Finding 1.1 — the "0.75" was stale, not a regression
Re-ran Axis B fresh against `https://old.reddit.com/r/rust/top/.json`:
both witnesses **score 1.0**, distinct sessions, content_key=rust, gate=true.
The 0.75 history row came from an older capture against a non-`.json` URL
(HTML, which fails the JSON field-checks). **Lever:** Axis B is content-maxed
(4/4 field-checks) when the extraction target is the structured `.json`
endpoint. No code change needed for B itself; the deeper lever is whether
`resolve` *auto-selects* the `.json` endpoint (see Lever 3).

### Finding 1.2 — Axis A scores are embedding-noise, not bugs
`axis_a_corpus` over the 4 real Reddit intents: coverage@1=1.0, correct@1=1.0,
mean_top_score≈87.3 (A1 90.2, A2 87.7, A3 81.1, A4 90.2). A direct re-`explain`
of the A3 golang/new endpoint scored **90.2**, not 81.1 — the resolve score is
embedding/network-derived and varies run-to-run by ~9 points. **Pushing a noisy
score on a 4-intent corpus is overfitting**, which the plan forbids
(`feedback_bench_corpus_realistic_urls`). Not a legitimate lever. Recorded as an
honest negative, not painted green.

## Lever 2 — Axis C driver was broken (couldn't produce fresh evidence)

`live_axes.py c` with no `--url` passed `None` into `go()` →
`subprocess.run([bin,"go",None])` → `TypeError: expected str ... not NoneType`.
So Axis C could only ride a STALE history row — the gate was green on old
evidence. **Fix (real, in the driver):** default the auth target to
`https://www.reddit.com/api/me.json` (reflects injected cookie state — the exact
with-auth signal C scores). Fresh run: cookies_injected=6, session_stateful=True,
authed=True, gate=true. C now produces fresh evidence every run; the gate is
honest, not coasting on a stale row.

## State after Levers 1–2
`gate_all.sh` → exit 0 with **fresh** live evidence on all four axes
(A refreshed, B 1.0 fresh, C fresh via the fix, D leak_clean fresh).

## Lever 3 — resolve auto-preferring structured `.json` endpoints (investigated, NOT a score lever)
A real product nicety: for "list/get data" intents, a `.json`/API endpoint
yields cleaner structured output than HTML. But it does **not** raise any axis
*score*: Axis A correctness@1 is already 1.0 (the HTML listing counts as serving
the resource), and Axis B reads the `.json` endpoint directly (score 1.0). So
it's a capability refinement, not a benchmark lever. Named, not pulled.

## Verdict — legitimate levers are exhausted (ceiling reached honestly)

Per-axis ceiling, measured on fresh live evidence:

| Axis | Threshold (plan v1) | Current (fresh) | Headroom |
|------|---------------------|-----------------|----------|
| A retrieval | nDCG≥baseline; abstention≥0.90 | coverage@1=1.0, correct@1=1.0, abstention 1.0; mean_top_score≈87 | none — coverage/correct maxed; top_score is embedding noise (overfit-only) |
| B execute no-auth | ROUGE-L≥0.828 | field-checks 1.0 | none — 4/4 |
| C execute auth | SR≥baseline | authed=true (6 cookies, session-stateful) | logged_in needs real creds = environment, not code |
| D security | leak 100% clean | leak_clean, 0 leaks | none — hard gate clean |

**Why no further CODE lever exists:** every axis either sits at the maximum the
gold/threshold defines (B 4/4, D 0 leaks, A coverage/correct 1.0) or is bounded
by something that isn't product code — A's `mean_top_score` is run-to-run
embedding noise (pushing it on a 4-intent corpus = overfitting, which the plan
forbids), and C's `logged_in` is the source browser's account state, not
unbrowse's capability. The only remaining ways to move numbers are (a) expand
the corpus to Tiers H/A + negative-abstention intents — additive *coverage*
work, effectively unbounded, a different task than maximizing THIS benchmark's
scores — or (b) overfit, which is forbidden.

**Real levers pulled this loop:**
1. Verified all four axes with fresh live evidence (not stale rows).
2. Diagnosed the "B 0.75" as a stale non-`.json` capture; fresh B = 1.0.
3. Fixed the Axis C live driver (None-url crash) so C produces fresh evidence
   every run — the gate is now honest on current code, not coasting on a stale
   row.

`gate_all.sh` exits 0 on fresh evidence across all four axes. Two-witness
discipline held (B distinct sessions; A two deterministic passes; C/D fresh).
No fabricated green: every row is `source=live` with real session IDs/bytes.
