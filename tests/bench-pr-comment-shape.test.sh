#!/usr/bin/env bash
# Falsifier shape test for scripts/bench-pr-comment.ts.
# 4 cases mirror plan-v13 falsifier shape: each prints PASS/FAIL and exits 0
# only if all four cases pass. Final line is a tally read by the Day-3 driver.

set -u

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SCRIPT="$REPO_ROOT/scripts/bench-pr-comment.ts"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

PASS=0
FAIL=0

note() { printf '%s\n' "$1" >&2; }

check() {
  local name="$1" cond="$2" detail="${3:-}"
  if [ "$cond" = "1" ]; then
    PASS=$((PASS+1))
    note "PASS: $name"
  else
    FAIL=$((FAIL+1))
    note "FAIL: $name${detail:+ — $detail}"
  fi
}

# ---------- Case 1: evidence only, no base ----------
EV1="$TMP/ev1.csv"
cat >"$EV1" <<'CSV'
goal,url,verdict
search foo,https://a.example/x,PASS
search bar,https://b.example/y,PRODUCT_FAIL
CSV

OUT1="$(bun "$SCRIPT" --evidence "$EV1" 2>/dev/null || true)"
echo "$OUT1" | grep -q '| https://a.example/x | — | PASS | = |' && c1a=1 || c1a=0
echo "$OUT1" | grep -q '| https://b.example/y | — | PRODUCT_FAIL | = |' && c1b=1 || c1b=0
echo "$OUT1" | grep -q 'coverage: 1/2 (was 0/0) +0 wins, 0 regressions' && c1c=1 || c1c=0
[ "$c1a" = 1 ] && [ "$c1b" = 1 ] && [ "$c1c" = 1 ] && c1=1 || c1=0
check "case1 evidence-only emits markdown with em-dash base" "$c1" "$OUT1"

# ---------- Case 2: matching base — all rows = ----------
EV2="$TMP/ev2.csv"
cat >"$EV2" <<'CSV'
goal,url,verdict
g,https://a.example/x,PASS
g,https://b.example/y,PRODUCT_FAIL
CSV
BASE2="$TMP/base2.json"
cat >"$BASE2" <<'JSON'
{"rows":[
  {"url":"https://a.example/x","verdict":"PASS"},
  {"url":"https://b.example/y","verdict":"PRODUCT_FAIL"}
]}
JSON

OUT2="$(bun "$SCRIPT" --evidence "$EV2" --base "$BASE2" 2>/dev/null || true)"
echo "$OUT2" | grep -q '⬆' && up2=1 || up2=0
echo "$OUT2" | grep -q '⬇' && dn2=1 || dn2=0
echo "$OUT2" | grep -q '+0 wins, 0 regressions' && tally2=1 || tally2=0
[ "$up2" = 0 ] && [ "$dn2" = 0 ] && [ "$tally2" = 1 ] && c2=1 || c2=0
check "case2 matching base — zero deltas" "$c2" "$OUT2"

# ---------- Case 3: head improves over base (BROWSER_BLOCK → PASS) ----------
EV3="$TMP/ev3.csv"
cat >"$EV3" <<'CSV'
goal,url,verdict
g,https://c.example/z,PASS
CSV
BASE3="$TMP/base3.json"
cat >"$BASE3" <<'JSON'
{"rows":[{"url":"https://c.example/z","verdict":"PRODUCT_FAIL"}]}
JSON

OUT3="$(bun "$SCRIPT" --evidence "$EV3" --base "$BASE3" 2>/dev/null || true)"
echo "$OUT3" | grep -q '| https://c.example/z | PRODUCT_FAIL | PASS | ⬆ |' && a3=1 || a3=0
echo "$OUT3" | grep -q '+1 wins, 0 regressions' && b3=1 || b3=0
[ "$a3" = 1 ] && [ "$b3" = 1 ] && c3=1 || c3=0
check "case3 win detected as up arrow" "$c3" "$OUT3"

# ---------- Case 4: regression (PASS → PRODUCT_FAIL) ----------
EV4="$TMP/ev4.csv"
cat >"$EV4" <<'CSV'
goal,url,verdict
g,https://d.example/w,PRODUCT_FAIL
CSV
BASE4="$TMP/base4.json"
cat >"$BASE4" <<'JSON'
{"rows":[{"url":"https://d.example/w","verdict":"PASS"}]}
JSON

OUT4="$(bun "$SCRIPT" --evidence "$EV4" --base "$BASE4" 2>/dev/null || true)"
echo "$OUT4" | grep -q '| https://d.example/w | PASS | PRODUCT_FAIL | ⬇ |' && a4=1 || a4=0
echo "$OUT4" | grep -q '+0 wins, 1 regressions' && b4=1 || b4=0
[ "$a4" = 1 ] && [ "$b4" = 1 ] && c4=1 || c4=0
check "case4 regression detected as down arrow" "$c4" "$OUT4"

# ---------- Case 5: empty evidence (header only, no rows) ----------
EV5="$TMP/ev5.csv"
cat >"$EV5" <<'CSV'
goal,url,verdict
CSV

OUT5="$(bun "$SCRIPT" --evidence "$EV5" 2>/dev/null || true)"
echo "$OUT5" | grep -q '| URL | base | head | Δ |' && a5=1 || a5=0
echo "$OUT5" | grep -q 'coverage: 0/0 (was 0/0) +0 wins, 0 regressions' && b5=1 || b5=0
[ "$a5" = 1 ] && [ "$b5" = 1 ] && c5=1 || c5=0
check "case5 empty evidence — header + 0/0 footer, no crash" "$c5" "$OUT5"

# ---------- Case 6: --base points to nonexistent file ----------
EV6="$TMP/ev6.csv"
cat >"$EV6" <<'CSV'
goal,url,verdict
g,https://e.example/q,PASS
CSV

OUT6="$(bun "$SCRIPT" --evidence "$EV6" --base /tmp/nonexistent-bench-base-xyz.json 2>/dev/null || true)"
echo "$OUT6" | grep -q '| https://e.example/q | — | PASS | = |' && a6=1 || a6=0
echo "$OUT6" | grep -q 'coverage: 1/1 (was 0/0) +0 wins, 0 regressions' && b6=1 || b6=0
[ "$a6" = 1 ] && [ "$b6" = 1 ] && c6=1 || c6=0
check "case6 missing base file treated as empty baseline" "$c6" "$OUT6"

# ---------- Case 7: base is empty JSON {} (no rows key) ----------
EV7="$TMP/ev7.csv"
cat >"$EV7" <<'CSV'
goal,url,verdict
g,https://f.example/r,PASS
CSV
BASE7="$TMP/base7.json"
echo '{}' >"$BASE7"

OUT7="$(bun "$SCRIPT" --evidence "$EV7" --base "$BASE7" 2>/dev/null || true)"
echo "$OUT7" | grep -q '| https://f.example/r | — | PASS | = |' && a7=1 || a7=0
echo "$OUT7" | grep -q 'coverage: 1/1 (was 0/0) +0 wins, 0 regressions' && b7=1 || b7=0
[ "$a7" = 1 ] && [ "$b7" = 1 ] && c7=1 || c7=0
check "case7 base {} (no rows key) treated as empty rows, no crash" "$c7" "$OUT7"

# ---------- Case 8: base has URLs not in head (dropped URLs) ----------
EV8="$TMP/ev8.csv"
cat >"$EV8" <<'CSV'
goal,url,verdict
g,https://h1.example/a,PASS
g,https://h2.example/b,PASS
g,https://h3.example/c,PRODUCT_FAIL
CSV
BASE8="$TMP/base8.json"
cat >"$BASE8" <<'JSON'
{"rows":[
  {"url":"https://h1.example/a","verdict":"PASS"},
  {"url":"https://h2.example/b","verdict":"PASS"},
  {"url":"https://h3.example/c","verdict":"PASS"},
  {"url":"https://gone1.example/x","verdict":"PASS"},
  {"url":"https://gone2.example/y","verdict":"PRODUCT_FAIL"}
]}
JSON

OUT8="$(bun "$SCRIPT" --evidence "$EV8" --base "$BASE8" 2>/dev/null || true)"
echo "$OUT8" | grep -q 'gone1.example' && drop1=0 || drop1=1
echo "$OUT8" | grep -q 'gone2.example' && drop2=0 || drop2=1
echo "$OUT8" | grep -q 'coverage: 2/3 (was 4/5) +0 wins, 1 regressions' && tally8=1 || tally8=0
[ "$drop1" = 1 ] && [ "$drop2" = 1 ] && [ "$tally8" = 1 ] && c8=1 || c8=0
check "case8 base-only URLs excluded from table; footer uses base full count" "$c8" "$OUT8"

# ---------- Case 9: head row with empty verdict ----------
EV9="$TMP/ev9.csv"
cat >"$EV9" <<'CSV'
goal,url,verdict
g,https://i1.example/a,PASS
g,https://i2.example/b,
CSV

OUT9="$(bun "$SCRIPT" --evidence "$EV9" 2>/dev/null || true)"
echo "$OUT9" | grep -q '| https://i1.example/a | — | PASS | = |' && a9=1 || a9=0
echo "$OUT9" | grep -q '| https://i2.example/b | —' && b9=1 || b9=0
echo "$OUT9" | grep -q 'coverage: 1/1 (was 0/0) +0 wins, 0 regressions' && d9=1 || d9=0
[ "$a9" = 1 ] && [ "$b9" = 1 ] && [ "$d9" = 1 ] && c9=1 || c9=0
check "case9 empty verdict treated as ?, excluded from denom, no crash" "$c9" "$OUT9"

echo "tally: pass=$PASS fail=$FAIL"
[ "$FAIL" = 0 ]
