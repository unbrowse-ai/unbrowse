"""Reads the chain the nodes settle on, over plain JSON-RPC, with the ABIs the node itself embeds
(unbrowse-node/app/contracts/*.json). Read only, except `advance_time`, the custom fault that jumps the chain's
clock, and `mine_epochs`, which moves its epoch the way days passing would.

Every call can fail under a fault: callers retry or give up for this round, never treat a failed read as a finding.
"""

import json
import os
import urllib.request

from Crypto.Hash import keccak

RPC = os.environ.get("UNBROWSE_RPC", "http://unbrowse-chain:8545")
CONTRACTS = "/opt/unbrowse-antithesis/contracts"
NETWORK_FILE = "/shared/arc-testnet.json"
# What an epoch is meant to last (R1.28). The chain counts it in blocks: `epochBlocks`.
EPOCH_SECONDS = 86400


class ChainError(Exception):
    pass


def keccak256(data: bytes) -> bytes:
    h = keccak.new(digest_bits=256)
    h.update(data)
    return h.digest()


def rpc(method, params, timeout=10):
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode()
    req = urllib.request.Request(RPC, data=body, headers={"content-type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as res:
            out = json.loads(res.read())
    except Exception as e:  # a partition, a restart, a timeout: the caller decides
        raise ChainError(f"{method}: {e}") from None
    if "error" in out:
        raise ChainError(f"{method}: {out['error']}")
    return out["result"]


def deployment():
    with open(NETWORK_FILE) as f:
        return json.load(f)["deployment"]


# ---- ABI: just the static types the views here use ----

def _abi(name):
    with open(os.path.join(CONTRACTS, f"{name}.json")) as f:
        return json.load(f)["abi"]


def _sig(item):
    return f"{item['name']}({','.join(_type(i) for i in item['inputs'])})"


def _type(i):
    if i["type"].startswith("tuple"):
        return "(" + ",".join(_type(c) for c in i["components"]) + ")" + i["type"][5:]
    return i["type"]


class Out(tuple):
    """A call's results, by the names the ABI gives them: a contract that adds, drops or reorders a result then breaks
    the read that names it (AttributeError), instead of shifting every later value into the wrong name."""

    def __new__(cls, outputs, values):
        out = super().__new__(cls, values)
        out._names = {o["name"]: v for o, v in zip(outputs, values) if o.get("name")}
        return out

    def __getattr__(self, name):
        try:
            return self.__dict__["_names"][name]
        except KeyError:
            raise AttributeError(f"no result named {name!r}; the call gives {sorted(self.__dict__['_names'])}") from None


class Contract:
    def __init__(self, name, address):
        self.address = address
        self.fns = {}
        self.events = {}
        for item in _abi(name):
            if item.get("type") == "function":
                self.fns.setdefault(item["name"], item)
            elif item.get("type") == "event":
                self.events[item["name"]] = item

    def call(self, fn, *args, block="latest"):
        if isinstance(block, int):
            block = hex(block)
        item = self.fns[fn]
        data = "0x" + keccak256(_sig(item).encode())[:4].hex() + "".join(_word(a) for a in args)
        out = rpc("eth_call", [{"to": self.address, "data": data}, block])
        return Out(item["outputs"], _decode([o["type"] for o in item["outputs"]], bytes.fromhex(out[2:])))

    def estimate(self, fn, sender, *args):
        """The gas `fn` takes from `sender`, or the error the node would get sending it."""
        item = self.fns[fn]
        data = "0x" + keccak256(_sig(item).encode())[:4].hex() + "".join(_word(a) for a in args)
        return int(rpc("eth_estimateGas", [{"from": sender, "to": self.address, "data": data}]), 16)

    def topic(self, event):
        return "0x" + keccak256(_sig(self.events[event]).encode()).hex()

    def logs(self, event, to_block="latest", from_block=0):
        item = self.events[event]
        to = hex(to_block) if isinstance(to_block, int) else to_block
        raw = rpc("eth_getLogs", [{"address": self.address, "fromBlock": hex(from_block), "toBlock": to, "topics": [self.topic(event)]}], timeout=30)
        return [self.decode_log(item, l) for l in raw]

    def decode_log(self, item, log):
        indexed = [i for i in item["inputs"] if i["indexed"]]
        plain = [i for i in item["inputs"] if not i["indexed"]]
        out = {"tx": log["transactionHash"], "block": int(log["blockNumber"], 16)}
        for i, t in zip(indexed, log["topics"][1:]):
            out[i["name"]] = _decode([i["type"]], bytes.fromhex(t[2:]))[0] if i["type"] not in ("string", "bytes") else t
        values = _decode([i["type"] for i in plain], bytes.fromhex(log["data"][2:]))
        for i, v in zip(plain, values):
            out[i["name"]] = v
        return out


def _word(a):
    if isinstance(a, str) and a.startswith("0x") and len(a) == 42:
        return a[2:].lower().rjust(64, "0")
    if isinstance(a, str) and a.startswith("0x") and len(a) == 66:
        return a[2:]
    return int(a).to_bytes(32, "big").hex()


def _decode(types, data):
    out = []
    for n, t in enumerate(types):
        word = data[32 * n: 32 * n + 32]
        if t == "address":
            out.append("0x" + word[12:].hex())
        elif t == "bool":
            out.append(int.from_bytes(word, "big") != 0)
        elif t.startswith("uint") or t.startswith("int"):
            out.append(int.from_bytes(word, "big"))
        elif t == "bytes32":
            out.append("0x" + word.hex())
        elif t in ("string", "bytes"):
            at = int.from_bytes(word, "big")
            size = int.from_bytes(data[at: at + 32], "big")
            raw = data[at + 32: at + 32 + size]
            out.append(raw.decode(errors="replace") if t == "string" else raw)
        else:
            raise ValueError(f"no decoder for {t}")
    return out


def contracts():
    d = deployment()
    s = Contract("LeanSettlement", d["settlement"])
    return {
        "settlement": s,
        "usdc": Contract("USDC", d["usdc"]),
        "unb": Contract("UNB", d["unb"]),
        # The route share goes to the fetch, which owes it to the entry's contributor while the entry has no coin
        # (`coin.split`); stakes on route coins live in their own contract. Settlement names both.
        "fetch": Contract("CoinFetch", s.call("fetch")[0]),
        "coin_stakes": Contract("CoinStakes", s.call("coinStakes")[0]),
    }


def entries_known(s, to_block="latest"):
    """Every entry id the harness can know of: the ones the workload listed and the ones a claim paid. The chain keeps
    no listing event (listings travel signed on the peer network; Settlement holds only their roots), so an entry is
    read back with `entry(id)` instead."""
    import helper_nodes as N

    ids = {e.lower() for e in (N.recall("entries") or {}).values()}
    ids |= {l["entryId"].lower() for l in s.logs("Claimed", to_block)}
    return ids


def receipt(tx):
    return rpc("eth_getTransactionReceipt", [tx])


def block_number():
    return int(rpc("eth_blockNumber", []), 16)


def rolled_back(at):
    """Whether the chain is behind a block the workload has seen: a restarted Anvil reloads state saved up to a second
    before it stopped (`--state-interval 1`), which no real chain does, so nothing is judged across that. Remembers
    the highest block seen."""
    import helper_nodes as N

    high = N.recall("chain-high", 0)
    if at < high:
        return True
    N.remember("chain-high", at)
    return False


def block_gas_limit():
    return int(rpc("eth_getBlockByNumber", ["latest", False])["gasLimit"], 16)


def block_number():
    return int(rpc("eth_blockNumber", []), 16)


def advance_time(seconds):
    """Moves the chain's clock by `seconds` and mines one block: a jump of the block timestamp, which no epoch counts."""
    rpc("evm_increaseTime", [int(seconds)])
    rpc("evm_mine", [])


def mine_epochs(epochs, length):
    """Mines `epochs` of `length` blocks, the only way an epoch passes (R1.28), the clock moving at a day an epoch."""
    rpc("anvil_mine", [hex(epochs * length), hex(max(EPOCH_SECONDS // length, 1))])
