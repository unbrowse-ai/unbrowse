"""The index of the internet, walked all the way up — the runnable core of
*Internal APIs Are All You Need* (arXiv:2604.00694), the tree + walk + verb atoms.

The shared route graph is an INDEX OF POINTERS, not a copy of the web: each node is
one callable first-party interface {domain, endpoint, method, schema, auth},
merged at the domain level. To answer an intent the orchestrator WALKS UP the verb
ladder — cache (read) -> graph (route) -> browser (discover) — escalating only on a
miss, and ranks graph candidates by the paper's composite score. A route is settled
by the continuous trust model: trusted by reliability OR decayed by freshness.

Weights and the freshness law are the paper's, not invented:
  composite = 0.40 embedding + 0.30 reliability + 0.15 freshness + 0.15 verification
  freshness(d) = 1 / (1 + d/30)
"""
from __future__ import annotations
import math
from dataclasses import dataclass, field

# the paper's composite weights (§ walk) — must sum to 1.0
W_EMBED, W_RELIABILITY, W_FRESHNESS, W_VERIFICATION = 0.40, 0.30, 0.15, 0.15


def freshness(days_since: float) -> float:
    """Trust decays as a route goes unverified: 1/(1 + d/30)."""
    return 1.0 / (1.0 + days_since / 30.0)


def cosine(a, b) -> float:
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a)) or 1.0
    nb = math.sqrt(sum(y * y for y in b)) or 1.0
    return dot / (na * nb)


@dataclass
class Route:
    domain: str
    endpoint: str
    method: str = "GET"
    schema: dict = field(default_factory=dict)
    auth: str = "public"         # auth DESCRIPTOR, never a credential; "public" = none needed
    permissioned: bool = False   # True only when the route is properly auth-gated
    reliability: float = 0.0     # [0,1] from execution feedback
    days_since: float = 0.0      # days since last verification
    verified: float = 0.0        # [0,1] from the automated verification loop
    embedding: tuple = ()        # intent embedding of the route
    disabled: bool = False       # confirmed-broken routes drop from search

    def well_formed(self) -> bool:
        # public internet for now: a node answers what(endpoint+schema)/where(domain)/
        # how(method). Auth is NOT required — a public route is complete without it.
        return bool(self.domain and self.endpoint and self.method and self.schema)

    def is_permissioned(self) -> bool:
        """A route is permissioned only when it BOTH opts in and names a real,
        non-public auth descriptor. Anything else is treated as public."""
        return bool(self.permissioned and self.auth not in ("public", "none", ""))

    def composite(self, query_emb) -> float:
        return (W_EMBED * cosine(self.embedding, query_emb)
                + W_RELIABILITY * self.reliability
                + W_FRESHNESS * freshness(self.days_since)
                + W_VERIFICATION * self.verified)

    def settled(self, quorum: float = 0.66, fresh_floor: float = 0.5) -> bool:
        """Continuous trust: reliability quorum OR the freshness clock."""
        if self.disabled:
            return False
        return self.reliability >= quorum or freshness(self.days_since) >= fresh_floor


class RouteGraph:
    """The shared index: pointers merged at the domain level. Not a copy of the web."""

    def __init__(self):
        self.by_domain: dict[str, list[Route]] = {}
        self.cache: dict[str, Route] = {}     # exact-intent 24h cache (the fast path)

    def add(self, route: Route) -> None:
        if not route.well_formed():
            raise ValueError(f"incomplete node (missing schema/auth): {route.endpoint}")
        self.by_domain.setdefault(route.domain, []).append(route)

    def routes(self) -> list[Route]:
        return [r for rs in self.by_domain.values() for r in rs]

    def rank(self, query_emb) -> list[Route]:
        live = [r for r in self.routes() if not r.disabled]
        return sorted(live, key=lambda r: r.composite(query_emb), reverse=True)

    def resolve(self, query_emb) -> Route | None:
        ranked = self.rank(query_emb)
        return ranked[0] if ranked else None


def seal(route: Route, credential: str | None = None) -> dict:
    """The boundary check before a request leaves — the seal atom, made conditional.

    Public internet for now: a public route seals to NOTHING (no auth header, no
    credential leaves the agent). Only a properly permissioned route attaches its
    auth descriptor, and then only if a credential was actually provided — so the
    default path is credential-free public access.
    """
    if not route.is_permissioned():
        return {}                                   # public: remove auth completely
    if not credential:
        raise PermissionError(
            f"route {route.endpoint} is permissioned ({route.auth}) but no credential provided")
    return {"authorization": f"{route.auth} {credential}"}


def walk(intent: str, query_emb, graph: RouteGraph, browser=None) -> dict:
    """Walk UP the verb ladder for `intent`. Escalate only on a miss.

    Returns {route, verb, path} — `verb` is the one that answered, `path` is the
    full ladder climbed. cache(read) -> graph(route) -> browser(discover).
    """
    path = []

    # verb 1 — cache (read): exact-intent hit, the memoised fast path
    path.append("cache")
    if intent in graph.cache and graph.cache[intent].settled():
        return {"route": graph.cache[intent], "verb": "cache", "path": path}

    # verb 2 — graph (route): composite-ranked resolution over the index
    path.append("graph")
    best = graph.resolve(query_emb)
    if best is not None and best.settled():
        graph.cache[intent] = best          # a fresh route makes the next walk free
        return {"route": best, "verb": "graph", "path": path}

    # verb 3 — browser (discover/make): the fallback, never the substrate
    path.append("browser")
    if browser is not None:
        discovered = browser(intent)        # capture -> reverse-engineer -> publish
        if discovered is not None:
            graph.add(discovered)           # publish back into the shared index
            graph.cache[intent] = discovered
            return {"route": discovered, "verb": "browser", "path": path}

    return {"route": None, "verb": None, "path": path}
