"""UNB-248: nothing on GitHub refuses a red merge on the free plan, so the gates are in the path after it.

On 23-24 Nov 2026 ten pull requests (#875, #879, #884, #888, #890-#893, #900, #901) merged into staging with checks
failed, cancelled or still running. `checks_green.py red-merge` reads a merged pull request's checks and pr-closed.yml
opens a revert; `checks_green.py sha` is the release gate's reading of one commit's own checks. The fixtures are
recorded from the repository: #884 (merged red), #909 (merged green), and the push runs of staging 2f50a43c4 (all
green) and 126851c22 (Coverage cancelled).
"""
from __future__ import annotations

import copy
import importlib.util
import json
import os
import pathlib
import stat
import subprocess
import sys
import tempfile
import unittest

import yaml

HERE = pathlib.Path(__file__).resolve().parent
SCRIPTS = HERE.parent
WORKFLOWS = SCRIPTS.parent / "workflows"
FIX = HERE / "fixtures" / "checks_green"

spec = importlib.util.spec_from_file_location("checks_green", SCRIPTS / "checks_green.py")
cg = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cg)

OWN = {"Closed pull request"}


def pr(n: int) -> dict:
    return json.loads((FIX / f"pr-{n}.json").read_text())


def message(n: int) -> str:
    return (FIX / f"pr-{n}-merge-message.txt").read_text()


class ARedMergeIsSeen(unittest.TestCase):
    def test_884_merged_with_failed_and_cancelled_checks_is_a_red_merge(self):
        got = cg.red_merge(pr(884), message(884), OWN)
        self.assertTrue(got["red"], got["why"])
        self.assertEqual(got["merged_by"], "lekt9")
        self.assertIn("`lekt9`", got["body"])
        self.assertTrue(any("failed" in b for b in got["bad"]), got["bad"])
        self.assertTrue(any("cancelled" in b for b in got["bad"]), got["bad"])
        self.assertFalse(any("Stop the closed pull request" in b for b in got["bad"]),
                         "the closing workflow's own jobs are not the pull request's checks")
        self.assertIn("Agent (merge commit trailer): none", got["body"], "no trailer is said as none, not dropped")

    def test_909_merged_with_every_check_green_is_not(self):
        got = cg.red_merge(pr(909), message(909), OWN)
        self.assertFalse(got["red"], got.get("bad"))
        self.assertGreater(got["checks"], 10)

    def test_a_check_still_running_at_the_merge_is_a_red_merge(self):
        p = pr(909)
        check = next(c for c in p["statusCheckRollup"] if c.get("conclusion") == "SUCCESS")
        check["status"], check["conclusion"] = "IN_PROGRESS", ""
        got = cg.red_merge(p, "", OWN)
        self.assertTrue(got["red"])
        self.assertEqual(got["bad"], [cg.label({"workflow": check["workflowName"], "name": check["name"],
                                                 "url": check["detailsUrl"], "state": "running"})])
        self.assertIn("still running", got["bad"][0])

    def test_a_queued_check_and_a_pending_status_are_running(self):
        self.assertEqual(cg.reading("QUEUED", None), "running")
        self.assertEqual(cg.reading("COMPLETED", None), "red", "completed with no conclusion is not a pass")
        self.assertEqual(cg.reading("COMPLETED", "TIMED_OUT"), "red")
        self.assertEqual(cg.reading("COMPLETED", "STARTUP_FAILURE"), "red")
        p = pr(909)
        p["statusCheckRollup"].append({"__typename": "StatusContext", "context": "ext", "state": "PENDING"})
        self.assertTrue(cg.red_merge(p, "", OWN)["red"])
        p["statusCheckRollup"][-1]["state"] = "SUCCESS"
        self.assertFalse(cg.red_merge(p, "", OWN)["red"])

    def test_a_rerun_that_passed_replaces_the_failure_it_reran(self):
        p = pr(909)
        check = next(c for c in p["statusCheckRollup"] if c.get("conclusion") == "SUCCESS")
        failed = dict(check, conclusion="FAILURE", startedAt="2000-01-01T00:00:00Z")
        p["statusCheckRollup"].insert(0, failed)
        self.assertFalse(cg.red_merge(p, "", OWN)["red"])
        newer = dict(check, conclusion="FAILURE", startedAt="2999-01-01T00:00:00Z")
        p["statusCheckRollup"].append(newer)
        self.assertTrue(cg.red_merge(p, "", OWN)["red"], "a newer failure is the check's state")

    def test_only_a_merge_into_staging_that_is_not_a_revert_is_read(self):
        p = copy.deepcopy(pr(884))
        p["headRefName"] = "revert/0123456789ab"
        self.assertFalse(cg.red_merge(p, "", OWN)["red"], "a revert is never reverted")
        p = copy.deepcopy(pr(884))
        p["baseRefName"] = "release/13.1"
        self.assertFalse(cg.red_merge(p, "", OWN)["red"])
        p = copy.deepcopy(pr(884))
        p["mergedAt"] = None
        self.assertFalse(cg.red_merge(p, "", OWN)["red"])

    def test_the_agent_and_model_trailers_reach_the_comment(self):
        msg = message(884) + "\nAgent: opencode\nAgent-Model: opencode-go/deepseek-v4.1-flash\n"
        got = cg.red_merge(pr(884), msg, OWN)
        self.assertIn("Agent (merge commit trailer): opencode", got["body"])
        self.assertIn("Agent-Model (merge commit trailer): opencode-go/deepseek-v4.1-flash", got["body"])
        self.assertEqual(cg.trailers("x\n\nAgent: claude-code\nagent: claude-code\n")["agent"], ["claude-code"])

    def test_the_command_writes_its_verdict_for_the_workflow(self):
        with tempfile.TemporaryDirectory() as d:
            d = pathlib.Path(d)
            out, body = d / "out", d / "body.md"
            env = dict(os.environ, GITHUB_OUTPUT=str(out), GITHUB_STEP_SUMMARY=str(d / "summary"))
            got = subprocess.run([sys.executable, "-I", str(SCRIPTS / "checks_green.py"), "red-merge",
                                  "--pr-json", str(FIX / "pr-884.json"), "--message", str(FIX / "pr-884-merge-message.txt"),
                                  "--ignore-workflow", "Closed pull request", "--body", str(body)],
                                 env=env, capture_output=True, text=True)
            self.assertEqual(got.returncode, 0, got.stderr)
            self.assertEqual(out.read_text(), "red=true\n")
            self.assertIn("merged into staging by `lekt9`", body.read_text())
            got = subprocess.run([sys.executable, "-I", str(SCRIPTS / "checks_green.py"), "red-merge",
                                  "--pr-json", str(FIX / "pr-909.json"), "--body", str(d / "b2")],
                                 env=dict(env, GITHUB_OUTPUT=str(d / "out2")), capture_output=True, text=True)
            self.assertEqual((d / "out2").read_text(), "red=false\n")
            self.assertFalse((d / "b2").exists(), "no comment for a green merge")


def fake_gh(d: pathlib.Path, runs_files: list[pathlib.Path]) -> dict:
    """A `gh` that answers `api … actions/runs` with each recorded file in turn (the last one again after that)."""
    gh = d / "gh"
    gh.write_text(f"""#!{sys.executable}
import json, os, pathlib, sys
files = {json.dumps([str(f) for f in runs_files])}
count = pathlib.Path({json.dumps(str(d / 'calls'))})
n = int(count.read_text()) if count.exists() else 0
count.write_text(str(n + 1))
with open({json.dumps(str(d / 'argv'))}, "a") as f:
    f.write(json.dumps(sys.argv[1:]) + "\\n")
for run in json.load(open(files[min(n, len(files) - 1)]))["workflow_runs"]:
    print(json.dumps(run))
""")
    gh.chmod(gh.stat().st_mode | stat.S_IEXEC)
    return dict(os.environ, PATH=f"{d}:{os.environ['PATH']}", GITHUB_STEP_SUMMARY=str(d / "summary"))


def sha(env: dict, *extra: str) -> subprocess.CompletedProcess:
    return subprocess.run([sys.executable, "-I", str(SCRIPTS / "checks_green.py"), "sha", "--repo", "o/r",
                           "--sha", "2f50a43c4abc", "--interval", "0", *extra], env=env, capture_output=True, text=True)


class TheReleaseReadsTheCommitsOwnChecks(unittest.TestCase):
    def test_a_commit_whose_push_runs_all_passed_is_green(self):
        with tempfile.TemporaryDirectory() as d:
            d = pathlib.Path(d)
            got = sha(fake_gh(d, [FIX / "runs-push-2f50a43c4.json"]))
            self.assertEqual(got.returncode, 0, got.stdout + got.stderr)
            self.assertIn("All green.", (d / "summary").read_text())
            argv = json.loads((d / "argv").read_text().splitlines()[0])
            self.assertIn("event=push", argv, "only the commit's own pushes: another workflow_run hangs here too")
            # Each -f is followed by its own key=value, as gh reads it. The release refused staging 9e956a99 because
            # `-f event=push` went in between `-f` and `head_sha=...`: gh got `-f -f event=push head_sha=...` and failed
            # (Release 45442586420, "nothing is released from 9e956a9964cf").
            fields = [argv[i + 1] for i, a in enumerate(argv) if a == "-f"]
            self.assertTrue(all("=" in f and not f.startswith("-") for f in fields), argv)
            self.assertEqual(sorted(f.split("=", 1)[0] for f in fields), ["event", "head_sha", "per_page"], argv)
            self.assertIn("head_sha=2f50a43c4abc", argv)

    def test_a_cancelled_run_refuses_the_commit(self):
        with tempfile.TemporaryDirectory() as d:
            d = pathlib.Path(d)
            got = sha(fake_gh(d, [FIX / "runs-push-126851c22.json"]))
            self.assertEqual(got.returncode, 1)
            self.assertIn("Coverage: cancelled", got.stderr)

    def test_a_commit_no_run_passed_is_refused(self):
        with tempfile.TemporaryDirectory() as d:
            d = pathlib.Path(d)
            empty = d / "empty.json"
            empty.write_text('{"workflow_runs": []}')
            got = sha(fake_gh(d, [empty]))
            self.assertEqual(got.returncode, 1)
            self.assertIn("nothing shows it passed", got.stdout)

    def test_runs_still_going_are_waited_on_and_the_callers_own_run_is_not(self):
        with tempfile.TemporaryDirectory() as d:
            d = pathlib.Path(d)
            green = json.loads((FIX / "runs-push-2f50a43c4.json").read_text())
            own = {"id": 777, "name": "Release", "event": "push", "status": "in_progress", "conclusion": None,
                   "run_attempt": 1, "created_at": "2026-11-24T10:00:00Z", "html_url": ""}
            going = copy.deepcopy(green)
            going["workflow_runs"][1].update(status="in_progress", conclusion=None)
            first, then = d / "first.json", d / "then.json"
            first.write_text(json.dumps({"workflow_runs": going["workflow_runs"] + [own]}))
            then.write_text(json.dumps({"workflow_runs": green["workflow_runs"] + [own]}))
            got = sha(fake_gh(d, [first, then]), "--skip-run", "777", "--wait", "30")
            self.assertEqual(got.returncode, 0, got.stdout + got.stderr)
            self.assertIn("waiting on 1 run(s)", got.stdout)
            self.assertEqual((d / "calls").read_text(), "2")

    def test_a_run_still_going_when_the_wait_ends_refuses(self):
        with tempfile.TemporaryDirectory() as d:
            d = pathlib.Path(d)
            going = json.loads((FIX / "runs-push-2f50a43c4.json").read_text())
            going["workflow_runs"][0].update(status="queued", conclusion=None)
            f = d / "going.json"
            f.write_text(json.dumps(going))
            got = sha(fake_gh(d, [f]), "--wait", "0")
            self.assertEqual(got.returncode, 1)
            self.assertIn("still running", got.stderr)


class TheRevertIsOpenedNotMerged(unittest.TestCase):
    def test_the_revert_takes_the_commit_back_out_on_its_own_branch(self):
        with tempfile.TemporaryDirectory() as d:
            d = pathlib.Path(d)
            origin = d / "origin.git"
            work = d / "work"
            git = ["git", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "init.defaultBranch=staging"]
            subprocess.run([*git, "init", "-q", "--bare", str(origin)], check=True)
            subprocess.run(["git", "-C", str(origin), "config", "uploadpack.allowAnySHA1InWant", "true"], check=True)
            subprocess.run([*git, "clone", "-q", str(origin), str(work)], check=True, capture_output=True)
            (work / "f").write_text("one")
            subprocess.run([*git, "-C", str(work), "add", "f"], check=True)
            subprocess.run([*git, "-C", str(work), "commit", "-qm", "one"], check=True)
            (work / "f").write_text("two")
            subprocess.run([*git, "-C", str(work), "commit", "-qam", "two"], check=True)
            subprocess.run(["git", "-C", str(work), "push", "-q", "origin", "HEAD:staging"], check=True)
            bad = subprocess.run(["git", "-C", str(work), "rev-parse", "HEAD"], capture_output=True, text=True).stdout.strip()
            log = d / "gh.log"
            gh = d / "gh"
            gh.write_text(f"""#!/bin/sh
echo "$*" >> "{log}"
case "$*" in
  *"/branches/"*) exit 1 ;;
  *"/commits/"*) echo 1 ;;
  "pr create"*) echo https://github.com/o/r/pull/999 ;;
esac
""")
            gh.chmod(gh.stat().st_mode | stat.S_IEXEC)
            env = dict(os.environ, PATH=f"{d}:{os.environ['PATH']}", REPO="o/r", GH_TOKEN="x",
                       ORIGIN=f"file://{origin}", RUNNER_TEMP=str(d))
            got = subprocess.run(["bash", str(SCRIPTS / "open-revert.sh"), bad, "revert: #1", "why"], env=env,
                                 capture_output=True, text=True)
            self.assertEqual(got.returncode, 0, got.stderr)
            self.assertEqual(got.stdout.strip().splitlines()[-1], "https://github.com/o/r/pull/999")
            branch = f"revert/{bad[:12]}"
            shown = subprocess.run(["git", "-C", str(origin), "show", f"{branch}:f"], capture_output=True, text=True)
            self.assertEqual(shown.stdout, "one", "the branch holds the tree from before the commit")
            calls = log.read_text()
            self.assertIn(f"pr create --repo o/r --base staging --head {branch}", calls)
            self.assertIn(f"workflow run ci.yml --repo o/r --ref {branch}", calls)
            self.assertNotIn("merge", calls.replace("pr create", ""), "it merges nothing")


class TheGatesAreWired(unittest.TestCase):
    def load(self, name: str) -> dict:
        return yaml.safe_load((WORKFLOWS / name).read_text())

    def steps(self, doc: dict, job: str) -> list[dict]:
        return doc["jobs"][job]["steps"]

    def test_a_merge_into_staging_is_read_and_a_red_one_reverted(self):
        job = self.load("pr-closed.yml")["jobs"]["red-merge"]
        self.assertIn("github.event.pull_request.merged == true", job["if"])
        self.assertIn("base.ref == 'staging'", job["if"])
        runs = "\n".join(s.get("run", "") for s in job["steps"])
        self.assertIn("checks_green.py red-merge", runs)
        self.assertIn('--ignore-workflow "$GITHUB_WORKFLOW"', runs)
        self.assertIn("open-revert.sh", runs)
        self.assertNotRegex(runs, r"gh pr merge|/merge\b", "the backstop merges nothing")

    def test_both_reverts_open_through_one_script(self):
        runs = "\n".join(s.get("run", "") for s in self.steps(self.load("staging-revert.yml"), "revert"))
        self.assertIn("open-revert.sh", runs)
        self.assertNotIn("git revert", runs)

    def test_nothing_is_released_from_a_commit_whose_checks_are_not_green(self):
        steps = self.steps(self.load("release.yml"), "version")
        names = [s.get("name") for s in steps]
        gate = steps[names.index("Every check on this commit is green")]
        self.assertLess(names.index("Every check on this commit is green"), names.index("Npm has every package"))
        self.assertEqual(gate["if"], "steps.next.outputs.version != ''", "every channel, not only production")
        self.assertIn("checks_green.py sha", gate["run"])
        self.assertIn('--skip-run "$GITHUB_RUN_ID"', gate["run"])
        self.assertIn("exit 1", gate["run"])

    def test_a_release_branch_is_promoted_only_with_its_checks_green(self):
        steps = self.steps(self.load("promotion-gate.yml"), "release")
        runs = [s.get("run", "") for s in steps]
        first = next(i for i, r in enumerate(runs) if "checks_green.py sha" in r)
        gate = next(i for i, r in enumerate(runs) if "promotion-gate.sh" in r)
        self.assertLess(first, gate)


class TheBackstopMayReadWhatItJudges(unittest.TestCase):
    """The red-merge job reads the merged pull request's statusCheckRollup, which GitHub only gives a token with
    `checks: read` and `statuses: read`. Without them every merge since 24 Nov failed before judging anything:
    "GraphQL: Resource not accessible by integration (…statusCheckRollup)" (Closed pull request 45449059793, #922), so
    no red merge was ever reverted."""

    def test_the_red_merge_job_may_read_checks_and_statuses(self):
        import yaml
        doc = yaml.safe_load((pathlib.Path(__file__).resolve().parents[2] / "workflows" / "pr-closed.yml").read_text())
        perms = doc["jobs"]["red-merge"]["permissions"]
        self.assertIn("statusCheckRollup", (pathlib.Path(__file__).resolve().parents[2] / "workflows" / "pr-closed.yml").read_text())
        self.assertEqual((perms.get("checks"), perms.get("statuses")), ("read", "read"), perms)


if __name__ == "__main__":
    unittest.main()
