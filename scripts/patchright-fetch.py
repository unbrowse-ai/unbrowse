#!/usr/bin/env python3
"""patchright fetch — the JS-challenge rung of the fetch ladder.

Why this exists: scripts/curl-impersonate-fetch.py documents its own boundary —
it clears the TLS-fingerprint-only class (youtube) but NOT the JS-challenge class
(reddit's Cloudflare interstitial, ebay's Akamai block), which "still needs T6.2
(real Chrome through residential proxy)". This is that rung.

Measured on this repo's own corpus (bench/sites100/CHALLENGE-RATE-FINDINGS.md):
18 of 100 sites are blocked to BOTH plain HTTP and obscura. Neither a Chrome-
shaped ClientHello nor a from-scratch JS engine reaches them, because the block
is decided by JS-runtime fingerprinting, not TLS.

Why patchright specifically: Apache-2.0 (unlike nodriver/zendriver, which are
AGPL-3.0 — a licensing decision for this repo, not a footnote), the widest
adoption in the space, and actively maintained. Camoufox was the other candidate
and was ruled out: its maintainer stepped down and it went 17.5 months between
releases.

HEADED, deliberately. Patchright measures indistinguishable from stock Chrome
when headed; headless drops sharply for one dumb reason — the User-Agent still
contains "HeadlessChrome". If no display is available we use xvfb-run when
present, and otherwise refuse rather than silently falling back to headless and
reporting a block that is really our own fingerprint.

Contract (stdout, one JSON object — same shape the curl-impersonate helper uses):
    {"ok": true,  "status": 200, "html": "...", "bytes": 1234}
    {"ok": false, "error": "patchright_not_installed", "hint": "..."}
Exit code is 0 whenever a JSON verdict was produced, including an honest refusal;
the caller distinguishes on `ok`, never on the exit code alone.
"""
import json
import os
import sys


def emit(obj):
    sys.stdout.write(json.dumps(obj))
    sys.stdout.flush()
    sys.exit(0)


def main():
    if len(sys.argv) < 2:
        emit({"ok": False, "error": "usage", "hint": "patchright-fetch.py <url> [--timeout-ms N] [--proxy URL] [--cookies JSON]"})

    url = sys.argv[1]
    argv = sys.argv[2:]

    def flag(name, default=None):
        return argv[argv.index(name) + 1] if name in argv and argv.index(name) + 1 < len(argv) else default

    timeout_ms = int(flag("--timeout-ms", "45000"))
    proxy = flag("--proxy")
    cookies_raw = flag("--cookies")

    try:
        # patchright is a drop-in Playwright fork; the import name is the tell.
        from patchright.sync_api import sync_playwright
    except ImportError:
        emit({
            "ok": False,
            "error": "patchright_not_installed",
            "hint": "pip install patchright && patchright install chrome  (Apache-2.0; headed Chrome for the JS-challenge rung)",
        })

    # Headed needs a display. Never silently degrade to headless — a headless run
    # leaks "HeadlessChrome" in the UA and would report a block that is our own
    # fingerprint, which is worse than admitting we could not run.
    if not os.environ.get("DISPLAY") and not os.environ.get("WAYLAND_DISPLAY"):
        emit({
            "ok": False,
            "error": "no_display_for_headed",
            "hint": "run under xvfb-run (e.g. `xvfb-run -a unbrowse ...`) or set DISPLAY; headless leaks HeadlessChrome in the UA",
        })

    launch = {"headless": False, "channel": "chrome"}
    if proxy:
        launch["proxy"] = {"server": proxy}

    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(**launch)
            try:
                ctx = browser.new_context()
                if cookies_raw:
                    try:
                        cookies = json.loads(cookies_raw)
                        if isinstance(cookies, list) and cookies:
                            ctx.add_cookies(cookies)
                    except Exception:
                        pass  # a bad jar must not sink the fetch
                page = ctx.new_page()
                resp = page.goto(url, timeout=timeout_ms, wait_until="domcontentloaded")
                # A managed challenge resolves itself after a beat; give it one.
                try:
                    page.wait_for_load_state("networkidle", timeout=min(timeout_ms, 20000))
                except Exception:
                    pass
                html = page.content()
                emit({
                    "ok": True,
                    "status": resp.status if resp else 0,
                    "html": html,
                    "bytes": len(html.encode("utf-8", "ignore")),
                })
            finally:
                browser.close()
    except Exception as exc:  # noqa: BLE001 — the caller wants a verdict, not a traceback
        emit({"ok": False, "error": "patchright_failed", "hint": str(exc)[:300]})


if __name__ == "__main__":
    main()
