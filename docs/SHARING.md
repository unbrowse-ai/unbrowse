# Sharing routes

What a node shares when it lists a route, what it never shares, how it decides by itself what to list, and how another
node finds, checks, pays for, keeps and runs what it shares. Written for engineers changing the listing and fetch
paths, and for owners who want to know what leaves their machine. How the bytes move between nodes is in
[NETWORK.md](NETWORK.md); what listing and fetching cost, and where a fee goes, is in [MONEY.md](MONEY.md).

The code is `unbrowse-node/app/src/`: `recipe.rs` (the body), `listing.rs` (signed listings and roots),
`autolist.rs` (automatic sharing), `share.rs` (serving, fetching, keeping, delisting), `api/goal.rs` (`network_goal`,
`api/call.rs` `call_entry`, `run_route`), `rank/reputation.rs` (which entry is picked) and `main.rs` (`list_route`,
`delist_route`). The protocol is §2, §3, §5 and §7 in the papers (R2.1 to R2.28, R3.1 to R3.12, R5.1 to R5.22, R7.1 to
R7.20).

- [1. Routes as recipes](#1-routes-as-recipes)
- [2. Signed listings under posted roots](#2-signed-listings-under-posted-roots)
- [3. How a caller finds, pays for, keeps and runs a body](#3-how-a-caller-finds-pays-for-keeps-and-runs-a-body)
- [4. Automatic sharing](#4-automatic-sharing)
- [5. A delist reaches kept copies](#5-a-delist-reaches-kept-copies)
- [6. Fees and pricing](#6-fees-and-pricing)
- [7. Which entry is picked: reputation from paid, passed uses](#7-which-entry-is-picked-reputation-from-paid-passed-uses)

---

## 1. Routes as recipes

A node never runs a route for another node. What it shares is the route's **body**: a recipe for making the call,
compiled from the route record by `recipe::of_route`. The same record always compiles to the same recipe (R2.11), so
anyone holding the recording can check a published body.

A recipe (`recipe::Recipe`, format `unbrowse.recipe/1`, or `unbrowse.recipe/2` for a route with optional inputs or a next
page) holds:

| Field | What it is |
|---|---|
| `site`, `method`, `endpoint` | the host and the target step's method and URL template |
| `root` | the page the flow starts from, walked again when the site drifts, without its query or fragment |
| `params` | what the caller supplies, each with its name, whether it is a secret, and its JSON type. Version 2 adds `optional`, the page's own `default` for one, and on a call that needs no session the `options` the page offers. A secret never has a default. Nor does any value the owner's own session gave the page: text they typed, an option they selected, a choice made by a click (whose text the page chose, and may be a token): such an input goes out with no default, an optional one's included, whatever the site said back, and a body in which the value still appears anywhere, matched whole, isn't listed (`Route::given`). And a route any input of which the owner's own browsing session gave is held to the same sources as a walk with a fragment (`Route::session_gave`): what the page made from the owner's value (a code wrapped in base64, sent under another name) can't be found by its text, so every constant must be found in what the site served before the walk's page code ran. A value a caller named for a walk through the API is their own word, and doesn't trigger it. A value the walked address carried only in its fragment never reached a server there, and never leaves the node with a shared route: read from the owner's own walked address at the sharing boundary (`recipe::compile_with`, `fragment_only`), whatever the site answered and however short, it goes out as an input the caller fills with no default, and a body in which it still appears anywhere, matched whole, isn't listed. The owner's own copy may keep a fragment search term as its default, since it came from the owner's address bar and stays on this machine; one the walk sends where a credential goes (a cookie, a header that isn't the browser's own) or that the site is sent and never says back is a secret on the owner's copy too (`trace::fragment_credential`), its walked value kept nowhere (`learn::withhold_secrets`). A walk that was at any address with a fragment, of any shape (`#q=lamps`, `#/reset/…`, `#…`), is held to more, and so is one whose capture can't show it wasn't: the walk's own address, a redirect's `Location`, a callback the page went on to, a hash or history change its code made, a frame inside it (the walk's capture records every address each frame was at, `session::page_address`; a browsing session's capture doesn't, and is read as one that may have been). The page's code reads a fragment whole and what it makes from it can't be found by its text, so on such a walk every text the route carries that the walk wrote (each constant value, each key it goes under, each step's host, each key of the answer it expects) must be found whole in bytes served before any of the walk's page code ran (`learn::page_made`, `sources_before_code`): the walked address outside its fragment, the walk's first document, and what that document names that was fetched before any page code could run (after the navigation and no later than the first script request, a `GET` with no body and only the browser's own headers, its address written in the document, and only when the document runs no code of its own as it is parsed: no inline script, handler, inline frame or `javascript:` address). Nothing that came with a cookie counts, the first document included (page code may have set it, and the site say it back), and no later document does. A header no script may set and a header value the browser sent on its first navigation are the browser's. An answer to a call the page made never counts. A listing already live is held to the same check on every pass of the node and every time it would serve or spread its body (`share::listed_today`): one whose route would no longer be listed is served no more at once and withdrawn by the node's delist path (`autolist::withdraw_refused`), and the owner is told once to walk the page again. A route with anything else, or one whose walk wasn't read this way (`Route::walk_without_fragment` false and no `page_made`), isn't listed, and what was taken out of it must be gone whole however short |
| `session` | the kind of session the call needs: `none`, `cookie` or `bearer`. The caller's own session supplies it |
| `response` | the target's response shape: field names and types, no values |
| `write`, `browser_assisted` | whether a step changes state on the site; whether a value only page code computes |
| `steps` | the setup graph, in order, the target last. Every field names where its value comes from at call time |
| `paging` | version 2: how the call reads on to the list's next page |

A route with neither optional inputs nor paging compiles to version 1, byte for byte, so its content identifier doesn't
change. A node older than version 2 refuses a version 2 body after paying for it, so a release that lists one raises
`MIN_VERSION`.

A field's source (`recipe::Source`) is one of: `param` (the caller's value), `constant` (the same for everyone, with
where the site serves it when the walk showed that), `response` (read from an earlier step's answer), `session` (a
cookie or header of the caller's own session for the site), or `browser` (made by page code in the caller's browser).

**The content id.** A body is named `sha256:` plus the hex SHA-256 of its canonical bytes (`recipe::content_id`): the
recipe as JSON with every object's keys sorted by their UTF-8 bytes, no whitespace, `serde_json`'s escaping, numbers
in their shortest form (`canonical_json`). Reformatting never changes the id; any change to what the body says does. A
served body must be those bytes exactly (`verify_body`), so one id names one byte string. A body is at most 64 KiB on
the wire ([NETWORK.md §6](NETWORK.md#6-the-body-protocol-and-vouchers)).

**What a body may never carry** (R2.10). `of_route` takes out every cookie value, token, authorisation value, session
value, value seen only once, vault reference and value the contributor typed, and refuses, with the reason, rather
than scrub when a credential would have to be removed to share the route (a quiet scrub changes the call). It refuses
a route that:

- is a socket's: its opening frames can't be told apart from the session that sent them;
- carries a value in `authorization` or `proxy-authorization` the site never served publicly;
- carries a token-shaped header value (16 or more characters, letters and digits, no spaces) with no public source;
- would still show a removed personal value anywhere else in the body, plain or percent-decoded.

`recipe::check` runs on every body, on the contributor's side before it is listed and on the caller's before it runs:
the right format, no cookie with a value, no credential or token-shaped header without a public source, and no string
anywhere that names a vault login. A route whose body would carry anything of the session is never listed.

**A body may carry its site's sign-in** (`Recipe::sign_in`, `credential.never`: a secret is an input each caller fills
from its own vault). A route that needs a session is listed with the node's own kept sign-in for the site, made
anyone's: its password is the secret `login.secret` and the account it typed `login.account`, neither with a value,
and the owner's account, the login's name and the password are looked for in the whole body before it goes
(`setups::shared`). It is held to `recipe::sign_in_admitted` on both sides: someone else's code's rules, https to fixed
hosts on the site itself, and the two values sent only in the body of its last request, which changes the site. A
caller's node with no session on the site asks its owner whether to sign in as the login its own vault holds there;
on yes the sign-in becomes its own kept sign-in (`setups::adopt`, `run::signs_in_as_its_owner`), sealed under that
login and sent as one it walked itself is. With no login for the site the call says how to add one. A node can sign in
with another's sign-in only as its own owner.

Bodies a node lists or keeps live in `~/.unbrowse/bodies/sha256-<hex>.json`, and are read back only if they still hash
to their id (`load_body`). The folder is bounded by `storage_gb` ([§3](#3-how-a-caller-finds-pays-for-keeps-and-runs-a-body),
the body store).

---

## 2. Signed listings under posted roots

A **listing** is the contributor's signed word that a body is theirs, and on what terms (`listing::SignedListing`,
R2.14 to R2.19):

| Field | |
|---|---|
| `route_id` | the route; its on-chain entry id is `keccak256(route_id)` (`chain::entry_id`) |
| `site` | the host the route calls, the entry's domain |
| `content_id` | the body's id |
| `agent_id` | the contributor's ERC-8004 `agentId`, or its wallet address on a devnet with no registry |
| `version`, `supersedes` | 1 for a route's first body; a changed body is the next version and names the one it replaces (R2.6) |
| `terms` | the description (the contributor's words, read as data), the response shape cut to 4 KiB (`bounded_shape`), and the price: `detail_fee` in `USDC` |
| `sig` | the owner key's signature |

The owner key signs it as EIP-712 typed data under Settlement's domain (`chain::domain`), so a signature holds on one
chain and one deployment only, and is never a voucher's.

**Posting a root.** Before a listing spreads, its node posts a Merkle root holding its leaf (`postRoot`), so the root's
block proves the listing existed by then (R2.19). The leaf is `keccak256(keccak256(digest))`, OpenZeppelin's
double-hashed leaf in sorted-pair trees. `listing::publish` signs the listing, keeps the body, posts one root over every
listing not yet under one (`post_pending`, which also retries a post that failed before), and records each root with
its leaf list in the node's **book**, `~/.unbrowse/listings-<chain id>-<settlement>.json`: one book per deployment, so
a new devnet or another network starts with none. Listing the same body again changes nothing.

**Listing a route** (`main.rs` `list_route`, the owner's command and automatic sharing alike):

1. Refuse the owner's own routes and another contributor's bodies; compile the body (`of_route`), refusing what can't
   be shared, before anything is written.
2. `listing::publish`: sign with the node's own wallet's key, under its own identity (a key the owner's wallet granted
   signs no listing: the owner decided issue #184, reversing spec §76.2 item 1), price it in its terms (the on-chain fee if the wallet set one, else `STARTING_FEE`), keep it, and put
   it under a root: the reserve's poster's (R2.20) or the node's own `postRoot`. Nothing is written to the chain for the
   listing itself; the body's first claim shows it (`showAndClaim`). A delisted body credited to this wallet is
   relisted (`relistEntry`).
3. Spread it only once its root is on chain (R2.19).
4. Provide the site's key and the body's key ([NETWORK.md §4](NETWORK.md#4-site-keys-and-provider-records)).

**Reading one** (`listing::verify`, R2.15). A node keeps a listing another node sent only when:

- the signature recovers to the key of the contributor identity it names (the ERC-8004 identity's owner);
- its root was posted on chain;
- the chain holds the entry, live, as that contributor's, for the site the listing names.

Unsigned listings, from nodes that predate signing, are dropped. A delisted entry's listing no longer spreads: a node
answers seekers only with listings whose entries the chain shows live ([NETWORK.md §5](NETWORK.md#5-the-listings-protocol)).

---

## 3. How a caller finds, pays for, keeps and runs a body

**Finding.** `unbrowse_search` asks the network for a query that names a site, and ranks other nodes' listings with the
node's own routes. `unbrowse_do` with a url tries other contributors' listings for the page's site before the browser
(R3.1, `api/goal.rs` `network_goal`): those the peers answer with, plus listings for the site it read and checked before.
A listing is a candidate when its description says the same words as the goal (any order, any case, `goal_words`), it
wasn't just tried from a kept copy, and it isn't in the dark set. Candidates are tried in the order §7 gives: the
route's default first.

A listing is taken for a goal only when its description has the goal's words. The site's other listings aren't
guessed at: `unbrowse_do` gives them to the agent in `network_offers` (entry id, what it does, fee), and the agent calls
one that does what it asked with `unbrowse_call` and the entry id (R3.2, `Skipped::offers`).

**The per-fetch maximum.** The node pays another contributor's fee by itself, with nothing to approve, up to the
owner's `max_fetch_usdc` (0.05 USDC by default, `store::MAX_FETCH_USDC`; `unbrowse-node max-fetch [usdc]` or
Settings). A listing over it is passed over as if it weren't offered: search marks it `over_max`, `unbrowse_do` says so
in `network_skipped`, and `call_entry` checks the fee the chain holds now once more before paying (`over_max`, R3.3).
At 0 the node uses only free routes and its own. A maximum the node can't read (a hand-edited file) pays for nothing.

**Paying and fetching** (`api/call.rs` `call_entry`, `share::fetch`):

1. Read the entry from the chain: live, its contributor, its fee.
2. Take the fee's place under the agent key's cap per epoch and the payer's deposit (`chain::reserve`),
   before the body is fetched or the site hears anything. A call the cap or the funds can't cover is refused here, and
   two calls running at once can't both take the last room.
3. Ask the contributor's own nodes first (from its identity's metadata), then the providers the table lists, without
   any set aside for this body. Each ask pays with a fresh body voucher
   ([NETWORK.md §6](NETWORK.md#6-the-body-protocol-and-vouchers)).
4. Check the bytes (`recipe::verify_body`). A body that isn't the listed one is never used or paid for; its provider
   is set aside and the next asked.
5. Make it a route of this node's (`recipe::into_route`): no listing of this node's, no jar of its own, a `fetched`
   record naming the entry, the contributor, the content id and the listing's words, and the same site as the listing
   or it is refused.

**Running.** `run_route` runs it under the node's own session and every check a call gets: the owner's exclusions, the
egress rule, the vault's binding of each login to its own site, and `share::bound`, which sends a session value or a
secret only to hosts on the site the body lists, by registrable domain, and never to a host built at call time. Nothing
the call sends or gets back passes through the node that served the body.

**Someone else's route never reaches the owner's network** (R2.28, `share::egress`). A route this node didn't learn
itself is someone else's code, so every request it makes is held to two rules, whatever the owner's Reach private
networks setting says (that setting is for the owner's own routes and their intranet):

- **HTTPS only.** No `http://`, no other scheme.
- **Public addresses only.** Every hop, setup steps and redirects included, must resolve to a public internet address:
  not loopback, private (RFC 1918), CGNAT, link-local (169.254.169.254 among them), unique-local, multicast,
  unspecified, or an IPv4-mapped form of those, and not a name no public suffix lists.

The rule is passed down with the call (`unbrowse_learn::egress::Egress::Foreign`, `RouteClient::with_egress`), so the
transport checks it on every request and redirect hop, and its resolver checks the address it connects to, so a name
rebound inside after the check can't get round it. A step that breaks either rule fails the call before anything is
sent, and the error says which rule. Such a route runs in the browser only when the owner turns on `shared_mint`,
only on its own site, and only in an empty profile of its own: the browser connects by itself, out of reach of the
per-call rule. The body is checked against the same rule
when it is fetched (`recipe::goes_where_it_may`): one that names plain HTTP or a private address is refused before it is
kept, and set aside by its content identifier (`Share::set_aside`), not marked dark, since it was served. A call the
rule refuses was never made, so it makes no line, and the entry is skipped.

When the owner's Reach private networks setting is on, a call of such a route also never goes through the node's
local proxy for a pinned site: the proxy resolves names under the node's own rule, which that setting loosens
(`client::resolves_under_its_own_rule`).

**Someone else's route acts in the owner's session only with the owner's yes to that route.** A request's method says
nothing about what it does to the account: a GET can sign the owner out or unsubscribe them. So a route this node didn't
learn sends none of the owner's session (no cookie, no token, no page storage of theirs) until the owner allows that
route to act in their session on its site. The owner is asked once per route, in the owner dialog, which no agent or
local process answers (`run::owner_session_for`). The yes is kept in `shared-sessions.json` under
`client::consent_digest`: a hash of the body's content identifier and the graph the route runs. It holds for that graph
only. The client measures the graph again whenever a run would be handed the owner's session
(`RouteClient::owner_material_for`). A chain a heal rebuilt, or any graph but the consented one or its target alone,
runs with none of the owner's session and is asked about again on the next call. A no runs the route with none of the
owner's session.

The question shows the route whole or not at all (`run::consent_question`). It shows:

- every request, in the order it is sent, a repeat listed again;
- its method and full address: scheme, host, any port, path, and the query the call builds;
- every query, header, cookie and body value, and where it comes from (fixed values in full, an input's default
  included). A value read from an earlier answer is shown with its exact selector: a JSON pointer (and where the
  caller's value takes a segment's place), a header, a cookie the answer sets, or the text between two marks and
  which occurrence. Any text sent around it is shown, and the question says the value read is sent on;
- each body as it is templated;
- the exact origins the session goes to, and that no other host gets it, another host of the same site included;
- the start page, and whether it is fetched with the session;
- the page the requests say they come from;
- that the session the site sets during the call goes along too.

It is plain ASCII: controls, bidirectional and invisible marks and non-ASCII letters are written as code points, and
hosts appear in their `xn--` form.

What the question can't describe is never asked about, and the route runs with none of the owner's session
(`run::describable`). That covers a page the route boots, its scripts or markup, the answers the page read, a step the
page's code signs or a browser runs, a producer or any other value made by page code, a value held inside another, a
multipart or opaque body, an address (a step's or the start page's) with a user name or password in it, and any part
added to the graph later. A user name or password in an address would go out as the request's credentials. A
stranger's route never sends one, in any request or redirect hop (`Egress::request`). The check is default-deny over the serialized graph.
A route over the bounds isn't asked about either: more than 12 requests, more than 16 values in a request, a value over
80 characters, a body over 400 characters, or a question over 6000 characters.

A stranger's route reaches only the exact origins its graph names (`client::origins_of`), on its own site: a request
anywhere else is refused before it is sent. The rule travels with the call's transport (`replay::Within`, held by the
call as `client::Held`), so every request of the call, the start page, the page fetched for another value and every
address a redirect leads one to are checked against it before anything is sent there (`Fetch::fetch_within`): a hop to
an origin the graph doesn't name, or a redirect whose answer replaces the owner's session, ends the fetch there with
nothing sent on and nothing of the other address's answer handed back. A cookie of the owner's jar is attached only where both hold: the request's
origin is one the route names, and a browser would send the cookie there (`client::Sent::goes_to`): its host, or a host
its recorded `Domain` reaches; a path its recorded `Path` covers; unexpired; over HTTPS. That holds for a cookie a step
names by its own field too: where it wouldn't go, it is taken off the request. The jar keeps each cookie's path and
whether it is HttpOnly beside it (`jars/<host>.json.meta`), as the walk's browser reported them or as the line that set
it said; a cookie whose path was never recorded goes as a root-path cookie. A page's script the node runs (the signing
sandbox, a door's own page) reads in `document.cookie` only what a browser shows a script on that page: the cookies that
go with a request to it and are known not to be HttpOnly (`client::Runner::page_cookies`). The page's own code asks, through the
node, only the origins the route's graph names, redirects included, as every step of the call does
(`client::Runner::page_asks`); a sibling host of the site is refused with nothing sent. A door's own page that a call computes instead of opening a browser (`client::RouteClient::compute_the_door`) is held to the same rules: its scripts and calls go through the call's `Within`, carry only the cookies a browser would send them and this call may carry, its script reads only cookies known not to be HttpOnly, and what it earns joins the jar through the checks an answer's cookies meet, never replacing the owner's session. A cookie whose HttpOnly was
never recorded (a jar from before it was kept) is treated as HttpOnly: kept from the script. What was once known hidden stays hidden for that value: a site setting the same value again without HttpOnly, or a browser saying so, leaves it hidden (`client::kept_from_script`); a new value takes its own line's word, as a browser does. Such a cookie is also set HttpOnly when a walk's
browser is seeded with it (`session::seed_params`). The jar holds one cookie per name, and keeps it whole: one
line's value with that same line's domain, path and life (`mint::keep_line`). Of two cookies of one name with different
reaches it keeps the narrower, and on a tie the one already held, so a value is never sent where its own line didn't
send it; HttpOnly is never loosened by the choice (SECURITY.md, "One cookie per name"). A sibling subdomain, which may be someone
else's, gets nothing. A route that could use no session (the owner holds none for its site, and none of its steps names
a session value or is answered with a cookie) isn't asked about.

Nor does it carry a session it made for itself without that yes. A cookie or token the site sets during the call
(a sign-in fixed in the route, under a name the owner's jar never held) is never sent again in that call. The rule is
`client::sendable`: a stranger's call carries only what the owner's jar held when it began. So the caller's values never
reach an account the route's author signed it into. The owner's yes covers both, and the question says so.

With that yes, it runs under the owner's session for its site, and nothing it earns is kept:

- **No write to the jar.** Cookies and tokens its answers set live for its call alone. That covers each step, its
  redirects, the browserless re-mint of its start page, its heal and the page code's own fetches. They are never saved
  to the owner's jar, its scope, metadata, storages or fingerprint, and the next call starts from the owner's session
  again (`RouteClient::keeps_the_session`).
- **No change of whose session it is.** An answer that sets another value for, or takes out, a cookie of the owner's
  session the request carried ends the call there, before anything more is sent. A sign-in as someone else and a
  sign-out both look like that. The node's own routes take a rotated session as before.
- **Every fixed value is admitted** (`recipe::check_foreign`), not only its declared fields. That covers what its body
  templates fix (JSON leaves, form values, multipart parts), its literal path segments and its start page's path. Each
  is checked as a constant with no public source, under its own name. A template value must also match its declared
  field. The start page must be a bare page (no query, no fragment) on the listing's site.
- **No owner reads in its writes.** A write never carries a value an earlier step read under the owner's session
  (their account page, their address) unless the owner allows that one call. The owner is asked before anything is
  sent (`run::session_reads_in_writes`), and the client refuses such a write that wasn't allowed.
- **Heals happen in an empty profile.** With `shared_mint` on, its heal walks in an empty profile of its own, in the
  node's folder and removed with the call, never in the site's signed-in profile or a browser the owner has running.

**Billing and keeping.** The use's receipt line names the node that served the body as its **server**, which is paid
no share (R7.6). The line passes only if the call did, judged by the caller from what it received. Only a passed line
keeps the body (`share::keep`): a body this node keeps is one its use was billed for. Once kept, the route
is reused with no new payment while it works (R3.12). When the owner serves kept routes (`serve_kept`, off by default),
the node also seeds it and serves its listing, so the route stays findable while its contributor is offline (spec
§103); off, using a route says nothing to the network. A kept route that fails is let go, and the
next call fetches the entry afresh. This fetch is the only call a node pays for: a route it learned itself is free
to its own agents, listed or not ([MONEY.md §3](MONEY.md#3-where-money-flows)). A passed line is also sent to the contributor's node to keep and claim
(`network::send_receipt`); if it doesn't arrive, the payer's own claim pays it. When no provider serves the body, the
line is written as failed and pays nothing.

**The body store** is bounded by the `storage_gb` setting, in decimal gigabytes (`store::body_bound`), and kept within
it after every body kept, as the node joins and on each minute's background pass (`share::trim`). Pinned bodies are
never let go:

- every body the node lists itself, any version;
- a body a route made from it was called or fetched within the last 7 days (`PINNED_FOR`), so a task an agent comes
  back to weekly never pays twice for the same body;
- a body file kept within the last 10 minutes that no listing or route names yet (`JUST_KEPT`): whatever kept it is
  about to.

Past the bound the rest go least recently used first, and only as many as it takes. A body's last use is the latest of
its file's modified time (set when it is kept, and again each time a paying caller is served it, `recipe::used_body`)
and the last call and fetch of each route made from it. A body's footprint is its file and those route records. A body
let go takes its routes with it, and the node stops providing it (`stop_providing_body`); the next call for the entry
fetches it again and pays. Everything is read from disk each time (`share::body_store`, `recipe::kept_bodies`), so a
restart, a crash or a file removed by hand never leaves the count wrong. A store whose pinned bodies alone are over the
bound keeps them all. Held routes (`hold_routes`) are listings in `held.json`, not bodies, and are bounded separately
(`peers::max_held`).

**Paid writes only for goals that ask for a change.** A listing doesn't say whether its route writes; the body does.
Another contributor's route that writes runs, paid for without the owner, only for a goal whose own words ask for a
change (`writes_goal`: buy, post, send, cancel and the like). For a goal that only reads, a fetched body that turns out
to write is billed as a passed fetch (the server did its work) and kept for a goal that asks for a change, and nothing
runs (`call_entry`, `reads_only`). A kept body that writes never answers a read. A route that pays with a vault card
waits for the owner on every call, in the window (`api/call.rs` `approve_route_payment`).

---

## 4. Automatic sharing

The node lists the routes it learns by itself, so others can fetch them and pay their fee (`autolist.rs`). A listing
writes nothing to the chain: the node signs it, a root holding it comes from the reserve's poster or the node's own
`postRoot`, and the first claim shows it ([MONEY.md §4](MONEY.md#4-sharing-routes-and-what-a-day-of-it-costs),
[LISTINGS.md](LISTINGS.md)). `share_routes` decides which routes, and `list_per_day` how many a day, so what the owner
shares grows at a pace they can review:

| Mode | Lists | A day, unless the owner sets `list_per_day` |
|---|---|---|
| `used` (the default) | a route once the node's agents keep using it: passed on 3 different days, or 5 times (`DAYS_EARNED`, `RUNS_EARNED`). The most used first | 5 |
| `all` | every route, once it has run successfully once | 20 |
| `off` | nothing by itself | 0 |

A release can change the default for fresh installs with `UNBROWSE_SHARE_DEFAULT` at build time
(`build_config.rs`); a settings file the owner already has keeps what it says.

A route is listed only when all of these hold (`autolist::plan`, `blocked`):

- the owner has signed in, and the route was learned after (a route learned before stays on the node, `Route::local`),
  and the owner has let the node share (Share them now in My routes, `share_approve`), or a day has passed since it told
  them which routes (`share_preview_told`). Reading `share_status` is neither;
- it has run successfully through this node: a recording that never worked is never published;
- in `used` mode it has earned it, unless the owner shared it by hand;
- the mode isn't `off`, its own `share` isn't `false`, no host it reaches is excluded, and it isn't one the owner
  delisted before (a delisted route comes back only when they share it again);
- it can be shared at all: not another contributor's body, and `of_route` takes its body (a route from the owner's own
  browsing is shared as its recipe, with placeholders);
- the node can list: its key is unlocked, it is on the peer network, Settlement is deployed, and its key can pay the
  gas ([ONBOARDING.md §3](ONBOARDING.md#3-paying-your-own-way)). When it can't, it says so once on the log and tries
  again each pass; a sign-in wakes it at once (`retry_now`).

Each minute's pass lists at most 2 (`PER_TICK`) and no more than the day's cap leaves; the day's count is kept in
`~/.unbrowse/autolist.json`, so a restart never resets it, and a listing is counted before its write. A listing that
failed for any reason but gas is tried again an hour later (`RETRY_AFTER`); out of gas, the rest wait for funds. The
first run with sharing on says so once, on the log and in the window (`autolist::notice`).

**Opting out:**

| | From a shell | Effect |
|---|---|---|
| Globally | `unbrowse-node share off` | lists nothing more. What is listed stays listed |
| A site | Settings, excluded sites | a route reaching an excluded host is never listed |
| A route | `unbrowse-node share route <id> off` | kept off the network from now on. What is listed stays listed: turning sharing off delists nothing (R2.14a); delisting is a separate signed withdrawal (`delist_route`, `share delist`, R2.16). `on` shares it, even before it has earned it |
| Everything | `unbrowse-node share delist` | delists every route this node lists, each kept off until shared again (`autolist::delist_all`) |

`unbrowse-node share` shows the mode, today's count against the cap, what stops listing now, and each route's
standing. The window shows the same in Settings ("Share routes I learn") and on Routes. The commands are listed in
[CLI.md](CLI.md#share).

---

## 5. A delist reaches kept copies

Delisting (`delistEntry`, `main.rs` `delist_route`) is the contributor's way to withdraw a route, so it has to reach
every node that kept the body, not only those that fetch it afresh (`share::still_listed`):

- A kept route that **reads** asks the chain at most once every 10 minutes (`LIVE_FOR`) and keeps running while the
  chain can't be read: what it does is only read.
- A kept route that **writes** asks the chain every time, and never runs on an answer it couldn't get.
- A delisted entry's route is dropped, and its bytes too unless they are a body this node lists itself. The call says
  so, and `unbrowse_do` goes on to other routes or the browser.
- The background pass checks every kept body the chain hasn't shown live within `LIVE_FOR` (`share::check_kept`), so a
  delisted route stops being offered within that bound even when no agent calls it.
- Mostly it is far sooner. The contributor's node says it delisted the entry on the site's gossip topic
  (`share::announce`), and every node that keeps a copy watches that topic and reads the chain again at once when a
  notice names one of its entries (`share::on_change`): the copy is dropped within seconds. A reprice is told the same
  way, and a node holding the route takes the new fee. The notice only makes the node read the chain; the chain decides
  ([NETWORK.md §15](NETWORK.md#15-change-notices)). For an entry no claim has put on the chain yet, which the chain
  can't show delisted, the notice carries the delist signed by the key that signed the listing, and a node that kept
  the body drops it on that signature alone, once no other contributor's listing of the body stands (R2.16).

A delisted entry's listing stops spreading at once: seekers are answered from the chain as it is
(`peers::listings_changed`).

A site delists its own routes two ways: a robots group naming `Unbrowse` (R4.32), which needs no proof, or its site
policy (`Domains.setSitePolicy`, R4.17), which needs its domain's wallet proven by DNSSEC
(R4.14). The chain stores the policy, its fee floor and the hosts it declares. The node honours it (`app/src/sitepolicy.rs`),
reading each site's policy from `Domains.policyOf` at most once an epoch, for the sites its routes call (the
background pass) and those whose entries it is about to pick (`network_goal`, a fetch by entry id):

- **The floor.** An entry priced under it is refused before anything is paid: a pick tells the agent why, with the
  floor, among the entries it tried; a fetch by entry id answers 403 with it; a search marks the entry `site_policy`.
- **The delisting.** A delisted site's entries leave the live set (R3.36): they are not called, a search marks them
  `site_policy`, and the owner's list of routes on the network leaves the site out.
- **The hosts.** A host the policy lists, exactly, under the path prefix it gives, is the site's own (R2.27 (b)): a
  body another contributor listed may send this node's session values there (`share::bound`).

---

## 6. Fees and pricing

A node has one detail fee for every route it lists, set on Settlement (`setFee`). It starts at 0.01 USDC and, with auto
pricing on (the default), moves at most once an epoch with its paid fetches and the median fee other contributors list
for the same sites, between the owner's floor and ceiling (`main.rs` `reprice`, `peers::market_fee`). Each passed fee
splits 65 / 30 / 5 between the route, the site's escrow and the burn (`LeanSettlement` `ROUTE_PCT = 65`). The route's
share pays the stake behind the entry and buys its coin for the payer; no server and no platform is paid a share.
The numbers, the gas and the claim timing are [MONEY.md §2 and §3](MONEY.md#3-where-money-flows).

---

## 7. Which entry is picked: reputation from paid, passed uses

Several contributors can list the same route: the same site, and descriptions with the same words. Every node ranks
them itself, from the chain's own record (`chain::reputation_history`, `rank/reputation.rs` `standings`), so no node is
trusted for a score and two nodes that read the same listings on one chain pick the same default (R5.20; the function
is version 1, sent as `reputation.version`). The node reads the chain up to its finalized block and counts closed
epochs only. The chain keeps a hash of an entry's site and none of its words, so those come from the signed listing the
node holds. An entry it holds none of stands alone (`route_of_entry`) until it reads one, and takes its route then.

**What counts.**

- **A use** is a claimed line, paid from a deposit. Settlement claims only passed lines, so every claim is a passed
  use.
- **A linked payer's use is no switch evidence** (R5.18). It still counts in shared reputation, the entry's pass rate
  (R5.3), but never towards a challenger taking the default or an entry leaving unverified. A payer is linked to a
  contributor when it is the contributor, or the
  payment graph has a path of at most 2 edges from the contributor to it. The edges are what the chain shows:
  - a claimed line runs from its payer to the entry's contributor;
  - USDC sent from one wallet Settlement knows to another runs from the sender to the receiver;
  - an agent key runs both ways with each wallet that authorised it or paid through it.

  The use being judged runs from the payer to the contributor, so paying a stranger never links a payer to it. The
  contributor's money or keys reaching the payer do. So does a ring whose members pay each other.
- **A payer's standing** `w(j)` (R5.2) comes from its independent lines before that epoch, on entries of contributors
  it isn't linked to:
  - it is zero for a payer with no record: fewer than 20 such paid lines over the 30 epochs before the use
    (`RECORD_LINES`, `RECORD_WINDOW`; the old site and age counts are retired);
  - otherwise it is the geometric mean of `x / (x + h)` over three things: the payer's age in epochs (h 7), its spend in
    USDC (h 0.5) and its spread, the distinct routes and sites it paid for (h 5). This shape is the client's default
    while `rating.payer_weight` is open.

  A ring that pays only itself has no standing to lend.
- **A failure** counts only from a verified person (R1.33, R5.4), once per person per route per epoch. No proof of
  personhood is chosen yet (R1.34), so the hook (`Personhood`, `NoProofYet`) verifies nobody. A use that ran and failed
  here demotes the entry in this node only, for 2 hours (`demote`).
- **Canaries** (R5.8 to R5.10): a revealed set counts once its epoch has closed, from the disclosed operator (the
  platform, Settlement's `platform()`), when it matches the first commitment the operator made for that epoch. A canary
  line is never a use. A payer that misreported one has no standing for 30 epochs. Settlement has no place for
  commitments or reveals yet, so none are read; the client side is built and tested.

**The formula.** Each use by a payer with standing adds `w(j)` to its entry's `P`, and each counted failure adds it to
`F`; the same sums less linked payers' are the entry's switch evidence. Both decay by
`δ = 0.5^(1/7)` an epoch (a half-life of 7 epochs). The pass rate is `θ̂ = (2 + P) / (4 + P + F)` (R5.16).

**The default** (R5.17):

- A route's default starts as its earliest live listing. An entry with fewer than 30 counted uses is tagged
  unverified (R3.36); that tag is no floor on the default.
- The default keeps its place until any live challenger's switch evidence shows `P(θ_c − θ_i > 0.02) ≥ 95%` under the
  two Beta posteriors, tested at every epoch. Ties keep the earlier listing.
- A default that stops being live hands over to the live entry with the best switch evidence, the earlier listing on
  a tie.

**Picking** (`rank::reputation::order`, used by `network_goal`):

- The default is tried first, then the rest by pass rate, counted uses, fee and listing.
- 5% of picks for a goal that only reads try an unverified entry first (R3.4). The entry is chosen in proportion to its
  contributor's travelling pass rate (R5.5): its uses on domains whose escrow another wallet claimed, plus, for an
  entry on its own claimed domain, its uses there; uses on an unclaimed domain count for nobody. A domain's escrow
  claimant is the wallet its latest DNSSEC proof names (`Domains`). The reply says `explored: true`. A failed line pays nothing,
  so an exploration pick costs a payer nothing but the try. A goal that writes never explores.
- An entry demoted here goes last.
- An entry the chain doesn't show yet is unverified, with no evidence.
- If the chain can't say within 5 seconds (`STANDINGS_WAIT`; 1 second for a search), the pick goes without the
  standings: every entry is unverified, and they're tried by fee. The read goes on for the next pick.

**Showing.**

- `unbrowse_search` gives every network route a `reputation` object: `default`, `unverified`, `counted_uses`,
  `pass_rate`, `unavailable` (off the ranking, R7.12) and `version`.
- Within one route the default fills the first place its entries won.
- The owner command `entries` (the window shows it on the Leaderboard, under "Routes on the network") lists every
  route on the chain with its live entries, the default first.

**What this means today.** No failure reaches the chain, so `F` is 0 everywhere, and the pass rate measures decayed,
independent passed use. An entry that works keeps the default. A broken default loses it once its callers' nodes move
to the next entry (each demotes it locally for 2 hours) and its evidence decays. In the scripted test
(`the_default_follows_passed_independent_use`) that takes 22 epochs. The evidence cap (`ranking.evidence_cap`) is left
unset: with `F` at 0, any cap would freeze the default.

Tests (`rank/reputation.rs`, `api.rs`, `chain/`):
- `the_default_follows_passed_independent_use`
- `a_sybil_ring_paying_itself_does_not_move_the_default`
- `unverified_entries_still_get_explored`
- `a_failure_counts_only_from_a_verified_person_once_a_route_a_day`
- `a_payer_that_misreports_a_canary_has_no_standing_for_the_penalty`
- `the_switch_test_is_monotone_and_ties_keep_the_incumbent`
- `a_routes_entries_reach_an_agent_default_first_and_tagged`
- `the_chain_shows_each_use_key_and_send_reputation_reads` (Anvil, ignored)

## 8. Links

Every listed route has an address you can share. `unbrowse_search` and `unb search` show it as `link`:

```text
unbrowse://example.com             the routes the network lists for a site
unbrowse://example.com/0x<entry>   one route, by its entry id
```

The entry id comes from the route's body, so a link keeps naming the same body. A route only your node holds has no link.

Open a link with `unb open <link>`, `unbrowse_open` or `open(link)` in the SDKs. On a Mac, clicking one opens Unbrowse.app, which shows what the link names. The node reads the listings from the network, checks them against the chain (spec §102) and says so when it can't.

Any page can fire a link at your machine, so opening one calls nothing and pays nothing. A link can name a site and one entry. The node refuses anything else, such as a port, a login, a query or a non-ASCII host. To use a route, call it by its id: the key's cap and your per-fetch maximum apply as usual.

Linux and Windows builds take a link as an argument to the window, but no installer registers the scheme there yet.
