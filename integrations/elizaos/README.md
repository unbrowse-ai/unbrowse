# @unbrowse/plugin-elizaos

ElizaOS plugin that replaces Playwright browser automation with [Unbrowse](https://unbrowse.ai) API discovery. Your agent gets structured JSON instead of raw HTML.

## Bootstrap Unbrowse first

```bash
npx unbrowse setup
unbrowse health
```

## Installation

### Step 1: Install the plugin

```bash
cd your-eliza-project
npm install @unbrowse/plugin-elizaos
```

### Step 2: Add to your character config

Edit your character file (e.g., `characters/my-agent.json`):

```json
{
  "name": "MyAgent",
  "plugins": [
    "@elizaos/plugin-openai",
    "@unbrowse/plugin-elizaos"
  ]
}
```

**To fully replace the browser:** Remove `@elizaos/plugin-browser` from the plugins array. This prevents Playwright from loading entirely — all web tasks route through Unbrowse.

**To keep browser as fallback:** Keep both plugins. The routing provider will instruct the LLM to prefer Unbrowse, falling back to browser for visual-only tasks (screenshots, drag-drop, canvas).

### Step 3: Start your agent

```bash
npx elizaos start --character characters/my-agent.json
```

The agent now has `UNBROWSE_FETCH` as its primary web action. Ask it to get data from any website.

## How It Replaces the Browser

This plugin registers three components that replace `@elizaos/plugin-browser`:

### 1. UNBROWSE_FETCH Action
The LLM's primary tool for web data extraction. Registered with `similes: ["FETCH_URL", "WEB_SEARCH", "GET_DATA_FROM_WEBSITE"]` so the LLM routes web requests here instead of `BROWSER_NAVIGATE`.

### 2. ServiceType.BROWSER Replacement
Implements `UnbrowseService` registered as `ServiceType.BROWSER`. Any code calling `runtime.getService(ServiceType.BROWSER).getPageContent(url)` gets unbrowse results instead of Playwright.

### 3. Routing Provider
Injects web-routing policy into the agent's context:
- **strict mode** (default): "Always use UNBROWSE_FETCH. Do not use browser."
- **fallback mode**: "Prefer UNBROWSE_FETCH. Use browser only for visual QA, file uploads, canvas apps."

## Configuration

Set in your ElizaOS runtime settings or environment:

| Setting | Description | Default |
|---------|-------------|---------|
| `UNBROWSE_ROUTING_MODE` | `strict` — block browser entirely. `fallback` — browser available as backup | `strict` |
| `UNBROWSE_BIN_PATH` | Custom path to unbrowse binary | auto-resolved from `node_modules` |
| `UNBROWSE_BASE_URL` | Remote Unbrowse server URL | local CLI |
| `UNBROWSE_TIMEOUT_MS` | CLI timeout in ms | `120000` |

## Example: Agent Fetching HN Stories

```
User: Get me the top stories from Hacker News
Agent: [calls UNBROWSE_FETCH with action=resolve, intent="get top stories", url="https://news.ycombinator.com"]
Agent: Here are the top stories:
  1. OpenCode - Open source AI coding agent (580 points)
  2. We rewrote our Rust WASM parser in TypeScript (147 points)
  ...
```

First call: ~10-15s (discovers the API). Subsequent calls: ~300ms (cached skill).

## Supported Actions

| Action | Description | Required params |
|--------|-------------|-----------------|
| `resolve` | Reverse-engineer a website into API endpoints | `intent`, `url` |
| `search` | Search the Unbrowse skill marketplace | `intent` |
| `execute` | Execute a cached skill endpoint | `skillId`, `endpointId` |
| `login` | Authenticate with a website | `url` |
| `skills` | List all cached skills | -- |
| `skill` | Inspect a specific skill | `skillId` |
| `health` | Check CLI health | -- |

## Development

```bash
cd integrations/elizaos
npm install
npm test          # 15 tests
```
