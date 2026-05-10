#!/usr/bin/env bash
# Falsifier for plan-v12 bench wrapper edit — guards the challenge_title
# branch in scripts/bench-two-phase.sh's phase1_status derivation.
#
# Extracts the relevant Python block from the embedded extract.py heredoc,
# feeds synthetic captured_meta inputs, asserts phase1_status maps as
# documented in plan-v12.

set -u
PASS=0
FAIL=0
TESTS_FILE="$(basename "$0")"

assert() {
  local label="$1" cmd="$2" expected="$3"
  local actual
  actual=$(eval "$cmd" 2>&1) || true
  if [[ "$actual" == "$expected" ]]; then
    PASS=$((PASS+1))
    echo "  ok    $label"
  else
    FAIL=$((FAIL+1))
    echo "  FAIL  $label"
    echo "        cmd:      $cmd"
    echo "        expected: $expected"
    echo "        actual:   $actual"
  fi
}

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
script="$repo_root/scripts/bench-two-phase.sh"

# 1. The new branch is present
assert "challenge_title-branch-present" \
  "grep -c 'elif \"challenge_title\" in bs:' '$script'" \
  "1"

# 2. New branch sets phase1_status to vendor_blocked (not soft_block)
assert "challenge_title-sets-vendor_blocked" \
  "awk '/elif \"challenge_title\" in bs:/{f=1;next} f && /phase1\\[\"phase1_status\"\\]/{print;exit}' '$script' | tr -d ' '" \
  'phase1["phase1_status"]="vendor_blocked"'

# 3. Branch ordering: challenge_title comes BEFORE the sparse_capture branch
#    (because both can co-exist and challenge_title is stronger evidence)
assert "branch-order-challenge_title-before-sparse" \
  "awk '/elif \"challenge_title\" in bs:/{a=NR} /elif tb < 100 and \"sparse_capture_mostly_noise\" in bs:/{b=NR} END{ if (a>0 && b>0 && a<b) print \"ok\"; else print \"bad\" }' '$script'" \
  "ok"

# 4. Branch ordering: vendor:* check still comes FIRST (highest precedence)
assert "branch-order-vendor-first" \
  "awk '/if has_real_vendor:/{a=NR} /elif \"challenge_title\" in bs:/{b=NR} END{ if (a>0 && b>0 && a<b) print \"ok\"; else print \"bad\" }' '$script'" \
  "ok"

# 5. Original branches all still present (no regression)
# 5. Original branches all still present (no regression). Use fixed-string
#    grep so we do not have to wrestle with regex escapes.
for branch in "if has_real_vendor:" 'elif tb < 100 and "sparse_capture_mostly_noise" in bs:' 'if phase1["phase1_status"] == "unknown":'; do
  count=$(grep -F -c "$branch" "$script")
  if [[ "$count" -ge 1 ]]; then
    PASS=$((PASS+1))
    echo "  ok    branch-preserved: $branch"
  else
    FAIL=$((FAIL+1))
    echo "  FAIL  branch-missing: $branch"
  fi
done

# 6. End-to-end: synthesize a similarweb-shape row and confirm the python
#    classifier promotes it to vendor_blocked. This extracts the derive
#    block from the script and runs it on a synthetic phase1 dict.
python3 - <<'PY'
import sys, re

with open("scripts/bench-two-phase.sh") as f:
    body = f.read()

# Pull ONLY the derive block (anchored to its preceding comment to skip
# the earlier capture_parse_error block at L114). Strip the leading 4-space
# indentation so the block is executable as top-level python.
m = re.search(r"# Derive phase1_status from evidence\n\s*if phase1\[\"phase1_status\"\] == \"unknown\":\n(.*?)\n\n", body, re.S)
if not m:
    print("FAIL  could not extract derive block")
    sys.exit(1)
import textwrap
derive = textwrap.dedent(m.group(1))

# Three test cases
cases = [
    {
        "label": "similarweb (challenge_title only) → vendor_blocked",
        "phase1": {
            "phase1_status": "unknown",
            "phase1_browser_block_signals": '["challenge_title", "sparse_capture_mostly_noise"]',
            "phase1_text_bytes": "553",
            "phase1_endpoints_discovered": 0,
            "phase1_capture_pattern": "",
        },
        "expected": "vendor_blocked",
    },
    {
        "label": "g2 (vendor:datadome present) → vendor_blocked",
        "phase1": {
            "phase1_status": "unknown",
            "phase1_browser_block_signals": '["vendor:datadome", "vendor:cloudflare", "sparse_capture_mostly_noise"]',
            "phase1_text_bytes": "6",
            "phase1_endpoints_discovered": 0,
            "phase1_capture_pattern": "",
        },
        "expected": "vendor_blocked",
    },
    {
        "label": "pure soft block (no vendor, no challenge_title) → soft_block",
        "phase1": {
            "phase1_status": "unknown",
            "phase1_browser_block_signals": '["sparse_capture_mostly_noise"]',
            "phase1_text_bytes": "12",
            "phase1_endpoints_discovered": 0,
            "phase1_capture_pattern": "",
        },
        "expected": "soft_block",
    },
    {
        "label": "no signals at all (real product fail) → no_endpoints",
        "phase1": {
            "phase1_status": "unknown",
            "phase1_browser_block_signals": "[]",
            "phase1_text_bytes": "0",
            "phase1_endpoints_discovered": 0,
            "phase1_capture_pattern": "",
        },
        "expected": "no_endpoints",
    },
]

all_pass = True
for c in cases:
    phase1 = dict(c["phase1"])
    # Execute the derive block in a sandbox where `phase1` is the only state
    g = {"phase1": phase1}
    exec(derive, g)
    actual = phase1["phase1_status"]
    if actual == c["expected"]:
        print(f"  ok    e2e: {c['label']}")
    else:
        print(f"  FAIL  e2e: {c['label']}")
        print(f"        expected: {c['expected']}")
        print(f"        actual:   {actual}")
        all_pass = False

sys.exit(0 if all_pass else 1)
PY
e2e_exit=$?
if [[ $e2e_exit -eq 0 ]]; then
  PASS=$((PASS+4))
else
  FAIL=$((FAIL+1))
fi

echo ""
echo "$TESTS_FILE: PASS=$PASS FAIL=$FAIL"
[[ $FAIL -eq 0 ]]
