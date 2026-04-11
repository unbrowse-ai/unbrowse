#!/usr/bin/env python3
"""Inspect what structured-data signals a URL exposes.

Curls the URL, then reports which SPA / structured-data markers are
present in the raw HTML. Feeds the harness-harness loop: when bench-local
marks a site as dom-fallback-only, run this to see what the capture
pipeline SHOULD have found.

Not a replacement for capture — captures fail on JS-rendered sites that
only expose their data post-hydration. But for SSR sites, this catches
the cases where the data IS in the initial HTML and our extractor
silently missed it (e.g. truncation, non-greedy regex, unsupported
marker).

Usage:
  python3 scripts/inspect-page-signals.py <url>
  python3 scripts/inspect-page-signals.py <url> --full      # dump full json
  cat urls.txt | python3 scripts/inspect-page-signals.py -  # batch mode
"""
import sys
import re
import json
import urllib.request
import urllib.error


USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15"
)


def _balanced_object(src: str, start: int) -> str | None:
    """Pull a brace-balanced {...} body starting at or after `start`."""
    first = src.find("{", start)
    if first < 0:
        return None
    depth = 0
    in_str = False
    str_ch = ""
    esc = False
    for i in range(first, len(src)):
        c = src[i]
        if esc:
            esc = False
            continue
        if in_str:
            if c == "\\":
                esc = True
                continue
            if c == str_ch:
                in_str = False
            continue
        if c in ('"', "'", "`"):
            in_str = True
            str_ch = c
            continue
        if c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
            if depth == 0:
                return src[first:i + 1]
    return None


def fetch(url: str, timeout: int = 20) -> tuple[int, dict, str]:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            status = resp.status
            headers = dict(resp.headers.items())
            body = resp.read().decode("utf-8", errors="replace")
            return status, headers, body
    except urllib.error.HTTPError as e:
        try:
            body = e.read().decode("utf-8", errors="replace")
        except Exception:
            body = ""
        return e.code, dict(e.headers.items()) if e.headers else {}, body
    except Exception as e:
        return -1, {"error": str(e)}, ""


def inspect_html(html: str) -> dict:
    """Return structured signal report for the HTML body.

    Keys:
      size_bytes: total HTML size
      spa_markers: {marker_name: {pos, bytes, parse_ok, keys_sample}}
      jsonld_scripts: count + first few @type values
      ldplus_json_inline: count of <script type="application/json"> blocks
      og_meta: count + a sample of useful og:* keys
      cloudflare_challenge: bool
      title: <title> contents
      visible_labels: list of likely label-value label texts (ends with ":")
      bytes_past_300k: how much data lives past the MAX_HTML_SIZE truncation
    """
    report: dict = {
        "size_bytes": len(html),
        "bytes_past_300k": max(0, len(html) - 300_000),
        "spa_markers": {},
        "jsonld_scripts": 0,
        "jsonld_types": [],
        "og_meta": {},
        "cloudflare_challenge": False,
        "title": "",
        "label_candidates": [],
    }

    m = re.search(r"<title[^>]*>([^<]{0,200})</title>", html, re.I | re.S)
    if m:
        report["title"] = m.group(1).strip()[:120]

    # Cloudflare challenge / JS challenge. Use high-specificity markers —
    # `challenge-platform` alone is a false positive (cloudflare ships a
    # JSD telemetry script at /cdn-cgi/challenge-platform/... even on
    # fully-served pages). Require actual challenge markup or a
    # "Just a moment" / "Attention Required" title.
    title = report.get("title", "")
    is_challenge_title = bool(re.search(
        r"(Just a moment|Attention Required|Access denied|Please Wait|Security check)",
        title,
        re.I,
    ))
    has_challenge_form = bool(re.search(
        r'<form[^>]*(?:id|class)="challenge-form|cf-challenge-running|__cf_chl_f_tk|cf_chl_opt',
        html,
        re.I,
    ))
    if is_challenge_title or has_challenge_form:
        report["cloudflare_challenge"] = True

    # Next.js <script id="__NEXT_DATA__">
    m = re.search(
        r'<script\s+id="__NEXT_DATA__"[^>]*>([\s\S]*?)</script>',
        html,
        re.I,
    )
    if m:
        body = m.group(1)
        ok = False
        keys: list[str] = []
        try:
            parsed = json.loads(body)
            pp = (parsed or {}).get("props", {}).get("pageProps") or {}
            ok = isinstance(pp, dict) and bool(pp)
            if ok:
                keys = list(pp.keys())[:10]
        except Exception:
            pass
        report["spa_markers"]["__NEXT_DATA__"] = {
            "pos": m.start(),
            "bytes": len(body),
            "parse_ok": ok,
            "page_props_keys": keys,
            "past_truncation": m.start() > 300_000,
        }

    for var in ("__NUXT__", "__INITIAL_STATE__", "__PRELOADED_STATE__", "__APOLLO_STATE__"):
        assign_re = re.compile(rf"window\.{re.escape(var)}\s*=\s*\{{")
        mm = assign_re.search(html)
        if not mm:
            continue
        body = _balanced_object(html, mm.start())
        if body is None:
            continue
        ok = False
        keys: list[str] = []
        try:
            parsed = json.loads(body)
            if isinstance(parsed, dict) and parsed:
                ok = True
                keys = list(parsed.keys())[:10]
        except Exception:
            pass
        report["spa_markers"][var] = {
            "pos": mm.start(),
            "bytes": len(body),
            "parse_ok": ok,
            "keys": keys,
            "past_truncation": mm.start() > 300_000,
        }

    # JSON-LD
    ld_blocks = re.findall(
        r'<script\s+type="application/ld\+json"[^>]*>([\s\S]*?)</script>',
        html,
        re.I,
    )
    report["jsonld_scripts"] = len(ld_blocks)
    for block in ld_blocks[:5]:
        try:
            parsed = json.loads(block)
        except Exception:
            continue
        items = parsed if isinstance(parsed, list) else [parsed]
        for it in items:
            if isinstance(it, dict):
                t = it.get("@type")
                if isinstance(t, str):
                    report["jsonld_types"].append(t)
                elif isinstance(t, list):
                    report["jsonld_types"].extend(x for x in t if isinstance(x, str))

    # OG meta — helpful for title/description/image even when body is thin
    for mm in re.finditer(
        r'<meta\s+property="(og:[^"]+)"\s+content="([^"]{0,200})"',
        html,
        re.I,
    ):
        report["og_meta"][mm.group(1)] = mm.group(2)
    if len(report["og_meta"]) > 12:
        keep = dict(list(report["og_meta"].items())[:12])
        report["og_meta"] = keep

    # "Label:" text candidates (for detail pages like etherscan)
    label_candidates = set()
    for mm in re.finditer(r">\s*([A-Z][A-Za-z ][A-Za-z0-9 /()]{3,40}):\s*<", html):
        label_candidates.add(mm.group(1))
    report["label_candidates"] = sorted(label_candidates)[:15]

    return report


def verdict(report: dict) -> str:
    if report.get("cloudflare_challenge"):
        return "browser_block:cloudflare"
    for name, info in report.get("spa_markers", {}).items():
        if info.get("parse_ok"):
            if info.get("past_truncation"):
                return f"spa_present_past_truncation:{name}"
            return f"spa_present:{name}"
    if report.get("jsonld_scripts", 0) > 0:
        return "jsonld_present"
    if report.get("size_bytes", 0) < 5000:
        return "thin_body_no_data"
    if report.get("label_candidates"):
        return "label_value_candidates"
    if report.get("og_meta"):
        return "og_meta_only"
    return "no_structured_signals"


def run(url: str, full: bool) -> dict:
    status, headers, body = fetch(url)
    if status < 0:
        return {"url": url, "error": headers.get("error"), "verdict": "fetch_failed"}
    report = inspect_html(body)
    report["url"] = url
    report["http_status"] = status
    report["verdict"] = verdict(report)
    if not full:
        # Trim for readability
        trimmed = {k: v for k, v in report.items() if k != "og_meta"}
        return trimmed
    return report


def main() -> None:
    args = sys.argv[1:]
    full = "--full" in args
    args = [a for a in args if not a.startswith("--")]
    if not args:
        print("usage: inspect-page-signals.py <url> [--full]", file=sys.stderr)
        sys.exit(2)
    urls = []
    if args[0] == "-":
        urls = [line.strip() for line in sys.stdin if line.strip()]
    else:
        urls = args
    for url in urls:
        result = run(url, full)
        print(json.dumps(result, indent=2, default=str))


if __name__ == "__main__":
    main()
