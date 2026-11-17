#!/usr/bin/env python3
"""Bounded HTTP-only homepage and observed-link pass across the 400-site bank."""

import argparse
import ipaddress
import json
import socket
import time
from collections import Counter
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from html.parser import HTMLParser
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urljoin, urlparse, urlunparse
from urllib.request import HTTPRedirectHandler, Request, build_opener

HERE = Path(__file__).resolve().parent
USER_AGENT = "UnbrowseTestBank/0.2 (bounded unauthenticated public route check)"
MAX_BYTES = 262144
MAX_REDIRECTS = 5
BLOCKED_SEGMENTS = {
    "login", "logout", "log-in", "log-out", "signin", "sign-in", "signout",
    "sign-out", "register", "signup", "sign-up", "auth", "oauth", "account",
    "settings", "profile", "cart", "checkout", "buy", "purchase", "order",
    "delete", "remove", "unsubscribe", "subscribe", "follow", "unfollow",
    "like", "vote", "submit", "send", "payment", "billing", "api", "admin",
}
STATIC_EXTENSIONS = {".pdf", ".jpg", ".jpeg", ".png", ".gif", ".svg", ".webp", ".zip", ".mp4", ".mp3", ".css", ".js", ".json", ".xml"}
STRONG_CHALLENGE_MARKERS = ("<title>just a moment", "<title>attention required", 'id="challenge-form"', "cf-chl-")
SPECIAL_SUFFIXES = (".localhost", ".local", ".internal", ".test", ".invalid", ".example", ".onion", ".lan", ".home.arpa")


def now_iso():
    return datetime.now(timezone.utc).isoformat()


def origin(url):
    parsed = urlparse(url)
    return f"{parsed.scheme}://{parsed.netloc}" if parsed.scheme and parsed.netloc else None


def safe_url(url):
    """Do not persist query strings or fragments that may carry auth state."""
    parsed = urlparse(url)
    return urlunparse((parsed.scheme, parsed.netloc, parsed.path, "", "", ""))


def public_redirect_host(url):
    """Reject literal and DNS-resolved nonpublic redirect destinations."""
    parsed = urlparse(url)
    host = (parsed.hostname or "").rstrip(".").lower()
    try:
        port = parsed.port
    except ValueError:
        return False
    if parsed.scheme != "https" or not host or "." not in host or parsed.username or parsed.password or port not in (None, 443):
        return False
    if host == "localhost" or host.endswith(SPECIAL_SUFFIXES):
        return False
    try:
        return ipaddress.ip_address(host).is_global
    except ValueError:
        pass
    try:
        answers = socket.getaddrinfo(host, 443, type=socket.SOCK_STREAM)
        return bool(answers) and all(ipaddress.ip_address(answer[4][0]).is_global for answer in answers)
    except (OSError, ValueError):
        return False


class BlockedRedirect(Exception):
    pass


class RedirectRecorder(HTTPRedirectHandler):
    def __init__(self, allowed_host=None):
        self.chain = []
        self.allowed_host = allowed_host

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        self.chain.append({"status": code, "from": safe_url(req.full_url), "to": safe_url(newurl)})
        parsed = urlparse(newurl)
        if len(self.chain) > MAX_REDIRECTS:
            raise BlockedRedirect("redirect_limit")
        if not public_redirect_host(newurl):
            raise BlockedRedirect("nonpublic_or_unresolved_redirect")
        if self.allowed_host and parsed.hostname != self.allowed_host:
            raise BlockedRedirect("off_host_route_redirect")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


class Links(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.hrefs = []

    def handle_starttag(self, tag, attrs):
        if tag.lower() != "a":
            return
        attributes = dict(attrs)
        href = attributes.get("href")
        if href:
            self.hrefs.append(href)


def observed_link(html, base_url):
    parser = Links()
    parser.feed(html)
    base = urlparse(base_url)
    for href in parser.hrefs:
        if href.startswith("#"):
            continue
        url = urljoin(base_url, href)
        parsed = urlparse(url)
        if parsed.scheme != "https" or parsed.hostname != base.hostname or parsed.username or parsed.password:
            continue
        if parsed.query or not parsed.path or parsed.path == "/":
            continue
        segments = [segment.lower() for segment in parsed.path.split("/") if segment]
        if not segments or any(segment in BLOCKED_SEGMENTS for segment in segments):
            continue
        if any(parsed.path.lower().endswith(ext) for ext in STATIC_EXTENSIONS):
            continue
        if parsed.path.startswith("//"):
            continue
        return urlunparse((parsed.scheme, parsed.netloc, parsed.path, "", "", ""))
    return None


def classify(status, content_type, snippet):
    if status in (403, 429, 503):
        return "challenge_or_denial"
    if status == 200 and any(marker in snippet.lower() for marker in STRONG_CHALLENGE_MARKERS):
        return "possible_challenge"
    if status == 200 and "html" in content_type:
        return "public_html"
    if status == 200:
        return "non_html"
    if status and 200 < status < 300:
        return "nonstandard_2xx"
    if status and status >= 400:
        return "http_error"
    return "other_status"


def fetch(url, timeout, allowed_host=None):
    redirects = RedirectRecorder(allowed_host)
    opener = build_opener(redirects)
    request = Request(url, headers={"User-Agent": USER_AGENT, "Accept": "text/html,application/xhtml+xml", "Accept-Encoding": "identity"}, method="GET")
    started = time.monotonic()
    result = {"requested_url": safe_url(url), "final_url": None, "final_origin": None, "status": None, "classification": None, "latency_ms": None, "redirect_chain": [], "content_type": None, "error_type": None, "error_reason": None}
    try:
        response = opener.open(request, timeout=timeout)
    except HTTPError as error:
        response = error
    except BlockedRedirect as error:
        result["classification"] = "blocked_redirect"
        result["error_reason"] = str(error)
        result["redirect_chain"] = redirects.chain
        result["latency_ms"] = round((time.monotonic() - started) * 1000)
        return result, None
    except (URLError, TimeoutError, OSError, ValueError) as error:
        result["classification"] = "network_error"
        result["error_type"] = type(error).__name__
        result["redirect_chain"] = redirects.chain
        result["latency_ms"] = round((time.monotonic() - started) * 1000)
        return result, None
    with response:
        result["status"] = response.status
        result["final_url"] = safe_url(response.url)
        result["final_origin"] = origin(response.url)
        result["redirect_chain"] = redirects.chain
        result["content_type"] = response.headers.get("Content-Type", "").split(";")[0].lower()
        raw = response.read(MAX_BYTES)
    html = raw.decode("utf-8", errors="replace")
    result["classification"] = classify(result["status"], result["content_type"], html[:16384])
    result["latency_ms"] = round((time.monotonic() - started) * 1000)
    return result, html if result["classification"] == "public_html" else None


def probe_site(site, timeout):
    output = {"domain": site["domain"], "tranco_rank": site["tranco_rank"], "checked_at": now_iso(), "homepage": None, "route": None, "route_skip_reason": None}
    try:
        home, html = fetch(site["entrypoint"], timeout)
        output["homepage"] = home
        if html is None:
            output["route_skip_reason"] = "homepage_" + home["classification"]
            return output
        final_host = urlparse(home["final_url"]).hostname
        if final_host != site["domain"] and not final_host.endswith("." + site["domain"]):
            output["route_skip_reason"] = "homepage_redirected_outside_inventory_domain"
            return output
        link = observed_link(html, home["final_url"])
        if not link:
            output["route_skip_reason"] = "no_safe_same_host_link_observed"
            return output
        route, _ = fetch(link, timeout, allowed_host=final_host)
        output["route"] = route
        return output
    except Exception as error:
        output["route_skip_reason"] = "runner_exception"
        output["runner_error_type"] = type(error).__name__
        if output["homepage"] is None:
            output["homepage"] = {"requested_url": safe_url(site["entrypoint"]), "final_url": None, "final_origin": None, "status": None, "classification": "runner_exception", "latency_ms": None, "redirect_chain": [], "content_type": None, "error_type": type(error).__name__, "error_reason": None}
        return output


def summarize(rows):
    home = Counter(row["homepage"]["classification"] for row in rows)
    route = Counter(row["route"]["classification"] for row in rows if row["route"])
    skips = Counter(row["route_skip_reason"] for row in rows if row["route_skip_reason"])
    return {
        "sites_with_outcome": len(rows),
        "homepages_attempted": len(rows),
        "homepage_classifications": dict(sorted(home.items())),
        "homepage_http_200_public_html": home["public_html"],
        "homepage_challenged_or_denied": home["challenge_or_denial"] + home["possible_challenge"],
        "homepage_network_errors": home["network_error"],
        "route_observed_and_attempted": sum(row["route"] is not None for row in rows),
        "route_http_200_public_html": route["public_html"],
        "route_classifications": dict(sorted(route.items())),
        "route_skip_reasons": dict(sorted(skips.items())),
        "redirected_homepages": sum(bool(row["homepage"]["redirect_chain"]) for row in rows),
    }


def write_output(path, sites, rows, started_at, timeout, workers, complete):
    ordered = sorted(rows, key=lambda row: row["tranco_rank"])
    payload = {
        "schema_version": 1,
        "runner": "http_client_public_get",
        "source_list_id": "GQ3LK",
        "started_at": started_at,
        "updated_at": now_iso(),
        "complete": complete,
        "parameters": {"timeout_seconds_per_request": timeout, "max_workers": workers, "max_redirects_per_request": MAX_REDIRECTS, "max_response_bytes": MAX_BYTES, "max_initial_gets_per_site": 2},
        "summary": summarize(ordered),
        "results": ordered,
    }
    temp = path.with_suffix(path.suffix + ".tmp")
    temp.write_text(json.dumps(payload, indent=2) + "\n")
    temp.replace(path)


def main():
    parser = argparse.ArgumentParser(description="Unauthenticated, bounded HTTP GET pass for all 400 inventoried domains")
    parser.add_argument("--timeout", type=float, default=7.0)
    parser.add_argument("--workers", type=int, default=12)
    parser.add_argument("--output", type=Path, default=HERE / "public-all-results.json")
    args = parser.parse_args()
    if not 1 <= args.timeout <= 20 or not 1 <= args.workers <= 20:
        parser.error("timeout must be 1-20 seconds and workers 1-20")
    sites = json.loads((HERE / "sites.json").read_text())["sites"]
    if len(sites) != 400:
        parser.error("sites.json must contain exactly 400 domains")
    started = now_iso()
    rows = []
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        pending = {pool.submit(probe_site, site, args.timeout): site["domain"] for site in sites}
        for future in as_completed(pending):
            rows.append(future.result())
            if len(rows) % 25 == 0 or len(rows) == len(sites):
                write_output(args.output, sites, rows, started, args.timeout, args.workers, len(rows) == len(sites))
                summary = summarize(rows)
                print(f"{len(rows)}/400 home HTML={summary['homepage_http_200_public_html']} challenged={summary['homepage_challenged_or_denied']} routes={summary['route_observed_and_attempted']}", flush=True)
    print(f"Saved {len(rows)} site outcomes to {args.output}")


if __name__ == "__main__":
    main()
