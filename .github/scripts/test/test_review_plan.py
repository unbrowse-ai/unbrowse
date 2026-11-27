"""Which pull request a Code review run is for. Every Code review on staging c1907d01b..6e7d47b73 that got past its
checkout died here: `gh run view --json pullRequests` is no field gh has ("Unknown JSON field", run 45331650590). The
fake below answers as gh does: the REST run endpoint carries `pull_requests`, and `run view` refuses that field."""
import json
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
import review_plan  # noqa: E402

RUN = {"event": "pull_request", "head_sha": "0be336bf47ad", "head_branch": "fix/x", "pull_requests": [{"number": 899}]}


def fake_gh(answers):
    asked = []

    def gh(args):
        asked.append(args)
        if args[:2] == ["run", "view"] and "pullRequests" in " ".join(args):
            raise RuntimeError('gh run view: Unknown JSON field: "pullRequests"')
        key = args[1] if args[0] == "api" else " ".join(args)
        if key not in answers:
            raise AssertionError(f"asked gh for {args}")
        return json.dumps(answers[key])

    return gh, asked


class ThePullRequestOfARun(unittest.TestCase):
    def test_a_run_that_names_its_pull_request(self):
        gh, _ = fake_gh({"repos/o/r/actions/runs/7": RUN})
        self.assertEqual(review_plan.pull_for_run(7, "o/r", gh=gh), (899, None))

    def test_a_run_that_names_none_is_found_by_its_commit(self):
        gh, asked = fake_gh({"repos/o/r/actions/runs/7": dict(RUN, pull_requests=[]), "repos/o/r/commits/0be336bf47ad/pulls": [{"number": 12}]})
        self.assertEqual(review_plan.pull_for_run(7, "o/r", gh=gh), (12, None))
        self.assertEqual(asked[-1][1], "repos/o/r/commits/0be336bf47ad/pulls")

    def test_a_run_of_a_push_is_no_pull_requests(self):
        gh, _ = fake_gh({"repos/o/r/actions/runs/7": dict(RUN, event="push")})
        self.assertEqual(review_plan.pull_for_run(7, "o/r", gh=gh), (None, "the run is not a pull request's"))


if __name__ == "__main__":
    unittest.main()
