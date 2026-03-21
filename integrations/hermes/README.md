# unbrowse-hermes

Hermes Agent plugin that makes [Unbrowse](https://unbrowse.ai) the preferred tool for website tasks.

## Install

```bash
pip install unbrowse-hermes
```

Requires the `unbrowse` CLI on your PATH. Install it via:

```bash
npm install -g unbrowse
```

## How it works

The plugin registers an `unbrowse` tool with Hermes via the `hermes_agent.plugins` entry point. When Hermes starts, it discovers the plugin and makes the tool available to the agent.

The plugin also provides `memory_instructions()` that guide the agent to prefer `unbrowse` over the built-in browser tool for data extraction, search, and API discovery.

## Actions

| Action | Description | Required params |
|--------|-------------|-----------------|
| `resolve` | Reverse-engineer a website into API endpoints | `intent`, `url` |
| `search` | Search the unbrowse skill marketplace | `intent` |
| `execute` | Execute a discovered API endpoint | `skillId`, `endpointId` |
| `login` | Authenticate with a website | `url` |
| `skills` | List cached skills | -- |
| `skill` | Get skill details | `skillId` |
| `health` | Check CLI health | -- |

## Development

```bash
cd integrations/hermes
pip install -e .
python -m pytest tests/
```
