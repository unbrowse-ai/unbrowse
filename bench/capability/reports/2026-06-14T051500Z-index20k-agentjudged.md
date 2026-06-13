# Capability bench — agent-driven sweep over the 20k corpus (checkpoint)

**Date:** 2026-06-14 · **Driver:** agent-in-thread (resolve capture + semantic judgment) ·
**Corpus:** `bench/index20k/corpus.jsonl` (20,000 real domains, Cisco Umbrella top-1M, infra-filtered,
apex-deduped) · **Captured this checkpoint:** 223 sites · **Binary:** repo source (`unbrowse resolve`).

## Headline

The structural signal said **186/223 "covered" (83%)**. Agent judgment of the *full* artifacts
puts the honest read at **~50% relevant retrieval + ~33% document-only capture + ~17% timeout** —
and corrected one false alarm I nearly shipped. This is exactly why the bench must be agent-driven:
a `endpoint-found = covered` script can't tell relevant data from a document dump, and can't catch a
truncation confound.

## Coverage (223-site sample, agent-judged on full results)

| source | n | agent verdict |
|---|---:|---|
| `exa` (webcode-RAG) | 112 | **site-relevant retrieval** — brand/domain present in every full result. Real coverage via the search pipeline. |
| `direct-document` | 73 | **document capture** — the page HTML/text, relevant to the site, but *not* a structured data/listing endpoint. Weak/partial coverage. |
| `browse-session` | 1 | real browser capture. |
| `timeout` (18–25s cap) | 37 | miss within budget — mostly heavy SPAs (azure, adobe, outlook). An honest negative, not a failure. |

Genuine structured-endpoint hits (direct-fetch JSON like the HN control) were rare in this
Umbrella-head slice — the top of the list is dominated by infra/portal homepages that have no clean
listing API, so retrieval/document capture is the expected ceiling there.

## The methodological finding (why agent-driven matters)

My first pass flagged `source=exa` as **degenerate/irrelevant** — every result's first 70 chars were
an identical HubSpot CRM OpenAPI chunk (`/crm/objects/...`), and a brand-in-first-500-chars check
returned `irrelevant` for office.net, ezviz7, bing, msn… A structural classifier would have recorded
"96 false-covered, degenerate constant fallback."

That was a **truncation confound** (Ecclesiastes 3:1 — a single-window signal is not the truth). Re-judging
on the *full* result: 112/112 distinct hashes, and **every result is site-relevant** (brand/domain present).
The exa path is doing real, relevant retrieval. The only real artifact: a shared HubSpot CRM chunk
**over-ranks into nearly every RAG result** as a high-ranked element — ranking pollution, not a
coverage failure. Worth a follow-up in the searcher's ranking/dedup, low severity.

## Regression check (the shipped work this session)

- `resolve` contract intact after the capture-path changes (`fetch-ladder.ts` browser-error guard +
  `browse-index.ts` admission guard): the HN control returned **500 real story IDs, `source=direct-fetch`,
  zero poison markers**, and the new guard did **not** false-positive on real JSON.
- Across 223 captured artifacts: **0 poison markers** (no browser-error page indexed as an endpoint).
  The cache-poisoning fix holds at scale.

## Honest scope note

20,000 literal agent-driven resolves is a ~12-hour sweep at safe concurrency (measured: ~2.2 s/site at
8-wide, dominated by the timeout tail). This checkpoint ran a real 223-site agent-judged sample; the
corpus + capture harness (`bench/index20k/`) scale to the full 20k and write `results.jsonl`
incrementally, so the sweep can be resumed from any offset. No fabricated 20k-green: the number reported
is the number captured and judged.

## Open

- Searcher ranking: the shared HubSpot CRM chunk over-ranks across unrelated queries — dedup/penalize.
- Resume the sweep past offset 223 toward 20k when a long background window is available.
