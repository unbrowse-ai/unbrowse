#!/usr/bin/env python3
"""A live network on one machine, with no containers: a chain, N real nodes, and checks on what they do.

antithesis/ runs the same idea under podman on Linux; this runs natively, so it scales past three nodes and works on a
Mac. It sets the chain up as antithesis/chain/entrypoint.sh does: an Anvil standing in for Arc testnet, the stand-in
ERC-8004 registry and a 6-decimal USDC at Arc's addresses, and the contracts deployed by the node's own
`chain deploy`. Every key is one of Anvil's published test keys: no real key, no real funds, no live chain.

    antithesis/local/netsim.py --bin <debug unbrowse-node> --repo . [--nodes 24] [--soak 180] [--seed N] [--old-bin <older build>]

It wants a debug build: a release build keeps its root key in the system's keystore, and this seeds each node's key
into its own folder. Prints one line a check and writes report.json. Exits 1 when a check fails. Routes point at
public JSON APIs, so no node needs a browser and no window opens.

What it can't do here: cut two nodes off from each other while both reach the chain (that needs netem; soak.sh does it
under podman), and it runs on one machine, so latency between peers is a loopback's.
"""
import argparse
import concurrent.futures
import json
import os
import pathlib
import random
import re
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

MNEMONIC = "test test test test test test test test test test test junk"
# An epoch here, in blocks (R1.28): few, so a day passes in a moment.
EPOCH_BLOCKS = 7200
REGISTRY = "0x8004A818BFB912233c491871b3d84c89A494BD9e"
USDC = "0x3600000000000000000000000000000000000000"
ZERO_WORD = "0x" + "0" * 64
FOUNDRY = pathlib.Path.home() / ".foundry/bin"

RESULTS = []


def log(*a, sep=" "):
    print(time.strftime("%H:%M:%S"), *a, sep=sep, flush=True)


def check(name, ok, detail=""):
    RESULTS.append({"check": name, "ok": bool(ok), "detail": str(detail)[:400]})
    log("PASS" if ok else "FAIL", name, "" if ok and not detail else f"({str(detail)[:200]})")
    return bool(ok)


def run(*cmd, env=None, timeout=240, ok=True):
    r = subprocess.run([str(c) for c in cmd], capture_output=True, text=True, env=env, timeout=timeout)
    if ok and r.returncode != 0:
        raise RuntimeError(f"{cmd[0]} {cmd[1] if len(cmd) > 1 else ''}: {(r.stderr or r.stdout)[-600:]}")
    return r.stdout.strip()


def wait(what, f, seconds, every=1.0):
    end = time.time() + seconds
    last = None
    while time.time() < end:
        try:
            last = f()
            if last:
                return last
        except Exception as e:  # a node still starting answers nothing
            last = None
            why = e
        time.sleep(every)
    return last


class Chain:
    def __init__(self, port, root):
        self.port, self.root = port, root
        self.rpc = f"http://127.0.0.1:{port}"
        self.proc = None

    def cast(self, *a, **k):
        return run(FOUNDRY / "cast", *a, **k)

    def rpc_call(self, method, *params):
        self.cast("rpc", "--rpc-url", self.rpc, method, *params)

    def start(self, accounts):
        logf = open(self.root / "anvil.log", "w")
        self.proc = subprocess.Popen(
            [FOUNDRY / "anvil", "--host", "127.0.0.1", "--port", str(self.port), "--chain-id", "5042002", "--base-fee", "20000000000",
             "--slots-in-an-epoch", "0", "--accounts", str(accounts), "--block-time", "1", "--silent"],
            stdout=logf, stderr=logf)
        wait("anvil", lambda: self.cast("chain-id", "--rpc-url", self.rpc, ok=False) == "5042002", 30, 0.2)

    def key(self, i):
        return self.cast("wallet", "private-key", "--mnemonic", MNEMONIC, "--mnemonic-index", i)

    def address(self, key):
        return self.cast("wallet", "address", "--private-key", key)

    def send(self, key, to, sig, *args):
        self.cast("send", "--rpc-url", self.rpc, "--private-key", key, to, sig, *args)

    def usdc_of(self, who):
        return int(self.cast("call", "--rpc-url", self.rpc, USDC, "balanceOf(address)(uint256)", who).split()[0])

    def nonce(self, who):
        return int(self.cast("nonce", "--rpc-url", self.rpc, who))

    def stop(self):
        if self.proc:
            self.proc.terminate()
            self.proc.wait(10)


class Relay:
    """A TCP relay to the chain that can be cut, for a node that loses the chain and keeps its peers."""

    def __init__(self, port, target):
        self.port, self.target, self.open = port, target, True
        self.srv = socket.create_server(("127.0.0.1", port))
        threading.Thread(target=self.loop, daemon=True).start()

    def loop(self):
        while True:
            c, _ = self.srv.accept()
            if not self.open:
                c.close()
                continue
            try:
                u = socket.create_connection(("127.0.0.1", self.target), 5)
            except OSError:
                c.close()
                continue
            for x, y in ((c, u), (u, c)):
                threading.Thread(target=self.pipe, args=(x, y), daemon=True).start()

    def pipe(self, x, y):
        try:
            while self.open:
                d = x.recv(65536)
                if not d:
                    break
                y.sendall(d)
        except OSError:
            pass
        for k in (x, y):
            try:
                k.close()
            except OSError:
                pass


class Node:
    def __init__(self, i, name, home, api, peer, key, address, binary, rpc):
        self.i, self.name, self.home, self.api, self.peer = i, name, home, api, peer
        self.key, self.address, self.binary, self.rpc = key, address, binary, rpc
        self.proc, self.token = None, None

    def env(self):
        e = {k: v for k, v in os.environ.items() if k in ("PATH", "TMPDIR", "LANG")}
        e.update(HOME=str(self.home), UNBROWSE_HOME=str(self.home / ".unbrowse"), UNBROWSE_CHAIN="arc-testnet", UNBROWSE_RPC=self.rpc,
                 UNBROWSE_PORT=str(self.api), UNBROWSE_PEER_PORT=str(self.peer), UNBROWSE_TELEMETRY="0")
        return e

    @property
    def data(self):
        return self.home / ".unbrowse"

    def seed(self, network_file):
        (self.data / "devnet").mkdir(parents=True, exist_ok=True)
        (self.data / "networks").mkdir(exist_ok=True)
        (self.data / "routes").mkdir(exist_ok=True)
        k = self.data / "devnet/root.key"
        k.write_text(self.key.removeprefix("0x"))
        k.chmod(0o600)
        (self.data / "networks/arc-testnet.json").write_text(json.dumps(network_file, indent=2))
        (self.data / "settings.json").write_text(json.dumps({
            "map_while_browsing": False, "hold_routes": False, "signed_in_calls": True, "paused": False, "api_port": self.api,
            "storage_gb": 1.0, "excluded": [], "share_routes": "all", "share_notice_seen": True, "share_previewed": True, "private_network": True,
            "peer_network": True, "light": False, "auto_update": False, "passkeys": False,
            "passkeys_never": [], "chain": "arc-testnet", "max_fetch_usdc": 0.5,
            # The harness's clients send a plain bearer token (`_post`): a scratch node takes it.
            "accept_bearer": True}))
        # The node holds off the network until its terms are acknowledged; a node with no window does it from a shell.
        subprocess.run([self.binary, "terms", "accept"], env=self.env(), stdout=subprocess.DEVNULL, check=True)

    def start(self):
        self.proc = subprocess.Popen([self.binary], env=self.env(), stdout=open(self.home / "node.log", "a"), stderr=subprocess.STDOUT,
                                     start_new_session=True)

    def kill(self, sig=signal.SIGKILL):
        if self.proc and self.proc.poll() is None:
            self.proc.send_signal(sig)
            if sig in (signal.SIGKILL, signal.SIGTERM):
                self.proc.wait(20)

    def http(self, method, path, token, body=None, timeout=90):
        data = None if body is None else json.dumps(body).encode()
        h = {"Authorization": f"Bearer {token}", "content-type": "application/json"} if token else {}
        req = urllib.request.Request(f"http://127.0.0.1:{self.api}{path}", data=data, headers=h, method=method)
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.status, json.loads(r.read() or b"null")
        except urllib.error.HTTPError as e:
            raw = e.read()
            try:
                return e.code, json.loads(raw)
            except ValueError:
                return e.code, {"error": raw[:300].decode(errors="replace")}

    def own(self, cmd, args=None, timeout=120):
        return self.http("POST", f"/owner/{cmd}", (self.data / "owner.token").read_text().strip(), args or {}, timeout)

    def agent(self, method, path, body=None, timeout=120):
        return self.http(method, path, self.token, body, timeout)

    def own_token(self):
        out = run(self.binary, "agent", "token", env=self.env(), ok=False, timeout=20).strip().splitlines()
        return out[-1].strip() if out and len(out[-1].strip()) > 20 and " " not in out[-1].strip() else None

    def health(self):
        return self.http("GET", "/v1/health", None, timeout=5)[1]

    def tail(self, n=12):
        try:
            return (self.home / "node.log").read_text(errors="replace").splitlines()[-n:]
        except OSError:
            return []


def route(rid, site, path, what, inp, default, shape):
    """A route to a public JSON API: learned by hand here, so no node needs a browser."""
    return {
        "id": rid, "site": site, "what": what, "method": "GET", "path": path, "root": f"https://{site}{path}?{inp}={default}",
        "inputs": [{"name": inp, "secret": False, "default": default}], "steps": 1, "browser_assisted": False, "write": False,
        "provisional": False, "learned_at": 1, "local": False,
        "graph": {"provisional": False, "steps": [{
            "exchange": 0, "method": "GET", "status": 200, "url": f"https://{site}{path}?{inp}={{{inp}}}", "needs_browser": False,
            "response_shape": shape,
            "fields": [{"loc": {"in": "query", "key": inp}, "class": "input", "name": inp, "secret": False, "default": default}]}]},
    }


ROUTES = [
    (route("books", "openlibrary.org", "/search.json", "Search books", "q", "dune", {"numFound": "number", "docs": [{"title": "string"}]}), "openlibrary.org"),
    # Filed under the registrable domain: the node keeps every subdomain of a site at one key.
    (route("stories", "hn.algolia.com", "/api/v1/search", "Search stories", "query", "rust", {"nbHits": "number", "hits": [{"title": "string"}]}), "algolia.com"),
    (route("papers", "api.crossref.org", "/works", "Search papers", "query", "graphs", {"status": "string", "message": {"total-results": "number"}}), "crossref.org"),
]


def bring_up(a, root):
    chain = Chain(a.chain_port, root)
    chain.start(a.nodes + 4)
    repo = pathlib.Path(a.repo)
    platform = chain.key(0)
    me = chain.address(platform)
    chain.rpc_call("anvil_setBalance", me, "0x21e19e0c9bab2400000")
    code = (repo / "unbrowse-node/app/tests/fixtures/erc8004/Erc8004StandIn.runtime.hex").read_text().strip()
    chain.rpc_call("anvil_setCode", REGISTRY, code if code.startswith("0x") else "0x" + code)
    bc = json.loads((repo / "unbrowse-node/app/contracts/USDC.json").read_text())["bytecode"]["object"]
    made = json.loads(chain.cast("send", "--rpc-url", chain.rpc, "--private-key", platform, "--json", "--create",
                                 bc + chain.cast("abi-encode", "constructor(uint8)", "6")[2:]))["contractAddress"]
    chain.rpc_call("anvil_setCode", USDC, chain.cast("code", "--rpc-url", chain.rpc, made))
    for slot in range(8):
        v = chain.cast("storage", "--rpc-url", chain.rpc, made, str(slot))
        if v != ZERO_WORD:
            chain.rpc_call("anvil_setStorageAt", USDC, "0x%064x" % slot, v)
    chain.send(platform, USDC, "faucet(address,uint256)", me, "100000000000")

    # The contracts, deployed the way an owner deploys them.
    deployer = root / "deployer"
    (deployer / ".unbrowse/devnet").mkdir(parents=True)
    (deployer / ".unbrowse/networks").mkdir()
    (deployer / ".unbrowse/devnet/root.key").write_text(platform.removeprefix("0x"))
    shipped = json.loads((repo / "unbrowse-node/app/networks/arc-testnet.json").read_text())
    shipped["deployment"], shipped["registry_from"], shipped["epoch_blocks"] = None, 0, EPOCH_BLOCKS
    (deployer / ".unbrowse/networks/arc-testnet.json").write_text(json.dumps(shipped))
    e = {k: v for k, v in os.environ.items() if k in ("PATH", "TMPDIR", "LANG")}
    e.update(HOME=str(deployer), UNBROWSE_HOME=str(deployer / ".unbrowse"), UNBROWSE_CHAIN="arc-testnet", UNBROWSE_RPC=chain.rpc,
             UNBROWSE_TELEMETRY="0")
    chain.rpc_call("anvil_mine", hex(EPOCH_BLOCKS))  # past epoch 0, as every chain Settlement runs on is
    out = run(a.bin, "chain", "deploy",
              "--pool", "1000", "1000", env=e, timeout=200)
    network = json.loads((deployer / ".unbrowse/networks/arc-testnet.json").read_text())
    network["registry_from"] = 0
    log("deployed: Settlement", network["deployment"]["settlement"])

    nodes = []
    for i in range(a.nodes):
        key = chain.key(i + 1)
        addr = chain.address(key)
        rpc = chain.rpc
        if i == a.nodes - 1:
            World.relay = Relay(a.chain_port + 1, a.chain_port)
            rpc = f"http://127.0.0.1:{a.chain_port + 1}"
        n = Node(i, f"n{i}", root / f"n{i}", a.api_port + i, a.peer_port + i, key, addr, a.bin, rpc)
        n.home.mkdir()
        n.seed(network)
        chain.rpc_call("anvil_setBalance", addr, "0x3635c9adc5dea00000")
        chain.send(platform, USDC, "faucet(address,uint256)", addr, "1000000000")
        nodes.append(n)
    return chain, network, nodes


def s_join(a, chain, network, nodes):
    """Every node comes up on the shared contracts and finds its peers."""
    for n in nodes:
        n.start()
    up = [wait(n.name, lambda n=n: n.health().get("alive"), 60) for n in nodes]
    check("join: every node answers", all(up), [n.name for n, u in zip(nodes, up) if not u])
    ready = [wait(n.name, lambda n=n: n.health().get("ready"), a.join_wait, 2) for n in nodes]
    if not check("join: every node is ready: chain, Settlement, keys, identity, network", all(ready), {n.name: n.health().get("checks") for n, r in zip(nodes, ready) if not r}):
        for n in nodes[:2]:
            log(n.name, "log tail:", *n.tail(6), sep="\n   ")


def s_probe(a, chain, network, nodes):
    for n in nodes:
        log(n.name, json.dumps(n.health())[:400])
        log(n.name, "log:", *n.tail(8), sep="\n   ")


def routes_of(v):
    return (v or {}).get("routes") or []


def search(n, words):
    return n.agent("GET", "/v1/routes?q=" + urllib.parse.quote(words), timeout=40)[1]


def remote(v, site):
    return [r for r in routes_of(v) if r.get("remote") and (r.get("listed_as") or {}).get("site") == site]


class World:
    """What the scenarios share: who listed what."""
    relay = None
    paid_units = 0
    paid_soak = []
    delisted_payers = []
    gone = {}
    entries = {}
    callers = []
    contributors = []


def s_setup(a, chain, network, nodes):
    """Contributors price and list a route each; callers fund a key to pay with."""
    W = World
    W.contributors, W.callers = nodes[: len(ROUTES)], nodes[len(ROUTES):]
    for n, (r, site) in zip(W.contributors, ROUTES):
        (n.data / "routes" / f"{r['id']}.json").write_text(json.dumps(r))
        n.kill(signal.SIGTERM)
        n.start()
        wait(n.name, lambda n=n: n.health().get("ready"), 60, 1)
        st, v = n.own("set_pricing", {"fee": 0.25, "auto": False, "floor": 0.1, "ceiling": 1.0})
        check(f"list: {n.name} sets its price", st == 200, v)
        st, v = n.own("list_route", {"id": r["id"]})
        if check(f"list: {n.name} lists {r['id']} on {site}", st == 200 and v.get("listing", {}).get("entry_id"), v):
            W.entries[site] = {"entry": v["listing"]["entry_id"], "node": n, "route": r}
    # The key each node makes for itself: asking for another opens the owner's dialog, which a test must never do.
    for n in nodes:
        n.token = wait(n.name, lambda n=n: n.own_token(), 30, 1)
    check("setup: every node has an agent key", all(n.token for n in nodes), [n.name for n in nodes if not n.token])
    for n in W.callers:
        st, v = n.own("deposit", {"amount": 20})
        check(f"setup: {n.name} deposits", st == 200, v)


def s_discover(a, chain, network, nodes):
    """Each caller finds every route on another node, by its site, through the peer network."""
    W = World
    t0 = time.time()
    for site, e in W.entries.items():
        for n in W.callers:
            got = wait(f"{n.name} {site}", lambda: remote(search(n, site), site), a.find_wait, 3)
            check(f"discover: {n.name} finds {site} from {e['node'].name}", got and got[0].get("id", "").lower() == e["entry"].lower(), got or routes_of(search(n, site)))
    log(f"discovery took {time.time() - t0:.0f} s")


def s_links(a, chain, network, nodes):
    """The path no test had reached: a link opened on one node names a route that lives on another."""
    W = World
    for site, e in W.entries.items():
        n = W.callers[0]
        link = f"unbrowse://{site}/{e['entry']}"
        spent = (chain.nonce(n.address), chain.usdc_of(n.address))
        st, v = n.agent("GET", "/v1/open?q=" + urllib.parse.quote(link, safe=""))
        rs = routes_of(v)
        check(f"links: {n.name} opens a route held by {e['node'].name}", st == 200 and len(rs) == 1 and rs[0].get("remote") and rs[0].get("id", "").lower() == e["entry"].lower(), v)
        check("links: it names the contributor and the listed price", rs and rs[0].get("contributor", "").lower() == e["node"].address.lower() and rs[0].get("fee") == 0.25, rs)
        check("links: the route carries its own link", rs and rs[0].get("link") == link, rs)
        check("links: opening spent nothing", (chain.nonce(n.address), chain.usdc_of(n.address)) == spent)
        st, v = n.agent("GET", "/v1/open?q=" + urllib.parse.quote(f"unbrowse://{site}", safe=""))
        check("links: a site link shows the site's routes", st == 200 and any(r.get("id", "").lower() == e["entry"].lower() for r in routes_of(v)), v)
        other = "0x" + "cd" * 32
        st, v = n.agent("GET", "/v1/open?q=" + urllib.parse.quote(f"unbrowse://{site}/{other}", safe=""))
        check("links: another entry shows nothing", st == 200 and routes_of(v) == [], v)
    n = W.callers[0]
    for bad in ["https://example.com", "unbrowse://example.com:8080", "unbrowse://me@example.com", "unbrowse://example.com?pay=1", "unbrowse://ex\u00e4mple.com", "unbrowse://example.com/search"]:
        st, v = n.agent("GET", "/v1/open?q=" + urllib.parse.quote(bad, safe=""))
        check(f"links: refuses {bad!r}", st == 400, v)


def s_pay(a, chain, network, nodes):
    """A caller fetches a route from a stranger: pays once, runs it here, and the next call is free."""
    W = World
    site, e = next(iter(W.entries.items()))
    inp = e["route"]["inputs"][0]["name"]
    W.paid = []
    W.baseline = solvency(chain, network, nodes, W)
    W.supply = supply(chain, network, nodes)
    for n in W.callers[:3]:
        search(n, site)
        st, v = n.agent("POST", f"/v1/routes/{e['entry']}/call", {"inputs": {inp: "dune"}})
        W.paid.append(n)
        ok = st == 200 and v.get("ok")
        check(f"pay: {n.name} calls {e['node'].name}'s route", ok, {k: v.get(k) for k in ("ok", "error", "paid_usdc", "network")} if isinstance(v, dict) else v)
        if ok:
            check(f"pay: {n.name} paid the listed fee", v.get("paid_usdc") == 0.25, v.get("paid_usdc"))
        st, v2 = n.agent("POST", f"/v1/routes/{e['entry']}/call", {"inputs": {inp: "foundation"}})
        check(f"pay: {n.name}'s second call is free", st == 200 and v2.get("ok") and not v2.get("paid_usdc"), {k: v2.get(k) for k in ("ok", "error", "paid_usdc")} if isinstance(v2, dict) else v2)


def s_conform(a, chain, network, nodes):
    """A node told to use contracts that aren't what they should be refuses them, and says why."""
    base = network["deployment"]
    cases = [
        ("the wrong address as Settlement", {"settlement": base["domains"]}, "other contracts"),
        ("another pool", {"pool": chain.address(chain.key(a.nodes + 2))}, "pool"),
        ("no code hash at all, on the right contracts", {"code": ""}, None),
        ("a forged code hash, on the right contracts", {"code": "0xabcd"}, None),
    ]
    for i, (what, change, says) in enumerate(cases):
        key = chain.key(a.nodes + 1)
        n = Node(100 + i, f"x{i}", pathlib.Path(a.dir) / f"x{i}", a.api_port + 60 + i, a.peer_port + 60 + i, key, chain.address(key), a.bin, chain.rpc)
        n.home.mkdir()
        f = json.loads(json.dumps(network))
        f["deployment"].update(change)
        n.seed(f)
        n.start()
        wait(n.name, lambda: n.health().get("alive"), 40)
        h = wait(n.name, lambda: (lambda c: c if (c.get("settlement") or {}).get("ok") or "reading" not in (c.get("settlement") or {}).get("detail", "") and (c.get("settlement") or {}).get("detail") else None)(n.health().get("checks") or {}), 30, 1) or {}
        s = h.get("settlement") or {}
        if says:
            check(f"conform: refuses {what}", not s.get("ok") and says in s.get("detail", ""), s)
        else:
            check(f"conform: accepts {what}", s.get("ok"), s)
        n.kill(signal.SIGTERM)


def s_churn(a, chain, network, nodes):
    """Nodes die, freeze and come back; the network keeps answering."""
    W = World
    site, e = next(iter(W.entries.items()))
    src = e["node"]
    inp = e["route"]["inputs"][0]["name"]
    keeper = W.paid[0] if getattr(W, "paid", None) else None
    src.kill(signal.SIGKILL)
    log(f"killed {src.name}, the contributor of {site}")
    if keeper:
        st, v = keeper.agent("POST", f"/v1/routes/{e['entry']}/call", {"inputs": {inp: "hyperion"}})
        check(f"churn: {keeper.name} still runs the kept route with its contributor dead", st == 200 and v.get("ok"), {k: v.get(k) for k in ("ok", "error")} if isinstance(v, dict) else v)
    fresh = [n for n in W.callers if n not in getattr(W, "paid", [])]
    if fresh:
        n = fresh[0]
        st, v = n.agent("GET", "/v1/open?q=" + urllib.parse.quote(f"unbrowse://{site}/{e['entry']}", safe=""))
        log(f"with the contributor dead, a fresh node's link shows {len(routes_of(v))} route(s)")
        check(f"churn: {n.name} still gets an answer for the link, not an error", st == 200, v)
    src.start()
    back = wait(src.name, lambda: src.health().get("ready"), 90, 2)
    check(f"churn: {src.name} comes back ready after a crash", back, src.health().get("checks"))
    if fresh:
        n = fresh[0]
        got = wait("refind", lambda: remote(search(n, site), site), a.find_wait, 3)
        check(f"churn: {n.name} finds the route again", got, routes_of(search(n, site)))
    # Freeze a peer: the rest carry on and don't hang on it.
    victim = W.callers[-1]
    victim.kill(signal.SIGSTOP)
    t0 = time.time()
    n = W.callers[0]
    st, v = n.agent("GET", "/v1/routes?q=" + urllib.parse.quote(site), timeout=40)
    check("churn: a search isn't held up by a frozen peer", st == 200 and time.time() - t0 < 30, f"{time.time() - t0:.1f}s")
    victim.kill(signal.SIGCONT)
    check("churn: the frozen node answers once thawed", wait("thaw", lambda: victim.health().get("alive"), 20))


def s_chain_outage(a, chain, network, nodes):
    """The chain stops answering, then comes back."""
    W = World
    chain.proc.send_signal(signal.SIGSTOP)
    log("chain frozen for 25 s")
    time.sleep(25)
    alive = [n.name for n in nodes if not n.proc.poll() and (lambda: _alive(n))()]
    check("outage: nodes stay up with the chain gone", len(alive) == len([n for n in nodes if n.proc.poll() is None]), alive)
    chain.proc.send_signal(signal.SIGCONT)
    ready = [wait(n.name, lambda n=n: n.health().get("ready"), 90, 2) for n in nodes]
    check("outage: every node is ready again, with no restart", all(ready), [n.name for n, r in zip(nodes, ready) if not r])


def s_hold(a, chain, network, nodes):
    """With its contributor offline, a node that never saw a route still finds and fetches it from whoever kept it (spec
    §103): by default, with nobody holding, before any claim has put the route on chain; and after a keeper restarts."""
    W = World
    site, e = next(iter(W.entries.items()))
    inp = e["route"]["inputs"][0]["name"]
    src = e["node"]
    paid = getattr(W, "paid", [])
    spare = [n for n in W.callers if n not in paid]
    holder, fresh = spare[0], spare[1]
    W.fresh_used = [fresh]
    link = "/v1/open?q=" + urllib.parse.quote(f"unbrowse://{site}/{e['entry']}", safe="")
    src.kill(signal.SIGKILL)
    time.sleep(3)
    st, v = fresh.agent("GET", link)
    W.dark_no_holder = len(routes_of(v))
    log(f"contributor offline, nobody holding, {len(paid)} nodes keep the body: a stranger sees {W.dark_no_holder} route(s)")
    check("hold: a stranger finds a route its keepers serve, with the contributor offline", W.dark_no_holder == 1, f"{W.dark_no_holder} route(s), {len(paid)} keepers")
    keeper = paid[0]
    keeper.kill(signal.SIGTERM)
    keeper.start()
    wait(keeper.name, lambda: keeper.health().get("ready"), 60, 2)
    for k in paid[1:]:
        k.kill(signal.SIGKILL)
    got = wait("after restart", lambda: routes_of(fresh.agent("GET", link)[1]), 60, 3)
    check("hold: a keeper still serves it after a restart, with nobody else left", got, got)
    for k in paid[1:]:
        k.start()
    for k in paid[1:]:
        wait(k.name, lambda k=k: k.health().get("ready"), 60, 2)
    src.start()
    wait(src.name, lambda: src.health().get("ready"), 90, 2)
    # Turn holding on for one node, on a site it touches, the way an owner does.
    st, cur = holder.own("settings")
    (holder.data / "profiles" / site).mkdir(parents=True, exist_ok=True)
    cur = dict(cur or {}, hold_routes=True)
    # Holding on is a settings change, which a person says yes to in the window; here the seeded file is the owner's word.
    holder.kill(signal.SIGTERM)
    f = holder.data / "settings.json"
    f.write_text(json.dumps(dict(json.loads(f.read_text()), hold_routes=True)))
    holder.start()
    st, v = (200, "restarted with holding on") if wait(holder.name, lambda: holder.health().get("ready"), 60, 2) else (500, "didn't come back")
    check(f"hold: {holder.name} turns holding on", st == 200, v)
    search(holder, site)
    got = wait("held", lambda: e["entry"].lower() in (holder.data / "held.json").read_text().lower(), 150, 5)
    if not check(f"hold: {holder.name} holds the route", got, (holder.data / "held.json").read_text()[:200] if (holder.data / "held.json").exists() else "no held.json"):
        return
    src.kill(signal.SIGKILL)
    time.sleep(3)
    st, v = fresh.agent("GET", link)
    n = len(routes_of(v))
    log(f"contributor offline, {holder.name} holding: a stranger sees {n} route(s)")
    check("hold: a stranger finds the route through a holder with the contributor offline", n == 1, v)
    st, c = fresh.agent("POST", f"/v1/routes/{e['entry']}/call", {"inputs": {inp: "neuromancer"}})
    check("hold: and fetches and runs it, paying the listed fee", st == 200 and c.get("ok") and c.get("paid_usdc") == 0.25, {k: c.get(k) for k in ("ok", "error", "paid_usdc", "network")} if isinstance(c, dict) else c)
    if isinstance(c, dict) and c.get("ok"):
        W.paid = list(paid) + [fresh]
    src.start()
    check(f"hold: {src.name} returns", wait(src.name, lambda: src.health().get("ready"), 90, 2))


def s_cut(a, chain, network, nodes):
    """One node loses the chain and keeps its peers."""
    n = nodes[-1]
    World.relay.open = False
    time.sleep(20)
    check(f"cut: {n.name} stays up without the chain", _alive(n))
    other = World.callers[0]
    site = next(iter(World.entries))
    st, v = other.agent("GET", "/v1/routes?q=" + urllib.parse.quote(site), timeout=40)
    check("cut: the others are unaffected", st == 200 and remote(v, site), v)
    st, v = n.agent("GET", "/v1/open?q=" + urllib.parse.quote(f"unbrowse://{site}", safe=""), timeout=60)
    check(f"cut: {n.name} shows no unproven route while it can't read the chain", st == 200 and not remote(v, site), {k: (v or {}).get(k) for k in ("routes", "unavailable")})
    World.relay.open = True
    check(f"cut: {n.name} is ready again", wait("uncut", lambda: n.health().get("ready"), 90, 2), n.health().get("checks"))


def s_mixed(a, chain, network, nodes):
    """An older build on the same network: it must stay safe, and leave the rest unharmed."""
    if not a.old_bin or not pathlib.Path(a.old_bin).exists():
        check("mixed: skipped, no older build given", True, "not run")
        return
    key = chain.key(a.nodes + 3)
    addr = chain.address(key)
    n = Node(200, "old", pathlib.Path(a.dir) / "old", a.api_port + 70, a.peer_port + 70, key, addr, a.old_bin, chain.rpc)
    n.home.mkdir()
    n.seed(network)
    chain.rpc_call("anvil_setBalance", addr, "0x3635c9adc5dea00000")
    n.start()
    check("mixed: the older build starts", wait("old", lambda: n.health().get("alive"), 40))
    time.sleep(8)
    h = n.health().get("checks") or {}
    log("older build says:", json.dumps(h.get("settlement"))[:200])
    site = next(iter(World.entries))
    if (h.get("settlement") or {}).get("ok"):
        # The same contracts, an older client: it reads what newer nodes serve, keepers included.
        n.token = wait(n.name, lambda: n.own_token(), 30, 1)
        check("mixed: the older build joins the same contracts", wait("oldready", lambda: n.health().get("ready"), 90, 2), n.health().get("checks"))
        src = World.entries[site]["node"]
        src.kill(signal.SIGKILL)
        got = wait("oldfind", lambda: remote(search(n, site), site), 60, 3)
        check("mixed: the older build finds a route from newer keepers, with the contributor offline", got, got)
        src.start()
        wait(src.name, lambda: src.health().get("ready"), 90, 2)
    else:
        check("mixed: the older build refuses contracts it doesn't know, and says to update", "update" in (h.get("settlement") or {}).get("detail", ""), h.get("settlement"))
    st, v = World.callers[0].agent("GET", "/v1/routes?q=" + urllib.parse.quote(site), timeout=40)
    check("mixed: the new nodes are unaffected", st == 200 and remote(v, site), v)
    n.kill(signal.SIGTERM)


def s_stranger(a, chain, network, nodes):
    """A node with no gas and no identity on chain: it may ask, but it can't join."""
    key = chain.key(a.nodes + 2)
    n = Node(201, "stranger", pathlib.Path(a.dir) / "stranger", a.api_port + 71, a.peer_port + 71, key, chain.address(key), a.bin, chain.rpc)
    n.home.mkdir()
    n.seed(network)
    n.start()
    check("stranger: an unfunded node starts", wait("str", lambda: n.health().get("alive"), 40))
    time.sleep(10)
    log("stranger network check:", json.dumps((n.health().get("checks") or {}).get("network"))[:200])
    site = next(iter(World.entries))
    st, v = World.callers[0].agent("GET", "/v1/routes?q=" + urllib.parse.quote(site), timeout=40)
    check("stranger: the network still answers", st == 200 and remote(v, site), v)
    n.kill(signal.SIGTERM)


def s_load(a, chain, network, nodes):
    """Many agents at once, across every node."""
    W = World
    sites = list(W.entries)

    def one(i):
        n = nodes[i % len(nodes)]
        site = sites[i % len(sites)]
        t = time.time()
        try:
            st, v = n.agent("GET", "/v1/open?q=" + urllib.parse.quote(f"unbrowse://{site}", safe="") if i % 2 else "/v1/routes?q=" + urllib.parse.quote(site), timeout=60)
            return st, time.time() - t
        except Exception as e:
            return repr(e)[:80], time.time() - t

    with concurrent.futures.ThreadPoolExecutor(a.load_workers) as ex:
        res = list(ex.map(one, range(a.load_requests)))
    ok = sorted(t for st, t in res if st == 200)
    bad = [st for st, t in res if st != 200]
    p = lambda q: ok[min(len(ok) - 1, int(len(ok) * q))] if ok else -1
    log(f"load: {len(res)} requests, {a.load_workers} at once: p50 {p(.5):.2f}s p95 {p(.95):.2f}s max {p(.999):.2f}s, {len(bad)} failed")
    check("load: every request was answered", not bad, bad[:5])
    check("load: p95 under 10 s", p(.95) < 10, f"{p(.95):.2f}s")


def solvency(chain, network, nodes, W):
    """Settlement's USDC is exactly what it owes (settlement-usdc-equals-its-liabilities): deposits, escrow, the burn
    buffer and the route shares it holds. Beside it, what the fetch accounts for (parked buys and what it owes
    contributors), which it must hold exactly (the-fetch-holds-exactly-what-it-owes)."""
    d = network["deployment"]
    S, rpc = d["settlement"], chain.rpc

    def call(to, sig, *x):
        return chain.cast("call", "--rpc-url", rpc, to, sig, *x).split("\n")

    def num(v):
        return int(v.split()[0])

    wallets = [n.address for n in nodes] + [chain.address(chain.key(0))]
    deposits = sum(num(call(S, "account(address)(uint256,uint256,uint256)", w)[0]) for w in wallets)
    every = {**W.entries, **W.gone}
    hosts = {e["route"]["site"] for e in every.values()} | set(every)
    escrow = {h: num(call(S, "escrow(bytes32)(uint256)", chain.cast("keccak", h))[0]) for h in hosts}
    burn, held = num(call(S, "burnBuffer()(uint256)")[0]), num(call(S, "heldRoute()(uint256)")[0])
    usdc = chain.usdc_of(S)
    parts = {"deposits": deposits, "escrow": sum(escrow.values()), "burn": burn, "held": held}
    fetch = call(S, "fetch()(address)")[0]
    owed = {"held": chain.usdc_of(fetch), "accounted": num(call(fetch, "accounted()(uint256)")[0])}
    return usdc, parts, escrow, owed


def s_dark(a, chain, network, nodes):
    """After a claim has put the route on chain: contributor offline, nobody holding, a stranger who never fetched it
    finds it from a keeper and runs it."""
    W = World
    site = "openlibrary.org"
    e = W.entries[site]
    inp = e["route"]["inputs"][0]["name"]
    keepers = set(getattr(W, "paid", []))
    holders = [n for n in nodes if "hold_routes\": true" in (n.data / "settings.json").read_text()]
    fresh = [n for n in W.callers if n not in keepers and n not in holders and n is not nodes[-1]]
    if not fresh:
        check("dark: skipped, no node left that never fetched it", True, "not run")
        return
    for h in holders:
        h.kill(signal.SIGTERM)
    e["node"].kill(signal.SIGKILL)
    time.sleep(4)
    n = fresh[0]
    st, v = n.agent("GET", "/v1/open?q=" + urllib.parse.quote(f"unbrowse://{site}/{e['entry']}", safe=""), timeout=60)
    seen = len(routes_of(v))
    st2, v2 = n.agent("GET", "/v1/routes?q=" + urllib.parse.quote(f"Search books on {site}"), timeout=60)
    found = remote(v2, site)
    log(f"after a claim, contributor and holders offline: the link shows {seen}, a search shows {len(found)}")
    check("dark: a stranger finds it by link and by search, from a keeper", seen == 1 and len(found) == 1, f"link {seen}, search {len(found)}")
    if seen or found:
        st, c = n.agent("POST", f"/v1/routes/{e['entry']}/call", {"inputs": {inp: "ubik"}}, timeout=90)
        log("and calling it:", {k: c.get(k) for k in ("ok", "error", "paid_usdc")} if isinstance(c, dict) else c)
        check("dark: a keeper serves the body with the contributor offline", st == 200 and isinstance(c, dict) and c.get("ok"), {k: c.get(k) for k in ("ok", "error")} if isinstance(c, dict) else c)
    e["node"].start()
    for h in holders:
        h.start()


def supply(chain, network, nodes):
    """All the USDC in the simulation, by holder. Nothing mints during a run, so the total can't move."""
    d = network["deployment"]
    who = {"settlement": d["settlement"], "pool": d["pool"], "platform": chain.address(chain.key(0))}
    # The coin contracts and the domain proofs a line's money can reach, as the network file records them.
    who.update({k: v for k, v in (d.get("coins") or {}).items() if isinstance(v, str) and v.startswith("0x") and len(v) == 42})
    if d.get("domains"):
        who["domains"] = d["domains"]
    who.update({n.name: n.address for n in nodes})
    return {k: chain.usdc_of(v) for k, v in who.items()}


def s_money(a, chain, network, nodes):
    """An epoch passes and the lines are claimed: every fee lands, and Settlement still owes exactly what it holds."""
    W = World
    paid = getattr(W, "paid", [])
    usdc, mid, _, fetch = solvency(chain, network, nodes, W)
    check("money: mid-run, Settlement holds exactly what it owes", usdc == sum(mid.values()), {"held": usdc, **mid})
    check("money: mid-run, the fetch holds exactly what it accounts for", fetch["held"] == fetch["accounted"], fetch)
    usdc, before, _, fetch_before = W.baseline
    log("before any payment", before)
    log("before the epoch ends", mid)
    chain.rpc_call("anvil_mine", hex(EPOCH_BLOCKS + 60), hex(86400 // EPOCH_BLOCKS))
    for n in nodes:
        n.kill(signal.SIGTERM)
    for n in nodes:
        n.start()
    for n in nodes:
        wait(n.name, lambda n=n: n.health().get("ready"), 90, 2)
    for n in list(dict.fromkeys(list(paid) + list(W.paid_soak) + list(W.delisted_payers))):
        st, v = n.own("claim_now", timeout=120)
        log(n.name, "claim_now", st, str(v)[:160])
    time.sleep(6)
    usdc2, after, escrow, fetch = solvency(chain, network, nodes, W)
    check("money: after claims, Settlement holds exactly what it owes", usdc2 == sum(after.values()), {"held": usdc2, **after})
    check("money: after claims, the fetch holds exactly what it accounts for", fetch["held"] == fetch["accounted"], fetch)
    moved = before["deposits"] - after["deposits"]
    fee_units = 250000
    log("paid out of deposits", moved / 1e6, "USDC; escrow", after["escrow"] / 1e6, "burn", after["burn"] / 1e6, "held", after["held"] / 1e6, "owed by the fetch", (fetch["accounted"] - fetch_before["accounted"]) / 1e6)
    expected = fee_units * len(paid) + W.paid_units
    check("money: every paid line left a deposit", moved == expected, f"{moved} of {expected}")
    if moved:
        check("money: the site's escrow got 30%", after["escrow"] - before["escrow"] == moved * 30 // 100, after["escrow"] - before["escrow"])
        now = supply(chain, network, nodes)
        moved_to = {k: now[k] - W.supply[k] for k in now if now[k] != W.supply[k]}
        log("USDC moved between holders", moved_to)
        check("money: no USDC was created or lost across every holder", sum(now.values()) == sum(W.supply.values()), moved_to)
    e = next(iter(W.entries.values()))
    st, v = e["node"].own("earnings")
    log("contributor earnings", str(v)[:220])
    check("money: the contributor sees earnings", st == 200, v)


def s_delist(a, chain, network, nodes):
    """A contributor withdraws a route: it stops being offered across the network."""
    W = World
    site = "crossref.org"
    e = W.entries.get(site)
    if not e:
        check("delist: skipped, no third route", True, "not run")
        return
    n = W.callers[0]
    link = "/v1/open?q=" + urllib.parse.quote(f"unbrowse://{site}/{e['entry']}", safe="")
    check("delist: the route shows before it's withdrawn", len(routes_of(n.agent("GET", link)[1])) == 1)
    # A keeper must let it go too, or it would go on being served.
    inp = e["route"]["inputs"][0]["name"]
    keeper = W.callers[1]
    search(keeper, site)
    st, kept = keeper.agent("POST", f"/v1/routes/{e['entry']}/call", {"inputs": {inp: "graphs"}})
    check(f"delist: {keeper.name} keeps a copy first", st == 200 and isinstance(kept, dict) and kept.get("ok"), {k: kept.get(k) for k in ("ok", "error")} if isinstance(kept, dict) else kept)
    st, v = e["node"].own("delist_route", {"id": e["route"]["id"]})
    check(f"delist: {e['node'].name} delists it", st == 200, v)
    t0 = time.time()
    gone = wait("gone", lambda: all(not routes_of(c.agent("GET", link)[1]) for c in W.callers), 90, 2)
    check("delist: no caller is offered it any more, keepers included", gone, f"{time.time() - t0:.0f}s")
    log(f"delist reached every caller in {time.time() - t0:.0f} s")
    if isinstance(kept, dict) and kept.get("paid_usdc"):
        W.paid_units += round(kept["paid_usdc"] * 1e6)
        W.delisted_payers.append(keeper)
    # The money it earned stays owed: solvency still counts it.
    W.gone[site] = W.entries.pop(site)


def s_soak(a, chain, network, nodes):
    """Faults at random while agents search, open links and pay, then recovery. One seed replays the same faults."""
    W = World
    rng = random.Random(a.seed)
    log("soak seed", a.seed, "for", a.soak, "s")
    stop = threading.Event()
    stats = {"faults": [], "ok": 0, "errors": {}, "paid": 0}
    site, e = [(k, v) for k, v in W.entries.items() if k == "algolia.com"][0]
    inp = e["route"]["inputs"][0]["name"]
    protected = {x["node"].name for x in W.entries.values()}
    victims = [n for n in W.callers if n is not nodes[-1]]
    lock = threading.Lock()
    down = set()

    def nemesis():
        while not stop.is_set():
            kind = rng.choice(["crash", "pause", "chain", "cut", "crash_contributor"])
            n = rng.choice(victims)
            if kind == "crash_contributor":
                n = rng.choice([x for x in nodes if x.name in protected])
            length = rng.uniform(4, 14)
            with lock:
                stats["faults"].append((kind, n.name if kind not in ("chain", "cut") else "-", round(length, 1)))
                down.add(n.name)
            if kind in ("crash", "crash_contributor"):
                n.kill(signal.SIGKILL)
                stop.wait(length)
                n.start()
            elif kind == "pause":
                n.kill(signal.SIGSTOP)
                stop.wait(length)
                n.kill(signal.SIGCONT)
            elif kind == "chain":
                chain.proc.send_signal(signal.SIGSTOP)
                stop.wait(length)
                chain.proc.send_signal(signal.SIGCONT)
            else:
                W.relay.open = False
                stop.wait(length)
                W.relay.open = True
            with lock:
                down.discard(n.name)
            stop.wait(rng.uniform(1, 6))

    def agent(n, seed):
        r = random.Random(seed)
        paid_once = False
        while not stop.is_set():
            try:
                if not paid_once and r.random() < 0.2 and n not in W.paid_soak:
                    st, v = n.agent("POST", f"/v1/routes/{e['entry']}/call", {"inputs": {inp: "rust"}}, timeout=40)
                    if st == 200 and isinstance(v, dict) and v.get("ok") and v.get("paid_usdc"):
                        paid_once = True
                        with lock:
                            stats["paid"] += 1
                            W.paid_soak.append(n)
                            W.paid_units += round(v["paid_usdc"] * 1e6)
                elif r.random() < 0.5:
                    st, v = n.agent("GET", "/v1/open?q=" + urllib.parse.quote(f"unbrowse://{site}", safe=""), timeout=40)
                else:
                    st, v = n.agent("GET", "/v1/routes?q=" + urllib.parse.quote(site), timeout=40)
                with lock:
                    if st == 200:
                        stats["ok"] += 1
                    else:
                        k = f"{st} {str((v or {}).get('error'))[:60]}" if isinstance(v, dict) else str(st)
                        stats["errors"][k] = stats["errors"].get(k, 0) + 1
            except Exception as x:
                with lock:
                    k = type(x).__name__
                    stats["errors"][k] = stats["errors"].get(k, 0) + 1
            stop.wait(r.uniform(0.2, 1.5))

    W.paid_soak = []
    ts = [threading.Thread(target=nemesis, daemon=True)] + [threading.Thread(target=agent, args=(n, a.seed + i), daemon=True) for i, n in enumerate(W.callers)]
    for t in ts:
        t.start()
    time.sleep(a.soak)
    stop.set()
    for t in ts:
        t.join(40)
    W.relay.open = True
    for n in nodes:
        if n.proc.poll() is None:
            n.kill(signal.SIGCONT)
        else:
            n.start()
    try:
        chain.proc.send_signal(signal.SIGCONT)
    except OSError:
        pass
    log(f"soak: {len(stats['faults'])} faults, {stats['ok']} answers, {stats['paid']} payments, errors {stats['errors']}")
    log("faults:", stats["faults"][:12])
    ready = [wait(n.name, lambda n=n: n.health().get("ready"), 120, 2) for n in nodes]
    check("soak: every node is ready after the faults stop", all(ready), [n.name for n, r in zip(nodes, ready) if not r])
    check("soak: faults really fired", len(stats["faults"]) >= 5, len(stats["faults"]))
    n = W.callers[0]
    got = wait("after", lambda: remote(search(n, site), site), 90, 3)
    check("soak: the network finds routes again after the faults", got, routes_of(search(n, site)))
    usdc, parts, _, fetch = solvency(chain, network, nodes, W)
    check("soak: Settlement holds exactly what it owes after the faults", usdc == sum(parts.values()), {"usdc": usdc, **parts})
    check("soak: the fetch holds exactly what it accounts for after the faults", fetch["held"] == fetch["accounted"], fetch)
    now = supply(chain, network, nodes)
    check("soak: no USDC was created or lost", sum(now.values()) == sum(W.supply.values()), sum(now.values()) - sum(W.supply.values()))


def _alive(n):
    try:
        return n.health().get("alive")
    except Exception:
        return False


SCENARIOS = {"join": s_join, "probe": s_probe, "setup": s_setup, "discover": s_discover, "links": s_links, "pay": s_pay,
             "conform": s_conform, "hold": s_hold, "churn": s_churn, "cut": s_cut, "outage": s_chain_outage, "mixed": s_mixed,
             "stranger": s_stranger, "load": s_load, "money": s_money, "delist": s_delist, "soak": s_soak, "dark": s_dark}


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--bin", required=True)
    p.add_argument("--repo", required=True)
    p.add_argument("--nodes", type=int, default=8)
    p.add_argument("--dir", default=str(pathlib.Path(tempfile.gettempdir()) / "unbrowse-netsim"))
    p.add_argument("--chain-port", type=int, default=19545)
    p.add_argument("--api-port", type=int, default=19100)
    p.add_argument("--peer-port", type=int, default=29100)
    p.add_argument("--join-wait", type=int, default=120)
    p.add_argument("--find-wait", type=int, default=90)
    p.add_argument("--scenarios", default="join,setup,discover,links,pay,conform,hold,churn,cut,outage,mixed,stranger,load,delist,soak,money,dark")
    p.add_argument("--soak", type=int, default=240, help="seconds of random faults")
    p.add_argument("--seed", type=int, default=int(time.time()))
    p.add_argument("--old-bin", default="")
    p.add_argument("--load-workers", type=int, default=16)
    p.add_argument("--load-requests", type=int, default=200)
    a = p.parse_args()
    root = pathlib.Path(a.dir)
    shutil.rmtree(root, ignore_errors=True)
    root.mkdir(parents=True)
    chain, nodes = None, []
    try:
        chain, network, nodes = bring_up(a, root)
        for s in a.scenarios.split(","):
            log("==", s)
            SCENARIOS[s](a, chain, network, nodes)
    finally:
        for n in nodes:
            n.kill(signal.SIGTERM)
        if chain:
            chain.stop()
        (root / "report.json").write_text(json.dumps(RESULTS, indent=1))
    bad = [r for r in RESULTS if not r["ok"]]
    log(f"{len(RESULTS) - len(bad)} of {len(RESULTS)} checks passed")
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()
