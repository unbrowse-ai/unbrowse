# snapshots/ — frozen inputs for deterministic scoring

Two kinds of file live here, and each is labeled by its name:

- `resolve_*_fixture.jsonl` — **HAND-AUTHORED gold**, not a live capture. Used to prove the
  deterministic scorers end-to-end. A gate run over a fixture is stamped `source=fixture` and
  is NOT an unbrowse benchmark score.
- `resolve_*_live.jsonl` (when present) — real captured `unbrowse eval resolve` output from a
  live `unbrowse go` session. Only gate runs over live captures are stamped `source=live` and
  count as scores.

As of this writing only the hand-authored fixture exists; live `eval resolve` returns
`no_active_session` without a browse session (see ARCHITECTURE.md, layer-4 preview wiring).
