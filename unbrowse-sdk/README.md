# Unbrowse node SDKs

Clients for the Unbrowse node on your machine. Say what you want from a website and get the site's own answer: the
node calls the route that does it, or learns one from the page and calls that. Drive the node's browser by hand when a
page needs it, and the node learns routes from that too.

| Language | Package | Directory |
|---|---|---|
| TypeScript (Node 20.3+, Bun, Deno) | `unbrowse` | [typescript/](typescript) |
| Python 3.9+ | `unbrowse` | [python/](python) |

Both wrap the same agent API (`app/src/api.rs` in `unbrowse-node`) with the same verbs, and neither has
dependencies. Both read `UNBROWSE_NODE` and `UNBROWSE_AGENT_TOKEN` from the setup the Unbrowse app shows when it
makes an agent key. The client is `Unbrowse` (also exported as `UnbrowseNode`), and each kind of failure is its own
`UnbrowseError` subclass (`AuthenticationError`, `NotFoundError`, `NodeConnectionError`, ...), the same names in both.

```ts
const node = new Unbrowse();
const r = await node.do("search Hacker News stories", { url: "https://hn.algolia.com/?q=rust" });
```

```python
node = Unbrowse()
r = node.do("search Hacker News stories", url="https://hn.algolia.com/?q=rust")
```

Both give agent frameworks the node's tools as their own tool objects, with the MCP server's names, descriptions and
input schemas: `unbrowse/ai-sdk`, `unbrowse/langchain`, `unbrowse/mastra` and `unbrowse/openai-agents` in TypeScript,
`unbrowse.adapters.langchain` and `unbrowse.adapters.openai_agents` in Python. [examples/](examples) has a quickstart
for each.

Both also have the owner's client (`UnbrowseOwner`): everything the Unbrowse window does, with the owner's token.

> This is the SDK for the **local Unbrowse node** (`http://127.0.0.1:7788`). Legacy hosted API users should migrate to the local node (`npm install -g unbrowse`).

## Changing the API

Each SDK's typed layer is generated from the node's `agent-api.json` (`codegen/generate.py`): the wire types, the agent
primitives' requests and one method per owner command, in `typescript/src/generated.ts` and
`python/src/unbrowse/_generated.py`, and the framework adapters' tool definitions, in `typescript/src/adapters/tools.ts`
and `python/src/unbrowse/adapters/_tools.py`. Those files are never edited by hand: change the node, rewrite its
`agent-api.json`, then run `python3 unbrowse-sdk/codegen/generate.py` (`npm run gen`); CI fails while one is stale.
See [codegen/](codegen) for what it writes and the workflow that drafts the hand-written follow-ups.

The friendlier layer on top is hand-written: when the node's API changes, change both clients and both fake nodes in
their tests together. The fakes answer in the API's own shapes, so a test that still passes against a stale fake
proves nothing.

## Licence

[Apache-2.0](../LICENSE).
