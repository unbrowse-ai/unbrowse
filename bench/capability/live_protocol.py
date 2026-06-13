#!/usr/bin/env python3
"""Live protocol driver — the capture→(wait→resolve→)score→record stages over the
REAL installed unbrowse CLI (the shipped artifact, not source).

What works on this binary (verified Step 3): `unbrowse go <url>` opens a session and
returns the REAL captured page payload — the live data path for Axis B (execution
returns real public data).

CONTRACT (corrected): the documented agent surface is top-level `unbrowse resolve` (step 1,
ranked endpoints) → `unbrowse execute` (step 2, replay). The earlier "KNOWN GATE" was a
MISDIAGNOSIS — it called `eval resolve` (the debug namespace), which returns a browse-strict
envelope; top-level `resolve` returns the real shortlist under result.available_endpoints.
`resolve_live` and `resolve_execute` below drive the proper contract commands.
"""
import argparse
import json
import os
import subprocess

UNBROWSE_BIN = os.environ.get("UNBROWSE_BIN", "unbrowse")


def _run(args, timeout=120):
    # Timeout-tolerant: a slow/flaky capture records a MISS, never raises (would abort the axis).
    try:
        p = subprocess.run([UNBROWSE_BIN, *args], capture_output=True, text=True, timeout=timeout)
        return p.returncode, p.stdout, p.stderr
    except subprocess.TimeoutExpired as e:
        out = e.stdout.decode("utf-8", "replace") if isinstance(e.stdout, bytes) else (e.stdout or "")
        return 124, out, "timeout"


def _json_lines(text):
    for ln in text.splitlines():
        ln = ln.strip()
        if ln.startswith("{"):
            try:
                yield json.loads(ln)
            except json.JSONDecodeError:
                continue


def go(url, timeout=120):
    """Open a session on url; return the REAL captured payload (Axis-B live data).
    -> {ok, session_id, tab_id, page_text, marketplace_publish_mode}."""
    rc, out, err = _run(["go", url], timeout=timeout)
    best = None
    for obj in _json_lines(out):
        if isinstance(obj, dict) and ("page" in obj or "session_id" in obj):
            best = obj  # keep the richest (the go envelope has page+autonomy)
            if "page" in obj:
                break
    if not best:
        return {"ok": False, "rc": rc, "error": "no go envelope parsed"}
    page = best.get("page") or {}
    autonomy = best.get("autonomy") or {}
    return {
        "ok": bool(best.get("ok", "session_id" in best)),
        "session_id": best.get("session_id"),
        "tab_id": best.get("tab_id"),
        "page_text": page.get("text") if isinstance(page, dict) else None,
        "marketplace_publish_mode": autonomy.get("marketplace_publish_mode"),
    }


def _parse_envelope(out):
    """Parse the one JSON object the CLI prints (pretty/multi-line/log-prefixed): {…}."""
    i, j = out.find("{"), out.rfind("}")
    if i < 0 or j <= i:
        return {}
    try:
        return json.loads(out[i:j + 1])
    except json.JSONDecodeError:
        for o in _json_lines(out):
            if isinstance(o, dict):
                return o
        return {}


def resolve_live(intent, url=None, force_capture=True, timeout=180):
    """Agent-contract STEP 1: top-level `unbrowse resolve --no-execute` → ranked endpoints
    (result.available_endpoints). --force-capture indexes on a cold miss."""
    args = ["resolve", "--intent", intent, "--no-execute"]
    if url:
        args += ["--url", url]
    if force_capture:
        args.append("--force-capture")
    rc, out, err = _run(args, timeout=timeout)
    d = _parse_envelope(out)
    r = d.get("result", d) if isinstance(d, dict) else {}
    shortlist = (r.get("available_endpoints") or r.get("shortlist_for_judgment")
                 or d.get("available_endpoints") or d.get("shortlist_for_judgment") or [])
    return {
        "rc": rc,
        "shortlist": [e for e in shortlist if isinstance(e, (str, dict))],
        "skill_id": r.get("skill_id") or d.get("skill_id"),
        "marketplace_available": bool(shortlist),
        "envelope_keys": list(r.keys()) if isinstance(r, dict) else [],
    }


def _extract_data(envelope):
    """Find the executed payload in an execute/resolve envelope, as a string."""
    r = envelope.get("result", envelope) if isinstance(envelope, dict) else {}
    for k in ("data", "body", "content", "response", "output"):
        v = r.get(k) if isinstance(r, dict) else None
        if v not in (None, "", {}, []):
            return json.dumps(v) if isinstance(v, (dict, list)) else str(v)
    # result.result may itself be the payload (when it's not a nested envelope)
    rr = r.get("result") if isinstance(r, dict) else None
    if isinstance(rr, (dict, list)) and rr:
        return json.dumps(rr)
    if isinstance(rr, str) and rr:
        return rr
    return ""


def resolve_execute(intent, url, timeout=200):
    """The agent contract via `unbrowse run <url> "<intent>"` — the documented one-shot path
    that resolves, then REPLAYS the cached/direct endpoint (or captures+indexes on miss):
    resolve→execute, orchestrated. Preferred over the explicit two calls because (a) it
    avoids the 38s in-process force-capture deadline (run manages its own capture budget),
    and (b) it correctly direct-fetches a JSON API URL instead of treating it as a
    non-replayable direct document. Returns {ok, trace_id, data, data_bytes, source}."""
    rc, out, err = _run(["run", url, intent], timeout=timeout)
    d = _parse_envelope(out)
    trace = d.get("trace") or {}
    trace_id = trace.get("trace_id") if isinstance(trace, dict) else None
    data_str = _extract_data(d)
    return {
        "ok": rc == 0 and len(data_str) > 0,
        "trace_id": trace_id,
        "source": d.get("source"),
        "data": data_str,
        "data_bytes": len(data_str),
        "step": "run",
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["go", "resolve"])
    ap.add_argument("url_or_intent")
    ap.add_argument("--url")
    args = ap.parse_args()
    if args.cmd == "go":
        r = go(args.url_or_intent)
        txt = r.get("page_text") or ""
        print(json.dumps({
            "ok": r["ok"], "session_id": r["session_id"],
            "data_bytes": len(txt), "data_head": txt[:160],
            "publish_mode": r.get("marketplace_publish_mode"),
        }, indent=2))
    else:
        print(json.dumps(resolve_live(args.url_or_intent, args.url), indent=2))


if __name__ == "__main__":
    main()
