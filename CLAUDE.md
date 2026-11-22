# unbrowse-core — the strategy and the pattern

How this project turns a site someone browses into calls an agent can make
without a browser. Written for agents working in this repository.

Root `CLAUDE.md` and `AGENTS.md` are one file, byte for byte, so every agent reads the same rules: edit `CLAUDE.md`,
copy it over `AGENTS.md`, and `cmp CLAUDE.md AGENTS.md` (CI runs it, and `.github/scripts/test/test_agent_guide.py`).

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

## Fixes are general, never hard-coded

The one rule every change follows. A site that breaks is a case of a class. Fix the class.

- **No site, vendor or host names in the engine, the learner or the transport.**
  No `if host == "sistic.com.sg"`, no list of ad or analytics hosts to skip,
  no path that only one site uses.
- **State the rule as a property of the walk.** Say what the call does, read
  from its own traffic: "a call that sends the walked page's own address is
  reporting the page, not answering it". Not "googleadservices is noise".
- **Site names belong in tests, as fixtures.** A regression test may be built
  from the walk that exposed the bug, named for the property it checks
  (`a_call_reporting_the_page_never_wins`), not for the site.
- **No lists of names to grow.** The old `NOISE` and `GATEKEEPER_HOSTS` lists
  were replaced by properties of the walk (`Trace::door`, a call reporting the
  page, a cookie only a browser can earn). When something new slips through,
  find the property it stands for and test that, never add its name.
- **Before finishing, check the fix against a site that isn't the one in
  front of you.** If it only works because of that site's names, it isn't the
  fix yet.

## The meta pattern: propose from the walk, let the site verify

The rule above is how a *fix* stays general. The same shape covers a route the
learner cannot work out generically, and it is the pattern to reach for before
writing any special case:

- **The walk is the asset.** A route is data read from it: the call, the
  caller's values, the page it carries, the producer it needs. The engine learns
  by reading the capture, not by reconstructing a site.
- **Generation proposes; the engine applies; the site verifies.** A model or a
  search may propose a *shape* from the walk — which step is the answer, which
  value is the caller's, which page to carry, which producer to run. It never
  ships as per-site code. The proposal is applied to the same generic graph and
  is kept only if replay passes: a second value changes the answer, a nonsense
  value finds nothing, a recheck matches, no write is sent twice.
- **Generative at learn/repair time only.** The call path is deterministic,
  warm HTTP. A model in the call path loses the route.
- **Generated code stays in the sandbox.** A program that reproduces a
  page-computed value runs only in the restricted sandbox, is the route's
  private data, and is never shared as code (shared routes carry no code).
- **A wall is a problem, not a boundary.** A captcha, Turnstile or DataDome is a
  step to satisfy like any other: meet it with the browser, the transport or a
  solver, keep the fix general, and say so plainly. Unbrowse is open about
  bypassing anti-bot; what it never ships is a fake success. A wall that still
  holds is an honest failure, and the site's answer remains the judge.
- **A property, not a vendor.** When a new site exposes a gap, name the property
  of the walk it stands for and fix that: “a value the page's address carries
  into its call is an input”, “a module script runs as a module”, “a page the
  route carries is not a live door”. The site that exposed it stays in a test
  fixture.

Worked examples: Substack's `/search/<term>` became an input because the
address handed the value to the call, not because Substack is special; Etsy's
vendor chunk ran as a module because the document said `type="module"`, not
because Etsy is special. The browser remains the fallback for a page that will
not boot, and the site's answer remains the judge.

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
- **The release task gate is the one exception, and only for the release.** It is not a way to investigate a site; see
  "Tests, requirements and the merge scorecard" below for how it keeps this section's rules (the agent calls and
  judges; a changed verdict is re-read by hand, one site at a time). Amended 17 November 2026 (UNB-208), merged by
  Lewis in PR #606.
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

## Push, then watch the run

Lewis, 19 November 2026 (UNB-235, "full"): CI runs the node end to end on every push, an agent and a model-free MCP
check included, so push early and read what it found. This replaces the 18 November rules "No pull request before the
change has run in the real application, on your machine" and "CI is a gate, never the first run". Lewis, 22 November
2026 (hub programme 5c79a6, UNB-235): the pushing session watches the run, fixes failures in the same session, and
testing moves off the host machine.

- **Testing runs in CI, not on your machine.** Before a push, run only the fast unit check of the part you changed:
  its own unit tests, with a name filter where one fits (`cargo test -p <crate> <filter>`, one script's
  `python3 -I .github/scripts/test/test_<name>.py`, one SDK's `npm test`), in a few minutes. Never run the full
  suites on the host: not `cargo test --workspace`, workspace clippy, the ignored end-to-end tests, a release build
  to make sure, the QA run, the bank or the task gate, coverage. CI runs every one of them on the push; read them
  there. Driving one site on a scratch node to find out why it fails ("Testing against sites") is an investigation,
  not a suite, and stays on the machine.
- **After every push, watch every run that push started, to its end, in the same session.** Not only the one you
  expect: the push's own runs, its pull request's (`PR check (no credential)`, `PR agent checks`, CI, Coverage, the
  promotion gate, Claude review) and any run another workflow starts from them. List them by the pushed commit and
  `gh run watch` each; `.github/scripts/watch_runs.py` does exactly that, picks up runs that start later, and ends on
  `RUNS_GREEN`, `RUNS_RED` (each red run's failed jobs and steps, the end of its failed log, its artifacts
  downloaded) or `RUNS_NONE`.

  ```sh
  git push -u origin <branch>
  python3 .github/scripts/watch_runs.py                 # every run on HEAD, to the end: RUNS_GREEN / RUNS_RED / RUNS_NONE
  gh run list --commit "$(git rev-parse HEAD)"          # the same runs by hand, with their ids
  gh run watch <run-id> --exit-status                   # wait on one; exits non-zero if it failed
  gh run view <run-id> --log-failed                     # the failed steps' log, and only those
  gh run view <run-id> --json jobs --jq '.jobs[] | select(.conclusion=="failure") | .name'
  gh run download <run-id> -D /tmp/run-<run-id>         # artifacts: qa-mcp-check (step report and a picture per
                                                        # step), qa-screenshots, qa-report, coverage files
  gh run rerun <run-id> --failed                        # once, for a failure that is not this change's
  gh workflow run qa.yml --ref <branch>                 # Agent QA on a branch, by hand (pushes to staging and
                                                        # main run it on their own)
  ```

  A pull request into staging, once it is ready for review, also runs the agent QA and the gate bank's slice on its
  merge commit (`PR agent checks`, pr-agent-checks.yml, UNB-248; Lewis, 20 November 2026): open it ready, or mark it
  ready, and watch that run too. A draft or a fork's pull request turns that check red with the reason and never gets
  the Claude credential. The full bank and the live-site check stay on staging and nightly. Every pull request into
  staging or main, a draft too, also runs `PR check (no credential)` (pr-check.yml, UNB-235): the MCP check (no model)
  and journey coverage, with no secret at all, so a draft shows most breakage in minutes; it prints `PR_CHECK_OK`.
  Which checks run on a pull request and which only after a push is written out in qa.yml's header.
- **A red run is fixed in the same session, from the runner's own logs.** Read its `--log-failed` and its artifacts
  (the MCP check's step report and pictures, the QA screenshots and report), say what broke and why, fix it, push, and
  watch the new runs. Repeat until every run on the last pushed commit is green. Diagnose from what the runner
  recorded; do not re-run the suite on your machine to find out. A failure that is not this change's (red on staging
  too, a runner that died) is rerun once; if it stays red, name the staging run that shows it.
- **Stop only on a cause you cannot fix, and say exactly which.** A missing secret, a refused credential, a runner
  that will not start, a failure staging has that this change does not own, a decision only Lewis can make. Name the
  failing workflow, job and step, the run id and the reason, quote the log line, and mark the ticket Blocked with that
  line in its one comment. The UNB board has no Blocked state: the ticket stays In Progress and the comment starts
  `Blocked:`. Then stop.
- **Never report done on a red or unwatched run.** Done names every run on the last pushed commit, with its id and
  its conclusion, all green (`RUNS_GREEN`). "Pushed", "CI started", "green on my machine" and a run nobody watched to
  its end are not done. A cancelled run is not green: when a newer push cancelled it, the newer commit's runs are the
  ones to watch.
- **Use it as a person would before you call it done.** The QA run drives the built node through its MCP tools and
  window and pictures each step; read the pictures for the path your change touches. "It compiles", a clean clippy
  and passing unit tests are necessary and say nothing about use.
- **Baseline, then treatment.** State the claim so it can fail: what, measured how, by how much ("a `fill` replies in
  under 500 ms; it took 3 s"). Take both sides from CI where a job measures it (staging's last run before, your run
  after); on your machine only when no job does. Compare the raw output: timings, replies, the node's log.
- **The pull request carries the evidence:** the commands run, the run ids, the before and after, and one verdict:
  verified, not verified or inconclusive. A negative result is said plainly, not softened.
- A docs-only change runs no suite of its own; its pull request says it is docs-only, and its runs are still watched
  to the end.

## Tests, requirements and the merge scorecard

Lewis, 17 November 2026: "full test and task coverage on staging; don't cut to public without it hitting 98%" (UNB-208),
and "prep our codebase agents md to encourage this sort of behaviour in the future". He named deconflicted merges as
what broke staging that day.

- **A behaviour Lewis asks for is a row and a test, in the same PR.** Add one row to the requirements ledger
  (`docs/REQUIREMENTS.md`: his words, the date, the source, and the test that holds it) and the test that fails when
  the behaviour is gone. A change with no row, or a row with no test, is not finished. A row Lewis later replaces is
  marked SUPERSEDED, never deleted.
- **Red first.** stif, 17 November 2026. A test for a known bug runs on staging and fails there before the fix goes in;
  the red output is pasted in the PR. A coverage test for code that already works is shown failing once, by breaking
  the code on purpose, and the PR says what was broken. A test that passes whatever the code does does not count, and
  neither does one that asserts nothing or exists only to touch lines.
- **Experiments are short and behind a flag.** Branch from staging, put the change behind a flag, and merge or delete
  it within a week. No long-lived experiment branches: a branch that drifts for weeks is a deconflicted merge waiting
  to happen.
- **One area per PR, one agent per area.** Never several agents editing the same files at once. If two changes need
  the same files, the second waits for the first to merge and then branches from staging.
- **The merge scorecard.** No PR to staging merges if any of these is worse than staging: line coverage; the task
  gate; node memory on a fixed learn; first-learn time. Paste the scorecard in the PR: each number on staging and on
  the branch, with the commit and the date. A number that was not measured is written UNMEASURED and counts as worse.
  Line coverage is checked for you: `Coverage, ratchet` (coverage.yml, `promotion_gate.py ratchet`) refuses a PR when
  a gated part falls 0.05 points or more below the lowest of staging's last five runs, when the lines it adds or
  changes in a gated part are under 90% covered, or when a part was not measured. It names the part, files and lines.
- **A deconflicted merge re-runs the whole scorecard.** Lewis, 17 November 2026, named deconflicted merges as what
  broke staging. After any conflict resolution (a merge or rebase that needed hands), run every item of the scorecard
  again on the result before merging. The scorecard from before the conflict is void.
- **Staging is promoted to public only at 90% line coverage and with no task lost.** UNB-208; Lewis, 17 November
  2026 21:47 SGT: the task gate is no regression, not a percentage. Lewis, 19 November 2026: the code bar is 90%
  ("change it to 90%"; it was 98%, which no part met, so nothing could ship). Line coverage is at or above 90% in each
  of the Rust workspaces and both SDKs. The task gate refuses when a task right on the last promoted
  build is wrong now, when any answer is confidently wrong (that number is 0), or when fewer tasks pass than at the
  last promotion (the floor, which only rises). A task the site blocked is set aside and counted apart, never as a
  pass. Every exclusion from the coverage count (generated code, code built only on another OS) is listed in one file,
  `docs/COVERAGE-EXCLUSIONS.md`, with a reason, and Lewis approves that file. Never exclude silently to reach the
  number. `.github/scripts/promotion_gate.py` is the check; release.yml runs it before a tag publishes.

**The task gate and the 13 November rule.** The gate is a fixed bank of real tasks run through the MCP, scored against
each task's own check. It runs before a promotion and on a PR's scorecard. It keeps "Testing against sites" intact:

- **The agent is the caller and the judge.** A model is the client: it calls the node's tools as an agent would and
  reads each answer against the task's check. No script counts words or scores an answer. A script may start the
  agent on each task and write down its verdict; it never decides what is right.
- **A site that blocks the task is set aside, never passed.** A wall or an outage is counted separately. A task that
  needs clicks counts only if the agent finishes it. A confident wrong answer is its own number and is 0.
- **A changed verdict is read by hand before it is a regression.** If a task's verdict differs between two builds,
  take that site alone, on each build, one after the other, and read the data, as "Testing against sites" says. Until
  then it is "changed", not "regressed" and not "fixed".
- **The gate is not how a site is investigated.** To find out why a site fails, drive it one call at a time. A bank run
  started to see what falls out is still not allowed.

## Branching rules (mandatory)

- Never push directly to main, staging, or release/*. Always open a PR.
- New work: branch from staging, PR into staging.
- Never branch from main. Never merge main into anything.
- release/* branches are feature-locked: only `fix:` PRs.
- A fix merged into release/X.Y must be cherry-picked to staging in its own PR, titled "fix: ... (from release/X.Y)".
- Only a release/* branch may be PR'd into main. Do not open PRs into main unless explicitly asked to ship a release.

CONTRIBUTING.md ("Branches and releases") says how each branch releases.

## Self-merging PRs

Lewis, 18 November 2026: port poteto's workflow (pstack's Autopilot-full) so agents merge their own PRs, with the rules
held by `/contract`, not by prose. The gate is `~/.claude/skills/self-merge` (`pr-gate`, on PATH); setting it up on a
repo is the `autopilot` skill. This repo's additions to the gate's policy are in `.github/self-merge.json`. It was
proven first on `lekt9/hoysan-ops` (#22, #23, #24 merged through it).

- **Agents never run a merge, approve a PR, or edit branch rules here.** Standing `/contract` guards in every
  checkout's `.claude/contracts.jsonl` (worktrees inherit their main checkout's) refuse `gh pr merge`, the merge API,
  `gh pr review --approve` and writes to branch protection or rulesets. `pr-gate merge` is the only way in. Lewis
  can still merge by hand in his own terminal.
- **A PR merges itself only when all eight cells hold at its head:** in scope (open, ready, into `staging` or a
  `release/*` with a `fix:` title, not labelled `no-self-merge`); merge-ready (no conflicts, no unresolved review
  threads, no review still requested); fresh (nothing landed on `staging` since it branched touches its files or which
  checks run); CI green on the head; a PASS from a fresh agent that did not write it and ran the change, for this
  exact patch (`git patch-id`; a swarm of three for new behaviour over 300 lines of code); the body's Verification
  and Scorecard sections; no gate loosened without Lewis's countersign; and no new code comments where the policy
  bans them.
- **What needs Lewis's countersign:** workflows and anything under `.github/`, AGENTS.md and CLAUDE.md, lint and
  coverage configs, settlement, chain and contract code, the vault, the root key's keystore, logins, the macOS
  keychain, passkeys, cards and payment holds, `.deploy/`, the requirements ledger and the coverage exclusions, and any
  added line that switches a check off (`#[ignore`, `.skip(`, `continue-on-error: true`, `#[allow(`, …). He runs the
  countersign in his own shell (`!` prefix in Claude Code); an agent never does.
- **The author runs:** `gh pr create` (ready, never draft), then `pr-gate contract`. The supervisor
  (`pr-gate tick`, under `/loop 1h`) verifies it with a fresh agent, reruns a red check once, reports what waits on
  Lewis, and names READY PRs; the agent judges each cell (`~/.claude/skills/contract/scripts/contract iterate`,
  then `… _mark`) and runs `pr-gate merge`.
- **Goals.** `.github/self-merge.json` names numbers this repo holds itself to (first reply, warm call, memory,
  browserless share, reply size, agent steps), measured by `scripts/goals/measure.py` on a scratch node built from
  the tree. `pr-gate goal measure` records them; each goal is a `/contract` loop that stays open until trunk meets
  its target, and a regression reopens it. A change for a goal lands only if its own baseline and treatment show
  the number moving the right way. Changing a target is a policy change, so Lewis countersigns it.
- **A PR that asks for a person's decision waits for it.** Requesting steefpls' review (see below) holds the PR at
  merge-ready until he answers.

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
- A test written after the fix that never failed, or one that passes whatever the code does.
- Merging a conflict resolution on the strength of a scorecard taken before it.
- Excluding code from the coverage count to reach the bar, or calling a task the site blocked a pass.
