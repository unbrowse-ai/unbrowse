#!/usr/bin/env bash
# W13.1 — cross-compile utls-proxy for the four shipping platforms.
#
# Eph 6:11 — "Put on the WHOLE armor." Every platform that v7 ships on
# needs the TLS armor too; missing a target is honest only if go build
# refuses (we log + continue, never silently drop).
#
# Output: dist/utls-proxy-<os>-<arch>. Compressed with upx when available.
# Budget: ≤8 MB per binary post-upx; fail loudly if exceeded so we know
# to revisit go-mod weight before shipping.

set -euo pipefail

cd "$(dirname "$0")"

TARGETS=(
  "darwin/arm64"
  "darwin/amd64"
  "linux/amd64"
  "linux/arm64"
)

# 8 MB ceiling in bytes (with a touch of slack for ELF/Mach-O headers).
MAX_BYTES=$((8 * 1024 * 1024))

mkdir -p dist
echo "[utls-proxy build] resolving go modules"
go mod tidy

UPX_AVAILABLE=0
if command -v upx >/dev/null 2>&1; then
  UPX_AVAILABLE=1
  echo "[utls-proxy build] upx detected: $(upx --version | head -1)"
else
  echo "[utls-proxy build] upx NOT installed — binaries will be larger than budget; install via 'brew install upx' (mac) or apt-get install upx (linux)"
fi

FAILED=()
BUILT=()

for target in "${TARGETS[@]}"; do
  goos="${target%%/*}"
  goarch="${target##*/}"
  out="dist/utls-proxy-${goos}-${goarch}"
  echo ""
  echo "[utls-proxy build] === ${goos}/${goarch} → ${out} ==="
  if ! GOOS="$goos" GOARCH="$goarch" CGO_ENABLED=0 go build \
      -trimpath \
      -ldflags="-s -w" \
      -o "$out" ./cmd/utls-proxy ; then
    echo "[utls-proxy build] FAILED ${target} — honest fall-through (skip this platform; runtime degrades cleanly)"
    FAILED+=("$target")
    continue
  fi
  pre_size=$(stat -f%z "$out" 2>/dev/null || stat -c%s "$out")
  echo "[utls-proxy build] ${target} pre-upx size: ${pre_size} bytes"
  if [[ "$UPX_AVAILABLE" -eq 1 ]]; then
    if upx --best --lzma -q "$out" >/dev/null 2>&1; then
      post_size=$(stat -f%z "$out" 2>/dev/null || stat -c%s "$out")
      echo "[utls-proxy build] ${target} post-upx size: ${post_size} bytes"
    else
      echo "[utls-proxy build] ${target} upx skipped (binary already small or platform unsupported)"
      post_size="$pre_size"
    fi
  else
    post_size="$pre_size"
  fi
  if (( post_size > MAX_BYTES )); then
    echo "[utls-proxy build] ⚠ ${target} EXCEEDS 8MB budget (${post_size} bytes). Revisit go.mod deps before shipping."
    FAILED+=("$target(oversize)")
  else
    BUILT+=("${target}:${post_size}")
  fi
done

echo ""
echo "[utls-proxy build] ── summary ─────────────────────────────────"
for row in "${BUILT[@]+"${BUILT[@]}"}"; do echo "  ok    $row bytes"; done
for row in "${FAILED[@]+"${FAILED[@]}"}"; do echo "  fail  $row"; done

if [[ ${#BUILT[@]} -eq 0 ]]; then
  echo "[utls-proxy build] no platforms succeeded — release wave will ship without TLS spoof until fixed"
  exit 1
fi
exit 0
