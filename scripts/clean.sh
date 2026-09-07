#!/usr/bin/env bash
# Safe, repeatable cleanup for the unbrowse repo.
# Removes build artifacts, transient traces, and local bench droppings.
# Does NOT delete committed history (docs/archive, internal, bench waves, evals campaigns, cli-v7, sdk-v2, etc.).
# Idempotent. Safe to run from repo root.

set -euo pipefail

echo "== unbrowse clean =="

# Standard build droppings
rm -rf node_modules dist build out *.tsbuildinfo 2>/dev/null || true
find . -name ".tsbuildinfo" -delete 2>/dev/null || true

# Workspace build outputs (do not touch source in packages/*/src)
for d in packages/*/dist packages/*/build packages/*/.turbo; do
  rm -rf "$d" 2>/dev/null || true
done

# Backend + frontend build droppings
rm -rf backend/dist backend/build frontend/.next frontend/out 2>/dev/null || true

# Transient runtime / bench artifacts (these are gitignored but can pile up locally)
rm -rf traces/* .bench-local/* 2>/dev/null || true
rm -rf evals/__pycache__ 2>/dev/null || true

# Common temp / lock droppings that are safe
rm -f .eslintcache 2>/dev/null || true

echo "clean complete (build + transient artifacts removed; source history preserved)"
exit 0
