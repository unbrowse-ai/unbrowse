#!/usr/bin/env bash
# Pre-commit doc-delta probe. Surfaces evidence when a staged diff touches
# shipping-surface signals (new workspace member, new binary, deploy target,
# new top-level directory, new package manifest below root) without a same-
# commit touch to a canonical doc.
#
# Substrate-faithful: this script COLLECTS evidence and PRINTS it. It does
# NOT exit non-zero. The committer judges whether the surface change is
# README/architecture/CHANGELOG worthy.
#
# Mirrors ~/.claude/skills/meta-harness/scripts/gates/doc-delta.sh, scoped
# to `git diff --cached` (staged diff) rather than a baseline ref.

set -uo pipefail

cd "$(git rev-parse --show-toplevel 2>/dev/null)" || exit 0

DIFF_FILES=$(git diff --cached --name-only --diff-filter=ACMR 2>/dev/null || true)
[[ -z "$DIFF_FILES" ]] && exit 0

DIFF=$(git diff --cached 2>/dev/null || true)

WORKSPACE_LINES=$(echo "$DIFF" | grep -cE '^\+.*("workspaces"|members\s*=|packages\s*:)' || true)
BIN_LINES=$(echo "$DIFF" | grep -cE '^\+.*(\[\[bin\]\]|"bin"\s*:)' || true)
DEPLOY_FILES=$(echo "$DIFF_FILES" | grep -cE '(^|/)(wrangler\.(toml|jsonc?)|vercel\.json|netlify\.toml|fly\.toml|Dockerfile|\.github/workflows/.*deploy.*\.ya?ml)$' || true)

NEW_MANIFEST_FILES=$(python3 - <<'PY' 2>/dev/null || echo ""
import subprocess
try:
    diff = subprocess.check_output(
        ["git", "diff", "--cached", "--name-status", "--diff-filter=A"],
        text=True, stderr=subprocess.DEVNULL,
    )
except Exception:
    raise SystemExit(0)
out = []
for line in diff.splitlines():
    parts = line.split("\t")
    if len(parts) < 2:
        continue
    path = parts[-1]
    base = path.rsplit("/", 1)[-1]
    if base in ("Cargo.toml", "package.json", "pyproject.toml", "go.mod") and "/" in path:
        out.append(path)
print(" ".join(out))
PY
)

NEW_TOPLEVEL_DIRS=$(python3 - <<'PY' 2>/dev/null || echo ""
import subprocess
try:
    diff = subprocess.check_output(
        ["git", "diff", "--cached", "--name-status", "--diff-filter=A"],
        text=True, stderr=subprocess.DEVNULL,
    )
except Exception:
    raise SystemExit(0)
added_dirs = set()
for line in diff.splitlines():
    parts = line.split("\t")
    if len(parts) < 2:
        continue
    path = parts[-1]
    if "/" not in path:
        continue
    head = path.split("/", 1)[0]
    added_dirs.add(head)
try:
    ls = subprocess.check_output(
        ["git", "ls-tree", "--name-only", "HEAD"],
        text=True, stderr=subprocess.DEVNULL,
    )
    existing = {line.strip() for line in ls.splitlines()}
except Exception:
    existing = set()
new = sorted(d for d in added_dirs if d and d not in existing)
print(" ".join(new))
PY
)

CANDIDATE_DOCS="README.md architecture.md ARCHITECTURE.md docs/README.md docs/architecture.md docs/ARCHITECTURE.md CHANGELOG.md"
DOCS_FOUND=""
DOCS_TOUCHED=""
DOCS_UNTOUCHED=""
for d in $CANDIDATE_DOCS; do
  if [[ -f "$d" ]]; then
    DOCS_FOUND="$DOCS_FOUND $d"
    if echo "$DIFF_FILES" | grep -qx "$d"; then
      DOCS_TOUCHED="$DOCS_TOUCHED $d"
    else
      DOCS_UNTOUCHED="$DOCS_UNTOUCHED $d"
    fi
  fi
done

WORKSPACE_LINES="$WORKSPACE_LINES" BIN_LINES="$BIN_LINES" \
  DEPLOY_FILES="$DEPLOY_FILES" NEW_TOPLEVEL_DIRS="$NEW_TOPLEVEL_DIRS" \
  NEW_MANIFEST_FILES="$NEW_MANIFEST_FILES" \
  DOCS_FOUND="$DOCS_FOUND" DOCS_TOUCHED="$DOCS_TOUCHED" \
  DOCS_UNTOUCHED="$DOCS_UNTOUCHED" \
python3 - <<'PY'
import json, os
workspace_lines  = int(os.environ.get("WORKSPACE_LINES") or 0)
bin_lines        = int(os.environ.get("BIN_LINES") or 0)
deploy_files     = int(os.environ.get("DEPLOY_FILES") or 0)
new_dirs         = [d for d in (os.environ.get("NEW_TOPLEVEL_DIRS") or "").split() if d]
new_manifests    = [d for d in (os.environ.get("NEW_MANIFEST_FILES") or "").split() if d]
found            = [d for d in (os.environ.get("DOCS_FOUND") or "").split() if d]
touched          = [d for d in (os.environ.get("DOCS_TOUCHED") or "").split() if d]
untouched        = [d for d in (os.environ.get("DOCS_UNTOUCHED") or "").split() if d]
surface_total    = workspace_lines + bin_lines + deploy_files + len(new_dirs) + len(new_manifests)
required         = bool(surface_total > 0 and len(found) > 0 and len(touched) == 0)
row = {
  "gate": "doc-delta-staged",
  "workspace_lines": workspace_lines,
  "bin_lines": bin_lines,
  "deploy_target_files": deploy_files,
  "new_toplevel_dirs": new_dirs,
  "new_manifest_files": new_manifests,
  "shipping_surface_total": surface_total,
  "canonical_docs_found": found,
  "canonical_docs_touched": touched,
  "canonical_docs_untouched": untouched,
  "doc_delta_required": required,
}
if surface_total == 0:
    # No shipping-surface signal in this commit. Silent pass.
    raise SystemExit(0)
print("[pre-commit] doc-delta evidence:", file=__import__("sys").stderr)
print("  " + json.dumps(row), file=__import__("sys").stderr)
if required:
    print("", file=__import__("sys").stderr)
    print("[pre-commit] HEADS UP: shipping-surface signals present (" + str(surface_total) + "), no canonical doc touched.", file=__import__("sys").stderr)
    print("[pre-commit]   Canonical docs found but untouched: " + " ".join(untouched), file=__import__("sys").stderr)
    print("[pre-commit]   This is evidence, not a block. Judge whether the change warrants a doc/CHANGELOG update.", file=__import__("sys").stderr)
PY

exit 0
