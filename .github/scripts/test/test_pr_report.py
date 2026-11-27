"""A pull request's CI report (pr_report.py): what it says from a run's artifacts, how it puts pictures, and that it
writes one comment over in place. Everything a run left is data: no mention pings, no tag draws, no cell breaks."""
import http.server
import json
import os
import pathlib
import sys
import tempfile
import threading
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
import pr_report as R  # noqa: E402

PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 64


def run(id_, name, conclusion="success"):
    return {"id": id_, "name": name, "html_url": f"https://github.com/o/r/actions/runs/{id_}", "status": "completed", "conclusion": conclusion}


class Artifacts:
    """A run's artifacts laid out as CI leaves them: QA's verdicts and pictures, the MCP check's steps and pictures."""

    def __init__(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self.tmp.name)

    def write(self, rel, data):
        p = self.root / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(data if isinstance(data, bytes) else (json.dumps(data) if not isinstance(data, str) else data).encode())
        return p


class WhatTheReportSays(unittest.TestCase):
    def setUp(self):
        self.a = Artifacts()
        self.a.write("qa-report-3/qa-verdict.json", {"pass": False, "checks": [
            {"n": 14, "result": "fail", "note": "hn.algolia: how browse | outcome challenge @steefpls <script>x</script>", "shot": "/runner/qa-shots/check-14.png"},
            {"n": 15, "result": "pass", "note": "?q=tauri called in 141 ms", "shot": "/runner/qa-shots/check-15.png"}]})
        self.a.write("qa-screenshots/shots.json", {"checks": [{"n": 14, "shot": "check-14.png"}, {"n": 15, "shot": "check-15.png"}]})
        self.a.write("qa-screenshots/check-14.png", PNG + b"14")
        self.a.write("qa-screenshots/check-15.png", PNG + b"15")
        self.a.write("qa-mcp-check/mcp-check.json", {"pass": False, "steps": [
            {"part": "journey", "id": "do-data-url", "pass": False, "problems": ["no screenshot: Chrome took none"], "note": "a url that is data", "shot": "08-do.png"},
            {"part": "contract", "id": "initialize", "pass": True, "problems": [], "note": "protocol 2025-11-25"}]})
        self.a.write("qa-mcp-check/shots/08-do.png", PNG + b"08")
        self.a.write("gate-bank-slice-abc/verdict.md", "REFUSE task bank: u6:customs-broker-1 changed, ask @someone")
        self.put = []
        self.picture = lambda p: (self.put.append(p.name) or f"https://shots.example/s/x/{p.name}") if p else None

    def tearDown(self):
        self.a.tmp.cleanup()

    def body(self):
        runs = [run(1, "PR agent checks", "failure"), run(2, "PR check (no credential)", "failure")]
        failed = {1: [{"job": "Gate bank (slice)", "url": "https://github.com/o/r/job/9", "steps": ["The gate's verdict"]}]}
        return R.render({"head": "fdb8890bea33"}, [("this pull request's", "fdb8890bea33", runs)], {1: self.a.root, 2: self.a.root}, failed, self.picture)

    def test_a_failure_comes_first_with_its_step_its_log_and_its_picture(self):
        b = self.body()
        self.assertTrue(b.startswith(R.MARKER))
        self.assertIn("❌ **Gate bank (slice)**: *The gate's verdict* · [log](https://github.com/o/r/job/9)", b)
        self.assertIn("**Claude QA: 1 of 2 checks pass.**", b)
        qa = b[b.index("**Claude QA"):]
        fold = qa.index("<details><summary>1 passing")
        self.assertLess(qa.index("| 14 |"), fold, "a failing check sits above the fold")
        self.assertGreater(qa.index("| 15 |"), fold, "a passing one is folded")
        self.assertIn('<img src="https://shots.example/s/x/check-14.png" width="280">', b)
        self.assertIn("**MCP check: 1 of 2 steps pass**", b)
        self.assertIn("no screenshot: Chrome took none", b)
        self.assertEqual(sorted(set(self.put)), ["08-do.png", "check-14.png", "check-15.png"])

    def test_what_a_run_wrote_cannot_ping_draw_or_break_a_table(self):
        b = self.body()
        self.assertNotIn("@steefpls", b)
        self.assertNotIn("@someone", b)
        self.assertIn("&#64;steefpls", b)
        self.assertNotIn("<script>", b)
        row = next(line for line in b.splitlines() if line.startswith("| 14 |"))
        self.assertEqual(row.count(" | "), 3, f"the note's own '|' is escaped, the row keeps its four cells: {row}")

    def test_without_the_pictures_worker_the_report_still_says_everything(self):
        runs = [run(1, "PR agent checks", "failure")]
        b = R.render({"head": "fdb8890bea33"}, [("this pull request's", "fdb8890bea33", runs)], {1: self.a.root}, {}, lambda p: None)
        self.assertIn("**Claude QA: 1 of 2 checks pass.**", b)
        self.assertNotIn("<img", b)

    def test_a_report_too_long_for_a_comment_is_cut_and_says_so(self):
        many = [{"n": i, "result": "fail", "note": "x" * 290, "shot": ""} for i in range(400)]
        self.a.write("qa-report-1/qa-verdict.json", {"checks": many})
        b = self.body()
        self.assertLessEqual(len(b), 65536)
        self.assertIn("…cut", b)

    def test_after_the_merge_staging_runs_are_their_own_section(self):
        groups = [("this pull request's", "fdb8890bea33", [run(1, "CI")]), ("after the merge, on staging,", "5ea2a27de0", [run(3, "QA")])]
        b = R.render({"head": "fdb8890bea33"}, groups, {}, {}, self.picture)
        self.assertIn("## after the merge, on staging, `5ea2a27de`", b)
        self.assertIn("[QA](https://github.com/o/r/actions/runs/3) | after the merge, on staging, `5ea2a27de` | ✅ success", b)


class WhyARunIsRed(unittest.TestCase):
    """A run red for a reason none of its tables shows says that reason above the fold. On PR #921 the PR check was red
    because the attack bank held 5 of 10 checks, while the MCP check beside it passed 45 of 45: the comment showed only
    the pass and a failed "Verdict" step."""

    def test_a_failed_attack_bank_is_shown_open_with_its_verdict(self):
        a = Artifacts()
        try:
            a.write("qa-mcp-check/mcp-check.json", {"pass": True, "steps": [{"part": "contract", "id": "initialize", "pass": True}]})
            a.write("qa-mcp-check/attack/attack.md", "## Attack bank\n\n**FAILED:** 5 of 10 checks held.\n\n| Check | Held |\n| --- | --- |\n"
                    "| the import signed A in as alice | **no**: The page didn't load |\n")
            b = R.run_section(run(1, "PR check (no credential)", "failure"), [], a.root, lambda p: None)
            self.assertIn("**FAILED:** 5 of 10 checks held.", b)
            head = b[: b.index("**FAILED:**")]
            self.assertEqual(head.count("<details>"), head.count("</details>"), "the failed bank is not folded away")
            self.assertIn("the import signed A in as alice", b)
            a.write("qa-mcp-check/attack/attack.md", "## Attack bank\n\n**PASSED:** 10 of 10 checks held.\n")
            ok = R.run_section(run(1, "PR check (no credential)"), [], a.root, lambda p: None)
            self.assertIn("<details><summary>Attack bank", ok, "a bank that held is folded")
        finally:
            a.tmp.cleanup()


class TheLatestArtifact(unittest.TestCase):
    """A rerun leaves two artifacts of one name (one per attempt). Asking gh for the name took both and failed on the
    second ("Not read: qa-mcp-check" on PR #921's report); the newest is the one read."""

    def setUp(self):
        self._gh, self._api = R.gh, R.api

    def tearDown(self):
        R.gh, R.api = self._gh, self._api

    def test_of_two_artifacts_with_one_name_only_the_newest_is_read(self):
        import io, zipfile
        def zipped(text):
            buf = io.BytesIO()
            with zipfile.ZipFile(buf, "w") as z:
                z.writestr("mcp-check.md", text)
            return buf.getvalue()
        arts = {"artifacts": [{"id": 1, "name": "qa-mcp-check", "expired": False, "created_at": "2026-11-24T15:10:00Z"},
                              {"id": 2, "name": "qa-mcp-check", "expired": False, "created_at": "2026-11-24T15:30:00Z"},
                              {"id": 3, "name": "pr-node-build", "expired": False, "created_at": "2026-11-24T15:00:00Z"}]}
        R.api = lambda path, **kw: arts
        fetched = []
        R.fetch_zip = lambda repo, artifact_id: fetched.append(artifact_id) or zipped(f"attempt {artifact_id}")
        with tempfile.TemporaryDirectory() as d:
            skipped = R.download("o/r", 7, pathlib.Path(d))
            self.assertEqual((skipped, fetched), ([], [2]))
            self.assertEqual((pathlib.Path(d) / "qa-mcp-check" / "mcp-check.md").read_text(), "attempt 2")

    def test_an_entry_that_climbs_out_of_its_folder_is_not_written(self):
        import io, zipfile
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w") as z:
            z.writestr("../escaped.md", "x")
            z.writestr("ok.md", "y")
        R.api = lambda path, **kw: {"artifacts": [{"id": 5, "name": "bank", "expired": False, "created_at": "2026-11-24T15:00:00Z"}]}
        R.fetch_zip = lambda repo, artifact_id: buf.getvalue()
        with tempfile.TemporaryDirectory() as d:
            R.download("o/r", 7, pathlib.Path(d) / "run")
            self.assertFalse((pathlib.Path(d) / "escaped.md").exists())
            self.assertEqual((pathlib.Path(d) / "run" / "bank" / "ok.md").read_text(), "y")


class Worker(http.server.BaseHTTPRequestHandler):
    """The pictures worker's door, standing in: HEAD finds what was put, PUT needs the key."""
    kept: dict = {}
    key = "k" * 64

    def log_message(self, *a):
        pass

    def turned_away(self):
        """Cloudflare's front: Python's own user agent is answered 403 before the worker sees it, as the live one was."""
        if (self.headers.get("user-agent") or "").startswith("Python-urllib"):
            self.send_response(403)
            self.end_headers()
            return True
        return False

    def do_HEAD(self):
        if self.turned_away():
            return
        self.send_response(200 if self.path in self.kept else 404)
        self.end_headers()

    def do_PUT(self):
        if self.turned_away():
            return
        if self.headers.get("authorization") != f"Bearer {self.key}":
            self.send_response(401)
            self.end_headers()
            return
        self.kept[self.path] = self.rfile.read(int(self.headers["content-length"]))
        self.send_response(201)
        self.end_headers()


class Pictures(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Worker)
        cls.base = f"http://127.0.0.1:{cls.server.server_address[1]}"
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()

    def setUp(self):
        Worker.kept.clear()
        self.a = Artifacts()

    def tearDown(self):
        self.a.tmp.cleanup()

    def test_a_picture_is_put_once_named_by_what_it_shows(self):
        put = R.Pictures(self.base, Worker.key, "o/r#898")
        one = self.a.write("1/qa-screenshots/check-14.png", PNG + b"a")
        same = self.a.write("2/qa-screenshots/check-14.png", PNG + b"a")
        changed = self.a.write("3/qa-screenshots/check-14.png", PNG + b"b")
        put.prefetch([one, same, changed])
        u1, u2, u3 = put(one), put(same), put(changed)
        self.assertEqual(u1, u2, "the same picture from another run is the one already put")
        self.assertNotEqual(u1, u3, "a picture a later commit changed is never shown as the old one")
        self.assertEqual(len(Worker.kept), 2)
        self.assertTrue(u1.startswith(f"{self.base}/s/") and u1.endswith(".png"))

    def test_the_address_cannot_be_worked_out_without_the_key(self):
        a = R.Pictures(self.base, Worker.key, "o/r#898").run
        b = R.Pictures(self.base, "another-key", "o/r#898").run
        self.assertNotEqual(a, b)
        self.assertRegex(a, r"^[0-9a-f]{32}$")
        import hashlib
        self.assertNotEqual(a, hashlib.sha256(b"o/r#898").hexdigest()[:32])

    def test_a_refused_picture_is_counted_and_left_out(self):
        put = R.Pictures(self.base, "wrong", "o/r#898")
        self.assertIsNone(put(self.a.write("x/check-1.png", PNG)))
        self.assertEqual(put.failed, 1)
        self.assertIsNone(put(self.a.write("x/notes.txt", b"hi")), "only a picture is ever sent")
        self.assertIsNone(R.Pictures(None, None, "o/r#898")(self.a.write("x/check-2.png", PNG)), "no worker, nothing sent")


class TheComment(unittest.TestCase):
    def setUp(self):
        self.calls = []
        self._gh, self._api = R.gh, R.api

    def tearDown(self):
        R.gh, R.api = self._gh, self._api

    def test_it_writes_over_its_own_comment_and_never_a_persons(self):
        comments = [{"id": 1, "body": f"quoting {R.MARKER}", "user": {"type": "User"}, "html_url": "u1"},
                    {"id": 2, "body": f"{R.MARKER}\nold", "user": {"type": "Bot"}, "html_url": "u2"}]
        R.api = lambda path, **kw: comments if "/comments" in path else None
        R.gh = lambda args: self.calls.append(args) or "{}"
        self.assertEqual(R.post("o/r", 7, "new"), "updated u2")
        self.assertEqual(self.calls[0][:4], ["api", "-X", "PATCH", "repos/o/r/issues/comments/2"])

    def test_with_none_yet_it_makes_one(self):
        R.api = lambda path, **kw: []
        R.gh = lambda args: self.calls.append(args) or json.dumps({"html_url": "new-url"})
        self.assertEqual(R.post("o/r", 7, "body"), "made new-url")
        self.assertEqual(self.calls[0][:4], ["api", "-X", "POST", "repos/o/r/issues/7/comments"])

    def test_a_push_to_staging_reports_to_the_pull_request_it_merged(self):
        answers = {"repos/o/r/actions/runs/5": {"pull_requests": [], "head_sha": "abc"}, "repos/o/r/commits/abc/pulls": [{"number": 896}],
                   "repos/o/r/actions/runs/6": {"pull_requests": [{"number": 903}], "head_sha": "def"}}
        R.api = lambda path, **kw: answers[path]
        self.assertEqual(R.pull_of_run("o/r", 5)[0], 896)
        self.assertEqual(R.pull_of_run("o/r", 6)[0], 903)


    def test_gather_skips_failed_jobs_for_green_runs_and_artifacts_for_non_artifact_workflows(self):
        asked = []
        pr_doc = {"head": {"sha": "abc123456789"}}
        runs_doc = {"workflow_runs": [
            {"id": 10, "name": "CI", "status": "completed", "conclusion": "success", "run_attempt": 1, "html_url": "https://example/10"},
            {"id": 11, "name": "Coverage", "status": "completed", "conclusion": "failure", "run_attempt": 1, "html_url": "https://example/11"},
            {"id": 12, "name": "PR check (no credential)", "status": "completed", "conclusion": "success", "run_attempt": 1, "html_url": "https://example/12"},
        ]}
        def fake_api(path, **kw):
            asked.append(path)
            if path == "repos/o/r/pulls/9":
                return pr_doc
            if "/actions/runs?head_sha=" in path:
                return runs_doc
            if path.endswith("/jobs?per_page=100"):
                return {"jobs": [{"name": "Coverage, node", "conclusion": "failure", "html_url": "https://example/j", "steps": [{"name": "Tests", "conclusion": "failure"}]}]}
            if path.endswith("/artifacts?per_page=100"):
                return {"artifacts": []}
            raise AssertionError(f"unexpected api call: {path}")
        R.api = fake_api
        with tempfile.TemporaryDirectory() as d:
            body = R.gather("o/r", 9, pathlib.Path(d), lambda p: None)
        self.assertNotIn("repos/o/r/actions/runs/10/jobs?per_page=100", asked)
        self.assertNotIn("repos/o/r/actions/runs/12/jobs?per_page=100", asked)
        self.assertIn("repos/o/r/actions/runs/11/jobs?per_page=100", asked)
        self.assertNotIn("repos/o/r/actions/runs/10/artifacts?per_page=100", asked)
        self.assertNotIn("repos/o/r/actions/runs/11/artifacts?per_page=100", asked)
        self.assertIn("repos/o/r/actions/runs/12/artifacts?per_page=100", asked)
        self.assertIn("Coverage, node", body)


if __name__ == "__main__":
    unittest.main()
