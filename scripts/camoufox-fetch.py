#!/usr/bin/env python3
"""camoufox-fetch — stealth Firefox capture that clears Cloudflare JS challenges.

The JS-challenge class ("Just a moment…", Turnstile/interstitial) is the one
curl-impersonate-fetch.py explicitly cannot do (no JS engine). camoufox is a
Firefox patched to inject fingerprint spoofing at the C++ level (invisible to
JS), kill CDP/WebRTC leaks, and add canvas noise — so Cloudflare's challenge JS
actually passes. This helper drives it through a solve_cloudflare loop (detect →
wait for auto-clear → click interactive Turnstile checkbox → re-check) and
returns the rendered HTML.

Yoinked primitive: D4Vinci/Scrapling StealthyFetcher(solve_cloudflare=True),
which wraps camoufox. We shell out (the same boundary pattern as curl_cffi) so
no MPL-2.0 source is vendored.

Invocation (subprocess from src/capture/camoufox-fallback.ts):
  python3 scripts/camoufox-fetch.py <url> [--proxy URL] [--timeout 60] [--no-solve]

Stdout: JSON {status, bytes, html_b64, solved, title} on success; {error:"..."} on failure.
Exit 0 on success (real content reached), 1 on failure / still-blocked.
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import re
import sys
import time
from urllib.parse import urlparse

CF_INTERSTITIAL = re.compile(
    r"just a moment|enable javascript and cookies|checking your browser|cf-browser-verification|challenge-platform",
    re.IGNORECASE,
)


def parse_proxy(raw: str):
    """playwright wants {server, username, password}; our env carries a URL."""
    if not raw:
        return None
    try:
        u = urlparse(raw)
        if not u.hostname:
            return None
        server = f"{u.scheme or 'http'}://{u.hostname}{(':' + str(u.port)) if u.port else ''}"
        prox = {"server": server}
        if u.username:
            prox["username"] = u.username
        if u.password:
            prox["password"] = u.password
        return prox
    except Exception:
        return None


def looks_blocked(html: str, title: str) -> bool:
    blob = f"{title}\n{html[:4000]}"
    return bool(CF_INTERSTITIAL.search(blob))


def solve_cloudflare(page, deadline: float) -> bool:
    """Detect + wait out the JS challenge; click an interactive Turnstile if present.
    Returns True when the page is no longer the interstitial."""
    while time.time() < deadline:
        try:
            title = page.title() or ""
            html = page.content() or ""
        except Exception:
            time.sleep(1.0)
            continue
        if not looks_blocked(html, title):
            return True
        # Interactive Turnstile: click the checkbox inside the CF challenge iframe.
        try:
            for fr in page.frames:
                src = (fr.url or "")
                if "challenges.cloudflare.com" in src or "turnstile" in src:
                    for sel in ("input[type=checkbox]", "label", "#challenge-stage", "body"):
                        try:
                            el = fr.query_selector(sel)
                            if el:
                                el.click(timeout=2000)
                                break
                        except Exception:
                            continue
        except Exception:
            pass
        # Non-interactive JS challenge auto-clears; just let it run.
        try:
            page.wait_for_timeout(2500)
        except Exception:
            time.sleep(2.5)
    # final check
    try:
        return not looks_blocked(page.content() or "", page.title() or "")
    except Exception:
        return False


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("url")
    p.add_argument("--proxy", default=os.environ.get("UNBROWSE_PROXY_URL") or "")
    p.add_argument("--timeout", type=int, default=60)
    p.add_argument("--max-bytes", type=int, default=8_000_000)
    p.add_argument("--no-solve", action="store_true")
    args = p.parse_args()

    try:
        from camoufox.sync_api import Camoufox
    except ImportError as e:
        print(json.dumps({"error": f"camoufox not installed: {e}",
                          "install": "uv pip install camoufox[geoip] && python -m camoufox fetch"}))
        return 1

    disable_proxy = os.environ.get("UNBROWSE_NO_PROXY", "") in ("1", "true", "yes")
    proxy = None if disable_proxy else parse_proxy(args.proxy)

    deadline = time.time() + args.timeout
    try:
        # humanize=True adds realistic cursor motion; geoip aligns locale/timezone to
        # the (proxy) IP so the fingerprint is internally consistent. headless via
        # the patched Firefox is NOT the detectable "HeadlessChrome" surface.
        # NB: do NOT block_images — camoufox warns it trips major WAFs (incl. Cloudflare),
        # the exact thing we're trying to clear. Keep the fingerprint maximally browser-like.
        launch_kw = dict(headless=True, humanize=True, geoip=bool(proxy))
        if proxy:
            launch_kw["proxy"] = proxy
        with Camoufox(**launch_kw) as browser:
            page = browser.new_page()
            page.goto(args.url, wait_until="domcontentloaded", timeout=int(args.timeout * 1000))
            try:
                page.wait_for_load_state("networkidle", timeout=8000)
            except Exception:
                pass
            solved = True
            if not args.no_solve:
                solved = solve_cloudflare(page, deadline)
            html = page.content() or ""
            title = page.title() or ""
            status = 200 if (html and not looks_blocked(html, title)) else 403
    except Exception as e:
        print(json.dumps({"error": f"camoufox fetch failed: {type(e).__name__}: {e}"}))
        return 1

    html_b = html.encode("utf-8", "replace")[: args.max_bytes]
    blocked = looks_blocked(html, title)
    out = {
        "status": status,
        "bytes": len(html_b),
        "html_b64": base64.b64encode(html_b).decode("ascii"),
        "solved": (not blocked),
        "title": title[:200],
    }
    print(json.dumps(out))
    return 0 if (not blocked and len(html_b) > 1024) else 1


if __name__ == "__main__":
    sys.exit(main())
