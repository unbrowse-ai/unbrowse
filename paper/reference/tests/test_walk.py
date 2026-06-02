"""Each test proves one sentence of the index-of-the-internet walk (sp-unbrowse:
tree + walk + verb + settle atoms, arXiv:2604.00694)."""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from walk.route_graph import (  # noqa: E402
    Route, RouteGraph, walk, freshness,
    W_EMBED, W_RELIABILITY, W_FRESHNESS, W_VERIFICATION)


def _route(domain, endpoint, emb, **kw):
    return Route(domain=domain, endpoint=endpoint, method="GET",
                 schema={"q": "string"}, auth="bearer", embedding=emb, **kw)


def test_composite_weights_are_the_papers_and_sum_to_one():
    assert (W_EMBED, W_RELIABILITY, W_FRESHNESS, W_VERIFICATION) == (0.40, 0.30, 0.15, 0.15)
    assert abs(W_EMBED + W_RELIABILITY + W_FRESHNESS + W_VERIFICATION - 1.0) < 1e-9


def test_freshness_decays_by_the_law():
    assert freshness(0) == 1.0
    assert abs(freshness(30) - 0.5) < 1e-9          # 1/(1+30/30) = 0.5
    assert freshness(120) < freshness(30)            # older = less trusted


def test_index_is_pointers_merged_at_the_domain_level():
    g = RouteGraph()
    g.add(_route("site.com", "/api/a", (1, 0), reliability=0.9, verified=1))
    g.add(_route("site.com", "/api/b", (0, 1), reliability=0.9, verified=1))
    g.add(_route("other.com", "/api/c", (1, 1), reliability=0.9, verified=1))
    assert set(g.by_domain) == {"site.com", "other.com"}   # merged at domain level
    assert len(g.by_domain["site.com"]) == 2
    assert len(g.routes()) == 3                            # pointers, not a web copy


def test_incomplete_node_is_rejected():
    g = RouteGraph()
    try:
        g.add(Route(domain="x.com", endpoint="/a", schema={}, auth=""))  # no schema/auth
        assert False, "incomplete node was admitted"
    except ValueError:
        pass


def test_composite_scoring_ranks_the_best_route_first():
    g = RouteGraph()
    weak = _route("a.com", "/weak", (1, 0), reliability=0.1, days_since=200, verified=0.0)
    strong = _route("b.com", "/strong", (1, 0), reliability=0.95, days_since=1, verified=1.0)
    g.add(weak); g.add(strong)
    ranked = g.rank((1, 0))                  # identical embedding match for both
    assert ranked[0].endpoint == "/strong"   # reliability+freshness+verification win


def test_walk_climbs_cache_then_graph_then_browser():
    g = RouteGraph()
    # empty graph -> cache miss, graph miss, browser discovers and publishes
    discovered = {"hit": False}
    def browser(intent):
        discovered["hit"] = True
        return _route("new.com", "/found", (1, 0), reliability=1.0, days_since=0, verified=1.0)
    r1 = walk("buy a flight", (1, 0), g, browser=browser)
    assert r1["verb"] == "browser" and r1["path"] == ["cache", "graph", "browser"]
    assert discovered["hit"] and r1["route"].domain == "new.com"
    assert len(g.routes()) == 1               # published back into the shared index

    # second walk for the same intent is FREE — the cache answers, no escalation
    r2 = walk("buy a flight", (1, 0), g, browser=lambda i: None)
    assert r2["verb"] == "cache" and r2["path"] == ["cache"]


def test_graph_route_answers_before_the_browser_when_a_settled_route_exists():
    g = RouteGraph()
    g.add(_route("api.com", "/route", (1, 0), reliability=0.95, days_since=0, verified=1.0))
    called = {"browser": False}
    def browser(intent):
        called["browser"] = True
        return None
    r = walk("get data", (1, 0), g, browser=browser)
    assert r["verb"] == "graph" and r["path"] == ["cache", "graph"]
    assert called["browser"] is False         # browser is the fallback, never the substrate


def test_broken_route_is_disabled_and_drops_from_the_walk():
    g = RouteGraph()
    g.add(_route("dead.com", "/gone", (1, 0), reliability=0.99, verified=1.0, disabled=True))
    r = walk("get data", (1, 0), g, browser=lambda i: None)
    assert r["route"] is None                 # confirmed-broken routes drop from search


def test_settle_by_reliability_quorum_or_freshness_clock():
    quorum_only = _route("a.com", "/a", (1, 0), reliability=0.9, days_since=999, verified=0)
    fresh_only = _route("b.com", "/b", (1, 0), reliability=0.0, days_since=0, verified=0)
    stale_weak = _route("c.com", "/c", (1, 0), reliability=0.1, days_since=999, verified=0)
    assert quorum_only.settled()              # reliability quorum
    assert fresh_only.settled()               # freshness clock
    assert not stale_weak.settled()           # neither -> not trusted


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
