"""Claude review reads each change merged into staging, so a newer push never cancels the review of the one before.

From #757's merge (21 Nov 2026 03:40Z) to 10:22Z all 21 runs were cancelled by the next push while they waited for a
pool slot, and none reached a runner: the workflow had one concurrency group for the branch, with cancel-in-progress.
Each push is another pull request's change (`git diff HEAD^ HEAD`), so each run has a group of its own (UNB-166).
"""
from pathlib import Path
import unittest

import yaml

WORKFLOW = Path(__file__).resolve().parents[2] / "workflows/claude-review.yml"


class ClaudeReview(unittest.TestCase):
    def test_a_newer_push_does_not_cancel_the_review_of_the_change_before_it(self):
        doc = yaml.safe_load(WORKFLOW.read_text())
        concurrency = doc["concurrency"]
        self.assertIs(concurrency["cancel-in-progress"], False)
        # One group per commit: a group shared by the branch keeps one waiting run and drops the others.
        self.assertEqual(concurrency["group"], "claude-review-${{ github.sha }}")
        for job in doc["jobs"].values():
            self.assertNotIn("concurrency", job)

    def test_it_reviews_the_pushed_commit_s_own_change(self):
        text = WORKFLOW.read_text()
        self.assertIn("git diff HEAD^ HEAD > .claude-review.diff", text)
        self.assertIn("fetch-depth: 2", text)


if __name__ == "__main__":
    unittest.main()
