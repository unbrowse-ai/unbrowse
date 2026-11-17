# Public batches 2–4: 2026-11-02

Fifteen sites from `sites.json`, plus Carousell from `future-targets.json`, all public search reads, through the node's agent API: the same primitives the MCP
tools call, driven by a script that records metadata and short answer samples. No login, no writes, no challenge
solved. Metadata: [2026-11-02-public-batches-2-4.json](2026-11-02-public-batches-2-4.json).

**Node.** 13.9.0-dev, built from unbrowse-core `fix/route-empty-and-names-2026-11-02` (PR #147, which adds
`unbrowse_judge`) and installed as `/Applications/Unbrowse.app`. The node was rebuilt four times during the run, as the
bugs below were fixed; each fix is a commit on that branch.

**Method.** The plan's steps, with what this run added to it (now in [MCP_TEST_PLAN.md](../MCP_TEST_PLAN.md)):

- Four values per site: two alike, a third unlike them (several words), and a nonsense value (`zqxjvbnmqw`).
- Every answer was read against its query (how many results, whether they mention the value), not taken from
  `result.ok`.
- An answer that was `ok` but wrong was judged with `unbrowse_judge` and the site asked again.
- No scouting: the first `unbrowse_do` went straight to the site's search URL, so "fresh" means a cold page.

## Outcomes

| Site | Outcome | Judgments | What happened |
| --- | --- | ---: | --- |
| bbc.co.uk | **pass** | 0 | All four values right |
| npmjs.com | **pass** (preexisting) | 0 | All four right; "0 packages found" for nonsense |
| pypi.org | **pass after retry** | 0 | First walk said "200 with nothing"; the second learned the search page. Fixed: a cold walk now learns on the first ask (finding 3) |
| reddit.com | **pass after retry** | 0 | Same flaky first walk; fixed the same way |
| etsy.com | **pass after retry** | 0 | First walk refused (403); the second learned the search page |
| github.com | **pass after fix** | 0 | The nonsense value failed as "not in the recorded shape" (see finding 4); passes on the fixed build |
| allrecipes.com | **pass, false failure** | 0 | Three values right; the site answers **404** for no results, which the node counts as failure |
| ebay.com | **pass after judging** | 2 | An image-carousel call, then a sign-up-banner call, then the search page: 126 prices, right replays, "No exact matches found" |
| imdb.com | **pass after judging** | 1 | The route was right but its default fields missed the titles; judged `right` with title fields. The no-results value is answered by a second route an earlier build learned |
| target.com | **fail, then pass after a node fix** | 4 | A store-locator route, experiment flags, the page's own state (no products), a recommendations call that fails. Its search call answers 1.2 MB, which the walk cut at 1 MB. Fixed (finding 8): it learns the search call on the first ask, and replays (water bottles, towels) |
| bestbuy.com | **blocked (region gate)** | 3 | Learned the "Select your Country" gate (from a Singapore address) as the search. Choosing United States in the browser showed results, but replays don't carry the choice, and the bot check then refused the walk |
| archive.org | **fail, then pass after a node fix** | 2 | An A/B-test call, then an empty page shell. Its search API passes the page's address along and was taken for a beacon. Fixed (finding 8): it learns the search API, and replays (Apollo 11, jazz) |
| stackoverflow.com | **blocked** | 0 | Cloudflare challenge; the node said so |
| goodreads.com | **blocked** | 0 | 202 hold, then requests that never complete |
| theguardian.com | not applicable | 0 | No first-party search page (`/search` is a 404) |
| carousell.sg (future target) | **pass after judging and node fixes** | 4 | The stored route answered the iPhone search with 0 listings (Certified tab). After one judgment the page went to hands. The marketplace URL then learned the empty page state and filter metadata. On the fixed build, once the page-state route was renamed, the marketplace URL learns the search API (`POST /ds/search/cf/4.0/search/`), which answers later searches (MacBook Air) |

**Counts.**
- 15 inventory sites: 2 pass, 3 pass after retry, 1 pass after a node fix, 1 pass with a false failure, 2 pass after
  judging, 2 fail (both pass after node fixes), 2 blocked, 1 blocked by a region gate, 1 not applicable.
- Carousell, outside the inventory: pass after four judgments and the node fixes.
- Of the 12 inventory sites with a search to test (the Guardian has none; two were blocked), 7 answered right
  without help (GitHub after a node fix), 2 more after judging, and 3 not at all on the first build. Of those,
  Target and archive.org pass after the node fixes; Best Buy stays behind its region gate.
- Five sites (eBay, archive.org, Target, Best Buy, Carousell) gave `ok` answers that weren't the search: 14 judgments
  between them.

## Findings for the node

Each fix is on the PR branch, with a test.

1. **`ok: true` is often not the answer.** An image carousel, a sign-up banner, an A/B-test assignment, a store
   locator, experiment flags, a country gate: each came back `ok`, and only reading the answer showed it. That is
   what `unbrowse_judge` is for. Before this run, though, a judgment didn't stick:
   - **Re-picking.** The learner re-picked the call it had just been told was wrong. It now passes over calls an
     agent rejected, matched by the route's own path pattern.
   - **Rename bypassed.** A renamed route still answered its old goal through `page_routes`, which matched on the
     site's own name. Agent-named routes are now found by their own words only, and the site's name matches no goal.
   - **Lost judgments.** A route judged right with fields was deleted by the next learn. Such routes are now kept,
     and `judge` refuses field paths the answer doesn't have.
2. **Walled steps could never run.** A step the site answers 403 is retried in the browser, through a program named
   `"in-process"` that doesn't exist. Every such step failed with "No such file or directory" (eBay's "a request of
   the route couldn't be made"). Fixed: it runs the node's browser program.
3. **The first walk on a cold site was flaky.** PyPI and Reddit rejected their first pick as "200 with nothing".
   A challenge loads the page twice, the first time empty, and the route took the first copy. Fixed: a copy that
   answered with nothing isn't the call.
4. **A page with several JSON blobs was read as the largest.** GitHub's empty search is smaller than its settings
   blob, so a search with no results failed. Fixed: a route reads the blob shaped like the answer it recorded.
5. **Browsing kept routes without saying so.** Leaving a page was learned after the reply, and a catch-up learn
   2 s later learned the page just opened under the old goal. Fixed: leaving learns before the reply, which names the
   route for the agent to judge, and opening a page sets off no catch-up.
6. **A no-results 404 is a failure.** Allrecipes answers an empty search with 404 and a page saying so. The node
   can't tell that from a broken route; the agent can, and now reads it: a failed call says the page's title and
   text ("No results for …") instead of its markup.
7. **A learn retired a route judged wrong for a page, and the verdict with it** (Carousell): the page then learned
   that route back. Every route an agent judged now outlives a learn. Fixed.
8. **The search call was in the walk, but couldn't win.** Target's search answers 1.2 MB of JSON, and the walk kept
   1 MB of any non-HTML body, so it didn't parse. archive.org's search API sends the page's address
   (`client_url=`), so the rule for calls that report the page made it noise. Fixed: JSON answers are kept whole
   up to 16 MB, and the site's own call whose answer says back the query isn't taken for a beacon.
9. **A verdict about the page's state outlives the state.** Best Buy's search page was the country gate until a
   country was chosen; judged wrong then, it stays passed over after. `right` with the URL takes it back.
10. **The default fields miss the records.** IMDb's route held the titles, but its defaults were image IDs. Judging
   the route `right` with `fields` fixes it per route; the node's own choice is still word matching.

## Not done

- Any login, write or pagination check.
- Re-running the earlier batch's arXiv and Hugging Face passes with answer evidence.
