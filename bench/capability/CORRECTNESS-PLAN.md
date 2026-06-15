# Correctness witness plan — the gate must prove RIGHT answers, not just consistent ones

**Why this plan exists.** Challenged "are the returned values actually correct?", `gate_all.sh`
was shown to prove only *reproducibility* (two witnesses agree, content-bound, auth-present,
no-leak) — a consistently-WRONG answer passes it. And the param/query "correctness" frame was
wrong: params/queries are **typed holes** (deref'd via `src/values/`, hashes-only audit), so
correctness is the **hole-dereference contract**, not plaintext on the wire. This plan closes
the blind spot.

## GOAL
A runnable **value-correctness witness** (`gate_correctness.sh`, exit 0 iff settled) proving the
published CLI returns values that match known GROUND TRUTH, across two independent witnesses, with
the hole-dereference contract intact (real value bound → correct gated response → audit carries
hashes only, never plaintext). No fabricated green; grades the npm-shipped CLI via `UNBROWSE_BIN`.

## NON-GOALS
- Beating Exa's RAG groundedness (separate, noise-blocked competitive axis).
- Re-testing param-substitution by watching plaintext echo back (anti-architectural — holes hide it).
- Engine-dependent sandbox POST probes (isolated install has no kuri engine; not the bug).

## ACCEPTANCE CRITERIA (each a runnable check)
1. **Ground-truth corpus** `corpus/correctness.jsonl`: N≥8 deterministic public-API intents whose
   answer is immutable + independently checkable (e.g. GitHub repo `full_name`, `owner.login`,
   `license.spdx_id`). Each row: {intent, url, json_path, expected}.
2. **Value-correctness scorer** `value_correctness.py`: drives `$UNBROWSE_BIN get <intent> --url <url>`,
   extracts `json_path` from the real returned payload, compares to `expected`. accuracy = correct/total.
3. **Two-witness correctness**: every corpus row is run twice (distinct invocations); a row counts as
   PASS only if BOTH runs return the value AND it equals `expected` (correct AND reproducible).
4. **Hole-deref / hashes-only assertion** `hole_deref_check.py`: on a hole-bearing execute (the live
   C_auth cookie path, or a `--header Name=<pointer>` replay), assert (a) gated response returned
   (real value bound) AND (b) the audit/trace surface carries NO resolved plaintext — only hashes/
   pointers (the architecture's invariant, `execute.ts:26-29`).
5. **`gate_correctness.sh`** exits 0 iff accuracy ≥ 0.85 over the corpus (two-witness) AND the
   hole-deref hashes-only assertion holds. Records to `history.jsonl` as `axis:E_correctness`.
6. **Honest negatives kept**: any wrong value is named in the report with intent + expected + got.

## RISKS
- Public API drift (a repo renamed) → pick immutable fields (full_name/owner/license), pin repos that
  won't rename; on fetch failure, the row is BLOCKED not PASS (no fabricated green).
- Over-fitting to GitHub → include ≥2 distinct API hosts so it's not one-host luck.
- The `get` path returns the full payload (no intent projection) → scorer extracts the field itself
  from the real JSON; "data correct" is the claim, projection is out of scope.

## OUT-OF-SCOPE
RAG groundedness, frontend UX, 10k sweep, x402 settlement (separate axes/loops).

## DIJKSTRA SPINE (cheapest first-win route)
root(corpus+truth) → scorer → two-witness run → hole-deref/hashes-only → gate_correctness.sh → settle
