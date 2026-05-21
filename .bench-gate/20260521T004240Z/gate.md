# Bench-Gate Verdict vs Baseline — 20260521T004240Z

- **gate**: **FAIL**
- cli_version: mcp:4bc78379
- baseline_run: _(unset — freeze with `bun run bench:gate:freeze` after a canonical run)_
- baseline_cli_version: n/a
- index_coverage: **77.8%** (42/54 indexable)
- retrieve_coverage: **39.0%** (23/59 retrievable)
- hostile-lane suspicious: 0 (new vs baseline: 0)

## Checks
- ❌ **index_coverage >= floor** — 77.8% vs floor 80.0% (42/54)
- ❌ **retrieve_coverage >= floor** — 39.0% vs floor 65.0% (23/59)
- ❌ **anchor lane must pass** — 3 anchor probe(s) failing: 002_anchor_https___www_npmjs_com_package_openai[idx=INDEX_FAIL_NO_ENDPOINTS,ret=RETRIEVE_FAIL_ERROR_BODY], 006_anchor_https___en_wikipedia_org_wiki_Transformer_(deep_learning_arc[idx=INDEX_PASS,ret=RETRIEVE_FAIL_ERROR_BODY], 009_anchor_https___pypi_org_project_anthropic_[idx=INDEX_PASS,ret=RETRIEVE_FAIL_WRONG_SHAPE]
- ✅ **no per-probe PASS→FAIL regression** — no per-probe baseline frozen yet (informational)
- ✅ **no new hostile-lane suspicious** — none

## By-lane breakdown
| Lane | index PASS / indexable | retrieve PASS / retrievable |
|------|------------------------|------------------------------|
| anchor | 10 / 11 | 8 / 11 |
| semantic-rank | 4 / 8 | 1 / 8 |
| graphql | 4 / 6 | 3 / 6 |
| ssr-list | 5 / 10 | 3 / 10 |
| auth-gated | 5 / 5 | 0 / 6 |
| hostile | 11 / 11 | 7 / 12 |