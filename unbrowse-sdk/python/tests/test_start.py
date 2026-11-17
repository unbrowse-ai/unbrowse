"""Starting the node for a client (``Unbrowse.start``, ``auto_start``), against a stub ``unbrowse-node``: a small program
that answers as the node does (the proof, whoami with no browser) on UNBROWSE_PORT, and ``agent token`` as the node's
CLI does, exiting 3 until its first key is made. The same as the TypeScript package's test/start.test.mjs."""

import os
import shutil
import socket
import stat
import sys
import tempfile
import threading
import time
import unittest
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))

from unbrowse import NodeConnectionError, Unbrowse  # noqa: E402

# The token is made of parts at runtime, as the node derives one; it is no real key.
TOKEN = "-".join(["stub", "agent", format(int(time.time()), "x")])

STUB = f"""#!{sys.executable}
import json, os, signal, sys, threading, time
from urllib.parse import parse_qs, urlparse
sys.path.insert(0, {str(Path(__file__).resolve().parent.parent / "src")!r})
sys.path.insert(0, {str(Path(__file__).resolve().parent)!r})
from signed_fixture import Signing
from unbrowse._proof import node_proof, token_key
from http.server import BaseHTTPRequestHandler, HTTPServer
home = os.environ["UNBROWSE_HOME"]
os.makedirs(home, exist_ok=True)
def log(what):
    with open(os.path.join(home, "stub.log"), "a") as f:
        f.write(what + "\\n")
if sys.argv[1:3] == ["agent", "token"]:
    # The first key exists once the node has been up a moment.
    if not os.path.exists(os.path.join(home, "key-made")):
        print("no live agent key yet", file=sys.stderr)
        sys.exit(3)
    print(os.environ["STUB_TOKEN"])
    sys.exit(0)
log("started " + os.environ.get("UNBROWSE_BROWSER", ""))
class H(Signing, BaseHTTPRequestHandler):
    TOKENS = staticmethod(lambda: [os.environ["STUB_TOKEN"]])
    def do_GET(self):
        if self.path.startswith("/v1/node/proof"):
            q = parse_qs(urlparse(self.path).query)
            token = os.environ["STUB_TOKEN"]
            mine = q.get("key") == [token_key(token)]
            proof = node_proof(token, int(os.environ["UNBROWSE_PORT"]), bytes.fromhex(q["challenge"][0])) if mine else None
            return self.send(200, {{"agents": [proof] if proof else []}})
        if self.path == "/die":
            os._exit(1)  # the node crashing
        if self.headers.get("authorization") != "Bearer " + os.environ["STUB_TOKEN"]:
            return self.send(401, {{"error": "unknown, revoked or expired agent key"}})
        if self.path == "/v1/whoami":
            return self.send(200, {{"agent": "agent", "address": "0xabc", "node": "stub", "browser": "missing", "browser_fetch": True}})
        self.send(404, {{"error": "no such route"}})
    def send(self, status, body):
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)
    def log_message(self, *a):
        pass
def stop(*a):
    log("stopped")
    os._exit(0)
signal.signal(signal.SIGTERM, stop)
server = HTTPServer(("127.0.0.1", int(os.environ["UNBROWSE_PORT"])), H)
threading.Timer(0.3, lambda: open(os.path.join(home, "key-made"), "w").write("1")).start()
server.serve_forever()
"""


# What a node that lost the port leaves behind, every time: another's node answering, and its own process gone. Two real
# starters can't show this, since which of them loses is a coin toss.
LOSER = f"""#!{sys.executable}
import os, socket, subprocess, sys, time
subprocess.Popen([os.environ["STUB_PROGRAM"]], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
while True:
    try:
        socket.create_connection(("127.0.0.1", int(os.environ["UNBROWSE_PORT"])), 1).close()
        sys.exit(1)
    except OSError:
        time.sleep(0.02)
"""


def free_port() -> int:
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def answers(port: int) -> bool:
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/v1/node/proof?challenge=00", timeout=1):
            return True
    except OSError:
        return False


@unittest.skipIf(sys.platform == "win32", "the stub is a script with a shebang")
class StartTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.dir = Path(tempfile.mkdtemp(prefix="unbrowse-start-"))
        cls.program = cls.dir / "unbrowse-node"
        cls.program.write_text(STUB)
        cls.program.chmod(cls.program.stat().st_mode | stat.S_IXUSR)

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.dir, ignore_errors=True)

    def home(self, name: str) -> Path:
        h = self.dir / name
        shutil.rmtree(h, ignore_errors=True)
        return h

    def test_start_runs_the_node_with_no_browser_waits_reads_its_token_and_close_stops_it(self):
        port, h = free_port(), self.home("fresh")
        node = Unbrowse.start(program=self.program, home=h, port=port, env={"STUB_TOKEN": TOKEN, "UNBROWSE_BROWSER": str(self.dir / "nowhere")})
        self.assertEqual(node.base_url, f"http://127.0.0.1:{port}")
        self.assertEqual(node.whoami().node, "stub")
        caps = node.capabilities()
        self.assertEqual((caps.browser, caps.fetches_browser, caps.browser_option), ("missing", True, True))
        self.assertIn("nowhere", (h / "stub.log").read_text(), "the node got the environment it was given")
        node.close()
        self.assertFalse(answers(port), "close stopped the node it started")
        self.assertIn("stopped", (h / "stub.log").read_text())
        node.close()

    def test_a_named_agent_token_is_used_even_when_a_home_is_set(self):
        from unbrowse import UnbrowseError

        port, h = free_port(), self.home("environment-home")
        names = ("UNBROWSE_HOME", "UNBROWSE_PORT", "UNBROWSE_AGENT_TOKEN", "STUB_TOKEN")
        old = {name: os.environ.get(name) for name in names}
        try:
            # The caller named a narrow key of its own: a home in the environment never swaps in the node's first key.
            os.environ.update({"UNBROWSE_HOME": str(h), "UNBROWSE_PORT": str(port), "UNBROWSE_AGENT_TOKEN": "a-narrow-key", "STUB_TOKEN": TOKEN})
            node = Unbrowse.start(program=self.program)
            with self.assertRaises(UnbrowseError) as e:
                node.whoami()
            self.assertEqual(e.exception.status, 401, "the named key is the one sent, and this node doesn't hold it")
            node.close()
            # Named nothing: the node this process started gives its own key.
            os.environ.pop("UNBROWSE_AGENT_TOKEN")
            own = Unbrowse.start(program=self.program)
            self.assertEqual(own.whoami().node, "stub")
            own.close()
        finally:
            for name, value in old.items():
                if value is None:
                    os.environ.pop(name, None)
                else:
                    os.environ[name] = value
    def test_start_uses_a_node_that_is_running_already_and_close_leaves_it(self):
        port, h = free_port(), self.home("running")
        first = Unbrowse.start(program=self.program, home=h, port=port, env={"STUB_TOKEN": TOKEN})
        # A node this process didn't start gives no key of its own: the caller names one.
        with self.assertRaises(Exception) as e:
            Unbrowse.start(program=self.program, home=h, port=port, env={"STUB_TOKEN": TOKEN})
        self.assertIn("only a node this process starts gives its own key", str(e.exception))
        with Unbrowse.start(program=self.program, home=h, port=port, token=TOKEN, env={"STUB_TOKEN": TOKEN}) as second:
            self.assertEqual(second.whoami().node, "stub")
        self.assertEqual((h / "stub.log").read_text().count("started"), 1, "only one node was started")
        self.assertTrue(answers(port), "a node the client didn't start keeps running")
        first.close()
        self.assertFalse(answers(port))

    def test_auto_start_starts_the_node_on_the_first_request(self):
        port, h = free_port(), self.home("auto")
        node = Unbrowse(auto_start={"program": self.program, "home": h, "port": port, "env": {"STUB_TOKEN": TOKEN}})
        self.assertFalse(answers(port), "nothing starts before a request")
        self.assertEqual(node.whoami().agent, "agent")
        node.close()
        self.assertFalse(answers(port))

    def auto(self, h: Path, port: int) -> Unbrowse:
        return Unbrowse(auto_start={"program": self.program, "home": h, "port": port, "env": {"STUB_TOKEN": TOKEN}})

    def crash(self, port: int) -> None:
        """Crashes the stub on ``port`` and waits until it's gone."""
        try:
            urllib.request.urlopen(f"http://127.0.0.1:{port}/die", timeout=1)
        except OSError:
            pass
        while answers(port):
            time.sleep(0.02)

    def test_after_close_the_next_request_starts_the_node_again_and_close_stops_that_one_too(self):
        port, h = free_port(), self.home("reopened")
        node = self.auto(h, port)
        node.whoami()
        node.close()
        self.assertFalse(answers(port))
        self.assertEqual(node.whoami().node, "stub")
        self.assertEqual((h / "stub.log").read_text().count("started"), 2)
        node.close()
        self.assertFalse(answers(port))

    def test_a_node_this_client_started_that_dies_is_started_again_before_the_next_request_goes(self):
        port, h = free_port(), self.home("crashed")
        node = self.auto(h, port)
        node.whoami()
        self.crash(port)
        node._started._proc.wait()
        self.assertEqual(node.whoami().node, "stub", "the request itself never sees the dead node")
        self.assertEqual((h / "stub.log").read_text().count("started"), 2)
        node.close()
        self.assertFalse(answers(port))

    def test_a_client_whose_node_another_client_stopped_says_so_once_then_brings_its_own(self):
        port, h = free_port(), self.home("shared")
        opts = {"program": self.program, "home": h, "port": port, "env": {"STUB_TOKEN": TOKEN}}
        first, second = Unbrowse.start(**opts), Unbrowse.start(token=TOKEN, **opts)
        first.close()
        self.assertFalse(answers(port))
        with self.assertRaises(NodeConnectionError):  # answered as it failed, never sent twice
            second.whoami()
        self.assertEqual(second.whoami().node, "stub")
        second.close()
        self.assertFalse(answers(port), "the node it brought back is its own to stop")

    def test_a_client_whose_node_lost_the_port_uses_the_winners_and_brings_one_when_that_goes(self):
        port = free_port()
        loser = self.dir / "losing-node"
        loser.write_text(LOSER)
        loser.chmod(loser.stat().st_mode | stat.S_IXUSR)
        node = Unbrowse(auto_start={"program": loser, "home": self.home("race"), "port": port, "token": TOKEN, "env": {"STUB_TOKEN": TOKEN, "STUB_PROGRAM": str(self.program)}})
        self.assertEqual(node.whoami().node, "stub")
        self.crash(port)
        # A dead process counted as this client's node would hold it here for good.
        try:
            who = node.whoami()
        except NodeConnectionError:
            who = node.whoami()
        self.assertEqual(who.node, "stub")
        self.crash(port)

    def test_a_request_made_during_a_start_waits_for_it(self):
        port = free_port()
        node = self.auto(self.home("waits"), port)
        got = []

        def ask() -> None:
            try:
                got.append(node.whoami().node)
            except Exception as e:  # noqa: BLE001 the assertion below shows it
                got.append(e)

        threads = [threading.Thread(target=ask) for _ in range(2)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        self.assertEqual(got, ["stub", "stub"])
        node.close()

    def test_with_no_node_running_and_no_node_program_start_says_how_to_get_one(self):
        was = os.environ.get("UNBROWSE_BIN")
        os.environ["UNBROWSE_BIN"] = str(self.dir / "no-such-folder")
        try:
            with self.assertRaises(NodeConnectionError) as c:
                Unbrowse.start(home=self.home("none"), port=free_port())
            self.assertIn("pip install unbrowse", c.exception.message)
            self.assertIn("UNBROWSE_BIN", c.exception.message)
        finally:
            os.environ.pop("UNBROWSE_BIN") if was is None else os.environ.__setitem__("UNBROWSE_BIN", was)

    def test_a_node_that_exits_before_it_answers_is_said_with_what_it_wrote(self):
        broken = self.dir / "broken-node"
        broken.write_text(f"#!{sys.executable}\nimport sys\nprint('settings written by a newer node', file=sys.stderr)\nsys.exit(1)\n")
        broken.chmod(broken.stat().st_mode | stat.S_IXUSR)
        with self.assertRaises(NodeConnectionError) as c:
            Unbrowse.start(program=broken, home=self.home("broken"), port=free_port(), ready_timeout=10)
        self.assertIn("newer node", c.exception.message)


if __name__ == "__main__":
    unittest.main()
