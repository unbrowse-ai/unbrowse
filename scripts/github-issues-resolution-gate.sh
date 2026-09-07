#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# External settlement is a real dependency and the cheapest falsifier. Check it
# before spending a minute rerunning already-green local suites while a human
# device authorization is still pending.
gh auth status --hostname github.com >/dev/null 2>&1 || {
  echo "GitHub authentication is required before public issue settlement" >&2
  exit 1
}

bun test --timeout 30000 \
  tests/breath-act-wall-clock-bound.test.ts \
  tests/breath-fill-ax-ref.test.ts \
  tests/linux-flatpak-profile-roots.test.ts \
  tests/breath-go-session-and-timeout.test.ts \
  tests/eval-snap-content-truth.test.ts \
  tests/resolve-visual-context.test.ts \
  tests/server-reaper-all-inflight.test.ts \
  tests/mcp-reaper-respects-inflight.test.ts \
  tests/kuri-process-cleanup.test.ts \
  tests/capture-sw-bypass.test.ts \
  tests/capture-noise-aware-early-exit.test.ts \
  tests/capture-lazy-api-wait.test.ts \
  tests/runtime-paths.test.ts \
  tests/protobuf-wire.test.ts \
  tests/skill-package-runtime.test.ts \
  tests/orchestrator-browser-opened-telemetry.test.ts \
  tests/orchestrator-autowalk.test.ts \
  tests/runtime-setup-semantics.test.ts

npm test --prefix submodules/openclaw-unbrowse-plugin
npm run typecheck --prefix submodules/openclaw-unbrowse-plugin

EXPECTED="27 30 48 51 52 62 65 66 69 76 84 91 96 98 105 108 109 110 111 114 115 118 123 124 126 127 128 129 130 131 132 133"
OPEN="$(gh issue list --repo unbrowse-ai/unbrowse --state open --limit 100 --json number --jq '.[].number' | sort -n | tr '\n' ' ' | sed 's/ $//')"
for ISSUE in $EXPECTED; do
  case " $OPEN " in
    *" $ISSUE "*) echo "issue #$ISSUE is still open" >&2; exit 1 ;;
  esac
done

git diff --check
echo "github issue resolution witness: green"
