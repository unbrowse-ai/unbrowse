# Routes: learn and call

A route is a website's own API call, learned once by walking its page in the node's browser, then replayed as plain HTTP with no browser. An agent says what it wants (`do`) with a goal in plain words and the address of a page that does it. The node calls a kept route, or learns one, or opens the page for the agent's hands. The agent can also list routes, call one by id, read its makeup, list a page's calls to pick one, drive the browser by hand, read the open page as actions, pass a person check, and tell the node what it saw (`judge`).

## Sub-features

- `do-learned` walks a page once and keeps the call that answers the goal (`how: learned`).
- `do-called` answers the same goal again with no browser (`how: called`).
- `do-new-value` answers a new value from the page address or `inputs` with a new call.
- `do-fields` returns only the named fields, and `["*"]` returns the whole answer.
- `do-browse` opens a page that needs hands (`how: browse`).
- `do-network` uses another contributor's route and pays its fee (`how: network`).
- `do-browser-missing` answers 422 `browser_missing` when the goal needs a browser it cannot use.
- `do-still-working` answers `still_working` with `ask` and `next` past `wait_ms`.
- `search` lists this node's routes and the network's, best first.
- `call` runs a route by id with `inputs`.
- `inspect` shows a route's steps, fields, classes and sources.
- `judge-wrong` sets a route aside for a page, so `do` learns the page afresh.
- `judge-right` keeps a route, with its fields as defaults.
- `walk` lists a page's own calls; `walk-pick` keeps the one chosen.
- `browse` drives the node's browser by hand and learns from each step.
- `observe` reads the open page as actions with stable refs. It pays nothing and writes nothing.
- `challenge` shows a page that asks for a person, and takes one step.
- `open` previews an `unbrowse://` link and calls nothing.
- `route-files` keeps each route as `routes/<id>.json` under the node's home.

## How to get to it (user POV)

- CLI: `unb do`, `unb search`, `unb call`, `unb inspect`, `unb judge`, `unb walk`, `unb browse`, `unb observe`, `unb challenge`, `unb open`; installed as `unbrowse do` and so on.
- MCP: `unbrowse_do`, `unbrowse_search`, `unbrowse_call`, `unbrowse_inspect`, `unbrowse_judge`, `unbrowse_walk`, `unbrowse_browse`, `unbrowse_observe`, `unbrowse_challenge`, `unbrowse_open` at `POST /mcp`.
- HTTP: `POST /v1/do`, `GET /v1/routes?q=`, `POST /v1/routes/{id}/call`, `GET /v1/routes/{id}/inspect`, `POST /v1/routes/{id}/judge`, `POST /v1/walk`, `POST /v1/browse`, `POST /v1/observe`, `POST /v1/challenge`, `GET /v1/open?q=`.
- SDK: `do`, `call`, `search`, `browser()`, `judge`, `open` (see `sdk.md`).
- Owner side: `owner routes`, `owner call_route`, `owner delete_route`, `owner sites` (see `window.md`).
- File: `<scratch home>/routes/<id>.json`, read-only evidence.

## Driving it with unbrowse-verify

Preconditions:

- A scratch node is healthy and `agent-browser` is built. A learn needs the browser and a live site.
- Pick one public page whose address query carries a search value, such as `https://hn.algolia.com/?q=rust`. Use a second value for the second sighting.
- No route exists yet for the goal. Check with `unbrowse-verify api GET '/v1/routes?q=hn'`.

- **Learn.** Run `unbrowse-verify do --url "https://hn.algolia.com/?q=rust" --goal "search Hacker News stories"`. `how` is `learned`, `route_id` is set, `answer` holds stories about the search value. Read the answer against the goal.
- **Warm call.** Run the same command again. `how` is `called`, `timings.wall_ms` is far below the learn, and `notes` holds no fallback. Check `unbrowse-verify logs --grep browser` shows no browser launch for this call.
- **New value.** Run `unbrowse-verify do --url "https://hn.algolia.com/?q=rust" --goal "search Hacker News stories" --inputs '{"q":"tauri"}'`. `how` is `called` and the answer changes from the first.
- **Fields.** Run it with `--fields title,url`. The answer holds those fields only. Then run with `--fields '*'` and see the whole answer. `result.fields.more` lists the paths left out.
- **List.** Run `unbrowse-verify api GET '/v1/routes?q=hn'`. The route appears with its `id` and inputs. A route taught by the owner's own browsing shows its input with `default: null`.
- **Call by id.** Run `unbrowse-verify api POST /v1/routes/<id>/call --body '{"inputs":{"q":"rust"}}'`. The answer matches a warm `do`.
- **Missing input.** Run the same call with `--body '{"inputs":{}}'`. The reply is a refusal naming the missing input, with a nonzero status.
- **Inspect.** Run `unbrowse-verify api GET /v1/routes/<id>/inspect`. Steps, fields (with class and source) and where scripts and producers run are shown.
- **Judge wrong, then relearn.** Run `unbrowse-verify api POST /v1/routes/<id>/judge --body '{"verdict":"wrong","url":"https://hn.algolia.com/?q=rust","why":"verification check"}'`. Then run the learn command again. `how` is `learned`, not `called`.
- **Judge right.** Run `unbrowse-verify api POST /v1/routes/<id>/judge --body '{"verdict":"right","fields":["title"]}'`. A later `do` returns that field by default.
- **Walk and pick.** Run `unbrowse-verify api POST /v1/walk --body '{"url":"https://hn.algolia.com/?q=rust","goal":"search Hacker News stories"}'`. Candidates have `index`, `method`, `host`, `path`, `status`, `bytes` and `keys`. Repeat with `"pick":<index>` to keep one.
- **Observe.** After a `how: browse`, run `unbrowse-verify api POST /v1/observe --body '{"site":"<site>"}'`. Elements show a ref, role, name and state.
- **Browse.** Run `unbrowse-verify api POST /v1/browse --body '{"do":["snapshot","-i"],"site":"<site>"}'`. A snapshot with refs like `@e4` is returned.
- **Link preview.** Run `unbrowse-verify api GET '/v1/open?q=unbrowse://example.com'`. Routes are listed, nothing is called or paid.
- **Disk.** Read `/tmp/ubv-17810/home/node/routes/<id>.json` and confirm the route's id matches. Use `unbrowse-verify owner routes` as the second view.

## Gotchas

- `ok: true` means the site answered, not that it answered the goal. Check the data against what the page shows. An empty list, suggestions in place of results or another item is a wrong answer.
- A warm call with `browser: true` or a fallback in `notes` is a defect. The bank's browserless finding fails a call that needed the browser, whatever it answered.
- A route answers its own page or call address, varying only at inputs. Another item, host or query key learns afresh. Never accept another page's data.
- The scratch node is headless and its guard refuses a headed window and a click that would pass a challenge. A site that needs a window, a captcha or the owner fails. The honest outcome is a failure with the reason (`how: browse` or an error), never a weakened journey. `challenge` may be reachable only to `look`.
- `how: network` needs a peer and a paid fetch. The scratch node has the peer network off, so it cannot be proven. Report it as not proven.
- `ask_owner` inside `browse` hands the page to the owner and waits up to 5 minutes. No owner is there. Do not call it.
- A write route changes the site. Never call a route that posts, books, buys or sends. Read `result.retry` if a call reports a failed write.
- A route that needs page code run in the sandbox needs the runtime from `unbrowse-verify runtime`. With none, the learn says why and the call falls to the browser or fails. That is a finding, not a pass.
- A learn takes tens of seconds. Past `wait_ms` the reply is `still_working`; pass its `ask` to collect the answer.
- Judging a route `wrong` sets it aside. Re-learn before the next recipe.
- The route file path depends on the scratch home layout. If it is not there, report the path you tried.
