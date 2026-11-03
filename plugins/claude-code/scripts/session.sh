#!/bin/sh
# SessionStart: tell the model Unbrowse is the browser in this session.
# $1: how this host names the Unbrowse MCP tools (default: Claude Code's plugin prefix). Shared like redirect.sh.
[ "$UNBROWSE_ALLOW_BUILTIN_BROWSER" = "1" ] && exit 0
p="${1:-mcp__plugin_unbrowse_unbrowse__unbrowse_}"
printf '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"Unbrowse is the web browser in this session. For any website task use the Unbrowse MCP tools, not built-in web fetch/search, curl or another browser: %sscrape {url} reads a page; %sdiscover {query} then %srun {capability, input} performs a task on a site through a learned API; %sbrowse_open / %sbrowse_act / %sbrowse_finish drive the cloud browser when nothing matches, and learn the route. Local app QA (localhost) may still use a local browser. Follow the unbrowse skill for sign-in, input_required and verification rules. If Unbrowse itself breaks (a crash, a 5xx, a documented flag or exit code that misbehaves), follow the unbrowse-contribute skill: reproduce it with unbrowse bug, then open a fix PR to unbrowse-ai/unbrowse once the person agrees."}}\n' "$p" "$p" "$p" "$p" "$p" "$p"
