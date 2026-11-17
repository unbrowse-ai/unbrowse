#!/bin/sh
# The x-ray harness: the routes a node keeps, read against the engine's source as it is now. Each hole strung to where
# its value comes from, the findings on it, the functions of the engine that decide each, the node's pick, and each
# route's calls. No site is asked. README.md beside this file says how it works.
#
#   xray.sh                          THE LIVE VIEW (the default after a learn): serves wiring.py on 127.0.0.1
#                                    ($XRAY_PORT, default 7317, the next free one if taken) for the scratch node in
#                                    $UB_DIR (its routes, made.jsonl, node.log, walk captures); without UB_DIR,
#                                    ~/.unbrowse and the matrix runs under $TMPDIR. It redraws as the files change.
#   xray.sh state                    the same state the page draws, as JSON (no server): for a session without a browser
#   xray.sh diff <home A> <home B>   what changed between two homes, as text; exits 1 on a new break
#   xray.sh --text [routes...]       the findings and the code they point at, as text
#   xray.sh pages                    the static pages of the scratch node's routes, in ~/.unbrowse-xray
#   xray.sh <route.json|folder>...   static pages of those routes, in ~/.unbrowse-xray (open index.html)
#   xray.sh build                    builds the engine's own tree reader (route_tree) once; a few minutes
#   xray.sh walks [corpus]           reads kept walks with the rebuild's learner (default: the folder under
#                                    ~/.unbrowse-corpus with the most cases); about five minutes, kept until asked again
#
# What it reads, each settable:
#   UB_DIR         a scratch node's folder: its routes, its log and its walks are read when no route is named
#   XRAY_PORT      the live view's port (default 7317)
#   XRAY_LOG       the node's log to read (default $UB_DIR/node.log)
#   XRAY_RUNNING   the running engine's source: a checkout (read as it stands, uncommitted edits and all) or a git ref.
#                  Default: the checkout this file is in.
#   XRAY_REBUILD   the tree's source, a git ref. Default feat/engine-rebuild-2026-11-13; left out where there is none.
#   XRAY_TREE_SRC  a checkout that holds unbrowse-node/crates/learn/examples/route_tree.rs (for `build`)
#   XRAY_OUT       where the pages go. Default ~/.unbrowse-xray. Never inside a repository: a route names its site.
set -eu
S=$(cd "$(dirname "$0")" && pwd)
HERE=$(cd "$S/../.." && pwd)
OUT=${XRAY_OUT:-$HOME/.unbrowse-xray}
WORK=$OUT/work
BIN=${XRAY_TREE_BIN:-$HOME/.unbrowse-xray/bin/route_tree}   # one reader, wherever the pages go
REPO=$(git -C "$HERE" rev-parse --path-format=absolute --git-common-dir 2>/dev/null | sed 's#/\.git$##')
RUNNING=${XRAY_RUNNING:-$HERE}
REBUILD=${XRAY_REBUILD:-feat/engine-rebuild-2026-11-13}
TREE_SRC=${XRAY_TREE_SRC:-$HERE}
UB_DIR=${UB_DIR:-}
mkdir -p "$WORK" "$(dirname "$BIN")"

if [ "${1:-}" = build ]; then
  [ -f "$TREE_SRC/unbrowse-node/crates/learn/examples/route_tree.rs" ] || { echo "no route_tree.rs under $TREE_SRC: set XRAY_TREE_SRC to a checkout that has it" >&2; exit 1; }
  T=${CARGO_TARGET_DIR:-$TREE_SRC/unbrowse-node/target}
  export PATH="$HOME/.cargo/bin:$PATH" CARGO_TARGET_DIR="$T"
  (cd "$TREE_SRC/unbrowse-node" && cargo build -p unbrowse-learn --example route_tree --color never)
  cp "$T/debug/examples/route_tree" "$BIN"
  git -C "$TREE_SRC" log -1 --format='%h, %cd' --date=format:'%d %b %H:%M' > "$BIN.tip"
  echo "built $BIN from $(cat "$BIN.tip")"
  exit 0
fi

if [ "${1:-}" = walks ]; then
  [ -x "$BIN" ] || { echo "no route_tree yet: run xray.sh build" >&2; exit 1; }
  corpus=${2:-$(for d in "$HOME"/.unbrowse-corpus/*/; do echo "$(ls "$d"*/case.json 2>/dev/null | wc -l | tr -d ' ') $d"; done | sort -rn | head -1 | cut -d' ' -f2-)}
  [ -d "$corpus" ] || { echo "no corpus at ${corpus:-~/.unbrowse-corpus}" >&2; exit 1; }
  echo "reading $corpus with the rebuild's learner (about five minutes)..." >&2
  "$BIN" walks "$corpus" > "$WORK/walks.jsonl.new" 2> "$WORK/walks.err" || { echo "route_tree stopped: $(tail -1 "$WORK/walks.err")" >&2; exit 1; }
  [ -s "$WORK/walks.jsonl.new" ] || { echo "$corpus holds no site with two walks: nothing kept" >&2; exit 1; }
  mv "$WORK/walks.jsonl.new" "$WORK/walks.jsonl"
  echo "kept $(wc -l < "$WORK/walks.jsonl" | tr -d ' ') site(s) in $WORK/walks.jsonl; run xray.sh to draw them"
  exit 0
fi

# The engine's source, as two trees engine-map.py can read.
tip() { git -C "$1" log -1 --format='%h, %cd' --date=format:'%d %b %H:%M' "${2:-HEAD}"; }
export_ref() {  # <ref> <folder>
  rm -rf "$2.new" && mkdir -p "$2.new"
  git -C "$REPO" archive "$1" unbrowse-node/crates unbrowse-node/app/src | tar -x -C "$2.new"
  tip "$REPO" "$1" > "$2.new/TIP"
  rm -rf "$2.old"; [ ! -d "$2" ] || mv "$2" "$2.old"; mv "$2.new" "$2"; rm -rf "$2.old"
}
maps=""
if [ -d "$RUNNING/unbrowse-node/crates" ]; then
  dirty=$(git -C "$RUNNING" status --porcelain -- unbrowse-node 2>/dev/null | grep -v vendor | head -1 || true)
  mkdir -p "$WORK/running-here"
  rm -f "$WORK/running-here/unbrowse-node" && ln -s "$RUNNING/unbrowse-node" "$WORK/running-here/unbrowse-node"
  echo "$(tip "$RUNNING")${dirty:+ with uncommitted edits}" > "$WORK/running-here/TIP"
  maps="running=$WORK/running-here"
elif git -C "$REPO" rev-parse -q --verify "$RUNNING^{commit}" >/dev/null 2>&1; then
  export_ref "$RUNNING" "$WORK/src-running"; maps="running=$WORK/src-running"
fi
if git -C "$REPO" rev-parse -q --verify "$REBUILD^{commit}" >/dev/null 2>&1; then
  export_ref "$REBUILD" "$WORK/src-rebuild"; maps="$maps rebuild=$WORK/src-rebuild"
fi
args=""
if [ -n "$maps" ]; then
  # shellcheck disable=SC2086
  python3 "$S/engine-map.py" $maps > "$WORK/engine-map.json"
  args="--map $WORK/engine-map.json"
else
  echo "the engine's source was not found (set XRAY_RUNNING to a checkout): the pages will not show the code" >&2
fi

# The live view, its JSON and its diff: wiring.py, which reads the running engine itself (live, edits included) and
# the rebuild from the map made above.
LOG=${XRAY_LOG:-${UB_DIR:+$UB_DIR/node.log}}
mapflag=""; [ ! -s "$WORK/engine-map.json" ] || mapflag="--map $WORK/engine-map.json"
engflag=""; [ ! -d "$RUNNING/unbrowse-node" ] || engflag="--engine $RUNNING"
where=""
if [ -n "$UB_DIR" ]; then where="--ub-dir $UB_DIR"; else where="--home $HOME/.unbrowse --matrix"; fi
[ -z "$LOG" ] || [ ! -s "$LOG" ] || where="$where --log $LOG"
case "${1:-}" in
  ""|serve)
    [ "${1:-}" != serve ] || shift
    # shellcheck disable=SC2086
    exec python3 "$S/wiring.py" serve $where $engflag $mapflag --port "${XRAY_PORT:-7317}" "$@" ;;
  state)
    shift
    # shellcheck disable=SC2086
    exec python3 "$S/wiring.py" state $where $engflag $mapflag "$@" ;;
  diff)
    shift
    exec python3 "$S/wiring.py" diff "$@" ;;
esac

text=""; routes=""
for a in "$@"; do
  case "$a" in --text) text=--text ;; pages) ;; *) routes="$routes $a" ;; esac
done
if [ -z "$routes" ]; then
  [ -n "$UB_DIR" ] || { echo "name the routes to read (route files or folders), or set UB_DIR to a scratch node's folder" >&2; exit 2; }
  routes="$UB_DIR/home/node/routes"
fi

# The same routes said as trees, by the engine itself.
if [ -x "$BIN" ]; then
  files=""
  for r in $routes; do
    if [ -d "$r" ]; then files="$files $(ls "$r"/*.json 2>/dev/null | tr '\n' ' ')"; else files="$files $r"; fi
  done
  # shellcheck disable=SC2086
  [ -z "$(echo $files)" ] || { "$BIN" body $files > "$WORK/tree.jsonl" 2>/dev/null && args="$args --tree $WORK/tree.jsonl"; }
else
  echo "no route_tree yet (xray.sh build): the holes will not be shown as the tree says them" >&2
fi
[ ! -s "$WORK/walks.jsonl" ] || [ -n "$text" ] || args="$args --walks $WORK/walks.jsonl"

# What the engine surfaced while it learned each route: the node's own log.
[ -z "$LOG" ] || [ ! -s "$LOG" ] || args="$args --log $LOG"
XRAY_TREE_TIP=$(cat "$BIN.tip" 2>/dev/null || true); export XRAY_TREE_TIP
# shellcheck disable=SC2086
python3 "$S/route-xray.py" $routes $args --out "$OUT" $text
