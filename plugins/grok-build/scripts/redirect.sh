#!/bin/sh
# PreToolUse: send the built-in web tools, browser MCPs and `agent-browser` navigation to Unbrowse.
# Local pages (localhost, 127.x, 0.0.0.0, [::1]) stay allowed for app QA.
# Opt out for a session with UNBROWSE_ALLOW_BUILTIN_BROWSER=1.
# $1: how this host names the Unbrowse MCP tools (default: Claude Code's plugin prefix).
# Shared by the Claude Code, Codex and Grok Build plugins (byte-identical copies; scripts/sync-plugins.mjs).
p="${1:-mcp__plugin_unbrowse_unbrowse__unbrowse_}"
input=$(cat)
[ "$UNBROWSE_ALLOW_BUILTIN_BROWSER" = "1" ] && exit 0
# Claude Code and Codex send tool_name; Grok sends toolName (web_fetch, web_search, run_terminal_command).
tool=$(printf '%s' "$input" | sed -n 's/.*"tool_\{0,1\}[nN]ame"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)
is_local() { printf '%s' "$1" | grep -Eqi '^(https?://)?(localhost|127\.[0-9.]+|0\.0\.0\.0|\[::1\])([:/]|$)'; }
case "$tool" in
  WebFetch|web_fetch)
    url=$(printf '%s' "$input" | sed -n 's/.*"url"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)
    is_local "$url" && exit 0
    use="${p}scrape {url} to read the page (clean markdown, renders JS, reuses saved logins)" ;;
  WebSearch|web_search)
    use="${p}discover {query} then ${p}run for a task on a site, or ${p}scrape for a known URL" ;;
  Bash|run_terminal_command)
    printf '%s' "$input" | grep -q 'agent-browser' || exit 0
    url=$(printf '%s' "$input" | sed -nE 's/.*agent-browser.*[[:space:]](open|goto|navigate)[[:space:]]+([^[:space:]"\\;&|]+).*/\2/p' | head -n 1)
    [ -z "$url" ] && exit 0
    is_local "$url" && exit 0
    tool="agent-browser"
    use="${p}scrape {url} to read it, ${p}discover + ${p}run for a task, or ${p}browse_open {url, task} / browse_act / browse_finish to drive the cloud browser (it learns the route)" ;;
  *)
    use="the Unbrowse cloud browser: ${p}browse_open {url, task}, ${p}browse_act, ${p}browse_finish (it learns the route so the next call needs no browser)" ;;
esac
reason="Unbrowse replaces ${tool:-this tool} in this session. Use $use. If the unbrowse tools are not listed yet, search again in a moment (the server may still be connecting). If Unbrowse is not connected, sign in to the unbrowse MCP server (OAuth) or save a key with: npx unbrowse login --key <key>, or set UNBROWSE_ALLOW_BUILTIN_BROWSER=1 to allow the built-in tool."
reason=$(printf '%s' "$reason" | sed 's/\\/\\\\/g; s/"/\\"/g')
printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"%s"}}\n' "$reason"
