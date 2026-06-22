#!/usr/bin/env python3
"""jespa-corpus-grind.py — grow the .bench-gate route corpus by driving the unbrowse CLI to
capture+index REAL endpoints across the ~1000 probes in harness/probes/corpus-gate.txt.

The user's directive (2026-06-22): "run it via unbrowse cli so that it grinds all the way and
indexes for us." The public corpus had only 101 unique routes (jespa beats keyword but sub-margin =
data-bound). The 5.6x win lives on the internal 8205-route corpus, which was BUILT by exactly this
grind. So we grow honestly: drive `unbrowse capture` per probe; for each REAL discovered endpoint,
write one .bench-gate/<run>/NNN_<lane>_<endpoint>/capture.meta.json (jespa reads dir NAMES only).

HONESTY: only endpoints unbrowse actually discovered are written. A site that yields no endpoint
writes nothing — never a fabricated route to inflate n (that would be the broken bottle, Matt 9:17).
"""
import os, sys, re, json, subprocess, time

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
CORPUS = os.environ.get("CORPUS", os.path.join(ROOT, "harness/probes/corpus-gate.txt"))
RUN = os.path.join(ROOT, ".bench-gate", "grind-" + time.strftime("%Y%m%dT%H%M%SZ", time.gmtime()))
UNB = os.environ.get("UNBROWSE_BIN", "bun src/cli.ts").split()
TIMEOUT = int(os.environ.get("CAP_TIMEOUT", "120"))

def main():
    os.makedirs(RUN, exist_ok=True)
    rows = []
    for line in open(CORPUS):
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        parts = [p.strip() for p in line.split("|")]
        if len(parts) < 6:
            continue
        lane, intent, url = parts[0], parts[4], parts[5]
        if not lane or not url.startswith("http"):
            continue
        rows.append((lane, intent, url))
    print(f"[grind] {len(rows)} probes to grind via unbrowse capture -> {RUN}", flush=True)
    n_routes = n_probes_hit = 0
    env = dict(os.environ, UNBROWSE_LOCAL_CACHES="1")
    for i, (lane, intent, url) in enumerate(rows):
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
                continue
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
                wrote += 1; n_routes += 1
            if wrote:
                n_probes_hit += 1
        except Exception:
            pass
        if i % 25 == 0:
            print(f"[grind] {i}/{len(rows)} probes | {n_probes_hit} yielded endpoints | {n_routes} routes indexed", flush=True)
    print(f"[grind] DONE — {n_routes} real endpoints from {n_probes_hit} probes indexed into {RUN}", flush=True)

if __name__ == "__main__":
    main()
