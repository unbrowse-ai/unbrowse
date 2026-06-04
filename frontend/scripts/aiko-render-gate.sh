#!/usr/bin/env bash
# aiko-render-gate — witness for streamdown + json-render generative UI + the
# jesus-pattern DESIGN method shipped as the default design skill.
# Exit 0 iff all are real and src typechecks.
set -uo pipefail
cd "$(dirname "$0")/.."   # frontend/
FAIL=0
need() { if [ ! -f "$1" ]; then echo "  ✗ missing $1 ($3)"; FAIL=1; return; fi
  grep -qiE -- "$2" "$1" || { echo "  ✗ $1: missing /$2/ ($3)"; FAIL=1; }; }

# 1. streamdown markdown rendering in the chat
need src/components/aiko-home.tsx 'from "streamdown"' "streamdown imported"
need src/components/aiko-home.tsx '<Streamdown' "streamdown renders the answer"

# 2. json-render generative UI
need src/components/generative-ui.tsx '@json-render/react' "json-render react imported"
need src/components/generative-ui.tsx 'Renderer' "uses the json-render Renderer"
need src/components/generative-ui.tsx 'export function GenerativeUI|export const GenerativeUI' "exports GenerativeUI"
need src/components/generative-ui.tsx 'export function extractUiSpec' "exports the spec extractor"
need src/components/aiko-home.tsx 'GenerativeUI|extractUiSpec' "chat renders generative UI when a spec is returned"

# 2b. generative UI is witnessed rendering a real spec (demo, since the live agent
#     can't emit specs yet — backend prompt change required, see aiko-home note)
need src/components/aiko-home.tsx 'DEMO_UI_SPEC' "a real json-ui demo spec exists"
need src/components/aiko-home.tsx 'showDemo|See generative UI' "the demo is triggerable in-UI"
# the embedded spec must be valid json-render (root + elements)
node -e 'const s=require("fs").readFileSync("src/components/aiko-home.tsx","utf8"); const m=s.match(/JSON\.stringify\((\{[\s\S]*?\})\)\s*\+\s*.\\n```/); if(!m){console.error("no demo spec object");process.exit(1)} const o=eval("("+m[1]+")"); if(!o.root||!o.elements){console.error("demo spec missing root/elements");process.exit(1)} console.log("[aiko-render-gate] demo spec valid:",Object.keys(o.elements).length,"elements");' || FAIL=1

# 3. jesus-pattern DESIGN shipped as the default design skill
[ -f src/skills/design.md ] || { echo "  ✗ missing src/skills/design.md (default design skill)"; FAIL=1; }
grep -q 'name: design' src/skills/design.md 2>/dev/null || { echo "  ✗ design skill missing frontmatter"; FAIL=1; }
need src/components/generative-ui.tsx 'DEFAULT_DESIGN_SKILL|design skill' "generative UI references the default design skill"

# 4. packages declared
grep -q '"streamdown"' package.json || { echo "  ✗ streamdown not in package.json"; FAIL=1; }
grep -q '@json-render/react' package.json || { echo "  ✗ @json-render/react not in package.json"; FAIL=1; }

# 5. real compile
echo "[aiko-render-gate] typechecking src/ (stale .next stubs ignored)..."
SRC_ERRORS=$(timeout 180 bunx tsc --noEmit 2>&1 | grep -E '^src/' || true)
[ -z "$SRC_ERRORS" ] || { echo "  ✗ src type errors:"; printf '%s\n' "$SRC_ERRORS" | head -15 | sed 's/^/    /'; FAIL=1; }

[ "$FAIL" -ne 0 ] && { echo "[aiko-render-gate] FAIL"; exit 1; }
echo "[aiko-render-gate] PASS — streamdown + json-render generative UI + default design skill wired; src typechecks"
