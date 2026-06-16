#!/usr/bin/env bash
# Machine witness for "95% coverage of it working well" — converts the self-asserted promise into
# a runnable check. Runs a random bench sample on the npm-installed CLI and measures TWO numbers:
#   1. raw coverage      = has_result & rc==0           (does resolve return anything?)
#   2. on-target rate    = of covered, the fraction that is GENUINELY site-relevant — NOT an
#                          off-domain web-search article. "working well" lives here, not in (1).
# An on-target cover = source is direct-fetch/direct-document of the actual site, OR a captured/
# marketplace skill, OR a web result whose source_url/top-candidate host contains the target's
# brand label. The witnessed bug: web-fallback returns docs.nex.ai/medium for bmo.com (off-target).
#
# Exit 0 only if BOTH raw coverage AND on-target rate clear the threshold. This is the honest bar:
# returning generic off-domain articles for 30% of sites is NOT "working well", even at 96% raw.
set -u
CORPUS="${1:-bench/index20k/corpus.jsonl}"
N="${2:-60}"; SEED="${3:-7}"; CONC="${4:-8}"; TO="${5:-25}"
THRESH="${COVERAGE_THRESHOLD:-95}"; QTHRESH="${ONTARGET_THRESHOLD:-95}"
BIN="${UNBROWSE_BIN:-unbrowse}"
TMP="$(mktemp -d)"; SAMPLE="$TMP/sample.jsonl"; ART="$TMP/art"; RES="$TMP/res.jsonl"
mkdir -p "$ART"

python3 - "$CORPUS" "$N" "$SEED" "$SAMPLE" <<'PY'
import json,random,sys
corpus=[json.loads(l) for l in open(sys.argv[1]) if l.strip()]
random.seed(int(sys.argv[3]))
with open(sys.argv[4],'w') as f:
    for r in random.sample(corpus,min(int(sys.argv[2]),len(corpus))):
        f.write(json.dumps({"url":r["url"],"intent":r["intent"]})+"\n")
PY

# capture (bounded, concurrent) — same shape as bench/index20k/capture.sh, isolated output
sem(){ while [ "$(jobs -rp | wc -l)" -ge "$CONC" ]; do wait -n 2>/dev/null || sleep 0.2; done; }
one(){
  local url="$1" intent="$2" idx="$3" f="$ART/$(printf '%05d' "$3").json"
  timeout "$TO" "$BIN" resolve --url "$url" --intent "$intent" --json >"$f" 2>/dev/null
  local rc=$?
  python3 - "$f" "$url" "$rc" "$idx" >>"$RES" <<'PY'
import sys,json,re
f,url,rc,idx=sys.argv[1],sys.argv[2],int(sys.argv[3]),int(sys.argv[4])
rec={"idx":idx,"url":url,"rc":rc}
try:
    d=json.load(open(f)); r=d.get("result"); src=d.get("source","")
    has=bool(r) and (not isinstance(r,(list,dict)) or len(r)>0) and rc==0
    rec["has_result"]=has; rec["source"]=src
    # on-target judgment (machine proxy for "working well")
    host=url.split("//")[-1].split("/")[0].replace("www.","")
    parts=host.split("."); label=parts[-2] if len(parts)>=2 else parts[0]
    label=label.lower() if len(label)>=4 else ""
    on=False
    if has:
        if src in ("direct-fetch","direct-document","marketplace","route-cache","live-capture","browser-action"):
            on=True  # resolved the actual site (its document/api/captured skill)
        elif src=="exa" and isinstance(r,dict):
            # ONLY inspect the actual web HITS (source_url host + candidate urls/titles), NEVER the
            # whole result blob — the blob echoes the target URL in decision_trace/next_step, which
            # would launder every off-domain result as on-target (the bmo.com->docs.nex.ai bug).
            hit_text=[str(r.get("source_url","")), str(r.get("source_title",""))]
            for c in (r.get("exa_candidates") or []):
                hit_text.append(str(c.get("url",""))); hit_text.append(str(c.get("title","")))
            blob=" ".join(hit_text).lower()
            on=bool(label) and label in blob  # a real web HIT mentions the target brand
        else:
            on=True
    rec["on_target"]=on
except Exception as e:
    rec["has_result"]=False; rec["on_target"]=False; rec["note"]=str(e)[:40]
print(json.dumps(rec))
PY
}
i=0
while IFS= read -r line; do
  i=$((i+1))
  url=$(printf '%s' "$line" | python3 -c 'import sys,json;print(json.loads(sys.stdin.read())["url"])')
  intent=$(printf '%s' "$line" | python3 -c 'import sys,json;print(json.loads(sys.stdin.read())["intent"])')
  sem; one "$url" "$intent" "$i" &
done < "$SAMPLE"
wait

python3 - "$RES" "$THRESH" "$QTHRESH" <<'PY'
import sys,json
rows=[json.loads(l) for l in open(sys.argv[1]) if l.strip()]
n=len(rows); cov=sum(1 for r in rows if r.get("has_result"))
ont=sum(1 for r in rows if r.get("on_target"))
covered=[r for r in rows if r.get("has_result")]
ont_of_cov=sum(1 for r in covered if r.get("on_target"))
cp=100*cov/n if n else 0
qp=100*ont_of_cov/len(covered) if covered else 0
T,Q=float(sys.argv[2]),float(sys.argv[3])
print(f"── coverage-quality gate (n={n}) ──")
print(f"  raw coverage     : {cov}/{n} = {cp:.1f}%  (threshold {T}%)")
print(f"  on-target / cov  : {ont_of_cov}/{len(covered)} = {qp:.1f}%  (threshold {Q}%)  <- 'working well'")
ok = cp>=T and qp>=Q
print(f"COVERAGE-QUALITY-GATE: {'PASS' if ok else 'FAIL'}")
sys.exit(0 if ok else 1)
PY
RC=$?
rm -rf "$TMP"
exit $RC
