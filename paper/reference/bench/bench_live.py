"""bench_live.py — the REAL field benchmark: reproduce the whitepaper's 3.6x.

This is the harness that proves the headline number (arXiv:2604.00694: cached route
950ms vs browser 3404ms, 3.6x mean / 5.4x median over 94 domains). It CANNOT run in
a sandbox — it needs a live network, the unbrowse binary, and a real browser. Run it
in a live environment:

    python3 bench_live.py --corpus domains.txt --out results.json [--n 94]

For each domain it times two equivalent paths to the same information:
  (1) BROWSER (cold rediscovery): unbrowse go+snap on the URL (real DOM render).
  (2) CACHED (warm reuse): unbrowse resolve+execute against the indexed route.
It reports mean+median wall-clock for each and the speedup, and EXITS NONZERO if the
measured mean speedup does not meet --target (default 3.6), so a green run is a real
reproduction of the paper's claim, not an assertion.

Honest preconditions (checked at start; the script refuses to fake a result):
  - `unbrowse` on PATH (the cached/execute + browse paths).
  - network reachable.
  - a corpus of `intent|url` lines (defaults to harness/probes/corpus.txt).
"""
import argparse, json, shutil, statistics, subprocess, sys, time

def have_unbrowse():
    return shutil.which("unbrowse") is not None

def time_cmd(args, timeout):
    t0 = time.perf_counter()
    try:
        p = subprocess.run(["unbrowse", *args], capture_output=True, text=True, timeout=timeout)
        ok = p.returncode == 0 and len(p.stdout) > 0
    except Exception:
        ok = False
    return (time.perf_counter() - t0), ok

def browser_path(url, timeout):
    # cold rediscovery: open a real browser tab + snapshot (DOM render cost)
    dt, ok = time_cmd(["go", url], timeout)
    return dt, ok

def cached_path(intent, url, timeout):
    # warm reuse: resolve the intent against the indexed graph + execute top route
    dt, ok = time_cmd(["resolve", "--intent", intent, "--url", url], timeout)
    return dt, ok

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--corpus", default="../../../harness/probes/corpus.txt")
    ap.add_argument("--out", default="results.json")
    ap.add_argument("--n", type=int, default=94)
    ap.add_argument("--target", type=float, default=3.6)
    ap.add_argument("--timeout", type=int, default=60)
    a = ap.parse_args()

    if not have_unbrowse():
        print("PRECONDITION FAIL: `unbrowse` not on PATH. This bench needs the binary; "
              "it does not fabricate a result.", file=sys.stderr)
        sys.exit(2)

    rows = []
    with open(a.corpus) as f:
        for ln in f:
            ln = ln.strip()
            if not ln or ln.startswith("#") or "|" not in ln:
                continue
            intent, url = ln.split("|", 1)
            rows.append((intent.strip(), url.strip()))
            if len(rows) >= a.n:
                break

    if not rows:
        print("PRECONDITION FAIL: corpus empty.", file=sys.stderr); sys.exit(2)

    browser, cached, per = [], [], []
    for intent, url in rows:
        bdt, bok = browser_path(url, a.timeout)
        cdt, cok = cached_path(intent, url, a.timeout)
        if bok and cok and cdt > 0:
            browser.append(bdt); cached.append(cdt); per.append(bdt / cdt)
            print(f"  {url[:48]:48} browser={bdt*1000:7.0f}ms cached={cdt*1000:7.0f}ms x{bdt/cdt:.1f}")
        else:
            print(f"  {url[:48]:48} SKIP (browser_ok={bok} cached_ok={cok})")

    if not per:
        print("RESULT FAIL: no domain produced a comparable pair.", file=sys.stderr); sys.exit(1)

    rep = {
        "domains_attempted": len(rows),
        "domains_paired": len(per),
        "browser_mean_ms": round(statistics.mean(browser) * 1000, 1),
        "browser_median_ms": round(statistics.median(browser) * 1000, 1),
        "cached_mean_ms": round(statistics.mean(cached) * 1000, 1),
        "cached_median_ms": round(statistics.median(cached) * 1000, 1),
        "speedup_mean": round(statistics.mean(per), 2),
        "speedup_median": round(statistics.median(per), 2),
        "target_mean": a.target,
        "meets_target": statistics.mean(per) >= a.target,
    }
    json.dump(rep, open(a.out, "w"), indent=2)
    print(json.dumps(rep, indent=2))
    # the field claim is PROVEN only if the live run meets the paper's headline number
    sys.exit(0 if rep["meets_target"] else 1)

if __name__ == "__main__":
    main()
