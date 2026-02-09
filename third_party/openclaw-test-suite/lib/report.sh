#!/usr/bin/env bash
# openclaw-test-suite: report.sh — Summary and machine-readable output
[ -n "${_OCT_REPORT_LOADED:-}" ] && return 0
_OCT_REPORT_LOADED=1

oct_report() {
  local fmt="${OCT_OUTPUT_FORMAT:-pretty}"
  if [ "$fmt" = "json" ]; then
    printf '{\"pass\":%s,\"fail\":%s,\"skip\":%s}\n' "${OCT_PASS:-0}" "${OCT_FAIL:-0}" "${OCT_SKIP:-0}"
  elif [ "$fmt" = "tap" ]; then
    local total=$(( (OCT_PASS:-0) + (OCT_FAIL:-0) + (OCT_SKIP:-0) ))
    echo "1..$total"
    # TAP details are intentionally minimal here.
    echo "# pass=${OCT_PASS:-0} fail=${OCT_FAIL:-0} skip=${OCT_SKIP:-0}"
  else
    echo ""
    echo "═══════════════════════════════════════════════════════"
    echo " Summary"
    echo "═══════════════════════════════════════════════════════"
    echo "  Pass: ${OCT_PASS:-0}"
    echo "  Fail: ${OCT_FAIL:-0}"
    echo "  Skip: ${OCT_SKIP:-0}"
    echo ""
  fi
}

