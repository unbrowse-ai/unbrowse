# @unbrowse/plugin-unbrowse

Unbrowse for ElizaOS agents. Your agent says what it wants from a website and gets the site's own JSON back, through
the Unbrowse node on your machine.

A **route** is a website's own API call, learned once by the node's browser and replayed after that as plain HTTP.
The node keeps the routes, the logins and the browser. This plugin is how an ElizaOS agent talks to it. Its actions
are the `unbrowse` TypeScript client's tools (`unbrowse/tools`), written from the node's own `agent-api.json`, so each
action's description and parameters are the node's MCP tool's, word for word, with action names for tool names.

Built for `@elizaos/core` 1.7 (the current stable line).

## Install

You need the Unbrowse node running:

```bash
npm install -g unbrowse
unbrowse app      # or `unbrowse start`, with no window
```

The node needs no account and no sign-in: it joins the network with its own wallet (spec §86), and linking a wallet of
yours is optional, only for cashing out ([ONBOARDING.md](../../docs/ONBOARDING.md#2-linking-a-wallet-optional)).

Then add the plugin to your ElizaOS project:

```bash
bun add @unbrowse/plugin-unbrowse unbrowse
```

`unbrowse` is a peer dependency: the plugin uses the client from the copy you install, and installs nothing else. It
needs the client this repository builds (`unbrowse-sdk/typescript`, with its `unbrowse/tools` entry); the `unbrowse`
on npm today is an older one, so until a current release reaches npm, install the client from a checkout
(`npm ci && npm run build && npm pack` in `unbrowse-sdk/typescript`, then add the `.tgz`).

## Configure

The node makes its first agent key itself on its first run, and `unbrowse agent token` prints that key's token. For
a key of the agent's own, `unbrowse agent new <name>` (or the window's Agents, Add agent) makes one and prints its
setup once. Two values:

| Setting | Required | What it is |
|---|---|---|
| `UNBROWSE_AGENT_TOKEN` | yes | This character/runtime's agent token. Keep it secret. Process environment variables are not used as token fallbacks. |
| `UNBROWSE_NODE` | no | The node's address. Defaults to `http://127.0.0.1:7788`. |

Set the key in the character's secret settings:

```ts
export const character: Character = {
  name: "Ada",
  plugins: ["@elizaos/plugin-bootstrap", "@elizaos/plugin-openai", "@unbrowse/plugin-unbrowse"],
  settings: {
    UNBROWSE_NODE: "http://127.0.0.1:7788",
    secrets: { UNBROWSE_AGENT_TOKEN: process.env.UNBROWSE_AGENT_TOKEN },
  },
};
```

Without a character/runtime token the plugin loads, logs a warning, and keeps its actions off. A process-wide token
never fills in a missing character key; settings are read each time they are needed, so a character token change takes
effect without a restart.

## What it adds

**`UnbrowseService`** (`unbrowse`) holds the client. Other plugins can reach it with
`runtime.getService("unbrowse")` and use `service.node` (an `UnbrowseNode`).

**Actions.** One for each agent tool the node serves, in the node's order: `UNBROWSE_SEARCH`, `UNBROWSE_DO`,
`UNBROWSE_WALK`, `UNBROWSE_BROWSE`, `UNBROWSE_CHALLENGE`, `UNBROWSE_OBSERVE`, `UNBROWSE_LOGINS`, `UNBROWSE_OPEN`,
`UNBROWSE_CALL`, `UNBROWSE_INSPECT`, `UNBROWSE_JUDGE`, `UNBROWSE_WHOAMI` and `UNBROWSE_REPORT`
([CLI.md §5](../../docs/CLI.md#5-the-agent-api-and-mcp-tools) says what each does). Each reads its parameters, which are its tool's input schema, off the conversation with the agent's
small text model. If the planner already gives them in `content.actionParams`, those are used as they are. A number
the model reads off the conversation (a bounty's id, a click's place) is dropped unless the conversation says that
number.

Each action answers in the chat with the node's JSON (cut at 4,000 characters) and returns an `ActionResult` with the
whole reply in `data.reply`, so later actions in the same run can read it. A refusal from the node, or a node that
isn't running, is answered as text, never thrown. All the actions share one browsing session, so each
`UNBROWSE_BROWSE` step acts on the page the last one opened.

**Providers.**

- `UNBROWSE` is in every prompt while the plugin has a token. It tells the agent what Unbrowse does and how to use it:
  `UNBROWSE_DO` first, `UNBROWSE_BROWSE` when the page needs hands, the learned route after that, `UNBROWSE_JUDGE` when
  an answer is wrong for the page.
- `UNBROWSE_ROUTES` is dynamic: it runs only when asked for, and lists the routes the node knows.

## Money and retries

Another contributor's route costs its fee, which the node pays by itself from its balance, up to the owner's per-fetch
maximum and the key's daily limit: nothing waits for approval. A card payment from the vault waits for the owner in
their window. The owner adds funds in the window (Money, Add funds).

A write that fails is never sent twice by the node. The reply's `retry` says what to do: `as_is` (run it again),
`check_first` (look at the site first) or `never` (don't send it again).

## Logins

Passwords and cards stay in the owner's vault on the node. `UNBROWSE_LOGINS` lists them by reference; to sign in, the
agent fills the password field with a reference, and the node types the password itself:

```
UNBROWSE_BROWSE  do: ["fill", "@e8", "vault:<site>:<account>"]
```

## Example

```
user:  Find stories about rust on https://hn.algolia.com/?q=rust
agent: (UNBROWSE_DO goal "search Hacker News stories", url https://hn.algolia.com/?q=rust)
       { "how": "learned", "route": { "id": "hn-search", ... }, "result": { "ok": true, "data": { "hits": [ ... ] } } }
user:  Now tauri.
agent: (UNBROWSE_DO goal "search Hacker News stories", inputs {"q": "tauri"})
       { "how": "called", ... }
```

The second call goes straight to the site's API. No browser.

## Develop

```bash
npm install
npm test     # builds, then runs the tests against a fake node: no live node, model or network
```

Build the SDK first (`npm ci && npm run build` in `unbrowse-sdk/typescript`): the plugin's dev copy of the client is
that folder. The tests check the plugin has an action for exactly the tools `unbrowse-node/agent-api.json` lists.

## ElizaOS docs used

- Plugin architecture: https://docs.elizaos.ai/plugins/architecture
- Components (actions, providers, services): https://docs.elizaos.ai/plugins/components
- Plugin reference: https://docs.elizaos.ai/plugins/reference
- Patterns (`composePromptFromState`, `useModel`): https://docs.elizaos.ai/plugins/patterns
- Services and `getSetting`: https://docs.elizaos.ai/runtime/services
- Character settings and secrets: https://docs.elizaos.ai/agents/character-interface
- Publishing and the `plugin-` name: https://docs.elizaos.ai/guides/publish-a-plugin
- The `@elizaos/core` 1.7.2 type definitions, and `@elizaos/plugin-quick-starter` and `@elizaos/plugin-mcp` on npm
  (for `agentConfig` and `content.actionParams`)
