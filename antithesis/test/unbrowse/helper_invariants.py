"""The settlement invariants, read from the chain (and, for what a line was, from the payers' own receipt files):

  settlement-holds-no-unb                       there is no bond: Settlement holds no UNB at all
  settlement-usdc-equals-its-liabilities        USDC held == deposits + escrow + burn buffer + route shares held
  each-line-is-paid-at-most-once                no line claimed more often than it was signed; claimed <= cap, <= signed
  the-fetch-holds-exactly-what-it-owes          CoinFetch's USDC == what it accounts for: parked buys and what it owes
                                                contributors (`coin.split`)
  only-a-claims-contributors-are-owed           a claim makes the fetch owe only the credited contributors of the
                                                entries it paid; no server earns a share (`fees.server` = 0)
  the-route-share-stays-withdrawable            `CoinFetch.withdraw` fits the block gas limit for every contributor
                                                it owes

These are the forge invariants of unbrowse-settlement/test/lean/Invariants.t.sol, checked on the deployment the nodes
really use, under the traffic they really make. Every chain read is pinned to one block so a block mined between
two reads can't make the sums disagree. The receipt files are read after the chain: a line is written before it can
be claimed, so the files then hold every line the chain had claimed.

`check()` emits each assertion from one call site, so the anytime and finally commands share them.
"""

from antithesis.assertions import always, always_greater_than_or_equal_to, always_less_than_or_equal_to, always_or_unreachable, reachable, sometimes, unreachable

import helper_chain as C
import helper_nodes as N

USDC_UNITS = 10**6


def check():
    """Runs every settlement invariant once. Returns False when the chain couldn't be read (a fault): nothing judged."""
    try:
        return _check()
    except (C.ChainError, OSError) as e:  # a partition, a restart: the chain wasn't read, so nothing is judged
        print(f"settlement check skipped this round: {e}", flush=True)
        return False
    except (AttributeError, KeyError, ValueError, TypeError) as e:
        # The chain answered, in a shape these checks don't read: a harness that no longer matches the contracts.
        unreachable("the settlement invariants read the contracts in the shape they have", {"error": str(e)[:300]})
        return False


def _check():
    c = C.contracts()
    s, usdc, unb, fetch = c["settlement"], c["usdc"], c["unb"], c["fetch"]
    at = C.block_number()
    if C.rolled_back(at):
        print("settlement check skipped: the chain restarted from an older state", flush=True)
        return False

    claimed = s.logs("Claimed", at)
    # contributor and domain of every entry known, as the chain has them at `at` (there is no listing event).
    known = {e: s.call("entry", e, block=at) for e in C.entries_known(s, at)}
    wallets = {N.PLATFORM, *N.OWNER.values()}
    wallets |= {l["payer"].lower() for l in s.logs("Deposited", at)}
    agents = N.agents()
    wallets |= {a["address"] for a in agents}
    contributor_of = {e: v.contributor.lower() for e, v in known.items() if int(v.contributor, 16)}
    contributors = set(contributor_of.values())

    # settlement-holds-no-unb (Invariants.t.sol invariant_settlementHoldsNoUnb): there is no bond to hold, and every
    # unit the burn batch buys it destroys in the same call (R4.6).
    held_unb = unb.call("balanceOf", s.address, block=at)[0]
    always(held_unb == 0, "Settlement holds no UNB", {"block": at, "held": held_unb})

    # settlement-usdc-equals-its-liabilities (invariant_settlementUsdcEqualsItsLiabilities)
    deposits = sum(s.call("account", w, block=at)[0] for w in wallets)
    domains = {v.domainHash for v in known.values() if int(v.domainHash, 16)}
    escrow = sum(s.call("escrow", d, block=at)[0] for d in domains)
    burn_buffer = s.call("burnBuffer", block=at)[0]
    held_route = s.call("heldRoute", block=at)[0]
    held_usdc = usdc.call("balanceOf", s.address, block=at)[0]
    owed = deposits + escrow + burn_buffer + held_route
    always(held_usdc == owed, "Settlement's USDC equals its deposits, escrow, burn buffer and the route shares it holds", {"block": at, "held": held_usdc, "deposits": deposits, "escrow": escrow, "burn_buffer": burn_buffer, "held_route": held_route})

    # the-fetch-holds-exactly-what-it-owes (invariant_theFetchHoldsExactlyWhatItOwes): every unit a line sends the
    # fetch is owed to a contributor, parked for a buy, paid to stakers or spent on a buy within the claim.
    accounted = fetch.call("accounted", block=at)[0]
    fetch_usdc = usdc.call("balanceOf", fetch.address, block=at)[0]
    always(fetch_usdc == accounted, "the fetch holds exactly the USDC it accounts for", {"block": at, "held": fetch_usdc, "accounted": accounted})

    # Which node and key index each agent key is, from the workload's own record of the keys it made.
    index_of = {a["address"]: (a["node"], a["idx"]) for a in agents}
    lines = {}
    for name in N.CALLERS:
        for idx, epoch, line in N.receipts(name):
            lines.setdefault((name, idx), []).append((epoch, line))

    def signed_lines(agent, entry, index, epochs=None):
        name, idx = index_of.get(agent, (None, None))
        return [
            (e, l)
            for e, l in lines.get((name, idx), [])
            if l.get("passed") and str(l.get("entry", "")).lower() == entry and l.get("index") == index and (epochs is None or e in epochs)
        ]

    # each-line-is-paid-at-most-once
    times = {}
    for ev in claimed:
        key = (ev["payer"].lower(), ev["agent"].lower(), ev["entryId"].lower(), ev["index"])
        times[key] = times.get(key, 0) + 1
    sometimes(len(claimed) > 0, "a passed line was claimed on chain", {"claimed": len(claimed)})
    for (payer, agent, entry, index), n in times.items():
        if agent not in index_of:
            continue  # a key this workload didn't make: nothing on disk to compare with
        always_less_than_or_equal_to(n, len(signed_lines(agent, entry, index)), "no receipt line is claimed more often than it was signed", {"payer": payer, "agent": agent, "entry": entry, "index": index})
    for agent, (name, idx) in index_of.items():
        payer = N.OWNER[name]
        signed_units = sum(round(l["amount"] * USDC_UNITS) for _e, l in lines.get((name, idx), []) if l.get("passed"))
        paid_units = sum(ev["amount"] for ev in claimed if ev["agent"].lower() == agent)
        always_less_than_or_equal_to(paid_units, signed_units, "an agent key is never paid out more than its node signed for", {"agent": agent})
        for epoch in sorted({e for e, _l in lines.get((name, idx), [])}):
            got = s.call("claimedOf", payer, agent, epoch, block=at)[0]
            cap = s.call("termsFor", payer, agent, epoch, block=at)[0]
            always_less_than_or_equal_to(got, cap, "the claims of an epoch never pass its agent key's cap", {"agent": agent, "epoch": epoch})

    # only-a-claims-contributors-are-owed: the fetch owes a claim's route share to the credited contributor of an entry
    # it paid, and to nobody else; no server is paid a share of a line (`fees.server` = 0).
    owed_ev = fetch.events["ContributorOwed"]
    for tx in sorted({ev["tx"] for ev in claimed}):
        r = C.receipt(tx)
        if not r:
            continue
        paid = {ev["entryId"].lower() for ev in claimed if ev["tx"] == tx}
        for l in r["logs"]:
            if l["address"].lower() != fetch.address.lower() or l["topics"][0] != fetch.topic("ContributorOwed"):
                continue
            v = fetch.decode_log(owed_ev, l)
            entry, who = v["entryId"].lower(), v["contributor"].lower()
            always(entry in paid, "the fetch owes a route share only for an entry the claim paid", {"tx": tx, "entry": entry})
            # Credit can move to an earlier listing of the same body, so the contributor is read as of the claim's block.
            credited = s.call("entry", entry, block=int(r["blockNumber"], 16)).contributor.lower()
            always(who == credited, "a route share is owed to the entry's credited contributor", {"tx": tx, "entry": entry, "owed": who, "credited": credited})
            sometimes(True, "a claim's route share was owed to its contributor", {"tx": tx})

    # the-route-share-stays-withdrawable: every contributor the fetch owes can take it, within a block.
    limit = C.block_gas_limit()
    for w in contributors | {l["contributor"].lower() for l in fetch.logs("ContributorOwed", at)}:
        if fetch.call("owedOf", w, block=at)[0] == 0:
            continue
        reachable("a contributor had route shares to withdraw from the fetch", {"wallet": w})
        try:
            gas = fetch.estimate("withdraw", w)
        except C.ChainError as e:
            # Withdrawn meanwhile is fine; any other failure is the withdrawal not fitting or reverting.
            always_or_unreachable("NothingOwed" in str(e) or ("0x" + C.keccak256(b"NothingOwed()")[:4].hex()) in str(e), "withdrawing a route share never fails for a contributor who is owed one", {"wallet": w, "error": str(e)[:300]})
            continue
        always_less_than_or_equal_to(gas, limit, "withdrawing a route share fits in a block", {"wallet": w})
    sometimes(True, "the settlement invariants were all checked on the chain", {"block": at})
    return True


REGISTRY = "0x8004A818BFB912233c491871b3d84c89A494BD9e"


def identities():
    """one-erc8004-identity-per-owner: each node's owner registers one ERC-8004 identity, however its boots and
    republishes interleave. Read from the registry's own `Registered` logs."""
    topic = "0x" + C.keccak256(b"Registered(uint256,string,address)").hex()
    try:
        logs = C.rpc("eth_getLogs", [{"address": REGISTRY, "fromBlock": "0x0", "toBlock": "latest", "topics": [topic]}], timeout=30)
    except C.ChainError:
        return
    count = {}
    for l in logs:
        owner = "0x" + l["topics"][2][-40:]
        count[owner] = count.get(owner, 0) + 1
    for name, owner in N.OWNER.items():
        always_less_than_or_equal_to(count.get(owner, 0), 1, "an owner registers at most one ERC-8004 identity", {"node": name})


def ledgers():
    """receipt-ledger-never-shrinks: a receipt file only grows. The workload keeps each file's high-water mark; a
    file read shorter than its mark lost lines (and their indexes would be signed again)."""
    marks = N.recall("ledger-marks", {})
    for name in N.CALLERS:
        try:
            lines = N.receipts(name)
        except (OSError, ValueError):
            continue  # caught mid-write: next time
        sizes = {}
        for idx, epoch, _l in lines:
            sizes[f"{name}/{idx}-{epoch}"] = sizes.get(f"{name}/{idx}-{epoch}", 0) + 1
        for k, n in sizes.items():
            always_greater_than_or_equal_to(n, marks.get(k, 0), "a receipt file never holds fewer lines than it once did", {"file": k})
            marks[k] = max(n, marks.get(k, 0))
        for k in [k for k in marks if k.startswith(f"{name}/") and k not in sizes]:
            unreachable("a receipt file that held lines is lost", {"file": k})
    N.remember("ledger-marks", marks)
