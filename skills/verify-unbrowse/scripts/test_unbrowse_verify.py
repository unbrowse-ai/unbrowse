"""The verification CLI's promises that need no node: it never acts on the owner's node, never kills what it didn't
start, keeps the evidence through cleanup, and answers every failure as JSON that says what to do.

    python3 -I -m unittest discover -s skills/verify-unbrowse/scripts -p 'test_*.py' -v
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

CLI = os.path.join(os.path.dirname(os.path.abspath(__file__)), "unbrowse-verify")
PORT = 19873  # a port no scratch node of a real run uses


class Cli(unittest.TestCase):
    def setUp(self):
        self.state = tempfile.mkdtemp(prefix="ubv-test-state-")
        self.scratch = f"/tmp/ubv-{PORT}"
        shutil.rmtree(self.scratch, ignore_errors=True)
        self.procs = []

    def tearDown(self):
        for p in self.procs:
            p.kill()
            p.wait()
        shutil.rmtree(self.state, ignore_errors=True)
        shutil.rmtree(self.scratch, ignore_errors=True)

    def run_cli(self, *args):
        env = {**os.environ, "UBV_STATE": self.state}
        r = subprocess.run([sys.executable, CLI, *args], capture_output=True, text=True, env=env, timeout=60)
        try:
            body = json.loads(r.stdout) if r.stdout.strip().startswith("{") else None
        except ValueError:
            body = None
        return r.returncode, body, r

    def record(self, pid):
        os.makedirs(os.path.join(self.state, "nodes"), exist_ok=True)
        home = f"{self.scratch}/home/node"
        os.makedirs(home, exist_ok=True)
        with open(os.path.join(self.state, "nodes", f"{PORT}.json"), "w") as f:
            json.dump({"port": PORT, "dir": self.scratch, "home": home, "pid": pid,
                       "node": "/nonexistent/unbrowse-node", "unb": "/nonexistent/unb"}, f)

    def test_the_owners_port_is_refused_by_every_command_that_takes_a_port(self):
        for cmd in ("start", "doctor", "do", "api", "mcp", "owner", "node", "unb", "logs", "stop", "cleanup"):
            extra = {"do": ["--url", "https://example.com/", "--goal", "x"], "api": ["GET", "/v1/whoami"],
                     "owner": ["node_info"]}.get(cmd, [])
            code, body, r = self.run_cli(cmd, "--port", "7788", *extra)
            self.assertEqual(code, 1, f"{cmd}: {r.stdout} {r.stderr}")
            self.assertIn("owner", body["error"], cmd)
            self.assertIn("fix", body, cmd)

    def test_a_failure_says_what_to_do_as_json(self):
        code, body, _ = self.run_cli("do", "--port", str(PORT), "--url", "https://example.com/", "--goal", "x")
        self.assertEqual(code, 1)
        self.assertFalse(body["ok"])
        self.assertIn("unbrowse-verify start", body["fix"])

    def test_every_command_has_help(self):
        code, _, r = self.run_cli("--help")
        self.assertEqual(code, 0)
        for cmd in ("build", "runtime", "start", "doctor", "do", "api", "mcp", "owner", "node", "unb", "logs",
                    "stop", "cleanup", "list"):
            self.assertIn(cmd, r.stdout)
            code, _, sub = self.run_cli(cmd, "--help")
            self.assertEqual(code, 0, cmd)
            self.assertGreater(len(sub.stdout), 150, cmd)

    def test_stop_never_kills_a_process_that_is_not_the_scratch_node(self):
        bystander = subprocess.Popen(["sleep", "60"])
        self.procs.append(bystander)
        self.record(bystander.pid)
        code, body, _ = self.run_cli("stop", "--port", str(PORT))
        self.assertEqual(code, 1)
        self.assertIn("no longer this scratch node", body["error"])
        self.assertIsNone(bystander.poll(), "the bystander was killed")

    def test_stop_takes_what_the_node_started_and_leaves_what_only_names_its_folder(self):
        self.record(None)
        started = subprocess.Popen(["sleep", "60"], env={"PATH": os.environ["PATH"],
                                                         "UNBROWSE_HOME": f"{self.scratch}/home/node"})
        reader = subprocess.Popen(["sh", "-c", f"sleep 60; cat {self.scratch}/node.log"])
        self.procs += [started, reader]
        code, body, _ = self.run_cli("stop", "--port", str(PORT))
        self.assertEqual(code, 0, body)
        self.assertIsNotNone(started.wait(timeout=20), "what the node started was left running")
        self.assertIsNone(reader.poll(), "a process that only names the folder was killed")

    def test_cleanup_removes_the_scratch_node_and_keeps_the_evidence(self):
        self.record(None)
        ev = os.path.join(self.state, "evidence", str(PORT))
        os.makedirs(ev)
        with open(os.path.join(ev, "proof.json"), "w") as f:
            f.write("{}")
        code, body, _ = self.run_cli("cleanup", "--port", str(PORT), "--dry-run")
        self.assertEqual(code, 0)
        self.assertTrue(os.path.isdir(self.scratch), "a dry run removed something")
        code, body, _ = self.run_cli("cleanup", "--port", str(PORT))
        self.assertEqual(code, 0)
        self.assertFalse(os.path.exists(self.scratch))
        self.assertFalse(os.path.exists(os.path.join(self.state, "nodes", f"{PORT}.json")))
        self.assertTrue(os.path.exists(os.path.join(ev, "proof.json")))
        self.assertTrue(body["cleaned"][0]["evidence_still_there"])

    def test_start_dry_run_starts_nothing(self):
        code, body, _ = self.run_cli("start", "--port", str(PORT), "--dry-run")
        self.assertFalse(os.path.exists(self.scratch))
        self.assertFalse(os.path.exists(os.path.join(self.state, "nodes", f"{PORT}.json")))
        self.assertIn("plan", body)


if __name__ == "__main__":
    unittest.main()
