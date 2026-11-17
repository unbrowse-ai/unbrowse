"""Reads back every assertion the Antithesis SDKs wrote in local mode (ANTITHESIS_SDK_LOCAL_OUTPUT), one .jsonl per
process under the directory given, and prints each with its outcome. Always and AlwaysOrUnreachable fail on any false
evaluation, Unreachable on any hit. Used by soak.sh.

  summarise.py SDK_DIR [--known FILE] [--coverage FILE]

--known names violations already filed (one assertion message per line, # comments): they print as KNOWN and are not
counted. --coverage writes every Sometimes and Reachable that came true, one "who<TAB>message" per line (explore.sh
reads it)."""
import json, sys, glob, collections
args = sys.argv[1:]
opt = lambda name: args[args.index(name) + 1] if name in args else None
known = set()
if opt("--known"):
    try: known = {l.strip() for l in open(opt("--known")) if l.strip() and not l.startswith("#")}
    except FileNotFoundError: pass
side = {}
agg = collections.OrderedDict()
for f in sorted(glob.glob(args[0] + "/*.jsonl")):
    who = "node" if "node-" in f else "workload"
    for line in open(f, errors="replace"):
        try: o = json.loads(line)
        except Exception: continue
        a = o.get("antithesis_assert")
        if not a: continue
        k = (who, a.get("display_type") or a.get("assert_type"), a["message"])
        r = agg.setdefault(k, {"hits": 0, "true": 0, "false": 0, "must_hit": a.get("must_hit"), "at": a.get("location", {}).get("file", "")})
        if a.get("hit"):
            r["hits"] += 1
            r["true" if a.get("condition") else "false"] += 1
viol = kn = 0
cov = []
for (who, t, m), r in agg.items():
    if r["hits"] == 0: st = "unfired" if t in ("Sometimes", "Reachable") else "held (not reached)"
    elif t in ("Always", "AlwaysOrUnreachable"): st = "VIOLATED" if r["false"] else "held"
    elif t == "Unreachable": st = "VIOLATED (reached)"
    elif t == "Sometimes": st = "fired" if r["true"] else "hit, never true"
    else: st = "fired"
    if st.startswith("VIOLATED") and m in known: st = "KNOWN " + st; kn += 1
    viol += st.startswith("VIOLATED")
    if st == "fired": cov.append(f"{who}\t{m}")
    print(f"{who:8} {t:20} {st:20} hits={r['hits']:<4} {m}")
if opt("--coverage"): open(opt("--coverage"), "w").write("".join(c + "\n" for c in cov))
print(f"\nVIOLATIONS={viol} known={kn} assertions={len(agg)} came_true={len(cov)}")
