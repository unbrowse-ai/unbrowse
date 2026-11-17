# Popular-site route and auth test bank

This independent fixture bank contains **400 web-facing domains** selected from
the [Tranco GQ3LK standard daily list](https://tranco-list.eu/list/GQ3LK/full)
dated **2026-10-27**. Tranco combines several domain rankings over a rolling
period; its [methodology](https://tranco-list.eu/methodology) explains the
sources and limits. The full ranked CSV is available at the permanent
[download URL](https://tranco-list.eu/download/GQ3LK/1000000). `sites.json`
records its SHA-256 and the rank for each selected domain. Category and market
labels are editorial sampling labels, not fields supplied by Tranco. A market
label denotes a localized host or a service mainly aimed at that market; it
does not infer the visitor's location or the site's legal domicile.

## Files

- `sites.json`: ranked inventory, HTTPS entrypoints, and scenario **candidates**.
- `scenarios.json`: 16 reusable public, auth, and authorized-action scenarios,
  including prerequisites, steps, and assertions.
- `site-fixture.example.json`: shape of a per-site configuration to fill after
  observing the site's actual routes. All account and action fields are null.
- `public-read-results.json`: bounded, unauthenticated homepage checks for 16
  sample sites using HTTP only; it is evidence of those responses only.
- `probe_all_public.py`, `public-all-results.json`, `PUBLIC_PASS_REPORT.md`:
  bounded HTTP-only homepage and observed-link checks for all 400 sites, with
  per-site evidence and exact counts.
- `local_chrome.py`: local Chrome DevTools Protocol runner for bounded public
  routes and opt-in test-account login/logout. It uses a temporary browser
  profile, not a VM. It has no action-scenario execution code.
- `browser-fixtures/`: two public route fixtures and an illustrative auth
  fixture with environment variable references rather than credentials.
- `browser-smoke-*.json`: metadata-only results from 12 local Chrome public
  checks across Wikipedia, GOV.UK, Booking.com, and NYTimes.com.
- `mcp-smoke-results.json`: four public MCP calls on Wikipedia and GOV.UK;
  the Wikipedia replay was a false semantic pass because its route had no input.
- `run_bank.py`, `test_run_bank.py`, `search-cases.json`: the public route test as a
  repeatable batch runner against a scratch node, its offline tests, and the sites it
  has a search URL and values for. It draws samples by seed, reads answers against
  each other, checks `unbrowse://` links, and refuses the owner's port. It also times
  every ask and keeps a warm call's milliseconds beside a browser's for the same URL
  (`--browser-program auto|none`), records whether each stored route is the walked
  page or a data call (path shape and query keys), counts the browsers left running
  under the run's folders before and after each site, and varies a second parameter
  on the replay ask when a case declares one in `vary`, so a route that wrote a
  one-character value in as a constant relearns instead of calling and the replay
  check says so. The 2026-11-06 cases for booking.com, airbnb.com, google.com,
  trip.com and lazada.com came from the Eden report of that date and check its
  findings: the adults/group_adults constant, the route stored with no inputs, the
  SSE flight list, and the ajax parameter the stored route lost.
  The 2026-11-07 cases for www.google.com (flights), carousell.sg, amazon.com and
  opentable.sg complete the report's ten sites: a sentence query the site breaks
  into parts, a next-page cursor that carried the walk's search into every later
  one, an answer that held only its own search parameters, and a door that refuses.
  Each run now turns those measurements into per-site verdicts: see
  [Findings](#findings-of-a-run).
- `decision_shim.py`: a stand-in decision model for a scratch node, on this machine
  only, answering `POST /v1/systemone` through the local `claude -p`. Its picks come
  from Claude, not Clef: a run that uses it says so (`report --decision-model`).
- `MCP_TEST_PLAN.md`, `mcp-runs/`: a Claude Code prompt and result location for
  separate fresh, replay, and site-specific authenticated route tests. The
  [reviewed five-site public batch](mcp-runs/2026-10-28-public-batch-1.md) records
  two goal-route passes, one blocked goal, and one site without an observed
  first-party search. Its Merriam-Webster "pass after retry" learned the
  autocomplete API (`/lapi/v1/mwol-search/autocomplete`), not the dictionary
  page the goal named, so on re-review it is a fail. The
  [Wikipedia retest](mcp-runs/2026-10-28-wikipedia-retest.md) confirms a route
  with a bound input and distinct answers, but `/wiki/{path[1]}` is a title
  lookup tested with two one-word titles, not a search. The
  [15-site batches of 2026-11-02](mcp-runs/2026-11-02-public-batches-2-4.md)
  read every answer against its query, add an unrelated and a no-results value
  per site, and judge wrong answers with `unbrowse_judge`. The
  [reads and writes of 2026-11-06](mcp-runs/2026-11-06-reads-and-writes.md) add
  write tasks on sites built to be written to (an order form, a demo login, a
  demo bank checked to the cent) and rerun on a node with the fixes they found. The
  [50-site batch of 2026-11-06](mcp-runs/2026-11-06-popular-sites-expanded.md) ran on a
  scratch node: 13 pass, 3 pass after judging, 13 ok_but_wrong, 1 false failure, 3 fail,
  12 blocked, 1 not applicable, 4 not tested.
  A later [run on four sites](mcp-runs/2026-11-06-script-drawn.md) fixes what that batch left on ASOS, Kubernetes and
  Target, and verifies Pinterest's input on a real replay.
  [Pinterest, read through](mcp-runs/2026-11-07-pinterest.md) takes its default fields and its nonsense value to the end.
- `mcp-auth.example.json`: an MCP auth fixture outline using a Vault reference,
  with no password or session material.
- `mcp-runs/2026-10-28-newlife-wp-auth.md`: a separate, site-specific WordPress
  auth check outside this 400-site inventory; login and protected browser reads
  passed, while route learning found no valid read route.
- `mcp-runs/2026-10-28-newlife-cpanel-auth.md`: a separate, site-specific cPanel
  auth check on HTTPS port 2083; guest gating, Vault login, and protected
  browser read passed. Learned route replay remains untested because page URLs
  contain session identifiers.
- `future-targets.json`: X, Instagram, LinkedIn, and Carousell reserved for
  later site-specific testing. The sampler still leaves them out; Carousell also has
  a plain public search case now, as one of the Eden report's ten sites.
- `curation.py`, `build_inventory.py`: reproducible editorial selection and
  rank join against the permanent Tranco CSV.
- `validate.py`, `test_safety.py`: dependency-free structural, rank, fixture,
  distribution, and opt-in safety checks.
- `probe_public.py`: optional, bounded public homepage probe. It opens one
  entrypoint per selected site, follows up to five redirects, limits response
  bytes, and stores metadata
  only. It never logs in or follows a challenge.

## Coverage and interpretation

The inventory spans **14 categories**, **20 market labels**, and **83 localized
market hosts**. Selected Tranco ranks run from **1 to 7,304**. This is a
diversity sample of recognizable web sites from a top-domain list, not the top
400 positions of the list: rankings also contain CDNs, DNS infrastructure,
telemetry hosts, and other non-browsable domains.

| Scenario group | Candidate sites | Measured live coverage |
| --- | ---: | ---: |
| Homepage | 400 | 400 HTTP reads; 4 local Chrome checks |
| Navigation | 400 | 218 observed-link HTTP GETs; 2 local Chrome checks |
| Redirects, errors, challenge recognition | 400 each | 321 HTTP homepage redirects observed; 48 challenge/denial statuses; no dedicated error-route check |
| Search | 352 | 4 local Chrome checks; 4 initial Unbrowse MCP calls on 2 sites, with one false semantic replay; 5-site MCP batch with 2 goal-route passes, 1 fail on re-review, 1 blocked goal, and 1 not tested; 15-site batch with answer evidence (2026-11-02); 50-site batch with answers compared across values (2026-11-06) |
| Pagination | 241 | 1 local Chrome check |
| Login, protected guest route, expiry, MFA, logout | 350 each | 0 live auth checks |
| Opt-in form submit | 64 | 0 |
| Opt-in message send | 28 | 0 |
| Opt-in checkout | 69 | 0 |
| Opt-in account change | 133 | 0 |

**Candidate means a test worth trying after site-specific discovery.** It is
not a claim that a route or capability exists. The inventory's `site_fixture`
fields remain null; two separate public fixtures were added for the browser
smoke check. Other search, pagination, navigation, and protected routes must
be observed before execution. A challenge or login wall is a classified
result, never a passing content route. The error scenario needs an explicitly
permitted nonexistent path.

On **2026-10-28**, the public read probe returned 14 HTTP 200 homepages, one
HTTP 403 challenge or denial (nytimes.com), and one nonstandard HTTP 202
response (booking.com); 11 of 16 visits redirected. These are response
classifications from one vantage point and user agent, not route replay or
full site passes. The 202 response is deliberately left unclassified as
content. The probe did not test auth, search, pagination, or writes.

The **local Chrome** smoke check on the same date completed 12 public checks:
Wikipedia homepage, navigation, and two searches; GOV.UK homepage,
navigation, two searches, listing, and pagination; plus Booking.com and
NYTimes.com homepages. The 10 Wikipedia/GOV.UK checks returned HTTP 200
and passed the configured route assertions. Booking.com returned 202 and
NYTimes.com returned 403 in Chrome, matching the HTTP ambiguity/denial. The
runner stores URL fingerprints
to verify distinct search and pagination routes while omitting query strings
from output. These four sites are the only ones visited in this task by local
Chrome. No login or MFA was attempted. See the
[full public pass report](PUBLIC_PASS_REPORT.md) for all 400 HTTP outcomes and
their limits.

The **Unbrowse MCP** smoke check then searched Wikipedia for `planet` and
`moon`, and GOV.UK for `passport` and `driving licence`. Each site's first
call learned a route and its second called the same route. All four returned
`result.ok: true`, but the Wikipedia route was fixed to `/wiki/Planet` with no
input, so `moon` was a false search pass. GOV.UK's route has a bound `keywords`
input; the original metadata did not retain a content-level replay assertion.
See the [corrected smoke report](mcp-runs/2026-10-28-public-smoke.md). A later
[five-site MCP batch](mcp-runs/2026-10-28-public-batch-1.md) checked input
changes in replay for arXiv, Hugging Face, and Merriam-Webster; those sessions
were scouted first. Neither batch turns the 400-site public HTTP pass into an
MCP pass.

## Run offline checks

From the `unbrowse-core` repository root:

```sh
python3 test-banks/popular-sites/validate.py
python3 -m unittest discover -s test-banks/popular-sites -p 'test_*.py'
```

`BANK_E2E=1` also runs the findings against the built node and Chrome, on stub
servers on this machine (a site with the report's shapes, a model that leaves out
`type`), with no network. They need `scratch-node.sh`'s two binaries built.

## Findings of a run

`run_bank.py run` writes these per site under `findings`, and `report` prints them as a
table. Each is `pass`, `fail`, `blocked` (a wall answered: the bank asks that domain
nothing more, its sibling cases included, and across batches on one `--out`) or `not_run`
(the case or the run gave it nothing to judge, never a pass). They sit
beside the site's outcome, not inside it: `compare`, the nightly regression, reads
answers only, so a slow route doesn't fail it.

| Finding | Fails when | Threshold or source |
| --- | --- | --- |
| `warm_speed` | the median answered warm call costs more than half of `open` + `snapshot -i -c` on the same URL | `WARM_SHARE_OF_BROWSER` 0.5; at least 2 answered calls; a refusal or a nothing-found doesn't count |
| `data_route` | the stored route is the page, by shape or by answering as one, and a data call existed; `not_run` with no capture, or while it holds a JSON, plain-text or stream call nothing could read | what the model was shown, else the walk's capture |
| `correct` | an answer is only ids, only the page's frame, only the request said back, or has no prices where the case says `expect: ["price"]` | `judge_check`; `MIN_PRICES` 3 |
| `keeps_pick` | the stored route isn't the call the model picked: another call, a lost query key, or the value fixed in its POST body | needs `--model-log`; the route's file for the body, so a POST without one is `not_run` |
| `sse` | an event stream in the walk was not shown to the model | the walk's capture and `--model-log` |
| `short_values` | a one-character query value is written into the route; passes only with a placeholder for it, and a route without the key is `not_run` | the stored path; `vary` tests the same by relearning |
| `inputs` | `inputs: []`, no input carries the query, or the run added more than one route | the agent API's routes |

Two more are not per site. `resources`, at the end of `run`: the node above 500 MB RSS
(`MAX_NODE_RSS_MB`) or more than 10 processes left (`MAX_PROCESSES_LEFT`, about one
browser handed over). A silent fallback from a reply with no `type` is checked offline
(`FallbackOnANodeTests`), since `decision_shim.py` always sends one.

A run that must take a wall as the answer uses `ONE_ASK=1` on `scratch-node.sh` and
`--one-ask` on `run`. The guard holds what no setting turns off: asking a site again in a
clean browser after it refused, and the background try that clicks a learned page's controls,
each logged as `HELD_`. The flag ends a site at the first door the node's log shows
(`saw_a_door`), and such a site's findings read `blocked`. A timeout ends the site too, with
no retry, since it may be a wall the log didn't name. It refuses to run without an existing
`--node-log` and a `--guard-log`, or on a node started without `ONE_ASK=1`. The bank then makes one `do` of a walled site, but that `do` is not one
request. It can still send a plain request for the page, the walk's own browser load, and a call
of a route the node already holds or has just learned. The guard holds every command to the
browser program but `close`, so neither the walk's fallback nor the hand-over browser that
opens the page after a failed walk (`how: browse`, session `browse_<site>`) reaches the site:
a wall is a fail, and no browser takes over. It can't stop two more things: a
page's own script challenge running and clearing in the walk's browser, and a route's call
walking the page again after a refusal (`[heal]`). Those are seen afterwards, not prevented.

To run with the stand-in model, start it and name it to the scratch node:

```sh
python3 decision_shim.py --port 18790 --log /private/dir/shim.jsonl &
ONE_ASK=1 MODEL_BASE=http://127.0.0.1:18790 sh scratch-node.sh /tmp/b
# Without MODEL_BASE the node gets a placeholder key and a dead model address, so the rule decides; the owner's Clef key
# in the Keychain is read only with CLEF_OPT_IN=1.
python3 run_bank.py run --cases search-cases.json --sites trip.com --token-file /tmp/b/token --seed 2026-11-07 \
  --out run.json --node-home /tmp/b/home/node --node-log /tmp/b/node.log --guard-log /tmp/b/guard.log --model-log /private/dir/shim.jsonl --one-ask
python3 run_bank.py report --out run.json --batch eden --node-version <v> --result <file> --decision-model "Claude Sonnet via decision_shim.py, not Clef"
```

To verify every rank and the full-list hash against the permanent source:

```sh
curl -L https://tranco-list.eu/download/GQ3LK/1000000 -o /tmp/tranco-GQ3LK.csv
python3 test-banks/popular-sites/validate.py --tranco-csv /tmp/tranco-GQ3LK.csv
```

To regenerate the inventory from the same snapshot, run
`python3 test-banks/popular-sites/build_inventory.py --tranco-csv /tmp/tranco-GQ3LK.csv`.
The downloaded full list is intentionally not committed. To rerun only the
16 public reads, use `python3 test-banks/popular-sites/probe_public.py`.

## Run local Chrome checks

The browser runner launches the **installed local Google Chrome** through
DevTools Protocol, in headless mode by default. It creates a temporary user
data directory and removes it when the run ends. No VM, remote browser, or
shared personal Chrome profile is involved. It needs Python 3 and the
`websocket-client` package:

```sh
python3 -m pip install -r test-banks/popular-sites/requirements-browser.txt
python3 test-banks/popular-sites/local_chrome.py \
  --fixture test-banks/popular-sites/browser-fixtures/wikipedia.json
python3 test-banks/popular-sites/local_chrome.py \
  --fixture test-banks/popular-sites/browser-fixtures/govuk.json
```

Use `--headed` to show the local Chrome window, `--chrome PATH` to choose a
different local Chrome executable, and `--output PATH` to save metadata-only
JSON. The runner accepts a single site-specific fixture, explicit HTTPS scope,
and observed URLs/selectors. It blocks out-of-scope document navigation and
blocks POST/PUT/PATCH/DELETE during public checks. During explicit `--auth`
runs, those methods are allowed only within the fixture's observed
`auth_write_scope` prefixes so login and logout can work. Off-scope frame
documents and writes are blocked; public
GET subresources may still load. Redirects outside scope fail closed.

## Auth setup

Copy `browser-fixtures/auth.example.json` to a private location and replace
the illustrative domain, routes, selectors, and expectations with observations
from one authorized site. Run `--validate-only` first. The fixture must name a
**disposable test account** and define:

- exact HTTPS `site_scope`, including any identity-provider origins used by
  the login flow, plus `auth_write_scope` with the observed login/logout
  request paths;
- protected and login URLs, username/password/submit selectors, a guest
  expectation, post-login marker, authenticated marker, and logout selector;
- credential **references**, such as `{"provider":"env","name":"TEST_USER"}`
  and `{"provider":"env","name":"TEST_PASSWORD"}`, or
  `{"provider":"macos_keychain","service":"...","account":"..."}`;
- if MFA is expected, an `mfa` block with a test-code reference and observed
  code/submit selectors. The test factor must be supplied by the account owner.

The credential values are read at runtime and never stored in the fixture or
result JSON. A one-time MFA code is read when its prompt appears. Then run:

```sh
python3 test-banks/popular-sites/local_chrome.py --fixture /private/path/site.json --validate-only
python3 test-banks/popular-sites/local_chrome.py --fixture /private/path/site.json --auth
```

`--auth` first checks the protected route as a guest, signs in with the supplied
test account, confirms an authenticated marker on the protected route, logs
out, and checks that guest behavior returns. MFA is exercised only when the
fixture includes it. Session expiry remains a scenario template pending a
site-specific expiry strategy. The auth flow has been tested with an offline
mock browser, not a live account.

X, Instagram, LinkedIn, and Carousell are reserved for a later site-specific
route test and were **not** visited by the browser harness (Carousell's public search
is a `run_bank.py` case, which goes through a node). X, Instagram, and
LinkedIn are in the 400-site inventory; Carousell's Tranco rank is 14,537 in
the same source list, outside the selected 400.

## Requirements to execute deeper flows

For each site, collect a scope of authorized origins and paths, an observed
route fixture for search/listing/login/logout/protected pages, and expected
route behavior. Auth tests need a **disposable test account** and a credential
provider reference; MFA needs a dedicated test factor, and expiry needs an
approved expiry or revocation strategy. The example fixture contains no
credentials, tokens, or secrets.

Authorized-action scenarios are **opt-in** and require an exact `site_scope`,
`test_account`, and `approved_action` before a runner may execute them. Form
submission needs a disposable target and expected write. Messaging needs a
test recipient and exact text. Checkout needs a sandbox or no-charge test
purchase, a spend limit, and expected order. Account changes need a disposable
target, expected change, and restore plan. The validator rejects any
side-effect scenario that loses its opt-in flag or approval prerequisites.
No live write, message, purchase, or account change has been submitted.
