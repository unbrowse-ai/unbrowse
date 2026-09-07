#!/usr/bin/env bash
# visibility-gate.sh — the right things are open/closed: papers done, backend
# private, frontend CLI fully open source, frontend web private (sp-opencore
# boundary walk). Exits 0 exactly when every component sits on the right side of
# the line AND it is declared in OPEN-SOURCE-NOTICE.md AND enforced (license flags,
# the clean client→backend seam, leak-guard, the published-package allow-lists).
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
NOTICE="docs/OPEN-SOURCE-NOTICE.md"
fail=0
section() { echo; echo "=== $1 ==="; }
license() { python3 -c "import json,sys;print(json.load(open(sys.argv[1])).get('license') or '')" "$1" 2>/dev/null; }
priv() { python3 -c "import json,sys;print(json.load(open(sys.argv[1])).get('private') is True)" "$1" 2>/dev/null; }
has_files() { python3 -c "import json,sys;print('files' in json.load(open(sys.argv[1])))" "$1" 2>/dev/null; }

# --- 1. PAPERS done properly --------------------------------------------------
section "1. all papers done properly"
if bash scripts/papers-done-gate.sh >/tmp/vg_papers.out 2>&1; then echo "  papers: done (gate green)"; else echo "  PAPERS-FAIL (see /tmp/vg_papers.out)"; fail=1; fi

# --- 2. BACKEND private -------------------------------------------------------
section "2. backend is a private repo (engine + marketplace)"
if bash scripts/backend-separation-gate.sh >/tmp/vg_backend.out 2>&1; then echo "  seam: clean, backend separable + non-leaking"; else echo "  BACKEND-SEAM-FAIL (see /tmp/vg_backend.out)"; fail=1; fi
if grep -qiE 'backend.*private repo|private repo.*backend' "$NOTICE"; then echo "  declared: $NOTICE marks backend private"; else echo "  BACKEND-DECL-FAIL: $NOTICE does not mark backend a private repo"; fail=1; fi

# --- 3. FRONTEND CLI fully open source ----------------------------------------
section "3. frontend CLI is fully open source (MIT client surface)"
for p in packages/sdk-v2 packages/sdk; do
  if [ "$(license $p/package.json)" = "MIT" ]; then echo "  MIT: $p"; else echo "  CLI-LICENSE-FAIL: $p is not MIT"; fail=1; fi
done
if grep -qiE 'open source|MIT' "$NOTICE" && grep -qiE 'CLI|@unbrowse/client' "$NOTICE"; then echo "  declared: $NOTICE marks the CLI/client open source"; else echo "  CLI-DECL-FAIL: $NOTICE does not declare the CLI open source"; fail=1; fi
if bash scripts/leak-guard.sh >/tmp/vg_leak.out 2>&1; then echo "  leak-guard: the open surface carries no moat"; else echo "  CLI-LEAK-FAIL (see /tmp/vg_leak.out)"; fail=1; fi

# --- 4. FRONTEND web private --------------------------------------------------
section "4. frontend web app is private"
if [ "$(priv frontend/package.json)" = "True" ]; then echo "  flag: frontend/package.json private=true"; else echo "  WEB-PRIVATE-FAIL: frontend is not marked private"; fail=1; fi
if [ "$(has_files frontend/package.json)" = "False" ]; then echo "  unpublished: frontend declares no npm files allow-list"; else echo "  WEB-PUBLISH-FAIL: frontend declares a files allow-list (would publish)"; fail=1; fi
if grep -qiE 'web app.*private|frontend web.*private|private repo.*web' "$NOTICE"; then echo "  declared: $NOTICE marks the web app private"; else echo "  WEB-DECL-FAIL: $NOTICE does not mark the web app private"; fail=1; fi
# the web must not be a leak-guard PUBLIC_PATH
if grep -qE '^\s*"frontend' scripts/leak-guard.sh; then echo "  WEB-PATH-FAIL: frontend/ is listed as a public path in leak-guard"; fail=1; else echo "  not-public: frontend/ is not a leak-guard public path"; fi

echo
if [ "$fail" -ne 0 ]; then
  echo "VISIBILITY-GATE FAIL — a component is on the wrong side of the open/closed line (or undeclared)."
  exit 1
fi
echo "VISIBILITY-GATE PASS — papers done; backend private; CLI fully open source; web private; declared + enforced."
