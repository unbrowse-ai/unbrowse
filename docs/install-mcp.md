# Install the Unbrowse MCP

Unbrowse runs on your computer and gives your agent its tools over MCP. Your agent starts `unbrowse mcp`, which talks to
Unbrowse on your machine. No key or token goes in your agent's settings.

## 1. Install Unbrowse

You need Node 20.3 or newer, on macOS, Linux or Windows.

```bash
npm i -g unbrowse@next
```

Version 13 is on npm under the tag `next` for now: a plain `npm i -g unbrowse` still installs 12.5.0, the hosted client
that has closed. Or download the app for your machine from [Releases](https://github.com/unbrowse-ai/unbrowse/releases).

## 2. Connect your agent

### Claude Code

```bash
unbrowse connect
```

This starts Unbrowse, makes your first agent, adds Unbrowse to Claude Code and checks that it answers. Restart Claude
Code afterwards. If you used the hosted version, `connect` also replaces your old entry. It asks first and can undo the
change. See [Moving to the new Unbrowse](upgrade.md).

To add Claude Code by hand instead, let your agent in once, then add the entry:

```bash
unbrowse grant first
claude mcp add --scope user unbrowse -- unbrowse mcp --agent first
```

### Codex

In `~/.codex/config.toml`:

```toml
[mcp_servers.unbrowse]
command = "unbrowse"
args = ["mcp", "--agent", "first"]
```

Run `unbrowse grant first` once before you start Codex. If you already have an old `[mcp_servers.unbrowse]` table, the
installer in [integrations/codex](../integrations/codex/README.md) replaces it and keeps the rest of the file.

### Cursor

In `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "unbrowse": { "command": "unbrowse", "args": ["mcp", "--agent", "first"] }
  }
}
```

### VS Code

Run the command **MCP: Open User Configuration** and add:

```json
{
  "servers": {
    "unbrowse": { "type": "stdio", "command": "unbrowse", "args": ["mcp", "--agent", "first"] }
  }
}
```

### Gemini CLI

In `~/.gemini/settings.json`:

```json
{
  "mcpServers": {
    "unbrowse": { "command": "unbrowse", "args": ["mcp", "--agent", "first"] }
  }
}
```

### Zed

In Zed's `settings.json`:

```json
{
  "context_servers": {
    "unbrowse": { "command": "unbrowse", "args": ["mcp", "--agent", "first"] }
  }
}
```

### Any other MCP client

Use the same command, `unbrowse mcp --agent first`, over stdio. For Cursor, VS Code, Gemini and Zed, `unbrowse connect`
prints the line for your version and the file it goes in.

Run `unbrowse grant first` once for any agent you add by hand. The owner is asked, and the answer is kept on your
machine.

## 3. Check it works

Restart your agent and ask it to get something from a website, for example "Use Unbrowse to find the top story on Hacker
News". The first time on a site takes a few seconds while Unbrowse learns it. After that it is quick.

## More than one agent

`--agent first` uses the agent Unbrowse made when it first started. To give another agent its own key, run
`unbrowse agent new <name>`. It prints the agent's number. Run `unbrowse grant <number>` once and use `--agent <number>` in that agent's settings.

## If it doesn't work

- **The agent lists no Unbrowse tools.** Restart the agent. Then make sure Unbrowse is running: open the Unbrowse app, or
  run `unbrowse start`.
- **"The owner hasn't let the node's first agent key in on this machine yet."** Run `unbrowse grant first`, or
  `unbrowse connect`.
- **You still see the old hosted tools, or a message that the service has moved.** An old entry is still there. Run
  `unbrowse connect --dry-run` to find it.
- More fixes: [Troubleshooting](TROUBLESHOOTING.md).
