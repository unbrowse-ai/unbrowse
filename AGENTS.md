# AGENTS.md — the strategy and the pattern

How this project turns a site someone browses into calls an agent can make
without a browser. Written for agents working in this repository.

**Design source of truth: `unbrowse-ai/unbrowse-graph`** (private, `~/work/unbrowse-graph`). Read its `INDEX.md`
before changing the contracts, the node or the money docs. Code comments, PRs and docs cite node ids
(`pledge.release`, `stake.on-route`). A behaviour with no node is added there first, or deleted. Where this repo
and the graph disagree, the graph wins.

## The shape of the thing

One engine, three consumers:

```
agent-browser-core            the engine, as a library
├── cdp/                      transport, Chrome launch, discovery, protocol types
├── capture                   the passive JSON-lines log of a walk
├── session                   MintedSession and mint(): the walk as one call
├── connection, paths, CA     timeouts, browser cache, TLS roots

cli/                          thin front end over the engine
unbrowse-learn/ (the node)    links the engine; routes, replay, solver
```

The node never drives a daemon over a socket. That boundary was the bug
family: stale daemons, environment captured at launch, sessions that survive
their own relaunch, frame targets that miss their setup. Linking the engine
removes the class rather than patching instances.

## The pipeline

```
mint   -> walk   -> trace   -> route        -> call
(browser          (requests   (the graph     (plain HTTP,
 once, in         + responses  rooted at      Chrome-shaped
 process)         + bodies)    the site)      transport)
```

1. **mint** — `agent_browser_core::session::mint()` launches Chrome, attaches,
   navigates, settles, and returns a `MintedSession` (cookies plus widget
   tokens). One call, no CLI, no daemon. A persistent profile per site makes
   later mints cheaper.
2. **walk** — the same call records every request and response (status,
   headers, body) into the capture log. Subscribing before navigation matters:
   the walk's first exchange is the page itself.
3. **trace** — `walk_har()` pairs those lines into HAR 1.2; the node reads it
   as a `Trace`.
4. **route** — `build()` keeps the site's own calls, dropping front-door
   probes and pages (their values classify as minted, supplied by the jar).
5. **call** — `RouteClient` replays the route over a Chrome-shaped transport,
   drawing session values from the jar.

## The meta pattern

A route the learner cannot work out generically is still a general problem
before it is a site's: generation may **propose** a shape from the walk (which
step, which value is the caller's, which page to carry, which producer), the
engine **applies** it to the same generic graph, and the **site verifies** it by
replay. Generation at learn time only, never in the call path and never as
per-site code; a wall is a problem to solve, not a boundary. The full rule is in `CLAUDE.md`.

## The pattern, learned the hard way

**The door checks three things, in order of how often they matter:**

| Layer | What the site reads | What passes it |
|---|---|---|
| request shape | headers: `accept`, `accept-language`, `sec-fetch-*`, referer | send what a navigation sends, not what a script sends |
| session | cookies: clearance, vendor tokens | the mint's jar, harvested from the browser's own jar |
| handshake | TLS ClientHello (JA4), HTTP/2 settings, header casing | a browser-shaped transport, measured against the browser |

The first is the cheapest and the one that bites most often: the same jar and
the same transport draw an interstitial without a browser-shaped `accept`
header, and pass with it.

**Gates are read from the site's own traffic, never named.** The capture
records what Chrome measured for every request: its resource type and its
frame. The door is the stretch of the walk from the first page the main frame
was refused (403, 429, 503) or served by another site, to the site's own page
it was let through to (`Trace::door`); its hosts are the gates
(`Trace::gates`). The route's goal is the site's own page, never a frame's.
A cookie issued by a step plain HTTP cannot make (a value with no source the
walk shows, or a body it cannot read) is the jar's, wherever that step sits.
A call that sends the walked page's own address back is reporting the page,
never answering it.

**Measure, do not infer.** Every claim in this repository came from an
instrument, and each has a cheap verifier:

- the client's fingerprint, read from the browser itself (load a TLS echo page
  in the minting browser and compare JA4 strings character for character);
- the door's identity, from the walk's own hosts and the challenge page's
  parameters;
- the route's correctness, by replaying it and reading the status.

**The capture is the asset.** A walk is worth more than any heuristic: it is
the site's own account of what it does, in order, with the values it issued.
Learn from it; do not reconstruct it.

## One question, one reader

Most of what breaks on a new site is not a missing capability. The primitive
exists and one path does not use it: the sample held the browser's user agent
and the transport was never handed it; a reader of callback-wrapped JSON
existed and the failure check parsed only plain JSON; a memo existed and the
candidate list never started it. Each such path then fell back to something
that still answered `ok: true` (the browser, the page's frame, a second walk),
so nothing showed until someone timed a call or read an answer.

- **A question about a walk or a call has one reader, and every path asks
  it.** Learning, calling, healing, signing and judging must read the same
  thing the same way. The readers today:

  | Question | Reader |
  |---|---|
  | What JSON did this call answer with? | `Exchange::own_json` (the body, inside a callback, behind a guard, a stream's events); `json_body_like` adds a page's embedded state; `trace::body_json` where only the text is at hand |
  | Did the site say the request failed? | `answer::not_an_answer`, and `replayed_not_an_answer` at call time |
  | What does this page's address ask for? | `trace::asked_pairs` (its query, and a fragment written as one) |
  | Did a value from the address's fragment act as a credential? | `trace::fragment_credential` (sent where a credential goes, or sent and never said back) |
  | Which browser does this request say it is? | `ChromeFetch::as_sampled` (the walk's client hints and user agent together); the transport itself brings the two to agree on every request (`http::agreeing_user_agent`) |
  | Is this the same call on another walk? | `graph::the_same_call_there` (`align`): each is the other's best match, and a path piece that differs is one the walk can source; a step against a request is `same_call` in the node |
  | Where did this value come from? | `graph::unsourced_among`, under a `provenance::Memo` whenever more than one value is asked |
  | Is this step a value of the caller's? | `Action::gives_a_value` (text typed, an option selected, a radio or box chosen by a click) |
  | Is this body data to keep whole? | `session::is_data` in the browser core, by what the body is and not only its type |

  Before parsing a body, reading a query or building a transport by hand, look
  for the reader. A second copy will handle fewer cases than the first, and the
  site that needs the missing case fails silently in that one path.
  `crates/learn/tests/one_reader.rs` reads the source for the copies it can
  recognise (a response body parsed by hand, a wrapping read outside
  `trace.rs`, a Chrome-shaped transport built in a new place) and fails with
  the reader's name.
- **A new case goes into the reader, not beside it.** When a site shows a
  wrapping, an address shape or a header the reader does not know, teach the
  reader; every path gains it at once. `an_answer_reads_the_same_at_learn_time_and_at_call_time_however_it_is_wrapped`
  holds learn time and call time to one reading: add the new case there.
- **A fallback says so.** A path that gives up on the cheap way and takes a
  dearer one records why (`RouteClient::fell_back`), and the reply carries it
  in `notes`. `browser: true` on a warm call is a defect to explain, not a
  detail: the bank's `browserless` finding fails a site whose warm calls
  needed the browser, whatever they answered.
- **A check that did not run is not a pass.** A trial that was skipped, a
  sandbox with no runtime, a walk that waited on another: each leaves a line
  saying which and why. `null` is a finding.
- **Test the fixture the site sent, not the one you imagined.** A failure
  check passed its test and missed the real answer, which carried one more
  field than the fixture. Build the regression from the capture
  (`examples/page_probe`, `fields_probe`, `get_probe` read one for you).
- **Search with the real tool.** A shell's `grep` may be an alias that skips
  ignored paths, and a worktree under `.agent-grid/` is one: a limit that
  "appears nowhere in the repo" was a constant the alias never read. Use
  `git grep` from the checkout, or `/usr/bin/grep`.

## The network

No node holds the whole map. A node keeps the routes it holds and uses, and
finds the rest through a Kademlia table keyed by site (`crates/net`, spec §53):

- **The key is the site.** Routes are announced and found under
  `/unbrowse/site/<registrable domain>`. Agents name a page, so a lookup is an
  exact key; ranking by meaning runs on the node over one site's listings.
- **Standing is read from the registry, never from the peer.** A peer counts
  when the registry lists its peer ID under the identity it names and it sits
  where that identity's node must. One that doesn't count may still ask; it
  never enters a routing table and its provider records are dropped.
- **Positions are fixed, not chosen.** A node's position starts with bits drawn
  from its identity and the block that registered it, so grinding keys can't
  put a node next to one site's key.
- **One owner is one source.** Several nodes of one identity answering a lookup
  count once, so one owner can't supply both copies being compared.
- **A listing is checked before an agent sees it.** It must be for the site
  asked about, and the chain must show it live and as that contributor's.

## Operating rules

- **An agent primitive is one entry.** Add or change one in `PRIMITIVES` (`unbrowse-node/app/src/api.rs`), never as
  a hand-made `/v1` route or MCP tool: both are made from that list. Then rewrite `unbrowse-node/agent-api.json`
  (`UNBROWSE_WRITE_AGENT_API=1 cargo test -p unbrowse-node-app the_agent_api_manifest_is_current`) and give `unb` and
  both SDKs what it adds; their tests read that file and fail until they have it.
- **An owner command is one entry, too.** Add or change one in `OWNER_COMMANDS` (`unbrowse-node/app/src/commands.rs`),
  never as an arm of its own: `owner()` runs it from there and the manifest carries it. Its entry says what it takes
  and what it answers (named types in `apischema.rs`). Then rewrite `agent-api.json` the same way.
- **Generated files are never edited by hand.** `unbrowse-sdk/codegen/generate.py` writes the SDKs' typed layers
  (`typescript/src/generated.ts`, `python/src/unbrowse/_generated.py`) from `agent-api.json`: run it after rewriting the manifest (CI runs `--check`). On staging, the SDK polish workflow drafts the
  hand-written follow-ups (friendlier methods, READMEs, the skill) as a pull request.

- **One identity end to end.** The browser mints under the same user agent the
  browserless client presents, so a clearance is bound to a name the stack
  owns and can honestly carry.
- **Session values are optional at call time.** A cookie the store lacks is
  not sent, the way a browser omits what it does not hold; if the site needs
  it, the call fails and the route is re-minted.
- **Recorded statuses are expected statuses.** A step learned through a guest
  probe that answered 401 is expected to answer 401 again; only an unexpected
  status fails a call.
- **Order by dependency, then by state.** Value dependencies first; among
  steps that are ready, session-establishing steps (logins, registrations)
  go before the calls whose answers assume that state.
- **Pages are the browser's job; calls are the node's.** A route is the site's
  API surface. The goal page is kept only when the goal is a page.

## Testing against sites: one at a time, driven by the agent

Lewis, 13 November 2026: test "one by one not all at one shot", and "you must always drive it as claude not with some
weird deterministic code".

- **One site at a time.** Take one site, learn it, ask it a second and a third value, read what came back, and say
  what you found before the next. No batch over a list of sites, no bank run started to see what falls out, no two
  nodes working through sites side by side.
- **The agent is the caller.** Call the node's own tools (`unbrowse_do`, `unbrowse_call`, `unbrowse_walk`,
  `unbrowse_browse`, `unbrowse_observe`, `unbrowse_challenge`, `unbrowse_inspect`) one call at a time, as a calling
  agent would, and decide the next call from the last answer. A script that loops over sites and scores answers by
  counting words is the bank's reader by another name: it misreads right answers and cannot follow up.
- **Judge by reading.** Open the data: the names, the prices, the picture. "ok: true" and a byte count are not a
  verdict. Say what you read.
- **Read the route against the engine before naming a cause.** After a learn, run `UB_DIR=<scratch node>
  scripts/xray/xray.sh`: the live x-ray of that node (README beside it). Each hole is strung to where its value comes
  from, with the findings on it; a click on a hole or a finding lists the engine's functions that write its kind and
  branch on it, read from your checkout as it stands, and `WHY`'s line for it. The pick panel shows each walk's
  candidates and why each was dropped, including a learn that kept no route. Read those functions before saying why a
  site failed. Without a browser: `xray.sh state` (the same state as JSON) or `xray.sh --text`. In a handback, paste
  `xray.sh diff <home before> <home after>`, not prose; it exits 1 on a new break. A fresh learn's x-ray must not show
  the finding. Its pages and snapshots name sites and stay outside the repository.
- **A helper sends one call.** A small script that sends one tool call, or prints one route or one stretch of the
  node's log, is fine. One that decides what to ask next, or whether an answer is right, is not.
- **Comparing two builds** is the same thing twice: the same site, by hand, on each build, one after the other. A
  difference is checked again by hand before it is called a regression: a site's door moves between two asks.
- **A wait is for one thing.** Waiting for one learn's background check is fine. Parking a turn on a run over many
  sites is not.
- **A route is never fixed by hand.** Lewis, 13 November 2026: "fixing the route by hand or fixing the general engine
  by hand to solve the route??", and of the second: "keep that as your deterministic rule". When a site fails, change
  the engine so every learn does what was missing, naming no site. Never edit a route, and never use a tool that
  changes one route on one node (`unbrowse_judge` with links or fields) to make a site pass: those are for a caller
  to say what it knows. The proof is a fresh learn on a fresh node where the agent types only the ask and the calls
  that read the result, and then the same build on a site that did not expose the gap. Driving by hand finds a gap
  and judges a result; it never closes one.

## Branching rules (mandatory)

- Never push directly to main, staging, or release/*. Always open a PR.
- New work: branch from staging, PR into staging.
- Never branch from main. Never merge main into anything.
- release/* branches are feature-locked: only `fix:` PRs.
- A fix merged into release/X.Y must be cherry-picked to staging in its own PR, titled "fix: ... (from release/X.Y)".
- Only a release/* branch may be PR'd into main. Do not open PRs into main unless explicitly asked to ship a release.

CONTRIBUTING.md ("Branches and releases") says how each branch releases.

## Review: when to ping steefpls

steefpls, 29 October 2026: "If its been reviewed and doesnt need my decision, merge. If its product direction, ping
me." Lewis, 31 October 2026: ping him only for important decisions, not every open question, and not over and over.
The papers repo's `AGENTS.md` says the same.

- **Ping him only for an important decision.** Important means it sets the direction, it's hard to undo, and Lewis
  hasn't decided it: what Unbrowse builds or sells and for whom, the launch gates, customer prices, the token's supply
  and allocation, the fee split, route coins and the burn, and the constitution.
- **Everything else is Lewis's, even when it touches money.** That covers building a decision Lewis already made (an
  adopted spec section, or his word in a session) into the node, the contracts or the SDKs; a parameter, cap or rule
  detail inside a direction already set (a bounty's size, a key's cap, who may call a setter); how to build a
  rule; a design or security trade-off; and a gap you found. Ask Lewis in the session.
- **If you're unsure whether it's important, it isn't.** Ask Lewis; he brings steefpls in when it needs him.
- **One ping per PR.** @-mention steefpls once, in the PR's description, with every question he needs to answer listed
  there, and request his review. Never @-mention him in a follow-up comment, a rebase note, a status update or another
  PR about the same decision: edit the description instead. Write his name without the `@` anywhere else.

## Anti-patterns

- Driving a daemon when a library call will do.
- Reading a fingerprint instead of measuring it.
- Treating a gate as noise to skip rather than a step to satisfy.
- Replaying one bare request at a page that expects a sequence.
- Hard-coding a site's shape into the engine: site knowledge belongs in the
  walk, the jar and the route, never in the transport.
- Answering a question the engine already has a reader for with a second,
  smaller copy of it (see "One question, one reader").
- Letting a fallback answer without saying it was one.
- Trusting what a peer says about itself, or a listing because a peer sent it.
- Testing sites in a batch, or with a script that scores answers, instead of driving one site at a time and
  reading what it answers.
