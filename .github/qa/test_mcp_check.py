"""mcp_check.py against a fake MCP server: it passes a sound one and fails each kind of fault it is there to catch."""
import base64
import json
import os
import stat
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
import mcp_check  # noqa: E402

SERVER = r'''
import json, sys
FAULT = sys.argv[1] if len(sys.argv) > 1 else ""
TOOLS = [
  {"name": "t_read", "description": "Read a thing by its id, and say what it holds.", "inputSchema": {"type": "object", "properties": {"id": {"type": "string"}}, "required": ["id"]}},
  {"name": "t_list", "description": "List every thing this server holds, newest first.", "inputSchema": {"type": "object", "properties": {}}},
]
if FAULT == "bad-schema":
    TOOLS[1]["inputSchema"] = {"type": "object", "properties": {}, "required": ["nope"]}
for line in sys.stdin:
    msg = json.loads(line)
    if "id" not in msg:
        continue
    m, i = msg["method"], msg["id"]
    def ok(r): print(json.dumps({"jsonrpc": "2.0", "id": i, "result": r}), flush=True)
    def err(c, t): print(json.dumps({"jsonrpc": "2.0", "id": i, "error": {"code": c, "message": t}}), flush=True)
    if m == "initialize":
        ok({"protocolVersion": "2025-11-25", "capabilities": {"tools": {}}, "serverInfo": {"name": "fake", "version": "1"}})
    elif m == "tools/list":
        ok({"tools": TOOLS})
    elif m == "resources/list":
        ok({"resources": [{"uri": "ui://fake/answer.html", "mimeType": "text/html;profile=mcp-app"}]})
    elif m == "tools/call":
        name, args = msg["params"]["name"], msg["params"].get("arguments", {})
        if name == "t_read":
            if "id" not in args:
                said = "something went wrong" if FAULT == "vague" else "t_read needs id"
                ok({"content": [{"type": "text", "text": json.dumps({"error": said})}], "isError": True})
            else:
                ok({"content": [{"type": "text", "text": json.dumps({"thing": args["id"], "holds": "x"})}], "isError": False})
        elif name == "t_list":
            ok({"content": [{"type": "text", "text": json.dumps({"things": ["a"]})}], "isError": False})
        else:
            err(-32602, f"no tool {name}")
    else:
        err(-32601, f"method not found: {m}")
'''

CHROME = r'''#!/bin/sh
for a in "$@"; do case $a in --screenshot=*) printf '\211PNG\r\n\032\nfake\000\000\000\000IEND\256B\140\202' > "${a#--screenshot=}" ;; esac; done
'''


class ChromePictureTest(unittest.TestCase):
    @staticmethod
    def screenshot_path(command):
        return Path(next(arg.split("=", 1)[1] for arg in command if arg.startswith("--screenshot=")))

    def test_a_picture_written_before_chrome_times_out_counts(self):
        with tempfile.TemporaryDirectory() as folder:
            target = Path(folder) / "shot.png"

            def wrote_then_waited(command, screenshot, timeout=60):
                self.screenshot_path(command).write_bytes(base64.b64decode(
                    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO9WZ2QAAAAASUVORK5CYII="
                ))
                raise subprocess.TimeoutExpired(command, timeout)

            with patch.object(mcp_check, "_run_chrome_screenshot", side_effect=wrote_then_waited) as chrome:
                self.assertTrue(mcp_check.chrome_shot("chrome", "file:///card.html", target, target.parent / "profile"))
                chrome.assert_called_once()
            self.assertTrue(mcp_check.is_png(target, complete=True))

    def test_a_hanging_chrome_is_stopped_promptly_once_complete_png_is_written(self):
        with tempfile.TemporaryDirectory() as folder:
            tmp = Path(folder)
            chrome = tmp / "hanging-chrome"
            chrome.write_text(
                "#!/bin/sh\n"
                "for a in \"$@\"; do case $a in --screenshot=*) printf '\\211PNG\\r\\n\\032\\nfake\\000\\000\\000\\000IEND\\256B\\140\\202' > \"${a#--screenshot=}\" ;; esac; done\n"
                "exec sleep 30\n"
            )
            chrome.chmod(chrome.stat().st_mode | stat.S_IEXEC)
            target = tmp / "shot.png"
            started = __import__("time").monotonic()
            self.assertTrue(mcp_check.chrome_shot(str(chrome), "file:///card.html", target, tmp / "profile"))
            elapsed = __import__("time").monotonic() - started
            self.assertLess(elapsed, 5.0, f"chrome_shot waited {elapsed:.1f}s for a hanging Chrome after PNG finished")
            self.assertTrue(mcp_check.is_png(target, complete=True))

    def test_chrome_timeouts_without_a_picture_still_fail(self):
        with tempfile.TemporaryDirectory() as folder:
            target = Path(folder) / "shot.png"
            with patch.object(mcp_check, "_run_chrome_screenshot", side_effect=subprocess.TimeoutExpired("chrome", 60)) as chrome:
                self.assertFalse(mcp_check.chrome_shot("chrome", "file:///card.html", target, target.parent / "profile"))
                self.assertEqual(chrome.call_count, 2)

    def test_a_previous_run_screenshot_does_not_count(self):
        with tempfile.TemporaryDirectory() as folder:
            target = Path(folder) / "shot.png"
            target.write_bytes(base64.b64decode(
                "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO9WZ2QAAAAASUVORK5CYII="
            ))
            with patch.object(mcp_check, "_run_chrome_screenshot", side_effect=subprocess.TimeoutExpired("chrome", 60)) as chrome:
                self.assertFalse(mcp_check.chrome_shot("chrome", "file:///card.html", target, target.parent / "profile"))
                self.assertEqual(chrome.call_count, 2)
            self.assertFalse(target.exists())

    def test_an_interrupted_png_write_still_fails(self):
        with tempfile.TemporaryDirectory() as folder:
            target = Path(folder) / "shot.png"

            def interrupted_write(command, screenshot, timeout=60):
                self.screenshot_path(command).write_bytes(mcp_check.PNG + b"partial")
                raise subprocess.TimeoutExpired(command, timeout)

            with patch.object(mcp_check, "_run_chrome_screenshot", side_effect=interrupted_write) as chrome:
                self.assertFalse(mcp_check.chrome_shot("chrome", "file:///card.html", target, target.parent / "profile"))
                self.assertEqual(chrome.call_count, 2)
            self.assertFalse(target.exists())


class McpCheckTest(unittest.TestCase):
    def test_the_nodes_browser_must_take_a_new_screenshot(self):
        with tempfile.TemporaryDirectory() as folder:
            shots = Path(folder)
            previous = shots / "01-session.png"
            previous.write_bytes(mcp_check.PNG + b"previous picture" + mcp_check.PNG_END)
            step = {"n": 1, "id": "session", "tool": "unbrowse_browse",
                    "shot": {"session": "session-fixture", "url": "https://example.test/"}}
            mcp = Mock()
            mcp.request.return_value = {"result": {"content": []}}
            path, source, _ = mcp_check.shoot(mcp, None, shots, step, {})
            self.assertIsNone(path)
            self.assertIsNone(source)
            self.assertFalse(previous.exists())
            self.assertNotEqual(Path(mcp.request.call_args.args[1]["arguments"]["do"][1]), previous)

    def test_data_url_screenshots_the_reply_from_the_live_call(self):
        journey = json.loads(Path(__file__).with_name("mcp-journey.json").read_text())
        step = next(step for step in journey["steps"] if step["id"] == "do-data-url")
        step = dict(step, n=1, answer='{"result":{"data":{"text":"User-agent: *"}}}')
        with tempfile.TemporaryDirectory() as tmp:
            shots = Path(tmp)
            with patch.object(mcp_check, "chrome_shot", return_value=True) as shot:
                _, source, _ = mcp_check.shoot(None, "chrome", shots, step, {})
            self.assertEqual(source, "the reply, drawn")
            self.assertEqual(shot.call_args.args[1], (shots / ".01.html").as_uri())
            self.assertIn("User-agent: *", (shots / ".01.html").read_text())

    def run_check(self, fault="", journey=None):
        tmp = Path(tempfile.mkdtemp())
        (tmp / "server.py").write_text(SERVER)
        unb = tmp / "unb"
        unb.write_text(f"#!/bin/sh\nexec {sys.executable} {tmp / 'server.py'} {fault}\n")
        chrome = tmp / "chrome"
        chrome.write_text(CHROME)
        for f in (unb, chrome):
            f.chmod(f.stat().st_mode | stat.S_IEXEC)
        plan = journey or {"steps": [
            {"id": "read", "tool": "t_read", "args": {"id": "a"}, "expect": {"has": ["thing"]}, "save": {"thing": "thing"}},
            {"id": "list", "tool": "t_list", "args": {}, "expect": {"says": ["{{thing}}"]}},
        ], "waived": {}}
        (tmp / "journey.json").write_text(json.dumps(plan))
        (tmp / "baseline.json").write_text(json.dumps({"input_errors_as_protocol_errors": []}))
        os.environ["UNBROWSE_AGENT_TOKEN"] = "test"
        code = mcp_check.main(["--unb", str(unb), "--out", str(tmp / "out"), "--chrome", str(chrome), "--api", "",
                               "--journey", str(tmp / "journey.json"), "--baseline", str(tmp / "baseline.json")])  # fmt: skip
        return code, json.loads((tmp / "out/mcp-check.json").read_text()), tmp / "out"

    def failed(self, result):
        return {s["id"] for s in result["steps"] if not s["pass"]}

    def test_a_request_that_is_not_a_tool_call_is_checked_like_one(self):
        steps = [
            {"id": "read", "tool": "t_read", "args": {"id": "a"}, "expect": {"has": ["thing"]}},
            {"id": "list", "tool": "t_list", "args": {}},
            {"id": "app", "method": "resources/list", "params": {}, "expect": {"says": ["ui://fake/answer.html"], "has": ["resources.0.uri"]}},
            {"id": "app-missing", "method": "resources/list", "params": {}, "expect": {"says": ["ui://other.html"]}},
            {"id": "no-method", "method": "resources/nope", "params": {}},
        ]
        code, result, _ = self.run_check(journey={"steps": steps, "waived": {}})
        self.assertEqual(code, 1)
        self.assertEqual(self.failed(result), {"app-missing", "no-method"})

    def test_a_sound_server_passes_with_a_picture_of_every_step(self):
        code, result, out = self.run_check()
        self.assertEqual(code, 0, self.failed(result))
        journey = [s for s in result["steps"] if s["part"] == "journey"]
        self.assertEqual([s["shot"] for s in journey], ["01-read.png", "02-list.png"])
        self.assertTrue(all((out / "shots" / s["shot"]).read_bytes().startswith(mcp_check.PNG) for s in journey))

    def test_a_refusal_that_names_nothing_fails(self):
        code, result, _ = self.run_check("vague")
        self.assertEqual(code, 1)
        self.assertIn("t_read", self.failed(result))

    def test_a_schema_requiring_what_it_does_not_describe_fails(self):
        code, result, _ = self.run_check("bad-schema")
        self.assertEqual(code, 1)
        self.assertIn("tools/list", self.failed(result))

    def test_a_tool_no_step_calls_fails_unless_waived(self):
        only_read = {"steps": [{"id": "read", "tool": "t_read", "args": {"id": "a"}}], "waived": {}}
        code, result, _ = self.run_check(journey=only_read)
        self.assertEqual(code, 1)
        self.assertEqual(self.failed(result), {"t_list"})
        only_read["waived"] = {"t_list": "listing is covered by the unit tests of the store"}
        code, result, _ = self.run_check(journey=only_read)
        self.assertEqual(code, 0, self.failed(result))

    def test_a_reply_missing_what_the_step_expects_fails(self):
        plan = {"steps": [
            {"id": "read", "tool": "t_read", "args": {"id": "a"}, "expect": {"in": {"holds": ["y"]}}},
            {"id": "list", "tool": "t_list", "args": {}, "expect": {"result": "refused"}},
        ], "waived": {}}  # fmt: skip
        code, result, _ = self.run_check(journey=plan)
        self.assertEqual(code, 1)
        self.assertEqual(self.failed(result), {"read", "list", "t_list"})


class SchemasTest(unittest.TestCase):
    API = {"primitives": [{"tool": "t_read", "returns": {"$ref": "#/types/Read"}}], "types": {"Read": {"anyOf": [
        {"type": "object", "properties": {"thing": {"type": "string"}}, "required": ["thing"], "additionalProperties": False},
        {"type": "object", "properties": {"how": {"enum": ["browse"]}}, "required": ["how"], "additionalProperties": False},
    ]}, "Do": {"anyOf": [
        {"type": "object", "properties": {"how": {"enum": ["learned"]}, "result": {"$ref": "#/types/Result"}}, "required": ["how", "result"], "additionalProperties": False},
        {"type": "object", "properties": {"how": {"enum": ["network"]}, "entry": {"type": "string"}, "result": {}}, "required": ["how", "entry", "result"], "additionalProperties": False},
    ]}, "Result": {"type": "object", "properties": {"ok": {"type": "boolean"}}, "additionalProperties": False}}}  # fmt: skip

    def schemas(self, drift=None):
        try:
            import jsonschema  # noqa: F401
        except ImportError:
            self.skipTest("jsonschema isn't installed")
        api = Path(tempfile.mkdtemp()) / "api.json"
        api.write_text(json.dumps(self.API))
        return mcp_check.Schemas(str(api), drift)

    def test_a_large_reply_that_breaks_its_schema_says_why_within_the_cut(self):
        reply = {"thing": "x" * 5000, "extra": True}
        problems = self.schemas().problems("t_read", reply)
        self.assertEqual(len(problems), 1)
        self.assertIn("'extra' was unexpected", problems[0])
        self.assertLess(len(problems[0]), 400)

    def test_a_tagged_reply_is_judged_by_the_branch_its_tag_names(self):
        schemas = self.schemas()
        schemas.returns["t_do"] = {"$ref": "#/types/Do"}
        problems = schemas.problems("t_do", {"how": "learned", "result": {"ok": True, "page": "p"}})
        self.assertEqual(len(problems), 1)
        self.assertIn("at /result", problems[0])
        self.assertIn("'page' was unexpected", problems[0])
        self.assertNotIn("entry", problems[0])

    def test_a_known_drift_hides_no_other_way_the_reply_leaves_its_schema(self):
        schemas = self.schemas({"t_do": ["at /result: Additional properties are not allowed ('page' was unexpected)"]})
        schemas.returns["t_do"] = {"$ref": "#/types/Do"}
        self.assertEqual(schemas.problems("t_do", {"how": "learned", "result": {"ok": True, "page": "p"}}), [])
        problems = schemas.problems("t_do", {"how": "learned", "result": {"ok": "yes", "page": "p"}})
        self.assertEqual(len(problems), 1)
        self.assertIn("at /result/ok", problems[0])

    def test_known_drift_is_said_not_failed_and_a_fixed_one_is_reported(self):
        drift = {"t_read": ["'extra' was unexpected", "'gone' was unexpected"]}
        schemas = self.schemas(drift)
        self.assertEqual(schemas.problems("t_read", {"thing": "a", "extra": 1}), [])
        self.assertEqual(len(schemas.fixed()), 1)
        self.assertIn("'gone' was unexpected", schemas.fixed()[0])
        self.assertTrue(schemas.problems("t_read", {"thing": "a", "new_field": 1}))


class CollectShotsTest(unittest.TestCase):
    def test_it_runs_isolated_as_the_report_job_runs_it(self):
        import subprocess

        script = Path(__file__).resolve().parent / "collect_shots.py"
        done = subprocess.run([sys.executable, "-I", str(script), "--help"], cwd=tempfile.mkdtemp(), capture_output=True, text=True)
        self.assertEqual(done.returncode, 0, done.stderr)

    def test_every_check_gets_a_picture_and_says_from_where(self):
        import collect_shots

        tmp = Path(tempfile.mkdtemp())
        chrome = tmp / "chrome"
        chrome.write_text(CHROME)
        chrome.chmod(chrome.stat().st_mode | stat.S_IEXEC)
        own = tmp / "own.png"
        own.write_bytes(mcp_check.PNG + b"x")
        outside = Path(tempfile.mkdtemp(dir=Path.home())) / "elsewhere.png"
        outside.write_bytes(mcp_check.PNG + b"y")
        verdict = tmp / "qa-verdict.json"
        verdict.write_text(json.dumps({"pass": True, "checks": [
            {"n": 1, "result": "pass", "shot": str(own)},
            {"n": 2, "result": "pass", "url": "https://example.com/"},
            {"n": 3, "result": "blocked", "note": "site down"},
            {"n": 4, "result": "pass", "shot": str(outside)},
        ]}))  # fmt: skip
        code = collect_shots.main(["--verdict", str(verdict), "--shots", str(tmp / "shots"), "--chrome", str(chrome), "--allow", str(tmp)])
        rows = json.loads((tmp / "shots/shots.json").read_text())["checks"]
        self.assertEqual(code, 0)
        self.assertEqual([r["source"] for r in rows], [
            "the agent's screenshot, through the node", "the check's page, straight in Chrome", "the check's result, drawn",
            "the check's result, drawn",
        ], "a path outside the allowed folders is never read")  # fmt: skip
        self.assertEqual((tmp / "shots/check-01.png").read_bytes(), own.read_bytes())
        outside.unlink()
        outside.parent.rmdir()

    def test_a_verdict_with_no_checks_fails(self):
        import collect_shots

        tmp = Path(tempfile.mkdtemp())
        (tmp / "v.json").write_text("{}")
        self.assertEqual(collect_shots.main(["--verdict", str(tmp / "v.json"), "--shots", str(tmp / "s")]), 1)


if __name__ == "__main__":
    unittest.main()
