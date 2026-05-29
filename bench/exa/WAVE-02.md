# WAVE-02 — benchmark reproducibility audit + real adapter (2026-05-29)

Cloned `github:exa-labs/benchmarks` (MIT) and read the actual harness. This wave
is an HONEST CORRECTION of WAVE-01's plan, not a score. Two fake-green traps in
the prior plan, both now disarmed:

## Correction 1 — WebCode *Contents* is NOT reproducible (do not chase 82.8)

`webcode-benchmark/.gitignore` excludes `data/contents/golden_markdown.jsonl`
("not included for licensing reasons"; you must self-generate it via a cloud
render pipeline). `code_contents.jsonl` ships URLs only. **Therefore any contents
score is graded against OUR self-built golden — non-comparable to Exa's published
82.8.** WAVE-01 clearing 82.8 on a 3-URL toy corpus proved nothing on this suite,
and even the full 250-URL run can't be a head-to-head win. Drop contents as a
"beat Exa" target.

## Correction 2 — the REPRODUCIBLE WebCode targets ship expected answers

| eval | rows | ships answers? | unbrowse verb | TARGETS beat |
|---|---|---|---|---|
| RAG (`evals.rag`) | 307 | ✅ `code_rag.jsonl` | search()+extract() synthesis | groundedness > 79.4 |
| Highlights (`evals.highlights`) | 250 | ✅ `code_highlights.jsonl` | extract() in-doc retrieval | > 94.8 / 93.2 (hardest) |
| Contents (`evals.contents`) | 250 | ❌ golden excluded | — | NOT reproducible |
| E2E (`evals.e2e`) | 33 | dataset only | — | sandboxed coding tasks |

Reproducible public-dataset Tier-2 targets stay as pinned in TARGETS.md:
**BrowseComp** (`perplexityai/search_evals` suite=browsecomp, arxiv:2504.12516,
beat > 0.336 — the named parallel track), SimpleQA (> 0.874 / 0.7124), FRAMES (> 0.881).

## Correction 3 — the real Searcher interface (WAVE-01 adapter used a toy shape)

Verified `shared/shared/searchers/base.py`: the ABC is **async** and returns
`SearchResult` dataclasses, NOT `extract(url)->str`. New correct drop-in adapter:
`bench/exa/unbrowse_searcher.py` (`UnbrowseSearcher`, modeled on `claude.py`).

## What is REAL this wave (tested, not claimed)

- `unbrowse_searcher.py` matches the real ABC; `extract('https://example.com')`
  ran live async, RC=0, 527 chars, trace-noise stripped. Structurally correct.
- Keys: `OPENAI_API_KEY` present (ContentsGrader/RAG grader uses it). `EXA_API_KEY`
  absent — only needed for the *exa baseline column*, NOT for the unbrowse searcher.

## HONEST GAPS (next waves, no box ticked without a real number)

1. **`unbrowse fetch` returned raw HTML, not markdown, for example.com.** The
   grader expects markdown; feeding HTML would score low. Confirm the markdown
   path (flag? page-size threshold?) or post-convert in the adapter BEFORE any
   Highlights/RAG run. This is the cache/loop (`extract()` JS-render escalation) node.
2. **BrowseComp track has ZERO infra.** Clone `perplexityai/search_evals`, wire
   `UnbrowseSearcher` as the backend, run suite=browsecomp with the OpenAI grader,
   record the real accuracy vs 0.336. This is the named "browsecomp in parallel" goal.
3. Run `evals.rag --searchers unbrowse --limit N` and `evals.highlights` for real
   baselines; only tick seal against the agent-judged real number.

The exa repo is cloned ephemerally at `/tmp/exa-bench`; treat it as re-cloneable.
The persistent artifacts are this file + `unbrowse_searcher.py`.
