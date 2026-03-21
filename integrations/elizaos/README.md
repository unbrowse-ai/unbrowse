# @unbrowse/plugin-elizaos

ElizaOS plugin that routes web tasks through [Unbrowse](https://unbrowse.ai) API discovery before Playwright browser automation.

## Installation

```bash
npm install @unbrowse/plugin-elizaos unbrowse
```

## Usage

Add to your ElizaOS character config:

```json
{
  "name": "MyAgent",
  "plugins": ["@unbrowse/plugin-elizaos"]
}
```

Omit `@elizaos/plugin-browser` to fully replace Playwright with Unbrowse.

## What it does

- **UNBROWSE_FETCH action** -- the LLM's primary tool for website data extraction, search, and API discovery
- **ServiceType.BROWSER replacement** -- any code calling `runtime.getService(ServiceType.BROWSER).getPageContent()` gets routed through Unbrowse
- **Routing provider** -- injects prompt guidance so the LLM prefers Unbrowse over browser automation

## Configuration

Set these in your ElizaOS runtime settings:

| Setting | Description | Default |
|---------|-------------|---------|
| `UNBROWSE_BASE_URL` | Remote Unbrowse server URL | (local CLI) |
| `UNBROWSE_ROUTING_MODE` | `strict` or `fallback` | `strict` |
| `UNBROWSE_BIN_PATH` | Custom path to unbrowse binary | (auto-resolve) |
| `UNBROWSE_TIMEOUT_MS` | CLI timeout in ms | `120000` |

## Supported actions

`resolve`, `search`, `execute`, `login`, `skills`, `skill`, `health`

## Development

```bash
npm test
npm run typecheck
```
