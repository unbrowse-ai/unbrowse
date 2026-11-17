#!/usr/bin/env bash
# The local fault injector, for runs without an Antithesis tenant (antithesis/local/soak.sh, explore.sh). It makes the
# faults the property catalog is written against happen, one at a time:
#
#   partition   a node, the chain or the shop drops every packet (netem loss 100%) for 10-90 s
#   split       two nodes stop reaching each other, everything else still reaches both, for 10-90 s
#   cut         a node stops reaching the chain, and still reaches its peers and the shop, for 20-150 s: its registry
#               reads and hold writes fail while peers keep talking to it
#   slow        a node, the chain or the shop answers late (netem delay 300-1500 ms, jitter) for 30-120 s
#   lossy       a node, the chain or the shop drops, duplicates and reorders some packets for 30-120 s
#   pause       a node or the chain is frozen (SIGSTOP) for 5-60 s
#   stall       the chain is frozen for 120-200 s: past the two minutes a node's background pass waits on it
#   crash       a node is killed (SIGKILL) and started again
#   chain       Anvil is killed and started again (it reloads state saved up to a second before: helper_chain
#               `rolled_back` keeps the checks from judging across that)
#
# Every choice comes from bash's RANDOM seeded by NEMESIS_SEED, so one seed and one profile give the same faults in
# the same order with the same lengths. Timing between them is the wall clock's, so a replay is close, not exact.
#
#   NEMESIS_SEED      seeds the faults (default: the time)
#   NEMESIS_GAP       seconds between faults (default 20; each gap is drawn from GAP/2..GAP)
#   NEMESIS_KINDS     comma list of the kinds above to draw from (default: all), repeats weight a kind
#   NEMESIS_STOP      a file: when it exists the nemesis heals everything and exits (SIGTERM heals too)
#   NEMESIS_SCHEDULE  a file to append each fault to, tab-separated: seconds since start, kind, target, length, detail
#
# Needs podman (rootless works: faults enter a container's network namespace with `podman unshare nsenter`) or docker
# (then nsenter runs under sudo), and the host's tc with netem, prio and u32.
set -u
STOP=${NEMESIS_STOP:-/tmp/unbrowse-nemesis.stop}
GAP=${NEMESIS_GAP:-20}
KINDS=${NEMESIS_KINDS:-partition,partition,split,cut,slow,lossy,pause,stall,crash,crash,chain}
SCHED=${NEMESIS_SCHEDULE:-/dev/null}
RANDOM=${NEMESIS_SEED:-$(date +%s)}
IFS=, read -r -a DRAW <<< "$KINDS"
NODES=(unbrowse-node-1 unbrowse-node-2 unbrowse-node-3)
NET_TARGETS=(unbrowse-node-1 unbrowse-node-2 unbrowse-node-3 unbrowse-chain unbrowse-site)
PAUSE_TARGETS=(unbrowse-node-1 unbrowse-node-2 unbrowse-node-3 unbrowse-chain)
if command -v podman >/dev/null; then E=podman; NS=(podman unshare nsenter); else E=docker; NS=(sudo nsenter); fi
T0=$(date +%s)

say() { echo "nemesis $(date -u +%T) $*"; }
record() { printf '%s\t%s\t%s\t%s\t%s\n' "$(( $(date +%s) - T0 ))" "$@" >> "$SCHED"; }
pick() { local a=("$@"); echo "${a[RANDOM % ${#a[@]}]}"; }
between() { echo $(( $1 + RANDOM % ($2 - $1 + 1) )); }

netns() {  # runs a command in container $1's network namespace
  local pid; pid=$($E inspect -f '{{.State.Pid}}' "$1" 2>/dev/null) || return 1
  [ "${pid:-0}" -gt 0 ] || return 1
  shift
  "${NS[@]}" -t "$pid" -n "$@"
}
dev_of() { netns "$1" ip -o link | awk -F': ' '$2!="lo"{print $2; exit}' | cut -d@ -f1; }
ip_of() { $E inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$1" 2>/dev/null; }
netem() { local d; d=$(dev_of "$1") && [ -n "$d" ] && netns "$1" tc qdisc replace dev "$d" root netem "${@:2}"; }
unnetem() { local d; d=$(dev_of "$1") && [ -n "$d" ] && netns "$1" tc qdisc del dev "$d" root 2>/dev/null; true; }
block_to() {  # container $1 drops what it sends to address $2, and nothing else
  local d; d=$(dev_of "$1") && [ -n "$d" ] && [ -n "$2" ] || return 1
  netns "$1" sh -c "tc qdisc replace dev $d root handle 1: prio &&
    tc qdisc add dev $d parent 1:3 handle 30: netem loss 100% &&
    tc filter add dev $d protocol ip parent 1:0 prio 3 u32 match ip dst $2/32 flowid 1:3"
}
state() { $E inspect -f '{{.State.Status}}' "$1" 2>/dev/null; }

heal() {
  for c in "${NET_TARGETS[@]}"; do unnetem "$c"; done
  for c in "${PAUSE_TARGETS[@]}"; do [ "$(state "$c")" = paused ] && $E unpause "$c" >/dev/null; done
  for c in "${NET_TARGETS[@]}"; do [ "$(state "$c")" = exited ] && $E start "$c" >/dev/null; done
  say healed
}
trap 'heal; exit 0' TERM INT

# Sleeps up to $1 seconds, stopping early when told to stop; returns 1 if told.
hold() { local i; for ((i = 0; i < $1; i++)); do [ -e "$STOP" ] && return 1; sleep 1; done; }

freeze() {  # $1 container, $2 seconds, $3 kind
  $E pause "$1" >/dev/null 2>&1 && say "$3 $1 ${2}s" && record "$3" "$1" "$2" - && { hold "$2"; $E unpause "$1" >/dev/null 2>&1; say "resume $1"; }
}

say "seed ${NEMESIS_SEED:-time} gap ${GAP}s kinds $KINDS engine $E"
while [ ! -e "$STOP" ]; do
  hold "$(between $((GAP / 2)) $GAP)" || break
  case $(pick "${DRAW[@]}") in
    partition) c=$(pick "${NET_TARGETS[@]}"); t=$(between 10 90)
      netem "$c" loss 100% && say "partition $c ${t}s" && record partition "$c" "$t" - && { hold "$t"; unnetem "$c"; say "rejoin $c"; } ;;
    split) a=$(pick "${NODES[@]}"); b=$(pick "${NODES[@]}"); t=$(between 10 90)
      [ "$a" = "$b" ] && b=${NODES[$(( (RANDOM % 2 + 1 + ${a##*-} - 1) % 3 ))]}
      block_to "$a" "$(ip_of "$b")" && block_to "$b" "$(ip_of "$a")" && say "split $a|$b ${t}s" && record split "$a|$b" "$t" - &&
        { hold "$t"; unnetem "$a"; unnetem "$b"; say "unsplit $a|$b"; } || { unnetem "$a"; unnetem "$b"; } ;;
    cut) c=$(pick "${NODES[@]}"); t=$(between 20 150)
      block_to "$c" "$(ip_of unbrowse-chain)" && say "cut $c ${t}s" && record cut "$c" "$t" - && { hold "$t"; unnetem "$c"; say "uncut $c"; } || unnetem "$c" ;;
    slow) c=$(pick "${NET_TARGETS[@]}"); t=$(between 30 120); ms=$(between 300 1500)
      netem "$c" delay "${ms}ms" "$((ms / 3))ms" && say "slow $c ${ms}ms ${t}s" && record slow "$c" "$t" "${ms}ms" && { hold "$t"; unnetem "$c"; say "fast $c"; } ;;
    lossy) c=$(pick "${NET_TARGETS[@]}"); t=$(between 30 120); l=$(between 5 30)
      netem "$c" delay 50ms 40ms loss "$l%" duplicate 5% reorder 25% && say "lossy $c ${l}% ${t}s" && record lossy "$c" "$t" "loss${l}%" &&
        { hold "$t"; unnetem "$c"; say "clean $c"; } ;;
    pause) freeze "$(pick "${PAUSE_TARGETS[@]}")" "$(between 5 60)" pause ;;
    stall) freeze unbrowse-chain "$(between 120 200)" stall ;;
    crash) c=$(pick "${NODES[@]}")
      $E kill -s KILL "$c" >/dev/null 2>&1 && say "crash $c" && record crash "$c" - - && { hold "$(between 2 20)"; $E start "$c" >/dev/null 2>&1; say "start $c"; } ;;
    chain) $E kill -s KILL unbrowse-chain >/dev/null 2>&1 && say "crash unbrowse-chain" && record chain unbrowse-chain - - &&
      { hold "$(between 2 10)"; $E start unbrowse-chain >/dev/null 2>&1; say "start unbrowse-chain"; } ;;
  esac
done
heal
