#!/usr/bin/env python3
"""The workload container's entrypoint: gives the three nodes their roles, then tells Antithesis setup is complete
and stays up so test commands can run here.

  node-1  the contributor: sets its fee and lists the shop's three routes (a search; one that
          writes; and the same call as the one that writes, listed again in a search's words, so two entries list
          byte-identical bodies under one content id).
  node-2  a caller, and the seeder: deposits and makes an agent key with a cap.
  node-3  a caller: the same. The owner driver turns light mode on and off for it.

Setup runs before any fault, so it may wait as long as the nodes need. Each step is recorded once done, so a
restarted workload container picks up where it stopped and only signals again.
"""

import subprocess
import sys
import time

sys.path.insert(0, "/opt/antithesis/test/v1/unbrowse")

import helper_nodes as N  # noqa: E402

FEE = 0.5
DEPOSIT = 100.0
CAP = 5.0


def say(*a):
    print("workload setup:", *a, flush=True)


def must(name, cmd, args, tries=60):
    """An owner command that has to work for the roles to stand: retried while the node or its chain settles."""
    last = None
    for _ in range(tries):
        try:
            status, reply = N.owner(name, cmd, args)
        except N.NodeDown as e:
            status, reply = 0, str(e)
        if status == 200:
            return reply
        last = (status, reply)
        time.sleep(3)
    raise SystemExit(f"{name} {cmd} {args}: {last}")


def main():
    N.wait(lambda: all(N.up(n) for n in N.NODES), 600) or sys.exit("the nodes never answered")
    N.wait(lambda: all(N.owner_token(n) for n in N.NODES), 120) or sys.exit("no owner token")
    def once(step, do):
        if not N.recall(f"setup:{step}"):
            do()
            N.remember(f"setup:{step}", True)

    # The routes are listed as soon as the nodes answer, while they may still be meeting each other before their
    # ERC-8004 metadata lands: a peer the registry doesn't list yet is asked again within seconds, so the callers
    # finding the listing below is a-site-listed-by-nodes-booting-together-is-found, not a wait.
    if not N.recall("roles"):
        once("fee", lambda: must("node-1", "set_pricing", {"fee": FEE, "auto": False, "floor": 0.1, "ceiling": 1.0}))
        entries = N.recall("entries", {})
        for route in ("route-items", "route-cart", "route-lookup"):
            if route not in entries:
                entries[route] = must("node-1", "list_route", {"id": route})["listing"]["entry_id"]
                N.remember("entries", entries)
        say("node-1 listed", entries)
        for name in N.CALLERS:
            if N.agents(name):
                continue
            once(f"deposit:{name}", lambda: must(name, "deposit", {"amount": DEPOSIT}))
            made = must(name, "agent_create", {"name": "workload", "cap_usdc": CAP, "days": 365})
            # The token comes on the owner's signed answer alone (`NewAgent.token`), never in the setup text.
            token = made["token"]
            a = made["agent"]
            if not a.get("tx"):
                say(name, "the agent key wasn't authorised on the chain; its calls are refused until it is")
            with N.db() as c:
                c.execute("INSERT OR REPLACE INTO agents VALUES (?, ?, ?, ?, ?)", (name, a["index"], a["address"].lower(), token, CAP))
            say(name, "agent", a["index"], a["address"])
        N.remember("roles", True)

    # Ready means each caller can see the contributor's listing for the shop. A node that can't yet is the network
    # still forming; setup gives it time but doesn't wait forever: finding each other is itself a property.
    def found(name):
        routes, by_peers = N.network_search(name, N.agents(name)[0]["token"])
        return by_peers is True and any(r.get("remote") for r in routes)

    for name in N.CALLERS:
        say(name, "finds the listing" if N.wait(lambda: found(name), 240, every=3) else "doesn't find the listing yet")

    subprocess.run(["/usr/local/bin/setup-complete.sh"], check=True)
    say("setup complete")
    while True:
        time.sleep(3600)


if __name__ == "__main__":
    main()
