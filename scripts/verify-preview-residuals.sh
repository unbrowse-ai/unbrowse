#!/usr/bin/env bash
# End-to-end witness for the Chromium navigation and npm OIDC truth seams.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

bun test \
  tests/breath-go-session-and-timeout.test.ts \
  tests/auth.test.ts \
  tests/deploy-preview-publish-truth.test.ts

bash -n scripts/publish-npm-via-public-oidc.sh
node - <<'NODE'
const fs = require("fs");
const yaml = require("yaml");
for (const file of [".github/workflows/deploy.yml", ".github/workflows/release.yml"]) {
  yaml.parse(fs.readFileSync(file, "utf8"));
}
NODE

cmp -s src/cli-v7/breath/go.ts packages/skill/src/cli-v7/breath/go.ts

# Exercise the real Chromium boundary without inheriting a user's browser state.
VERIFY_HOME="$(mktemp -d)"
SESSION_ID=""
cleanup() {
  if [ -n "$SESSION_ID" ]; then
    HOME="$VERIFY_HOME" UNBROWSE_NON_INTERACTIVE=1 UNBROWSE_TOS_ACCEPTED=1 \
      timeout 15s bun src/cli.ts close --session "$SESSION_ID" --json >/dev/null 2>&1 || true
  fi
  rm -rf -- "$VERIFY_HOME"
}
trap cleanup EXIT

HOME="$VERIFY_HOME" UNBROWSE_NON_INTERACTIVE=1 UNBROWSE_TOS_ACCEPTED=1 \
  timeout 45s bun src/cli.ts go https://example.com --json >"$VERIFY_HOME/go.out" 2>&1

node - "$VERIFY_HOME/go.out" >"$VERIFY_HOME/session-id" <<'NODE'
const fs = require("fs");
const lines = fs.readFileSync(process.argv[2], "utf8").trim().split(/\n/).reverse();
let value;
for (const line of lines) {
  try { value = JSON.parse(line); break; } catch {}
}
if (!value || value.operational_ok !== true || value.task_ok !== true) process.exit(1);
if (!/^https:\/\/example\.com\/?$/.test(value.final_url || "")) process.exit(1);
if (!String(value.page?.text || value.page_text || value.text || "").includes("Example Domain")) process.exit(1);
if (!value.session_id) process.exit(1);
process.stdout.write(value.session_id);
NODE
SESSION_ID="$(cat "$VERIFY_HOME/session-id")"

git diff --check
echo "preview residual witness: green"
