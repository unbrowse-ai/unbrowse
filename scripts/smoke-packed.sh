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
