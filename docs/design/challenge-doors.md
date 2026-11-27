# A challenge door: passing a page's own check, as part of a route

Status: design and first experiment, 2026-11-23 (staging `13543f0ea`, the BAILII `u6:court-researcher-4` bank task).

**The question.** When a route's call is answered with a page whose own script is the check — a proof of work, a
"one moment" interstitial — how does the node pass it *as part of the route*, browserlessly where that is honest, and
what is already there to do it with?

## The case

`https://www.bailii.org/cgi-bin/lucy_search_1.cgi?query=restitution&…` answers with an Anubis check (a JS proof of
work that earns a cookie, then rewrites the page). Measured on this machine, on the staging build:

| Probe | What came back |
|---|---|
| the node's first navigation | the challenge: the walk's log shows `/.within.website/x/cmd/anubis/static/js/worker/sha256-webcrypto.mjs` being fetched, and `unb do` replied `needs_hands` after **7 exchanges, 1–2 s** |
| the next request, same profile | **Access Denied**, error code `4d1dbaddfcc0f385` — the page the bank's run recorded as "set aside" |
| `unb browse` on the same page afterwards | learned a route **from the interstitial**: `fc9a231f80209a56`, "Read cgi bin on bailii.org" |
| `curl`, Chrome UA | the challenge (200), not a denial |
| `curl`, `HeadlessChrome` UA | **Access Denied**, the same code |
| the node's own walk, at a local server | `User-Agent: … Chrome/149.0.0.0 …`, `sec-ch-ua: "Google Chrome";v="149"` — the headless marker is gone before the page is asked (`fingerprint::apply_browser_identity`) |

So the request is not refused as a machine: the site hands us its check, and **we walk away while the check is still
running**. The denial is what follows an abandoned challenge, in the same profile.

## What the engine already has

The model is built; three pieces of it are hollow.

| Piece | Where | State |
|---|---|---|
| Read the answer as a wall, or as the site's page | `refusal::read(Answer) → Wall` — `Check`, `Person`, `Script`, `Rate`, `Session`, `Puzzle`, `Refused`, from the status, the body and the addresses only | built, tested, no vendor named |
| What may clear a wall, in the wall's own order | `Wall::sources()`; `Wall::Script = [Page, Sandbox, Engine]`, and a script wall "clears alone" | declared |
| The loop that runs them | `RouteClient::clear` (`client.rs:428`): each source in order, what it hands back joins the jar **as this client's pass** (`refusal::identity_of(fingerprint, egress)`), then the chain runs again | built |
| What earns a fresh pass | `Door { kind, statuses, credential, ttl, earn, at }`, `Earn::Recompute \| Browser \| BrowserOrOwner` (`graph.rs:612`) | built; `at` is "where the wall stood in the walk… the page at this address, let run, earns it as the walk's did" |
| `Source::Page` | `refresh_session`: the page fetched again over the call's own wire, cookies read from its answer | built |
| `Source::Engine` | the node opens `Door::at`, lets it run, harvests the cookies it gained, binds them to the client, and the call's wire is shaped to that engine from then on | built |
| `Source::Sandbox` | "the door's page, run in the sandbox: its script writes the pass" | **hollow**: `Page` and `Sandbox` take the same branch and call `refresh_session`, so no JS runs |
| A sandbox that can run a page's code | `sandbox::run_program_on_page(program, ctx, fingerprint, storage, page_url, html, answers, scripts)` — DOM, storage, fingerprint, `crypto.subtle`, and the page's own scripts | built; **no `Worker`**, and nothing reads a request the script would send or a cookie it would write |
| Keeping the pass | the jar with a cookie's own metadata (`Max-Age`) beside it; a call drops expired cookies the way a browser does (`docs/DOORS.md`) | built |
| Who the node registers as clearers | one: `Source::OwnerSession` (`run.rs:617`, `app/src/clearance.rs`) | built |

## Doctrine this must not break

`docs/DOORS.md` draws the line: the engine does not synthesize a vendor's token, emulate the browser a check is
scoring, or replay a sensor sample. A vendor-bound pass is earned by the real browser the node drives, **once per
TTL, not once per call**, and spent browserless until it lapses.

That settles the order of work here: the first fix is *the walk*, not a solver. A route is warm when the pass is in
the jar; the walk is what fills it. A browserless recompute of a script wall is legitimate only where the pass is the
site's own plain cookie and nothing at the edge scores the client — `Earn::Recompute`, decided by measurement (E2
below), never assumed.

`docs/BROWSERLESS.md` is the call-path plan this slots into, and it already has the right phases: Phase 1 (the sandbox
sufficient for a page's producers), Phase 4 (one visit per credential, built: a live credential opens no browser), and
Phase 2's lesson — a warm page bridge was built, measured and **reverted**, because "a page left open is not a page
that just walked". So nothing here keeps a page warm, and nothing here waits for a page it is done learning from: the
walk captures, the sandbox recomputes, the engine is the fallback.

## The shape: two passes, and the check is data

The walk is already two passes: the first walks the page and captures it, the second settles what the first left
unexplained (`learn.rs` "built from two walks of the page: the second settles what the first left unexplained",
`settle_repeats`), and every call after that replays the captured telemetry browserlessly.

A script check is data the same way, and the browser's job is only to *capture* it:

| Pass | What it does with a check |
|---|---|
| 1, the walk | runs the page once and captures the check as material: the answered document, the scripts it parsed, the check's own parameters (the blob it was given), and — if the page got that far — the redemption request it made and the cookie it set. Then it stops; it does not wait for the check to be passed. |
| 2, the route | recomputes from that material: the sandbox runs the captured script on the captured parameters, produces the redemption request, sends it, takes the cookie, and the call goes on browserless. Every later call spends the cookie until its line says it is done; then it recomputes again. |
| the fallback | material that cannot be recomputed (a vendor sensor, a challenge bound to the client) is `Earn::Browser`: one browser visit per TTL, which is what `Source::Engine` already does. |

So there is **no fixed hold**. The walk waits only while the page is *demonstrably still working* — a main-thread task
running, a timer or worker still live, a document replacement pending — and stops as soon as the material it needs is
in the capture, which for a check is the first page load, not a solved challenge. A page that has already handed over
its scripts and parameters is done being useful to the walk. `Waits.door` is a ceiling for the one case that has no
material to cut it short, never the plan.

## Inventory: what exists, and what is actually missing

Taken 2026-11-23 across this repo, `docs/`, `test-banks/` and `~/work/unbrowse-graph`. The short version: **the
browserless door pass is built at both ends and tested — it is off by default — and what let BAILII through the net is
that the walk and the call read "is this a door" in two different ways.**

| Area | What exists | Where | State |
|---|---|---|---|
| An answer read as a wall | `refusal::read → Wall {Check, Person, Script, Rate, Session, Puzzle, Refused}`, from status, body and addresses only | `crates/learn/src/refusal.rs` | built, tested, no vendor named |
| A page read as a door, in the walk | `PAGE_STATE` in the browser's own DOM vocabulary: Cloudflare's config/DOM, "just a moment", "verify you are human", a visible cross-site widget, a refused status | `crates/browser/src/session.rs:1303` | built — **vendor-shaped, and it has no case for a script-only check** |
| Waiting at a door, in the walk | `DOOR_WAIT = 25 s` (`Waits.door`), `ASKS = 4` browsers, the door page asked again after it passes | `session.rs:1296`, `:2470` | built |
| Recording a door on the route | `route.graph.door = Door::met(trace, site)`; `doors.json` per site; `Graph::door` persisted with the route | `app/src/learn.rs:3092`, `store.rs:106`, `body.rs:1170` | built |
| The door model | `Door { kind, statuses, credential, ttl, earn, at }`, `Earn { Recompute, Browser, BrowserOrOwner }` | `crates/learn/src/graph.rs:598,612` | built |
| The browserless door pass | the door's page and scripts run in the sandbox, its requests made through the call's own held transport (origins, cookies, HttpOnly, session replacement all checked), the pass it earns joins the jar | `client.rs:929 compute_the_door`, `sandbox::door_pass` | **built and tested, `UNBROWSE_DOOR_PASS=1` only, off by default** |
| The door pass during a walk | the same pass at mint time | `crates/learn/src/mint.rs:1650,1696` | built, same flag |
| What may clear a wall | `Wall::sources()` in the wall's own order; `Cleared { cookies, ttl, bound_to }`; `identity_of(fingerprint, egress)` | `refusal.rs`, `client.rs:428 clear()` | built |
| Clearing sources, wired | `Page` (re-fetch), `Sandbox` (the pass), `Engine` (one browser visit, `HealGuard`, `sight_the_root`), `OwnerSession` (the owner's own browser session) | `client.rs::clear`, `app/src/clearance.rs`, `run.rs:617` | built |
| A solver | `app/src/solver.rs`: a configured pointer (createTask/getTaskResult), no vendor named | `app/src/solver.rs` | **built, and never registered** (`with_clearer(Source::Solver, …)` exists in tests only) |
| The sandbox itself | DOM, real cookie jar with read/write, `Worker` (`UbWorker`), `crypto.subtle`, canvas, script cache, a settle window, a confined Node child with no net and no `require` | `crates/learn/src/sandbox.rs` (`:959`, `:1103`, `:720`) | built; its output already carries the requests the page made and the cookies it wrote |
| An agent's eyes and hands on a check | `unbrowse_challenge` (page as a picture, click/drag/hold/type/wait/done), the node's own dialog for the owner | `crates/learn/src/challenge.rs`, `app/src/challenge.rs`, the skill | built |
| Doctrine | `docs/DOORS.md` (classes, what earns a fresh credential, what is never done), `docs/BROWSERLESS.md` (phases 1–5; phase 2's warm page bridge *reverted*), `docs/SIGNED-ROUTE-REPLAY.md` (producers) | `docs/` | built — **no class for a check that serves itself** |
| The graph | protocol and economics nodes; no node about a site's check | `~/work/unbrowse-graph/nodes/` | absent, and this repo's engine docs are where it is decided |
| Tests | wall/door/clearance tests in `client.rs` (`a_door_that_is_a_page_of_script_is_computed_not_visited`, `a_doors_pass_is_held_to_the_calls_rules`, `a_live_credential_costs_no_browser`, `a_wall_or_a_failed_browser_is_not_a_walk_away`), mint's door tests, the browser's waits tests, `refusal`'s eight | `crates/`, `app/` | built |
| The banks | `test-banks/gate/bank.json` holds `u6:court-researcher-4` (BAILII); `popular-sites/run_bank.py::door_in` has its own door reader | `test-banks/` | built |

### One question, five readers

"Is this answer the site, or the site's check?" is asked in five places, and they do not answer alike:

1. `refusal::read` (`learn`, the call) — properties of the answer: a page that only waits on its own code is
   `Wall::Script`.
2. `session.rs::PAGE_STATE` (`browser`, the walk) — the live DOM, in Cloudflare's names and a few English phrases.
3. `mint::asks_a_person` — whether a door's page is one a person must answer (so its scripts are never run).
4. `page::a_door` — the body-based reader `refusal` and `learn` both use.
5. `run_bank.py::door_in` — the bank's own classifier, for its report.

**The walk's reader (2) has no case for a check that shows no widget, no vendor config and no "verify you are human"
words — exactly a self-served proof of work.** So the walk settled on Anubis's page, judged it as the site, learned a
route from it, and closed the browser mid-check. The call-side reader (1) would have called the same page a
`Wall::Script`.

### What is actually missing

- **G1. The walk reads doors in its own, narrower vocabulary.** It should answer with the same reader the call does
  (`refusal::read` over the answer it got), or `PAGE_STATE` must gain the property "a page whose own code is still
  working on it and then replaces itself". This is the whole BAILII failure.
- **G2. The door pass has not been measured since it was turned off.** `#542` (13 Nov) turned it on for the bank on 29
  sites and found "no log shows the door pass being reached"; it has been off since. Modern checks (self-hosted PoW,
  Cloudflare's newer interstitials) are exactly what it was built for, and nobody has run it on them.
- **G3. A door the walk does not see becomes a route.** Seen: `fc9a231f80209a56`, "Read cgi bin on bailii.org", learned
  from the check page. With G1 fixed, the door stretch is the door's and is not learned from.
- **G4. `Source::Solver` is implemented and never registered**, so a wall the owner's solver could clear is an honest
  failure today. *2026-11-25:* the agent's half is built: `unbrowse_challenge` `solve` finds the check in the page or a
  frame of it, gets a token from the node's solver (the owner's, or Unbrowse's gateway for a signed-in owner) and hands
  it over in the frame's main world. *Later the same day:* the call-time half is registered too. A solve keeps the
  request the page then sent with the token (`app/src/redeem.rs`: each value read as the token, a value of the check's
  address, or a short constant; a long value the page computed is left out). A call whose answer names its check
  (`refusal::read` → `Wall::Check`, now also for a page that is only a script sending the reader on, `page::sent_on`)
  fails as a door, and `Source::Solver` reads the check page over the call's transport, gets a token and sends that
  request; what the site sets is the pass. The solver now comes before the engine for a check that asks a person.
- **G5. `docs/DOORS.md` has no class for a check that serves itself.** Its `Unknown` row says "credential none found,
  earn recompute, a browserless re-fetch, then report" — which is precisely wrong for a proof of work (a re-fetch
  returns a new challenge). The class and its earner need to be written down.
- **G6. No agent-visible door state.** `Door` is not in `apischema.rs` or `agent-api.json`, so an agent reads about a
  door only in `notes`. It cannot say "this site has a check, it is `Wall::Script`, the pass lives until then".
- **G7. No test of a walk meeting a script-only check.** The nearest test (`learn.rs` "One moment") exercises a call
  answered with a check's address, not a walk that settles on one. A local fixture cannot be browsed
  (`proxy::browser_may_reach` refuses this machine's own addresses), so this has to be a decision-level test over two
  saved exchanges, or a public fixture host the bank owns.
- **G8. Nothing measures where "asks a person" ends and "asks its own code" begins.** `asks_a_person` correctly stops
  the pass for a widget door; a check whose page says "verify you are human" *and* computes its own pass could be read
  either way, and no test says which it is.

### What this changes in the fix

Steps 1 and 2 stand (the walk captures and stops; the check becomes a producer on the route), but step 4 does not:
**`Source::Sandbox` is not to be built — it is to be turned on and measured**, with G1 as the thing that finally gives
it a door to run. The list becomes: G1 → G3 → G2 (measure) → G5/G6 (doctrine and agent surface) → G4, G7, G8.

## The atoms

| # | Atom | Primitive | State |
|---|---|---|---|
| 1 | The answer is a door, and which kind | `refusal::read` | have |
| 2 | Where it stood, what it issues, what earns it | `Door { at, credential, ttl, earn }` from `Trace::door`/`gates`, and the check's material: the answered document, its scripts, its parameters | have the model; **no door, and no material, is recorded** when the walk abandons the page |
| 3 | The code that earns it, and what it is given | the walk's captured scripts, `read_the_pages_code`; the check's parameters in the document | have the capture; the parameters are not picked out as the recompute's inputs |
| 4 | Run that code | `sandbox::run_program_on_page` | partly: no `Worker`; the script's `fetch`/`document.cookie` writes are not read |
| 5 | Turn what it did into the pass, as the browser did | the redemption request the walk's browser made, kept as the producer's expected output | **missing**: nothing reads the request the script would send, and nothing compares the second pass with the first |
| 6 | Keep the pass, bound to the client and with its life | `Cleared { cookies, ttl, bound_to }`, `identity_of`, jar metadata | have |
| 7 | Send it on the route, now and later | route `session` links, the jar | have |
| 8 | Re-earn it when it lapses | the same `clear()` loop, `Earn::Recompute` or `Browser` | have the shape |
| 9 | Fall back honestly, and say so | `Source::Engine`, `browser: true` in `notes` | have |
| 10 | Never learn a route from the door | the door stretch left out of learning | **missing**: BAILII's interstitial became a route |

## The fix, in order

1. **The walk captures the check, and holds only while the page is still working.** The walked document is read as a
   wall (`refusal::read`); when it is `Wall::Script`, the walk does not judge it settled, and holds **only while the
   page is demonstrably still working** — a main-thread task, a live timer or worker, a pending document replacement —
   and **stops as soon as the material the recompute needs is in the capture** (the document, its scripts, the check's
   parameters, and the redemption request if it has been made). `Waits.door` is the ceiling for the case with no
   material to cut it short. The exchanges before the replacement are the door stretch: kept (the cookie is the pass),
   never learned from.
2. **The check becomes a producer on the route.** What the walk captured is kept as the door's material: the script,
   the parameters, and the shape of the redemption request (its address and which of its values the script computes).
   The route names it as a value with a producer, the way a page-computed value is named today — so provenance can say
   "the route lost this", and `Source::Sandbox` has something to run.
3. **`Earn` from what the material allows**, not from what the page looks like: recomputable from the capture →
   `Recompute` (the sandbox earns it, browserless, every time it lapses); anything scored at the edge → `Browser` (the
   engine, once per TTL). E2 is what measures which.
4. **`Source::Sandbox` becomes real for `Recompute`**: the captured script runs on the captured parameters, its
   redemption request is read, sent, and the cookie it sets is the pass. The two gaps it needs: a reader of the request
   the script would send, and `Worker`. The worker is less of a gap than it looks: a page's worker script is its own
   exchange in the capture (Anubis's `…/worker/sha256-webcrypto.mjs` was one), so a `Worker` can be run as that script
   with `self.onmessage` wired to `postMessage`, no thread needed.
5. **`Source::Engine` stays the honest backstop** — one browser visit per TTL, `notes` saying so.

## Tests that would hold it

- **The hold is material-driven, not time-driven**: an answer that reads as `Wall::Script` is not judged settled; the
  walk stops holding **as soon as the material it needs is in the capture** (document, scripts, the check's
  parameters), and does not spend the ceiling on a page that has already handed them over. A page that hands over
  nothing holds to `Waits.door` and is then reported as a door, not as the site. Same shape as
  `a_walk_waits_while_the_page_is_still_asking` (`session.rs:196`).
- **The second pass reproduces the first's request**: given the captured check, the sandbox's recompute produces the
  redemption request the walk's browser made — same address, same values. That is the whole claim of the two-pass
  shape, and it fails loudly when the capture is incomplete.
- **The door earns nothing to learn from**: with the door captured and passed, the route's exchanges are the ones
  after the replacement only, and the pass cookie is in the jar.
- **The sandbox**: a script that does its work in a `Worker` runs to the same answer as one that does not.
- **The bank**: `u6:court-researcher-4` reads right, and the verdict is a door passed rather than `set_aside`.

## What the experiment established (2026-11-23, this machine)

Three things, two of them changing the plan.

**1. The browser's address rule blocks a local fixture, by design.** `proxy::browser_may_reach` refuses any address that
is this machine — loopback, link-local, and every address one of the machine's own interfaces holds — "whatever the
owner's setting". A local fixture can therefore never be browsed by the node (a good guard, an SSRF rule with a
property, not a host list), and a public tunnel is blocked on this network. So the challenge behaviour is measured on
real pages, and the *tests* for it have to be at the decision level (a fake answer in, a wait or a move out), the way
`browse_move` and `Open::holds` are already tested, not end-to-end against a local server.

**2. The walk's patience is keyed on the network, not on the page.** `Waits { least_settle: 3 s, door: 25 s,
asking: 25 s, scripts: 8 s, in_flight: 5 s }` (`session.rs:1116`), and `Open::holds` holds a walk only while a request
**carries what the page was asked** (`asked_of(PAGE)`), an answer is arriving, or a script is still to arrive.

A check that computes for seconds is none of those: a proof of work in the page is CPU and a timer, nothing on the
wire. So the page is judged settled while its own script is still working, and the judgement is
`learn.loading: "loading the page sends no call that answers the goal: it needs clicks or typing"` — the BAILII
`needs_hands` seen above, after 7 exchanges.

**3. The door is already a wait the walk has; nothing connects it to a loaded page.** `refusal::read` names a page
that only waits on its own code as `Wall::Script`, and `Waits.door` is 25 s — but `door` is consulted for a *refused
status*, not for a page that arrived whole and then stalled in its own script. That is the whole of the bug, and the
fix is to read the walked document as a wall and, when it is a `Script` one, hold the walk at the door.

So the order of work changes: **the walk's door-wait is the fix, and the sandbox recompute is not needed for BAILII at
all** — the pass is a plain cookie, so once the walk rides the check out, the jar holds it and the route is warm with
it until it lapses, and the browser (once per TTL) re-earns it after that.

## What the experiment did *not* settle

- Whether a pass Anubis issues is device-bound (`Earn::Recompute` or `Earn::Browser`). BAILII denied this machine's
  address after the earlier abandoned challenges, so a clean pass could not be earned here (E2 is open).
- Whether the check replaces the document by navigating the frame (`location.replace`, as the fixture does) or only by
  rewriting it in place. The wait has to cover both: a second `Page.frameNavigated`, or a document that changed under
  the same address.

## Experiments

- **E1 — where the walk gives up.** Run: BAILII challenged the node, and the walk answered `needs_hands` after 7
  exchanges and about 1–2 s; the next request from the same profile was denied. A held page (browse) fared no better:
  Anubis denied it at once, the machine's address having been denied repeatedly while these runs were made. **Open:**
  the same page from an address that has not been denied, left alone for 30 s.
- **E1b — a local fixture.** Attempted; blocked by `proxy::browser_may_reach` (this machine's own addresses are never
  browsed, whatever the setting) and by the network blocking a public tunnel. The fixture lives on as the shape of the
  decision-level test above.
- **E2 — bound or not.** Open: it needs the pass the walk has not yet earned. This decides `Earn::Recompute` versus
  `Earn::Browser`, and so whether `Source::Sandbox` is honest for this class at all.
- **E3 — the record.** Open: with the walk holding at the door, does a route carry a `Door` with `at` and a
  credential, and does the route call answer from the jar?

## Not in scope

Synthesizing a vendor's token, a per-site code path, a Rust proof-of-work solver (that is re-implementing each
vendor's algorithm forever), and treating `set_aside` as the site's fault when the check was only abandoned.
