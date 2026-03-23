# unbrowse-hermes

Hermes Agent plugin that makes [Unbrowse](https://unbrowse.ai) the preferred tool for website tasks, replacing the built-in CDP browser automation.

## Bootstrap Unbrowse first

```bash
curl -fsSL https://www.unbrowse.ai/install.sh | bash
unbrowse health
```

## Installation

### Option A: pip install (recommended)

```bash
pip install unbrowse-hermes
```

The plugin auto-registers via the `hermes_agent.plugins` entry point. Hermes discovers it on startup, so restart Hermes after install — no config file needed.

### Option B: Drop-in plugin directory

Copy the bundled plugin directory into Hermes's plugin directory:

```bash
mkdir -p ~/.hermes/plugins
cp -R dropin/unbrowse ~/.hermes/plugins/unbrowse
```

Hermes scans `~/.hermes/plugins/<name>/` for a `plugin.yaml` + `__init__.py` pair on startup.

### Verify it loaded

Start Hermes and check:

```
/tools
```

You should see `unbrowse` in the tool list with actions: resolve, search, execute, login, skills, skill, health.

## How It Replaces the Browser

### What it replaces
Hermes ships with built-in browser tools via Chrome DevTools Protocol (CDP):
- `/browser connect` — attaches to Chrome
- The agent navigates pages, clicks, extracts text manually

This is slow, brittle, and returns unstructured text.

### What unbrowse provides instead
A single `unbrowse` tool that reverse-engineers websites into cached API skills:
- First call: captures traffic, discovers the API, returns structured JSON (~5-15s)
- Subsequent calls: re-uses the cached skill (~300ms-1s)

### Routing guidance
The plugin provides `memory_instructions()` that get injected into the agent's system memory:

> *"Use unbrowse first for any website data extraction, search, or authenticated reads. Only fall back to the browser tool for visual QA, drag-drop, canvas apps, or file uploads."*

**Note:** Hermes has no `before_tool_call` hook for blocking other tools (unlike OpenClaw). The agent is guided via memory instructions, not forced. For strict blocking, consider using the MCP server integration instead.

### "Skills" disambiguation
Hermes has its own "skills" concept (prompt+tool bundles in `~/.hermes/skills/`). Unbrowse also uses "skills" for API endpoint bundles. The plugin's tool descriptions clarify: "unbrowse skill" = API endpoint bundle, not a Hermes skill.

## Example Session

```
You: Get the trending repos on GitHub
Agent: [calls unbrowse with action=resolve, intent="get trending repositories", url="https://github.com/trending"]
Agent: Here are today's trending repositories:
  1. vercel/ai - 2,847 stars today
  2. anthropics/claude-code - 1,523 stars today
  ...
```

## Actions

| Action | Description | Required params |
|--------|-------------|-----------------|
| `resolve` | Reverse-engineer a website into API endpoints | `intent`, `url` |
| `search` | Search the Unbrowse skill marketplace | `intent` |
| `execute` | Execute a cached skill endpoint | `skillId`, `endpointId` |
| `login` | Authenticate with a website | `url` |
| `skills` | List cached skills | -- |
| `skill` | Inspect a specific skill | `skillId` |
| `health` | Check CLI health | -- |

## Optional: MCP Alternative

Hermes natively supports MCP servers. If you prefer the MCP approach (which works across multiple frameworks):

```bash
hermes mcp add unbrowse -- npx -y @unbrowse/mcp-server
```

This gives you the same tools without the Python plugin, but you lose `memory_instructions()` routing guidance.

## Development

```bash
cd integrations/hermes
pip install -e .
python -m pytest tests/   # 22 tests
```
