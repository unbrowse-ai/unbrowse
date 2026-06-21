#!/usr/bin/env bash
# rebuild-reinstall-gate.sh — the jesus-ralph witness for "rebuild and reinstall again":
# the contract substrate is freshly re-signed AND the unbrowse CLI, rebuilt + reinstalled
# from a fresh tarball, carries the embedded libcontract AND declares a /contract IN-PROCESS
# via that vendored lib (emergence survives a real pack→install round-trip).
#
# Exit 0 ONLY when ALL hold (no fabricated green):
#   R1 substrate — ~/.claude/skills/contract/scripts/contract verify-self == OK (re-signed binary valid)
#   R2 embedding — scripts/contract-native-gate.sh GREEN (vendor+bind+files+in-process, dev tree)
#   R3 seam      — bun test tests/contract-native-seam.test.ts (the CLI USES the embedded substrate)
#   R4 reinstall — fresh `npm pack` of packages/skill carries vendor/contract/<host>, and a fresh
#                  install of that tarball into a temp prefix declares a /contract in-process via the
#                  INSTALLED embedded lib (8-hex id). Proves the round-trip, not just the dev tree.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"; cd "$ROOT" || exit 2
fail() { echo "GATE RED — $1"; exit 1; }
HOST="$(node -e 'process.stdout.write(process.platform+"-"+process.arch)')"
case "$HOST" in *darwin*) EXT=dylib;; *win*) EXT=dll;; *) EXT=so;; esac

# R1 — the re-signed contract substrate self-attests
CB="$HOME/.claude/skills/contract/scripts/contract"
[ -x "$CB" ] || fail "R1 substrate: contract binary missing at $CB"
"$CB" verify-self >/tmp/rr-r1.log 2>&1 && grep -qi "verify-self: OK\|OK" /tmp/rr-r1.log || fail "R1 substrate: contract verify-self not OK"
echo "ok R1 substrate — contract verify-self OK"

# R2 — embedding intact in the dev tree
bash scripts/contract-native-gate.sh >/tmp/rr-r2.log 2>&1 || { tail -5 /tmp/rr-r2.log; fail "R2 embedding: contract-native-gate not green"; }
echo "ok R2 embedding — vendored + linked + in-process (dev tree)"

# R3 — the seam actually uses the embedded substrate
bun test tests/contract-native-seam.test.ts >/tmp/rr-r3.log 2>&1 || { tail -8 /tmp/rr-r3.log; fail "R3 seam: contract-native-seam test failed"; }
echo "ok R3 seam — eval-resolve hot path uses the embedded substrate"

# R4 — fresh pack → install → in-process declare on the INSTALLED artifact
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
( cd packages/skill && npm pack --pack-destination "$WORK" ) >/tmp/rr-r4pack.log 2>&1 || { tail -8 /tmp/rr-r4pack.log; fail "R4 reinstall: npm pack failed"; }
TGZ="$(ls "$WORK"/*.tgz 2>/dev/null | head -1)"; [ -n "$TGZ" ] || fail "R4 reinstall: no tarball produced"
tar -tzf "$TGZ" | grep -q "vendor/contract/$HOST/libcontract.$EXT" || fail "R4 reinstall: tarball omits vendor/contract/$HOST/libcontract.$EXT"
mkdir -p "$WORK/inst" && ( cd "$WORK/inst" && npm init -y >/dev/null 2>&1 && npm install "$TGZ" >/tmp/rr-r4inst.log 2>&1 ) || { tail -8 /tmp/rr-r4inst.log; fail "R4 reinstall: npm install of tarball failed"; }
PKGDIR="$(ls -d "$WORK"/inst/node_modules/unbrowse 2>/dev/null || ls -d "$WORK"/inst/node_modules/* 2>/dev/null | head -1)"
ID="$(cd "$PKGDIR" && bun -e '
import { dlopen, FFIType, CString } from "bun:ffi";
import { existsSync } from "node:fs"; import { join } from "node:path";
const HOST=process.platform+"-"+process.arch;
const EXT=process.platform==="darwin"?"dylib":process.platform==="win32"?"dll":"so";
const lib=join(process.cwd(),"vendor","contract",HOST,`libcontract.${EXT}`);
if(!existsSync(lib)){console.log("NO-LIB");process.exit(0);}
const {symbols}=dlopen(lib,{contract_declare:{args:[FFIType.cstring,FFIType.cstring,FFIType.cstring,FFIType.cstring],returns:FFIType.ptr}});
const p=symbols.contract_declare(Buffer.from("reinstall witness\0"),Buffer.from("installed\0"),Buffer.from("\0"),Buffer.from("\0"));
console.log(p?new CString(p).toString():"NULL");
' 2>/dev/null | tail -1)"
echo "$ID" | grep -qE '^[0-9a-f]{8}$' || fail "R4 reinstall: installed CLI did not declare in-process (got: $ID)"
echo "ok R4 reinstall — installed unbrowse declares /contract in-process via embedded lib (id=$ID)"

echo "GATE GREEN — rebuilt + reinstalled: /contract substrate re-signed, embedded, and live in the installed CLI"
