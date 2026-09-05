# Unbrowse

**The route / action layer for AI agents.** Learn a site’s first-party routes once, then replay them as cheap indexed calls instead of re-driving a browser every time.

```bash
npm install -g unbrowse@latest
unbrowse setup
unbrowse "top stories with points" --url https://news.ycombinator.com
```

That’s the whole agent path: **one call**. Setup installs the Agent Skill + runtime; every later call runs **in-process** (no localhost daemon, no port to babysit).

---

## What it is (and isn’t)

| Unbrowse is | Unbrowse is not |
|---|---|
| A **route layer** that reuses first-party site APIs | A browser automation product |
| A **local CLI + Agent Skill + SDK** | A cloud-only black box |
| Capture-once, replay-everywhere | “Open Chromium on every agent turn” |
| Credentials **local**; only sanitized route metadata publishes | A place that stores your sessions server-side |

Measured (paper): **3.6× mean / 5.4× median** speedup on warmed routes vs browser automation across 94 domains — [arXiv:2604.00694](https://arxiv.org/abs/2604.00694).

---

## Install

```bash
npm install -g unbrowse@latest
unbrowse setup          # Agent Skill + browser engine + registration
unbrowse health         # local runtime check
```

Optional bee aliases (same engine, different names):

```bash
npm install -g @unbrowse/pollen-cli
hive setup
forage "top stories" --url https://news.ycombinator.com
```

Binary / script installers: [unbrowse.ai](https://unbrowse.ai) · docs: [docs.unbrowse.ai](https://docs.unbrowse.ai)

---

## CLI — flat commands (what agents should use)

| You want | Command |
|---|---|
| **One internet result** | `unbrowse "task" --url <url>` or `unbrowse get "task" --url <url>` |
| URL contents | `unbrowse fetch <url>` |
| Ranked routes (debug) | `unbrowse resolve --intent "..." --url "..."` |
| Pick endpoint | `unbrowse execute --skill <id> --endpoint <id>` |
| Sign in once | `unbrowse auth <login_url>` |
| Capture on miss | `unbrowse capture --url <url> --intent "..."` |
| Health / setup | `unbrowse health` · `unbrowse setup` |
| Upgrade | `unbrowse upgrade` |

Browse session **only when you need a real DOM** (forms, multi-step UI):

```text
go <url> → snap → click/fill/type/select/submit → sync → close
```

Legacy `build` / `act` / `eval` / `act` prefixes may still parse as aliases; **prefer the flat table**. Per-command help: `unbrowse <command> --help`.

### Agent recovery (three moves)

1. Default — `unbrowse "task" --url <site>`
2. On `auth_required` — follow `next_step` or `unbrowse auth <url>`, then **1** once
3. On miss — follow `next_step` or one `unbrowse capture --url … --intent …`, then **1** once

Do not invent browser loops, curl chains, or hand-picked profiles.

---

## Runtime model

- **Default:** every CLI/MCP call runs **in-process** (stateless). No `localhost:6969` daemon.
- **Optional:** `unbrowse serve` is an explicit HTTP facade only (pairing / legacy HTTP clients).
- **Browser:** a local broker (Kuri) starts only when a task needs a live page.
- **Readable runtime:** the npm package ships an auditable Node runtime under `runtime/` (not a sealed binary-only black box).

Backend default: `https://beta-api.unbrowse.ai` (override with `UNBROWSE_API_URL`).

---

## SDK (same hole, in TypeScript)

```ts
import { createHole } from "unbrowse/sdk";

const hole = createHole();
const result = await hole.fill({
  intent: "get the current npm express version and weekly downloads",
  url: "https://www.npmjs.com/package/express",
});
```

Drop-in adapters (swap one import):

```ts
import Exa from "unbrowse/sdk/adapters/exa"; // was: exa-js
```

Also: `tavily`, `browser-use`, `firecrawl` under `unbrowse/sdk/adapters/*`.

---

## MCP (optional compatibility)

Skill + CLI are primary. For hosts that still want MCP:

```json
{
  "mcpServers": {
    "unbrowse": {
      "command": "npx",
      "args": ["-y", "unbrowse", "mcp"],
      "env": { "UNBROWSE_MCP_SURFACE": "agent" }
    }
  }
}
```

- `UNBROWSE_MCP_SURFACE=agent` (default): few tools — get / auth / capture / feedback / status  
- `UNBROWSE_MCP_SURFACE=full`: full operator catalog  

`unbrowse setup` does **not** auto-write MCP host configs.

---

## Configuration

```text
~/.unbrowse/config.json    # API key, agent id
~/.unbrowse/vault/         # encrypted local credentials
~/.unbrowse/skill-cache/   # local route cache
```

| Variable | Default | Meaning |
|---|---|---|
| `UNBROWSE_API_URL` | `https://beta-api.unbrowse.ai` | Marketplace / backend |
| `UNBROWSE_CONFIG_DIR` | `~/.unbrowse` | Config + cache root |
| `UNBROWSE_NO_AUTO_UPDATE` | — | `1` disables background `npm i -g unbrowse@latest` |
| `UNBROWSE_AGENT_EMAIL` | — | Headless registration identity |
| `UNBROWSE_TOS_ACCEPTED` | — | Non-interactive ToS accept |
| `HEADLESS` | `true` | `false` shows the browser window |

Global installs may auto-update in the background (throttled). Manual: `unbrowse upgrade`.

---

## How resolution works

1. Local / marketplace **route hit** → execute (often &lt;200ms cache path)  
2. Miss → capture via local browser when needed → index after checkpoint  
3. Credentials stay on your machine; marketplace gets sanitized route metadata only when you publish  

Contract surface (machine-readable holes):

```bash
curl https://beta-api.unbrowse.ai/v1/contract/surface
```

---

## Links

| | |
|---|---|
| Site | https://unbrowse.ai |
| Docs | https://docs.unbrowse.ai |
| Papers | https://unbrowse.ai/papers · [arXiv:2604.00694](https://arxiv.org/abs/2604.00694) |
| How it pays | https://unbrowse.ai/how-unbrowse-pays |
| Discord | https://discord.gg/VWugEeFNsG |
| Public source | https://github.com/unbrowse-ai/unbrowse |
| Open / private split | [OPEN-SOURCE-NOTICE](https://github.com/unbrowse-ai/unbrowse/blob/main/docs/OPEN-SOURCE-NOTICE.md) |

---

## License

AGPL-3.0 for this package — see [LICENSE](LICENSE). SDK entrypoints under `unbrowse/sdk` follow the package license terms shipped with this release; see the open-source notice for the client vs backend boundary.
