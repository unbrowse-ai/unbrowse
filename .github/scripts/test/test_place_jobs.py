"""place_jobs.py: an agent job goes to a free local runner, and to a hosted machine whenever none is free (UNB-166)."""

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

    def test_hosted_only_workflows_skip_jobs_queries(self):
        queried = []
        def get(path):
            queried.append(path)
            if "/actions/runs?status=in_progress" in path:
                return {"workflow_runs": [
                    {"id": 10, "path": ".github/workflows/pr-report.yml"},
                    {"id": 11, "path": ".github/workflows/ci.yml"},
                    {"id": 12, "path": ".github/workflows/pr-agent-checks.yml"},
                ]}
            if "/actions/runs?status=queued" in path:
                return {"workflow_runs": []}
            if "/actions/runs/12/jobs" in path:
                return {"jobs": [{"status": "in_progress", "labels": MAC}]}
            raise AssertionError(f"should not query hosted-only run: {path}")
        free, _ = pj.pool_state(MAC, get, REPO, 1, NOW, None, slots=1)
        self.assertEqual(free, 0)
        self.assertEqual([p for p in queried if "/jobs" in p], [f"/repos/{REPO}/actions/runs/12/jobs?filter=latest&per_page=100"])


class Place(unittest.TestCase):
    def test_one_free_mac_takes_the_first_job_asked_and_the_rest_go_to_a_hosted_mac(self):
        placed, _ = pj.place([("qa", "mac"), ("check", "mac"), ("slice", "mac")], {"mac": MAC}, {"mac": (1, "")}, False)
        self.assertEqual(placed, {"qa": MAC, "check": pj.FALLBACK["mac"], "slice": pj.FALLBACK["mac"]})

    def test_a_fork_never_gets_a_local_runner(self):
        placed, why = pj.place([("qa", "mac"), ("skills", "linux")], {"mac": MAC, "linux": LINUX}, {"mac": (9, ""), "linux": (9, "")}, True)
        self.assertEqual(placed, {"qa": pj.FALLBACK["mac"], "skills": pj.FALLBACK["linux"]})
        self.assertIn("fork", why["qa"])

    def test_no_pool_set_means_a_hosted_machine(self):
        placed, _ = pj.place([("qa", "mac")], {"mac": None}, {"mac": (0, "")}, False)
        self.assertEqual(placed["qa"], pj.FALLBACK["mac"])

    def test_an_unknown_pool_is_refused(self):
        with self.assertRaises(ValueError):
            pj.place([("qa", "windows")], {}, {}, False)


class TheSliceRunsOnlyOnLewissMac(unittest.TestCase):
    """Lewis, 28 Nov 2026: "run slices only on my Mac". A `mac-only` job (the gate bank's slice) goes to Lewis's Mac
    (OWN_MAC) whatever the pool's state, and waits for it: on a hosted Mac (a data centre's address) Ticketmaster and
    Carousell refuse the slice's tasks and its gate says PROMOTION_REFUSED (PR #945, run 46116646462)."""

    def test_a_busy_mac_keeps_the_slice_and_the_qa_shards_go_hosted(self):
        placed, why = pj.place([("slice", "mac-only"), ("qa1", "mac")], {"mac": MAC, "mac-only": MAC},
                               {"mac": (0, "busy")}, False)
        self.assertEqual(placed, {"slice": MAC, "qa1": pj.FALLBACK["mac"]})
        self.assertIn("waits", why["slice"])

    def test_a_free_mac_goes_to_the_slice_first_so_no_qa_shard_queues_beside_it(self):
        placed, _ = pj.place([("slice", "mac-only"), ("qa4", "mac"), ("qa1", "mac")], {"mac": MAC, "mac-only": MAC},
                             {"mac": (1, "idle")}, False)
        self.assertEqual(placed, {"slice": MAC, "qa4": pj.FALLBACK["mac"], "qa1": pj.FALLBACK["mac"]})

    def test_with_no_mac_pool_for_the_rest_the_slice_still_goes_to_the_mac(self):
        # qa.yml on a push: MAC_POOL is empty (only the nightly run puts QA shards on the Mac).
        placed, _ = pj.place([("slice", "mac-only"), ("qa1", "mac")], {"mac": None, "mac-only": MAC}, {}, False)
        self.assertEqual(placed, {"slice": MAC, "qa1": pj.FALLBACK["mac"]})

    def test_it_is_never_a_hosted_machine(self):
        for state in [(0, ""), (1, ""), (5, "")]:
            placed, _ = pj.place([("slice", "mac-only")], {"mac": MAC, "mac-only": MAC}, {"mac": state}, False)
            self.assertEqual(placed["slice"], MAC)
            self.assertNotIn(placed["slice"], pj.FALLBACK.values())

    def test_a_fork_or_no_own_mac_is_refused_never_sent_to_a_hosted_mac(self):
        with self.assertRaisesRegex(ValueError, "only on Lewis's Mac"):
            pj.place([("slice", "mac-only")], {"mac": MAC, "mac-only": MAC}, {"mac": (1, "")}, True)
        with self.assertRaisesRegex(ValueError, "only on Lewis's Mac"):
            pj.place([("slice", "mac-only")], {"mac": MAC, "mac-only": None}, {"mac": (1, "")}, False)

    def test_main_places_the_slice_on_the_mac_when_nothing_can_be_read(self):
        # No GH_TOKEN: every other job goes to its hosted fallback, the slice to the Mac all the same.
        env = {"GITHUB_REPOSITORY": REPO, "MAC_POOL": json.dumps(MAC), "OWN_MAC": json.dumps(MAC)}
        placed, out, summary = Main.run_main(self, ["slice=mac-only", "qa1=mac", "skills=linux"], env)
        self.assertEqual(placed, {"slice": MAC, "qa1": pj.FALLBACK["mac"], "skills": pj.FALLBACK["linux"]})
        self.assertIn(f"slice={json.dumps(MAC)}", out)
        self.assertIn("| slice |", summary)

    def test_main_places_the_slice_on_the_mac_when_it_is_asleep_or_busy(self):
        asleep = {7: ("queued", [{"status": "queued", "labels": MAC, "created_at": ago(30)}])}
        real = pj._http
        pj._http = lambda token: api(asleep)
        try:
            env = {"GITHUB_REPOSITORY": REPO, "GH_TOKEN": "x", "MAC_POOL": json.dumps(MAC), "OWN_MAC": json.dumps(MAC)}
            placed, _, _ = Main.run_main(self, ["slice=mac-only", "qa1=mac"], env)
        finally:
            pj._http = real
        self.assertEqual(placed, {"slice": MAC, "qa1": pj.FALLBACK["mac"]})

    def test_main_refuses_when_no_own_mac_is_set_or_it_is_not_self_hosted(self):
        for own in ["", json.dumps("macos-15"), json.dumps(["macos-15"])]:
            with self.subTest(own=own), self.assertRaises(SystemExit), redirect_stdout(io.StringIO()):
                pj.main(["slice=mac-only"], {"GITHUB_REPOSITORY": REPO, "OWN_MAC": own, "GITHUB_OUTPUT": os.devnull})


class Main(unittest.TestCase):
    def run_main(self, argv, env):
        with tempfile.TemporaryDirectory() as d:
            out, summary = os.path.join(d, "out"), os.path.join(d, "summary")
            env = dict(env, GITHUB_OUTPUT=out, GITHUB_STEP_SUMMARY=summary)
            with redirect_stdout(io.StringIO()):
                placed = pj.main(argv, env)
            return placed, Path(out).read_text(), Path(summary).read_text()

    def test_anything_unreadable_sends_every_job_to_a_hosted_machine(self):
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
