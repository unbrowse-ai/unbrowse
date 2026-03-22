# Hermes Agent Framework — Unbrowse Integration Research

**Framework:** [Hermes Agent](https://hermes-agent.nousresearch.com/) by NousResearch  
**Repo:** https://github.com/NousResearch/hermes-agent  
**Latest release:** v0.3.0 (2026-03-17)  
**Language:** Python (core), with MCP support for polyglot extensions  

---

## Overview

Hermes is an open-source autonomous AI agent with persistent cross-session memory, a self-improving skills system, and multi-platform messaging (Telegram, Discord, Slack, WhatsApp). It ships 50+ built-in tools and supports two extension mechanisms: **plugins** (Python files or pip packages) and **skills** (bundled tool + prompt + config packages).

---

## Tool Registration System

Tools are registered via a central `ToolRegistry`. Each tool is a Python object passed to `registry.register()` with:

```python
registry.register(
    name="my_tool",
    toolset="my_toolset",
    schema={
        "type": "object",
        "properties": {
            "query": {"type": "string", "description": "..."},
        },
        "required": ["query"],
    },
    handler=my_handler_fn,          # async fn(params) -> str (must return JSON string)
    check_fn=lambda: True,          # availability check, e.g. env var present
    requires_env=["MY_API_KEY"],    # declared env vars
)
```

- All handlers **must return a JSON string**.
- Tools are grouped into toolsets, either `_HERMES_CORE_TOOLS` (always loaded) or custom toolsets.
- Adding a new tool requires both `model_tools.py` (import in `_discover_tools()`) and `toolsets.py` (toolset membership).

---

## Plugin System

### Drop-in plugins (no pip required)
Place a `.py` file in `~/.hermes/plugins/`. Hermes scans this directory on startup and auto-loads any Python module found there.

### Package-based plugins (pip entry points)
Any pip package can register tools by declaring the `hermes_agent.plugins` entry point. When Hermes starts, it discovers and calls the package's `register()` function:

```python
# setup.py / pyproject.toml entry point
[project.entry-points."hermes_agent.plugins"]
my_plugin = "my_package.plugin:register"
```

```python
# my_package/plugin.py
def register(registry):
    registry.register(name="my_tool", ...)

def register_tools():
    """Optional: called directly when skipping auto-discovery."""
    ...

def memory_instructions():
    """Optional: return a string injected into the agent's memory system prompt."""
    return "When using my_tool, always ..."
```

The `register_tools()` and `memory_instructions()` functions allow manual registration when you need control over tags, recall filters, or want to bypass the entry-point discovery path (e.g., the `hindsight-hermes` memory plugin uses this pattern).

---

## Browser / Web Tools

Hermes has built-in browser tools via Chrome DevTools Protocol (CDP):

- `/browser connect` — attach to a running Chrome at a CDP endpoint
- `/browser status` — check connection
- `/browser disconnect`

Built-in web tools include: web search, terminal, file system, browser automation (CDP), vision, code execution, subagent delegation, and more.

The browser automation approach is **live-Chrome CDP**, not a headless sandbox — the agent interacts with the user's actual browser session, which means cookies/auth state are naturally present.

Hermes also supports connecting to any **MCP server** for extended tool capabilities, making it compatible with the Chrome DevTools MCP, Playwright MCP, etc.

---

## Skills System (Hermes-specific concept)

Hermes "skills" are distinct from tools — they are **bundles of tools + prompts + config + scripts** stored in `~/.hermes/skills/<category>/<skill-name>/`. Each skill requires a `SKILL.md` file documenting purpose, usage, and dependencies.

Skills can include shell scripts and reference other Hermes tools. They are self-improving: Hermes updates skills based on usage feedback.

This is a different concept from unbrowse "skills" (API endpoint bundles) — naming collision to be aware of.

---

## Integration Points for Unbrowse

### Recommended approach: pip plugin package (`unbrowse-hermes`)

The cleanest integration mirrors the `hindsight-hermes` pattern — a pip-installable package that:

1. Declares `hermes_agent.plugins` entry point pointing to a `register()` function
2. Registers an `unbrowse` tool via `registry.register()`
3. Optionally provides `memory_instructions()` to guide the agent to prefer unbrowse over the browser tool

This is the **Python equivalent** of the OpenClaw TypeScript plugin pattern.

### Tool schema mapping (OpenClaw → Hermes)

| OpenClaw concept | Hermes equivalent |
|---|---|
| `api.registerTool({ name, description, parameters, execute })` | `registry.register(name, schema, handler)` |
| `api.registerHook("before_tool_call", ...)` | No direct hook system; use `check_fn` or wrap the browser tool handler |
| `api.registerHook("before_prompt_build", ...)` | `memory_instructions()` return value |
| `api.registerHook("agent:bootstrap", ...)` | No direct equivalent; inject via `memory_instructions()` |
| `api.registerService({ start })` | `register()` can run startup logic directly |
| `api.registerCli(...)` | No equivalent; CLI debug commands not supported in plugin API |
| `api.logger.info(...)` | `import logging; logging.getLogger("hermes").info(...)` |

### Blocking the browser tool

Hermes has no `before_tool_call` hook equivalent for blocking other tools. The strictest approach is to wrap/override the browser tool's handler in the plugin's `register()` by re-registering the same tool name with a new handler that checks if unbrowse should handle the request first — though this is fragile.

A safer approach: use `memory_instructions()` to strongly instruct the agent to prefer `unbrowse`, and document that strict-mode browser blocking is not available in Hermes (unlike OpenClaw).

---

## Code Sketch: unbrowse-hermes plugin

```python
# unbrowse_hermes/plugin.py
import json, subprocess, shutil

TOOL_NAME = "unbrowse"

def register(registry):
    registry.register(
        name=TOOL_NAME,
        toolset="web",
        schema={
            "type": "object",
            "properties": {
                "action": {
                    "type": "string",
                    "enum": ["resolve", "search", "execute", "login", "skills", "skill", "health"],
                    "description": "Unbrowse action to perform",
                },
                "intent": {"type": "string", "description": "Plain-English task or search intent"},
                "url": {"type": "string", "description": "Target website URL"},
                "skillId": {"type": "string", "description": "Skill id for skill/execute actions"},
                "endpointId": {"type": "string", "description": "Endpoint id for execute action"},
            },
            "required": ["action"],
        },
        handler=_handle,
        check_fn=lambda: shutil.which("unbrowse") is not None,
        requires_env=[],  # optional: UNBROWSE_URL for self-hosted backend
    )

async def _handle(params: dict) -> str:
    args = _build_args(params)
    result = subprocess.run(
        ["unbrowse"] + args,
        capture_output=True, text=True, timeout=120,
    )
    try:
        return result.stdout.strip() or json.dumps({"error": result.stderr.strip()})
    except Exception as e:
        return json.dumps({"error": str(e)})

def memory_instructions() -> str:
    return (
        "You have an `unbrowse` tool that reverse-engineers websites into reusable API skills. "
        "Use `unbrowse` first for any website data extraction, search, or authenticated reads. "
        "Only fall back to the browser tool for visual QA, drag-drop, canvas apps, or file uploads."
    )

def _build_args(params: dict) -> list[str]:
    action = params["action"]
    if action == "health": return ["health"]
    if action == "skills": return ["skills"]
    if action == "skill": return ["skill", params["skillId"]]
    if action == "login": return ["login", "--url", params["url"]]
    if action == "search": return ["search", "--intent", params["intent"]]
    if action == "resolve":
        return ["resolve", "--intent", params["intent"], "--url", params["url"]]
    if action == "execute":
        return ["execute", "--skill", params["skillId"], "--endpoint", params["endpointId"]]
    raise ValueError(f"Unsupported action: {action}")
```

**`pyproject.toml` entry point:**
```toml
[project.entry-points."hermes_agent.plugins"]
unbrowse = "unbrowse_hermes.plugin:register"
```

---

## Framework-Specific Quirks

1. **Python-only plugin API** — no TypeScript/JS plugin SDK exists. The TypeScript pattern from OpenClaw does not port directly; you need a Python wrapper that shells out to the `unbrowse` CLI (same subprocess pattern as the OpenClaw plugin, just in Python).

2. **No tool-blocking hooks** — unlike OpenClaw's `before_tool_call` hook, Hermes has no interceptor API for blocking other tools. Browser routing enforcement must rely on memory/prompt guidance.

3. **"Skills" name collision** — Hermes uses "skills" for its own prompt-bundle system; unbrowse also uses "skills" for API endpoint bundles. Documentation and tool descriptions must disambiguate (e.g., "unbrowse skill" vs "Hermes skill").

4. **MCP as an alternative** — Hermes supports MCP servers natively. An MCP-based unbrowse server would work across Hermes, OpenClaw, Claude Desktop, and any other MCP-compatible host without framework-specific code. This may be worth pursuing in parallel with the native plugin.

5. **Live Chrome CDP** — Hermes browser automation connects to the user's real Chrome session (not a headless browser). Unbrowse's cookie/auth syncing from the local browser vault is directly compatible with this approach.

6. **Entry-point plugin discovery** — plugins only auto-load if installed as pip packages with the entry point declared. Drop-in `~/.hermes/plugins/` files are an easier dev/test path but aren't packageable as PyPI releases.

---

## Sources

- [Hermes Agent GitHub](https://github.com/NousResearch/hermes-agent)
- [Hermes Agent Documentation](https://hermes-agent.nousresearch.com/docs/)
- [Creating Skills](https://hermes-agent.nousresearch.com/docs/developer-guide/creating-skills/)
- [Tools & Toolsets](https://hermes-agent.nousresearch.com/docs/user-guide/features/tools/)
- [Browser Automation](https://hermes-agent.nousresearch.com/docs/user-guide/features/browser/)
- [v0.3.0 Release Notes](https://github.com/NousResearch/hermes-agent/releases/tag/v2026.3.17)
- [hindsight-hermes memory plugin example](https://hindsight.vectorize.io/blog/2026/03/17/hermes-agent-memory)
- [toolsets.py source](https://github.com/NousResearch/hermes-agent/blob/main/toolsets.py)
- [DeepWiki memory systems](https://deepwiki.com/NousResearch/hermes-agent/4.4-memory-systems)
