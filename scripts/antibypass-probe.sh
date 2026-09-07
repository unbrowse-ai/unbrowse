#!/usr/bin/env bash
set -euo pipefail

# antibypass-probe.sh — verify unbrowse anti-bot challenge solvers against live sites
# Maps each challenge vendor to a live target site, probes via unbrowse breath fetch
# (HTTP-first), then escalates to unbrowse breath go (Chrome + anti-bot spoofing)
# when bot-blocked.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

SITE="all"
VERBOSE=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --site) SITE="$2"; shift 2 ;;
    --verbose) VERBOSE=1; shift ;;
    *) echo "ERROR: unknown argument: $1" >&2
       echo "Usage: $0 [--site <name>] [--verbose]" >&2
       echo "  --site  cloudflare | datadome | perimeterx | akamai | kasada | all" >&2
       exit 1 ;;
  esac
done

declare -A VENDOR_SITES VENDOR_DESC VENDOR_SOLVER
VENDOR_SITES[cloudflare]="https://www.glassdoor.com/Reviews/index.htm"
VENDOR_SITES[datadome]="https://www.vinted.fr/catalog?search_text=nike"
VENDOR_SITES[perimeterx]="https://www.zillow.com/homes/San-Francisco_rb/"
VENDOR_SITES[akamai]="https://www.nike.com/w/mens-shoes-nik1zy7ok"
VENDOR_SITES[kasada]="https://www.canadagoose.com/us/en/shop/mens/parkas"

VENDOR_DESC[cloudflare]="Cloudflare Bot Management"
VENDOR_DESC[datadome]="DataDome"
VENDOR_DESC[perimeterx]="PerimeterX / HUMAN"
VENDOR_DESC[akamai]="Akamai Bot Manager"
VENDOR_DESC[kasada]="Kasada"

VENDOR_SOLVER[cloudflare]="src/execution/cf-challenge.ts"
VENDOR_SOLVER[datadome]="(no dedicated solver — generic pipeline)"
VENDOR_SOLVER[perimeterx]="src/execution/px-challenge.ts"
VENDOR_SOLVER[akamai]="src/execution/akamai-challenge.ts"
VENDOR_SOLVER[kasada]="src/execution/kasada-challenge.ts"

if [[ "$SITE" == "all" ]]; then
  VENDORS=(cloudflare datadome perimeterx akamai kasada)
else
  VENDORS=("$SITE")
fi

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'

log()  { echo -e "${CYAN}[probe]${NC} $*" >&2; }
pass() { echo -e "${GREEN}[PASS]${NC} $*" >&2; }
fail() { echo -e "${RED}[FAIL]${NC} $*" >&2; }
warn() { echo -e "${YELLOW}[WARN]${NC} $*" >&2; }

has_unbrowse() { command -v unbrowse &>/dev/null; }
has_chrome() { command -v google-chrome &>/dev/null || command -v chromium &>/dev/null || command -v chromium-browser &>/dev/null; }

probe_one() {
  local vendor="$1" url="$2"
  local desc="${VENDOR_DESC[$vendor]:-$vendor}"
  local solver="${VENDOR_SOLVER[$vendor]:-unknown}"

  log "============================================================"
  log "Probing $vendor — $desc"
  log "  URL:    $url"
  log "  Solver: $solver"
  log "============================================================"

  log "Step 1: unbrowse breath fetch (HTTP-first) ..."
  local fetch_out fetch_rc
  set +e
  fetch_out="$(unbrowse breath fetch "$url" --json 2>&1)"
  fetch_rc=$?
  set -e

  if [[ "$VERBOSE" -eq 1 ]]; then
    echo "$fetch_out" | head -15
  fi

  local blocked=0
  if echo "$fetch_out" | grep -qiE 'bot-blocked|403 for bidden'; then
    blocked=1
    log "  → bot-blocked detected in fetch response"
  elif [[ "$fetch_rc" -ne 0 ]]; then
    log "  → fetch exited non-zero (rc=$fetch_rc), treating as potential block"
    blocked=1
  else
    log "  → fetch succeeded (no block signal)"
  fi

  if [[ "$blocked" -eq 1 ]]; then
    if ! has_chrome; then
      warn "  → Chrome/Chromium not found — cannot escalate to breath go"
      warn "  → SKIP: no browser available for anti-bot bypass"
      return 2
    fi

    log "Step 2: unbrowse breath go (Chrome + anti-bot spoofing) ..."
    local go_out go_rc
    set +e
    go_out="$(timeout 60 unbrowse breath go "$url" 2>&1)"
    go_rc=$?
    set -e

    if echo "$go_out" | grep -qiE 'bot-blocked|403 for bidden'; then
      fail "$vendor — BLOCK (breath go also blocked)"; return 1
    elif [[ "$go_rc" -ne 0 ]]; then
      fail "$vendor — BLOCK (breath go rc=$go_rc)"; return 1
    else
      pass "$vendor — PASS (breath go bypassed challenge)"; return 0
    fi
  else
    pass "$vendor — PASS (breath fetch returned clean, no block)"; return 0
  fi
}

log "antibypass-probe.sh starting at $(date -u +%Y-%m-%dT%H:%M:%SZ)"
log "Target(s): ${VENDORS[*]}"

if ! has_unbrowse; then
  fail "unbrowse not found on PATH — install with: npm install -g unbrowse@preview && unbrowse setup"
  exit 1
fi
log "unbrowse found at $(command -v unbrowse)"

declare -A RESULTS RESULT_CODES

for vendor in "${VENDORS[@]}"; do
  url="${VENDOR_SITES[$vendor]:-}"
  if [[ -z "$url" ]]; then
    fail "No URL mapped for vendor '$vendor'"
    RESULTS[$vendor]="UNKNOWN"; RESULT_CODES[$vendor]=-1
    continue
  fi
  set +e; probe_one "$vendor" "$url"; rc=$?; set -e
  RESULT_CODES[$vendor]=$rc
  case $rc in 0) RESULTS[$vendor]="PASS";; 1) RESULTS[$vendor]="BLOCK";; 2) RESULTS[$vendor]="SKIP";; *) RESULTS[$vendor]="ERROR";; esac
done

echo ""
echo "============================================================================"
echo "  antibypass-probe SUMMARY — $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "============================================================================"
printf "  %-14s %-22s %-8s %s\n" "VENDOR" "ANTI-BOT SYSTEM" "VERDICT" "SITE"
printf "  %-14s %-22s %-8s %s\n" "------" "---------------" "-------" "----"
for vendor in "${VENDORS[@]}"; do
  desc="${VENDOR_DESC[$vendor]:-$vendor}"
  result="${RESULTS[$vendor]:-UNKNOWN}"
  url="${VENDOR_SITES[$vendor]:-}"
  case "$result" in
    PASS)  vc="${GREEN}PASS${NC}" ;;
    BLOCK) vc="${RED}BLOCK${NC}" ;;
    SKIP)  vc="${YELLOW}SKIP${NC}" ;;
    *)     vc="$result" ;;
  esac
  printf "  %-14s %-22s " "$vendor" "$desc"
  echo -e "${vc}  ${url}"
done
echo "============================================================================"

pass_count=0; block_count=0; skip_count=0
for vendor in "${VENDORS[@]}"; do
  case "${RESULT_CODES[$vendor]:- -1}" in
    0) ((pass_count++)) ;; 1) ((block_count++)) ;; 2) ((skip_count++)) ;;
  esac
done
echo ""
echo "  Tally: ${GREEN}${pass_count} PASS${NC} / ${RED}${block_count} BLOCK${NC} / ${YELLOW}${skip_count} SKIP${NC}"
echo ""
echo "  Challenge solvers tested:"
echo "    Cloudflare  → src/execution/cf-challenge.ts"
echo "    PerimeterX  → src/execution/px-challenge.ts"
echo "    Akamai      → src/execution/akamai-challenge.ts"
echo "    Kasada      → src/execution/kasada-challenge.ts"
echo "    DataDome    → (no dedicated solver; generic pipeline)"

if [[ "$block_count" -gt 0 ]]; then
  fail "Probe complete — ${block_count} vendor(s) still blocked"
  exit 1
fi
log "Probe complete — all tested vendors passed"
