# bench/capability — Architecture (shape only; Step 2 firmament)

The benchmark's concerns, kept separate so later builds stand on the seams.
Spec: `bench/CAPABILITY-BENCH-PLAN.md`. This file names layers/modules/contracts/columns —
**not** their contents (those are Steps 3-9).

## Directory shape

```
bench/capability/
  adapters/
    unbrowse_cli.py        # the ONLY module that talks to the preview CLI
  corpus/
    R.jsonl  H.jsonl  A.jsonl   # intents per tier (Reddit / Hardest-scrape / Automate)
  gold/
    {axisA_qrels, axisB_answers, axisC_tasks, axisD_policies}.jsonl
  snapshots/                 # frozen page/response captures → deterministic A & B
  score_retrieval.py         # Axis A   (deterministic: nDCG@10, Recall@10, abstention)
  score_execute.py           # Axis B/C (deterministic: token-F1, numeric, JSON-kv, ROUGE-L)
  judge_execute.py           # Axis B/C (LLM judge: presents evidence; agent renders verdict)
  audit_security.py          # Axis D   (leak-scan + targeted-ASR + data-exfil ASR + CuP)
  gate.sh                    # pass/fail boundary; two-witness; reads history
  history.jsonl              # append-only run record
  ARCHITECTURE.md            # this file
```

## The load-bearing firmament — secrets

The one boundary that fails the whole benchmark if breached (Axis D zero-tolerance):

- **Above (plaintext, transient):** a resolved secret value exists ONLY at the fetch
  boundary inside `breath execute`, in scope-local memory.
- **Below (pointer/hash-only, durable):** everything the harness reads or writes — corpus,
  gold, scores, `history.jsonl`, the audit POST body, stdout — carries pointers and hashes,
  never a value. `audit_security.py`'s leak-scan asserts this firmament held after every
  `execute`.

## Module boundaries (no cross-leak)

- **Adapter ↔ scorers.** `adapters/unbrowse_cli.py` is the sole CLI-aware module: it shells
  the preview binary (`resolve`, `breath execute`, `auth-capture`, `version`) and returns
  plain data dicts. Scorers know only those data shapes — never how the CLI works.
- **Deterministic scoring ↔ LLM judgment.** `score_*.py` exit with numbers (no model call,
  no grep-classification of unstructured text). `judge_execute.py` is the only model-using
  module and it **presents evidence; the agent-in-thread renders the verdict** (project
  standing rule). The two never blend.
- **Per-axis isolation.** A/B/C/D each own one scorer; no cross-axis coupling. Axis D's
  leak-scan is a sidecar over every `execute` call from B/C, not embedded in their scorers.
- **Auth seam.** Axis B (no-auth) MUST never touch the vault/session; Axis C (with-auth)
  goes through `auth-capture` → sealed vault → `execute`. The vault is a hard boundary
  between the two paths.
- **Data ↔ code.** `corpus/` + `gold/` + `snapshots/` are frozen inputs; scoring code is
  pure over them. Snapshots make Axis A and the Exa-style Axis B deterministic offline.
- **Deploy ↔ run.** Preview deploy is supervised and separate (`npm run release:preview`;
  `wrangler deploy --env staging`). The harness only *consumes* a pinned build via
  `eval version` (build_sha) — it never builds.
- **Gate ↔ history.** `gate.sh` is the pass/fail boundary (two independent witnesses);
  `history.jsonl` is the append-only record it reads. Recording ≠ gating.

## Data contracts (columns, not values)

- **Corpus entry:** `{ id, tier(R|H|A), intent, url, auth(none|required), axis(A|B|C|D),
  gold_ref }`.
- **Adapter `resolve()` →** `{ shortlist:[{endpoint_id, domain, title, rank, score}], cacheKey }`.
- **Adapter `execute()` →** `{ status, data, build_sha, audit_ref }` (no secret values).
- **Scorer output:** `{ axis, id, metric, score, witness(1|2), passed }`.
- **History row:** `{ ts, cli_version, build_sha, axis, metric, score, threshold, witnesses, gate }`.

## Reuse seam

`bench/exa/` (ROUGE-L searcher + scorer) folds in as the Axis-B extraction sub-scorer ONLY —
called by `score_execute.py`, not extended in place. New four-axis wine, new skin.

---

## Live protocol (iteration 2 — shape only)

Step-1 finding: `eval resolve` grades the **backend marketplace index** (cross-session
published skills), NOT the local fresh capture; a fresh `go` capture is resolvable only after
~5–30s async streaming-publish. So live Axis A is a **capture → index → retrieve** test, and
the firmament between capture and resolve is the **propagation wait**. Keep these stages
separate — one vessel per stage, not one call.

### Stages (each distinct; the wait is the boundary)
1. **capture** — `go(url)` opens a session, returns real page data + a captured `endpoint_id`.
2. **wait/propagate** — `wait_publish(domain, timeout)` polls until the marketplace can resolve it
   (`count>0`) or `timeout`. This is the async firmament; never collapse it into resolve.
3. **resolve** — `resolve_live(intent, url)` → the marketplace `{ok, shortlist, count, escalation?}`.
4. **score** — `score_retrieval.py` over the shortlist vs self-derived gold.
5. **record** — `gate.sh` writes a `source=live` row.

### New adapter methods (`adapters/unbrowse_cli.py`, contracts only)
- `go(url) -> {session_id, endpoint_id?, page_text}` (Axis B's live data path too).
- `wait_publish(domain, timeout_s) -> bool` (poll resolve until count>0 / escalation gone).
- `resolve_live(intent, url, limit) -> {ok, shortlist:[{endpoint_id,domain,title,rank,score}], count}`.
  Build task (Step 3): pin the invocation that yields the populated `{ok, shortlist}` — the
  active-session+`--url` form returns a browse-strict `{session_id,tab_id}` envelope, NOT the
  shortlist; resolve the marketplace path (likely a fresh no-active-session invocation).
- `execute(endpoint_id) -> {status, data, build_sha, audit_ref}` (Axis B/C, no secret values).
- `auth_capture(domain) -> {sealed:bool}` (Axis C).

### Live gold — self-derived (honest, no hand-authoring)
For each live target, the **endpoint `go` actually captured** for that URL is the relevant one
resolve must surface. `gold/axisA_live.jsonl` is written FROM the capture, not invented. This
keeps the live qrels truthful and reproducible.

### Decision: which path Axis A grades
Axis A grades the **marketplace CLI resolve** (the "search for action-retrieval indexing"),
NOT the MCP in-flight local-cache path. The MCP `unbrowse_resolve` in-flight flush is a
separate (local) capability, out of scope for the index-coverage axis.

### Files (live, shape only)
```
corpus/{R,H,A}_live.jsonl       # targets to capture+resolve, per tier
gold/axisA_live.jsonl           # self-derived: captured endpoint per intent
snapshots/resolve_*_live.jsonl  # real captured resolve outputs (source=live)
live_protocol.py                # capture→wait→resolve→record driver (new skin)
```
Fixture path is preserved unchanged beside the live path; `source` stamps which ran.
