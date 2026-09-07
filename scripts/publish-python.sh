#!/usr/bin/env bash
# publish-python.sh — publish the Python adapter family to PyPI. HUMAN-TRIGGERED.
#
# Mirrors scripts/publish-dropins.sh (the npm family). Builds a wheel + sdist for
# every package in scripts/python-adapter-manifest.tsv via the PEP-517 setuptools
# backend (no build isolation needed) and uploads with twine. Idempotent-ish:
# twine skips versions already on the index with --skip-existing.
#
# Gated by scripts/check-python-publishable.py (run it first; it must exit 0).
# Requires TWINE_USERNAME/TWINE_PASSWORD (or a ~/.pypirc token) in the environment.
#
#   bash scripts/publish-python.sh            # build + upload all
#   bash scripts/publish-python.sh --dry-run  # build only, no upload
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
DRY="${1:-}"
MANIFEST="scripts/python-adapter-manifest.tsv"
OUT="$(mktemp -d)"

echo "== gate =="
python3 scripts/check-python-publishable.py >/dev/null || { echo "not publish-ready; aborting"; exit 1; }

while IFS=$'\t' read -r upstream pkg pkg_dir readme test; do
  [[ -z "${upstream// }" || "${upstream:0:1}" == "#" ]] && continue
  echo "== build $pkg ($pkg_dir) =="
  python3 - "$pkg_dir" "$OUT" <<'PY'
import os, sys, shutil
pkg_dir, out = sys.argv[1], sys.argv[2]
import setuptools.build_meta as b
os.chdir(pkg_dir)
w = b.build_wheel(out)
try:
    s = b.build_sdist(out)
except Exception:
    s = None
print("wheel", w, "sdist", s)
# clean build junk
for j in ("build",):
    if os.path.isdir(j): shutil.rmtree(j, ignore_errors=True)
for f in os.listdir("."):
    if f.endswith(".egg-info"): shutil.rmtree(f, ignore_errors=True)
if os.path.isdir("src"):
    for f in os.listdir("src"):
        if f.endswith(".egg-info"): shutil.rmtree(os.path.join("src", f), ignore_errors=True)
PY
done < "$MANIFEST"

if [[ "$DRY" == "--dry-run" ]]; then
  echo "dry-run: built into $OUT, not uploading."; ls -1 "$OUT"; exit 0
fi

echo "== upload =="
if ! command -v twine >/dev/null 2>&1; then
  echo "twine not installed — install it in your release env (pipx install twine) and re-run."; exit 1
fi
twine upload --skip-existing "$OUT"/*
echo "Done. Verify: pip index versions unbrowse-requests"
