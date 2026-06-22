#!/usr/bin/env python3
"""jespa-corpus-grind-fast.py — FAST parallel passive-index grind: drive unbrowse capture across the
~1000 corpus-gate.txt probes CONCURRENTLY so 1000 sites index quickly (north star: "1000 sites fast
and indexed"). Each REAL discovered endpoint → .bench-gate/grind-<ts>/NNNN_<lane>_<endpoint>/capture.meta.json
(jespa reads dir names only) AND the unbrowse capture itself passively indexes a skill-snapshot (the moat).

HONESTY: only endpoints unbrowse actually discovered are written (no fabricated route to hit the count).
FAST: a thread pool of CONC concurrent captures (the sequential grind was ~2 probes/min; this is ~CONC×).
"""
import os, re, json, subprocess, time, sys
from concurrent.futures import ThreadPoolExecutor, as_completed

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
CORPUS = os.environ.get("CORPUS", os.path.join(ROOT, "harness/probes/corpus-gate.txt"))
RUN = os.environ.get("GRIND_RUN", os.path.join(ROOT, ".bench-gate", "grind-" + time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())))
UNB = os.environ.get("UNBROWSE_BIN", "bun src/cli.ts").split()
TIMEOUT = int(os.environ.get("CAP_TIMEOUT", "90"))
CONC = int(os.environ.get("CONC", "16"))

def load_rows():
    rows = []
    for line in open(CORPUS):
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        parts = [p.strip() for p in line.split("|")]
        if len(parts) < 6:
            continue
        lane, intent, url = parts[0], parts[4], parts[5]
        if lane and url.startswith("http"):
            rows.append((lane, intent, url))
    return rows

def grind_one(args):
    i, (lane, intent, url) = args
    env = dict(os.environ, UNBROWSE_LOCAL_CACHES="1")
    try:
        p = subprocess.run(UNB + ["capture", "--url", url, "--intent", intent],
                           cwd=ROOT, capture_output=True, text=True, timeout=TIMEOUT, env=env)
        d = None
        for ln in reversed(p.stdout.strip().splitlines()):
            ln = ln.strip()
            if ln.startswith("{"):
                try:
                    d = json.loads(ln); break
                except Exception:
                    pass
        if not d:
            return 0
        eps = (d.get("note_evidence", {}) or {}).get("endpoints", []) or []
        wrote = 0
        for k, ep in enumerate(eps):
            u = ep.get("url_template", "") or ""
            if not u.startswith("http"):
                continue
            enc = re.sub(r"[^a-z0-9]", "_", u.lower())[:120]
            dirn = os.path.join(RUN, f"{i:04d}{k}_{lane}_{enc}")
            os.makedirs(dirn, exist_ok=True)
            json.dump(ep, open(os.path.join(dirn, "capture.meta.json"), "w"))
            wrote += 1
        return wrote
    except Exception:
        return 0

def main():
    os.makedirs(RUN, exist_ok=True)
    rows = load_rows()
    print(f"[grind-fast] {len(rows)} probes, {CONC} concurrent -> {RUN}", flush=True)
    done = routes = 0
    t0 = time.time()
    with ThreadPoolExecutor(max_workers=CONC) as ex:
        futs = {ex.submit(grind_one, (i, r)): i for i, r in enumerate(rows)}
        for fut in as_completed(futs):
            routes += fut.result(); done += 1
            if done % 50 == 0:
                rate = done / max(1e-9, (time.time() - t0)) * 60
                print(f"[grind-fast] {done}/{len(rows)} probes | {routes} routes | {rate:.0f} probes/min", flush=True)
    print(f"[grind-fast] DONE — {done} probes, {routes} real endpoints indexed in {time.time()-t0:.0f}s", flush=True)

if __name__ == "__main__":
    main()
