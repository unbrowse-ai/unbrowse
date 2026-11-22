# SDK

`unbrowse-sdk` is the client for the local node, in TypeScript (`unbrowse` on npm) and Python (`unbrowse` on PyPI). It has no browser on the calling side and no dependencies. A script says what it wants with `do`, calls a route by id, searches, drives the node's browser, reads logins by reference, judges a route and reports a problem. `UnbrowseOwner` is the node as its owner sees it, over `/owner/{command}`. The TypeScript package also gives agent-framework tool adapters. Each request is signed with the agent's token and the node's reply is checked.

## Sub-features

- `sdk-whoami` reads the agent's identity.
- `sdk-do` takes `how` of `called`, `network`, `learned` or `browse`.
- `sdk-search-call` searches and calls by route id.
- `sdk-browser` drives the node's browser by hand (`open`, `snapshot`, `click`, `fill`, `ask_owner`, `close`).
- `sdk-logins-cards` reads references only.
- `sdk-judge-report` judges a route and reports a problem.
- `sdk-open` previews an `unbrowse://` link.
- `sdk-start` starts a node when none runs (`Unbrowse.start()`), and stops only one it started.
- `sdk-errors` raises a subclass per failure: `AuthenticationError`, `NotFoundError`, `ConflictError`, `BrowserMissingError`, `NodeConnectionError` and more.
- `sdk-owner` calls one method per owner command, named as the node names it.
- `sdk-adapters` gives `unbrowseTools` for `unbrowse/ai-sdk`, `unbrowse/langchain`, `unbrowse/mastra`, `unbrowse/openai-agents`.
- `sdk-manifest-parity` holds both SDKs to `unbrowse-node/agent-api.json`.

## How to get to it (user POV)

- TypeScript: `import { Unbrowse, UnbrowseOwner } from "unbrowse"`; `new Unbrowse()` or `Unbrowse.start()`; `unbrowse/local` for `ownerToken()`.
- Python: `from unbrowse import Unbrowse, UnbrowseOwner`; `Unbrowse()` or `Unbrowse.start()`; `unbrowse.local` for `owner_token()`.
- Environment: `UNBROWSE_NODE` and `UNBROWSE_AGENT_TOKEN`; the owner client reads the owner token from the node's home.
- Methods and routes: `whoami()` is `GET /v1/whoami`; `search(query)` is `GET /v1/routes?q=`; `do` is `POST /v1/do`; `call(id, inputs)` is `POST /v1/routes/{id}/call`; `browser().*` is `POST /v1/browse`; `open(link)` is `GET /v1/open?q=`; `logins()` and `cards()` are `GET /v1/logins`; `judge` and `report` are `POST /v1/routes/{id}/judge` and `POST /v1/report`.
- Tests: `npm test` in `unbrowse-sdk/typescript`; `python -m pytest` in `unbrowse-sdk/python`; `npm run gen:check` for the generated files.

## Driving it with unbrowse-verify

Preconditions:

- A scratch node is healthy on its port. Its agent token is in `/tmp/ubv-<port>/token`. Never print it.
- Python 3.9 or later. The TypeScript client needs its `dist` built from `unbrowse-sdk/typescript`; the harness does not build it.
- The wire is the contract. `unbrowse-verify api` proves each route the SDK sends to. The SDK itself runs from a short script.

- **Wire parity.** Run `unbrowse-verify api GET /v1/whoami`, `GET /v1/logins` and `GET '/v1/routes?q=hn'`. Each answers in the shape the SDK types describe.
- **Python whoami.** Run `UNBROWSE_NODE=http://127.0.0.1:17810 UNBROWSE_AGENT_TOKEN="$(cat /tmp/ubv-17810/token)" PYTHONPATH=unbrowse-sdk/python/src python3 -c "from unbrowse import Unbrowse; print(Unbrowse().whoami())"`. It prints the agent, address and node, the same as `api GET /v1/whoami`.
- **Python do.** In the same environment run `Unbrowse().do("search Hacker News stories", url="https://hn.algolia.com/?q=rust")`. `how` is `called` or `learned`. A second call with `inputs={"q":"tauri"}` is `called`.
- **Python error class.** With `UNBROWSE_AGENT_TOKEN=wrong` run `whoami()`. It raises `AuthenticationError` with code `unauthorized`.
- **Python connection error.** With `UNBROWSE_NODE=http://127.0.0.1:17999` (nothing listening) run `whoami()`. It raises `NodeConnectionError`.
- **Owner client.** Run `UNBROWSE_HOME=/tmp/ubv-17810/home/node PYTHONPATH=unbrowse-sdk/python/src python3 -c "from unbrowse import UnbrowseOwner; from unbrowse.local import owner_token; print(UnbrowseOwner(token=owner_token).settings())"`. Settings come back in the node's snake case. Compare with `unbrowse-verify owner settings`.
- **Manifest parity.** Run `python3 ../codegen/generate.py --check` from `unbrowse-sdk/typescript` (the same as `npm run gen:check`). It exits 0 when the generated clients match `agent-api.json`.
- **Offline suites.** Run `npm test` in `unbrowse-sdk/typescript` and `python -m pytest unbrowse-sdk/python/tests`. They run against fake nodes. Record that they build or write cache files in the checkout.

## Gotchas

- Do not point the SDK at port 7788. `Unbrowse.start()` and `autoStart` start a node when none answers, with the owner's home, unless `home` and `port` are given. Always set `UNBROWSE_NODE`.
- A test or script that starts a node with no `UNBROWSE_HOME` uses the owner's `~/.unbrowse`. Set it every time.
- The SDK needs a signed answer from the node. A listener that took the port gets nothing of the token. A bare `curl` cannot stand in for the SDK.
- The TypeScript live drive needs a build. If `dist` is missing, report the TypeScript journeys as not proven. The generate check and the offline suites still run.
- Argument names follow the API: `fields`, `inputs`, `browser` (`auto`, `if_present`, `never`). `browser: "never"` on a goal that needs a browser raises `BrowserMissingError` with `missing` and `install`.
- The Python README says in one place that the package has no owner client, and in another documents `UnbrowseOwner`. Check which one this checkout has, and report the stale line.
- `UnbrowseOwner` can do anything on the node, the vault included. Use it only against the scratch home. `vault_reveal`, `wallet_phrase` and `wallet_send` ask the owner and cannot be answered here.
- The framework adapters need their peer packages. Run them only with `UNBROWSE_STUB_MODEL=1` (the examples' scripted model), so no model API is called.
- A page in a browser cannot read the owner token. The proxy path is not driven here.
