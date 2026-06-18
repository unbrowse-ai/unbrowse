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

# `eval stats` emits the docs block only on the backend-success path, so a transient
# /v1/stats/summary timeout (common under a heavy gate run) would falsely redden this
# witness. The docs block itself is static + correct; tolerate a network blip with a
# bounded retry — green on the first run that reaches the backend, fail only if all do.
for attempt in 1 2 3; do
  # pipefail is set, so $? of the command-substitution assignment is the pipeline's
  # status (python's, or bun's if it failed first). PIPESTATUS does NOT apply here.
  out="$(timeout 70 bun src/cli.ts eval stats --json 2>/dev/null | python3 "$PYCHECK")"
  rc=$?
  if [ "$rc" -eq 0 ]; then echo "$out"; exit 0; fi
  [ "$attempt" -lt 3 ] && sleep 2
done
echo "$out"
exit "$rc"
