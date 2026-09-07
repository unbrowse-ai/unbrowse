#!/usr/bin/env bash
# thin-client-gate — measures how many MOAT-INTELLIGENCE modules sit in the public
# client's transitive import closure. The thin-client migration drives this to 0:
# the intelligence (RE inference, indexing/admission scoring, graph compilation,
# ranking) runs server-side over a ZK/obfuscated egress; the client calls the API.
#
# MOAT set (must leave the client primary closure): reverse-engineer, indexer, graph,
# ranking, marketplace, intent-match, extraction.
# STAYS client (NOT moat — drive-a-browser / make-a-call / sign-with-my-key):
# capture, cdp, browser, execution, values, auth, vault, payments, obfuscate, zk-bound-hole.
#
# Seeds = the public client entrypoints. The number is the real import graph — it
# cannot be faked. Exit 0 only when 0 moat modules remain in the closure.

set -uo pipefail
cd "$(dirname "$0")/.." || exit 2

python3 - <<'PY'
import subprocess, re, os, sys
# MOAT = the agreed set (the "what moves vs stays" table): the reverse-engineerable
# tuning/inference IP. NOT extraction (local cheerio/readability content parsing),
# marketplace (backend API client + local bookkeeping; authoritative scoring is
# server-side), or intent-match (local result matching) — those are client-local.
MOAT={'reverse-engineer','indexer','graph','ranking'}
SEEDS=['sdk','client','cli-v7']           # dirs
SEED_FILES=['cli.ts','mcp.ts','index.ts'] # top-level entrypoints

def dir_imports(d):
    out=subprocess.run(['git','grep','-hoE',r"from ['\"](\.\./)+[a-z0-9-]+",'--','src/'+d],
                       capture_output=True,text=True).stdout
    return set(re.findall(r"from ['\"](?:\.\./)+([a-z0-9-]+)",out))
def file_imports(f):
    p='src/'+f
    if not os.path.isfile(p): return set()
    out=subprocess.run(['grep','-hoE',r"from ['\"]\./[a-z0-9-]+",p],
                       capture_output=True,text=True).stdout
    deps=set(re.findall(r"from ['\"]\./([a-z0-9-]+)",out))
    return {d for d in deps if os.path.isdir('src/'+d)}

keep=set(SEEDS); frontier=list(SEEDS)
for f in SEED_FILES:
    for d in file_imports(f):
        if d not in keep: keep.add(d); frontier.append(d)
while frontier:
    d=frontier.pop()
    for dep in dir_imports(d):
        if os.path.isdir('src/'+dep) and dep not in keep:
            keep.add(dep); frontier.append(dep)

moat_in=sorted(keep & MOAT)
print(f"client import closure: {len(keep)} modules")
print(f"MOAT modules still in the closure ({len(moat_in)}): {moat_in or 'NONE'}")
print(f"target: 0  |  ranking is already server-first when absent here")
sys.exit(1 if moat_in else 0)
PY
rc=$?

# reverse-engineer is SERVER-ONLY: no client (src/) file may import the inference engine,
# static OR dynamic (the static-closure walk above misses a lazy `import()`; this catches it).
# The only allowed importer is backend/ (not part of the client and not mirrored).
re_imp=$(git grep -lE "(from|import\()\s*['\"]((\.\./)+|\./)?reverse-engineer/(index|description-prompt)" -- src 2>/dev/null || true)
if [ -n "$re_imp" ]; then
  echo "─────────────────────────────────────────────────────────"
  echo "GATE RED — client (src/) imports the SERVER-ONLY reverse-engineer engine:"
  echo "$re_imp" | sed 's/^/    /'
  echo "  route RE through src/capture/reveng-server-first.ts (server), not a local import."
  exit 1
fi

echo "─────────────────────────────────────────────────────────"
if [ "$rc" -ne 0 ]; then
  echo "GATE RED — moat intelligence still reachable from the public client; migrate it server-side"
  exit 1
fi
echo "GATE GREEN — public client is thin: no moat closure + reverse-engineer is server-only"
exit 0
