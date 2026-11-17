# The last wrong answers: 2026-11-06

ASOS, Kubernetes, Target and Pinterest, the sites the [50-site batch](2026-11-06-popular-sites-expanded.md) and #270 left
wrong. All public search reads through the node's agent API with `run_bank.py`. No login, no account, no purchase, no
challenge solved. Metadata: [2026-11-06-script-drawn.json](2026-11-06-script-drawn.json).

**Node.** A debug build of `fix/script-drawn-2026-11-06` at `a57d9991`, on main `31ad1504`, as a scratch node on its own
port, home, `TMPDIR` and Anvil, off the peer network, started under `env -i`, with `headless_only` and `UNBROWSE_HEADLESS`
on. It started with no routes, so every first ask is a fresh walk. `lsappinfo` didn't list it, and the guards logged no
refusal. `paid_usdc` stayed empty.

## Outcomes

| Site | Before (main `3ddba96b`) | After (final build) | Outcome |
| --- | --- | --- | --- |
| kubernetes.io | 4 ok_but_wrong, 1 pass | 5 pass | **pass** |
| target.com | 4 ok_but_wrong, 1 pass | 4 pass, 1 ok_but_wrong | **pass**, by reading the one check |
| asos.com | 4 ok_but_wrong, 1 pass | 4 pass, 1 ok_but_wrong | **pass**, by reading the one check |
| pinterest.com | 1 safety_stop | 2 pass, 3 ok_but_wrong; after one judgment 1 pass, 4 ok_but_wrong | **ok_but_wrong** |

The one pass before was each site's recheck, which compares a value with itself. On Kubernetes and ASOS it proved nothing:
they answered the same for every value.

25 checks and 25 calls in the record, on the final build. `suggested` and `classification` differ on Target and ASOS, and
each has its reason in `note`.

- **Kubernetes.** Pods, Ingress and Persistent Volumes each find ten matching pages, and the nonsense value finds none.
  The route is the site's search provider on `cse.google.com`, so `route_first_party` is false.
- **Target.** Water bottle, towels and LEGO each find 30 products, and their titles say so. The nonsense value answers 24
  unrelated items. The site's page for that exact word says "200 results" and shows the same first item, so that is the
  site's fallback, and the node reports it as the site shows it.
- **ASOS.** Dress, jacket and waterproof walking boots each find their products. The nonsense value answers one product's
  page: the site sends that word there itself, with `SearchRedirect=true` in the address.
- **Pinterest.** Stays wrong on one check, and the input now works. Each value gets its own 25 pins with no id shared,
  the site's guides name the value ("garden ideas", "tiny house loft stairs"), and a recheck matches exactly. So the swap
  from #270 is verified on a real replay, and the route is eight GETs, so the safety stop no longer holds it.
  - Pins hold only ids and images for a guest, so the bank has no text to match. That is why most checks read
    `ok_but_wrong` after judging: the reader takes pin ids as the records, and an id says nothing.
  - The default fields are filter chips. One `right` judgment with `fields` gave the pins and guides.
  - The nonsense value answers 25 pins and no guides. The site's page shows a sign-up wall, so I couldn't confirm that as
    its fallback, and the plan keeps it `ok_but_wrong`.

## What the causes were

None of the four was what the last report called them, except Kubernetes.

1. **Kubernetes: a script tag's answer.** The search is JSONP. The browser logs it as a script, so it was dropped as an
   asset, and the page's shell was kept. An answer inside the name its own address gave it, whole JSON inside, is now data.
2. **Kubernetes: a token read as a clock.** `cse_tok` ends in a server's millisecond time. Analytics' ten-digit id matched
   inside it, so the token would have been rebuilt on every call, and an analytics POST rode along as a step.
3. **ASOS: the menu as the answer.** The results were in the document all along. The route recorded the shape of the site's
   menu, held in a JSON script, and answered that menu for every value. A step now says the page was read, and the reader
   follows that. `response_shape` stays, since it still tells a later page from a wall.
4. **Target: nothing in the walk.** The route was right. The bank read a product's brand instead of its title, and a layout's
   slot ids instead of the products.
5. **Target: defaults that moved.** The saved default fields were thrown away if any one was missing from an answer, so
   LEGO's answer, lacking one small field, got defaults chosen from it alone: facets and ids, no product named. They now
   change only when most of them name nothing there. That is one live sample, beside a unit test.
6. **Pinterest: a logger picked.** The route ended on an event-logger POST, because its answer plays back the events it was
   sent, and those say the query. Records a call sent are not records it found.
7. **Pinterest: a search that asks inside JSON.** Its value sits in JSON inside a query value, which wasn't read as asking,
   and a form body hid the page's address from the check that sets aside calls naming the page.
8. **Pinterest: POSTs by request order.** A read took a value from a POST's JSON before a page's text, so whether POSTs rode
   along changed with the order of the walk. One build's all-GET route was luck, and the next build's held two POSTs.

## How far to trust this

- **A walk varies.** An earlier build learned the page instead of Target's search call, in a run beside a heavy `cargo test`:
  the walk ended at 5.5 s with its calls still pending. That is the open "a walk ends before a slow page's call lands". It
  didn't recur without the load, and nothing here fixes it, so a slow machine can still give Target a page route.
- **ASOS's first value can still read worse.** On the final build `dress` came back as the page's text, with its products
  named. On two earlier builds the same search came back as the page's state, whose default fields are `id` and
  `brandName`: the right products, with no names until an agent asks for `description`. Which one comes back depends on how
  much of the page that state holds that time (`holds_the_page`). This run's pass doesn't rule the other out.
- **`cse_tok` is held as a constant.** A token 96 minutes old still answered, tested on an earlier build by putting it in a
  scratch route. How long it lasts past that isn't known, and neither is what the route does when it stops.
- **A listing's recipe doesn't carry `reads_page`**, so a route fetched from another node still answers the menu, the same
  gap `held` has.
- **Traffic.** Besides the 25 calls recorded here, this work made three earlier runs on other builds, some direct calls to
  read whole answers, and four page opens in the node's browser. Pinterest's first ask on main replayed its old route once,
  so its guest POSTs reached the site.
