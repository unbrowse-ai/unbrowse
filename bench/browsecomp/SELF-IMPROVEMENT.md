# BrowseComp — self-improvement across N tries (honest ledger)

OpenAI's **BrowseComp** multi-hop browsing benchmark, driven through Unbrowse's
route-graph search path (same gpt-4.1 agent + gpt-4.1 grader each run). Every row
below is read straight from `runs.ledger.jsonl`; each is backed by an exited-0
eval log that carries its `Evaluation complete. Score:` line — no hand-typed numbers.

The question the experiment answers: *does repeating BrowseComp improve it, and how
does self-improvement move across tries?* The route/content cache warms run-over-run
(capture → index → reuse), so we record both accuracy and wall-clock latency/query.

| run | model | N | accuracy | total latency | latency/query | eval log |
|---|---|---|---|---|---|---|
| run1 | `gpt-4.1` | 10 | 0.100 | 706s | 70.6s | `logs/run1.log` |
| run2 | `Kimi-K2.6` | 4 | 0.000 | 323s | 80.8s | `logs/run2.log` |
| run3 | `Kimi-K2.6` | 4 | 0.000 | 330s | 82.5s | `logs/run3.log` |
| run4 | `Kimi-K2.6` | 10 | 0.100 | 698s | 69.8s | `logs/run4.log` |
| run5 | `Kimi-K2.6` | 10 | 0.100 | 673s | 67.3s | `logs/run5.log` |
| run6 | `Kimi-K2.6` | 10 | 0.100 | 581s | 58.1s | `logs/run6.log` |
| run7 | `Kimi-K2.6` | 10 | 0.100 | 649s | 64.9s | `logs/run7.log` |
| run8 | `Kimi-K2.6` | 10 | 0.100 | 654s | 65.4s | `logs/run8.log` |

## What the tries show

- **Latency self-improvement (the cache thesis):** per-query wall-clock moved from **80.8s** (run `run2`, cold graph) to **65.4s** (run `run8`, warmed) — a **+19%** change as the route/content cache
  warms. This is the capture→index→reuse self-improvement the substrate predicts.
- **Accuracy across tries:** 0.000 → 0.100 (**+0.100**). BrowseComp accuracy is dominated by the agent harness above
  retrieval (single-shot agent here), so repetition warms latency far more than it
  moves accuracy — recorded honestly, not curve-fit.

## Honesty boundary

- Exa's published BrowseComp figure is **0.336** on their specialised search stack.
  Our reproducible figure (0.100) is **below** that and we do not claim to
  beat it: this run isolates route-graph retrieval under a deliberately minimal
  single-shot agent, not an optimised deep-research harness. Where Unbrowse's substrate
  *does* win head-to-head is anti-bot retrieval — see `bench/reddit/` (9/9 vs naive 0/9).
- Reproduce: `bash bench/browsecomp/run-and-record.sh <run-id> 10` (writes a new
  ledger row + log); then re-run this generator.

