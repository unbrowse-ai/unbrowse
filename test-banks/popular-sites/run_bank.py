#!/usr/bin/env python3
"""The public route test of MCP_TEST_PLAN.md, as a repeatable batch runner.

It drives a node's agent API (the same primitives as the MCP tools) through the plan's steps and records metadata.
It reads each answer against its query rather than trusting result.ok: the four answers of a site are compared with
each other, so the lines every answer shares (the page's menu and footer, the query echoed back) cancel out and only
what changed with the query counts as a result. What it decides is a suggestion. A person reads each answer, and any
call they make that differs goes in a reads file with its reason (`report`), so a report shows both.

It runs against a scratch node only: it refuses the owner's port, and any address that isn't this machine.

    python3 run_bank.py sample --seed 2026-11-06
    python3 run_bank.py run --cases search-cases.json --sites pypi.org,etsy.com --out run.json --samples /private/dir
    python3 run_bank.py judge --out run.json --site etsy.com --route <id> --verdict wrong --url <url> --why <what you saw>
    python3 run_bank.py run --cases search-cases.json --sites etsy.com --out run.json --samples /private/dir --after-judge
    python3 run_bank.py report --out run.json --reads reads.json --result mcp-runs/<date>.json
    python3 run_bank.py compare --out run.json
    python3 run_bank.py census --node-home <scratch>/home/node --out run.json --census census.json
"""
import argparse
import hashlib
import json
import os
import re
import shutil
import stat
import statistics
import subprocess
import sys
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter, defaultdict
from pathlib import Path

HERE = Path(__file__).resolve().parent

OWNER_PORT = 7788
WAIT_SECS = 340  # the agent API's call_wait_secs (330), and a little
# A reply that says the node is still working (how: working) names an ask; the bank collects its answer this many times
# at most, each waiting COLLECT_WAIT_MS (the node's MOST_WAIT). The node ends an ask's work 120 s behind its first reply
# (param.ask.wall), so one collect is nearly always enough. Scoring the working reply itself scored no answer at all.
COLLECTS = 3
COLLECT_WAIT_MS = 300_000
GAP_SECS = 4.0  # between two calls to one site
SITE_GAP_SECS = 10.0  # between two sites
MAX_BATCH = 5  # sites a run takes at once
MAX_CALLS_PER_SITE = 14  # a site's first pass, retries included
MAX_JUDGMENTS = 3  # after this a site is what it is: no judging a site until it passes
SHORT = 60  # characters kept of a title
ERROR_SHORT = 300  # characters kept of an error: enough for the step and what it needed
SAMPLE_CHARS = 1500  # characters of an answer's own lines kept in the private samples
# A warm call has to cost at most this share of opening the same URL in a browser. The Eden report's page routes saved only
# the browser's own rendering, a third at best (3.6-8.7 s against 3-6 s): a call that skips the page altogether saves more
# than half, so half is where a route has plainly earned its keep.
WARM_SHARE_OF_BROWSER = 0.5
MIN_WARM_CALLS = 2  # one call is a measurement of the network that second
# What a scratch node may hold at the end of a run. The report saw 800 MB and 88 processes. A walk's browser closes with its
# walk, so what is left is at most one browser handed over for an agent to drive (`how: browse`, HANDOFF_TTL), about ten
# processes of Chrome's own.
MAX_NODE_RSS_MB = 500
MAX_PROCESSES_LEFT = 10
MIN_OWN_LINES_OF_A_LONG_PAGE = 3  # of a page of LONG_PAGE_LINES or more: two lines that change are its title and a breadcrumb
LONG_PAGE_LINES = 20
MIN_RECORDS = 3  # one record is a config object, not a list
MIN_PRICES = 3  # a page's frame can name a price or two ("free delivery over $50"); a list of offers names one each
FINDING_OUTCOMES = ("pass", "fail", "blocked", "not_run")
FINDINGS = ("warm_speed", "data_route", "correct", "keeps_pick", "sse", "short_values", "inputs", "browserless", "reads_on", "follows_a_link")  # per site, from the Eden report; reads_on is scenarios.json's public.pagination, follows_a_link its public.navigation

SITE_OUTCOMES = (
    "pass",  # every check right on the first ask
    "pass_after_retry",  # right, after one retried timeout
    "pass_after_judge",  # right, after unbrowse_judge taught the node
    "pass_after_hands",  # right, after steps through unbrowse_browse
    "ok_but_wrong",  # an answer came back ok and isn't the search
    "false_failure",  # right answers, but a no-results answer counts as an error
    "fail",  # the node couldn't do it
    "blocked",  # a challenge, a denial, a region gate: never a pass
    "requires_account",  # a login wall
    "not_applicable",  # no public search on the site
    "safety_stop",  # a route marked write
    "not_tested",
)
PASSES = ("pass", "pass_after_retry", "pass_after_judge", "pass_after_hands")
CHECK_OUTCOMES = ("pass", "ok_but_wrong", "false_failure", "fail", "blocked", "requires_account", "safety_stop", "unstable", "not_tested")

CHALLENGE = (
    "just a moment", "verify you are human", "verify you’re a human", "verify you're a human", "are you a robot", "are you human",
    "captcha", "access denied", "you have been blocked", "pardon our interruption", "unusual traffic", "request blocked",
    "attention required", "robot check", "press & hold", "press and hold", "enable javascript and cookies", "too many requests",
    "bot check", "security check", "human verification", "安全验证", "验证码",
)
GATE = ("select your country", "choose your country", "choose a country", "select a country", "not available in your", "unavailable in your region")
LOGIN = ("sign in to continue", "log in to continue", "please log in", "please sign in", "login required", "you must be logged in", "sign in to your account")
NO_RESULTS = (
    "no results", "no result", "no hits", "nothing found", "no matches", "no exact matches", "no match",
    "did not match", "didn't match", "couldn't find", "could not find", "can't find", "cannot find", "we didn't find", "not find any",
    "found nothing", "returned no", "no items", "no packages", "no videos", "no articles", "no recipes",
    "keine ergebnisse", "keine treffer", "keine exakten treffer", "nichts gefunden", "aucun résultat", "aucun resultat", "sin resultados", "nenhum resultado",
    "brak wyników", "brak wynikow", "ничего не найдено",
    "не найдено", "見つかりません", "該当する",
    "検索結果はありません", "没有找到", "未找到",
    "无结果", "暂无",
)
ECHO = ("results for", "result for", "search results", "you searched", "your search", "searching for", "showing results", "suche nach", "search for", "search:")
TITLE_KEYS = ("title", "name", "headline", "label", "displayName", "display_name", "text", "description")
# Emphasis a search answer puts inside a highlighted title.
PLAIN_MARKUP = re.compile(r"</?(?:mark|em|strong|b|i)(?:\s[^>]*)?>", re.I)
# Paths a read test must not replay without a person looking, whatever the route's write label says.
WRITE_WORDS = re.compile(r"(^|[/_\-.])(add|cart|basket|checkout|order|pay|payment|subscribe|unsubscribe|signup|sign-up|register|login|logout|delete|update|create|vote|follow|like|comment|post|submit|send)([/_\-.?]|$)", re.I)
# A call that suggests is not the search, however well its names match: only its own path says so.
# An object's own way of saying it found nothing: {"results": [], ...}, {"numFound": 0}.
ZERO_FOUND = re.compile(r"(?<![\d.,])0 (results?|items?|packages?|projects?|matches|ergebnisse|treffer)\b", re.I)
EMPTY_LIST = re.compile(r"^\s*(results?|hits|items|posts|products|docs|data|numFound|total)\s*:\s*(\[\]|0\b|\{'results': \[\])", re.I)
SUGGESTS = re.compile(r"(auto-?complete|auto-?suggest|type-?ahead|suggest(ion)?s?)", re.I)
REFUSED = (403, 429, 503)  # the node's `trace::REFUSED`
DOOR_PATH = re.compile(r"challenge|captcha", re.I)
CALL_WALLED = re.compile(r"answered (?:403|429|503)|a sign-in or a wall")
UNREAD_DATA = re.compile(r"json|text/plain|event-stream", re.I)
JSON_EVENT = re.compile(r"^data:\s*[\[{]", re.M)
MONEY = re.compile(r"[$€£¥฿₩₫₱]\s?\d|\b(?:SGD|USD|EUR|GBP|JPY|THB|MYR|HKD|AUD|RM|Rp)\s?\d|\d\s?(?:SGD|USD|EUR|GBP|JPY|THB|MYR|HKD|AUD)\b|\d\s?円|\"[^\"]*(?:price|fare|amount)[^\"]*\":\s*\"?\d", re.I)
SCRUB = (
    (re.compile(r"[\w.+-]+@[\w-]+\.[\w.-]+"), "[email]"),
    (re.compile(r"\beyJ[\w-]{10,}(\.[\w-]+)*"), "[token]"),
    (re.compile(r"\b[0-9a-fA-F]{24,}\b"), "[hex]"),
    (re.compile(r"\b[A-Za-z0-9_-]{40,}\b"), "[token]"),
    (re.compile(r"\b(?:\d{1,3}\.){3}\d{1,3}\b"), "[address]"),  # archive.org's answer says the caller's address back
    (re.compile(r"\+?\d[\d ()-]{9,}\d"), "[number]"),
)
AN_ADDRESS = re.compile(r"\b(?:\d{1,3}\.){3}\d{1,3}\b")

# What a link must never be, on any site. {s} is the site, and each one has to answer 400.
MALFORMED_LINKS = (
    ("port", "unbrowse://{s}:443"),
    ("login", "unbrowse://user@{s}"),
    ("login_and_password", "unbrowse://user:secret@{s}"),
    ("query", "unbrowse://{s}?q=1"),
    ("query_after_slash", "unbrowse://{s}/?q=1"),
    ("fragment", "unbrowse://{s}#top"),
    ("non_ascii_host", "unbrowse://exämple-{s}"),
    ("cyrillic_lookalike_host", "unbrowse://а{s}"),
    ("percent_encoded_host", "unbrowse://%65{s}"),
    ("path_not_an_entry", "unbrowse://{s}/search"),
    ("short_entry", "unbrowse://{s}/0x" + "ab" * 31),
    ("entry_not_hex", "unbrowse://{s}/0x" + "zz" * 32),
    ("entry_then_more", "unbrowse://{s}/0x" + "ab" * 32 + "/more"),
    ("entry_then_query", "unbrowse://{s}/0x" + "ab" * 32 + "?a=1"),
    ("other_scheme", "https://{s}"),
    ("no_slashes", "unbrowse:{s}"),
    ("backslash", "unbrowse://{s}\\evil.com"),
    ("too_long", "unbrowse://" + "a" * 520 + ".{s}"),
)
# Not tied to a site. What these should be is a judgment, so each says what the node ought to answer.
ODD_LINKS = (
    ("ip_address", "unbrowse://127.0.0.1", 400),
    ("localhost", "unbrowse://localhost", 400),
    ("bare_public_suffix", "unbrowse://co.uk", 400),
    ("empty_host", "unbrowse://", 400),
    ("dots_only", "unbrowse://..", 400),
    ("leading_dash", "unbrowse://-example.com", 400),
    ("punycode_lookalike", "unbrowse://xn--pple-43d.com", 400),
)
SOUND_LINKS = (
    ("plain", "unbrowse://{s}"),
    ("upper_case", "UNBROWSE://{u}"),
    ("trailing_slash", "unbrowse://{s}/"),
)


def nonsense_value(seed):
    """A word that finds nothing, made per run. A fixed one stops being nonsense once this bank is published: search
    the code hosts for it and it finds this file."""
    consonants = "bcdfghjklmnpqrstvwxz"
    digest = hashlib.sha256(f"nonsense:{seed}".encode()).digest()
    return "zq" + "".join(consonants[b % len(consonants)] for b in digest[:10])


def normal(text):
    """Case, width and accents folded, so a mention is found however a site writes it."""
    return "".join(c for c in unicodedata.normalize("NFKD", str(text)) if not unicodedata.combining(c)).casefold()


def has_cjk(text):
    return any("぀" <= c <= "ヿ" or "㐀" <= c <= "鿿" or "가" <= c <= "힯" for c in text)


def word_stems(value):
    """The parts of a query a result could show: each word of three letters or more, its ending cut (towels: towel)."""
    out = []
    for word in normal(value).split():
        if has_cjk(word):
            out.append(word)
        elif len(word) >= 3:
            out.append(word[: max(3, len(word) - 2)] if len(word) > 4 else word)
    return out or [normal(value)]


def mentions(text, value, aliases=()):
    """Whether an answer's line names the value — itself, or a word the case says it stands for (`bjs` is Beijing: a
    flight list names airports, never IATA codes)."""
    plain = normal(text)
    return any(stem in plain for stem in word_stems(value)) or any(normal(a) in plain for a in aliases if a)


def is_echo(line, value):
    """A line that says the query back, rather than a result about it."""
    plain = normal(line).strip(" \"'“”「」:.")
    query = normal(value)
    return plain == query or (len(plain) <= len(query) + 30 and any(e in plain for e in ECHO))


def carries_the_query(line, value):
    """An object's line that only holds the request: `fullUrl: https://...?dcity=bjs`, `query: bjs`."""
    key, said, rest = line.partition(": ")
    return bool(said) and ("://" in rest[:12] or rest.startswith("/") or normal(rest).strip() == normal(value))


def shorten(text):
    flat = " ".join("".join(c if c.isprintable() else " " for c in str(text)).split())
    for pattern, stand_in in SCRUB:
        flat = pattern.sub(stand_in, flat)
    return flat[:SHORT]


def shorten_error(text):
    flat = " ".join("".join(c if c.isprintable() else " " for c in str(text)).split())
    for pattern, stand_in in SCRUB:
        flat = pattern.sub(stand_in, flat)
    return flat.replace(str(Path.home()), "~")[:ERROR_SHORT]


def keyed_title(record, depth=3, through_lists=True):
    """The text a record names itself by: the shallowest level that has one, and at that level a title before a name. A
    product's title sits beside its brand's name, a level down (`item.product_description.title`, `item.primary_brand.name`).
    `through_lists` off reads only the record's own name, never one a part of it carries."""
    level = [record]
    for _ in range(depth + 1):
        found, following = {}, []
        for node in level:
            for key, value in node.items():
                # A key's own last segment names it: `title.default` is a title, `product_description.title` too. And a
                # title is often a highlighted list — `highlight: {title: ["<mark>Domains</mark>"]}` — so a list of
                # strings names a record as its first entry does, with the emphasis taken off.
                stem = str(key).rsplit(".", 1)[-1].rsplit("_", 1)[-1]
                if isinstance(value, list):
                    first = next((v for v in value if isinstance(v, str) and v.strip()), "")
                    value = PLAIN_MARKUP.sub("", first) if first else value
                if (key in TITLE_KEYS or stem in TITLE_KEYS) and isinstance(value, str) and value.strip():
                    found.setdefault(stem if key not in TITLE_KEYS else key, value)
                elif isinstance(value, dict):
                    following.append(value)
                elif isinstance(value, list) and through_lists:
                    # A record handed over wrapped in a list of its own (`{contents: [{name: ...}], topicId: ...}`)
                    # is named a level down like any other; its wrapper's tag is not its name.
                    following.extend(v for v in value if isinstance(v, dict))
        if found:
            return next(found[key] for key in TITLE_KEYS if key in found)
        level = following
    return ""


def record_title(record, depth=3):
    """A record's name, wherever it sits: search answers often nest it (`hits[].fields.title`)."""
    keyed = keyed_title(record, depth)
    if keyed:
        return keyed
    # An answer with obfuscated keys (Canva's {"C": "Film Poster", "A?": "A"}): the longest of its own texts is its name,
    # and an address is where something is, not what it's called.
    texts = [v for v in record.values() if isinstance(v, str) and v.strip()]
    own = max((v for v in texts if "://" not in v) or texts, key=len, default="")
    if len(own) > 3 or not depth:
        return own
    for value in record.values():
        found = record_title(value, depth - 1) if isinstance(value, dict) else ""
        if found:
            return found
    return own


def part_names(record, limit=60):
    """What a record's parts are called, where it holds lists of them: a photo's tags, a recipe's ingredients. A record
    says these too, so a photo tagged with the value is a photo of it whatever its own caption is."""
    out, level = [], [record]
    for _ in range(3):
        following = []
        for node in level:
            for value in node.values():
                if isinstance(value, dict):
                    following.append(value)
                elif isinstance(value, list):
                    out.extend(t for t in (keyed_title(v, 1) for v in value if isinstance(v, dict)) if t)
        level = following
    return list(dict.fromkeys(out))[:limit]


def record_line(record):
    """A record as one line: its name, then what its parts are called."""
    title = record_title(record)
    parts = [p for p in part_names(record) if p != title]
    return f"{title} · {', '.join(parts)}" if title and parts else title


def lists_in(record):
    """The lists a record holds, each with the path of keys to it."""
    out, stack = [], [(record, "")]
    while stack:
        node, path = stack.pop()
        for key, value in node.items():
            if isinstance(value, dict):
                stack.append((value, f"{path}.{key}"))
            elif isinstance(value, list):
                out.append((f"{path}.{key}", value))
    return out


def says_words(title):
    """Whether a record's title holds a word a person could read, not only an id or an address."""
    return any(word.isalpha() and 3 <= len(word) <= 40 for word in str(title).split())


def largest_records(value):
    """The longest list of objects anywhere in `value`: the records, when an answer is a site's data. A list that says
    words comes before one known only by ids, whatever their lengths: an id says nothing of what was asked. Of two as
    long, the one whose records name themselves: a layout can list as many slots, holding only ids, as the results it
    lays out."""
    best, best_rank, parts = [], (False, 0, 0, 0), set()
    stack = [value]
    while stack:
        node = stack.pop()
        if isinstance(node, dict):
            stack.extend(node.values())
        elif isinstance(node, list):
            objects = [n for n in node if isinstance(n, dict) and record_title(n).strip()]
            named = sum(1 for n in objects if keyed_title(n))
            words = len(objects) >= 3 and sum(says_words(record_title(n)) for n in objects) * 2 >= len(objects)
            # A list every record of a named list holds one of is those records' part: a photo's fifty tags, a flight's
            # two legs. It is no rival to the list of photos, however long one of them runs. A list that holds most of
            # what its like hold stands on its own: the twenty products in one of a page's three zones.
            if words and sum(1 for n in objects if keyed_title(n, through_lists=False)) * 2 >= len(objects):
                held = [(path, inner) for n in objects for path, inner in lists_in(n)]
                sizes = {}
                for path, inner in held:
                    sizes[path] = sizes.get(path, 0) + len(inner)
                parts.update(id(inner) for path, inner in held if len(inner) * 2 <= sizes[path])
            # Distinct names before a longer list of the same one: an answer that repeats a site's own name ten times
            # beside ten results is a menu, and its lines would read the same whatever was asked (WordPress.com's
            # search nests its titles and repeats `blog_name` in another list).
            distinct = len({record_title(n).strip() for n in objects})
            if id(node) not in parts and (words, distinct, len(objects), named) > best_rank:
                best, best_rank = objects, (words, distinct, len(objects), named)
            stack.extend(node)
    return best


def read_answer(data):
    """An answer as what can be compared: its kind, its lines (one per result or line of the page), and its head (the
    words a door would show)."""
    if data is None or data == "" or data == [] or data == {}:
        return {"kind": "empty", "lines": [], "head": "", "count": 0}
    if isinstance(data, str):
        return {"kind": "page", "lines": [l.strip() for l in data.splitlines() if l.strip()], "head": data[:1500], "count": None}
    if isinstance(data, dict) and "text" in data and "title" in data:
        text = data.get("text") or ""
        lines = [l.strip() for l in text.splitlines() if l.strip()]
        records = largest_records(data.get("state")) if data.get("state") else []
        if len(records) >= 3:
            lines = lines + [record_title(r) for r in records]
        kind = "page" if lines else "empty"  # an app's shell: a title and no words, for any query
        return {"kind": kind, "lines": lines, "head": f"{data.get('title') or ''}\n{text[:1500]}", "count": len(records) if len(records) >= 3 else None}
    records = largest_records(data)
    if records:
        return {"kind": "records", "lines": [record_line(r) or json.dumps(r, sort_keys=True, ensure_ascii=False)[:200] for r in records], "head": json.dumps(data, ensure_ascii=False)[:600], "count": len(records)}
    if isinstance(data, list):
        # Lists of lists with no object in them (Google Maps' `/search?tbm=map`: places as nested arrays): what it says is
        # its strings, one line each. Read as one line it was 200 characters of its first place, and every right answer
        # read as one that names nothing (UNB-165).
        return {"kind": "object", "lines": list(dict.fromkeys(s.strip() for s in strings_in(data) if says_words(s))), "head": json.dumps(data, ensure_ascii=False)[:600], "count": None}
    return {"kind": "object", "lines": [f"{k}: {str(v)[:120]}" for k, v in data.items()] if isinstance(data, dict) else [str(data)[:200]], "head": json.dumps(data, ensure_ascii=False)[:600], "count": None}


def strings_in(value):
    """Every string in `value`, in the order it holds them."""
    if isinstance(value, str):
        yield value
    elif isinstance(value, list):
        for v in value:
            yield from strings_in(v)
    elif isinstance(value, dict):
        for v in value.values():
            yield from strings_in(v)


def door_in(head):
    """What stands in front of the answer, if anything: a door beats any mention of the query, which a door's address
    can carry."""
    plain = normal(head)
    if any(normal(m) in plain for m in CHALLENGE):
        return "blocked", "challenge"
    # Only the title: a site's own menu can say "Select a Country" on a page that is no gate at all (Huawei).
    if any(normal(m) in plain.split("\n", 1)[0] for m in GATE):
        return "blocked", "region_gate"
    if any(normal(m) in plain for m in LOGIN):
        return "requires_account", "login_wall"
    return None


def no_results_in(lines):
    return any(any(normal(p) in normal(l) for p in NO_RESULTS) or ZERO_FOUND.search(l) or EMPTY_LIST.search(l) for l in lines)


def compare(answers, aliases=None):
    """Each answer's own lines: those no other value's answer holds. `answers` maps a step to (value, read_answer)."""
    held = {step: set(a["lines"]) for step, (_, a) in answers.items()}
    out = {}
    for step, (value, answer) in answers.items():
        others = set().union(*[lines for other, lines in held.items() if other != step]) if len(held) > 1 else set()
        own = [l for l in dict.fromkeys(answer["lines"]) if l not in others]
        # A line that says the query back, or an object's line that only holds the request, is no result and names
        # nothing: a tracking envelope's `fullUrl: …?dcity=bjs` and `query: bjs` are the ask, not flights.
        def said(a, l):
            return not is_echo(l, value) and not (a["kind"] == "object" and carries_the_query(l, value))
        results = [l for l in own if said(answer, l)]
        # A hit is a line of the answer that names the value or a word the case says it stands for (`bjs` is Beijing: a
        # flight list names airports, never IATA codes). A line every answer shares names the page, not the query, so
        # the naming only counts where this answer names the value more often than any other does; elsewhere only its
        # own lines count.
        words = (aliases or {}).get(value, ())
        mine = [l for l in dict.fromkeys(answer["lines"]) if said(answer, l) and mentions(l, value, words)]
        def named(a):
            plain = [normal(l) for l in dict.fromkeys(a["lines"]) if said(a, l)]
            return sum(p.count(normal(value)) + sum(p.count(normal(w)) for w in words if w) for p in plain)
        theirs = max((named(a) for other, a in answers.values() if other != step), default=0)
        hits = mine if named(answer) > theirs else [l for l in mine if l in own]
        out[step] = {"own_lines": len(results), "hits": len(hits), "titles": [shorten(l) for l in (hits or results)[:3]], "_own": results}
    return out


def overlap(a, b):
    """How much of two answers is the same, 0 to 1: a recheck of a value should find most of its first answer."""
    first, second = set(a), set(b)
    return len(first & second) / max(1, min(len(first), len(second)))


def judge_check(step, value, read, own, ok, aliases=None):
    """What a check's answer suggests. `own` is its entry from `compare`."""
    door = door_in(read["head"])
    # A short page's footer can say "sign in": a page that says it found nothing is no login wall.
    if door and not (door[0] == "requires_account" and no_results_in(own["_own"])):
        return door[0], door[1]
    if step == "no_results":
        if not ok:
            return "fail", "error_on_no_results"
        if read["kind"] == "empty" or read["count"] == 0 or no_results_in(own["_own"]) or no_results_in(read["lines"]):
            return "pass", None
        if own["own_lines"] <= 2:
            return "pass", "nothing_of_its_own"
        return "ok_but_wrong", "results_for_nonsense"
    if read["kind"] == "empty":
        return "ok_but_wrong", "empty_answer"
    if read["kind"] == "records" and sum(says_words(l) for l in read["lines"]) * 2 < len(read["lines"]):
        return "ok_but_wrong", "records_known_only_by_ids"
    if read["kind"] == "page" and len(read["lines"]) >= LONG_PAGE_LINES and 0 < own["own_lines"] < MIN_OWN_LINES_OF_A_LONG_PAGE:
        return "ok_but_wrong", "only_the_page_frame"
    if own["hits"] >= 2 or (read["kind"] == "records" and own["hits"] >= 1):
        return "pass", None
    if own["own_lines"] == 0:
        return "ok_but_wrong", "same_answer_for_every_value"
    return "ok_but_wrong", "nothing_mentions_the_value"


def judge_site(checks, retried=False, judgments=0, hands=False):
    """A site's outcome from its final checks. Passing is every check right, on one node version."""
    final = {}
    for check in checks:
        final[check["step"]] = check
    outcomes = [c.get("outcome", "not_tested") for c in final.values()]
    if "safety_stop" in outcomes:
        return "safety_stop"
    needed = ("first", "replay", "call_unrelated", "no_results", "recheck")
    if any(o == "blocked" for o in outcomes):
        return "blocked"
    if any(o == "requires_account" for o in outcomes):
        return "requires_account"
    if all(final.get(s, {}).get("outcome") == "pass" for s in needed):
        return "pass_after_judge" if judgments else "pass_after_hands" if hands else "pass_after_retry" if retried else "pass"
    if final.get("no_results", {}).get("outcome") == "false_failure" and all(final.get(s, {}).get("outcome") == "pass" for s in needed if s != "no_results"):
        return "false_failure"
    if "ok_but_wrong" in outcomes or "unstable" in outcomes:
        return "ok_but_wrong"
    return "fail"


def error_category(status, reply):
    """A short name for a failure, from the status and the node's words."""
    words = normal(json.dumps(reply, ensure_ascii=False))[:1500] if reply else ""
    if status in (401,):
        return "agent_key_refused"
    if status == 429 or "too many requests" in words:
        return "rate_limited"
    if status == 0 or "timed out" in words or "timeout" in words:
        return "timeout"
    # A call that needs the page's own code, or a value the page computes, is a route that needs hands: the site is
    # reachable, and the call is the part that isn't browserless. It is not a door, and never a challenge.
    if any(w in words for w in ("needs a browser", "needs hands", "page computes a value")):
        return "needs_hands"
    if any(w in words for w in ("mint unresolved", "challenge", "kept challenging", "verification", "antispider", "captcha")):
        return "challenge"
    if any(w in words for w in (" 403", "refused", "forbidden", "denied", "blocked")):
        return "refused"
    if "no route" in words or "no answer" in words or "answered 200 with nothing" in words:
        return "no_route"
    if "browser" in words:
        return "browser"
    return f"http_{status}" if status else "error"


def tested_domains(run_dir):
    """Every site a past run names. Sites are compared by the words in its results, as earlier files differ in shape."""
    seen = set()
    for path in sorted(Path(run_dir).glob("*.json")):
        seen.update(re.findall(r'"site"\s*:\s*"([^"]+)"', path.read_text()))
    return seen


def pick_sample(sites, tested, reserved, seed, per_category=3):
    """A draw that is not a person's favourites: per category, in an order fixed by the seed, a market not yet drawn
    first, then the next in order. All categories count, whether or not the inventory marks them for search: a
    candidate list is no proof either way."""
    def order(site):
        return hashlib.sha256(f"{seed}:{site['domain']}".encode()).hexdigest()

    by_category = defaultdict(list)
    for site in sites:
        if site["domain"] not in tested and site["domain"] not in reserved:
            by_category[site["category"]].append(site)
    picked, markets = [], set()
    for category in sorted(by_category):
        pool = sorted(by_category[category], key=order)
        chosen = next(([s] for s in pool if s["market"] != "GLOBAL" and s["market"] not in markets), [])
        markets.update(s["market"] for s in chosen)
        chosen += [s for s in pool if s not in chosen][: per_category - len(chosen)]
        picked += chosen
    return picked


class Node:
    """A scratch node's agent API. The owner's node is never one: its port, or any address off this machine, is refused."""

    def __init__(self, base, token, opener=None):
        parts = urllib.parse.urlsplit(base)
        if parts.hostname not in ("127.0.0.1", "localhost", "::1"):
            raise SystemExit(f"{base} isn't this machine: the bank runs against a scratch node")
        if parts.port in (None, OWNER_PORT):
            raise SystemExit(f"{base} is the owner's node: give a scratch node's port")
        self.base = base.rstrip("/")
        self.token = token
        self.opener = opener or urllib.request.urlopen

    def ask(self, method, path, body=None):
        request = urllib.request.Request(
            self.base + path,
            method=method,
            data=None if body is None else json.dumps(body).encode(),
            headers={"Authorization": f"Bearer {self.token}", "Content-Type": "application/json"},
        )
        try:
            with self.opener(request, timeout=WAIT_SECS) as reply:
                return reply.status, json.loads(reply.read() or b"{}")
        except urllib.error.HTTPError as e:
            text = e.read()
            try:
                return e.code, json.loads(text)
            except ValueError:
                return e.code, {"error": text[:300].decode("utf8", "replace")}
        except (TimeoutError, urllib.error.URLError) as e:
            return 0, {"error": f"timeout or no answer: {e}"}

    def routes(self):
        return self.ask("GET", "/v1/routes")[1].get("routes", [])

    def do(self, goal, url):
        status, reply = self.ask("POST", "/v1/do", {"goal": goal, "url": url})
        for _ in range(COLLECTS):
            if not (200 <= status < 300 and isinstance(reply, dict) and reply.get("how") == "working" and reply.get("ask")):
                break
            status, reply = self.ask("POST", "/v1/do", {"ask": reply["ask"], "wait_ms": COLLECT_WAIT_MS})
        return status, reply

    def call(self, route_id, inputs):
        return self.ask("POST", f"/v1/routes/{route_id}/call", {"inputs": inputs})

    def judge(self, route_id, body):
        return self.ask("POST", f"/v1/routes/{route_id}/judge", body)

    def open_link(self, link):
        return self.ask("GET", "/v1/open?q=" + urllib.parse.quote(link, safe=""))


def url_for(case, value, vary=None):
    """The address the ask goes to. `vary` (a case's `vary` field) is the replay ask's value of a second parameter the
    URL carries: a route that wrote that parameter in as a constant cannot be reused for it, and relearns instead."""
    text = value.replace(" ", case["space"]) if case.get("space") else value
    url = case["url"].replace("{q}", urllib.parse.quote(text, safe=case.get("space", "")))
    for param, other in (vary or {}).items():
        url, n = re.subn(rf"([?&]){re.escape(param)}=[^&#]*", lambda m: f"{m.group(1)}{param}={urllib.parse.quote(str(other))}", url)
        if not n:
            url += ("&" if "?" in url else "?") + f"{param}={urllib.parse.quote(str(other))}"
    return url


def as_sent(case, value):
    """A value as the site's own address carries it: a value in a path keeps its dashes (/search/gluten-free-)."""
    if not case.get("space"):
        return value
    after = re.search(r"\{q\}([^/?]*)", case["url"])
    return value.replace(" ", case["space"]) + (after.group(1) if after else "")


def median(values):
    return int(statistics.median(values)) if values else None


def beats_browser(warm_ms, browser_ms):
    """Whether the warm calls beat opening the same page in a browser. None when either side wasn't measured: a
    missing measurement says nothing, it is not a pass."""
    if not warm_ms or browser_ms is None:
        return None
    return median(warm_ms) < browser_ms


def browser_seconds(program, url, run_dir, timeout=90):
    """What opening the page in a real browser costs here: `open` plus `snapshot -i -c`, timed, the same two calls the
    Eden report baselined against, in the run's folders and a session of its own, and closed after. None when the program
    is missing, either call fails, a wall answers (a wall's time says nothing of the page's), or there is no run folder:
    outside one this would be the caller's own default browser session."""
    if not program or not run_dir:
        return None
    env = {"HOME": str(Path(run_dir) / "home"), "TMPDIR": str(Path(run_dir) / "tmp"), "PATH": "/usr/bin:/bin:/usr/sbin:/sbin"}
    session = [program, "--session", "bank_baseline"]
    started = time.monotonic()
    try:
        for args in ([*session, "open", url], [*session, "snapshot", "-i", "-c"]):
            done = subprocess.run(args, capture_output=True, timeout=timeout, text=True, env=env)
            if done.returncode != 0 or door_in(done.stdout):
                return None
        return int((time.monotonic() - started) * 1000)
    except (OSError, subprocess.TimeoutExpired):
        return None
    finally:
        try:
            subprocess.run([*session, "close"], capture_output=True, timeout=30, env=env)
        except (OSError, subprocess.TimeoutExpired):
            pass


def default_browser_program():
    """The agent-browser the bank can time against: the one the shell names, else the build the scratch node uses."""
    found = os.environ.get("BROWSER_PROGRAM")
    if found:
        return found
    root = HERE.parent.parent
    built = Path(os.environ.get("CARGO_TARGET_DIR", root / "unbrowse-browser" / "cli" / "target")) / "debug" / "agent-browser"
    return str(built) if built.exists() else None


def chrome_count(ps_text, roots):
    """How many running processes hold a browser profile under one of this run's folders. The scratch node's walks get
    their profiles from its home and its TMPDIR, so a browser still up with one of those profiles was left behind by a
    walk. `roots` is a path or a list of paths."""
    if not roots:
        return None
    if isinstance(roots, (str, Path)):
        roots = [roots]
    roots = [str(r) for r in roots]
    return sum(1 for line in ps_text.splitlines() if "user-data-dir" in line and any(r in line for r in roots))


def bound_input(route, *values):
    """The input that carries the query: the one whose default is a value this site was asked for."""
    wanted = {normal(v) for v in values} | {normal(v).replace(" ", "+") for v in values} | {normal(urllib.parse.quote(v)) for v in values}
    for spec in route.get("inputs", []):
        default = normal(urllib.parse.unquote_plus(str(spec.get("default") or "")))
        # A value in a path keeps what the site wraps it in: /search/chicken- is `chicken-`.
        if default in wanted or default.strip("-_/ ").replace("-", " ") in wanted:
            return spec["name"]
    return None


def looks_like_a_write(route):
    """A route the node doesn't mark write, but whose method and path say a person should look before it runs again."""
    return route.get("method", "GET").upper() != "GET" and bool(WRITE_WORDS.search(route.get("path", "")))


def step_that_writes(steps):
    """A step of a route that reads as a write: `path` shows only the route's last call, and a route replays them all
    (Pinterest's search POSTs to ActivateExperimentResource/create/ on the way). The node lists them in the route's
    `also_sends`; a route file has them as `url`."""
    for step in steps:
        method = str(step.get("method", "GET")).upper()
        path = step.get("path") or urllib.parse.urlsplit(str(step.get("url", ""))).path
        if method != "GET" and WRITE_WORDS.search(path):
            return f"{method} {path}"
    return None


def first_party(route, site):
    host = (route.get("site") or "").lower()
    core = site.lower().removeprefix("www.")
    return host == core or host.endswith("." + core) or core.endswith("." + host)


def strip_query(url):
    parts = urllib.parse.urlsplit(url)
    return f"{parts.scheme}://{parts.netloc}{parts.path}"


def same_page(route_path, walked_url, value):
    """Whether a stored route asks for the walked page itself: the same path, once the route's `{placeholders}` and
    the value the caller typed stand in for each other, and carrying no query key the walked page didn't. A data call
    fails either way: its path is its own (`/aps/cf/1.0/...`) or it adds a key the page never sent (`pb`, `ajax`).
    None when there is no route to compare."""
    if not route_path:
        return None
    route = urllib.parse.urlsplit(route_path)
    walked = urllib.parse.urlsplit(walked_url)
    route_path_segs, walked_path_segs = route.path.split("/"), walked.path.split("/")
    if len(route_path_segs) != len(walked_path_segs):
        return False
    for r, w in zip(route_path_segs, walked_path_segs):
        if r != w and not (r.startswith("{") or w == value or value in w):
            return False
    page_keys = {k for k, _ in urllib.parse.parse_qsl(walked.query, keep_blank_values=True)}
    route_keys = {k for k, _ in urllib.parse.parse_qsl(route.query, keep_blank_values=True)}
    return route_keys <= page_keys


def price_marks(data):
    """How many prices an answer shows, wherever they sit: in its text, or a field named for one."""
    # json writes a line break as \\n, and that n would stick to the word after it: "\\nSGD 215" has no word boundary.
    return len(MONEY.findall(json.dumps(data, ensure_ascii=False)[:2_000_000].replace("\\n", " "))) if data else 0


def speed_finding(warm_ms, browser_ms, right=True):
    """Finding: a warm call is meaningfully faster than a browser, at most WARM_SHARE_OF_BROWSER of its time. Slow is slow
    whatever it answered; fast counts only for right answers, since a route answering a tracking id is fast for nothing."""
    if len(warm_ms) < MIN_WARM_CALLS:
        return {"outcome": "not_run", "why": "fewer_than_two_answered_warm_calls", "warm_ms": warm_ms}
    if not browser_ms:
        return {"outcome": "not_run", "why": "no_browser_time", "warm_ms": warm_ms}
    share = round(median(warm_ms) / browser_ms, 2)
    said = {"warm_median_ms": median(warm_ms), "browser_ms": browser_ms, "share": share}
    if share > WARM_SHARE_OF_BROWSER:
        return dict(said, outcome="fail", why="not_half_a_browser")
    return dict(said, outcome="pass", why=None) if right else dict(said, outcome="not_run", why="fast_but_wrong")


def goal_picks(entries):
    """The decision model's picks in a model log's lines, oldest first: the row each choice named, as the model saw it."""
    picks = []
    for entry in entries:
        question = (entry["request"].get("questions") or {}).get("goal") or {}
        answer = (entry.get("answers") or {}).get("goal") or {}
        if question.get("type") == "choice" and answer.get("choice") is not None:
            rows = entry["request"].get("state", {}).get("exchanges") or []
            row = next((r for r in rows if str(r.get("index")) == str(answer["choice"])), None)
            if row:
                picks.append({"row": row, "probability": (answer.get("probabilities") or {}).get(answer["choice"]), "confidence": answer.get("confidence")})
    return picks


def offered_rows(entries):
    """Every call the model was shown, once each."""
    rows = {}
    for entry in entries:
        for row in entry["request"].get("state", {}).get("exchanges") or []:
            rows.setdefault((row.get("method"), row.get("path")), row)
    return list(rows.values())


def is_data_row(row):
    """A call that could be the search's answer: data, and either it says back what was asked, holds the goal's own words,
    or lists records. A page's config or device check is JSON too (`/websiteconfig`, `/device`), and is no data call for it."""
    mime = row.get("mime") or ""
    if row.get("resource_type") == "Document" or "html" in mime or not ("json" in mime or "event-stream" in mime):
        return False
    return bool(row.get("says_back") or row.get("holds") or (row.get("records") or 0) >= MIN_RECORDS or row.get("json_events"))


def data_route_finding(route, is_page, offered, walked_calls):
    """Finding: a route stored as the results page when the walk had a data call for it. What counts as having had one is
    what the model was shown, else what the walk's capture holds."""
    if not route:
        return {"outcome": "not_run", "why": "no_route"}
    if not is_page:
        return {"outcome": "pass", "why": None, "stored": route_said(route)}
    data = [f"{r.get('method')} {r.get('path')}" for r in offered if is_data_row(r)] or [f"{c['method']} {c['path']}" for c in walked_calls if is_data_row(c)]
    if data:
        return {"outcome": "fail", "why": "page_stored_where_a_data_call_existed", "stored": route_said(route), "data_calls": [shorten_path(d) for d in data[:3]]}
    # Only the capture can clear a page: the model is shown what passed the node's filter, not what the walk held.
    if not walked_calls:
        return {"outcome": "not_run", "why": "page_stored_and_nothing_known_of_the_walk", "stored": route_said(route)}
    # And it says a call sent data and nothing of what that held, so a call that could carry data leaves it open.
    if any(UNREAD_DATA.search(c.get("mime") or "") and c.get("resource_type") != "Document" for c in walked_calls):
        return {"outcome": "not_run", "why": "a_data_call_nothing_could_read", "stored": route_said(route)}
    return {"outcome": "pass", "why": "page_stored_and_no_data_call_seen", "stored": route_said(route)}


def route_said(route):
    return shorten_path(f"{route.get('method')} {route.get('path')}")


def shorten_path(text):
    return str(text)[:120]


def query_keys(path):
    return {k for k, _ in urllib.parse.parse_qsl(urllib.parse.urlsplit(path).query, keep_blank_values=True)}


def same_call_shape(route_path, picked_path):
    """Whether a stored route's path is the picked call's, with the route's placeholders standing for any piece."""
    route_segs = urllib.parse.urlsplit(route_path).path.rstrip("/").split("/")
    picked_segs = urllib.parse.urlsplit(picked_path).path.rstrip("/").split("/")
    return len(route_segs) == len(picked_segs) and all(r == p or "{" in r for r, p in zip(route_segs, picked_segs))


def keeps_pick_finding(route, picked_by, pick, steps, values):
    """Finding: the stored route is the call the model picked. `pick` is the model's last choice, the row it saw; `steps`
    is the route's file, which alone shows a POST's body. Only a pick the node says it used is held against the route."""
    if not route:
        return {"outcome": "not_run", "why": "no_route"}
    if picked_by != "the decision model" or not pick:
        return {"outcome": "not_run", "why": f"picked_by: {picked_by}" if picked_by else "no_learn_seen"}
    row = pick["row"]
    said = {"picked": shorten_path(f"{row.get('method')} {row.get('path')}"), "stored": route_said(route)}
    if (route.get("method") or "").upper() != (row.get("method") or "").upper() or not same_call_shape(route.get("path") or "", row.get("path") or ""):
        return dict(said, outcome="fail", why="stored_a_different_call")
    lost = sorted(query_keys(row.get("path") or "") - query_keys(route.get("path") or "") - {i.get("name") for i in route.get("inputs", [])})
    if lost:
        return dict(said, outcome="fail", why="lost_query_keys", lost=lost)
    if not steps and (route.get("method") or "").upper() != "GET":
        return dict(said, outcome="not_run", why="no_route_file_to_read_its_body")
    body = json.dumps((steps[-1].get("body") if steps else None) or {}, ensure_ascii=False)
    fixed = [v for v in values if normal(v) in normal(body)]
    if fixed:
        return dict(said, outcome="fail", why="value_fixed_in_the_body", fixed=fixed)
    return dict(said, outcome="pass", why=None)


def sse_finding(walked_calls, offered, model_asked):
    """Finding: an event stream the walk saw reaches the model as a candidate. Nothing to say of a walk that had none."""
    streams = [c for c in walked_calls if "event-stream" in (c.get("mime") or "") and c.get("json_events")]  # a ping is owed nothing
    if not streams:
        return {"outcome": "not_run", "why": "no_event_stream_in_the_walk"}
    if not model_asked:
        return {"outcome": "not_run", "why": "the_model_was_not_asked", "streams": [shorten_path(c["path"]) for c in streams[:3]]}
    shown = {urllib.parse.urlsplit(r.get("path") or "").path for r in offered}
    left_out = [c["path"] for c in streams if urllib.parse.urlsplit(c["path"]).path not in shown]
    return {"outcome": "fail" if left_out else "pass", "why": "stream_never_a_candidate" if left_out else None, "streams": [shorten_path(c["path"]) for c in streams[:3]]}


def fixed_short_values(route_path, walked_url):
    """Query values of one character the walked page was asked for and the stored route wrote in: `adults=2`."""
    asked = dict(urllib.parse.parse_qsl(urllib.parse.urlsplit(walked_url).query, keep_blank_values=True))
    stored = dict(urllib.parse.parse_qsl(urllib.parse.urlsplit(route_path or "").query, keep_blank_values=True))
    return sorted(k for k, v in asked.items() if len(v) == 1 and k in stored and "{" not in stored[k])


def short_values_finding(route, walked_url):
    """Finding: a one-character query value stays an input. Nothing to say of a URL that has none."""
    if not route:
        return {"outcome": "not_run", "why": "no_route"}
    if not any(len(v) == 1 for _, v in urllib.parse.parse_qsl(urllib.parse.urlsplit(walked_url).query)):
        return {"outcome": "not_run", "why": "no_short_value_in_the_url"}
    fixed = fixed_short_values(route.get("path"), walked_url)
    if fixed:
        return {"outcome": "fail", "why": "short_value_fixed", "fixed": fixed}
    # A key the route doesn't carry at all (a data call of its own) says nothing of whether it could take the value.
    stored = dict(urllib.parse.parse_qsl(urllib.parse.urlsplit(route.get("path") or "").query, keep_blank_values=True))
    short = [k for k, v in urllib.parse.parse_qsl(urllib.parse.urlsplit(walked_url).query) if len(v) == 1]
    if all("{" in stored.get(k, "") for k in short):
        return {"outcome": "pass", "why": None}
    return {"outcome": "not_run", "why": "short_value_not_in_the_route", "absent": sorted(k for k in short if k not in stored)}


def call_key(route):
    """A route as its call: method, path, query keys. Two with the same key are copies, whatever their values."""
    parts = urllib.parse.urlsplit(route.get("path") or "")
    return (route.get("method"), parts.path, tuple(sorted(query_keys(route.get("path") or ""))))


def inputs_finding(route, bound, routes_added):
    """Finding: a route is stored with the input its query needs, once: not `inputs: []` and a copy per query."""
    if not route:
        return {"outcome": "not_run", "why": "no_route"}
    copies = Counter(call_key(r) for r in routes_added)
    most = max(copies.values(), default=0)
    said = {"routes_added": len(routes_added), "inputs": [i.get("name") for i in route.get("inputs", [])]}
    if not route.get("inputs"):
        return dict(said, outcome="fail", why="stored_with_no_inputs")
    if not bound:
        return dict(said, outcome="fail", why="no_input_carries_the_query")
    if most > 1 or len(routes_added) > 1:
        return dict(said, outcome="fail", why="copies_piled_up", copies=most)
    return dict(said, outcome="pass", why=None)


def fallback_finding(model_requests, log_added, picked_by):
    """Finding: a reply the node can't read (no `type`) is said, not swallowed. Takes the stub model's request count, the
    node log's lines since, and what the reply said picked."""
    if not model_requests:
        return {"outcome": "not_run", "why": "the_model_was_not_asked"}
    said = any("no answer, so the rule decides" in line for line in log_added)
    if not said:
        return {"outcome": "fail", "why": "silent_fallback", "picked_by": picked_by}
    if picked_by == "the decision model":
        return {"outcome": "fail", "why": "credits_a_model_that_gave_no_answer", "picked_by": picked_by}
    return {"outcome": "pass", "why": None, "picked_by": picked_by}


def correct_finding(checks, prefix=""):
    """Finding: the answers are the search's own results. Whether the route was reused or kept its input has a finding of
    its own, so a right answer from a relearned route is still right."""
    elsewhere = ("replay_was_not_a_call_of_the_same_route", "no_bound_input")
    read = [c for c in checks if c["step"].removeprefix(prefix) in ("first", "replay", "call_unrelated")]
    if not read:
        return {"outcome": "not_run", "why": "no_answer_read"}
    if any(c.get("outcome") in ("blocked", "requires_account") for c in read):
        return {"outcome": "blocked", "why": next(c.get("why") for c in read if c.get("outcome") in ("blocked", "requires_account"))}
    wrong = {c["step"]: c.get("why") or c.get("outcome") for c in read if c.get("outcome") != "pass" and c.get("why") not in elsewhere}
    return {"outcome": "fail", "why": wrong} if wrong else {"outcome": "pass", "why": None}


def node_tree(ps_text, node_pid, roots):
    """What a scratch node holds now, from `ps -ww -Ao pid=,ppid=,rss=,args=`: its own RSS, and its descendants plus any
    browser with a profile under the run's folders (a browser outlives the process that launched it)."""
    table = []
    for line in ps_text.splitlines():
        cells = line.split(None, 3)
        if len(cells) == 4 and cells[0].isdigit() and cells[1].isdigit() and cells[2].isdigit():
            table.append((int(cells[0]), int(cells[1]), int(cells[2]), cells[3]))
    kin, grew = {node_pid}, True
    while grew:
        grew = False
        for pid, ppid, _, _ in table:
            if ppid in kin and pid not in kin:
                kin.add(pid)
                grew = True
    roots = [str(r) for r in roots]
    left = [row for row in table if row[0] != node_pid and (row[0] in kin or ("user-data-dir" in row[3] and any(r in row[3] for r in roots)))]
    mine = next((row for row in table if row[0] == node_pid), None)
    return {"node_rss_mb": mine[2] // 1024 if mine else None, "processes_left": len(left), "left_rss_mb": sum(row[2] for row in left) // 1024}


def resources_finding(tree):
    """Finding: memory stays bounded. The thresholds are MAX_NODE_RSS_MB and MAX_PROCESSES_LEFT."""
    if not tree or tree.get("node_rss_mb") is None:
        return {"outcome": "not_run", "why": "no_node_to_measure"}
    over = [w for w, bad in (("rss", tree["node_rss_mb"] > MAX_NODE_RSS_MB), ("processes", tree["processes_left"] > MAX_PROCESSES_LEFT)) if bad]
    return dict(tree, outcome="fail" if over else "pass", why=over or None, max_rss_mb=MAX_NODE_RSS_MB, max_processes=MAX_PROCESSES_LEFT)


def calls_in_capture(text):
    """A walk's capture as its calls, a `request` and a `response` line joined by `requestId`: method, the query's names
    (never its values), and the kind of answer."""
    methods, calls = {}, []
    for line in text.splitlines():
        try:
            item = json.loads(line)
        except ValueError:
            continue
        if not isinstance(item, dict):
            continue
        if item.get("type") == "request":
            methods[item.get("requestId")] = (item.get("method"), item.get("resourceType"))
        elif item.get("type") == "response" and item.get("url"):
            url = urllib.parse.urlsplit(item["url"])
            names = sorted(query_keys(item["url"]))
            method, kind = methods.get(item.get("requestId"), ("GET", None))
            calls.append({"method": method, "path": url.path + ("?" + "&".join(names) if names else ""), "mime": item.get("mimeType") or "", "resource_type": kind, "status": item.get("status"), "json_events": bool(JSON_EVENT.search(str(item.get("body") or "")))})
    return calls


class Files:
    """What the node leaves behind when it acts, to show that opening a link left nothing."""

    def __init__(self, node_home=None, node_log=None, guard_log=None, model_log=None):
        self.model_log = Path(model_log) if model_log else None
        self.activity = Path(node_home) / "activity.jsonl" if node_home else None
        self.node_log = Path(node_log) if node_log else None
        self.guard_log = Path(guard_log) if guard_log else None
        self.routes = Path(node_home) / "routes" if node_home else None
        self.home = Path(node_home) if node_home else None

    def steps(self, route_id):
        """A route's steps, as a scratch node keeps them. The agent API shows only its last call."""
        file = self.routes / f"{route_id}.json" if self.routes else None
        if not file or not file.exists():
            return []
        return (json.loads(file.read_text()).get("graph") or {}).get("steps") or []

    def model_lines(self):
        """The stand-in decision model's log, every line: what it was asked and what it said."""
        if not self.model_log or not self.model_log.exists():
            return []
        lines = [line for line in self.model_log.read_text(errors="replace").splitlines() if line.strip()]
        read = []
        for n, line in enumerate(lines):
            try:
                read.append(json.loads(line))
            except ValueError:
                if n < len(lines) - 1:  # the last may still be being written, and is read next time; any other is damage
                    raise
        return read

    def guard_lines(self):
        return self.guard_log.read_text(errors="replace").splitlines() if self.guard_log and self.guard_log.exists() else []

    def node_log_lines(self):
        return self.node_log.read_text(errors="replace").splitlines() if self.node_log and self.node_log.exists() else []

    def run_dir(self):
        return self.home.parent.parent if self.home else None  # scratch-node.sh: <dir>/home/node

    def walked_calls(self, since):
        """The calls of the walks finished since a time, from their captures: method, path and the kind of answer, read
        where they lie. A capture holds cookies and tokens, so nothing else of it is kept."""
        folder = self.run_dir() / "tmp" / "unbrowse-node-walks" if self.home else None
        if not folder or not folder.exists():
            return []
        calls = {}
        for file in folder.glob("learn_*.jsonl"):
            if file.stat().st_mtime < since:
                continue
            for call in calls_in_capture(file.read_text(errors="replace")):
                calls.setdefault((call["method"], call["path"]), call)
        return list(calls.values())

    def tree(self):
        pid_file = self.run_dir() / "node.pid" if self.home else None
        if not pid_file or not pid_file.exists():
            return None
        try:
            done = subprocess.run(["ps", "-ww", "-Ao", "pid=,ppid=,rss=,args="], capture_output=True, text=True, timeout=20)
        except (OSError, subprocess.TimeoutExpired):
            return None
        return node_tree(done.stdout, int(pid_file.read_text().strip()), [self.home, self.run_dir() / "tmp"])

    def chrome_left(self):
        """Live browsers holding a profile this run owns, now. A walk's browser goes with its walk, so one still up
        after the walk that opened it was left behind: the Eden report's 88 processes. None when there is no run
        folder to own a profile under, which says nothing rather than zero."""
        if not self.home:
            return None
        roots = [str(self.home)]
        tmp = self.home.parent.parent / "tmp"  # scratch-node.sh: <dir>/home/node and <dir>/tmp
        if tmp.exists():
            roots.append(str(tmp))
        try:
            done = subprocess.run(["ps", "-ww", "-Ao", "args="], capture_output=True, text=True, timeout=20)
        except (OSError, subprocess.TimeoutExpired):
            return None
        return chrome_count(done.stdout, roots)

    def counts(self):
        def lines(path, word=None):
            if not path or not path.exists():
                return None
            text = path.read_text(errors="replace").splitlines()
            return len(text) if word is None else sum(word in l for l in text)

        return {"activity": lines(self.activity), "calls": lines(self.node_log, 'call {"id"'), "browsers": lines(self.guard_log, "chrome_headless_launch"), "refused": lines(self.guard_log, "REFUSED_")}


def check_links(node, domain, files, wait=1.0):
    """unbrowse_open on the site's link: it shows the site, leaves nothing behind and refuses what a link can't be."""
    before = files.counts()
    status, reply = node.open_link(f"unbrowse://{domain}")
    time.sleep(wait)
    after = files.counts()
    routes = reply.get("routes") or []
    expected_link = f"unbrowse://{domain}"
    check = {
        "status": status,
        "link_echoed": reply.get("link") == expected_link or (reply.get("site") or "\0") in domain,
        "refused_why": shorten(reply.get("error") or "") if status != 200 else None,
        "routes": len(routes),
        "unavailable": bool(reply.get("unavailable")),
        "says_nothing_paid": "Nothing was called or paid" in str(reply.get("next")),
        "activity_added": None if after["activity"] is None else after["activity"] - before["activity"],
        "calls_added": None if after["calls"] is None else after["calls"] - before["calls"],
        "browsers_added": None if after["browsers"] is None else after["browsers"] - before["browsers"],
        "paid": reply.get("paid_usdc"),
    }
    forms = {}
    for name, form in SOUND_LINKS:
        forms[name] = node.open_link(form.format(s=domain, u=domain.upper()))[0]
    accepted = []
    for name, form in MALFORMED_LINKS:
        got = node.open_link(form.format(s=domain))[0]
        if got != 400:
            accepted.append(f"{name}:{got}")
    check["sound_forms"] = forms
    check["malformed_tried"] = len(MALFORMED_LINKS)
    check["malformed_not_refused"] = accepted
    check["outcome"] = "pass" if (status == 200 and check["says_nothing_paid"] and not accepted and all(v == 200 for v in forms.values()) and not check["calls_added"] and not check["browsers_added"] and not check["activity_added"]) else "fail"
    return check


def check_odd_links(node):
    out = []
    for name, link, want in ODD_LINKS:
        status, reply = node.open_link(link)
        out.append({"name": name, "link": link, "expected": want, "status": status, "named_site": reply.get("site")})
    return out


def browserless_finding(warm_checks):
    """Whether the warm calls answered with no browser. A route that answers only through the node's browser reads
    right and costs a page visit a call: it is not the route the bank is here to find, whatever its other checks say.
    A node that doesn't say (an older one) leaves this not run."""
    told = [c for c in warm_checks if c.get("result_ok") is True and c.get("browser") is not None]
    if not told:
        return {"outcome": "not_run", "why": "no_answered_warm_call_said"}
    used = [c["step"] for c in told if c["browser"] is True]
    if used:
        return {"outcome": "fail", "why": "the_browser_ran_" + "_".join(used)}
    return {"outcome": "pass", "why": None}


def reads_on_finding(offered, asked, ok, first_lines, next_lines, browser=None):
    """Whether a search reads on to its next page (`public.pagination` in scenarios.json): the route's answer offered
    a way on, the call for it answered, and what it lists is not the first page again.

    A route that offers no way on is not run: a search may fit on one page, and the bank's words don't say which do.
    A next page that is the first one over again is the repeated-page loop the scenario names, and fails; so does one
    that lists nothing, or that only the node's browser could fetch. The first page again is told by how few lines
    of its own the next one has, not by how much the two share."""
    if not offered:
        return {"outcome": "not_run", "why": "the_route_offered_no_next_page"}
    if not asked:
        return {"outcome": "not_run", "why": "the_site_stopped_before_it_was_asked"}
    if not ok:
        return {"outcome": "fail", "why": "the_call_for_the_next_page_failed"}
    if not next_lines:
        return {"outcome": "fail", "why": "the_next_page_lists_nothing"}
    # A page's frame is the same on every page of it (a results page may carry hundreds of lines of filters), so how
    # much the two share says little. A next page has lines of its own; the first page over again has almost none.
    own = set(next_lines) - set(first_lines)
    if first_lines and len(own) < max(3, len(set(next_lines)) // 50):
        return {"outcome": "fail", "why": "the_next_page_is_the_first_again"}
    if browser is True:
        return {"outcome": "fail", "why": "the_browser_ran_the_next_page"}
    return {"outcome": "pass", "why": None}


NOT_PAGES = (".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp", ".css", ".js", ".ico", ".pdf", ".zip", ".mp4", ".woff", ".woff2")


def link_to_follow(data, site, asked_url):
    """One link of an answer to follow (`public.navigation`): the first address it holds on the site's own hosts that
    is a page and not the page that was asked. An answer's links are what a reader of it would go to next: a result,
    a document, a product. None when the answer holds no such address."""
    core = site.lower().removeprefix("www.")
    asked = urllib.parse.urlsplit(asked_url)
    found = []

    def walk(value, depth=0):
        if depth > 8 or len(found) >= 40:
            return
        if isinstance(value, dict):
            for v in value.values():
                walk(v, depth + 1)
        elif isinstance(value, list):
            for v in value[:60]:
                walk(v, depth + 1)
        elif isinstance(value, str) and value.startswith(("http://", "https://")) and " " not in value and len(value) < 400:
            found.append(value)

    walk(data)
    for link in found:
        parts = urllib.parse.urlsplit(link)
        host = (parts.hostname or "").lower()
        if not (host == core or host.endswith("." + core)):
            continue
        if parts.path in ("", "/") or parts.path.lower().endswith(NOT_PAGES) or parts.path == asked.path:
            continue
        return link
    return None


def follows_a_link_finding(link, asked, status, ok, lines, route_host, site, error=""):
    """Whether one link of the site's own, found in an answer, could be followed (`public.navigation` in
    scenarios.json): it resolved to something readable, on the site.

    An answer with no link of the site's own is not run. A link that leads off the site, or to nothing readable,
    fails; one the site meets with a wall is blocked, classified and not held against the route."""
    if not link:
        return {"outcome": "not_run", "why": "the_answer_held_no_link_of_the_sites_own"}
    if not asked:
        return {"outcome": "not_run", "why": "the_site_stopped_before_it_was_asked"}
    said = (error or "").lower()
    if any(w in said for w in ("asks for a person", "wall", "challenge", "refused the page", "403", "429")):
        return {"outcome": "blocked", "why": "the_site_met_the_link_with_a_wall"}
    if not ok:
        return {"outcome": "fail", "why": "the_link_did_not_resolve"}
    core = site.lower().removeprefix("www.")
    host = (route_host or "").lower()
    if host and not (host == core or host.endswith("." + core) or core.endswith("." + host)):
        return {"outcome": "fail", "why": "the_link_left_the_site"}
    if not lines:
        return {"outcome": "fail", "why": "the_link_led_to_nothing_readable"}
    return {"outcome": "pass", "why": None}


def record_step(step, value, status, reply, route, kept):
    """One check's metadata. A do's reply holds a call's result under `result`; a call's reply is the result."""
    result = reply.get("result") if isinstance(reply.get("result"), dict) else (reply if "ok" in reply else {})
    check = {
        "step": step,
        "value": value,
        "status": status,
        "how": reply.get("how"),
        "route_id": route.get("id") if route else None,
        "method": route.get("method") if route else None,
        "path": route.get("path") if route else None,
        "route_host": route.get("site") if route else None,
        "inputs": [i.get("name") for i in route.get("inputs", [])] if route else None,
        "write": route.get("write") if route else None,
        "picked_by": reply.get("picked_by"),
        "result_ok": result.get("ok"),
        "error": shorten_error(result.get("error") or reply.get("error") or reply.get("why") or "") or None,
        "ignored_inputs": result.get("ignored_inputs") or [],
        "paid_usdc": result.get("paid_usdc"),
        "truncated": bool(result.get("truncated")),
        "fields_more": (result.get("fields") or {}).get("more_total"),
        "route_failed": bool(reply.get("route_failed")),
        # Whether the node's browser ran any step of the call: an answer that needed it is not a browserless one,
        # however right it reads.
        "browser": result.get("browser"),
    }
    read = read_answer(result.get("data"))
    read["prices"] = price_marks(result.get("data"))
    kept[step] = (value, read)
    return check


def saw_a_door(log_lines):
    """The line of the node's log that says a site put up a bot check, whether or not the node then got through, or None:
    a walk's main page refused (403, 429, 503), a main page answered 202 for its script to reload (Booking's), a call to a
    challenge's own address, a walk that ended at one, or a route's call refused or sent to a wall. A redirect to another
    of the site's hosts (`.com` to `.sg`) marks a walk's gate too, and is no wall.

    A challenge's address counts for a call that did something, by the node's own `sort_of`: one answering data, a gate,
    or one that sent something (not a GET). A page fetched by GET counts on the host the walk landed on (its first page or
    gate), where it is the site's own wall (`/splashui/challenge`); on another host it is a frame the page embeds, as a
    results page embeds a sign-in form's captcha. An asset, a script or a picture, never counts."""
    landed = {}
    for line in log_lines:
        if line.startswith("eye "):
            if "mint unresolved (" in line or "kept challenging" in line:
                return line
            try:
                seen = json.loads(line[4:])
            except ValueError:
                continue
            if seen.get("kind") != "seen":
                continue
            sort, method = seen.get("sort"), seen.get("method", "GET")
            if sort in ("page", "gate"):
                landed.setdefault(seen.get("walk"), seen.get("host"))
            challenge = bool(DOOR_PATH.search(str(seen.get("path"))))
            did_something = sort not in ("asset", "page") or method != "GET"
            on_site_page = sort == "page" and seen.get("host") == landed.get(seen.get("walk"))
            if (sort == "gate" and seen.get("status") in REFUSED) or (sort == "page" and seen.get("status") == 202) or (challenge and (did_something or on_site_page)):
                return line
        elif "[call] failed before any heal" in line and CALL_WALLED.search(line):
            return line
    return None


def door_said(line):
    """A door's line, short, for the record: an eye line's call (method, host, path, status, sort), else its first words."""
    try:
        seen = json.loads(line[4:]) if line.startswith("eye ") else None
    except ValueError:
        seen = None
    if isinstance(seen, dict) and seen.get("kind") == "seen":
        return f"{seen.get('method')} {seen.get('host')}{str(seen.get('path'))[:80]} {seen.get('status')} {seen.get('sort')}"
    return " ".join(str(line).split())[:120]


def held_a_clean_browser(guard_lines):
    """Whether the run's guard held a clean browser: the node asked a site again after it refused, which only a door makes
    it do, whatever the node's log says of it."""
    return any(line.startswith("HELD_CLEAN") for line in guard_lines)


def door_stops(step, read):
    """Whether what answered is a wall to stop at. A short page's footer can say "sign in" where nothing was found."""
    door = door_in(read["head"])
    return bool(door) and not (step == "no_results" and door[0] == "requires_account")


def run_site(node, case, nonsense, files, samples=None, after_judge=False, gap=GAP_SECS, browser_program=None, one_ask=False):
    """The plan's steps for one site. It stops at a write, at a rate limit and at the call budget.

    Every ask is timed: a warm call (a call to the route the first ask stored) is the whole point of learning one, so
    its seconds are kept beside its answer. `browser_program` times the same URL in a real browser once, which is what
    a warm call has to beat to have been worth learning."""
    site, goal, values = case["site"], case["goal"], case["values"]
    # What a case's values stand for, when an answer never says them itself (`bjs` is Beijing: a flight list names
    # airports and never IATA codes). A case may say so with `aliases`; without it the value must be said.
    aliases = {k: list(v) for k, v in (case.get("aliases") or {}).items()}
    prefix = "after_judge_" if after_judge else ""
    checks, kept, calls, errors = [], {}, [0], {}
    retried = False

    def do(step, value):
        nonlocal retried
        refused = files.counts()["refused"]
        log_before, guard_before = len(files.node_log_lines()), len(files.guard_lines())
        url = url_for(case, value, case.get("vary") if step == "replay" else None)
        started = time.monotonic()
        status, reply = node.do(goal, url)
        calls[0] += 1
        if status == 0 and not one_ask:  # the timeout may be a wall: the log is read before anything is asked again
            retried = True
            time.sleep(gap)
            started = time.monotonic()
            status, reply = node.do(goal, url)
            calls[0] += 1
        took = int((time.monotonic() - started) * 1000)
        route = reply.get("route") if isinstance(reply.get("route"), dict) else None
        check = record_step(step, value, status, reply, route, kept)
        check["ms"] = took
        errors[step] = str((reply.get("result") or {}).get("error") or reply.get("error") or reply.get("why") or "")
        # The node asked for a window and the run's guard refused it: the site refused the walk twice, and what a
        # window would have done is unknown. The error it comes back with (Chrome exited) is the guard's, not the node's.
        now = files.counts()["refused"]
        check["window_refused"] = bool(refused is not None and now and now > refused)
        said = files.node_log_lines()[log_before:]
        check["healed"] = any("[heal]" in l for l in said)
        door = saw_a_door(said) or (held_a_clean_browser(files.guard_lines()[guard_before:]) and "HELD_CLEAN")
        if one_ask and door:
            check["outcome"], check["why"], check["door"] = "blocked", "the_walk_met_a_door", door_said(door)
        checks.append(check)
        return status, reply, route, check

    preexisting = [r for r in node.routes() if first_party(r, site)]
    chrome_before = files.chrome_left()
    began, model_seen, log_seen = time.time(), len(files.model_lines()), len(files.node_log_lines())
    site_result = {
        "site": site, "goal": goal, "url": strip_query(case["url"]), "values": values + [nonsense], "category": case.get("category"), "market": case.get("market"),
        "retest": bool(case.get("retest")), "url_source": case.get("url_source", "known"),
        "phase": "after_judge" if after_judge else ("preexisting" if preexisting else "fresh"),
    }
    route = None
    stop = None
    offered_next = None
    link = None
    for step, value in (("first", values[0]), ("replay", values[1])):
        status, reply, got, check = do(step, value)
        route = got or route
        if check.get("outcome") == "blocked":
            stop = "blocked"
            break
        if one_ask and status == 0:  # no answer may be a wall the log didn't name: nothing more is asked of the site
            stop = "timeout"
            break
        if got and got.get("write"):
            stop = "safety_stop"
            check["outcome"] = "safety_stop"
            break
        held = got and (looks_like_a_write(got) and f"{got.get('method')} {got.get('path')}" or step_that_writes(got.get("also_sends") or files.steps(got.get("id"))))
        if held:
            stop = "safety_stop"
            check["outcome"] = "safety_stop"
            check["note"] = f"not marked write, but this step reads as one: {shorten(held)}. Held for a person"
            break
        if status == 429 or error_category(status, reply) == "rate_limited":
            stop = "rate_limited"
            break
        result = reply.get("result") if isinstance(reply.get("result"), dict) else {}
        if result.get("ok") is False and error_category(status, {"e": result.get("error")}) in ("refused", "challenge"):
            stop = "blocked"  # nothing is retried past a block
            break
        # A walk that ended at the door, or a wall that came back as an answer: the site showed one, so the run moves on.
        if door_stops(step, kept[step][1]) or (reply.get("how") == "browse" and error_category(status, {"why": errors[step]}) in ("refused", "challenge")):
            stop = "blocked"
            break
        time.sleep(gap)

    input_name = bound_input(route, values[0], values[1]) if route else None
    site_result["bound_input"] = input_name
    site_result["route_first_party"] = first_party(route, site) if route else None
    # Whether the stored route is the walked page itself rather than a data call: the Eden report's reason warm calls
    # bought nothing (8 of 9 routes were the results page). Recorded, not judged: a page route can still answer right.
    site_result["route_is_page"] = same_page(route.get("path") if route else None, url_for(case, values[0]), values[0])
    if route and not stop and input_name:  # a site stopped at the door gets no more calls
        for step, value in (("call_unrelated", values[2]), ("no_results", nonsense), ("recheck", values[0])):
            if calls[0] >= MAX_CALLS_PER_SITE:
                stop = "call_budget"
                break
            log_before, guard_before = len(files.node_log_lines()), len(files.guard_lines())
            started = time.monotonic()
            status, reply = node.call(route["id"], {input_name: as_sent(case, value)})
            calls[0] += 1
            check = record_step(step, value, status, reply, route, kept)
            check["ms"] = int((time.monotonic() - started) * 1000)
            errors[step] = str(reply.get("error") or "")
            if step == "call_unrelated" and isinstance(reply.get("more"), dict) and reply.get("ok") is True:
                offered_next = dict(reply["more"])  # the way on this answer offers: public.pagination follows it
            if step == "call_unrelated" and reply.get("ok") is True:
                link = link_to_follow(reply.get("data"), site, url_for(case, value))  # public.navigation follows it
            said = files.node_log_lines()[log_before:]
            check["healed"] = any("[heal]" in l for l in said)
            checks.append(check)
            door = saw_a_door(said) or (held_a_clean_browser(files.guard_lines()[guard_before:]) and "HELD_CLEAN")
            if one_ask and door:
                check["outcome"], check["why"], check["door"] = "blocked", "the_call_met_a_door", door_said(door)
                stop = "blocked"
                break
            if one_ask and status == 0:
                stop = "timeout"
                break
            if status == 429 or error_category(status, reply) == "rate_limited":
                stop = "rate_limited"
                break
            if (reply.get("ok") is False and error_category(status, reply) in ("refused", "challenge")) or door_stops(step, kept[step][1]):
                stop = "blocked"  # nothing is retried past a block
                break
            time.sleep(gap)

    # public.pagination: the next page of the last real search, by the way on its own answer offered. One call, kept
    # apart from the search's own checks: a search is right or wrong whether or not it reads on.
    next_page = {"offered": offered_next, "asked": False}
    if route and not stop and input_name and offered_next and calls[0] < MAX_CALLS_PER_SITE:
        time.sleep(gap)
        started = time.monotonic()
        status, reply = node.call(route["id"], {input_name: as_sent(case, values[2]), **offered_next})
        calls[0] += 1
        beside = {}
        record_step("next_page", values[2], status, reply, route, beside)
        next_page.update({"asked": True, "ok": reply.get("ok") is True, "ms": int((time.monotonic() - started) * 1000), "browser": reply.get("browser"),
                          "lines": beside["next_page"][1]["lines"], "error": shorten_error(str(reply.get("error") or "")) or None})
    reads_on = reads_on_finding(next_page["offered"], next_page["asked"], next_page.get("ok"), kept["call_unrelated"][1]["lines"] if "call_unrelated" in kept else [], next_page.get("lines") or [], next_page.get("browser"))
    site_result["next_page"] = {k: v for k, v in next_page.items() if k != "lines"} | {"listed": len(next_page.get("lines") or [])}

    # public.navigation: one link of the site's own from the last real search's answer, asked for once as a page to
    # read. Kept apart from the search's checks, as the next page is.
    followed = {"link": link, "asked": False}
    if route and not stop and link and calls[0] < MAX_CALLS_PER_SITE:
        time.sleep(gap)
        started = time.monotonic()
        status, reply = node.do("read this page", link)
        calls[0] += 1
        went = reply.get("route") if isinstance(reply.get("route"), dict) else None
        beside = {}
        landed = record_step("follow_link", link, status, reply, went, beside)
        followed.update({"asked": True, "status": status, "ok": landed["result_ok"] is True, "ms": int((time.monotonic() - started) * 1000), "how": reply.get("how"),
                         "route_host": landed["route_host"], "lines": beside["follow_link"][1]["lines"], "error": landed["error"] or shorten_error(str(reply.get("why") or "")) or None})
    follows = follows_a_link_finding(followed["link"], followed["asked"], followed.get("status"), followed.get("ok"), followed.get("lines") or [], followed.get("route_host"), site, followed.get("error") or "")
    site_result["followed_link"] = {k: v for k, v in followed.items() if k != "lines"} | {"listed": len(followed.get("lines") or [])}

    answers = {s: kept[s] for s in kept if s != "recheck"}
    compared = compare(answers, aliases)
    for check in checks:
        step = check["step"]
        if check.get("outcome"):
            continue
        value, read = kept[step]
        own = compared.get(step, {"own_lines": 0, "hits": 0, "titles": [], "_own": []})
        check["evidence"] = {"kind": read["kind"], "count": read["count"], "own_lines": own["own_lines"], "hits": own["hits"], "titles": own["titles"], "no_results_words": no_results_in(read["lines"])}
        ok = check["result_ok"] is True
        if check.get("window_refused") and not ok:
            check["outcome"], check["why"] = "blocked", "walk_refused_then_wanted_a_window"
        elif check["ignored_inputs"]:
            check["outcome"], check["why"] = "fail", "input_not_sent"
        elif step == "recheck" and ok and read["lines"] and not ("first" in kept and kept["first"][1]["lines"]):
            check["outcome"], check["why"] = "not_tested", "the_first_ask_has_no_answer_to_compare"
        elif step == "recheck" and ok:
            same = overlap(kept["first"][1]["lines"], read["lines"])
            check["evidence"]["overlap_with_first"] = round(same, 2)
            if door_in(read["head"]):
                check["outcome"], check["why"] = door_in(read["head"])
            elif read["kind"] == "empty":
                check["outcome"], check["why"] = "ok_but_wrong", "empty_answer"
            else:
                check["outcome"], check["why"] = ("pass", None) if ok and same >= 0.5 else ("unstable", "value_answers_differently_now")
        elif check["how"] == "browse":
            door = error_category(check["status"], {"why": errors.get(step) or check["error"]})
            check["outcome"], check["why"] = ("blocked", door) if door in ("challenge", "refused") else ("fail", "needs_hands")
        elif not ok:
            door = door_in(read["head"])
            words = error_category(check["status"], {"e": check["error"]})
            said = errors.get(step, "")
            if step == "no_results" and (no_results_in([said] + read["lines"]) or ("answered 404" in said and normal(value) in normal(said))):
                check["outcome"], check["why"] = "false_failure", "no_results_counted_as_error"
            elif door:
                check["outcome"], check["why"] = door
            elif words in ("challenge", "refused", "rate_limited"):
                check["outcome"], check["why"] = "blocked", words
            else:
                check["outcome"], check["why"] = "fail", words
        else:
            check["outcome"], check["why"] = judge_check(step, value, read, own, ok, aliases.get(value, ()))
        check["evidence"]["prices"] = read["prices"]
        if step in ("first", "replay", "call_unrelated"):
            # A value the answer has no reason to say (a city code, for a list of flights): the list itself is the read.
            if (check["outcome"], check.get("why")) == ("ok_but_wrong", "nothing_mentions_the_value") and case.get("value_not_shown") and own["own_lines"] >= MIN_OWN_LINES_OF_A_LONG_PAGE:
                check["outcome"], check["why"] = "pass", "value_not_shown"
            if check["outcome"] == "pass" and "price" in case.get("expect", ()) and read["prices"] < MIN_PRICES:
                check["outcome"], check["why"] = "ok_but_wrong", "no_prices_in_the_answer"
        if check["outcome"] == "pass" and step != "no_results" and SUGGESTS.search(str(check.get("path"))):
            check["outcome"], check["why"] = "ok_but_wrong", "suggestions_not_results"
        if step == "replay" and check["outcome"] == "pass" and (check["how"] != "called" or check["route_id"] != checks[0].get("route_id")):
            check["outcome"], check["why"] = "ok_but_wrong" if check["how"] == "learned" else "fail", "replay_was_not_a_call_of_the_same_route"
        if step in ("first", "replay") and check["outcome"] == "pass" and not input_name:
            check["outcome"], check["why"] = "fail", "no_bound_input"

    # Results for the nonsense value may be the site's own fallback (popular items, one product it redirects to): what
    # a site shows whatever it was asked. A second nonsense value tells it apart from a search that matched: the same
    # answer for both is the fallback, and the node handed back what the site serves. A line saying back the word asked
    # differs between the two by its nature, so it counts for nothing either way. Anything else stays wrong: a site that
    # finds something different for each nonsense word (Target) matched them, however loosely.
    check = next((c for c in checks if c["step"] == "no_results"), None)
    if (check and (check.get("outcome"), check.get("why")) == ("ok_but_wrong", "results_for_nonsense") and route
            and not stop and input_name and calls[0] < MAX_CALLS_PER_SITE):
        other = "zq" + nonsense[:1:-1]
        time.sleep(gap)
        log_before, guard_before = len(files.node_log_lines()), len(files.guard_lines())
        status, reply = node.call(route["id"], {input_name: as_sent(case, other)})
        calls[0] += 1
        said = files.node_log_lines()[log_before:]
        again = read_answer(reply.get("data")) if reply.get("ok") else None
        door = saw_a_door(said) or (held_a_clean_browser(files.guard_lines()[guard_before:]) and "HELD_CLEAN")
        walled = (one_ask and door) or (
            reply.get("ok") is False and error_category(status, reply) in ("refused", "challenge", "rate_limited")) or bool(again and door_stops("no_results", again))
        again = None if walled else again
        first = kept["no_results"][1]
        same = round(overlap(first["lines"], again["lines"]), 2) if again and again["lines"] and first["lines"] else 0.0
        says = again is not None and any(mentions(l, v) for l in first["lines"] + again["lines"] for v in (nonsense, other))
        check["evidence"]["second_nonsense"] = {"value": other, "status": status, "ok": reply.get("ok"), "overlap": same, "says_a_nonsense_word": says}
        if walled:
            check["outcome"], check["why"] = "blocked", "the_second_nonsense_met_a_door"
            if one_ask and door:
                check["door"] = door_said(door)
            stop = "blocked"
        elif same >= 0.8:
            check["outcome"], check["why"] = "pass", "site_fallback_same_for_any_nonsense"

    # A search whose every real answer was a list of records, answering the nonsense value with no list at all (a
    # cursor, a link to look elsewhere, the request said back), found nothing for it: the list is what it finds, and
    # there is none. Kubernetes' search provider answers that way.
    lists = [c for c in checks if c["step"] in ("first", "replay", "call_unrelated") and c.get("outcome") == "pass"]
    if lists and all((c.get("evidence") or {}).get("kind") == "records" for c in lists):
        for check in checks:
            if check["step"] == "no_results" and (check.get("outcome"), check.get("why")) == ("ok_but_wrong", "results_for_nonsense") and (check.get("evidence") or {}).get("kind") == "object":
                check["outcome"], check["why"] = "pass", "no_records_where_the_others_had_them"

    # Nothing found means something only beside a search that finds things: a page blank for every value says no
    # more for the nonsense value than for the rest.
    real = [c for c in checks if c["step"] in ("first", "replay", "call_unrelated")]
    if not any(c.get("outcome") == "pass" for c in real):
        for check in checks:
            if check["step"] == "no_results" and check.get("outcome") == "pass":
                check["outcome"], check["why"] = "ok_but_wrong", "no_real_answer_to_compare"

    for check in checks:
        check["step"] = prefix + check["step"]
    # What a warm call cost, beside what the same page costs in a browser: the Eden report's whole first finding was
    # that learned routes bought no time. Warm means a call of the stored route (a `do` that found it, or a `call`),
    # never the learn that made it.
    warm_checks = [c for c in checks if c["step"].removeprefix(prefix) in ("call_unrelated", "no_results", "recheck") or (c["step"].removeprefix(prefix) in ("first", "replay") and c.get("how") == "called")]
    warm = [c["ms"] for c in warm_checks if isinstance(c.get("ms"), int)]
    # What the threshold reads: calls that answered a real value. A refusal or a nothing-found comes back fast and says
    # nothing of what an answer costs.
    # And a call that had to walk the page again (a heal) is a learn, not a warm call.
    answered = [c["ms"] for c in warm_checks if isinstance(c.get("ms"), int) and c["result_ok"] is True and not c.get("healed") and c["step"].removeprefix(prefix) != "no_results"]
    browser_ms = browser_seconds(browser_program, url_for(case, values[0]), files.run_dir()) if browser_program and len(answered) >= MIN_WARM_CALLS and not stop else None
    lines = files.model_lines()[model_seen:]
    offered, picks = offered_rows(lines), goal_picks(lines)
    walked = files.walked_calls(began - 1)
    learned = next((c for c in reversed(checks) if c.get("how") == "learned"), None)
    picked_by = learned.get("picked_by") if learned else None
    # A route's site can be another of the site's hosts (`.com` redirected to `.sg`), which `first_party` doesn't know.
    added = [r for r in node.routes() if (first_party(r, site) or r.get("site") == (route or {}).get("site")) and r.get("id") not in {e.get("id") for e in preexisting}]
    answers_as_a_page = any(kept[s][1]["kind"] == "page" for s in ("first", "call_unrelated") if s in kept)
    if judge_site(checks) in ("blocked", "requires_account"):
        findings = {name: {"outcome": "blocked", "why": stop or "a_wall_answered"} for name in FINDINGS}
    else:
        findings = {
            "warm_speed": speed_finding(answered, browser_ms, correct_finding(checks, prefix)["outcome"] == "pass"),
            "data_route": data_route_finding(route, bool(site_result["route_is_page"] or answers_as_a_page), offered, walked),
            "correct": correct_finding(checks, prefix),
            "keeps_pick": keeps_pick_finding(route, picked_by, picks[-1] if picks else None, files.steps(route.get("id")) if route else [], values[:2]),
            "sse": sse_finding(walked, offered, bool(lines)),
            "short_values": short_values_finding(route, url_for(case, values[0])),
            "inputs": inputs_finding(route, input_name, added),
            "browserless": browserless_finding(warm_checks),
            "reads_on": reads_on,
            "follows_a_link": follows,
        }
    site_result["findings"] = findings
    site_result["model"] = {
        "asked": len(lines), "picked_by": picked_by, "offered": len(offered),
        "picks": [{"call": shorten_path(f"{p['row'].get('method')} {p['row'].get('path')}"), "probability": p["probability"], "confidence": p["confidence"]} for p in picks],
        "no_answer_said": sum("no answer, so the rule decides" in line for line in files.node_log_lines()[log_seen:]),
    }
    site_result.update({
        "checks": checks, "calls": calls[0], "stopped": stop, "retried_timeout": retried, "paid_usdc": sum(c["paid_usdc"] or 0 for c in checks),
        "vary": case.get("vary"),
        "warm_steps": [c["step"] for c in warm_checks],
        # The warm calls the node's browser ran a step of: a route that answers only through it is no route yet.
        "warm_in_browser": [c["step"] for c in warm_checks if c.get("browser") is True],
        "warm_ms": warm, "warm_answered_ms": answered, "warm_median_ms": median(warm), "browser_ms": browser_ms, "faster_than_browser": beats_browser(warm, browser_ms),
        "chrome_before": chrome_before, "chrome_after": files.chrome_left(),
    })
    if samples:
        keep_samples(samples, site, prefix, kept, compared)
    return site_result


def keep_samples(samples, site, prefix, kept, compared):
    """A site's answers for the person reading them: their own lines, short, kept outside the repository."""
    root = Path(samples).resolve()
    if HERE.parent.parent == root or HERE.parent.parent in root.parents:
        raise SystemExit("samples hold answer text: keep them outside the repository")
    root.mkdir(parents=True, exist_ok=True)
    out = {}
    for step, (value, read) in kept.items():
        own = compared.get(step, {}).get("_own", read["lines"])
        out[step] = {"value": value, "kind": read["kind"], "head": read["head"][:300], "own": "\n".join(own)[:SAMPLE_CHARS]}
    (root / f"{site}{'.' + prefix.strip('_') if prefix else ''}.json").write_text(json.dumps(out, ensure_ascii=False, indent=1))


def load(path, empty):
    file = Path(path)
    return json.loads(file.read_text()) if file.exists() else empty


def save(path, doc):
    """Whole or not at all: a run stopped mid-write (a per-site time cap) leaves the last whole file, never half of one."""
    file = Path(path)
    part = file.with_name(file.name + ".part")
    part.write_text(json.dumps(doc, ensure_ascii=False, indent=1) + "\n")
    os.replace(part, file)


def digest(site):
    """A site's checks, for the person reading the run."""
    print(f"\n== {site['site']} [{site['phase']}] input={site.get('bound_input')} first_party={site.get('route_first_party')} calls={site['calls']} stopped={site['stopped']}")
    speed = f" warm={site.get('warm_median_ms')}ms browser={site.get('browser_ms')}ms faster={site.get('faster_than_browser')}" if site.get("warm_ms") is not None else ""
    if site.get("warm_in_browser"):
        speed += f" IN_BROWSER={','.join(site['warm_in_browser'])}"
    page = " page_route" if site.get("route_is_page") else " data_route" if site.get("route_is_page") is not None else ""
    left = "" if site.get("chrome_before") is None else f" chrome={site.get('chrome_before')}->{site.get('chrome_after')}"
    print(f"  route:{page}{speed}{left} vary={site.get('vary')}")
    for c in site["checks"]:
        e = c.get("evidence") or {}
        took = f" {c['ms']}ms" if isinstance(c.get("ms"), int) else ""
        print(f"  {c['step']:<14} {str(c.get('outcome')):<13} how={c['how']} ok={c['result_ok']} st={c['status']} {c.get('method')} {str(c.get('path'))[:60]} why={c.get('why')} err={c.get('error')}{took}")
        print(f"      {e.get('kind')} count={e.get('count')} own={e.get('own_lines')} hits={e.get('hits')} none_words={e.get('no_results_words')} overlap={e.get('overlap_with_first')} titles={e.get('titles')}")
    model = site.get("model") or {}
    if model.get("asked"):
        print(f"  model asked={model['asked']} picked_by={model.get('picked_by')} picks={model.get('picks')} no_answer_said={model.get('no_answer_said')}")
    for name, finding in (site.get("findings") or {}).items():
        print(f"  {name:<14} {finding['outcome']:<8} {finding.get('why') or ''} {({k: v for k, v in finding.items() if k not in ('outcome', 'why')}) or ''}")
    links = site.get("links") or {}
    if links:
        print(f"  links {links.get('outcome')} status={links.get('status')} routes={links.get('routes')} added={links.get('activity_added')}/{links.get('calls_added')}/{links.get('browsers_added')} sound={links.get('sound_forms')} not_refused={links.get('malformed_not_refused')}")


def command_sample(args):
    sites = json.loads((HERE / "sites.json").read_text())["sites"]
    reserved = {d["domain"] for d in json.loads((HERE / "future-targets.json").read_text())["domains"]} | {"twitter.com"}
    picked = pick_sample(sites, tested_domains(HERE / "mcp-runs"), reserved, args.seed, args.per_category)
    for site in picked:
        print(f"{site['category']:<22} {site['domain']:<24} {site['market']:<7} {site['tranco_rank']}")
    print(len(picked), "sites;", dict(Counter(s["market"] for s in picked)))


def one_ask_refusal(node_log, guard_log):
    """Why `--one-ask` can't be honoured, or None. Without the node's log no door can be seen, and without the guard's hold
    the node re-asks in a clean browser: either way the flag would promise what the run doesn't do."""
    if not node_log or not guard_log:
        return "--one-ask needs --node-log and --guard-log: without them a wall can't be seen"
    if not Path(node_log).exists():
        return f"--one-ask needs the node's log, and {node_log} doesn't exist: a wall can't be seen in a file that isn't there"
    guard = Path(guard_log).parent / "guard-browser"
    if not guard.exists() or 'if [ "1" = 1 ]' not in guard.read_text():
        return f"--one-ask needs a node started with ONE_ASK=1: {guard} doesn't hold to one ask"
    return None


# The flags and the trial of sandbox.rs (`HELD`, `TRIED`) and scratch-node.sh, held to them by a test in sandbox.rs: under
# the permission model, no child process, no network, and no SQLite of the runtime's own.
RUNTIME_FLAGS = ["--permission", "--no-experimental-sqlite"]
RUNTIME_HOLDS = 'if(!process.permission||process.permission.has("child")||process.getBuiltinModule("node:sqlite"))process.exit(1);var denied=function(e){process.exit(e&&e.code==="ERR_ACCESS_DENIED"?0:1)};try{require("net").connect(9,"127.0.0.1").on("error",denied).on("connect",function(){process.exit(1)})}catch(e){denied(e)}'


def runtime_refusal(program=None):
    """Why the bank can't run with this signing runtime, or None. The node runs a page's code only in a runtime it can hold
    (no child process, no network), and with any other every page-signed route goes to the browser: a run would measure
    nothing of the sandbox. The runtime is the one scratch-node.sh gives the node: SIGNING_PROGRAM, else `node` on the path."""
    program = program or os.environ.get("SIGNING_PROGRAM") or shutil.which("node")
    if not program:
        return "no runtime to sign a page's calls in: the bank needs Node 25 or later on the path, or SIGNING_PROGRAM naming one"
    try:
        holds = subprocess.run([program, *RUNTIME_FLAGS, "-e", RUNTIME_HOLDS], capture_output=True, timeout=30).returncode == 0
    except (OSError, subprocess.TimeoutExpired):
        holds = False
    if holds:
        return None
    return f"{program} can't hold a page's code: the bank needs Node 25 or later, whose permission model denies child processes and the network (22.13 to 24 leave the network open, older ones have no such model)"


def private_node_refusal(cases, node_home, token_file):
    """Why these cases can't run on this node, or None. A node with `private_network` on is for a test's stub site: a public
    page there could send a route at this machine's own services. Settings are read from the node's home, else the scratch
    folder its token sits in. A node whose settings can't be found can't be told apart, so it gets no live URL."""
    homes = [Path(node_home)] if node_home else []
    homes.append(Path(token_file).parent / "home" / "node")
    live = [c["site"] for c in cases if urllib.parse.urlsplit(c["url"].replace("{q}", "q")).hostname not in ("127.0.0.1", "localhost", "::1")]
    if not live:
        return None
    settings = next((h / "settings.json" for h in homes if (h / "settings.json").exists()), None)
    if not settings:
        return f"this node's settings weren't found, so {', '.join(live)} can't be cleared to run: give --node-home"
    if json.loads(settings.read_text()).get("private_network"):
        return f"this node has private_network on, and these aren't on this machine: {', '.join(live)}"
    return None


def registrable(case):
    """The domain a wall on this case stands for: a case can name it, as a second case on one domain does."""
    return (case.get("registrable") or case["site"]).lower().removeprefix("www.")


def walled_domains(doc):
    """Domains this run's file has met a wall on. Kept in the file, so another batch on the same --out holds to them."""
    return {e.get("registrable") or e["site"].lower().removeprefix("www.") for e in doc["sites"] if e.get("stopped") == "blocked" or judge_site(e["checks"]) == "blocked"}


def command_run(args):
    doc = load(args.out, {"schema_version": 2, "seed": args.seed, "nonsense": nonsense_value(args.seed), "sites": [], "judgments": [], "odd_links": None})
    cases = {c["site"]: c for c in json.loads(Path(args.cases).read_text())["cases"]}
    wanted = args.sites.split(",")
    if len(wanted) > MAX_BATCH:
        raise SystemExit(f"a batch is at most {MAX_BATCH} sites")
    refusal = runtime_refusal() or (one_ask_refusal(args.node_log, args.guard_log) if args.one_ask else None) or private_node_refusal([cases[name] for name in wanted], args.node_home, args.token_file)
    if refusal:
        raise SystemExit(refusal)
    node = Node(args.node, Path(args.token_file).read_text().strip())
    files = Files(args.node_home, args.node_log, args.guard_log, args.model_log)
    if doc.get("odd_links") is None:
        doc["odd_links"] = check_odd_links(node)
    walled = walled_domains(doc)
    for n, name in enumerate(wanted):
        domain = registrable(cases[name])
        if domain in walled:  # a wall on one case is a wall on its sibling: another path of the site is no way round it
            doc.setdefault("skipped", []).append({"site": name, "registrable": domain, "why": "a_wall_on_this_domain"})
            save(args.out, doc)
            print(f"\n== {name} skipped: {domain} showed a wall in this run")
            continue
        site = run_site(node, cases[name], doc["nonsense"], files, args.samples, args.after_judge, args.gap, browser_program(args), args.one_ask)
        site["registrable"] = domain
        doc["sites"].append(site)
        save(args.out, doc)
        walled |= walled_domains({"sites": [site]})
        site["links"] = check_links(node, cases[name].get("registrable", name), files)
        save(args.out, doc)
        digest(site)
        if n + 1 < len(wanted):
            time.sleep(args.site_gap)
    # What the node holds at the end of the run: the last batch's measure stands.
    time.sleep(args.site_gap)
    doc["resources"] = resources_finding(files.tree())
    save(args.out, doc)
    print(f"\nresources {doc['resources']}")


def browser_program(args):
    """The browser the run times warm calls against. `auto` (the default) is the agent-browser this repo builds, when
    it is built; `none` skips the baseline, which records no comparison rather than a pass."""
    value = getattr(args, "browser_program", None) or "auto"
    if value == "auto":
        return default_browser_program()
    return None if value in ("none", "") else value


def command_judge(args):
    doc = load(args.out, None)
    done = sum(j["site"] == args.site and j.get("status") == 200 for j in doc["judgments"])
    if done >= MAX_JUDGMENTS:
        raise SystemExit(f"{args.site} has had {done} judgments: that is the limit, record what it is")
    node = Node(args.node, Path(args.token_file).read_text().strip())
    body = {"verdict": args.verdict}
    for key in ("url", "why", "what"):
        if getattr(args, key):
            body[key] = getattr(args, key)
    if args.fields:
        body["fields"] = args.fields.split(",")
    status, reply = node.judge(args.route, body)
    doc["judgments"].append({"site": args.site, "route_id": args.route, "verdict": args.verdict, "url": strip_query(args.url or ""), "why": args.why, "what": args.what, "fields": body.get("fields"), "status": status})
    save(args.out, doc)
    print(status, json.dumps(reply, ensure_ascii=False)[:400])


def final_site(entries, judgments, reads):
    """One site's record: its passes in order, what the rule suggests, and what the reader called it."""
    checks = [c for e in entries for c in e["checks"]]
    last = [dict(c, step=c["step"].removeprefix("after_judge_")) for c in entries[-1]["checks"]]
    retried = any(e["retried_timeout"] for e in entries)
    suggested = judge_site(last, retried, judgments)
    read = reads.get(entries[0]["site"], {})
    head = {k: entries[0].get(k) for k in ("site", "goal", "url", "values", "category", "market", "retest", "url_source", "phase", "bound_input", "route_first_party", "route_is_page", "vary", "warm_median_ms", "browser_ms", "faster_than_browser", "chrome_before", "chrome_after")}
    return dict(
        head,
        checks=checks,
        calls=sum(e["calls"] for e in entries),
        judgments=judgments,
        paid_usdc=sum(e["paid_usdc"] for e in entries),
        links=entries[-1].get("links"),
        findings=entries[-1].get("findings"),
        model=entries[-1].get("model"),
        warm_answered_ms=entries[-1].get("warm_answered_ms"),
        suggested=suggested,
        classification=read.get("classification", suggested),
        read_differs=read.get("classification", suggested) != suggested,
        note=read.get("note"),
    )


def build_report(doc, reads):
    by_site = defaultdict(list)
    for entry in doc["sites"]:
        by_site[entry["site"]].append(entry)
    judged = Counter(j["site"] for j in doc["judgments"] if j.get("status") == 200 and (j["verdict"] == "wrong" or j.get("fields")))
    sites = [final_site(entries, judged[name], reads) for name, entries in by_site.items()]
    counts = Counter(s["classification"] for s in sites)
    # What the Eden report asked for, counted across the run: do warm calls beat a browser, how many stored routes are
    # the page rather than a data call, and how many browsers the run left running.
    faster = [s for s in sites if s.get("faster_than_browser") is not None]
    return {
        "sites": sites,
        "judgments": doc["judgments"],
        "odd_links": doc["odd_links"],
        "counts": {k: counts[k] for k in SITE_OUTCOMES if counts[k]},
        "checks_total": sum(len(s["checks"]) for s in sites),
        "calls_total": sum(s["calls"] for s in sites),
        "paid_usdc_total": sum(s["paid_usdc"] for s in sites),
        "read_differs": sum(s["read_differs"] for s in sites),
        "speed": {"measured": len(faster), "faster": sum(1 for s in faster if s["faster_than_browser"]), "slower": sum(1 for s in faster if not s["faster_than_browser"])},
        "page_routes": sum(1 for s in sites if s.get("route_is_page")),
        "routes_stored": sum(1 for s in sites if s.get("route_is_page") is not None),
        "browsers_left": sum(max(0, (s.get("chrome_after") or 0) - (s.get("chrome_before") or 0)) for s in sites if s.get("chrome_before") is not None),
        "findings": {name: dict(Counter((s.get("findings") or {}).get(name, {}).get("outcome", "not_run") for s in sites)) for name in FINDINGS},
        "resources": doc.get("resources"),
        "skipped": doc.get("skipped", []),
    }


def findings_table(report):
    """The run per site and finding, as Markdown. The site's own verdict is beside them, not made of them: a slow route can
    still answer right, and the nightly regression reads answers."""
    rows = ["| site | outcome | " + " | ".join(FINDINGS) + " |", "|---|---|" + "---|" * len(FINDINGS)]
    for site in report["sites"]:
        found = site.get("findings") or {}
        rows.append(f"| {site['site']} | {site['classification']} | " + " | ".join(found.get(name, {}).get("outcome", "not_run") for name in FINDINGS) + " |")
    return "\n".join(rows)


def problems(report):
    """What a report must never say: an outcome off the list, a pass on an answer that was wrong, a count that doesn't
    add up, money spent, or anything longer than a short sample."""
    found = []
    for site in report["sites"]:
        if site["classification"] not in SITE_OUTCOMES:
            found.append(f"{site['site']}: {site['classification']} isn't an outcome")
        if site["classification"] in PASSES and site["suggested"] not in PASSES and not site.get("note"):
            found.append(f"{site['site']}: read as a pass against the rule with no reason given")
        if site["paid_usdc"]:
            found.append(f"{site['site']}: paid {site['paid_usdc']}")
        if site.get("faster_than_browser") is not None and not site.get("browser_ms"):
            found.append(f"{site['site']}: says faster than a browser with no browser time")
        for name, finding in (site.get("findings") or {}).items():
            if finding["outcome"] not in FINDING_OUTCOMES:
                found.append(f"{site['site']}: {name} outcome {finding['outcome']}")
            if name == "warm_speed" and finding["outcome"] in ("pass", "fail") and not finding.get("browser_ms"):
                found.append(f"{site['site']}: a speed verdict with no browser time")
        for check in site["checks"]:
            if check.get("outcome") and check["outcome"] not in CHECK_OUTCOMES:
                found.append(f"{site['site']}: check outcome {check['outcome']}")
            if any(len(t) > SHORT for t in (check.get("evidence") or {}).get("titles", [])):
                found.append(f"{site['site']}: a title over {SHORT} characters")
            if any(AN_ADDRESS.search(t) for t in (check.get("evidence") or {}).get("titles", [])):
                found.append(f"{site['site']}: an address in a title")
            if "?" in str(check.get("url", "")):
                found.append(f"{site['site']}: a query string in a url")
    if sum(report["counts"].values()) != len(report["sites"]):
        found.append("the counts don't add up to the sites")
    return found


def command_report(args):
    doc = load(args.out, None)
    reads = load(args.reads, {}) if args.reads else {}
    report = build_report(doc, reads)
    report = {"schema_version": 2, "batch": args.batch, "node_version": args.node_version, "decision_model": args.decision_model, "seed": doc.get("seed"), "nonsense": doc.get("nonsense"), "scope": "public read-only search; no login, no writes, no challenge solved", "excluded": "no credentials, cookies, session IDs or response bodies; up to three short titles per check", **report}
    found = problems(report)
    if found:
        raise SystemExit("\n".join(found))
    save(args.result, report)
    print(json.dumps({k: report[k] for k in ("decision_model", "counts", "checks_total", "calls_total", "paid_usdc_total", "read_differs", "speed", "page_routes", "routes_stored", "browsers_left", "findings", "resources", "skipped")}, indent=1))
    print(findings_table(report))
    if report["browsers_left"]:
        print(f"the run left {report['browsers_left']} browser process(es) running")


def compare_to_baseline(baseline, entries):
    """How a run stands against the checks each site passed: `baseline` is {site: [steps]}. A check that passed and now
    answers wrong has regressed. A wall or a site down is no fault of a build and no proof of one, so it says nothing, and
    a wall anywhere says nothing of the whole site: what follows a refused first ask follows from the refusal. A live list
    that answers a value differently on the recheck (`unstable`) is the site moving on, not the route going wrong.
    Check by check, since a site's own verdict in a run that was read may be a person's, and this run has only the rule."""
    latest = {e["site"]: e for e in entries}
    cant_tell = ("blocked", "requires_account", "not_applicable", "not_tested", "unstable")
    walled = ("blocked", "requires_account")
    out = {"passed": [], "regressed": [], "cant_tell": []}
    for site, steps in baseline.items():
        final = {c["step"]: c.get("outcome", "not_tested") for c in (latest.get(site) or {}).get("checks", [])}
        now = {step: final.get(step, "not_tested") for step in steps}
        wrong = {step: o for step, o in now.items() if o != "pass" and o not in cant_tell}
        wall = next((o for o in final.values() if o in walled), None)
        if wall:
            out["cant_tell"].append({"site": site, "outcome": wall})
        elif wrong:
            out["regressed"].append({"site": site, "outcome": ", ".join(f"{step}: {o}" for step, o in wrong.items())})
        elif all(o == "pass" for o in now.values()):
            out["passed"].append({"site": site, "outcome": "pass"})
        else:
            out["cant_tell"].append({"site": site, "outcome": next(o for o in now.values() if o != "pass")})
    return out


def comparison_text(result):
    total = sum(len(v) for v in result.values())
    lines = [f"**Read regression: {len(result['passed'])} of {total} sites still pass their checks, {len(result['regressed'])} regressed, {len(result['cant_tell'])} couldn't be told.**", ""]
    lines += [f"- regressed: {r['site']} ({r['outcome']})" for r in result["regressed"]]
    lines += [f"- couldn't tell: {r['site']} ({r['outcome']})" for r in result["cant_tell"]]
    return "\n".join(lines) + "\n"


def command_compare(args):
    baseline = json.loads(Path(args.baseline).read_text())["sites"]
    result = compare_to_baseline(baseline, load(args.out, {"sites": []})["sites"])
    text = comparison_text(result)
    print(text)
    if args.summary:
        Path(args.summary).write_text(text)
    return 1 if result["regressed"] else 0


def walks_started(log_lines):
    """Each walk the node's log says it started: its id, the page and the goal it was walked for."""
    out = {}
    for line in log_lines:
        if not line.startswith("eye {"):
            continue
        try:
            said = json.loads(line[4:])
        except ValueError:
            continue
        if said.get("kind") == "started" and said.get("walk") and said.get("url"):
            out[said["walk"]] = {"walk": said["walk"], "url": said["url"], "goal": said.get("goal") or ""}
    return out


def owners_folder(path):
    """Makes `path` a folder its owner alone can read, or refuses: one made now is made so, one already there that is
    this user's is narrowed to the owner, and one that is a link, not a folder, or someone else's is refused, since a
    case holds the session that walked and the page's whole address, fragment and all."""
    path = Path(path)
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    held = os.lstat(path)
    if stat.S_ISLNK(held.st_mode) or not stat.S_ISDIR(held.st_mode):
        raise PermissionError(f"{path} is not a folder of its own: a walk's case is kept only in its owner's folder")
    if held.st_uid != os.getuid():
        raise PermissionError(f"{path} is another user's: a walk's case is kept only in its owner's folder")
    if held.st_mode & 0o077:
        os.chmod(path, 0o700)
    return path


def write_private(path, text):
    """Writes `text` to `path` for its owner alone (0600), whatever was there, never through a link."""
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | getattr(os, "O_NOFOLLOW", 0), 0o600)
    try:
        os.fchmod(fd, 0o600)
        os.write(fd, text.encode())
    finally:
        os.close(fd)


def keep_capture(capture, case, corpus):
    """Moves one walk's capture into the corpus as a case of its own, with the page and the goal it was walked for
    (`case`: url, goal). A capture holds the session that walked, and the case the page's whole address, so the corpus
    and every case in it are their owner's alone (`owners_folder`, files 0600), and are never the repository's. Returns
    the case's name, or nothing for a walk that recorded nothing."""
    capture, corpus = Path(capture), owners_folder(corpus)
    if not capture.is_file() or capture.stat().st_size == 0:
        return None
    host = urllib.parse.urlsplit(case["url"]).hostname or "unknown"
    home = owners_folder(corpus / f"{host.removeprefix('www.')}--{capture.stem.removeprefix('learn_')}")
    shutil.move(str(capture), str(home / capture.name))
    os.chmod(home / capture.name, 0o600)
    write_private(home / "case.json", json.dumps(case, indent=2, ensure_ascii=False) + "\n")
    return home.name


def keep_walks(log_lines, walks_dir, corpus):
    """Keeps every walk the node's log says it started (`keep_capture`): what the learner reads again offline
    (`learn/corpus.rs`)."""
    owners_folder(corpus)
    kept = [keep_capture(Path(walks_dir) / f"learn_{walk}.jsonl", case, corpus) for walk, case in sorted(walks_started(log_lines).items())]
    return [name for name in kept if name]


# What binds a call to the browser, read from what the run saw of its site: a challenge or a denial is a door, a login
# wall wants a person. Anything else that still needed a browser is not yet placed. A line that says so itself wins.
BOUND_BY = ("person", "entropy", "door", "unplaced")
# The outcomes of a site whose answers were right: only its calls count as answered. A no-results answer the node
# counted as an error is still a right answer.
RIGHT = ("pass", "pass_after_retry", "pass_after_judge", "pass_after_hands", "false_failure")


def outcome_of(site, outcomes):
    """What the run decided of the site a call went to. A route's site is a host of the site the run names
    (`www.shop.example`, `api.shop.example` for `shop.example`), so the longest name it sits at or under decides."""
    site = (site or "").lower()
    under = [name for name in outcomes if site == name or site.endswith("." + name)]
    return outcomes[max(under, key=len)] if under else None


def bound_by(line, outcome):
    said = line.get("bound_by")
    if said in BOUND_BY:
        return said
    return {"blocked": "door", "requires_account": "person"}.get(outcome, "unplaced")


def census(lines, outcomes=None, routes=None):
    """Counts a run's calls by the highest rung each reached (made.jsonl: one line per call, `learn.rung`), and how
    many answered with no browser process: coverage without a browser is browserless_answered / calls. `outcomes`
    maps a site to what the run decided of it, and `routes` a route to the same for the site whose checks called it;
    only a call of a site whose answers the run found right answered, whatever the call said of itself. The route
    decides first: a site that sends its visitors to another host (a country's own) is still the site the run
    asked. A call the run says nothing of, by route or by site, is taken at its word."""
    outcomes = outcomes or {}
    routes = routes or {}
    by_rung = {str(r): 0 for r in range(6)}
    answered = browserless_answered = model_calls = 0
    browser_calls = []
    for line in lines:
        rung = line["rung"]
        if not isinstance(rung, int) or not 0 <= rung <= 5:
            raise ValueError(f"a call's rung is 0 to 5, not {rung!r}")
        outcome = routes.get(line.get("route")) or outcome_of(line.get("site"), outcomes)
        ok = bool(line.get("ok")) and (outcome is None or outcome in RIGHT)
        by_rung[str(rung)] += 1
        answered += ok
        model_calls += int(line.get("model_requests", 0))
        if rung <= 3:
            browserless_answered += ok
        else:
            browser_calls.append({"case": line.get("site"), "route": line.get("route"), "rung": rung, "ok": ok, "bound_by": bound_by(line, outcome)})
    return {
        "calls": len(lines),
        "answered": answered,
        "browserless_answered": browserless_answered,
        "by_rung": by_rung,
        "browser_calls": browser_calls,
        "model_calls": model_calls,
    }


def made_lines(home):
    path = Path(home) / "made.jsonl"
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


def command_census(args):
    """One census over one run or several: each scratch node's calls, and what each run decided of its sites."""
    lines = [line for home in args.node_home for line in made_lines(home)]
    if not lines:
        print(f"no calls in {', '.join(str(Path(h) / 'made.jsonl') for h in args.node_home)}", file=sys.stderr)
        return 1
    outcomes, routes = {}, {}
    for out in args.out or []:
        for s in load(out, {"sites": []})["sites"]:
            outcomes[s["site"]] = judge_site(s.get("checks", []), retried=bool(s.get("retried_timeout")))
            for check in s.get("checks", []):
                if check.get("route_id"):
                    routes[check["route_id"]] = outcomes[s["site"]]
    result = census(lines, outcomes, routes)
    result["from"] = {"node_home": [str(h) for h in args.node_home], "run": args.out, "commit": args.commit}
    result["sites"] = outcomes
    Path(args.census).write_text(json.dumps(result, indent=1) + "\n")
    share = result["browserless_answered"] / result["calls"]
    print(f"{result['calls']} calls, {result['browserless_answered']} answered with no browser ({share:.1%}); by rung {result['by_rung']}")
    return 0


def command_walks(args):
    lines = Path(args.node_log).read_text(errors="replace").splitlines()
    kept = keep_walks(lines, args.walks, args.corpus)
    print(f"kept {len(kept)} walks in {args.corpus}")
    return 0


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    commands = parser.add_subparsers(dest="command", required=True)

    def node_args(p):
        p.add_argument("--node", default="http://127.0.0.1:17810")
        p.add_argument("--token-file", required=True)
        p.add_argument("--out", required=True)

    sample = commands.add_parser("sample")
    sample.add_argument("--seed", required=True)
    sample.add_argument("--per-category", type=int, default=3)
    sample.set_defaults(func=command_sample)

    run = commands.add_parser("run")
    node_args(run)
    run.add_argument("--cases", required=True)
    run.add_argument("--sites", required=True)
    run.add_argument("--seed", required=True)
    run.add_argument("--samples")
    run.add_argument("--after-judge", action="store_true")
    run.add_argument("--node-home")
    run.add_argument("--node-log")
    run.add_argument("--guard-log")
    run.add_argument("--model-log", help="the stand-in decision model's log (decision_shim.py), read for what it was shown and what it picked")
    run.add_argument("--browser-program", default="auto", help="what warm calls are timed against: auto (the built agent-browser), a path, or none")
    run.add_argument("--one-ask", action="store_true", help="a door a walk or a call met ends the site: with scratch-node.sh's ONE_ASK=1")
    run.add_argument("--gap", type=float, default=GAP_SECS)
    run.add_argument("--site-gap", type=float, default=SITE_GAP_SECS)
    run.set_defaults(func=command_run)

    judge = commands.add_parser("judge")
    node_args(judge)
    judge.add_argument("--site", required=True)
    judge.add_argument("--route", required=True)
    judge.add_argument("--verdict", required=True, choices=("right", "wrong"))
    judge.add_argument("--url")
    judge.add_argument("--why")
    judge.add_argument("--what")
    judge.add_argument("--fields")
    judge.set_defaults(func=command_judge)

    report = commands.add_parser("report")
    report.add_argument("--out", required=True)
    report.add_argument("--reads")
    report.add_argument("--batch", required=True)
    report.add_argument("--node-version", required=True)
    report.add_argument("--decision-model", default="none: the rule", help="who answered the node's decisions, said in the report")
    report.add_argument("--result", required=True)
    report.set_defaults(func=command_report)

    compared = commands.add_parser("compare")
    compared.add_argument("--baseline", default=str(HERE / "regression.json"))
    compared.add_argument("--out", required=True)
    compared.add_argument("--summary")
    compared.set_defaults(func=command_compare)

    counted = commands.add_parser("census")
    counted.add_argument("--node-home", required=True, action="append", help="a scratch node's home: its made.jsonl is what is counted (repeat for several runs)")
    counted.add_argument("--out", action="append", help="a run's results, so only the calls of sites it found right count as answered (repeat for several runs)")
    counted.add_argument("--commit", help="the commit the node was built from")
    counted.add_argument("--census", required=True, help="where the counts are written")
    counted.set_defaults(func=command_census)

    walks = commands.add_parser("walks", help="keep a run's walks as a corpus the learner reads again offline")
    walks.add_argument("--node-log", required=True)
    walks.add_argument("--walks", required=True, help="where the node wrote its captures: <scratch>/tmp/unbrowse-node-walks")
    walks.add_argument("--corpus", required=True, help="a folder outside the repository")
    walks.set_defaults(func=command_walks)

    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
