#!/usr/bin/env bash
# check-dropins-publishable.sh — the gate for the drop-in npm CI/CD.
#
# For every drop-in package: build it, then `npm pack --dry-run` and assert the
# tarball actually ships dist/index.js and is not bloated by an accidentally
# bundled peer dep (a multi-MB tarball means an --external flag is missing). Also
# validates the publish workflow YAML parses. No secrets, no network publish —
# this proves the packages are publish-READY so CI can publish them for real.
#
#   bash scripts/check-dropins-publishable.sh

set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

PKGS=(axios-shim got-shim ky-shim node-fetch-shim cross-fetch-shim \
      undici-shim superagent-shim wretch-shim \
      puppeteer-shim playwright-shim selenium-shim stagehand-shim \
      firecrawl-shim exa-shim tavily-shim \
      ai-sdk langchain-js mastra llamaindex openai-agents \
      adopt)
MAX_KB=2048          # a tarball over this means a peer dep got bundled (missing --external)
WORKFLOW=".github/workflows/publish-dropins.yml"

fail=0
printf '%-18s %-10s %-10s %s\n' "PACKAGE" "BUILD" "DIST" "SIZE"
printf '%s\n' "------------------------------------------------------------"

for p in "${PKGS[@]}"; do
  dir="packages/$p"
  if [[ ! -f "$dir/package.json" ]]; then
    printf '%-18s %s\n' "$p" "MISSING package.json"; fail=1; continue
  fi
  if ( cd "$dir" && npm run build >/tmp/dropin-build-$p.log 2>&1 ); then build=ok; else build=FAIL; fi
  if [[ "$build" != ok ]]; then
    printf '%-18s %-10s %s\n' "$p" "$build" "$(tail -1 /tmp/dropin-build-$p.log)"; fail=1; continue
  fi
  read -r kb hasdist < <(cd "$dir" && npm pack --dry-run --json 2>/dev/null | python3 -c "
import sys,json
d=json.load(sys.stdin)[0]
has=any(f['path'].endswith('dist/index.js') for f in d['files'])
print(round(d['unpackedSize']/1024), 'yes' if has else 'no')
" 2>/dev/null || echo "0 err")
  dist="$hasdist"; size="${kb}KB"
  row_ok=1
  [[ "$hasdist" == yes ]] || { dist="NO-DIST"; row_ok=0; }
  if [[ "$kb" -gt "$MAX_KB" ]]; then size="${kb}KB!BLOAT"; row_ok=0; fi
  [[ $row_ok -eq 1 ]] || fail=1
  printf '%-18s %-10s %-10s %s\n' "$p" "$build" "$dist" "$size"
done

printf '%s\n' "------------------------------------------------------------"
# workflow YAML must parse
if [[ -f "$WORKFLOW" ]]; then
  if python3 -c "import yaml,sys; yaml.safe_load(open('$WORKFLOW'))" 2>/dev/null; then
    echo "workflow: $WORKFLOW parses OK"
  else
    echo "workflow: $WORKFLOW — INVALID YAML"; fail=1
  fi
else
  echo "workflow: $WORKFLOW — MISSING"; fail=1
fi

if [[ $fail -ne 0 ]]; then
  echo "NOT publish-ready — fix the rows above."; exit 1
fi
echo "ALL ${#PKGS[@]} drop-in packages are publish-ready (build + dist + size) and the workflow is valid."
exit 0
