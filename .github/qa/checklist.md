# QA: the node, used by an agent

You are QA for the Unbrowse node. A node built from this pull request is running on this machine, and you reach it
the way every agent does: through its MCP tools (`unbrowse_do`, `unbrowse_browse`, `unbrowse_search`,
`unbrowse_call`, `unbrowse_judge`, `unbrowse_report`). Work through the checks below with those tools, then write the report. Use only those tools to
reach websites; never fetch a site any other way.

Judge what the node does, not what the code says. A check passes only when you saw it happen in a tool's reply.
A site that is down or slow is not the node's fault: retry once, and if it is still down, mark the check `blocked`
with what you saw. Anything else that doesn't work is `fail`, with the reply that shows it.

## Checks

1. **do learns, then calls.** `unbrowse_do` with goal `top stories` and url `https://news.ycombinator.com/`. The
   reply's `how` is `learned` or `called`, and `result` holds stories (titles you can read). Then the same
   `unbrowse_do` again: `how` is now `called`, with the same kind of result.
2. **search finds what was learned.** `unbrowse_search` for `top stories` lists the route check 1 used.
3. **call by id.** `unbrowse_call` that route's id; the result holds stories.
4. **browse, when a page needs hands.** `unbrowse_do` with goal `sign in` and url
   `https://the-internet.herokuapp.com/login`. The reply's `how` is `browse`, with the page's interactive elements in
   it (`page`) and what to do `next`.
5. **sign in from the vault, without the password.** Only when `VAULT_READY` below is `yes`; otherwise mark it
   `not run`. With `unbrowse_browse` on that page: fill the username field with `tomsmith`, fill the password field
   with `vault:the-internet.herokuapp.com:tomsmith` (the node types the real password itself), click Login, then
   snapshot. The page says "You logged into a secure area". Nothing any tool returned contains the password
   `SuperSecretPassword!`.
6. **the node refuses what agents may not do.** Each of these comes back as a refusal, not a result:
   - `unbrowse_browse` with the command `["open", "https://example.com", "--executable-path", "/bin/sh"]`
   - `unbrowse_browse` with a command the node doesn't take, `["cookies", "clear"]`
   - (only when check 5 ran) `unbrowse_browse` with `["eval", "document.querySelector('input[type=password]').value"]`
     on the signed-in site before leaving it, or on the login page right after filling: refused, or no password in
     the reply.
7. **asking the owner reaches them, or says at once it can't.** QA runs no owner's window, and none can be opened
   beside a node built from source. With the login page from check 4 open, `unbrowse_browse` with
   `["ask_owner", "qa: no one will answer this", "--timeout", "10"]`. Within a few seconds (well before the ten) the
   reply is an error saying no Unbrowse window is open and that nothing was asked; it is not a ten-second wait, an
   `owner: no_answer`, or a hang. Then `["snapshot", "-i"]` works again.
8. **an unknown goal without a page.** `unbrowse_do` with goal `qa check a goal no route has` and no url: a clear
   error that says what's missing, not a crash or a hang.
9. **a url that is data is its own route, and a refusal says what the site said.** `unbrowse_do` with goal
   `read the robots file` and url `https://www.python.org/robots.txt`: `how` is `learned` with no browser opened, and
   `result.data.text` holds the file's text. Then `unbrowse_do` with goal `qa read a missing data file` and url
   `https://api.github.com/repos/unbrowse-ai/qa-no-such-repo`: an error that carries the site's status and its own
   words (`404`, `Not Found`), not `ok: true` and not a bare "mint unresolved".
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
11. **a long script returns or times out clearly.** In session `qa-a`, `["eval", "--timeout", "45000",
    "new Promise(r => setTimeout(() => r('waited'), 35000))"]` answers `waited`. `["eval", "new Promise(r =>
    setTimeout(r, 40000))"]` answers an error saying the script didn't finish within 30 s, not "Resource temporarily
    unavailable" or a hang; the next `["get", "url"]` works.
12. **an agent reports wrong data: scrubbed, and sent nowhere from a node off the network.** `unbrowse_report` with kind `wrong_data`, summary
    `qa: top stories came back for another site`, expected `Hacker News stories`, got
    `stories for qa@example.com from https://news.ycombinator.com/item?id=123&auth=AbCdEf123456GhIjKl`, url
    `https://news.ycombinator.com/?p=2`, and the route id from check 1 as route_id. This node is off the network, so
    it shows the agent the report as it would go and files nothing, even with reports turned on (and its relay is an
    address nothing answers). The reply's `report` is `off` and `why` says the node is off the network and nothing was
    sent; `scrubbed` names `email` and `query`; `contents` holds the route's shape (`route` with its method, host and
    path) and no `qa@example.com`, no `auth=`, no `p=2` and no `AbCdEf123456GhIjKl`. Then the same `unbrowse_report`
    again: `off` again, never `queued` or `already_sent`.
13. **a route judged wrong for a page is passed over there.** `unbrowse_judge` the route check 1 used, verdict
    `wrong`, url `https://news.ycombinator.com/`, why `qa: judged wrong to check it is passed over`. The reply's
    `judged.wrong_pages` holds that page and `next` says what happens. Then check 1's `unbrowse_do` again: its
    `route_failed` names that route with the agent's why, and `how` isn't `called` with it (the page is learned
    afresh, or opened for hands). `unbrowse_judge` the same route, verdict `right`, url
    `https://news.ycombinator.com/`: `judged.wrong_pages` no longer holds it, and check 1's `unbrowse_do` is `called`
    again. `unbrowse_judge` with verdict `wrong` and no url or what is refused, saying what it needs.

## Report

Write two files in the working directory:

- `qa-report.md`: a short report for the pull request. One line per check, `pass`, `fail`, `blocked` or `not run`,
  and for anything but `pass` the reply that shows why (trimmed). End with one line: what an owner should look at
  first, or "Nothing to look at".
- `qa-verdict.json`: `{"pass": true|false, "checks": [{"n": 1, "result": "pass", "note": "..."}]}`. `pass` is false
  when any check is `fail`; `blocked` and `not run` don't fail it.

Keep going after a failure: every check gets a result.
