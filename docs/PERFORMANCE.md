# What the node costs, against what it cannot beat

Every cost the node, its browser and an agent using them pay, measured; beside it the **floor**, the same work done
by the plainest tool that does it (the same request by `curl`, the same page in a bare headless Chrome, an empty MCP
round trip), and the **budget** we hold it to: the floor plus a stated allowance. The "industry standard minimum" is
that floor plus allowance, and the practices any browser-automation stack is held to:

- every browser, context and page is closed by whoever opened it, however that scope ends;
- one browser per profile, reused; an idle one closed on a timer;
- no browser outlives the process that launched it, and a process starting reaps what a dead one of its home left;
- no work on the hot path that the reply does not need;
- replies sized to what was asked: fields named by default, the rest on request.

Measured on 14 November 2026, one MacBook (load 4 to 8), a scratch node from `test-banks/popular-sites/scratch-node.sh`
on this branch's debug build. Sites are not named here (the x-ray rule): "a public search page" is one SPA whose
search is one JSON POST to its search API, and the floors are taken against that same page and request. The scripts
are in `~/.unbrowse-xray/audit/` (`ask.sh` times one `unbrowse_do` over MCP and counts the node's browser processes
every half second; `mcp.sh` sends one MCP request). Rows marked *reported* are the owner's notes from earlier runs, not
re-measured here. The rows that awaited the A/B of the node's own asks (`own_asks`) now give what the default (arm B,
15 November) measures: the node asks a site nothing of its own.

## Processes and memory

| What | How measured | Today | Floor | Budget | Gap |
|---|---|---|---|---|---|
| Browsers left after a walk, a try, a second look | `ask.sh`, then `ps -A -o command= \| grep <home> \| grep -ci chrom` 20 s on | 0 | 0 | 0 | none |
| Browsers left when the node is killed mid-walk (`kill -9`) | `ask.sh … &`, kill at 6 s, count, start the node again on the same home, count | before this branch: every one in flight, for good (292 under one scratch node's tries, 2 to 20 h old, 7 to 41 per route). Now: 12 at the kill, **0** once a node of the home starts (`closed 1 browsers a node of this home left`) | 0 | 0 after the next start | fixed (`cdp::launched`, 7f0f3c8f) |
| Browsers left when the node is stopped (`SIGTERM`, `SIGINT`, `SIGHUP`) mid-walk | same, `kill -TERM` | before: every one in flight (`exit` runs no other thread's drop). Now **0** (`closed the 1 browsers its walks still had open`) | 0 | 0 | fixed (7f0f3c8f) |
| Browser processes during one learn (peak) | `ask.sh` peak | 13 (one headless Chrome is 6 to 7 processes; the walk, then the second look and the try overlap) | 6 to 7 (one bare headless Chrome) | 7: one browser at a time per ask | on defaults (15 Nov, the node asks a site nothing of its own) no second look and no try run beside a walk: one browser at a time per ask; the peak was not re-measured with `ask.sh` |
| Browser launches per first ask | `chrome_headless_launch` lines in the run's `guard.log`; now `browser {"launched"…}` in `node.log` and the x-ray's cost strip | 3 (walk, second look, try of the page's controls); on a site that refused the try's empty profile, a fourth (a clean browser in its place), and the try ran until ~50 s after the reply | 1 | 1 | **on defaults, 1** per first ask on each of ten live sites (68d16425, Node 22 then; booking twice on b9a9add1, Node 26): the walk's own; 22 launches in 40 asks on ten sites (arm B 20, arm A 66) |
| A walk whose ask gave up, holding the site's profile so the retry queues behind it | `curl -m 3` of an `unbrowse_do` (the agent hangs up), then the same ask again; and `notifications/cancelled` at 3 s | before: the walk ran on in its blocking task, the retry waited 26 s for the profile, and the stopped walk then fell back to the browser program and walked again. Now (2923015a) a hung-up or cancelled call's walks stop within 250 ms to 0.9 s, launch nothing more, and the reply says `stopped: …`; the retry waited **0 s** and answered in 8.9 s; nothing left | the retry starts at once | the walk ends with the ask | none. Still open (the owner's findings, 14 Nov): the node does not answer before the client's own wait ends (no MCP progress, no "still walking" reply: plain JSON only), and `PROFILE_WAIT` (120 s) is twice a client's 60 s, though a waiting ask that gave up now stops at once |
| A browser the node starts through the browser program (a route's browser step, a bridge's visit in the site's profile) | `ps` after the matrix ended | was **1 left** for good: a headless Chrome (12 processes) under an `agent-browser` daemon in `~/.unbrowse/profiles/<site>`. Now every command states `PROGRAM_IDLE` (30 min, `AGENT_BROWSER_IDLE_TIMEOUT_MS`) and the daemon closes it (dcf8e126, `a_browser_the_program_holds_closes_once_idle`). The matrix runs before the worker fix left one such browser per run until killed (a route client's session, kept open on purpose so the next call reuses it); after the fix, 10 runs of that row and a full matrix left none | 0 | closed at the browse sessions' 30 min | none for the node; a test process's are still left until the 30 min (to shorten under a test home) |
| A test opening a browser in the owner's home | where the matrix's program browser had its profile | was `~/.unbrowse/profiles/127.0.0.1` and `~/.unbrowse/browser-runtime`: the engine and the learner read `unbrowse_files::private::home`, which never knew a test's scratch home. Now a test binary has every crate read the test thread's home, and a thread with none a folder of the test process (dcf8e126, `a_test_never_opens_the_owners_home`); the matrix's program browsers since are in its scratch homes | never | never | none |
| Browse sessions' idle close | `browse::TAB_IDLE` | 30 min a tab; a browser whose every tab is idle closes whole | — | stated, 30 min | none (stated) |
| A person's handoff window | `cdp::chrome::HANDOFF_TTL` | closed at 10 min | — | stated, 10 min | none (stated) |
| Node RSS, idle | `ps -o rss= -p $(cat node.pid)` after start | 32 MB | — | 50 MB | none |
| Node RSS after 10 and 100 warm calls | 100 `unbrowse_do` calls of a learned route, 10 values | 50 MB after 10, 50 MB after 100: flat | — | flat (no growth per call) | none |
| Node RSS after a learn | `ask.sh` | 117 to 133 MB (the walk's trace and its candidates in memory) | — | back to idle + 20 MB once the learn ends | not yet measured whether it comes back |
| The page sandbox's isolates and their memory | not yet measured on this branch (needs a page-signed route) | — | 0 isolates between calls | 0 between calls | to measure |
| Profiles on disk | `du -sh home/node/profiles` | 27 MB for 2 sites (13 MB a site); nothing prunes them | — | a cap per home, oldest unused first | no pruning |
| Walk captures on disk | `du -sh tmp/unbrowse-node-walks` | 26 MB for 3 walks (8 MB a walk); kept, nothing prunes them | — | the last N walks a site, or a size cap | no pruning |
| `scratch-node.sh` shells left behind | `ps -A -o command= \| grep scratch-node.sh` with a node running | before: one copy of the script per node started, alive as long as the node. Now 0 | 0 | 0 | fixed (9792ba08; `test_the_script_leaves_no_copy_of_itself_behind_the_node`) |
| The x-ray server's state | `xray.sh state \| wc -c` on `~/.unbrowse` | *reported* 0.3 MB for 280 routes (was 10.7 MB) | — | 1 MB for 300 routes | to re-check |

## Speed

| What | How measured | Today | Floor | Budget | Gap |
|---|---|---|---|---|---|
| Time to first reply, page never seen | `ask.sh <port> <dir> '{"goal":…,"url":…}'` on a fresh home | was 14.8 s and 14.5 s (two public search pages), a third 22.3 s. Now, load 6.5: the first page 9.9 s (12.7 s after the walk change alone, a90394b2; 9.9 s once a page is parsed once, 3cdbbfeb), the second 13.2 s. *Reported* 15 to 54 s on others, one 190 s | 4.1 to 4.5 s: a bare headless Chrome launching, loading the page and settling (`Google Chrome --headless=new --dump-dom --virtual-time-budget=6000`) | floor + 3 s | ~2.5 to 6 s over budget: launch 1.4 s, walk 4.6 s, the node's own learn work ~3 s, first call 0.55 s. On defaults no second look and no try run after the reply (no more launches); the first ask on the ten live sites took 16 to 70 s at load 3 to 8 (a site's own page and its check included) |
| A later ask behind a background check | *reported*: waits up to 60 to 90 s on the second look (`api::goal::learn_page` waits for the first call, then `verify_learned`) | **0 on defaults**: no check runs behind a reply. A later ask is either called warm (0.3 to 1.7 s on the ten live sites) or, for a route not yet confirmed with a records place, served by the browser for that value (a walk, 16 to 82 s; 179 s once on a slow page) | 0 | 0 (never waits on a check) | none on defaults |
| Warm route call, a value not called before | the node's own `call … "ms"` in `node.log`, 10 new values | was 221 to 312 ms (median 270): each call built a transport of its own and paid DNS, TCP and TLS again. Now 195 to 213 ms (median 201), the connection reused (9ebc00d1, `calls_to_one_site_share_one_connection`: five calls, one connect) | 40 ms: `curl` of the same request, a new process and connection each time (330 ms the first, DNS cold) | floor + 30 ms | ~4×, inside the node: one request goes out per call (`SENT_LOG=1`), so the rest is the node's own work on the answer, on a debug build; to measure on a release build and profile |
| Warm route call, a value called before | same, 90 repeats | 37 ms median (the kept reply) | 0.6 ms (an empty MCP round trip) | floor + 50 ms | none |
| The first calls right after a learn | `node.log` calls 2 and 3 | 745 to 776 ms | 40 ms | as above | on defaults nothing runs in the background after a learn; the warm calls of the ten live sites answered in 0.3 to 1.7 s, each with the site's own latency |
| A browse action against the same action in a bare browser | *reported*: learning adds 1 to 6 s per click, fill or press | not re-measured | the action in the bare browser | floor + 0.5 s; the learning after the reply | to measure |
| A heal that re-walks inside a call | not re-measured | — | the call | no walk inside a call (REBUILD §7: heals leave the call path) | to measure |
| Cold browser launch against reattach | `Google Chrome --headless=new` start to first page | ~1 s launch inside the 4.1 s above; reattach not yet measured | reattach (a CDP connect) | — | to measure |
| A sandbox-signed call | *reported*: 9 to 32 s on one site | not re-measured | the signed request by curl | floor + 1 s | to measure |
| The node's start | `scratch-node.sh` start to first `/v1/health` | ≤ 2.1 s (the script polls every 2 s) | — | 1 s | to measure finer |
| An empty MCP round trip | `mcp.sh … '{"method":"ping"}'` ×3 | 0.5 to 0.9 ms | — | 5 ms | none |
| The learner on the corpus (pairing calls across walks, the wiring per hole, the digest search) | `docs/COMPLEXITY.md` (harness branch) | see that table | — | linear in the walk | there |

### Time to first reply, by phase

Read from a walk's own capture (each line's `t`) and the node's `call` lines, one search page never seen
(`ask.sh`, a fresh home). Before 34788707, then after:

| Phase | Before | After | Floor | What it is |
|---|---|---|---|---|
| Launch and attach | 1.4 s | 1.4 s | ~1 s (bare Chrome start) | a new browser per walk; the site's open browser is reused when one runs (`browse::browser_in`) |
| Load to ready | 1.5 s | 1.5 s | the page's own | — |
| Walk window after ready | 14.1 s | 8.6 s, now **3.0 s** | 0 s once the page's data call has answered | was `settle_ms` 6 s, then four nudges 1.5 s apart (8.6 s). Now browsing ends at the next nudge's turn when the last nudge made the page send nothing, in any context, and nothing it asked is open (a90394b2; a `walk_end` line in the capture): one nudge, 3.0 s, on both public pages. A page that answers its nudges is walked to the old end. Matrix 25, 25, 24 of 25 (the failure was the worker row, which never reached this rule: 8 of 10 with it and 8 of 10 without), then 25 of 25 with the worker fix; matrix time 487 s → 193 s |
| A worker's first call missed | the matrix's worker row alone, 10 runs | 8 of 10: the worker called before the walk turned its network on, and Chrome reported the answer without the request | 10 of 10 | 10 of 10 | fixed (722d8a44: a worker, never a frame, is held at its first line until its network is on, at most 1 s); 10 of 10, each run 8 s (was 40 to 50 s) |
| The learn's own work, walk end to first call | 4.7 s | ~4 s, now ~3 s | — | a `sample` of one ask: most of the node's own CPU was HTML parsing of the one 350 KB page, seven times (`page::read` from `answer_like`, `answer_of`, `fails_goals`, the client's run, the experiment; `page::a_door` from the trace's door). Each is now parsed once (3cdbbfeb). Left: the try's form labels (`controls::label_of`, ~1 s, after the reply), the walk's own parse in `session::mint` (~1.4 s of samples), debug-build checks (to see on release, item 4) |
| First call | 0.6 s | 0.6 s | curl | — |
| After the reply | — | — | — | on defaults nothing starts after the reply: no second look, no try (`own_asks`, every family held; `[own-ask] held` lines) |
| Total | 22.3 s | 16.8 s, now 9.9 s (another page: 13.2 s) | 4.1 to 4.5 s | — |

## The runtime for a page's code

| What | How measured | Today | Floor | Budget | Gap |
|---|---|---|---|---|---|
| Routes that run a page's code (rung 2, and a rung-1 digest over a script's constant) | the matrix on Node 22 and Node 26 (4efd3576), the same binary | Node 26: every row as before. Node 22 (below 25): `signed-standard`, `signed-own`, `signed-reads` fall to the browser and fail honestly there; `cipher-answer` is not learned, said as "the page's answer is read only by the page's own code: … needs Node 25 or later"; no sandbox child starts, no wrong answer | — | — | rung 2 needs Node 25 or later (`sandbox::permits`, `docs/CLI.md` §1); on staging's sandbox (merged 17 November) `sandbox::confined` decides and Node 22.23.3 is confined too (`docs/CLI.md` §1) |

## Requests and tool calls

| What | How measured | Today | Floor | Budget | Gap |
|---|---|---|---|---|---|
| Page loads per first ask | `guard.log` launches, `node.log` walks | 3 on one page (walk, second look, try). *Reported*: about 4 an ask (of 96 loads on 19 sites: 25 an agent's, 45 a nonsense word, 15 a made-up second word, 11 re-walks); a matrix run made 86 asks of its own; shrinking removed nothing on any matrix row | 1 | 1 | **on defaults, 1** per first ask; 25 page loads in 40 asks on ten live sites (arm B 22, arm A 33), the node's own asks 0 (arm A 179 sends): each later load is an agent's own ask for a value a route has not yet answered confirmed. Matrix on defaults (4efd3576, Node 26): 52 walks over 27 rows, the node's own 0 |
| Site requests per warm call | `SENT_LOG=1 scratch-node.sh …`, lines of `sent.jsonl` per call | 1 | 1 | 1 (+1 a page the route reads on) | none |
| `tools/list` size, every session | `mcp.sh … tools/list`, bytes of `tools` | 30.9 KB, ~7.7k tokens, 15 tools; `unbrowse_do` alone 6.3 KB, `unbrowse_judge` 5.5 KB, `unbrowse_browse` 3.9 KB | name, one line and schema a tool: ~0.3 KB a tool, ~5 KB for 15 | 12 KB | 2.6× |
| One `unbrowse_do` reply (a search, default fields) | `ask.sh`, bytes of the MCP reply | was 19.9 KB, pretty-printed (44% indentation); now 11.1 to 12.2 KB, compact (8cd219fb); a second site's search 17.7 KB compact, flagged by the cost strip. The default fields still carry each record's highlight copy beside its title (`hits[]._highlightResult…`): about a third of the data | the fields the goal named | compact JSON of the named fields, ~6 KB here | ~2×: fields the goal did not name are returned by default |
| Calls per goal, at best | one `unbrowse_do` | 1 when the reply answers | 1 | 1 | — |
| Calls per goal, reported | *reported*: a public read took an agent 15 calls and 174 s and got nothing; a sign-up 80 calls, 320 s, $2.68 | not re-measured | 1 | 3 | dead ends from replies that mislead (below) |
| Replies that mislead | *reported*: a challenged walk reported as "The operation timed out"; `unbrowse_browse open` reporting success on a site's offline error page; `browser_missing` saying the browser is present; `ask_owner` failing only when called | not re-measured | — | each says what happened | to fix, each with a test of the reply |

## Next, in order of cost

1. ~~Replies in compact JSON~~ (8cd219fb). ~~One transport reused across calls~~ (9ebc00d1).
2. The node's own time on a warm call (~160 ms over the request on a debug build): measure on release, then profile.
3. ~~The cost strip in the x-ray~~ (49b7ecb5: launches and reply sizes now logged). Not recorded yet: the time to a
   learn's first reply as its own line, and which own ask (second look, nonsense word, try) each load and request was for.
4. ~~A walk cancelled with the ask that gave up on it~~ (2923015a). Next with it: answer before the caller's wait ends.
5. Pruning walk captures and profiles.
6. Tool descriptions toward 12 KB.

## Budgets as score fields (for the harness branch)

The harness reads each as a number per route and per home, with its budget beside it; a field over its budget is a
flag. Names, counts, sizes and times only, never a value.

| Field | What | Budget |
|---|---|---|
| `cost.browsers_left` | browser processes of the home alive 20 s after the run | 0 |
| `cost.browser_launches` | browsers launched for one ask (`browsers-launched` records, `guard.log`) | 1 + each kept probe |
| `cost.page_loads` | walks of the page for one ask: the agent's, the second look, the nonsense word, the second word, re-walks | 1 + each kept probe |
| `cost.own_asks` | requests the node sent the site on its own account (probes), per ask | 0 + each kept probe |
| `cost.site_requests_per_call` | `sent.jsonl` lines per warm call | 1 (+1 a page read on) |
| `cost.ms_first_reply` / `cost.floor_ms_first_reply` | first reply of a page never seen, and a bare headless Chrome's load of it | floor + 3000 |
| `cost.ms_call` / `cost.floor_ms_call` | a warm call of a new value, and curl of the same request | floor + 30 |
| `cost.reply_bytes` | bytes of the MCP reply text | the named fields, compact |
| `cost.tools_bytes` | `tools/list` bytes, per session | 12000 |
| `cost.rss_mb_idle` / `cost.rss_mb_after_100` | node RSS idle and after 100 calls | 50 / no growth |

## Verification of the performance commits (14 November, 072933db)

clippy `-D warnings`: unbrowse-learn and unbrowse-node-app clean; `agent-browser-core` on its own fails with 45 errors,
none in a line these commits wrote (41 in `session.rs`, dead fields in `chrome.rs`), so they were there before. Learn
lib 689 passed (6 ignored) with the filler off and on; the app's filters 425 (32 ignored); x-ray 86; the browser
crate 199 of 200, the failure this branch's own (`closing_all…` closed another test's fake Chrome: fixed in 454dba92,
then 200 of 200 three times); the matrix with the switch on 25 of 25, and 25 of 25 again on 34788707 (the walk fix), the browser crate 201 of 201. Logs in `~/.unbrowse-xray/audit/verify/`.
