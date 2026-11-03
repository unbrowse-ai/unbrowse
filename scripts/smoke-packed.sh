#!/usr/bin/env bash
# Install the packed tarballs into an empty project on plain Node and run them. No account needed.
set -euo pipefail
SDK_TGZ="$(realpath "$1")"; CLI_TGZ="$(realpath "$2")"
DIR="$(mktemp -d)"
trap 'rm -rf "$DIR"' EXIT
cd "$DIR"
npm init -y >/dev/null
npm i --no-audit --no-fund "$SDK_TGZ" "$CLI_TGZ" >/dev/null
./node_modules/.bin/unbrowse --version
./node_modules/.bin/unbrowse help >/dev/null
test -f node_modules/unbrowse/SKILL.md
test -f node_modules/unbrowse/references/tools.json
test -f node_modules/unbrowse/contribute/SKILL.md
# setup from the installed package: both skills and the rule land in a fresh home with Claude Code, and --remove undoes it.
SETUP_HOME="$DIR/home"; mkdir -p "$SETUP_HOME/.claude"
HOME="$SETUP_HOME" ./node_modules/.bin/unbrowse setup --no-mcp 2>/dev/null
test -f "$SETUP_HOME/.claude/skills/unbrowse/SKILL.md"
test -f "$SETUP_HOME/.claude/skills/unbrowse/references/tools.json"
test -f "$SETUP_HOME/.agents/skills/unbrowse-contribute/SKILL.md"
grep -q "unbrowse:begin" "$SETUP_HOME/.claude/CLAUDE.md"
HOME="$SETUP_HOME" ./node_modules/.bin/unbrowse setup --remove 2>/dev/null
test ! -e "$SETUP_HOME/.claude/skills/unbrowse"
node --input-type=module -e '
  import { Unbrowse, DEFAULT_BASE_URL } from "@unbrowse/sdk";
  if (DEFAULT_BASE_URL !== "https://unbrowse.ai/api/v1") throw new Error("wrong default base URL");
  if (process.env.SMOKE_LIVE === "1") {
    const s = await new Unbrowse({ apiKey: "" }).sites("wikipedia");
    if (!(s.total > 0)) throw new Error("public registry returned nothing");
    console.log("live registry:", s.total, "tools");
  }
  console.log("sdk ok");'

echo PACKED_CLIENT_OK
