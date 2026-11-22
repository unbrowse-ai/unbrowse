"""watch_runs.py watches every run a pushed commit started, picks up runs that start later, and is green only when
every one of them ended green (AGENTS.md, "Push, then watch the run"; UNB-235)."""
import io
import json
import pathlib
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
import watch_runs  # noqa: E402


def run(run_id, workflow, status="completed", conclusion="success"):
    return {"databaseId": run_id, "workflowName": workflow, "status": status, "conclusion": conclusion,
            "event": "push", "url": f"https://example.invalid/runs/{run_id}"}


class FakeGh:
    """Each `gh run list` answers the next listing; the last one repeats. Other calls are recorded."""

    def __init__(self, listings, jobs=None, log="", download_code=0):
        self.listings, self.jobs, self.log, self.download_code = listings, jobs or {}, log, download_code
        self.calls = []

    def __call__(self, args):
        self.calls.append(args)
        if args[:2] == ["run", "list"]:
            listing = self.listings.pop(0) if len(self.listings) > 1 else self.listings[0]
            return 0, json.dumps(listing)
        if args[:2] == ["run", "view"] and "--json" in args:
            return 0, json.dumps({"jobs": self.jobs.get(int(args[2]), [])})
        if args[:2] == ["run", "view"]:
            return 0, self.log
        if args[:2] == ["run", "download"]:
            return self.download_code, "" if self.download_code == 0 else "no valid artifacts found to download"
        return 0, ""

    def watched(self):
        return [int(a[2]) for a in self.calls if a[:2] == ["run", "watch"]]


class Clock:
    def __init__(self):
        self.now = 0.0

    def __call__(self):
        return self.now

    def sleep(self, seconds):
        self.now += seconds


def watch(fake, settle=30):
    clock, out = Clock(), io.StringIO()
    code = watch_runs.watch("abc123", settle=settle, poll=10, artifacts="/tmp/x", call=fake, sleep=clock.sleep,
                            clock=clock, out=out)
    return code, out.getvalue()


class WatchRuns(unittest.TestCase):
    def test_every_run_green_is_green_and_names_each_run(self):
        fake = FakeGh([[run(2, "QA"), run(1, "CI")]])
        code, out = watch(fake)
        self.assertEqual(code, 0)
        self.assertEqual(fake.watched(), [1, 2])
        self.assertEqual(out.splitlines()[-1], "RUNS_GREEN sha=abc123 runs=1:CI,2:QA")

    def test_a_run_that_starts_later_is_watched_too(self):
        fake = FakeGh([[run(1, "CI")], [run(1, "CI")], [run(1, "CI"), run(3, "Dashboard", conclusion="failure")]])
        code, out = watch(fake)
        self.assertEqual(fake.watched(), [1, 3])
        self.assertEqual(code, 1)
        self.assertIn("RUNS_RED sha=abc123 red=3:Dashboard:failure", out)

    def test_a_failed_run_names_its_job_and_step_quotes_the_log_and_downloads_the_artifacts(self):
        jobs = {7: [{"name": "Claude QA", "conclusion": "failure",
                     "steps": [{"name": "checkout", "conclusion": "success"},
                               {"name": "Drive the node", "conclusion": "failure"}]},
                    {"name": "build", "conclusion": "success", "steps": []}]}
        fake = FakeGh([[run(7, "QA", conclusion="failure")]], jobs=jobs, log="line a\nqa: step 4 failed: no reply\n")
        code, out = watch(fake)
        self.assertEqual(code, 1)
        self.assertIn("failed: Claude QA (failure): Drive the node", out)
        self.assertNotIn("build (success)", out)
        self.assertIn("| qa: step 4 failed: no reply", out)
        self.assertIn(["run", "download", "7", "-D", "/tmp/x/run-7"], fake.calls)
        self.assertIn("artifacts: /tmp/x/run-7", out)

    def test_a_cancelled_run_is_not_green(self):
        code, out = watch(FakeGh([[run(1, "CI"), run(2, "QA", conclusion="cancelled")]]))
        self.assertEqual(code, 1)
        self.assertTrue(out.splitlines()[-1].startswith("RUNS_RED sha=abc123 red=2:QA:cancelled"))

    def test_a_skipped_run_is_green(self):
        code, _ = watch(FakeGh([[run(1, "CI"), run(2, "Bank", conclusion="skipped")]]))
        self.assertEqual(code, 0)

    def test_a_run_still_going_when_listed_last_is_not_green(self):
        fake = FakeGh([[run(1, "CI")], [run(1, "CI", status="in_progress", conclusion="")]])
        code, out = watch(fake)
        self.assertEqual(code, 1)
        self.assertIn("1:CI:in_progress", out)

    def test_no_run_at_all_is_not_green(self):
        code, out = watch(FakeGh([[]]))
        self.assertEqual(code, 2)
        self.assertEqual(out.splitlines()[-1], "RUNS_NONE sha=abc123")

    def test_a_run_without_artifacts_says_so(self):
        fake = FakeGh([[run(4, "CI", conclusion="failure")]], download_code=1)
        _, out = watch(fake)
        self.assertIn("artifacts: none (no valid artifacts found to download)", out)


if __name__ == "__main__":
    unittest.main()
