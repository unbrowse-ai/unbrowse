#!/bin/bash
# ship.sh - runs the ship_command DECLARED in the state file frontmatter.
# Substrate principle: surfaces what is declared, never bakes the literal.
set -uo pipefail
cd "$(dirname "$0")/../../.."
export PLAN=add-an-opt-in-paid-residential-proxy-fallback-fo
export SCAFFOLD="$(cd "$(dirname "$0")/.." && pwd)"
STATE_FILE="$(dirname "$SCAFFOLD")/${PLAN}.local.md"

SHIP_CMD="$(python3 - "$STATE_FILE" <<'PYEXTRACT'
import sys, re
text = open(sys.argv[1]).read()
m = re.match(r"^---\n(.*?)\n---", text, re.S)
if not m:
    sys.exit("[ship] no frontmatter in state file")
fm = m.group(1)
m2 = re.search(r"^ship_command:\s*\|\s*\n((?:[ \t]+.*\n?)+)", fm, re.M)
if m2:
    body = m2.group(1)
    lines = body.splitlines()
    indents = [len(l) - len(l.lstrip()) for l in lines if l.strip()]
    strip = min(indents) if indents else 0
    print("\n".join(l[strip:] if len(l) >= strip else l for l in lines))
    sys.exit(0)
m3 = re.search(r"^ship_command:\s*(.+)$", fm, re.M)
if not m3:
    sys.exit("[ship] no ship_command declared")
print(m3.group(1).strip())
PYEXTRACT
)"
if [ -z "$SHIP_CMD" ]; then
  echo "[ship:$PLAN] FATAL: could not extract ship_command from state file" >&2
  exit 3
fi
echo "[ship:$PLAN] state-file ship_command:"
echo "$SHIP_CMD" | sed 's/^/    /'
bash -c "$SHIP_CMD"
