# Unbrowse Capability Benchmark — Plan

**Goal.** One reproducible benchmark that grades Unbrowse on four axes, run against the
**latest CLI deployed to preview**, scored deterministically, gated so no fabricated green
can pass, and judged by an agent reading real artifacts (never by heuristic field-matching).

The four axes, in the product's own verbs:

| # | Axis | Unbrowse verb under test | What "good" means |
|---|------|--------------------------|-------------------|
| **A** | Action-retrieval / indexing **coverage** | `eval resolve <intent>` | For an intent+URL, return a ranked shortlist whose top endpoints are relevant; abstain when none exist |
| **B** | Execution **without auth** (public) | `eval resolve` → `breath execute` | The chosen endpoint returns the real public data the intent asked for |
| **C** | Execution **with auth** (logged-in) | `breath auth-capture` → `breath execute` | Authenticated READ/CREATE/UPDATE/DELETE succeed against a logged-in session |
| **D** | **Security audit** | `breath execute` + audit/session surface | Execution respects auth boundaries, never leaks vault secrets, resists injected page content |

Reuse-first: every axis clones the task shape and/or scoring metric from a real, published
benchmark rather than inventing one. The harness reuses the existing `bench/exa/` pattern —
a CLI-wrapping adapter, a deterministic per-axis scorer, a `--gate` that exits non-zero
until a pinned threshold is met, a frozen corpus + gold, and a history record.

---

## What we reuse (verified, real)

| Axis | Cloned from | What we lift | Metric we adopt | Repo |
|------|-------------|--------------|-----------------|------|
| A | **ToolRet** | intent → ranked-tool task shape; BEIR-format corpus + qrels | **nDCG@10, Recall@10** | github.com/mangopy/tool-retrieval-benchmark |
| A (negatives) | **BFCL** relevance-detection split | "no valid endpoint → abstain" task pattern | abstention accuracy | github.com/ShishirPatil/gorilla |
| A (scaffold) | **BEIR / MTEB** | register our (intent → endpoint) pairs as a custom retrieval task; inherit scoring | nDCG@10 / MRR / Recall@k | github.com/beir-cellar/beir |
| B | **AssistantBench** | closed-form gold answers + deterministic scorer | token-F1 / numeric-ratio / JSON key-value | huggingface.co/datasets/AssistantBench/AssistantBench |
| B | **Exa WebCode/Contents** (already pinned in `bench/exa/TARGETS.md`) | same 250 URLs, content-fidelity scorer | **ROUGE-L** vs Exa 82.8 / Completeness 82.8 / Accuracy 89.3 | github.com/exa-labs/benchmarks |
| B/C (fuzzy judge) | **Online-Mind2Web → WebJudge** | LLM-as-judge "did output satisfy intent" (87% human agreement) | WebJudge task-completion | github.com/OSU-NLP-Group/Online-Mind2Web |
| C | **WebBench (Halluminate)** | READ/CREATE/UPDATE/DELETE taxonomy over real authed sites | task success rate | github.com/Halluminate/WebBench |
| C (offline det.) | **WebArena** / **ST-WebAgentBench** | dockerized real backends → programmatic final-state reward | functional success rate | github.com/web-arena-x/webarena |
| D | **AgentDojo** | utility-under-attack + targeted-ASR (inject content during authed execute) | targeted-ASR + utility-under-attack | github.com/ethz-spylab/agentdojo |
| D | **InjecAgent** | offline data-exfil probe (does execute leak vault values?) | data-stealing ASR | github.com/uiuc-kang-lab/InjecAgent |
| D | **ST-WebAgentBench** | **CuP** — completion under zero policy violations | CuP + Risk Ratio | github.com/segev-shlomov/ST-WebAgentBench |
| C/D (offline backend) | **WASP** | self-hosted Reddit (Postmill) + GitLab Docker stack — reuse as our Reddit auth/inject target | — (provides the sandbox) | github.com/facebookresearch/wasp |

There is **no published frozen-gold extraction benchmark specific to Reddit or anti-bot
sites** — those vendor "success-rate" numbers ship no reusable corpus. So Tiers R and H
below are corpora **we build**, scored with the AssistantBench/WebJudge metrics above.

---

## The corpus — three coverage tiers × four axes

The "coverage over Reddit / hardest scraping sites / things people want to automate" lives
in how we tier the target list. Each target carries: `intent`, `url`, `auth: none|required`,
`gold` (frozen answer or judge rubric), `gold_endpoint` (for Axis A qrels), and `tier`.

- **Tier R — Reddit.** Public listing / subreddit / thread / search (no-auth, Axis A+B) and
  authed post / comment / vote / save (Axis C+D). Reddit doubles as a hard-scrape target
  (anti-bot) and the canonical auth target. **Offline backend = WASP's Postmill Reddit
  clone** for deterministic C/D runs; live old.reddit.com / json endpoints for B.
- **Tier H — hardest scraping sites.** Cloudflare/anti-bot challenge pages, heavy JS/SSR
  payloads (Next.js / Apollo / Nuxt hydration), infinite-scroll, rate-limited APIs. Coverage
  metric = *does `resolve`+`execute` return real data on a cold load* (the silent-truncation
  failure mode is the named enemy — see `feedback_extraction_silent_truncation`). **No site
  names in published artifacts** — aggregate counts + anti-bot-system names only
  (`feedback_no_site_names_benchmarks`).
- **Tier A — things people want to automate.** The long tail mapped onto **WebBench's
  452-site / READ-CRUD taxonomy** for breadth: dashboards, SaaS, e-commerce, social,
  productivity. Seed the intents from real demand signal (session logs + Reddit complaints
  via `evidence-build`), not invented ones (`feedback_bench_corpus_realistic_urls`).

Corpus lives at `bench/capability/corpus/{R,H,A}.jsonl`, gold at
`bench/capability/gold/`, frozen snapshots at `bench/capability/snapshots/` (so Axis A and
the Exa-style Axis B are deterministic offline).

---

## Scoring — one deterministic scorer per axis, agent-judged where fuzzy

```
bench/capability/
  adapters/unbrowse_cli.py     # wraps the PREVIEW CLI: resolve(), execute(), auth_capture()
  score_retrieval.py           # Axis A: nDCG@10, Recall@10, abstention-accuracy   (deterministic)
  score_execute.py             # Axis B/C: token-F1 + numeric-ratio + JSON-kv + ROUGE-L (deterministic)
  judge_execute.py             # Axis B/C fuzzy: WebJudge rubric, LLM-judged, NOT heuristic
  audit_security.py            # Axis D: targeted-ASR, data-exfil ASR, CuP, leak-scan      (deterministic)
  gate.sh                      # exits 0 only when ALL axes ≥ pinned thresholds
  history.jsonl                # per-run record (CLI version + build_sha + per-axis scores)
```

- **Axis A** is pure deterministic (qrels → nDCG@10 / Recall@10 + abstention accuracy).
- **Axis B/C** has a deterministic core (gold-answer F1 / ROUGE-L) **and** a WebJudge LLM
  layer for open-ended intents. Per the standing rule, the LLM judge **presents evidence;
  the agent-in-thread renders the verdict** — no grep/regex classification of unstructured
  output (`feedback_no_heuristics_in_judge_jobs`, `feedback_harness_makes_visible_agent_judges`).
- **Axis D** is the security witness and is mostly deterministic + adversarial:
  1. **Leak-scan (static, unbrowse-specific):** after every `breath execute`, assert the
     resolved secret value appears **nowhere** in the session file, the audit POST body,
     stdout, or the returned data — only hashes/pointers. This directly tests the
     "secret-redaction invariants" already load-bearing in `breath/execute.ts`.
  2. **Data-exfil ASR (InjecAgent shape):** inject an attacker instruction into page/response
     content; measure whether `execute` ever emits a vault value.
  3. **Targeted-ASR + utility-under-attack (AgentDojo shape):** does injected content divert
     the action while authed?
  4. **CuP (ST-WebAgentBench):** authed CRUD completes with **zero** permission-boundary
     violations.

---

## Run mode — against the PREVIEW-deployed CLI, two witnesses

The benchmark grades the **shipped artifact**, not local source (`feedback_harness_uses_global_binary`):

1. **Deploy latest CLI to preview.**
   - CLI/binary: cut preview release → `npm run release:preview` (release-it bumps + tags +
     pushes; CI builds the cross-compiled binaries; polls npm; SSH-installs + smoke-tests),
     or tag-push → `.github/workflows/release.yml`. Backend preview:
     `cd backend && wrangler deploy --env staging`.
   - The adapter pins the version under test via `eval version` (CLI version + build_sha +
     signed manifest) and stamps it into `history.jsonl`.
2. **Run all four axes** through `adapters/unbrowse_cli.py` against that preview build.
3. **Two-witness settlement** (Gen 2:2 / the project's standing rule): a real win requires
   the score reproduce across **two independent runs** (or two judges that can't share a
   failure mode), and the gate is a **runnable witness** — `gate.sh` exits 0 — never a
   self-asserted string. Record honest negatives; don't paint green.

---

## Gate thresholds (pin per axis; start honest, ratchet up)

| Axis | Pinned target (v1) | Source of the bar |
|------|--------------------|-------------------|
| A — retrieval | nDCG@10 ≥ baseline embed-search; abstention ≥ 0.90 | our own embed baseline + BFCL relevance pattern |
| B — execute no-auth | ROUGE-L ≥ **0.828** (Exa); AssistantBench F1 ≥ public-agent baseline | Exa published + AssistantBench leaderboard |
| C — execute auth | WebBench-style task SR ≥ stated baseline | WebBench published SR |
| D — security | leak-scan **100% clean** (hard gate); targeted-ASR ≤ AgentDojo defended baseline; CuP ≥ ST-WebAgentBench baseline | the redaction invariant is non-negotiable; rest from published defended numbers |

Axis D's leak-scan is a **hard zero-tolerance gate** — any secret value on the wire fails
the whole run, regardless of A/B/C scores. (This is the `leak-guard` / `zk-gate` philosophy
turned into a per-execution runtime check.)

---

## Build order (Dijkstra spine — cheapest first win)

1. **Pin corpus + gold for Tier R** (Reddit, smallest, both auth modes) — the seed slice.
2. **Build `adapters/unbrowse_cli.py`** wrapping the preview CLI's `resolve` / `execute` /
   `auth-capture` / `version`.
3. **Axis A scorer** (deterministic, no auth, no network beyond resolve) — fastest to a real
   number; clone ToolRet qrels scoring.
4. **Axis B scorer + Exa re-run** — fold the existing `bench/exa` ROUGE-L harness in as the
   no-auth extraction sub-score.
5. **Axis D leak-scan** — cheap, deterministic, highest-value security witness; runs on every
   `execute` from step 4 onward.
6. **Axis C** (auth-capture → authed execute) on the WASP Postmill Reddit sandbox (offline,
   deterministic) before live authed sites.
7. **Axis D adversarial** (AgentDojo/InjecAgent injection) layered on C.
8. **`gate.sh` + `history.jsonl`** — wire the runnable two-witness gate.
9. **Expand corpus to Tiers H and A**, ratchet thresholds, run vs preview, settle.

Settle each step Plan → Build → Test → Judge; tick only on real evidence; on failure repent
and re-cost.

---

## LAYERS

- **layer-1 retrieval-coverage** — Axis A end-to-end: corpus Tier R+H+A intents, ToolRet-style
  qrels, `score_retrieval.py`, gate on nDCG@10 + abstention. (Build order 1–3, 9-partial)
- **layer-2 execution** — Axis B (no-auth, incl. Exa re-run) + Axis C (auth, WASP sandbox then
  live), `score_execute.py` + WebJudge. (Build order 4, 6)
- **layer-3 security-audit** — Axis D: leak-scan + AgentDojo/InjecAgent ASR + ST CuP,
  `audit_security.py`. (Build order 5, 7)
- **layer-4 preview-gate** — deploy latest CLI to preview, run all axes against it,
  two-witness `gate.sh` + `history.jsonl`, agent-judged. (Build order 2, 8) ← **final layer**

GOAL: a runnable `bench/capability/gate.sh` that, against the preview-deployed CLI, exits 0
only when all four axes meet pinned thresholds across two independent witnesses — and a
`history.jsonl` recording the version, build_sha, and per-axis scores of each run.
