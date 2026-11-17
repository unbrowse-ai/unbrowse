#!/usr/bin/env python3
"""Bounded, unauthenticated homepage reads for a small test-bank sample."""

import argparse
import json
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import HTTPRedirectHandler, Request, build_opener

HERE = Path(__file__).resolve().parent
DEFAULT_DOMAINS = [
    "wikipedia.org", "github.com", "bbc.co.uk", "amazon.com",
    "naver.com", "baidu.com", "uol.com.br", "www.gov.uk",
    "openstreetmap.org", "mercadolibre.com", "shopify.com", "canva.com",
    "nytimes.com", "booking.com", "arxiv.org", "shopee.co.id",
]
STRONG_CHALLENGE_MARKERS = (b"<title>just a moment", b"<title>attention required", b'id="challenge-form"', b"cf-chl-")


class BoundedRedirect(HTTPRedirectHandler):
    def __init__(self):
        self.chain = []

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        self.chain.append({"status": code, "url": newurl})
        if len(self.chain) > 5:
            raise URLError("redirect limit exceeded")
        if not newurl.startswith(("https://", "http://")):
            raise URLError("non-HTTP redirect")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def probe(domain, timeout):
    handler = BoundedRedirect()
    opener = build_opener(handler)
    request = Request(
        "https://" + domain + "/",
        headers={"User-Agent": "UnbrowseTestBank/0.1 (public homepage check)", "Accept": "text/html,application/xhtml+xml", "Accept-Encoding": "identity"},
        method="GET",
    )
    result = {"domain": domain, "checked_at": datetime.now(timezone.utc).isoformat(), "status": None, "final_url": None, "redirect_chain": [], "content_type": None, "classification": None}
    try:
        response = opener.open(request, timeout=timeout)
    except HTTPError as error:
        response = error
    except (URLError, TimeoutError, OSError) as error:
        result["classification"] = "network_error"
        result["error_type"] = type(error).__name__
        result["redirect_chain"] = handler.chain
        return result
    with response:
        result["status"] = response.status
        result["final_url"] = response.url
        result["redirect_chain"] = handler.chain
        result["content_type"] = response.headers.get("Content-Type", "").split(";")[0].lower()
        snippet = response.read(16384).lower()
    if response.status in (403, 429, 503):
        result["classification"] = "challenge_or_denial"
    elif response.status == 200 and any(marker in snippet for marker in STRONG_CHALLENGE_MARKERS):
        result["classification"] = "possible_challenge"
    elif response.status == 200:
        result["classification"] = "public_content"
    elif 200 < response.status < 300:
        result["classification"] = "nonstandard_2xx"
    elif 300 <= response.status < 400:
        result["classification"] = "redirect_unresolved"
    else:
        result["classification"] = "http_error"
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--domains", nargs="*", default=DEFAULT_DOMAINS)
    parser.add_argument("--timeout", type=float, default=8.0)
    parser.add_argument("--output", type=Path, default=HERE / "public-read-results.json")
    args = parser.parse_args()
    known = {site["domain"] for site in json.loads((HERE / "sites.json").read_text())["sites"]}
    if len(args.domains) > 20 or len(args.domains) != len(set(args.domains)) or not set(args.domains).issubset(known):
        parser.error("choose at most 20 unique domains from sites.json")
    results = []
    for domain in args.domains:
        result = probe(domain, args.timeout)
        results.append(result)
        print(f"{domain:24} {str(result['status']):4} {result['classification']}")
        time.sleep(0.5)
    args.output.write_text(json.dumps({"schema_version": 1, "probe_type": "unauthenticated_homepage_get", "results": results}, indent=2) + "\n")
    print(f"Wrote {args.output}")


if __name__ == "__main__":
    main()
