#!/usr/bin/env bash
# rest-gate.sh — the end-to-end witness for "do the rest": the obscura backend is
# wired into the server capture path, navigate-discovery works headless, and the
# binaries are vendorable. Self-contained (exports its own binary env) so the
# jesus-ralph Stop-hook can run it standalone. Offline + deterministic — the
# hermetic tests inject the capture runner, so this never touches the network.
#
# Exit 0 iff every obscura unit/integration suite passes AND the vendor script is
# syntactically valid. Fail-closed. Never a fabricated green.
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
cd "$repo"

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_resolve-bins.sh"

# Resolve the sidecar binary for any suite that needs it (hermetic ones inject it).
export UNBROWSE_OBSCURA_CAPTURE_BIN="$CAP"
export OBSCURA_CAPTURE_BIN="$CAP"

echo "== obscura suites (server-wire, nav-discovery, discovery, integration, jar, resolve-bin) =="
bun test \
  tests/obscura-server-wire.test.ts \
  tests/obscura-nav-discovery.test.ts \
  tests/obscura-discovery.test.ts \
  tests/obscura-capture-integration.test.ts \
  tests/obscura-jar.test.ts \
  tests/obscura-resolve-bin.test.ts \
  tests/obscura-readers.test.ts \
  tests/obscura-mcp-session.test.ts \
  tests/obscura-session-broker.test.ts \
  tests/obscura-egress-binding.test.ts \
  tests/patchright-rung.test.ts \
  tests/obscura-browse-session-client.test.ts \
  tests/browse-session-kuri-free.test.ts \
  tests/api-kuri-boundary.test.ts || { echo "REST-GATE FAIL: obscura suites red" >&2; exit 1; }

echo "== no CLI handler still needs CDP =="
bash native/obscura-capture/no-cdp-gate.sh >/dev/null || { echo "REST-GATE FAIL: a handler still needs CDP" >&2; exit 1; }

echo "== vendor script is valid + targets vendor/obscura/ =="
bash -n native/obscura-capture/vendor.sh || { echo "REST-GATE FAIL: vendor.sh syntax" >&2; exit 1; }
grep -q 'vendor/obscura' native/obscura-capture/vendor.sh || { echo "REST-GATE FAIL: vendor.sh missing vendor/obscura" >&2; exit 1; }

echo "REST-GATE PASS: server-wire + navigate-discovery + vendorable, all witnessed"
