# The x-ray harness

One harness for reading what the engine learned, against the engine as it stands. Its default is a live page. Its
text and static modes give the same readings to CI and to sessions without a browser. It asks no site.

Run it straight after a learn, from the checkout you are fixing:

```sh
UB_DIR=<scratch node folder> scripts/xray/xray.sh     # THE LIVE VIEW of that node: prints http://127.0.0.1:7317/
scripts/xray/xray.sh                                  # without UB_DIR: ~/.unbrowse and the matrix runs under $TMPDIR
```

The page redraws as the node's files change (route files, `made.jsonl`, `node.log`, the walk captures, the engine's
source). `XRAY_PORT` sets the port; if it is taken, the next free one is used and printed.

The same readings without a browser:

```sh
UB_DIR=<node> scripts/xray/xray.sh state              # the state the page draws, as JSON, secrets shaped as on the page
scripts/xray/xray.sh diff <home A> <home B>           # what changed, as text; exits 1 on a new break. A scratch
                                                      # node's folder is read with its log and walks, so a call
                                                      # that newly differs from its browser is listed (`+ differs`)
UB_DIR=<node> scripts/xray/xray.sh --text             # each route's findings and the code they point at, as text
UB_DIR=<node> scripts/xray/xray.sh pages              # static pages in ~/.unbrowse-xray (open index.html)
scripts/xray/xray.sh <route.json | folder>...         # static pages of those routes
scripts/xray/xray.sh build                            # builds route_tree once (see below)
scripts/xray/xray.sh walks [corpus]                   # kept walks, as the rebuild's learner reads them
```

`wiring.py` is the live view itself (`serve`, `render`, `state`, `diff`; `--home`, `--ub-dir`, `--matrix`, `--log`,
`--captures`, `--engine`, `--map`). `xray.sh` calls it with the scratch node, the checkout and the rebuild's map
filled in. A worker hands back the `diff` output, not prose. The header of `xray.sh` lists what can be set
(`UB_DIR`, `XRAY_PORT`, `XRAY_RUNNING`, `XRAY_REBUILD`, `XRAY_LOG`, `XRAY_OUT`, ...).

**Pages and snapshots name sites, so they never go into a repository.** `route-xray.py` and `wiring.py render`
refuse to write into one. No value of a route is printed: a value is described by its shape. A word the page was asked
is written `‹word›`. A value shaped like a key, an id or a number of six digits or more is shown by its shape
(`‹18 chars, token-like›`). A cookie, a stored value or a secret slot is shown by its name.

## The cost strip

Beside the flags, each home of the group shows what it cost against its budgets (`docs/PERFORMANCE.md`): page loads
(`eye … started` in the node's log), browsers launched (`browser {"launched":…}`), calls (`made.jsonl`) and the requests
they sent (`sent.jsonl`, kept when the node runs with `UNBROWSE_SENT_LOG`; `SENT_LOG=1` for a scratch node), the largest
and median reply an agent was sent (`reply {"tool":…,"bytes":…}`), and browsers a stopped node of the home left running
(`browsers-launched/*.launch` whose launcher is gone). A field over its budget is red, and `state` carries the same as
`cost` (with `over`: field, value, budget). Each route's line shows the median time of its recent calls. All are names,
counts and sizes; the log's counts are over the whole log, which a scratch node appends to across restarts.

## What the live view shows

Every route of a home at once. Each hole of each request sits on the bottom sheet, with a string running up to the
layer its value comes from: the caller, earlier answers, the session, page storage, the clock, the sending script,
the page, or a person. Views: all routes; one route large, step by step in fill order; side by side (a route's graph
against its body, or two groups matched by matrix row).

The page stays light on a big home. It opens on `/overview`: one line a route (its last call, its calls, its holes by
layer, its steps by rung, its flags and findings), listed worst first, 40 to a page. The counts at the top are worked
out on the server over every hole, drawn or not. A route's holes are fetched from `/route` only when it is opened (▸,
or by its name), and drawn 12 steps at a time. The page polls `/version`. It fetches the overview again only when a
file moved, and an open route's detail only when that route's own `sig` moved. A route is read again on the server
only when its file, its calls, its learn or its walk moved. On `~/.unbrowse` (280 routes) the page is drawn in about
0.3 s from 0.3 MB, where the first version took 2 s and 10.7 MB.

1. **Findings**, from `route-xray.py`'s catalogue (break, risk, note), asked of its code and never re-implemented.
   Each sits on the hole, step or route it is about, in the catalogue's words. A ring round a hole shows its worst
   finding, and the counts are at the top beside the flags. On a route kept as a body, a finding is found on the
   route's graph and laid on the same place of the same call. Where a flag and a finding say the same thing (open; a
   time of the walk sent as walked), the finding is kept and carries the flag's evidence.
2. **From a hole to the engine, in one click.** Click a hole or a finding to see its kind (`Class::`, `Expr::`,
   `Held`), with the functions that write it and the functions that branch on it: file, line, length, callers. They
   are read by `engine-map.py` from the checkout the harness runs from, uncommitted edits included, and read again
   when a source file changes. The rebuild comes from the map `xray.sh` makes (`--map`). Under each finding is
   `WHY`'s line for it, resolved against the source: who wrote it this way, who would have strung it, the pass that
   decides the seam, how the rebuild's tree says it, and what neither can say yet. A name the source no longer has is
   shown as gone.
3. **The pick**, fed by the node's log through `xray_log.py` (`$UB_DIR/node.log`, or `--log`). Each walk shows every
   candidate call with its score, what it holds, why it was held back, which one was picked, and the pick's reasons.
   A learn that kept no route ("it needs clicks or typing") shows here, since it has no route file, and so does a
   walk with no candidate at all. Where the walk's capture is at hand (`$UB_DIR/tmp/unbrowse-node-walks`), it says
   whether the page started a worker or frame that made no call (the walk ended before it called). A frame or worker
   whose calls trace back to one of the browser's own pages (its new-tab page) is not the page's.
4. **The call log.** Each route's last calls from `made.jsonl` appear as a strip of squares, oldest first, coloured
   by rung (B where a browser ran, a red edge for a failure). Each step's number takes the colour of the rung the
   last call ran it at (`made.jsonl`'s `steps`, the answer's step last). *Fell to the browser* flags a route that
   answered plain before and ran a browser on its last call.
5. **Flags**, each a rule, counted at the top, and listed per route in `flags` with the number of holes:
   - *open*: no way;
   - *fixed, but it moves* (evidence below);
   - *above its ceiling*;
   - *a browser ran*;
   - *fell to the browser*;
   - *rung under-reported*;
   - *unknown op*.

   A hole counts once for each kind. A hole with a flag or a finding is never folded, so what is counted is drawn.
6. **Fixed, but it moves.** A hole sent as fixed text, with any of this evidence (shapes only):
   - its sightings moved between walks;
   - the route's own graph strings it to a source;
   - the route notes a `tied`;
   - it equals a value that an earlier reply or the page's storage held in the walk (with the capture at hand);
   - it is a header shaped like an id, on a step that follows a write (POST) the route left out (from its graph or its
     walk);
   - it is a header shaped like an id, the route keeps none of the calls the walk made before it, and nothing else
     explains it.
7. **The browser's own headers fold** into a chip per step. Each is read in this order: the route's sightings
   (`Kind::Browsers`); then the walk (a header sent on what the document loads by itself, where no page code sets
   one: `slots::BrowsersOwn`'s property); then, only where neither says, the Fetch standard's names. The legend says
   how many were folded by each.
8. **A person**: a `person` or `door` field on a hole, or a sighting from one. No route carries one yet; the legend
   says which reading was used.
9. **Route to transport** (`xray_wire.py`), in an opened route only. For each step of the last call there are three
   columns, side by side:
   - **The walk's browser**: the capture's `request_extra`, which holds Chrome's wire headers, its cookies, and its
     pseudo-headers (they mean h2 or h3; none means h1). Beside it is the reply's status.
   - **The route says**: each header and cookie hole, and its source.
   - **What the call sent**: read from `<home>/sent.jsonl` (the engine addition below), the node's `[wire]` lines
     (`UNBROWSE_WIRE_DEBUG`), or the names the client prints of a refused request (`UNBROWSE_SIGN_DEBUG`), in that
     order. The node's log is cut into calls by its `call {"phase":"start"}` and `"end"` lines.

   A column with nothing behind it says "not recorded", and says what would fill it. Each difference is a kind, read
   as a rule:
   - a header the browser sent that the call did not;
   - one the call sent that the browser never did;
   - the same headers in another order (only where the capture keeps the order; it does not today, since every wire
     list is alphabetical);
   - a cookie the browser carried that the call, or the jar, did not give;
   - a value the route fills that went out empty, or as the walk's own;
   - another protocol;
   - client hints or a user agent that name another browser than the walk's (the jar's fingerprint sample, agreed
     with the request's hints as `http.rs::agreeing_user_agent` does);
   - a reply that reads as a refusal (`trace::REFUSED`, read from the engine's source), or as the site's door (the
     engine's words, "met the site's door").

   Where there is no record of the call, the browser's request is held to the route instead, and only for the
   headers the page set: a name only Chrome's network stack wrote is the browser's own, and the transport writes
   those itself. A refused request the route as it stands no longer names (it was learned again since) is held to
   the walk's own request to that address. Click a difference for the engine's functions that build that part of
   the request (`xray_wire.KINDS`, resolved like `WHY`). Three flags count at the top:
   - *refused, the request differs*: the refused request's own differences, against the call's record or else the
     route, and which of the two it was held to is said;
   - *refused, the request identical*: the wall is not about the request's shape;
   - *sent as walked, the session's*: a cookie sent as fixed text (the jar never replaces a cookie the request
     carries: `client.rs::with_session_cookies`), or a fixed value equal to a cookie of the walk or a value of the jar.

   Values are compared on this machine and never shown: names, lengths and kinds only. The exact request a call sent
   is not written anywhere by the engine today. The engine addition that writes it, one line per request sent, names
   and shapes only, under `UNBROWSE_SENT_LOG`, is kept outside the repository with its note. Start a node with
   `UNBROWSE_SENT_LOG=$UB_DIR/home/node/sent.jsonl` and the call's column fills in with its cookies, protocol and
   statuses.

## What the text and static modes read

1. **The route as the node kept it** (`<node>/routes/*.json`). Every value a step sends is a *hole*. Its *string* is
   where the value comes from: the caller, the session, an earlier answer, the clock, or nothing (sent as walked).
   Unstrung holes, bad strings and open seams are the findings. `route-xray.py` holds their catalogue and reads the
   route's graph.
2. **The engine's source as it stands** (`engine-map.py`). It reads a checkout (uncommitted edits included) and the
   rebuild branch by ref. For each kind a hole can have, it lists the functions that write it and that branch on it.
   `xray_why.py` (`WHY`) names, for each finding, the kinds and functions that decide it. It names them only: where
   they are is read from the source on each run.
3. **The node's own log of the learn** (`xray_log.py`, from a node started with `SIGN_DEBUG=1`). It reads each call
   the walk made, every candidate scored and why each was held back, the pick and its reasons, each value's kind at
   each build, and every line after the pick. A wrong pick shows here and nowhere among the route's holes.

The rebuild's own reading comes from `route_tree`, an example of the rebuild's learner crate. With `body` it says a
kept route as the tree and shows what `Route::refused` refuses. With `walks` it shows what `lab::compile::learn`
writes from two kept walks, or why it writes none. `xray.sh build` builds it from a checkout that has
`unbrowse-node/crates/learn/examples/route_tree.rs` (`XRAY_TREE_SRC`).

## How it is used

One site at a time:

1. Drive the site: only the ask typed, three words and then a word nobody searches for.
2. Open the live view (`UB_DIR=<node> scripts/xray/xray.sh`). Click the hole or finding, and read the functions it
   lists before naming a cause. If the learn kept nothing, read the pick.
3. Fix one of them as a property of the walk, with a test named for it. Never fix the route.
4. Learn the site afresh: the view redraws, and the finding must be gone. Hand back
   `xray.sh diff <home before> <home after>`. Then try a second site.

Where the x-ray does not explain a failure, extend it until it does. That means a finding in the catalogue, the
functions that decide it in `WHY`, and the log lines that raise it in `xray_log.findings`. The view shows a new finding
with no change of its own. Never add a finding to hide one.

## Its tests

```sh
python3 -I -m unittest discover -s scripts/xray -p 'test_*.py' -v
```

They use made-up routes, logs and walk captures on `shop.example`. `test_xray.py` covers the catalogue and the log,
`test_wiring.py` the drawing and its flags, and `test_transport.py` the route-to-transport columns, their kinds, flags, the engine's functions, the
diff and the state, and `test_harness.py` the one harness: findings on their holes, the engine
in one click, the pick (a learn that kept nothing, no candidate, a walk that ended early), the call log, the evidence
that a fixed value moves, counts that agree with what is drawn, the person layer and the folds, the diff, the state
as JSON and the front door. Every function of the running engine that `WHY` names must be in the source: rename one
and that test fails until `WHY` follows.
