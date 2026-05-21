# Bench-Gate Verdict vs Baseline — 20260520T235712Z

- **gate**: **FAIL**
- cli_version: mcp:74b17e08
- baseline_run: _(unset — freeze with `bun run bench:gate:freeze` after a canonical run)_
- baseline_cli_version: n/a
- index_coverage: **76.1%** (35/46 indexable)
- retrieve_coverage: **34.0%** (16/47 retrievable)
- hostile-lane suspicious: 0 (new vs baseline: 0)

## Checks
- ❌ **index_coverage >= floor** — 76.1% vs floor 80.0% (35/46)
- ❌ **retrieve_coverage >= floor** — 34.0% vs floor 65.0% (16/47)
- ❌ **anchor lane must pass** — 4 anchor probe(s) failing: 002_anchor_https___www_npmjs_com_package_openai[idx=INDEX_FAIL_NO_ENDPOINTS,ret=RETRIEVE_FAIL_ERROR_BODY], 005_anchor_https___github_com_search_q_anthropic_type_repositories[idx=INDEX_PASS,ret=RETRIEVE_FAIL_WRONG_SHAPE], 006_anchor_https___en_wikipedia_org_wiki_Transformer_(deep_learning_arc[idx=INDEX_PASS,ret=RETRIEVE_FAIL_ERROR_BODY], 009_anchor_https___pypi_org_project_anthropic_[idx=INDEX_PASS,ret=RETRIEVE_FAIL_WRONG_SHAPE]
- ✅ **no per-probe PASS→FAIL regression** — no per-probe baseline frozen yet (informational)
- ✅ **no new hostile-lane suspicious** — none

## By-lane breakdown
| Lane | index PASS / indexable | retrieve PASS / retrievable |
|------|------------------------|------------------------------|
| anchor | 10 / 11 | 7 / 11 |
| semantic-rank | 5 / 8 | 1 / 8 |
| graphql | 4 / 6 | 1 / 6 |
| ssr-list | 5 / 10 | 2 / 10 |
| auth-gated | 2 / 2 | 1 / 2 |
| hostile | 6 / 6 | 1 / 7 |