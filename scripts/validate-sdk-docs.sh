#!/usr/bin/env bash
# Falsifiable signals for the SDK + onboarding docs.
# Catches drift between docs/sdk/, packages/sdk/docs/, and the actual code.
#
# Three luminaries:
#   1. relative markdown links resolve
#   2. every /v1/<path> mentioned exists as a Hono route somewhere
#      (handlers register the suffix; /v1/ prefix is added at mount time)
#   3. every `unbrowse <cmd>` mentioned exists in src/cli.ts dispatch
#
# Exit non-zero on any failure. Run from repo root.
set -u
cd "$(dirname "$0")/.."

FAILFILE=$(mktemp)
trap 'rm -f "$FAILFILE"' EXIT
fail() { echo 1 >> "$FAILFILE"; }

RED=$'\033[31m'; GREEN=$'\033[32m'; YEL=$'\033[33m'; RESET=$'\033[0m'

DOCS=(
  README.md
  packages/skill/SKILL.md
  docs/README.md
  docs/archive/README.md
  docs/OPEN-SOURCE-NOTICE.md
  docs/sdk/build-on-unbrowse.md
  docs/sdk/developer-recipes.md
  docs/sdk/onboarding-users.md
  docs/sdk/developer-recipes.md
  docs/frontend-dashboard-plan.md
  docs/sdk/build-on-unbrowse.md
  packages/sdk/docs/README.md
  packages/sdk/docs/getting-started/installation.md
  packages/sdk/docs/getting-started/first-validator.md
  packages/sdk/docs/api-reference/README.md
  packages/sdk/docs/api-reference/resolve.md
  packages/sdk/docs/api-reference/execute.md
  packages/sdk/docs/api-reference/auth.md
  packages/sdk/docs/api-reference/rewards.md
  packages/sdk/docs/examples/README.md
  packages/sdk/docs/examples/swarm-validator.md
  packages/sdk/docs/examples/login-then-mine.md
  packages/sdk/docs/examples/data-extraction.md
)

ROUTE_DIRS="src/api backend/src"
CLI=src/cli.ts

echo "${YEL}== Luminary 1: relative markdown links ==${RESET}"
for f in "${DOCS[@]}"; do
  if [ ! -f "$f" ]; then echo "${RED}MISSING DOC: $f${RESET}"; fail; continue; fi
  dir=$(dirname "$f")
  while IFS= read -r link; do
    target="${link%%#*}"; target="${target%%\?*}"
    [ -z "$target" ] && continue
    case "$target" in
      /*) resolved="${target#/}" ;;
      *)  resolved="$dir/$target" ;;
    esac
    resolved=$(python3 -c "import os,sys; print(os.path.normpath(sys.argv[1]))" "$resolved" 2>/dev/null || echo "$resolved")
    if [ ! -e "$resolved" ]; then
      echo "${RED}BROKEN LINK${RESET} $f -> $target (resolved: $resolved)"
      fail
    fi
  done < <(grep -oE '\]\(([^)]+)\)' "$f" | sed -E 's/^\]\(//; s/\)$//' | grep -vE '^(https?:|mailto:|#)')
done

echo "${YEL}== Luminary 2: /v1/* paths exist somewhere as Hono route suffix ==${RESET}"
# Build a corpus of all string literals in route files (single + double + backtick).
ROUTE_CORPUS=$(grep -rhoE '"[^"]*"|`[^`]*`|'"'[^']*'" $ROUTE_DIRS 2>/dev/null | tr -d "\"\`'" | sort -u)
for f in "${DOCS[@]}"; do
  [ -f "$f" ] || continue
  # Strip lines between <!-- validator:skip-routes-below --> markers so we don't
  # falsely flag routes the doc has explicitly labelled as proposed/future.
  doc_filtered=$(awk '/<!-- validator:skip-routes-below -->/{skip=1; next} /<!-- \/validator:skip-routes-below -->/{skip=0; next} !skip' "$f" | grep -vE 'GREENFIELD|needs new|requires new|proposed|do NOT exist|does NOT exist|NEW backend|new backend|coming soon|not built|not yet')
  while IFS= read -r path; do
    [ -z "$path" ] && continue
    suffix="${path#/v1}"
    path_clean=$(echo "$path" | sed -E 's/[.,)`]+$//')
    suffix_clean=$(echo "$suffix" | sed -E 's/[.,)`]+$//')
    if echo "$ROUTE_CORPUS" | grep -qF "$path_clean"; then continue; fi
    if echo "$ROUTE_CORPUS" | grep -qF "$suffix_clean"; then continue; fi
    norm=$(echo "$suffix_clean" | sed -E 's#:[A-Za-z0-9_]+#:[A-Za-z0-9_]+#g')
    if echo "$ROUTE_CORPUS" | grep -qE "$(echo "$norm" | sed 's#[][/.]#\\&#g')"; then continue; fi
    stem="${suffix_clean%%:*}"
    if [ -n "$stem" ] && echo "$ROUTE_CORPUS" | grep -qF "$stem"; then continue; fi
    echo "${RED}MISSING ROUTE${RESET} $path  (mentioned in $f)"
    fail
  done < <(echo "$doc_filtered" | grep -oE '/v1/[A-Za-z0-9/_:.\-]+' | sed -E 's/[.,)`]+$//' | sort -u)
done

echo "${YEL}== Luminary 3: unbrowse <cmd> exists in cli.ts ==${RESET}"
if [ ! -f "$CLI" ]; then
  echo "${RED}cli.ts not found at $CLI${RESET}"; fail
else
  for f in "${DOCS[@]}"; do
    [ -f "$f" ] || continue
    while IFS= read -r sub; do
      [ -z "$sub" ] && continue
      case "$sub" in --*|setup|help) continue ;; esac
      if ! grep -qE "(command === \"$sub\"|case \"$sub\")" "$CLI"; then
        # account for deprecated aliases that still work
        if grep -qE "\"$sub\".*deprecated|deprecated.*\"$sub\"" "$CLI" 2>/dev/null; then continue; fi
        echo "${RED}MISSING CLI${RESET} unbrowse $sub  (mentioned in $f)"
        fail
      fi
    done < <(grep -hoE '`unbrowse [a-z][a-z\-]*' "$f" | sed -E 's/^`unbrowse //' | sort -u)
  done
fi
echo "${YEL}== Luminary 4: frontend/src/app/ paths cited in frontend-dashboard-plan.md exist ==${RESET}"
PLAN=docs/frontend-dashboard-plan.md
if [ -f "$PLAN" ]; then
  # Extract `frontend/src/app/...` paths from inline code spans + bare references.
  # We look for the path token, strip trailing punctuation, and check disk existence.
  while IFS= read -r p; do
    [ -z "$p" ] && continue
    # strip backticks, parens, trailing punctuation
    cleaned=$(echo "$p" | sed -E 's/[`\)\.,;:]+$//; s/^`//')
    # turn template segments like [wallet] or [id] into a glob test by checking the parent
    # if the path has a [bracket], check that the parent directory has matching dynamic dir
    if [[ "$cleaned" == *"["*"]"* ]]; then
      parent=$(dirname "$cleaned")
      base=$(basename "$cleaned")
      if [ ! -e "$parent" ] || ! ls "$parent" 2>/dev/null | grep -q "^\[" ; then
        echo "${RED}MISSING FRONTEND PATH${RESET} $cleaned  (parent $parent has no dynamic [..] segment)"
        fail
      fi
    else
      if [ ! -e "$cleaned" ]; then
        echo "${RED}MISSING FRONTEND PATH${RESET} $cleaned  (cited in $PLAN)"
        fail
      fi
    fi
  done < <(grep -hoE 'frontend/src/app/[A-Za-z0-9/_\.\-\[\]]+' "$PLAN" | sort -u)
fi

if [ ! -s "$FAILFILE" ]; then
  echo "${GREEN}ALL OK${RESET}"
  exit 0
else
  echo "${RED}validation failed ($(wc -l < "$FAILFILE" | tr -d ' ') signals tripped)${RESET}"
  exit 1
fi
