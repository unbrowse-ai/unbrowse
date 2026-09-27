#!/bin/sh
# MCP headers for the hosted Unbrowse server (.mcp.json headersHelper).
# Key: UNBROWSE_API_KEY if Claude Code passes it through, else the key saved by `unbrowse login --key <key>`
# (~/.config/unbrowse/cli.json). No key → no headers, so Claude Code signs in with OAuth (/mcp → Authenticate).
# Claude Code drops *KEY*/*TOKEN* variables from this script's environment, hence the file.
key="$UNBROWSE_API_KEY"
if [ -z "$key" ]; then
  dir="${UNBROWSE_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/unbrowse}"
  [ -r "$dir/cli.json" ] && key=$(sed -n 's/.*"apiKey"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$dir/cli.json" | head -n 1)
fi
if [ -z "$key" ]; then printf '{}\n'; exit 0; fi
if [ -n "$UNBROWSE_END_USER" ]; then
  printf '{"Authorization":"Bearer %s","X-Unbrowse-End-User":"%s"}\n' "$key" "$UNBROWSE_END_USER"
else
  printf '{"Authorization":"Bearer %s"}\n' "$key"
fi
