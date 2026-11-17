# Learn a route while browsing

Every step driven in the node's browser is recorded, and the node distils the walk into a route. There is no separate
"learn" command: learning is what browsing through the node does, as long as **Map while browsing** is on
(`map_while_browsing`, Settings). With it off, browsing teaches nothing, and `unbrowse_do` with no route answers "the
owner has turned learning off" (`api/goal.rs` `do_goal`).

## Watch it learn

Open **Live** in the native window while the node walks (`window/src/screens/live.zig`, `kept.zig`). It shows:

- the browser's pictures as it walks (pictures only: nothing the browser sends or keeps leaves it);
- the calls the node weighed against the goal ("Weighed 3 of 41 calls against the goal");
- the one it kept, and what picked it.

The kept call, with the chain of calls it depends on and your inputs marked, is the route. The Node screen's agent's
eye shows the same in short. The route then appears on **My routes**.

## What makes a good route

- **Reach the thing directly.** A page that shows the result for one input teaches a route whose input is clear.
- **Do it once, cleanly.** A short, direct walk distils best; wandering adds calls the node must weigh and drop.
- **Let it settle.** The node waits for the page to settle before it weighs the calls.

## Healing

A site changes. When a route's call fails, the node re-walks the route's root page in that site's browser, recomputes
the chain from what it sees, and retries once (`crates/learn/src/client.rs`; `run.rs` `call_with`). Live shows it as
"Re-walking". One re-walk runs per site at a time: other calls that fail meanwhile fail rather than open another
browser. If a read still fails after the heal, `unbrowse_do` learns the goal afresh from its URL and says which route
broke in `route_failed`.

A write the site may already hold is never healed and retried, so it can't be sent twice. The reply's `retry` says
what to do: `as_is` (run it again), `check_first` (ask the site what it holds) or `never` (it landed).

## Sharing it

The node lists the routes it learns by itself (`autolist.rs`), so other nodes can find and use them. 65% of each
fetch fee is the route's share: it is owed to you as contributor until the entry has a coin, and then pays the coin's
stakers and buys the coin for the payer ([MONEY.md §3](../MONEY.md#3-where-money-flows),
[Payments and UNB](../concepts/payments-and-unb.md)). Listing holds nothing up
front; its network fee comes out of the node's balance ([MONEY.md §2](../MONEY.md#2-every-action-that-needs-funds)).

| `share_routes` | What is listed |
|---|---|
| `used` (default) | a route the node's agents keep using: passed on 3 different days or 5 times, the most used first, at most 5 a day |
| `all` | every route once it has run successfully, at most 20 a day |
| `off` | nothing; what is listed stays listed until you delist it |

Nothing is listed before you sign in, and a route learned before your sign-in never is. A route learned from your own
browsing is listed like any other, as its recipe with placeholders. Never listed, in any mode: another contributor's
body, one that reaches an excluded site, one you kept off or delisted, or one whose body would carry anything of the session
(`recipe::of_route`). Set the mode in **Settings**, **Share routes I learn**, or with `unbrowse share used|all|off`;
`unbrowse share` says where each route stands. List one by hand from **My routes** (List it), or keep one off with
`unbrowse share route <id> off`. All of it: [SHARING.md §4](../SHARING.md#4-automatic-sharing).

Related: [Unbrowse a site](unbrowse-a-site.md) · [ARCHITECTURE.md §3](../ARCHITECTURE.md#3-the-pipeline-browse-once-call-forever).

## Filters and next pages

A route takes more than the walk asked for when the walk shows it (`crates/learn/src/paging.rs`,
`crates/learn/src/controls.rs`):

- **From the call's repeats:** a value that climbs is a page number or offset, a value the last answer handed over is a
  token, and a short value a reader changed is a choice. An opaque value keeps the first call's value.
- **From a server-rendered page:** its GET form and the links that change one query key say what it takes.
- **By trying the page:** once a read is learned, the node opens its page in the background and tries its controls one at
  a time (`learn::try_the_page`), opening collapsed panels and putting each toggle back. It leaves alone a page's header
  and footer, dialogs, forms that post, sign-in forms and switches.

Trying the page runs in a new, empty browser profile that is thrown away after, because a click on a signed-in page can
change what an account holds. Nothing there is signed in, so a route that needs a session shows nothing new this way. A
site that refuses an empty profile shows nothing either.

These are the route's optional inputs, with the values the page offers in `options`. An optional input left unset sends
the first call's value, or nothing. An input whose value the owner's own browsing gave the page is shown to an agent
with no default and `supply: true`: the agent sends its own value, and one it leaves out is refused by name. When an answer is one page of a list, `result.more` holds the inputs that read on.
