#!/usr/bin/env bash
# github-public-gate.sh — the public stuff points at the unbrowse-ai GitHub org.
#
# sp-opencore node-settle: a published module is only well-formed when it carries
# the right license AND names where it lives. Every public package (the JS shims +
# agent-SDK adapters in the npm manifests, and the Python adapters) must declare
# license MIT and a repository URL in github.com/unbrowse-ai — so npm/PyPI link the
# package back to the org's public repo. Exits 0 iff every public package does.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
ORG="github.com/unbrowse-ai"
fail=0
section() { echo; echo "=== $1 ==="; }

check_js() {  # pkg_dir
  python3 - "$1" "$ORG" <<'PY'
import json,sys
pj,org=sys.argv[1],sys.argv[2]
d=json.load(open(pj+"/package.json"))
lic=d.get("license"); r=d.get("repository"); url=r.get("url") if isinstance(r,dict) else (r or "")
ok = lic=="MIT" and org in (url or "")
print(("ok" if ok else "FAIL")+f"|license={lic}|repo={url or '-'}")
PY
}
check_py() {  # pkg_dir
  python3 - "$1" "$ORG" <<'PY'
import tomllib,sys
pj,org=sys.argv[1],sys.argv[2]
d=tomllib.load(open(pj+"/pyproject.toml","rb"))["project"]
lic=d.get("license"); lic=lic.get("text") if isinstance(lic,dict) else lic
urls=d.get("urls",{}) or {}
has_org=any(org in str(v) for v in urls.values())
ok = lic=="MIT" and has_org
print(("ok" if ok else "FAIL")+f"|license={lic}|repo={'yes' if has_org else 'MISSING'}")
PY
}

section "JS public packages (npm @unbrowse/*)"
js_dirs=$(awk -F'\t' '!/^#/ && NF>=3 {print $3}' scripts/dropin-manifest.tsv scripts/agent-sdk-manifest.tsv | sort -u)
for d in $js_dirs; do
  [ -f "$d/package.json" ] || continue
  res=$(check_js "$d"); st=${res%%|*}
  printf '  %-26s %s\n' "$(basename "$d")" "$res"
  [ "$st" = ok ] || fail=1
done

section "Python public packages (PyPI unbrowse-*)"
py_dirs=$(awk -F'\t' '!/^#/ && NF>=3 {print $3}' scripts/python-adapter-manifest.tsv | sort -u)
for d in $py_dirs; do
  [ -f "$d/pyproject.toml" ] || continue
  res=$(check_py "$d"); st=${res%%|*}
  printf '  %-26s %s\n' "$(basename "$d")" "$res"
  [ "$st" = ok ] || fail=1
done

echo
if [ "$fail" -ne 0 ]; then echo "GITHUB-PUBLIC-GATE FAIL — a public package does not point at the unbrowse-ai org (or is not MIT)."; exit 1; fi
echo "GITHUB-PUBLIC-GATE PASS — every public package is MIT and points at github.com/unbrowse-ai."
