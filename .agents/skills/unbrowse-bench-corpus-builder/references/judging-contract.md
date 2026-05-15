# Agent-Judged Contract

The corpus only defines tasks. The harness collects evidence. The Codex agent renders verdicts.

For every probe, the agent must inspect:

1. `capture.meta.json` and `capture.html.excerpt` for discovery evidence.
2. `index.store.json` for stored skill evidence.
3. `resolve.shortlist.json` and `resolve.pick.json` for endpoint selection evidence.
4. `execute.input.json` for the exact query, skill, and endpoint executed.
5. `execute.response.raw` and `execute.meta.json` for retrieval correctness.

The validator may reject malformed corpus rows. It must not infer INDEX or RETRIEVE verdicts.
