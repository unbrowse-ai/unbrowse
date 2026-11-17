# Unbrowse MCP public batch 1 — 2026-10-28

Five sites from `sites.json`, all public search reads, through the local node's
`unbrowse_*` MCP tools only. No login, no writes, and no challenge was solved.
Metadata: [2026-10-28-public-batch-1.json](2026-10-28-public-batch-1.json).
The node version is not exposed by the MCP tools, so it is not recorded.

**Baseline.** An empty `unbrowse_search` before any goal call listed three local
routes (GOV.UK, Wikipedia, HN Algolia). None of the five sites below had a
route, so every goal call here tried a fresh goal route. Each search URL was
first observed with `unbrowse_browse`, labelled **scouting**. Those sessions
were already warm when the goal calls ran. Scouting learned
routes under its own goal text ("scout …"), separate from the goals tested.

| Site | Goal | Values | Fresh `unbrowse_do` | Replay `unbrowse_do` | Outcome |
| --- | --- | --- | --- | --- | --- |
| npmjs.com | search npm packages | react / express | `browse`: Cloudflare verification | not run | **blocked** |
| arxiv.org | search arXiv papers | protein folding / dark matter | `learned` `42794748fa16ee0c`, ok | `called`, same ID, ok | **pass** |
| theguardian.com | — | — | not run: site search goes to google.co.uk | — | **not tested** |
| huggingface.co | search Hugging Face models | whisper / stable-diffusion | `learned` `dccda83ed15d403b`, ok | `called`, same ID, ok | **pass** |
| merriam-webster.com | look up a word in Merriam-Webster | ephemeral / quixotic | timeout, then `learned` `e98c53199c1a5630`, ok | `called`, same ID, ok | **pass after retry** |

Direct `unbrowse_call` checks: npm scout route `ce869a6cac01d0c9` with `express`,
ok; Merriam-Webster `e98c53199c1a5630` with `laconic`, ok.

**Counts.** 5 sites: 2 pass, 1 pass after retry, 1 blocked, 1 not tested.
Goal checks: 3 learned, 3 called, 1 blocked (`browse`), 1 failed (timeout),
1 not run. In every replay the new value changed the result.

## Findings for the engine

1. **A beacon was kept as a write route.** Scouting Merriam-Webster stored
   `db3e926b4866c2c4`, a `POST` to `event.ay.delivery` with `write: true` and
   no inputs, during a read-only search. This is the "call reporting the page"
   class in `CLAUDE.md`. It was not called.
2. **The Wikipedia smoke replay was a false pass.** `bc6c42c23d187540` is stored
   as `GET /wiki/Planet` with no inputs, so the earlier `moon` replay could not
   search for moon even though the HTTP call returned `ok: true`. The original
   smoke report and test plan now distinguish transport success from semantic
   replay. The Merriam-Webster scout route parameterises a similar path
   segment (`/dictionary/{path[1]}`).
3. **Input names drift from the parameter they fill.** Examples: `Filter by name`
   (a form label) on Hugging Face, and `dictionary` for `?search=` on
   Merriam-Webster. Values still bound correctly on replay.
4. **Two of the three routes return page text, not JSON.** arXiv and
   Hugging Face routes return rendered page text. Merriam-Webster's route is
   the site's JSON autocomplete API.

The analytics and fixed-route defects are tracked as
[issue 24](https://github.com/unbrowse-ai/unbrowse-core/issues/24) and
[issue 23](https://github.com/unbrowse-ai/unbrowse-core/issues/23), respectively.
The patched node's separate [Wikipedia retest](2026-10-28-wikipedia-retest.md)
confirmed that the new route binds the query and returns distinct articles.
