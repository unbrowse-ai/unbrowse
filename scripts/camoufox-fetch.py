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

# Tencent Cloud WAF captcha (sg.captcha.qcloud.com / `new Captcha('<appId>', ...)`),
# as served by rootdata.com and other Tencent-fronted sites. Yoinked detection
# target from the Boterdrop-Solver /clearance pattern, generalized beyond Cloudflare:
# a stealth browser (camoufox) on a residential IP frequently gets Tencent's risk
# check to return ret:0 (no slider), and once cleared the WAF sets a clearance cookie
# we harvest for HTTP replay. Markers are the captcha bootstrap + its visible refresh text.
TENCENT_WAF = re.compile(
    r"__captcha|WafCaptcha|captcha\.qcloud\.com|Captcha\.js|new Captcha\(|"
    r"Verification Code will refresh|Refreshing too often",
    re.IGNORECASE,
)

CHALLENGE = re.compile(f"(?:{CF_INTERSTITIAL.pattern})|(?:{TENCENT_WAF.pattern})", re.IGNORECASE)


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
    # The challenge stub is tiny; only scan a head window. Tencent's bootstrap
    # marker (`__captcha`) can sit slightly deeper than CF's, so widen to 8KB.
    blob = f"{title}\n{html[:8000]}"
    return bool(CHALLENGE.search(blob))


def solve_challenge(page, deadline: float) -> bool:
    """Detect + clear the challenge (Cloudflare interstitial/Turnstile OR Tencent WAF).
    Returns True when the page is no longer a challenge page.

    Strategy is the same shape for both vendors: let the stealth browser run the
    challenge JS (camoufox's C++-level spoofing is what gets the risk check to pass
    without a slider), nudge any interactive widget, and re-check. Tencent's
    `/WafCaptcha` POST + `window.location.reload(true)` self-clears once ret:0, so
    waiting is usually enough; we also click into a visible qcloud iframe if present."""
    while time.time() < deadline:
        try:
            title = page.title() or ""
            html = page.content() or ""
        except Exception:
            time.sleep(1.0)
            continue
        if not looks_blocked(html, title):
            return True
        # Interactive Cloudflare Turnstile: click the checkbox inside the CF iframe.
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
                # Tencent TCaptcha renders its slider inside an *.captcha.qcloud.com iframe.
                if "captcha.qcloud.com" in src or "captcha.gtimg.com" in src:
                    for sel in ("#tcaptcha_drag_button", ".tc-slider-normal", "#slideBg", "body"):
                        try:
                            el = fr.query_selector(sel)
                            if el:
                                el.scroll_into_view_if_needed(timeout=1500)
                                break
                        except Exception:
                            continue
        except Exception:
            pass
        # Non-interactive challenge auto-clears (Tencent reloads on ret:0); let it run.
        try:
            page.wait_for_timeout(2500)
        except Exception:
            time.sleep(2.5)
    # final check
    try:
        return not looks_blocked(page.content() or "", page.title() or "")
    except Exception:
        return False


def harvest_clearance(page):
    """Boterdrop /clearance primitive: after the challenge clears, the WAF has set
    an IP+UA-bound clearance cookie. Harvest the cookie jar + the exact user-agent
    that solved it so a downstream HTTP fetch can replay them (the clearance is
    worthless from a different UA/IP). Returns (cookies, user_agent, cookie_header)."""
    cookies = []
    user_agent = ""
    try:
        ctx = page.context
        cookies = ctx.cookies() or []
    except Exception:
        cookies = []
    try:
        user_agent = page.evaluate("() => navigator.userAgent") or ""
    except Exception:
        user_agent = ""
    cookie_header = "; ".join(
        f"{c.get('name')}={c.get('value')}" for c in cookies if c.get("name")
    )
    slim = [
        {
            "name": c.get("name"),
            "value": c.get("value"),
            "domain": c.get("domain"),
            "path": c.get("path", "/"),
        }
        for c in cookies
        if c.get("name")
    ]
    return slim, user_agent, cookie_header


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
                solved = solve_challenge(page, deadline)
            html = page.content() or ""
            title = page.title() or ""
            status = 200 if (html and not looks_blocked(html, title)) else 403
            # Harvest the clearance (cookies + UA) regardless of block state — even a
            # partial clear seeds the per-domain replay jar for the next sticky-IP call.
            cookies, user_agent, cookie_header = harvest_clearance(page)
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
        # Boterdrop /clearance primitive: the IP+UA-bound clearance for HTTP replay.
        "cookies": cookies,
        "user_agent": user_agent,
        "cookie_header": cookie_header,
    }
    print(json.dumps(out))
    return 0 if (not blocked and len(html_b) > 1024) else 1


if __name__ == "__main__":
    sys.exit(main())
