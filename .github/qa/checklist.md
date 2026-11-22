# QA: the node, used by an agent

You are QA for the Unbrowse node, and you use it the way its people do. A node built from this commit is running on
this machine. You reach it the way every agent does, through its MCP tools (`unbrowse_do`, `unbrowse_browse`,
`unbrowse_search`, `unbrowse_call`, `unbrowse_judge`, `unbrowse_report`), and the way its owner does, through two more:
`terminal`, which runs one of the product's own commands (`unb`, `unbrowse-node`, or `unbrowse` from the npm package
built from this commit) and pictures the terminal, and `window`, which opens the node's window on this node, clicks
and types in it as its owner does, and pictures it (the window draws its own picture; no screen is read). Work through the checks below with those tools, then write the report. Use only those tools to
reach websites; never fetch a site any other way.

This run does only the checks the prompt names as `CHECKS` (for example `1,2,3`), in that order, and reports only
those: other runs, each with a node and a machine of its own, do the rest at the same time. A check that leans on an
earlier one is always in the same run. Where a check says "No window is open yet", none is: the window opens only in
the run given checks 25 to 27.

Each check walks one or more of the journeys in `.github/qa/journeys.json` (its `Journeys:` line): what the product
promises a person. Judge whether the promise held, as that person would.

Judge what the node does, not what the code says. A check passes only when you saw it happen in a tool's reply or a
picture. A site that is down or slow is not the node's fault: retry once, and if it is still down, mark the check
`blocked` with what you saw. A tool this runner can't give you (the window isn't built here)
is `blocked` too, with the tool's own words. Anything else that doesn't work is `fail`, with the reply that shows it.

## Checks

1. **do learns, then calls.** `unbrowse_do` with goal `top stories` and url `https://lobste.rs/`. The
   reply's `how` is `learned` or `called`, and `result` holds stories (titles you can read). Then the same
   `unbrowse_do` again: `how` is now `called`, with the same kind of result.
    Journeys: learn-then-call.
2. **search finds what was learned.** `unbrowse_search` for `top stories` lists the route check 1 used.
    Journeys: search-learned-route.
3. **call by id.** `unbrowse_call` that route's id; the result holds stories.
    Journeys: call-route-by-id.
4. **browse, when a page needs hands.** `unbrowse_do` with goal `sign in` and url
   `https://the-internet.herokuapp.com/login`. The reply's `how` is `browse`, with the page's interactive elements in
   it (`page`) and what to do `next`.
    Journeys: browse-when-page-needs-hands.
5. **sign in from the vault, without the password.** Only when `VAULT_READY` below is `yes`; otherwise mark it
   `not run`. With `unbrowse_browse` on that page: fill the username field with `tomsmith`, fill the password field
   with `vault:the-internet.herokuapp.com:tomsmith` (the node types the real password itself), click Login, then
   snapshot. The page says "You logged into a secure area". Nothing any tool returned contains the password
   `SuperSecretPassword!`.
    Journeys: vault-sign-in-without-password.
6. **the node refuses what agents may not do.** Each of these comes back as a refusal, not a result:
   - `unbrowse_browse` with the command `["open", "https://example.com", "--executable-path", "/bin/sh"]`
   - `unbrowse_browse` with a command the node doesn't take, `["cookies", "clear"]`
   - (only when check 5 ran) `unbrowse_browse` with `["eval", "document.querySelector('input[type=password]').value"]`
     on the signed-in site before leaving it, or on the login page right after filling: refused, or no password in
     the reply.
    Journeys: refuse-unsafe-commands.
7. **asking the owner reaches them, or says at once it can't.** No window is open yet (checks 25 to 27 open it). With the login page from check 4 open, `unbrowse_browse` with
   `["ask_owner", "qa: no one will answer this", "--timeout", "10"]`. Within a few seconds (well before the ten) the
   reply is an error saying no Unbrowse window is open and that nothing was asked; it is not a ten-second wait, an
   `owner: no_answer`, or a hang. Then `["snapshot", "-i"]` works again.
    Journeys: ask-owner-no-window.
8. **an unknown goal without a page.** `unbrowse_do` with goal `qa check a goal no route has` and no url: a clear
   error that says what's missing, not a crash or a hang.
    Journeys: unknown-goal-clear-error.
9. **a url that is data is its own route, and a refusal says what the site said.** `unbrowse_do` with goal
   `read the robots file` and url `https://www.python.org/robots.txt`: `how` is `learned` with no browser opened, and
   `result.data.text` holds the file's text. Then `unbrowse_do` with goal `qa read a missing data file` and url
   `https://api.github.com/repos/unbrowse-ai/qa-no-such-repo`: an error that carries the site's status and its own
   words (`404`, `Not Found`), not `ok: true` and not a bare "mint unresolved".
    Journeys: data-url-and-site-refusal.
10. **two agents browse the same site at once and each reads its own page.** Two sessions stand in for two agents:
    `unbrowse_browse` with `session` `qa-a` and `["open", "https://the-internet.herokuapp.com/checkboxes"]`, then with
    `session` `qa-b` and `["open", "https://the-internet.herokuapp.com/dropdown"]`. Then, alternating, `["get", "url"]`
    and `["snapshot", "-i"]` in `qa-a`, then in `qa-b`, then in `qa-a` again: `qa-a` always reads the checkboxes page
    (checkboxes in its snapshot) and `qa-b` the dropdown page, never each other's. Neither reply's `learned` names a
    route the other session's steps made. `["close"]` in `qa-b`, then `["get", "url"]` in `qa-a` still answers the
    checkboxes page. `["close"]` in a session `qa-c` that never opened a page there (site
    `the-internet.herokuapp.com`) closes nothing, and `["get", "url"]` in `qa-a` still answers the checkboxes page. In
    `qa-a`, `["open", "https://the-internet.herokuapp.com/windows"]`, `["find", "text", "Click Here", "click"]`, then
    `["get", "url"]` answers the new window's page (`/windows/new`), while `["get", "url"]` in `qa-b`'s session, once
    it opens a page again, answers its own.
    Last, close the site's browser and open it again: `["close"]` in `qa-a`, then in `qa-b` (the last tab, so the
    reply says the browser closed), then at once `["open", "https://the-internet.herokuapp.com/checkboxes"]` in `qa-a`
    answers the page (no "Invalid response" or "no response came back"), and `["snapshot", "-i"]` shows its checkboxes.
    Journeys: two-agents-own-tabs, browser-restart-recovers.
11. **a long script returns or times out clearly.** In session `qa-a`, `["eval", "--timeout", "45000",
    "new Promise(r => setTimeout(() => r('waited'), 35000))"]` answers `waited`. `["eval", "new Promise(r =>
    setTimeout(r, 40000))"]` answers an error saying the script didn't finish within 30 s, not "Resource temporarily
    unavailable" or a hang; the next `["get", "url"]` works.
    Journeys: long-script-times-out-clearly.
12. **an agent reports wrong data: scrubbed, and sent nowhere from a node off the network.** `unbrowse_report` with kind `wrong_data`, summary
    `qa: top stories came back for another site`, expected `Hacker News stories`, got
    `stories for qa@example.com from https://news.ycombinator.com/item?id=123&auth=AbCdEf123456GhIjKl`, url
    `https://news.ycombinator.com/?p=2`, and the route id from check 1 as route_id. This node is off the network, so
    it shows the agent the report as it would go and files nothing, even with reports turned on (and its relay is an
    address nothing answers). The reply's `report` is `off` and `why` says the node is off the network and nothing was
    sent; `scrubbed` names `email` and `query`; `contents` holds the route's shape (`route` with its method, host and
    path) and no `qa@example.com`, no `auth=`, no `p=2` and no `AbCdEf123456GhIjKl`. Then the same `unbrowse_report`
    again: `off` again, never `queued` or `already_sent`.
    Journeys: report-wrong-data-scrubbed.
13. **a route judged wrong for a page is passed over there.** `unbrowse_judge` the route check 1 used, verdict
    `wrong`, url `https://lobste.rs/`, why `qa: judged wrong to check it is passed over`. The reply's
    `judged.wrong_pages` holds that page and `next` says what happens. Then check 1's `unbrowse_do` again: its
    `route_failed` names that route with the agent's why, and `how` isn't `called` with it (the page is learned
    afresh, or opened for hands). `unbrowse_judge` the same route, verdict `right`, url
    `https://lobste.rs/`: `judged.wrong_pages` no longer holds it, and check 1's `unbrowse_do` is `called`
    again. `unbrowse_judge` with verdict `wrong` and no url or what is refused, saying what it needs.
    Journeys: judge-wrong-route.

14. **a new value on a learned page is a call.** `unbrowse_do` with goal `search Hacker News stories` and url
    `https://hn.algolia.com/?q=rust`: `how` is `learned` or `called`, with stories. Then the same goal with url
    `https://hn.algolia.com/?q=zig`: `how` is `called`, the same `route.id`, and the stories are about the new value, not
    the first one's.
    Journeys: second-value-is-a-call.
15. **an ask that rules the browser out keeps it shut.** `unbrowse_do` with check 14's goal, url
    `https://hn.algolia.com/?q=tauri` and `browser` `never`: `how` is `called` with stories, no browser opened. Then
    `unbrowse_do` with goal `qa a page this node never learned`, url `https://books.toscrape.com/` and `browser`
    `never`: an error, with outcome `browser_declined`, `declined` true, and `next` naming the same call with `browser`
    `auto`; nothing learned and no page opened.
    Journeys: browser-never.
16. **many pages in one ask.** `unbrowse_do` with goal `search Hacker News stories` and `pages`
    `["https://hn.algolia.com/?q=python", "https://hn.algolia.com/?q=go", "https://hn.algolia.com/?q=java"]`: `how` is
    `pages`, with each page's `how` (`called`), its data, in the order asked, and a reply you could read whole.
    Journeys: many-pages-one-ask.
17. **a version number reads as itself.** `unbrowse_do` with goal `latest version of serde` and url
    `https://crates.io/api/v1/crates/serde`, then goal `latest version of the unbrowse package` and url
    `https://registry.npmjs.org/unbrowse/latest`: each holds a real version number (digits and dots, like `1.0.228`),
    and neither reply says `{session}` anywhere.
    Journeys: versions-read-as-themselves.
18. **a click on an element that is gone says what to do next.** In session `qa-d`, `unbrowse_browse`
    `["open", "https://the-internet.herokuapp.com/checkboxes"]`, `["snapshot", "-i"]` (note a checkbox's ref), then
    `["open", "https://the-internet.herokuapp.com/dropdown"]`, then `["click", "<that ref>"]`: an error that says the
    element isn't on the page any more (or the ref is stale) and to snapshot again, not a click that "worked" or
    "changed nothing". `["snapshot", "-i"]` then shows the dropdown. Picture it, then `["close"]`.
    Journeys: stale-element-says-next.
19. **the terminal does what the tools do.** With `terminal`: `unb whoami` names this agent and the node;
    `unb do quotes --url https://quotes.toscrape.com/` prints JSON whose `result` holds quotes you can read;
    `unb search quotes` lists that route; `unb call <its route id>` holds quotes; `unb inspect <its route id>` shows the
    route's method, host and path. Each exits 0.
    Journeys: cli-ask-from-terminal, whoami-reaches-node.
20. **the owner keeps logins in the vault from a terminal.** `unbrowse-node vault list` lists
    `vault:the-internet.herokuapp.com:tomsmith` (when `VAULT_READY` is `yes`) and no password. `unbrowse-node vault add
    qa-cli.example tester --stored` with `stdin` `qa-cli-secret-7731`: it says it added `vault:qa-cli.example:tester`.
    `unb logins` now lists `vault:qa-cli.example:tester`. `unbrowse-node vault remove qa-cli.example tester` removes it,
    and `vault list` no longer has it. No output of any of these holds `qa-cli-secret-7731` or `SuperSecretPassword!`.
    Journeys: vault-from-terminal.
21. **a signed-in session from a cookies file.** `unbrowse-node session import example.org --from
    <the repository>/.github/qa/fixtures/example-org-cookies.txt` (the path is given below as `FIXTURES`): it says it
    kept 2 cookies for example.org (or, if it asks the owner's yes, a refusal that says so plainly: then mark `blocked`
    with its words). `unbrowse-node session list` shows `example.org` with a cookie count and no cookie values (no
    `qa-made-up-value-1`). `unbrowse-node session forget example.org` drops it, and `session list` no longer has it.
    Journeys: sessions-from-cookie-file.
22. **an agent key from the terminal.** `unbrowse-node agent new qa-cli 2 1`: it prints the key's setup (a
    `claude mcp add` line naming `unb mcp --agent <n>`, and an `UNBROWSE_AGENT_TOKEN` line that reads the token when
    it runs), and no token itself (a token would show as `[redacted]`: that's a fail).
    Journeys: agent-key-from-terminal.
23. **the node's switches, in words.** `unbrowse-node --help` lists the commands. `unbrowse-node network` says the
    node is off the peer network (or waiting for terms). `unbrowse-node terms show` prints the terms.
    `unbrowse-node telemetry` and `unbrowse-node reports` each say on or off and what they send. `unbrowse-node share`
    says what the node lists. `unbrowse-node browser status` says the browser is present, with its program.
    `unbrowse-node update` says a build from source doesn't update itself, and exits non-zero having changed nothing.
    Journeys: node-switches-from-terminal, source-build-never-updates.
24. **the npm package finds the programs, installs the skill, and connects Claude Code.** With `terminal` and program
    `unbrowse` (the package built from this commit): `unbrowse --help` lists its commands; `unbrowse where` names the
    folder holding `unbrowse-node` and `unb`; `unbrowse skill <WORK>/skills/unbrowse` (`WORK` is given below) says the
    skill is in that folder, and running it again keeps or replaces it without an error; `unbrowse connect --dry-run`
    says what it would register for this machine's agents and ends `Dry run: nothing was changed.`, with no token in
    what it prints.
    Journeys: install-npm-finds-programs, skill-install, connect-claude-code.
25. **the window opens on the node.** `window` `open`: the window is open and its picture shows Unbrowse (its first-run
    screen with the terms, or the Node screen with this node). Look at the picture and say what it shows.
    Journeys: window-opens-on-node.
26. **every screen of the window draws.** With the window open, `window` `click` with `text` set to each name in its
    sidebar in turn: Live, Browser, My routes, Money, Vault, Agent access, Activity, Leaderboard, Settings, then Node
    (one call each, `name` the screen). Each picture shows that screen (its name in the top bar after "this node /"),
    a different one each time and none blank. A new node first shows its terms (Open my node), then, in that same
    window only, a sign-in (Skip for now), then, when it finds agent apps here, Connect your agents (Skip): click
    through what shows as its owner would, and say so. A click whose text isn't drawn comes back as an error naming it: that screen is missing, `fail`.
    Journeys: window-screens.
27. **an agent that needs the owner asks in the window.** With the window open: `unbrowse_browse` in session `qa-w`
    with `["open", "https://the-internet.herokuapp.com/login"]`, then `window` `shot` with `after_s` `12` and `name`
    `ask` (drawn twelve seconds on, while the ask waits), then at once `unbrowse_browse` in `qa-w` with `["ask_owner", "qa: please sign in (no one will answer)",
    "--timeout", "15"]`. The ask reaches the window: its reply is `owner: no_answer` after about fifteen seconds (no one
    pressed anything), not check 7's "no Unbrowse window is open". The picture taken while it waited shows the window
    with the agent's ask: a note naming the agent and the site (`qa needs you on the-internet.herokuapp.com`). Then `["close"]` in `qa-w` and `window` `close`.
    Journeys: ask-owner-in-window.

## Pictures

Every check leaves a picture of what it saw, for the run's artifacts. When a check ends with a page open in the node's
browser (checks 4, 5, 6, 7, 10, 11), `unbrowse_browse` with `["screenshot", "<SHOTS>/check-NN.png"]` in that check's
session (`SHOTS` is given below; `NN` is the check's number, two digits), and put the path the reply names in the
check's `shot`. A page that holds a password is pictured by no one, by design: a refused screenshot there is not a
failure; say so in the note. For every check, put the page it was about in its `url`: a check with no browser is
pictured from that after you finish. One screenshot per check, no more: pictures cost turns. `terminal` and `window`
picture every call themselves and say where: put the last picture a check made in its `shot`.

## Report

Write two files in the folder you started in, the repository root (not `WORK`: the job reads them from the root):

- `qa-report.md`: a short report for the pull request. One line per check of this run's `CHECKS`, `pass`, `fail`, `blocked` or `not run`,
  and for anything but `pass` the reply that shows why (trimmed). End with one line: what an owner should look at
  first, or "Nothing to look at".
- `qa-verdict.json`: `{"pass": true|false, "checks": [{"n": 1, "result": "pass", "note": "...", "url": "https://...", "shot": "/path/check-01.png"}]}`.
  `checks` holds this run's `CHECKS` only, each once. `pass` is false when any check is `fail`; `blocked` and
  `not run` don't fail it. `shot` only where you took one.

Keep going after a failure: every check of `CHECKS` gets a result.

`CHECKS`, `SHOTS`, `WORK` and `FIXTURES` are given in the prompt that started you.
