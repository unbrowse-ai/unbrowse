#!/usr/bin/env python3
"""The owners at work while agents call: one owner command on one node, drawn from the whole surface the property
catalog touches. The contributor reprices, delists and lists its routes again, and claims; the callers turn holding
(seeding) and light mode on and off, leave and rejoin the peer network, move their per-fetch maximum around the fee,
top up, ask to withdraw, collect what their earnings hold for them, make and revoke agent keys, and claim now.

A refused command is the node saying no (an empty balance, a route already listed, a fault): recorded, not judged.
What the commands must never do is break the settlement invariants or the network's properties, which the other
commands check.
"""

import time

from antithesis.assertions import reachable
from antithesis.random import get_random, random_choice

import helper_nodes as N

FEE = 0.5
# Menu axis: fees and per-fetch maximums around the fee a listing names, and amounts around nothing and the deposit.
FEES = [0.1, FEE - 0.01, FEE, FEE + 0.01, 1.0]
MAX_FETCH = [0.0, FEE - 0.01, FEE, FEE + 0.01, 5.0]
AMOUNTS = [0.000001, 0.01, 1.0, 99.0, 1000.0]


def settings_change(name, change):
    status, s = N.owner(name, "settings")
    if status != 200:
        return status, s
    change(s)
    return N.owner(name, "save_settings", {"settings": s})


def contributor_action():
    kind = random_choice(["set_pricing", "delist", "list", "claim_now", "share_status", "collect_earnings"])
    route = random_choice(["route-items", "route-cart", "route-lookup"])
    if kind == "set_pricing":
        return kind, N.owner("node-1", "set_pricing", {"fee": random_choice(FEES), "auto": random_choice([False, False, True]), "floor": 0.1, "ceiling": 1.0})
    if kind == "delist":
        out = N.owner("node-1", "delist_route", {"id": route})
        if out[0] == 200:
            entry = ((N.recall("entries") or {}).get(route) or "").lower()
            N.remember(f"delisted-at:{entry}", time.time())
            reachable("the contributor delisted a route other nodes may keep", {"route": route})
        return kind, out
    if kind == "list":
        return kind, N.owner("node-1", "list_route", {"id": route})
    return kind, N.owner("node-1", kind)


def caller_action(name):
    kind = random_choice(["hold", "light", "peer_network", "max_fetch", "deposit", "request_withdraw", "collect_earnings", "claim_now", "agent_create", "agent_revoke"])
    if kind == "hold":
        on = random_choice([True, False])
        return kind, settings_change(name, lambda s: s.__setitem__("hold_routes", on))
    if kind == "light":
        on = random_choice([True, False])
        return kind, settings_change(name, lambda s: s.__setitem__("light", on))
    if kind == "peer_network":
        on = random_choice([True, False, True])
        return kind, settings_change(name, lambda s: s.__setitem__("peer_network", on))
    if kind == "max_fetch":
        v = random_choice(MAX_FETCH)
        return kind, settings_change(name, lambda s: s.__setitem__("max_fetch_usdc", v))
    if kind in ("deposit", "request_withdraw"):
        return kind, N.owner(name, kind, {"amount": random_choice(AMOUNTS)})
    if kind == "agent_create":
        import re

        status, made = N.owner(name, "agent_create", {"name": f"workload-{get_random() % 1000}", "cap_usdc": random_choice([0.5, 5.0, 50.0]), "days": 365})
        found = re.search(r"UNBROWSE_AGENT_TOKEN=(\S+)", made.get("setup", "")) if status == 200 and isinstance(made, dict) else None
        if found:
            token = found.group(1)
            a = made["agent"]
            with N.db() as c:
                c.execute("INSERT OR REPLACE INTO agents VALUES (?, ?, ?, ?, ?)", (name, a["index"], a["address"].lower(), token, 0))
        return kind, (status, made)
    if kind == "agent_revoke":
        keys = N.agents(name)
        if len(keys) < 2:
            return kind, (0, "keeps its last key")
        a = random_choice(keys)
        out = N.owner(name, "agent_revoke", {"index": a["idx"]})
        if out[0] == 200:
            with N.db() as c:
                c.execute("DELETE FROM agents WHERE node = ? AND idx = ?", (name, a["idx"]))
        return kind, out
    return kind, N.owner(name, kind)


def main():
    if not N.recall("roles"):
        return
    name = random_choice(N.NODES)
    try:
        kind, (status, reply) = contributor_action() if name == N.CONTRIBUTOR else caller_action(name)
    except N.NodeDown as e:
        kind, status, reply = "unreachable", 0, str(e)
    with N.db() as c:
        c.execute("INSERT INTO owner_ops VALUES (?, ?, ?, ?, ?)", (time.time(), name, kind, status, str(reply)[:400]))


if __name__ == "__main__":
    main()
