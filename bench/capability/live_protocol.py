#!/usr/bin/env python3
"""Live protocol driver — the capture→(wait→resolve→)score→record stages over the
REAL installed unbrowse CLI (the shipped artifact, not source).

What works on this binary (verified Step 3): `unbrowse go <url>` opens a session and
returns the REAL captured page payload — the live data path for Axis B (execution
returns real public data).

KNOWN GATE (named once, lewis-brain): `unbrowse eval resolve` on THIS installed binary
returns only a `{session_id, tab_id}` browse-strict envelope, never the documented
`{ok, shortlist}` marketplace payload — so live Axis-A ranking is BLOCKED here and needs
a source-built/preview CLI (or the backend /v1/search/resolve endpoint direct). `resolve_live`
below surfaces that honestly rather than faking a shortlist.
"""
import argparse
import json
import os
import subprocess

UNBROWSE_BIN = os.environ.get("UNBROWSE_BIN", "unbrowse")


def _run(args, timeout=120):
    p = subprocess.run([UNBROWSE_BIN, *args], capture_output=True, text=True, timeout=timeout)
    return p.returncode, p.stdout, p.stderr


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


def resolve_live(intent, url=None, limit=10, timeout=60):
    """Attempt the marketplace shortlist. On this binary it returns a browse-strict
    envelope (no shortlist) — report that honestly; do NOT fabricate a shortlist."""
    args = ["eval", "resolve", intent]
    if url:
        args += ["--url", url]
    args += ["--limit", str(limit), "--json"]
    rc, out, err = _run(args, timeout=timeout)
    shortlist, envelope = [], None
    for obj in _json_lines(out):
        if isinstance(obj, dict):
            if "shortlist" in obj or "domain_results" in obj:
                envelope = obj
                raw = obj.get("shortlist") or obj.get("domain_results") or []
                shortlist = [e for e in raw if isinstance(e, (str, dict))]
                break
            envelope = obj  # session envelope fallback
    return {
        "rc": rc,
        "shortlist": shortlist,
        "marketplace_available": bool(shortlist) or (envelope or {}).get("shortlist") is not None,
        "envelope_keys": list((envelope or {}).keys()),
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
