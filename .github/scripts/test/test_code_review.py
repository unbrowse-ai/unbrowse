"""code_review.py: one OpenCode answer becomes a GitHub review that lands only on lines the change touched.

The agent answers with one JSON object; everything here is the distance between that and a review a person reads —
where a finding may sit, what the check's last line says, and what a broken answer looks like.
"""
import io
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from unittest import mock

import yaml

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
import code_review  # noqa: E402

DIFF = """diff --git a/app/src/lib.rs b/app/src/lib.rs
--- a/app/src/lib.rs
+++ b/app/src/lib.rs
@@ -10,2 +10,4 @@ fn main() {
 context ten
+added eleven
+added twelve
 context thirteen
@@ -40,1 +42,2 @@ fn other() {
-old line
+new line
diff --git a/docs/old.md b/docs/old.md
deleted file mode 100644
--- a/docs/old.md
+++ /dev/null
@@ -1,1 +0,0 @@
-gone
"""


def events(*texts, message="msg_1"):
    return "".join(
        json.dumps({"type": "text", "part": {"messageID": message, "text": t}}) + "\n" for t in texts
    ) + json.dumps({"type": "step_finish", "part": {"cost": 0.25}}) + "\n"


class Reading(unittest.TestCase):
    def test_the_last_message_is_the_answer_and_earlier_ones_are_not(self):
        lines = (json.dumps({"type": "text", "part": {"messageID": "m1", "text": "thinking out loud"}}) + "\n"
                 + json.dumps({"type": "text", "part": {"messageID": "m2", "text": '{"ok":'}}) + "\n"
                 + json.dumps({"type": "text", "part": {"messageID": "m2", "text": "true}"}}) + "\n")
        self.assertEqual(code_review.answer(lines.splitlines()), '{"ok":true}')

    def test_a_fenced_object_is_read_and_prose_around_it_is_dropped(self):
        self.assertEqual(code_review.object_in('Here:\n```json\n{"a": 1}\n```\nDone.'), {"a": 1})
        self.assertEqual(code_review.object_in('noise {"a": 2} noise'), {"a": 2})

    def test_claude_codes_stream_is_read_for_its_answer_and_cost(self):
        """The review asks through agent_cli.py, which writes Claude Code's stream-json on either CLI (Lewis, 25 Nov
        2026: "lets switch back to claude code"): the answer is the result event's text, the cost its total."""
        stream = [
            json.dumps({"type": "system", "subtype": "init", "model": "claude-sonnet-5-5"}),
            json.dumps({"type": "assistant", "message": {"content": [{"type": "text", "text": "Reading review.diff."}]}}),
            json.dumps({"type": "assistant", "message": {"content": [{"type": "text", "text": '{"summary":"ok","findings":[]}'}]}}),
            json.dumps({"type": "result", "subtype": "success", "is_error": False, "result": '{"summary":"ok","findings":[]}',
                        "total_cost_usd": 0.0731}),
        ]
        self.assertEqual(code_review.answer(stream), '{"summary":"ok","findings":[]}')
        self.assertEqual(code_review.cost(stream), 0.0731)

    def test_a_refused_run_says_what_the_model_said(self):
        stream = [json.dumps({"type": "result", "subtype": "success", "is_error": True, "result": "Credit balance is too low"})]
        self.assertEqual(code_review.answer(stream), "")
        self.assertEqual(code_review.refusal(stream), "Credit balance is too low")

    def test_an_answer_with_no_object_is_an_error_not_an_empty_review(self):
        with self.assertRaises(ValueError):
            code_review.object_in("I could not review this.")


class Placing(unittest.TestCase):
    def test_a_line_the_change_added_or_the_context_of_one_is_where_a_comment_may_go(self):
        paths, lines = code_review.changed_lines(DIFF)
        self.assertIn("app/src/lib.rs", paths)
        self.assertEqual(paths["app/src/lib.rs"], {11, 12, 42})
        self.assertIn(13, lines["app/src/lib.rs"])       # context, so a comment on a hunk's neighbour is accepted
        self.assertNotIn(10, paths["app/src/lib.rs"])    # context is not an added line
        self.assertNotIn("docs/old.md", lines)          # a deleted file has nowhere to put a comment

    def test_a_finding_is_placed_inline_at_a_touched_line_file_level_elsewhere_or_left_out(self):
        paths, lines = code_review.changed_lines(DIFF)
        where, path, number, severity, why = code_review.place({"severity": "important", "path": "app/src/lib.rs", "line": 11}, paths, lines, "pr")
        self.assertEqual((where, number, severity, why), ("inline", 11, "normal", None))
        where, _, number, _, _ = code_review.place({"severity": "nit", "path": "app/src/lib.rs", "line": 12}, paths, lines, "pr")
        self.assertEqual(where, "inline")
        self.assertEqual(code_review.place({"severity": "nit", "path": "app/src/lib.rs", "line": 99}, paths, lines, "pr")[0], "file")
        self.assertEqual(code_review.place({"severity": "nit", "path": "README.md", "line": 3}, paths, lines, "pr")[0], "body")
        self.assertIsNone(code_review.place({"severity": "urgent", "path": "app/src/lib.rs", "line": 11}, paths, lines, "pr")[0])

    def test_a_path_the_agent_prefixed_with_pr_is_read_as_the_repository_s(self):
        paths, lines = code_review.changed_lines(DIFF)
        self.assertEqual(code_review.place({"severity": "nit", "path": "pr/app/src/lib.rs", "line": 11}, paths, lines, "pr")[0], "inline")


class TheReview(unittest.TestCase):
    def test_workflow_render_step_passes_the_diff_and_writes_the_review(self):
        root = pathlib.Path(code_review.__file__).resolve().parents[2]
        workflow = yaml.safe_load((root / ".github/workflows/opencode-review.yml").read_text())
        step = next(s for s in workflow["jobs"]["review"]["steps"] if s.get("id") == "render")
        with tempfile.TemporaryDirectory() as d:
            work = pathlib.Path(d)
            (work / ".github").symlink_to(root / ".github", target_is_directory=True)
            (work / "review.diff").write_text(DIFF)
            review = work / "review"
            review.mkdir()
            (review / "events.jsonl").write_text(events('{"summary":"Sound.","findings":[]}'))
            output = work / "github-output"
            run = subprocess.run(["bash", "-e", "-c", step["run"]], cwd=work, text=True, capture_output=True,
                                 env=dict(os.environ, RUNNER_TEMP=d, GITHUB_OUTPUT=str(output), PR="12", HEAD="abc123def456"))
            self.assertEqual(run.returncode, 0, run.stderr)
            self.assertIn("ok=true", output.read_text())
            self.assertEqual(json.loads((review / "review.json").read_text())["event"], "COMMENT")

    def run_it(self, answer, diff=DIFF):
        with tempfile.TemporaryDirectory() as d:
            events_file = pathlib.Path(d, "events.jsonl")
            diff_file = pathlib.Path(d, "review.diff")
            out = pathlib.Path(d, "out")
            events_file.write_text(events(answer))
            diff_file.write_text(diff)
            output = pathlib.Path(d, "github-output")
            with mock.patch.dict(os.environ, {"GITHUB_OUTPUT": str(output)}), redirect_stdout(io.StringIO()):
                code_review.main(["--events", str(events_file), "--diff", str(diff_file), "--pr", "12",
                                  "--head", "abc123def456", "--tree", "pr", "--out", str(out)])
            return {p.name: p.read_text() for p in out.iterdir()}, output.read_text()

    def test_findings_land_inline_and_the_check_s_line_is_claude_ship_s(self):
        answer = json.dumps({"summary": "It adds a line.", "findings": [
            {"severity": "important", "path": "app/src/lib.rs", "line": 11, "title": "Off by one", "body": "eleven is twelve", "why": "read it"},
            {"severity": "nit", "path": "app/src/lib.rs", "line": 99, "title": "Almost", "body": "no line", "why": ""},
            {"severity": "pre-existing", "path": "README.md", "line": 1, "title": "Elsewhere", "body": "untouched file", "why": ""},
        ]})
        files, out = self.run_it(answer)
        review = json.loads(files["review.json"])
        self.assertEqual(review["event"], "COMMENT")
        self.assertEqual([c["line"] for c in review["comments"]], [11])
        self.assertIn("🔴 Important", review["comments"][0]["body"])
        self.assertIn("Why this was flagged", review["comments"][0]["body"])
        self.assertIn("app/src/lib.rs:99", review["body"])
        self.assertIn("README.md", review["body"])
        check = files["check.md"].strip().splitlines()[-1]
        self.assertEqual(json.loads(check.split("<!-- bughunter-severity: ")[1].rsplit(" -->")[0]),
                         {"normal": 1, "nit": 1, "pre_existing": 1})
        self.assertEqual(json.loads(files["findings.json"])["counts"]["normal"], 1)
        self.assertIn("ok=true", out)
        self.assertIn("important=1", out)

    def test_no_findings_is_a_review_that_says_so_with_a_zero_line(self):
        files, _ = self.run_it(json.dumps({"summary": "Sound.", "findings": []}))
        self.assertIn("No findings", files["review.json"])
        self.assertEqual(json.loads(files["check.md"].split("<!-- bughunter-severity: ")[1].rsplit(" -->")[0]),
                         {"normal": 0, "nit": 0, "pre_existing": 0})

    def test_an_answer_that_is_not_json_still_leaves_a_review_and_a_pass(self):
        files, out = self.run_it("I think it is fine?")
        self.assertIn("could not be read", files["review.json"])
        self.assertEqual(json.loads(files["review.json"])["comments"], [])
        self.assertIn("ok=false", out)
        self.assertEqual(json.loads(files["findings.json"])["findings"], [])


if __name__ == "__main__":
    unittest.main()
