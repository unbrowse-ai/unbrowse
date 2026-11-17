#!/usr/bin/env python3
"""An agent on a caller node uses the shop through the network: it names a goal (read or write) or calls an entry,
so its node finds node-1's signed listing, pays for the body within its key's cap, fetches it from whichever node
serves it, checks it and runs it itself under its own session. A burst of calls at once, from the cap's family of
sizes, is what makes calls race for the cap's last room. (Whether a delisted route stops running from kept copies is
checked once faults stop, in eventually_network_recovers.py: a read route may run on while its node can't read the
chain.)

Every attempt is recorded before it is sent and its outcome after, so the final checks can bound the lines written
between what was acknowledged and what was tried. A failed call is the network or a fault at work, never a finding by
itself; the findings are the assertions.
"""

import json
import os
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor

from antithesis.assertions import always_or_unreachable, reachable, sometimes
from antithesis.random import get_random, random_choice

import helper_nodes as N

FEE = 0.5
FEES = [0.1, FEE - 0.01, FEE, FEE + 0.01, 1.0]  # what the owner driver may set (parallel_driver_owner.py)
CAP = 5.0
# Menu axis: the burst sizes around the cap's room in calls (CAP / FEE = 10), and the query values the route fills.
PER_CAP = int(CAP / FEE)
BURSTS = [1, 2, PER_CAP - 1, PER_CAP, PER_CAP + 1]
QUERIES = ["desk lamps", "", "a", "lámpara", "%25&q=1#x", "x" * 2048]


def weights():
    """Shape axis: how this timeline leans between the kinds of call, drawn once per timeline and kept."""
    w = N.recall("call-weights")
    if w is None:
        w = {k: random_choice([0, 1, 5, 20]) for k in ("read_goal", "write_goal", "call_items", "call_cart", "call_lookup", "search")}
        if not any(w.values()):
            w["read_goal"] = 1
        N.remember("call-weights", w)
    return w


def pick(w):
    total = sum(w.values())
    at = get_random() % total
    for k, v in w.items():
        if at < v:
            return k
        at -= v
    return "read_goal"


def seen():
    try:
        with urllib.request.urlopen(N.SEEN, timeout=5) as r:
            return json.loads(r.read())
    except Exception:
        return None


def one(name, agent, kind, entries):
    q = random_choice(QUERIES)
    with N.db() as c:
        cur = c.execute("INSERT INTO calls VALUES (?, ?, 'attempt', 0, '', 0, ?)", (time.time(), name, json.dumps({"kind": kind})))
        row = cur.lastrowid
    token = agent["token"]
    try:
        if kind == "search":
            routes = N.agent(name, token).search("search items shop.example.com")
            sometimes(any(getattr(r, "remote", False) for r in routes), "a caller's search finds the contributor's listing", {"node": name})
            status, reply = 200, {"search": len(routes)}
        elif kind in ("read_goal", "write_goal"):
            # A goal is matched to a listing by its words (api/goal.rs `goal_words`): "look up items" finds the route listed
            # with read words that writes, which a read goal must be refused.
            goal = random_choice(["search items", "look up items"]) if kind == "read_goal" else "add an item to the cart"
            status, reply = N.agent_post(name, token, "/v1/do", {"goal": goal, "url": f"{N.SITE}/?q=lamps", "inputs": {"q": q}})
        else:
            # route-lookup lists the same body as route-cart: either entry's voucher is paid for as that entry.
            entry = entries[{"call_items": "route-items", "call_cart": "route-cart", "call_lookup": "route-lookup"}[kind]]
            status, reply = N.agent_post(name, token, f"/v1/routes/{entry}/call", {"inputs": {"q": q}})
    except N.NodeDown as e:
        with N.db() as c:
            c.execute("UPDATE calls SET outcome = 'unreachable', detail = ? WHERE rowid = ?", (str(e)[:200], row))
        return
    except Exception as e:  # the SDK's own errors: a refusal or a fault, recorded
        status, reply = getattr(e, "status", 0), {"error": str(e)[:300]}
    result = (reply or {}).get("result", reply) if isinstance(reply, dict) else {}
    net = (result or {}).get("network") or {}
    paid = (result or {}).get("paid_usdc") or 0
    ok = status == 200 and (kind == "search" or bool((result or {}).get("ok")))
    with N.db() as c:
        c.execute(
            "UPDATE calls SET outcome = ?, paid = ?, served_by = ?, cached = ?, detail = ? WHERE rowid = ?",
            ("ok" if ok else f"refused-{status}", paid, str(net.get("served_by") or "").lower(), int(bool(net.get("cached"))), json.dumps({"kind": kind, "reply": str(reply)[:400]}), row),
        )
    check(name, kind, status, reply, result, net, paid, ok)


def check(name, kind, status, reply, result, net, paid, ok):
    me = N.OWNER[name]
    if ok and net and not net.get("cached"):
        server = str(net.get("served_by") or "").lower()
        # A server whose standing the caller couldn't confirm is named as none (share.rs): the line pays no server.
        sometimes(not server, "a paid fetch's server couldn't be named", {"node": name})
        if server:
            always_or_unreachable(server in N.OWNER.values() and server != me, "a paid fetch names another node that holds the body as its server", {"node": name, "server": server})
            sometimes(server == N.OWNER["node-2"] and name == "node-3", "a body was served by a seeder rather than its contributor", {"server": server})
        always_or_unreachable(paid <= max(FEES) + 1e-9, "a call pays no more than the highest fee the contributor sets", {"node": name, "paid": paid})
        reachable("a caller paid for a body, fetched it and ran it itself", {"node": name, "paid": paid})
    if ok and net.get("cached"):
        always_or_unreachable(not paid, "a caller runs a kept body again without paying", {"node": name, "paid": paid})
    if ok and kind in ("write_goal", "call_cart", "call_lookup"):
        reachable("a route that writes ran for a call that asks for a change", {"node": name, "kind": kind})
    if kind == "write_goal":
        # listings-of-one-body-all-count (spec R2.16, R2.21, R2.22): "Add an item to the cart" is route-cart's listing;
        # route-lookup lists the same body in read words, so the two listings name one entry. Listings only accumulate,
        # so a write goal still finds the body by the first listing's words, from the network or from its kept copy.
        how = reply.get("how") if isinstance(reply, dict) else None
        sometimes(status == 200 and how in ("network", "called"), "a write goal finds its route by its own listing's words though another listing shares the body (R2.16, R2.21)", {"node": name, "status": status, "how": how})
    if kind == "call_lookup":
        # every-listed-entry-is-served-even-when-its-body-is-shared: the second entry of a shared body is served too.
        sometimes(ok and bool(net) and not net.get("cached"), "an entry whose body another entry also lists was paid for and fetched", {"node": name, "status": status})


def main():
    entries = N.recall("entries")
    if not entries:
        return
    w = weights()
    name = random_choice(N.CALLERS)
    keys = N.agents(name)
    if not keys:
        return
    agent = random_choice(keys)
    burst = random_choice(BURSTS)
    kinds = [pick(w) for _ in range(burst)]
    before = seen()
    with ThreadPoolExecutor(max_workers=burst) as pool:
        list(pool.map(lambda k: one(name, agent, k, entries), kinds))
    after = seen()
    if before is not None and after is not None:
        # The site hears only the callers, each under its own session: never the contributor or a node that only
        # served a body, and never one caller's session from another.
        for r in after[len(before):]:
            cookie = r.get("cookie", "")
            always_or_unreachable(cookie in ("", "sid=node-2-session", "sid=node-3-session"), "the shop hears a caller only under that caller's own session", {"cookie": cookie, "line": r.get("line")})


if __name__ == "__main__":
    main()
