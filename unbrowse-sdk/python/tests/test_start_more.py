"""What starting the node does at the edges test_start.py leaves: an environment variable taken away from the node, the
node's words kept or let through, a node that will not give its token, a node that outlives being asked to stop, and a
node that exits having lost the port to one that answers. Against stub ``unbrowse-node`` programs, as test_start.py is."""

import os
import shutil
import stat
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_start import STUB, TOKEN, answers, free_port  # noqa: E402

from unittest import mock  # noqa: E402

import unbrowse.start as start_module  # noqa: E402
from unbrowse import UnbrowseError  # noqa: E402
from unbrowse.start import Started, bring  # noqa: E402

LOCKED = STUB.replace('print("no live agent key yet", file=sys.stderr)\n        sys.exit(3)', 'print("keystore locked", file=sys.stderr)\n        sys.exit(2)')
NOISY = STUB.replace('log("started " + os.environ.get("UNBROWSE_BROWSER", ""))', 'print("node says hello", flush=True)')
assert LOCKED != STUB and NOISY != STUB


def wait_for(what, ok, seconds=10):
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        if ok():
            return
        time.sleep(0.02)
    raise AssertionError(f"never happened: {what}")


@unittest.skipIf(sys.platform == "win32", "the stubs are scripts with a shebang")
class StartEdges(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.dir = Path(tempfile.mkdtemp(prefix="unbrowse-start-more-"))

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.dir, ignore_errors=True)

    def program(self, name, text):
        p = self.dir / name
        p.write_text(text)
        p.chmod(p.stat().st_mode | stat.S_IXUSR)
        return p

    def started(self, name, text, **kw):
        port = free_port()
        home = self.dir / f"{name}-home"
        kw.setdefault("env", {})["STUB_TOKEN"] = TOKEN
        url, token, started = bring(home=home, port=port, program=self.program(name, text), **kw)
        if started is not None:
            self.addCleanup(started.stop)
        return port, home, url, token, started

    def no_token_in_the_environment(self):
        old = os.environ.pop("UNBROWSE_AGENT_TOKEN", None)
        if old is not None:
            self.addCleanup(os.environ.__setitem__, "UNBROWSE_AGENT_TOKEN", old)

    def test_an_environment_variable_given_as_none_is_taken_away_from_the_node(self):
        os.environ["UNBROWSE_BROWSER"] = "/the/callers/browser"
        self.addCleanup(os.environ.pop, "UNBROWSE_BROWSER", None)
        port, home, url, token, started = self.started("takeaway", STUB, env={"UNBROWSE_BROWSER": None})
        self.assertEqual((home / "stub.log").read_text().splitlines()[0], "started ", "the node's browser variable was not set")
        self.assertEqual((url, token), (f"http://127.0.0.1:{port}", TOKEN))

    def test_the_nodes_words_are_kept_for_what_it_said_unless_asked_to_let_them_through(self):
        _, _, _, _, started = self.started("quiet", NOISY)
        wait_for("the node's words are kept", lambda: "node says hello" in started.said())

    def test_the_nodes_words_go_where_this_processes_go_when_asked_to_let_them_through(self):
        out = tempfile.TemporaryFile()
        saved = os.dup(1)
        try:
            os.dup2(out.fileno(), 1)
            _, _, _, _, started = self.started("loud", NOISY, output="inherit")
        finally:
            os.dup2(saved, 1)
            os.close(saved)
        wait_for("the node's words reach this process's output", lambda: out.seek(0) is not None and b"node says hello" in out.read())
        self.assertEqual(started.said(), "", "nothing kept: it was let through")

    def test_a_node_that_will_not_give_its_token_is_said_and_stopped_not_left_running(self):
        self.no_token_in_the_environment()
        port = free_port()
        with self.assertRaises(UnbrowseError) as e:
            bring(home=self.dir / "locked-home", port=port, program=self.program("locked", LOCKED), env={"STUB_TOKEN": TOKEN})
        self.assertEqual((e.exception.code, e.exception.status), ("unauthorized", 401))
        self.assertIn("couldn't get an agent token", e.exception.message)
        self.assertIn("keystore locked", e.exception.message)
        wait_for("the node it started is stopped", lambda: not answers(port))

    def test_a_node_that_ignores_being_asked_to_stop_is_killed(self):
        proc = subprocess.Popen(
            [sys.executable, "-c", "import signal, time; signal.signal(signal.SIGTERM, signal.SIG_IGN); print('ready', flush=True); time.sleep(120)"],
            stdout=subprocess.PIPE,
        )
        self.addCleanup(lambda: proc.poll() is None and proc.kill())
        self.assertEqual(proc.stdout.readline().strip(), b"ready")
        started = Started(proc, __import__("collections").deque())
        started.stop()
        self.assertTrue(started.exited)
        self.assertEqual(proc.returncode, -9, "killed, since it would not stop when asked")

    def test_a_node_still_running_when_the_script_ends_is_killed_by_the_exit_hook_and_one_that_is_gone_is_left(self):
        proc = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(120)"])
        self.addCleanup(lambda: proc.poll() is None and proc.kill())
        started = Started(proc, __import__("collections").deque())
        self.addCleanup(started.stop)
        started._at_exit()
        proc.wait(timeout=10)
        self.assertEqual(proc.returncode, -9)
        started._at_exit()


class Answering(unittest.TestCase):
    """A listener that answers with an error status is still something answering: what the node does for a request it
    does not know."""

    def serve(self, drop_first=0):
        heard = []

        class H(BaseHTTPRequestHandler):
            def do_GET(self):
                heard.append(self.path)
                if len(heard) <= drop_first:
                    self.connection.close()
                    return
                data = b'{"error": "no such route"}'
                self.send_response(404)
                self.send_header("content-length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def log_message(self, *a):
                pass

        server = ThreadingHTTPServer(("127.0.0.1", 0), H)
        threading.Thread(target=server.serve_forever, args=(0.01,), daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        return f"http://127.0.0.1:{server.server_address[1]}", heard

    def test_a_listener_answering_not_found_is_a_node_that_answers_so_none_is_started(self):
        url, heard = self.serve()
        got = bring(base_url=url, token="named-token", program=Path("/nonexistent/unbrowse-node"))
        self.assertEqual(got, (url, "named-token", None))
        self.assertEqual(len(heard), 1)

    @unittest.skipIf(sys.platform == "win32", "the stub is a script with a shebang")
    def test_a_node_that_exits_having_lost_the_port_to_one_that_answers_is_not_an_error_and_nothing_is_left_to_stop(self):
        # Asked three times, in the order bring() asks: nothing answers before it starts a node; nothing answers when the
        # started node, which has exited by then, is first looked for; then the other node answers. Which ask hears what
        # is scripted, and the started node is waited for until it has exited, so no clock decides the order.
        url = "http://127.0.0.1:9"
        asks = []

        def answers_in_order(asked):
            asks.append(asked)
            return len(asks) == 3

        real_launch = start_module._launch

        def launched_and_gone(*args, **kwargs):
            s = real_launch(*args, **kwargs)
            s._proc.wait(timeout=10)
            return s

        with tempfile.TemporaryDirectory() as d:
            program = Path(d) / "unbrowse-node"
            program.write_text("#!/bin/sh\nexit 1\n")
            program.chmod(0o755)
            with mock.patch.object(start_module, "_answers", answers_in_order), mock.patch.object(start_module, "_launch", launched_and_gone):
                got = bring(base_url=url, token="named-token", program=program, ready_timeout=20)
        self.assertEqual(got, (url, "named-token", None))
        self.assertEqual(asks, [url, url, url])


if __name__ == "__main__":
    unittest.main()
