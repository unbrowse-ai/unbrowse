#!/usr/bin/env bash
# plan-v13 falsifier: assert that packages/skill/vendor/kuri/manifest.json is
# actually fresh — built from a post-CURLOPT_PROXY commit, with non-placeholder
# binaries on every platform, and recorded sha256 matches the file on disk.
#
# Today this test is EXPECTED TO FAIL against the placeholder manifest.
# That failure is the seed: it proves the falsifier works. Once the
# kuri-vendor workflow runs and Step 6 commits real binaries + a refreshed
# manifest, this test must go green.
#
# Compatible with macOS and Linux (uses shasum or sha256sum, jq, stat).

set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# Optional override: point the falsifier at a synthetic vendor tree (used by
# tests/kuri-vendor-manifest-fresh-meta.test.sh to verify the falsifier itself).
# Default behavior unchanged when KURI_VENDOR_ROOT is unset.
VENDOR_DIR="${KURI_VENDOR_ROOT:-$ROOT/packages/skill/vendor/kuri}"
MANIFEST="$VENDOR_DIR/manifest.json"
STALE_SHA="973c6cf9a457814cf8b4f161b830189908416ee5"  # pre-CURLOPT_PROXY
PLATFORMS=(darwin-arm64 darwin-x64 linux-arm64 linux-x64)

fail_count=0
pass_count=0

pass() { echo "PASS: $*"; pass_count=$((pass_count + 1)); }
fail() { echo "FAIL: $*"; fail_count=$((fail_count + 1)); }

if ! command -v jq >/dev/null 2>&1; then
  echo "FAIL: jq not installed (required to parse manifest.json)"
  exit 1
fi

if [ ! -f "$MANIFEST" ]; then
  echo "FAIL: manifest.json not found at $MANIFEST"
  exit 1
fi

sha256_of() {
  local file="$1"
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$file" | awk '{print $1}'
  elif command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$file" | awk '{print $1}'
  else
    echo "FAIL: no shasum or sha256sum available" >&2
    return 1
  fi
}

file_size() {
  local file="$1"
  # macOS uses stat -f%z; GNU uses stat -c%s
  stat -f%z "$file" 2>/dev/null || stat -c%s "$file" 2>/dev/null
}

# Check 1: source_sha differs from pre-CURLOPT_PROXY commit
source_sha="$(jq -r '.source_sha' "$MANIFEST")"
if [ "$source_sha" = "$STALE_SHA" ]; then
  fail "source_sha is still the pre-CURLOPT_PROXY commit ($STALE_SHA)"
elif [ "$source_sha" = "null" ] || [ -z "$source_sha" ]; then
  fail "source_sha is missing or null in manifest"
else
  pass "source_sha is post-CURLOPT_PROXY ($source_sha)"
fi

# Per-platform checks
for platform in "${PLATFORMS[@]}"; do
  source_field="$(jq -r --arg p "$platform" '.binaries[$p].source // "missing"' "$MANIFEST")"
  recorded_sha="$(jq -r --arg p "$platform" '.binaries[$p].sha256 // "missing"' "$MANIFEST")"
  bin_path="$VENDOR_DIR/$platform/kuri"

  # Check 2: source != "placeholder"
  if [ "$source_field" = "placeholder" ]; then
    fail "$platform: manifest source is 'placeholder' (must be a real build origin)"
  elif [ "$source_field" = "missing" ]; then
    fail "$platform: manifest entry has no 'source' field"
  else
    pass "$platform: source is '$source_field'"
  fi

  # Check 3: binary file exists and is > 1MB
  if [ ! -f "$bin_path" ]; then
    fail "$platform: binary missing at $bin_path"
    continue
  fi
  size="$(file_size "$bin_path")"
  if [ -z "$size" ]; then
    fail "$platform: could not stat $bin_path"
  elif [ "$size" -le 1048576 ]; then
    fail "$platform: binary is $size bytes (must be > 1MB / 1048576 bytes)"
  else
    pass "$platform: binary is $size bytes (> 1MB)"
  fi

  # Check 4: recorded sha256 matches actual file sha256
  if [ "$recorded_sha" = "missing" ] || [ -z "$recorded_sha" ]; then
    fail "$platform: no sha256 recorded in manifest"
  else
    actual_sha="$(sha256_of "$bin_path")"
    if [ "$actual_sha" = "$recorded_sha" ]; then
      pass "$platform: sha256 matches ($recorded_sha)"
    else
      fail "$platform: sha256 mismatch — manifest=$recorded_sha actual=$actual_sha"
    fi
  fi
done

echo
echo "---"
echo "passed: $pass_count   failed: $fail_count"
if [ "$fail_count" -gt 0 ]; then
  exit 1
fi
exit 0
