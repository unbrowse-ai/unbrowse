# Bench-Gate Verdict vs Baseline — 20260521T010031Z

- **gate**: **FAIL**
- cli_version: mcp:d7475856
- baseline_run: _(unset — freeze with `bun run bench:gate:freeze` after a canonical run)_
- baseline_cli_version: n/a
- index_coverage: **81.1%** (30/37 indexable)
- retrieve_coverage: **43.2%** (16/37 retrievable)
- hostile-lane suspicious: 0 (new vs baseline: 0)

## Checks
- ✅ **index_coverage >= floor** — 81.1% vs floor 80.0% (30/37)
- ❌ **retrieve_coverage >= floor** — 43.2% vs floor 65.0% (16/37)
- ❌ **anchor lane must pass** — 4 anchor probe(s) failing: 001_anchor_https___news_ycombinator_com_[idx=INDEX_FAIL_NO_ENDPOINTS,ret=RETRIEVE_FAIL_ERROR_BODY], 002_anchor_https___www_npmjs_com_package_openai[idx=INDEX_FAIL_NO_ENDPOINTS,ret=RETRIEVE_FAIL_ERROR_BODY], 009_anchor_https___pypi_org_project_anthropic_[idx=INDEX_PASS,ret=RETRIEVE_FAIL_WRONG_SHAPE], 010_anchor_https___hub_docker_com_r_library_nginx_tags[idx=INDEX_PASS,ret=RETRIEVE_FAIL_ERROR_BODY]
- ✅ **no per-probe PASS→FAIL regression** — no per-probe baseline frozen yet (informational)
- ✅ **no new hostile-lane suspicious** — none

## By-lane breakdown
| Lane | index PASS / indexable | retrieve PASS / retrievable |
|------|------------------------|------------------------------|
| anchor | 9 / 11 | 7 / 11 |
| semantic-rank | 6 / 8 | 3 / 8 |
| graphql | 5 / 6 | 0 / 6 |
| ssr-list | 8 / 10 | 4 / 10 |
| auth-gated | 1 / 1 | 1 / 1 |
| hostile | 0 / 0 | 0 / 0 |