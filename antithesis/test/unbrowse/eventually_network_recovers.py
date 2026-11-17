#!/usr/bin/env python3
"""Once faults stop, the network comes back by itself:

  nodes-booting-together-find-each-other, admission-recovers-after-registry-stall,
  node-on-network-after-first-publish-fails, boot-failures-heal-without-restart: every caller on the peer network
  finds node-1's signed listing for the shop through the peer network again (the search reply carries `checked`),
  within a deadline, with no restart.
  a-delisted-or-superseded-route-is-not-run-from-cache: an entry still delisted on chain runs from no kept copy once
  `LIVE_FOR` has passed since its delist and each node can read the chain again.

Holding is no longer written to the chain (route stakes, which kept it, are gone; `held.json` is the whole record), so
there is no on-chain hold for `held.json` to converge to.

A caller the owner driver left off the peer network is put back first: being off is the owner's choice, not a fault.
That setting takes effect at the node's next start, so it is put back on every try until the node answers.
"""

import time

from antithesis.assertions import always, always_or_unreachable

import helper_chain as C
import helper_nodes as N

DEADLINE = 600  # the join backoff tops out at 2 min and admission's at 5 min (node.rs), plus a background pass
LIVE_FOR = 10 * 60  # share.rs LIVE_FOR: how long a kept read route trusts the chain's last word that its entry is live


def back_on(name):
    try:
        status, s = N.owner(name, "settings")
        if status == 200 and not s.get("peer_network", True):
            s["peer_network"] = True
            N.owner(name, "save_settings", {"settings": s})
    except N.NodeDown:
        pass


def relisted():
    """Faults stopping includes the owner driver's delists: the contributor lists its routes again, as an owner would,
    so a caller not finding a listing is the network's fault and never the absence of one. A route already listed is
    refused, which is fine."""
    for route in ("route-items", "route-cart", "route-lookup"):
        try:
            status, reply = N.owner(N.CONTRIBUTOR, "list_route", {"id": route})
            print(f"relist {route}: {status} {str(reply)[:160]}", flush=True)
        except N.NodeDown:
            pass


def finds(name):
    back_on(name)
    for a in N.agents(name):
        routes, by_peers = N.network_search(name, a["token"])
        if routes is None:
            continue  # a key revoked on the node: try the next
        return by_peers is True and any(r.get("remote") for r in routes)
    return False


def still_delisted():
    """Entries delisted on chain and not listed again, with the wall-clock time the owner driver delisted them."""
    s = C.contracts()["settlement"]
    out = {}
    for route, entry in (N.recall("entries") or {}).items():
        entry = entry.lower()
        delisted = any(l["entryId"].lower() == entry for l in s.logs("EntryDelisted"))
        if delisted and not s.call("entry", entry).live:
            out[entry] = N.recall(f"delisted-at:{entry}", 0)
    return out


def main():
    if not N.recall("roles"):
        return
    try:
        if C.rolled_back(C.block_number()):
            return
    except C.ChainError:
        pass
    relisted()
    start = time.time()
    for name in N.CALLERS:
        ok = N.wait(lambda: finds(name), max(1, DEADLINE - (time.time() - start)), every=5)
        always(bool(ok), "after faults stop every caller finds the contributor's listing through the peer network", {"node": name, "seconds": round(time.time() - start)})

    gone = N.wait(still_delisted, 60, every=5) or {}
    if gone:
        time.sleep(max(0, min(LIVE_FOR + 90 - (time.time() - min(gone.values())), LIVE_FOR + 90)))
    for entry in gone:
        for name in N.CALLERS:
            for a in N.agents(name)[:1]:
                try:
                    status, reply = N.agent_post(name, a["token"], f"/v1/routes/{entry}/call", {"inputs": {"q": "desk lamps"}})
                except N.NodeDown:
                    continue
                cached = isinstance(reply, dict) and reply.get("ok") and (reply.get("network") or {}).get("cached")
                always_or_unreachable(not cached, "a delisted route stops running from kept copies once faults stop", {"node": name, "entry": entry, "status": status})


if __name__ == "__main__":
    main()
