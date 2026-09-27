#!/bin/sh
# Opt-in: register the Unbrowse redirect as a global Grok hook (~/.grok/hooks/unbrowse.json).
# Grok 1.0.41 discovers plugin hooks but does not dispatch them; global hooks do run. Remove with --remove.
set -e
dir="${GROK_HOME:-$HOME/.grok}/hooks"
file="$dir/unbrowse.json"
if [ "$1" = "--remove" ]; then rm -f "$file"; echo "removed $file"; exit 0; fi
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
mkdir -p "$dir"
cat > "$file" <<JSON
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "WebSearch|web_search|web_fetch|Bash|playwright__.*|puppeteer__.*|browserbase__.*|chrome-devtools__.*",
        "hooks": [{ "type": "command", "command": "sh \\"$root/scripts/redirect.sh\\" unbrowse__unbrowse_", "timeout": 5 }]
      }
    ]
  }
}
JSON
echo "wrote $file (redirect: $root/scripts/redirect.sh)"
