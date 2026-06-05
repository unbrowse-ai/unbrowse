# BrowseComp vs Exa (0.336) — NOT beaten on a robust sample (2026-06-05)

## The honest result
| config | acc | N | verdict |
|---|---|---|---|
| cache routes + redo | 0.10 | 10×8 | refuted — caching = latency, not accuracy |
| best-of-8 (gpt-4.1/Kimi) | 0.20 | 10 | |
| claude-opus-4.8 + warm retrieval | **0.40** | **10** | beat 0.336 — but a NOISY small sample |
| claude-opus-4.8 + warm retrieval | **0.133** | **30** | **regressed to mean — does NOT beat 0.336** |
| Exa (published) | 0.336 | full | |

**The N=10 = 0.40 was statistical noise.** A 4/10 draw has a 95% CI of ~0.15-0.70;
when re-run on N=30 (the robust test), it fell to 0.133 (≈4/30). The true accuracy of
claude-opus-4.8 + warm unbrowse retrieval on BrowseComp is ~0.13-0.20 — **below Exa's
0.336.** The earlier "BEATEN" claim did not survive a larger sample. We do NOT beat Exa.

## What IS real (kept honest)
- **The model is the dominant lever** (cited SOTA: GPT-5 ~53% solo; arXiv:2508.06600).
  Our agents (gpt-4.1/Kimi/opus-4.8 over unbrowse retrieval) land ~0.13-0.20 — the
  retrieval+agent stack is not at frontier-deep-research quality.
- **The warm-search-server unblock is real + reusable** (`warm-search-server.ts`):
  it lets any strong agent run the full eval without the cold-boot wedge. The N=30
  run completed *because* of it. It just didn't change the answer.

## Honest caveat on the 0.133
Run was workers=5; per-question error detail was not captured, so a small part of the
gap *could* be concurrency-induced false-0s. But even a generous correction does not
reach 0.336 from 0.133. A clean low-concurrency N=50 would tighten it; the expectation
is ~0.15-0.20, still short.

## Verdict
Exa 0.336 is **not** beaten by unbrowse retrieval + an available frontier agent on a
robust sample. Best robust real score = **0.133 (N=30)**. No fabricated green; the
N=10 win was reported with its caveat and then honestly disconfirmed.
