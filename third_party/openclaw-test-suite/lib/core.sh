#!/usr/bin/env bash
# openclaw-test-suite: core.sh — Colors, counters, assertion primitives
[ -n "${_OCT_CORE_LOADED:-}" ] && return 0
_OCT_CORE_LOADED=1

OCT_PASS=0
OCT_FAIL=0
OCT_SKIP=0

if [ -n "${NO_COLOR:-}" ]; then
  RED=""; GREEN=""; YELLOW=""; BLUE=""; NC=""
else
  RED=$'\033[0;31m'
  GREEN=$'\033[0;32m'
  YELLOW=$'\033[0;33m'
  BLUE=$'\033[0;34m'
  NC=$'\033[0m'
fi

_oct_print() {
  [ -n "${OCT_QUIET:-}" ] && return 0
  echo -e "$@"
}

phase() {
  _oct_print "  ${BLUE}==>${NC} $1"
}

warn() {
  _oct_print "  ${YELLOW}WARN:${NC} $1"
}

skip() {
  OCT_SKIP=$((OCT_SKIP + 1))
  _oct_print "  ${YELLOW}SKIP:${NC} $1"
}

assert() {
  local desc="$1"
  local ok="$2"
  if [ "$ok" = "true" ]; then
    OCT_PASS=$((OCT_PASS + 1))
    _oct_print "  ${GREEN}PASS:${NC} $desc"
  else
    OCT_FAIL=$((OCT_FAIL + 1))
    _oct_print "  ${RED}FAIL:${NC} $desc"
    return 1
  fi
}

assert_eq() {
  local desc="$1" a="$2" b="$3"
  assert "$desc" "$([ "$a" = "$b" ] && echo true || echo false)"
  if [ "$a" != "$b" ]; then
    _oct_print "    expected: $b"
    _oct_print "    got:      $a"
    return 1
  fi
}

assert_contains() {
  local desc="$1" hay="$2" needle="$3"
  assert "$desc" "$(echo "$hay" | grep -qiE "$needle" && echo true || echo false)"
  if ! echo "$hay" | grep -qiE "$needle"; then
    _oct_print "    needle: $needle"
    _oct_print "    haystack (first 200 chars):"
    _oct_print "    $(echo "$hay" | head -c 200)"
    return 1
  fi
}

assert_file_exists() {
  local desc="$1" path="$2"
  assert "$desc" "$([ -f "$path" ] && echo true || echo false)"
}

assert_dir_exists() {
  local desc="$1" path="$2"
  assert "$desc" "$([ -d "$path" ] && echo true || echo false)"
}

assert_http_status() {
  local desc="$1" url="$2" want="$3"
  shift 3
  local got
  got=$(curl -sS -o /dev/null -w "%{http_code}" "$url" --max-time 15 "$@" 2>/dev/null || echo "000")
  assert_eq "$desc" "$got" "$want"
}

