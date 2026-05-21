#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

if [[ -f .env.runtime ]]; then
  set -a
  # shellcheck disable=SC1091
  source ./.env.runtime
  set +a
fi

bun test \
  tests/graph-agent-view.test.ts \
  tests/graph-dependencies.test.ts \
  tests/codex-harness.test.ts \
  tests/orchestrator-endpoint-readiness.test.ts \
  tests/orchestrator-cache-acceptance.test.ts \
  tests/semantic-ranking.test.ts \
  tests/execution-replay-context.test.ts \
  tests/reddit-intent-match.test.ts \
  tests/company-intent-match.test.ts \
  tests/linkedin-company-real-world.test.ts \
  tests/real-world-cases.test.ts

server_pid=""
cleanup() {
  if [[ -n "${server_pid}" ]]; then
    kill "${server_pid}" >/dev/null 2>&1 || true
    wait "${server_pid}" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

health_url="${UNBROWSE_BASE_URL:-http://127.0.0.1:6969}/health"
if ! curl -fsS "${health_url}" >/dev/null 2>&1; then
  bun src/index.ts >/tmp/unbrowse-precommit-server.log 2>&1 &
  server_pid=$!
  for _ in $(seq 1 60); do
    if curl -fsS "${health_url}" >/dev/null 2>&1; then
      break
    fi
    sleep 1
  done
  curl -fsS "${health_url}" >/dev/null
fi

artifact_path="$(mktemp -t unbrowse-codex-precommit)"
bun evals/codex-harness.ts \
  --intent "search repositories" \
  --url "https://github.com/search?q=openai&type=repositories" \
  --out "${artifact_path}"
