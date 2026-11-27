"""passed_on_pr.py says a push already passed only for a successful pull request run of pr-agent-checks.yml on the
same tree, from this repository, and says nothing when it cannot tell (UNB-166)."""
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import passed_on_pr as pp  # noqa: E402

REPO = "unbrowse-ai/unbrowse-core"
TREE = "3219fc34c3190108030b7c024ea564b6c030b460"
PUSH = ("push", "refs/heads/staging")


def artifact(run_id, name=f"gate-bank-slice-{TREE}", expired=False, head_repo=1, repo=1):
    return {"id": run_id * 10, "name": name, "expired": expired, "workflow_run": {"id": run_id, "repository_id": repo, "head_repository_id": head_repo}}


SHA = "9" * 40


def run(run_id, **changed):
    base = {"id": run_id, "path": ".github/workflows/pr-agent-checks.yml", "event": "pull_request", "status": "completed", "head_sha": SHA,
            "conclusion": "success", "repository": {"full_name": REPO}, "head_repository": {"full_name": REPO},
            "html_url": f"https://github.com/{REPO}/actions/runs/{run_id}"}  # fmt: skip
    base.update(changed)
    return base


class Api:
    """GitHub's answers, made up: the artifacts of one name and the runs by id. Records what was asked."""

    def __init__(self, artifacts, runs, checks=None):
        # pr-check.yml's runs, by commit: by default one that passed on every commit a run here names.
        default = [run(900 + r["id"], path=".github/workflows/pr-check.yml", head_sha=r.get("head_sha")) for r in runs]
        self.artifacts, self.runs, self.checks, self.asked = artifacts, {r["id"]: r for r in runs}, default if checks is None else checks, []

    def __call__(self, path):
        self.asked.append(path)
        if "/actions/artifacts?" in path:
            return {"total_count": len(self.artifacts), "artifacts": self.artifacts}
        if "/actions/runs?" in path:
            sha = path.split("head_sha=", 1)[1].split("&", 1)[0]
            found = [c for c in self.checks if c.get("head_sha") == sha]
            return {"total_count": len(found), "workflow_runs": found}
        return self.runs[int(path.rsplit("/", 1)[1])]


class Find(unittest.TestCase):
    def hit(self, api, event=PUSH[0], ref=PUSH[1], tree=TREE):
        found, why = pp.find(REPO, event, ref, tree, api)
        return found is not None, why

    def test_a_successful_pull_request_run_on_the_same_tree_is_a_hit(self):
        api = Api([artifact(7)], [run(7)])
        self.assertEqual(self.hit(api), (True, f"tree {TREE} passed PR agent checks in run 7 and the MCP check in run 907"))
        self.assertEqual(api.asked[0], f"/repos/{REPO}/actions/artifacts?name=gate-bank-slice-{TREE}&per_page=100")

    def test_the_mcp_check_must_have_passed_on_the_same_commit(self):
        # The MCP check runs only in pr-check.yml: a green PR agent checks run is not enough without it.
        check = lambda **c: run(907, path=".github/workflows/pr-check.yml", **c)
        for checks in ([], [check(conclusion="failure")], [check(status="in_progress", conclusion=None)], [check(head_sha="8" * 40)],
                       [check(head_repository={"full_name": "someone/unbrowse-core"})], [run(907)]):
            with self.subTest(checks=checks):
                hit, why = self.hit(Api([artifact(7)], [run(7)], checks))
                self.assertFalse(hit)
                self.assertIn("MCP check", why)
        self.assertTrue(self.hit(Api([artifact(7)], [run(7)], [check(conclusion="failure"), check()]))[0])

    def test_only_a_push_to_staging_is_looked_up(self):
        for event, ref in (("schedule", "refs/heads/staging"), ("workflow_dispatch", "refs/heads/staging"), ("push", "refs/heads/main"), ("pull_request", "refs/pull/1/merge")):
            api = Api([artifact(7)], [run(7)])
            with self.subTest(event=event, ref=ref):
                self.assertFalse(self.hit(api, event, ref)[0])
                self.assertEqual(api.asked, [], "nothing is asked: the answer could not be a hit")

    def test_a_run_that_did_not_pass_or_has_not_ended_is_no_hit(self):
        for changed in ({"conclusion": "failure"}, {"conclusion": "cancelled"}, {"conclusion": None, "status": "in_progress"}, {"conclusion": "skipped"}):
            with self.subTest(changed=changed):
                self.assertFalse(self.hit(Api([artifact(7)], [run(7, **changed)]))[0])

    def test_the_pushs_own_qa_run_or_any_other_workflow_is_no_hit(self):
        # qa.yml's slice keeps an artifact of the same name on the push itself.
        self.assertFalse(self.hit(Api([artifact(7)], [run(7, path=".github/workflows/qa.yml", event="push")]))[0])
        self.assertFalse(self.hit(Api([artifact(7)], [run(7, event="workflow_dispatch")]))[0])
        self.assertFalse(self.hit(Api([artifact(7)], [run(7, path=".github/workflows/gate-bank.yml")]))[0])

    def test_a_forks_run_or_another_repositorys_is_no_hit(self):
        self.assertFalse(self.hit(Api([artifact(7, head_repo=2)], [run(7)]))[0])
        self.assertFalse(self.hit(Api([artifact(7)], [run(7, head_repository={"full_name": "someone/unbrowse-core"})]))[0])
        self.assertFalse(self.hit(Api([artifact(7)], [run(7, repository={"full_name": "someone/unbrowse-core"})]))[0])
        self.assertFalse(self.hit(Api([artifact(7)], [run(7, head_repository=None)]))[0])

    def test_an_expired_artifact_another_trees_or_none_is_no_hit(self):
        self.assertFalse(self.hit(Api([artifact(7, expired=True)], [run(7)]))[0])
        self.assertFalse(self.hit(Api([artifact(7, name="gate-bank-slice-" + "0" * 40)], [run(7)]))[0])
        self.assertFalse(self.hit(Api([artifact(7, name=f"gate-bank-full-{TREE}")], [run(7)]))[0])
        found, why = pp.find(REPO, *PUSH, TREE, Api([], []))
        self.assertIsNone(found)
        self.assertIn("no pull request run kept results", why)

    def test_one_good_run_among_bad_ones_is_a_hit(self):
        api = Api([artifact(5), artifact(6), artifact(7)], [run(5, path=".github/workflows/qa.yml", event="push"), run(6, conclusion="failure"), run(7)])
        found, _ = pp.find(REPO, *PUSH, TREE, api)
        self.assertEqual(found["id"], 7)

    def test_a_tree_that_is_not_a_sha_is_never_asked_about(self):
        for tree in ("", "HEAD", TREE[:39], TREE + "&name=x", TREE.upper()):
            api = Api([artifact(7)], [run(7)])
            with self.subTest(tree=tree):
                self.assertFalse(self.hit(api, tree=tree)[0])
                self.assertEqual(api.asked, [])

    def test_an_answer_of_another_shape_is_no_hit(self):
        self.assertFalse(pp.find(REPO, *PUSH, TREE, lambda path: None)[0])
        self.assertFalse(pp.find(REPO, *PUSH, TREE, lambda path: {"message": "Not Found"})[0])
        # The run asked for by id answers as another run.
        self.assertFalse(self.hit(Api([artifact(7)], [{**run(8), "id": 7, "conclusion": "failure"}]))[0])


class WhatItReads(unittest.TestCase):
    def test_the_pull_request_run_keeps_its_slice_under_the_tree_it_ran_on(self):
        # The name passed_on_pr.py looks for is the one pr-agent-checks.yml's slice job gives, from the merge commit's
        # own tree; a run that never reached its verdict falls back to the commit's sha, which is no tree's name.
        workflow = (Path(__file__).resolve().parents[1] / "workflows/pr-agent-checks.yml").read_text()
        slice_job = workflow.split("\n  slice:\n", 1)[1].split("\n  report:\n", 1)[0]
        self.assertIn("tree=$(git rev-parse 'HEAD^{tree}')\n          echo \"tree=$tree\" >> \"$GITHUB_OUTPUT\"", slice_job)
        self.assertIn("name: gate-bank-slice-${{ steps.verdict.outputs.tree || github.sha }}", slice_job)
        self.assertEqual(pp.WORKFLOW, ".github/workflows/pr-agent-checks.yml")
        # Its last job is green only when every agent check passed (or was explicitly scoped out with scope+security
        # passing, in which case slice never runs and no gate-bank-slice-<tree> artifact exists to match).
        self.assertIn('length == 8 and (to_entries | all(.value.result == "success"))', workflow)


class Main(unittest.TestCase):
    def outputs(self, get, env=None, event="push", ref="refs/heads/staging"):
        with tempfile.TemporaryDirectory() as d:
            out, summary = os.path.join(d, "out"), os.path.join(d, "summary")
            given = {"GITHUB_OUTPUT": out, "GITHUB_STEP_SUMMARY": summary, **(env or {})}
            code = pp.main(["--repo", REPO, "--event", event, "--ref", ref, "--tree", TREE], get=get, env=given)
            return code, Path(out).read_text(), Path(summary).read_text()

    def test_a_hit_is_written_for_the_jobs_and_the_summary(self):
        code, out, summary = self.outputs(Api([artifact(7)], [run(7)]))
        self.assertEqual(code, 0)
        self.assertEqual(out, f"hit=true\nrun=https://github.com/{REPO}/actions/runs/7\n")
        self.assertIn("are not run again on this push", summary)
        self.assertIn("/actions/runs/7", summary)

    def test_github_being_down_is_no_hit_and_never_a_red_job(self):
        def down(path):
            raise OSError("connection refused")

        code, out, summary = self.outputs(down)
        self.assertEqual(code, 0)
        self.assertEqual(out, "hit=false\nrun=\n")
        self.assertIn("Every check runs", summary)

    def test_no_token_is_no_hit(self):
        code, out, _ = self.outputs(None, env={"GH_TOKEN": ""})
        self.assertEqual((code, out), (0, "hit=false\nrun=\n"))

    def test_the_nightly_run_is_never_a_hit(self):
        code, out, _ = self.outputs(Api([artifact(7)], [run(7)]), event="schedule")
        self.assertEqual((code, out), (0, "hit=false\nrun=\n"))


if __name__ == "__main__":
    unittest.main()
