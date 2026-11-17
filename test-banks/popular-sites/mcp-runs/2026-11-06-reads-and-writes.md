# Reads and writes: 2026-11-06

Thirteen sites from `sites.json` and three outside it, read with four values each, plus write tasks on three public
sites built to be written to. Everything goes through the node's agent API: the MCP tools for the writes, and for
the reads a script that records metadata and short answer samples. No real person's account was used, nothing was
bought, and no challenge was solved. Metadata: [2026-11-06-reads-and-writes.json](2026-11-06-reads-and-writes.json).

**Nodes.**
- Round 1: the release **v13.17.1**.
- Round 2: a local build of `fix/lundy-bank-2026-11-06`, which is origin/main `1917484b` plus the fixes below.

**Why a second round.** The 13 fixes from the [2026-11-02 run](2026-11-02-lundy-bank.md) never left a local branch.
v13.17.1 still had the bugs they fixed. The redirect-cookie one showed up again here, on a login. Eleven of them are
ported to main's code on this branch. The other two were already on main in another form: the beacon test
(`answers_the_ask`) and page state that is only a scrap of the page (`page::answer`).

**Method.** As [MCP_TEST_PLAN.md](../MCP_TEST_PLAN.md) describes:
- Two values alike, a third unlike them, and a nonsense value.
- Every answer is read against its query.
- Answers that are `ok` but wrong are judged with `unbrowse_judge`.

Writes are judged by what the site says back, and checked against what the site then shows. The order form echoes
what it received. The login says which page it landed on. The bank's balances are checked to the cent after every
transfer.

## Writes

| Site | Task | Round 1 (v13.17.1) | Round 2 (fixed) |
| --- | --- | --- | --- |
| httpbin.org | Submit the pizza order form | **ok but wrong**: the first ask kept the form page's GET as the route. After judging it, the form was driven by hand: the POST echoed all 7 values, and the learned route replayed new values exactly. A radio click said "changed nothing, needs the owner". | **pass**: the first ask goes straight to `browse`. Radio and check-box clicks are done. The order echoed exactly (small, onion, "no olives"). |
| the-internet.herokuapp.com | Log in (public demo login) | **ok but wrong**: the right and the wrong password both came back as the bare login page, `ok: true`. The site's redirect cookie was dropped. | **pass**: right password → "You logged into a secure area!"; wrong → "Your password is invalid!" |
| parabank.parasoft.com | Register a customer | **ok but wrong**, then pass: the first ask kept the sign-up form's GET. After judging it, the form was driven: all 11 inputs were learned, and a replay registered a second customer ("Your account was created successfully"). | goes to `browse` on the first ask (the same rule as httpbin) |
| parabank.parasoft.com | Open a savings account | **pass in the browser, not learned**: account opened. The account type was chosen in a select, and the browser records the option's label ("SAVINGS") while the site sends its value (`1`), so the node never matched the call. | **pass** (round 3): the browser logs a select by its option's value. Learned with inputs `type` and `fromAccountId`; a replay with no browser opened a CHECKING account funded $100 from 36321, and the total stayed $515.50. |
| parabank.parasoft.com | Transfer funds | **pass, badly named**: $25, then a $10 replay, both landed. The inputs were learned as `@e129`, `@e130` and `input`: the snapshot's refs. | **pass**: inputs are `fromAccountId`, `toAccountId` and `amount`. A $3 replay and a $1 replay both landed. |
| parabank.parasoft.com | List the account balances (signed in) | **fail**: always `browse`. The learner threw out the accounts call and kept the page, which answers 500 to a plain request. | **pass**: learns `GET …/customers/{id}/accounts`. Exact after every transfer: $400.50 / $115.00, then $396.50 / $119.00, then $397.50 / $118.00. The total stayed $515.50. |

Round 3, end to end on routes alone, after the demo session expired:
1. A call answered "User login required" and failed, not a wrong `ok`.
2. The learned sign-in route logged in again, and its session now goes with the calls after it.
3. The balances read, a $2 transfer, and a second read followed: 36210 went 397.50 → 395.50, 62295 went
   100.00 → 102.00, and the total stayed $515.50.

The money check, end to end with no browser after learning:
1. Transfer $1 through the learned route.
2. Read the balances through the learned route.
3. Both accounts moved by exactly $1.

## Reads

| Site | Round 1 (v13.17.1) | Round 2 (fixed) | Judgments |
| --- | --- | --- | ---: |
| pixabay.com | **pass**: four values right, nonsense empty | — | 0 |
| soundcloud.com | **pass** | — | 0 |
| hub.docker.com | **pass** (the page read; "1 - 30 of 76,047 results for machine learning notebook") | — | 0 |
| walmart.com | **pass** (product lists per value) | — | 0 |
| nature.com | **ok but wrong** on the third value: a bot check ("Client Challenge") came back as `ok: true` | **pass**: four values; the check rule now fails such a page | 0 |
| sourceforge.net | three values right; nonsense → **false failure** (the site answers 404) | **pass** (round 3): the no-results 404 page that says back the value is the answer ("zqxjvbnmqw free download") | 0 |
| cnn.com | **ok but wrong**: the search call was right, but the default fields kept the 8 counts in `meta` and dropped `result[]` | **pass**: headlines per value ("The climate crisis is causing hunger in Somalia"; battery-tech startups for the third); the nonsense value returns one story because CNN's own search counts 2 matches | 0 |
| gitlab.com | **ok but wrong**: a GraphQL call that never sends the name; the same projects for every value | **not the node** (round 3): signed out, GitLab redirects `explore/projects?name=…` to `/explore/projects/active` and drops the name. `?search=` and typing in the page's own search box don't filter either (the browser sent no request with the name). The page itself never searches, so it `requires_account`. The node now fails its empty shell honestly instead of answering wrong. | 1 |
| dailymotion.com | **ok but wrong**: a GraphQL "stories" call, always empty | **pass** (round 3), on `/search/<q>/videos`: the search API (`POST search.<site>/v1`, input `search`). cats, dogs and "street food tour" → 20 matching videos each; nonsense → 0. The round-1 call was the right one: its replays were empty because the query text was rebuilt around a type name, and because it went out saying it came from the API's own host. | 3 (one of them mine, made in error, and reverted) |
| flickr.com | **ok but wrong**: related tags, not photos | **pass** (round 3): `flickr.photos.search`. sunset → 760,643; bridge → 594,286; "old steam locomotive" → 40,102, whose top titles say it; nonsense → 0 | 2 |
| crates.io | — | **pass**: the API; nonsense empty | 0 |
| bandcamp.com | — | **pass**: albums per value; "japanese city pop" → 14 of 15 say it back | 0 |
| openlibrary.org | — | **pass** (the page read) | 0 |
| ikea.com (US) | — | an older route read the search page shell; judged wrong, it **passes**: the product search API (`POST`, input `q`); lamp → 22 lamps, nonsense → 0 | 1 |
| imdb.com | — | **ok but wrong**: an older route's fields give image and title ids, no titles. **pass after judging** (round 3), with `right` and the `titleText` fields: Inception…, The Matrix…, space-station titles; nonsense → 0 | 1 |

## Findings for the node

Each is a commit on `fix/lundy-bank-2026-11-06`, with a test named for the property, never for the site.

1. **A goal that asks for a change was answered by loading its page.** "submit …" and "register …" kept the form
   page's GET, so every later submit read the empty form again. A goal whose first word is a change now opens the
   page for hands.
2. **A bot check came back as an answer.** A replayed page that links nowhere, says a few lines at most, and says
   none of what was asked is a check or a wall, so the call fails, saying what the page said.
3. **A tie went to the counts.** A search's `result[]` and its `meta` had 8 fields each, and the defaults took
   `meta`. A list of records now wins the tie. Defaults saved before the fix, which miss every record list in an
   answer that has one, are chosen again.
4. **A radio click "changed nothing".** The click check compared only the address and the text. It now compares the
   controls' state too, read from the snapshot without its refs.
5. **Inputs named by snapshot refs.** A value filled into a control with no name of its own takes the key the call
   sends it under.
6. **A page that fills itself from its own call threw that call out.** The served page shows only the table's head,
   so the accounts call "said none of what the page showed". A same-site call that the page's own script spells
   (address pieces and ids) is the page filling itself.
7. **Ported from 2026-11-02**:
   - a redirect's cookie goes with the next hop (the login above);
   - HTML fragments;
   - arguments written as JSON text;
   - late answers kept for the next ask;
   - values matched however they are encoded;
   - a call that never carries the asked value;
   - a one-record search;
   - the page's path handed on whole;
   - restart;
   - page state that never says the search;
   - markup earns nothing over its page.

8. **Round 3**:
   - Rejecting one operation at an address (`method=`, a GraphQL operation) passes over no other.
   - Two operations at one address are two routes: the body's naming values are part of the route's id.
   - A select is logged by the values it sends.
   - A search the site answers 404 with a page saying so found nothing.
   - A name written as text (`titleText`) names the record.
   - Defaults an older rule chose are chosen again once.
   - A call that sends the asked value beats one that sends the page's address.
   - A word inside a long text is not where the text comes from: the GraphQL query.
   - A script's call goes out from the page it was learned on (Origin and Referer).
   - A browsing is picked by what its calls hold, and another method at one address is no repeat of a call.
   - The needs-Anvil tests stop the Anvils they start, however they end: a piped run used to hang for 90 minutes.
   - A session an answer sets goes with the calls after it: a route's jar takes in its own host's Set-Cookie, the
     redirects' too.

## Still open

- **A walk ends before a slow page's own call lands.** Dailymotion's search fires a few seconds after load, so the
  first walk keeps the page instead. Judging the page wrong, or browsing it, learns the call.
- **Default fields can be crowded out.** IMDb's titles lost to sixteen translation strings with "title" in their keys.
  Judging `right` with fields fixes the route.
- **A later learn of the same call replaces its inputs.** httpbin's order route was learned again from a flow that
  typed only a name and a note, so the phone and e-mail became fixed values.
- **A route call shares the site's session.** Replaying "register" signed the browser in as the new customer. That's
  by design: a route runs under the owner's session for the site, as the browser would.
