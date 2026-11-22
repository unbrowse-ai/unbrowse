# unbrowse

Unbrowse on your machine: the node, the agent skill, and the TypeScript client for the node. Say what you
want from a website and get the site's own answer back, and run the node as its owner. The client has no browser on the
calling side and no dependencies: Node 20.3+, Bun, Deno, or any runtime with `fetch`.

A **route** is a website's own API call, learned once by the node's browser and replayed after that as plain HTTP.
The node keeps the routes, the logins and, once something needs it, the browser; the client is how an agent or a
script talks to it.

> This is the client for the **local node** (`http://127.0.0.1:7788`). For the hosted API at unbrowse.ai, use
> [`@unbrowse/sdk`](https://www.npmjs.com/package/@unbrowse/sdk).

**Install the app** (no Node or npm needed): [Mac](https://github.com/unbrowse-ai/unbrowse/releases/download/v13.21.0-installers.3/Unbrowse-13.21.0-installers.3-macos-arm64.dmg) · [Windows](https://github.com/unbrowse-ai/unbrowse/releases/download/v13.21.0-installers.3/Unbrowse-13.21.0-installers.3-windows-x64-setup.exe) ·
[Linux](https://github.com/unbrowse-ai/unbrowse/releases/download/v13.21.0-installers.3/unbrowse_13.21.0-installers.3_amd64.deb) · [Linux ARM](https://github.com/unbrowse-ai/unbrowse/releases/download/v13.21.0-installers.3/unbrowse_13.21.0-installers.3_arm64.deb). Every file with its SHA-256 is on [the release](https://github.com/unbrowse-ai/unbrowse/releases/tag/v13.21.0-installers.3); the guide is at
[unbrowse.ai/#install](https://unbrowse.ai/#install). The window starts the node (MCP at `http://127.0.0.1:7788/mcp`) and connects your
agents and a remote MCP address.

**Or with npm** (Node 20.3+):

```bash
npm install -g unbrowse
unbrowse app          # opens the window, which starts the node
unbrowse start        # or runs the node without the window
```

On macOS, Linux and Windows it brings the window, the node and `unb` (in the machine's own
package, `@unbrowse/darwin-arm64`, `@unbrowse/linux-x64`, `@unbrowse/win32-x64` and so on, which npm fetches only
there; on a Mac as Unbrowse.app), and a global install puts the agent skill in
`~/.claude/skills/unbrowse` (`unbrowse skill [dir]` puts it anywhere). `unbrowse do …`, `unbrowse browse …` and the rest are `unb`'s commands. `npm install unbrowse` in a
project gives you the client. No install brings the browser: see below.

## Start with no browser

The install brings no browser and downloads no Chrome. The node serves search, calls, whoami and its owner's commands
without one, and `Unbrowse.start()` starts it for you when none is running:

```ts
import { Unbrowse, BrowserMissingError } from "unbrowse";

const node = await Unbrowse.start(); // starts unbrowse-node with no window, waits, reads an agent token
console.log(await node.capabilities()); // { browser: "missing", fetchesBrowser: true, browserOption: true }
const [route] = await node.search("hn.algolia.com"); // other nodes' routes too, with their fee
if (route) console.log((await node.call(route.id, { q: "rust" })).data); // a plain HTTP call: no browser
try {
  await node.do("list new arrivals", { url: "https://shop.example/new", browser: "never" });
} catch (e) {
  if (e instanceof BrowserMissingError) console.log(e.missing, e.install); // ["program", "chromium"] "unbrowse browser install"
}
await node.close(); // stops the node it started; one that was running already keeps running
```

`Unbrowse.start({ home, port, program, token, readyTimeoutMs, env, output })` finds the `unbrowse-node` the package
brought (or `UNBROWSE_BIN`'s, or `program`), uses a node that already answers instead of starting a second, and says
how to install one when there's none. `new Unbrowse({ autoStart: true })` does the same on the first request. Either
client brings the node back when it goes: one it started and that died, before the next request; one another client
stopped, after the request that found it gone fails. Node.js
only; a page in a browser talks to a node that's running.

The browser is an add-on, needed only to learn a page (`do` with a `url` no route does yet) or to drive one by hand.
The node fetches it the first time a goal needs it, unless its owner turned that off: the browser program from this
release, checked against its signature, and Chrome for Testing when there's no Chromium on the machine. Or get it now:

```bash
unbrowse browser install   # the browser program, and Chrome for Testing when there's no Chromium
unbrowse browser status    # present, missing or installing, and what it lacks
unbrowse browser remove    # the program the node installed (--chromium: Chrome for Testing too)
unbrowse browser fetch off # never fetch it by itself: a goal that needs it throws BrowserMissingError
```

## Connect

The node's owner makes a key for each agent in the Unbrowse app (Wallet, New agent key). Its setup carries the
node's address and the agent's token:

```bash
export UNBROWSE_NODE=http://127.0.0.1:7788
export UNBROWSE_AGENT_TOKEN="$(unbrowse agent token)"
```

```ts
import { Unbrowse } from "unbrowse"; // also the default export; the same class as `UnbrowseNode`

const node = new Unbrowse(); // UNBROWSE_AGENT_TOKEN, UNBROWSE_NODE
console.log(await node.whoami()); // { agent, address, node }
```

`new UnbrowseNode({ token, baseUrl, timeoutMs, fetch })`: `token` defaults to `UNBROWSE_AGENT_TOKEN`; `baseUrl` to
`UNBROWSE_NODE`, then `http://127.0.0.1:7788`; `timeoutMs` to 330 000 (`do` may walk a page, which can take a
minute).

The token never goes over the wire. Each request is signed with it: the request names the token by its key and carries
an HMAC-SHA256 keyed by the token over the method, the host and port it is sent to, the path with its query, the body's SHA-256, the time and a fresh
nonce, which the node takes once. The node signs its answer over the status, the body's SHA-256 and the nonce (and each
event of the owner's stream with its place in it), and the client uses only an answer the node signed. A process that
took the node's address, or relays it, gets the one request it relayed and nothing it can use again, and can't hand the
client an answer of its own: an unsigned or wrongly signed answer is a `NodeConnectionError`. Before each request the
client also asks what listens at `baseUrl` to prove it is the node the token is for (`GET /v1/node/proof`, with a fresh
challenge and the token's key): a listener that took the port and can't reach the node gets nothing of what a request
says. The proof alone doesn't keep the token safe (a relay passes it); the signing does.

## Say what you want

```ts
const r = await node.do("search Hacker News stories", { url: "https://hn.algolia.com/?q=rust" });

if (r.how === "browse") {
  // The page needs clicks or typing: it's open in the node's browser. See "Drive the browser by hand".
} else {
  console.log(r.result.data); // the site's own JSON
}

// The same goal again, with a new value: no browser this time.
await node.do("search Hacker News stories", { inputs: { q: "tauri" } });
```

`do(goal, { url?, inputs?, browser? })` takes the fastest way there is. `browser` says whether it may use the node's
browser: `"auto"` (the default: when the goal needs it, fetched first if the node lacks it and its owner lets it),
`"if_present"` (only a browser the node has already) or `"never"` (only a route, another contributor's route or a
plain request). A goal that needs a browser it can't use throws `BrowserMissingError`. A node from before the option
can't keep a call off its browser, so `"never"` throws `unsupported` there before anything is sent.

| `how` | What the node did |
|---|---|
| `called` | A route already does this goal. It called it; `result` is the call's (tens to hundreds of milliseconds). |
| `network` | Another contributor's route for the page's site does it. The node fetched it, paid its fee itself (up to the owner's per-fetch maximum) and ran it here; `entry` says whose. |
| `learned` | No route did. Its browser walked `url` once, kept the call that answers the goal as a route, and called it. `pickedBy` says how it chose. |
| `browse` | Loading the page doesn't answer the goal; it needs clicks or typing. The page is open in the node's browser: `site`, a snapshot in `page`, and `why`. |

A route does a goal when what it does says the same words, in any order and case: keep using the words you started
with. Put what you'd search for in the url's query (`?q=rust`): the value becomes the route's input, and `inputs`
win over it. When routes on two sites do the goal, `do` throws `conflict`: pass `url` to say which.

A read route that fails, even after the node walks its page again, is learned afresh from `url`, and `routeFailed`
names the route that broke. A write that fails is answered as it failed, never tried another way.

`search(query)` and `call(routeId, inputs)` are there when you already hold a route id. `search` returns this node's
routes first; when it has none, routes other nodes serve on the network, marked `remote: true` with a `fee` in USDC.

### Writes and retries

A route with `write: true` changes something on the site: it posts, books, buys or sends. Ask before calling one.

A call that doesn't pass resolves with `ok: false` rather than throwing, because what you do next depends on what
reached the site. The node never sends a failed write twice; `retry` tells you whether you may:

| `retry` | Meaning | Do |
|---|---|---|
| `as_is` | Nothing that changes the site was sent | Run it again as it was |
| `check_first` | The site may hold the write (`possibleCommit: true`) | Look at the site before running it again |
| `never` | The write landed | Don't send it again |

```ts
const r = await node.call("post-listing", { title: "Desk", price: "40" });
if (!r.ok && r.retry === "as_is") await node.call("post-listing", { title: "Desk", price: "40" });
```

### Payments

Nothing waits for the owner, and there is nothing to pass. Another contributor's route (`remote: true`) costs its fetch
fee in USDC, which the node pays by itself, once, up to the owner's per-fetch maximum; later calls run the kept copy
free. A route whose fee is over the maximum is skipped by `do` (`networkSkipped` on the answer says which and why),
marked `overMax` in `search`, and refused by `call` (`payment_required`, naming both numbers).

```ts
const r = await node.do("search flights", { url: "https://example-air.com/?from=SIN" });
if (r.how === "network") console.log(r.entry.fee, r.result.paidUsdc); // paid by the node, once
if (r.how !== "network" && r.networkSkipped) console.log(r.networkSkipped.why);
```

A listed or network route charges its fee only when the call passes (`paidUsdc` on the result, in USDC; `paidUnb` is the same amount under its old, deprecated name). `paysUsd` and `pays`
from older code are still accepted by the types and ignored.

## Drive the browser by hand

When `do` answers `how: "browse"` (a login, a form, a message), drive the node's browser. Use it instead of any other
browser: every step is recorded, and the node learns routes from what you do. Each reply names them in `learned`;
from then on, `do` with the same goal calls the route instead.

```ts
const b = node.browser({ goal: "send a message" }); // or node.browser({ site: r.site }) after do

const opened = await b.open("https://chat.example.com/inbox");
if (opened.routeForGoal) {
  // A route already does this: skip the clicking.
  await node.call(opened.routeForGoal.routeId, { text: "on my way" });
} else {
  const page = await b.snapshot({ interactive: true }); // page.output: elements with refs like @e4
  await b.fill("@e4", "on my way");
  const sent = await b.click("@e5");
  console.log(sent.learned); // [{ routeId, what: "send a message", inputs: ["text"], write: true }]
  await b.close(); // the node learns the flow before the browser closes
}
```

Pages run in the site's own profile on the node, so logins hold between steps and between runs. The browser runs
headless; a window appears in the Unbrowse app only when a check needs a person.

| Method | Command |
|---|---|
| `open(url, { goal? })` | `open <url>` (a full `http(s)` URL) |
| `snapshot({ interactive?, compact?, depth?, selector? })` | `snapshot -i -c -d <n> -s <sel>` |
| `click(t)`, `dblclick(t)`, `hover(t)`, `focus(t)` | same names |
| `fill(t, text)`, `type(t, text)`, `press(key)` | `fill` clears first; `type` keeps what's there |
| `select(t, value)`, `check(t)`, `uncheck(t)` | same names |
| `scroll(dir, px?, { selector? })`, `scrollIntoView(t)` | `scroll`, `scrollintoview` |
| `upload(t, ...files)` | file paths on the node's machine |
| `get(what, t?)`, `attr(t, name)`, `is(state, t)` | `get text\|html\|value\|title\|url\|count\|box\|styles`, `get attr`, `is visible\|enabled\|checked` |
| `find(by, value, action, actionValue?, { name?, exact? })` | `find role button click --name Submit` |
| `wait(ms \| target \| { text \| url \| load \| fn, timeoutMs? })` | `wait` |
| `back()`, `forward()`, `reload()`, `eval(js)` | same names |
| `screenshot({ path?, full?, annotate? })` | saved on the node's machine; `output` says where |
| `askOwner(why, { timeoutS? })` | `ask_owner`: the owner does it on the page in the Unbrowse app (sign in, a code, a check); waits until they give it back and `owner` says `done`, `declined` or `no_answer` |
| `run(...args)` | any command the node's browser takes, word by word |
| `close()` | close the site's browser |

`t` is a ref from `snapshot()` (`@e3`) or a CSS selector. Every method returns a `BrowseReply`:
`{ site, output, learned, routeForGoal, note, owner, url }` (`owner` and `url` from `askOwner`; what the owner types
never comes back). The `Browser` also keeps `site`, `goal`, every route it has
`learned`, and the latest `routeForGoal`.

The node takes page-driving commands only. It refuses flags that would pick another browser, profile or session.

Each client browses in its own session (`node.session`, drawn fresh unless you pass `{ session }`): its own tab in a
site's browser on the node, so two agents on the same site at once each read and drive their own page. Tabs share the
site's profile, so a login holds across them.

## Logins

```ts
await node.logins(); // [{ ref: "vault:example.com:me", site: "example.com" }]

const b = node.browser({ goal: "sign in" });
await b.open("https://example.com/login");
await b.fill("@e6", "me");
await b.fill("@e8", "vault:example.com:me");      // the node types the password itself
await b.click("@e4");
// b.learned: a sign-in route whose password input is "vault:example.com:me"
```

Saved logins come back as references; the values never leave the node. Fill one into a page with `fill(target,
"vault:<site>:<account>")`: the node types it only into a page on the login's own site, and what the browser says
back (a field's value, a script's answer) shows the reference, never the password. `vault:new:<site>:<account>`
makes a login with a fresh derived password, for signing up.

A route learned from that sign-in keeps the reference as its secret input, so `do` and `call` sign in again from
the vault with no browser. You can pass a reference yourself for a route's secret input on the login's own site;
any other input refuses it (`forbidden`).

## Agent frameworks

An agent built on the Vercel AI SDK, LangChain, Mastra or the OpenAI Agents SDK gets the node's tools as its framework's
own tool objects. Each has the MCP server's name, description and input schema, so a framework agent sees what an MCP
client sees. Each adapter's `unbrowseTools(node?, { include? })` gives `unbrowse_do`, `unbrowse_search`,
`unbrowse_call`, `unbrowse_logins` and `unbrowse_whoami`; `include` picks others, such as `[...DEFAULT_TOOLS, "browse"]`
for pages that need clicks or typing. `node` defaults to `new Unbrowse()`.

| Framework | Import | Gives | Peer dependency |
|---|---|---|---|
| Vercel AI SDK | `unbrowse/ai-sdk` | a tool set for `generateText` and `streamText` | `ai` 5, 6 or 7 |
| LangChain | `unbrowse/langchain` | `DynamicStructuredTool[]` for `createAgent` or `bindTools` | `@langchain/core` 1 |
| Mastra | `unbrowse/mastra` | tools for `new Agent({ tools })` | `@mastra/core` 1 |
| OpenAI Agents | `unbrowse/openai-agents` | `FunctionTool[]` for `new Agent({ tools })` | `@openai/agents` 0.20 or later |
| Any other host | `unbrowse/tools` | `TOOLS` (every tool's name, description and input schema) and `runTool(node, spec, input)`, which answers what the MCP server would; the [integrations](../../integrations) build their tools from it | none |

The frameworks are optional peer dependencies, so `npm i unbrowse` installs none of them. A tool answers what the MCP
server would: the node's JSON, or `{ error, code }` when a call fails, so the model reads what went wrong and the run
doesn't crash. A node without a browser answers `code: "browser_missing"` with a hint; it can still call the routes it
has.

```ts
// npm i unbrowse ai @ai-sdk/openai
import { generateText, stepCountIs } from "ai";
import { openai } from "@ai-sdk/openai";
import { unbrowseTools } from "unbrowse/ai-sdk";

const { text } = await generateText({
  model: openai("gpt-5-mini"),
  tools: unbrowseTools(),
  stopWhen: stepCountIs(5),
  prompt: "What are the top Hacker News stories about Rust? https://hn.algolia.com/api/v1/search?query=rust answers it.",
});
console.log(text);
```

```ts
// npm i unbrowse langchain @langchain/core @langchain/openai
import { createAgent } from "langchain";
import { ChatOpenAI } from "@langchain/openai";
import { unbrowseTools } from "unbrowse/langchain";

const agent = createAgent({ model: new ChatOpenAI({ model: "gpt-5-mini" }), tools: unbrowseTools() });
const { messages } = await agent.invoke({ messages: [{ role: "user", content: "What are the top Hacker News stories about Rust?" }] });
console.log(messages.at(-1).content);
```

```ts
// npm i unbrowse @mastra/core
import { Agent } from "@mastra/core/agent";
import { unbrowseTools } from "unbrowse/mastra";

const agent = new Agent({ id: "hn", name: "HN reader", instructions: "Answer from websites with Unbrowse.", model: "openai/gpt-5-mini", tools: unbrowseTools() });
const { text } = await agent.generate("What are the top Hacker News stories about Rust?", { maxSteps: 5 });
console.log(text);
```

```ts
// npm i unbrowse @openai/agents
import { Agent, run } from "@openai/agents";
import { unbrowseTools } from "unbrowse/openai-agents";

const agent = new Agent({ name: "HN reader", instructions: "Answer from websites with Unbrowse.", tools: unbrowseTools() });
console.log((await run(agent, "What are the top Hacker News stories about Rust?")).finalOutput);
```

[`unbrowse-sdk/examples/`](../examples) has each one ready to run; `UNBROWSE_STUB_MODEL=1` runs it with a scripted model
that calls no model API.

## MCP

The node is also an MCP server with tools `unbrowse_do`, `unbrowse_browse`, `unbrowse_search` and `unbrowse_call`.
`mcpServer()` returns the config agent frameworks take: `unbrowse mcp` over stdio, which signs each message with the
token, so the framework never sends the token over a transport of its own:

```ts
await node.mcpServer(); // { type: "stdio", command: "unbrowse", args: ["mcp"], env: { UNBROWSE_NODE: "http://127.0.0.1:7788", UNBROWSE_AGENT_TOKEN: "…" } }
```

It carries the token in the bridge's environment: keep it out of logs. For Claude Code, `unb connect` registers the node without the token ever
passing through a terminal.

## The owner

`UnbrowseOwner` is the node as its owner sees it: everything the Unbrowse window does, over `POST /owner/{command}`.
Routes, agent keys, the vault, settings (the per-fetch maximum among them), the wallet and the chain, and the node's
live events.

```ts
import { UnbrowseOwner } from "unbrowse";
import { ownerToken } from "unbrowse/local"; // Node.js only

const owner = new UnbrowseOwner({ token: ownerToken }); // the function: each request reads the token

const { agent, setup } = await owner.createAgent({ name: "claude", capUsdc: 5, days: 30 }); // spends up to 5 USDC an epoch
// setup names the agent, never its token; the token comes on this answer alone (`token`): hand it to the agent, then let it go.
await owner.setMaxFetch(0.1); // the most the node pays to fetch one route, in USDC; agents spend up to it on their own

const events = owner.events();
events.on("open", () => refresh());             // (re)connected: refetch, events sent while down are gone
events.on("call", (c) => console.log(c.phase, c.route));
```

The owner's token can do anything on the node, the vault included. The node writes a fresh one to
`~/.unbrowse/owner.token` (mode 0600) every time it starts, so pass `ownerToken` itself, not `ownerToken()`: a token
held as text is refused from the next start, and an event stream using one stops there, through `onError`, since no
retry can pass. A page in a browser can't read it: serve the page beside a proxy that signs `/owner` requests and pass
`baseUrl: ""` with no token.

Records come back in the node's own snake case (`map_while_browsing`), so a record goes back as it came:
`saveSettings({ ...await owner.settings(), paused: true })`. Method arguments are camel case.

Every command the node answers has its method, generated from the node's `agent-api.json` (`OwnerCommands`, which
`UnbrowseOwner` extends), with its arguments in order, required ones first; its records are typed as the node sends
them (`wire.KeptRoute`, re-exported under the names below). `createAgent`, `vaultAdd`, `setPricing` and
`passkeyEnrol` also take the object forms shown.

Fees, deposits, caps and earnings are USDC; route coins are bought, launched and bountied with UNB. An agent key's cap
is `cap_usdc` (`cap_unb` is the same amount under its deprecated old name), and an activity line's `unb` is still named
from before fees were USDC (it is USDC).

| Area | Methods |
|---|---|
| Node | `identity()`, `nodeInfo()`, `settings()`, `saveSettings(s)`, `setMaxFetch(usdc)`: the most the node pays to fetch one route (0: only free routes and its own), `activity(limit?)`, `updateStatus()` |
| Browser | `browsers()`: the one in use and the Chromium browsers on this Mac; `chooseBrowser(path \| null)`; `downloadBrowser()`: Chrome for Testing, ending with a `browser` event |
| Routes and sites | `routes()`, `deleteRoute(id)`, `callRoute(id, inputs)`, `sites()`, `sessions()`, `forgetSession(host)`, `importSession(host)`: the site's cookies from the node's browser |
| Agents | `agents()`, `createAgent({ name, capUsdc, days })`, `revokeAgent(index)`, `agentsSpend()` |
| Vault | `vaultList()`, `vaultAdd({ site, account, kind, password? })`, `vaultRemove(site, account)`, `vaultReveal(site, account)`, `vaultRotate(site, account)`, `vaultImport(csv)`: a browser's or password manager's CSV export |
| Passkeys | `passkeys()`, `passkeyNever(site, never?)`, `passkeyRemove(id)`, `passkeyEnrol(site, { cdp?, minutes? })`, `passkeyUse(site, cdp)` |
| Money | `money()`: one balance in dollars (`balance`, `available_to_spend`, `needed_to_start`, each agent's `daily_limit` and `spent_today`, earnings, `add_funds_url`), every sum a decimal string of USDC; `addFunds()` opens the page that adds funds |
| Chain and wallet | `chainStatus()`, `wallet()`; the agents' deposit, in USDC: `deposit(n)`, `requestWithdraw(n)`, `withdraw()`; earnings: `earnings()` (from staking route coins and as a contributor, paid whole: nothing vests), `collectEarnings()`, `claimNow()`; `board()`, `entries({ site })` (every route on the chain with its live entries, the default first), `funding()` |
| Route coins | `coinHoldings()`: each coin the wallet holds, its staked lots and what they earned; `coinLaunch(entry, unb)`: the coin of an entry the wallet is credited with; `coinBuy(entry, unb)`, `coinSell(entry, coins)`; `coinStake(entry, coins, delay?)` (24 hours when left out), `coinUnstake(entry, delay, coins)`, `coinWithdraw(entry, delay)`; `coinClaim(entry)`; `coinFetchDelay(delay?)`, `coinDevBuy(bps?)`: read or set (the listing's first buy is a share of the wallet's UNB in basis points, 100 by default, 0 for none); `coinRank(entries)` |
| The network | `listRoute(id)`, `delistRoute(id)`, `shareStatus()`, `shareRoute(id, on)`, `delistAll()`, `setPricing({ fee, auto, floor, ceiling })`: the node's one fee in USDC, `routesOnChain()`: each kept route's listing, coin, the owner's coins of it and its rank |
| The owner's hands | `hands()`, `handsWatch(site)`, `handsInput(site, input)`, `handsGiveBack(site, done?)`, `handsStop()` |
| Bounties (spec ch. 8) | `bountyPost(site, amount, limit?, days?)`: UNB for a site, with the most it pays a coin (`limit`; none buys at market), open for `days` (30 when left out); `bountyConfirm(id, entry)`: once your own paid call on an entry of the site passed and was claimed, launches or buys that entry's coin; after the deadline `bountySettle(id)`, `bountyRelease(id, entry)`: an entry's share by use, and `bountyRefund(id)`: what is yours; `bountyList(mine?)`, `bountyShow(id)`: site, amount, `limit_price`, `deadline`, `state`, `refundable`; `bountyAuto(on?)`: whether the node takes these steps for you, off by default. An agent asked about a bounty (`result.bounties`) answers with `answerBounty({ routeId, verdict, bounty, entry })` |
| Devnet | `faucet(n)`, `advanceDay()` |
| Anything | `command(name, args)`: any owner command by the node's name for it |
| Live | `events({ onError? })`: one connection, back by itself after a restart (with `token: ownerToken`, or behind a proxy); `frame(walk?)`: a walk's latest picture as a JPEG `Blob` |

Events: `activity` (something changed: refetch), `chain`, `identity`, `eye` (what the node's browser sees
while learning), `call` (a call leaving and answering), `frame` (a new picture of a walk), `browser`, `hands` and
`hands_frame` (a site's page changing hands, and its new picture), and the stream's own `open`. A listener that throws is reported and the stream carries on.

`unbrowse/local` (Node.js only) reads what the node keeps on this machine: `nodeHome()` (`UNBROWSE_HOME`, else
`~/.unbrowse`), `ownerToken()`, `nodePort()`, `nodeAddress()`.

## Errors

A request the node refuses throws an `UnbrowseError` with `status`, `code` and the node's reason as `message`. Each
kind of failure is its own subclass, so catch the ones you handle and let the rest through:

```ts
import { Unbrowse, AuthenticationError, NodeConnectionError } from "unbrowse";

try {
  await new Unbrowse().do("search Hacker News stories", { url: "https://hn.algolia.com/?q=rust" });
} catch (e) {
  if (e instanceof AuthenticationError) console.error("make an agent key: Unbrowse app, Wallet, New agent key");
  else if (e instanceof NodeConnectionError) console.error("start the node: open the Unbrowse app");
  else throw e;
}
```

`NodeTimeoutError` is also a `NodeConnectionError`. Every class is an `UnbrowseError`, and `code` reads as before.

| Class | `code` | `status` | Why |
|---|---|---|---|
| `BadRequestError` | `bad_request` | 400 | The node couldn't run the call with these inputs, or a field is missing |
| `AuthenticationError` | `unauthorized` | 401 | No token, or a key that's unknown, revoked or expired |
| `PaymentRequiredError` | `payment_required` | 402 | A paid route this key isn't authorised for, or past its cap |
| `PermissionDeniedError` | `forbidden` | 403 | The owner declined (or didn't answer in five minutes), turned learning off, or a vault login can't go where it was sent |
| `NotFoundError` | `not_found` | 404 | No such route; or nothing does the goal yet and `do` had no `url` |
| `ConflictError` | `conflict` | 409 | Routes on more than one site do the goal: pass `url` to say which |
| `UnprocessableEntityError` | `unprocessable` | 422 | The browser or the learner couldn't do it; `message` says why |
| `BrowserMissingError` (an `UnprocessableEntityError`) | `browser_missing` | 422 | The goal needs the node's browser and the node lacks it (or the call said `browser: "never"`): `missing` (`program`, `chromium`), `install` (`unbrowse browser install`), `browser` (`missing`, `installing`) and `fetches` say what and how |
| `NodeUnavailableError` | `unavailable` | 503 | The node is paused by its owner, or waiting for Keychain access |
| `NodeConnectionError` | `unreachable` | 0 | The node isn't running at `baseUrl` |
| `NodeTimeoutError` | `timeout` | 0 | No answer within `timeoutMs` |

## HTTP

Each method is one request to the node's agent API, signed with the token (above). Request
bodies use the API's snake case; results come back camel-cased.

| Method | Route |
|---|---|
| `whoami()` | `GET /v1/whoami` |
| `search(query)` | `GET /v1/routes?q=` |
| `do(goal, { url?, inputs? })` | `POST /v1/do` (`goal`, `url`, `inputs`) |
| `call(id, inputs)` | `POST /v1/routes/:id/call` (`inputs`) |
| `browser().*` | `POST /v1/browse` (`{ do: [...], site, goal, session }`) |
| `open(link)` | `GET /v1/open?q=` (what an `unbrowse://` link names; calls and pays nothing) |
| `logins()`, `cards()` | `GET /v1/logins` (`logins`, `cards`: references only) |
| `judge({ routeId, verdict, url?, why?, what?, fields? })` | `POST /v1/routes/{id}/judge` (what you saw in a route's answer: wrong for a page, its real name, its default fields) |
| `report({ kind, summary, expected, got, ... })` | `POST /v1/report` (scrubbed by the node, filed as a public GitHub issue) |
| `mcpServer()` | `GET /v1/node/proof`; the bridge it names then sends each message to `POST /mcp` |
| `UnbrowseOwner` methods | `POST /owner/:command`, `GET /owner/events`, `GET /owner/frame?walk=` (owner's token) |

## Develop

```bash
npm install
npm test   # builds, then runs the tests against fake nodes that answer in the API's shapes
npm run gen   # rewrites src/generated.ts from the node's agent-api.json (gen:check fails when it's stale)
```

`src/generated.ts` and `src/adapters/tools.ts` are written from the node's `agent-api.json` by `../codegen/generate.py`:
never edit them by hand. The frameworks are dev dependencies here, so `npm test` runs each adapter against the fake node
and through its framework's own tool-calling path with a scripted model. The
node's records as they cross the wire are exported as `wire` (`import type { wire } from "unbrowse"`).

## Licence

[Apache-2.0](../../LICENSE).
