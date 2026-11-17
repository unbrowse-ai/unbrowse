# Lundy bank run, 2026-11-02

Metadata only (no cookies, tokens, bodies or query URLs). Raw: `2026-11-02-lundy-bank.json`.

## Nodes

- Before: service `unbrowse-node` on release 13.4.1. Bank run on a podman source build of main `9c3ccda`.
- After: `fix/lundy-bank-2026-11-02` at `596311b` (local, unpushed), installed at
  `~/.local/opt/unbrowse-core/fix-596311b`, `current` points to it. Proof runs used that build on a node at
  127.0.0.1:7797 with its own home (network, telemetry and reports off), with fresh routes for the final pass.
- The service has not taken 7788 back yet. The main-9c3ccda node was OOM-killed at 12:47 (12.2 GB peak, from
  the headed Chromes leaked by fix 4's bug). The old `unbrowse-window` (started Nov 1 from 13.4.1) then
  respawned a 13.4.1 node on 7788, and the service now crash-loops on "address in use".
- Rollback: `ln -sfn main-9c3ccda` (or `13.4.1`) `~/.local/opt/unbrowse-core/current`, then restart the service.

## Baseline (31 sites, main 9c3ccda)

| outcome | n | sites |
|---|---|---|
| pass (learned, replay changed) | 10 | github, sourceforge, pubmed, wiktionary, imdb*, bandcamp, steam, itch.io, duckduckgo, unsplash |
| transport pass, constant answer | 1 | python.org |
| semantic fail (wrong call, ok:true) | 10 | archive, bbc, npr, aljazeera, techcrunch, rottentomatoes, ikea, craigslist, target, reddit |
| error | 3 | goodreads (redirect loop), openstreetmap (HTML answer), php.net (one route per value) |
| blocked (site) | 7 | pypi, britannica, bestbuy, stackexchange, lichess, apnews, ebay |

*imdb's answer never names the value (results keyed by IDs); it counted as a pass because the answer changed.
Batch 4 (ikea, craigslist, target, bestbuy, ebay, apnews, reddit) comes from the earlier run's notes; its raw
records were lost.

## Final pass (19 sites, 596311b, fresh routes, two values each)

Pass means both answers name the asked value and the answer changes between values.

| verdict | n | sites |
|---|---|---|
| pass | 15 | goodreads, openstreetmap, archive, bbc, techcrunch, rottentomatoes, sourceforge, pubmed, bandcamp, itch.io, duckduckgo, unsplash, github, steam, wiktionary |
| ok:true, value not in answer | 4 | aljazeera, npr, python.org, imdb |

Moved from fail to pass: goodreads, openstreetmap, archive, bbc, techcrunch, rottentomatoes (6).
All 10 earlier passes were re-run: 9 pass, and imdb is the same as at baseline (value never named). pubmed
regressed after fix 5 and fix 13 restored it.

## Fixes (one commit each, regression test each, fail-without verified unless noted)

1. 299bbdb: a cookie set on a redirect goes with the next hop (goodreads loop).
2. ae6759d: an HTML piece a call answers with is read as the page it belongs to (openstreetmap).
3. 3f86a1d: an argument written as JSON text means the list or object it spells (`pages`, `fields`,
   `inputs`). Fail-without not verified separately. Live: `pages` as JSON text ran 2 pages; `"[1, 2]"` was
   refused with a 400.
4. 216b105: a page that finishes after its call replied answers the next ask. Before, it was walked again on
   every ask and each challenged walk leaked a headed Chrome: 19 Chromes, OOM. Unit test only; no live proof.
5. d3aac64: a value is sent however the call encodes it (`apollo+11` is "apollo 11").
6. f98c394: a call that never sends or says back the asked value never answers the page (config blobs).
7. b4caa4c: a call asking for the value beside the page's address is not a beacon (archive's search).
8. e15366a: a search is never answered by one record that never says the value back. Guard only: on the live
   walk the real cause was fix 9.
9. ec3da66: the page's path handed on whole (`path=/search`) is no input (rottentomatoes ad slot).
10. dcf4a57: a restart starts the program that replaced this one (`<path> (deleted)`). Proven live on the
    proof node.
11. 0588646: a page whose state never says the search answers with what it renders (page_defaults).
12. 76b3e6a: a page whose embedded JSON is a scrap answers with the page read (bbc, rottentomatoes).
13. 596311b: a call answering markup earns nothing over its page (pubmed after fix 5).

## Unfixed

- php.net: the value ends up inside the redirect target's path (`/manual/en/function.strlen.php`), so each
  value gets its own fixed route.
- npr: answered by an Algolia POST whose search term is a form string inside a JSON body field. It is never
  made an input, so the route replays the recorded query.
- python.org: a plain replay of `/search/?q=` answers as the homepage. Cause UNMEASURED.
- aljazeera: a path-value page (`/search/ukraine`) where no call says the value back, so nothing counts as
  asked. Cause UNMEASURED (no capture).
- imdb: the answer is results keyed by IDs and never names the value; unchanged from baseline.
- reddit, ikea, craigslist, target: not re-run (UNMEASURED after the fixes).
- The 7 blocked sites are challenges or geo gates, not node bugs.
- Window: `unbrowse-window` respawns a node from its own install dir whenever 7788 stops answering, and
  races the service (see branch fix/window-leaves-service-node).

## Unit suite (podman, `cargo test --locked --workspace --no-fail-fast`)

- On 9c3ccda + fixes 1-3: 741 passed, 12 failed, 51 ignored.
- On 596311b: 747 passed, 12 failed, 51 ignored. All 12 are environment failures: 5 passkey tests need Chrome
  in the container, and 7 learn `learn_shop`/`replay_shop` tests run the host-built agent-browser (GLIBC_2.39
  missing in the container).
- Bank pytest (venv with requirements-browser.txt): 16 passed.
