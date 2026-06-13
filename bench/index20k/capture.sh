#!/usr/bin/env bash
# Mechanical capture rung (NOT judgment): drive `unbrowse resolve` per site, bounded, write the
# raw artifact. Agents judge the artifacts afterward (harness collects, agent judges). Incremental.
set -u
CORPUS="${1:?corpus.jsonl}"; START="${2:-0}"; COUNT="${3:-30}"; CONC="${4:-8}"; TO="${5:-25}"
OUT="bench/index20k/artifacts"; RES="bench/index20k/results.jsonl"
BIN="${UNBROWSE_BIN:-unbrowse}"
sem(){ while [ "$(jobs -rp | wc -l)" -ge "$CONC" ]; do wait -n 2>/dev/null || sleep 0.2; done; }
one(){
  local url="$1" intent="$2" idx="$3"
  local f="$OUT/$(printf '%05d' "$idx").json"
  timeout "$TO" "$BIN" resolve --url "$url" --intent "$intent" --json >"$f" 2>/dev/null
  local rc=$?
  # structural PRE-class only (agent re-judges later): poison / covered / miss / blocked / timeout
  python3 - "$f" "$url" "$rc" "$idx" >>"$RES" <<'PY'
import sys,json
f,url,rc,idx=sys.argv[1],sys.argv[2],int(sys.argv[3]),int(sys.argv[4])
rec={"idx":idx,"url":url,"rc":rc}
try:
    d=json.load(open(f))
    blob=json.dumps(d).lower()
    poison=any(m in blob for m in['err_proxy','no internet','isofflineerror','chrome-error','err_connection_','err_name_not'])
    r=d.get('result'); src=d.get('source','')
    has=bool(r) and (not isinstance(r,(list,dict)) or len(r)>0)
    rec.update(source=src, poison=poison, has_result=has,
               pre=('poison' if poison else 'covered' if has else 'miss'))
except Exception as e:
    rec.update(pre=('timeout' if rc==124 else 'error'), note=str(e)[:60])
print(json.dumps(rec))
PY
}
i=0; n=0
while IFS= read -r line; do
  i=$((i+1)); [ "$i" -le "$START" ] && continue
  url=$(printf '%s' "$line" | python3 -c 'import sys,json;print(json.loads(sys.stdin.read())["url"])')
  intent=$(printf '%s' "$line" | python3 -c 'import sys,json;print(json.loads(sys.stdin.read())["intent"])')
  sem; one "$url" "$intent" "$i" &
  n=$((n+1)); [ "$n" -ge "$COUNT" ] && break
done < "$CORPUS"
wait
echo "captured $n sites (start=$START)"
