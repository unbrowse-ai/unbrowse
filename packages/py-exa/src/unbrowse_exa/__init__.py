"""unbrowse_exa — a zero-edit drop-in for `exa-py`, backed by Unbrowse.

Swap the import and keep your code:

    # from exa_py import Exa
    from unbrowse_exa import Exa

    exa = Exa(api_key="...")
    r = exa.search_and_contents("best AI agent frameworks", num_results=5)
    for hit in r.results:
        print(hit.title, hit.url, hit.text[:120])

It mirrors exa-py's public surface — `Exa(api_key)`, `.search(...)`,
`.search_and_contents(...)`, a `SearchResponse` with `.results`, and `Result`
objects carrying `.url/.title/.text/.highlights/.score/.published_date/...` —
but the results come from the Unbrowse shared route graph + web enrichment
(`/v1/search`), not from Exa. Offline shape mode: `UNBROWSE_EXA_DRYRUN=1`.

Not affiliated with or endorsed by Exa. `exa-py` is the upstream we are a
drop-in for; trademarks belong to their owners.
"""
import os
import json
import urllib.request

__all__ = ["Exa", "AsyncExa", "Result", "SearchResponse"]


# ---- exa-py-shaped result types -------------------------------------------
class Result:
    """Mirrors exa_py.api.Result: the fields a caller reads off a hit."""

    __slots__ = (
        "url", "title", "id", "score", "published_date", "author",
        "text", "highlights", "highlight_scores", "summary",
    )

    def __init__(self, url="", title=None, id=None, score=None, published_date=None,
                 author=None, text=None, highlights=None, highlight_scores=None, summary=None):
        self.url = url
        self.title = title
        self.id = id or url
        self.score = score
        self.published_date = published_date
        self.author = author
        self.text = text
        self.highlights = highlights or []
        self.highlight_scores = highlight_scores or []
        self.summary = summary

    def __repr__(self):
        return f"Result(url={self.url!r}, title={self.title!r})"


class SearchResponse:
    """Mirrors exa_py's SearchResponse: `.results` plus `.autoprompt_string`."""

    def __init__(self, results, autoprompt_string=None, resolved_search_type=None):
        self.results = results
        self.autoprompt_string = autoprompt_string
        self.resolved_search_type = resolved_search_type

    def __repr__(self):
        return f"SearchResponse(results={len(self.results)})"


# ---- Unbrowse backend ------------------------------------------------------
def _base():
    return (os.environ.get("UNBROWSE_API_URL")
            or os.environ.get("UNBROWSE_BASE")
            or "https://beta-api.unbrowse.ai")


def _auth(api_key=None):
    h = {"content-type": "application/json"}
    k = api_key or os.environ.get("UNBROWSE_API_KEY")
    if k:
        h["authorization"] = "Bearer " + k
    return h


def _dryrun():
    return os.environ.get("UNBROWSE_EXA_DRYRUN") == "1" or os.environ.get("UNBROWSE_DRYRUN") == "1"


def _search_backend(query, num_results, api_key, timeout=30):
    payload = {"intent": query, "globalK": num_results}
    req = urllib.request.Request(_base() + "/v1/search", data=json.dumps(payload).encode(),
                                 headers=_auth(api_key), method="POST")
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode())


def _coerce_results(raw, num_results, want_text, want_highlights, want_summary):
    """Map an Unbrowse /v1/search response into exa-shaped Result objects.

    Honest best-effort: Unbrowse items may be dicts (url/title/text) or bare
    text snippets. We populate every field we can and leave the rest at exa's
    own defaults (None / []). No fabricated URLs.
    """
    items = []
    res = (raw or {}).get("result") or raw or {}
    data = res.get("data") if isinstance(res, dict) else None
    if data is None and isinstance(raw, dict):
        data = raw.get("results") or raw.get("hits")
    if isinstance(data, dict):
        data = data.get("results") or list(data.values())
    if not isinstance(data, list):
        data = [data] if data else []

    for item in data[:num_results]:
        if isinstance(item, dict):
            url = item.get("url") or item.get("link") or ""
            title = item.get("title") or item.get("name")
            text = item.get("text") or item.get("snippet") or item.get("content")
            items.append(Result(
                url=url, title=title,
                text=text if want_text or not (want_highlights or want_summary) else None,
                highlights=[text] if (want_highlights and text) else [],
                summary=text if want_summary else None,
                score=item.get("score"), published_date=item.get("published_date"),
                author=item.get("author"),
            ))
        else:
            snippet = str(item)
            items.append(Result(
                url="", title=None,
                text=snippet if want_text or not (want_highlights or want_summary) else None,
                highlights=[snippet] if want_highlights else [],
                summary=snippet if want_summary else None,
            ))
    return items


def _dry_results(query, num_results, want_text, want_highlights, want_summary):
    out = []
    for i in range(num_results):
        out.append(Result(
            url=f"https://example.com/{i}", title=f"[dryrun] {query} #{i}",
            text=f"[dryrun] contents for {query}" if want_text or not (want_highlights or want_summary) else None,
            highlights=[f"[dryrun] highlight {i}"] if want_highlights else [],
            summary=f"[dryrun] summary {i}" if want_summary else None,
            score=1.0,
        ))
    return out


# ---- the exa-py-compatible client -----------------------------------------
class Exa:
    """Drop-in for `exa_py.Exa`, backed by Unbrowse."""

    def __init__(self, api_key=None, base_url=None, user_agent=None):
        self.api_key = api_key or os.environ.get("UNBROWSE_API_KEY") or os.environ.get("EXA_API_KEY")
        self.base_url = base_url

    def search(self, query, num_results=10, type="auto", **kwargs):
        if _dryrun():
            return SearchResponse(_dry_results(query, num_results, False, False, False), resolved_search_type=type)
        raw = _search_backend(query, num_results, self.api_key)
        return SearchResponse(_coerce_results(raw, num_results, False, False, False), resolved_search_type=type)

    def search_and_contents(self, query, num_results=10, type="auto",
                            text=False, highlights=False, summary=False, **kwargs):
        # exa returns text by default from search_and_contents
        want_text = bool(text) or not (highlights or summary)
        if _dryrun():
            return SearchResponse(_dry_results(query, num_results, want_text, bool(highlights), bool(summary)),
                                  resolved_search_type=type)
        raw = _search_backend(query, num_results, self.api_key)
        return SearchResponse(_coerce_results(raw, num_results, want_text, bool(highlights), bool(summary)),
                              resolved_search_type=type)

    def get_contents(self, ids, **kwargs):
        # exa surface: fetch contents for known urls/ids. Best-effort via search.
        urls = ids if isinstance(ids, (list, tuple)) else [ids]
        results = []
        for u in urls:
            r = self.search_and_contents(str(u), num_results=1, text=True)
            results.extend(r.results)
        return SearchResponse(results)


class AsyncExa:
    """Async drop-in for `exa_py.AsyncExa`. Wraps the sync client; the network
    call is brief and runs in a thread so it never blocks the event loop."""

    def __init__(self, api_key=None, base_url=None, user_agent=None):
        self._sync = Exa(api_key=api_key, base_url=base_url)

    async def search(self, query, num_results=10, type="auto", **kwargs):
        import asyncio
        return await asyncio.to_thread(self._sync.search, query, num_results, type, **kwargs)

    async def search_and_contents(self, query, num_results=10, type="auto",
                                  text=False, highlights=False, summary=False, **kwargs):
        import asyncio
        return await asyncio.to_thread(self._sync.search_and_contents, query, num_results, type,
                                       text, highlights, summary, **kwargs)
