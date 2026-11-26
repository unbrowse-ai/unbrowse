# unbrowse

Unbrowse on your machine: the node, the agent skill, and the Python client for the node. Say what you want
from a website and get the site's own answer back. The client has no browser on the calling side and no dependencies.
Python 3.9+.

A **route** is a website's own API call, learned once by the node's browser and replayed after that as plain HTTP.
The node keeps the routes, the logins and, once something needs it, the browser; the client is how an agent or a
script talks to it.

```bash
pip install unbrowse
unbrowse app          # opens the window, which starts the node
unbrowse start        # or runs the node without the window
unbrowse skill        # puts the agent skill in ~/.claude/skills/unbrowse
```

On macOS, Linux and Windows the wheel for the machine carries the window, the node and `unb` (on a Mac as
Unbrowse.app); `unbrowse do …`, `unbrowse browse …` and the rest are `unb`'s commands. Elsewhere it is the client alone.
No wheel brings the browser: see below.

## Start with no browser

The install brings no browser and downloads no Chrome. The node serves search, calls, whoami and its owner's commands
without one, and `Unbrowse.start()` starts it for you when none is running:

```python
from unbrowse import BrowserMissingError, Unbrowse

with Unbrowse.start() as node:  # starts unbrowse-node with no window, waits, reads an agent token; stops it at the end
    print(node.capabilities())  # Capabilities(browser='missing', fetches_browser=True, browser_option=True)
    routes = node.search("hn.algolia.com")  # other nodes' routes too, with their fee
    if routes:
        print(node.call(routes[0].id, {"q": "rust"}).data)  # a plain HTTP call: no browser
    try:
        node.do("list new arrivals", url="https://shop.example/new", browser="never")
    except BrowserMissingError as e:
        print(e.missing, e.install)  # ['program', 'chromium'] unbrowse browser install
```

`Unbrowse.start(home=, port=, program=, token=, ready_timeout=, env=, output=)` finds the `unbrowse-node` the wheel
brought (or `UNBROWSE_BIN`'s, or `program`), uses a node that already answers instead of starting a second, and says
how to install one when there's none. `close()` (or leaving the `with`) stops a node it started and leaves one that was
running. `Unbrowse(auto_start=True)` does the same on the first request. Either client brings the node back when it
goes: one it started and that died, before the next request; one another client stopped, after the request that found
it gone fails.

The browser is an add-on, needed only to learn a page (`do` with a `url` no route does yet) or to drive one by hand.
The node fetches it the first time a goal needs it, unless its owner turned that off: the browser program from this
release, checked against its signature, and Chrome for Testing when there's no Chromium on the machine. Or get it now:

```bash
unbrowse browser install   # the browser program, and Chrome for Testing when there's no Chromium
unbrowse browser status    # present, missing or installing, and what it lacks
unbrowse browser remove    # the program the node installed (--chromium: Chrome for Testing too)
unbrowse browser fetch off # never fetch it by itself: a goal that needs it raises BrowserMissingError
```

## Connect

The node's owner makes a key for each agent with `unbrowse agent new <name>`, or in the Unbrowse app (Agents, Add agent, shown once Settings has Show advanced screens on). Its setup carries the
node's address and the agent's token:

```bash
export UNBROWSE_NODE=http://127.0.0.1:7788
export UNBROWSE_AGENT_TOKEN="$(unbrowse agent token)"
```

```python
from unbrowse import Unbrowse  # the same class as UnbrowseNode

node = Unbrowse()  # UNBROWSE_AGENT_TOKEN, UNBROWSE_NODE
print(node.whoami())   # Whoami(agent=..., address=..., node=...)
```

`UnbrowseNode(token=None, base_url=None, timeout=330)`: `token` defaults to `UNBROWSE_AGENT_TOKEN`; `base_url` to
`UNBROWSE_NODE`, then `http://127.0.0.1:7788`; `timeout` is in seconds (`do` may walk a page, which can take a
minute). The client is synchronous; in async code, wrap calls in `asyncio.to_thread`.

The token never goes over the wire. Each request is signed with it: the request names the token by its key and carries
an HMAC-SHA256 keyed by the token over the method, the host and port it is sent to, the path with its query, the body's SHA-256, the time and a fresh
nonce, which the node takes once. The node signs its answer over the status, the body's SHA-256 and the nonce (and each
event of the owner's stream with its place in it), and the client uses only an answer the node signed. A process that
took the node's address, or relays it, gets the one request it relayed and nothing it can use again, and can't hand the
client an answer of its own: an unsigned or wrongly signed answer is a `NodeConnectionError`. Before each request the
client also asks what listens at `base_url` to prove it is the node the token is for (`GET /v1/node/proof`, with a fresh
challenge and the token's key): a listener that took the port and can't reach the node gets nothing of what a request
says. The proof alone doesn't keep the token safe (a relay passes it); the signing does.

## Say what you want

```python
r = node.do("search Hacker News stories", url="https://hn.algolia.com/?q=rust")

if r.how == "browse":
    pass  # The page needs clicks or typing: it's open in the node's browser. See "Drive the browser by hand".
else:
    print(r.result.data)  # the site's own JSON

# The same goal again, with a new value: no browser this time.
node.do("search Hacker News stories", inputs={"q": "tauri"})
```

`do(goal, url=None, inputs=None, browser=None)` takes the fastest way there is. `browser` says whether it may use the
node's browser: `"auto"` (the default: when the goal needs it, fetched first if the node lacks it and its owner lets
it), `"if_present"` (only a browser the node has already) or `"never"` (only a route, another contributor's route or a
plain request). A goal that needs a browser it can't use raises `BrowserMissingError`. A node from before the option
can't keep a call off its browser, so `"never"` raises `unsupported` there before anything is sent.

| `how` | What the node did |
|---|---|
| `"called"` | A route already does this goal. It called it; `result` is the call's (tens to hundreds of milliseconds). |
| `"network"` | Another contributor's route for the page's site does it. The node fetched it, paid its fee itself (up to the owner's per-fetch maximum) and ran it here; `entry` says whose. |
| `"learned"` | No route did. Its browser walked `url` once, kept the call that answers the goal as a route, and called it. `picked_by` says how it chose. |
| `"browse"` | Loading the page doesn't answer the goal; it needs clicks or typing. The page is open in the node's browser: `site`, a snapshot in `page`, and `why`. |

A route does a goal when what it does says the same words, in any order and case: keep using the words you started
with. Put what you'd search for in the url's query (`?q=rust`): the value becomes the route's input, and `inputs`
win over it. When routes on two sites do the goal, `do` raises `conflict`: pass `url` to say which.

A read route that fails, even after the node walks its page again, is learned afresh from `url`, and `route_failed`
names the route that broke. A write that fails is answered as it failed, never tried another way.

`search(query)` and `call(route_id, inputs)` are there when you already hold a route id. `search` returns this
node's routes first; when it has none, routes other nodes serve on the network, marked `remote=True` with a `fee`
in USDC.

### Writes and retries

A route with `write=True` changes something on the site: it posts, books, buys or sends. Ask before calling one.

A call that doesn't pass returns `ok=False` rather than raising, because what you do next depends on what reached
the site. The node never sends a failed write twice; `retry` tells you whether you may:

| `retry` | Meaning | Do |
|---|---|---|
| `"as_is"` | Nothing that changes the site was sent | Run it again as it was |
| `"check_first"` | The site may hold the write (`possible_commit=True`) | Look at the site before running it again |
| `"never"` | The write landed | Don't send it again |

### Payments

Nothing waits for the owner, and there is nothing to pass. Another contributor's route (`remote=True`) costs its fetch
fee in USDC, which the node pays by itself, once, up to the owner's per-fetch maximum; later calls run the kept copy
free. A route whose fee is over the maximum is skipped by `do` (`network_skipped` on the answer says which and why),
marked `over_max` in `search`, and refused by `call` (`payment_required`, naming both numbers).

```python
r = node.do("search flights", url="https://example-air.com/?from=SIN")
if r.how == "network":
    print(r.entry.fee, r.result.paid_usdc)  # paid by the node, once
elif r.network_skipped:
    print(r.network_skipped.why)
```

A listed or network route charges its fee only when the call passes (`paid_usdc` on the result, in USDC; `paid_unb` is the same amount under its old name). `pays_usd=` and
`pays=` from older code are still accepted, ignored and warned about (`DeprecationWarning`). The owner's per-fetch
maximum is set on the node (`unbrowse max-fetch 0.1`, or the window's Settings); this package has no owner client.

## Drive the browser by hand

When `do` answers `how == "browse"` (a login, a form, a message), drive the node's browser. Use it instead of any
other browser: every step is recorded, and the node learns routes from what you do. Each reply names them in
`learned`; from then on, `do` with the same goal calls the route instead.

```python
with node.browser(goal="send a message") as b:  # or node.browser(site=r.site) after do; closes on exit
    opened = b.open("https://chat.example.com/inbox")
    if opened.route_for_goal:
        # A route already does this: skip the clicking.
        node.call(opened.route_for_goal.route_id, {"text": "on my way"})
    else:
        page = b.snapshot(interactive=True)  # page.output: elements with refs like @e4
        b.fill("@e4", "on my way")
        sent = b.click("@e5")
        print(sent.learned)  # [LearnedRoute(route_id=..., what='send a message', inputs=['text'], write=True)]
```

Pages run in the site's own profile on the node, so logins hold between steps and between runs. The browser runs
headless; a window appears in the Unbrowse app only when a check needs a person.

| Method | Command |
|---|---|
| `open(url, goal=None)` | `open <url>` (a full `http(s)` URL) |
| `snapshot(interactive=, compact=, depth=, selector=)` | `snapshot -i -c -d <n> -s <sel>` |
| `click(t)`, `dblclick(t)`, `hover(t)`, `focus(t)` | same names |
| `fill(t, text)`, `type(t, text)`, `press(key)` | `fill` clears first; `type` keeps what's there |
| `select(t, value)`, `check(t)`, `uncheck(t)` | same names |
| `scroll(direction, px=None, selector=None)`, `scroll_into_view(t)` | `scroll`, `scrollintoview` |
| `upload(t, *files)` | file paths on the node's machine |
| `get(what, t=None)`, `attr(t, name)`, `is_(state, t)` | `get text\|html\|value\|title\|url\|count\|box\|styles`, `get attr`, `is visible\|enabled\|checked` |
| `find(by, value, action, action_value=None, name=None, exact=False)` | `find role button click --name Submit` |
| `wait(target=None, text=, url=, load=, fn=, timeout_ms=)` | `wait`: a selector, a time in ms, or one condition |
| `back()`, `forward()`, `reload()`, `eval(js)` | same names |
| `screenshot(path=None, full=False, annotate=False)` | saved on the node's machine; `output` says where |
| `ask_owner(why, timeout_s=None)` | `ask_owner`: the owner does it on the page in the Unbrowse app (sign in, a code, a check); waits until they give it back and `owner` says `done`, `declined` or `no_answer` |
| `run(*args)` | any command the node's browser takes, word by word |
| `close()` | close the site's browser |

`t` is a ref from `snapshot()` (`@e3`) or a CSS selector. Every method returns a `BrowseReply`
(`site`, `output`, `learned`, `route_for_goal`, `note`, and from `ask_owner`, `owner` and `url`). What the owner
types never comes back. The `Browser` also keeps `site`, `goal`, every route it
has `learned`, and the latest `route_for_goal`.

The node takes page-driving commands only. It refuses flags that would pick another browser, profile or session.

Each client browses in its own session (`node.session`, drawn fresh unless you pass `session=`): its own tab in a
site's browser on the node, so two agents on the same site at once each read and drive their own page. Tabs share the
site's profile, so a login holds across them.

## Logins

```python
node.logins()  # [Login(ref='vault:example.com:me', site='example.com')]

with node.browser(goal="sign in") as b:
    b.open("https://example.com/login")
    b.fill("@e6", "me")
    b.fill("@e8", "vault:example.com:me")       # the node types the password itself
    b.click("@e4")
    # b.learned: a sign-in route whose password input is "vault:example.com:me"
```

Saved logins come back as references; the values never leave the node. Fill one into a page with `fill(target,
"vault:<site>:<account>")`: the node types it only into a page on the login's own site, and what the browser says
back (a field's value, a script's answer) shows the reference, never the password. `vault:new:<site>:<account>`
makes a login with a fresh derived password, for signing up.

A route learned from that sign-in keeps the reference as its secret input, so `do` and `call` sign in again from
the vault with no browser. You can pass a reference yourself for a route's secret input on the login's own site;
any other input refuses it (`forbidden`).

## Agent frameworks

An agent built on LangChain or the OpenAI Agents SDK gets the node's tools as its framework's own tool objects. Each has
the MCP server's name, description and input schema, so a framework agent sees what an MCP client sees.
`unbrowse_tools(node=None, include=None)` gives `unbrowse_do`, `unbrowse_search`, `unbrowse_call`, `unbrowse_logins` and
`unbrowse_whoami`; `include` picks others, such as `[*DEFAULT_TOOLS, "browse"]` for pages that need clicks or typing.
`node` defaults to `Unbrowse()`.

| Framework | Module | Gives | Install |
|---|---|---|---|
| LangChain | `unbrowse.adapters.langchain` | `StructuredTool`s for `create_agent` or `bind_tools` | `pip install "unbrowse[langchain]"` |
| OpenAI Agents | `unbrowse.adapters.openai_agents` | `FunctionTool`s for `Agent(tools=...)` | `pip install "unbrowse[openai-agents]"` |

The frameworks are optional extras, so `pip install unbrowse` installs neither. They need Python 3.10 or later. A tool
answers what the MCP server would, as JSON text: the node's answer, or `{"error", "code"}` when a call fails, so the
model reads what went wrong and the run doesn't crash. A node without a browser answers `"code": "browser_missing"` with
a hint; it can still call the routes it has.

```python
# pip install "unbrowse[langchain]" langchain langchain-openai
from langchain.agents import create_agent
from langchain_openai import ChatOpenAI
from unbrowse.adapters.langchain import unbrowse_tools

agent = create_agent(ChatOpenAI(model="gpt-5-mini"), tools=unbrowse_tools())
question = "What are the top Hacker News stories about Rust? https://hn.algolia.com/api/v1/search?query=rust answers it."
print(agent.invoke({"messages": [{"role": "user", "content": question}]})["messages"][-1].content)
```

```python
# pip install "unbrowse[openai-agents]"
from agents import Agent, Runner
from unbrowse.adapters.openai_agents import unbrowse_tools

agent = Agent(name="HN reader", instructions="Answer from websites with Unbrowse.", tools=unbrowse_tools())
print(Runner.run_sync(agent, "What are the top Hacker News stories about Rust?").final_output)
```

[`unbrowse-sdk/examples/`](../examples) has each one ready to run; `UNBROWSE_STUB_MODEL=1` runs it with a scripted model
that calls no model API.

## MCP

The node is also an MCP server with tools `unbrowse_do`, `unbrowse_browse`, `unbrowse_search` and `unbrowse_call`.
`mcp_server()` returns the config agent frameworks take: `unbrowse mcp` over stdio (`unb mcp`), which signs each message
with the token, so the framework never sends the token over a transport of its own:

```python
node.mcp_server()  # {"type": "stdio", "command": "unbrowse", "args": ["mcp"], "env": {"UNBROWSE_NODE": "http://127.0.0.1:7788", "UNBROWSE_AGENT_TOKEN": "…"}}
```

It carries the token in the bridge's environment: keep it out of logs. (`repr(node)` never shows it.)

## The owner

`UnbrowseOwner` is the node as its owner sees it: everything the Unbrowse window does, over `POST /owner/{command}`.
Routes, agent keys, the vault, settings (the per-fetch maximum among them), the wallet and the chain, and the node's
live events.

```python
from unbrowse import UnbrowseOwner
from unbrowse.local import owner_token

owner = UnbrowseOwner(token=owner_token)  # the function: each request reads the token; or UNBROWSE_OWNER_TOKEN

new = owner.agent_create("claude", cap_usdc=5, days=30)  # spends up to 5 USDC a day
# new["setup"] names the agent, never its token; new["token"] is the token, on this answer alone: hand it to the agent, then let it go.
owner.set_max_fetch(0.1)  # the most the node pays to fetch one route, in USDC
m = owner.money()  # one balance in dollars: m["balance"], m["needed_to_start"], each agent's daily limit

for name, payload in owner.events():  # ("open", None) first; ends when the node restarts
    print(name, payload)
```

The owner's token can do anything on the node, the vault included. The node writes a fresh one to
`~/.unbrowse/owner.token` (mode 0600) every time it starts, so pass `owner_token` itself, not `owner_token()`: a token
held as text is refused from the next start, and `events()` called again after a restart raises `AuthenticationError`.

There is one method per owner command, named as the node names it (`agents_list()`, `vault_add(site, account, kind,
password=None)`, `wallet()`, ...), generated from the node's `agent-api.json`: every command the node answers is here,
with its arguments in order, required ones first. An optional argument left as None isn't sent. Records come back as
the node's own snake-case dicts, typed as TypedDicts in `unbrowse.wire`, so a record goes back as it came:
`owner.save_settings(dict(owner.settings(), paused=True))`. On top: `command(name, args)` (any command by name),
`address()`, `set_max_fetch(usdc)`, `frame(walk)` (a walk's latest picture, as JPEG bytes) and `events()`.

Route coins: `coin_holdings()` reads what the wallet holds, per coin (its entry, unstaked coins, each staked lot by exit
delay, what its stake earned to claim, its price). `coin_launch(entry, unb)` launches the coin of an entry the wallet is
credited with; `coin_buy(entry, unb)` and `coin_sell(entry, coins)` trade it; `coin_stake(entry, coins, delay=None)`
stakes coins in the lot of that exit delay (24 hours when left out), `coin_unstake(entry, delay, coins)` asks them back
and `coin_withdraw(entry, delay)` takes them once ready; `coin_claim(entry)` claims what a stake earned.
`coin_fetch_delay(delay=None)` and `coin_dev_buy(bps=None)` read or set the exit delay fetches stake with and the share
of the wallet's UNB, in basis points, each newly credited entry's coin is launched with and staked (100, 1%, by default;
0 turns it off); `coin_rank(entries)` reads entries' ranks. `earnings()` says what
the wallet earned from staking and as a contributor, and `collect_earnings()` takes it all; nothing vests.

Bounties (spec ch. 8): `bounty_post(site, amount, limit=None, days=None)` posts UNB from the wallet for a site, with the
most it pays a coin (`limit`, UNB; none buys at market), open for `days` (30 when left out). `bounty_confirm(id, entry)`
confirms it for an entry of the site once your own paid call on that entry passed and was claimed, which launches or
buys the entry's coin; after the deadline `bounty_settle(id)` fixes what others' use releases, `bounty_release(id,
entry)` releases an entry's share of it, and `bounty_refund(id)` takes back what is yours. `bounty_list(mine=None)` and
`bounty_show(id)` read the site, amount, limit, deadline, state and what is `refundable`. The node signs each write with
its own key. `bounty_auto(on=None)` reads or sets whether the node takes these steps for you, off by default.

```python
done = owner.bounty_post("shop.example", 2000, limit=0.5, days=7)  # {"tx": ..., "id": ...}
owner.bounty_show(done["id"])["state"]  # "open"
```

An agent asked about a bounty (`result.bounties`, beside a passed call) answers with
`node.answer_bounty(route_id, "right", bounty=..., entry=...)`; the node confirms only on your yes.

`unbrowse.local` reads what the node keeps on this machine: `node_home()` (`UNBROWSE_HOME`, else `~/.unbrowse`),
`owner_token()`, `node_port()`, `node_address()`.

## Errors

A request the node refuses raises an `UnbrowseError` with `status`, `code`, `body` and the node's reason as `message`.
Each kind of failure is its own subclass, so catch the ones you handle and let the rest through:

```python
from unbrowse import Unbrowse, AuthenticationError, NodeConnectionError

try:
    Unbrowse().do("search Hacker News stories", url="https://hn.algolia.com/?q=rust")
except AuthenticationError:
    print("make an agent key: unbrowse agent new <name>")
except NodeConnectionError:
    print("start the node: open the Unbrowse app")
```

`NodeTimeoutError` is also a `NodeConnectionError`; the `Node` prefix keeps them from hiding Python's own
`ConnectionError` and `TimeoutError`. Every class is an `UnbrowseError`, and `code` reads as before.

| Class | `code` | `status` | Why |
|---|---|---|---|
| `BadRequestError` | `bad_request` | 400 | The node couldn't run the call with these inputs, or a field is missing |
| `AuthenticationError` | `unauthorized` | 401 | No token, or a key that's unknown, revoked or expired |
| `PaymentRequiredError` | `payment_required` | 402 | A paid route this key isn't authorised for, or past its cap |
| `PermissionDeniedError` | `forbidden` | 403 | The owner declined (or didn't answer in five minutes), turned learning off, or a vault login can't go where it was sent |
| `NotFoundError` | `not_found` | 404 | No such route; or nothing does the goal yet and `do` had no `url` |
| `ConflictError` | `conflict` | 409 | Routes on more than one site do the goal: pass `url` to say which |
| `UnprocessableEntityError` | `unprocessable` | 422 | The browser or the learner couldn't do it; `message` says why |
| `BrowserMissingError` (an `UnprocessableEntityError`) | `browser_missing` | 422 | The goal needs the node's browser and the node lacks it (or the call said `browser="never"`): `missing` (`program`, `chromium`), `install` (`unbrowse browser install`), `browser` (`missing`, `installing`) and `fetches` say what and how |
| `NodeUnavailableError` | `unavailable` | 503 | The node is paused by its owner, or waiting for Keychain access |
| `NodeConnectionError` | `unreachable` | 0 | The node isn't running at `base_url` |
| `NodeTimeoutError` | `timeout` | 0 | No answer within `timeout` |

## HTTP

Each method is one request to the node's agent API, signed with the token (above).

| Method | Route |
|---|---|
| `whoami()` | `GET /v1/whoami` |
| `search(query)` | `GET /v1/routes?q=` |
| `do(goal, url=None, inputs=None, pays_usd=None, pays=False)` | `POST /v1/do` |
| `call(id, inputs, pays_usd=None, pays=False)` | `POST /v1/routes/:id/call` |
| `browser().*`, `browse(args, site, goal)` | `POST /v1/browse` (`{"do": [...], "site", "goal", "session"}`) |
| `open(link)` | `GET /v1/open?q=` (what an `unbrowse://` link names; calls and pays nothing) |
| `logins()`, `cards()` | `GET /v1/logins` (`logins`, `cards`: references only) |
| `judge(route_id, verdict, url=None, why=None, what=None, fields=None)` | `POST /v1/routes/{id}/judge` (what you saw in a route's answer: wrong for a page, its real name, its default fields) |
| `report(kind, summary, expected, got, route_id=None, goal=None, url=None, tool=None, error=None)` | `POST /v1/report` (scrubbed by the node, filed as a public GitHub issue) |
| `mcp_server()` | `GET /v1/node/proof`; the bridge it names then sends each message to `POST /mcp` |
| `UnbrowseOwner` methods | `POST /owner/:command`, `GET /owner/events`, `GET /owner/frame?walk=` (owner's token) |

## Develop

```bash
python3 -m unittest discover -s tests   # against fake nodes that answer in the API's shapes
pip install -e ".[langchain,openai-agents]"   # Python 3.10+: the adapters' tests skip a framework that isn't installed
```

`src/unbrowse/_generated.py` and `src/unbrowse/adapters/_tools.py` are written from the node's `agent-api.json` by
`../codegen/generate.py`: never edit them by hand, rerun the generator.

## Licence

[Apache-2.0](../../LICENSE).
