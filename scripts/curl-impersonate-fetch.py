#!/usr/bin/env python3
"""curl-impersonate fetch via curl_cffi — Chrome131 JA4 spoof + residential proxy.

Why this exists: src/capture/ssr-fastpath.ts (trySsrFastPathOnBlock) POSTs to
Kuri's /v1/sandbox/replay for libcurl-impersonate behavior. When that path
returns no_html (Kuri unavailable, sandbox endpoint not impersonating, or
upstream non-200), this helper is the tertiary fallback: curl_cffi ships a
prebuilt patched curl with Chrome131 JA3/JA4 fingerprint baked in, installable
via `pip install curl_cffi` (precompiled wheels for macOS-arm64).

Boundary mapped 2026-05-25 via direct probing:
  - youtube.com: PASS via curl_cffi+IProyal (1.04 MB real ytInitialData)
  - reddit.com: BLOCKED — CF serves JS-challenge interstitial that requires
    real browser execution (only T6.2 fixes this class)
  - ebay.com: BLOCKED — Akamai 403 hard-block
  - clinicaltrials.gov: PROXY 403 — IProyal can't tunnel this domain

So this helper unblocks the TLS-fingerprint-only class. The JS-challenge class
still needs T6.2 (real Chrome through residential proxy).

Invocation (subprocess from src/capture/curl-impersonate-fallback.ts):
  python3 scripts/curl-impersonate-fetch.py <url> [--proxy URL] [--impersonate chrome131]

Stdout: JSON {status, bytes, html_b64} on success; {error: "..."} on failure.
Exit 0 on success, 1 on connect/proxy/impersonation error.
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import sys


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("url")
    p.add_argument("--proxy", default=os.environ.get("UNBROWSE_PROXY_URL") or "")
    p.add_argument("--impersonate", default="chrome131")
    p.add_argument("--timeout", type=int, default=30)
    p.add_argument("--max-bytes", type=int, default=5_000_000)
    args = p.parse_args()

    try:
        from curl_cffi import requests as cc_requests
    except ImportError as e:
        print(json.dumps({"error": f"curl_cffi not installed: {e}", "install": "pip install --user curl_cffi"}))
        return 1

    proxies = None
    if args.proxy:
        proxies = {"http": args.proxy, "https": args.proxy}
    elif os.environ.get("IPROYAL_USER") and os.environ.get("IPROYAL_PASS"):
        from urllib.parse import quote
        u = quote(os.environ["IPROYAL_USER"], safe="")
        pw = quote(os.environ["IPROYAL_PASS"], safe="")
        host = os.environ.get("IPROYAL_HOST", "geo.iproyal.com")
        port = os.environ.get("IPROYAL_PORT", "12321")
        proxy_url = f"http://{u}:{pw}@{host}:{port}"
        proxies = {"http": proxy_url, "https": proxy_url}

    try:
        r = cc_requests.get(
            args.url,
            impersonate=args.impersonate,
            proxies=proxies,
            timeout=args.timeout,
            allow_redirects=True,
        )
    except Exception as e:
        print(json.dumps({"error": f"{type(e).__name__}: {str(e)[:200]}"}))
        return 1

    content = r.content[: args.max_bytes]
    out = {
        "status": r.status_code,
        "bytes": len(r.content),
        "truncated": len(r.content) > args.max_bytes,
        "html_b64": base64.b64encode(content).decode("ascii"),
        "final_url": str(r.url),
        "proxy_used": bool(proxies),
        "impersonate": args.impersonate,
    }
    print(json.dumps(out))
    return 0


if __name__ == "__main__":
    sys.exit(main())
