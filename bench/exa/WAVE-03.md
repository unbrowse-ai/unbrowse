# WAVE-03 — extraction→markdown verified + small-doc leak fixed (2026-05-29)

Ralph-loop iteration toward the Exa/BrowseComp benchmark goal. This wave settles
the extraction-quality blocker that WAVE-02 flagged, with live evidence — and
honestly disarms it as half false-alarm, half real bug.

## Disarmed — WAVE-02 gap #1 was a <1KB-threshold artifact, NOT a broken pipeline

WAVE-02 said "`unbrowse fetch` returned raw HTML, not markdown, for example.com."
Tested live on the shipped binary (v7.0.2) against a REAL >1KB page:

    unbrowse fetch https://httpbin.org/html   →  "# Herman Melville - Moby-Dick" + prose, 0 raw HTML tags

So the HTML→markdown (turndown) conversion in `runSandboxCore` (src/cli.ts ~L2726)
**works on real content**. The adapter `bench/exa/unbrowse_searcher.py`'s
`extract()` is benchmark-ready for normal pages — the grader gets markdown.

## Real fix shipped — short full HTML documents no longer leak raw HTML

Root cause of the example.com case: `isHtmlString` required `s.length > 1024`
before converting. example.com's body is **528 bytes**, so a complete HTML
document fell through the size gate and printed raw `<!doctype html>…`. Short
real pages (API doc snippets, brief articles — which graders DO hit) leaked HTML.

Fix (src/cli.ts, `runSandboxCore`): a full-document marker
(`<!doctype html` / `<html` / `<head` / `<body`) now forces conversion regardless
of size; the 1024 gate still guards bare fragments that merely contain an
incidental tag (so JSON/plain-text is untouched).

LIVE-VERIFIED from source:

    bun src/cli.ts fetch https://example.com   →  "# Example Domain\n\nThis domain is for use…", 0 raw HTML tags  (was raw HTML before)

Gate: `bun test browse-markdown-structured-header + extraction-sanitize-to-json` →
12 pass / 0 fail. Change is a pure predicate inside the fetch path; JSON/text
responses (no doctype/`<body>`) are unaffected.

## HONEST GAPS (unchanged — next nodes, no box ticked without a real number)

1. **BrowseComp track still has ZERO infra** (WAVE-02 gap #2). Clone
   `perplexityai/search_evals`, wire `UnbrowseSearcher`, run suite=browsecomp with
   the OpenAI grader, record real accuracy vs 0.336. This is the named
   "browsecomp in parallel" goal and is now unblocked on the extraction side.
2. **No real RAG/Highlights baseline yet** (gap #3). Run `evals.rag --searchers
   unbrowse --limit N` + `evals.highlights`; tick seal only against the
   agent-judged real number.
3. The fix lives in source only; it reaches the published binary via the normal
   release pipeline, not a local install.
