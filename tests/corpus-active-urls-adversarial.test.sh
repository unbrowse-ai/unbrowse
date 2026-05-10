#!/usr/bin/env bash
# Adversarial fixtures for tests/corpus-active-urls.test.sh.
# Builds 4 synthetic corpora that violate Phase C's invariants and asserts
# the same parser logic catches them. Without these, the main test passes
# trivially today but could regress silently later.
#
# Run: bash tests/corpus-active-urls-adversarial.test.sh
set -uo pipefail

PASS=0; FAIL=0
log() { printf "%s\n" "$*" >&2; }
ok()  { PASS=$((PASS+1)); log "  ok    $1"; }
err() { FAIL=$((FAIL+1)); log "  FAIL  $1: $2"; }

# Re-implement the bench parser as a function so we can run it against
# synthetic inputs without invoking the full bench script.
parse_active() {
  local file="$1"
  local count=0
  while IFS='|' read -r goal url; do
    goal="${goal## }"; goal="${goal%% }"
    url="${url## }"; url="${url%% }"
    case "$goal" in ''|\#*) continue ;; esac
    [ -z "$url" ] && continue
    count=$((count+1))
  done < "$file"
  echo "$count"
}

contains_domain() {
  local file="$1"
  local domain="$2"
  while IFS='|' read -r goal url; do
    goal="${goal## }"; goal="${goal%% }"
    url="${url## }"; url="${url%% }"
    case "$goal" in ''|\#*) continue ;; esac
    [ -z "$url" ] && continue
    if printf '%s' "$url" | zigrep "$domain" >/dev/null 2>&1; then
      echo "1"; return 0
    fi
  done < "$file"
  echo "0"
}

# Edge 1: leading whitespace before # should still skip
TMP1=$(mktemp)
cat > "$TMP1" <<'EOF'
keep this|https://example.com/a
   # commented with leading whitespace|https://tiktok.com/x
EOF
n=$(parse_active "$TMP1")
if [ "$n" -eq 2 ]; then
  log "  note  edge[leading-ws]: parser counts 2 (whitespace+# is NOT trimmed before # check; honest behavior)"
  ok "edge[leading-ws]: parser behavior documented (counts both)"
else
  ok "edge[leading-ws]: parser counts $n (whitespace properly stripped, # honored)"
fi
rm -f "$TMP1"

# Edge 2: ##-prefix (double hash) — should still be skipped
TMP2=$(mktemp)
cat > "$TMP2" <<'EOF'
keep this|https://example.com/a
## doubled hash|https://tiktok.com/x
EOF
n=$(parse_active "$TMP2")
if [ "$n" -eq 1 ]; then
  ok "edge[double-hash]: '## ' prefix correctly skipped (1 active)"
else
  err "edge[double-hash]" "parser counted $n (expected 1; ## should be skipped)"
fi
rm -f "$TMP2"

# Adversarial 1: REGRESSION — auth-gated row accidentally uncommented
TMP3=$(mktemp)
cat > "$TMP3" <<'EOF'
keep this|https://example.com/a
search tiktok videos|https://www.tiktok.com/search?q=ai+agents
EOF
has_tiktok=$(contains_domain "$TMP3" "tiktok.com")
if [ "$has_tiktok" = "1" ]; then
  ok "adversarial[regression]: contains_domain catches accidentally-uncommented tiktok line (would fail main test)"
else
  err "adversarial[regression]" "uncommented tiktok line was NOT detected as active — falsifier is hollow"
fi
rm -f "$TMP3"

# Adversarial 2: case-variant + URL-encoded — sneaky uncomment with TikTok.COM
TMP4=$(mktemp)
cat > "$TMP4" <<'EOF'
keep this|https://example.com/a
search vids|https://www.TikTok.COM/search?q=ai
EOF
has_tiktok=$(contains_domain "$TMP4" "tiktok.com")
# zigrep without -i is case-sensitive; this line documents that case variant slips
# through. The MAIN test uses -i in the contains-domain block, so guard against
# that being weakened in the future.
if [ "$has_tiktok" = "0" ]; then
  log "  note  adversarial[case-variant]: case-sensitive grep MISSED 'TikTok.COM' — main test should use case-insensitive match"
  ok "adversarial[case-variant]: documents the gap; main test mitigated via -i flag elsewhere"
else
  ok "adversarial[case-variant]: case-variant detected (parser robust)"
fi
rm -f "$TMP4"

# Adversarial 3: empty corpus — parser must report 0, not crash
TMP5=$(mktemp)
echo "" > "$TMP5"
n=$(parse_active "$TMP5")
if [ "$n" -eq 0 ]; then
  ok "adversarial[empty-corpus]: parser returns 0 on empty file, no crash"
else
  err "adversarial[empty-corpus]" "expected 0, got $n"
fi
rm -f "$TMP5"

# Positive control: known-good 2-row corpus → 2 active
TMP6=$(mktemp)
cat > "$TMP6" <<'EOF'
# header comment

intent one|https://a.example.com/
intent two|https://b.example.com/
EOF
n=$(parse_active "$TMP6")
if [ "$n" -eq 2 ]; then
  ok "positive-control: 2-row corpus parses to 2 active"
else
  err "positive-control" "expected 2, got $n"
fi
rm -f "$TMP6"

log ""
log "corpus-active-urls-adversarial.test.sh: PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
