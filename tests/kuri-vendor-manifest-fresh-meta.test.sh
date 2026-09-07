#!/usr/bin/env bash
# plan-v13 Day 4 (Luminaries) sub-agent C — META-TEST of the falsifier.
#
# The falsifier (tests/kuri-vendor-manifest-fresh.test.sh) FAILS today because
# the real vendor manifest is stale. That proves it detects staleness.
# This meta-test proves the SECOND signal: it correctly PASSES on a synthetic
# fresh tree, and FAILS again when we mutate that tree (binary tampered, or
# source_sha rewound to the pre-CURLOPT_PROXY commit).
#
# Without this meta-test, a future refactor could neuter the falsifier
# silently. With it, the falsifier is a working luminary — a sign for
# seasons (Genesis 1:14): visible only when something is wrong.

set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
FALSIFIER="$SCRIPT_DIR/kuri-vendor-manifest-fresh.test.sh"
FRESH_SHA="894ecb9b503f60665a31d2c4c8e96b17d9da3f61"   # Tier 1 post-CURLOPT_PROXY target
STALE_SHA="973c6cf9a457814cf8b4f161b830189908416ee5"   # pre-CURLOPT_PROXY commit
PLATFORMS=(darwin-arm64 darwin-x64 linux-arm64 linux-x64 win-x64)

if [ ! -x "$FALSIFIER" ] && [ ! -f "$FALSIFIER" ]; then
  echo "FAIL: falsifier not found at $FALSIFIER"
  exit 1
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "FAIL: jq required"; exit 1
fi

TMPDIR="$(mktemp -d -t kuri-falsifier-meta.XXXXXX)"
cleanup() { rm -rf "$TMPDIR"; }
trap cleanup EXIT INT TERM

sha256_of() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    sha256sum "$1" | awk '{print $1}'
  fi
}

scenario_pass=0
scenario_fail=0

record() {
  local name="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then
    echo "PASS: $name (exit=$actual as expected)"
    scenario_pass=$((scenario_pass + 1))
  else
    echo "FAIL: $name (expected exit=$expected, got $actual)"
    scenario_fail=$((scenario_fail + 1))
  fi
}

# Build a synthetic fresh vendor tree.
build_fresh_tree() {
  local root="$1" sha="$2"
  rm -rf "$root"
  mkdir -p "$root"
  local entries='{}'
  for p in "${PLATFORMS[@]}"; do
    mkdir -p "$root/$p"
    local bin="kuri"
    if [ "$p" = "win-x64" ]; then bin="kuri.exe"; fi
    head -c 1500000 /dev/urandom > "$root/$p/$bin"
    chmod +x "$root/$p/$bin"
    local bsha
    bsha="$(sha256_of "$root/$p/$bin")"
    entries="$(jq --arg p "$p" --arg sha "$bsha" \
      '. + {($p): {source: "ci-build", sha256: $sha}}' <<<"$entries")"
  done
  jq -n --arg src "$sha" --argjson bins "$entries" \
    '{source_sha: $src, binaries: $bins}' > "$root/manifest.json"
}

run_falsifier() {
  KURI_VENDOR_ROOT="$1" bash "$FALSIFIER" >/dev/null 2>&1
  echo $?
}

# Scenario 1: synthetic fresh tree → falsifier should pass (exit 0).
build_fresh_tree "$TMPDIR/v1" "$FRESH_SHA"
exit1="$(run_falsifier "$TMPDIR/v1")"
record "fresh tree passes falsifier" 0 "$exit1"

# Scenario 2: mutate one binary so its sha256 no longer matches manifest.
echo "extra" >> "$TMPDIR/v1/darwin-x64/kuri"
exit2="$(run_falsifier "$TMPDIR/v1")"
record "tampered binary detected (sha256 mismatch)" 1 "$exit2"

# Scenario 3: rebuild fresh, then rewrite source_sha to the stale value.
build_fresh_tree "$TMPDIR/v2" "$FRESH_SHA"
tmp_manifest="$TMPDIR/v2/manifest.json"
jq --arg s "$STALE_SHA" '.source_sha = $s' "$tmp_manifest" > "$tmp_manifest.new"
mv "$tmp_manifest.new" "$tmp_manifest"
exit3="$(run_falsifier "$TMPDIR/v2")"
record "stale source_sha detected" 1 "$exit3"

echo
echo "---"
echo "scenarios passed: $scenario_pass   failed: $scenario_fail"
[ "$scenario_fail" -eq 0 ]
