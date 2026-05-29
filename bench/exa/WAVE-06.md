# WAVE-06 — dominion E2E: gate-5 audit holds across the npm seam; gate-4 konmari; gates 1+2 still grader-blocked (2026-05-29)

jesus-loop default, branch `jl/exa-browsecomp`. Step 6 (Dominion) — integration across every axis at once.

## E2E #1 — gate-5 audit rules the WHOLE surface (src AND built dist)
The audit gate (`scripts/client-audit-gate.sh`) checks `packages/sdk-v2/src/index.ts`, but an npm
consumer imports the compiled `dist/`. Built `@unbrowse/client` (`tsc -p`, exit 0) and re-ran the gate
against the real publish seam:

    CLIENT_AUDIT_INDEX=.../dist/index.d.ts CLIENT_AUDIT_SRC=.../dist bash scripts/client-audit-gate.sh
    → reflect: 35 public export(s), 0 unaudited · no-leak: 20 moat terms, 0 leaked · PASS

The auditable surface is identical src↔dist; no moat term leaks into the compiled package either.
Gate 5 now holds end-to-end, not just at source.

## E2E #2 — the gate-5 + gate-6 witnesses are green TOGETHER (integration, not in isolation)
- client-audit-gate.test.ts: 3/3 (mutation test, fails-closed)
- covenant-toll-emit.test.ts: 3/3
- covenant-toll-ledger.test.ts: 6/6
- backend x402-gate.test.ts: 10/10
= 22/22, 0 fail. Gate 6 (toll-booth) two-witness status corroborated under integration.

## E2E #3 — gates 1+2 remain HONESTLY blocked (no fabricated number)
Re-probed the grader: `OPENAI_API_KEY` still returns HTTP 429 (insufficient_quota). Harness intact
(`bench/browsecomp/unbrowse_browsecomp_searcher.py` + `vendor/search_evals`). Gates 1 (beat Exa) and 2
(BrowseComp > 0.336) cannot emit a real number until a funded key lands in `~/.config/env/global.env`.
The exact run command is in WAVE-05.md. Unchanged from WAVE-05 — external funding dependency, not code.

## John 15:2 prune (gate-4 konmari)
Removed the superseded extraction-track cluster (188 lines), verified no live importer first:
- `bench/exa/searcher_unbrowse.py` — TOY sync Searcher interface, superseded by `unbrowse_searcher.py` (WAVE-02).
- `bench/exa/score_extract.py` — extraction track disarmed as NON-reproducible (golden markdown licensing-excluded).
- `bench/exa/corpus.extract.jsonl` — toy 3-URL corpus for the disarmed track.
Kept: `unbrowse_searcher.py` (exa-suite adapter), and all of `bench/browsecomp/` (the live SERP track).

## Verdict
Off-grader spine (gates 4,5,6) is integrated and green end-to-end. The benchmark-win axis (gates 1,2)
is the only unruled territory, blocked solely on grader funding. No integration break → Step 7 unblocked.
