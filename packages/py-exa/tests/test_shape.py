"""Shape parity tests for unbrowse_exa — plain python3, MUST pass OFFLINE.

Proves the shim provides exa-py's public surface. Run:
    python3 packages/py-exa/tests/test_shape.py
"""
import os, sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))
import unbrowse_exa as M


def test_exports_match_exa_py():
    # the names a caller of exa-py imports
    for name in ("Exa", "AsyncExa", "Result", "SearchResponse"):
        assert hasattr(M, name), f"missing {name}"


def test_exa_client_surface():
    exa = M.Exa(api_key="test")
    for method in ("search", "search_and_contents", "get_contents"):
        assert hasattr(exa, method) and callable(getattr(exa, method)), method


def test_search_and_contents_returns_exa_shape():
    os.environ["UNBROWSE_EXA_DRYRUN"] = "1"
    try:
        exa = M.Exa(api_key="test")
        r = exa.search_and_contents("best AI agent frameworks", num_results=3)
        assert isinstance(r, M.SearchResponse)
        assert isinstance(r.results, list) and len(r.results) == 3
        hit = r.results[0]
        # the exact attributes a caller reads off an exa Result
        for attr in ("url", "title", "text", "highlights", "score", "published_date", "summary"):
            assert hasattr(hit, attr), f"Result missing {attr}"
        assert isinstance(hit.url, str)
        assert hit.text is not None  # search_and_contents returns text by default
    finally:
        os.environ.pop("UNBROWSE_EXA_DRYRUN", None)


def test_search_highlights_and_summary_modes():
    os.environ["UNBROWSE_EXA_DRYRUN"] = "1"
    try:
        exa = M.Exa(api_key="test")
        h = exa.search_and_contents("q", num_results=2, highlights=True)
        assert all(isinstance(x.highlights, list) for x in h.results)
        assert h.results[0].highlights, "highlights mode should populate highlights"
        s = exa.search_and_contents("q", num_results=2, summary=True)
        assert s.results[0].summary is not None
    finally:
        os.environ.pop("UNBROWSE_EXA_DRYRUN", None)


def test_plain_search_shape():
    os.environ["UNBROWSE_EXA_DRYRUN"] = "1"
    try:
        r = M.Exa(api_key="test").search("hello", num_results=4)
        assert isinstance(r, M.SearchResponse) and len(r.results) == 4
        assert isinstance(r.results[0].url, str)
    finally:
        os.environ.pop("UNBROWSE_EXA_DRYRUN", None)


def test_async_client_surface():
    import asyncio
    os.environ["UNBROWSE_EXA_DRYRUN"] = "1"
    try:
        async def go():
            a = M.AsyncExa(api_key="test")
            r = await a.search_and_contents("q", num_results=2)
            return r
        r = asyncio.run(go())
        assert isinstance(r, M.SearchResponse) and len(r.results) == 2
    finally:
        os.environ.pop("UNBROWSE_EXA_DRYRUN", None)


if __name__ == "__main__":
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    passed = 0
    for fn in fns:
        try:
            fn(); print(f"PASS {fn.__name__}"); passed += 1
        except AssertionError as e:
            print(f"FAIL {fn.__name__}: {e}")
        except Exception as e:
            print(f"ERROR {fn.__name__}: {type(e).__name__}: {e}")
    print(f"\n{passed}/{len(fns)} green")
    sys.exit(0 if passed == len(fns) else 1)
