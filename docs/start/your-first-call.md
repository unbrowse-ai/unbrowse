# Your first call

Say what you want and the address of a page that does it. The node calls the route that does it, or walks the page
once, keeps the call that answers you, and calls that. You get the site's JSON.

## 1. Make an agent key

Every call comes from an agent key. Make one in the window (**Money**, **Add agent**) or from a shell:

```sh
unbrowse agent new my-agent            # [limit] [days]: daily limit in $ (default 5), expiry in days (default 30)
```

`agent new` derives the key from the root key, lets it pay up to its daily limit once the node is on the network (`main.rs`
`agent_new`, `chain::authorize`), and prints its setup once (`agents.rs` `create`):

```sh
# Claude Code (MCP):
claude mcp add --scope user unbrowse --env UNBROWSE_NODE=http://127.0.0.1:7788 -- unb mcp --agent first

# Any other agent, or the unb CLI:
export UNBROWSE_NODE=http://127.0.0.1:7788
export UNBROWSE_AGENT_TOKEN="$(unbrowse agent token)"
```

Keep it: the setup isn't shown again, and a lost one means a new key. Until the key can pay, it still works for free
routes and the node's own.

## 2. Ask

```sh
unbrowse do "search Rust crates" --url "https://crates.io/search?q=tokio"
```

The reply's `how` says what the node did (`api/goal.rs` `do_goal`):

| `how` | What happened |
|---|---|
| `learned` | No route did this. The node's browser walked the page, kept the call that answers the goal, and called it. A few seconds |
| `called` | A route this node holds did it: one HTTP request, tens to hundreds of milliseconds, no browser |
| `network` | Another node lists a route for the page's site. This node fetched it, paid its fee itself and ran it here |
| `browse` | Loading the page doesn't answer the goal: it needs clicks or typing. The page is open in the node's browser; drive it ([unbrowse-a-site.md](../guides/unbrowse-a-site.md)) |

Run the same command again, or with a new value in the query (`?q=serde`), and it is `called`. Put what you'd search
for in the URL's query: that value becomes the route's input. A route the node already has needs no `--url`;
`name=value` gives its inputs.

**Nothing waits for you.** Another contributor's route costs its fetch fee, which the node pays by itself from its
balance, up to the per-fetch maximum (`max_fetch_usdc`, $0.05 by default) and within the agent key's daily limit
(`agents.rs`). A route whose fee is over the maximum is passed over, and the reply's `network_skipped` says so
([SHARING.md §3](../SHARING.md#3-how-a-caller-finds-pays-for-keeps-and-runs-a-body)). The only things that ask the
owner are a card checkout and a page only a person can pass ([the-app.md](the-app.md#what-the-node-asks-you)).

## 3. From an agent

Connect the agent once with the setup above, and give it the skill ([connect-your-agent.md](../guides/connect-your-agent.md)).
The agent calls `unbrowse_do` with a goal and a URL and gets the site's JSON back, with no browser in its own process;
when a page needs hands it drives the node's browser with `unbrowse_browse`, and the node learns from every step.

## 4. From your own code

Install the client in the project (`npm install unbrowse`, without `-g`). It reads the same `UNBROWSE_NODE` and
`UNBROWSE_AGENT_TOKEN` (`unbrowse-sdk/typescript/src/client.ts`, `python/src/unbrowse/client.py`):

```ts
import { Unbrowse } from "unbrowse";
const node = new Unbrowse();
const r = await node.do("search Rust crates", { url: "https://crates.io/search?q=tokio" });
if (r.how === "browse") {
  // the page is open in the node's browser: drive it with node.browser({ site: r.site })
} else {
  console.log(r.result.data); // read r.result.retry before running a failed write again
}
```

```python
from unbrowse import Unbrowse
node = Unbrowse()
r = node.do("search Rust crates", url="https://crates.io/search?q=tokio")
```

`Unbrowse` is also exported as `UnbrowseNode`. The methods are `do`, `call`, `search`, `browser()` (and `browse`),
`logins`, `cards` and `whoami`; each kind of failure is its own `UnbrowseError` subclass
([unbrowse-sdk/README.md](../../unbrowse-sdk/README.md)).

## The rule

Always go through the node. A browser of your own teaches the node nothing, and only the node can reuse what it
learned. The first walk is paid once; every call after it is plain HTTP.

Next: [The app](the-app.md) · [Unbrowse a site](../guides/unbrowse-a-site.md).
