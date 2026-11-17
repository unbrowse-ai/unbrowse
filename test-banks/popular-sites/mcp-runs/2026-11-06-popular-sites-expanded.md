# Expanded public batch: 2026-11-06

Fifty sites from `sites.json`, all public search reads: a seeded draw of 42 not tested before, plus the 8 sites that
failed or needed fixes on 2 November. We drove them through the node's agent API, the same primitives the MCP tools
call, with `run_bank.py`. No login, no account, no purchase, no challenge solved. Metadata:
[2026-11-06-popular-sites-expanded.json](2026-11-06-popular-sites-expanded.json).

**Node.** A debug build of unbrowse-core `main` at `87a205de`, which reports version 0.1.0. It ran as a scratch node, on
its own port, home, `TMPDIR` and Anvil, off the peer network, with an unfunded wallet. The node did not change during
the run. The runner did: see "How far to trust this run".

**Method.** The plan's steps as changed in this PR ([MCP_TEST_PLAN.md](../MCP_TEST_PLAN.md)): four values per site in the
market's language, a nonsense value made for this run (`zqhxccsxbtfv`), a new recheck of the first value, and
`unbrowse_open` on each site's link. The runner compares each site's answers with each other and suggests an outcome. I
read the answers and called the outcome. `suggested` and `classification` both stay in the JSON. They differ on 23 sites,
and each difference has its reason in `note`.

**The browser never reached the screen.** Headless Chrome ran through a guard that refuses any launch without
`--headless`. `lsappinfo` didn't list its process, and a sampler found no scratch Chrome visible to LaunchServices all run.

## Outcomes

| Site | Market | Outcome | Judged | What happened |
| --- | --- | --- | ---: | --- |
| pypi.org | | **pass** | 0 | Retest. Learned on the first ask, all five checks right |
| ebay.de | DE | **pass** | 0 | Fahrrad, Kaffeemaschine, antike Wanduhr; "Keine exakten Treffer gefunden" for nonsense |
| postgresql.org | | **pass** (preexisting) | 0 | An exploratory walk had learned this route, so it measures replay |
| nasa.gov | | **pass** | 0 | Real results; nonsense finds 19 OCR-noise documents, the site's loose match |
| mayoclinic.org | | **pass** | 0 | Real results; its header says 10482 for nonsense, the site's loose match |
| pexels.com | | **pass** | 0 | The site's search API, but `page=2` is fixed in the route (finding 11) |
| usatoday.com | | **pass** | 0 | Real headlines per value |
| canva.com | | **pass** | 0 | Real templates per value, `A: []` for nonsense |
| substack.com | | **pass** | 0 | Real posts per value, `results: []` for nonsense |
| wordpress.com | | **pass** | 0 | The support search API, `total: 0` for nonsense |
| accuweather.com | | **pass** | 0 | Real locations per value |
| foodnetwork.com | | **pass** | 0 | The second sighting made `/search/{path[1]}`; two values read by hand in the site's dashed form |
| mastodon.social | | **pass** | 0 | `/api/v2/search`, all lists empty for nonsense |
| archive.org | | **pass after judging** | 1 | Retest. Learned the API on the first ask; the default fields hid the hits |
| target.com | | **pass after judging** | 1 | Retest. Learned the search call on the first ask; 30 products per value after fields. Nonsense answers 24 unrelated items, read as the site's fallback and not confirmed against its page |
| itch.io | | **pass after judging** | 1 | `/autocomplete` first, then the search page |
| amazon.co.jp | JP | **ok_but_wrong** | 1 | A 252-byte settings blob; `fields.more` empty |
| asos.com | | **ok_but_wrong** | 1 | A fixed category call, then a settings blob |
| huawei.com | | **ok_but_wrong** | 1 | Page labels, then a shell |
| mi.com | | **ok_but_wrong** | 1 | First ask header-footer; second ask the real search; the judgment made it worse (finding 7) |
| kubernetes.io | | **ok_but_wrong** | 1 | A shell for every value; results render client-side |
| ieee.org | | **ok_but_wrong** | 1 | Breadcrumbs, then a shell |
| vanguard.com | | **ok_but_wrong** | 1 | The search rides in `#q=`, which no server sees |
| minecraft.net | | **ok_but_wrong** | 0 | First ask `/experiment/config.json`; the second ask learned the real search unaided and a later pass read right on all five |
| aljazeera.com | | **ok_but_wrong** | 1 | Feature flags, then a breaking-news call |
| wp.pl | PL | **ok_but_wrong** | 1 | An obfuscated blank call, then a page the same for every value. URL guessed |
| pinterest.com | | **ok_but_wrong** | 1 | Asked for garden, it answers kitchen (finding 2) |
| makemytrip.com | IN | **ok_but_wrong** | 0 | A locale file, then a page saying `200-OK`. URL guessed |
| dailymotion.com | | **ok_but_wrong** | 1 | `Search:None` for every value (finding 2) |
| allrecipes.com | | **false failure** | 0 | Retest. Three values right; the site's 404 for nothing found counts as an error |
| mysql.com | | **fail** | 0 | `how: browse`: a consent dialog disables the search box. I didn't drive it: a consent choice writes to the site |
| discord.com | | **fail** | 0 | The learned route failed its first call, then read right on later values |
| sberbank.ru | RU | **fail** | 0 | `ERR_CERT_AUTHORITY_INVALID`. The site's certificate, no node bug |
| reddit.com | | **blocked** | 1 | Retest. Reddit's network block, returned as `ok: true` (finding 3) |
| etsy.com | | **blocked** | 0 | Retest. Walks refused, then the node asked for a window |
| bestbuy.com | | **blocked** | 0 | Retest. The country gate, as on 2 November |
| ebay.com | | **blocked** | 1 | Retest. Search right after one judgment, then 403 on the fifth call |
| britannica.com | | **blocked** | 0 | Walks refused, then the node asked for a window |
| loc.gov | | **blocked** | 0 | The same |
| hilton.com | | **blocked** | 0 | The same |
| google.co.jp | JP | **blocked** | 0 | The same |
| roblox.com | | **blocked** | 0 | The same on the second ask; the first ask failed with a socket directory error, cause not found |
| marriott.com | | **blocked** | 0 | Learned a route of 39 steps; step 1 answers 403 |
| sogou.com | CN | **blocked** | 0 | The site sent the page to `/antispider/` |
| youku.com | CN | **blocked** | 0 | The walk saved the anti-bot call as the route |
| bild.de | DE | not applicable | 0 | Scouted: the search box hands the query to an AI chat on `hey.bild.de` |
| vivo.com.cn | CN | not tested | 0 | My URL is a 404 page; I observed no search URL |
| chase.com | | not tested | 0 | The same |
| hbo.com | | not tested | 0 | The same |
| service.gov.uk | UK | not tested | 0 | My URL was refused, and this host is a home for services with no search URL observed |

**Counts.**

| Outcome | All 50 | 42 new | 8 retests |
| --- | ---: | ---: | ---: |
| pass | 13 | 12 | 1 |
| pass after judging | 3 | 1 | 2 |
| ok_but_wrong | 13 | 13 | 0 |
| false failure | 1 | 0 | 1 |
| fail | 3 | 3 | 0 |
| blocked | 12 | 8 | 4 |
| not applicable | 1 | 1 | 0 |
| not tested | 4 | 4 | 0 |

- 45 sites had a search tested. Of those, 13 answered right with no help (29%), 3 more after one judgment each, and 17
  didn't answer right (13 ok_but_wrong, 3 fail, 1 false failure). 12 were blocked.
- Of the 33 sites the node reached past the door, 16 ended right.
- 16 judgments landed; 2 more found the route already gone. No site passed on more than one.
- Local-market sites did worst: of the 11 non-GLOBAL sites, 1 passed (ebay.de).
- 283 checks and 283 calls in the record. A further 22 calls are voided (see below), and about 30 more were scouting or
  hand reads. `paid_usdc` stayed empty on all of them.

## Links

- **`unbrowse_open`, 68 opens across 50 sites:** none added an activity line, a call or a browser launch, and none paid.
  An unlisted route never showed.
- **Malformed links:** the node refused 1,224 of 1,224 (18 forms on each pass): a port, a login, a query, a fragment,
  non-ASCII and percent-encoded hosts, paths that aren't entry ids, over-long links.
- **Sound forms:** upper case and a trailing slash answered 200 on 49 of 50 sites. `unbrowse://service.gov.uk` answers
  400 "that link names no site": it is a public suffix, as `gov.uk` is, and `unbrowse://www.service.gov.uk` works.
- **The `link` field works on a local chain.** A node off the network can't list (`this node is off the network`), and a
  route learned while off stays local for good, so this needed a second scratch node with `peer_network` on and an
  empty ads folder. It held no outside connection. Before listing, `/v1/routes` had no `link`. After listing on its Anvil
  it read `unbrowse://mastodon.social/0x0a95…f5f5`. Opening that showed the route and added 0 calls; opening the site
  listed it; another entry, or the same entry under another site, showed 0 routes. This shows the node's code on a
  private devnet and says nothing about a live network.

## Compared with 2 November

The two runs differ in state, so read this table with care. On 2 November the bank ran on the owner's installed node with
a warm browser profile, and a window could open. This run started cold on a scratch node, and a window could not open.
Both ran from Singapore. Etsy and Reddit may read worse here for those reasons alone, so neither is proof of a node
regression.

| Site | 2 Nov | 6 Nov | Reading |
| --- | --- | --- | --- |
| pypi.org | pass after retry | pass | **Improved.** The first walk learned it |
| target.com | fail, 4 judgments, pass after a fix | pass after judging, 1 | **Improved.** The search call came on the first ask; only the fields needed help |
| archive.org | fail, 2 judgments, pass after a fix | pass after judging, 1 | **Improved.** The same |
| ebay.com | pass after judging, 2 | blocked, 1 | **Mixed.** One judgment found the search; then the new recheck drew a 403 that the old four checks never reached |
| allrecipes.com | pass, false failure | false failure | **Unchanged.** The 2 November message fix doesn't reach it (finding 8) |
| bestbuy.com | blocked by a region gate | blocked by a region gate | **Unchanged** |
| reddit.com | pass after retry | blocked | **Worse here.** Cold profile; the node now says `ok: true` on the block |
| etsy.com | pass after retry | blocked | **Worse here.** 2 November's second walk passed; here the walk ended at the window the guard refused |

## Findings for the node

None of these are fixed: this PR changes no node code. Most serious first.

1. **A walk opens a window by itself, with no setting to stop it.** A refused walk goes to a clean browser, then to a
   headed one (`next_after_refusal` and `Next::Person` in `core/src/session.rs`). A walled step reopens with `--headed`
   (`mint.rs`). An agent calling `unbrowse_do` triggers it with no person asked. The guard refused 21 headed Chrome
   launch attempts and 45 `--headed` commands, on at least 7 of these 50 sites. Each would have put a window on the owner's
   screen. Where a window launch fails, the walk falls through to the CLI path, whose `pass_challenge` clicks "Verify
   you are human". Refusing that click was part of the guard; it fired 0 times here, so no page offered the box.

2. **The input never reaches the call that holds the answer, and the node says `ok: true`.** An agent gets the wrong
   thing and has no way to tell.
   - Pinterest: `q=garden` answered kitchen pins ("kitchen" 124 times, "garden" 6). `q` feeds step 1, and the
     `BaseSearchResource` call keeps its recorded `data`.
   - Dailymotion: `variables.query` is empty in the GraphQL body, and every value answers `Search:None`, `edges: []`.
   - ASOS: an input `q` on a fixed category call changes nothing.

3. **A blocked, blank or missing page is learned as a route and answers `ok: true`.**
   - Reddit: the walk's own score said "0 bytes of data" and "0 records", the node saved the route anyway, and it
     answers `{title: "Reddit", text: ""}` for any query in about 40 ms. The browser shows a page with only a "File a
     ticket" link. Its recorded status is 200.
   - Youku: the route is the anti-bot call `punishTextFetch`.
   - Vivo and Chase: the page I gave was a 404, and the node learned a call from it and answered `ok`.

4. **A wrong verdict binds to one query, not the page.** `page_key` keeps query values (`store.rs`), so a verdict on
   `q=rust programming` doesn't cover `q=sourdough`. On Reddit, Kubernetes and Amazon JP the judged URL went to hands,
   and the next value called the same wrong route. Input values shouldn't be part of the key.

5. **The default fields miss the records, and `fields.more` can't lead you to them.** archive.org's `data` is request
   metadata, and `fields.more` lists 20 of 175 paths in document order with no hit among them. I found `hits` only through
   `["*"]`. Target's defaults are brands and ids, not product names. Amazon JP's `fields.more` is empty. This is 2
   November's finding 10, still open.

6. **An answer can say the caller's IP address back to the agent.** archive.org's default `data` includes `client_id`,
   which holds this machine's public IP. It reached an agent by default and could reach a shared answer or a report. The
   runner now scrubs addresses and refuses a report that holds one.

7. **The first walk often takes site chrome, and judging can make it worse.** Minecraft took `/experiment/config.json`,
   Mi `header-footer`, MakeMyTrip a locale file, Huawei page labels. On Minecraft and Mi the second ask found the real
   search unaided. On Mi a wrong verdict on the first route then lost that: the next ask learned a shell and called
   it for every value, though a right route existed. Judging the first route also failed with 404 on Minecraft and
   MakeMyTrip, where the second learn had already retired it, so an agent can't judge the answer it was given.

8. **A no-results 404 is still a failure, and the message no longer says why.** Allrecipes' error stops at the page's
   navigation ("Skip to content Allrecipes Search…"), before any no-results words, so an agent can't use the fix from 2
   November's finding 6. The node also writes that page's HTML to its log.

9. **A route replays steps its `write: false` and `path` don't show.** Pinterest's 9 steps include `POST
   …/ActivateExperimentResource/create/`. Dailymotion's 8 include four analytics POSTs to `dm-event.net` and a token
   request. Marriott's 39 include analytics. `path` shows only the last call, and the agent API shows no steps. See
   "What went wrong in this run".

10. **A browser outlives a failed walk.** After Etsy's fallback, 9 Chrome processes stayed up until I closed them, at
    least 3 minutes later, with the page still open. A second Chrome also failed on one profile (`SingletonLock`, on
    service.gov.uk).

11. **Smaller.**
    - Pexels' route fixes `page=2`, so it answers the second page of results, probably from the walk's own scrolling.
    - Raw spaces in a path value find nothing (Food Network wants dashes), and nothing tells an agent.
    - `unbrowse://-example.com` answers 200 with site `-example.com`, which is no valid host.
    - `unbrowse://xn--pple-43d.com` answers 200. Its host is Cyrillic "аpple" in punycode. `routelink.rs` refuses
      non-ASCII so a look-alike can't pass. Punycode gets past that rule, though it shows as `xn--…` unless a client
      decodes it.
    - `takes_keychain_key` compares against `$HOME`, so a process with `HOME=<x>` and `UNBROWSE_HOME=<x>/.unbrowse` takes
      the owner's Keychain key, so a scratch node with that folder name runs as the owner. Read from the code; I didn't run it.

## Weak spots found in the bank's logic

All fixed in `MCP_TEST_PLAN.md` and `run_bank.py`, with tests.

1. **`mentions_value` proved nothing.** It searched the whole page, so a query echo counted. On 2 November, 6 of the 9
   sites with nonsense evidence "mentioned" it, and Best Buy's country gate mentioned all four values. Answers are now
   compared with each other.
2. **`records` wasn't a result count.** It read 21 to 83 for nonsense on sites that found nothing.
3. **A wrong input name passed.** The node doesn't send it, and answers `ok` with the route's default. `ignored_inputs`
   now fails the check.
4. **A blank page passed the nonsense check.** A page empty for every value "finds nothing" for nonsense too.
5. **`pass_after_retry` hid failures.** The plan allowed it for timeouts, but 2 November used it on a 403 and on "200
   with nothing". Only a timeout retries now.
6. **A fix could count as a pass.** The node was rebuilt four times on 2 November, and its counts added passes across
   builds. One version now serves a whole run.
7. **Judging had no limit.** Any site passes in the end. The limit is three judgments, reported apart from first-ask passes.
8. **Fresh meant "no route with this goal".** A route answers a page under any goal, so fresh now means no route for the site.
9. **The nonsense word was fixed and public.** A code search finds it in this repository. Each run now makes its own.
10. **The sample was hand-picked, and two categories could never come up.** `government_health` and `consumer_technology`
    have no search candidates. The draw is seeded across all 14 categories.
11. **The plan named no rates, and no closed list of outcomes.** It has both now, and the report refuses anything off the list.
12. **The plan said to run on the current node.** Tests rewrite routes and a judged route can list. It now requires a
    scratch node and names the traps.
13. **`write` trusted one label on one call.** See finding 9.

Reading also beat the new rule. It passed itch.io's `/autocomplete` until I read the path, and it took Huawei's country
menu for a gate. Both are fixed, and the rule stays a suggestion.

## How far to trust this run

- **The rule changed as I read.** Each fix came from reading an answer, more than a dozen in all, and sites run before a
  fix keep the older suggestion. That is why `suggested` differs on 23 sites. On 9 checks I corrected a stored outcome to the fixed
  rule and marked it `rule_corrected`. The site outcomes are my reads, not the rule's.
- **One reader.** Nobody checked my reads. 13 of the passes carry one person's judgment on samples of up to 1,500
  characters per answer.
- **Blocked means blocked for a cold, windowless browser from Singapore.** A window or a warm profile might pass some of
  the 12. By rule I never tried.
- **The node retries a refused walk in a clean browser inside one call.** I can't turn that off, and it happened. I
  counted those sites as blocked and tried nothing further on them.
- **Guessed URLs.** Most `known` URLs came from memory. Four were wrong enough to leave a site untested, and wp.pl and
  MakeMyTrip are guesses I didn't scout, so their `ok_but_wrong` may say more about my URL than the node.

## What went wrong in this run

- **Pinterest's route ran 7 times before I read its steps,** so its `ActivateExperimentResource/create/` POST went out
  with each: a guest experiment activation, no account. Dailymotion's route ran 9 times with its analytics POSTs, and
  Marriott's 4. The runner reads steps now and holds such a route before its second call. A `write: false` label
  on the route is why the stop rule didn't fire.
- **22 calls are voided.** A shell error meant three judgments never ran, so I removed the 15-call "after judge" pass that
  followed; the other 7 were Mi and Huawei on URLs I then corrected.
- **Marriott's 403s.** The runner made three more calls after a 403 before I fixed it to stop on one, against the plan's
  own rule. eBay's and Marriott's blocks are the only ones this touched.
- **A runner crash lost service.gov.uk's first pass.** It ran again, and the runner now saves before the link check.
- **Scouting typed harmless queries** into Bild's and Mi's search boxes, through `unbrowse_browse`.
- **One Chrome ran outside a node,** on `about:blank`, to test focus before the run.

## Not done

- A live-network listing, `how: network` or a paid route: the scratch node stayed off the network.
- Any login, write or pagination check.
- The MCP layer itself: the run used the agent API under it.
- `how: browse` by hand past a consent dialog (MySQL) or into a client-rendered search (Kubernetes, IEEE, Vanguard).
- The 350-odd sites still without a route test.
