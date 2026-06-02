"""Each test proves one sentence of Paper 1's adoption condition + three-tier fee
model (*Internal APIs Are All You Need*, arXiv:2604.00694)."""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from adoption.adoption import Tiers, route_fee, adopts_graph, cheapest_path  # noqa: E402


def test_adopts_when_total_fee_below_rediscovery():
    # the necessary condition: f_route < c_rediscovery -> adopt
    t = Tiers(tier3_per_query=10)
    assert adopts_graph(t, rediscovery_cost=100)        # 10 < 100
    assert not adopts_graph(t, rediscovery_cost=5)      # 10 !< 5 -> defect


def test_self_correcting_defect_to_browser_when_overcharged():
    # if the graph fee exceeds browser rediscovery, the rational agent walks away
    t = Tiers(tier3_per_query=500)
    path, cost = cheapest_path(cache_hit=False, tiers=t, rediscovery_cost=100)
    assert path == "browser" and cost == 100            # platform take is capped


def test_three_tiers_sum_into_the_route_fee():
    t = Tiers(tier3_per_query=3, tier1_install=20, tier2_per_exec=5, tier2_opted=True)
    # uses=1: 3 + 20/1 + 5 = 28
    assert route_fee(t, uses=1) == 28
    # tier2 not opted -> excluded
    t2 = Tiers(tier3_per_query=3, tier1_install=20, tier2_per_exec=5, tier2_opted=False)
    assert route_fee(t2, uses=1) == 23


def test_install_fee_amortizes_over_reuse():
    t = Tiers(tier3_per_query=1, tier1_install=100)
    once = route_fee(t, uses=1)        # 1 + 100 = 101
    many = route_fee(t, uses=100)      # 1 + 1  = 2
    assert once == 101 and many == 2 and many < once   # reuse makes the graph cheap


def test_three_path_ladder_picks_the_cheapest_rung():
    t = Tiers(tier3_per_query=10)
    # cache hit -> free, no fee
    assert cheapest_path(True, t, rediscovery_cost=100) == ("cache", 0.0)
    # cache miss, graph cheaper than browser -> graph
    assert cheapest_path(False, t, rediscovery_cost=100) == ("graph", 10)
    # cache miss, graph dearer than browser -> browser
    assert cheapest_path(False, Tiers(tier3_per_query=200), 100) == ("browser", 100)


def test_adoption_holds_only_strictly_below_cost():
    # boundary: equal fee and cost -> NOT adopted (strict inequality, paper Eq.)
    t = Tiers(tier3_per_query=100)
    assert not adopts_graph(t, rediscovery_cost=100)
    assert adopts_graph(t, rediscovery_cost=100.01)


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
