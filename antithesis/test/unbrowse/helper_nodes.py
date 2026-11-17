"""The workload's way to the three nodes: their agent API through the project's own Python client
(unbrowse-sdk/python, `unbrowse.UnbrowseNode`), and their owner door, each reached through the node container's relay.

A node answers only requests that name its loopback as the host (api.rs `own_host_only`). The relay in the node's
container forwards TCP to that loopback, so every request here names `127.0.0.1:7788` as its Host, which urllib keeps
when a request already carries one (`HostOnTheNode`).

Each node's home is mounted read only at /nodes/<name>: its owner token, its receipts, `held.json`, its routes.
"""

import json
import os
import sqlite3
import time
import urllib.error
import urllib.parse
import urllib.request

NODES = ["node-1", "node-2", "node-3"]
CONTRIBUTOR = "node-1"
CALLERS = ["node-2", "node-3"]
# The owners' addresses: Anvil's published accounts 1-3 (antithesis/config/docker-compose.yaml), and the platform's.
OWNER = {
    "node-1": "0x70997970c51812dc3a010c7d01b50e0d17dc79c8",
    "node-2": "0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc",
    "node-3": "0x90f79bf6eb2c4f870365e785982e1f101e93b906",
}
PLATFORM = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266"
NODE_HOST = "127.0.0.1:7788"
# The shop as a route reaches it (HTTPS, under the harness CA), and the plain-HTTP side door only the workload uses
# to read who called (`/_seen`): the workload never needs to trust the CA.
SITE = "https://shop.example.com"
SEEN = "http://shop.example.com:8080/_seen"
ROUTE = "route-items"
STATE = "/state/workload.db"


def base(name):
    return f"http://unbrowse-{name}:7700"


class HostOnTheNode(urllib.request.BaseHandler):
    """Names the node's own loopback as the Host of every request to a node's relay."""

    handler_order = 100

    def http_request(self, req):
        if req.host.startswith("unbrowse-node-") and not req.has_header("Host"):
            req.add_unredirected_header("Host", NODE_HOST)
        return req


urllib.request.install_opener(urllib.request.build_opener(HostOnTheNode()))


class NodeDown(Exception):
    """The node didn't answer: a fault, a restart, or still booting. Never a finding by itself."""


def _post(url, body, headers, timeout):
    data = json.dumps(body).encode()
    req = urllib.request.Request(url, data=data, method="POST", headers={"content-type": "application/json", **headers})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as res:
            return res.status, json.loads(res.read() or b"null")
    except urllib.error.HTTPError as e:
        raw = e.read()
        try:
            return e.code, json.loads(raw)
        except Exception:
            return e.code, {"error": raw.decode(errors="replace")}
    except Exception as e:
        raise NodeDown(f"{url}: {e}") from None


def owner_token(name):
    with open(f"/nodes/{name}/owner.token") as f:
        return f.read().strip()


def owner(name, cmd, args=None, timeout=120):
    """An owner command on `name`: (status, reply). Raises NodeDown when the node can't be reached."""
    return _post(f"{base(name)}/owner/{cmd}", args or {}, {"authorization": f"Bearer {owner_token(name)}"}, timeout)


def agent(name, token):
    from unbrowse import UnbrowseNode

    return UnbrowseNode(token=token, base_url=base(name), timeout=120)


def agent_post(name, token, path, body, timeout=120):
    return _post(f"{base(name)}{path}", body, {"authorization": f"Bearer {token}"}, timeout)


def network_search(name, token, query="search items shop.example.com"):
    """A caller's search as the node answers it: (routes, answered by the peer network). A reply the peer network gave
    carries `checked`; one without it fell back to reading every listed entry off the chain (api/search.rs `ask_network`)."""
    req = urllib.request.Request(f"{base(name)}/v1/routes?q={urllib.parse.quote(query)}", headers={"authorization": f"Bearer {token}"})
    try:
        with urllib.request.urlopen(req, timeout=60) as res:
            body = json.loads(res.read())
    except urllib.error.HTTPError as e:
        return None, e.code
    except Exception as e:
        raise NodeDown(f"{name}: {e}") from None
    return body.get("routes", []), "checked" in body


def up(name, timeout=5):
    try:
        with urllib.request.urlopen(urllib.request.Request(f"{base(name)}/v1/whoami"), timeout=timeout):
            return True
    except urllib.error.HTTPError:
        return True  # it answered
    except Exception:
        return False


def contents(file):
    """A node's file without its version (unbrowse-files): a list or map it wrapped as {"v": n, "items": ...} is
    unwrapped, and fields keep everything but `v`. A file from before versions reads as it is."""
    if isinstance(file, dict) and set(file) == {"v", "items"} and isinstance(file["v"], int):
        return file["items"]
    return file


def read_json(path, default=None):
    try:
        with open(path) as f:
            return contents(json.load(f))
    except Exception:
        return default


def receipts(name):
    """Every receipt line on `name`'s disk: (agent index, epoch, line). Raises on a file that doesn't read."""
    d = f"/nodes/{name}/arc-testnet/receipts"
    out = []
    try:
        files = os.listdir(d)
    except FileNotFoundError:
        return out
    for f in files:
        if not f.endswith(".json") or "-" not in f:
            continue
        a, e = f[:-5].split("-", 1)
        try:
            index, epoch = int(a), int(e)
        except ValueError:
            continue
        # A file caught mid-write (or torn) is a reason to look again later, never an empty ledger.
        with open(os.path.join(d, f)) as fh:
            lines = contents(json.load(fh))
        for line in lines:
            out.append((index, epoch, line))
    return out


# ---- what the workload remembers between commands: attempts, acknowledgements, agents ----

def db():
    os.makedirs(os.path.dirname(STATE), exist_ok=True)
    c = sqlite3.connect(STATE, timeout=30)
    c.execute("CREATE TABLE IF NOT EXISTS agents (node TEXT, idx INTEGER, address TEXT, token TEXT, cap REAL, PRIMARY KEY (node, idx))")
    c.execute("CREATE TABLE IF NOT EXISTS calls (at REAL, node TEXT, outcome TEXT, paid REAL, served_by TEXT, cached INTEGER, detail TEXT)")
    c.execute("CREATE TABLE IF NOT EXISTS owner_ops (at REAL, node TEXT, cmd TEXT, status INTEGER, reply TEXT)")
    c.execute("CREATE TABLE IF NOT EXISTS facts (k TEXT PRIMARY KEY, v TEXT)")
    return c


def remember(k, v):
    with db() as c:
        c.execute("INSERT OR REPLACE INTO facts VALUES (?, ?)", (k, json.dumps(v)))


def recall(k, default=None):
    with db() as c:
        row = c.execute("SELECT v FROM facts WHERE k = ?", (k,)).fetchone()
    return json.loads(row[0]) if row else default


def agents(node=None):
    with db() as c:
        q = "SELECT node, idx, address, token, cap FROM agents" + (" WHERE node = ?" if node else "")
        return [dict(zip(["node", "idx", "address", "token", "cap"], r)) for r in c.execute(q, (node,) if node else ())]


def wait(pred, seconds, every=1.0):
    end = time.time() + seconds
    while time.time() < end:
        try:
            v = pred()
            if v:
                return v
        except Exception:
            pass
        time.sleep(every)
    return None
