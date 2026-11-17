#!/usr/bin/env bash
# Coverage-guided search over fault schedules, with no Antithesis tenant: many short soak.sh runs, each with its own
# seed and fault profile, steered toward the Sometimes and Reachable assertions no run has made come true yet.
#
#   antithesis/local/explore.sh          from the repo root, after one soak.sh has built the images
#
#   EXPLORE_RUNS     runs to make (default 8)               EXPLORE_MINUTES  driver minutes per run (default 6)
#   EXPLORE_SEED     seeds the search itself (default: the time), so a whole search can be made again
#   EXPLORE_DIR      where it keeps state (default antithesis/local/explore, git-ignored; kept across searches)
#
# A profile is a seed, a gap between faults and the kinds of fault to draw from (nemesis.sh). Half the runs take a
# fresh profile: each kind is in with even odds (swarm testing: leaving faults out reaches states a mix of all of them
# keeps interrupting). The other half mutate a profile from the corpus, the runs that made something new come true:
# a new seed, the gap moved, one kind added or dropped. A run that made a new assertion come true joins the corpus.
#
# State: corpus.tsv (the profiles that found something), seen.txt (everything that came true in any run),
# failures.tsv (each run that violated an assertion beyond known-violations.txt, with the command that replays it),
# runs/<n>-<seed>/ (each run's soak output). Prints ANTITHESIS_LOCAL_EXPLORE_DONE with the counts and the assertions
# still never reached; exits 1 if any run failed.
set -u
cd "$(dirname "$0")/../.."
HERE=antithesis/local
DIR=${EXPLORE_DIR:-$HERE/explore}
RUNS=${EXPLORE_RUNS:-8}
MIN=${EXPLORE_MINUTES:-6}
RANDOM=${EXPLORE_SEED:-$(date +%s)}
ALL=(partition split cut slow lossy pause stall crash chain)
mkdir -p "$DIR/runs"; touch "$DIR/corpus.tsv" "$DIR/seen.txt" "$DIR/failures.tsv"
log() { echo "== $(date -u +%FT%TZ) $*"; }

fresh() {
  local k=() x
  for x in "${ALL[@]}"; do [ $((RANDOM % 2)) = 1 ] && k+=("$x"); done
  [ ${#k[@]} -eq 0 ] && k=("${ALL[RANDOM % ${#ALL[@]}]}")
  GAP=$((8 + RANDOM % 23)); KINDS=$(IFS=,; echo "${k[*]}")
}
mutate() {  # from a random corpus line: seed<TAB>gap<TAB>kinds<TAB>new
  local line; line=$(sed -n "$((1 + RANDOM % $(wc -l < "$DIR/corpus.tsv")))p" "$DIR/corpus.tsv")
  GAP=$(cut -f2 <<< "$line"); KINDS=$(cut -f3 <<< "$line")
  GAP=$((GAP + RANDOM % 11 - 5)); [ "$GAP" -lt 6 ] && GAP=6
  local x=${ALL[RANDOM % ${#ALL[@]}]}
  if [[ ",$KINDS," == *",$x,"* ]]; then
    local d; d=$(tr , '\n' <<< "$KINDS" | grep -vx "$x" | paste -sd,); [ -n "$d" ] && KINDS=$d
  else KINDS="$KINDS,$x"; fi
}

fails=0
for i in $(seq 1 "$RUNS"); do
  if [ -s "$DIR/corpus.tsv" ] && [ $((RANDOM % 2)) = 1 ]; then mutate; how=mutated; else fresh; how=fresh; fi
  SEED=$(( (RANDOM << 15 | RANDOM) ))
  n=$(( $(ls "$DIR/runs" | wc -l) + 1 )); OUT="$DIR/runs/$n-$SEED"
  log "run $i/$RUNS ($how) seed $SEED gap $GAP kinds $KINDS"
  BUILD=0 SOAK_SEED=$SEED SOAK_MINUTES=$MIN NEMESIS_GAP=$GAP NEMESIS_KINDS=$KINDS OUT=$OUT "$HERE/soak.sh" > "$OUT.log" 2>&1
  rc=$?; mv "$OUT.log" "$OUT/soak.log" 2>/dev/null
  if [ ! -s "$OUT/assertions.txt" ]; then log "run $i made no assertions (setup or teardown failed): $OUT/soak.log"; continue; fi
  new=$(sort -u "$OUT/coverage.txt" | comm -23 - <(sort -u "$DIR/seen.txt") | tee "$OUT/new.txt" | wc -l)
  sort -u "$OUT/coverage.txt" "$DIR/seen.txt" -o "$DIR/seen.txt"
  [ "$new" -gt 0 ] && printf '%s\t%s\t%s\t%s\n' "$SEED" "$GAP" "$KINDS" "$new" >> "$DIR/corpus.tsv"
  if [ $rc -ne 0 ]; then
    fails=$((fails + 1))
    printf '%s\t%s\t%s\n' "$OUT" "$(grep -c 'VIOLATED' "$OUT/assertions.txt")" "$(grep '^replay:' "$OUT/soak.log" | cut -d' ' -f2-)" >> "$DIR/failures.tsv"
    log "run $i FAILED: $(grep -v KNOWN "$OUT/assertions.txt" | grep VIOLATED | cut -c52- | paste -sd';')"
  fi
  log "run $i: $(grep -c . "$OUT/coverage.txt") came true, $new new, $(wc -l < "$DIR/seen.txt") seen in all"
done

# The frontier: every Sometimes and Reachable any run evaluated, less what came true in some run.
cat "$DIR"/runs/*/assertions.txt 2>/dev/null | awk '$2=="Sometimes"||$2=="Reachable"' |
  sed -E 's/^(\S+)\s+\S+\s+.{20} hits=\S+\s+/\1\t/' | sort -u | comm -23 - "$DIR/seen.txt" > "$DIR/frontier.txt"
echo "never came true in any run ($(wc -l < "$DIR/frontier.txt")):"; sed 's/^/  /' "$DIR/frontier.txt"
echo "ANTITHESIS_LOCAL_EXPLORE_DONE runs=$RUNS failures=$fails seen=$(wc -l < "$DIR/seen.txt") frontier=$(wc -l < "$DIR/frontier.txt")"
[ "$fails" -eq 0 ]
