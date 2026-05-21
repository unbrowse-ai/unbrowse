#!/usr/bin/env bash
# ship.sh — rebuild-the-unbrowse-sdk-as-a-thin-http-first-ty
# Commits any staged changes from the current wave on the active branch.
# Agent stages files between iterations; ship.sh just lands them with a
# conventional-commit message. No --no-verify; pre-commit hooks stand.

set -u
SCAFFOLD_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROJECT_ROOT="$(cd "${SCAFFOLD_DIR}/../.." && pwd)"
cd "$PROJECT_ROOT"

if [[ -z "$(git status --porcelain)" ]]; then
  echo "[ship] no changes to commit (clean tree)"
  exit 0
fi

# Stage scaffold artifacts + anything the agent has staged in this wave.
git add -A .claude/rebuild-the-unbrowse-sdk-as-a-thin-http-first-ty/ 2>/dev/null || true

if [[ -z "$(git diff --cached --name-only)" ]]; then
  echo "[ship] nothing staged after harness add (agent must stage SDK / docs / principle changes before ship)"
  exit 0
fi

n_files=$(git diff --cached --name-only | wc -l | tr -d ' ')
wave=$(grep -c '^{' "${SCAFFOLD_DIR}/ledgers/iterations.jsonl" 2>/dev/null || echo 0)
wave=$((wave + 1))

msg="chore(sdk-rebuild): wave ${wave} (${n_files} files)

harness: rebuild-the-unbrowse-sdk-as-a-thin-http-first-ty
wave: ${wave}
ledger: .claude/rebuild-the-unbrowse-sdk-as-a-thin-http-first-ty/ledgers/iterations.jsonl

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"

if git commit -m "$msg"; then
  sha=$(git rev-parse --short HEAD)
  echo "[ship] committed ${sha} (${n_files} files)"
  exit 0
else
  echo "[ship] commit failed (pre-commit hook?)"
  exit 9
fi
