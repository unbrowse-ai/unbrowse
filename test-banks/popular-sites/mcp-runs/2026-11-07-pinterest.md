# Pinterest, read through: 2026-11-07

The [last run](2026-11-06-script-drawn.md) left Pinterest `ok_but_wrong`: the default fields were filter chips, the bank's
reader held pin ids that say nothing, and the nonsense value answered 25 pins nobody could account for. All public reads
through the node's agent API with `run_bank.py`. No login, no account, no purchase, no challenge solved. Metadata:
[2026-11-07-pinterest.json](2026-11-07-pinterest.json).

**Node.** A debug build of `fix/pinterest-answers-2026-11-07` at `f658e79a9`, on #316's branch at `0d230bd98`, as a scratch
node on its own port, home, `TMPDIR` and Anvil, off the peer network, started under `env -i`, with `headless_only` and
`UNBROWSE_HEADLESS` on. It started with no routes. `lsappinfo` didn't list it, the guards logged no refusal, and
`paid_usdc` stayed empty.

## Outcomes

| Site | Last run | This run | Outcome |
| --- | --- | --- | --- |
| pinterest.com | 2 pass, 3 ok_but_wrong; 1 judgment | 4 pass, 1 ok_but_wrong; 0 judgments | **pass**, by reading the one check |
| kubernetes.io | 5 pass | 5 pass | **pass** |
| target.com | 4 pass, 1 ok_but_wrong | 4 pass, 1 ok_but_wrong | **pass**, by reading the one check |
| asos.com | 4 pass, 1 ok_but_wrong | 3 pass, 2 ok_but_wrong | **ok_but_wrong** |

20 checks and 20 calls in the record. `suggested` and `classification` differ on Pinterest and Target, and each has its
reason in `note`.

- **Pinterest.** Kitchen, garden and tiny house loft each answer 25 pins and the site's guides for that value, 10 of 10
  guides saying it back, with no judgment. Pins hold only ids and images for a guest, so the guides are what names them.
- **Kubernetes.** Unchanged.
- **Target.** Unchanged. The site's page for this run's nonsense word says "200 results" for it.
- **ASOS stays wrong on one check, and it is no regression.** `dress` is the right page with its products in the answer,
  but it came back as the page's state, whose default fields are `id` and `brandName`, so no product is named until an
  agent asks for `description`. It has done this in three of the last four runs, so the pass in the last run was the lucky
  one. Reading the code, the likely cause is that an example is cut to 24 characters, so `description` never reads as
  saying the search back. I didn't change or test that here. Jacket and walking boots read right.

## The default fields

`richest_list` took the list with the most fields, and the next step kept what said the search back. On a live answer the
filter chips scored 33 fields and four that say the search, and the pins scored 18 and none. A chip describes its look and
its link at length, and a guest's pin is an id and an image.

A chip's link goes back to the page, still asking what it asked: `/search/pins/?q=kitchen%20cabinets`. That is the class: a
list whose records lead back to the page, on its path and still holding a value of its query, is another way of asking it
(filters, tabs, suggestions, next page). It is the page's menu, not what it found, so it no longer counts. Both halves are
needed: a product's link can carry the search on another path, and `/item?id=5` shares a path and asks something else.
`DEFAULTS_RULE` goes to 3, so saved defaults are chosen again once.

## The bank's reader

`largest_records` ranked by length, so 25 ids beat 10 guides that name the search. A list that says words now comes first,
and an address is no record's name. Kubernetes, Target and ASOS read as before.

## The nonsense value

Three nonsense words, each answered 25 pins by the route.

| Word | Pins the route answered | Same pins in the page's own call | Route's pins in the document |
| --- | ---: | ---: | ---: |
| `zqjlqndbxrfz` | 25 | 25 | 0 |
| `zqwvbkxtmjpd` | 25 | 25 | 0 |
| `zqdvjbvjtqjl` | 25 | 25 | 0 |

- **The document holds no pin data.** It has no pin ids or image signatures at all, so comparing with it can't work. The
  page fills itself from its own `BaseSearchResource` call.
- **That call is the comparison.** The node's browser opened each page, and the page's own call for that word returned the
  same 25 pins as the route, in all three.
- **The page shows them.** A screenshot of the page for `zqwvbkxtmjpd` showed that word in the search box and a grid of pins
  behind the login dialog.
- **It looks like a fallback.** The first two words share 5 of 25 pins with each other, and the first shares none with
  `kitchen`.

So the route answers what the site answers, and this is the site's fallback, recorded the way Target and ASOS are. The first
two words ran on the base build, the third on this one. The check itself is unchanged: the rule still reads `ok_but_wrong`,
and the classification differs, with its reason in `note`.

## How far to trust this

- **A walk varies.** Pinterest's route was 8 GETs last run and 4 here, and a slow machine can still end a walk early.
- **Pins can't be read by what they show.** That a pin suits its search rests on the site's guides and on each value getting
  its own pins, not on reading a pin. I did not look at pins for real values.
- **Traffic.** Besides the 20 calls recorded here, this work made five Pinterest calls on or after the base build (one
  learning walk and four to read whole answers) and opened four pages in the node's browser (Pinterest three times, Target
  once). One screenshot was taken, read and deleted.
