"""place_jobs.py: an agent job goes to a free local runner, and to Blacksmith whenever none is free (UNB-166)."""

import importlib.util
import io
import json
import os
import tempfile
import unittest
from contextlib import redirect_stdout
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
spec = importlib.util.spec_from_file_location("place_jobs", ROOT / ".github/scripts/place_jobs.py")
pj = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pj)

MAC = ["self-hosted", "macOS", "ARM64", "lewis-mbp"]
LINUX = ["self-hosted", "linux", "x64"]
NOW = datetime(2026, 11, 21, 12, 0, tzinfo=timezone.utc)
REPO = "o/r"


def ago(minutes):
    return (NOW - timedelta(minutes=minutes)).strftime("%Y-%m-%dT%H:%M:%SZ")


def api(runs):
    """A fake repository API: `runs` is {run_id: (status, [job, ...])}."""
    def get(path):
        if "/actions/runs?status=" in path:
            status = path.split("status=")[1].split("&")[0]
            return {"workflow_runs": [{"id": rid} for rid, (s, _) in runs.items() if s == status]}
        rid = int(path.split("/actions/runs/")[1].split("/")[0])
        return {"jobs": runs[rid][1]}
    return get


def runners(*rows):
    def get(path):
        assert path.endswith("/actions/runners?per_page=100"), path
        return {"runners": [{"status": s, "busy": b, "labels": [{"name": n} for n in labels]} for s, b, labels in rows]}
    return get


class PoolState(unittest.TestCase):
    def test_an_idle_mac_with_nothing_waiting_is_free(self):
        free, _ = pj.pool_state(MAC, api({}), REPO, 1, NOW, runners(("online", False, MAC)))
        self.assertEqual(free, 1)

    def test_a_busy_or_offline_mac_is_not_free(self):
        self.assertEqual(pj.pool_state(MAC, api({}), REPO, 1, NOW, runners(("online", True, MAC)))[0], 0)
        self.assertEqual(pj.pool_state(MAC, api({}), REPO, 1, NOW, runners(("offline", False, MAC)))[0], 0)

    def test_a_job_already_waiting_takes_the_idle_runner_first(self):
        waiting = {7: ("queued", [{"status": "queued", "labels": MAC, "created_at": ago(1)}])}
        self.assertEqual(pj.pool_state(MAC, api(waiting), REPO, 1, NOW, runners(("online", False, MAC)))[0], 0)

    def test_a_linux_runner_is_not_a_mac(self):
        self.assertEqual(pj.pool_state(MAC, api({}), REPO, 1, NOW, runners(("online", False, LINUX)))[0], 0)

    def test_labels_match_without_case(self):
        waiting = {7: ("queued", [{"status": "queued", "labels": ["self-hosted", "macos", "arm64", "lewis-mbp"], "created_at": ago(1)}])}
        free, why = pj.pool_state(MAC, api(waiting), REPO, 1, NOW, None, slots=1)
        self.assertEqual(free, 0, why)

    def test_this_runs_own_jobs_are_not_counted(self):
        own = {1: ("in_progress", [{"status": "in_progress", "labels": MAC}])}
        self.assertEqual(pj.pool_state(MAC, api(own), REPO, 1, NOW, None, slots=1)[0], 1)

    def test_without_the_runner_token_slots_less_running_and_waiting(self):
        runs = {7: ("in_progress", [{"status": "in_progress", "labels": LINUX}, {"status": "queued", "labels": LINUX, "created_at": ago(2)}])}
        self.assertEqual(pj.pool_state(LINUX, api(runs), REPO, 1, NOW, None, slots=4)[0], 2)

    def test_without_the_runner_token_a_wait_with_nothing_running_means_the_pool_is_asleep(self):
        runs = {7: ("queued", [{"status": "queued", "labels": LINUX, "created_at": ago(3)}])}
        free, why = pj.pool_state(LINUX, api(runs), REPO, 1, NOW, None, slots=4)
        self.assertEqual(free, 0)
        self.assertIn("asleep", why)
        # A wait of seconds is a runner picking the job up, not a pool asleep.
        runs = {7: ("queued", [{"status": "queued", "labels": LINUX, "created_at": ago(0.5)}])}
        self.assertEqual(pj.pool_state(LINUX, api(runs), REPO, 1, NOW, None, slots=4)[0], 3)

    def test_without_the_runner_token_a_long_wait_means_the_pool_is_not_answering(self):
        runs = {7: ("queued", [{"status": "queued", "labels": MAC, "created_at": ago(25)}]),
                8: ("in_progress", [{"status": "in_progress", "labels": MAC}])}
        free, why = pj.pool_state(MAC, api(runs), REPO, 1, NOW, None, slots=4)
        self.assertEqual(free, 0)
        self.assertIn("waited", why)


class Place(unittest.TestCase):
    def test_one_free_mac_takes_the_first_job_asked_and_the_rest_go_to_blacksmith(self):
        placed, _ = pj.place([("qa", "mac"), ("check", "mac"), ("slice", "mac")], {"mac": MAC}, {"mac": (1, "")}, False)
        self.assertEqual(placed, {"qa": MAC, "check": pj.FALLBACK["mac"], "slice": pj.FALLBACK["mac"]})

    def test_a_fork_never_gets_a_local_runner(self):
        placed, why = pj.place([("qa", "mac"), ("skills", "linux")], {"mac": MAC, "linux": LINUX}, {"mac": (9, ""), "linux": (9, "")}, True)
        self.assertEqual(placed, {"qa": pj.FALLBACK["mac"], "skills": pj.FALLBACK["linux"]})
        self.assertIn("fork", why["qa"])

    def test_no_pool_set_means_blacksmith(self):
        placed, _ = pj.place([("qa", "mac")], {"mac": None}, {"mac": (0, "")}, False)
        self.assertEqual(placed["qa"], pj.FALLBACK["mac"])

    def test_an_unknown_pool_is_refused(self):
        with self.assertRaises(ValueError):
            pj.place([("qa", "windows")], {}, {}, False)


class Main(unittest.TestCase):
    def run_main(self, argv, env):
        with tempfile.TemporaryDirectory() as d:
            out, summary = os.path.join(d, "out"), os.path.join(d, "summary")
            env = dict(env, GITHUB_OUTPUT=out, GITHUB_STEP_SUMMARY=summary)
            with redirect_stdout(io.StringIO()):
                placed = pj.main(argv, env)
            return placed, Path(out).read_text(), Path(summary).read_text()

    def test_anything_unreadable_sends_every_job_to_blacksmith(self):
        # No GH_TOKEN: the read fails, and the jobs still get a machine that starts.
        placed, out, summary = self.run_main(["qa=mac", "skills=linux"], {"GITHUB_REPOSITORY": REPO, "MAC_POOL": json.dumps(MAC)})
        self.assertEqual(placed, {"qa": pj.FALLBACK["mac"], "skills": pj.FALLBACK["linux"]})
        self.assertIn(f"qa={json.dumps(pj.FALLBACK['mac'])}", out)
        self.assertIn("| qa |", summary)

    def test_each_output_is_json_runs_on_can_read(self):
        _, out, _ = self.run_main(["qa=mac"], {"FORK": "true", "MAC_POOL": json.dumps(MAC), "GITHUB_REPOSITORY": REPO, "GH_TOKEN": "x"})
        key, _, value = out.strip().partition("=")
        self.assertEqual(key, "qa")
        self.assertEqual(json.loads(value), pj.FALLBACK["mac"])

    def test_a_bad_argument_is_refused(self):
        with self.assertRaises(SystemExit):
            pj.main(["qa"], {})

    def test_the_mac_pool_variable_reads_as_the_workflows_wrote_it(self):
        self.assertEqual(pj._labels('["self-hosted","macOS","ARM64","lewis-mbp"]'), MAC)
        self.assertIsNone(pj._labels(""))
        with self.assertRaises(ValueError):
            pj._labels("[1]")


if __name__ == "__main__":
    unittest.main()
