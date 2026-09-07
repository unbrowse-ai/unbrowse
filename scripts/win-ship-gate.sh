#!/usr/bin/env bash
# Witness: Windows browse works AND is shipped to users (preview).
#
# Exits 0 exactly when BOTH:
#   1. the latest test-windows.yml run on the branch concluded success
#      (go/snap/close on windows-latest), and
#   2. unbrowse@7.2.0-preview.0 is published on npm (the `preview` ship).
set -uo pipefail

echo "[ship] 1/2 Windows E2E green..."
bash "$(dirname "${BASH_SOURCE[0]}")/win-ci-gate.sh" || { echo "[ship] FAIL: Windows E2E not green"; exit 1; }

echo "[ship] 2/2 waiting for unbrowse@7.2.0-preview.0 on npm (release pipeline publishes async)..."
# Poll up to ~25 min for the release pipeline to build all platforms and publish.
deadline=$(( $(date +%s) + 1500 ))
while [ "$(date +%s)" -lt "$deadline" ]; do
  V=$(npm view unbrowse@7.2.0-preview.0 version 2>/dev/null)
  if [ "$V" = "7.2.0-preview.0" ]; then
    TAG=$(npm view unbrowse dist-tags.preview 2>/dev/null)
    echo "[ship] PASS — Windows E2E green + unbrowse@7.2.0-preview.0 on npm (preview dist-tag=${TAG}). npm i unbrowse@preview"
    exit 0
  fi
  sleep 30
done
echo "[ship] unbrowse@7.2.0-preview.0 still not on npm after wait — check release run"; exit 1
