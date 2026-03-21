# unbrowse-openclaw

Use Unbrowse inside OpenClaw.

This plugin adds a native `unbrowse` tool, teaches agents to use it first for website tasks, and gives you a strict mode that can keep agents off the built-in `browser` tool.

Use it when you want API-first web work: structured extraction, reverse-engineered site actions, less brittle browser automation.

## Quickstart

Install it, make it the default web path, restart OpenClaw, verify it:

```bash
openclaw plugins install unbrowse-openclaw
openclaw config set plugins.entries.unbrowse-openclaw.enabled true --strict-json
openclaw config set plugins.entries.unbrowse-openclaw.config.routingMode '"strict"' --strict-json
openclaw config set plugins.entries.unbrowse-openclaw.config.preferInBootstrap true --strict-json
openclaw gateway restart
openclaw plugins info unbrowse-openclaw
openclaw unbrowse-plugin health
```

What this does:

- installs the plugin
- enables it
- puts it in `strict` mode so normal website tasks route through Unbrowse instead of the built-in `browser`
- injects prompt guidance so agents prefer `unbrowse` before tool selection

Expected verify output:

- `openclaw plugins info unbrowse-openclaw` shows the plugin as loaded
- `openclaw unbrowse-plugin health` returns JSON with `"status":"ok"`

## Choose A Mode

### Strict

Use this if you want Unbrowse to replace the built-in browser for normal website work.

```bash
openclaw config set plugins.entries.unbrowse-openclaw.config.routingMode '"strict"' --strict-json
openclaw gateway restart
```

### Fallback

Use this if you want Unbrowse first, but still want OpenClaw's built-in `browser` available for true UI-only tasks.

```bash
openclaw config set plugins.entries.unbrowse-openclaw.config.routingMode '"fallback"' --strict-json
openclaw gateway restart
```

## Common Commands

```bash
openclaw plugins info unbrowse-openclaw
openclaw unbrowse-plugin health
openclaw unbrowse-plugin print-bootstrap
openclaw unbrowse-plugin print-config strict
openclaw unbrowse-plugin print-config fallback
```

## What Agents Get

Tool:

```json
{
  "action": "resolve",
  "intent": "get pricing page API data",
  "url": "https://example.com"
}
```

Actions: `resolve`, `search`, `execute`, `login`, `skills`, `skill`, `health`

Integration:

- bootstrap guidance plus a `before_prompt_build` system-prompt hint each run
- a shipped `unbrowse-browser` skill so the replacement policy shows up in OpenClaw's skill surface
- strict-mode blocking of the built-in `browser` tool via `before_tool_call`

## How Replacement Works

This plugin makes `unbrowse` the default web path in practice by:

- teaching the agent to prefer `unbrowse`
- shipping a skill that reinforces the policy
- blocking `browser` in strict mode

Strict mode is the closest thing to making Unbrowse the default browser path without patching OpenClaw core.

## Tool Policy

If you use plugin allowlists, trust it:

```json5
{
  plugins: {
    allow: ["unbrowse-openclaw"]
  }
}
```

If you use tool allowlists, allow one of:

- plugin id: `unbrowse-openclaw`
- tool name: `browser`
- tool name: `unbrowse`
- `group:plugins`

Example:

```json5
{
  tools: {
    allow: ["browser", "unbrowse"]
  }
}
```

## Local Dev

Install the local checkout as a linked plugin:

```bash
openclaw plugins install --link /absolute/path/to/unbrowse-openclaw
```

For this monorepo checkout:

```bash
openclaw plugins install --link /absolute/path/to/unbrowse/integrations/openclaw
```

Then enable it and pick a mode:

```bash
openclaw config set plugins.entries.unbrowse-openclaw.enabled true --strict-json
openclaw config set plugins.entries.unbrowse-openclaw.config.routingMode '"strict"' --strict-json
openclaw gateway restart
```

Using `openclaw plugins install` keeps the plugin in OpenClaw's installed-plugin registry instead of relying on workspace-origin `plugins.load.paths`.

## Preset Files

- [examples/openclaw.fallback.json5](./examples/openclaw.fallback.json5)
- [examples/openclaw.strict.json5](./examples/openclaw.strict.json5)

## Dev

```bash
npm test
npm run typecheck
```
