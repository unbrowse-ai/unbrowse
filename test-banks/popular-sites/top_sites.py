#!/usr/bin/env python3
"""The top 1,000 web-facing sites of a Tranco list, each with a task run_bank.py's checks can judge (UNB-260).

    top_sites.py probe  --tranco-csv <csv> --upto 2500 --out probe.jsonl
        one bounded GET of each domain's front page, in rank order, and what it showed: where it went, what it served,
        the search it declares, the words it links with, and the hosts its page loads things from
    top_sites.py build  --tranco-csv <csv> --probe probe.jsonl [--want 1000]
        top-1000.json: the first 1,000 domains that are web pages, each with its case, and every domain passed over
        with the property that ruled it out
    top_sites.py shard  --list top-1000.json --shard 3 --of 50 [--limit 20]
        the sites one job reads, comma-separated (round robin over the first `limit` sites)
    top_sites.py report --list top-1000.json --reads <dir> [--limit N] [--md out.md] [--json out.json]
        hard_sites.py's five labels for every site, the totals, the run's hours and the ten commonest reasons a site was
        not right

Nothing here names a site. A domain is kept or passed over by what its own front page did (it answered no one, it
handed its visitors to another domain, it served no page, other sites load it and nobody links to it), and a case is
made from what the page itself declares (a SearchAction, an OpenSearch description, a search form) and the words it
links with. Where the bank already holds a hand-checked case for a domain (search-cases.json, staging-hard-sites.json),
that case is used, since its values were read by a person.
"""

import argparse
import csv
import hashlib
import html
import json
import re
import socket
import ssl
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter
from concurrent.futures import ThreadPoolExecutor, as_completed
from html.parser import HTMLParser
from pathlib import Path

import hard_sites
import run_bank

HERE = Path(__file__).resolve().parent
LIST_ID = "GQ3LK"
SNAPSHOT_DATE = "2026-10-27"
WANT = 1000
MAX_BYTES = 600_000
TIMEOUT = 12
DEADLINE = 20  # seconds a body may take to arrive
MAX_REDIRECTS = 6
# A browser's own words: a front page that answers a browser and not a script is still a front page, which is what the
# probe asks. It reads one page and follows no link.
HEADERS = {
    "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
}
# A host loaded by at least this share of the probed front pages, and linked to by under a quarter as many as load it,
# is one the web loads, not one it visits: an ad, tracking, font or CDN host.
THIRD_PARTY_SHARE = 0.03
LINKED_PER_LOAD = 0.25
EMPTY_PAGE_BYTES = 600
LINKED_BY = 2  # front pages that link to a domain for its refusal of the probe to say "a site", not "an API"
MIN_VALUES = 3
# Two-part public suffixes, enough to say which domain a host belongs to: "a.b.co.uk" is b.co.uk. A short second label
# under a two-letter country code is a suffix of its own.
SECOND_LEVEL = {"co", "com", "net", "org", "gov", "ac", "edu", "ne", "or", "go", "gob", "mil", "nic", "info", "biz"}
SEARCH_NAMES = {"q", "query", "search", "s", "k", "keyword", "keywords", "term", "terms", "text", "wd", "p", "search_query",
                "searchterm", "search_term", "st", "qt", "kw", "w", "key", "searchtext", "search-text", "find", "word", "qs"}
# Words a site links with that name no thing to find: a menu's own furniture, in the languages the list's top sites
# mostly use. A search for "login" finds nothing a site is about.
FURNITURE = set("""
home about contact help login logout sign signin register account privacy terms cookies cookie policy careers jobs press
news blog more menu search close open next previous back skip main content language english settings support download
apps app store shop cart basket checkout english deutsch français español italiano português русский 日本語 中文 한국어
learn read view show all here click subscribe follow share facebook twitter instagram youtube linkedin tiktok pinterest
copyright rights reserved accessibility sitemap feedback advertise advertising business developers investors legal
notice notices imprint impressum datenschutz kontakt hilfe anmelden startseite accueil connexion aide inicio ayuda
contacto iniciar sesión cuenta entrar sair ajuda conta войти помощь главная ログイン ヘルプ 登录 注册 首页 帮助 로그인
free donate offers deals sale gift gifts cards card terms conditions continue loading need item items center centre
start started getting explore visit create case under build building managed features products services partner
partners solutions resources company customers pricing plans enterprise overview discover watch see find get try
alle mehr weitere jetzt plus todos todas ver voir tous toutes tutti altro все ещё
with from that this your their what when where which have will they them were been were than then there these those
also into only over such some most more very just about after before other others first last year years today
""".split())
TOKEN_WORDS = re.compile(r"token|csrf|nonce|session|sig|hash|state", re.I)


def registrable(host):
    """The domain a host belongs to, by its last labels."""
    labels = (host or "").lower().rstrip(".").removeprefix("www.").split(".")
    if len(labels) >= 3 and len(labels[-1]) == 2 and labels[-2] in SECOND_LEVEL:
        return ".".join(labels[-3:])
    return ".".join(labels[-2:])


def ranked(path):
    """[(rank, domain)] and the list's SHA-256 and size."""
    data = Path(path).read_bytes()
    rows = []
    for row in csv.reader(data.decode("utf-8-sig").splitlines()):
        if len(row) != 2 or not row[0].isdigit():
            raise ValueError(f"invalid Tranco row: {row}")
        rows.append((int(row[0]), row[1].strip().lower()))
    return sorted(rows), hashlib.sha256(data).hexdigest(), len(data)


class Page(HTMLParser):
    """What a front page says about itself: its title, words, links, the hosts it loads, its declared searches."""

    def __init__(self, base):
        super().__init__(convert_charrefs=True)
        self.base, self.title, self.words, self.anchors, self.loads, self.links = base, "", 0, [], Counter(), Counter()
        self.opensearch, self.forms, self.ld, self.scripts = [], [], [], 0
        self._in, self._anchor, self._form, self._ld = [], None, None, None

    def handle_starttag(self, tag, attrs):
        a = {k.lower(): (v or "") for k, v in attrs}
        self._in.append(tag)
        if tag in ("script", "img", "iframe", "link", "source", "video", "audio", "embed") and (a.get("src") or (tag == "link" and a.get("href"))):
            target = a.get("src") or a.get("href")
            if tag == "link" and "search" in a.get("rel", "") and "opensearch" in a.get("type", ""):
                self.opensearch.append(urllib.parse.urljoin(self.base, target))
            elif tag != "link" or any(r in a.get("rel", "") for r in ("stylesheet", "preload", "icon", "preconnect", "dns-prefetch")):
                host = urllib.parse.urlsplit(urllib.parse.urljoin(self.base, target)).hostname
                if host:
                    self.loads[registrable(host)] += 1
        if tag == "script":
            self.scripts += 1
            if "ld+json" in a.get("type", ""):
                self._ld = []
        if tag == "a" and a.get("href"):
            host = urllib.parse.urlsplit(urllib.parse.urljoin(self.base, a["href"])).hostname
            if host:
                self.links[registrable(host)] += 1
            self._anchor = []
        if tag == "form":
            self._form = {"action": urllib.parse.urljoin(self.base, a.get("action") or self.base), "method": (a.get("method") or "get").lower(),
                          "role": a.get("role", ""), "inputs": []}
        if tag == "input" and self._form is not None:
            self._form["inputs"].append({"name": a.get("name", ""), "type": (a.get("type") or "text").lower(), "value": a.get("value", ""),
                                         "role": a.get("role", ""), "aria": (a.get("aria-label", "") + " " + a.get("placeholder", "")).lower()})

    def handle_endtag(self, tag):
        if self._in and tag in self._in:
            while self._in and self._in.pop() != tag:
                pass
        if tag == "a" and self._anchor is not None:
            text = " ".join("".join(self._anchor).split())
            if text:
                self.anchors.append(text)
            self._anchor = None
        if tag == "form" and self._form is not None:
            self.forms.append(self._form)
            self._form = None
        if tag == "script" and self._ld is not None:
            self.ld.append("".join(self._ld))
            self._ld = None

    def handle_data(self, data):
        if self._ld is not None:
            self._ld.append(data)
            return
        if "title" in self._in[-1:] and not self.title:
            self.title = " ".join(data.split())[:200]
        if not set(self._in) & {"script", "style", "noscript", "template"}:
            self.words += len(data.split())
            if self._anchor is not None:
                self._anchor.append(data)


def fetch(url, timeout=TIMEOUT):
    """(status, final url, content type, body bytes, error kind). Follows redirects like a browser, to MAX_REDIRECTS."""
    request = urllib.request.Request(url, headers=HEADERS)
    context = ssl.create_default_context()
    # A cookie jar, as a browser has: a front page that sets a cookie and sends the visitor back to itself loops
    # forever without one, and the probe read the loop's last 307 as the page (the first probe, 22 Nov 2026).
    opener = urllib.request.build_opener(urllib.request.HTTPSHandler(context=context), urllib.request.HTTPCookieProcessor())
    opener.addheaders = []
    try:
        with opener.open(request, timeout=timeout) as reply:
            return reply.status, reply.geturl(), reply.headers.get("Content-Type", ""), read_until(reply, time.monotonic() + DEADLINE), None
    except urllib.error.HTTPError as e:
        try:
            body = e.read(MAX_BYTES)
        except Exception:
            body = b""
        return e.code, e.geturl() or url, e.headers.get("Content-Type", "") if e.headers else "", body, None
    except urllib.error.URLError as e:
        reason = e.reason
        if isinstance(reason, socket.gaierror):
            return None, url, "", b"", "no_address"
        if isinstance(reason, ssl.SSLError):
            return None, url, "", b"", "tls"
        if isinstance(reason, (TimeoutError, socket.timeout)):
            return None, url, "", b"", "timeout"
        return None, url, "", b"", "no_connection"
    except (TimeoutError, socket.timeout):
        return None, url, "", b"", "timeout"
    except (ssl.SSLError, ssl.CertificateError):
        return None, url, "", b"", "tls"
    except Exception as e:  # a reset mid-read, a malformed reply: what the page did is that it didn't answer
        return None, url, "", b"", "no_connection:" + type(e).__name__


def read_until(reply, deadline):
    """At most MAX_BYTES of a body, and nothing after the deadline: a server that sends a byte a second keeps each read
    inside its timeout for as long as it likes (the first probe stood still on one front page for minutes)."""
    chunks, size = [], 0
    while size < MAX_BYTES and time.monotonic() < deadline:
        chunk = reply.read1(min(65536, MAX_BYTES - size)) if hasattr(reply, "read1") else reply.read(min(65536, MAX_BYTES - size))
        if not chunk:
            break
        chunks.append(chunk)
        size += len(chunk)
    return b"".join(chunks)


def search_action(blocks):
    """A schema.org SearchAction's target with its query as {q}: the site's own word for how it is searched."""
    for block in blocks:
        for template, name in re.findall(r'"(?:target|urlTemplate)"\s*:\s*"([^"]*\{([a-zA-Z_ .-]+)\}[^"]*)"', block):
            if "search" in block.lower() and "searchaction" in block.lower().replace(" ", ""):
                return html.unescape(template.replace("\\/", "/")).replace("{" + name + "}", "{q}")
    return None


def opensearch_template(xml):
    for template in re.findall(r'<Url[^>]*type="text/html"[^>]*template="([^"]+)"', xml) + re.findall(r'<Url[^>]*template="([^"]+)"[^>]*type="text/html"', xml):
        template = html.unescape(template)
        if "{searchTerms}" in template:
            template = template.replace("{searchTerms}", "{q}")
            # Optional parameters ({startPage?}) go; required ones other than the query make no address of their own.
            template = re.sub(r"[?&][^=&]+=\{[^}]+\?\}", "", template)
            if not re.search(r"\{(?!q\})[^}]+\}", template):
                return template
    return None


def form_template(form):
    """A GET form with a search box, as the address its submit would load."""
    if form["method"] != "get":
        return None
    box = next((i for i in form["inputs"] if i["name"] and (i["type"] == "search" or (i["type"] in ("text", "") and (
        i["name"].lower() in SEARCH_NAMES or "search" in i["aria"] or "search" in i["role"] or "search" in form["role"]))) ), None)
    if not box:
        return None
    action = urllib.parse.urlsplit(form["action"])
    keep = [(i["name"], i["value"]) for i in form["inputs"] if i["type"] == "hidden" and i["name"] and len(i["value"]) <= 40 and not TOKEN_WORDS.search(i["name"])]
    query = urllib.parse.urlencode(keep + [(box["name"], "QQQ")]).replace("QQQ", "{q}")
    return urllib.parse.urlunsplit((action.scheme, action.netloc, action.path or "/", query, ""))


def link_words(anchors, domain, limit=12):
    """Words the page links with, commonest first: what a site lists is what it can be searched for. Menu furniture and
    the site's own name are left out; a script with no spaces (CJK) gives its short link texts whole."""
    own = set(re.split(r"[.-]", domain))
    counts = Counter()
    for text in anchors:
        if len(text) > 60:
            continue
        if run_bank.has_cjk(text):
            for run in re.findall(r"[぀-ヿ㐀-鿿가-힯]{2,6}", text):
                if run not in FURNITURE:
                    counts[run] += 1
            continue
        # A link that is one word is a menu's name for a kind of thing ("Laptops", "Football"): what a site holds.
        words = re.findall(r"[^\W\d_]{4,16}", text.lower())
        for word in words:
            if word not in FURNITURE and word not in own:
                counts[word] += 3 if len(words) == 1 else 1
    return [w for w, _ in counts.most_common(limit)]


def probe_one(rank, domain):
    record = {"rank": rank, "domain": domain}
    tried = []
    for url in (f"https://{domain}/", f"https://www.{domain}/"):
        status, final, ctype, body, error = fetch(url)
        tried.append({"url": url, "status": status, "error": error})
        if status is not None:
            break
    record["tried"] = tried
    record.update({"status": status, "final_url": run_bank.strip_query(final) if final else None, "content_type": ctype.split(";")[0].strip().lower(), "bytes": len(body), "error": error})
    if status is None:
        return record
    final_host = urllib.parse.urlsplit(final).hostname or ""
    record["final_registrable"] = registrable(final_host)
    text = body.decode("utf-8", "replace")
    record["challenge"] = bool(run_bank.door_in(text[:4000]) or any(m in text[:20000].lower() for m in ("cf-chl-", 'id="challenge-form"', "captcha-delivery", "_incapsula_", "px-captcha")))
    if "html" not in record["content_type"] and not text.lstrip()[:200].lower().startswith(("<!doctype html", "<html")):
        return record
    page = Page(final)
    try:
        page.feed(text)
    except Exception:
        pass
    record.update({"title": page.title, "words": page.words, "scripts": page.scripts, "loads": dict(page.loads.most_common(40)), "links": dict(page.links.most_common(40)),
                   "values": link_words(page.anchors, domain)})
    template, source = search_action(page.ld), "search_action"
    if not template:
        for href in page.opensearch[:1]:
            status2, _, _, xml, _ = fetch(href, timeout=10)
            if status2 == 200:
                template, source = opensearch_template(xml.decode("utf-8", "replace")), "opensearch"
    if not template:
        template = next((t for t in (form_template(f) for f in page.forms) if t), None)
        source = "form"
    template = template.strip() if template else None
    if template and urllib.parse.urlsplit(template).scheme == "https" and registrable(urllib.parse.urlsplit(template).hostname) == registrable(final_host):
        record["search"] = {"template": template, "source": source}
    return record


def command_probe(args):
    rows, _, _ = ranked(args.tranco_csv)
    rows = [r for r in rows if r[0] <= args.upto]
    done = set()
    out = Path(args.out)
    if out.exists():
        kept = [json.loads(l) for l in out.read_text().splitlines() if l.strip()]
        if args.again:
            # Once more, few at a time, for what didn't answer or answered with a redirect it didn't follow: a burst of
            # lookups gets "no address" back for domains that have one (the first probe lost one of the top ten so).
            kept = [r for r in kept if not again(r)]
            out.write_text("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in kept))
        done = {r["domain"] for r in kept}
    todo = [r for r in rows if r[1] not in done]
    print(f"{len(todo)} to probe, {len(done)} already in {out}", file=sys.stderr)
    with out.open("a") as sink, ThreadPoolExecutor(args.workers) as pool:
        futures = [pool.submit(probe_one, *r) for r in todo]
        for n, future in enumerate(as_completed(futures), 1):
            record = future.result()
            sink.write(json.dumps(record, ensure_ascii=False) + "\n")
            sink.flush()
            if n % 100 == 0:
                print(f"{n}/{len(todo)}", file=sys.stderr)
    return 0


def again(record):
    """Whether a probe's answer is worth asking for once more: no answer, or a redirect it stopped at."""
    return record.get("status") is None or 300 <= record["status"] < 400 or record["status"] == 417


def third_party_hosts(records):
    """{domain: (pages that load it, pages that link to it)}, over every front page that served HTML."""
    pages = [r for r in records if "loads" in r]
    loads, links = Counter(), Counter()
    for r in pages:
        own = r.get("final_registrable")
        for host in r["loads"]:
            if host != own:
                loads[host] += 1
        for host in r["links"]:
            if host != own:
                links[host] += 1
    return {d: (loads[d], links[d]) for d in set(loads) | set(links)}, len(pages)


def passed_over(record, loaded, pages):
    """Why a domain is no web-facing site, from what its own front page did, or None when it is one."""
    domain = record["domain"]
    load, link = loaded.get(registrable(domain), (0, 0))
    if record.get("status") is None:
        # A domain other front pages link to is a site people visit, even where this machine gets no answer from it
        # (a name its resolver doesn't resolve): the node on the same machine meets the same, and the run counts it.
        if link >= LINKED_BY:
            return None
        kinds = sorted({t["error"] for t in record.get("tried", []) if t.get("error")})
        return "unreachable", (f"nothing answers from the probe's machine at the domain or its www host ({', '.join(kinds)}), and {link} front pages "
                               "link to it: an API, CDN or tracking host")
    if record.get("final_registrable") and record["final_registrable"] != registrable(domain):
        return "redirect_only", f"its front page hands its visitors to {record['final_registrable']}"
    if pages and load >= THIRD_PARTY_SHARE * pages and link < LINKED_PER_LOAD * load and not record.get("search"):
        return "loaded_not_visited", f"{load} of {pages} front pages load from it and {link} link to it: an ad, tracking, font or CDN host"
    if record.get("challenge"):
        return None  # a wall in front of a page is a site Unbrowse has to face
    # Nothing at the root (404, 410) is no front page, whoever links there.
    if record["status"] in (404, 410):
        return "no_page", f"its front page answers {record['status']}"
    # A refusal that is still a titled page (Facebook's 400 "Error" to a script, a "Checking your browser" 401) is a
    # site that turned the probe away, which the node has to face. So is an untitled refusal or a blank page that other
    # front pages link to: people go there, the probe just wasn't let in.
    if record["status"] >= 400 and record.get("title"):
        return None
    if link >= LINKED_BY:
        return None
    if record["status"] >= 400:
        return "no_page", f"its front page answers {record['status']} with no titled page, and {link} front pages link to it"
    if "words" not in record:
        return "no_page", f"its front page serves {record.get('content_type') or 'nothing'}, not a page"
    if record.get("bytes", 0) < EMPTY_PAGE_BYTES and not record.get("scripts"):
        return "no_page", f"its front page is {record.get('bytes')} bytes with no script: a parked or placeholder page"
    return None


def known_cases():
    """Hand-checked cases already in the bank, by domain: their values were read by a person."""
    out = {}
    for name in ("staging-hard-sites.json", "search-cases.json"):
        path = HERE / name
        if path.exists():
            # A case whose address carries no query (a search box that hands off to a chat) varies nothing the
            # checks can read: the front page decides that site's task instead.
            for case in (c for c in json.loads(path.read_text())["cases"] if "{q}" in c["url"]):
                out.setdefault(registrable(urllib.parse.urlsplit(case["url"].replace("{q}", "q")).hostname or case["site"]), dict(case, url_source=case.get("url_source", "known"), from_file=name))
    return out


def case_for(record, known):
    """The task a kept domain gets: the bank's own case where it has one, else a search where the page declares one and
    links with enough words to ask it for, else a read of the front page."""
    domain = record["domain"]
    if domain in known:
        case = dict(known[domain])
        return dict(case, site=domain, registrable=domain) if case["site"] != domain and registrable(case["site"]) != domain else case
    search, values = record.get("search"), record.get("values") or []
    if search and len(values) >= MIN_VALUES:
        return {"site": domain, "kind": "search", "goal": f"search {domain}", "url": search["template"], "values": values[:MIN_VALUES],
                "url_source": "page:" + search["source"]}
    entry = record.get("final_url") or f"https://{domain}/"
    why = "no search on its front page" if not search else f"its front page links with {len(values)} words to search for, under {MIN_VALUES}"
    return {"site": domain, "kind": "read", "goal": f"read the main content of {domain}'s front page", "url": entry, "values": [],
            "url_source": "page:front", "why_read": why}


def build(rows, records, want=WANT, known=None):
    """(kept cases in rank order, passed-over domains with reasons) from the ranked list and the probe."""
    by_domain = {r["domain"]: r for r in records}
    loaded, pages = third_party_hosts(records)
    kept, dropped, seen = [], [], set()
    known = known if known is not None else known_cases()
    for rank, domain in rows:
        if len(kept) >= want:
            break
        record = by_domain.get(domain)
        if record is None:
            raise SystemExit(f"{domain} (rank {rank}) was not probed: probe further down the list")
        verdict = passed_over(record, loaded, pages)
        if verdict:
            dropped.append({"domain": domain, "rank": rank, "property": verdict[0], "why": verdict[1]})
            continue
        case = case_for(record, known)
        if case["site"] in seen:
            dropped.append({"domain": domain, "rank": rank, "property": "same_site", "why": f"the same case as {case['site']}"})
            continue
        seen.add(case["site"])
        kept.append(dict(case, tranco_rank=rank, probe={k: record.get(k) for k in ("status", "final_url", "challenge", "words")}))
    if len(kept) < want:
        raise SystemExit(f"only {len(kept)} web-facing domains in the probed ranks; probe further down the list")
    return kept, dropped


def command_build(args):
    rows, digest, size = ranked(args.tranco_csv)
    records = [json.loads(l) for l in Path(args.probe).read_text().splitlines() if l.strip()]
    kept, dropped = build(rows, records, args.want)
    counts = Counter(d["property"] for d in dropped)
    payload = {
        "schema_version": 1,
        "ticket": "UNB-260",
        "about": ("The top web-facing domains of a Tranco list, in rank order, each with a task run_bank.py's checks judge: a search (url with {q}, "
                  "three values) where the front page declares one, else a read of the front page (kind: read). Built by top_sites.py from one probe of "
                  "each front page; every domain passed over carries the property of its own front page that ruled it out."),
        "source": {"name": "Tranco standard daily list", "list_id": LIST_ID, "snapshot_date": SNAPSHOT_DATE, "list_url": f"https://tranco-list.eu/list/{LIST_ID}",
                   "download_url": f"https://tranco-list.eu/download/{LIST_ID}/1000000", "sha256_full_csv": digest, "full_csv_bytes": size},
        "probe": {"date": args.probe_date, "from": "one GET of https://<domain>/ (then https://www.<domain>/) per domain, browser headers, redirects followed"},
        "ranks_read": max(r["tranco_rank"] for r in kept),
        "counts": {"kept": len(kept), "passed_over": len(dropped), "by_property": dict(counts.most_common()),
                   "kinds": dict(Counter(c.get("kind", "search") for c in kept)), "url_sources": dict(Counter(c.get("url_source") for c in kept))},
        "cases": kept,
        "passed_over": dropped,
    }
    Path(args.out).write_text(json.dumps(payload, indent=1, ensure_ascii=False) + "\n")
    print(json.dumps(payload["counts"], indent=1))
    return 0


def failure_reason(row):
    """One short reason a site wasn't right, for counting: the first failing check's step and why, else the label's."""
    if row["label"] == "right":
        return None
    for step, outcome in row["checks"].items():
        if not str(outcome).startswith("pass") and outcome != "not_tested":
            return f"{row['label']}: {step} {outcome} ({row['whys'].get(step) or 'no reason given'})"
    return f"{row['label']}: " + re.sub(r"\d+ s\b", "N s", row["why"].split(":")[0])[:80]


def top_report(listed, records, skipped, seconds, memory=None):
    result = hard_sites.report(listed, records, skipped, seconds)
    for row in result["rows"]:
        record = records.get(row["site"]) or {}
        row["whys"] = {c["step"]: c.get("why") for c in record.get("checks") or []}
        row["kind"] = next((c.get("kind", "search") for c in listed if c["site"] == row["site"]), "search")
        row["reason"] = failure_reason(row)
        row["model_asks_unanswered"] = (record.get("model") or {}).get("no_answer_said")
    timed = [s for s in seconds.values() if isinstance(s, (int, float))]
    result["seconds"] = {"sites_timed": len(timed), "total": sum(timed), "hours": round(sum(timed) / 3600, 2),
                         "mean": round(sum(timed) / len(timed), 1) if timed else None, "median": run_bank.median(timed)}
    result["by_kind"] = {k: dict(Counter(r["label"] for r in result["rows"] if r["kind"] == k)) for k in sorted({r["kind"] for r in result["rows"]})}
    result["reasons"] = Counter(r["reason"] for r in result["rows"] if r["reason"]).most_common()
    result["model"] = {"asks_unanswered": sum(r["model_asks_unanswered"] or 0 for r in result["rows"]),
                       "note": "the read jobs' nodes have no decision model (scratch-node.sh points it at 127.0.0.1:9): no tokens are spent, the rule decides"}
    result["memory"] = memory or {}
    return result


def top_markdown(result, top=10):
    c, s = result["counts"], result["seconds"]
    lines = [f"**Top sites: {c['right']} right, {c['wrong']} wrong, {c['needs a browser']} need a browser, {c['walled']} walled, {c['unknown']} unknown, of {result['sites']}.**", "",
             f"Site time: {s['hours']} h over {s['sites_timed']} timed sites (mean {s['mean']} s, median {s['median']} s). "
             f"AI: {result['model']['note']}; model asks that went unanswered: {result['model']['asks_unanswered']}."]
    if result.get("memory"):
        peaks = [m.get("peak_mb") for m in result["memory"].values() if m.get("peak_mb")]
        if peaks:
            lines.append(f"Peak memory of a read job's runner: {max(peaks)} MB (of {len(peaks)} jobs that said).")
    lines += ["", "| kind | " + " | ".join(hard_sites.LABELS) + " |", "|---|" + "---|" * len(hard_sites.LABELS)]
    for kind, counts in result["by_kind"].items():
        lines.append(f"| {kind} | " + " | ".join(str(counts.get(k, 0)) for k in hard_sites.LABELS) + " |")
    lines += ["", f"**The {top} commonest reasons a site was not right**", "", "| sites | reason |", "|---|---|"]
    for reason, n in result["reasons"][:top]:
        lines.append(f"| {n} | {reason.replace('|', '/')} |")
    lines += ["", "| site | kind | verdict | checks | s |", "|---|---|---|---|---|"]
    order = {k: n for n, k in enumerate(hard_sites.LABELS)}
    for r in sorted(result["rows"], key=lambda r: (order[r["label"]], r["site"])):
        lines.append(f"| {r['site']} | {r['kind']} | {r['label']} | {r['why'].replace('|', '/')[:200]} | {r['seconds'] if r['seconds'] is not None else ''} |")
    return "\n".join(lines) + "\n"


def gather_memory(reads_dir):
    out = {}
    for path in sorted(Path(reads_dir).rglob("memory-*.json")):
        try:
            doc = json.loads(path.read_text())
        except ValueError:
            continue
        out[str(doc.get("shard", path.stem))] = doc
    return out


def listed_cases(path, limit=None):
    cases = json.loads(Path(path).read_text())["cases"]
    return cases[:limit] if limit else cases


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    commands = parser.add_subparsers(dest="command", required=True)
    p = commands.add_parser("probe")
    p.add_argument("--tranco-csv", required=True)
    p.add_argument("--upto", type=int, default=2500)
    p.add_argument("--out", required=True)
    p.add_argument("--workers", type=int, default=32)
    p.add_argument("--again", action="store_true", help="probe once more what didn't answer (use few --workers)")
    b = commands.add_parser("build")
    b.add_argument("--tranco-csv", required=True)
    b.add_argument("--probe", required=True)
    b.add_argument("--probe-date", required=True)
    b.add_argument("--want", type=int, default=WANT)
    b.add_argument("--out", default=str(HERE / "top-1000.json"))
    s = commands.add_parser("shard")
    s.add_argument("--list", required=True)
    s.add_argument("--shard", type=int, required=True)
    s.add_argument("--of", type=int, required=True)
    s.add_argument("--limit", type=int)
    r = commands.add_parser("report")
    r.add_argument("--list", required=True)
    r.add_argument("--reads", required=True)
    r.add_argument("--limit", type=int)
    r.add_argument("--md")
    r.add_argument("--json")
    args = parser.parse_args(argv)
    if args.command == "probe":
        return command_probe(args)
    if args.command == "build":
        return command_build(args)
    listed = listed_cases(args.list, args.limit)
    if args.command == "shard":
        print(",".join(hard_sites.shard([c["site"] for c in listed], args.shard, args.of)))
        return 0
    result = top_report(listed, *hard_sites.gather(args.reads), memory=gather_memory(args.reads))
    text = top_markdown(result)
    print(text)
    if args.md:
        Path(args.md).write_text(text)
    if args.json:
        Path(args.json).write_text(json.dumps(result, indent=1, ensure_ascii=False) + "\n")
    return 0 if any(r["checks"] for r in result["rows"]) else 1


if __name__ == "__main__":
    sys.exit(main())
