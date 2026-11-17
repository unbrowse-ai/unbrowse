# Testing the bank through Unbrowse MCP

The 400 entries in `sites.json` are **candidate sites**, not 400 known API
routes. The HTTP and local Chrome results in this directory are separate from
Unbrowse route learning. Use the local Unbrowse MCP tools, or the same primitives
over a node's agent API (`run_bank.py` does this), for each site test; local file
tools may read fixtures and write reports. Work in small batches so each result
can be inspected before continuing.

## Limits

These hold for every public batch, and `run_bank.py` keeps them:

- At most 5 sites a batch, one site at a time, at least 4 s between calls to a
  site and 10 s between sites.
- At most 14 calls a site before judging, and at most 3 judgments a site. A site
  that needs more is recorded as what it is: judging is teaching, and with no
  limit any site passes in the end.
- A 429 or a rate-limit message stops that site at once. Nothing is retried past
  a block.
- One node version a run. A site tested on a build that later changed is tested
  again on the final build, or its result is reported as that build's alone.
- `paid_usdc` must stay empty on every check.

## Run it on a scratch node

`sh scratch-node.sh <folder>` does all of this, and CI runs the same script. Run the bank on a node of its own, never the owner's. Judgments rewrite routes, a
walk changes a site's browser profile, and a node that shares what it learns may
list a wrong route. The owner's real node also has a real wallet. Each trap below
was read from the code, and the first three reach the owner's machine:

- **The folder name matters.** `UNBROWSE_HOME` must not be `$HOME/.unbrowse`, even
  with `HOME` set to a scratch folder: a node in that exact folder takes the
  Keychain's root key and runs as the owner (`takes_keychain_key`). Use
  `HOME=<scratch>/home UNBROWSE_HOME=<scratch>/home/node`.
- **`TMPDIR` is shared.** Walks are captured under `$TMPDIR/unbrowse-node-walks`,
  one folder for every node of this user, and the mint's fallback deletes it. Give
  the node a `TMPDIR` of its own.
- **Windows open by themselves unless told not to.** A walk the site refused is asked
  again in a clean browser and then in a **headed** one (`Next::Person` in the engine),
  and a step the site walled reopens with `--headed` (`mint.rs`). Set `headless_only`
  in `settings.json` (or `UNBROWSE_HEADLESS=1`): such a walk then ends as `how: browse`
  or says why it can't. Also name a wrapper in `browser.json` that refuses any launch
  without `--headless`, so a window the setting missed is refused and counted.
- **A failed launch reaches a click.** A launch that fails falls through to the mint's
  CLI path, whose `pass_challenge` clicks "Verify you are human". That is the product's
  rule (spec §32); the bank's is that it never passes a challenge. Set `UNBROWSE_BROWSER`
  to a wrapper that refuses `--headed`, and `click` in a `learn_` session, which is only
  that path. Log every refusal: with `headless_only` on, a run should log none.
- **Checking a door that refuses headless.** `ALLOW_HEADED=1 sh scratch-node.sh <folder>` lifts both
  guards and runs the node with windows allowed (`UNBROWSE_HEADLESS=0`), so the mint's own retry in a
  window is exercised. That is a check by a person, not the bank's run: the bank stays headless and
  still never passes a challenge. Measured 2026-11-07: eBay answers a headless browser with its error
  page and a headed one with a challenge that clears itself in about ten seconds; OpenTable refuses
  Akamai at the door headless and serves results headed. Neither changes with
  `--disable-blink-features=AutomationControlled` or a different user agent: plain Chrome, headless,
  with no flags at all, is refused the same way.
- **Write settings before the first start.** `settings.json` needs `api_port`, and
  `UNBROWSE_PORT` must stay unset: it rewrites the file to the default. Also set
  `peer_network`, `auto_update`, `fetch_browser`, `passkeys` to false, `headless_only`
  to true and `share_routes` to `off`, and start the node under `env -i` so nothing of the
  owner's shell reaches it. Set `UNBROWSE_DEVNET_PORT`, `UNBROWSE_DEVNET_FORK=none`,
  `UNBROWSE_TELEMETRY=0` and `UNBROWSE_REPORTS=0`. Anvil is looked for under
  `$HOME/.foundry/bin`, so link it there.
- **Check before you run.** The port the node listens on, its root key in its own
  folder, and on macOS that its browser never appears: `lsappinfo info -app pid=<pid>`
  answers nothing for a headless Chrome, and `lsappinfo front` doesn't change.

## Public route test

Start with a site whose public search URL was actually observed. The existing
`browser-fixtures/wikipedia.json` and `browser-fixtures/govuk.json` provide
two examples. Draw new sites with `python3 run_bank.py sample --seed <date>`: it
takes three per category across all 14, a market not yet drawn first, in an order
the seed fixes, so a batch isn't a tester's favourites. It leaves out sites already
tested and those `future-targets.json` reserves. It ignores `scenario_candidates`:
that list marks no site in `government_health` or `consumer_technology` for search,
and some of them have one.

A fresh route means no route **for that site** was present before the first call:
a route answers a page whatever goal it was learned under, so an empty search for
the same goal proves nothing. A scratch node with no routes is a fresh state. Say in
`url_source` how far each URL can be trusted: `known` is the tester's memory of the
site, `previous_run` a past run's, `scouted` found with `unbrowse_browse`. `search-cases.json`
holds them. A `known` URL that lands on no search is scouted before the site is
called `not_applicable`. A case may declare `vary`, a second query parameter and the
value the replay ask gives it: a route that stored that parameter as a constant
cannot answer the varied ask and relearns instead, which the replay check reports.

For each site:

1. Record the site, exact goal, four harmless query values, and observed HTTPS
   URLs. The values are: a first and a second of the same kind (`requests`,
   `flask`), a third **unlike them** (several words, not a title or a name the
   site has a page for: `geospatial raster`), and a nonsense value that should
   find nothing, made fresh for each run from its seed (`nonsense_value`): a fixed
   word stops being nonsense once this file is public, as a code search finds it
   here. Values are in the language of the site's market. A `scenario_candidates` entry in `sites.json`
   is not proof that a search route exists. If discovering the URL requires `unbrowse_browse`,
   label that stage **scouting**; it may itself learn a route.
2. Call `unbrowse_search` with an empty query **before** the first goal call.
   Record whether a local route with the same goal already exists. If it does,
   label the case `preexisting` and test replay, not fresh discovery.
3. Call `unbrowse_do` with the goal and first URL. Record `how`, route ID,
   target host and path, method, input names, `result.ok`, and any error.
   Check that the requested value is bound to a route input: the input whose
   default is the value, with the name used for every later call. Then read the
   answer and record **evidence** (see below). `how: learned` with `result.ok: true`
   alone is a transport pass, not a search pass: the answer must hold results for
   this query. An answer that is `ok` but wrong (an empty list where the page shows
   results, suggestions, a banner, an A/B-test or image call, a page shell) is
   `ok_but_wrong`, never a pass; go to step 7. A route on another site's host is
   recorded (`route_first_party`), and read: it may be the site's search provider,
   or an advert. `how: browse` needs an observed interaction through
   `unbrowse_browse`; it is not a learned-route pass yet.
4. Call `unbrowse_do` with the **same goal** and second URL or the route's
   named input. A replay pass requires `how: called`, the same route ID,
   `result.ok: true`, and evidence that the second value changed the answer:
   different titles that mention the second value. A route with no bound input
   cannot pass a two-value search replay. Record a new `learned`, `browse`,
   error, or challenge as its own outcome rather than calling it a pass. A name
   the route doesn't take is not sent, and the call still answers `ok` with the
   route's default, so **a non-empty `ignored_inputs` fails the check**: the value
   was never asked.
5. Call `unbrowse_call` with that route ID and the **third** value. This checks
   direct replay, separately from goal selection, and that the route
   generalises past values like the first. Record the same evidence.
6. Call `unbrowse_call` with the nonsense value. A pass is `result.ok: true`
   with no results or the site's "no results" message. An error whose words say
   no results (Allrecipes answers 404) is a **false failure**, and an error that
   doesn't is `fail`. Results of its own are `ok_but_wrong`, unless a person reads
   them as the site's own fuzzy matching and says so in `note`. This check means
   nothing alone: a page blank for every value "finds nothing" for nonsense too, so
   it passes only beside a real value that found results.
6a. Call `unbrowse_call` with the **first** value again (`recheck`). Most of its
   answer must be the first answer's. This catches a route that keeps the last
   value, or a walk that passed once by luck, and it is the only check of a value
   that has been through a nonsense value.
6b. Call `unbrowse_open` on `unbrowse://<site>` (see Links).
7. When a check is `ok_but_wrong`, tell the node with `unbrowse_judge`:
   verdict `wrong`, the route ID, the URL and why. When the route is a
   different kind of call than its name (suggestions, a banner), give `what`,
   your words for it. Then repeat steps 3-6 and record them as `after_judge`
   checks: what the node learned next, or `browse` when the page needs hands.
   When a route is right but its default fields miss what you need, judge it
   `right` with `fields`, using paths exactly as the call's `result.fields`
   names them. Count a site as passing only on its final checks, and report
   how many judgments it took.

A judgment changes the node for that site, so an `after_judge` pass measures the
tester's teaching as well as the node. Report it apart from first-ask passes, never
added to them.

**Evidence.** A page's answer is its whole text: menus, footer, and the search box
saying the query back. `mentions_value` over that text is true for nearly anything,
a no-results page and a country gate included: on 2 November, 6 of the 9 sites with
evidence for the nonsense value "mentioned" it, and Best Buy's country gate mentioned
all four values. `records` counted the page's parts, not results: 21 to 83 for nonsense
on sites that found nothing. Compare the four answers instead:

- A site's **own lines** are those no other value's answer holds. Menus cancel out.
  A line that only says the query back (`Results for flask`) is dropped.
- **Hits** are own lines that mention the value, after folding case, accents and word
  endings. A pass needs two hits, or one in a list of records.
- A route whose path suggests (`/autocomplete`, `/typeahead`) is `ok_but_wrong` however well
  its names match: mentions can't tell suggestions from results. itch.io's did match.
- An answer whose own lines are empty is the same for every value: the route ignores
  its input, however much it mentions.
- A **door beats any mention**. A challenge, a denial, a region gate or a login wall
  in the answer's title or head is `blocked` or `requires_account`, even with
  `result.ok: true` and the query in its address.
- Up to three short titles per check go in the report, so a reader can check the
  verdict. They are cut to 60 characters and scrubbed of addresses, numbers and tokens.

`run_bank.py` works this out as a **suggestion**, and a person reads every answer. A
semantic search can be right with no literal mention, and a word list can miss a
door. A read that differs goes in the reads file with its reason, and the report
keeps both `suggested` and `classification`, so disagreement stays visible. A read
of pass against the rule, with no reason, is refused.

Classify every outcome by what happened, not by the reply's shape alone:
`how: network` (another contributor's route, paid by the node within the
owner's per-fetch maximum) is its own class, recorded with its fee;
`how: error` is `fail` with an error category. Retry **a timeout** once, record
both attempts, and label the second `pass_after_retry`. Nothing else is retried
into a pass: a 403 is `blocked`, and a walk that answered nothing is a failure of
that walk, reported as one. Ask again only as the plan's own next step does.

A site's outcome is one of these, and no others: `pass`, `pass_after_retry`,
`pass_after_judge`, `pass_after_hands`, `ok_but_wrong`, `false_failure`, `fail`, `blocked`,
`requires_account`, `not_applicable`, `safety_stop`, `not_tested`. It is `pass` only if the
first, replay, unrelated, no-results and recheck checks all pass on the same build.
A pass after a node fix doesn't exist: the node is one version for the whole run.
`false_failure` is not a pass. `not_applicable` needs a look at the site, not a guessed
URL that answered 404.

## Links

`unbrowse_open` (`GET /v1/open?q=<link>`) shows what an `unbrowse://` link names, and
nothing else. For each site:

1. Open `unbrowse://<site>`. It must answer 200 with the site, say nothing was called
   or paid, and leave nothing behind: no activity line, no call, no browser launched.
   An unlisted route of this node is not shown.
2. Open the sound forms (`UNBROWSE://SITE`, a trailing slash). Each answers 200.
3. Open each form in `MALFORMED_LINKS`: a port, a login, a query, a fragment, a non-ASCII
   or percent-encoded host, a path that isn't an entry id, and more. Each answers 400.

Once a run, open the forms in `ODD_LINKS` (an IP address, `localhost`, a bare public
suffix), where the answer is a judgment rather than a rule: report what each did.

A route's `link` field appears once it is listed. Listing needs a chain, so test it
once a run on the scratch node's own Anvil, and say so: that shows the node's code,
not a live network.

**Stop on any write.** If a read test's route is `write: true`, don't call or
replay it again: record `safety_stop` with its method and path, and judge it
`wrong` with `what` saying what it does. A `POST` alone isn't a write (many
search APIs read by `POST`); the route's `write` label is.

The rule above leans on the node's own `write` label. A `POST` whose path reads as a
write (`/cart/add`, `/subscribe`) is held for a person even when not marked: it isn't
replayed until someone has read it. Read every step, not only the route's last call,
which is all its `path` shows: a route replays them all. Pinterest's search POSTs to
`ActivateExperimentResource/create/` on the way, marked `write: false`. A scratch node's
route files show the steps, and `run_bank.py` holds such a route before its second call.

Scouting before the first goal call warms the browser session even if it saves
only routes under a different goal. Label such a check `fresh goal route,
scouted session`; it does not measure discovery from a pristine browser. If
the "fresh" route's method and path are the same as a route scouting learned,
label it `scouted_route_reused`, not fresh discovery.

Public checks must remain read-only. A login wall, CAPTCHA, 403/429/503, or
site denial the node does not get past is `blocked` or `requires_account`, never
a passing route. A challenge the node does get past is a pass only when the
site's own answer follows; record that it was challenged. Do not submit forms or
make purchases in the public batch. The node itself retries a refused walk in a
clean browser inside one call: report it as the node's behaviour.

## Authenticated route test

Run this only for a named site with a disposable account the owner controls.
Before Claude starts, provide the site scope, login URL, protected URL, test
account label, and the Vault reference for its password. Put the password in
the Unbrowse Vault on this Mac; do not put it in Claude's prompt, a fixture,
or a report. Copy `mcp-auth.example.json` to a private path and fill only
the test account identifier, Vault reference, observed URLs, and markers.
Record any identity-provider origin used by the actual login flow. Use only
the supplied account and URLs.

1. Open the protected URL with `unbrowse_browse` and record the guest state.
   If a session is already active, mark the guest check `not_tested`; closing
   a browser does not prove cookies were cleared.
2. Open the login URL and inspect `snapshot -i`. Fill the account identifier
   into the observed field. Fill the password field with its
   `vault:<site>:<account>` reference; Unbrowse types the actual password on
   the matching site. Submit only the observed login control.
3. If MFA or a human challenge appears, stop and ask the owner to complete
   that step; record `needs_owner` until it is completed. Never store the code.
4. Open the protected URL and verify a site-specific authenticated marker.
   Test one harmless **read** with `unbrowse_do`, then replay the learned route
   with the same test account. If the learned route is `write: true`, stop:
   record `safety_stop`, never replay it, and judge it `wrong`.
   Record whether session renewal, the protected
   result, and replay actually work. Keep response bodies out of the report.
5. If the test fixture includes an observed logout control, log out and check
   the protected URL returns to its guest state. A session-expiry test needs
   a separate documented expiry or revocation strategy.

For a service on a non-default HTTPS port, name the Vault entry and reference
with `host:port` (for example `vault:example.org:2083:admin`). If a protected
page URL contains a session identifier, verify access through the browser but
do not pass that URL to `unbrowse_do` or save it in a route fixture. Record
learned-route replay as `not_tested_session_url_recording_risk` until the node
can remove session segments before recording routes. The cPanel check in
`mcp-runs/2026-10-28-newlife-cpanel-auth.md` is an example.

Do not run account changes, messages, checkout, or other writes as part of an
auth test. They are separate opt-in scenarios in `scenarios.json`.

## Outcome files

Write one metadata-only JSON (`run_bank.py report`, which refuses an outcome off the
list, a count that doesn't add up, or any money spent) and one short Markdown summary
under `test-banks/popular-sites/mcp-runs/` for each batch. Answer samples for reading
stay outside the repository. Compare with an earlier run only like for like, and
say how the state differed (a warm owner's node against a cold scratch one).
Include run time, node version, site, phase (`scouting`, `fresh`, `preexisting`, `auth`), goal, public
URLs without sensitive query strings, observed route ID, method and path,
`how`, `result.ok`, the answer evidence (result count, up to three short
titles, whether they mention the value), any `unbrowse_judge` verdicts,
pass/fail/blocked classification, and a short error category. The node
version is required: a run against uncommitted node changes says so. For auth, record
guest/login/protected/replay/logout outcomes and the test-account **label**,
never credentials, cookies, session IDs, one-time codes, full response bodies,
or URLs containing auth codes. Count sites and checks separately; a site can
have several checks. Link the outcome files from `README.md` after review.

## Prompt to paste into Claude Code

Use this in the Claude session where the `unbrowse_*` MCP tools are available:

```text
Read test-banks/popular-sites/MCP_TEST_PLAN.md (from the unbrowse-core repository root) and the bank's README, sites.json, and available browser-fixtures. Use only the Unbrowse MCP tools for website access; local file tools are allowed for reading fixtures and writing results. Run a bounded public batch of up to five sites. For each site, distinguish scouting, genuinely fresh discovery, and replay according to the plan. Use two harmless values for an observed public search route; do not guess routes from scenario_candidates alone. Record metadata-only JSON and a concise Markdown report under test-banks/popular-sites/mcp-runs/. Show me the report path and a table of learned, called, blocked, and failed outcomes. Do not test login or writes in this batch.
```

For auth, supply a **specific** private fixture path after the owner has
created the test account and Vault reference, then ask Claude to run only that
site's `auth` steps above and write a separate report. The two current public
MCP examples and their route IDs are in `mcp-smoke-results.json`.

```text
Read test-banks/popular-sites/MCP_TEST_PLAN.md (from the unbrowse-core repository root) and my private MCP auth fixture at <ABSOLUTE_FIXTURE_PATH>. Test only the named disposable account and URLs in that fixture. Use only Unbrowse MCP tools for website access; use the Vault reference for the password, never a raw password. Record guest access, login, protected read-route learning, replay, and logout as separate outcomes. Stop for an MFA or human challenge and ask me to complete it. Save a metadata-only JSON and a short Markdown report under test-banks/popular-sites/mcp-runs/; do not save credentials, cookies, codes, full response bodies, or auth URLs with query strings. Show me the report path and any blocked or failed step.
```
