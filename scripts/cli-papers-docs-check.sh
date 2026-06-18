#!/usr/bin/env bash
# Falsifiable signal: `unbrowse eval stats --json` surfaces the papers' economy +
# privacy story under a top-level `docs` object (src/cli-v7/eval/stats.ts).
# GREEN iff docs has all four keys AND privacy mentions "zero-knowledge"
# (case-insensitive) AND economy mentions "x402".
set -uo pipefail
cd "$(dirname "$0")/.."

PYCHECK="$(mktemp -t cli-papers-docs-check.XXXXXX.py)"
trap 'rm -f "$PYCHECK"' EXIT
cat > "$PYCHECK" <<'PYEOF'
import sys, json

raw = sys.stdin.read()
try:
    data = json.loads(raw)
except Exception as e:
    print("CLI-PAPERS-DOCS RED")
    print("  could not parse JSON: %s" % e)
    print("  raw head: %r" % raw[:300])
    sys.exit(1)

docs = data.get("docs")
if not isinstance(docs, dict):
    print("CLI-PAPERS-DOCS RED")
    print("  no top-level `docs` object; got: %s" % type(docs).__name__)
    print("  top-level keys: %s" % list(data.keys()))
    sys.exit(1)

required = ["how_it_pays", "economy", "privacy", "papers"]
missing = [k for k in required if k not in docs]
if missing:
    print("CLI-PAPERS-DOCS RED")
    print("  docs missing keys: %s" % missing)
    print("  docs actually contains: %s" % json.dumps(docs, indent=2))
    sys.exit(1)

privacy = str(docs.get("privacy", ""))
economy = str(docs.get("economy", ""))
errs = []
if "zero-knowledge" not in privacy.lower():
    errs.append('docs.privacy does not mention "zero-knowledge": %r' % privacy)
if "x402" not in economy.lower():
    errs.append('docs.economy does not mention "x402": %r' % economy)
if errs:
    print("CLI-PAPERS-DOCS RED")
    for e in errs:
        print("  %s" % e)
    print("  docs actually contains: %s" % json.dumps(docs, indent=2))
    sys.exit(1)

print("CLI-PAPERS-DOCS GREEN")
sys.exit(0)
PYEOF

timeout 70 bun src/cli.ts eval stats --json 2>/dev/null | python3 "$PYCHECK"
exit ${PIPESTATUS[1]}
