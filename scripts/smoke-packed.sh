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

# Signed in, against the live service: what a new user does right after install.sh. Releases set
# SMOKE_SIGNED_IN=1 with the release-QA account's key; a missing key fails instead of skipping.
if [ "${SMOKE_SIGNED_IN:-0}" = "1" ]; then
  if [ -z "${UNBROWSE_API_KEY:-}" ]; then echo "SMOKE_SIGNED_IN=1 needs UNBROWSE_API_KEY (the release-QA key)" >&2; exit 1; fi
  export HOME="$DIR/home"; mkdir -p "$HOME"
  ./node_modules/.bin/unbrowse whoami --json > whoami.json
  node -e 'const w=require("./whoami.json"); if (w.origin !== "https://unbrowse.ai" || !w.workspaceId) { console.error(w); process.exit(1) } console.log("signed in:", w.origin)'
  ./node_modules/.bin/unbrowse run "top stories on Hacker News" --json > run.json
  node -e 'const r=require("./run.json"); const n=r.result?.stories?.length ?? 0;
    if (r.status !== "succeeded" || r.phase !== "verified" || n < 5) { console.error(JSON.stringify(r).slice(0, 800)); process.exit(1) }
    console.log("first run:", r.capabilityId, n, "stories, verified")'
  echo SIGNED_IN_OK
fi

echo PACKED_CLIENT_OK
