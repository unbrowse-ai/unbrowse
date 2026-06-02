"""Rational adoption of the shared route graph — Paper 1's necessary condition
(*Internal APIs Are All You Need*, arXiv:2604.00694; sp-toll adoption atom).

The paper's three-tier x402 fee model and the ONE inequality that governs all of
it, in runnable form. From the abstract: "All tiers are grounded in a necessary
condition for rational adoption: an agent uses the shared graph only when the total
fee is lower than the expected cost of browser rediscovery."

  Tier 1  one-time install fee for the discovery documentation (amortized over uses)
  Tier 2  optional per-execution fee for site owners who opt in
  Tier 3  per-query search fee for a graph lookup

  adopt  iff  f_route < c_rediscovery      (f_route = the total fee the agent pays)

Adoption is voluntary and self-correcting: if the graph ever overcharges past the
browser's rediscovery cost, the rational agent defects to the browser — which caps
what the platform can take. The three-path execution (cache -> graph -> browser) is
the cheapest-rung walk over exactly these costs.
"""
from __future__ import annotations
from dataclasses import dataclass


@dataclass
class Tiers:
    """The three x402 fee tiers (per the paper). Costs in the same unit as
    rediscovery cost (e.g. USDC cents or seconds-of-compute)."""
    tier3_per_query: float = 0.0   # per graph lookup
    tier1_install: float = 0.0     # one-time, amortized over `uses`
    tier2_per_exec: float = 0.0    # optional, only if the site owner opted in
    tier2_opted: bool = False


def route_fee(tiers: Tiers, uses: int = 1) -> float:
    """f_route — the total fee an agent pays to use the shared graph for one task,
    with the one-time install amortized over how many times the route is reused."""
    install = tiers.tier1_install / max(uses, 1)
    exec_fee = tiers.tier2_per_exec if tiers.tier2_opted else 0.0
    return tiers.tier3_per_query + install + exec_fee


def adopts_graph(tiers: Tiers, rediscovery_cost: float, uses: int = 1) -> bool:
    """The necessary condition for rational adoption: f_route < c_rediscovery."""
    return route_fee(tiers, uses) < rediscovery_cost


def cheapest_path(cache_hit: bool, tiers: Tiers, rediscovery_cost: float,
                  uses: int = 1) -> tuple[str, float]:
    """Three-path execution as the cheapest-rung walk: cache (free) -> graph (fee,
    only if it undercuts the browser) -> browser (rediscovery cost). Returns the
    path taken and what it cost."""
    if cache_hit:
        return ("cache", 0.0)                       # the memoized fast path is free
    if adopts_graph(tiers, rediscovery_cost, uses):
        return ("graph", route_fee(tiers, uses))    # voluntary: only when cheaper
    return ("browser", rediscovery_cost)            # self-correcting fallback
