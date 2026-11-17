#!/usr/bin/env python3
"""Benchmark a node's routes: call each read once and report what it cost and how it answered.

    python3 benchmark-routes.py --port 18997 --home ~/unbrowse-work/sn-trip

It reads `<home>/token`, lists the node's own routes, and for each one (reads only by default) calls it with the
route's own defaults, then reads its inspect for the page cost. The scoreboard is what the browserless work is judged
by: ok, browser (did the call open a page), ms, bytes of answer, scripts and script bytes. Writes are skipped unless
--include-writes: a benchmark must not change anything on a site.

Nothing here knows a site. Output is a table, or JSON with --json.
"""
from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path


def call(base: str, token: str, method: str, path: str, body: dict | None = None):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(base + path, data=data, method=method)
    req.add_header("Authorization", f"Bearer {token}")
    if data is not None:
        req.add_header("content-type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=300) as r:
            return r.status, json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read() or b"{}")
        except Exception:
            return e.code, {"error": str(e)}
    except Exception as e:  # the node is down, a call timed out
        return 0, {"error": str(e)}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=18997)
    ap.add_argument("--home", type=Path, required=True, help="the node's home (holds token)")
    ap.add_argument("--site")
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--include-writes", action="store_true")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()

    token = (args.home / "token").read_text().strip()
    base = f"http://127.0.0.1:{args.port}"
    status, found = call(base, token, "GET", "/v1/routes")
    if status != 200:
        print(f"the node didn't list its routes: {status} {found}", file=sys.stderr)
        return 1
    routes = found.get("routes") or []
    if args.site:
        routes = [r for r in routes if r.get("site") == args.site]
    if not args.include_writes:
        routes = [r for r in routes if not r.get("write")]
    if args.limit:
        routes = routes[: args.limit]

    rows = []
    for r in routes:
        rid = r.get("id", "")
        inputs = {i["name"]: i.get("default") for i in r.get("inputs") or [] if i.get("default") is not None}
        started = time.monotonic()
        status, reply = call(base, token, "POST", f"/v1/routes/{rid}/call", inputs)
        ms = int((time.monotonic() - started) * 1000)
        _, ins = call(base, token, "GET", f"/v1/routes/{rid}/inspect")
        data = reply.get("data")
        rows.append(
            {
                "route": rid,
                "site": r.get("site"),
                "what": r.get("what"),
                "method": r.get("method"),
                "path": r.get("path"),
                "ok": bool(reply.get("ok")),
                "status": status,
                "browser": reply.get("browser"),
                "ms": reply.get("ms", ms),
                "bytes": len(json.dumps(data)) if data is not None else 0,
                "scripts": (ins.get("scripts") or {}).get("count"),
                "script_bytes": (ins.get("scripts") or {}).get("bytes"),
                # The scoreboard's four questions: is the page markup carried, are its reads text, how many steps still
                # need the page, and did the plain trial answer at learn time.
                "carried_page": ins.get("carried_page"),
                "page_reads": ins.get("page_reads"),
                "page_signed": ins.get("page_signed_steps"),
                "plain_trial": ins.get("plain_trial"),
                "error": reply.get("error"),
            }
        )

    if args.json:
        print(json.dumps({"routes": rows}, indent=2))
        return 0
    if not rows:
        print("no routes to measure")
        return 0
    print(f"{'route':<20} {'ok':<3} {'browser':<8} {'ms':>7} {'bytes':>8} {'scr':>4} {'page':<6} {'reads':<5} {'signed':>6} {'trial':<5}  what")
    for x in rows:
        print(
            f"{x['route']:<20} {str(x['ok']):<3} {str(x['browser']):<8} {str(x['ms']):>7} {x['bytes']:>8} "
            f"{str(x['scripts']):>4} {str(x['carried_page']):<6} {str(x['page_reads']):<5} {str(x['page_signed']):>6} "
            f"{str(x['plain_trial']):<5}  {(x['what'] or '')[:44]}"
        )
    ok = sum(1 for x in rows if x["ok"])
    browserless = sum(1 for x in rows if x["ok"] and x["browser"] is False)
    print(f"\n{ok}/{len(rows)} answered; {browserless} browserless")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
