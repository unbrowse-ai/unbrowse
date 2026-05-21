#!/usr/bin/env bash
# verify.sh — rebuild-the-unbrowse-sdk-as-a-thin-http-first-ty
# Substrate-faithful: each lane emits raw evidence rows; the agent judges convergence.
# Never claims PASS/FAIL on its own; exit code mirrors the worst lane's exit but the
# row in lanes.jsonl is the truth.

set -u
SCAFFOLD_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROJECT_ROOT="$(cd "${SCAFFOLD_DIR}/../.." && pwd)"
LEDGER="${SCAFFOLD_DIR}/ledgers/lanes.jsonl"
mkdir -p "${SCAFFOLD_DIR}/ledgers" "${SCAFFOLD_DIR}/references/research"

ts() { date -u +"%Y-%m-%dT%H:%M:%SZ"; }
row() {
  # row <lane> <status> <evidence-json-fragment>
  local lane="$1" status="$2" evidence="$3"
  printf '{"ts":"%s","lane":"%s","status":"%s","evidence":%s}\n' \
    "$(ts)" "$lane" "$status" "$evidence" >> "$LEDGER"
}

worst_exit=0
bump() { (( $1 > worst_exit )) && worst_exit=$1; }

# ---------- L1: research files cite >=4 reference SDKs ----------
echo "[L1] research citations"
RESEARCH_DIR="${SCAFFOLD_DIR}/references/research"
expected=(resend openai replicate stripe vercel)
present=()
cited=()
for ref in "${expected[@]}"; do
  f="${RESEARCH_DIR}/${ref}.md"
  if [[ -f "$f" ]]; then
    present+=("$ref")
    # need at least one source_id line: 'source_id:' or a deepwiki/gh URL
    if grep -qE 'source_id:|deepwiki|github\.com|api\.github\.com' "$f"; then
      cited+=("$ref")
    fi
  fi
done
p_count=${#present[@]}; c_count=${#cited[@]}
if (( c_count >= 4 )); then
  echo "  [L1] OK ($c_count/5 reference SDKs cited)"
  row "L1-research" "ok" "{\"present\":$p_count,\"cited\":$c_count,\"sdks\":\"${cited[*]}\"}"
else
  echo "  [L1] MISSING ($c_count/4+ required cited; present=$p_count)"
  row "L1-research" "missing" "{\"present\":$p_count,\"cited\":$c_count,\"missing\":\"$((4 - c_count)) more needed\"}"
  bump 1
fi

# ---------- L2: packages/sdk-v2 builds + typechecks ----------
echo "[L2] sdk-v2 build + typecheck"
SDK="${PROJECT_ROOT}/packages/sdk-v2"
if [[ ! -d "$SDK" ]]; then
  echo "  [L2] MISSING packages/sdk-v2/"
  row "L2-sdk-build" "missing" "{\"reason\":\"packages/sdk-v2 does not exist yet\"}"
  bump 2
elif [[ ! -f "$SDK/package.json" ]]; then
  echo "  [L2] MISSING packages/sdk-v2/package.json"
  row "L2-sdk-build" "missing" "{\"reason\":\"no package.json\"}"
  bump 2
else
  cd "$SDK"
  if bun --bun tsc --noEmit 2>"${SCAFFOLD_DIR}/logs/.l2-tsc.err"; then
    echo "  [L2] OK (tsc clean)"
    row "L2-sdk-build" "ok" "{\"tsc\":\"clean\"}"
  else
    err_tail="$(tail -3 "${SCAFFOLD_DIR}/logs/.l2-tsc.err" 2>/dev/null | tr -d '\n' | head -c 240 | sed 's/"/\\"/g')"
    echo "  [L2] FAIL tsc: ${err_tail}"
    row "L2-sdk-build" "fail" "{\"tsc_err\":\"${err_tail}\"}"
    bump 3
  fi
  cd "$PROJECT_ROOT"
fi

# ---------- L3: live HTTPS probe to deployed backend ----------
echo "[L3] live https probe -> beta-api.unbrowse.ai"
STATS_URL="https://beta-api.unbrowse.ai/v1/stats/summary"
code=$(curl -sS -o /tmp/.l3-stats.json -w "%{http_code}" --max-time 10 "$STATS_URL" || echo "000")
if [[ "$code" == "200" ]] && head -c 1 /tmp/.l3-stats.json | grep -q '{'; then
  echo "  [L3] OK 200 from $STATS_URL"
  row "L3-live-probe" "ok" "{\"url\":\"$STATS_URL\",\"status\":200}"
else
  echo "  [L3] FAIL http=$code"
  row "L3-live-probe" "fail" "{\"url\":\"$STATS_URL\",\"status\":\"$code\"}"
  bump 4
fi
# Lane L3b: if test key present in .env, probe authenticated route too
if [[ -f "${PROJECT_ROOT}/.env" ]] && grep -q "^UNBROWSE_TEST_API_KEY=" "${PROJECT_ROOT}/.env"; then
  key="$(grep '^UNBROWSE_TEST_API_KEY=' "${PROJECT_ROOT}/.env" | head -1 | cut -d= -f2- | tr -d '"'"'")"
  if [[ -n "$key" && "$key" =~ ^ubr_ ]]; then
    code2=$(curl -sS -o /tmp/.l3b.json -w "%{http_code}" --max-time 15 \
      -H "Authorization: Bearer $key" \
      -H "Content-Type: application/json" \
      -d '{"intent":"healthcheck"}' \
      "https://beta-api.unbrowse.ai/v1/resolve" || echo "000")
    if [[ "$code2" =~ ^2 ]]; then
      echo "  [L3b] OK authenticated $code2"
      row "L3b-auth-probe" "ok" "{\"status\":$code2}"
    else
      echo "  [L3b] FAIL authenticated $code2"
      row "L3b-auth-probe" "fail" "{\"status\":\"$code2\"}"
      # do not bump — L3b is aspirational until keys endpoint ships
    fi
  fi
fi

# ---------- L4: docs site builds ----------
echo "[L4] docs site build"
DOCS_CANDIDATES=("${PROJECT_ROOT}/packages/docs" "${PROJECT_ROOT}/docs-site" "${PROJECT_ROOT}/frontend/docs")
docs_dir=""
for d in "${DOCS_CANDIDATES[@]}"; do
  if [[ -d "$d" && -f "$d/package.json" ]]; then docs_dir="$d"; break; fi
done
if [[ -z "$docs_dir" ]]; then
  echo "  [L4] MISSING docs site (looked in: ${DOCS_CANDIDATES[*]})"
  row "L4-docs-build" "missing" "{\"reason\":\"no docs site dir with package.json\"}"
  bump 5
else
  cd "$docs_dir"
  if bun --bun run build >"${SCAFFOLD_DIR}/logs/.l4-build.log" 2>&1; then
    echo "  [L4] OK (build clean) in $docs_dir"
    row "L4-docs-build" "ok" "{\"dir\":\"$docs_dir\"}"
  else
    err_tail="$(tail -5 "${SCAFFOLD_DIR}/logs/.l4-build.log" 2>/dev/null | tr -d '\n' | head -c 240 | sed 's/"/\\"/g')"
    echo "  [L4] FAIL build: ${err_tail}"
    row "L4-docs-build" "fail" "{\"dir\":\"$docs_dir\",\"err\":\"${err_tail}\"}"
    bump 6
  fi
  cd "$PROJECT_ROOT"
fi

# ---------- L5: principle landed in applied.jsonl citing >=3 refs ----------
echo "[L5] principle in applied.jsonl"
APPLIED="$HOME/.claude/skills/meta-harness/.principle-queue/applied.jsonl"
if [[ ! -f "$APPLIED" ]]; then
  echo "  [L5] applied.jsonl missing"
  row "L5-principle" "missing" "{\"reason\":\"applied.jsonl not yet created\"}"
  bump 7
else
  # match rows whose proposal mentions 'sdk' AND cites >=3 reference SDK names
  match=$(grep -i '"proposal"' "$APPLIED" | grep -i 'sdk' | head -5 || true)
  if [[ -z "$match" ]]; then
    echo "  [L5] no sdk-design principle row yet"
    row "L5-principle" "missing" "{\"reason\":\"no sdk principle in applied store\"}"
    bump 8
  else
    refs_hit=0
    for r in resend openai replicate stripe vercel anthropic; do
      if echo "$match" | grep -qi "$r"; then ((refs_hit++)); fi
    done
    if (( refs_hit >= 3 )); then
      echo "  [L5] OK principle cites $refs_hit reference SDKs"
      row "L5-principle" "ok" "{\"refs_cited\":$refs_hit}"
    else
      echo "  [L5] principle present but only $refs_hit refs cited (need >=3)"
      row "L5-principle" "partial" "{\"refs_cited\":$refs_hit}"
      bump 8
    fi
  fi
fi

echo
echo "[verify] worst_exit=$worst_exit  (0=all-lanes-ok; non-zero=evidence in lanes.jsonl)"
exit "$worst_exit"
