#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
IMAGE_TAG="${OCT_DOCKER_IMAGE:-unbrowse-openclaw-oct:local}"

# Ensure the real backend is up on the host (used by the gateway inside the container).
BACKEND_PATH="${E2E_BACKEND_PATH:-}"
if [ -z "${BACKEND_PATH}" ]; then
  BACKEND_PATH="$(REPO_ROOT="${REPO_ROOT}" node --input-type=module - <<'NODE' || true
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const repoRoot = process.env.REPO_ROOT;
if (!repoRoot) process.exit(1);

function looksLikeRepo(p) {
  return (
    fs.existsSync(path.join(p, "package.json")) &&
    fs.existsSync(path.join(p, "Dockerfile")) &&
    fs.existsSync(path.join(p, "src"))
  );
}

const candidates = [];
for (const p of [
  path.resolve(repoRoot, "..", "reverse-engineer"),
  path.resolve(repoRoot, "..", "..", "reverse-engineer"),
]) {
  if (looksLikeRepo(p)) candidates.push({ p, m: fs.statSync(p).mtimeMs });
}

const codex = path.resolve(os.homedir(), ".codex", "worktrees");
if (fs.existsSync(codex)) {
  for (const ent of fs.readdirSync(codex, { withFileTypes: true })) {
    if (!ent.isDirectory()) continue;
    const p = path.join(codex, ent.name, "reverse-engineer");
    if (looksLikeRepo(p)) candidates.push({ p, m: fs.statSync(p).mtimeMs });
  }
}

candidates.sort((a, b) => b.m - a.m);
if (!candidates[0]) process.exit(1);
process.stdout.write(candidates[0].p);
NODE
)"
fi
BACKEND_URL="${E2E_REAL_BACKEND_URL:-http://127.0.0.1:4112}"
if ! curl -sf "${BACKEND_URL}/health" --max-time 2 >/dev/null 2>&1; then
  if [ -z "${BACKEND_PATH}" ]; then
    echo "[oct] reverse-engineer backend repo not found. Set E2E_BACKEND_PATH=/path/to/reverse-engineer."
    exit 1
  fi
  echo "[oct] starting backend via e2e docker compose: ${BACKEND_PATH}"
  if [ ! -d "${BACKEND_PATH}" ]; then
    echo "[oct] backend path not found: ${BACKEND_PATH}"
    exit 1
  fi
  E2E_COMPOSE_FILE="${REPO_ROOT}/test/e2e/reverse-engineer.e2e.compose.yml"
  E2E_PROJECT_NAME="unbrowse-openclaw-e2e"
  E2E_BACKEND_PATH="${BACKEND_PATH}" docker compose -f "${E2E_COMPOSE_FILE}" -p "${E2E_PROJECT_NAME}" up -d --build
  for i in {1..120}; do
    curl -sf "${BACKEND_URL}/health" --max-time 2 >/dev/null 2>&1 && break
    sleep 1
  done
  # Wait for a DB-backed route too, so we don't race migrations.
  for i in {1..120}; do
    curl -sf "${BACKEND_URL}/marketplace/skills?limit=1" --max-time 2 >/dev/null 2>&1 && break
    sleep 1
  done
fi

DOCKERFILE="${REPO_ROOT}/test/oct/docker/Dockerfile"
docker build --platform "${OCT_DOCKER_PLATFORM:-linux/amd64}" -t "${IMAGE_TAG}" -f "${DOCKERFILE}" "${REPO_ROOT}"
docker run --rm --platform "${OCT_DOCKER_PLATFORM:-linux/amd64}" \
  --add-host=host.docker.internal:host-gateway \
  -e "UNBROWSE_INDEX_URL=${UNBROWSE_INDEX_URL:-http://host.docker.internal:4112}" \
  "${IMAGE_TAG}"
